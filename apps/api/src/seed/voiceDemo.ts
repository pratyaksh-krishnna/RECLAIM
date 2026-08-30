/**
 * TEMPORARY: put one executed send_email (and therefore one voice note) into
 * the demo database without replaying the whole population, which needs five
 * sequential model calls per case.
 *
 * Uses the real tool path — same executeIntervention, same deliverVoiceNote,
 * same mock synthesizer and sender the API runs with.
 */
import { and, eq, isNotNull } from 'drizzle-orm';
import { db, sql } from '../db/client.js';
import { customers, interventions, invoices, recoveryCases } from '../db/schema.js';
import { executeIntervention, type ToolDeps } from '../tools/execute.js';
import { getMailer } from '../mailer/index.js';
import { SandboxPaymentProvider } from '../payments/sandboxAdapter.js';
import { getVoiceSynthesizer } from '../voice/index.js';
import { getWhatsAppSender } from '../whatsapp/index.js';
import { env } from '../config/env.js';

const ACTION = {
  type: 'send_email' as const,
  templateId: 'payment_reminder' as const,
  language: 'en' as const,
  toneRegister: 'friendly' as const,
  slotFills: {
    greeting: 'Hello Priya,',
    context_sentence:
      'We know things get busy, so this is just a gentle nudge about an invoice that is still open.',
    sign_off: 'Thank you, the billing team.',
  },
};

const deps: ToolDeps = {
  provider: new SandboxPaymentProvider(),
  mailer: getMailer(),
  enqueueScheduled: async () => {},
  enqueueAgent: async () => {},
  voice: {
    synthesizer: getVoiceSynthesizer(),
    whatsapp: getWhatsAppSender(),
    whatsappMode: env.WHATSAPP_MODE,
  },
};

const [customer] = await db
  .select()
  .from(customers)
  .where(and(isNotNull(customers.phone), eq(customers.whatsappConsent, true)))
  .limit(1);
if (!customer) throw new Error('no customer with a phone — run `pnpm seed` first');

const [invoice] = await db
  .select()
  .from(invoices)
  .where(eq(invoices.customerId, customer.id))
  .limit(1);
if (!invoice) throw new Error('that customer has no invoice');

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
  .values({
    caseId: caseRow!.id,
    actionType: 'send_email',
    params: ACTION,
    proposedBy: 'agent',
    status: 'approved',
  })
  .returning();

const result = await executeIntervention(db, deps, {
  caseId: caseRow!.id,
  interventionId: intervention!.id,
  attempt: 1,
});

console.log(`\n${result.status}  voice=${env.VOICE_MODE}  whatsapp=${env.WHATSAPP_MODE}`);
console.log(`open  →  http://localhost:5173/cases/${caseRow!.id}\n`);
await sql.end();
