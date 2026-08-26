import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from './api';
import { Button, Card, ErrorNote, ReasonDialog } from './ui';

/** Which of the three reason-taking actions is open. */
type Ask = 'issue' | 'replace' | 'revoke';

/**
 * The venue's QR code.
 *
 * WHY THIS PANEL EXISTS
 *
 * A court created from the console is ACTIVE with no token — the platform
 * recognises the venue and nobody can enter it. Those two facts look identical
 * on a row that shows only status, and the symptom is the confusing one: the
 * court simply does not appear in the customer app, because `GET dev/courts`
 * filters on `qr_token IS NOT NULL`. Nothing errors. It is just missing.
 *
 * WHAT IS AND IS NOT HERE
 *
 * The URL, copyable, and the two actions. There is **no rendered QR image** —
 * generating the printed asset is a separate job with real constraints that
 * `src/tenancy/qr.ts` already documents: error correction level H (these live
 * on tables and collect grease and scratches), a 35mm minimum symbol, and a
 * four-module quiet zone. Rendering a canvas here at whatever size the layout
 * gave it would produce something that looks right on screen and fails to scan
 * on a poster, which is worse than producing nothing.
 *
 * So: the URL is the deliverable, and whoever does the printing encodes it to
 * those parameters.
 */
export function CourtQr({ courtId }: { courtId: string }) {
  const qc = useQueryClient();

  const q = useQuery({ queryKey: ['qr', courtId], queryFn: () => api.qr(courtId) });

  const after = (state: unknown): void => {
    qc.setQueryData(['qr', courtId], state);
    // The court list shows a "no QR" badge, and the detail page reads `hasQr`.
    void qc.invalidateQueries({ queryKey: ['courts'] });
    void qc.invalidateQueries({ queryKey: ['court', courtId] });
  };

  const issue = useMutation({
    mutationFn: (v: { reason: string; replace: boolean }) =>
      api.issueQr(courtId, v.reason, v.replace),
    onSuccess: after,
  });

  const revoke = useMutation({
    mutationFn: (reason: string) => api.revokeQr(courtId, reason),
    onSuccess: after,
  });

  /**
   * Which reason is being asked for, or null.
   *
   * Replacing used to be TWO native dialogs stacked in front of each other — a
   * `window.confirm` stating the consequence, then a `window.prompt` for the
   * reason. Two modal interruptions for one decision, the first of which you
   * dismiss before you can read the second. `ReasonDialog` puts the consequence
   * above the field, so it is still on screen while the reason is being typed.
   */
  const [asking, setAsking] = useState<Ask | null>(null);

  const s = q.data;
  const busy = issue.isPending || revoke.isPending;

  const ASKS: Record<
    Ask,
    { title: string; prompt: string; consequence?: string; label: string; danger: boolean }
  > = {
    issue: {
      title: 'Why is a QR being issued for this court?',
      prompt: 'The venue becomes reachable to customers as soon as this is done.',
      label: 'Issue the QR',
      danger: false,
    },
    replace: {
      title: 'Why is this QR being replaced?',
      prompt: 'A new token is generated and the old one stops resolving.',
      consequence:
        'Every printed poster and sticker in this venue stops working immediately. Customers already mid-order are unaffected.',
      label: 'Replace it',
      danger: true,
    },
    revoke: {
      title: 'Why is this QR being revoked?',
      prompt: 'The court stays as it is; only the way in disappears.',
      consequence:
        'Nobody can scan into this venue afterwards, and it stops appearing in the customer app entirely.',
      label: 'Revoke it',
      danger: true,
    },
  };

  return (
    <Card className="p-4 mb-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="display text-[17px] text-ink-900">Venue QR code</h3>
          <p className="text-[12px] text-ink-500 mt-0.5 leading-relaxed">
            One code for the whole court — printed on posters and stall fronts, never per table.
          </p>
        </div>

        <div className="flex gap-2 shrink-0">
          {s && !s.token ? (
            <Button disabled={busy} onClick={() => setAsking('issue')}>
              {issue.isPending ? 'Issuing…' : 'Issue a QR'}
            </Button>
          ) : null}

          {s?.token ? (
            <>
              <Button variant="secondary" disabled={busy} onClick={() => setAsking('replace')}>
                Replace
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => setAsking('revoke')}>
                Revoke
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {q.isError ? (
        <div className="mt-3">
          <ErrorNote error={q.error} onRetry={() => void q.refetch()} />
        </div>
      ) : null}
      {issue.isError ? (
        <div className="mt-3">
          <ErrorNote error={issue.error} />
        </div>
      ) : null}
      {revoke.isError ? (
        <div className="mt-3">
          <ErrorNote error={revoke.error} />
        </div>
      ) : null}

      {s && !s.token ? (
        <p className="mt-3 rounded-lg border border-dashed border-draft-500 bg-draft-50 px-3 py-2.5 text-[12px] text-draft-700 leading-relaxed">
          No code yet, so <strong>nothing can scan into this court</strong> — it will not appear in
          the customer app at all. Issue one to make the venue reachable.
        </p>
      ) : null}

      {s?.token ? (
        <div className="mt-3">
          {/*
            One sentence answering "would a customer get in right now".
            A token on a suspended court resolves to QR_INVALID exactly like no
            token, so showing "QR: issued" beside "Court: on hold" would be two
            true facts and the wrong answer.
          */}
          {!s.scannable ? (
            <p className="mb-3 rounded-lg bg-draft-50 px-3 py-2 text-[12px] text-draft-700 leading-relaxed">
              This code exists but will not let anyone in — the court is{' '}
              {s.courtStatus.toLowerCase()}. Put the court back live to make it work.
            </p>
          ) : null}

          <div className="rounded-lg border border-ink-200 bg-ink-50 p-3">
            <div className="text-[11px] text-ink-500 mb-1">Encode this URL on the poster</div>
            <div className="ident text-[12px] text-ink-900 break-all">{s.url}</div>
          </div>

          <div className="flex flex-wrap items-center gap-2 mt-2">
            <Button
              variant="secondary"
              onClick={() => void navigator.clipboard?.writeText(s.url ?? '')}
            >
              Copy URL
            </Button>
            <a
              href={s.url ?? '#'}
              target="_blank"
              rel="noreferrer"
              className="pressable glass-hover rounded-lg border border-ink-200 bg-surface px-4 py-2 text-[13px] font-semibold text-ink-800"
            >
              Open as a customer
            </a>
          </div>

          {/*
            The printing constraints, stated where somebody is about to print.
            From src/tenancy/qr.ts — level H because these collect grease and
            scratches on a table, and a quiet zone because its absence is the
            commonest cause of a code that will not scan.
          */}
          <p className="text-[11px] text-ink-500 mt-3 leading-relaxed">
            When printing: error correction <strong>level H</strong>, at least{' '}
            <strong>35mm</strong> square (40mm preferred), with a{' '}
            <strong>four-module quiet zone</strong> on every side. These are not cosmetic — a code
            on a food-court table collects grease and scratches, and a missing quiet zone is the
            commonest reason a symbol will not scan.
          </p>
        </div>
      ) : null}

      {asking ? (
        <ReasonDialog
          title={ASKS[asking].title}
          prompt={ASKS[asking].prompt}
          {...(ASKS[asking].consequence ? { consequence: ASKS[asking].consequence! } : {})}
          confirmLabel={ASKS[asking].label}
          tone={ASKS[asking].danger ? 'danger' : 'primary'}
          pending={busy}
          onCancel={() => setAsking(null)}
          onConfirm={(reason) => {
            if (asking === 'revoke') revoke.mutate(reason);
            else issue.mutate({ reason, replace: asking === 'replace' });
            setAsking(null);
          }}
        />
      ) : null}
    </Card>
  );
}
