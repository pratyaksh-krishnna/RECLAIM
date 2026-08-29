import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sql } from '../../src/db/client.js';
import { communications, customers, outbox, recoveryCases } from '../../src/db/schema.js';
import { buildApp } from '../../src/app.js';
import { signPayload } from '../../src/ingest/verifySignature.js';
import { InProcessRuntime } from '../../src/runtime/inProcessRuntime.js';
import { FakeLlmClient } from '../helpers/fakeLlm.js';
import { SandboxPaymentProvider } from '../../src/payments/sandboxAdapter.js';
import { runAgentJob } from '../../src/agents/runner.js';
import { seedCase, seedCustomer, seedInvoice } from '../helpers/fixtures.js';

const APP_SECRET = 'test-app-secret'; // matches vitest.config.ts
const app = buildApp({ db, webhookSecret: 'whsec_test_secret', enqueueNormalize: async () => {} });
const server = createServer(app).listen(0);
const port = (server.address() as AddressInfo).port;

afterAll(async () => {
  server.close();
  await sql.end();
});

function metaPayload(from: string, text: string) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              messages: [
                { from, id: `wamid.${Math.random().toString(36).slice(2)}`, type: 'text', text: { body: text } },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function post(body: unknown, opts: { sign?: boolean | string } = { sign: true }) {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.sign === true) headers['x-hub-signature-256'] = `sha256=${signPayload(raw, APP_SECRET)}`;
  else if (typeof opts.sign === 'string') headers['x-hub-signature-256'] = opts.sign;
  return fetch(`http://127.0.0.1:${port}/webhooks/whatsapp`, { method: 'POST', headers, body: raw });
}

function randomPhone(): string {
  return `+9198${Math.floor(Math.random() * 100_000_000)}`;
}

async function openCaseFor(phone: string) {
  const customer = await seedCustomer(db, { phone, whatsappConsent: true });
  const invoice = await seedInvoice(db, customer.id);
  const caseRow = await seedCase(db, customer.id, invoice.id, { state: 'waiting' });
  return { customer, caseRow };
}

describe('GET /webhooks/whatsapp — Meta subscription challenge', () => {
  it('echoes the challenge when the verify token matches', async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=31337`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('31337');
  });

  it('refuses a wrong verify token', async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=31337`,
    );
    expect(res.status).toBe(403);
  });
});

describe('POST /webhooks/whatsapp — inbound text', () => {
  it('rejects an unsigned request before writing anything', async () => {
    const phone = randomPhone();
    const { caseRow } = await openCaseFor(phone);
    const res = await post(metaPayload(phone.slice(1), 'I will pay tomorrow'), { sign: false });
    expect(res.status).toBe(401);
    const comms = await db.select().from(communications).where(eq(communications.caseId, caseRow.id));
    expect(comms).toHaveLength(0);
  });

  it('rejects a wrongly-signed request', async () => {
    const phone = randomPhone();
    await openCaseFor(phone);
    const res = await post(metaPayload(phone.slice(1), 'hello'), { sign: 'sha256=deadbeef' });
    expect(res.status).toBe(401);
  });

  it('resolves by phone, writes a whatsapp_text row, and emits customer.responded', async () => {
    const phone = randomPhone();
    const { customer, caseRow } = await openCaseFor(phone);
    const res = await post(metaPayload(phone.slice(1), 'I will pay on Friday'));
    expect(res.status).toBe(200);

    const [comm] = await db.select().from(communications).where(eq(communications.caseId, caseRow.id));
    expect(comm!.direction).toBe('inbound');
    expect(comm!.channel).toBe('whatsapp_text');
    expect(comm!.renderedBody).toBe('I will pay on Friday');
    expect(comm!.customerId).toBe(customer.id);
    expect(comm!.sentAt).not.toBeNull(); // the window check reads sentAt

    const events = await db.select().from(outbox);
    const responded = events.filter(
      (e) =>
        e.eventType === 'customer.responded' &&
        (e.payload as { caseId: string }).caseId === caseRow.id,
    );
    expect(responded).toHaveLength(1);
  });

  it('matches a number sent without the leading +', async () => {
    const phone = randomPhone();
    const { caseRow } = await openCaseFor(phone);
    await post(metaPayload(phone.slice(1), 'ok'));
    const comms = await db.select().from(communications).where(eq(communications.caseId, caseRow.id));
    expect(comms).toHaveLength(1);
  });

  it('acknowledges a delivery-status callback without writing a communication', async () => {
    // Meta posts statuses to the same URL. They are not customer messages and
    // must not open a 24-hour window.
    const before = await db.select().from(communications);
    const res = await post({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ field: 'messages', value: { statuses: [{ status: 'delivered' }] } }] }],
    });
    expect(res.status).toBe(200);
    const after = await db.select().from(communications);
    expect(after).toHaveLength(before.length);
  });

  it('200s for an unknown number so Meta does not retry forever', async () => {
    const res = await post(metaPayload('919999999999', 'who is this'));
    expect(res.status).toBe(200);
  });
});

describe('opt-out arriving over WhatsApp', () => {
  it('suppresses every channel, not just the next voice note', async () => {
    const phone = randomPhone();
    const { customer, caseRow } = await openCaseFor(phone);
    const res = await post(metaPayload(phone.slice(1), 'STOP'));
    expect(res.status).toBe(200);
    const { communicationId } = (await res.json()) as { communicationId: string };

    // The webhook only records and emits; the interpreter is what classifies.
    const runtime = new InProcessRuntime(db, {
      llm: new FakeLlmClient(),
      provider: new SandboxPaymentProvider(),
      mailer: { name: 'test', send: async () => ({ providerMessageId: 'noop' }) },
    });
    await runAgentJob(db, runtime.agentDeps, {
      caseId: caseRow.id,
      agent: 'reply_interpreter',
      communicationId,
    });

    // optedOut is global: execute.ts sets it on the customer, not per channel,
    // so the email path is suppressed too. Per-channel suppression was
    // considered and rejected — it cannot under-suppress this way.
    const [fresh] = await db.select().from(customers).where(eq(customers.id, customer.id));
    expect(fresh!.optedOut).toBe(true);

    const [freshCase] = await db.select().from(recoveryCases).where(eq(recoveryCases.id, caseRow.id));
    expect(freshCase!.state).toBe('stopped');
  });
});
