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
import type { CaseRow } from '../orchestrator/caseService.js';

/**
 * Bounded, structured context snapshot for agent calls. Everything here is a
 * fact from the DB; sizes are capped so snapshots stay small and auditable.
 */
export interface CaseContext {
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

export async function buildCaseContext(tx: Tx, caseRow: CaseRow, now: () => Date = () => new Date()): Promise<CaseContext> {
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
  const since14d = new Date(now().getTime() - 14 * 86_400_000);
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

  const daysOverdue = Math.max(0, Math.floor((now().getTime() - invoice.dueDate.getTime()) / 86_400_000));

  return {
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
    hasPaymentLinkOutstanding: comms.some((c) => c.templateId === 'payment_link_delivery'),
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
