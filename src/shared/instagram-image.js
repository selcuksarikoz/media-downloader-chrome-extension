export function isInstagramCdnImageUrl(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl);
    const isCdn = url.hostname.endsWith(".cdninstagram.com") || url.hostname.endsWith(".fbcdn.net");
    return isCdn && /\.(?:avif|jpe?g|png|webp)$/i.test(url.pathname);
  } catch {
    return false;
  }
}

/**
 * An Instagram CDN URL is identified both by its signed `ig_cache_key` and by
 * the media filename. The same photo can be described with either one, so every
 * lookup and every stored candidate keeps both keys.
 */
export function getInstagramImageAssetKeys(value, baseUrl) {
  if (typeof value !== "string" || !value) return [];
  let url;
  try {
    url = new URL(value, baseUrl);
  } catch {
    return [];
  }
  if (!isInstagramCdnImageUrl(url.href, baseUrl)) return [];

  const keys = [];
  const cacheKey = url.searchParams.get("ig_cache_key");
  if (cacheKey) keys.push(`cache:${cacheKey}`);
  const filename = url.pathname.split("/").pop();
  if (filename) keys.push(`file:${filename}`);
  return keys;
}

export function getInstagramImageAssetKey(value, baseUrl) {
  return getInstagramImageAssetKeys(value, baseUrl)[0] || "";
}

const SHORTCODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Convert an Instagram post/reel shortcode into its numeric media id. */
export function getInstagramMediaIdFromShortcode(shortcode) {
  if (typeof shortcode !== "string" || !/^[\w-]{1,40}$/.test(shortcode)) {
    return "";
  }
  let id = 0n;
  for (const char of shortcode) {
    const digit = SHORTCODE_ALPHABET.indexOf(char);
    if (digit < 0) return "";
    id = id * 64n + BigInt(digit);
  }
  return id > 0n ? id.toString() : "";
}

const RESIZE_TRANSFORM_SEGMENT =
  /(?:^|_)(?:[psc]\d+(?:x\d+|(?:\.\d+){3}[a-z]?)|sh\d+(?:\.\d+)?)(?:_|$)/i;

/** Whether a URL only carries an Instagram thumbnail/crop transform. */
export function isResizedInstagramImageUrl(value, baseUrl) {
  try {
    const stp = new URL(value, baseUrl).searchParams.get("stp") || "";
    return RESIZE_TRANSFORM_SEGMENT.test(stp);
  } catch {
    return false;
  }
}
