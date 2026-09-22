import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    env: { NODE_ENV: 'test' },
    // Test files share one PostgreSQL database (hms_test); run them one after another so
    // business rules like "one open shift per cashier" or room availability are deterministic.
    fileParallelism: false,
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 120_000,
    reporters: ['default'],
  },
});
