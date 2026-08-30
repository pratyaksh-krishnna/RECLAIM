/**
 * Drive the voice pipeline end to end, from the command line.
 *
 * Uses the SAME synthesizer, sender and templates the API uses — there is one
 * copy of each, and this is how you exercise them against the real providers
 * without waiting for a case to reach the executing state.
 *
 * DRY RUN IS THE DEFAULT. Without --to, audio is written to out/ and nothing
 * is sent. Confirming the pipeline before anyone receives anything is the
 * point, so the safe path is the one you get by forgetting a flag.
 *
 *   pnpm voice:try --template payment_reminder --lang hi
 *   pnpm voice:try --template payment_reminder --lang hi --to +919812345678
 *
 * Sending needs WHATSAPP_MODE=live and an open 24-hour window: WhatsApp allows
 * a freeform message — which audio is — only after the customer writes first.
 * Without one Meta returns 131047, which reads like a broken token.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Language, TemplateId } from '@reclaim/shared';
import { env } from '../config/env.js';
import {
  DEFAULT_FREE_FILLS,
  TEMPLATE_REGISTRY,
  formatINRForSpeech,
  formatInvoiceRefForSpeech,
  formatDateIST,
  renderVoiceScript,
} from '../templates/registry.js';
import { getVoiceSynthesizer } from '../voice/index.js';
import { getWhatsAppSender } from '../whatsapp/index.js';

// pnpm's arg forwarding leaves a bare '--' in argv, and parseArgs treats that
// as "stop parsing options" — every flag after it would silently take its
// default.
const args = process.argv.slice(2).filter((a) => a !== '--');

const { values } = parseArgs({
  args,
  allowPositionals: true,
  options: {
    template: { type: 'string', default: 'payment_reminder' },
    lang: { type: 'string', default: 'en' },
    speaker: { type: 'string' },
    to: { type: 'string' },
  },
});

const templateId = TemplateId.parse(values.template);
const language = Language.parse(values.lang);
const skeleton = TEMPLATE_REGISTRY[templateId];

// Stand-in figures. The real path resolves these from the invoice; here they
// only need to be shaped like the values the server injects.
const immutables: Record<string, string> = {
  amount: formatINRForSpeech(249_900),
  invoice_number: formatInvoiceRefForSpeech('inv_833010f3-4271'),
  customer_name: 'Priya Sharma',
  due_date: formatDateIST(new Date('2026-08-01T00:00:00Z')),
  debit_date: formatDateIST(new Date('2026-09-01T00:00:00Z')),
};

// pre_debit_notice declares no free slots; handing it fills is an error.
const declared = new Set(skeleton.slots.filter((s) => s.kind === 'free').map((s) => s.name));
const fills = Object.fromEntries(
  Object.entries(DEFAULT_FREE_FILLS).filter(([k]) => declared.has(k)),
);

const script = renderVoiceScript(skeleton, immutables, fills);
console.log(`\nscript (${script.length} chars):\n${script}\n`);

const synth = getVoiceSynthesizer();
const audio = await synth.speak({
  script,
  language,
  ...(values.speaker ? { speaker: values.speaker } : {}),
});

const outDir = new URL('../../out/', import.meta.url);
mkdirSync(outDir, { recursive: true });
const outPath = new URL(`${templateId}-${language}.ogg`, outDir);
writeFileSync(outPath, audio.bytes);
console.log(
  `audio: ${audio.bytes.length} bytes via ${synth.name} → ${decodeURIComponent(outPath.pathname)}`,
);

if (!values.to) {
  console.log('\ndry run — no --to given, nothing sent. Listen to the file above.');
} else {
  const sender = getWhatsAppSender();
  const sent = await sender.sendVoice({ to: values.to, audio });
  console.log(`sent via ${sender.name} (WHATSAPP_MODE=${env.WHATSAPP_MODE}): ${sent.providerMessageId}`);
}
