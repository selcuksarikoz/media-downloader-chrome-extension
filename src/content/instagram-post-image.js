import { instagramPostImageRequests, storeInstagramImageCandidate } from "./state.js";
import {
  getInstagramMediaIdFromShortcode,
  getInstagramImageAssetKeys,
  isResizedInstagramImageUrl,
} from "../shared/instagram-image.js";
import {
  INSTAGRAM_POST_IMAGE_REQUEST_EVENT,
  INSTAGRAM_POST_IMAGE_RESULT_EVENT,
} from "./constants.js";
import { isInstagramPage, createRequestId } from "../shared/utils.js";

const MAX_CACHED_POSTS = 40;
const MAX_CANDIDATES_PER_ASSET = 20;
const REQUEST_TIMEOUT_MS = 6000;
const UPGRADE_MIN_WIDTH = 1440;
const pendingRequests = new Map();

function receiveResult(event) {
  const { requestId, candidates } = event.detail || {};
  const pending = pendingRequests.get(requestId);
  if (!pending) return;
  pendingRequests.delete(requestId);
  clearTimeout(pending.timer);
  pending.resolve(Array.isArray(candidates) ? candidates : []);
}

function requestPostCandidates(mediaId, shortcode) {
  return new Promise((resolve) => {
    const requestId = createRequestId();
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      resolve([]);
    }, REQUEST_TIMEOUT_MS);
    pendingRequests.set(requestId, { resolve, timer });
    window.dispatchEvent(
      new CustomEvent(INSTAGRAM_POST_IMAGE_REQUEST_EVENT, {
        detail: { requestId, mediaId, shortcode },
      }),
    );
  });
}

function getPostReference(img) {
  const link = img.closest?.('a[href*="/p/"], a[href*="/reel/"], a[href*="/reels/"]');
  if (!link) return null;
  const match = (link.getAttribute("href") || "").match(/\/(?:p|reel|reels)\/([\w-]+)/);
  if (!match) return null;
  const mediaId = getInstagramMediaIdFromShortcode(match[1]);
  return mediaId ? { mediaId, shortcode: match[1] } : null;
}

function storeCandidates(candidates) {
  for (const candidate of candidates) {
    if (typeof candidate?.url !== "string") continue;
    const entry = {
      url: candidate.url,
      width: Number(candidate.width) || 0,
      height: Number(candidate.height) || 0,
    };
    getInstagramImageAssetKeys(entry.url, document.baseURI).forEach((assetKey) =>
      storeInstagramImageCandidate(assetKey, entry, MAX_CANDIDATES_PER_ASSET),
    );
  }
}

function cachePost(mediaId, promise) {
  instagramPostImageRequests.set(mediaId, promise);
  while (instagramPostImageRequests.size > MAX_CACHED_POSTS) {
    instagramPostImageRequests.delete(instagramPostImageRequests.keys().next().value);
  }
  return promise;
}

/** Whether the current best URL is a downscaled Instagram variant. */
export function needsInstagramOriginal(best) {
  if (!best) return false;
  return (
    best.estimatedWidth < UPGRADE_MIN_WIDTH ||
    isResizedInstagramImageUrl(best.url, document.baseURI)
  );
}

/**
 * Fetch the post behind a feed image so its full-resolution variants join the
 * candidate list. Feed payloads only carry 1080-wide URLs; the post data does
 * not. Results are cached per media id, so acting on a carousel asks once.
 */
export async function upgradeInstagramImageCandidates(img, best) {
  if (!needsInstagramOriginal(best)) return false;
  if (!isInstagramPage()) return false;
  const reference = getPostReference(img);
  if (!reference) return false;

  let request = instagramPostImageRequests.get(reference.mediaId);
  if (!request) {
    request = requestPostCandidates(reference.mediaId, reference.shortcode);
    cachePost(reference.mediaId, request);
    request.then((candidates) => {
      if (candidates.length === 0) {
        instagramPostImageRequests.delete(reference.mediaId);
      }
    });
  }
  const candidates = await request;
  if (candidates.length === 0) return false;
  storeCandidates(candidates);
  return true;
}

export function initInstagramPostImageUpgrade() {
  if (!isInstagramPage()) return;
  window.addEventListener(INSTAGRAM_POST_IMAGE_RESULT_EVENT, receiveResult);
}
