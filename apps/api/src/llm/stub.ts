import type { LlmClient, StructuredCallArgs, StructuredCallResult } from './client.js';

/**
 * Deterministic offline stand-in for the Anthropic client. Produces
 * schema-shaped outputs from simple keyword rules so the entire pipeline —
 * including demos and the safety suite — runs with no API key. This is NOT
 * ML and NOT the decision authority; the same policy engine and lints gate
 * its output exactly as they gate live model output.
 */

interface StubCaseInput {
  leakType?: string;
  causeHypothesis?: string | null;
  declineClass?: string | null;
  declineCode?: string | null;
  rail?: string;
  amountDuePaise?: number;
  daysOverdue?: number;
  invoiceId?: string;
  failureEventIds?: string[];
  priorFailureCount?: number;
  brokenPromiseCount?: number;
  emailsSentLast14d?: number;
  hasPaymentLinkOutstanding?: boolean;
  lastDenyReason?: string | null;
  lastReplyIntent?: string | null;
  customer_message?: string;
  language?: string;
  templateId?: string;
  customerName?: string;
  eventIds?: string[];
  accountKind?: string;
}

function pick(input: unknown): StubCaseInput {
  return (input ?? {}) as StubCaseInput;
}

export class StubLlmClient implements LlmClient {
  readonly mode = 'stub' as const;

  async completeStructured(args: StructuredCallArgs): Promise<StructuredCallResult> {
    const started = Date.now();
    const raw = this.produce(args.schemaName, pick(args.input));
    return {
      raw,
      modelId: `stub-${args.modelClass}`,
      inputTokens: JSON.stringify(args.input).length / 4,
      outputTokens: 64,
      latencyMs: Date.now() - started,
    };
  }

  private produce(schemaName: string, input: StubCaseInput): unknown {
    switch (schemaName) {
      case 'triage_output': {
        const isB2B = input.accountKind === 'b2b' || input.leakType === 'invoice_overdue';
        return {
          leakType: isB2B ? 'invoice_overdue' : 'subscription_payment_failure',
          urgencySignals:
            (input.daysOverdue ?? 0) > 60
              ? ['aging past 60 days', 'recovery odds decay sharply']
              : (input.priorFailureCount ?? 0) > 1
                ? ['repeat failure pattern']
                : [],
          isUrgent: (input.daysOverdue ?? 0) > 60 || (input.amountDuePaise ?? 0) > 1_000_000,
          reasoningSummary: 'stub: classified from leak context fields',
        };
      }
      case 'diagnosis_output': {
        const cause = this.diagnose(input);
        return {
          causeHypothesis: cause,
          confidence: cause === 'unknown' ? 0.4 : 0.75,
          evidence: [
            {
              recordType: 'failure_events',
              recordId: input.failureEventIds?.[0] ?? input.invoiceId ?? 'none',
              field: 'decline_code',
              observation: `decline_code=${input.declineCode ?? 'n/a'}, class=${input.declineClass ?? 'n/a'}`,
            },
          ],
          reasoningSummary: 'stub: mapped from decline class, aging and history',
        };
      }
      case 'strategy_output': {
        return this.strategize(input);
      }
      case 'communication_output': {
        const hinglish = input.language === 'hinglish';
        return {
          slotFills: {
            greeting: hinglish ? `Namaste ${input.customerName ?? ''} ji,`.trim() : `Dear ${input.customerName ?? 'customer'},`,
            context_sentence: hinglish
              ? 'Aapka recent payment complete nahi ho paya, isliye hum yeh reminder bhej rahe hain.'
              : 'Your recent payment could not be completed, so we are reaching out to help you finish it.',
            sign_off: hinglish ? 'Dhanyavaad,\nBilling Team' : 'Warm regards,\nThe Billing Team',
          },
        };
      }
      case 'reply_interpretation': {
        return this.interpret(input.customer_message ?? '');
      }
      case 'summarizer_output': {
        return {
          summary: `stub summary: case with cause=${input.causeHypothesis ?? 'unknown'}, exposure=${input.amountDuePaise ?? 0} paise. Escalated for human review.`,
          citedEventIds: (input.eventIds ?? []).slice(0, 5),
        };
      }
      default:
        return null;
    }
  }

  private diagnose(input: StubCaseInput): string {
    if (input.causeHypothesis) return input.causeHypothesis;
    switch (input.declineClass) {
      case 'soft':
        return 'insufficient_funds';
      case 'hard':
        return input.declineCode?.includes('expired') ? 'expired_card' : 'hard_decline';
      case 'auth_required':
        return 'auth_required';
      case 'processor_error':
        return 'processor_error';
    }
    if (input.leakType === 'invoice_overdue') {
      if ((input.brokenPromiseCount ?? 0) > 0) return 'habitual_late_payer';
      if ((input.daysOverdue ?? 0) > 45) return 'cash_flow_stress';
      return 'procurement_delay';
    }
    return 'unknown';
  }

  private strategize(input: StubCaseInput): unknown {
    const base = {
      rationale: 'stub strategy from cause/action heuristics',
      confidence: 0.72,
      stopConditions: ['customer disputes the charge', 'customer opts out', 'invoice is paid'],
    };
    if (input.lastDenyReason?.includes('quiet')) {
      const tomorrow = new Date(Date.now() + 12 * 3_600_000).toISOString();
      return { ...base, action: { type: 'schedule_reminder', remindAt: tomorrow, note: 'retry outside quiet hours' } };
    }
    if (input.lastReplyIntent === 'paid_claim') {
      const in3d = new Date(Date.now() + 3 * 86_400_000).toISOString();
      return { ...base, confidence: 0.7, action: { type: 'mark_wait', waitUntil: in3d, waitingFor: 'reconciliation of claimed payment' } };
    }
    if (input.lastReplyIntent === 'will_pay') {
      const in3d = new Date(Date.now() + 3 * 86_400_000).toISOString();
      return { ...base, confidence: 0.68, action: { type: 'schedule_reminder', remindAt: in3d, note: 'customer said they will pay; follow up' } };
    }
    if (input.lastDenyReason) {
      return { ...base, confidence: 0.5, action: { type: 'escalate_to_human', reason: `policy denied: ${input.lastDenyReason}` } };
    }
    switch (input.causeHypothesis) {
      case 'insufficient_funds': {
        if ((input.rail === 'upi_autopay' || input.rail === 'emandate') && (input.amountDuePaise ?? 0) <= 1_500_000) {
          const in48h = new Date(Date.now() + 48 * 3_600_000).toISOString();
          return { ...base, confidence: 0.8, action: { type: 'schedule_mandate_reexecution', scheduleAt: in48h } };
        }
        return { ...base, confidence: 0.78, action: { type: 'create_payment_link' } };
      }
      case 'expired_card':
      case 'hard_decline':
      case 'auth_required':
        return { ...base, confidence: 0.85, action: { type: 'create_payment_link' } };
      case 'processor_error':
        return { ...base, confidence: 0.7, action: { type: 'create_payment_link' } };
      case 'procurement_delay':
      case 'habitual_late_payer':
      case 'cash_flow_stress':
        if (input.hasPaymentLinkOutstanding || (input.emailsSentLast14d ?? 0) >= 1) {
          const in3d = new Date(Date.now() + 3 * 86_400_000).toISOString();
          return { ...base, confidence: 0.65, action: { type: 'schedule_reminder', remindAt: in3d, note: 'follow up on overdue invoice' } };
        }
        return {
          ...base,
          confidence: 0.7,
          action: {
            type: 'send_email',
            templateId: 'payment_reminder',
            language: input.language ?? 'en',
            toneRegister: 'formal',
            slotFills: {},
          },
        };
      default:
        return { ...base, confidence: 0.45, action: { type: 'escalate_to_human', reason: 'cause unclear; needs human judgment' } };
    }
  }

  private interpret(message: string): unknown {
    const m = message.toLowerCase();
    const injection =
      /(ignore|disregard).{0,40}(polic|instruction|rule)|mark.{0,30}paid|issue.{0,20}refund|waive|system prompt/.test(m);
    let intent = 'unclear';
    let promise: { date: string | null; amountReference: string | null } | null = null;
    if (/(stop|unsubscribe|opt.?out|don.?t (contact|email))/.test(m)) intent = 'opt_out';
    else if (/(dispute|chargeback|not authorized|didn.?t sign|fraud|wrong charge|contest)/.test(m)) intent = 'dispute';
    else if (/(already paid|payment done|paid it|पेमेंट हो|paid yesterday)/.test(m)) intent = 'paid_claim';
    else if (/(will pay|next week|by (mon|tue|wed|thu|fri|sat|sun)|salary|month end|pay on)/.test(m)) {
      const dateMatch = /by ([a-z]+day)|month end|next week/.exec(m);
      intent = dateMatch ? 'promise_with_date' : 'will_pay';
      if (dateMatch) {
        promise = { date: new Date(Date.now() + 7 * 86_400_000).toISOString(), amountReference: 'full amount' };
      }
    } else if (/[?]|how|why|what|kya|kaise/.test(m)) intent = 'question';
    else if (/(idiot|stupid|sue you|lawyer|harass)/.test(m)) intent = 'hostile';
    if (injection && intent === 'unclear') intent = 'unclear';
    return {
      intent,
      confidence: intent === 'unclear' ? 0.4 : 0.8,
      promise,
      containsInstructionAttempt: injection,
      summary: `stub: classified inbound message as ${intent}${injection ? ' with instruction-injection attempt' : ''}`,
    };
  }
}
