/**
 * Regression guard for the module-boundary rules.
 *
 * Why this test exists: when the boundary config was first written it silently
 * enforced NOTHING. We use NodeNext, so imports are written with a `.js`
 * specifier that resolves to a `.ts` file, and without the TypeScript resolver
 * eslint-plugin-boundaries could not resolve them — it treated every internal
 * import as external and skipped it. `npm run lint` passed, and the architecture
 * was unprotected.
 *
 * A boundary rule that fails open is worse than no boundary rule, because it
 * buys false confidence. This test writes deliberate violations, runs ESLint
 * over them, and asserts they are reported.
 *
 * TDD §2.1. docs/tech/tooling.md.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ESLint } from 'eslint';

const ROOT = process.cwd();
const PROBE_DIR = join(ROOT, 'src', 'pricing');
const created: string[] = [];
const dirExisted = existsSync(PROBE_DIR);

function probe(name: string, source: string): string {
  mkdirSync(PROBE_DIR, { recursive: true });
  const file = join(PROBE_DIR, name);
  writeFileSync(file, source, 'utf8');
  created.push(file);
  return file;
}

async function lintMessages(file: string): Promise<ESLint.LintResult[]> {
  const eslint = new ESLint({ cwd: ROOT });
  return eslint.lintFiles([file]);
}

function boundaryErrors(results: ESLint.LintResult[]): string[] {
  return results
    .flatMap((r) => r.messages)
    .filter((m) => m.ruleId === 'boundaries/element-types')
    .map((m) => m.message);
}

afterAll(() => {
  for (const f of created) rmSync(f, { force: true });
  if (!dirExisted) rmSync(PROBE_DIR, { recursive: true, force: true });
});

describe('module boundaries are actually enforced', () => {
  it('rejects pricing importing the database layer', async () => {
    // pricing must be PURE — no I/O, no clock, no database. This is what makes
    // the fee arithmetic property-testable.
    const file = probe(
      '__probe_db.ts',
      `import { createPool } from '../platform/db.js';\nexport const x = createPool;\n`,
    );
    const errors = boundaryErrors(await lintMessages(file));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("File is of type 'pricing'");
    expect(errors[0]).toContain("Dependency is of type 'platform-io'");
  });

  it('rejects pricing importing another domain module', async () => {
    const file = probe(
      '__probe_cross.ts',
      `import { HealthService } from '../health/health.controller.js';\nexport const x = HealthService;\n`,
    );
    const errors = boundaryErrors(await lintMessages(file));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("Dependency is of type 'health'");
  });

  it('ALLOWS pricing importing the pure half of platform', async () => {
    // The rule must permit what it is supposed to permit, or people disable it.
    const file = probe(
      '__probe_ok.ts',
      `import { applyBps, paise } from '../platform/money.js';\n` +
        `export const commission = applyBps(paise(25000), 300);\n`,
    );
    expect(boundaryErrors(await lintMessages(file))).toEqual([]);
  });

  it('rejects a domain module importing a payment provider SDK directly', async () => {
    // PRD PAY-MODE-02: everything goes through the PaymentProvider interface.
    const file = probe(
      '__probe_sdk.ts',
      `import Razorpay from 'razorpay';\nexport const x = Razorpay;\n`,
    );
    const results = await lintMessages(file);
    const restricted = results
      .flatMap((r) => r.messages)
      .filter((m) => m.ruleId === 'no-restricted-imports');
    expect(restricted.length).toBeGreaterThan(0);
    expect(restricted[0]?.message).toContain('PaymentProvider interface');
  });
});
