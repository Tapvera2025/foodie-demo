import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, type Availability, type MenuItem } from './api';
import { CATALOG_CHANGED, useFallbackInterval, useRealtime } from './realtime';
import { cdn } from './cdn';
import { ItemEditor } from './ItemEditor';

/**
 * The menu, from the kitchen's side.
 *
 * ============================================================================
 * WHY A BINARY TOGGLE WOULD HAVE BEEN WRONG
 * ============================================================================
 *
 * The reference shows one green ON/OFF switch per dish, and SOLD OUT as a state
 * stamped across the photograph. Copied literally that is two states rendered
 * as three, and it loses the distinction PRD §6 exists to keep:
 *
 * AVAILABLE selling
 * SOLD_OUT gone for today, back tomorrow
 * TEMPORARILY_UNAVAILABLE off indefinitely — the fryer broke, the chef left
 *
 * Those are different sentences to a customer and different decisions to a
 * cook, and collapsing them means a stall that ran out of momos at 2pm looks
 * identical to one that has stopped making them. So the toggle carries the
 * common case — on, or off — and "Sold out" is its own action beside it. The
 * photograph still gets the SOLD OUT stamp, because that is genuinely the
 * clearest way to show it.
 *
 * THE FOURTH STATE NOBODY SETS
 *
 * `orderable` is what the CUSTOMER sees, and it is not the switch. An item can
 * be AVAILABLE and still not orderable because its tracked stock ran out. It is
 * rendered as its own line rather than inferred, because it is the only one a
 * cook can check against reality.
 *
 * WHO MAY DO WHAT
 *
 * The switch and the stock count are `stock.toggle` — anyone on the line. The
 * pencil and the bin are `menu.write` — owner only. A price field on a tablet
 * mounted in a kitchen is how a ₹180 roll becomes ₹18 during a rush, and PRD
 * §12.1 separates order management from menu management for that reason.
 */

/**
 * Three, matching `MUST_TRY_LIMIT` in `inventory.controller.ts`.
 *
 * Duplicated deliberately rather than fetched: the server sends `limit` back on
 * every successful toggle, so a mismatch surfaces the moment anybody uses the
 * feature — and the alternative is an extra request on page load to learn a
 * number that changes once a year. `tests/conformance/must-try.mjs` asserts the
 * two agree, so the duplication cannot rot silently.
 */
const MUST_TRY_LIMIT = 3;

export function Menu() {
  /* `FALLBACK_MS` while the socket is up, the old interval when it is not. */
  const fallbackMs = useFallbackInterval();

  const qc = useQueryClient();
  const [filter, setFilter] = useState<'all' | 'off'>('all');

  /** `null` = closed, `'new'` = add, an item = edit that one. */
  const [editing, setEditing] = useState<MenuItem | 'new' | null>(null);

  /** Which dish is being taken off the menu for good. See the note below. */
  const [removing, setRemoving] = useState<MenuItem | null>(null);

  /**
   * Whether to show the editing controls at all.
   *
   * From `/vendor/status`, computed server-side from `menu.write`. Shared cache
   * with the Stall tab, so this costs nothing extra. It is a RENDERING hint —
   * the endpoints check the permission again, so a cook who found the form
   * another way gets a 403 telling them where their controls are.
   */
  const status = useQuery({ queryKey: ['stall-status'], queryFn: api.stallStatus });
  const canEdit = status.data?.canEditMenu ?? false;

  /**
   * Polled, but slowly.
   *
   * Fifteen seconds, not the board's three. Availability changes because
   * somebody on this screen changed it; the poll exists for the other tablet in
   * the same kitchen, and for stock counts moving as orders are confirmed
   * elsewhere.
   */
  /*
    A second tablet in the same kitchen, and the customer app, are looking at
    this same list. `catalog.changed` is published by the stall's own writes,
    so two tablets stay in step instead of drifting up to fifteen seconds
    apart — which is how one cook marks a dish sold out and the other keeps
    accepting it.
  */
  useRealtime(CATALOG_CHANGED, [['menu-items']]);
  const q = useQuery({ queryKey: ['menu-items'], queryFn: api.items, refetchInterval: fallbackMs });

  const mustTry = useMutation({
    mutationFn: (v: { itemId: string; mustTry: boolean }) => api.setMustTry(v.itemId, v.mustTry),
    onSettled: () => qc.invalidateQueries({ queryKey: ['menu-items'] }),
  });

  const availability = useMutation({
    mutationFn: (v: { itemId: string; availability: Availability }) =>
      api.setAvailability(v.itemId, v.availability),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['menu-items'] }),
  });

  const stock = useMutation({
    mutationFn: (v: { itemId: string; dailyStock: number }) => api.setStock(v.itemId, v.dailyStock),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['menu-items'] }),
  });

  const discontinue = useMutation({
    mutationFn: (itemId: string) => api.discontinueItem(itemId),
    onSuccess: () => {
      setRemoving(null);
      void qc.invalidateQueries({ queryKey: ['menu-items'] });
    },
  });

  const all = q.data?.items ?? [];
  // INACTIVE items are discontinued products, not availability decisions.
  const items = all.filter((i) => i.status === 'ACTIVE');
  /*
   * How many picks this stall has used, counted from the list already on
   * screen rather than tracked separately.
   *
   * Declared HERE and not beside the mutation above, because `items` is a
   * `const` and is not hoisted — reading it earlier is a temporal dead zone
   * error at first render, which TypeScript caught rather than the browser.
   *
   * The server is the authority and refuses the fourth regardless. This only
   * decides whether the button is offered, and deriving it from `items` means
   * it cannot drift out of step with what the cook is looking at.
   */
  const picked = items.filter((i) => i.mustTry).length;

  const off = items.filter((i) => !i.orderable);
  const shown = filter === 'off' ? off : items;

  if (q.isLoading) return <p className="text-shell-400 text-xl p-8">Loading the menu…</p>;

  if (q.isError) {
    return (
      <div className="p-8">
        <p className="text-late-500 text-xl font-bold">Cannot load the menu.</p>
        <button
          onClick={() => void q.refetch()}
          className="pressable glass-hover mt-4 rounded-xl border border-shell-600 px-6 py-3 text-lg font-semibold"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="p-5 md:p-6">
      <div className="flex items-center justify-between gap-4 mb-4">
        <h1 className="display text-[26px] text-shell-100">Menu management</h1>
        {canEdit ? (
          <button
            onClick={() => setEditing('new')}
            className="pressable glass-hover shrink-0 rounded-xl bg-go-500 text-shell-900 px-5 h-12 text-[15px] font-bold"
          >
            + Add a dish
          </button>
        ) : null}
      </div>

      {/*
        ONE SEGMENTED CONTROL, not two separate buttons.
        The reference's shape, and it is the right one: these are two views of
        the same list, and a joined control says "pick one" where two buttons
        say "press either".
      */}
      <div className="inline-flex rounded-full bg-shell-800 p-1 mb-5">
        {(
          [
            ['all', 'Everything', items.length],
            ['off', 'Not selling', off.length],
          ] as const
        ).map(([key, label, count]) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            aria-pressed={filter === key}
            className={`pressable glass-hover rounded-full px-5 h-11 eyebrow text-[11px] ${
              filter === key ? 'bg-shell-700 text-shell-100' : 'text-shell-400'
            }`}
          >
            {label}
            <span
              className={`ml-2 tnum ${
                key === 'off' && count > 0 ? 'text-warn-500' : 'text-shell-400'
              }`}
            >
              {count}
            </span>
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="text-shell-400 text-lg">
          {filter === 'off'
            ? 'Everything on the menu is selling.'
            : 'No dishes yet. Add one, or ask the food court to import your menu.'}
        </p>
      ) : (
        /*
          DESKTOP IS A GRID, and that is the whole adaptation.

          The reference is a phone: one column of tall photo cards, which is
          right when the screen is the width of a card. A kitchen tablet is
          almost always landscape and often 1280px wide — one column there is a
          strip of menu beside an empty half-screen, and finding the dish you
          want means scrolling past nine you do not.
        */
        /*
          NO `items-start` HERE, unlike the customer's stall list.

          There the cards are content and a short one should not be padded out
          to match a tall one — ragged bottoms cost nothing when you are
          scrolling past.

          Here the bottom of every card is a CONTROL. Only some dishes carry a
          stock line, so `items-start` put the on/off switch at a different
          height on every card in the row, and a cook reaching for the third one
          finds it forty pixels above where the second one was. On a touch
          screen that is a mis-tap that takes a dish off sale.

          So the cards stretch, and the action strip is pinned to the bottom of
          each with `mt-auto` — one predictable line across the row.
        */
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((item) => (
            <DishCard
              key={item.id}
              item={item}
              canEdit={canEdit}
              busy={
                (availability.isPending && availability.variables?.itemId === item.id) ||
                (stock.isPending && stock.variables?.itemId === item.id)
              }
              onAvailability={(a) => availability.mutate({ itemId: item.id, availability: a })}
              onStock={(n) => stock.mutate({ itemId: item.id, dailyStock: n })}
              onMustTry={(next) => mustTry.mutate({ itemId: item.id, mustTry: next })}
              mustTryFull={picked >= MUST_TRY_LIMIT}
              onEdit={() => setEditing(item)}
              onRemove={() => setRemoving(item)}
            />
          ))}
        </ul>
      )}

      {editing !== null ? (
        <ItemEditor item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      ) : null}

      {/*
        THE BIN IS NOT A DELETE, and the dialog has to say so.

        `discontinueItem` marks the row INACTIVE. Every order that ever
        contained this dish references it, and a deleted row turns "what did
        they eat" into a dangling key on exactly the records a dispute starts
        from. The word people expect is Delete; the thing that happens is not,
        and the gap between them is where somebody clicks expecting it to be
        undoable in a way it is not.
      */}
      {removing ? (
        <div
          className="fixed inset-0 z-30 grid place-items-center p-4 bg-scrim"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setRemoving(null);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-md rounded-card border border-shell-700 bg-shell-800 p-5"
          >
            <h2 className="text-[19px] font-bold text-shell-100">
              Take “{removing.name}” off the menu?
            </h2>
            <p className="text-[14px] text-shell-300 mt-2 leading-relaxed">
              It disappears from the customer app straight away. To hide it just for today, close
              this and use <strong>Sold out</strong> instead.
            </p>
            <p className="text-[13px] text-shell-400 mt-2 leading-relaxed">
              Permanent, but not a delete — past orders keep their record of it, and the food court
              can put it back.
            </p>

            <div className="flex gap-2.5 mt-5">
              <button
                onClick={() => discontinue.mutate(removing.id)}
                disabled={discontinue.isPending}
                className="pressable glass-hover h-12 rounded-xl bg-late-500 px-5 text-[15px] font-bold text-shell-100 disabled:opacity-50"
              >
                {discontinue.isPending ? 'Removing…' : 'Take it off'}
              </button>
              <button
                onClick={() => setRemoving(null)}
                className="pressable glass-hover h-12 rounded-xl border border-shell-700 px-5 text-[15px] font-semibold text-shell-300"
              >
                Keep it
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function DishCard({
  item,
  canEdit,
  busy,
  onAvailability,
  onStock,
  onMustTry,
  mustTryFull,
  onEdit,
  onRemove,
}: {
  item: MenuItem;
  canEdit: boolean;
  busy: boolean;
  onAvailability: (a: Availability) => void;
  onStock: (n: number) => void;
  onMustTry: (next: boolean) => void;
  /** The stall is already at its cap, and this dish is not one of the picks. */
  mustTryFull: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const [stockOpen, setStockOpen] = useState(false);

  const soldOut = item.availability === 'SOLD_OUT';
  const on = item.availability === 'AVAILABLE';
  const tracked = item.inventoryMode === 'TRACKED';
  /** Stock ran out while the switch still says AVAILABLE. See the header. */
  const outOfStock = on && !item.orderable && item.reason === 'item.unavailable.stock';

  return (
    <li
      className={`flex h-full flex-col rounded-card bg-shell-800 border border-shell-700 overflow-hidden ${
        item.orderable ? '' : 'opacity-80'
      }`}
    >
      {/*
        A FIXED HEIGHT, NOT `aspect-[16/10]`.

        The aspect box was already here and the grid was still ragged — three
        cards showing 4:3, 16:10 and 1:1. `aspect-ratio` needs a definite width
        to resolve a height from, and inside a flex column that depends on the
        stretch resolving first; when it does not, the box collapses to the
        image's own shape and the class silently does nothing.

        `h-44` cannot fail that way. It is the same 16:10 at the widths this
        grid actually uses, and it holds at every width, which is the property
        that matters for a grid.

        `shrink-0` so a tall neighbour stretches the TEXT block rather than
        squashing this photograph.
      */}
      <div className="relative h-44 bg-shell-900 shrink-0 overflow-hidden">
        {item.imageUrl ? (
          <img
            /*
              The CDN crops this, not the browser. `object-cover` alone chops
              equally off both edges regardless of where the food is; `cdn()`
              asks Cloudinary for a 16:10 derivative cropped around the SUBJECT,
              and ships a 640px file instead of the 1600px original.
            */
            src={cdn(item.imageUrl, 'card') ?? item.imageUrl}
            alt=""
            loading="lazy"
            className={`size-full object-cover ${item.orderable ? '' : 'opacity-40 grayscale'}`}
          />
        ) : (
          <div className="size-full grid place-items-center">
            <span aria-hidden className="display text-[40px] text-shell-600">
              {item.name.trim().slice(0, 1).toUpperCase()}
            </span>
          </div>
        )}

        {/* Stamped across the photograph, as the reference has it — it is the
            clearest possible way to say a dish is gone, and it reads from
            across a kitchen. */}
        {soldOut || outOfStock ? (
          <span className="absolute inset-0 grid place-items-center">
            <span className="rounded-full bg-shell-900/85 px-4 py-2 eyebrow text-[12px] text-shell-100">
              {outOfStock ? 'None left today' : 'Sold out'}
            </span>
          </span>
        ) : null}
      </div>

      <div className="p-4 flex flex-1 flex-col">
        <div className="flex items-baseline gap-3">
          <p
            className={`min-w-0 flex-1 text-[17px] font-bold leading-tight ${
              item.orderable ? 'text-shell-100' : 'text-shell-400'
            }`}
          >
            {item.name}
          </p>
          {/* Beside the name, never editable inline. An owner opens the dish to
              change it; a cook never sees the way in at all. */}
          <span className="shrink-0 tnum text-[16px] font-bold text-shell-300">
            ₹{(item.pricePaise / 100).toFixed(2)}
          </span>
        </div>

        {tracked ? (
          <p className="text-[13px] text-shell-400 mt-1.5 tnum">
            {item.remaining ?? 0} left · {item.consumed ?? 0} sold of {item.dailyStock ?? 0}
          </p>
        ) : null}

        <div className="mt-auto pt-3.5 border-t border-shell-700 flex items-center gap-2">
          {/*
            THE SWITCH IS ON/OFF ONLY. "Sold out" is its own action.
            See the header: three states rendered as two loses "back tomorrow"
            against "off indefinitely", which are different sentences to a
            customer and different decisions to a cook.
          */}
          <button
            onClick={() => onAvailability(on ? 'TEMPORARILY_UNAVAILABLE' : 'AVAILABLE')}
            disabled={busy}
            role="switch"
            aria-checked={on}
            aria-label={`${item.name} — ${on ? 'switch off' : 'switch on'}`}
            className="pressable flex items-center gap-2.5 disabled:opacity-50"
          >
            <span
              aria-hidden
              className={`h-8 w-14 rounded-full p-1 transition-colors ${
                on ? 'bg-go-500' : 'bg-shell-600'
              }`}
            >
              <span
                className={`block size-6 rounded-full bg-shell-100 transition-transform ${
                  on ? 'translate-x-6' : ''
                }`}
              />
            </span>
            <span
              className={`eyebrow text-[11px] ${on ? 'text-go-500' : 'text-shell-400'}`}
            >
              {on ? 'On' : 'Off'}
            </span>
          </button>

          {/* Only offered when it is on. "Sold out" on a dish already switched
              off is a state change nobody means to make. */}
          {on ? (
            <button
              onClick={() => onAvailability('SOLD_OUT')}
              disabled={busy}
              className="pressable glass-hover h-9 rounded-lg border border-shell-700 px-3 text-[12px] font-semibold
                         text-shell-400 disabled:opacity-50"
            >
              Sold out
            </button>
          ) : null}

          {/*
            ==================================================================
            "MUST TRY" — THE STALL RECOMMENDING ITS OWN DISH
            ==================================================================

            Not the Bestseller badge. That one is computed from units this stall
            actually sold in the last seven days and nothing on this screen can
            change it — which is the point of it. This button sets a separate
            flag the customer app labels "Must try", so a cook can put a new
            dish, or the one they are proudest of, in front of somebody.

            DISABLED AT THE CAP RATHER THAN HIDDEN. Three per stall, and the
            fourth attempt is refused by the server. Hiding the button would
            leave a cook wondering why one dish has a control another does not;
            a disabled button with "3 of 3 picked" in its tooltip says what the
            rule is. The server refuses regardless — `mustTryFull` only saves a
            round trip and an error toast, it is not the enforcement.
          */}
          {canEdit ? (
            <button
              onClick={() => onMustTry(!item.mustTry)}
              disabled={busy || (mustTryFull && !item.mustTry)}
              aria-pressed={item.mustTry}
              title={
                item.mustTry
                  ? 'Stop recommending this dish'
                  : mustTryFull
                    ? 'This stall already recommends 3 dishes. Unmark one first.'
                    : 'Recommend this dish to customers'
              }
              className={`pressable glass-hover h-9 rounded-lg border px-3 text-[12px] font-semibold
                          disabled:opacity-40 ${
                            item.mustTry
                              ? 'border-go-500 text-go-500'
                              : 'border-shell-700 text-shell-400'
                          }`}
            >
              {item.mustTry ? '★ Must try' : 'Must try'}
            </button>
          ) : null}

          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={() => setStockOpen((x) => !x)}
              disabled={busy}
              aria-label={`Set today's count for ${item.name}`}
              title="Today's count"
              className="pressable glass-hover size-10 grid place-items-center rounded-lg text-shell-400 hover:text-shell-100 disabled:opacity-50"
            >
              <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden>
                <path
                  d="M4 7h16M4 12h16M4 17h10"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
            </button>

            {canEdit ? (
              <>
                <button
                  onClick={onEdit}
                  aria-label={`Edit ${item.name}`}
                  className="pressable glass-hover size-10 grid place-items-center rounded-lg text-shell-400 hover:text-shell-100"
                >
                  <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden>
                    <path
                      d="M4 20h4L19 9a2.1 2.1 0 00-3-3L5 17v3z"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
                <button
                  onClick={onRemove}
                  aria-label={`Take ${item.name} off the menu`}
                  className="pressable glass-hover size-10 grid place-items-center rounded-lg text-shell-400"
                >
                  <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden>
                    <path
                      d="M5 7h14M10 7V5h4v2M6 7l1 13h10l1-13"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              </>
            ) : null}
          </div>
        </div>

        {stockOpen ? <StockSetter current={item.dailyStock} busy={busy} onSet={onStock} /> : null}
      </div>
    </li>
  );
}

/**
 * Setting a count, without a keyboard.
 *
 * A number input on a mounted tablet means the on-screen keyboard covers half
 * the screen mid-service. Presets cover every real case — nobody sets 47
 * biryanis, they set 40 or 50.
 *
 * Setting ANY count switches the item to TRACKED, which is the only way to turn
 * tracking on. Deliberate, server-side: a separate "enable tracking" toggle
 * would allow TRACKED with no count, which reads as zero and silently removes
 * the item from sale.
 */
function StockSetter({
  current,
  busy,
  onSet,
}: {
  current: number | null;
  busy: boolean;
  onSet: (n: number) => void;
}) {
  return (
    <div className="mt-3 pt-3 border-t border-shell-700">
      <p className="text-[12px] text-shell-400 mb-2">
        {current === null ? "Today's count — not currently counted" : `Counted: ${current} today`}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {[10, 20, 30, 50, 100].map((n) => (
          <button
            key={n}
            onClick={() => onSet(n)}
            disabled={busy}
            className="pressable glass-hover min-w-12 h-11 rounded-lg bg-shell-900 text-shell-100 text-[15px] font-bold tnum disabled:opacity-50"
          >
            {n}
          </button>
        ))}
        <button
          onClick={() => onSet(0)}
          disabled={busy}
          className="pressable glass-hover h-11 rounded-lg border border-late-500 px-3 text-[13px] font-bold text-late-500 disabled:opacity-50"
        >
          None left
        </button>
      </div>
    </div>
  );
}
