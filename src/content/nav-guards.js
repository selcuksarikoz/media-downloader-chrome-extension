import {
  NAVIGATION_BLOCKED_EVENT, DOWNLOAD_NAVIGATION_WARNING,
} from './constants.js';
import {
  blobDownloadRequests, activeBlobJobIds, activeIndependentMuxes,
  activeMuxWorkers,
} from './state.js';
import { showToast } from './toast.js';

function hasActivePageDownload() {
  return (
    blobDownloadRequests.size > 0 ||
    activeBlobJobIds.size > 0 ||
    activeIndependentMuxes.size > 0 ||
    activeMuxWorkers.size > 0
  );
}

function warnDownloadNavigationBlocked() {
  showToast(DOWNLOAD_NAVIGATION_WARNING);
}

window.addEventListener("beforeunload", (event) => {
  if (!hasActivePageDownload()) return;
  event.preventDefault();
  event.returnValue = "";
});

window.addEventListener(NAVIGATION_BLOCKED_EVENT, warnDownloadNavigationBlocked);

document.addEventListener(
  "click",
  (event) => {
    if (!hasActivePageDownload()) return;
    const anchor = event.target.closest?.("a[href]");
    if (!anchor || anchor.hasAttribute("download")) return;
    if (anchor.target && anchor.target.toLowerCase() === "_blank") return;
    let destination;
    try {
      destination = new URL(anchor.href, location.href);
    } catch {
      return;
    }
    if (destination.href === location.href) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    warnDownloadNavigationBlocked();
  },
  true,
);

document.addEventListener(
  "submit",
  (event) => {
    if (!hasActivePageDownload()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    warnDownloadNavigationBlocked();
  },
  true,
);

document.addEventListener(
  "keydown",
  (event) => {
    if (!hasActivePageDownload()) return;
    const reloadShortcut =
      event.key === "F5" ||
      ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r");
    if (!reloadShortcut) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    warnDownloadNavigationBlocked();
  },
  true,
);
