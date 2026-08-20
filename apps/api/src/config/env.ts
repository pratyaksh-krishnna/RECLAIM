import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url().default('postgres://reclaim:reclaim@localhost:5433/reclaim'),
  REDIS_URL: z.string().url().default('redis://localhost:6380'),
  API_PORT: z.coerce.number().int().positive().default(3001),
  JWT_SECRET: z.string().min(16).default('change-me-32-chars-minimum-secret'),

  ANTHROPIC_API_KEY: z.string().optional().default(''),
  LLM_MODE: z.enum(['stub', 'live']).default('stub'),
  LLM_SMALL_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  LLM_MID_MODEL: z.string().default('claude-sonnet-5'),

  RAZORPAY_KEY_ID: z.string().optional().default(''),
  RAZORPAY_KEY_SECRET: z.string().optional().default(''),
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1).default('whsec_demo_secret'),
  PAYMENTS_MODE: z.enum(['sandbox', 'live-test']).default('sandbox'),

  MAILER_MODE: z.enum(['mock']).default('mock'),
});

export type Env = z.infer<typeof EnvSchema>;

export const env: Env = EnvSchema.parse(process.env);

// Guard: live LLM mode requires a key; fall back is an explicit failure, not silence.
if (env.LLM_MODE === 'live' && !env.ANTHROPIC_API_KEY) {
  throw new Error('LLM_MODE=live requires ANTHROPIC_API_KEY');
}
if (env.PAYMENTS_MODE === 'live-test' && (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET)) {
  throw new Error('PAYMENTS_MODE=live-test requires RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET');
}
