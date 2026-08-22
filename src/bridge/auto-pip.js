import {
  autoPipBridgeEnabled,
  autoPipBridgeVideoId,
  autoPipPageHandler,
  setAutoPipBridgeEnabled,
  setAutoPipBridgeVideoId,
  setAutoPipPageHandler,
} from "./auto-pip-state.js";

const AUTO_PIP_CONFIG_EVENT = "imd:auto-pip-config";

function findConfiguredVideo(videoId) {
  if (!videoId) return null;
  return Array.from(document.querySelectorAll("video")).find(
    (video) => video.dataset.imdCaptureId === videoId,
  ) || null;
}

function canEnterPictureInPicture(video) {
  let renderedWidth = 0;
  try {
    renderedWidth = video?.getBoundingClientRect().width || 0;
    video?.removeAttribute("disablepictureinpicture");
    if (video) video.disablePictureInPicture = false;
  } catch {}
  return Boolean(
    video?.isConnected &&
    !video.paused &&
    !video.ended &&
    video.readyState >= 2 &&
    renderedWidth > 470 &&
    typeof video.requestPictureInPicture === "function"
  );
}

export function initAutoPipBridge() {
  const mediaSession = navigator.mediaSession;
  if (!mediaSession?.setActionHandler || window.top !== window) return;

  const nativeSetActionHandler = mediaSession.setActionHandler.bind(mediaSession);
  const autoPipHandler = (details) => {
    const video = findConfiguredVideo(autoPipBridgeVideoId);
    if (
      autoPipBridgeEnabled &&
      canEnterPictureInPicture(video) &&
      details?.reason === "contentoccluded"
    ) {
      try {
        video.requestPictureInPicture().catch(() => {});
      } catch {}
      return;
    }
    if (autoPipPageHandler) {
      autoPipPageHandler.call(mediaSession, details);
      return;
    }
    if (!autoPipBridgeEnabled || !canEnterPictureInPicture(video)) return;
    try {
      video.requestPictureInPicture().catch(() => {});
    } catch {}
  };

  const applyHandler = () => {
    try {
      nativeSetActionHandler(
        "enterpictureinpicture",
        autoPipBridgeEnabled ? autoPipHandler : autoPipPageHandler,
      );
    } catch {}
  };

  try {
    mediaSession.setActionHandler = function (action, handler) {
      if (action !== "enterpictureinpicture") {
        return nativeSetActionHandler(action, handler);
      }
      setAutoPipPageHandler(typeof handler === "function" ? handler : null);
      applyHandler();
    };
  } catch {}

  window.addEventListener(AUTO_PIP_CONFIG_EVENT, (event) => {
    const detail = event.detail;
    setAutoPipBridgeEnabled(detail?.enabled === true);
    setAutoPipBridgeVideoId(
      typeof detail?.videoId === "string" ? detail.videoId : "",
    );
    applyHandler();
  });
}
