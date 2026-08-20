import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import { invoices, subscriptions } from '../db/schema.js';
import type { ProviderResolver, ResolvedInvoice } from './normalizer.js';

function toResolved(row: typeof invoices.$inferSelect): ResolvedInvoice {
  return {
    id: row.id,
    customerId: row.customerId,
    subscriptionId: row.subscriptionId,
    amountDuePaise: row.amountDuePaise,
    amountPaidPaise: row.amountPaidPaise,
  };
}

export function makeDbResolver(db: Db | Tx): ProviderResolver {
  return {
    async invoiceByProviderId(pid) {
      const [row] = await db.select().from(invoices).where(eq(invoices.providerInvoiceId, pid)).limit(1);
      return row ? toResolved(row) : null;
    },
    async invoiceById(id) {
      const [row] = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
      return row ? toResolved(row) : null;
    },
    async subscriptionByProviderId(pid) {
      const [row] = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.providerSubscriptionId, pid))
        .limit(1);
      return row ? { id: row.id, customerId: row.customerId } : null;
    },
    async openInvoiceForSubscription(subscriptionId) {
      const [row] = await db
        .select()
        .from(invoices)
        .where(and(eq(invoices.subscriptionId, subscriptionId), inArray(invoices.status, ['open', 'overdue'])))
        .orderBy(desc(invoices.dueDate))
        .limit(1);
      return row ? toResolved(row) : null;
    },
  };
}
