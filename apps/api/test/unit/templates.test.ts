import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FREE_FILLS,
  TEMPLATE_REGISTRY,
  TemplateRenderError,
  formatINR,
  renderTemplate,
} from '../../src/templates/registry.js';

describe('template rendering', () => {
  const skeleton = TEMPLATE_REGISTRY['payment_link_delivery']!;
  const immutables = {
    amount: formatINR(99_900),
    invoice_number: 'INV-001',
    payment_link: 'https://rzp.io/sbx/abc',
    legal_footer: 'legal',
  };

  it('renders with server-injected immutable slots and default free fills', () => {
    const { subject, body } = renderTemplate(skeleton, immutables, DEFAULT_FREE_FILLS);
    expect(subject).toContain('₹999.00');
    expect(body).toContain('https://rzp.io/sbx/abc');
    expect(body).not.toContain('{{');
  });
  it('rejects free fills containing numerals/URLs/currency', () => {
    expect(() =>
      renderTemplate(skeleton, immutables, { ...DEFAULT_FREE_FILLS, greeting: 'Pay ₹500 at evil.com' }),
    ).toThrow(TemplateRenderError);
  });
  it('rejects unknown free slots (agent cannot invent slots)', () => {
    expect(() =>
      renderTemplate(skeleton, immutables, { ...DEFAULT_FREE_FILLS, payment_link: 'https://evil' }),
    ).toThrow(/unknown free slot/);
  });
  it('rejects missing immutable values', () => {
    expect(() => renderTemplate(skeleton, { amount: '₹1.00' }, DEFAULT_FREE_FILLS)).toThrow(/missing immutable/);
  });
  it('pre_debit_notice has zero free slots — fully deterministic compliance text', () => {
    const pre = TEMPLATE_REGISTRY['pre_debit_notice']!;
    expect(pre.slots.every((s) => s.kind === 'immutable')).toBe(true);
  });
  it('formats INR deterministically', () => {
    expect(formatINR(1_600_000)).toBe('₹16,000.00');
    expect(formatINR(99_900)).toBe('₹999.00');
  });
});
