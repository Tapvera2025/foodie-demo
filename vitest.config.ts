import { defineConfig } from 'vitest/config';

/**
 * Load `.env` so integration tests see DATABASE_URL, the same way the dev
 * server does via `--env-file-if-exists`.
 *
 * Without this the integration tests that need a database silently *skip*
 * rather than fail — `describe.skip` when DATABASE_URL is absent — and a
 * skipped test reports green. That is the same failure-by-silence pattern as
 * `docs/errata.md` E-002 and E-005, so it is worth closing here rather than
 * discovering later that schema conformance has never actually run locally.
 *
 * Absent in CI, which supplies the environment directly; hence the catch.
 */
try {
  process.loadEnvFile('.env');
} catch {
  // no .env — CI, or a developer using a shell export. Both are fine.
}

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // docs/tech/tooling.md — a hard floor on the three modules that move money.
      // Everything else is judgement; these three are not.
      include: ['src/pricing/**', 'src/payments/**', 'src/ledger/**', 'src/platform/money.ts'],
      thresholds: {
        lines: 95,
        branches: 90,
        functions: 95,
        statements: 95,
      },
    },
  },
});
