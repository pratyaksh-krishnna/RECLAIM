import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sql } from '../../src/db/client.js';
import { failureEvents, invoices, outbox, webhookInbox } from '../../src/db/schema.js';
import { buildApp } from '../../src/app.js';
import { signPayload } from '../../src/ingest/verifySignature.js';
import { processInboxRow } from '../../src/ingest/normalizeWorker.js';
import { relayOutboxOnce } from '../../src/ingest/outboxRelay.js';
import { scanOverdueOnce } from '../../src/ingest/overdueScanner.js';
import { seedCustomer, seedInvoice } from '../helpers/fixtures.js';

const SECRET = 'whsec_test_secret';
const enqueued: string[] = [];
const app = buildApp({
  db,
  webhookSecret: SECRET,
  enqueueNormalize: async (id) => {
    enqueued.push(id);
  },
});
const server = createServer(app).listen(0);
const port = (server.address() as AddressInfo).port;

async function postWebhook(body: string, headers: Record<string, string> = {}) {
  return fetch(`http://127.0.0.1:${port}/webhooks/razorpay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

afterAll(async () => {
  server.close();
  await sql.end();
});

describe('webhook ingestion', () => {
  it('rejects an invalid signature before parsing', async () => {
    const res = await postWebhook('{not even json', { 'x-razorpay-signature': 'bogus' });
    expect(res.status).toBe(401);
  });

  it('accepts a valid signature and dedupes duplicate provider event ids', async () => {
    const body = JSON.stringify({ event: 'payment.failed', payload: {} });
    const sig = signPayload(body, SECRET);
    const eid = `evt_dedupe_${Date.now()}`;
    const h = { 'x-razorpay-signature': sig, 'x-razorpay-event-id': eid };

    const r1 = await postWebhook(body, h);
    const r2 = await postWebhook(body, h);
    expect(r1.status).toBe(200);
    expect(((await r1.json()) as { duplicate: boolean }).duplicate).toBe(false);
    expect(((await r2.json()) as { duplicate: boolean }).duplicate).toBe(true);

    const rows = await db.select().from(webhookInbox).where(eq(webhookInbox.providerEventId, eid));
    expect(rows).toHaveLength(1);
  });
});

describe('normalizer', () => {
  it('maps payment.failed to canonical event + failure_event row, idempotently', async () => {
    const customer = await seedCustomer(db);
    const invoice = await seedInvoice(db, customer.id);

    const body = JSON.stringify({
      event: 'payment.failed',
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        payment: {
          entity: {
            id: 'pay_test001',
            invoice_id: invoice.providerInvoiceId,
            amount: invoice.amountDuePaise,
            method: 'card',
            error_reason: 'insufficient_funds',
          },
        },
      },
    });
    const eid = `evt_pf_${Date.now()}`;
    await postWebhook(body, { 'x-razorpay-signature': signPayload(body, SECRET), 'x-razorpay-event-id': eid });

    const [inboxRow] = await db.select().from(webhookInbox).where(eq(webhookInbox.providerEventId, eid));
    expect(inboxRow).toBeDefined();
    await processInboxRow(db, inboxRow!.id);
    await processInboxRow(db, inboxRow!.id); // replay must be a no-op

    const fes = await db.select().from(failureEvents).where(eq(failureEvents.invoiceId, invoice.id));
    expect(fes).toHaveLength(1);
    expect(fes[0]!.declineClass).toBe('soft');

    const outboxRows = await db.select().from(outbox).where(eq(outbox.eventType, 'payment.failed'));
    const mine = outboxRows.filter(
      (r) => (r.payload as { invoiceId?: string }).invoiceId === invoice.id,
    );
    expect(mine).toHaveLength(1);
  });
});

describe('overdue scanner', () => {
  it('transitions open→overdue exactly once and emits invoice.overdue', async () => {
    const customer = await seedCustomer(db);
    const invoice = await seedInvoice(db, customer.id, { dueDate: new Date('2026-07-01T00:00:00Z') });

    const first = await scanOverdueOnce(db, () => new Date('2026-08-21T10:00:00Z'));
    expect(first).toBeGreaterThanOrEqual(1);
    const second = await scanOverdueOnce(db, () => new Date('2026-08-21T10:00:00Z'));
    expect(second).toBe(0);

    const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoice.id));
    expect(inv!.status).toBe('overdue');

    const events = await db.select().from(outbox).where(eq(outbox.eventType, 'invoice.overdue'));
    const mine = events.filter((r) => (r.payload as { invoiceId?: string }).invoiceId === invoice.id);
    expect(mine).toHaveLength(1);
    expect((mine[0]!.payload as { daysOverdue: number }).daysOverdue).toBe(51);
  });
});

describe('outbox relay', () => {
  it('publishes unprocessed rows once and marks them processed', async () => {
    const published: string[] = [];
    const n1 = await relayOutboxOnce(db, {
      publish: async (id) => {
        published.push(id);
      },
    });
    expect(n1).toBeGreaterThanOrEqual(1);
    const n2 = await relayOutboxOnce(db, { publish: async () => {} });
    expect(n2).toBe(0);
    expect(new Set(published).size).toBe(published.length);
  });
});
