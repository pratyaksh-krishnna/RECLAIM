import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { Db } from './db/client.js';
import { makeInboundEmailRouter, makeWebhookRouter } from './ingest/webhookRouter.js';

export interface AppDeps {
  db: Db;
  webhookSecret: string;
  enqueueNormalize: (inboxId: string) => Promise<void>;
}

export function buildApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  // NOTE: webhook router mounts BEFORE any json body parser — raw body required for HMAC
  app.use(makeWebhookRouter({ db: deps.db, webhookSecret: deps.webhookSecret, enqueueNormalize: deps.enqueueNormalize }));
  app.use(makeInboundEmailRouter({ db: deps.db }));
  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('unhandled route error:', err);
    res.status(500).json({ error: 'internal error' });
  });
  return app;
}
