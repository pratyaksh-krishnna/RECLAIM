import { createHash, randomUUID } from 'node:crypto';
import { Router, raw, json, type NextFunction, type Request, type Response } from 'express';
import { and, desc, eq, inArray, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { CanonicalEvent, TERMINAL_STATES } from '@reclaim/shared';
import type { Db } from '../db/client.js';
import { communications, customers, outbox, recoveryCases, webhookInbox } from '../db/schema.js';
import { writeAudit } from '../audit/audit.js';
import { verifyMetaSignature, verifyRazorpaySignature } from './verifySignature.js';
import { env } from '../config/env.js';

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

interface MetaWebhookBody {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<{ from: string; id: string; type: string; text?: { body: string } }>;
      };
    }>;
  }>;
}

/**
 * Meta WhatsApp Cloud API webhook.
 *
 * A sibling of makeInboundEmailRouter above, not a new subsystem: it writes the
 * same kind of inbound communications row and emits the same customer.responded
 * event, so the reply interpreter, promise extraction, dispute handling and
 * opt-out all work unchanged.
 *
 * It also does something the email hook does not need to: an inbound message
 * here is what OPENS the 24-hour window that outbound voice notes require. That
 * is why `sentAt` is set — isWhatsAppWindowOpen reads it.
 */
export function makeWhatsAppRouter(deps: { db: Db }): Router {
  const router = Router();

  // Meta's subscription challenge.
  router.get('/webhooks/whatsapp', (req: Request, res: Response) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === env.WHATSAPP_VERIFY_TOKEN && typeof challenge === 'string') {
      res.status(200).send(challenge);
      return;
    }
    res.sendStatus(403);
  });

  router.post(
    '/webhooks/whatsapp',
    raw({ type: '*/*' }), // raw body required for HMAC — must precede any json parser
    asyncRoute(async (req: Request, res: Response) => {
      const rawBody = req.body as Buffer;
      const signature = req.header('x-hub-signature-256') ?? '';
      if (!verifyMetaSignature(rawBody, signature, env.WHATSAPP_APP_SECRET)) {
        res.status(401).json({ error: 'bad signature' });
        return;
      }

      const payload = JSON.parse(rawBody.toString('utf8')) as MetaWebhookBody;
      const message = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

      // Delivery-status callbacks arrive at this same URL. They are not
      // customer messages and must never open a window.
      if (!message || message.type !== 'text' || !message.text?.body) {
        res.status(200).json({ ok: true, ignored: true });
        return;
      }
      const text = message.text.body;

      const outcome = await deps.db.transaction(async (tx) => {
        // Meta sends bare digits; we store E.164 with a '+'. Try both.
        const digits = message.from.replace(/^\+/, '');
        const [customer] = await tx
          .select()
          .from(customers)
          .where(inArray(customers.phone, [`+${digits}`, digits]))
          .limit(1);
        if (!customer) return { status: 200 as const, ignored: 'unknown number' };

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
        if (!openCase) return { status: 200 as const, ignored: 'no open case' };

        const body = text.slice(0, 20_000);
        const [comm] = await tx
          .insert(communications)
          .values({
            caseId: openCase.id,
            customerId: customer.id,
            direction: 'inbound',
            channel: 'whatsapp_text',
            renderedBody: body,
            providerMessageId: message.id,
            // load-bearing: isWhatsAppWindowOpen reads this column
            sentAt: new Date(),
          })
          .returning({ id: communications.id });
        if (!comm) return { status: 500 as const, error: 'insert failed' };

        const event = CanonicalEvent.parse({
          eventId: randomUUID(),
          occurredAt: new Date().toISOString(),
          sourceEventId: `inbound-whatsapp:${message.id}`,
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
          eventType: 'inbound_whatsapp.received',
          payload: { communicationId: comm.id, bytes: body.length },
        });
        return { status: 200 as const, caseId: openCase.id, communicationId: comm.id };
      });

      // Always 200 for a well-signed request Meta cannot act on, or it retries
      // the same unresolvable message indefinitely.
      res.status(outcome.status).json(outcome);
    }),
  );

  return router;
}
