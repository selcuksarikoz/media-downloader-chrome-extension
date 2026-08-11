# Media Downloader Engineering Rules

This repository is a Chrome Manifest V3 extension. Treat every media action as
part of one product contract: a change to one action must not alter the meaning,
availability, playback state, or lifecycle of another action.

## Architecture boundaries

- `manifest.json` is Manifest V3. Keep the background entry as a service worker;
  never rely on a persistent background page, DOM APIs, or long-lived in-memory
  state there.
- `media-bridge.js` runs in the page's `MAIN` world at `document_start`. It owns
  page-native media interception, MediaSource/Blob knowledge, playback-assisted
  recording, and page-world custom events.
- `content.js` runs in the isolated content-script world. It owns UI, settings,
  action dispatch, clipboard access, frame capture orchestration, and messages to
  the service worker.
- Content scripts run on HTTP as well as HTTPS pages. Browser APIs gated to a
  secure context (for example `crypto.randomUUID`) require a compatible
  fallback; one missing optional API must not abort processing all later media.
- `background.js` owns privileged Chrome APIs: downloads, tabs, offscreen
  documents, and persisted job chunks.
- Installing or updating the extension must not navigate the user to the Options
  page automatically. Options open only through an explicit user action.
- Cross-world communication must use the existing named `CustomEvent` contracts.
  Extension-world communication must use explicit `chrome.runtime` messages or
  ports. Do not reach across these boundaries by assuming shared globals.
- A runtime message handler must validate the fields required by that specific
  action. Never put a generic `message.url` guard in front of actions such as
  `captureTab` that intentionally have no URL.
- If an async `onMessage` branch calls `sendResponse` later, it must return
  `true`. Every caller must handle both `chrome.runtime.lastError` and an explicit
  `{ ok: false, error }` response.
- Values passed to Chrome APIs must have their documented primitive type.
  In particular, `tabs.create({ url })` must receive a non-empty string—never a
  Promise, Blob, response object, or `{ blobUrl, dataUrl }` capture result.

## Non-negotiable action contracts

### Full video download

- Download means the complete video from timestamp 0, regardless of the
  element's current playback position.
- Direct HTTP(S) media downloads use `chrome.downloads` and must not seek or
  mutate the page video.
- Blob/MediaSource downloads must use original captured media/track data when
  available. A recording fallback must seek to 0, wait for a rendered frame,
  record one deterministic pass, and restore the user's playback position,
  paused state, rate, mute state, and loop state.
- Full download and trim are distinct intents. Never pass the current time into
  the full-download path and never silently turn a full download into a trim.

### Trim video

- Trim starts at the video's current time when the user first clicks Trim.
- A second Trim click means Save/finalize. Reaching the end may also finalize.
- Trim state belongs to the media/job (`videoTrimRecordings`, `blobJobIntent`,
  video ID), never only to a button DOM node. Context-menu buttons are recreated
  on every open and therefore cannot be the source of truth.
- Cross-origin progressive videos such as Instagram CDN media must not use
  `HTMLMediaElement.captureStream()` as their only trim path. Record the chosen
  start/end timestamps and trim the fetched original with the FFmpeg bridge.
- Hover and context-menu Trim buttons must both show the current state when they
  are created: scissors when idle, stop/save while recording.
- Do not start a second trim or full-download job for a video that already has a
  conflicting active job. Preserve cancellation and persisted-chunk cleanup.

### Video frame preview

- Video Preview means: capture the currently presented video frame, encode it in
  the configured JPG/PNG/WebP format, convert it to a `data:image/...` string,
  and open that image in a new inactive tab next to the source tab.
- Video Preview must never open the video source URL itself.
- Preview must work for direct, Blob, and MediaSource videos through the existing
  capture fallbacks. Do not hide it merely because the source starts with
  `blob:`.
- A failed capture fallback must continue to the next fallback: live canvas,
  CORS source probe, rebuilt MediaSource, then visible-tab screenshot/crop. Do
  not `return await` an intermediate fallback without catching its rejection.
- Preview/copy frame extraction must preserve the user's playback state and must
  not pause, seek away from, restart, or otherwise disrupt a download/trim.
- Canvas contexts repeatedly read with `getImageData` must be created with
  `{ willReadFrequently: true }`.

### Frame capture and clipboard

- Capture Frame captures only the current video frame and opens the in-page
  image lightbox. It must not start a video recording or download the video.
- Copy on an image copies the highest-resolution image available. Copy on a
  video copies only the current frame in a clipboard-supported image format.
- Clipboard actions must not navigate, download, open a tab, or change playback.
- Revoke temporary object URLs only after every consumer has finished. Always
  clean timers, listeners, probes, ports, and capture-block events on success,
  failure, and cancellation.

### Image, lightbox, link, and PiP actions

- Image Download/Preview/Copy use the highest-resolution candidate unless a
  deliberate lightbox/crop URL is supplied.
- Image lightbox actions must keep their explicit source URL alive until the
  async action finishes. Crop export stays at original pixel resolution.
- Open Link opens only the wrapping link in a background tab; it must not trigger
  a media action.
- PiP is video-only, shown only when supported, and reflects entry/exit state.

## Hover/context-menu parity

- `buildMediaActionButtons` and `attachMediaActionHandlers` are the single shared
  source for hover and context-menu media actions. Do not fork their semantics.
- `useContextMenu: false`: show hover controls and leave the browser's native
  context menu untouched. Switching to this mode must also remove any custom
  menu that was already open.
- `useContextMenu: true`: do not render hover controls; right-clicking tracked
  media must call `preventDefault`, open one custom menu, and suppress the native
  menu.
- Both surfaces must expose the same applicable actions and honor the same
  Preview setting, media type checks, PiP support, busy/recording state, labels,
  disabled state, success feedback, and error feedback.
- A context menu may close immediately after dispatch, so async work and action
  state must not depend on the clicked button remaining connected.
- Newly created controls must derive their state from the media/job model. Status
  events must update both an open context menu and persistent hover controls.
- Every action click must prevent page navigation/playback handlers from also
  firing. Context menus close on action, outside click, Escape, scroll, resize,
  and window blur.

## Regression discipline

Before changing an action, trace all of these surfaces: hover group, custom
context menu, image lightbox, popup (when applicable), content-to-background
message, page bridge event, job status event, and cleanup path.

For action-related changes, verify at minimum:

1. Direct image: download, preview, full-size/lightbox, copy.
2. Direct video: full download from 0, trim start/save, preview current frame in
   a new tab, capture current frame, copy frame, PiP.
3. Blob/MediaSource video: the same video actions, including fallback capture,
   persisted download, save, cancel, and terminal status cleanup.
4. Both UI modes: hover controls and custom right-click menu.
5. Settings transitions while the page is open: Preview visibility, native video
   controls, button position, blacklist, and context-menu mode.
6. Failure paths: CORS/tainted canvas, missing metadata, extension reload,
   disconnected runtime, invalid URL, canceled recording, and removed media.

Do not declare an action fix complete from a successful build alone. Add a
targeted check when practical and exercise the affected interaction in Chrome.

## Build and repository hygiene

- Edit source files, not minified `dist` files. `dist/` is tracked and is the
  unpacked extension users load, so run `npm run build` after source changes and
  include the generated output.
- Keep `manifest.json` and copied/compiled `dist/manifest.json` consistent via
  the build; do not patch the generated manifest by hand.
- Preserve unrelated user changes. Do not delete persisted job compatibility or
  weaken MV3 service-worker restart handling as a shortcut.
- Required final checks: `node --check` for changed plain JavaScript files,
  `npm run build`, and `git diff --check`. Report any browser path that could not
  be exercised and why.
