import {
  capturedVideos,
  dismissedPopupVideoIds,
  popupVideoStatuses,
  activeBlobJobIds,
  activeIndependentMuxes,
} from './state.js';
import { BLOB_STATUS_EVENT, BLOB_MUX_RESULT_EVENT } from './constants.js';
import { releaseMuxUrl } from './blob-mux.js';
import { processAllMedia } from './media-tracking.js';
import { downloadMedia } from './media-download.js';

chrome.runtime.onMessage.addListener((message) => {
  if (message?.action === "independentMuxResult" && message.muxId) {
    const entry = [...activeIndependentMuxes.values()].find(
      (candidate) => candidate.muxId === message.muxId,
    );
    if (!entry) return;
    for (const [videoId, candidate] of activeIndependentMuxes) {
      if (candidate === entry) activeIndependentMuxes.delete(videoId);
    }
    if (message.ok) entry.resolve(message);
    else {
      const error = new Error(message.error || "Independent mux failed.");
      if (message.canceled) error.name = "AbortError";
      entry.reject(error);
    }
    return;
  }
  if (message?.action === "releaseMuxUrl" && message.url) {
    releaseMuxUrl(message.url);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.action === "getPopupMedia") {
    sendResponse({ ok: true, media: getPopupMediaList() });
    return;
  }
  if (message?.action === "independentMuxProgress" && message.videoId) {
    window.dispatchEvent(
      new CustomEvent(BLOB_STATUS_EVENT, {
        detail: {
          videoId: message.videoId,
          status: "progress",
          message: message.message,
          progress: message.progress,
        },
      }),
    );
    sendResponse({ ok: true });
    return;
  }
  if (message?.action === "removePopupMedia" && message.videoId) {
    dismissedPopupVideoIds.add(message.videoId);
    sendResponse({ ok: true, media: getPopupMediaList() });
    return;
  }
  if (message?.action === "clearPopupMedia") {
    capturedVideos.forEach((_video, videoId) => {
      dismissedPopupVideoIds.add(videoId);
    });
    sendResponse({ ok: true, media: [] });
    return;
  }
  if (message?.action === "rescanPopupMedia") {
    dismissedPopupVideoIds.clear();
    processAllMedia();
    sendResponse({ ok: true, media: getPopupMediaList() });
    return;
  }
  if (message?.action === "downloadPopupMedia" && message.videoId) {
    const video = capturedVideos.get(message.videoId);
    if (!video?.isConnected) {
      sendResponse({ ok: false, error: "This video is no longer on the page." });
      return;
    }
    if (activeBlobJobIds.has(message.videoId)) {
      sendResponse({ ok: false, error: "This video is already downloading." });
      return;
    }
    downloadMedia(video)
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error?.message || "Video download failed.",
        })
      );
    return true;
  }
});

export function getPopupMediaList() {
  let position = 0;
  const media = [];
  capturedVideos.forEach((video, videoId) => {
    if (
      !video?.isConnected ||
      dismissedPopupVideoIds.has(videoId) ||
      !(video.currentSrc || video.src)
    ) {
      return;
    }
    position += 1;
    const source = video.currentSrc || video.src;
    let sourceLabel = "Page stream";
    if (source.startsWith("blob:")) {
      sourceLabel = "Blob stream";
    } else {
      try {
        sourceLabel = new URL(source, document.baseURI).hostname;
      } catch {}
    }
    const poster = video.poster || "";
    const downloadStatus = popupVideoStatuses.get(videoId);
    media.push({
      id: videoId,
      title: `Video ${position}`,
      pageTitle: document.title || location.hostname,
      sourceLabel,
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      width: video.videoWidth || 0,
      height: video.videoHeight || 0,
      poster:
        /^(?:https?:|data:image\/)/i.test(poster) ? poster : "",
      active: activeBlobJobIds.has(videoId),
      playing: !video.paused && !video.ended,
      downloadStatus,
    });
  });
  return media;
}
