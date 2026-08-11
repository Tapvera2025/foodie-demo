# Frontend Technology

← [`tech.md`](../../tech.md) · Derived from PRD v5.2 §8, §10, §33 · Screens & Copy Deck v1.1

Three surfaces, **one codebase, three Vite build targets**. They share the money
formatter, the API client, the design tokens and the copy catalogue. They share
almost nothing else — a kitchen tablet and a lunch customer's phone have opposite
constraints.

| Target         | Entry           | Users                            | Hard constraint                                     |
| -------------- | --------------- | -------------------------------- | --------------------------------------------------- |
| `apps/pwa`     | Customer        | Anyone, once, on their own phone | First paint on a mid-range Android over court wi-fi |
| `apps/kds`     | Vendor kitchen  | Trained, all day, mounted tablet | Legible and tappable with wet hands in bad light    |
| `apps/console` | Manager + admin | Staff, desktop                   | Dense data, keyboard-operable                       |

---

## Core

| Concern      | Choice                | Version | Why                                                              |
| ------------ | --------------------- | ------- | ---------------------------------------------------------------- |
| Framework    | React                 | 19      | Team familiarity. Hiring pool.                                   |
| Build        | Vite                  | 6       | Fast dev loop; per-target builds from one repo.                  |
| Language     | TypeScript            | 5.6+    | `strict`. API types generated from `openapi.yaml`.               |
| Routing      | React Router          | 7       | Data routers. Well understood.                                   |
| Server state | TanStack Query        | 5       | See below — this is a correctness choice, not a convenience one. |
| Client state | Zustand               | 5       | Cart draft and UI state only. Nothing server-owned.              |
| Styling      | Tailwind CSS          | 4       | Design tokens as CSS variables; no runtime CSS-in-JS.            |
| Forms        | React Hook Form + Zod | 7 / 3   | Same Zod schemas as the backend where shapes match.              |
| Icons        | lucide-react          | latest  | Tree-shakeable.                                                  |

### Why TanStack Query is a correctness decision

PRD **CUS-TRK-04**: _"On reconnection the client re-fetches authoritative state
rather than replaying missed events."_

Socket events are hints. The client must never derive order state from event
ordering, because Socket.IO can deliver twice or out of order (PRD §23). So:

```ts
// A socket event NEVER writes state. It invalidates, and the query refetches.
socket.on('order.status_changed', ({ orderId }) => {
  queryClient.invalidateQueries({ queryKey: ['order', orderId] });
});
```

Any state library where a socket handler can write the order status directly is
the wrong tool. This pattern is not negotiable.

---

## PWA specifics

| Concern        | Choice                             | Notes                                                             |
| -------------- | ---------------------------------- | ----------------------------------------------------------------- |
| Service worker | `vite-plugin-pwa` (Workbox)        | Precache the shell; **never** cache order or payment responses.   |
| Web Push       | `web-push` (server) + native API   | Android and desktop Chrome only in practice — see below.          |
| Wake lock      | `navigator.wakeLock`               | PRD CUS-TRK-02. Feature-detect; degrade silently.                 |
| Offline        | Shell + menu cache only            | Ordering requires connectivity. Never queue an order client-side. |
| QR scanning    | None — the phone camera handles it | We are the _destination_ of a scan, not a scanner.                |

### The iOS constraint, in code

Web Push on iOS Safari works **only** if the PWA is installed to the Home Screen.
No lunch customer will do that. The client must report this honestly so the
notification ladder (PRD §10) can advance to WhatsApp:

```ts
export function pushViability(): 'ok' | 'ios_not_installed' | 'unsupported' {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
  const installed = window.matchMedia('(display-mode: standalone)').matches;
  if (isIOS && !installed) return 'ios_not_installed'; // report as SKIPPED, not SENT
  return 'ok';
}
```

Reporting an uninstalled-iOS push as `SENT` is the single easiest way to make the
notification metrics lie to you for a whole pilot.

---

## Performance budget

Enforced in CI on the customer PWA. Derived from PRD §24.

| Metric                             | Budget           | Measured on                      |
| ---------------------------------- | ---------------- | -------------------------------- |
| JS transferred, initial route      | ≤ 170 KB gzipped | Lighthouse CI                    |
| Largest Contentful Paint           | ≤ 2.0 s          | Moto G-class device, 4G throttle |
| Menu interactive                   | ≤ 2.0 s          | Same                             |
| QR resolve → court context painted | ≤ 1.0 s          | Same                             |

Route-level code splitting is mandatory. The console bundle must never be
reachable from the customer PWA entry.

---

## Accessibility

PRD §33 requires WCAG 2.2 AA on the customer PWA, gated in CI.

| Tool                             | Where                                                 |
| -------------------------------- | ----------------------------------------------------- |
| `eslint-plugin-jsx-a11y`         | Lint                                                  |
| `@axe-core/playwright`           | Every PWA route in CI; fails on serious or critical   |
| `vitest-axe`                     | Component tests                                       |
| Manual VoiceOver / TalkBack pass | Before go-live and whenever the ordering flow changes |

Two rules the linter cannot catch:

- **No information by colour alone** (A11Y-05). The veg / non-veg mark carries
  shape _and_ label _and_ colour. Roughly 1 in 12 men has a colour vision
  deficiency, and for many customers this is a dietary or religious requirement.
- **Order state changes are announced** via a polite live region (A11Y-06), so a
  screen reader user hears "ready to collect" without re-navigating.

---

## KDS-specific

Different product, same repo.

- **Touch targets ≥ 48px, spaced.** Greasy fingers, fast hands.
- **No hover states.** There is no cursor.
- **Audio + persistent visual** for every alert (A11Y-12) — a deaf operator must
  be able to run the stall from the screen alone.
- **Wake lock always held** while the queue is open.
- **Optimistic updates with visible rollback.** A failed stock toggle must say so
  loudly (`kds.stock.failed`), because the customer can still see the item.
- **Auto-acknowledge on paint.** The KDS calls `POST /orders/{id}/acknowledge`
  itself once the card renders (TDD §9.1). No human taps anything. This is what
  cancels the escalation ladder.

---

## i18n

English (India) only at pilot, but **every string goes through the catalogue from
day one**. The copy deck (Screens & Copy v1.1) already assigns a key to all 90
strings.

- Library: `i18next` + `react-i18next`
- No literal user-facing string in a component. Ever. Lint rule enforces it.
- Adding Hindi or Gujarati later is then a data change, not a refactor.

---

## Rejected

| Rejected                               | Why                                                                                                                                                             |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Next.js                                | We need a static PWA on a CDN plus a separate API. SSR buys nothing when every meaningful screen is authenticated and dynamic, and it adds a server to operate. |
| Redux Toolkit                          | Almost all state here is server state. See the TanStack note above.                                                                                             |
| CSS-in-JS (styled-components, Emotion) | Runtime cost on the device class we care about.                                                                                                                 |
| Component library (MUI, Chakra)        | We need ~18 components (Screens & Copy → Components sheet), heavily customised for kitchen and daylight use. A library would be fought more than used.          |
| Capacitor / React Native wrapper       | PRD §6.3 rules out native. A wrapper reintroduces app-store review for no gain.                                                                                 |
| Client-side order queueing             | An order that exists only on a phone is an order that does not exist.                                                                                           |
