import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sql } from '../../src/db/client.js';
import { communications, voiceMessages } from '../../src/db/schema.js';
import { seedCase, seedCustomer, seedInvoice } from '../helpers/fixtures.js';

afterAll(async () => {
  await sql.end();
});

describe('voice schema', () => {
  it('defaults whatsappConsent to false, so no customer is opted in by the migration', async () => {
    const customer = await seedCustomer(db);
    expect(customer.whatsappConsent).toBe(false);
    expect(customer.phone).toBeNull();
  });

  it('refuses two customers sharing a phone number', async () => {
    const phone = `+9198${Math.floor(Math.random() * 100_000_000)}`;
    await seedCustomer(db, { phone });
    // customers.email is unique for exactly this reason — a reply resolved to
    // whichever row Postgres returned first and an opt-out landed on a stale
    // closed case. The inbound WhatsApp hook resolves by phone, so phone
    // carries the same constraint.
    await expect(seedCustomer(db, { phone })).rejects.toThrow();
  });

  it('allows many customers with no phone at all', async () => {
    await seedCustomer(db, {});
    await expect(seedCustomer(db, {})).resolves.toBeTruthy();
  });

  it('stores and reads back audio bytes intact', async () => {
    const customer = await seedCustomer(db);
    const invoice = await seedInvoice(db, customer.id);
    const caseRow = await seedCase(db, customer.id, invoice.id);
    const [comm] = await db
      .insert(communications)
      .values({
        caseId: caseRow.id,
        customerId: customer.id,
        direction: 'outbound',
        channel: 'whatsapp_voice',
        renderedBody: 'spoken script',
      })
      .returning();

    const bytes = Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0xff]);
    await db.insert(voiceMessages).values({
      communicationId: comm!.id,
      mimeType: 'audio/ogg',
      audio: bytes,
      durationMs: 14_000,
      sarvamRequestId: `req_${randomUUID().slice(0, 8)}`,
    });

    const [stored] = await db
      .select()
      .from(voiceMessages)
      .where(eq(voiceMessages.communicationId, comm!.id));
    expect(Buffer.from(stored!.audio).equals(bytes)).toBe(true);
    expect(stored!.mimeType).toBe('audio/ogg');
  });

  it('permits at most one voice_messages row per communication', async () => {
    const customer = await seedCustomer(db);
    const invoice = await seedInvoice(db, customer.id);
    const caseRow = await seedCase(db, customer.id, invoice.id);
    const [comm] = await db
      .insert(communications)
      .values({
        caseId: caseRow.id,
        customerId: customer.id,
        direction: 'outbound',
        channel: 'whatsapp_voice',
        renderedBody: 'x',
      })
      .returning();
    const row = { communicationId: comm!.id, mimeType: 'audio/ogg', audio: Buffer.from('a') };
    await db.insert(voiceMessages).values(row);
    await expect(db.insert(voiceMessages).values(row)).rejects.toThrow();
  });
});
