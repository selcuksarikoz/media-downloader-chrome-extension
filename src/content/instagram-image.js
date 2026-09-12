import {
  INSTAGRAM_IMAGE_REQUEST_EVENT,
  INSTAGRAM_IMAGE_RESULT_EVENT,
} from './constants.js';
import { createCaptureId } from './utils.js';

const REQUEST_TIMEOUT_MS = 8000;
const RESIZE_TRANSFORM = /_(?:[ps]\d+x\d+|c\d+(?:\.\d+){3}[a-z]?)(?:_|$)/i;

export function isResizedInstagramImageUrl(value) {
  try {
    const url = new URL(value, document.baseURI);
    return (
      url.hostname.endsWith(".cdninstagram.com") &&
      RESIZE_TRANSFORM.test(url.searchParams.get("stp") || "")
    );
  } catch {
    return false;
  }
}

export function isInstagramImageUrl(value) {
  try {
    const url = new URL(value, document.baseURI);
    return url.hostname.endsWith(".cdninstagram.com");
  } catch {
    return false;
  }
}

/** Ask the page world for Instagram's freshly signed original image URL. */
export async function resolveInstagramImageCandidate(candidates, image) {
  const reference = getInstagramMediaReference(candidates, image);
  if (
    !reference ||
    typeof window === "undefined" ||
    typeof window.dispatchEvent !== "function"
  ) {
    return null;
  }

  const requestId = createCaptureId();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (candidate = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener(INSTAGRAM_IMAGE_RESULT_EVENT, onResult);
      resolve(candidate);
    };
    const onResult = (event) => {
      if (event.detail?.requestId !== requestId) return;
      const { url, width } = event.detail;
      finish(
        event.detail.ok && typeof url === "string" && url
          ? { url, estimatedWidth: Number(width) || 0 }
          : null,
      );
    };
    const timer = setTimeout(() => finish(), REQUEST_TIMEOUT_MS);
    window.addEventListener(INSTAGRAM_IMAGE_RESULT_EVENT, onResult);
    window.dispatchEvent(new CustomEvent(INSTAGRAM_IMAGE_REQUEST_EVENT, {
      detail: { requestId, ...reference },
    }));
  });
}

export function getInstagramMediaReference(candidates, image) {
  for (const candidate of candidates) {
    let url;
    try {
      url = new URL(candidate.url);
    } catch {
      continue;
    }
    if (!isInstagramImageUrl(url.href)) continue;

    const cacheKey = url.searchParams.get("ig_cache_key");
    let mediaId = "";
    try {
      const encodedMediaId = (cacheKey || "").split(".")[0];
      mediaId = atob(encodedMediaId).match(/^\d+$/)?.[0] || "";
    } catch {}
    const filename = url.pathname.split("/").pop() || "";
    if (mediaId && filename) {
      const pagePermalink = getInstagramPermalink(image);
      return {
        mediaId,
        filename,
        permalink: getInstagramMediaPermalink(mediaId),
        postMediaId: getInstagramPostMediaId(pagePermalink),
      };
    }
  }
  return null;
}

export function getInstagramMediaPermalink(mediaId) {
  if (!/^\d+$/.test(mediaId || "")) return "";
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let value = BigInt(mediaId);
  let shortcode = "";
  do {
    shortcode = alphabet[Number(value % 64n)] + shortcode;
    value /= 64n;
  } while (value > 0n);
  return `/p/${shortcode}/`;
}

export function getInstagramPostMediaId(permalink) {
  const shortcode = permalink?.match(
    /^\/(?:p|reel)\/([\w-]+)\/?(?:\?[^#]*)?$/,
  )?.[1];
  if (!shortcode) return "";

  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let mediaId = 0n;
  for (const character of shortcode) {
    const value = alphabet.indexOf(character);
    if (value < 0) return "";
    mediaId = (mediaId * 64n) + BigInt(value);
  }
  return mediaId.toString();
}

function getInstagramPermalink(image) {
  const directLink = image?.closest?.('a[href*="/p/"], a[href*="/reel/"]');
  const articleLink = image?.closest?.("article")?.querySelector?.(
    'a[href*="/p/"], a[href*="/reel/"]',
  );
  const dialogLink = image?.closest?.('[role="dialog"]')?.querySelector?.(
    'a[href*="/p/"], a[href*="/reel/"]',
  );
  const locationPath = globalThis.location?.pathname || "";
  const pagePath = /^\/(?:p|reel)\/[\w-]+\/?$/.test(locationPath)
    ? locationPath
    : "";
  const rawUrl = directLink?.href || articleLink?.href || dialogLink?.href ||
    pagePath;
  if (!rawUrl) return "";
  try {
    const url = new URL(rawUrl, document.baseURI);
    if (!/(^|\.)instagram\.com$/.test(url.hostname)) return "";
    if (!/^\/(?:p|reel)\/[\w-]+\/?$/.test(url.pathname)) return "";
    const imageIndex = url.searchParams.get("img_index");
    return imageIndex && /^\d+$/.test(imageIndex)
      ? `${url.pathname}?img_index=${imageIndex}`
      : url.pathname;
  } catch {
    return "";
  }
}
