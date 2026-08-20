import Razorpay from 'razorpay';
import type {
  CreatePaymentLinkArgs,
  ExecuteMandateDebitArgs,
  MandateDebitResult,
  PaymentLinkResult,
  PaymentProvider,
} from './provider.js';

/**
 * Razorpay test-mode adapter.
 *
 * Idempotency note (verified against Razorpay docs as of 2026): the Payment
 * Links API does not accept a client idempotency key header the way Stripe
 * does, so provider-side idempotency cannot be relied on. The system-level
 * guarantee is internal: the unique tool_executions.idempotency_key claim
 * means a duplicate BullMQ job never reaches this adapter twice for the same
 * attempt. reference_id also lets us detect existing links for an invoice.
 */
export class RazorpayAdapter implements PaymentProvider {
  readonly name = 'razorpay';
  private client: Razorpay;

  constructor(keyId: string, keySecret: string) {
    this.client = new Razorpay({ key_id: keyId, key_secret: keySecret });
  }

  async createPaymentLink(args: CreatePaymentLinkArgs): Promise<PaymentLinkResult> {
    const link = await this.client.paymentLink.create({
      amount: args.amountPaise,
      currency: args.currency,
      description: args.description,
      reference_id: args.referenceId,
      customer: { name: args.customer.name, email: args.customer.email },
      notify: { email: false, sms: false }, // we deliver the link through our own templated email
      // UPI, cards and netbanking are enabled on the link by default in test mode
      ...(args.expireByUnix ? { expire_by: args.expireByUnix } : {}),
      notes: { idempotency_key: args.idempotencyKey },
    });
    return { providerLinkId: link.id, shortUrl: link.short_url };
  }

  async executeMandateDebit(_args: ExecuteMandateDebitArgs): Promise<MandateDebitResult> {
    // Recurring mandate re-execution in Razorpay test mode runs through
    // subscription invoices/charges; a direct ad-hoc charge API is NOT used
    // (the provider owns its retry rail). In live-test mode we only initiate;
    // completion arrives via webhook.
    throw new Error(
      'live-test mandate re-execution not wired: Razorpay executes mandate debits on its own rail; use sandbox mode for demos',
    );
  }
}
