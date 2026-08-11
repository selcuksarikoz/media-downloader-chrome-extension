import {
  BLOB_STORE_PORT_NAME, BLOB_PERSIST_CHUNK_EVENT, CAPTURE_FROM_MSE_EVENT,
  CAPTURE_FROM_MSE_RESULT_EVENT, BLOB_MUX_EVENT, BLOB_MUX_RESULT_EVENT,
} from './constants.js';
import {
  mseCapturePending, blobStorePort,
  blobStorePending, canceledBlobJobs, settings,
  allocateMseCaptureSeq, setBlobStorePort, allocateBlobStoreSeq,
} from './state.js';
import { abortError } from './utils.js';
import { muxTracksIndependently, muxTracksLocally, releaseMuxUrl } from './blob-mux.js';

export function downloadMuxUrl(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        action: "downloadMuxUrl",
        url,
        filename,
        folder: settings.downloadFolder,
        saveAs: settings.showSaveAs,
      },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response?.ok) {
          reject(new Error(response?.error || "Muxed video download failed."));
          return;
        }
        resolve();
      },
    );
  });
}

function replaceFileExtension(filename, extension) {
  const base = (filename || `video-${Date.now()}`).replace(/\.[^.]+$/, "");
  return `${base}.${extension}`;
}

window.addEventListener(CAPTURE_FROM_MSE_RESULT_EVENT, (event) => {
  const { requestId, blob } = event.detail || {};
  const pending = mseCapturePending.get(requestId);
  if (!pending) return;
  mseCapturePending.delete(requestId);
  clearTimeout(pending.timer);
  pending.resolve(blob || null);
});

export function requestMediaSourceBlob(url, timeout = 4000) {
  return new Promise((resolve) => {
    const id = `mse-capture-${allocateMseCaptureSeq()}`;
    const timer = setTimeout(() => {
      if (mseCapturePending.delete(id)) resolve(null);
    }, timeout);
    mseCapturePending.set(id, { resolve, timer });
    try {
      window.dispatchEvent(
        new CustomEvent(CAPTURE_FROM_MSE_EVENT, {
          detail: { url, requestId: id },
        }),
      );
    } catch {
      clearTimeout(timer);
      mseCapturePending.delete(id);
      resolve(null);
    }
  });
}

export function getBlobStorePort() {
  if (blobStorePort) return blobStorePort;
  try {
    const port = chrome.runtime.connect({ name: BLOB_STORE_PORT_NAME });
    setBlobStorePort(port);
  } catch {
    return null;
  }
  blobStorePort.onDisconnect.addListener(() => {
    setBlobStorePort(null);
  });
  blobStorePort.onMessage.addListener((msg) => {
    if (!msg?.requestId) return;
    const pending = blobStorePending.get(msg.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    blobStorePending.delete(msg.requestId);
    pending.resolve(msg.ok === true);
  });
  return blobStorePort;
}

export function sendBlobStoreMessage(message) {
  return new Promise((resolve) => {
    const port = getBlobStorePort();
    if (!port) {
      resolve(false);
      return;
    }
    const requestId = `m${allocateBlobStoreSeq()}`;
    message.requestId = requestId;
    const timer = setTimeout(() => {
      blobStorePending.delete(requestId);
      resolve(false);
    }, 15000);
    blobStorePending.set(requestId, { resolve, timer });
    try {
      port.postMessage(message);
    } catch {
      clearTimeout(timer);
      blobStorePending.delete(requestId);
      resolve(false);
    }
  });
}

window.addEventListener(BLOB_PERSIST_CHUNK_EVENT, (event) => {
  const { videoId, blob } = event.detail || {};
  if (!videoId || !blob || !blob.size) return;
  sendBlobStoreMessage({ action: "chunk", jobId: videoId, blob });
});

window.addEventListener(BLOB_MUX_EVENT, async (event) => {
  const { requestId, videoId, filename, tracks, startTime, duration } =
    event.detail || {};
  if (!requestId || !videoId || !tracks?.length) return;
  let response = { ok: false };
  try {
    if (canceledBlobJobs.has(videoId)) throw abortError();
    if (tracks.every((track) => track.url && !track.blob)) {
      await muxTracksIndependently(videoId, filename, tracks, startTime, duration);
      response = { ok: true };
      window.dispatchEvent(
        new CustomEvent(BLOB_MUX_RESULT_EVENT, {
          detail: { requestId, ...response },
        }),
      );
      return;
    }
    const result = await muxTracksLocally(videoId, tracks, startTime, duration);
    if (canceledBlobJobs.has(videoId)) throw abortError();
    const outputName = replaceFileExtension(filename, result.extension);
    try {
      await downloadMuxUrl(result.url, outputName);
    } catch (error) {
      releaseMuxUrl(result.url);
      throw error;
    }
    response = { ok: true };
  } catch (error) {
    response = {
      ok: false,
      canceled: error?.name === "AbortError",
      error: error?.message || String(error),
    };
  }
  window.dispatchEvent(
    new CustomEvent(BLOB_MUX_RESULT_EVENT, {
      detail: { requestId, ...response },
    }),
  );
});
