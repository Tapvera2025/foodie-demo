/**
 * The one error shape. Clients branch on `code`, never on the message and never
 * on the HTTP status alone.
 *
 * Catalogue: TDD §15. Wire shape: contracts/openapi.yaml #/components/schemas/Problem.
 */

export const ERROR_CODES = {
  // --- request / protocol -------------------------------------------------
  IDEMPOTENCY_KEY_REQUIRED: 400,
  RATE_LIMITED: 429,
  TENANT_SCOPE_VIOLATION: 404,
  WEBHOOK_SIGNATURE_INVALID: 401,

  // --- session / discovery ------------------------------------------------
  QR_INVALID: 404,
  SESSION_EXPIRED: 401,
  VENDOR_CLOSED: 409,
  VENDOR_DEVICE_OFFLINE: 409,
  VENDOR_DISPATCH_BLOCKED: 409,

  // --- cart / catalog -----------------------------------------------------
  ITEM_UNAVAILABLE: 409,
  CROSS_VENDOR_CART: 409,
  OPTION_RULE_VIOLATION: 422,
  CART_EXPIRED: 409,

  // --- checkout -----------------------------------------------------------
  PRICE_CHANGED: 409,
  QUOTE_EXPIRED: 409,
  BELOW_MINIMUM_ORDER: 409,

  // --- order lifecycle ----------------------------------------------------
  INVALID_TRANSITION: 409,
  ORDER_NOT_CANCELLABLE: 409,

  // --- money --------------------------------------------------------------
  PAYMENT_ALREADY_CAPTURED: 409,
  CREDIT_NOT_AVAILABLE: 409,
  // Split out from CREDIT_NOT_AVAILABLE after building the credit module: the
  // copy deck has a distinct `credit.expired` string, so the customer sees a
  // different message and the client needs to be able to branch on it.
  // Addition to the TDD §15 catalogue.
  CREDIT_EXPIRED: 409,
  CREDIT_ALREADY_REFUNDED: 409,
  REFUND_IN_FLIGHT_NOT_CANCELLABLE: 409,
  FEE_CONFIG_EXCEEDS_ORDER: 422,
  FEE_RULE_INVALID_FOR_MODE: 422,
  RECONCILIATION_REQUIRED: 409,

  // --- auth (Interface Specs §2) ------------------------------------------
  TOKEN_INVALID: 401,
  TOKEN_WRONG_TYPE: 401,
  REFRESH_TOKEN_REUSED: 401,
  PAIRING_CODE_INVALID: 400,

  // --- catch-all ----------------------------------------------------------
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export class AppError extends Error {
  readonly httpStatus: number;

  constructor(
    readonly code: ErrorCode,
    readonly detail?: string,
    readonly fields?: Readonly<Record<string, string>>,
  ) {
    super(code);
    this.name = 'AppError';
    this.httpStatus = ERROR_CODES[code];
  }

  /** Render as the Problem schema. `correlationId` is attached by the filter. */
  toProblem(correlationId: string): {
    code: ErrorCode;
    message: string;
    detail?: string;
    correlationId: string;
    fields?: Readonly<Record<string, string>>;
  } {
    return {
      code: this.code,
      message: this.code,
      ...(this.detail !== undefined ? { detail: this.detail } : {}),
      correlationId,
      ...(this.fields !== undefined ? { fields: this.fields } : {}),
    };
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
