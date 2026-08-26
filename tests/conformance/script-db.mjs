/**
 * ============================================================================
 * A SCRIPT MUST TALK TO THE DATABASE THE WAY THE APPLICATION DOES
 * ============================================================================
 *
 * `platform/db.ts` registers a node-pg type parser for INT8 AS AN IMPORT SIDE
 * EFFECT:
 *
 *     pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v))
 *
 * Postgres returns BIGINT as a string — correctly, since it can exceed JS
 * number range — and every monetary column in this schema is BIGINT paise. So
 * that one registration is what makes `199.00` arrive as `19900` rather than
 * `"19900"` everywhere in the application.
 *
 * A script that builds its own `new Pool()` and `new Kysely()` never imports
 * that module, never registers the parser, and quietly reads different types
 * from the same rows.
 *
 * ----------------------------------------------------------------------------
 * WHAT THAT ACTUALLY COST
 * ----------------------------------------------------------------------------
 *
 * NINE scripts had it. It went unnoticed because most of them only print
 * strings, and a number rendered as `"19900"` looks fine in a terminal.
 *
 * It surfaced when `diagnose-split.ts` passed a money value to `paise()`, which
 * refuses a non-number by design:
 *
 *     MoneyError: money must be a number, got 19900
 *
 * And the way it surfaced is the real damage: it arrived while investigating a
 * 502 from the payment intent, and read exactly like a bug in the money path it
 * was meant to be reporting on. A diagnostic that fails DIFFERENTLY from the
 * application does not merely fail to help — it invents a second fault to
 * chase, on top of the one you started with.
 *
 * This is the third instance of the same shape in this codebase: the worker
 * hardcoding `StubPaymentProvider` while the API used Cashfree, and
 * `diagnose-cashfree.ts` hand-building the provider while `payment.module.ts`
 * used the factory. Every time, a second construction of something that should
 * have one.
 *
 * Run: node tests/conformance/script-db.mjs
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

import { stripComments } from './_source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = join(ROOT, 'scripts');

let checked = 0;
let failures = 0;

function check(name, ok, detail) {
  checked++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
}

console.log('\nscripts — one way to open a database connection');
console.log('─'.repeat(78));

const files = readdirSync(DIR).filter((f) => f.endsWith('.ts'));

check(
  `found ${files.length} scripts to check`,
  files.length > 5,
  'the directory scan broke and everything below passes vacuously',
);

/*
 * Only scripts that TOUCH the database. A script with no `selectFrom` and no
 * `sql\`` has nothing to get wrong, and demanding the import from it would be
 * noise that trains people to ignore this check.
 */
const offenders = [];
let dbScripts = 0;

for (const f of files) {
  const src = stripComments(readFileSync(join(DIR, f), 'utf8'));
  const touchesDb = /selectFrom\(|\bsql`/.test(src);
  if (!touchesDb) continue;
  dbScripts++;

  const buildsOwn = /new Pool\(|new PostgresDialect\(/.test(src);
  const usesShared = /from '\.\.\/src\/platform\/db\.js'/.test(src);

  if (buildsOwn || !usesShared) {
    offenders.push({ f, buildsOwn, usesShared });
  }
}

check(
  `${dbScripts} scripts talk to the database`,
  dbScripts > 3,
  'the detection broke — no script appears to query anything',
);

check(
  'every one of them goes through createPool/createDb',
  offenders.length === 0,
  offenders
    .map(
      (o) =>
        `${o.f}: ${o.buildsOwn ? 'builds its own Pool/Dialect' : 'does not import platform/db.js'}` +
        ` — BIGINT money will arrive as a string, and paise() will refuse it`,
    )
    .join('\n        '),
);

/* --------------------------------------- the parser is actually still there */
{
  const db = stripComments(readFileSync(join(ROOT, 'src/platform/db.ts'), 'utf8'));

  check(
    'platform/db.ts still registers the INT8 parser',
    /setTypeParser\(\s*pg\.types\.builtins\.INT8/.test(db),
    'this whole check is about routing scripts through that registration. ' +
      'Without it, routing them through this module buys nothing.',
  );

  check(
    'and it still refuses values outside the safe integer range',
    /isSafeInteger/.test(db),
    'silently truncating a BIGINT to a lossy double is a worse failure than ' +
      'the string it replaced',
  );
}

console.log('\n' + '═'.repeat(78));
console.log(`${checked} assertions, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
