import {
  settings, extensionActive, mediaMutationObserver, mediaControls,
  trackedMedia, capturedVideos, pipState, mediaHoverListeners,
  visibleMedia, popupVideoStatuses,
  setExtensionActive, setMediaMutationObserver,
} from './state.js';
import { createCaptureId } from './utils.js';
import { buildMediaActionButtons, attachActionGroup, hideActionGroup,
  isolateActionGroupEvents, getMediaHoverTargets, showActionGroup,
  setButtonLabel,
} from './action-ui.js';
import { isInstagramVideoPlayerMedia, syncInstagramNativeVideoControls,
  removeInstagramNativeVideoControls, applyStoryVideoFix, removeStoryVideoFix,
} from './instagram.js';
import { TRIM_ICON } from './constants.js';
import { downloadMedia, previewMedia, togglePictureInPicture,
  triggerTrim,
} from './media-download.js';
import { captureVideoFrame } from './capture-core.js';
import { copyImageToClipboard, copyVideoFrameToClipboard } from './clipboard.js';
import { openLightbox } from './lightbox.js';
import { showToast } from './toast.js';

export const mediaIntersectionObserver = new IntersectionObserver(
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

export const mediaResizeObserver = new ResizeObserver((entries) => {
  entries.forEach(({ target }) => {
    if (!target.dataset.imdProcessed) {
      processMedia(target);
      return;
    }
    const group = mediaControls.get(target);
    if (visibleMedia.has(target) && group?.classList.contains("imd-show")) {
      const rect = target.getBoundingClientRect();
      const width = group.offsetWidth || 86;
      const height = group.offsetHeight || 40;
      const gap = 10;
      let top, left;
      switch (settings.buttonPosition) {
        case "top-left": top = rect.top + gap; left = rect.left + gap; break;
        case "bottom-left": top = rect.bottom - height - gap; left = rect.left + gap; break;
        case "bottom-right": top = rect.bottom - height - gap; left = rect.right - width - gap; break;
        case "center": top = rect.top + (rect.height - height) / 2; left = rect.left + (rect.width - width) / 2; break;
        default: top = rect.top + gap; left = rect.right - width - gap;
      }
      group.style.top = `${Math.max(0, top)}px`;
      group.style.left = `${Math.max(0, left)}px`;
    }
  });
});

function isValidMedia(media) {
  const width = media.clientWidth || media.width;
  const height = media.clientHeight || media.height;
  if (width < settings.minWidth || height < settings.minWidth) return false;
  if (media.dataset.imdProcessed) return false;
  return true;
}

export function processMedia(media) {
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
      media.addEventListener("loadedmetadata", () => processMedia(media), { once: true });
    }
    return;
  }

  delete media.dataset.imdWaiting;
  media.dataset.imdProcessed = "true";
  if (!isImage && !media.dataset.imdCaptureId) {
    media.dataset.imdCaptureId = createCaptureId();
  }
  if (!isImage) capturedVideos.set(media.dataset.imdCaptureId, media);
  if (!isImage) syncInstagramNativeVideoControls(media);

  trackedMedia.set(media, isImage ? "image" : "video");

  if (settings.useContextMenu) return;

  const actionGroup = document.createElement("div");
  actionGroup.className = "imd-action-group";
  if (isInstagramVideoPlayerMedia(media)) {
    actionGroup.classList.add("imd-video-portal");
    actionGroup.popover = "manual";
  }
  isolateActionGroupEvents(actionGroup);
  const btns = buildMediaActionButtons(media);
  attachMediaActionHandlers(media, btns);
  actionGroup.append(...btns.buttons);

  const showButtons = () => { showActionGroup(actionGroup, media); };
  const hideButtons = () => hideActionGroup(actionGroup);

  const hoverTargets = getMediaHoverTargets(media);
  const hideTimer = { id: null };
  const scheduleHide = () => {
    if (hideTimer.id) clearTimeout(hideTimer.id);
    hideTimer.id = setTimeout(() => {
      hideTimer.id = null;
      const stillHovering = hoverTargets.some((t) => t.matches(":hover"));
      if (!stillHovering && !actionGroup.matches(":hover")) hideButtons();
    }, 100);
  };

  const hoverEntries = hoverTargets.map((target) => ({
    target, mouseenter: showButtons, mouseleave: scheduleHide,
  }));
  hoverEntries.forEach(({ target, mouseenter, mouseleave }) => {
    target.addEventListener("mouseenter", mouseenter);
    target.addEventListener("mouseleave", mouseleave);
  });
  mediaHoverListeners.set(media, { hoverEntries, hideTimer });

  actionGroup.addEventListener("mouseenter", showButtons);
  actionGroup.addEventListener("mouseleave", scheduleHide);

  if (btns.pipBtn) {
    const onEnterPip = () => { btns.pipBtn.hidden = true; };
    const onLeavePip = () => { btns.pipBtn.hidden = false; };
    media.addEventListener("enterpictureinpicture", onEnterPip);
    media.addEventListener("leavepictureinpicture", onLeavePip);
    pipState.set(media, { onEnterPip, onLeavePip });
    if (document.pictureInPictureElement === media) btns.pipBtn.hidden = true;
  }

  attachActionGroup(actionGroup);
  mediaControls.set(media, actionGroup);
}

export function attachMediaActionHandlers(media, btns) {
  btns.downloadBtn.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    downloadMedia(media).catch((error) => {
      console.error("Media download failed:", error);
      showToast(error?.message || "Download failed.");
    });
  });
  btns.previewBtn.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    previewMedia(media).catch((error) => {
      console.warn("[Media Downloader] Preview failed:", error);
      showToast(error?.message || "Preview failed.");
    });
  });
  btns.captureBtn?.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
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
        showToast(`Frame capture failed: ${error?.message || "unknown error"}`);
      });
  });
  btns.lightboxBtn?.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    openLightbox(media);
  });
  btns.pipBtn?.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    togglePictureInPicture(media);
  });
  btns.trimBtn?.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    triggerTrim(media, btns.trimBtn);
  });
  btns.copyBtn?.addEventListener("click", async (e) => {
    e.preventDefault(); e.stopPropagation();
    try {
      const isVideo = media.tagName === "VIDEO";
      const { copiedType } = isVideo
        ? await copyVideoFrameToClipboard(media)
        : await copyImageToClipboard(media);
      setButtonLabel(btns.copyBtn, "Copied!");
      showToast(copiedType ? `Copied to clipboard (${copiedType})` : "Copied to clipboard.");
      setTimeout(() => {
        setButtonLabel(btns.copyBtn, isVideo ? "Copy current frame to clipboard" : "Copy image to clipboard");
      }, 1500);
    } catch (error) {
      console.error("Copy to clipboard failed:", error);
      setButtonLabel(btns.copyBtn, "Copy failed");
      showToast("Copy to clipboard failed.");
    }
  });
}

export function cleanupMedia(media) {
  const group = mediaControls.get(media);
  if (group) group.remove();
  if (media.dataset.imdCaptureId) {
    capturedVideos.delete(media.dataset.imdCaptureId);
    popupVideoStatuses.delete(media.dataset.imdCaptureId);
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

export function trackMedia(media) {
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

export function processAllMedia() {
  document.querySelectorAll("img, video").forEach(trackMedia);
}

export function rebuildAllMedia() {
  document.querySelectorAll("img, video").forEach((media) => {
    if (mediaControls.has(media) || trackedMedia.has(media)) cleanupMedia(media);
  });
  processAllMedia();
}

export function startObserver() {
  if (mediaMutationObserver) return;
  const observer = new MutationObserver((mutations) => {
    const removedMedia = new Set();
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === 1) {
          if (node.matches("img, video")) trackMedia(node);
          else node.querySelectorAll("img, video").forEach(trackMedia);
        }
      });
      mutation.removedNodes.forEach((node) => {
        if (node.nodeType !== 1) return;
        if (node.matches("img, video")) removedMedia.add(node);
        node.querySelectorAll("img, video").forEach((m) => removedMedia.add(m));
      });
    });
    queueMicrotask(() => {
      removedMedia.forEach((media) => {
        if (!media.isConnected) cleanupMedia(media);
      });
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
  setMediaMutationObserver(observer);
}

export function updateVideoControls() {
  document.querySelectorAll("video").forEach((video) => {
    video.controls = settings.showVideoControls;
    applyStoryVideoFix(video);
    syncInstagramNativeVideoControls(video);
  });
}

export function findTrackedAncestor(el) {
  let node = el;
  while (node && node !== document.body) {
    if (trackedMedia.has(node)) return node;
    const found = node.querySelector?.("img[data-imd-media-type], video[data-imd-media-type]");
    if (found && trackedMedia.has(found)) return found;
    node = node.parentElement;
  }
  return null;
}

export function getMediaAtPoint(x, y) {
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
