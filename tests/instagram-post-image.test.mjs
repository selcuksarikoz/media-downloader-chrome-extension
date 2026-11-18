import assert from "node:assert/strict";
import test from "node:test";

globalThis.location = {
  hostname: "www.instagram.com",
  href: "https://www.instagram.com/",
};
globalThis.document = { baseURI: "https://www.instagram.com/" };

const listeners = new Map();
globalThis.window = {
  addEventListener(type, handler) {
    listeners.set(type, handler);
  },
  dispatchEvent(event) {
    if (event.type === "imd:instagram-post-image-request") {
      queueMicrotask(() => {
        listeners.get("imd:instagram-post-image-result")({
          detail: {
            requestId: event.detail.requestId,
            candidates: [
              { url: FEED_URL, width: 1080, height: 1350 },
              { url: ORIGINAL_URL, width: 3072, height: 3840 },
            ],
          },
        });
      });
      return true;
    }
    listeners.get(event.type)?.(event);
    return true;
  },
};

globalThis.CustomEvent = class {
  constructor(type, options = {}) {
    this.type = type;
    this.detail = options.detail;
  }
};

const { upgradeInstagramImageCandidates, initInstagramPostImageUpgrade } =
  await import("../src/content/instagram-post-image.js");
const { instagramImageCandidatesByAsset } = await import("../src/content/state.js");
const { getInstagramMediaIdFromShortcode, isResizedInstagramImageUrl } =
  await import("../src/shared/instagram-image.js");

const FEED_URL =
  "https://scontent.cdninstagram.com/v/photo_n.jpg?" +
  "stp=dst-jpg_e35_p1080x1080_tt6&ig_cache_key=shared";
const ORIGINAL_URL =
  "https://scontent.cdninstagram.com/v/photo_n.jpg?" + "stp=dst-jpg_e35_tt6&oh=signed";

function createFeedImage() {
  return {
    tagName: "IMG",
    closest() {
      return { getAttribute: () => "/p/DfxK8_LjGMH/" };
    },
  };
}

initInstagramPostImageUpgrade();

test("converts a post shortcode into its media id", () => {
  assert.equal(getInstagramMediaIdFromShortcode("DfxK8_LjGMH"), "4031051312946504455");
  assert.equal(getInstagramMediaIdFromShortcode("not a code"), "");
});

test("detects Instagram thumbnail and crop transforms", () => {
  assert.equal(isResizedInstagramImageUrl(FEED_URL), true);
  assert.equal(
    isResizedInstagramImageUrl(
      "https://scontent.cdninstagram.com/v/p.jpg" + "?stp=dst-jpg_e35_c0.0.1080.1080a_tt6",
    ),
    true,
  );
  assert.equal(isResizedInstagramImageUrl(ORIGINAL_URL), false);
});

test("upgrades a feed image with the post's full-resolution variants", async () => {
  const upgraded = await upgradeInstagramImageCandidates(createFeedImage(), {
    url: FEED_URL,
    estimatedWidth: 1080,
  });

  assert.equal(upgraded, true);
  assert.equal(
    instagramImageCandidatesByAsset.get("file:photo_n.jpg").get(ORIGINAL_URL).width,
    3072,
  );
  instagramImageCandidatesByAsset.clear();
});

test("skips the request when the best candidate is already the original", async () => {
  let requested = false;
  const original = globalThis.window.dispatchEvent;
  globalThis.window.dispatchEvent = (event) => {
    if (event.type === "imd:instagram-post-image-request") requested = true;
    return original(event);
  };

  assert.equal(
    await upgradeInstagramImageCandidates(createFeedImage(), {
      url: ORIGINAL_URL,
      estimatedWidth: 3072,
    }),
    false,
  );
  assert.equal(requested, false);
  globalThis.window.dispatchEvent = original;
});
