import type { CaseState } from '@reclaim/shared';
import { TERMINAL_STATES } from '@reclaim/shared';

/**
 * The case lifecycle FSM. Pure data + pure guards; the orchestrator is the
 * only writer. Any transition not listed here is illegal.
 */
const TRANSITIONS: Record<CaseState, readonly CaseState[]> = {
  detected: ['diagnosed', 'waiting', 'recovered', 'stopped', 'escalated', 'lost', 'disputed'],
  diagnosed: ['planned', 'waiting', 'recovered', 'stopped', 'escalated', 'lost', 'disputed'],
  planned: ['pending_policy', 'recovered', 'stopped', 'escalated', 'lost', 'disputed'],
  pending_policy: ['pending_approval', 'executing', 're_evaluating', 'recovered', 'stopped', 'escalated', 'lost', 'disputed'],
  pending_approval: ['executing', 're_evaluating', 'recovered', 'stopped', 'escalated', 'lost', 'disputed'],
  executing: ['waiting', 're_evaluating', 'recovered', 'stopped', 'escalated', 'lost', 'disputed'],
  waiting: ['re_evaluating', 'recovered', 'stopped', 'escalated', 'lost', 'disputed'],
  re_evaluating: ['diagnosed', 'planned', 'waiting', 'recovered', 'stopped', 'escalated', 'lost', 'disputed'],
  recovered: [],
  stopped: [],
  escalated: ['re_evaluating', 'recovered', 'stopped', 'lost', 'disputed'],
  lost: [],
  disputed: ['re_evaluating', 'recovered', 'stopped', 'lost'],
};

export function canTransition(from: CaseState, to: CaseState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(state: CaseState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: CaseState,
    public readonly to: CaseState,
  ) {
    super(`illegal case transition ${from} -> ${to}`);
  }
}
