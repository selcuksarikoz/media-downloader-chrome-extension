import createFFmpegCore from "./ffmpeg-core.js";

const CORE_URL = new URL("./ffmpeg-core.js", import.meta.url).href;
const WASM_URL = new URL("./ffmpeg-core.wasm", import.meta.url).href;

self.onmessage = async (event) => {
  if (event.data?.action === "release") {
    URL.revokeObjectURL(event.data.url);
    self.close();
    return;
  }
  const { muxId, tracks, startTime } = event.data || {};
  if (!muxId || !tracks?.length) return;
  let ffmpeg;
  const inputNames = [];
  const inputDirectory = "/inputs";
  let outputName = "output.mp4";
  const ffmpegLogs = [];
  const captureLog = (line) => {
    const text = String(line || "").trim();
    if (!text) return;
    ffmpegLogs.push(text);
    if (ffmpegLogs.length > 30) ffmpegLogs.shift();
  };
  try {
    ffmpeg = await createFFmpegCore({
      print: captureLog,
      printErr: captureLog,
      mainScriptUrlOrBlob: `${CORE_URL}#${btoa(
        JSON.stringify({ wasmURL: WASM_URL, workerURL: "" }),
      )}`,
    });

    const mountedBlobs = [];
    for (let i = 0; i < tracks.length; i++) {
      const extension = /webm/i.test(tracks[i].mimeType) ? "webm" : "mp4";
      const name = `input-${i}.${extension}`;
      inputNames.push(`${inputDirectory}/${name}`);
      mountedBlobs.push({ name, data: tracks[i].blob });
    }
    ffmpeg.FS.mkdir(inputDirectory);
    ffmpeg.FS.mount(
      ffmpeg.FS.filesystems.WORKERFS,
      { blobs: mountedBlobs },
      inputDirectory,
    );

    const videoIndex = tracks.findIndex((track) =>
      /video/i.test(track.mimeType),
    );
    const audioIndex = tracks.findIndex((track) =>
      /audio/i.test(track.mimeType),
    );
    if (videoIndex < 0) throw new Error("No video track was captured.");

    const videoNeedsH264 =
      /(?:vp0?9|av0?1)/i.test(tracks[videoIndex].mimeType || "") ||
      await blobContainsCodecTag(
        tracks[videoIndex].blob,
        ["vp09", "av01"],
      );

    const useWebm =
      !videoNeedsH264 &&
      tracks.some((track) =>
        /webm|vp8|vp9|opus/i.test(track.mimeType),
      );
    outputName = useWebm ? "output.webm" : "output.mp4";
    const args = [];
    for (const name of inputNames) args.push("-i", name);
    if (Number.isFinite(startTime) && startTime > 0) {
      args.push("-ss", String(startTime));
    }
    args.push(
      "-map",
      `${videoIndex}:v:0`,
      "-map",
      audioIndex >= 0 ? `${audioIndex}:a:0` : `${videoIndex}:a:0?`,
    );
    if (videoNeedsH264) {
      args.push(
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "21",
        "-pix_fmt",
        "yuv420p",
        "-profile:v",
        "high",
        "-tag:v",
        "avc1",
        "-c:a",
        "copy",
      );
    } else {
      args.push("-c", "copy");
    }
    args.push("-avoid_negative_ts", "make_zero");
    if (!useWebm) {
      // Finder/Quick Look expects the MP4 index near the beginning of the
      // file. This adds a final container-only pass; media is still copied
      // without re-encoding.
      args.push("-movflags", "+faststart", "-brand", "mp42");
    }
    args.push(outputName);

    ffmpeg.exec(...args);
    const exitCode = ffmpeg.ret;
    ffmpeg.reset();
    if (exitCode !== 0) {
      const detail = ffmpegLogs.slice(-4).join(" | ");
      throw new Error(
        `FFmpeg mux failed (${exitCode})${detail ? `: ${detail}` : "."}`
      );
    }

    const output = ffmpeg.FS.readFile(outputName);
    const blob = new Blob([output], {
      type: useWebm ? "video/webm" : "video/mp4",
    });
    if (!blob.size) throw new Error("FFmpeg produced an empty video.");
    const url = URL.createObjectURL(blob);
    self.postMessage({
      muxId,
      ok: true,
      url,
      extension: useWebm ? "webm" : "mp4",
    });
  } catch (error) {
    self.postMessage({
      muxId,
      ok: false,
      error: error?.message || String(error),
    });
    self.close();
  } finally {
    if (ffmpeg) {
      try {
        ffmpeg.FS.unmount(inputDirectory);
        ffmpeg.FS.rmdir(inputDirectory);
      } catch {}
      for (const name of [outputName]) {
        try {
          ffmpeg.FS.unlink(name);
        } catch {}
      }
    }
  }
};

async function blobContainsCodecTag(blob, tags) {
  if (!(blob instanceof Blob) || !blob.size) return false;
  const probeSize = Math.min(blob.size, 4 * 1024 * 1024);
  const bytes = new Uint8Array(await blob.slice(0, probeSize).arrayBuffer());
  for (let offset = 0; offset <= bytes.length - 4; offset += 1) {
    for (const tag of tags) {
      if (
        bytes[offset] === tag.charCodeAt(0) &&
        bytes[offset + 1] === tag.charCodeAt(1) &&
        bytes[offset + 2] === tag.charCodeAt(2) &&
        bytes[offset + 3] === tag.charCodeAt(3)
      ) {
        return true;
      }
    }
  }
  return false;
}
