import {
  mediaControls, visibleMedia, lastPointerPosition, repositionFrame, pointerFrame,
  visibilityStyleCacheFrame, visibilityStyleCache, cachedModalsFrame, cachedModals,
  setRepositionFrame, setPointerFrame, setLastPointerPosition,
  setVisibilityStyleCacheFrame, setCachedModalsFrame, setCachedModals,
} from './state.js';
import { getInstagramReelLink } from './instagram.js';
import {
  showActionGroup, hideActionGroup, positionActionGroup,
} from './action-ui.js';

export function getMediaHoverTargets(media) {
  const targets = [media];
  const mediaRect = media.getBoundingClientRect();
  let ancestor = media.parentElement;

  for (let depth = 0; ancestor && depth < 3; depth += 1) {
    const rect = ancestor.getBoundingClientRect();
    const widthLimit = Math.max(mediaRect.width * 1.5, mediaRect.width + 40);
    const heightLimit = Math.max(mediaRect.height * 1.5, mediaRect.height + 40);

    if (rect.width <= widthLimit && rect.height <= heightLimit) {
      targets.push(ancestor);
      ancestor = ancestor.parentElement;
      continue;
    }
    break;
  }

  return targets;
}

export function repositionOpenControls() {
  mediaControls.forEach((group, media) => {
    if (!media.isConnected) return;
    if (!visibleMedia.has(media)) {
      hideActionGroup(group);
    } else if (group.classList.contains("imd-show")) {
      positionActionGroup(group, media);
    }
  });
}

export function scheduleReposition() {
  if (repositionFrame !== null) return;
  setRepositionFrame(requestAnimationFrame(() => {
    setRepositionFrame(null);
    repositionOpenControls();
  }));
}

export function schedulePointerReconciliation() {
  if (!lastPointerPosition) return;
  if (pointerFrame !== null) cancelAnimationFrame(pointerFrame);
  setPointerFrame(requestAnimationFrame(() => {
    setPointerFrame(null);
    reconcileControlsAtPoint(lastPointerPosition.x, lastPointerPosition.y);
  }));
}

export function reconcileControlsAtPoint(x, y) {
  const topMedia = findTopMediaAtPoint(x, y);
  mediaControls.forEach((group, media) => {
    if (!media.isConnected) return;
    if (visibleMedia.has(media) && media === topMedia) {
      showActionGroup(group, media);
    } else if (!group.matches(":hover")) {
      hideActionGroup(group);
    }
  });
}

export function findTopMediaAtPoint(x, y) {
  const stack = document.elementsFromPoint(x, y);
  const { hasModal, modal } = getModalAtPoint(x, y, stack);
  if (hasModal && !modal) return null;
  let bestMedia = null;
  let bestStackIndex = Infinity;

  mediaControls.forEach((group, media) => {
    if (
      !media.isConnected ||
      !visibleMedia.has(media) ||
      !isMediaActuallyVisible(media)
    ) {
      return;
    }
    if (modal && !modal.contains(media)) return;
    const rect = media.getBoundingClientRect();
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      return;
    }

    const directStackIndex = stack.indexOf(media);
    const stackIndex =
      directStackIndex !== -1
        ? directStackIndex
        : stack.findIndex((element) => element.contains(media));
    if (stackIndex === -1 || stackIndex >= bestStackIndex) return;

    bestMedia = media;
    bestStackIndex = stackIndex;
  });

  return bestMedia;
}

function getCachedComputedStyle(element) {
  const frame = performance.now();
  if (visibilityStyleCacheFrame !== Math.floor(frame / 16)) {
    visibilityStyleCache.clear();
    setVisibilityStyleCacheFrame(Math.floor(frame / 16));
  }
  let cached = visibilityStyleCache.get(element);
  if (!cached) {
    cached = getComputedStyle(element);
    visibilityStyleCache.set(element, cached);
  }
  return cached;
}

/** Check if a media element is actually visible (not hidden, opacity 0, etc.). */
function isMediaActuallyVisible(media) {
  const hasBackgroundProxy = hasVisibleBackgroundProxy(media);
  if (
    typeof media.checkVisibility === "function" &&
    !media.checkVisibility({
      checkOpacity: !hasBackgroundProxy,
      checkVisibilityCSS: true,
    })
  ) {
    return false;
  }

  for (let element = media; element; element = element.parentElement) {
    if (
      element.hidden ||
      element.inert ||
      element.getAttribute("aria-hidden") === "true"
    ) {
      return false;
    }
    const style = getCachedComputedStyle(element);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      (Number(style.opacity) === 0 &&
        !(element === media && hasBackgroundProxy))
    ) {
      return false;
    }
  }
  return true;
}

/** Check if the media has a visible background proxy element (e.g. Instagram reel thumb). */
function hasVisibleBackgroundProxy(media) {
  if (!media.parentElement) return false;
  const mediaRect = media.getBoundingClientRect();
  const parent = media.tagName === "VIDEO"
    ? (getInstagramReelLink(media) || media.parentElement)
    : media.parentElement;
  if (!parent) return false;

  if (media.tagName === "VIDEO") {
    const imgs = parent.querySelectorAll("img");
    for (const element of imgs) {
      if (element === media) continue;
      const style = getCachedComputedStyle(element);
      const hasVisibleImage = element.tagName === "IMG" && Boolean(element.currentSrc || element.src);
      if (
        (!hasVisibleImage && style.backgroundImage === "none") ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number(style.opacity) === 0
      ) continue;
      const rect = element.getBoundingClientRect();
      if (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.left < mediaRect.right &&
        rect.right > mediaRect.left &&
        rect.top < mediaRect.bottom &&
        rect.bottom > mediaRect.top
      ) return true;
    }
    return false;
  }

  for (const element of parent.children) {
    if (element === media) continue;
    const style = getCachedComputedStyle(element);
    const hasVisibleImage = element.tagName === "IMG" && Boolean(element.currentSrc || element.src);
    if (
      (!hasVisibleImage && style.backgroundImage === "none") ||
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number(style.opacity) === 0
    ) continue;
    const rect = element.getBoundingClientRect();
    if (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.left < mediaRect.right &&
      rect.right > mediaRect.left &&
      rect.top < mediaRect.bottom &&
      rect.bottom > mediaRect.top
    ) return true;
  }
  return false;
}

function getVisibleModals() {
  const frame = performance.now();
  if (cachedModalsFrame !== Math.floor(frame / 16)) {
    setCachedModalsFrame(Math.floor(frame / 16));
    setCachedModals(Array.from(
      document.querySelectorAll(
        'dialog[open], [role="dialog"], [aria-modal="true"]',
      ),
    ).filter((modal) => {
      const style = getCachedComputedStyle(modal);
      const rect = modal.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity) > 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    }));
  }
  return cachedModals;
}

/** Find the topmost modal at a point, or determine if one exists. */
function getModalAtPoint(x, y, stack) {
  const modals = getVisibleModals();
  if (!modals.length) return { hasModal: false, modal: null };

  const modal = stack
    .map((element) => modals.find((candidate) => candidate.contains(element)))
    .find(Boolean);
  if (modal) return { hasModal: true, modal };

  const containsPoint = modals.find((candidate) => {
    const rect = candidate.getBoundingClientRect();
    return (
      x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
    );
  });
  return { hasModal: true, modal: containsPoint || null };
}

window.addEventListener("scroll", scheduleReposition, true);
window.addEventListener("resize", scheduleReposition);

document.addEventListener(
  "pointermove",
  (event) => {
    if (event.pointerType === "touch") return;
    setLastPointerPosition({ x: event.clientX, y: event.clientY });
    schedulePointerReconciliation();
  },
  true,
);
