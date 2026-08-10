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
  try {
    ffmpeg = await createFFmpegCore({
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

    const useWebm = tracks.some((track) =>
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
      "-c",
      "copy",
      "-avoid_negative_ts",
      "make_zero",
    );
    args.push(outputName);

    ffmpeg.exec(...args);
    const exitCode = ffmpeg.ret;
    ffmpeg.reset();
    if (exitCode !== 0) throw new Error(`FFmpeg mux failed (${exitCode}).`);

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
