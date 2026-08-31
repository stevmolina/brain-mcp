import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The isolation test writes real rows; running files in parallel against one
    // Neon branch would let them see each other's fixtures.
    fileParallelism: false,
  },
});
