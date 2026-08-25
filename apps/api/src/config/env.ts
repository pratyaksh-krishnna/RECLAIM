import { z } from 'zod';

const isProd = process.env.NODE_ENV === 'production';

/** Dev-only fallback; production refuses to boot without explicit secrets. */
function devDefault<T extends z.ZodTypeAny>(schema: T, value: z.infer<T>) {
  return isProd ? schema : schema.default(value);
}

/** `KEY=` in a .env file arrives as an empty string; for these settings that means unset. */
function blankAsUnset<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((v) => (v === '' ? undefined : v), schema);
}

export const LlmProvider = z.enum(['anthropic', 'openai']);
export type LlmProvider = z.infer<typeof LlmProvider>;

/** Whichever provider is selected, its key is mandatory — there is no offline mode. */
const REQUIRED_API_KEY = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
} as const satisfies Record<LlmProvider, string>;

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: devDefault(z.string().url(), 'postgres://reclaim:reclaim@localhost:5433/reclaim'),
  REDIS_URL: devDefault(z.string().url(), 'redis://localhost:6380'),
  API_PORT: z.coerce.number().int().positive().default(3001),
  JWT_SECRET: devDefault(z.string().min(16), 'dev-only-jwt-secret-not-for-prod'),

  /** Which provider answers agent calls. Both adapters are real API calls. */
  LLM_PROVIDER: LlmProvider.default('anthropic'),
  /** Required when LLM_PROVIDER=anthropic — enforced below, once the provider is known. */
  ANTHROPIC_API_KEY: z.string().default(''),
  /** Required when LLM_PROVIDER=openai. */
  OPENAI_API_KEY: z.string().default(''),
  /** Optional: an OpenAI-compatible gateway or Azure endpoint instead of api.openai.com. */
  OPENAI_BASE_URL: blankAsUnset(z.string().url().optional()),
  /**
   * A model id per provider, NOT one shared setting. Each adapter reads its own,
   * so the inactive provider's id sitting in .env is harmless — flipping
   * LLM_PROVIDER can never send a Claude id to OpenAI or the reverse.
   */
  ANTHROPIC_MODEL: blankAsUnset(z.string().min(1).default('claude-haiku-4-5')),
  OPENAI_MODEL: blankAsUnset(z.string().min(1).default('gpt-5.6-sol')),

  RAZORPAY_KEY_ID: z.string().optional().default(''),
  RAZORPAY_KEY_SECRET: z.string().optional().default(''),
  RAZORPAY_WEBHOOK_SECRET: devDefault(z.string().min(1), 'whsec_demo_secret'),
  PAYMENTS_MODE: z.enum(['sandbox', 'live-test']).default('sandbox'),

  MAILER_MODE: z.enum(['mock']).default('mock'),
  /** comma-separated origin allowlist for the browser app */
  CORS_ALLOWED_ORIGINS: z.string().default('http://localhost:5173'),
});

/**
 * LLM_MODEL is DERIVED, not read from the environment: the model the selected
 * provider will actually be called with. Adapters read their own provider's
 * setting; this exists so logs and displays have one answer to "which model".
 */
export type Env = z.infer<typeof EnvSchema> & { LLM_MODEL: string };

// It used to be an input, applying to whichever provider was active — which
// meant switching provider silently sent the wrong id. Refuse to ignore a value
// someone deliberately set; say what replaced it instead.
if (process.env.LLM_MODEL) {
  throw new Error(
    'LLM_MODEL is no longer read — set ANTHROPIC_MODEL or OPENAI_MODEL instead (each provider keeps its own model id)',
  );
}

const parsed = EnvSchema.parse(process.env);

export const env: Env = {
  ...parsed,
  LLM_MODEL: parsed.LLM_PROVIDER === 'openai' ? parsed.OPENAI_MODEL : parsed.ANTHROPIC_MODEL,
};

// The key check left the schema because which key is required now depends on
// another field. The guarantee is unchanged: the API refuses to boot without a
// key for the provider it is about to call.
const requiredKey = REQUIRED_API_KEY[env.LLM_PROVIDER];
if (!env[requiredKey]) {
  throw new Error(
    `${requiredKey} is required — agents call the real ${env.LLM_PROVIDER} API; there is no offline mode`,
  );
}

if (env.PAYMENTS_MODE === 'live-test' && (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET)) {
  throw new Error('PAYMENTS_MODE=live-test requires RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET');
}
