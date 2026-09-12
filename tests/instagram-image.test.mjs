import assert from "node:assert/strict";
import test from "node:test";

import {
  findInstagramImageCandidate,
  findInstagramImageUrlInHtml,
  isInstagramPostResponse,
} from
  "../src/bridge/instagram-image.js";
import {
  getInstagramMediaReference,
  getInstagramMediaPermalink,
  getInstagramPostMediaId,
} from
  "../src/content/instagram-image.js";
import { upgradeInstagramImageSource } from
  "../src/content/image-resolution.js";

globalThis.document = { baseURI: "https://www.instagram.com/" };

test("extracts the Instagram media ID from a resized feed image", () => {
  const url = "https://scontent-fra3-1.cdninstagram.com/v/t51.82787-15/806366147_18627620224053581_382444429393678389_n.jpg?stp=dst-jpg_e35_p1080x1080_tt6&ig_cache_key=Mzk4NDQzNjAzMTcxNjU1MzYzMw%3D%3D.3-ccb7-5";
  const image = {
    closest(selector) {
      if (selector !== "article") return null;
      return {
        querySelector() {
          return { href: "/p/DdLj3Xcu3Oh/" };
        },
      };
    },
  };

  assert.deepEqual(getInstagramMediaReference([{ url }], image), {
    mediaId: "3984436031716553633",
    filename: "806366147_18627620224053581_382444429393678389_n.jpg",
    permalink: "/p/DdLj3Xcu3Oh/",
    postMediaId: "3984436031716553633",
  });
});

test("decodes the parent post ID from a carousel permalink", () => {
  assert.equal(
    getInstagramPostMediaId("/p/DdGvnMvjQhw/"),
    "3983080322384070768",
  );
});

test("creates a detail permalink from a child media ID", () => {
  assert.equal(
    getInstagramMediaPermalink("3976672487804709493"),
    "/p/Dcv-o7vqyp1/",
  );
});

test("accepts a canonical Instagram redirect as a post response", () => {
  assert.equal(isInstagramPostResponse({
    ok: true,
    redirected: true,
    url: "https://www.instagram.com/p/Dcv-uqzmySa/",
  }), true);
  assert.equal(isInstagramPostResponse({
    ok: true,
    redirected: true,
    url: "https://www.instagram.com/accounts/login/",
  }), false);
});

test("selects the largest signed candidate for the matching carousel image", () => {
  const filename = "target.jpg";
  const payload = {
    items: [{
      image_versions2: {
        candidates: [{
          url: "https://scontent.cdninstagram.com/unrelated.jpg",
          width: 4096,
          height: 4096,
        }],
      },
      carousel_media: [{
        image_versions2: {
          candidates: [
            {
              url: `https://scontent.cdninstagram.com/${filename}?size=small`,
              width: 1080,
              height: 1080,
            },
            {
              url: `https://scontent.cdninstagram.com/${filename}?size=original`,
              width: 2688,
              height: 3360,
            },
          ],
        },
      }],
    }],
  };

  assert.deepEqual(findInstagramImageCandidate(payload, filename), {
    url: `https://scontent.cdninstagram.com/${filename}?size=original`,
    width: 2688,
    height: 3360,
  });
});

test("prefers an untransformed original URL outside image_versions2", () => {
  const filename = "target.jpg";
  const original = `https://scontent.cdninstagram.com/${filename}?stp=dst-jpg_e35_tt6&oh=new-signature`;
  const payload = {
    items: [{
      original_width: 2688,
      original_height: 3360,
      original_image_url: original,
      image_versions2: {
        candidates: [{
          url: `https://scontent.cdninstagram.com/${filename}?stp=dst-jpg_e35_p1080x1080_tt6&oh=feed-signature`,
          width: 1080,
          height: 1350,
        }],
      },
    }],
  };

  assert.deepEqual(findInstagramImageCandidate(payload, filename), {
    url: original,
    width: 2688,
    height: 3360,
  });
});

test("extracts an untransformed signed URL from permalink HTML", () => {
  const filename = "target.jpg";
  const original = `https://scontent.cdninstagram.com/${filename}?stp=dst-jpg_e35_tt6&ig_cache_key=abc%3D%3D&oh=detail-signature`;
  const html = `<script>{"original_image_url":"${original.replaceAll("/", "\\/").replaceAll("&", "\\u0026")}"}</script>`;
  const encodedHtml = html.replaceAll("%", "\\u0025");

  assert.deepEqual(findInstagramImageUrlInHtml(encodedHtml, filename), {
    url: original,
    width: 0,
    height: 0,
  });
});

test("upgrades the Instagram page image to the signed original", async () => {
  globalThis.CustomEvent = class extends Event {
    constructor(type, options) {
      super(type);
      this.detail = options?.detail;
    }
  };
  globalThis.window = new EventTarget();
  globalThis.Image = class {
    removeAttribute() {}

    set src(url) {
      this.naturalWidth = url.includes("oh=detail") ? 3072 : 0;
      queueMicrotask(() => {
        if (this.naturalWidth) this.onload?.();
        else this.onerror?.(new Error(`Failed: ${url}`));
      });
    }
  };
  const thumbnail = "https://scontent.cdninstagram.com/photo.jpg?stp=dst-jpg_e35_tt6&ig_cache_key=Mzk4NDQzNjAzMTcxNjU1MzYzMw%3D%3D.3-ccb7-5&oh=feed";
  const original = "https://scontent.cdninstagram.com/photo.jpg?stp=dst-jpg_e35_tt6&oh=detail";
  const image = {
    tagName: "IMG",
    src: thumbnail,
    currentSrc: thumbnail,
    srcset: thumbnail,
    naturalWidth: 1080,
    width: 1080,
    clientWidth: 681,
    isConnected: true,
    getAttribute(name) {
      return name === "srcset" ? this.srcset : null;
    },
    closest() {
      return null;
    },
  };
  window.addEventListener("imd:instagram-image-request", (event) => {
    window.dispatchEvent(new CustomEvent("imd:instagram-image-result", {
      detail: {
        requestId: event.detail.requestId,
        ok: true,
        url: original,
        width: 3072,
      },
    }));
  });

  assert.equal(await upgradeInstagramImageSource(image), true);
  assert.equal(image.src, original);
  assert.equal(image.srcset, original);
  assert.equal(image.decoding, "async");
});
