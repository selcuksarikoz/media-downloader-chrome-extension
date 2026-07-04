/**
 * Runs in the page's MAIN world so page-owned Blob and MediaSource URLs remain
 * accessible. Content scripts cannot reliably fetch those URLs from their
 * isolated JavaScript world.
 */

const DOWNLOAD_EVENT = "imd:download-blob-video";
const STATUS_EVENT = "imd:blob-video-status";
const blobKinds = new Map();
const activeRecordings = new Map();

const nativeCreateObjectURL = URL.createObjectURL.bind(URL);
URL.createObjectURL = (object) => {
  const url = nativeCreateObjectURL(object);
  if (object instanceof MediaSource) {
    blobKinds.set(url, "media-source");
  } else if (object instanceof Blob) {
    blobKinds.set(url, "blob");
  }
  return url;
};

const nativeRevokeObjectURL = URL.revokeObjectURL.bind(URL);
URL.revokeObjectURL = (url) => {
  blobKinds.delete(url);
  return nativeRevokeObjectURL(url);
};

window.addEventListener(DOWNLOAD_EVENT, (event) => {
  const { url, filename, videoId } = event.detail || {};
  if (!url || !videoId) return;

  const video = document.querySelector(
    `video[data-imd-capture-id="${CSS.escape(videoId)}"]`
  );
  if (!video) return;

  if (activeRecordings.has(videoId)) {
    activeRecordings.get(videoId).stop();
    return;
  }

  const kind = blobKinds.get(url);
  const operation =
    kind === "media-source"
      ? recordMediaSource(video, videoId, filename)
      : streamBlob(url, filename, videoId).catch((error) => {
          if (error && error.name === "AbortError") throw error;
          return recordMediaSource(video, videoId, filename);
        });

  operation.catch((error) => {
    if (error && error.name === "AbortError") return;
    emitStatus(videoId, "error", error.message || String(error));
  });
});

async function streamBlob(url, filename, videoId) {
  const responsePromise = fetch(url);
  const fileHandle = await pickFile(filename, [
    {
      description: "Video",
      accept: {
        "video/mp4": [".mp4"],
        "video/webm": [".webm"],
        "video/quicktime": [".mov"],
        "video/x-matroska": [".mkv"],
      },
    },
  ]);
  const response = await responsePromise;
  if (!response.ok || !response.body) {
    throw new Error(`Blob stream could not be read (${response.status}).`);
  }

  const writable = await fileHandle.createWritable();
  await response.body.pipeTo(writable);
  emitStatus(videoId, "complete", "Blob video downloaded.");
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
  const webmName = replaceExtension(filename, "webm");
  const fileHandle = await pickFile(webmName, [
    {
      description: "WebM video recording",
      accept: { "video/webm": [".webm"] },
    },
  ]);
  const writable = await fileHandle.createWritable();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
  const originalTime = video.currentTime;
  const wasPaused = video.paused;
  let writeQueue = Promise.resolve();

  const completion = new Promise((resolve, reject) => {
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) {
        writeQueue = writeQueue.then(() => writable.write(event.data));
      }
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
    recorder.start(1000);
    await video.play();
    emitStatus(
      videoId,
      "recording",
      "MediaSource recording started. Click download again to stop."
    );
    await completion;
    await writeQueue;
    await writable.close();
    emitStatus(videoId, "complete", "MediaSource recording saved.");
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  } finally {
    activeRecordings.delete(videoId);
    video.removeEventListener("ended", stop);
    if (Number.isFinite(originalTime)) video.currentTime = originalTime;
    if (wasPaused) video.pause();
  }
}

function getRecorderMimeType() {
  return [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ].find((type) => MediaRecorder.isTypeSupported(type));
}

function replaceExtension(filename, extension) {
  const base = (filename || `video-${Date.now()}`).replace(/\.[^.]+$/, "");
  return `${base}.${extension}`;
}

function pickFile(suggestedName, types) {
  if (typeof window.showSaveFilePicker !== "function") {
    throw new Error("Saving streamed video requires Chrome File System Access.");
  }
  return window.showSaveFilePicker({ suggestedName, types });
}

function emitStatus(videoId, status, message) {
  window.dispatchEvent(
    new CustomEvent(STATUS_EVENT, {
      detail: { videoId, status, message },
    })
  );
}
