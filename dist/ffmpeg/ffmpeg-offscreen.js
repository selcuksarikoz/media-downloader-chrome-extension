const jobs = new Map();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "ffmpeg-offscreen") return;

  if (message.action === "startIndependentMux") {
    startIndependentMux(message);
    sendResponse({ ok: true });
    return;
  }

  if (message.action === "cancelIndependentMux") {
    cancelJob(message.muxId);
    sendResponse({ ok: true });
    return;
  }

  if (message.action === "releaseIndependentMux") {
    releaseJob(message.muxId, message.url);
    sendResponse({ ok: true });
  }
});

async function startIndependentMux(message) {
  const { muxId, tracks, startTime } = message;
  if (!muxId || !tracks?.length || jobs.has(muxId)) return;

  const job = { controller: new AbortController(), worker: null, message };
  jobs.set(muxId, job);
  try {
    const downloads = new Map();
    const preparedTracks = await Promise.all(
      tracks.map(async (track) => {
        if (!/^https?:/i.test(track.url || "")) {
          throw new Error("The original track URL is unavailable.");
        }
        let download = downloads.get(track.url);
        if (!download) {
          download = fetchCompleteTrack(
            track.url,
            job.controller.signal,
            track.fullSize,
          );
          downloads.set(track.url, download);
        }
        const downloaded = await download;
        if (
          /video/i.test(track.mimeType || downloaded.contentType) &&
          downloaded.blob.size < 64 * 1024
        ) {
          throw new Error(
            "The independent source contains only a video initialization segment.",
          );
        }
        return {
          mimeType: track.mimeType || downloaded.contentType,
          blob: downloaded.blob,
        };
      }),
    );
    if (!jobs.has(muxId)) return;

    const worker = new Worker(
      chrome.runtime.getURL("ffmpeg/ffmpeg-mux-worker.js"),
      { type: "module" },
    );
    job.worker = worker;
    worker.onerror = (event) => {
      jobs.delete(muxId);
      worker.terminate();
      reportResult(job, {
        ok: false,
        error: event.message || "FFmpeg worker failed.",
      });
    };
    worker.onmessage = (event) => {
      if (event.data?.muxId !== muxId) return;
      if (!event.data.ok) {
        jobs.delete(muxId);
        worker.terminate();
      } else {
        job.cleanupTimer = setTimeout(
          () => releaseJob(muxId, event.data.url),
          60 * 60 * 1000,
        );
      }
      reportResult(job, event.data);
    };
    worker.postMessage({ muxId, tracks: preparedTracks, startTime });
  } catch (error) {
    jobs.delete(muxId);
    reportResult(job, {
      ok: false,
      canceled: error?.name === "AbortError",
      error: error?.message || String(error),
    });
  }
}

async function fetchCompleteTrack(url, signal, knownFullSize) {
  // Some CDNs (notably video.twimg.com) return only a small initial MP4 range
  // even when a normal GET is made. Start with an explicit range, read the
  // complete size from Content-Range, then fetch every remaining byte range.
  const requestedChunkSize = 1024 * 1024;
  const first = await fetchTrackRange(
    url,
    0,
    requestedChunkSize - 1,
    signal,
    knownFullSize,
  );

  if (!first.isPartial) {
    return {
      blob: new Blob([first.data], {
        type: first.contentType || "application/octet-stream",
      }),
      contentType: first.contentType,
    };
  }

  if (!first.fullSize || first.start !== 0 || !first.data.byteLength) {
    throw new Error("The media server did not provide a complete track size.");
  }

  const chunkSize = first.data.byteLength;
  const chunkCount = Math.ceil(first.fullSize / chunkSize);
  const chunks = new Array(chunkCount);
  chunks[0] = first.data;
  let nextIndex = 1;
  const workerCount = Math.min(8, Math.max(0, chunkCount - 1));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= chunkCount) return;
        signal.throwIfAborted();
        const start = index * chunkSize;
        const part = await fetchTrackRange(
          url,
          start,
          Math.min(first.fullSize - 1, start + chunkSize - 1),
          signal,
          first.fullSize,
        );
        const expectedEnd = Math.min(
          first.fullSize - 1,
          start + chunkSize - 1,
        );
        if (
          !part.isPartial ||
          part.start !== start ||
          part.end !== expectedEnd ||
          part.fullSize !== first.fullSize
        ) {
          throw new Error("The media server returned an unexpected track range.");
        }
        chunks[index] = part.data;
      }
    }),
  );

  signal.throwIfAborted();
  const blob = new Blob(chunks, {
    type: first.contentType || "application/octet-stream",
  });
  if (blob.size !== first.fullSize) {
    throw new Error("The media server returned an incomplete track.");
  }
  return { blob, contentType: first.contentType };
}

async function fetchTrackRange(url, start, end, signal, knownFullSize) {
  const rangedUrl = buildExplicitRangeUrl(url, start, end);
  const hasExplicitRange = rangedUrl !== url;
  const response = await fetch(rangedUrl, {
    headers: hasExplicitRange ? undefined : { Range: `bytes=${start}-${end}` },
    credentials: "include",
    redirect: "follow",
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    throw new Error(`Track download failed (${response.status}).`);
  }

  const contentRange = response.headers.get("Content-Range") || "";
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(contentRange);
  const data = await response.arrayBuffer();
  signal.throwIfAborted();

  if (response.status === 206 && !match && !knownFullSize) {
    throw new Error("The media server hid the track range information.");
  }
  if (hasExplicitRange && !match && !knownFullSize) {
    throw new Error("The media server did not reveal the complete track size.");
  }
  if (match && data.byteLength !== Number(match[2]) - Number(match[1]) + 1) {
    throw new Error("The media server returned an incomplete track range.");
  }
  return {
    status: response.status,
    isPartial: Boolean(match) || hasExplicitRange || response.status === 206,
    start: match ? Number(match[1]) : hasExplicitRange ? start : 0,
    end: match
      ? Number(match[2])
      : hasExplicitRange
        ? start + data.byteLength - 1
        : Math.max(0, data.byteLength - 1),
    fullSize: match ? Number(match[3]) : knownFullSize || data.byteLength,
    contentType: response.headers.get("Content-Type") || "",
    data,
  };
}

function buildExplicitRangeUrl(value, start, end) {
  try {
    const url = new URL(value);
    const params = url.searchParams;
    if (params.has("bytestart") && params.has("byteend")) {
      params.set("bytestart", String(start));
      params.set("byteend", String(end));
      return url.href;
    }
    if (params.has("byte_start") && params.has("byte_end")) {
      params.set("byte_start", String(start));
      params.set("byte_end", String(end));
      return url.href;
    }
  } catch {}
  return value;
}

function cancelJob(muxId) {
  const job = jobs.get(muxId);
  if (!job) return;
  jobs.delete(muxId);
  clearTimeout(job.cleanupTimer);
  job.controller.abort();
  job.worker?.terminate();
}

function releaseJob(muxId, url) {
  const job = jobs.get(muxId);
  if (!job) return;
  jobs.delete(muxId);
  clearTimeout(job.cleanupTimer);
  job.worker?.postMessage({ action: "release", url });
}

function reportResult(job, result) {
  chrome.runtime
    .sendMessage({
      target: "background",
      action: "independentMuxResult",
      muxId: job.message.muxId,
      videoId: job.message.videoId,
      filename: job.message.filename,
      folder: job.message.folder,
      saveAs: job.message.saveAs,
      tabId: job.message.tabId,
      ...result,
    })
    .catch(() => {});
}
