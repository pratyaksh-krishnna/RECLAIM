# RECLAIM

**R**evenue **E**vent **C**apture, **L**earning, and **I**ntervention **M**anager — a bounded multi-agent AI revenue recovery system. It detects revenue at risk (failed subscription payments, overdue B2B invoices), diagnoses the cause, selects an intervention, executes it within strict policy limits, and proves incremental recovery against a built-in randomized 10% holdout.

**Central principle: AI agents reason about recovery; deterministic code controls money.** No agent ever computes, emits, or modifies a monetary amount that reaches a customer or a payment API. There is **no ML anywhere** — deterministic rule tables plus LLM calls with forced structured outputs.

All agent reasoning is a **real Anthropic API call** (`claude-haiku-4-5`). There is no stub, mock, or heuristic fallback in `src/` — `ANTHROPIC_API_KEY` is required to boot. Payments remain mocked by default (`PAYMENTS_MODE=sandbox`).

See [FLOW.md](./FLOW.md) for how a case moves through the system end to end, and [PLAN.md](./PLAN.md) for the architecture recap.

## Getting started

### Prerequisites

| Requirement | Notes |
|---|---|
| **Node 22+** | `node -v` — pnpm ships with it via corepack |
| **Docker** | runs Postgres 16 and Redis; nothing else is needed locally |
| **An Anthropic API key** | **required** — agents are always real `claude-haiku-4-5` calls and the API refuses to boot without one. Get one at [console.anthropic.com](https://console.anthropic.com/settings/keys) |

No Razorpay account is needed. Payments are mocked by the sandbox provider by default.

### 1. Install

```bash
git clone https://github.com/pratyaksh-krishnna/RECLAIM.git
cd RECLAIM
corepack enable pnpm      # pnpm ships with Node 22
pnpm install
```

### 2. Configure

```bash
cp .env.example .env
```

Open `.env` and set the one required value:

```ini
ANTHROPIC_API_KEY=sk-ant-...   # required — the API will not boot without it
```

Everything else works as shipped. `.env` is gitignored; never commit a real key.

### 3. Start the infrastructure

```bash
docker compose up -d      # Postgres 16 on :5433, Redis on :6380
pnpm db:migrate           # create/refresh the schema
```

> Re-run `pnpm db:migrate` after every `git pull` — a missing migration shows up as a
> `column ... does not exist` error at runtime.

### 4. Run the app

Two processes, in two terminals:

```bash
pnpm --filter @reclaim/api dev   # API + BullMQ workers  → http://localhost:3001
pnpm --filter @reclaim/web dev   # frontend              → http://localhost:5173
```

Or start both at once from the repo root:

```bash
pnpm dev
```

### 5. Sign in

Open **http://localhost:5173**. Demo users are seeded automatically when `NODE_ENV != production`:

| Email | Role | Can do |
|---|---|---|
| `admin@reclaim.test` | admin | everything, including editing policy rules |
| `operator@reclaim.test` | operator | approve/deny, intervene, stop cases |
| `viewer@reclaim.test` | viewer | read-only |

Password for all three: `reclaim-demo`

### 6. Load demo data

With the API running:

```bash
pnpm seed     # generates India-realistic at-risk cases (reproducible RNG)
pnpm replay   # feeds Razorpay-shaped webhooks through the live HMAC-verified path
```

**Start small.** `pnpm seed` defaults to 1,000 cases, and every case is diagnosed by a real
agent — roughly 3,000 Haiku calls (~$8). Use `SEED_COUNT` for a cheap run:

```bash
SEED_COUNT=15 pnpm seed && pnpm replay   # ~80 Haiku calls, well under $1
```

The replay shows cases opened and ranked by exposure, causes diagnosed, payment links and UPI
pre-debit notices executed against the sandbox provider and mock mailer, a dispute hard-stopping
all outreach, an opt-out suppressed globally, a prompt-injection reply flagged classification-only,
the 10% holdout visibly untouched, and the Experiments screen concluding *gross recovered X,
holdout says Y would have arrived anyway, incremental = X − Y* with a 95% CI.

### Where to look first

| Screen | What it shows |
|---|---|
| **Command Center** `/` | open revenue at risk, recovery vs. holdout, what needs a human |
| **Risk Queue** `/cases` | every case ranked by exposure; holdout cases badged and action-locked |
| **Case View** `/cases/:id` | diagnosis with cited evidence, full policy rule trace, message preview with locked slots |
| **Human Inbox** `/approvals` | the three things that need a person: actions awaiting approval, escalated cases where the pipeline stopped, and disputes whose freeze only an admin can lift |
| **Policy Studio** `/policies` | versioned money-control rules with diff history |
| **Experiments** `/experiments` | incremental recovery vs. the randomized holdout, with a 95% CI |

### Troubleshooting

| Symptom | Fix |
|---|---|
| API exits immediately on boot | `ANTHROPIC_API_KEY` is unset in `.env` — it is required |
| `column "..." does not exist` | run `pnpm db:migrate` |
| `ECONNREFUSED :5433` or `:6380` | `docker compose up -d`, then `docker ps` to confirm both are healthy |
| Port already in use | change `API_PORT` in `.env`; the web dev server picks the next free port itself |
| Replay reports zero cases | let `pnpm seed` finish first — it must complete before `pnpm replay` |

## Verification

```bash
pnpm test        # 121 tests: policy engine, FSM, idempotency, ingestion, human inbox, dispute resolution, stall alarm, e2e pipeline, safety suite
pnpm typecheck
pnpm lint
```

Tests inject a `FakeLlmClient` at the `LlmClient` seam (`test/helpers/fakeLlm.ts`) so the suite is deterministic and free to run; everything downstream of that seam — Zod contracts, lint, policy engine, tools, FSM — is exercised for real. No fake exists in `src/`.

The safety suite (`apps/api/test/safety/`) covers each non-negotiable: schema+policy+lint gating of every LLM output, webhook dedupe, `caseId:interventionId:attempt` execution idempotency, pre-debit-notice-before-mandate-debit, dispute/opt-out hard stops, prompt-injection red-team cases, and contact/retry ceilings that hold against agent proposals.

## Layout

```
apps/api          Express + BullMQ workers + Drizzle (single deployable)
apps/web          React + Vite + TanStack Router/Query/Table + Tailwind + Recharts
packages/shared   Zod contracts: enums, event catalog, action catalog, policy types, free-slot lint
```
