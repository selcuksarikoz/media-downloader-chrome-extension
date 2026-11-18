import { settings } from "./state.js";

// These helpers are shared with the page bridge, the service worker and the
// extension pages. Re-export them so existing content-script imports work.
export {
  hasForbiddenFolder,
  replaceFileExtension,
  createCaptureId,
  isInstagramPage,
  isInstagramDirectVideoUrl,
  isTelegramProgressiveUrl,
} from "../shared/utils.js";

export function abortError() {
  return new DOMException("Mux canceled.", "AbortError");
}

export function getSuggestedVideoName(video) {
  const source = video.currentSrc || video.src;
  if (source && !source.startsWith("blob:")) {
    try {
      const pathname = new URL(source, document.baseURI).pathname;
      const filename = decodeURIComponent(pathname.split("/").pop() || "");
      if (filename) return filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    } catch {}
  }
  return `video-${Date.now()}.mp4`;
}

export function getTimestampedVideoName(extension = "mp4") {
  return `video-${Date.now()}.${extension}`;
}

export function getFrameCaptureFormat(captureType = settings.captureType) {
  const formats = {
    jpg: { mimeType: "image/jpeg", extension: "jpg", quality: 0.92 },
    png: { mimeType: "image/png", extension: "png" },
    webp: { mimeType: "image/webp", extension: "webp", quality: 0.92 },
  };
  return formats[captureType] ?? formats.jpg;
}

export function getClipboardImageFormat(preferredFormat) {
  if (
    typeof ClipboardItem !== "undefined" &&
    typeof ClipboardItem.supports === "function" &&
    !ClipboardItem.supports(preferredFormat.mimeType)
  ) {
    return getFrameCaptureFormat("png");
  }
  return preferredFormat;
}

export function parseSrcset(srcset) {
  if (!srcset) return [];
  return srcset
    .split(",")
    .map((candidate) => {
      const parts = candidate.trim().split(/\s+/);
      const descriptor = parts[parts.length - 1];
      const match = descriptor.match(/^(\d+(?:\.\d+)?)(w|x)$/);
      if (!match) {
        return { url: parts.join(" "), width: 0, density: 1 };
      }
      const value = Number(match[1]);
      return {
        url: parts.slice(0, -1).join(" "),
        width: match[2] === "w" ? value : 0,
        density: match[2] === "x" ? value : 1,
      };
    })
    .filter((candidate) => candidate.url);
}
