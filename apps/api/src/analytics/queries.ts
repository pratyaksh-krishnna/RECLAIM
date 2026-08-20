import { eq, notInArray, sql as dsql } from 'drizzle-orm';
import { TERMINAL_STATES } from '@reclaim/shared';
import type { Db } from '../db/client.js';
import { interventions, recoveryCases, recoveryLedger } from '../db/schema.js';
import { twoProportionCI, type TwoProportionResult } from '../attribution/stats.js';

export interface RevenueRiskSummary {
  openCases: number;
  openExposurePaise: number;
  pendingApprovals: number;
  escalated: number;
  disputed: number;
}

export async function revenueRiskSummary(db: Db): Promise<RevenueRiskSummary> {
  const [open] = await db
    .select({ n: dsql<number>`count(*)::int`, exposure: dsql<number>`coalesce(sum(${recoveryCases.exposurePaise}), 0)::bigint` })
    .from(recoveryCases)
    .where(notInArray(recoveryCases.state, [...TERMINAL_STATES]));
  const [approvals] = await db
    .select({ n: dsql<number>`count(*)::int` })
    .from(recoveryCases)
    .where(eq(recoveryCases.state, 'pending_approval'));
  const [esc] = await db
    .select({ n: dsql<number>`count(*)::int` })
    .from(recoveryCases)
    .where(eq(recoveryCases.state, 'escalated'));
  const [disp] = await db
    .select({ n: dsql<number>`count(*)::int` })
    .from(recoveryCases)
    .where(eq(recoveryCases.state, 'disputed'));
  return {
    openCases: open?.n ?? 0,
    openExposurePaise: Number(open?.exposure ?? 0),
    pendingApprovals: approvals?.n ?? 0,
    escalated: esc?.n ?? 0,
    disputed: disp?.n ?? 0,
  };
}

export interface RecoveryReport {
  treatment: { cases: number; recovered: number; grossRecoveredPaise: number };
  holdout: { cases: number; recovered: number; baselineRecoveredPaise: number };
  /** credited = direct + assisted only; external is never credited */
  creditedRecoveredPaise: number;
  incremental: TwoProportionResult;
  /** treatment gross minus what the holdout rate says would have arrived anyway */
  incrementalRecoveredPaiseEstimate: number;
}

export async function recoveryReport(db: Db): Promise<RecoveryReport> {
  const armCounts = await db
    .select({
      arm: recoveryCases.holdoutArm,
      total: dsql<number>`count(*)::int`,
      recovered: dsql<number>`count(*) filter (where ${recoveryCases.state} = 'recovered')::int`,
    })
    .from(recoveryCases)
    .groupBy(recoveryCases.holdoutArm);
  const t = armCounts.find((r) => r.arm === 'treatment') ?? { total: 0, recovered: 0 };
  const h = armCounts.find((r) => r.arm === 'holdout') ?? { total: 0, recovered: 0 };

  // net ledger amounts (recoveries minus reversals)
  const ledgerSums = await db
    .select({
      arm: recoveryLedger.holdoutArm,
      cls: recoveryLedger.attributionClass,
      net: dsql<number>`coalesce(sum(case when ${recoveryLedger.entryType} = 'reversal' then -${recoveryLedger.amountPaise} else ${recoveryLedger.amountPaise} end), 0)::bigint`,
    })
    .from(recoveryLedger)
    .groupBy(recoveryLedger.holdoutArm, recoveryLedger.attributionClass);

  const sumWhere = (arm: string, classes: string[]): number =>
    ledgerSums
      .filter((r) => r.arm === arm && classes.includes(r.cls))
      .reduce((acc, r) => acc + Number(r.net), 0);

  const treatmentGross = sumWhere('treatment', ['direct', 'assisted', 'external']);
  const credited = sumWhere('treatment', ['direct', 'assisted']);
  const holdoutBaseline = sumWhere('holdout', ['direct', 'assisted', 'external']);

  const incremental = twoProportionCI(t.recovered, t.total, h.recovered, h.total);
  // "holdout says Y would have arrived anyway": holdout rate × treatment cases × avg recovered amount
  const avgRecoveredPaise = t.recovered > 0 ? treatmentGross / t.recovered : 0;
  const wouldHaveArrived = Math.round(incremental.p2 * t.total * avgRecoveredPaise);

  return {
    treatment: { cases: t.total, recovered: t.recovered, grossRecoveredPaise: treatmentGross },
    holdout: { cases: h.total, recovered: h.recovered, baselineRecoveredPaise: holdoutBaseline },
    creditedRecoveredPaise: credited,
    incremental,
    incrementalRecoveredPaiseEstimate: Math.max(0, Math.round(treatmentGross - wouldHaveArrived)),
  };
}

export interface InterventionStats {
  actionType: string;
  proposed: number;
  executed: number;
  casesRecoveredAfter: number;
}

export async function interventionStats(db: Db): Promise<InterventionStats[]> {
  const rows = await db
    .select({
      actionType: interventions.actionType,
      proposed: dsql<number>`count(*)::int`,
      executed: dsql<number>`count(*) filter (where ${interventions.status} = 'executed')::int`,
      casesRecoveredAfter: dsql<number>`count(distinct ${interventions.caseId}) filter (where ${interventions.status} = 'executed' and exists (select 1 from ${recoveryCases} rc where rc.id = ${interventions.caseId} and rc.state = 'recovered'))::int`,
    })
    .from(interventions)
    .groupBy(interventions.actionType);
  return rows.map((r) => ({
    actionType: r.actionType,
    proposed: r.proposed,
    executed: r.executed,
    casesRecoveredAfter: r.casesRecoveredAfter,
  }));
}
