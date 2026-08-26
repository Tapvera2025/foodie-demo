/**
 * The admin client and the API agree — on routes, and on field names.
 *
 * WHY THIS IS A TEST AND NOT A CODE REVIEW
 *
 * Three separate Vite apps talk to one Nest API over hand-written clients.
 * There is no generated SDK, so the client's belief about the server is a
 * duplicate of the truth, and duplicates drift. Both directions of drift fail
 * silently:
 *
 *   a renamed ROUTE    404 at runtime. Typechecks fine — the path is a string.
 *   a renamed FIELD    `undefined` at runtime. Typechecks fine — the client's
 *                      interface is its own declaration, not the server's, so
 *                      it happily promises a field nobody sends.
 *
 * The second is the nastier one. `vendor.fssaiLicence` renamed to
 * `fssai_licence` on the server would render an empty input, save `null`, and
 * put a stall live with no licence recorded — with every typecheck passing.
 *
 * Run: node tests/conformance/client-contract.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

let failures = 0;
let checked = 0;

// ============================================================================
// 1. Routes
// ============================================================================

/** Every `@Controller` prefix + `@Get/@Post/...` path in the API. */
function serverRoutes() {
  const out = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(resolve(root, dir), { withFileTypes: true })) {
      const p = join(dir, name.name);
      if (name.isDirectory()) walk(p);
      else if (p.endsWith('.controller.ts')) {
        const src = read(p);
        const c = src.match(/@Controller\('([^']*)'\)/);
        if (!c) continue;
        /*
         * `@Get()` WITH NO ARGUMENT IS A ROUTE, AND THIS USED TO MISS IT.
         *
         * A bare decorator means "the controller's prefix and nothing more" —
         * idiomatic Nest, and how a collection endpoint is normally written.
         * The old pattern required `('...')`, so `@Controller('api/v1/x')` plus
         * `@Get()` produced no entry at all, and the client's perfectly correct
         * call to `/x` was reported as pointing at a route that does not exist.
         *
         * A false FAILURE, which is the more corrosive direction: the fix that
         * suggests itself is to change the client to match the test, and the
         * client was right.
         */
        for (const m of src.matchAll(/@(Get|Post|Patch|Put|Delete)\((?:'([^']*)')?\)/g)) {
          out.set(`${m[1].toUpperCase()} ${normalise(`${c[1]}/${m[2] ?? ''}`)}`, p);
        }
      }
    }
  };
  walk('src');
  return out;
}

/**
 * `/console/vendors/${id}` and `vendors/:vendorId` reduced to one shape.
 *
 * Both parameter forms collapse to `:x`, because the client's variable name and
 * the server's parameter name have no reason to match and comparing them would
 * produce failures that are not bugs.
 */
function normalise(p) {
  // A query string is not part of the route. `?dryRun=true` is read by the
  // handler from `@Query`, and including it here would make every call with a
  // parameter look like a route that does not exist.
  let s = p.split('?')[0];
  s = s.replace(/\$\{[^}]*\}/g, ':x').replace(/:[A-Za-z]\w*/g, ':x');
  if (!s.startsWith('api/v1') && !s.startsWith('/api')) s = `api/v1/${s.replace(/^\//, '')}`;
  return s.replace(/\/+/g, '/').replace(/\/$/, '');
}

/**
 * Every `request<T>('/path', { method })` in a client, EXPANDED.
 *
 * A path segment interpolated from a union-typed parameter is not one route,
 * it is several — `/kds/orders/${orderId}/${action}` with
 * `action: 'accept' | 'ready' | 'collect'` is three handlers, and the server
 * spells each out literally.
 *
 * Collapsing it to `:x` the way an id is collapsed would pass this check while
 * proving nothing: two of the three could be missing and `:x` would still
 * "match" a route that only exists for the third. So union segments are
 * expanded and EVERY member must resolve.
 *
 * This is exactly the case that made the first version of this file report a
 * false failure, and the fix is stronger than the check it replaced.
 */
function clientCalls(file) {
  const src = read(file);
  const out = [];

  /*
   * SCANNED, NOT PATTERN-MATCHED.
   *
   * Two regex attempts got this wrong in opposite directions, and both failures
   * looked like real bugs in the app:
   *
   *   one character class for ` and '  broke on `?dryRun=${x ? 'true' : 'false'}`
   *                                    — the quote inside the ternary ended the
   *                                    path early
   *   a lazy `\{...\}\s*\)` for opts    matched the inner `})` of
   *                                    `JSON.stringify({ reason })` first, so
   *                                    three quarters of the KDS calls lost
   *                                    their method and defaulted to GET
   *
   * A call argument list is a nesting structure, so it needs a scanner rather
   * than a pattern. Find `request<…>(`, then walk to the matching close paren
   * tracking depth and string state, and parse the slice.
   */
  for (const start of [...src.matchAll(/request<[^>]*>\(/g)]) {
    const from = (start.index ?? 0) + start[0].length;
    let depth = 1;
    let i = from;
    let quote = null;

    while (i < src.length && depth > 0) {
      const c = src[i];
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = null;
      } else if (c === '`' || c === "'" || c === '"') quote = c;
      else if (c === '(' || c === '{') depth++;
      else if (c === ')' || c === '}') depth--;
      i++;
    }

    const call = src.slice(from, i - 1);

    // The path is the first string literal in the argument list.
    const pm = call.match(/^\s*(?:`((?:[^`\\]|\\.)*)`|'((?:[^'\\]|\\.)*)')/);
    if (!pm) continue;
    const path = pm[1] ?? pm[2] ?? '';
    if (!path) continue;

    const verb = call.match(/method:\s*'(\w+)'/)?.[1]?.toUpperCase() ?? 'GET';

    // Any `${name}` whose name is declared as a union of string literals.
    let variants = [path];
    for (const v of path.matchAll(/\$\{(\w+)\}/g)) {
      const decl = src.match(
        new RegExp(`\\b${v[1]}\\s*:\\s*((?:'[\\w-]+'\\s*\\|\\s*)+'[\\w-]+')`),
      );
      if (!decl) continue;
      const members = [...decl[1].matchAll(/'([\w-]+)'/g)].map((x) => x[1]);
      variants = variants.flatMap((p) => members.map((lit) => p.replace(v[0], lit)));
    }

    for (const p of variants) out.push({ verb, path: p, key: `${verb} ${normalise(p)}` });
  }

  return out;
}

const routes = serverRoutes();

console.log('routes — every client call resolves to a handler');
console.log('─'.repeat(78));

for (const client of ['apps/admin/src/api.ts', 'apps/pwa/src/lib/api.ts', 'apps/kds/src/api.ts']) {
  const calls = clientCalls(client);
  const bad = calls.filter((c) => !routes.has(c.key));
  checked += calls.length;

  if (bad.length === 0) {
    console.log(`  ok    ${client.padEnd(28)} ${String(calls.length).padStart(2)} calls, all resolve`);
  } else {
    for (const b of bad) {
      failures++;
      console.log(`  FAIL  ${client}  ${b.verb} ${b.path}\n        no handler for ${b.key}`);
    }
  }
}

// ============================================================================
// 2. Fields
// ============================================================================

/** An interface's fields, following one level of `extends`. */
function fields(src, name, depth = 0) {
  if (depth > 3) return {};
  const m = src.match(new RegExp(`interface ${name}(?:\\s+extends\\s+(\\w+))?\\s*\\{([\\s\\S]*?)\\n\\}`));
  if (!m) return null;

  const own = {};
  for (const raw of m[2].split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
    const f = line.match(/^(?:readonly\s+)?(\w+)\??:\s*(.+?);?$/);
    if (f) own[f[1]] = f[2].trim().replace(/;$/, '');
  }

  return m[1] ? { ...(fields(src, m[1], depth + 1) ?? {}), ...own } : own;
}

/** `Date` becomes a string over JSON; the two status enums are the same set. */
const wire = (t) =>
  t
    .replace(/\bDate\b/g, 'string')
    .replace(/\bVendorStatus\b/g, 'EntityStatus')
    .replace(/readonly /g, '')
    .replace(/\s+/g, '');

const CONTRACTS = [
  ['VendorDetail', 'src/console/vendor.repository.ts', 'apps/admin/src/api.ts'],
  ['VendorSummary', 'src/console/vendor.repository.ts', 'apps/admin/src/api.ts'],
  ['CourtSummary', 'src/console/court.repository.ts', 'apps/admin/src/api.ts'],
  ['CourtDetail', 'src/console/court.repository.ts', 'apps/admin/src/api.ts'],
];

console.log('\nfields — the client never declares something the server does not send');
console.log('─'.repeat(78));

for (const [name, serverFile, clientFile] of CONTRACTS) {
  const server = fields(read(serverFile), name);
  const client = fields(read(clientFile), name);
  checked++;

  if (!server || !client) {
    failures++;
    console.log(`  FAIL  ${name} — could not parse ${!server ? serverFile : clientFile}`);
    continue;
  }

  const problems = [];

  // The dangerous direction. A field the client promises and the server never
  // sends is `undefined` at runtime with a green typecheck.
  for (const k of Object.keys(client)) {
    if (!(k in server)) problems.push(`client declares \`${k}\`, server never sends it`);
    else if (wire(server[k]) !== wire(client[k])) {
      problems.push(`\`${k}\`: server ${server[k]} vs client ${client[k]}`);
    }
  }

  if (problems.length === 0) {
    const extra = Object.keys(server).filter((k) => !(k in client)).length;
    console.log(
      `  ok    ${name.padEnd(16)} ${String(Object.keys(client).length).padStart(2)} fields agree` +
        (extra ? `  (server sends ${extra} more the client ignores — harmless)` : ''),
    );
  } else {
    for (const p of problems) {
      failures++;
      console.log(`  FAIL  ${name}: ${p}`);
    }
  }
}

// ============================================================================
// 2b. Responses built as object LITERALS
// ============================================================================

/**
 * The check above compares two declared interfaces. Half this API does not have
 * one on the server side — the discovery endpoints build their response inline,
 * so `MenuResponse` exists only in the client, as an unverified promise.
 *
 * That is the more dangerous half, not the safer one. `VendorDetail` at least
 * has a repository type someone would have to edit deliberately; the menu
 * response is an object literal a hundred lines long, and dropping a key from
 * it is a one-character deletion that typechecks on both sides and renders as
 * an empty banner.
 *
 * So: every field the client declares must appear as a key somewhere in the
 * handler that answers that route. Weaker than a type comparison — it proves
 * the name is emitted, not that the shape matches — and much stronger than
 * nothing, which is what was here before.
 */
function literalKeys(src, handler) {
  // From `async handler(` to the start of the next method at the same depth.
  const start = src.indexOf(`async ${handler}(`);
  if (start === -1) return null;
  const rest = src.slice(start);
  const end = rest.search(/\n {2}(?:@[A-Z]|\})/);
  const body = end === -1 ? rest : rest.slice(0, end);
  /*
   * TWO FORMS, because `{ vendorId }` is shorthand for `{ vendorId: vendorId }`
   * and the handler uses both. Matching only `name:` reported `vendorId` and
   * `closedReason` as never emitted when they are the first two things it
   * returns — a false failure that would have trained the next person to add a
   * skip-list entry rather than read the check.
   *
   * `name,` on its own line also matches a multi-line call argument, so a local
   * called `now` counts as an emitted key. That is a false PASS confined to
   * fields named after locals, and the alternative — parsing the literal
   * properly — is a JS parser this file does not need.
   */
  return new Set(
    [...body.matchAll(/^\s*(\w+)\s*(?::|,\s*$)/gm)].map((m) => m[1]),
  );
}

const LITERAL_CONTRACTS = [
  // [client interface, client file, server file, handler, fields to skip]
  ['MenuItem', 'apps/pwa/src/lib/api.ts', 'src/tenancy/discovery.controller.ts', 'menu', []],
  ['MenuResponse', 'apps/pwa/src/lib/api.ts', 'src/tenancy/discovery.controller.ts', 'menu', []],
];

console.log('\ninline responses — every client field is a key the handler emits');
console.log('─'.repeat(78));

for (const [name, clientFile, serverFile, handler, skip] of LITERAL_CONTRACTS) {
  const client = fields(read(clientFile), name);
  const keys = literalKeys(read(serverFile), handler);
  checked++;

  if (!client || !keys) {
    failures++;
    console.log(`  FAIL  ${name} — could not parse ${!client ? clientFile : `${serverFile}#${handler}`}`);
    continue;
  }

  // Nested object types are declared inline in the client (`vendor: { … }`), so
  // their inner names have to be pulled out of the type text as well.
  const declared = new Set(Object.keys(client).filter((k) => !skip.includes(k)));
  for (const t of Object.values(client)) {
    if (t.startsWith('{')) for (const m of t.matchAll(/(\w+)\??:/g)) declared.add(m[1]);
  }

  const missing = [...declared].filter((k) => !keys.has(k));
  if (missing.length === 0) {
    console.log(`  ok    ${name.padEnd(14)} ${declared.size} fields all emitted by ${handler}()`);
  } else {
    for (const k of missing) {
      failures++;
      console.log(`  FAIL  ${name}.${k} — client declares it, ${handler}() never emits it`);
    }
  }
}

// ============================================================================
// 2c. One rule, two implementations
// ============================================================================

/**
 * "IS THIS STALL ACCEPTING ORDERS" IS COMPUTED IN TWO PLACES.
 *
 * `discovery.controller.ts` decides whether a stall appears in the customer's
 * carousel. `vendor.repository.ts` decides whether the console tells an
 * operator the banner is showing. They must agree, or the console says "showing
 * now" about something no customer can see — which is the exact confusion that
 * put this check here.
 *
 * Sharing the function would be better and is not free: the console importing
 * from `tenancy/` crosses the boundary this codebase keeps hardest. So they
 * stay separate and this asserts they use the same INPUTS.
 *
 * Inputs, not output. A test that ran both would need a database; a test that
 * compares the source text would fail on whitespace. What actually goes wrong
 * is somebody adding a fifth condition to one copy — a new `holiday_closed`
 * column, say — and that shows up here as an input one file mentions and the
 * other does not.
 */
const ACCEPTING_INPUTS = [
  [/dispatch_blocked_at|dispatchBlockedAt/, 'the escalation block'],
  [/temp_closed_until|tempClosedUntil/, "the kitchen's own pause"],
  [/isOpenAt\(/, 'opening hours'],
  /*
   * `status` IS NOT ON THIS LIST, and that is a finding rather than an omission.
   *
   * The first version included it and reported the customer app as not
   * consulting it. True, and correct: discovery excludes non-ACTIVE stalls in
   * SQL — `.where('status', '=', 'ACTIVE')` — so by the time the expression
   * runs, a suspended stall is not in the array to be judged.
   *
   * The console cannot do that. It deliberately LISTS draft and suspended
   * stalls so an operator can see them and grant a slot before opening day, so
   * it has to test the status inline. Two mechanisms, same outcome, and
   * asserting they use the same one would be asserting something false.
   */
];

console.log('\naccepting-orders — the console and the customer app agree on the inputs');
console.log('─'.repeat(78));

{
  const discovery = read('src/tenancy/discovery.controller.ts');
  const consoleRepo = read('src/console/vendor.repository.ts');

  /*
   * THE DECISION, NOT THE QUERY.
   *
   * The first version of this sliced from the top of each function, which
   * included the SELECT list — so `temp_closed_until` matched because the
   * column was FETCHED, and a seeded `const paused = false` still passed.
   * A check that proves a column is selected proves nothing about whether
   * anybody consulted it.
   *
   * Bounded by explicit markers, so the window is the expression that computes
   * the answer and nothing else.
   */
  const between = (src, from, to) => {
    const a = src.indexOf(from);
    if (a === -1) return '';
    const b = src.indexOf(to, a);
    return src.slice(a, b === -1 ? a : b);
  };

  const a = between(discovery, 'const pausedUntil =', 'return {');
  const b = between(consoleRepo, 'const paused =', 'return {');

  for (const [pattern, what] of ACCEPTING_INPUTS) {
    checked++;
    const inA = pattern.test(a);
    const inB = pattern.test(b);
    if (inA && inB) {
      console.log(`  ok    both consult ${what}`);
    } else {
      failures++;
      console.log(
        `  FAIL  ${what}: customer app ${inA ? 'yes' : 'NO'}, console ${inB ? 'yes' : 'NO'}` +
          ' — one of them will lie about whether a banner is showing',
      );
    }
  }
}

// ============================================================================
// 3. Negative controls
// ============================================================================

console.log('\nnegative controls — both checks must be able to fail');
console.log('─'.repeat(78));

checked++;
if (!routes.has('GET api/v1/console/food-courts/:x/nonexistent')) {
  console.log('  ok    a made-up route is not reported as resolving');
} else {
  failures++;
  console.log('  FAIL  route matcher accepts anything');
}

/**
 * The verbs must actually be read, not defaulted.
 *
 * This is the control that would have caught the bug that produced this file's
 * two false failures. A scanner that silently fell back to GET for every call
 * would still report "all resolve" — because most paths exist under some verb —
 * while proving nothing at all. If the spread of methods collapses to one, the
 * parser has stopped parsing.
 */
checked++;
const verbs = new Set(
  ['apps/admin/src/api.ts', 'apps/pwa/src/lib/api.ts', 'apps/kds/src/api.ts']
    .flatMap((f) => clientCalls(f))
    .map((c) => c.verb),
);
if (verbs.size >= 3 && verbs.has('POST') && verbs.has('PATCH')) {
  console.log(`  ok    methods are being read, not defaulted (${[...verbs].sort().join(', ')})`);
} else {
  failures++;
  console.log(`  FAIL  only saw ${[...verbs].join(', ')} — the method parser has stopped working`);
}

checked++;
const sabotaged = read('apps/admin/src/api.ts').replace(
  'fssaiLicence: string | null;',
  'fssaiLicense: string | null;', // American spelling — a real, plausible typo
);
const sabotagedFields = fields(sabotaged, 'VendorDetail');
const serverFields = fields(read('src/console/vendor.repository.ts'), 'VendorDetail');
if (sabotagedFields && !('fssaiLicense' in serverFields)) {
  console.log('  ok    a misspelt field name would be caught (fssaiLicense vs fssaiLicence)');
} else {
  failures++;
  console.log('  FAIL  field comparison would not catch a misspelt name');
}

console.log('\n' + '═'.repeat(78));
console.log(`${checked} assertions, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
