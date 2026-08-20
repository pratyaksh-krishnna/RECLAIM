import { z } from 'zod';

/** Case lifecycle states owned exclusively by the deterministic orchestrator. */
export const CaseState = z.enum([
  'detected',
  'diagnosed',
  'planned',
  'pending_policy',
  'pending_approval',
  'executing',
  'waiting',
  're_evaluating',
  'recovered',
  'stopped',
  'escalated',
  'lost',
  'disputed',
]);
export type CaseState = z.infer<typeof CaseState>;

/** Terminal states: no agent may run and no action may execute once reached. */
export const TERMINAL_STATES: readonly CaseState[] = ['recovered', 'stopped', 'lost'] as const;

export const LeakType = z.enum([
  'subscription_payment_failure',
  'invoice_overdue',
  'unknown',
]);
export type LeakType = z.infer<typeof LeakType>;

/** CLOSED enum — the Diagnosis agent may not invent causes outside this list. */
export const CauseHypothesis = z.enum([
  'expired_card',
  'insufficient_funds',
  'hard_decline',
  'auth_required',
  'processor_error',
  'procurement_delay',
  'invoice_dispute_suspected',
  'cash_flow_stress',
  'habitual_late_payer',
  'unknown',
]);
export type CauseHypothesis = z.infer<typeof CauseHypothesis>;

/** Decline classification from the deterministic decline table (never from an LLM). */
export const DeclineClass = z.enum(['soft', 'hard', 'auth_required', 'processor_error', 'ambiguous']);
export type DeclineClass = z.infer<typeof DeclineClass>;

/** Payment rails relevant in India. */
export const PaymentRail = z.enum(['card', 'upi_autopay', 'emandate', 'netbanking']);
export type PaymentRail = z.infer<typeof PaymentRail>;

export const HoldoutArm = z.enum(['treatment', 'holdout']);
export type HoldoutArm = z.infer<typeof HoldoutArm>;

export const AttributionClass = z.enum(['direct', 'assisted', 'external']);
export type AttributionClass = z.infer<typeof AttributionClass>;

/** Reply Interpreter intents — closed set; anything else is 'unclear'. */
export const ReplyIntent = z.enum([
  'paid_claim',
  'will_pay',
  'promise_with_date',
  'dispute',
  'opt_out',
  'question',
  'hostile',
  'unclear',
]);
export type ReplyIntent = z.infer<typeof ReplyIntent>;

export const StopReason = z.enum([
  'opt_out',
  'dispute',
  'paid_external',
  'attempts_exhausted',
  'human_request',
  'loop_guard',
]);
export type StopReason = z.infer<typeof StopReason>;

export const Language = z.enum(['en', 'hi', 'hinglish']);
export type Language = z.infer<typeof Language>;

export const ToneRegister = z.enum(['formal', 'friendly', 'firm']);
export type ToneRegister = z.infer<typeof ToneRegister>;

export const Channel = z.enum(['email']);
export type Channel = z.infer<typeof Channel>;

export const UserRole = z.enum(['admin', 'operator', 'viewer']);
export type UserRole = z.infer<typeof UserRole>;

export const PolicyVerdict = z.enum(['ALLOW', 'DENY', 'REQUIRE_APPROVAL']);
export type PolicyVerdict = z.infer<typeof PolicyVerdict>;

export const AgentName = z.enum([
  'triage',
  'diagnosis',
  'strategy',
  'communication',
  'reply_interpreter',
  'summarizer',
]);
export type AgentName = z.infer<typeof AgentName>;

/** All money everywhere in the system: integer paise (INR * 100). Never floats. */
export const Paise = z.number().int().nonnegative();
export type Paise = z.infer<typeof Paise>;

export const Confidence = z.number().min(0).max(1);
export type Confidence = z.infer<typeof Confidence>;
