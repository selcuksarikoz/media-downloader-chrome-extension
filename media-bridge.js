const DOWNLOAD_EVENT = "imd:download-blob-video";
const TRIM_EVENT = "imd:trim-blob-video";
const CONTROL_EVENT = "imd:control-blob-video";
const STATUS_EVENT = "imd:blob-video-status";
const BLOB_DATA_EVENT = "imd:blob-data-for-download";
const PAGE_MEDIA_DOWNLOAD_EVENT = "imd:download-page-media";
const PERSIST_CHUNK_EVENT = "imd:persist-blob-chunk";
const MUX_EVENT = "imd:mux-blob-tracks";
const MUX_RESULT_EVENT = "imd:mux-blob-tracks-result";
const NAVIGATION_BLOCKED_EVENT = "imd:navigation-blocked";
const CAPTURE_BLOCK_EVENT = "imd:capture-block";
const CAPTURE_UNBLOCK_EVENT = "imd:capture-unblock";
const blobKinds = new Map();
const BLOB_KINDS_MAX_SIZE = 500;

// Instagram prefers VP9/AV1 when Chrome advertises support, but macOS Finder
// and Quick Look do not reliably open those codecs inside MP4. Advertise the
// universally compatible H.264 path before Instagram selects a representation.
if (
  location.hostname === "instagram.com" ||
  location.hostname.endsWith(".instagram.com")
) {
  const isPreviewIncompatibleCodec = (value) =>
    /(?:vp0?9|av0?1)/i.test(String(value || ""));

  if (window.MediaSource?.isTypeSupported) {
    const nativeIsTypeSupported = MediaSource.isTypeSupported.bind(MediaSource);
    try {
      MediaSource.isTypeSupported = (type) =>
        isPreviewIncompatibleCodec(type) ? false : nativeIsTypeSupported(type);
    } catch {}
  }

  const nativeCanPlayType = HTMLMediaElement.prototype.canPlayType;
  HTMLMediaElement.prototype.canPlayType = function (type) {
    return isPreviewIncompatibleCodec(type)
      ? ""
      : nativeCanPlayType.call(this, type);
  };

  const mediaCapabilities = navigator.mediaCapabilities;
  if (mediaCapabilities?.decodingInfo) {
    const nativeDecodingInfo = mediaCapabilities.decodingInfo.bind(
      mediaCapabilities
    );
    try {
      mediaCapabilities.decodingInfo = async (config) => {
        if (isPreviewIncompatibleCodec(config?.video?.contentType)) {
          return {
            supported: false,
            smooth: false,
            powerEfficient: false,
          };
        }
        return nativeDecodingInfo(config);
      };
    } catch {}
  }
}

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
const mediaSourceRecords = new WeakMap();
const sourceBufferRecords = new WeakMap();
const responseSources = new WeakMap();
const payloadSources = new WeakMap();
const protectedVideos = new WeakSet();
const captureBlockedVideos = new WeakSet();
const renderedFrameTimes = new WeakMap();
const nativeHistoryPushState = History.prototype.pushState;
const nativeHistoryReplaceState = History.prototype.replaceState;
let lastAllowedPageUrl = location.href;

function hasActiveMediaJob() {
  return activeJobs.size > 0;
}

function emitNavigationBlocked() {
  window.dispatchEvent(new CustomEvent(NAVIGATION_BLOCKED_EVENT));
}

function isDifferentPageUrl(url) {
  if (url == null) return false;
  try {
    return new URL(String(url), location.href).href !== location.href;
  } catch {
    return false;
  }
}

History.prototype.pushState = function (state, unused, url) {
  if (hasActiveMediaJob() && isDifferentPageUrl(url)) {
    emitNavigationBlocked();
    return;
  }
  const result = nativeHistoryPushState.call(this, state, unused, url);
  lastAllowedPageUrl = location.href;
  return result;
};

History.prototype.replaceState = function (state, unused, url) {
  if (hasActiveMediaJob() && isDifferentPageUrl(url)) {
    emitNavigationBlocked();
    return;
  }
  const result = nativeHistoryReplaceState.call(this, state, unused, url);
  lastAllowedPageUrl = location.href;
  return result;
};

window.addEventListener(
  "popstate",
  (event) => {
    if (!hasActiveMediaJob()) {
      lastAllowedPageUrl = location.href;
      return;
    }
    event.stopImmediatePropagation();
    nativeHistoryPushState.call(history, history.state, "", lastAllowedPageUrl);
    emitNavigationBlocked();
  },
  true
);

window.addEventListener(
  "hashchange",
  (event) => {
    if (!hasActiveMediaJob()) {
      lastAllowedPageUrl = location.href;
      return;
    }
    event.stopImmediatePropagation();
    nativeHistoryReplaceState.call(
      history,
      history.state,
      "",
      lastAllowedPageUrl
    );
    emitNavigationBlocked();
  },
  true
);

window.addEventListener("beforeunload", (event) => {
  if (!hasActiveMediaJob()) return;
  event.preventDefault();
  event.returnValue = "";
});

function normalizeRequestUrl(input) {
  try {
    const value = typeof input === "string" || input instanceof URL
      ? String(input)
      : input?.url;
    return value ? new URL(value, document.baseURI).href : "";
  } catch {
    return "";
  }
}

function getResponseSource(response, fallbackUrl = "") {
  const header = (name) => {
    try {
      return response.headers?.get(name) || "";
    } catch {
      return "";
    }
  };
  return {
    url: response.url || fallbackUrl,
    status: response.status || 0,
    contentType: header("Content-Type"),
    contentRange: header("Content-Range"),
    contentLength: Number.parseInt(header("Content-Length"), 10) || 0,
  };
}

function tagMediaPayload(payload, source) {
  if (!payload || !source?.url) return payload;
  if (payload instanceof ArrayBuffer) payloadSources.set(payload, source);
  else if (ArrayBuffer.isView(payload)) payloadSources.set(payload.buffer, source);
  else if (payload instanceof Blob) payloadSources.set(payload, source);
  return payload;
}

// Associate bytes appended to MediaSource with the original CDN response.
// The association lets the extension fetch the complete track independently
// without seeking or accelerating the page's video element.
const nativeFetch = window.fetch;
window.fetch = async function (...args) {
  const fallbackUrl = normalizeRequestUrl(args[0]);
  const response = await nativeFetch.apply(this, args);
  responseSources.set(response, getResponseSource(response, fallbackUrl));
  return response;
};

const nativeResponseClone = Response.prototype.clone;
Response.prototype.clone = function () {
  const clone = nativeResponseClone.call(this);
  const source = responseSources.get(this);
  if (source) responseSources.set(clone, source);
  return clone;
};

for (const method of ["arrayBuffer", "blob"]) {
  const nativeMethod = Response.prototype[method];
  Response.prototype[method] = async function (...args) {
    const payload = await nativeMethod.apply(this, args);
    return tagMediaPayload(
      payload,
      responseSources.get(this) || getResponseSource(this)
    );
  };
}

const nativeBlobArrayBuffer = Blob.prototype.arrayBuffer;
Blob.prototype.arrayBuffer = async function (...args) {
  const payload = await nativeBlobArrayBuffer.apply(this, args);
  return tagMediaPayload(payload, payloadSources.get(this));
};

const nativeArrayBufferSlice = ArrayBuffer.prototype.slice;
ArrayBuffer.prototype.slice = function (...args) {
  const sliced = nativeArrayBufferSlice.apply(this, args);
  return tagMediaPayload(sliced, payloadSources.get(this));
};

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const nativeTypedArraySlice = typedArrayPrototype.slice;
if (typeof nativeTypedArraySlice === "function") {
  typedArrayPrototype.slice = function (...args) {
    const sliced = nativeTypedArraySlice.apply(this, args);
    tagMediaPayload(sliced, payloadSources.get(this.buffer));
    return sliced;
  };
}

if (window.ReadableStream && window.ReadableStreamDefaultReader) {
  const streamSources = new WeakMap();
  const readerSources = new WeakMap();
  const bodyDescriptor = Object.getOwnPropertyDescriptor(Response.prototype, "body");
  if (bodyDescriptor?.get) {
    Object.defineProperty(Response.prototype, "body", {
      ...bodyDescriptor,
      get() {
        const stream = bodyDescriptor.get.call(this);
        const source = responseSources.get(this);
        if (stream && source) streamSources.set(stream, source);
        return stream;
      },
    });
  }
  const nativeGetReader = ReadableStream.prototype.getReader;
  ReadableStream.prototype.getReader = function (...args) {
    const reader = nativeGetReader.apply(this, args);
    const source = streamSources.get(this);
    if (source) readerSources.set(reader, source);
    return reader;
  };
  const nativeReaderRead = ReadableStreamDefaultReader.prototype.read;
  ReadableStreamDefaultReader.prototype.read = async function (...args) {
    const result = await nativeReaderRead.apply(this, args);
    tagMediaPayload(result?.value, readerSources.get(this));
    return result;
  };
}

if (window.XMLHttpRequest) {
  const xhrSources = new WeakMap();
  const nativeXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    xhrSources.set(this, { url: normalizeRequestUrl(url) });
    return nativeXhrOpen.call(this, method, url, ...args);
  };
  const responseDescriptor = Object.getOwnPropertyDescriptor(
    XMLHttpRequest.prototype,
    "response"
  );
  if (responseDescriptor?.get) {
    Object.defineProperty(XMLHttpRequest.prototype, "response", {
      ...responseDescriptor,
      get() {
        const payload = responseDescriptor.get.call(this);
        const initial = xhrSources.get(this);
        if (!initial) return payload;
        let source = initial;
        try {
          source = {
            url: this.responseURL || initial.url,
            status: this.status || 0,
            contentType: this.getResponseHeader("Content-Type") || "",
            contentRange: this.getResponseHeader("Content-Range") || "",
            contentLength:
              Number.parseInt(this.getResponseHeader("Content-Length"), 10) || 0,
          };
        } catch {}
        return tagMediaPayload(payload, source);
      },
    });
  }
}

const nativePause = HTMLMediaElement.prototype.pause;
const nativePlay = HTMLMediaElement.prototype.play;
HTMLMediaElement.prototype.pause = function () {
  if (protectedVideos.has(this) && !this.ended) {
    queueMicrotask(() => {
      if (protectedVideos.has(this) && this.paused && !this.ended) {
        nativePlay.call(this).catch(() => {});
      }
    });
    return;
  }
  return nativePause.call(this);
};
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
    const bufferRecord = { mimeType, chunks: [], sources: [] };
    record.buffers.push(bufferRecord);
    sourceBufferRecords.set(sourceBuffer, { bufferRecord, mediaRecord: record });
    return sourceBuffer;
  };

  const nativeAppendBuffer = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data) {
    const sourceRecord = sourceBufferRecords.get(this);
    if (sourceRecord && data) {
      const source = payloadSources.get(
        ArrayBuffer.isView(data) ? data.buffer : data
      );
      if (
        source?.url &&
        !sourceRecord.bufferRecord.sources.some(
          (existing) => existing.url === source.url
        )
      ) {
        sourceRecord.bufferRecord.sources.push(source);
      }
      const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
      sourceRecord.bufferRecord.chunks.push(bytes.slice().buffer);
    }
    return nativeAppendBuffer.call(this, data);
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
    // Keep only our bookkeeping until the job settles. Revoking the real URL
    // remains the page's decision and must not be delayed by a download.
    source.record.pendingRevokes.add(url);
    return nativeRevokeObjectURL(url);
  }
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

  if (activeJobs.has(videoId)) return;

  const source = blobKinds.get(url);
  if (source?.kind === "media-source") source.record.lockCount += 1;
  const job = { url, filename, videoId, video, source };
  startJob(job);
});

window.addEventListener(PAGE_MEDIA_DOWNLOAD_EVENT, (event) => {
  const { url, filename, videoId } = event.detail || {};
  const isTelegram = isTelegramProgressiveUrl(url);
  const isInstagram = isInstagramDirectVideoUrl(url);
  if (!url || !videoId || (!isTelegram && !isInstagram)) return;
  if (activeJobs.has(videoId)) return;

  const controller = new AbortController();
  activeJobs.add(videoId);
  activeJobControllers.set(videoId, controller);
  emitStatus(
    videoId,
    "recording",
    isTelegram
      ? "Downloading Telegram video…"
      : "Downloading and finalizing Instagram video…",
    0
  );

  const operation = isTelegram
    ? downloadTelegramProgressiveVideo(
        url,
        filename,
        videoId,
        controller.signal
      )
    : downloadInstagramDirectVideo(
        url,
        filename,
        videoId,
        controller.signal
      );
  operation
    .catch((error) => {
      if (error?.name === "AbortError") return;
      console.error("[Media Downloader] Page video download failed:", error);
      emitStatus(
        videoId,
        "error",
        error?.message || "Video download failed."
      );
    })
    .finally(() => {
      activeJobs.delete(videoId);
      activeJobControllers.delete(videoId);
    });
});

window.addEventListener(TRIM_EVENT, (event) => {
  const { url, filename, videoId, startTime } = event.detail || {};
  if (!url || !videoId) return;

  const video = document.querySelector(
    `video[data-imd-capture-id="${CSS.escape(videoId)}"]`
  );
  if (!video) return;

  if (activeJobs.has(videoId)) return;

  const source = blobKinds.get(url);
  if (source?.kind === "media-source") source.record.lockCount += 1;
  const job = {
    url,
    filename,
    videoId,
    video,
    source,
    startTime,
    isTrim: true,
  };

  startJob(job);
});

window.addEventListener(CONTROL_EVENT, (event) => {
  const { videoId, action } = event.detail || {};
  if (!videoId || (action !== "save" && action !== "cancel")) return;

  if (action === "save") {
    activeRecordings.get(videoId)?.save();
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
  return new Blob(getOrderedCapturedChunks(videoBuffer.chunks), {
    type: mimeType,
  });
}

function getOrderedCapturedChunks(chunks) {
  const inspected = chunks.map((chunk, index) => ({
    chunk,
    index,
    decodeTime: getFragmentDecodeTime(chunk),
  }));
  const timed = inspected.filter((entry) => entry.decodeTime !== undefined);
  if (timed.length < 2) return chunks;

  let previousDecodeTime = -Infinity;
  let needsOrdering = false;
  for (const entry of timed) {
    if (entry.decodeTime <= previousDecodeTime) {
      needsOrdering = true;
      break;
    }
    previousDecodeTime = entry.decodeTime;
  }
  if (!needsOrdering) return chunks;

  const headers = inspected.filter((entry) => entry.decodeTime === undefined);
  timed.sort(
    (a, b) => a.decodeTime - b.decodeTime || a.index - b.index
  );

  // Seeking back to zero can make the page append a fragment that was already
  // captured before the download started. Keep one fragment per decode time.
  const unique = [];
  let previousTime;
  for (const entry of timed) {
    if (entry.decodeTime === previousTime) continue;
    unique.push(entry.chunk);
    previousTime = entry.decodeTime;
  }
  return [...headers.map((entry) => entry.chunk), ...unique];
}

function getFragmentDecodeTime(chunk) {
  const bytes = new Uint8Array(chunk);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const readBoxes = (start, end, depth = 0) => {
    let offset = start;
    while (offset + 8 <= end) {
      let size = view.getUint32(offset);
      const type = String.fromCharCode(
        bytes[offset + 4],
        bytes[offset + 5],
        bytes[offset + 6],
        bytes[offset + 7]
      );
      let headerSize = 8;
      if (size === 1) {
        if (offset + 16 > end) return undefined;
        const high = view.getUint32(offset + 8);
        const low = view.getUint32(offset + 12);
        size = high * 2 ** 32 + low;
        headerSize = 16;
      } else if (size === 0) {
        size = end - offset;
      }
      if (size < headerSize || offset + size > end) return undefined;

      if (type === "tfdt" && offset + headerSize + 8 <= end) {
        const version = bytes[offset + headerSize];
        const valueOffset = offset + headerSize + 4;
        if (version === 1 && valueOffset + 8 <= offset + size) {
          return (
            view.getUint32(valueOffset) * 2 ** 32 +
            view.getUint32(valueOffset + 4)
          );
        }
        if (valueOffset + 4 <= offset + size) {
          return view.getUint32(valueOffset);
        }
      }

      if (depth < 3 && (type === "moof" || type === "traf")) {
        const nested = readBoxes(
          offset + headerSize,
          offset + size,
          depth + 1
        );
        if (nested !== undefined) return nested;
      }
      offset += size;
    }
    return undefined;
  };
  return readBoxes(0, bytes.byteLength);
}

function startJob(job) {
  const { url, filename, videoId, video, source, startTime, isTrim } = job;
  const controller = new AbortController();
  activeJobs.add(videoId);
  activeJobControllers.set(videoId, controller);
  emitStatus(
    videoId,
    "recording",
    isTrim ? "Preparing fast video trim…" : "Preparing video download…"
  );
  let operation;
  if (isTrim && source?.kind === "blob") {
    operation = trimKnownBlob(
      url,
      filename,
      videoId,
      controller.signal,
      startTime
    );
  } else if (isTrim && source?.kind === "media-source") {
    operation = downloadCapturedMediaSource(
      video,
      videoId,
      filename,
      source.record.buffers,
      controller.signal,
      startTime
    );
  } else if (source?.kind === "blob") {
    operation = downloadKnownBlob(url, filename, videoId, controller.signal);
  } else if (source?.kind === "media-source") {
    operation = downloadCapturedMediaSource(
      video,
      videoId,
      filename,
      source.record.buffers,
      controller.signal
    );
  } else {
    operation = Promise.reject(
      new Error(
        "Independent download is unavailable because no original media segments were captured."
      )
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
    });
}

function releaseMediaSourceLock(source) {
  if (source?.kind !== "media-source") return;
  source.record.lockCount -= 1;
  if (source.record.lockCount) return;
  for (const pendingUrl of source.record.pendingRevokes) {
    blobKinds.delete(pendingUrl);
  }
  source.record.pendingRevokes.clear();
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
  if (isInstagramPage()) {
    emitStatus(videoId, "recording", "Finalizing MP4 for system preview…", 98);
    await requestFastMux(
      videoId,
      filename,
      [{ mimeType: blob.type || "video/mp4", blob }],
      undefined,
      signal
    );
    emitStatus(videoId, "complete", "Preview-compatible MP4 saved.", 100);
    return;
  }
  await validateVideoBlob(blob, signal);
  signal.throwIfAborted();
  sendBlobForDownload(blob, filename, videoId);
  emitStatus(videoId, "complete", "Blob video downloaded.", 100);
}

function isTelegramProgressiveUrl(value) {
  try {
    const url = new URL(value, document.baseURI);
    return (
      url.protocol === "https:" &&
      url.hostname === "web.telegram.org" &&
      /\/progressive\//i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function isInstagramPage() {
  return (
    location.hostname === "instagram.com" ||
    location.hostname.endsWith(".instagram.com")
  );
}

function isInstagramDirectVideoUrl(value) {
  if (!isInstagramPage()) return false;
  try {
    const url = new URL(value, document.baseURI);
    return (
      url.protocol === "https:" &&
      (url.hostname.endsWith(".fbcdn.net") ||
        url.hostname.endsWith(".cdninstagram.com"))
    );
  } catch {
    return false;
  }
}

async function downloadInstagramDirectVideo(
  url,
  filename,
  videoId,
  signal
) {
  await requestFastMux(
    videoId,
    filename,
    [{ mimeType: "video/mp4", url }],
    undefined,
    signal
  );
  emitStatus(videoId, "complete", "Preview-compatible MP4 saved.", 100);
}

async function downloadTelegramProgressiveVideo(
  url,
  filename,
  videoId,
  signal
) {
  // Telegram's progressive URLs are virtual resources resolved by Telegram
  // Web's Service Worker. It requires a byte Range and caps each response at
  // 512 KiB, so download ranges in parallel just like Telegram's own download
  // endpoint does. A plain fetch throws before producing a Response.
  const chunkSize = 512 * 1024;
  const first = await fetchTelegramProgressiveRange(
    url,
    0,
    chunkSize - 1,
    signal
  );
  const { fullSize, contentType } = first;
  if (!Number.isSafeInteger(fullSize) || fullSize <= 0) {
    throw new Error("Telegram did not provide a valid video size.");
  }

  const chunkCount = Math.ceil(fullSize / chunkSize);
  const chunks = new Array(chunkCount);
  chunks[0] = first.data;
  let loaded = first.data.byteLength;
  let nextIndex = 1;
  const workerCount = Math.min(8, Math.max(0, chunkCount - 1));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= chunkCount) return;
      signal.throwIfAborted();
      const start = index * chunkSize;
      const part = await fetchTelegramProgressiveRange(
        url,
        start,
        Math.min(fullSize - 1, start + chunkSize - 1),
        signal
      );
      chunks[index] = part.data;
      loaded += part.data.byteLength;
      emitStatus(
        videoId,
        "progress",
        "Downloading Telegram video in parallel…",
        Math.min(99, (loaded / fullSize) * 100)
      );
    }
  });
  await Promise.all(workers);
  signal.throwIfAborted();
  const blob = new Blob(chunks, { type: contentType || "video/mp4" });
  if (!blob.size) throw new Error("Telegram returned an empty video file.");
  if (blob.size !== fullSize) {
    throw new Error("Telegram returned an incomplete video file.");
  }

  const prefix = await blob.slice(0, 512).text();
  signal.throwIfAborted();
  if (
    /(?:text\/html|application\/xhtml\+xml)/i.test(contentType) ||
    /^\s*(?:<!doctype\s+html|<html[\s>])/i.test(prefix)
  ) {
    throw new Error(
      "Telegram returned a web page instead of the requested video."
    );
  }

  await validateVideoBlob(blob, signal);
  signal.throwIfAborted();
  const extension = /webm/i.test(contentType || blob.type) ? "webm" : "mp4";
  sendBlobForDownload(blob, replaceExtension(filename, extension), videoId);
  emitStatus(videoId, "complete", "Telegram video downloaded.", 100);
}

async function fetchTelegramProgressiveRange(url, start, end, signal) {
  const response = await nativeFetch.call(window, url, {
    headers: { Range: `bytes=${start}-${end}` },
    credentials: "include",
    redirect: "follow",
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    throw new Error(`Telegram video request failed (${response.status}).`);
  }

  const contentRange = response.headers.get("Content-Range") || "";
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(contentRange);
  if (!match) {
    throw new Error("Telegram returned an invalid video range.");
  }
  const returnedStart = Number(match[1]);
  const returnedEnd = Number(match[2]);
  const fullSize = Number(match[3]);
  if (returnedStart !== start || returnedEnd < returnedStart) {
    throw new Error("Telegram returned an unexpected video range.");
  }

  const data = await response.arrayBuffer();
  signal.throwIfAborted();
  if (data.byteLength !== returnedEnd - returnedStart + 1) {
    throw new Error("Telegram returned an incomplete video range.");
  }
  return {
    data,
    fullSize,
    contentType: response.headers.get("Content-Type") || "",
  };
}

async function trimKnownBlob(url, filename, videoId, signal, startTime) {
  const response = await fetch(url, { signal });
  const blob = await response.blob();
  signal.throwIfAborted();
  if (!blob.size) throw new Error("The Blob video contains no data.");
  emitStatus(videoId, "recording", "Trimming video with FFmpeg…", 90);
  await requestFastMux(
    videoId,
    filename,
    [{ mimeType: blob.type || "video/mp4", blob }],
    startTime,
    signal
  );
  emitStatus(videoId, "complete", "Trim muxed without re-encoding.", 100);
}

async function downloadCapturedMediaSource(
  video,
  videoId,
  filename,
  bufferRecords,
  signal,
  startTime
) {
  let restoreAcceleratedPlayback = () => {};
  try {
    const hadIndependentTracks = getIndependentTracks(bufferRecords).length > 0;
    if (
      await downloadIndependentTracks(
        bufferRecords,
        videoId,
        filename,
        startTime,
        signal
      )
    ) return;

    if (!isMediaFullyBuffered(video)) {
      let collectionMessage =
        "Collecting segments in the background; you can use the video normally…";
      if (!(startTime > 0)) {
        const hasCapturedFragments = bufferRecords.some((buffer) =>
          buffer.chunks.some(
            (chunk) => getFragmentDecodeTime(chunk) !== undefined
          )
        );
        const accelerated = await accelerateMediaCollection(
          video,
          signal,
          !hasCapturedFragments
        );
        restoreAcceleratedPlayback = accelerated.restore;
        collectionMessage = `Collecting segments at ${accelerated.rate}× playback…`;
      }
      emitStatus(
        videoId,
        "recording",
        collectionMessage,
        0
      );
      const waitResult = await waitForMediaCompletion(
        video,
        videoId,
        signal,
        () =>
          !hadIndependentTracks && getIndependentTracks(bufferRecords).length > 0,
        collectionMessage
      );
      if (
        waitResult === "independent" &&
        await downloadIndependentTracks(
          bufferRecords,
          videoId,
          filename,
          startTime,
          signal
        )
      ) return;
      if (!isMediaFullyBuffered(video)) {
        await waitForMediaCompletion(
          video,
          videoId,
          signal,
          undefined,
          collectionMessage
        );
      }
    }

    signal.throwIfAborted();

    const availableBuffers = bufferRecords.filter(
      (buffer) =>
        buffer?.chunks?.length && /^(audio|video)\//i.test(buffer.mimeType)
    );
    if (!availableBuffers.length) {
      throw new Error("No MediaSource segments were captured.");
    }

    if (
      availableBuffers.length === 1 &&
      !(startTime > 0) &&
      !isInstagramPage()
    ) {
      const bufferRecord = availableBuffers[0];
      const mimeType = bufferRecord.mimeType.split(";")[0] || "video/mp4";
      const extension = mimeType.includes("webm") ? "webm" : "mp4";
      const blob = new Blob(getOrderedCapturedChunks(bufferRecord.chunks), {
        type: mimeType,
      });
      if (!blob.size) throw new Error("No MediaSource segments were captured.");
      await validateVideoBlob(blob, signal);
      signal.throwIfAborted();
      sendBlobForDownload(blob, replaceExtension(filename, extension), videoId);
    } else {
      const orderedChunks = availableBuffers.map((buffer) =>
        getOrderedCapturedChunks(buffer.chunks)
      );
      const tracks = availableBuffers.map((buffer, index) => ({
        mimeType: buffer.mimeType,
        blob: new Blob(orderedChunks[index], {
          type: buffer.mimeType.split(";")[0] || "application/octet-stream",
        }),
      }));
      emitStatus(
        videoId,
        "recording",
        isInstagramPage()
          ? "Finalizing MP4 for system preview…"
          : "Muxing audio and video with FFmpeg…",
        98
      );
      try {
        await requestFastMux(videoId, filename, tracks, startTime, signal);
      } catch (orderedError) {
        const wasReordered = availableBuffers.some(
          (buffer, index) => orderedChunks[index] !== buffer.chunks
        );
        if (wasReordered) {
          emitStatus(
            videoId,
            "recording",
            "Retrying mux with original segment order…",
            98
          );
          const originalTracks = availableBuffers.map((buffer) => ({
            mimeType: buffer.mimeType,
            blob: new Blob(buffer.chunks, {
              type:
                buffer.mimeType.split(";")[0] || "application/octet-stream",
            }),
          }));
          try {
            await requestFastMux(
              videoId,
              filename,
              originalTracks,
              startTime,
              signal
            );
          } catch {
            await fallbackToMediaRecorder(orderedError);
            return;
          }
        } else {
          await fallbackToMediaRecorder(orderedError);
          return;
        }
      }
    }
    emitStatus(
      videoId,
      "complete",
      startTime > 0
        ? "Trim muxed without re-encoding."
        : "Original media tracks muxed.",
      100
    );
  } finally {
    restoreAcceleratedPlayback();
    activeRecordings.delete(videoId);
  }

  async function fallbackToMediaRecorder(muxError) {
    if (signal.aborted) throw muxError;
    console.warn(
      "[Media Downloader] Captured segment mux failed; retrying with MediaRecorder:",
      muxError
    );
    restoreAcceleratedPlayback();
    restoreAcceleratedPlayback = () => {};
    emitStatus(
      videoId,
      "recording",
      "Retrying with real-time video capture…",
      0
    );
    await recordMediaSource(video, videoId, filename, signal, startTime);
  }
}

async function downloadIndependentTracks(
  bufferRecords,
  videoId,
  filename,
  startTime,
  signal
) {
  const independentTracks = getIndependentTracks(bufferRecords);
  if (!independentTracks.length) return false;
  try {
    emitStatus(
      videoId,
      "recording",
      "Downloading original tracks independently in parallel…",
      5
    );
    await requestFastMux(
      videoId,
      filename,
      independentTracks,
      startTime,
      signal
    );
    emitStatus(
      videoId,
      "complete",
      startTime > 0
        ? "Independent download and trim completed."
        : "Original tracks downloaded and muxed independently.",
      100
    );
    return true;
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    console.warn(
      "[Media Downloader] Independent track download unavailable; " +
        "falling back to captured segments:",
      error
    );
    return false;
  }
}

function getIndependentTracks(bufferRecords) {
  const mediaBuffers = bufferRecords.filter((buffer) =>
    /^(audio|video)\//i.test(buffer?.mimeType || "")
  );
  if (!mediaBuffers.length) return [];

  const tracks = [];
  for (const buffer of mediaBuffers) {
    const source = [...(buffer.sources || [])]
      .reverse()
      .find(isCompleteTrackSource);
    if (!source) return [];
    tracks.push({
      mimeType: buffer.mimeType,
      url: source.url,
      fullSize: getTrackFullSize(source),
    });
  }
  return tracks.some((track) => /^video\//i.test(track.mimeType)) ? tracks : [];
}

function isCompleteTrackSource(source) {
  if (!/^https?:/i.test(source?.url || "")) return false;
  if (/^bytes\s+\d+-\d+\/\d+$/i.test(source.contentRange || "")) return true;
  let hasExplicitByteWindow = false;
  try {
    const params = new URL(source.url).searchParams;
    hasExplicitByteWindow =
      params.has("bytestart") ||
      params.has("byteend") ||
      params.has("byte_start") ||
      params.has("byte_end") ||
      params.has("range");
  } catch {}
  if (hasExplicitByteWindow) return isRewritableInstagramRangeUrl(source.url);

  // Twitter/X commonly serves its canonical .mp4 track URL with status 206
  // while CORS hides Content-Range from page JavaScript. A fresh request to
  // that same URL, without a Range header, still downloads the complete track.
  // Recognize the canonical file URL before rejecting non-200 responses so we
  // can switch to the independent downloader instead of waiting for playback.
  if (/\.(?:mp4|m4a|webm|mov)(?:$|[?#])/i.test(source.url)) {
    if (
      source.status === 200 &&
      source.contentLength > 0 &&
      source.contentLength < 64 * 1024 &&
      !source.contentRange
    ) {
      return false;
    }
    return true;
  }
  if (source.status !== 200) return false;
  return (
    /^(?:audio|video)\//i.test(source.contentType || "") &&
    !/\.(?:m4s|ts)(?:$|[?#])/i.test(source.url)
  );
}

function isRewritableInstagramRangeUrl(value) {
  try {
    const url = new URL(value);
    const isInstagramCdn =
      url.hostname.endsWith(".fbcdn.net") ||
      url.hostname.endsWith(".cdninstagram.com");
    const params = url.searchParams;
    const hasRangePair =
      (params.has("bytestart") && params.has("byteend")) ||
      (params.has("byte_start") && params.has("byte_end"));
    return isInstagramCdn && hasRangePair;
  } catch {
    return false;
  }
}

function getTrackFullSize(source) {
  const match = /\/([0-9]+)$/i.exec(source?.contentRange || "");
  const size = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(size) && size > 0 ? size : undefined;
}

function requestFastMux(videoId, filename, tracks, startTime, signal) {
  return new Promise((resolve, reject) => {
    const requestId = `${videoId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let settled = false;
    const cleanup = () => {
      window.removeEventListener(MUX_RESULT_EVENT, onResult);
      signal.removeEventListener("abort", onAbort);
    };
    const settle = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () =>
      settle(signal.reason || new DOMException("Canceled", "AbortError"));
    const onResult = (event) => {
      if (event.detail?.requestId !== requestId) return;
      if (event.detail.ok) {
        settle();
        return;
      }
      const error = new Error(event.detail.error || "FFmpeg mux failed.");
      if (event.detail.canceled) error.name = "AbortError";
      settle(error);
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    window.addEventListener(MUX_RESULT_EVENT, onResult);
    signal.addEventListener("abort", onAbort, { once: true });
    window.dispatchEvent(
      new CustomEvent(MUX_EVENT, {
        detail: { requestId, videoId, filename, tracks, startTime },
      })
    );
  });
}

function isMediaFullyBuffered(video) {
  if (!Number.isFinite(video.duration) || !video.buffered.length) return false;
  let bufferedUntil = 0;
  for (let index = 0; index < video.buffered.length; index += 1) {
    const start = video.buffered.start(index);
    const end = video.buffered.end(index);
    if (start > bufferedUntil + 0.25) return false;
    bufferedUntil = Math.max(bufferedUntil, end);
  }
  return bufferedUntil >= video.duration - 0.25;
}

function waitForMediaCompletion(
  video,
  videoId,
  signal,
  independentReady,
  collectionMessage =
    "Collecting segments in the background; you can use the video normally…"
) {
  return new Promise((resolve, reject) => {
    let checkTimer;
    let settled = false;
    const reportProgress = () => {
      let furthestBufferedTime = 0;
      for (let index = 0; index < video.buffered.length; index += 1) {
        furthestBufferedTime = Math.max(
          furthestBufferedTime,
          video.buffered.end(index)
        );
      }
      const progress = Number.isFinite(video.duration) && video.duration > 0
        ? (furthestBufferedTime / video.duration) * 100
        : undefined;
      emitStatus(
        videoId,
        "progress",
        collectionMessage,
        progress
      );
      if (independentReady?.()) {
        settle(null, "independent");
        return;
      }
      if (isMediaFullyBuffered(video) || video.ended) finish();
    };
    const settle = (error, result) => {
      if (settled) return;
      settled = true;
      clearInterval(checkTimer);
      video.removeEventListener("ended", finish);
      video.removeEventListener("error", fail);
      video.removeEventListener("progress", reportProgress);
      video.removeEventListener("durationchange", reportProgress);
      signal.removeEventListener("abort", cancel);
      if (error) reject(error);
      else resolve(result);
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
    video.addEventListener("progress", reportProgress);
    video.addEventListener("durationchange", reportProgress);
    checkTimer = setInterval(reportProgress, 500);
    reportProgress();
  });
}

async function accelerateMediaCollection(video, signal, restartFromBeginning) {
  const state = {
    paused: video.paused,
    currentTime: video.currentTime,
    playbackRate: video.playbackRate,
    defaultPlaybackRate: video.defaultPlaybackRate,
    muted: video.muted,
    loop: video.loop,
  };
  const releaseKeepAlive = keepVideoPlaying(video);
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    releaseKeepAlive();
    video.loop = state.loop;
    video.muted = state.muted;
    try {
      video.defaultPlaybackRate = state.defaultPlaybackRate;
      video.playbackRate = state.playbackRate;
    } catch {}
    try {
      if (Number.isFinite(state.currentTime)) video.currentTime = state.currentTime;
    } catch {}
    if (state.paused) nativePause.call(video);
    else nativePlay.call(video).catch(() => {});
  };

  try {
    video.loop = false;
    video.muted = true;
    let rate = 1;
    for (const candidate of [8, 4, 2]) {
      try {
        video.defaultPlaybackRate = candidate;
        video.playbackRate = candidate;
        rate = video.playbackRate;
        if (rate === candidate) break;
      } catch {}
    }

    if (restartFromBeginning && video.seekable.length) {
      const beginning = video.seekable.start(0);
      if (Math.abs(video.currentTime - beginning) > 0.05) {
        video.currentTime = beginning;
        await waitForVideoSeek(video, signal);
      }
    }
    signal.throwIfAborted();
    await nativePlay.call(video);
    try {
      video.playbackRate = rate;
    } catch {}
    return { rate, restore };
  } catch (error) {
    restore();
    throw error;
  }
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
  const releaseCaptureHost = hostVideoForCapture(captureVideo);
  // Automatic downloads record a single full pass; disable looping so the
  // recording ends deterministically. Trims are user-stopped, so leave loop
  // untouched there.
  if (!hasStartTime) captureVideo.loop = false;
  // Seeking a MediaSource-backed video is asynchronous. The recorder must not
  // start before the seek completes and the first frame at the target position
  // is rendered, otherwise the captureStream video track produces no frames
  // and the file starts with audio-only data.
  let seekTarget = 0;
  let recorder;
  try {
    const seeks = video.seekable.length && video.duration !== Infinity;
    seekTarget = hasStartTime ? Math.min(startTime, video.duration) : 0;
    const needsSeek =
      seeks && Math.abs(captureVideo.currentTime - seekTarget) > 0.05;
    if (seeks) {
      captureVideo.currentTime = seekTarget;
      if (needsSeek) await waitForVideoSeek(captureVideo, signal);
    }

    if (signal.aborted) throw new DOMException("Canceled", "AbortError");
    const recordStream = captureVideo.captureStream();
    if (!recordStream.getVideoTracks().length) {
      throw new Error("The video stream has no capturable video track.");
    }

    recorder = new MediaRecorder(recordStream, {
      mimeType,
      videoBitsPerSecond: getRecordingBitrate(video),
      audioBitsPerSecond: 128_000,
    });
  } catch (error) {
    releaseCaptureHost();
    protectedVideos.delete(captureVideo);
    if (!hasStartTime) captureVideo.loop = wasLooping;
    throw error;
  }
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
    releaseCaptureHost();
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
  const releaseCaptureHost = hostVideoForCapture(video);
  const releaseFramePump = keepVideoFramesDecoded(video);
  video.preload = "auto";

  return () => {
    protectedVideos.delete(video);
    video.preload = previousPreload;
    releaseFramePump();
    releaseCaptureHost();
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
  const originalStyle = video.getAttribute("style");
  const originalAriaHidden = video.getAttribute("aria-hidden");
  let movedToHost = false;
  let released = false;

  const keepAlive = () => {
    if (released) return;
    if (!video.isConnected) {
      const host = getCaptureRenderHost();
      host.appendChild(video);
      video.setAttribute("aria-hidden", "true");
      video.style.setProperty("display", "block", "important");
      video.style.setProperty("width", "160px", "important");
      video.style.setProperty("height", "90px", "important");
      video.style.setProperty("min-width", "160px", "important");
      video.style.setProperty("min-height", "90px", "important");
      video.style.setProperty("pointer-events", "none", "important");
      movedToHost = true;
    }
    if (video.paused && !video.ended) {
      nativePlay.call(video).catch(() => {});
    }
  };

  const observer = new MutationObserver(keepAlive);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  const playbackTimer = setInterval(keepAlive, 500);
  document.addEventListener("visibilitychange", keepAlive);

  return () => {
    released = true;
    observer.disconnect();
    clearInterval(playbackTimer);
    document.removeEventListener("visibilitychange", keepAlive);
    if (!movedToHost) return;

    if (originalStyle === null) video.removeAttribute("style");
    else video.setAttribute("style", originalStyle);
    if (originalAriaHidden === null) video.removeAttribute("aria-hidden");
    else video.setAttribute("aria-hidden", originalAriaHidden);

    if (video.parentNode === captureRenderHost) {
      video.remove();
    }
    cleanupCaptureRenderHost();
  };
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
