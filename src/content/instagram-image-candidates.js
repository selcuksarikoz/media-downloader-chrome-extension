import { storeInstagramImageCandidate, trimInstagramImageCandidates } from "./state.js";
import { getInstagramImageAssetKeys } from "../shared/instagram-image.js";
import {
  INSTAGRAM_IMAGE_CANDIDATES_EVENT,
  INSTAGRAM_IMAGE_CANDIDATES_REQUEST_EVENT,
} from "./constants.js";
import { toDimension } from "../shared/utils.js";

const MAX_ASSETS = 500;
const MAX_CANDIDATES_PER_ASSET = 20;

function receiveCandidates(event) {
  const candidates = event.detail?.candidates;
  if (!Array.isArray(candidates)) return;

  for (const candidate of candidates.slice(0, MAX_ASSETS)) {
    if (typeof candidate?.url !== "string") continue;
    const entry = {
      url: candidate.url,
      width: toDimension(candidate.width),
      height: toDimension(candidate.height),
    };
    getInstagramImageAssetKeys(candidate.url, document.baseURI).forEach((assetKey) =>
      storeInstagramImageCandidate(assetKey, entry, MAX_CANDIDATES_PER_ASSET),
    );
  }

  trimInstagramImageCandidates(MAX_ASSETS);
}

export function initInstagramImageCandidates() {
  if (location.hostname !== "instagram.com" && !location.hostname.endsWith(".instagram.com"))
    return;
  window.addEventListener(INSTAGRAM_IMAGE_CANDIDATES_EVENT, receiveCandidates);
  window.dispatchEvent(new CustomEvent(INSTAGRAM_IMAGE_CANDIDATES_REQUEST_EVENT));
}
