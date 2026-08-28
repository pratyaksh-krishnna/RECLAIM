import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetaWhatsAppSender, MockWhatsAppSender } from '../src/whatsapp.js';

const AUDIO = { bytes: Buffer.from('OggS-fake'), mimeType: 'audio/ogg', requestId: 'req_1' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MetaWhatsAppSender', () => {
  it('refuses to construct without credentials', () => {
    expect(() => new MetaWhatsAppSender('', 'pnid')).toThrow(/requires an access token/);
    expect(() => new MetaWhatsAppSender('tok', '')).toThrow(/requires a phone number id/);
  });

  it('uploads the media, then sends a message referencing the returned id', async () => {
    const calls: Array<{ url: string; body: unknown; auth: string | undefined }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const headers = init.headers as Record<string, string>;
        calls.push({ url, body: init.body, auth: headers?.['Authorization'] });
        if (url.includes('/media')) {
          return new Response(JSON.stringify({ id: 'media_abc' }), { status: 200 });
        }
        return new Response(JSON.stringify({ messages: [{ id: 'wamid.XYZ' }] }), { status: 200 });
      }),
    );

    const result = await new MetaWhatsAppSender('tok_1', '55501').sendVoice({
      to: '+919812345678',
      audio: AUDIO,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe('https://graph.facebook.com/v21.0/55501/media');
    expect(calls[0]!.auth).toBe('Bearer tok_1');
    expect(calls[0]!.body).toBeInstanceOf(FormData);

    expect(calls[1]!.url).toBe('https://graph.facebook.com/v21.0/55501/messages');
    expect(JSON.parse(calls[1]!.body as string)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '919812345678', // leading + stripped: Graph wants bare digits
      type: 'audio',
      audio: { id: 'media_abc' },
    });

    expect(result.providerMessageId).toBe('wamid.XYZ');
  });

  it('surfaces a closed 24-hour window as a recognisable error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/media')) return new Response(JSON.stringify({ id: 'm' }), { status: 200 });
        return new Response(
          JSON.stringify({ error: { code: 131047, message: 'Re-engagement message' } }),
          { status: 400 },
        );
      }),
    );
    await expect(
      new MetaWhatsAppSender('tok', 'pn').sendVoice({ to: '+91981', audio: AUDIO }),
    ).rejects.toThrow(/131047/);
  });

  it('throws when the media upload fails, without attempting to send', async () => {
    const fetchSpy = vi.fn(async () => new Response('bad token', { status: 401 }));
    vi.stubGlobal('fetch', fetchSpy);
    await expect(
      new MetaWhatsAppSender('tok', 'pn').sendVoice({ to: '+91981', audio: AUDIO }),
    ).rejects.toThrow(/media upload failed: 401/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('MockWhatsAppSender', () => {
  it('records the send and makes no network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const sender = new MockWhatsAppSender();
    const result = await sender.sendVoice({ to: '+919812345678', audio: AUDIO });
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.to).toBe('+919812345678');
    expect(result.providerMessageId).toMatch(/^mock_wa_/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
