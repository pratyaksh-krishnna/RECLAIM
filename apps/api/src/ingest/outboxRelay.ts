import { asc, isNull, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { outbox } from '../db/schema.js';

export interface OutboxPublisher {
  /** enqueue an orchestrate job; jobId = outboxId gives queue-level dedupe */
  publish(outboxId: string, eventType: string, payload: unknown): Promise<void>;
}

/**
 * Relays unprocessed outbox rows to the orchestrate queue. At-least-once:
 * a crash between publish and mark re-publishes, deduped by jobId and by
 * the orchestrator's own idempotency.
 */
export async function relayOutboxOnce(db: Db, publisher: OutboxPublisher, batch = 100): Promise<number> {
  const rows = await db
    .select()
    .from(outbox)
    .where(isNull(outbox.processedAt))
    .orderBy(asc(outbox.createdAt))
    .limit(batch);

  for (const row of rows) {
    await publisher.publish(row.id, row.eventType, row.payload);
    await db.update(outbox).set({ processedAt: new Date(), attempts: row.attempts + 1 }).where(eq(outbox.id, row.id));
  }
  return rows.length;
}
