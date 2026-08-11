import { describe, it, expect } from 'vitest';
import {
  createCart,
  addItem,
  updateQuantity,
  removeItem,
  switchVendor,
  subtotal,
  lineTotal,
  assertSingleVendor,
  assertNotExpired,
  isExpired,
  type Cart,
  type AddItemInput,
} from './cart.js';
import { paise } from '../platform/money.js';
import { AppError } from '../platform/errors.js';
import type { OptionGroup } from '../catalog/options.js';

const NOW = new Date('2026-08-10T12:30:00Z');
const VENDOR_A = 'vendor-a';
const VENDOR_B = 'vendor-b';

const portion: OptionGroup = {
  id: 'g-portion',
  name: 'Portion',
  minSelect: 1,
  maxSelect: 1,
  options: [
    { id: 'o-half', name: 'Half', priceDeltaPaise: paise(0), isAvailable: true },
    { id: 'o-full', name: 'Full', priceDeltaPaise: paise(9000), isAvailable: true },
  ],
};

const addons: OptionGroup = {
  id: 'g-addons',
  name: 'Add-ons',
  minSelect: 0,
  maxSelect: 2,
  options: [
    { id: 'o-naan', name: 'Butter naan', priceDeltaPaise: paise(4500), isAvailable: true },
    { id: 'o-rice', name: 'Jeera rice', priceDeltaPaise: paise(12000), isAvailable: true },
    { id: 'o-gone', name: 'Sold out thing', priceDeltaPaise: paise(1000), isAvailable: false },
  ],
};

function baseItem(over: Partial<AddItemInput> = {}): AddItemInput {
  return {
    cartItemId: 'ci-1',
    menuItemId: 'mi-1',
    vendorId: VENDOR_A,
    name: 'Veg Manchurian',
    unitPricePaise: paise(18000),
    quantity: 1,
    optionGroups: [],
    isAvailable: true,
    ...over,
  };
}

function emptyCart(): Cart {
  return createCart({
    id: 'cart-1',
    sessionId: 'sess-1',
    vendorId: VENDOR_A,
    now: NOW,
    expiryMinutes: 20,
  });
}

describe('single-vendor invariant (CUS-CART-01) — the week 3 gate', () => {
  it('refuses an item belonging to a different vendor', () => {
    const cart = emptyCart();
    try {
      addItem(cart, baseItem({ vendorId: VENDOR_B }), NOW);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('CROSS_VENDOR_CART');
      expect((e as AppError).httpStatus).toBe(409);
    }
  });

  it('checks the vendor BEFORE availability, so the error is the actionable one', () => {
    // A wrong-vendor item that also happens to be out of stock should still
    // tell the customer "start a new cart?", not "out of stock".
    const cart = emptyCart();
    try {
      addItem(cart, baseItem({ vendorId: VENDOR_B, isAvailable: false }), NOW);
    } catch (e) {
      expect((e as AppError).code).toBe('CROSS_VENDOR_CART');
    }
  });

  it('assertSingleVendor catches a cart corrupted by something bypassing addItem', () => {
    // If this ever fires in production, something wrote to the cart directly —
    // which is precisely what the database trigger exists to prevent.
    const corrupted = {
      ...emptyCart(),
      items: [
        {
          id: 'x',
          menuItemId: 'mi-9',
          vendorId: VENDOR_B,
          name: 'Smuggled',
          unitPricePaise: paise(100),
          quantity: 1,
          selectedOptionIds: [],
          optionsPricePaise: paise(0),
        },
      ],
    };
    expect(() => assertSingleVendor(corrupted)).toThrow(AppError);
  });

  it('switching vendor replaces the cart rather than merging', () => {
    let cart = addItem(emptyCart(), baseItem(), NOW);
    expect(cart.items).toHaveLength(1);

    cart = switchVendor(cart, VENDOR_B, NOW, 20);
    expect(cart.vendorId).toBe(VENDOR_B);
    expect(cart.items).toHaveLength(0);
  });

  it('switching to the same vendor is a no-op and keeps the items', () => {
    const cart = addItem(emptyCart(), baseItem(), NOW);
    expect(switchVendor(cart, VENDOR_A, NOW, 20).items).toHaveLength(1);
  });
});

describe('line totals', () => {
  it('multiplies unit price plus options by quantity', () => {
    const cart = addItem(
      emptyCart(),
      baseItem({
        quantity: 2,
        optionGroups: [portion],
        selectedOptionIds: ['o-full'],
      }),
      NOW,
    );
    // (180.00 + 90.00) x 2 = 540.00
    expect(lineTotal(cart.items[0]!)).toBe(54000);
    expect(subtotal(cart)).toBe(54000);
  });

  it('an empty cart subtotals to zero, not NaN', () => {
    expect(subtotal(emptyCart())).toBe(0);
  });

  it('sums several lines', () => {
    let cart = addItem(emptyCart(), baseItem(), NOW);
    cart = addItem(
      cart,
      baseItem({ cartItemId: 'ci-2', menuItemId: 'mi-2', unitPricePaise: paise(4500) }),
      NOW,
    );
    expect(subtotal(cart)).toBe(22500);
  });
});

describe('option rules are enforced when adding (CUS-MENU-02)', () => {
  it('rejects a required group left unselected', () => {
    expect(() => addItem(emptyCart(), baseItem({ optionGroups: [portion] }), NOW)).toThrow(
      AppError,
    );
  });

  it('rejects more selections than the group allows', () => {
    expect(() =>
      addItem(
        emptyCart(),
        baseItem({
          optionGroups: [portion],
          selectedOptionIds: ['o-half', 'o-full'],
        }),
        NOW,
      ),
    ).toThrow(AppError);
  });

  it('rejects an out-of-stock option', () => {
    try {
      addItem(
        emptyCart(),
        baseItem({ optionGroups: [addons], selectedOptionIds: ['o-gone'] }),
        NOW,
      );
    } catch (e) {
      expect((e as AppError).code).toBe('ITEM_UNAVAILABLE');
    }
  });

  it('accepts a valid selection and charges the deltas', () => {
    const cart = addItem(
      emptyCart(),
      baseItem({
        optionGroups: [portion, addons],
        selectedOptionIds: ['o-full', 'o-naan'],
      }),
      NOW,
    );
    expect(cart.items[0]!.optionsPricePaise).toBe(9000 + 4500);
  });
});

describe('quantity and line merging', () => {
  it('merges identical lines rather than stacking them', () => {
    let cart = addItem(emptyCart(), baseItem(), NOW);
    cart = addItem(cart, baseItem({ cartItemId: 'ci-2' }), NOW);
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0]!.quantity).toBe(2);
  });

  it('does not merge lines with different instructions', () => {
    let cart = addItem(emptyCart(), baseItem(), NOW);
    cart = addItem(cart, baseItem({ cartItemId: 'ci-2', instructions: 'no onion' }), NOW);
    expect(cart.items).toHaveLength(2);
  });

  it('does not merge lines with different options', () => {
    let cart = addItem(
      emptyCart(),
      baseItem({ optionGroups: [portion], selectedOptionIds: ['o-half'] }),
      NOW,
    );
    cart = addItem(
      cart,
      baseItem({ cartItemId: 'ci-2', optionGroups: [portion], selectedOptionIds: ['o-full'] }),
      NOW,
    );
    expect(cart.items).toHaveLength(2);
  });

  it('rejects an absurd quantity', () => {
    expect(() => addItem(emptyCart(), baseItem({ quantity: 999 }), NOW)).toThrow(AppError);
    expect(() => addItem(emptyCart(), baseItem({ quantity: 0 }), NOW)).toThrow(AppError);
    expect(() => addItem(emptyCart(), baseItem({ quantity: 1.5 }), NOW)).toThrow(AppError);
  });

  it('quantity 0 removes the line', () => {
    const cart = addItem(emptyCart(), baseItem(), NOW);
    expect(updateQuantity(cart, 'ci-1', 0, NOW).items).toHaveLength(0);
  });

  it('rejects an update to an unknown line', () => {
    expect(() => updateQuantity(emptyCart(), 'nope', 2, NOW)).toThrow(AppError);
    expect(() => removeItem(emptyCart(), 'nope', NOW)).toThrow(AppError);
  });
});

describe('expiry (CUS-CART-03)', () => {
  const later = new Date(NOW.getTime() + 21 * 60_000);

  it('expires after the configured inactivity period', () => {
    const cart = emptyCart();
    expect(isExpired(cart, NOW)).toBe(false);
    expect(isExpired(cart, later)).toBe(true);
  });

  it('refuses mutations once expired', () => {
    const cart = emptyCart();
    expect(() => addItem(cart, baseItem(), later)).toThrow(AppError);
    expect(() => updateQuantity(cart, 'ci-1', 2, later)).toThrow(AppError);
    expect(() => assertNotExpired(cart, later)).toThrow(AppError);
  });
});
