import { Queue } from 'bullmq';
import { makeRedis } from './connection.js';

export const QUEUE_NAMES = {
  normalize: 'normalize',
  orchestrate: 'orchestrate',
  agents: 'agents',
  tools: 'tools',
  scheduled: 'scheduled',
  maintenance: 'maintenance',
} as const;
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export interface NormalizeJob {
  inboxId: string;
}
export interface OrchestrateJob {
  outboxId: string;
}
/** Case-step job: orchestrator advancing a case through its FSM. */
export interface CaseStepJob {
  caseId: string;
  trigger: string;
}
export interface AgentJob {
  caseId: string;
  agent: 'triage' | 'diagnosis' | 'strategy' | 'communication' | 'reply_interpreter' | 'summarizer';
  /** for reply_interpreter: the inbound communication to classify */
  communicationId?: string;
}
export interface ToolJob {
  caseId: string;
  interventionId: string;
  attempt: number;
}
export type ScheduledJob =
  | { kind: 'reminder'; caseId: string; interventionId: string }
  | { kind: 'pre_debit_notification'; caseId: string; interventionId: string }
  | { kind: 'mandate_execution'; caseId: string; interventionId: string; attempt: number }
  | { kind: 'wait_deadline'; caseId: string };
export type MaintenanceJob =
  | { kind: 'outbox_relay' }
  | { kind: 'overdue_scan' }
  | { kind: 'promise_check' }
  | { kind: 'stuck_case_sweep' };

const connection = makeRedis();

export const queues = {
  normalize: new Queue<NormalizeJob>(QUEUE_NAMES.normalize, { connection }),
  orchestrate: new Queue<OrchestrateJob | CaseStepJob>(QUEUE_NAMES.orchestrate, { connection }),
  agents: new Queue<AgentJob>(QUEUE_NAMES.agents, { connection }),
  tools: new Queue<ToolJob>(QUEUE_NAMES.tools, { connection }),
  scheduled: new Queue<ScheduledJob>(QUEUE_NAMES.scheduled, { connection }),
  maintenance: new Queue<MaintenanceJob>(QUEUE_NAMES.maintenance, { connection }),
};

export const defaultJobOpts = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
} as const;
