import type { Language, TemplateSkeleton } from '@reclaim/shared';
import type { Db } from '../db/client.js';
import { communications, customers, invoices, voiceMessages } from '../db/schema.js';
import { writeAudit } from '../audit/audit.js';
import {
  formatDateIST,
  formatINRForSpeech,
  formatInvoiceRefForSpeech,
  renderVoiceScript,
} from '../templates/registry.js';
import type { VoiceSynthesizer } from '../voice/index.js';
import { isWhatsAppWindowOpen, type WhatsAppSender } from '../whatsapp/index.js';

/**
 * Voice delivery. Called after each mailer.send() site in execute.ts.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS FUNCTION MUST NEVER THROW.
 *
 * executeIntervention claims idempotency on caseId:interventionId:attempt.
 * A FAILED claim is re-claimed on retry and runTool re-runs from the top,
 * mailer.send() included. So an exception escaping here would make BullMQ
 * retry the job and send the customer a SECOND EMAIL — which is commit
 * 08fb3a9 ("a case could send the same email twice") through a new door.
 *
 * Email is the channel of record. Voice is an accompaniment, and an
 * accompaniment that can take down the thing it accompanies is a liability.
 * ─────────────────────────────────────────────────────────────────────────
 */

export interface VoiceToolDeps {
  synthesizer: VoiceSynthesizer;
  whatsapp: WhatsAppSender;
  /**
   * In 'mock' the 24-hour window check is bypassed: nothing is delivered, and
   * the console should still have audio to show for every message sent.
   */
  whatsappMode: 'mock' | 'live';
}

export interface DeliverVoiceArgs {
  caseId: string;
  customer: typeof customers.$inferSelect;
  invoice: typeof invoices.$inferSelect;
  interventionId: string;
  skeleton: TemplateSkeleton;
  language: Language;
  freeFills: Record<string, string>;
  amountDuePaise: number;
  /** only for pre_debit_notice */
  debitDate?: Date;
  now: () => Date;
}

/**
 * Immutable values for a spoken render. The sibling of buildImmutableValues in
 * execute.ts, differing in exactly two ways: the amount is spoken rather than
 * written, and payment_link / legal_footer are absent.
 *
 * It lives HERE rather than beside its email sibling because execute.ts already
 * imports this module — defining it there and importing it back would make the
 * two files a cycle. A separate function rather than a flag on the email one,
 * so the email path is untouched and the speech path cannot inherit a URL.
 */
export function buildVoiceImmutableValues(
  templateId: string,
  invoice: typeof invoices.$inferSelect,
  amountDuePaise: number,
  customerName: string,
  debitDate?: Date,
): Record<string, string> {
  const values: Record<string, string> = {
    amount: formatINRForSpeech(amountDuePaise),
    invoice_number: formatInvoiceRefForSpeech(invoice.providerInvoiceId ?? invoice.id.slice(0, 8)),
  };
  if (templateId === 'payment_reminder') values['due_date'] = formatDateIST(invoice.dueDate);
  if (templateId === 'pre_debit_notice') {
    values['customer_name'] = customerName;
    if (debitDate) values['debit_date'] = formatDateIST(debitDate);
  }
  return values;
}

type SkipReason = 'opted_out' | 'no_phone' | 'no_consent' | 'window_closed';

/** Consent and contactability, in the order a human would check them. */
function staticSkipReason(customer: typeof customers.$inferSelect): SkipReason | null {
  if (customer.optedOut) return 'opted_out';
  if (!customer.phone) return 'no_phone';
  if (!customer.whatsappConsent) return 'no_consent';
  return null;
}

export async function deliverVoiceNote(
  db: Db,
  deps: VoiceToolDeps,
  args: DeliverVoiceArgs,
): Promise<void> {
  try {
    const skip =
      staticSkipReason(args.customer) ??
      (deps.whatsappMode === 'live' && !(await isWhatsAppWindowOpen(db, args.customer.id, args.now()))
        ? ('window_closed' as const)
        : null);

    if (skip) {
      // Skips are audited, never silent. "No voice note went out" is a fact an
      // operator needs to be able to look up.
      await db.transaction(async (tx) => {
        await writeAudit(tx, {
          caseId: args.caseId,
          actorType: 'system',
          eventType: 'voice.skipped',
          payload: { interventionId: args.interventionId, reason: skip },
        });
      });
      return;
    }

    const immutables = buildVoiceImmutableValues(
      args.skeleton.templateId,
      args.invoice,
      args.amountDuePaise,
      args.customer.name,
      args.debitDate,
    );
    const script = renderVoiceScript(args.skeleton, immutables, args.freeFills);
    const audio = await deps.synthesizer.speak({ script, language: args.language });
    const sent = await deps.whatsapp.sendVoice({ to: args.customer.phone!, audio });

    await db.transaction(async (tx) => {
      const [comm] = await tx
        .insert(communications)
        .values({
          caseId: args.caseId,
          customerId: args.customer.id,
          interventionId: args.interventionId,
          direction: 'outbound',
          channel: 'whatsapp_voice',
          templateId: args.skeleton.templateId,
          language: args.language,
          // a voice note has no subject
          renderedSubject: null,
          renderedBody: script,
          consentSnapshot: {
            whatsapp: args.customer.whatsappConsent,
            optedOut: args.customer.optedOut,
            // false under WHATSAPP_MODE=mock. The console must never imply a
            // customer received something they did not.
            delivered: deps.whatsappMode === 'live',
          },
          providerMessageId: sent.providerMessageId,
          sentAt: args.now(),
        })
        .returning({ id: communications.id });

      await tx.insert(voiceMessages).values({
        communicationId: comm!.id,
        mimeType: audio.mimeType,
        audio: audio.bytes,
        sarvamRequestId: audio.requestId,
      });
    });

    // NOTE: no bumpAttemptCounters here. The voice note is the same contact to
    // the same customer at the same moment as the email that just went out;
    // counting it again would wrongly tighten the 24h spacing rule and the
    // per-invoice attempt cap.
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await db.transaction(async (tx) => {
        await writeAudit(tx, {
          caseId: args.caseId,
          actorType: 'system',
          eventType: 'voice.failed',
          payload: { interventionId: args.interventionId, error: message },
        });
      });
    } catch {
      // Even the audit write is allowed to fail without taking the email down.
      console.error(`[voice] delivery failed and could not be audited: ${message}`);
    }
  }
}
