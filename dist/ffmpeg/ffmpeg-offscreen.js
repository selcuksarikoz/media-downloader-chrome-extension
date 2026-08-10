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
          download = fetch(track.url, {
            credentials: "include",
            redirect: "follow",
            cache: "no-store",
            signal: job.controller.signal,
          }).then(async (response) => {
            if (!response.ok) {
              throw new Error(`Track download failed (${response.status}).`);
            }
            return {
              blob: await response.blob(),
              contentType: response.headers.get("Content-Type") || "",
            };
          });
          downloads.set(track.url, download);
        }
        const downloaded = await download;
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
