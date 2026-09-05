/**
 * Single media-type registry: extension → sniff token → Content-Type.
 * Server consumes the three views; validate derives MEDIA_EXTENSIONS from here.
 */

const MEDIA_TYPES = [
  { ext: ".png", sniff: "png", contentType: "image/png" },
  // canonical sniff token is "jpeg" (see validate.js extensionMatchesSniff)
  { ext: ".jpg", sniff: "jpeg", contentType: "image/jpeg" },
  { ext: ".jpeg", sniff: "jpeg", contentType: "image/jpeg" },
  { ext: ".gif", sniff: "gif", contentType: "image/gif" },
  { ext: ".webp", sniff: "webp", contentType: "image/webp" },
  { ext: ".svg", sniff: "svg", contentType: "image/svg+xml" },
];

/** Allowed image extensions for local media (lowercase, with dot). */
export const MEDIA_EXTENSIONS = new Set(MEDIA_TYPES.map((entry) => entry.ext));

const SNIFF_BY_EXT = new Map(MEDIA_TYPES.map((entry) => [entry.ext, entry.sniff]));
const CONTENT_TYPE_BY_EXT = new Map(
  MEDIA_TYPES.map((entry) => [entry.ext, entry.contentType]),
);

/**
 * @param {string} ext lowercase, with leading dot
 * @returns {string | undefined}
 */
export function extToSniff(ext) {
  return SNIFF_BY_EXT.get(ext);
}

/**
 * @param {string} ext lowercase, with leading dot
 * @returns {string | undefined}
 */
export function contentTypeFor(ext) {
  return CONTENT_TYPE_BY_EXT.get(ext);
}
