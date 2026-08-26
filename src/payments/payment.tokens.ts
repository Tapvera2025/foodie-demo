/**
 * Injection tokens, in a file that imports nothing.
 *
 * WHY THIS FILE EXISTS
 *
 * These symbols lived in `payment.module.ts`, which imports `PaymentController`,
 * which imports the symbols back. A cycle. At runtime it failed with:
 *
 *     ReferenceError: Cannot access 'PAYMENT_ENGINE' before initialization
 *
 * and the API would not boot at all.
 *
 * `tsc --noEmit` passes on this happily — a circular *type* graph is legal, and
 * the compiler has no opinion about which module finishes evaluating first. The
 * error only appears when something actually runs the code, which is why three
 * clean typechecks in a row said nothing about it.
 *
 * The fix is structural rather than clever: a leaf module that imports nothing
 * cannot participate in a cycle. Both the module and the controller now depend
 * on this, and on nothing of each other's.
 *
 * The general rule, since this will happen again: an injection token is not
 * part of a module's implementation. Keeping it next to the `@Module` that
 * happens to provide it reads as tidy and creates exactly this trap.
 */

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
export const PAYMENT_ENGINE = Symbol('PAYMENT_ENGINE');
