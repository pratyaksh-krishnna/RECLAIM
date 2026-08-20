import { z } from 'zod';
import { Paise, PaymentRail } from './enums.js';

/**
 * Canonical internal event catalog. The normalizer maps provider (Razorpay)
 * webhook events onto these; the orchestrator consumes ONLY these.
 */
export const CanonicalEventType = z.enum([
  'payment.failed',
  'invoice.overdue',
  'payment.recovered',
  'subscription.retrying', // Razorpay subscription.pending: provider retry cycle active — hold off
  'subscription.retries_exhausted', // Razorpay subscription.halted: our recovery plan starts
  'customer.responded',
  'customer.broke_promise',
  'recovery.stopped',
  'refund.recorded',
  'payment_link.expired',
]);
export type CanonicalEventType = z.infer<typeof CanonicalEventType>;

const base = {
  eventId: z.string().uuid(),
  occurredAt: z.string().datetime(),
  /** provider event id (or synthetic id for internally generated events) */
  sourceEventId: z.string().min(1),
  customerId: z.string().uuid(),
};

export const PaymentFailedEvent = z.object({
  ...base,
  type: z.literal('payment.failed'),
  invoiceId: z.string().uuid(),
  subscriptionId: z.string().uuid().nullable(),
  amountDue: Paise,
  rail: PaymentRail,
  declineCode: z.string().nullable(),
  providerPaymentId: z.string().nullable(),
});

export const InvoiceOverdueEvent = z.object({
  ...base,
  type: z.literal('invoice.overdue'),
  invoiceId: z.string().uuid(),
  amountDue: Paise,
  dueDate: z.string().datetime(),
  daysOverdue: z.number().int().nonnegative(),
});

export const PaymentRecoveredEvent = z.object({
  ...base,
  type: z.literal('payment.recovered'),
  invoiceId: z.string().uuid(),
  amountPaid: Paise,
  providerPaymentId: z.string().nullable(),
  /** how the money arrived, used by attribution */
  via: z.enum(['payment_link', 'mandate_execution', 'provider_retry', 'out_of_band']),
});

export const SubscriptionRetryingEvent = z.object({
  ...base,
  type: z.literal('subscription.retrying'),
  subscriptionId: z.string().uuid(),
  invoiceId: z.string().uuid().nullable(),
});

export const SubscriptionRetriesExhaustedEvent = z.object({
  ...base,
  type: z.literal('subscription.retries_exhausted'),
  subscriptionId: z.string().uuid(),
  invoiceId: z.string().uuid().nullable(),
  amountDue: Paise,
});

export const CustomerRespondedEvent = z.object({
  ...base,
  type: z.literal('customer.responded'),
  caseId: z.string().uuid(),
  communicationId: z.string().uuid().nullable(),
  /** raw customer text; ALWAYS treated as data, never as instructions */
  body: z.string(),
});

export const CustomerBrokePromiseEvent = z.object({
  ...base,
  type: z.literal('customer.broke_promise'),
  caseId: z.string().uuid(),
  promiseId: z.string().uuid(),
});

export const RecoveryStoppedEvent = z.object({
  ...base,
  type: z.literal('recovery.stopped'),
  caseId: z.string().uuid(),
  reason: z.string(),
});

export const RefundRecordedEvent = z.object({
  ...base,
  type: z.literal('refund.recorded'),
  invoiceId: z.string().uuid(),
  amount: Paise,
});

export const PaymentLinkExpiredEvent = z.object({
  ...base,
  type: z.literal('payment_link.expired'),
  invoiceId: z.string().uuid(),
  providerLinkId: z.string(),
});

export const CanonicalEvent = z.discriminatedUnion('type', [
  PaymentFailedEvent,
  InvoiceOverdueEvent,
  PaymentRecoveredEvent,
  SubscriptionRetryingEvent,
  SubscriptionRetriesExhaustedEvent,
  CustomerRespondedEvent,
  CustomerBrokePromiseEvent,
  RecoveryStoppedEvent,
  RefundRecordedEvent,
  PaymentLinkExpiredEvent,
]);
export type CanonicalEvent = z.infer<typeof CanonicalEvent>;
