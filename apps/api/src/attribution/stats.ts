/**
 * Two-proportion statistics for treatment-vs-holdout incremental recovery.
 * Pure arithmetic (normal approximation) — this is statistics, not ML.
 */
export interface TwoProportionResult {
  p1: number; // treatment recovery rate
  p2: number; // holdout recovery rate
  diff: number; // incremental rate (p1 - p2)
  ciLow: number;
  ciHigh: number;
  zUsed: number;
  n1: number;
  n2: number;
}

export function twoProportionCI(
  successes1: number,
  n1: number,
  successes2: number,
  n2: number,
  z = 1.96,
): TwoProportionResult {
  const p1 = n1 > 0 ? successes1 / n1 : 0;
  const p2 = n2 > 0 ? successes2 / n2 : 0;
  const diff = p1 - p2;
  if (n1 === 0 || n2 === 0) {
    return { p1, p2, diff, ciLow: Number.NaN, ciHigh: Number.NaN, zUsed: z, n1, n2 };
  }
  const se = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);
  return { p1, p2, diff, ciLow: diff - z * se, ciHigh: diff + z * se, zUsed: z, n1, n2 };
}
