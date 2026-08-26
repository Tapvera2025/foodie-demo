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
  /**
   * A menu source could not be read. 422 rather than 400: the request was
   * well formed, the spreadsheet inside it was not, and the difference matters
   * to whoever is fixing it.
   */
  MENU_IMPORT_INVALID: 422,
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

  // --- ledger (TDD §8) ----------------------------------------------------
  // 500, all four, deliberately. None of these can be caused by a customer or
  // a vendor doing something wrong — they mean the platform is about to write
  // money rows it cannot justify. The correct response is to abort the
  // transaction and page someone, not to show anybody an error message.
  LEDGER_IMBALANCED: 500,
  LEDGER_TOTAL_MISMATCH: 500,
  // Two features the TDD §8.1 entry catalogue cannot express. See
  // src/ledger/entries.ts — the gap is in the spec, not the implementation.
  LEDGER_CANNOT_REPRESENT_DISCOUNT: 500,
  LEDGER_CANNOT_REPRESENT_CREDIT_AT_PLACEMENT: 500,

  // --- auth (Interface Specs §2) ------------------------------------------
  // 401 for both, deliberately identical. See auth.controller.ts: telling a
  // caller whether the email exists turns login into an account-enumeration
  // oracle, and that list is what a phishing campaign starts from.
  INVALID_CREDENTIALS: 401,
  ACCOUNT_SUSPENDED: 403,
  WEAK_PASSWORD: 422,

  TOKEN_INVALID: 401,
  TOKEN_WRONG_TYPE: 401,
  REFRESH_TOKEN_REUSED: 401,
  PAIRING_CODE_INVALID: 400,

  /**
   * The payment provider refused the request.
   *
   * 502, not 500, and its own code rather than INTERNAL. "Something went wrong
   * on our side" is a claim about WHOSE fault it is, and when an aggregator
   * rejects a create-order call that claim is wrong — it sends whoever is
   * debugging to read our stack traces instead of the provider's message.
   *
   * The customer-facing sentence stays generic; the distinction is for the
   * error CODE and the log, which is where a developer actually looks.
   */
  PAYMENT_PROVIDER_REJECTED: 502,

  // --- AI dish descriptions ------------------------------------------------
  /**
   * The stall has spent its whole grant.
   *
   * 409, not 402. `402 Payment Required` looks like the obvious fit and is
   * wrong here: nothing about this is payable by the person who hit the limit.
   * A stall does not top up a balance — it asks the platform to raise its grant,
   * which is an offline conversation. 409 says "the state of your account
   * conflicts with this request", which is exactly the situation, and it keeps
   * 402 free for the day there is a real self-serve purchase.
   */
  AI_CREDITS_EXHAUSTED: 409,

  /**
   * The stall already recommends as many dishes as it may.
   *
   * 409 and not 422: the request is perfectly well formed, and the same body
   * would succeed after the stall unmarks something. That is a conflict with
   * current state, which is what 409 means — and it tells the kitchen board to
   * show "unmark one first" rather than "that was not valid".
   */
  MUST_TRY_LIMIT_REACHED: 409,
  /** Neither provider key is set on this server. An operator problem. */
  AI_NOT_CONFIGURED: 503,
  /** Both providers were tried and neither produced anything usable. */
  AI_GENERATION_FAILED: 502,

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
