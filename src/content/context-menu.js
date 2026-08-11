import {
  settings,
  extensionActive,
  trackedMedia,
  contextMenuEl,
  contextMenuMedia,
  setContextMenuEl,
  setContextMenuMedia,
} from './state.js';
import {
  buildMediaActionButtons,
  isolateActionGroupEvents,
  createActionButton,
} from './action-ui.js';
import {
  OPEN_LINK_ICON, TRIM_ICON, STOP_ICON,
  ACTIVE_DOWNLOAD_STATES, BLOB_STATUS_EVENT,
} from './constants.js';
import { getMediaAtPoint, attachMediaActionHandlers } from './media-tracking.js';
import { showToast } from './toast.js';

/** Close and remove the custom right-click menu if it is open. */
export function closeContextMenu() {
  if (contextMenuEl) {
    contextMenuEl.remove();
    setContextMenuEl(null);
    setContextMenuMedia(null);
  }
}

/** Open the custom right-click menu for a media element near the cursor. */
export function openContextMenu(media, x, y, linkEl) {
  closeContextMenu();
  const menu = document.createElement("div");
  menu.className = "imd-context-menu";
  menu.setAttribute("role", "menu");
  isolateActionGroupEvents(menu);

  if (linkEl) {
    const openLinkBtn = createActionButton(
      "imd-open-link-btn",
      "Open link in new tab",
      OPEN_LINK_ICON,
    );
    openLinkBtn.setAttribute("role", "menuitem");
    openLinkBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      chrome.runtime.sendMessage(
        { action: "openTab", url: linkEl.href },
        (response) => {
          if (chrome.runtime.lastError) {
            showToast("Failed to open link.");
            return;
          }
          if (response?.ok !== true) {
            showToast(response?.error || "Failed to open link.");
            return;
          }
          showToast("Link opened in a new tab.");
        },
      );
      closeContextMenu();
    });
    menu.appendChild(openLinkBtn);
  }

  if (media) {
    const btns = buildMediaActionButtons(media);
    attachMediaActionHandlers(media, btns);
    btns.buttons.forEach((button) => {
      button.setAttribute("role", "menuitem");
      button.addEventListener("click", closeContextMenu);
      menu.appendChild(button);
    });
  }

  const anchor = document.getElementById("MediaViewer")?.open
    ? document.getElementById("MediaViewer")
    : document.body;
  anchor.appendChild(menu);
  setContextMenuEl(menu);
  setContextMenuMedia(media);

  positionContextMenu(menu, x, y);
  requestAnimationFrame(() => menu.classList.add("imd-context-menu-open"));
}

/**
 * Position a context menu near the cursor, flipping above the menu when it
 * touches the bottom edge.
 */
function positionContextMenu(menu, x, y) {
  const menuRect = menu.getBoundingClientRect();
  const menuHeight = menuRect.height;
  const gap = 12;

  let top = y - menuHeight - gap;
  if (top < 8) top = y + gap;

  const maxX = window.innerWidth - menuRect.width - 8;
  const maxY = window.innerHeight - menuHeight - 8;
  menu.style.left = `${Math.min(Math.max(8, x), Math.max(8, maxX))}px`;
  menu.style.top = `${Math.max(8, Math.min(top, maxY))}px`;
}

function handleContextMenuEvent(event) {
  if (!extensionActive || !settings.useContextMenu) return;

  const path = event.composedPath();
  let media = null;

  for (const el of path) {
    if (trackedMedia.has(el)) { media = el; break; }
    const found = el.querySelector?.("img[data-imd-media-type], video[data-imd-media-type]");
    if (found && trackedMedia.has(found)) { media = found; break; }
  }

  if (!media) media = getMediaAtPoint(event.clientX, event.clientY);

  if (!media) return;

  // Intentionally do not call preventDefault(): our media action menu and the
  // browser's native context menu are both meant to open on the same click.
  event.stopPropagation();
  event.stopImmediatePropagation();

  let linkEl =
    path.find((el) => el.tagName === "A" && el.hasAttribute("href")) ||
    event.target?.closest?.("a[href]");
  if (!linkEl) {
    let node = media;
    while (node && node !== document.body) {
      if (node.tagName === "A" && node.hasAttribute("href")) {
        linkEl = node;
        break;
      }
      node = node.parentElement || node.getRootNode()?.host;
    }
  }

  openContextMenu(media, event.clientX, event.clientY, linkEl);
}

document.addEventListener("contextmenu", handleContextMenuEvent, true);

const dialogObserver = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== 1) continue;
      const dialogs = node.tagName === "DIALOG"
        ? [node]
        : [...(node.querySelectorAll?.("dialog") ?? [])];
      for (const dialog of dialogs) {
        if (!dialog.dataset.imdCtxMenu) {
          dialog.dataset.imdCtxMenu = "true";
          dialog.addEventListener("contextmenu", handleContextMenuEvent, true);
        }
      }
    }
  }
});
if (document.body) {
  dialogObserver.observe(document.body, { childList: true, subtree: true });
}

document.addEventListener("pointerdown", (event) => {
  if (contextMenuEl && !contextMenuEl.contains(event.target)) {
    closeContextMenu();
  }
});
document.addEventListener("click", (event) => {
  if (contextMenuEl && !contextMenuEl.contains(event.target)) {
    closeContextMenu();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeContextMenu();
});
window.addEventListener("blur", closeContextMenu);
window.addEventListener("scroll", closeContextMenu, true);
window.addEventListener("resize", closeContextMenu);

window.addEventListener(BLOB_STATUS_EVENT, (event) => {
  if (!contextMenuEl || !contextMenuMedia) return;
  const { videoId, status } = event.detail || {};
  if (contextMenuMedia.dataset.imdCaptureId !== videoId) return;
  const downBtns = contextMenuEl.querySelectorAll(".imd-down-btn");
  const trimBtns = contextMenuEl.querySelectorAll(".imd-trim-btn");
  const isActive = ACTIVE_DOWNLOAD_STATES.has(status);
  downBtns.forEach((button) => {
    button.title = isActive ? "Video download in progress" : "Download Video";
    button.setAttribute("aria-label", button.title);
    button.classList.toggle("imd-recording", isActive);
    button.disabled = isActive;
  });
  trimBtns.forEach((button) => {
    const recording = status === "recording" || status === "progress";
    if (status === "complete" || status === "error" || status === "canceled") {
      button.title = "Trim from current time";
      button.innerHTML = TRIM_ICON;
    } else if (recording) {
      button.title = "Save trim";
      button.innerHTML = STOP_ICON;
    }
  });
});
