import type { AttachmentKind } from "@/lib/types";
import { env } from "../env";

export const IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/bmp": "bmp",
};

/** Audio accepted for in-app review (verified by content: Ogg Vorbis/Opus and MPEG audio). */
export const AUDIO_TYPES: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
};

/** Roblox model and place files (binary and XML). */
export const ROBLOX_TYPES: Record<string, string> = {
  "application/x-roblox-model": "rbxm",
  "application/x-roblox-model+xml": "rbxmx",
  "application/x-roblox-place": "rbxl",
  "application/x-roblox-place+xml": "rbxlx",
};

export const VIDEO_TYPES: Record<string, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-m4v": "m4v",
  "video/x-matroska": "mkv",
};

const EXTENSION_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  bmp: "image/bmp",
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  mp3: "audio/mpeg",
  rbxm: "application/x-roblox-model",
  rbxmx: "application/x-roblox-model+xml",
  rbxl: "application/x-roblox-place",
  rbxlx: "application/x-roblox-place+xml",
};

/** Files accepted as stand-ins for Roblox meshes (see roblox_resources). */
export const MESH_EXTENSIONS = new Set(["mesh", "obj", "glb", "fbx"]);

/** Executables and scripts are never accepted, regardless of declared type. */
const BLOCKED_EXTENSIONS = new Set([
  "exe", "msi", "bat", "cmd", "com", "scr", "pif", "ps1", "psm1", "vbs", "vbe", "wsf", "wsh",
  "jar", "dll", "sys", "cpl", "hta", "lnk", "reg", "sh", "bash", "app", "dmg", "pkg", "apk",
]);

export function extensionOf(filename: string): string {
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(filename);
  return match ? match[1]!.toLowerCase() : "";
}

export function sanitizeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "file";
  const cleaned = base
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return cleaned || "file";
}

/** Safe object-key segment derived from a filename. */
export function storageName(filename: string): string {
  const ext = extensionOf(filename);
  const stem = filename
    .replace(/\.[^.]+$/, "")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${stem || "file"}${ext ? `.${ext}` : ""}`;
}

export interface Classification {
  kind: AttachmentKind;
  mimeType: string;
}

/** Classifies an upload from its declared type and extension (verified later by content sniffing). */
export function classifyUpload(filename: string, declaredType: string): Classification | { error: string } {
  const ext = extensionOf(filename);
  if (BLOCKED_EXTENSIONS.has(ext)) return { error: `.${ext} files can't be uploaded.` };
  const declared = declaredType.toLowerCase().split(";")[0]!.trim();
  const byExt = EXTENSION_TO_MIME[ext];
  // Roblox files are identified by extension (browsers declare them as octet-stream).
  if (byExt && ROBLOX_TYPES[byExt]) return { kind: "ROBLOX", mimeType: byExt };
  const mime = IMAGE_TYPES[declared] || VIDEO_TYPES[declared] || AUDIO_TYPES[declared] ? declared : byExt ?? declared;
  if (IMAGE_TYPES[mime]) return { kind: "IMAGE", mimeType: mime };
  if (VIDEO_TYPES[mime]) return { kind: "VIDEO", mimeType: mime };
  if (AUDIO_TYPES[mime] || declared === "audio/mp3" || declared === "audio/x-mpeg" || declared === "audio/vorbis") {
    return { kind: "AUDIO", mimeType: AUDIO_TYPES[mime] ? mime : ext === "mp3" ? "audio/mpeg" : "audio/ogg" };
  }
  if (MESH_EXTENSIONS.has(ext)) return { kind: "FILE", mimeType: ext === "glb" ? "model/gltf-binary" : ext === "obj" ? "model/obj" : "application/octet-stream" };
  if (mime === "image/svg+xml" || ext === "svg") {
    // SVG can carry scripts; accept it only as a downloadable file.
    return { kind: "FILE", mimeType: "image/svg+xml" };
  }
  return { kind: "FILE", mimeType: declared && /^[\w.+-]+\/[\w.+-]+$/.test(declared) ? declared : "application/octet-stream" };
}

export function maxBytesFor(kind: AttachmentKind): number {
  const mb =
    kind === "IMAGE"
      ? env.MAX_IMAGE_UPLOAD_MB
      : kind === "VIDEO"
        ? env.MAX_VIDEO_UPLOAD_MB
        : kind === "AUDIO"
          ? env.MAX_AUDIO_UPLOAD_MB
          : kind === "ROBLOX"
            ? env.MAX_ROBLOX_UPLOAD_MB
            : env.MAX_FILE_UPLOAD_MB;
  return Math.floor(mb * 1024 * 1024);
}

/** Types a browser may render inline; everything else is served as a download. */
export function isInlineSafe(mimeType: string): boolean {
  return Boolean(IMAGE_TYPES[mimeType] || VIDEO_TYPES[mimeType] || AUDIO_TYPES[mimeType]);
}
