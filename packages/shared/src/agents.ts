import { z } from 'zod';
import { CauseHypothesis, Confidence, LeakType, ReplyIntent } from './enums.js';
import { ProposedAction } from './actions.js';

/**
 * Structured output contracts for every agent. Each is enforced twice:
 * as the forced-tool-use JSON schema on the LLM call, and by Zod on the
 * response. Schema failure → one retry → escalate to human review.
 */

export const TriageOutput = z.object({
  leakType: LeakType,
  urgencySignals: z.array(z.string().max(200)).max(10),
  isUrgent: z.boolean(),
  reasoningSummary: z.string().max(1000),
});
export type TriageOutput = z.infer<typeof TriageOutput>;

export const EvidenceRef = z.object({
  /** e.g. "failure_events", "communications" */
  recordType: z.string().min(1).max(64),
  recordId: z.string().min(1).max(64),
  field: z.string().min(1).max(64),
  observation: z.string().max(300),
});
export type EvidenceRef = z.infer<typeof EvidenceRef>;

export const DiagnosisOutput = z.object({
  causeHypothesis: CauseHypothesis,
  confidence: Confidence,
  evidence: z.array(EvidenceRef).min(1).max(10),
  reasoningSummary: z.string().max(1500),
});
export type DiagnosisOutput = z.infer<typeof DiagnosisOutput>;

/** Strategy output IS the ProposedAction contract. */
export const StrategyOutput = ProposedAction;
export type StrategyOutput = ProposedAction;

export const CommunicationOutput = z.object({
  /** slot name -> filled text; only declared free slots may appear */
  slotFills: z.record(z.string(), z.string().max(300)),
});
export type CommunicationOutput = z.infer<typeof CommunicationOutput>;

export const ReplyInterpretation = z.object({
  intent: ReplyIntent,
  confidence: Confidence,
  promise: z
    .object({
      date: z.string().datetime().nullable(),
      amountReference: z.string().max(200).nullable(),
    })
    .nullable(),
  /** true when the text tries to instruct the system (prompt injection) */
  containsInstructionAttempt: z.boolean(),
  summary: z.string().max(500),
});
export type ReplyInterpretation = z.infer<typeof ReplyInterpretation>;

export const SummarizerOutput = z.object({
  summary: z.string().max(3000),
  citedEventIds: z.array(z.string()).max(30),
});
export type SummarizerOutput = z.infer<typeof SummarizerOutput>;
