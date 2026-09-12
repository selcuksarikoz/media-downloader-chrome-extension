import assert from "node:assert/strict";
import test from "node:test";

globalThis.document = { baseURI: "https://www.instagram.com/p/example/" };

const {
  getHighestResolutionImageUrl,
  resolveHighestResolutionImageUrl,
} = await import("../src/content/image-resolution.js");

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

test("probes the untransformed Instagram image behind a profile thumbnail", async () => {
  const thumbnail = "https://scontent-fra3-1.cdninstagram.com/v/t51.82787-15/photo.jpg?stp=dst-jpg_e35_c0.0.1080.1080a_s320x320_sh0.08_tt6&oh=signed";
  const original = "https://scontent-fra3-1.cdninstagram.com/v/t51.82787-15/photo.jpg?stp=dst-jpg_e35_tt6&oh=signed";
  const widths = new Map([
    [thumbnail, 320],
    [original, 1440],
  ]);
  globalThis.Image = class {
    removeAttribute() {}

    set src(url) {
      this.naturalWidth = widths.get(url) || 0;
      queueMicrotask(() => this.onload?.());
    }
  };
  const image = createImage(
    { srcset: `${thumbnail} 320w` },
    { naturalWidth: 320, src: thumbnail, currentSrc: thumbnail },
  );

  assert.equal(await resolveHighestResolutionImageUrl(image), original);
});

test("keeps the declared Instagram image when the original probe fails", async () => {
  const thumbnail = "https://scontent-fra3-1.cdninstagram.com/photo.jpg?stp=dst-jpg_s320x320_tt6&oh=signed";
  globalThis.Image = class {
    removeAttribute() {}

    set src(url) {
      queueMicrotask(() => this.onerror?.(new Error(`Failed: ${url}`)));
    }
  };
  const image = createImage(
    { srcset: `${thumbnail} 320w` },
    { naturalWidth: 320, src: thumbnail, currentSrc: thumbnail },
  );

  assert.equal(await resolveHighestResolutionImageUrl(image), thumbnail);
});
