import { randomUUID } from 'node:crypto';

export interface OutboundEmail {
  to: { name: string; email: string };
  subject: string;
  body: string;
  caseId: string;
  templateId: string;
}
export interface SendResult {
  providerMessageId: string;
}

export interface Mailer {
  readonly name: string;
  send(msg: OutboundEmail): Promise<SendResult>;
}

/**
 * Mock mailer: console log only — the durable log is the communications row
 * the calling tool writes in the same flow.
 */
export class MockMailer implements Mailer {
  readonly name = 'mock';
  async send(msg: OutboundEmail): Promise<SendResult> {
    const id = `mock_${randomUUID().slice(0, 12)}`;
    console.log(`[mock-mailer] → ${msg.to.email} | ${msg.subject} | template=${msg.templateId} | ${id}`);
    return { providerMessageId: id };
  }
}
