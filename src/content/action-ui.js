import {
  DOWNLOAD_ICON, PREVIEW_ICON, CAPTURE_ICON, PIP_ICON, LIGHTBOX_ICON,
  CROP_ICON, TRIM_ICON, STOP_ICON, COPY_ICON,
} from './constants.js';
import {
  settings, mediaControls, trackedMedia, visibleMedia, pipState,
  mediaHoverListeners, lastPointerPosition, contextMenuEl, contextMenuMedia,
  blobJobIntent, activeBlobJobIds, videoTrimRecordings,
  finalizingBlobJobIds,
  visibilityStyleCacheFrame, visibilityStyleCache, cachedModalsFrame,
  cachedModals,
  setLastPointerPosition, setVisibilityStyleCacheFrame, setCachedModalsFrame,
  setCachedModals,
} from './state.js';
import { getInstagramReelLink, getActionRect } from './instagram.js';
import { getVideoUrl } from './video-resolution.js';

export function createActionButton(className, title, icon) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `imd-action-btn ${className}`;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.innerHTML = icon;
  return button;
}

export function setButtonLabel(button, label) {
  button.title = label;
  button.setAttribute("aria-label", label);
}

export function syncActionButtonState(media, btns) {
  if (media.tagName !== "VIDEO") return;
  const videoId = media.dataset.imdCaptureId;
  const blobIntent = videoId ? blobJobIntent.get(videoId) : null;
  const blobBusy = Boolean(videoId && activeBlobJobIds.has(videoId));
  const regularTrimActive = videoTrimRecordings.has(media);
  const trimActive = regularTrimActive || blobIntent === "trim";
  const trimFinalizing = Boolean(videoId && finalizingBlobJobIds.has(videoId));
  const conflictingJob = regularTrimActive || blobBusy;

  btns.downloadBtn.disabled = conflictingJob;
  btns.downloadBtn.classList.toggle("imd-recording", conflictingJob);
  setButtonLabel(
    btns.downloadBtn,
    conflictingJob ? "Video operation in progress" : "Download Video",
  );

  if (!btns.trimBtn) return;
  btns.trimBtn.disabled = trimFinalizing || (blobBusy && blobIntent !== "trim");
  btns.trimBtn.dataset.recording = trimActive ? "true" : "false";
  btns.trimBtn.innerHTML = trimActive ? STOP_ICON : TRIM_ICON;
  setButtonLabel(
    btns.trimBtn,
    trimFinalizing
      ? "Finalizing trim…"
      : trimActive
        ? "Save trim"
        : btns.trimBtn.disabled
          ? "Video operation in progress"
          : "Trim from current time",
  );
}

export function buildMediaActionButtons(media) {
  const isImage = media.tagName === "IMG";
  const isBlobVideo = !isImage && getVideoUrl(media).startsWith("blob:");
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
      ? createActionButton("imd-lightbox-btn", "View full-size image", LIGHTBOX_ICON)
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
  previewBtn.hidden = !settings.showPreviewButton || isBlobVideo;
  const buttons = [downloadBtn, previewBtn];
  if (trimBtn) buttons.push(trimBtn);
  if (lightboxBtn) buttons.push(lightboxBtn);
  if (captureBtn) buttons.push(captureBtn);
  if (copyBtn) buttons.push(copyBtn);
  if (pipBtn) buttons.push(pipBtn);
  const controls = {
    downloadBtn, previewBtn, captureBtn, lightboxBtn, pipBtn, trimBtn, copyBtn, buttons,
  };
  syncActionButtonState(media, controls);
  return controls;
}

export function refreshMediaActionState(media) {
  const roots = [];
  const hoverGroup = mediaControls.get(media);
  if (hoverGroup) roots.push(hoverGroup);
  if (contextMenuEl && contextMenuMedia === media) roots.push(contextMenuEl);
  roots.forEach((root) => {
    const downloadBtn = root.querySelector(".imd-down-btn");
    if (!downloadBtn) return;
    syncActionButtonState(media, {
      downloadBtn,
      trimBtn: root.querySelector(".imd-trim-btn"),
    });
  });
}

export function isolateActionGroupEvents(group) {
  const eventTypes = [
    "pointerdown", "pointerup", "mousedown", "mouseup",
    "touchstart", "touchend", "click", "dblclick",
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

export function attachActionGroup(group) {
  if (group.parentElement === document.body) return;
  document.body.appendChild(group);
}

export function detachActionGroup(group) {
  group.remove();
}

export function showActionGroup(group, media) {
  if (!media.isConnected) {
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

export function hideActionGroup(group) {
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

export function positionActionGroup(group, media) {
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

export function updateAllButtonPositions() {
  mediaControls.forEach((group, media) => {
    positionActionGroup(group, media);
  });
}

export function updatePreviewButtonVisibility() {
  mediaControls.forEach((group, media) => {
    const button = group.querySelector(".imd-preview-btn");
    if (!button) return;
    const isBlobVideo =
      media.tagName === "VIDEO" && getVideoUrl(media).startsWith("blob:");
    button.hidden = !settings.showPreviewButton || isBlobVideo;
  });
}

export function getMediaHoverTargets(media) {
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

export function repositionOpenControls() {
  mediaControls.forEach((group, media) => {
    if (!media.isConnected) return;
    if (!visibleMedia.has(media)) {
      hideActionGroup(group);
    } else if (group.classList.contains("imd-show")) {
      positionActionGroup(group, media);
    }
  });
}

export function scheduleReposition() {
  if (repositionFrame !== null) return;
  repositionFrame = requestAnimationFrame(() => {
    repositionFrame = null;
    repositionOpenControls();
  });
}

let repositionFrame = null;

export function schedulePointerReconciliation() {
  if (!lastPointerPosition) return;
  if (pointerFrame !== null) cancelAnimationFrame(pointerFrame);
  pointerFrame = requestAnimationFrame(() => {
    pointerFrame = null;
    reconcileControlsAtPoint(lastPointerPosition.x, lastPointerPosition.y);
  });
}

let pointerFrame = null;

export function reconcileControlsAtPoint(x, y) {
  const topMedia = findTopMediaAtPoint(x, y);
  mediaControls.forEach((group, media) => {
    if (!media.isConnected) return;
    if (visibleMedia.has(media) && media === topMedia) {
      showActionGroup(group, media);
    } else if (!group.matches(":hover")) {
      hideActionGroup(group);
    }
  });
}

export function findTopMediaAtPoint(x, y) {
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

function getCachedComputedStyle(element) {
  const frame = performance.now();
  if (visibilityStyleCacheFrame !== Math.floor(frame / 16)) {
    visibilityStyleCache.clear();
    setVisibilityStyleCacheFrame(Math.floor(frame / 16));
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

function getVisibleModals() {
  const frame = performance.now();
  if (cachedModalsFrame !== Math.floor(frame / 16)) {
    setCachedModalsFrame(Math.floor(frame / 16));
    setCachedModals(Array.from(
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
    }));
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

window.addEventListener("scroll", scheduleReposition, true);
window.addEventListener("resize", scheduleReposition);

document.addEventListener(
  "pointermove",
  (event) => {
    if (event.pointerType === "touch") return;
    setLastPointerPosition({ x: event.clientX, y: event.clientY });
    schedulePointerReconciliation();
  },
  true,
);
