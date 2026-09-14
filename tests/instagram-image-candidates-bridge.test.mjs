import assert from "node:assert/strict";
import test from "node:test";

globalThis.location = {
  hostname: "www.instagram.com",
  href: "https://www.instagram.com/",
};

const { extractInstagramImageCandidates } = await import(
  "../src/bridge/instagram-image-candidates.js"
);

test("extracts signed Instagram image candidates and their dimensions", () => {
  const small =
    "https://scontent-fra5-2.cdninstagram.com/v/t51/image_n.jpg?" +
    "stp=dst-jpg_p1080x1080&ig_cache_key=shared";
  const original =
    "https://scontent-fra5-2.cdninstagram.com/v/t51/image_n.jpg?" +
    "stp=dst-jpg&ig_cache_key=shared";
  const candidates = extractInstagramImageCandidates({
    image_versions2: {
      candidates: [
        { url: small, width: 1080, height: 1440 },
        { url: original, width: 2599, height: 3465 },
      ],
    },
  });

  assert.deepEqual(
    candidates.map(({ assetKey, width, height }) => ({
      assetKey,
      width,
      height,
    })),
    [
      { assetKey: "cache:shared", width: 2599, height: 3465 },
      { assetKey: "cache:shared", width: 1080, height: 1440 },
    ],
  );
});

test("ignores videos and non-Instagram assets", () => {
  assert.deepEqual(extractInstagramImageCandidates({
    candidates: [
      { url: "https://example.com/image.jpg", width: 4000 },
      { url: "https://scontent.cdninstagram.com/video.mp4", width: 1920 },
    ],
  }), []);
});
