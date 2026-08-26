# DESIGN.md — Food Court QR Ordering Platform

Tapvera Technologies · v1.0

The design system, in the format agents read. Drop-in compatible with the
[Stitch DESIGN.md](https://stitch.withgoogle.com/docs/design-md/overview/)
specification and written after an audit against the
[taste-skill redesign checklist](https://github.com/Leonxlnx/taste-skill).

> **Two surfaces, two defaults.** The customer PWA defaults to **light**. The
> kitchen board defaults to **dark**. Both support both, and the reason is not
> preference — see §1.

---

## 1. Visual theme and atmosphere

Two products share one design language and invert it, because they are used in
opposite conditions.

| | Customer PWA | Kitchen board |
| --- | --- | --- |
| Device | A phone held at reading distance | A tablet bolted to a wall, arm's length |
| Light | A bright food court, often near windows | Over a hot range, glare and steam |
| Session | Four minutes, standing or seated | Eight hours, continuous |
| Default theme | **Light** | **Dark** |
| Density | Spacious — one decision at a time | Dense — the whole queue at once |

**Why the defaults are what they are.** A phone screen competes with daylight,
so light-on-dark loses; a dark UI in a bright hall forces the backlight up and
still washes out. A mounted kitchen tablet is the opposite problem — a bright
screen glaring at somebody for an eight-hour shift is fatiguing, and dark
surfaces keep contrast without the glare.

Both surfaces still offer both themes. A customer eating late, or a kitchen with
a window behind the tablet, will want the other one.

**Mood:** appetite-forward but not shouty. Warm red for action, generous
whitespace on the customer side, high contrast and large targets on the vendor
side. Nothing decorative that a hungry person has to read past.

---

## 2. Colour palette and roles

Every colour is a CSS custom property. Themes swap the values, never the names,
so no component knows which theme it is in.

### Brand

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--color-brand-500` | `#E8483F` | `#FF5A50` | Primary action. Buttons, active states |
| `--color-brand-600` | `#CF3A32` | `#E8483F` | Pressed |
| `--color-brand-100` | `#FFDEDB` | `#4A1D1A` | Tint behind the accent |

The red is ours, not a competitor's. Saturation sits at 78% — under the 80%
ceiling the audit sets, so it reads as appetite rather than alarm. **One accent
colour only.** Green, amber and red below are *semantic*, not brand.

### Dietary marks — legally fixed, not styleable

| Token | Value | Role |
| --- | --- | --- |
| `--color-veg-500` | `#0F8A45` | Vegetarian mark |
| `--color-nonveg-500` | `#9C2B1F` | Non-vegetarian mark |
| `--color-egg-500` | `#D99B12` | Contains egg |

India's FSSAI packaging and labelling rules mandate a distinguishing mark. These
do **not** change between themes and are never adjusted for aesthetics.

### Semantic

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--color-fresh-500` | `#1BA55C` | `#2ECC71` | Available, success, ready |
| `--color-warn-500` | `#E5A50A` | `#F5B82E` | Ageing, unpaid, muted audio |
| `--color-alert-500` | `#D92D20` | `#FF5A4E` | Rejected, failed |

Distinct from veg green on purpose: one is a dietary fact, the other a system
state. Collapsing them makes a sold-out vegetarian dish look related to a
sold-out one.

### Surfaces and ink

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--color-page` | `#F4F5F7` | `#0E1116` | Page behind the cards |
| `--color-surface` | `#FFFFFF` | `#171C23` | Card |
| `--color-surface-raised` | `#FFFFFF` | `#1F252E` | Sheets, popovers |
| `--color-ink-900` | `#12151A` | `#F2F5F8` | Headings |
| `--color-ink-700` | `#3C4553` | `#C2CBD6` | Body |
| `--color-ink-500` | `#6E7787` | `#8B97A6` | Secondary |
| `--color-ink-400` | `#9AA2B1` | `#6E7A88` | Tertiary, disabled |
| `--color-ink-200` | `#E7E9EE` | `#2A323C` | Hairline |
| `--color-ink-100` | `#F1F3F6` | `#232A33` | Divider, skeleton |

**Never pure black or pure white as a page.** Dark mode sits at `#0E1116`, a
tinted charcoal; light sits at `#F4F5F7`, not `#FFF`, so white cards have
something to lift off.

**One gray family.** Every neutral is tinted the same cool hue. Mixing warm and
cool grays is the audit's most common finding and it makes a palette look
assembled rather than designed.

---

## 3. Typography

**System stack, deliberately.** `ui-sans-serif, system-ui, -apple-system,
'Segoe UI', Roboto`.

> The audit says to replace system fonts with something with character — Geist,
> Satoshi, Cabinet Grotesk — and it is right that system fonts are anonymous.
> This project declines, and the reason is a number: PRD §16.1 budgets **under
> two seconds from scan to the stall list on 4G**. A webfont on the critical
> path of that screen is 30–40KB and a render-blocking round trip, on a phone
> in a building with concrete walls. Character is worth less here than a menu
> that arrives.
>
> **If this is revisited**, self-host one variable font with `font-display:
> swap` and `<link rel=preload>`, and measure the scan screen before and after.
> Do not add a third-party font CDN — it is a second DNS lookup on the slowest
> screen in the product, and a privacy consideration in a venue.

Hierarchy is carried by size, weight and tracking instead.

| Role | Size | Weight | Tracking | Notes |
| --- | --- | --- | --- | --- |
| Order number (hero) | 52px | 900 | `-0.02em` | The single most-read element |
| Order number (card) | 44px | 900 | `-0.02em` | Payment receipt |
| Screen title | 19px | 700 | `0` | App bar |
| Section heading | 15px | 700 | `0` | Menu category |
| Item name | 15px | 600 | `0` | |
| Price | 15px | 700 | `0` | Tabular figures, always |
| Body | 14px | 400 | `0` | Max ~65 characters |
| Secondary | 13px | 400 | `0` | |
| Label / eyebrow | 11px | 700 | `0.08em` | Uppercase, sparingly |
| Button | 15px | 700 | `0.02em` | Uppercase for primary actions |

**Rules**

- **Tabular figures on every number.** `.tnum`. A price that jitters as digits
  change reads as unstable, and money should never look unstable.
- **Negative tracking above 24px, positive below 12px.** Large type tightens,
  small caps open up.
- `text-wrap: balance` on headings, `pretty` on body. Orphaned words on a
  narrow phone column are the most common typographic tell.
- Body width capped at 65 characters.

---

## 4. Component stylings

### Buttons

| State | Treatment |
| --- | --- |
| Rest | `bg-brand-500`, white, 700, radius 12px, 14px vertical |
| Hover | `bg-brand-600` — **required**, see below |
| Active | `scale(0.98)` |
| Focus | 2px `brand-500` ring at 2px offset. Never removed |
| Disabled | 45% opacity, no pointer events |

> **Hover states are not optional and were the audit's sharpest finding here.**
> This app had 21 `active:` styles and **zero** `hover:`. On a phone that is
> defensible — there is no hover. On the desktop browser everyone actually
> demos in, it makes the entire interface feel dead. Every interactive element
> now carries all four states.

### Cards

Light: `--color-surface` on `--color-page`, no border, soft tinted shadow.
Dark: `--color-surface` with a 1px `--color-ink-200` border and **no** shadow —
shadows do not read on dark surfaces; a hairline does.

Radius varies by nesting: 16px containers, 14px tiles, 12px inner controls.
Uniform radius everywhere is the audit's "generic card look".

### Add control

`− n +` in a pill, overlapping the food tile's lower edge by 16px. The overlap
puts the action at the item's visual centre of gravity so a thumb travelling
down a menu barely moves sideways.

### Shadows

**Tinted, never neutral black.** Light mode shadows carry the page's cool hue;
dark mode uses borders instead.

```
--shadow-card: 0 1px 2px rgb(18 21 26 / 0.04), 0 4px 12px rgb(18 21 26 / 0.05)
--shadow-bar:  0 -2px 16px rgb(18 21 26 / 0.08)
```

---

## 5. Layout principles

**Spacing scale:** 4 · 8 · 12 · 16 · 20 · 24 · 32 · 48. Nothing between.

### Two widths — and why the first answer was wrong

The customer PWA originally had **no max-width container**, so on a desktop
browser it stretched a single order card across 2000px. The first fix was a
30rem phone column, centred. That solved the stretching and produced something
worse: a narrow strip of app marooned in an empty page, with three stall cards
above a screen and a half of nothing.

**A phone simulator is not a desktop layout. It is an apology for not having
one.** So there are two widths, and a screen picks by what it *is*:

```
--width-app    the frame.  100% → 40rem @640px → 70rem @1024px
--width-read   34rem — a readable measure, centred inside the frame
```

| Screen is… | Width | Because |
| --- | --- | --- |
| a **set** — stall list, menu, order history | `app`, laid out as a **grid** | Seeing six stalls at once instead of six stalls and a void is the entire value of the screen |
| a **sequence** — checkout, payment, verify, tracking | `read` | One thing at a time. Widening only makes the eye travel further between a label and its number |

Grid columns: 1 → 2 at `sm` → 3 at `lg`. Below 640px every screen is the single
column it always was, so **the phone case is untouched by all of this**.

Sticky bars and app-bar *contents* follow `--width-read` even inside a wide
frame — a "PAY NOW" button stretched to 70rem is a 1000px banner, not a control.

The kitchen board is different again: it is a tablet in landscape and *should*
fill the viewport. Its grid is `repeat(auto-fill, minmax(320px, 1fr))`.

### Viewport height

`min-height: 100dvh`, never `100vh`. iOS Safari's collapsing toolbar makes
`100vh` taller than the visible viewport, which pushes sticky bottom bars — the
pay button — under the fold.

### Other

- Safe-area insets on every sticky top and bottom bar.
- Bottom padding runs slightly larger than top; optically even, mathematically
  not.
- Buttons pinned to card bottoms so they form a horizontal line regardless of
  content height above.

---

## 6. Depth and elevation

| Level | Light | Dark |
| --- | --- | --- |
| Page | `--color-page`, flat | `--color-page`, flat |
| Card | `--color-surface` + tinted shadow | `--color-surface` + 1px border |
| Sticky bar | `--color-surface` + upward shadow | `--color-surface` + top border |
| Toast | `--color-surface-raised` + shadow | `--color-surface-raised` + border |

One light source, from above. Every shadow in the system points the same way.

---

## 7. Do's and don'ts

**Do**

- Give every interactive element hover, active *and* focus states.
- State the reason next to the colour: a sold-out item is greyed **and**
  labelled. Colour is never the only carrier of meaning (WCAG 1.4.1) — a food
  court is lit badly and roughly 1 in 12 men has some colour vision deficiency.
- Use skeletons shaped like the content, not spinners.
- Keep the order number the largest thing on any screen that has one.

**Don't**

- **Drop a dark panel into a light page.** The audit names this exactly, and
  this app did it: the development OTP panel was near-black in the middle of a
  white card and read as a rendering fault. Use a tinted shade of the same
  palette for contrast.
- Show a number the system does not have. There are no star ratings anywhere
  because nothing collects them, and inventing one marks down a real business.
- Use `window.alert` or `confirm` for anything a customer sees.
- Write "Oops", "Elevate", "Seamless", or an exclamation mark in a success
  message. Be direct and confident.
- Animate `top`/`left`/`width`. `transform` and `opacity` only.

---

## 8. Responsive behaviour

| Breakpoint | Customer — set screens | Customer — sequence screens | Kitchen |
| --- | --- | --- | --- |
| < 640px | Full width, 1 column | Full width | n/a |
| ≥ 640px | Frame 40rem, **2-column grid** | Capped at 34rem, centred | n/a |
| ≥ 768px | 2-column grid | Capped at 34rem | 2-up ticket grid |
| ≥ 1024px | Frame 70rem, **3-column grid** | Capped at 34rem | 3-up ticket grid |
| ≥ 1280px | 3-column grid | Capped at 34rem | 3–4-up ticket grid |

**Touch targets:** 44px minimum on the customer app, **64px** on the kitchen
board — a gloved, wet hand cannot aim, and the cost of a mis-tap there is a
wrong order rather than a wrong tab.

`prefers-reduced-motion` disables the skeleton shimmer and the new-order pulse.
The kitchen's pulse is the only animation in that app and it is load-bearing, so
the border colour continues to carry the meaning when motion is off.

---

## 9. Agent prompt guide

**Quick reference**

```
brand-500     #E8483F light / #FF5A50 dark   identity, borders, icons
brand-fill    #CF3A32 light / #FF5A50 dark   the fill UNDER small text
on-brand      #FFFFFF light / #12151A dark   ← inverts. See below.
veg           #0F8A45   FSSAI mark, identical in both themes, do not restyle
nonveg        #9C2B1F   FSSAI mark, triangle not circle
fresh-500     #1BA55C light / #2ECC71 dark   ready, available
warn-500      #E5A50A light / #F5B82E dark   ageing, unpaid
alert-500     #C92418 light / #FF5A4E dark   rejected, failed
page          #F4F5F7 light / #0E1116 dark
surface       #FFFFFF light / #171C23 dark
banner-*      wait / ready / attention / alert — full-bleed, always white text
```

**The one rule that is not obvious:** `bg-brand-500 text-white` fails AA in
*both* themes (3.87:1 and 3.07:1). Filled brand surfaces use `bg-brand-fill
text-on-brand`, and `on-brand` **inverts to near-black in dark mode** — a
saturated red is bright, so dark-on-light is correct inside a dark theme.

Every pair above is asserted in `tests/design/contrast.mjs` (59 assertions).
`tests/design/tokens.mjs` proves no screen references a token that does not
exist — a misspelt Tailwind class renders nothing and is invisible in light
mode. Run both with `npm run test:design`.

**Prompts that fit this system**

> Build a customer-facing screen for the food court PWA. Light theme by
> default, capped at 30rem and centred. System font stack. One accent (#E8483F).
> Cards on a tinted page, tinted shadows, no borders. Tabular figures on every
> number. Hover, active and focus on every control. Colour never the only
> signal.

> Build a kitchen board panel. Dark theme by default, full viewport width,
> `auto-fill minmax(320px, 1fr)` grid. Surfaces get a 1px border, not a shadow.
> 64px minimum touch targets. State names in words on every status strip, not
> just colour.

**Theme switching**

Themes are a `data-theme` attribute on `<html>` with values `light` and `dark`.
Every colour is a custom property, so no component branches on the theme. The
default comes from the app, not the OS: customer light, kitchen dark. A stored
choice overrides it; `prefers-color-scheme` is the fallback only when neither
exists.
