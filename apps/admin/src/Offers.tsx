import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, type OfferSlotRow } from './api';
import { Button, Card, EmptyState, ErrorNote, Spinner } from './ui';

/**
 * Who appears in the customer app's offer carousel.
 *
 * ============================================================================
 * ONE LIST, EVERY COURT, AND NO STALL PAGE
 * ============================================================================
 *
 * The grant already existed, on each stall's own page. That is the wrong place
 * for it and the reason is arithmetic: answering a request meant knowing which
 * venue the stall was in, opening that court, finding the stall, scrolling to
 * the panel. Four navigations to press one switch — and no way at all to see
 * that a request was waiting, because nothing surfaced it.
 *
 * So this is a queue. Requests first, oldest at the top, and the switch is on
 * the row.
 *
 * ============================================================================
 * WHY THE CAROUSEL IS RATIONED AT ALL
 * ============================================================================
 *
 * It is the first thing on the customer home screen, above any stall list, on
 * every visit. Space there is not neutral — a stall in it is a stall the others
 * are behind. Granting it per stall is what makes it something the platform can
 * sell, ration, or withdraw, rather than something the first stall to find the
 * button takes permanently.
 */

/** `2 days ago`, `4 hours ago`. How long somebody has been waiting. */
function waited(iso: string): string {
  const mins = Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

export function Offers() {
  const qc = useQueryClient();

  const q = useQuery({
    queryKey: ['offer-slots'],
    queryFn: api.offerSlots,
    // A request arrives from a kitchen tablet, not from this screen. Thirty
    // seconds is often enough for a queue somebody works through in batches.
    refetchInterval: 30_000,
  });

  const decide = useMutation({
    mutationFn: (v: { vendorId: string; enabled: boolean }) =>
      api.setOfferSlot(v.vendorId, v.enabled),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['offer-slots'] });
      // A stall page open in another tab reads the same flag.
      void qc.invalidateQueries({ queryKey: ['vendor'] });
    },
  });

  const stalls = q.data?.stalls ?? [];
  const pending = stalls.filter((s) => s.requestedAt !== null);
  const granted = stalls.filter((s) => s.enabled);
  const rest = stalls.filter((s) => !s.enabled && s.requestedAt === null);

  const busy = (id: string): boolean => decide.isPending && decide.variables?.vendorId === id;

  return (
    <div>
      <div className="mb-5">
        <h1 className="display text-[26px] text-ink-900">Offer carousel</h1>
        <p className="text-[12px] text-ink-500 mt-1 leading-relaxed max-w-prose">
          Which stalls may put a banner at the top of the customer app. The platform grants the
          slot; the stall uploads its own artwork from its kitchen board. A banner applies no
          discount — it is the stall's own claim about its menu.
        </p>
      </div>

      {q.isLoading ? <Spinner label="Reading every court…" /> : null}
      {q.isError ? <ErrorNote error={q.error} onRetry={() => void q.refetch()} /> : null}
      {decide.isError ? (
        <div className="mb-4">
          <ErrorNote error={decide.error} />
        </div>
      ) : null}

      {/* ------------------------------------------------------- waiting */}
      {pending.length > 0 ? (
        <section className="mb-6">
          <h2 className="eyebrow text-[9px] text-ink-500 mb-2">
            Waiting on you ({pending.length})
          </h2>
          <Card className="overflow-hidden border border-draft-500">
            <ul className="divide-y divide-ink-100">
              {pending.map((s) => (
                <Row
                  key={s.id}
                  stall={s}
                  busy={busy(s.id)}
                  onDecide={(enabled) => decide.mutate({ vendorId: s.id, enabled })}
                />
              ))}
            </ul>
          </Card>
        </section>
      ) : null}

      {/* ------------------------------------------------------- granted */}
      {granted.length > 0 ? (
        <section className="mb-6">
          <h2 className="eyebrow text-[9px] text-ink-500 mb-2">In the carousel ({granted.length})</h2>
          <Card className="overflow-hidden">
            <ul className="divide-y divide-ink-100">
              {granted.map((s) => (
                <Row
                  key={s.id}
                  stall={s}
                  busy={busy(s.id)}
                  onDecide={(enabled) => decide.mutate({ vendorId: s.id, enabled })}
                />
              ))}
            </ul>
          </Card>
        </section>
      ) : null}

      {/* --------------------------------------------------- everyone else */}
      {rest.length > 0 ? (
        <section>
          <h2 className="eyebrow text-[9px] text-ink-500 mb-2">No slot ({rest.length})</h2>
          <Card className="overflow-hidden">
            <ul className="divide-y divide-ink-100">
              {rest.map((s) => (
                <Row
                  key={s.id}
                  stall={s}
                  busy={busy(s.id)}
                  onDecide={(enabled) => decide.mutate({ vendorId: s.id, enabled })}
                />
              ))}
            </ul>
          </Card>
        </section>
      ) : null}

      {q.data && stalls.length === 0 ? (
        <EmptyState
          title="No stalls yet"
          body="Once a court has stalls, they appear here and can be given a carousel slot."
        />
      ) : null}
    </div>
  );
}

function Row({
  stall,
  busy,
  onDecide,
}: {
  stall: OfferSlotRow;
  busy: boolean;
  onDecide: (enabled: boolean) => void;
}) {
  const waiting = stall.requestedAt !== null;

  return (
    <li className="px-4 py-3 flex items-center gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[14px] font-bold text-ink-900 truncate">{stall.name}</span>
          {/* The COURT, on every row. The whole point of one list across every
              venue is that you never have to ask which one a stall is in. */}
          <span className="text-[12px] text-ink-500">{stall.foodCourtName}</span>
          {stall.status !== 'ACTIVE' ? (
            <span className="rounded-md bg-draft-50 px-2 py-0.5 text-[11px] font-semibold text-draft-700">
              {stall.status === 'DRAFT' ? 'Onboarding' : 'On hold'}
            </span>
          ) : null}
        </div>

        <p className="text-[12px] text-ink-500 mt-0.5 leading-relaxed">
          {waiting ? (
            <span className="text-draft-700 font-semibold">Asked {waited(stall.requestedAt!)}</span>
          ) : stall.enabled ? (
            stall.filled ? (
              /*
                "LIVE" ONLY WHEN IT IS ACTUALLY ON A CUSTOMER'S SCREEN.
                
                This said "Live" the moment a slot was granted and filled, which
                is a claim about the customer app and was wrong every time the
                stall was shut — the carousel deliberately carries only stalls
                accepting orders right now. An operator would grant, watch the
                upload land, read "Live", open the app and find nothing, with no
                way to tell a broken configuration from a stall that closes at
                four. The server now answers the question it was really asking.
              */
              stall.showingNow ? (
                <span className="text-live-700 font-semibold">
                  Showing now: “{stall.headline}”
                </span>
              ) : (
                <span className="text-draft-700">
                  Ready, not showing — {stall.notShowingReason}
                </span>
              )
            ) : (
              /* Granted and empty is the state worth naming. The stall has the
                 slot and the customer sees nothing — usually because nobody
                 told them it had been given. */
              <span className="text-draft-700">Slot granted, nothing uploaded yet</span>
            )
          ) : stall.decidedAt ? (
            <>Declined or withdrawn earlier</>
          ) : (
            <>Never asked</>
          )}
        </p>
      </div>

      <div className="shrink-0 flex gap-2">
        {stall.enabled ? (
          <Button variant="danger" disabled={busy} onClick={() => onDecide(false)}>
            {busy ? 'Saving…' : 'Withdraw'}
          </Button>
        ) : (
          <>
            <Button disabled={busy} onClick={() => onDecide(true)}>
              {busy ? 'Saving…' : 'Grant'}
            </Button>
            {/* Declining is only offered against a REQUEST. On a stall that
                never asked there is nothing to decline, and a button saying so
                would be an action with no object. */}
            {waiting ? (
              <Button variant="secondary" disabled={busy} onClick={() => onDecide(false)}>
                Decline
              </Button>
            ) : null}
          </>
        )}
      </div>
    </li>
  );
}
