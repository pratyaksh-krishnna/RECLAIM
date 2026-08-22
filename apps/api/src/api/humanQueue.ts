import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { auditEvents, customers, interventions, recoveryCases } from '../db/schema.js';

/**
 * The human work queue.
 *
 * Two different things need a person, and they are scoped differently:
 *
 *  - an APPROVAL is intervention-scoped: the policy engine returned
 *    REQUIRE_APPROVAL on one specific proposed action, so a human says
 *    yes or no to that action.
 *
 *  - an ESCALATION is case-scoped: the pipeline gave up (loop guard, agent
 *    schema failure, prompt injection, a tool that failed permanently, or an
 *    explicit escalate_to_human) and there is NO proposed action at all.
 *
 * This queue used to select only `interventions.status = 'pending_approval'`,
 * so escalated cases — the ones that by definition require a human decision —
 * could never match and were invisible in the approvals area. The Summarizer
 * was already writing a summary "for a human escalation inbox" that nothing
 * read. Both kinds now land in one inbox, ranked by exposure.
 */
export type HumanQueueKind = 'approval' | 'escalation';

export interface HumanQueueItem {
  kind: HumanQueueKind;
  caseRow: typeof recoveryCases.$inferSelect;
  customerName: string;
  /** the action awaiting a yes/no — always null for an escalation */
  intervention: typeof interventions.$inferSelect | null;
  /** Summarizer output for the escalation inbox, if it has run */
  summary: string | null;
  /** why the pipeline handed this case to a human */
  escalationReason: string | null;
}

export async function humanQueue(db: Db): Promise<HumanQueueItem[]> {
  // ---- escalations: case-scoped, no intervention exists ----
  const escalatedRows = await db
    .select({ caseRow: recoveryCases, customerName: customers.name })
    .from(recoveryCases)
    .innerJoin(customers, eq(customers.id, recoveryCases.customerId))
    .where(eq(recoveryCases.state, 'escalated'));

  const escalatedIds = escalatedRows.map((r) => r.caseRow.id);

  // one query for the audit trail of every escalated case, reduced in memory —
  // avoids an N+1 as the escalation backlog grows
  const trail = escalatedIds.length
    ? await db
        .select({
          caseId: auditEvents.caseId,
          eventType: auditEvents.eventType,
          payload: auditEvents.payload,
        })
        .from(auditEvents)
        .where(
          and(
            inArray(auditEvents.caseId, escalatedIds),
            inArray(auditEvents.eventType, ['case.summary', 'case.transition']),
          ),
        )
        .orderBy(asc(auditEvents.createdAt))
    : [];

  const summaries = new Map<string, string>();
  const reasons = new Map<string, string>();
  for (const row of trail) {
    if (!row.caseId) continue;
    const payload = row.payload as { summary?: string; to?: string; reason?: string | null };
    // later rows overwrite earlier ones, so each map ends up holding the latest
    if (row.eventType === 'case.summary') {
      if (typeof payload.summary === 'string') summaries.set(row.caseId, payload.summary);
    } else if (payload.to === 'escalated' && typeof payload.reason === 'string') {
      reasons.set(row.caseId, payload.reason);
    }
  }

  const escalations: HumanQueueItem[] = escalatedRows.map((r) => ({
    kind: 'escalation',
    caseRow: r.caseRow,
    customerName: r.customerName,
    intervention: null,
    summary: summaries.get(r.caseRow.id) ?? null,
    escalationReason: reasons.get(r.caseRow.id) ?? null,
  }));

  // ---- approvals: intervention-scoped ----
  const approvalRows = await db
    .select({ intervention: interventions, caseRow: recoveryCases, customerName: customers.name })
    .from(interventions)
    .innerJoin(recoveryCases, eq(recoveryCases.id, interventions.caseId))
    .innerJoin(customers, eq(customers.id, recoveryCases.customerId))
    .where(eq(interventions.status, 'pending_approval'));

  const escalatedSet = new Set(escalatedIds);
  const approvals: HumanQueueItem[] = approvalRows
    // a stale proposal on an escalated case is not a separate decision —
    // the escalation already represents that case in the queue
    .filter((r) => !escalatedSet.has(r.caseRow.id))
    .map((r) => ({
      kind: 'approval',
      caseRow: r.caseRow,
      customerName: r.customerName,
      intervention: r.intervention,
      summary: null,
      escalationReason: null,
    }));

  return [...escalations, ...approvals].sort((a, b) => b.caseRow.exposurePaise - a.caseRow.exposurePaise);
}
