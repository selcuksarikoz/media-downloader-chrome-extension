/**
 * Runs in the page's MAIN world so page-owned Blob and MediaSource URLs remain
 * accessible. Content scripts cannot reliably fetch those URLs from their
 * isolated JavaScript world.
 */

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
  const operation =
    source?.kind === "blob"
      ? downloadKnownBlob(url, filename, videoId)
      : source?.kind === "media-source" && source.record.buffers.length === 1
        ? downloadCapturedMediaSource(
            video,
            videoId,
            filename,
            source.record.buffers[0]
          )
        : recordMediaSource(video, videoId, filename);

  operation
    .catch((error) => {
      if (error && error.name === "AbortError") return;
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
      0,
      index + 1
    );
  });
}

async function downloadKnownBlob(url, filename, videoId) {
  const response = await fetch(url);
  const blob = await response.blob();
  if (!blob.size) throw new Error("The Blob video contains no data.");
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
    const finish = () => {
      clearTimeout(timer);
      video.removeEventListener("ended", finish);
      video.removeEventListener("error", fail);
      video.removeEventListener("timeupdate", reportProgress);
      resolve();
    };
    const fail = () => {
      clearTimeout(timer);
      reject(new Error("Video playback failed while collecting segments."));
    };

    activeRecordings.set(videoId, { stop: finish });
    video.addEventListener("ended", finish, { once: true });
    video.addEventListener("error", fail, { once: true });
    video.addEventListener("timeupdate", reportProgress);
    if (Number.isFinite(video.duration) && video.duration > 0) {
      timer = setTimeout(finish, Math.ceil(video.duration * 1000) + 5000);
    }
    video.play().catch(fail);
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
  let stopTimer;
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
    recorder.start(1000);
    await video.play();
    if (Number.isFinite(video.duration) && video.duration > 0) {
      stopTimer = setTimeout(
        stop,
        Math.ceil((video.duration / Math.max(video.playbackRate, 0.1)) * 1000) +
          2000
      );
    }
    emitStatus(
      videoId,
      "recording",
      "Recording video stream…",
      0
    );
    video.addEventListener("timeupdate", reportProgress);
    await completion;
    const recordedBlob = new Blob(chunks, { type: recorder.mimeType });
    if (!recordedBlob.size) {
      throw new Error("No video data was captured; no file was created.");
    }
    const downloadUrl = nativeCreateObjectURL(recordedBlob);
    triggerDownload(downloadUrl, outputName);
    setTimeout(() => nativeRevokeObjectURL(downloadUrl), 60_000);
    emitStatus(videoId, "complete", "MediaSource recording saved.", 100);
  } catch (error) {
    throw error;
  } finally {
    clearTimeout(stopTimer);
    activeRecordings.delete(videoId);
    video.removeEventListener("ended", stop);
    video.removeEventListener("timeupdate", reportProgress);
    if (Number.isFinite(originalTime)) video.currentTime = originalTime;
    video.loop = wasLooping;
    if (wasPaused) video.pause();
  }
}

function getRecorderMimeType() {
  return [
    "video/mp4;codecs=avc1.64003E,mp4a.40.2",
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4",
  ].find((type) => MediaRecorder.isTypeSupported(type));
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

function emitStatus(videoId, status, message, progress, queuePosition) {
  window.dispatchEvent(
    new CustomEvent(STATUS_EVENT, {
      detail: { videoId, status, message, progress, queuePosition },
    })
  );
}
