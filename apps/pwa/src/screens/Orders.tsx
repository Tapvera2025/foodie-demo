import { useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';

import { api, useIsSignedIn } from '../lib/api';
import { formatINR } from '../lib/money';
import { useCart } from '../lib/cart';
import { useFallbackInterval, ORDER_CHANGED, useRealtime } from '../lib/realtime';
import { theme } from '../lib/theme';
import { Card, EmptyState, ErrorState, Pill, Screen, Spinner, orderStatusLabel } from './ui';

/**
 * The customer's own screen: who they are, and everything they have ordered.
 *
 * WHY THIS IS "YOUR ORDERS" AND NOT "PROFILE"
 *
 * There is almost nothing in the account. A first name and a phone number — no
 * address, no saved cards, no preferences. DR-0001's reasoning still holds for
 * all of those: a customer buying a plate of noodles will not fill in a form.
 *
 * The name was added because it is one optional field that buys something
 * concrete at the counter, where a stall can call a person rather than a
 * number. It is never required, and a customer who skips it gets exactly the
 * experience they got before it existed.
 *
 * A screen titled "Profile" would still promise settings that do not exist, so
 * this is an order list with who you are at the top. That is the whole account,
 * stated plainly.
 *
 * SCOPE: THIS SESSION, NOT ALL TIME
 *
 * The orders come from the four-hour session, which is the realistic window for
 * a food-court visit and covers every order in it. Cross-session history —
 * "what did I eat here last Tuesday" — needs the customer token to be checked
 * server-side, and there is no customer guard yet. Flagged rather than faked:
 * showing a list titled "all your orders" that silently drops everything older
 * than four hours would be worse than saying which window this is.
 */
export function Orders() {
  /* `FALLBACK_MS` while the socket is up, the old interval when it is not. */
  const fallbackMs = useFallbackInterval();

  const navigate = useNavigate();
  const { sessionId, customerPhone, customerName, foodCourtName } = useCart();
  const mode = useSyncExternalStore(theme.subscribe, theme.get, theme.get);
  const signedIn = useIsSignedIn();

  useRealtime(ORDER_CHANGED, [['session-orders']], Boolean(sessionId) && signedIn);

  const q = useQuery({
    queryKey: ['session-orders', sessionId],
    queryFn: () => api.sessionOrders(sessionId!),
    /*
      Gated on the CUSTOMER TOKEN, not on the session.

      A session exists from the moment somebody scans a poster; the token
      exists only after they verify a number. Gating on `sessionId` alone meant
      every browsing visitor polled their own orders every four seconds and got
      a 401 every time — hundreds of identical auth failures in the API log,
      from a client asking a question it had no right to ask.

      Nobody unverified has orders, so there is nothing to miss.
    */
    enabled: Boolean(sessionId) && signedIn,
    // Slower than the strip on the browse screens: somebody reading a history
    // list is not waiting on a state change, and four-second polling on a
    // screen nobody is watching for updates is just battery.
    // 8s -> FALLBACK_MS, driven by `order.changed` instead. See lib/realtime.ts.
    refetchInterval: fallbackMs,
  });

  const orders = q.data?.orders ?? [];

  return (
    <Screen title="Your orders" subtitle={foodCourtName ?? undefined} back width="full">
      {/* Account and appearance sit side by side once there is room: two short
          cards stacked on a wide screen is the shape that made this look empty. */}
      <div className="grid gap-4 mb-4 md:grid-cols-2 items-start">
      {/* The account, in full. */}
      <Card className="p-4 flex items-center gap-3.5">
        <div className="size-11 rounded-full bg-brand-50 grid place-items-center shrink-0">
          <svg viewBox="0 0 24 24" className="size-6 text-brand-700" fill="none" aria-hidden>
            <circle cx="12" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.8" />
            <path
              d="M4.5 20a7.5 7.5 0 0115 0"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </div>
        <div className="min-w-0">
          {customerPhone ? (
            <>
              {/*
                The NAME leads when there is one, and the number becomes the
                second line. A profile whose headline is a masked phone number
                reads as a record; one whose headline is your name reads as an
                account. `tnum` moves down with the number, since a name has no
                digits to align.
              */}
              <p className="font-bold text-[15px] text-ink-900">
                {customerName ?? <span className="tnum">{customerPhone}</span>}
              </p>
              <p className="text-[12px] text-ink-500 mt-0.5">
                {customerName ? (
                  <>
                    <span className="tnum">{customerPhone}</span> · verified
                  </>
                ) : (
                  'Verified · used only to reach you'
                )}
              </p>
            </>
          ) : (
            <>
              <p className="font-bold text-[15px] text-ink-900">Not verified yet</p>
              <p className="text-[12px] text-ink-500 mt-0.5">
                You will be asked for a number when you add your first item.
              </p>
            </>
          )}
        </div>
      </Card>

      {/*
        Appearance, as a LABELLED control rather than only the bare icon in the
        app bar.
        The icon on the stall list is for the person who already knows what it
        does. This row is for the person who does not — it is the one screen in
        the app that is about the customer rather than about food, so it is
        where somebody goes looking when the screen is hard to read.
      */}
      <Card className="p-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-bold text-[15px] text-ink-900">Appearance</p>
          <p className="text-[12px] text-ink-500 mt-0.5">
            {mode === 'light' ? 'Light — easier in daylight' : 'Dark — easier at night'}
          </p>
        </div>
        <div className="flex rounded-xl border border-ink-200 overflow-hidden shrink-0">
          {(['light', 'dark'] as const).map((m) => (
            <button
              key={m}
              onClick={() => theme.set(m)}
              aria-pressed={mode === m}
              /* Square on purpose: the segmented control's own
                 `rounded-xl overflow-hidden` cuts the two halves. */
              className={`pressable glass-hover rounded-none px-4 py-2 text-[13px] font-bold capitalize ${
                mode === m ? 'bg-brand-fill text-on-brand' : 'bg-surface text-ink-700'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      </Card>
      </div>

      {q.isLoading ? <Spinner label="Loading your orders…" /> : null}
      {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}

      {q.data && orders.length === 0 ? (
        <EmptyState
          title="No orders yet"
          body="Pick a stall and your orders will appear here, live."
        />
      ) : null}

      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 items-start">
        {orders.map((o) => {
          const s = orderStatusLabel(o.status);
          const when = new Date(o.placedAt);

          return (
            <li key={o.orderId}>
              <button onClick={() => navigate(`/order/${o.orderId}`)} className="pressable w-full text-left">
                {/* `interactive`, not `className="glass-hover"` — the film has to
                    follow the card's radius, and the radius lives inside Card. */}
                <Card interactive className="p-4">
                  <div className="flex items-baseline gap-3">
                    <span className="text-[17px] font-black text-ink-900 tnum">
                      {o.orderNumber}
                    </span>
                    <span className="min-w-0 flex-1 text-[14px] text-ink-700 truncate">
                      {o.vendorName}
                    </span>
                    <span className="text-[15px] font-bold text-ink-900 tnum shrink-0">
                      {formatINR(o.totalPayablePaise)}
                    </span>
                  </div>

                  <div className="flex items-center gap-2 mt-2.5">
                    <Pill tone={s.tone === 'go' ? 'good' : s.tone === 'warn' ? 'warn' : 'neutral'}>
                      {s.text}
                    </Pill>
                    <span className="text-[12px] text-ink-400 tnum">
                      {when.toLocaleTimeString('en-IN', {
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: true,
                      })}
                    </span>
                    <span className="ml-auto text-[12px] font-semibold text-brand-700">
                      {s.tone === 'go' ? 'COLLECT' : 'TRACK'}
                    </span>
                  </div>
                </Card>
              </button>
            </li>
          );
        })}
      </ul>

      {orders.length > 0 ? (
        <p className="text-[11px] text-ink-400 text-center mt-6 pb-2 leading-relaxed">
          Orders from this visit. They stay here for four hours.
        </p>
      ) : null}
    </Screen>
  );
}
