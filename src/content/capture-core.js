import { settings } from './state.js';
import { requestMediaSourceBlob } from './blob-store.js';
import { CAPTURE_BLOCK_EVENT, CAPTURE_UNBLOCK_EVENT } from './constants.js';
import {
  waitForVideoMetadata, waitForNextPresentedFrame, ensurePresentedFrame,
  drawVideoFrameToBlob,
} from './canvas-draw.js';
import {
  captureVideoFrameFromSource, captureFrameFromMediaProbe,
  captureVideoFrameFromTab,
} from './capture-sources.js';
import { getVideoUrl } from './video-resolution.js';

/**
 * Capture the current video frame and return both a blob URL (for downloads,
 * previews and the clipboard) and a data URL (for reliable in-page display).
 */
export async function captureVideoFrame(video) {
  const blob = await captureVideoFrameBlobWithFallbacks(video);
  const blobUrl = URL.createObjectURL(blob);
  try {
    return { blobUrl, dataUrl: await blobToDataUrl(blob) };
  } catch (error) {
    return { blobUrl, dataUrl: blobUrl };
  }
}

/** Convert a Blob into a data: URL string (FileReader-based). */
export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () =>
      reject(reader.error || new Error("Blob read failed."));
    reader.readAsDataURL(blob);
  });
}

/**
 * Capture the current video frame as an encoded image blob, trying harder
 * sources in order until one succeeds:
 *   1. draw the live element directly onto a canvas,
 *   2. re-load the plain source URL with CORS enabled,
 *   3. rebuild the stream from the MediaSource segments recorded by the bridge,
 *   4. screenshot the visible tab and crop the video element rect.
 */
export async function captureVideoFrameBlobWithFallbacks(
  video,
  captureType = settings.captureType,
) {
  try {
    return await captureVideoFrameBlob(video, captureType);
  } catch (error) {
    console.warn("[Media Downloader] Direct frame capture failed:", error);
    const sourceUrl = getVideoUrl(video);
    if (sourceUrl && !sourceUrl.startsWith("blob:") && !sourceUrl.startsWith("data:")) {
      try {
        return await captureVideoFrameFromSource(video, captureType);
      } catch (sourceError) {
        console.warn(
          "[Media Downloader] Source frame capture failed:",
          sourceError,
        );
      }
    }
    const mseBlob = await requestMediaSourceBlob(sourceUrl);
    if (mseBlob && mseBlob.size) {
      try {
        return await captureFrameFromMediaProbe(video, mseBlob, captureType);
      } catch (probeError) {
        console.warn(
          "[Media Downloader] MediaSource rebuild capture failed:",
          probeError,
        );
      }
    }
    return await captureVideoFrameFromTab(video);
  }
}

/** Capture the current video frame as an encoded image blob. */
async function captureVideoFrameBlob(video, captureType = settings.captureType) {
  if (
    !Number.isFinite(video.videoWidth) ||
    !video.videoWidth ||
    !Number.isFinite(video.videoHeight) ||
    !video.videoHeight
  ) {
    const ready = await waitForVideoMetadata(video);
    if (!ready) throw new Error("Video frame is not ready.");
  }
  window.dispatchEvent(
    new CustomEvent(CAPTURE_BLOCK_EVENT, { detail: { video } }),
  );
  const wasPlaying = !video.paused;
  try {
    // First pass grabs the live presented frame (never paused, so the decoder
    // keeps painting). If the frame is empty (paused streams often drop their
    // decoded frame), fall back to seeking in place to force a new decode.
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt === 0 && wasPlaying) {
          await waitForNextPresentedFrame(video);
        } else {
          await ensurePresentedFrame(video, attempt > 0);
        }
        const blob = await drawVideoFrameToBlob(video, captureType);
        return blob;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("Video frame capture failed.");
  } finally {
    window.dispatchEvent(
      new CustomEvent(CAPTURE_UNBLOCK_EVENT, { detail: { video } }),
    );
  }
}
