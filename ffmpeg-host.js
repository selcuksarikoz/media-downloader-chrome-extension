const CHANNEL = "imd:ffmpeg-host";
const jobs = new Map();

window.addEventListener("message", (event) => {
  if (event.source !== parent || event.data?.channel !== CHANNEL) return;
  const { action, muxId } = event.data;

  if (action === "mux" && muxId && event.data.tracks?.length) {
    startMux(muxId, event.data.tracks, event.data.startTime);
    return;
  }

  if (action === "cancel" && muxId) {
    const job = jobs.get(muxId);
    if (!job) return;
    jobs.delete(muxId);
    job.controller.abort();
    job.worker?.terminate();
    return;
  }

  if (action === "release" && muxId && event.data.url) {
    const job = jobs.get(muxId);
    if (!job) return;
    jobs.delete(muxId);
    job.worker?.postMessage({ action: "release", url: event.data.url });
  }
});

async function startMux(muxId, tracks, startTime) {
  if (jobs.has(muxId)) return;
  const job = { controller: new AbortController(), worker: null };
  jobs.set(muxId, job);
  let worker;
  let preparedTracks;
  try {
    const remoteDownloads = new Map();
    preparedTracks = await Promise.all(
      tracks.map(async (track) => {
        if (track.blob instanceof Blob) return track;
        if (!/^https?:/i.test(track.url || "")) {
          throw new Error("The original track URL is unavailable.");
        }
        let download = remoteDownloads.get(track.url);
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
          remoteDownloads.set(track.url, download);
        }
        const downloaded = await download;
        return {
          mimeType: track.mimeType || downloaded.contentType,
          blob: downloaded.blob,
        };
      }),
    );
    if (!jobs.has(muxId)) return;

    worker = new Worker(chrome.runtime.getURL("ffmpeg/ffmpeg-mux-worker.js"), {
      type: "module",
    });
    job.worker = worker;
  } catch (error) {
    jobs.delete(muxId);
    sendResult(muxId, {
      ok: false,
      canceled: error?.name === "AbortError",
      error: error?.message || String(error),
    });
    return;
  }

  worker.onerror = (event) => {
    jobs.delete(muxId);
    worker.terminate();
    sendResult(muxId, {
      ok: false,
      error: event.message || "FFmpeg worker failed.",
    });
  };
  worker.onmessage = (event) => {
    if (event.data?.muxId !== muxId) return;
    if (!event.data.ok) {
      jobs.delete(muxId);
      worker.terminate();
    }
    sendResult(muxId, event.data);
  };
  worker.postMessage({ muxId, tracks: preparedTracks, startTime });
}

function sendResult(muxId, result) {
  parent.postMessage({ channel: CHANNEL, muxId, ...result }, "*");
}
