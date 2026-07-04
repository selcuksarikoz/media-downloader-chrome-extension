# Media Downloader

Chrome extension that adds download and preview controls to page images and videos.

## Behavior

- Regular image and video URLs use `chrome.downloads`.
- Blob URLs are copied directly when readable.
- Single-buffer MediaSource streams reuse captured segments.
- Separate MediaSource audio/video buffers are recorded in real time as MP4.
- Active video captures are queued according to the configured concurrency limit.
- DRM-protected media is not supported.

## Development

```bash
bun install
bun run build
```

Load the generated `dist` directory from `chrome://extensions` with Developer mode enabled.

Options control button position, minimum media size, concurrent video captures, download subfolder, save prompts, previews, and native video controls.

## License

MIT
