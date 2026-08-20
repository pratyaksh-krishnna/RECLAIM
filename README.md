# RECLAIM

**R**evenue **E**vent **C**apture, **L**earning, and **I**ntervention **M**anager — a bounded multi-agent AI revenue recovery system. It detects revenue at risk (failed subscription payments, overdue B2B invoices), diagnoses the cause, selects an intervention, executes it within strict policy limits, and proves incremental recovery against a built-in randomized 10% holdout.

**Central principle: AI agents reason about recovery; deterministic code controls money.** No agent ever computes, emits, or modifies a monetary amount that reaches a customer or a payment API. There is **no ML anywhere** — deterministic rule tables plus LLM calls with forced structured outputs.

See [PLAN.md](./PLAN.md) for the architecture recap.

## Quick start

```bash
corepack enable pnpm            # pnpm ships with Node 22
pnpm install
cp .env.example .env            # defaults run fully offline (stub LLM, sandbox payments)
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

Real keys are optional: set `LLM_MODE=live` + `ANTHROPIC_API_KEY` for live agents, `PAYMENTS_MODE=live-test` + Razorpay test keys for real test-mode Payment Links.

## Verification

```bash
pnpm test        # 87 tests: policy engine, FSM, idempotency, ingestion, e2e pipeline, safety suite
pnpm typecheck
pnpm lint
```

The safety suite (`apps/api/test/safety/`) covers each non-negotiable: schema+policy+lint gating of every LLM output, webhook dedupe, `caseId:interventionId:attempt` execution idempotency, pre-debit-notice-before-mandate-debit, dispute/opt-out hard stops, prompt-injection red-team cases, and contact/retry ceilings that hold against agent proposals.

## Layout

```
apps/api          Express + BullMQ workers + Drizzle (single deployable)
apps/web          React + Vite + TanStack Router/Query/Table + Tailwind + Recharts
packages/shared   Zod contracts: enums, event catalog, action catalog, policy types, free-slot lint
```
