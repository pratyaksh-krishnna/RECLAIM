import type { Mailer, OutboundEmail, SendResult } from './mailer.js';

/**
 * Resend adapter shape — pluggable behind the Mailer interface but NOT wired
 * to a real key at MVP (spec). Selecting it without configuration is an error.
 */
export class ResendMailer implements Mailer {
  readonly name = 'resend';
  constructor(private apiKey: string) {
    if (!apiKey) throw new Error('ResendMailer requires an API key; MVP runs MAILER_MODE=mock');
  }
  async send(_msg: OutboundEmail): Promise<SendResult> {
    throw new Error('ResendMailer is intentionally unwired at MVP');
  }
}
