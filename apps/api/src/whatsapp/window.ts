import { and, desc, eq, gte } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import { communications } from '../db/schema.js';

/**
 * WhatsApp permits a freeform message — which is what an audio message is —
 * only inside a window opened by the customer writing first. Business-initiated
 * contact must be a pre-approved template, and template headers support
 * image/video/document but not audio, so there is no version of this that
 * reaches someone who has never written to us.
 */
export const WHATSAPP_WINDOW_HOURS = 24;

/**
 * Deterministic, and needs no column of its own: a window is open if an
 * INBOUND whatsapp_text communication exists for this customer inside the
 * window. Served by the existing comms_customer_sent_idx on
 * (customer_id, sent_at).
 *
 * Direction and channel both matter. An inbound email does not open a WhatsApp
 * window, and our own outbound voice note certainly does not.
 */
export async function isWhatsAppWindowOpen(
  db: Db | Tx,
  customerId: string,
  now: Date,
): Promise<boolean> {
  const cutoff = new Date(now.getTime() - WHATSAPP_WINDOW_HOURS * 3_600_000);
  const [row] = await db
    .select({ id: communications.id })
    .from(communications)
    .where(
      and(
        eq(communications.customerId, customerId),
        eq(communications.direction, 'inbound'),
        eq(communications.channel, 'whatsapp_text'),
        gte(communications.sentAt, cutoff),
      ),
    )
    .orderBy(desc(communications.sentAt))
    .limit(1);
  return row !== undefined;
}
