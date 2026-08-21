import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql as dsql } from 'drizzle-orm';
import { db, sql } from '../db/client.js';
import { env } from '../config/env.js';
import { communications, invoices, recoveryCases } from '../db/schema.js';
import { signPayload } from '../ingest/verifySignature.js';
import { scanOverdueOnce } from '../ingest/overdueScanner.js';
import { mulberry32 } from './generator.js';
import { policyRules } from '../db/schema.js';
import { getActivePolicy } from '../policy/service.js';
import { desc } from 'drizzle-orm';

/**
 * `pnpm replay` — feeds the seeded events through the LIVE webhook path
 * (HMAC-signed HTTP posts against the running API), opens B2B overdue cases
 * via the scanner, delivers scripted customer replies, then simulates
 * customer payment outcomes at different rates for treatment vs holdout so
 * the Experiments screen has a real incremental story.
 *
 * Requires: `pnpm dev` (or start) running with Postgres + Redis up.
 */

const API = process.env['REPLAY_API_URL'] ?? `http://localhost:${env.API_PORT}`;
const SECRET = env.RAZORPAY_WEBHOOK_SECRET;
const rng = mulberry32(777);

interface ReplayFile {
  events: Array<{ kind: 'webhook' | 'inbound_email'; afterMs: number; eventId?: string; body: unknown; meta: { scenario: string; customerEmail: string; invoiceId: string } }>;
}

const istHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
{
  const { config, version } = await getActivePolicy(db);
  const { startHour, endHour } = config.quietHours;
  const inQuiet = startHour > endHour ? istHour >= startHour || istHour < endHour : istHour >= startHour && istHour < endHour;
  if (inQuiet && process.env['REPLAY_KEEP_QUIET_HOURS'] !== 'true') {
    // Use the real versioned-policy mechanism (visible in Policy Studio history)
    // to move the quiet window away from the demo run.
    const newQuiet = { startHour: (istHour + 6) % 24, endHour: (istHour + 8) % 24 };
    await db.transaction(async (tx) => {
      const [latest] = await tx.select().from(policyRules).orderBy(desc(policyRules.version)).limit(1);
      await tx.update(policyRules).set({ active: false });
      await tx.insert(policyRules).values({
        version: (latest?.version ?? version) + 1,
        config: { ...config, quietHours: newQuiet },
        comment: `replay: quiet hours shifted to ${newQuiet.startHour}–${newQuiet.endHour} for demo window (was ${startHour}–${endHour})`,
        active: true,
      });
    });
    console.warn(`⚠ IST hour ${istHour} was inside quiet hours ${startHour}–${endHour}; published policy version shifting quiet hours to ${newQuiet.startHour}–${newQuiet.endHour} for the demo (set REPLAY_KEEP_QUIET_HOURS=true to skip).`);
  }
}

const file = JSON.parse(readFileSync(new URL('../../seed-events.json', import.meta.url).pathname, 'utf8')) as ReplayFile;

async function postWebhook(body: unknown, eventId: string): Promise<number> {
  const raw = JSON.stringify(body);
  const res = await fetch(`${API}/webhooks/razorpay`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': signPayload(raw, SECRET),
      'x-razorpay-event-id': eventId,
    },
    body: raw,
  });
  return res.status;
}

async function postInbound(body: unknown): Promise<number> {
  const res = await fetch(`${API}/webhooks/inbound-email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.status;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForQuiescence(label: string, maxMs = 240_000): Promise<void> {
  const started = Date.now();
  let quietPolls = 0;
  let inFlight = -1;
  // Quiescent means the WHOLE pipeline is drained: nothing left to normalize,
  // nothing left to relay, and no case mid-flight. Checking only case states
  // reports "settled" before the first case has even been created.
  while (Date.now() - started < maxMs) {
    const [pending] = await db
      .select({
        inbox: dsql<number>`(select count(*) from webhook_inbox where processed_at is null)::int`,
        outbox: dsql<number>`(select count(*) from outbox where processed_at is null)::int`,
        transient: dsql<number>`(select count(*) from recovery_cases where state in ('detected','diagnosed','planned','pending_policy','executing'))::int`,
      })
      .from(dsql`(select 1) as _`);
    inFlight = (pending?.inbox ?? 0) + (pending?.outbox ?? 0) + (pending?.transient ?? 0);
    if (inFlight === 0) {
      quietPolls++;
      if (quietPolls >= 3) break; // stable across ~9s, not just a lull
    } else {
      quietPolls = 0;
    }
    process.stdout.write(`\r[replay] ${label}: ${inFlight} items in flight…   `);
    await sleep(3000);
  }
  console.log(`\n[replay] ${label}: settled`);
}

// ---- 1. failure webhooks --------------------------------------------------
const webhooks = file.events.filter((e) => e.kind === 'webhook').sort((a, b) => a.afterMs - b.afterMs);
console.log(`[replay] posting ${webhooks.length} provider webhooks…`);
let posted = 0;
for (const e of webhooks) {
  const status = await postWebhook(e.body, e.eventId ?? `evt_${randomUUID().slice(0, 12)}`);
  if (status !== 200) console.error(`webhook rejected (${status})`, e.meta);
  if (++posted % 100 === 0) {
    process.stdout.write(`\r[replay] ${posted}/${webhooks.length} posted`);
    await sleep(300);
  }
}
console.log(`\n[replay] webhooks posted; replaying 25 duplicates to prove dedupe…`);
for (const e of webhooks.slice(0, 25)) {
  await postWebhook(e.body, e.eventId ?? '');
}

// ---- 2. open B2B overdue cases -------------------------------------------
const overdueOpened = await scanOverdueOnce(db);
console.log(`[replay] overdue scan transitioned ${overdueOpened} invoices`);

await waitForQuiescence('initial processing');

// ---- 3. scripted replies --------------------------------------------------
const inbounds = file.events.filter((e) => e.kind === 'inbound_email');
console.log(`[replay] delivering ${inbounds.length} scripted customer replies…`);
for (const e of inbounds) {
  const status = await postInbound(e.body);
  console.log(`  reply → ${e.meta.customerEmail} (${e.meta.scenario}): HTTP ${status}`);
}
await waitForQuiescence('reply processing', 60_000);

// ---- 4. simulated customer payment outcomes ------------------------------
console.log('[replay] simulating payment outcomes (treatment pays more than holdout)…');
const open = await db
  .select({
    caseId: recoveryCases.id,
    invoiceId: recoveryCases.invoiceId,
    arm: recoveryCases.holdoutArm,
    state: recoveryCases.state,
  })
  .from(recoveryCases)
  .where(inArray(recoveryCases.state, ['waiting', 'pending_approval', 'escalated', 'detected', 'diagnosed', 're_evaluating']));

let treatmentPaid = 0;
let holdoutPaid = 0;
for (const c of open) {
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, c.invoiceId)).limit(1);
  if (!inv || inv.status === 'paid' || !inv.providerInvoiceId) continue;
  const [linkComm] = await db
    .select({ id: communications.id })
    .from(communications)
    .where(and(eq(communications.caseId, c.caseId), eq(communications.templateId, 'payment_link_delivery')))
    .limit(1);

  if (c.arm === 'treatment') {
    if (linkComm && rng() < 0.55) {
      // paid through OUR link → direct attribution
      await postWebhook(
        {
          event: 'payment_link.paid',
          payload: {
            payment_link: { entity: { id: `plink_replay_${randomUUID().slice(0, 8)}`, reference_id: c.invoiceId, amount: inv.amountDuePaise } },
            payment: { entity: { id: `pay_replay_${randomUUID().slice(0, 10)}`, amount: inv.amountDuePaise } },
          },
        },
        `evt_out_${randomUUID().slice(0, 12)}`,
      );
      treatmentPaid++;
    } else if (rng() < 0.12) {
      // paid out-of-band after contact → assisted (or external when uncontacted)
      await postWebhook(
        { event: 'invoice.paid', payload: { invoice: { entity: { id: inv.providerInvoiceId, amount_paid: inv.amountDuePaise, payment_id: `pay_oob_${randomUUID().slice(0, 10)}` } } } },
        `evt_out_${randomUUID().slice(0, 12)}`,
      );
      treatmentPaid++;
    }
  } else if (rng() < 0.24) {
    // holdout self-heal baseline
    await postWebhook(
      { event: 'invoice.paid', payload: { invoice: { entity: { id: inv.providerInvoiceId, amount_paid: inv.amountDuePaise, payment_id: `pay_oob_${randomUUID().slice(0, 10)}` } } } },
      `evt_out_${randomUUID().slice(0, 12)}`,
    );
    holdoutPaid++;
  }
}
console.log(`[replay] outcomes posted: ${treatmentPaid} treatment payments, ${holdoutPaid} holdout self-heals`);
await waitForQuiescence('outcome processing', 120_000);

// ---- 5. summary -----------------------------------------------------------
const states = await db
  .select({ state: recoveryCases.state, arm: recoveryCases.holdoutArm })
  .from(recoveryCases);
const byState = new Map<string, number>();
for (const s of states) byState.set(`${s.arm}/${s.state}`, (byState.get(`${s.arm}/${s.state}`) ?? 0) + 1);
console.log('\n[replay] final case states:');
for (const [k, v] of [...byState.entries()].sort()) console.log(`  ${k}: ${v}`);
console.log('\n[replay] done — open the Command Center and Experiments screens.');
await sql.end();
