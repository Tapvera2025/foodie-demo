/**
 * Cloudinary, signed server-side.
 *
 * No SDK. Cloudinary's signature is a SHA-1 of the parameters you are about to
 * send, sorted by key, with the API secret appended — about fifteen lines, and
 * the package pulls in a large dependency tree to do it plus an upload path we
 * deliberately do not use. `createHash` is already in Node.
 *
 * ============================================================================
 * THE TRANSFORMATION IS PART OF THE SIGNATURE, AND THAT IS THE POINT
 * ============================================================================
 *
 * A phone photograph is 3–12MB and 4000px wide. The dish tile that displays it
 * is 76px. Serving the original would blow PRD §16.1's budget of under two
 * seconds from scan to menu on 4G — on the first screen a customer ever sees,
 * in a basement, on the worst connection they will have that day.
 *
 * So the upload carries an eager transformation that caps the stored image, and
 * because the transformation is signed, the client cannot remove it. A client
 * that could choose its own transformation could choose none, and then the
 * budget depends on every future caller remembering.
 */

import { createHash } from 'node:crypto';

import { AppError } from '../errors.js';
import { folderFor, type SignedUpload, type StoragePort, type UploadScope } from './storage.port.js';

export interface CloudinaryConfig {
  readonly cloudName: string;
  readonly apiKey: string;
  readonly apiSecret: string;
}

/**
 * What each kind of image is resized to on the way in.
 *
 * `c_limit` never enlarges and never crops — a small logo stays small, and a
 * wide photograph is bounded by its longest side. Cropping would decide for the
 * vendor which part of their own food to show.
 *
 * `q_auto` and `f_auto` let Cloudinary pick the quality and hand WebP or AVIF
 * to browsers that take it, which is most of the saving on a 4G connection.
 */
const TRANSFORM: Record<UploadScope['kind'], string> = {
  // Wide, and the largest thing we store: it is a hero band on a phone and a
  // card image on a desktop grid.
  'stall-cover': 'c_limit,w_1600,h_1600,q_auto,f_auto',
  // The offer banner is 2:1 across the carousel. Same ceiling.
  offer: 'c_limit,w_1600,h_1600,q_auto,f_auto',
  // A dish appears at 76px on a menu row and fills a hero band at most.
  dish: 'c_limit,w_1200,h_1200,q_auto,f_auto',
  // 44px over a photograph. Anything larger is bytes nobody will ever see.
  'stall-logo': 'c_limit,w_400,h_400,q_auto,f_auto',
};

/** Eight megabytes. Larger than any phone photo needs to be after the client
 *  has picked it, and small enough that a mis-selected video is refused. */
const MAX_BYTES = 8 * 1024 * 1024;

const ACCEPT = ['image/jpeg', 'image/png', 'image/webp'] as const;

export class CloudinaryStorage implements StoragePort {
  readonly name = 'cloudinary';

  constructor(private readonly cfg: CloudinaryConfig) {}

  signUpload(scope: UploadScope): SignedUpload {
    const timestamp = Math.floor(Date.now() / 1000);
    const folder = folderFor(scope);
    const transformation = TRANSFORM[scope.kind];

    /**
     * Exactly the parameters that will be sent, and nothing else.
     *
     * Cloudinary rebuilds this string from what it receives and compares. Any
     * field the client adds that is not here breaks the signature — which is
     * what stops a caller appending its own `folder` and writing into another
     * stall's directory.
     *
     * `api_key` and `file` are excluded by Cloudinary's own rule; including
     * them produces a signature that never matches, and the error it returns
     * does not say so.
     */
    const signed: Record<string, string> = {
      folder,
      timestamp: String(timestamp),
      transformation,
    };

    const toSign = Object.keys(signed)
      .sort()
      .map((k) => `${k}=${signed[k]}`)
      .join('&');

    const signature = createHash('sha1').update(`${toSign}${this.cfg.apiSecret}`).digest('hex');

    return {
      uploadUrl: `https://api.cloudinary.com/v1_1/${this.cfg.cloudName}/image/upload`,
      fields: { ...signed, api_key: this.cfg.apiKey, signature },
      maxBytes: MAX_BYTES,
      accept: [...ACCEPT],
    };
  }
}

/**
 * The adapter used when nothing is configured.
 *
 * Refuses, with a message aimed at whoever can fix it. The alternative — a null
 * port and an endpoint that 404s — turns "somebody forgot an environment
 * variable" into "the upload button is broken", which is a bug report rather
 * than a five-second fix.
 *
 * Deliberately NOT a fallback to unsigned uploads or to a local disk. A storage
 * provider that silently changes under you is how images end up in two places
 * and half of them disappear on the next deploy.
 */
export class UnconfiguredStorage implements StoragePort {
  readonly name = 'none';

  signUpload(): SignedUpload {
    throw new AppError(
      'RECONCILIATION_REQUIRED',
      'Image uploads are not configured on this server. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET.',
    );
  }
}
