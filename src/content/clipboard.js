import { settings } from './state.js';
import { getFrameCaptureFormat, getClipboardImageFormat } from './utils.js';
import { captureVideoFrameBlobWithFallbacks } from './capture-core.js';
import { resolveHighestResolutionImageUrl } from './image-resolution.js';
import { fetchImageBlob, fetchImageBlobViaBackground } from './media-fetch.js';

export async function copyImageToClipboard(image) {
  const url = await resolveHighestResolutionImageUrl(image);
  let blob;
  try {
    blob = await fetchImageBlob(url);
  } catch (error) {
    blob = await fetchImageBlobViaBackground(url);
  }
  const copiedType = await copyBlobToClipboard(blob);
  return { copiedType };
}

export async function copyVideoFrameToClipboard(video) {
  const preferredFormat = getFrameCaptureFormat(settings.captureType);
  const clipboardFormat = getClipboardImageFormat(preferredFormat);
  const blob = await captureVideoFrameBlobWithFallbacks(
    video,
    clipboardFormat.extension,
  );
  const copiedType = await copyBlobToClipboard(blob);
  return { copiedType };
}

/** Write an image blob to the system clipboard. */
async function copyBlobToClipboard(blob) {
  if (
    !navigator.clipboard ||
    typeof navigator.clipboard.write !== "function" ||
    typeof ClipboardItem === "undefined"
  ) {
    throw new Error(
      "Clipboard is not available on this page (an HTTPS page is required).",
    );
  }

  let type = blob.type || "";
  if (
    !type ||
    (typeof ClipboardItem.supports === "function" &&
      !ClipboardItem.supports(type))
  ) {
    blob = await convertImageBlobToPng(blob);
    type = "image/png";
  }

  await navigator.clipboard.write([new ClipboardItem({ [type]: blob })]);
  return type.split("/")[1].replace("jpeg", "jpg");
}

/** Re-encode any image blob into a PNG blob. */
async function convertImageBlobToPng(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (png) =>
        png ? resolve(png) : reject(new Error("PNG conversion failed.")),
      "image/png",
    );
  });
}
