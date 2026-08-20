import { and, desc, eq } from 'drizzle-orm';
import type { CanonicalEvent, PolicyDecisionResult } from '@reclaim/shared';
import type { Db, Tx } from '../db/client.js';
import {
  agentDecisions,
  interventions,
  invoices,
  payments,
  promisesToPay,
  recoveryCases,
  recoveryLedger,
} from '../db/schema.js';
import { writeAudit } from '../audit/audit.js';
import { classifyAttribution } from '../attribution/attribution.js';
import { causeFromDeclineCode } from '../domain/causeMapping.js';
import { classifyDeclineCode, isUnambiguous } from '../domain/declineTable.js';
import { findOrCreateCaseForInvoice, lockCase, transitionCase, type CaseRow } from './caseService.js';
import { isTerminal } from './fsm.js';

/**
 * The supervisor. Deterministic code, NOT an LLM: routes cases through the
 * FSM, decides which agent runs next, enforces loop guards, and is the only
 * component that closes cases.
 */

export type AgentKind = 'triage' | 'diagnosis' | 'strategy' | 'communication' | 'reply_interpreter' | 'summarizer';

export interface OrchestratorDeps {
  enqueueAgent(job: { caseId: string; agent: AgentKind; communicationId?: string }): Promise<void>;
  enqueueCaseStep(caseId: string, trigger: string, delayMs?: number): Promise<void>;
  enqueueTool(job: { caseId: string; interventionId: string; attempt: number }): Promise<void>;
  /** the deterministic policy engine (mandatory middleware; injected) */
  evaluatePolicy(tx: Tx, caseRow: CaseRow, interventionId: string): Promise<PolicyDecisionResult>;
  loopGuards(): Promise<{ maxAgentInvocationsPerCase: number; maxCaseAgeHoursWithoutProgress: number }>;
  rng?: () => number;
  now?: () => Date;
}

const nowOf = (deps: OrchestratorDeps) => (deps.now ?? (() => new Date()))();

/** Entry point for canonical events arriving from the outbox relay. */
export async function handleCanonicalEvent(db: Db, deps: OrchestratorDeps, event: CanonicalEvent): Promise<void> {
  switch (event.type) {
    case 'payment.failed': {
      const declineClass = classifyDeclineCode(event.declineCode);
      const cause = causeFromDeclineCode(event.declineCode);
      const { caseRow, created } = await db.transaction(async (tx) => {
        const res = await findOrCreateCaseForInvoice(tx, {
          invoiceId: event.invoiceId,
          leakType: 'subscription_payment_failure',
          causeHypothesis: isUnambiguous(declineClass) ? cause : null,
          ...(deps.rng ? { rng: deps.rng } : {}),
          ...(deps.now ? { now: deps.now } : {}),
        });
        if (!res.created) {
          await writeAudit(tx, {
            caseId: res.caseRow.id,
            actorType: 'provider',
            eventType: 'case.repeat_failure',
            payload: { eventId: event.eventId, declineCode: event.declineCode },
          });
        }
        return res;
      });
      if (created) await deps.enqueueCaseStep(caseRow.id, 'case_created');
      else await deps.enqueueCaseStep(caseRow.id, 're_evaluate');
      return;
    }

    case 'invoice.overdue': {
      const { caseRow, created } = await db.transaction(async (tx) =>
        findOrCreateCaseForInvoice(tx, {
          invoiceId: event.invoiceId,
          leakType: 'invoice_overdue',
          ...(deps.rng ? { rng: deps.rng } : {}),
          ...(deps.now ? { now: deps.now } : {}),
        }),
      );
      if (created) await deps.enqueueCaseStep(caseRow.id, 'case_created');
      return;
    }

    case 'subscription.retrying': {
      // Razorpay's own retry cycle is running: hold off on aggressive outreach.
      if (!event.invoiceId) return;
      await withOpenCaseForInvoice(db, event.invoiceId, async (tx, caseRow) => {
        if (isTerminal(caseRow.state) || caseRow.state === 'waiting') return;
        if (['detected', 'diagnosed', 'executing', 're_evaluating', 'planned'].includes(caseRow.state)) {
          // planned has no direct →waiting edge; route via legal edges when needed
          if (caseRow.state === 'planned') return; // policy gate will run; strategy already aware via context
          await transitionCase(tx, caseRow, 'waiting', {
            reason: 'provider retry cycle active (subscription.pending)',
            extra: { waitUntil: new Date(nowOf(deps).getTime() + 72 * 3_600_000) },
          });
        }
      });
      return;
    }

    case 'subscription.retries_exhausted': {
      // Provider gave up — our recovery plan starts now.
      if (event.invoiceId) {
        const invoiceId = event.invoiceId;
        const caseId = await withOpenCaseForInvoice(db, invoiceId, async (tx, caseRow) => {
          if (caseRow.state === 'waiting') {
            await transitionCase(tx, caseRow, 're_evaluating', {
              reason: 'provider retries exhausted (subscription.halted)',
            });
          }
          return caseRow.id;
        });
        if (caseId) {
          await deps.enqueueCaseStep(caseId, 're_evaluate');
          return;
        }
        // no case yet (e.g. halted without a prior payment.failed we saw)
        const { caseRow, created } = await db.transaction(async (tx) =>
          findOrCreateCaseForInvoice(tx, {
            invoiceId,
            leakType: 'subscription_payment_failure',
            ...(deps.rng ? { rng: deps.rng } : {}),
            ...(deps.now ? { now: deps.now } : {}),
          }),
        );
        if (created) await deps.enqueueCaseStep(caseRow.id, 'case_created');
      }
      return;
    }

    case 'payment.recovered': {
      await recordRecovery(db, deps, event);
      return;
    }

    case 'customer.responded': {
      const caseId = event.caseId;
      const communicationId = event.communicationId;
      await db.transaction(async (tx) => {
        await writeAudit(tx, {
          caseId,
          actorType: 'provider',
          eventType: 'customer.responded',
          payload: { communicationId },
        });
      });
      const [caseRow] = await db.select().from(recoveryCases).where(eq(recoveryCases.id, caseId)).limit(1);
      if (caseRow && !isTerminal(caseRow.state) && caseRow.holdoutArm === 'treatment' && communicationId) {
        await deps.enqueueAgent({ caseId, agent: 'reply_interpreter', communicationId });
      }
      return;
    }

    case 'customer.broke_promise': {
      await db.transaction(async (tx) => {
        await tx
          .update(promisesToPay)
          .set({ status: 'broken', resolvedAt: nowOf(deps) })
          .where(and(eq(promisesToPay.id, event.promiseId), eq(promisesToPay.status, 'open')));
        const caseRow = await lockCase(tx, event.caseId);
        if (caseRow && ['waiting', 'executing'].includes(caseRow.state)) {
          await transitionCase(tx, caseRow, 're_evaluating', { reason: 'promise to pay broken' });
        }
      });
      await deps.enqueueCaseStep(event.caseId, 're_evaluate');
      return;
    }

    case 'payment_link.expired': {
      const caseId = await withOpenCaseForInvoice(db, event.invoiceId, async (tx, caseRow) => {
        if (['waiting', 'executing'].includes(caseRow.state)) {
          await transitionCase(tx, caseRow, 're_evaluating', { reason: 'payment link expired unpaid' });
          return caseRow.id;
        }
        return null;
      });
      if (caseId) await deps.enqueueCaseStep(caseId, 're_evaluate');
      return;
    }

    case 'refund.recorded': {
      await db.transaction(async (tx) => {
        await writeAudit(tx, {
          actorType: 'provider',
          eventType: 'refund.recorded',
          payload: { invoiceId: event.invoiceId, amount: event.amount },
        });
      });
      return;
    }

    case 'recovery.stopped': {
      await db.transaction(async (tx) => {
        const caseRow = await lockCase(tx, event.caseId);
        if (caseRow && !isTerminal(caseRow.state)) {
          await transitionCase(tx, caseRow, 'stopped', {
            reason: event.reason,
            extra: { stopReason: event.reason },
          });
        }
      });
      return;
    }
  }
}

async function withOpenCaseForInvoice<T>(
  db: Db,
  invoiceId: string,
  fn: (tx: Tx, caseRow: CaseRow) => Promise<T>,
): Promise<T | null> {
  return db.transaction(async (tx) => {
    const [found] = await tx
      .select({ id: recoveryCases.id })
      .from(recoveryCases)
      .where(eq(recoveryCases.invoiceId, invoiceId))
      .orderBy(desc(recoveryCases.openedAt))
      .limit(1);
    if (!found) return null;
    const caseRow = await lockCase(tx, found.id);
    if (!caseRow) return null;
    return fn(tx, caseRow);
  });
}

/** Recovery: payment row, invoice paid, ledger entry, case closed — one tx. */
async function recordRecovery(
  db: Db,
  deps: OrchestratorDeps,
  event: Extract<CanonicalEvent, { type: 'payment.recovered' }>,
): Promise<void> {
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(payments)
      .values({
        invoiceId: event.invoiceId,
        customerId: event.customerId,
        amountPaise: event.amountPaid,
        status: 'captured',
        rail: 'card', // rail of the recovery payment is provider-reported; default card
        via: event.via,
        providerPaymentId: event.providerPaymentId,
        capturedAt: new Date(event.occurredAt),
      })
      .onConflictDoNothing({ target: payments.providerPaymentId })
      .returning({ id: payments.id });
    const payRow = inserted[0];
    if (!payRow && event.providerPaymentId) return; // duplicate delivery — already recorded

    const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, event.invoiceId)).for('update').limit(1);
    if (!invoice) return;
    const newPaid = Math.min(invoice.amountDuePaise, invoice.amountPaidPaise + event.amountPaid);
    await tx
      .update(invoices)
      .set({ amountPaidPaise: newPaid, status: newPaid >= invoice.amountDuePaise ? 'paid' : invoice.status })
      .where(eq(invoices.id, invoice.id));

    const [found] = await tx
      .select({ id: recoveryCases.id })
      .from(recoveryCases)
      .where(eq(recoveryCases.invoiceId, event.invoiceId))
      .orderBy(desc(recoveryCases.openedAt))
      .limit(1);
    if (!found) return;
    const caseRow = await lockCase(tx, found.id);
    if (!caseRow) return;

    const attribution = await classifyAttribution(tx, {
      caseId: caseRow.id,
      via: event.via,
      paidAt: new Date(event.occurredAt),
      attributionWindowEndsAt: caseRow.attributionWindowEndsAt,
    });
    await tx.insert(recoveryLedger).values({
      caseId: caseRow.id,
      invoiceId: invoice.id,
      customerId: caseRow.customerId,
      paymentId: payRow?.id ?? null,
      amountPaise: event.amountPaid,
      attributionClass: attribution,
      holdoutArm: caseRow.holdoutArm,
      entryType: 'recovery',
    });
    if (!isTerminal(caseRow.state)) {
      await transitionCase(tx, caseRow, 'recovered', {
        reason: `paid via ${event.via} (${attribution})`,
      });
    }
    await writeAudit(tx, {
      caseId: caseRow.id,
      actorType: 'provider',
      eventType: 'payment.recovered',
      payload: { amountPaise: event.amountPaid, via: event.via, attribution },
    });
  });
}

/**
 * The per-case router: given current state, run the next deterministic step
 * or enqueue the next agent. Holdout cases NEVER advance.
 */
export async function advanceCase(db: Db, deps: OrchestratorDeps, caseId: string, trigger: string): Promise<void> {
  const guards = await deps.loopGuards();

  const decision = await db.transaction(async (tx) => {
    const caseRow = await lockCase(tx, caseId);
    if (!caseRow || isTerminal(caseRow.state)) return { kind: 'none' as const };

    if (caseRow.holdoutArm === 'holdout') {
      await writeAudit(tx, {
        caseId,
        actorType: 'system',
        eventType: 'case.holdout_noop',
        payload: { trigger, state: caseRow.state },
      });
      return { kind: 'none' as const };
    }

    // loop guards
    if (caseRow.agentInvocationCount >= guards.maxAgentInvocationsPerCase) {
      if (caseRow.state !== 'escalated') {
        await transitionCase(tx, caseRow, 'escalated', { reason: 'loop guard: max agent invocations' });
        return { kind: 'summarize' as const };
      }
      return { kind: 'none' as const };
    }
    const ageHours = (nowOf(deps).getTime() - caseRow.lastProgressAt.getTime()) / 3_600_000;
    if (ageHours >= guards.maxCaseAgeHoursWithoutProgress && caseRow.state !== 'escalated') {
      await transitionCase(tx, caseRow, 'escalated', { reason: 'loop guard: no progress within limit' });
      return { kind: 'summarize' as const };
    }

    switch (caseRow.state) {
      case 'detected': {
        const [triageRun] = await tx
          .select({ id: agentDecisions.id })
          .from(agentDecisions)
          .where(and(eq(agentDecisions.caseId, caseId), eq(agentDecisions.agent, 'triage'), eq(agentDecisions.schemaValid, true)))
          .limit(1);
        return { kind: 'agent' as const, agent: triageRun ? ('diagnosis' as const) : ('triage' as const) };
      }
      case 'diagnosed':
        return { kind: 'agent' as const, agent: 'strategy' as const };
      case 're_evaluating': {
        if (!caseRow.causeHypothesis) return { kind: 'agent' as const, agent: 'diagnosis' as const };
        return { kind: 'agent' as const, agent: 'strategy' as const };
      }
      case 'planned': {
        // policy gate: latest proposed intervention
        const [proposal] = await tx
          .select()
          .from(interventions)
          .where(and(eq(interventions.caseId, caseId), eq(interventions.status, 'proposed')))
          .orderBy(desc(interventions.createdAt))
          .limit(1);
        if (!proposal) return { kind: 'none' as const };
        await transitionCase(tx, caseRow, 'pending_policy', { reason: 'policy evaluation' });
        const verdict = await deps.evaluatePolicy(tx, caseRow, proposal.id);
        if (verdict.verdict === 'ALLOW') {
          await tx.update(interventions).set({ status: 'approved' }).where(eq(interventions.id, proposal.id));
          await transitionCase(tx, caseRow, 'executing', { reason: 'policy ALLOW' });
          return { kind: 'tool' as const, interventionId: proposal.id };
        }
        if (verdict.verdict === 'REQUIRE_APPROVAL') {
          await tx.update(interventions).set({ status: 'pending_approval' }).where(eq(interventions.id, proposal.id));
          await transitionCase(tx, caseRow, 'pending_approval', { reason: verdict.reason ?? 'approval required' });
          return { kind: 'none' as const };
        }
        await tx.update(interventions).set({ status: 'denied' }).where(eq(interventions.id, proposal.id));
        await transitionCase(tx, caseRow, 're_evaluating', { reason: `policy DENY: ${verdict.reason ?? ''}` });
        return { kind: 'step' as const, trigger: 'policy_denied' };
      }
      case 'waiting': {
        if (caseRow.waitUntil && nowOf(deps) >= caseRow.waitUntil) {
          await transitionCase(tx, caseRow, 're_evaluating', { reason: 'wait deadline reached' });
          return { kind: 'step' as const, trigger: 'wait_elapsed' };
        }
        return { kind: 'none' as const };
      }
      case 'pending_policy':
      case 'pending_approval':
      case 'executing':
      case 'escalated':
      case 'disputed':
        return { kind: 'none' as const };
      default:
        return { kind: 'none' as const };
    }
  });

  switch (decision.kind) {
    case 'agent':
      await deps.enqueueAgent({ caseId, agent: decision.agent });
      break;
    case 'tool':
      await deps.enqueueTool({ caseId, interventionId: decision.interventionId, attempt: 1 });
      break;
    case 'step':
      await deps.enqueueCaseStep(caseId, decision.trigger);
      break;
    case 'summarize':
      await deps.enqueueAgent({ caseId, agent: 'summarizer' });
      break;
    case 'none':
      break;
  }
}
