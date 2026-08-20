import { and, eq, isNotNull, lte } from 'drizzle-orm';
import type { AttributionClass } from '@reclaim/shared';
import type { Tx } from '../db/client.js';
import { communications } from '../db/schema.js';

/**
 * Deterministic attribution of a recovered payment.
 *  - direct:   arrived through OUR payment link or OUR scheduled mandate execution
 *  - assisted: arrived via another path, but after at least one outbound
 *              contact from us, inside the attribution window
 *  - external: no contact preceded it (or holdout) — never credited
 */
export async function classifyAttribution(
  tx: Tx,
  args: {
    caseId: string;
    via: 'payment_link' | 'mandate_execution' | 'provider_retry' | 'out_of_band';
    paidAt: Date;
    attributionWindowEndsAt: Date;
  },
): Promise<AttributionClass> {
  if (args.paidAt > args.attributionWindowEndsAt) return 'external';
  if (args.via === 'payment_link' || args.via === 'mandate_execution') return 'direct';

  const [contact] = await tx
    .select({ id: communications.id })
    .from(communications)
    .where(
      and(
        eq(communications.caseId, args.caseId),
        eq(communications.direction, 'outbound'),
        isNotNull(communications.sentAt),
        lte(communications.sentAt, args.paidAt),
      ),
    )
    .limit(1);
  return contact ? 'assisted' : 'external';
}
