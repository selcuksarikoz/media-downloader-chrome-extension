import { parseSrcset } from './utils.js';

export function getHighestResolutionImageUrl(img) {
  const candidates = parseSrcset(img.getAttribute("srcset"));
  if (candidates.length > 0) {
    const baseWidth = img.naturalWidth || img.width || 1;
    const ranked = candidates
      .map((candidate, index) => ({ candidate, index }))
      .sort((a, b) => {
        const diff =
          estimateCandidateWidth(b.candidate, baseWidth) -
          estimateCandidateWidth(a.candidate, baseWidth);
        return diff || b.index - a.index;
      });
    return new URL(ranked[0].candidate.url, document.baseURI).href;
  }
  return img.currentSrc || img.src;
}

/** Estimate an image's pixel width for cross-unit srcset comparison. */
function estimateCandidateWidth(candidate, baseWidth) {
  return candidate.width > 0 ? candidate.width : candidate.density * baseWidth;
}

/** Resolve the best declared/original URL without loading probe images. */
export async function resolveHighestResolutionImageUrl(img) {
  return getHighestResolutionImageUrl(img);
}
