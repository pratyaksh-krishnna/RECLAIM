import { env } from '../config/env.js';
import { MockSynthesizer, SarvamSynthesizer } from './voice.js';
import type { VoiceSynthesizer } from './voice.js';

/**
 * Which synthesizer runs. Unlike the LlmClient seam, mock is a real option
 * here: audio is an accompaniment, and CI must never call a paid API.
 */
export function getVoiceSynthesizer(): VoiceSynthesizer {
  return env.VOICE_MODE === 'mock'
    ? new MockSynthesizer()
    : new SarvamSynthesizer(env.SARVAM_API_KEY);
}

export { DEFAULT_SPEAKER, MockSynthesizer, SarvamSynthesizer, sarvamLanguageCode } from './voice.js';
export type { SpeakArgs, SpokenAudio, VoiceSynthesizer } from './voice.js';
