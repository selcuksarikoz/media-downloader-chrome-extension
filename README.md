# Media Downloader

A Chrome extension for downloading images and videos from websites, developed
especially for Instagram. It adds download, preview, and frame-capture controls
directly to page media.

## Behavior

- Controls are shown only for the visible media currently under the pointer.
- Regular image and video URLs use `chrome.downloads`.
- Blob URLs are copied directly when readable.
- Single-buffer MediaSource streams reuse captured segments.
- Separate MediaSource audio/video buffers are recorded in real time as MP4.
- Video downloads that require recording are queued according to the configured
  concurrency limit and require the tab to remain open.
- The capture button saves the video's current frame as JPG, PNG, or WebP. It
  does not start a video recording.
- DRM-protected media is not supported.

## Settings

- Overlay button position
- Minimum media size
- Simultaneous video download limit
- Download subfolder and save prompt
- Preview button visibility
- Native video controls
- Frame capture type: JPG (default), PNG, or WebP

## Development

```bash
bun install
bun run build
```

After building:

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the generated `dist` directory.

After rebuilding the extension, return to `chrome://extensions` and reload it to
apply the changes.

## License

MIT
