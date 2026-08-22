import {
  autoPipRequest,
  autoPipVideo,
  autoPipConfiguredVideo,
  autoPipInitialized,
  autoPipRefreshFrame,
  autoPipMarkedVideo,
  autoPipMarkedVideoWasNative,
  autoPipMarkedVideoWasDisabled,
  autoPipMutationObserver,
  autoPipResizeObserver,
  settings,
  setAutoPipRequest,
  setAutoPipVideo,
  setAutoPipConfiguredVideo,
  setAutoPipInitialized,
  setAutoPipRefreshFrame,
  setAutoPipMarkedVideo,
  setAutoPipMutationObserver,
  setAutoPipResizeObserver,
} from "./state.js";
import { createCaptureId } from "./utils.js";
import { AUTO_PIP_CONFIG_EVENT } from "./constants.js";

const MIN_READY_STATE = 2;
const AUTO_PIP_MIN_WIDTH = 470;

function getRenderedRect(video) {
  try {
    return video.getBoundingClientRect();
  } catch {
    return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
  }
}

export function isAutoPipCandidate(video) {
  if (!video?.isConnected || video.paused || video.ended) return false;
  if (video.readyState < MIN_READY_STATE) {
    return false;
  }
  const rect = getRenderedRect(video);
  return rect.width > AUTO_PIP_MIN_WIDTH;
}

export function selectAutoPipVideo(videos) {
  for (const video of videos) {
    if (isAutoPipCandidate(video)) return video;
  }
  return null;
}

function isTopFrame() {
  try {
    return window.top === window;
  } catch {
    return false;
  }
}

function dispatchBridgeConfig(enabled, video = null) {
  let videoId = "";
  if (video) {
    videoId = video.dataset.imdCaptureId || createCaptureId();
    video.dataset.imdCaptureId = videoId;
  }
  window.dispatchEvent(
    new CustomEvent(AUTO_PIP_CONFIG_EVENT, {
      detail: { enabled: Boolean(enabled), videoId },
    }),
  );
}

function setConfiguredVideo(video) {
  if (autoPipConfiguredVideo === video) {
    if (video) {
      try {
        video.removeAttribute("disablepictureinpicture");
        video.disablePictureInPicture = false;
      } catch {}
    }
    return;
  }
  if (autoPipMarkedVideo) {
    try {
      if (!autoPipMarkedVideoWasNative) {
        autoPipMarkedVideo.removeAttribute("autopictureinpicture");
        autoPipMarkedVideo.autoPictureInPicture = false;
      }
      if (autoPipMarkedVideoWasDisabled) {
        autoPipMarkedVideo.setAttribute("disablepictureinpicture", "");
        autoPipMarkedVideo.disablePictureInPicture = true;
      } else {
        autoPipMarkedVideo.removeAttribute("disablepictureinpicture");
        autoPipMarkedVideo.disablePictureInPicture = false;
      }
    } catch {}
  }
  if (video) {
    const wasNative = Boolean(
      video.hasAttribute?.("autopictureinpicture") ||
      video.autoPictureInPicture === true
    );
    const wasDisabled = Boolean(
      video.hasAttribute?.("disablepictureinpicture") ||
      video.disablePictureInPicture === true
    );
    try {
      video.removeAttribute("disablepictureinpicture");
      video.disablePictureInPicture = false;
      video.setAttribute("autopictureinpicture", "");
      video.autoPictureInPicture = true;
    } catch {}
    setAutoPipMarkedVideo(video, wasNative, wasDisabled);
  } else {
    setAutoPipMarkedVideo(null);
  }
  setAutoPipConfiguredVideo(video);
  dispatchBridgeConfig(true, video);
}

function chooseCandidate() {
  if (!settings.autoPictureInPicture || !isTopFrame()) {
    return null;
  }
  if (isAutoPipCandidate(autoPipConfiguredVideo)) {
    return autoPipConfiguredVideo;
  }
  return selectAutoPipVideo(document.querySelectorAll("video"));
}

function onPlaybackStarted(event) {
  const video = event.target;
  if (video?.tagName === "VIDEO" && isAutoPipCandidate(video)) {
    setConfiguredVideo(video);
    return;
  }
  refreshAutoPictureInPictureCandidate();
}

function observeAutoPipVideo(video) {
  if (video?.tagName === "VIDEO") autoPipResizeObserver?.observe(video);
}

function startAutoPipMediaObservers() {
  if (!autoPipResizeObserver) {
    setAutoPipResizeObserver(new ResizeObserver(() => {
      refreshAutoPictureInPictureCandidate();
    }));
  }
  document.querySelectorAll("video").forEach(observeAutoPipVideo);

  if (autoPipMutationObserver || !document.body) return;
  const observer = new MutationObserver((mutations) => {
    let foundVideo = false;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches?.("video")) {
          observeAutoPipVideo(node);
          foundVideo = true;
        }
        node.querySelectorAll?.("video").forEach((video) => {
          observeAutoPipVideo(video);
          foundVideo = true;
        });
      }
    }
    if (foundVideo) refreshAutoPictureInPictureCandidate();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  setAutoPipMutationObserver(observer);
}

export function refreshAutoPictureInPictureCandidate() {
  if (!settings.autoPictureInPicture || !isTopFrame()) {
    setConfiguredVideo(null);
    dispatchBridgeConfig(false);
    return null;
  }
  const video = chooseCandidate();
  setConfiguredVideo(video);
  return video;
}

async function enterAutoPictureInPicture() {
  if (document.pictureInPictureElement || autoPipRequest) return;
  const video = refreshAutoPictureInPictureCandidate();
  if (!video || typeof video.requestPictureInPicture !== "function") return;

  let request = null;
  try {
    request = video.requestPictureInPicture();
    setAutoPipRequest(request);
    await request;
    if (
      document.visibilityState === "hidden" &&
      settings.autoPictureInPicture
    ) {
      setAutoPipVideo(video);
    } else if (document.pictureInPictureElement === video) {
      await document.exitPictureInPicture();
    }
  } catch (error) {
    if (error?.name !== "NotAllowedError") {
      console.debug("[Media Downloader] Automatic PiP was not available:", error);
    }
  } finally {
    if (request && autoPipRequest === request) setAutoPipRequest(null);
  }
}

async function exitOwnedAutoPictureInPicture() {
  const video = autoPipVideo;
  setAutoPipVideo(null);
  if (!video || document.pictureInPictureElement !== video) return;
  try {
    await document.exitPictureInPicture();
  } catch (error) {
    if (error?.name !== "InvalidStateError") {
      console.debug("[Media Downloader] Automatic PiP could not be closed:", error);
    }
  }
}

function onVisibilityChange() {
  if (document.visibilityState === "hidden") {
    enterAutoPictureInPicture();
    return;
  }
  exitOwnedAutoPictureInPicture();
  refreshAutoPictureInPictureCandidate();
}

function onEnterPictureInPicture(event) {
  if (
    document.visibilityState === "hidden" &&
    settings.autoPictureInPicture &&
    event.target === autoPipConfiguredVideo
  ) {
    setAutoPipVideo(event.target);
  }
}

export function applyAutoPictureInPictureSetting() {
  if (!settings.autoPictureInPicture) {
    setConfiguredVideo(null);
    dispatchBridgeConfig(false);
    exitOwnedAutoPictureInPicture();
    return;
  }
  refreshAutoPictureInPictureCandidate();
}

export function initAutoPictureInPicture() {
  if (autoPipInitialized || !isTopFrame()) return;
  setAutoPipInitialized(true);
  document.addEventListener("visibilitychange", onVisibilityChange);
  document.addEventListener("play", onPlaybackStarted, true);
  document.addEventListener("playing", onPlaybackStarted, true);
  document.addEventListener("pause", refreshAutoPictureInPictureCandidate, true);
  document.addEventListener("ended", refreshAutoPictureInPictureCandidate, true);
  document.addEventListener("volumechange", refreshAutoPictureInPictureCandidate, true);
  document.addEventListener("loadeddata", refreshAutoPictureInPictureCandidate, true);
  document.addEventListener("enterpictureinpicture", onEnterPictureInPicture, true);
  document.addEventListener("leavepictureinpicture", (event) => {
    if (event.target === autoPipVideo) setAutoPipVideo(null);
  }, true);
  window.addEventListener("resize", refreshAutoPictureInPictureCandidate, { passive: true });
  document.addEventListener("scroll", scheduleCandidateRefresh, {
    capture: true,
    passive: true,
  });
  startAutoPipMediaObservers();
  applyAutoPictureInPictureSetting();
}

function scheduleCandidateRefresh() {
  if (autoPipRefreshFrame !== null) return;
  setAutoPipRefreshFrame(requestAnimationFrame(() => {
    setAutoPipRefreshFrame(null);
    refreshAutoPictureInPictureCandidate();
  }));
}
