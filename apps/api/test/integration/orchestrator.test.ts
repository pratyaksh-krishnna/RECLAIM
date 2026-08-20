import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sql } from '../../src/db/client.js';
import { agentDecisions, recoveryCases, recoveryLedger, invoices } from '../../src/db/schema.js';
import { advanceCase, handleCanonicalEvent } from '../../src/orchestrator/orchestrator.js';
import { makeFakeDeps } from '../helpers/orchestratorDeps.js';
import { seedCustomer, seedInvoice, seedSubscription } from '../helpers/fixtures.js';

afterAll(async () => {
  await sql.end();
});

function paymentFailed(invoiceId: string, customerId: string, declineCode: string | null) {
  return {
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    sourceEventId: `evt_${randomUUID().slice(0, 8)}`,
    type: 'payment.failed' as const,
    customerId,
    invoiceId,
    subscriptionId: null,
    amountDue: 99_900,
    rail: 'card' as const,
    declineCode,
    providerPaymentId: `pay_${randomUUID().slice(0, 8)}`,
  };
}

describe('orchestrator case creation', () => {
  it('creates exactly one case for duplicate payment.failed events on the same invoice', async () => {
    const c = await seedCustomer(db);
    const inv = await seedInvoice(db, c.id);
    const { deps } = makeFakeDeps({ rng: () => 0.99 }); // treatment

    await handleCanonicalEvent(db, deps, paymentFailed(inv.id, c.id, 'insufficient_funds'));
    await handleCanonicalEvent(db, deps, paymentFailed(inv.id, c.id, 'insufficient_funds'));

    const cases = await db.select().from(recoveryCases).where(eq(recoveryCases.invoiceId, inv.id));
    expect(cases).toHaveLength(1);
    // unambiguous code → deterministic diagnosis, no LLM needed
    expect(cases[0]!.state).toBe('diagnosed');
    expect(cases[0]!.causeHypothesis).toBe('insufficient_funds');
    expect(cases[0]!.holdoutArm).toBe('treatment');
  });

  it('ambiguous decline codes start at detected (triage agent path)', async () => {
    const c = await seedCustomer(db);
    const inv = await seedInvoice(db, c.id);
    const { deps, calls } = makeFakeDeps({ rng: () => 0.99 });

    await handleCanonicalEvent(db, deps, paymentFailed(inv.id, c.id, 'do_not_honor'));
    const [caseRow] = await db.select().from(recoveryCases).where(eq(recoveryCases.invoiceId, inv.id));
    expect(caseRow!.state).toBe('detected');
    expect(caseRow!.causeHypothesis).toBeNull();

    await advanceCase(db, deps, caseRow!.id, 'case_created');
    expect(calls.agents).toContainEqual({ caseId: caseRow!.id, agent: 'triage' });
  });

  it('after a valid triage run, detected routes to diagnosis instead', async () => {
    const c = await seedCustomer(db);
    const inv = await seedInvoice(db, c.id);
    const { deps, calls } = makeFakeDeps({ rng: () => 0.99 });
    await handleCanonicalEvent(db, deps, paymentFailed(inv.id, c.id, 'do_not_honor'));
    const [caseRow] = await db.select().from(recoveryCases).where(eq(recoveryCases.invoiceId, inv.id));

    await db.insert(agentDecisions).values({
      caseId: caseRow!.id,
      agent: 'triage',
      model: 'stub',
      promptVersionHash: 'test',
      inputSnapshot: {},
      output: {},
      schemaValid: true,
      latencyMs: 1,
    });
    await advanceCase(db, deps, caseRow!.id, 'triage_done');
    expect(calls.agents.at(-1)).toEqual({ caseId: caseRow!.id, agent: 'diagnosis' });
  });

  it('holdout cases never advance and never get agents', async () => {
    const c = await seedCustomer(db);
    const inv = await seedInvoice(db, c.id);
    const { deps, calls } = makeFakeDeps({ rng: () => 0.01 }); // holdout

    await handleCanonicalEvent(db, deps, paymentFailed(inv.id, c.id, 'insufficient_funds'));
    const [caseRow] = await db.select().from(recoveryCases).where(eq(recoveryCases.invoiceId, inv.id));
    expect(caseRow!.holdoutArm).toBe('holdout');

    await advanceCase(db, deps, caseRow!.id, 'case_created');
    expect(calls.agents).toHaveLength(0);
    expect(calls.tools).toHaveLength(0);
  });

  it('records recovery with ledger entry and closes the case', async () => {
    const c = await seedCustomer(db);
    const sub = await seedSubscription(db, c.id);
    const inv = await seedInvoice(db, c.id, { subscriptionId: sub.id });
    const { deps } = makeFakeDeps({ rng: () => 0.99 });
    await handleCanonicalEvent(db, deps, paymentFailed(inv.id, c.id, 'insufficient_funds'));

    await handleCanonicalEvent(db, deps, {
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      sourceEventId: `evt_${randomUUID().slice(0, 8)}`,
      type: 'payment.recovered',
      customerId: c.id,
      invoiceId: inv.id,
      amountPaid: 99_900,
      providerPaymentId: `pay_${randomUUID().slice(0, 8)}`,
      via: 'payment_link',
    });

    const [caseRow] = await db.select().from(recoveryCases).where(eq(recoveryCases.invoiceId, inv.id));
    expect(caseRow!.state).toBe('recovered');
    const ledger = await db.select().from(recoveryLedger).where(eq(recoveryLedger.caseId, caseRow!.id));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.attributionClass).toBe('direct');
    const [invRow] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(invRow!.status).toBe('paid');
  });

  it('duplicate payment.recovered deliveries produce one ledger entry', async () => {
    const c = await seedCustomer(db);
    const inv = await seedInvoice(db, c.id);
    const { deps } = makeFakeDeps({ rng: () => 0.99 });
    await handleCanonicalEvent(db, deps, paymentFailed(inv.id, c.id, 'insufficient_funds'));

    const providerPaymentId = `pay_${randomUUID().slice(0, 8)}`;
    const recovered = {
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      sourceEventId: 'evt_dup',
      type: 'payment.recovered' as const,
      customerId: c.id,
      invoiceId: inv.id,
      amountPaid: 99_900,
      providerPaymentId,
      via: 'payment_link' as const,
    };
    await handleCanonicalEvent(db, deps, recovered);
    await handleCanonicalEvent(db, deps, { ...recovered, eventId: randomUUID() });

    const [caseRow] = await db.select().from(recoveryCases).where(eq(recoveryCases.invoiceId, inv.id));
    const ledger = await db.select().from(recoveryLedger).where(eq(recoveryLedger.caseId, caseRow!.id));
    expect(ledger).toHaveLength(1);
  });

  it('loop guard escalates a case exceeding max agent invocations', async () => {
    const c = await seedCustomer(db);
    const inv = await seedInvoice(db, c.id);
    const { deps, calls } = makeFakeDeps({ rng: () => 0.99 });
    await handleCanonicalEvent(db, deps, paymentFailed(inv.id, c.id, 'do_not_honor'));
    const [caseRow] = await db.select().from(recoveryCases).where(eq(recoveryCases.invoiceId, inv.id));

    await db
      .update(recoveryCases)
      .set({ agentInvocationCount: 99 })
      .where(eq(recoveryCases.id, caseRow!.id));
    await advanceCase(db, deps, caseRow!.id, 're_evaluate');

    const [after] = await db.select().from(recoveryCases).where(eq(recoveryCases.id, caseRow!.id));
    expect(after!.state).toBe('escalated');
    expect(calls.agents.at(-1)).toEqual({ caseId: caseRow!.id, agent: 'summarizer' });
  });
});
