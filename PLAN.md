# RECLAIM — Implementation Plan

**R**evenue **E**vent **C**apture, **L**earning, and **I**ntervention **M**anager: a bounded multi-agent AI revenue recovery system. Detects revenue at risk (failed subscription payments, overdue B2B invoices), diagnoses cause, selects an intervention, executes within strict policy limits, and proves incremental recovery against a randomized 10% holdout.

**Central principle:** AI agents reason about recovery; deterministic code controls money. No agent ever computes, emits, or modifies a monetary amount that reaches a customer or payment API.

**Hard constraint:** No ML anywhere. All money control = deterministic rules and tables; all agent reasoning = real `claude-haiku-4-5` calls (no stub/mock in `src/`); reasoning = Anthropic LLM calls with forced tool use / strict Zod-validated JSON. Schema failure → one retry → human review.

---

## Architecture Recap

### Monorepo (pnpm workspaces)

```
apps/api          Express + BullMQ workers + Drizzle (single deployable, workers in-process)
apps/web          React + Vite + TanStack Router/Query/Table + shadcn/ui + Recharts
packages/shared   Zod schemas, types, event catalog, action catalog, state machine types
```

### Event flow

```
Razorpay webhook
  → raw-body HMAC SHA-256 verify (X-Razorpay-Signature) BEFORE JSON.parse
  → INSERT webhook_inbox (unique provider_event_id = dedupe; delivery is at-least-once)
  → transactional outbox
  → normalizer worker: Razorpay events → canonical internal events
  → orchestrator consumes
```

Canonical events: `payment.failed`, `invoice.overdue`, `payment.recovered`, `subscription.retrying`, `subscription.retries_exhausted`, `customer.responded`, `customer.broke_promise`, `recovery.stopped`. `subscription.pending` maps to `subscription.retrying` ("Razorpay is retrying — hold off on aggressive outreach"); `subscription.halted` maps to `subscription.retries_exhausted` and triggers our own recovery plan. `invoice.overdue` is synthesized by a daily BullMQ repeatable job scanning due dates. Every state transition + outbox event + audit row commits in **one DB transaction**. Webhook handlers never mutate cases.

### Orchestrator (deterministic code, NOT an LLM)

Owns the case FSM:

```
detected → diagnosed → planned → pending_policy → pending_approval → executing
        → waiting → re_evaluating → recovered | stopped | escalated | lost | disputed
```

- Single-writer per case via `SELECT ... FOR UPDATE`
- Routes to the next agent purely from state
- Loop guards: max agent invocations per case; max wall-clock age without progress → force escalate
- At case creation: random arm assignment — treatment 90% / holdout 10% (observe-only, no interventions ever execute; outcomes still tracked)

### Agents (BullMQ workers; communicate only via typed queue jobs + structured records)

| Agent | Model | Job |
|---|---|---|
| Triage | Haiku | Leak taxonomy + urgency for **every** case (no hardcoded short-circuit) |
| Diagnosis | Haiku | Cause hypothesis from CLOSED enum (`expired_card, insufficient_funds, hard_decline, auth_required, processor_error, procurement_delay, invoice_dispute_suspected, cash_flow_stress, habitual_late_payer, unknown`) + confidence + evidence citing record IDs |
| Strategy | Haiku | `ProposedAction` from the enumerated catalog only — never an execution |
| Communication | Haiku | Fills bounded free-text slots in approved template skeletons (EN/Hindi/Hinglish). Amounts/dates/links/legal text are immutable server-injected slots. Deterministic lint rejects any numeral, URL, or currency symbol in free slots |
| Reply Interpreter | Haiku | Inbound text → intent enum (`paid_claim, will_pay, promise_with_date, dispute, opt_out, question, hostile, unclear`) + promise extraction. Customer text passed only as delimited data, never instructions |
| Summarizer | Haiku | Case summaries for escalation inbox, citing event IDs |

Every invocation persisted as an `AgentDecision` row (agent, model+version, prompt version hash, input snapshot, output JSON, confidence, latency, token cost). No chain-of-thought stored.

### Policy Engine (deterministic middleware between Strategy and any execution)

Evaluates `PolicyRequest` against versioned JSON rules in Postgres → `ALLOW | DENY(reason) | REQUIRE_APPROVAL(reason)` + full rule trace, persisted as `PolicyDecision`. Evaluation order (first DENY wins):

1. **Hard compliance:** opt-out, open dispute, quiet hours (customer TZ), per-channel consent
2. **Rail limits:** decline-table retry ceilings (soft retryable, hard never); global cap 4 attempts/invoice; min 24h spacing. **India rules as policy data:** UPI AutoPay re-execution requires pre-debit notification ≥24h before debit (notification job scheduled first, then execution job); e-mandate debit > ₹15,000 requires AFA → above that, only autonomous action is a payment link
3. **Contact budget:** max 3 emails per rolling 14 days per customer
4. **Financial limits:** autonomous execution only ≤ amount cap; above → approval. No discount/waiver/refund action exists in the catalog at all
5. **Confidence gate:** strategy confidence < 0.6 with exposure > threshold → approval
6. **Loop guards**

### Action Catalog (the ONLY proposable actions)

`schedule_mandate_reexecution` · `create_payment_link` · `send_email` · `schedule_reminder` · `record_promise_to_pay` · `escalate_to_human` (always allowed) · `stop_workflow` (always allowed) · `mark_wait`

Each tool: Zod-validated IO, per-tool authorization against case state, idempotency key `caseId:actionId:attempt` (unique DB constraint; passed to the provider where the endpoint supports idempotency), external-call retry with backoff, structured result, `AuditEvent` write. Tools are the only code allowed to call Razorpay or the mailer. Amounts and mandate refs always resolved server-side from the invoice.

### Payments

`PaymentProvider` interface; **only** the Razorpay adapter (test mode). Razorpay runs its own subscription retry cycle — we never fire ad-hoc card charges. Levers: exact-amount Payment Links (UPI/cards/netbanking), mandate re-execution scheduling where the rail permits, communications.

### Attribution & holdout

Windows: 30d payment failures, 90d receivables. Ledger attribution class: `direct | assisted | external` (external never credited); holdout outcomes = baseline. Incremental = treatment rate − holdout rate, with two-proportion confidence interval (pure-function arithmetic).

### Data model (Drizzle, Postgres 16)

`customers, accounts, subscriptions, invoices, payments, payment_methods (token refs only), failure_events, recovery_cases, interventions, communications, promises_to_pay, agent_decisions, policy_decisions, recovery_ledger (append-only), audit_events (append-only), policy_rules (versioned), templates, webhook_inbox, outbox`. Append-only tables take corrections as reversing entries, never UPDATEs.

### API (Express, Zod-validated, JWT sessions, RBAC admin/operator/viewer)

`POST /webhooks/razorpay` · `GET /recovery/cases` · `GET /recovery/cases/:id` · `POST /recovery/cases/:id/{approve,intervene,stop,analyze}` · `GET /analytics/{revenue-risk,recovery,interventions}` · `GET|POST /policies` · `GET /audit/cases/:id`. Human interventions go through the same catalog and same policy gate.

### Frontend (file-based routes, polling via TanStack Query)

`/` Command Center · `/cases` Risk Queue (ranked by exposure = amount due; holdout badge, action-locked) · `/cases/$caseId` Case View (diagnosis + evidence, policy trace, message preview with locked slots, approve/modify/stop) · `/approvals` · `/policies` Policy Studio (versioned rules, diff history) · `/experiments` (incremental recovery + CI).

---

## Build Order

1. **Foundation:** pnpm workspaces, TS strict, ESLint/Prettier/Vitest, `docker-compose.yml` (Postgres 16 + Redis), Zod `env.ts` + `.env.example`, `packages/shared` (enums, event/action catalogs, Zod schemas), all Drizzle migrations
2. **Ingestion:** raw-body HMAC verification, `webhook_inbox` dedupe, transactional outbox + relay worker, normalizer (Razorpay → canonical), daily `invoice.overdue` scanner
3. **Orchestrator:** FSM + transition table, `FOR UPDATE` single-writer, BullMQ queue wiring, holdout assignment, loop guards
4. **Money controls:** decline-class table, policy engine (6 rule categories, versioned rules, rule trace), tools with `caseId:actionId:attempt` idempotency, Razorpay adapter behind `PaymentProvider`, mock mailer behind `Mailer`
5. **Agents:** LLM provider abstraction (`src/llm/`), forced-tool-use structured outputs, retry-once-then-escalate, the 6 agents, AgentDecision persistence, free-slot lint
6. **Ledger & attribution:** append-only ledger, reconciliation (external payments), attribution windows, two-proportion CI
7. **API:** routes above + JWT/RBAC
8. **Frontend:** Queue → Case View → Approvals → Command Center → Policy Studio → Experiments
9. **Seed/replay:** `pnpm seed` (1,000 India-realistic cases: ~30% expired cards, insufficient-funds clustered pre-month-end, B2B aging tail, habitual late payers, scripted dispute + opt-out, ≥1 case above ₹15,000 AFA threshold), `pnpm replay` through the webhook path
10. **Safety suite:** every non-negotiable safety requirement gets a test (schema+policy+lint gate, webhook dedupe, job idempotency, pre-debit precedence, dispute/opt-out hard stop, prompt-injection red team, budget/ceiling enforcement even against agent proposals)

Each phase lands with its own Vitest coverage; TDD for policy engine, tools, attribution, and lint (the money paths).

---

## Open Questions / Working Assumptions

1. **Stripe removed entirely (user decision, 2026-08-22):** no Stripe code, adapter, or references remain. The `PaymentProvider` interface has exactly two implementations — the Razorpay test adapter and the offline sandbox. Internal idempotency (unique constraint) is enforced regardless of provider support.
2. **API keys (revised 2026-08-22):** `ANTHROPIC_API_KEY` is REQUIRED — agents are always real `claude-haiku-4-5` calls and the API refuses to boot without it. Payments stay mocked via the sandbox provider (no Razorpay keys needed). Tests inject a fake at the `LlmClient` seam; no fake exists in `src/`.
3. **Amount cap & thresholds:** autonomous amount cap, confidence-gate exposure threshold, quiet hours window. **Assumption:** seeded as editable policy data — cap ₹5,000, exposure threshold ₹10,000, quiet hours 21:00–09:00 IST — all changeable in Policy Studio.
4. **Auth:** simple JWT sessions with seeded demo users (admin/operator/viewer), no signup flow.
5. **Git:** directory is not a repo. **Assumption:** `git init` and commit per phase.
6. **pnpm:** not installed; enabled via corepack (ships with Node 22 — no new dependency).

---

## Explicitly NOT built

**Removed by user decision (2026-08-21):** revenue-at-risk priority scoring (E·L·U−C and the L/U lookup tables). Queue ranks by exposure (amount due); Command Center "open revenue at risk" is a plain sum of open amounts due.

Checkout abandonment, SMS/WhatsApp, voice, any ML/vector store/RAG, refunds/discounts/payment plans, any second PSP, microservices, Kafka, websockets, RL/bandits. No stubs for these.
