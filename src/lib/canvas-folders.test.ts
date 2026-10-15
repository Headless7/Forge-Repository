import { describe, expect, it } from "vitest";
import {
  DEFAULT_FOLDER_NAME,
  defaultFolderName,
  dropTargetAt,
  FOLDER_COLLAPSED,
  FOLDER_HEADER,
  FOLDER_PAD,
  folderContains,
  folderDepth,
  folderDescendants,
  folderFrames,
  folderPath,
  folderTree,
  foldersById,
  visibleFolderOf,
} from "./canvas-folders";

const folders = [
  { id: "ui", parentId: null, collapsed: false },
  { id: "items", parentId: "ui", collapsed: false },
  { id: "relics", parentId: "items", collapsed: true },
  { id: "vfx", parentId: null, collapsed: false },
];
const byId = foldersById(folders);
const items = [
  { id: "a", groupId: "ui", position: 3, rect: { x: 100, y: 100, w: 200, h: 100 } },
  { id: "b", groupId: "items", position: 1, rect: { x: 400, y: 120, w: 200, h: 100 } },
  { id: "c", groupId: "relics", position: 2, rect: { x: 700, y: 300, w: 200, h: 100 } },
  { id: "d", groupId: null, position: 4, rect: { x: 0, y: 600, w: 200, h: 100 } },
  { id: "e", groupId: "vfx", position: 5, rect: { x: 1000, y: 0, w: 200, h: 100 } },
];

describe("canvas folders", () => {
  it("walks the tree and refuses to nest a folder inside itself", () => {
    expect(folderPath(byId, "relics")).toEqual(["ui", "items", "relics"]);
    expect(folderPath(byId, null)).toEqual([]);
    expect(folderDepth(byId, null)).toBe(0);
    expect(folderDepth(byId, "relics")).toBe(3);
    expect(folderContains(byId, "ui", "relics")).toBe(true);
    expect(folderContains(byId, "ui", "ui")).toBe(true);
    expect(folderContains(byId, "items", "ui")).toBe(false);
    expect(folderContains(byId, "ui", null)).toBe(false);
    expect(folderDescendants(folders, items, "ui")).toEqual({ folderIds: ["items", "relics"], itemIds: ["a", "b", "c"] });
    // A looping chain (bad data) ends instead of hanging.
    const loop = foldersById([
      { id: "x", parentId: "y" },
      { id: "y", parentId: "x" },
    ]);
    expect(folderPath(loop, "x")).toEqual(["y", "x"]);
  });

  it("hides what's inside a collapsed folder and points arrows at the outermost collapsed one", () => {
    expect(visibleFolderOf(byId, "relics")).toBe("relics");
    expect(visibleFolderOf(byId, "items")).toBeNull();
    const collapsedUi = foldersById(folders.map((f) => (f.id === "ui" ? { ...f, collapsed: true } : f)));
    expect(visibleFolderOf(collapsedUi, "relics")).toBe("ui");
    expect(visibleFolderOf(collapsedUi, "items")).toBe("ui");
    expect(visibleFolderOf(byId, null)).toBeNull();
  });

  it("draws each frame around its contents, bottom-up, and collapsed folders as one compact node", () => {
    const frames = folderFrames(folders, items);
    expect(frames.get("relics")).toEqual({ x: 700, y: 300, ...FOLDER_COLLAPSED });
    // items: b plus the collapsed relics node.
    expect(frames.get("items")).toEqual({
      x: 400 - FOLDER_PAD,
      y: 120 - FOLDER_PAD - FOLDER_HEADER,
      w: 700 + FOLDER_COLLAPSED.w - 400 + 2 * FOLDER_PAD,
      h: 300 + FOLDER_COLLAPSED.h - 120 + 2 * FOLDER_PAD + FOLDER_HEADER,
    });
    // ui: a plus the items frame.
    const inner = frames.get("items")!;
    expect(frames.get("ui")).toEqual({
      x: 100 - FOLDER_PAD,
      y: inner.y - FOLDER_PAD - FOLDER_HEADER,
      w: inner.x + inner.w - 100 + 2 * FOLDER_PAD,
      h: inner.y + inner.h - inner.y + 2 * FOLDER_PAD + FOLDER_HEADER,
    });
    // The title always fits.
    expect(folderFrames([{ id: "one", parentId: null, collapsed: false }], [{ id: "z", groupId: "one", rect: { x: 0, y: 0, w: 100, h: 50 } }]).get("one")?.w).toBe(236);
  });

  it("drops onto the deliverable under the pointer, else the innermost folder, never the dragged nodes", () => {
    const frames = folderFrames(folders, items);
    const candidates = [
      ...items.map((i) => ({ id: i.id, kind: "deliverable" as const, rect: i.rect, depth: folderDepth(byId, i.groupId) + 1 })),
      ...folders.map((f) => ({ id: f.id, kind: "folder" as const, rect: frames.get(f.id)!, depth: folderDepth(byId, f.parentId) + 1 })),
    ];
    expect(dropTargetAt({ x: 450, y: 150 }, candidates, new Set())).toEqual({ id: "b", kind: "deliverable" });
    expect(dropTargetAt({ x: 450, y: 150 }, candidates, new Set(["b"]))).toEqual({ id: "items", kind: "folder" });
    expect(dropTargetAt({ x: 450, y: 150 }, candidates, new Set(["b", "items"]))).toEqual({ id: "ui", kind: "folder" });
    expect(dropTargetAt({ x: 90, y: 95 }, candidates, new Set())).toEqual({ id: "ui", kind: "folder" });
    expect(dropTargetAt({ x: -500, y: -500 }, candidates, new Set())).toBeNull();
  });

  it("names a new folder after a shared type", () => {
    expect(defaultFolderName([{ assetType: "UI" }, { assetType: "UI " }])).toBe("UI");
    expect(defaultFolderName([{ assetType: "UI" }, { assetType: "VFX" }])).toBe(DEFAULT_FOLDER_NAME);
    expect(defaultFolderName([{ assetType: "" }, { assetType: "" }])).toBe(DEFAULT_FOLDER_NAME);
    expect(defaultFolderName([])).toBe(DEFAULT_FOLDER_NAME);
  });

  it("lists folders where their first deliverable would be", () => {
    const tree = folderTree(folders, items);
    expect(tree.map((n) => (n.kind === "folder" ? `folder:${n.folder.id}` : n.item.id))).toEqual(["folder:ui", "d", "folder:vfx"]);
    const ui = tree[0]!;
    if (ui.kind !== "folder") throw new Error("expected a folder");
    expect(ui.children.map((n) => (n.kind === "folder" ? `folder:${n.folder.id}` : n.item.id))).toEqual(["folder:items", "a"]);
    // A deliverable pointing at an unknown folder shows at the top level rather than vanishing.
    expect(folderTree(folders, [{ id: "q", groupId: "gone", position: 1 }]).map((n) => n.kind)).toEqual(["item", "folder", "folder"]);
  });
});
