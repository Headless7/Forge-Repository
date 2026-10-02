import fsp from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { AttachmentKind } from "@/lib/types";
import { invalid } from "../errors";
import { storage } from "../storage";
import { buildManifest, manifestMeta } from "../roblox/manifest";
import { RobloxParseError } from "../roblox/model";
import { detectRobloxFormat, parseRobloxFile } from "../roblox/parse";
import { computePeaks, probeAudio, renderWaveformThumb, transcodeAudioToM4a } from "./audio";
import { createPreviewClip, extractFrame, ffmpegPath, needsTranscode, probeMedia, transcodeToMp4 } from "./ffmpeg";
import { looksLikeMarkup, sniffMedia } from "./sniff";
import { runtimePath, tempPrefix } from "../runtime-path";

export interface ClientMediaMeta {
  durationMs?: number;
  width?: number;
  height?: number;
}

export interface AnalysisResult {
  kind: AttachmentKind;
  mimeType: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  fps: number | null;
  thumbnailKey: string | null;
  /** Video can't play natively in browsers; a background transcode is required. */
  needsTranscode: boolean;
  /** Video long enough to deserve a lightweight hover-preview clip. */
  wantsPreview: boolean;
  /** Derived preview data to build in the background. */
  derive: "audio" | "roblox" | null;
  meta: Record<string, unknown> | null;
}

/** Bumped whenever the Roblox parser/manifest changes, so stale previews are re-derived (2: adds 2D UI). */
export const ROBLOX_PROCESSOR = "forge-rbx/3";

/** Largest image decoded (pixels). A tiny file can declare huge dimensions; this bounds the memory a decode takes (~480 MB RGBA). */
const MAX_INPUT_PIXELS = 120_000_000;

const THUMB_SIZE = 960;

export function siblingKey(storageKey: string, name: string) {
  return `${storageKey.slice(0, storageKey.lastIndexOf("/"))}/${name}`;
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fsp.mkdtemp(tempPrefix("forge-media-"));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Verifies an uploaded object by content, extracts metadata and writes a WebP
 * thumbnail next to it. Heavy work (transcodes/previews) is reported back so the
 * caller can schedule it in the background.
 */
export async function analyzeUpload(
  input: { kind: AttachmentKind; mimeType: string; storageKey: string },
  clientMeta?: ClientMediaMeta,
): Promise<AnalysisResult> {
  const store = storage();
  const head = await store.readHead(input.storageKey, 4096);
  const base = { width: null, height: null, durationMs: null, fps: null, thumbnailKey: null, needsTranscode: false, wantsPreview: false, derive: null, meta: null };

  if (input.kind === "ROBLOX") {
    const format = detectRobloxFormat(head);
    if (!format) throw invalid("This doesn't look like a Roblox model file (.rbxm / .rbxmx). It may be corrupted or mislabelled.");
    // Parsing (and the preview manifest) happens in the background; the original is never modified.
    return { ...base, kind: "ROBLOX", mimeType: input.mimeType, derive: "roblox", meta: { format } };
  }

  const sniffed = sniffMedia(head);

  if (input.kind !== "FILE" && !sniffed) {
    const what = input.kind === "IMAGE" ? "image" : input.kind === "AUDIO" ? "MP3 or Ogg (Vorbis/Opus) audio file" : "video";
    throw invalid(`This file doesn't look like a valid ${what}. It may be corrupted or mislabelled.`);
  }
  if (!sniffed) {
    return {
      kind: "FILE",
      mimeType: looksLikeMarkup(head) ? "application/octet-stream" : input.mimeType,
      width: null,
      height: null,
      durationMs: null,
      fps: null,
      thumbnailKey: null,
      needsTranscode: false,
      wantsPreview: false,
      derive: null,
      meta: null,
    };
  }

  const local = await store.materialize(input.storageKey);
  try {
    if (sniffed.kind === "IMAGE") {
      // Decode from memory: libvips can't open paths longer than Windows' MAX_PATH (storage keys nest several ids).
      const bytes = await fsp.readFile(local.path);
      const image = sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS });
      const meta = await image.metadata();
      const rotated = (meta.orientation ?? 1) >= 5;
      const thumb = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS })
        .rotate()
        .resize({ width: THUMB_SIZE, height: THUMB_SIZE, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer();
      const thumbnailKey = siblingKey(input.storageKey, "thumb.webp");
      await store.put(thumbnailKey, thumb, "image/webp");
      return {
        kind: "IMAGE",
        mimeType: sniffed.mimeType,
        width: (rotated ? meta.height : meta.width) ?? null,
        height: (rotated ? meta.width : meta.height) ?? null,
        durationMs: null,
        fps: null,
        thumbnailKey,
        needsTranscode: false,
        wantsPreview: false,
        derive: null,
        meta: null,
      };
    }

    if (sniffed.kind === "AUDIO") {
      if (!ffmpegPath()) {
        return { ...base, kind: "AUDIO", mimeType: sniffed.mimeType, durationMs: clientMeta?.durationMs ?? null, meta: {} };
      }
      const probe = await probeAudio(local.path);
      if (!probe.codec) throw invalid("This file has no playable audio track.");
      return {
        ...base,
        kind: "AUDIO",
        mimeType: sniffed.mimeType,
        durationMs: probe.durationMs,
        derive: "audio",
        meta: { codec: probe.codec, sampleRate: probe.sampleRate, channels: probe.channels, bitrateKbps: probe.bitrateKbps },
      };
    }

    // Video
    if (!ffmpegPath()) {
      return {
        kind: "VIDEO",
        mimeType: sniffed.mimeType,
        width: clientMeta?.width ?? null,
        height: clientMeta?.height ?? null,
        durationMs: clientMeta?.durationMs ?? null,
        fps: null,
        thumbnailKey: null,
        needsTranscode: false,
        wantsPreview: false,
        derive: null,
        meta: null,
      };
    }
    const probe = await probeMedia(local.path);
    if (!probe.videoCodec) throw invalid("This video has no playable video track.");
    const durationSec = (probe.durationMs ?? 0) / 1000;
    const posterAt = Math.min(1, durationSec * 0.25);
    const thumbnailKey = await withTempDir(async (dir) => {
      const frame = runtimePath(dir, "poster.jpg");
      await extractFrame(local.path, frame, posterAt);
      const thumb = await sharp(frame)
        .resize({ width: THUMB_SIZE, height: THUMB_SIZE, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
      const key = siblingKey(input.storageKey, "thumb.webp");
      await store.put(key, thumb, "image/webp");
      return key;
    });
    return {
      kind: "VIDEO",
      mimeType: sniffed.mimeType,
      width: probe.width,
      height: probe.height,
      durationMs: probe.durationMs,
      fps: probe.fps,
      thumbnailKey,
      needsTranscode: needsTranscode(sniffed.mimeType, probe),
      wantsPreview: durationSec > 0.5,
      derive: null,
      meta: null,
    };
  } finally {
    await local.cleanup();
  }
}

/** Background: low-res muted preview for hover playback on the board. */
export async function buildPreviewClip(storageKey: string): Promise<string> {
  const store = storage();
  const local = await store.materialize(storageKey);
  try {
    return await withTempDir(async (dir) => {
      const out = runtimePath(dir, "preview.mp4");
      await createPreviewClip(local.path, out);
      const key = siblingKey(storageKey, "preview.mp4");
      await store.putFile(key, out, "video/mp4");
      return key;
    });
  } finally {
    await local.cleanup();
  }
}

/** Background: full-length browser-playable MP4. */
export async function buildPlaybackTranscode(storageKey: string): Promise<string> {
  const store = storage();
  const local = await store.materialize(storageKey);
  try {
    return await withTempDir(async (dir) => {
      const out = runtimePath(dir, "playback.mp4");
      await transcodeToMp4(local.path, out);
      const key = siblingKey(storageKey, "playback.mp4");
      await store.putFile(key, out, "video/mp4");
      return key;
    });
  } finally {
    await local.cleanup();
  }
}

export interface AudioDerivatives {
  derivedKey: string | null;
  thumbnailKey: string | null;
  playbackKey: string | null;
  durationMs: number | null;
  error?: string;
}

/** Background: waveform peaks (for the player), a waveform thumbnail (for boards) and an Ogg compatibility copy. */
export async function buildAudioDerivatives(storageKey: string, mimeType: string): Promise<AudioDerivatives> {
  const store = storage();
  const local = await store.materialize(storageKey);
  try {
    return await withTempDir(async (dir) => {
      const peaks = await computePeaks(local.path, dir);
      const derivedKey = siblingKey(storageKey, "peaks.json");
      await store.put(derivedKey, Buffer.from(JSON.stringify(peaks)), "application/json");
      const thumbnailKey = siblingKey(storageKey, "thumb.webp");
      await store.put(thumbnailKey, await renderWaveformThumb(peaks.peaks), "image/webp");
      let playbackKey: string | null = null;
      if (mimeType === "audio/ogg") {
        const out = runtimePath(dir, "playback.m4a");
        await transcodeAudioToM4a(local.path, out);
        playbackKey = siblingKey(storageKey, "playback.m4a");
        await store.putFile(playbackKey, out, "audio/mp4");
      }
      return { derivedKey, thumbnailKey, playbackKey, durationMs: peaks.durationMs };
    });
  } catch (error) {
    return { derivedKey: null, thumbnailKey: null, playbackKey: null, durationMs: null, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await local.cleanup();
  }
}

/**
 * Background: parses a Roblox file (never executing anything in it) into the preview
 * manifest the viewer renders, stored next to the original and tied to this revision.
 */
export async function buildRobloxManifest(storageKey: string): Promise<Record<string, unknown>> {
  const store = storage();
  const local = await store.materialize(storageKey);
  try {
    const bytes = new Uint8Array(await fsp.readFile(local.path));
    const manifest = buildManifest(parseRobloxFile(bytes));
    const derivedKey = siblingKey(storageKey, "manifest.json");
    await store.put(derivedKey, Buffer.from(JSON.stringify(manifest)), "application/json");
    return { ...manifestMeta(manifest), derivedKey, processor: ROBLOX_PROCESSOR };
  } catch (error) {
    const message =
      error instanceof RobloxParseError
        ? `Couldn't read this Roblox file (${error.message.replace(/\.$/, "")}). It may be incomplete or corrupted — re-export it from Roblox Studio and upload it as a new revision.`
        : "The file couldn't be read. It may be corrupted or use a format this preview doesn't support.";
    if (!(error instanceof RobloxParseError)) console.error("[forge] Roblox parse failed", error);
    return { previewError: message, processor: ROBLOX_PROCESSOR };
  } finally {
    await local.cleanup();
  }
}

/** Square WebP avatar from an uploaded image buffer. */
export async function renderAvatar(buffer: Buffer): Promise<Buffer> {
  const sniffed = sniffMedia(buffer);
  if (!sniffed || sniffed.kind !== "IMAGE") throw invalid("Avatars must be PNG, JPG, WebP or GIF images.");
  return sharp(buffer, { limitInputPixels: 8192 * 8192 })
    .rotate()
    .resize(256, 256, { fit: "cover", position: "attention" })
    .webp({ quality: 85 })
    .toBuffer();
}
