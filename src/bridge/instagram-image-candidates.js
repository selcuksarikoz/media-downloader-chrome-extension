const MAX_ASSETS = 500;
const MAX_CANDIDATES_PER_ASSET = 20;
const MAX_VISITED_VALUES = 100_000;
const MAX_SCRIPT_CHARS = 8_000_000;
const MAX_EXTRACT_MS = 400;
const SCRIPT_URL_PATTERN = /https?:\/\/[^\s"'<>\\]+/g;
const INSTAGRAM_IMAGE_CANDIDATES_EVENT = "imd:instagram-image-candidates";
const INSTAGRAM_IMAGE_CANDIDATES_REQUEST_EVENT =
  "imd:request-instagram-image-candidates";
const candidatesByAsset = new Map();
const scannedScripts = new WeakSet();

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

export function extractInstagramImageCandidates(payload, deadline = Infinity) {
  const output = new Map();
  const pending = [payload];
  let visited = 0;

  while (pending.length > 0 && visited < MAX_VISITED_VALUES) {
    visited += 1;
    if ((visited & 2047) === 0 && Date.now() > deadline) break;
    const value = pending.pop();
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

/** Pull CDN image URLs straight out of text that is not valid JSON. */
export function extractInstagramImageCandidatesFromText(
  text,
  deadline = Infinity,
) {
  const output = new Map();
  for (const match of text.matchAll(SCRIPT_URL_PATTERN)) {
    addCandidate(output, match[0]);
    if (Date.now() > deadline) break;
  }
  return [...output.values()];
}

function decodeScriptText(text) {
  return text
    .replaceAll("\\/", "/")
    .replace(/\\u0026/gi, "&")
    .replaceAll("&amp;", "&");
}

/**
 * Instagram renders the first feed page (and every permalink) from JSON that is
 * embedded in the document instead of fetched, so the 2K variants only exist
 * there. Extract them from an inline script's text.
 */
export function extractInstagramImageCandidatesFromScript(
  text,
  deadline = Infinity,
) {
  if (typeof text !== "string" || !text) return [];
  if (text.length > MAX_SCRIPT_CHARS) return [];
  if (!text.includes("cdninstagram") && !text.includes("fbcdn")) return [];
  const decoded = decodeScriptText(text);
  try {
    return extractInstagramImageCandidates(JSON.parse(decoded), deadline);
  } catch {
    return extractInstagramImageCandidatesFromText(decoded, deadline);
  }
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

function scanScriptElement(script, deadline) {
  if (!script || scannedScripts.has(script)) return;
  scannedScripts.add(script);
  if (script.src) return;
  emitCandidates(rememberCandidates(
    extractInstagramImageCandidatesFromScript(script.textContent, deadline),
  ));
}

function scanInlineScripts() {
  const deadline = Date.now() + MAX_EXTRACT_MS;
  for (const script of document.scripts) {
    scanScriptElement(script, deadline);
    if (Date.now() > deadline) break;
  }
}

function observeInlineScripts() {
  if (typeof MutationObserver !== "function" || !document.documentElement) {
    return;
  }
  new MutationObserver((records) => {
    const deadline = Date.now() + MAX_EXTRACT_MS;
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node?.nodeType === 1 && node.tagName === "SCRIPT") {
          scanScriptElement(node, deadline);
        }
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
}

function initInlineScriptScan() {
  scanInlineScripts();
  observeInlineScripts();
}

function emitSnapshot() {
  scanInlineScripts();
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
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initInlineScriptScan, {
      once: true,
    });
  } else {
    initInlineScriptScan();
  }
}
