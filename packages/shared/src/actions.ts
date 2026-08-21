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

/** What the Strategy agent emits. A proposal, never an execution. */
export const ProposedAction = z.object({
  action: ActionParams,
  rationale: z.string().max(2000),
  confidence: Confidence,
  /** conditions under which this plan should be abandoned; strategy must acknowledge them */
  stopConditions: z.array(z.string().max(300)).min(1).max(5),
});
export type ProposedAction = z.infer<typeof ProposedAction>;

/** Actions permitted regardless of case state or policy outcome. */
export const ALWAYS_ALLOWED_ACTIONS: readonly ActionType[] = [
  'escalate_to_human',
  'stop_workflow',
] as const;
