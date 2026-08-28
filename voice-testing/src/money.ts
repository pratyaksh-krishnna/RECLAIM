/**
 * Money, spoken. The sibling of formatINR in apps/api/src/templates/registry.ts,
 * which produces "₹2,499.00" — correct in an email and a hazard in a
 * synthesiser, where the ₹ glyph may be misread and ".00" becomes
 * "point zero zero".
 *
 * The amount is the one thing in a voice note that must be exactly right, so
 * it is deterministic code here for the same reason it is deterministic code
 * on the email path. An agent still never touches a number.
 */
export function formatINRForSpeech(paise: number): string {
  if (!Number.isInteger(paise) || paise < 0) {
    throw new Error(`formatINRForSpeech expects non-negative integer paise, got ${paise}`);
  }
  const rupees = Math.floor(paise / 100);
  const remainder = paise % 100;

  const parts: string[] = [];
  if (rupees > 0) {
    parts.push(`${rupees.toLocaleString('en-IN')} ${rupees === 1 ? 'rupee' : 'rupees'}`);
  }
  if (remainder > 0) {
    parts.push(`${remainder} ${remainder === 1 ? 'paisa' : 'paise'}`);
  }
  // 0 paise is a real amount to speak, not an empty string
  return parts.length > 0 ? parts.join(' ') : '0 rupees';
}
