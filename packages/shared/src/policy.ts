import { z } from 'zod';
import { ActionParams } from './actions.js';
import { Confidence, DeclineClass, HoldoutArm, Paise, PaymentRail, PolicyVerdict } from './enums.js';

/**
 * Everything the deterministic policy engine needs to evaluate a proposed
 * action. Built entirely server-side from DB state — never from agent output
 * except the action itself and its confidence.
 */
export const PolicyRequest = z.object({
  caseId: z.string().uuid(),
  customerId: z.string().uuid(),
  invoiceId: z.string().uuid(),
  action: ActionParams,
  proposedBy: z.enum(['agent', 'human']),
  strategyConfidence: Confidence.nullable(),

  // deterministic context snapshot
  holdoutArm: HoldoutArm,
  amountDue: Paise,
  rail: PaymentRail,
  declineClass: DeclineClass.nullable(),
  hasOptOut: z.boolean(),
  hasOpenDispute: z.boolean(),
  channelConsent: z.record(z.string(), z.boolean()),
  customerTimezone: z.string(),
  nowIso: z.string().datetime(),
  recoveryAttemptCount: z.number().int().nonnegative(),
  lastAttemptAt: z.string().datetime().nullable(),
  emailsSentLast14d: z.number().int().nonnegative(),
  agentInvocationCount: z.number().int().nonnegative(),
  caseAgeHours: z.number().nonnegative(),
  /** exists when a pre-debit notification job has been scheduled for a pending mandate re-execution */
  preDebitNotificationScheduledFor: z.string().datetime().nullable(),
});
export type PolicyRequest = z.infer<typeof PolicyRequest>;

export const RuleTraceEntry = z.object({
  ruleId: z.string(),
  category: z.string(),
  description: z.string(),
  outcome: z.enum(['pass', 'deny', 'require_approval', 'skipped']),
  detail: z.string().nullable(),
});
export type RuleTraceEntry = z.infer<typeof RuleTraceEntry>;

export const PolicyDecisionResult = z.object({
  verdict: PolicyVerdict,
  reason: z.string().nullable(),
  ruleTrace: z.array(RuleTraceEntry),
  policyVersion: z.number().int().positive(),
});
export type PolicyDecisionResult = z.infer<typeof PolicyDecisionResult>;

/** Shape of the versioned policy rule config stored in Postgres. */
export const PolicyConfig = z.object({
  quietHours: z.object({ startHour: z.number().int().min(0).max(23), endHour: z.number().int().min(0).max(23) }),
  maxRecoveryAttemptsPerInvoice: z.number().int().positive(),
  minHoursBetweenAttempts: z.number().positive(),
  maxEmailsPerRolling14d: z.number().int().positive(),
  /** paise; autonomous money-touching actions above this require approval */
  autonomousAmountCapPaise: Paise,
  /** paise; e-mandate debit above this requires AFA → only payment link allowed autonomously */
  afaThresholdPaise: Paise,
  /** hours of advance notice required before any UPI AutoPay / e-mandate re-execution */
  preDebitNoticeHours: z.number().positive(),
  confidenceGate: z.object({ minConfidence: Confidence, exposureThresholdPaise: Paise }),
  /**
   * paise; a promise to pay that an agent read out of a customer's reply is
   * accepted automatically at or below this exposure, and needs a human above
   * it. Accepting one pauses collection until the promised date, so the cost of
   * being wrong scales with the amount at stake.
   *
   * Defaulted, so policy rows written before this rule existed still parse —
   * the engine parses the stored config strictly on every evaluation.
   */
  promiseApprovalThresholdPaise: Paise.default(200_000),
  loopGuards: z.object({ maxAgentInvocationsPerCase: z.number().int().positive(), maxCaseAgeHoursWithoutProgress: z.number().positive() }),
});
export type PolicyConfig = z.infer<typeof PolicyConfig>;
