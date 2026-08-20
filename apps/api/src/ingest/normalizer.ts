import { randomUUID } from 'node:crypto';
import { CanonicalEvent, type PaymentRail } from '@reclaim/shared';
import { classifyDeclineCode } from '../domain/declineTable.js';

/**
 * Maps raw Razorpay webhook payloads to canonical internal events.
 * Pure with respect to the DB except through the injected resolver.
 */

export interface ResolvedInvoice {
  id: string;
  customerId: string;
  subscriptionId: string | null;
  amountDuePaise: number;
  amountPaidPaise: number;
}
export interface ResolvedSubscription {
  id: string;
  customerId: string;
}

export interface ProviderResolver {
  invoiceByProviderId(providerInvoiceId: string): Promise<ResolvedInvoice | null>;
  subscriptionByProviderId(providerSubscriptionId: string): Promise<ResolvedSubscription | null>;
  /** latest open/overdue invoice for a subscription (for halted events) */
  openInvoiceForSubscription(subscriptionId: string): Promise<ResolvedInvoice | null>;
  /** resolve a payment-link reference (we set reference_id = internal invoice id) */
  invoiceById(invoiceId: string): Promise<ResolvedInvoice | null>;
}

export interface FailureEventInsert {
  customerId: string;
  invoiceId: string;
  subscriptionId: string | null;
  rail: PaymentRail;
  declineCode: string | null;
  declineClass: ReturnType<typeof classifyDeclineCode>;
  amountPaise: number;
  providerPaymentId: string | null;
  occurredAt: Date;
}

export interface NormalizedResult {
  events: CanonicalEvent[];
  failureEvent?: FailureEventInsert;
  /** provider event could not be tied to known records; kept in inbox, audited, skipped */
  unresolved?: string;
}

interface RazorpayEnvelope {
  event: string;
  created_at?: number;
  payload?: Record<string, { entity?: Record<string, unknown> } | undefined>;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function railFromMethod(method: string | null, recurring: boolean): PaymentRail {
  switch (method) {
    case 'card':
      return 'card';
    case 'upi':
      return recurring ? 'upi_autopay' : 'upi_autopay';
    case 'emandate':
      return 'emandate';
    case 'netbanking':
      return 'netbanking';
    default:
      return 'card';
  }
}

export async function normalizeRazorpayEvent(
  providerEventId: string,
  payload: unknown,
  resolver: ProviderResolver,
  now: () => Date = () => new Date(),
): Promise<NormalizedResult> {
  const env = payload as RazorpayEnvelope;
  const occurredAt = env.created_at ? new Date(env.created_at * 1000) : now();
  const iso = occurredAt.toISOString();
  const mk = { eventId: randomUUID(), occurredAt: iso, sourceEventId: providerEventId };

  switch (env.event) {
    case 'payment.failed': {
      const p = env.payload?.payment?.entity ?? {};
      const providerInvoiceId = str(p['invoice_id']);
      if (!providerInvoiceId) return { events: [], unresolved: 'payment.failed without invoice_id' };
      const invoice = await resolver.invoiceByProviderId(providerInvoiceId);
      if (!invoice) return { events: [], unresolved: `unknown invoice ${providerInvoiceId}` };
      const declineCode = str(p['error_reason']) ?? str(p['error_code']);
      const rail = railFromMethod(str(p['method']), Boolean(p['recurring']));
      const amount = num(p['amount']) ?? invoice.amountDuePaise;
      return {
        events: [
          CanonicalEvent.parse({
            ...mk,
            type: 'payment.failed',
            customerId: invoice.customerId,
            invoiceId: invoice.id,
            subscriptionId: invoice.subscriptionId,
            amountDue: amount,
            rail,
            declineCode,
            providerPaymentId: str(p['id']),
          }),
        ],
        failureEvent: {
          customerId: invoice.customerId,
          invoiceId: invoice.id,
          subscriptionId: invoice.subscriptionId,
          rail,
          declineCode,
          declineClass: classifyDeclineCode(declineCode),
          amountPaise: amount,
          providerPaymentId: str(p['id']),
          occurredAt,
        },
      };
    }

    case 'subscription.pending': {
      const s = env.payload?.subscription?.entity ?? {};
      const pid = str(s['id']);
      if (!pid) return { events: [], unresolved: 'subscription.pending without id' };
      const sub = await resolver.subscriptionByProviderId(pid);
      if (!sub) return { events: [], unresolved: `unknown subscription ${pid}` };
      const inv = await resolver.openInvoiceForSubscription(sub.id);
      return {
        events: [
          CanonicalEvent.parse({
            ...mk,
            type: 'subscription.retrying',
            customerId: sub.customerId,
            subscriptionId: sub.id,
            invoiceId: inv?.id ?? null,
          }),
        ],
      };
    }

    case 'subscription.halted': {
      const s = env.payload?.subscription?.entity ?? {};
      const pid = str(s['id']);
      if (!pid) return { events: [], unresolved: 'subscription.halted without id' };
      const sub = await resolver.subscriptionByProviderId(pid);
      if (!sub) return { events: [], unresolved: `unknown subscription ${pid}` };
      const inv = await resolver.openInvoiceForSubscription(sub.id);
      return {
        events: [
          CanonicalEvent.parse({
            ...mk,
            type: 'subscription.retries_exhausted',
            customerId: sub.customerId,
            subscriptionId: sub.id,
            invoiceId: inv?.id ?? null,
            amountDue: inv ? inv.amountDuePaise - inv.amountPaidPaise : 0,
          }),
        ],
      };
    }

    case 'subscription.charged': {
      const s = env.payload?.subscription?.entity ?? {};
      const p = env.payload?.payment?.entity ?? {};
      const pid = str(s['id']);
      if (!pid) return { events: [], unresolved: 'subscription.charged without id' };
      const sub = await resolver.subscriptionByProviderId(pid);
      if (!sub) return { events: [], unresolved: `unknown subscription ${pid}` };
      const inv = await resolver.openInvoiceForSubscription(sub.id);
      if (!inv) return { events: [] }; // routine renewal charge with nothing at risk — ignore
      return {
        events: [
          CanonicalEvent.parse({
            ...mk,
            type: 'payment.recovered',
            customerId: sub.customerId,
            invoiceId: inv.id,
            amountPaid: num(p['amount']) ?? inv.amountDuePaise,
            providerPaymentId: str(p['id']),
            via: 'provider_retry',
          }),
        ],
      };
    }

    case 'payment_link.paid': {
      const link = env.payload?.payment_link?.entity ?? {};
      const p = env.payload?.payment?.entity ?? {};
      // we always set reference_id to the internal invoice id when creating links
      const refId = str(link['reference_id']);
      if (!refId) return { events: [], unresolved: 'payment_link.paid without reference_id' };
      const invoice = await resolver.invoiceById(refId);
      if (!invoice) return { events: [], unresolved: `unknown invoice ref ${refId}` };
      return {
        events: [
          CanonicalEvent.parse({
            ...mk,
            type: 'payment.recovered',
            customerId: invoice.customerId,
            invoiceId: invoice.id,
            amountPaid: num(p['amount']) ?? num(link['amount']) ?? invoice.amountDuePaise,
            providerPaymentId: str(p['id']),
            via: 'payment_link',
          }),
        ],
      };
    }

    case 'invoice.paid': {
      const inv = env.payload?.invoice?.entity ?? {};
      const providerInvoiceId = str(inv['id']);
      if (!providerInvoiceId) return { events: [], unresolved: 'invoice.paid without id' };
      const invoice = await resolver.invoiceByProviderId(providerInvoiceId);
      if (!invoice) return { events: [], unresolved: `unknown invoice ${providerInvoiceId}` };
      return {
        events: [
          CanonicalEvent.parse({
            ...mk,
            type: 'payment.recovered',
            customerId: invoice.customerId,
            invoiceId: invoice.id,
            amountPaid: num(inv['amount_paid']) ?? invoice.amountDuePaise,
            providerPaymentId: str(inv['payment_id']),
            via: 'out_of_band',
          }),
        ],
      };
    }

    case 'invoice.expired':
    case 'payment_link.expired': {
      const link = env.payload?.payment_link?.entity ?? env.payload?.invoice?.entity ?? {};
      const refId = str(link['reference_id']);
      const providerLinkId = str(link['id']) ?? 'unknown';
      const invoice = refId
        ? await resolver.invoiceById(refId)
        : providerLinkId
          ? await resolver.invoiceByProviderId(providerLinkId)
          : null;
      if (!invoice) return { events: [], unresolved: 'expired link/invoice not resolvable' };
      return {
        events: [
          CanonicalEvent.parse({
            ...mk,
            type: 'payment_link.expired',
            customerId: invoice.customerId,
            invoiceId: invoice.id,
            providerLinkId,
          }),
        ],
      };
    }

    case 'refund.created': {
      const r = env.payload?.refund?.entity ?? {};
      const notes = (r['notes'] ?? {}) as Record<string, unknown>;
      const refId = str(notes['invoice_id']);
      if (!refId) return { events: [], unresolved: 'refund.created not tied to an invoice' };
      const invoice = await resolver.invoiceById(refId);
      if (!invoice) return { events: [], unresolved: `unknown invoice ${refId}` };
      return {
        events: [
          CanonicalEvent.parse({
            ...mk,
            type: 'refund.recorded',
            customerId: invoice.customerId,
            invoiceId: invoice.id,
            amount: num(r['amount']) ?? 0,
          }),
        ],
      };
    }

    default:
      return { events: [], unresolved: `unmapped provider event: ${env.event}` };
  }
}
