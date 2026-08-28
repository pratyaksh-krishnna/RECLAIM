import { describe, expect, it } from 'vitest';
import { TEMPLATE_REGISTRY, TemplateRenderError } from '@reclaim/api/templates/registry';
import type { TemplateId } from '@reclaim/shared';
import { VOICE_SCRIPTS, buildVoiceImmutableValues, renderVoiceScript } from '../src/voiceScript.js';

const FILLS = {
  greeting: 'Hello Priya,',
  context_sentence: 'We noticed something went wrong with your recent payment.',
  sign_off: 'Thank you, the billing team.',
};

describe('VOICE_SCRIPTS coverage', () => {
  it('has a script for every template in the registry', () => {
    for (const id of Object.keys(TEMPLATE_REGISTRY) as TemplateId[]) {
      expect(VOICE_SCRIPTS[id], `missing voice script for ${id}`).toBeTruthy();
    }
  });

  it('never speaks a payment link', () => {
    for (const [id, script] of Object.entries(VOICE_SCRIPTS)) {
      expect(script, `${id} speaks a URL`).not.toContain('{{payment_link}}');
    }
  });

  it('references only slots its skeleton declares', () => {
    for (const [id, script] of Object.entries(VOICE_SCRIPTS)) {
      const declared = new Set(TEMPLATE_REGISTRY[id as TemplateId].slots.map((s) => s.name));
      for (const m of script.matchAll(/\{\{(\w+)\}\}/g)) {
        expect(declared.has(m[1]!), `${id} references undeclared slot ${m[1]}`).toBe(true);
      }
    }
  });

  it('stays under Sarvam’s 2,500 character limit once rendered', () => {
    for (const id of Object.keys(VOICE_SCRIPTS) as TemplateId[]) {
      const skeleton = TEMPLATE_REGISTRY[id];
      const immutables = buildVoiceImmutableValues(
        id,
        249_900,
        'INV-4271',
        'Priya Sharma',
        '1 September 2026',
      );
      // Only the fills this skeleton actually declares. pre_debit_notice is a
      // compliance notice with NO free slots, so handing it a greeting is an
      // "unknown free slot" error — correctly.
      const declared = new Set(skeleton.slots.filter((s) => s.kind === 'free').map((s) => s.name));
      const fills = Object.fromEntries(Object.entries(FILLS).filter(([k]) => declared.has(k)));
      const spoken = renderVoiceScript(skeleton, VOICE_SCRIPTS[id], immutables, fills);
      expect(spoken.length).toBeLessThan(2500);
    }
  });
});

describe('renderVoiceScript', () => {
  const skeleton = TEMPLATE_REGISTRY['payment_failed_notice'];
  const script = VOICE_SCRIPTS['payment_failed_notice'];
  const immutables = buildVoiceImmutableValues(
    'payment_failed_notice',
    249_900,
    'INV-4271',
    'Priya Sharma',
  );

  it('injects the spoken amount, not the written one', () => {
    const spoken = renderVoiceScript(skeleton, script, immutables, FILLS);
    expect(spoken).toContain('2,499 rupees');
    expect(spoken).not.toContain('₹');
    expect(spoken).not.toContain('{{');
  });

  it('renders without a payment_link value, unlike renderTemplate', () => {
    // The whole point: renderTemplate demands a value for EVERY declared
    // immutable slot, which for this skeleton includes payment_link. A voice
    // script omits it by design, so requiring it would fail every render.
    expect(immutables).not.toHaveProperty('payment_link');
    expect(() => renderVoiceScript(skeleton, script, immutables, FILLS)).not.toThrow();
  });

  it('rejects free fills containing numerals, URLs, or currency', () => {
    expect(() =>
      renderVoiceScript(skeleton, script, immutables, { ...FILLS, greeting: 'Pay ₹500 at evil.com' }),
    ).toThrow(TemplateRenderError);
  });

  it('rejects a fill for a slot the skeleton does not declare', () => {
    expect(() =>
      renderVoiceScript(skeleton, script, immutables, { ...FILLS, payment_link: 'https://evil' }),
    ).toThrow(/unknown free slot/);
  });

  it('throws when a referenced immutable value is missing', () => {
    const { amount: _dropped, ...withoutAmount } = immutables;
    expect(() => renderVoiceScript(skeleton, script, withoutAmount, FILLS)).toThrow(
      /missing immutable slot value 'amount'/,
    );
  });

  it('throws on a slot the skeleton does not declare at all', () => {
    expect(() => renderVoiceScript(skeleton, 'Hello {{nonsense}}', immutables, FILLS)).toThrow(
      /undeclared slot/,
    );
  });
});
