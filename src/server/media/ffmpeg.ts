import { spawn } from "node:child_process";
import fs from "node:fs";
import ffmpegStatic from "ffmpeg-static";
import { env } from "../env";

let resolved: string | null | undefined;

/** Path to an ffmpeg binary (FFMPEG_PATH or the bundled ffmpeg-static), or null if unavailable. */
export function ffmpegPath(): string | null {
  if (resolved !== undefined) return resolved;
  const candidates = [env.FFMPEG_PATH, typeof ffmpegStatic === "string" ? ffmpegStatic : null];
  resolved = candidates.find((c): c is string => Boolean(c && fs.existsSync(c))) ?? null;
  if (!resolved) console.warn("[forge] ffmpeg not found — video thumbnails and transcodes are disabled.");
  return resolved;
}

export function runFfmpeg(args: string[], timeoutMs = 10 * 60 * 1000): Promise<{ code: number; stderr: string }> {
  const bin = ffmpegPath();
  if (!bin) return Promise.reject(new Error("ffmpeg is not available"));
  return new Promise((resolve, reject) => {
    // The binary comes from ffmpeg-static (an external package), so build tracing can skip this call.
    const child = spawn(/*turbopackIgnore: true*/ bin, ["-hide_banner", "-nostdin", ...args], { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("ffmpeg timed out"));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stderr });
    });
  });
}

export interface ProbeResult {
  durationMs: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
}

/** Parses `ffmpeg -i` diagnostics (avoids shipping a separate ffprobe binary). */
export async function probeMedia(file: string): Promise<ProbeResult> {
  const { stderr } = await runFfmpeg(["-i", file], 60_000);
  const duration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const videoLine = /Stream #\d+:\d+[^:]*: Video: ([^\n]+)/.exec(stderr)?.[1] ?? null;
  const audioLine = /Stream #\d+:\d+[^:]*: Audio: ([^\n]+)/.exec(stderr)?.[1] ?? null;

  let width: number | null = null;
  let height: number | null = null;
  let fps: number | null = null;
  if (videoLine) {
    const dims = /(\d{2,5})x(\d{2,5})/.exec(videoLine);
    if (dims) {
      width = Number(dims[1]);
      height = Number(dims[2]);
    }
    const rate = /([\d.]+)\s*fps/.exec(videoLine) ?? /([\d.]+)\s*tbr/.exec(videoLine);
    if (rate) fps = Number(rate[1]);
  }
  // Phones record rotated frames plus a display matrix; report displayed dimensions.
  const rotation = /rotation of (-?[\d.]+) degrees/.exec(stderr) ?? /rotate\s*:\s*(-?\d+)/.exec(stderr);
  if (rotation && width && height && Math.abs(Number(rotation[1])) % 180 === 90) [width, height] = [height, width];

  return {
    durationMs: duration
      ? Math.round((Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])) * 1000)
      : null,
    width,
    height,
    fps: fps && Number.isFinite(fps) ? Math.round(fps * 1000) / 1000 : null,
    videoCodec: videoLine ? videoLine.split(/[\s,(]/)[0]! : null,
    audioCodec: audioLine ? audioLine.split(/[\s,(]/)[0]! : null,
  };
}

export async function extractFrame(file: string, output: string, atSeconds: number, maxWidth = 1280) {
  const { code, stderr } = await runFfmpeg(
    [
      "-y",
      "-ss",
      atSeconds.toFixed(3),
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      `scale='min(${maxWidth},iw)':-2`,
      "-q:v",
      "3",
      output,
    ],
    120_000,
  );
  if (code !== 0 || !fs.existsSync(output)) throw new Error(`Frame extraction failed: ${stderr.slice(-400)}`);
}

/** Short, muted, low-res loop used for hover previews on the board. */
export async function createPreviewClip(file: string, output: string, maxSeconds = 8) {
  const { code, stderr } = await runFfmpeg([
    "-y",
    "-i",
    file,
    "-t",
    String(maxSeconds),
    "-an",
    "-vf",
    "scale='min(480,iw)':-2,fps=24",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "30",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    output,
  ]);
  if (code !== 0) throw new Error(`Preview encode failed: ${stderr.slice(-400)}`);
}

/** Browser-friendly H.264/AAC MP4 for sources browsers can't play (MOV/ProRes, MKV …). */
export async function transcodeToMp4(file: string, output: string) {
  const { code, stderr } = await runFfmpeg([
    "-y",
    "-i",
    file,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "21",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-movflags",
    "+faststart",
    output,
  ]);
  if (code !== 0) throw new Error(`Transcode failed: ${stderr.slice(-400)}`);
}

const BROWSER_VIDEO_CODECS = new Set(["h264", "vp8", "vp9", "av1"]);
const BROWSER_AUDIO_CODECS = new Set(["aac", "opus", "vorbis", "mp3"]);

export function needsTranscode(mimeType: string, probe: ProbeResult): boolean {
  if (mimeType !== "video/mp4" && mimeType !== "video/webm" && mimeType !== "video/x-m4v") return true;
  if (probe.videoCodec && !BROWSER_VIDEO_CODECS.has(probe.videoCodec)) return true;
  if (probe.audioCodec && !BROWSER_AUDIO_CODECS.has(probe.audioCodec)) return true;
  return false;
}
