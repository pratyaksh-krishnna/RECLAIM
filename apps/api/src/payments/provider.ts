/**
 * PaymentProvider abstraction. Only the Razorpay adapter is implemented
 * (test mode); the interface exists so another PSP can be added later.
 * NO amount in these calls ever originates from an LLM — callers resolve
 * amounts server-side from the invoice.
 */
export interface CreatePaymentLinkArgs {
  amountPaise: number;
  currency: 'INR';
  description: string;
  referenceId: string; // internal invoice id; round-trips via webhooks
  customer: { name: string; email: string };
  /** internal idempotency key caseId:interventionId:attempt */
  idempotencyKey: string;
  expireByUnix?: number;
}
export interface PaymentLinkResult {
  providerLinkId: string;
  shortUrl: string;
}

export interface ExecuteMandateDebitArgs {
  amountPaise: number;
  currency: 'INR';
  mandateRef: string;
  invoiceId: string;
  customerId: string;
  idempotencyKey: string;
}
export interface MandateDebitResult {
  providerPaymentId: string;
  /** sandbox resolves synchronously; the live rail reports via webhook */
  status: 'captured' | 'initiated' | 'failed';
}

export interface PaymentProvider {
  readonly name: string;
  createPaymentLink(args: CreatePaymentLinkArgs): Promise<PaymentLinkResult>;
  executeMandateDebit(args: ExecuteMandateDebitArgs): Promise<MandateDebitResult>;
}
