import { fetchImageBlob, fetchImageBlobViaBackground } from './media-fetch.js';

/** Detect the best output format for a cropped image. Uses the option
 * format when set, otherwise mirrors the source image's format. */
export function getImageCropFormat(url, preferredFormat) {
  if (preferredFormat?.mimeType) {
    return {
      mimeType: preferredFormat.mimeType,
      extension: preferredFormat.extension || "jpg",
      quality: preferredFormat.quality ?? null,
    };
  }
  let ext = "";
  if (url.startsWith("data:")) {
    ext = (url.match(/^data:image\/([a-z0-9.+-]+)/i)?.[1] || "").toLowerCase();
  } else {
    try {
      ext = (
        new URL(url).pathname.match(/\.([a-z0-9]+)(?:\?|$)/i)?.[1] || ""
      ).toLowerCase();
    } catch {}
  }
  if (ext === "png") return { mimeType: "image/png", extension: "png", quality: null };
  if (ext === "webp") return { mimeType: "image/webp", extension: "webp", quality: 0.95 };
  return { mimeType: "image/jpeg", extension: "jpg", quality: 0.95 };
}

/** Load an image blob into a same-origin <img> for taint-free canvas drawing. */
function loadImageFromBlob(blob) {
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve({ image, url });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Retrieved image could not be decoded."));
    };
    image.src = url;
  });
}

/** Build a unique filename for a cropped image export (no "crop" suffix). */
export function getCropFilename(url, extension) {
  let base = `image-${Date.now()}`;
  if (!url.startsWith("data:")) {
    try {
      const pathname = new URL(url).pathname;
      const name = pathname.slice(pathname.lastIndexOf("/") + 1);
      if (name) {
        base = decodeURIComponent(name).replace(/[^a-zA-Z0-9.\-_]/g, "_");
        base = base.replace(/\.[^.]+$/, "");
      }
    } catch {}
  }
  return `${base || "image"}.${extension}`;
}

/**
 * Render the crop region at the image's full original resolution.
 * When the lightbox image was loaded CORS-clean (crossOrigin + ACAO headers)
 * it is drawn straight from the on-screen element — no refetch at all. Only
 * if the lightbox image is tainted are fetches attempted (page fetch, then
 * background bypass) to obtain a clean copy.
 */
export function buildCroppedImage(img, url, cropRect, preferredFormat, corsClean) {
  const { mimeType, extension, quality } = getImageCropFormat(
    url,
    preferredFormat,
  );

  const render = (source) => {
    const width = Math.max(1, source.naturalWidth);
    const height = Math.max(1, source.naturalHeight);
    const x = Math.round(cropRect.x * width);
    const y = Math.round(cropRect.y * height);
    const cropW = Math.max(
      1,
      Math.min(width - x, Math.round(cropRect.w * width)),
    );
    const cropH = Math.max(
      1,
      Math.min(height - y, Math.round(cropRect.h * height)),
    );

    const canvas = document.createElement("canvas");
    canvas.width = cropW;
    canvas.height = cropH;
    const context = canvas.getContext("2d");
    context.drawImage(source, x, y, cropW, cropH, 0, 0, cropW, cropH);

    return new Promise((resolve, reject) => {
      try {
        canvas.toBlob((blob) => {
          if (!blob) {
            reject(new Error("Cropped image could not be encoded."));
            return;
          }
          resolve({
            blob,
            filename: getCropFilename(url, extension),
            width: cropW,
            height: cropH,
          });
        }, mimeType, quality);
      } catch (error) {
        reject(
          new Error(
            "Protected (CORS) image cannot be re-read for cropping.",
          ),
        );
      }
    });
  };

  if (corsClean) return render(img);

  return Promise.resolve()
    .then(() => fetchImageBlob(url))
    .catch(() => fetchImageBlobViaBackground(url))
    .then((blob) => (blob ? loadImageFromBlob(blob) : null))
    .then((source) => {
      if (source) {
        try {
          return render(source.image);
        } finally {
          URL.revokeObjectURL(source.url);
        }
      }
      return render(img);
    });
}
