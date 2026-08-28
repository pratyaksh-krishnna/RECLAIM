import type { Language } from '@reclaim/shared';

/**
 * Text-to-speech seam. Mirrors the Mailer interface in
 * apps/api/src/mailer/mailer.ts: one interface, one real adapter, one mock.
 *
 * The mock is not a fallback. Like MAILER_MODE it is an explicit mode, chosen
 * so tests and CI never reach a paid API.
 */

export interface SpokenAudio {
  bytes: Buffer;
  mimeType: string;
  /** Sarvam's request_id, kept for support tickets; null from the mock */
  requestId: string | null;
}

export interface SpeakArgs {
  script: string;
  language: Language;
  speaker?: string;
}

export interface VoiceSynthesizer {
  readonly name: string;
  speak(args: SpeakArgs): Promise<SpokenAudio>;
}

/** Sarvam's REST limit. Checked before the call so an over-long script costs nothing. */
const MAX_SCRIPT_CHARS = 2500;

/**
 * Lowest critical-error-rate speaker in Sarvam's own published ranking (0.00%).
 * Names are case-sensitive and must be lowercase.
 */
export const DEFAULT_SPEAKER = 'mani';

/**
 * Sarvam has no Hinglish language code. Hinglish fills are Latin-script, so the
 * Indian-English voice reads them correctly; hi-IN would mispronounce them.
 */
export function sarvamLanguageCode(language: Language): string {
  switch (language) {
    case 'hi':
      return 'hi-IN';
    case 'en':
    case 'hinglish':
      return 'en-IN';
  }
}

export class SarvamSynthesizer implements VoiceSynthesizer {
  readonly name = 'sarvam';

  constructor(private readonly apiKey: string) {
    if (!apiKey) throw new Error('SarvamSynthesizer requires an API key; set SARVAM_API_KEY');
  }

  async speak(args: SpeakArgs): Promise<SpokenAudio> {
    if (args.script.length > MAX_SCRIPT_CHARS) {
      throw new Error(
        `voice script is ${args.script.length} characters; Sarvam accepts at most ${MAX_SCRIPT_CHARS} characters`,
      );
    }

    const res = await fetch('https://api.sarvam.ai/text-to-speech', {
      method: 'POST',
      headers: {
        'api-subscription-key': this.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        text: args.script,
        model: 'bulbul:v3',
        language_code: sarvamLanguageCode(args.language),
        speaker: args.speaker ?? DEFAULT_SPEAKER,
        // opus, not the wav default: WhatsApp renders audio/ogg;codecs=opus as a
        // real voice note with a waveform, and it is ~20x smaller than wav.
        output_audio_codec: 'opus',
        enable_preprocessing: true,
      }),
    });

    if (!res.ok) {
      throw new Error(`sarvam tts failed: ${res.status} ${await res.text()}`);
    }

    const json = (await res.json()) as { request_id?: string; audios?: string[] };
    const joined = (json.audios ?? []).join('');
    if (!joined) throw new Error('sarvam tts returned no audio');

    return {
      bytes: Buffer.from(joined, 'base64'),
      mimeType: 'audio/ogg',
      requestId: json.request_id ?? null,
    };
  }
}

/**
 * A valid, tiny OGG container. Enough for the pipeline to carry real bytes
 * end to end without a network call; not enough to actually play.
 */
const MOCK_OGG = Buffer.from('T2dnUwACAAAAAAAAAAAAAAAAAAAAAAAAAA==', 'base64');

export class MockSynthesizer implements VoiceSynthesizer {
  readonly name = 'mock';
  async speak(args: SpeakArgs): Promise<SpokenAudio> {
    console.log(
      `[mock-voice] ${args.language} | ${args.script.length} chars | ${args.script.slice(0, 60)}…`,
    );
    return { bytes: MOCK_OGG, mimeType: 'audio/ogg', requestId: null };
  }
}
