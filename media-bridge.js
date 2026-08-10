const DOWNLOAD_EVENT = "imd:download-blob-video";
const TRIM_EVENT = "imd:trim-blob-video";
const CONTROL_EVENT = "imd:control-blob-video";
const STATUS_EVENT = "imd:blob-video-status";
const BLOB_DATA_EVENT = "imd:blob-data-for-download";
const PERSIST_CHUNK_EVENT = "imd:persist-blob-chunk";
const CAPTURE_BLOCK_EVENT = "imd:capture-block";
const CAPTURE_UNBLOCK_EVENT = "imd:capture-unblock";
const blobKinds = new Map();
const BLOB_KINDS_MAX_SIZE = 500;

function trimBlobKinds() {
  if (blobKinds.size <= BLOB_KINDS_MAX_SIZE) return;
  const excess = blobKinds.size - BLOB_KINDS_MAX_SIZE;
  let removed = 0;
  for (const [url, entry] of blobKinds) {
    if (removed >= excess) break;
    if (entry.kind !== "media-source" || !entry.record?.lockCount) {
      blobKinds.delete(url);
      removed++;
    }
  }
}
const activeRecordings = new Map();
const activeJobs = new Set();
const activeJobControllers = new Map();
const queuedJobs = [];
const queuedVideoIds = new Set();
let maxConcurrentJobs = 2;
const mediaSourceRecords = new WeakMap();
const sourceBufferRecords = new WeakMap();
const protectedVideos = new WeakSet();
const captureBlockedVideos = new WeakSet();
const renderedFrameTimes = new WeakMap();

const nativePause = HTMLMediaElement.prototype.pause;
const nativePlay = HTMLMediaElement.prototype.play;
HTMLMediaElement.prototype.play = function () {
  if (captureBlockedVideos.has(this)) return Promise.resolve();
  return nativePlay.call(this);
};
const nativeLoad = HTMLMediaElement.prototype.load;
HTMLMediaElement.prototype.load = function () {
  if (!protectedVideos.has(this)) return nativeLoad.call(this);
};

for (const property of ["src", "srcObject"]) {
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
  trimBlobKinds();
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
    Math.max(1, Number.parseInt(maxConcurrent, 10) || 2)
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
    Math.max(1, Number.parseInt(maxConcurrent, 10) || 2)
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

window.addEventListener(CAPTURE_BLOCK_EVENT, (event) => {
  const video = event.detail?.video;
  if (video instanceof HTMLMediaElement) captureBlockedVideos.add(video);
});

window.addEventListener(CAPTURE_UNBLOCK_EVENT, (event) => {
  const video = event.detail?.video;
  if (video instanceof HTMLMediaElement) captureBlockedVideos.delete(video);
});

const CAPTURE_FROM_MSE_EVENT = "imd:capture-from-mse";
const CAPTURE_FROM_MSE_RESULT_EVENT = "imd:capture-from-mse-result";

window.addEventListener(CAPTURE_FROM_MSE_EVENT, (event) => {
  const { url, requestId } = event.detail || {};
  if (!url || !requestId) return;
  const source = blobKinds.get(url);
  let blob = null;
  if (source?.kind === "media-source" && source.record?.buffers?.length) {
    blob = buildBlobFromRecordedBuffers(source.record.buffers);
  }
  try {
    window.dispatchEvent(
      new CustomEvent(CAPTURE_FROM_MSE_RESULT_EVENT, {
        detail: { requestId, blob },
      })
    );
  } catch {}
});

/**
 * Concatenate the recorded SourceBuffer segments into one playable blob.
 * Audio and video usually live in separate buffers; pick the video track and
 * fall back to the buffer holding the most data.
 */
function buildBlobFromRecordedBuffers(buffers) {
  const videoBuffer =
    buffers.find((buffer) => /video/i.test(buffer.mimeType)) ||
    buffers.reduce((largest, buffer) =>
      buffer.chunks.length > largest.chunks.length ? buffer : largest
    );
  if (!videoBuffer?.chunks?.length) return null;
  const mimeType = videoBuffer.mimeType.split(";")[0] || "video/mp4";
  return new Blob(videoBuffer.chunks, { type: mimeType });
}

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

function sendBlobForDownload(blob, filename, videoId) {
  try {
    window.dispatchEvent(
      new CustomEvent(BLOB_DATA_EVENT, {
        detail: { blob, filename, videoId },
      })
    );
  } catch (error) {
    emitStatus(videoId, "error", error.message || "Failed to prepare download.");
  }
}

function persistChunk(videoId, blob) {
  try {
    window.dispatchEvent(
      new CustomEvent(PERSIST_CHUNK_EVENT, {
        detail: { videoId, blob },
      })
    );
  } catch {}
}

async function downloadKnownBlob(url, filename, videoId, signal) {
  const response = await fetch(url, { signal });
  const blob = await response.blob();
  signal.throwIfAborted();
  if (!blob.size) throw new Error("The Blob video contains no data.");
  await validateVideoBlob(blob, signal);
  signal.throwIfAborted();
  sendBlobForDownload(blob, filename, videoId);
  emitStatus(videoId, "complete", "Blob video downloaded.", 100);
}

async function downloadCapturedMediaSource(
  video,
  videoId,
  filename,
  bufferRecord,
  signal
) {
  const wasPaused = video.paused;
  const wasLooping = video.loop;

  try {
    if (!isMediaFullyBuffered(video)) {
      video.loop = false;
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

    sendBlobForDownload(blob, replaceExtension(filename, extension), videoId);
    emitStatus(
      videoId,
      "complete",
      "Original media segments downloaded.",
      100
    );
  } finally {
    activeRecordings.delete(videoId);
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
    let stallTimer;
    let settled = false;
    let lastProgressTime = video.currentTime;
    let lastProgressUpdateAt = Date.now();
    const releasePlaybackLock = keepVideoPlaying(video);
    const reportProgress = () => {
      lastProgressUpdateAt = Date.now();
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
      clearInterval(stallTimer);
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
    // Guard against infinite duration (common for MediaSource streams): if
    // playback stops making progress for a while, finalize with the segments
    // collected so far instead of hanging the download forever.
    stallTimer = setInterval(() => {
      const current = video.currentTime;
      if (current === lastProgressTime) {
        if (Date.now() - lastProgressUpdateAt > 15000) finish();
      } else {
        lastProgressTime = current;
      }
    }, 1000);
    video.play().catch(() => {});
  });
}

async function recordMediaSource(video, videoId, filename, signal, startTime) {
  signal.throwIfAborted();
  if (typeof video.captureStream !== "function" || !window.MediaRecorder) {
    throw new Error("This browser cannot record MediaSource video streams.");
  }
  const hasStartTime = startTime != null && Number.isFinite(startTime) && startTime > 0;
  const hdr = isHdrVideo(video);
  const mimeType = getRecorderMimeType(hdr);
  if (!mimeType) {
    throw new Error("This Chrome build cannot record this video.");
  }
  const ext = mimeType.includes("webm") ? "webm" : "mp4";
  const outputName = replaceExtension(filename, ext);

  const captureVideo = video;
  const wasLooping = captureVideo.loop;
  // The page usually recycles this element for the next reel/story by swapping
  // its source. Lock the source for the duration of the recording so the
  // download keeps capturing the original media instead of stalling or
  // switching to unrelated content.
  protectedVideos.add(captureVideo);
  // Automatic downloads record a single full pass; disable looping so the
  // recording ends deterministically. Trims are user-stopped, so leave loop
  // untouched there.
  if (!hasStartTime) captureVideo.loop = false;
  // Seeking a MediaSource-backed video is asynchronous. The recorder must not
  // start before the seek completes and the first frame at the target position
  // is rendered, otherwise the captureStream video track produces no frames
  // and the file starts with audio-only data.
  const seeks = video.seekable.length && video.duration !== Infinity;
  const seekTarget = hasStartTime ? Math.min(startTime, video.duration) : 0;
  const needsSeek = seeks && Math.abs(captureVideo.currentTime - seekTarget) > 0.05;
  if (seeks) {
    captureVideo.currentTime = seekTarget;
    if (needsSeek) await waitForVideoSeek(captureVideo, signal);
  }

  if (signal.aborted) throw new DOMException("Canceled", "AbortError");
  const recordStream = captureVideo.captureStream();
  if (!recordStream.getVideoTracks().length) {
    throw new Error("The video stream has no capturable video track.");
  }

  const recorder = new MediaRecorder(recordStream, {
    mimeType,
    videoBitsPerSecond: getRecordingBitrate(video),
    audioBitsPerSecond: 128_000,
  });
  const chunks = [];
  let safetyTimer;
  let releaseFramePump = () => {};
  let recordingStartPos = 0;
  let recordingElapsed = 0;
  let lastTimeupdateAt = Date.now();
  const reportProgress = () => {
    lastTimeupdateAt = Date.now();
    recordingElapsed = Math.max(0, captureVideo.currentTime - recordingStartPos);
    const label = `Recording ${recordingElapsed.toFixed(1)}s…`;
    emitStatus(videoId, "progress", label, getRecordingProgress(captureVideo, recordingStartPos));
  };

  const completion = new Promise((resolve, reject) => {
    recorder.addEventListener("dataavailable", (event) => {
      // MediaRecorder emits one final dataavailable event after stop(). When
      // stop() was caused by cancellation that chunk must not resurrect the
      // canceled persistence job in the background worker.
      if (!signal.aborted && event.data && event.data.size > 0) {
        chunks.push(event.data);
        persistChunk(videoId, event.data);
      }
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
  let stallTimer;
  let lastProgressTime = captureVideo.currentTime;
  try {
    releaseFramePump = keepVideoFramesDecoded(captureVideo);
    await captureVideo.play();
    // Wait until a frame at the target position is actually being rendered
    // before starting the recorder so the file does not begin with a
    // video-less segment (audio-only head).
    await waitForFirstRenderedFrame(captureVideo, seekTarget, signal);
    signal.throwIfAborted();
    recordingStartPos = captureVideo.currentTime;
    recorder.start(1000);
    safetyTimer = setInterval(() => {
      if (captureVideo.ended || (Number.isFinite(captureVideo.duration) && captureVideo.duration > 0 && captureVideo.currentTime >= captureVideo.duration - 0.15)) {
        stop();
      }
    }, 250);
    // If the element stops producing frames (e.g. the page recycled it even
    // though we locked the source), finalize with what was captured instead of
    // leaving the download hanging forever.
    stallTimer = setInterval(() => {
      const current = captureVideo.currentTime;
      if (current !== lastProgressTime) {
        lastProgressTime = current;
        return;
      }
      if (captureVideo.ended) {
        stop();
        return;
      }
      if (Date.now() - lastTimeupdateAt > 15000) {
        stop();
      }
    }, 1000);
    emitStatus(videoId, "recording", hasStartTime ? `Recording from ${startTime}s…` : "Recording video stream…", 0);
    captureVideo.addEventListener("ended", stop, { once: true });
    captureVideo.addEventListener("timeupdate", reportProgress);
    await completion;
    signal.throwIfAborted();
    const recordedBlob = new Blob(chunks, { type: recorder.mimeType });
    if (!recordedBlob.size) {
      throw new Error("No video data was captured; no file was created.");
    }
    await validateVideoBlob(recordedBlob, signal);
    signal.throwIfAborted();
    sendBlobForDownload(recordedBlob, outputName, videoId);
    emitStatus(videoId, "complete", "MediaSource recording saved.", 100);
    completed = true;
  } finally {
    clearInterval(safetyTimer);
    clearInterval(stallTimer);
    releaseFramePump();
    protectedVideos.delete(captureVideo);
    if (!hasStartTime) captureVideo.loop = wasLooping;
    activeRecordings.delete(videoId);
    signal.removeEventListener("abort", cancel);
    captureVideo.removeEventListener("ended", stop);
    captureVideo.removeEventListener("timeupdate", reportProgress);
    if (recorder.state !== "inactive") recorder.stop();
    captureVideo.pause();
  }
}

/** Resolve once an in-flight seek on the video completes. */
function waitForVideoSeek(video, signal) {
  if (!video.seeking) return Promise.resolve();
  return new Promise((resolve) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onFailed);
      signal?.removeEventListener("abort", onAbort);
    };
    const onSeeked = () => { cleanup(); resolve(); };
    const onFailed = () => { cleanup(); resolve(); };
    const onAbort = () => { cleanup(); resolve(); };
    timer = setTimeout(onFailed, 3000);
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onFailed, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Wait until the video renders its first frame at the target position. */
function waitForFirstRenderedFrame(video, targetTime, signal) {
  return new Promise((resolve) => {
    if (typeof video.requestVideoFrameCallback !== "function") {
      setTimeout(resolve, 150);
      return;
    }
    let frameId;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      if (frameId !== undefined) video.cancelVideoFrameCallback?.(frameId);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => { cleanup(); resolve(); };
    const onFrame = (_now, metadata) => {
      frameId = undefined;
      const frameTime = metadata?.mediaTime;
      if (!Number.isFinite(frameTime) || Math.abs(frameTime - targetTime) > 0.1) {
        frameId = video.requestVideoFrameCallback(onFrame);
        return;
      }
      cleanup();
      resolve();
    };
    timer = setTimeout(onAbort, 3000);
    video.requestVideoFrameCallback(onFrame);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function waitForLoadedMetadata(video, signal) {
  return new Promise((resolve, reject) => {
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) { resolve(); return; }
    const onMeta = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error("Video metadata load failed")); };
    const onAbort = () => { cleanup(); reject(new DOMException("Canceled", "AbortError")); };
    const cleanup = () => {
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    video.addEventListener("loadedmetadata", onMeta, { once: true });
    video.addEventListener("error", onError, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function getRecordingProgress(video, startTime) {
  if (!Number.isFinite(video.duration) || video.duration <= startTime) {
    return undefined;
  }
  const elapsed = Math.max(0, video.currentTime - startTime);
  const remainingDuration = video.duration - startTime;
  return (elapsed / remainingDuration) * 100;
}

function keepVideoPlaying(video) {
  const previousPreload = video.preload;
  protectedVideos.add(video);
  const releaseFramePump = keepVideoFramesDecoded(video);
  video.preload = "auto";

  return () => {
    protectedVideos.delete(video);
    video.preload = previousPreload;
    releaseFramePump();
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

function cleanupCaptureRenderHost() {
  if (captureRenderHost && !captureRenderHost.children.length) {
    captureRenderHost.remove();
    captureRenderHost = null;
  }
}

function hostVideoForCapture(video) {
  return () => {};
}

function keepVideoFramesDecoded(video) {
  const canvas = document.createElement("canvas");
  const vw = video.videoWidth || 0;
  const vh = video.videoHeight || 0;
  if (vw >= 3840 || vh >= 2160) {
    canvas.width = 1280;
    canvas.height = 720;
  } else if (vw >= 1920 || vh >= 1080) {
    canvas.width = 640;
    canvas.height = 360;
  } else {
    canvas.width = 320;
    canvas.height = 180;
  }
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

  const supportsRvfc = typeof video.requestVideoFrameCallback === "function";
  if (supportsRvfc) {
    callbackId = video.requestVideoFrameCallback(onFrame);
  }
  // Throttle the timer fallback: on HDR/4K streams a tight repaint interval is
  // the main source of page jank during recording. requestVideoFrameCallback
  // already paints once per rendered frame where supported.
  const intervalId = supportsRvfc
    ? null
    : setInterval(() => {
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
    if (intervalId) clearInterval(intervalId);
    if (callbackId !== undefined) video.cancelVideoFrameCallback?.(callbackId);
    renderedFrameTimes.delete(video);
    canvas.remove();
    cleanupCaptureRenderHost();
  };
}

function isHdrVideo(video) {
  const cs = video.videoColorSpace;
  if (!cs) return false;
  return cs.transfer === "pq" || cs.transfer === "hlg";
}

function getRecorderMimeType(isHdr) {
  const candidates = [
    "video/mp4;codecs=hvc1.2.4.L150.90,mp4a.40.2",
    "video/mp4;codecs=hev1.2.4.L150.90,mp4a.40.2",
  ];
  if (isHdr) {
    candidates.push(
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp9"
    );
  }
  candidates.push(
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4;codecs=avc1.64003E,mp4a.40.2",
    "video/mp4"
  );
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
  if (pixels >= 3840 * 2160) return 50_000_000;
  if (pixels >= 2560 * 1440) return 30_000_000;
  if (pixels >= 1920 * 1080) return 20_000_000;
  return 12_000_000;
}

function replaceExtension(filename, extension) {
  const base = (filename || `video-${Date.now()}`).replace(/\.[^.]+$/, "");
  return `${base}.${extension}`;
}

function emitStatus(videoId, status, message, progress) {
  window.dispatchEvent(
    new CustomEvent(STATUS_EVENT, {
      detail: { videoId, status, message, progress },
    })
  );
}
