// MAIN-world scripts must remain a self-contained classic bundle.
const INSTAGRAM_IMAGE_REQUEST_EVENT = "imd:instagram-image-request";
const INSTAGRAM_IMAGE_RESULT_EVENT = "imd:instagram-image-result";
const INSTAGRAM_APP_ID = "936619743392459";
const REQUEST_TIMEOUT_MS = 7000;

export function initInstagramImageBridge() {
  if (!/(^|\.)instagram\.com$/.test(location.hostname)) return;
  window.addEventListener(INSTAGRAM_IMAGE_REQUEST_EVENT, async (event) => {
    const {
      requestId, mediaId, postMediaId, filename, permalink,
    } = event.detail || {};
    if (
      typeof requestId !== "string" || !requestId ||
      typeof mediaId !== "string" || !/^\d+$/.test(mediaId) ||
      typeof filename !== "string" || !filename
    ) {
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let candidate = null;
    if (isInstagramPermalink(permalink)) {
      try {
        const response = await fetch(permalink, {
          credentials: "include",
          signal: controller.signal,
        });
        if (isInstagramPostResponse(response)) {
          candidate = findInstagramImageUrlInHtml(
            await response.text(),
            filename,
          );
        }
      } catch {}
    }

    if (!candidate) {
      try {
        const requestedMediaId = /^\d+$/.test(postMediaId || "")
          ? postMediaId
          : mediaId;
        const response = await fetch(`/api/v1/media/${requestedMediaId}/info/`, {
          credentials: "include",
          headers: {
            "X-IG-App-ID": INSTAGRAM_APP_ID,
            "X-Requested-With": "XMLHttpRequest",
          },
          signal: controller.signal,
        });
        if (response.ok && !response.redirected) {
          candidate = findInstagramImageCandidate(
            await response.json(),
            filename,
          );
        }
      } catch {}
    }

    try {
      emitResult(requestId, candidate);
    } finally {
      clearTimeout(timer);
    }
  });
}

export function findInstagramImageCandidate(payload, filename) {
  const matches = [];
  collectImageMatches(payload, filename, matches);
  return rankMatches(matches);
}

export function findInstagramImageUrlInHtml(html, filename) {
  if (typeof html !== "string") return null;
  const decoded = html
    .replace(/\\u([0-9a-f]{4})/gi, (_match, hex) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replaceAll("\\/", "/")
    .replaceAll("&amp;", "&");
  const urls = decoded.match(/https:\/\/[^"'<>\\\s]+/g) || [];
  const matches = [];
  urls.forEach((url) => addImageMatch(url, filename, 0, 0, matches));
  return rankMatches(matches);
}

function collectImageMatches(value, filename, matches, dimensions = {}) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry) =>
      collectImageMatches(entry, filename, matches, dimensions),
    );
    return;
  }

  const width = Number(value.original_width || value.width) ||
    dimensions.width || 0;
  const height = Number(value.original_height || value.height) ||
    dimensions.height || 0;
  Object.values(value).forEach((entry) => {
    if (typeof entry === "string") {
      addImageMatch(entry, filename, width, height, matches);
      return;
    }
    collectImageMatches(entry, filename, matches, { width, height });
  });
}

function addImageMatch(value, filename, width, height, matches) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  if (url.protocol !== "https:") return;
  if (!url.hostname.endsWith(".cdninstagram.com")) return;
  if (url.pathname.split("/").pop() !== filename) return;
  matches.push({
    url: url.href,
    width,
    height,
    resized: /_(?:p|s)\d+x\d+(?:_|$)/i.test(
      url.searchParams.get("stp") || "",
    ),
  });
}

function rankMatches(matches) {
  const best = [...matches].sort((a, b) => {
    const aResized = isResizedImageUrl(a.url);
    const bResized = isResizedImageUrl(b.url);
    if (aResized !== bResized) return aResized ? 1 : -1;
    return (b.width * b.height) - (a.width * a.height);
  })[0];
  if (!best) return null;
  const { resized, ...candidate } = best;
  return candidate;
}

function isResizedImageUrl(value) {
  try {
    return /_(?:p|s)\d+x\d+(?:_|$)/i.test(
      new URL(value).searchParams.get("stp") || "",
    );
  } catch {
    return true;
  }
}

function isInstagramPermalink(value) {
  return /^\/(?:p|reel)\/[\w-]+\/?(?:\?img_index=\d+)?$/.test(value || "");
}

export function isInstagramPostResponse(response) {
  try {
    const url = new URL(response.url);
    return (
      response.ok &&
      /(^|\.)instagram\.com$/.test(url.hostname) &&
      /^\/(?:p|reel)\/[\w-]+\/?$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function emitResult(requestId, candidate) {
  window.dispatchEvent(new CustomEvent(INSTAGRAM_IMAGE_RESULT_EVENT, {
    detail: candidate
      ? { requestId, ok: true, ...candidate }
      : { requestId, ok: false },
  }));
}
