import { randomUUID } from 'node:crypto';
import { and, eq, isNotNull } from 'drizzle-orm';
import { ActionParams, CanonicalEvent } from '@reclaim/shared';
import type { Language } from '@reclaim/shared';
import type { Db, Tx } from '../db/client.js';
import {
  communications,
  customers,
  interventions,
  invoices,
  outbox,
  paymentMethods,
  promisesToPay,
  recoveryCases,
  toolExecutions,
} from '../db/schema.js';
import { writeAudit } from '../audit/audit.js';
import { getActivePolicy } from '../policy/service.js';
import type { Mailer } from '../mailer/index.js';
import type { PaymentProvider } from '../payments/index.js';
import { lockCase, transitionCase, type CaseRow } from '../orchestrator/caseService.js';
import { deliverVoiceNote, type VoiceToolDeps } from './voiceDelivery.js';
import { isTerminal } from '../orchestrator/fsm.js';
import {
  DEFAULT_FREE_FILLS,
  LEGAL_FOOTERS,
  TEMPLATE_REGISTRY,
  TemplateRenderError,
  formatDateIST,
  formatINR,
  needsPaymentLink,
  renderTemplate,
  validateFreeFills,
} from '../templates/registry.js';

/**
 * Tool execution layer. THE ONLY code allowed to call the payment provider
 * or the mailer. Guarantees, in order:
 *   1. idempotency claim on `caseId:interventionId:attempt` (unique index) —
 *      a duplicate BullMQ job can never double-execute
 *   2. authorization: intervention approved + case in an executable state
 *   3. Zod-validated params; amounts resolved server-side from the invoice
 *   4. structured result + AuditEvent in the closing transaction
 */

export interface ToolDeps {
  provider: PaymentProvider;
  mailer: Mailer;
  /** voice note that accompanies each email; best-effort, never throws */
  voice: VoiceToolDeps;
  enqueueScheduled(job: { kind: string; caseId: string; interventionId: string; attempt?: number }, delayMs: number): Promise<void>;
  enqueueAgent(job: { caseId: string; agent: 'summarizer' }): Promise<void>;
  now?: () => Date;
}

export class ToolAuthorizationError extends Error {}

/**
 * Called when a tool job has exhausted its retries. Without this a permanently
 * failing tool leaves the case parked in 'executing' forever with no human
 * ever told about it.
 */
export async function abandonIntervention(
  db: Db,
  args: { caseId: string; interventionId: string; reason: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const caseRow = await lockCase(tx, args.caseId);
    if (!caseRow) return;
    await tx.update(interventions).set({ status: 'failed' }).where(eq(interventions.id, args.interventionId));
    if (!isTerminal(caseRow.state) && caseRow.state !== 'escalated') {
      await transitionCase(tx, caseRow, 'escalated', { reason: `tool failed permanently: ${args.reason}` });
    }
    await writeAudit(tx, {
      caseId: args.caseId,
      actorType: 'system',
      eventType: 'tool.abandoned',
      payload: { interventionId: args.interventionId, reason: args.reason },
    });
  });
}

const EXECUTABLE_CASE_STATES = ['executing', 'waiting', 'escalated', 'disputed'] as const;

export async function executeIntervention(
  db: Db,
  deps: ToolDeps,
  args: { caseId: string; interventionId: string; attempt: number },
): Promise<{ status: 'executed' | 'duplicate' | 'skipped'; detail?: string }> {
  const now = deps.now ?? (() => new Date());
  const idempotencyKey = `${args.caseId}:${args.interventionId}:${args.attempt}`;

  // ---- 1. claim ----
  const claim = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(toolExecutions)
      .values({
        caseId: args.caseId,
        interventionId: args.interventionId,
        attempt: args.attempt,
        idempotencyKey,
        status: 'started',
      })
      .onConflictDoNothing({ target: toolExecutions.idempotencyKey })
      .returning({ id: toolExecutions.id });
    if (inserted[0]) return { kind: 'claimed' as const, executionId: inserted[0].id };

    const [existing] = await tx.select().from(toolExecutions).where(eq(toolExecutions.idempotencyKey, idempotencyKey)).limit(1);
    if (!existing) throw new Error('idempotency row vanished');
    if (existing.status === 'succeeded') return { kind: 'duplicate' as const };
    if (existing.status === 'started') return { kind: 'in_flight' as const };
    // failed → same-attempt retry re-claims the row; provider sees the same idempotency key
    await tx.update(toolExecutions).set({ status: 'started', error: null }).where(eq(toolExecutions.id, existing.id));
    return { kind: 'claimed' as const, executionId: existing.id };
  });
  if (claim.kind === 'duplicate') return { status: 'duplicate', detail: 'already executed' };
  if (claim.kind === 'in_flight') return { status: 'skipped', detail: 'another worker holds the claim' };

  // ---- 2/3. authorize + execute ----
  try {
    const result = await runTool(db, deps, args, idempotencyKey, now);
    await db.transaction(async (tx) => {
      await tx
        .update(toolExecutions)
        .set({ status: 'succeeded', result: result as object, finishedAt: now() })
        .where(eq(toolExecutions.id, claim.executionId));
    });
    return { status: 'executed' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.transaction(async (tx) => {
      await tx
        .update(toolExecutions)
        .set({ status: 'failed', error: message, finishedAt: now() })
        .where(eq(toolExecutions.id, claim.executionId));
      await writeAudit(tx, {
        caseId: args.caseId,
        actorType: 'system',
        eventType: 'tool.failed',
        payload: { interventionId: args.interventionId, attempt: args.attempt, error: message },
      });
    });
    throw err;
  }
}

interface LoadedContext {
  caseRow: CaseRow;
  intervention: typeof interventions.$inferSelect;
  invoice: typeof invoices.$inferSelect;
  customer: typeof customers.$inferSelect;
  action: ActionParams;
}

async function loadAndAuthorize(tx: Tx, args: { caseId: string; interventionId: string }): Promise<LoadedContext> {
  const caseRow = await lockCase(tx, args.caseId);
  if (!caseRow) throw new ToolAuthorizationError(`case not found: ${args.caseId}`);
  const [intervention] = await tx.select().from(interventions).where(eq(interventions.id, args.interventionId)).limit(1);
  if (!intervention || intervention.caseId !== args.caseId) {
    throw new ToolAuthorizationError('intervention does not belong to case');
  }
  if (!['approved', 'executing'].includes(intervention.status)) {
    throw new ToolAuthorizationError(`intervention status '${intervention.status}' is not executable`);
  }
  if (!EXECUTABLE_CASE_STATES.includes(caseRow.state as (typeof EXECUTABLE_CASE_STATES)[number])) {
    throw new ToolAuthorizationError(`case state '${caseRow.state}' does not permit execution`);
  }
  const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, caseRow.invoiceId)).for('update').limit(1);
  if (!invoice) throw new ToolAuthorizationError('invoice not found');
  const [customer] = await tx.select().from(customers).where(eq(customers.id, caseRow.customerId)).limit(1);
  if (!customer) throw new ToolAuthorizationError('customer not found');
  const action = ActionParams.parse(intervention.params); // Zod gate — malformed params never execute
  return { caseRow, intervention, invoice, customer, action };
}

async function markExecuted(tx: Tx, ctx: LoadedContext, now: () => Date, resultSummary: unknown): Promise<void> {
  await tx.update(interventions).set({ status: 'executed', executedAt: now() }).where(eq(interventions.id, ctx.intervention.id));
  await writeAudit(tx, {
    caseId: ctx.caseRow.id,
    actorType: 'system',
    eventType: `tool.executed.${ctx.action.type}`,
    payload: { interventionId: ctx.intervention.id, result: resultSummary },
  });
}

async function bumpAttemptCounters(tx: Tx, caseRow: CaseRow, now: () => Date): Promise<void> {
  await tx
    .update(recoveryCases)
    .set({ recoveryAttemptCount: caseRow.recoveryAttemptCount + 1, lastAttemptAt: now() })
    .where(eq(recoveryCases.id, caseRow.id));
}

async function runTool(
  db: Db,
  deps: ToolDeps,
  args: { caseId: string; interventionId: string; attempt: number },
  idempotencyKey: string,
  now: () => Date,
): Promise<unknown> {
  // Pre-read (short tx) to authorize and gather data for the external call.
  const ctx = await db.transaction(async (tx) => loadAndAuthorize(tx, args));
  const { action, invoice, customer, caseRow } = ctx;
  const amountDuePaise = invoice.amountDuePaise - invoice.amountPaidPaise; // server-resolved, never agent-supplied

  switch (action.type) {
    case 'create_payment_link': {
      const link = await deps.provider.createPaymentLink({
        amountPaise: amountDuePaise,
        currency: 'INR',
        description: `Invoice ${invoice.providerInvoiceId ?? invoice.id}`,
        referenceId: invoice.id,
        customer: { name: customer.name, email: customer.email },
        idempotencyKey,
        expireByUnix: Math.floor((now().getTime() + 7 * 86_400_000) / 1000),
      });
      // deliver via deterministic template — NO agent output in the money path.
      // Deterministic is not the same as English: skeleton, default fills and
      // footer all exist in the customer's language, so this path stays free of
      // agent text without switching languages on the customer mid-conversation.
      const skeleton = TEMPLATE_REGISTRY['payment_link_delivery']!;
      const language = customer.preferredLanguage;
      const rendered = renderTemplate(
        skeleton,
        language,
        {
          amount: formatINR(amountDuePaise),
          invoice_number: invoice.providerInvoiceId ?? invoice.id.slice(0, 8),
          payment_link: link.shortUrl,
          legal_footer: LEGAL_FOOTERS.payment_notice[language],
        },
        DEFAULT_FREE_FILLS[language],
      );
      const sent = await deps.mailer.send({
        to: { name: customer.name, email: customer.email },
        subject: rendered.subject,
        body: rendered.body,
        caseId: caseRow.id,
        templateId: skeleton.templateId,
      });
      await db.transaction(async (tx) => {
        const fresh = await lockCase(tx, caseRow.id);
        if (!fresh) return;
        await tx.insert(communications).values({
          caseId: caseRow.id,
          customerId: customer.id,
          interventionId: ctx.intervention.id,
          direction: 'outbound',
          channel: 'email',
          templateId: skeleton.templateId,
          language,
          renderedSubject: rendered.subject,
          renderedBody: rendered.body,
          consentSnapshot: { email: customer.emailConsent, optedOut: customer.optedOut },
          providerMessageId: sent.providerMessageId,
          sentAt: now(),
        });
        await bumpAttemptCounters(tx, fresh, now);
        if (fresh.state === 'executing') {
          await transitionCase(tx, fresh, 'waiting', {
            reason: 'payment link delivered; awaiting payment',
            extra: { waitUntil: new Date(now().getTime() + 7 * 86_400_000) },
          });
        }
        await markExecuted(tx, ctx, now, { providerLinkId: link.providerLinkId, shortUrl: link.shortUrl });
      });
      await deliverVoiceNote(db, deps.voice, {
        caseId: caseRow.id,
        customer,
        invoice,
        interventionId: ctx.intervention.id,
        skeleton,
        language,
        freeFills: DEFAULT_FREE_FILLS[language],
        amountDuePaise,
        now,
      });
      return { providerLinkId: link.providerLinkId, shortUrl: link.shortUrl };
    }

    case 'schedule_mandate_reexecution': {
      const [mandate] = await db
        .select()
        .from(paymentMethods)
        .where(and(eq(paymentMethods.customerId, customer.id), eq(paymentMethods.rail, 'upi_autopay')))
        .limit(1);
      const [emandate] = mandate
        ? [mandate]
        : await db
            .select()
            .from(paymentMethods)
            .where(and(eq(paymentMethods.customerId, customer.id), eq(paymentMethods.rail, 'emandate')))
            .limit(1);
      const method = mandate ?? emandate;
      if (!method?.mandateRef) throw new ToolAuthorizationError('no active mandate on file');

      // The proposal fixed scheduleAt with a 2h margin over the notice period,
      // assuming it would execute immediately. It may have sat in the approval
      // inbox for hours instead, and the notice only goes out now — so measure
      // the period from THIS moment and push the debit back if the approved
      // time no longer clears it. Latency can delay a debit; it must never
      // shorten the notice.
      const { config: policyAtExecution } = await getActivePolicy(db);
      const earliestLegalDebit = new Date(
        now().getTime() + policyAtExecution.preDebitNoticeHours * 3_600_000,
      );
      const requested = new Date(action.scheduleAt);
      const scheduleAt = requested < earliestLegalDebit ? earliestLegalDebit : requested;
      // 1) mandatory pre-debit notice FIRST — deterministic template, no free slots
      const skeleton = TEMPLATE_REGISTRY['pre_debit_notice']!;
      const language = customer.preferredLanguage;
      const rendered = renderTemplate(
        skeleton,
        language,
        {
          customer_name: customer.name,
          amount: formatINR(amountDuePaise),
          invoice_number: invoice.providerInvoiceId ?? invoice.id.slice(0, 8),
          debit_date: formatDateIST(scheduleAt, language),
          legal_footer: LEGAL_FOOTERS.emandate[language],
        },
        {},
      );
      const sent = await deps.mailer.send({
        to: { name: customer.name, email: customer.email },
        subject: rendered.subject,
        body: rendered.body,
        caseId: caseRow.id,
        templateId: skeleton.templateId,
      });
      await db.transaction(async (tx) => {
        const fresh = await lockCase(tx, caseRow.id);
        if (!fresh) return;
        await tx.insert(communications).values({
          caseId: caseRow.id,
          customerId: customer.id,
          interventionId: ctx.intervention.id,
          direction: 'outbound',
          channel: 'email',
          templateId: skeleton.templateId,
          language,
          renderedSubject: rendered.subject,
          renderedBody: rendered.body,
          consentSnapshot: { email: customer.emailConsent, optedOut: customer.optedOut },
          providerMessageId: sent.providerMessageId,
          sentAt: now(),
        });
        await bumpAttemptCounters(tx, fresh, now);
        if (fresh.state === 'executing') {
          await transitionCase(tx, fresh, 'waiting', {
            reason: 'pre-debit notice sent; mandate execution scheduled',
            extra: { waitUntil: new Date(scheduleAt.getTime() + 86_400_000) },
          });
        }
        if (scheduleAt.getTime() !== requested.getTime()) {
          await writeAudit(tx, {
            caseId: caseRow.id,
            actorType: 'system',
            eventType: 'mandate.debit_deferred_for_notice',
            payload: {
              interventionId: ctx.intervention.id,
              requested: requested.toISOString(),
              scheduledAt: scheduleAt.toISOString(),
              preDebitNoticeHours: policyAtExecution.preDebitNoticeHours,
            },
          });
        }
        await markExecuted(tx, ctx, now, { scheduledAt: scheduleAt.toISOString(), noticeMessageId: sent.providerMessageId });
      });
      await deliverVoiceNote(db, deps.voice, {
        caseId: caseRow.id,
        customer,
        invoice,
        interventionId: ctx.intervention.id,
        skeleton,
        language,
        freeFills: {},
        amountDuePaise,
        debitDate: scheduleAt,
        now,
      });
      // 2) only AFTER the notice exists: schedule the execution job
      await deps.enqueueScheduled(
        { kind: 'mandate_execution', caseId: caseRow.id, interventionId: ctx.intervention.id, attempt: args.attempt },
        Math.max(0, scheduleAt.getTime() - now().getTime()),
      );
      return { scheduledAt: scheduleAt.toISOString() };
    }

    case 'send_email': {
      const skeleton = TEMPLATE_REGISTRY[action.templateId];
      if (!skeleton) throw new ToolAuthorizationError(`template '${action.templateId}' not in the approved registry`);
      // pre_debit_notice announces a {{debit_date}} that exists only once a
      // mandate debit has been scheduled — schedule_mandate_reexecution sends
      // it itself, as step 1. A standalone send_email has no debit to announce,
      // so honouring one here could only produce a compliance notice for a
      // debit that was never scheduled.
      if (skeleton.templateId === 'pre_debit_notice') {
        throw new ToolAuthorizationError(
          "template 'pre_debit_notice' is sent only by schedule_mandate_reexecution, never by send_email",
        );
      }
      const immutableValues = buildImmutableValues(skeleton.templateId, invoice, amountDuePaise, action.language);
      // a notice is only actionable if it carries a live link to pay from —
      // generate one (right amount, resolved server-side) for the same reason
      // create_payment_link does; reused on retry via the same idempotency key.
      //
      // Ask the SKELETON what it needs rather than listing template ids by
      // hand. payment_link_delivery has always declared {{payment_link}} and
      // has always been reachable from send_email, but only create_payment_link
      // ever supplied it — so an agent naming it here stranded the case with
      // "missing immutable slot value 'payment_link'". A hand-maintained list
      // is what allowed that; asking the template cannot go out of date.
      const freeFills = { ...DEFAULT_FREE_FILLS[action.language], ...action.slotFills };
      // Lint BEFORE calling the provider. This used to run only inside
      // renderTemplate, below the link creation — so an email rejected for a
      // bad fill had already minted a live, payable link, and the retry minted
      // another, against an API that accepts no idempotency key. Nothing
      // downstream cancels them.
      const fillProblems = validateFreeFills(skeleton, freeFills);
      if (fillProblems.length > 0) throw new TemplateRenderError(fillProblems.join('; '));

      let paymentLink: { providerLinkId: string; shortUrl: string } | null = null;
      if (needsPaymentLink(skeleton)) {
        paymentLink = await deps.provider.createPaymentLink({
          amountPaise: amountDuePaise,
          currency: 'INR',
          description: `Invoice ${invoice.providerInvoiceId ?? invoice.id}`,
          referenceId: invoice.id,
          customer: { name: customer.name, email: customer.email },
          idempotencyKey,
          expireByUnix: Math.floor((now().getTime() + 7 * 86_400_000) / 1000),
        });
        immutableValues['payment_link'] = paymentLink.shortUrl;
      }
      // defense in depth: linted at agent time and again above; renderTemplate
      // re-runs the same check plus the immutable-slot coverage check
      const rendered = renderTemplate(skeleton, action.language, immutableValues, freeFills);
      const sent = await deps.mailer.send({
        to: { name: customer.name, email: customer.email },
        subject: rendered.subject,
        body: rendered.body,
        caseId: caseRow.id,
        templateId: skeleton.templateId,
      });
      await db.transaction(async (tx) => {
        const fresh = await lockCase(tx, caseRow.id);
        if (!fresh) return;
        await tx.insert(communications).values({
          caseId: caseRow.id,
          customerId: customer.id,
          interventionId: ctx.intervention.id,
          direction: 'outbound',
          channel: 'email',
          templateId: skeleton.templateId,
          language: action.language,
          renderedSubject: rendered.subject,
          renderedBody: rendered.body,
          consentSnapshot: { email: customer.emailConsent, optedOut: customer.optedOut },
          providerMessageId: sent.providerMessageId,
          sentAt: now(),
        });
        // An email carrying a live payment link IS a recovery attempt. Without
        // this the invoice attempt cap and the 24h spacing rule never saw it,
        // so a second payable link could be minted for the same invoice.
        if (paymentLink) await bumpAttemptCounters(tx, fresh, now);
        if (fresh.state === 'executing') {
          await transitionCase(tx, fresh, 'waiting', {
            reason: 'email sent; awaiting response or payment',
            extra: { waitUntil: new Date(now().getTime() + 5 * 86_400_000) },
          });
        }
        await markExecuted(tx, ctx, now, {
          providerMessageId: sent.providerMessageId,
          ...(paymentLink ? { providerLinkId: paymentLink.providerLinkId, shortUrl: paymentLink.shortUrl } : {}),
        });
      });
      await deliverVoiceNote(db, deps.voice, {
        caseId: caseRow.id,
        customer,
        invoice,
        interventionId: ctx.intervention.id,
        skeleton,
        language: action.language,
        freeFills,
        amountDuePaise,
        now,
      });
      return { providerMessageId: sent.providerMessageId, ...(paymentLink ? { paymentLink: paymentLink.shortUrl } : {}) };
    }

    case 'schedule_reminder': {
      const remindAt = new Date(action.remindAt);
      await db.transaction(async (tx) => {
        const fresh = await lockCase(tx, caseRow.id);
        if (!fresh) return;
        if (fresh.state === 'executing') {
          await transitionCase(tx, fresh, 'waiting', {
            reason: `reminder scheduled: ${action.note}`,
            extra: { waitUntil: remindAt },
          });
        }
        await markExecuted(tx, ctx, now, { remindAt: remindAt.toISOString() });
      });
      await deps.enqueueScheduled(
        { kind: 'reminder', caseId: caseRow.id, interventionId: ctx.intervention.id },
        Math.max(0, remindAt.getTime() - now().getTime()),
      );
      return { remindAt: remindAt.toISOString() };
    }

    case 'record_promise_to_pay': {
      const promisedDate = new Date(action.promisedDate);
      await db.transaction(async (tx) => {
        const fresh = await lockCase(tx, caseRow.id);
        if (!fresh) return;
        await tx.insert(promisesToPay).values({
          caseId: caseRow.id,
          customerId: customer.id,
          promisedDate,
          amountReference: action.amountReference,
        });
        if (fresh.state === 'executing') {
          await transitionCase(tx, fresh, 'waiting', {
            reason: 'promise to pay recorded',
            extra: { waitUntil: new Date(promisedDate.getTime() + 86_400_000) },
          });
        }
        await markExecuted(tx, ctx, now, { promisedDate: promisedDate.toISOString() });
      });
      return { promisedDate: promisedDate.toISOString() };
    }

    case 'escalate_to_human': {
      await db.transaction(async (tx) => {
        const fresh = await lockCase(tx, caseRow.id);
        if (!fresh) return;
        if (fresh.state !== 'escalated') {
          await transitionCase(tx, fresh, 'escalated', { reason: action.reason });
        }
        await markExecuted(tx, ctx, now, { reason: action.reason });
      });
      await deps.enqueueAgent({ caseId: caseRow.id, agent: 'summarizer' });
      return { escalated: true };
    }

    case 'stop_workflow': {
      await db.transaction(async (tx) => {
        const fresh = await lockCase(tx, caseRow.id);
        if (!fresh) return;
        if (action.reason === 'opt_out') {
          // GLOBAL suppression — applies to every case of this customer
          await tx.update(customers).set({ optedOut: true, optedOutAt: now() }).where(eq(customers.id, customer.id));
        }
        await transitionCase(tx, fresh, 'stopped', {
          reason: action.reason,
          extra: { stopReason: action.reason },
        });
        const event = CanonicalEvent.parse({
          eventId: randomUUID(),
          occurredAt: now().toISOString(),
          sourceEventId: `stop:${ctx.intervention.id}`,
          type: 'recovery.stopped',
          customerId: customer.id,
          caseId: caseRow.id,
          reason: action.reason,
        });
        await tx.insert(outbox).values({ eventType: event.type, payload: event });
        await markExecuted(tx, ctx, now, { reason: action.reason });
      });
      return { stopped: true };
    }

    case 'mark_wait': {
      const waitUntil = new Date(action.waitUntil);
      await db.transaction(async (tx) => {
        const fresh = await lockCase(tx, caseRow.id);
        if (!fresh) return;
        if (fresh.state === 'executing') {
          await transitionCase(tx, fresh, 'waiting', {
            reason: `waiting for: ${action.waitingFor}`,
            extra: { waitUntil },
          });
        }
        await markExecuted(tx, ctx, now, { waitUntil: waitUntil.toISOString() });
      });
      return { waitUntil: waitUntil.toISOString() };
    }
  }
}

/** Exported for the coverage test in test/unit/templates.test.ts. */
export function buildImmutableValues(
  templateId: string,
  invoice: typeof invoices.$inferSelect,
  amountDuePaise: number,
  language: Language,
): Record<string, string> {
  const base: Record<string, string> = {
    amount: formatINR(amountDuePaise),
    invoice_number: invoice.providerInvoiceId ?? invoice.id.slice(0, 8),
    legal_footer: LEGAL_FOOTERS.payment_notice[language],
  };
  if (templateId === 'payment_reminder') base['due_date'] = formatDateIST(invoice.dueDate, language);
  return base;
}

/**
 * Scheduled mandate execution handler. Deterministic invariant enforced here:
 * NO debit without a previously sent pre-debit notice communication on file.
 */
export async function executeScheduledMandateDebit(
  db: Db,
  deps: ToolDeps,
  args: { caseId: string; interventionId: string; attempt: number },
): Promise<{ status: 'executed' | 'blocked' | 'skipped' }> {
  const now = deps.now ?? (() => new Date());
  const pre = await db.transaction(async (tx) => {
    const caseRow = await lockCase(tx, args.caseId);
    if (!caseRow || ['recovered', 'stopped', 'lost', 'disputed'].includes(caseRow.state)) {
      return { kind: 'skip' as const, reason: 'case no longer active' };
    }
    const [customer] = await tx.select().from(customers).where(eq(customers.id, caseRow.customerId)).limit(1);
    if (!customer || customer.optedOut) return { kind: 'skip' as const, reason: 'customer opted out' };
    const [notice] = await tx
      .select({ id: communications.id, sentAt: communications.sentAt })
      .from(communications)
      .where(and(eq(communications.caseId, args.caseId), eq(communications.templateId, 'pre_debit_notice')))
      .limit(1);
    // Existence was not enough. A notice sent 16h before the debit satisfies
    // "a notice exists" and still breaks the rule it exists to satisfy, so the
    // LEAD TIME is what gets checked — the last gate before money moves, and
    // the only one that sees both timestamps.
    const noticeLeadHours = notice?.sentAt ? (now().getTime() - notice.sentAt.getTime()) / 3_600_000 : null;
    const requiredLeadHours = (await getActivePolicy(tx)).config.preDebitNoticeHours;
    if (noticeLeadHours === null || noticeLeadHours < requiredLeadHours) {
      const reason =
        noticeLeadHours === null
          ? 'SAFETY: mandate execution without pre-debit notice'
          : `SAFETY: pre-debit notice only ${noticeLeadHours.toFixed(1)}h old, needs ${requiredLeadHours}h`;
      await transitionCase(tx, caseRow, 'escalated', { reason });
      await writeAudit(tx, {
        caseId: args.caseId,
        actorType: 'system',
        eventType: 'safety.mandate_blocked_no_notice',
        payload: {
          interventionId: args.interventionId,
          noticeSentAt: notice?.sentAt?.toISOString() ?? null,
          noticeLeadHours,
          requiredLeadHours,
        },
      });
      return { kind: 'blocked' as const };
    }
    const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, caseRow.invoiceId)).limit(1);
    if (!invoice || invoice.status === 'paid') return { kind: 'skip' as const, reason: 'invoice already settled' };
    const [method] = await tx
      .select()
      .from(paymentMethods)
      .where(and(eq(paymentMethods.customerId, caseRow.customerId), isNotNull(paymentMethods.mandateRef)))
      .limit(1);
    if (!method?.mandateRef) return { kind: 'skip' as const, reason: 'mandate no longer on file' };
    return {
      kind: 'go' as const,
      amountPaise: invoice.amountDuePaise - invoice.amountPaidPaise,
      mandateRef: method.mandateRef,
      invoiceId: invoice.id,
      customerId: caseRow.customerId,
    };
  });

  if (pre.kind === 'blocked') return { status: 'blocked' };
  if (pre.kind === 'skip') return { status: 'skipped' };

  const idempotencyKey = `${args.caseId}:${args.interventionId}:exec${args.attempt}`;
  const debit = await deps.provider.executeMandateDebit({
    amountPaise: pre.amountPaise,
    currency: 'INR',
    mandateRef: pre.mandateRef,
    invoiceId: pre.invoiceId,
    customerId: pre.customerId,
    idempotencyKey,
  });
  await db.transaction(async (tx) => {
    await writeAudit(tx, {
      caseId: args.caseId,
      actorType: 'system',
      eventType: 'mandate.debit_initiated',
      payload: { providerPaymentId: debit.providerPaymentId, status: debit.status },
    });
    if (debit.status === 'captured') {
      // sandbox resolves synchronously — canonical recovery event through the same outbox path
      const event = CanonicalEvent.parse({
        eventId: randomUUID(),
        occurredAt: now().toISOString(),
        sourceEventId: `sbx:${debit.providerPaymentId}`,
        type: 'payment.recovered',
        customerId: pre.customerId,
        invoiceId: pre.invoiceId,
        amountPaid: pre.amountPaise,
        providerPaymentId: debit.providerPaymentId,
        via: 'mandate_execution',
      });
      await tx.insert(outbox).values({ eventType: event.type, payload: event });
    }
  });
  return { status: 'executed' };
}
