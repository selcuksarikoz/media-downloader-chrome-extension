const DEFAULT_SETTINGS = {
  buttonPosition: "top-right",
  downloadFolder: "",
  showSaveAs: false,
  showPreviewButton: true,
  showVideoControls: true,
  captureType: "jpg",
  minWidth: 150,
  maxConcurrentDownloads: 5,
};
const ACTIVE_DOWNLOAD_STATES = new Set(["queued", "recording", "progress"]);
let settings = { ...DEFAULT_SETTINGS };

const mediaControls = new Map();
const capturedVideos = new Map();
const blobDownloadRequests = new Map();
const BLOB_DOWNLOAD_EVENT = "imd:download-blob-video";
const BLOB_STATUS_EVENT = "imd:blob-video-status";
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
  { root: null, threshold: [0, 0.01] }
);
const mediaResizeObserver = new ResizeObserver((entries) => {
  entries.forEach(({ target }) => {
    if (!visibleMedia.has(target)) return;
    if (!target.dataset.imdProcessed) {
      processMedia(target);
      return;
    }
    const group = mediaControls.get(target);
    if (group?.classList.contains("imd-show")) {
      positionActionGroup(group, target);
    }
  });
});

window.addEventListener(BLOB_STATUS_EVENT, (event) => {
  const { videoId, status, message, progress } = event.detail || {};
  const video = capturedVideos.get(videoId);
  const buttons = video
    ? mediaControls.get(video)?.querySelectorAll(".imd-down-btn")
    : [];

  if (buttons?.length) {
    const isActive = ACTIVE_DOWNLOAD_STATES.has(status);
    buttons.forEach((button) => {
      button.title = isActive ? "Video download in progress" : "Download Video";
      button.setAttribute("aria-label", button.title);
      button.classList.toggle("imd-recording", isActive);
      button.disabled = isActive;
    });
  }

  updateBlobDownloadPanel(videoId, status, message, progress);

  if (status === "error") console.error(message);
});

let blobDownloadStack;
const blobDownloadPanels = new Map();
window.addEventListener("beforeunload", (event) => {
  if (!blobDownloadRequests.size) return;
  event.preventDefault();
  event.returnValue = "";
});

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
  const canFinish = status === "recording" || status === "progress";
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
  panel.querySelector(".imd-finish-download").hidden = !canFinish;

  if (typeof blobDownloadStack.showPopover === "function") {
    if (!blobDownloadStack.matches(":popover-open")) {
      blobDownloadStack.showPopover();
    }
  }

  if (!isActive) {
    blobDownloadRequests.delete(videoId);
    setTimeout(() => {
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
    }, status === "error" ? 6000 : 2500);
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
      <button type="button" class="imd-finish-download">Finish and save now</button>
    </div>`;
  panel.querySelector(".imd-finish-download").addEventListener("click", () => {
    const request = blobDownloadRequests.get(videoId);
    if (request) {
      window.dispatchEvent(
        new CustomEvent(BLOB_DOWNLOAD_EVENT, { detail: request })
      );
    }
  });
  return panel;
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

function init() {
  chrome.storage.sync.get(DEFAULT_SETTINGS, (items) => {
    settings = items;
    if (hasForbiddenFolder(settings.downloadFolder)) {
      settings.downloadFolder = "";
      chrome.storage.sync.set({ downloadFolder: "" });
    }
    processAllMedia();
    startObserver();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    Object.entries(changes).forEach(([key, change]) => {
      settings[key] = change.newValue;
    });
    if (changes.buttonPosition) updateAllButtonPositions();
    if (changes.showPreviewButton) updatePreviewButtonVisibility();
    if (changes.showVideoControls) updateVideoControls();
  });
}

function hasForbiddenFolder(folder) {
  return folder
    .split(/[\/\\]+/)
    .some((part) => part.toLowerCase() === "imgdownloader_files");
}

function processAllMedia() {
  document.querySelectorAll("img, video").forEach(trackMedia);
}

function trackMedia(media) {
  if (media.tagName === "VIDEO") {
    media.controls = settings.showVideoControls;
  }
  mediaResizeObserver.observe(media);
  mediaIntersectionObserver.observe(media);
}

function updateVideoControls() {
  document.querySelectorAll("video").forEach((video) => {
    video.controls = settings.showVideoControls;
  });
}

function startObserver() {
  const observer = new MutationObserver((mutations) => {
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
        node.querySelectorAll("img, video").forEach((media) =>
          removedMedia.add(media)
        );
      });
    });
    queueMicrotask(() => {
      removedMedia.forEach((media) => {
        if (!media.isConnected) cleanupMedia(media);
      });
    });
    schedulePointerReconciliation();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

function cleanupMedia(media) {
  const group = mediaControls.get(media);
  if (group) group.remove();
  if (media.dataset.imdCaptureId) {
    capturedVideos.delete(media.dataset.imdCaptureId);
  }
  mediaControls.delete(media);
  visibleMedia.delete(media);
  mediaIntersectionObserver.unobserve(media);
  mediaResizeObserver.unobserve(media);
  delete media.dataset.imdProcessed;
  delete media.dataset.imdWaiting;
}

function updateAllButtonPositions() {
  mediaControls.forEach((group, media) => {
    positionActionGroup(group, media);
  });
}

function updatePreviewButtonVisibility() {
  mediaControls.forEach((group, media) => {
    const button = group.querySelector(".imd-preview-btn");
    const isBlobVideo =
      media.tagName === "VIDEO" && getVideoUrl(media).startsWith("blob:");
    button.hidden = !settings.showPreviewButton || isBlobVideo;
  });
  repositionOpenControls();
}

function isValidMedia(media) {
  const width = media.clientWidth || media.width;
  const height = media.clientHeight || media.height;
  if (width < settings.minWidth || height < settings.minWidth)
    return false;
  if (media.dataset.imdProcessed) return false;
  return true;
}

function processMedia(media) {
  if (!visibleMedia.has(media) || !media.isConnected) return;
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

  const actionGroup = document.createElement("div");
  actionGroup.className = "imd-action-group";
  actionGroup.popover = "manual";
  const downloadBtn = createActionButton(
    "imd-down-btn",
    `Download ${isImage ? "Image" : "Video"}`,
    DOWNLOAD_ICON
  );
  const previewBtn = createActionButton(
    "imd-preview-btn",
    `Preview ${isImage ? "highest-resolution image" : "video"}`,
    PREVIEW_ICON
  );
  const captureBtn = isImage
    ? null
      : createActionButton(
        "imd-capture-btn",
        "Capture Frame",
        CAPTURE_ICON
      );
  const isBlobVideo = !isImage && getVideoUrl(media).startsWith("blob:");
  previewBtn.hidden = !settings.showPreviewButton || isBlobVideo;
  actionGroup.append(downloadBtn, previewBtn);
  if (captureBtn) actionGroup.append(captureBtn);

  downloadBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    downloadMedia(media);
  });

  previewBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    previewMedia(media);
  });

  captureBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    captureVideoFrame(media).catch((error) => {
      console.error("Video frame capture failed:", error);
    });
  });

  const showButtons = () => {
    if (
      lastPointerPosition &&
      findTopMediaAtPoint(lastPointerPosition.x, lastPointerPosition.y) === media
    ) {
      showActionGroup(actionGroup, media);
    }
  };
  const hideButtons = () => hideActionGroup(actionGroup);

  const hoverTargets = getMediaHoverTargets(media);
  const scheduleHide = () => {
    setTimeout(() => {
      const stillHoveringMedia = hoverTargets.some((target) =>
        target.matches(":hover")
      );
      if (!stillHoveringMedia && !actionGroup.matches(":hover")) {
        hideButtons();
      }
    }, 100);
  };

  hoverTargets.forEach((target) => {
    target.addEventListener("mouseenter", showButtons);
    target.addEventListener("mouseleave", scheduleHide);
  });

  actionGroup.addEventListener("mouseenter", showButtons);
  actionGroup.addEventListener("mouseleave", scheduleHide);

  document.body.appendChild(actionGroup);
  mediaControls.set(media, actionGroup);
}

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

  if (!group.isConnected && document.body) {
    document.body.appendChild(group);
  }

  if (typeof group.showPopover === "function") {
    try {
      if (group.isConnected && !group.matches(":popover-open")) {
        group.showPopover();
      }
    } catch (error) {
      if (error.name !== "InvalidStateError") throw error;
      return;
    }
  }
  group.classList.add("imd-show");
  positionActionGroup(group, media);
}

function hideActionGroup(group) {
  group.classList.remove("imd-show");
  if (
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

function positionActionGroup(group, media) {
  const rect = media.getBoundingClientRect();
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

function repositionOpenControls() {
  mediaControls.forEach((group, media) => {
    if (!media.isConnected) {
      cleanupMedia(media);
      return;
    }
    if (!visibleMedia.has(media)) {
      hideActionGroup(group);
    } else if (group.classList.contains("imd-show")) {
      positionActionGroup(group, media);
    }
  });
}

window.addEventListener("scroll", repositionOpenControls, true);
window.addEventListener("resize", repositionOpenControls);

let pointerFrame = null;
let lastPointerPosition = null;
document.addEventListener(
  "pointermove",
  (event) => {
    if (event.pointerType === "touch") return;
    lastPointerPosition = { x: event.clientX, y: event.clientY };
    schedulePointerReconciliation();
  },
  true
);

function schedulePointerReconciliation() {
  if (!lastPointerPosition) return;
  if (pointerFrame !== null) cancelAnimationFrame(pointerFrame);
  pointerFrame = requestAnimationFrame(() => {
    pointerFrame = null;
    reconcileControlsAtPoint(lastPointerPosition.x, lastPointerPosition.y);
  });
}

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

    const targets = getMediaHoverTargets(media);
    const isRelated = (element) =>
      group.contains(element) ||
      targets.some((target) => target === element || target.contains(element));
    const stackIndex = stack.findIndex(isRelated);
    if (stackIndex === -1 || stackIndex >= bestStackIndex) return;

    const blocked = stack
      .slice(0, stackIndex)
      .some((element) => !isRelated(element));
    if (blocked) return;

    bestMedia = media;
    bestStackIndex = stackIndex;
  });

  return bestMedia;
}

function isMediaActuallyVisible(media) {
  if (
    typeof media.checkVisibility === "function" &&
    !media.checkVisibility({
      checkOpacity: true,
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
    const style = getComputedStyle(element);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number(style.opacity) === 0
    ) {
      return false;
    }
  }
  return true;
}

function getModalAtPoint(x, y, stack) {
  const modals = Array.from(
    document.querySelectorAll('dialog[open], [role="dialog"], [aria-modal="true"]')
  ).filter((modal) => {
    const style = getComputedStyle(modal);
    const rect = modal.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity) > 0 &&
      rect.width > 0 &&
      rect.height > 0
    );
  });
  if (!modals.length) return { hasModal: false, modal: null };

  const modal = stack
    .map((element) => modals.find((candidate) => candidate.contains(element)))
    .find(Boolean);
  if (modal) return { hasModal: true, modal };

  const containsPoint = modals.find((candidate) => {
    const rect = candidate.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  });
  return { hasModal: true, modal: containsPoint || null };
}

function createActionButton(className, title, icon) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `imd-action-btn ${className}`;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.innerHTML = icon;
  return button;
}

function previewMedia(media) {
  if (media.tagName === "VIDEO") {
    const url = getVideoUrl(media);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
    return;
  }

  const previewWindow = window.open("about:blank", "_blank");
  if (!previewWindow) return;
  previewWindow.opener = null;
  resolveHighestResolutionImageUrl(media)
    .then((url) => {
      if (url && !previewWindow.closed) previewWindow.location.replace(url);
    })
    .catch((error) => {
      previewWindow.close();
      console.error("Image resolution detection failed.", error);
    });
}

function getHighestResolutionImageUrl(img) {
  const candidates = parseSrcset(img.getAttribute("srcset"));
  if (candidates.length > 0) {
    candidates.sort((a, b) => b.score - a.score);
    return new URL(candidates[0].url, document.baseURI).href;
  }
  return img.currentSrc || img.src;
}

async function resolveHighestResolutionImageUrl(img) {
  const candidates = collectImageCandidates(img);
  if (!candidates.length) return getHighestResolutionImageUrl(img);

  const measured = await Promise.all(
    candidates.map(async (url) => ({
      url,
      area: await measureImageArea(url),
    }))
  );
  measured.sort((a, b) => b.area - a.area);
  return measured[0]?.area > 0
    ? measured[0].url
    : getHighestResolutionImageUrl(img);
}

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

  const container = img.closest("article, [role='dialog']") || img.parentElement;
  container?.querySelectorAll("img").forEach((candidate) => {
    const values = [candidate.currentSrc, candidate.src];
    parseSrcset(candidate.getAttribute("srcset")).forEach(({ url }) =>
      values.push(url)
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

function measureImageArea(url) {
  return new Promise((resolve) => {
    const probe = new Image();
    const timeout = setTimeout(() => resolve(0), 5000);
    probe.onload = () => {
      clearTimeout(timeout);
      resolve(probe.naturalWidth * probe.naturalHeight);
    };
    probe.onerror = () => {
      clearTimeout(timeout);
      resolve(0);
    };
    probe.src = url;
  });
}

function getVideoUrl(video) {
  if (video.currentSrc) return video.currentSrc;
  if (video.src) return video.src;

  const source = Array.from(video.querySelectorAll("source[src]")).find(
    (item) => item.src
  );
  return source ? source.src : "";
}

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

async function downloadMedia(media) {
  const src =
    media.tagName === "IMG"
      ? await resolveHighestResolutionImageUrl(media)
      : getVideoUrl(media);
  if (!src) {
    console.error("Media has no source.");
    return;
  }

  if (media.tagName === "VIDEO" && src.startsWith("blob:")) {
    await streamBlobVideo(media, src);
    return;
  }

  chrome.runtime.sendMessage({
    action: "download",
    url: src,
    mediaType: media.tagName === "VIDEO" ? "video" : "image",
    folder: settings.downloadFolder,
    saveAs: settings.showSaveAs,
  });
}

function streamBlobVideo(video, url) {
  const detail = {
    url,
    filename: getSuggestedVideoName(video),
    videoId: video.dataset.imdCaptureId,
    maxConcurrent: settings.maxConcurrentDownloads,
  };
  blobDownloadRequests.set(detail.videoId, detail);
  window.dispatchEvent(
    new CustomEvent(BLOB_DOWNLOAD_EVENT, {
      detail,
    })
  );
}

async function captureVideoFrame(video) {
  if (!video.videoWidth || !video.videoHeight) {
    throw new Error("Video frame is not ready.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable.");
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const captureFormats = {
    jpg: { mimeType: "image/jpeg", extension: "jpg", quality: 0.92 },
    png: { mimeType: "image/png", extension: "png" },
    webp: { mimeType: "image/webp", extension: "webp", quality: 0.92 },
  };
  const format = captureFormats[settings.captureType] ?? captureFormats.jpg;
  const blob = await new Promise((resolve, reject) => {
    try {
      canvas.toBlob(
        (result) =>
          result ? resolve(result) : reject(new Error("Frame encoding failed.")),
        format.mimeType,
        format.quality
      );
    } catch (error) {
      reject(error);
    }
  });
  const url = URL.createObjectURL(blob);
  const filename = getSuggestedVideoName(video).replace(
    /\.[^.]+$/,
    `-frame-${Math.round(video.currentTime * 1000)}ms.${format.extension}`
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.documentElement.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

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

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
