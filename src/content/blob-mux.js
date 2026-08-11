import {
  FFMPEG_HOST_CHANNEL, BLOB_MUX_RESULT_EVENT,
} from './constants.js';
import {
  activeMuxWorkers, muxOutputWorkers, activeIndependentMuxes, settings,
  setFfmpegHostFrame, setFfmpegHostPromise,
  ffmpegHostFrame, ffmpegHostPromise,
} from './state.js';
import { abortError } from './utils.js';

export function muxTracksIndependently(videoId, filename, tracks, startTime, duration) {
  const muxId = `${videoId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const entry = { muxId, resolve, reject };
    activeIndependentMuxes.set(videoId, entry);
    chrome.runtime.sendMessage(
      {
        action: "startIndependentMux",
        muxId,
        videoId,
        filename,
        folder: settings.downloadFolder,
        saveAs: settings.showSaveAs,
        tracks: tracks.map((track) => ({
          mimeType: track.mimeType,
          url: track.url,
          fullSize: track.fullSize,
        })),
        startTime,
        duration,
      },
      (response) => {
        if (chrome.runtime.lastError || !response?.ok) {
          if (activeIndependentMuxes.get(videoId) === entry) {
            activeIndependentMuxes.delete(videoId);
          }
          reject(
            new Error(
              chrome.runtime.lastError?.message ||
                response?.error ||
                "Independent download could not be started.",
            ),
          );
        }
      },
    );
  });
}

export async function getFfmpegHostFrame() {
  if (ffmpegHostFrame?.isConnected) return ffmpegHostFrame;
  if (ffmpegHostPromise) return ffmpegHostPromise;

  const promise = new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.src = chrome.runtime.getURL("ffmpeg/ffmpeg-host.html");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText =
      "position:fixed;width:1px;height:1px;left:-10000px;top:-10000px;" +
      "border:0;opacity:0;pointer-events:none";
    frame.onload = () => {
      setFfmpegHostFrame(frame);
      setFfmpegHostPromise(null);
      resolve(frame);
    };
    frame.onerror = () => {
      frame.remove();
      setFfmpegHostPromise(null);
      reject(new Error("The extension FFmpeg host could not be loaded."));
    };
    (document.documentElement || document.body).appendChild(frame);
  });
  setFfmpegHostPromise(promise);
  return promise;
}

export async function muxTracksLocally(videoId, tracks, startTime, duration) {
  const muxId = `${videoId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const frame = await getFfmpegHostFrame();
  return new Promise((resolve, reject) => {
    const entry = {
      frame,
      muxId,
      reject,
      cleanup: () => window.removeEventListener("message", onMessage),
    };
    activeMuxWorkers.set(videoId, entry);
    const fail = (error) => {
      if (activeMuxWorkers.get(videoId) === entry) {
        activeMuxWorkers.delete(videoId);
      }
      window.removeEventListener("message", onMessage);
      reject(error);
    };
    const onMessage = (event) => {
      if (
        event.source !== frame.contentWindow ||
        event.data?.channel !== FFMPEG_HOST_CHANNEL ||
        event.data?.muxId !== muxId
      ) {
        return;
      }
      window.removeEventListener("message", onMessage);
      if (activeMuxWorkers.get(videoId) === entry) {
        activeMuxWorkers.delete(videoId);
      }
      if (!event.data.ok) {
        fail(new Error(event.data.error || "FFmpeg mux failed."));
        return;
      }
      muxOutputWorkers.set(event.data.url, { frame, muxId });
      resolve(event.data);
    };
    window.addEventListener("message", onMessage);
    const payload = tracks.map((track) => ({
      mimeType: track.mimeType,
      blob: track.blob,
      url: track.url,
    }));
    frame.contentWindow.postMessage(
      {
        channel: FFMPEG_HOST_CHANNEL,
        action: "mux",
        muxId,
        tracks: payload,
        startTime,
        duration,
      },
      "*",
    );
  });
}

export function cancelLocalMux(videoId) {
  const independent = activeIndependentMuxes.get(videoId);
  if (independent) {
    activeIndependentMuxes.delete(videoId);
    chrome.runtime.sendMessage({
      action: "cancelIndependentMux",
      muxId: independent.muxId,
    });
    independent.reject(abortError());
  }
  const entry = activeMuxWorkers.get(videoId);
  if (!entry) return;
  activeMuxWorkers.delete(videoId);
  entry.cleanup();
  entry.frame.contentWindow?.postMessage(
    {
      channel: FFMPEG_HOST_CHANNEL,
      action: "cancel",
      muxId: entry.muxId,
    },
    "*",
  );
  entry.reject(abortError());
}

export function releaseMuxUrl(url) {
  const entry = muxOutputWorkers.get(url);
  if (!entry) return;
  muxOutputWorkers.delete(url);
  entry.frame.contentWindow?.postMessage(
    {
      channel: FFMPEG_HOST_CHANNEL,
      action: "release",
      muxId: entry.muxId,
      url,
    },
    "*",
  );
}
