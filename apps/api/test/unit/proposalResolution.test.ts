import { describe, expect, it } from 'vitest';
import {
  ActionParams,
  DELAY_WINDOW_HOURS,
  InterveneActionParams,
  ProposedActionParams,
  resolveProposedAction,
} from '@reclaim/shared';

/**
 * The agent names a delay window; deterministic code names the moment.
 *
 * This exists because an agent-authored `scheduleAt` was one of the two
 * operands in the `upi_pre_debit_notice` compliance rule — the model's number
 * subtracted from the server's clock to decide whether the mandatory India
 * notice period was met. A date is a money-control value when it gates a rule
 * like that, and the catalog now has nowhere to put one.
 */
const NOW = new Date('2026-08-26T09:00:00.000Z');
const RULES = { preDebitNoticeHours: 24 };
const hoursFromNow = (iso: string): number => (new Date(iso).getTime() - NOW.getTime()) / 3_600_000;

describe('agent proposals carry no dates', () => {
  it.each(['schedule_mandate_reexecution', 'schedule_reminder', 'mark_wait'] as const)(
    'rejects a fabricated datetime on %s',
    (type) => {
      // the exact shapes the agent used to be able to emit
      const withDate: Record<string, unknown> = {
        schedule_mandate_reexecution: { type, scheduleAt: '2026-09-01T00:00:00.000Z' },
        schedule_reminder: { type, remindAt: '2026-09-01T00:00:00.000Z', note: 'follow up' },
        mark_wait: { type, waitUntil: '2026-09-01T00:00:00.000Z', waitingFor: 'payment' },
      }[type] as Record<string, unknown>;

      expect(ProposedActionParams.safeParse(withDate).success).toBe(false);
    },
  );
});

describe('agent proposals name only templates send_email can render', () => {
  const base = {
    type: 'send_email',
    language: 'en',
    toneRegister: 'formal',
    slotFills: {},
  } as const;

  it('rejects pre_debit_notice — schedule_mandate_reexecution owns that template', () => {
    // Schema-valid and policy-approved until execution refused it, which cost a
    // model call, a policy decision, and a human. Now it cannot be said at all.
    expect(
      ProposedActionParams.safeParse({ ...base, templateId: 'pre_debit_notice' }).success,
    ).toBe(false);
    // still executable, because schedule_mandate_reexecution renders it
    expect(ActionParams.safeParse({ ...base, templateId: 'pre_debit_notice' }).success).toBe(true);
  });

  it.each(['payment_failed_notice', 'payment_link_delivery', 'payment_reminder'] as const)(
    'accepts %s',
    (templateId) => {
      expect(ProposedActionParams.safeParse({ ...base, templateId }).success).toBe(true);
    },
  );
});

describe('resolveProposedAction', () => {
  it('turns a wait window into a moment measured from now', () => {
    const resolved = resolveProposedAction(
      { type: 'mark_wait', waitFor: 'medium', waitingFor: 'reconciliation' },
      NOW,
      RULES,
    );
    expect(resolved.type).toBe('mark_wait');
    if (resolved.type !== 'mark_wait') throw new Error('unreachable');
    expect(hoursFromNow(resolved.waitUntil)).toBe(DELAY_WINDOW_HOURS.medium);
  });

  it('turns a reminder window into a moment measured from now', () => {
    const resolved = resolveProposedAction(
      { type: 'schedule_reminder', remindIn: 'short', note: 'follow up' },
      NOW,
      RULES,
    );
    if (resolved.type !== 'schedule_reminder') throw new Error('unreachable');
    expect(hoursFromNow(resolved.remindAt)).toBe(DELAY_WINDOW_HOURS.short);
  });

  it('never schedules a debit inside the mandatory notice period, however soon the agent asked', () => {
    // same_day is 6h — well under the 24h pre-debit notice the rail requires
    const resolved = resolveProposedAction(
      { type: 'schedule_mandate_reexecution', scheduleIn: 'same_day' },
      NOW,
      RULES,
    );
    if (resolved.type !== 'schedule_mandate_reexecution') throw new Error('unreachable');
    expect(hoursFromNow(resolved.scheduleAt)).toBeGreaterThan(RULES.preDebitNoticeHours);
  });

  it('reads the notice period from policy, not from a constant', () => {
    // Policy Studio raises the requirement; the floor moves with it
    const resolved = resolveProposedAction(
      { type: 'schedule_mandate_reexecution', scheduleIn: 'short' },
      NOW,
      { preDebitNoticeHours: 72 },
    );
    if (resolved.type !== 'schedule_mandate_reexecution') throw new Error('unreachable');
    expect(hoursFromNow(resolved.scheduleAt)).toBeGreaterThan(72);
  });

  it('honours a longer window when the agent asks for one', () => {
    const resolved = resolveProposedAction(
      { type: 'schedule_mandate_reexecution', scheduleIn: 'long' },
      NOW,
      RULES,
    );
    if (resolved.type !== 'schedule_mandate_reexecution') throw new Error('unreachable');
    expect(hoursFromNow(resolved.scheduleAt)).toBe(DELAY_WINDOW_HOURS.long);
  });

  it('passes dateless actions through untouched', () => {
    for (const action of [
      { type: 'create_payment_link' },
      { type: 'escalate_to_human', reason: 'cause unclear' },
      { type: 'stop_workflow', reason: 'opt_out' },
      // extracted evidence, not an agent-chosen date — deliberately still a date
      {
        type: 'record_promise_to_pay',
        promisedDate: '2026-09-05T00:00:00.000Z',
        amountReference: 'the full amount',
      },
    ] as const) {
      expect(resolveProposedAction(action, NOW, RULES)).toEqual(action);
    }
  });

  it('always produces something the execution catalog accepts', () => {
    for (const proposal of [
      { type: 'mark_wait', waitFor: 'same_day', waitingFor: 'payment' },
      { type: 'schedule_reminder', remindIn: 'long', note: 'follow up' },
      { type: 'schedule_mandate_reexecution', scheduleIn: 'medium' },
    ] as const) {
      expect(ActionParams.safeParse(resolveProposedAction(proposal, NOW, RULES)).success).toBe(
        true,
      );
    }
  });
});

describe('operators propose through the same narrowed template set', () => {
  const base = {
    type: 'send_email',
    language: 'en',
    toneRegister: 'formal',
    slotFills: {},
  } as const;

  it('POST /intervene rejects pre_debit_notice, as the agent catalog does', () => {
    // it used to be accepted, pass the policy gate, and die at the tool
    expect(
      InterveneActionParams.safeParse({ ...base, templateId: 'pre_debit_notice' }).success,
    ).toBe(false);
  });

  it('but operators keep absolute dates — a human knows what time it is', () => {
    const r = InterveneActionParams.safeParse({
      type: 'schedule_reminder',
      remindAt: '2026-09-01T00:00:00.000Z',
      note: 'follow up',
    });
    expect(r.success).toBe(true);
  });
});
