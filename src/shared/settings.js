/** Default settings shared by the content script and the Options page. */
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
  autoPictureInPicture: true,
};
