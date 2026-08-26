import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';

import { api, setAuthToken } from '../lib/api';
import { useCart } from '../lib/cart';
import { Card, ErrorState, PrimaryButton, Screen } from './ui';

/**
 * The one authentication prompt in the customer journey.
 *
 * It appears at add-to-cart, not at scan and not at checkout (DR-0001).
 *
 *   Not at scan     — that gates browsing behind a form and loses everyone who
 *                     was merely curious.
 *   Not at checkout — that competes with the payment itself and adds a second
 *                     place to abandon a full basket.
 *   At add-to-cart  — the customer has expressed intent and invested almost
 *                     nothing, so the interruption costs one item's worth of
 *                     momentum rather than a full basket's.
 *
 * THE CART SURVIVES THIS SCREEN. That is the single most important property
 * here and it is why this is a route rather than a modal that unmounts the menu:
 * the item was added to the store BEFORE navigating, so returning is a
 * `navigate(-1)` onto a menu that already has it. Losing the cart is the most
 * likely way to make this feel worse than no login at all.
 */
export function Verify() {
  const navigate = useNavigate();
  const location = useLocation();

  /**
   * Where the customer was trying to get to, if a route guard sent them here.
   *
   * `RequireVerified` puts it in history state. Falling back to `navigate(-1)`
   * keeps the original path working — somebody who tapped ADD on the menu got
   * here from an event handler, not a redirect, and going back is exactly right
   * for them. Somebody bounced off `/checkout` needs to land on `/checkout`,
   * because Back from here is the menu they already left.
   */
  const from = (location.state as { from?: string } | null)?.from ?? null;
  const sessionId = useCart((s) => s.sessionId);
  const setCustomerIdentity = useCart((s) => s.setCustomerIdentity);

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const codeRef = useRef<HTMLInputElement>(null);

  // Countdown for the resend button. Without it people tap resend three times
  // in five seconds, each one invalidating the code that just arrived.
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  const send = useMutation({
    mutationFn: () => api.requestOtp(phone),
    onSuccess: (r) => {
      setSentTo(r.sentTo);
      setResendIn(r.resendAfterSeconds);
      // Focus moves to the code field so the customer can type straight away.
      setTimeout(() => codeRef.current?.focus(), 50);
    },
  });

  /**
   * Development only: shows the code instead of making you read the API log.
   *
   * Enabled only once a code has been sent, and only in DEV — `import.meta.env`
   * is inlined at build time, so this whole block and the fetch inside it are
   * removed from a production bundle rather than merely skipped.
   */
  const devCode = useQuery({
    queryKey: ['dev-otp', sentTo],
    queryFn: () => api.latestOtp(),
    enabled: import.meta.env.DEV && sentTo !== null,
    refetchInterval: 2000,
    retry: false,
  });

  const verify = useMutation({
    // The name goes with the CODE, not with the request that sent it. Sending
    // it a step earlier would let anyone write a name against any number they
    // can type, with no proof they hold it.
    mutationFn: () => api.verifyOtp(phone, code, name.trim()),
    onSuccess: (r) => {
      setAuthToken(r.token);
      setCustomerIdentity(r.customer.phone, r.customer.name);
      /*
       * `replace`, so this screen leaves history.
       *
       * Otherwise Back from checkout returns to a verify form for a customer
       * who is already verified — which is confusing on its own and worse than
       * that, because the form is empty and looks like the verification was
       * lost.
       */
      if (from) navigate(from, { replace: true });
      else navigate(-1);
    },
  });

  if (!sessionId) return <ErrorState error={new Error('No session. Rescan the QR code.')} />;

  return (
    <Screen
      title={sentTo === null ? 'One quick step' : 'Enter the code'}
      subtitle={
        sentTo === null
          ? 'We need a number to tell you when your food is ready'
          : `Sent to ${sentTo}`
      }
      back
    >
      <Card className="p-5 space-y-4">
        {/*
          THE NAME IS REQUIRED, AND THAT IS AN OPERATIONAL DECISION.

          It was optional, on the reasoning that a hungry person will not fill
          in a form and a phone number is the only thing strictly needed. That
          reasoning missed where the name is actually spent.

          The kitchen ticket carries the customer's NAME AND NEVER THE PHONE —
          deliberately, because a kitchen tablet is a screen several people can
          see, and a customer's number is not theirs to read. So a nameless
          customer gives the counter nothing to call out. The field is not a
          courtesy; it is the entire handover at collection.

          One field, above the phone because it is the easier question, and a
          form that opens with the easy one gets finished more often.
        */}
        <label className="block">
          <span className="text-sm font-medium text-ink-700">Your name</span>
          <input
            type="text"
            autoComplete="given-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={sentTo !== null}
            maxLength={80}
            placeholder="Ramesh"
            className="mt-1.5 w-full rounded-xl border border-ink-200 bg-ink-50 px-4 py-3.5
                       text-[17px] outline-none focus:ring-2 focus:ring-brand-200
                       focus:border-brand-500 disabled:text-ink-500"
          />
          <span className="block text-[12px] text-ink-500 mt-1.5 leading-relaxed">
            The counter calls this name when your food is ready — they never see
            your number.
          </span>
        </label>

        <label className="block">
          <span className="text-sm font-medium text-ink-700">Mobile number</span>
          <input
            type="tel"
            inputMode="numeric"
            autoComplete="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            disabled={sentTo !== null}
            placeholder="98765 43210"
            className="mt-1.5 w-full rounded-xl border border-ink-200 bg-ink-50 px-4 py-3.5
                       text-[18px] tnum outline-none focus:ring-2 focus:ring-brand-200
                       focus:border-brand-500 disabled:text-ink-500"
          />
        </label>

        {sentTo === null ? (
          <PrimaryButton
            onClick={() => send.mutate()}
            /*
             * The NAME gates the first button, not the second.
             *
             * Blocking at "Verify" instead would let somebody spend an SMS,
             * wait for it, type six digits and only then be told about a field
             * two inches above — and the field is disabled by then, so the only
             * way out is to reload and start over. Gating the send means the
             * requirement is visible while it is still free to satisfy.
             */
            disabled={
              name.trim().length === 0 ||
              phone.replace(/\D/g, '').length < 10 ||
              send.isPending
            }
          >
            {send.isPending ? 'SENDING A CODE…' : 'SEND CODE'}
          </PrimaryButton>
        ) : (
          <>
            <label className="block">
              <span className="text-sm font-medium text-ink-700">6-digit code</span>
              {/* One wide field rather than six boxes. Six inputs look right in
                  a mockup and fight every Android autofill, paste, and the
                  browser's own SMS one-time-code hint — which is the thing that
                  actually makes this fast. `autocomplete=one-time-code` does
                  more for completion here than any amount of styling. */}
              <input
                ref={codeRef}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                className="mt-1.5 w-full rounded-xl border-2 border-ink-200 bg-ink-50 px-4 py-4
                           text-[28px] font-bold tracking-[0.45em] tnum text-center text-ink-900
                           outline-none focus:border-brand-500 focus:bg-surface"
              />
            </label>

            <PrimaryButton
              onClick={() => verify.mutate()}
              disabled={code.length !== 6 || verify.isPending}
            >
              {verify.isPending ? 'CHECKING…' : 'VERIFY'}
            </PrimaryButton>

            <button
              onClick={() => send.mutate()}
              disabled={resendIn > 0 || send.isPending}
              className="pressable glass-hover w-full text-[13px] font-semibold text-brand-700
                         py-2 rounded-lg disabled:text-ink-400"
            >
              {resendIn > 0 ? `Resend in ${resendIn}s` : 'Send a new code'}
            </button>
          </>
        )}

        {import.meta.env.DEV ? (
          <div className="border-t border-ink-100 pt-3">
            {devCode.data?.code ? (
              <button
                type="button"
                onClick={() => setCode(devCode.data.code!)}
                /* Was `bg-ink-900` — a black panel in a light page, and the
                   exact anti-pattern the redesign audit calls out. A dashed
                   warn-tinted card says "this is scaffolding, not product"
                   without punching a hole in the page, and it behaves in dark
                   mode instead of inverting into a white slab. */
                className="pressable glass-hover w-full rounded-xl border border-dashed border-warn-500
                           bg-warn-50 px-4 py-3 text-left"
              >
                <span className="block text-[10px] font-bold uppercase tracking-widest text-warn-700">
                  Development — no SMS is sent
                </span>
                <span className="mt-1 flex items-baseline justify-between gap-3">
                  <span className="text-[26px] font-black tracking-[0.3em] tnum text-ink-900">
                    {devCode.data.code}
                  </span>
                  <span className="text-[11px] font-semibold text-warn-700 shrink-0">
                    TAP TO FILL
                  </span>
                </span>
              </button>
            ) : (
              <p className="text-[11px] text-ink-400 leading-relaxed">
                Development: no SMS is sent. The code appears here a moment after you request
                it, and is also printed in the API log as
                <code className="mx-1">otp_console_delivery</code>. Real delivery needs DLT
                registration, which is still outstanding.
              </p>
            )}
          </div>
        ) : null}
      </Card>

      {/* Said before they type, not after. The reason a diner hesitates over a
          phone number is not knowing what it will be used for. */}
      <p className="text-[12px] text-ink-500 leading-relaxed mt-4 px-1">
        Used to tell you when your food is ready and to find your order if
        something goes wrong. Nothing else.
      </p>

      {send.isError ? <ErrorState error={send.error} onRetry={() => send.mutate()} /> : null}
      {verify.isError ? <ErrorState error={verify.error} /> : null}
    </Screen>
  );
}
