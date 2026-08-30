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
 *
 * FAILS CLOSED ON AN EMPTY SECRET. Without that check an unset
 * WHATSAPP_APP_SECRET does not disable verification, it makes it forgeable:
 * anyone can HMAC a body with the empty key and produce a signature this
 * function accepts. The consequence is not just a spurious row — an inbound
 * message OPENS the 24-hour window, and an open window is what authorises
 * outbound voice notes. env.ts additionally refuses to boot in production
 * without the secret; this is the second line.
 *
 * Comparison is over the decoded 32-byte digests rather than their hex text,
 * so the only length branch is on input that failed to parse as a digest at
 * all.
 */
export function verifyMetaSignature(rawBody: Buffer, header: string, appSecret: string): boolean {
  if (!appSecret) return false;
  if (!header?.startsWith('sha256=')) return false;

  const provided = Buffer.from(header.slice('sha256='.length), 'hex');
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
