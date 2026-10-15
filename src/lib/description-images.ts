/**
 * Images in descriptions (a card's or a deliverable's). The text keeps a marker where each image
 * goes — `![name](image:<id>)` — and the image itself is a file stored in Forge (an attachment
 * with the DESCRIPTION purpose), never a hotlink: pasted links are copied in, since Discord's
 * expire. Saving a description archives the images it no longer shows, and brings back ones
 * it shows again.
 */

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** One image marker. Group 1: its name, group 2: the image id. */
export const IMAGE_TOKEN = new RegExp(`!\\[([^\\]\\n]{0,200})\\]\\(image:(${ID})\\)`, "gi");

/** Markers for images still uploading while someone writes (never saved). */
export const PENDING_TOKEN = /!\[([^\]\n]{0,200})\]\(image:pending-[a-z0-9]+\)/gi;

export function imageToken(name: string, id: string): string {
  const clean = name.replace(/[[\]\n\r]/g, " ").trim().slice(0, 120) || "image";
  return `![${clean}](image:${id})`;
}

/** The images a description shows, in order, each once. */
export function descriptionImageIds(text: string): string[] {
  const ids: string[] = [];
  for (const m of text.matchAll(IMAGE_TOKEN)) {
    const id = m[2]!.toLowerCase();
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** The description as plain text for one-line previews: each image as "[image]". */
export function plainDescription(text: string): string {
  return text.replace(IMAGE_TOKEN, "[image]").replace(PENDING_TOKEN, "[image]");
}

/** A pasted address that is (very likely) a picture: an image file, or Discord's media proxy. */
export function looksLikeImageUrl(text: string): boolean {
  const value = text.trim();
  if (!/^https?:\/\/\S+$/i.test(value)) return false;
  try {
    const url = new URL(value);
    if (/\.(png|jpe?g|gif|webp|avif)$/i.test(url.pathname)) return true;
    return url.hostname === "media.discordapp.net" && /^\/attachments\//.test(url.pathname) && /\b(format=(png|jpe?g|webp))\b/i.test(url.search);
  } catch {
    return false;
  }
}
