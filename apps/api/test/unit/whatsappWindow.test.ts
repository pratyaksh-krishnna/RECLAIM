import { afterAll, describe, expect, it } from 'vitest';
import { db, sql } from '../../src/db/client.js';
import { communications } from '../../src/db/schema.js';
import { isWhatsAppWindowOpen } from '../../src/whatsapp/index.js';
import { seedCase, seedCustomer, seedInvoice } from '../helpers/fixtures.js';

afterAll(async () => {
  await sql.end();
});

const NOW = new Date('2026-08-29T12:00:00Z');

async function openCase() {
  const customer = await seedCustomer(db);
  const invoice = await seedInvoice(db, customer.id);
  const caseRow = await seedCase(db, customer.id, invoice.id);
  return { customer, caseRow };
}

async function inbound(
  caseId: string,
  customerId: string,
  sentAt: Date,
  channel: 'email' | 'whatsapp_text',
) {
  await db.insert(communications).values({
    caseId,
    customerId,
    direction: 'inbound',
    channel,
    renderedBody: 'ok',
    sentAt,
  });
}

describe('isWhatsAppWindowOpen', () => {
  it('is closed when the customer has never written', async () => {
    const c = await seedCustomer(db);
    expect(await isWhatsAppWindowOpen(db, c.id, NOW)).toBe(false);
  });

  it('is open at 23h59m', async () => {
    const { customer, caseRow } = await openCase();
    await inbound(
      caseRow.id,
      customer.id,
      new Date(NOW.getTime() - 23 * 3_600_000 - 59 * 60_000),
      'whatsapp_text',
    );
    expect(await isWhatsAppWindowOpen(db, customer.id, NOW)).toBe(true);
  });

  it('is closed at 24h01m', async () => {
    const { customer, caseRow } = await openCase();
    await inbound(
      caseRow.id,
      customer.id,
      new Date(NOW.getTime() - 24 * 3_600_000 - 60_000),
      'whatsapp_text',
    );
    expect(await isWhatsAppWindowOpen(db, customer.id, NOW)).toBe(false);
  });

  it('an inbound EMAIL does not open a WhatsApp window', async () => {
    const { customer, caseRow } = await openCase();
    await inbound(caseRow.id, customer.id, new Date(NOW.getTime() - 60_000), 'email');
    expect(await isWhatsAppWindowOpen(db, customer.id, NOW)).toBe(false);
  });

  it('an OUTBOUND whatsapp_voice does not open a window', async () => {
    const { customer, caseRow } = await openCase();
    await db.insert(communications).values({
      caseId: caseRow.id,
      customerId: customer.id,
      direction: 'outbound',
      channel: 'whatsapp_voice',
      renderedBody: 'spoken',
      sentAt: new Date(NOW.getTime() - 60_000),
    });
    expect(await isWhatsAppWindowOpen(db, customer.id, NOW)).toBe(false);
  });
});
