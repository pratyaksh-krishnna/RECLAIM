import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Razorpay webhook authenticity: HMAC SHA-256 of the RAW request body with
 * the webhook secret, compared against X-Razorpay-Signature. Runs BEFORE any
 * JSON parsing; constant-time comparison.
 */
export function verifyRazorpaySignature(rawBody: Buffer, signature: string, secret: string): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function signPayload(rawBody: Buffer | string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}
