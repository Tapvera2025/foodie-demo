/**
 * Turns thrown errors into the wire format `contracts/openapi.yaml` promises.
 *
 * Two jobs, and the second is the important one.
 *
 * 1. `AppError` already carries its own HTTP status, chosen once in the error
 *    catalogue rather than at each throw site. A `VENDOR_CLOSED` is a 409
 *    everywhere or nowhere.
 *
 * 2. Everything else becomes a bare 500 with no detail. An unexpected error is
 *    by definition one nobody reasoned about, so its message may contain a
 *    connection string, a SQL fragment, or a customer's phone number. The
 *    correlation id goes to the client; the detail goes to the log.
 */

import {
  Catch,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { AppError, isAppError } from './errors.js';
import { currentCorrelationId } from './correlation.js';
import { log } from './logger.js';

interface ErrorBody {
  readonly code: string;
  readonly message: string;
  readonly correlationId: string;
  readonly fields?: Readonly<Record<string, string>>;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const correlationId = currentCorrelationId() ?? 'unknown';

    if (isAppError(exception)) {
      const e: AppError = exception;
      // 5xx AppErrors are our fault, not the caller's — log them loudly. The
      // LEDGER_* codes live here, and they mean money rows could not be
      // justified, which is a page-someone event rather than a status code.
      const level = e.httpStatus >= 500 ? 'error' : 'info';
      log()[level](
        { event: 'request_failed', code: e.code, status: e.httpStatus, path: req.url },
        e.detail ?? e.code,
      );

      const body: ErrorBody = {
        code: e.code,
        message: e.detail ?? e.code,
        correlationId,
        ...(e.fields ? { fields: e.fields } : {}),
      };
      res.status(e.httpStatus).json(body);
      return;
    }

    // Nest's own 404s and validation errors arrive as HttpException.
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      res.status(status).json({
        code: status === 404 ? 'NOT_FOUND' : 'BAD_REQUEST',
        message: exception.message,
        correlationId,
      } satisfies ErrorBody);
      return;
    }

    log().error(
      {
        event: 'unhandled_exception',
        path: req.url,
        err: exception instanceof Error ? exception.stack : String(exception),
      },
      'unhandled exception',
    );

    // Deliberately opaque. The correlation id is how support ties this response
    // to the log line above, which has everything.
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      code: 'INTERNAL',
      message: 'Something went wrong on our side.',
      correlationId,
    } satisfies ErrorBody);
  }
}
