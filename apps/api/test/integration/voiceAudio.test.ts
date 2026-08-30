import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { db, sql } from '../../src/db/client.js';
import { communications, users, voiceMessages } from '../../src/db/schema.js';
import { buildApp } from '../../src/app.js';
import { signSession } from '../../src/auth/auth.js';
import { seedCase, seedCustomer, seedInvoice } from '../helpers/fixtures.js';

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
const server = createServer(app).listen(0);
const port = (server.address() as AddressInfo).port;

afterAll(async () => {
  server.close();
  await sql.end();
});

const AUDIO = Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x01, 0x02, 0x03]);

async function fixture(withAudio: boolean) {
  const [user] = await db
    .insert(users)
    .values({
      email: `viewer-${Math.random().toString(36).slice(2)}@example.test`,
      name: 'Viewer',
      passwordHash: 'x',
      role: 'viewer',
    })
    .returning();
  const token = signSession({ sub: user!.id, email: user!.email, role: 'viewer' });

  const customer = await seedCustomer(db);
  const invoice = await seedInvoice(db, customer.id);
  const caseRow = await seedCase(db, customer.id, invoice.id, { state: 'waiting' });
  const [comm] = await db
    .insert(communications)
    .values({
      caseId: caseRow.id,
      customerId: customer.id,
      direction: 'outbound',
      channel: withAudio ? 'whatsapp_voice' : 'email',
      renderedBody: 'body',
    })
    .returning();
  if (withAudio) {
    await db.insert(voiceMessages).values({
      communicationId: comm!.id,
      mimeType: 'audio/ogg',
      audio: AUDIO,
    });
  }
  return { token, caseId: caseRow.id, commId: comm!.id };
}

function audioUrl(caseId: string, commId: string, query = ''): string {
  return `http://127.0.0.1:${port}/recovery/cases/${caseId}/communications/${commId}/audio${query}`;
}

describe('GET /recovery/cases/:caseId/communications/:id/audio', () => {
  it('returns the stored bytes with the stored content type', async () => {
    const { token, caseId, commId } = await fixture(true);
    const res = await fetch(audioUrl(caseId, commId), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('audio/ogg');
    expect(Buffer.from(await res.arrayBuffer()).equals(AUDIO)).toBe(true);
  });

  it('401s without a token', async () => {
    const { caseId, commId } = await fixture(true);
    const res = await fetch(audioUrl(caseId, commId));
    expect(res.status).toBe(401);
  });

  it('does NOT accept a token in the query string', async () => {
    // A credential in a URL is written to access logs, browser history and
    // Referer headers. The browser fetches these bytes with the normal
    // authenticated client and plays them from a blob URL instead.
    const { token, caseId, commId } = await fixture(true);
    const res = await fetch(audioUrl(caseId, commId, `?token=${encodeURIComponent(token)}`));
    expect(res.status).toBe(401);
  });

  it('404s for a communication with no audio', async () => {
    const { token, caseId, commId } = await fixture(false);
    const res = await fetch(audioUrl(caseId, commId), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  it('404s when the communication belongs to a different case', async () => {
    const { token, commId } = await fixture(true);
    const other = await fixture(true);
    const res = await fetch(audioUrl(other.caseId, commId), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });
});
