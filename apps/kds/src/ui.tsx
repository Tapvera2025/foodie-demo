/**
 * The two pieces of chrome the board and the sign-in screen both need.
 *
 * This file exists because `ThemeToggle` was defined privately inside
 * `Board.tsx`, which meant the light/dark switch was BEHIND the login — and the
 * one situation the light theme exists for is a tablet on a counter under a
 * skylight, where a dark screen is a mirror and the sign-in form is the first
 * thing nobody can read. A control that fixes an unreadable screen is no use if
 * you have to read the screen to reach it.
 *
 * Kept small on purpose. The board's own components stay in `Board.tsx` — this
 * is not a component library, it is the shared edge between two screens.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import { theme } from './theme';
import { uploadImage, type UploadKind } from './upload';

/**
 * Light / dark.
 *
 * `useSyncExternalStore` for the same reason the auth store uses it: the theme
 * also lives on `<html>` and in localStorage, and this app has already been
 * bitten once by keeping a second copy of a truth in React state.
 *
 * The target is 48px square even though the icon inside it is 24 — everything
 * on this screen is sized for someone with wet or gloved hands, and a 24px hit
 * area is a control only a mouse can use.
 *
 * The `aria-label` says what it will DO, not what the state IS. "Switch to
 * light mode" is actionable; "Dark mode: on" makes a screen-reader user work
 * out the consequence themselves.
 */
export function ThemeToggle() {
  const mode = useSyncExternalStore(theme.subscribe, theme.get, theme.get);
  const next = mode === 'dark' ? 'light' : 'dark';

  return (
    <button
      type="button"
      onClick={() => theme.set(next)}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      className="pressable glass-hover size-12 grid place-items-center rounded-xl text-shell-400
                  hover:text-shell-100"
    >
      {mode === 'dark' ? (
        // Sun: the thing you would be switching TO.
        <svg viewBox="0 0 24 24" className="size-6" fill="none" aria-hidden>
          <circle cx="12" cy="12" r="4.2" stroke="currentColor" strokeWidth="1.8" />
          <path
            d="M12 2.5v2.2M12 19.3v2.2M21.5 12h-2.2M4.7 12H2.5M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6M18.7 18.7l-1.6-1.6M6.9 6.9L5.3 5.3"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" className="size-6" fill="none" aria-hidden>
          <path
            d="M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
}

/**
 * The wordmark, in the display serif.
 *
 * The SAME lockup the console shows in its sidebar and the customer app carries
 * on its stall list: serif name, uppercase eyebrow underneath naming which
 * surface you are on. Three apps, three audiences, one product — and the only
 * place a cook ever sees the product's name is here, because the board itself is
 * all tickets.
 *
 * `leading-none` because a serif at 34px sets with enough internal leading
 * already; the default line-height puts a visible gap between the name and the
 * eyebrow that reads as two unrelated lines.
 */
export function Wordmark({ surface }: { surface: string }) {
  return (
    <div>
      <p className="display text-[34px] text-shell-100 leading-none">Foodie</p>
      <p className="eyebrow text-[10px] text-shell-400 mt-2">{surface}</p>
    </div>
  );
}

// =============================================================================
// Image picker
// =============================================================================

/**
 * Choosing an image, three ways.
 *
 * ============================================================================
 * WHY ALL THREE, AND NOT JUST A BUTTON
 * ============================================================================
 *
 * This one control is used on two very different machines and the natural
 * gesture is different on each:
 *
 * TAP a mounted kitchen tablet. There is no cursor to drag with and
 * no keyboard to paste from — the file picker, which opens the
 * camera on Android and iPadOS, is the only route that exists.
 * DROP an owner doing the menu properly on a laptop, with a folder of
 * photographs open beside the browser.
 * PASTE the commonest one, and the one usually missing. A stall owner
 * has the photo in WhatsApp Web or a supplier's email. Copy,
 * paste. Making them save it to disk first is a step that exists
 * only because the form did not think of them.
 *
 * PASTE ACCEPTS A URL TOO, deliberately. The field this replaces was a URL box,
 * and somebody who already hosts their images somewhere should not lose that
 * path just because uploading arrived. Pasting text that looks like a URL uses
 * it; pasting an image uploads it. One gesture, and the control works out which
 * was meant.
 */
export function ImagePicker({
  value,
  kind,
  label,
  hint,
  onChange,
}: {
  value: string | null;
  kind: UploadKind;
  label: string;
  hint?: string;
  onChange: (url: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [showUrl, setShowUrl] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const take = useCallback(
    async (file: File) => {
      setBusy(true);
      setError(null);
      try {
        onChange(await uploadImage(file, kind));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'That upload did not work.');
      } finally {
        setBusy(false);
      }
    },
    [kind, onChange],
  );

  /**
   * Paste, bound to the WINDOW rather than to the drop zone.
   *
   * `onPaste` on a div only fires when that div has focus, and a div is not
   * focusable — so the obvious implementation silently never runs. Binding to
   * the window is what makes Cmd-V work the way somebody expects it to, and the
   * listener is torn down with the component.
   *
   * Guarded on `busy` so a second paste mid-upload does not start a race whose
   * loser overwrites the winner.
   */
  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      if (busy) return;

      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
      if (file) {
        e.preventDefault();
        void take(file);
        return;
      }

      // Not an image — a URL is the other thing people paste here, and it is
      // what this field used to be.
      const text = e.clipboardData?.getData('text')?.trim() ?? '';
      if (/^https?:\/\/\S+$/i.test(text)) {
        e.preventDefault();
        setError(null);
        onChange(text);
      }
    };

    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [busy, take, onChange]);

  return (
    <div>
      <span className="block text-[13px] font-semibold text-shell-300 mb-1.5">{label}</span>

      {value ? (
        <div className="flex items-start gap-3">
          <img
            src={value}
            alt=""
            className="h-24 w-40 shrink-0 rounded-xl object-cover bg-shell-900 border border-shell-700"
          />
          <div className="min-w-0 flex-1">
            <p className="ident text-[11px] text-shell-400 break-all line-clamp-2">{value}</p>
            <div className="flex gap-2 mt-2">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={busy}
                className="pressable glass-hover h-9 rounded-lg border border-shell-700 px-3 text-[12px] font-semibold text-shell-300 disabled:opacity-50"
              >
                {busy ? 'Uploading…' : 'Replace'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  onChange(null);
                }}
                className="pressable glass-hover h-9 rounded-lg px-3 text-[12px] font-semibold text-shell-400"
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      ) : (
        /*
          A BUTTON, not a div with a click handler.
          It is keyboard-reachable, it announces itself, and Enter opens the
          file picker — none of which a div gets for free, and all of which
          somebody using this with a bluetooth keypad beside a mounted tablet
          depends on.
        */
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => {
            // Without preventDefault the browser navigates to the file and the
            // drop never fires. The single commonest drag-and-drop bug.
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
            if (file) void take(file);
            else setError('That was not an image file.');
          }}
          disabled={busy}
          className={`w-full rounded-xl border border-dashed px-4 py-6 text-center transition-colors ${
            dragging
              ? 'border-go-500 bg-go-500/10'
              : 'border-shell-600 bg-shell-900 hover:border-shell-400'
          } disabled:opacity-60`}
        >
          {busy ? (
            <span className="text-[14px] font-semibold text-shell-300">Uploading…</span>
          ) : (
            <>
              <svg
                viewBox="0 0 24 24"
                className="size-7 mx-auto text-shell-400"
                fill="none"
                aria-hidden
              >
                <path
                  d="M12 16V4m0 0L8 8m4-4l4 4"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
              <span className="block text-[14px] font-semibold text-shell-100 mt-2">
                Add a photo
              </span>
              {/* The three gestures, named. A drop zone that does not say it
                  accepts a paste is one nobody pastes into. */}
              <span className="block text-[12px] text-shell-400 mt-1">
                Tap to choose · drag one here · or paste
              </span>
            </>
          )}
        </button>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Cleared so choosing the SAME file twice fires `change` again —
          // otherwise a failed upload cannot be retried with the same photo.
          e.target.value = '';
          if (file) void take(file);
        }}
      />

      {error ? (
        <p role="alert" className="text-[12px] text-late-500 mt-2 leading-relaxed">
          {error}
        </p>
      ) : null}

      {hint && !error ? (
        <p className="text-[12px] text-shell-400 mt-2 leading-relaxed">{hint}</p>
      ) : null}

      {/*
        The URL box survives, one click away.
        It is how every image got here before uploading existed, and somebody
        who hosts their own photographs should not lose that because a nicer
        path arrived. Collapsed, because it is now the rarer of the two.
      */}
      {!value ? (
        <button
          type="button"
          onClick={() => setShowUrl((x) => !x)}
          className="pressable text-[12px] font-semibold text-shell-400 underline mt-2"
        >
          {showUrl ? 'Hide the link box' : 'Paste a link instead'}
        </button>
      ) : null}

      {showUrl && !value ? (
        <input
          type="url"
          inputMode="url"
          placeholder="https://…"
          onChange={(e) => {
            const v = e.target.value.trim();
            if (v === '' || /^https?:\/\/\S+$/i.test(v)) onChange(v === '' ? null : v);
          }}
          className="mt-2 w-full h-11 rounded-xl border border-shell-700 bg-shell-900 px-3.5 text-[14px]
                     text-shell-100 placeholder:text-shell-400 outline-none focus:border-brand-400"
        />
      ) : null}
    </div>
  );
}

// =============================================================================
// Modal
// =============================================================================

/**
 * One dialog, used by both overlays in this app.
 *
 * WHAT THE HAND-ROLLED VERSIONS WERE MISSING
 *
 * Both were `<div className="fixed inset-0 …">` with a panel inside, and each
 * was missing the same four things — which is the argument for a primitive
 * rather than a third copy:
 *
 * ESCAPE the universal way out of a dialog, and the only one a
 * keyboard user has. Neither overlay listened for it.
 * SCROLL LOCK without it the page behind scrolls under your finger
 * while the dialog stays put, which on a tablet feels like
 * the app has come apart.
 * DIALOG SEMANTICS `role="dialog"` + `aria-modal` + a labelled title.
 * Without them a screen reader keeps reading the board
 * behind, and never announces that anything opened.
 * A STICKY FOOTER the dish editor is six fields tall. Its Save button sat
 * at the bottom of a scrolling column, so on a short
 * landscape tablet you scrolled past the thing you came to
 * press. The footer is now pinned and the BODY scrolls.
 *
 * THE PANEL IS A GRID, AND THAT IS WHAT MAKES THE FOOTER WORK
 *
 * `grid-rows-[auto_1fr_auto]` gives the body the leftover height and lets it be
 * the only scroller. `max-h-[calc(100dvh-2rem)]` caps the whole panel against
 * the VISIBLE viewport — `dvh` rather than `vh` because a tablet browser's
 * collapsing toolbar makes `vh` taller than the screen, which is exactly how a
 * footer ends up under the fold.
 */
export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  size = 'md',
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  /** Pinned to the bottom of the panel. Never scrolls away. */
  footer?: ReactNode;
  /** `md` for a form, `sm` for a short list of choices. */
  size?: 'sm' | 'md';
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);

    // Restore the PREVIOUS value rather than assuming it was ''. Two dialogs
    // open in sequence would otherwise leave the page unlocked when the first
    // one closes.
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
      className="fixed inset-0 z-30 grid place-items-center p-4 bg-scrim"
      // Closes on the SCRIM only. `onClick` on the wrapper would fire for any
      // click inside the panel too, so a stray tap on a label would dismiss a
      // half-filled form.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`grid grid-rows-[auto_1fr_auto] w-full ${
          size === 'sm' ? 'max-w-md' : 'max-w-xl'
        } max-h-[calc(100dvh-2rem)] rounded-card border border-shell-700 bg-shell-800
           overflow-hidden`}
      >
        <div className="flex items-start gap-3 px-5 pt-5 pb-4 border-b border-shell-700">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-[19px] font-bold text-shell-100 leading-tight">
              {title}
            </h2>
            {subtitle ? (
              <p className="text-[13px] text-shell-400 mt-1 leading-relaxed">{subtitle}</p>
            ) : null}
          </div>

          {/* 44px, and an X rather than the word "Close" — the footer already
              carries a labelled Cancel, so this is the redundant escape for
              somebody who reaches for the corner. */}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="pressable glass-hover -mr-1.5 -mt-1 size-11 shrink-0 grid place-items-center rounded-xl
                       text-shell-400 hover:text-shell-100"
          >
            <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden>
              <path
                d="M6 6l12 12M18 6L6 18"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-5">{children}</div>

        {footer ? (
          <div className="px-5 py-4 border-t border-shell-700 bg-shell-800">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}
