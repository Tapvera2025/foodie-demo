import { StrictMode, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createBrowserRouter,
  Navigate,
  Outlet,
  RouterProvider,
  useLocation,
  useNavigate,
} from 'react-router';

import './index.css';
import { useIsSignedIn, type StockWatch } from './lib/api';
import { ToastProvider, useToast } from './lib/notify';
import { useRestockAnnouncements } from './lib/stock-watch';
import { initTheme } from './lib/theme';
import { DevEntry } from './screens/DevEntry';
import { Scan } from './screens/Scan';
import { Vendors } from './screens/Vendors';
import { Menu } from './screens/Menu';
import { Checkout } from './screens/Checkout';
import { Pay } from './screens/Pay';
import { Verify } from './screens/Verify';
import { Track } from './screens/Track';
import { Orders } from './screens/Orders';

/**
 * `staleTime: 0` on everything by default.
 *
 * PRD CUS-TRK-04: on reconnection the client re-fetches authoritative state
 * rather than replaying missed events. Caching an order status for even a few
 * seconds means showing "Preparing" to someone whose food is on the counter.
 * Menus could be cached; orders must not be, and one rule is easier to keep
 * right than two.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 0,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

/**
 * Announces a dish coming back, wherever the customer happens to be.
 *
 * Renders nothing. It exists to be inside `ToastProvider` — a hook cannot be
 * called from the module scope, and putting this in one screen would mean the
 * news only arrives if they are standing on that screen when it does.
 *
 * The toast is CLICKABLE and goes to the stall, because "Momos are back" with
 * no way to act on it is a notification that makes somebody hunt for the thing
 * it just told them about.
 */
function RestockWatcher() {
  const { push } = useToast();
  const navigate = useNavigate();

  const announce = useCallback(
    (w: StockWatch) => {
      push({
        title: `${w.itemName} is back`,
        body: `${w.vendorName} can make it again.`,
        tone: 'good',
        // Longer than a confirmation and shorter than an order alert. It is
        // good news rather than something to act on within seconds.
        ttl: 9000,
        onClick: () => navigate(`/vendor/${w.vendorId}`),
      });
    },
    [push, navigate],
  );

  useRestockAnnouncements(announce);
  return null;
}

/**
 * A layout route wrapping every screen.
 *
 * It exists for one reason: `RestockWatcher` calls `useNavigate`, and that hook
 * needs a Router above it. Rendering the watcher beside `RouterProvider` — the
 * obvious place, since it belongs to the whole app rather than to any screen —
 * throws on mount, because there is no router context there to navigate with.
 *
 * `<Outlet />` renders whichever child route matched, so every screen below is
 * unchanged and the watcher is mounted once for all of them.
 */
function Shell() {
  return (
    <>
      <RestockWatcher />
      <Outlet />
    </>
  );
}

/**
 * ============================================================================
 * A SCREEN THAT NEEDS A VERIFIED CUSTOMER SAYS SO IN THE ROUTE TABLE
 * ============================================================================
 *
 * The gate used to be a single line inside `Menu.addToCart`: add the dish, and
 * if there is no token, go to `/verify`. That covers the first tap and nothing
 * after it. Someone who backed out of the verify screen still had the dish in
 * their cart — deliberately, the cart is meant to survive authentication — so
 * the cart bar was still there, and tapping it went straight to `/checkout`
 * with no token.
 *
 * What they got was not a prompt. Checkout asked the server to price the
 * basket, the request came back 401 `TOKEN_INVALID`, and the screen rendered
 * its generic failure card: "Something went wrong. Verify your mobile number
 * to continue." with a Try again button that tries the same unauthenticated
 * request and fails identically, forever. The sentence naming the actual
 * problem was there, buried in an error box, next to a button that could not
 * fix it.
 *
 * A `navigate()` inside an event handler can only ever guard the paths someone
 * thought of. Every route into `/checkout` — the cart bar, the back button, a
 * restored tab, a bookmark, a deep link — has to pass through the route table,
 * so that is where the check belongs. A screen added next year is covered by
 * being listed here, not by remembering this conversation.
 */
function RequireVerified({ children }: { children: React.ReactElement }) {
  const signedIn = useIsSignedIn();
  const location = useLocation();

  if (!signedIn) {
    /*
     * `replace`, and carry where they were going.
     *
     * `replace` keeps the unreachable screen out of history: pressing Back from
     * the verify screen should return to the menu, not to a checkout that will
     * only bounce them here again.
     *
     * `from` is the intent. Without it, verifying succeeds and drops the
     * customer wherever `navigate(-1)` happens to land, which after a redirect
     * is the menu they just left — so the tap that meant "pay" ends with them
     * back where they started, holding a full cart and no explanation.
     */
    return (
      <Navigate to="/verify" replace state={{ from: location.pathname + location.search }} />
    );
  }

  return children;
}

const router = createBrowserRouter([
  {
    element: <Shell />,
    children: [
      // `/` is the dev table picker in development and a plain scan prompt in a
      // real build, so the shortcut cannot ship by accident.
      { path: '/', element: import.meta.env.DEV ? <DevEntry /> : <Scan /> },
      { path: '/t/:token', element: <Scan /> },
      { path: '/court', element: <Vendors /> },
      { path: '/vendor/:vendorId', element: <Menu /> },
      { path: '/verify', element: <Verify /> },
      {
        path: '/checkout',
        element: (
          <RequireVerified>
            <Checkout />
          </RequireVerified>
        ),
      },
      {
        path: '/pay/:orderId',
        element: (
          <RequireVerified>
            <Pay />
          </RequireVerified>
        ),
      },
      {
        path: '/orders',
        element: (
          <RequireVerified>
            <Orders />
          </RequireVerified>
        ),
      },
      {
        path: '/order/:orderId',
        element: (
          <RequireVerified>
            <Track />
          </RequireVerified>
        ),
      },
      { path: '*', element: <Scan /> },
    ],
  },
]);

/**
 * Paint the theme BEFORE React mounts.
 *
 * If `data-theme` were set in an effect, the first frame would render with the
 * default theme and then swap — the flash of wrong theme. It is worst for the
 * person who chose dark, because they get a full-white screen for a frame in
 * whatever lighting made them choose dark in the first place.
 *
 * Light is the customer default. A phone in a food court is competing with
 * daylight, and that beats whatever the phone was set to at breakfast. Anyone
 * who prefers otherwise taps the toggle once and it sticks.
 */
initTheme('light');

/**
 * Says, in the console, when the code this tab is running was served.
 *
 * The answer to "I restarted the server and it still shows the old UI". A tab
 * that was open when the dev server died keeps rendering its last DOM for ever
 * — the HMR socket is gone and nothing tells the page so. It looks entirely
 * alive, which is why the reload never occurs to anybody.
 *
 * Compare this timestamp with when you last restarted. Older means the TAB is
 * stale, not the build, and Cmd-Shift-R fixes it.
 *
 * `import.meta.env.DEV` is inlined at build time, so this whole block is
 * removed from a production bundle rather than merely skipped.
 */
if (import.meta.env.DEV) {
  console.info(
    `%c Foodie %c customer app · code served ${new Date(__DEV_SERVER_STARTED_AT__).toLocaleTimeString()}`,
    'background:#cf3a32;color:#fff;font-weight:700;border-radius:3px 0 0 3px',
    'background:#f1f3f6;color:#3c4553;border-radius:0 3px 3px 0',
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {/* Outside the router, so a toast survives navigation. A notification
          that vanishes because the customer tapped through to another screen
          is a notification that did not arrive. */}
      <ToastProvider>
        {/* The phone column. Without it a single order card stretched the full
            width of a desktop browser — the one reason the app looked broken
            on anything that was not a phone. */}
        <div className="app-frame">
          <RouterProvider router={router} />
        </div>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
