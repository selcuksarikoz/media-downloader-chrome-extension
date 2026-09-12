import { settings } from './state.js';
import { getFrameCaptureFormat } from './utils.js';
import { downloadBlobFile } from './blob-status.js';
import { showToast } from './toast.js';
import { buildCroppedImage } from './crop-export.js';
import { MIN_CROP_SIZE_PX } from './constants.js';

/**
 * Manage the lightbox crop overlay: DOM creation, drag/resize interaction,
 * and the crop export flow. All lightbox DOM/state references are injected so
 * this module stays free of lightbox-internal state.
 */
export function createLightboxCropController(options) {
  const {
    stage, img, cropBtn, infoEl,
    getBaseInfo, exitZoom, toggleZoom,
    resolvedUrl, mediaUrl, corsClean, close,
  } = options;

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
    infoEl.textContent = cropActive ? infoCropText() : getBaseInfo();
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
          cancel();
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

  function start() {
    if (cropActive) return;
    if (!img.complete || !img.naturalWidth) {
      showToast("Wait for the image to finish loading.");
      return;
    }
    // Leave the zoomed state first so the crop overlay aligns 1:1 with
    // the displayed image.
    exitZoom();
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

  function cancel() {
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
    if (cropActive) cancel();
    else start();
  });

  /** Export the current crop region at full resolution. */
  async function save() {
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

  return {
    start,
    cancel,
    save,
    showOverlay: showCropOverlay,
    hideOverlay: hideCropOverlay,
    isActive: () => cropActive,
    refreshInfo: updateCropInfo,
  };
}
