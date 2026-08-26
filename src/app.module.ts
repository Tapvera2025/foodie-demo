import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { DatabaseModule } from './platform/database.module.js';
import { HttpExceptionFilter } from './platform/http-exception.filter.js';
import { HealthController } from './health/health.controller.js';
import { AuthController } from './identity/auth.controller.js';
import { CustomerAuthController } from './identity/customer-auth.controller.js';
import { DiscoveryController } from './tenancy/discovery.controller.js';
import { KdsController } from './ordering/kds.controller.js';
import { OrderController } from './ordering/order.controller.js';
import { InventoryController } from './catalog/inventory.controller.js';
import { StockWatchController } from './catalog/stock-watch.controller.js';
import { MenuEditController } from './catalog/menu-edit.controller.js';
import { DescribeController } from './catalog/describe.controller.js';
import { ConsoleController } from './console/console.controller.js';
import { CourtController } from './console/court.controller.js';
import { ConsoleVendorController } from './console/vendor.controller.js';
import { PaymentModule } from './payments/payment.module.js';
import { WorkersModule } from './platform/workers.module.js';

/**
 * Root module.
 *
 * Feature modules are added here as they land, in the order given by TDD §2.1.
 * The dependency direction between them is enforced by eslint-plugin-boundaries
 * (see eslint.config.js), not by convention.
 */
@Module({
  imports: [DatabaseModule, WorkersModule, PaymentModule],
  controllers: [
    HealthController,
    DiscoveryController,
    OrderController,
    AuthController,
    CustomerAuthController,
    KdsController,
    InventoryController,
    /*
     * `api/v1/vendor/menu/**`, separate from `InventoryController`'s
     * `api/v1/vendor/**`, because the permission differs: availability and
     * stock are `stock.toggle` / `inventory.write` and a cook holds both;
     * everything here is `menu.write`, which is owner-only. Two prefixes rather
     * than one controller with a per-handler exception.
     */
    MenuEditController,
    DescribeController,
    /*
     * `api/v1/stock-watch`, its own prefix.
     *
     * Session-guarded like the customer routes rather than staff-guarded like
     * everything else in `catalog/`, which is why it is not folded into
     * `InventoryController`: one controller with two guards is one controller
     * somebody eventually adds a handler to under the wrong one.
     */
    StockWatchController,
    ConsoleController,
    /*
     * Order matters here, and Nest is not the reason.
     *
     * `CourtController` owns `api/v1/console/food-courts/**` and
     * `ConsoleVendorController` owns `api/v1/console/vendors/**`. They are
     * separate prefixes, so no route shadows another — but they were very
     * nearly one controller with both, and splitting them keeps the permission
     * story legible: everything in the first needs `tenant.manage`, everything
     * in the second needs `vendor.write`.
     */
    CourtController,
    ConsoleVendorController,
  ],
  providers: [
    // Global, so no controller can forget it and leak a stack trace.
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
/**
 * Correlation middleware is NOT registered here.
 *
 * `consumer.apply(...).forRoutes('*')` is the idiomatic Nest way and it kills
 * this app on boot. Nest 11 ships Express 5, whose path-to-regexp rejects a
 * bare `'*'` with "Missing parameter name" — the wildcard now has to be named
 * (`'*splat'`). The failure is at startup and total, and from the browser it
 * looks like a request that simply never returns.
 *
 * Rather than encode an Express-version-specific path pattern, `main.ts`
 * registers it with `app.use()`, which takes a plain handler and no path to
 * parse. Fewer moving parts, and it survives the next router rewrite.
 */
export class AppModule {}
