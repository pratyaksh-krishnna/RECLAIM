import { describe, expect, it } from 'vitest';
import { evaluatePolicyRequest, contactWindow } from '../../src/policy/engine.js';
import { DEFAULT_POLICY_CONFIG } from '../../src/policy/defaults.js';
import type { PolicyRequest } from '@reclaim/shared';

/**
 * The agent is told `contactAllowedNow`; the gate decides `quiet_hours`. This
 * asserts they are the same answer, because they used to be two.
 *
 * A strategy agent, handed nowIso + timezone + {startHour, endHour}, read the
 * quiet window as the window in which contact was permitted, concluded 02:28
 * IST fell outside it, and scheduled a reminder instead of emailing a 70-day
 * overdue invoice. Its twin case proposed an email in the same minute and the
 * quiet_hours rule passed it.
 */
const IST = 'Asia/Kolkata';
const quietHours = { startHour: 21, endHour: 9 };

function requestAt(nowIso: string, timeZone = IST): PolicyRequest {
  return {
    caseId: '00000000-0000-0000-0000-000000000001',
    customerId: '00000000-0000-0000-0000-000000000002',
    invoiceId: '00000000-0000-0000-0000-000000000003',
    action: {
      type: 'send_email',
      templateId: 'payment_reminder',
      language: 'en',
      toneRegister: 'formal',
      slotFills: {},
    },
    proposedBy: 'agent',
    strategyConfidence: 0.9,
    holdoutArm: 'treatment',
    amountDue: 100_000,
    rail: 'card',
    declineClass: null,
    hasOptOut: false,
    hasOpenDispute: false,
    channelConsent: { email: true },
    customerTimezone: timeZone,
    nowIso,
    recoveryAttemptCount: 0,
    lastAttemptAt: null,
    emailsSentLast14d: 0,
    agentInvocationCount: 1,
    caseAgeHours: 1,
    preDebitNotificationScheduledFor: null,
  };
}

const quietHoursOutcome = (nowIso: string): string | undefined =>
  evaluatePolicyRequest(
    requestAt(nowIso),
    { ...DEFAULT_POLICY_CONFIG, quietHours },
    1,
  ).ruleTrace.find((r) => r.ruleId === 'quiet_hours')?.outcome;

describe('contactAllowedNow is the same answer the gate gives', () => {
  // 00:00 → 23:00 IST, i.e. 18:30 the previous day → 17:30 UTC
  const everyHourOfTheDay = Array.from({ length: 24 }, (_, h) => {
    const utc = new Date(Date.UTC(2026, 7, 25, 18, 30, 0) + h * 3_600_000);
    return utc.toISOString();
  });

  it.each(everyHourOfTheDay)('agrees at %s', (nowIso) => {
    const agentView = contactWindow(nowIso, IST, quietHours);
    const gateVerdict = quietHoursOutcome(nowIso);
    expect(agentView.allowedNow).toBe(gateVerdict === 'pass');
  });
});

describe('contactWindow', () => {
  // 20:58 UTC = 02:28 IST — the exact instant the agent got wrong
  const theMomentItFailed = '2026-08-25T20:58:17.838Z';

  it('reports contact permitted when the quiet window does not span now', () => {
    // 09:00-11:00 quiet: 02:28 IST is outside it, so contact is allowed
    expect(contactWindow(theMomentItFailed, IST, { startHour: 9, endHour: 11 })).toMatchObject({
      allowedNow: true,
      localHour: 2,
      nextAllowedAt: null,
    });
  });

  it('reports contact barred inside an overnight window, and when it reopens', () => {
    // 21:00-09:00 quiet: 02:28 IST is inside it
    const window = contactWindow(theMomentItFailed, IST, quietHours);
    expect(window.allowedNow).toBe(false);
    expect(window.localHour).toBe(2);
    // reopens at 09:00 IST — 6h32m after 02:28, landing on the hour despite
    // IST's half-hour offset from UTC
    expect(window.nextAllowedAt).toBe('2026-08-26T03:30:17.838Z');
    expect(contactWindow(window.nextAllowedAt!, IST, quietHours).allowedNow).toBe(true);
  });

  it('reopens on the hour for a whole-hour timezone too', () => {
    // 03:30 UTC is 03:30 in London (BST = UTC+1 → 04:30); quiet 21-09
    const window = contactWindow('2026-08-26T03:30:00.000Z', 'Europe/London', quietHours);
    expect(window.allowedNow).toBe(false);
    expect(contactWindow(window.nextAllowedAt!, 'Europe/London', quietHours).allowedNow).toBe(true);
  });
});
