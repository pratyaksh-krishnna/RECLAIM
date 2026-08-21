import { z } from 'zod';

const isProd = process.env.NODE_ENV === 'production';

/** Dev-only fallback; production refuses to boot without explicit secrets. */
function devDefault<T extends z.ZodTypeAny>(schema: T, value: z.infer<T>) {
  return isProd ? schema : schema.default(value);
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: devDefault(z.string().url(), 'postgres://reclaim:reclaim@localhost:5433/reclaim'),
  REDIS_URL: devDefault(z.string().url(), 'redis://localhost:6380'),
  API_PORT: z.coerce.number().int().positive().default(3001),
  JWT_SECRET: devDefault(z.string().min(16), 'dev-only-jwt-secret-not-for-prod'),

  /** Required: every agent call goes to the real Anthropic API. There is no offline mode. */
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required — agents call the real Anthropic API'),
  LLM_MODEL: z.string().default('claude-haiku-3-5'),

  RAZORPAY_KEY_ID: z.string().optional().default(''),
  RAZORPAY_KEY_SECRET: z.string().optional().default(''),
  RAZORPAY_WEBHOOK_SECRET: devDefault(z.string().min(1), 'whsec_demo_secret'),
  PAYMENTS_MODE: z.enum(['sandbox', 'live-test']).default('sandbox'),

  MAILER_MODE: z.enum(['mock']).default('mock'),
  /** comma-separated origin allowlist for the browser app */
  CORS_ALLOWED_ORIGINS: z.string().default('http://localhost:5173'),
});

export type Env = z.infer<typeof EnvSchema>;

export const env: Env = EnvSchema.parse(process.env);

if (env.PAYMENTS_MODE === 'live-test' && (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET)) {
  throw new Error('PAYMENTS_MODE=live-test requires RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET');
}
