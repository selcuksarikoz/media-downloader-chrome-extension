const DOWNLOAD_EVENT = "imd:download-blob-video";
const TRIM_EVENT = "imd:trim-blob-video";
const CONTROL_EVENT = "imd:control-blob-video";
const STATUS_EVENT = "imd:blob-video-status";
const blobKinds = new Map();
const activeRecordings = new Map();
const activeJobs = new Set();
const activeJobControllers = new Map();
const queuedJobs = [];
const queuedVideoIds = new Set();
let maxConcurrentJobs = 5;
const mediaSourceRecords = new WeakMap();
const sourceBufferRecords = new WeakMap();
const protectedVideos = new WeakSet();
const renderedFrameTimes = new WeakMap();

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

function getMediaSourceRecord(mediaSource) {
  let record = mediaSourceRecords.get(mediaSource);
  if (!record) {
    record = { buffers: [], lockCount: 0, pendingRevokes: new Set() };
    mediaSourceRecords.set(mediaSource, record);
  }
  return record;
}

if (window.MediaSource && window.SourceBuffer) {
  const nativeAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mimeType) {
    const sourceBuffer = nativeAddSourceBuffer.call(this, mimeType);
    const record = getMediaSourceRecord(this);
    const bufferRecord = { mimeType, chunks: [] };
    record.buffers.push(bufferRecord);
    sourceBufferRecords.set(sourceBuffer, { bufferRecord, mediaRecord: record });
    return sourceBuffer;
  };

  const nativeAppendBuffer = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data) {
    const sourceRecord = sourceBufferRecords.get(this);
    if (sourceRecord && data) {
      const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
      sourceRecord.bufferRecord.chunks.push(bytes.slice().buffer);
    }
    return nativeAppendBuffer.call(this, data);
  };

  for (const method of ["remove", "abort", "changeType"]) {
    const nativeMethod = SourceBuffer.prototype[method];
    if (typeof nativeMethod !== "function") continue;
    SourceBuffer.prototype[method] = function (...args) {
      const record = sourceBufferRecords.get(this)?.mediaRecord;
      if (!record?.lockCount) return nativeMethod.apply(this, args);
    };
  }

  const nativeRemoveSourceBuffer = MediaSource.prototype.removeSourceBuffer;
  MediaSource.prototype.removeSourceBuffer = function (...args) {
    const record = mediaSourceRecords.get(this);
    if (!record?.lockCount) return nativeRemoveSourceBuffer.apply(this, args);
  };
}

const nativeCreateObjectURL = URL.createObjectURL.bind(URL);
URL.createObjectURL = (object) => {
  const url = nativeCreateObjectURL(object);
  if (object instanceof MediaSource) {
    const record = getMediaSourceRecord(object);
    blobKinds.set(url, { kind: "media-source", record });
  } else if (object instanceof Blob) {
    blobKinds.set(url, { kind: "blob" });
  }
  return url;
};

const nativeRevokeObjectURL = URL.revokeObjectURL.bind(URL);
URL.revokeObjectURL = (url) => {
  const source = blobKinds.get(url);
  if (source?.kind === "media-source" && source.record.lockCount) {
    source.record.pendingRevokes.add(url);
    return;
  }
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

  if (activeJobs.has(videoId) || queuedVideoIds.has(videoId)) return;

  const source = blobKinds.get(url);
  if (source?.kind === "media-source") source.record.lockCount += 1;
  const job = { url, filename, videoId, video, source };
  if (activeJobs.size >= maxConcurrentJobs) {
    queuedJobs.push(job);
    queuedVideoIds.add(videoId);
    updateQueueStatuses();
    return;
  }

  startJob(job);
});

window.addEventListener(TRIM_EVENT, (event) => {
  const { url, filename, videoId, startTime, maxConcurrent } = event.detail || {};
  if (!url || !videoId) return;

  maxConcurrentJobs = Math.min(
    10,
    Math.max(1, Number.parseInt(maxConcurrent, 10) || 5)
  );

  const video = document.querySelector(
    `video[data-imd-capture-id="${CSS.escape(videoId)}"]`
  );
  if (!video) return;

  if (activeJobs.has(videoId) || queuedVideoIds.has(videoId)) return;

  if (activeJobs.size >= maxConcurrentJobs) {
    queuedJobs.push({ url, filename, videoId, video, startTime });
    queuedVideoIds.add(videoId);
    updateQueueStatuses();
    return;
  }

  const controller = new AbortController();
  activeJobs.add(videoId);
  activeJobControllers.set(videoId, controller);
  emitStatus(videoId, "recording", "Recording trimmed video…", 0);

  recordMediaSource(video, videoId, filename, controller.signal, startTime)
    .catch((error) => {
      if (error && error.name === "AbortError") return;
      console.error("[Media Downloader] Trim failed:", error);
      emitStatus(videoId, "error", (error && error.message) || String(error || "Unknown error"));
    })
    .finally(() => {
      activeJobs.delete(videoId);
      activeJobControllers.delete(videoId);
      startQueuedJobs();
    });
});

window.addEventListener(CONTROL_EVENT, (event) => {
  const { videoId, action } = event.detail || {};
  if (!videoId || (action !== "save" && action !== "cancel")) return;

  if (action === "save") {
    activeRecordings.get(videoId)?.save();
    return;
  }

  const queueIndex = queuedJobs.findIndex((job) => job.videoId === videoId);
  if (queueIndex !== -1) {
    const [job] = queuedJobs.splice(queueIndex, 1);
    queuedVideoIds.delete(videoId);
    releaseMediaSourceLock(job.source);
    emitStatus(videoId, "canceled", "Video download canceled.");
    updateQueueStatuses();
    return;
  }

  activeJobControllers.get(videoId)?.abort();
  activeRecordings.get(videoId)?.cancel();
  if (activeJobs.has(videoId)) {
    emitStatus(videoId, "canceled", "Video download canceled.");
  }
});

function startJob(job) {
  const { url, filename, videoId, video, source } = job;
  const controller = new AbortController();
  activeJobs.add(videoId);
  activeJobControllers.set(videoId, controller);
  emitStatus(videoId, "recording", "Preparing video download…");
  let operation;
  if (source?.kind === "blob") {
    operation = downloadKnownBlob(url, filename, videoId, controller.signal);
  } else if (
    source?.kind === "media-source" &&
    source.record.buffers.length === 1
  ) {
    operation = downloadCapturedMediaSource(
      video,
      videoId,
      filename,
      source.record.buffers[0],
      controller.signal
    );
  } else {
    operation = recordMediaSource(
      video,
      videoId,
      filename,
      controller.signal
    );
  }

  operation
    .catch((error) => {
      if (error && error.name === "AbortError") return;
      console.error("[Media Downloader] Video download failed:", error);
      emitStatus(videoId, "error", (error && error.message) || String(error || "Unknown error"));
    })
    .finally(() => {
      releaseMediaSourceLock(source);
      activeJobs.delete(videoId);
      activeJobControllers.delete(videoId);
      startQueuedJobs();
    });
}

function releaseMediaSourceLock(source) {
  if (source?.kind !== "media-source") return;
  source.record.lockCount -= 1;
  if (source.record.lockCount) return;
  for (const pendingUrl of source.record.pendingRevokes) {
    blobKinds.delete(pendingUrl);
    nativeRevokeObjectURL(pendingUrl);
  }
  source.record.pendingRevokes.clear();
}

function startQueuedJobs() {
  while (activeJobs.size < maxConcurrentJobs && queuedJobs.length) {
    const job = queuedJobs.shift();
    queuedVideoIds.delete(job.videoId);
    startJob(job);
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

async function downloadKnownBlob(url, filename, videoId, signal) {
  const response = await fetch(url, { signal });
  const blob = await response.blob();
  signal.throwIfAborted();
  if (!blob.size) throw new Error("The Blob video contains no data.");
  await validateVideoBlob(blob, signal);
  signal.throwIfAborted();
  const downloadUrl = nativeCreateObjectURL(blob);
  triggerDownload(downloadUrl, filename);
  setTimeout(() => nativeRevokeObjectURL(downloadUrl), 60_000);
  emitStatus(videoId, "complete", "Blob video downloaded.", 100);
}

async function downloadCapturedMediaSource(
  video,
  videoId,
  filename,
  bufferRecord,
  signal
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
      await waitForMediaCompletion(video, videoId, signal);
    }

    signal.throwIfAborted();

    const mimeType = bufferRecord.mimeType.split(";")[0] || "video/mp4";
    const extension = mimeType.includes("webm") ? "webm" : "mp4";
    const blob = new Blob(bufferRecord.chunks, { type: mimeType });
    if (!blob.size) {
      throw new Error("No MediaSource segments were captured.");
    }
    await validateVideoBlob(blob, signal);
    signal.throwIfAborted();

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

function waitForMediaCompletion(video, videoId, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    let settled = false;
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
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener("ended", finish);
      video.removeEventListener("error", fail);
      video.removeEventListener("timeupdate", reportProgress);
      signal.removeEventListener("abort", cancel);
      releasePlaybackLock();
      if (error) reject(error);
      else resolve();
    };
    const finish = () => settle();
    const cancel = () => settle(signal.reason || new DOMException("Canceled", "AbortError"));
    const fail = () =>
      settle(new Error("Video playback failed while collecting segments."));

    activeRecordings.set(videoId, { save: finish, cancel });
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener("abort", cancel, { once: true });
    video.addEventListener("ended", finish, { once: true });
    video.addEventListener("error", fail, { once: true });
    video.addEventListener("timeupdate", reportProgress);
    if (Number.isFinite(video.duration) && video.duration > 0) {
      timer = setTimeout(finish, Math.ceil(video.duration * 1000) + 5000);
    }
    video.play().catch(() => {});
  });
}

async function recordMediaSource(video, videoId, filename, signal, startTime) {
  signal.throwIfAborted();
  if (typeof video.captureStream !== "function" || !window.MediaRecorder) {
    throw new Error("This browser cannot record MediaSource video streams.");
  }

  const stream = video.captureStream();
  if (!stream.getVideoTracks().length) {
    throw new Error("The video stream has no capturable video track.");
  }

  const hdr = isHdrVideo(video);
  const mimeType = getRecorderMimeType(hdr);
  if (!mimeType) {
    throw new Error("This Chrome build cannot record this video.");
  }
  const ext = mimeType.includes("webm") ? "webm" : "mp4";
  const outputName = replaceExtension(filename, ext);
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: getRecordingBitrate(video),
    audioBitsPerSecond: 256_000,
  });
  const originalTime = video.currentTime;
  const wasPaused = video.paused;
  const wasLooping = video.loop;
  const hasStartTime = startTime != null && Number.isFinite(startTime) && startTime > 0;
  const recordDuration =
    Number.isFinite(video.duration) && video.duration > 0
      ? video.duration - (hasStartTime ? startTime : 0)
      : null;
  let targetDuration = recordDuration;
  const chunks = [];
  let safetyTimer;
  let reachedEndAt = null;
  let releasePlaybackLock = () => {};
  let recordingElapsed = 0;
  const reportProgress = () => {
    const elapsed = video.currentTime - (hasStartTime ? startTime : 0);
    recordingElapsed = Math.max(0, elapsed);
    const progress = targetDuration ? (recordingElapsed / targetDuration) * 100 : undefined;
    const label = `Recording ${recordingElapsed.toFixed(1)}s…`;
    emitStatus(videoId, "progress", label, progress);
  };

  const completion = new Promise((resolve, reject) => {
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) chunks.push(event.data);
    });
    recorder.addEventListener("stop", resolve, { once: true });
    recorder.addEventListener(
      "error",
      () => reject(recorder.error || new DOMException("Recording failed", "MediaRecorderError")),
      { once: true }
    );
  });

  const stop = () => {
    if (recorder.state !== "inactive") recorder.stop();
  };
  const cancel = () => stop();
  activeRecordings.set(videoId, { save: stop, cancel });
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) {
    activeRecordings.delete(videoId);
    signal.removeEventListener("abort", cancel);
    signal.throwIfAborted();
  }

  let completed = false;
  try {
    if (video.seekable.length && video.duration !== Infinity) {
      video.currentTime = hasStartTime ? Math.min(startTime, video.duration) : 0;
    }
    video.loop = false;
    releasePlaybackLock = keepVideoPlaying(video);
    recorder.start(1000);
    await video.play();
    const recordingStartedAt = performance.now();
    const recordStartTime = video.currentTime;
    safetyTimer = setInterval(() => {
      if (!targetDuration && Number.isFinite(video.duration) && video.duration > 0) {
        targetDuration = recordDuration ?? video.duration - (hasStartTime ? startTime : 0);
      }
      if (!targetDuration) return;
      const currentPos = video.currentTime - (hasStartTime ? startTime : 0);
      const lastRenderedFrame = (renderedFrameTimes.get(video) ?? 0) - (hasStartTime ? startTime : 0);
      const playbackReachedEnd = currentPos >= targetDuration - 0.15;
      const videoReachedEnd = lastRenderedFrame >= targetDuration - 0.5;
      if (playbackReachedEnd && videoReachedEnd) {
        reachedEndAt ??= performance.now();
        if (performance.now() - reachedEndAt >= 250) stop();
        return;
      }
      reachedEndAt = null;
      const expectedDuration =
        (targetDuration / Math.max(video.playbackRate, 0.1)) * 1000;
      if (performance.now() - recordingStartedAt > expectedDuration + 15_000) {
        stop();
      }
    }, 250);
    emitStatus(videoId, "recording", hasStartTime ? `Recording from ${startTime}s…` : "Recording video stream…", 0);
    video.addEventListener("timeupdate", reportProgress);
    await completion;
    signal.throwIfAborted();
    const recordedBlob = new Blob(chunks, { type: recorder.mimeType });
    if (!recordedBlob.size) {
      throw new Error("No video data was captured; no file was created.");
    }
    await validateVideoBlob(recordedBlob, signal);
    signal.throwIfAborted();
    const downloadUrl = nativeCreateObjectURL(recordedBlob);
    triggerDownload(downloadUrl, outputName);
    setTimeout(() => nativeRevokeObjectURL(downloadUrl), 60_000);
    emitStatus(videoId, "complete", "MediaSource recording saved.", 100);
    completed = true;
  } finally {
    clearInterval(safetyTimer);
    releasePlaybackLock();
    activeRecordings.delete(videoId);
    signal.removeEventListener("abort", cancel);
    video.removeEventListener("timeupdate", reportProgress);
    if (!completed && Number.isFinite(originalTime)) video.currentTime = originalTime;
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
    "position:fixed;top:0;left:0;width:100vw;min-height:400px;display:flex;" +
    "flex-wrap:wrap;overflow:hidden;align-items:flex-start;" +
    "opacity:.01;pointer-events:none;z-index:2147483646;transform:translateZ(0)";
  document.documentElement.appendChild(captureRenderHost);
  return captureRenderHost;
}

function hostVideoForCapture(video) {
  const originalParent = video.parentNode;
  const originalNextSibling = video.nextSibling;
  const originalStyle = video.getAttribute("style");
  const originalMuted = video.muted;
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

  const placeholderContext = placeholder.getContext("2d");
  let stopped = false;
  let frameCallbackId;
  const paintPlaceholder = () => {
    if (stopped || !placeholder.isConnected) return;
    try {
      placeholderContext?.drawImage(
        video,
        0,
        0,
        placeholder.width,
        placeholder.height
      );
    } catch {}
  };
  const paintFrame = () => {
    if (stopped) return;
    paintPlaceholder();
    frameCallbackId = video.requestVideoFrameCallback?.(paintFrame);
  };

  originalParent.insertBefore(placeholder, video);
  getCaptureRenderHost().appendChild(video);
  video.muted = true;
  const capW = Math.min(video.videoWidth || 640, 640);
  const capH = Math.min(video.videoHeight || 360, 360);
  video.style.cssText =
    `position:relative;display:block;flex:0 0 ${capW}px;width:${capW}px;height:${capH}px;` +
    `min-width:${capW}px;min-height:${capH}px;opacity:1;pointer-events:none;` +
    "transform:translateZ(0);will-change:transform,opacity";

  if (typeof video.requestVideoFrameCallback === "function") {
    frameCallbackId = video.requestVideoFrameCallback(paintFrame);
  }
  const paintInterval = setInterval(paintPlaceholder, 100);

  return () => {
    stopped = true;
    clearInterval(paintInterval);
    if (frameCallbackId !== undefined) {
      video.cancelVideoFrameCallback?.(frameCallbackId);
    }
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
    video.muted = originalMuted;
  };
}

function keepVideoFramesDecoded(video) {
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 90;
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.cssText =
    "display:block;flex:0 0 160px;width:160px;height:90px;" +
    "min-width:160px;min-height:90px;pointer-events:none";
  getCaptureRenderHost().appendChild(canvas);
  const context = canvas.getContext("2d", { alpha: false });
  let stopped = false;
  let callbackId;
  let lastFrameCount = video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
  const paint = () => {
    if (stopped) return;
    try {
      context?.drawImage(video, 0, 0, canvas.width, canvas.height);
    } catch {}
  };
  const onFrame = (_now, metadata) => {
    if (Number.isFinite(metadata?.mediaTime)) {
      renderedFrameTimes.set(video, metadata.mediaTime);
    }
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
    if (frameCount > lastFrameCount) {
      renderedFrameTimes.set(video, currentTime);
    }
    lastFrameCount = frameCount;
  }, 250);

  return () => {
    stopped = true;
    clearInterval(intervalId);
    if (callbackId !== undefined) video.cancelVideoFrameCallback?.(callbackId);
    renderedFrameTimes.delete(video);
    canvas.remove();
  };
}

function isHdrVideo(video) {
  const cs = video.videoColorSpace;
  if (!cs) return false;
  return cs.transfer === "pq" || cs.transfer === "hlg";
}

function getRecorderMimeType(isHdr) {
  const candidates = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4;codecs=avc1.64003E,mp4a.40.2",
    "video/mp4",
  ];
  if (isHdr) {
    candidates.unshift(
      "video/mp4;codecs=hvc1.2.4.L150.90,mp4a.40.2",
      "video/mp4;codecs=hev1.2.4.L150.90,mp4a.40.2",
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp9"
    );
  }
  return candidates.find((type) => MediaRecorder.isTypeSupported(type));
}

function validateVideoBlob(blob, signal) {
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
      signal?.removeEventListener("abort", cancel);
      probe.removeAttribute("src");
      probe.load();
      nativeRevokeObjectURL(url);
      if (error) reject(error);
      else resolve();
    };
    const cancel = () =>
      finish(signal.reason || new DOMException("Canceled", "AbortError"));
    if (signal?.aborted) {
      cancel();
      return;
    }
    signal?.addEventListener("abort", cancel, { once: true });
    probe.preload = "metadata";
    probe.addEventListener(
      "loadedmetadata",
      () => {
        const hasVideo = probe.videoWidth > 0 && probe.videoHeight > 0;
        const hasDuration = probe.duration > 0 || probe.duration === Infinity;
        if (!hasVideo || !hasDuration) {
          finish(new Error("Generated file does not contain playable video."));
          return;
        }
        finish(null);
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
