import { z } from 'zod';
import { Language } from './enums.js';

/**
 * Template skeletons: immutable server-injected slots (amounts, dates, links,
 * legal text) + bounded free-text slots the Communication agent may fill.
 */
export const TemplateSlot = z.object({
  name: z.string().min(1),
  kind: z.enum(['immutable', 'free']),
  /** for free slots: max characters the agent may produce */
  maxLength: z.number().int().positive().optional(),
  description: z.string(),
});
export type TemplateSlot = z.infer<typeof TemplateSlot>;

/**
 * One piece of template text in every language the system speaks.
 *
 * Every language is REQUIRED, so a template cannot ship half-translated. It
 * used to be a single English string per field, with the customer's language
 * reaching only the agent-filled free slots — which produced a message whose
 * greeting and sign-off were Hindi and whose every other sentence was English.
 * A partial record would let that back in one template at a time.
 */
export const LocalizedText = z.object(
  // Built FROM the Language enum rather than beside it: adding a language is
  // then a compile error in every template, which is the moment to translate
  // it, instead of a silent gap discovered by a customer.
  Object.fromEntries(Language.options.map((l) => [l, z.string()])) as Record<Language, z.ZodString>,
);
export type LocalizedText = z.infer<typeof LocalizedText>;

export const TemplateSkeleton = z.object({
  templateId: z.string().min(1),
  subject: LocalizedText,
  /** body with {{slotName}} placeholders */
  body: LocalizedText,
  /**
   * The spoken form of this template. Two rules, enforced by test: never
   * {{payment_link}} (a URL read aloud is useless) and never {{legal_footer}}
   * (the opt-out is spoken in plain language).
   *
   * The slot ORDER differs from the body on purpose. There, {{sign_off}} sits
   * above {{legal_footer}}, which voice does not speak — so copying that order
   * leaves the sign-off mid-message, dangling on its comma before the opt-out
   * sentence. Spoken, a sign-off has to be last.
   */
  voiceScript: LocalizedText,
  slots: z.array(TemplateSlot),
});
export type TemplateSkeleton = z.infer<typeof TemplateSkeleton>;

/**
 * Deterministic free-slot lint. Rejects any numeral (ASCII or Devanagari),
 * URL-ish token, currency symbol, or HTML in agent-filled free slots so no
 * amount, date, or link can ever originate from an LLM.
 */
// All Unicode decimal digits, letter-numbers, and other numerics (०-९, ٠-٩, ①, Ⅷ, …)
const NUMERAL_RE = /[\p{Nd}\p{Nl}\p{No}]/u;
const URL_RE = /(https?:\/\/|www\.|\.com|\.in\b|\.org|\.net|:\/\/)/i;
const CURRENCY_RE = /\p{Sc}|(\bINR\b)|(\bRs\.?)|(\brupees?\b)/iu;
const HTML_RE = /[<>]/;
// Invisible/zero-width characters that could be used to split tokens past the
// lint while an email client still renders them joined (parser differential).
// eslint-disable-next-line no-misleading-character-class -- intentional: we strip LONE combining/invisible code points
const INVISIBLE_RE = /[\u200B-\u200F\u2060\u2061-\u2064\uFEFF\u00AD\u034F\u180E]/gu;

/**
 * Canonicalize before linting: NFKC folds full-width/stylized digits and
 * letters to ASCII forms; stripping invisibles rejoins split tokens. The lint
 * MUST see the text the way a mail client's renderer will.
 */
export function canonicalizeForLint(text: string): string {
  return text.normalize('NFKC').replace(INVISIBLE_RE, '');
}

export type LintViolation = { slot: string; rule: 'numeral' | 'url' | 'currency' | 'html'; match: string };

export function lintFreeSlotFills(fills: Record<string, string>): LintViolation[] {
  const violations: LintViolation[] = [];
  for (const [slot, raw] of Object.entries(fills)) {
    const text = canonicalizeForLint(raw);
    const checks: Array<[LintViolation['rule'], RegExp]> = [
      ['numeral', NUMERAL_RE],
      ['url', URL_RE],
      ['currency', CURRENCY_RE],
      ['html', HTML_RE],
    ];
    for (const [rule, re] of checks) {
      const m = text.match(re);
      if (m) violations.push({ slot, rule, match: m[0] });
    }
  }
  return violations;
}
