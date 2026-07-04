// Saves options to chrome.storage
function saveOptions() {
  const position = document.getElementById("position").value;
  const requestedFolder = document.getElementById("folder").value.trim();
  const folder = hasForbiddenFolder(requestedFolder) ? "" : requestedFolder;
  const saveAs = document.getElementById("saveAs").checked;
  const showPreview = document.getElementById("showPreview").checked;
  const showVideoControls = document.getElementById(
    "showVideoControls"
  ).checked;
  const minWidth = document.getElementById("minWidth").value;
  const maxConcurrent = document.getElementById("maxConcurrent").value;

  chrome.storage.sync.set(
    {
      buttonPosition: position,
      downloadFolder: folder,
      showSaveAs: saveAs,
      showPreviewButton: showPreview,
      showVideoControls,
      minWidth: parseInt(minWidth, 10) || 150,
      maxConcurrentDownloads: Math.min(
        10,
        Math.max(1, parseInt(maxConcurrent, 10) || 5)
      ),
    },
    () => {
      // Update status to let user know options were saved.
      const status = document.getElementById("status");
      status.textContent = "Options saved successfully!";
      setTimeout(() => {
        status.textContent = "";
      }, 2000);
    }
  );
}

// Restores select box and text fields using the preferences stored in chrome.storage.
function restoreOptions() {
  chrome.storage.sync.get(
    {
      buttonPosition: "top-right", // Default value
      downloadFolder: "", // Empty means the default Downloads folder
      showSaveAs: false, // Default value
      showPreviewButton: true,
      showVideoControls: true,
      minWidth: 150, // Default value
      maxConcurrentDownloads: 5,
    },
    (items) => {
      document.getElementById("position").value = items.buttonPosition;
      const folder = hasForbiddenFolder(items.downloadFolder)
        ? ""
        : items.downloadFolder;
      document.getElementById("folder").value = folder;
      if (folder !== items.downloadFolder) {
        chrome.storage.sync.set({ downloadFolder: "" });
      }
      document.getElementById("saveAs").checked = items.showSaveAs;
      document.getElementById("showPreview").checked =
        items.showPreviewButton;
      document.getElementById("showVideoControls").checked =
        items.showVideoControls;
      document.getElementById("minWidth").value = items.minWidth;
      document.getElementById("maxConcurrent").value =
        items.maxConcurrentDownloads;
    }
  );
}

function hasForbiddenFolder(folder) {
  return folder
    .trim()
    .split(/[\/\\]+/)
    .some((part) => part.toLowerCase() === "imgdownloader_files");
}

document.addEventListener("DOMContentLoaded", restoreOptions);
document.getElementById("save").addEventListener("click", saveOptions);
