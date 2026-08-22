import {
  settings,
  extensionActive,
  setExtensionActive,
  mediaMutationObserver,
  setMediaMutationObserver,
  setSettings,
  mediaControls,
  trackedMedia,
} from './state.js';
import { DEFAULT_SETTINGS, BLOB_STATUS_EVENT, CAPTURE_FROM_MSE_RESULT_EVENT } from './constants.js';
import { hasForbiddenFolder } from './utils.js';
import {
  rebuildAllMedia,
  startObserver,
  updateVideoControls,
  processAllMedia,
  cleanupMedia,
  trackMedia,
} from './media-tracking.js';
import { updateAllButtonPositions, updatePreviewButtonVisibility } from './action-ui.js';
import { closeContextMenu } from './context-menu.js';
import {
  applyAutoPictureInPictureSetting,
  initAutoPictureInPicture,
} from './auto-pip.js';
import './blob-store.js';
import './blob-mux.js';
import './blob-status.js';
import './nav-guards.js';
import './messaging.js';
import './context-menu.js';
import './media-tracking.js';

function init() {
  chrome.storage.sync.get(DEFAULT_SETTINGS, (items) => {
    setSettings(items);
    if (hasForbiddenFolder(settings.downloadFolder)) {
      setSettings({ ...settings, downloadFolder: "" });
      chrome.storage.sync.set({ downloadFolder: "" });
    }
    applyDomainAccess();
    initAutoPictureInPicture();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    Object.entries(changes).forEach(([key, change]) => {
      settings[key] = change.newValue;
    });
    if (changes.buttonPosition) updateAllButtonPositions();
    if (changes.showPreviewButton) updatePreviewButtonVisibility();
    if (changes.showVideoControls) updateVideoControls();
    if (changes.blacklistedDomains) applyDomainAccess();
    if (changes.useContextMenu) {
      closeContextMenu();
      rebuildAllMedia();
    }
    if (changes.autoPictureInPicture) {
      applyAutoPictureInPictureSetting();
    }
  });
}

/** Check if the current domain is in the blacklist. */
function isCurrentDomainBlacklisted() {
  const hostname = location.hostname.toLowerCase().replace(/\.$/, "");
  const domains = Array.isArray(settings.blacklistedDomains)
    ? settings.blacklistedDomains
    : [];
  return domains.some((domain) => {
    if (typeof domain !== "string") return false;
    const normalized = domain
      .toLowerCase()
      .replace(/^\*\./, "")
      .replace(/^www\./, "")
      .replace(/\.$/, "");
    return (
      normalized &&
      (hostname === normalized || hostname.endsWith(`.${normalized}`))
    );
  });
}

/** Enable or disable in-page media controls based on the domain blacklist. */
function applyDomainAccess() {
  const shouldBeActive = !isCurrentDomainBlacklisted();
  if (shouldBeActive === extensionActive) return;
  setExtensionActive(shouldBeActive);
  if (extensionActive) {
    processAllMedia();
    startObserver();
    applyAutoPictureInPictureSetting();
    return;
  }

  mediaMutationObserver?.disconnect();
  setMediaMutationObserver(null);
  applyAutoPictureInPictureSetting();
  document.querySelectorAll("img, video").forEach((media) => {
    cleanupMedia(media);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
