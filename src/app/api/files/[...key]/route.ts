import { Readable } from "node:stream";
import { extensionOf } from "@/server/media/formats";
import { storage } from "@/server/storage";
import { LocalStorageDriver, verifyFileSignature } from "@/server/storage/local";

export const dynamic = "force-dynamic";

const INLINE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  bmp: "image/bmp",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  // Served as mp4 so Chromium plays H.264 QuickTime files while the transcode runs.
  mov: "video/mp4",
  mkv: "video/x-matroska",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  m4a: "audio/mp4",
  // Derived preview data (Roblox manifests, audio peaks) — never user-authored HTML.
  json: "application/json",
};

function contentDisposition(kind: "inline" | "attachment", filename: string) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Serves private objects for the local storage driver. Access requires a valid,
 * unexpired HMAC signature minted by the server for a user who could see the file.
 */
async function serve(req: Request, context: { params: Promise<{ key: string[] }> }, headOnly: boolean) {
  const { key: parts } = await context.params;
  const key = parts.map((p) => decodeURIComponent(p)).join("/");
  const url = new URL(req.url);
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") ?? "";
  const download = url.searchParams.get("dl") ?? "";

  if (!verifyFileSignature(key, exp, download, sig)) {
    return new Response("Link expired", { status: 403, headers: { "cache-control": "no-store" } });
  }
  const store = storage();
  // Duck-typed: dev bundles can hold separate copies of the driver class.
  if (store.name !== "local") return new Response("Not found", { status: 404 });
  const driver = store as LocalStorageDriver;
  const stat = await driver.stat(key);
  if (!stat) return new Response("Not found", { status: 404 });

  const ext = extensionOf(key);
  const inlineType = INLINE_TYPES[ext];
  const forceDownload = Boolean(download) || !inlineType;
  const maxAge = Math.max(0, exp - Math.floor(Date.now() / 1000));
  const headers = new Headers({
    "content-type": forceDownload && !inlineType ? "application/octet-stream" : (inlineType ?? "application/octet-stream"),
    "accept-ranges": "bytes",
    "cache-control": `private, max-age=${maxAge}`,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; img-src 'self'; media-src 'self'; sandbox",
    "cross-origin-resource-policy": "same-origin",
  });
  if (forceDownload) headers.set("content-disposition", contentDisposition("attachment", download || key.split("/").pop()!));

  const range = req.headers.get("range");
  let start = 0;
  let end = stat.size - 1;
  let status = 200;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match || (match[1] === "" && match[2] === "")) {
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${stat.size}` } });
    }
    if (match[1] === "") {
      start = Math.max(0, stat.size - Number(match[2]));
    } else {
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
    }
    if (start > end || start >= stat.size) {
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${stat.size}` } });
    }
    status = 206;
    headers.set("content-range", `bytes ${start}-${end}/${stat.size}`);
  }
  headers.set("content-length", String(end - start + 1));
  if (headOnly) return new Response(null, { status, headers });

  const stream = driver.createReadStream(key, { start, end });
  req.signal.addEventListener("abort", () => stream.destroy());
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, { status, headers });
}

export function GET(req: Request, context: { params: Promise<{ key: string[] }> }) {
  return serve(req, context, false);
}

export function HEAD(req: Request, context: { params: Promise<{ key: string[] }> }) {
  return serve(req, context, true);
}
