import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockSynthesizer, SarvamSynthesizer, sarvamLanguageCode } from '../src/voice.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sarvamLanguageCode', () => {
  it('maps the RECLAIM language enum to BCP-47', () => {
    expect(sarvamLanguageCode('en')).toBe('en-IN');
    expect(sarvamLanguageCode('hi')).toBe('hi-IN');
  });

  it('maps hinglish to Indian English, since Sarvam has no Hinglish code', () => {
    expect(sarvamLanguageCode('hinglish')).toBe('en-IN');
  });
});

describe('SarvamSynthesizer', () => {
  it('refuses to construct without a key', () => {
    expect(() => new SarvamSynthesizer('')).toThrow(/requires an API key/);
  });

  it('posts the documented request shape and decodes the base64 response', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        seen.url = url;
        seen.init = init;
        return new Response(
          JSON.stringify({ request_id: 'req_1', audios: [Buffer.from('AB').toString('base64')] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    const audio = await new SarvamSynthesizer('key_123').speak({ script: 'Hello', language: 'hi' });

    expect(seen.url).toBe('https://api.sarvam.ai/text-to-speech');
    const headers = seen.init!.headers as Record<string, string>;
    expect(headers['api-subscription-key']).toBe('key_123');
    expect(headers['Authorization']).toBeUndefined(); // Sarvam does not use bearer auth
    const body = JSON.parse(seen.init!.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      text: 'Hello',
      model: 'bulbul:v3',
      language_code: 'hi-IN',
      speaker: 'mani',
      output_audio_codec: 'opus',
      // opus rejects the 22050 default outright; see the comment in voice.ts
      speech_sample_rate: 24000,
    });
    expect(audio.bytes.toString()).toBe('AB');
    expect(audio.mimeType).toBe('audio/ogg');
    expect(audio.requestId).toBe('req_1');
  });

  it('joins a multi-part audios array before decoding', async () => {
    const whole = Buffer.from('HELLOWORLD');
    const b64 = whole.toString('base64');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ audios: [b64.slice(0, 4), b64.slice(4)] }), { status: 200 }),
      ),
    );
    const audio = await new SarvamSynthesizer('k').speak({ script: 'x', language: 'en' });
    expect(audio.bytes.equals(whole)).toBe(true);
  });

  it('rejects a script over Sarvam’s 2,500 character limit before spending a call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(
      new SarvamSynthesizer('k').speak({ script: 'a'.repeat(2501), language: 'en' }),
    ).rejects.toThrow(/2500 characters/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws with the provider status and body on a non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('quota exceeded', { status: 429 })));
    await expect(new SarvamSynthesizer('k').speak({ script: 'x', language: 'en' })).rejects.toThrow(
      /sarvam tts failed: 429 quota exceeded/,
    );
  });

  it('throws when the response carries no audio', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ audios: [] }), { status: 200 })),
    );
    await expect(new SarvamSynthesizer('k').speak({ script: 'x', language: 'en' })).rejects.toThrow(
      /returned no audio/,
    );
  });
});

describe('MockSynthesizer', () => {
  it('returns deterministic non-empty ogg bytes without any network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const audio = await new MockSynthesizer().speak({ script: 'anything', language: 'en' });
    expect(audio.bytes.length).toBeGreaterThan(0);
    expect(audio.mimeType).toBe('audio/ogg');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
