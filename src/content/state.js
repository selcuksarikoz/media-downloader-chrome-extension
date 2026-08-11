import { DEFAULT_SETTINGS } from './constants.js';

export let settings = { ...DEFAULT_SETTINGS };
export let extensionActive = false;
export let mediaMutationObserver = null;

export const mediaControls = new Map();
export const trackedMedia = new Map();
export const capturedVideos = new Map();
export const dismissedPopupVideoIds = new Set();
export const popupVideoStatuses = new Map();
export const blobDownloadRequests = new Map();
export const activeBlobJobIds = new Set();
export const pipState = new WeakMap();
export const mediaHoverListeners = new WeakMap();
export const instagramNativeControlState = new WeakMap();
export const videoTrimRecordings = new Map();
export const blobJobIntent = new Map();
export const canceledBlobJobs = new Set();
export const activeMuxWorkers = new Map();
export const muxOutputWorkers = new Map();
export const activeIndependentMuxes = new Map();
export let ffmpegHostFrame = null;
export let ffmpegHostPromise = null;

export let mseCaptureSeq = 0;
export const mseCapturePending = new Map();

export let blobStorePort = null;
export let blobStoreSeq = 0;
export const blobStorePending = new Map();

export let toastEl = null;
export let toastTimer = null;

export let lightboxOpen = false;
export const visibleMedia = new WeakSet();

export let repositionFrame = null;
export let pointerFrame = null;
export let lastPointerPosition = null;

export let visibilityStyleCacheFrame = -1;
export const visibilityStyleCache = new Map();

export let cachedModalsFrame = -1;
export let cachedModals = [];

export let contextMenuEl = null;
export let contextMenuMedia = null;

export let blobDownloadStack = null;
export const blobDownloadPanels = new Map();

export function setSettings(newSettings) { settings = newSettings; }
export function setExtensionActive(value) { extensionActive = value; }
export function setMediaMutationObserver(observer) { mediaMutationObserver = observer; }
export function setFfmpegHostFrame(frame) { ffmpegHostFrame = frame; }
export function setFfmpegHostPromise(promise) { ffmpegHostPromise = promise; }
export function setMseCaptureSeq(value) { mseCaptureSeq = value; }
export function allocateMseCaptureSeq() { return ++mseCaptureSeq; }
export function setBlobStorePort(port) { blobStorePort = port; }
export function setBlobStoreSeq(value) { blobStoreSeq = value; }
export function allocateBlobStoreSeq() { return ++blobStoreSeq; }
export function setToastEl(el) { toastEl = el; }
export function setToastTimer(timer) { toastTimer = timer; }
export function setLightboxOpen(value) { lightboxOpen = value; }
export function setRepositionFrame(frame) { repositionFrame = frame; }
export function setPointerFrame(frame) { pointerFrame = frame; }
export function setLastPointerPosition(pos) { lastPointerPosition = pos; }
export function setVisibilityStyleCacheFrame(frame) { visibilityStyleCacheFrame = frame; }
export function setCachedModalsFrame(frame) { cachedModalsFrame = frame; }
export function setCachedModals(modals) { cachedModals = modals; }
export function setContextMenuEl(el) { contextMenuEl = el; }
export function setContextMenuMedia(media) { contextMenuMedia = media; }
export function setBlobDownloadStack(stack) { blobDownloadStack = stack; }
