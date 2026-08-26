import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';

import { api, auth } from './api';
import { Button, Card, ErrorNote, Field, Input, ThemeToggle } from './ui';

/**
 * Console sign-in.
 *
 * The same `/auth/login` the kitchen board uses — one staff identity, several
 * surfaces. What differs is what the token is then permitted to do, and that is
 * decided per request by `decide`, not here.
 *
 * NO ROLE CHECK ON THIS SCREEN, DELIBERATELY.
 *
 * It is tempting to reject a cook signing in here with "you do not have console
 * access". That would be a client-side check standing in for a server-side one,
 * and it teaches the wrong lesson: the console is not protected by this form, it
 * is protected by every endpoint calling `decide`. A cook who signs in gets a
 * working session and an empty list, which is both honest and harmless.
 *
 * THE MASTHEAD IS THE SIDEBAR'S, NOT A SECOND ONE
 *
 * `Shell.tsx` opens with the Foodie wordmark in the display serif and an
 * uppercase eyebrow under it. This screen used a 20px sans heading instead, so
 * the product introduced itself one way to a signed-out user and another way
 * thirty seconds later. Same lockup, same sizes, same place on the left edge —
 * signing in should feel like the page filling in rather than a different site
 * handing you over.
 */
export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const login = useMutation({
    mutationFn: () => api.login(email.trim(), password),
    onSuccess: (r) => auth.set(r.token),
  });

  const expired = auth.reason() === 'EXPIRED';
  const canSubmit = email.trim().length > 3 && password.length > 0 && !login.isPending;

  return (
    <div className="min-h-dvh grid place-items-center p-6">
      <div className="w-full max-w-sm">
        <div className="flex items-start justify-between gap-4 mb-6">
          <div>
            <p className="display text-[32px] text-ink-900 leading-none">Foodie</p>
            {/* `ink-500`, not the `ink-400` the sidebar used. 9px uppercase is
                the smallest type in the console and ink-400 is 3.06:1 on a
                card — under AA. See the note in tests/design/contrast.mjs. */}
            <p className="eyebrow text-[9px] text-ink-500 mt-2">Platform console</p>
          </div>
          <ThemeToggle />
        </div>

        <Card className="p-5">
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (canSubmit) login.mutate();
            }}
          >
            <div className="pb-1">
              <h1 className="text-[15px] font-bold text-ink-900">Sign in</h1>
              {/*
                Names the SCOPE, not the software. Somebody landing here has
                been sent a link and a password by whoever runs the platform,
                and the useful thing to tell them is what is on the other side —
                which is also, accurately, everything this console does.
              */}
              <p className="text-[12px] text-ink-500 mt-0.5 leading-relaxed">
                Food courts, stalls and the accounts that run them.
              </p>
            </div>

            {expired && !login.isError ? (
              <p className="rounded-lg bg-draft-50 text-draft-700 px-3 py-2 text-[12px] font-medium">
                Your session ended. Sign in again.
              </p>
            ) : null}

            <Field label="Email" required>
              <Input value={email} onChange={setEmail} type="email" placeholder="ops@example.com" />
            </Field>

            <Field label="Password" required>
              <Input value={password} onChange={setPassword} type="password" />
            </Field>

            {login.isError ? <ErrorNote error={login.error} /> : null}

            <Button type="submit" disabled={!canSubmit} full>
              {login.isPending ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </Card>

        {/*
          Where a "forgot password" link would be, saying the true thing
          instead. Console accounts are provisioned, not self-served — a link
          that opened a reset flow which does not exist would be worse than the
          absence it is covering for.
        */}
        <p className="text-[11px] text-ink-500 text-center mt-4 leading-relaxed">
          Console accounts are issued by the platform. There is no self-service reset.
        </p>

        {import.meta.env.DEV ? (
          <p className="mt-4 rounded-lg border border-dashed border-draft-500 bg-draft-50 px-4 py-3 text-[11px] text-draft-700 leading-relaxed">
            Development: <code className="ident">npm run seed:dev</code> creates
            <code className="ident mx-1">ops@tapvera.example.com</code> holding SUPER_ADMIN,
            PLATFORM_OPS and PLATFORM_FINANCE — the three roles this console needs between them.
            The seed prints the password.
          </p>
        ) : null}
      </div>
    </div>
  );
}
