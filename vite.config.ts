import { defineConfig } from "vite";
import { resolve } from "path";
import { viteStaticCopy } from "vite-plugin-static-copy";

/**
 * Every extension script is loaded as a classic script (the MAIN-world bridge
 * in particular), so each output must be self-contained. A single Vite build
 * with several inputs would emit shared ESM chunks and break at runtime, hence
 * `build.mjs` builds one entry at a time with this factory.
 */
export function createEntryConfig(name: string, input: string, isFirst: boolean) {
  return {
    // build.mjs supplies the whole configuration; do not merge the file config
    // again or every entry would inherit all the other inputs/plugins.
    configFile: false,
    build: {
      outDir: "dist",
      emptyOutDir: isFirst,
      sourcemap: true,
      modulePreload: false,
      rollupOptions: {
        input: { [name]: resolve(__dirname, input) },
        output: {
          entryFileNames: "[name].js",
          chunkFileNames: "[name].js",
          assetFileNames: "[name].[ext]",
        },
      },
    },
    plugins: [
      {
        name: "isolate-main-world-content-script",
        renderChunk(code: string, chunk: { name: string }) {
          if (chunk.name !== "media-bridge") return null;
          return {
            code: `(() => {\n${code}\n})();`,
            map: null,
          };
        },
      },
      ...(isFirst
        ? [
            viteStaticCopy({
              targets: [
                { src: "manifest.json", dest: "." },
                { src: "icons/icon16.png", dest: "icons" },
                { src: "icons/icon48.png", dest: "icons" },
                { src: "icons/icon128.png", dest: "icons" },
                {
                  src: "node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js",
                  dest: "ffmpeg",
                },
                {
                  src: "node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm",
                  dest: "ffmpeg",
                },
                {
                  src: "ffmpeg-mux-worker.js",
                  dest: "ffmpeg",
                },
                {
                  src: "ffmpeg-host.html",
                  dest: "ffmpeg",
                },
                {
                  src: "ffmpeg-host.js",
                  dest: "ffmpeg",
                },
                {
                  src: "ffmpeg-offscreen.html",
                  dest: "ffmpeg",
                },
                {
                  src: "ffmpeg-offscreen.js",
                  dest: "ffmpeg",
                },
              ],
            }),
          ]
        : []),
    ],
  };
}

export const ENTRIES = [
  ["background", "background.js"],
  ["content", "src/content/index.js"],
  ["media-bridge", "media-bridge.js"],
  ["popup", "popup.html"],
  ["options", "options.html"],
  ["styles", "styles.scss"],
] as const;

export default defineConfig(createEntryConfig(ENTRIES[0][0], ENTRIES[0][1], true));
