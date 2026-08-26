import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import { api, REJECTION_REASONS, type Ticket } from './api';
import { Menu } from './Menu';
import { armAudioUnlock, unlockAudio, useAudioBlocked, useKitchenNotifications } from './notify';
import { Settings } from './Settings';
// `ThemeToggle` moved to `ui.tsx` so the SIGN-IN screen can use it too. It was
// private to this file, which put the light/dark switch behind the login — and
// the one case the light theme exists for is a tablet by a window, where the
// unreadable screen is the login itself.
import { Modal, ThemeToggle } from './ui';

/**
 * A filter pill with its count.
 *
 * The count is on the pill rather than beside it because the two are one fact —
 * "three urgent" — and splitting them makes the eye do a join. It shows even at
 * zero, so "Urgent 0" is a positive statement rather than an absent control the
 * cook has to notice is missing.
 */
function Pill({
  active,
  tone,
  label,
  count,
  onClick,
}: {
  active: boolean;
  tone: 'late' | 'new';
  label: string;
  count: number;
  onClick: () => void;
}) {
  const dot = tone === 'late' ? 'bg-late-500' : 'bg-stage-new';

  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`pressable glass-hover flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-bold ${
        active
          ? 'bg-shell-100 text-shell-900'
          : 'bg-shell-800 text-shell-300'
      }`}
    >
      <span aria-hidden className={`size-2 rounded-full ${active ? 'bg-shell-900' : dot}`} />
      {label}
      <span className="tnum">{count}</span>
    </button>
  );
}

/** Re-renders every second so ticket ages tick without refetching. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

const mins = (from: string, now: number): number => Math.floor((now - Date.parse(from)) / 60_000);

/** The next thing this ticket needs, or null if it is waiting on the customer. */
function nextAction(status: string): { action: 'accept' | 'ready' | 'collect'; label: string } | null {
  switch (status) {
    case 'PAYMENT_CONFIRMED':
    case 'DISPATCHED':
      // One tap: taken AND cooking. A cook holding the ticket is already
      // reaching for a pan; asking them to confirm that separately is the
      // interface making work for itself.
      return { action: 'accept', label: 'Accept' };
    case 'ACKNOWLEDGED':
      // Only reachable if something acknowledged without starting — a future
      // device auto-ack, or a half-finished action. Still needs a way forward.
      return { action: 'ready', label: 'Ready' };
    case 'PREPARING':
      return { action: 'ready', label: 'Ready' };
    case 'READY':
      return { action: 'collect', label: 'Hand over' };
    default:
      return null;
  }
}

export function Board({
  query,
  onSignOut,
}: {
  query: UseQueryResult<{ vendor: { id: string; name: string }; orders: Ticket[] }>;
  onSignOut: () => void;
}) {
  const now = useNow();
  const qc = useQueryClient();
  const [rejecting, setRejecting] = useState<Ticket | null>(null);

  /**
   * Which tab, held here rather than in the router.
   *
   * The KDS has no router — it is one screen with two modes, and a URL that a
   * mounted tablet can be left on is a liability: a cook who lands on /menu and
   * closes the app comes back to /menu during a rush. Tab state resets to
   * Orders on every reload, which is the right default for a device whose whole
   * purpose is the queue.
   */
  const [tab, setTab] = useState<'orders' | 'menu' | 'settings'>('orders');

  const onTab = (t: 'orders' | 'menu' | 'settings'): void => setTab(t);

  /**
   * Which tickets to show.
   *
   * `null` is everything. The two filters answer the two questions a cook has
   * during a rush — what is late, and what have I not started — and both are
   * derived from data already on screen rather than a new query.
   *
   * Deliberately NOT persisted. A filter that survives a reload is a filter a
   * cook forgets is on, and the failure mode is a ticket that never appears.
   */
  const [filter, setFilter] = useState<null | 'urgent' | 'new'>(null);

  /**
   * Fifteen seconds, matching DEVICE_HEARTBEAT_INTERVAL_SECONDS against a
   * sixty-second offline threshold. Three missed beats before a stall
   * disappears from the customer's list — enough slack for a wi-fi hiccup, not
   * enough to keep selling from a dead tablet for minutes.
   *
   * Deliberately separate from the board query. Folding it into that refetch
   * would mean a board that fails to load also stops the heartbeat, and the
   * stall would vanish from the app for a rendering bug.
   */
  const health = useQuery({
    queryKey: ['heartbeat'],
    queryFn: () => api.heartbeat(),
    refetchInterval: 15_000,
    retry: false,
  });

  const advance = useMutation({
    mutationFn: (v: { id: string; action: 'accept' | 'ready' | 'collect' }) =>
      api.advance(v.id, v.action),
    // No optimistic update. A ticket that flips to "Ready" locally and then
    // reverts because the server refused the transition is how food goes out
    // that nobody cooked. Wait for the server, then refetch.
    onSettled: () => qc.invalidateQueries({ queryKey: ['board'] }),
  });

  const reject = useMutation({
    mutationFn: (v: { id: string; reason: string }) => api.reject(v.id, v.reason),
    onSettled: () => qc.invalidateQueries({ queryKey: ['board'] }),
  });

  const orders = query.data?.orders ?? [];
  const blocked = health.data?.blockedReason ?? null;

  /**
   * URGENT is a wait time, and the threshold matches the escalation ladder.
   *
   * Three minutes, because the worker blocks a stall for not acknowledging at
   * 90 seconds and offers the customer a refund at 180. A ticket should be
   * visibly shouting on the board well before anybody outside the kitchen is
   * told about it — a cook learning from a customer that an order is late is
   * the failure this number exists to prevent.
   */
  const isUrgent = (t: Ticket): boolean => mins(t.placedAt, now) >= 3;
  const isNew = (t: Ticket): boolean =>
    t.status === 'PAYMENT_CONFIRMED' || t.status === 'DISPATCHED';

  const urgentCount = orders.filter(isUrgent).length;
  const newCount = orders.filter(isNew).length;

  const shown =
    filter === 'urgent'
      ? orders.filter(isUrgent)
      : filter === 'new'
        ? orders.filter(isNew)
        : orders;

  /**
   * Whether the stall is selling, taken from the HEARTBEAT rather than a
   * separate fetch.
   *
   * The heartbeat already returns `acceptingOrders` and runs every fifteen
   * seconds whichever tab is open, so the warning dot on the Stall tab is free.
   * Adding a second query for the same fact would give two answers that can
   * disagree for a few seconds — and the disagreement would show up as a dot
   * that appears and vanishes, which reads as a flickering bug.
   */
  const notAccepting = health.data ? health.data.acceptingOrders === false : false;

  // A sound when a ticket arrives, and a banner explaining it once the cook
  // turns round. The sound is the alert; the banner is the explanation.
  // The heartbeat carries the stock alerts, so they arrive on every tab rather
  // than only while somebody is looking at the queue.
  const { notices, dismiss } = useKitchenNotifications(orders, health.data?.stockAlerts);

  /**
   * Watched, not sampled — and unlocked by ANY first touch, not by the login.
   *
   * The banner used to reappear for ever on a mounted tablet, because the only
   * `unlockAudio()` call lived in the login form's submit handler and a kitchen
   * tablet is already signed in. See the long note in `notify.tsx`.
   */
  const muted = useAudioBlocked();
  useEffect(() => armAudioUnlock(), []);

  return (
    <div className="min-h-full flex">
      {/*
        ============================================================ sidebar
        A tablet in landscape has horizontal room and very little vertical, so
        the navigation goes down the side and the tickets get the height. The
        previous version put tabs in the top bar, which cost a row of ticket
        space on the one screen where vertical space is the scarce thing.
      */}
      <aside className="hidden sm:flex w-52 shrink-0 flex-col border-r border-shell-700 bg-shell-800">
        <div className="px-5 py-5 border-b border-shell-700">
          {/* The stall name, not the word "Orders". Three stalls share this
              court and a cook must never have to guess whose queue this is —
              an order at another stall would otherwise look like a lost one. */}
          <p className="text-lg font-bold leading-tight">{query.data?.vendor.name ?? 'Orders'}</p>
          <p className="text-shell-400 text-xs mt-1">
            {query.isError ? (
              <span className="text-late-500">Offline, retrying</span>
            ) : (
              'Kitchen board'
            )}
          </p>
        </div>

        <nav className="p-3 flex-1 space-y-1" aria-label="Sections">
          {(
            [
              ['orders', 'Live orders', orders.length],
              ['menu', 'Menu', null],
              ['settings', 'Stall', null],
            ] as const
          ).map(([id, label, count]) => (
            <button
              key={id}
              onClick={() => onTab(id)}
              aria-current={tab === id ? 'page' : undefined}
              className={`pressable glass-hover w-full flex items-center justify-between gap-2 rounded-xl px-4 py-3.5
                          text-base font-bold ${
                            tab === id
                              ? 'bg-shell-700 text-shell-100'
                              : 'text-shell-400 hover:text-shell-100'
                          }`}
            >
              <span className="flex items-center gap-2">
                {label}
                {/* A dot on Stall when the kitchen is not selling. The cook
                    should not have to open a tab to discover that. */}
                {id === 'settings' && notAccepting ? (
                  <span
                    aria-label="not taking orders"
                    className="size-2 rounded-full bg-warn-500"
                  />
                ) : null}
              </span>
              {count !== null && count > 0 ? (
                <span
                  className={`tnum text-sm rounded-md px-2 py-0.5 ${
                    tab === id ? 'bg-shell-900 text-shell-100' : 'bg-shell-900 text-shell-400'
                  }`}
                >
                  {count}
                </span>
              ) : null}
            </button>
          ))}
        </nav>

        <div className="p-3 border-t border-shell-700 flex items-center gap-1">
          <ThemeToggle />
          <button
            onClick={onSignOut}
            className="pressable glass-hover flex-1 text-left rounded-xl px-3 py-3 text-sm font-semibold
                       text-shell-400 hover:text-shell-100"
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* ==================================================== main column */}
      <div className="min-w-0 flex-1 flex flex-col">
      <header className="flex items-center justify-between px-6 py-4 border-b border-shell-700">
        <div className="flex items-center gap-4">
          {/* Below `sm` the sidebar is gone, so the stall name comes back here.
              A phone-sized kitchen screen is not the target, but a board that
              breaks entirely on one is worse than one that degrades. */}
          <div className="sm:hidden">
            <h1 className="text-xl font-bold leading-tight">
              {query.data?.vendor.name ?? 'Orders'}
            </h1>
            <p className="text-shell-400 text-xs mt-0.5">
              {orders.length} live
              {query.isError ? <span className="text-late-500"> · offline</span> : null}
            </p>
          </div>

          {/* A live dot. The only reliable way to tell a working board from a
              frozen one at a glance is something that is visibly moving. */}
          <span className="flex items-center gap-2 rounded-full bg-shell-800 px-3 py-1.5">
            <span
              aria-hidden
              className={`size-2 rounded-full ${
                query.isError || health.isError ? 'bg-late-500' : 'bg-go-500 animate-pulse'
              }`}
            />
            <span className="text-shell-400 text-xs font-semibold tnum">
              {new Date(now).toLocaleTimeString('en-IN', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
              })}
            </span>
          </span>

          {/*
            MUTED, AS A CHIP BESIDE THE CLOCK — not a banner across the board.

            It was a full-width slab under the header, and it was wrong twice
            over. It ate a row of ticket space on the one screen where vertical
            room is the scarce thing, and it sat below the fold of attention: a
            cook facing a hob never sees the top of the page, so the size bought
            nothing it was paying for.

            Beside the live clock it is next to the other thing that says "is
            this board working" — the heartbeat dot — which is where somebody
            checking on the tablet actually looks. Amber and animated, because
            a muted board misses orders and looks identical to a working one.
          */}
          {muted ? (
            <button
              onClick={() => unlockAudio()}
              title="Your browser blocks sound until the page is touched"
              className="pressable glass-hover inline-flex items-center gap-1.5 rounded-full border border-warn-500
                         bg-warn-500/15 pl-2 pr-2.5 h-8"
            >
              <svg viewBox="0 0 24 24" className="size-4 text-warn-500" fill="none" aria-hidden>
                <path
                  d="M11 5L6 9H3v6h3l5 4V5z"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinejoin="round"
                />
                <path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
              <span className="eyebrow text-[10px] text-warn-500">Sound off — tap</span>
            </button>
          ) : null}
        </div>

        {/*
          FILTERS, and only the two questions a cook has during a rush.
          What is late, and what have I not started. Both counts are derived
          from tickets already on screen — no second query — and each pill is a
          toggle rather than a mode, so tapping the active one clears it.

          Hidden entirely on the other tabs: a filter for a list that is not
          being shown is a control with nothing to do.
        */}
        {tab === 'orders' ? (
          <div className="flex items-center gap-2">
            <Pill
              active={filter === 'urgent'}
              tone="late"
              label="Urgent"
              count={urgentCount}
              onClick={() => setFilter(filter === 'urgent' ? null : 'urgent')}
            />
            <Pill
              active={filter === 'new'}
              tone="new"
              label="New"
              count={newCount}
              onClick={() => setFilter(filter === 'new' ? null : 'new')}
            />
          </div>
        ) : null}

        {/* Sign out and the theme switch live in the sidebar now. Below `sm`
            the sidebar is gone, so they come back here. */}
        <div className="sm:hidden flex items-center gap-1">
          <ThemeToggle />
          <button
            onClick={onSignOut}
            className="pressable glass-hover text-shell-400 px-4 py-2 text-sm font-semibold rounded-xl
                        hover:text-shell-100"
          >
            Sign out
          </button>
        </div>
      </header>

      {/* The page title, as the reference has it. Says what is on screen and
          how much of it, which is the first thing a cook checks on walking up. */}
      {tab === 'orders' ? (
        <div className="px-6 pt-6">
          <h2 className="text-3xl font-bold leading-none">Live orders</h2>
          <p className="text-shell-400 text-base mt-1.5">
            {orders.length === 0
              ? 'Nothing waiting'
              : filter === null
                ? `${orders.length} ${orders.length === 1 ? 'order' : 'orders'} in the kitchen`
                : `Showing ${shown.length} of ${orders.length}`}
          </p>
        </div>
      ) : null}

      {/*
        The other two tabs render INSIDE the board's shell, not instead of it.
        The header, the live clock and the heartbeat all keep running — a cook
        who opens the menu must not stop the tablet reporting itself alive, or
        the stall would vanish from the customer app for as long as they were
        looking at it.
      */}
      {tab === 'menu' ? <Menu /> : null}
      {tab === 'settings' ? <Settings /> : null}

      {/*
        ================================================================
        ARRIVALS — floating, bottom-right, and they clear themselves
        ================================================================

        This was a full-width slab in the document flow, and that was wrong in
        three separate ways:

          IT MOVED THE QUEUE. A new order pushed every ticket down at the exact
          moment somebody was reaching for one. On a touch screen that is not an
          aesthetic problem, it is a mis-tap on the wrong order.

          IT COST A ROW OF TICKETS on the one screen where vertical space is the
          scarce thing — the whole reason the navigation lives in a sidebar.

          IT DUPLICATED THE BOARD. The ticket is already there, pulsing, with
          the New count up beside the filters. The only thing this adds is
          "that happened while you were turned away", which is worth a few
          seconds of a corner and not a permanent band across the screen.

        `fixed` so the queue never moves. Bottom-right because tickets fill from
        the top, so nothing important is ever underneath it. And it is still
        LOUD — a green so saturated it reads in peripheral vision, and an order
        number at 28px legible from the pass.
      */}
      {notices.length > 0 ? (
        <div
          className="fixed bottom-5 right-5 z-40 w-[min(24rem,calc(100vw-2.5rem))] space-y-2.5"
          role="status"
          aria-live="polite"
        >
          {notices.map((n) => (
            <button
              key={n.id}
              onClick={() => dismiss(n.id)}
              className="pressable glass-hover block w-full text-left rounded-card border border-go-500
                         bg-shell-800 shadow-lg overflow-hidden"
            >
              {/* A solid edge rather than a tinted fill. The tint washed out
                  against a charcoal board at an angle, which is how a mounted
                  tablet is always viewed. */}
              <span className="flex items-center gap-3.5 px-4 py-3.5">
                <span
                  aria-hidden
                  className="size-10 shrink-0 grid place-items-center rounded-full bg-go-500/15"
                >
                  <svg viewBox="0 0 24 24" className="size-5 text-go-500" fill="none">
                    <path
                      d="M5 12l5 5L19 8"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>

                <span className="min-w-0 flex-1">
                  <span className="block eyebrow text-[10px] text-go-500">New order</span>
                  {/* The order NUMBER is the headline, not the sentence. It is
                      the one string a cook matches against a ticket, and at
                      28px it reads from the pass. */}
                  <span className="block text-[28px] font-black text-shell-100 leading-none tnum mt-0.5">
                    {n.title.replace(/^New order\s*/i, '')}
                  </span>
                  {n.body ? (
                    <span className="block text-[12px] text-shell-400 mt-1">{n.body}</span>
                  ) : null}
                </span>
              </span>
            </button>
          ))}
        </div>
      ) : null}


      {/* The stall is not receiving new orders and needs to know why.
          Deliberately not phrased as a punishment: the reason it exists is
          that a kitchen which cannot see its queue should not be given more
          of it. The customer-facing copy for the same state says only
          "not taking orders" and never mentions the stall — ESC-02. */}
      {blocked ? (
        <div
          role="alert"
          className="mx-6 mt-4 rounded-xl border-2 border-late-500 bg-late-500/10 px-5 py-4"
        >
          <p className="font-bold text-lg">New orders paused</p>
          <p className="text-shell-300 text-sm mt-1">{blocked}</p>
        </div>
      ) : null}

      {/* A heartbeat that has stopped is worse than a board that has stopped:
          the screen still looks alive while customers are being quietly told
          this stall is closed. Say so. */}
      {health.isError ? (
        <div
          role="alert"
          className="mx-6 mt-4 rounded-xl border-2 border-warn-500 bg-warn-500/10 px-5 py-4"
        >
          <p className="font-bold text-lg">Lost contact with the server</p>
          <p className="text-shell-300 text-sm mt-1">
            Customers may stop seeing this stall until the connection returns.
          </p>
        </div>
      ) : null}

      {/* `hidden`, not unmounted. The queue keeps polling behind the other two
          tabs, so switching back is instant and a ticket that arrived while the
          cook was setting stock has already been announced by the sound. */}
      <main className={`flex-1 p-6 ${tab === 'orders' ? '' : 'hidden'}`}>
        {orders.length === 0 ? (
          <div className="text-center mt-28">
            <p className="text-shell-100 text-2xl font-bold">All caught up</p>
            <p className="text-shell-400 text-lg mt-2">
              New orders appear here automatically. No need to refresh.
            </p>
          </div>
        ) : shown.length === 0 ? (
          /*
            A filter matching nothing is NOT "all caught up" — there are orders
            in the kitchen, they are just not these. Saying "all caught up"
            here would tell a cook the queue was empty while five tickets sat
            one tap away, which is the worst thing this screen could get wrong.
          */
          <div className="text-center mt-28">
            <p className="text-shell-100 text-2xl font-bold">
              {filter === 'urgent' ? 'Nothing is running late' : 'Everything has been started'}
            </p>
            <p className="text-shell-400 text-lg mt-2">
              {orders.length} {orders.length === 1 ? 'order is' : 'orders are'} still in the
              kitchen.
            </p>
            <button
              onClick={() => setFilter(null)}
              className="pressable glass-hover mt-6 rounded-xl bg-shell-800 px-6 py-4 text-lg font-bold
                         text-shell-100"
            >
              Show all orders
            </button>
          </div>
        ) : (
          <ul className="grid gap-5 [grid-template-columns:repeat(auto-fill,minmax(320px,1fr))]">
            {shown.map((t) => {
              const age = mins(t.placedAt, now);
              // Thresholds match the escalation ladder the worker uses, so the
              // cook sees a ticket redden before anyone is paged about it.
              const tone =
                age >= 3 ? 'border-late-500' : age >= 2 ? 'border-warn-500' : 'border-shell-700';
              const next = nextAction(t.status);

              // Unaccepted and already ageing. The escalation ladder starts
              // paging at 15 seconds and blocks the stall at 90; the card
              // should be shouting well before anyone else is told.
              const unaccepted = t.status === 'PAYMENT_CONFIRMED' || t.status === 'DISPATCHED';

              /**
               * The badge says the state in WORDS. Colour is reinforcement.
               *
               * "Urgent" outranks the lifecycle stage because it is the thing a
               * cook must act on — a three-minute-old ticket that is already
               * cooking still needs looking at before a fresh one.
               */
              const stage =
                age >= 3
                  ? { label: 'URGENT', bar: 'bg-late-500', chip: 'bg-late-500 text-shell-100' }
                  : t.status === 'READY'
                    ? { label: 'READY', bar: 'bg-stage-ready', chip: 'bg-stage-ready text-shell-900' }
                    : t.status === 'PREPARING' || t.status === 'ACKNOWLEDGED'
                      ? {
                          label: 'PREPARING',
                          bar: 'bg-stage-cooking',
                          chip: 'bg-stage-cooking text-shell-900',
                        }
                      : { label: 'NEW', bar: 'bg-stage-new', chip: 'bg-stage-new text-shell-100' };

              /**
               * How full the bar is: age against the escalation ladder's last
               * rung (180s = 3 min), capped.
               *
               * NOT against the stall's own prep estimate, which is what a
               * delivery app would use. The estimate is a promise about cooking
               * time; this bar is about how close the platform is to telling
               * the customer their order has gone wrong, and those two numbers
               * answer different questions.
               */
              const urgency = Math.min(1, age / 3);

              return (
                <li
                  key={t.orderId}
                  className={`bg-shell-800 border-2 ${tone} rounded-card overflow-hidden ${
                    unaccepted && age >= 1 ? 'ticket-new' : ''
                  }`}
                >
                  {/* The coloured rail across the top. Reads from across a
                      kitchen before any text resolves. */}
                  <div className={`${stage.bar} h-1.5`} />

                  <div className="p-5">
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div className="min-w-0">
                      <span
                        className={`inline-block rounded-md px-2 py-0.5 text-[11px] font-black tracking-widest ${stage.chip}`}
                      >
                        {stage.label}
                      </span>
                      <span className="block text-4xl font-black tnum tracking-tight mt-1.5">
                        {t.orderNumber}
                      </span>
                      {/*
                        The name UNDER the number, not instead of it.
                        The number is what the system, the receipt and the
                        customer's own screen all agree on; the name is what
                        makes calling it work when two people both thought
                        A-011 sounded like theirs. Truncated rather than
                        wrapped — a long name must not push the items down.
                      */}
                      {t.customerName ? (
                        <span className="block text-shell-300 text-base font-semibold truncate mt-0.5">
                          {t.customerName}
                        </span>
                      ) : null}
                    </div>

                    {/* Never colour alone — the number is stated, and labelled,
                        because "08:45" beside an order number is otherwise as
                        likely to read as a clock time as a duration. */}
                    <div className="text-right shrink-0">
                      <span
                        className={`block text-3xl font-black tnum leading-none ${
                          age >= 3 ? 'text-late-500' : age >= 2 ? 'text-warn-500' : 'text-shell-400'
                        }`}
                      >
                        {age}
                      </span>
                      <span className="block text-shell-400 text-[10px] font-bold tracking-widest mt-1">
                        MIN WAITING
                      </span>
                    </div>
                  </div>

                  <div className="h-1 rounded-full bg-shell-900 overflow-hidden mb-4">
                    <div
                      className={`h-full rounded-full ${stage.bar}`}
                      style={{ width: `${urgency * 100}%` }}
                    />
                  </div>

                  <ul className="mb-5 divide-y divide-shell-700">
                    {t.items.map((i, n) => (
                      <li key={n} className="py-2.5 first:pt-0 flex gap-3">
                        {/* The quantity as a chip, because "2×" run into the
                            dish name is the number a cook misreads when three
                            tickets are open and one of them says 1×. */}
                        <span className="shrink-0 rounded-md bg-shell-900 px-2 py-0.5 text-sm font-black tnum text-shell-300 h-fit">
                          {i.quantity}×
                        </span>
                        <span className="min-w-0">
                          <span className="block text-lg font-bold leading-snug">{i.name}</span>
                          {i.instructions ? (
                            // The line that ruins an order if missed. Warn
                            // colour and its own row, never appended to the name.
                            <span className="block text-warn-500 text-base leading-snug mt-0.5">
                              {i.instructions}
                            </span>
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ul>

                  <div className="flex gap-3">
                    {next ? (
                      <button
                        disabled={advance.isPending}
                        onClick={() => advance.mutate({ id: t.orderId, action: next.action })}
                        // Tall targets: a gloved thumb cannot hit 40px.
                        className="flex-1 bg-go-500 text-shell-900 font-black text-lg tracking-wide
                                   rounded-xl py-5 pressable glass-hover disabled:opacity-50"
                      >
                        {next.label}
                      </button>
                    ) : null}

                    {t.status !== 'READY' ? (
                      <button
                        onClick={() => setRejecting(t)}
                        className="px-5 py-5 rounded-xl border-2 border-shell-700 text-shell-400
                                   font-semibold pressable glass-hover"
                      >
                        Reject
                      </button>
                    ) : null}
                  </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </main>

      {/*
        THIS ONE KEEPS ITS BIG TARGETS, UNLIKE THE DISH EDITOR.
        The two dialogs in this app are opposites and are sized as such. Adding
        a dish is typing, done with attention before service. Rejecting an order
        is one tap in the middle of a rush, by somebody who is annoyed and
        holding something hot — so the reasons stay at 56px and the type stays
        large. Same primitive, same chrome, different density: what the redesign
        fixed was applying the ticket's sizing to a FORM, not the sizing itself.
      */}
      {rejecting ? (
        <Modal
          size="sm"
          title={`Reject ${rejecting.orderNumber}?`}
          subtitle="The customer is refunded automatically. A reason is required — it is how a stall with a recurring problem gets noticed."
          onClose={() => setRejecting(null)}
          footer={
            <button
              onClick={() => setRejecting(null)}
              className="pressable glass-hover w-full h-12 rounded-xl border border-shell-700 text-[15px]
                         font-semibold text-shell-300 hover:text-shell-100"
            >
              Cancel
            </button>
          }
        >
          <div className="grid gap-2.5">
            {REJECTION_REASONS.map(([code, label]) => (
              <button
                key={code}
                disabled={reject.isPending}
                onClick={() => {
                  reject.mutate({ id: rejecting.orderId, reason: code });
                  setRejecting(null);
                }}
                className="pressable glass-hover text-left min-h-14 px-4 rounded-xl border border-shell-700
                           bg-shell-900 text-[16px] font-semibold text-shell-100

                            disabled:opacity-50"
              >
                {label}
              </button>
            ))}
          </div>
        </Modal>
      ) : null}
      </div>
    </div>
  );
}
