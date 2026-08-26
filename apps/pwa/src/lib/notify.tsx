/**
 * In-app notifications.
 *
 * WHAT THIS IS AND IS NOT
 *
 * This is the layer that turns a state CHANGE into something a person notices.
 * It is not the notification *engine* — that lives on the server
 * (`src/notify/`) and owns WhatsApp, SMS and the dedupe ledger, for the case
 * where the customer has put their phone away. This is the case where they are
 * looking at the screen, and it is the fastest and most reliable channel we
 * have, because it needs no registration, no permission prompt and no DLT.
 *
 * WHY IT WATCHES DATA RATHER THAN LISTENING FOR EVENTS
 *
 * PRD CUS-TRK-04 says the client re-fetches authoritative state and never
 * derives state from an event stream. So the trigger is a diff: the previous
 * status we rendered versus the one that just arrived. That property is what
 * makes this correct under a socket layer too — when sockets land they will
 * invalidate the query, the query will refetch, and this diff will fire exactly
 * as it does now. Nothing here has to be rewritten for that, which is the whole
 * reason it is built this way round.
 *
 * A toast fires only on a TRANSITION, never on a state. Rendering "your food is
 * ready" every four seconds because the status is still READY is how people
 * learn to ignore notifications.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type ToastTone = 'good' | 'info' | 'warn' | 'bad';

export interface Toast {
  id: number;
  title: string;
  body?: string;
  tone: ToastTone;
  /** Milliseconds. `null` stays until dismissed — used for "ready to collect". */
  ttl: number | null;
  onClick?: () => void;
}

interface ToastApi {
  push: (t: Omit<Toast, 'id'>) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast outside ToastProvider');
  return ctx;
}

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (t: Omit<Toast, 'id'>) => {
      const id = nextId++;
      // Three at a time. A stack taller than that covers the screen it is
      // trying to annotate, and the oldest is the least relevant.
      setToasts((ts) => [...ts.slice(-2), { ...t, id }]);
      if (t.ttl !== null) setTimeout(() => dismiss(id), t.ttl);
    },
    [dismiss],
  );

  const api = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastHost toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

/**
 * Toast tones.
 *
 * `info` used to be `bg-ink-900 text-white` — a black slab dropped onto a light
 * page, which is the one anti-pattern the redesign audit names by hand. It also
 * inverted itself in dark mode into a white slab, which is worse.
 *
 * It is now a normal surface with a brand-coloured left edge, so it reads as
 * part of the app in both themes. The three tones that DO carry urgency keep a
 * filled colour, because a "your food is ready" toast has to be seen from the
 * corner of the eye and a tinted card is not enough for that.
 */
const TONES: Record<ToastTone, string> = {
  /*
   * The banner tokens, not the status colours.
   *
   * The obvious mapping — `bg-fresh-500 text-white` and friends — was 3.19:1
   * for "your food is ready" and 2.16:1 for a warning. That is the single most
   * important message this product sends, failing AA by a wide margin, on a
   * phone held at arm's length in a bright hall.
   *
   * These are the same four tokens the tracking screen's header uses, which has
   * a second benefit: the toast that announces a state and the screen it opens
   * are the same colour, so tapping one leads somewhere that looks like it.
   */
  good: 'bg-banner-ready text-on-banner',
  info: 'bg-surface text-ink-900 border-l-4 border-brand-500',
  warn: 'bg-banner-attention text-on-banner',
  bad: 'bg-banner-alert text-on-banner',
};

/**
 * A mark per tone, in a translucent circle.
 *
 * The toast was a wall of text, and at a glance every state looked the same —
 * the colour did all the work, which is exactly what WCAG 1.4.1 says colour
 * must not be asked to do alone. A tick, a clock and a warning triangle are
 * distinguishable before a word is read, and they survive a greyscale screen
 * and the roughly one in twelve men with a colour vision deficiency.
 */
function ToneIcon({ tone }: { tone: ToastTone }) {
  const path =
    tone === 'good'
      ? 'M5 12l5 5L19 8'
      : tone === 'bad'
        ? 'M6 6l12 12M18 6L6 18'
        : tone === 'warn'
          ? 'M12 8v5M12 16.5v.01'
          : 'M12 7.5V12l3 1.8';

  return (
    <span
      aria-hidden
      className={`size-9 shrink-0 grid place-items-center rounded-full ${
        tone === 'info' ? 'bg-brand-50 text-brand-700' : 'bg-white/20 text-current'
      }`}
    >
      <svg viewBox="0 0 24 24" className="size-[18px]" fill="none">
        {/* `info` is a clock — these are all "your order moved", and time is
            what the customer is actually waiting on. */}
        {tone === 'info' ? (
          <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.9" />
        ) : null}
        {tone === 'warn' ? (
          <path
            d="M12 3.5L21 19H3L12 3.5z"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinejoin="round"
          />
        ) : null}
        <path d={path} stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function ToastHost({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;

  return (
    <div
      /*
       * TOP, not bottom. The bottom of a phone is where the cart bar, the pay
       * button and the home indicator live — a toast there covers the control
       * the customer is reaching for at exactly the moment they reach for it.
       *
       * CAPPED AND CENTRED, not edge-to-edge. It used to be `inset-x-0`, so on
       * a laptop a "your food is ready" stretched across 2000px while every
       * other pixel of the app sat inside a 70rem frame. It read as browser
       * chrome rather than as the app talking.
       *
       * `aria-live="assertive"` because these are time-sensitive: "your food is
       * ready" interrupting a screen reader is correct, and "polite" would
       * queue it behind whatever is being read.
       */
      className="fixed inset-x-0 top-0 z-50 px-3 pt-3 safe-top pointer-events-none"
      role="alert"
      aria-live="assertive"
    >
      <div className="mx-auto w-full max-w-[26rem] space-y-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast-in pointer-events-auto flex items-center gap-3 rounded-card shadow-card
                        pl-3.5 pr-2 py-3 ${TONES[t.tone]}`}
          >
            <ToneIcon tone={t.tone} />

            {/*
              THE BODY IS THE BUTTON, AND THE X IS SEPARATE.

              The whole toast used to be one button that both opened the order
              and dismissed the toast — so there was no way to dismiss without
              navigating, and no way to navigate without losing the message. A
              customer glancing at "ready" and tapping to clear it was taken to
              a screen they did not ask for, mid-scroll through a menu.
            */}
            <button
              onClick={() => {
                t.onClick?.();
                onDismiss(t.id);
              }}
              className="pressable min-w-0 flex-1 text-left"
            >
              <span className="block font-bold text-[15px] leading-snug">{t.title}</span>
              {t.body ? (
                <span className="block text-[13px] opacity-90 mt-0.5 leading-snug">{t.body}</span>
              ) : null}
            </button>

            <button
              onClick={() => onDismiss(t.id)}
              aria-label="Dismiss"
              // 40px. Small enough not to compete with the message, large
              // enough to hit while walking through a food court.
              className="pressable glass-hover size-10 shrink-0 grid place-items-center rounded-full opacity-70 hover:opacity-100"
            >
              <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" aria-hidden>
                <path
                  d="M6 6l12 12M18 6L6 18"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// =============================================================================
// The diff
// =============================================================================

export interface WatchedOrder {
  orderId: string;
  orderNumber: string;
  status: string;
  vendorName: string;
}

/** What to say when an order moves from one state to another. */
function messageFor(o: WatchedOrder): { title: string; body?: string; tone: ToastTone; ttl: number | null } | null {
  switch (o.status) {
    case 'PAYMENT_CONFIRMED':
    case 'DISPATCHED':
      return {
        title: `Order ${o.orderNumber} confirmed`,
        body: `${o.vendorName} has your order.`,
        tone: 'info',
        ttl: 5000,
      };

    case 'ACKNOWLEDGED':
    case 'PREPARING':
      return {
        title: `${o.vendorName} is making order ${o.orderNumber}`,
        tone: 'info',
        ttl: 5000,
      };

    case 'READY':
      return {
        title: `Order ${o.orderNumber} is ready`,
        body: `Collect from ${o.vendorName}.`,
        tone: 'good',
        // Stays until dismissed. This is the only message the product genuinely
        // owes a customer, and a five-second window for someone who glanced
        // away is a message that did not arrive.
        ttl: null,
      };

    case 'REJECTED':
      return {
        title: `Order ${o.orderNumber} could not be made`,
        body: 'Your refund has started. You do not need to do anything.',
        tone: 'bad',
        ttl: null,
      };

    case 'CANCELLED':
      return { title: `Order ${o.orderNumber} was cancelled`, tone: 'bad', ttl: null };

    case 'PAYMENT_EXPIRED':
    case 'PAYMENT_FAILED':
      return {
        title: `Payment for ${o.orderNumber} did not complete`,
        body: 'Nothing was charged.',
        tone: 'warn',
        ttl: null,
      };

    case 'COLLECTED':
      return { title: `Order ${o.orderNumber} collected`, body: 'Enjoy your food.', tone: 'good', ttl: 4000 };

    // CREATED and PAYMENT_PENDING are the customer's own actions a second ago.
    // Announcing them back is noise.
    default:
      return null;
  }
}

/**
 * Fires a toast whenever a watched order changes state.
 *
 * THE FIRST SNAPSHOT IS DELIBERATELY SILENT.
 *
 * Without that, opening the app with two orders in flight fires two toasts for
 * things that happened before the customer was looking. A notification is
 * about a change; the initial state is not one.
 */
export function useOrderNotifications(
  orders: readonly WatchedOrder[] | undefined,
  onOpen?: (orderId: string) => void,
): void {
  const { push } = useToast();
  const seen = useRef<Map<string, string> | null>(null);

  useEffect(() => {
    if (!orders) return;

    // Prime on first data, announce nothing.
    if (seen.current === null) {
      seen.current = new Map(orders.map((o) => [o.orderId, o.status]));
      return;
    }

    for (const o of orders) {
      const previous = seen.current.get(o.orderId);
      seen.current.set(o.orderId, o.status);

      // An order appearing for the first time after the initial snapshot is a
      // new order this customer just placed — they know, they are looking at it.
      if (previous === undefined || previous === o.status) continue;

      const m = messageFor(o);
      if (!m) continue;

      push({
        title: m.title,
        ...(m.body !== undefined ? { body: m.body } : {}),
        tone: m.tone,
        ttl: m.ttl,
        ...(onOpen ? { onClick: () => onOpen(o.orderId) } : {}),
      });
    }
  }, [orders, push, onOpen]);
}
