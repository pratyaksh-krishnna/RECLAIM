import type { HoldoutArm } from '@reclaim/shared';

export const HOLDOUT_FRACTION = 0.1;

/**
 * Random arm assignment at case creation. 90% treatment / 10% holdout.
 * rng injectable for deterministic tests; production uses Math.random.
 */
export function assignArm(rng: () => number = Math.random): HoldoutArm {
  return rng() < HOLDOUT_FRACTION ? 'holdout' : 'treatment';
}

/** Attribution window lengths per leak type (days). */
export function attributionWindowDays(leakType: 'subscription_payment_failure' | 'invoice_overdue' | 'unknown'): number {
  return leakType === 'invoice_overdue' ? 90 : 30;
}
