const DOWNLOAD_EVENT = "imd:download-blob-video";
const STATUS_EVENT = "imd:blob-video-status";
const blobKinds = new Map();
const activeRecordings = new Map();
const activeJobs = new Set();
const queuedJobs = [];
const queuedVideoIds = new Set();
let maxConcurrentJobs = 5;
const mediaSourceRecords = new WeakMap();
const sourceBufferRecords = new WeakMap();
const protectedVideos = new WeakSet();
const nativeMediaProperties = new Map();

const nativePause = HTMLMediaElement.prototype.pause;
HTMLMediaElement.prototype.pause = function () {
  if (!protectedVideos.has(this)) return nativePause.call(this);
};
const nativeLoad = HTMLMediaElement.prototype.load;
HTMLMediaElement.prototype.load = function () {
  if (!protectedVideos.has(this)) return nativeLoad.call(this);
};

for (const property of ["src", "srcObject", "currentTime"]) {
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLMediaElement.prototype,
    property
  );
  if (!descriptor?.set) continue;
  nativeMediaProperties.set(property, descriptor);
  Object.defineProperty(HTMLMediaElement.prototype, property, {
    ...descriptor,
    set(value) {
      if (!protectedVideos.has(this)) descriptor.set.call(this, value);
    },
  });
}

const nativeSetAttribute = Element.prototype.setAttribute;
Element.prototype.setAttribute = function (name, value) {
  if (!(protectedVideos.has(this) && name.toLowerCase() === "src")) {
    return nativeSetAttribute.call(this, name, value);
  }
};
const nativeRemoveAttribute = Element.prototype.removeAttribute;
Element.prototype.removeAttribute = function (name) {
  if (!(protectedVideos.has(this) && name.toLowerCase() === "src")) {
    return nativeRemoveAttribute.call(this, name);
  }
};

if (window.MediaSource && window.SourceBuffer) {
  const nativeAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mimeType) {
    const sourceBuffer = nativeAddSourceBuffer.call(this, mimeType);
    let record = mediaSourceRecords.get(this);
    if (!record) {
      record = { buffers: [] };
      mediaSourceRecords.set(this, record);
    }
    const bufferRecord = { mimeType, chunks: [] };
    record.buffers.push(bufferRecord);
    sourceBufferRecords.set(sourceBuffer, bufferRecord);
    return sourceBuffer;
  };

  const nativeAppendBuffer = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data) {
    const record = sourceBufferRecords.get(this);
    if (record && data) {
      const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
      record.chunks.push(bytes.slice().buffer);
    }
    return nativeAppendBuffer.call(this, data);
  };
}

const nativeCreateObjectURL = URL.createObjectURL.bind(URL);
URL.createObjectURL = (object) => {
  const url = nativeCreateObjectURL(object);
  if (object instanceof MediaSource) {
    let record = mediaSourceRecords.get(object);
    if (!record) {
      record = { buffers: [] };
      mediaSourceRecords.set(object, record);
    }
    blobKinds.set(url, { kind: "media-source", record });
  } else if (object instanceof Blob) {
    blobKinds.set(url, { kind: "blob" });
  }
  return url;
};

const nativeRevokeObjectURL = URL.revokeObjectURL.bind(URL);
URL.revokeObjectURL = (url) => {
  blobKinds.delete(url);
  return nativeRevokeObjectURL(url);
};

window.addEventListener(DOWNLOAD_EVENT, (event) => {
  const { url, filename, videoId, maxConcurrent } = event.detail || {};
  if (!url || !videoId) return;

  maxConcurrentJobs = Math.min(
    10,
    Math.max(1, Number.parseInt(maxConcurrent, 10) || 5)
  );

  const video = document.querySelector(
    `video[data-imd-capture-id="${CSS.escape(videoId)}"]`
  );
  if (!video) return;

  if (activeRecordings.has(videoId)) {
    activeRecordings.get(videoId).stop();
    return;
  }

  if (activeJobs.has(videoId) || queuedVideoIds.has(videoId)) return;

  const job = { url, filename, videoId, video };
  if (activeJobs.size >= maxConcurrentJobs) {
    queuedJobs.push(job);
    queuedVideoIds.add(videoId);
    updateQueueStatuses();
    return;
  }

  startJob(job);
});

function startJob(job) {
  const { url, filename, videoId, video } = job;
  activeJobs.add(videoId);
  emitStatus(videoId, "recording", "Preparing video download…");
  const source = blobKinds.get(url);
  let operation;
  if (source?.kind === "blob") {
    operation = downloadKnownBlob(url, filename, videoId);
  } else if (
    source?.kind === "media-source" &&
    source.record.buffers.length === 1
  ) {
    operation = downloadCapturedMediaSource(
      video,
      videoId,
      filename,
      source.record.buffers[0]
    );
  } else {
    operation = recordMediaSource(video, videoId, filename);
  }

  operation
    .catch((error) => {
      if (error && error.name === "AbortError") return;
      console.error("[Media Downloader] Video download failed:", error);
      emitStatus(videoId, "error", error.message || String(error));
    })
    .finally(() => {
      activeJobs.delete(videoId);
      startQueuedJobs();
    });
}

function startQueuedJobs() {
  while (activeJobs.size < maxConcurrentJobs && queuedJobs.length) {
    const job = queuedJobs.shift();
    queuedVideoIds.delete(job.videoId);
    if (job.video.isConnected) startJob(job);
    else emitStatus(job.videoId, "error", "Queued video is no longer available.");
  }
  updateQueueStatuses();
}

function updateQueueStatuses() {
  queuedJobs.forEach((job, index) => {
    emitStatus(
      job.videoId,
      "queued",
      `Waiting in queue · position ${index + 1}`,
      0
    );
  });
}

async function downloadKnownBlob(url, filename, videoId) {
  const response = await fetch(url);
  const blob = await response.blob();
  if (!blob.size) throw new Error("The Blob video contains no data.");
  await validateVideoBlob(blob);
  const downloadUrl = nativeCreateObjectURL(blob);
  triggerDownload(downloadUrl, filename);
  setTimeout(() => nativeRevokeObjectURL(downloadUrl), 60_000);
  emitStatus(videoId, "complete", "Blob video downloaded.", 100);
}

async function downloadCapturedMediaSource(
  video,
  videoId,
  filename,
  bufferRecord
) {
  const originalTime = video.currentTime;
  const wasPaused = video.paused;
  const wasLooping = video.loop;

  try {
    if (!isMediaFullyBuffered(video)) {
      video.loop = false;
      if (video.seekable.length && Number.isFinite(video.duration)) {
        video.currentTime = 0;
      }
      emitStatus(
        videoId,
        "recording",
        "Collecting original media segments…",
        0
      );
      await waitForMediaCompletion(video, videoId);
    }

    const mimeType = bufferRecord.mimeType.split(";")[0] || "video/mp4";
    const extension = mimeType.includes("webm") ? "webm" : "mp4";
    const blob = new Blob(bufferRecord.chunks, { type: mimeType });
    if (!blob.size) {
      throw new Error("No MediaSource segments were captured.");
    }
    await validateVideoBlob(blob);

    const downloadUrl = nativeCreateObjectURL(blob);
    triggerDownload(downloadUrl, replaceExtension(filename, extension));
    setTimeout(() => nativeRevokeObjectURL(downloadUrl), 60_000);
    emitStatus(
      videoId,
      "complete",
      "Original media segments downloaded.",
      100
    );
  } finally {
    activeRecordings.delete(videoId);
    if (Number.isFinite(originalTime)) video.currentTime = originalTime;
    video.loop = wasLooping;
    if (wasPaused) video.pause();
  }
}

function isMediaFullyBuffered(video) {
  if (!Number.isFinite(video.duration) || !video.buffered.length) return false;
  return (
    video.buffered.start(0) <= 0.25 &&
    video.buffered.end(video.buffered.length - 1) >= video.duration - 0.25
  );
}

function waitForMediaCompletion(video, videoId) {
  return new Promise((resolve, reject) => {
    let timer;
    const releasePlaybackLock = keepVideoPlaying(video);
    const reportProgress = () => {
      const progress =
        Number.isFinite(video.duration) && video.duration > 0
          ? (video.currentTime / video.duration) * 100
          : undefined;
      emitStatus(
        videoId,
        "progress",
        "Collecting original media segments…",
        progress
      );
    };
    const settle = (error) => {
      clearTimeout(timer);
      video.removeEventListener("ended", finish);
      video.removeEventListener("error", fail);
      video.removeEventListener("timeupdate", reportProgress);
      releasePlaybackLock();
      if (error) reject(error);
      else resolve();
    };
    const finish = () => settle();
    const fail = () =>
      settle(new Error("Video playback failed while collecting segments."));

    activeRecordings.set(videoId, { stop: finish });
    video.addEventListener("ended", finish, { once: true });
    video.addEventListener("error", fail, { once: true });
    video.addEventListener("timeupdate", reportProgress);
    if (Number.isFinite(video.duration) && video.duration > 0) {
      timer = setTimeout(finish, Math.ceil(video.duration * 1000) + 5000);
    }
    video.play().catch(() => {});
  });
}

async function recordMediaSource(video, videoId, filename) {
  if (typeof video.captureStream !== "function" || !window.MediaRecorder) {
    throw new Error("This browser cannot record MediaSource video streams.");
  }

  const stream = video.captureStream();
  if (!stream.getVideoTracks().length) {
    throw new Error("The video stream has no capturable video track.");
  }

  const mimeType = getRecorderMimeType();
  if (!mimeType) {
    throw new Error("This Chrome build cannot record MP4 video.");
  }
  const outputName = replaceExtension(filename, "mp4");
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: getRecordingBitrate(video),
    audioBitsPerSecond: 256_000,
  });
  const originalTime = video.currentTime;
  const wasPaused = video.paused;
  const wasLooping = video.loop;
  const chunks = [];
  let safetyTimer;
  let reachedEndAt = null;
  let releasePlaybackLock = () => {};
  const reportProgress = () => {
    const progress =
      Number.isFinite(video.duration) && video.duration > 0
        ? (video.currentTime / video.duration) * 100
        : undefined;
    emitStatus(videoId, "progress", "Recording video stream…", progress);
  };

  const completion = new Promise((resolve, reject) => {
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) chunks.push(event.data);
    });
    recorder.addEventListener("stop", resolve, { once: true });
    recorder.addEventListener("error", () => reject(recorder.error), {
      once: true,
    });
  });

  const stop = () => {
    if (recorder.state !== "inactive") recorder.stop();
  };
  activeRecordings.set(videoId, { stop });
  video.addEventListener("ended", stop, { once: true });

  try {
    if (video.seekable.length && video.duration !== Infinity) {
      video.currentTime = 0;
    }
    video.loop = false;
    releasePlaybackLock = keepVideoPlaying(video);
    recorder.start(1000);
    await video.play();
    const recordingStartedAt = performance.now();
    safetyTimer = setInterval(() => {
      if (!Number.isFinite(video.duration) || video.duration <= 0) return;
      if (video.currentTime >= video.duration - 0.15) {
        reachedEndAt ??= performance.now();
        if (performance.now() - reachedEndAt >= 250) stop();
        return;
      }
      reachedEndAt = null;
      const expectedDuration =
        (video.duration / Math.max(video.playbackRate, 0.1)) * 1000;
      if (performance.now() - recordingStartedAt > expectedDuration + 15_000) {
        stop();
      }
    }, 250);
    emitStatus(videoId, "recording", "Recording video stream…", 0);
    video.addEventListener("timeupdate", reportProgress);
    await completion;
    const recordedBlob = new Blob(chunks, { type: recorder.mimeType });
    if (!recordedBlob.size) {
      throw new Error("No video data was captured; no file was created.");
    }
    await validateVideoBlob(recordedBlob);
    const downloadUrl = nativeCreateObjectURL(recordedBlob);
    triggerDownload(downloadUrl, outputName);
    setTimeout(() => nativeRevokeObjectURL(downloadUrl), 60_000);
    emitStatus(videoId, "complete", "MediaSource recording saved.", 100);
  } finally {
    clearInterval(safetyTimer);
    releasePlaybackLock();
    activeRecordings.delete(videoId);
    video.removeEventListener("ended", stop);
    video.removeEventListener("timeupdate", reportProgress);
    if (Number.isFinite(originalTime)) video.currentTime = originalTime;
    video.loop = wasLooping;
    if (wasPaused) video.pause();
  }
}

function keepVideoPlaying(video) {
  let disposed = false;
  let resumePending = false;
  const previousPreload = video.preload;
  protectedVideos.add(video);
  const releaseRenderHost = hostVideoForCapture(video);
  const releaseFramePump = keepVideoFramesDecoded(video);
  video.preload = "auto";

  const resume = () => {
    if (disposed || resumePending) return;
    if (!video.isConnected) getCaptureRenderHost().appendChild(video);
    if (video.ended || video.error) return;
    resumePending = true;
    queueMicrotask(() => {
      resumePending = false;
      if (!disposed && video.paused && !video.ended) {
        video.play().catch(() => {});
      }
    });
  };

  video.addEventListener("pause", resume);
  const watchdog = setInterval(resume, 500);
  resume();

  return () => {
    if (disposed) return;
    disposed = true;
    clearInterval(watchdog);
    video.removeEventListener("pause", resume);
    protectedVideos.delete(video);
    video.preload = previousPreload;
    releaseFramePump();
    releaseRenderHost();
  };
}

let captureRenderHost;
function getCaptureRenderHost() {
  if (captureRenderHost?.isConnected) return captureRenderHost;
  captureRenderHost = document.createElement("div");
  captureRenderHost.setAttribute("aria-hidden", "true");
  captureRenderHost.style.cssText =
    "position:fixed;top:0;left:0;width:100vw;min-height:90px;display:flex;" +
    "flex-wrap:wrap;overflow:hidden;" +
    "opacity:.01;pointer-events:none;z-index:2147483646;transform:translateZ(0)";
  document.documentElement.appendChild(captureRenderHost);
  return captureRenderHost;
}

function hostVideoForCapture(video) {
  const originalParent = video.parentNode;
  const originalNextSibling = video.nextSibling;
  const originalStyle = video.getAttribute("style");
  if (!originalParent) return () => {};

  const rect = video.getBoundingClientRect();
  const placeholder = document.createElement("canvas");
  placeholder.width = video.videoWidth || Math.max(1, Math.round(rect.width));
  placeholder.height = video.videoHeight || Math.max(1, Math.round(rect.height));
  placeholder.setAttribute("aria-hidden", "true");
  placeholder.style.cssText =
    `display:${getComputedStyle(video).display};width:${rect.width}px;` +
    `height:${rect.height}px;object-fit:cover`;
  try {
    placeholder
      .getContext("2d")
      .drawImage(video, 0, 0, placeholder.width, placeholder.height);
  } catch {}

  originalParent.insertBefore(placeholder, video);
  getCaptureRenderHost().appendChild(video);
  video.style.cssText =
    "position:relative;display:block;flex:0 0 160px;width:160px;height:90px;" +
    "min-width:160px;min-height:90px;opacity:1;pointer-events:none;" +
    "transform:translateZ(0);will-change:transform";

  return () => {
    const targetParent = placeholder.isConnected
      ? placeholder.parentNode
      : originalParent.isConnected
        ? originalParent
        : null;
    if (targetParent) {
      const anchor = placeholder.isConnected
        ? placeholder
        : originalNextSibling?.parentNode === targetParent
          ? originalNextSibling
          : null;
      targetParent.insertBefore(video, anchor);
    } else {
      video.remove();
    }
    placeholder.remove();
    if (originalStyle === null) video.removeAttribute("style");
    else video.setAttribute("style", originalStyle);
  };
}

function keepVideoFramesDecoded(video) {
  const canvas = document.createElement("canvas");
  canvas.width = 16;
  canvas.height = 9;
  const context = canvas.getContext("2d", { alpha: false });
  let stopped = false;
  let callbackId;
  let lastFrameAt = performance.now();
  let lastObservedTime = video.currentTime;
  let lastFrameCount = video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
  const paint = () => {
    if (stopped) return;
    try {
      context?.drawImage(video, 0, 0, canvas.width, canvas.height);
    } catch {}
  };
  const onFrame = () => {
    lastFrameAt = performance.now();
    paint();
    callbackId = video.requestVideoFrameCallback?.(onFrame);
  };

  if (typeof video.requestVideoFrameCallback === "function") {
    callbackId = video.requestVideoFrameCallback(onFrame);
  }
  const intervalId = setInterval(() => {
    paint();
    const currentTime = video.currentTime;
    const frameCount =
      video.getVideoPlaybackQuality?.().totalVideoFrames ?? lastFrameCount;
    if (frameCount > lastFrameCount) lastFrameAt = performance.now();
    lastFrameCount = frameCount;
    const timeIsMoving = currentTime > lastObservedTime + 0.05;
    if (timeIsMoving && performance.now() - lastFrameAt > 1500) {
      const descriptor = nativeMediaProperties.get("currentTime");
      descriptor?.set.call(video, Math.max(0, currentTime - 0.02));
      video.play().catch(() => {});
      lastFrameAt = performance.now();
    }
    lastObservedTime = currentTime;
  }, 250);

  return () => {
    stopped = true;
    clearInterval(intervalId);
    if (callbackId !== undefined) video.cancelVideoFrameCallback?.(callbackId);
  };
}

function getRecorderMimeType() {
  return [
    "video/mp4;codecs=avc1.64003E,mp4a.40.2",
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4",
  ].find((type) => MediaRecorder.isTypeSupported(type));
}

function validateVideoBlob(blob) {
  return new Promise((resolve, reject) => {
    const probe = document.createElement("video");
    const url = nativeCreateObjectURL(blob);
    let settled = false;
    const timeout = setTimeout(
      () => finish(new Error("Generated video could not be validated.")),
      8000
    );
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      probe.removeAttribute("src");
      probe.load();
      nativeRevokeObjectURL(url);
      if (error) reject(error);
      else resolve();
    };
    probe.preload = "metadata";
    probe.addEventListener(
      "loadedmetadata",
      () => {
        const hasVideo = probe.videoWidth > 0 && probe.videoHeight > 0;
        const hasDuration = probe.duration > 0 || probe.duration === Infinity;
        finish(
          hasVideo && hasDuration
            ? null
            : new Error("Generated file does not contain playable video.")
        );
      },
      { once: true }
    );
    probe.addEventListener(
      "error",
      () => finish(new Error("Generated file is not a playable video.")),
      { once: true }
    );
    probe.src = url;
  });
}

function getRecordingBitrate(video) {
  const pixels = (video.videoWidth || 1920) * (video.videoHeight || 1080);
  if (pixels >= 3840 * 2160) return 30_000_000;
  if (pixels >= 2560 * 1440) return 20_000_000;
  if (pixels >= 1920 * 1080) return 12_000_000;
  return 8_000_000;
}

function replaceExtension(filename, extension) {
  const base = (filename || `video-${Date.now()}`).replace(/\.[^.]+$/, "");
  return `${base}.${extension}`;
}

function triggerDownload(url, filename) {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.documentElement.appendChild(link);
  link.click();
  link.remove();
}

function emitStatus(videoId, status, message, progress) {
  window.dispatchEvent(
    new CustomEvent(STATUS_EVENT, {
      detail: { videoId, status, message, progress },
    })
  );
}
