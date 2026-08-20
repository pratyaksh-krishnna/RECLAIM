import { randomUUID } from 'node:crypto';
import type { Db } from '../../src/db/client.js';
import { customers, invoices, subscriptions } from '../../src/db/schema.js';

export async function seedCustomer(db: Db, overrides: Partial<typeof customers.$inferInsert> = {}) {
  const [row] = await db
    .insert(customers)
    .values({
      name: 'Priya Sharma',
      email: `priya-${randomUUID().slice(0, 8)}@example.test`,
      timezone: 'Asia/Kolkata',
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('seedCustomer failed');
  return row;
}

export async function seedSubscription(
  db: Db,
  customerId: string,
  overrides: Partial<typeof subscriptions.$inferInsert> = {},
) {
  const [row] = await db
    .insert(subscriptions)
    .values({
      customerId,
      planName: 'Pro Monthly',
      mrrPaise: 99_900,
      rail: 'card',
      providerSubscriptionId: `sub_${randomUUID().slice(0, 12)}`,
      startedAt: new Date('2026-01-01T00:00:00Z'),
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('seedSubscription failed');
  return row;
}

export async function seedInvoice(
  db: Db,
  customerId: string,
  overrides: Partial<typeof invoices.$inferInsert> = {},
) {
  const [row] = await db
    .insert(invoices)
    .values({
      customerId,
      amountDuePaise: 99_900,
      dueDate: new Date('2026-08-01T00:00:00Z'),
      providerInvoiceId: `inv_${randomUUID().slice(0, 12)}`,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('seedInvoice failed');
  return row;
}
