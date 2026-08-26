import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * The API this dev server proxies to. Named once so the proxy's error handler
 * can say which port it failed to reach.
 */
const TARGET = 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // 5175. The customer PWA is on 5173 and the kitchen board on 5174, so all
    // three run side by side — which is the only way to watch a stall created
    // here appear to a customer there.
    port: 5175,
    // Fail on a clash rather than incrementing. Vite's default would move this
    // to 5176 and leave you with two tabs of the same app wondering why one
    // never updates.
    strictPort: true,
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
      // `ws: true` or socket.io silently degrades to long-polling. See the
      // note in the PWA's config.
      '/realtime': { target: TARGET, ws: true, changeOrigin: true },
    },
  },
});
