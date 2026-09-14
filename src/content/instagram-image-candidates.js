import {
  storeInstagramImageCandidate,
  trimInstagramImageCandidates,
} from "./state.js";
import { getInstagramImageAssetKey } from "../shared/instagram-image.js";
import {
  INSTAGRAM_IMAGE_CANDIDATES_EVENT,
  INSTAGRAM_IMAGE_CANDIDATES_REQUEST_EVENT,
} from "./constants.js";

const MAX_ASSETS = 500;
const MAX_CANDIDATES_PER_ASSET = 20;

function toDimension(value) {
  const dimension = Number(value);
  return Number.isFinite(dimension) && dimension > 0 ? dimension : 0;
}

function receiveCandidates(event) {
  const candidates = event.detail?.candidates;
  if (!Array.isArray(candidates)) return;

  for (const candidate of candidates.slice(0, MAX_ASSETS)) {
    if (typeof candidate?.url !== "string") continue;
    const assetKey = getInstagramImageAssetKey(candidate.url, document.baseURI);
    if (!assetKey) continue;
    storeInstagramImageCandidate(assetKey, {
      url: candidate.url,
      width: toDimension(candidate.width),
      height: toDimension(candidate.height),
    }, MAX_CANDIDATES_PER_ASSET);
  }

  trimInstagramImageCandidates(MAX_ASSETS);
}

export function initInstagramImageCandidates() {
  if (
    location.hostname !== "instagram.com" &&
    !location.hostname.endsWith(".instagram.com")
  ) return;
  window.addEventListener(INSTAGRAM_IMAGE_CANDIDATES_EVENT, receiveCandidates);
  window.dispatchEvent(new CustomEvent(
    INSTAGRAM_IMAGE_CANDIDATES_REQUEST_EVENT,
  ));
}
