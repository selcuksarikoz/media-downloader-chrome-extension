/**
 * Media Downloader content script.
 * Injects download and preview controls onto images and videos.
 */

let settings = {
  buttonPosition: "top-right",
  downloadFolder: "",
  showSaveAs: false,
  showPreviewButton: true,
  minWidth: 150,
};

const mediaControls = new Map();
const BLOB_DOWNLOAD_EVENT = "imd:download-blob-video";
const BLOB_STATUS_EVENT = "imd:blob-video-status";
const mediaResizeObserver = new ResizeObserver((entries) => {
  entries.forEach(({ target }) => {
    if (!target.dataset.imdProcessed) processMedia(target);
  });
});

window.addEventListener(BLOB_STATUS_EVENT, (event) => {
  const { videoId, status, message } = event.detail || {};
  const video = Array.from(mediaControls.keys()).find(
    (media) => media.dataset.imdCaptureId === videoId
  );
  const button = video
    ? mediaControls.get(video)?.querySelector(".imd-down-btn")
    : null;

  if (button) {
    button.title =
      status === "recording" ? "Stop Video Recording" : "Download Video";
    button.setAttribute("aria-label", button.title);
    button.classList.toggle("imd-recording", status === "recording");
  }

  if (status === "error") console.error(message);
  else console.info(message);
});

// SVG Icon for the download button
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

/**
 * Initialize the extension content script.
 */
function init() {
  // Load settings first
  chrome.storage.sync.get(
    {
      buttonPosition: "top-right",
      downloadFolder: "",
      showSaveAs: false,
      showPreviewButton: true,
      minWidth: 150,
    },
    (items) => {
      settings = items;
      if (hasForbiddenFolder(settings.downloadFolder)) {
        settings.downloadFolder = "";
        chrome.storage.sync.set({ downloadFolder: "" });
      }
      processAllMedia();
      // Observe for dynamically added media
      startObserver();
    }
  );

  // Listen for setting changes
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync") {
      if (changes.buttonPosition) {
        settings.buttonPosition = changes.buttonPosition.newValue;
        updateAllButtonPositions();
      }
      if (changes.downloadFolder) {
        settings.downloadFolder = changes.downloadFolder.newValue;
      }
      if (changes.showSaveAs) {
        settings.showSaveAs = changes.showSaveAs.newValue;
      }
      if (changes.showPreviewButton) {
        settings.showPreviewButton = changes.showPreviewButton.newValue;
        updatePreviewButtonVisibility();
      }
      if (changes.minWidth) {
        settings.minWidth = changes.minWidth.newValue;
      }
    }
  });
}

function hasForbiddenFolder(folder) {
  return folder
    .split(/[\/\\]+/)
    .some((part) => part.toLowerCase() === "imgdownloader_files");
}

/**
 * Process all existing images and videos on the page.
 */
function processAllMedia() {
  const mediaElements = document.querySelectorAll("img, video");
  mediaElements.forEach(trackMedia);
}

function trackMedia(media) {
  mediaResizeObserver.observe(media);
  processMedia(media);
}

/**
 * Start MutationObserver to detect new media elements.
 */
function startObserver() {
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === 1) {
          // Element
          if (node.matches("img, video")) {
            trackMedia(node);
          } else {
            node.querySelectorAll("img, video").forEach(trackMedia);
          }
        }
      });
    });
    schedulePointerReconciliation();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

/**
 * Update positions of all existing buttons.
 */
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

/**
 * Check if a media element is large enough and has not been processed.
 */
function isValidMedia(media) {
  const width = media.clientWidth || media.width;
  const height = media.clientHeight || media.height;
  if (width < settings.minWidth || height < settings.minWidth)
    return false;
  if (media.dataset.imdProcessed) return false;
  return true;
}

/**
 * Create and inject controls for an image or video.
 */
function processMedia(media) {
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

  mediaResizeObserver.unobserve(media);
  delete media.dataset.imdWaiting;
  media.dataset.imdProcessed = "true";
  if (!isImage && !media.dataset.imdCaptureId) {
    media.dataset.imdCaptureId = crypto.randomUUID();
  }

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
  const isBlobVideo = !isImage && getVideoUrl(media).startsWith("blob:");
  previewBtn.hidden = !settings.showPreviewButton || isBlobVideo;
  actionGroup.append(downloadBtn, previewBtn);

  // Prevent clicks from bubbling to links
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

  // Toggle the controls from the media element because sibling hover selectors
  // are unreliable across arbitrary page markup.

  const showButtons = () => {
    if (
      !lastPointerPosition ||
      findTopMediaAtPoint(lastPointerPosition.x, lastPointerPosition.y) === media
    ) {
      showActionGroup(actionGroup, media);
    }
  };
  const hideButtons = () => hideActionGroup(actionGroup);

  // Sites such as Instagram place sibling overlays above the actual media.
  // Listen on the nearest same-sized wrappers as well as the media itself.
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
    group.remove();
    mediaControls.delete(media);
    return;
  }

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
      group.remove();
      mediaControls.delete(media);
      return;
    }
    if (group.classList.contains("imd-show")) {
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
      group.remove();
      mediaControls.delete(media);
      return;
    }

    if (media === topMedia) {
      showActionGroup(group, media);
    } else if (!group.matches(":hover")) {
      hideActionGroup(group);
    }
  });
}

function findTopMediaAtPoint(x, y) {
  const stack = document.elementsFromPoint(x, y);
  let bestMedia = null;
  let bestStackIndex = Infinity;

  mediaControls.forEach((group, media) => {
    if (!media.isConnected) return;
    const rect = media.getBoundingClientRect();
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      return;
    }

    for (let index = 0; index < stack.length; index += 1) {
      let element = stack[index];
      if (group.contains(element)) {
        bestMedia = media;
        bestStackIndex = -1;
        return;
      }

      for (let depth = 0; element && depth < 5; depth += 1) {
        if (element === media || element.contains(media)) {
          if (index < bestStackIndex) {
            bestMedia = media;
            bestStackIndex = index;
          }
          return;
        }
        element = element.parentElement;
      }
    }
  });

  return bestMedia;
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

  // Open synchronously to retain the click's popup permission, then navigate
  // after the candidates have been measured.
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
    } catch (_error) {
      // Ignore malformed page-provided candidates.
    }
  };

  addUrl(img.currentSrc);
  addUrl(img.src);
  parseSrcset(img.getAttribute("srcset")).forEach(({ url }) => addUrl(url));

  let sourcePath = "";
  try {
    sourcePath = new URL(img.currentSrc || img.src).pathname;
  } catch (_error) {
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
      } catch (_error) {
        // Ignore malformed candidates.
      }
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

/**
 * Download normal URLs through chrome.downloads and stream Blob-backed videos
 * directly to a user-selected file without buffering the entire video.
 */
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
  window.dispatchEvent(
    new CustomEvent(BLOB_DOWNLOAD_EVENT, {
      detail: {
        url,
        filename: getSuggestedVideoName(video),
        videoId: video.dataset.imdCaptureId,
      },
    })
  );
}

function getSuggestedVideoName(video) {
  const source = video.currentSrc || video.src;
  if (source && !source.startsWith("blob:")) {
    try {
      const pathname = new URL(source, document.baseURI).pathname;
      const filename = decodeURIComponent(pathname.split("/").pop() || "");
      if (filename) return filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    } catch (_error) {
      // Use the generated fallback below.
    }
  }

  return `video-${Date.now()}.mp4`;
}

// Run init
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
