import { settings } from './state.js';
import { getFrameCaptureFormat } from './utils.js';
import { isCanvasBlank } from './canvas-draw.js';
import { getVideoUrl } from './video-resolution.js';

/**
 * Load a rebuilt media blob (recorded MediaSource segments) into an offscreen
 * probe, seek to the video's current time and capture that frame.
 */
export async function captureFrameFromMediaProbe(
  video,
  mediaBlob,
  captureType = settings.captureType,
) {
  const blobUrl = URL.createObjectURL(mediaBlob);
  try {
    const blob = await new Promise((resolve, reject) => {
      const probe = document.createElement("video");
      probe.muted = true;
      probe.playsInline = true;
      probe.preload = "auto";
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        probe.removeAttribute("src");
        probe.load();
        probe.remove();
        if (error) reject(error);
        else resolve(result);
      };
      probe.onloadedmetadata = () => {
        const duration = Number.isFinite(probe.duration)
          ? probe.duration
          : Infinity;
        const target = Math.min(
          Math.max(video.currentTime || 0, 0),
          Math.max(duration - 0.01, 0),
        );
        try {
          probe.currentTime = target;
        } catch (error) {
          finish(error);
        }
      };
      probe.onseeked = () => {
        const tryCapture = (attempt) => {
          try {
            const canvas = document.createElement("canvas");
            canvas.width = probe.videoWidth;
            canvas.height = probe.videoHeight;
            const context = canvas.getContext("2d", {
              willReadFrequently: true,
            });
            if (!context) throw new Error("Canvas is unavailable.");
            context.imageSmoothingEnabled = false;
            context.drawImage(probe, 0, 0);
            if (attempt < 3 && isCanvasBlank(context, canvas.width, canvas.height)) {
              setTimeout(() => tryCapture(attempt + 1), 120);
              return;
            }
            if (isCanvasBlank(context, canvas.width, canvas.height)) {
              throw new Error("Rebuilt media frame is not decoded.");
            }
            const format = getFrameCaptureFormat(captureType);
            canvas.toBlob(
              (result) =>
                result
                  ? finish(null, result)
                  : finish(new Error("Frame encoding failed.")),
              format.mimeType,
              format.quality,
            );
          } catch (error) {
            finish(error);
          }
        };
        tryCapture(0);
      };
      probe.onerror = () =>
        finish(new Error("Rebuilt media could not be loaded."));
      probe.src = blobUrl;
      probe.load();
    });
    return blob;
  } finally {
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  }
}

/**
 * Last-resort capture: screenshot the visible tab through the background
 * service worker and crop the video element's bounding rect from it.
 */
export function captureVideoFrameFromTab(video) {
  return new Promise((resolve, reject) => {
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
      reject(new Error("Tab screenshot is unavailable."));
      return;
    }
    const actionGroups = Array.from(
      document.querySelectorAll(".imd-action-group"),
    );
    const previousDisplays = actionGroups.map(
      (group) => group.style.display,
    );
    actionGroups.forEach((group) => {
      group.style.display = "none";
    });
    const restore = () => {
      actionGroups.forEach((group, index) => {
        group.style.display = previousDisplays[index];
      });
    };
    chrome.runtime.sendMessage({ action: "captureTab" }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        restore();
        reject(
          new Error(
            chrome.runtime.lastError?.message || "Tab screenshot failed.",
          ),
        );
        return;
      }
      const rect = video.getBoundingClientRect();
      if (!rect.width || !rect.height) {
        restore();
        reject(new Error("Video is not visible on screen."));
        return;
      }
      const image = new Image();
      image.decoding = "async";
      let attempts = 0;
      const cropAndResolve = () => {
        const dpr = Math.max(window.devicePixelRatio || 1, 1);
        const sx = Math.max(0, Math.round(rect.left * dpr));
        const sy = Math.max(0, Math.round(rect.top * dpr));
        const width = Math.max(
          1,
          Math.min(Math.round(rect.width * dpr), image.naturalWidth - sx),
        );
        const height = Math.max(
          1,
          Math.min(Math.round(rect.height * dpr), image.naturalHeight - sy),
        );
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.imageSmoothingEnabled = false;
        context.drawImage(image, sx, sy, width, height, 0, 0, width, height);
        // The player may cover a paused video with a poster overlay that is
        // still loading; retry once before giving up on the crop.
        if (attempts < 1 && isCanvasBlank(context, width, height)) {
          attempts += 1;
          setTimeout(cropAndResolve, 200);
          return;
        }
        if (isCanvasBlank(context, width, height)) {
          reject(new Error("Captured screen area is empty."));
          return;
        }
        canvas.toBlob(
          (blob) =>
            blob
              ? resolve(blob)
              : reject(new Error("Frame encoding failed.")),
          "image/png",
        );
      };
      image.onload = () => {
        restore();
        cropAndResolve();
      };
      image.onerror = () => {
        restore();
        reject(new Error("Screenshot decode failed."));
      };
      image.src = response.dataUrl;
    });
  });
}

/** Re-capture a video frame by loading the source with CORS enabled. */
export function captureVideoFrameFromSource(
  video,
  captureType = settings.captureType,
) {
  return new Promise((resolve, reject) => {
    const url = getVideoUrl(video);
    if (!url || url.startsWith("blob:") || url.startsWith("data:")) {
      reject(new Error("Video source cannot be re-captured."));
      return;
    }

    const probe = document.createElement("video");
    probe.muted = true;
    probe.playsInline = true;
    probe.crossOrigin = "anonymous";
    probe.preload = "auto";

    let settled = false;
    const finish = (error, blob) => {
      if (settled) return;
      settled = true;
      probe.removeAttribute("src");
      probe.load();
      probe.remove();
      if (error) reject(error);
      else resolve(blob);
    };

    probe.onloadedmetadata = () => {
      const duration = Number.isFinite(probe.duration)
        ? probe.duration
        : Infinity;
      const target = Math.min(
        Math.max(video.currentTime || 0, 0),
        Math.max(duration - 0.01, 0),
      );
      try {
        probe.currentTime = target;
      } catch (error) {
        finish(error);
      }
    };
    probe.onseeked = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = probe.videoWidth;
        canvas.height = probe.videoHeight;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas is unavailable.");
        context.imageSmoothingEnabled = false;
        context.drawImage(probe, 0, 0);
        const format = getFrameCaptureFormat(captureType);
        canvas.toBlob(
          (result) =>
            result
              ? finish(null, result)
              : finish(new Error("Frame encoding failed.")),
          format.mimeType,
          format.quality,
        );
      } catch (error) {
        finish(error);
      }
    };
    probe.onerror = () =>
      finish(new Error("Video source could not be loaded for capture."));

    probe.src = url;
    probe.load();
  });
}
