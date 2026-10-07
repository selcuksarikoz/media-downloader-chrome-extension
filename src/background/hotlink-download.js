/**
 * Hotlink-protected direct media downloads.
 *
 * Some CDNs answer extension-initiated downloads with an error body (often a
 * small JSON document) instead of the media, because the download request
 * carries no `Referer`. Chromium refuses to let an extension set `Referer`
 * through `chrome.downloads.download({ headers })` ("Unsafe request header
 * name"), and both `fetch(url, { referrer })` and a `Referer` header are
 * dropped for service-worker requests. A declarativeNetRequest header rewrite
 * is the only supported way to attach it, and it applies to extension fetches
 * only, never to `chrome.downloads` requests.
 *
 * So the blocked case is served by fetching the media with a rewritten
 * `Referer` and handing the resulting blob to the normal download pipeline.
 * Everything else keeps using the direct URL download.
 */

const MAX_BLOB_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const BLOCKED_CONTENT_TYPE =
  /^(?:application\/(?:json|xml|xhtml\+xml)|text\/)/i;
const MEDIA_CONTENT_TYPE = /^(?:image|video|audio)\//i;

let nextRuleId = 100000;

function isHttpUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

/**
 * `urlFilter` for one URL. `|` anchors a match, so a URL that itself contains
 * one cannot be anchored and falls back to a plain substring match.
 */
function toUrlFilter(url) {
  const escaped = url.replace(/\\/g, "\\\\");
  return escaped.includes("|") ? escaped : `|${escaped}|`;
}

function getDnr() {
  const dnr = globalThis.chrome?.declarativeNetRequest;
  return typeof dnr?.updateDynamicRules === "function" ? dnr : null;
}

/** Whether the referrer-rewritten fetch fallback is available at all. */
export function canFetchWithReferrer(url) {
  return isHttpUrl(url) && Boolean(getDnr());
}

function parseContentLength(header) {
  const value = Number(header);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Cheap probe for hotlink protection. It reports a blocked URL only when the
 * server is known to answer with something that is not the media, and refuses
 * the buffered path for media too large to hold in the service worker.
 * Anything unknown (HEAD unsupported, network error) keeps the direct path.
 */
export async function probeHotlinkProtection(url) {
  if (!canFetchWithReferrer(url)) return { blocked: false, fetchable: false };
  let response;
  try {
    response = await fetch(url, {
      method: "HEAD",
      cache: "no-store",
      redirect: "follow",
    });
  } catch {
    return { blocked: false, fetchable: false };
  }
  const contentType = response.headers.get("Content-Type") || "";
  const blocked =
    response.status === 401 ||
    response.status === 403 ||
    (response.ok && BLOCKED_CONTENT_TYPE.test(contentType));
  const length = parseContentLength(response.headers.get("Content-Length"));
  return {
    blocked,
    fetchable: length === 0 || length <= MAX_BLOB_DOWNLOAD_BYTES,
  };
}

async function updateRule(id, rule) {
  const dnr = getDnr();
  if (!dnr) throw new Error("Header rewriting is unavailable.");
  if (rule) {
    await dnr.updateDynamicRules({ removeRuleIds: [id], addRules: [rule] });
    return;
  }
  await dnr.updateDynamicRules({ removeRuleIds: [id] });
}

/**
 * Fetch the media with a `Referer` pointing at its own origin, which is what
 * the browser itself sends for a cross-origin image request under
 * `strict-origin-when-cross-origin`.
 */
export async function fetchMediaWithReferrer(url) {
  const dnr = getDnr();
  if (!dnr) throw new Error("Header rewriting is unavailable.");
  const id = nextRuleId++;
  let referrer;
  try {
    referrer = `${new URL(url).origin}/`;
  } catch {
    throw new TypeError("Media URL must be an absolute http(s) URL.");
  }
  await updateRule(id, {
    id,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [{ header: "Referer", operation: "set", value: referrer }],
    },
    condition: {
      urlFilter: toUrlFilter(url),
      resourceTypes: ["xmlhttprequest"],
    },
  });
  try {
    const response = await fetch(url, {
      credentials: "include",
      redirect: "follow",
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`Fetch failed (${response.status}).`);
    }
    const contentType = response.headers.get("Content-Type") || "";
    if (BLOCKED_CONTENT_TYPE.test(contentType)) {
      throw new Error("The server rejected the download (hotlink protection).");
    }
    if (contentType && !MEDIA_CONTENT_TYPE.test(contentType)) {
      throw new Error(`Unexpected media type (${contentType}).`);
    }
    return await response.blob();
  } finally {
    await updateRule(id, null).catch(() => {});
  }
}