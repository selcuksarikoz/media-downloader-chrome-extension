/**
 * Build options for chrome.downloads.download.
 *
 * Chromium treats a supplied filename as a path relative to the configured
 * Downloads directory. In Brave this also makes the Save As dialog start in
 * that directory on every call. Omitting filename while prompting lets the
 * browser reuse its last Save As location instead.
 */
export function buildBrowserDownloadOptions({
  url,
  filename,
  saveAs,
  conflictAction = "overwrite",
}) {
  const options = {
    url,
    saveAs: saveAs === true,
    conflictAction,
  };

  if (!options.saveAs && typeof filename === "string" && filename) {
    options.filename = filename;
  }

  return options;
}
