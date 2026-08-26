import { useSyncExternalStore } from 'react';
import { Navigate, Route, Routes } from 'react-router';

import { auth } from './api';
import { Court } from './Court';
import { Courts } from './Courts';
import { LiveOrders } from './LiveOrders';
import { Login } from './Login';
import { Offers } from './Offers';
import { Shell } from './Shell';
import { Stall } from './Stall';

/**
 * The shell.
 *
 * ONE SOURCE OF TRUTH FOR "AM I SIGNED IN", VIA `useSyncExternalStore`.
 *
 * The kitchen board learned this the hard way: it kept a `signedIn` React state
 * alongside a `localStorage` read during render, and the 401 handler cleared the
 * token from inside `fetch` — something React cannot observe. The board
 * flickered between the sign-in form and the queue every few seconds.
 *
 * Subscribing to the token store means a 401 anywhere unmounts the console on
 * the next render, once, with no oscillation. Repeating the pattern here is
 * cheaper than rediscovering the bug on a third surface.
 */
export function App() {
  const token = useSyncExternalStore(auth.subscribe, auth.get, auth.get);

  if (!token) return <Login />;

  /*
    The content column caps at `max-w-5xl` inside `Shell`, not full width.
    This console is tables and forms. A table stretched across a 27-inch monitor
    puts the status pill so far from the venue name that the eye loses the row —
    the classic wide-table failure.
  */
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Navigate to="/courts" replace />} />
        <Route path="/courts" element={<Courts />} />
        <Route path="/courts/:courtId" element={<Court />} />
        <Route path="/stalls/:vendorId" element={<Stall />} />
        <Route path="/orders" element={<LiveOrders />} />
        <Route path="/offers" element={<Offers />} />
        <Route path="*" element={<Navigate to="/courts" replace />} />
      </Routes>
    </Shell>
  );
}
