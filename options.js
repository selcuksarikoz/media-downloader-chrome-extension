// Saves options to chrome.storage
function saveOptions() {
  const position = document.getElementById("position").value;
  const folder = document.getElementById("folder").value;
  const saveAs = document.getElementById("saveAs").checked;
  const minWidth = document.getElementById("minWidth").value;

  chrome.storage.sync.set(
    {
      buttonPosition: position,
      downloadFolder: folder,
      showSaveAs: saveAs,
      minWidth: parseInt(minWidth, 10) || 150,
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
      downloadFolder: "imgDownloader_Files", // Default value
      showSaveAs: false, // Default value
      minWidth: 150, // Default value
    },
    (items) => {
      document.getElementById("position").value = items.buttonPosition;
      document.getElementById("folder").value = items.downloadFolder;
      document.getElementById("saveAs").checked = items.showSaveAs;
      document.getElementById("minWidth").value = items.minWidth;
    }
  );
}

document.addEventListener("DOMContentLoaded", restoreOptions);
document.getElementById("save").addEventListener("click", saveOptions);
