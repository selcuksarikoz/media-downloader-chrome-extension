/**
 * imgDownloader Background Script
 * Handles image downloading via chrome.downloads API.
 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "download" && message.url) {
    downloadImage(message.url, message.folder, message.saveAs);
  }
});

function downloadImage(url, folder, saveAs) {
  let filename = getFilenameFromUrl(url);

  // Ensure the folder path.
  // Chrome downloads API treats / as subdirectory separator.
  // Remove leading/trailing slashes from folder name just in case.
  if (folder) {
    folder = folder.replace(/^[\/\\]+|[\/\\]+$/g, "");
    if (folder.length > 0) {
      // Check length after trim
      filename = `${folder}/${filename}`;
    }
  }

  chrome.downloads.download(
    {
      url: url,
      filename: filename,
      saveAs: !!saveAs, // Force boolean
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

function getFilenameFromUrl(url) {
  // Handle Data URIs
  if (url.startsWith("data:")) {
    const mime = url.match(/data:([^;]*);/);
    const extension = mime ? mime[1].split("/")[1] : "png";
    return `image-${Date.now()}.${extension}`;
  }

  // Handle standard URLs
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    let name = pathname.substring(pathname.lastIndexOf("/") + 1);

    // Remove query strings or extra chars if simple extraction failed or included them (pathname usually doesn't have query)
    // But sometimes pathname ends in nothing or /.
    if (!name || name === "/") {
      name = `image-${Date.now()}.jpg`;
    }

    // Decode URI component (e.g. %20 -> space)
    name = decodeURIComponent(name);

    // Basic sanitization
    name = name.replace(/[^a-zA-Z0-9.\-_]/g, "_");

    // If no extension, try to guess or default to jpg?
    // Chrome might handle it, but it's safer to have one.
    if (!name.includes(".")) {
      name += ".jpg";
    }

    return name;
  } catch (e) {
    // Fallback
    return `image-${Date.now()}.jpg`;
  }
}
