import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sql } from '../../src/db/client.js';
import { recoveryCases } from '../../src/db/schema.js';
import { sweepCases } from '../../src/orchestrator/sweep.js';
import { humanQueue } from '../../src/api/humanQueue.js';
import { seedCustomer, seedInvoice } from '../helpers/fixtures.js';

/**
 * The general stall alarm. Two separate bugs shipped where a case went quiet in
 * a state nothing was watching (escalated, then disputed), each fixed by
 * teaching one more reader about one more state. This catches the states we
 * did not think of.
 */

const NOW = () => new Date('2026-08-22T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW().getTime() - h * 3_600_000);

afterAll(async () => {
  await sql.end();
});

async function seedCase(
  state: 'waiting' | 'executing' | 're_evaluating' | 'disputed' | 'pending_approval' | 'recovered' | 'planned',
  lastProgressAt: Date,
  overrides: Partial<typeof recoveryCases.$inferInsert> = {},
) {
  const customer = await seedCustomer(db, { name: `Stall ${randomUUID().slice(0, 6)}` });
  const invoice = await seedInvoice(db, customer.id);
  const [row] = await db
    .insert(recoveryCases)
    .values({
      customerId: customer.id,
      invoiceId: invoice.id,
      state,
      leakType: 'subscription_payment_failure',
      exposurePaise: 99_900,
      holdoutArm: 'treatment',
      // far future so the attribution-window sweep never interferes
      attributionWindowEndsAt: new Date('2027-12-01T00:00:00Z'),
      lastProgressAt,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('seed failed');
  return row;
}

const runSweep = () => sweepCases(db, async () => {}, NOW, 72);
const stateOf = async (id: string) =>
  (await db.select().from(recoveryCases).where(eq(recoveryCases.id, id)))[0]!.state;

describe('stall alarm — a case that stops moving reaches a human', () => {
  it('escalates a waiting case that has no wake-up timer at all', async () => {
    // the exact gap: the wait sweep only matches waitUntil IS NOT NULL, so a
    // waiting case with no timer was never picked up by anything
    const c = await seedCase('waiting', hoursAgo(100), { waitUntil: null });
    await runSweep();
    expect(await stateOf(c.id)).toBe('escalated');
  });

  it('escalates a case stuck mid-execution', async () => {
    const c = await seedCase('executing', hoursAgo(100));
    await runSweep();
    expect(await stateOf(c.id)).toBe('escalated');
  });

  it('leaves a waiting case alone while its timer is still ahead of it', async () => {
    const c = await seedCase('waiting', hoursAgo(100), { waitUntil: new Date('2026-09-01T00:00:00Z') });
    await runSweep();
    expect(await stateOf(c.id), 'a live timer means the case is working as intended').toBe('waiting');
  });

  it('leaves a case that is already in front of a human alone', async () => {
    const disputed = await seedCase('disputed', hoursAgo(500), { disputedAt: hoursAgo(500) });
    const awaiting = await seedCase('pending_approval', hoursAgo(500));
    await runSweep();
    // these are waited-upon, not stalled — re-escalating would be noise
    expect(await stateOf(disputed.id)).toBe('disputed');
    expect(await stateOf(awaiting.id)).toBe('pending_approval');
  });

  it('leaves a recently-active case alone', async () => {
    const c = await seedCase('re_evaluating', hoursAgo(2));
    await runSweep();
    expect(await stateOf(c.id)).toBe('re_evaluating');
  });

  it('never touches a closed case', async () => {
    const c = await seedCase('recovered', hoursAgo(900));
    await runSweep();
    expect(await stateOf(c.id)).toBe('recovered');
  });

  it('puts the stalled case in the human inbox with a reason that says what happened', async () => {
    const c = await seedCase('executing', hoursAgo(100));
    await runSweep();

    const item = (await humanQueue(db)).find((q) => q.caseRow.id === c.id);
    expect(item, 'a stalled case must become visible human work').toBeDefined();
    expect(item!.kind).toBe('escalation');
    expect(item!.escalationReason).toContain('stalled');
    expect(item!.escalationReason).toContain('executing');
  });

  it('reports how many it caught', async () => {
    const before = (await runSweep()).stalled;
    await seedCase('executing', hoursAgo(100));
    await seedCase('planned', hoursAgo(100));
    const after = (await runSweep()).stalled;
    expect(after).toBeGreaterThanOrEqual(2);
    expect(before).toBe(0); // idempotent: a second sweep re-catches nothing
  });
});
