/**
 * ============================================================================
 * AI DESCRIPTIONS — THE SHAPER, THE METER, AND THE SECRETS
 * ============================================================================
 *
 * Three things are worth pinning here, and they fail in three different ways.
 *
 * 1. `shape()` is the only thing between a language model and a live customer
 *    menu. If it lets `Here is a description:` through, that goes on a menu
 *    board in a food court. It is pure, so it is tested directly.
 *
 * 2. The credit arithmetic decides whether the platform pays for a third
 *    generation on a two-credit grant. The SQL half needs a database, but the
 *    rule that governs it — which outcomes count — is a constant this asserts
 *    against the controller's own source, so the two cannot drift.
 *
 * 3. The API keys must not be in the repository. That is not a style
 *    preference: they were pasted into a chat transcript, and the difference
 *    between "in a gitignored .env" and "committed" is the difference between
 *    rotating a key at leisure and rotating it under pressure.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative } from 'node:path';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register(
  'data:text/javascript,export async function resolve(s,c,n){return n(s.replace(/\\.js$/,".ts"),c)}',
  pathToFileURL('./'),
);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { shape } = await import('../../src/catalog/describe.shape.ts');

let checked = 0;
let failures = 0;

function check(name, ok, detail) {
  checked++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.git' || e === 'dist' || e === 'coverage') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const GOOD =
  'Soft paneer simmered in a smooth tomato gravy, finished with cream and a little kasuri methi.';

console.log('\nai descriptions — shaping model output');
console.log('─'.repeat(78));

check('a clean sentence passes through unchanged', shape(GOOD) === GOOD);

check(
  'a preamble is removed',
  shape(`Here is a description: ${GOOD}`) === GOOD,
  JSON.stringify(shape(`Here is a description: ${GOOD}`)),
);

check(
  'wrapping straight quotes are removed',
  shape(`"${GOOD}"`) === GOOD,
  JSON.stringify(shape(`"${GOOD}"`)),
);

check(
  'wrapping curly quotes are removed',
  shape(`“${GOOD}”`) === GOOD,
  JSON.stringify(shape(`“${GOOD}”`)),
);

check(
  'markdown emphasis is stripped',
  shape(`**Paneer** simmered in a smooth tomato gravy, finished with cream and methi.`) ===
    'Paneer simmered in a smooth tomato gravy, finished with cream and methi.',
  JSON.stringify(shape('**Paneer** simmered in a smooth tomato gravy, finished with cream and methi.')),
);

check(
  'only the first sentence survives',
  shape(`${GOOD} It pairs beautifully with naan. Order it hot.`) === GOOD,
  JSON.stringify(shape(`${GOOD} It pairs beautifully with naan. Order it hot.`)),
);

check(
  'an abbreviation is not treated as a sentence end',
  (shape('Served with Rs. 0 extra chutney and a generous helping of fresh green salad.') ?? '')
    .includes('chutney'),
  JSON.stringify(shape('Served with Rs. 0 extra chutney and a generous helping of fresh green salad.')),
);

check('newlines collapse to single spaces', !(shape(`Soft paneer\n\nin gravy with cream and methi.`) ?? '').includes('\n'));

/*
 * The rejections. Each of these returns null, which makes the caller fall
 * through to the other provider — a better outcome than any of them on a menu.
 */
check('empty input is rejected', shape('') === null);
check('null input is rejected', shape(null) === null);
check('whitespace is rejected', shape('   \n  ') === null);
check(
  'a refusal is rejected rather than published',
  shape('I cannot help with that.') === null,
  JSON.stringify(shape('I cannot help with that.')),
);
check(
  'a stub too short to be a description is rejected',
  shape('Delicious paneer dish.') === null,
  JSON.stringify(shape('Delicious paneer dish.')),
);

/* The ceiling truncates rather than rejecting: a long answer contains a good one. */
{
  const long = Array.from({ length: 90 }, (_, i) => `word${i}`).join(' ');
  const out = shape(long) ?? '';
  const words = out.split(' ').length;
  check(
    'an over-long answer is truncated on a word boundary and closed',
    words === 45 && out.endsWith('.') && !out.includes('  '),
    `got ${words} words, ends "${out.slice(-12)}"`,
  );
}

check(
  'output never exceeds the database column bound',
  (shape('a '.repeat(600)) ?? '').length <= 500,
);

console.log('\nai descriptions — what a credit is spent on');
console.log('─'.repeat(78));

/*
 * The controller's rule, read out of the controller.
 *
 * Asserting `['OK','PENDING']` as a literal here would be a copy that agrees
 * with itself for ever. Reading the constant out of the source means the test
 * fails if somebody adds a charged outcome, which is when a human should look.
 */
const controllerSrc = readFileSync(join(root, 'src/catalog/describe.controller.ts'), 'utf8');
const chargedDecl = /const CHARGED_OUTCOMES = \[([^\]]*)\]/.exec(controllerSrc);
const charged = (chargedDecl?.[1] ?? '')
  .split(',')
  .map((s) => s.trim().replace(/^'|'$/g, ''))
  .filter(Boolean);

check(
  'exactly OK and PENDING are charged',
  charged.length === 2 && charged.includes('OK') && charged.includes('PENDING'),
  `found [${charged.join(', ')}] — a new charged outcome needs a human to confirm it is intended`,
);

check(
  'a failed generation is NOT charged',
  !charged.includes('ALL_PROVIDERS_FAILED') &&
    !charged.includes('ERROR') &&
    !charged.includes('TIMEOUT') &&
    !charged.includes('EMPTY'),
  `[${charged.join(', ')}] contains a failure outcome — stalls would lose credits to outages`,
);

check(
  'PENDING is charged, which is what stops a double-spend',
  charged.includes('PENDING'),
  'without it, two concurrent taps both count zero rows and both proceed',
);

check(
  'the balance is read under a row lock',
  /\.forUpdate\(\)/.test(controllerSrc),
  'no forUpdate() in the controller — the count-then-insert is a race',
);

check(
  'the credit is reserved before the model is called',
  controllerSrc.indexOf('.insertInto(\'ai_generation\')') < controllerSrc.indexOf('await describeDish('),
  'describeDish() runs before the reservation — two tabs could both spend the last credit',
);

/*
 * "Inside the transaction" is a question about nesting, so it needs a brace
 * match, not a regex.
 *
 * The first version of this check was
 *
 *     /transaction\(\)[\s\S]*?await describeDish\(/
 *
 * and it failed against correct code. A lazy wildcard cannot tell "inside the
 * callback" from "on the line after it closes" — both are just text between
 * two anchors. It reported a bug that was not there, which is the more
 * expensive kind of wrong: a real one costs a fix, a false one costs the trust
 * that makes anybody read the output at all.
 */
function bodyOf(src, opener) {
  const at = src.indexOf(opener);
  if (at === -1) return null;
  let depth = 0;
  let i = src.indexOf('{', at);
  if (i === -1) return null;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) return src.slice(i, j + 1);
    }
  }
  return null;
}

{
  const txBody = bodyOf(controllerSrc, 'this.db.transaction().execute(');
  const ok = txBody !== null && !txBody.includes('describeDish(');
  check(
    'the provider call is NOT inside the transaction',
    ok,
    txBody === null
      ? 'could not find the transaction body — the brace matcher is broken'
      : 'a multi-second HTTP call inside a transaction pins a connection and a lock',
  );

  /* And prove the matcher can actually see inside, or the above is vacuous. */
  check(
    'the brace matcher really reads the transaction body',
    txBody !== null && txBody.includes('forUpdate()') && txBody.includes("insertInto('ai_generation')"),
    txBody === null ? 'null body' : `body was ${txBody.length} chars and missing the reservation`,
  );
}

console.log('\nai descriptions — the keys are not in the repository');
console.log('─'.repeat(78));

/*
 * Patterns for the two providers' key formats. Deliberately matching the SHAPE
 * rather than the specific strings, so this also catches the next key somebody
 * pastes into a file.
 */
const SECRET_PATTERNS = [
  { name: 'x.ai key', re: /\bxai-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenRouter key', re: /\bsk-or-v1-[A-Za-z0-9]{20,}/ },
  { name: 'OpenAI-style key', re: /\bsk-[A-Za-z0-9]{32,}/ },
];

{
  const offenders = [];
  for (const file of walk(root)) {
    const rel = relative(root, file);
    // `.env` is the one place a real key belongs, and it is gitignored.
    if (rel === '.env' || rel.startsWith('.env.')) continue;
    if (rel.startsWith('tests/conformance/ai-descriptions.mjs')) continue;
    if (/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|pdf|zip)$/i.test(rel)) continue;

    let src;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const p of SECRET_PATTERNS) {
      if (p.re.test(src)) offenders.push(`${rel} (${p.name})`);
    }
  }

  check(
    'no provider API key literal anywhere outside .env',
    offenders.length === 0,
    offenders.join('\n        '),
  );
}

check(
  '.env is gitignored',
  readFileSync(join(root, '.gitignore'), 'utf8')
    .split('\n')
    .some((l) => l.trim() === '.env'),
);

{
  const examplePath = join(root, '.env.example');
  const example = existsSync(examplePath) ? readFileSync(examplePath, 'utf8') : '';
  check(
    '.env.example names both keys and holds neither',
    example.includes('XAI_API_KEY=') &&
      example.includes('OPENROUTER_API_KEY=') &&
      !SECRET_PATTERNS.some((p) => p.re.test(example)),
  );
}

/*
 * The keys must not reach a browser. Anything under `apps/` is bundled and
 * shipped, so a reference to either variable there is a leak by construction —
 * Vite would inline it if it were prefixed, and a developer reaching for it is
 * the moment to stop them.
 */
{
  const leaked = [];
  for (const app of ['apps/pwa/src', 'apps/kds/src', 'apps/admin/src']) {
    const dir = join(root, app);
    if (!existsSync(dir)) continue;
    for (const file of walk(dir)) {
      const src = readFileSync(file, 'utf8');
      if (/XAI_API_KEY|OPENROUTER_API_KEY/.test(src)) leaked.push(relative(root, file));
    }
  }
  check(
    'no client bundle references either key variable',
    leaked.length === 0,
    leaked.join(', '),
  );
}

/* And the server must not log them. */
{
  const providerSrc = readFileSync(join(root, 'src/catalog/describe.provider.ts'), 'utf8');
  const logCalls = [...providerSrc.matchAll(/log\(\)\.(?:info|warn|error)\(\s*\{([^}]*)\}/g)].map(
    (m) => m[1],
  );
  const logsKey = logCalls.some((c) => /apiKey|API_KEY|Authorization/.test(c));
  check(
    'the provider logs no key material',
    !logsKey && logCalls.length > 0,
    logCalls.length === 0 ? 'no log calls found — the parser is broken' : logCalls.join(' | '),
  );
}

console.log('\n' + '═'.repeat(78));
console.log(`${checked} assertions, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
