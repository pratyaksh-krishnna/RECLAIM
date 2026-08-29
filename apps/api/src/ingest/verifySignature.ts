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

/**
 * Meta webhook authenticity: HMAC SHA-256 of the RAW body with the app secret,
 * sent as `X-Hub-Signature-256: sha256=<hex>`. Same shape as the Razorpay check
 * above, with the prefix Meta adds.
 */
export function verifyMetaSignature(rawBody: Buffer, header: string, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(header.slice('sha256='.length), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
