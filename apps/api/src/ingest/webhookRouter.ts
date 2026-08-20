import { createHash, randomUUID } from 'node:crypto';
import { Router, raw, json, type NextFunction, type Request, type Response } from 'express';
import { and, desc, eq, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { CanonicalEvent, TERMINAL_STATES } from '@reclaim/shared';
import type { Db } from '../db/client.js';
import { communications, customers, outbox, recoveryCases, webhookInbox } from '../db/schema.js';
import { writeAudit } from '../audit/audit.js';
import { verifyRazorpaySignature } from './verifySignature.js';

/** Express 4 does not catch async rejections; every async route goes through this. */
export function asyncRoute(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export interface WebhookDeps {
  db: Db;
  webhookSecret: string;
  /** enqueue a normalize job after insert; the backstop repeatable covers failures */
  enqueueNormalize: (inboxId: string) => Promise<void>;
}

/**
 * POST /webhooks/razorpay — raw-body HMAC verification BEFORE JSON.parse.
 * Duplicate provider event ids are absorbed by the unique constraint.
 */
export function makeWebhookRouter(deps: WebhookDeps): Router {
  const router = Router();

  router.post('/webhooks/razorpay', raw({ type: '*/*' }), asyncRoute(async (req: Request, res: Response) => {
    const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    const signature = req.header('x-razorpay-signature') ?? '';
    if (!verifyRazorpaySignature(rawBody, signature, deps.webhookSecret)) {
      res.status(401).json({ error: 'invalid signature' });
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      res.status(400).json({ error: 'invalid json' });
      return;
    }
    const eventType =
      typeof (payload as { event?: unknown }).event === 'string'
        ? (payload as { event: string }).event
        : 'unknown';
    // Razorpay sends x-razorpay-event-id; fall back to a payload hash for dedupe
    const providerEventId =
      req.header('x-razorpay-event-id') ?? createHash('sha256').update(rawBody).digest('hex');

    const inserted = await deps.db
      .insert(webhookInbox)
      .values({ provider: 'razorpay', providerEventId, eventType, payload: payload as object })
      .onConflictDoNothing()
      .returning({ id: webhookInbox.id });

    const first = inserted[0];
    if (first) {
      await deps.enqueueNormalize(first.id).catch(() => {
        /* backstop repeatable job re-enqueues unprocessed inbox rows */
      });
    }
    res.status(200).json({ status: 'accepted', duplicate: !first });
  }));

  return router;
}

const InboundEmailBody = z.object({
  customerEmail: z.string().email(),
  body: z.string().min(1).max(20_000),
  inReplyToCommunicationId: z.string().uuid().nullish(),
});

/**
 * POST /webhooks/inbound-email — mock inbound mail hook (sandbox stand-in for
 * a mail provider's inbound parse). Stores raw text strictly as data and emits
 * customer.responded; the text is never interpreted here.
 */
export function makeInboundEmailRouter(deps: { db: Db }): Router {
  const router = Router();

  router.post('/webhooks/inbound-email', json(), asyncRoute(async (req: Request, res: Response) => {
    const parsed = InboundEmailBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const { customerEmail, body } = parsed.data;

    const outcome = await deps.db.transaction(async (tx) => {
      const [customer] = await tx
        .select()
        .from(customers)
        .where(eq(customers.email, customerEmail))
        .limit(1);
      if (!customer) return { status: 404 as const, error: 'unknown customer' };

      const [openCase] = await tx
        .select()
        .from(recoveryCases)
        .where(
          and(
            eq(recoveryCases.customerId, customer.id),
            notInArray(recoveryCases.state, [...TERMINAL_STATES]),
          ),
        )
        .orderBy(desc(recoveryCases.openedAt))
        .limit(1);
      if (!openCase) return { status: 404 as const, error: 'no open case for customer' };

      const [comm] = await tx
        .insert(communications)
        .values({
          caseId: openCase.id,
          customerId: customer.id,
          direction: 'inbound',
          channel: 'email',
          renderedBody: body,
          sentAt: new Date(),
        })
        .returning({ id: communications.id });
      if (!comm) return { status: 500 as const, error: 'insert failed' };

      const event = CanonicalEvent.parse({
        eventId: randomUUID(),
        occurredAt: new Date().toISOString(),
        sourceEventId: `inbound-email:${comm.id}`,
        type: 'customer.responded',
        customerId: customer.id,
        caseId: openCase.id,
        communicationId: comm.id,
        body,
      });
      await tx.insert(outbox).values({ eventType: event.type, payload: event });
      await writeAudit(tx, {
        caseId: openCase.id,
        actorType: 'provider',
        eventType: 'inbound_email.received',
        payload: { communicationId: comm.id, bytes: body.length },
      });
      return { status: 200 as const, caseId: openCase.id, communicationId: comm.id };
    });

    res.status(outcome.status).json(outcome);
  }));

  return router;
}
