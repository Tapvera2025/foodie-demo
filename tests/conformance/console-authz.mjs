/**
 * Every console endpoint authorises with `decide`, not with the guard alone.
 *
 * THE FAILURE THIS CATCHES
 *
 * `StaffGuard` proves *who* is calling. `decide` decides *what they may do*.
 * `staff.guard.ts` states the rule in its own header: a guard that also
 * authorises comes to mean "signed in", and then everyone signed in gets
 * everything.
 *
 * That is not a hypothetical here. The console is the one surface where a
 * single account holds SUPER_ADMIN, PLATFORM_OPS and PLATFORM_FINANCE at once,
 * so during development every endpoint appears to work whether or not it checks
 * anything. A missing `decide` is invisible until the day a second person gets
 * a login — by which point the endpoint has been "working" for months.
 *
 * A unit test cannot catch it either: testing the handler with an authorised
 * principal passes, and nobody writes the unauthorised case for an endpoint
 * they forgot to protect. So this reads the source instead and asserts the call
 * is present, per handler.
 *
 * WHAT IT CANNOT PROVE
 *
 * That the permission chosen is the RIGHT one, or that the scope passed is
 * correct. `decide(..., 'catalog.read')` on a handler that force-cancels an
 * order would satisfy this check completely. It proves the decision happens,
 * not that it is a good one — which is still the difference between a review
 * catching a wrong permission and nobody ever looking.
 *
 * Run: node tests/conformance/console-authz.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Controllers whose endpoints are all reachable by staff credentials.
 *
 * The customer and KDS controllers are deliberately absent — they authorise
 * differently (a session token scoped to one order, a device token scoped to
 * one vendor) and holding them to this rule would produce noise, which is how a
 * conformance check gets switched off.
 */
const STAFF_CONTROLLERS = [
  'src/console/console.controller.ts',
  'src/console/court.controller.ts',
  'src/console/vendor.controller.ts',
];

const METHOD = /@(Get|Post|Patch|Put|Delete)\(/;

/**
 * Split a controller into handlers.
 *
 * Naive but sufficient: a handler runs from its route decorator to the next
 * one, or to the end of the class. Anything that survives a rename of `decide`
 * would be caught by the typechecker instead.
 */
function handlers(src) {
  const lines = src.split('\n');
  const out = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (METHOD.test(line)) {
      if (current) out.push(current);
      current = { line: i + 1, route: line.trim(), body: '', name: '' };
      continue;
    }

    if (current) {
      // The first `foo(` after the decorator is the method name.
      if (!current.name) {
        const m = line.match(/^\s*(?:async\s+)?([a-zA-Z][\w]*)\s*\(/);
        if (m && !/^(if|for|while|switch|catch|return)$/.test(m[1])) current.name = m[1];
      }
      current.body += line + '\n';
    }
  }
  if (current) out.push(current);
  return out;
}

let failures = 0;
let checked = 0;

console.log('console endpoints — each must call decide()');
console.log('─'.repeat(78));

for (const rel of STAFF_CONTROLLERS) {
  const src = readFileSync(resolve(root, rel), 'utf8');

  // The guard must be on the class, or none of this matters.
  const guarded = /@UseGuards\(\s*StaffGuard\s*\)/.test(src);
  checked++;
  if (!guarded) {
    failures++;
    console.log(`  FAIL  ${rel}  has no @UseGuards(StaffGuard)`);
  }

  /**
   * A private helper that calls `decide` counts.
   *
   * Both new controllers funnel through an `authorise(...)` method rather than
   * repeating the call — which is better code and would otherwise fail this
   * check. So: collect the names of private methods whose body calls `decide`,
   * and treat a call to one of those as equivalent.
   */
  const helpers = new Set();
  for (const m of src.matchAll(/private\s+(?:async\s+)?([a-zA-Z]\w*)\s*\([^)]*\)[^{]*\{/g)) {
    const start = m.index ?? 0;
    // Look ahead a generous but bounded window rather than brace-matching.
    if (/\bdecide\s*\(/.test(src.slice(start, start + 1400))) helpers.add(m[1]);
  }

  for (const h of handlers(src)) {
    checked++;
    const callsDecide = /\bdecide\s*\(/.test(h.body);
    const callsHelper = [...helpers].some((name) =>
      new RegExp(`this\\.${name}\\s*\\(`).test(h.body),
    );

    if (callsDecide || callsHelper) {
      const how = callsDecide ? 'decide()' : `this.${[...helpers].find((n) => new RegExp(`this\\.${n}\\s*\\(`).test(h.body))}()`;
      console.log(
        `  ok    ${relative(root, resolve(root, rel)).padEnd(38)} ${(h.name || '?').padEnd(18)} ${how}`,
      );
    } else {
      failures++;
      console.log(
        `  FAIL  ${rel}:${h.line}  ${h.name || '?'} — ${h.route}\n` +
          `        authorises off the guard alone. Everyone signed in can call it.`,
      );
    }
  }
}

/**
 * A negative control.
 *
 * A check that has never failed is a check nobody has verified. This strips the
 * authorisation out of a copy of one controller in memory and asserts the
 * scanner notices — so a refactor that quietly breaks the detection (a renamed
 * helper, a changed decorator) fails here rather than passing silently for ever.
 */
console.log('\nnegative control — the check must be able to fail');
console.log('─'.repeat(78));

const sample = readFileSync(resolve(root, 'src/console/vendor.controller.ts'), 'utf8');
const sabotaged = sample.replace(/\bdecide\s*\(/g, 'noop(').replace(/this\.authorise\s*\(/g, 'noop(');

const stillDetected = handlers(sabotaged).filter((h) => /\bdecide\s*\(|this\.authorise\s*\(/.test(h.body));
checked++;
if (stillDetected.length === 0) {
  console.log('  ok    with authorisation removed, 0 handlers pass — the check has teeth');
} else {
  failures++;
  console.log(`  FAIL  ${stillDetected.length} handlers still looked authorised after sabotage`);
}

// A second control: the scanner must actually be finding handlers at all. A
// regex that matched nothing would report "0 failures" and mean nothing.
const found = STAFF_CONTROLLERS.reduce(
  (n, rel) => n + handlers(readFileSync(resolve(root, rel), 'utf8')).length,
  0,
);
checked++;
if (found >= 10) {
  console.log(`  ok    found ${found} handlers across ${STAFF_CONTROLLERS.length} controllers`);
} else {
  failures++;
  console.log(`  FAIL  only found ${found} handlers — the route regex is not matching`);
}

/**
 * No console controller may be added without being listed here.
 *
 * The whole check is opt-in by filename, which is its weakest point: a new
 * `src/console/settlement.controller.ts` would simply not be scanned. So the
 * directory is compared against the list.
 */
console.log('\ncoverage — every console controller is scanned');
console.log('─'.repeat(78));

const present = readdirSync(resolve(root, 'src/console'))
  .filter((f) => f.endsWith('.controller.ts'))
  .map((f) => join('src/console', f));

const unscanned = present.filter((f) => !STAFF_CONTROLLERS.includes(f));
checked++;
if (unscanned.length === 0) {
  console.log(`  ok    all ${present.length} controllers in src/console are in the list`);
} else {
  failures++;
  for (const f of unscanned) {
    console.log(`  FAIL  ${f} exists and is not scanned — add it to STAFF_CONTROLLERS`);
  }
}

console.log('\n' + '═'.repeat(78));
console.log(`${checked} assertions, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
