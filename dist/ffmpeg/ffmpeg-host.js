const CHANNEL = "imd:ffmpeg-host";
const workers = new Map();

window.addEventListener("message", (event) => {
  if (event.source !== parent || event.data?.channel !== CHANNEL) return;
  const { action, muxId } = event.data;

  if (action === "mux" && muxId && event.data.tracks?.length) {
    startMux(muxId, event.data.tracks, event.data.startTime);
    return;
  }

  if (action === "cancel" && muxId) {
    const worker = workers.get(muxId);
    if (!worker) return;
    workers.delete(muxId);
    worker.terminate();
    return;
  }

  if (action === "release" && muxId && event.data.url) {
    const worker = workers.get(muxId);
    if (!worker) return;
    workers.delete(muxId);
    worker.postMessage({ action: "release", url: event.data.url });
  }
});

function startMux(muxId, tracks, startTime) {
  if (workers.has(muxId)) return;
  let worker;
  try {
    worker = new Worker(chrome.runtime.getURL("ffmpeg/ffmpeg-mux-worker.js"), {
      type: "module",
    });
  } catch (error) {
    sendResult(muxId, {
      ok: false,
      error: error?.message || String(error),
    });
    return;
  }

  workers.set(muxId, worker);
  worker.onerror = (event) => {
    workers.delete(muxId);
    worker.terminate();
    sendResult(muxId, {
      ok: false,
      error: event.message || "FFmpeg worker failed.",
    });
  };
  worker.onmessage = (event) => {
    if (event.data?.muxId !== muxId) return;
    if (!event.data.ok) {
      workers.delete(muxId);
      worker.terminate();
    }
    sendResult(muxId, event.data);
  };
  worker.postMessage({ muxId, tracks, startTime });
}

function sendResult(muxId, result) {
  parent.postMessage({ channel: CHANNEL, muxId, ...result }, "*");
}
