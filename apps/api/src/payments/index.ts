import { env } from '../config/env.js';
import type { PaymentProvider } from './provider.js';
import { RazorpayAdapter } from './razorpayAdapter.js';
import { SandboxPaymentProvider } from './sandboxAdapter.js';

export function getPaymentProvider(): PaymentProvider {
  if (env.PAYMENTS_MODE === 'live-test') {
    return new RazorpayAdapter(env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET);
  }
  return new SandboxPaymentProvider();
}
export type { PaymentProvider } from './provider.js';
