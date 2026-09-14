export function isInstagramCdnImageUrl(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl);
    const isCdn =
      url.hostname.endsWith(".cdninstagram.com") ||
      url.hostname.endsWith(".fbcdn.net");
    return isCdn && /\.(?:avif|jpe?g|png|webp)$/i.test(url.pathname);
  } catch {
    return false;
  }
}

export function getInstagramImageAssetKey(value, baseUrl) {
  if (!isInstagramCdnImageUrl(value, baseUrl)) return "";
  const url = new URL(value, baseUrl);
  const cacheKey = url.searchParams.get("ig_cache_key");
  if (cacheKey) return `cache:${cacheKey}`;
  const filename = url.pathname.split("/").pop();
  return filename ? `file:${filename}` : "";
}
