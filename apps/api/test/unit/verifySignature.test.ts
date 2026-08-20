import { describe, expect, it } from 'vitest';
import { signPayload, verifyRazorpaySignature } from '../../src/ingest/verifySignature.js';

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
