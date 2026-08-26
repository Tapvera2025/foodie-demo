/**
 * Picking an image and getting a URL back.
 *
 * ============================================================================
 * THREE STEPS, AND THE MIDDLE ONE DOES NOT TOUCH OUR SERVER
 * ============================================================================
 *
 *   1. ask our API to sign an upload   — this is where permission is checked
 *   2. POST the file to the provider    — bytes go straight there
 *   3. send the returned URL to our API — the column has always been a URL
 *
 * Step 2 skipping our server is the point. A 12MB phone photograph on
 * food-court wi-fi would otherwise hold an API connection open for the length
 * of the upload, twice, on the process that is also serving every order in
 * every court.
 *
 * Step 3 is why nothing else had to change: `menu_item.image_url`,
 * `vendor.cover_image_url` and `vendor.offer_image_url` have always been URL
 * columns, and this is simply the first way of filling them that does not
 * involve somebody hosting a picture elsewhere and pasting a link.
 */

import { api } from './api';

export interface SignedUpload {
  uploadUrl: string;
  fields: Record<string, string>;
  maxBytes: number;
  accept: string[];
}

export type UploadKind = 'dish' | 'stall-cover' | 'stall-logo' | 'offer';

export class UploadError extends Error {}

/**
 * Upload one file and return its URL.
 *
 * Throws `UploadError` with something a vendor can act on. The provider's own
 * errors are JSON aimed at a developer — "Invalid Signature" tells a stall
 * owner holding a photograph of a biryani precisely nothing.
 */
export async function uploadImage(file: File, kind: UploadKind): Promise<string> {
  const signed = await api.signUpload(kind);

  /*
    Checked HERE as well as by the provider.

    The provider will refuse an oversized file too — but only after the whole
    thing has been sent, which on a kitchen tablet's connection is a minute of
    somebody's time and data spent to be told no. Refusing locally is instant.
  */
  if (file.size > signed.maxBytes) {
    throw new UploadError(
      `That image is ${(file.size / 1024 / 1024).toFixed(1)}MB. The limit is ${Math.round(
        signed.maxBytes / 1024 / 1024,
      )}MB — most phones can send a smaller copy.`,
    );
  }

  if (!signed.accept.includes(file.type)) {
    throw new UploadError('That file is not a JPEG, PNG or WebP image.');
  }

  const form = new FormData();
  // Every signed field, exactly as given. Adding or dropping one breaks the
  // signature, and the provider's error for that does not say which.
  for (const [k, v] of Object.entries(signed.fields)) form.append(k, v);
  form.append('file', file);

  let res: Response;
  try {
    res = await fetch(signed.uploadUrl, { method: 'POST', body: form });
  } catch {
    throw new UploadError('Could not reach the image service. Check the connection.');
  }

  if (!res.ok) {
    throw new UploadError('The image service refused that upload. Try a different photo.');
  }

  const body = (await res.json()) as { secure_url?: string };
  if (!body.secure_url) throw new UploadError('The upload finished with no image URL.');

  // `secure_url`, never `url`. The plain one is http, and an http image on an
  // https page is blocked as mixed content — it would upload successfully and
  // then simply not appear, which is the worst of both.
  return body.secure_url;
}
