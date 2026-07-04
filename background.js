chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message.url) return;
  if (message.action === "download") {
    downloadMedia(message);
    return;
  }
  if (message.action === "preview") {
    const createProperties = { url: message.url, active: false };
    if (sender.tab) {
      createProperties.windowId = sender.tab.windowId;
      createProperties.index = sender.tab.index + 1;
    }
    chrome.tabs.create(createProperties, () => {
      if (chrome.runtime.lastError) {
        console.error("Preview failed:", chrome.runtime.lastError.message);
      }
    });
  }
});

function downloadMedia({ url, folder, saveAs, mediaType }) {
  let filename = getFilenameFromUrl(url, mediaType);

  if (typeof folder === "string") {
    folder = folder.trim().replace(/^[\/\\]+|[\/\\]+$/g, "");
    if (folder && !hasForbiddenFolder(folder)) filename = `${folder}/${filename}`;
  }

  chrome.downloads.download(
    {
      url,
      filename,
      saveAs: saveAs === true,
      conflictAction: "overwrite",
    },
    () => {
      if (chrome.runtime.lastError) {
        console.error("Download failed:", chrome.runtime.lastError.message);
      }
    }
  );
}

function hasForbiddenFolder(folder) {
  return folder
    .split(/[\/\\]+/)
    .some((part) => part.toLowerCase() === "imgdownloader_files");
}

function getFilenameFromUrl(url, mediaType = "image") {
  const fallbackExtension = mediaType === "video" ? "mp4" : "jpg";
  const fallbackName = () =>
    `${mediaType}-${Date.now()}.${fallbackExtension}`;

  if (url.startsWith("data:")) {
    const mime = url.match(/data:([^;]*);/);
    const extension = mime ? mime[1].split("/")[1] : fallbackExtension;
    return `${mediaType}-${Date.now()}.${extension}`;
  }

  try {
    const pathname = new URL(url).pathname;
    let name = pathname.slice(pathname.lastIndexOf("/") + 1);
    if (!name) return fallbackName();
    name = decodeURIComponent(name);
    name = name.replace(/[^a-zA-Z0-9.\-_]/g, "_");
    if (!name.includes(".")) name += `.${fallbackExtension}`;
    return name;
  } catch {
    return fallbackName();
  }
}
