# Media Downloader

A Chrome Manifest V3 extension for downloading images and videos from websites,
including Instagram, Telegram Web, TikTok, and YouTube. It adds download, trim,
copy, lightbox, and frame-capture controls directly to page media.

## Site Compatibility

Support depends on the media sources that each site exposes to the browser. Site
updates can change which actions are available.

| Site | Available actions | Notes |
| --- | --- | --- |
| Instagram | Download images and videos, trim videos, capture or copy the current frame, copy images, open the image lightbox, and use Picture-in-Picture. | Works with supported posts, Reels, and Stories when a direct CDN URL or captured MediaSource data is available. |
| Telegram Web | Download images and videos, trim videos, capture or copy frames, copy images, open the image lightbox, and use Picture-in-Picture. | Progressive virtual video sources can be collected through ranged requests; Blob and MediaSource fallbacks are also supported. |
| TikTok | Download visible images and videos, trim videos, capture or copy frames, copy images, open the image lightbox, and use Picture-in-Picture. | Availability depends on the direct, Blob, or MediaSource URL exposed by the current player. |
| YouTube | Capture or copy the current frame and use Picture-in-Picture. Full download and trim are attempted for non-DRM progressive media or reusable captured MediaSource tracks. | Download and trim support is best effort. DRM-protected, encrypted, and some live or adaptive streams are not supported. |

Use the extension only for media that you own or have permission to save.

## Behavior

- Controls are shown only for the visible media currently under the pointer.
- Action buttons are circular with no transition delay for instant feedback.
- Video controls include a Picture-in-Picture button (when supported).
- Auto-PiP is enabled by default. Leaving a tab opens the first actively playing
  video wider than 470 px in Picture-in-Picture when Chrome permits it; returning
  closes only the PiP window opened automatically by the extension.
- Auto-PiP uses a fixed 470 px width threshold; the configurable minimum media
  size continues to apply only to in-page controls.
- While Auto-PiP is enabled, a selected player's `disablePictureInPicture` hint
  is temporarily cleared and restored when that player is released.
- The domain blacklist hides the extension's in-page media controls without
  disabling Auto-PiP.
- Click the bolt icon on images to open them in a full-size lightbox overlay with
  actions fixed at the bottom center.
- The lightbox opens with an active **crop** overlay covering the whole image.
  Drag inside the crop area to move it, drag the 8 round handles to resize, and
  click the dimmed area (or press Escape) to cancel cropping.
- **Download in the lightbox saves the cropped region** at the original (full)
  resolution, using the frame capture format selected in the settings. When crop
  is cancelled, download saves the full image.
- Click the lightbox image (or the crop area) to zoom in at the clicked point.
  Accepting crop no longer requires double-click: a click without dragging is
  zoom; dragging moves the crop area. The crop overlay hides while zoomed so you
  can inspect the image unobstructed, and returns when you zoom back out.
  Ctrl+scroll provides smooth zoom (1x–10x); scroll or use the scrollbar to pan
  when zoomed. Click outside the image or press ESC to close.
- Regular image and video URLs use `chrome.downloads`.
- Readable Blob URLs and captured source data are reused when available.
- Single-buffer MediaSource streams reuse captured segments.
- Separate captured MediaSource audio/video tracks are combined into one output
  when possible; playback-assisted recording is used as a fallback.
- Video downloads start immediately without a concurrency queue. Recorded
  segments are streamed to the extension's storage,
  so a download is finalized and saved even if the tab is closed or the page
  navigates mid-recording (a partial file is saved if recording was interrupted).
  Background downloads fall back to a data URL when blob URLs are unavailable
  in the service worker context. **Save Now** stops an active collection or
  recording pass and saves the valid media collected so far.
- Preview is an image action. Videos use **Capture Frame** or **Copy Frame**, so
  Blob and MediaSource videos never open a source URL or Base64 page as a video
  preview.
- The capture button captures the video's current frame and opens it in the
  in-page image lightbox. It does not start a video recording.
- The **Trim** button (scissors icon) starts a video segment at the current
  playback position. Click once to begin, then click **Save Trim** (or let the
  video reach the end) to lock the end point and save the segment as MP4. Direct,
  Blob, and reusable MediaSource inputs are supported. Final muxing or encoding
  can continue briefly after the end point is locked. Trim output preserves the
  source resolution and frame rate; full downloads keep the original media data.
- The **Copy** button (clipboard icon) copies images in highest resolution and
  video current frames using the selected frame capture format so you can paste
  them directly into any application.
- DRM-protected media is not supported.

## Right-click Context Menu

Instead of the hover action buttons, the extension can show a custom in-page menu
when you right-click media. Enable **Use right-click menu instead of hover buttons**
in the settings.

- Right-clicking an image or video opens a floating, pill-shaped menu with the
  same applicable circular actions that normally appear on hover. Preview and
  full-size lightbox actions are for images; Capture Frame, Picture-in-Picture,
  and Trim are for videos.
- Right-clicking a link that wraps media shows an "Open link in new tab" button at
  the top of the menu, opening the link in a background tab.
- The menu respects the same visibility rules as the hover buttons (for example,
  image Preview follows its setting and PiP only shows when supported).
- The custom media menu suppresses Chrome's native context menu only for the
  tracked media that was right-clicked.
- The menu closes on outside click, `Escape`, scroll, resize, or when the window
  loses focus.
- Download and trim buttons reflect live recording status (spinner/disabled state)
  just like the hover buttons.

## Settings

- Overlay button position
- Minimum media size
- Simultaneous video download limit
- Download subfolder and save prompt
- Always ask where to save (show "Save As" dialog)
- Preview button visibility
- Native video controls
- Automatic Picture-in-Picture for the active playing video wider than 470 px
  (enabled by default)
- Frame capture type: JPG (default), PNG, or WebP — also used for lightbox crops
- Use right-click menu instead of hover buttons
- Domain blacklist with subdomain matching

## Installation

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `dist` folder from this repository.

After any updates, return to `chrome://extensions` and click the reload icon on
the extension card to apply the changes.

> **Note:** The `dist` folder is pre-built and ready to use. No build step is
> required.

## Development

```bash
bun install
bun run build
```

After rebuilding, reload the extension from `chrome://extensions`.

## License

MIT
