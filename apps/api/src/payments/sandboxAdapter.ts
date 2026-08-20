import { createHash } from 'node:crypto';
import type {
  CreatePaymentLinkArgs,
  ExecuteMandateDebitArgs,
  MandateDebitResult,
  PaymentLinkResult,
  PaymentProvider,
} from './provider.js';

/**
 * Deterministic offline provider for demos/tests. Ids are derived from the
 * idempotency key, so a replayed call yields the identical link/payment id —
 * duplicates are structurally impossible.
 */
export class SandboxPaymentProvider implements PaymentProvider {
  readonly name = 'razorpay-sandbox';

  async createPaymentLink(args: CreatePaymentLinkArgs): Promise<PaymentLinkResult> {
    const h = createHash('sha256').update(args.idempotencyKey).digest('hex').slice(0, 14);
    return {
      providerLinkId: `plink_sbx_${h}`,
      shortUrl: `https://rzp.io/sbx/${h}`,
    };
  }

  async executeMandateDebit(args: ExecuteMandateDebitArgs): Promise<MandateDebitResult> {
    const h = createHash('sha256').update(args.idempotencyKey).digest('hex').slice(0, 14);
    return { providerPaymentId: `pay_sbx_${h}`, status: 'captured' };
  }
}
