import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, type KitchenRole, type VendorDetail } from './api';
import { Button, Card, ErrorNote, Field, Input, ReasonDialog, Select } from './ui';

/**
 * The two blockers the console could name and not clear.
 *
 * `MENU_EMPTY` and `NO_STAFF_ACCOUNT` were both real dead ends: the checklist
 * said what was wrong, and the only fix was a CSV endpoint with no screen and a
 * SQL INSERT. Onboarding stopped there and looked like a broken console.
 *
 * A checklist item that names a problem and offers no way to fix it is worse
 * than not checking at all — it converts a missing feature into an apparent
 * bug, and the person hitting it has no way to tell which it is.
 */

// =============================================================================
// Menu
// =============================================================================

const TEMPLATE_HEADER =
  'category,category_order,item_name,item_order,description,price_inr,tax_rate_pct,dietary,is_available';

const SAMPLE = `${TEMPLATE_HEADER}
Starters,1,Veg Momo,1,Steamed dumplings with a chilli dip,120.00,5,VEG,yes
Starters,1,Chicken Momo,2,Steamed dumplings with minced chicken,150.00,5,NON_VEG,yes
Main Course,2,Momo Platter,1,Eight pieces with two dips,260.00,5,VEG,yes
Beverages,3,Masala Chai,1,,30.00,5,VEG,yes`;

export function MenuImport({ vendor }: { vendor: VendorDetail }) {
  const qc = useQueryClient();
  const [csv, setCsv] = useState('');
  const [open, setOpen] = useState(false);

  /**
   * Dry run first, always.
   *
   * The import REPLACES a menu: anything in the database and absent from the
   * file is discontinued. On a live stall that is a destructive act driven by a
   * spreadsheet nobody has read back, so the plan is shown before it is
   * applied. The endpoint runs the real code path and rolls back, which means
   * the preview cannot disagree with the result.
   */
  const preview = useMutation({
    mutationFn: () => api.importMenu(vendor.id, csv, true),
  });

  const apply = useMutation({
    mutationFn: () => api.importMenu(vendor.id, csv, false),
    onSuccess: () => {
      setCsv('');
      preview.reset();
      setOpen(false);
      // The checklist counts available items, so it has to be re-asked.
      void qc.invalidateQueries({ queryKey: ['readiness', vendor.id] });
      void qc.invalidateQueries({ queryKey: ['vendor', vendor.id] });
      void qc.invalidateQueries({ queryKey: ['vendors', vendor.foodCourtId] });
    },
  });

  const plan = preview.data;

  if (!open) {
    return (
      <Card className="p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h3 className="display text-[17px] text-ink-900">Menu</h3>
            {/*
              The menu no longer blocks activation, so this no longer claims it
              does. It IS the vendor's to load from their own board, and they
              cannot reach that board until the stall is live — blocking here
              deadlocked the common case.

              The consequence is still stated, because a stall live with an
              empty menu shows to customers as open with nothing to order.
            */}
            <p className="text-[12px] text-ink-500 mt-0.5 leading-relaxed">
              {vendor.availableMenuItemCount === 0
                ? 'No items yet. The stall can still go live — but customers will see it open with nothing to order.'
                : `${vendor.availableMenuItemCount} available ${
                    vendor.availableMenuItemCount === 1 ? 'item' : 'items'
                  }.`}
            </p>
          </div>
          <Button variant="secondary" onClick={() => setOpen(true)}>
            {vendor.availableMenuItemCount === 0 ? 'Add a menu' : 'Replace menu'}
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-5">
      <h3 className="display text-[17px] text-ink-900 mb-1">Import a menu</h3>
      <p className="text-[12px] text-ink-500 mb-4 leading-relaxed">
        Paste a spreadsheet as CSV. This <strong>replaces</strong> the whole menu — anything
        already here and missing from the file is discontinued, not deleted. You will see exactly
        what changes before anything is written.
      </p>

      <Field
        label="CSV"
        required
        hint={`Required columns: category, item_name, price_inr, tax_rate_pct. Prices in rupees, tax as a percentage.`}
      >
        <textarea
          value={csv}
          onChange={(e) => {
            setCsv(e.target.value);
            preview.reset();
          }}
          rows={10}
          spellCheck={false}
          placeholder={TEMPLATE_HEADER}
          className="ident w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-[12px]
                     text-ink-900 placeholder:text-ink-400 outline-none resize-y
                     focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
        />
      </Field>

      <div className="flex flex-wrap gap-2 mt-2">
        <button
          onClick={() => {
            setCsv(SAMPLE);
            preview.reset();
          }}
          className="pressable text-[11px] font-semibold text-brand-700 underline"
        >
          Fill with a sample menu
        </button>
        <span className="text-ink-400">·</span>
        <span className="text-[11px] text-ink-500">
          A fuller template with variants and add-ons is in{' '}
          <code className="ident">docs/menu_import_template.csv</code>
        </span>
      </div>

      {preview.isError ? (
        <div className="mt-4">
          <ErrorNote error={preview.error} />
        </div>
      ) : null}
      {apply.isError ? (
        <div className="mt-4">
          <ErrorNote error={apply.error} />
        </div>
      ) : null}

      {plan ? <Plan plan={plan} /> : null}

      <div className="flex gap-2 mt-5">
        {!plan ? (
          <Button onClick={() => preview.mutate()} disabled={csv.trim() === '' || preview.isPending}>
            {preview.isPending ? 'Checking…' : 'Check what would change'}
          </Button>
        ) : (
          <Button onClick={() => apply.mutate()} disabled={apply.isPending}>
            {apply.isPending ? 'Importing…' : 'Apply this import'}
          </Button>
        )}
        <Button
          variant="secondary"
          onClick={() => {
            setOpen(false);
            setCsv('');
            preview.reset();
          }}
        >
          Cancel
        </Button>
      </div>
    </Card>
  );
}

/**
 * What the import would do.
 *
 * Price changes are listed individually and everything else is counted. That
 * asymmetry is on purpose: a count of "12 updated" tells you nothing worth
 * knowing, but "Veg Momo ₹120 → ₹140" is the line somebody has to check
 * against what the vendor actually agreed to.
 */
function Plan({
  plan,
}: {
  plan: {
    categoriesCreated: number;
    itemsCreated: string[];
    itemsUpdated: string[];
    itemsDiscontinued: string[];
    itemsReactivated: string[];
    priceChanges: { item: string; fromPaise: number; toPaise: number }[];
  };
}) {
  const rupees = (p: number): string => `₹${(p / 100).toFixed(2)}`;

  const rows: [string, number, string][] = [
    ['New items', plan.itemsCreated.length, 'live'],
    ['Updated', plan.itemsUpdated.length, 'neutral'],
    ['Brought back', plan.itemsReactivated.length, 'live'],
    ['Discontinued', plan.itemsDiscontinued.length, 'draft'],
  ];

  const nothing = rows.every(([, n]) => n === 0) && plan.priceChanges.length === 0;

  return (
    <div className="mt-4 rounded-lg border border-ink-200 bg-ink-50 p-4">
      <p className="text-[12px] font-bold text-ink-900 mb-3">
        Nothing has been written yet. This is what would change:
      </p>

      {nothing ? (
        <p className="text-[12px] text-ink-500">
          Nothing. The file matches the menu already in the system.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {rows.map(([label, n, tone]) => (
              <div key={label}>
                <div
                  className={`text-[18px] font-bold tnum ${
                    n === 0
                      ? 'text-ink-400'
                      : tone === 'live'
                        ? 'text-live-700'
                        : tone === 'draft'
                          ? 'text-draft-700'
                          : 'text-ink-900'
                  }`}
                >
                  {n}
                </div>
                <div className="text-[11px] text-ink-500">{label}</div>
              </div>
            ))}
          </div>

          {plan.itemsDiscontinued.length > 0 ? (
            <p className="mt-3 text-[11px] text-draft-700 leading-relaxed">
              Discontinued because they are absent from the file:{' '}
              {plan.itemsDiscontinued.join(',')}. They are marked inactive, not deleted — past
              orders still reference them.
            </p>
          ) : null}

          {plan.priceChanges.length > 0 ? (
            <div className="mt-4 pt-3 border-t border-ink-200">
              <p className="text-[11px] font-bold text-ink-700 mb-1.5">
                Price changes — check these against what the vendor agreed
              </p>
              <ul className="space-y-1">
                {plan.priceChanges.map((c) => (
                  <li key={c.item} className="text-[12px] text-ink-700 flex gap-2">
                    <span className="min-w-0 flex-1 truncate">{c.item}</span>
                    <span className="ident shrink-0 tnum">
                      {rupees(c.fromPaise)} → <strong>{rupees(c.toPaise)}</strong>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

// =============================================================================
// Kitchen logins
// =============================================================================

const ROLE_OPTIONS = [
  ['VENDOR_OPERATOR', 'Cook — the board only'],
  ['VENDOR_OWNER', 'Owner — the board, the menu and the profile'],
] as const;

/**
 * The carousel slot, granted or withheld by the platform.
 *
 * ============================================================================
 * THIS IS THE HALF THE STALL CANNOT DO
 * ============================================================================
 *
 * The offer carousel is the first thing on the customer home screen, above any
 * stall list, on every visit. A stall that could put itself there unilaterally
 * would take that space from every other stall in the court — and the first one
 * to notice would keep it. So the platform decides WHO may appear, and the
 * stall decides WHAT appears. Neither can do the other's half, and the server
 * enforces both ends rather than trusting either screen.
 *
 * Withdrawing the grant does not delete the artwork. The stall simply stops
 * appearing, so re-granting next month does not mean chasing them for the image
 * again.
 */
function OfferSlot({ vendor }: { vendor: VendorDetail }) {
  const qc = useQueryClient();

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.updateVendor(vendor.id, { offerUploadsEnabled: enabled }),
    onSuccess: (updated) => qc.setQueryData(['vendor', vendor.id], updated),
  });

  const on = vendor.offerUploadsEnabled;

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="display text-[17px] text-ink-900">Offer carousel</h3>
          <p className="text-[12px] text-ink-500 mt-0.5 leading-relaxed">
            {on
              ? 'This stall may put a banner on the customer home screen. It uploads the artwork from its own kitchen board.'
              : 'This stall cannot appear in the carousel. Turning this on lets it upload one banner from its kitchen board.'}
          </p>
        </div>

        <Button
          variant={on ? 'danger' : 'primary'}
          disabled={toggle.isPending}
          onClick={() => toggle.mutate(!on)}
        >
          {toggle.isPending ? 'Saving…' : on ? 'Withdraw slot' : 'Grant a slot'}
        </Button>
      </div>

      {toggle.isError ? (
        <div className="mt-3">
          <ErrorNote error={toggle.error} />
        </div>
      ) : null}

      {on ? (
        <div className="mt-3 rounded-lg border border-ink-200 bg-ink-50 p-3">
          {vendor.offerImageUrl ? (
            <div className="flex items-start gap-3">
              <img
                src={vendor.offerImageUrl}
                alt=""
                className="h-16 w-32 shrink-0 rounded-lg object-cover bg-ink-100"
              />
              <div className="min-w-0">
                <p className="text-[12px] font-semibold text-ink-900">{vendor.offerHeadline}</p>
                <p className="text-[11px] text-ink-500 mt-1 leading-relaxed">
                  Live on the customer home screen while the stall is open. It applies{' '}
                  <strong>no discount</strong> — the stall is making a claim about its own menu
                  pricing.
                </p>
              </div>
            </div>
          ) : (
            <p className="text-[11px] text-ink-500 leading-relaxed">
              Slot granted, nothing uploaded yet. The stall adds its banner from the kitchen board
              under Stall.
            </p>
          )}
        </div>
      ) : null}
    </Card>
  );
}

const DAYS = [
  ['mon', 'Monday'],
  ['tue', 'Tuesday'],
  ['wed', 'Wednesday'],
  ['thu', 'Thursday'],
  ['fri', 'Friday'],
  ['sat', 'Saturday'],
  ['sun', 'Sunday'],
] as const;

type Windows = Record<string, { open: string; close: string }[]>;

/**
 * Opening hours.
 *
 * ============================================================================
 * WHY THIS IS NOT A PAIR OF TIME FIELDS
 * ============================================================================
 *
 * A great many food-court stalls run lunch and dinner with a dead afternoon
 * between — 11:00–15:30, then 18:30–23:00. One open and one close per day
 * forces those stalls to either claim they are open at 4pm, which loses an
 * order the kitchen cannot cook, or to shut at 15:30 and lose the evening.
 *
 * So a day is a LIST. Most stalls will use one row; the ones that need two are
 * not an edge case in this market.
 *
 * ============================================================================
 * EMPTY MEANS ALWAYS OPEN, AND THE PANEL SAYS SO
 * ============================================================================
 *
 * Every stall in the database has `{}` — the column has existed since the first
 * migration and nothing ever wrote it. If empty meant closed, saving this
 * feature would have shut the whole platform. It means "no schedule", and the
 * banner states that rather than leaving somebody to infer it from an empty
 * form, because "no hours set" and "closed all week" look identical here and
 * are opposites.
 */
export { OfferSlot };

export function OpeningHours({ vendor }: { vendor: VendorDetail }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Windows>(() => ({ ...vendor.operatingHours }));

  const save = useMutation({
    mutationFn: () => api.updateVendor(vendor.id, { operatingHours: draft }),
    onSuccess: (updated) => {
      qc.setQueryData(['vendor', vendor.id], updated);
    },
  });

  const configured = DAYS.some(([d]) => (draft[d]?.length ?? 0) > 0);

  const setDay = (day: string, windows: { open: string; close: string }[]): void => {
    setDraft((d) => ({ ...d, [day]: windows }));
  };

  /** Monday's rows onto every other day. The commonest schedule by far. */
  const copyMondayToAll = (): void => {
    const mon = draft['mon'] ?? [];
    setDraft(Object.fromEntries(DAYS.map(([d]) => [d, mon.map((w) => ({ ...w }))])));
  };

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-4 mb-3">
        <div className="min-w-0">
          <h3 className="display text-[17px] text-ink-900">Opening hours</h3>
          <p className="text-[12px] text-ink-500 mt-0.5">
            When the stall appears open to customers. Separate from pausing.
          </p>
        </div>
        <Button variant="secondary" onClick={copyMondayToAll}>
          Copy Monday to all
        </Button>
      </div>

      {!configured ? (
        <p className="mb-3 rounded-lg border border-dashed border-draft-500 bg-draft-50 px-3 py-2.5 text-[12px] text-draft-700 leading-relaxed">
          No hours set, so this stall is treated as <strong>always open</strong>. Its availability
          comes from its status, its pause and whether the kitchen board is awake. Set hours only if
          the stall genuinely keeps them — an empty schedule is not the same as being closed.
        </p>
      ) : null}

      {/*
        `divide-y` rather than `space-y`, and a FLEX ROW per day.

        The first version used `space-y-2` on the content column, which only
        puts margin between BLOCK-level siblings — "Closed" was an inline span
        and "Add hours" an inline button, so they sat on one line touching, as
        `ClosedAdd hours`. Flex with a gap spaces whatever is actually there,
        inline or not, and wraps instead of overflowing the card on a narrow
        column.
      */}
      <div className="divide-y divide-ink-100 border-y border-ink-100">
        {DAYS.map(([day, label]) => {
          const windows = draft[day] ?? [];
          return (
            <div key={day} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2">
              <span className="w-[5.5rem] shrink-0 text-[13px] font-semibold text-ink-700">
                {label}
              </span>

              {windows.length === 0 ? (
                <>
                  <span className="text-[12px] text-ink-400">Closed</span>
                  <button
                    onClick={() => setDay(day, [{ open: '11:00', close: '22:00' }])}
                    className="pressable text-[12px] font-semibold text-brand-700 underline"
                  >
                    Add hours
                  </button>
                </>
              ) : null}

              {/* Each window is its own wrapping row so two windows never end
                  up side by side and unreadable on a narrow console column. */}
              <div className="min-w-0 flex-1 flex flex-col gap-2">
                {windows.map((w, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <input
                      type="time"
                      value={w.open}
                      onChange={(e) =>
                        setDay(
                          day,
                          windows.map((x, j) => (j === i ? { ...x, open: e.target.value } : x)),
                        )
                      }
                      className="rounded-lg border border-ink-200 bg-surface px-2 py-1 text-[13px] text-ink-900 outline-none focus:border-brand-500"
                    />
                    <span className="text-[12px] text-ink-400">to</span>
                    <input
                      type="time"
                      value={w.close}
                      onChange={(e) =>
                        setDay(
                          day,
                          windows.map((x, j) => (j === i ? { ...x, close: e.target.value } : x)),
                        )
                      }
                      className="rounded-lg border border-ink-200 bg-surface px-2 py-1 text-[13px] text-ink-900 outline-none focus:border-brand-500"
                    />
                    {/* Closing before opening is not an error — the window runs
                        past midnight, which late counters really do. Said here
                        so nobody "fixes" it. */}
                    {w.close < w.open ? (
                      <span className="text-[11px] text-ink-500">past midnight</span>
                    ) : null}
                    <button
                      onClick={() => setDay(day, windows.filter((_, j) => j !== i))}
                      aria-label={`Remove this ${label} window`}
                      className="pressable ml-auto text-[12px] font-semibold text-held-700 underline"
                    >
                      Remove
                    </button>
                  </div>
                ))}

                {windows.length > 0 && windows.length < 4 ? (
                  <button
                    onClick={() => setDay(day, [...windows, { open: '18:30', close: '23:00' }])}
                    className="pressable self-start text-[12px] font-semibold text-ink-500 underline"
                  >
                    Add another window
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {save.isError ? (
        <div className="mt-3">
          <ErrorNote error={save.error} />
        </div>
      ) : null}

      <div className="flex items-center gap-3 mt-4 pt-3 border-t border-ink-100">
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save hours'}
        </Button>
        {save.isSuccess ? <span className="text-[12px] text-live-700">Saved</span> : null}
      </div>
    </Card>
  );
}

/**
 * The credentials, shown once.
 *
 * ONE COMPONENT FOR BOTH ISSUING AND RESETTING, deliberately. It is the only
 * place in the product where a secret is displayed, and the sentence that
 * matters — "this is not shown again" — has to be identical in both flows. Two
 * copies is how one of them ends up saying something slightly softer.
 *
 * The password is in the mutation's result and nowhere else: not in
 * localStorage, not re-fetchable, not in the server's log. `platform_user`
 * holds a scrypt hash.
 *
 * Saying that plainly is the whole design of this panel. A quiet "copied!"
 * toast would let somebody close it assuming they can find it again.
 */
function Credentials({
  title,
  account,
  password,
  onDone,
}: {
  title: string;
  account: { email: string; displayName: string };
  password: string;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="mb-4 rounded-lg border border-live-500 bg-live-50 p-4">
      <p className="text-[13px] font-bold text-live-700">{title}</p>
      <p className="text-[11px] text-live-700/80 mt-1 leading-relaxed">
        Give these to the stall now. <strong>The password is not shown again</strong> and cannot be
        recovered. If it is lost, use Reset on their row — that issues a new one without disturbing
        their access.
      </p>

      <dl className="mt-3 rounded-lg bg-surface border border-ink-200 p-3 space-y-2">
        <div className="flex gap-3">
          <dt className="text-[11px] text-ink-500 w-20 shrink-0">Sign in at</dt>
          <dd className="ident text-[12px] text-ink-900">http://localhost:5174</dd>
        </div>
        <div className="flex gap-3">
          <dt className="text-[11px] text-ink-500 w-20 shrink-0">Email</dt>
          <dd className="ident text-[12px] text-ink-900 break-all">{account.email}</dd>
        </div>
        <div className="flex gap-3">
          <dt className="text-[11px] text-ink-500 w-20 shrink-0">Password</dt>
          <dd className="ident text-[13px] font-bold text-ink-900 break-all">{password}</dd>
        </div>
      </dl>

      <div className="flex gap-2 mt-3">
        <Button
          variant="secondary"
          onClick={() => {
            void navigator.clipboard?.writeText(
              `Board: http://localhost:5174\nEmail: ${account.email}\nPassword: ${password}`,
            );
            setCopied(true);
          }}
        >
          {copied ? 'Copied' : 'Copy all three'}
        </Button>
        {/*
          Dismissing is the destructive action here, so it is the quiet one and
          it changes wording once a copy has been taken. Before copying, "Done"
          invites closing a panel holding the only copy of a secret.
        */}
        <Button variant="secondary" onClick={onDone}>
          {copied ? 'Done' : 'Close without copying'}
        </Button>
      </div>
    </div>
  );
}

export function StaffAccounts({ vendor }: { vendor: VendorDetail }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);

  /**
   * Which login is being revoked, and whose.
   *
   * The name is carried so the dialog can say it. `window.prompt` could not —
   * it appeared at the top of the window with no idea which row summoned it,
   * on a list where four cooks may share a surname.
   */
  const [revoking, setRevoking] = useState<{ userId: string; name: string } | null>(null);

  /**
   * The reset. Its result is the only copy of the new password.
   *
   * `reset.reset()` — TanStack's, not ours — is what dismisses the panel, so
   * the password leaves memory when the operator says they are done with it
   * rather than lingering in component state until the page changes.
   */
  const reset = useMutation({
    mutationFn: (userId: string) => api.resetStaffPassword(vendor.id, userId),
  });

  const q = useQuery({
    queryKey: ['staff', vendor.id],
    queryFn: () => api.staff(vendor.id),
  });

  const revoke = useMutation({
    mutationFn: (v: { userId: string; reason: string }) =>
      api.revokeStaff(vendor.id, v.userId, v.reason),
    onSuccess: (r) => {
      qc.setQueryData(['staff', vendor.id], r);
      void qc.invalidateQueries({ queryKey: ['readiness', vendor.id] });
      void qc.invalidateQueries({ queryKey: ['vendor', vendor.id] });
    },
  });

  const list = q.data?.staff ?? [];
  const live = list.filter((s) => s.active);

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-4 mb-3">
        <div className="min-w-0">
          <h3 className="display text-[17px] text-ink-900">Kitchen logins</h3>
          <p className="text-[12px] text-ink-500 mt-0.5">
            {live.length === 0
              ? 'None yet. Orders would arrive at a kitchen that cannot see them.'
              : `${live.length} active. They sign in to the board at localhost:5174.`}
          </p>
        </div>
        {!adding ? (
          <Button variant="secondary" onClick={() => setAdding(true)}>
            Add a login
          </Button>
        ) : null}
      </div>

      {adding ? (
        <NewStaff
          vendor={vendor}
          onCancel={() => setAdding(false)}
          onCreated={() => {
            void qc.invalidateQueries({ queryKey: ['staff', vendor.id] });
            void qc.invalidateQueries({ queryKey: ['readiness', vendor.id] });
            void qc.invalidateQueries({ queryKey: ['vendor', vendor.id] });
          }}
        />
      ) : null}

      {revoke.isError ? (
        <div className="mb-3">
          <ErrorNote error={revoke.error} />
        </div>
      ) : null}

      {reset.isSuccess ? (
        <Credentials
          title={`New password for ${reset.data.account.displayName}`}
          account={reset.data.account}
          password={reset.data.password}
          onDone={() => reset.reset()}
        />
      ) : null}

      {reset.isError ? (
        <div className="mb-3">
          <ErrorNote error={reset.error} />
        </div>
      ) : null}

      {list.length > 0 ? (
        <ul className="divide-y divide-ink-100 -mx-1">
          {list.map((s) => (
            <li key={s.userId} className="px-1 py-2.5 flex items-center gap-3">
              <span className="min-w-0 flex-1">
                <span
                  className={`block text-[13px] font-semibold truncate ${
                    s.active ? 'text-ink-900' : 'text-ink-400 line-through'
                  }`}
                >
                  {s.displayName}
                </span>
                <span className="block text-[11px] text-ink-500 ident truncate">{s.email}</span>
              </span>

              <span className="shrink-0 text-[11px] text-ink-500">
                {s.role === 'VENDOR_OWNER' ? 'Owner' : 'Cook'}
              </span>

              {s.active ? (
                <span className="shrink-0 flex items-center gap-3">
                  {/*
                    Reset sits BEFORE Revoke and is the plainer of the two.
                    A forgotten password is the commonest reason anyone touches
                    this row, and until this existed the only control here was
                    the destructive one — which is how "they forgot the
                    password" turns into a revoked account nobody can recreate,
                    because the email guard then refuses the replacement.
                  */}
                  <button
                    onClick={() => reset.mutate(s.userId)}
                    disabled={reset.isPending || revoke.isPending}
                    className="pressable text-[11px] font-semibold text-ink-700 underline disabled:opacity-50"
                  >
                    {reset.isPending && reset.variables === s.userId ? 'Resetting…' : 'Reset password'}
                  </button>
                  <button
                    onClick={() => setRevoking({ userId: s.userId, name: s.displayName })}
                    disabled={revoke.isPending || reset.isPending}
                    className="pressable text-[11px] font-semibold text-held-700 underline disabled:opacity-50"
                  >
                    Revoke
                  </button>
                </span>
              ) : (
                // Kept in the list rather than hidden. "Who used to have access"
                // is the question asked after an incident.
                <span className="shrink-0 text-[11px] text-ink-400">Revoked</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {revoking ? (
        <ReasonDialog
          title={`Revoke ${revoking.name}'s login?`}
          prompt="They are signed out of the kitchen board and cannot sign back in."
          {...(live.length === 1
            ? {
                consequence:
                  'This is the stall’s only active login. Revoking it leaves orders arriving at a kitchen that cannot see them, and the stall will fail its readiness check.',
              }
            : {})}
          confirmLabel="Revoke the login"
          tone="danger"
          pending={revoke.isPending}
          onCancel={() => setRevoking(null)}
          onConfirm={(reason) => {
            revoke.mutate({ userId: revoking.userId, reason });
            setRevoking(null);
          }}
        />
      ) : null}
    </Card>
  );
}

function NewStaff({
  vendor,
  onCancel,
  onCreated,
}: {
  vendor: VendorDetail;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<KitchenRole | ''>('VENDOR_OPERATOR');

  const create = useMutation({
    mutationFn: () =>
      api.createStaff(vendor.id, {
        email: email.trim(),
        displayName: displayName.trim(),
        role: (role || 'VENDOR_OPERATOR') as KitchenRole,
      }),
    onSuccess: onCreated,
  });

  if (create.isSuccess) {
    return (
      <Credentials
        title={`Login created for ${create.data.account.displayName}`}
        account={create.data.account}
        password={create.data.password}
        onDone={onCancel}
      />
    );
  }

  const canSubmit =
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()) &&
    displayName.trim().length >= 2 &&
    !create.isPending;

  return (
    <div className="mb-4 rounded-lg border border-ink-200 p-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) create.mutate();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" required hint="Shown on the kitchen board.">
            <Input value={displayName} onChange={setDisplayName} placeholder="Ramesh" />
          </Field>
          <Field label="Email" required hint="What they sign in with.">
            <Input value={email} onChange={setEmail} type="email" />
          </Field>
        </div>

        <div className="mt-3">
          <Field
            label="Access"
            required
            hint="A cook only needs the board. Give owner access to whoever also changes the menu."
          >
            <Select value={role} onChange={setRole} options={ROLE_OPTIONS} placeholder="Cook" />
          </Field>
        </div>

        <p className="text-[11px] text-ink-500 mt-3 leading-relaxed">
          A password is generated for you — three words and three digits, so it survives being read
          aloud across a kitchen and typed with wet hands. It is shown once.
        </p>

        {create.isError ? (
          <div className="mt-3">
            <ErrorNote error={create.error} />
          </div>
        ) : null}

        <div className="flex gap-2 mt-4">
          <Button type="submit" disabled={!canSubmit}>
            {create.isPending ? 'Creating…' : 'Create login'}
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
