/**
 * The console's component kit.
 *
 * Denser and plainer than the customer app's. This is an internal tool used by
 * people who will use it hundreds of times: legibility and predictability beat
 * delight, and every control says what it does in words rather than an icon.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

import { ApiError, type EntityStatus } from './api';
import { theme } from './theme';

// =============================================================================
// Status — the vocabulary of the whole app
// =============================================================================

/**
 * The four states, in the words the console uses for them.
 *
 * The database calls them DRAFT / ACTIVE / SUSPENDED / INACTIVE. Those are
 * accurate and, on a screen, unhelpful: "inactive" and "suspended" are near
 * synonyms in English and opposites here — one is reversible and one is not.
 *
 * So the UI says something the reader can act on. The database word is kept as
 * a `title` for anyone cross-referencing a SQL query or an audit row.
 */
export const STATUS: Record<
  EntityStatus,
  { label: string; tone: 'draft' | 'live' | 'held' | 'closed'; hint: string }
> = {
  DRAFT: {
    label: 'Onboarding',
    tone: 'draft',
    hint: 'Not taking orders yet. Finish the checklist to go live.',
  },
  ACTIVE: { label: 'Live', tone: 'live', hint: 'Taking orders now.' },
  SUSPENDED: {
    label: 'On hold',
    tone: 'held',
    hint: 'Temporarily stopped. Can be put back live.',
  },
  INACTIVE: {
    label: 'Closed',
    tone: 'closed',
    hint: 'Left the court. Coming back means onboarding again.',
  },
};

export function StatusPill({ status }: { status: EntityStatus }) {
  const s = STATUS[status];
  const tones = {
    draft: 'bg-draft-50 text-draft-700',
    live: 'bg-live-50 text-live-700',
    held: 'bg-held-50 text-held-700',
    closed: 'bg-closed-50 text-closed-700',
  } as const;

  return (
    <span
      title={status}
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[12px] font-semibold ${tones[s.tone]}`}
    >
      {/* A dot as well as the colour, so the four states differ by shape in a
          greyscale print or to a colourblind reader. */}
      <span aria-hidden className={`size-1.5 rounded-full bg-current`} />
      {s.label}
    </span>
  );
}

// =============================================================================
// Shell
// =============================================================================

export function ThemeToggle() {
  const mode = useSyncExternalStore(theme.subscribe, theme.get, theme.get);
  const next = mode === 'light' ? 'dark' : 'light';

  return (
    <button
      onClick={() => theme.set(next)}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      className="pressable glass-hover size-9 grid place-items-center rounded-lg text-ink-500"
    >
      {mode === 'light' ? (
        <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden>
          <path
            d="M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden>
          <circle cx="12" cy="12" r="4.2" stroke="currentColor" strokeWidth="1.8" />
          <path
            d="M12 2.5v2.2M12 19.3v2.2M21.5 12h-2.2M4.7 12H2.5M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6M18.7 18.7l-1.6-1.6M6.9 6.9L5.3 5.3"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      )}
    </button>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={`bg-surface rounded-card shadow-card ${className ?? ''}`}>{children}</div>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  type,
  variant = 'primary',
  full,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: 'button' | 'submit';
  variant?: 'primary' | 'secondary' | 'danger';
  full?: boolean;
}) {
  const styles = {
    primary: 'bg-brand-fill text-on-brand',
    secondary: 'bg-surface border border-ink-200 text-ink-800',
    // Outlined, not filled. A destructive action should be reachable without
    // being the loudest thing on the screen — a solid red button next to a
    // solid brand button is two shouts and no hierarchy.
    danger: 'bg-surface border border-held-500 text-held-700',
  } as const;

  return (
    <button
      type={type ?? 'button'}
      onClick={onClick}
      disabled={disabled}
      className={`pressable glass-hover rounded-lg px-4 py-2 text-[13px] font-semibold disabled:opacity-45
                  ${full ? 'w-full' : ''} ${styles[variant]}`}
    >
      {children}
    </button>
  );
}

/**
 * A labelled field.
 *
 * `hint` sits UNDER the input, not above it. Above, it competes with the label
 * for the same glance; below, it is where the eye already is after typing —
 * which is also where a validation message would appear, so the two never
 * fight for position.
 */
export function Field({
  label,
  hint,
  children,
  required,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="block text-[12px] font-semibold text-ink-700 mb-1">
        {label}
        {required ? (
          <span className="text-held-500 ml-0.5" aria-label="required">
            *
          </span>
        ) : (
          <span className="text-ink-400 font-normal ml-1.5">optional</span>
        )}
      </span>
      {children}
      {hint ? <span className="block text-[11px] text-ink-500 mt-1 leading-relaxed">{hint}</span> : null}
    </label>
  );
}

export function Input({
  value,
  onChange,
  placeholder,
  mono,
  maxLength,
  type,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** Identifiers people transcribe by eye. See `.ident` in index.css. */
  mono?: boolean;
  maxLength?: number;
  type?: 'text' | 'password' | 'email' | 'number';
  disabled?: boolean;
}) {
  return (
    <input
      type={type ?? 'text'}
      value={value}
      disabled={disabled}
      maxLength={maxLength}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-[13px]
                  text-ink-900 placeholder:text-ink-400 outline-none
                  focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20
                  disabled:bg-ink-50 disabled:text-ink-500 ${mono ? 'ident' : ''}`}
    />
  );
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: T | '';
  onChange: (v: T | '') => void;
  options: readonly (readonly [T, string])[];
  placeholder?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T | '')}
      className="w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-[13px]
                 text-ink-900 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
    >
      <option value="">{placeholder ?? 'Not set'}</option>
      {options.map(([v, label]) => (
        <option key={v} value={v}>
          {label}
        </option>
      ))}
    </select>
  );
}

// =============================================================================
// Dialogs
// =============================================================================

/**
 * The console's dialog.
 *
 * WHAT THIS REPLACED, AND WHY IT HAD TO GO
 *
 * `window.prompt`, `window.confirm` and `window.alert` — nine call sites across
 * three screens. They are the last OS chrome in the product and they cannot be
 * themed at all, which is the visible problem. The behavioural problems are
 * worse:
 *
 * THEY APPEAR NOWHERE NEAR THE BUTTON. A Chrome prompt drops from the top of
 * the window, detached from the row you clicked, so on a list of twelve
 * stalls it does not say WHICH one you are about to suspend.
 *
 * THEY VALIDATE BY RE-ASKING. The old flow was: prompt → too short → alert →
 * dismissed → nothing happened, and whatever you had typed is gone. You start
 * again with no idea what "long enough" means.
 *
 * THEY BLOCK THE MAIN THREAD. Every query in the console stops polling for as
 * long as the prompt is open.
 *
 * THEY CANNOT SHOW THE CONSEQUENCE. Replacing a QR invalidates every printed
 * poster in a venue. That sentence has to be readable at the moment of the
 * decision, and a prompt gives you one line of unstyled text.
 */
export function Modal({
  title,
  onClose,
  children,
  size = 'sm',
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  size?: 'sm' | 'md';
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);

    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  const titleId = `dialog-${title.replace(/\W+/g, '-').toLowerCase()}`;

  return (
    <div
      className="fixed inset-0 z-40 grid place-items-center p-4 bg-scrim"
      // Scrim only — `onClick` on the wrapper fires for clicks inside the panel
      // too, which would dismiss a half-typed reason on a stray click.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`w-full ${size === 'sm' ? 'max-w-md' : 'max-w-lg'} max-h-[calc(100dvh-2rem)]
                    overflow-y-auto rounded-card bg-surface shadow-dialog p-5`}
      >
        <h2 id={titleId} className="text-[16px] font-bold text-ink-900 leading-tight">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

/**
 * "Why are you doing this?" — the console's single most repeated interaction.
 *
 * Suspending a court, closing one, issuing a QR, replacing one, revoking one,
 * revoking a stall login. Every one of them writes an audit row that cannot be
 * edited afterwards, so every one of them asks for a reason first.
 *
 * THE TEN-CHARACTER RULE IS SHOWN, NOT ENFORCED BY REJECTION.
 *
 * The old prompt accepted anything, then threw it away with an alert. Here the
 * button is simply disabled until the reason is long enough, and the counter
 * says how much further there is to go. Same rule, but the person can see it
 * before they have lost their typing — and "ten characters" stops being a
 * trivia question.
 *
 * `consequence` is for the irreversible ones. It renders as a warn panel above
 * the field, which is the second `window.confirm` the QR panel used to stack in
 * front of its prompt — one dialog now, saying both things.
 */
export function ReasonDialog({
  title,
  prompt,
  consequence,
  confirmLabel,
  tone = 'primary',
  pending,
  onCancel,
  onConfirm,
}: {
  title: string;
  /** What the reason is FOR, in one line. */
  prompt: string;
  /** Irreversible effects, stated before the field. */
  consequence?: string;
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  pending?: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  // Focus the field on open. A dialog that requires typing and does not put the
  // cursor in the only field costs a click every single time, and this is the
  // interaction the console repeats more than any other.
  useEffect(() => {
    ref.current?.focus();
  }, []);

  const trimmed = reason.trim();
  const short = Math.max(0, 10 - trimmed.length);
  const ready = short === 0 && !pending;

  return (
    <Modal title={title} onClose={onCancel}>
      <p className="text-[12px] text-ink-500 mt-1 leading-relaxed">{prompt}</p>

      {consequence ? (
        <p className="mt-3 rounded-lg border border-draft-500 bg-draft-50 px-3 py-2.5 text-[12px] text-draft-700 leading-relaxed">
          {consequence}
        </p>
      ) : null}

      <textarea
        ref={ref}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={3}
        maxLength={280}
        placeholder="Licence expired on 14 March; owner notified twice."
        // Enter submits when it is allowed to. Shift+Enter still makes a new
        // line, and the form is one field, so this is the fast path for the
        // person doing eleven of these in a row.
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && ready) {
            e.preventDefault();
            onConfirm(trimmed);
          }
        }}
        className="mt-3 w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-[13px]
                   text-ink-900 placeholder:text-ink-400 outline-none resize-y
                   focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
      />

      <div className="flex items-center justify-between gap-3 mt-1.5">
        <p className="text-[11px] text-ink-500">
          {short > 0
            ? `${short} more character${short === 1 ? '' : 's'} — a date alone is not a reason.`
            : 'Goes in the audit log. It cannot be edited later.'}
        </p>
      </div>

      <div className="flex gap-2 mt-4">
        <Button onClick={() => onConfirm(trimmed)} disabled={!ready} variant={tone}>
          {pending ? 'Working…' : confirmLabel}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={pending ?? false}>
          Cancel
        </Button>
      </div>
    </Modal>
  );
}

// =============================================================================
// Feedback
// =============================================================================

export function Spinner({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-3" role="status">
      <div className="size-7 rounded-full border-[3px] border-ink-200 border-t-brand-500 motion-safe:animate-spin" />
      <p className="text-[13px] text-ink-500">{label}</p>
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="py-16 text-center px-6">
      <p className="text-[15px] font-bold text-ink-900">{title}</p>
      <p className="text-[13px] text-ink-500 mt-1.5 max-w-sm mx-auto leading-relaxed">{body}</p>
      {action ? <div className="mt-5 inline-block">{action}</div> : null}
    </div>
  );
}

/**
 * Errors, by CODE.
 *
 * `VENDOR_CLOSED` gets special treatment because the server sends it when the
 * §5.2 gate refuses an activation, and its message is a list of what is still
 * missing. That is the most useful error this console can produce, so it is
 * shown verbatim rather than replaced with a generic line.
 */
export function ErrorNote({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const api = error instanceof ApiError ? error : null;

  const copy: Record<string, string> = {
    NETWORK: 'Cannot reach the server. Is the API running on port 3000?',
    TIMEOUT: 'The server did not answer in time.',
    INVALID_CREDENTIALS: 'That email and password do not match.',
    ACCOUNT_SUSPENDED: 'This account is not active, or has no role assigned.',
    TOKEN_INVALID: api?.message ?? 'This account cannot do that.',
    INVALID_TRANSITION: api?.message ?? 'That change is not allowed from here.',
    VENDOR_CLOSED: api?.message ?? 'This stall is not ready to take orders.',
    CROSS_VENDOR_CART: api?.message ?? 'That name is already taken here.',
    QR_INVALID: 'Not found. It may have been removed.',
  };

  const message = (api && copy[api.code]) ?? api?.message ?? 'Something went wrong.';

  return (
    <div
      role="alert"
      className="rounded-lg border border-held-500 bg-held-50 px-4 py-3 flex items-start gap-3"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-semibold text-held-700">{message}</span>
        {api && api.code !== 'NETWORK' ? (
          <span className="block text-[11px] text-held-700/70 mt-0.5 ident">{api.code}</span>
        ) : null}
      </span>
      {onRetry ? (
        <button
          onClick={onRetry}
          className="pressable shrink-0 text-[12px] font-bold text-held-700 underline"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}
