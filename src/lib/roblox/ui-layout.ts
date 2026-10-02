/**
 * Roblox 2D UI layout, reproduced from the engine's rules: UDim2 sizes and positions,
 * AnchorPoint, SizeConstraint, UIPadding, UIListLayout / UIGridLayout / UIPageLayout,
 * UIAspectRatioConstraint, UISizeConstraint, AutomaticSize, ScrollingFrame canvases,
 * TextScaled (with UITextSizeConstraint) and Roblox's top-bar inset.
 *
 * Pure: text measurement is injected, so the same code runs in the browser (real fonts)
 * and in tests. Boxes are relative to their parent's top-left, before rotation/UIScale
 * (the renderer applies those as transforms, like Roblox does visually).
 */
import type { ManifestNode, RobloxManifest } from "./manifest";

/** Height of Roblox's top bar, which ScreenGuis sit below unless they ignore the inset. */
export const TOPBAR_INSET = 58;
/** TextScaled never grows text beyond this. */
export const MAX_SCALED_TEXT = 100;

export interface TextStyle {
  font: string;
  weight: number;
  italic: boolean;
  /** Line height multiplier (TextLabel.LineHeight). */
  lineHeight: number;
}

/** Measures text at a size, wrapping at maxWidth when given. Returns the text block's size. */
export type MeasureText = (text: string, style: TextStyle, size: number, maxWidth: number | null) => { width: number; height: number };

export interface UiBox {
  node: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Resolved text size (TextScaled fitted, constraints applied). */
  textSize?: number;
  /** Scrollable canvas inside a ScrollingFrame. */
  canvas?: { w: number; h: number };
  children: UiBox[];
}

export interface UiRoot {
  /** LayerCollector node, or -1 for loose GuiObjects (wrapped in a virtual ScreenGui). */
  node: number;
  kind: "screen" | "surface" | "billboard";
  name: string;
  enabled: boolean;
  /** Pixel size of the surface the UI is drawn on. */
  width: number;
  height: number;
  /** Area UI is laid out in (e.g. below the top bar). */
  inset: number;
  order: number;
  children: UiBox[];
}

type R = Record<string, unknown>;
const nums = (v: unknown, fallback: number[]): number[] => (Array.isArray(v) && v.every((n) => typeof n === "number") ? (v as number[]) : fallback);
const numOf = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const boolOf = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);

/** Children of each node, in file order. */
function childIndex(nodes: ManifestNode[]): number[][] {
  const out: number[][] = nodes.map(() => []);
  nodes.forEach((n, i) => {
    if (n.p >= 0 && out[n.p]) out[n.p]!.push(i);
  });
  return out;
}

export const isGuiObject = (n: ManifestNode | undefined) => n?.r.g === 1;

/** All UI roots in a manifest: ScreenGuis, SurfaceGuis, BillboardGuis, and loose GuiObjects. */
export function uiRoots(manifest: RobloxManifest): Array<{ node: number; kind: UiRoot["kind"]; name: string }> {
  const { nodes } = manifest;
  const roots: Array<{ node: number; kind: UiRoot["kind"]; name: string }> = [];
  let loose = false;
  nodes.forEach((n, i) => {
    if (typeof n.r.lc === "string") {
      roots.push({ node: i, kind: n.r.lc as UiRoot["kind"], name: n.n });
      return;
    }
    if (!isGuiObject(n)) return;
    // A GuiObject with no GuiObject/LayerCollector above it (e.g. a Frame exported on its own).
    let p = n.p;
    while (p >= 0 && !isGuiObject(nodes[p]) && typeof nodes[p]!.r.lc !== "string") p = nodes[p]!.p;
    if (p < 0) loose = true;
  });
  if (loose) roots.push({ node: -1, kind: "screen", name: "UI (no ScreenGui)" });
  return roots;
}

export interface LayoutOptions {
  /** Screen size for ScreenGuis. */
  screen: { width: number; height: number };
  measure: MeasureText;
}

export function layoutUiRoot(manifest: RobloxManifest, root: { node: number; kind: UiRoot["kind"]; name: string }, options: LayoutOptions): UiRoot {
  const { nodes } = manifest;
  const kids = childIndex(nodes);
  const r = root.node >= 0 ? nodes[root.node]!.r : ({} as R);

  let width = options.screen.width;
  let height = options.screen.height;
  let inset = 0;
  if (root.kind === "screen") {
    const ignoreInset = boolOf(r.inset, false);
    const screenInsets = numOf(r.si, 2);
    // CoreUISafeInsets (default) and TopbarSafeInsets keep UI below the top bar.
    inset = ignoreInset || screenInsets === 0 || screenInsets === 1 ? 0 : TOPBAR_INSET;
  } else if (root.kind === "surface") {
    const canvas = nums(r.canvas, [800, 600]);
    width = canvas[0]!;
    height = canvas[1]!;
    if (numOf(r.sizing, 0) === 1) {
      // PixelsPerStud: the canvas follows the part's face.
      const part = typeof r.adornee === "number" ? nodes[r.adornee] : nodes[nodes[root.node]!.p];
      const size = nums(part?.r.size, []);
      if (size.length === 3) {
        const face = numOf(r.face, 5);
        const ppu = numOf(r.ppu, 50);
        const [sx, sy, sz] = size as [number, number, number];
        // Front/Back (5/2) show X×Y, Left/Right (3/0) Z×Y, Top/Bottom (1/4) X×Z.
        const [fw, fh] = face === 0 || face === 3 ? [sz, sy] : face === 1 || face === 4 ? [sx, sz] : [sx, sy];
        width = Math.round(fw * ppu);
        height = Math.round(fh * ppu);
      }
    }
  } else {
    // BillboardGui: offsets are pixels; scale is in studs (drawn at ~50 px per stud).
    const size = nums(r.size, [0, 200, 0, 50]);
    width = Math.max(1, size[0]! * 50 + size[1]!);
    height = Math.max(1, size[2]! * 50 + size[3]!);
  }

  const engine = new LayoutEngine(nodes, kids, options.measure);
  const topLevel =
    root.node >= 0
      ? kids[root.node]!.filter((c) => isGuiObject(nodes[c]))
      : nodes.map((n, i) => i).filter((i) => isGuiObject(nodes[i]) && !hasUiAncestor(nodes, i));
  const children = engine.layoutChildren(root.node >= 0 ? root.node : null, topLevel, width, height - inset);
  for (const c of children) c.y += inset;
  return {
    node: root.node,
    kind: root.kind,
    name: root.name,
    enabled: boolOf(r.en, true),
    width,
    height,
    inset,
    order: numOf(r.order, 0),
    children,
  };
}

function hasUiAncestor(nodes: ManifestNode[], i: number) {
  let p = nodes[i]!.p;
  while (p >= 0) {
    if (isGuiObject(nodes[p]) || typeof nodes[p]!.r.lc === "string") return true;
    p = nodes[p]!.p;
  }
  return false;
}

const udim2 = (v: number[], w: number, h: number): [number, number] => [v[0]! * w + v[1]!, v[2]! * h + v[3]!];

class LayoutEngine {
  constructor(
    private nodes: ManifestNode[],
    private kids: number[][],
    private measure: MeasureText,
  ) {}

  private modifier(parent: number | null, test: (r: R) => boolean): R | null {
    if (parent === null) return null;
    for (const c of this.kids[parent]!) {
      const n = this.nodes[c]!;
      if (!isGuiObject(n) && test(n.r)) return n.r;
    }
    return null;
  }

  /** Padding of a node's content box: [top, right, bottom, left] in pixels. */
  padding(node: number | null, w: number, h: number): [number, number, number, number] {
    const pad = this.modifier(node, (r) => Array.isArray(r.pad));
    if (!pad) return [0, 0, 0, 0];
    const p = nums(pad.pad, [0, 0, 0, 0, 0, 0, 0, 0]);
    return [p[0]! * h + p[1]!, p[2]! * w + p[3]!, p[4]! * h + p[5]!, p[6]! * w + p[7]!];
  }

  /** Size from UDim2 + SizeConstraint, then UIAspectRatioConstraint and UISizeConstraint. */
  sizeOf(i: number, cw: number, ch: number): [number, number] {
    const r = this.nodes[i]!.r;
    const size = nums(r.size, [0, 100, 0, 100]);
    const sc = numOf(r.sc, 0);
    // RelativeXX / RelativeYY measure both axes against one parent axis.
    const refW = sc === 2 ? ch : cw;
    const refH = sc === 1 ? cw : ch;
    let [w, h] = udim2(size, refW, refH);
    [w, h] = this.constrain(i, w, h);
    return [Math.max(0, w), Math.max(0, h)];
  }

  private constrain(i: number, w: number, h: number): [number, number] {
    const aspect = this.modifier(i, (r) => typeof r.ar === "number");
    if (aspect) [w, h] = applyAspect(aspect, w, h);
    const limits = this.modifier(i, (r) => Array.isArray(r.min) && Array.isArray(r.max));
    if (limits) {
      const min = nums(limits.min, [0, 0]);
      const max = nums(limits.max, [1e9, 1e9]);
      w = Math.min(Math.max(w, min[0]!), max[0]!);
      h = Math.min(Math.max(h, min[1]!), max[1]!);
    }
    return [w, h];
  }

  /** Lays out a node at a given size; returns its box with children relative to it. */
  layoutNode(i: number, w: number, h: number): UiBox {
    const r = this.nodes[i]!.r;
    const box: UiBox = { node: i, x: 0, y: 0, w, h, children: [] };
    const auto = numOf(r.auto, 0);
    const childNodes = this.kids[i]!.filter((c) => isGuiObject(this.nodes[c]));

    const place = (bw: number, bh: number) => {
      box.w = bw;
      box.h = bh;
      if (r.canvas !== undefined && Array.isArray(r.canvas)) {
        // ScrollingFrame: children live on the canvas.
        let [cw, ch] = udim2(nums(r.canvas, [0, 0, 2, 0]), bw, bh);
        cw = Math.max(cw, 0);
        ch = Math.max(ch, 0);
        box.children = this.layoutChildren(i, childNodes, cw, ch);
        const autoCanvas = numOf(r.autoCanvas, 0);
        if (autoCanvas) {
          const [ew, eh] = this.extent(i, box.children, cw, ch);
          if (autoCanvas === 1 || autoCanvas === 3) cw = Math.max(cw, ew);
          if (autoCanvas === 2 || autoCanvas === 3) ch = Math.max(ch, eh);
        }
        box.canvas = { w: Math.max(cw, bw), h: Math.max(ch, bh) };
      } else {
        box.children = this.layoutChildren(i, childNodes, bw, bh);
      }
    };
    place(w, h);

    if (typeof r.text === "string") box.textSize = this.textSize(i, box.w, box.h);

    if (auto) {
      // AutomaticSize grows (never shrinks) to fit the content, then lays out again.
      let [ew, eh] = this.extent(i, box.children, box.w, box.h);
      if (typeof r.text === "string" && r.text) {
        const [pt, pr, pb, pl] = this.padding(i, box.w, box.h);
        const style = this.textStyle(r);
        const size = box.textSize ?? numOf(r.ts, 14);
        const wrapWidth = auto === 1 || auto === 3 ? null : Math.max(1, box.w - pl - pr);
        const m = this.measure(plainText(r), style, size, boolOf(r.wrap, false) ? wrapWidth : null);
        ew = Math.max(ew, m.width + pl + pr);
        eh = Math.max(eh, m.height + pt + pb);
      }
      const nw = auto === 1 || auto === 3 ? Math.max(box.w, ew) : box.w;
      const nh = auto === 2 || auto === 3 ? Math.max(box.h, eh) : box.h;
      if (nw !== box.w || nh !== box.h) {
        const [cw, ch] = this.constrain(i, nw, nh);
        place(cw, ch);
        if (typeof r.text === "string") box.textSize = this.textSize(i, box.w, box.h);
      }
    }
    return box;
  }

  /** Size needed to contain the laid-out children (plus padding). */
  private extent(i: number, children: UiBox[], w: number, h: number): [number, number] {
    const [pt, pr, pb, pl] = this.padding(i, w, h);
    if (!children.length) return [pl + pr, pt + pb];
    let ew = 0;
    let eh = 0;
    // Child positions already include the left/top padding.
    for (const c of children) {
      ew = Math.max(ew, c.x + c.w);
      eh = Math.max(eh, c.y + c.h);
    }
    return [ew + pr, eh + pb];
  }

  /** Lays out a parent's GuiObject children inside a w×h area (applying its UIPadding and layout). */
  layoutChildren(parent: number | null, childNodes: number[], w: number, h: number): UiBox[] {
    const [pt, pr, pb, pl] = this.padding(parent, w, h);
    const cx = pl;
    const cy = pt;
    const cw = Math.max(0, w - pl - pr);
    const ch = Math.max(0, h - pt - pb);
    const layout = this.modifier(parent, (r) => typeof r.layout === "string");
    const visible = childNodes.filter((c) => boolOf(this.nodes[c]!.r.vis, true));

    if (!layout) {
      return childNodes.map((c) => {
        const r = this.nodes[c]!.r;
        const [sw, sh] = this.sizeOf(c, cw, ch);
        const box = this.layoutNode(c, sw, sh);
        const [px, py] = udim2(nums(r.pos, [0, 0, 0, 0]), cw, ch);
        const anchor = nums(r.anchor, [0, 0]);
        box.x = cx + px - anchor[0]! * box.w;
        box.y = cy + py - anchor[1]! * box.h;
        return box;
      });
    }

    const sorted = this.sortForLayout(visible, numOf(layout.so, 2));
    const ha = numOf(layout.ha, 1); // Center 0, Left 1, Right 2
    const va = numOf(layout.va, 1); // Center 0, Top 1, Bottom 2
    const alignX = (free: number) => (ha === 0 ? free / 2 : ha === 2 ? free : 0);
    const alignY = (free: number) => (va === 0 ? free / 2 : va === 2 ? free : 0);
    const out: UiBox[] = [];

    if (layout.layout === "grid") {
      let [cellW, cellH] = udim2(nums(layout.cell, [0, 100, 0, 100]), cw, ch);
      // A UIAspectRatioConstraint inside the grid layout shapes every cell.
      const gridIndex = this.kids[parent!]!.find((k) => this.nodes[k]!.r === layout);
      const cellAspect = gridIndex !== undefined ? this.modifier(gridIndex, (r) => typeof r.ar === "number") : null;
      if (cellAspect) [cellW, cellH] = applyAspect(cellAspect, cellW, cellH);
      const [gapX, gapY] = udim2(nums(layout.cgap, [0, 5, 0, 5]), cw, ch);
      const horizontal = numOf(layout.fd, 0) === 0;
      const max = numOf(layout.maxCells, 0);
      const fit = horizontal ? Math.floor((cw + gapX) / (cellW + gapX || 1)) : Math.floor((ch + gapY) / (cellH + gapY || 1));
      const perLine = Math.max(1, max > 0 ? Math.min(max, Math.max(1, fit)) : fit);
      const n = sorted.length;
      const lines = Math.ceil(n / perLine);
      const cols = horizontal ? Math.min(n, perLine) : lines;
      const rows = horizontal ? lines : Math.min(n, perLine);
      const blockW = cols * cellW + Math.max(0, cols - 1) * gapX;
      const blockH = rows * cellH + Math.max(0, rows - 1) * gapY;
      const ox = cx + alignX(cw - blockW);
      const oy = cy + alignY(ch - blockH);
      const start = numOf(layout.start, 0); // TopLeft, TopRight, BottomLeft, BottomRight
      sorted.forEach((c, k) => {
        let col = horizontal ? k % perLine : Math.floor(k / perLine);
        let row = horizontal ? Math.floor(k / perLine) : k % perLine;
        if (start === 1 || start === 3) col = cols - 1 - col;
        if (start === 2 || start === 3) row = rows - 1 - row;
        const box = this.layoutNode(c, cellW, cellH);
        box.x = ox + col * (cellW + gapX);
        box.y = oy + row * (cellH + gapY);
        out.push(box);
      });
      return out;
    }

    if (layout.layout === "page") {
      // Shows the first page filling the container.
      const first = sorted[0];
      if (first !== undefined) {
        const [sw, sh] = this.sizeOf(first, cw, ch);
        const box = this.layoutNode(first, sw, sh);
        box.x = cx + alignX(cw - box.w);
        box.y = cy + alignY(ch - box.h);
        out.push(box);
      }
      return out;
    }

    // List (and table, approximated as a vertical list).
    const vertical = layout.layout === "table" || numOf(layout.fd, 1) === 1;
    const gapU = nums(layout.gap, [0, 0]);
    const gap = gapU[0]! * (vertical ? ch : cw) + gapU[1]!;
    const boxes = sorted.map((c) => {
      const [sw, sh] = this.sizeOf(c, cw, ch);
      return this.layoutNode(c, sw, sh);
    });
    const wraps = boolOf(layout.wrap, false);
    // Split into lines (only when Wraps is on), then stack.
    const lines: UiBox[][] = [];
    let line: UiBox[] = [];
    let used = 0;
    for (const b of boxes) {
      const len = vertical ? b.h : b.w;
      if (wraps && line.length && used + gap + len > (vertical ? ch : cw)) {
        lines.push(line);
        line = [];
        used = 0;
      }
      used += (line.length ? gap : 0) + len;
      line.push(b);
    }
    if (line.length) lines.push(line);
    const lineMain = (l: UiBox[]) => l.reduce((s, b) => s + (vertical ? b.h : b.w), 0) + Math.max(0, l.length - 1) * gap;
    const lineCross = (l: UiBox[]) => l.reduce((m, b) => Math.max(m, vertical ? b.w : b.h), 0);
    const crossTotal = lines.reduce((s, l) => s + lineCross(l), 0) + Math.max(0, lines.length - 1) * gap;
    let crossCursor = vertical ? alignX(cw - crossTotal) : alignY(ch - crossTotal);
    for (const l of lines) {
      const main = lineMain(l);
      const lc = lines.length > 1 ? lineCross(l) : vertical ? cw : ch;
      let cursor = vertical ? alignY(ch - main) : alignX(cw - main);
      for (const b of l) {
        if (vertical) {
          b.x = cx + (lines.length > 1 ? crossCursor : 0) + alignX(lc - b.w);
          b.y = cy + cursor;
          cursor += b.h + gap;
        } else {
          b.x = cx + cursor;
          b.y = cy + (lines.length > 1 ? crossCursor : 0) + alignY(lc - b.h);
          cursor += b.w + gap;
        }
        out.push(b);
      }
      crossCursor += lineCross(l) + gap;
    }
    return out;
  }

  private sortForLayout(children: number[], sortOrder: number): number[] {
    const order = children.map((c, k) => ({ c, k, n: this.nodes[c]! }));
    if (sortOrder === 0) order.sort((a, b) => a.n.n.localeCompare(b.n.n) || a.k - b.k);
    else if (sortOrder === 2) order.sort((a, b) => numOf(a.n.r.order, 0) - numOf(b.n.r.order, 0) || a.k - b.k);
    return order.map((o) => o.c);
  }

  textStyle(r: R): TextStyle {
    return { font: typeof r.font === "string" ? r.font : "SourceSansPro", weight: numOf(r.fw, 400), italic: boolOf(r.fi, false), lineHeight: numOf(r.lh, 1) };
  }

  /** TextSize, or for TextScaled the largest size (≤ 100, within UITextSizeConstraint) whose wrapped text fits. */
  textSize(i: number, w: number, h: number): number {
    const r = this.nodes[i]!.r;
    const limits = this.modifier(i, (m) => typeof m.tmax === "number");
    const min = Math.max(1, numOf(limits?.tmin, 1));
    const max = Math.min(MAX_SCALED_TEXT, numOf(limits?.tmax, MAX_SCALED_TEXT));
    if (!boolOf(r.tScaled, false)) {
      const size = numOf(r.ts, 14);
      return limits ? Math.min(Math.max(size, min), Math.max(min, numOf(limits.tmax, size))) : size;
    }
    const text = plainText(r);
    const [pt, pr, pb, pl] = this.padding(i, w, h);
    const aw = Math.max(0, w - pl - pr);
    const ah = Math.max(0, h - pt - pb);
    if (!text.trim()) return Math.max(min, Math.min(max, Math.floor(ah)));
    const style = this.textStyle(r);
    const fits = (size: number) => {
      // TextScaled wraps words onto more lines when that allows a larger size.
      const m = this.measure(text, style, size, aw);
      return m.width <= aw + 0.5 && m.height <= ah + 0.5;
    };
    let lo = min;
    let hi = max;
    if (!fits(lo)) return lo;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(mid)) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
}

function applyAspect(aspect: R, w: number, h: number): [number, number] {
  const ratio = numOf(aspect.ar, 1) || 1;
  const type = numOf(aspect.at, 0);
  if (type === 0) {
    // FitWithinMaxSize: the largest box of this ratio that fits.
    return w / Math.max(h, 1e-6) > ratio ? [h * ratio, h] : [w, w / ratio];
  }
  // ScaleWithParentSize: the dominant axis keeps its size.
  return numOf(aspect.da, 0) === 0 ? [w, w / ratio] : [h * ratio, h];
}

/** Text without rich-text markup (for measuring). */
export function plainText(r: R): string {
  const text = typeof r.text === "string" ? r.text : "";
  if (!boolOf(r.rich, false)) return text;
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
