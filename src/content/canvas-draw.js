import { settings } from './state.js';
import { getFrameCaptureFormat } from './utils.js';

/** Wait until the element presents its next rendered frame (if it is playing). */
export function waitForNextPresentedFrame(video, timeout = 1500) {
  return new Promise((resolve) => {
    if (typeof video.requestVideoFrameCallback !== "function") {
      resolve();
      return;
    }
    let callbackId;
    const timer = setTimeout(() => {
      video.cancelVideoFrameCallback?.(callbackId);
      resolve();
    }, timeout);
    callbackId = video.requestVideoFrameCallback(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Draw the video's current frame onto a fresh canvas and encode it. */
export async function drawVideoFrameToBlob(video, captureType = settings.captureType) {
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const isHdr =
    video.videoColorSpace &&
    (video.videoColorSpace.transfer === "pq" ||
      video.videoColorSpace.transfer === "hlg");
  const contextOptions = {
    willReadFrequently: true,
    ...(isHdr &&
    "display-p3" in (window.CanvasRenderingContext2D?.prototype || {})
      ? { colorSpace: "display-p3" }
      : {}),
  };
  const context = canvas.getContext("2d", contextOptions);
  if (!context) throw new Error("Canvas is unavailable.");
  // HDR frames are tone-mapped to SDR by the canvas; draw at native
  // resolution and disable smoothing so the captured pixels stay as close to
  // the source as the canvas can represent.
  context.imageSmoothingEnabled = false;
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  // A tainted canvas throws later in toBlob; a streamed video that did not
  // decode its frame yet renders transparent or plain black, so treat those
  // as a miss and let the caller retry.
  if (isCanvasBlank(context, canvas.width, canvas.height)) {
    throw new Error("Video frame is not decoded yet.");
  }
  const format = getFrameCaptureFormat(captureType);
  return await new Promise((resolve, reject) => {
    try {
      canvas.toBlob(
        (result) =>
          result
            ? resolve(result)
            : reject(new Error("Frame encoding failed.")),
        format.mimeType,
        format.quality,
      );
    } catch (error) {
      reject(error);
    }
  });
}

/** Wait until the video element has dimensions (metadata) or times out. */
export function waitForVideoMetadata(video, timeout = 2500) {
  if (video.videoWidth > 0 && video.videoHeight > 0) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener("loadedmetadata", onMetadata);
      clearTimeout(timer);
      resolve(video.videoWidth > 0 && video.videoHeight > 0);
    };
    const onMetadata = () => finish();
    const timer = setTimeout(finish, timeout);
    video.addEventListener("loadedmetadata", onMetadata);
  });
}

/**
 * Make sure the element has a decoded frame at the current position before a
 * canvas draw. With force=true it always seeks in place, which forces the
 * decoder to re-decode the frame (paused streams drop their frame otherwise).
 */
export function ensurePresentedFrame(video, force = false, timeout = 2000) {
  if (!force && video.readyState >= 2) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      clearTimeout(timer);
      resolve();
    };
    const onSeeked = () => cleanup();
    const onError = () => cleanup();
    const timer = setTimeout(cleanup, timeout);
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const target = Math.min(
      Math.max(video.currentTime || 0, 0),
      Math.max(duration - 0.01, 0),
    );
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    try {
      video.currentTime = target;
    } catch {
      cleanup();
    }
  });
}

/**
 * Detect a canvas holding no usable frame: fully transparent (undecoded
 * stream) or plain black (paused element whose decoder dropped the frame).
 */
export function isCanvasBlank(context, width, height) {
  try {
    const points = [
      [0, 0],
      [width >> 1, 0],
      [width - 1, 0],
      [0, height >> 1],
      [width >> 1, height >> 1],
      [width - 1, height >> 1],
      [0, height - 1],
      [width >> 1, height - 1],
      [width - 1, height - 1],
    ];
    for (const [x, y] of points) {
      const { data } = context.getImageData(x, y, 1, 1);
      if (data[3] === 0) continue;
      if (data[0] || data[1] || data[2]) return false;
    }
    return true;
  } catch {
    // Tainted canvas: not blank, but unusable for encoding.
    return false;
  }
}
