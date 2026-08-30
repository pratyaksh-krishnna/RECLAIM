import { CanonicalEvent } from '@reclaim/shared';
import type { Db } from '../db/client.js';
import type { AgentDeps } from '../agents/runner.js';
import { runAgentJob } from '../agents/runner.js';
import type { LlmClient } from '../llm/index.js';
import type { Mailer } from '../mailer/index.js';
import { MockSynthesizer } from '../voice/index.js';
import { MockWhatsAppSender } from '../whatsapp/index.js';
import type { PaymentProvider } from '../payments/index.js';
import { evaluateAndPersistPolicy, getActivePolicy } from '../policy/service.js';
import { advanceCase, handleCanonicalEvent, type OrchestratorDeps } from '../orchestrator/orchestrator.js';
import { relayOutboxOnce } from '../ingest/outboxRelay.js';
import { executeIntervention, executeScheduledMandateDebit, type ToolDeps } from '../tools/execute.js';

/**
 * Deterministic in-process job runtime: the same handlers BullMQ workers run,
 * driven synchronously from an in-memory queue. Used by tests and the offline
 * sandbox demo; production uses BullMQ with identical handlers.
 */

type Job =
  | { kind: 'case_step'; caseId: string; trigger: string }
  | { kind: 'agent'; caseId: string; agent: 'triage' | 'diagnosis' | 'strategy' | 'communication' | 'reply_interpreter' | 'summarizer'; communicationId?: string }
  | { kind: 'tool'; caseId: string; interventionId: string; attempt: number }
  | { kind: 'scheduled'; job: { kind: string; caseId: string; interventionId: string; attempt?: number }; delayMs: number };

export interface RuntimeOptions {
  llm: LlmClient;
  provider: PaymentProvider;
  mailer: Mailer;
  /** defaults to mocks: the in-process runtime must never reach a paid API */
  voice?: ToolDeps['voice'];
  rng?: () => number;
  now?: () => Date;
  /** run delayed jobs immediately when draining (tests/demo time-compression) */
  runScheduledImmediately?: boolean;
}

export class InProcessRuntime {
  private queue: Job[] = [];
  /**
   * Virtual time. Running a delayed job "immediately" means asserting its delay
   * elapsed, so the clock every dep reads has to agree — otherwise a pre-debit
   * notice sent one statement earlier looks zero hours old to the debit that
   * is supposed to follow it by a day, and the safety check that compares the
   * two timestamps fires on a schedule the test never intended to compress.
   */
  private clockOffsetMs = 0;
  private readonly now = (): Date =>
    new Date((this.opts.now?.() ?? new Date()).getTime() + this.clockOffsetMs);
  readonly orchestratorDeps: OrchestratorDeps;
  readonly agentDeps: AgentDeps;
  readonly toolDeps: ToolDeps;

  constructor(
    private db: Db,
    private opts: RuntimeOptions,
  ) {
    this.orchestratorDeps = {
      enqueueAgent: async (j) => {
        this.queue.push({ kind: 'agent', ...j });
      },
      enqueueCaseStep: async (caseId, trigger) => {
        this.queue.push({ kind: 'case_step', caseId, trigger });
      },
      enqueueTool: async (j) => {
        this.queue.push({ kind: 'tool', ...j });
      },
      evaluatePolicy: (tx, caseRow, interventionId) =>
        evaluateAndPersistPolicy(tx, caseRow, interventionId, this.now),
      loopGuards: async () => {
        const { config } = await getActivePolicy(this.db);
        return config.loopGuards;
      },
      ...(this.opts.rng ? { rng: this.opts.rng } : {}),
      now: this.now,
    };
    this.agentDeps = {
      llm: this.opts.llm,
      enqueueCaseStep: async (caseId, trigger) => {
        this.queue.push({ kind: 'case_step', caseId, trigger });
      },
      enqueueAgent: async (j) => {
        this.queue.push({ kind: 'agent', ...j });
      },
      now: this.now,
    };
    this.toolDeps = {
      provider: this.opts.provider,
      mailer: this.opts.mailer,
      voice: this.opts.voice ?? {
        synthesizer: new MockSynthesizer(),
        whatsapp: new MockWhatsAppSender(),
        whatsappMode: 'mock',
      },
      enqueueScheduled: async (job, delayMs) => {
        this.queue.push({ kind: 'scheduled', job, delayMs });
      },
      enqueueAgent: async (j) => {
        this.queue.push({ kind: 'agent', ...j });
      },
      now: this.now,
    };
  }

  async ingest(event: CanonicalEvent): Promise<void> {
    await handleCanonicalEvent(this.db, this.orchestratorDeps, event);
  }

  /** Drain jobs + outbox until quiescent (bounded). */
  async drain(maxIterations = 300): Promise<void> {
    for (let i = 0; i < maxIterations; i++) {
      const job = this.queue.shift();
      if (job) {
        await this.dispatch(job);
        continue;
      }
      // no jobs → relay outbox; new canonical events may enqueue more work
      const relayed = await relayOutboxOnce(this.db, {
        publish: async (_id, _type, payload) => {
          const event = CanonicalEvent.parse(payload);
          await this.ingest(event);
        },
      });
      if (relayed === 0 && this.queue.length === 0) return;
    }
    throw new Error('runtime drain did not quiesce — possible loop');
  }

  private async dispatch(job: Job): Promise<void> {
    switch (job.kind) {
      case 'case_step':
        await advanceCase(this.db, this.orchestratorDeps, job.caseId, job.trigger);
        return;
      case 'agent':
        await runAgentJob(this.db, this.agentDeps, job);
        return;
      case 'tool':
        await executeIntervention(this.db, this.toolDeps, job);
        return;
      case 'scheduled': {
        if (!this.opts.runScheduledImmediately && job.delayMs > 0) return; // parked (real runtime uses BullMQ delay)
        // time-compression: the delay is being skipped, so advance the clock by
        // it rather than pretending both the notice and the debit happened at
        // the same instant
        if (job.delayMs > 0) this.clockOffsetMs += job.delayMs;
        if (job.job.kind === 'mandate_execution') {
          await executeScheduledMandateDebit(this.db, this.toolDeps, {
            caseId: job.job.caseId,
            interventionId: job.job.interventionId,
            attempt: job.job.attempt ?? 1,
          });
        } else if (job.job.kind === 'reminder') {
          this.queue.push({ kind: 'case_step', caseId: job.job.caseId, trigger: 'reminder_due' });
        }
        return;
      }
    }
  }
}
