// Runs once before the test suite: applies the D1 schema migrations to the
// local (in-memory, per-worker) Miniflare D1 instance so every test starts
// against the real schema instead of an empty database.
//
// TEST_MIGRATIONS is injected via vitest.config.ts (poolOptions.workers.miniflare.bindings),
// populated from migrations/*.sql by readD1Migrations().
import { applyD1Migrations, env } from 'cloudflare:test';

const testEnv = env as unknown as {
  DB: D1Database;
  TEST_MIGRATIONS: import('@cloudflare/vitest-pool-workers/config').D1Migration[];
};

await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
