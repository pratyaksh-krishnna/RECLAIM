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
export type HumanQueueKind = 'approval' | 'escalation' | 'dispute';

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
  // ---- case-scoped work: nothing was proposed, the case itself needs a human ----
  // `escalated` is the pipeline giving up. `disputed` is a compliance freeze
  // that, by design, only a human can lift — recovery_cases carries a
  // dispute_resolved_by_user_id for exactly that. Both were invisible here
  // before: a disputed case had no intervention and was not 'escalated', so it
  // sat frozen and unreachable while the Summarizer wrote it a brief nobody read.
  const caseRows = await db
    .select({ caseRow: recoveryCases, customerName: customers.name })
    .from(recoveryCases)
    .innerJoin(customers, eq(customers.id, recoveryCases.customerId))
    .where(inArray(recoveryCases.state, ['escalated', 'disputed']));

  const caseIds = caseRows.map((r) => r.caseRow.id);

  // one query for the audit trail of every such case, reduced in memory —
  // avoids an N+1 as the backlog grows
  const trail = caseIds.length
    ? await db
        .select({
          caseId: auditEvents.caseId,
          eventType: auditEvents.eventType,
          payload: auditEvents.payload,
        })
        .from(auditEvents)
        .where(
          and(
            inArray(auditEvents.caseId, caseIds),
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
    } else if (
      (payload.to === 'escalated' || payload.to === 'disputed') &&
      typeof payload.reason === 'string'
    ) {
      reasons.set(row.caseId, payload.reason);
    }
  }

  const caseWork: HumanQueueItem[] = caseRows.map((r) => ({
    kind: r.caseRow.state === 'disputed' ? 'dispute' : 'escalation',
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

  const caseWorkSet = new Set(caseIds);
  const approvals: HumanQueueItem[] = approvalRows
    // a stale proposal on an escalated/disputed case is not a separate
    // decision — that case is already represented in the queue
    .filter((r) => !caseWorkSet.has(r.caseRow.id))
    .map((r) => ({
      kind: 'approval',
      caseRow: r.caseRow,
      customerName: r.customerName,
      intervention: r.intervention,
      summary: null,
      escalationReason: null,
    }));

  return [...caseWork, ...approvals].sort((a, b) => b.caseRow.exposurePaise - a.caseRow.exposurePaise);
}
