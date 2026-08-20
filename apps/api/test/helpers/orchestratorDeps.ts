import type { PolicyDecisionResult } from '@reclaim/shared';
import type { OrchestratorDeps } from '../../src/orchestrator/orchestrator.js';

export interface RecordedCalls {
  agents: Array<{ caseId: string; agent: string; communicationId?: string }>;
  steps: Array<{ caseId: string; trigger: string }>;
  tools: Array<{ caseId: string; interventionId: string; attempt: number }>;
}

export function makeFakeDeps(
  overrides: Partial<OrchestratorDeps> = {},
): { deps: OrchestratorDeps; calls: RecordedCalls } {
  const calls: RecordedCalls = { agents: [], steps: [], tools: [] };
  const allow: PolicyDecisionResult = { verdict: 'ALLOW', reason: null, ruleTrace: [], policyVersion: 1 };
  const deps: OrchestratorDeps = {
    enqueueAgent: async (j) => {
      calls.agents.push(j);
    },
    enqueueCaseStep: async (caseId, trigger) => {
      calls.steps.push({ caseId, trigger });
    },
    enqueueTool: async (j) => {
      calls.tools.push(j);
    },
    evaluatePolicy: async () => allow,
    loopGuards: async () => ({ maxAgentInvocationsPerCase: 12, maxCaseAgeHoursWithoutProgress: 96 }),
    ...overrides,
  };
  return { deps, calls };
}
