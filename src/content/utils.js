import { settings } from './state.js';

export function abortError() {
  return new DOMException("Mux canceled.", "AbortError");
}

export function replaceFileExtension(filename, extension) {
  const base = (filename || `video-${Date.now()}`).replace(/\.[^.]+$/, "");
  return `${base}.${extension}`;
}

export function hasForbiddenFolder(folder) {
  return folder
    .split(/[\/\\]+/)
    .some((part) => part.toLowerCase() === "imgdownloader_files");
}

export function createCaptureId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    const values = new Uint32Array(4);
    globalThis.crypto.getRandomValues(values);
    return `imd-${Array.from(values, (value) => value.toString(16)).join("-")}`;
  }
  return `imd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
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

export function isInstagramPage() {
  return (
    location.hostname === "instagram.com" ||
    location.hostname.endsWith(".instagram.com")
  );
}

export function isInstagramDirectVideoUrl(value) {
  if (!isInstagramPage()) return false;
  try {
    const url = new URL(value, document.baseURI);
    return (
      url.protocol === "https:" &&
      (url.hostname.endsWith(".fbcdn.net") ||
        url.hostname.endsWith(".cdninstagram.com"))
    );
  } catch {
    return false;
  }
}

export function isTelegramProgressiveUrl(value) {
  try {
    const url = new URL(value, document.baseURI);
    return (
      url.protocol === "https:" &&
      url.hostname === "web.telegram.org" &&
      /\/progressive\//i.test(url.pathname)
    );
  } catch {
    return false;
  }
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
