# voice-testing

A sandbox that proves the Sarvam → WhatsApp voice pipeline before any of it
touches RECLAIM. Delete this folder once the manual gate below has passed and
Phase 2 has landed.

## Setup

### 1. Sarvam

Get a key from https://dashboard.sarvam.ai and put it in the root `.env`:

```ini
SARVAM_API_KEY=sk_...
VOICE_MODE=sarvam
```

Without a key, run with `VOICE_MODE=mock` — the pipeline works end to end but
writes a placeholder OGG that will not play.

### 2. Meta WhatsApp Cloud API

1. Create an app at https://developers.facebook.com → Business → add the
   **WhatsApp** product.
2. From **WhatsApp → API Setup**, copy the temporary **access token** and the
   **Phone number ID** of the provided test number.
3. On that same page, add your own number under **To** and verify the code.
   The test number sends to at most 5 pre-registered recipients.

```ini
WHATSAPP_MODE=live
WHATSAPP_ACCESS_TOKEN=EAAG...
WHATSAPP_PHONE_NUMBER_ID=1234567890
```

The temporary token expires in 24 hours. A `401` on the media upload usually
means it lapsed, not that anything is wrong.

### 3. Open the 24-hour window — do not skip this

**An audio message is a freeform message, and WhatsApp allows freeform
messages only inside a 24-hour window opened by the customer.** Before any
`--to` run, send any WhatsApp message *from your phone to the test number*.

Skip it and Meta returns error **131047** ("Re-engagement message"), which
reads like a broken token.

Business-initiated contact must be a pre-approved template, and template
headers support image, video and document — **not audio**. There is no
configuration that sends a cold voice note.

## The three-step test

Each step isolates one failure domain. Do them in order.

```bash
# 1. Sarvam only. No WhatsApp, no LLM. Listen to the file it writes.
pnpm voice:try --template payment_failed_notice --lang hi --canned

# 2. + WhatsApp. Fixed message, so a bad result is the codec or Meta,
#    never the model. Confirm it arrives as a voice note with a waveform,
#    not as a file attachment.
pnpm voice:try --template payment_failed_notice --lang hi --canned --to +919812345678

# 3. Full chain, with a real Communication-agent call writing the fills.
pnpm voice:try --template payment_failed_notice --lang hi --agent --to +919812345678
```

Templates: `payment_failed_notice`, `payment_link_delivery`, `payment_reminder`,
`pre_debit_notice`. Languages: `en`, `hi`, `hinglish`.
Try `--speaker priya` or `--speaker ishita` to compare voices.

`--agent` honours `LLM_PROVIDER` from the root `.env`, so it calls the same
provider the product calls.

**Dry run is the default.** Without `--to`, nothing is sent.
