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
import { TEMPLATE_REGISTRY, needsPaymentLink } from '../templates/registry.js';
import { DEFAULT_POLICY_CONFIG } from './defaults.js';

/**
 * THE deterministic policy engine. Pure function of (request, config).
 * Mandatory middleware between any proposal (agent OR human) and execution.
 * Evaluation order is fixed; the first DENY wins; REQUIRE_APPROVAL is
 * sticky unless a later rule denies.
 */

/** Actions that attempt to collect money, by type alone. */
const MONEY_ACTION_TYPES: ReadonlySet<ActionParams['type']> = new Set([
  'schedule_mandate_reexecution',
  'create_payment_link',
]);

/**
 * Whether an action is an attempt to collect money.
 *
 * send_email is not inherently one — but payment_reminder and
 * payment_failed_notice now carry a live {{payment_link}}, which makes them
 * collection attempts wearing an email's clothes. Keying off the type alone
 * let them slip past the invoice attempt cap and the 24h spacing rule, so a
 * second payable link could be minted for an invoice that already had one.
 */
function isMoneyAction(action: ActionParams): boolean {
  if (MONEY_ACTION_TYPES.has(action.type)) return true;
  return action.type === 'send_email' && needsPaymentLink(TEMPLATE_REGISTRY[action.templateId]);
}
/** Actions that contact the customer by email (link delivery includes an email). */
const CONTACT_ACTIONS: ReadonlySet<ActionParams['type']> = new Set([
  'send_email',
  'create_payment_link',
  'schedule_mandate_reexecution', // sends the mandatory pre-debit notice email
]);

export function localHour(nowIso: string, timeZone: string): number | null {
  const fmt = localFormatter(timeZone);
  return fmt ? localHourMinute(new Date(nowIso), fmt).hour : null;
}

/**
 * Built once and reused: resolving a contact window walks the clock forward a
 * minute at a time, and constructing a formatter per step is the expensive part.
 */
function localFormatter(timeZone: string): Intl.DateTimeFormat | null {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
  } catch {
    // customers.timezone is unvalidated text; only the seed path guarantees an
    // IANA id. Since this moved into buildCaseContext it runs for EVERY agent
    // call, so one bad row ('IST', 'GMT+5:30') threw inside the read
    // transaction and killed every agent for that customer with no decision
    // row and no escalation.
    return null;
  }
}

function localHourMinute(at: Date, fmt: Intl.DateTimeFormat): { hour: number; minute: number } {
  const parts = fmt.formatToParts(at);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { hour: get('hour'), minute: get('minute') };
}

function inQuietHours(hour: number, startHour: number, endHour: number): boolean {
  return startHour > endHour ? hour >= startHour || hour < endHour : hour >= startHour && hour < endHour;
}

export interface ContactWindow {
  allowedNow: boolean;
  /** null when the customer's timezone could not be read */
  localHour: number | null;
  /** when contact becomes permitted again; null when it already is */
  nextAllowedAt: string | null;
}

/**
 * THE definition of "may this customer be contacted right now". Both callers
 * use it: the quiet_hours rule below, and buildCaseContext when it tells an
 * agent what it is allowed to do.
 *
 * They used to work it out separately from the raw parts — an instant, a
 * timezone, and a {startHour, endHour} pair. On one case the agent read those
 * hours as the window in which contact was PERMITTED, decided 02:28 IST fell
 * outside it, and parked a 70-day-overdue invoice for a day; its twin proposed
 * an email in the same minute and this rule passed it. Two readings of one rule
 * is one reading too many, so there is now a single function and a single
 * answer.
 */
export function contactWindow(
  nowIso: string,
  timeZone: string,
  quietHours: { startHour: number; endHour: number },
): ContactWindow {
  const fmt = localFormatter(timeZone);
  // Fail CLOSED. Falling back to UTC would silently permit contact at 23:00 in
  // the customer's actual evening; refusing contact stalls nothing, because
  // the agent still runs and escalate_to_human is always allowed — which is
  // the right destination for a customer row with an unusable timezone.
  if (!fmt) return { allowedNow: false, localHour: null, nextAllowedAt: null };
  const start = new Date(nowIso);
  const { hour, minute } = localHourMinute(start, fmt);
  const isQuiet = (at: Date): boolean =>
    inQuietHours(localHourMinute(at, fmt).hour, quietHours.startHour, quietHours.endHour);

  if (!isQuiet(start)) return { allowedNow: true, localHour: hour, nextAllowedAt: null };

  // Elapsed minutes until the window ends, measured from local wall-clock so a
  // zone offset by a half hour (IST is UTC+5:30) lands on the hour rather than
  // thirty minutes past it.
  const minutesToEnd = ((quietHours.endHour - hour + 24) % 24) * 60 - minute;
  const estimate = start.getTime() + (minutesToEnd > 0 ? minutesToEnd : minutesToEnd + 24 * 60) * 60_000;

  // …and then VERIFIED, because that arithmetic adds wall-clock minutes to a
  // UTC instant, which is wrong by an hour across a DST change. Fall-back
  // lands back inside the window (London on 24 Oct estimates 08:00 GMT, still
  // quiet) and spring-forward overshoots, throwing away an hour of contact
  // time. Both are the agent being told contact reopens at a moment the gate
  // will still deny — the disagreement this function exists to prevent. A
  // one-minute scan either side of the estimate finds the true boundary.
  const CORRECTION_MS = 90 * 60_000;
  const earliest = Math.max(start.getTime() + 60_000, estimate - CORRECTION_MS);
  for (let t = earliest; t <= estimate + CORRECTION_MS; t += 60_000) {
    const candidate = new Date(t);
    if (!isQuiet(candidate)) {
      return { allowedNow: false, localHour: hour, nextAllowedAt: candidate.toISOString() };
    }
  }
  return { allowedNow: false, localHour: hour, nextAllowedAt: new Date(estimate).toISOString() };
}

/**
 * Push a scheduled CONTACT to the first moment it is actually permitted.
 *
 * Delay windows are multiples of 24h, so they preserve the customer's local
 * hour: a case denied at 02:28 for quiet hours and rescheduled a day out woke
 * at 02:28 and was denied again, and again. Evaluating the window AT the
 * resolved moment is the only way to see that, and it reuses contactWindow so
 * the deferral and the gate cannot disagree.
 *
 * mark_wait is untouched — waiting contacts nobody.
 */
export function deferContactPastQuietHours(
  action: ActionParams,
  timeZone: string,
  quietHours: { startHour: number; endHour: number },
): ActionParams {
  const defer = (iso: string): string => {
    const window = contactWindow(iso, timeZone, quietHours);
    return window.allowedNow ? iso : (window.nextAllowedAt ?? iso);
  };
  switch (action.type) {
    case 'schedule_reminder':
      return { ...action, remindAt: defer(action.remindAt) };
    case 'schedule_mandate_reexecution':
      // sends the mandatory pre-debit notice, so it is a contact too
      return { ...action, scheduleAt: defer(action.scheduleAt) };
    default:
      return action;
  }
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
      const window = contactWindow(req.nowIso, req.customerTimezone, cfg.quietHours);
      if (window.allowedNow) return { outcome: 'pass' };
      return {
        outcome: 'deny',
        detail:
          window.localHour === null
            ? `customer timezone '${req.customerTimezone}' is not a valid IANA zone — quiet hours cannot be proven`
            : `local hour ${window.localHour} is inside quiet hours`,
      };
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
      if (!isMoneyAction(req.action)) return { outcome: 'skipped' };
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
      if (!isMoneyAction(req.action) || !req.lastAttemptAt) return { outcome: 'skipped' };
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
      if (!isMoneyAction(req.action) || req.proposedBy !== 'agent') return { outcome: 'skipped' };
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
    evaluate: (req, cfg) => {
      if (req.action.type !== 'record_promise_to_pay' || req.proposedBy !== 'agent') {
        return { outcome: 'skipped' };
      }
      // Accepting a promise pauses collection until the promised date — the
      // agent read that date out of free text the customer wrote. Above the
      // threshold a human confirms it before the clock starts; below it, the
      // pause is cheaper than the friction of asking. A human proposing one
      // directly has already made that call and is not asked to approve
      // themselves.
      if (req.amountDue <= cfg.promiseApprovalThresholdPaise) {
        return { outcome: 'pass', detail: `exposure ${req.amountDue} at or below the ask-a-human threshold` };
      }
      return {
        outcome: 'require_approval',
        detail: `agent read a promise to pay by ${req.action.promisedDate} from the customer's reply, exposure ${req.amountDue}`,
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
      req.hoursWithoutProgress >= cfg.loopGuards.maxCaseAgeHoursWithoutProgress &&
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
