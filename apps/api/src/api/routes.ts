import { Router, json, type Request, type Response } from 'express';
import { and, asc, desc, eq, inArray, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { ActionParams, CaseState, PolicyConfig, TERMINAL_STATES } from '@reclaim/shared';
import type { Db } from '../db/client.js';
import {
  agentDecisions,
  auditEvents,
  communications,
  customers,
  interventions,
  invoices,
  policyDecisions,
  policyRules,
  promisesToPay,
  recoveryCases,
  recoveryLedger,
  users,
} from '../db/schema.js';
import { writeAudit } from '../audit/audit.js';
import { interventionStats, recoveryReport, revenueRiskSummary } from '../analytics/queries.js';
import { requireRole, signSession, verifyPassword, type AuthedRequest } from '../auth/auth.js';
import { asyncRoute } from '../ingest/webhookRouter.js';
import { humanQueue } from './humanQueue.js';
import { lockCase, transitionCase } from '../orchestrator/caseService.js';
import { isTerminal } from '../orchestrator/fsm.js';
import type { OrchestratorDeps } from '../orchestrator/orchestrator.js';

export interface ApiDeps {
  db: Db;
  orchestrator: Pick<OrchestratorDeps, 'enqueueAgent' | 'enqueueCaseStep' | 'enqueueTool'>;
}

export function makeApiRouter(deps: ApiDeps): Router {
  const router = Router();
  const { db } = deps;
  router.use(json());

  // ---- auth ----
  const LoginBody = z.object({ email: z.string().email(), password: z.string().min(1) });
  router.post(
    '/auth/login',
    asyncRoute(async (req, res) => {
      const parsed = LoginBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid credentials payload' });
        return;
      }
      const [user] = await db.select().from(users).where(eq(users.email, parsed.data.email)).limit(1);
      if (!user || !verifyPassword(parsed.data.password, user.passwordHash)) {
        res.status(401).json({ error: 'invalid credentials' });
        return;
      }
      res.json({
        token: signSession({ sub: user.id, email: user.email, role: user.role }),
        user: { id: user.id, email: user.email, name: user.name, role: user.role },
      });
    }),
  );

  // ---- cases ----
  const CasesQuery = z.object({
    state: CaseState.optional(),
    arm: z.enum(['treatment', 'holdout']).optional(),
    open: z.enum(['true', 'false']).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  });
  router.get(
    '/recovery/cases',
    requireRole('viewer'),
    asyncRoute(async (req, res) => {
      const q = CasesQuery.safeParse(req.query);
      if (!q.success) {
        res.status(400).json({ error: q.error.flatten() });
        return;
      }
      const conditions = [];
      if (q.data.state) conditions.push(eq(recoveryCases.state, q.data.state));
      if (q.data.arm) conditions.push(eq(recoveryCases.holdoutArm, q.data.arm));
      if (q.data.open === 'true') conditions.push(notInArray(recoveryCases.state, [...TERMINAL_STATES]));

      const rows = await db
        .select({
          caseRow: recoveryCases,
          customerName: customers.name,
          customerEmail: customers.email,
        })
        .from(recoveryCases)
        .innerJoin(customers, eq(customers.id, recoveryCases.customerId))
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(recoveryCases.exposurePaise))
        .limit(q.data.limit);

      const caseIds = rows.map((r) => r.caseRow.id);
      const nextActions = caseIds.length
        ? await db
            .select()
            .from(interventions)
            .where(and(inArray(interventions.caseId, caseIds), inArray(interventions.status, ['proposed', 'pending_approval', 'approved', 'executing'])))
        : [];

      res.json(
        rows.map((r) => ({
          ...r.caseRow,
          customerName: r.customerName,
          customerEmail: r.customerEmail,
          nextAction: nextActions.find((i) => i.caseId === r.caseRow.id)?.actionType ?? null,
        })),
      );
    }),
  );

  router.get(
    '/recovery/cases/:id',
    requireRole('viewer'),
    asyncRoute(async (req, res) => {
      const id = z.string().uuid().safeParse(req.params.id);
      if (!id.success) {
        res.status(400).json({ error: 'invalid id' });
        return;
      }
      const [caseRow] = await db.select().from(recoveryCases).where(eq(recoveryCases.id, id.data)).limit(1);
      if (!caseRow) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const [customer] = await db.select().from(customers).where(eq(customers.id, caseRow.customerId)).limit(1);
      const [invoice] = await db.select().from(invoices).where(eq(invoices.id, caseRow.invoiceId)).limit(1);
      const [decisions, policies, comms, actions, promises, ledger, audit] = await Promise.all([
        db.select().from(agentDecisions).where(eq(agentDecisions.caseId, id.data)).orderBy(asc(agentDecisions.createdAt)),
        db.select().from(policyDecisions).where(eq(policyDecisions.caseId, id.data)).orderBy(asc(policyDecisions.createdAt)),
        db.select().from(communications).where(eq(communications.caseId, id.data)).orderBy(asc(communications.createdAt)),
        db.select().from(interventions).where(eq(interventions.caseId, id.data)).orderBy(asc(interventions.createdAt)),
        db.select().from(promisesToPay).where(eq(promisesToPay.caseId, id.data)),
        db.select().from(recoveryLedger).where(eq(recoveryLedger.caseId, id.data)),
        db.select().from(auditEvents).where(eq(auditEvents.caseId, id.data)).orderBy(asc(auditEvents.createdAt)).limit(500),
      ]);
      res.json({
        case: caseRow,
        customer: customer
          ? { id: customer.id, name: customer.name, email: customer.email, optedOut: customer.optedOut, timezone: customer.timezone }
          : null,
        invoice,
        agentDecisions: decisions,
        policyDecisions: policies,
        communications: comms,
        interventions: actions,
        promises,
        ledger,
        audit,
      });
    }),
  );

  // ---- human actions (same catalog, same policy gate) ----
  const ApproveBody = z.object({ interventionId: z.string().uuid(), decision: z.enum(['approve', 'deny']) });
  router.post(
    '/recovery/cases/:id/approve',
    requireRole('operator'),
    asyncRoute(async (req, res) => {
      const id = z.string().uuid().safeParse(req.params.id);
      const body = ApproveBody.safeParse(req.body);
      if (!id.success || !body.success) {
        res.status(400).json({ error: 'invalid payload' });
        return;
      }
      const actorId = (req as AuthedRequest).session?.sub ?? null;
      const outcome = await db.transaction(async (tx) => {
        const caseRow = await lockCase(tx, id.data);
        if (!caseRow) return { status: 404 as const, error: 'case not found' };
        const [proposal] = await tx
          .select()
          .from(interventions)
          .where(and(eq(interventions.id, body.data.interventionId), eq(interventions.caseId, id.data)))
          .limit(1);
        if (!proposal || proposal.status !== 'pending_approval') {
          return { status: 409 as const, error: 'intervention is not awaiting approval' };
        }
        if (body.data.decision === 'approve') {
          await tx.update(interventions).set({ status: 'approved' }).where(eq(interventions.id, proposal.id));
          if (caseRow.state === 'pending_approval') {
            await transitionCase(tx, caseRow, 'executing', { actorType: 'human', actorId, reason: 'approved' });
          }
          await writeAudit(tx, { caseId: id.data, actorType: 'human', actorId, eventType: 'approval.granted', payload: { interventionId: proposal.id } });
          return { status: 200 as const, next: 'execute' as const, interventionId: proposal.id };
        }
        await tx.update(interventions).set({ status: 'denied' }).where(eq(interventions.id, proposal.id));
        if (caseRow.state === 'pending_approval') {
          await transitionCase(tx, caseRow, 're_evaluating', { actorType: 'human', actorId, reason: 'approval denied' });
        }
        await writeAudit(tx, { caseId: id.data, actorType: 'human', actorId, eventType: 'approval.denied', payload: { interventionId: proposal.id } });
        return { status: 200 as const, next: 'replan' as const };
      });
      if (outcome.status !== 200) {
        res.status(outcome.status).json(outcome);
        return;
      }
      if (outcome.next === 'execute' && outcome.interventionId) {
        await deps.orchestrator.enqueueTool({ caseId: id.data, interventionId: outcome.interventionId, attempt: 1 });
      } else if (outcome.next === 'replan') {
        await deps.orchestrator.enqueueCaseStep(id.data, 'approval_denied');
      }
      res.json({ ok: true, next: outcome.next });
    }),
  );

  const InterveneBody = z.object({ action: ActionParams });
  router.post(
    '/recovery/cases/:id/intervene',
    requireRole('operator'),
    asyncRoute(async (req, res) => {
      const id = z.string().uuid().safeParse(req.params.id);
      const body = InterveneBody.safeParse(req.body);
      if (!id.success || !body.success) {
        res.status(400).json({ error: 'invalid payload — action must come from the catalog' });
        return;
      }
      const actorId = (req as AuthedRequest).session?.sub ?? null;
      const outcome = await db.transaction(async (tx) => {
        const caseRow = await lockCase(tx, id.data);
        if (!caseRow) return { status: 404 as const, error: 'case not found' };
        if (isTerminal(caseRow.state)) return { status: 409 as const, error: `case is ${caseRow.state}` };
        const [created] = await tx
          .insert(interventions)
          .values({
            caseId: id.data,
            actionType: body.data.action.type,
            params: body.data.action,
            proposedBy: 'human',
            proposedByUserId: actorId,
            status: 'proposed',
            rationale: 'human-initiated intervention',
            stopConditions: [],
          })
          .returning({ id: interventions.id });
        await writeAudit(tx, { caseId: id.data, actorType: 'human', actorId, eventType: 'action.proposed', payload: { action: body.data.action, interventionId: created?.id } });
        // walk to planned so the SAME policy gate runs
        if (caseRow.state === 'waiting' || caseRow.state === 'escalated' || caseRow.state === 'disputed') {
          await transitionCase(tx, caseRow, 're_evaluating', { actorType: 'human', actorId, reason: 'human intervention' });
        }
        if (caseRow.state === 'diagnosed' || caseRow.state === 're_evaluating') {
          await transitionCase(tx, caseRow, 'planned', { actorType: 'human', actorId, reason: 'human proposal ready' });
          return { status: 200 as const, gate: true };
        }
        if (caseRow.state === 'detected') {
          // no diagnosis yet — legal path detected→diagnosed is agent work; route via policy on next step
          await transitionCase(tx, caseRow, 'diagnosed', { actorType: 'human', actorId, reason: 'human override: proceeding without agent diagnosis' });
          await transitionCase(tx, caseRow, 'planned', { actorType: 'human', actorId, reason: 'human proposal ready' });
          return { status: 200 as const, gate: true };
        }
        return { status: 200 as const, gate: caseRow.state === 'planned' };
      });
      if (outcome.status !== 200) {
        res.status(outcome.status).json(outcome);
        return;
      }
      await deps.orchestrator.enqueueCaseStep(id.data, 'human_proposal');
      res.json({ ok: true });
    }),
  );

  const StopBody = z.object({ reason: z.enum(['opt_out', 'dispute', 'paid_external', 'attempts_exhausted', 'human_request', 'loop_guard']).default('human_request') });
  router.post(
    '/recovery/cases/:id/stop',
    requireRole('operator'),
    asyncRoute(async (req, res) => {
      const id = z.string().uuid().safeParse(req.params.id);
      const body = StopBody.safeParse(req.body ?? {});
      if (!id.success || !body.success) {
        res.status(400).json({ error: 'invalid payload' });
        return;
      }
      const actorId = (req as AuthedRequest).session?.sub ?? null;
      const outcome = await db.transaction(async (tx) => {
        const caseRow = await lockCase(tx, id.data);
        if (!caseRow) return { status: 404 as const };
        if (isTerminal(caseRow.state)) return { status: 409 as const };
        await transitionCase(tx, caseRow, 'stopped', {
          actorType: 'human',
          actorId,
          reason: body.data.reason,
          extra: { stopReason: body.data.reason },
        });
        return { status: 200 as const };
      });
      res.status(outcome.status).json({ ok: outcome.status === 200 });
    }),
  );

  router.post(
    '/recovery/cases/:id/analyze',
    requireRole('operator'),
    asyncRoute(async (req, res) => {
      const id = z.string().uuid().safeParse(req.params.id);
      if (!id.success) {
        res.status(400).json({ error: 'invalid id' });
        return;
      }
      const [caseRow] = await db.select().from(recoveryCases).where(eq(recoveryCases.id, id.data)).limit(1);
      if (!caseRow) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      if (isTerminal(caseRow.state) || caseRow.holdoutArm === 'holdout') {
        res.status(409).json({ error: 'case cannot be re-analyzed' });
        return;
      }
      await deps.orchestrator.enqueueAgent({ caseId: id.data, agent: caseRow.causeHypothesis ? 'diagnosis' : 'triage' });
      res.json({ ok: true });
    }),
  );

  // ---- human inbox: actions awaiting a yes/no AND cases handed to a human ----
  router.get(
    '/approvals',
    requireRole('viewer'),
    asyncRoute(async (_req: Request, res: Response) => {
      res.json(await humanQueue(db));
    }),
  );

  // ---- analytics ----
  router.get('/analytics/revenue-risk', requireRole('viewer'), asyncRoute(async (_req, res) => {
    res.json(await revenueRiskSummary(db));
  }));
  router.get('/analytics/recovery', requireRole('viewer'), asyncRoute(async (_req, res) => {
    res.json(await recoveryReport(db));
  }));
  router.get('/analytics/interventions', requireRole('viewer'), asyncRoute(async (_req, res) => {
    res.json(await interventionStats(db));
  }));

  // ---- policies ----
  router.get('/policies', requireRole('viewer'), asyncRoute(async (_req, res) => {
    const rows = await db.select().from(policyRules).orderBy(desc(policyRules.version));
    res.json(rows);
  }));
  const PolicyBody = z.object({ config: PolicyConfig, comment: z.string().max(500).optional() });
  router.post(
    '/policies',
    requireRole('admin'),
    asyncRoute(async (req, res) => {
      const body = PolicyBody.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: body.error.flatten() });
        return;
      }
      const actorId = (req as AuthedRequest).session?.sub ?? null;
      const created = await db.transaction(async (tx) => {
        const [latest] = await tx.select().from(policyRules).orderBy(desc(policyRules.version)).limit(1);
        const version = (latest?.version ?? 0) + 1;
        await tx.update(policyRules).set({ active: false }).where(eq(policyRules.active, true));
        const [row] = await tx
          .insert(policyRules)
          .values({ version, config: body.data.config, comment: body.data.comment ?? null, createdByUserId: actorId, active: true })
          .returning();
        await writeAudit(tx, { actorType: 'human', actorId, eventType: 'policy.updated', payload: { version } });
        return row;
      });
      res.json(created);
    }),
  );

  // ---- audit ----
  router.get(
    '/audit/cases/:id',
    requireRole('viewer'),
    asyncRoute(async (req, res) => {
      const id = z.string().uuid().safeParse(req.params.id);
      if (!id.success) {
        res.status(400).json({ error: 'invalid id' });
        return;
      }
      const rows = await db.select().from(auditEvents).where(eq(auditEvents.caseId, id.data)).orderBy(asc(auditEvents.createdAt)).limit(1000);
      res.json(rows);
    }),
  );

  return router;
}
