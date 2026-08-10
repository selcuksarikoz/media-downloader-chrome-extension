const DEFAULT_BLACKLISTED_DOMAINS = [
  "netflix.com",
  "primevideo.com",
  "disneyplus.com",
  "hbo.com",
  "hbomax.com",
  "max.com",
  "paramountplus.com",
  "hulu.com",
  "peacocktv.com",
  "discoveryplus.com",
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
];

const DEFAULT_SETTINGS = {
  buttonPosition: "top-right",
  downloadFolder: "",
  showSaveAs: false,
  showPreviewButton: true,
  showVideoControls: true,
  captureType: "jpg",
  blacklistedDomains: [...DEFAULT_BLACKLISTED_DOMAINS],
  minWidth: 150,
  useContextMenu: false,
};
const ACTIVE_DOWNLOAD_STATES = new Set(["recording", "progress"]);
let settings = { ...DEFAULT_SETTINGS };
let extensionActive = false;
let mediaMutationObserver = null;

const mediaControls = new Map();
const trackedMedia = new Map();
const capturedVideos = new Map();
const blobDownloadRequests = new Map();
const activeBlobJobIds = new Set();
const pipState = new WeakMap();
const mediaHoverListeners = new WeakMap();
const instagramNativeControlState = new WeakMap();
const videoTrimRecordings = new Map();
const blobJobIntent = new Map();
const canceledBlobJobs = new Set();
const activeMuxWorkers = new Map();
const muxOutputWorkers = new Map();
const activeIndependentMuxes = new Map();
const FFMPEG_HOST_CHANNEL = "imd:ffmpeg-host";
let ffmpegHostFrame = null;
let ffmpegHostPromise = null;
const BLOB_DOWNLOAD_EVENT = "imd:download-blob-video";
const BLOB_TRIM_EVENT = "imd:trim-blob-video";
const BLOB_CONTROL_EVENT = "imd:control-blob-video";
const BLOB_STATUS_EVENT = "imd:blob-video-status";
const BLOB_DATA_EVENT = "imd:blob-data-for-download";
const PAGE_MEDIA_DOWNLOAD_EVENT = "imd:download-page-media";
const BLOB_PERSIST_CHUNK_EVENT = "imd:persist-blob-chunk";
const BLOB_MUX_EVENT = "imd:mux-blob-tracks";
const BLOB_MUX_RESULT_EVENT = "imd:mux-blob-tracks-result";
const NAVIGATION_BLOCKED_EVENT = "imd:navigation-blocked";
const CAPTURE_BLOCK_EVENT = "imd:capture-block";
const CAPTURE_UNBLOCK_EVENT = "imd:capture-unblock";
const CAPTURE_FROM_MSE_EVENT = "imd:capture-from-mse";
const CAPTURE_FROM_MSE_RESULT_EVENT = "imd:capture-from-mse-result";
const BLOB_STORE_PORT_NAME = "imd-blob-store";
const FETCH_MEDIA_PORT_NAME = "imd-fetch-media";
let mseCaptureSeq = 0;
const mseCapturePending = new Map();

window.addEventListener(CAPTURE_FROM_MSE_RESULT_EVENT, (event) => {
  const { requestId, blob } = event.detail || {};
  const pending = mseCapturePending.get(requestId);
  if (!pending) return;
  mseCapturePending.delete(requestId);
  clearTimeout(pending.timer);
  pending.resolve(blob || null);
});

/** Ask the media bridge to rebuild a blob from the recorded MediaSource segments. */
function requestMediaSourceBlob(url, timeout = 4000) {
  return new Promise((resolve) => {
    const requestId = `mse-capture-${++mseCaptureSeq}`;
    const timer = setTimeout(() => {
      if (mseCapturePending.delete(requestId)) resolve(null);
    }, timeout);
    mseCapturePending.set(requestId, { resolve, timer });
    try {
      window.dispatchEvent(
        new CustomEvent(CAPTURE_FROM_MSE_EVENT, {
          detail: { url, requestId },
        }),
      );
    } catch {
      clearTimeout(timer);
      mseCapturePending.delete(requestId);
      resolve(null);
    }
  });
}
let blobStorePort = null;
let blobStoreSeq = 0;
const blobStorePending = new Map();

function getBlobStorePort() {
  if (blobStorePort) return blobStorePort;
  try {
    blobStorePort = chrome.runtime.connect({ name: BLOB_STORE_PORT_NAME });
  } catch {
    return null;
  }
  blobStorePort.onDisconnect.addListener(() => {
    blobStorePort = null;
  });
  blobStorePort.onMessage.addListener((msg) => {
    if (!msg?.requestId) return;
    const pending = blobStorePending.get(msg.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    blobStorePending.delete(msg.requestId);
    pending.resolve(msg.ok === true);
  });
  return blobStorePort;
}

function sendBlobStoreMessage(message) {
  return new Promise((resolve) => {
    const port = getBlobStorePort();
    if (!port) {
      resolve(false);
      return;
    }
    const requestId = `m${++blobStoreSeq}`;
    message.requestId = requestId;
    const timer = setTimeout(() => {
      blobStorePending.delete(requestId);
      resolve(false);
    }, 15000);
    blobStorePending.set(requestId, { resolve, timer });
    try {
      port.postMessage(message);
    } catch {
      clearTimeout(timer);
      blobStorePending.delete(requestId);
      resolve(false);
    }
  });
}

window.addEventListener(BLOB_PERSIST_CHUNK_EVENT, (event) => {
  const { videoId, blob } = event.detail || {};
  if (!videoId || !blob || !blob.size) return;
  sendBlobStoreMessage({ action: "chunk", jobId: videoId, blob });
});

window.addEventListener(BLOB_MUX_EVENT, async (event) => {
  const { requestId, videoId, filename, tracks, startTime } = event.detail || {};
  if (!requestId || !videoId || !tracks?.length) return;
  let response = { ok: false };
  try {
    if (canceledBlobJobs.has(videoId)) throw abortError();
    if (tracks.every((track) => track.url && !track.blob)) {
      await muxTracksIndependently(
        videoId,
        filename,
        tracks,
        startTime,
      );
      response = { ok: true };
      window.dispatchEvent(
        new CustomEvent(BLOB_MUX_RESULT_EVENT, {
          detail: { requestId, ...response },
        }),
      );
      return;
    }
    const result = await muxTracksLocally(videoId, tracks, startTime);
    if (canceledBlobJobs.has(videoId)) throw abortError();
    const outputName = replaceFileExtension(filename, result.extension);
    try {
      await downloadMuxUrl(result.url, outputName);
    } catch (error) {
      releaseMuxUrl(result.url);
      throw error;
    }
    response = { ok: true };
  } catch (error) {
    response = {
      ok: false,
      canceled: error?.name === "AbortError",
      error: error?.message || String(error),
    };
  }
  window.dispatchEvent(
    new CustomEvent(BLOB_MUX_RESULT_EVENT, {
      detail: { requestId, ...response },
    }),
  );
});

function muxTracksIndependently(videoId, filename, tracks, startTime) {
  const muxId = `${videoId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const entry = { muxId, resolve, reject };
    activeIndependentMuxes.set(videoId, entry);
    chrome.runtime.sendMessage(
      {
        action: "startIndependentMux",
        muxId,
        videoId,
        filename,
        folder: settings.downloadFolder,
        saveAs: settings.showSaveAs,
        tracks: tracks.map((track) => ({
          mimeType: track.mimeType,
          url: track.url,
          fullSize: track.fullSize,
        })),
        startTime,
      },
      (response) => {
        if (chrome.runtime.lastError || !response?.ok) {
          if (activeIndependentMuxes.get(videoId) === entry) {
            activeIndependentMuxes.delete(videoId);
          }
          reject(
            new Error(
              chrome.runtime.lastError?.message ||
                response?.error ||
                "Independent download could not be started.",
            ),
          );
        }
      },
    );
  });
}

async function getFfmpegHostFrame() {
  if (ffmpegHostFrame?.isConnected) return ffmpegHostFrame;
  if (ffmpegHostPromise) return ffmpegHostPromise;

  ffmpegHostPromise = new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.src = chrome.runtime.getURL("ffmpeg/ffmpeg-host.html");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText =
      "position:fixed;width:1px;height:1px;left:-10000px;top:-10000px;" +
      "border:0;opacity:0;pointer-events:none";
    frame.onload = () => {
      ffmpegHostFrame = frame;
      ffmpegHostPromise = null;
      resolve(frame);
    };
    frame.onerror = () => {
      frame.remove();
      ffmpegHostPromise = null;
      reject(new Error("The extension FFmpeg host could not be loaded."));
    };
    (document.documentElement || document.body).appendChild(frame);
  });
  return ffmpegHostPromise;
}

async function muxTracksLocally(videoId, tracks, startTime) {
  const muxId = `${videoId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const frame = await getFfmpegHostFrame();
  return new Promise((resolve, reject) => {
    const entry = {
      frame,
      muxId,
      reject,
      cleanup: () => window.removeEventListener("message", onMessage),
    };
    activeMuxWorkers.set(videoId, entry);
    const fail = (error) => {
      if (activeMuxWorkers.get(videoId) === entry) {
        activeMuxWorkers.delete(videoId);
      }
      window.removeEventListener("message", onMessage);
      reject(error);
    };
    const onMessage = (event) => {
      if (
        event.source !== frame.contentWindow ||
        event.data?.channel !== FFMPEG_HOST_CHANNEL ||
        event.data?.muxId !== muxId
      ) {
        return;
      }
      window.removeEventListener("message", onMessage);
      if (activeMuxWorkers.get(videoId) === entry) {
        activeMuxWorkers.delete(videoId);
      }
      if (!event.data.ok) {
        fail(new Error(event.data.error || "FFmpeg mux failed."));
        return;
      }
      muxOutputWorkers.set(event.data.url, { frame, muxId });
      resolve(event.data);
    };
    window.addEventListener("message", onMessage);
    // Blob objects are structured-cloned without first duplicating the entire
    // video into ArrayBuffers on the page's main thread. The worker mounts
    // them read-only, which avoids another full-sized input copy in WASM.
    const payload = tracks.map((track) => ({
      mimeType: track.mimeType,
      blob: track.blob,
      url: track.url,
    }));
    frame.contentWindow.postMessage(
      {
        channel: FFMPEG_HOST_CHANNEL,
        action: "mux",
        muxId,
        tracks: payload,
        startTime,
      },
      "*",
    );
  });
}

function cancelLocalMux(videoId) {
  const independent = activeIndependentMuxes.get(videoId);
  if (independent) {
    activeIndependentMuxes.delete(videoId);
    chrome.runtime.sendMessage({
      action: "cancelIndependentMux",
      muxId: independent.muxId,
    });
    independent.reject(abortError());
  }
  const entry = activeMuxWorkers.get(videoId);
  if (!entry) return;
  activeMuxWorkers.delete(videoId);
  entry.cleanup();
  entry.frame.contentWindow?.postMessage(
    {
      channel: FFMPEG_HOST_CHANNEL,
      action: "cancel",
      muxId: entry.muxId,
    },
    "*",
  );
  entry.reject(abortError());
}

function releaseMuxUrl(url) {
  const entry = muxOutputWorkers.get(url);
  if (!entry) return;
  muxOutputWorkers.delete(url);
  entry.frame.contentWindow?.postMessage(
    {
      channel: FFMPEG_HOST_CHANNEL,
      action: "release",
      muxId: entry.muxId,
      url,
    },
    "*",
  );
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.action === "independentMuxResult" && message.muxId) {
    const entry = [...activeIndependentMuxes.values()].find(
      (candidate) => candidate.muxId === message.muxId,
    );
    if (!entry) return;
    for (const [videoId, candidate] of activeIndependentMuxes) {
      if (candidate === entry) activeIndependentMuxes.delete(videoId);
    }
    if (message.ok) entry.resolve(message);
    else {
      const error = new Error(message.error || "Independent mux failed.");
      if (message.canceled) error.name = "AbortError";
      entry.reject(error);
    }
    return;
  }
  if (message?.action === "releaseMuxUrl" && message.url) {
    releaseMuxUrl(message.url);
  }
});

function abortError() {
  return new DOMException("Mux canceled.", "AbortError");
}

function replaceFileExtension(filename, extension) {
  const base = (filename || `video-${Date.now()}`).replace(/\.[^.]+$/, "");
  return `${base}.${extension}`;
}

function downloadMuxUrl(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        action: "downloadMuxUrl",
        url,
        filename,
        folder: settings.downloadFolder,
        saveAs: settings.showSaveAs,
      },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response?.ok) {
          reject(new Error(response?.error || "Muxed video download failed."));
          return;
        }
        resolve();
      },
    );
  });
}
let lightboxOpen = false;
const visibleMedia = new WeakSet();
const mediaIntersectionObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      const media = entry.target;
      if (entry.isIntersecting && entry.intersectionRatio > 0) {
        visibleMedia.add(media);
        processMedia(media);
        return;
      }

      visibleMedia.delete(media);
      const group = mediaControls.get(media);
      if (group) hideActionGroup(group);
    });
  },
  { root: null, threshold: [0, 0.01] },
);
const mediaResizeObserver = new ResizeObserver((entries) => {
  entries.forEach(({ target }) => {
    if (!target.dataset.imdProcessed) {
      processMedia(target);
      return;
    }
    const group = mediaControls.get(target);
    if (visibleMedia.has(target) && group?.classList.contains("imd-show")) {
      positionActionGroup(group, target);
    }
  });
});

window.addEventListener(BLOB_STATUS_EVENT, (event) => {
  const { videoId, status, message, progress } = event.detail || {};
  if (videoId) {
    if (ACTIVE_DOWNLOAD_STATES.has(status)) activeBlobJobIds.add(videoId);
    else activeBlobJobIds.delete(videoId);
  }
  const video = capturedVideos.get(videoId);
  const allBtns = video
    ? mediaControls.get(video)?.querySelectorAll(".imd-action-btn")
    : [];
  const downBtns = video
    ? mediaControls.get(video)?.querySelectorAll(".imd-down-btn")
    : [];
  const trimBtns = video
    ? mediaControls.get(video)?.querySelectorAll(".imd-trim-btn")
    : [];

  if (downBtns?.length) {
    const isActive = ACTIVE_DOWNLOAD_STATES.has(status);
    downBtns.forEach((button) => {
      button.title = isActive ? "Video download in progress" : "Download Video";
      button.setAttribute("aria-label", button.title);
      button.classList.toggle("imd-recording", isActive);
      button.disabled = isActive;
    });
  }

  if (trimBtns?.length) {
    const isActive = status === "recording" || status === "progress";
    const elapsed =
      status === "progress" && message
        ? message.replace("Recording ", "").replace("…", "")
        : "";
    trimBtns.forEach((button) => {
      if (
        status === "complete" ||
        status === "error" ||
        status === "canceled"
      ) {
        button.title = "Trim from current time";
        button.innerHTML = TRIM_ICON;
        button.dataset.recording = "false";
      } else if (isActive) {
        button.title = elapsed ? `Save (${elapsed})` : "Save trim";
        button.innerHTML = STOP_ICON;
      }
    });
  }

  updateBlobDownloadPanel(videoId, status, message, progress);

  if (status === "complete") {
    showToast(
      blobJobIntent.get(videoId) === "trim"
        ? "Trim saved."
        : "Download complete.",
    );
  } else if (status === "error") {
    console.error(message);
    sendBlobStoreMessage({ action: "cancel", jobId: videoId });
    showToast(message || "Download failed.");
  } else if (status === "canceled") {
    console.error(message);
    canceledBlobJobs.add(videoId);
    cancelLocalMux(videoId);
    sendBlobStoreMessage({ action: "cancel", jobId: videoId });
    showToast("Download canceled.");
  }

  if (
    status === "complete" ||
    status === "error" ||
    status === "canceled"
  ) {
    blobJobIntent.delete(videoId);
  }
});

window.addEventListener(BLOB_DATA_EVENT, async (event) => {
  const { blob, filename, videoId } = event.detail || {};
  if (!blob || !blob.size) return;
  // A final recorder event can race with the cancel control event. Never let
  // a canceled job reach either the background download or the direct
  // fallback, even if its blob was already being prepared.
  if (canceledBlobJobs.has(videoId)) return;

  const sent = await sendBlobStoreMessage({
    action: "finalize",
    jobId: videoId,
    blob,
    filename,
    folder: settings.downloadFolder,
    saveAs: settings.showSaveAs,
  });
  if (!sent && !canceledBlobJobs.has(videoId)) {
    downloadBlobFile(blob, filename, settings.downloadFolder, settings.showSaveAs);
  }
});

let toastEl = null;
let toastTimer = null;

/** Show a short transient error message near the bottom of the viewport. */
function showToast(message) {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.className = "imd-toast";
    toastEl.setAttribute("role", "alert");
    document.documentElement.appendChild(toastEl);
  }
  toastEl.textContent = message;
  toastEl.classList.add("imd-toast-show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove("imd-toast-show");
  }, 4000);
}

/** Directly start a blob file download (fallback when persistence fails). */
function downloadBlobFile(blob, filename, folder, saveAs) {
  const blobUrl = URL.createObjectURL(blob);

  let downloadFilename = filename;
  let useSaveAs = saveAs;
  if (folder) {
    const cleanFolder = folder.trim().replace(/^[\/\\]+|[\/\\]+$/g, "");
    if (cleanFolder && !hasForbiddenFolder(cleanFolder)) {
      downloadFilename = `${cleanFolder}/${filename}`;
      useSaveAs = false;
    }
  }

  if (typeof chrome !== "undefined" && chrome.downloads) {
    chrome.downloads.download(
      {
        url: blobUrl,
        filename: downloadFilename,
        saveAs: useSaveAs,
        conflictAction: "overwrite",
      },
      () => {
        if (chrome.runtime.lastError) {
          console.error(
            "Blob download failed:",
            chrome.runtime.lastError.message,
          );
          showToast(`Blob download failed: ${chrome.runtime.lastError.message}`);
        }
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
      },
    );
  } else {
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = downloadFilename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  }
}

let blobDownloadStack;
const blobDownloadPanels = new Map();
const DOWNLOAD_NAVIGATION_WARNING =
  "You cannot leave or reload this page while a download is in progress. " +
  "Wait for it to finish or cancel the download.";

function hasActivePageDownload() {
  return (
    blobDownloadRequests.size > 0 ||
    activeBlobJobIds.size > 0 ||
    activeIndependentMuxes.size > 0 ||
    activeMuxWorkers.size > 0
  );
}

function warnDownloadNavigationBlocked() {
  showToast(DOWNLOAD_NAVIGATION_WARNING);
}

window.addEventListener("beforeunload", (event) => {
  if (!hasActivePageDownload()) return;
  event.preventDefault();
  event.returnValue = "";
});

window.addEventListener(NAVIGATION_BLOCKED_EVENT, warnDownloadNavigationBlocked);

document.addEventListener(
  "click",
  (event) => {
    if (!hasActivePageDownload()) return;
    const anchor = event.target.closest?.("a[href]");
    if (!anchor || anchor.hasAttribute("download")) return;
    if (anchor.target && anchor.target.toLowerCase() === "_blank") return;
    let destination;
    try {
      destination = new URL(anchor.href, location.href);
    } catch {
      return;
    }
    if (destination.href === location.href) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    warnDownloadNavigationBlocked();
  },
  true,
);

document.addEventListener(
  "submit",
  (event) => {
    if (!hasActivePageDownload()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    warnDownloadNavigationBlocked();
  },
  true,
);

document.addEventListener(
  "keydown",
  (event) => {
    if (!hasActivePageDownload()) return;
    const reloadShortcut =
      event.key === "F5" ||
      ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r");
    if (!reloadShortcut) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    warnDownloadNavigationBlocked();
  },
  true,
);

/** Update or create the download panel for a blob video. */
function updateBlobDownloadPanel(videoId, status, message, progress) {
  if (!blobDownloadStack) blobDownloadStack = createBlobDownloadStack();
  if (!blobDownloadStack.isConnected) {
    document.body.appendChild(blobDownloadStack);
  }
  let panel = blobDownloadPanels.get(videoId);
  if (!panel) {
    panel = createBlobDownloadPanel(videoId);
    blobDownloadPanels.set(videoId, panel);
    blobDownloadStack.appendChild(panel);
  }
  const isActive = ACTIVE_DOWNLOAD_STATES.has(status);
  const canSave = status === "recording" || status === "progress";
  const percent = Number.isFinite(progress)
    ? Math.max(0, Math.min(100, Math.round(progress)))
    : null;

  panel.querySelector(".imd-download-message").textContent =
    message || "Preparing video download…";
  const fill = panel.querySelector(".imd-download-progress-fill");
  fill.style.width = `${percent ?? (isActive ? 15 : 100)}%`;
  fill.classList.toggle("imd-indeterminate", percent === null && isActive);
  panel.querySelector(".imd-download-percent").textContent =
    percent === null ? "" : `${percent}%`;
  panel.querySelector(".imd-save-download").hidden = !canSave;
  panel.querySelector(".imd-cancel-download").hidden = !isActive;

  if (typeof blobDownloadStack.showPopover === "function") {
    if (!blobDownloadStack.matches(":popover-open")) {
      blobDownloadStack.showPopover();
    }
  }

  if (!isActive) {
    blobDownloadRequests.delete(videoId);
    setTimeout(
      () => {
        const currentPanel = blobDownloadPanels.get(videoId);
        if (currentPanel === panel) {
          currentPanel.remove();
          blobDownloadPanels.delete(videoId);
        }
        if (
          blobDownloadPanels.size === 0 &&
          blobDownloadStack.matches(":popover-open")
        ) {
          blobDownloadStack.hidePopover();
        }
      },
      status === "error" ? 6000 : 2500,
    );
  }
}

/** Create the popover container for blob download panels. */
function createBlobDownloadStack() {
  const stack = document.createElement("div");
  stack.className = "imd-download-stack";
  stack.popover = "manual";
  return stack;
}

/** Create a download panel section for a blob video. */
function createBlobDownloadPanel(videoId) {
  const panel = document.createElement("section");
  panel.className = "imd-download-panel";
  panel.dataset.videoId = videoId;
  panel.innerHTML = `
    <div class="imd-download-title">Video download</div>
    <div class="imd-download-message"></div>
    <div class="imd-download-progress">
      <div class="imd-download-progress-fill"></div>
    </div>
    <div class="imd-download-footer">
      <span class="imd-download-percent"></span>
      <span>Keep this tab open</span>
      <div class="imd-download-actions">
        <button type="button" class="imd-save-download">Save Now</button>
        <button type="button" class="imd-cancel-download">Cancel</button>
      </div>
    </div>`;
  panel.querySelector(".imd-save-download").addEventListener("click", () => {
    dispatchBlobControl(videoId, "save");
  });
  panel.querySelector(".imd-cancel-download").addEventListener("click", () => {
    dispatchBlobControl(videoId, "cancel");
  });
  return panel;
}

/** Dispatch a control event (save/cancel) for a blob video download. */
function dispatchBlobControl(videoId, action) {
  window.dispatchEvent(
    new CustomEvent(BLOB_CONTROL_EVENT, {
      detail: { videoId, action },
    }),
  );
}

const DOWNLOAD_ICON = `
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
</svg>
`;

const PREVIEW_ICON = `
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5c-1.7-4.4-6-7.5-11-7.5zm0 12.5a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-2.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"/>
</svg>
`;

const CAPTURE_ICON = `
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M17 7h-1.2l-1.1-2H9.3L8.2 7H7a3 3 0 0 0-3 3v6a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-6a3 3 0 0 0-3-3zm-5 9a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/>
</svg>
`;

const PIP_ICON = `
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M19 7h-8v6h8V7zm2-4H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H3V5h18v14z"/>
</svg>
`;

const LIGHTBOX_ICON = `
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M13 2L4 14h6l-2 8 9-12h-6l2-8z"/>
</svg>
`;

const CROP_ICON = `
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M17 15h2V7c0-1.1-.9-2-2-2H9v2h8v8zM7 17V1H5v4H1v2h4v10c0 1.1.9 2 2 2h10v4h2v-4h4v-2H7z"/>
</svg>
`;

const MIN_CROP_SIZE_PX = 24;

const TRIM_ICON = `
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M9.64 7.64c.23-.5.36-1.05.36-1.64 0-2.21-1.79-4-4-4S2 3.79 2 6s1.79 4 4 4c.59 0 1.14-.13 1.64-.36L10 12l-2.36 2.36C7.14 14.13 6.59 14 6 14c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4c0-.59-.13-1.14-.36-1.64L12 14l7 7h3v-1L9.64 7.64zM6 8c-1.1 0-2-.89-2-2s.9-2 2-2 2 .89 2 2-.9 2-2 2zm0 12c-1.1 0-2-.89-2-2s.9-2 2-2 2 .89 2 2-.9 2-2 2zm6-7.5c-.28 0-.5-.22-.5-.5s.22-.5.5-.5.5.22.5.5-.22.5-.5.5zM19 3l-6 6 2 2 7-7V3z"/>
</svg>
`;

const SAVE_ICON = `
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"/>
</svg>
`;

const STOP_ICON = `
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M6 6h12v12H6z"/>
</svg>
`;

const OPEN_LINK_ICON = `
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/>
</svg>
`;

const COPY_ICON = `
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
</svg>
`;

/** Initialize extension: load settings, apply domain access, listen for changes. */
function init() {
  chrome.storage.sync.get(DEFAULT_SETTINGS, (items) => {
    settings = items;
    if (hasForbiddenFolder(settings.downloadFolder)) {
      settings.downloadFolder = "";
      chrome.storage.sync.set({ downloadFolder: "" });
    }
    applyDomainAccess();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    Object.entries(changes).forEach(([key, change]) => {
      settings[key] = change.newValue;
    });
    if (changes.buttonPosition) updateAllButtonPositions();
    if (changes.showPreviewButton) updatePreviewButtonVisibility();
    if (changes.showVideoControls) updateVideoControls();
    if (changes.blacklistedDomains) applyDomainAccess();
    if (changes.useContextMenu) rebuildAllMedia();
  });
}

/** Remove and re-create all media controls/tracking (e.g. after mode switch). */
function rebuildAllMedia() {
  document.querySelectorAll("img, video").forEach((media) => {
    if (mediaControls.has(media) || trackedMedia.has(media)) {
      cleanupMedia(media);
    }
  });
  processAllMedia();
}

/** Check if the current domain is in the blacklist. */
function isCurrentDomainBlacklisted() {
  const hostname = location.hostname.toLowerCase().replace(/\.$/, "");
  const domains = Array.isArray(settings.blacklistedDomains)
    ? settings.blacklistedDomains
    : [];
  return domains.some((domain) => {
    if (typeof domain !== "string") return false;
    const normalized = domain
      .toLowerCase()
      .replace(/^\*\./, "")
      .replace(/^www\./, "")
      .replace(/\.$/, "");
    return (
      normalized &&
      (hostname === normalized || hostname.endsWith(`.${normalized}`))
    );
  });
}

/** Enable or disable the extension based on domain blacklist. */
function applyDomainAccess() {
  const shouldBeActive = !isCurrentDomainBlacklisted();
  if (shouldBeActive === extensionActive) return;
  extensionActive = shouldBeActive;
  if (extensionActive) {
    processAllMedia();
    startObserver();
    return;
  }

  mediaMutationObserver?.disconnect();
  mediaMutationObserver = null;
  document.querySelectorAll("img, video").forEach((media) => {
    cleanupMedia(media);
  });
}

/** Check if the download folder path contains a forbidden segment. */
function hasForbiddenFolder(folder) {
  return folder
    .split(/[\/\\]+/)
    .some((part) => part.toLowerCase() === "imgdownloader_files");
}

/** Process all existing img/video elements on the page. */
function processAllMedia() {
  document.querySelectorAll("img, video").forEach(trackMedia);
}

/** Track a media element with observers and process it. */
function trackMedia(media) {
  if (!extensionActive) return;
  if (media.closest(".imd-lightbox-overlay")) return;
  media.dataset.imdMediaType = media.tagName === "VIDEO" ? "video" : "image";
  if (media.tagName === "VIDEO") {
    media.controls = settings.showVideoControls;
    applyStoryVideoFix(media);
    syncInstagramNativeVideoControls(media);
  }
  mediaResizeObserver.observe(media);
  mediaIntersectionObserver.observe(media);
  processMedia(media);
}

/** Apply the showVideoControls setting to all video elements. */
function updateVideoControls() {
  document.querySelectorAll("video").forEach((video) => {
    video.controls = settings.showVideoControls;
    applyStoryVideoFix(video);
    syncInstagramNativeVideoControls(video);
  });
}

/** Start the mutation observer to track dynamically added/removed media. */
function startObserver() {
  if (mediaMutationObserver) return;
  mediaMutationObserver = new MutationObserver((mutations) => {
    const removedMedia = new Set();
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === 1) {
          if (node.matches("img, video")) {
            trackMedia(node);
          } else {
            node.querySelectorAll("img, video").forEach(trackMedia);
          }
        }
      });
      mutation.removedNodes.forEach((node) => {
        if (node.nodeType !== 1) return;
        if (node.matches("img, video")) removedMedia.add(node);
        node
          .querySelectorAll("img, video")
          .forEach((media) => removedMedia.add(media));
      });
    });
    queueMicrotask(() => {
      removedMedia.forEach((media) => {
        if (!media.isConnected) cleanupMedia(media);
      });
    });
    schedulePointerReconciliation();
  });

  mediaMutationObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

/** Remove all extension traces (controls, listeners, observers) from a media element. */
function cleanupMedia(media) {
  const group = mediaControls.get(media);
  if (group) detachActionGroup(group);
  if (media.dataset.imdCaptureId) {
    capturedVideos.delete(media.dataset.imdCaptureId);
  }
  const pipListeners = pipState.get(media);
  if (pipListeners) {
    media.removeEventListener("enterpictureinpicture", pipListeners.onEnterPip);
    media.removeEventListener("leavepictureinpicture", pipListeners.onLeavePip);
    pipState.delete(media);
  }
  const hoverData = mediaHoverListeners.get(media);
  if (hoverData) {
    if (hoverData.hideTimer.id) clearTimeout(hoverData.hideTimer.id);
    hoverData.hoverEntries.forEach(({ target, mouseenter, mouseleave }) => {
      target.removeEventListener("mouseenter", mouseenter);
      target.removeEventListener("mouseleave", mouseleave);
    });
    mediaHoverListeners.delete(media);
  }
  removeInstagramNativeVideoControls(media);
  mediaControls.delete(media);
  trackedMedia.delete(media);
  removeStoryVideoFix(media);
  visibleMedia.delete(media);
  mediaIntersectionObserver.unobserve(media);
  mediaResizeObserver.unobserve(media);
  delete media.dataset.imdProcessed;
  delete media.dataset.imdWaiting;
  delete media.dataset.imdMediaType;
}

/** Reposition all visible action groups (e.g. on setting change). */
function updateAllButtonPositions() {
  mediaControls.forEach((group, media) => {
    positionActionGroup(group, media);
  });
}

/** Show/hide preview buttons based on settings and blob status. */
function updatePreviewButtonVisibility() {
  mediaControls.forEach((group, media) => {
    const button = group.querySelector(".imd-preview-btn");
    const isBlobVideo =
      media.tagName === "VIDEO" && getVideoUrl(media).startsWith("blob:");
    button.hidden = !settings.showPreviewButton || isBlobVideo;
  });
  repositionOpenControls();
}

/** Check if a media element meets minimum size and hasn't been processed yet. */
function isValidMedia(media) {
  const width = media.clientWidth || media.width;
  const height = media.clientHeight || media.height;
  if (width < settings.minWidth || height < settings.minWidth) return false;
  if (media.dataset.imdProcessed) return false;
  return true;
}

/** Attach action controls (download, preview, capture, PiP) to a media element. */
function processMedia(media) {
  if (!extensionActive || !media.isConnected) return;
  const isImage = media.tagName === "IMG";
  const isLoaded = isImage ? media.complete : true;
  if (!isLoaded) {
    if (!media.dataset.imdWaiting) {
      media.dataset.imdWaiting = "true";
      media.addEventListener("load", () => processMedia(media), { once: true });
    }
    return;
  }

  if (!isValidMedia(media)) {
    if (media.tagName === "VIDEO" && !media.dataset.imdWaiting) {
      media.dataset.imdWaiting = "true";
      media.addEventListener("loadedmetadata", () => processMedia(media), {
        once: true,
      });
    }
    return;
  }

  delete media.dataset.imdWaiting;
  media.dataset.imdProcessed = "true";
  if (!isImage && !media.dataset.imdCaptureId) {
    media.dataset.imdCaptureId = crypto.randomUUID();
  }
  if (!isImage) capturedVideos.set(media.dataset.imdCaptureId, media);
  if (!isImage) syncInstagramNativeVideoControls(media);

  trackedMedia.set(media, isImage ? "image" : "video");

  if (settings.useContextMenu) {
    // When the context menu is enabled, no hover action buttons are shown.
    // The tracked media is still registered so the context menu can act on it.
    return;
  }

  const actionGroup = document.createElement("div");
  actionGroup.className = "imd-action-group";
  if (isInstagramVideoPlayerMedia(media)) {
    actionGroup.classList.add("imd-video-portal");
    actionGroup.popover = "manual";
  }
  isolateActionGroupEvents(actionGroup);
  const btns = buildMediaActionButtons(media);
  const { downloadBtn, previewBtn, captureBtn, lightboxBtn, pipBtn, trimBtn } =
    btns;
  attachMediaActionHandlers(media, btns);
  actionGroup.append(...btns.buttons);

  const showButtons = () => {
    if (
      lastPointerPosition &&
      findTopMediaAtPoint(lastPointerPosition.x, lastPointerPosition.y) ===
        media
    ) {
      showActionGroup(actionGroup, media);
    }
  };
  const hideButtons = () => hideActionGroup(actionGroup);

  const hoverTargets = getMediaHoverTargets(media);
  const hideTimer = { id: null };
  const scheduleHide = () => {
    if (hideTimer.id) clearTimeout(hideTimer.id);
    hideTimer.id = setTimeout(() => {
      hideTimer.id = null;
      const stillHoveringMedia = hoverTargets.some((target) =>
        target.matches(":hover"),
      );
      if (!stillHoveringMedia && !actionGroup.matches(":hover")) {
        hideButtons();
      }
    }, 100);
  };

  const hoverEntries = hoverTargets.map((target) => ({
    target,
    mouseenter: showButtons,
    mouseleave: scheduleHide,
  }));
  hoverEntries.forEach(({ target, mouseenter, mouseleave }) => {
    target.addEventListener("mouseenter", mouseenter);
    target.addEventListener("mouseleave", mouseleave);
  });

  mediaHoverListeners.set(media, { hoverEntries, hideTimer });

  actionGroup.addEventListener("mouseenter", showButtons);
  actionGroup.addEventListener("mouseleave", scheduleHide);

  if (pipBtn) {
    const onEnterPip = () => {
      pipBtn.hidden = true;
    };
    const onLeavePip = () => {
      pipBtn.hidden = false;
    };
    media.addEventListener("enterpictureinpicture", onEnterPip);
    media.addEventListener("leavepictureinpicture", onLeavePip);
    pipState.set(media, { onEnterPip, onLeavePip });
    if (document.pictureInPictureElement === media) {
      pipBtn.hidden = true;
    }
  }

  attachActionGroup(actionGroup);
  mediaControls.set(media, actionGroup);
}

/** Check if media belongs to an Instagram video player context. */
function isInstagramVideoPlayerMedia(media) {
  return Boolean(
    getAssociatedVideoPlayer(media) || getInstagramReelLink(media),
  );
}

/** Get the closest Instagram reel link ancestor. */
function getInstagramReelLink(media) {
  if (!/(^|\.)instagram\.com$/.test(location.hostname)) return null;
  return media.closest('a[href*="/reel/"], a[href*="/reels/"]');
}

/** Find the associated Instagram video player element near the media. */
function getAssociatedVideoPlayer(media) {
  const selector = '[role="group"][aria-label="Video player"]';
  const directPlayer = media.closest(selector);
  if (directPlayer) return directPlayer;

  const reelLink =
    getInstagramReelLink(media) || media.closest('a[href*="/p/"]');
  const linkedPlayer = reelLink?.querySelector(selector);
  if (linkedPlayer) return linkedPlayer;

  const mediaRect = media.getBoundingClientRect();
  let ancestor = media.parentElement;
  for (let depth = 0; ancestor && depth < 8; depth += 1) {
    const player = ancestor.querySelector(selector);
    if (player) {
      const rect = player.getBoundingClientRect();
      const overlaps =
        rect.left < mediaRect.right &&
        rect.right > mediaRect.left &&
        rect.top < mediaRect.bottom &&
        rect.bottom > mediaRect.top;
      if (overlaps) return player;
    }
    ancestor = ancestor.parentElement;
  }
  return null;
}

/** Get the bounding rect to position the action group, considering Instagram overlays. */
function getActionRect(media) {
  const player = getAssociatedVideoPlayer(media);
  if (player) {
    const rect = player.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return rect;
  }

  const reelLink = getInstagramReelLink(media);
  if (reelLink) {
    const rect = reelLink.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return rect;
  }

  return media.getBoundingClientRect();
}

/** Check if a video is inside an Instagram Story viewer. */
function isInstagramStoryContext(video) {
  if (!/(^|\.)instagram\.com$/.test(location.hostname)) return false;
  return /\/stories\//.test(location.pathname);
}

/** Get the height of the Instagram Story reply bar overlapping the video bottom. */
function getStoryReplyBarHeight(video) {
  const videoRect = video.getBoundingClientRect();
  if (videoRect.height < window.innerHeight * 0.5) return 0;

  const dialog = video.closest('[role="dialog"]');
  if (!dialog) return 0;

  const viewportBottom = window.innerHeight;
  let maxOverlap = 0;

  const candidates = dialog.querySelectorAll(
    'form, [role="group"], [data-testid]',
  );
  for (const el of candidates) {
    const rect = el.getBoundingClientRect();
    if (rect.height < 10) continue;
    if (rect.top < viewportBottom * 0.6) continue;
    const input = el.querySelector(
      'input, textarea, [contenteditable="true"], [placeholder]',
    );
    if (!input) continue;
    const overlap = videoRect.bottom - rect.top;
    if (overlap > maxOverlap) maxOverlap = overlap;
  }

  if (maxOverlap > 0) return maxOverlap;

  const centerX = videoRect.left + videoRect.width / 2;
  const bottomY = viewportBottom - 5;
  const elements = document.elementsFromPoint(centerX, bottomY);

  for (const el of elements) {
    if (
      el === video ||
      video.contains(el) ||
      el.tagName === "HTML" ||
      el.tagName === "BODY"
    )
      continue;
    const hasInput = el.querySelector(
      'input, textarea, [contenteditable="true"], [placeholder]',
    );
    if (hasInput) {
      const rect = el.getBoundingClientRect();
      if (rect.height > 10) {
        const overlap = videoRect.bottom - rect.top;
        if (overlap > 0) return overlap;
      }
    }
  }

  return 0;
}

/** Apply or remove the story push-up fix so native controls are above the reply bar. */
function applyStoryVideoFix(video) {
  if (video.tagName !== "VIDEO") return;
  if (settings.showVideoControls && isInstagramStoryContext(video)) {
    const replyBarHeight = getStoryReplyBarHeight(video) || 60;
    const existing = video.style.transform || "";
    const cleaned = existing.replace(/translateY\([^)]*\)/g, "").trim();
    const translateY = `translateY(-${replyBarHeight}px)`;
    video.style.transform = cleaned ? `${cleaned} ${translateY}` : translateY;
    video.style.zIndex = "9999";
    video.dataset.imdStoryFix = "true";
    return;
  }
  removeStoryVideoFix(video);
}

/** Attach a hover lift for Instagram videos so native controls receive pointer events. */
function syncInstagramNativeVideoControls(video) {
  if (video.tagName !== "VIDEO") return;
  if (
    !settings.showVideoControls ||
    !isInstagramVideoPlayerMedia(video) ||
    isInstagramStoryContext(video)
  ) {
    removeInstagramNativeVideoControls(video);
    return;
  }
  if (instagramNativeControlState.has(video)) return;

  const state = {
    active: false,
    original: null,
    hideTimer: { id: null },
    hoverEntries: [],
    showControls: null,
    scheduleRestore: null,
  };

  state.showControls = () => {
    if (!settings.showVideoControls || !video.isConnected) return;
    if (state.hideTimer.id) clearTimeout(state.hideTimer.id);
    state.hideTimer.id = null;
    liftInstagramVideoForNativeControls(video, state);
  };

  state.scheduleRestore = () => {
    if (state.hideTimer.id) clearTimeout(state.hideTimer.id);
    state.hideTimer.id = setTimeout(() => {
      state.hideTimer.id = null;
      const stillHovering = state.hoverEntries.some(({ target }) =>
        target.matches(":hover"),
      );
      if (!stillHovering && !video.matches(":hover")) {
        restoreInstagramVideoAfterNativeControls(video, state);
      }
    }, 250);
  };

  state.hoverEntries = getInstagramNativeControlHoverTargets(video).map(
    (target) => ({
      target,
      mouseenter: state.showControls,
      mouseleave: state.scheduleRestore,
    }),
  );
  state.hoverEntries.forEach(({ target, mouseenter, mouseleave }) => {
    target.addEventListener("mouseenter", mouseenter);
    target.addEventListener("mouseleave", mouseleave);
  });
  video.addEventListener("mouseenter", state.showControls);
  video.addEventListener("mouseleave", state.scheduleRestore);
  instagramNativeControlState.set(video, state);
}

/** Remove Instagram native-controls hover handling and restore inline styles. */
function removeInstagramNativeVideoControls(video) {
  const state = instagramNativeControlState.get(video);
  if (!state) return;
  if (state.hideTimer.id) clearTimeout(state.hideTimer.id);
  state.hoverEntries.forEach(({ target, mouseenter, mouseleave }) => {
    target.removeEventListener("mouseenter", mouseenter);
    target.removeEventListener("mouseleave", mouseleave);
  });
  video.removeEventListener("mouseenter", state.showControls);
  video.removeEventListener("mouseleave", state.scheduleRestore);
  restoreInstagramVideoAfterNativeControls(video, state);
  instagramNativeControlState.delete(video);
}

/** Collect Instagram player surfaces that represent hovering the video. */
function getInstagramNativeControlHoverTargets(video) {
  const targets = [
    getAssociatedVideoPlayer(video),
    getInstagramReelLink(video),
    ...getMediaHoverTargets(video),
  ].filter(Boolean);
  return [...new Set(targets)];
}

/** Temporarily raise the video above Instagram overlays so browser controls can appear. */
function liftInstagramVideoForNativeControls(video, state) {
  if (state.active) return;
  state.original = {
    position: video.style.position,
    zIndex: video.style.zIndex,
    pointerEvents: video.style.pointerEvents,
    isolation: video.style.isolation,
  };
  if (getComputedStyle(video).position === "static") {
    video.style.position = "relative";
  }
  video.style.zIndex = "2147483646";
  video.style.pointerEvents = "auto";
  video.style.isolation = "isolate";
  state.active = true;
}

/** Restore the video styles changed while exposing native controls. */
function restoreInstagramVideoAfterNativeControls(video, state) {
  if (!state.active || !state.original) return;
  video.style.position = state.original.position;
  video.style.zIndex = state.original.zIndex;
  video.style.pointerEvents = state.original.pointerEvents;
  video.style.isolation = state.original.isolation;
  state.original = null;
  state.active = false;
}

/** Remove the story push-up fix from a video element. */
function removeStoryVideoFix(video) {
  if (video.dataset.imdStoryFix) {
    const existing = video.style.transform || "";
    const cleaned = existing.replace(/translateY\([^)]*\)/g, "").trim();
    if (cleaned) {
      video.style.transform = cleaned;
    } else {
      video.style.removeProperty("transform");
    }
    video.style.removeProperty("z-index");
    delete video.dataset.imdStoryFix;
  }
}

/** Prevent action group events from propagating to the underlying page. */
function isolateActionGroupEvents(group) {
  const eventTypes = [
    "pointerdown",
    "pointerup",
    "mousedown",
    "mouseup",
    "touchstart",
    "touchend",
    "click",
    "dblclick",
  ];
  eventTypes.forEach((type) => {
    group.addEventListener(
      type,
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
      },
      { passive: false },
    );
  });
}

/** Append the action group to document.body if not already there. */
function attachActionGroup(group) {
  if (group.parentElement === document.body) return;
  document.body.appendChild(group);
}

/** Remove the action group from the DOM. */
function detachActionGroup(group) {
  group.remove();
}

/** Show the action group positioned over the media element. */
function showActionGroup(group, media) {
  if (!media.isConnected) {
    cleanupMedia(media);
    return;
  }
  if (!visibleMedia.has(media)) {
    hideActionGroup(group);
    return;
  }

  mediaControls.forEach((otherGroup, otherMedia) => {
    if (otherMedia !== media) hideActionGroup(otherGroup);
  });

  attachActionGroup(group);
  if (
    group.classList.contains("imd-video-portal") &&
    typeof group.showPopover === "function" &&
    !group.matches(":popover-open")
  ) {
    try {
      group.showPopover();
    } catch (error) {
      if (error.name !== "InvalidStateError") throw error;
    }
  }
  group.classList.add("imd-show");
  positionActionGroup(group, media);
}

/** Hide the action group and close its popover if applicable. */
function hideActionGroup(group) {
  group.classList.remove("imd-show");
  if (
    group.classList.contains("imd-video-portal") &&
    typeof group.hidePopover === "function" &&
    group.matches(":popover-open")
  ) {
    try {
      group.hidePopover();
    } catch (error) {
      if (error.name !== "InvalidStateError") throw error;
    }
  }
}

/** Collect hover targets (media + tightly wrapping ancestors) for show/hide. */
function getMediaHoverTargets(media) {
  const targets = [media];
  const mediaRect = media.getBoundingClientRect();
  let ancestor = media.parentElement;

  for (let depth = 0; ancestor && depth < 3; depth += 1) {
    const rect = ancestor.getBoundingClientRect();
    const widthLimit = Math.max(mediaRect.width * 1.5, mediaRect.width + 40);
    const heightLimit = Math.max(mediaRect.height * 1.5, mediaRect.height + 40);

    if (rect.width <= widthLimit && rect.height <= heightLimit) {
      targets.push(ancestor);
      ancestor = ancestor.parentElement;
      continue;
    }
    break;
  }

  return targets;
}

/** Position the action group relative to the media element based on settings. */
function positionActionGroup(group, media) {
  attachActionGroup(group);
  const rect = getActionRect(media);
  const width = group.offsetWidth || 86;
  const height = group.offsetHeight || 40;
  const gap = 10;
  let top;
  let left;

  switch (settings.buttonPosition) {
    case "top-left":
      top = rect.top + gap;
      left = rect.left + gap;
      break;
    case "bottom-left":
      top = rect.bottom - height - gap;
      left = rect.left + gap;
      break;
    case "bottom-right":
      top = rect.bottom - height - gap;
      left = rect.right - width - gap;
      break;
    case "center":
      top = rect.top + (rect.height - height) / 2;
      left = rect.left + (rect.width - width) / 2;
      break;
    default:
      top = rect.top + gap;
      left = rect.right - width - gap;
  }

  group.style.top = `${Math.max(0, top)}px`;
  group.style.left = `${Math.max(0, left)}px`;
}

/** Reposition any currently visible action groups (on scroll/resize). */
function repositionOpenControls() {
  mediaControls.forEach((group, media) => {
    if (!media.isConnected) {
      cleanupMedia(media);
      return;
    }
    if (media.tagName === "VIDEO") applyStoryVideoFix(media);
    const inLightbox = media.closest(".imd-lightbox-overlay");
    if (!visibleMedia.has(media) && !inLightbox) {
      hideActionGroup(group);
    } else if (group.classList.contains("imd-show")) {
      positionActionGroup(group, media);
    }
  });
}

let repositionFrame = null;
function scheduleReposition() {
  if (repositionFrame !== null) return;
  repositionFrame = requestAnimationFrame(() => {
    repositionFrame = null;
    repositionOpenControls();
  });
}

window.addEventListener("scroll", scheduleReposition, true);
window.addEventListener("resize", scheduleReposition);

let pointerFrame = null;
let lastPointerPosition = null;
document.addEventListener(
  "pointermove",
  (event) => {
    if (event.pointerType === "touch") return;
    lastPointerPosition = { x: event.clientX, y: event.clientY };
    schedulePointerReconciliation();
  },
  true,
);

/** Schedule a pointer reconciliation on the next animation frame. */
function schedulePointerReconciliation() {
  if (!lastPointerPosition) return;
  if (pointerFrame !== null) cancelAnimationFrame(pointerFrame);
  pointerFrame = requestAnimationFrame(() => {
    pointerFrame = null;
    reconcileControlsAtPoint(lastPointerPosition.x, lastPointerPosition.y);
  });
}

/** Show the action group for the topmost media at the given pointer coordinates. */
function reconcileControlsAtPoint(x, y) {
  const topMedia = findTopMediaAtPoint(x, y);
  mediaControls.forEach((group, media) => {
    if (!media.isConnected) {
      cleanupMedia(media);
      return;
    }

    if (visibleMedia.has(media) && media === topMedia) {
      showActionGroup(group, media);
    } else if (!group.matches(":hover")) {
      hideActionGroup(group);
    }
  });
}

/** Find the topmost visible media element at the given coordinates. */
function findTopMediaAtPoint(x, y) {
  const stack = document.elementsFromPoint(x, y);
  const { hasModal, modal } = getModalAtPoint(x, y, stack);
  if (hasModal && !modal) return null;
  let bestMedia = null;
  let bestStackIndex = Infinity;

  mediaControls.forEach((group, media) => {
    if (
      !media.isConnected ||
      !visibleMedia.has(media) ||
      !isMediaActuallyVisible(media)
    ) {
      return;
    }
    if (modal && !modal.contains(media)) return;
    const rect = media.getBoundingClientRect();
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      return;
    }

    const directStackIndex = stack.indexOf(media);
    const stackIndex =
      directStackIndex !== -1
        ? directStackIndex
        : stack.findIndex((element) => element.contains(media));
    if (stackIndex === -1 || stackIndex >= bestStackIndex) return;

    bestMedia = media;
    bestStackIndex = stackIndex;
  });

  return bestMedia;
}

let visibilityStyleCacheFrame = -1;
const visibilityStyleCache = new Map();

function getCachedComputedStyle(element) {
  const frame = performance.now();
  if (visibilityStyleCacheFrame !== Math.floor(frame / 16)) {
    visibilityStyleCache.clear();
    visibilityStyleCacheFrame = Math.floor(frame / 16);
  }
  let cached = visibilityStyleCache.get(element);
  if (!cached) {
    cached = getComputedStyle(element);
    visibilityStyleCache.set(element, cached);
  }
  return cached;
}

/** Check if a media element is actually visible (not hidden, opacity 0, etc.). */
function isMediaActuallyVisible(media) {
  const hasBackgroundProxy = hasVisibleBackgroundProxy(media);
  if (
    typeof media.checkVisibility === "function" &&
    !media.checkVisibility({
      checkOpacity: !hasBackgroundProxy,
      checkVisibilityCSS: true,
    })
  ) {
    return false;
  }

  for (let element = media; element; element = element.parentElement) {
    if (
      element.hidden ||
      element.inert ||
      element.getAttribute("aria-hidden") === "true"
    ) {
      return false;
    }
    const style = getCachedComputedStyle(element);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      (Number(style.opacity) === 0 &&
        !(element === media && hasBackgroundProxy))
    ) {
      return false;
    }
  }
  return true;
}

/** Check if the media has a visible background proxy element (e.g. Instagram reel thumb). */
function hasVisibleBackgroundProxy(media) {
  if (!media.parentElement) return false;
  const mediaRect = media.getBoundingClientRect();
  const parent = media.tagName === "VIDEO"
    ? (getInstagramReelLink(media) || media.parentElement)
    : media.parentElement;
  if (!parent) return false;

  if (media.tagName === "VIDEO") {
    const imgs = parent.querySelectorAll("img");
    for (const element of imgs) {
      if (element === media) continue;
      const style = getCachedComputedStyle(element);
      const hasVisibleImage = element.tagName === "IMG" && Boolean(element.currentSrc || element.src);
      if (
        (!hasVisibleImage && style.backgroundImage === "none") ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number(style.opacity) === 0
      ) continue;
      const rect = element.getBoundingClientRect();
      if (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.left < mediaRect.right &&
        rect.right > mediaRect.left &&
        rect.top < mediaRect.bottom &&
        rect.bottom > mediaRect.top
      ) return true;
    }
    return false;
  }

  for (const element of parent.children) {
    if (element === media) continue;
    const style = getCachedComputedStyle(element);
    const hasVisibleImage = element.tagName === "IMG" && Boolean(element.currentSrc || element.src);
    if (
      (!hasVisibleImage && style.backgroundImage === "none") ||
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number(style.opacity) === 0
    ) continue;
    const rect = element.getBoundingClientRect();
    if (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.left < mediaRect.right &&
      rect.right > mediaRect.left &&
      rect.top < mediaRect.bottom &&
      rect.bottom > mediaRect.top
    ) return true;
  }
  return false;
}

let cachedModalsFrame = -1;
let cachedModals = [];

function getVisibleModals() {
  const frame = performance.now();
  if (cachedModalsFrame !== Math.floor(frame / 16)) {
    cachedModalsFrame = Math.floor(frame / 16);
    cachedModals = Array.from(
      document.querySelectorAll(
        'dialog[open], [role="dialog"], [aria-modal="true"]',
      ),
    ).filter((modal) => {
      const style = getCachedComputedStyle(modal);
      const rect = modal.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity) > 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    });
  }
  return cachedModals;
}

/** Find the topmost modal at a point, or determine if one exists. */
function getModalAtPoint(x, y, stack) {
  const modals = getVisibleModals();
  if (!modals.length) return { hasModal: false, modal: null };

  const modal = stack
    .map((element) => modals.find((candidate) => candidate.contains(element)))
    .find(Boolean);
  if (modal) return { hasModal: true, modal };

  const containsPoint = modals.find((candidate) => {
    const rect = candidate.getBoundingClientRect();
    return (
      x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
    );
  });
  return { hasModal: true, modal: containsPoint || null };
}

/** Create an action button element with an SVG icon. */
function createActionButton(className, title, icon) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `imd-action-btn ${className}`;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.innerHTML = icon;
  return button;
}

/** Build the action buttons for a media element (hover group and context menu). */
function buildMediaActionButtons(media) {
  const isImage = media.tagName === "IMG";
  const downloadBtn = createActionButton(
    "imd-down-btn",
    `Download ${isImage ? "Image" : "Video"}`,
    DOWNLOAD_ICON,
  );
  const previewBtn = createActionButton(
    "imd-preview-btn",
    `Preview ${isImage ? "highest-resolution image" : "video"}`,
    PREVIEW_ICON,
  );
  const captureBtn = isImage
    ? null
    : createActionButton("imd-capture-btn", "Capture Frame", CAPTURE_ICON);
  const lightboxBtn =
    isImage && !media.closest(".imd-lightbox-overlay")
      ? createActionButton(
          "imd-lightbox-btn",
          "View full-size image",
          LIGHTBOX_ICON,
        )
      : null;
  const pipBtn =
    !isImage && document.pictureInPictureEnabled
      ? createActionButton("imd-pip-btn", "Picture-in-Picture", PIP_ICON)
      : null;
  const trimBtn = !isImage
    ? createActionButton("imd-trim-btn", "Trim from current time", TRIM_ICON)
    : null;
  const copyBtn = createActionButton(
    "imd-copy-btn",
    isImage ? "Copy image to clipboard" : "Copy current frame to clipboard",
    COPY_ICON,
  );
  const isBlobVideo = !isImage && getVideoUrl(media).startsWith("blob:");
  previewBtn.hidden = !settings.showPreviewButton || isBlobVideo;
  const buttons = [downloadBtn, previewBtn];
  if (trimBtn) buttons.push(trimBtn);
  if (lightboxBtn) buttons.push(lightboxBtn);
  if (captureBtn) buttons.push(captureBtn);
  if (copyBtn) buttons.push(copyBtn);
  if (pipBtn) buttons.push(pipBtn);
  return {
    downloadBtn,
    previewBtn,
    captureBtn,
    lightboxBtn,
    pipBtn,
    trimBtn,
    copyBtn,
    buttons,
  };
}

/** Attach the click handlers for the media action buttons. */
function attachMediaActionHandlers(media, btns) {
  btns.downloadBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    downloadMedia(media).catch((error) => {
      console.error("Media download failed:", error);
    });
  });
  btns.previewBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    previewMedia(media);
  });
  btns.captureBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    captureVideoFrame(media)
      .then(({ blobUrl, dataUrl }) => {
        if (dataUrl) {
          openLightbox(media, dataUrl, blobUrl);
          setTimeout(() => URL.revokeObjectURL(blobUrl), 120_000);
          showToast("Frame captured.");
        }
      })
      .catch((error) => {
        console.error("Video frame capture failed:", error);
        showToast(
          `Frame capture failed: ${error?.message || "unknown error"}`,
        );
      });
  });
  btns.lightboxBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openLightbox(media);
  });
  btns.pipBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    togglePictureInPicture(media);
  });
  btns.trimBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    triggerTrim(media, null);
  });
  btns.copyBtn?.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const restoreTitle = () => {
      setTimeout(() => {
        const isVideo = media.tagName === "VIDEO";
        btns.copyBtn.title = isVideo
          ? "Copy current frame to clipboard"
          : "Copy image to clipboard";
      }, 1500);
    };
    try {
      const isVideo = media.tagName === "VIDEO";
      const { copiedType } = isVideo
        ? await copyVideoFrameToClipboard(media)
        : await copyImageToClipboard(media);
      btns.copyBtn.title = "Copied!";
      showToast(
        copiedType
          ? `Copied to clipboard (${copiedType})`
          : "Copied to clipboard.",
      );
      setTimeout(() => {
        btns.copyBtn.title =
          isVideo && copiedType
            ? `Copy current frame to clipboard (${copiedType})`
            : isVideo
              ? "Copy current frame to clipboard"
              : "Copy image to clipboard";
      }, 1500);
    } catch (error) {
      console.error("Copy to clipboard failed:", error);
      btns.copyBtn.title = "Copy failed";
      restoreTitle();
      showToast("Copy to clipboard failed.");
    }
  });
}

async function copyImageToClipboard(image) {
  const url = await resolveHighestResolutionImageUrl(image);
  let blob;
  try {
    blob = await fetchImageBlob(url);
  } catch (error) {
    blob = await fetchImageBlobViaBackground(url);
  }
  const copiedType = await copyBlobToClipboard(blob);
  return { copiedType };
}

async function copyVideoFrameToClipboard(video) {
  const preferredFormat = getFrameCaptureFormat(settings.captureType);
  const clipboardFormat = getClipboardImageFormat(preferredFormat);
  const blob = await captureVideoFrameBlobWithFallbacks(
    video,
    clipboardFormat.extension,
  );
  const copiedType = await copyBlobToClipboard(blob);
  return { copiedType };
}

/** Write an image blob to the system clipboard. */
async function copyBlobToClipboard(blob) {
  if (
    !navigator.clipboard ||
    typeof navigator.clipboard.write !== "function" ||
    typeof ClipboardItem === "undefined"
  ) {
    throw new Error(
      "Clipboard is not available on this page (an HTTPS page is required).",
    );
  }

  let type = blob.type || "";
  if (
    !type ||
    (typeof ClipboardItem.supports === "function" &&
      !ClipboardItem.supports(type))
  ) {
    blob = await convertImageBlobToPng(blob);
    type = "image/png";
  }

  await navigator.clipboard.write([new ClipboardItem({ [type]: blob })]);
  return type.split("/")[1].replace("jpeg", "jpg");
}

/** Re-encode any image blob into a PNG blob. */
async function convertImageBlobToPng(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (png) =>
        png ? resolve(png) : reject(new Error("PNG conversion failed.")),
      "image/png",
    );
  });
}

/** Fetch an image URL as a blob from the current page context. */
async function fetchImageBlob(url) {
  const response = await fetch(url, {
    credentials: "include",
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`Image fetch failed (${response.status}).`);
  return response.blob();
}

/** Fetch an image URL as a blob through the background (bypasses CORS). */
function fetchImageBlobViaBackground(url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let port;
    let timeout;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        port?.disconnect();
      } catch {}
      fn(value);
    };
    try {
      port = chrome.runtime.connect({ name: FETCH_MEDIA_PORT_NAME });
    } catch (error) {
      reject(error);
      return;
    }
    timeout = setTimeout(
      () => settle(reject, new Error("Image fetch timed out.")),
      30000,
    );
    port.onMessage.addListener((response) => {
      if (response?.ok && response.data) {
        settle(
          resolve,
          new Blob([response.data], { type: response.mimeType || "" }),
        );
      } else {
        settle(reject, new Error(response?.error || "Image fetch failed."));
      }
    });
    port.onDisconnect.addListener(() => {
      settle(
        reject,
        new Error(
          chrome.runtime.lastError?.message ||
            "Background fetch connection closed.",
        ),
      );
    });
    port.postMessage({ action: "fetchMedia", url });
  });
}

function getFrameCaptureFormat(captureType = settings.captureType) {
  const formats = {
    jpg: { mimeType: "image/jpeg", extension: "jpg", quality: 0.92 },
    png: { mimeType: "image/png", extension: "png" },
    webp: { mimeType: "image/webp", extension: "webp", quality: 0.92 },
  };
  return formats[captureType] ?? formats.jpg;
}

function getClipboardImageFormat(preferredFormat) {
  if (
    typeof ClipboardItem !== "undefined" &&
    typeof ClipboardItem.supports === "function" &&
    !ClipboardItem.supports(preferredFormat.mimeType)
  ) {
    return getFrameCaptureFormat("png");
  }
  return preferredFormat;
}

/** Re-capture a video frame by loading the source with CORS enabled. */
function captureVideoFrameFromSource(
  video,
  captureType = settings.captureType,
) {
  return new Promise((resolve, reject) => {
    const url = getVideoUrl(video);
    if (!url || url.startsWith("blob:") || url.startsWith("data:")) {
      reject(new Error("Video source cannot be re-captured."));
      return;
    }

    const probe = document.createElement("video");
    probe.muted = true;
    probe.playsInline = true;
    probe.crossOrigin = "anonymous";
    probe.preload = "auto";

    let settled = false;
    const finish = (error, blob) => {
      if (settled) return;
      settled = true;
      probe.removeAttribute("src");
      probe.load();
      probe.remove();
      if (error) reject(error);
      else resolve(blob);
    };

    probe.onloadedmetadata = () => {
      const duration = Number.isFinite(probe.duration)
        ? probe.duration
        : Infinity;
      const target = Math.min(
        Math.max(video.currentTime || 0, 0),
        Math.max(duration - 0.01, 0),
      );
      try {
        probe.currentTime = target;
      } catch (error) {
        finish(error);
      }
    };
    probe.onseeked = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = probe.videoWidth;
        canvas.height = probe.videoHeight;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas is unavailable.");
        context.imageSmoothingEnabled = false;
        context.drawImage(probe, 0, 0);
        const format = getFrameCaptureFormat(captureType);
        canvas.toBlob(
          (result) =>
            result
              ? finish(null, result)
              : finish(new Error("Frame encoding failed.")),
          format.mimeType,
          format.quality,
        );
      } catch (error) {
        finish(error);
      }
    };
    probe.onerror = () =>
      finish(new Error("Video source could not be loaded for capture."));

    probe.src = url;
    probe.load();
  });
}

/** Preview media in the background tab (uses highest resolution for images/videos). */
async function previewMedia(media, preferredUrl) {
  if (media.tagName === "VIDEO") {
    const url = resolveHighestResolutionVideoUrl(media);
    if (url) openPreviewInBackground(url);
    return;
  }

  if (preferredUrl) {
    openPreviewInBackground(preferredUrl);
    return;
  }

  try {
    const url = await resolveHighestResolutionImageUrl(media);
    if (url) openPreviewInBackground(url);
  } catch (error) {
    console.error("Image resolution detection failed.", error);
  }
}

/** Open a URL in the background preview tab via the extension runtime. */
function openPreviewInBackground(url) {
  const runtime = globalThis.chrome?.runtime;
  if (typeof runtime?.sendMessage !== "function") {
    console.warn(
      "[Media Downloader] Extension context is unavailable. Reload the page.",
    );
    return;
  }

  runtime.sendMessage({ action: "preview", url }, (response) => {
    if (runtime.lastError) {
      console.warn(
        "[Media Downloader] Preview failed:",
        runtime.lastError.message,
      );
      showToast("Preview failed.");
      return;
    }
    if (response?.ok === false) {
      console.warn("[Media Downloader] Preview failed:", response.error);
      showToast(response.error || "Preview failed.");
      return;
    }
    showToast("Preview opened.");
  });
}

/**
 * Open a full-size lightbox overlay for an image (or a captured video frame).
 * `url` is the display URL (data: URLs render reliably on every page).
 * `downloadUrl` is the original media URL used for downloads/previews.
 */
function openLightbox(media, url, downloadUrl) {
  if (media.tagName !== "IMG" && !url) return;
  if (lightboxOpen) return;

  const promise = url
    ? Promise.resolve(url)
    : resolveHighestResolutionImageUrl(media);
  promise
    .then((resolvedUrl) => {
      if (!resolvedUrl) return;
      const mediaUrl = downloadUrl || resolvedUrl;

      lightboxOpen = true;

      const activeVideo = document.querySelector("video:not([paused])");
      if (activeVideo) activeVideo.pause();

      document.querySelectorAll(".imd-lightbox-btn").forEach((btn) => {
        btn.hidden = true;
      });

      const overlay = document.createElement("div");
      overlay.className = "imd-lightbox-overlay";

      const container = document.createElement("div");
      container.className = "imd-lightbox-container";

      const stage = document.createElement("div");
      stage.className = "imd-lightbox-stage";

      const img = document.createElement("img");
      img.className = "imd-lightbox-image";
      img.alt = media.alt || "";
      // Load the image CORS-enabled so the crop export can draw it straight
      // from the canvas-taint-free element (no refetch). If the server has no
      // CORS headers the load fails; retry without crossOrigin and remember
      // the canvas will be tainted.
      let corsClean = true;
      img.addEventListener("error", () => {
        if (!img.crossOrigin) return;
        corsClean = false;
        img.crossOrigin = null;
        img.src = resolvedUrl;
      });
      img.crossOrigin = "anonymous";
      img.src = resolvedUrl;

      stage.appendChild(img);
      container.appendChild(stage);
      overlay.appendChild(container);

      const actions = document.createElement("div");
      actions.className = "imd-lightbox-actions";
      actions.innerHTML = `
      <div class="imd-lightbox-actions-row">
        <button type="button" class="imd-action-btn imd-down-btn" title="Download Image" aria-label="Download Image">${DOWNLOAD_ICON}</button>
        <button type="button" class="imd-action-btn imd-preview-btn" title="Preview image" aria-label="Preview image">${PREVIEW_ICON}</button>
        <button type="button" class="imd-action-btn imd-crop-btn" title="Toggle crop" aria-label="Toggle crop">${CROP_ICON}</button>
      </div>
      <span class="imd-lightbox-info"></span>
    `;
      const infoEl = actions.querySelector(".imd-lightbox-info");
      let infoText = "";
      const setInfo = (text) => {
        infoText = text;
        infoEl.textContent = cropActive ? infoCropText() : infoText;
      };
      const infoAbort = new AbortController();
      img.addEventListener(
        "load",
        () => {
          const w = img.naturalWidth;
          const h = img.naturalHeight;
          const ext = (
            resolvedUrl.match(/\.(\w+)(?:\?|$)/)?.[1] || ""
          ).toLowerCase();
          const format =
            ext === "png" ? "PNG" : ext === "webp" ? "WebP" : "JPG";
          setInfo(`${w} × ${h} · ${format}`);
          fetch(resolvedUrl, { method: "HEAD", signal: infoAbort.signal })
            .then((res) => {
              const ct = res.headers.get("Content-Type");
              if (ct) {
                const m = ct.match(/image\/(\w+)/);
                if (m) {
                  const f = m[1].toLowerCase();
                  const label =
                    f === "jpeg"
                      ? "JPG"
                      : f === "png"
                        ? "PNG"
                        : f === "webp"
                          ? "WebP"
                          : f.toUpperCase();
                  setInfo(`${w} × ${h} · ${label}`);
                }
              }
              const len = res.headers.get("Content-Length");
              if (len) {
                const mb = (Number(len) / (1024 * 1024)).toFixed(1);
                setInfo(`${infoText} · ${mb} MB`);
              }
            })
            .catch(() => {});
          startCrop();
        },
        { once: true },
      );
      actions.querySelector(".imd-down-btn").addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (cropActive) {
          saveCrop();
          return;
        }
        // downloadMedia is async; for blob: URLs it dispatches the download
        // request and the media bridge fetches the blob. Close only after it
        // resolves so the blob URL is not revoked before the fetch completes.
        downloadMedia(img, mediaUrl).finally(() => close());
      });
      actions
        .querySelector(".imd-preview-btn")
        .addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          previewMedia(img, mediaUrl);
          close();
        });
      const anchor =
        document.getElementById("MediaViewer")?.open
          ? document.getElementById("MediaViewer")
          : document.body;
      anchor.appendChild(overlay);
      anchor.appendChild(actions);

      requestAnimationFrame(() => {
        overlay.classList.add("imd-lightbox-open");
      });

      overlay.addEventListener("scroll", repositionOpenControls, {
        passive: true,
      });

      const escHandler = (e) => {
        if (e.key === "Escape") {
          if (cropActive) cancelCrop();
          else close();
        }
      };
      document.addEventListener("keydown", escHandler);

      // ---------------------------------------------------------------------
      // Crop
      // ---------------------------------------------------------------------
      const cropBtn = actions.querySelector(".imd-crop-btn");
      const cropRect = { x: 0, y: 0, w: 1, h: 1 };
      let cropActive = false;
      let cropOverlay = null;
      let cropDrag = null;

      const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

      function infoCropText() {
        const w = Math.max(1, Math.round(cropRect.w * img.naturalWidth));
        const h = Math.max(1, Math.round(cropRect.h * img.naturalHeight));
        return `Crop · ${w} × ${h} px`;
      }

      function renderCropOverlay() {
        const rectEl = cropOverlay.querySelector(".imd-crop-rect");
        rectEl.style.left = `${cropRect.x * 100}%`;
        rectEl.style.top = `${cropRect.y * 100}%`;
        rectEl.style.width = `${cropRect.w * 100}%`;
        rectEl.style.height = `${cropRect.h * 100}%`;
      }

      function updateCropInfo() {
        infoEl.textContent = cropActive ? infoCropText() : infoText;
      }

      function createCropOverlay() {
        const el = document.createElement("div");
        el.className = "imd-crop-overlay";
        el.innerHTML = `
          <div class="imd-crop-mask"></div>
          <div class="imd-crop-rect">
            <div class="imd-crop-grid"></div>
            <div class="imd-crop-handle imd-crop-h-nw" data-dir="nw"></div>
            <div class="imd-crop-handle imd-crop-h-n" data-dir="n"></div>
            <div class="imd-crop-handle imd-crop-h-ne" data-dir="ne"></div>
            <div class="imd-crop-handle imd-crop-h-e" data-dir="e"></div>
            <div class="imd-crop-handle imd-crop-h-se" data-dir="se"></div>
            <div class="imd-crop-handle imd-crop-h-s" data-dir="s"></div>
            <div class="imd-crop-handle imd-crop-h-sw" data-dir="sw"></div>
            <div class="imd-crop-handle imd-crop-h-w" data-dir="w"></div>
          </div>`;
        el.addEventListener("pointerdown", (e) => {
          const handle = e.target.closest(".imd-crop-handle");
          const rectEl = e.target.closest(".imd-crop-rect");
          if (!handle && !rectEl) {
            if (e.target.classList.contains("imd-crop-mask")) {
              cancelCrop();
            }
            return;
          }
          e.preventDefault();
          e.stopPropagation();
          cropDrag = {
            mode: handle ? "resize" : "move",
            dir: handle?.dataset.dir || "",
            start: { x: e.clientX, y: e.clientY, rect: { ...cropRect } },
            pointerId: e.pointerId,
            moved: false,
          };
          try {
            el.setPointerCapture(e.pointerId);
          } catch {}
        });
        el.addEventListener("pointermove", (e) => {
          if (!cropDrag) return;
          e.preventDefault();
          el.classList.add("imd-dragging");
          if (
            Math.hypot(e.clientX - cropDrag.start.x, e.clientY - cropDrag.start.y) >
            5
          ) {
            cropDrag.moved = true;
          }
          const stageRect = stage.getBoundingClientRect();
          if (!stageRect.width || !stageRect.height) return;
          const dx = (e.clientX - cropDrag.start.x) / stageRect.width;
          const dy = (e.clientY - cropDrag.start.y) / stageRect.height;
          const { x, y, w, h } = cropDrag.start.rect;
          const minW = Math.min(MIN_CROP_SIZE_PX / stageRect.width, 0.5);
          const minH = Math.min(MIN_CROP_SIZE_PX / stageRect.height, 0.5);
          const next = { ...cropRect };
          if (cropDrag.mode === "move") {
            next.x = clamp(x + dx, 0, Math.max(0, 1 - w));
            next.y = clamp(y + dy, 0, Math.max(0, 1 - h));
          } else {
            const dir = cropDrag.dir;
            if (dir.includes("w")) {
              const left = clamp(x + dx, 0, Math.max(0, x + w - minW));
              next.x = left;
              next.w = x + w - left;
            } else if (dir.includes("e")) {
              next.w = clamp(w + dx, minW, 1 - x);
            }
            if (dir.includes("n")) {
              const top = clamp(y + dy, 0, Math.max(0, y + h - minH));
              next.y = top;
              next.h = y + h - top;
            } else if (dir.includes("s")) {
              next.h = clamp(h + dy, minH, 1 - y);
            }
          }
          Object.assign(cropRect, next);
          renderCropOverlay();
          updateCropInfo();
        });
        const endCropDrag = (e) => {
          if (!cropDrag) return;
          const drag = cropDrag;
          const pointerId = cropDrag.pointerId;
          cropDrag = null;
          el.classList.remove("imd-dragging");
          try {
            el.releasePointerCapture(pointerId);
          } catch {}
          // A plain click on the crop area (no drag) toggles zoom. Handle
          // drags are resize gestures and never toggle zoom.
          if (drag.mode === "move" && !drag.moved) {
            toggleZoom({ clientX: e.clientX, clientY: e.clientY });
          }
        };
        el.addEventListener("pointerup", endCropDrag);
        el.addEventListener("pointercancel", endCropDrag);
        return el;
      }

      function hideCropOverlay() {
        if (cropOverlay) cropOverlay.style.display = "none";
      }

      function showCropOverlay() {
        if (cropOverlay) cropOverlay.style.display = "";
      }

      function startCrop() {
        if (cropActive) return;
        if (!img.complete || !img.naturalWidth) {
          showToast("Wait for the image to finish loading.");
          return;
        }
        // Leave the zoomed state first so the crop overlay aligns 1:1 with
        // the displayed image.
        if (lightboxZoomed) {
          lightboxZoomed = false;
          lightboxZoomLevel = 1;
          applyZoom();
        }
        cropActive = true;
        // Cover the whole image initially (edges at 0/100%).
        Object.assign(cropRect, { x: 0, y: 0, w: 1, h: 1 });
        if (!cropOverlay) cropOverlay = createCropOverlay();
        showCropOverlay();
        stage.appendChild(cropOverlay);
        cropBtn.classList.add("imd-active");
        renderCropOverlay();
        updateCropInfo();
      }

      function cancelCrop() {
        if (!cropActive) return;
        cropActive = false;
        cropDrag = null;
        cropOverlay?.remove();
        cropBtn.classList.remove("imd-active");
        updateCropInfo();
      }

      cropBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (cropActive) cancelCrop();
        else startCrop();
      });

      /** Export the current crop region at full resolution. */
      async function saveCrop() {
        try {
          const { blob, filename, width, height } = await buildCroppedImage(
            img,
            mediaUrl || resolvedUrl,
            cropRect,
            getFrameCaptureFormat(settings.captureType),
            corsClean,
          );
          downloadBlobFile(
            blob,
            filename,
            settings.downloadFolder,
            settings.showSaveAs,
          );
          showToast(`Crop saved · ${width} × ${height} px`);
          close();
        } catch (error) {
          console.error("Crop failed:", error);
          showToast(`Crop failed: ${error?.message || "Unknown error"}`);
        }
      }

      const cleanup = () => {
        cancelCrop();
        infoAbort.abort();
        document.removeEventListener("keydown", escHandler);
        overlay.removeEventListener("scroll", repositionOpenControls);
        overlay.remove();
        actions.remove();
        lightboxOpen = false;
        if (mediaUrl.startsWith("blob:")) {
          setTimeout(() => URL.revokeObjectURL(mediaUrl), 60_000);
        }
        document.querySelectorAll(".imd-lightbox-btn").forEach((btn) => {
          btn.hidden = false;
        });
        lightboxZoomed = false;
        lightboxZoomLevel = 1;
      };

      const close = () => cleanup();

      let lightboxZoomed = false;
      let lightboxZoomLevel = 1;
      overlay.addEventListener("click", (e) => {
        if (e.target !== overlay) return;
        if (
          overlay.scrollWidth > overlay.clientWidth ||
          overlay.scrollHeight > overlay.clientHeight
        ) {
          const rect = overlay.getBoundingClientRect();
          const sw = overlay.offsetWidth - overlay.clientWidth;
          const sh = overlay.offsetHeight - overlay.clientHeight;
          if (e.clientX > rect.right - sw || e.clientY > rect.bottom - sh)
            return;
        }
        close();
      });

      function getZoomOrigin(e) {
        const rect = img.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 100;
        const y = ((e.clientY - rect.top) / rect.height) * 100;
        return { x, y };
      }

      function applyZoom(origin) {
        if (lightboxZoomed) {
          const scale = lightboxZoomLevel;
          const nw = img.naturalWidth;
          const nh = img.naturalHeight;

          const displayW = Math.round(nw * scale);
          const displayH = Math.round(nh * scale);

          img.style.width = displayW + "px";
          img.style.height = displayH + "px";
          container.style.width = "";
          container.style.height = "";

          container.classList.add("imd-lightbox-fullwidth");

          if (origin) {
            overlay.scrollLeft = 0;
            overlay.scrollTop = 0;
            void overlay.offsetHeight;

            const imgX = (origin.x / 100) * nw;
            const imgY = (origin.y / 100) * nh;

            overlay.scrollLeft = Math.max(
              0,
              Math.round(imgX * scale - overlay.clientWidth / 2),
            );
            overlay.scrollTop = Math.max(
              0,
              Math.round(imgY * scale - overlay.clientHeight / 2),
            );
          }
        } else {
          img.style.width = "";
          img.style.height = "";
          container.style.width = "";
          container.style.height = "";

          container.classList.remove("imd-lightbox-fullwidth");
        }
      }

      function toggleZoom(e) {
        if (lightboxZoomed) {
          lightboxZoomed = false;
          lightboxZoomLevel = 1;
          applyZoom();
          if (cropActive) showCropOverlay();
        } else {
          lightboxZoomed = true;
          lightboxZoomLevel = 1;
          applyZoom(getZoomOrigin(e));
          if (cropActive) hideCropOverlay();
        }
      }

      img.addEventListener("click", toggleZoom);

      overlay.addEventListener(
        "wheel",
        (e) => {
          if (e.target.closest(".imd-lightbox-actions")) return;

          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            const delta = e.deltaY > 0 ? 1 / 1.15 : 1.15;
            lightboxZoomLevel = Math.min(
              Math.max(lightboxZoomLevel * delta, 1),
              10,
            );
            if (lightboxZoomLevel <= 1.001) {
              // Wheeled all the way back out: leave the zoomed state.
              if (lightboxZoomed) {
                lightboxZoomed = false;
                lightboxZoomLevel = 1;
                applyZoom();
                if (cropActive) showCropOverlay();
              }
              return;
            }
            if (!lightboxZoomed) {
              lightboxZoomed = true;
              lightboxZoomLevel = 1;
            }
            applyZoom(e.deltaY < 0 ? getZoomOrigin(e) : null);
            if (cropActive) hideCropOverlay();
          }
        },
        { passive: false },
      );


    })
    .catch((error) => {
      console.error("Lightbox failed to load image:", error);
    });
}

// ---------------------------------------------------------------------------
// Cropped image export
// ---------------------------------------------------------------------------

/** Detect the best output format for a cropped image. Uses the option
 * format when set, otherwise mirrors the source image's format. */
function getImageCropFormat(url, preferredFormat) {
  if (preferredFormat?.mimeType) {
    return {
      mimeType: preferredFormat.mimeType,
      extension: preferredFormat.extension || "jpg",
      quality: preferredFormat.quality ?? null,
    };
  }
  let ext = "";
  if (url.startsWith("data:")) {
    ext = (url.match(/^data:image\/([a-z0-9.+-]+)/i)?.[1] || "").toLowerCase();
  } else {
    try {
      ext = (
        new URL(url).pathname.match(/\.([a-z0-9]+)(?:\?|$)/i)?.[1] || ""
      ).toLowerCase();
    } catch {}
  }
  if (ext === "png") return { mimeType: "image/png", extension: "png", quality: null };
  if (ext === "webp") return { mimeType: "image/webp", extension: "webp", quality: 0.95 };
  return { mimeType: "image/jpeg", extension: "jpg", quality: 0.95 };
}

/** Load an image blob into a same-origin <img> for taint-free canvas drawing. */
function loadImageFromBlob(blob) {
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ image, url });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Retrieved image could not be decoded."));
    };
    image.src = url;
  });
}

/** Build a unique filename for a cropped image export (no "crop" suffix). */
function getCropFilename(url, extension) {
  let base = `image-${Date.now()}`;
  if (!url.startsWith("data:")) {
    try {
      const pathname = new URL(url).pathname;
      const name = pathname.slice(pathname.lastIndexOf("/") + 1);
      if (name) {
        base = decodeURIComponent(name).replace(/[^a-zA-Z0-9.\-_]/g, "_");
        base = base.replace(/\.[^.]+$/, "");
      }
    } catch {}
  }
  return `${base || "image"}.${extension}`;
}

/**
 * Render the crop region at the image's full original resolution.
 * When the lightbox image was loaded CORS-clean (crossOrigin + ACAO headers)
 * it is drawn straight from the on-screen element — no refetch at all. Only
 * if the lightbox image is tainted are fetches attempted (page fetch, then
 * background bypass) to obtain a clean copy.
 */
function buildCroppedImage(img, url, cropRect, preferredFormat, corsClean) {
  const { mimeType, extension, quality } = getImageCropFormat(
    url,
    preferredFormat,
  );

  const render = (source) => {
    const width = Math.max(1, source.naturalWidth);
    const height = Math.max(1, source.naturalHeight);
    const x = Math.round(cropRect.x * width);
    const y = Math.round(cropRect.y * height);
    const cropW = Math.max(
      1,
      Math.min(width - x, Math.round(cropRect.w * width)),
    );
    const cropH = Math.max(
      1,
      Math.min(height - y, Math.round(cropRect.h * height)),
    );

    const canvas = document.createElement("canvas");
    canvas.width = cropW;
    canvas.height = cropH;
    const context = canvas.getContext("2d");
    context.drawImage(source, x, y, cropW, cropH, 0, 0, cropW, cropH);

    return new Promise((resolve, reject) => {
      try {
        canvas.toBlob((blob) => {
          if (!blob) {
            reject(new Error("Cropped image could not be encoded."));
            return;
          }
          resolve({
            blob,
            filename: getCropFilename(url, extension),
            width: cropW,
            height: cropH,
          });
        }, mimeType, quality);
      } catch (error) {
        reject(
          new Error(
            "Protected (CORS) image cannot be re-read for cropping.",
          ),
        );
      }
    });
  };

  if (corsClean) return render(img);

  return Promise.resolve()
    .then(() => fetchImageBlob(url))
    .catch(() => fetchImageBlobViaBackground(url))
    .then((blob) => (blob ? loadImageFromBlob(blob) : null))
    .then((source) => {
      if (source) {
        try {
          return render(source.image);
        } finally {
          URL.revokeObjectURL(source.url);
        }
      }
      return render(img);
    });
}

/** Get the best resolution image URL from srcset descriptors without measurement. */
function getHighestResolutionImageUrl(img) {
  const candidates = parseSrcset(img.getAttribute("srcset"));
  if (candidates.length > 0) {
    candidates.sort((a, b) => b.score - a.score);
    return new URL(candidates[0].url, document.baseURI).href;
  }
  return img.currentSrc || img.src;
}

/** Find the highest resolution image URL by measuring actual pixel area of candidates. */
async function resolveHighestResolutionImageUrl(img) {
  const candidates = collectImageCandidates(img);
  if (!candidates.length) return getHighestResolutionImageUrl(img);
  if (candidates.length === 1) return candidates[0];

  const measured = await Promise.all(
    candidates.map(async (url) => ({
      url,
      area: await measureImageArea(url),
    })),
  );
  measured.sort((a, b) => b.area - a.area);
  return measured[0]?.area > 0
    ? measured[0].url
    : getHighestResolutionImageUrl(img);
}

/** Collect all candidate URLs for an image (src, srcset, nearby siblings). */
function collectImageCandidates(img) {
  const urls = new Set();
  const addUrl = (value) => {
    if (!value) return;
    try {
      urls.add(new URL(value, document.baseURI).href);
    } catch {}
  };

  addUrl(img.currentSrc);
  addUrl(img.src);
  parseSrcset(img.getAttribute("srcset")).forEach(({ url }) => addUrl(url));

  let sourcePath = "";
  try {
    sourcePath = new URL(img.currentSrc || img.src).pathname;
  } catch {
    return Array.from(urls);
  }

  const container =
    img.closest("article, [role='dialog']") || img.parentElement;
  container?.querySelectorAll("img").forEach((candidate) => {
    const values = [candidate.currentSrc, candidate.src];
    parseSrcset(candidate.getAttribute("srcset")).forEach(({ url }) =>
      values.push(url),
    );
    values.forEach((value) => {
      try {
        const url = new URL(value, document.baseURI);
        if (url.pathname === sourcePath) addUrl(url.href);
      } catch {}
    });
  });

  Array.from(urls).forEach((value) => {
    const url = new URL(value);
    if (!url.hostname.includes("cdninstagram.com")) return;

    const withoutTransform = new URL(url);
    withoutTransform.searchParams.delete("stp");
    urls.add(withoutTransform.href);

    const originalCandidate = new URL(withoutTransform);
    originalCandidate.searchParams.delete("efg");
    urls.add(originalCandidate.href);
  });

  return Array.from(urls);
}

/** Measure the pixel area of an image by loading it in an off-screen probe. */
function measureImageArea(url) {
  return new Promise((resolve) => {
    const probe = new Image();
    let settled = false;
    const finish = (area) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        probe.onload = null;
        probe.onerror = null;
        probe.src = "";
        resolve(area);
      }
    };
    const timeout = setTimeout(() => finish(0), 5000);
    probe.onload = () => finish(probe.naturalWidth * probe.naturalHeight);
    probe.onerror = () => finish(0);
    probe.src = url;
  });
}

/** Measure the pixel dimensions of a video by probing its metadata. */
function measureVideoDimensions(url) {
  return new Promise((resolve) => {
    const probe = document.createElement("video");
    probe.preload = "metadata";
    probe.muted = true;
    probe.playsInline = true;
    probe.crossOrigin = "anonymous";
    let settled = false;
    const finish = (w, h) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      probe.onloadeddata = null;
      probe.onloadedmetadata = null;
      probe.onerror = null;
      probe.removeAttribute("src");
      probe.load();
      resolve(w > 0 && h > 0 ? { width: w, height: h } : null);
    };
    const timeout = setTimeout(() => finish(0, 0), 15000);
    probe.onloadeddata = () => finish(probe.videoWidth, probe.videoHeight);
    probe.onloadedmetadata = () => {
      if (probe.videoWidth > 0 && probe.videoHeight > 0) {
        finish(probe.videoWidth, probe.videoHeight);
      }
    };
    probe.onerror = () => finish(0, 0);
    probe.src = url;
    probe.load();
  });
}

/** Measure the pixel area of a video by probing its metadata. */
function measureVideoResolution(url) {
  return measureVideoDimensions(url).then(
    (dims) => (dims ? dims.width * dims.height : 0),
  );
}

/** Get the currently active source URL from a video element. */
function getVideoUrl(video) {
  if (video.currentSrc) return video.currentSrc;
  if (video.src) return video.src;

  const source = Array.from(video.querySelectorAll("source[src]")).find(
    (item) => item.src,
  );
  return source ? source.src : "";
}

/** Find the highest quality video source URL among all candidates. */
async function resolveHighestResolutionVideoUrl(video) {
  const candidates = collectVideoCandidates(video);
  if (candidates.length === 0) return getVideoUrl(video);
  if (candidates.length === 1) return candidates[0].url;

  const measured = await Promise.all(
    candidates.map(async ({ url }) => ({
      url,
      pixels: await measureVideoResolution(url),
    })),
  );
  const best = measured.reduce((a, b) => (a.pixels >= b.pixels ? a : b));
  return best.pixels > 0
    ? best.url
    : candidates.sort((a, b) => b.score - a.score)[0].url;
}

/** Collect all non-blob source URLs from a video and its source elements. */
function collectVideoCandidates(video) {
  const seen = new Map();

  const add = (url, source) => {
    if (!url || url.startsWith("blob:") || seen.has(url)) return;
    seen.set(url, source);
  };

  add(video.currentSrc, null);
  add(video.src, null);

  video.querySelectorAll("source").forEach((el) => {
    if (el.src) add(el.src, el);
  });

  return Array.from(seen.entries()).map(([url, source]) => ({
    url,
    score: scoreVideoSource(url, source),
  }));
}

/** Score a video source URL by resolution hints (media queries, labels, dimensions). */
function scoreVideoSource(url, source) {
  let score = 1;

  if (source) {
    const media = source.getAttribute("media") || "";
    const mw = media.match(/min-width\s*:\s*(\d+)/);
    if (mw) score = Math.max(score, parseInt(mw[1], 10));
    const mh = media.match(/min-height\s*:\s*(\d+)/);
    if (mh) score = Math.max(score, parseInt(mh[1], 10));
  }

  const res = url.match(/(\d{3,4})p/i);
  if (res) score = Math.max(score, parseInt(res[1], 10) * 1.78);

  const dims = url.match(/(\d{3,4})x(\d{3,4})/);
  if (dims) score = Math.max(score, parseInt(dims[1], 10));

  return score;
}

/** Parse an HTML srcset string into URL/score candidates. */
function parseSrcset(srcset) {
  if (!srcset) return [];

  return srcset
    .split(",")
    .map((candidate) => {
      const parts = candidate.trim().split(/\s+/);
      const descriptor = parts[parts.length - 1];
      const match = descriptor.match(/^(\d+(?:\.\d+)?)(w|x)$/);
      return {
        url: match ? parts.slice(0, -1).join(" ") : parts.join(" "),
        score: match ? Number(match[1]) : 1,
      };
    })
    .filter((candidate) => candidate.url);
}

/** Download the highest resolution version of an image or video. */
async function downloadMedia(media, preferredUrl) {
  const src =
    preferredUrl ||
    (media.tagName === "IMG"
      ? await resolveHighestResolutionImageUrl(media)
      : await resolveHighestResolutionVideoUrl(media));
  if (!src) {
    console.error("Media has no source.");
    return;
  }

  if (media.tagName === "VIDEO" && src.startsWith("blob:")) {
    await streamBlobVideo(media, src);
    return;
  }

  if (media.tagName === "VIDEO" && isTelegramProgressiveUrl(src)) {
    streamPageVideo(media, src);
    return;
  }

  chrome.runtime.sendMessage(
    {
      action: "download",
      url: src,
      mediaType: media.tagName === "VIDEO" ? "video" : "image",
      folder: settings.downloadFolder,
      saveAs: settings.showSaveAs,
    },
    (response) => {
      if (chrome.runtime.lastError) {
        console.error("Download failed:", chrome.runtime.lastError.message);
        showToast(`Download failed: ${chrome.runtime.lastError.message}`);
        return;
      }
      if (!response?.ok) {
        console.error("Download failed:", response?.error || "Unknown error");
        showToast(response?.error || "Download failed.");
        return;
      }
      showToast(
        media.tagName === "VIDEO"
          ? "Video download started."
          : "Image download started.",
      );
    },
  );
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

/** Download a page-owned media URL through the page's Service Worker. */
function streamPageVideo(video, url) {
  const detail = {
    url,
    filename: getSuggestedVideoName(video),
    videoId: video.dataset.imdCaptureId,
  };
  canceledBlobJobs.delete(detail.videoId);
  blobDownloadRequests.set(detail.videoId, detail);
  blobJobIntent.set(detail.videoId, "download");
  showToast("Video download started.");
  sendBlobStoreMessage({
    action: "job-start",
    jobId: detail.videoId,
    filename: detail.filename,
    folder: settings.downloadFolder,
    saveAs: settings.showSaveAs,
  });
  window.dispatchEvent(
    new CustomEvent(PAGE_MEDIA_DOWNLOAD_EVENT, {
      detail,
    }),
  );
}

/** Start streaming a blob video for download via the media bridge. */
function streamBlobVideo(video, url) {
  const detail = {
    url,
    filename: getSuggestedVideoName(video),
    videoId: video.dataset.imdCaptureId,
  };
  canceledBlobJobs.delete(detail.videoId);
  blobDownloadRequests.set(detail.videoId, detail);
  blobJobIntent.set(detail.videoId, "download");
  showToast("Video download started.");
  sendBlobStoreMessage({
    action: "job-start",
    jobId: detail.videoId,
    filename: detail.filename,
    folder: settings.downloadFolder,
    saveAs: settings.showSaveAs,
  });
  window.dispatchEvent(
    new CustomEvent(BLOB_DOWNLOAD_EVENT, {
      detail,
    }),
  );
}

/** Start recording a video segment from the current playback position. */
function startTrimRecording(video) {
  if (
    typeof video.captureStream !== "function" ||
    typeof MediaRecorder === "undefined"
  ) {
    throw new Error("This browser does not support video recording.");
  }

  const stream = video.captureStream();
  if (!stream.getVideoTracks().length) {
    throw new Error("The video has no capturable video track.");
  }

  const mimeType = [
    "video/mp4;codecs=hvc1.2.4.L150.90,mp4a.40.2",
    "video/mp4;codecs=hev1.2.4.L150.90,mp4a.40.2",
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4;codecs=avc1.64003E,mp4a.40.2",
    "video/mp4",
  ].find((t) => MediaRecorder.isTypeSupported(t));
  if (!mimeType) {
    throw new Error("No supported recording MIME type found.");
  }

  const pixels = (video.videoWidth || 1920) * (video.videoHeight || 1080);
  const bitrate =
    pixels >= 3840 * 2160
      ? 30_000_000
      : pixels >= 2560 * 1440
        ? 20_000_000
        : pixels >= 1920 * 1080
          ? 12_000_000
          : 8_000_000;

  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: bitrate,
    audioBitsPerSecond: 128_000,
  });

  const startTime = video.currentTime;
  const chunks = [];
  let rejectPromise = null;

  recorder.addEventListener("dataavailable", (e) => {
    if (e.data.size) chunks.push(e.data);
  });

  const promise = new Promise((resolve, reject) => {
    rejectPromise = reject;
    recorder.addEventListener("stop", () => {
      const blob = new Blob(chunks, { type: recorder.mimeType });
      resolve(blob);
    });
    recorder.addEventListener(
      "error",
      () =>
        reject(
          recorder.error ||
            new DOMException("Recording failed", "MediaRecorderError"),
        ),
      { once: true },
    );
  });

  if (video.paused) {
    video.play().catch(() => {});
  }

  recorder.start(1000);

  const endCheck = () => {
    if (video.currentTime >= video.duration - 0.15) {
      if (recorder.state !== "inactive") recorder.stop();
    }
  };
  video.addEventListener("timeupdate", endCheck, { passive: true });

  return {
    startTime,
    promise,
    save: () => {
      video.removeEventListener("timeupdate", endCheck);
      if (recorder.state !== "inactive") recorder.stop();
    },
    cancel: () => {
      video.removeEventListener("timeupdate", endCheck);
      if (recorder.state !== "inactive") {
        recorder.removeEventListener("stop", () => {});
        recorder.stop();
        rejectPromise?.(new Error("Recording cancelled."));
      }
    },
  };
}

/**
 * Capture the current video frame and return both a blob URL (for downloads,
 * previews and the clipboard) and a data URL (for reliable in-page display).
 */
async function captureVideoFrame(video) {
  const blob = await captureVideoFrameBlobWithFallbacks(video);
  const blobUrl = URL.createObjectURL(blob);
  try {
    return { blobUrl, dataUrl: await blobToDataUrl(blob) };
  } catch (error) {
    return { blobUrl, dataUrl: blobUrl };
  }
}

/** Convert a Blob into a data: URL string (FileReader-based). */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () =>
      reject(reader.error || new Error("Blob read failed."));
    reader.readAsDataURL(blob);
  });
}

/**
 * Capture the current video frame as an encoded image blob, trying harder
 * sources in order until one succeeds:
 *   1. draw the live element directly onto a canvas,
 *   2. re-load the plain source URL with CORS enabled,
 *   3. rebuild the stream from the MediaSource segments recorded by the bridge,
 *   4. screenshot the visible tab and crop the video element rect.
 */
async function captureVideoFrameBlobWithFallbacks(
  video,
  captureType = settings.captureType,
) {
  try {
    return await captureVideoFrameBlob(video, captureType);
  } catch (error) {
    console.warn("[Media Downloader] Direct frame capture failed:", error);
    const sourceUrl = getVideoUrl(video);
    if (sourceUrl && !sourceUrl.startsWith("blob:") && !sourceUrl.startsWith("data:")) {
      return await captureVideoFrameFromSource(video, captureType);
    }
    const mseBlob = await requestMediaSourceBlob(sourceUrl);
    if (mseBlob && mseBlob.size) {
      try {
        return await captureFrameFromMediaProbe(video, mseBlob, captureType);
      } catch (probeError) {
        console.warn(
          "[Media Downloader] MediaSource rebuild capture failed:",
          probeError,
        );
      }
    }
    return await captureVideoFrameFromTab(video);
  }
}

/** Capture the current video frame as an encoded image blob. */
async function captureVideoFrameBlob(video, captureType = settings.captureType) {
  if (
    !Number.isFinite(video.videoWidth) ||
    !video.videoWidth ||
    !Number.isFinite(video.videoHeight) ||
    !video.videoHeight
  ) {
    const ready = await waitForVideoMetadata(video);
    if (!ready) throw new Error("Video frame is not ready.");
  }
  window.dispatchEvent(
    new CustomEvent(CAPTURE_BLOCK_EVENT, { detail: { video } }),
  );
  const wasPlaying = !video.paused;
  try {
    // First pass grabs the live presented frame (never paused, so the decoder
    // keeps painting). If the frame is empty (paused streams often drop their
    // decoded frame), fall back to seeking in place to force a new decode.
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt === 0 && wasPlaying) {
          await waitForNextPresentedFrame(video);
        } else {
          await ensurePresentedFrame(video, attempt > 0);
        }
        const blob = await drawVideoFrameToBlob(video, captureType);
        if (wasPlaying) video.pause();
        return blob;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("Video frame capture failed.");
  } finally {
    window.dispatchEvent(
      new CustomEvent(CAPTURE_UNBLOCK_EVENT, { detail: { video } }),
    );
  }
}

/** Wait until the element presents its next rendered frame (if it is playing). */
function waitForNextPresentedFrame(video, timeout = 1500) {
  return new Promise((resolve) => {
    if (typeof video.requestVideoFrameCallback !== "function") {
      resolve();
      return;
    }
    let callbackId;
    const timer = setTimeout(() => {
      video.cancelVideoFrameCallback?.(callbackId);
      resolve();
    }, timeout);
    callbackId = video.requestVideoFrameCallback(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Draw the video's current frame onto a fresh canvas and encode it. */
async function drawVideoFrameToBlob(video, captureType = settings.captureType) {
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const isHdr =
    video.videoColorSpace &&
    (video.videoColorSpace.transfer === "pq" ||
      video.videoColorSpace.transfer === "hlg");
  const contextOptions =
    isHdr &&
    "display-p3" in (window.CanvasRenderingContext2D?.prototype || {})
      ? { colorSpace: "display-p3" }
      : undefined;
  const context = canvas.getContext("2d", contextOptions);
  if (!context) throw new Error("Canvas is unavailable.");
  // HDR frames are tone-mapped to SDR by the canvas; draw at native
  // resolution and disable smoothing so the captured pixels stay as close to
  // the source as the canvas can represent.
  context.imageSmoothingEnabled = false;
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  // A tainted canvas throws later in toBlob; a streamed video that did not
  // decode its frame yet renders transparent or plain black, so treat those
  // as a miss and let the caller retry.
  if (isCanvasBlank(context, canvas.width, canvas.height)) {
    throw new Error("Video frame is not decoded yet.");
  }
  const format = getFrameCaptureFormat(captureType);
  return await new Promise((resolve, reject) => {
    try {
      canvas.toBlob(
        (result) =>
          result
            ? resolve(result)
            : reject(new Error("Frame encoding failed.")),
        format.mimeType,
        format.quality,
      );
    } catch (error) {
      reject(error);
    }
  });
}

/** Wait until the video element has dimensions (metadata) or times out. */
function waitForVideoMetadata(video, timeout = 2500) {
  if (video.videoWidth > 0 && video.videoHeight > 0) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener("loadedmetadata", onMetadata);
      clearTimeout(timer);
      resolve(video.videoWidth > 0 && video.videoHeight > 0);
    };
    const onMetadata = () => finish();
    const timer = setTimeout(finish, timeout);
    video.addEventListener("loadedmetadata", onMetadata);
  });
}

/**
 * Make sure the element has a decoded frame at the current position before a
 * canvas draw. With force=true it always seeks in place, which forces the
 * decoder to re-decode the frame (paused streams drop their frame otherwise).
 */
function ensurePresentedFrame(video, force = false, timeout = 2000) {
  if (!force && video.readyState >= 2) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      clearTimeout(timer);
      resolve();
    };
    const onSeeked = () => cleanup();
    const onError = () => cleanup();
    const timer = setTimeout(cleanup, timeout);
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const target = Math.min(
      Math.max(video.currentTime || 0, 0),
      Math.max(duration - 0.01, 0),
    );
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    try {
      video.currentTime = target;
    } catch {
      cleanup();
    }
  });
}

/**
 * Detect a canvas holding no usable frame: fully transparent (undecoded
 * stream) or plain black (paused element whose decoder dropped the frame).
 */
function isCanvasBlank(context, width, height) {
  try {
    const points = [
      [0, 0],
      [width >> 1, 0],
      [width - 1, 0],
      [0, height >> 1],
      [width >> 1, height >> 1],
      [width - 1, height >> 1],
      [0, height - 1],
      [width >> 1, height - 1],
      [width - 1, height - 1],
    ];
    for (const [x, y] of points) {
      const { data } = context.getImageData(x, y, 1, 1);
      if (data[3] === 0) continue;
      if (data[0] || data[1] || data[2]) return false;
    }
    return true;
  } catch {
    // Tainted canvas: not blank, but unusable for encoding.
    return false;
  }
}

/**
 * Load a rebuilt media blob (recorded MediaSource segments) into an offscreen
 * probe, seek to the video's current time and capture that frame.
 */
async function captureFrameFromMediaProbe(
  video,
  mediaBlob,
  captureType = settings.captureType,
) {
  const blobUrl = URL.createObjectURL(mediaBlob);
  try {
    const blob = await new Promise((resolve, reject) => {
      const probe = document.createElement("video");
      probe.muted = true;
      probe.playsInline = true;
      probe.preload = "auto";
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        probe.removeAttribute("src");
        probe.load();
        probe.remove();
        if (error) reject(error);
        else resolve(result);
      };
      probe.onloadedmetadata = () => {
        const duration = Number.isFinite(probe.duration)
          ? probe.duration
          : Infinity;
        const target = Math.min(
          Math.max(video.currentTime || 0, 0),
          Math.max(duration - 0.01, 0),
        );
        try {
          probe.currentTime = target;
        } catch (error) {
          finish(error);
        }
      };
      probe.onseeked = () => {
        const tryCapture = (attempt) => {
          try {
            const canvas = document.createElement("canvas");
            canvas.width = probe.videoWidth;
            canvas.height = probe.videoHeight;
            const context = canvas.getContext("2d");
            if (!context) throw new Error("Canvas is unavailable.");
            context.imageSmoothingEnabled = false;
            context.drawImage(probe, 0, 0);
            if (attempt < 3 && isCanvasBlank(context, canvas.width, canvas.height)) {
              setTimeout(() => tryCapture(attempt + 1), 120);
              return;
            }
            if (isCanvasBlank(context, canvas.width, canvas.height)) {
              throw new Error("Rebuilt media frame is not decoded.");
            }
            const format = getFrameCaptureFormat(captureType);
            canvas.toBlob(
              (result) =>
                result
                  ? finish(null, result)
                  : finish(new Error("Frame encoding failed.")),
              format.mimeType,
              format.quality,
            );
          } catch (error) {
            finish(error);
          }
        };
        tryCapture(0);
      };
      probe.onerror = () =>
        finish(new Error("Rebuilt media could not be loaded."));
      probe.src = blobUrl;
      probe.load();
    });
    return blob;
  } finally {
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  }
}

/**
 * Last-resort capture: screenshot the visible tab through the background
 * service worker and crop the video element's bounding rect from it.
 */
function captureVideoFrameFromTab(video) {
  return new Promise((resolve, reject) => {
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
      reject(new Error("Tab screenshot is unavailable."));
      return;
    }
    const actionGroups = Array.from(
      document.querySelectorAll(".imd-action-group"),
    );
    const previousDisplays = actionGroups.map(
      (group) => group.style.display,
    );
    actionGroups.forEach((group) => {
      group.style.display = "none";
    });
    const restore = () => {
      actionGroups.forEach((group, index) => {
        group.style.display = previousDisplays[index];
      });
    };
    chrome.runtime.sendMessage({ action: "captureTab" }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        restore();
        reject(
          new Error(
            chrome.runtime.lastError?.message || "Tab screenshot failed.",
          ),
        );
        return;
      }
      const rect = video.getBoundingClientRect();
      if (!rect.width || !rect.height) {
        restore();
        reject(new Error("Video is not visible on screen."));
        return;
      }
      const image = new Image();
      let attempts = 0;
      const cropAndResolve = () => {
        const dpr = Math.max(window.devicePixelRatio || 1, 1);
        const sx = Math.max(0, Math.round(rect.left * dpr));
        const sy = Math.max(0, Math.round(rect.top * dpr));
        const width = Math.max(
          1,
          Math.min(Math.round(rect.width * dpr), image.naturalWidth - sx),
        );
        const height = Math.max(
          1,
          Math.min(Math.round(rect.height * dpr), image.naturalHeight - sy),
        );
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        context.imageSmoothingEnabled = false;
        context.drawImage(image, sx, sy, width, height, 0, 0, width, height);
        // The player may cover a paused video with a poster overlay that is
        // still loading; retry once before giving up on the crop.
        if (attempts < 1 && isCanvasBlank(context, width, height)) {
          attempts += 1;
          setTimeout(cropAndResolve, 200);
          return;
        }
        if (isCanvasBlank(context, width, height)) {
          reject(new Error("Captured screen area is empty."));
          return;
        }
        canvas.toBlob(
          (blob) =>
            blob
              ? resolve(blob)
              : reject(new Error("Frame encoding failed.")),
          "image/png",
        );
      };
      image.onload = () => {
        restore();
        cropAndResolve();
      };
      image.onerror = () => {
        restore();
        reject(new Error("Screenshot decode failed."));
      };
      image.src = response.dataUrl;
    });
  });
}

/** Toggle Picture-in-Picture mode for a video element. */
function togglePictureInPicture(video) {
  if (document.pictureInPictureElement === video) {
    document
      .exitPictureInPicture()
      .then(() => showToast("Picture-in-Picture closed."))
      .catch((error) => {
        console.error(error);
        showToast("Failed to close Picture-in-Picture.");
      });
  } else {
    video
      .requestPictureInPicture()
      .then(() => showToast("Picture-in-Picture enabled."))
      .catch((error) => {
        console.error(error);
        showToast("Picture-in-Picture is not available.");
      });
  }
}

/** Generate a suggested filename for a video from its source URL. */
function getSuggestedVideoName(video) {
  const source = video.currentSrc || video.src;
  if (source && !source.startsWith("blob:")) {
    try {
      const pathname = new URL(source, document.baseURI).pathname;
      const filename = decodeURIComponent(pathname.split("/").pop() || "");
      if (filename) return filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    } catch {}
  }

  return `video-${Date.now()}.mp4`;
}

/** Start or stop a trim recording for a video (used by button and context menu). */
function triggerTrim(media, trimBtn) {
  const recording = videoTrimRecordings.get(media);
  if (recording) {
    recording.save();
    return;
  }

  const isBlob = getVideoUrl(media).startsWith("blob:");
  if (isBlob) {
    if (trimBtn && trimBtn.dataset.recording === "true") {
      window.dispatchEvent(
        new CustomEvent(BLOB_CONTROL_EVENT, {
          detail: { videoId: media.dataset.imdCaptureId, action: "save" },
        }),
      );
    } else {
      canceledBlobJobs.delete(media.dataset.imdCaptureId);
      if (trimBtn) {
        trimBtn.dataset.recording = "true";
        trimBtn.title = "Save trim";
        trimBtn.innerHTML = STOP_ICON;
      }
      sendBlobStoreMessage({
        action: "job-start",
        jobId: media.dataset.imdCaptureId,
        filename: getSuggestedVideoName(media),
        folder: settings.downloadFolder,
        saveAs: settings.showSaveAs,
      });
      blobJobIntent.set(media.dataset.imdCaptureId, "trim");
      showToast("Trim recording started.");
      window.dispatchEvent(
        new CustomEvent(BLOB_TRIM_EVENT, {
          detail: {
            url: getVideoUrl(media),
            filename: getSuggestedVideoName(media),
            videoId: media.dataset.imdCaptureId,
            startTime: media.currentTime,
          },
        }),
      );
    }
    return;
  }

  if (trimBtn) trimBtn.disabled = true;
  let rec;
  try {
    rec = startTrimRecording(media);
  } catch (error) {
    console.error("Trim recording failed:", error);
    if (trimBtn) trimBtn.disabled = false;
    showToast("Trim recording failed.");
    return;
  }

  videoTrimRecordings.set(media, rec);
  showToast("Trim recording started.");
  if (trimBtn) {
    trimBtn.title = "Save trim";
    trimBtn.innerHTML = STOP_ICON;
    trimBtn.disabled = false;
  }

  let elapsedTimer = setInterval(() => {
    const elapsed = media.currentTime - rec.startTime;
    if (elapsed > 0 && trimBtn) {
      trimBtn.title = `Save (${elapsed.toFixed(1)}s)`;
    }
  }, 500);

  rec.promise
    .then((blob) => {
      clearInterval(elapsedTimer);
      if (!blob || !blob.size) return;
      const url = URL.createObjectURL(blob);
      const ext = blob.type.includes("webm") ? "webm" : "mp4";
      const filename = getSuggestedVideoName(media).replace(
        /\.[^.]+$/,
        `-trim-${Math.round(rec.startTime)}.${ext}`,
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.hidden = true;
      document.documentElement.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      showToast("Trim saved.");
    })
    .catch((error) => {
      clearInterval(elapsedTimer);
      console.error("Trim recording failed:", error);
      showToast("Trim recording failed.");
    })
    .finally(() => {
      clearInterval(elapsedTimer);
      videoTrimRecordings.delete(media);
      if (trimBtn) {
        trimBtn.title = "Trim from current time";
        trimBtn.innerHTML = TRIM_ICON;
        trimBtn.dataset.recording = "false";
      }
    });
}

/** Find a tracked media element at the given viewport coordinates. */
function findTrackedAncestor(el) {
  let node = el;
  while (node && node !== document.body) {
    if (trackedMedia.has(node)) return node;
    const found = node.querySelector?.("img[data-imd-media-type], video[data-imd-media-type]");
    if (found && trackedMedia.has(found)) return found;
    node = node.parentElement;
  }
  return null;
}

function getMediaAtPoint(x, y) {
  const originals = [];
  for (const [el] of trackedMedia) {
    originals.push([el, el.style.pointerEvents]);
    el.style.pointerEvents = "auto";
  }
  const stack = document.elementsFromPoint(x, y);
  for (let i = originals.length - 1; i >= 0; i--) originals[i][0].style.pointerEvents = originals[i][1];
  for (const el of stack) {
    const found = findTrackedAncestor(el);
    if (found) return found;
  }
  return null;
}

let contextMenuEl = null;
let contextMenuMedia = null;

/** Close and remove the custom right-click menu if it is open. */
function closeContextMenu() {
  if (contextMenuEl) {
    contextMenuEl.remove();
    contextMenuEl = null;
    contextMenuMedia = null;
  }
}

/** Open the custom right-click menu for a media element near the cursor. */
function openContextMenu(media, x, y, linkEl) {
  closeContextMenu();
  const menu = document.createElement("div");
  menu.className = "imd-context-menu";
  menu.setAttribute("role", "menu");
  menu.addEventListener("click", (e) => e.stopPropagation());

  if (linkEl) {
    const openLinkBtn = createActionButton(
      "imd-open-link-btn",
      "Open link in new tab",
      OPEN_LINK_ICON,
    );
    openLinkBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      chrome.runtime.sendMessage(
        { action: "openTab", url: linkEl.href },
        () => {
          if (chrome.runtime.lastError) {
            showToast("Failed to open link.");
            return;
          }
          showToast("Link opened in a new tab.");
        },
      );
      closeContextMenu();
    });
    menu.appendChild(openLinkBtn);
  }

  if (media) {
    const btns = buildMediaActionButtons(media);
    attachMediaActionHandlers(media, btns);
    btns.buttons.forEach((button) => {
      button.addEventListener("click", closeContextMenu);
      menu.appendChild(button);
    });
  }

  const anchor = document.getElementById("MediaViewer")?.open
    ? document.getElementById("MediaViewer")
    : document.body;
  anchor.appendChild(menu);
  contextMenuEl = menu;
  contextMenuMedia = media;

  positionContextMenu(menu, x, y);
  requestAnimationFrame(() => menu.classList.add("imd-context-menu-open"));
}

/**
 * Position a context menu near the cursor, flipping above the menu when it
 * touches the bottom edge.
 */
function positionContextMenu(menu, x, y) {
  const menuRect = menu.getBoundingClientRect();
  const menuHeight = menuRect.height;
  const gap = 12;

  let top = y - menuHeight - gap;
  if (top < 8) top = y + gap;

  const maxX = window.innerWidth - menuRect.width - 8;
  const maxY = window.innerHeight - menuHeight - 8;
  menu.style.left = `${Math.min(Math.max(8, x), Math.max(8, maxX))}px`;
  menu.style.top = `${Math.max(8, Math.min(top, maxY))}px`;
}

function handleContextMenuEvent(event) {
  if (!extensionActive) return;

  const path = event.composedPath();
  let media = null;

  for (const el of path) {
    if (trackedMedia.has(el)) { media = el; break; }
    const found = el.querySelector?.("img[data-imd-media-type], video[data-imd-media-type]");
    if (found && trackedMedia.has(found)) { media = found; break; }
  }

  if (!media) media = getMediaAtPoint(event.clientX, event.clientY);

  if (!media) return;

  event.stopPropagation();

  let linkEl =
    path.find((el) => el.tagName === "A" && el.hasAttribute("href")) ||
    event.target?.closest?.("a[href]");
  if (!linkEl) {
    let node = media;
    while (node && node !== document.body) {
      if (node.tagName === "A" && node.hasAttribute("href")) {
        linkEl = node;
        break;
      }
      node = node.parentElement || node.getRootNode()?.host;
    }
  }

  openContextMenu(media, event.clientX, event.clientY, linkEl);
}

document.addEventListener("contextmenu", handleContextMenuEvent, true);

const dialogObserver = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== 1) continue;
      const dialogs = node.tagName === "DIALOG"
        ? [node]
        : [...(node.querySelectorAll?.("dialog") ?? [])];
      for (const dialog of dialogs) {
        if (!dialog.dataset.imdCtxMenu) {
          dialog.dataset.imdCtxMenu = "true";
          dialog.addEventListener("contextmenu", handleContextMenuEvent, true);
        }
      }
    }
  }
});
if (document.body) {
  dialogObserver.observe(document.body, { childList: true, subtree: true });
}

document.addEventListener("pointerdown", (event) => {
  if (contextMenuEl && !contextMenuEl.contains(event.target)) {
    closeContextMenu();
  }
});
document.addEventListener("click", (event) => {
  if (contextMenuEl && !contextMenuEl.contains(event.target)) {
    closeContextMenu();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeContextMenu();
});
window.addEventListener("blur", closeContextMenu);
window.addEventListener("scroll", closeContextMenu, true);
window.addEventListener("resize", closeContextMenu);

window.addEventListener(BLOB_STATUS_EVENT, (event) => {
  if (!contextMenuEl || !contextMenuMedia) return;
  const { videoId, status } = event.detail || {};
  if (contextMenuMedia.dataset.imdCaptureId !== videoId) return;
  const downBtns = contextMenuEl.querySelectorAll(".imd-down-btn");
  const trimBtns = contextMenuEl.querySelectorAll(".imd-trim-btn");
  const isActive = ACTIVE_DOWNLOAD_STATES.has(status);
  downBtns.forEach((button) => {
    button.title = isActive ? "Video download in progress" : "Download Video";
    button.setAttribute("aria-label", button.title);
    button.classList.toggle("imd-recording", isActive);
    button.disabled = isActive;
  });
  trimBtns.forEach((button) => {
    const recording = status === "recording" || status === "progress";
    if (status === "complete" || status === "error" || status === "canceled") {
      button.title = "Trim from current time";
      button.innerHTML = TRIM_ICON;
    } else if (recording) {
      button.title = "Save trim";
      button.innerHTML = STOP_ICON;
    }
  });
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
