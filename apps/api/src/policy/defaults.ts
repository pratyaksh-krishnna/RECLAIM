import type { PolicyConfig } from '@reclaim/shared';

/**
 * Seed policy configuration, version 1. Stored in policy_rules and editable
 * in the Policy Studio; these constants are only the version-1 seed values.
 */
export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  quietHours: { startHour: 21, endHour: 9 },
  maxRecoveryAttemptsPerInvoice: 4,
  minHoursBetweenAttempts: 24,
  maxEmailsPerRolling14d: 3,
  autonomousAmountCapPaise: 500_000, // ₹5,000
  afaThresholdPaise: 1_500_000, // ₹15,000 — e-mandate AFA line
  preDebitNoticeHours: 24,
  confidenceGate: { minConfidence: 0.6, exposureThresholdPaise: 1_000_000 }, // ₹10,000
  loopGuards: { maxAgentInvocationsPerCase: 12, maxCaseAgeHoursWithoutProgress: 96 },
};
