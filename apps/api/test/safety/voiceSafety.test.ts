import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { ActionParams } from '@reclaim/shared';
import { db, sql } from '../../src/db/client.js';
import {
  auditEvents,
  communications,
  customers,
  interventions,
  voiceMessages,
} from '../../src/db/schema.js';
import { executeIntervention, type ToolDeps } from '../../src/tools/execute.js';
import { SandboxPaymentProvider } from '../../src/payments/sandboxAdapter.js';
import { MockSynthesizer } from '../../src/voice/index.js';
import { MockWhatsAppSender } from '../../src/whatsapp/index.js';
import { seedCase, seedCustomer, seedInvoice } from '../helpers/fixtures.js';

afterAll(async () => {
  await sql.end();
});

const ACTION: ActionParams = {
  type: 'send_email',
  templateId: 'payment_reminder',
  language: 'en',
  toneRegister: 'friendly',
  slotFills: {
    greeting: 'Hello Priya,',
    context_sentence: 'We wanted to check in about your invoice.',
    sign_off: 'Thank you, the billing team.',
  },
};

function makeDeps(overrides: Partial<ToolDeps['voice']> = {}) {
  const sentEmails: string[] = [];
  const whatsapp = new MockWhatsAppSender();
  const deps: ToolDeps = {
    provider: new SandboxPaymentProvider(),
    mailer: {
      name: 'test',
      send: async (msg) => {
        sentEmails.push(msg.to.email);
        return { providerMessageId: `test_${randomUUID().slice(0, 8)}` };
      },
    },
    enqueueScheduled: async () => {},
    enqueueAgent: async () => {},
    voice: { synthesizer: new MockSynthesizer(), whatsapp, whatsappMode: 'mock', ...overrides },
  };
  return { deps, sentEmails, whatsapp };
}

async function makeCase(overrides: Partial<typeof customers.$inferInsert> = {}) {
  const customer = await seedCustomer(db, {
    phone: `+9198${Math.floor(Math.random() * 100_000_000)}`,
    whatsappConsent: true,
    ...overrides,
  });
  const invoice = await seedInvoice(db, customer.id);
  const caseRow = await seedCase(db, customer.id, invoice.id);
  const [intervention] = await db
    .insert(interventions)
    .values({
      caseId: caseRow.id,
      actionType: 'send_email',
      params: ACTION,
      proposedBy: 'agent',
      status: 'approved',
    })
    .returning();
  return { customer, invoice, caseRow, intervention: intervention! };
}

async function auditTypes(caseId: string): Promise<string[]> {
  const rows = await db.select().from(auditEvents).where(eq(auditEvents.caseId, caseId));
  return rows.map((r) => r.eventType);
}

async function skipReasonFor(caseId: string): Promise<string | undefined> {
  const rows = await db.select().from(auditEvents).where(eq(auditEvents.caseId, caseId));
  const skipped = rows.find((r) => r.eventType === 'voice.skipped');
  return skipped ? (skipped.payload as { reason: string }).reason : undefined;
}

describe('voice delivery is best-effort', () => {
  it('a throwing synthesizer leaves the email sent exactly once and the tool successful', async () => {
    // THE regression guard. If this ever throws out of executeIntervention,
    // BullMQ retries, runTool re-runs from the top, and mailer.send() fires a
    // second time — commit 08fb3a9 all over again.
    const { deps, sentEmails } = makeDeps({
      synthesizer: {
        name: 'exploding',
        speak: async () => {
          throw new Error('sarvam timeout');
        },
      },
    });
    const { caseRow, intervention } = await makeCase();

    const result = await executeIntervention(db, deps, {
      caseId: caseRow.id,
      interventionId: intervention.id,
      attempt: 1,
    });

    expect(result.status).toBe('executed');
    expect(sentEmails).toHaveLength(1);

    const [fresh] = await db.select().from(interventions).where(eq(interventions.id, intervention.id));
    expect(fresh!.status).toBe('executed');

    expect(await auditTypes(caseRow.id)).toContain('voice.failed');

    const comms = await db.select().from(communications).where(eq(communications.caseId, caseRow.id));
    expect(comms.filter((c) => c.channel === 'email')).toHaveLength(1);
    expect(comms.filter((c) => c.channel === 'whatsapp_voice')).toHaveLength(0);
  });

  it('a throwing WhatsApp sender is equally harmless', async () => {
    const { deps, sentEmails } = makeDeps({
      whatsapp: {
        name: 'exploding',
        sendVoice: async () => {
          throw new Error('whatsapp send failed: 400 {"error":{"code":131047}}');
        },
      },
    });
    const { caseRow, intervention } = await makeCase();
    const result = await executeIntervention(db, deps, {
      caseId: caseRow.id,
      interventionId: intervention.id,
      attempt: 1,
    });
    expect(result.status).toBe('executed');
    expect(sentEmails).toHaveLength(1);
    expect(await auditTypes(caseRow.id)).toContain('voice.failed');
  });

  it('sends a voice note alongside the email on the happy path', async () => {
    const { deps, whatsapp } = makeDeps();
    const { caseRow, intervention } = await makeCase();
    await executeIntervention(db, deps, {
      caseId: caseRow.id,
      interventionId: intervention.id,
      attempt: 1,
    });

    const comms = await db.select().from(communications).where(eq(communications.caseId, caseRow.id));
    expect(comms.filter((c) => c.channel === 'email')).toHaveLength(1);
    const voice = comms.filter((c) => c.channel === 'whatsapp_voice');
    expect(voice).toHaveLength(1);
    expect(voice[0]!.renderedSubject).toBeNull(); // a voice note has no subject
    expect(voice[0]!.renderedBody).toContain('rupees'); // the spoken amount
    expect(voice[0]!.renderedBody).not.toContain('₹');
    expect(voice[0]!.renderedBody).not.toContain('http');

    const [audio] = await db
      .select()
      .from(voiceMessages)
      .where(eq(voiceMessages.communicationId, voice[0]!.id));
    expect(audio!.audio.length).toBeGreaterThan(0);
    expect(whatsapp.sent).toHaveLength(1);
  });

  it('mock mode records the send as undelivered', async () => {
    const { deps } = makeDeps();
    const { caseRow, intervention } = await makeCase();
    await executeIntervention(db, deps, {
      caseId: caseRow.id,
      interventionId: intervention.id,
      attempt: 1,
    });
    const [voice] = await db
      .select()
      .from(communications)
      .where(and(eq(communications.caseId, caseRow.id), eq(communications.channel, 'whatsapp_voice')));
    expect((voice!.consentSnapshot as { delivered: boolean }).delivered).toBe(false);
  });
});

describe('voice delivery skips, audibly', () => {
  const cases: Array<[string, Partial<typeof customers.$inferInsert>, string]> = [
    ['no phone on file', { phone: null }, 'no_phone'],
    ['whatsapp consent not given', { whatsappConsent: false }, 'no_consent'],
    ['customer opted out', { optedOut: true }, 'opted_out'],
  ];

  for (const [label, overrides, reason] of cases) {
    it(`${label} → email only, plus a voice.skipped audit event`, async () => {
      const { deps, sentEmails, whatsapp } = makeDeps();
      const { caseRow, intervention } = await makeCase(overrides);
      await executeIntervention(db, deps, {
        caseId: caseRow.id,
        interventionId: intervention.id,
        attempt: 1,
      });

      expect(sentEmails).toHaveLength(1);
      expect(whatsapp.sent).toHaveLength(0);
      const comms = await db.select().from(communications).where(eq(communications.caseId, caseRow.id));
      expect(comms.filter((c) => c.channel === 'whatsapp_voice')).toHaveLength(0);
      expect(await skipReasonFor(caseRow.id), `expected a skip for ${label}`).toBe(reason);
    });
  }

  it('a closed 24-hour window skips in live mode but not in mock', async () => {
    const { deps: liveDeps, whatsapp: liveWa } = makeDeps({ whatsappMode: 'live' });
    const live = await makeCase();
    await executeIntervention(db, liveDeps, {
      caseId: live.caseRow.id,
      interventionId: live.intervention.id,
      attempt: 1,
    });
    expect(liveWa.sent).toHaveLength(0);
    expect(await skipReasonFor(live.caseRow.id)).toBe('window_closed');

    // mock mode bypasses the check so the console always has audio to show
    const { deps: mockDeps, whatsapp: mockWa } = makeDeps();
    const mock = await makeCase();
    await executeIntervention(db, mockDeps, {
      caseId: mock.caseRow.id,
      interventionId: mock.intervention.id,
      attempt: 1,
    });
    expect(mockWa.sent).toHaveLength(1);
  });
});
