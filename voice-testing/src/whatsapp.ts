import { randomUUID } from 'node:crypto';
import type { SpokenAudio } from './voice.js';

/**
 * WhatsApp delivery seam. Same three pieces as the mailer: interface, real
 * adapter, mock.
 *
 * Meta's Cloud API takes audio in two steps — upload to the Media API for a
 * media_id, then send a message referencing that id. Sending by id rather than
 * by URL is why this needs no publicly reachable host, which is what makes
 * local testing possible at all.
 */

const GRAPH_VERSION = 'v21.0';

export interface SendVoiceArgs {
  /** E.164, with or without the leading '+' */
  to: string;
  audio: SpokenAudio;
}

export interface SendVoiceResult {
  providerMessageId: string;
}

export interface WhatsAppSender {
  readonly name: string;
  sendVoice(args: SendVoiceArgs): Promise<SendVoiceResult>;
}

export class MetaWhatsAppSender implements WhatsAppSender {
  readonly name = 'meta';

  constructor(
    private readonly accessToken: string,
    private readonly phoneNumberId: string,
  ) {
    if (!accessToken) throw new Error('MetaWhatsAppSender requires an access token');
    if (!phoneNumberId) throw new Error('MetaWhatsAppSender requires a phone number id');
  }

  async sendVoice(args: SendVoiceArgs): Promise<SendVoiceResult> {
    const mediaId = await this.uploadMedia(args.audio);

    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${this.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: args.to.replace(/^\+/, ''),
          type: 'audio',
          audio: { id: mediaId },
        }),
      },
    );

    const text = await res.text();
    if (!res.ok) {
      // 131047 is the re-engagement error: no open 24-hour window. It reads
      // like a broken token if you have not seen it before, so keep the code.
      throw new Error(`whatsapp send failed: ${res.status} ${text}`);
    }

    const json = JSON.parse(text) as { messages?: Array<{ id?: string }> };
    const id = json.messages?.[0]?.id;
    if (!id) throw new Error(`whatsapp send returned no message id: ${text}`);
    return { providerMessageId: id };
  }

  private async uploadMedia(audio: SpokenAudio): Promise<string> {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', audio.mimeType);
    form.append('file', new Blob([audio.bytes], { type: audio.mimeType }), 'voice.ogg');

    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${this.phoneNumberId}/media`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.accessToken}` },
        body: form,
      },
    );

    const text = await res.text();
    if (!res.ok) throw new Error(`whatsapp media upload failed: ${res.status} ${text}`);
    const json = JSON.parse(text) as { id?: string };
    if (!json.id) throw new Error(`whatsapp media upload returned no id: ${text}`);
    return json.id;
  }
}

export class MockWhatsAppSender implements WhatsAppSender {
  readonly name = 'mock';
  readonly sent: SendVoiceArgs[] = [];

  async sendVoice(args: SendVoiceArgs): Promise<SendVoiceResult> {
    this.sent.push(args);
    const id = `mock_wa_${randomUUID().slice(0, 12)}`;
    console.log(`[mock-whatsapp] → ${args.to} | ${args.audio.bytes.length} bytes | ${id}`);
    return { providerMessageId: id };
  }
}
