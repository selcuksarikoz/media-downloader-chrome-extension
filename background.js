const FETCH_PORT = "imd-fetch-media";
const BLOB_STORE_PORT = "imd-blob-store";

const DB_NAME = "imd-blob-store";
const DB_VERSION = 1;
const META_STORE = "jobs";
const CHUNK_STORE = "chunks";

const portJobSets = new Map();
const activeBlobUrls = new Map();
const activePreparedDownloads = new Map();

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install" || details.reason === "update") {
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message.url) return;
  if (message.action === "downloadMuxUrl") {
    downloadPreparedUrl(message, sender.tab?.id)
      .then((downloadId) => sendResponse({ ok: true, downloadId }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.action === "download") {
    downloadMedia(message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.action === "preview") {
    openPreviewTab(message.url, sender.tab?.id)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.action === "openTab") {
    chrome.tabs.create({ url: message.url, active: false });
    return;
  }
  if (message.action === "captureTab") {
    chrome.tabs.captureVisibleTab(
      sender.tab?.windowId,
      { format: "png" },
      (dataUrl) => {
        if (chrome.runtime.lastError || !dataUrl) {
          sendResponse({
            ok: false,
            error: chrome.runtime.lastError?.message || "Tab capture failed.",
          });
          return;
        }
        sendResponse({ ok: true, dataUrl });
      },
    );
    return true;
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === FETCH_PORT) {
    handleFetchPort(port);
  } else if (port.name === BLOB_STORE_PORT) {
    handleBlobStorePort(port);
  }
});

// ---------------------------------------------------------------------------
// Zero-copy media fetch (Port + ArrayBuffer transfer)
// ---------------------------------------------------------------------------

function handleFetchPort(port) {
  port.onMessage.addListener((message) => {
    if (message?.action !== "fetchMedia" || typeof message.url !== "string") {
      return;
    }
    fetchMedia(message.url)
      .then(({ mimeType, data }) => {
        port.postMessage({ ok: true, mimeType, data }, [data]);
      })
      .catch((error) => {
        try {
          port.postMessage({ ok: false, error: error.message });
        } catch {}
      });
  });
}

async function fetchMedia(url) {
  if (url.startsWith("blob:") || url.startsWith("data:")) {
    throw new Error("Page-local media cannot be fetched from the background.");
  }
  const response = await fetch(url, {
    credentials: "include",
    redirect: "follow",
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Fetch failed (${response.status}).`);
  const data = await response.arrayBuffer();
  const mimeType = response.headers.get("Content-Type") || "";
  return { mimeType, data };
}

// ---------------------------------------------------------------------------
// Blob download persistence (survives tab close via IndexedDB)
// ---------------------------------------------------------------------------

function handleBlobStorePort(port) {
  const jobIds = new Set();
  portJobSets.set(port, jobIds);
  port.onMessage.addListener((message) => {
    if (message?.jobId) jobIds.add(message.jobId);
    handleStoreMessage(message)
      .then(() => {
        if (message?.requestId) {
          port.postMessage({ requestId: message.requestId, ok: true });
        }
      })
      .catch((error) => {
        if (message?.requestId) {
          port.postMessage({
            requestId: message.requestId,
            ok: false,
            error: error.message,
          });
        }
      });
  });
  port.onDisconnect.addListener(() => {
    portJobSets.delete(port);
    finalizeInterruptedJobs(jobIds);
  });
}

const jobQueues = new Map();

function handleStoreMessage(message) {
  if (!message?.jobId) return Promise.resolve();
  const jobId = message.jobId;
  const previous = jobQueues.get(jobId) || Promise.resolve();
  const next = previous.then(() => handleStoreMessageNow(message));
  const chained = next.catch(() => {});
  jobQueues.set(jobId, chained);
  chained.finally(() => {
    if (jobQueues.get(jobId) === chained) jobQueues.delete(jobId);
  });
  return next;
}

async function handleStoreMessageNow(message) {
  const { jobId } = message;
  if (message.action === "job-start") {
    const meta = (await getJobMeta(jobId)) || {};
    await putJobMeta({
      jobId,
      filename: message.filename || meta.filename || "",
      folder: message.folder || meta.folder || "",
      saveAs: message.saveAs === true || meta.saveAs === true,
      status: "recording",
      seq: meta.seq || 0,
      finalBlob: meta.finalBlob || null,
    });
  } else if (message.action === "chunk") {
    await appendChunk(jobId, message.blob);
  } else if (message.action === "finalize") {
    const meta = await getJobMeta(jobId);
    // job-start always precedes finalize on the same port. Missing/canceled
    // metadata means cancellation won the race, so a late final blob must be
    // discarded instead of opening a save dialog.
    if (!meta || meta.status !== "recording") return;
    await putJobMeta({
      jobId,
      filename: message.filename || meta.filename || "",
      folder: message.folder || meta.folder || "",
      saveAs: message.saveAs === true || meta.saveAs === true,
      status: "done",
      seq: meta.seq || 0,
      finalBlob: message.blob,
    });
    await downloadJob(jobId);
  } else if (message.action === "cancel") {
    await cancelJob(jobId);
  }
}

function finalizeInterruptedJobs(jobIds) {
  (async () => {
    const metas = jobIds
      ? []
      : await getAllJobMetas();
    const targets = jobIds
      ? jobIds
      : new Set(metas.map((meta) => meta.jobId));
    for (const jobId of targets) {
      const meta = await getJobMeta(jobId);
      if (!meta) continue;
      if (meta.status === "canceled") {
        if (Date.now() - (meta.updatedAt || 0) > 24 * 60 * 60 * 1000) {
          await deleteJob(jobId);
        }
        continue;
      }
      if (meta.status !== "recording") continue;
      // Safety net: never keep abandoned data around forever.
      if (Date.now() - (meta.updatedAt || 0) > 24 * 60 * 60 * 1000) {
        await deleteJob(jobId);
        continue;
      }
      const chunks = await getAllChunks(jobId);
      if (!meta.finalBlob && !chunks.length) {
        await deleteJob(jobId);
        continue;
      }
      await downloadJob(jobId);
    }
  })().catch((error) => {
    console.error("[Media Downloader] Finalize interrupted jobs failed:", error);
  });
}

async function downloadJob(jobId) {
  const meta = await getJobMeta(jobId);
  if (!meta) return;
  const fromChunks = !meta.finalBlob;
  const blob = meta.finalBlob || (await buildBlobFromChunks(jobId));
  if (!blob) return;

  let filename = buildFilename(meta);
  if (fromChunks) {
    filename = replaceExtension(
      filename,
      blob.type.includes("webm") ? "webm" : "mp4",
    );
  }

  let url;
  let isObjectUrl = false;
  try {
    const created = await createDownloadableUrl(blob);
    url = created.url;
    isObjectUrl = created.isObjectUrl;
  } catch (error) {
    // A job that cannot be turned into a download URL must never linger:
    // drop it so it stops being retried on every service worker start.
    await deleteJob(jobId);
    throw error;
  }

  let downloadId;
  try {
    downloadId = await new Promise((resolve, reject) => {
      chrome.downloads.download(
        {
          url,
          filename,
          saveAs: !filename.includes("/") && meta.saveAs === true,
          conflictAction: "overwrite",
        },
        (id) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(id);
        },
      );
    });
  } catch (error) {
    console.error("[Media Downloader] Blob download failed:", error);
    if (isObjectUrl) URL.revokeObjectURL(url);
    await deleteJob(jobId);
    return;
  }

  activeBlobUrls.set(downloadId, { jobId, url, isObjectUrl });
  // The download is now owned by the browser (the object URL keeps the blob
  // alive). Drop the IndexedDB copy immediately so a completed or interrupted
  // download can never leave a stale job behind, even across service worker
  // restarts.
  await deleteJob(jobId);
}

/**
 * Service workers have no URL.createObjectURL. Prefer object URLs when they
 * exist; otherwise encode the blob as a data: URL with FileReader so the
 * download can still start from the service worker.
 */
function createDownloadableUrl(blob) {
  if (typeof URL.createObjectURL === "function") {
    return Promise.resolve({ url: URL.createObjectURL(blob), isObjectUrl: true });
  }
  if (blob.size > 512 * 1024 * 1024) {
    return Promise.reject(
      new Error(
        "Blob is too large to encode inside the background worker; " +
          "keep the tab open and use the page's download fallback.",
      ),
    );
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () =>
      resolve({ url: reader.result, isObjectUrl: false });
    reader.onerror = () =>
      reject(new Error("Blob could not be encoded for download."));
    reader.readAsDataURL(blob);
  });
}

chrome.downloads.onChanged.addListener((delta) => {
  const state = delta.state?.current;
  if (state !== "complete" && state !== "interrupted") return;
  const prepared = activePreparedDownloads.get(delta.id);
  if (prepared) {
    activePreparedDownloads.delete(delta.id);
    if (prepared.tabId) {
      chrome.tabs
        .sendMessage(prepared.tabId, {
          action: "releaseMuxUrl",
          url: prepared.url,
        })
        .catch(() => {});
    }
  }
  const entry = activeBlobUrls.get(delta.id);
  if (!entry) return;
  activeBlobUrls.delete(delta.id);
  if (entry.isObjectUrl !== false) {
    URL.revokeObjectURL(entry.url);
  }
  deleteJob(entry.jobId).catch(() => {});
});

async function buildBlobFromChunks(jobId) {
  const chunks = await getAllChunks(jobId);
  if (!chunks.length) return null;
  return new Blob(chunks.map((chunk) => chunk.blob), {
    type: chunks[0].mimeType || "video/mp4",
  });
}

function buildFilename(meta) {
  let filename =
    meta.filename ||
    `video-${Date.now()}.mp4`;
  const folder = (meta.folder || "").trim().replace(/^[\/\\]+|[\/\\]+$/g, "");
  if (folder && !hasForbiddenFolder(folder)) {
    filename = `${folder}/${filename}`;
  }
  return filename;
}

function replaceExtension(filename, extension) {
  const base = (filename || `video-${Date.now()}`).replace(/\.[^.]+$/, "");
  return `${base}.${extension}`;
}

// ---------------------------------------------------------------------------
// IndexedDB helpers
// ---------------------------------------------------------------------------

let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "jobId" });
      }
      if (!db.objectStoreNames.contains(CHUNK_STORE)) {
        const store = db.createObjectStore(CHUNK_STORE, {
          keyPath: ["jobId", "seq"],
        });
        store.createIndex("jobId", "jobId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function requestResult(request, mode) {
  return new Promise((resolve, reject) => {
    if (mode === "tx") {
      const transaction = request;
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
      return;
    }
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getJobMeta(jobId) {
  const db = await openDb();
  const tx = db.transaction(META_STORE, "readonly");
  const request = tx.objectStore(META_STORE).get(jobId);
  return (await requestResult(request)) || null;
}

async function putJobMeta(meta) {
  const db = await openDb();
  const tx = db.transaction(META_STORE, "readwrite");
  tx.objectStore(META_STORE).put({ ...meta, updatedAt: Date.now() });
  return requestResult(tx, "tx");
}

async function getAllJobMetas() {
  const db = await openDb();
  const tx = db.transaction(META_STORE, "readonly");
  const request = tx.objectStore(META_STORE).getAll();
  return (await requestResult(request)) || [];
}

async function appendChunk(jobId, blob) {
  if (!blob) return;
  let meta = await getJobMeta(jobId);
  if (!meta) {
    meta = {
      jobId,
      filename: "",
      folder: "",
      saveAs: false,
      status: "recording",
      seq: 0,
      finalBlob: null,
      updatedAt: Date.now(),
    };
  }
  if (meta.status !== "recording") return;
  const db = await openDb();
  const tx = db.transaction([META_STORE, CHUNK_STORE], "readwrite");
  tx.objectStore(CHUNK_STORE).put({
    jobId,
    seq: meta.seq,
    blob,
    mimeType: blob.type || "",
  });
  tx.objectStore(META_STORE).put({ ...meta, seq: meta.seq + 1 });
  return requestResult(tx, "tx");
}

async function getAllChunks(jobId) {
  const db = await openDb();
  const tx = db.transaction(CHUNK_STORE, "readonly");
  const index = tx.objectStore(CHUNK_STORE).index("jobId");
  const request = index.getAll(jobId);
  const rows = (await requestResult(request)) || [];
  return rows.sort((a, b) => a.seq - b.seq);
}

async function deleteJob(jobId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([META_STORE, CHUNK_STORE], "readwrite");
    tx.objectStore(META_STORE).delete(jobId);
    const index = tx.objectStore(CHUNK_STORE).index("jobId");
    const cursorRequest = index.openCursor(IDBKeyRange.only(jobId));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * Keep a short-lived cancellation tombstone while removing all captured data.
 * MediaRecorder may send its final chunk after the cancel message; appendChunk
 * will see this status and ignore that late chunk instead of recreating a job.
 */
async function cancelJob(jobId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([META_STORE, CHUNK_STORE], "readwrite");
    tx.objectStore(META_STORE).put({
      jobId,
      filename: "",
      folder: "",
      saveAs: false,
      status: "canceled",
      seq: 0,
      finalBlob: null,
      updatedAt: Date.now(),
    });
    const index = tx.objectStore(CHUNK_STORE).index("jobId");
    const cursorRequest = index.openCursor(IDBKeyRange.only(jobId));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// Recover jobs left behind from a previous service worker session. A live
// content-script port keeps the worker alive, so this only runs while no page
// is currently recording. Delay briefly so a freshly restarted worker does not
// race a page that is reconnecting its port.
setTimeout(() => finalizeInterruptedJobs(null), 5000);

// ---------------------------------------------------------------------------
// Regular (URL) media downloads
// ---------------------------------------------------------------------------

function downloadMedia({ url, folder, saveAs, mediaType }) {
  return new Promise((resolve, reject) => {
    let filename = getFilenameFromUrl(url, mediaType);

    if (typeof folder === "string") {
      folder = folder.trim().replace(/^[\/\\]+|[\/\\]+$/g, "");
      if (folder && !hasForbiddenFolder(folder)) {
        filename = `${folder}/${filename}`;
        saveAs = false;
      }
    }

    chrome.downloads.download(
      {
        url,
        filename,
        saveAs: saveAs === true,
        conflictAction: "overwrite",
      },
      () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      },
    );
  });
}

function downloadPreparedUrl({ url, filename, folder, saveAs }, tabId) {
  return new Promise((resolve, reject) => {
    filename = (filename || `video-${Date.now()}.mp4`).replace(
      /[^a-zA-Z0-9.\-_]/g,
      "_",
    );
    if (typeof folder === "string") {
      folder = folder.trim().replace(/^[\/\\]+|[\/\\]+$/g, "");
      if (folder && !hasForbiddenFolder(folder)) {
        filename = `${folder}/${filename}`;
        saveAs = false;
      }
    }
    chrome.downloads.download(
      {
        url,
        filename,
        saveAs: saveAs === true,
        conflictAction: "overwrite",
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        activePreparedDownloads.set(downloadId, { url, tabId });
        resolve(downloadId);
      },
    );
  });
}

function hasForbiddenFolder(folder) {
  return folder
    .split(/[\/\\]+/)
    .some((part) => part.toLowerCase() === "imgdownloader_files");
}

function getFilenameFromUrl(url, mediaType = "image") {
  const fallbackExtension = mediaType === "video" ? "mp4" : "jpg";
  const fallbackName = () =>
    `${mediaType}-${Date.now()}.${fallbackExtension}`;

  if (url.startsWith("data:")) {
    const mime = url.match(/data:([^;]*);/);
    const extension = mime ? mime[1].split("/")[1] : fallbackExtension;
    return `${mediaType}-${Date.now()}.${extension}`;
  }

  try {
    const pathname = new URL(url).pathname;
    let name = pathname.slice(pathname.lastIndexOf("/") + 1);
    if (!name) return fallbackName();
    name = decodeURIComponent(name);
    name = name.replace(/[^a-zA-Z0-9.\-_]/g, "_");
    if (!name.includes(".")) name += `.${fallbackExtension}`;
    return name;
  } catch {
    return fallbackName();
  }
}

// ---------------------------------------------------------------------------
// Preview tab
// ---------------------------------------------------------------------------

async function openPreviewTab(url, sourceTabId) {
  const sourceTab = sourceTabId
    ? await chrome.tabs.get(sourceTabId)
    : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (!sourceTab?.id) throw new Error("Source tab was not found.");

  const previewTab = await chrome.tabs.create({
    url,
    active: false,
    windowId: sourceTab.windowId,
    index: sourceTab.index + 1,
    pinned: sourceTab.pinned,
  });
  if (!previewTab?.id) throw new Error("Preview tab was not created.");

  if (sourceTab.groupId >= 0) {
    await chrome.tabs.group({
      tabIds: previewTab.id,
      groupId: sourceTab.groupId,
    });
  }

  await keepPreviewNextToSource(previewTab.id, sourceTab.id);
}

async function keepPreviewNextToSource(previewTabId, sourceTabId) {
  let moving = false;
  let disposed = false;
  const enforcePosition = async () => {
    if (moving || disposed) return;
    moving = true;
    try {
      const [sourceTab, previewTab] = await Promise.all([
        chrome.tabs.get(sourceTabId),
        chrome.tabs.get(previewTabId),
      ]);
      const targetIndex = sourceTab.index + 1;
      if (
        previewTab.windowId !== sourceTab.windowId ||
        previewTab.index !== targetIndex
      ) {
        await chrome.tabs.move(previewTabId, {
          windowId: sourceTab.windowId,
          index: targetIndex,
        });
      }
    } finally {
      moving = false;
    }
  };
  const handleMoved = (tabId) => {
    if (tabId === previewTabId || tabId === sourceTabId) enforcePosition();
  };
  const handleUpdated = (tabId, changeInfo) => {
    if (tabId === previewTabId && changeInfo.status === "complete") {
      enforcePosition();
    }
  };

  chrome.tabs.onMoved.addListener(handleMoved);
  chrome.tabs.onAttached.addListener(handleMoved);
  chrome.tabs.onUpdated.addListener(handleUpdated);
  await enforcePosition();
  setTimeout(() => {
    disposed = true;
    chrome.tabs.onMoved.removeListener(handleMoved);
    chrome.tabs.onAttached.removeListener(handleMoved);
    chrome.tabs.onUpdated.removeListener(handleUpdated);
  }, 5000);
}
