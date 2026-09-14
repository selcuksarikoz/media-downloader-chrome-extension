const MAX_ASSETS = 500;
const MAX_CANDIDATES_PER_ASSET = 20;
const MAX_VISITED_VALUES = 100_000;
const INSTAGRAM_IMAGE_CANDIDATES_EVENT = "imd:instagram-image-candidates";
const INSTAGRAM_IMAGE_CANDIDATES_REQUEST_EVENT =
  "imd:request-instagram-image-candidates";
const candidatesByAsset = new Map();

function isInstagramPage() {
  return (
    location.hostname === "instagram.com" ||
    location.hostname.endsWith(".instagram.com")
  );
}

function toDimension(value) {
  const dimension = Number(value);
  return Number.isFinite(dimension) && dimension > 0 ? dimension : 0;
}

function isInstagramCdnImageUrl(value) {
  try {
    const url = new URL(value, location.href);
    const isCdn =
      url.hostname.endsWith(".cdninstagram.com") ||
      url.hostname.endsWith(".fbcdn.net");
    return isCdn && /\.(?:avif|jpe?g|png|webp)$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function getInstagramImageAssetKey(value) {
  if (!isInstagramCdnImageUrl(value)) return "";
  const url = new URL(value, location.href);
  const cacheKey = url.searchParams.get("ig_cache_key");
  if (cacheKey) return `cache:${cacheKey}`;
  const filename = url.pathname.split("/").pop();
  return filename ? `file:${filename}` : "";
}

function addCandidate(output, rawUrl, owner = {}) {
  if (typeof rawUrl !== "string") return;
  const url = rawUrl.replaceAll("\\u0026", "&");
  if (!isInstagramCdnImageUrl(url)) return;
  const assetKey = getInstagramImageAssetKey(url);
  if (!assetKey) return;
  const canonicalUrl = new URL(url, location.href).href;
  const previous = output.get(canonicalUrl);
  output.set(canonicalUrl, {
    assetKey,
    url: canonicalUrl,
    width: Math.max(
      previous?.width || 0,
      toDimension(owner.width ?? owner.config_width),
    ),
    height: Math.max(
      previous?.height || 0,
      toDimension(owner.height ?? owner.config_height),
    ),
  });
}

export function extractInstagramImageCandidates(payload) {
  const output = new Map();
  const pending = [payload];
  let visited = 0;

  while (pending.length > 0 && visited < MAX_VISITED_VALUES) {
    const value = pending.pop();
    visited += 1;
    if (typeof value === "string") {
      addCandidate(output, value);
      continue;
    }
    if (!value || typeof value !== "object") continue;
    if (typeof value.url === "string") addCandidate(output, value.url, value);
    if (typeof value.src === "string") addCandidate(output, value.src, value);
    for (const child of Object.values(value)) {
      if (
        typeof child === "string" ||
        (child && typeof child === "object")
      ) pending.push(child);
    }
  }

  return [...output.values()];
}

function rememberCandidates(candidates) {
  const changed = [];
  for (const candidate of candidates) {
    let assetCandidates = candidatesByAsset.get(candidate.assetKey);
    if (!assetCandidates) {
      assetCandidates = new Map();
      candidatesByAsset.set(candidate.assetKey, assetCandidates);
    }
    const previous = assetCandidates.get(candidate.url);
    if (
      previous &&
      previous.width >= candidate.width &&
      previous.height >= candidate.height
    ) continue;
    assetCandidates.set(candidate.url, candidate);
    while (assetCandidates.size > MAX_CANDIDATES_PER_ASSET) {
      assetCandidates.delete(assetCandidates.keys().next().value);
    }
    changed.push(candidate);
  }

  while (candidatesByAsset.size > MAX_ASSETS) {
    candidatesByAsset.delete(candidatesByAsset.keys().next().value);
  }
  return changed;
}

function emitCandidates(candidates) {
  if (candidates.length === 0) return;
  window.dispatchEvent(new CustomEvent(
    INSTAGRAM_IMAGE_CANDIDATES_EVENT,
    { detail: { candidates } },
  ));
}

function inspectPayload(payload) {
  emitCandidates(rememberCandidates(extractInstagramImageCandidates(payload)));
}

function inspectFetchResponse(response) {
  const contentType = response.headers?.get("Content-Type") || "";
  if (!/json/i.test(contentType)) return;
  response.clone().json().then(inspectPayload).catch(() => {});
}

function inspectXhrResponse(xhr) {
  const contentType = xhr.getResponseHeader("Content-Type") || "";
  if (!/json/i.test(contentType)) return;
  if (xhr.responseType === "json") {
    inspectPayload(xhr.response);
    return;
  }
  if (xhr.responseType && xhr.responseType !== "text") return;
  try {
    inspectPayload(JSON.parse(xhr.responseText));
  } catch {}
}

function emitSnapshot() {
  emitCandidates(
    [...candidatesByAsset.values()].flatMap((entries) => [...entries.values()]),
  );
}

export function initInstagramImageCandidateBridge() {
  if (!isInstagramPage()) return;

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === "function") {
    window.fetch = async function (...args) {
      const response = await nativeFetch.apply(this, args);
      inspectFetchResponse(response);
      return response;
    };
  }

  if (window.XMLHttpRequest) {
    const nativeOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (...args) {
      this.addEventListener("load", () => inspectXhrResponse(this), {
        once: true,
      });
      return nativeOpen.apply(this, args);
    };
  }

  window.addEventListener(
    INSTAGRAM_IMAGE_CANDIDATES_REQUEST_EVENT,
    emitSnapshot,
  );
}
