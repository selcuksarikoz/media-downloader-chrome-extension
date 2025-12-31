# imgDownloader

imgDownloader is a powerful and easy-to-use Chrome Extension that allows you to download images from any website with a single click. It automatically injects a download button onto images, making it effortless to save content.

## Features

- **One-Click Download:** Adds a convenient download button to every image on a webpage.
- **Smart Positioning:** Choose where the button appears (Top-Right, Top-Left, etc.) via settings.
- **Custom Save Location:** Save images to a specific sub-folder in your Downloads directory, or choose to have the browser ask for a location every time.
- **Size Filtering:** Automatically ignore small icons and thumbnails by setting a minimum width (default: 150px) to keep your interface clean.
- **Dynamic Support:** Works on pages with lazy-loading (infinite scroll) images.
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
- **Minimum Image Width:** Set a pixel threshold to avoid adding buttons to tiny icons (default 150px).
- **Download Folder:** Specify a folder name to organize downloads.
- **Always ask where to save:** Check this to trigger the "Save As" dialog for every image.

## License

MIT
