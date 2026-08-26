import { and, desc, eq, gt, isNotNull } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import {
  accounts,
  communications,
  customers,
  failureEvents,
  invoices,
  policyDecisions,
  promisesToPay,
} from '../db/schema.js';
import { contactWindow } from '../policy/engine.js';
import { getActivePolicy } from '../policy/service.js';
import { TEMPLATE_REGISTRY, needsPaymentLink } from '../templates/registry.js';
import type { PolicyConfig, TemplateId } from '@reclaim/shared';
import type { CaseRow } from '../orchestrator/caseService.js';

/**
 * Bounded, structured context snapshot for agent calls. Everything here is a
 * fact from the DB; sizes are capped so snapshots stay small and auditable.
 */
export interface CaseContext {
  /**
   * The clock. Without it an agent cannot turn "wait three days" into anything,
   * and cannot tell whether a cooling-off period has elapsed. It used to be
   * absent: a careful model then refused to propose scheduling actions at all
   * and escalated instead, while a less careful one invented a plausible
   * timestamp that passed every downstream gate unchallenged.
   */
  nowIso: string;
  customerTimezone: string;
  lastAttemptAt: string | null;
  /**
   * Whether this customer may be contacted right now — computed by the SAME
   * function the policy engine's quiet_hours rule uses, so the agent's view and
   * the gate's verdict cannot disagree. Handed over as an answer rather than as
   * a timezone, an instant and an hour range to reconcile: asked to do that
   * itself, an agent read the quiet window as the permitted one and parked an
   * overdue invoice for a day.
   */
  contactAllowedNow: boolean;
  /** when contact becomes permitted again; null when it already is */
  nextContactAllowedAt: string | null;
  /**
   * The deterministic limits the policy engine will enforce on this proposal.
   * Handing them over does not weaken the gate — the engine still decides, and
   * an agent cannot edit these — it just stops the agent guessing at rules it
   * is about to be judged against.
   */
  contactRules: {
    minHoursBetweenAttempts: number;
    maxEmailsPerRolling14d: number;
    maxRecoveryAttemptsPerInvoice: number;
    preDebitNoticeHours: number;
    quietHours: { startHour: number; endHour: number };
  };
  caseId: string;
  leakType: string;
  state: string;
  causeHypothesis: string | null;
  causeConfidence: number | null;
  customerName: string;
  language: string;
  accountKind: string;
  amountDuePaise: number;
  invoiceId: string;
  daysOverdue: number;
  rail: string | null;
  declineCode: string | null;
  declineClass: string | null;
  priorFailureCount: number;
  brokenPromiseCount: number;
  emailsSentLast14d: number;
  hasPaymentLinkOutstanding: boolean;
  recoveryAttemptCount: number;
  lastDenyReason: string | null;
  failureEventIds: string[];
  recentCommunications: Array<{ id: string; direction: string; templateId: string | null; sentAt: string | null; excerpt: string }>;
  eventIds: string[];
}

export async function buildCaseContext(
  tx: Tx,
  caseRow: CaseRow,
  now: () => Date = () => new Date(),
  config?: PolicyConfig,
): Promise<CaseContext> {
  // One clock read for the whole snapshot. nowIso and nextContactAllowedAt are
  // two fields the agent is asked to reason across, so they must describe the
  // same instant rather than three consecutive calls to a moving clock.
  const nowDate = now();
  const [customer] = await tx.select().from(customers).where(eq(customers.id, caseRow.customerId)).limit(1);
  const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, caseRow.invoiceId)).limit(1);
  const [account] = await tx.select().from(accounts).where(eq(accounts.customerId, caseRow.customerId)).limit(1);
  if (!customer || !invoice) throw new Error('context: missing customer or invoice');

  const failures = await tx
    .select()
    .from(failureEvents)
    .where(eq(failureEvents.customerId, caseRow.customerId))
    .orderBy(desc(failureEvents.occurredAt))
    .limit(5);
  const invoiceFailures = failures.filter((f) => f.invoiceId === caseRow.invoiceId);
  const latest = invoiceFailures[0] ?? null;

  const promises = await tx.select().from(promisesToPay).where(eq(promisesToPay.customerId, caseRow.customerId));
  const since14d = new Date(nowDate.getTime() - 14 * 86_400_000);
  const comms = await tx
    .select()
    .from(communications)
    .where(eq(communications.caseId, caseRow.id))
    .orderBy(desc(communications.createdAt))
    .limit(5);
  const emails14d = await tx
    .select({ id: communications.id })
    .from(communications)
    .where(
      and(
        eq(communications.customerId, caseRow.customerId),
        eq(communications.direction, 'outbound'),
        isNotNull(communications.sentAt),
        gt(communications.sentAt, since14d),
      ),
    );
  const [lastDeny] = await tx
    .select()
    .from(policyDecisions)
    .where(and(eq(policyDecisions.caseId, caseRow.id), eq(policyDecisions.verdict, 'DENY')))
    .orderBy(desc(policyDecisions.createdAt))
    .limit(1);

  const daysOverdue = Math.max(0, Math.floor((nowDate.getTime() - invoice.dueDate.getTime()) / 86_400_000));
  const activeConfig = config ?? (await getActivePolicy(tx)).config;
  const nowIso = nowDate.toISOString();
  const window = contactWindow(nowIso, customer.timezone, activeConfig.quietHours);

  return {
    nowIso,
    contactAllowedNow: window.allowedNow,
    nextContactAllowedAt: window.nextAllowedAt,
    customerTimezone: customer.timezone,
    lastAttemptAt: caseRow.lastAttemptAt?.toISOString() ?? null,
    contactRules: {
      minHoursBetweenAttempts: activeConfig.minHoursBetweenAttempts,
      maxEmailsPerRolling14d: activeConfig.maxEmailsPerRolling14d,
      maxRecoveryAttemptsPerInvoice: activeConfig.maxRecoveryAttemptsPerInvoice,
      preDebitNoticeHours: activeConfig.preDebitNoticeHours,
      quietHours: activeConfig.quietHours,
    },
    caseId: caseRow.id,
    leakType: caseRow.leakType,
    state: caseRow.state,
    causeHypothesis: caseRow.causeHypothesis,
    causeConfidence: caseRow.causeConfidence ? Number(caseRow.causeConfidence) : null,
    customerName: customer.name,
    language: customer.preferredLanguage,
    accountKind: account?.kind ?? 'b2c',
    amountDuePaise: invoice.amountDuePaise - invoice.amountPaidPaise,
    invoiceId: invoice.id,
    daysOverdue,
    rail: latest?.rail ?? null,
    declineCode: latest?.declineCode ?? null,
    declineClass: latest?.declineClass ?? null,
    priorFailureCount: failures.length,
    brokenPromiseCount: promises.filter((p) => p.status === 'broken').length,
    emailsSentLast14d: emails14d.length,
    // Any template carrying {{payment_link}} leaves a payable link in the
    // customer's inbox, not just payment_link_delivery. Keyed off that one id,
    // this read false while a live link existed, and the agent proposed
    // another.
    hasPaymentLinkOutstanding: comms.some((c) => {
      const skeleton = c.templateId ? TEMPLATE_REGISTRY[c.templateId as TemplateId] : undefined;
      return skeleton !== undefined && needsPaymentLink(skeleton);
    }),
    recoveryAttemptCount: caseRow.recoveryAttemptCount,
    lastDenyReason: lastDeny?.reason ?? null,
    failureEventIds: invoiceFailures.map((f) => f.id),
    recentCommunications: comms.map((c) => ({
      id: c.id,
      direction: c.direction,
      templateId: c.templateId,
      sentAt: c.sentAt?.toISOString() ?? null,
      excerpt: c.renderedBody.slice(0, 300),
    })),
    eventIds: invoiceFailures.map((f) => f.id),
  };
}
