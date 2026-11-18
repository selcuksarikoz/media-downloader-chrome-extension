import {
  DOWNLOAD_ICON, PREVIEW_ICON, CAPTURE_ICON, PIP_ICON, LIGHTBOX_ICON,
  TRIM_ICON, STOP_ICON, COPY_ICON,
} from './constants.js';
import {
  settings, mediaControls, visibleMedia, contextMenuEl, contextMenuMedia,
  blobJobIntent, activeBlobJobIds, activeDirectDownloadIds,
  pendingVideoActionIds, videoTrimRecordings, finalizingBlobJobIds,
} from './state.js';
import { getActionRect } from './instagram.js';

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
  const directDownloadBusy = Boolean(
    videoId && activeDirectDownloadIds.has(videoId)
  );
  const actionPending = Boolean(videoId && pendingVideoActionIds.has(videoId));
  const conflictingJob =
    regularTrimActive || blobBusy || directDownloadBusy || actionPending;

  btns.downloadBtn.disabled = conflictingJob;
  btns.downloadBtn.classList.toggle("imd-recording", conflictingJob);
  setButtonLabel(
    btns.downloadBtn,
    conflictingJob ? "Video operation in progress" : "Download Video",
  );

  if (!btns.trimBtn) return;
  btns.trimBtn.disabled =
    trimFinalizing || directDownloadBusy || actionPending ||
    (blobBusy && blobIntent !== "trim");
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
  previewBtn.hidden = !settings.showPreviewButton || !isImage;
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
  const eventTypes = ["pointerdown", "mousedown", "touchstart", "click", "dblclick"];
  eventTypes.forEach((type) => {
    group.addEventListener(type, (event) => event.stopPropagation());
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
      if (error.name !== "InvalidStateError") {
        console.warn("[Media Downloader] Controls could not be shown:", error);
      }
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
      if (error.name !== "InvalidStateError") {
        console.warn("[Media Downloader] Controls could not be hidden:", error);
      }
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
    button.hidden = !settings.showPreviewButton || media.tagName !== "IMG";
  });
}
