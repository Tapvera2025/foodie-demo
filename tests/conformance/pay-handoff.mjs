/**
 * ============================================================================
 * EVERY WAY THE PAYMENT HANDOFF CAN END MUST REACH A SCREEN
 * ============================================================================
 *
 * THE BUG THIS EXISTS FOR, WHICH SHIPPED AND SHOWED NOTHING
 *
 * `Pay.tsx` has a fully written panel for a handoff that fails to open:
 *
 *     "The payment screen did not open"
 *     "Nothing has been charged. This is usually a network hiccup…"
 *     [ Try again ]  [ Back to your basket ]
 *
 * It had never been displayed. Both failure paths in `payNow` set their
 * message and then reset `handoffStartedAt` to null — and `awaitingHandoff`,
 * which is checked FIRST and returns the order summary, was true whenever
 * `handoffStartedAt` was null. So the summary always won and the panel below
 * was dead code. Same for "Payments are not switched on yet".
 *
 * Nothing threw. The panel compiled, typechecked, and read correctly to
 * anybody looking at it. It simply sat behind an earlier `return`.
 *
 * That is the class of bug here: A STATE WITH A SCREEN AND NO WAY TO SEE IT.
 * It got worse the moment arrival could start the handoff by itself, because
 * a failure then loops — fire, fail, render something that looks unchanged,
 * offer no explanation.
 *
 * ----------------------------------------------------------------------------
 * WHAT IS CHECKED, AND WHY IT IS NOT A RESTATEMENT OF THE CODE
 * ----------------------------------------------------------------------------
 *
 * The check does not assert "the expression contains these words" from a list
 * written by hand. It DERIVES the list: it reads which error flags `payNow`
 * actually sets, and requires each one to be excluded from the guard. Add a
 * third failure mode tomorrow with its own panel and this fails until the
 * guard knows about it — which is exactly the moment it needs to.
 *
 * Run: node tests/conformance/pay-handoff.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

// Shared, because this exact bug was written three times. See _source.mjs.
import { stripComments } from './_source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');


const payRaw = readFileSync(join(ROOT, 'apps/pwa/src/screens/Pay.tsx'), 'utf8');
const checkoutRaw = readFileSync(join(ROOT, 'apps/pwa/src/screens/Checkout.tsx'), 'utf8');
const pay = stripComments(payRaw);
const checkout = stripComments(checkoutRaw);

let checked = 0;
let failures = 0;

function check(name, ok, detail) {
  checked++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
}

/**
 * The body of a `const NAME = … => {` arrow, by brace matching.
 *
 * Counting braces rather than searching for a closing marker: the body
 * contains nested objects, arrow callbacks and template literals, and every
 * "find the next `};`" shortcut lands inside one of them.
 */
function arrowBody(src, name) {
  const start = src.indexOf(`const ${name} =`);
  if (start === -1) return '';
  const open = src.indexOf('{', src.indexOf('=>', start));
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  return '';
}

console.log('\npay handoff — no state may have a panel it can never reach');
console.log('─'.repeat(78));

const payNow = arrowBody(pay, 'payNow');
const guard = pay.slice(pay.indexOf('const awaitingHandoff ='), pay.indexOf(';', pay.indexOf('const awaitingHandoff =')));

/* ------------------------------------------------------------- the bug */
{
  /*
   * Derived, not listed. Every `setXxx(` inside `payNow` whose panel is
   * rendered below the early return has to be excluded from the guard.
   * `setHandoffStartedAt` is not one of these — it IS the guard's subject —
   * and neither is a setter the render never branches on.
   */
  const setters = [...new Set([...payNow.matchAll(/\bset([A-Z]\w+)\(/g)].map((m) => m[1]))];
  const flags = setters
    .map((s) => s[0].toLowerCase() + s.slice(1))
    .filter((f) => f !== 'handoffStartedAt')
    /*
     * Only the ones the fallthrough render actually branches on.
     *
     * `{flag ?` OR `: flag ?` — the panels are one ternary CHAIN, so only the
     * first branch opens with a brace and every branch after it opens with a
     * colon. Matching just the brace form found `noProvider` and missed
     * `handoffError`, which is the one the original bug was about. The
     * `flags.length >= 2` assertion below is what surfaced that; a check that
     * derives its own inputs needs a floor on how many it derived, or it
     * quietly verifies a subset and reports success.
     */
    .filter((f) => new RegExp(`[{:]\\s*${f}\\s*\\?`).test(pay));

  check(
    'payNow has failure flags the render branches on',
    flags.length >= 2,
    `found [${flags.join(', ')}] from setters [${setters.join(', ')}] — if this is ` +
      `empty the derivation broke and everything below passes vacuously`,
  );

  for (const f of flags) {
    check(
      `awaitingHandoff excludes \`${f}\` — otherwise its panel is unreachable`,
      new RegExp(`!\\s*${f}\\b`).test(guard),
      `guard is: ${guard.replace(/\s+/g, ' ').trim()}\n        ` +
        `\`${f}\` has a panel after the early return, and payNow sets it while ` +
        `resetting handoffStartedAt — so without \`!${f}\` the summary returns first ` +
        `and the panel never renders. That is the original bug, exactly.`,
    );
  }

  check(
    'the early return really does come before those panels',
    pay.indexOf('if (awaitingHandoff') < pay.indexOf('{noProvider ?'),
    'if the ordering ever inverts, this whole file is checking the wrong thing — ' +
      're-read it rather than trusting it',
  );
}

/* -------------------------------------------------- the merged flow */
{
  check(
    'Checkout sends autoStart only when a real handoff is waiting',
    /state:\s*order\.handedOff\s*\?\s*\{\s*autoStart:\s*true\s*\}\s*:\s*undefined/.test(checkout),
    'a simulated payment is already complete and goes to tracking — flagging it ' +
      'would ask the pay screen to open a sheet for money that has already moved',
  );

  check(
    'Pay reads autoStart from router state, not from a prop or storage',
    /useLocation\(\)\.state/.test(pay) && /autoStart/.test(pay),
    'router state is what dies on reload, which is the required lifetime: ' +
      'reopening /pay later must show a button, never a sheet opening by itself',
  );

  const effect = pay.slice(pay.indexOf('if (!autoStart'), pay.indexOf('if (!autoStart') + 400);
  check(
    'the auto-fire waits for the intent before running',
    /!intent\.data/.test(effect) && /\[autoStart, intent\.data/.test(effect),
    'payNow builds its session from intent.data; firing early takes the ' +
      '"no aggregator is wired" branch and reports a missing provider for one ' +
      'that is merely still loading',
  );

  check(
    'the auto-fire is guarded against running twice',
    /fired\.current/.test(payNow),
    'a re-render or a StrictMode double-invoke would otherwise open two checkouts',
  );

  check(
    'awaitingHandoff excludes autoStart, so the skipped screen does not flash',
    /!\s*autoStart\b/.test(guard),
    'the effect runs after first paint, so without this the summary appears for ' +
      'a frame on the way past — which is the screen being removed',
  );
}

/*
 * ---------------------------------------------------------------------------
 * CONTROL
 * ---------------------------------------------------------------------------
 * Everything above is a regex over a slice, so all of it passes against "".
 */
{
  checked++;
  const ok =
    payNow.length > 400 &&
    guard.length > 40 &&
    checkout.length > 1000 &&
    payRaw.length - pay.length > 2000 &&
    pay.includes('const awaitingHandoff');
  if (!ok) failures++;
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'}  control  payNow ${payNow.length} chars, guard ${guard.length} chars, ` +
      `${payRaw.length - pay.length} comment chars stripped`,
  );
}

console.log('\n' + '═'.repeat(78));
console.log(`${checked} assertions, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
