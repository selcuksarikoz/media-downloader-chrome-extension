import {
  settings, canceledBlobJobs, blobDownloadRequests, activeBlobJobIds,
  activeDirectDownloadIds, blobJobIntent, pendingVideoActionIds,
} from './state.js';
import {
  getSuggestedVideoName, isTelegramProgressiveUrl, isInstagramDirectVideoUrl,
  isInstagramPage,
} from './utils.js';
import {
  BLOB_DOWNLOAD_EVENT, PAGE_MEDIA_DOWNLOAD_EVENT,
} from './constants.js';
import { sendBlobStoreMessage } from './blob-store.js';
import { showToast } from './toast.js';
import { refreshMediaActionState } from './action-ui.js';
import {
  resolveHighestResolutionImageUrl,
} from './image-resolution.js';
import {
  resolveHighestResolutionVideoUrl,
} from './video-resolution.js';
import { captureVideoFrame } from './capture-core.js';

/** Download the highest resolution version of an image or video. */
export async function downloadMedia(media, preferredUrl) {
  const requestedVideoId = media.tagName === "VIDEO"
    ? media.dataset.imdCaptureId
    : null;
  if (
    requestedVideoId &&
    (
      pendingVideoActionIds.has(requestedVideoId) ||
      activeBlobJobIds.has(requestedVideoId) ||
      activeDirectDownloadIds.has(requestedVideoId)
    )
  ) {
    showToast("A video operation is already in progress.");
    return;
  }
  const releasePendingAction = () => {
    if (!requestedVideoId) return;
    pendingVideoActionIds.delete(requestedVideoId);
    refreshMediaActionState(media);
  };
  if (requestedVideoId) {
    pendingVideoActionIds.add(requestedVideoId);
    refreshMediaActionState(media);
  }

  let src;
  try {
    src = preferredUrl || (media.tagName === "IMG"
      ? await resolveHighestResolutionImageUrl(media)
      : await resolveHighestResolutionVideoUrl(media));
  } catch (error) {
    releasePendingAction();
    throw error;
  }
  if (!src) {
    releasePendingAction();
    showToast("Media source is not available.");
    return;
  }

  if (media.tagName === "VIDEO" && src.startsWith("blob:")) {
    await streamBlobVideo(media, src);
    releasePendingAction();
    return;
  }

  if (media.tagName === "VIDEO" && isTelegramProgressiveUrl(src)) {
    streamPageVideo(media, src);
    releasePendingAction();
    return;
  }

  if (
    media.tagName === "VIDEO" &&
    isInstagramDirectVideoUrl(src)
  ) {
    streamPageVideo(media, src);
    releasePendingAction();
    return;
  }

  const directVideoId = requestedVideoId;
  if (directVideoId) {
    activeDirectDownloadIds.add(directVideoId);
  }
  releasePendingAction();

  let response;
  try {
    response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        action: "download",
        url: src,
        mediaType: media.tagName === "VIDEO" ? "video" : "image",
        videoId: directVideoId,
        folder: settings.downloadFolder,
        saveAs: settings.showSaveAs,
      }, (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(result);
      });
    });
  } catch (error) {
    if (directVideoId) {
      activeDirectDownloadIds.delete(directVideoId);
      refreshMediaActionState(media);
    }
    throw error;
  }
  if (!response?.ok) {
    if (directVideoId) {
      activeDirectDownloadIds.delete(directVideoId);
      refreshMediaActionState(media);
    }
    throw new Error(response?.error || "Download failed.");
  }
  if (response.anchor) await saveThroughAnchor(response.anchor);
  showToast(
    media.tagName === "VIDEO"
      ? "Video download started."
      : "Image download started.",
  );
}

/** Save bytes the worker fetched with the browser's own download flow. */
async function saveThroughAnchor({ href, filename }) {
  const blobUrl = URL.createObjectURL(await (await fetch(href)).blob());
  const anchor = document.createElement("a");
  anchor.href = blobUrl;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
}

/** Open a preview tab for an image or captured video frame. */
export async function previewMedia(media, preferredUrl) {
  if (media.tagName === "VIDEO") {
    const { blobUrl, dataUrl } = await captureVideoFrame(media);
    try {
      if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
        throw new Error("Captured video frame is not a valid image.");
      }
      await openPreviewInBackground(dataUrl);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
    return;
  }

  if (preferredUrl) {
    await openPreviewInBackground(preferredUrl);
    return;
  }

  const url = await resolveHighestResolutionImageUrl(media);
  if (!url) throw new Error("Image has no preview URL.");
  await openPreviewInBackground(url);
}

/** Open a URL in the background preview tab via the extension runtime. */
function openPreviewInBackground(url) {
  if (typeof url !== "string" || !url) {
    throw new TypeError("Preview URL must be a non-empty string.");
  }
  const runtime = globalThis.chrome?.runtime;
  if (typeof runtime?.sendMessage !== "function") {
    throw new Error(
      "Extension context is unavailable. Reload the page.",
    );
  }

  return new Promise((resolve, reject) => {
    runtime.sendMessage({ action: "preview", url }, (response) => {
      if (runtime.lastError) {
        reject(new Error(runtime.lastError.message));
        return;
      }
      if (response?.ok !== true) {
        reject(new Error(response?.error || "Preview failed."));
        return;
      }
      showToast("Preview opened.");
      resolve();
    });
  });
}

/** Register and dispatch a streamed video download job. */
function startStreamedDownload(video, url, filename, eventName) {
  const detail = {
    url,
    filename,
    videoId: video.dataset.imdCaptureId,
  };
  canceledBlobJobs.delete(detail.videoId);
  blobDownloadRequests.set(detail.videoId, detail);
  blobJobIntent.set(detail.videoId, "download");
  showToast("Video download started.");
  sendBlobStoreMessage({
    action: "job-start",
    jobId: detail.videoId,
    filename: detail.filename,
    folder: settings.downloadFolder,
    saveAs: settings.showSaveAs,
  });
  window.dispatchEvent(new CustomEvent(eventName, { detail }));
}

/** Download a page-owned media URL through the page's Service Worker. */
function streamPageVideo(video, url) {
  const filename = isInstagramPage()
    ? `video-${Date.now()}.mp4`
    : getSuggestedVideoName(video);
  startStreamedDownload(video, url, filename, PAGE_MEDIA_DOWNLOAD_EVENT);
}

/** Start streaming a blob video for download via the media bridge. */
function streamBlobVideo(video, url) {
  startStreamedDownload(
    video,
    url,
    getSuggestedVideoName(video),
    BLOB_DOWNLOAD_EVENT,
  );
}

/** Toggle Picture-in-Picture mode for a video element. */
export function togglePictureInPicture(video) {
  if (document.pictureInPictureElement === video) {
    document
      .exitPictureInPicture()
      .then(() => showToast("Picture-in-Picture closed."))
      .catch((error) => {
        console.error(error);
        showToast("Failed to close Picture-in-Picture.");
      });
  } else {
    video
      .requestPictureInPicture()
      .then(() => showToast("Picture-in-Picture enabled."))
      .catch((error) => {
        console.error(error);
        showToast("Picture-in-Picture is not available.");
      });
  }
}
