/**
 * ============================================================================
 * THE TILL. WHERE SOMEBODY PRESSES A BUTTON AND A CARD MACHINE WAKES UP.
 * ============================================================================
 *
 *   GET  /pos/terminal                 is the machine there?
 *   GET  /pos/orders/:orderId          what does the counter need to see?
 *   POST /pos/orders/:orderId/charge   take the money
 *   POST /pos/orders/:orderId/resolve  find out what happened when we lost sight
 *
 * Every one of these is staff-authenticated and requires `payment.collect`,
 * which no DEVICE role holds — see the note on that row in
 * ../identity/permissions.ts. A wall-mounted kitchen tablet must not be able
 * to charge a card.
 *
 * ----------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE CONTROLLER FROM `PaymentController`
 * ----------------------------------------------------------------------------
 *
 * That one is the customer's payment surface: open an intent, read your own
 * payment's state, and the provider's signed webhook. Its guard is
 * `CustomerGuard` and every route asserts the customer owns the order.
 *
 * This is a staff surface for a physical device, and the ownership question is
 * inverted — the cashier is explicitly acting on somebody else's order. Sharing
 * a controller would mean one file with two authentication models and a
 * per-route memory of which applies, which is how a customer route eventually
 * ends up behind the staff guard.
 */

import { Controller, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Kysely } from 'kysely';

import { requirePermission } from '../identity/rbac.js';
import type { RoleAssignment } from '../identity/rbac.js';
import { StaffGuard, staffOf, type RequestWithStaff } from '../identity/staff.guard.js';
import { currentCorrelationId } from '../platform/correlation.js';
import { DB } from '../platform/database.module.js';
import { AppError } from '../platform/errors.js';
import { log } from '../platform/logger.js';
import { paise } from '../platform/money.js';
import type { Database } from '../platform/schema.js';
import { PAYMENT_ENGINE, PAYMENT_PROVIDER } from './payment.tokens.js';
import type { PaymentRepository } from './payment.repository.js';
import type { PaymentProvider } from './provider.interface.js';
import { PosPaymentProvider, type PosChargeOutcome } from './providers/pos.provider.js';

function toAssignment(r: {
  role: RoleAssignment['role'];
  fc?: string;
  vnd?: string;
}): RoleAssignment {
  return {
    role: r.role,
    ...(r.fc !== undefined ? { foodCourtId: r.fc } : {}),
    ...(r.vnd !== undefined ? { vendorId: r.vnd } : {}),
  };
}

/** The payment this order is waiting on, and the order's own identity. */
interface Chargeable {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly vendorId: string;
  readonly foodCourtId: string;
  readonly providerOrderRef: string;
  readonly amountPaise: number;
  readonly paymentStatus: string;
  readonly orderStatus: string;
}

@Controller('api/v1/pos')
@UseGuards(StaffGuard)
export class PosController {
  constructor(
    @Inject(PAYMENT_ENGINE) private readonly payments: PaymentRepository,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    @Inject(DB) private readonly db: Kysely<Database>,
  ) {}

  /**
   * The provider, narrowed — or a refusal that says why.
   *
   * Every route here needs it, and the check is not a formality: this
   * controller is mounted unconditionally, so on a Cashfree deployment these
   * routes exist and must refuse rather than 500 on a missing method.
   */
  private pos(): PosPaymentProvider {
    if (!(this.provider instanceof PosPaymentProvider)) {
      throw new AppError(
        'RECONCILIATION_REQUIRED',
        'This deployment is not configured for a card terminal. Set PAYMENTS_PROVIDER=pos.',
      );
    }
    return this.provider;
  }

  /** Authorise the actor against the stall whose order this is. */
  private authorise(req: RequestWithStaff, scope: { vendorId: string; foodCourtId: string }): void {
    const staff = staffOf(req);
    requirePermission(
      { subjectId: staff.userId, assignments: staff.roles.map(toAssignment) },
      'payment.collect',
      scope,
    );
  }

  /**
   * Find the payment this order is waiting on.
   *
   * `CREATED` and `PENDING` only. An order whose payment already reached
   * CAPTURED must not present a live Charge button — the guarantee against a
   * double charge is the terminal-side reference, but the guarantee against
   * anybody *trying* belongs here, where it can produce a sentence rather than
   * a silent no-op.
   */
  private async chargeable(orderId: string): Promise<Chargeable> {
    const row = await this.db
      .selectFrom('payment')
      .innerJoin('order', 'order.id', 'payment.order_id')
      .select([
        'order.id as orderId',
        // `public_order_number`, which is what is printed on the slip and
        // called out at the counter. Unique within a court PER DAY, not
        // globally — see the note on `business_date` in schema.ts.
        'order.public_order_number as orderNumber',
        'order.vendor_id as vendorId',
        'order.food_court_id as foodCourtId',
        'order.status as orderStatus',
        'payment.provider_order_ref as providerOrderRef',
        'payment.amount_paise as amountPaise',
        'payment.status as paymentStatus',
      ])
      .where('payment.order_id', '=', orderId)
      .orderBy('payment.created_at', 'desc')
      .executeTakeFirst();

    if (!row) throw new AppError('QR_INVALID', 'No such order.');

    const { providerOrderRef } = row;
    if (!providerOrderRef) {
      throw new AppError(
        'INVALID_TRANSITION',
        'This order has no payment reference yet. The customer must tap Pay first.',
      );
    }

    return { ...row, providerOrderRef };
  }

  /**
   * Is the card machine reachable, right now?
   *
   * The till screen calls this before it offers a Charge button. A terminal
   * that is unplugged, asleep, or has drifted onto a different subnet after a
   * router reboot should be discovered by a cashier reading a screen during a
   * quiet moment — not by a customer standing at the counter while nothing
   * happens for two minutes.
   */
  @Get('terminal')
  async terminal(@Req() req: RequestWithStaff): Promise<unknown> {
    const staff = staffOf(req);
    requirePermission(
      { subjectId: staff.userId, assignments: staff.roles.map(toAssignment) },
      'payment.collect',
    );

    const reachable = await this.pos().terminalReachable();
    return { reachable };
  }

  /** What the counter needs on screen before it charges anybody. */
  @Get('orders/:orderId')
  async summary(
    @Param('orderId') orderId: string,
    @Req() req: RequestWithStaff,
  ): Promise<unknown> {
    const order = await this.chargeable(orderId);
    this.authorise(req, order);

    return {
      orderId: order.orderId,
      orderNumber: order.orderNumber,
      amountPaise: order.amountPaise,
      paymentStatus: order.paymentStatus,
      orderStatus: order.orderStatus,
      /*
       * Whether to draw the Charge button, decided HERE rather than by the
       * screen reading `paymentStatus` and inventing its own rule. Two copies
       * of "may this be charged" is how a till eventually offers the button on
       * an order that has already been paid for.
       */
      chargeable: order.paymentStatus === 'CREATED' || order.paymentStatus === 'PENDING',
    };
  }

  /**
   * ==========================================================================
   * TAKE THE MONEY.
   * ==========================================================================
   *
   * Blocks for as long as the customer takes at the machine — up to two
   * minutes, per `CHARGE_TIMEOUT_MS` in the LAN adapter. That is deliberate and
   * the till's fetch must not time out sooner: abandoning the request does not
   * abandon the transaction, it only abandons our ability to see the result,
   * turning a clean approval into an ambiguity somebody has to reconcile.
   */
  @Post('orders/:orderId/charge')
  async charge(@Param('orderId') orderId: string, @Req() req: RequestWithStaff): Promise<unknown> {
    const order = await this.chargeable(orderId);
    this.authorise(req, order);

    if (order.paymentStatus !== 'CREATED' && order.paymentStatus !== 'PENDING') {
      throw new AppError(
        'PAYMENT_ALREADY_CAPTURED',
        `This order's payment is already ${order.paymentStatus}. Do not charge it again.`,
      );
    }

    const outcome = await this.pos().charge({
      orderId: order.orderId,
      orderNumber: order.orderNumber,
      providerOrderRef: order.providerOrderRef,
      amountPaise: paise(order.amountPaise),
      correlationId: currentCorrelationId(),
    });

    return this.apply(outcome, order);
  }

  /**
   * ==========================================================================
   * FIND OUT WHAT HAPPENED WHEN THE MACHINE WENT QUIET.
   * ==========================================================================
   *
   * The button a cashier presses after an ambiguous charge, instead of the one
   * they would otherwise press — which is Charge, again, on a customer who may
   * already have been debited.
   *
   * Safe to press repeatedly. It asks the terminal and reports; if the answer
   * is an approval, the resulting event goes through the same ingest path and
   * the duplicate suppression there decides whether it changes anything.
   */
  @Post('orders/:orderId/resolve')
  async resolve(@Param('orderId') orderId: string, @Req() req: RequestWithStaff): Promise<unknown> {
    const order = await this.chargeable(orderId);
    this.authorise(req, order);

    const outcome = await this.pos().resolve({
      orderId: order.orderId,
      orderNumber: order.orderNumber,
      providerOrderRef: order.providerOrderRef,
      amountPaise: paise(order.amountPaise),
      correlationId: currentCorrelationId(),
    });

    return this.apply(outcome, order);
  }

  /**
   * Push the terminal's verdict through the one ingest path, and answer the
   * till in words a cashier can act on.
   *
   * The controller does not decide anything. `ingestWebhook` verifies the
   * signature, claims the event id, runs `decideWebhookAction` and moves the
   * order — so a POS charge and a Cashfree webhook reach PAYMENT_CONFIRMED
   * through identical code. See the long note at the top of
   * providers/pos.provider.ts.
   */
  private async apply(outcome: PosChargeOutcome, order: Chargeable): Promise<unknown> {
    if (outcome.event === null) {
      /*
       * CANCELLED or UNKNOWN. Nothing is asserted and nothing is written.
       *
       * The order stays exactly where it was, which for UNKNOWN is the truthful
       * position: we asked for money and do not know the answer. The message
       * is what stops the cashier from doing the wrong thing next.
       */
      log().info(
        {
          event: 'pos_charge_no_state_change',
          orderId: order.orderId,
          outcome: outcome.outcome,
        },
        'the terminal produced nothing to record',
      );

      return {
        outcome: outcome.outcome,
        orderStatus: order.orderStatus,
        message: outcome.message,
        /*
         * The till hides Charge and shows "Check status" on an ambiguity. A
         * screen that offered both would eventually be given the wrong one by
         * somebody in a hurry, and the wrong one debits a customer twice.
         */
        canRetryCharge: outcome.outcome === 'CANCELLED',
        canResolve: outcome.outcome === 'UNKNOWN',
      };
    }

    const result = await this.payments.ingestWebhook(
      outcome.event.rawBody,
      outcome.event.headers,
    );

    log().info(
      {
        event: 'pos_charge_applied',
        orderId: order.orderId,
        outcome: outcome.outcome,
        ingest: result.outcome,
        ...(outcome.rrn !== undefined ? { rrn: outcome.rrn } : {}),
        ...(outcome.approvalCode !== undefined ? { approvalCode: outcome.approvalCode } : {}),
      },
      'a card terminal result was applied through the webhook path',
    );

    return {
      outcome: outcome.outcome,
      orderStatus: result.orderStatus,
      message: outcome.message,
      canRetryCharge: outcome.outcome === 'DECLINED',
      canResolve: false,
      ...(outcome.approvalCode !== undefined ? { approvalCode: outcome.approvalCode } : {}),
      ...(outcome.rrn !== undefined ? { rrn: outcome.rrn } : {}),
    };
  }
}
