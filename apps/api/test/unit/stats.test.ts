import { describe, expect, it } from 'vitest';
import { twoProportionCI } from '../../src/attribution/stats.js';

describe('two-proportion CI', () => {
  it('computes incremental rate and CI', () => {
    const r = twoProportionCI(450, 900, 30, 100);
    expect(r.p1).toBeCloseTo(0.5);
    expect(r.p2).toBeCloseTo(0.3);
    expect(r.diff).toBeCloseTo(0.2);
    expect(r.ciLow).toBeLessThan(0.2);
    expect(r.ciHigh).toBeGreaterThan(0.2);
    // hand-computed SE: sqrt(0.25/900 + 0.21/100) ≈ 0.04886 → CI ≈ 0.2 ± 0.0958
    expect(r.ciLow).toBeCloseTo(0.2 - 1.96 * 0.048876, 3);
    expect(r.ciHigh).toBeCloseTo(0.2 + 1.96 * 0.048876, 3);
  });
  it('handles empty arms without dividing by zero', () => {
    const r = twoProportionCI(0, 0, 0, 0);
    expect(r.diff).toBe(0);
    expect(Number.isNaN(r.ciLow)).toBe(true);
  });
  it('zero-difference case straddles zero', () => {
    const r = twoProportionCI(50, 100, 50, 100);
    expect(r.diff).toBe(0);
    expect(r.ciLow).toBeLessThan(0);
    expect(r.ciHigh).toBeGreaterThan(0);
  });
});
