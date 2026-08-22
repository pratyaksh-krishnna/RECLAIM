import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { z } from 'zod';
import {
  CanonicalEvent,
  CommunicationOutput,
  DiagnosisOutput,
  ProposedAction,
  ReplyInterpretation,
  SummarizerOutput,
  TriageOutput,
  type TemplateId,
} from '@reclaim/shared';
import { TEMPLATE_REGISTRY, validateFreeFills } from '../templates/registry.js';
import type { Db, Tx } from '../db/client.js';
import {
  agentDecisions,
  communications,
  customers,
  interventions,
  outbox,
  recoveryCases,
} from '../db/schema.js';
import { writeAudit } from '../audit/audit.js';
import type { LlmClient } from '../llm/index.js';
import { lockCase, transitionCase, type CaseRow } from '../orchestrator/caseService.js';
import { isTerminal } from '../orchestrator/fsm.js';
import { buildCaseContext, type CaseContext } from './context.js';
import { PROMPTS, promptVersionHash, type PromptAgent } from './prompts.js';

export interface AgentDeps {
  llm: LlmClient;
  enqueueCaseStep(caseId: string, trigger: string): Promise<void>;
  enqueueAgent(job: { caseId: string; agent: PromptAgent; communicationId?: string }): Promise<void>;
  now?: () => Date;
}

interface AgentSpec<T> {
  schemaName: string;
  zod: z.ZodType<T>;
  /**
   * Extra deterministic validation beyond the schema. Receives the agent's
   * input too, because some rules depend on it — free-slot limits belong to
   * the specific template the agent was asked to fill.
   */
  extraValidate?: (output: T, input: unknown) => string | null;
}

const SPECS = {
  triage: { schemaName: 'triage_output', zod: TriageOutput } as AgentSpec<TriageOutput>,
  diagnosis: { schemaName: 'diagnosis_output', zod: DiagnosisOutput } as AgentSpec<DiagnosisOutput>,
  strategy: { schemaName: 'strategy_output', zod: ProposedAction } as AgentSpec<ProposedAction>,
  communication: {
    schemaName: 'communication_output',
    zod: CommunicationOutput,
    extraValidate: (o: CommunicationOutput, input: unknown) => {
      // Validate against the SAME rules renderTemplate enforces, so a bad fill
      // is retried here rather than failing inside the tool after the policy
      // gate has already approved the action.
      const templateId = (input as { templateId?: TemplateId } | null)?.templateId;
      const skeleton = templateId ? TEMPLATE_REGISTRY[templateId] : undefined;
      if (!skeleton) return `unknown templateId '${String(templateId)}'`;
      const problems = validateFreeFills(skeleton, o.slotFills);
      return problems.length > 0 ? problems.join('; ') : null;
    },
  } as AgentSpec<CommunicationOutput>,
  reply_interpreter: {
    schemaName: 'reply_interpretation',
    zod: ReplyInterpretation,
  } as AgentSpec<ReplyInterpretation>,
  summarizer: { schemaName: 'summarizer_output', zod: SummarizerOutput } as AgentSpec<SummarizerOutput>,
} as const;

export async function runAgentJob(
  db: Db,
  deps: AgentDeps,
  job: { caseId: string; agent: PromptAgent; communicationId?: string },
): Promise<void> {
  const now = deps.now ?? (() => new Date());

  // read phase: case + context + agent-specific input
  const prep = await db.transaction(async (tx) => {
    const [caseRow] = await tx.select().from(recoveryCases).where(eq(recoveryCases.id, job.caseId)).limit(1);
    if (!caseRow) return null;
    if (isTerminal(caseRow.state) || caseRow.holdoutArm === 'holdout') return null; // agents NEVER run on holdout
    const context = await buildCaseContext(tx, caseRow, now);
    const input = await buildAgentInput(tx, job, caseRow, context);
    return { caseRow, context, input };
  });
  if (!prep) return;

  const spec = SPECS[job.agent];
  const jsonSchema = zodToJsonSchema(spec.zod, { target: 'jsonSchema7' }) as Record<string, unknown>;
  const system = PROMPTS[job.agent].system;

  // call with one retry on schema/lint failure
  let parsed: unknown = null;
  let lastRaw: unknown = null;
  let failReason = '';
  let usage = { modelId: 'unknown', inputTokens: 0, outputTokens: 0, latencyMs: 0 };
  for (let attempt = 1; attempt <= 2 && parsed === null; attempt++) {
    const result = await deps.llm.completeStructured(
      { schemaName: spec.schemaName, system, input: prep.input },
      jsonSchema,
    );
    usage = {
      modelId: result.modelId,
      inputTokens: Math.round(result.inputTokens),
      outputTokens: Math.round(result.outputTokens),
      latencyMs: result.latencyMs,
    };
    lastRaw = result.raw;
    const candidate = spec.zod.safeParse(result.raw);
    if (!candidate.success) {
      failReason = `schema: ${candidate.error.issues[0]?.message ?? 'invalid'}`;
      continue;
    }
    const extraError = spec.extraValidate ? spec.extraValidate(candidate.data as never, prep.input) : null;
    if (extraError) {
      failReason = extraError;
      continue;
    }
    parsed = candidate.data;
  }

  const confidence = extractConfidence(job.agent, parsed);
  const pending: Array<() => Promise<void>> = [];

  await db.transaction(async (tx) => {
    const caseRow = await lockCase(tx, job.caseId);
    if (!caseRow || isTerminal(caseRow.state)) return;

    await tx.insert(agentDecisions).values({
      caseId: job.caseId,
      agent: job.agent,
      model: usage.modelId,
      promptVersionHash: promptVersionHash(job.agent),
      inputSnapshot: prep.input as object,
      output: (parsed ?? lastRaw) as object,
      schemaValid: parsed !== null,
      confidence: confidence !== null ? String(confidence) : null,
      latencyMs: usage.latencyMs,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });
    await tx
      .update(recoveryCases)
      .set({ agentInvocationCount: caseRow.agentInvocationCount + 1 })
      .where(eq(recoveryCases.id, job.caseId));
    caseRow.agentInvocationCount += 1;

    if (parsed === null) {
      // schema failure after retry → human review, per spec
      await writeAudit(tx, {
        caseId: job.caseId,
        actorType: 'agent',
        actorId: job.agent,
        eventType: 'agent.schema_failure',
        payload: { reason: failReason },
      });
      if (caseRow.state !== 'escalated') {
        await transitionCase(tx, caseRow, 'escalated', {
          actorType: 'agent',
          actorId: job.agent,
          reason: `agent output failed validation twice: ${failReason}`,
        });
      }
      return;
    }
    await postProcess(tx, deps, job, caseRow, parsed, now, (fn) => pending.push(fn));
  });

  // enqueues deferred until after the commit so a rollback never leaves ghost jobs
  for (const fn of pending.splice(0)) await fn();
}

async function buildAgentInput(
  tx: Tx,
  job: { caseId: string; agent: PromptAgent; communicationId?: string },
  caseRow: CaseRow,
  context: CaseContext,
): Promise<unknown> {
  switch (job.agent) {
    case 'reply_interpreter': {
      if (!job.communicationId) throw new Error('reply_interpreter requires communicationId');
      const [comm] = await tx
        .select()
        .from(communications)
        .where(eq(communications.id, job.communicationId))
        .limit(1);
      if (!comm) throw new Error('inbound communication not found');
      // customer text enters ONLY as a delimited data field
      return { ...context, customer_message: comm.renderedBody.slice(0, 4000) };
    }
    case 'communication': {
      const [proposal] = await tx
        .select()
        .from(interventions)
        .where(
          and(eq(interventions.caseId, job.caseId), eq(interventions.status, 'proposed'), eq(interventions.actionType, 'send_email')),
        )
        .orderBy(desc(interventions.createdAt))
        .limit(1);
      const params = (proposal?.params ?? {}) as { templateId?: TemplateId; language?: string; toneRegister?: string };
      const templateId = params.templateId ?? 'payment_reminder';
      const skeleton = TEMPLATE_REGISTRY[templateId];
      return {
        ...context,
        templateId,
        language: params.language ?? context.language,
        toneRegister: params.toneRegister ?? 'formal',
        // the agent was previously given bare slot NAMES, so it never knew the
        // length budget it was being judged against and routinely blew it
        freeSlots: skeleton.slots
          .filter((s) => s.kind === 'free')
          .map((s) => ({ name: s.name, maxLength: s.maxLength ?? null, description: s.description })),
      };
    }
    case 'strategy': {
      const [lastReply] = await tx
        .select()
        .from(agentDecisions)
        .where(and(eq(agentDecisions.caseId, job.caseId), eq(agentDecisions.agent, 'reply_interpreter'), eq(agentDecisions.schemaValid, true)))
        .orderBy(desc(agentDecisions.createdAt))
        .limit(1);
      const intent = (lastReply?.output as { intent?: string } | null)?.intent ?? null;
      return { ...context, lastReplyIntent: intent };
    }
    default:
      return context;
  }
}

function extractConfidence(agent: PromptAgent, parsed: unknown): number | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const c = (parsed as { confidence?: unknown }).confidence;
  return typeof c === 'number' ? c : agent === 'communication' || agent === 'summarizer' ? null : null;
}

/**
 * Global suppression. Reached from a clean opt-out reply AND from one that was
 * also flagged as an instruction attempt — the obligation to stop contacting a
 * customer does not depend on how politely they asked.
 */
async function applyOptOut(tx: Tx, caseRow: CaseRow, now: () => Date): Promise<void> {
  await tx.update(customers).set({ optedOut: true, optedOutAt: now() }).where(eq(customers.id, caseRow.customerId));
  if (!isTerminal(caseRow.state)) {
    await transitionCase(tx, caseRow, 'stopped', {
      reason: 'customer opted out',
      extra: { stopReason: 'opt_out' },
    });
  }
  const event = CanonicalEvent.parse({
    eventId: randomUUID(),
    occurredAt: now().toISOString(),
    sourceEventId: `optout:${caseRow.id}`,
    type: 'recovery.stopped',
    customerId: caseRow.customerId,
    caseId: caseRow.id,
    reason: 'opt_out',
  });
  await tx.insert(outbox).values({ eventType: event.type, payload: event });
}

/** Dispute freeze — likewise honoured regardless of the injection flag. */
async function applyDisputeFreeze(
  tx: Tx,
  deps: AgentDeps,
  caseRow: CaseRow,
  afterCommit: (fn: () => Promise<void>) => void,
): Promise<void> {
  if (caseRow.state !== 'disputed') {
    await transitionCase(tx, caseRow, 'disputed', { reason: 'customer disputes the charge' });
  }
  afterCommit(() => deps.enqueueAgent({ caseId: caseRow.id, agent: 'summarizer' }));
}

/** Walk legal FSM edges to reach 'planned' from wherever the case is. */
async function toPlanned(tx: Tx, caseRow: CaseRow, reason: string): Promise<boolean> {
  if (caseRow.state === 'waiting' || caseRow.state === 'escalated') {
    await transitionCase(tx, caseRow, 're_evaluating', { reason });
  }
  if (caseRow.state === 'diagnosed' || caseRow.state === 're_evaluating') {
    await transitionCase(tx, caseRow, 'planned', { reason });
    return true;
  }
  return false;
}

async function postProcess(
  tx: Tx,
  deps: AgentDeps,
  job: { caseId: string; agent: PromptAgent; communicationId?: string },
  caseRow: CaseRow,
  parsed: unknown,
  now: () => Date,
  afterCommit: (fn: () => Promise<void>) => void,
): Promise<void> {
  switch (job.agent) {
    case 'triage': {
      const out = parsed as TriageOutput;
      await tx
        .update(recoveryCases)
        .set({ leakType: out.leakType, urgencySignals: out.urgencySignals })
        .where(eq(recoveryCases.id, caseRow.id));
      afterCommit(() => deps.enqueueCaseStep(caseRow.id, 'triage_done'));
      return;
    }
    case 'diagnosis': {
      const out = parsed as DiagnosisOutput;
      await tx
        .update(recoveryCases)
        .set({ causeHypothesis: out.causeHypothesis, causeConfidence: String(out.confidence) })
        .where(eq(recoveryCases.id, caseRow.id));
      caseRow.causeHypothesis = out.causeHypothesis;
      if (caseRow.state === 'detected' || caseRow.state === 're_evaluating') {
        await transitionCase(tx, caseRow, 'diagnosed', {
          actorType: 'agent',
          actorId: 'diagnosis',
          reason: `cause: ${out.causeHypothesis} (${out.confidence})`,
        });
      }
      afterCommit(() => deps.enqueueCaseStep(caseRow.id, 'diagnosis_done'));
      return;
    }
    case 'strategy': {
      const out = parsed as ProposedAction;
      const [created] = await tx
        .insert(interventions)
        .values({
          caseId: caseRow.id,
          actionType: out.action.type,
          params: out.action,
          rationale: out.rationale,
          confidence: String(out.confidence),
          stopConditions: out.stopConditions,
          proposedBy: 'agent',
          status: 'proposed',
        })
        .returning({ id: interventions.id });
      await writeAudit(tx, {
        caseId: caseRow.id,
        actorType: 'agent',
        actorId: 'strategy',
        eventType: 'action.proposed',
        payload: { interventionId: created?.id, action: out.action, confidence: out.confidence },
      });
      if (out.action.type === 'send_email') {
        // free slots must be filled by the communication agent before the policy gate
        afterCommit(() => deps.enqueueAgent({ caseId: caseRow.id, agent: 'communication' }));
        return;
      }
      const ok = await toPlanned(tx, caseRow, 'strategy proposal ready');
      if (ok) afterCommit(() => deps.enqueueCaseStep(caseRow.id, 'proposal_ready'));
      return;
    }
    case 'communication': {
      const out = parsed as CommunicationOutput;
      const [proposal] = await tx
        .select()
        .from(interventions)
        .where(
          and(eq(interventions.caseId, caseRow.id), eq(interventions.status, 'proposed'), eq(interventions.actionType, 'send_email')),
        )
        .orderBy(desc(interventions.createdAt))
        .limit(1);
      if (!proposal) return;
      const params = proposal.params as Record<string, unknown>;
      await tx
        .update(interventions)
        .set({ params: { ...params, slotFills: out.slotFills } })
        .where(eq(interventions.id, proposal.id));
      const ok = await toPlanned(tx, caseRow, 'email slots filled');
      if (ok) afterCommit(() => deps.enqueueCaseStep(caseRow.id, 'proposal_ready'));
      return;
    }
    case 'reply_interpreter': {
      const out = parsed as ReplyInterpretation;
      await writeAudit(tx, {
        caseId: caseRow.id,
        actorType: 'agent',
        actorId: 'reply_interpreter',
        eventType: 'reply.interpreted',
        payload: { intent: out.intent, confidence: out.confidence, injection: out.containsInstructionAttempt },
      });

      if (out.containsInstructionAttempt) {
        // SAFETY: instruction injection → classification only + human review
        await writeAudit(tx, {
          caseId: caseRow.id,
          actorType: 'system',
          eventType: 'safety.injection_flagged',
          payload: { communicationId: job.communicationId, intent: out.intent },
        });
        // A flagged reply is refused anything that would let the sender GAIN
        // something: no paid_claim, no promise, no re-planning. Suppression is
        // not a gain — honouring an opt-out or a dispute freeze only ever makes
        // us contact the customer LESS, which is the safe direction even if the
        // message really was hostile. Dropping a high-confidence opt-out because
        // the same sentence also parsed as an instruction ("unsubscribe me") is
        // a compliance failure, not a safety win.
        if (out.intent === 'opt_out') return applyOptOut(tx, caseRow, now);
        if (out.intent === 'dispute') return applyDisputeFreeze(tx, deps, caseRow, afterCommit);
        if (caseRow.state !== 'escalated') {
          await transitionCase(tx, caseRow, 'escalated', { reason: 'prompt-injection attempt in customer reply' });
        }
        afterCommit(() => deps.enqueueAgent({ caseId: caseRow.id, agent: 'summarizer' }));
        return;
      }

      switch (out.intent) {
        case 'opt_out':
          return applyOptOut(tx, caseRow, now);
        case 'dispute':
          return applyDisputeFreeze(tx, deps, caseRow, afterCommit);
        case 'promise_with_date': {
          const promisedDate = out.promise?.date ?? new Date(now().getTime() + 7 * 86_400_000).toISOString();
          const [created] = await tx
            .insert(interventions)
            .values({
              caseId: caseRow.id,
              actionType: 'record_promise_to_pay',
              params: {
                type: 'record_promise_to_pay',
                promisedDate,
                amountReference: out.promise?.amountReference ?? null,
              },
              rationale: 'customer promised payment in reply',
              confidence: String(out.confidence),
              stopConditions: ['invoice paid', 'promise broken'],
              proposedBy: 'agent',
              status: 'proposed',
            })
            .returning({ id: interventions.id });
          void created;
          const ok = await toPlanned(tx, caseRow, 'promise-to-pay proposal from reply');
          if (ok) afterCommit(() => deps.enqueueCaseStep(caseRow.id, 'proposal_ready'));
          return;
        }
        case 'hostile':
        case 'question': {
          if (caseRow.state !== 'escalated') {
            await transitionCase(tx, caseRow, 'escalated', { reason: `customer reply needs a human (${out.intent})` });
          }
          afterCommit(() => deps.enqueueAgent({ caseId: caseRow.id, agent: 'summarizer' }));
          return;
        }
        case 'paid_claim':
        case 'will_pay':
        case 'unclear': {
          if (caseRow.state === 'waiting' || caseRow.state === 'executing') {
            await transitionCase(tx, caseRow, 're_evaluating', { reason: `customer reply: ${out.intent}` });
          }
          afterCommit(() => deps.enqueueCaseStep(caseRow.id, 're_evaluate'));
          return;
        }
      }
      return;
    }
    case 'summarizer': {
      const out = parsed as SummarizerOutput;
      await writeAudit(tx, {
        caseId: caseRow.id,
        actorType: 'agent',
        actorId: 'summarizer',
        eventType: 'case.summary',
        payload: { summary: out.summary, citedEventIds: out.citedEventIds },
      });
      return;
    }
  }
}
