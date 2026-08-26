/**
 * ============================================================================
 * THE PROGRESS RAIL AGREES WITH THE HEADLINE ABOVE IT
 * ============================================================================
 *
 * Written against a real bug. A COLLECTED order showed:
 *
 *     Collected
 *     Enjoy your food.
 *     [✓]───[✓]───[✓]───[●]        <- the last dot RED, labelled READY
 *
 * `stepIndex` collapsed READY and COLLECTED onto the same index, so a finished
 * order sat on a node that was still "in progress" forever. The words said the
 * food was in your hands; the rail said the counter was still waiting for you.
 * People read the rail first, so the rail won.
 *
 * Nothing threw and nothing was misaligned — two correct pieces disagreed about
 * what a status means. That is the class of bug this file is for, and it is not
 * reachable by typechecking: every index involved was a valid number.
 *
 * ----------------------------------------------------------------------------
 * WHY SOURCE INSPECTION RATHER THAN RENDERING
 * ----------------------------------------------------------------------------
 *
 * Track.tsx cannot be imported here — it pulls in React, the router, the query
 * client and the API module, so a test of four lines of arithmetic would need
 * the whole app booted. The three facts that were wrong are all decidable from
 * the text, so the text is what is read, and a control at the bottom proves the
 * file was really parsed rather than silently missed.
 *
 * Run: node tests/conformance/track-rail.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

// Shared, because this exact bug was written three times. See _source.mjs.
import { stripComments } from './_source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const REL = 'apps/pwa/src/screens/Track.tsx';
const raw = readFileSync(join(ROOT, REL), 'utf8');


const src = stripComments(raw);

let checked = 0;
let failures = 0;

function check(name, ok, detail) {
  checked++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
}

console.log('\ntrack rail — the steps, the statuses and the geometry must agree');
console.log('─'.repeat(78));

/* ------------------------------------------------------------ parse STEPS */

const stepsBlock = src.slice(src.indexOf('const STEPS = ['), src.indexOf('] as const;'));
const labels = [...stepsBlock.matchAll(/label:\s*'([^']+)'/g)].map((m) => m[1]);

/*
 * Every status the switch names, paired with the index it returns. Cases fall
 * through, so a `case` with no `return` under it belongs to the next one — the
 * reduce below carries labels forward until a return is seen. Getting this
 * wrong in the obvious way (assume one case per return) would silently drop
 * PAYMENT_CONFIRMED, ACKNOWLEDGED and CREATED, which is most of the journey.
 */
const fn = src.slice(src.indexOf('function stepIndex'), src.indexOf('const TERMINAL'));
const mapping = new Map();
{
  let pending = [];
  for (const line of fn.split('\n')) {
    const c = /case\s+'([A-Z_]+)':/.exec(line);
    if (c) pending.push(c[1]);
    const r = /return\s+(\d+);/.exec(line);
    if (r && pending.length > 0) {
      for (const s of pending) mapping.set(s, Number(r[1]));
      pending = [];
    }
  }
}

/* --------------------------------------------------------------- the bug */

check(
  'COLLECTED has a step of its own',
  labels.includes('Collected'),
  `steps are [${labels.join(', ')}] — a collected order has to land somewhere ` +
    `that is not "Ready", or the rail contradicts the headline`,
);

check(
  'COLLECTED maps to the LAST step, not to READY',
  mapping.get('COLLECTED') === labels.length - 1,
  `COLLECTED -> ${mapping.get('COLLECTED')}, READY -> ${mapping.get('READY')}, ` +
    `last index is ${labels.length - 1}. Equal to READY is the original bug.`,
);

check(
  'READY is still its own step — collection is a separate event',
  mapping.get('READY') === mapping.get('COLLECTED') - 1,
  'food waiting at a counter and food picked up are different situations for ' +
    'the person holding the phone',
);

/*
 * The tone rules moved from two `const` lines into the `toneAt` callback the
 * shared `Rail` takes. Same two facts, so the same two checks — read from the
 * callback the ORDER PROGRESS rail passes, not from anywhere in the file, or
 * the rejected rail's callback below could satisfy them by accident.
 */
const orderToneAt = (() => {
  const at = src.indexOf('ariaLabel="Order progress"');
  return at === -1 ? '' : src.slice(at, src.indexOf('/>', src.indexOf('toneAt', at)) + 2);
})();

check(
  'a collected order paints every node done',
  /i < current \|\| collected/.test(orderToneAt) && /return 'done'/.test(orderToneAt),
  'the final tick is the point — `i < current` alone leaves the last node blank',
);

check(
  'a collected order paints NO active (red) node',
  /if \(i < current \|\| collected\) return 'done';/.test(orderToneAt) &&
    orderToneAt.indexOf("return 'done'") < orderToneAt.indexOf("return 'active'"),
  'the collected case has to be decided BEFORE `i === current`, or the last ' +
    'node stays red — which is exactly what the screenshot showed',
);

/* ------------------------------------------------- no index can fall off */

check(
  'every mapped status is a real step index',
  [...mapping.values()].every((i) => Number.isInteger(i) && i >= 0 && i < labels.length),
  `STEPS has ${labels.length} entries; mapped indices are ` +
    `[${[...new Set(mapping.values())].sort().join(', ')}]. The headline reads ` +
    `STEPS[current]!.headline unconditionally, so an out-of-range index is a ` +
    `white screen rather than a wrong label.`,
);

/*
 * THIS CHECK USED TO ASSERT THE BUG.
 *
 * It required `default: return 0`, on the reasoning that a status the switch
 * does not name must not crash the screen. True, and the remedy was wrong: it
 * meant DISPATCH_FAILED, REFUNDED and anything added server-side afterwards
 * rendered as "RECEIVED", with a red dot and "you can put your phone away"
 * underneath. A customer whose order never reached the kitchen was told it had
 * been received.
 *
 * Not crashing and being right are different requirements, and step zero
 * satisfied only the first. The switch returns `null` now, and the caller has
 * to decide — which TypeScript enforces at four call sites.
 */
check(
  'an unknown status returns null, not step zero',
  /default:[\s\S]{0,400}?return null;/.test(fn) && !/default:[\s\S]{0,200}?return 0;/.test(fn),
  'falling back to 0 makes the rail assert "Received" for a status it cannot ' +
    'place — a confident wrong answer in the largest element on the page',
);

check(
  'the forward rail is not rendered when the status cannot be placed',
  /current === null \? null : \(/.test(src),
  'a null index reaching the rail is a rail drawn at step zero again, by ' +
    'another route',
);

check(
  'the headline is gated on a placeable step too',
  /current !== null &&/.test(src),
  '`STEPS[current]!.headline` with a null index is `undefined.headline` — a ' +
    'white screen rather than a wrong label',
);

/* ------------------------ EVERY SERVER STATUS IS HANDLED SOMEWHERE */
/*
 * ============================================================================
 * THE CHECK THAT WOULD HAVE ENDED THIS ON THE FIRST SCREENSHOT
 * ============================================================================
 *
 * `OrderStatus` in the server schema has seventeen members. This screen knew
 * about fourteen. The three it had never heard of were REFUND_PENDING,
 * REFUND_FAILED and RECONCILIATION_REQUIRED — and REFUND_PENDING is not an
 * edge case, it is where EVERY rejected order lands within seconds:
 *
 *     REJECTED -> REFUND_PENDING -> REFUNDED
 *
 * So the toast fired on REJECTED, the order moved on, and the screen fell out
 * of every branch it had. It cost several rounds of screenshots, two wrong
 * diagnoses of mine, and a footer that said "This order keeps cooking" over an
 * order nobody was making.
 *
 * Nothing could catch it, because "handled" was spread across a switch, three
 * Sets and a handful of `===` comparisons, and no two of them had to agree
 * with the server about anything.
 *
 * This reads `OrderStatus` from the SERVER and requires each member to appear
 * somewhere in this screen. It is deliberately not clever about WHERE — it
 * cannot tell a good branch from a bad one — but it can tell that a status was
 * never considered at all, which is the failure that actually happened.
 */
{
  const schema = readFileSync(join(ROOT, 'src/platform/schema.ts'), 'utf8');
  const block = schema.slice(
    schema.indexOf('export type OrderStatus'),
    schema.indexOf(';', schema.indexOf('export type OrderStatus')),
  );
  const serverStatuses = [...block.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);

  check(
    'the server OrderStatus union was parsed',
    serverStatuses.length >= 12,
    `found ${serverStatuses.length} — the parse broke and the check below is vacuous`,
  );

  const unhandled = serverStatuses.filter((st) => !src.includes(`'${st}'`));

  check(
    `all ${serverStatuses.length} server order statuses are named in this screen`,
    unhandled.length === 0,
    `never mentioned: ${unhandled.join(', ')}\n        ` +
      `A status the screen does not name renders as whatever the fallbacks do ` +
      `— which is how REFUND_PENDING produced an empty card under a footer ` +
      `reading "This order keeps cooking".`,
  );

  check(
    'the refund lifecycle counts as "not being made"',
    /NOT_BEING_MADE[\s\S]{0,200}REFUND_PENDING/.test(src),
    'REJECTED alone is two statuses out of five; the order leaves it within ' +
      'seconds and the rejected rail has to follow it',
  );

  check(
    'REFUND_PENDING does NOT stop the polling',
    !/TERMINAL = new Set\(\[[\s\S]{0,200}REFUND_PENDING/.test(src),
    'a refund in flight is the one thing still moving on this screen, and it ' +
      'is what the customer is waiting on',
  );
}

/* ------------------------------------------------------------- geometry */
/*
 * THESE NUMBERS USED TO BE WRITTEN DOWN, AND THAT WAS THE HAZARD.
 *
 * The rail hard-coded `w-1/5`, `left-[10%] right-[10%]` and a fill of `* 80`.
 * Three values that must agree, with nothing but a comment saying so — and the
 * comment explicitly warned that changing the step count meant revisiting all
 * three by hand. Adding a second, three-step rail is precisely the change that
 * warning was about.
 *
 * They are now derived inside `Rail` from `steps.length`, so this no longer
 * checks that three literals match a step count. It checks that no literal is
 * there to go stale: the inset is half a column, the span is the remainder,
 * and the fill uses that same span.
 */
{
  const rail = src.slice(src.indexOf('function Rail('), src.indexOf('export function Track'));

  check(
    'the rail was found and is a real function body',
    rail.length > 400,
    `sliced ${rail.length} chars — every geometry check below would pass vacuously`,
  );

  check(
    'the track inset is half a column, derived from the step count',
    /const half = 100 \/ n \/ 2/.test(rail),
    'a literal percentage here is what has to be revisited by hand every time ' +
      'a step is added to either rail',
  );

  check(
    'the span is the track minus both insets',
    /const span = 100 - 2 \* half/.test(rail),
    'the coloured fill and the grey track must cover the same distance, or a ' +
      'finished rail stops short of its last dot',
  );

  check(
    'the fill width is computed from that span, not a literal',
    /\* span/.test(rail) && !/\* 80\b/.test(rail),
    'a hard-coded 80 is correct for five steps and wrong for three',
  );

  check(
    'each column is 100/n wide, not a Tailwind fraction',
    /width: `\$\{100 \/ n\}%`/.test(rail) && !/w-1\/\d/.test(rail),
    '`w-1/5` cannot be generated from a computed value, and a fixed one is ' +
      'wrong for whichever rail it was not written for',
  );

  check(
    'the fill is clamped, so a bad index cannot overshoot the track',
    /Math\.max\(0, Math\.min\(fillTo, n - 1\)\)/.test(rail),
    'an out-of-range index would paint the line past its last dot',
  );
}

/* --------------------------------------- the rejected journey has a rail */
/*
 * The second rail, added because a rejected order used to lose the rail
 * entirely — the refund card replaced it, which removed the one element
 * orienting the customer at the moment they most needed orienting.
 */
{
  const rejectedSteps = /const REJECTED_STEPS = \[([^\]]*)\]/.exec(src)?.[1] ?? '';
  const names = [...rejectedSteps.matchAll(/'([^']+)'/g)].map((m) => m[1]);

  check(
    'the rejected rail is Received -> Rejected -> Refunded',
    names.length === 3 && names[0] === 'Received' && names[2] === 'Refunded',
    `got [${names.join(', ')}] — the third step is what the customer is actually ` +
      `waiting on once the food is off the table`,
  );

  check(
    'a cancelled order gets its own middle label',
    /const CANCELLED_STEPS = \[[^\]]*'Cancelled'/.test(src),
    'telling somebody the kitchen REJECTED an order they cancelled themselves ' +
      'is a different and worse sentence',
  );

  const refundToneAt = (() => {
    const at = src.indexOf('ariaLabel="Refund progress"');
    return at === -1 ? '' : src.slice(at, src.indexOf('/>', src.indexOf('toneAt', at)) + 2);
  })();

  check(
    'the refund rail callback was found',
    refundToneAt.length > 200,
    `sliced ${refundToneAt.length} chars — the two checks below prove nothing otherwise`,
  );

  check(
    "the rejection node is 'bad', never 'done'",
    /if \(i === 1\) return 'bad';/.test(refundToneAt),
    'a green tick on the rejection would say it went well',
  );

  /*
   * SCOPED TO THE REFUND BRANCH, and the first version was not.
   *
   * It compared `indexOf("'FAILED'")` against `indexOf("return 'done'")` across
   * the whole callback — and the FIRST `return 'done'` is the one for node
   * zero, which sits above the refund logic entirely. So the check failed
   * against correct code, on an ordering that was never in question.
   *
   * The real property is local: within the part that reads `o.refund`, FAILED
   * must be decided before SUCCEEDED.
   */
  const refundBranch = refundToneAt.slice(refundToneAt.indexOf('!o.refund'));

  check(
    "a FAILED refund is 'bad', never 'done'",
    /'FAILED'\) return 'bad'/.test(refundBranch) &&
      refundBranch.indexOf("'FAILED'") < refundBranch.indexOf("return 'done'"),
    'a refund that could not be made automatically needs a human. A tick there ' +
      'tells somebody their money is back when it is not, which is the worst ' +
      'thing this rail could say.',
  );
}

/* --------------------------------------------------- one source of truth */

check(
  'the headline is not duplicated outside STEPS',
  !/collected \? 'Collected'/.test(src),
  "a `collected ? 'Collected' : STEPS[…]` branch means two places define what a " +
    'collected order says, and only one of them gets edited next time',
);

/* -------------------------------------------------------------- labels */
/*
 * The fifth column cut each label's box from ~72px to ~57px on a 360px screen.
 * Exact text width is not knowable here — it depends on the rendered font — so
 * this checks the two things that ARE decidable and that together make a wrap
 * survivable: the labels are short, and they are forbidden to wrap at all.
 */
{
  const longest = labels.reduce((a, b) => (a.length >= b.length ? a : b), '');
  check(
    'no label exceeds 9 characters',
    longest.length <= 9,
    `"${longest}" is ${longest.length} characters; past 9 it overruns its column ` +
      `at 9px uppercase and the rail goes ragged`,
  );

  check(
    'labels are forbidden to wrap',
    /whitespace-nowrap/.test(
      src.slice(src.indexOf('function Rail('), src.indexOf('export function Track')),
    ),
    'overlapping neighbours by a hair is a far better failure than one label ' +
      'wrapping to two lines while "READY" stays on one',
  );
}

/*
 * ---------------------------------------------------------------------------
 * CONTROL
 * ---------------------------------------------------------------------------
 * Every assertion above is a regex or a slice, so all of them pass against an
 * empty string. This proves the parsing actually found what it claims to —
 * without it, deleting Track.tsx's rail entirely would turn this file green.
 */
{
  checked++;
  const stripped = raw.length - src.length;
  const ok =
    src.length > 5000 &&
    labels.length >= 4 &&
    mapping.size >= 6 &&
    mapping.has('COLLECTED') &&
    mapping.has('READY') &&
    // Both rails, addressed by the prop the shared component takes. This was
    // `aria-label="Order progress"` — the raw attribute — and stopped being
    // true the moment the rail became a component; the control caught it,
    // which is the one job a control has.
    src.includes('ariaLabel="Order progress"') &&
    src.includes('ariaLabel="Refund progress"') &&
    src.includes('function Rail(') &&
    // Comments really were removed, and code really was not. This file is
    // heavily commented; if the stripper ever matched nothing the checks would
    // silently go back to reading prose.
    stripped > 2000 &&
    src.includes('const STEPS = [') &&
    src.includes('function stepIndex');
  if (!ok) failures++;
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'}  control  ${REL} parsed: ` +
      `${labels.length} steps, ${mapping.size} statuses mapped, both rails present, ` +
      `${stripped} comment chars stripped`,
  );
  if (!ok) {
    console.log(`        labels=[${labels.join(', ')}]`);
    console.log(`        statuses=[${[...mapping.keys()].join(', ')}]`);
  }
}

console.log('\n' + '═'.repeat(78));
console.log(`${checked} assertions, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
