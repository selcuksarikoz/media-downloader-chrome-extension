/**
 * Names shared by the page (MAIN) world and the isolated content-script world.
 *
 * Both worlds dispatch and listen for the same CustomEvents, so the literals
 * must live in exactly one place. Keeping them here also prevents a typo on one
 * side from silently dropping a message.
 */

// Page <-> content script CustomEvents.
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
export const AUTO_PIP_CONFIG_EVENT = "imd:auto-pip-config";
export const INSTAGRAM_IMAGE_CANDIDATES_EVENT = "imd:instagram-image-candidates";
export const INSTAGRAM_IMAGE_CANDIDATES_REQUEST_EVENT = "imd:request-instagram-image-candidates";
export const INSTAGRAM_POST_IMAGE_REQUEST_EVENT = "imd:instagram-post-image-request";
export const INSTAGRAM_POST_IMAGE_RESULT_EVENT = "imd:instagram-post-image-result";

// Extension-internal channels/ports.
export const FFMPEG_HOST_CHANNEL = "imd:ffmpeg-host";
export const BLOB_STORE_PORT_NAME = "imd-blob-store";
export const FETCH_MEDIA_PORT_NAME = "imd-fetch-media";
