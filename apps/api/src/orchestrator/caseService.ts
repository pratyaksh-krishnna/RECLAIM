import { and, eq, notInArray } from 'drizzle-orm';
import type { CaseState, HoldoutArm, LeakType } from '@reclaim/shared';
import { TERMINAL_STATES } from '@reclaim/shared';
import type { Tx } from '../db/client.js';
import { invoices, recoveryCases } from '../db/schema.js';
import { writeAudit } from '../audit/audit.js';
import { IllegalTransitionError, canTransition } from './fsm.js';
import { assignArm, attributionWindowDays } from './holdout.js';

export type CaseRow = typeof recoveryCases.$inferSelect;

/** Load a case with a row lock — single-writer semantics for every mutation. */
export async function lockCase(tx: Tx, caseId: string): Promise<CaseRow | null> {
  const [row] = await tx
    .select()
    .from(recoveryCases)
    .where(eq(recoveryCases.id, caseId))
    .for('update')
    .limit(1);
  return row ?? null;
}

export async function transitionCase(
  tx: Tx,
  caseRow: CaseRow,
  to: CaseState,
  opts: {
    actorType?: 'system' | 'agent' | 'human' | 'provider';
    actorId?: string | null;
    reason?: string;
    extra?: Partial<typeof recoveryCases.$inferInsert>;
  } = {},
): Promise<void> {
  if (!canTransition(caseRow.state, to)) throw new IllegalTransitionError(caseRow.state, to);
  const now = new Date();
  const closing = (TERMINAL_STATES as readonly string[]).includes(to);
  await tx
    .update(recoveryCases)
    .set({
      state: to,
      lastProgressAt: now,
      ...(closing ? { closedAt: now } : {}),
      ...(opts.extra ?? {}),
    })
    .where(eq(recoveryCases.id, caseRow.id));
  await writeAudit(tx, {
    caseId: caseRow.id,
    actorType: opts.actorType ?? 'system',
    actorId: opts.actorId ?? null,
    eventType: 'case.transition',
    payload: { from: caseRow.state, to, reason: opts.reason ?? null },
  });
  caseRow.state = to;
}

export interface CreateCaseArgs {
  invoiceId: string;
  leakType: LeakType;
  causeHypothesis?: string | null;
  causeConfidence?: number | null;
  rng?: () => number;
  now?: () => Date;
}

/**
 * Find the open case for an invoice or create one (locking the invoice row to
 * serialize concurrent creation). Holdout arm is assigned here, once, forever.
 */
export async function findOrCreateCaseForInvoice(
  tx: Tx,
  args: CreateCaseArgs,
): Promise<{ caseRow: CaseRow; created: boolean }> {
  const [invoice] = await tx
    .select()
    .from(invoices)
    .where(eq(invoices.id, args.invoiceId))
    .for('update')
    .limit(1);
  if (!invoice) throw new Error(`invoice not found: ${args.invoiceId}`);

  const [existing] = await tx
    .select()
    .from(recoveryCases)
    .where(
      and(
        eq(recoveryCases.invoiceId, args.invoiceId),
        notInArray(recoveryCases.state, [...TERMINAL_STATES]),
      ),
    )
    .limit(1);
  if (existing) return { caseRow: existing, created: false };

  const now = (args.now ?? (() => new Date()))();
  const arm: HoldoutArm = assignArm(args.rng);
  const windowDays = attributionWindowDays(args.leakType);
  const deterministicCause = args.causeHypothesis ?? null;

  const [created] = await tx
    .insert(recoveryCases)
    .values({
      customerId: invoice.customerId,
      invoiceId: invoice.id,
      subscriptionId: invoice.subscriptionId,
      state: deterministicCause ? 'diagnosed' : 'detected',
      leakType: args.leakType,
      causeHypothesis: deterministicCause as CaseRow['causeHypothesis'],
      causeConfidence: deterministicCause ? String(args.causeConfidence ?? 0.95) : null,
      exposurePaise: invoice.amountDuePaise - invoice.amountPaidPaise,
      holdoutArm: arm,
      attributionWindowEndsAt: new Date(now.getTime() + windowDays * 86_400_000),
      openedAt: now,
    })
    .returning();
  if (!created) throw new Error('case insert failed');

  await writeAudit(tx, {
    caseId: created.id,
    actorType: 'system',
    eventType: 'case.created',
    payload: {
      leakType: args.leakType,
      holdoutArm: arm,
      exposurePaise: created.exposurePaise,
      deterministicCause,
      attributionWindowDays: windowDays,
    },
  });
  return { caseRow: created, created: true };
}
