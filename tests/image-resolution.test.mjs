import assert from "node:assert/strict";
import test from "node:test";

globalThis.document = { baseURI: "https://www.instagram.com/p/example/" };

const {
  getHighestResolutionImageUrl,
  resolveHighestResolutionImageUrl,
} = await import("../src/content/image-resolution.js");
const { instagramImageCandidatesByAsset } = await import(
  "../src/content/state.js"
);

function createElement(attributes = {}) {
  return {
    getAttribute(name) {
      return attributes[name] || null;
    },
  };
}

function createImage(attributes = {}, options = {}) {
  return {
    ...createElement(attributes),
    naturalWidth: options.naturalWidth || 0,
    width: options.width || 0,
    clientWidth: options.clientWidth || 0,
    src: options.src || "",
    currentSrc: options.currentSrc || "",
    parentElement: options.picture || null,
    closest() {
      return options.picture || null;
    },
  };
}

test("selects the largest width candidate instead of currentSrc", () => {
  const srcset = [1080, 720, 640, 480, 320, 240]
    .map((width) => `https://cdn.example/image-${width}.jpg ${width}w`)
    .join(",");
  const image = createImage(
    { srcset },
    {
      naturalWidth: 640,
      src: "https://cdn.example/image-640.jpg",
      currentSrc: "https://cdn.example/image-640.jpg",
    },
  );

  assert.equal(
    getHighestResolutionImageUrl(image),
    "https://cdn.example/image-1080.jpg",
  );
});

test("includes picture source and lazy srcset candidates", () => {
  const source = createElement({
    "data-srcset": "image-1200.jpg 1200w, image-2000.jpg 2000w",
  });
  const picture = {
    tagName: "PICTURE",
    querySelectorAll(selector) {
      assert.equal(selector, "source");
      return [source];
    },
  };
  const image = createImage(
    { srcset: "image-1080.jpg 1080w" },
    { naturalWidth: 1080, picture },
  );

  assert.equal(
    getHighestResolutionImageUrl(image),
    "https://www.instagram.com/p/example/image-2000.jpg",
  );
});

test("probes an original URL that has no size descriptor", async () => {
  const widths = new Map([
    ["https://cdn.example/original.jpg", 2048],
  ]);
  globalThis.Image = class {
    removeAttribute() {}

    set src(url) {
      this.naturalWidth = widths.get(url) || 0;
      queueMicrotask(() => this.onload?.());
    }
  };
  const image = createImage(
    {
      srcset: "https://cdn.example/image-1080.jpg 1080w",
      "data-original": "https://cdn.example/original.jpg",
    },
    { naturalWidth: 1080 },
  );

  assert.equal(
    await resolveHighestResolutionImageUrl(image),
    "https://cdn.example/original.jpg",
  );
});

test("selects an early-captured Instagram candidate for the same asset", () => {
  const feedUrl =
    "https://scontent.cdninstagram.com/v/image_n.jpg?" +
    "stp=dst-jpg_p1080x1080&ig_cache_key=shared";
  const originalUrl =
    "https://scontent.cdninstagram.com/v/image_n.jpg?" +
    "stp=dst-jpg&ig_cache_key=shared";
  instagramImageCandidatesByAsset.set("cache:shared", new Map([
    [originalUrl, { url: originalUrl, width: 2599, height: 3465 }],
  ]));
  const image = createImage({}, {
    naturalWidth: 1080,
    src: feedUrl,
    currentSrc: feedUrl,
  });

  assert.equal(getHighestResolutionImageUrl(image), originalUrl);
  instagramImageCandidatesByAsset.clear();
});
