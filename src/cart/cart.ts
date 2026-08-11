/**
 * The cart.
 *
 * PRD CUS-CART-01: a cart contains items from exactly ONE vendor. This module
 * enforces it in the domain; `schema.sql` enforces it again with a trigger.
 * Both, deliberately — the trigger is the guarantee, this is the good error
 * message.
 *
 * The cart holds selections and computes line totals. It does NOT compute fees,
 * taxes or the payable amount; that is the pricing module's job at checkout,
 * and the boundary rules keep cart out of it.
 */

import { AppError } from '../platform/errors.js';
import { add, mul, paise, type Paise } from '../platform/money.js';
import { validateSelection, type OptionGroup } from '../catalog/options.js';

export const MAX_LINE_QUANTITY = 50;

export interface CartItem {
  readonly id: string;
  readonly menuItemId: string;
  readonly vendorId: string;
  readonly name: string;
  readonly unitPricePaise: Paise;
  readonly quantity: number;
  readonly selectedOptionIds: readonly string[];
  readonly optionsPricePaise: Paise;
  readonly instructions?: string;
}

export interface Cart {
  readonly id: string;
  readonly sessionId: string;
  /** Immutable for the life of the cart. Changing vendor replaces the cart. */
  readonly vendorId: string;
  readonly items: readonly CartItem[];
  readonly expiresAt: Date;
}

export function lineTotal(item: CartItem): Paise {
  return mul(add(item.unitPricePaise, item.optionsPricePaise), item.quantity);
}

export function subtotal(cart: Cart): Paise {
  return add(...cart.items.map(lineTotal));
}

export function isExpired(cart: Cart, now: Date): boolean {
  return cart.expiresAt.getTime() <= now.getTime();
}

export function assertNotExpired(cart: Cart, now: Date): void {
  if (isExpired(cart, now)) {
    throw new AppError('CART_EXPIRED', 'cart expired through inactivity');
  }
}

export function createCart(input: {
  id: string;
  sessionId: string;
  vendorId: string;
  now: Date;
  expiryMinutes: number;
}): Cart {
  return {
    id: input.id,
    sessionId: input.sessionId,
    vendorId: input.vendorId,
    items: [],
    expiresAt: new Date(input.now.getTime() + input.expiryMinutes * 60_000),
  };
}

export interface AddItemInput {
  readonly cartItemId: string;
  readonly menuItemId: string;
  readonly vendorId: string;
  readonly name: string;
  readonly unitPricePaise: Paise;
  readonly quantity: number;
  readonly optionGroups: readonly OptionGroup[];
  readonly selectedOptionIds?: readonly string[];
  readonly instructions?: string;
  readonly isAvailable: boolean;
}

/**
 * Adds an item, refusing anything that would break an invariant.
 *
 * The vendor check is the important one and it is checked FIRST, before
 * availability or option rules, so the customer gets the actionable error
 * ("start a new cart?") rather than an incidental one.
 */
export function addItem(cart: Cart, input: AddItemInput, now: Date): Cart {
  assertNotExpired(cart, now);

  if (input.vendorId !== cart.vendorId) {
    // PRD CUS-CART-01. Screens & Copy: `cart.other_vendor.title`.
    throw new AppError(
      'CROSS_VENDOR_CART',
      `cart is bound to vendor ${cart.vendorId}; item belongs to ${input.vendorId}`,
      { cartVendorId: cart.vendorId, itemVendorId: input.vendorId },
    );
  }

  if (!input.isAvailable) {
    throw new AppError('ITEM_UNAVAILABLE', `"${input.name}" is out of stock`, {
      menuItemId: input.menuItemId,
    });
  }

  assertQuantity(input.quantity);

  const selection = validateSelection(input.optionGroups, input.selectedOptionIds ?? []);

  const item: CartItem = {
    id: input.cartItemId,
    menuItemId: input.menuItemId,
    vendorId: input.vendorId,
    name: input.name,
    unitPricePaise: input.unitPricePaise,
    quantity: input.quantity,
    selectedOptionIds: [...(input.selectedOptionIds ?? [])].sort(),
    optionsPricePaise: selection.priceDeltaPaise,
    ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
  };

  // Two lines of the same item with the same options and instructions merge,
  // rather than stacking up as separate rows the customer has to reason about.
  const mergeIndex = cart.items.findIndex((existing) => isSameLine(existing, item));
  if (mergeIndex >= 0) {
    const existing = cart.items[mergeIndex] as CartItem;
    const merged = { ...existing, quantity: existing.quantity + item.quantity };
    assertQuantity(merged.quantity);
    const items = [...cart.items];
    items[mergeIndex] = merged;
    return { ...cart, items };
  }

  return { ...cart, items: [...cart.items, item] };
}

function isSameLine(a: CartItem, b: CartItem): boolean {
  return (
    a.menuItemId === b.menuItemId &&
    a.instructions === b.instructions &&
    a.selectedOptionIds.length === b.selectedOptionIds.length &&
    a.selectedOptionIds.every((id, i) => id === b.selectedOptionIds[i])
  );
}

function assertQuantity(q: number): void {
  if (!Number.isInteger(q) || q < 1 || q > MAX_LINE_QUANTITY) {
    throw new AppError(
      'OPTION_RULE_VIOLATION',
      `quantity must be a whole number between 1 and ${MAX_LINE_QUANTITY}`,
    );
  }
}

/** Quantity 0 removes the line, matching PATCH semantics in the API contract. */
export function updateQuantity(cart: Cart, cartItemId: string, quantity: number, now: Date): Cart {
  assertNotExpired(cart, now);

  if (quantity === 0) return removeItem(cart, cartItemId, now);
  assertQuantity(quantity);

  let found = false;
  const items = cart.items.map((i) => {
    if (i.id !== cartItemId) return i;
    found = true;
    return { ...i, quantity };
  });
  if (!found) throw new AppError('ITEM_UNAVAILABLE', `no such cart item ${cartItemId}`);
  return { ...cart, items };
}

export function removeItem(cart: Cart, cartItemId: string, now: Date): Cart {
  assertNotExpired(cart, now);
  const items = cart.items.filter((i) => i.id !== cartItemId);
  if (items.length === cart.items.length) {
    throw new AppError('ITEM_UNAVAILABLE', `no such cart item ${cartItemId}`);
  }
  return { ...cart, items };
}

/**
 * Switching vendor REPLACES the cart. It never merges, and it never silently
 * drops the old items — the caller must have confirmed with the customer first
 * (`cart.other_vendor.body`).
 */
export function switchVendor(cart: Cart, vendorId: string, now: Date, expiryMinutes: number): Cart {
  if (vendorId === cart.vendorId) return cart;
  return createCart({
    id: cart.id,
    sessionId: cart.sessionId,
    vendorId,
    now,
    expiryMinutes,
  });
}

export function touch(cart: Cart, now: Date, expiryMinutes: number): Cart {
  return { ...cart, expiresAt: new Date(now.getTime() + expiryMinutes * 60_000) };
}

/**
 * Belt and braces: asserts the invariant across the whole cart.
 *
 * Called before checkout. If this ever throws, something bypassed `addItem` —
 * which is exactly the case the database trigger exists to catch.
 */
export function assertSingleVendor(cart: Cart): void {
  for (const item of cart.items) {
    if (item.vendorId !== cart.vendorId) {
      throw new AppError(
        'CROSS_VENDOR_CART',
        `cart ${cart.id} contains an item for vendor ${item.vendorId}`,
      );
    }
  }
}

export const ZERO_SUBTOTAL: Paise = paise(0);
