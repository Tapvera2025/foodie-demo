import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import './index.css';
import { App } from './App';
import { initTheme } from './theme';

/**
 * `staleTime: 0` and a 3-second poll.
 *
 * A kitchen board showing a stale queue is worse than one showing nothing: the
 * cook believes it. Three seconds is fast enough that a new ticket appears
 * before the customer has put their phone away, and cheap enough for a handful
 * of tablets per court.
 */
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 0, retry: 1, refetchOnWindowFocus: true } },
});

/**
 * Dark by default, painted before the first frame.
 *
 * A kitchen board that flashed white on load would do it at the exact moment a
 * cook glanced up at a new ticket, in a room where the screen is the brightest
 * object. The stored choice wins if the cook has set one.
 */
initTheme('dark');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
