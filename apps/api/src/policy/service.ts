import { and, desc, eq, gt, isNotNull } from 'drizzle-orm';
import {
  ActionParams,
  Confidence,
  PolicyConfig,
  type PolicyDecisionResult,
  PolicyRequest,
} from '@reclaim/shared';
import type { Db, Tx } from '../db/client.js';
import {
  communications,
  customers,
  failureEvents,
  interventions,
  invoices,
  policyDecisions,
  policyRules,
} from '../db/schema.js';
import type { CaseRow } from '../orchestrator/caseService.js';
import { DEFAULT_POLICY_CONFIG, evaluatePolicyRequest } from './engine.js';

export async function getActivePolicy(tx: Tx | Db): Promise<{ config: PolicyConfig; version: number }> {
  const [row] = await tx.select().from(policyRules).where(eq(policyRules.active, true)).orderBy(desc(policyRules.version)).limit(1);
  if (!row) return { config: DEFAULT_POLICY_CONFIG, version: 0 };
  return { config: PolicyConfig.parse(row.config), version: row.version };
}

/** Insert the version-1 seed policy if the table is empty. */
export async function ensureSeedPolicy(db: Db): Promise<void> {
  const [row] = await db.select({ id: policyRules.id }).from(policyRules).limit(1);
  if (row) return;
  await db.insert(policyRules).values({
    version: 1,
    config: DEFAULT_POLICY_CONFIG,
    comment: 'seed policy v1',
    active: true,
  });
}

/**
 * Build the full deterministic context for a proposal, evaluate, persist the
 * PolicyDecision, and link it to the intervention — all inside the caller's tx.
 */
export async function evaluateAndPersistPolicy(
  tx: Tx,
  caseRow: CaseRow,
  interventionId: string,
  now: () => Date = () => new Date(),
): Promise<PolicyDecisionResult> {
  const [intervention] = await tx.select().from(interventions).where(eq(interventions.id, interventionId)).limit(1);
  if (!intervention) throw new Error(`intervention not found: ${interventionId}`);
  const [customer] = await tx.select().from(customers).where(eq(customers.id, caseRow.customerId)).limit(1);
  if (!customer) throw new Error(`customer not found: ${caseRow.customerId}`);
  const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, caseRow.invoiceId)).limit(1);
  if (!invoice) throw new Error(`invoice not found: ${caseRow.invoiceId}`);
  const [latestFailure] = await tx
    .select()
    .from(failureEvents)
    .where(eq(failureEvents.invoiceId, caseRow.invoiceId))
    .orderBy(desc(failureEvents.occurredAt))
    .limit(1);

  const nowDate = now();
  const since14d = new Date(nowDate.getTime() - 14 * 86_400_000);
  const emails = await tx
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

  const request = PolicyRequest.parse({
    caseId: caseRow.id,
    customerId: caseRow.customerId,
    invoiceId: caseRow.invoiceId,
    action: ActionParams.parse(intervention.params),
    proposedBy: intervention.proposedBy,
    strategyConfidence:
      intervention.confidence !== null ? Confidence.parse(Number(intervention.confidence)) : null,
    holdoutArm: caseRow.holdoutArm,
    amountDue: invoice.amountDuePaise - invoice.amountPaidPaise,
    rail: latestFailure?.rail ?? 'netbanking',
    declineClass: latestFailure?.declineClass ?? null,
    hasOptOut: customer.optedOut,
    // durable flag, not `state === 'disputed'` — moving the case to another
    // state must never silently lift a compliance freeze
    hasOpenDispute: caseRow.disputedAt !== null,
    channelConsent: { email: customer.emailConsent },
    customerTimezone: customer.timezone,
    nowIso: nowDate.toISOString(),
    recoveryAttemptCount: caseRow.recoveryAttemptCount,
    lastAttemptAt: caseRow.lastAttemptAt?.toISOString() ?? null,
    emailsSentLast14d: emails.length,
    agentInvocationCount: caseRow.agentInvocationCount,
    caseAgeHours: (nowDate.getTime() - caseRow.openedAt.getTime()) / 3_600_000,
    preDebitNotificationScheduledFor: null,
  });

  const { config, version } = await getActivePolicy(tx);
  const result = evaluatePolicyRequest(request, config, version);

  const [decision] = await tx
    .insert(policyDecisions)
    .values({
      caseId: caseRow.id,
      interventionId,
      requestSnapshot: request,
      verdict: result.verdict,
      reason: result.reason,
      ruleTrace: result.ruleTrace,
      policyVersion: result.policyVersion,
    })
    .returning({ id: policyDecisions.id });
  if (decision) {
    await tx.update(interventions).set({ policyDecisionId: decision.id }).where(eq(interventions.id, interventionId));
  }
  return result;
}
