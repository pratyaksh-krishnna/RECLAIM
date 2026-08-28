import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { TEMPLATE_REGISTRY } from '@reclaim/api/templates/registry';
import { Language, TemplateId } from '@reclaim/shared';
import { MockSynthesizer, SarvamSynthesizer, type VoiceSynthesizer } from './voice.js';
import { MetaWhatsAppSender, MockWhatsAppSender, type WhatsAppSender } from './whatsapp.js';
import { VOICE_SCRIPTS, buildVoiceImmutableValues, renderVoiceScript } from './voiceScript.js';
import { runAgent } from './agent.js';

/**
 * Drives the voice pipeline end to end.
 *
 * DRY RUN IS THE DEFAULT. Without --to, audio is written to out/ and nothing
 * is sent. The point of this sandbox is to confirm the pipeline before anyone
 * receives anything, so the safe path is the one you get by forgetting a flag.
 */

const CANNED_FILLS: Record<string, string> = {
  greeting: 'Hello Priya,',
  context_sentence:
    'We noticed your recent payment did not go through, and we want to make it easy to sort out.',
  sign_off: 'Thank you, the billing team.',
};

async function main(): Promise<void> {
  // pnpm's arg forwarding leaves a bare '--' in argv, and parseArgs treats that
  // as "stop parsing options" — so every flag after it would become a
  // positional and silently take its default.
  const args = process.argv.slice(2).filter((a) => a !== '--');

  const { values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      template: { type: 'string', default: 'payment_failed_notice' },
      lang: { type: 'string', default: 'en' },
      speaker: { type: 'string' },
      to: { type: 'string' },
      agent: { type: 'boolean', default: false },
      canned: { type: 'boolean', default: false },
    },
  });

  const templateId = TemplateId.parse(values.template);
  const language = Language.parse(values.lang);
  const skeleton = TEMPLATE_REGISTRY[templateId];
  const script = VOICE_SCRIPTS[templateId];

  // ---- 1. the fills ----
  // pre_debit_notice declares no free slots; handing it fills is an error.
  const declared = new Set(skeleton.slots.filter((s) => s.kind === 'free').map((s) => s.name));
  const fills = values.agent
    ? await runAgent({ skeleton, language, toneRegister: 'friendly' })
    : Object.fromEntries(Object.entries(CANNED_FILLS).filter(([k]) => declared.has(k)));
  console.log(`fills (${values.agent ? 'agent' : 'canned'}):`, fills);

  // ---- 2. the script ----
  const immutables = buildVoiceImmutableValues(
    templateId,
    249_900,
    'INV-4271',
    'Priya Sharma',
    '1 September 2026',
  );
  const spoken = renderVoiceScript(skeleton, script, immutables, fills);
  console.log(`\nscript (${spoken.length} chars):\n${spoken}\n`);

  // ---- 3. the audio ----
  const synth: VoiceSynthesizer =
    process.env['VOICE_MODE'] === 'mock'
      ? new MockSynthesizer()
      : new SarvamSynthesizer(process.env['SARVAM_API_KEY'] ?? '');
  const audio = await synth.speak({
    script: spoken,
    language,
    ...(values.speaker ? { speaker: values.speaker } : {}),
  });

  mkdirSync(new URL('../out/', import.meta.url), { recursive: true });
  const outPath = new URL(`../out/${templateId}-${language}.ogg`, import.meta.url);
  writeFileSync(outPath, audio.bytes);
  console.log(
    `audio: ${audio.bytes.length} bytes via ${synth.name} → ${decodeURIComponent(outPath.pathname)}`,
  );

  // ---- 4. delivery, only when asked ----
  if (!values.to) {
    console.log('\ndry run — no --to given, nothing sent. Listen to the file above.');
    return;
  }
  const sender: WhatsAppSender =
    process.env['WHATSAPP_MODE'] === 'live'
      ? new MetaWhatsAppSender(
          process.env['WHATSAPP_ACCESS_TOKEN'] ?? '',
          process.env['WHATSAPP_PHONE_NUMBER_ID'] ?? '',
        )
      : new MockWhatsAppSender();
  const sent = await sender.sendVoice({ to: values.to, audio });
  console.log(`sent via ${sender.name}: ${sent.providerMessageId}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
