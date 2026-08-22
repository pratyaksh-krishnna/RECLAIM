import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sql } from '../../src/db/client.js';
import { recoveryCases } from '../../src/db/schema.js';
import { buildApp } from '../../src/app.js';
import { signSession } from '../../src/auth/auth.js';
import { ensureSeedPolicy, evaluateAndPersistPolicy } from '../../src/policy/service.js';
import { lockCase } from '../../src/orchestrator/caseService.js';
import { interventions } from '../../src/db/schema.js';
import { seedCustomer, seedInvoice } from '../helpers/fixtures.js';

/**
 * The dispute freeze is the one control a human must be able to lift, and the
 * one an agent must never reach. recovery_cases.dispute_resolved_by_user_id
 * shipped unwritten: a disputed case was frozen forever because policy reads
 * disputed_at (durably, by design) and nothing could clear it.
 */

let server: Server;
let base: string;

beforeAll(async () => {
  await ensureSeedPolicy(db);
  const app = buildApp({
    db,
    webhookSecret: 'whsec_test_secret',
    enqueueNormalize: async () => {},
    orchestrator: {
      enqueueAgent: async () => {},
      enqueueCaseStep: async () => {},
      enqueueTool: async () => {},
    },
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await sql.end();
});

const tokenFor = (role: 'admin' | 'operator' | 'viewer') =>
  signSession({ sub: randomUUID(), email: `${role}@reclaim.test`, role });

async function seedDisputedCase(exposurePaise = 149_900) {
  const customer = await seedCustomer(db, { name: `Disputer ${randomUUID().slice(0, 6)}` });
  const invoice = await seedInvoice(db, customer.id, { amountDuePaise: exposurePaise });
  const [row] = await db
    .insert(recoveryCases)
    .values({
      customerId: customer.id,
      invoiceId: invoice.id,
      state: 'disputed',
      leakType: 'subscription_payment_failure',
      exposurePaise,
      holdoutArm: 'treatment',
      attributionWindowEndsAt: new Date('2026-12-01T00:00:00Z'),
      disputedAt: new Date('2026-08-20T00:00:00Z'),
      causeHypothesis: 'invoice_dispute_suspected',
    })
    .returning();
  if (!row) throw new Error('seed failed');
  return { caseRow: row, customer, invoice };
}

const resolve = (caseId: string, role: 'admin' | 'operator' | 'viewer', body: unknown) =>
  fetch(`${base}/recovery/cases/${caseId}/resolve-dispute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenFor(role)}` },
    body: JSON.stringify(body),
  });

/** propose an email and ask the real policy engine for a verdict */
async function policyVerdictForEmail(caseId: string) {
  // a case may hold only one open intervention, so close any prior probe first
  await db
    .update(interventions)
    .set({ status: 'cancelled' })
    .where(eq(interventions.caseId, caseId));
  const [proposal] = await db
    .insert(interventions)
    .values({
      caseId,
      actionType: 'send_email',
      params: { type: 'send_email', templateId: 'payment_reminder', language: 'en', toneRegister: 'formal', slotFills: {} },
      proposedBy: 'human',
      status: 'proposed',
      rationale: 'test',
      stopConditions: ['paid'],
    })
    .returning();
  return db.transaction(async (tx) => {
    const locked = await lockCase(tx, caseId);
    return evaluateAndPersistPolicy(tx, locked!, proposal!.id);
  });
}

describe('dispute resolution — the only way to lift a compliance freeze', () => {
  it('refuses a non-admin', async () => {
    const { caseRow } = await seedDisputedCase();
    const res = await resolve(caseRow.id, 'operator', { outcome: 'rejected', reason: 'chargeback failed at the bank' });
    expect(res.status).toBe(403);

    const [after] = await db.select().from(recoveryCases).where(eq(recoveryCases.id, caseRow.id));
    expect(after!.disputedAt, 'an operator must not be able to unfreeze a dispute').not.toBeNull();
  });

  it('requires a written reason', async () => {
    const { caseRow } = await seedDisputedCase();
    const res = await resolve(caseRow.id, 'admin', { outcome: 'rejected', reason: 'nope' });
    expect(res.status).toBe(400);
  });

  it('rejected: lifts the freeze, records who did it, and lets recovery resume', async () => {
    const { caseRow } = await seedDisputedCase();
    // before: the freeze denies outreach
    expect((await policyVerdictForEmail(caseRow.id)).verdict).toBe('DENY');

    const res = await resolve(caseRow.id, 'admin', {
      outcome: 'rejected',
      reason: 'bank ruled in our favour; chargeback reversed',
    });
    expect(res.status).toBe(200);

    const [after] = await db.select().from(recoveryCases).where(eq(recoveryCases.id, caseRow.id));
    expect(after!.disputedAt).toBeNull();
    expect(after!.disputeResolvedByUserId, 'the resolver must be recorded').not.toBeNull();
    expect(after!.state).toBe('re_evaluating');
    // The freeze is genuinely lifted, not just visually cleared. Other DENY
    // reasons (quiet hours, contact budget) are legitimate and orthogonal —
    // what must no longer hold is a denial BECAUSE OF the dispute.
    const after2 = await policyVerdictForEmail(caseRow.id);
    expect(after2.reason ?? '', `verdict=${after2.verdict} reason=${after2.reason}`).not.toMatch(/dispute/i);
  });

  it('upheld: stops the case and keeps the dispute on record', async () => {
    const { caseRow } = await seedDisputedCase();
    const res = await resolve(caseRow.id, 'admin', {
      outcome: 'upheld',
      reason: 'charge was not authorised; writing it off',
    });
    expect(res.status).toBe(200);

    const [after] = await db.select().from(recoveryCases).where(eq(recoveryCases.id, caseRow.id));
    expect(after!.state).toBe('stopped');
    expect(after!.stopReason).toBe('dispute');
    // history is not tidied away — the case was disputed and stays so on record
    expect(after!.disputedAt).not.toBeNull();
    expect(after!.disputeResolvedByUserId).not.toBeNull();
  });

  it('refuses a case with no open dispute', async () => {
    const { caseRow } = await seedDisputedCase();
    await db.update(recoveryCases).set({ disputedAt: null }).where(eq(recoveryCases.id, caseRow.id));
    const res = await resolve(caseRow.id, 'admin', { outcome: 'rejected', reason: 'there is nothing to resolve here' });
    expect(res.status).toBe(409);
  });
});
