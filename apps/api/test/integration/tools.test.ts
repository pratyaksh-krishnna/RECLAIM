import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { ActionParams } from '@reclaim/shared';
import { db, sql } from '../../src/db/client.js';
import {
  communications,
  customers,
  interventions,
  outbox,
  paymentMethods,
  promisesToPay,
  recoveryCases,
  toolExecutions,
} from '../../src/db/schema.js';
import { executeIntervention, executeScheduledMandateDebit, type ToolDeps } from '../../src/tools/execute.js';
import { SandboxPaymentProvider } from '../../src/payments/sandboxAdapter.js';
import { seedCustomer, seedInvoice } from '../helpers/fixtures.js';

afterAll(async () => {
  await sql.end();
});

function makeToolDeps() {
  const scheduled: Array<{ job: { kind: string; caseId: string; interventionId: string }; delayMs: number }> = [];
  const sentEmails: Array<{ subject: string; body: string; to: string }> = [];
  const deps: ToolDeps = {
    provider: new SandboxPaymentProvider(),
    mailer: {
      name: 'test',
      send: async (msg) => {
        sentEmails.push({ subject: msg.subject, body: msg.body, to: msg.to.email });
        return { providerMessageId: `test_${randomUUID().slice(0, 8)}` };
      },
    },
    enqueueScheduled: async (job, delayMs) => {
      scheduled.push({ job, delayMs });
    },
    enqueueAgent: async () => {},
  };
  return { deps, scheduled, sentEmails };
}

async function makeExecutingCase(action: ActionParams, opts: { rail?: 'card' | 'upi_autopay' } = {}) {
  const customer = await seedCustomer(db);
  const invoice = await seedInvoice(db, customer.id);
  if (opts.rail === 'upi_autopay') {
    await db.insert(paymentMethods).values({
      customerId: customer.id,
      rail: 'upi_autopay',
      tokenRef: 'tok_test',
      mandateRef: `mandate_${randomUUID().slice(0, 8)}`,
      mandateMaxPaise: 1_500_000,
    });
  }
  const [caseRow] = await db
    .insert(recoveryCases)
    .values({
      customerId: customer.id,
      invoiceId: invoice.id,
      state: 'executing',
      leakType: 'subscription_payment_failure',
      exposurePaise: invoice.amountDuePaise,
      holdoutArm: 'treatment',
      attributionWindowEndsAt: new Date(Date.now() + 30 * 86_400_000),
    })
    .returning();
  const [intervention] = await db
    .insert(interventions)
    .values({ caseId: caseRow!.id, actionType: action.type, params: action, proposedBy: 'agent', status: 'approved' })
    .returning();
  return { customer, invoice, caseRow: caseRow!, intervention: intervention! };
}

describe('tool idempotency', () => {
  it('a duplicate BullMQ job cannot create a duplicate payment link', async () => {
    const { deps, sentEmails } = makeToolDeps();
    const { caseRow, intervention } = await makeExecutingCase({ type: 'create_payment_link' });

    const r1 = await executeIntervention(db, deps, { caseId: caseRow.id, interventionId: intervention.id, attempt: 1 });
    const r2 = await executeIntervention(db, deps, { caseId: caseRow.id, interventionId: intervention.id, attempt: 1 });
    expect(r1.status).toBe('executed');
    expect(r2.status).toBe('duplicate');
    expect(sentEmails).toHaveLength(1); // one link email, not two

    const execs = await db.select().from(toolExecutions).where(eq(toolExecutions.caseId, caseRow.id));
    expect(execs).toHaveLength(1);
    expect(execs[0]!.idempotencyKey).toBe(`${caseRow.id}:${intervention.id}:1`);
  });

  it('payment link email contains the exact server-resolved amount and case moves to waiting', async () => {
    const { deps, sentEmails } = makeToolDeps();
    const { caseRow, intervention } = await makeExecutingCase({ type: 'create_payment_link' });
    await executeIntervention(db, deps, { caseId: caseRow.id, interventionId: intervention.id, attempt: 1 });

    expect(sentEmails[0]!.body).toContain('₹999.00');
    expect(sentEmails[0]!.body).toContain('https://rzp.io/sbx/');
    const [after] = await db.select().from(recoveryCases).where(eq(recoveryCases.id, caseRow.id));
    expect(after!.state).toBe('waiting');
    expect(after!.recoveryAttemptCount).toBe(1);
  });
});

describe('mandate re-execution safety', () => {
  it('sends the pre-debit notice BEFORE scheduling the execution job', async () => {
    const { deps, scheduled, sentEmails } = makeToolDeps();
    const scheduleAt = new Date(Date.now() + 48 * 3_600_000).toISOString();
    const { caseRow, intervention } = await makeExecutingCase(
      { type: 'schedule_mandate_reexecution', scheduleAt },
      { rail: 'upi_autopay' },
    );
    await executeIntervention(db, deps, { caseId: caseRow.id, interventionId: intervention.id, attempt: 1 });

    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]!.subject).toContain('auto-debit');
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.job.kind).toBe('mandate_execution');

    const notice = await db
      .select()
      .from(communications)
      .where(and(eq(communications.caseId, caseRow.id), eq(communications.templateId, 'pre_debit_notice')));
    expect(notice).toHaveLength(1);
  });

  it('a mandate debit without a pre-debit notice on file is BLOCKED and escalated', async () => {
    const { deps } = makeToolDeps();
    const scheduleAt = new Date(Date.now() + 48 * 3_600_000).toISOString();
    const { caseRow, intervention } = await makeExecutingCase(
      { type: 'schedule_mandate_reexecution', scheduleAt },
      { rail: 'upi_autopay' },
    );
    // simulate a corrupted flow: execution job fires but no notice was ever sent
    const result = await executeScheduledMandateDebit(db, deps, {
      caseId: caseRow.id,
      interventionId: intervention.id,
      attempt: 1,
    });
    expect(result.status).toBe('blocked');
    const [after] = await db.select().from(recoveryCases).where(eq(recoveryCases.id, caseRow.id));
    expect(after!.state).toBe('escalated');
  });

  it('with the notice on file, the sandbox debit captures and emits payment.recovered', async () => {
    const { deps } = makeToolDeps();
    const scheduleAt = new Date(Date.now() + 48 * 3_600_000).toISOString();
    const { caseRow, intervention, invoice } = await makeExecutingCase(
      { type: 'schedule_mandate_reexecution', scheduleAt },
      { rail: 'upi_autopay' },
    );
    await executeIntervention(db, deps, { caseId: caseRow.id, interventionId: intervention.id, attempt: 1 });
    const result = await executeScheduledMandateDebit(db, deps, {
      caseId: caseRow.id,
      interventionId: intervention.id,
      attempt: 1,
    });
    expect(result.status).toBe('executed');
    const rows = await db.select().from(outbox).where(eq(outbox.eventType, 'payment.recovered'));
    const mine = rows.filter((r) => (r.payload as { invoiceId?: string }).invoiceId === invoice.id);
    expect(mine).toHaveLength(1);
    expect((mine[0]!.payload as { via: string }).via).toBe('mandate_execution');
  });
});

describe('other tools', () => {
  it('send_email with lint-violating fills fails and never sends', async () => {
    const { deps, sentEmails } = makeToolDeps();
    const { caseRow, intervention } = await makeExecutingCase({
      type: 'send_email',
      templateId: 'payment_failed_notice',
      language: 'en',
      toneRegister: 'friendly',
      slotFills: { greeting: 'Pay ₹500 now at evil.com' },
    });
    await expect(
      executeIntervention(db, deps, { caseId: caseRow.id, interventionId: intervention.id, attempt: 1 }),
    ).rejects.toThrow(/lint/);
    expect(sentEmails).toHaveLength(0);
    const execs = await db.select().from(toolExecutions).where(eq(toolExecutions.caseId, caseRow.id));
    expect(execs[0]!.status).toBe('failed');
  });

  it('stop_workflow with opt_out suppresses the customer globally', async () => {
    const { deps } = makeToolDeps();
    const { caseRow, intervention, customer } = await makeExecutingCase({ type: 'stop_workflow', reason: 'opt_out' });
    await executeIntervention(db, deps, { caseId: caseRow.id, interventionId: intervention.id, attempt: 1 });
    const [after] = await db.select().from(recoveryCases).where(eq(recoveryCases.id, caseRow.id));
    expect(after!.state).toBe('stopped');
    const [cust] = await db.select().from(customers).where(eq(customers.id, customer.id));
    expect(cust!.optedOut).toBe(true);
  });

  it('record_promise_to_pay stores the promise and parks the case', async () => {
    const { deps } = makeToolDeps();
    const promisedDate = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const { caseRow, intervention } = await makeExecutingCase({
      type: 'record_promise_to_pay',
      promisedDate,
      amountReference: 'the full amount',
    });
    await executeIntervention(db, deps, { caseId: caseRow.id, interventionId: intervention.id, attempt: 1 });
    const promises = await db.select().from(promisesToPay).where(eq(promisesToPay.caseId, caseRow.id));
    expect(promises).toHaveLength(1);
    const [after] = await db.select().from(recoveryCases).where(eq(recoveryCases.id, caseRow.id));
    expect(after!.state).toBe('waiting');
  });

  it('an unapproved intervention cannot execute', async () => {
    const { deps } = makeToolDeps();
    const { caseRow, intervention } = await makeExecutingCase({ type: 'create_payment_link' });
    await db.update(interventions).set({ status: 'proposed' }).where(eq(interventions.id, intervention.id));
    await expect(
      executeIntervention(db, deps, { caseId: caseRow.id, interventionId: intervention.id, attempt: 1 }),
    ).rejects.toThrow(/not executable/);
  });
});
