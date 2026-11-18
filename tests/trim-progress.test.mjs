import test from "node:test";
import assert from "node:assert/strict";

/** Minimal browser stubs so the content module graph can load in Node. */
function installBrowserStubs() {
  const listeners = new Map();
  const sentMessages = [];
  const timers = new Set();
  const nativeSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, delay, ...args) => {
    const id = nativeSetTimeout(fn, delay, ...args);
    timers.add(id);
    return id;
  };
  const nativeClearTimeout = globalThis.clearTimeout;
  globalThis.clearTimeout = (id) => {
    timers.delete(id);
    return nativeClearTimeout(id);
  };

  const fakeElement = () => ({
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {},
    getAttribute: () => null,
    appendChild() {},
    remove() {},
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    textContent: "",
    hidden: false,
  });

  const win = {
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) || []), listener]);
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) || []).filter((l) => l !== listener));
    },
    dispatchEvent(event) {
      (listeners.get(event.type) || []).slice().forEach((l) => l(event));
      return true;
    },
  };

  globalThis.window = win;
  globalThis.document = {
    body: fakeElement(),
    documentElement: fakeElement(),
    createElement: fakeElement,
    getElementById: () => null,
    baseURI: "https://example.com/",
    addEventListener() {},
  };
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href: "https://example.com/", hostname: "example.com" },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaCapabilities: null },
  });
  globalThis.chrome = {
    runtime: {
      getURL: (path) => `chrome-extension://test/${path}`,
      connect: () => {
        let onMessage;
        return {
          postMessage: (message) => {
            sentMessages.push(message);
            queueMicrotask(() =>
              onMessage?.({ requestId: message.requestId, ok: true }),
            );
          },
          onDisconnect: { addListener() {} },
          onMessage: {
            addListener(listener) {
              onMessage = listener;
            },
          },
        };
      },
      sendMessage() {},
      lastError: null,
    },
    storage: { get: (_defaults, cb) => cb({}), sync: { get: (_d, cb) => cb({}) } },
  };

  return {
    win,
    sentMessages,
    cleanup() {
      timers.forEach((id) => nativeClearTimeout(id));
      timers.clear();
      globalThis.setTimeout = nativeSetTimeout;
      globalThis.clearTimeout = nativeClearTimeout;
    },
  };
}

test("starting a bridge trim dispatches the trim event and opens a stored job", async () => {
  const { win, sentMessages, cleanup } = installBrowserStubs();
  const { triggerTrim } = await import("../src/content/video-trim.js");
  const { BLOB_TRIM_EVENT } = await import("../src/content/constants.js");

  const trimEvents = [];
  win.addEventListener(BLOB_TRIM_EVENT, (event) => trimEvents.push(event));

  const video = {
    tagName: "VIDEO",
    dataset: { imdCaptureId: "trim-video-1" },
    currentSrc: "https://example.com/video.mp4",
    currentTime: 12,
    paused: true,
  };

  assert.doesNotThrow(() => triggerTrim(video, null));
  assert.equal(trimEvents.length, 1, "BLOB_TRIM_EVENT must be dispatched");
  assert.equal(trimEvents[0].detail.videoId, "trim-video-1");
  assert.equal(trimEvents[0].detail.startTime, 12);
  assert.equal(
    sentMessages.find((message) => message.action === "job-start")?.jobId,
    "trim-video-1",
    "the persisted blob job must be started",
  );
  cleanup();
});
