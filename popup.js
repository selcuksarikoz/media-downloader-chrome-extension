const listEl = document.getElementById("media-list");
const emptyEl = document.getElementById("empty");
const noticeEl = document.getElementById("notice");
const countEl = document.getElementById("count");
const scanBtn = document.getElementById("scan");
const scanEmptyBtn = document.getElementById("scan-empty");
const downloadAllBtn = document.getElementById("download-all");
const clearBtn = document.getElementById("clear");

let activeTabId;
let activeFrameIds = [0];
let mediaItems = [];
const itemStates = new Map();
const itemProgress = new Map();
const reportedVideoIds = new Set();
let refreshInFlight = false;
let refreshTimer;

init();

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id;
  if (!activeTabId) {
    showUnavailable("No active tab was found.");
    return;
  }
  activeFrameIds = await discoverFrameIds();
  await loadMedia("getPopupMedia");
  refreshTimer = setInterval(refreshMedia, 500);
}

async function discoverFrameIds() {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: activeTabId, allFrames: true },
      func: () => true,
    });
    const frameIds = [...new Set(results.map((result) => result.frameId))];
    return frameIds.length ? frameIds : [0];
  } catch {
    return [0];
  }
}

async function sendToTab(message, frameId = 0) {
  if (!activeTabId) throw new Error("No active tab was found.");
  try {
    return await chrome.tabs.sendMessage(activeTabId, message, { frameId });
  } catch {
    throw new Error("Open a regular web page and reload it once.");
  }
}

async function sendToAllFrames(message) {
  const results = await Promise.allSettled(
    activeFrameIds.map(async (frameId) => ({
      frameId,
      response: await sendToTab(message, frameId),
    })),
  );
  return results
    .filter((result) => result.status === "fulfilled" && result.value.response?.ok)
    .map((result) => result.value);
}

async function collectFrameMedia(action) {
  if (action === "rescanPopupMedia") {
    activeFrameIds = await discoverFrameIds();
  }
  const results = await sendToAllFrames({ action });
  if (!results.length) {
    throw new Error("Open a regular web page and reload it once.");
  }
  return results.flatMap(({ frameId, response }) =>
    (response.media || []).map((item) => ({ ...item, frameId })),
  );
}

async function loadMedia(action) {
  setBusy(true);
  hideNotice();
  try {
    mediaItems = await collectFrameMedia(action);
    syncStatuses(mediaItems);
    render();
  } catch (error) {
    showUnavailable(error.message);
  } finally {
    setBusy(false);
  }
}

async function refreshMedia() {
  if (refreshInFlight || !activeTabId) return;
  refreshInFlight = true;
  try {
    mediaItems = await collectFrameMedia("getPopupMedia");
    syncStatuses(mediaItems);
    render();
  } catch {
    clearInterval(refreshTimer);
  } finally {
    refreshInFlight = false;
  }
}

function syncStatuses(items) {
  items.forEach((item) => {
    if (item.downloadStatus) applyStatus(item.id, item.downloadStatus, false);
  });
}

function render() {
  listEl.replaceChildren();
  countEl.textContent = `${mediaItems.length} found`;
  emptyEl.hidden = mediaItems.length > 0;
  listEl.hidden = mediaItems.length === 0;
  downloadAllBtn.disabled = mediaItems.length === 0;
  clearBtn.disabled = mediaItems.length === 0;

  mediaItems.forEach((item) => listEl.appendChild(createMediaCard(item)));
}

function createMediaCard(item) {
  const state = itemStates.get(item.id) || (item.active ? "downloading" : "ready");
  const article = document.createElement("article");
  article.className = `media-card state-${state}`;
  article.dataset.videoId = item.id;

  const thumb = document.createElement("div");
  thumb.className = "thumbnail";
  if (item.poster) {
    const image = document.createElement("img");
    image.src = item.poster;
    image.alt = "";
    thumb.appendChild(image);
  } else {
    thumb.innerHTML = '<span class="play-mark" aria-hidden="true"></span>';
  }

  const body = document.createElement("div");
  body.className = "media-body";
  const title = document.createElement("h2");
  title.textContent = item.title;
  const page = document.createElement("p");
  page.className = "page-title";
  page.textContent = item.pageTitle;
  const facts = document.createElement("p");
  facts.className = "facts";
  facts.textContent = [
    item.duration ? formatDuration(item.duration) : "Live",
    item.width && item.height ? `${item.width}×${item.height}` : "Adaptive",
    item.sourceLabel,
  ].join(" · ");
  body.append(title, page, facts);

  const progress = itemProgress.get(item.id);
  if (
    progress !== undefined &&
    ["downloading", "started", "complete"].includes(state)
  ) {
    const progressTrack = document.createElement("div");
    progressTrack.className = "progress-track";
    progressTrack.setAttribute("role", "progressbar");
    progressTrack.setAttribute("aria-label", "Download progress");
    if (Number.isFinite(progress)) {
      const percent = Math.max(0, Math.min(100, Math.round(progress)));
      progressTrack.setAttribute("aria-valuenow", String(percent));
      progressTrack.innerHTML = `<span style="width: ${percent}%"></span>`;
    } else {
      progressTrack.classList.add("indeterminate");
      progressTrack.innerHTML = "<span></span>";
    }
    body.appendChild(progressTrack);
  }

  const actions = document.createElement("div");
  actions.className = "card-actions";
  const download = document.createElement("button");
  download.type = "button";
  download.className = "download-button";
  download.textContent =
    state === "downloading" && Number.isFinite(progress)
      ? `${Math.round(progress)}%`
      : ({
          downloading: "Downloading",
          complete: "Saved",
          started: "Started",
          error: "Retry",
        }[state] || "Download");
  download.disabled = ["downloading", "started", "complete"].includes(state);
  download.addEventListener("click", () => downloadItem(item.id));

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "remove-button";
  remove.title = "Remove from list";
  remove.setAttribute("aria-label", "Remove from list");
  remove.textContent = "×";
  remove.addEventListener("click", () => removeItem(item.id));
  actions.append(download, remove);

  article.append(thumb, body, actions);
  return article;
}

async function downloadItem(videoId) {
  const item = mediaItems.find((candidate) => candidate.id === videoId);
  reportedVideoIds.delete(videoId);
  itemProgress.set(videoId, 0);
  itemStates.set(videoId, "downloading");
  render();
  try {
    const response = await sendToTab(
      { action: "downloadPopupMedia", videoId },
      item?.frameId ?? 0,
    );
    if (!response?.ok) throw new Error(response?.error || "Download failed.");
    if (!reportedVideoIds.has(videoId)) {
      itemStates.set(videoId, "started");
      render();
    }
    showNotice("Download started.", "success");
  } catch (error) {
    itemStates.set(videoId, "error");
    render();
    showNotice(error.message, "error");
  }
}

async function removeItem(videoId) {
  try {
    const item = mediaItems.find((candidate) => candidate.id === videoId);
    const response = await sendToTab(
      { action: "removePopupMedia", videoId },
      item?.frameId ?? 0,
    );
    if (!response?.ok) throw new Error(response?.error || "Remove failed.");
    itemStates.delete(videoId);
    itemProgress.delete(videoId);
    mediaItems = mediaItems.filter((candidate) => candidate.id !== videoId);
    render();
  } catch (error) {
    showNotice(error.message, "error");
  }
}

async function downloadAll() {
  const pending = mediaItems.filter(
    (item) =>
      !["downloading", "started", "complete"].includes(
        itemStates.get(item.id),
      ),
  );
  await Promise.all(pending.map((item) => downloadItem(item.id)));
}

async function clearAll() {
  try {
    const responses = await sendToAllFrames({ action: "clearPopupMedia" });
    if (!responses.length) throw new Error("Clear failed.");
    mediaItems = [];
    itemStates.clear();
    itemProgress.clear();
    render();
  } catch (error) {
    showNotice(error.message, "error");
  }
}

function setBusy(busy) {
  scanBtn.disabled = busy;
  scanEmptyBtn.disabled = busy;
  if (busy && !mediaItems.length) {
    countEl.textContent = "Scanning…";
  }
}

function showUnavailable(message) {
  mediaItems = [];
  render();
  showNotice(message, "error");
}

function showNotice(message, type) {
  noticeEl.hidden = false;
  noticeEl.className = `notice notice-${type}`;
  noticeEl.textContent = message;
}

function hideNotice() {
  noticeEl.hidden = true;
  noticeEl.textContent = "";
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${minutes}:${String(remaining).padStart(2, "0")}`;
}

scanBtn.addEventListener("click", () => loadMedia("rescanPopupMedia"));
scanEmptyBtn.addEventListener("click", () => loadMedia("rescanPopupMedia"));
downloadAllBtn.addEventListener("click", downloadAll);
clearBtn.addEventListener("click", clearAll);

chrome.runtime.onMessage.addListener((message) => {
  if (message?.action !== "popupMediaStatus" || !message.videoId) return;
  applyStatus(message.videoId, message);
});

function applyStatus(videoId, update, shouldRender = true) {
  reportedVideoIds.add(videoId);
  if (Number.isFinite(update.progress)) {
    const previous = itemProgress.get(videoId);
    const next = Math.max(0, Math.min(100, update.progress));
    itemProgress.set(
      videoId,
      Number.isFinite(previous) &&
        (update.status === "progress" || update.status === "recording")
        ? Math.max(previous, next)
        : next,
    );
  } else if (update.status === "progress" || update.status === "recording") {
    if (!Number.isFinite(itemProgress.get(videoId))) {
      itemProgress.set(videoId, null);
    }
  }
  if (update.status === "complete") {
    itemStates.set(videoId, "complete");
    itemProgress.set(videoId, 100);
  } else if (update.status === "error" || update.status === "canceled") {
    itemStates.set(videoId, "error");
  } else if (update.status === "recording" || update.status === "progress") {
    itemStates.set(videoId, "downloading");
  }
  if (shouldRender) render();
}

window.addEventListener("unload", () => clearInterval(refreshTimer));
