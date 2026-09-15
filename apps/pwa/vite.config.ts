import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * When this dev server started, baked into the bundle.
 *
 * WHY THIS EXISTS
 *
 * "I restarted the server and it is still showing the old UI" has two completely
 * different causes and no way to tell them apart by looking:
 *
 *   the SERVER is stale   an old `vite` process still owns the port, so the
 *                         restart went to a different one or failed
 *   the BROWSER is stale  the tab was open when the server died. Its HMR socket
 *                         is gone, so it keeps rendering the last DOM it built
 *                         and never learns that anything changed. The page looks
 *                         completely alive.
 *
 * The second is far commoner and looks exactly like the first. This stamp is
 * evaluated when Vite loads its config — that is, at server start — so the
 * browser prints the moment the code it is running was served. Older than your
 * last restart means the TAB is stale and a reload fixes it.
 */
const STARTED_AT = new Date().toISOString();

/**
 * The API this dev server proxies to. Named once so the proxy's error handler
 * can say which port it failed to reach.
 */
const TARGET = 'http://localhost:3000';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),

    /*
     * ========================================================================
     * THE SERVICE WORKER — SHELL AND MENU, AND NOTHING ELSE
     * ========================================================================
     *
     * `docs/tech/frontend.md` states the policy this implements:
     *
     *     Offline — shell + menu cache only. Ordering requires connectivity.
     *               NEVER queue an order client-side.
     *
     * The second sentence is the important one, and it is a product decision
     * rather than a technical limit. An order that syncs ten minutes later is
     * food nobody is standing there to collect, cooked for a customer who has
     * left the building. So there is no Background Sync here, no write queue,
     * and no mutation ever touches a cache.
     *
     * WHAT MAKES "NEVER CACHE AN ORDER" TRUE
     *
     * Not a denylist. `runtimeCaching` below matches exactly three things —
     * the stall list, a menu, and menu photographs — and Workbox leaves any
     * request matching no route entirely alone, straight to the network as if
     * no service worker existed. Orders, payments, OTPs and checkout are not
     * excluded by a rule that somebody could edit; they are uncovered by
     * construction, which is the difference between a policy and a promise.
     *
     * `tests/conformance/sw-cache-policy.mjs` asserts that from the outside.
     */
    VitePWA({
      /*
       * The customer never sees an "update available" prompt.
       *
       * A prompt assumes somebody will read it and decide. This app is open
       * for four minutes in the hands of a person holding a tray, and a stale
       * shell they declined to update becomes a bug report about a feature
       * that shipped weeks ago. `autoUpdate` takes the new bundle on the next
       * load and says nothing.
       */
      registerType: 'autoUpdate',

      /*
       * OFF IN DEVELOPMENT, DELIBERATELY.
       *
       * Read the note on `STARTED_AT` below: this repo already loses time to
       * "I restarted the server and it still shows the old UI", where a tab
       * outlives its dev server and renders a DOM that nothing will ever
       * update. A service worker makes that failure strictly worse — it serves
       * the old bundle from disk, so the stale page now survives a reload AND
       * a server restart, and still looks completely alive.
       *
       * The cost is that the offline path is exercised by `vite preview` on a
       * real build rather than by `vite dev`. That is where it should be
       * tested anyway: the dev server has no precache manifest to be wrong
       * about.
       */
      devOptions: { enabled: false },

      includeAssets: ['apple-touch-icon.png'],

      manifest: {
        id: '/',
        name: 'Food Court Ordering',
        short_name: 'Order',
        description: 'Scan the code on your table, order from any stall, pay once.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        /*
         * The PAGE colour, not the brand colour — the same value `index.html`
         * sets for `theme-color`. A red strip above a white app reads as a
         * banner that failed to load; see the note there.
         */
        theme_color: '#f4f5f7',
        background_color: '#f4f5f7',
        lang: 'en-IN',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          /*
           * A separate file rather than `purpose: 'any maskable'` on the one
           * above. A launcher may crop a maskable icon to a circle, taking the
           * outer 20%, and an icon drawn to fill its square loses its edges to
           * that crop. This one is drawn smaller to survive it — using a single
           * file for both purposes means choosing which of the two looks wrong.
           */
          {
            src: '/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },

      workbox: {
        // The shell: everything needed to render a frame with no network at all.
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],

        /*
         * A deep link with no network still gets the app.
         *
         * Every route in this SPA is served by `index.html`, so an offline
         * reload of `/order/abc` has to resolve to the precached shell rather
         * than the browser's offline page. The screen then fails its own fetch
         * and says so in the app's own words, which is a far better answer than
         * a page that never loaded.
         */
        navigateFallback: '/index.html',

        /*
         * ...but a navigation is not an API call, and the API must never be
         * answered with HTML. `/realtime` is the socket.io endpoint, which a
         * fallback would break outright.
         */
        navigateFallbackDenylist: [/^\/api\//, /^\/realtime/],

        /*
         * Take over immediately rather than on the next tab.
         *
         * With `autoUpdate` the alternative is a worker that installs and then
         * waits for every existing tab to close — on a phone, effectively never.
         */
        clientsClaim: true,
        skipWaiting: true,

        runtimeCaching: [
          /*
           * ------------------------------------------------------------------
           * 1. THE STALL LIST.  NetworkFirst.
           * ------------------------------------------------------------------
           * Which stalls exist changes rarely; whether they are OPEN changes
           * all day. NetworkFirst so a connected customer always sees the
           * truth, with the cache as the answer to "the basement has no
           * signal" rather than as the primary source.
           */
          {
            urlPattern: /\/api\/v1\/food-courts\/[^/]+\/vendors$/,
            method: 'GET',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'court-vendors',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 },
              cacheableResponse: { statuses: [200] },
            },
          },

          /*
           * ------------------------------------------------------------------
           * 2. A MENU.  NetworkFirst.
           * ------------------------------------------------------------------
           * WHY A STALE PRICE IS SAFE HERE, AND NOWHERE ELSE
           *
           * A cached menu can be wrong about price and availability, and
           * showing a wrong price to somebody about to order would normally be
           * unacceptable. It is survivable only because the basket is re-priced
           * server-side at `POST /checkout/validate` before any money moves: a
           * stale price is corrected on the checkout screen, not charged.
           *
           * That is a guarantee about the SERVER. If checkout ever stops
           * re-pricing, this cache silently becomes a way to undercharge — so
           * the age is capped at 24h for that reason, not for storage.
           */
          {
            urlPattern: /\/api\/v1\/vendors\/[^/]+\/menu$/,
            method: 'GET',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'vendor-menu',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 40, maxAgeSeconds: 60 * 60 * 24 },
              cacheableResponse: { statuses: [200] },
            },
          },

          /*
           * ------------------------------------------------------------------
           * 3. MENU PHOTOGRAPHS.  CacheFirst.
           * ------------------------------------------------------------------
           * Immutable by URL — Cloudinary encodes the transform into the path,
           * so a changed image is a changed URL and this can never serve a
           * stale one. CacheFirst rather than NetworkFirst because a photograph
           * is the heaviest thing on the menu screen and the cheapest to reuse.
           *
           * On a court with no route to the internet these never populate at
           * all and the menu renders without pictures. That is an argument for
           * moving image hosting on-prem, not for changing this rule.
           */
          {
            urlPattern: /^https:\/\/res\.cloudinary\.com\//,
            method: 'GET',
            handler: 'CacheFirst',
            options: {
              cacheName: 'menu-images',
              expiration: { maxEntries: 120, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  define: {
    __DEV_SERVER_STARTED_AT__: JSON.stringify(STARTED_AT),
  },
  server: {
    port: 5173,
    // Fail loudly on a port clash instead of quietly moving to the next free
    // one. Vite's default is to increment, which means a stale dev server on
    // 5173 sends this app to 5174 — and you end up with two browser tabs
    // showing the same application, wondering why the other one never updates.
    strictPort: true,
    // Proxy /api to the Nest server so the browser sees one origin in dev.
    // This is not just convenience: same-origin means no preflight, no CORS
    // subtleties, and the dev setup matches production, where the PWA is
    // served from the same host as the API.
    proxy: {
      '/api': { target: TARGET, changeOrigin: true,
      /*
       * ====================================================================
       * WHOSE 502 IS IT?
       * ====================================================================
       *
       * When this proxy cannot reach :3000 it answers 502 Bad Gateway — and
       * so does the API's own exception filter, for PAYMENT_PROVIDER_REJECTED.
       * In the browser the two are indistinguishable: same status, same empty
       * body, same URL on this dev server's port.
       *
       * That cost four rounds of debugging a payment. A POST to
       * /payment-intent returned 502 and it was read as "Cashfree refused the
       * order", so the payload was dissected against the live sandbox — the
       * amount, the split allocation, the vendor, the full real `createIntent`
       * body, the idempotency key. Every one of them passed, because the
       * request was never sent. The API had restarted (this repo runs it under
       * `node --watch`, so every source edit does) and the proxy was answering
       * on its behalf.
       *
       * The tell was always there and was invisible: an API 502 is ALWAYS
       * preceded by a `cashfree rejected a request` log line, and there was
       * none. A missing log line is not something anyone notices.
       *
       * So this proxy now says who it is. `x-proxy-error: upstream-unreachable`
       * and a body naming the port make the difference obvious from the
       * network tab alone, with no correlation of timestamps against a
       * terminal.
       */
      configure: (proxy) => {
        proxy.on('error', (err, _req, res) => {
          const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
          if (!('writeHead' in res)) return; // a socket (ws upgrade), not a response
          res.writeHead(502, {
            'Content-Type': 'application/json',
            'x-proxy-error': 'upstream-unreachable',
          });
          res.end(
            JSON.stringify({
              error: 'DEV_PROXY_UPSTREAM_UNREACHABLE',
              message:
                `The Vite dev proxy could not reach the API at ${TARGET} (${code}). ` +
                `This 502 is from the proxy, NOT from the API and NOT from the payment ` +
                `provider. The API is probably down, still booting, or mid-restart — it ` +
                `runs under \`node --watch\`, so every source edit restarts it.`,
              hint: 'Check the terminal running `npm run dev`.',
            }),
          );
        });
      },
      },
      /*
        `ws: true` is not optional here. Without it Vite proxies the initial
        polling handshake and then refuses the Upgrade, so socket.io falls back
        to long-polling and looks like it works — slower, chattier, and only in
        development, which is the worst place for a difference to hide.
      */
      '/realtime': { target: TARGET, ws: true, changeOrigin: true },
    },
  },

  /*
   * ==========================================================================
   * `vite preview` NEEDS ITS OWN PROXY, AND NOT KNOWING THAT COSTS AN HOUR
   * ==========================================================================
   *
   * `server.proxy` above applies to `vite dev` and to nothing else. Preview
   * runs a different server with a separate `preview.proxy`, and an absent one
   * is not an error — it simply serves the built files and answers every
   * /api request with the SPA fallback.
   *
   * So the app loads, looks perfect, and every call returns index.html. The
   * client parses HTML as JSON and reports a malformed response, which reads
   * like a broken API rather than a missing proxy line.
   *
   * This matters more here than it would in most projects, because preview is
   * the ONLY place the service worker runs: it is disabled in dev on purpose
   * (see the note on `devOptions`). Testing offline behaviour means building
   * and previewing, so the one command that exercises the feature was also the
   * one command with no route to the API.
   *
   * Same table as the dev server, deliberately. Two proxy configs that are
   * meant to be identical will not stay identical.
   */
  preview: {
    port: 4173,
    strictPort: true,
    proxy: {
      '/api': { target: TARGET, changeOrigin: true },
      '/realtime': { target: TARGET, ws: true, changeOrigin: true },
    },
  },
});
