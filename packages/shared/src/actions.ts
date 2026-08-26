import { z } from 'zod';
import { Confidence, Language, StopReason, ToneRegister } from './enums.js';

/**
 * THE action catalog. Agents may propose actions ONLY from this discriminated
 * union. Note what is absent by design: no refund, no discount, no waiver,
 * no payment plan — those actions do not exist anywhere in the system.
 *
 * No action carries a monetary amount. Amounts are always resolved
 * server-side from the invoice at execution time.
 */
export const ActionType = z.enum([
  'schedule_mandate_reexecution',
  'create_payment_link',
  'send_email',
  'schedule_reminder',
  'record_promise_to_pay',
  'escalate_to_human',
  'stop_workflow',
  'mark_wait',
]);
export type ActionType = z.infer<typeof ActionType>;

/**
 * The approved template registry, as a CLOSED enum. templateId used to be a
 * free string, so a model could invent a plausible-sounding template
 * ("expired_card_recovery") that passed schema validation and the policy gate,
 * then failed at the tool — stranding the case. Now an unknown template fails
 * the Zod gate, is retried once, then escalated, like any other bad output.
 */
export const TemplateId = z.enum([
  'payment_failed_notice',
  'payment_link_delivery',
  'pre_debit_notice',
  'payment_reminder',
]);
export type TemplateId = z.infer<typeof TemplateId>;

export const ScheduleMandateReexecution = z.object({
  type: z.literal('schedule_mandate_reexecution'),
  /** ISO datetime; policy enforces the >=24h pre-debit notification precedes it */
  scheduleAt: z.string().datetime(),
});

export const CreatePaymentLink = z.object({
  type: z.literal('create_payment_link'),
  /** server sets the exact amount due; agent contributes nothing monetary */
});

export const SendEmail = z.object({
  type: z.literal('send_email'),
  templateId: TemplateId,
  language: Language,
  toneRegister: ToneRegister,
  /** bounded free-text slot fills keyed by slot name; linted deterministically */
  slotFills: z.record(z.string(), z.string().max(300)),
});

export const ScheduleReminder = z.object({
  type: z.literal('schedule_reminder'),
  remindAt: z.string().datetime(),
  note: z.string().max(500),
});

export const RecordPromiseToPay = z.object({
  type: z.literal('record_promise_to_pay'),
  promisedDate: z.string().datetime(),
  /** reference only ("the full amount", "half now") — never a number the server acts on */
  amountReference: z.string().max(200).nullable(),
});

export const EscalateToHuman = z.object({
  type: z.literal('escalate_to_human'),
  reason: z.string().max(1000),
});

export const StopWorkflow = z.object({
  type: z.literal('stop_workflow'),
  reason: StopReason,
});

export const MarkWait = z.object({
  type: z.literal('mark_wait'),
  waitUntil: z.string().datetime(),
  waitingFor: z.string().max(500),
});

export const ActionParams = z.discriminatedUnion('type', [
  ScheduleMandateReexecution,
  CreatePaymentLink,
  SendEmail,
  ScheduleReminder,
  RecordPromiseToPay,
  EscalateToHuman,
  StopWorkflow,
  MarkWait,
]);
export type ActionParams = z.infer<typeof ActionParams>;

/**
 * ── The agent-facing catalog ──────────────────────────────────────────────
 *
 * The same actions, with one difference: an agent never names a moment in time.
 *
 * Three actions above carry an absolute ISO datetime, and the agent used to
 * author it. That is a value of the same character as an amount. `scheduleAt`
 * is one of the two operands in the `upi_pre_debit_notice` rule — the model's
 * number is subtracted from the server's clock to decide whether the India
 * mandatory-notice requirement is met — so a date an agent invented was
 * steering a compliance verdict. `create_payment_link` carries no amount for
 * exactly this reason; these carry no date for the same one.
 *
 * The agent picks the SHAPE of a delay from a closed set, and deterministic
 * code turns it into a moment against the real clock and the policy the engine
 * will judge it by. Structural, not behavioural: there is nowhere in this
 * schema for a fabricated timestamp to go.
 *
 * `record_promise_to_pay.promisedDate` deliberately stays a real date. That one
 * is not the agent choosing a date — it is the agent reading one out of the
 * customer's own reply ("I'll pay on the 5th"). Collapsing extracted evidence
 * into a window would destroy the information. It needs a clock instead, which
 * CaseContext.nowIso now supplies.
 */
export const DelayWindow = z.enum(['same_day', 'short', 'medium', 'long']);
export type DelayWindow = z.infer<typeof DelayWindow>;

/** The one place a window becomes a duration. */
export const DELAY_WINDOW_HOURS: Record<DelayWindow, number> = {
  same_day: 6,
  short: 24,
  medium: 72,
  long: 168,
};

export const ProposedScheduleMandateReexecution = z.object({
  type: z.literal('schedule_mandate_reexecution'),
  scheduleIn: DelayWindow,
});

export const ProposedScheduleReminder = z.object({
  type: z.literal('schedule_reminder'),
  remindIn: DelayWindow,
  note: z.string().max(500),
});

export const ProposedMarkWait = z.object({
  type: z.literal('mark_wait'),
  waitFor: DelayWindow,
  waitingFor: z.string().max(500),
});

/**
 * The templates an agent may ask send_email to deliver — every TemplateId
 * except pre_debit_notice.
 *
 * pre_debit_notice announces a {{debit_date}} that exists only once a mandate
 * debit has been scheduled, so schedule_mandate_reexecution sends it itself as
 * step 1. It stays in TemplateId because that tool still renders it; it is
 * absent here because send_email cannot.
 *
 * It was reachable, and an agent duly proposed it: schema-valid, policy-
 * approved, then refused at execution — one spent model call, one policy
 * decision, and a case in the human inbox. Removing the option is the same
 * move as removing the datetime fields above. What a schema cannot express
 * cannot be retried, escalated, or argued with.
 */
export const AgentTemplateId = TemplateId.exclude(['pre_debit_notice']);
export type AgentTemplateId = z.infer<typeof AgentTemplateId>;

export const ProposedSendEmail = SendEmail.extend({ templateId: AgentTemplateId });

/** What an agent may propose. Resolved to ActionParams before anything else sees it. */
export const ProposedActionParams = z.discriminatedUnion('type', [
  ProposedScheduleMandateReexecution,
  CreatePaymentLink,
  ProposedSendEmail,
  ProposedScheduleReminder,
  RecordPromiseToPay,
  EscalateToHuman,
  StopWorkflow,
  ProposedMarkWait,
]);
export type ProposedActionParams = z.infer<typeof ProposedActionParams>;

/** What the Strategy agent emits. A proposal, never an execution. */
export const ProposedAction = z.object({
  action: ProposedActionParams,
  rationale: z.string().max(2000),
  confidence: Confidence,
  /** conditions under which this plan should be abandoned; strategy must acknowledge them */
  stopConditions: z.array(z.string().max(300)).min(1).max(5),
});
export type ProposedAction = z.infer<typeof ProposedAction>;

/** Policy values the resolver needs. Read from the active policy, never hardcoded. */
export interface ProposalResolutionRules {
  preDebitNoticeHours: number;
}

/**
 * Margin above the policy minimum. The debit is scheduled now but fires later,
 * and a job that lands a few minutes late must not drag the notice period back
 * under the line it was supposed to clear.
 */
const PRE_DEBIT_SAFETY_MARGIN_HOURS = 2;

/**
 * Turn an agent proposal into an executable action. Pure: same inputs, same
 * output, always. Called once, where the proposal is persisted — NOT in the
 * tool, because the policy engine evaluates the proposal before execution and
 * needs a concrete datetime to evaluate.
 */
/**
 * Note what this does NOT do: it knows nothing about quiet hours. Every window
 * but same_day is a multiple of 24h and so preserves the customer's local
 * hour, which means a resolved moment can land inside a FUTURE quiet period —
 * something a reopen time computed for *now* cannot describe. Deferring past
 * that is deferContactPastQuietHours in policy/engine.ts, which owns the one
 * definition of the window.
 */
export function resolveProposedAction(
  action: ProposedActionParams,
  now: Date,
  rules: ProposalResolutionRules,
): ActionParams {
  const at = (hours: number): string => new Date(now.getTime() + hours * 3_600_000).toISOString();
  switch (action.type) {
    case 'mark_wait':
      return { type: 'mark_wait', waitUntil: at(DELAY_WINDOW_HOURS[action.waitFor]), waitingFor: action.waitingFor };
    case 'schedule_reminder':
      return { type: 'schedule_reminder', remindAt: at(DELAY_WINDOW_HOURS[action.remindIn]), note: action.note };
    case 'schedule_mandate_reexecution':
      // never sooner than the mandatory notice period, whatever window was
      // asked for — the rail requirement outranks the agent's preference
      return {
        type: 'schedule_mandate_reexecution',
        scheduleAt: at(
          Math.max(DELAY_WINDOW_HOURS[action.scheduleIn], rules.preDebitNoticeHours + PRE_DEBIT_SAFETY_MARGIN_HOURS),
        ),
      };
    default:
      return action;
  }
}

/**
 * What a human operator may propose through POST /intervene.
 *
 * The execution catalog minus the one template send_email cannot render.
 * ActionParams still accepts it — schedule_mandate_reexecution sends it — but
 * an operator submitting send_email + pre_debit_notice would sail through the
 * policy gate and die at the tool, which is the same stranded case that
 * removing it from the agent catalog was meant to prevent. Operators keep
 * absolute dates: a human knows what time it is.
 */
export const InterveneActionParams = z.discriminatedUnion('type', [
  ScheduleMandateReexecution,
  CreatePaymentLink,
  SendEmail.extend({ templateId: AgentTemplateId }),
  ScheduleReminder,
  RecordPromiseToPay,
  EscalateToHuman,
  StopWorkflow,
  MarkWait,
]);
export type InterveneActionParams = z.infer<typeof InterveneActionParams>;

/** Actions permitted regardless of case state or policy outcome. */
export const ALWAYS_ALLOWED_ACTIONS: readonly ActionType[] = [
  'escalate_to_human',
  'stop_workflow',
] as const;
