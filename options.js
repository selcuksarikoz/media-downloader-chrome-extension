const DEFAULTS = {
  buttonPosition: "top-right",
  downloadFolder: "",
  showSaveAs: false,
  showPreviewButton: true,
  showVideoControls: true,
  captureType: "jpg",
  minWidth: 150,
  maxConcurrentDownloads: 5,
};
const get = (id) => document.getElementById(id);

function saveOptions() {
  const requestedFolder = get("folder").value.trim();
  const folder = hasForbiddenFolder(requestedFolder) ? "" : requestedFolder;

  chrome.storage.sync.set(
    {
      buttonPosition: get("position").value,
      downloadFolder: folder,
      showSaveAs: get("saveAs").checked,
      showPreviewButton: get("showPreview").checked,
      showVideoControls: get("showVideoControls").checked,
      captureType: get("captureType").value,
      minWidth: parseInt(get("minWidth").value, 10) || DEFAULTS.minWidth,
      maxConcurrentDownloads: Math.min(
        10,
        Math.max(
          1,
          parseInt(get("maxConcurrent").value, 10) ||
            DEFAULTS.maxConcurrentDownloads
        )
      ),
    },
    () => {
      get("status").textContent = "Options saved.";
      setTimeout(() => (get("status").textContent = ""), 2000);
    }
  );
}

function restoreOptions() {
  chrome.storage.sync.get(DEFAULTS, (items) => {
    const folder = hasForbiddenFolder(items.downloadFolder)
      ? ""
      : items.downloadFolder;
    get("position").value = items.buttonPosition;
    get("folder").value = folder;
    get("saveAs").checked = items.showSaveAs;
    get("showPreview").checked = items.showPreviewButton;
    get("showVideoControls").checked = items.showVideoControls;
    get("captureType").value = ["jpg", "png", "webp"].includes(
      items.captureType
    )
      ? items.captureType
      : DEFAULTS.captureType;
    get("minWidth").value = items.minWidth;
    get("maxConcurrent").value = items.maxConcurrentDownloads;
    if (folder !== items.downloadFolder) {
      chrome.storage.sync.set({ downloadFolder: "" });
    }
  });
}

function hasForbiddenFolder(folder) {
  return folder
    .trim()
    .split(/[\/\\]+/)
    .some((part) => part.toLowerCase() === "imgdownloader_files");
}

document.addEventListener("DOMContentLoaded", restoreOptions);
get("save").addEventListener("click", saveOptions);
