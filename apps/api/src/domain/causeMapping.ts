import type { CauseHypothesis } from '@reclaim/shared';

/**
 * Deterministic decline-code → cause mapping for the unambiguous cases the
 * spec routes around the agents ("triage is resolved by the deterministic
 * decline table BEFORE the agent runs"). Returns null when only an agent can
 * form a hypothesis.
 */
export function causeFromDeclineCode(code: string | null | undefined): CauseHypothesis | null {
  if (!code) return null;
  switch (code.toLowerCase()) {
    case 'expired_card':
    case 'card_expired':
      return 'expired_card';
    case 'insufficient_funds':
    case 'upi_insufficient_balance':
    case 'withdrawal_limit_exceeded':
      return 'insufficient_funds';
    case 'authentication_required':
    case 'auth_required':
      return 'auth_required';
    case 'issuer_unavailable':
    case 'gateway_error':
    case 'processor_error':
    case 'upi_app_unavailable':
    case 'netbanking_failure':
      return 'processor_error';
    case 'card_lost':
    case 'card_stolen':
    case 'pickup_card':
    case 'account_closed':
    case 'transaction_not_permitted':
    case 'mandate_paused':
    case 'mandate_cancelled':
    case 'mandate_revoked':
    case 'mandate_max_amount_exceeded':
      return 'hard_decline';
    default:
      return null; // ambiguous → triage/diagnosis agents
  }
}
