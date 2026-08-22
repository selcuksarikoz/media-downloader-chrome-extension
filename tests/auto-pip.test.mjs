import assert from "node:assert/strict";
import test from "node:test";

globalThis.innerWidth = 1280;
globalThis.innerHeight = 720;

const {
  applyAutoPictureInPictureSetting,
  initAutoPictureInPicture,
  isAutoPipCandidate,
  refreshAutoPictureInPictureCandidate,
  selectAutoPipVideo,
} = await import(
  "../src/content/auto-pip.js"
);
const { setExtensionActive, setSettings } = await import(
  "../src/content/state.js"
);

function createVideo({
  rect = { left: 0, top: 0, right: 640, bottom: 360, width: 640, height: 360 },
  videoWidth = 1280,
  videoHeight = 720,
  ...overrides
} = {}) {
  return {
    isConnected: true,
    paused: false,
    ended: false,
    muted: false,
    volume: 1,
    disablePictureInPicture: false,
    readyState: 4,
    videoWidth,
    videoHeight,
    dataset: {},
    hasAttribute: () => false,
    setAttribute() {},
    removeAttribute() {},
    getBoundingClientRect: () => rect,
    ...overrides,
  };
}

test("selects the first playing video wider than 470px", () => {
  const small = createVideo({
    rect: { left: 0, top: 0, right: 470, bottom: 264, width: 470, height: 264 },
  });
  const large = createVideo({
    rect: { left: 20, top: 20, right: 980, bottom: 560, width: 960, height: 540 },
  });

  assert.equal(selectAutoPipVideo([small, large]), large);
});

test("does not compare resolution after a playing video qualifies", () => {
  const first = createVideo({ videoWidth: 640, videoHeight: 360 });
  const fourK = createVideo({ videoWidth: 3840, videoHeight: 2160 });

  assert.equal(selectAutoPipVideo([first, fourK]), first);
});

test("rejects paused and 470px-wide videos but accepts site-disabled PiP", () => {
  assert.equal(isAutoPipCandidate(createVideo({ paused: true })), false);
  assert.equal(isAutoPipCandidate(createVideo({ muted: true })), true);
  assert.equal(isAutoPipCandidate(createVideo({ disablePictureInPicture: true })), true);
  assert.equal(isAutoPipCandidate(createVideo({
    rect: { left: 0, top: 0, right: 470, bottom: 264, width: 470, height: 264 },
  })), false);
});

test("keeps Auto-PiP active when the domain blacklist hides media controls", () => {
  let nativeAutoPipMarked = false;
  const video = createVideo({
    setAttribute(name) {
      if (name === "autopictureinpicture") nativeAutoPipMarked = true;
    },
  });
  let config = null;
  const pageWindow = {
    dispatchEvent(event) {
      config = event.detail;
    },
  };
  pageWindow.top = pageWindow;
  globalThis.window = pageWindow;
  globalThis.document = {
    querySelectorAll(selector) {
      assert.equal(selector, "video");
      return [video];
    },
  };
  globalThis.CustomEvent = class {
    constructor(type, options) {
      this.type = type;
      this.detail = options.detail;
    }
  };

  setSettings({ autoPictureInPicture: true, minWidth: 150 });
  setExtensionActive(false);

  assert.equal(refreshAutoPictureInPictureCandidate(), video);
  assert.equal(config.enabled, true);
  assert.equal(config.videoId, video.dataset.imdCaptureId);
  assert.equal(nativeAutoPipMarked, true);
});

test("temporarily clears and restores a site's PiP-disable hint", () => {
  setSettings({ autoPictureInPicture: false });
  applyAutoPictureInPictureSetting();
  let disabledAttribute = true;
  const video = createVideo({
    disablePictureInPicture: true,
    hasAttribute(name) {
      return name === "disablepictureinpicture" && disabledAttribute;
    },
    removeAttribute(name) {
      if (name === "disablepictureinpicture") disabledAttribute = false;
    },
    setAttribute(name) {
      if (name === "disablepictureinpicture") disabledAttribute = true;
    },
  });
  globalThis.document.querySelectorAll = () => [video];

  setSettings({ autoPictureInPicture: true });
  assert.equal(refreshAutoPictureInPictureCandidate(), video);
  assert.equal(video.disablePictureInPicture, false);
  assert.equal(disabledAttribute, false);

  setSettings({ autoPictureInPicture: false });
  applyAutoPictureInPictureSetting();
  assert.equal(video.disablePictureInPicture, true);
  assert.equal(disabledAttribute, true);
});

test("targets a playing video when layout grows past 470px without another play", () => {
  let width = 200;
  let config = null;
  let resizeCallback = null;
  const video = createVideo({
    tagName: "VIDEO",
    getBoundingClientRect() {
      return { left: 0, top: 0, right: width, bottom: 360, width, height: 360 };
    },
  });
  const pageWindow = {
    addEventListener() {},
    dispatchEvent(event) {
      config = event.detail;
    },
  };
  pageWindow.top = pageWindow;
  globalThis.window = pageWindow;
  globalThis.document = {
    body: {},
    addEventListener() {},
    querySelectorAll: () => [video],
  };
  globalThis.ResizeObserver = class {
    constructor(callback) {
      resizeCallback = callback;
    }
    observe() {}
  };
  globalThis.MutationObserver = class {
    constructor() {}
    observe() {}
  };
  globalThis.requestAnimationFrame = (callback) => {
    callback();
    return 1;
  };

  setSettings({ autoPictureInPicture: true });
  initAutoPictureInPicture();
  assert.equal(config, null);

  width = 800;
  resizeCallback();
  assert.equal(config.enabled, true);
  assert.equal(config.videoId, video.dataset.imdCaptureId);
});
