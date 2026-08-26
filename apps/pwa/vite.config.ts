import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

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
  plugins: [react(), tailwindcss()],
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
});
