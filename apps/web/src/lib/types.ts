/** API row shapes consumed by the UI (server is the source of truth). */
export interface CaseListRow {
  id: string;
  state: string;
  leakType: string;
  causeHypothesis: string | null;
  causeConfidence: string | null;
  exposurePaise: number;
  holdoutArm: 'treatment' | 'holdout';
  customerName: string;
  customerEmail: string;
  nextAction: string | null;
  openedAt: string;
  urgencySignals: string[];
}

export interface RuleTraceEntry {
  ruleId: string;
  category: string;
  description: string;
  outcome: 'pass' | 'deny' | 'require_approval' | 'skipped';
  detail: string | null;
}

export interface CaseDetail {
  case: {
    id: string;
    state: string;
    leakType: string;
    causeHypothesis: string | null;
    causeConfidence: string | null;
    exposurePaise: number;
    holdoutArm: 'treatment' | 'holdout';
    openedAt: string;
    closedAt: string | null;
    stopReason: string | null;
    urgencySignals: string[];
    recoveryAttemptCount: number;
    agentInvocationCount: number;
    waitUntil: string | null;
    attributionWindowEndsAt: string;
  };
  customer: { id: string; name: string; email: string; optedOut: boolean; timezone: string } | null;
  invoice: { id: string; amountDuePaise: number; amountPaidPaise: number; status: string; dueDate: string; providerInvoiceId: string | null } | null;
  agentDecisions: Array<{
    id: string; agent: string; model: string; promptVersionHash: string; output: unknown;
    schemaValid: boolean; confidence: string | null; latencyMs: number; createdAt: string;
  }>;
  policyDecisions: Array<{ id: string; verdict: string; reason: string | null; ruleTrace: RuleTraceEntry[]; policyVersion: number; createdAt: string; interventionId: string | null }>;
  communications: Array<{ id: string; direction: string; templateId: string | null; renderedSubject: string | null; renderedBody: string; sentAt: string | null; language: string | null }>;
  interventions: Array<{ id: string; actionType: string; params: unknown; rationale: string | null; confidence: string | null; stopConditions: string[]; proposedBy: string; status: string; createdAt: string; executedAt: string | null }>;
  promises: Array<{ id: string; promisedDate: string; amountReference: string | null; status: string }>;
  ledger: Array<{ id: string; amountPaise: number; attributionClass: string; entryType: string; recordedAt: string }>;
  audit: Array<{ id: string; actorType: string; actorId: string | null; eventType: string; payload: unknown; createdAt: string }>;
}

export interface RevenueRisk {
  openCases: number;
  openExposurePaise: number;
  pendingApprovals: number;
  escalated: number;
  disputed: number;
}

export interface RecoveryReport {
  treatment: { cases: number; recovered: number; grossRecoveredPaise: number };
  holdout: { cases: number; recovered: number; baselineRecoveredPaise: number };
  creditedRecoveredPaise: number;
  incremental: { p1: number; p2: number; diff: number; ciLow: number; ciHigh: number; n1: number; n2: number };
  incrementalRecoveredPaiseEstimate: number;
}

/**
 * One item in the human inbox. Two shapes share it because two different
 * things need a person: an `approval` is one proposed action awaiting a
 * yes/no, while an `escalation` is a whole case the pipeline handed over
 * with no action proposed at all — the human decides what to do.
 */
export interface HumanQueueItem {
  kind: 'approval' | 'escalation';
  intervention: { id: string; actionType: string; params: unknown; rationale: string | null; confidence: string | null; createdAt: string; caseId: string } | null;
  caseRow: { id: string; exposurePaise: number; state: string; causeHypothesis: string | null; holdoutArm: 'treatment' | 'holdout' };
  customerName: string;
  summary: string | null;
  escalationReason: string | null;
}

export interface PolicyVersionRow {
  id: string;
  version: number;
  config: Record<string, unknown>;
  comment: string | null;
  active: boolean;
  createdAt: string;
}

export interface InterventionStat {
  actionType: string;
  proposed: number;
  executed: number;
  casesRecoveredAfter: number;
}
