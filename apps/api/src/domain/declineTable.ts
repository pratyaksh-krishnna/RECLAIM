import type { DeclineClass } from '@reclaim/shared';

/**
 * THE deterministic decline table. Maps provider decline codes to a decline
 * class and defines per-class retry legality. This is data + pure functions —
 * no LLM is ever consulted for an unambiguous code. Codes not listed are
 * 'ambiguous' and go to the Triage agent.
 */
export const DECLINE_TABLE_VERSION = 1;

const CODE_TO_CLASS: Record<string, DeclineClass> = {
  // card
  expired_card: 'hard',
  card_expired: 'hard',
  card_lost: 'hard',
  card_stolen: 'hard',
  pickup_card: 'hard',
  account_closed: 'hard',
  transaction_not_permitted: 'hard',
  insufficient_funds: 'soft',
  withdrawal_limit_exceeded: 'soft',
  authentication_required: 'auth_required',
  auth_required: 'auth_required',
  issuer_unavailable: 'processor_error',
  gateway_error: 'processor_error',
  processor_error: 'processor_error',
  do_not_honor: 'ambiguous',
  generic_decline: 'ambiguous',
  // UPI AutoPay / e-mandate
  upi_insufficient_balance: 'soft',
  mandate_paused: 'hard',
  mandate_cancelled: 'hard',
  mandate_revoked: 'hard',
  mandate_max_amount_exceeded: 'hard',
  upi_app_unavailable: 'processor_error',
  // netbanking
  netbanking_failure: 'processor_error',
};

export function classifyDeclineCode(code: string | null | undefined): DeclineClass {
  if (!code) return 'ambiguous';
  return CODE_TO_CLASS[code.toLowerCase()] ?? 'ambiguous';
}

/** May the system itself schedule another debit attempt for this class? */
export function isRetryableClass(declineClass: DeclineClass): boolean {
  switch (declineClass) {
    case 'soft':
    case 'processor_error':
      return true;
    case 'hard':
    case 'auth_required':
    case 'ambiguous':
      return false;
  }
}

/** Classes whose cause is already determined without any agent. */
export function isUnambiguous(declineClass: DeclineClass): boolean {
  return declineClass !== 'ambiguous';
}
