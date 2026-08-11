/** Measure the pixel dimensions of a video by probing its metadata. */
export function measureVideoDimensions(url) {
  return new Promise((resolve) => {
    const probe = document.createElement("video");
    probe.preload = "metadata";
    probe.muted = true;
    probe.playsInline = true;
    probe.crossOrigin = "anonymous";
    let settled = false;
    const finish = (w, h) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      probe.onloadeddata = null;
      probe.onloadedmetadata = null;
      probe.onerror = null;
      probe.removeAttribute("src");
      probe.load();
      resolve(w > 0 && h > 0 ? { width: w, height: h } : null);
    };
    const timeout = setTimeout(() => finish(0, 0), 15000);
    probe.onloadeddata = () => finish(probe.videoWidth, probe.videoHeight);
    probe.onloadedmetadata = () => {
      if (probe.videoWidth > 0 && probe.videoHeight > 0) {
        finish(probe.videoWidth, probe.videoHeight);
      }
    };
    probe.onerror = () => finish(0, 0);
    probe.src = url;
    probe.load();
  });
}

/** Measure the pixel area of a video by probing its metadata. */
function measureVideoResolution(url) {
  return measureVideoDimensions(url).then(
    (dims) => (dims ? dims.width * dims.height : 0),
  );
}

/** Get the currently active source URL from a video element. */
export function getVideoUrl(video) {
  if (video.currentSrc) return video.currentSrc;
  if (video.src) return video.src;

  const source = Array.from(video.querySelectorAll("source[src]")).find(
    (item) => item.src,
  );
  return source ? source.src : "";
}

/** Find the highest quality video source URL among all candidates. */
export async function resolveHighestResolutionVideoUrl(video) {
  const candidates = collectVideoCandidates(video);
  if (candidates.length === 0) return getVideoUrl(video);
  if (candidates.length === 1) return candidates[0].url;

  const measured = await Promise.all(
    candidates.map(async ({ url }) => ({
      url,
      pixels: await measureVideoResolution(url),
    })),
  );
  const best = measured.reduce((a, b) => (a.pixels >= b.pixels ? a : b));
  return best.pixels > 0
    ? best.url
    : candidates.sort((a, b) => b.score - a.score)[0].url;
}

/** Collect all non-blob source URLs from a video and its source elements. */
function collectVideoCandidates(video) {
  const seen = new Map();

  const add = (url, source) => {
    if (!url || url.startsWith("blob:") || seen.has(url)) return;
    seen.set(url, source);
  };

  add(video.currentSrc, null);
  add(video.src, null);

  video.querySelectorAll("source").forEach((el) => {
    if (el.src) add(el.src, el);
  });

  return Array.from(seen.entries()).map(([url, source]) => ({
    url,
    score: scoreVideoSource(url, source),
  }));
}

/** Score a video source URL by resolution hints (media queries, labels, dimensions). */
function scoreVideoSource(url, source) {
  let score = 1;

  if (source) {
    const media = source.getAttribute("media") || "";
    const mw = media.match(/min-width\s*:\s*(\d+)/);
    if (mw) score = Math.max(score, parseInt(mw[1], 10));
    const mh = media.match(/min-height\s*:\s*(\d+)/);
    if (mh) score = Math.max(score, parseInt(mh[1], 10));
  }

  const res = url.match(/(\d{3,4})p/i);
  if (res) score = Math.max(score, parseInt(res[1], 10) * 1.78);

  const dims = url.match(/(\d{3,4})x(\d{3,4})/);
  if (dims) score = Math.max(score, parseInt(dims[1], 10));

  return score;
}
