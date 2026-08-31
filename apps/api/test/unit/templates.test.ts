import { describe, expect, it } from 'vitest';
import { ActionParams, Language, type TemplateId } from '@reclaim/shared';
import {
  DEFAULT_FREE_FILLS,
  LEGAL_FOOTERS,
  TEMPLATE_REGISTRY,
  TemplateRenderError,
  formatDateIST,
  formatINR,
  formatINRForSpeech,
  formatInvoiceRefForSpeech,
  needsPaymentLink,
  renderTemplate,
  renderVoiceScript,
  validateFreeFills,
} from '../../src/templates/registry.js';

const LANGUAGES = Language.options;
import { buildImmutableValues } from '../../src/tools/execute.js';

/** immutable values the payment_reminder skeleton needs to render at all */
const IMMUTABLES_FOR_REMINDER = {
  amount: formatINR(99_900),
  invoice_number: 'INV-001',
  due_date: '1 August 2026',
  payment_link: 'https://rzp.io/sbx/abc',
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
    const { subject, body } = renderTemplate(skeleton, 'en', immutables, DEFAULT_FREE_FILLS.en);
    expect(subject).toContain('₹999.00');
    expect(body).toContain('https://rzp.io/sbx/abc');
    expect(body).not.toContain('{{');
  });
  it('rejects free fills containing numerals/URLs/currency', () => {
    expect(() =>
      renderTemplate(skeleton, 'en', immutables, { ...DEFAULT_FREE_FILLS.en, greeting: 'Pay ₹500 at evil.com' }),
    ).toThrow(TemplateRenderError);
  });
  it('rejects unknown free slots (agent cannot invent slots)', () => {
    expect(() =>
      renderTemplate(skeleton, 'en', immutables, { ...DEFAULT_FREE_FILLS.en, payment_link: 'https://evil' }),
    ).toThrow(/unknown free slot/);
  });
  it('rejects missing immutable values', () => {
    expect(() => renderTemplate(skeleton, 'en', { amount: '₹1.00' }, DEFAULT_FREE_FILLS.en)).toThrow(/missing immutable/);
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
        renderTemplate(skeleton, 'en', IMMUTABLES_FOR_REMINDER, fills);
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

/**
 * The strategy agent may set `templateId` to ANY member of the closed
 * TemplateId enum, so every template send_email accepts must be renderable
 * from server state alone.
 *
 * payment_link_delivery was not. It has always declared {{payment_link}} and
 * has always been reachable from send_email, but only the create_payment_link
 * tool ever supplied that value — so an agent naming it stranded the case in
 * the human inbox with "missing immutable slot value 'payment_link'": an
 * engineering error dressed up as a business decision, which is exactly what
 * closing templateId to an enum was supposed to prevent.
 */
describe('send_email can render every template it is allowed to name', () => {
  const invoice = {
    id: '0e322da4-743a-43c1-85b8-ab6d9e135a36',
    providerInvoiceId: 'INV-001',
    dueDate: new Date('2026-08-01T00:00:00Z'),
  } as Parameters<typeof buildImmutableValues>[1];

  const SEND_EMAIL_TEMPLATES = (Object.keys(TEMPLATE_REGISTRY) as TemplateId[]).filter(
    (id) => id !== 'pre_debit_notice',
  );

  it.each(SEND_EMAIL_TEMPLATES)('%s renders from server state alone', (templateId) => {
    const skeleton = TEMPLATE_REGISTRY[templateId];
    const values = buildImmutableValues(templateId, invoice, 99_900, 'en');
    // the same question runTool asks before generating a link
    if (needsPaymentLink(skeleton)) values['payment_link'] = 'https://rzp.io/sbx/abc';

    const missing = skeleton.slots
      .filter((slot) => slot.kind === 'immutable' && !(slot.name in values))
      .map((slot) => slot.name);
    expect(missing).toEqual([]);
    expect(() => renderTemplate(skeleton, 'en', values, DEFAULT_FREE_FILLS.en)).not.toThrow();
  });

  it('pre_debit_notice is refused by send_email because server state cannot fill it', () => {
    const skeleton = TEMPLATE_REGISTRY['pre_debit_notice'];
    const values = buildImmutableValues('pre_debit_notice', invoice, 99_900, 'en');
    const missing = skeleton.slots
      .filter((slot) => slot.kind === 'immutable' && !(slot.name in values))
      .map((slot) => slot.name);
    // both only exist once a mandate debit has actually been scheduled, which
    // is why schedule_mandate_reexecution owns this template
    expect(missing).toEqual(['customer_name', 'debit_date']);
  });
});

describe('formatINRForSpeech', () => {
  it('drops a zero paise component and never emits a glyph or a decimal point', () => {
    expect(formatINRForSpeech(249_900, 'en')).toBe('2,499 rupees');
    expect(formatINRForSpeech(249_900, 'en')).not.toMatch(/[₹.]/);
  });
  it('speaks a non-zero paise component and singularises at one', () => {
    expect(formatINRForSpeech(249_950, 'en')).toBe('2,499 rupees 50 paise');
    expect(formatINRForSpeech(100, 'en')).toBe('1 rupee');
    expect(formatINRForSpeech(1, 'en')).toBe('1 paisa');
  });
  it('emits only paise when the rupee component is zero', () => {
    expect(formatINRForSpeech(50, 'en')).toBe('50 paise');
    expect(formatINRForSpeech(1, 'en')).toBe('1 paisa');
  });
  it('uses Indian digit grouping at lakh scale', () => {
    expect(formatINRForSpeech(1_50_00_000, 'en')).toBe('1,50,000 rupees');
  });
  it('rejects a non-integer or negative amount', () => {
    expect(() => formatINRForSpeech(-1, 'en')).toThrow(/non-negative integer paise/);
    expect(() => formatINRForSpeech(1.5, 'en')).toThrow(/non-negative integer paise/);
  });
});

describe('voice script coverage', () => {
  // Each rule below held for one English string and now has to hold for every
  // language: a translation is a place for a {{payment_link}} or a dangling
  // sign-off to reappear, and only the English one was ever being read.
  it('every template has a voice script in every language', () => {
    for (const id of Object.keys(TEMPLATE_REGISTRY) as TemplateId[]) {
      for (const lang of LANGUAGES) {
        expect(TEMPLATE_REGISTRY[id].voiceScript[lang], `${id}/${lang} has no voiceScript`).toBeTruthy();
      }
    }
  });
  it('no voice script speaks a payment link or legal footer', () => {
    for (const [id, s] of Object.entries(TEMPLATE_REGISTRY)) {
      for (const lang of LANGUAGES) {
        expect(s.voiceScript[lang], `${id}/${lang} speaks a URL`).not.toContain('{{payment_link}}');
        expect(s.voiceScript[lang], `${id}/${lang} speaks legal boilerplate`).not.toContain('{{legal_footer}}');
      }
    }
  });
  it('no voice script references a slot its skeleton does not declare', () => {
    for (const [id, s] of Object.entries(TEMPLATE_REGISTRY)) {
      const declared = new Set(s.slots.map((slot) => slot.name));
      for (const lang of LANGUAGES) {
        for (const m of s.voiceScript[lang].matchAll(/\{\{(\w+)\}\}/g)) {
          expect(declared.has(m[1]!), `${id}/${lang} references undeclared slot ${m[1]}`).toBe(true);
        }
      }
    }
  });
  it('ends on the sign-off, not mid-message', () => {
    // The email body puts {{sign_off}} above {{legal_footer}}; voice does not
    // speak the footer, so copying that order left the sign-off dangling on
    // its comma before the opt-out sentence.
    for (const [id, s] of Object.entries(TEMPLATE_REGISTRY)) {
      for (const lang of LANGUAGES) {
        if (!s.voiceScript[lang].includes('{{sign_off}}')) continue;
        expect(s.voiceScript[lang].trimEnd().endsWith('{{sign_off}}'), `${id}/${lang} buries its sign-off`).toBe(true);
      }
    }
  });
});

describe('renderVoiceScript', () => {
  const skeleton = TEMPLATE_REGISTRY['payment_failed_notice'];
  const immutables = { amount: formatINRForSpeech(99_900, 'en'), invoice_number: 'INV-001' };

  it('speaks the amount and never the link', () => {
    const spoken = renderVoiceScript(skeleton, 'en', immutables, DEFAULT_FREE_FILLS.en);
    expect(spoken).toContain('999 rupees');
    expect(spoken).not.toContain('http');
    expect(spoken).not.toContain('{{');
  });

  it('renders without a payment_link value, unlike renderTemplate', () => {
    // renderTemplate demands a value for EVERY declared immutable slot, which
    // here includes payment_link. A voice script omits it by design, so
    // reusing that rule would fail every render.
    expect(() => renderTemplate(skeleton, 'en', immutables, DEFAULT_FREE_FILLS.en)).toThrow(/missing immutable/);
    expect(() => renderVoiceScript(skeleton, 'en', immutables, DEFAULT_FREE_FILLS.en)).not.toThrow();
  });

  it('applies the same free-slot lint as email', () => {
    expect(() =>
      renderVoiceScript(skeleton, 'en', immutables, { ...DEFAULT_FREE_FILLS.en, greeting: 'Pay ₹500 now' }),
    ).toThrow(TemplateRenderError);
  });

  it('throws when a referenced immutable value is missing', () => {
    expect(() => renderVoiceScript(skeleton, 'en', { invoice_number: 'INV-001' }, DEFAULT_FREE_FILLS.en)).toThrow(
      /missing immutable slot value 'amount'/,
    );
  });

  it('stays under Sarvam’s 2,500 character limit for every template and language', () => {
    for (const id of Object.keys(TEMPLATE_REGISTRY) as TemplateId[]) {
      const s = TEMPLATE_REGISTRY[id];
      for (const lang of LANGUAGES) {
        const values: Record<string, string> = {
          amount: formatINRForSpeech(249_900, lang),
          invoice_number: formatInvoiceRefForSpeech('INV-4271', lang),
          customer_name: 'Priya Sharma',
          due_date: formatDateIST(new Date('2026-08-01T00:00:00Z'), lang),
          debit_date: formatDateIST(new Date('2026-09-01T00:00:00Z'), lang),
        };
        // pre_debit_notice declares no free slots; handing it fills is an error
        const declared = new Set(s.slots.filter((x) => x.kind === 'free').map((x) => x.name));
        const fills = Object.fromEntries(
          Object.entries(DEFAULT_FREE_FILLS[lang]).filter(([k]) => declared.has(k)),
        );
        expect(renderVoiceScript(s, lang, values, fills).length, `${id}/${lang}`).toBeLessThan(2500);
      }
    }
  });
});

describe('formatInvoiceRefForSpeech', () => {
  it('speaks the tail of a machine id, the way a biller does on the phone', () => {
    // "inv_d4c775ba-254" read aloud is "i n v underscore d four c seven seven
    // five b a dash two five four", which no listener can hold or repeat back.
    expect(formatInvoiceRefForSpeech('inv_d4c775ba-254', 'en')).toBe('ending 2 5 4');
    expect(formatInvoiceRefForSpeech('INV-4271', 'en')).toBe('ending 4 2 7 1');
  });

  it('spaces the tail so it is spoken character by character', () => {
    // Unspaced, "8776" is read as "eight thousand seven hundred seventy six"
    // and "f9f3" is attempted as a word; neither matches the id on the invoice.
    expect(formatInvoiceRefForSpeech('inv_0009988776', 'en')).toBe('ending 8 7 7 6');
    expect(formatInvoiceRefForSpeech('20f9f9f3', 'en')).toBe('ending f 9 f 3');
  });

  it('always contains a digit, so the console can tell it from agent prose', () => {
    for (const ref of ['inv_d4c775ba-254', 'INV-4271', '20f9f9f3']) {
      expect(formatInvoiceRefForSpeech(ref, 'en')).toMatch(/\d/);
    }
  });
});

/**
 * The defect these cover: template text was ONE English string per field, and
 * only the agent-filled free slots carried the customer's language. A Hindi
 * customer got a Hindi greeting and sign-off wrapped around English sentences
 * — "चालान … के लिए" next to "We have emailed you a secure payment link" — in
 * both the email and the voice note. Half a message in a language you do not
 * read is worse than none of it.
 */
describe('a message is in one language, end to end', () => {
  const invoice = {
    id: '0e322da4-743a-43c1-85b8-ab6d9e135a36',
    providerInvoiceId: 'inv_833010f3-7cd',
    dueDate: new Date('2026-08-01T00:00:00Z'),
  } as Parameters<typeof buildImmutableValues>[1];

  /** Sentences that must NOT survive into a translated render. */
  const ENGLISH_TELLS = [
    'We have emailed you',
    'Pay securely here',
    'was due on',
    'could not be processed',
    'Amount due:',
    'As per your active mandate',
    'This is a payment notice',
  ];

  it('every template is actually translated, not copied', () => {
    for (const [id, s] of Object.entries(TEMPLATE_REGISTRY)) {
      for (const field of ['subject', 'body', 'voiceScript'] as const) {
        expect(s[field].hi, `${id}.${field} hi is still the English string`).not.toBe(s[field].en);
        expect(s[field].hinglish, `${id}.${field} hinglish is still the English string`).not.toBe(s[field].en);
      }
    }
  });

  it('a Hindi email carries no English boilerplate', () => {
    for (const id of Object.keys(TEMPLATE_REGISTRY) as TemplateId[]) {
      const skeleton = TEMPLATE_REGISTRY[id];
      const values = buildImmutableValues(id, invoice, 99_900, 'hi');
      values['payment_link'] = 'https://rzp.io/sbx/abc';
      values['customer_name'] = 'प्रकाश';
      values['debit_date'] = formatDateIST(new Date('2026-09-01T00:00:00Z'), 'hi');
      const declared = new Set(skeleton.slots.filter((x) => x.kind === 'free').map((x) => x.name));
      const fills = Object.fromEntries(
        Object.entries(DEFAULT_FREE_FILLS.hi).filter(([k]) => declared.has(k)),
      );
      const { subject, body } = renderTemplate(skeleton, 'hi', values, fills);
      for (const tell of ENGLISH_TELLS) {
        expect(body, `${id} body leaks "${tell}"`).not.toContain(tell);
        expect(subject, `${id} subject leaks "${tell}"`).not.toContain(tell);
      }
      expect(body, `${id} body is not in Devanagari`).toMatch(/\p{Script=Devanagari}/u);
    }
  });

  it('a Hindi voice note carries no English boilerplate', () => {
    for (const id of Object.keys(TEMPLATE_REGISTRY) as TemplateId[]) {
      const skeleton = TEMPLATE_REGISTRY[id];
      const values: Record<string, string> = {
        amount: formatINRForSpeech(99_900, 'hi'),
        invoice_number: formatInvoiceRefForSpeech('inv_833010f3-7cd', 'hi'),
        customer_name: 'प्रकाश',
        due_date: formatDateIST(new Date('2026-08-01T00:00:00Z'), 'hi'),
        debit_date: formatDateIST(new Date('2026-09-01T00:00:00Z'), 'hi'),
      };
      const declared = new Set(skeleton.slots.filter((x) => x.kind === 'free').map((x) => x.name));
      const fills = Object.fromEntries(
        Object.entries(DEFAULT_FREE_FILLS.hi).filter(([k]) => declared.has(k)),
      );
      const spoken = renderVoiceScript(skeleton, 'hi', values, fills);
      for (const tell of ENGLISH_TELLS) {
        expect(spoken, `${id} voice leaks "${tell}"`).not.toContain(tell);
      }
      expect(spoken, `${id} voice is not in Devanagari`).toMatch(/\p{Script=Devanagari}/u);
    }
  });

  it('every legal footer exists in every language and is translated', () => {
    for (const [name, footer] of Object.entries(LEGAL_FOOTERS)) {
      for (const lang of LANGUAGES) expect(footer[lang], `${name}/${lang}`).toBeTruthy();
      expect(footer.hi, `${name} hi is still English`).not.toBe(footer.en);
    }
  });

  /**
   * The default fills go out on the MONEY path, where no agent is involved and
   * nothing regenerates them. A Devanagari digit or a currency word in one of
   * them would fail the lint at render time, on a live case, with no retry.
   */
  it('the default free fills pass the free-slot lint in every language', () => {
    for (const [id, skeleton] of Object.entries(TEMPLATE_REGISTRY)) {
      const declared = new Set(skeleton.slots.filter((x) => x.kind === 'free').map((x) => x.name));
      if (declared.size === 0) continue;
      for (const lang of LANGUAGES) {
        const fills = Object.fromEntries(
          Object.entries(DEFAULT_FREE_FILLS[lang]).filter(([k]) => declared.has(k)),
        );
        expect(validateFreeFills(skeleton, fills), `${id}/${lang} default fills`).toEqual([]);
      }
    }
  });

  it('speaks money, dates and invoice refs in the message language', () => {
    expect(formatINRForSpeech(249_900, 'hi')).toBe('2,499 रुपये');
    expect(formatINRForSpeech(100, 'hi')).toBe('1 रुपया');
    expect(formatINRForSpeech(249_950, 'hi')).toBe('2,499 रुपये 50 पैसे');
    // Hinglish is Latin-script by definition, so it takes the English forms.
    expect(formatINRForSpeech(249_900, 'hinglish')).toBe('2,499 rupees');

    expect(formatInvoiceRefForSpeech('inv_833010f3-7cd', 'hi')).toBe('अंतिम अंक 7 c d');
    expect(formatInvoiceRefForSpeech('inv_833010f3-7cd', 'hinglish')).toBe('ending 7 c d');

    expect(formatDateIST(new Date('2026-08-01T00:00:00Z'), 'hi')).toMatch(/\p{Script=Devanagari}/u);
    expect(formatDateIST(new Date('2026-08-01T00:00:00Z'), 'en')).toBe('1 August 2026');
  });

  /**
   * The digits themselves stay Latin in every language — the English form
   * always kept them ("499 rupees", never "four hundred ninety nine"), and
   * Sarvam reads a numeral in the voice's own language.
   */
  it('keeps numerals as numerals so no number-to-words converter is needed', () => {
    expect(formatINRForSpeech(1_50_00_000, 'hi')).toBe('1,50,000 रुपये');
    expect(formatINRForSpeech(1_50_00_000, 'hi')).not.toMatch(/[०-९]/); // Devanagari digits
  });
});
