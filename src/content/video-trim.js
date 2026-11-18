import {
  settings, canceledBlobJobs, blobDownloadRequests, blobJobIntent,
  activeBlobJobIds, activeDirectDownloadIds, pendingVideoActionIds,
  videoTrimRecordings, finalizingBlobJobIds,
} from './state.js';
import {
  isTelegramProgressiveUrl, getTimestampedVideoName,
} from './utils.js';
import {
  BLOB_TRIM_EVENT, BLOB_CONTROL_EVENT, TRIM_ICON, STOP_ICON,
} from './constants.js';
import { preloadFfmpeg } from './blob-mux.js';
import { downloadBlobFile } from './blob-status.js';
import { showToast } from './toast.js';
import { refreshMediaActionState, setButtonLabel } from './action-ui.js';
import { getVideoUrl } from './video-resolution.js';

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
