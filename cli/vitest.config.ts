import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 20 * 60_000,
    // The end-to-end tests share one local network and run in order.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
