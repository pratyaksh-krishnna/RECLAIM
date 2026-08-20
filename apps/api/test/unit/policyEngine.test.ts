import { describe, expect, it } from 'vitest';
import type { PolicyRequest } from '@reclaim/shared';
import { DEFAULT_POLICY_CONFIG, evaluatePolicyRequest } from '../../src/policy/engine.js';

const NOON_IST = '2026-08-21T06:30:00.000Z'; // 12:00 Asia/Kolkata

function baseRequest(overrides: Partial<PolicyRequest> = {}): PolicyRequest {
  return {
    caseId: '11111111-1111-4111-8111-111111111111',
    customerId: '22222222-2222-4222-8222-222222222222',
    invoiceId: '33333333-3333-4333-8333-333333333333',
    action: { type: 'send_email', templateId: 'payment_failed_notice', language: 'en', toneRegister: 'friendly', slotFills: {} },
    proposedBy: 'agent',
    strategyConfidence: 0.9,
    holdoutArm: 'treatment',
    amountDue: 99_900,
    rail: 'card',
    declineClass: 'soft',
    hasOptOut: false,
    hasOpenDispute: false,
    channelConsent: { email: true },
    customerTimezone: 'Asia/Kolkata',
    nowIso: NOON_IST,
    recoveryAttemptCount: 0,
    lastAttemptAt: null,
    emailsSentLast14d: 0,
    agentInvocationCount: 2,
    caseAgeHours: 5,
    preDebitNotificationScheduledFor: null,
    ...overrides,
  };
}

const evaluate = (req: PolicyRequest) => evaluatePolicyRequest(req, DEFAULT_POLICY_CONFIG, 1);

describe('policy engine — hard compliance', () => {
  it('allows a clean email', () => {
    expect(evaluate(baseRequest()).verdict).toBe('ALLOW');
  });
  it('denies everything on a holdout case except escalate/stop', () => {
    expect(evaluate(baseRequest({ holdoutArm: 'holdout' })).verdict).toBe('DENY');
    expect(
      evaluate(baseRequest({ holdoutArm: 'holdout', action: { type: 'escalate_to_human', reason: 'x' } })).verdict,
    ).toBe('ALLOW');
  });
  it('denies outreach to an opted-out customer but allows stop_workflow', () => {
    expect(evaluate(baseRequest({ hasOptOut: true })).verdict).toBe('DENY');
    expect(evaluate(baseRequest({ hasOptOut: true, action: { type: 'stop_workflow', reason: 'opt_out' } })).verdict).toBe('ALLOW');
  });
  it('denies anything on an open dispute', () => {
    const r = evaluate(baseRequest({ hasOpenDispute: true }));
    expect(r.verdict).toBe('DENY');
    expect(r.reason).toContain('dispute');
  });
  it('denies contact during quiet hours in the customer timezone', () => {
    // 23:00 IST
    const r = evaluate(baseRequest({ nowIso: '2026-08-21T17:30:00.000Z' }));
    expect(r.verdict).toBe('DENY');
    expect(r.reason).toContain('quiet');
  });
  it('quiet hours do not block non-contact actions', () => {
    const r = evaluate(
      baseRequest({
        nowIso: '2026-08-21T17:30:00.000Z',
        action: { type: 'mark_wait', waitUntil: '2026-08-25T06:00:00.000Z', waitingFor: 'provider retry' },
      }),
    );
    expect(r.verdict).toBe('ALLOW');
  });
  it('denies email without channel consent', () => {
    expect(evaluate(baseRequest({ channelConsent: { email: false } })).verdict).toBe('DENY');
  });
});

describe('policy engine — rail limits', () => {
  const mandate = (overrides: Partial<PolicyRequest> = {}) =>
    baseRequest({
      action: { type: 'schedule_mandate_reexecution', scheduleAt: '2026-08-23T06:30:00.000Z' }, // 48h lead
      rail: 'upi_autopay',
      declineClass: 'soft',
      ...overrides,
    });

  it('allows mandate re-execution on soft decline with proper lead time', () => {
    expect(evaluate(mandate()).verdict).toBe('ALLOW');
  });
  it('never allows re-execution of a hard decline', () => {
    const r = evaluate(mandate({ declineClass: 'hard' }));
    expect(r.verdict).toBe('DENY');
    expect(r.reason).toContain('not retryable');
  });
  it('denies re-execution on a rail without a mandate', () => {
    expect(evaluate(mandate({ rail: 'card' })).verdict).toBe('DENY');
  });
  it('enforces the global attempt cap', () => {
    expect(evaluate(mandate({ recoveryAttemptCount: 4 })).verdict).toBe('DENY');
  });
  it('enforces 24h spacing between attempts', () => {
    const r = evaluate(mandate({ lastAttemptAt: '2026-08-21T00:30:00.000Z' })); // 6h ago
    expect(r.verdict).toBe('DENY');
    expect(r.reason).toContain('since last attempt');
  });
  it('denies a mandate debit scheduled inside the pre-debit notice window', () => {
    const r = evaluate(mandate({ action: { type: 'schedule_mandate_reexecution', scheduleAt: '2026-08-21T10:30:00.000Z' } })); // 4h lead
    expect(r.verdict).toBe('DENY');
    expect(r.reason).toContain('pre-debit');
  });
  it('above the AFA threshold only a payment link may run — mandate denied', () => {
    const r = evaluate(mandate({ amountDue: 1_600_000 }));
    expect(r.verdict).toBe('DENY');
    expect(r.reason).toContain('AFA');
    const link = evaluate(baseRequest({ amountDue: 1_600_000, action: { type: 'create_payment_link' } }));
    expect(link.verdict).toBe('REQUIRE_APPROVAL'); // above autonomous cap → approval, not denial
  });
});

describe('policy engine — budgets, financial limits, confidence, loops', () => {
  it('enforces the 3-emails-per-14-days budget', () => {
    expect(evaluate(baseRequest({ emailsSentLast14d: 3 })).verdict).toBe('DENY');
  });
  it('agent money actions above the autonomous cap require approval; human ones do not', () => {
    const agent = evaluate(baseRequest({ action: { type: 'create_payment_link' }, amountDue: 600_000 }));
    expect(agent.verdict).toBe('REQUIRE_APPROVAL');
    const human = evaluate(
      baseRequest({ action: { type: 'create_payment_link' }, amountDue: 600_000, proposedBy: 'human', strategyConfidence: null }),
    );
    expect(human.verdict).toBe('ALLOW');
  });
  it('low confidence with high exposure requires approval', () => {
    const r = evaluate(baseRequest({ strategyConfidence: 0.4, amountDue: 1_200_000 }));
    expect(r.verdict).toBe('REQUIRE_APPROVAL');
    expect(r.reason).toContain('confidence');
  });
  it('low confidence with low exposure is allowed', () => {
    expect(evaluate(baseRequest({ strategyConfidence: 0.4, amountDue: 50_000 })).verdict).toBe('ALLOW');
  });
  it('loop guards deny when tripped, but escalation stays allowed', () => {
    expect(evaluate(baseRequest({ agentInvocationCount: 12 })).verdict).toBe('DENY');
    expect(
      evaluate(baseRequest({ agentInvocationCount: 12, action: { type: 'escalate_to_human', reason: 'loop' } })).verdict,
    ).toBe('ALLOW');
  });
  it('every decision carries the full rule trace', () => {
    const r = evaluate(baseRequest());
    expect(r.ruleTrace.length).toBeGreaterThanOrEqual(10);
    expect(r.ruleTrace.every((t) => ['pass', 'deny', 'require_approval', 'skipped'].includes(t.outcome))).toBe(true);
  });
});
