import assert from "node:assert/strict";
import test from "node:test";

let headCalls = [];
let headHandler = () => blockedResponse();
let ruleCalls = 0;

function blockedResponse() {
  return {
    status: 403,
    ok: false,
    headers: { get: () => "application/json" },
  };
}

globalThis.chrome = {
  declarativeNetRequest: {
    async updateDynamicRules() {
      ruleCalls += 1;
    },
  },
};
globalThis.fetch = async (url) => {
  headCalls.push(url);
  return headHandler(url);
};

const { probeHotlinkProtection } = await import(
  "../src/background/hotlink-download.js"
);

test("caches a blocked probe so repeated downloads skip the HEAD request", async () => {
  const url = "https://cdn.test/video.mp4";
  headCalls = [];
  ruleCalls = 0;
  headHandler = () => blockedResponse();

  const first = await probeHotlinkProtection(url);
  const second = await probeHotlinkProtection(url);

  assert.deepEqual(first, { blocked: true, fetchable: true });
  assert.deepEqual(second, first);
  assert.deepEqual(headCalls, [url], "HEAD is sent only once");
  assert.equal(ruleCalls, 2, "one DNR add and one remove");
});

test("does not cache an unknown probe outcome", async () => {
  const url = "https://cdn.test/unstable.mp4";
  headCalls = [];
  ruleCalls = 0;
  let first = true;
  headHandler = () => {
    if (first) {
      first = false;
      throw new Error("network error");
    }
    return blockedResponse();
  };

  const unknown = await probeHotlinkProtection(url);
  assert.deepEqual(unknown, { blocked: false, fetchable: false });

  const retried = await probeHotlinkProtection(url);
  assert.deepEqual(retried, { blocked: true, fetchable: true });
  assert.equal(headCalls.length, 2, "a failed probe is retried");
});
