/**
 * WCAG contrast, computed from the CSS that actually ships.
 *
 * WHY THIS EXISTS AS A TEST RATHER THAN A ONE-OFF CHECK
 *
 * Adding a second theme doubles every colour decision, and the failure mode is
 * silent: nothing crashes, no type is wrong, the page renders — it is simply
 * unreadable for somebody. Three real failures were already sitting in the
 * light theme before dark mode was written, and the worst of them (white on
 * #E5A50A, 2.16:1) was on the header that tells a customer their payment did
 * not go through.
 *
 * So the pairs below are asserted, not eyeballed. The token VALUES are parsed
 * out of the real stylesheets, which means changing a hex in `index.css`
 * without re-checking it fails here rather than in a food court.
 *
 * Run: node tests/design/contrast.mjs
 *
 * NOT COVERED, AND DELIBERATELY SO
 *
 * This proves the declared pairs. It cannot prove that a component uses the
 * pair it should — `text-ink-400` on `bg-surface` would pass here as a declared
 * pair and still be wrong if it were used for body copy. That is a review
 * question, not an arithmetic one.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// ---------------------------------------------------------------- WCAG maths

/** sRGB channel → linear. The 0.03928 knee is from the WCAG 2.x definition. */
function toLinear(c) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function luminance(hex) {
  const h = hex.replace('#', '').trim();
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// ------------------------------------------------------------- token parsing

/**
 * Pull the custom properties out of one theme block.
 *
 * Matches on the SELECTOR rather than on document order, so reordering the
 * stylesheet cannot silently make this read the wrong theme — which would turn
 * every assertion into a test of the light theme twice.
 */
function tokens(css, selector) {
  const at = css.indexOf(selector);
  if (at < 0) throw new Error(`no block for ${selector}`);
  const open = css.indexOf('{', at);
  const close = css.indexOf('\n}', open);
  const block = css.slice(open, close);

  const out = {};
  /*
   * ANCHORED TO THE START OF A LINE, AND THAT IS NOT COSMETIC.
   *
   * The unanchored version matched anywhere in a declaration, so a botched edit
   * that produced
   *
   *     --scrim: --scrim: #12151a73;
   *
   * still matched `--scrim: #12151a73` as a SUBSTRING and reported the token as
   * correctly declared. All six scrims in this repo were malformed like that at
   * once — every one of them resolving to an invalid value at use time, so the
   * dialog behind every modal in all three apps had no scrim — and this file
   * printed nine green ticks over the top of it.
   *
   * A custom property may hold almost any token stream, which is why CSS does
   * not complain either. Nothing catches this except reading the whole
   * declaration, from the start of the line to the semicolon.
   */
  for (const m of block.matchAll(/^[ \t]*--([a-z0-9-]+):[ \t]*([^;\n]+);/gm)) {
    const value = m[2].trim();
    // Only colour tokens are of interest here; shadows and the rest are
    // asserted elsewhere. A malformed one is DROPPED rather than skipped
    // quietly, so the assertions below report it as missing.
    if (/^#[0-9a-fA-F]{3,8}$/.test(value)) out[m[1]] = value;
  }
  return out;
}

const pwaCss = readFileSync(resolve(root, 'apps/pwa/src/index.css'), 'utf8');
const kdsCss = readFileSync(resolve(root, 'apps/kds/src/index.css'), 'utf8');
const adminCss = readFileSync(resolve(root, 'apps/admin/src/index.css'), 'utf8');

const themes = {
  'pwa · light': tokens(pwaCss, ':root,\n[data-theme=\'light\']'),
  'pwa · dark': tokens(pwaCss, '[data-theme=\'dark\']'),
  'kds · dark': tokens(kdsCss, ':root,\n[data-theme=\'dark\']'),
  'kds · light': tokens(kdsCss, '[data-theme=\'light\']'),
  'admin · light': tokens(adminCss, ':root,\n[data-theme=\'light\']'),
  'admin · dark': tokens(adminCss, '[data-theme=\'dark\']'),
};

// Constants that are the same in both themes, so they are not in a theme block.
/**
 * Tokens whose VALUE carries alpha, checked for shape rather than for contrast.
 *
 * A scrim has no text on it, so a ratio would be meaningless. What matters is
 * that it is theme-swapped at all — the thing it replaced was `bg-black/70`
 * hard-coded in four components, which is right over a charcoal board and turns
 * a pale one into a slab. Asserted below in `ALPHA_TOKENS`.
 */
const ALPHA_TOKENS = ['scrim'];

const FIXED = {
  'on-banner': '#ffffff',
  white: '#ffffff',
  'veg-500': '#0f8a45',
  'nonveg-500': '#9c2b1f',
  'egg-500': '#d99b12',
  // A UI colour derived from the veg mark, not the mark itself. See index.css.
  'veg-fill': '#0c6e37',
};

/**
 * AA thresholds.
 *
 * 3.0 is the LARGE-text floor and applies only at 18.66px bold / 24px regular.
 * Where a pair is marked `lg` below, the size that justifies it is named — an
 * unexplained 3.0 is how a small-text failure gets waved through.
 */
const AA = 4.5;
const AA_LARGE = 3.0;

/** [foreground, background, minimum, why] */
const PAIRS = {
  'pwa · light': [
    ['on-brand', 'brand-fill', AA, 'button labels, 15px bold'],
    ['on-brand-muted', 'brand-fill', AA, 'app-bar subtitle, 13px'],
    ['ink-900', 'surface', AA, 'headings on a card'],
    ['ink-700', 'surface', AA, 'body on a card'],
    ['ink-500', 'surface', AA, 'secondary text on a card'],
    ['ink-700', 'page', AA, 'body on the page tint'],
    ['ink-500', 'page', AA, 'secondary text on the page tint'],
    ['brand-700', 'surface', AA, 'the ADD label, 13px bold'],
    ['fresh-700', 'fresh-50', AA, 'the "Open" pill'],
    ['warn-700', 'warn-50', AA, 'the dev OTP panel'],
    ['alert-500', 'alert-50', AA, 'the failure pill'],
    ['ink-700', 'ink-100', AA, 'the neutral pill'],
    ['on-banner', 'banner-wait', AA, 'tracking header — placed / cooking'],
    ['on-banner', 'banner-ready', AA, 'tracking header — ready'],
    ['on-banner', 'banner-attention', AA, 'tracking header — UNPAID (was 2.16:1)'],
    ['on-banner', 'banner-alert', AA, 'tracking header — rejected'],
    // The rejected rail, added with it. The crossed node is 11px and the label
    // 9px, so both are small text and both need full AA rather than AA_LARGE.
    ['on-brand', 'alert-500', AA, 'the ✕ on the rejected rail node'],
    ['alert-500', 'surface', AA, 'the REJECTED label under it'],
    ['white', 'success-page', AA, 'the payment-success screen'],
    ['fresh-700', 'surface', AA, 'TRACK MY ORDER, on the success screen'],
    ['brand-500', 'surface', AA_LARGE, 'borders and icons only — never small text'],
    ['white', 'veg-fill', AA, 'the "Veg only" filter when active'],
  ],
  'pwa · dark': [
    ['on-brand', 'brand-fill', AA, 'button labels, 15px bold'],
    ['on-brand-muted', 'brand-fill', AA, 'app-bar subtitle, 13px'],
    ['ink-900', 'surface', AA, 'headings on a card'],
    ['ink-700', 'surface', AA, 'body on a card'],
    ['ink-500', 'surface', AA, 'secondary text on a card'],
    ['ink-700', 'page', AA, 'body on the page tint'],
    ['ink-500', 'page', AA, 'secondary text on the page tint'],
    ['brand-700', 'surface', AA, 'the ADD label, 13px bold'],
    ['fresh-700', 'fresh-50', AA, 'the "Open" pill'],
    ['warn-700', 'warn-50', AA, 'the dev OTP panel'],
    ['alert-500', 'alert-50', AA, 'the failure pill'],
    ['ink-700', 'ink-100', AA, 'the neutral pill'],
    ['on-banner', 'banner-wait', AA, 'tracking header — placed / cooking'],
    ['on-banner', 'banner-ready', AA, 'tracking header — ready'],
    ['on-banner', 'banner-attention', AA, 'tracking header — unpaid'],
    ['on-banner', 'banner-alert', AA, 'tracking header — rejected'],
    // The rejected rail, added with it. The crossed node is 11px and the label
    // 9px, so both are small text and both need full AA rather than AA_LARGE.
    ['on-brand', 'alert-500', AA, 'the ✕ on the rejected rail node'],
    ['alert-500', 'surface', AA, 'the REJECTED label under it'],
    ['white', 'success-page', AA, 'the payment-success screen'],
    ['fresh-700', 'surface', AA, 'TRACK MY ORDER, on the success screen'],
    ['brand-500', 'surface', AA, 'brand as TEXT is legible on dark'],
    ['white', 'veg-fill', AA, 'the "Veg only" filter when active'],
  ],
  'kds · dark': [
    ['shell-100', 'shell-900', AA, 'primary text on the board'],
    ['shell-100', 'shell-800', AA, 'the sign-in card heading and the wordmark'],
    ['shell-300', 'shell-800', AA, 'body on a ticket'],
    ['shell-400', 'shell-800', AA, 'secondary text on a ticket'],
    ['shell-400', 'shell-900', AA, 'secondary text on the board'],
    ['go-500', 'shell-800', AA_LARGE, 'the Accept button edge and 28px stage label'],
    ['warn-500', 'shell-800', AA, 'the ageing warning'],
    ['late-500', 'shell-800', AA, 'the late warning'],
    ['brand-400', 'shell-900', AA, 'the focus ring and new-ticket accent'],
    ['shell-900', 'brand-500', AA, 'the SIGN IN button — pale label on the fill'],
  ],
  'kds · light': [
    ['shell-100', 'shell-900', AA, 'primary text on the board'],
    ['shell-100', 'shell-800', AA, 'the sign-in card heading and the wordmark'],
    ['shell-300', 'shell-800', AA, 'body on a ticket'],
    ['shell-400', 'shell-800', AA, 'secondary text on a ticket'],
    ['shell-400', 'shell-900', AA, 'secondary text on the board'],
    ['go-500', 'shell-800', AA_LARGE, 'the Accept button edge and 28px stage label'],
    ['warn-500', 'shell-800', AA, 'the ageing warning'],
    ['late-500', 'shell-800', AA, 'the late warning'],
    ['brand-400', 'shell-900', AA_LARGE, 'the focus ring — a 3px outline, not text'],
    ['shell-900', 'brand-500', AA, 'the SIGN IN button — pale label on the fill'],
  ],

  /*
   * The console's four status tones carry the entire vocabulary of the app —
   * every court and stall is in one of them — and each is rendered as coloured
   * text on its own 50-tint. That pairing is the one most likely to be tuned by
   * eye and land at 4.2:1.
   */
  'admin · light': [
    ['on-brand', 'brand-fill', AA, 'button labels'],
    ['ink-900', 'surface', AA, 'headings and table rows'],
    ['ink-900', 'page', AA, 'the sign-in wordmark, 32px serif, on the bare page'],
    ['ink-700', 'surface', AA, 'field labels'],
    ['ink-500', 'surface', AA, 'hints under a field, and every 9px eyebrow'],
    ['ink-500', 'page', AA, 'hints on the page tint'],
    /*
     * ink-400 IS NOT A TEXT COLOUR, and this row is what says so.
     *
     * Asserted at the LARGE floor with the size that justifies it named —
     * except nothing here is large, because nothing here is text: icons beside
     * their own labels, input placeholders, and struck-through inactive rows.
     *
     * Writing the sign-in screen is what surfaced this. Copying the sidebar's
     * `eyebrow text-[9px] text-ink-400` would have shipped a 9px uppercase
     * label at 3.06:1 on a card and 2.80:1 on the page — the second one is
     * under even this floor. Four existing eyebrows had the same problem and
     * are now ink-500. The check above cannot catch that on its own (it proves
     * pairs, not usage), so the guard is this comment plus the deliberately
     * low bar: if a future pair needs ink-400 to pass AA, it is the wrong tone.
     */
    ['ink-400', 'surface', AA_LARGE, 'icons, placeholders, inactive rows — never content'],
    ['draft-700', 'draft-50', AA, 'the Onboarding pill and blocker list'],
    ['live-700', 'live-50', AA, 'the Live pill'],
    ['held-700', 'held-50', AA, 'the On hold pill and error notes'],
    ['closed-700', 'closed-50', AA, 'the Closed pill'],
    ['held-500', 'surface', AA, 'the required-field asterisk'],
  ],
  'admin · dark': [
    ['on-brand', 'brand-fill', AA, 'button labels'],
    ['ink-900', 'surface', AA, 'headings and table rows'],
    ['ink-900', 'page', AA, 'the sign-in wordmark, 32px serif, on the bare page'],
    ['ink-700', 'surface', AA, 'field labels'],
    ['ink-500', 'surface', AA, 'hints under a field, and every 9px eyebrow'],
    ['ink-500', 'page', AA, 'hints on the page tint'],
    ['ink-400', 'surface', AA_LARGE, 'icons, placeholders, inactive rows — never content'],
    ['draft-700', 'draft-50', AA, 'the Onboarding pill and blocker list'],
    ['live-700', 'live-50', AA, 'the Live pill'],
    ['held-700', 'held-50', AA, 'the On hold pill and error notes'],
    ['closed-700', 'closed-50', AA, 'the Closed pill'],
    ['held-500', 'surface', AA, 'the required-field asterisk'],
  ],
};

// ------------------------------------------------------------------- the run

let failures = 0;
let checked = 0;

for (const [themeName, pairs] of Object.entries(PAIRS)) {
  const t = { ...FIXED, ...themes[themeName] };
  console.log(`\n${themeName}`);
  console.log('─'.repeat(78));

  for (const [fg, bg, min, why] of pairs) {
    const fgHex = t[fg];
    const bgHex = t[bg];

    if (!fgHex || !bgHex) {
      console.log(`  MISSING  ${fg} on ${bg} — token not found in this theme`);
      failures++;
      continue;
    }

    const ratio = contrast(fgHex, bgHex);
    const ok = ratio >= min;
    checked++;
    if (!ok) failures++;

    console.log(
      `  ${ok ? 'ok  ' : 'FAIL'}  ${ratio.toFixed(2).padStart(5)}:1` +
        ` (min ${min.toFixed(1)})  ${(fg + ' on ' + bg).padEnd(30)} ${why}`,
    );
  }
}

// ------------------------------------------------------------- the scrim
/**
 * Every app declares a scrim, and the two themes declare DIFFERENT ones.
 *
 * Equal values in both themes would mean somebody set one and copied it, which
 * is exactly the bug: 72% black is "dimmed" over the kitchen's charcoal and
 * "the screen went out" over its light theme. The direction is asserted too —
 * the darker theme must carry the HEAVIER wash, which is the counter-intuitive
 * half and therefore the half that gets undone.
 */
console.log('\ndialog scrim — declared per theme, and not the same value twice');
console.log('─'.repeat(78));
for (const [app, lightKey, darkKey] of [
  ['pwa', 'pwa · light', 'pwa · dark'],
  ['kds', 'kds · light', 'kds · dark'],
  ['admin', 'admin · light', 'admin · dark'],
]) {
  for (const name of ALPHA_TOKENS) {
    const light = themes[lightKey][name];
    const dark = themes[darkKey][name];

    // 8-digit hex: the last byte is the alpha.
    const alpha = (hex) => (hex && hex.length === 9 ? parseInt(hex.slice(7, 9), 16) : null);
    const la = alpha(light);
    const da = alpha(dark);

    const ok = Boolean(light && dark) && light !== dark && la !== null && da !== null && da > la;
    checked++;
    if (!ok) failures++;
    console.log(
      `  ${ok ? 'ok  ' : 'FAIL'}  ${app.padEnd(6)} ${name.padEnd(8)} light ${light ?? '(none)'} (${
        la ?? '?'
      }/255)  dark ${dark ?? '(none)'} (${da ?? '?'}/255) — dark must be heavier`,
    );
  }
}

// ------------------------------------------------------------- glass polarity
/**
 * THE GLASS MUST LEAN THE OPPOSITE WAY IN EACH THEME.
 *
 * This is the single mistake that makes glassmorphism not work, and it is made
 * constantly, because the effect is learned from dark-mode screenshots. On a
 * dark page a white film at 8% is a beautiful sheen. On a LIGHT page the same
 * white film over a white card is nothing at all — the hover state simply
 * vanishes, silently, in the theme most customers are using.
 *
 * So: light theme's glass must be built from a DARK colour, dark theme's from a
 * LIGHT one. Asserted on the RGB half of the 8-digit hex, ignoring the alpha.
 *
 * Also asserted: press must be heavier than hover. If they are the same, a tap
 * gives no evidence it registered and the customer taps again — which on the
 * pay screen is not a cosmetic problem.
 */
console.log('\nglass — light theme darkens, dark theme lightens, press beats hover');
console.log('─'.repeat(78));

const rgbLuma = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const alphaOf = (hex) => (hex && hex.length === 9 ? parseInt(hex.slice(7, 9), 16) : null);

for (const [app, lightKey, darkKey] of [
  ['pwa', 'pwa · light', 'pwa · dark'],
  ['kds', 'kds · light', 'kds · dark'],
  ['admin', 'admin · light', 'admin · dark'],
]) {
  const l = themes[lightKey];
  const d = themes[darkKey];
  const names = ['glass-fill', 'glass-press', 'glass-edge'];

  const missing = names.filter((n) => !l[n] || !d[n]);
  if (missing.length > 0) {
    checked++;
    failures++;
    console.log(`  FAIL  ${app.padEnd(6)} missing glass token(s): ${missing.join(', ')}`);
    continue;
  }

  // Polarity.
  const lightIsDark = names.every((n) => rgbLuma(l[n]) < 0.5);
  const darkIsLight = names.every((n) => rgbLuma(d[n]) > 0.5);
  checked++;
  const polarityOk = lightIsDark && darkIsLight;
  if (!polarityOk) failures++;
  console.log(
    `  ${polarityOk ? 'ok  ' : 'FAIL'}  ${app.padEnd(6)} polarity   light ${l['glass-fill']} (dark wash)  dark ${
      d['glass-fill']
    } (light wash)${polarityOk ? '' : ' — a same-colour film on its own theme is invisible'}`,
  );

  // Press heavier than hover, in both themes.
  for (const [label, t] of [['light', l], ['dark', d]]) {
    const fill = alphaOf(t['glass-fill']);
    const press = alphaOf(t['glass-press']);
    const edge = alphaOf(t['glass-edge']);
    checked++;
    const ok = fill !== null && press !== null && edge !== null && press > fill && edge > fill;
    if (!ok) failures++;
    console.log(
      `  ${ok ? 'ok  ' : 'FAIL'}  ${app.padEnd(6)} ${label.padEnd(6)}     fill ${fill}/255 < press ${press}/255, edge ${edge}/255`,
    );
  }
}

// -------------------------------------------------- the dietary marks, fixed

/**
 * FSSAI marks are a legal requirement, not a palette choice.
 *
 * Asserted as EQUAL across themes rather than as contrast-passing: the point is
 * that no future theme tweak quietly recolours them. A veg mark that has been
 * "harmonised" with a dark palette is a compliance problem and, for a Jain or
 * vegetarian diner, the one mistake in this app that actually matters.
 */
console.log('\ndietary marks — one declaration each, outside both themes');
console.log('─'.repeat(78));
for (const name of ['veg-500', 'nonveg-500', 'egg-500']) {
  // Every literal declaration of this token anywhere in the stylesheet. If a
  // theme block ever gains its own, this count goes to 2 and the test fails —
  // which is the whole point, because the second one would be the tweak.
  const literal = [...pwaCss.matchAll(new RegExp(`^\\s*--${name}:\\s*(#[0-9a-f]{3,8})`, 'gim'))].map(
    (m) => m[1].toLowerCase(),
  );
  // And the Tailwind alias must forward to the token, never restate the value.
  const alias = pwaCss.match(new RegExp(`--color-${name}:\\s*var\\(--${name}\\)`));

  const ok = literal.length === 1 && literal[0] === FIXED[name] && Boolean(alias);
  checked++;
  if (!ok) failures++;
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(12)} ${literal.length}× literal ${
      literal.join(', ') || '(none)'
    }, alias ${alias ? 'forwards' : 'MISSING or inlined'}`,
  );
}

/**
 * `@theme inline` is load-bearing, so assert it.
 *
 * `VegMark` reads `var(--veg-500)` directly. That is only correct under
 * `inline`; switch back to plain `@theme` and the raw tokens still exist, so
 * nothing breaks — but the utilities gain an indirection through a cascade
 * layer, which is the ambiguity this setup was chosen to avoid. Assert the
 * choice rather than leave it to be quietly undone by an editor's autocomplete.
 */
console.log('\nstylesheet structure');
console.log('─'.repeat(78));
for (const [label, css] of [
  ['pwa', pwaCss],
  ['kds', kdsCss],
  ['admin', adminCss],
]) {
  const ok = /@theme\s+inline\s*\{/.test(css);
  checked++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label} uses \`@theme inline\``);
}

console.log('\n' + '═'.repeat(78));
console.log(`${checked} assertions, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
