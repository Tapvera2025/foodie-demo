/**
 * Proves every module can actually be loaded.
 *
 * WHY THIS EXISTS
 *
 * `payment.controller.ts` imported its injection tokens from
 * `payment.module.ts`, which imported the controller. A cycle. At runtime:
 *
 *     ReferenceError: Cannot access 'PAYMENT_ENGINE' before initialization
 *
 * The API would not boot. Three consecutive clean `tsc --noEmit` runs said
 * nothing, because a circular *type* graph is perfectly legal and the compiler
 * has no opinion about module evaluation order. Neither did the unit tests —
 * they import leaves, and the cycle was between two files no leaf touches.
 *
 * So the gap was not "we forgot to write a test for payments". It was that
 * NOTHING in the suite ever imported the composition root. The whole point of
 * an entrypoint is that it pulls the graph together, and it was the one file
 * with no coverage of any kind.
 *
 * This is deliberately not a boot test. It needs no database, no config and no
 * network — it imports, and asserts the imports produced something. That is
 * exactly the failure being guarded against, and keeping it that cheap means it
 * runs in the unit suite rather than behind a Postgres service.
 */

import { describe, it, expect } from 'vitest';

describe('the module graph loads', () => {
  it('imports the composition root without a circular reference', async () => {
    // The failing import throws here rather than returning undefined, so the
    // assertion below is a formality — the value of this test is that the
    // import is attempted at all.
    const mod = await import('../../src/app.module.js');
    expect(mod.AppModule).toBeTypeOf('function');
  });

  it('loads every Nest module and controller', async () => {
    // Listed explicitly rather than globbed. A glob would silently start
    // covering new files, which sounds good until it silently STOPS covering
    // one that gets renamed — and a guard that quietly shrinks is the pattern
    // this codebase keeps writing errata about.
    const modules = [
      '../../src/platform/database.module.js',
      '../../src/platform/workers.module.js',
      '../../src/payments/payment.module.js',
      '../../src/payments/payment.controller.js',
      '../../src/payments/payment.tokens.js',
      '../../src/health/health.controller.js',
      '../../src/identity/auth.controller.js',
      '../../src/identity/customer-auth.controller.js',
      '../../src/tenancy/discovery.controller.js',
      '../../src/ordering/order.controller.js',
      '../../src/ordering/kds.controller.js',
      '../../src/catalog/inventory.controller.js',
    ];

    for (const path of modules) {
      const mod = await import(path);
      expect(Object.keys(mod).length, `${path} exported nothing`).toBeGreaterThan(0);
    }
  });

  it('keeps injection tokens in a leaf that imports nothing', async () => {
    // The structural fix, asserted rather than trusted to a comment. A token
    // module with no imports cannot participate in a cycle, so this is the
    // property that makes the bug unrepeatable rather than merely fixed.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/payments/payment.tokens.ts', 'utf8');

    const imports = src.match(/^\s*import\s/gm) ?? [];
    expect(imports, 'payment.tokens.ts must import nothing').toHaveLength(0);
  });

  it('has no controller in a cycle with the module that provides it', async () => {
    /**
     * The precise property, not a proxy for it.
     *
     * A first version of this asserted that no controller imports from any
     * `.module.js`. That is far too broad and would have failed on eight safe
     * imports: `DB` and `PG_POOL` come from `database.module.ts`, which
     * declares no controllers and therefore cannot close a loop. Banning the
     * pattern outright would have meant a red test with no bug behind it,
     * which is how a suite trains people to ignore it.
     *
     * What actually broke the API is a two-way edge: the controller imports
     * the module AND the module imports the controller back. That is what this
     * looks for. `workers.module.ts` is one controller away from the same
     * trap; this catches it on the commit that introduces it rather than
     * requiring anyone to remember.
     */
    const { readFileSync, readdirSync } = await import('node:fs');
    const { basename, dirname, join, resolve } = await import('node:path');

    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(full);
      }
    };
    walk('src');

    /** Resolved absolute paths this file imports from within `src`. */
    const importsOf = (file: string): Set<string> => {
      const src = readFileSync(file, 'utf8');
      const out = new Set<string>();
      for (const m of src.matchAll(/from\s+'(\.[^']+)\.js'/g)) {
        out.add(resolve(dirname(file), `${m[1]}.ts`));
      }
      return out;
    };

    const graph = new Map(files.map((f) => [resolve(f), importsOf(f)]));

    const cycles: string[] = [];
    for (const [file, deps] of graph) {
      for (const dep of deps) {
        // A two-way edge. Only reported once, by naming the pair in a stable
        // order, so one cycle does not produce two failures.
        if (graph.get(dep)?.has(file) && file < dep) {
          cycles.push(`${basename(file)} ⇄ ${basename(dep)}`);
        }
      }
    }

    expect(
      cycles,
      'a two-way import is what stopped the API booting with "Cannot access X before ' +
        'initialization". Put whatever both files need in a leaf that imports nothing.',
    ).toEqual([]);
  });
});
