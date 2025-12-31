// Saves options to chrome.storage
function saveOptions() {
  const position = document.getElementById("position").value;
  const folder = document.getElementById("folder").value;

  chrome.storage.sync.set(
    {
      buttonPosition: position,
      downloadFolder: folder,
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
    },
    (items) => {
      document.getElementById("position").value = items.buttonPosition;
      document.getElementById("folder").value = items.downloadFolder;
    }
  );
}

document.addEventListener("DOMContentLoaded", restoreOptions);
document.getElementById("save").addEventListener("click", saveOptions);
