# RECLAIM

**R**evenue **E**vent **C**apture, **L**earning, and **I**ntervention **M**anager — a bounded multi-agent AI revenue recovery system. It detects revenue at risk (failed subscription payments, overdue B2B invoices), diagnoses the cause, selects an intervention, executes it within strict policy limits, and proves incremental recovery against a built-in randomized 10% holdout.

**Central principle: AI agents reason about recovery; deterministic code controls money.** No agent ever computes, emits, or modifies a monetary amount that reaches a customer or a payment API. There is **no ML anywhere** — deterministic rule tables plus LLM calls with forced structured outputs.

All agent reasoning is a **real Anthropic API call** (`claude-haiku-4-5`). There is no stub, mock, or heuristic fallback in `src/` — `ANTHROPIC_API_KEY` is required to boot. Payments remain mocked by default (`PAYMENTS_MODE=sandbox`).

See [PLAN.md](./PLAN.md) for the architecture recap.

## Quick start

```bash
corepack enable pnpm            # pnpm ships with Node 22
pnpm install
cp .env.example .env            # then set ANTHROPIC_API_KEY (required); payments stay mocked
docker compose up -d            # Postgres 16 on :5433, Redis on :6380
pnpm db:migrate
```

Run the system:

```bash
pnpm --filter @reclaim/api dev  # API + BullMQ workers on :3001
pnpm --filter @reclaim/web dev  # frontend on :5173
```

Sign in at http://localhost:5173 — demo users (`NODE_ENV != production` only):
`admin@reclaim.test` / `operator@reclaim.test` / `viewer@reclaim.test`, password `reclaim-demo`.

## Demo

With the API running:

```bash
pnpm seed     # 1,000 India-realistic at-risk cases + replay script (reproducible RNG)
pnpm replay   # feeds Razorpay-shaped webhooks through the live HMAC-verified path
```

The replay shows: cases opened and ranked by exposure, causes diagnosed, payment links and UPI pre-debit notices executed against the sandbox provider and mock mailer, a dispute hard-stopping all outreach, an opt-out suppressed globally, a prompt-injection reply flagged classification-only, the 10% holdout visibly untouched, and the Experiments screen concluding *gross recovered X, holdout says Y would have arrived anyway, incremental = X − Y* with a 95% CI.

`ANTHROPIC_API_KEY` is required (agents are always real model calls). Payments are mocked unless you set `PAYMENTS_MODE=live-test` with Razorpay test keys.

**Cost note:** every case is diagnosed by a real agent, so a full 1,000-case replay makes roughly 3,000 Haiku calls (~$8). Seed a smaller population for cheaper runs.

## Verification

```bash
pnpm test        # 87 tests: policy engine, FSM, idempotency, ingestion, e2e pipeline, safety suite
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
