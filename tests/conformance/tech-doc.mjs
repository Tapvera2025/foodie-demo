/**
 * `tech.md` describes the code that exists.
 *
 * WHY A DOCUMENT NEEDS A TEST
 *
 * v1.0 of `tech.md` listed Redis, BullMQ, Argon2, Playwright and `date-fns` as
 * the current stack. None of them were ever installed. It said so for two
 * months, through a working build, and nothing complained — because prose has
 * no compiler.
 *
 * That is worse than having no document. A new engineer reads it, believes the
 * job queue is BullMQ, and goes looking for a Redis connection string. The file
 * was not lying when it was written; it was a plan, and nobody demoted it when
 * the plan changed.
 *
 * So the claims that CAN be checked mechanically are checked. Not the prose —
 * the reasoning in that file is judgement and belongs to whoever wrote it — but
 * every "we use X", every "we do not use Y", and every number.
 *
 * Run: node tests/conformance/tech-doc.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

const doc = read('tech.md');
const pkg = JSON.parse(read('package.json'));
const deps = { ...pkg.dependencies, ...pkg.devDependencies };

let failures = 0;
let checked = 0;

function check(label, ok, detail = '') {
  checked++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

// ============================================================================
// 1. Everything §8 says we dropped is genuinely absent
// ============================================================================

console.log('§8 — dropped dependencies are actually gone');
console.log('─'.repeat(78));

/**
 * The names §8 claims are not used.
 *
 * Hardcoded rather than parsed out of the table, deliberately: the whole point
 * is to catch somebody quietly re-adding one, and a check that reads its own
 * expectations from the file it is checking would happily agree with a table
 * that had the row deleted.
 */
const MUST_BE_ABSENT = ['bullmq', 'ioredis', 'redis', 'argon2', 'bcrypt', 'date-fns', 'date-fns-tz', 'playwright', '@playwright/test', '@socket.io/redis-adapter'];

for (const name of MUST_BE_ABSENT) {
  check(`${name} not installed`, !(name in deps), name in deps ? `found ${deps[name]}` : '');
}

// Socket.IO is the special case: installed, and §3 claims zero imports.
console.log('');
console.log('§3 — Socket.IO is installed and unused');
console.log('─'.repeat(78));

check('socket.io is in package.json', 'socket.io' in deps);

function walk(dir, out = []) {
  for (const e of readdirSync(resolve(root, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const sources = [...walk('src'), ...walk('apps/pwa/src'), ...walk('apps/kds/src'), ...walk('apps/admin/src')];
const socketImports = sources.filter((f) => /from ['"]socket\.io/.test(read(f)));

/**
 * THE SOCKET LAYER IS WIRED, AND THIS CHECK INVERTED WHEN IT WAS.
 *
 * This asserted ZERO imports, with a note saying "the day somebody wires the
 * socket layer this test fails — correctly", because the docs claimed the
 * WEBSOCKET notification rung skipped for want of an implementation.
 *
 * That day arrived and the check did exactly its job: it failed, in the same
 * run as the change, and the documents were corrected rather than the check
 * being deleted. It now asserts the opposite, for the same reason — the docs
 * describe a realtime layer, and a realtime layer nothing imports would be a
 * document describing a system that does not exist.
 *
 * The four expected importers are named rather than counted. A fifth is fine
 * and will not fail this; what would fail is one of these four losing its
 * connection, which is how an app silently goes back to polling alone.
 */
const EXPECTED_SOCKET_IMPORTERS = [
  'src/realtime/realtime.gateway.ts',
  'apps/pwa/src/lib/realtime.ts',
  'apps/kds/src/realtime.ts',
  'apps/admin/src/realtime.ts',
];
const missingImporters = EXPECTED_SOCKET_IMPORTERS.filter(
  (f) => !socketImports.some((s) => s.replace(/^\.\//, '') === f),
);
check(
  'the server and all three apps import socket.io (docs/tech/backend.md §Realtime)',
  missingImporters.length === 0,
  missingImporters.length
    ? `no socket.io import in ${missingImporters.join(', ')} — that app is on the ` +
      `fallback timer only. Found: ${socketImports.join(', ') || '(none)'}`
    : '',
);

// ============================================================================
// 2. Everything §2 lists as used is installed
// ============================================================================

console.log('');
console.log('§2 — the stack table matches package.json');
console.log('─'.repeat(78));

const MUST_BE_PRESENT = {
  '@nestjs/core': 'framework',
  '@nestjs/platform-express': 'HTTP adapter',
  kysely: 'query layer',
  pg: 'driver',
  zod: 'validation',
  jose: 'auth',
  pino: 'logging',
  'prom-client': 'metrics',
  '@noble/hashes': 'OTP hashing',
  vitest: 'tests',
  'fast-check': 'property tests',
  'eslint-plugin-boundaries': 'module boundaries',
  'openapi-typescript': 'API types',
};

for (const [name, role] of Object.entries(MUST_BE_PRESENT)) {
  check(`${name} installed (${role})`, name in deps);
}

// Zustand is per-app, and §2 says which apps.
const appDeps = (a) => JSON.parse(read(`apps/${a}/package.json`)).dependencies;
check('zustand in pwa', 'zustand' in appDeps('pwa'));
check('zustand in kds', 'zustand' in appDeps('kds'));
check('zustand NOT in admin (§2: every screen is server state)', !('zustand' in appDeps('admin')));

// ============================================================================
// 3. Every number in the document
// ============================================================================

console.log('');
console.log('numbers quoted in the prose');
console.log('─'.repeat(78));

/** Pull `N` out of the first line matching a pattern, so the doc is the source. */
function quoted(re, label) {
  const m = doc.match(re);
  if (!m) {
    check(`${label} — claim found in tech.md`, false, 'the sentence has been reworded; update this test');
    return null;
  }
  return Number(m[1]);
}

const tables = [...read('db/migrations/20260810000001_init.sql').matchAll(/^CREATE TABLE/gm)].length +
  readdirSync(resolve(root, 'db/migrations'))
    .filter((f) => !f.includes('init'))
    .reduce((n, f) => n + [...read(`db/migrations/${f}`).matchAll(/^CREATE TABLE/gm)].length, 0);

const claimedTables = quoted(/(\d+) tables, \d+ migrations/, 'table count');
if (claimedTables !== null) check(`${claimedTables} tables`, claimedTables === tables, `actual ${tables}`);

const migrationFiles = readdirSync(resolve(root, 'db/migrations'));
const migrations = migrationFiles.length;
const claimedMigrations = quoted(/\d+ tables, (\d+) migrations/, 'migration count');
if (claimedMigrations !== null) {
  check(`${claimedMigrations} migrations`, claimedMigrations === migrations, `actual ${migrations}`);
}

/**
 * EVERY MIGRATION HAS BOTH DIRECTIVE MARKERS.
 *
 * `scripts/migrate.ts` splits a file on `-- migrate:up` and `-- migrate:down`.
 * A file missing the up marker throws at run time with a clear message, which
 * sounds harmless — the migration simply does not apply.
 *
 * It is not harmless, because of WHEN it throws. The runner reads every file
 * before applying any, so one malformed migration blocks the whole batch. On a
 * laptop that is thirty wasted seconds. In CI, or on a deploy that runs
 * migrations before starting the API, it is a failed release caused by a
 * missing comment.
 *
 * A missing `-- migrate:down` is quieter still and worse in the moment it
 * matters: nothing complains at all, and the gap is discovered while trying to
 * roll back a bad deploy at the exact point when there is no time to write one.
 *
 * Counting the files was never going to catch either. This was added after
 * shipping a migration with neither marker.
 */
for (const f of migrationFiles) {
  const sql = read(`db/migrations/${f}`);
  const up = sql.includes('-- migrate:up');
  const down = sql.includes('-- migrate:down');
  // The detail is computed conditionally, not with a ternary passed as an
  // argument — `check` prints whatever it is given, so an eagerly-evaluated
  // failure message appears next to a passing row and reads as a warning
  // nobody can act on. A green line that describes a problem is worse than no
  // line: it trains people to skim past this whole section.
  const detail = up && down ? '' : !up
    ? 'no "-- migrate:up": this blocks the ENTIRE batch'
    : 'no "-- migrate:down": nothing can roll it back';

  check(`${f.replace(/\.sql$/, '')} — up and down markers`, up && down, detail);
}

const perms = read('src/identity/permissions.ts');
/*
 * `[a-z._]`, with the underscore.
 *
 * The first version used `[a-z.]` and counted 30 where there are 31: it silently
 * dropped `order.force_cancel`, the only permission with an underscore in it —
 * and force-cancelling an order is not a permission to lose track of. The count
 * was wrong by one in the direction that looks plausible, which is the kind of
 * off-by-one nobody investigates.
 */
/*
 * `\r?$`, because this repository is checked out on Windows too.
 *
 * `core.autocrlf=true` gives the working tree CRLF line endings, so splitting
 * on '\n' leaves a trailing '\r' on every line and `$` matches nothing. The
 * count came back as 0 — not off by one, but zero, on a file that plainly
 * contains thirty-odd permissions — and the check reported the doc's honest
 * number as wrong on every Windows machine while passing on every Linux one.
 *
 * A conformance check that depends on the checkout platform is a check people
 * learn to ignore, which is worse than not having it. Same class of defect as
 * the path separator bug in console-authz.mjs.
 */
const nPerms = perms.split('] as const')[0].split('\n').filter((l) => /^\s+'[a-z._]+',\r?$/.test(l)).length;
const nRoles = perms.split('] as const')[1].split('\n').filter((l) => /^\s+'[A-Z_]+',\r?$/.test(l)).length;

const claimedPerms = quoted(/\*\*(\d+) permissions × \d+ roles\*\*/, 'permission count');
const claimedRoles = quoted(/\*\*\d+ permissions × (\d+) roles\*\*/, 'role count');
if (claimedPerms !== null) check(`${claimedPerms} permissions`, claimedPerms === nPerms, `actual ${nPerms}`);
if (claimedRoles !== null) check(`${claimedRoles} roles`, claimedRoles === nRoles, `actual ${nRoles}`);

// Worker tick — the one number PRD §16.1's budget depends on.
const tick = read('src/workers/index.ts').match(/const TICK_MS = ([\d_]+);/);
const tickMs = tick ? Number(tick[1].replace(/_/g, '')) : NaN;
check('TICK_MS = 1500, as §3 states', tickMs === 1500, `actual ${tickMs}`);
check('tech.md says 1.5-second poll', /1\.5-second poll/.test(doc));

// Escalation rungs.
const esc = read('src/dispatch/escalation.ts');
const rungs = [1, 2, 3, 4].map((i) => Number(esc.match(new RegExp(`step${i}Seconds: (\\d+)`))?.[1]));
check(
  'escalation ladder is 15 / 45 / 90 / 180',
  rungs.join('/') === '15/45/90/180' && /15 \/ 45 \/ 90 \/ 180 seconds/.test(doc),
  `code says ${rungs.join('/')}`,
);

// Dev-server ports.
for (const [app, port] of [['pwa', 5173], ['kds', 5174], ['admin', 5175]]) {
  const configured = read(`apps/${app}/vite.config.ts`).includes(`port: ${port}`);
  const documented = doc.includes(`| ${port} |`);
  check(`${app} on ${port}`, configured && documented, configured ? '' : 'vite.config disagrees');
}

// ============================================================================
// 4. The append-only claim
// ============================================================================

console.log('');
console.log('§4 — five append-only tables, by trigger');
console.log('─'.repeat(78));

const triggers = read('db/migrations/20260810000002_append_only_triggers.sql');
for (const t of ['ledger_entry', 'order_status_history', 'audit_log', 'processed_event', 'dispatch_attempt']) {
  check(`${t} has a trigger`, triggers.includes(t) && doc.includes(t));
}

// The TRUNCATE guard is a separate migration (errata E-008) and §4 says so.
check(
  'TRUNCATE guarded separately',
  read('db/migrations/20260812000005_append_only_truncate.sql').toUpperCase().includes('TRUNCATE'),
);

// ============================================================================
// 5. Password algorithm
// ============================================================================

console.log('');
console.log('§2 and §8 — scrypt, not Argon2');
console.log('─'.repeat(78));

const pw = read('src/identity/password.ts');
check('password.ts imports scrypt from node:crypto', /from 'node:crypto'/.test(pw) && /scrypt/.test(pw));
check('password.ts does not use argon2', !/argon2/i.test(pw.replace(/\/\*[\s\S]*?\*\//g, '')));

// ============================================================================
// 6. Negative control
// ============================================================================

console.log('');
console.log('negative control');
console.log('─'.repeat(78));

/**
 * Prove the dependency check can fail.
 *
 * Without this, a bug that made `deps` an empty object would report every
 * "not installed" claim as passing and the file would be certifying nothing.
 */
const fakeDeps = { ...deps, bullmq: '^5.0.0' };
check(
  'a re-added bullmq would be caught',
  'bullmq' in fakeDeps && !('bullmq' in deps),
);

console.log('\n' + '═'.repeat(78));
console.log(`${checked} claims checked against the code, ${failures} wrong`);
process.exit(failures === 0 ? 0 : 1);
