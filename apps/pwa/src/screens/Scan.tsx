import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';

import { api } from '../lib/api';
import { useCart } from '../lib/cart';
import { ErrorState, Screen, Spinner } from './ui';

/**
 * The landing screen — where a camera scan lands.
 *
 * Deliberately has nothing to tap. The customer has already expressed intent
 * by scanning; asking them to press "Continue" is a tap that buys nothing.
 */
export function Scan() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const startSession = useCart((s) => s.startSession);

  const q = useQuery({
    queryKey: ['scan', token],
    queryFn: () => api.scan(token!),
    enabled: Boolean(token),
    retry: false,
  });

  useEffect(() => {
    if (!q.data) return;
    startSession({
      sessionId: q.data.sessionId,
      sessionToken: q.data.sessionToken,
      foodCourtId: q.data.foodCourt.id,
      foodCourtName: q.data.foodCourt.name,
      // Absent from an older server's response, which means `otp`.
      identityMode: q.data.identityMode ?? 'otp',
    });
    navigate('/court', { replace: true });
  }, [q.data, startSession, navigate]);

  if (!token) {
    // Reachable via the `*` route. Previously this rendered the same spinner
    // as a real fetch, so a bad URL was indistinguishable from a slow one.
    return (
      <Screen title="Scan to start">
        <p className="text-sm text-ink-500">
          Point your phone camera at the QR code on the poster or the stall front.
        </p>
      </Screen>
    );
  }

  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;

  return (
    <Screen title="Just a moment">
      <Spinner label="Finding your table…" />
    </Screen>
  );
}
