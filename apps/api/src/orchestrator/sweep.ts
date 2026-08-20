import { and, lt, notInArray, eq, isNotNull } from 'drizzle-orm';
import { TERMINAL_STATES } from '@reclaim/shared';
import type { Db } from '../db/client.js';
import { promisesToPay, recoveryCases, outbox, invoices } from '../db/schema.js';
import { writeAudit } from '../audit/audit.js';
import { lockCase, transitionCase } from './caseService.js';
import { isTerminal } from './fsm.js';
import { randomUUID } from 'node:crypto';
import { CanonicalEvent } from '@reclaim/shared';

/**
 * Periodic deterministic sweeps:
 *  - waiting cases past their deadline → re_evaluate (via case step)
 *  - open cases past the attribution window → lost
 *  - open promises past their date with the invoice unpaid → customer.broke_promise
 */
export async function sweepCases(
  db: Db,
  enqueueCaseStep: (caseId: string, trigger: string) => Promise<void>,
  now: () => Date = () => new Date(),
): Promise<{ waitElapsed: number; lost: number; brokenPromises: number }> {
  const nowDate = now();
  let waitElapsed = 0;
  let lost = 0;
  let brokenPromises = 0;

  const waiting = await db
    .select({ id: recoveryCases.id })
    .from(recoveryCases)
    .where(and(eq(recoveryCases.state, 'waiting'), isNotNull(recoveryCases.waitUntil), lt(recoveryCases.waitUntil, nowDate)));
  for (const { id } of waiting) {
    await enqueueCaseStep(id, 'wait_elapsed');
    waitElapsed++;
  }

  const expired = await db
    .select({ id: recoveryCases.id })
    .from(recoveryCases)
    .where(
      and(
        notInArray(recoveryCases.state, [...TERMINAL_STATES]),
        lt(recoveryCases.attributionWindowEndsAt, nowDate),
      ),
    );
  for (const { id } of expired) {
    await db.transaction(async (tx) => {
      const caseRow = await lockCase(tx, id);
      if (!caseRow || isTerminal(caseRow.state)) return;
      await transitionCase(tx, caseRow, 'lost', { reason: 'attribution window elapsed without recovery' });
      lost++;
    });
  }

  const overduePromises = await db
    .select()
    .from(promisesToPay)
    .where(and(eq(promisesToPay.status, 'open'), lt(promisesToPay.promisedDate, nowDate)));
  for (const promise of overduePromises) {
    await db.transaction(async (tx) => {
      const [caseRow] = await tx.select().from(recoveryCases).where(eq(recoveryCases.id, promise.caseId)).limit(1);
      if (!caseRow) return;
      const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, caseRow.invoiceId)).limit(1);
      if (!invoice || invoice.status === 'paid') return; // promise kept via payment; recovery event handles it
      const event = CanonicalEvent.parse({
        eventId: randomUUID(),
        occurredAt: nowDate.toISOString(),
        sourceEventId: `promise-check:${promise.id}`,
        type: 'customer.broke_promise',
        customerId: promise.customerId,
        caseId: promise.caseId,
        promiseId: promise.id,
      });
      await tx.insert(outbox).values({ eventType: event.type, payload: event });
      // mark now so the sweep never emits twice for the same promise
      await tx.update(promisesToPay).set({ status: 'broken', resolvedAt: nowDate }).where(eq(promisesToPay.id, promise.id));
      await writeAudit(tx, {
        caseId: promise.caseId,
        actorType: 'system',
        eventType: 'promise.broken_detected',
        payload: { promiseId: promise.id },
      });
      brokenPromises++;
    });
  }

  return { waitElapsed, lost, brokenPromises };
}
