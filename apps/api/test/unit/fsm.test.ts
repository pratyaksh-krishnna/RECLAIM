import { describe, expect, it } from 'vitest';
import { canTransition, isTerminal } from '../../src/orchestrator/fsm.js';

describe('case FSM', () => {
  it('allows the happy path', () => {
    expect(canTransition('detected', 'diagnosed')).toBe(true);
    expect(canTransition('diagnosed', 'planned')).toBe(true);
    expect(canTransition('planned', 'pending_policy')).toBe(true);
    expect(canTransition('pending_policy', 'executing')).toBe(true);
    expect(canTransition('executing', 'waiting')).toBe(true);
    expect(canTransition('waiting', 're_evaluating')).toBe(true);
    expect(canTransition('re_evaluating', 'planned')).toBe(true);
  });
  it('forbids skipping the policy gate', () => {
    expect(canTransition('planned', 'executing')).toBe(false);
    expect(canTransition('diagnosed', 'executing')).toBe(false);
    expect(canTransition('detected', 'executing')).toBe(false);
  });
  it('terminal states are dead ends', () => {
    for (const s of ['recovered', 'stopped', 'lost'] as const) {
      expect(isTerminal(s)).toBe(true);
      expect(canTransition(s, 're_evaluating')).toBe(false);
      expect(canTransition(s, 'executing')).toBe(false);
    }
  });
  it('any active state can reach recovered/stopped', () => {
    for (const s of ['detected', 'diagnosed', 'planned', 'pending_policy', 'pending_approval', 'executing', 'waiting', 're_evaluating'] as const) {
      expect(canTransition(s, 'recovered')).toBe(true);
      expect(canTransition(s, 'stopped')).toBe(true);
    }
  });
});
