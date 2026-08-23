import {
  type ActionParams,
  type PolicyConfig,
  type PolicyDecisionResult,
  type PolicyRequest,
  type RuleTraceEntry,
  ALWAYS_ALLOWED_ACTIONS,
  PolicyConfig as PolicyConfigSchema,
} from '@reclaim/shared';
import { isRetryableClass } from '../domain/declineTable.js';
import { DEFAULT_POLICY_CONFIG } from './defaults.js';

/**
 * THE deterministic policy engine. Pure function of (request, config).
 * Mandatory middleware between any proposal (agent OR human) and execution.
 * Evaluation order is fixed; the first DENY wins; REQUIRE_APPROVAL is
 * sticky unless a later rule denies.
 */

/** Actions that attempt to collect money. */
const MONEY_ACTIONS: ReadonlySet<ActionParams['type']> = new Set([
  'schedule_mandate_reexecution',
  'create_payment_link',
]);
/** Actions that contact the customer by email (link delivery includes an email). */
const CONTACT_ACTIONS: ReadonlySet<ActionParams['type']> = new Set([
  'send_email',
  'create_payment_link',
  'schedule_mandate_reexecution', // sends the mandatory pre-debit notice email
]);

export function localHour(nowIso: string, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' });
  return Number(fmt.format(new Date(nowIso)));
}

function inQuietHours(hour: number, startHour: number, endHour: number): boolean {
  return startHour > endHour ? hour >= startHour || hour < endHour : hour >= startHour && hour < endHour;
}

type RuleOutcome = { outcome: 'pass' | 'deny' | 'require_approval' | 'skipped'; detail?: string };
type Rule = { id: string; category: string; description: string; evaluate: (req: PolicyRequest, cfg: PolicyConfig) => RuleOutcome };

const RULES: Rule[] = [
  // ---- 0. structural ------------------------------------------------------
  {
    id: 'holdout_lock',
    category: 'hard_compliance',
    description: 'holdout-arm cases are observe-only: no intervention ever executes',
    evaluate: (req) =>
      req.holdoutArm === 'holdout' && !ALWAYS_ALLOWED_ACTIONS.includes(req.action.type)
        ? { outcome: 'deny', detail: 'case is in the holdout arm' }
        : { outcome: 'pass' },
  },
  // ---- 1. hard compliance --------------------------------------------------
  {
    id: 'opt_out',
    category: 'hard_compliance',
    description: 'no outreach or collection against an opted-out customer',
    evaluate: (req) =>
      req.hasOptOut && !ALWAYS_ALLOWED_ACTIONS.includes(req.action.type)
        ? { outcome: 'deny', detail: 'customer has opted out' }
        : { outcome: 'pass' },
  },
  {
    id: 'open_dispute',
    category: 'hard_compliance',
    description: 'an open dispute freezes all outreach and collection',
    evaluate: (req) =>
      req.hasOpenDispute && !ALWAYS_ALLOWED_ACTIONS.includes(req.action.type)
        ? { outcome: 'deny', detail: 'case has an open dispute' }
        : { outcome: 'pass' },
  },
  {
    id: 'quiet_hours',
    category: 'hard_compliance',
    description: 'no customer contact during quiet hours in the customer timezone',
    evaluate: (req, cfg) => {
      if (!CONTACT_ACTIONS.has(req.action.type)) return { outcome: 'skipped' };
      const hour = localHour(req.nowIso, req.customerTimezone);
      return inQuietHours(hour, cfg.quietHours.startHour, cfg.quietHours.endHour)
        ? { outcome: 'deny', detail: `local hour ${hour} is inside quiet hours` }
        : { outcome: 'pass' };
    },
  },
  {
    id: 'channel_consent',
    category: 'hard_compliance',
    description: 'per-channel consent must exist for the contact channel',
    evaluate: (req) => {
      if (!CONTACT_ACTIONS.has(req.action.type)) return { outcome: 'skipped' };
      return req.channelConsent['email'] === true
        ? { outcome: 'pass' }
        : { outcome: 'deny', detail: 'no email consent' };
    },
  },
  // ---- 2. rail limits ------------------------------------------------------
  {
    id: 'decline_class_retry',
    category: 'rail_limits',
    description: 'mandate re-execution only for retryable decline classes (soft/processor); never hard/auth',
    evaluate: (req) => {
      if (req.action.type !== 'schedule_mandate_reexecution') return { outcome: 'skipped' };
      if (req.declineClass === null) return { outcome: 'deny', detail: 'no classified decline — nothing to legally retry' };
      return isRetryableClass(req.declineClass)
        ? { outcome: 'pass' }
        : { outcome: 'deny', detail: `decline class '${req.declineClass}' is not retryable` };
    },
  },
  {
    id: 'mandate_rail_only',
    category: 'rail_limits',
    description: 'mandate re-execution requires a recurring mandate rail (UPI AutoPay / e-mandate)',
    evaluate: (req) => {
      if (req.action.type !== 'schedule_mandate_reexecution') return { outcome: 'skipped' };
      return req.rail === 'upi_autopay' || req.rail === 'emandate'
        ? { outcome: 'pass' }
        : { outcome: 'deny', detail: `rail '${req.rail}' has no re-executable mandate` };
    },
  },
  {
    id: 'global_attempt_cap',
    category: 'rail_limits',
    description: 'global cap on recovery attempts per invoice',
    evaluate: (req, cfg) => {
      if (!MONEY_ACTIONS.has(req.action.type)) return { outcome: 'skipped' };
      return req.recoveryAttemptCount >= cfg.maxRecoveryAttemptsPerInvoice
        ? { outcome: 'deny', detail: `${req.recoveryAttemptCount} attempts >= cap ${cfg.maxRecoveryAttemptsPerInvoice}` }
        : { outcome: 'pass' };
    },
  },
  {
    id: 'attempt_spacing',
    category: 'rail_limits',
    description: 'minimum spacing between recovery attempts',
    evaluate: (req, cfg) => {
      if (!MONEY_ACTIONS.has(req.action.type) || !req.lastAttemptAt) return { outcome: 'skipped' };
      const hours = (new Date(req.nowIso).getTime() - new Date(req.lastAttemptAt).getTime()) / 3_600_000;
      return hours < cfg.minHoursBetweenAttempts
        ? { outcome: 'deny', detail: `${hours.toFixed(1)}h since last attempt < ${cfg.minHoursBetweenAttempts}h` }
        : { outcome: 'pass' };
    },
  },
  {
    id: 'upi_pre_debit_notice',
    category: 'rail_limits',
    description: 'India: mandate re-execution requires a pre-debit notification lead time before the debit',
    evaluate: (req, cfg) => {
      if (req.action.type !== 'schedule_mandate_reexecution') return { outcome: 'skipped' };
      const leadHours = (new Date(req.action.scheduleAt).getTime() - new Date(req.nowIso).getTime()) / 3_600_000;
      return leadHours < cfg.preDebitNoticeHours
        ? { outcome: 'deny', detail: `debit in ${leadHours.toFixed(1)}h < required ${cfg.preDebitNoticeHours}h pre-debit notice` }
        : { outcome: 'pass' };
    },
  },
  {
    id: 'afa_threshold',
    category: 'rail_limits',
    description: 'India: e-mandate debits above the AFA threshold cannot run autonomously — payment link only',
    evaluate: (req, cfg) => {
      if (req.action.type !== 'schedule_mandate_reexecution') return { outcome: 'skipped' };
      return req.amountDue > cfg.afaThresholdPaise
        ? { outcome: 'deny', detail: `amount ${req.amountDue} > AFA threshold ${cfg.afaThresholdPaise}; use a payment link` }
        : { outcome: 'pass' };
    },
  },
  // ---- 3. contact budget ---------------------------------------------------
  {
    id: 'contact_budget',
    category: 'contact_budget',
    description: 'max emails per rolling 14 days per customer',
    evaluate: (req, cfg) => {
      if (!CONTACT_ACTIONS.has(req.action.type)) return { outcome: 'skipped' };
      return req.emailsSentLast14d >= cfg.maxEmailsPerRolling14d
        ? { outcome: 'deny', detail: `${req.emailsSentLast14d} emails in 14d >= budget ${cfg.maxEmailsPerRolling14d}` }
        : { outcome: 'pass' };
    },
  },
  // ---- 4. financial limits -------------------------------------------------
  {
    id: 'autonomous_amount_cap',
    category: 'financial_limits',
    description: 'agent-proposed money actions above the autonomous cap require human approval',
    evaluate: (req, cfg) => {
      if (!MONEY_ACTIONS.has(req.action.type) || req.proposedBy !== 'agent') return { outcome: 'skipped' };
      return req.amountDue > cfg.autonomousAmountCapPaise
        ? { outcome: 'require_approval', detail: `amount ${req.amountDue} > autonomous cap ${cfg.autonomousAmountCapPaise}` }
        : { outcome: 'pass' };
    },
  },
  // ---- 5. confidence gate --------------------------------------------------
  {
    id: 'confidence_gate',
    category: 'confidence_gate',
    description: 'low-confidence strategy with high exposure requires human approval',
    evaluate: (req, cfg) => {
      if (req.proposedBy !== 'agent' || req.strategyConfidence === null) return { outcome: 'skipped' };
      return req.strategyConfidence < cfg.confidenceGate.minConfidence &&
        req.amountDue > cfg.confidenceGate.exposureThresholdPaise
        ? {
            outcome: 'require_approval',
            detail: `confidence ${req.strategyConfidence} < ${cfg.confidenceGate.minConfidence} with exposure ${req.amountDue}`,
          }
        : { outcome: 'pass' };
    },
  },
  {
    id: 'promise_requires_approval',
    category: 'confidence_gate',
    description: 'a promise-to-pay extracted from a customer reply needs a human to accept it',
    evaluate: (req) => {
      if (req.action.type !== 'record_promise_to_pay' || req.proposedBy !== 'agent') {
        return { outcome: 'skipped' };
      }
      // Accepting a promise pauses collection until the promised date — the
      // agent read that date out of free text the customer wrote, so a human
      // confirms it before the clock starts. A human proposing one directly
      // has already made that call and is not asked to approve themselves.
      return {
        outcome: 'require_approval',
        detail: `agent read a promise to pay by ${req.action.promisedDate} from the customer's reply`,
      };
    },
  },
  // ---- 6. loop guards ------------------------------------------------------
  {
    id: 'loop_guard_invocations',
    category: 'loop_guards',
    description: 'max agent invocations per case',
    evaluate: (req, cfg) =>
      req.agentInvocationCount >= cfg.loopGuards.maxAgentInvocationsPerCase &&
      !ALWAYS_ALLOWED_ACTIONS.includes(req.action.type)
        ? { outcome: 'deny', detail: 'agent invocation loop guard tripped — escalate' }
        : { outcome: 'pass' },
  },
  {
    id: 'loop_guard_age',
    category: 'loop_guards',
    description: 'max case age without progress',
    evaluate: (req, cfg) =>
      req.caseAgeHours >= cfg.loopGuards.maxCaseAgeHoursWithoutProgress &&
      !ALWAYS_ALLOWED_ACTIONS.includes(req.action.type)
        ? { outcome: 'deny', detail: 'case age loop guard tripped — escalate' }
        : { outcome: 'pass' },
  },
];

export function evaluatePolicyRequest(
  req: PolicyRequest,
  config: PolicyConfig,
  policyVersion: number,
): PolicyDecisionResult {
  const parsedConfig = PolicyConfigSchema.parse(config);
  const trace: RuleTraceEntry[] = [];
  let requireApproval: string | null = null;

  // escalate/stop are always allowed — but still traced for auditability
  for (const rule of RULES) {
    const result = rule.evaluate(req, parsedConfig);
    trace.push({
      ruleId: rule.id,
      category: rule.category,
      description: rule.description,
      outcome: result.outcome,
      detail: result.detail ?? null,
    });
    if (result.outcome === 'deny') {
      return { verdict: 'DENY', reason: `${rule.id}: ${result.detail ?? rule.description}`, ruleTrace: trace, policyVersion };
    }
    if (result.outcome === 'require_approval' && requireApproval === null) {
      requireApproval = `${rule.id}: ${result.detail ?? rule.description}`;
    }
  }
  if (requireApproval) {
    return { verdict: 'REQUIRE_APPROVAL', reason: requireApproval, ruleTrace: trace, policyVersion };
  }
  return { verdict: 'ALLOW', reason: null, ruleTrace: trace, policyVersion };
}

export { DEFAULT_POLICY_CONFIG };
