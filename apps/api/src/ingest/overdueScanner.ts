import { randomUUID } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import { CanonicalEvent } from '@reclaim/shared';
import type { Db } from '../db/client.js';
import { invoices, outbox } from '../db/schema.js';
import { writeAudit } from '../audit/audit.js';

/**
 * Daily scan simulating `invoice.overdue`: every open invoice past its due
 * date transitions open→overdue exactly once, emitting the canonical event
 * in the same transaction. The single state transition is the dedupe.
 */
export async function scanOverdueOnce(db: Db, now: () => Date = () => new Date()): Promise<number> {
  const due = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(eq(invoices.status, 'open'), lt(invoices.dueDate, now())));

  let transitioned = 0;
  for (const { id } of due) {
    await db.transaction(async (tx) => {
      const [inv] = await tx.select().from(invoices).where(eq(invoices.id, id)).for('update').limit(1);
      if (!inv || inv.status !== 'open') return; // raced: someone else transitioned it
      const nowDate = now();
      const daysOverdue = Math.max(0, Math.floor((nowDate.getTime() - inv.dueDate.getTime()) / 86_400_000));
      await tx.update(invoices).set({ status: 'overdue' }).where(eq(invoices.id, id));
      const event = CanonicalEvent.parse({
        eventId: randomUUID(),
        occurredAt: nowDate.toISOString(),
        sourceEventId: `overdue-scan:${inv.id}`,
        type: 'invoice.overdue',
        customerId: inv.customerId,
        invoiceId: inv.id,
        amountDue: inv.amountDuePaise - inv.amountPaidPaise,
        dueDate: inv.dueDate.toISOString(),
        daysOverdue,
      });
      await tx.insert(outbox).values({ eventType: event.type, payload: event });
      await writeAudit(tx, {
        actorType: 'system',
        eventType: 'invoice.marked_overdue',
        payload: { invoiceId: inv.id, daysOverdue },
      });
      transitioned++;
    });
  }
  return transitioned;
}
