import { rm, cp, mkdir } from "fs/promises";
import { existsSync } from "fs";

const distDir = "./dist";
const filesToCopy = [
  "manifest.json",
  "background.js",
  "content.js",
  "options.html",
  "options.js",
  "styles.css",
];

console.log("Building extension...");

// Clean dist directory
if (existsSync(distDir)) {
  await rm(distDir, { recursive: true, force: true });
}
await mkdir(distDir);

// Copy files
for (const file of filesToCopy) {
  if (existsSync(file)) {
    await cp(file, `${distDir}/${file}`, { recursive: true });
    console.log(`Copied ${file}`);
  } else {
    console.warn(`Warning: File ${file} not found.`);
  }
}

console.log("\nBuild complete! 🚀");
console.log(
  "Please load the 'dist' folder in Chrome (instead of the root folder)."
);
