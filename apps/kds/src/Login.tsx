import { useState, type FormEvent } from 'react';

import { api, auth, ApiError, type SignOutReason } from './api';
import { unlockAudio } from './notify';
import { ThemeToggle, Wordmark } from './ui';

/**
 * The kitchen board's sign-in.
 *
 * THE SAME MASTHEAD AS THE OTHER TWO SURFACES
 *
 * Serif wordmark, uppercase eyebrow naming the surface, then a card. The console
 * uses the identical lockup and the customer app carries it on the stall list.
 * That matters more here than anywhere else: this is the ONLY screen in the
 * kitchen app that shows the product's name at all — the board itself is
 * nothing but tickets, correctly, because a cook mid-service does not need a
 * logo. So the whole burden of "what is this thing I have been handed" falls on
 * one screen.
 *
 * WHAT IS NOT COPIED FROM THE OTHER TWO
 *
 * The sizes. Every target here is 56px or taller and the inputs are set at 17px,
 * because this runs on a tablet mounted at arm's length and the person tapping
 * it has wet or gloved hands. The console's 13px form on a laptop is the correct
 * answer to a different question.
 *
 * THE THEME SWITCH IS ON THIS SCREEN AND THAT IS A FIX, NOT A FLOURISH
 *
 * It used to live only in the board's sidebar, which put it behind the login.
 * Light mode exists for a tablet on a counter under a skylight, where a dark
 * screen becomes a mirror — and in that situation the first unreadable screen is
 * this one. A control that repairs an unreadable screen is no use if you have to
 * read the screen to find it.
 */
export function Login({
  onSignedIn,
  reason,
}: {
  onSignedIn: () => void;
  reason?: SignOutReason;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Browsers keep AudioContext suspended until a user gesture. Signing in
      // is the one gesture guaranteed to happen on a tablet that will then sit
      // untouched for hours, so this is where the alert sound gets its licence
      // to play. Miss this and the first new order beeps at nobody.
      unlockAudio();

      const res = await api.login(email.trim(), password);
      auth.set(res.token);
      onSignedIn();
    } catch (err) {
      // The server deliberately returns the same message for a bad email and a
      // bad password. Showing it verbatim keeps that property — inventing a
      // more "helpful" client-side distinction would undo it.
      setError(err instanceof ApiError ? err.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  }

  const field = `w-full rounded-xl border border-shell-700 bg-shell-900 px-4 py-4 text-[17px]
                 text-shell-100 placeholder:text-shell-400 outline-none
                 focus:border-brand-400 focus:bg-shell-800`;

  return (
    <div className="min-h-full grid place-items-center p-6">
      {/* Capped at 26rem rather than left to fill a 10-inch tablet in landscape.
          A sign-in form stretched across a wide screen puts the label and its
          input a hand's width apart. */}
      <div className="w-full max-w-[26rem]">
        <div className="flex items-start justify-between gap-4 mb-7">
          <Wordmark surface="Kitchen board" />
          <ThemeToggle />
        </div>

        {/* Says what happened rather than just reappearing. A form that shows
            up unannounced mid-service reads as a crash; "your session ended"
            reads as a thing that was supposed to happen. */}
        {reason === 'EXPIRED' ? (
          <div
            role="status"
            className="mb-5 rounded-card border border-warn-500 bg-warn-500/10 px-5 py-4"
          >
            <p className="font-bold text-shell-100">Your session ended</p>
            <p className="text-shell-300 text-sm mt-1 leading-relaxed">
              Sign in again to get back to the queue. Nothing was lost — orders keep arriving
              while you are signed out.
            </p>
          </div>
        ) : null}

        <form
          onSubmit={submit}
          className="rounded-card border border-shell-700 bg-shell-800 p-6"
        >
          <h1 className="text-[20px] font-bold text-shell-100">Sign in to your stall</h1>
          <p className="text-[14px] text-shell-400 mt-1 mb-6 leading-relaxed">
            Use the account the food court gave you. It opens this stall's queue and nobody
            else's.
          </p>

          <label className="block mb-4">
            <span className="block text-[13px] font-semibold text-shell-300 mb-2">Email</span>
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={field}
            />
          </label>

          <label className="block mb-6">
            <span className="block text-[13px] font-semibold text-shell-300 mb-2">Password</span>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={field}
            />
          </label>

          {error ? (
            <p
              role="alert"
              className="mb-5 rounded-xl border border-late-500 bg-late-500/10 px-4 py-3
                         text-[14px] font-semibold text-shell-100"
            >
              {error}
            </p>
          ) : null}

          {/*
            `text-shell-900` on `bg-brand-500`, not white.
            The shell scale inverts between themes, so this one pairing is
            correct in both: near-black on a lifted red in dark, and a pale
            label on the darkened red in light. White was 4.30:1 on the light
            theme's red, which is why `--brand-500` there is a step down the
            same hue — see the note in index.css.
          */}
          <button
            type="submit"
            disabled={busy}
            className="pressable glass-hover w-full rounded-xl bg-brand-500 text-shell-900 font-bold text-[17px]
                       py-5 disabled:opacity-50"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        {/*
          Said here because this is where somebody stuck actually is.
          Vendor staff accounts are issued and revoked by the platform, not by
          the stall (PRD §13.1) — so there is deliberately no "forgot password"
          link to click. Pointing at the real route beats a dead end.
        */}
        <p className="text-[12px] text-shell-400 text-center mt-5 leading-relaxed">
          Locked out? Stall accounts are created and reset by the food court office, not from
          this screen.
        </p>
      </div>
    </div>
  );
}
