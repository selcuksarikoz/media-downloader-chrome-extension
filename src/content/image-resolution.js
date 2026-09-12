import { parseSrcset } from './utils.js';
import { instagramImageUpgradeState } from './state.js';
import {
  isInstagramImageUrl,
  isResizedInstagramImageUrl,
  resolveInstagramImageCandidate,
} from './instagram-image.js';

const SRCSET_ATTRIBUTES = ["srcset", "data-srcset", "data-lazy-srcset"];
const URL_ATTRIBUTES = [
  ["data-original", true],
  ["data-original-src", true],
  ["data-orig-file", true],
  ["data-full-src", true],
  ["data-full-url", true],
  ["data-zoom-src", true],
  ["data-zoom-image", true],
  ["data-hi-res-src", true],
  ["data-large-src", true],
  ["data-large-file", true],
  ["data-lazy-src", false],
  ["data-src", false],
];
const IMAGE_PROBE_TIMEOUT_MS = 5000;
const INSTAGRAM_TRANSFORM_SEGMENTS = [
  /^(?:p|s)\d+x\d+$/i,
  /^c\d+(?:\.\d+){3}[a-z]?$/i,
  /^sh\d+(?:\.\d+)?$/i,
];

export function getHighestResolutionImageUrl(img) {
  return rankImageCandidates(collectImageCandidates(img))[0]?.url || "";
}

/** Estimate an image's pixel width for cross-unit srcset comparison. */
function estimateCandidateWidth(candidate, baseWidth) {
  return candidate.width > 0 ? candidate.width : candidate.density * baseWidth;
}

/** Collect responsive, lazy-loaded, and original image URLs declared by the image. */
export function collectImageCandidates(img) {
  const candidates = new Map();
  let order = 0;
  const baseWidth = img.naturalWidth || img.width || img.clientWidth || 1;

  const add = (rawUrl, estimatedWidth = 0, originalHint = false) => {
    if (typeof rawUrl !== "string" || !rawUrl.trim()) return;
    let url;
    try {
      url = new URL(rawUrl.trim(), document.baseURI).href;
    } catch {
      return;
    }
    const existing = candidates.get(url);
    if (existing) {
      existing.estimatedWidth = Math.max(
        existing.estimatedWidth,
        estimatedWidth,
      );
      existing.originalHint ||= originalHint;
      existing.order = order++;
      return;
    }
    candidates.set(url, { url, estimatedWidth, originalHint, order: order++ });

    const originalInstagramUrl = getOriginalInstagramImageUrl(url);
    if (originalInstagramUrl && !candidates.has(originalInstagramUrl)) {
      candidates.set(originalInstagramUrl, {
        url: originalInstagramUrl,
        estimatedWidth: 0,
        originalHint: true,
        order: order++,
      });
    }
  };

  const picture = img.parentElement?.tagName === "PICTURE"
    ? img.parentElement
    : img.closest?.("picture");
  const declaredElements = [
    img,
    ...(picture ? picture.querySelectorAll("source") : []),
  ];

  declaredElements.forEach((element) => {
    SRCSET_ATTRIBUTES.forEach((attribute) => {
      parseSrcset(element.getAttribute(attribute)).forEach((candidate) => {
        add(candidate.url, estimateCandidateWidth(candidate, baseWidth));
      });
    });
    URL_ATTRIBUTES.forEach(([attribute, originalHint]) => {
      add(element.getAttribute(attribute), 0, originalHint);
    });
  });

  add(img.src, img.naturalWidth || 0);
  add(img.currentSrc, img.naturalWidth || 0);
  return [...candidates.values()];
}

/** Remove Instagram CDN thumbnail transforms while preserving signed params. */
function getOriginalInstagramImageUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return "";
  }
  if (!url.hostname.endsWith(".cdninstagram.com")) return "";

  const transform = url.searchParams.get("stp");
  if (!transform) return "";
  const originalTransform = transform
    .split("_")
    .filter((segment) =>
      !INSTAGRAM_TRANSFORM_SEGMENTS.some((pattern) => pattern.test(segment)),
    )
    .join("_");
  if (!originalTransform || originalTransform === transform) return "";

  url.searchParams.set("stp", originalTransform);
  return url.href;
}

function rankImageCandidates(candidates) {
  return [...candidates].sort((a, b) => {
    const widthDiff = b.estimatedWidth - a.estimatedWidth;
    if (widthDiff) return widthDiff;
    if (a.originalHint !== b.originalHint) return b.originalHint ? 1 : -1;
    return b.order - a.order;
  });
}

/** Resolve the widest declared URL, probing candidates without size descriptors. */
export async function resolveHighestResolutionImageUrl(img) {
  const candidates = collectImageCandidates(img);
  const instagramCandidate = await resolveInstagramImageCandidate(
    candidates,
    img,
  );
  if (
    instagramCandidate &&
    !candidates.some(({ url }) => url === instagramCandidate.url)
  ) {
    candidates.push({
      ...instagramCandidate,
      estimatedWidth: 0,
      originalHint: true,
      order: candidates.length,
    });
  }
  const unresolved = candidates.filter(({ estimatedWidth }) => !estimatedWidth);
  if (unresolved.length > 0 && typeof Image === "function") {
    await Promise.all(unresolved.map(async (candidate) => {
      candidate.estimatedWidth = await probeImageWidth(candidate.url);
    }));
  }
  return rankImageCandidates(candidates)[0]?.url || "";
}

/** Quickly test a URL with Instagram's explicit resize transforms removed. */
export async function resolveDirectInstagramImageUrl(img) {
  const source = img.currentSrc || img.src;
  const directUrl = getOriginalInstagramImageUrl(source);
  if (!directUrl) return "";
  const width = await probeImageWidth(directUrl);
  return width > (img.naturalWidth || 0) ? directUrl : "";
}

/** Replace a visible Instagram thumbnail with its signed original source. */
export function upgradeInstagramImageSource(img) {
  const source = img.currentSrc || img.src;
  if (!isInstagramImageUrl(source)) return Promise.resolve(false);

  const active = instagramImageUpgradeState.get(img);
  if (active?.source === source || active?.source === img.src) {
    return active.promise;
  }

  const sourceFilename = getUrlFilename(source);
  let promise;
  const applyResolvedUrl = (resolvedUrl) => {
    const currentSource = img.currentSrc || img.src;
    if (instagramImageUpgradeState.get(img)?.promise !== promise) {
      return false;
    }
    if (!img.isConnected) return false;
    if (getUrlFilename(currentSource) !== sourceFilename) return false;
    if (!resolvedUrl || resolvedUrl === currentSource) return false;
    if (getUrlFilename(resolvedUrl) !== sourceFilename) return false;
    if (isResizedInstagramImageUrl(resolvedUrl)) return false;

    img.decoding = "async";
    img.srcset = resolvedUrl;
    img.src = resolvedUrl;
    instagramImageUpgradeState.set(img, {
      source: resolvedUrl,
      promise,
      resolved: true,
    });
    return true;
  };
  promise = Promise.all([
    resolveDirectInstagramImageUrl(img)
      .then(applyResolvedUrl)
      .catch(() => false),
    resolveHighestResolutionImageUrl(img)
      .then(applyResolvedUrl)
      .catch(() => false),
  ])
    .then((results) => results.some(Boolean))
    .finally(() => {
      const state = instagramImageUpgradeState.get(img);
      if (state?.promise === promise && !state.resolved) {
        instagramImageUpgradeState.delete(img);
      }
    });
  instagramImageUpgradeState.set(img, { source, promise });
  return promise;
}

function getUrlFilename(value) {
  try {
    return new URL(value, document.baseURI).pathname.split("/").pop() || "";
  } catch {
    return "";
  }
}

function probeImageWidth(url) {
  return new Promise((resolve) => {
    const probe = new Image();
    probe.decoding = "async";
    let settled = false;
    const finish = (width = 0, cancel = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      probe.onload = null;
      probe.onerror = null;
      if (cancel) probe.removeAttribute("src");
      resolve(width);
    };
    const timer = setTimeout(
      () => finish(0, true),
      IMAGE_PROBE_TIMEOUT_MS,
    );
    probe.onload = () => finish(probe.naturalWidth || 0);
    probe.onerror = () => finish();
    probe.src = url;
  });
}
