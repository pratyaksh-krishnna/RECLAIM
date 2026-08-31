import {
  lintFreeSlotFills,
  type Language,
  type LocalizedText,
  type TemplateId,
  type TemplateSkeleton,
} from '@reclaim/shared';

/**
 * Pick one language out of a LocalizedText.
 *
 * Every field carries every language, so this cannot miss — which is the
 * point. The alternative, an English string plus optional overrides, silently
 * falls back to English for the customer who least wants it.
 */
export function localize(text: LocalizedText, language: Language): string {
  return text[language];
}

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

/**
 * A date, written or spoken, in the customer's language.
 *
 * Hinglish takes the English form on purpose: it is Latin-script by
 * definition, and "1 September 2026" is what a Hinglish speaker writes.
 */
export function formatDateIST(date: Date, language: Language): string {
  const locale = language === 'hi' ? 'hi-IN' : 'en-IN';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'Asia/Kolkata' }).format(date);
}

/**
 * Money, spoken. formatINR above produces "₹2,499.00" — right in an email and
 * a hazard in a synthesiser, where the ₹ glyph may be misread and ".00"
 * becomes "point zero zero". The amount is the one thing a voice note must get
 * exactly right, so it is deterministic here for the same reason the written
 * form is. An agent still never touches a number.
 */
const CURRENCY_WORDS: Record<Language, { rupee: string; rupees: string; paisa: string; paise: string }> = {
  en: { rupee: 'rupee', rupees: 'rupees', paisa: 'paisa', paise: 'paise' },
  hi: { rupee: 'रुपया', rupees: 'रुपये', paisa: 'पैसा', paise: 'पैसे' },
  hinglish: { rupee: 'rupee', rupees: 'rupees', paisa: 'paisa', paise: 'paise' },
};

export function formatINRForSpeech(paise: number, language: Language): string {
  if (!Number.isInteger(paise) || paise < 0) {
    throw new Error(`formatINRForSpeech expects non-negative integer paise, got ${paise}`);
  }
  const w = CURRENCY_WORDS[language];
  const rupees = Math.floor(paise / 100);
  const remainder = paise % 100;
  const parts: string[] = [];
  // The DIGITS stay Latin digits in every language, exactly as the English
  // form always kept them ("499 rupees", never "four hundred ninety nine").
  // Sarvam's preprocessing reads a numeral in the voice's own language, so
  // hi-IN says "चार सौ निन्यानवे" unaided; only the currency word has to
  // change, and spelling numbers out by hand would add a converter whose edge
  // cases nothing else in this file has.
  if (rupees > 0) parts.push(`${rupees.toLocaleString('en-IN')} ${rupees === 1 ? w.rupee : w.rupees}`);
  if (remainder > 0) parts.push(`${remainder} ${remainder === 1 ? w.paisa : w.paise}`);
  return parts.length > 0 ? parts.join(' ') : `0 ${w.rupees}`;
}

/**
 * An invoice reference, spoken.
 *
 * providerInvoiceId is a machine id — "inv_d4c775ba-254" — and read aloud that
 * is "i n v underscore d four c seven seven five b a dash two five four",
 * which no listener can hold or repeat back. Billers say "ending 254" on the
 * phone for the same reason, and the customer has the invoice in hand, so the
 * tail identifies it.
 *
 * The tail is spoken CHARACTER BY CHARACTER, spaced. Handed "8776" the
 * synthesiser says "eight thousand seven hundred seventy six", and handed
 * "f9f3" it attempts a word — neither of which a listener can match against
 * the id printed on their invoice. Spacing forces "eight seven seven six",
 * which is what someone writing it down needs to hear.
 *
 * Written messages keep the full id: you read those with your eyes.
 */
const ENDING_WORD: Record<Language, string> = {
  en: 'ending',
  hi: 'अंतिम अंक',
  hinglish: 'ending',
};

export function formatInvoiceRefForSpeech(reference: string, language: Language): string {
  const segments = reference.split(/[^0-9A-Za-z]+/).filter(Boolean);
  const tail = segments[segments.length - 1] ?? reference;
  // The tail itself stays as printed on the invoice — it is an identifier the
  // customer matches character for character, not a word to translate.
  return `${ENDING_WORD[language]} ${tail.slice(-4).split('').join(' ')}`;
}

const commonFreeSlots = [
  { name: 'greeting', kind: 'free' as const, maxLength: 120, description: 'personal greeting, no numbers/links/amounts' },
  { name: 'context_sentence', kind: 'free' as const, maxLength: 300, description: 'one empathetic context sentence, no numbers/links/amounts' },
  { name: 'sign_off', kind: 'free' as const, maxLength: 120, description: 'sign-off line, no numbers/links/amounts' },
];

/**
 * Typed by TemplateId: a missing or extra template is a compile error, and
 * every text field is a LocalizedText, so is a missing translation.
 *
 * The opt-out keyword stays the literal "STOP" in all three languages. It is a
 * command the customer types back, not prose — translating it would leave a
 * Hindi customer told to reply with a word our own reply interpreter was never
 * shown.
 *
 * The Hindi is EVERYDAY Hindi, not शुद्ध हिंदी. Billing vocabulary in India is
 * English: people say पेमेंट, इनवॉइस, लिंक, ड्यू — not भुगतान, चालान, देय.
 * Sanskritised Hindi reads as a government form, which is the opposite of what
 * a payment reminder wants to sound like.
 *
 * Those loanwords are written in DEVANAGARI, never Latin script. hi-IN
 * mispronounces Latin text — the same fact that sends Hinglish to en-IN in
 * sarvamLanguageCode — so "पेमेंट लिंक" is heard correctly where "payment
 * link" would not be.
 */
export const TEMPLATE_REGISTRY: Record<TemplateId, TemplateSkeleton> = {
  payment_failed_notice: {
    templateId: 'payment_failed_notice',
    subject: {
      en: 'Payment issue on invoice {{invoice_number}}',
      hi: 'इनवॉइस {{invoice_number}} पर पेमेंट की दिक्कत',
      hinglish: 'Invoice {{invoice_number}} par payment ki dikkat',
    },
    body: {
      en: `{{greeting}}

{{context_sentence}}

Your payment of {{amount}} for invoice {{invoice_number}} could not be processed.
Pay securely here (UPI, cards, netbanking): {{payment_link}}

{{sign_off}}

{{legal_footer}}`,
      hi: `{{greeting}}

{{context_sentence}}

इनवॉइस {{invoice_number}} के लिए आपका {{amount}} का पेमेंट प्रोसेस नहीं हो पाया।
यहाँ सुरक्षित तरीके से पेमेंट करें (यूपीआई, कार्ड, नेटबैंकिंग): {{payment_link}}

{{sign_off}}

{{legal_footer}}`,
      hinglish: `{{greeting}}

{{context_sentence}}

Invoice {{invoice_number}} ke liye aapka {{amount}} ka payment process nahi ho paya.
Yahan surakshit tareeke se payment karein (UPI, cards, netbanking): {{payment_link}}

{{sign_off}}

{{legal_footer}}`,
    },
    voiceScript: {
      en: `{{greeting}} {{context_sentence}} Your payment of {{amount}} for invoice {{invoice_number}} could not be processed. We have emailed you a secure payment link — please check your inbox to complete it. If you would rather not receive these messages, just reply STOP. {{sign_off}}`,
      hi: `{{greeting}} {{context_sentence}} इनवॉइस {{invoice_number}} के लिए आपका {{amount}} का पेमेंट प्रोसेस नहीं हो पाया। हमने आपको ईमेल पर एक सुरक्षित पेमेंट लिंक भेजा है — उसे पूरा करने के लिए अपना इनबॉक्स देखें। अगर आप ये मैसेज नहीं चाहते, तो जवाब में STOP लिख दें। {{sign_off}}`,
      hinglish: `{{greeting}} {{context_sentence}} Invoice {{invoice_number}} ke liye aapka {{amount}} ka payment process nahi ho paya. Humne aapko email par ek surakshit payment link bheja hai — use poora karne ke liye apna inbox dekhein. Agar aap ye messages nahi chahte, to jawab mein STOP likh dein. {{sign_off}}`,
    },
    slots: [
      ...commonFreeSlots,
      { name: 'amount', kind: 'immutable', description: 'exact amount due, server-injected' },
      { name: 'invoice_number', kind: 'immutable', description: 'invoice reference, server-injected' },
      { name: 'payment_link', kind: 'immutable', description: 'provider short URL, server-injected' },
      { name: 'legal_footer', kind: 'immutable', description: 'legal/opt-out text, server-injected' },
    ],
  },
  payment_link_delivery: {
    templateId: 'payment_link_delivery',
    subject: {
      en: 'Payment link for invoice {{invoice_number}} — {{amount}}',
      hi: 'इनवॉइस {{invoice_number}} के लिए पेमेंट लिंक — {{amount}}',
      hinglish: 'Invoice {{invoice_number}} ke liye payment link — {{amount}}',
    },
    body: {
      en: `{{greeting}}

{{context_sentence}}

Amount due: {{amount}} for invoice {{invoice_number}}.
Pay securely here (UPI, cards, netbanking): {{payment_link}}

{{sign_off}}

{{legal_footer}}`,
      hi: `{{greeting}}

{{context_sentence}}

बाकी अमाउंट: इनवॉइस {{invoice_number}} के लिए {{amount}}।
यहाँ सुरक्षित तरीके से पेमेंट करें (यूपीआई, कार्ड, नेटबैंकिंग): {{payment_link}}

{{sign_off}}

{{legal_footer}}`,
      hinglish: `{{greeting}}

{{context_sentence}}

Baaki rashi: invoice {{invoice_number}} ke liye {{amount}}.
Yahan surakshit tareeke se payment karein (UPI, cards, netbanking): {{payment_link}}

{{sign_off}}

{{legal_footer}}`,
    },
    voiceScript: {
      en: `{{greeting}} {{context_sentence}} The amount due on invoice {{invoice_number}} is {{amount}}. We have emailed you a secure payment link — please check your inbox to complete it. If you would rather not receive these messages, just reply STOP. {{sign_off}}`,
      hi: `{{greeting}} {{context_sentence}} इनवॉइस {{invoice_number}} पर बाकी अमाउंट {{amount}} है। हमने आपको ईमेल पर एक सुरक्षित पेमेंट लिंक भेजा है — उसे पूरा करने के लिए अपना इनबॉक्स देखें। अगर आप ये मैसेज नहीं चाहते, तो जवाब में STOP लिख दें। {{sign_off}}`,
      hinglish: `{{greeting}} {{context_sentence}} Invoice {{invoice_number}} par baaki rashi {{amount}} hai. Humne aapko email par ek surakshit payment link bheja hai — use poora karne ke liye apna inbox dekhein. Agar aap ye messages nahi chahte, to jawab mein STOP likh dein. {{sign_off}}`,
    },
    slots: [
      ...commonFreeSlots,
      { name: 'amount', kind: 'immutable', description: 'exact amount due' },
      { name: 'invoice_number', kind: 'immutable', description: 'invoice reference' },
      { name: 'payment_link', kind: 'immutable', description: 'provider short URL, server-injected' },
      { name: 'legal_footer', kind: 'immutable', description: 'legal/opt-out text' },
    ],
  },
  pre_debit_notice: {
    templateId: 'pre_debit_notice',
    subject: {
      en: 'Upcoming auto-debit of {{amount}} on {{debit_date}}',
      hi: '{{debit_date}} को {{amount}} का आने वाला ऑटो-डेबिट',
      hinglish: '{{debit_date}} ko {{amount}} ka aane wala auto-debit',
    },
    body: {
      en: `Dear {{customer_name}},

As per your active mandate, {{amount}} for invoice {{invoice_number}} will be debited on {{debit_date}}.

No action is needed if you wish to proceed. To cancel this debit, use your UPI or bank app before the debit date.

{{legal_footer}}`,
      hi: `नमस्ते {{customer_name}},

आपके एक्टिव मैंडेट के अनुसार, इनवॉइस {{invoice_number}} के लिए {{amount}} {{debit_date}} को डेबिट किया जाएगा।

अगर आप आगे बढ़ना चाहते हैं तो कुछ करने की ज़रूरत नहीं है। इस डेबिट को कैंसिल करने के लिए, डेबिट डेट से पहले अपना यूपीआई या बैंक ऐप इस्तेमाल करें।

{{legal_footer}}`,
      hinglish: `Namaste {{customer_name}},

Aapke active mandate ke anusaar, invoice {{invoice_number}} ke liye {{amount}} {{debit_date}} ko debit kiya jayega.

Agar aap aage badhna chahte hain to kuch karne ki zaroorat nahi hai. Is debit ko cancel karne ke liye, debit date se pehle apne UPI ya bank app ka upyog karein.

{{legal_footer}}`,
    },
    voiceScript: {
      en: `Dear {{customer_name}}. As per your active mandate, {{amount}} for invoice {{invoice_number}} will be debited on {{debit_date}}. No action is needed if you wish to proceed. To cancel this debit, use your UPI or bank app before the debit date.`,
      hi: `नमस्ते {{customer_name}}। आपके एक्टिव मैंडेट के अनुसार, इनवॉइस {{invoice_number}} के लिए {{amount}} {{debit_date}} को डेबिट किया जाएगा। अगर आप आगे बढ़ना चाहते हैं तो कुछ करने की ज़रूरत नहीं है। इस डेबिट को कैंसिल करने के लिए, डेबिट डेट से पहले अपना यूपीआई या बैंक ऐप इस्तेमाल करें।`,
      hinglish: `Namaste {{customer_name}}. Aapke active mandate ke anusaar, invoice {{invoice_number}} ke liye {{amount}} {{debit_date}} ko debit kiya jayega. Agar aap aage badhna chahte hain to kuch karne ki zaroorat nahi hai. Is debit ko cancel karne ke liye, debit date se pehle apne UPI ya bank app ka upyog karein.`,
    },
    // compliance notice: NO free slots — fully deterministic
    slots: [
      { name: 'customer_name', kind: 'immutable', description: 'customer name, server-injected' },
      { name: 'amount', kind: 'immutable', description: 'exact debit amount' },
      { name: 'invoice_number', kind: 'immutable', description: 'invoice reference' },
      { name: 'debit_date', kind: 'immutable', description: 'scheduled debit date' },
      { name: 'legal_footer', kind: 'immutable', description: 'legal text' },
    ],
  },
  payment_reminder: {
    templateId: 'payment_reminder',
    subject: {
      en: 'Reminder: invoice {{invoice_number}} ({{amount}}) is due',
      hi: 'रिमाइंडर: इनवॉइस {{invoice_number}} ({{amount}}) ड्यू है',
      hinglish: 'Reminder: invoice {{invoice_number}} ({{amount}}) due hai',
    },
    body: {
      en: `{{greeting}}

{{context_sentence}}

Invoice {{invoice_number}} for {{amount}} was due on {{due_date}} and remains unpaid.
Pay securely here (UPI, cards, netbanking): {{payment_link}}

{{sign_off}}

{{legal_footer}}`,
      hi: `{{greeting}}

{{context_sentence}}

{{amount}} का इनवॉइस {{invoice_number}} {{due_date}} को ड्यू था और अभी तक पेंडिंग है।
यहाँ सुरक्षित तरीके से पेमेंट करें (यूपीआई, कार्ड, नेटबैंकिंग): {{payment_link}}

{{sign_off}}

{{legal_footer}}`,
      hinglish: `{{greeting}}

{{context_sentence}}

{{amount}} ka invoice {{invoice_number}} {{due_date}} ko due tha aur abhi tak unpaid hai.
Yahan surakshit tareeke se payment karein (UPI, cards, netbanking): {{payment_link}}

{{sign_off}}

{{legal_footer}}`,
    },
    voiceScript: {
      en: `{{greeting}} {{context_sentence}} Invoice {{invoice_number}} for {{amount}} was due on {{due_date}} and is still open. We have emailed you a secure payment link — please check your inbox to complete it. If you would rather not receive these messages, just reply STOP. {{sign_off}}`,
      hi: `{{greeting}} {{context_sentence}} {{amount}} का इनवॉइस {{invoice_number}} {{due_date}} को ड्यू था और अभी भी पेंडिंग है। हमने आपको ईमेल पर एक सुरक्षित पेमेंट लिंक भेजा है — उसे पूरा करने के लिए अपना इनबॉक्स देखें। अगर आप ये मैसेज नहीं चाहते, तो जवाब में STOP लिख दें। {{sign_off}}`,
      hinglish: `{{greeting}} {{context_sentence}} {{amount}} ka invoice {{invoice_number}} {{due_date}} ko due tha aur abhi bhi khula hai. Humne aapko email par ek surakshit payment link bheja hai — use poora karne ke liye apna inbox dekhein. Agar aap ye messages nahi chahte, to jawab mein STOP likh dein. {{sign_off}}`,
    },
    slots: [
      ...commonFreeSlots,
      { name: 'amount', kind: 'immutable', description: 'exact amount due' },
      { name: 'invoice_number', kind: 'immutable', description: 'invoice reference' },
      { name: 'due_date', kind: 'immutable', description: 'original due date' },
      { name: 'payment_link', kind: 'immutable', description: 'provider short URL, server-injected' },
      { name: 'legal_footer', kind: 'immutable', description: 'legal text' },
    ],
  },
};

/**
 * The two legal footers, server-injected. They live here rather than as string
 * literals at the two call sites in execute.ts for the same reason the
 * templates do: a footer that exists in English only is how a fully translated
 * message ends in an English sentence.
 */
export const LEGAL_FOOTERS = {
  payment_notice: {
    en: 'This is a payment notice regarding your account. Reply STOP to opt out.',
    hi: 'यह आपके अकाउंट से जुड़ा एक पेमेंट नोटिस है। मैसेज बंद करने के लिए जवाब में STOP लिखें।',
    hinglish: 'Yeh aapke account se sambandhit ek payment notice hai. Messages band karne ke liye jawab mein STOP likhein.',
  },
  emandate: {
    en: 'As per RBI e-mandate guidelines, you may cancel before the debit date.',
    hi: 'आरबीआई ई-मैंडेट गाइडलाइंस के अनुसार, आप डेबिट डेट से पहले इसे कैंसिल कर सकते हैं।',
    hinglish: 'RBI e-mandate guidelines ke anusaar, aap debit date se pehle ise cancel kar sakte hain.',
  },
} as const satisfies Record<string, LocalizedText>;

/**
 * Deterministic default fills used when no agent output is involved (money
 * path), per language. English-only defaults were the second half of the
 * mixed-language message: even with a translated skeleton, the money path fed
 * these three English sentences into it.
 */
export const DEFAULT_FREE_FILLS: Record<Language, Record<string, string>> = {
  en: {
    greeting: 'Hello,',
    context_sentence: 'We were unable to collect your recent payment, and wanted to make it easy to complete.',
    sign_off: 'Thank you,\nThe Billing Team',
  },
  hi: {
    greeting: 'नमस्ते,',
    context_sentence: 'हम आपका रीसेंट पेमेंट कलेक्ट नहीं कर पाए, और इसे पूरा करना आसान बनाना चाहते थे।',
    sign_off: 'धन्यवाद,\nबिलिंग टीम',
  },
  hinglish: {
    greeting: 'Namaste,',
    context_sentence: 'Hum aapka recent payment collect nahi kar paye, aur ise poora karna aasan banana chahte the.',
    sign_off: 'Dhanyavaad,\nBilling Team',
  },
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
  language: Language,
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
      if (freeSlotNames.has(name)) return freeFills[name] ?? DEFAULT_FREE_FILLS[language][name] ?? '';
      throw new TemplateRenderError(`undeclared slot '{{${name}}}' in template ${skeleton.templateId}`);
    });

  return { subject: fill(localize(skeleton.subject, language)), body: fill(localize(skeleton.body, language)) };
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
  language: Language,
  immutableValues: Record<string, string>,
  freeFills: Record<string, string>,
): string {
  const freeSlotNames = new Set(skeleton.slots.filter((s) => s.kind === 'free').map((s) => s.name));
  const immutableSlotNames = new Set(
    skeleton.slots.filter((s) => s.kind === 'immutable').map((s) => s.name),
  );

  const problems = validateFreeFills(skeleton, freeFills);
  if (problems.length > 0) throw new TemplateRenderError(problems.join('; '));

  return localize(skeleton.voiceScript, language).replace(/\{\{(\w+)\}\}/g, (_m, name: string) => {
    if (immutableSlotNames.has(name)) {
      const value = immutableValues[name];
      if (value === undefined) throw new TemplateRenderError(`missing immutable slot value '${name}'`);
      return value;
    }
    if (freeSlotNames.has(name)) return freeFills[name] ?? DEFAULT_FREE_FILLS[language][name] ?? '';
    throw new TemplateRenderError(`undeclared slot '{{${name}}}' in voice script ${skeleton.templateId}`);
  });
}
