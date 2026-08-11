import { FETCH_MEDIA_PORT_NAME } from './constants.js';

/** Fetch an image URL as a blob from the current page context. */
export async function fetchImageBlob(url) {
  const response = await fetch(url, {
    credentials: "include",
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`Image fetch failed (${response.status}).`);
  return response.blob();
}

/** Fetch an image URL as a blob through the background (bypasses CORS). */
export function fetchImageBlobViaBackground(url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let port;
    let timeout;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        port?.disconnect();
      } catch {}
      fn(value);
    };
    try {
      port = chrome.runtime.connect({ name: FETCH_MEDIA_PORT_NAME });
    } catch (error) {
      reject(error);
      return;
    }
    timeout = setTimeout(
      () => settle(reject, new Error("Image fetch timed out.")),
      30000,
    );
    port.onMessage.addListener((response) => {
      if (response?.ok && response.data) {
        settle(
          resolve,
          new Blob([response.data], { type: response.mimeType || "" }),
        );
      } else {
        settle(reject, new Error(response?.error || "Image fetch failed."));
      }
    });
    port.onDisconnect.addListener(() => {
      settle(
        reject,
        new Error(
          chrome.runtime.lastError?.message ||
            "Background fetch connection closed.",
        ),
      );
    });
    port.postMessage({ action: "fetchMedia", url });
  });
}
