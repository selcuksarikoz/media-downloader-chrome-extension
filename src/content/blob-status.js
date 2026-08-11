import {
  BLOB_STATUS_EVENT, BLOB_DATA_EVENT, ACTIVE_DOWNLOAD_STATES,
} from './constants.js';
import {
  settings, popupVideoStatuses, activeBlobJobIds, capturedVideos,
  mediaControls, blobJobIntent, canceledBlobJobs,
  finalizingBlobJobIds,
  blobDownloadStack, blobDownloadPanels, blobDownloadRequests,
  setBlobDownloadStack,
} from './state.js';
import { sendBlobStoreMessage } from './blob-store.js';
import { cancelLocalMux } from './blob-mux.js';
import { showToast } from './toast.js';
import { TRIM_ICON, STOP_ICON } from './constants.js';
import { refreshMediaActionState } from './action-ui.js';

window.addEventListener(BLOB_STATUS_EVENT, (event) => {
  const { videoId, status, message, progress } = event.detail || {};
  const normalizedProgress = normalizeJobProgress(
    popupVideoStatuses.get(videoId),
    status,
    progress,
  );
  if (videoId) {
    if (
      blobJobIntent.get(videoId) === "trim" &&
      /(?:downloading and trimming|finalizing trim)/i.test(message || "")
    ) {
      finalizingBlobJobIds.add(videoId);
    }
    popupVideoStatuses.set(videoId, {
      status,
      message,
      progress: normalizedProgress,
    });
    if (ACTIVE_DOWNLOAD_STATES.has(status)) activeBlobJobIds.add(videoId);
    else activeBlobJobIds.delete(videoId);

    try {
      chrome.runtime.sendMessage({
        action: "popupMediaStatus",
        videoId,
        status,
        message,
        progress: normalizedProgress,
      });
    } catch {}
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
        ? message.replace("Recording ", "").replace("\u2026", "")
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

  updateBlobDownloadPanel(videoId, status, message, normalizedProgress);

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
    finalizingBlobJobIds.delete(videoId);
    blobJobIntent.delete(videoId);
  }
  if (video) refreshMediaActionState(video);
});

function normalizeJobProgress(previous, status, progress) {
  if (status === "complete") return 100;
  const current = Number.isFinite(progress)
    ? Math.max(0, Math.min(100, progress))
    : null;
  if (!ACTIVE_DOWNLOAD_STATES.has(status)) return current;
  if (!ACTIVE_DOWNLOAD_STATES.has(previous?.status)) return current;
  if (!Number.isFinite(previous.progress)) return current;
  return Number.isFinite(current)
    ? Math.max(previous.progress, current)
    : previous.progress;
}

window.addEventListener(BLOB_DATA_EVENT, async (event) => {
  const { blob, filename, videoId } = event.detail || {};
  if (!blob || !blob.size) return;
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

export function downloadBlobFile(blob, filename, folder, saveAs) {
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

function hasForbiddenFolder(folder) {
  return folder
    .split(/[\/\\]+/)
    .some((part) => part.toLowerCase() === "imgdownloader_files");
}

function updateBlobDownloadPanel(videoId, status, message, progress) {
  if (!blobDownloadStack) setBlobDownloadStack(createBlobDownloadStack());
  if (!blobDownloadStack.isConnected) {
    document.body.appendChild(blobDownloadStack);
  }
  let panel = blobDownloadPanels.get(videoId);
  if (!panel) {
    panel = createBlobDownloadPanel(videoId);
    blobDownloadPanels.set(videoId, panel);
    blobDownloadStack.appendChild(panel);
  }
  const isTrimJob = blobJobIntent.get(videoId) === "trim";
  const isActive = ACTIVE_DOWNLOAD_STATES.has(status);
  const wasActive = panel.dataset.active === "true";
  if (isActive && !wasActive) panel.dataset.maxProgress = "0";
  panel.dataset.active = isActive ? "true" : "false";

  const rawPercent = Number.isFinite(progress)
    ? Math.max(0, Math.min(100, Math.round(progress)))
    : null;
  const previousPercent = Number(panel.dataset.maxProgress);
  const percent = rawPercent === null
    ? (Number.isFinite(previousPercent) ? previousPercent : null)
    : Math.max(Number.isFinite(previousPercent) ? previousPercent : 0, rawPercent);
  if (percent !== null) panel.dataset.maxProgress = String(percent);

  panel.querySelector(".imd-download-title").textContent =
    isTrimJob ? "Trim video" : "Video download";
  panel.querySelector(".imd-download-message").textContent =
    message || "Preparing video download\u2026";
  const fill = panel.querySelector(".imd-download-progress-fill");
  fill.style.width = `${percent ?? (isActive ? 15 : 100)}%`;
  fill.classList.toggle("imd-indeterminate", percent === null && isActive);
  panel.querySelector(".imd-download-percent").textContent =
    percent === null ? "" : `${percent}%`;
  panel.querySelector(".imd-save-download").hidden = !(
    isTrimJob && isActive && !finalizingBlobJobIds.has(videoId)
  );
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

function createBlobDownloadStack() {
  const stack = document.createElement("div");
  stack.className = "imd-download-stack";
  stack.popover = "manual";
  return stack;
}

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
        <button type="button" class="imd-save-download">Save Trim</button>
        <button type="button" class="imd-cancel-download">Cancel</button>
      </div>
    </div>`;
  panel.querySelector(".imd-save-download").addEventListener("click", () => {
    finalizingBlobJobIds.add(videoId);
    const video = capturedVideos.get(videoId);
    if (video) refreshMediaActionState(video);
    panel.querySelector(".imd-save-download").hidden = true;
    dispatchBlobControl(videoId, "save");
  });
  panel.querySelector(".imd-cancel-download").addEventListener("click", () => {
    dispatchBlobControl(videoId, "cancel");
  });
  return panel;
}

function dispatchBlobControl(videoId, action) {
  window.dispatchEvent(
    new CustomEvent("imd:control-blob-video", {
      detail: { videoId, action },
    }),
  );
}
