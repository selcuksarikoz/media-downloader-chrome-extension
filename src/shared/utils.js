/**
 * Small, environment-agnostic helpers used by more than one extension world
 * (page bridge, isolated content script, service worker, extension pages).
 *
 * This module must not import from feature modules so every entry point can
 * use it without pulling in unrelated state or UI code.
 */

/** Whether the download folder contains the extension's reserved directory. */
export function hasForbiddenFolder(folder) {
  const value = typeof folder === "string" ? folder.trim() : "";
  return value.split(/[/\\]+/).some((part) => part.toLowerCase() === "imgdownloader_files");
}

/** Replace a filename's extension, falling back to a timestamped video name. */
export function replaceFileExtension(filename, extension) {
  const base = (filename || `video-${Date.now()}`).replace(/\.[^.]+$/, "");
  return `${base}.${extension}`;
}

/** Random hexadecimal fallback for environments without crypto.randomUUID. */
function randomIdPart() {
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    const values = new Uint32Array(4);
    globalThis.crypto.getRandomValues(values);
    return Array.from(values, (value) => value.toString(16)).join("-");
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Stable ID for tracked media. Works on insecure (HTTP) pages too. */
export function createCaptureId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `imd-${randomIdPart()}`;
}

/** Correlation ID for cross-world request/response events. */
export function createRequestId(prefix = "ig") {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }
  return `${prefix}-${randomIdPart()}`;
}

/** Read a Blob as a `data:` URL using FileReader. */
export function readBlobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Blob read failed."));
    reader.readAsDataURL(blob);
  });
}

/** Coerce a value to a positive finite dimension, defaulting to zero. */
export function toDimension(value) {
  const dimension = Number(value);
  return Number.isFinite(dimension) && dimension > 0 ? dimension : 0;
}

/** Clamp a number to the inclusive [min, max] range. */
export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/** Whether the current page is instagram.com or one of its subdomains. */
export function isInstagramPage() {
  const hostname = globalThis.location?.hostname || "";
  return hostname === "instagram.com" || hostname.endsWith(".instagram.com");
}

/** Whether a URL points directly at an Instagram CDN video. */
export function isInstagramDirectVideoUrl(value) {
  if (!isInstagramPage()) return false;
  try {
    const url = new URL(value, globalThis.document?.baseURI);
    return (
      url.protocol === "https:" &&
      (url.hostname.endsWith(".fbcdn.net") || url.hostname.endsWith(".cdninstagram.com"))
    );
  } catch {
    return false;
  }
}

/** Whether a URL is a Telegram progressive (streaming) video endpoint. */
export function isTelegramProgressiveUrl(value) {
  try {
    const url = new URL(value, globalThis.document?.baseURI);
    return (
      url.protocol === "https:" &&
      url.hostname === "web.telegram.org" &&
      /\/progressive\//i.test(url.pathname)
    );
  } catch {
    return false;
  }
}
