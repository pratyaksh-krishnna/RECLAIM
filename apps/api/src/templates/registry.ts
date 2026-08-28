import { lintFreeSlotFills, type TemplateId, type TemplateSkeleton } from '@reclaim/shared';

/**
 * Approved template skeletons. Immutable slots ({{amount}}, {{payment_link}},
 * {{debit_date}}, …) are ALWAYS injected server-side from DB state; the
 * Communication agent may only fill the declared free slots, and every free
 * fill passes the numeral/URL/currency lint (again) at render time.
 */

export function formatINR(paise: number): string {
  const rupees = paise / 100;
  return `₹${rupees.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatDateIST(date: Date): string {
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'long', timeZone: 'Asia/Kolkata' }).format(date);
}

/**
 * Money, spoken. formatINR above produces "₹2,499.00" — right in an email and
 * a hazard in a synthesiser, where the ₹ glyph may be misread and ".00"
 * becomes "point zero zero". The amount is the one thing a voice note must get
 * exactly right, so it is deterministic here for the same reason the written
 * form is. An agent still never touches a number.
 */
export function formatINRForSpeech(paise: number): string {
  if (!Number.isInteger(paise) || paise < 0) {
    throw new Error(`formatINRForSpeech expects non-negative integer paise, got ${paise}`);
  }
  const rupees = Math.floor(paise / 100);
  const remainder = paise % 100;
  const parts: string[] = [];
  if (rupees > 0) parts.push(`${rupees.toLocaleString('en-IN')} ${rupees === 1 ? 'rupee' : 'rupees'}`);
  if (remainder > 0) parts.push(`${remainder} ${remainder === 1 ? 'paisa' : 'paise'}`);
  return parts.length > 0 ? parts.join(' ') : '0 rupees';
}

const commonFreeSlots = [
  { name: 'greeting', kind: 'free' as const, maxLength: 120, description: 'personal greeting, no numbers/links/amounts' },
  { name: 'context_sentence', kind: 'free' as const, maxLength: 300, description: 'one empathetic context sentence, no numbers/links/amounts' },
  { name: 'sign_off', kind: 'free' as const, maxLength: 120, description: 'sign-off line, no numbers/links/amounts' },
];

/** Typed by TemplateId: a missing or extra template is a compile error. */
export const TEMPLATE_REGISTRY: Record<TemplateId, TemplateSkeleton> = {
  payment_failed_notice: {
    templateId: 'payment_failed_notice',
    subject: 'Payment issue on invoice {{invoice_number}}',
    body: `{{greeting}}

{{context_sentence}}

Your payment of {{amount}} for invoice {{invoice_number}} could not be processed.
Pay securely here (UPI, cards, netbanking): {{payment_link}}

{{sign_off}}

{{legal_footer}}`,
    voiceScript: `{{greeting}} {{context_sentence}} Your payment of {{amount}} for invoice {{invoice_number}} could not be processed. We have emailed you a secure payment link — please check your inbox to complete it. If you would rather not receive these messages, just reply STOP. {{sign_off}}`,
    slots: [
      ...commonFreeSlots,
      { name: 'amount', kind: 'immutable', description: 'exact amount due, server-injected' },
      { name: 'invoice_number', kind: 'immutable', description: 'invoice reference, server-injected' },
      { name: 'payment_link', kind: 'immutable', description: 'provider short URL, server-injected' },
      { name: 'legal_footer', kind: 'immutable', description: 'legal/opt-out text, server-injected' },
    ],
    supportedLanguages: ['en', 'hi', 'hinglish'],
  },
  payment_link_delivery: {
    templateId: 'payment_link_delivery',
    subject: 'Payment link for invoice {{invoice_number}} — {{amount}}',
    body: `{{greeting}}

{{context_sentence}}

Amount due: {{amount}} for invoice {{invoice_number}}.
Pay securely here (UPI, cards, netbanking): {{payment_link}}

{{sign_off}}

{{legal_footer}}`,
    voiceScript: `{{greeting}} {{context_sentence}} The amount due on invoice {{invoice_number}} is {{amount}}. We have emailed you a secure payment link — please check your inbox to complete it. If you would rather not receive these messages, just reply STOP. {{sign_off}}`,
    slots: [
      ...commonFreeSlots,
      { name: 'amount', kind: 'immutable', description: 'exact amount due' },
      { name: 'invoice_number', kind: 'immutable', description: 'invoice reference' },
      { name: 'payment_link', kind: 'immutable', description: 'provider short URL, server-injected' },
      { name: 'legal_footer', kind: 'immutable', description: 'legal/opt-out text' },
    ],
    supportedLanguages: ['en', 'hi', 'hinglish'],
  },
  pre_debit_notice: {
    templateId: 'pre_debit_notice',
    subject: 'Upcoming auto-debit of {{amount}} on {{debit_date}}',
    body: `Dear {{customer_name}},

As per your active mandate, {{amount}} for invoice {{invoice_number}} will be debited on {{debit_date}}.

No action is needed if you wish to proceed. To cancel this debit, use your UPI or bank app before the debit date.

{{legal_footer}}`,
    voiceScript: `Dear {{customer_name}}. As per your active mandate, {{amount}} for invoice {{invoice_number}} will be debited on {{debit_date}}. No action is needed if you wish to proceed. To cancel this debit, use your UPI or bank app before the debit date.`,
    // compliance notice: NO free slots — fully deterministic
    slots: [
      { name: 'customer_name', kind: 'immutable', description: 'customer name, server-injected' },
      { name: 'amount', kind: 'immutable', description: 'exact debit amount' },
      { name: 'invoice_number', kind: 'immutable', description: 'invoice reference' },
      { name: 'debit_date', kind: 'immutable', description: 'scheduled debit date' },
      { name: 'legal_footer', kind: 'immutable', description: 'legal text' },
    ],
    supportedLanguages: ['en', 'hi', 'hinglish'],
  },
  payment_reminder: {
    templateId: 'payment_reminder',
    subject: 'Reminder: invoice {{invoice_number}} ({{amount}}) is due',
    body: `{{greeting}}

{{context_sentence}}

Invoice {{invoice_number}} for {{amount}} was due on {{due_date}} and remains unpaid.
Pay securely here (UPI, cards, netbanking): {{payment_link}}

{{sign_off}}

{{legal_footer}}`,
    voiceScript: `{{greeting}} {{context_sentence}} Invoice {{invoice_number}} for {{amount}} was due on {{due_date}} and is still open. We have emailed you a secure payment link — please check your inbox to complete it. If you would rather not receive these messages, just reply STOP. {{sign_off}}`,
    slots: [
      ...commonFreeSlots,
      { name: 'amount', kind: 'immutable', description: 'exact amount due' },
      { name: 'invoice_number', kind: 'immutable', description: 'invoice reference' },
      { name: 'due_date', kind: 'immutable', description: 'original due date' },
      { name: 'payment_link', kind: 'immutable', description: 'provider short URL, server-injected' },
      { name: 'legal_footer', kind: 'immutable', description: 'legal text' },
    ],
    supportedLanguages: ['en', 'hi', 'hinglish'],
  },
};

/** Deterministic default fills used when no agent output is involved (money path). */
export const DEFAULT_FREE_FILLS: Record<string, string> = {
  greeting: 'Hello,',
  context_sentence: 'We were unable to collect your recent payment, and wanted to make it easy to complete.',
  sign_off: 'Thank you,\nThe Billing Team',
};

export class TemplateRenderError extends Error {}

/**
 * Whether a skeleton declares the server-injected {{payment_link}} slot.
 *
 * Lives here because it is a question about the registry, and because three
 * places need the same answer: the tool that mints the link, the policy engine
 * (an email carrying a live link is a collection attempt, not just contact),
 * and the case context (an outstanding link is a fact the agent reasons about).
 * A hand-written list of template ids is what let payment_link_delivery fall
 * through the first time.
 */
export function needsPaymentLink(skeleton: TemplateSkeleton): boolean {
  return skeleton.slots.some((slot) => slot.kind === 'immutable' && slot.name === 'payment_link');
}

/**
 * THE definition of what makes a set of free-slot fills acceptable. Both gates
 * call this: the agent runner before an output is accepted, and renderTemplate
 * at execution time.
 *
 * They used to disagree. The agent gate ran only the numeral/URL/currency lint,
 * while the renderer additionally enforced maxLength and unknown-slot rules —
 * so an over-long sign_off passed Zod, passed the lint, passed the POLICY gate,
 * and then died inside the tool. The intervention failed permanently and the
 * case landed in the human inbox with "free slot 'sign_off' exceeds max length
 * 120" — an engineering error dressed up as a business decision, which is not
 * something an operator can act on. Keeping one definition means a bad fill is
 * caught while the model can still be asked to try again.
 */
export function validateFreeFills(skeleton: TemplateSkeleton, freeFills: Record<string, string>): string[] {
  const problems: string[] = [];
  const freeSlots = skeleton.slots.filter((s) => s.kind === 'free');
  const freeSlotNames = new Set(freeSlots.map((s) => s.name));

  for (const key of Object.keys(freeFills)) {
    if (!freeSlotNames.has(key)) problems.push(`unknown free slot '${key}'`);
  }
  for (const slot of freeSlots) {
    const value = freeFills[slot.name];
    if (slot.maxLength && value !== undefined && value.length > slot.maxLength) {
      problems.push(`free slot '${slot.name}' exceeds max length ${slot.maxLength} (got ${value.length})`);
    }
  }
  for (const v of lintFreeSlotFills(freeFills)) {
    problems.push(`free-slot lint ${v.slot}:${v.rule}(${v.match})`);
  }
  return problems;
}

/**
 * Render a skeleton. Free fills are linted; immutable values may only come
 * from the server-side caller. Unfilled placeholders are a hard error.
 */
export function renderTemplate(
  skeleton: TemplateSkeleton,
  immutableValues: Record<string, string>,
  freeFills: Record<string, string>,
): { subject: string; body: string } {
  const freeSlotNames = new Set(skeleton.slots.filter((s) => s.kind === 'free').map((s) => s.name));
  const immutableSlotNames = new Set(skeleton.slots.filter((s) => s.kind === 'immutable').map((s) => s.name));

  const problems = validateFreeFills(skeleton, freeFills);
  if (problems.length > 0) throw new TemplateRenderError(problems.join('; '));

  for (const name of immutableSlotNames) {
    if (!(name in immutableValues)) throw new TemplateRenderError(`missing immutable slot value '${name}'`);
  }

  const fill = (text: string): string =>
    text.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => {
      if (immutableSlotNames.has(name)) return immutableValues[name] ?? '';
      if (freeSlotNames.has(name)) return freeFills[name] ?? DEFAULT_FREE_FILLS[name] ?? '';
      throw new TemplateRenderError(`undeclared slot '{{${name}}}' in template ${skeleton.templateId}`);
    });

  return { subject: fill(skeleton.subject), body: fill(skeleton.body) };
}

/**
 * Render a skeleton's spoken form.
 *
 * Mirrors renderTemplate in every validation it performs, with ONE deliberate
 * difference in the coverage rule. renderTemplate requires a value for every
 * immutable slot the skeleton DECLARES; applied here that is wrong, because a
 * voice script omits {{payment_link}} and {{legal_footer}} by design and would
 * demand exactly the values it must not carry. So this requires a value only
 * for the slots the SCRIPT references.
 */
export function renderVoiceScript(
  skeleton: TemplateSkeleton,
  immutableValues: Record<string, string>,
  freeFills: Record<string, string>,
): string {
  const freeSlotNames = new Set(skeleton.slots.filter((s) => s.kind === 'free').map((s) => s.name));
  const immutableSlotNames = new Set(
    skeleton.slots.filter((s) => s.kind === 'immutable').map((s) => s.name),
  );

  const problems = validateFreeFills(skeleton, freeFills);
  if (problems.length > 0) throw new TemplateRenderError(problems.join('; '));

  return skeleton.voiceScript.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => {
    if (immutableSlotNames.has(name)) {
      const value = immutableValues[name];
      if (value === undefined) throw new TemplateRenderError(`missing immutable slot value '${name}'`);
      return value;
    }
    if (freeSlotNames.has(name)) return freeFills[name] ?? DEFAULT_FREE_FILLS[name] ?? '';
    throw new TemplateRenderError(`undeclared slot '{{${name}}}' in voice script ${skeleton.templateId}`);
  });
}
