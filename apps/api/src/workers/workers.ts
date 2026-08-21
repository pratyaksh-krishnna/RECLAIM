import { Worker } from 'bullmq';
import { CanonicalEvent } from '@reclaim/shared';
import type { Db } from '../db/client.js';
import { makeRedis } from '../queues/connection.js';
import {
  QUEUE_NAMES,
  defaultJobOpts,
  queues,
  type AgentJob,
  type CaseStepJob,
  type MaintenanceJob,
  type NormalizeJob,
  type ScheduledJob,
  type ToolJob,
} from '../queues/queues.js';
import { processInboxRow } from '../ingest/normalizeWorker.js';
import { relayOutboxOnce } from '../ingest/outboxRelay.js';
import { scanOverdueOnce } from '../ingest/overdueScanner.js';
import { runAgentJob, type AgentDeps } from '../agents/runner.js';
import { advanceCase, handleCanonicalEvent, type OrchestratorDeps } from '../orchestrator/orchestrator.js';
import { sweepCases } from '../orchestrator/sweep.js';
import { evaluateAndPersistPolicy, getActivePolicy } from '../policy/service.js';
import { executeIntervention, executeScheduledMandateDebit, type ToolDeps } from '../tools/execute.js';
import { getLlmClient } from '../llm/index.js';
import { getPaymentProvider } from '../payments/index.js';
import { getMailer } from '../mailer/index.js';

/**
 * BullMQ workers — production counterparts of the InProcessRuntime, sharing
 * the exact same handler functions.
 */
export function buildLiveDeps(db: Db): { orchestrator: OrchestratorDeps; agents: AgentDeps; tools: ToolDeps } {
  const orchestrator: OrchestratorDeps = {
    enqueueAgent: async (j) => {
      await queues.agents.add(`agent-${j.agent}`, j, defaultJobOpts);
    },
    enqueueCaseStep: async (caseId, trigger, delayMs) => {
      await queues.orchestrate.add('case-step', { caseId, trigger }, { ...defaultJobOpts, ...(delayMs ? { delay: delayMs } : {}) });
    },
    enqueueTool: async (j) => {
      await queues.tools.add('tool', j, defaultJobOpts);
    },
    evaluatePolicy: (tx, caseRow, interventionId) => evaluateAndPersistPolicy(tx, caseRow, interventionId),
    loopGuards: async () => (await getActivePolicy(db)).config.loopGuards,
  };
  const agents: AgentDeps = {
    llm: getLlmClient(),
    enqueueCaseStep: orchestrator.enqueueCaseStep,
    enqueueAgent: async (j) => {
      await queues.agents.add(`agent-${j.agent}`, j, defaultJobOpts);
    },
  };
  const tools: ToolDeps = {
    provider: getPaymentProvider(),
    mailer: getMailer(),
    enqueueScheduled: async (job, delayMs) => {
      await queues.scheduled.add(job.kind, job as ScheduledJob, { ...defaultJobOpts, delay: delayMs });
    },
    enqueueAgent: async (j) => {
      await queues.agents.add('agent-summarizer', j, defaultJobOpts);
    },
  };
  return { orchestrator, agents, tools };
}

export function startWorkers(db: Db): Worker[] {
  const deps = buildLiveDeps(db);
  // BullMQ Workers issue BLOCKING Redis commands, soevery Worker needs its OWN
  // connection. Sharing one across workers causes silent, erratic job loss
  // under burst — jobs complete but follow-up jobs never get delivered.
  const opts = () => ({ connection: makeRedis(), concurrency: 4 });

  const workers: Worker[] = [
    new Worker<NormalizeJob>(QUEUE_NAMES.normalize, async (job) => processInboxRow(db, job.data.inboxId), opts()),

    new Worker(QUEUE_NAMES.orchestrate, async (job) => {
      const data = job.data as CaseStepJob | { outboxId: string; eventType: string; payload: unknown };
      if ('caseId' in data) {
        await advanceCase(db, deps.orchestrator, data.caseId, data.trigger);
      } else {
        await handleCanonicalEvent(db, deps.orchestrator, CanonicalEvent.parse(data.payload));
      }
    }, opts()),

    new Worker<AgentJob>(QUEUE_NAMES.agents, async (job) => runAgentJob(db, deps.agents, job.data), { connection: makeRedis(), concurrency: 2 }),

    new Worker<ToolJob>(QUEUE_NAMES.tools, async (job) => {
      await executeIntervention(db, deps.tools, job.data);
    }, opts()),

    new Worker<ScheduledJob>(QUEUE_NAMES.scheduled, async (job) => {
      const data = job.data;
      switch (data.kind) {
        case 'mandate_execution':
          await executeScheduledMandateDebit(db, deps.tools, { caseId: data.caseId, interventionId: data.interventionId, attempt: data.attempt });
          return;
        case 'reminder':
        case 'wait_deadline':
          await deps.orchestrator.enqueueCaseStep(data.caseId, data.kind);
          return;
        case 'pre_debit_notification':
          return; // notice is sent synchronously by the scheduling tool; job kept for observability
      }
    }, opts()),

    new Worker<MaintenanceJob>(QUEUE_NAMES.maintenance, async (job) => {
      switch (job.data.kind) {
        case 'outbox_relay':
          await relayOutboxOnce(db, {
            publish: async (outboxId, eventType, payload) => {
              await queues.orchestrate.add('event', { outboxId, eventType, payload }, { ...defaultJobOpts, jobId: `outbox-${outboxId}` });
            },
          });
          return;
        case 'overdue_scan':
          await scanOverdueOnce(db);
          return;
        case 'promise_check':
        case 'stuck_case_sweep':
          await sweepCases(db, deps.orchestrator.enqueueCaseStep);
          return;
      }
    }, { connection: makeRedis(), concurrency: 1 }),
  ];

  // Without these, a throwing job fails silently and a case just stops advancing.
  for (const w of workers) {
    w.on('failed', (job, err) => {
      console.error(`[worker:${w.name}] job ${job?.id ?? '?'} failed: ${err?.message ?? err}`);
    });
    w.on('error', (err) => {
      console.error(`[worker:${w.name}] error: ${err.message}`);
    });
  }
  return workers;
}

export async function registerRepeatables(): Promise<void> {
  await queues.maintenance.add('outbox_relay', { kind: 'outbox_relay' }, { repeat: { every: 3000 }, jobId: 'rep-outbox-relay' });
  await queues.maintenance.add('overdue_scan', { kind: 'overdue_scan' }, { repeat: { pattern: '0 1 * * *' }, jobId: 'rep-overdue-scan' });
  await queues.maintenance.add('promise_check', { kind: 'promise_check' }, { repeat: { pattern: '30 1 * * *' }, jobId: 'rep-promise-check' });
  await queues.maintenance.add('stuck_case_sweep', { kind: 'stuck_case_sweep' }, { repeat: { every: 3_600_000 }, jobId: 'rep-sweep' });
}
