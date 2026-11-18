import { ACTIVE_DOWNLOAD_STATES } from "./constants.js";

/**
 * Keep the download button's busy state identical on hover controls and in the
 * custom context menu. Trim buttons keep their own richer, surface-specific
 * labels and are intentionally not handled here.
 */
export function setDownloadButtonsBusy(buttons, status) {
  const isActive = ACTIVE_DOWNLOAD_STATES.has(status);
  buttons.forEach((button) => {
    button.title = isActive ? "Video download in progress" : "Download Video";
    button.setAttribute("aria-label", button.title);
    button.classList.toggle("imd-recording", isActive);
    button.disabled = isActive;
  });
}
