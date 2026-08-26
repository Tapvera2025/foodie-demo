/**
 * Which storage provider is in use, decided once at startup.
 *
 * A module-level singleton rather than a Nest provider, matching `config()` and
 * `authKeys()`. Two controllers and a worker need this and none of them should
 * have to be constructed differently because a photograph moved house.
 *
 * THE SWAP TO A LOCAL SERVER IS THIS FILE AND ONE NEW ADAPTER.
 *
 * Nothing above this line knows what Cloudinary is. The endpoints ask for a
 * signature, the browser uploads wherever it is told, and the database stores
 * whatever URL comes back. When the local server exists it implements
 * `StoragePort`, gets chosen here, and no endpoint, screen or column changes.
 */

import { config } from '../config.js';
import { log } from '../logger.js';
import { CloudinaryStorage, UnconfiguredStorage } from './cloudinary.adapter.js';
import type { StoragePort } from './storage.port.js';

let port: StoragePort | null = null;

export function storage(): StoragePort {
  if (port !== null) return port;

  const c = config();

  if (c.CLOUDINARY_CLOUD_NAME && c.CLOUDINARY_API_KEY && c.CLOUDINARY_API_SECRET) {
    port = new CloudinaryStorage({
      cloudName: c.CLOUDINARY_CLOUD_NAME,
      apiKey: c.CLOUDINARY_API_KEY,
      apiSecret: c.CLOUDINARY_API_SECRET,
    });
    // The cloud NAME is public — it is in every image URL the app serves. The
    // key and the secret are not logged, here or anywhere.
    log().info(
      { event: 'storage_configured', provider: 'cloudinary', cloudName: c.CLOUDINARY_CLOUD_NAME },
      'image uploads are enabled',
    );
  } else {
    port = new UnconfiguredStorage();
    log().warn(
      { event: 'storage_unconfigured' },
      'image uploads are disabled: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET are not all set',
    );
  }

  return port;
}

export type { SignedUpload, StoragePort, UploadScope } from './storage.port.js';
