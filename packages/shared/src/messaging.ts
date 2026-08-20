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

export const TemplateSkeleton = z.object({
  templateId: z.string().min(1),
  subject: z.string(),
  /** body with {{slotName}} placeholders */
  body: z.string(),
  slots: z.array(TemplateSlot),
  supportedLanguages: z.array(Language),
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
