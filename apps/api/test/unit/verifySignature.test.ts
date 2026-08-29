import { describe, expect, it } from 'vitest';
import {
  signPayload,
  verifyMetaSignature,
  verifyRazorpaySignature,
} from '../../src/ingest/verifySignature.js';

describe('razorpay signature verification', () => {
  const secret = 'whsec_demo_secret';
  const body = Buffer.from(JSON.stringify({ event: 'payment.failed', payload: {} }));

  it('accepts a valid signature', () => {
    expect(verifyRazorpaySignature(body, signPayload(body, secret), secret)).toBe(true);
  });
  it('rejects a tampered body', () => {
    const sig = signPayload(body, secret);
    expect(verifyRazorpaySignature(Buffer.from(body.toString() + 'x'), sig, secret)).toBe(false);
  });
  it('rejects a wrong secret', () => {
    expect(verifyRazorpaySignature(body, signPayload(body, 'other'), secret)).toBe(false);
  });
  it('rejects empty signature', () => {
    expect(verifyRazorpaySignature(body, '', secret)).toBe(false);
  });
});

describe('verifyMetaSignature', () => {
  const body = Buffer.from(JSON.stringify({ entry: [] }));
  const secret = 'app-secret';
  const good = `sha256=${signPayload(body, secret)}`;

  it('accepts a correctly signed body', () => {
    expect(verifyMetaSignature(body, good, secret)).toBe(true);
  });

  it('rejects a tampered body', () => {
    expect(verifyMetaSignature(Buffer.from('{"entry":[1]}'), good, secret)).toBe(false);
  });

  it('rejects a missing or unprefixed header', () => {
    expect(verifyMetaSignature(body, '', secret)).toBe(false);
    expect(verifyMetaSignature(body, signPayload(body, secret), secret)).toBe(false);
  });

  it('rejects a signature that is not hex, or is the wrong length', () => {
    expect(verifyMetaSignature(body, 'sha256=zzzz', secret)).toBe(false);
    expect(verifyMetaSignature(body, 'sha256=abcd', secret)).toBe(false);
  });

  it('FAILS CLOSED when the secret is empty, rather than verifying against it', () => {
    // An unset WHATSAPP_APP_SECRET must not turn verification off. Without this
    // guard anyone can HMAC a body with the empty key and be believed — and an
    // inbound message opens the 24-hour window that authorises outbound voice.
    const forged = `sha256=${signPayload(body, '')}`;
    expect(verifyMetaSignature(body, forged, '')).toBe(false);
    expect(verifyMetaSignature(body, good, '')).toBe(false);
  });
});
