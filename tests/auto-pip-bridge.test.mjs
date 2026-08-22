import assert from "node:assert/strict";
import test from "node:test";

test("bridge opens the configured video and preserves the page handler", async () => {
  const listeners = new Map();
  const handlers = new Map();
  const pageWindow = {
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
  };
  pageWindow.top = pageWindow;
  globalThis.window = pageWindow;

  let requestCount = 0;
  const video = {
    dataset: { imdCaptureId: "video-1" },
    isConnected: true,
    paused: false,
    ended: false,
    muted: false,
    volume: 1,
    disablePictureInPicture: true,
    readyState: 4,
    videoWidth: 1920,
    videoHeight: 1080,
    getBoundingClientRect() {
      return { width: 1280, height: 720 };
    },
    removeAttribute() {},
    requestPictureInPicture() {
      requestCount += 1;
      return Promise.resolve();
    },
  };
  globalThis.document = {
    querySelectorAll(selector) {
      assert.equal(selector, "video");
      return [video];
    },
  };

  const mediaSession = {
    setActionHandler(action, handler) {
      handlers.set(action, handler);
    },
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaSession },
  });

  const { initAutoPipBridge } = await import("../src/bridge/auto-pip.js");
  initAutoPipBridge();
  listeners.get("imd:auto-pip-config")({
    detail: { enabled: true, videoId: "video-1" },
  });

  handlers.get("enterpictureinpicture")({ reason: "contentoccluded" });
  await Promise.resolve();
  assert.equal(requestCount, 1);
  assert.equal(video.disablePictureInPicture, false);

  let pageHandlerCount = 0;
  const pageHandler = () => { pageHandlerCount += 1; };
  mediaSession.setActionHandler("enterpictureinpicture", pageHandler);
  handlers.get("enterpictureinpicture")({ reason: "contentoccluded" });
  await Promise.resolve();
  assert.equal(pageHandlerCount, 0);
  assert.equal(requestCount, 2);

  handlers.get("enterpictureinpicture")({ reason: "userinitiated" });
  assert.equal(pageHandlerCount, 1);

  listeners.get("imd:auto-pip-config")({
    detail: { enabled: false, videoId: "" },
  });
  assert.equal(handlers.get("enterpictureinpicture"), pageHandler);
});
