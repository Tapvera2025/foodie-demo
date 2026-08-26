/**
 * ============================================================================
 * THE SOCKET SERVER: AUTHENTICATE AT THE DOOR, ASSIGN ROOMS, NEVER LISTEN AGAIN
 * ============================================================================
 *
 * Three jobs and nothing else:
 *
 *   1. verify the token on the handshake, with the SAME function the HTTP
 *      guards use — a second implementation of "is this token good" is a
 *      second thing that can be wrong, and it would be wrong in the direction
 *      of letting somebody in
 *   2. join the rooms `roomsFor` derives from that token
 *   3. relay bus messages into those rooms
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * There is no `@SubscribeMessage`, no `socket.on('subscribe')`, no handler of
 * any kind for client messages. The socket is one-directional by construction:
 * the server talks, the client listens and refetches over HTTP where every
 * existing guard, tenancy scope and audit path already applies.
 *
 * That is what keeps the realtime layer out of the security surface. Nothing
 * arrives from a socket, so nothing from a socket can be trusted incorrectly.
 * `docs/tech/backend.md`'s "Broadcast only — never a source of state" is
 * enforced here by having no inbound path at all rather than by remembering.
 *
 * THE TOKEN VERSION IS CHECKED AT THE DOOR AND NOT AFTER
 *
 * `CustomerGuard` re-reads `customer.token_version` on every request, so a
 * revoked customer stops being served within one request. A socket is checked
 * once and then held open for as long as the tab is. A revoked customer's
 * socket therefore keeps receiving "your order changed" nudges until they
 * disconnect — which is acceptable ONLY because the nudge carries no data:
 * the refetch it triggers goes through `CustomerGuard`, sees the stale
 * version, and returns nothing. Revocation still bites at the only place it
 * matters. This is the second time the "events carry no state" rule pays for
 * itself, and it is why that rule is not negotiable.
 */

import type { Server as HttpServer } from 'node:http';

import type { Kysely } from 'kysely';
import type pg from 'pg';
import { Server, type Socket } from 'socket.io';

import { config } from '../platform/config.js';
import { rootLogger } from '../platform/logger.js';
import type { Database } from '../platform/schema.js';
import { CUSTOMER_AUDIENCE } from '../identity/customer.guard.js';
import { STAFF_AUDIENCE } from '../identity/auth.controller.js';
import { authKeys } from '../identity/keys.js';
import { verifyToken } from '../identity/tokens.js';
import { BusSubscriber, type BusMessage } from './bus.js';
import { roomsFor, type Principal } from './rooms.js';

/**
 * Resolve a handshake token to a principal, or null.
 *
 * TRIES CUSTOMER FIRST, THEN STAFF. Both are signed by the same keys and
 * differ by audience and `typ`, so the audience check is what separates them —
 * a customer token presented to the staff verification fails on audience, not
 * on signature. Trying both is how one endpoint serves three apps without the
 * client having to declare which kind of token it holds (and therefore without
 * the client being able to LIE about which kind it holds — the claims decide).
 */
async function principalOf(
  db: Kysely<Database>,
  token: string,
): Promise<Principal | null> {
  try {
    const claims = await verifyToken(authKeys(), token, {
      audience: CUSTOMER_AUDIENCE,
      expectType: 'customer',
    });
    if (claims.typ === 'customer') {
      const customer = await db
        .selectFrom('customer')
        .select(['id', 'token_version'])
        .where('id', '=', claims.sub)
        .executeTakeFirst();
      // Same revocation check the HTTP guard makes. A socket is cheap to
      // refuse and expensive to explain later.
      if (!customer || customer.token_version !== claims.ver) return null;
      return { kind: 'customer', customerId: customer.id };
    }
  } catch {
    /* not a customer token; fall through */
  }

  try {
    const claims = await verifyToken(authKeys(), token, {
      audience: STAFF_AUDIENCE,
      expectType: 'staff',
    });
    if (claims.typ === 'staff') {
      /*
       * Scope comes from the ROLE CLAIMS, which the token signs, and not from
       * a lookup keyed on the staff id. That matters: it means a socket's
       * reach is exactly the reach the token was minted with, and widening
       * somebody's roles does not silently widen a connection that is already
       * open.
       */
      const vendorIds = claims.rol.map((r) => r.vnd).filter((v): v is string => Boolean(v));
      const courtIds = claims.rol.map((r) => r.fc).filter((c): c is string => Boolean(c));
      return { kind: 'staff', staffId: claims.sub, vendorIds, courtIds };
    }
  } catch {
    /* not a staff token either */
  }

  return null;
}

export class RealtimeGateway {
  private io: Server | null = null;
  private subscriber: BusSubscriber | null = null;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly makeListenClient: () => pg.Client,
  ) {}

  attach(http: HttpServer): void {
    const cfg = config();

    const io = new Server(http, {
      path: '/realtime',
      /*
       * Mirrors main.ts exactly: localhost only in development, and in
       * production the apps are same-origin so no grant is the correct grant.
       *
       * SPREAD rather than `cors: … : undefined`, because this project sets
       * `exactOptionalPropertyTypes`. Under that flag an optional property and
       * a property explicitly set to `undefined` are different things, and
       * passing the second where the first is expected is a type error — which
       * is the compiler being right: `{cors: undefined}` says "I am
       * configuring cors, to nothing", and omitting the key says "I am not
       * configuring cors". Only the second is meant here.
       */
      ...(cfg.NODE_ENV !== 'production'
        ? { cors: { origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/] } }
        : {}),
      // Both, in this order. A mall's wifi or a corporate proxy will sometimes
      // refuse an upgrade, and long-polling is what keeps a kitchen tablet
      // connected there — degrading to a working transport beats failing.
      transports: ['websocket', 'polling'],
    });

    io.use((socket, next) => {
      /*
       * `auth.token` — from the Socket.IO handshake payload, not a query
       * string. A token in a query string is a token in the access log, in the
       * Referer header and in any proxy that records URLs.
       */
      const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
      if (typeof token !== 'string' || token.length === 0) {
        next(new Error('unauthorised'));
        return;
      }

      void principalOf(this.db, token)
        .then((principal) => {
          if (!principal) {
            next(new Error('unauthorised'));
            return;
          }
          socket.data.principal = principal;
          next();
        })
        .catch(() => next(new Error('unauthorised')));
    });

    io.on('connection', (socket: Socket) => {
      const principal = socket.data.principal as Principal | undefined;
      if (!principal) {
        // Belt and braces: `io.use` above cannot let an unauthenticated socket
        // through, so reaching this means the middleware chain changed.
        socket.disconnect(true);
        return;
      }

      const rooms = roomsFor(principal);
      // Assigned, never requested. See the note at the top of `rooms.ts`.
      for (const room of rooms) void socket.join(room);

      rootLogger.debug(
        { event: 'realtime_connected', kind: principal.kind, rooms: rooms.length },
        'socket joined',
      );
    });

    this.io = io;

    this.subscriber = new BusSubscriber(this.makeListenClient, (m: BusMessage) => {
      if (m.rooms.length === 0) return;
      // `.to(rooms)` unions the rooms and de-duplicates recipients, so a socket
      // in two of them receives one copy rather than two.
      io.to([...m.rooms]).emit(m.event, m.payload);
    });

    void this.subscriber.start();
  }

  async close(): Promise<void> {
    await this.subscriber?.stop();
    // Disconnects every socket. Without it the process will not exit, and a
    // deploy that will not exit is a deploy that gets SIGKILLed mid-refund.
    await new Promise<void>((resolve) => {
      if (!this.io) return resolve();
      this.io.close(() => resolve());
    });
  }
}
