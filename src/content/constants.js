export const DEFAULT_BLACKLISTED_DOMAINS = [
  "netflix.com",
  "primevideo.com",
  "disneyplus.com",
  "hbo.com",
  "hbomax.com",
  "max.com",
  "paramountplus.com",
  "hulu.com",
  "peacocktv.com",
  "discoveryplus.com",
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
];

export const DEFAULT_SETTINGS = {
  buttonPosition: "top-right",
  downloadFolder: "",
  showSaveAs: false,
  showPreviewButton: true,
  showVideoControls: true,
  captureType: "jpg",
  blacklistedDomains: [...DEFAULT_BLACKLISTED_DOMAINS],
  minWidth: 150,
  useContextMenu: false,
};

export const ACTIVE_DOWNLOAD_STATES = new Set(["recording", "progress"]);

export const FFMPEG_HOST_CHANNEL = "imd:ffmpeg-host";
export const BLOB_DOWNLOAD_EVENT = "imd:download-blob-video";
export const BLOB_TRIM_EVENT = "imd:trim-blob-video";
export const BLOB_CONTROL_EVENT = "imd:control-blob-video";
export const BLOB_STATUS_EVENT = "imd:blob-video-status";
export const BLOB_DATA_EVENT = "imd:blob-data-for-download";
export const PAGE_MEDIA_DOWNLOAD_EVENT = "imd:download-page-media";
export const BLOB_PERSIST_CHUNK_EVENT = "imd:persist-blob-chunk";
export const BLOB_MUX_EVENT = "imd:mux-blob-tracks";
export const BLOB_MUX_RESULT_EVENT = "imd:mux-blob-tracks-result";
export const NAVIGATION_BLOCKED_EVENT = "imd:navigation-blocked";
export const CAPTURE_BLOCK_EVENT = "imd:capture-block";
export const CAPTURE_UNBLOCK_EVENT = "imd:capture-unblock";
export const CAPTURE_FROM_MSE_EVENT = "imd:capture-from-mse";
export const CAPTURE_FROM_MSE_RESULT_EVENT = "imd:capture-from-mse-result";
export const BLOB_STORE_PORT_NAME = "imd-blob-store";
export const FETCH_MEDIA_PORT_NAME = "imd-fetch-media";

export const DOWNLOAD_NAVIGATION_WARNING =
  "You cannot leave or reload this page while a download is in progress. " +
  "Wait for it to finish or cancel the download.";

export const MIN_CROP_SIZE_PX = 24;

export const DOWNLOAD_ICON = `
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
</svg>
`;

export const PREVIEW_ICON = `
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5c-1.7-4.4-6-7.5-11-7.5zm0 12.5a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-2.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"/>
</svg>
`;

export const CAPTURE_ICON = `
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M17 7h-1.2l-1.1-2H9.3L8.2 7H7a3 3 0 0 0-3 3v6a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-6a3 3 0 0 0-3-3zm-5 9a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/>
</svg>
`;

export const PIP_ICON = `
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M19 7h-8v6h8V7zm2-4H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H3V5h18v14z"/>
</svg>
`;

export const LIGHTBOX_ICON = `
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M13 2L4 14h6l-2 8 9-12h-6l2-8z"/>
</svg>
`;

export const CROP_ICON = `
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M17 15h2V7c0-1.1-.9-2-2-2H9v2h8v8zM7 17V1H5v4H1v2h4v10c0 1.1.9 2 2 2h10v4h2v-4h4v-2H7z"/>
</svg>
`;

export const TRIM_ICON = `
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M9.64 7.64c.23-.5.36-1.05.36-1.64 0-2.21-1.79-4-4-4S2 3.79 2 6s1.79 4 4 4c.59 0 1.14-.13 1.64-.36L10 12l-2.36 2.36C7.14 14.13 6.59 14 6 14c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4c0-.59-.13-1.14-.36-1.64L12 14l7 7h3v-1L9.64 7.64zM6 8c-1.1 0-2-.89-2-2s.9-2 2-2 2 .89 2 2-.9 2-2 2zm0 12c-1.1 0-2-.89-2-2s.9-2 2-2 2 .89 2 2-.9 2-2 2zm6-7.5c-.28 0-.5-.22-.5-.5s.22-.5.5-.5.5.22.5.5-.22.5-.5.5zM19 3l-6 6 2 2 7-7V3z"/>
</svg>
`;

export const SAVE_ICON = `
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"/>
</svg>
`;

export const STOP_ICON = `
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M6 6h12v12H6z"/>
</svg>
`;

export const OPEN_LINK_ICON = `
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/>
</svg>
`;

export const COPY_ICON = `
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
</svg>
`;
