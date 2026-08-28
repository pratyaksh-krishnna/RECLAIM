import { describe, expect, it } from 'vitest';
import { formatINRForSpeech } from '../src/money.js';

describe('formatINRForSpeech', () => {
  it('drops a zero paise component', () => {
    expect(formatINRForSpeech(249_900)).toBe('2,499 rupees');
    expect(formatINRForSpeech(250_000)).toBe('2,500 rupees');
  });

  it('speaks a non-zero paise component', () => {
    expect(formatINRForSpeech(249_950)).toBe('2,499 rupees 50 paise');
    expect(formatINRForSpeech(100_001)).toBe('1,000 rupees 1 paisa');
  });

  it('singularises at exactly one', () => {
    expect(formatINRForSpeech(100)).toBe('1 rupee');
    expect(formatINRForSpeech(101)).toBe('1 rupee 1 paisa');
  });

  it('emits only paise when the rupee component is zero', () => {
    expect(formatINRForSpeech(50)).toBe('50 paise');
    expect(formatINRForSpeech(1)).toBe('1 paisa');
  });

  it('uses Indian digit grouping at lakh scale', () => {
    expect(formatINRForSpeech(1_50_00_000)).toBe('1,50,000 rupees');
  });

  it('never emits a currency glyph or a decimal point', () => {
    for (const paise of [1, 50, 100, 249_950, 1_50_00_000]) {
      const spoken = formatINRForSpeech(paise);
      expect(spoken).not.toMatch(/[₹.]/);
    }
  });

  it('rejects a non-integer or negative amount', () => {
    expect(() => formatINRForSpeech(-1)).toThrow(/non-negative integer paise/);
    expect(() => formatINRForSpeech(1.5)).toThrow(/non-negative integer paise/);
  });
});
