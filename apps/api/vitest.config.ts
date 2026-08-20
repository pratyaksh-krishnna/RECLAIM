import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // integration tests share one Postgres test database — keep files serial
    fileParallelism: false,
    globalSetup: ['./test/helpers/globalSetup.ts'],
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://reclaim:reclaim@localhost:5433/reclaim_test',
      REDIS_URL: 'redis://localhost:6380',
      LLM_MODE: 'stub',
      PAYMENTS_MODE: 'sandbox',
      RAZORPAY_WEBHOOK_SECRET: 'whsec_test_secret',
    },
  },
});
