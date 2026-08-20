import { eq, isNull, and } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { failureEvents, outbox, webhookInbox } from '../db/schema.js';
import { writeAudit } from '../audit/audit.js';
import { makeDbResolver } from './resolver.js';
import { normalizeRazorpayEvent } from './normalizer.js';

/**
 * Processes one webhook_inbox row: map to canonical events, persist failure
 * events, write outbox rows, mark inbox processed — all in ONE transaction.
 * Idempotent: an already-processed row is a no-op, so BullMQ redelivery is safe.
 */
export async function processInboxRow(db: Db, inboxId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(webhookInbox)
      .where(and(eq(webhookInbox.id, inboxId), isNull(webhookInbox.processedAt)))
      .for('update')
      .limit(1);
    if (!row) return; // already processed or unknown — idempotent no-op

    const result = await normalizeRazorpayEvent(row.providerEventId, row.payload, makeDbResolver(tx));

    if (result.failureEvent) {
      await tx.insert(failureEvents).values(result.failureEvent);
    }
    for (const event of result.events) {
      await tx.insert(outbox).values({ eventType: event.type, payload: event });
    }
    if (result.unresolved) {
      await writeAudit(tx, {
        actorType: 'provider',
        eventType: 'webhook.unresolved',
        payload: { inboxId, providerEventId: row.providerEventId, reason: result.unresolved },
      });
    }
    await tx.update(webhookInbox).set({ processedAt: new Date() }).where(eq(webhookInbox.id, inboxId));
  });
}
