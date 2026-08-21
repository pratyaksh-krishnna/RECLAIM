import { db } from './db/client.js';
import { env } from './config/env.js';
import { buildApp } from './app.js';
import { buildLiveDeps, registerRepeatables, startWorkers } from './workers/workers.js';
import { queues, defaultJobOpts } from './queues/queues.js';
import { bootstrap } from './seed/bootstrap.js';

await bootstrap(db);

const app = buildApp({
  db,
  webhookSecret: env.RAZORPAY_WEBHOOK_SECRET,
  enqueueNormalize: async (inboxId) => {
    await queues.normalize.add('normalize', { inboxId }, defaultJobOpts);
  },
  orchestrator: buildLiveDeps(db).orchestrator,
});

const workers = startWorkers(db);
await registerRepeatables();

const server = app.listen(env.API_PORT, () => {
  console.log(`[reclaim-api] listening on :${env.API_PORT} (llm=${env.LLM_MODEL}, payments=${env.PAYMENTS_MODE})`);
});

async function shutdown(): Promise<void> {
  console.log('shutting down…');
  server.close();
  await Promise.allSettled(workers.map((w) => w.close()));
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
