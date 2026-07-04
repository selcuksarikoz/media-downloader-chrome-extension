import { defineConfig } from "vite";
import { resolve } from "path";
import { viteStaticCopy } from "vite-plugin-static-copy";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        background: resolve(__dirname, "background.js"),
        content: resolve(__dirname, "content.js"),
        "media-bridge": resolve(__dirname, "media-bridge.js"),
        options: resolve(__dirname, "options.html"),
        styles: resolve(__dirname, "styles.scss"),
      },
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
      renderChunk(code, chunk) {
        if (chunk.name !== "media-bridge") return null;

        // Chrome executes MAIN-world content scripts as classic scripts. Keep
        // minified bindings private so page globals cannot overwrite them.
        return {
          code: `(() => {\n${code}\n})();`,
          map: null,
        };
      },
    },
    viteStaticCopy({
      targets: [
        {
          src: "manifest.json",
          dest: ".",
        },
        {
          src: "icons",
          dest: ".",
        },
      ],
    }),
  ],
});
