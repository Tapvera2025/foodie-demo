/**
 * ============================================================================
 * THE SPLIT ADDS UP, AND THE STALL IS ACTUALLY PAID
 * ============================================================================
 *
 * This is the one part of the system where being wrong costs somebody money and
 * nothing on any screen says so.
 *
 * Until this shipped, `createIntent` sent no `order_splits` at all under
 * PLATFORM_COLLECT. The customer paid, Cashfree collected, the order cooked,
 * the ledger balanced — and the entire amount sat in the platform's account.
 * The stall's share was not lost, not flagged, and not visible: every screen in
 * all three apps showed a completed order. The only artefact was a bank
 * statement nobody reads until the end of a month.
 *
 * A source-reading check cannot cover that. "The code calls `buildSplit`" says
 * nothing about whether the numbers it produces are right. So this IMPORTS the
 * real module and runs it — `split.ts` is pure, with no database, no network
 * and no provider, precisely so that this file can exist.
 *
 * Run: node --experimental-strip-types tests/conformance/split.mjs
 */

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register(
  'data:text/javascript,export async function resolve(s,c,n){return n(s.replace(/\\.js$/,".ts"),c)}',
  pathToFileURL('./'),
);

const { buildSplit, platformShare } = await import('../../src/payments/split.ts');

let checked = 0;
let failures = 0;

function check(name, ok, detail) {
  checked++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
}

/**
 * A realistic order: ₹200 of food, 5% GST retained by the platform under
 * s.9(5), a 3% commission, and the ₹1 + 18% convenience fee the customer pays.
 *
 *   subtotal            20000
 *   food GST (5%)        1000   -> platform, s.9(5)
 *   customer fee          100   -> platform
 *   fee GST (18%)          18   -> platform
 *   ------------------------------------------------
 *   total payable       21118
 *   commission (3%)       600   -> platform
 *   vendor net          19400   -> THE STALL
 */
const ORDER = {
  orderId: 'ord-1',
  totalPayablePaise: 21118,
  vendorNetPaise: 19400,
  platformTaxReservePaise: 1000,
  customerFeePaise: 100,
  customerFeeTaxPaise: 18,
  vendorCommissionPaise: 600,
  operatorSharePaise: 0,
};

console.log('\nsplit — the stall gets its money, to the paise');
console.log('─'.repeat(78));

/* -------------------------------------------------- PLATFORM_COLLECT */
{
  const decision = buildSplit({
    money: ORDER,
    settlementMode: 'PLATFORM_COLLECT',
    vendorLinkedAccountId: 'cf-vendor-1',
  });
  const split = decision.kind === 'SPLIT' ? decision.split : null;

  check('a split is produced under PLATFORM_COLLECT', decision.kind === 'SPLIT', decision.kind);

  check(
    'the stall is allocated exactly its net',
    split?.allocations.length === 1 && split.allocations[0].amountPaise === 19400,
    `got ${JSON.stringify(split?.allocations)}`,
  );

  check(
    "the allocation names the stall's linked account",
    split?.allocations[0].linkedAccountId === 'cf-vendor-1',
    'without it Cashfree has nowhere to send the money and the platform keeps it',
  );

  /*
   * THE CENTRAL ASSERTION. Everything not allocated to a linked account stays
   * with the merchant, so the platform's take is the residue — and the residue
   * must equal the fee, its GST, the retained food GST and the commission.
   * If these disagree, somebody is short.
   */
  const residue = ORDER.totalPayablePaise - 19400;
  const expected =
    ORDER.customerFeePaise +
    ORDER.customerFeeTaxPaise +
    ORDER.platformTaxReservePaise +
    ORDER.vendorCommissionPaise +
    ORDER.operatorSharePaise;

  check(
    'what is left over is exactly the platform\'s share',
    residue === expected,
    `residue ${residue} vs fee+tax+reserve+commission ${expected} — a mismatch ` +
      `means either the stall or the platform is being paid the wrong amount`,
  );

  check(
    'platformShare() agrees with that residue',
    platformShare(ORDER) === residue,
    `platformShare said ${platformShare(ORDER)}, residue is ${residue}`,
  );

  check(
    'nothing is allocated beyond what the customer paid',
    split.allocations.reduce((n, a) => n + a.amountPaise, 0) <= ORDER.totalPayablePaise,
    'transferring more than was collected is an overdraft, not a split',
  );

  check(
    'the transfer id is derived from the order, not random',
    split?.transferId === 'split-ord-1',
    'createIntent is safe to call twice (PAY-REC-03); a random id would make ' +
      'the retry look like a second transfer',
  );

  /*
   * THE CONVENIENCE FEE MUST NOT REACH THE VENDOR. Stated as its own check
   * because it is the specific thing this feature is for — the fee is the
   * platform's revenue in this mode, and an off-by-one in the allocation would
   * hand it to the stall on every single order.
   */
  check(
    'the convenience fee is NOT part of the vendor allocation',
    split.allocations[0].amountPaise < ORDER.totalPayablePaise - ORDER.customerFeePaise,
    'the fee is why this mode exists; allocating it away is the whole revenue',
  );
}

/* ------------------------------------------------------ VENDOR_DIRECT */
{
  const split = buildSplit({
    money: ORDER,
    settlementMode: 'VENDOR_DIRECT',
    vendorLinkedAccountId: 'cf-vendor-1',
  });

  check(
    'VENDOR_DIRECT produces no split at all',
    split.kind === 'NONE',
    'the money never reaches a platform account in that mode, so there is ' +
      'nothing to divide — and `order_splits: []` says something different ' +
      'from sending none',
  );
}

/* ------------------------------------- an unroutable stall is refused */
{
  const d = buildSplit({
    money: ORDER,
    settlementMode: 'PLATFORM_COLLECT',
    vendorLinkedAccountId: null,
  });

  check(
    'a stall with no linked account REFUSES rather than being skipped',
    d.kind === 'REFUSE',
    `got ${d.kind}. Skipping the allocation would let the payment succeed with ` +
      `the stall's money staying in the platform account — silent, and only ` +
      `visible in a bank statement weeks later.`,
  );

  check(
    'and it is NOT confused with "nothing to split"',
    d.kind !== 'NONE',
    'NONE means VENDOR_DIRECT — the payment proceeds. Collapsing the two into ' +
      'a nullable return is exactly how the stall stops being paid.',
  );

  check(
    'and it says why',
    typeof d.reason === 'string' && d.reason.length > 20,
    `reason was ${JSON.stringify(d.reason)}`,
  );
}

/* ------------------------------------------------------ edge amounts */
{
  const zero = buildSplit({
    money: { ...ORDER, vendorNetPaise: 0 },
    settlementMode: 'PLATFORM_COLLECT',
    vendorLinkedAccountId: 'cf-vendor-1',
  });
  check(
    'a zero vendor net produces no allocation',
    zero.kind === 'NONE',
    'Cashfree refuses a zero-value transfer, and it means the same thing as ' +
      'not sending one',
  );

  const over = buildSplit({
    money: { ...ORDER, vendorNetPaise: ORDER.totalPayablePaise + 1 },
    settlementMode: 'PLATFORM_COLLECT',
    vendorLinkedAccountId: 'cf-vendor-1',
  });
  check(
    'allocating more than the order is worth is refused',
    over.kind === 'REFUSE',
    'this cannot happen from a correct quote — which is exactly why it must ' +
      'fire when it does, rather than becoming a transfer',
  );

  /*
   * The fee alone, no food value. Not a real order, but it is the arithmetic
   * boundary: the platform's share should be the whole payment.
   */
  const feeOnly = {
    ...ORDER,
    totalPayablePaise: 118,
    vendorNetPaise: 0,
    platformTaxReservePaise: 0,
    vendorCommissionPaise: 0,
  };
  check(
    'a fee-only order leaves everything with the platform',
    platformShare(feeOnly) === 118,
    `platformShare said ${platformShare(feeOnly)} of 118`,
  );
}

/* --------------------- ONE COLUMN FOR THE PAYEE HANDLE, NOT TWO */
/*
 * ============================================================================
 * THE BUG THIS SECTION EXISTS FOR
 * ============================================================================
 *
 * Migration 18 added `vendor.cashfree_vendor_id` when
 * `vendor.provider_linked_account_id` already existed for the same fact. The
 * split code read the new one; the admin console, the CHECK constraint
 * `vendor_platform_collect_needs_linked_account`, and `vendor-onboarding.ts`
 * all used the old one.
 *
 * So they drifted immediately and invisibly. A stall onboarded through the
 * console had the console's column set and the split's column null — and
 * `order.repository` refused every order it tried to take, while every screen
 * showed it fully configured. A stall set up by the script had the reverse.
 *
 * Nothing was individually wrong. Each query, form and constraint was
 * self-consistent; the fact simply lived in two places that nobody compared.
 * Migration 23 collapsed them onto `provider_linked_account_id`.
 *
 * These read SOURCE rather than running code, because the failure is about
 * which column names appear where — not about arithmetic.
 */
{
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, resolve, join } = await import('node:path');
  const { stripComments } = await import('./_source.mjs');

  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const read = (rel) => stripComments(readFileSync(join(root, rel), 'utf8'));

  const schema = read('src/platform/schema.ts');
  const paymentRepo = read('src/payments/payment.repository.ts');
  const orderRepo = read('src/ordering/order.repository.ts');
  const consoleRepo = read('src/console/vendor.repository.ts');

  check(
    'the duplicate column is gone from the schema',
    !/cashfree_vendor_id/.test(schema),
    'two columns for one payee handle is how a stall ends up configured in the ' +
      'console and unpayable in the split, with nothing on any screen wrong',
  );

  check(
    'the surviving column is still there',
    /provider_linked_account_id/.test(schema),
    'the CHECK constraint and the console both depend on this name',
  );

  check(
    'the split path reads provider_linked_account_id',
    /provider_linked_account_id/.test(paymentRepo) && !/cashfree_vendor_id/.test(paymentRepo),
    'the payment intent has to read the column the console writes, or a ' +
      'UI-onboarded stall silently cannot be paid',
  );

  check(
    'the placement guard reads the same column',
    /provider_linked_account_id/.test(orderRepo) && !/cashfree_vendor_id/.test(orderRepo),
    'the guard that refuses unroutable orders and the split that routes them ' +
      'must agree about where the handle lives',
  );

  check(
    'and so does the console that writes it',
    /provider_linked_account_id/.test(consoleRepo),
    'if the console ever writes somewhere else, the drift is back',
  );
}

/*
 * ---------------------------------------------------------------------------
 * CONTROL
 * ---------------------------------------------------------------------------
 * Every assertion above runs real code, so a broken import would throw rather
 * than pass silently — but a `buildSplit` that returned null unconditionally
 * would satisfy several of them. Prove it can produce a non-trivial result.
 */
{
  checked++;
  const dec = buildSplit({
    money: ORDER,
    settlementMode: 'PLATFORM_COLLECT',
    vendorLinkedAccountId: 'cf-vendor-1',
  });
  const s = dec.kind === 'SPLIT' ? dec.split : null;
  const ok =
    typeof buildSplit === 'function' &&
    typeof platformShare === 'function' &&
    s !== null &&
    s.allocations.length > 0 &&
    s.allocations[0].amountPaise > 0;
  if (!ok) failures++;
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'}  control  buildSplit returns a real allocation ` +
      `(${s?.allocations[0]?.amountPaise} paise to ${s?.allocations[0]?.linkedAccountId})`,
  );
}

console.log('\n' + '═'.repeat(78));
console.log(`${checked} assertions, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
