import { parseSrcset } from './utils.js';

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
  const unresolved = candidates.filter(({ estimatedWidth }) => !estimatedWidth);
  if (unresolved.length > 0 && typeof Image === "function") {
    await Promise.all(unresolved.map(async (candidate) => {
      candidate.estimatedWidth = await probeImageWidth(candidate.url);
    }));
  }
  return rankImageCandidates(candidates)[0]?.url || "";
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
