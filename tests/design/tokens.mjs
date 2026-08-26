/**
 * Every colour utility used in the apps resolves to a token that exists.
 *
 * WHY THIS IS NOT PARANOIA
 *
 * A misspelt Tailwind class is the quietest bug in this stack. `bg-surace`
 * does not error, does not warn, and does not typecheck — Tailwind simply
 * generates nothing, the element inherits whatever is behind it, and the page
 * still renders. On a light theme a missing background is invisible, because
 * the page underneath is already pale. It shows up for the first time in dark
 * mode, as one card that is the wrong colour.
 *
 * This whole redesign renamed most of the colour vocabulary — `bg-white` to
 * `bg-surface`, `bg-brand-500` to `bg-brand-fill`, four status colours to four
 * banner tokens — across nine screens. That is exactly the change that leaves
 * one straggler behind.
 *
 * Run: node tests/design/tokens.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Utilities that take a colour. Prefix → the CSS property it would set. */
const COLOUR_PREFIXES = [
  'bg',
  'text',
  'border',
  'ring',
  'divide',
  'outline',
  'from',
  'to',
  'via',
  'fill',
  'stroke',
  'accent',
  'caret',
  'shadow',
  'decoration',
  'placeholder',
];

/**
 * Names that are Tailwind's, not ours.
 *
 * Kept SHORT on purpose. Every entry here is a colour that does not follow the
 * theme, so each one is a small decision to opt out of dark mode — `text-white`
 * on a fixed-colour gradient is fine, `text-white` on a card is the bug this
 * file exists to catch. A long allow-list would defeat the check.
 */
const BUILT_IN = new Set([
  'white', // on the FoodTile gradient and the fixed-colour veg pill
  'black', // hover scrims: `hover:bg-black/10`
  'transparent',
  'current',
  'inherit',
  'none',
]);

/** Non-colour values that share a prefix with a colour utility. */
const NOT_COLOURS = new Set([
  // text-*
  'left', 'right', 'center', 'justify', 'start', 'end', 'wrap', 'nowrap',
  'balance', 'pretty', 'ellipsis', 'clip', 'xs', 'sm', 'base', 'lg', 'xl',
  '2xl', '3xl', '4xl', '5xl', '6xl',
  // border-*
  'solid', 'dashed', 'dotted', 'double', 'hidden', 'collapse', 'separate',
  't', 'r', 'b', 'l', 'x', 'y', 's', 'e',
  // shadow-*
  'inner',
  // ring-*
  'offset',
  // decoration-*
  'underline', 'overline', 'slice', 'clone',
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(p)) out.push(p);
  }
  return out;
}

/**
 * SHARED BY EVERY CHECK BELOW, AND DECLARED UP HERE ON PURPOSE.
 *
 * These lived beside the first check that needed them, which put them BELOW
 * a later check that also needed them — and `const` is not hoisted, so the
 * file threw a temporal-dead-zone error the moment the second one ran. The
 * suite reported nothing at all rather than a failure, which is the worst
 * outcome a test file has.
 */
const CLASS_ATTR = /className=(?:\{`|")((?:[^"`\\]|\\.)*?)(?:`\}|")/gs;

/**
 * Comments out, before anything is matched.
 *
 * Every doc-comment in this codebase quotes the classes it is explaining, so a
 * check that reads raw source reports its own documentation as a violation —
 * which is what the first run of the rule below did, on the comment that says
 * `className="glass-hover"` while explaining why not to write it.
 *
 * Sniffing whether a LINE starts with a comment marker is not enough: JSX
 * comments open with `{​/*`, and a comment's second line starts with prose.
 *
 * Line comments are anchored to the start of the line on purpose, so that a
 * `https://` inside a string is not mistaken for one.
 */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/** Theme tokens declared in a stylesheet, as bare names (`brand-fill`, ...). */
function themeTokens(cssPath) {
  const css = readFileSync(cssPath, 'utf8');
  const names = new Set();
  for (const m of css.matchAll(/--color-([a-z0-9-]+):/g)) names.add(m[1]);
  // Non-colour theme namespaces that still produce utilities.
  for (const m of css.matchAll(/--(radius|shadow)-([a-z0-9-]+):/g)) names.add(m[2]);
  return names;
}

const APPS = [
  { name: 'pwa', src: resolve(root, 'apps/pwa/src'), css: resolve(root, 'apps/pwa/src/index.css') },
  { name: 'kds', src: resolve(root, 'apps/kds/src'), css: resolve(root, 'apps/kds/src/index.css') },
  {
    name: 'admin',
    src: resolve(root, 'apps/admin/src'),
    css: resolve(root, 'apps/admin/src/index.css'),
  },
];

let failures = 0;
let checked = 0;

/**
 * How many colour utilities the scanner actually reached.
 *
 * Tracked separately from `checked` so the floor below measures COVERAGE
 * rather than the suite's total size, which grows for unrelated reasons.
 */
let colourUtilitiesSeen = 0;

for (const app of APPS) {
  const tokens = themeTokens(app.css);
  const bad = [];
  const seen = new Set();

  for (const file of walk(app.src)) {
    /*
     * `stripComments` FIRST, and that is not tidiness.
     *
     * This scanned the raw file, and the regex below treats every quote
     * character in it as a string delimiter. An apostrophe in prose — "the
     * customer's phone", "the SDK's own opinion" — therefore OPENS a string
     * that runs to the next quote anywhere in the file, swallowing whatever
     * className attributes lie between.
     *
     * The symptom was a count that moved when only COMMENTS changed: adding a
     * few sentences with apostrophes to `Pay.tsx` took the suite from 653
     * checks to 633, and removing a card containing seven real colour
     * utilities changed it by zero. The check was not testing less because the
     * code shrank; it was testing less because the prose grew.
     *
     * Every sibling check in this file already strips comments. This one was
     * the exception, and being the exception is what made it quietly weakest.
     */
    const src = stripComments(readFileSync(file, 'utf8'));

    // Every className string and template literal in the file. Conditional
    // class expressions are string literals too, so this catches the ternary
    // branches as well as the static case.
    for (const lit of src.matchAll(/(?:className=)?["'`]([^"'`]*)["'`]/g)) {
      for (const raw of lit[1].split(/\s+/)) {
        if (!raw) continue;

        // Strip variants (`hover:`, `lg:`, `dark:`, `group-hover:`) and any
        // opacity suffix (`/70`), then split prefix from value.
        const base = raw.split(':').pop() ?? '';
        const [util, ...rest] = base.split('-');
        if (!util || rest.length === 0) continue;
        if (!COLOUR_PREFIXES.includes(util)) continue;

        let value = rest.join('-').split('/')[0];
        if (!value) continue;

        // `border-l-4` is a width and `border-l-brand-500` is a colour, so a
        // leading side keyword has to be stripped before deciding which this
        // is. Getting that wrong the other way — treating every `border-l-*` as
        // a width — would blind the check to a misspelt directional colour.
        const side = value.match(/^(t|r|b|l|x|y|s|e)-(.+)$/);
        if (side) value = side[2];

        /*
         * `ring-offset-*` is TWO utilities sharing one prefix.
         *
         *   ring-offset-2      a WIDTH
         *   ring-offset-page   a COLOUR, and one worth checking — an offset
         *                      ring whose colour does not match the surface
         *                      behind it draws a halo in the wrong shade, and
         *                      in dark mode that is a white ring on charcoal.
         *
         * Stripping the keyword and re-testing is what lets the numeric one
         * fall through the `^\d` guard below while the named one is resolved
         * against the theme like any other colour.
         */
        const offset = value.match(/^offset-(.+)$/);
        if (offset) value = offset[1];

        if (NOT_COLOURS.has(value)) continue;
        if (BUILT_IN.has(value)) continue;
        if (/^\[/.test(value)) continue; // arbitrary value, e.g. text-[13px]
        if (/^\d/.test(value)) continue; // border-2, ring-4, text-3
        if (!/^[a-z][a-z0-9-]*$/.test(value)) continue;

        // Bare numeric-suffix families we do not own (Tailwind's own scales are
        // not enabled here — every colour in these apps is a theme token).
        checked++;
        colourUtilitiesSeen++;
        if (!tokens.has(value)) {
          const key = `${util}-${value}`;
          if (seen.has(key)) continue;
          seen.add(key);
          bad.push({ file: relative(root, file), util, value });
        }
      }
    }
  }

  console.log(`\n${app.name} — ${tokens.size} theme tokens declared`);
  console.log('─'.repeat(78));

  if (bad.length === 0) {
    console.log('  ok    every colour utility resolves to a declared token');
  } else {
    for (const b of bad) {
      failures++;
      console.log(`  FAIL  ${b.util}-${b.value}   no --color-${b.value} in ${app.name}   (${b.file})`);
    }
  }
}

/*
 * ============================================================================
 * THE CONTROL FOR THE CHECK ABOVE: PROSE MUST NOT CHANGE ITS COVERAGE
 * ============================================================================
 *
 * The scanner treats every quote character as a string delimiter, so an
 * apostrophe in a comment used to open a fake string that swallowed real
 * className attributes until the next quote. The result was a check whose
 * coverage depended on how much prose sat above the code — it lost 278 of 911
 * occurrences that way, silently, and the only visible symptom was a total
 * that moved when nothing but comments had changed.
 *
 * `stripComments` fixes it. This asserts the fix is still in place, by counting
 * the same code with and without an apostrophe-bearing comment attached. A
 * regression here does not produce a failure anywhere else — it produces a
 * quieter suite, which is the hardest kind of rot to notice.
 */
{
  /*
   * A FLOOR ON COVERAGE, MEASURED FROM THE REAL SCAN.
   *
   * The first version of this control re-implemented the extraction on a
   * synthetic string and asserted the technique worked. That is worth almost
   * nothing: it is a COPY, so it kept passing while a mutation removed
   * `stripComments` from the real check and coverage collapsed from 911
   * occurrences to 634. A control that cannot see the thing it guards is
   * decoration.
   *
   * This counts what the actual scan reached. Comment-stripping is worth ~30%
   * of the class strings in this codebase, so the floor sits above what the
   * broken version can reach and below the current figure — it fails on the
   * regression and does not need editing every time a screen is added.
   */
  const FLOOR = 750;
  checked++;
  const ok = colourUtilitiesSeen >= FLOOR;
  if (!ok) failures++;
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'}  coverage  the scanner reached ${colourUtilitiesSeen} colour utilities ` +
      `(floor ${FLOOR})`,
  );
  if (!ok) {
    console.log(`        Below the floor means the scan is missing class strings, not that the`);
    console.log(`        apps shrank. The usual cause is a raw readFileSync where stripComments`);
    console.log(`        belongs: an apostrophe in a comment opens a fake string that swallows`);
    console.log(`        every className until the next quote.`);
  }
}

/**
 * ============================================================================
 * PLAIN CSS CLASSES, WHICH THE CHECK ABOVE CANNOT SEE
 * ============================================================================
 *
 * `.display`, `.eyebrow`, `.pressable`, `.tnum`, `.ident` are hand-written
 * rules, not theme tokens, so nothing above knows they exist. Their failure
 * mode is quieter than a missing colour: a heading with no `.display` renders
 * as ordinary bold sans, which looks like a design decision rather than a bug,
 * and `.pressable` missing means a button simply has no hover state.
 *
 * This was not hypothetical — the console used `.display` and `.eyebrow` nine
 * times before either was defined in its stylesheet, and everything typechecked
 * and rendered.
 */
const PLAIN_CLASSES = [
  'display',
  'eyebrow',
  'pressable',
  'tnum',
  'ident',
  // The glass treatment. Same failure mode and worse: a missing `.glass-hover`
  // leaves a button with NO hover state at all, which on a desktop reads as a
  // dead control rather than as a styling slip.
  'glass-hover',
  'glass-on',
  'glass-ring',
  // The floating cart/pay action. Missing means a control with no background at
  // all, floating unreadably over a menu of photographs.
  'glass-action',
  // Same material, ink fill. The pay button — see `--action-fill`.
  'glass-action-ink',
  'action-dock',
];

console.log('\nplain CSS classes — used in an app must be defined in its stylesheet');
console.log('─'.repeat(78));

for (const app of APPS) {
  const css = readFileSync(app.css, 'utf8');
  const missing = [];

  for (const name of PLAIN_CLASSES) {
    // Used as a whole class token, not as part of a longer word.
    const used = walk(app.src).some((f) =>
      new RegExp(`["'\`\\s]${name}[\\s"'\`]`).test(readFileSync(f, 'utf8')),
    );
    if (!used) continue;

    checked++;
    const defined = new RegExp(`^\\.${name}\\s*[,{]`, 'm').test(css);
    if (defined) continue;

    failures++;
    missing.push(name);
  }

  if (missing.length === 0) {
    console.log(`  ok    ${app.name.padEnd(6)} every class it uses is defined`);
  } else {
    for (const m of missing) {
      console.log(`  FAIL  ${app.name}  uses .${m} and does not define it — renders as nothing`);
    }
  }
}

/**
 * ============================================================================
 * NO FADED TEXT ON A MEASURED BACKGROUND
 * ============================================================================
 *
 * `tests/design/contrast.mjs` measures TOKEN PAIRS — `on-banner` on
 * `banner-wait`, and so on. It cannot see an `opacity-90` applied to the
 * element afterwards, and several of those pairs were designed close to the
 * 4.5:1 floor on purpose, because a banner is a saturated fill carrying white.
 *
 * So fading one costs contrast the measurement already spent:
 *
 *   white on banner-wait  #CF3A32   100% -> 4.88:1  passes
 *                                    90% -> 4.21:1  FAILS, and it was on 9px
 *
 * That was live on the order-tracking header, in the state an order sits in for
 * most of its life. Nothing caught it, because everything that looks was
 * looking at the token.
 *
 * The rule: text on a `banner-*` or `brand-fill` surface uses its `on-*` token
 * at full strength. Rank it by size, weight and tracking instead — that is what
 * typography is for, and it costs no legibility.
 *
 * Backgrounds are exempt: `bg-white/20` on a pill inside a banner is a surface,
 * not a label, and lightening it makes the text on top MORE legible.
 *
 * AND SO IS `disabled:`. A disabled control is SUPPOSED to be low contrast —
 * that is what disabled looks like, and WCAG 1.4.3 exempts inactive components
 * explicitly. The first version of this check flagged four `disabled:opacity-45`
 * buttons, which is the check being wrong rather than the code: a rule that
 * fires on the correct implementation of a state trains people to add
 * exceptions until it fires on nothing.
 *
 * So the pattern requires the utility to be UNPREFIXED. `opacity-90` applies
 * always; `disabled:opacity-45` applies to a button nobody can press.
 */
const FADED_TEXT = /(?:^|\s)(?:(?:text-on-\w[\w-]*|text-white)\/(\d+)|opacity-(\d+))\b/g;

console.log('\ntext on a banner — measured pairs are not faded afterwards');
console.log('─'.repeat(78));

for (const app of APPS) {
  const bad = [];
  for (const file of walk(app.src)) {
    const src = stripComments(readFileSync(file, 'utf8'));
    for (const m of src.matchAll(CLASS_ATTR)) {
      const cls = m[1].split(/\s+/).filter(Boolean).join(' ');
      // Only class strings that also carry the measured foreground.
      if (!/\btext-on-(banner|brand)\b/.test(cls)) continue;

      for (const f of cls.matchAll(FADED_TEXT)) {
        const pct = Number(f[1] ?? f[2]);
        // 100 is not a fade. Below it is.
        if (!Number.isFinite(pct) || pct >= 100) continue;
        checked++;
        failures++;
        bad.push({ file: relative(root, file), what: f[0] });
      }
    }
  }
  checked++;
  if (bad.length === 0) {
    console.log(`  ok    ${app.name.padEnd(6)} on-banner and on-brand text is at full strength`);
  } else {
    for (const b of bad) {
      console.log(
        `  FAIL  ${b.what} on measured text — the pair was sized for 100%   (${b.file})`,
      );
    }
  }
}

/**
 * ============================================================================
 * `{''}` IS NOT A SPACE
 * ============================================================================
 *
 * JSX collapses the whitespace around a newline, so a sentence split across two
 * lines needs an explicit separator. The idiom is `{' '}`. What was in this
 * codebase, thirteen times across all three apps, was `{''}` — an empty string,
 * which renders nothing at all:
 *
 *   Order A-003 · {o.items.length}{''}
 *   {o.items.length === 1 ? 'item' : 'items'}      ->  "2items"
 *
 *   Customers pay{''}
 *   {formatINR(price)}                             ->  "Customers pay₹180"
 *
 * It is invisible in review — one character, in a position where SOMETHING
 * clearly belongs — and it typechecks, lints and renders without complaint. It
 * only shows up as two words glued together in a screenshot somebody sends
 * back, which is exactly how this one was found.
 *
 * There is no legitimate use. An empty expression container that renders
 * nothing is either a mistake or a comment written the wrong way.
 */
console.log('\nJSX spacing — no {\'\'} where a space was meant');
console.log('─'.repeat(78));

for (const app of APPS) {
  const bad = [];
  for (const file of walk(app.src)) {
    const src = readFileSync(file, 'utf8');
    const hits = [...src.matchAll(/\{''\}/g)];
    for (const m of hits) {
      checked++;
      failures++;
      bad.push({ file: relative(root, file), line: src.slice(0, m.index).split('\n').length });
    }
  }
  checked++;
  if (bad.length === 0) {
    console.log(`  ok    ${app.name.padEnd(6)} no empty-string separators`);
  } else {
    for (const b of bad) {
      console.log(`  FAIL  {''} renders nothing — two words will run together   (${b.file}:${b.line})`);
    }
  }
}

/**
 * ============================================================================
 * A FILM MUST HAVE A SHAPE
 * ============================================================================
 *
 * THE BUG THIS EXISTS FOR, WHICH SHIPPED
 *
 * The glass film was first put inside `.pressable`, on the reasoning that one
 * rule means nothing gets forgotten. But `.pressable` sits on two different
 * kinds of element:
 *
 *   1. controls that own a surface — a background, a border, a radius
 *   2. invisible layout wrappers whose only job is to make something clickable
 *
 * A category chip is (2): an 84px SQUARE button wrapping a round photo and a
 * caption. Giving it a background painted a RECTANGLE behind the circle on
 * every hover, in the most-looked-at row of the customer app, and the user saw
 * it before any test did.
 *
 * `filter` and `transform` are safe on both kinds, because they act on what is
 * already painted — a wrapper with an empty box shows nothing. A background is
 * the one property that INVENTS a shape. So it may only go on an element that
 * already has one, and a `rounded-*` class is the evidence of that.
 *
 * `rounded-none` counts, and is not a loophole: three buttons here are squared
 * off because a `rounded-* overflow-hidden` PARENT cuts their corners, and
 * writing it explicitly is how that intent survives the next reader.
 */
console.log('\nglass — never on an element with no shape to fill');
console.log('─'.repeat(78));

const GLASS = /\bglass-(hover|on|ring)\b/;
const RADIUS = /\brounded(-|\b)/;


for (const app of APPS) {
  const bad = [];
  for (const file of walk(app.src)) {
    const src = stripComments(readFileSync(file, 'utf8'));
    for (const m of src.matchAll(CLASS_ATTR)) {
      const cls = m[1].split(/\s+/).filter(Boolean).join(' ');
      if (!GLASS.test(cls) || RADIUS.test(cls)) continue;
      checked++;
      failures++;
      bad.push({ file: relative(root, file), cls: cls.slice(0, 60) });
    }
  }
  checked++;
  if (bad.length === 0) {
    console.log(`  ok    ${app.name.padEnd(6)} every glass surface has a radius to follow`);
  } else {
    for (const b of bad) {
      console.log(`  FAIL  glass with no radius — draws a rectangle   (${b.file})  "${b.cls}"`);
    }
  }
}

/**
 * ============================================================================
 * NO SEMANTIC COLOUR IN A HOVER OR PRESS STATE
 * ============================================================================
 *
 * Pointing at a control is not a semantic event. `hover:bg-brand-50` on the ADD
 * button meant a grid of dishes lit up red as the cursor crossed it, announcing
 * "important" at a pointer that was on its way somewhere else — and in the
 * kitchen board, `hover:text-late-500` spent the ONE colour that means "this
 * order is late" on a mouse passing over a Reject button.
 *
 * The replacement is `.pressable` / `.glass-hover`, which are theme tokens with
 * no meaning attached. This check is what stops a branded hover coming back the
 * next time somebody wants a button to feel livelier, because the failure is
 * invisible in review: one more `hover:bg-brand-50` in a 200-character class
 * string reads as perfectly normal Tailwind.
 *
 * REST states are deliberately NOT checked. A permanently red-outlined "None
 * left" button is a fact about the button; it is the reaction to a cursor that
 * has to be quiet.
 *
 * `focus` is excluded too, and that is not an oversight — see below.
 */
const SEMANTIC = /^(brand|alert|late|warn|held|fresh|nonveg|veg|egg|banner|success)/;
/*
 * `[a-z]+` for the utility, NOT `[a-z-]+`.
 *
 * With a hyphen in that class the group is greedy and swallows the colour
 * family: `hover:bg-brand-50` parses as util `bg-brand`, value `50`, which is
 * in neither the tint list nor the semantic list, so the check waves it
 * through. This exact bug survived its first negative control — the seeded
 * `hover:bg-brand-50` was reported clean — which is the entire argument for
 * seeding one.
 */
const POINTER_VARIANT = /\b(hover|active|group-hover|group-active):([a-z]+)-([a-z0-9-]+(?:\/\d+)?)\b/g;
const TINTS = new Set(['bg', 'text', 'border', 'ring', 'from', 'to', 'via', 'fill', 'stroke', 'divide', 'outline', 'shadow']);

console.log('\nhover and press — no semantic colour, in any app');
console.log('─'.repeat(78));

for (const app of APPS) {
  const bad = [];

  for (const file of walk(app.src)) {
    const src = stripComments(readFileSync(file, 'utf8'));
    for (const m of src.matchAll(POINTER_VARIANT)) {
      const [whole, variant, util] = m;
      if (!TINTS.has(util)) continue;
      // `ring-offset-page` is a colour wearing a keyword. Same strip as above.
      const value = m[3].replace(/^offset-/, '');
      if (!SEMANTIC.test(value)) continue;

      checked++;
      failures++;
      bad.push({ file: relative(root, file), whole, variant });
    }
  }

  checked++; // the app itself passing counts as one assertion
  if (bad.length === 0) {
    console.log(`  ok    ${app.name.padEnd(6)} every hover and press state is colour-neutral`);
  } else {
    for (const b of bad) {
      console.log(`  FAIL  ${b.whole}   semantic colour in a ${b.variant} state   (${b.file})`);
    }
  }
}

/**
 * FOCUS IS EXEMPT, ON PURPOSE.
 *
 * A focus ring is not a highlight, it is the only thing telling a keyboard user
 * where they are, and WCAG 2.4.11 wants it at 3:1 against what is behind it. A
 * translucent frost cannot carry that — the whole point of glass is that it
 * takes its colour from whatever it is over. So `focus:border-brand-500` and
 * `focus:ring-brand-200` stay exactly as they are, and this asserts that they
 * are still there rather than getting swept up in a future tidy.
 */
console.log('\nfocus rings — still coloured, because glass cannot carry 3:1');
console.log('─'.repeat(78));

for (const app of APPS) {
  const rings = walk(app.src).reduce(
    (n, f) => n + [...readFileSync(f, 'utf8').matchAll(/\bfocus(-visible)?:(border|ring)-brand-/g)].length,
    0,
  );
  checked++;
  const ok = rings > 0;
  if (!ok) failures++;
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'}  ${app.name.padEnd(6)} ${rings} coloured focus indicator${
      rings === 1 ? '' : 's'
    }${ok ? '' : ' — a keyboard user has nothing to follow'}`,
  );
}

/**
 * ============================================================================
 * A SNAPPING SCROLLER MUST DECLARE ITS SCROLL-PADDING
 * ============================================================================
 *
 * `snap-x` next to `px-4` looks complete and is not. Scroll snapping aligns a
 * `snap-start` child against the SNAPPORT — the padding box reduced by
 * `scroll-padding` — and `scroll-padding` defaults to zero. So the snapport
 * starts at the padding box edge, the browser scrolls the track far enough to
 * bring the first child flush with it, and the left padding ends up parked
 * off-screen. Nothing is overridden and no rule loses; the padding is simply
 * scrolled out from under itself.
 *
 * The visible result is a rail whose first item hugs the edge of the phone
 * while every heading on the page begins 16px in. It is invisible on a desktop
 * only in the sense that nobody looks at the left edge there — it is wrong at
 * every width, and it cost a round trip to find because the class string
 * already said `px-4`.
 *
 * So: any element that snaps AND carries horizontal padding must carry a
 * matching `scroll-px-*` at the SAME breakpoint. A scroller with no padding —
 * a full-bleed banner carousel — has nothing to protect and is left alone.
 */
console.log('\nsnapping scrollers — scroll-padding matches padding');
console.log('─'.repeat(78));

/** `md:px-6` -> {bp:'md', kind:'px', v:'6'}; `px-4` -> {bp:'', ...}. */
const PAD = /^(?:([a-z0-9@[\]()-]+):)?p([xl])-(.+)$/;
const SCROLL_PAD = /^(?:([a-z0-9@[\]()-]+):)?scroll-p([xl])-(.+)$/;

function snapPaddingGaps(classes) {
  if (!/\bsnap-x\b/.test(classes)) return [];
  const tokens = classes.split(/\s+/).filter(Boolean);
  const declared = new Set();
  for (const t of tokens) {
    const m = SCROLL_PAD.exec(t);
    if (m) declared.add(`${m[1] ?? ''}|${m[3]}`);
  }
  const gaps = [];
  for (const t of tokens) {
    const m = PAD.exec(t);
    if (!m) continue;
    const [, bp, , v] = m;
    if (!declared.has(`${bp ?? ''}|${v}`)) {
      /* Name the token they need, so the fix is the message rather than a
         lookup. `md:px-6` wants `md:scroll-px-6`, keeping the breakpoint. */
      gaps.push({ token: t, want: `${bp ? `${bp}:` : ''}scroll-${t.slice(bp ? bp.length + 1 : 0)}` });
    }
  }
  return gaps;
}

for (const app of APPS) {
  const bad = [];
  for (const file of walk(app.src)) {
    const src = stripComments(readFileSync(file, 'utf8'));
    for (const m of src.matchAll(CLASS_ATTR)) {
      for (const g of snapPaddingGaps(m[1])) {
        bad.push({ gap: g.token, want: g.want, file: relative(root, file) });
      }
    }
  }
  checked++;
  if (bad.length > 0) {
    failures++;
    for (const b of bad) {
      console.log(`  FAIL  snap-x scroller has ${b.gap} and no ${b.want}   (${b.file})`);
      console.log(`        the snap scrolls that padding off-screen — the row will hug the edge`);
    }
  } else {
    console.log(`  ok    ${app.name.padEnd(6)} every snapping scroller protects its padding`);
  }
}

/*
 * The control. The bug this check exists for is a MISSING token, and a check
 * for something absent passes trivially when its parser is broken — so prove
 * it fires, and prove the exemption for a genuinely full-bleed scroller holds.
 */
{
  checked++;
  const seeded = snapPaddingGaps('flex overflow-x-auto snap-x -mx-4 px-4 md:px-6');
  const fixed = snapPaddingGaps('flex snap-x -mx-4 px-4 scroll-px-4 md:px-6 md:scroll-px-6');
  const bleed = snapPaddingGaps('flex overflow-x-auto snap-x snap-mandatory -mx-4 md:mx-0');
  const notARail = snapPaddingGaps('flex px-4');
  /* The names it suggests are part of the check: a message that says
     `scroll-px-4` when the breakpoint was `md:` sends somebody to the wrong
     line. Assert the suggestion, not just the count. */
  const named = seeded.map((g) => g.want).join(' ');
  const ok =
    seeded.length === 2 &&
    named === 'scroll-px-4 md:scroll-px-6' &&
    fixed.length === 0 &&
    bleed.length === 0 &&
    notARail.length === 0;
  if (!ok) failures++;
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'}  control  catches ${seeded.length}/2 gaps, names them "${named}", ` +
      `clears the fixed rail, exempts the full-bleed carousel`,
  );
}

/**
 * ============================================================================
 * A MODIFIER CLASS IS USELESS — AND INVISIBLE — WITHOUT ITS BASE
 * ============================================================================
 *
 * `.glass-action-ink` sets two custom properties and nothing else:
 *
 *     .glass-action-ink { --action-fill: var(--ink-900);
 *                         --action-glow: rgb(18 21 26 / 0.28); }
 *
 * The background, the blur, the rim and the shadow all live in `.glass-action`,
 * which READS those variables. So the modifier alone paints nothing.
 *
 * WHAT THAT COST
 *
 * The customer's Pay button was
 *
 *     class="pressable glass-action-ink w-full rounded-full text-page py-4"
 *
 * — modifier, no base. It rendered at full size, with `text-page` (near-white)
 * text, no background, on a near-white page. An invisible button occupying its
 * own space: the screen looked blank below the order summary, and the only way
 * to pay was to tap a gap.
 *
 * It survived because it was unreachable in development. Checkout sent DEV
 * builds straight to the tracking screen after simulating a payment, so the pay
 * screen was only ever rendered in a production build — and the first time
 * anybody reached it was with a real aggregator wired.
 *
 * Every other check here passed it: the class string HAS a glass class, and it
 * HAS a radius, which is all `glass-needs-a-shape` asks.
 *
 * HOW THIS DECIDES WHAT A MODIFIER IS
 *
 * Not a hand-written list. A rule whose body declares ONLY custom properties
 * cannot paint anything by itself — that is what makes it a modifier, and it is
 * readable straight from the stylesheet. Its base is the name minus the last
 * segment, and it only counts if that base is really a rule too.
 */
console.log('\nmodifier classes — never used without the base that paints');
console.log('─'.repeat(78));

/** `.foo { --a: 1; --b: 2 }` -> a modifier. `.foo { color: red }` -> not. */
function modifierClasses(css) {
  const found = new Map();
  for (const m of css.matchAll(/^\.([a-z][\w-]*)\s*\{([^}]*)\}/gm)) {
    const [, name, body] = m;
    const decls = body
      .split(';')
      .map((d) => d.trim())
      .filter((d) => d.length > 0 && !d.startsWith('/*'));
    if (decls.length === 0) continue;
    if (!decls.every((d) => d.startsWith('--'))) continue;

    // The base is this name with the last `-segment` removed.
    const base = name.replace(/-[^-]+$/, '');
    if (base !== name && new RegExp(`^\\.${base}\\s*\\{`, 'm').test(css)) {
      found.set(name, base);
    }
  }
  return found;
}

for (const app of APPS) {
  const css = readFileSync(app.css, 'utf8');
  const modifiers = modifierClasses(css);
  const bad = [];

  if (modifiers.size > 0) {
    for (const file of walk(app.src)) {
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const m of src.matchAll(CLASS_ATTR)) {
        const tokens = m[1].split(/\s+/).filter(Boolean);
        for (const [mod, base] of modifiers) {
          if (tokens.includes(mod) && !tokens.includes(base)) {
            bad.push({ file: relative(root, file), mod, base });
          }
        }
      }
    }
  }

  checked++;
  if (bad.length > 0) {
    failures++;
    for (const b of bad) {
      console.log(`  FAIL  ${b.mod} without ${b.base}   (${b.file})`);
      console.log(`        the modifier only sets variables — nothing paints, and the`);
      console.log(`        element still occupies its full size`);
    }
  } else {
    const names = [...modifiers.keys()];
    console.log(
      `  ok    ${app.name.padEnd(6)} ${names.length} modifier${names.length === 1 ? '' : 's'}` +
        `${names.length ? ` (${names.join(', ')})` : ''}, each used with its base`,
    );
  }
}

/*
 * The control. This passes trivially if `modifierClasses` finds nothing, and
 * the PWA is the only app that currently has one — so prove the detector both
 * recognises a variables-only rule and rejects a painting one.
 */
{
  checked++;
  const css = `
.glass-action { background-color: red; }
.glass-action-ink { --action-fill: black; --action-glow: grey; }
.pressable { transform: scale(1); }
.orphan-mod { --x: 1; }
`;
  const found = modifierClasses(css);
  const ok =
    found.get('glass-action-ink') === 'glass-action' &&
    !found.has('glass-action') &&
    !found.has('pressable') &&
    // no `.orphan` rule exists, so this is not a modifier of anything
    !found.has('orphan-mod') &&
    found.size === 1;
  if (!ok) failures++;
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'}  control  detects a variables-only rule with a real base, and ` +
      `ignores painting rules and orphans${ok ? '' : `   (found ${JSON.stringify([...found])})`}`,
  );
}

console.log('\n' + '═'.repeat(78));
console.log(`${checked} checks, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
