import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, type Dietary, type MenuItem } from './api';
import { ImagePicker, Modal } from './ui';

/**
 * Add or edit one dish.
 *
 * OWNER-ONLY, AND THE SERVER IS WHAT ENFORCES IT.
 *
 * `Menu` hides these controls when `canEditMenu` is false, which is a rendering
 * decision. The actual rule is `menu.write` in the permission matrix, checked
 * again on every request — `VENDOR_OWNER` has it, `VENDOR_OPERATOR` does not.
 * A cook who reached this form some other way would get a 403 with a message
 * saying where their controls are.
 *
 * WHY PRICE IS IN RUPEES HERE AND PAISE EVERYWHERE ELSE
 *
 * An owner types 150, not 15000. The conversion happens once, on the server,
 * on a value the schema has already bounded — `Math.round(rupees * 100)`.
 * Money never becomes a float in storage or arithmetic (PRD §14.5); this is
 * only the shape of the input.
 *
 * ============================================================================
 * THIS FORM IS NOT SIZED LIKE THE BOARD, AND THAT IS THE POINT
 * ============================================================================
 *
 * It used to be: 64px inputs, 80px buttons, `text-2xl` labels, 2px borders on
 * everything. Those numbers are correct for a TICKET — read across a kitchen at
 * arm's length, tapped once by somebody holding a pan. They are wrong for a
 * form, and applying them here produced the two complaints the rebuild is
 * answering:
 *
 * TOO BIG six fields at 64px each is 700px of column before the buttons.
 * On a landscape tablet the Save button was below the fold of its
 * own dialog.
 * UGLY 2px borders on nine elements at once is a form made of boxes.
 * Weight that loud has to mean something, and here it meant
 * nothing — every field had it.
 *
 * What replaced them: 44px controls (still a comfortable touch target, and the
 * platform minimum), hairline borders with weight kept for FOCUS alone, and the
 * short fields paired into a row so the whole thing is one screen. Adding a
 * dish happens before service or between rushes, with attention — the opposite
 * of the board's job.
 */

const DIETARY: readonly (readonly [Dietary, string])[] = [
  ['VEG', 'Veg'],
  ['NON_VEG', 'Non-veg'],
  ['EGG', 'Egg'],
  ['JAIN', 'Jain'],
];

/** One field style, so a change lands everywhere rather than in eight places. */
const FIELD = `w-full h-11 rounded-xl border border-shell-700 bg-shell-900 px-3.5 text-[15px]
               text-shell-100 placeholder:text-shell-400 outline-none
               focus:border-brand-400 focus:ring-2 focus:ring-brand-400/25`;

export function ItemEditor({
  item,
  onClose,
}: {
  /** `null` means "new dish". */
  item: MenuItem | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const editing = item !== null;

  const cats = useQuery({ queryKey: ['menu-categories'], queryFn: api.categories });

  const [name, setName] = useState(item?.name ?? '');
  const [price, setPrice] = useState(item ? String(item.pricePaise / 100) : '');
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [dietary, setDietary] = useState<Dietary | ''>('');
  const [imageUrl, setImageUrl] = useState(item?.imageUrl ?? '');

  /**
   * The destructive action is behind a step, not behind `window.confirm`.
   *
   * The native dialog was the last piece of OS chrome in this app — unstyleable,
   * and it appears at the top of the screen unrelated to the button that
   * summoned it. This replaces it with a panel that opens in place, under the
   * button, saying the one thing people get wrong: this is not "sold out".
   */
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  /**
   * ========================================================================
   * THE AI DESCRIPTION BUTTON
   * ========================================================================
   *
   * Three pieces of state, and they are three because the flow has three
   * distinct moments a person can be in:
   *
   *   `confirmingGenerate`  they tapped, and are being told it costs something
   *   `generate.isPending`  it is running
   *   `generatedBy`         it finished, and the text below was not theirs
   *
   * Collapsing the first into "just do it" is the thing to avoid. This spends
   * a limited, non-refundable allowance on the stall's account, and the product
   * requires the person to be told that before it happens rather than after.
   */
  const [confirmingGenerate, setConfirmingGenerate] = useState(false);
  const [generatedBy, setGeneratedBy] = useState<string | null>(null);

  /**
   * Credits, fetched once when the editor opens.
   *
   * `staleTime: 0` and no interval: the number only changes when THIS person
   * generates something, and the mutation writes the new balance straight into
   * the cache. Polling would be asking a question we already know the answer
   * to, on a tablet in a kitchen, every few seconds, for ever.
   */
  const credits = useQuery({ queryKey: ['describe-credits'], queryFn: api.describeCredits });

  const generate = useMutation({
    mutationFn: () =>
      api.describe({
        dishName: name.trim(),
        categoryName: category.trim() || null,
        ...(dietary ? { dietaryFlags: [dietary] } : {}),
        menuItemId: item?.id ?? null,
      }),
    onSuccess: (r) => {
      setDescription(r.description);
      setGeneratedBy(r.provider);
      setConfirmingGenerate(false);
      /*
       * Write the new balance into the cache rather than refetching.
       *
       * The response already carries the post-spend balance precisely so the
       * button can go from "1 left" to "none left" on the same tap that used
       * it. A refetch would be a second round trip to learn a number we were
       * just handed.
       */
      qc.setQueryData(['describe-credits'], {
        granted: r.granted,
        used: r.used,
        remaining: r.remaining,
        configured: true,
      });
    },
  });

  /** Enough to generate: a dish name to work from, and a credit to spend. */
  const nameReady = name.trim().length >= 2;
  const remaining = credits.data?.remaining ?? 0;
  const canGenerate = Boolean(credits.data?.configured) && remaining > 0 && nameReady;

  const done = (): void => {
    void qc.invalidateQueries({ queryKey: ['menu-items'] });
    void qc.invalidateQueries({ queryKey: ['menu-categories'] });
    onClose();
  };

  const save = useMutation({
    mutationFn: () => {
      const priceRupees = Number(price);
      // `''` becomes null so a photo can be REMOVED, not just replaced. An
      // empty string would fail the server's `.url()` check and read as a
      // validation error rather than as "take the picture off".
      const image = imageUrl.trim() === '' ? null : imageUrl.trim();

      if (editing) {
        return api.updateItem(item.id, {
          name: name.trim(),
          priceRupees,
          imageUrl: image,
          ...(category.trim() ? { category: category.trim() } : {}),
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(dietary ? { dietary } : {}),
        });
      }
      return api.createItem({
        name: name.trim(),
        category: category.trim(),
        priceRupees,
        ...(image ? { imageUrl: image } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(dietary ? { dietary } : {}),
      });
    },
    onSuccess: done,
  });

  const discontinue = useMutation({
    mutationFn: () => api.discontinueItem(item!.id),
    onSuccess: done,
  });

  const priceNumber = Number(price);
  const priceValid = price.trim() !== '' && Number.isFinite(priceNumber) && priceNumber >= 0;
  const canSave =
    name.trim().length >= 2 &&
    priceValid &&
    (editing || category.trim().length > 0) &&
    !save.isPending;

  const error = save.error ?? discontinue.error;

  return (
    <Modal
      title={editing ? item.name : 'Add a dish'}
      subtitle={
        editing
          ? 'Changes show on the customer menu straight away.'
          : 'It appears on the customer menu as soon as you save.'
      }
      onClose={onClose}
      footer={
        <div className="flex gap-2.5">
          <button
            onClick={() => save.mutate()}
            disabled={!canSave}
            className="pressable glass-hover flex-1 h-12 rounded-xl bg-go-500 text-shell-900 text-[15px] font-bold
                       disabled:opacity-40"
          >
            {save.isPending ? 'Saving…' : editing ? 'Save changes' : 'Add to the menu'}
          </button>
          <button
            onClick={onClose}
            className="pressable glass-hover h-12 rounded-xl border border-shell-700 px-6 text-[15px] font-semibold
                       text-shell-300 hover:text-shell-100"
          >
            Cancel
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Chicken Momo"
            className={FIELD}
          />
        </Field>

        {/*
          Price and section share a row.
          Both are short, and pairing them is what turns a seven-row column into
          a form that fits without scrolling. It collapses back to one column
          below `sm`, which is a phone — nobody adds a dish on a phone, but the
          layout should not break if they try.
        */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Price">
            <div className="relative">
              <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[15px] text-shell-400 pointer-events-none">
                ₹
              </span>
              <input
                value={price}
                onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ''))}
                inputMode="decimal"
                placeholder="150"
                className={`${FIELD} pl-8 font-bold tnum`}
              />
            </div>
          </Field>

          <Field label={editing ? 'Move to section' : 'Section'}>
            <input
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              list="kds-categories"
              placeholder={editing ? 'Leave blank to keep' : 'Starters'}
              className={FIELD}
            />
            {/* A datalist rather than a select: existing sections are offered,
                and typing a new one creates it. The server matches on name
                case-insensitively, so "starters" lands in "Starters". */}
            <datalist id="kds-categories">
              {(cats.data?.categories ?? []).map((c) => (
                <option key={c.id} value={c.name} />
              ))}
            </datalist>
          </Field>
        </div>

        {/* Said out loud, because this is the field where a slip is expensive
            and a confirmation dialog would be ignored. Outside the grid so it
            gets the full width and does not shove the section field down. */}
        {priceValid && priceNumber > 0 ? (
          <p className="text-[13px] text-shell-400 -mt-1">
            Customers pay{' '}
            <span className="tnum font-semibold text-shell-100">₹{priceNumber.toFixed(2)}</span>
            {editing && item.pricePaise !== Math.round(priceNumber * 100) ? (
              <span className="text-warn-500"> — was ₹{(item.pricePaise / 100).toFixed(2)}</span>
            ) : null}
          </p>
        ) : null}

        <Field label="Description" optional>
          <input
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              // Once they edit it, it is theirs. The "written for you" note
              // would otherwise sit above a sentence they rewrote by hand.
              setGeneratedBy(null);
            }}
            placeholder="Steamed dumplings with a chilli dip"
            className={FIELD}
          />

          {/*
            ================================================================
            WRITE IT FOR ME
            ================================================================

            Under the field rather than beside it. A button on the right of an
            input competes with the text for the same horizontal space on a
            tablet held in portrait, and this one has a subtitle — how many
            generations are left — that has nowhere to go in that layout.
          */}
          {credits.data?.configured ? (
            <div className="mt-2">
              {!confirmingGenerate ? (
                <div className="flex items-center gap-3 flex-wrap">
                  <button
                    type="button"
                    onClick={() => setConfirmingGenerate(true)}
                    disabled={!canGenerate || generate.isPending}
                    className="pressable glass-hover inline-flex items-center gap-2 h-9 rounded-xl
                               border border-shell-700 bg-shell-800 px-3 text-[13px] font-semibold
                               text-shell-100 disabled:opacity-45"
                  >
                    <svg viewBox="0 0 24 24" className="size-4" fill="none" aria-hidden>
                      <path
                        d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinejoin="round"
                      />
                    </svg>
                    Write it for me
                  </button>

                  {/*
                    The count is a plain fact, not a warning, until it runs out.
                    Colouring "2 left" amber would make a normal state look like
                    a problem every single time the editor opens.
                  */}
                  {remaining > 0 ? (
                    <span className="text-[12px] text-shell-400">
                      {remaining} of {credits.data.granted} left
                    </span>
                  ) : (
                    <span className="text-[12px] text-warn-500">
                      No automatic descriptions left — contact the platform team for more credits.
                    </span>
                  )}

                  {!nameReady && remaining > 0 ? (
                    <span className="text-[12px] text-shell-400">Enter the dish name first.</span>
                  ) : null}
                </div>
              ) : (
                /*
                  THE CHARGE IS NAMED BEFORE IT HAPPENS, IN PLACE.

                  Not a `window.confirm`, for the same reason the remove step is
                  not: the native dialog is unstyleable and opens at the top of
                  the screen, unrelated to the button that summoned it. This
                  opens directly under the button, which is where the person is
                  already looking.

                  It says the number remaining rather than only "this costs
                  credits", because "you have 1 left" and "you have 40 left" are
                  different decisions and the generic sentence serves neither.
                */
                <div className="rounded-xl border border-warn-500/40 bg-warn-500/10 p-3">
                  <p className="text-[13px] font-semibold text-shell-100">
                    Automatic descriptions are charged
                  </p>
                  <p className="mt-1 text-[12px] text-shell-300 leading-relaxed">
                    Writing this with AI uses one of your stall's credits.{' '}
                    {remaining === 1
                      ? 'This is your last one — after this you will need to contact the platform team for more.'
                      : `You have ${remaining} left of ${credits.data.granted}.`}
                  </p>
                  <div className="mt-2.5 flex gap-2">
                    <button
                      type="button"
                      onClick={() => generate.mutate()}
                      disabled={generate.isPending}
                      className="pressable glass-hover h-9 rounded-xl bg-brand-fill px-3.5 text-[13px]
                                 font-bold text-on-brand disabled:opacity-45"
                    >
                      {generate.isPending ? 'Writing…' : 'Use one credit'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingGenerate(false)}
                      disabled={generate.isPending}
                      className="pressable glass-hover h-9 rounded-xl border border-shell-700 px-3.5
                                 text-[13px] font-semibold text-shell-200 disabled:opacity-45"
                    >
                      Not now
                    </button>
                  </div>
                </div>
              )}

              {/*
                A FAILED GENERATION SAYS THE CREDIT IS SAFE.

                Without that sentence the reasonable assumption is that a failure
                still cost something — which would stop somebody retrying, and
                the retry is the thing most likely to work.
              */}
              {generate.isError ? (
                <p className="mt-2 text-[12px] text-alert-500 leading-relaxed">
                  {generate.error instanceof Error
                    ? generate.error.message
                    : 'Could not write a description just now.'}
                </p>
              ) : null}

              {generatedBy && !generate.isError ? (
                <p className="mt-2 text-[12px] text-shell-400 leading-relaxed">
                  Written for you — read it before saving, and edit anything that is not right.
                </p>
              ) : null}
            </div>
          ) : null}
        </Field>

        {/*
          A REAL UPLOAD, replacing the URL box.

          The field was a URL, which is the same as no photograph for almost
          everybody: a stall owner has the picture in their camera roll or in
          WhatsApp, not on a host with a link they can type. `ImagePicker`
          takes a tap, a drop or a paste, sends the file straight to the storage
          provider, and hands back the URL this field always wanted.

          The link box is still there, one click down inside the picker —
          somebody who already hosts their images should not lose that path
          because a better one arrived.
        */}
        <ImagePicker
          value={imageUrl.trim() === '' ? null : imageUrl.trim()}
          kind="dish"
          label="Photo — optional"
          hint="Without one the dish shows a coloured tile with its initial, which is deliberate — it looks chosen rather than missing."
          onChange={(url) => setImageUrl(url ?? '')}
        />

        <Field label="Dietary mark" optional>
          <div className="flex gap-2 flex-wrap">
            {DIETARY.map(([v, label]) => (
              <button
                key={v}
                onClick={() => setDietary(dietary === v ? '' : v)}
                aria-pressed={dietary === v}
                className={`pressable glass-hover h-11 min-w-[5rem] rounded-xl px-4 text-[14px] font-bold ${
                  dietary === v
                    ? 'bg-shell-100 text-shell-900'
                    : 'bg-shell-900 border border-shell-700 text-shell-300 hover:text-shell-100'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {/*
            Leaving it blank is a real choice, not laziness.
            No dietary information is NOT the same as vegetarian — a green mark
            on an unlabelled dish is a claim the platform cannot support, and
            for a Jain or vegetarian diner it is the one mistake that matters
            most. The customer app renders nothing rather than guess.
          */}
          <p className="text-[12px] text-shell-400 mt-2 leading-relaxed">
            Leave blank if unsure. No mark is shown rather than the wrong one.
          </p>
        </Field>

        {error ? (
          <p
            role="alert"
            className="rounded-xl border border-late-500 bg-late-500/10 px-4 py-3 text-[14px]
                       font-semibold text-shell-100"
          >
            {error instanceof Error ? error.message : 'That did not save.'}
          </p>
        ) : null}

        {editing ? (
          <div className="pt-4 border-t border-shell-700">
            {confirmingRemove ? (
              <div className="rounded-xl border border-late-500 bg-late-500/10 p-4">
                <p className="text-[14px] font-bold text-shell-100">
                  Take “{item.name}” off the menu for good?
                </p>
                <p className="text-[13px] text-shell-300 mt-1 leading-relaxed">
                  To hide it just for today, close this and use <strong>Sold out</strong> instead.
                  Removing is permanent but is not a delete — past orders keep their record of it,
                  and the platform can put it back.
                </p>
                <div className="flex gap-2.5 mt-3.5">
                  <button
                    onClick={() => discontinue.mutate()}
                    disabled={discontinue.isPending}
                    className="pressable glass-hover h-11 rounded-xl bg-late-500 px-5 text-[14px] font-bold
                               text-shell-100 disabled:opacity-50"
                  >
                    {discontinue.isPending ? 'Removing…' : 'Yes, take it off'}
                  </button>
                  <button
                    onClick={() => setConfirmingRemove(false)}
                    className="pressable glass-hover h-11 rounded-xl border border-shell-700 px-5 text-[14px]
                               font-semibold text-shell-300 hover:text-shell-100"
                  >
                    Keep it
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setConfirmingRemove(true)}
                className="pressable glass-hover h-11 rounded-xl border border-shell-700 px-5 text-[14px] font-semibold
                           text-shell-400"
              >
                Take off the menu
              </button>
            )}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

/**
 * A labelled field.
 *
 * `optional` is a prop rather than something callers write into the label, so
 * every optional field is marked the same way and none is marked twice — the
 * old version had "(optional)" typed by hand into three separate strings.
 */
function Field({
  label,
  optional,
  children,
}: {
  label: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-[13px] font-semibold text-shell-300 mb-1.5">
        {label}
        {optional ? <span className="text-shell-400 font-normal ml-1.5">optional</span> : null}
      </span>
      {children}
    </label>
  );
}
