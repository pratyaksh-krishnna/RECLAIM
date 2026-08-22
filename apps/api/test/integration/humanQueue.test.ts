import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { db, sql } from '../../src/db/client.js';
import { auditEvents, interventions, recoveryCases } from '../../src/db/schema.js';
import { humanQueue } from '../../src/api/humanQueue.js';
import { seedCustomer, seedInvoice } from '../helpers/fixtures.js';

afterAll(async () => {
  await sql.end();
});

async function seedCase(
  state: 'escalated' | 'pending_approval' | 'waiting' | 'recovered' | 'disputed',
  exposurePaise: number,
  overrides: Partial<typeof recoveryCases.$inferInsert> = {},
) {
  const customer = await seedCustomer(db, { name: `Case owner ${randomUUID().slice(0, 6)}` });
  const invoice = await seedInvoice(db, customer.id, { amountDuePaise: exposurePaise });
  const [row] = await db
    .insert(recoveryCases)
    .values({
      customerId: customer.id,
      invoiceId: invoice.id,
      state,
      leakType: 'subscription_payment_failure',
      exposurePaise,
      holdoutArm: 'treatment',
      attributionWindowEndsAt: new Date('2026-12-01T00:00:00Z'),
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('seedCase failed');
  return { caseRow: row, customer, invoice };
}

describe('human queue — escalated cases reach the human approval area', () => {
  it('surfaces an escalated case as an escalation work item', async () => {
    const { caseRow, customer } = await seedCase('escalated', 149_900);
    await db.insert(auditEvents).values({
      caseId: caseRow.id,
      actorType: 'system',
      eventType: 'case.transition',
      payload: { from: 'waiting', to: 'escalated', reason: 'prompt-injection attempt in customer reply' },
    });
    await db.insert(auditEvents).values({
      caseId: caseRow.id,
      actorType: 'agent',
      actorId: 'summarizer',
      eventType: 'case.summary',
      payload: { summary: 'Card declined twice; customer reply contained an injection attempt.', citedEventIds: [] },
    });

    const queue = await humanQueue(db);
    const item = queue.find((q) => q.caseRow.id === caseRow.id);

    expect(item, 'escalated case must appear in the human queue').toBeDefined();
    expect(item!.kind).toBe('escalation');
    expect(item!.customerName).toBe(customer.name);
    expect(item!.summary).toContain('injection attempt');
    expect(item!.escalationReason).toBe('prompt-injection attempt in customer reply');
  });

  it('still surfaces a pending_approval intervention as an approval work item', async () => {
    const { caseRow } = await seedCase('pending_approval', 99_900);
    const [iv] = await db
      .insert(interventions)
      .values({
        caseId: caseRow.id,
        actionType: 'create_payment_link',
        params: { type: 'create_payment_link' },
        proposedBy: 'agent',
        status: 'pending_approval',
        rationale: 'above the autonomous cap',
        stopConditions: ['customer pays'],
      })
      .returning();

    const queue = await humanQueue(db);
    const item = queue.find((q) => q.caseRow.id === caseRow.id);

    expect(item).toBeDefined();
    expect(item!.kind).toBe('approval');
    expect(item!.intervention?.id).toBe(iv!.id);
  });

  it('does not surface cases that need no human decision', async () => {
    const { caseRow: waitingCase } = await seedCase('waiting', 50_000);
    const { caseRow: doneCase } = await seedCase('recovered', 50_000);

    const queue = await humanQueue(db);

    expect(queue.find((q) => q.caseRow.id === waitingCase.id)).toBeUndefined();
    expect(queue.find((q) => q.caseRow.id === doneCase.id)).toBeUndefined();
  });

  it('ranks the queue by exposure so the biggest leak is decided first', async () => {
    const { caseRow: small } = await seedCase('escalated', 10_000);
    const { caseRow: big } = await seedCase('escalated', 9_000_000);

    const queue = await humanQueue(db);
    const positions = queue.map((q) => q.caseRow.id);

    expect(positions.indexOf(big.id)).toBeLessThan(positions.indexOf(small.id));
  });

  it('lists a case once even when an escalated case carries a stale pending_approval row', async () => {
    const { caseRow } = await seedCase('escalated', 77_700);
    await db.insert(interventions).values({
      caseId: caseRow.id,
      actionType: 'send_email',
      params: { type: 'send_email' },
      proposedBy: 'agent',
      status: 'pending_approval',
      rationale: 'stale proposal left behind by an earlier plan',
      stopConditions: ['customer pays'],
    });

    const queue = await humanQueue(db);

    expect(queue.filter((q) => q.caseRow.id === caseRow.id)).toHaveLength(1);
  });
});

describe('human queue — disputed cases are human work too', () => {
  it('surfaces a disputed case as a dispute work item with its reason and summary', async () => {
    const { caseRow } = await seedCase('disputed', 249_900, { disputedAt: new Date('2026-08-20T00:00:00Z') });
    await db.insert(auditEvents).values({
      caseId: caseRow.id,
      actorType: 'system',
      eventType: 'case.transition',
      payload: { from: 'waiting', to: 'disputed', reason: 'customer disputes the charge' },
    });
    await db.insert(auditEvents).values({
      caseId: caseRow.id,
      actorType: 'agent',
      actorId: 'summarizer',
      eventType: 'case.summary',
      payload: { summary: 'Customer raised a chargeback with their bank.', citedEventIds: [] },
    });

    const queue = await humanQueue(db);
    const item = queue.find((q) => q.caseRow.id === caseRow.id);

    expect(item, 'a frozen dispute must be reachable by a human').toBeDefined();
    expect(item!.kind).toBe('dispute');
    expect(item!.escalationReason).toBe('customer disputes the charge');
    expect(item!.summary).toContain('chargeback');
  });

  it('ranks disputes alongside escalations by exposure', async () => {
    const { caseRow: bigDispute } = await seedCase('disputed', 8_000_000, { disputedAt: new Date() });
    const { caseRow: smallEsc } = await seedCase('escalated', 5_000);

    const ids = (await humanQueue(db)).map((q) => q.caseRow.id);
    expect(ids.indexOf(bigDispute.id)).toBeLessThan(ids.indexOf(smallEsc.id));
  });
});
