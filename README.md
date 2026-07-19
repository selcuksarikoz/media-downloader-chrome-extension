# Media Downloader

A Chrome extension for downloading images and videos from websites, developed
especially for Instagram. It adds download, preview, and frame-capture controls
directly to page media.

## Behavior

- Controls are shown only for the visible media currently under the pointer.
- Action buttons are circular with no transition delay for instant feedback.
- Video controls include a Picture-in-Picture button (when supported).
- Click the bolt icon on images to open them in a full-size lightbox overlay with
  download and preview buttons fixed at the bottom center.
- Click the lightbox image to zoom in at the clicked point (2x). Click again to
  zoom out. Use Ctrl+scroll for smooth zoom (1x–10x). Scroll or use the scrollbar
  to pan when zoomed. Click outside the image or press ESC to close.
- Regular image and video URLs use `chrome.downloads`.
- Blob URLs are copied directly when readable.
- Single-buffer MediaSource streams reuse captured segments.
- Separate MediaSource audio/video buffers are recorded in real time as MP4.
- Video downloads that require recording are queued according to the configured
  concurrency limit and require the tab to remain open.
- The capture button saves the video's current frame as JPG, PNG, or WebP. It
  does not start a video recording.
- The **Trim** button (scissors icon) records a video segment starting from the
  current playback position. Click once to begin recording, click again (or let
  the video reach the end) to save the trimmed segment as MP4. The button shows
  the elapsed recording time. Works on both blob and regular videos.
- DRM-protected media is not supported.

## Right-click Context Menu

Instead of the hover action buttons, the extension can show a custom in-page menu
when you right-click media. Enable **Use right-click menu instead of hover buttons**
in the settings.

- Right-clicking an image or video opens a floating, pill-shaped menu with the same
  circular action buttons that normally appear on hover (download, preview, capture
  frame, open full size, picture-in-picture, trim).
- The menu respects the same visibility rules as the hover buttons (for example, the
  preview button is hidden when disabled or for blob videos, and PiP only shows when
  supported).
- The native browser context menu is suppressed over media while this mode is on.
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
- Frame capture type: JPG (default), PNG, or WebP
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
