import {
  settings, canceledBlobJobs, blobDownloadRequests, activeBlobJobIds,
  activeDirectDownloadIds, blobJobIntent, finalizingBlobJobIds,
  pendingVideoActionIds, videoTrimRecordings,
} from './state.js';
import {
  getSuggestedVideoName, isTelegramProgressiveUrl, isInstagramDirectVideoUrl,
  isInstagramPage, getTimestampedVideoName,
} from './utils.js';
import {
  BLOB_DOWNLOAD_EVENT, BLOB_TRIM_EVENT, BLOB_CONTROL_EVENT,
  PAGE_MEDIA_DOWNLOAD_EVENT, TRIM_ICON, STOP_ICON,
} from './constants.js';
import { sendBlobStoreMessage } from './blob-store.js';
import { preloadFfmpeg } from './blob-mux.js';
import { downloadBlobFile } from './blob-status.js';
import { showToast } from './toast.js';
import { refreshMediaActionState, setButtonLabel } from './action-ui.js';
import {
  resolveHighestResolutionImageUrl,
} from './image-resolution.js';
import {
  resolveHighestResolutionVideoUrl, getVideoUrl,
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
  showToast(
    media.tagName === "VIDEO"
      ? "Video download started."
      : "Image download started.",
  );
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

/** Download a page-owned media URL through the page's Service Worker. */
function streamPageVideo(video, url) {
  const detail = {
    url,
    filename: isInstagramPage()
      ? `video-${Date.now()}.mp4`
      : getSuggestedVideoName(video),
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
  window.dispatchEvent(
    new CustomEvent(PAGE_MEDIA_DOWNLOAD_EVENT, {
      detail,
    }),
  );
}

/** Start streaming a blob video for download via the media bridge. */
function streamBlobVideo(video, url) {
  const detail = {
    url,
    filename: getSuggestedVideoName(video),
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
  window.dispatchEvent(
    new CustomEvent(BLOB_DOWNLOAD_EVENT, {
      detail,
    }),
  );
}

/** Start recording a video segment from the current playback position. */
export function startTrimRecording(video) {
  if (
    typeof video.captureStream !== "function" ||
    typeof MediaRecorder === "undefined"
  ) {
    throw new Error("This browser does not support video recording.");
  }

  const stream = video.captureStream();
  if (!stream.getVideoTracks().length) {
    throw new Error("The video has no capturable video track.");
  }

  const mimeType = [
    "video/mp4;codecs=hvc1.2.4.L150.90,mp4a.40.2",
    "video/mp4;codecs=hev1.2.4.L150.90,mp4a.40.2",
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4;codecs=avc1.64003E,mp4a.40.2",
    "video/mp4",
  ].find((t) => MediaRecorder.isTypeSupported(t));
  if (!mimeType) {
    throw new Error("No supported recording MIME type found.");
  }

  const pixels = (video.videoWidth || 1920) * (video.videoHeight || 1080);
  const bitrate =
    pixels >= 3840 * 2160
      ? 30_000_000
      : pixels >= 2560 * 1440
        ? 20_000_000
        : pixels >= 1920 * 1080
          ? 12_000_000
          : 8_000_000;

  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: bitrate,
    audioBitsPerSecond: 128_000,
  });

  const startTime = video.currentTime;
  const wasPaused = video.paused;
  const wasLooping = video.loop;
  const chunks = [];
  let rejectPromise = null;
  let restored = false;
  const restorePlayback = () => {
    if (restored) return;
    restored = true;
    video.loop = wasLooping;
    if (wasPaused) video.pause();
  };

  recorder.addEventListener("dataavailable", (e) => {
    if (e.data.size) chunks.push(e.data);
  });

  const promise = new Promise((resolve, reject) => {
    rejectPromise = reject;
    recorder.addEventListener("stop", () => {
      restorePlayback();
      const blob = new Blob(chunks, { type: recorder.mimeType });
      resolve(blob);
    });
    recorder.addEventListener(
      "error",
      () => {
        restorePlayback();
        reject(
          recorder.error ||
            new DOMException("Recording failed", "MediaRecorderError"),
        );
      },
      { once: true },
    );
  });

  if (video.paused) {
    video.play().catch(() => {});
  }
  video.loop = false;

  recorder.start(1000);

  const save = () => {
    video.removeEventListener("timeupdate", endCheck);
    if (recorder.state !== "inactive") recorder.stop();
    else restorePlayback();
  };
  const endCheck = () => {
    if (video.currentTime >= video.duration - 0.15) save();
  };
  video.addEventListener("timeupdate", endCheck, { passive: true });

  return {
    startTime,
    promise,
    save,
    cancel: () => {
      video.removeEventListener("timeupdate", endCheck);
      if (recorder.state !== "inactive") {
        recorder.removeEventListener("stop", () => {});
        recorder.stop();
        rejectPromise?.(new Error("Recording cancelled."));
      }
      restorePlayback();
    },
  };
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

/** Start or stop a trim recording for a video (used by button and context menu). */
export function triggerTrim(media, trimBtn) {
  const videoId = media.dataset.imdCaptureId;
  if (
    videoId &&
    (
      pendingVideoActionIds.has(videoId) ||
      activeDirectDownloadIds.has(videoId)
    )
  ) {
    showToast("A video operation is already in progress.");
    return;
  }
  const recording = videoTrimRecordings.get(media);
  if (recording) {
    recording.save();
    if (trimBtn) {
      trimBtn.disabled = true;
      setButtonLabel(trimBtn, "Finalizing trim…");
    }
    return;
  }

  const mediaUrl = getVideoUrl(media);
  const usesPageBridge =
    mediaUrl.startsWith("blob:") || /^https?:/i.test(mediaUrl);
  if (usesPageBridge) {
    const videoId = media.dataset.imdCaptureId;
    const intent = blobJobIntent.get(videoId);
    if (intent === "trim") {
      finalizingBlobJobIds.add(videoId);
      refreshMediaActionState(media);
      window.dispatchEvent(
        new CustomEvent(BLOB_CONTROL_EVENT, {
          detail: { videoId, action: "save" },
        }),
      );
      if (trimBtn) {
        trimBtn.disabled = true;
        setButtonLabel(trimBtn, "Finalizing trim…");
      }
      showToast("Finalizing trim…");
    } else if (activeBlobJobIds.has(videoId)) {
      showToast("A video operation is already in progress.");
    } else {
      const startTime = Math.max(0, Number(media.currentTime) || 0);
      const filename = getTimestampedVideoName();
      // Blob/MediaSource and Telegram progressive trims are recorded into
      // chunks during playback and do not need FFmpeg. Preload it only for
      // sources that use the source-trim fallback.
      if (
        !mediaUrl.startsWith("blob:") &&
        !isTelegramProgressiveUrl(mediaUrl)
      ) {
        preloadFfmpeg().catch((error) => {
          console.warn("[Media Downloader] FFmpeg preload failed:", error);
        });
      }
      canceledBlobJobs.delete(videoId);
      blobJobIntent.set(videoId, "trim");
      refreshMediaActionState(media);
      if (trimBtn) {
        trimBtn.dataset.recording = "true";
        setButtonLabel(trimBtn, "Save trim");
        trimBtn.innerHTML = STOP_ICON;
      }
      sendBlobStoreMessage({
        action: "job-start",
        jobId: videoId,
        filename,
        folder: settings.downloadFolder,
        saveAs: settings.showSaveAs,
      });
      showToast("Trim recording started.");
      window.dispatchEvent(
        new CustomEvent(BLOB_TRIM_EVENT, {
          detail: {
            url: mediaUrl,
            filename,
            videoId,
            startTime,
          },
        }),
      );
    }
    return;
  }

  if (trimBtn) trimBtn.disabled = true;
  let rec;
  try {
    rec = startTrimRecording(media);
  } catch (error) {
    console.error("Trim recording failed:", error);
    if (trimBtn) trimBtn.disabled = false;
    showToast("Trim recording failed.");
    return;
  }

  videoTrimRecordings.set(media, rec);
  refreshMediaActionState(media);
  showToast("Trim recording started.");
  if (trimBtn) {
    setButtonLabel(trimBtn, "Save trim");
    trimBtn.innerHTML = STOP_ICON;
    trimBtn.dataset.recording = "true";
    trimBtn.disabled = false;
  }

  let elapsedTimer = setInterval(() => {
    const elapsed = media.currentTime - rec.startTime;
    if (elapsed > 0 && trimBtn) {
      setButtonLabel(trimBtn, `Save (${elapsed.toFixed(1)}s)`);
    }
  }, 500);

  rec.promise
    .then((blob) => {
      clearInterval(elapsedTimer);
      if (!blob || !blob.size) return;
      const ext = blob.type.includes("webm") ? "webm" : "mp4";
      const filename = getTimestampedVideoName(ext);
      downloadBlobFile(
        blob,
        filename,
        settings.downloadFolder,
        settings.showSaveAs,
      );
      showToast("Trim saved.");
    })
    .catch((error) => {
      clearInterval(elapsedTimer);
      console.error("Trim recording failed:", error);
      showToast("Trim recording failed.");
    })
    .finally(() => {
      clearInterval(elapsedTimer);
      videoTrimRecordings.delete(media);
      refreshMediaActionState(media);
      if (trimBtn) {
        setButtonLabel(trimBtn, "Trim from current time");
        trimBtn.innerHTML = TRIM_ICON;
        trimBtn.dataset.recording = "false";
        trimBtn.disabled = false;
      }
  });
}
