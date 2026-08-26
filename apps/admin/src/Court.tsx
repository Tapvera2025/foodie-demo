import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, type EntityStatus } from './api';
import { CourtQr } from './CourtQr';
import {
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  ReasonDialog,
  Spinner,
  STATUS,
  StatusPill,
} from './ui';

/**
 * One court, and the stalls inside it.
 *
 * The screen where a stall is created. Everything about a stall's onboarding
 * happens on the next screen down; this one exists to get it created and to
 * show, per stall, how far off live it is.
 */
export function Court() {
  const { courtId } = useParams<{ courtId: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);

  const court = useQuery({
    queryKey: ['court', courtId],
    queryFn: () => api.court(courtId!),
    enabled: Boolean(courtId),
  });

  const vendors = useQuery({
    queryKey: ['vendors', courtId],
    queryFn: () => api.vendors(courtId!),
    enabled: Boolean(courtId),
  });

  const setStatus = useMutation({
    mutationFn: (v: { status: EntityStatus; reason: string }) =>
      api.setCourtStatus(courtId!, v.status, v.reason),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['court', courtId] });
      void qc.invalidateQueries({ queryKey: ['courts'] });
    },
  });

  if (court.isLoading) return <Spinner label="Loading…" />;
  if (court.isError || !court.data) {
    return <ErrorNote error={court.error} onRetry={() => void court.refetch()} />;
  }

  const c = court.data;
  const list = vendors.data?.vendors ?? [];

  return (
    <div>
      <button
        onClick={() => navigate('/courts')}
        className="pressable text-[12px] font-semibold text-ink-500 hover:text-ink-900 mb-3"
      >
        ← All food courts
      </button>

      <div className="flex items-start justify-between gap-4 mb-1">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h1 className="display text-[26px] text-ink-900 truncate">{c.name}</h1>
            <StatusPill status={c.status} />
          </div>
          <p className="text-[13px] text-ink-500 mt-0.5">
            {c.city}
            {c.address ? ` · ${c.address}` : ''}
          </p>
        </div>

        <CourtActions
          status={c.status}
          pending={setStatus.isPending}
          onChange={(status, reason) => setStatus.mutate({ status, reason })}
        />
      </div>

      <p className="text-[12px] text-ink-500 mb-5">{STATUS[c.status].hint}</p>

      {setStatus.isError ? (
        <div className="mb-4">
          <ErrorNote error={setStatus.error} />
        </div>
      ) : null}

      <CourtQr courtId={courtId!} />

      {/* ---------------------------------------------------------- stalls */}

      <div className="flex items-baseline justify-between gap-4 mb-3 mt-8">
        <h2 className="display text-[19px] text-ink-900">
          Stalls
          <span className="ml-2 text-[13px] font-medium text-ink-400 tnum">{list.length}</span>
        </h2>
        {!adding && c.status !== 'INACTIVE' ? (
          <Button onClick={() => setAdding(true)}>Add a stall</Button>
        ) : null}
      </div>

      {adding ? (
        <NewVendor
          courtId={courtId!}
          onCancel={() => setAdding(false)}
          onCreated={(id) => {
            setAdding(false);
            void qc.invalidateQueries({ queryKey: ['vendors', courtId] });
            navigate(`/stalls/${id}`);
          }}
        />
      ) : null}

      {vendors.isLoading ? <Spinner label="Loading stalls…" /> : null}
      {vendors.isError ? (
        <ErrorNote error={vendors.error} onRetry={() => void vendors.refetch()} />
      ) : null}

      {vendors.data && list.length === 0 && !adding ? (
        <EmptyState
          title="No stalls yet"
          body="A stall is one kitchen. It starts in onboarding and goes live once its licence, settlement account, menu and staff login are all in place."
          action={<Button onClick={() => setAdding(true)}>Add the first stall</Button>}
        />
      ) : null}

      {list.length > 0 ? (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-ink-100">
            {list.map((v) => (
              <li key={v.id}>
                <button
                  onClick={() => navigate(`/stalls/${v.id}`)}
                  className="pressable w-full text-left px-4 py-3.5 flex items-center gap-4"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2.5">
                      <span className="font-semibold text-[14px] text-ink-900 truncate">
                        {v.name}
                      </span>
                      <StatusPill status={v.status} />
                    </span>
                    <span className="block text-[12px] text-ink-500 mt-0.5 truncate">
                      {v.cuisine.length > 0 ? v.cuisine.join(' ·') : 'No cuisine set'} · about{' '}
                      {v.estimatedPrepMinutes} min
                    </span>
                  </span>

                  {/*
                    The blocker count, and only while it matters.
                    Shown for a stall that is not live: it is the distance to
                    live, and it is the single most useful number on this row.
                    Hidden once live, where it is always zero and therefore noise.
                  */}
                  {v.status !== 'ACTIVE' && v.status !== 'INACTIVE' ? (
                    <span
                      className={`shrink-0 rounded-md px-2 py-0.5 text-[11px] font-semibold ${
                        v.blockerCount === 0
                          ? 'bg-live-50 text-live-700'
                          : 'bg-draft-50 text-draft-700'
                      }`}
                    >
                      {v.blockerCount === 0
                        ? 'Ready to go live'
                        : `${v.blockerCount} left`}
                    </span>
                  ) : null}

                  <svg
                    viewBox="0 0 24 24"
                    className="size-4 text-ink-400 shrink-0"
                    fill="none"
                    aria-hidden
                  >
                    <path
                      d="M9 5l7 7-7 7"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

/**
 * Status actions, offered only where the transition is legal.
 *
 * The allowed set mirrors `canTransitionCourt` on the server. Duplicating it is
 * a real cost — two places to change — and the alternative is worse: showing a
 * button that always fails teaches people to distrust the console. The server
 * remains the authority; this only decides what to render.
 */
function CourtActions({
  status,
  pending,
  onChange,
}: {
  status: EntityStatus;
  pending: boolean;
  onChange: (to: EntityStatus, reason: string) => void;
}) {
  /**
   * Which change is being asked about, or null.
   *
   * State rather than `window.prompt` because the prompt was synchronous and
   * blocking — it stopped every poll in the console, and it appeared at the top
   * of the window rather than near the button, so on a court page with a dozen
   * stalls it never said WHICH thing was about to be suspended.
   */
  const [asking, setAsking] = useState<{ to: EntityStatus; verb: string } | null>(null);

  if (status === 'INACTIVE') return null;

  const CONSEQUENCE: Partial<Record<EntityStatus, string>> = {
    SUSPENDED:
      'Customers scanning this venue stop getting in immediately. Orders already cooking are unaffected.',
    INACTIVE:
      'Closing is not reversible from here. Bringing the venue back means onboarding it again from the start.',
  };

  return (
    <>
      <div className="flex gap-2 shrink-0">
        {status === 'SUSPENDED' ? (
          <Button
            variant="secondary"
            disabled={pending}
            onClick={() => setAsking({ to: 'ACTIVE', verb: 'put back live' })}
          >
            Put back live
          </Button>
        ) : null}
        {status === 'ACTIVE' ? (
          <Button
            variant="secondary"
            disabled={pending}
            onClick={() => setAsking({ to: 'SUSPENDED', verb: 'put on hold' })}
          >
            Put on hold
          </Button>
        ) : null}
        <Button
          variant="danger"
          disabled={pending}
          onClick={() => setAsking({ to: 'INACTIVE', verb: 'closed' })}
        >
          Close
        </Button>
      </div>

      {asking ? (
        <ReasonDialog
          title={`Why is this court being ${asking.verb}?`}
          prompt="Whoever reads this later will not have the context you have now."
          {...(CONSEQUENCE[asking.to] ? { consequence: CONSEQUENCE[asking.to]! } : {})}
          confirmLabel={asking.to === 'ACTIVE' ? 'Put back live' : `Confirm`}
          tone={asking.to === 'ACTIVE' ? 'primary' : 'danger'}
          pending={pending}
          onCancel={() => setAsking(null)}
          onConfirm={(reason) => {
            onChange(asking.to, reason);
            setAsking(null);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * A stall is created with a name and nothing else.
 *
 * §5.1 lists eleven things onboarding collects, and they arrive over days — an
 * FSSAI number by WhatsApp on Tuesday, a bank account on Friday. A form
 * demanding all eleven means losing Tuesday's while waiting for Friday's. So
 * the stall is created DRAFT immediately and filled in as things arrive.
 */
function NewVendor({
  courtId,
  onCancel,
  onCreated,
}: {
  courtId: string;
  onCancel: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [cuisine, setCuisine] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api.createVendor(courtId, {
        name: name.trim(),
        ...(cuisine.trim()
          ? {
              cuisine: cuisine
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
                .slice(0, 6),
            }
          : {}),
      }),
    onSuccess: (v) => onCreated(v.id),
  });

  const canSubmit = name.trim().length >= 2 && !create.isPending;

  return (
    <Card className="p-5 mb-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) create.mutate();
        }}
      >
        <h3 className="display text-[18px] text-ink-900 mb-4">New stall</h3>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Stall name" required hint="The trading name customers see.">
            <Input value={name} onChange={setName} placeholder="Tandoor Tales" />
          </Field>

          <Field label="Cuisine" hint="Comma separated. Up to six.">
            <Input value={cuisine} onChange={setCuisine} placeholder="North Indian, Mughlai" />
          </Field>
        </div>

        {create.isError ? (
          <div className="mt-4">
            <ErrorNote error={create.error} />
          </div>
        ) : null}

        <p className="text-[11px] text-ink-500 mt-4 leading-relaxed">
          Created in <strong>onboarding</strong>, never live. It cannot take an order until its
          legal name, PAN, FSSAI licence, settlement account, KYC, menu and a staff login are all
          in place — the next screen shows exactly what is outstanding.
        </p>

        <div className="flex gap-2 mt-4">
          <Button type="submit" disabled={!canSubmit}>
            {create.isPending ? 'Creating…' : 'Create stall'}
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
