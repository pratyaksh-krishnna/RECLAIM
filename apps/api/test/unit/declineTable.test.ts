import { describe, expect, it } from 'vitest';
import { classifyDeclineCode, isRetryableClass } from '../../src/domain/declineTable.js';

describe('decline table', () => {
  it('classifies hard declines', () => {
    expect(classifyDeclineCode('expired_card')).toBe('hard');
    expect(classifyDeclineCode('mandate_cancelled')).toBe('hard');
  });
  it('classifies soft declines', () => {
    expect(classifyDeclineCode('insufficient_funds')).toBe('soft');
    expect(classifyDeclineCode('upi_insufficient_balance')).toBe('soft');
  });
  it('unknown or missing codes are ambiguous (route to triage agent)', () => {
    expect(classifyDeclineCode('do_not_honor')).toBe('ambiguous');
    expect(classifyDeclineCode('something_new')).toBe('ambiguous');
    expect(classifyDeclineCode(null)).toBe('ambiguous');
  });
  it('is case-insensitive', () => {
    expect(classifyDeclineCode('EXPIRED_CARD')).toBe('hard');
  });
  it('hard and auth classes are never retryable; soft and processor are', () => {
    expect(isRetryableClass('hard')).toBe(false);
    expect(isRetryableClass('auth_required')).toBe(false);
    expect(isRetryableClass('ambiguous')).toBe(false);
    expect(isRetryableClass('soft')).toBe(true);
    expect(isRetryableClass('processor_error')).toBe(true);
  });
});
