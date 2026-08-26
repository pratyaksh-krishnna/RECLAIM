import { describe, expect, it } from 'vitest';
import {
  deferContactPastQuietHours,
  evaluatePolicyRequest,
  contactWindow,
} from '../../src/policy/engine.js';
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
    hoursWithoutProgress: 1,
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

/**
 * The 24-hour sweep above runs on an ordinary day, so it cannot see this: the
 * reopen time used to be computed by adding wall-clock minutes to a UTC
 * instant, which is off by an hour across a DST change. Fall-back returned a
 * moment still inside quiet hours; spring-forward overshot and discarded an
 * hour of contact time. Either way the agent was told contact reopens when the
 * gate would still deny it.
 */
describe('contactWindow across DST transitions', () => {
  const transitions: Array<[string, string, string]> = [
    ['Europe/London', '2026-10-24T22:00:00.000Z', 'fall back'],
    ['America/New_York', '2026-11-01T03:00:00.000Z', 'fall back'],
    ['Australia/Lord_Howe', '2026-04-04T13:00:00.000Z', 'fall back (30 min)'],
    ['Europe/London', '2026-03-28T22:00:00.000Z', 'spring forward'],
    ['America/New_York', '2026-03-08T03:00:00.000Z', 'spring forward'],
  ];

  it.each(transitions)('%s %s: the reopen time is actually outside quiet hours', (tz, nowIso) => {
    const window = contactWindow(nowIso, tz, quietHours);
    expect(window.allowedNow).toBe(false);
    expect(window.nextAllowedAt).not.toBeNull();
    // the answer must survive being fed back in — this is the whole contract
    expect(contactWindow(window.nextAllowedAt!, tz, quietHours).allowedNow).toBe(true);
  });

  it.each(transitions)('%s %s: and the minute before it is still inside', (tz, nowIso) => {
    const window = contactWindow(nowIso, tz, quietHours);
    const oneMinuteEarlier = new Date(
      new Date(window.nextAllowedAt!).getTime() - 60_000,
    ).toISOString();
    // proves it is the true boundary, not merely some later allowed moment
    expect(contactWindow(oneMinuteEarlier, tz, quietHours).allowedNow).toBe(false);
  });
});

/**
 * A delay window is a multiple of 24h, so it preserves the customer's local
 * hour. A case denied at 02:28 IST for quiet hours and rescheduled a day out
 * woke at 02:28 and was denied again — and a reopen time computed for *now*
 * cannot see that, because the collision is with a future night. The window
 * has to be evaluated AT the resolved moment.
 */
describe('deferContactPastQuietHours', () => {
  const IST_TZ = 'Asia/Kolkata';
  const overnight = { startHour: 21, endHour: 9 };
  // 20:58 UTC = 02:28 IST, inside 21:00-09:00
  const inQuietTomorrow = '2026-08-26T20:58:00.000Z';

  it('pushes a reminder that lands in a future quiet period out of it', () => {
    const deferred = deferContactPastQuietHours(
      { type: 'schedule_reminder', remindAt: inQuietTomorrow, note: 'follow up' },
      IST_TZ,
      overnight,
    );
    if (deferred.type !== 'schedule_reminder') throw new Error('unreachable');
    expect(deferred.remindAt).not.toBe(inQuietTomorrow);
    expect(contactWindow(deferred.remindAt, IST_TZ, overnight).allowedNow).toBe(true);
  });

  it('pushes a mandate debit too — it sends the pre-debit notice', () => {
    const deferred = deferContactPastQuietHours(
      { type: 'schedule_mandate_reexecution', scheduleAt: inQuietTomorrow },
      IST_TZ,
      overnight,
    );
    if (deferred.type !== 'schedule_mandate_reexecution') throw new Error('unreachable');
    expect(contactWindow(deferred.scheduleAt, IST_TZ, overnight).allowedNow).toBe(true);
  });

  it('leaves a moment that is already permitted untouched', () => {
    const fine = '2026-08-26T06:00:00.000Z'; // 11:30 IST
    const deferred = deferContactPastQuietHours(
      { type: 'schedule_reminder', remindAt: fine, note: 'n' },
      IST_TZ,
      overnight,
    );
    if (deferred.type !== 'schedule_reminder') throw new Error('unreachable');
    expect(deferred.remindAt).toBe(fine);
  });

  it('leaves mark_wait alone — waiting contacts nobody', () => {
    const action = {
      type: 'mark_wait',
      waitUntil: inQuietTomorrow,
      waitingFor: 'payment',
    } as const;
    expect(deferContactPastQuietHours(action, IST_TZ, overnight)).toEqual(action);
  });
});
