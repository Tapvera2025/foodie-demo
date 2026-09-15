/**
 * ============================================================================
 * ONE PLACE THAT DECIDES WHICH PAYMENT PROVIDER IS IN USE
 * ============================================================================
 *
 * THE BUG THIS EXISTS TO END
 *
 * There were two. `payment.module.ts` read `PAYMENTS_PROVIDER` and built the
 * configured adapter; `workers/index.ts` did this, unconditionally:
 *
 *     const provider = new StubPaymentProvider({ … });
 *
 * So with `PAYMENTS_PROVIDER=cashfree` the API talked to Cashfree and the
 * WORKER talked to a stub — in the same deployment, about the same orders.
 *
 * That is not a cosmetic inconsistency. The worker owns the money that moves
 * without anybody watching:
 *
 *   - it initiates and retries REFUNDS, so a rejected order's refund was
 *     "processed" against a stub and the customer's money never actually left
 *     the platform's account
 *   - it captures on acknowledgement under ON_ACKNOWLEDGED
 *   - it now reconciles payments the webhook never delivered
 *
 * Every one of those silently did nothing real, and the stub's cheerful
 * successes made the logs look correct.
 *
 * It survived because the stub was the only provider that existed. The moment
 * a second one arrived, the duplication became a live defect — and a second
 * copy of a decision is exactly the shape of thing that is right until the day
 * it matters.
 *
 * So: one function, both call sites. A third caller cannot get it wrong either.
 */

import type { Config } from '../platform/config.js';
import { CashfreePaymentProvider } from './providers/cashfree.provider.js';
import { StubPaymentProvider } from './providers/stub.provider.js';
import { PosPaymentProvider } from './providers/pos.provider.js';
import { LanTerminal } from './providers/pos/lan.terminal.js';
import { MockTerminal } from './providers/pos/mock.terminal.js';
import type { PosTerminal } from './providers/pos/terminal.port.js';
import type { PaymentProvider } from './provider.interface.js';

export function buildPaymentProvider(cfg: Config): PaymentProvider {
  switch (cfg.PAYMENTS_PROVIDER) {
    case 'cashfree': {
      /*
       * Fail at BOOT, not at checkout. A missing key discovered when a customer
       * taps Pay is a lost order and a support ticket; discovered here it is a
       * process that will not start, which is loud and nobody's lunch.
       */
      const missing = (
        [
          ['CASHFREE_APP_ID', cfg.CASHFREE_APP_ID],
          ['CASHFREE_SECRET_KEY', cfg.CASHFREE_SECRET_KEY],
        ] as const
      )
        .filter(([, v]) => !v)
        .map(([k]) => k);

      if (missing.length > 0) {
        throw new Error(
          `PAYMENTS_PROVIDER=cashfree but ${missing.join(' and ')} ${
            missing.length === 1 ? 'is' : 'are'
          } not set. Cashfree issues separate credentials per environment — ` +
            `make sure these match CASHFREE_ENV=${cfg.CASHFREE_ENV}.`,
        );
      }

      /*
       * The platform-wide DEFAULT mode. `vendor.settlement_mode` decides each
       * order and is snapshotted onto it; this only says which behaviour the
       * adapter falls back to when an order carries no snapshot.
       */
      /*
       * THE RETURN URL FALLS BACK, AND IN DEVELOPMENT IT FALLS BACK TO THE PWA.
       *
       * Cashfree's v3 checkout will not render for an order that has no
       * `return_url`, and until this existed the return URL was gated on
       * `CASHFREE_PUBLIC_BASE_URL` — a tunnel nobody has running locally. The
       * result was that local checkout could not work at all, with a perfectly
       * valid session, and the error said only "Something went wrong".
       *
       * The chain, most specific first:
       *
       *   1. CASHFREE_RETURN_BASE_URL   set it explicitly and it wins
       *   2. CASHFREE_PUBLIC_BASE_URL   correct in production, where the apps
       *                                 are served same-origin with the API
       *   3. localhost:5173 IN DEV ONLY the PWA's dev server, per its
       *                                 vite.config.ts `strictPort` — the
       *                                 browser is what follows this, and the
       *                                 browser is on the same machine
       *
       * Step 3 is deliberately not available in production: a real deployment
       * silently returning customers to localhost would be worse than failing,
       * and `buildPaymentProvider` already refuses to start on missing
       * production configuration rather than guessing.
       */
      const returnBaseUrl =
        cfg.CASHFREE_RETURN_BASE_URL ??
        cfg.CASHFREE_PUBLIC_BASE_URL ??
        (cfg.NODE_ENV !== 'production' ? 'http://localhost:5173' : undefined);

      return new CashfreePaymentProvider({
        mode: 'PLATFORM_COLLECT',
        appId: cfg.CASHFREE_APP_ID!,
        secretKey: cfg.CASHFREE_SECRET_KEY!,
        env: cfg.CASHFREE_ENV,
        apiVersion: cfg.CASHFREE_API_VERSION,
        publicBaseUrl: cfg.CASHFREE_PUBLIC_BASE_URL,
        returnBaseUrl,
      });
    }

    case 'stub':
      // Refuses to be the production provider. A stub that ran in production
      // would confirm every payment without anyone paying, and it would do it
      // quietly — PRD §2.2 exactly.
      if (cfg.NODE_ENV === 'production') {
        throw new Error(
          'PAYMENTS_PROVIDER=stub in production. The stub confirms payments nobody made. ' +
            'Choose an aggregator (PRD §19 decision 2) before deploying.',
        );
      }
      return new StubPaymentProvider({
        mode: 'PLATFORM_COLLECT',
        secret: cfg.PAYMENTS_WEBHOOK_SECRET,
      });

    case 'pos': {
      /*
       * Same boot-time refusal as Cashfree, and the POS version is worse to
       * discover late: a missing address does not fail at checkout, where the
       * customer is still holding their phone. It fails at the counter, after
       * they have walked over, with a cashier who cannot do anything about it.
       */
      const missing = (
        [
          ['POS_TERMINAL_HOST', cfg.POS_TERMINAL_HOST],
          ['POS_TERMINAL_ID', cfg.POS_TERMINAL_ID],
          ['POS_MERCHANT_ID', cfg.POS_MERCHANT_ID],
        ] as const
      )
        .filter(([, v]) => !v)
        .map(([k]) => k);

      if (cfg.POS_TERMINAL_KIND === 'lan' && missing.length > 0) {
        throw new Error(
          `PAYMENTS_PROVIDER=pos with POS_TERMINAL_KIND=lan, but ${missing.join(' and ')} ` +
            `${missing.length === 1 ? 'is' : 'are'} not set. The terminal needs a fixed ` +
            'address on the intranet — give the machine a DHCP reservation and set ' +
            'POS_TERMINAL_HOST to it.',
        );
      }

      const terminal: PosTerminal =
        cfg.POS_TERMINAL_KIND === 'mock'
          ? (() => {
              // The mock takes no money. It exists so the counter flow, the
              // ambiguous-charge path and the reconciliation screen can be
              // built and chaos-tested without hardware — the same argument
              // `stub.provider.ts` makes for itself, one layer down.
              if (cfg.NODE_ENV === 'production') {
                throw new Error(
                  'POS_TERMINAL_KIND=mock in production. The mock terminal approves payments ' +
                    'nobody made, and it does it quietly. Set POS_TERMINAL_KIND=lan and point ' +
                    'POS_TERMINAL_HOST at the real machine.',
                );
              }
              return new MockTerminal();
            })()
          : new LanTerminal({
              host: cfg.POS_TERMINAL_HOST!,
              port: cfg.POS_TERMINAL_PORT,
              terminalId: cfg.POS_TERMINAL_ID!,
              merchantId: cfg.POS_MERCHANT_ID!,
              wireFormatVerified: cfg.POS_TERMINAL_WIRE_VERIFIED,
              nodeEnv: cfg.NODE_ENV,
            });

      return new PosPaymentProvider({
        terminal,
        // The same secret the ingest path verifies with. The POS provider signs
        // its own events and they re-enter through `verifyAndParseWebhook`, so
        // that an order can still only be confirmed by `decideWebhookAction`.
        secret: cfg.PAYMENTS_WEBHOOK_SECRET,
        mode: cfg.POS_SETTLEMENT_MODE,
      });
    }

    case 'razorpay-route':
    case 'vendor-direct':
      // No adapter exists yet, and an empty one that returned success would be
      // far worse than this. PRD §19 decision 2 is still open.
      throw new Error(
        `PAYMENTS_PROVIDER=${cfg.PAYMENTS_PROVIDER} has no adapter yet. ` +
          'The aggregator decision is open — see PRD §19.1 for the selection criteria.',
      );
  }
}
