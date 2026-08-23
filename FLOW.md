# RECLAIM — How a case flows, end to end

This traces one failed payment from the moment Razorpay tells us about it to the
moment the money is counted (or written off), naming the real files and functions
at each step.

The one rule that shapes everything below:

> **Agents reason about recovery. Deterministic code controls money.**
> No agent ever computes, emits, or modifies a monetary amount that reaches a
> customer or a payment API. Amounts are always resolved server-side from the
> invoice at execution time.

---

## The short version

```
Razorpay webhook
  → verify signature → webhook_inbox (dedupe)
  → outbox → normalizer → canonical event
  → orchestrator opens a CASE, assigns treatment/holdout
  → triage agent → diagnosis agent → strategy agent   (reasoning)
  → POLICY ENGINE                                     (the gate — deterministic)
      ALLOW ─────────→ tool executes → email / payment link / mandate
      REQUIRE_APPROVAL → human inbox → operator approves → tool executes
      DENY ───────────→ back to re-planning
  → wait for the customer
  → payment arrives → ledger entry → case recovered
  → attribution compares treatment vs holdout → incremental recovery
```

Everything that touches money passes through the policy engine. There is no
second path.

---

## 1. Ingestion — getting the event in, exactly once

**`src/ingest/webhookRouter.ts`**

1. `POST /webhooks/razorpay` arrives.
2. The **raw body** is HMAC-SHA256 verified against `X-Razorpay-Signature`
   **before** `JSON.parse`. An invalid signature is rejected before the payload
   is ever interpreted (`src/ingest/verifySignature.ts`).
3. The event is inserted into `webhook_inbox`. `provider_event_id` is **unique**,
   so a redelivery is a no-op — provider delivery is at-least-once, and this is
   what makes our handling exactly-once.
4. A row goes into the **transactional outbox** in the same transaction.

> Webhook handlers never touch cases. They only record that something happened.
> This keeps the HTTP path fast and makes replay/redelivery safe.

**`src/ingest/outboxRelay.ts`** polls unprocessed outbox rows and publishes them.
**`src/ingest/normalizer.ts`** turns provider-shaped events into **canonical
events** so nothing downstream knows what a Razorpay payload looks like:

| Razorpay | Canonical | Meaning |
|---|---|---|
| `payment.failed` | `payment.failed` | a charge failed |
| `subscription.pending` | `subscription.retrying` | *Razorpay is still retrying — hold off* |
| `subscription.halted` | `subscription.retries_exhausted` | provider gave up; our plan starts |
| `invoice.paid` | `payment.recovered` | money arrived |

`invoice.overdue` has no webhook — it is synthesised by a daily scan of due dates
(`src/ingest/overdueScanner.ts`).

---

## 2. The orchestrator — deterministic, not an LLM

**`src/orchestrator/orchestrator.ts`**

The orchestrator owns the case lifecycle. It is ordinary code. It decides *which
agent runs next* purely from the case's current state — an agent never decides
what happens next.

### Case creation

`findOrCreateCaseForInvoice` (`caseService.ts`) opens one case per invoice and
immediately assigns the **arm**:

- **treatment (90%)** — the system works the case
- **holdout (10%)** — observe only. **Agents never run. Nothing ever executes.**

The holdout is the entire basis of the "does this system actually help?" claim,
so it is protected in two places: the runner refuses to run any agent on a
holdout case, and the policy engine's very first rule (`holdout_lock`) denies
every action on one.

### The state machine

**`src/orchestrator/fsm.ts`** — any transition not in the table throws.

```
detected → diagnosed → planned → pending_policy → pending_approval → executing
        → waiting → re_evaluating → recovered | stopped | escalated | lost | disputed
```

Every transition, outbox event and audit row commits in **one database
transaction**. A case is locked with `SELECT … FOR UPDATE` so only one writer
touches it at a time.

> **A subtlety worth knowing.** Dispatching an agent does *not* change the case
> state. So the lock alone does not prevent duplicate work: if two triggers
> arrive close together, the second one sees the same unchanged state and
> repeats the first one's decision. That once caused a customer to receive the
> same email twice. It is now prevented by checking for an already-open
> intervention, backed by a partial unique index — see §7.

---

## 3. The agents — six of them, all `claude-haiku-4-5`

**`src/agents/runner.ts`**. Every call is a real Anthropic call; there is no
stub, mock or heuristic fallback anywhere in `src/`.

| Agent | Job |
|---|---|
| **Triage** | leak type + urgency signals |
| **Diagnosis** | cause from a closed enum + confidence + evidence citing real record IDs |
| **Strategy** | one `ProposedAction` from the closed catalog — a *proposal*, never an execution |
| **Communication** | fills bounded free-text slots in an approved template |
| **Reply Interpreter** | inbound customer text → intent enum + promise extraction |
| **Summarizer** | a case brief for the human inbox, citing event IDs |

### How an agent call is constrained

1. **Bounded input.** `buildCaseContext` (`src/agents/context.ts`) assembles a
   capped, structured snapshot of database facts. Customer free text is passed
   **only as a delimited data field**, never as instructions.
2. **Forced structured output.** The Zod schema is converted to JSON Schema and
   the model must answer in that shape.
3. **Zod validation** of whatever comes back.
4. **Extra deterministic validation** where it applies — for the Communication
   agent, the fills are checked against *exactly* the rules the template renderer
   enforces (unknown slot, `maxLength`, and the numeral/URL/currency lint).
5. **One retry.** If validation fails twice → the case is **escalated to a human**.
   No third attempt, no partial acceptance.

Every invocation is persisted as an `agent_decisions` row: agent, model,
prompt-version hash, input snapshot, output, confidence, latency, token counts.
No chain-of-thought is stored.

---

## 4. What an agent is allowed to propose

**`packages/shared/src/actions.ts`** — the closed catalog:

```
schedule_mandate_reexecution · create_payment_link · send_email
schedule_reminder · record_promise_to_pay · escalate_to_human
stop_workflow · mark_wait
```

Note what is **absent by design**: no refund, no discount, no waiver, no payment
plan. Those actions do not exist anywhere in the system, so no amount of clever
prompting can produce one.

**No action carries a monetary amount.** `create_payment_link` has no amount
field at all — the server resolves it from the invoice at execution time.

`templateId` is a closed enum for the same reason: it was once a free string,
and the model invented plausible-sounding templates that passed validation and
then failed at execution.

---

## 5. The policy engine — the gate everything passes through

**`src/policy/engine.ts`** · `evaluatePolicyRequest(req, config, version)`

A **pure function** of (request, config). Same inputs, same verdict, always.

### The request

`src/policy/service.ts` builds a `PolicyRequest` entirely from **database state** —
never from agent output, except the proposed action itself and its confidence:
amount due, rail, decline class, opt-out status, open dispute, channel consent,
customer timezone, attempt counts, contact history.

### The rules, in fixed order — first DENY wins

| # | Category | Rule | What it stops |
|---|---|---|---|
| 0 | structural | `holdout_lock` | any action on a holdout case |
| 1 | hard compliance | `opt_out` | contacting someone who opted out |
| | | `open_dispute` | any collection while a dispute is open |
| | | `quiet_hours` | contact outside allowed hours **in the customer's timezone** |
| | | `channel_consent` | emailing without consent |
| 2 | rail limits | `decline_class_retry` | retrying a hard decline (never retryable) |
| | | `mandate_rail_only` | mandate re-execution on a rail that has none |
| | | `global_attempt_cap` | more than 4 attempts per invoice |
| | | `attempt_spacing` | retrying within 24h of the last attempt |
| | | `upi_pre_debit_notice` | **debiting before the mandatory ≥24h notice** |
| | | `afa_threshold` | auto-debit above ₹15,000 without AFA |
| 3 | contact budget | `contact_budget` | more than 3 emails per rolling 14 days |
| 4 | financial limits | `autonomous_amount_cap` | acting alone above the cap → **approval** |
| 5 | confidence gate | `confidence_gate` | low confidence + high exposure → **approval** |
| 6 | loop guards | `loop_guard_invocations` | runaway agent loops |
| | | `loop_guard_age` | a case with no progress |

`escalate_to_human` and `stop_workflow` are **always allowed** — the system can
always stop or ask for help.

### The verdict

```
DENY             → the intervention is marked denied; the case re-plans
REQUIRE_APPROVAL → case → pending_approval; it appears in the human inbox
ALLOW            → case → executing; the tool runs
```

Every decision is persisted as a `policy_decisions` row with the **full rule
trace** — every rule, its outcome, and why. That trace is what the Case View
shows an operator, so a verdict is never a black box.

**India-specific rules are policy data, not code.** The UPI pre-debit notice and
the ₹15,000 AFA threshold live in versioned JSON in Postgres and are editable in
Policy Studio, with diff history.

---

## 6. Human-in-the-loop

Three different things need a person, and they are scoped differently. All three
land in one inbox (`GET /approvals`, `src/api/humanQueue.ts`), ranked by exposure:

| Kind | Scope | What the human does |
|---|---|---|
| **approval** | one intervention | approve or deny that specific action |
| **escalation** | the whole case | the pipeline gave up — decide what to do, hand it back, or stop |
| **dispute** | the whole case | a compliance freeze only a human can lift (**admin only**) |

An operator proposing an action goes through `POST /intervene`, which walks the
case back to `planned` so **the same policy gate runs**. A human can choose the
action; a human cannot bypass policy.

Resolving a dispute (`POST /resolve-dispute`) is the most sensitive control in
the system — "rejected" resumes collection against someone who formally
contested a charge. It is admin-only, requires a written reason, is fully
audited, and is unreachable by any agent.

---

## 7. Execution — the only code allowed to touch the outside world

**`src/tools/execute.ts`**

Tools are the *only* place Razorpay or the mailer is called. Each one:

1. **Authorises against case state** — the case must be in an executable state.
2. **Claims an idempotency key**: `caseId:interventionId:attempt`, with a
   **unique constraint**. This is the hard guarantee against double-charging:
   a duplicate BullMQ job cannot create a second payment link or fire a second
   mandate debit, no matter how it was scheduled.
3. **Resolves the amount server-side** from the invoice. Never from the agent.
4. **Renders the message**, if any: immutable slots (amount, dates, links, legal
   text) are server-injected; free slots are re-linted at render time.
5. **Calls the provider** with retry and backoff.
6. **Writes an `audit_events` row.**

A second, independent guarantee lives in the database: a partial unique index
allows **at most one open intervention per case**. This exists because a
duplicate dispatch once produced two proposals and sent a customer the same
email twice — and relying on every dispatch site to remember to check is exactly
what failed.

If a tool fails permanently after its retries, `abandonIntervention` marks the
intervention failed and **escalates the case to a human** rather than leaving it
parked in `executing` forever.

### Safety invariant enforced at execution

Before any mandate debit, the tool re-checks that the ≥24h pre-debit notice was
actually sent. If not, it refuses and escalates — even if policy said ALLOW.
Belt and braces on the one action that moves money without further consent.

---

## 8. After execution — waiting, replies, outcomes

The case moves to `waiting` with a deadline.

**A customer reply** (`POST /webhooks/inbound-email`) is stored as data and
emitted as `customer.responded`. The Reply Interpreter classifies it:

| Intent | What happens |
|---|---|
| `opt_out` | customer suppressed **globally**; case stopped |
| `dispute` | case frozen; `disputed_at` stamped durably |
| `promise_with_date` | a promise-to-pay is recorded and tracked |
| `paid_claim` / `will_pay` | case re-evaluates |
| `hostile` / `question` | escalated to a human |

If the message also looks like a **prompt-injection attempt**, it is flagged and
the case escalates for review — but **suppression is still honoured**. An
opt-out or a dispute is applied even when the same message tried to steer the
system, because those only ever make us contact the customer *less*. Refusing to
honour an opt-out because the message was also hostile would be a compliance
failure, not a safety win.

**Background sweeps** (`src/orchestrator/sweep.ts`, hourly) handle everything
nothing else is watching:

- waiting cases past their deadline → re-evaluate
- open promises past their date with the invoice unpaid → `customer.broke_promise`
- cases past their attribution window → `lost`
- **any case that has stopped moving → escalated to a human.** This is the
  catch-all: a stalled case is otherwise indistinguishable from a healthy one
  patiently waiting, so nobody notices until the money is gone.

---

## 9. Money in — ledger and attribution

When `payment.recovered` arrives, **one transaction** records the payment, updates
the invoice, writes an append-only `recovery_ledger` entry, and closes the case.

`src/attribution/attribution.ts` classifies each recovery:

| Class | Meaning | Credited? |
|---|---|---|
| `direct` | paid through a link we sent | yes |
| `assisted` | paid within the window after our outreach | yes |
| `external` | paid by a route we had nothing to do with | **never** |

Windows: 30 days for payment failures, 90 for receivables.

Append-only tables take corrections as **reversing entries, never UPDATEs**.

---

## 10. Proving it worked

**`src/attribution/stats.ts`** — pure arithmetic, no ML anywhere in the system.

```
incremental = treatment recovery rate − holdout recovery rate
```

with a two-proportion confidence interval. The Experiments screen states it
plainly: *gross recovered X, the holdout says Y would have arrived anyway,
so incremental = X − Y*, with a 95% CI.

This is why the holdout is protected so carefully. If holdout cases were ever
worked — or if the arm assignment could be overridden — this number would be
meaningless, and it is the only honest answer to "is this system worth running?"

> With a small demo population the arm split drifts badly off 90/10 and this
> figure is statistically meaningless. That is sample size, not a defect.

---

## Where things live

```
apps/api/src/
  ingest/        webhook verification, dedupe, outbox, normalizer, overdue scan
  orchestrator/  FSM, case service, holdout assignment, sweeps
  agents/        runner, prompts, bounded context builder
  policy/        the engine (pure), request builder, versioned rules
  tools/         the only code that calls Razorpay or the mailer
  attribution/   ledger classification, two-proportion CI
  api/           REST routes, human inbox
apps/web/src/routes/
  index          Command Center      cases      Risk Queue
  cases.$caseId  Case View           approvals  Human Inbox
  policies       Policy Studio       experiments  Incremental recovery
packages/shared/ Zod contracts: enums, event + action catalogs, policy types, lint
```

## The invariants, in one place

1. No agent output reaches a customer or a payment API without passing schema
   validation, the policy engine, and the free-slot lint.
2. No action carries a monetary amount; amounts are always server-resolved.
3. The action catalog is closed — refunds, discounts and waivers do not exist.
4. Webhook delivery is deduped; execution is idempotent per
   `caseId:interventionId:attempt`.
5. A mandate debit cannot precede its mandatory pre-debit notice.
6. An opt-out or open dispute stops all outreach, durably, across every state.
7. Holdout cases never execute anything.
8. A case that stops moving always ends up in front of a human.
