/**
 * Where images live. One interface, so the provider is a swap and not a rewrite.
 *
 * ============================================================================
 * THE BYTES NEVER TOUCH THIS SERVER
 * ============================================================================
 *
 * This port does not upload anything. It SIGNS an upload, and the browser sends
 * the file straight to the provider. That is the whole shape, and it is chosen
 * over proxying for reasons that get worse at scale, not better:
 *
 *   a 12MB phone photo on food-court wi-fi would hold an API connection open
 *   for the length of the upload, twice — once in, once out — on a Node process
 *   that is also serving every order in every court.
 *
 * And it is chosen over an unsigned upload preset because an unsigned preset is
 * a public string in the JavaScript bundle. Anyone who reads it can upload
 * anything to the account, without signing in, without a stall, without limit,
 * on a service that bills for storage and bandwidth. Every permission check in
 * this codebase would be decoration.
 *
 * So: our API decides WHO may upload and WHERE it goes, the provider does the
 * carrying, and the secret never leaves this process.
 *
 * ============================================================================
 * WHAT THE CALLER GETS BACK, AND WHAT IT DOES WITH IT
 * ============================================================================
 *
 * A signature and the fields to send alongside the file. The browser uploads,
 * gets a URL, and posts THAT to the endpoint that already existed —
 * `PUT /vendor/offer`, the dish editor's `imageUrl`, `vendor.cover_image_url`.
 *
 * None of those columns change. They have always been URL fields, and migration
 * 12 said so at the time: "the columns land first so the upload endpoint has
 * somewhere to write when it exists." This is that endpoint.
 */

/**
 * What is being uploaded, which decides the folder and the transformation.
 *
 * A scope rather than a free-text path: a caller that could name its own folder
 * could write into another stall's, and the folder is how an image is later
 * traced to the stall that owns it or deleted with it.
 */
export type UploadScope =
  | { kind: 'dish'; vendorId: string }
  | { kind: 'stall-cover'; vendorId: string }
  | { kind: 'stall-logo'; vendorId: string }
  | { kind: 'offer'; vendorId: string };

export interface SignedUpload {
  /** Where the browser POSTs the file. */
  readonly uploadUrl: string;
  /** Sent alongside the file. Exactly these, or the signature will not match. */
  readonly fields: Readonly<Record<string, string>>;
  /**
   * Bytes the provider will accept. Enforced by the provider too — this is for
   * the client to refuse a 40MB file before spending somebody's data on it.
   */
  readonly maxBytes: number;
  /** MIME types the provider will accept, for the file picker's `accept`. */
  readonly accept: readonly string[];
}

export interface StoragePort {
  /** For logs and for the console to say which provider is in use. */
  readonly name: string;

  /**
   * Authorise one upload.
   *
   * Throws when the provider is not configured, rather than returning something
   * that fails opaquely in the browser. A missing API key is an operator
   * problem and the error should say so at the point somebody can fix it.
   */
  signUpload(scope: UploadScope): SignedUpload;
}

/**
 * The folder an image belongs in.
 *
 * Shared so every adapter agrees. `foodie/<kind>/<vendorId>` reads in the
 * provider's own media browser without a lookup — which matters the day
 * somebody has to find and remove one stall's images by hand.
 */
export function folderFor(scope: UploadScope): string {
  return `foodie/${scope.kind}/${scope.vendorId}`;
}
