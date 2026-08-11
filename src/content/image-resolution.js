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

/** Find the highest resolution image URL by measuring actual pixel area of candidates. */
export async function resolveHighestResolutionImageUrl(img) {
  const candidates = collectImageCandidates(img);
  if (!candidates.length) return getHighestResolutionImageUrl(img);
  if (candidates.length === 1) return candidates[0];

  const measured = await Promise.all(
    candidates.map(async (url, index) => ({
      url,
      index,
      area: await measureImageArea(url),
    })),
  );
  measured.sort((a, b) => b.area - a.area || b.index - a.index);
  return measured[0]?.area > 0
    ? measured[0].url
    : getHighestResolutionImageUrl(img);
}

/** Collect all candidate URLs for an image (src, srcset, nearby siblings). */
function collectImageCandidates(img) {
  const urls = new Set();
  const addUrl = (value) => {
    if (!value) return;
    try {
      urls.add(new URL(value, document.baseURI).href);
    } catch {}
  };

  addUrl(img.currentSrc);
  addUrl(img.src);
  parseSrcset(img.getAttribute("srcset")).forEach(({ url }) => addUrl(url));

  let sourcePath = "";
  try {
    sourcePath = new URL(img.currentSrc || img.src).pathname;
  } catch {
    return Array.from(urls);
  }

  const container =
    img.closest("article, [role='dialog']") || img.parentElement;
  container?.querySelectorAll("img").forEach((candidate) => {
    const values = [candidate.currentSrc, candidate.src];
    parseSrcset(candidate.getAttribute("srcset")).forEach(({ url }) =>
      values.push(url),
    );
    values.forEach((value) => {
      try {
        const url = new URL(value, document.baseURI);
        if (url.pathname === sourcePath) addUrl(url.href);
      } catch {}
    });
  });

  Array.from(urls).forEach((value) => {
    const url = new URL(value);
    if (!url.hostname.includes("cdninstagram.com")) return;

    const withoutTransform = new URL(url);
    withoutTransform.searchParams.delete("stp");
    urls.add(withoutTransform.href);

    const originalCandidate = new URL(withoutTransform);
    originalCandidate.searchParams.delete("efg");
    urls.add(originalCandidate.href);
  });

  return Array.from(urls);
}

/** Measure the pixel area of an image by loading it in an off-screen probe. */
function measureImageArea(url) {
  return new Promise((resolve) => {
    const probe = new Image();
    probe.decoding = "async";
    let settled = false;
    const finish = (area) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        probe.onload = null;
        probe.onerror = null;
        probe.src = "";
        resolve(area);
      }
    };
    const timeout = setTimeout(() => finish(0), 5000);
    probe.onload = () => finish(probe.naturalWidth * probe.naturalHeight);
    probe.onerror = () => finish(0);
    probe.src = url;
  });
}
