/**
 * imgDownloader Content Script
 * Injects download buttons onto images on the page.
 */

let settings = {
  buttonPosition: "top-right",
  downloadFolder: "",
  showSaveAs: false,
  showPreviewButton: true,
  minWidth: 150,
};

// SVG Icon for the download button
const DOWNLOAD_ICON = `
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
</svg>
`;

const PREVIEW_ICON = `
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5c-1.7-4.4-6-7.5-11-7.5zm0 12.5a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-2.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"/>
</svg>
`;

/**
 * Initialize the extension content script.
 */
function init() {
  // Load settings first
  chrome.storage.sync.get(
    {
      buttonPosition: "top-right",
      downloadFolder: "",
      showSaveAs: false,
      showPreviewButton: true,
      minWidth: 150,
    },
    (items) => {
      settings = items;
      if (hasForbiddenFolder(settings.downloadFolder)) {
        settings.downloadFolder = "";
        chrome.storage.sync.set({ downloadFolder: "" });
      }
      // Start processing existing images
      processAllImages();
      // Observe for new images
      startObserver();
    }
  );

  // Listen for setting changes
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync") {
      if (changes.buttonPosition) {
        settings.buttonPosition = changes.buttonPosition.newValue;
        updateAllButtonPositions();
      }
      if (changes.downloadFolder) {
        settings.downloadFolder = changes.downloadFolder.newValue;
      }
      if (changes.showSaveAs) {
        settings.showSaveAs = changes.showSaveAs.newValue;
      }
      if (changes.showPreviewButton) {
        settings.showPreviewButton = changes.showPreviewButton.newValue;
        updatePreviewButtonVisibility();
      }
      if (changes.minWidth) {
        settings.minWidth = changes.minWidth.newValue;
      }
    }
  });
}

function hasForbiddenFolder(folder) {
  return folder
    .split(/[\/\\]+/)
    .some((part) => part.toLowerCase() === "imgdownloader_files");
}

/**
 * Process all existing images on the page.
 */
function processAllImages() {
  const images = document.querySelectorAll("img");
  images.forEach(processImage);
}

/**
 * Start MutationObserver to detect new images.
 */
function startObserver() {
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === 1) {
          // Element
          if (node.tagName === "IMG") {
            processImage(node);
          } else {
            // Check children of added node
            const imgs = node.querySelectorAll("img");
            imgs.forEach(processImage);
          }
        }
      });
    });
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

/**
 * Update positions of all existing buttons.
 */
function updateAllButtonPositions() {
  const actionGroups = document.querySelectorAll(".imd-action-group");
  actionGroups.forEach((group) => {
    // Remove old pos classes
    group.classList.remove(
      "imd-pos-tl",
      "imd-pos-tr",
      "imd-pos-bl",
      "imd-pos-br",
      "imd-pos-center"
    );
    // Add new pos class
    group.classList.add(getPositionClass(settings.buttonPosition));
  });
}

function updatePreviewButtonVisibility() {
  const previewButtons = document.querySelectorAll(".imd-preview-btn");
  previewButtons.forEach((button) => {
    button.hidden = !settings.showPreviewButton;
  });
}

/**
 * Map setting value to CSS class.
 */
function getPositionClass(pos) {
  switch (pos) {
    case "top-left":
      return "imd-pos-tl";
    case "bottom-left":
      return "imd-pos-bl";
    case "bottom-right":
      return "imd-pos-br";
    case "center":
      return "imd-pos-center";
    default:
      return "imd-pos-tr"; // Top-Right
  }
}

/**
 * Check if image is suitable for a download button.
 */
function isValidImage(img) {
  // Ignore small icons/tracking pixels based on setting
  if (img.width < settings.minWidth || img.height < settings.minWidth)
    return false;
  // Ignore if already has a button (check sibling)
  if (img.dataset.imdProcessed) return false;
  return true;
}

/**
 * Create and inject the download button for a specific image.
 */
function processImage(img) {
  // Ensure image is loaded to check dimensions
  if (!img.complete) {
    img.addEventListener("load", () => processImage(img), { once: true });
    return;
  }

  if (!isValidImage(img)) return;

  // Mark as processed
  img.dataset.imdProcessed = "true";

  const actionGroup = document.createElement("div");
  actionGroup.className = `imd-action-group ${getPositionClass(settings.buttonPosition)}`;
  const downloadBtn = createActionButton(
    "imd-down-btn",
    "Download Image",
    DOWNLOAD_ICON
  );
  const previewBtn = createActionButton(
    "imd-preview-btn",
    "Preview highest resolution",
    PREVIEW_ICON
  );
  previewBtn.hidden = !settings.showPreviewButton;
  actionGroup.append(downloadBtn, previewBtn);

  // Prevent clicks from bubbling to links
  downloadBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    downloadImage(img);
  });

  previewBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    previewImage(img);
  });

  // Show button on hover (Logic for button visibility)
  // We rely on CSS: .imd-down-btn { opacity: 0; } and .imd-show { opacity: 1; }
  // We add event listeners to the IMG to toggle the button visibility
  // Because we are inserting the button as a sibling, we can't always rely on CSS sibling selector +
  // if there are text nodes in between. So JS events are safer.

  const showButtons = () => actionGroup.classList.add("imd-show");
  const hideButtons = () => actionGroup.classList.remove("imd-show");

  img.addEventListener("mouseenter", showButtons);
  img.addEventListener("mouseleave", (e) => {
    // delay hiding to allow moving to button
    if (!actionGroup.contains(e.relatedTarget)) {
      setTimeout(() => {
        if (!actionGroup.matches(":hover")) hideButtons();
      }, 100);
    }
  });

  actionGroup.addEventListener("mouseenter", showButtons);
  actionGroup.addEventListener("mouseleave", hideButtons);

  // Positioning Strategy: Relative to Container
  // We need to inject the button into the same container as the image.
  // We also need to ensure the container is positioned relatively so absolute works contextually.

  const parent = img.parentElement;
  if (parent) {
    const parentStyle = window.getComputedStyle(parent);
    if (parentStyle.position === "static") {
      parent.style.position = "relative";
    }

    // Inject button after image
    // Sometimes images are wrapped in <a> tags, this button will be inside the <a> but clicks stopped.
    // If the image is the only child, this is perfect.
    // If there are other siblings, we might overlap them, which is expected for an overlay.
    if (img.nextSibling) {
      parent.insertBefore(actionGroup, img.nextSibling);
    } else {
      parent.appendChild(actionGroup);
    }
  }
}

function createActionButton(className, title, icon) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `imd-action-btn ${className}`;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.innerHTML = icon;
  return button;
}

function previewImage(img) {
  const url = getHighestResolutionUrl(img);
  if (!url) {
    console.error("Image has no preview source.");
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function getHighestResolutionUrl(img) {
  const candidates = parseSrcset(img.getAttribute("srcset"));
  if (candidates.length > 0) {
    candidates.sort((a, b) => b.score - a.score);
    return new URL(candidates[0].url, document.baseURI).href;
  }
  return img.currentSrc || img.src;
}

function parseSrcset(srcset) {
  if (!srcset) return [];

  return srcset
    .split(",")
    .map((candidate) => {
      const parts = candidate.trim().split(/\s+/);
      const descriptor = parts[parts.length - 1];
      const match = descriptor.match(/^(\d+(?:\.\d+)?)(w|x)$/);
      return {
        url: match ? parts.slice(0, -1).join(" ") : parts.join(" "),
        score: match ? Number(match[1]) : 1,
      };
    })
    .filter((candidate) => candidate.url);
}

/**
 * Send download request to background script.
 */
function downloadImage(img) {
  const src = img.currentSrc || img.src;
  if (!src) {
    console.error("Image has no source.");
    return;
  }

  chrome.runtime.sendMessage({
    action: "download",
    url: src,
    folder: settings.downloadFolder,
    saveAs: settings.showSaveAs,
  });
}

// Run init
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
