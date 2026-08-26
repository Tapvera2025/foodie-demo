import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, type CourtSummary } from './api';
import { Button, Card, EmptyState, ErrorNote, Field, Input, Spinner, StatusPill } from './ui';

/**
 * Every food court on the platform.
 *
 * The console's home screen, and the top of the only hierarchy that matters:
 * a court holds stalls, a stall holds a menu. There is nothing above a court.
 *
 * WHAT THE STAT CARDS SHOW, AND WHAT THEY REFUSE TO
 *
 * Three numbers, each computed from data the platform actually holds. The
 * reference this is modelled on also shows a revenue figure and a
 * month-on-month arrow on everything; both are omitted where there is nothing
 * to derive them from. "↑2 this month" survives because `createdAt` is on every
 * row and the arithmetic is real; a growth percentage on live orders would be
 * comparing a snapshot to nothing.
 */
export function Courts() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');

  /**
   * Polled, unlike everything else in this console.
   *
   * `main.tsx` sets no `refetchInterval` by default, because a console changes
   * only when the person using it changes something. This screen is the one
   * exception: `liveOrderCount` moves because customers are ordering, and a
   * live number that is thirty seconds stale is worse than no number — somebody
   * would use it to decide whether a court is busy.
   */
  const q = useQuery({ queryKey: ['courts'], queryFn: api.courts, refetchInterval: 15_000 });
  const courts = q.data?.courts ?? [];

  const stats = useMemo(() => {
    const now = new Date();
    const thisMonth = courts.filter((c) => {
      const d = new Date(c.createdAt);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    }).length;

    return {
      courts: courts.length,
      thisMonth,
      activeStalls: courts.reduce((n, c) => n + c.activeVendorCount, 0),
      totalStalls: courts.reduce((n, c) => n + c.vendorCount, 0),
      liveOrders: courts.reduce((n, c) => n + c.liveOrderCount, 0),
      // Not a stat card, but the number somebody has to act on: a court that
      // exists and cannot be entered.
      unreachable: courts.filter((c) => !c.hasQr && c.status === 'ACTIVE').length,
    };
  }, [courts]);

  const shown = useMemo(() => {
    const t = query.trim().toLowerCase();
    if (!t) return courts;
    return courts.filter(
      (c) =>
        c.name.toLowerCase().includes(t) ||
        c.city.toLowerCase().includes(t) ||
        (c.address ?? '').toLowerCase().includes(t),
    );
  }, [courts, query]);

  return (
    <div>
      {/* ==================================================== page header */}
      <div className="flex items-start justify-between gap-4 mb-7">
        <div>
          <h1 className="display text-[28px] text-ink-900">Food courts</h1>
          <p className="text-[13px] text-ink-500 mt-1">
            Venues, the stalls inside them, and what is cooking right now.
          </p>
        </div>
        {!adding ? (
          <Button onClick={() => setAdding(true)}>+ Add a food court</Button>
        ) : null}
      </div>

      {/* ===================================================== stat cards */}
      <div className="grid gap-4 sm:grid-cols-3 mb-7">
        <Stat
          label="Food courts"
          value={stats.courts}
          note={
            stats.thisMonth > 0
              ? `↑ ${stats.thisMonth} added this month`
              : 'None added this month'
          }
          tone={stats.thisMonth > 0 ? 'live' : 'plain'}
        />
        <Stat
          label="Stalls taking orders"
          value={stats.activeStalls}
          // Both numbers, because "148" alone hides that 40 are stuck in
          // onboarding — which is the actionable half of the fact.
          note={`of ${stats.totalStalls} across all venues`}
        />
        <Stat
          label="Live orders"
          value={stats.liveOrders}
          note="Paid, not yet collected"
          tone={stats.liveOrders > 0 ? 'live' : 'plain'}
        />
      </div>

      {/*
        The one thing on this page that is a problem rather than a number.
        A court with no QR is invisible to every customer, and the symptom —
        "I created it and nothing happens" — is two applications away from the
        cause. Surfaced here so nobody has to go looking.
      */}
      {stats.unreachable > 0 ? (
        <div className="mb-6 rounded-card border border-dashed border-draft-500 bg-draft-50 px-4 py-3">
          <p className="text-[13px] font-semibold text-draft-700">
            {stats.unreachable} {stats.unreachable === 1 ? 'court has' : 'courts have'} no QR code
          </p>
          <p className="text-[12px] text-draft-700/80 mt-0.5 leading-relaxed">
            They are live and nothing can scan into them. Open one and issue its code.
          </p>
        </div>
      ) : null}

      {adding ? (
        <NewCourt
          onCancel={() => setAdding(false)}
          onCreated={(id) => {
            setAdding(false);
            void qc.invalidateQueries({ queryKey: ['courts'] });
            navigate(`/courts/${id}`);
          }}
        />
      ) : null}

      {/* ========================================================== table */}
      <Card className="overflow-hidden">
        <div className="px-4 py-3.5 border-b border-ink-100 flex items-center justify-between gap-4">
          <h2 className="font-bold text-[14px] text-ink-900">
            All venues
            <span className="ml-2 font-medium text-ink-400 tnum">{shown.length}</span>
          </h2>

          {courts.length > 3 ? (
            <div className="relative w-56">
              <svg
                viewBox="0 0 24 24"
                className="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-ink-400"
                fill="none"
                aria-hidden
              >
                <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
                <path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search venues…"
                aria-label="Search venues"
                className="w-full rounded-lg border border-ink-200 bg-surface py-2 pl-9 pr-3 text-[13px]
                           text-ink-900 placeholder:text-ink-400 outline-none
                           focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
              />
            </div>
          ) : null}
        </div>

        {q.isLoading ? <Spinner label="Loading food courts…" /> : null}
        {q.isError ? (
          <div className="p-4">
            <ErrorNote error={q.error} onRetry={() => void q.refetch()} />
          </div>
        ) : null}

        {q.data && courts.length === 0 && !adding ? (
          <EmptyState
            title="No food courts yet"
            body="A food court is a venue with one scannable QR code. Stalls live inside it."
            action={<Button onClick={() => setAdding(true)}>Add the first one</Button>}
          />
        ) : null}

        {shown.length === 0 && courts.length > 0 ? (
          <EmptyState title="Nothing matches that" body="Try a different name or city." />
        ) : null}

        {shown.length > 0 ? (
          <>
            {/*
              A real <table>, not a grid of divs.
              This is tabular data with headers, and the semantics are what let a
              screen reader announce "Live orders, 142" instead of reading a
              number with no idea what it counts.
            */}
            <table className="w-full">
              <thead>
                <tr className="border-b border-ink-100">
                  <Th>Venue</Th>
                  <Th className="hidden md:table-cell">Location</Th>
                  <Th className="hidden sm:table-cell">Live orders</Th>
                  <Th>Status</Th>
                  <th className="w-12" />
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {shown.map((c) => (
                  <Row key={c.id} court={c} onOpen={() => navigate(`/courts/${c.id}`)} />
                ))}
              </tbody>
            </table>
          </>
        ) : null}
      </Card>
    </div>
  );
}

function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <th
      className={`eyebrow text-[9px] text-ink-500 text-left px-4 py-2.5 font-bold ${className ?? ''}`}
    >
      {children}
    </th>
  );
}

function Stat({
  label,
  value,
  note,
  tone = 'plain',
}: {
  label: string;
  value: number;
  note: string;
  tone?: 'plain' | 'live';
}) {
  return (
    <Card className="p-4">
      <p className="eyebrow text-[9px] text-ink-500">{label}</p>
      <p className="display text-[38px] text-ink-900 tnum mt-1.5 leading-none">{value}</p>
      <p className={`text-[11px] mt-2 ${tone === 'live' ? 'text-live-700' : 'text-ink-500'}`}>
        {note}
      </p>
    </Card>
  );
}

/**
 * One venue.
 *
 * The whole row is the target rather than the pencil in the last column. A
 * 32px icon at the far right of a 900px row is a small target a long way from
 * where the eye is, and there is only one action — open it. The chevron stays
 * because a row that is clickable and does not look it gets clicked by accident
 * and not on purpose.
 */
function Row({ court: c, onOpen }: { court: CourtSummary; onOpen: () => void }) {
  const initial = c.name.trim().slice(0, 1).toUpperCase();

  return (
    <tr className="cursor-pointer" onClick={onOpen}>
      <td className="px-4 py-3.5">
        <div className="flex items-center gap-3">
          {/* No venue photograph exists, and one upload per court to show a
              thumbnail is not worth chasing. A deterministic tile from the name
              gives the row the same visual anchor and never 404s. */}
          <span
            aria-hidden
            className="size-10 shrink-0 grid place-items-center rounded-lg bg-ink-100 display text-[18px] text-ink-500"
          >
            {initial}
          </span>
          <span className="min-w-0">
            <span className="block font-bold text-[14px] text-ink-900 truncate">{c.name}</span>
            <span className="block text-[12px] text-ink-500 mt-0.5">
              {c.activeVendorCount} of {c.vendorCount}{' '}
              {c.vendorCount === 1 ? 'stall' : 'stalls'} live
            </span>
          </span>
        </div>
      </td>

      <td className="px-4 py-3.5 hidden md:table-cell">
        <span className="flex items-start gap-1.5 text-[12px] text-ink-500">
          <svg viewBox="0 0 24 24" className="size-3.5 mt-0.5 shrink-0" fill="none" aria-hidden>
            <path
              d="M12 21s7-5.5 7-11a7 7 0 10-14 0c0 5.5 7 11 7 11z"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinejoin="round"
            />
            <circle cx="12" cy="10" r="2.4" stroke="currentColor" strokeWidth="1.7" />
          </svg>
          <span className="min-w-0">
            {c.address ? <span className="block truncate">{c.address}</span> : null}
            <span className="block">{c.city}</span>
          </span>
        </span>
      </td>

      <td className="px-4 py-3.5 hidden sm:table-cell">
        <span
          className={`text-[16px] font-bold tnum ${
            c.liveOrderCount > 0 ? 'text-ink-900' : 'text-ink-400'
          }`}
        >
          {c.liveOrderCount}
        </span>
      </td>

      <td className="px-4 py-3.5">
        <span className="flex flex-col items-start gap-1.5">
          <StatusPill status={c.status} />
          {/* The distinction the status pill cannot carry: live, and unreachable. */}
          {!c.hasQr && c.status === 'ACTIVE' ? (
            <span className="rounded-md bg-draft-50 px-2 py-0.5 text-[10px] font-semibold text-draft-700">
              No QR
            </span>
          ) : null}
        </span>
      </td>

      <td className="px-4 py-3.5 text-right">
        <svg viewBox="0 0 24 24" className="size-4 text-ink-400 inline-block" fill="none" aria-hidden>
          <path
            d="M9 5l7 7-7 7"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </td>
    </tr>
  );
}

/**
 * Three fields, and only two are required.
 *
 * Everything else about a court — hours, taxes, ordering rules — has a working
 * default and can be edited after. Asking for it here would turn a ten-second
 * act into a form, and the person doing this has a vendor waiting.
 */
function NewCourt({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [city, setCity] = useState('');
  const [address, setAddress] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api.createCourt({
        name: name.trim(),
        city: city.trim(),
        ...(address.trim() ? { address: address.trim() } : {}),
      }),
    onSuccess: (c) => onCreated(c.id),
  });

  const canSubmit = name.trim().length >= 2 && city.trim().length >= 2 && !create.isPending;

  return (
    <Card className="p-5 mb-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) create.mutate();
        }}
      >
        <h2 className="font-bold text-[15px] text-ink-900 mb-4">New food court</h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required hint="What customers see when they scan.">
            <Input value={name} onChange={setName} placeholder="Phoenix Marketcity — Level 3" />
          </Field>

          <Field label="City" required>
            <Input value={city} onChange={setCity} placeholder="Ahmedabad" />
          </Field>
        </div>

        <div className="mt-4">
          <Field label="Address" hint="For your own records. Not shown to customers.">
            <Input value={address} onChange={setAddress} />
          </Field>
        </div>

        {create.isError ? (
          <div className="mt-4">
            <ErrorNote error={create.error} />
          </div>
        ) : null}

        <p className="text-[11px] text-ink-500 mt-4 leading-relaxed">
          The court is created live, but with <strong>no QR code</strong> — so nothing can be
          scanned until one is issued. Issuing it is a separate, audited step, because a QR is the
          credential to the whole venue.
        </p>

        <div className="flex gap-2 mt-4">
          <Button type="submit" disabled={!canSubmit}>
            {create.isPending ? 'Creating…' : 'Create food court'}
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
