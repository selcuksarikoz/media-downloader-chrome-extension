import assert from "node:assert/strict";
import test from "node:test";

let probeCount = 0;
let dimensions = new Map();

globalThis.document = {
  createElement(tag) {
    assert.equal(tag, "video");
    probeCount += 1;
    const probe = {
      videoWidth: 0,
      videoHeight: 0,
      onloadeddata: null,
      onloadedmetadata: null,
      onerror: null,
      removeAttribute() {},
      load() {},
      remove() {},
      set src(url) {
        const dims = dimensions.get(url);
        queueMicrotask(() => {
          if (dims) {
            this.videoWidth = dims[0];
            this.videoHeight = dims[1];
            this.onloadedmetadata?.();
          } else {
            this.onerror?.();
          }
        });
      },
    };
    return probe;
  },
};

const { resolveHighestResolutionVideoUrl } = await import(
  "../src/content/video-resolution.js"
);
const { videoResolutionCache } = await import("../src/content/state.js");

function makeVideo(urls) {
  return {
    currentSrc: "",
    src: "",
    querySelectorAll() {
      return urls.map((url) => ({
        src: url,
        getAttribute: () => "",
      }));
    },
  };
}

test("reuses cached resolution probes across downloads", async () => {
  videoResolutionCache.clear();
  probeCount = 0;
  dimensions = new Map([
    ["https://x.test/720p.mp4", [1280, 720]],
    ["https://x.test/1080p.mp4", [1920, 1080]],
  ]);
  const video = makeVideo([...dimensions.keys()]);

  const first = await resolveHighestResolutionVideoUrl(video);
  assert.equal(first, "https://x.test/1080p.mp4");
  assert.equal(probeCount, 2);

  const second = await resolveHighestResolutionVideoUrl(video);
  assert.equal(second, first);
  assert.equal(probeCount, 2, "no new metadata probe on a repeated download");
});

test("retries a failed resolution probe instead of caching the failure", async () => {
  videoResolutionCache.clear();
  probeCount = 0;
  dimensions = new Map([["https://x.test/480p.mp4", [854, 480]]]);
  const video = makeVideo([
    "https://x.test/broken.mp4",
    "https://x.test/480p.mp4",
  ]);

  await resolveHighestResolutionVideoUrl(video);
  assert.equal(probeCount, 2);

  await resolveHighestResolutionVideoUrl(video);
  assert.equal(
    probeCount,
    3,
    "only the failed URL is probed again; the successful one stays cached",
  );
});
