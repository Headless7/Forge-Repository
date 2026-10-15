/**
 * Folders on the deliverable canvas, shared by the server and the client. A folder is a named
 * frame around the deliverables (and folders) inside it; folders nest to any depth. Deliverables
 * keep absolute canvas positions whatever folder they're in, so a folder has no geometry of its
 * own: its frame is the box around its contents (`folderFrames`). A collapsed folder is drawn as
 * one compact node and hides what's inside; arrows to hidden work attach to the folder instead
 * (`visibleFolderOf`).
 */

import type { CardState } from "./types";

export const FOLDER_NAME_MAX = 60;
export const DEFAULT_FOLDER_NAME = "New folder";
/** Space between a frame's edge and its contents. */
export const FOLDER_PAD = 18;
/** The frame's title strip. */
export const FOLDER_HEADER = 34;
/** A collapsed folder's node. */
export const FOLDER_COLLAPSED = { w: 236, h: 64 } as const;
/** Narrowest frame (room for the title). */
export const FOLDER_MIN_W = 236;
/** Gap left beside a deliverable when another is dropped onto it to group the two. */
export const GROUP_DROP_GAP = 24;

export interface FolderLike {
  id: string;
  parentId: string | null;
}
export interface FolderItemLike {
  id: string;
  groupId: string | null;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function foldersById<F extends FolderLike>(folders: readonly F[]): Map<string, F> {
  return new Map(folders.map((f) => [f.id, f]));
}

/** The folders a folder sits in, nearest first (never itself; stops on a broken or looping chain). */
export function folderAncestors(byId: ReadonlyMap<string, FolderLike>, folderId: string | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>(folderId ? [folderId] : []);
  let cursor = folderId ? (byId.get(folderId)?.parentId ?? null) : null;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    out.push(cursor);
    cursor = byId.get(cursor)?.parentId ?? null;
  }
  return out;
}

/** The chain from the top level down to (and including) a folder — for breadcrumbs. */
export function folderPath(byId: ReadonlyMap<string, FolderLike>, folderId: string | null): string[] {
  if (!folderId || !byId.has(folderId)) return [];
  return [...folderAncestors(byId, folderId).reverse(), folderId];
}

/** How many folders something placed in `parentId` sits inside. */
export function folderDepth(byId: ReadonlyMap<string, FolderLike>, parentId: string | null): number {
  return parentId ? folderAncestors(byId, parentId).length + 1 : 0;
}

/** True when `target` is `folderId` itself or sits somewhere inside it — a folder can't be moved there. */
export function folderContains(byId: ReadonlyMap<string, FolderLike>, folderId: string, target: string | null): boolean {
  if (!target) return false;
  return target === folderId || folderAncestors(byId, target).includes(folderId);
}

/** Everything inside a folder, at any depth. */
export function folderDescendants(folders: readonly FolderLike[], items: readonly FolderItemLike[], folderId: string): { folderIds: string[]; itemIds: string[] } {
  const folderIds: string[] = [];
  const queue = [folderId];
  const seen = new Set<string>([folderId]);
  while (queue.length) {
    const id = queue.shift()!;
    for (const f of folders) {
      if (f.parentId === id && !seen.has(f.id)) {
        seen.add(f.id);
        folderIds.push(f.id);
        queue.push(f.id);
      }
    }
  }
  const inside = new Set([folderId, ...folderIds]);
  return { folderIds, itemIds: items.filter((i) => i.groupId && inside.has(i.groupId)).map((i) => i.id) };
}

/**
 * The folder a node is seen as: none when every folder around it is open, otherwise the
 * outermost collapsed folder around it. Nodes inside a collapsed folder are hidden and their
 * arrows attach to that folder.
 */
export function visibleFolderOf(byId: ReadonlyMap<string, FolderLike & { collapsed: boolean }>, groupId: string | null): string | null {
  if (!groupId) return null;
  const chain = [groupId, ...folderAncestors(byId, groupId)];
  let visible: string | null = null;
  for (const id of chain) if (byId.get(id)?.collapsed) visible = id;
  return visible;
}

/** "3 deliverables · 1 approved · 1 needs attention" */
export function folderSummary(count: number, states: readonly CardState[]): string {
  const approved = states.filter((s) => s === "APPROVED").length;
  const parts = [`${count} deliverable${count === 1 ? "" : "s"}`];
  if (approved) parts.push(approved === count ? "all approved" : `${approved} approved`);
  const attention = states.filter((s) => s === "NEEDS_REVIEW" || s === "CHANGES_REQUESTED").length;
  if (attention) parts.push(`${attention} need${attention === 1 ? "s" : ""} attention`);
  return parts.join(" · ");
}

/** A sensible name for a folder made from these deliverables: their shared type, else a placeholder. */
export function defaultFolderName(members: ReadonlyArray<{ assetType: string }>): string {
  const types = new Set(members.map((m) => m.assetType.trim()).filter(Boolean));
  if (members.length && types.size === 1 && members.every((m) => m.assetType.trim())) return [...types][0]!;
  return DEFAULT_FOLDER_NAME;
}

/** Frames for every folder: the box around its contents (bottom-up), or the compact node when collapsed. */
export function folderFrames<F extends FolderLike & { collapsed: boolean }>(folders: readonly F[], items: ReadonlyArray<FolderItemLike & { rect: Rect }>): Map<string, Rect> {
  const frames = new Map<string, Rect>();
  const childFolders = new Map<string | null, F[]>();
  for (const f of folders) childFolders.set(f.parentId, [...(childFolders.get(f.parentId) ?? []), f]);
  const childItems = new Map<string | null, Rect[]>();
  for (const i of items) childItems.set(i.groupId, [...(childItems.get(i.groupId) ?? []), i.rect]);
  const visiting = new Set<string>();
  const frameOf = (f: F): Rect => {
    const known = frames.get(f.id);
    if (known) return known;
    if (visiting.has(f.id)) return { x: 0, y: 0, ...FOLDER_COLLAPSED }; // a broken chain never hangs the canvas
    visiting.add(f.id);
    const rects = [...(childItems.get(f.id) ?? []), ...(childFolders.get(f.id) ?? []).map(frameOf)];
    let frame: Rect;
    if (!rects.length) frame = { x: 0, y: 0, ...FOLDER_COLLAPSED };
    else {
      const minX = Math.min(...rects.map((r) => r.x));
      const minY = Math.min(...rects.map((r) => r.y));
      const maxX = Math.max(...rects.map((r) => r.x + r.w));
      const maxY = Math.max(...rects.map((r) => r.y + r.h));
      frame = f.collapsed
        ? { x: minX, y: minY, ...FOLDER_COLLAPSED }
        : {
            x: minX - FOLDER_PAD,
            y: minY - FOLDER_PAD - FOLDER_HEADER,
            w: Math.max(FOLDER_MIN_W, maxX - minX + 2 * FOLDER_PAD),
            h: maxY - minY + 2 * FOLDER_PAD + FOLDER_HEADER,
          };
    }
    frames.set(f.id, frame);
    visiting.delete(f.id);
    return frame;
  };
  for (const f of folders) frameOf(f);
  return frames;
}

export function rectContains(r: Rect, p: { x: number; y: number }): boolean {
  return p.x >= r.x && p.y >= r.y && p.x <= r.x + r.w && p.y <= r.y + r.h;
}

/**
 * Where a drop lands. Deliverables win over folders (dropping onto one groups the two); among
 * folders the innermost wins. `excluded` are the dragged nodes and everything inside them.
 */
export function dropTargetAt(
  point: { x: number; y: number },
  candidates: ReadonlyArray<{ id: string; kind: "deliverable" | "folder"; rect: Rect; depth: number }>,
  excluded: ReadonlySet<string>,
): { id: string; kind: "deliverable" | "folder" } | null {
  let best: { id: string; kind: "deliverable" | "folder"; depth: number } | null = null;
  for (const c of candidates) {
    if (excluded.has(c.id) || !rectContains(c.rect, point)) continue;
    if (c.kind === "deliverable") return { id: c.id, kind: c.kind };
    if (!best || c.depth > best.depth) best = c;
  }
  return best ? { id: best.id, kind: best.kind } : null;
}

/** A list-view tree: siblings in position order, a folder placed where its first deliverable would be. */
export type FolderTreeNode<F, I> = { kind: "folder"; folder: F; children: FolderTreeNode<F, I>[]; order: number } | { kind: "item"; item: I; order: number };

export function folderTree<F extends FolderLike, I extends FolderItemLike & { position: number }>(folders: readonly F[], items: readonly I[]): FolderTreeNode<F, I>[] {
  const byId = foldersById(folders);
  const build = (parentId: string | null, seen: Set<string>): FolderTreeNode<F, I>[] => {
    const nodes: FolderTreeNode<F, I>[] = items
      .filter((i) => (i.groupId && byId.has(i.groupId) ? i.groupId : null) === parentId)
      .map((item) => ({ kind: "item", item, order: item.position }));
    for (const folder of folders) {
      if (folder.parentId !== parentId || seen.has(folder.id)) continue;
      const children = build(folder.id, new Set([...seen, folder.id]));
      nodes.push({ kind: "folder", folder, children, order: children.length ? Math.min(...children.map((c) => c.order)) : Number.POSITIVE_INFINITY });
    }
    return nodes.sort((a, b) => a.order - b.order);
  };
  return build(null, new Set());
}
