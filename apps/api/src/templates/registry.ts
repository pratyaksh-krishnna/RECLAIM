import { lintFreeSlotFills, type TemplateSkeleton } from '@reclaim/shared';

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

const commonFreeSlots = [
  { name: 'greeting', kind: 'free' as const, maxLength: 120, description: 'personal greeting, no numbers/links/amounts' },
  { name: 'context_sentence', kind: 'free' as const, maxLength: 300, description: 'one empathetic context sentence, no numbers/links/amounts' },
  { name: 'sign_off', kind: 'free' as const, maxLength: 120, description: 'sign-off line, no numbers/links/amounts' },
];

export const TEMPLATE_REGISTRY: Record<string, TemplateSkeleton> = {
  payment_failed_notice: {
    templateId: 'payment_failed_notice',
    subject: 'Payment issue on invoice {{invoice_number}}',
    body: `{{greeting}}

{{context_sentence}}

Your payment of {{amount}} for invoice {{invoice_number}} could not be processed.

{{sign_off}}

{{legal_footer}}`,
    slots: [
      ...commonFreeSlots,
      { name: 'amount', kind: 'immutable', description: 'exact amount due, server-injected' },
      { name: 'invoice_number', kind: 'immutable', description: 'invoice reference, server-injected' },
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

{{sign_off}}

{{legal_footer}}`,
    slots: [
      ...commonFreeSlots,
      { name: 'amount', kind: 'immutable', description: 'exact amount due' },
      { name: 'invoice_number', kind: 'immutable', description: 'invoice reference' },
      { name: 'due_date', kind: 'immutable', description: 'original due date' },
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

  for (const key of Object.keys(freeFills)) {
    if (!freeSlotNames.has(key)) throw new TemplateRenderError(`unknown free slot '${key}'`);
  }
  for (const slot of skeleton.slots) {
    if (slot.kind === 'free' && slot.maxLength && (freeFills[slot.name]?.length ?? 0) > slot.maxLength) {
      throw new TemplateRenderError(`free slot '${slot.name}' exceeds max length ${slot.maxLength}`);
    }
  }
  const violations = lintFreeSlotFills(freeFills);
  if (violations.length > 0) {
    throw new TemplateRenderError(
      `free-slot lint violations: ${violations.map((v) => `${v.slot}:${v.rule}(${v.match})`).join(', ')}`,
    );
  }
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
