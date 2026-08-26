/**
 * Ask the CDN for the picture we actually want to show.
 *
 * ============================================================================
 * THE PROBLEM THIS SOLVES
 * ============================================================================
 *
 * A stall uploads whatever its phone took. One dish arrives 4:3, the next 1:1,
 * the next 16:9, and the menu grid becomes a ragged wall of different-shaped
 * photographs. A CSS box fixes the SHAPE — and only the shape. The browser
 * still downloads a 1600px image to paint a 300px card, and it still has to
 * decide which part of an off-ratio photo to throw away, which it does by
 * chopping equally off both edges regardless of where the food is.
 *
 * ============================================================================
 * WHY `g_auto` IS THE WHOLE POINT
 * ============================================================================
 *
 * `c_fill` alone crops to the centre. On a plate photographed slightly off to
 * one side — which is most phone photographs of food — a centre crop takes the
 * tablecloth and leaves the biryani half out of frame. That is the "unusual
 * crop": not that anything was cut, but that the wrong thing was.
 *
 * `g_auto` makes Cloudinary find the subject first and crop around it. Same
 * fixed output shape, and the dish stays in the picture.
 *
 * `f_auto` serves AVIF or WebP to browsers that take them, `q_auto` picks a
 * quality by content rather than a fixed number, and `dpr_2` covers the retina
 * screens every phone in a food court has.
 *
 * ============================================================================
 * IT IS A URL REWRITE, NOT A RE-UPLOAD
 * ============================================================================
 *
 * Cloudinary generates and caches a derivative on first request. Nothing is
 * stored twice by us, no migration is needed for images already uploaded, and
 * the ORIGINAL is untouched — so changing the shape later is a change to this
 * one file rather than a re-processing job over every stall's menu.
 *
 * Anything that is not a Cloudinary delivery URL comes back unchanged. Seed
 * data points at other hosts, and silently mangling those URLs would replace a
 * ragged grid with an empty one.
 */

/** The shapes this app asks for. Named, so call sites cannot invent ratios. */
export type CdnShape = 'tile' | 'card' | 'hero';

const SHAPE: Record<CdnShape, string> = {
  /*
   * The dish thumbnail beside a menu row. SQUARE, and the shape that suffers
   * most from a naive crop — a 16:9 photograph squeezed into a square loses a
   * third of its width, so WHERE that third is taken from decides whether the
   * customer sees the dish or the plate next to it.
   */
  tile: 'ar_1:1,w_240',
  /** The stall card's photograph on the court list. */
  card: 'ar_16:10,w_720',
  /** The banner at the top of a stall page. */
  hero: 'ar_16:9,w_1280',
};

/**
 * `/image/upload/` is the marker.
 *
 * Cloudinary URLs are `https://res.cloudinary.com/<cloud>/image/upload/<...>`,
 * and transformations go in the segment straight after `upload/`. Matching on
 * the full path rather than on the hostname alone means a link to a Cloudinary
 * account that is not ours still gets left alone if it is not a delivery URL.
 */
const UPLOAD = '/image/upload/';

export function cdn(url: string | null | undefined, shape: CdnShape): string | null {
  if (!url) return null;

  const at = url.indexOf(UPLOAD);
  if (at === -1) return url;

  const head = url.slice(0, at + UPLOAD.length);
  const tail = url.slice(at + UPLOAD.length);

  /*
   * ALREADY TRANSFORMED? LEAVE IT.
   *
   * Applying a second `c_fill` chains the crops — Cloudinary would fill to our
   * ratio, then fill that result again, and a picture that survived one crop
   * loses its edges twice. The signed upload already carries `c_limit`, so a
   * URL arriving here with a transformation segment is one somebody built
   * deliberately, and rewriting it would silently overrule them.
   */
  if (/^[a-z]{1,3}_[^/]*\//.test(tail)) return url;

  return `${head}c_fill,g_auto,${SHAPE[shape]},f_auto,q_auto,dpr_2/${tail}`;
}
