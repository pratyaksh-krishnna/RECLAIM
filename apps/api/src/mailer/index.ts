import type { Mailer } from './mailer.js';
import { MockMailer } from './mailer.js';

export function getMailer(): Mailer {
  return new MockMailer(); // MAILER_MODE only allows 'mock' at MVP
}
export type { Mailer, OutboundEmail } from './mailer.js';
