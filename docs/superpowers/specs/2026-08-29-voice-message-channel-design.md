# Voice message channel — design

**Date:** 2026-08-29
**Status:** approved, pending implementation plan

## Problem

RECLAIM contacts customers on exactly one channel: email. `Channel` is
`z.enum(['email'])` in `packages/shared/src/enums.ts`, `communications.channel`
is the same single-value enum in the database, and `tools/execute.ts` calls
`deps.mailer.send()` at three sites.

We want a second, accompanying channel: a **spoken WhatsApp voice note**,
synthesised by Sarvam AI, sent alongside every email the system already sends.

The constraint that shapes everything: RECLAIM's central principle is *"AI
agents reason about recovery; deterministic code controls money."* Every
customer-facing message today is a `TEMPLATE_REGISTRY` skeleton whose
`{{amount}}` and `{{invoice_number}}` slots are injected server-side from the
invoice, and whose free slots (`{{greeting}}`, `{{context_sentence}}`,
`{{sign_off}}`) are the only text an agent authors. The voice channel must sit
under the same discipline, or it becomes the one place an agent can say a
number out loud.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| WhatsApp provider | Meta WhatsApp Cloud API | Audio uploads to the Media API and is sent by `media_id`, so local testing needs no public hosting. |
| Voice script definition | A `voiceScript` field on each existing `TemplateSkeleton` | One template id renders both forms, so they cannot drift, and `validateFreeFills` stays the single definition of an acceptable fill. |
| Relationship to email | Two `communications` rows per send, one per channel | The two deliveries fail independently and each needs its own `providerMessageId`, `sentAt`, and `consentSnapshot`. |
| Agent involvement | None beyond today's `slotFills` | No new action type, no channel choice. Every `send_email` also produces a voice note. |
| Audio codec | `opus` (`audio/ogg`) | WhatsApp renders ogg/opus as a real voice note with a waveform; other formats appear as a file attachment. Also ~20x smaller than WAV. |
| Audio storage | New `voice_messages` table | `routes.ts:132` does `db.select().from(communications)`, so a `bytea` column there would ship audio into every case-detail response. |

### Rejected alternatives

- **Voice as a second rendering on one `communications` row.** Cannot answer
  "the email sent, the voice note did not" without a second set of columns, at
  which point it is the two-row design with worse names.
- **`send_voice_message` as a new `ActionParams` member.** Gives the agent a
  channel lever nobody asked it to pull, and adds a proposal shape, a policy
  rule and an approval path. Per the comment in `actions.ts` — *"What a schema
  cannot express cannot be retried, escalated, or argued with"* — leaving it
  out is the conservative move. Easy to add later, hard to remove.
- **Agent authors the whole spoken script as free text.** Puts the agent back
  in the position of authoring a message that mentions money.

## Sarvam API facts

Established from `docs.sarvam.ai`:

- `POST https://api.sarvam.ai/text-to-speech`, header `api-subscription-key`
- `model: "bulbul:v3"`, `text` <= 2,500 characters
- `language_code` is BCP-47: `en-IN`, `hi-IN`
- `output_audio_codec: "opus"` (default is `wav`)
- Response is JSON with an `audios` array of base64 strings; join then
  `Buffer.from(joined, 'base64')`
- Speakers are lowercase and case-sensitive. Lowest critical error rate:
  `mani` (male, 0.00%), `priya` (female, 0.13%), `ishita` (female, 0.13%).

Language mapping from the existing `Language` enum:

| RECLAIM `Language` | Sarvam `language_code` |
|---|---|
| `en` | `en-IN` |
| `hi` | `hi-IN` |
| `hinglish` | `en-IN` |

`hinglish` maps to `en-IN` because Sarvam has no Hinglish code and the
Devanagari-free mixed register reads acceptably under the Indian-English voice.

## Architecture

### One agent output, two messages

```
                 agent slotFills          server immutables
                 greeting, context_       amount = ₹2,499.00
                 sentence, sign_off       invoice_number = INV-4271
                          |                        |
              +-----------+------------------------+----------+
              v                                               v
      renderTemplate()                            renderVoiceScript()
      (unchanged)                                 (new, same signature)
              |                                               |
              v                                               v
      { subject, body }                           spoken script, no URL
      ...{{payment_link}}...                      "...2,499 rupees... we have
              |                                    emailed you a secure link"
              v                                               v
        mailer.send()                              synthesizer.speak()  -> opus
              |                                               v
              |                                    whatsapp.sendVoice()
              v                                               v
   communications row                            communications row
   channel='email'                               channel='whatsapp_voice'
                                                 + voice_messages row
```

Both renderers call the same `validateFreeFills`. A fill that is bad for email
is bad for voice.

### Speaking money: `formatINRForSpeech`

`formatINR(249900)` returns `"₹2,499.00"`. Correct for an email, a hazard
for TTS: the ₹ glyph may be misread and `.00` becomes "point zero zero".
Since the amount is the one thing that must be spoken correctly, a
deterministic sibling formatter lives next to `formatINR`:

| paise | `formatINR` | `formatINRForSpeech` |
|---|---|---|
| `249900` | `₹2,499.00` | `2,499 rupees` |
| `250000` | `₹2,500.00` | `2,500 rupees` |
| `249950` | `₹2,499.50` | `2,499 rupees 50 paise` |
| `100` | `₹1.00` | `1 rupee` |
| `50` | `₹0.50` | `50 paise` |

Rules: use Indian digit grouping as `formatINR` does; drop a zero paise
component; singularise `rupee`/`paisa` at exactly 1; when the rupee component
is zero, emit only the paise component. The agent still never touches a number.

### Voice scripts

Each `TemplateSkeleton` in `apps/api/src/templates/registry.ts` gains a
required `voiceScript: string` field. Rules, enforced by test:

1. Every registry entry has one.
2. No `voiceScript` may contain `{{payment_link}}` — a URL read aloud is
   useless. Scripts say "we have emailed you a secure payment link" instead.
3. A `voiceScript` may reference only slots the skeleton already declares, plus
   nothing new. `renderVoiceScript` throws `TemplateRenderError` on an
   undeclared slot, exactly as `renderTemplate` does.
4. `{{legal_footer}}` is omitted from voice scripts; the opt-out instruction is
   spoken in plain language where the template needs one.

`pre_debit_notice` gets a `voiceScript` too, with no free slots, matching its
fully-deterministic email form.

`renderVoiceScript(skeleton, immutableValues, freeFills)` mirrors
`renderTemplate` in signature and in every validation it performs, with **one
deliberate difference in the coverage rule**:

`renderTemplate` requires a value for *every* immutable slot the skeleton
declares. Applied verbatim to voice that rule is wrong — a `voiceScript` omits
`{{payment_link}}` and `{{legal_footer}}` by design (rules 2 and 4 above), so it
would demand exactly the values a voice script must not carry. Reusing it would
have made every voice render fail with `missing immutable slot value
'payment_link'`.

So `renderVoiceScript` requires a value only for the slots the `voiceScript`
text **actually references**. Everything else is identical: free fills go
through the same `validateFreeFills`, an undeclared `{{slot}}` is still a hard
`TemplateRenderError`, and an unfilled placeholder is still an error.

Its immutable values come from `buildVoiceImmutableValues(templateId, invoice,
amountDuePaise)`, a sibling of the existing `buildImmutableValues` in
`tools/execute.ts`. It differs in exactly two ways: `amount` is formatted with
`formatINRForSpeech`, and `payment_link` / `legal_footer` are absent. Keeping it
as a separate function rather than a flag on the existing one means the email
path is untouched and the speech path cannot accidentally inherit a URL.

## Phase 1 — the sandbox

A standalone workspace package proves the pipeline before RECLAIM is touched.

```
voice-testing/
  package.json          @reclaim/voice-testing, private
  tsconfig.json
  README.md             Meta app setup + how to open the 24h window
  src/
    voice.ts            VoiceSynthesizer iface | SarvamSynthesizer | MockSynthesizer
    whatsapp.ts         WhatsAppSender   iface | MetaWhatsAppSender | MockSender
    voiceScript.ts      VOICE_SCRIPTS map + renderVoiceScript + formatINRForSpeech
    agent.ts            --agent mode: real LlmClient call producing slotFills
    cli.ts              arg parsing and wiring
  out/                  .ogg output, gitignored
```

`voice.ts` and `whatsapp.ts` mirror `apps/api/src/mailer/` exactly — interface,
real adapter, mock. That symmetry is the promotion path.

Two supporting changes:

- `pnpm-workspace.yaml` gains `- "voice-testing"` (it currently globs only
  `apps/*` and `packages/*`).
- `apps/api/package.json` gains
  `"exports": { "./templates/registry": "./src/templates/registry.ts" }`, so the
  sandbox validates fills against the live skeletons rather than a copy.
  Purely additive; nothing imports `@reclaim/api` by package name today.

The sandbox is placed at the repository root rather than under `packages/`
precisely so it reads as temporary and is easy to find and delete.

### CLI

```
pnpm voice:try -- --template <id> --lang <en|hi|hinglish> [--canned|--agent]
                  [--speaker <name>] [--to <e164>]
```

`--canned` uses fixed `slotFills` and makes no LLM call. `--agent` makes a real
Communication-agent call through the existing `LlmClient`. **Dry run is the
default**: without `--to`, audio is written to `out/` and nothing is sent. The
safe path is the one you get by forgetting a flag.

### Test sequence

Each step isolates one failure domain.

1. `--canned` (no `--to`) — proves the Sarvam key, the opus output and the
   voice quality. No WhatsApp, no LLM.
2. `--canned --to <number>` — proves Meta accepts Sarvam's opus and that it
   arrives as a waveform voice note rather than a file attachment. A fixed
   message means a bad result is the codec's fault or Meta's, never the model's.
3. `--agent --to <number>` — proves the full chain.

### Meta Cloud API flow

1. `POST /{WHATSAPP_PHONE_NUMBER_ID}/media` — multipart, `messaging_product=whatsapp`,
   `type=audio/ogg` — returns `{ id }`.
2. `POST /{WHATSAPP_PHONE_NUMBER_ID}/messages` with
   `{ messaging_product: "whatsapp", to, type: "audio", audio: { id } }`.

**An audio message is a freeform message**, and WhatsApp permits freeform
messages only inside an open 24-hour customer service window. Business-initiated
contact must be a pre-approved template, and template headers support
image/video/document but **not** audio. So before step 2 the tester must
WhatsApp the test number from their own phone. Missing this returns error
`131047` (re-engagement), which reads like a broken token. Meta's test number is
also limited to 5 pre-registered recipients.

This is a real product constraint, not just a testing one: in production, voice
notes reach only customers with an open window. Cases without one get the email
alone, which the skip path below already handles.

### Credentials

Added to `.env` and `.env.example`:

```ini
SARVAM_API_KEY=
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
```

The sandbox reads the root `.env` with `--env-file-if-exists=../.env`, matching
the existing script convention in `apps/api/package.json`.

## Phase 2 — RECLAIM integration

### Migration `0004`

```
customers        + phone             text          nullable
                 + whatsapp_consent  boolean       not null default false

communications     channel           enum widened to ['email','whatsapp_voice']

voice_messages   (new)
                   id                uuid pk default random
                   communication_id  uuid not null unique -> communications.id
                   mime_type         text not null
                   audio             bytea not null
                   duration_ms       integer
                   sarvam_request_id text
                   created_at        timestamptz not null default now()
```

The spoken script needs no new column: it is stored in
`communications.rendered_body`, with `rendered_subject` null. A voice note has
no subject.

`whatsapp_consent` defaults to **false**. Reusing `email_consent` would grant a
channel the customer never agreed to.

`Channel` in `packages/shared/src/enums.ts` widens to match.

The seed generator populates `phone` and `whatsapp_consent` for demo customers
so the UI has voice notes to show.

### `tools/execute.ts`

A single helper, `deliverVoiceNote(...)`, is appended after each of the three
existing `mailer.send()` sites (`create_payment_link`, `schedule_mandate_reexecution`,
`send_email`).

**It must never throw.** The idempotency claim is keyed
`caseId:interventionId:attempt`; a *failed* claim is re-claimed on retry and
`runTool` re-runs from the top, including `mailer.send()`. If a Sarvam timeout
propagated out of the tool, BullMQ would retry and the customer would receive a
second email — reintroducing the bug fixed in commit `08fb3a9` ("a case could
send the same email twice") through a new door.

Therefore:

- Synthesis and delivery are wrapped in `try/catch`.
- Failure writes a `voice.failed` audit event and returns; the intervention
  still succeeds.
- Skips are audited, not silent: `customer.optedOut`, `phone == null`, or
  `whatsappConsent == false` write `voice.skipped` with a reason.
- Email is the channel of record. Voice is an accompaniment that must never
  take it down.

**No policy-engine change.** `bumpAttemptCounters` already fires once per
intervention. The voice note is the same contact to the same customer at the
same moment; counting it separately would wrongly tighten the 24-hour spacing
rule and the per-invoice attempt cap.

### Configuration

Two independent switches, mirroring `MAILER_MODE`:

```ini
VOICE_MODE=sarvam      # sarvam | mock   -- generate the audio
WHATSAPP_MODE=mock     # mock   | live   -- deliver it
```

Defaults are `sarvam` and `mock`: the voice note is really generated and
appears in the UI, and reaches nobody. Flipping delivery on is a one-word
change against code that is already written and tested.

`env.ts` enforces that `VOICE_MODE=sarvam` requires `SARVAM_API_KEY` and
`WHATSAPP_MODE=live` requires both `WHATSAPP_ACCESS_TOKEN` and
`WHATSAPP_PHONE_NUMBER_ID`, following the existing `PAYMENTS_MODE=live-test`
precedent. Tests force `VOICE_MODE=mock` so CI never calls Sarvam.

### API

`GET /cases/:caseId/communications/:id/audio` — authenticated like the rest of
the API, streams the `voice_messages.audio` bytes with the stored `mime_type`.
Returns 404 when the communication is not a voice row or has no audio.

The existing case-detail query is unchanged; audio is never joined into it.

### UI

`apps/web/src/routes/cases.$caseId.tsx:194` maps communications. Voice rows
render an `<audio controls>` pointing at the endpoint above, with the script
shown beneath as a visible transcript, and a channel/language/template label
consistent with the existing email entries.

While `WHATSAPP_MODE=mock`, each voice row carries a **"not sent"** badge. This
is load-bearing: the console must never imply a customer received something
they did not.

## Testing

| Level | Test |
|---|---|
| unit | `formatINRForSpeech` — zero paise, non-zero paise, singular rupee, paise-only, lakh-scale grouping |
| unit | `renderVoiceScript` — immutable injection, free-fill lint, undeclared slot throws, and a script referencing no `payment_link` renders without one |
| unit | coverage: every `TEMPLATE_REGISTRY` entry has a `voiceScript`, and no `voiceScript` contains `{{payment_link}}` (mirrors the existing coverage test in `test/unit/templates.test.ts`) |
| unit | language mapping `en|hi|hinglish` -> `en-IN|hi-IN|en-IN` |
| integration | one `send_email` produces two `communications` rows and one `voice_messages` row |
| integration | `whatsappConsent == false` produces the email row only, plus a `voice.skipped` audit event |
| safety | **a throwing synthesizer leaves the email sent exactly once and the intervention `executed`** — the regression guard against the double-send described above |
| safety | `WHATSAPP_MODE=mock` performs no outbound HTTP to Meta |

## Out of scope

- Inbound WhatsApp replies. The reply interpreter stays email-only; a voice
  reply is a separate problem (speech-to-text, a new `direction='inbound'`
  voice row, intent extraction from a transcript).
- Agent-chosen channel. Reconsider only if evidence shows voice helps on some
  case types and not others.
- WhatsApp template approval for business-initiated contact. Voice reaches only
  open 24-hour windows; widening that needs Meta template review and is a
  product decision, not an engineering one.
- Audio storage outside Postgres. Opus keeps a 15-second note near 15-25 KB;
  object storage is warranted only if volume proves otherwise.
