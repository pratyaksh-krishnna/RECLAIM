import { describe, expect, it } from 'vitest';
import { lintFreeSlotFills } from '../src/messaging.js';

describe('lintFreeSlotFills', () => {
  it('passes clean conversational text', () => {
    expect(lintFreeSlotFills({ greeting: 'Namaste Priya ji, hope you are doing well.' })).toEqual([]);
  });
  it('rejects ASCII numerals', () => {
    expect(lintFreeSlotFills({ ctx: 'pay 500 now' })).toContainEqual(
      expect.objectContaining({ rule: 'numeral' }),
    );
  });
  it('rejects Devanagari numerals', () => {
    expect(lintFreeSlotFills({ ctx: 'कृपया ५०० भेजें' })).toContainEqual(
      expect.objectContaining({ rule: 'numeral' }),
    );
  });
  it('rejects URLs in any form', () => {
    for (const s of ['visit https://x.co', 'go to www.pay.me', 'evil.com now']) {
      expect(lintFreeSlotFills({ ctx: s }).some((v) => v.rule === 'url')).toBe(true);
    }
  });
  it('rejects currency symbols and words', () => {
    for (const s of ['₹ due', 'Rs pending', 'INR owed', 'send rupees please', '$ owed']) {
      expect(lintFreeSlotFills({ ctx: s }).some((v) => v.rule === 'currency')).toBe(true);
    }
  });
  it('rejects HTML angle brackets', () => {
    expect(lintFreeSlotFills({ ctx: '<a href=x>click</a>' }).some((v) => v.rule === 'html')).toBe(true);
  });
});
