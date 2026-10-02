import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Real scrypt/Fastify/SQLite/Docker fixtures share host resources. Keep per-test deadlines and internal race assertions intact.
    maxWorkers: 2,
  },
});
