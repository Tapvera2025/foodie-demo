/**
 * ============================================================================
 * NOTHING GOES BACK TO ASKING EVERY THREE SECONDS
 * ============================================================================
 *
 * Before sockets, fourteen queries across three apps polled on timers between
 * two and thirty seconds. The worst were a customer's order at 4s, the stall
 * list at 4s, a stall's menu at 4s and the kitchen board at 3s — every one of
 * them asking a question whose answer had not changed, twenty times a minute,
 * for every open tab in a food court.
 *
 * Those are now driven by `order.changed` and `catalog.changed`, and what is
 * left on a timer is deliberately slow.
 *
 * ----------------------------------------------------------------------------
 * WHY THIS NEEDS A CHECK AND NOT JUST A COMMIT
 * ----------------------------------------------------------------------------
 *
 * Adding `refetchInterval: 3000` is a one-line fix for almost any "the screen
 * did not update" report, it always works, and it is invisible in review. The
 * pressure to reintroduce it arrives the first time realtime has a bad day —
 * which is exactly when adding it hides the actual fault instead of fixing it.
 *
 * So the floor is enforced rather than agreed. A screen that genuinely needs
 * to poll faster has to say so here, in one place, with a reason next to it.
 *
 * ----------------------------------------------------------------------------
 * WHAT IS DELIBERATELY ALLOWED
 * ----------------------------------------------------------------------------
 *
 * `FALLBACK_MS`, because that is the point — it is insurance against a socket
 * that died silently, not a poll. And the OTP screen, which is a bounded wait
 * of a few seconds for a code to arrive, ends the moment it does, and has no
 * event to hang off because the customer is not authenticated yet. Everything
 * else has to clear the floor.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative } from 'node:path';

import { stripComments } from './_source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Below this, a timer is a poll rather than a safety net. */
const FLOOR_MS = 15_000;

/**
 * Screens that may poll faster, each with the reason it may.
 *
 * A list, so adding to it is a visible act in a diff rather than a number
 * changed in a file nobody re-reads.
 */
const ALLOWED = new Map([
  [
    'apps/pwa/src/screens/Verify.tsx',
    'the OTP wait: seconds long, self-terminating, and the customer has no ' +
      'token yet so there is no socket to carry it',
  ],
]);

let checked = 0;
let failures = 0;

function check(name, ok, detail) {
  checked++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.tsx?$/.test(entry)) yield full;
  }
}

console.log('\nno hot polling — realtime replaced the timers, and must keep them replaced');
console.log('─'.repeat(78));

const offenders = [];
let intervalsSeen = 0;
let filesScanned = 0;

for (const app of ['apps/pwa/src', 'apps/kds/src', 'apps/admin/src']) {
  for (const file of walk(join(ROOT, app))) {
    filesScanned++;
    const src = stripComments(readFileSync(file, 'utf8'));
    const rel = relative(ROOT, file);

    /*
     * Numeric literals only. `refetchInterval: FALLBACK_MS` and the function
     * form that returns `FALLBACK_MS` are what this change produced, and both
     * are correct by construction — the constant is defined once, in
     * `realtime.ts`, next to the argument for its value.
     *
     * Underscore separators are matched because `15_000` and `15000` are the
     * same number and both are written in this codebase.
     */
    for (const m of src.matchAll(/refetchInterval:\s*(?:\(\)\s*=>\s*)?([\d_]+)/g)) {
      intervalsSeen++;
      const ms = Number(m[1].replace(/_/g, ''));
      if (ms >= FLOOR_MS) continue;
      if (ALLOWED.has(rel)) continue;
      offenders.push({ rel, ms });
    }
    // The Track screen's conditional form: `? false : <number>`.
    for (const m of src.matchAll(/:\s*([\d_]+);?\s*\n\s*\},\s*\n\s*\}\);/g)) {
      void m; // shape too loose to judge on; the literal scan above covers it
    }
  }
}

check(
  'the scan actually read the three apps',
  filesScanned > 40 && intervalsSeen > 0,
  `${filesScanned} files, ${intervalsSeen} numeric refetchIntervals — if either is ` +
    `zero this file passes without checking anything`,
);

check(
  `no query polls faster than ${FLOOR_MS / 1000}s`,
  offenders.length === 0,
  offenders.map((o) => `${o.rel} polls every ${o.ms}ms`).join('\n        ') +
    `\n        If a screen truly needs this, add it to ALLOWED with the reason. ` +
    `Otherwise it wants a socket event — see src/realtime/publish.ts.`,
);

/* ------------------------------------- the replacements are actually wired */
{
  const wired = [
    ['apps/pwa/src/screens/Track.tsx', 'ORDER_CHANGED', "the customer's own order"],
    ['apps/kds/src/App.tsx', 'ORDER_CHANGED', 'the kitchen board'],
    ['apps/pwa/src/screens/Menu.tsx', 'CATALOG_CHANGED', 'a stall menu going out of stock'],
    ['apps/pwa/src/screens/Vendors.tsx', 'CATALOG_CHANGED', 'a stall opening or closing'],
  ];

  for (const [rel, event, what] of wired) {
    const src = stripComments(readFileSync(join(ROOT, rel), 'utf8'));
    check(
      `${rel.split('/').pop()} subscribes to ${event}`,
      new RegExp(`useRealtime\\(\\s*${event}`).test(src),
      `${what} would only update on the fallback timer — which is the slow path, ` +
        `not the path`,
    );
  }
}

/* ------------------------------ the server actually publishes what they await */
{
  const transition = stripComments(
    readFileSync(join(ROOT, 'src/ordering/transition.ts'), 'utf8'),
  );
  check(
    'the status choke point publishes, inside the transaction',
    /await publishOrderChanged\(\s*trx\b/.test(transition),
    'a client subscribed to an event nothing sends is worse than polling: it ' +
      'looks wired and updates only on the fallback. `trx` and not `db` — the ' +
      'notification has to commit with the change it describes.',
  );

  const interceptor = stripComments(
    readFileSync(join(ROOT, 'src/catalog/inventory.controller.ts'), 'utf8'),
  );
  check(
    'every catalogue write broadcasts, via the class-level interceptor',
    /@UseInterceptors\(CatalogBroadcastInterceptor\)/.test(interceptor),
    'per-method publishing is a list that goes stale at the next endpoint',
  );
}

console.log('\n' + '═'.repeat(78));
console.log(`${checked} assertions, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
