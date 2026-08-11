import { settings, instagramNativeControlState } from './state.js';

export function isInstagramPage() {
  return (
    location.hostname === "instagram.com" ||
    location.hostname.endsWith(".instagram.com")
  );
}

export function getInstagramReelLink(media) {
  if (!/(^|\.)instagram\.com$/.test(location.hostname)) return null;
  return media.closest('a[href*="/reel/"], a[href*="/reels/"]');
}

export function getAssociatedVideoPlayer(media) {
  const selector = '[role="group"][aria-label="Video player"]';
  const directPlayer = media.closest(selector);
  if (directPlayer) return directPlayer;

  const reelLink =
    getInstagramReelLink(media) || media.closest('a[href*="/p/"]');
  const linkedPlayer = reelLink?.querySelector(selector);
  if (linkedPlayer) return linkedPlayer;

  const mediaRect = media.getBoundingClientRect();
  let ancestor = media.parentElement;
  for (let depth = 0; ancestor && depth < 8; depth += 1) {
    const player = ancestor.querySelector(selector);
    if (player) {
      const rect = player.getBoundingClientRect();
      const overlaps =
        rect.left < mediaRect.right &&
        rect.right > mediaRect.left &&
        rect.top < mediaRect.bottom &&
        rect.bottom > mediaRect.top;
      if (overlaps) return player;
    }
    ancestor = ancestor.parentElement;
  }
  return null;
}

export function isInstagramVideoPlayerMedia(media) {
  return Boolean(
    getAssociatedVideoPlayer(media) || getInstagramReelLink(media),
  );
}

export function isInstagramStoryContext(video) {
  if (!/(^|\.)instagram\.com$/.test(location.hostname)) return false;
  return /\/stories\//.test(location.pathname);
}

export function getStoryReplyBarHeight(video) {
  const videoRect = video.getBoundingClientRect();
  if (videoRect.height < window.innerHeight * 0.5) return 0;

  const dialog = video.closest('[role="dialog"]');
  if (!dialog) return 0;

  const viewportBottom = window.innerHeight;
  let maxOverlap = 0;

  const candidates = dialog.querySelectorAll(
    'form, [role="group"], [data-testid]',
  );
  for (const el of candidates) {
    const rect = el.getBoundingClientRect();
    if (rect.height < 10) continue;
    if (rect.top < viewportBottom * 0.6) continue;
    const input = el.querySelector(
      'input, textarea, [contenteditable="true"], [placeholder]',
    );
    if (!input) continue;
    const overlap = videoRect.bottom - rect.top;
    if (overlap > maxOverlap) maxOverlap = overlap;
  }

  if (maxOverlap > 0) return maxOverlap;

  const centerX = videoRect.left + videoRect.width / 2;
  const bottomY = viewportBottom - 5;
  const elements = document.elementsFromPoint(centerX, bottomY);

  for (const el of elements) {
    if (
      el === video ||
      video.contains(el) ||
      el.tagName === "HTML" ||
      el.tagName === "BODY"
    )
      continue;
    const hasInput = el.querySelector(
      'input, textarea, [contenteditable="true"], [placeholder]',
    );
    if (hasInput) {
      const rect = el.getBoundingClientRect();
      if (rect.height > 10) {
        const overlap = videoRect.bottom - rect.top;
        if (overlap > 0) return overlap;
      }
    }
  }

  return 0;
}

export function applyStoryVideoFix(video) {
  if (video.tagName !== "VIDEO") return;
  if (settings.showVideoControls && isInstagramStoryContext(video)) {
    const replyBarHeight = getStoryReplyBarHeight(video) || 60;
    const existing = video.style.transform || "";
    const cleaned = existing.replace(/translateY\([^)]*\)/g, "").trim();
    const translateY = `translateY(-${replyBarHeight}px)`;
    video.style.transform = cleaned ? `${cleaned} ${translateY}` : translateY;
    video.style.zIndex = "9999";
    video.dataset.imdStoryFix = "true";
    return;
  }
  removeStoryVideoFix(video);
}

export function removeStoryVideoFix(video) {
  if (video.dataset.imdStoryFix) {
    const existing = video.style.transform || "";
    const cleaned = existing.replace(/translateY\([^)]*\)/g, "").trim();
    if (cleaned) {
      video.style.transform = cleaned;
    } else {
      video.style.removeProperty("transform");
    }
    video.style.removeProperty("z-index");
    delete video.dataset.imdStoryFix;
  }
}

export function getActionRect(media) {
  const player = getAssociatedVideoPlayer(media);
  if (player) {
    const rect = player.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return rect;
  }

  const reelLink = getInstagramReelLink(media);
  if (reelLink) {
    const rect = reelLink.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return rect;
  }

  return media.getBoundingClientRect();
}

export function syncInstagramNativeVideoControls(video) {
  if (video.tagName !== "VIDEO") return;
  if (
    !settings.showVideoControls ||
    !isInstagramVideoPlayerMedia(video) ||
    isInstagramStoryContext(video)
  ) {
    removeInstagramNativeVideoControls(video);
    return;
  }
  if (instagramNativeControlState.has(video)) return;

  const state = {
    active: false,
    original: null,
    hideTimer: { id: null },
    hoverEntries: [],
    showControls: null,
    scheduleRestore: null,
  };

  state.showControls = () => {
    if (!settings.showVideoControls || !video.isConnected) return;
    if (state.hideTimer.id) clearTimeout(state.hideTimer.id);
    state.hideTimer.id = null;
    liftInstagramVideoForNativeControls(video, state);
  };

  state.scheduleRestore = () => {
    if (state.hideTimer.id) clearTimeout(state.hideTimer.id);
    state.hideTimer.id = setTimeout(() => {
      state.hideTimer.id = null;
      const stillHovering = state.hoverEntries.some(({ target }) =>
        target.matches(":hover"),
      );
      if (!stillHovering && !video.matches(":hover")) {
        restoreInstagramVideoAfterNativeControls(video, state);
      }
    }, 250);
  };

  state.hoverEntries = getInstagramNativeControlHoverTargets(video).map(
    (target) => ({
      target,
      mouseenter: state.showControls,
      mouseleave: state.scheduleRestore,
    }),
  );
  state.hoverEntries.forEach(({ target, mouseenter, mouseleave }) => {
    target.addEventListener("mouseenter", mouseenter);
    target.addEventListener("mouseleave", mouseleave);
  });
  video.addEventListener("mouseenter", state.showControls);
  video.addEventListener("mouseleave", state.scheduleRestore);
  instagramNativeControlState.set(video, state);
}

export function removeInstagramNativeVideoControls(video) {
  const state = instagramNativeControlState.get(video);
  if (!state) return;
  if (state.hideTimer.id) clearTimeout(state.hideTimer.id);
  state.hoverEntries.forEach(({ target, mouseenter, mouseleave }) => {
    target.removeEventListener("mouseenter", mouseenter);
    target.removeEventListener("mouseleave", mouseleave);
  });
  video.removeEventListener("mouseenter", state.showControls);
  video.removeEventListener("mouseleave", state.scheduleRestore);
  restoreInstagramVideoAfterNativeControls(video, state);
  instagramNativeControlState.delete(video);
}

function getInstagramNativeControlHoverTargets(video) {
  const targets = [
    getAssociatedVideoPlayer(video),
    getInstagramReelLink(video),
  ].filter(Boolean);
  return [...new Set(targets)];
}

function liftInstagramVideoForNativeControls(video, state) {
  if (state.active) return;
  state.original = {
    position: video.style.position,
    zIndex: video.style.zIndex,
    pointerEvents: video.style.pointerEvents,
    isolation: video.style.isolation,
  };
  if (getComputedStyle(video).position === "static") {
    video.style.position = "relative";
  }
  video.style.zIndex = "2147483646";
  video.style.pointerEvents = "auto";
  video.style.isolation = "isolate";
  state.active = true;
}

function restoreInstagramVideoAfterNativeControls(video, state) {
  if (!state.active || !state.original) return;
  video.style.position = state.original.position;
  video.style.zIndex = state.original.zIndex;
  video.style.pointerEvents = state.original.pointerEvents;
  video.style.isolation = state.original.isolation;
  state.original = null;
  state.active = false;
}
