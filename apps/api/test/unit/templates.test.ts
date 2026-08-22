import { describe, expect, it } from 'vitest';
import { ActionParams } from '@reclaim/shared';
import {
  DEFAULT_FREE_FILLS,
  TEMPLATE_REGISTRY,
  TemplateRenderError,
  formatINR,
  renderTemplate,
  validateFreeFills,
} from '../../src/templates/registry.js';

/** immutable values the payment_reminder skeleton needs to render at all */
const IMMUTABLES_FOR_REMINDER = {
  amount: formatINR(99_900),
  invoice_number: 'INV-001',
  due_date: '1 August 2026',
  legal_footer: 'legal',
};

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

describe('templateId is a closed enum (agents cannot invent templates)', () => {
  it('rejects a hallucinated template id at the schema gate', () => {
    // These are real ids Haiku invented in a live run; each stranded a case
    // because templateId used to be a free string that only failed at the tool.
    for (const bogus of [
      'soft_decline_insufficient_funds',
      'expired_card_recovery',
      'card_expiry_renewal_prompt',
      'invoice_overdue_initial_outreach',
    ]) {
      const result = ActionParams.safeParse({
        type: 'send_email',
        templateId: bogus,
        language: 'en',
        toneRegister: 'formal',
        slotFills: {},
      });
      expect(result.success).toBe(false);
    }
  });

  it('accepts every id in the approved registry', () => {
    for (const id of Object.keys(TEMPLATE_REGISTRY)) {
      const result = ActionParams.safeParse({
        type: 'send_email',
        templateId: id,
        language: 'en',
        toneRegister: 'formal',
        slotFills: {},
      });
      expect(result.success).toBe(true);
    }
  });
});

describe('agent-time validation matches render-time validation', () => {
  const skeleton = TEMPLATE_REGISTRY.payment_reminder;
  const tooLong = 'x'.repeat(121); // sign_off maxLength is 120

  it('rejects an over-long free fill BEFORE it reaches the tool', () => {
    // the gap that stranded live cases: renderTemplate threw on maxLength but
    // the agent-time gate never checked it, so the failure surfaced only at
    // execution — after the policy gate had already approved the action
    const problems = validateFreeFills(skeleton, { sign_off: tooLong });
    expect(problems.join(' ')).toContain('exceeds max length');
  });

  it('rejects an invented slot at the agent gate too', () => {
    const problems = validateFreeFills(skeleton, { made_up_slot: 'hello' });
    expect(problems.join(' ')).toContain('unknown free slot');
  });

  it('still catches numerals/links/currency', () => {
    expect(validateFreeFills(skeleton, { sign_off: 'Pay 500 now' }).join(' ')).toContain('numeral');
    expect(validateFreeFills(skeleton, { sign_off: 'see example.com' }).join(' ')).toContain('url');
  });

  it('accepts a clean fill', () => {
    expect(validateFreeFills(skeleton, { sign_off: 'Warm regards, the billing team' })).toEqual([]);
  });

  /**
   * The invariant that was violated: anything the renderer rejects must be
   * rejected at the agent gate, so a bad fill is retried and regenerated
   * instead of stranding the case in 'escalated' with an engineering error.
   */
  it('never lets a render-time failure through the agent gate', () => {
    const badFills: Array<Record<string, string>> = [
      { sign_off: tooLong },
      { greeting: 'x'.repeat(121) },
      { context_sentence: 'x'.repeat(301) },
      { made_up_slot: 'hello' },
      { sign_off: 'Pay 500' },
      { sign_off: 'visit example.com' },
      { sign_off: 'costs ₹99' },
    ];
    for (const fills of badFills) {
      let rendererRejected = false;
      try {
        renderTemplate(skeleton, IMMUTABLES_FOR_REMINDER, fills);
      } catch {
        rendererRejected = true;
      }
      expect(rendererRejected, `renderer should reject ${JSON.stringify(fills)}`).toBe(true);
      expect(
        validateFreeFills(skeleton, fills).length,
        `agent gate MUST also reject ${JSON.stringify(fills)}`,
      ).toBeGreaterThan(0);
    }
  });
});
