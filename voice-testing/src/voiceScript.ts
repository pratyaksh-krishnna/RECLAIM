import type { TemplateId, TemplateSkeleton } from '@reclaim/shared';
import { TemplateRenderError, validateFreeFills } from '@reclaim/api/templates/registry';
import { formatINRForSpeech } from './money.js';

/**
 * The spoken form of each approved template.
 *
 * Two rules hold for every entry:
 *   1. no {{payment_link}} — a URL read aloud is useless, so the script tells
 *      the listener where the link is instead of reciting it
 *   2. no {{legal_footer}} — the opt-out is spoken in plain language
 *
 * Everything else is the same discipline as the email body: the agent fills
 * greeting/context_sentence/sign_off and nothing else, and every number is
 * injected by the server.
 */
export const VOICE_SCRIPTS: Record<TemplateId, string> = {
  payment_failed_notice: `{{greeting}} {{context_sentence}} Your payment of {{amount}} for invoice {{invoice_number}} could not be processed. We have emailed you a secure payment link — please check your inbox to complete it. {{sign_off}} If you would rather not receive these messages, just reply STOP.`,

  payment_link_delivery: `{{greeting}} {{context_sentence}} The amount due on invoice {{invoice_number}} is {{amount}}. We have emailed you a secure payment link — please check your inbox to complete it. {{sign_off}} If you would rather not receive these messages, just reply STOP.`,

  payment_reminder: `{{greeting}} {{context_sentence}} Invoice {{invoice_number}} for {{amount}} was due on {{due_date}} and is still open. We have emailed you a secure payment link — please check your inbox to complete it. {{sign_off}} If you would rather not receive these messages, just reply STOP.`,

  // Compliance notice: no free slots, exactly like its email form.
  pre_debit_notice: `Dear {{customer_name}}. As per your active mandate, {{amount}} for invoice {{invoice_number}} will be debited on {{debit_date}}. No action is needed if you wish to proceed. To cancel this debit, use your UPI or bank app before the debit date.`,
};

/**
 * Immutable values for a spoken render. The sibling of buildImmutableValues in
 * apps/api/src/tools/execute.ts, differing in exactly two ways: the amount is
 * spoken rather than written, and payment_link / legal_footer are absent.
 *
 * Separate function rather than a flag on the existing one, so the email path
 * is untouched and the speech path cannot inherit a URL by accident.
 */
export function buildVoiceImmutableValues(
  templateId: TemplateId,
  amountDuePaise: number,
  invoiceNumber: string,
  customerName: string,
  dateValue?: string,
): Record<string, string> {
  const values: Record<string, string> = {
    amount: formatINRForSpeech(amountDuePaise),
    invoice_number: invoiceNumber,
  };
  if (templateId === 'payment_reminder' && dateValue) values['due_date'] = dateValue;
  if (templateId === 'pre_debit_notice') {
    values['customer_name'] = customerName;
    if (dateValue) values['debit_date'] = dateValue;
  }
  return values;
}

/**
 * Render a spoken script.
 *
 * Mirrors renderTemplate in every validation it performs, with ONE deliberate
 * difference in the coverage rule. renderTemplate requires a value for every
 * immutable slot the skeleton declares; applied here that is wrong, because a
 * voice script omits {{payment_link}} and {{legal_footer}} by design and would
 * demand exactly the values it must not carry. So this requires a value only
 * for the slots the SCRIPT actually references.
 */
export function renderVoiceScript(
  skeleton: TemplateSkeleton,
  script: string,
  immutableValues: Record<string, string>,
  freeFills: Record<string, string>,
): string {
  const freeSlotNames = new Set(skeleton.slots.filter((s) => s.kind === 'free').map((s) => s.name));
  const immutableSlotNames = new Set(
    skeleton.slots.filter((s) => s.kind === 'immutable').map((s) => s.name),
  );

  const problems = validateFreeFills(skeleton, freeFills);
  if (problems.length > 0) throw new TemplateRenderError(problems.join('; '));

  return script.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => {
    if (immutableSlotNames.has(name)) {
      const value = immutableValues[name];
      if (value === undefined) {
        throw new TemplateRenderError(`missing immutable slot value '${name}'`);
      }
      return value;
    }
    if (freeSlotNames.has(name)) return freeFills[name] ?? '';
    throw new TemplateRenderError(`undeclared slot '{{${name}}}' in voice script`);
  });
}
