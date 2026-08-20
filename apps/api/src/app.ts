import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { Db } from './db/client.js';
import { makeInboundEmailRouter, makeWebhookRouter } from './ingest/webhookRouter.js';
import { makeApiRouter, type ApiDeps } from './api/routes.js';

export interface AppDeps {
  db: Db;
  webhookSecret: string;
  enqueueNormalize: (inboxId: string) => Promise<void>;
  orchestrator?: ApiDeps['orchestrator'];
}

export function buildApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  // NOTE: webhook router mounts BEFORE any json body parser — raw body required for HMAC
  app.use(makeWebhookRouter({ db: deps.db, webhookSecret: deps.webhookSecret, enqueueNormalize: deps.enqueueNormalize }));
  app.use(makeInboundEmailRouter({ db: deps.db }));
  // dev CORS for the Vite frontend
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.header('Access-Control-Allow-Origin', req.header('origin') ?? '*');
    res.header('Access-Control-Allow-Headers', 'authorization, content-type');
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });
  if (deps.orchestrator) {
    app.use(makeApiRouter({ db: deps.db, orchestrator: deps.orchestrator }));
  }
  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('unhandled route error:', err);
    res.status(500).json({ error: 'internal error' });
  });
  return app;
}
