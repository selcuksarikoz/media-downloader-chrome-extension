import { lightboxOpen, setLightboxOpen } from './state.js';
import { DOWNLOAD_ICON, PREVIEW_ICON, CROP_ICON } from './constants.js';
import { showToast } from './toast.js';
import { downloadMedia, previewMedia } from './media-download.js';
import { resolveHighestResolutionImageUrl } from './image-resolution.js';
import { createLightboxCropController } from './crop-overlay.js';
import { repositionOpenControls } from './action-ui.js';

/**
 * Open a full-size lightbox overlay for an image (or a captured video frame).
 * `url` is the display URL (data: URLs render reliably on every page).
 * `downloadUrl` is the original media URL used for downloads/previews.
 */
export async function openLightbox(media, url, downloadUrl, options = {}) {
  const revokeUnusedDownloadUrl = () => {
    if (options.revokeDownloadUrl && downloadUrl?.startsWith("blob:")) {
      URL.revokeObjectURL(downloadUrl);
    }
  };
  if (media.tagName !== "IMG" && !url) {
    revokeUnusedDownloadUrl();
    return false;
  }
  if (lightboxOpen) {
    revokeUnusedDownloadUrl();
    return false;
  }

  // Reserve the lightbox before resolving a remote image URL. Without this,
  // repeated clicks can create multiple full-page overlays; closing one then
  // leaves an invisible overlay intercepting every page interaction.
  setLightboxOpen(true);
  let overlay = null;
  let actions = null;
  let cleanup = null;
  try {
      const resolvedUrl = url || await resolveHighestResolutionImageUrl(media);
      if (!resolvedUrl) {
        setLightboxOpen(false);
        revokeUnusedDownloadUrl();
        return false;
      }
      const mediaUrl = downloadUrl || resolvedUrl;

      document.querySelectorAll(".imd-lightbox-btn").forEach((btn) => {
        btn.hidden = true;
      });

      overlay = document.createElement("div");
      overlay.className = "imd-lightbox-overlay";

      const container = document.createElement("div");
      container.className = "imd-lightbox-container";

      const stage = document.createElement("div");
      stage.className = "imd-lightbox-stage";

      const img = document.createElement("img");
      img.className = "imd-lightbox-image";
      img.alt = media.alt || "";
      img.decoding = "async";
      // Load the image CORS-enabled so the crop export can draw it straight
      // from the canvas-taint-free element (no refetch). If the server has no
      // CORS headers the load fails; retry without crossOrigin and remember
      // the canvas will be tainted.
      let corsClean = true;
      let retriedWithoutCors = false;
      img.addEventListener("error", () => {
        if (!retriedWithoutCors && img.crossOrigin) {
          retriedWithoutCors = true;
          corsClean = false;
          img.crossOrigin = null;
          img.src = resolvedUrl;
          return;
        }
        showToast("Image could not be loaded.");
        close();
      });
      img.crossOrigin = "anonymous";
      img.src = resolvedUrl;

      stage.appendChild(img);
      container.appendChild(stage);
      overlay.appendChild(container);

      actions = document.createElement("div");
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
        crop?.refreshInfo();
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
          startCrop?.();
        },
        { once: true },
      );
      actions.querySelector(".imd-down-btn").addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (crop?.isActive()) {
          crop.save();
          return;
        }
        e.currentTarget.disabled = true;
        const downloadPromise = downloadMedia(img, mediaUrl);
        // Do not keep a full-page overlay mounted while Chrome accepts the
        // download. Owned blob URLs remain valid for the cleanup grace period.
        close();
        try {
          await downloadPromise;
        } catch (error) {
          console.warn("[Media Downloader] Download could not be started:", error);
          showToast(error?.message || "Download failed.");
        }
      });
      actions
        .querySelector(".imd-preview-btn")
        .addEventListener("click", async (e) => {
          e.preventDefault();
          e.stopPropagation();
          e.currentTarget.disabled = true;
          const previewPromise = previewMedia(img, mediaUrl);
          close();
          try {
            await previewPromise;
          } catch (error) {
            console.warn("[Media Downloader] Image preview failed:", error);
            showToast(error?.message || "Preview failed.");
          }
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
          e.preventDefault();
          e.stopImmediatePropagation();
          close();
        }
      };
      document.addEventListener("keydown", escHandler, true);

      // ---------------------------------------------------------------------
      // Crop
      // ---------------------------------------------------------------------
      const cropBtn = actions.querySelector(".imd-crop-btn");
      let startCrop;
      const crop = createLightboxCropController({
        stage,
        img,
        cropBtn,
        infoEl,
        getBaseInfo: () => infoText,
        exitZoom: () => {
          if (lightboxZoomed) {
            lightboxZoomed = false;
            lightboxZoomLevel = 1;
            applyZoom();
          }
        },
        toggleZoom,
        resolvedUrl,
        mediaUrl,
        corsClean,
        close,
      });
      startCrop = crop.start;

      let closed = false;
      cleanup = () => {
        if (closed) return;
        closed = true;
        try {
          crop.cancel();
        } catch (error) {
          console.warn("[Media Downloader] Crop cleanup failed:", error);
        }
        infoAbort.abort();
        document.removeEventListener("keydown", escHandler, true);
        overlay.removeEventListener("scroll", repositionOpenControls);
        const activeElement = document.activeElement;
        if (actions.contains(activeElement)) activeElement.blur();
        overlay.remove();
        actions.remove();
        setLightboxOpen(false);
        if (options.revokeDownloadUrl && mediaUrl.startsWith("blob:")) {
          setTimeout(() => URL.revokeObjectURL(mediaUrl), 60_000);
        }
        document.querySelectorAll(".imd-lightbox-btn").forEach((btn) => {
          btn.hidden = false;
        });
        lightboxZoomed = false;
        lightboxZoomLevel = 1;
      };

      function close() {
        cleanup();
      }

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
          if (crop.isActive()) crop.showOverlay();
        } else {
          lightboxZoomed = true;
          lightboxZoomLevel = 1;
          applyZoom(getZoomOrigin(e));
          if (crop.isActive()) crop.hideOverlay();
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
                if (crop.isActive()) crop.showOverlay();
              }
              return;
            }
            if (!lightboxZoomed) {
              lightboxZoomed = true;
              lightboxZoomLevel = 1;
            }
            applyZoom(e.deltaY < 0 ? getZoomOrigin(e) : null);
            if (crop.isActive()) crop.hideOverlay();
          }
        },
        { passive: false },
      );
      return true;
  } catch (error) {
    cleanup?.();
    overlay?.remove();
    actions?.remove();
    setLightboxOpen(false);
    revokeUnusedDownloadUrl();
    console.warn("[Media Downloader] Lightbox could not be opened:", error);
    showToast("Image could not be opened.");
    return false;
  }
}
