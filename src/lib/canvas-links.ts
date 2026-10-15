/**
 * Links on the deliverable canvas, shared by the server and the client. A link points at another
 * card of the same project, or at one of its deliverables — which shares that deliverable here:
 * its work, files, reviews and history stay on its own card, and this card shows it live. A link
 * is placed like a deliverable (at the top level or in a folder) but has a fixed size.
 */

import type { CanvasLinkDTO } from "./types";

/** A link's box on the canvas (it isn't resizable; its height is measured once shown). */
export const LINK_NODE = { w: 248, h: 118 } as const;

/** What a link is called on screen: the shared deliverable's name, or the card's title. */
export function linkName(link: Pick<CanvasLinkDTO, "card" | "deliverable">): string {
  return link.deliverable ? link.deliverable.name : link.card.title;
}

/** "Shared from UTD-3" or "Linked card UTD-3". */
export function linkKind(link: Pick<CanvasLinkDTO, "card" | "deliverable">): string {
  return link.deliverable ? `Shared from ${link.card.key}` : `Linked card ${link.card.key}`;
}

// ── Recent picks (this browser only) ────────────────────────────────────────

const LIMIT = 6;
const PREFIX = "forge:recent-links:";

/** A pick in the link menu: a card (`card:<id>`) or a deliverable (`deliverable:<id>`). */
export type LinkPick = `card:${string}` | `deliverable:${string}`;

export function getRecentLinks(projectId: string): LinkPick[] {
  try {
    const raw = window.localStorage.getItem(`${PREFIX}${projectId}`);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is LinkPick => typeof v === "string" && /^(card|deliverable):/.test(v)).slice(0, LIMIT) : [];
  } catch {
    return [];
  }
}

export function rememberLink(projectId: string, pick: LinkPick): void {
  try {
    const next = [pick, ...getRecentLinks(projectId).filter((p) => p !== pick)].slice(0, LIMIT);
    window.localStorage.setItem(`${PREFIX}${projectId}`, JSON.stringify(next));
  } catch {
    // Private windows and blocked storage: no recents, nothing else changes.
  }
}
