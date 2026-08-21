import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Conventions:
 * - All money columns are integer paise (bigint), never floats.
 * - `recovery_ledger` and `audit_events` are append-only: corrections are
 *   reversing entries; application code never issues UPDATE/DELETE on them.
 * - `payment_methods` stores token references only; PANs never exist here.
 */

const ts = { withTimezone: true } as const;

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['admin', 'operator', 'viewer'] }).notNull(),
  createdAt: timestamp('created_at', ts).notNull().defaultNow(),
});

export const customers = pgTable('customers', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  timezone: text('timezone').notNull().default('Asia/Kolkata'),
  preferredLanguage: text('preferred_language', { enum: ['en', 'hi', 'hinglish'] })
    .notNull()
    .default('en'),
  optedOut: boolean('opted_out').notNull().default(false),
  optedOutAt: timestamp('opted_out_at', ts),
  emailConsent: boolean('email_consent').notNull().default(true),
  createdAt: timestamp('created_at', ts).notNull().defaultNow(),
});

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: uuid('customer_id').notNull().references(() => customers.id),
  kind: text('kind', { enum: ['b2c', 'b2b'] }).notNull(),
  companyName: text('company_name'),
  createdAt: timestamp('created_at', ts).notNull().defaultNow(),
});

export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: uuid('customer_id').notNull().references(() => customers.id),
  planName: text('plan_name').notNull(),
  mrrPaise: bigint('mrr_paise', { mode: 'number' }).notNull(),
  status: text('status', { enum: ['active', 'pending', 'halted', 'cancelled', 'completed'] })
    .notNull()
    .default('active'),
  rail: text('rail', { enum: ['card', 'upi_autopay', 'emandate', 'netbanking'] }).notNull(),
  providerSubscriptionId: text('provider_subscription_id').unique(),
  startedAt: timestamp('started_at', ts).notNull(),
  createdAt: timestamp('created_at', ts).notNull().defaultNow(),
});

export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id').notNull().references(() => customers.id),
    accountId: uuid('account_id').references(() => accounts.id),
    subscriptionId: uuid('subscription_id').references(() => subscriptions.id),
    amountDuePaise: bigint('amount_due_paise', { mode: 'number' }).notNull(),
    amountPaidPaise: bigint('amount_paid_paise', { mode: 'number' }).notNull().default(0),
    currency: text('currency').notNull().default('INR'),
    status: text('status', { enum: ['open', 'overdue', 'paid', 'void'] }).notNull().default('open'),
    dueDate: timestamp('due_date', ts).notNull(),
    providerInvoiceId: text('provider_invoice_id').unique(),
    createdAt: timestamp('created_at', ts).notNull().defaultNow(),
  },
  (t) => [index('invoices_status_due_idx').on(t.status, t.dueDate)],
);

export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  invoiceId: uuid('invoice_id').notNull().references(() => invoices.id),
  customerId: uuid('customer_id').notNull().references(() => customers.id),
  amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
  status: text('status', { enum: ['captured', 'failed', 'refunded'] }).notNull(),
  rail: text('rail', { enum: ['card', 'upi_autopay', 'emandate', 'netbanking'] }).notNull(),
  via: text('via', { enum: ['payment_link', 'mandate_execution', 'provider_retry', 'out_of_band', 'initial_charge'] }),
  providerPaymentId: text('provider_payment_id').unique(),
  capturedAt: timestamp('captured_at', ts),
  createdAt: timestamp('created_at', ts).notNull().defaultNow(),
});

/** Token references ONLY. PANs never enter this system. */
export const paymentMethods = pgTable('payment_methods', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: uuid('customer_id').notNull().references(() => customers.id),
  rail: text('rail', { enum: ['card', 'upi_autopay', 'emandate', 'netbanking'] }).notNull(),
  tokenRef: text('token_ref').notNull(),
  cardLast4: text('card_last4'),
  cardExpiryMonth: integer('card_expiry_month'),
  cardExpiryYear: integer('card_expiry_year'),
  mandateRef: text('mandate_ref'),
  mandateMaxPaise: bigint('mandate_max_paise', { mode: 'number' }),
  createdAt: timestamp('created_at', ts).notNull().defaultNow(),
});

export const failureEvents = pgTable(
  'failure_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id').notNull().references(() => customers.id),
    invoiceId: uuid('invoice_id').notNull().references(() => invoices.id),
    subscriptionId: uuid('subscription_id').references(() => subscriptions.id),
    rail: text('rail', { enum: ['card', 'upi_autopay', 'emandate', 'netbanking'] }).notNull(),
    declineCode: text('decline_code'),
    declineClass: text('decline_class', {
      enum: ['soft', 'hard', 'auth_required', 'processor_error', 'ambiguous'],
    }),
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
    providerPaymentId: text('provider_payment_id'),
    occurredAt: timestamp('occurred_at', ts).notNull(),
    createdAt: timestamp('created_at', ts).notNull().defaultNow(),
  },
  (t) => [index('failure_events_customer_idx').on(t.customerId, t.occurredAt)],
);

export const recoveryCases = pgTable(
  'recovery_cases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id').notNull().references(() => customers.id),
    invoiceId: uuid('invoice_id').notNull().references(() => invoices.id),
    subscriptionId: uuid('subscription_id').references(() => subscriptions.id),
    state: text('state', {
      enum: [
        'detected', 'diagnosed', 'planned', 'pending_policy', 'pending_approval',
        'executing', 'waiting', 're_evaluating', 'recovered', 'stopped',
        'escalated', 'lost', 'disputed',
      ],
    }).notNull().default('detected'),
    leakType: text('leak_type', {
      enum: ['subscription_payment_failure', 'invoice_overdue', 'unknown'],
    }).notNull().default('unknown'),
    causeHypothesis: text('cause_hypothesis', {
      enum: [
        'expired_card', 'insufficient_funds', 'hard_decline', 'auth_required',
        'processor_error', 'procurement_delay', 'invoice_dispute_suspected',
        'cash_flow_stress', 'habitual_late_payer', 'unknown',
      ],
    }),
    causeConfidence: text('cause_confidence'), // numeric string 0..1; parsed via Zod at read
    /** denormalized amount due at detection; queue sort key */
    exposurePaise: bigint('exposure_paise', { mode: 'number' }).notNull(),
    holdoutArm: text('holdout_arm', { enum: ['treatment', 'holdout'] }).notNull(),
    attributionWindowEndsAt: timestamp('attribution_window_ends_at', ts).notNull(),
    urgencySignals: jsonb('urgency_signals').$type<string[]>().notNull().default([]),
    agentInvocationCount: integer('agent_invocation_count').notNull().default(0),
    recoveryAttemptCount: integer('recovery_attempt_count').notNull().default(0),
    lastAttemptAt: timestamp('last_attempt_at', ts),
    lastProgressAt: timestamp('last_progress_at', ts).notNull().defaultNow(),
    waitUntil: timestamp('wait_until', ts),
    openedAt: timestamp('opened_at', ts).notNull().defaultNow(),
    /**
     * Set when a dispute is raised, cleared ONLY by an explicit human
     * resolution. Deliberately NOT derived from `state`: the compliance
     * freeze must survive the case moving through other states.
     */
    disputedAt: timestamp('disputed_at', ts),
    disputeResolvedByUserId: uuid('dispute_resolved_by_user_id'),
    closedAt: timestamp('closed_at', ts),
    stopReason: text('stop_reason'),
  },
  (t) => [
    index('cases_state_idx').on(t.state),
    index('cases_customer_idx').on(t.customerId),
    // one open case per invoice is enforced in code within the creation tx
    index('cases_invoice_idx').on(t.invoiceId),
  ],
);

export const interventions = pgTable(
  'interventions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id').notNull().references(() => recoveryCases.id),
    actionType: text('action_type', {
      enum: [
        'schedule_mandate_reexecution', 'create_payment_link', 'send_email',
        'schedule_reminder', 'record_promise_to_pay', 'escalate_to_human',
        'stop_workflow', 'mark_wait',
      ],
    }).notNull(),
    params: jsonb('params').notNull(),
    rationale: text('rationale'),
    confidence: text('confidence'),
    stopConditions: jsonb('stop_conditions').$type<string[]>().notNull().default([]),
    proposedBy: text('proposed_by', { enum: ['agent', 'human'] }).notNull(),
    proposedByUserId: uuid('proposed_by_user_id').references(() => users.id),
    status: text('status', {
      enum: ['proposed', 'pending_approval', 'approved', 'denied', 'executing', 'executed', 'failed', 'cancelled'],
    }).notNull().default('proposed'),
    policyDecisionId: uuid('policy_decision_id'),
    executedAt: timestamp('executed_at', ts),
    createdAt: timestamp('created_at', ts).notNull().defaultNow(),
  },
  (t) => [index('interventions_case_idx').on(t.caseId)],
);

/**
 * One row per execution attempt of an intervention.
 * idempotencyKey = `${caseId}:${interventionId}:${attempt}` — the unique
 * constraint is the hard guarantee that a duplicate BullMQ job can never
 * double-execute (no duplicate payment link, no duplicate mandate debit).
 */
export const toolExecutions = pgTable(
  'tool_executions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id').notNull().references(() => recoveryCases.id),
    interventionId: uuid('intervention_id').notNull().references(() => interventions.id),
    attempt: integer('attempt').notNull().default(1),
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status', { enum: ['started', 'succeeded', 'failed'] }).notNull().default('started'),
    result: jsonb('result'),
    error: text('error'),
    startedAt: timestamp('started_at', ts).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', ts),
  },
  (t) => [uniqueIndex('tool_exec_idem_uq').on(t.idempotencyKey)],
);

export const communications = pgTable(
  'communications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id').notNull().references(() => recoveryCases.id),
    customerId: uuid('customer_id').notNull().references(() => customers.id),
    interventionId: uuid('intervention_id').references(() => interventions.id),
    direction: text('direction', { enum: ['outbound', 'inbound'] }).notNull(),
    channel: text('channel', { enum: ['email'] }).notNull().default('email'),
    templateId: text('template_id'),
    language: text('language', { enum: ['en', 'hi', 'hinglish'] }),
    renderedSubject: text('rendered_subject'),
    renderedBody: text('rendered_body').notNull(),
    /** consent state snapshot at send time */
    consentSnapshot: jsonb('consent_snapshot'),
    providerMessageId: text('provider_message_id'),
    sentAt: timestamp('sent_at', ts),
    createdAt: timestamp('created_at', ts).notNull().defaultNow(),
  },
  (t) => [index('comms_case_idx').on(t.caseId), index('comms_customer_sent_idx').on(t.customerId, t.sentAt)],
);

export const promisesToPay = pgTable('promises_to_pay', {
  id: uuid('id').primaryKey().defaultRandom(),
  caseId: uuid('case_id').notNull().references(() => recoveryCases.id),
  customerId: uuid('customer_id').notNull().references(() => customers.id),
  promisedDate: timestamp('promised_date', ts).notNull(),
  amountReference: text('amount_reference'),
  status: text('status', { enum: ['open', 'kept', 'broken'] }).notNull().default('open'),
  recordedAt: timestamp('recorded_at', ts).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', ts),
});

export const agentDecisions = pgTable(
  'agent_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id').notNull().references(() => recoveryCases.id),
    agent: text('agent', {
      enum: ['triage', 'diagnosis', 'strategy', 'communication', 'reply_interpreter', 'summarizer'],
    }).notNull(),
    model: text('model').notNull(),
    promptVersionHash: text('prompt_version_hash').notNull(),
    inputSnapshot: jsonb('input_snapshot').notNull(),
    output: jsonb('output'),
    schemaValid: boolean('schema_valid').notNull(),
    confidence: text('confidence'),
    latencyMs: integer('latency_ms').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    createdAt: timestamp('created_at', ts).notNull().defaultNow(),
  },
  (t) => [index('agent_decisions_case_idx').on(t.caseId)],
);

export const policyDecisions = pgTable(
  'policy_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id').notNull().references(() => recoveryCases.id),
    interventionId: uuid('intervention_id').references(() => interventions.id),
    requestSnapshot: jsonb('request_snapshot').notNull(),
    verdict: text('verdict', { enum: ['ALLOW', 'DENY', 'REQUIRE_APPROVAL'] }).notNull(),
    reason: text('reason'),
    ruleTrace: jsonb('rule_trace').notNull(),
    policyVersion: integer('policy_version').notNull(),
    createdAt: timestamp('created_at', ts).notNull().defaultNow(),
  },
  (t) => [index('policy_decisions_case_idx').on(t.caseId)],
);

/** APPEND-ONLY. Corrections are reversing entries referencing the original. */
export const recoveryLedger = pgTable(
  'recovery_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id').notNull().references(() => recoveryCases.id),
    invoiceId: uuid('invoice_id').notNull().references(() => invoices.id),
    customerId: uuid('customer_id').notNull().references(() => customers.id),
    paymentId: uuid('payment_id').references(() => payments.id),
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
    attributionClass: text('attribution_class', { enum: ['direct', 'assisted', 'external'] }).notNull(),
    holdoutArm: text('holdout_arm', { enum: ['treatment', 'holdout'] }).notNull(),
    entryType: text('entry_type', { enum: ['recovery', 'reversal'] }).notNull().default('recovery'),
    reversesLedgerId: uuid('reverses_ledger_id'),
    recordedAt: timestamp('recorded_at', ts).notNull().defaultNow(),
  },
  (t) => [index('ledger_case_idx').on(t.caseId)],
);

/** APPEND-ONLY audit trail. */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id'),
    actorType: text('actor_type', { enum: ['system', 'agent', 'human', 'provider'] }).notNull(),
    actorId: text('actor_id'),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', ts).notNull().defaultNow(),
  },
  (t) => [index('audit_case_idx').on(t.caseId, t.createdAt)],
);

/** Versioned policy rules; a new row per edit, exactly one active. */
export const policyRules = pgTable('policy_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  version: integer('version').notNull().unique(),
  config: jsonb('config').notNull(),
  comment: text('comment'),
  createdByUserId: uuid('created_by_user_id').references(() => users.id),
  active: boolean('active').notNull().default(false),
  createdAt: timestamp('created_at', ts).notNull().defaultNow(),
});

export const templates = pgTable('templates', {
  id: text('id').primaryKey(), // human-readable template id, e.g. 'payment_failed_gentle_v1'
  skeleton: jsonb('skeleton').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', ts).notNull().defaultNow(),
});

/** Raw webhook intake. Unique provider event id = at-least-once dedupe. */
export const webhookInbox = pgTable(
  'webhook_inbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').notNull().default('razorpay'),
    providerEventId: text('provider_event_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    receivedAt: timestamp('received_at', ts).notNull().defaultNow(),
    processedAt: timestamp('processed_at', ts),
  },
  (t) => [uniqueIndex('webhook_inbox_provider_event_uq').on(t.provider, t.providerEventId)],
);

/** Transactional outbox: written in the same tx as state changes. */
export const outbox = pgTable(
  'outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamp('created_at', ts).notNull().defaultNow(),
    processedAt: timestamp('processed_at', ts),
  },
  (t) => [index('outbox_unprocessed_idx').on(t.processedAt, t.createdAt)],
);
