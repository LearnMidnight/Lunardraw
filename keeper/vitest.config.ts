import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The simulator runs the real circuits; computing the numbers is slow.
    testTimeout: 300_000,
  },
});
