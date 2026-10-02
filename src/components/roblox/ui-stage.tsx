"use client";

import "./roblox-fonts.css";
import { Eye, EyeOff, Film, ImageOff, Box as BoxIcon, PanelTop } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { fontShorthand, resolveFont } from "@/lib/roblox/fonts";
import type { ManifestNode, MValue, RobloxManifest } from "@/lib/roblox/manifest";
import { parseRichText, type RichNode, type RichStyle } from "@/lib/roblox/rich-text";
import { layoutUiRoot, plainText, TOPBAR_INSET, uiRoots, type MeasureText, type UiBox, type UiRoot } from "@/lib/roblox/ui-layout";
import { cn } from "@/lib/utils";
import { Select } from "../ui/controls";
import type { ResolvedResource } from "./resources";

export const SCREEN_PRESETS = [
  { id: "desktop", label: "Desktop 1920×1080", width: 1920, height: 1080 },
  { id: "laptop", label: "Laptop 1366×768", width: 1366, height: 768 },
  { id: "tablet", label: "Tablet 1024×768", width: 1024, height: 768 },
  { id: "phone", label: "Phone 844×390", width: 844, height: 390 },
  { id: "phone-portrait", label: "Phone portrait 390×844", width: 390, height: 844 },
] as const;
type PresetId = (typeof SCREEN_PRESETS)[number]["id"];
type Backdrop = "scene" | "dark" | "light" | "checker";
const PRESET_KEY = "forge:ui-screen";

// ── Small helpers ───────────────────────────────────────────────────────────

type R = Record<string, MValue>;
const n = (v: MValue | undefined, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const b = (v: MValue | undefined, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
const arr = (v: MValue | undefined, fallback: number[]) => (Array.isArray(v) && v.every((x) => typeof x === "number") ? (v as number[]) : fallback);
const rgba = (c: number[], alpha: number) => `rgba(${Math.round(c[0]! * 255)}, ${Math.round(c[1]! * 255)}, ${Math.round(c[2]! * 255)}, ${Math.max(0, Math.min(1, alpha))})`;

function wrapLines(text: string, maxWidth: number | null, width: (s: string) => number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (maxWidth === null) {
      out.push(para);
      continue;
    }
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      if (!word) continue;
      const next = line + word;
      if (line.trim() && width(next.trimEnd()) > maxWidth && word.trim()) {
        out.push(line.trimEnd());
        line = word.trimStart();
      } else line = next;
    }
    out.push(line.trimEnd());
  }
  return out;
}

/** Text measurement with the same fonts the preview draws with. */
function createMeasurer(): MeasureText {
  const ctx = document.createElement("canvas").getContext("2d")!;
  const width = (s: string) => ctx.measureText(s).width;
  return (text, style, size, maxWidth) => {
    ctx.font = fontShorthand(resolveFont(style.font, style.weight, style.italic), size);
    const lines = wrapLines(text, maxWidth, width);
    return { width: Math.max(0, ...lines.map(width)), height: lines.length * size * style.lineHeight };
  };
}

const imageCache = new Map<string, Promise<HTMLImageElement>>();
function loadImage(url: string): Promise<HTMLImageElement> {
  let p = imageCache.get(url);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("image failed"));
      img.src = url;
    });
    imageCache.set(url, p);
  }
  return p;
}

// ── Modifiers (UICorner, UIStroke, UIGradient, UIPadding, UIScale) ───────────

interface Mods {
  corner: R | null;
  stroke: R | null;
  gradient: R | null;
  padding: R | null;
  scale: R | null;
}

function gradientCss(g: R, base: number[], alpha: number): string {
  const colors = (Array.isArray(g.cs) ? (g.cs as number[][]) : [[0, 1, 1, 1], [1, 1, 1, 1]]).map((k) => k.map(Number));
  const trans = (Array.isArray(g.ts) ? (g.ts as number[][]) : [[0, 0, 0], [1, 0, 0]]).map((k) => k.map(Number));
  const times = [...new Set([...colors.map((k) => k[0]!), ...trans.map((k) => k[0]!)])].sort((x, y) => x - y);
  const sample = (keys: number[][], t: number, dims: number) => {
    for (let i = 0; i < keys.length - 1; i++) {
      const a = keys[i]!;
      const c = keys[i + 1]!;
      if (t >= a[0]! && t <= c[0]!) {
        const f = c[0]! === a[0]! ? 0 : (t - a[0]!) / (c[0]! - a[0]!);
        return Array.from({ length: dims }, (_, d) => a[d + 1]! + (c[d + 1]! - a[d + 1]!) * f);
      }
    }
    return keys[t <= keys[0]![0]! ? 0 : keys.length - 1]!.slice(1, dims + 1);
  };
  const rot = n(g.rot, 0);
  const off = arr(g.off, [0, 0]);
  const rad = (rot * Math.PI) / 180;
  const shift = off[0]! * Math.cos(rad) + off[1]! * Math.sin(rad);
  const stops = times.map((t) => {
    const [cr, cg, cb] = sample(colors, t, 3);
    const [tr] = sample(trans, t, 1);
    return `${rgba([cr! * base[0]!, cg! * base[1]!, cb! * base[2]!], alpha * (1 - tr!))} ${((t + shift) * 100).toFixed(2)}%`;
  });
  return `linear-gradient(${90 + rot}deg, ${stops.join(", ")})`;
}

function ringShadow(thickness: number, color: string): string {
  if (thickness <= 0) return "";
  const steps = thickness <= 1.5 ? 8 : 16;
  return Array.from({ length: steps }, (_, i) => {
    const a = (i / steps) * Math.PI * 2;
    return `${(Math.cos(a) * thickness).toFixed(2)}px ${(Math.sin(a) * thickness).toFixed(2)}px 0 ${color}`;
  }).join(", ");
}

// ── Rendering ───────────────────────────────────────────────────────────────

interface RenderCtx {
  nodes: ManifestNode[];
  mods: (node: number) => Mods;
  images: Map<string, string>;
  selected: number | null;
  onSelect: (node: number) => void;
  showHidden: boolean;
  fontsVersion: number;
}

function RichText({ nodes, base }: { nodes: RichNode[]; base: CSSProperties }): ReactNode {
  return nodes.map((node, i) => {
    if (node.type === "text") return node.text;
    if (node.type === "br") return <br key={i} />;
    return (
      <span key={i} style={richStyle(node.style, base)}>
        <RichText nodes={node.children} base={base} />
      </span>
    );
  });
}

function richStyle(s: RichStyle, base: CSSProperties): CSSProperties {
  const style: CSSProperties = {};
  if (s.bold) style.fontWeight = 700;
  if (s.italic) style.fontStyle = "italic";
  const deco = [s.underline && "underline", s.strike && "line-through"].filter(Boolean).join(" ");
  if (deco) style.textDecoration = deco;
  if (s.color) style.color = rgba(s.color, 1 - (s.transparency ?? 0));
  else if (s.transparency !== undefined) style.opacity = 1 - s.transparency;
  if (s.size) style.fontSize = s.size;
  if (s.face) {
    const f = resolveFont(s.face, s.weight ?? Number(base.fontWeight ?? 400), Boolean(s.italic));
    style.fontFamily = f.css;
  }
  if (s.weight) style.fontWeight = s.weight;
  if (s.stroke) style.textShadow = ringShadow(s.stroke.thickness, rgba(s.stroke.color, 1 - s.stroke.transparency));
  if (s.mark) style.backgroundColor = rgba(s.mark.color, 1 - s.mark.transparency);
  if (s.uppercase) style.textTransform = "uppercase";
  if (s.smallcaps) style.fontVariant = "small-caps";
  return style;
}

function UiText({ r, box, mods }: { r: R; box: UiBox; mods: Mods }) {
  const font = resolveFont(typeof r.font === "string" ? r.font : "SourceSansPro", n(r.fw, 400), b(r.fi, false));
  const size = box.textSize ?? n(r.ts, 14);
  const [pt, pr, pb, pl] = padPx(mods.padding, box.w, box.h);
  const xa = n(r.xa, 2);
  const ya = n(r.ya, 1);
  const wrap = b(r.wrap, false) || b(r.tScaled, false);
  let text = typeof r.text === "string" ? r.text : "";
  let color = arr(r.tc, [0, 0, 0]);
  let transparency = n(r.tT, 0);
  if (!text && typeof r.ph === "string" && r.ph) {
    text = r.ph;
    color = arr(r.phC, [0.7, 0.7, 0.7]);
  }
  const maxG = n(r.maxG, -1);
  if (maxG >= 0 && !b(r.rich, false)) text = [...new Intl.Segmenter().segment(text)].slice(0, maxG).map((s) => s.segment).join("");
  if (!text) return null;

  const style: CSSProperties = {
    fontFamily: font.css,
    fontWeight: font.weight,
    fontStyle: font.italic ? "italic" : "normal",
    fontSize: size,
    lineHeight: `${size * n(r.lh, 1)}px`,
    whiteSpace: wrap ? "pre-wrap" : "pre",
    overflowWrap: "normal",
    textAlign: xa === 0 ? "left" : xa === 1 ? "right" : "center",
    width: wrap ? "100%" : undefined,
    color: rgba(color, 1 - transparency),
  };
  const shadows: string[] = [];
  const legacyStroke = n(r.sT, 1);
  if (legacyStroke < 1) shadows.push(ringShadow(1, rgba(arr(r.sC, [0, 0, 0]), (1 - legacyStroke) * (1 - transparency))));
  const stroke = mods.stroke;
  if (stroke && b(stroke.en, true) && n(stroke.mode, 0) === 0) shadows.push(ringShadow(n(stroke.th, 1), rgba(arr(stroke.c, [0, 0, 0]), 1 - n(stroke.t, 0))));
  if (mods.gradient && b(mods.gradient.en, true)) {
    // UIGradient tints the text too.
    style.backgroundImage = gradientCss(mods.gradient, color, 1 - transparency);
    style.WebkitBackgroundClip = "text";
    style.backgroundClip = "text";
    style.color = "transparent";
  } else if (shadows.length) style.textShadow = shadows.filter(Boolean).join(", ");
  const truncate = n(r.trunc, 0) !== 0 && !wrap;
  if (truncate) Object.assign(style, { overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" });

  return (
    <div
      className="pointer-events-none absolute flex"
      style={{
        inset: `${pt}px ${pr}px ${pb}px ${pl}px`,
        justifyContent: xa === 0 ? "flex-start" : xa === 1 ? "flex-end" : "center",
        alignItems: ya === 0 ? "flex-start" : ya === 2 ? "flex-end" : "center",
      }}
    >
      <span style={style}>{b(r.rich, false) ? <RichText nodes={parseRichText(text)} base={style} /> : text}</span>
    </div>
  );
}

function padPx(pad: R | null, w: number, h: number): [number, number, number, number] {
  if (!pad) return [0, 0, 0, 0];
  const p = arr(pad.pad, [0, 0, 0, 0, 0, 0, 0, 0]);
  return [p[0]! * h + p[1]!, p[2]! * w + p[3]!, p[4]! * h + p[5]!, p[6]! * w + p[7]!];
}

/** Draws an ImageLabel the way Roblox does: Stretch/Fit/Crop/Tile/Slice, sprite rect, tint. */
function drawImage(ctx: CanvasRenderingContext2D, img: HTMLImageElement, r: R, w: number, h: number) {
  const ro = arr(r.ro, [0, 0]);
  const rs = arr(r.rs, [0, 0]);
  const sx = ro[0]!;
  const sy = ro[1]!;
  const sw = rs[0]! > 0 ? rs[0]! : img.naturalWidth;
  const sh = rs[1]! > 0 ? rs[1]! : img.naturalHeight;
  const mode = n(r.st, 0);
  ctx.imageSmoothingEnabled = !b(r.pix, false);
  if (mode === 3 || mode === 4) {
    const scale = mode === 3 ? Math.min(w / sw, h / sh) : Math.max(w / sw, h / sh);
    const dw = sw * scale;
    const dh = sh * scale;
    ctx.drawImage(img, sx, sy, sw, sh, (w - dw) / 2, (h - dh) / 2, dw, dh);
  } else if (mode === 2) {
    const tile = arr(r.tile, [1, 0, 1, 0]);
    const tw = Math.max(1, tile[0]! * w + tile[1]!);
    const th = Math.max(1, tile[2]! * h + tile[3]!);
    for (let y = 0; y < h; y += th) for (let x = 0; x < w; x += tw) ctx.drawImage(img, sx, sy, sw, sh, x, y, tw, th);
  } else if (mode === 1 && Array.isArray(r.slice) && (r.slice as number[]).some((v) => v !== 0)) {
    const [minX, minY, maxX, maxY] = r.slice as number[];
    const scale = n(r.sliceS, 1);
    const src = { l: minX!, t: minY!, r: sw - maxX!, b: sh - maxY! };
    let dst = { l: src.l * scale, t: src.t * scale, r: src.r * scale, b: src.b * scale };
    const fx = dst.l + dst.r > w ? w / (dst.l + dst.r) : 1;
    const fy = dst.t + dst.b > h ? h / (dst.t + dst.b) : 1;
    dst = { l: dst.l * fx, r: dst.r * fx, t: dst.t * fy, b: dst.b * fy };
    const xs = [[0, src.l, 0, dst.l], [src.l, maxX! - src.l, dst.l, w - dst.l - dst.r], [maxX!, src.r, w - dst.r, dst.r]];
    const ys = [[0, src.t, 0, dst.t], [src.t, maxY! - src.t, dst.t, h - dst.t - dst.b], [maxY!, src.b, h - dst.b, dst.b]];
    for (const [ax, aw, bx, bw] of xs) {
      for (const [ay, ah, by, bh] of ys) {
        if (aw! > 0 && ah! > 0 && bw! > 0 && bh! > 0) ctx.drawImage(img, sx + ax!, sy + ay!, aw!, ah!, bx!, by!, bw!, bh!);
      }
    }
  } else {
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
  }
  const tint = arr(r.iC, [1, 1, 1]);
  if (tint.some((c) => c < 0.999)) {
    // Multiply by ImageColor3, then restore the image's own alpha.
    const snapshot = document.createElement("canvas");
    snapshot.width = ctx.canvas.width;
    snapshot.height = ctx.canvas.height;
    snapshot.getContext("2d")!.drawImage(ctx.canvas, 0, 0);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = rgba(tint, 1);
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(snapshot, 0, 0);
    ctx.restore();
  }
}

function UiImage({ r, box, url, builtin }: { r: R; box: UiBox; url: string | undefined; builtin: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const w = box.w;
  const h = box.h;
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    loadImage(url)
      .then((img) => {
        if (cancelled || !canvas.current) return;
        const k = Math.min(2, window.devicePixelRatio || 1, 2048 / Math.max(w, 1), 2048 / Math.max(h, 1));
        const c = canvas.current;
        c.width = Math.max(1, Math.round(w * k));
        c.height = Math.max(1, Math.round(h * k));
        const ctx = c.getContext("2d")!;
        ctx.setTransform(k, 0, 0, k, 0, 0);
        ctx.clearRect(0, 0, w, h);
        drawImage(ctx, img, r, w, h);
        setState("ready");
      })
      .catch(() => !cancelled && setState("error"));
    return () => {
      cancelled = true;
    };
  }, [url, w, h, r]);

  if (!url || state === "error") {
    // Roblox would draw the image here; say why we can't instead of drawing nothing.
    if (w < 24 || h < 24) return <div className="pointer-events-none absolute inset-0 border border-dashed border-white/25" />;
    return (
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-0.5 border border-dashed border-white/30 bg-white/[0.04] text-white/55">
        <ImageOff style={{ width: Math.min(28, w / 3), height: Math.min(28, h / 3) }} />
        {w > 90 && h > 60 ? <span style={{ fontSize: 11 }}>{builtin ? "Built-in Roblox image" : state === "error" ? "Image failed to load" : "Image not provided"}</span> : null}
      </div>
    );
  }
  return <canvas ref={canvas} className="pointer-events-none absolute inset-0 h-full w-full" style={{ opacity: 1 - n(r.iT, 0) }} />;
}

const UiNode = memo(function UiNode({ box, ctx }: { box: UiBox; ctx: RenderCtx }) {
  const node = ctx.nodes[box.node]!;
  const r = node.r;
  const visible = b(r.vis, true);
  if (!visible && !ctx.showHidden) return null;
  const mods = ctx.mods(box.node);
  const { w, h } = box;
  const c = node.c;
  const minSide = Math.min(w, h);
  const radius = mods.corner ? Math.min(minSide / 2, Math.max(0, arr(mods.corner.rad, [0, 8])[0]! * minSide + arr(mods.corner.rad, [0, 8])[1]!)) : 0;

  const bgT = n(r.bgT, 0);
  const bg = arr(r.bg, [0.64, 0.64, 0.64]);
  const gradientOn = mods.gradient && b(mods.gradient.en, true);
  const background = bgT >= 1 ? undefined : gradientOn ? gradientCss(mods.gradient!, bg, 1 - bgT) : rgba(bg, 1 - bgT);
  const shadows: string[] = [];
  const border = n(r.bd, 0);
  if (border > 0 && !mods.corner && bgT < 1) {
    const mode = n(r.bdM, 0);
    const col = rgba(arr(r.bdC, [0.1, 0.16, 0.2]), 1 - bgT);
    shadows.push(mode === 2 ? `inset 0 0 0 ${border}px ${col}` : mode === 1 ? `0 0 0 ${border / 2}px ${col}, inset 0 0 0 ${border / 2}px ${col}` : `0 0 0 ${border}px ${col}`);
  }
  const isText = typeof r.text === "string";
  const stroke = mods.stroke;
  if (stroke && b(stroke.en, true) && (!isText || n(stroke.mode, 0) === 1)) shadows.push(`0 0 0 ${n(stroke.th, 1)}px ${rgba(arr(stroke.c, [0, 0, 0]), 1 - n(stroke.t, 0))}`);

  const s = mods.scale ? n(mods.scale.s, 1) : 1;
  const rot = n(r.rot, 0);
  const anchor = arr(r.anchor, [0, 0]);
  const transforms: string[] = [];
  if (s !== 1) transforms.push(`translate(${anchor[0]! * w}px, ${anchor[1]! * h}px) scale(${s}) translate(${-anchor[0]! * w}px, ${-anchor[1]! * h}px)`);
  if (rot) transforms.push(`translate(${w / 2}px, ${h / 2}px) rotate(${rot}deg) translate(${-w / 2}px, ${-h / 2}px)`);

  const clip = b(r.clip, false);
  const isScroll = Boolean(box.canvas);
  const selected = ctx.selected === box.node;
  const img = typeof r.img === "string" ? r.img : null;
  const button = (c === "TextButton" || c === "ImageButton") && b(r.autoBtn, true);
  const groupOpacity = c === "CanvasGroup" ? 1 - n(r.gT, 0) : 1;

  const children = box.children.map((child) => <UiNode key={child.node} box={child} ctx={ctx} />);
  return (
    <div
      data-ui-node={box.node}
      title={`${node.n} (${c})`}
      className={cn("absolute", button && "rbx-btn", !visible && "rbx-hidden")}
      style={{
        left: box.x,
        top: box.y,
        width: w,
        height: h,
        zIndex: n(r.z, 1),
        transform: transforms.length ? transforms.join(" ") : undefined,
        transformOrigin: "0 0",
        opacity: groupOpacity,
        outline: selected ? "2px solid #8b7bff" : undefined,
        outlineOffset: selected ? 1 : undefined,
      }}
      onClick={(e) => {
        e.stopPropagation();
        ctx.onSelect(box.node);
      }}
    >
      <div className="rbx-bg pointer-events-none absolute inset-0" style={{ background, borderRadius: radius, boxShadow: shadows.join(", ") || undefined }} />
      {img !== null ? (
        <div className="pointer-events-none absolute inset-0 overflow-hidden" style={{ borderRadius: radius }}>
          <UiImage r={r} box={box} url={ctx.images.get(img)} builtin={img.startsWith("rbxasset://")} />
        </div>
      ) : null}
      {c === "ViewportFrame" || c === "VideoFrame" ? (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 border border-dashed border-white/30 text-white/60" style={{ borderRadius: radius, fontSize: 11 }}>
          {c === "ViewportFrame" ? <BoxIcon className="size-5" /> : <Film className="size-5" />}
          {w > 110 && h > 50 ? <span>{c === "ViewportFrame" ? "3D view not shown" : "Video not played"}</span> : null}
        </div>
      ) : null}
      {isText ? <UiText r={r} box={box} mods={mods} /> : null}
      {isScroll ? (
        <ScrollArea box={box} r={r} radius={radius}>
          {children}
        </ScrollArea>
      ) : children.length ? (
        <div className="absolute inset-0" style={{ overflow: clip ? "hidden" : "visible", borderRadius: clip ? radius : undefined }}>
          {children}
        </div>
      ) : null}
    </div>
  );
});

function ScrollArea({ box, r, radius, children }: { box: UiBox; r: R; radius: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const cpos = arr(r.cpos, [0, 0]);
  useEffect(() => {
    if (ref.current) ref.current.scrollTo({ left: cpos[0], top: cpos[1] });
  }, [cpos[0], cpos[1]]); // eslint-disable-line react-hooks/exhaustive-deps
  const dir = n(r.dir, 4);
  const thickness = n(r.sbT, 12);
  return (
    <div
      ref={ref}
      className="rbx-scroll absolute inset-0"
      style={{
        overflowX: dir === 2 ? "hidden" : "auto",
        overflowY: dir === 1 ? "hidden" : "auto",
        borderRadius: radius,
        scrollbarWidth: thickness <= 0 ? "none" : thickness < 8 ? "thin" : "auto",
        scrollbarColor: `${rgba(arr(r.sbC, [1, 1, 1]), 1 - n(r.sbTr, 0))} transparent`,
      }}
    >
      <div className="relative" style={{ width: box.canvas!.w, height: box.canvas!.h }}>
        {children}
      </div>
    </div>
  );
}

function Topbar() {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-3 px-3" style={{ height: TOPBAR_INSET, zIndex: 100000 }} aria-hidden>
      {[0, 1].map((k) => (
        <div key={k} className="flex size-11 items-center justify-center rounded-full bg-black/45">
          <div className="size-5 rounded-md border-2 border-white/80" />
        </div>
      ))}
      <span className="ml-auto rounded bg-black/40 px-2 py-0.5 text-[12px] text-white/70">Roblox top bar · {TOPBAR_INSET}px</span>
    </div>
  );
}

const BACKDROPS: Record<Backdrop, CSSProperties> = {
  scene: { background: "linear-gradient(180deg, #6f9fd6 0%, #a9c9ea 55%, #7f9a6a 55%, #5d7a4c 100%)" },
  dark: { background: "#1b1d24" },
  light: { background: "#e9eaef" },
  checker: { backgroundColor: "#2a2b31", backgroundImage: "conic-gradient(#3a3b42 25%, transparent 0 50%, #3a3b42 0 75%, transparent 0)", backgroundSize: "40px 40px" },
};

// ── The stage ───────────────────────────────────────────────────────────────

export interface UiStageProps {
  manifest: RobloxManifest;
  resources: ResolvedResource[];
  selected: number | null;
  onSelect: (node: number | null) => void;
  /** Fidelity notes for this file (substituted fonts, images not provided…). */
  onNotes: (notes: string[]) => void;
}

export default function UiStage({ manifest, resources, selected, onSelect, onNotes }: UiStageProps) {
  const host = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState({ w: 800, h: 450 });
  const [preset, setPreset] = useState<PresetId>(() => {
    try {
      return (localStorage.getItem(PRESET_KEY) as PresetId | null) ?? "desktop";
    } catch {
      return "desktop";
    }
  });
  const roots = useMemo(() => uiRoots(manifest), [manifest]);
  const screens = roots.filter((r) => r.kind === "screen");
  const others = roots.filter((r) => r.kind !== "screen");
  const [view, setView] = useState<string>(screens.length ? "screen" : String(others[0]?.node ?? "screen"));
  const [showHidden, setShowHidden] = useState(false);
  const [showTopbar, setShowTopbar] = useState(true);
  const [backdrop, setBackdrop] = useState<Backdrop>("scene");
  const [fontsVersion, setFontsVersion] = useState(0);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setArea({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setArea({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Load the fonts this UI uses before measuring text, then lay out again.
  const usedFonts = useMemo(() => {
    const set = new Map<string, string>();
    for (const node of manifest.nodes) {
      if (typeof node.r.text !== "string" || typeof node.r.font !== "string") continue;
      const f = resolveFont(node.r.font, n(node.r.fw, 400), b(node.r.fi, false));
      set.set(fontShorthand(f, 16), f.substituteFor ?? "");
    }
    return set;
  }, [manifest]);
  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([...usedFonts.keys()].map((spec) => document.fonts.load(spec))).then(() => !cancelled && setFontsVersion((v) => v + 1));
    return () => {
      cancelled = true;
    };
  }, [usedFonts]);

  const measure = useMemo(() => createMeasurer(), []);
  const presetInfo = SCREEN_PRESETS.find((p) => p.id === preset) ?? SCREEN_PRESETS[0];
  const laid: UiRoot[] = useMemo(() => {
    void fontsVersion;
    const screen = { width: presetInfo.width, height: presetInfo.height };
    if (view === "screen") {
      return screens
        .map((root) => layoutUiRoot(manifest, root, { screen, measure }))
        .filter((root) => root.enabled || showHidden)
        .sort((x, y) => x.order - y.order);
    }
    const root = others.find((r) => String(r.node) === view);
    return root ? [layoutUiRoot(manifest, root, { screen, measure })] : [];
  }, [manifest, view, presetInfo.width, presetInfo.height, measure, fontsVersion, showHidden]); // eslint-disable-line react-hooks/exhaustive-deps

  const surfaceW = view === "screen" ? presetInfo.width : (laid[0]?.width ?? presetInfo.width);
  const surfaceH = view === "screen" ? presetInfo.height : (laid[0]?.height ?? presetInfo.height);
  const scale = Math.max(0.05, Math.min((area.w - 32) / surfaceW, (area.h - 96) / surfaceH, view === "screen" ? 2 : 4));

  const images = useMemo(() => new Map(resources.filter((r) => r.kind === "texture").map((r) => [r.contentId, r.url])), [resources]);
  const kids = useMemo(() => {
    const out: number[][] = manifest.nodes.map(() => []);
    manifest.nodes.forEach((node, i) => node.p >= 0 && out[node.p]?.push(i));
    return out;
  }, [manifest]);
  const ctx: RenderCtx = useMemo(
    () => ({
      nodes: manifest.nodes,
      mods: (node: number) => {
        const m: Mods = { corner: null, stroke: null, gradient: null, padding: null, scale: null };
        for (const c of kids[node] ?? []) {
          const r = manifest.nodes[c]!.r;
          if (r.g === 1) continue;
          if (r.rad !== undefined) m.corner = r;
          else if (r.th !== undefined) m.stroke = r;
          else if (r.cs !== undefined) m.gradient = r;
          else if (r.pad !== undefined) m.padding = r;
          else if (r.s !== undefined && r.layout === undefined) m.scale = r;
        }
        return m;
      },
      images,
      selected,
      onSelect: (node: number) => onSelect(node),
      showHidden,
      fontsVersion,
    }),
    [manifest, kids, images, selected, onSelect, showHidden, fontsVersion],
  );

  // Fidelity notes for what this particular UI can't show exactly.
  const missingImages = useMemo(() => {
    const ids = new Set<string>();
    for (const node of manifest.nodes) if (typeof node.r.img === "string" && !images.has(node.r.img)) ids.add(node.r.img);
    return ids.size;
  }, [manifest, images]);
  useEffect(() => {
    const notes: string[] = [];
    const subs = [...new Set([...usedFonts.values()].filter(Boolean))];
    if (subs.length) notes.push(`Fonts not available to the preview, drawn with a close open font: ${subs.join(", ")}.`);
    if (missingImages) notes.push(`${missingImages} image${missingImages === 1 ? "" : "s"} not provided yet (see Resources).`);
    if (manifest.nodes.some((node) => node.r.lc === "screen" && n(node.r.zb, 1) === 0)) notes.push("ZIndexBehavior Global is drawn like Sibling (children above their parent).");
    if (others.length) notes.push("SurfaceGuis and BillboardGuis are drawn flat in the UI tab, not on their parts in 3D.");
    onNotes(notes);
  }, [usedFonts, missingImages, manifest, others.length, onNotes]);

  const hiddenCount = useMemo(() => manifest.nodes.filter((node) => node.r.g === 1 && node.r.vis === false).length + screens.filter((s) => manifest.nodes[s.node]?.r.en === false).length, [manifest, screens]);
  const choosePreset = (id: PresetId) => {
    setPreset(id);
    try {
      localStorage.setItem(PRESET_KEY, id);
    } catch {
      // not remembered
    }
  };

  return (
    <div ref={host} className="absolute inset-0 z-[5] overflow-hidden bg-[#101116]" onClick={() => onSelect(null)}>
      <style>{`.rbx-btn:hover > .rbx-bg { filter: brightness(0.82); } .rbx-btn:active > .rbx-bg { filter: brightness(0.66); } .rbx-hidden { outline: 1px dashed rgba(255,255,255,.35); opacity: .55; }`}</style>
      <div
        role="img"
        aria-label={`Roblox UI preview at ${surfaceW}×${surfaceH}`}
        className="absolute overflow-hidden shadow-2xl ring-1 ring-white/10"
        style={{
          left: Math.max(16, (area.w - surfaceW * scale) / 2),
          top: Math.max(48, (area.h - 48 - surfaceH * scale) / 2),
          width: surfaceW,
          height: surfaceH,
          transform: `scale(${scale})`,
          transformOrigin: "0 0",
          ...BACKDROPS[backdrop],
        }}
      >
        {laid.map((root) => (
          <div key={root.node} className="absolute inset-0" style={{ zIndex: root.order }}>
            {root.children.map((box) => (
              <UiNode key={box.node} box={box} ctx={ctx} />
            ))}
          </div>
        ))}
        {view === "screen" && showTopbar ? <Topbar /> : null}
        {!laid.length || laid.every((root) => !root.children.length) ? (
          <div className="absolute inset-0 flex items-center justify-center text-[16px] text-white/70">
            {hiddenCount ? "Everything here starts hidden (scripts show it in game) — turn on “Show hidden”." : "This UI has nothing to draw."}
          </div>
        ) : null}
      </div>

      <div className="absolute inset-x-2 bottom-2 z-10 flex flex-wrap items-center gap-2 rounded-lg bg-black/70 p-2 text-[12px] text-white backdrop-blur" onClick={(e) => e.stopPropagation()}>
        {view === "screen" ? (
          <Select variant="media" aria-label="Screen size" value={preset} onValueChange={choosePreset} options={SCREEN_PRESETS.map((p) => ({ value: p.id, label: p.label }))} />
        ) : null}
        {roots.length > 1 || others.length ? (
          <Select
            variant="media"
            aria-label="UI to show"
            value={view}
            onValueChange={setView}
            className="max-w-60"
            options={[
              ...(screens.length ? [{ value: "screen", label: `Screen (${screens.length} ScreenGui${screens.length === 1 ? "" : "s"})` }] : []),
              ...others.map((r) => ({ value: String(r.node), label: `${r.kind === "surface" ? "SurfaceGui" : "BillboardGui"} · ${r.name}` })),
            ]}
          />
        ) : null}
        <button
          type="button"
          aria-pressed={showHidden}
          onClick={() => setShowHidden((v) => !v)}
          className={cn("inline-flex h-7 items-center gap-1 rounded-md px-2 hover:bg-white/10", showHidden ? "bg-white/15" : "text-white/80")}
          title="Show objects that start hidden (Visible = false / disabled ScreenGuis) — scripts usually reveal them in game"
        >
          {showHidden ? <Eye className="size-4" /> : <EyeOff className="size-4" />} Show hidden{hiddenCount ? ` (${hiddenCount})` : ""}
        </button>
        {view === "screen" ? (
          <button type="button" aria-pressed={showTopbar} onClick={() => setShowTopbar((v) => !v)} className={cn("inline-flex h-7 items-center gap-1 rounded-md px-2 hover:bg-white/10", showTopbar ? "bg-white/15" : "text-white/80")}>
            <PanelTop className="size-4" /> Top bar
          </button>
        ) : null}
        <Select
          variant="media"
          aria-label="Backdrop"
          value={backdrop}
          onValueChange={setBackdrop}
          options={[
            { value: "scene", label: "Game backdrop" },
            { value: "dark", label: "Dark" },
            { value: "light", label: "Light" },
            { value: "checker", label: "Checker" },
          ]}
        />
        <span className="flex-1" />
        <span className="text-[11.5px] text-white/60">
          {surfaceW}×{surfaceH} · {Math.round(scale * 100)}% · click an element to inspect it
        </span>
      </div>
    </div>
  );
}

/** Text without markup, for labels elsewhere. */
export { plainText };
