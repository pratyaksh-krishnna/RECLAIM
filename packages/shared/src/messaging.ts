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
const NUMERAL_RE = /[0-9०-९]/; // ASCII + Devanagari digits
const URL_RE = /(https?:\/\/|www\.|\.com|\.in\b|\.org|\.net|:\/\/)/i;
const CURRENCY_RE = /[₹$€£¥]|(\bINR\b)|(\bRs\.?)|(\brupees?\b)/i;
const HTML_RE = /[<>]/;

export type LintViolation = { slot: string; rule: 'numeral' | 'url' | 'currency' | 'html'; match: string };

export function lintFreeSlotFills(fills: Record<string, string>): LintViolation[] {
  const violations: LintViolation[] = [];
  for (const [slot, text] of Object.entries(fills)) {
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
