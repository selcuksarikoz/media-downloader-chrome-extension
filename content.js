/**
 * imgDownloader Content Script
 * Injects download buttons onto images on the page.
 */

let settings = {
  buttonPosition: "top-right",
  downloadFolder: "imgDownloader_Files",
};

// SVG Icon for the download button
const DOWNLOAD_ICON = `
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
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
      downloadFolder: "imgDownloader_Files",
    },
    (items) => {
      settings = items;
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
    }
  });
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
  const buttons = document.querySelectorAll(".imd-down-btn");
  buttons.forEach((btn) => {
    // Remove old pos classes
    btn.classList.remove(
      "imd-pos-tl",
      "imd-pos-tr",
      "imd-pos-bl",
      "imd-pos-br",
      "imd-pos-center"
    );
    // Add new pos class
    btn.classList.add(getPositionClass(settings.buttonPosition));
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
  // Ignore small icons/tracking pixels
  if (img.width < 50 || img.height < 50) return false;
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

  // Create Button
  const btn = document.createElement("div");
  btn.className = `imd-down-btn ${getPositionClass(settings.buttonPosition)}`;
  btn.innerHTML = DOWNLOAD_ICON;
  btn.title = "Download Image";

  // Prevent clicks from bubbling to links
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    downloadImage(img);
  });

  // Show button on hover (Logic for button visibility)
  // We rely on CSS: .imd-down-btn { opacity: 0; } and .imd-show { opacity: 1; }
  // We add event listeners to the IMG to toggle the button visibility
  // Because we are inserting the button as a sibling, we can't always rely on CSS sibling selector +
  // if there are text nodes in between. So JS events are safer.

  const showBtn = () => btn.classList.add("imd-show");
  const hideBtn = () => btn.classList.remove("imd-show");

  img.addEventListener("mouseenter", showBtn);
  img.addEventListener("mouseleave", (e) => {
    // delay hiding to allow moving to button
    if (e.relatedTarget !== btn) {
      setTimeout(() => {
        if (!btn.matches(":hover")) hideBtn();
      }, 100);
    }
  });

  btn.addEventListener("mouseenter", showBtn);
  btn.addEventListener("mouseleave", hideBtn);

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
      parent.insertBefore(btn, img.nextSibling);
    } else {
      parent.appendChild(btn);
    }
  }
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
  });
}

// Run init
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
