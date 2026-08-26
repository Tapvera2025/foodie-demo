/**
 * Does image upload actually work, end to end?
 *
 * THE SYMPTOM THIS EXISTS FOR
 *
 *   "I pick a photo and nothing happens."
 *
 * There are five places that can fail and the browser shows the same nothing
 * for four of them:
 *
 *   1. the three CLOUDINARY_* variables are not set
 *   2. the API was started before they were, so it cached "unconfigured"
 *   3. the signature is wrong, and Cloudinary's error for that is "Invalid
 *      Signature" with no indication of which parameter caused it
 *   4. the credentials are right and the account is not reachable
 *   5. everything works, and the client threw the URL away
 *
 * This tests 1, 3 and 4 directly by performing a real signed upload of a 1x1
 * PNG with the exact code path `cloudinary.adapter.ts` uses. If it prints a
 * secure_url, the server half is correct and the fault is in the browser.
 *
 *   npm run check:uploads
 *
 * Writes one tiny file to foodie/selftest/ in your account. Delete it whenever.
 */

import { createHash } from 'node:crypto';

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const OFF = '\x1b[0m';

async function main(): Promise<void> {
  const cloud = process.env['CLOUDINARY_CLOUD_NAME'];
  const key = process.env['CLOUDINARY_API_KEY'];
  const secret = process.env['CLOUDINARY_API_SECRET'];

  console.log(`\n${BOLD}Image upload check${OFF}\n${'─'.repeat(70)}`);

  const missing = [
    ['CLOUDINARY_CLOUD_NAME', cloud],
    ['CLOUDINARY_API_KEY', key],
    ['CLOUDINARY_API_SECRET', secret],
  ].filter(([, v]) => !v);

  if (missing.length > 0) {
    console.log(`\n${RED}Not configured.${OFF} Missing from .env:\n`);
    for (const [name] of missing) console.log(`    ${name}`);
    console.log(
      `\n  With any of these unset the server refuses every upload, and the\n` +
        `  message it returns names exactly these variables.\n`,
    );
    process.exit(1);
  }

  // Only the cloud name is printed. The key and the secret are not, here or
  // anywhere else — this script is likely to be run in a shared terminal.
  console.log(`  cloud name   ${cloud}`);
  console.log(`  api key      ${DIM}set (${String(key).length} chars)${OFF}`);
  console.log(`  api secret   ${DIM}set (${String(secret).length} chars)${OFF}`);

  /*
   * The SAME construction as `cloudinary.adapter.ts`. Deliberately duplicated
   * rather than imported: this script's job is to prove the algorithm produces
   * a signature Cloudinary accepts, and importing the implementation under test
   * would make it agree with itself no matter what it does.
   */
  const timestamp = Math.floor(Date.now() / 1000);
  const signed: Record<string, string> = {
    folder: 'foodie/selftest',
    timestamp: String(timestamp),
    transformation: 'c_limit,w_1600,h_1600,q_auto,f_auto',
  };

  const toSign = Object.keys(signed)
    .sort()
    .map((k) => `${k}=${signed[k]}`)
    .join('&');

  const signature = createHash('sha1').update(`${toSign}${secret}`).digest('hex');

  console.log(`\n  signing      ${DIM}${toSign}${OFF}`);
  console.log(`  signature    ${DIM}${signature.slice(0, 12)}…${OFF}`);

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

  const form = new FormData();
  for (const [k, v] of Object.entries(signed)) form.append(k, v);
  form.append('api_key', String(key));
  form.append('signature', signature);
  form.append('file', new Blob([png], { type: 'image/png' }), 'selftest.png');

  console.log(`\n  uploading a 1×1 PNG…`);

  let res: Response;
  try {
    res = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/image/upload`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    console.log(
      `\n${RED}Could not reach Cloudinary.${OFF} ${(e as Error).message}\n\n` +
        `  Network, proxy or firewall — not a credentials problem.\n`,
    );
    process.exit(1);
  }

  const body = (await res.json()) as { secure_url?: string; error?: { message?: string } };

  if (res.ok && body.secure_url) {
    console.log(`\n${GREEN}${BOLD}  Uploads work.${OFF}`);
    console.log(`  ${body.secure_url}\n`);
    console.log(
      `  The signature is accepted and the account is reachable, so the\n` +
        `  server half is correct. If a photo still does not stick in the app,\n` +
        `  the fault is in the browser — open the console and watch for the\n` +
        `  POST to api.cloudinary.com.\n`,
    );
    return;
  }

  console.log(`\n${RED}Cloudinary refused it (HTTP ${res.status}).${OFF}`);
  console.log(`  ${body.error?.message ?? JSON.stringify(body)}\n`);

  if (/signature/i.test(body.error?.message ?? '')) {
    console.log(
      `${YELLOW}  "Invalid Signature" means the secret is wrong, or the signed\n` +
        `  parameters do not match what was sent. The secret is the usual one —\n` +
        `  check for a trailing space or a stale value in .env.${OFF}\n`,
    );
  }

  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
