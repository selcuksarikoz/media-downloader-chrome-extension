# Media Downloader

Media Downloader is a Chrome extension for downloading images and videos. It adds download and preview controls directly to supported media elements.

## Features

- **One-Click Download:** Adds a download button to images and videos.
- **Blob Video Download:** Validates readable `Blob` videos before starting the browser download, preventing empty files.
- **MediaSource Segment Capture:** Captures appended MediaSource segments and reconstructs single-buffer MP4/WebM streams without quality loss. Separate audio/video buffers fall back to WebM recording.
- **Download Progress:** Shows persistent video capture progress, prevents accidental duplicate actions, and warns before closing a tab with an active capture.
- **Smart Positioning:** Choose where the button appears (Top-Right, Top-Left, etc.) via settings.
- **Custom Save Location:** Save media to a specific sub-folder in your Downloads directory, or leave it empty to use Downloads directly.
- **Size Filtering:** Automatically ignore small icons and thumbnails by setting a minimum width (default: 150px) to keep your interface clean.
- **Dynamic Support:** Works with dynamically loaded images and videos.
- **Modern Design:** Sleek, unobtrusive UI that blends correct button placement without breaking site layouts.

## Installation

### From Source (Developer Mode)

1.  Clone this repository:

    ```bash
    git clone https://github.com/selcuksarikoz/media-downloader-chrome-extension.git
    cd media-downloader-chrome-extension
    ```

2.  Install dependencies:

    ```bash
    bun install
    ```

3.  Build the extension:

    ```bash
    bun run build
    ```

4.  Load into Chrome:
    - Open `chrome://extensions/`
    - Enable **Developer mode** (top right toggle).
    - Click **Load unpacked**.
    - Select the `dist` folder inside the project directory.

## Development

This project uses **Vite** for building and **Sass** for styling.

- **Build:** `bun run build` - Compiles `options.html`, `background.js`, `content.js` and `styles.scss` into the `dist/` folder.
- **Watch:** You can use `bun run build` manually after changes.

## Settings

Right-click the extension icon and select **Options** to configure:

- **Button Position:** Top-Right (Default), Top-Left, Bottom-Right, Bottom-Left, Center.
- **Minimum Media Size:** Set a pixel threshold to avoid adding buttons to tiny media elements (default 150px).
- **Download Folder:** Specify a folder name to organize downloads.
- **Always ask where to save:** Check this to trigger the "Save As" dialog for regular media downloads.
- **Show preview button:** Show or hide the media preview control.

Readable `Blob` URLs are copied directly. HLS/DASH `MediaSource` playback is recorded in real time because its appended segments are not exposed through `fetch()`. DRM-protected media cannot be captured.

## License

MIT
