import { readFile, unlink, writeFile } from "node:fs/promises";
import { build } from "vite";
import { createEntryConfig, ENTRIES } from "./vite.config.ts";

for (const [index, [name, input]] of ENTRIES.entries()) {
  process.stdout.write(`Building ${name}...\n`);
  await build(createEntryConfig(name, input, index === 0));
}

// options.html shares the main stylesheet with the popup/content styles. The
// separate per-entry build emits a duplicate; point the page at styles.css.
const optionsHtml = "dist/options.html";
const html = await readFile(optionsHtml, "utf8");
await writeFile(optionsHtml, html.replaceAll("/options.css", "/styles.css"));
await unlink("dist/options.css");

process.stdout.write("Build complete.\n");
