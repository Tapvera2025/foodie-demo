import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router';

import './index.css';
import { App } from './App';
import { initTheme } from './theme';

/**
 * `staleTime: 0`, and no polling.
 *
 * The difference from the other two apps is the absence of `refetchInterval`.
 * The customer app and the kitchen board are watching something that changes
 * without them — an order moving through a kitchen. This console changes only
 * because the person using it changed something, so polling would burn
 * connections to re-fetch a list nobody else is editing.
 *
 * `refetchOnWindowFocus` covers the one real case: two console tabs, or a
 * vendor's own tablet marking an item sold out while the checklist is open.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 0, retry: 1, refetchOnWindowFocus: true },
  },
});

/**
 * Light by default, painted before React mounts.
 *
 * An office tool on a laptop, not a phone in daylight or a tablet over a range.
 * Setting `data-theme` in an effect instead would render one frame of the wrong
 * theme — worst for whoever chose dark, who gets a full-white flash in the
 * lighting that made them choose dark.
 */
initTheme('light');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
