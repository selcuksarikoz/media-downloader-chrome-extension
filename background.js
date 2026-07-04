/**
 * Media Downloader background script.
 * Handles image and video downloading via chrome.downloads API.
 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "download" && message.url) {
    downloadMedia(
      message.url,
      message.folder,
      message.saveAs,
      message.mediaType
    );
  }
});

function downloadMedia(url, folder, saveAs, mediaType) {
  let filename = getFilenameFromUrl(url, mediaType);

  // An empty folder means the browser's default Downloads directory.
  // Never recreate the folder used by older extension versions.
  if (typeof folder === "string") {
    folder = folder.trim().replace(/^[\/\\]+|[\/\\]+$/g, "");
    const hasForbiddenFolder = folder
      .split(/[\/\\]+/)
      .some((part) => part.toLowerCase() === "imgdownloader_files");
    if (folder && !hasForbiddenFolder) {
      filename = `${folder}/${filename}`;
    }
  }

  chrome.downloads.download(
    {
      url: url,
      filename: filename,
      saveAs: saveAs === true,
      conflictAction: "uniquify",
    },
    (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error("Download failed:", chrome.runtime.lastError.message);
      } else {
        console.log("Download started, ID:", downloadId);
      }
    }
  );
}

function getFilenameFromUrl(url, mediaType = "image") {
  const fallbackExtension = mediaType === "video" ? "mp4" : "jpg";
  const fallbackName = () =>
    `${mediaType}-${Date.now()}.${fallbackExtension}`;

  // Handle Data URIs
  if (url.startsWith("data:")) {
    const mime = url.match(/data:([^;]*);/);
    const extension = mime ? mime[1].split("/")[1] : fallbackExtension;
    return `${mediaType}-${Date.now()}.${extension}`;
  }

  // Handle standard URLs
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    let name = pathname.substring(pathname.lastIndexOf("/") + 1);

    // Remove query strings or extra chars if simple extraction failed or included them (pathname usually doesn't have query)
    // But sometimes pathname ends in nothing or /.
    if (!name || name === "/") {
      name = fallbackName();
    }

    // Decode URI component (e.g. %20 -> space)
    name = decodeURIComponent(name);

    // Basic sanitization
    name = name.replace(/[^a-zA-Z0-9.\-_]/g, "_");

    // Keep a usable extension when the source path has none.
    if (!name.includes(".")) {
      name += `.${fallbackExtension}`;
    }

    return name;
  } catch (e) {
    // Fallback
    return fallbackName();
  }
}
