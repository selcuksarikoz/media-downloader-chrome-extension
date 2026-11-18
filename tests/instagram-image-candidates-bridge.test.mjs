import assert from "node:assert/strict";
import test from "node:test";

globalThis.location = {
  hostname: "www.instagram.com",
  href: "https://www.instagram.com/",
};

const { extractInstagramImageCandidates, extractInstagramImageCandidatesFromScript } =
  await import("../src/bridge/instagram-image-candidates.js");

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
  assert.deepEqual(
    extractInstagramImageCandidates({
      candidates: [
        { url: "https://example.com/image.jpg", width: 4000 },
        { url: "https://scontent.cdninstagram.com/video.mp4", width: 1920 },
      ],
    }),
    [],
  );
});

test("reads the full-resolution variants embedded in the page JSON", () => {
  const feed =
    "https://scontent-fra5-1.cdninstagram.com/v/t51/photo_n.jpg?" +
    "stp=dst-jpg_e35_p1080x1080_tt6&ig_cache_key=shared";
  const original =
    "https://scontent-fra5-1.cdninstagram.com/v/t51/photo_n.jpg?" +
    "stp=dst-jpg_e35_tt6&ig_cache_key=shared";
  const payload = {
    require: [
      [
        "ScheduledApplyEach",
        [],
        {
          __bbox: {
            result: {
              data: {
                image_versions2: {
                  candidates: [
                    { url: feed, width: 1080, height: 1350 },
                    { url: original, width: 3072, height: 3840 },
                  ],
                },
              },
            },
          },
        },
      ],
    ],
  };
  const script = JSON.stringify(payload).replaceAll("/", "\\/").replaceAll("&", "\\u0026");

  const candidates = extractInstagramImageCandidatesFromScript(script);

  assert.deepEqual(
    candidates.map(({ url, width, height }) => ({ url, width, height })),
    [
      { url: original, width: 3072, height: 3840 },
      { url: feed, width: 1080, height: 1350 },
    ],
  );
});

test("falls back to raw URLs when the embedded data is not JSON", () => {
  const original =
    "https://scontent-fra5-1.cdninstagram.com/v/t51/photo_n.jpg?" +
    "stp=dst-jpg_e35_tt6&ig_cache_key=shared";
  const script = `window.x = {img:"${original.replaceAll("/", "\\/")}"};`;

  assert.deepEqual(
    extractInstagramImageCandidatesFromScript(script).map(({ url }) => url),
    [original],
  );
});

test("ignores inline scripts that cannot hold media", () => {
  assert.deepEqual(extractInstagramImageCandidatesFromScript('{"a":1}'), []);
});
