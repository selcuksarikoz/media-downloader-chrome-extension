// MAIN-world companion of `instagram-image-candidates.js`. Instagram only ships
// 1080-wide variants with the feed payload, so the full-resolution candidates
// have to be requested for the post behind the media.
import {
  extractInstagramImageCandidates,
  extractInstagramImageCandidatesFromScript,
} from "./instagram-image-candidates.js";
import {
  INSTAGRAM_POST_IMAGE_REQUEST_EVENT,
  INSTAGRAM_POST_IMAGE_RESULT_EVENT,
} from "../shared/events.js";
import { isInstagramPage } from "../shared/utils.js";

const INSTAGRAM_APP_ID = "936619743392459";
const REQUEST_TIMEOUT_MS = 8000;
const MAX_CACHED_POSTS = 40;
const posts = new Map();

function rememberPost(mediaId, promise) {
  posts.set(mediaId, promise);
  while (posts.size > MAX_CACHED_POSTS) {
    posts.delete(posts.keys().next().value);
  }
  return promise;
}

function isValidHandle(mediaId, shortcode) {
  return /^\d+$/.test(mediaId || "") && /^[\w-]{1,40}$/.test(shortcode || "");
}

async function fetchPostInfo(mediaId, signal) {
  const response = await fetch(`/api/v1/media/${mediaId}/info/`, {
    credentials: "include",
    headers: {
      "X-IG-App-ID": INSTAGRAM_APP_ID,
      "X-Requested-With": "XMLHttpRequest",
    },
    signal,
  });
  if (!response.ok || response.redirected) return [];
  return extractInstagramImageCandidates(await response.json());
}

/**
 * The permalink document embeds the same data the post page renders with, so it
 * still works when the media-info endpoint refuses the request.
 */
const PAGE_SCRIPT_PATTERN = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;

async function fetchPostPage(shortcode, signal) {
  const response = await fetch(`/p/${shortcode}/`, {
    credentials: "include",
    signal,
  });
  if (!response.ok || response.redirected) return [];
  const html = await response.text();
  const candidates = extractInstagramImageCandidatesFromScript(html);
  for (const script of html.matchAll(PAGE_SCRIPT_PATTERN)) {
    candidates.push(...extractInstagramImageCandidatesFromScript(script[1]));
  }
  return candidates;
}

async function fetchPostCandidates(mediaId, shortcode) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    try {
      const candidates = await fetchPostInfo(mediaId, controller.signal);
      if (candidates.length > 0) return candidates;
    } catch {}
    try {
      return await fetchPostPage(shortcode, controller.signal);
    } catch {
      return [];
    }
  } finally {
    clearTimeout(timer);
  }
}

function emitResult(requestId, candidates) {
  window.dispatchEvent(
    new CustomEvent(INSTAGRAM_POST_IMAGE_RESULT_EVENT, {
      detail: { requestId, candidates },
    }),
  );
}

function getPostRequest(mediaId, shortcode) {
  const cached = posts.get(mediaId);
  if (cached) return cached;
  const request = fetchPostCandidates(mediaId, shortcode);
  rememberPost(mediaId, request);
  request.then((candidates) => {
    if (candidates.length === 0) posts.delete(mediaId);
  });
  return request;
}

function handleRequest(event) {
  const { requestId, mediaId, shortcode } = event.detail || {};
  if (typeof requestId !== "string" || !requestId) return;
  if (!isValidHandle(mediaId, shortcode)) {
    emitResult(requestId, []);
    return;
  }
  getPostRequest(mediaId, shortcode).then((candidates) => emitResult(requestId, candidates));
}

export function initInstagramPostImageBridge() {
  if (!isInstagramPage()) return;
  window.addEventListener(INSTAGRAM_POST_IMAGE_REQUEST_EVENT, handleRequest);
}
