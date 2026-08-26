import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, type EntityStatus, type SettlementMode, type VendorDetail, type VendorPatch } from './api';
import { MenuImport, OfferSlot, OpeningHours, StaffAccounts } from './StallSetup';
import {
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  ReasonDialog,
  Select,
  Spinner,
  STATUS,
  StatusPill,
} from './ui';

/**
 * One stall: its onboarding, and the gate between onboarding and taking money.
 *
 * THE CHECKLIST IS THE SCREEN.
 *
 * `assessVendorReadiness` has existed since week two — pure, exhaustively
 * tested, and unreachable. Its own header says why it is a gate and not form
 * validation: every item is something that, if missing, fails *after* a
 * customer has paid. No settlement account and the platform holds money it
 * cannot forward. No staff login and orders arrive at a kitchen that cannot see
 * them, firing the escalation ladder on every single one.
 *
 * So the checklist is not decoration around a form. It is the form's purpose:
 * turn eleven expensive late failures into a list somebody can work through
 * while the vendor is still on the phone.
 *
 * THE UI IS NOT THE CHECK.
 *
 * Worth stating because the screen makes it look otherwise. `Go live` is
 * disabled while blockers remain, and that is a courtesy. The gate runs on the
 * server, inside the transaction that flips the status, against a locked row —
 * so a stall cannot go live because someone re-enabled a button, and cannot go
 * live on a menu item that sold out between the check and the write.
 */

/** Which field each blocker points at, so the list can scroll to it. */
const BLOCKER_ANCHOR: Record<string, string> = {
  LEGAL_NAME_MISSING: 'legalName',
  SETTLEMENT_MODE_MISSING: 'settlementMode',
  PAN_MISSING: 'pan',
  PAN_MALFORMED: 'pan',
  GSTIN_MALFORMED: 'gstin',
  FSSAI_MISSING: 'fssaiLicence',
  BANK_ACCOUNT_MISSING: 'bankAccountRef',
  KYC_INCOMPLETE: 'kyc',
  PROVIDER_ACCOUNT_MISSING: 'providerLinkedAccountId',
  MENU_EMPTY: 'menu',
  NO_STAFF_ACCOUNT: 'staff',
};

/**
 * The live verdict, shared by the checklist and the Go-live button.
 *
 * One `useQuery` per caller, one cache entry — TanStack keys by `queryKey`, so
 * calling this in two components subscribes both to the same poll rather than
 * running two. That matters more than it looks: if the button read the vendor
 * snapshot while the checklist read the poll, clearing the last blocker from a
 * terminal would empty the list and leave the button disabled, which reads as
 * the console being broken.
 *
 * Polls only while there is something to notice. A live stall has nothing left
 * to clear and a closed one is not coming back.
 */
function useReadiness(vendor: VendorDetail) {
  return useQuery({
    queryKey: ['readiness', vendor.id],
    queryFn: () => api.readiness(vendor.id),
    initialData: {
      status: vendor.status,
      canActivate: vendor.readiness.canActivate,
      blockers: vendor.readiness.blockers,
      warnings: vendor.readiness.warnings,
      availableMenuItemCount: vendor.availableMenuItemCount,
      activeStaffCount: vendor.activeStaffCount,
    },
    refetchInterval: vendor.status === 'DRAFT' || vendor.status === 'SUSPENDED' ? 10_000 : false,
  }).data;
}

/**
 * Fetch, then hand off.
 *
 * The split is not cosmetic. `useReadiness` has to run unconditionally, and
 * this component returns early three times before the vendor exists — a hook
 * after those returns breaks the rules of hooks and, worse, does so
 * intermittently, because whether it is reached depends on the network.
 *
 * So the loading and error branches live here, and everything that needs the
 * loaded vendor lives in `Loaded`, where the vendor is a prop and therefore
 * always present.
 */
export function Stall() {
  const { vendorId } = useParams<{ vendorId: string }>();

  const q = useQuery({
    queryKey: ['vendor', vendorId],
    queryFn: () => api.vendor(vendorId!),
    enabled: Boolean(vendorId),
  });

  if (q.isLoading) return <Spinner label="Loading stall…" />;
  if (q.isError || !q.data) return <ErrorNote error={q.error} onRetry={() => void q.refetch()} />;

  return <Loaded vendor={q.data} />;
}

function Loaded({ vendor: v }: { vendor: VendorDetail }) {
  const navigate = useNavigate();
  const qc = useQueryClient();

  // The polled verdict, shared with the checklist through the query cache. The
  // Go-live button must agree with the list beside it.
  const r = useReadiness(v);

  const setStatus = useMutation({
    mutationFn: (x: { status: EntityStatus; reason: string }) =>
      api.setVendorStatus(v.id, x.status, x.reason),
    onSuccess: (updated) => {
      qc.setQueryData(['vendor', v.id], updated);
      void qc.invalidateQueries({ queryKey: ['readiness', v.id] });
      void qc.invalidateQueries({ queryKey: ['vendors', updated.foodCourtId] });
      void qc.invalidateQueries({ queryKey: ['courts'] });
    },
  });

  /**
   * Which status change is being asked about, or null.
   *
   * This is the console's most-pressed dialog — every stall that ever goes live
   * goes through it — and it was a `window.prompt`. Beyond the styling, the
   * prompt could not say WHAT GOING LIVE MEANS: that the stall starts taking
   * real money from real customers the moment the button is pressed. One line
   * of unstyled OS text was carrying the most consequential action in the
   * product.
   */
  const [asking, setAsking] = useState<{ to: EntityStatus; verb: string } | null>(null);

  const CONSEQUENCE: Partial<Record<EntityStatus, string>> = {
    ACTIVE:
      'The stall appears in the customer app immediately and starts taking real payments. Make sure the kitchen tablet is switched on and somebody is watching it.',
    SUSPENDED:
      'The stall stops appearing to customers. Orders already cooking are unaffected, and it can be put back live at any time.',
    INACTIVE:
      'Closing is not reversible. Bringing this stall back means onboarding it again from scratch — bank details, licence and menu included.',
  };

  return (
    <div>
      <button
        onClick={() => navigate(`/courts/${v.foodCourtId}`)}
        className="pressable text-[12px] font-semibold text-ink-500 hover:text-ink-900 mb-3"
      >
        ← Back to the court
      </button>

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex items-start gap-3.5">
          {/* The same initial tile the venue table uses. No stall photograph
              exists and one upload per stall to fill a 44px square is not worth
              chasing; a deterministic tile anchors the row and never 404s. */}
          <span
            aria-hidden
            className="size-11 shrink-0 grid place-items-center rounded-xl bg-ink-100 display text-[20px] text-ink-500"
          >
            {v.name.trim().slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h1 className="display text-[26px] text-ink-900 truncate">{v.name}</h1>
              <StatusPill status={v.status} />
            </div>
            <p className="text-[12px] text-ink-500 mt-1">{STATUS[v.status].hint}</p>
          </div>
        </div>

        <div className="flex gap-2 shrink-0">
          {(v.status === 'DRAFT' || v.status === 'SUSPENDED') ? (
            <Button
              disabled={!r.canActivate || setStatus.isPending}
              onClick={() => setAsking({ to: 'ACTIVE', verb: 'put live' })}
            >
              {setStatus.isPending ? 'Working…' : 'Go live'}
            </Button>
          ) : null}
          {v.status === 'ACTIVE' ? (
            <Button
              variant="secondary"
              disabled={setStatus.isPending}
              onClick={() => setAsking({ to: 'SUSPENDED', verb: 'put on hold' })}
            >
              Put on hold
            </Button>
          ) : null}
          {v.status !== 'INACTIVE' ? (
            <Button
              variant="danger"
              disabled={setStatus.isPending}
              onClick={() => setAsking({ to: 'INACTIVE', verb: 'closed' })}
            >
              Close
            </Button>
          ) : null}
        </div>
      </div>

      {asking ? (
        <ReasonDialog
          title={`Why is this stall being ${asking.verb}?`}
          prompt={`${v.name}. Whoever reads this later will not have the context you have now.`}
          {...(CONSEQUENCE[asking.to] ? { consequence: CONSEQUENCE[asking.to]! } : {})}
          confirmLabel={asking.to === 'ACTIVE' ? 'Put the stall live' : 'Confirm'}
          tone={asking.to === 'ACTIVE' ? 'primary' : 'danger'}
          pending={setStatus.isPending}
          onCancel={() => setAsking(null)}
          onConfirm={(reason) => {
            setStatus.mutate({ status: asking.to, reason });
            setAsking(null);
          }}
        />
      ) : null}

      {setStatus.isError ? (
        <div className="mt-4">
          <ErrorNote error={setStatus.error} />
        </div>
      ) : null}

      {v.status === 'INACTIVE' ? (
        <div className="mt-5 rounded-lg border border-ink-200 bg-ink-50 px-4 py-3">
          <p className="text-[13px] font-semibold text-ink-800">This stall has left the court.</p>
          <p className="text-[12px] text-ink-500 mt-1 leading-relaxed">
            It cannot be reopened. If it comes back, create it again and onboard it fresh — its
            bank details, licence and menu have all had time to change, and silently reusing stale
            settlement details is how money reaches the wrong account.
          </p>
        </div>
      ) : (
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] items-start">
          <div className="space-y-6 min-w-0">
            <OnboardingForm vendor={v} />

            {/*
              The two blockers the checklist could name and not clear.
              Below the form rather than above it because they are usually done
              once, whereas the compliance fields get revisited as documents
              arrive. Both are in the left column so the checklist beside them
              can be watched clearing as each one lands.
            */}
            <MenuImport vendor={v} />
            <OpeningHours vendor={v} />
            <OfferSlot vendor={v} />
            <StaffAccounts vendor={v} />
          </div>

          <Checklist vendor={v} />
        </div>
      )}
    </div>
  );
}

// =============================================================================
// The checklist
// =============================================================================

function Checklist({ vendor }: { vendor: VendorDetail }) {
  /*
   * Two of the eleven blockers are cleared somewhere other than this console: a
   * menu arrives via the CSV import endpoint and a kitchen login via SQL. Both
   * are things you do in a terminal with this page open beside it, so the list
   * polls rather than waiting for a save that is never going to come.
   */
  const r = useReadiness(vendor);
  const done = r.canActivate;

  const jump = (code: string): void => {
    const id = BLOCKER_ANCHOR[code];
    if (!id) return;
    const el = document.getElementById(id);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });

    /**
     * `.focus()`, not `dispatchEvent(new Event('focus'))`.
     *
     * The first version dispatched a synthetic focus event, which notifies
     * listeners and moves nothing: the caret stays where it was and the field
     * is not focused. It typecheck-passes, throws nothing, and silently does
     * half the job — you scroll to the field and still have to click it.
     *
     * `preventScroll` because `scrollIntoView` above has already positioned it;
     * letting focus scroll again fights the smooth animation and lands the
     * field at the top of the viewport instead of the centre.
     */
    el?.querySelector<HTMLElement>('input, select')?.focus({ preventScroll: true });
  };

  return (
    <Card className="p-4 lg:sticky lg:top-4">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h2 className="display text-[17px] text-ink-900">Before going live</h2>
        <span
          className={`text-[12px] font-bold tnum ${done ? 'text-live-700' : 'text-draft-700'}`}
        >
          {done ? 'Ready' : `${r.blockers.length} left`}
        </span>
      </div>

      {done ? (
        <p className="rounded-lg bg-live-50 text-live-700 px-3 py-2.5 text-[12px] leading-relaxed">
          {/*
            "Everything the platform needs" is precise, and it is the point.
            It does NOT say everything is finished — with the menu now a warning
            a stall can be ready and still have nothing to sell, and the warning
            below says so. Claiming completeness here and contradicting it two
            lines down would make both lines untrustworthy.
          */}
          Everything the platform needs is in place. This stall can start taking money.
        </p>
      ) : (
        <ul className="space-y-2">
          {r.blockers.map((b) => (
            <li key={b.code}>
              <button
                onClick={() => jump(b.code)}
                className="pressable glass-hover w-full text-left rounded-lg bg-draft-50 px-3 py-2 hover:brightness-95"
              >
                <span className="flex gap-2">
                  <span aria-hidden className="text-draft-700 font-bold leading-5">
                    ·
                  </span>
                  <span className="text-[12px] text-draft-700 leading-relaxed">{b.message}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {/*
        WARNINGS ARE RENDERED LIKE WARNINGS, NOT LIKE FOOTNOTES.
        They used to be 11px grey text under the list — which was fine while
        nothing ever produced one. Now that an empty menu warns instead of
        blocking, this is the only thing standing between "the stall went live"
        and "the stall went live selling nothing", so it gets a tinted card and
        the same weight as a blocker.
      */}
      {r.warnings.length > 0 ? (
        <ul className={`space-y-2 ${done ? 'mt-3' : 'mt-2'}`}>
          {r.warnings.map((w) => (
            <li
              key={w.code}
              className="rounded-lg border border-draft-500/40 bg-draft-50 px-3 py-2"
            >
              <span className="flex gap-2">
                <svg
                  viewBox="0 0 24 24"
                  className="size-3.5 shrink-0 mt-0.5 text-draft-700"
                  fill="none"
                  aria-hidden
                >
                  <path
                    d="M12 4l9 16H3l9-16z"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinejoin="round"
                  />
                  <path d="M12 10v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  <circle cx="12" cy="16.75" r="0.9" fill="currentColor" />
                </svg>
                <span className="text-[12px] text-draft-700 leading-relaxed">{w.message}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {/*
        Two counts that are NOT editable here, and saying so.

        A menu comes from a CSV import and staff logins are issued separately.
        Rendering them as read-only rows next to eleven editable fields would
        invite somebody to look for the missing input; naming where each is
        actually done costs two lines and saves the search.
      */}
      <div className="mt-4 pt-4 border-t border-ink-100 space-y-2.5">
        {/* From the polled verdict, not the vendor snapshot — these are the two
            numbers that change without anyone touching this page. */}
        <CountRow
          id="menu"
          label="Available menu items"
          value={r.availableMenuItemCount}
          where="Imported from a spreadsheet — not edited here."
        />
        <CountRow
          id="staff"
          label="Kitchen logins"
          value={r.activeStaffCount}
          where="Created by the platform, not by the vendor."
        />
      </div>
    </Card>
  );
}

function CountRow({
  id,
  label,
  value,
  where,
}: {
  id: string;
  label: string;
  value: number;
  where: string;
}) {
  return (
    <div id={id}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[12px] font-semibold text-ink-700">{label}</span>
        <span
          className={`text-[13px] font-bold tnum ${value === 0 ? 'text-draft-700' : 'text-ink-900'}`}
        >
          {value}
        </span>
      </div>
      <p className="text-[11px] text-ink-400 leading-relaxed mt-0.5">{where}</p>
    </div>
  );
}

// =============================================================================
// The form
// =============================================================================

const SETTLEMENT_OPTIONS = [
  ['PLATFORM_COLLECT', 'Platform collects, then splits'],
  ['VENDOR_DIRECT', 'Money goes straight to the vendor'],
] as const;

/**
 * Eleven fields, saved as a patch.
 *
 * LOCAL STATE, EXPLICIT SAVE — not save-on-blur.
 *
 * Onboarding is transcription: somebody is reading a PAN off a photograph of a
 * licence. Save-on-blur would write a half-typed PAN, the gate would call it
 * malformed, and the checklist would flash an error mid-keystroke. Worse, each
 * partial write is an audit row — so a single field would produce eleven
 * entries and bury the one that mattered.
 *
 * `dirty` is computed by comparing against the server's copy rather than
 * tracked by a flag, so re-typing a value back to what it was correctly leaves
 * nothing to save.
 */
function OnboardingForm({ vendor }: { vendor: VendorDetail }) {
  const qc = useQueryClient();

  const [form, setForm] = useState(() => toForm(vendor));

  /**
   * Re-seed when the server's VALUES change — not when its object identity does.
   *
   * THIS DISTINCTION IS THE WHOLE BUG.
   *
   * The first version was `useEffect(..., [vendor])`. `refetchOnWindowFocus` is
   * on, so every time the tab regained focus TanStack Query produced a new
   * object — same data, new identity — the effect fired, and the form reset.
   *
   * Which means: type half a PAN, alt-tab to read the licence photograph, come
   * back, and your typing is gone. On the one screen in this product whose
   * entire job is transcribing numbers off photographs. It would have looked
   * like a flaky app rather than a bug, because the data was never wrong — it
   * just kept reverting.
   *
   * Keying on a content fingerprint re-seeds after a real save (values changed)
   * and leaves the form alone on a refetch that returned the same row.
   */
  const fingerprint = JSON.stringify(toForm(vendor));
  useEffect(() => {
    setForm(toForm(vendor));
    // `vendor` deliberately absent: depending on it reintroduces the identity
    // problem the fingerprint exists to avoid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint]);

  const save = useMutation({
    mutationFn: () => api.updateVendor(vendor.id, diff(vendor, form)),
    onSuccess: (v) => {
      qc.setQueryData(['vendor', vendor.id], v);

      /**
       * THE READINESS QUERY MUST BE INVALIDATED HERE, AND WAS NOT.
       *
       * This was the "I fill everything in, save, and Go live does not appear —
       * sometimes" bug, and the "sometimes" is the tell.
       *
       * The checklist and the Go-live button both read `['readiness', id]`,
       * which polls every ten seconds while a stall is in onboarding. Saving
       * the form wrote `['vendor', id]` and left the readiness cache holding
       * the verdict from BEFORE the save. So the button stayed disabled until
       * the next poll happened to land — instant if you saved a second before
       * one, ten seconds if you saved a second after.
       *
       * The shape worth recognising: a derived query that is only refreshed on
       * a timer, and a mutation that changes what it derives from. The timer
       * hides the missing invalidation by eventually being right.
       */
      void qc.invalidateQueries({ queryKey: ['readiness', vendor.id] });
      void qc.invalidateQueries({ queryKey: ['vendors', v.foodCourtId] });
    },
  });

  const patch = diff(vendor, form);
  const dirty = Object.keys(patch).length > 0;

  const set = <K extends keyof FormState>(k: K, val: FormState[K]): void =>
    setForm((f) => ({ ...f, [k]: val }));

  return (
    <Card className="p-5">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty && !save.isPending) save.mutate();
        }}
      >
        <h2 className="display text-[18px] text-ink-900 mb-4">Business and settlement</h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Field label="Trading name" required hint="What customers see.">
              <Input value={form.name} onChange={(x) => set('name', x)} />
            </Field>
          </div>

          <div id="legalName">
            <Field
              label="Registered legal name"
              required
              hint="As it appears on the PAN. Often differs from the trading name — and a mismatch is a settlement mismatch."
            >
              <Input value={form.legalName} onChange={(x) => set('legalName', x)} />
            </Field>
          </div>

          <div>
            <Field label="Cuisine" hint="Comma separated. Up to six.">
              <Input value={form.cuisine} onChange={(x) => set('cuisine', x)} />
            </Field>
          </div>

          <div>
            <Field label="Preparation time" hint="Minutes. Shown to customers as “about N min”.">
              <Input
                type="number"
                value={form.estimatedPrepMinutes}
                onChange={(x) => set('estimatedPrepMinutes', x)}
              />
            </Field>
          </div>
        </div>

        <h3 className="display text-[16px] text-ink-900 mt-8 mb-3">Compliance</h3>

        <div className="grid gap-4 sm:grid-cols-2">
          <div id="pan">
            <Field label="PAN" required hint="Ten characters, like ABCDE1234F.">
              <Input value={form.pan} onChange={(x) => set('pan', x)} mono maxLength={10} />
            </Field>
          </div>

          <div id="gstin">
            <Field
              label="GSTIN"
              hint="Fifteen characters. Genuinely optional — a stall below the registration threshold has none."
            >
              <Input value={form.gstin} onChange={(x) => set('gstin', x)} mono maxLength={15} />
            </Field>
          </div>

          <div id="fssaiLicence" className="sm:col-span-2">
            <Field
              label="FSSAI licence number"
              required
              hint="Statutory for anyone selling food in India."
            >
              <Input
                value={form.fssaiLicence}
                onChange={(x) => set('fssaiLicence', x)}
                mono
                maxLength={20}
              />
            </Field>
          </div>
        </div>

        <h3 className="display text-[16px] text-ink-900 mt-8 mb-3">Settlement</h3>

        <div className="grid gap-4 sm:grid-cols-2">
          <div id="settlementMode">
            <Field
              label="How this stall is paid"
              required
              hint="Platform-collect means the platform takes the money and forwards the vendor's share."
            >
              <Select
                value={form.settlementMode}
                onChange={(x) => set('settlementMode', x)}
                options={SETTLEMENT_OPTIONS}
                placeholder="Not chosen yet"
              />
            </Field>
          </div>

          <div id="bankAccountRef">
            {/*
              "REFERENCE", AND THE HINT USED TO SAY SOMETHING FALSE.
              It read "Where the vendor's money goes", which is what the field
              looks like and is not what it does. Nothing in the payout path
              reads `bank_account_ref` — `vendor-onboarding.ts` uses it only to
              decide whether a stall's paperwork is complete, and the money is
              routed by the linked account below.
              A label that implies a bank account is where somebody eventually
              types one, and a real account number sitting in a free-text column
              nothing validates is worth avoiding on its own.
            */}
            <Field
              label="Settlement account reference"
              required
              hint="Your own reference for the stall's bank details — not an account number, and not what routes the money. Payouts go via the linked account below."
            >
              <Input
                value={form.bankAccountRef}
                onChange={(x) => set('bankAccountRef', x)}
                mono
              />
            </Field>
          </div>

          {/*
            Only PLATFORM_COLLECT needs a linked account: under VENDOR_DIRECT
            the money never touches the platform, so there is nothing to split.
            Hiding it under the other mode would be tidier and wrong — a field
            that vanishes looks like a bug, so it is disabled and explains why.
          */}
          <div id="providerLinkedAccountId" className="sm:col-span-2">
            <Field
              label="Payment provider linked account"
              required={form.settlementMode === 'PLATFORM_COLLECT'}
              hint={
                form.settlementMode === 'PLATFORM_COLLECT'
                  ? 'Without it the platform collects money it has nowhere to forward — which a regulated aggregator must not do.'
                  : 'Only needed when the platform collects. Under vendor-direct the money never touches the platform.'
              }
            >
              <Input
                value={form.providerLinkedAccountId}
                onChange={(x) => set('providerLinkedAccountId', x)}
                mono
                disabled={form.settlementMode !== 'PLATFORM_COLLECT'}
              />
            </Field>
          </div>
        </div>

        {/*
          KYC is a checkbox, and the SERVER stamps the date.
          Letting the console post a timestamp would let somebody backdate the
          moment the provider cleared this vendor — which is exactly the field
          an auditor would look at.
        */}
        <div id="kyc" className="mt-5">
          <label className="flex items-start gap-3 rounded-lg border border-ink-200 p-3 cursor-pointer">
            <input
              type="checkbox"
              checked={form.kycCompleted}
              onChange={(e) => set('kycCompleted', e.target.checked)}
              className="mt-0.5 size-4 accent-brand-500"
            />
            <span>
              <span className="block text-[13px] font-semibold text-ink-900">
                The payment provider has confirmed KYC
              </span>
              <span className="block text-[11px] text-ink-500 mt-0.5 leading-relaxed">
                Settlement stays frozen until it has. Tick this only when the provider says so —
                not when the documents were sent.
                {vendor.kycCompletedAt ? (
                  <>
                    {' '}
                    Confirmed{' '}
                    <span className="ident">
                      {new Date(vendor.kycCompletedAt).toLocaleDateString('en-IN')}
                    </span>
                    .
                  </>
                ) : null}
              </span>
            </span>
          </label>
        </div>

        {save.isError ? (
          <div className="mt-4">
            <ErrorNote error={save.error} />
          </div>
        ) : null}

        <div className="flex items-center gap-3 mt-6">
          <Button type="submit" disabled={!dirty || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
          {dirty ? (
            <span className="text-[12px] text-draft-700 font-medium">
              {Object.keys(patch).length} unsaved{' '}
              {Object.keys(patch).length === 1 ? 'change' : 'changes'}
            </span>
          ) : (
            <span className="text-[12px] text-ink-400">Saved</span>
          )}
        </div>
      </form>
    </Card>
  );
}

// =============================================================================
// Form <-> API shape
// =============================================================================

interface FormState {
  name: string;
  legalName: string;
  cuisine: string;
  estimatedPrepMinutes: string;
  pan: string;
  gstin: string;
  fssaiLicence: string;
  settlementMode: SettlementMode | '';
  bankAccountRef: string;
  providerLinkedAccountId: string;
  kycCompleted: boolean;
}

/** Server shape → form shape. `null` becomes `''` so inputs stay controlled. */
function toForm(v: VendorDetail): FormState {
  return {
    name: v.name,
    legalName: v.legalName ?? '',
    cuisine: v.cuisine.join(','),
    estimatedPrepMinutes: String(v.estimatedPrepMinutes),
    pan: v.pan ?? '',
    gstin: v.gstin ?? '',
    fssaiLicence: v.fssaiLicence ?? '',
    settlementMode: v.settlementMode ?? '',
    bankAccountRef: v.bankAccountRef ?? '',
    providerLinkedAccountId: v.providerLinkedAccountId ?? '',
    kycCompleted: v.kycCompletedAt !== null,
  };
}

/**
 * Only what changed, and `''` means "clear it".
 *
 * The empty-string-to-null mapping is the whole reason this is a function
 * rather than a spread. The API distinguishes absent (leave alone) from null
 * (clear), and an HTML input has only one empty value — so emptying a field has
 * to be translated into an explicit `null` or it would be indistinguishable
 * from never having touched it, and clearing a wrong PAN would be impossible.
 */
function diff(v: VendorDetail, f: FormState): VendorPatch {
  const patch: VendorPatch = {};

  const text = (
    key: 'legalName' | 'pan' | 'gstin' | 'fssaiLicence' | 'bankAccountRef' | 'providerLinkedAccountId',
  ): void => {
    const now = f[key].trim();
    const was = v[key] ?? '';
    if (now !== was) patch[key] = now === '' ? null : now;
  };

  if (f.name.trim() !== v.name) patch.name = f.name.trim();

  const cuisine = f.cuisine
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 6);
  // A NUL separator so ["a,b"] and ["a", "b"] do not compare equal. Written as
  // an ESCAPE, not as a literal 0x00 byte in the source: a raw NUL makes the
  // whole file binary, which is why `grep -r` was silently skipping it.
  const SEP = '\u0000';
  if (cuisine.join(SEP) !== v.cuisine.join(SEP)) patch.cuisine = cuisine;

  const prep = Number(f.estimatedPrepMinutes);
  if (Number.isInteger(prep) && prep > 0 && prep !== v.estimatedPrepMinutes) {
    patch.estimatedPrepMinutes = prep;
  }

  text('legalName');
  text('pan');
  text('gstin');
  text('fssaiLicence');
  text('bankAccountRef');
  text('providerLinkedAccountId');

  const mode = f.settlementMode === '' ? null : f.settlementMode;
  if (mode !== v.settlementMode) patch.settlementMode = mode;

  if (f.kycCompleted !== (v.kycCompletedAt !== null)) patch.kycCompleted = f.kycCompleted;

  return patch;
}
