/**
 * utils/storageService.js
 * ─────────────────────────
 * Handles permanent image storage.
 *
 * Strategy:
 *   - For base64 images (from CF Worker): decode + upload to Firebase Storage
 *   - For Replicate URLs: fetch + re-upload to Firebase Storage
 *   - Falls back gracefully if storage is unavailable
 *
 * Why we re-upload:
 *   Replicate CDN URLs expire. CF base64 data URLs are ~1MB each.
 *   Firebase Storage gives permanent public URLs at no cost for first 5GB.
 */

import fetch from 'node-fetch';

/**
 * Converts a base64 data URL to a Buffer.
 * Works for both PNG and WebP.
 *
 * @param {string} dataUrl  - e.g. "data:image/png;base64,iVBORw0..."
 * @returns {Buffer}
 */
export function dataUrlToBuffer(dataUrl) {
  const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!matches) throw new Error('Invalid data URL format');
  return Buffer.from(matches[2], 'base64');
}

/**
 * Uploads an image to Firebase Storage and returns the permanent public URL.
 *
 * @param {object}  bucket        - Firebase Admin storage bucket
 * @param {string}  imageSource   - base64 data URL or https:// URL
 * @param {string}  uid           - user ID (for path namespacing)
 * @param {number}  index         - image index (0–3)
 * @returns {Promise<string>}     - permanent public URL
 */
export async function uploadImageToFirebase(bucket, imageSource, uid, index) {
  let buffer;
  let contentType = 'image/webp';

  if (imageSource.startsWith('data:')) {
    // Source is a base64 data URL (from Cloudflare Worker)
    buffer      = dataUrlToBuffer(imageSource);
    contentType = imageSource.match(/data:([^;]+)/)?.[1] || 'image/png';
  } else {
    // Source is a URL (from Replicate CDN)
    const res = await fetch(imageSource, { timeout: 15_000 });
    if (!res.ok) throw new Error(`Failed to fetch image: HTTP ${res.status}`);
    buffer      = Buffer.from(await res.arrayBuffer());
    contentType = res.headers.get('content-type') || 'image/webp';
  }

  const ext      = contentType.split('/')[1] || 'png';
  const fileName = `generations/${uid}/${Date.now()}_${index}.${ext}`;
  const file     = bucket.file(fileName);

  await file.save(buffer, {
    metadata:  {
      contentType,
      cacheControl: 'public, max-age=31536000, immutable',  // 1 year — images never change
    },
    public:    true,
    resumable: false,
  });

  const storageUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
  return storageUrl;
}

/**
 * Uploads all images for a generation, returning permanent URLs.
 * Processes uploads concurrently (Promise.all) for speed.
 * Falls back to original URL if any upload fails — never blocks the user.
 *
 * @param {object|null} bucket      - Firebase Admin bucket (null = skip)
 * @param {string[]}    images      - array of base64 data URLs or https:// URLs
 * @param {string}      uid         - user UID
 * @returns {Promise<string[]>}     - array of permanent (or fallback) URLs
 */
export async function persistImages(bucket, images, uid) {
  if (!bucket || !images?.length) return images || [];

  const results = await Promise.all(
    images.map(async (src, i) => {
      try {
        return await uploadImageToFirebase(bucket, src, uid, i);
      } catch (err) {
        console.warn(`[Storage] Upload failed for image ${i}: ${err.message}`);
        // Return original source as fallback
        // base64 data URLs will display fine temporarily
        // Non-fatal fallback: return original URL so user still sees image
        return src;
      }
    })
  );

  return results;
}
