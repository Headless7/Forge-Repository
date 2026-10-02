/**
 * Identifies media from its first bytes so a renamed or mislabelled file can't
 * masquerade as an image/video (e.g. HTML uploaded as .png).
 */
export interface Sniffed {
  kind: "IMAGE" | "VIDEO" | "AUDIO";
  mimeType: string;
}

const ascii = (buf: Buffer, start: number, end: number) => buf.subarray(start, end).toString("latin1");

export function sniffMedia(head: Buffer): Sniffed | null {
  if (head.length < 12) return null;

  if (head[0] === 0x89 && ascii(head, 1, 4) === "PNG") return { kind: "IMAGE", mimeType: "image/png" };
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { kind: "IMAGE", mimeType: "image/jpeg" };
  if (ascii(head, 0, 6) === "GIF87a" || ascii(head, 0, 6) === "GIF89a") return { kind: "IMAGE", mimeType: "image/gif" };
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP") return { kind: "IMAGE", mimeType: "image/webp" };
  if (ascii(head, 0, 2) === "BM" && head.length > 26) return { kind: "IMAGE", mimeType: "image/bmp" };

  // Ogg: only audio codecs (Vorbis / Opus) are accepted as audio.
  if (ascii(head, 0, 4) === "OggS") {
    const text = ascii(head, 0, Math.min(head.length, 128));
    if (text.includes("vorbis") || text.includes("OpusHead")) return { kind: "AUDIO", mimeType: "audio/ogg" };
    return null;
  }
  // MP3: ID3v2 tag, or an MPEG audio frame header (sync word + layer I–III).
  if (ascii(head, 0, 3) === "ID3") return { kind: "AUDIO", mimeType: "audio/mpeg" };
  if (head[0] === 0xff && (head[1]! & 0xe0) === 0xe0 && (head[1]! & 0x06) !== 0 && (head[1]! & 0x18) !== 0x08 && (head[2]! & 0xf0) !== 0xf0) {
    return { kind: "AUDIO", mimeType: "audio/mpeg" };
  }

  // EBML header → Matroska / WebM
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    const text = ascii(head, 0, Math.min(head.length, 64));
    return { kind: "VIDEO", mimeType: text.includes("webm") ? "video/webm" : "video/x-matroska" };
  }

  // ISO base media (MP4, MOV, AVIF …)
  const box = ascii(head, 4, 8);
  if (box === "ftyp") {
    const brand = ascii(head, 8, 12);
    if (brand === "avif" || brand === "avis") return { kind: "IMAGE", mimeType: "image/avif" };
    if (brand === "qt  ") return { kind: "VIDEO", mimeType: "video/quicktime" };
    if (brand === "M4V " || brand === "M4VH" || brand === "M4VP") return { kind: "VIDEO", mimeType: "video/x-m4v" };
    if (brand === "heic" || brand === "heix" || brand === "mif1") return null;
    return { kind: "VIDEO", mimeType: "video/mp4" };
  }
  // Legacy QuickTime files without an ftyp box
  if (["moov", "mdat", "wide", "free", "skip", "pnot"].includes(box)) return { kind: "VIDEO", mimeType: "video/quicktime" };

  return null;
}

/** Heuristic for content that browsers could execute if rendered inline. */
export function looksLikeMarkup(head: Buffer): boolean {
  const text = head.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  return text.startsWith("<!doctype html") || text.startsWith("<html") || text.startsWith("<svg") || text.startsWith("<?xml") || text.includes("<script");
}
