import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 300_000,
    // Separate processes, not worker threads: with the CPU-heavy simulator and
    // zkir checks in threads, vitest sometimes failed a run whose tests all
    // passed with "Timeout calling onTaskUpdate" (no test takes more than 10 s).
    pool: 'forks',
  },
});
