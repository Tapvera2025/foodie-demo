import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from './api';
import { CATALOG_CHANGED, useFallbackInterval, useRealtime } from './realtime';
import { ImagePicker } from './ui';

/**
 * The stall itself: taking orders, or not.
 *
 * THREE THINGS CAN STOP A STALL AND THE REMEDIES ARE DIFFERENT
 *
 * paused the kitchen said so. Ends by itself, or resume here.
 * blocked the escalation ladder stopped it for not acknowledging orders.
 * There is deliberately NO button for this — see below.
 * closed the platform has the stall suspended or not yet live.
 *
 * Rendering these as one "open/closed" switch would be simpler and would make
 * the screen useless in the only situation that matters, which is when a stall
 * has stopped taking orders and nobody knows why.
 *
 * WHY BLOCKED HAS NO DISMISS BUTTON
 *
 * A stall is blocked because it stopped acknowledging tickets for 90 seconds
 * (PRD §11.4). The cause is that nobody is looking at the board — so a button
 * saying "we're fine" would be pressed by exactly the person who is not looking
 * at it, and orders would resume flowing to a kitchen that still cannot see
 * them. It clears when the stall starts accepting again, which is the only
 * evidence that the underlying problem is gone.
 */
export function Settings() {
  /* `FALLBACK_MS` while the socket is up, the old interval when it is not. */
  const fallbackMs = useFallbackInterval();

  const qc = useQueryClient();

  useRealtime(CATALOG_CHANGED, [['stall-status']]);

  const q = useQuery({
    queryKey: ['stall-status'],
    queryFn: api.stallStatus,
    /*
      The pause is published as `catalog.changed` by the interceptor on the
      vendor controller, so a second tablet sees a pause the moment it is set
      rather than up to ten seconds later.

      The timer stays as the fallback, and here it does a second job the socket
      cannot: a pause EXPIRES ON ITS OWN. Nothing writes a row when a
      `temp_closed_until` passes, so there is no transaction to hang a
      notification off and no event will ever arrive for it. The countdown has
      to be roughly honest or somebody re-pauses a stall that already resumed —
      so this one is genuinely a poll, and it is the one place in the app where
      that is the right answer.
    */
    refetchInterval: fallbackMs,
  });

  const pause = useMutation({
    mutationFn: (minutes: number) => api.pause(minutes),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['stall-status'] });
      // The board's banner reads the same state.
      void qc.invalidateQueries({ queryKey: ['board'] });
    },
  });

  const s = q.data;

  if (q.isLoading || !s) {
    return <p className="text-shell-400 text-xl p-8">Loading…</p>;
  }

  const paused = Boolean(s.pausedUntil);
  const canPause = s.vendorStatus === 'ACTIVE' && !s.dispatchBlocked;

  return (
    /*
      TWO COLUMNS ON A WIDE TABLET, ONE ON A MOUNTED PHONE.

      Everything here used to be a single 48rem ribbon: a green slab, four amber
      slabs, a dashed box and a footnote, each the full width of whatever it was
      shown on. On the 10" landscape tablet these boards actually run on, that
      is a column of unrelated blocks with a third of the screen empty beside
      it, and nothing on the page says which of them is the important one.

      The split is by URGENCY, not by size. Left is the thing a cook touches
      mid-service — am I taking orders, stop for twenty minutes. Right is the
      thing an owner sets up once. They never compete for the same glance.
    */
    <div className="p-5 md:p-6 grid gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-6 items-start">
      <div className="space-y-5">
        {/* -------------------------------------------- the one big answer */}
        {/*
          A DOT, A HEADLINE, A SENTENCE — in that order.

          The old panel was a flat wash of colour with 3xl text on it and no
          anchor, which at arm's length across a hot kitchen reads as "a green
          rectangle" before it reads as anything. The dot is what makes it
          legible in peripheral vision, and it PULSES only while the stall is
          live, because a static dot and a stopped kitchen look the same.
        */}
        <section
          className={`glass-on rounded-card border-2 p-5 md:p-6 ${
            s.acceptingOrders
              ? 'border-go-500 bg-go-500/10'
              : 'border-warn-500 bg-warn-500/10'
          }`}
        >
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className={`relative grid place-items-center size-3.5 shrink-0 rounded-full ${
                s.acceptingOrders ? 'bg-go-500' : 'bg-warn-500'
              }`}
            >
              {s.acceptingOrders ? (
                <span className="absolute inset-0 rounded-full bg-go-500 motion-safe:animate-ping opacity-60" />
              ) : null}
            </span>
            <h2
              className={`text-2xl md:text-3xl font-bold leading-tight ${
                s.acceptingOrders ? 'text-go-500' : 'text-warn-500'
              }`}
            >
              {s.acceptingOrders ? 'Taking orders' : 'Not taking orders'}
            </h2>
          </div>

          <p className="text-shell-300 text-base md:text-lg mt-2.5 leading-snug">
            {s.acceptingOrders ? (
              <>Customers can see {s.name} and order from it right now.</>
            ) : s.dispatchBlocked ? (
              <>
                Orders were not being accepted, so the platform stopped sending them. This clears
                by itself once tickets start getting accepted again — check the Orders tab.
              </>
            ) : s.pausedUntil ? (
              <>
                Paused for another {s.pausedMinutesLeft}{' '}
                {s.pausedMinutesLeft === 1 ? 'minute' : 'minutes'}. Customers see the stall as
                closed. It reopens by itself.
              </>
            ) : s.vendorStatus !== 'ACTIVE' ? (
              <>
                The platform has this stall {s.vendorStatus.toLowerCase()}. Only the platform can
                change that — nothing on this tablet will.
              </>
            ) : null}
          </p>

          {/* RESUMING IS THE HERO, and it belongs inside the panel that says
              the stall is stopped. It was below, separated by a margin, which
              made "you are paused" and "un-pause" two unrelated things. */}
          {canPause && paused ? (
            <button
              onClick={() => pause.mutate(0)}
              disabled={pause.isPending}
              className="pressable glass-hover mt-5 w-full min-h-16 rounded-xl bg-go-500 text-shell-900
                         text-xl font-bold disabled:opacity-50"
            >
              {pause.isPending ? 'Starting…' : 'Start taking orders again'}
            </button>
          ) : null}
        </section>

        {/* ------------------------------------------------------ the pause */}
        {canPause && !paused ? (
          <section className="glass-on rounded-card border border-shell-700 bg-shell-800 p-5 md:p-6">
            <h3 className="text-lg font-bold text-shell-100">Pause for a bit</h3>
            <p className="text-shell-400 text-sm mt-1.5 leading-relaxed">
              Stops NEW orders only. Anything already accepted still needs cooking, and the stall
              reopens on its own.
            </p>

            {/*
              FOUR NEUTRAL BUTTONS, NOT FOUR AMBER SLABS.

              They were `border-2 border-warn-500 text-warn-500` at `min-h-20`,
              which made stopping the stall the loudest control on a screen
              whose headline says the stall is running. Amber means "ageing" on
              the board next door; spending it on a button nobody presses during
              a normal shift devalues it where it matters.

              Still 56px tall and still four across, because a cook hits these
              with the side of a hand. What changed is the WEIGHT, not the
              target: a neutral face, and the amber kept as a hairline that says
              which family they belong to.
            */}
            <div className="grid grid-cols-4 gap-2.5 mt-4">
              {[10, 20, 30, 60].map((m) => (
                <button
                  key={m}
                  onClick={() => pause.mutate(m)}
                  disabled={pause.isPending}
                  className="pressable glass-hover min-h-14 rounded-xl border border-shell-600 bg-shell-900
                             text-shell-100 text-lg font-bold leading-none disabled:opacity-50
                             flex flex-col items-center justify-center gap-0.5"
                >
                  <span className="tnum">{m}</span>
                  <span className="eyebrow text-[10px] text-shell-400">MIN</span>
                </button>
              ))}
            </div>

            {/*
              A pause has a LENGTH, and there is no open-ended option.
              "Closed until further notice" is the switch somebody flips during
              a rush and finds still on the next morning — the stall sells
              nothing all day and nobody can see why, because the switch is on a
              tablet in the back.
            */}
            <p className="text-shell-400 text-[13px] mt-3 leading-relaxed">
              There is no “until further notice”. A pause somebody forgets is a day of no sales
              nobody can explain.
            </p>

            {pause.isError ? (
              <p role="alert" className="mt-3 text-late-500 text-base font-semibold">
                That did not save. Check the connection and try again.
              </p>
            ) : null}
          </section>
        ) : null}

        {pause.isError && paused ? (
          <p role="alert" className="text-late-500 text-base font-semibold">
            That did not save. Check the connection and try again.
          </p>
        ) : null}
      </div>

      {/* ------------------------------------------- set up once, on the right */}
      <div className="space-y-5">
        <CoverPanel imageUrl={s.coverImageUrl} />

        <OfferPanel
          enabled={s.offerUploadsEnabled}
          imageUrl={s.offerImageUrl}
          headline={s.offerHeadline}
          requestedAt={s.offerSlotRequestedAt}
          decidedAt={s.offerSlotDecidedAt}
        />
      </div>
    </div>
  );
}

/**
 * ============================================================================
 * THE STALL'S OWN BANNER
 * ============================================================================
 *
 * NOT THE SAME THING AS THE OFFER BANNER, and the two sit next to each other
 * on this tab precisely so nobody confuses them:
 *
 *   this one   the photograph at the top of YOUR page. Always yours, always
 *              there, no permission needed. It is your shopfront.
 *   the offer  a slot on the COURT'S home screen, above every stall list. The
 *              food court office grants it, because it is shared space.
 *
 * WHY THIS EXISTS NOW
 *
 * `vendor.cover_image_url` has been in the schema since migration 12 and no
 * screen has ever been able to write it. So the customer's stall page fell
 * back to "the first dish with a photograph" — which meant the banner changed
 * on its own every time the menu did. Adding a dish moved the shopfront.
 *
 * The fallback is gone. This is the only thing that fills that space now.
 */
function CoverPanel({ imageUrl }: { imageUrl: string | null }) {
  const qc = useQueryClient();

  /*
   * A DRAFT, and Save sends it — the same shape as the offer panel, for the
   * same reason. Binding the picker straight to the server's value means the
   * upload has nowhere to live between landing and being persisted, which is
   * exactly the bug that made offer uploads vanish.
   */
  const [draft, setDraft] = useState<string | null>(imageUrl);

  const save = useMutation({
    mutationFn: (url: string | null) => api.setCover(url),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['stall-status'] }),
  });

  const changed = draft !== imageUrl;

  return (
    <section className="glass-on rounded-card border border-shell-700 bg-shell-800 p-5 md:p-6">
      <h2 className="text-lg font-bold text-shell-100">Your stall banner</h2>
      <p className="text-shell-400 text-sm mt-1.5 mb-4 leading-relaxed">
        The photograph at the top of your page, above your menu. This is yours —
        no permission needed, and it is not the offer banner below.
      </p>

      <ImagePicker
        value={draft}
        kind="stall-cover"
        label="Banner photograph"
        hint="Wide works best — around twice as wide as it is tall. A picture of your counter or your best dish."
        onChange={setDraft}
      />

      {save.isError ? (
        <p role="alert" className="text-[13px] text-late-500 mt-3">
          That did not save. Check the connection and try again.
        </p>
      ) : null}

      <div className="flex items-center gap-3 mt-4">
        <button
          onClick={() => save.mutate(draft)}
          disabled={!changed || save.isPending}
          className="pressable glass-hover h-12 rounded-xl bg-go-500 text-shell-900 px-5 text-[15px] font-bold disabled:opacity-40"
        >
          {save.isPending
            ? 'Saving…'
            : draft === null && imageUrl
              ? 'Remove the banner'
              : 'Save the banner'}
        </button>
        {save.isSuccess && !changed ? <span className="text-[13px] text-go-500">Saved</span> : null}
      </div>
    </section>
  );
}

/**
 * The stall's banner on the customer home carousel.
 *
 * ============================================================================
 * THE PLATFORM GRANTS THE SLOT, THIS FILLS IT
 * ============================================================================
 *
 * `offerUploadsEnabled` is not a setting this screen can change. The carousel
 * is the first thing on the customer home screen, above any stall list, on
 * every visit — a stall that could put itself there would be taking that space
 * from every other stall in the court. So the console grants it and this fills
 * it, and the server refuses the upload without the grant rather than trusting
 * either screen.
 *
 * Shown even when NOT granted, with the reason. A control that is simply absent
 * gets asked about; a disabled one with a sentence does not.
 *
 * THE HEADLINE IS REQUIRED AND IS NOT A CAPTION.
 *
 * It is the image's alt text, and a database CHECK refuses an image without
 * one. An offer that exists only as artwork is invisible to a screen reader and
 * to anybody whose image never loaded — which in a basement food court is
 * common rather than exotic. It is also shown as text under the banner, because
 * words baked into a JPEG are unreadable at 2x and untranslatable anywhere.
 */
function OfferPanel({
  enabled,
  imageUrl,
  headline,
  requestedAt,
  decidedAt,
}: {
  enabled: boolean;
  imageUrl: string | null;
  headline: string | null;
  requestedAt: string | null;
  decidedAt: string | null;
}) {
  const qc = useQueryClient();

  /**
   * A DRAFT, not the server's value. This is the bug that made uploads vanish.
   *
   * The picker was bound straight to `imageUrl` — the saved value — and its
   * `onChange` only persisted when a headline happened to be typed already.
   * Upload before typing one and the URL was handed over, dropped on the floor,
   * and the picker re-rendered from the server showing an empty box. The file
   * had reached Cloudinary perfectly; nothing on this screen kept it.
   *
   * A controlled input whose value comes from the SERVER cannot show anything
   * the server has not yet been told. So the draft lives here, the picker binds
   * to it, and Save is what sends both halves at once — which is also the only
   * way to satisfy the database CHECK that refuses an image without a headline.
   */
  const [draftImage, setDraftImage] = useState<string | null>(imageUrl);
  const [draftHeadline, setDraftHeadline] = useState(headline ?? '');

  const save = useMutation({
    mutationFn: (v: { imageUrl: string | null; headline: string }) =>
      api.setOffer(v.imageUrl, v.headline),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['stall-status'] }),
  });

  if (!enabled) {
    return <OfferSlotRequest requestedAt={requestedAt} decidedAt={decidedAt} />;
  }

  const trimmed = draftHeadline.trim();
  const changed = draftImage !== imageUrl || trimmed !== (headline ?? '');
  // Both halves or neither. The database refuses an image with no headline, and
  // a headline with no image is an offer nobody sees.
  const complete = draftImage === null || trimmed.length > 0;

  return (
    <section className="glass-on rounded-card border border-shell-700 bg-shell-800 p-5 md:p-6">
      <div className="flex items-center gap-2.5">
        <h2 className="text-lg font-bold text-shell-100 flex-1">Offer banner</h2>
        {/* The GRANT, stated as a fact. This panel and the request panel look
            alike at a glance, and the badge is what distinguishes "you have a
            slot, fill it" from "you do not have one". */}
        <span className="eyebrow text-[10px] rounded-full px-2.5 py-1 bg-go-500/15 text-go-500">
          Slot granted
        </span>
      </div>
      <p className="text-shell-400 text-sm mt-1.5 mb-4 leading-relaxed">
        Shown at the top of the customer app while your stall is open. It does <strong>not</strong>{' '}
        change any price — it is your own claim about your menu.
      </p>

      <ImagePicker
        value={draftImage}
        kind="offer"
        label="Banner image"
        /* A NUMBER, because the banner is now shown at its own shape rather
           than cropped to a box. "Wide works best" was fine advice when the
           app cropped to 2:1 regardless; now whatever they upload is what
           appears, so the guidance has to be specific enough to design to. */
        hint="Around 3 times as wide as it is tall — 1200×400 is a good size. It is shown whole, never cropped."
        onChange={setDraftImage}
      />

      <label className="block mt-4">
        <span className="block text-[13px] font-semibold text-shell-300 mb-1.5">
          What the offer says
        </span>
        <input
          value={draftHeadline}
          onChange={(e) => setDraftHeadline(e.target.value)}
          maxLength={80}
          placeholder="Buy 1 get 1 free"
          className="w-full h-11 rounded-xl border border-shell-700 bg-shell-900 px-3.5 text-[15px]
                     text-shell-100 placeholder:text-shell-400 outline-none focus:border-brand-400"
        />
        <span className="block text-[12px] text-shell-400 mt-1.5 leading-relaxed">
          Read aloud by screen readers and shown if the image does not load. Required.
        </span>
      </label>

      {save.isError ? (
        <p role="alert" className="text-[13px] text-late-500 mt-3">
          That did not save. Check the connection and try again.
        </p>
      ) : null}

      {/* Said BEFORE they press a disabled button, not after. A control that is
          greyed out with no reason reads as broken. */}
      {draftImage !== null && trimmed.length === 0 ? (
        <p className="text-[13px] text-warn-500 mt-3">
          Add a line of text above and the banner can be saved.
        </p>
      ) : null}

      <div className="flex items-center gap-3 mt-4">
        <button
          onClick={() => save.mutate({ imageUrl: draftImage, headline: trimmed || 'Offer' })}
          disabled={!changed || !complete || save.isPending}
          className="pressable glass-hover h-12 rounded-xl bg-go-500 text-shell-900 px-5 text-[15px] font-bold disabled:opacity-40"
        >
          {save.isPending ? 'Saving…' : draftImage === null && imageUrl ? 'Remove the banner' : 'Save the banner'}
        </button>
        {save.isSuccess && !changed ? (
          <span className="text-[13px] text-go-500">Saved</span>
        ) : null}
      </div>
    </section>
  );
}

/**
 * No slot yet — asking for one, and being told what happened.
 *
 * ============================================================================
 * THREE STATES, NOT ONE "YOU HAVE NO SLOT"
 * ============================================================================
 *
 * This panel used to say one thing: "the food court office decides who appears
 * there — ask them if you would like one." A closed door with no bell. The only
 * route out of it was a phone call, which meant the request never reached
 * whoever could act on it and nobody could see how long it had been waiting.
 *
 * NEVER ASKED a button, and one sentence on what the slot is
 * WAITING when they asked, and no button — a second request queues
 * nothing and only makes the queue harder to work through
 * DECLINED the office answered. Asking again is allowed, because the
 * reason is usually "not this month" rather than "never".
 *
 * The middle and the last are why the server keeps two timestamps. Clearing the
 * request on a decline would put the stall straight back to NEVER ASKED — it
 * would conclude the request was lost and ask again every week, into what feels
 * from their side like silence.
 */
function OfferSlotRequest({
  requestedAt,
  decidedAt,
}: {
  requestedAt: string | null;
  decidedAt: string | null;
}) {
  const qc = useQueryClient();

  const ask = useMutation({
    mutationFn: () => api.requestOfferSlot(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['stall-status'] }),
  });

  const waiting = requestedAt !== null;
  const declined = !waiting && decidedAt !== null;

  const when = (iso: string): string =>
    new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

  return (
    /*
      NOT DASHED ANY MORE.

      A dashed border means "drop a file here" everywhere else in this app —
      `ImagePicker` uses one three inches away — so the panel explaining what an
      offer banner IS looked like an empty upload target somebody had failed to
      fill. It is a solid panel with a status badge, like every other panel on
      this tab; the difference between the three states is carried by the badge
      and the copy rather than by the border being unfinished.
    */
    <section
      className={`glass-on rounded-card border p-5 md:p-6 ${
        waiting ? 'border-warn-500 bg-warn-500/5' : 'border-shell-700 bg-shell-800'
      }`}
    >
      <div className="flex items-center gap-2.5">
        <h2 className="text-lg font-bold text-shell-100 flex-1">Offer banner</h2>
        <span
          className={`eyebrow text-[10px] rounded-full px-2.5 py-1 ${
            waiting
              ? 'bg-warn-500/15 text-warn-500'
              : declined
                ? 'bg-shell-700 text-shell-300'
                : 'bg-shell-700 text-shell-400'
          }`}
        >
          {waiting ? 'Waiting' : declined ? 'Not this time' : 'No slot yet'}
        </span>
      </div>

      {waiting ? (
        <>
          <p className="text-shell-300 text-sm mt-1.5 leading-relaxed">
            Requested on {when(requestedAt)}. The food court office has it and will come back to
            you — there is nothing else to do here.
          </p>
          <p className="text-shell-400 text-[13px] mt-2 leading-relaxed">
            Asking again would not move you up the queue, so there is no button.
          </p>
        </>
      ) : (
        <>
          <p className="text-shell-400 text-sm mt-1.5 leading-relaxed">
            {declined
              ? `The office looked at this on ${when(decidedAt!)} and did not give your stall a slot. You can ask again — these are usually decided a month at a time.`
              : 'A banner at the top of the customer app, above every stall list. The food court office decides which stalls get one.'}
          </p>

          {ask.isError ? (
            <p role="alert" className="text-[13px] text-late-500 mt-3">
              That did not send. Check the connection and try again.
            </p>
          ) : null}

          <button
            onClick={() => ask.mutate()}
            disabled={ask.isPending}
            className="pressable glass-hover mt-4 h-12 rounded-xl bg-shell-100 text-shell-900 px-5 text-[15px] font-bold disabled:opacity-50"
          >
            {ask.isPending ? 'Sending…' : declined ? 'Ask again' : 'Request a slot'}
          </button>
        </>
      )}
    </section>
  );
}
