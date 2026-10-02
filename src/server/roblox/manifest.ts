import { brickColorRgb } from "@/lib/roblox/brickcolor";
import { isBuiltinContent, normalizeContentId } from "@/lib/roblox/content-id";
import {
  primaryKind,
  ROBLOX_MANIFEST_VERSION,
  type AnimationInfo,
  type ManifestNode,
  type MValue,
  type ResourceKind,
  type ResourceUse,
  type RigInfo,
  type RobloxFileMeta,
  type RobloxManifest,
  type SupportEntry,
} from "@/lib/roblox/manifest";
import { classSupport } from "@/lib/roblox/support";
import { decodeAttributes } from "./attributes";
import type { RbxDocument, RbxInstance, RbxValue } from "./model";

const PART_CLASSES = new Set([
  "Part",
  "WedgePart",
  "CornerWedgePart",
  "TrussPart",
  "SpawnLocation",
  "Seat",
  "VehicleSeat",
  "SkateboardPlatform",
  "FlagStand",
  "Platform",
  "MeshPart",
  "UnionOperation",
  "NegateOperation",
  "IntersectOperation",
  "PartOperation",
]);
const UNION_CLASSES = new Set(["UnionOperation", "NegateOperation", "IntersectOperation", "PartOperation"]);
const SCRIPT_CLASSES = new Set(["Script", "LocalScript", "ModuleScript", "CoreScript"]);
const LIGHT_CLASSES = new Set(["PointLight", "SpotLight", "SurfaceLight"]);
const LEGACY_EFFECTS = new Set(["Fire", "Smoke", "Sparkles"]);
const JOINT_CLASSES = new Set(["Motor6D", "Motor"]);
const MAX_INSPECT_PROPS = 80;
const INSPECT_SKIP = new Set(["AttributesSerialize", "UniqueId", "HistoryId", "SourceAssetId", "ScriptGuid", "DefinesCapabilities"]);

function looksBinary(s: string): boolean {
  for (let i = 0; i < Math.min(s.length, 2048); i++) {
    const c = s.charCodeAt(i);
    if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 0xfffd) return true;
  }
  return false;
}

const round = (n: number, digits = 4) => {
  if (!Number.isFinite(n)) return n;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

function eulerXYZ(m: number[]): [number, number, number] {
  // Rotation matrix (row-major R00..R22 at m[3..11]) → XYZ Euler degrees, like CFrame:ToEulerAnglesXYZ.
  const r02 = m[5]!;
  const y = Math.asin(Math.max(-1, Math.min(1, r02)));
  let x: number;
  let z: number;
  if (Math.abs(r02) < 0.99999) {
    x = Math.atan2(-m[8]!, m[11]!);
    z = Math.atan2(-m[4]!, m[3]!);
  } else {
    x = Math.atan2(m[9]!, m[7]!);
    z = 0;
  }
  const deg = (v: number) => round((v * 180) / Math.PI, 2);
  return [deg(x), deg(y), deg(z)];
}

function display(value: RbxValue, doc: RbxDocument, propName: string, className: string): string {
  const fmt = (n: number) => String(round(n, 4));
  switch (value.type) {
    case "String": {
      if (SCRIPT_CLASSES.has(className) && propName === "Source") {
        const lines = value.value ? value.value.split("\n").length : 0;
        return `${lines} line${lines === 1 ? "" : "s"} (never executed)`;
      }
      if (value.bytes && looksBinary(value.value)) return `<${value.bytes.length} bytes>`;
      return value.value.length > 160 ? `${value.value.slice(0, 157)}…` : value.value;
    }
    case "BinaryString":
    case "SharedString":
      return `<${value.value.length} bytes>`;
    case "Bool":
      return value.value ? "true" : "false";
    case "Int32":
    case "Int64":
    case "Enum":
    case "BrickColor":
    case "Faces":
    case "Axes":
      return String(value.value);
    case "Float32":
    case "Float64":
      return fmt(value.value);
    case "Color3":
      return value.value.map((c) => Math.round(c * 255)).join(", ");
    case "Color3uint8":
      return value.value.join(", ");
    case "Vector2":
    case "Vector3":
    case "Vector2int16":
    case "Vector3int16":
    case "NumberRange":
    case "UDim":
    case "UDim2":
    case "Rect":
    case "Ray":
      return value.value.map(fmt).join(", ");
    case "CFrame":
    case "OptionalCFrame": {
      if (!value.value) return "none";
      const v = value.value;
      const [rx, ry, rz] = eulerXYZ(v);
      return `pos ${fmt(v[0])}, ${fmt(v[1])}, ${fmt(v[2])} · rot ${rx}°, ${ry}°, ${rz}°`;
    }
    case "NumberSequence": {
      const text = value.value.map(([t, v]) => `${fmt(t)}→${fmt(v)}`).join("  ");
      return text.length > 160 ? `${text.slice(0, 157)}…` : text;
    }
    case "ColorSequence": {
      const text = value.value.map(([t, r, g, b]) => `${fmt(t)}→(${[r, g, b].map((c) => Math.round(c * 255)).join(",")})`).join("  ");
      return text.length > 160 ? `${text.slice(0, 157)}…` : text;
    }
    case "Ref": {
      if (!value.value) return "none";
      const target = doc.byRef.get(value.value);
      return target ? `→ ${target.className} "${target.name}"` : "→ (outside this file)";
    }
    case "Content":
      return value.value ?? "none";
    case "PhysicalProperties":
      return value.value ? value.value.map(fmt).join(", ") : "default";
    case "Font":
      return `${value.value.family} (${value.value.weight}, ${value.value.style})`;
    case "UniqueId":
    case "SecurityCapabilities":
      return value.value;
    case "Unknown":
      return `(${value.value})`;
  }
}

interface Ctx {
  doc: RbxDocument;
  index: Map<RbxInstance, number>;
  resources: Map<string, ResourceUse>;
  warnings: string[];
}

function prop(inst: RbxInstance, ...names: string[]): RbxValue | undefined {
  for (const n of names) {
    const v = inst.props.get(n);
    if (v) return v;
  }
  return undefined;
}

const num = (v: RbxValue | undefined, fallback: number): number => {
  if (!v) return fallback;
  switch (v.type) {
    case "Float32":
    case "Float64":
    case "Int32":
    case "Int64":
    case "Enum":
    case "BrickColor":
      return Number.isFinite(v.value) ? v.value : fallback;
    default:
      return fallback;
  }
};
const bool = (v: RbxValue | undefined, fallback: boolean) => (v?.type === "Bool" ? v.value : fallback);
const vec = (v: RbxValue | undefined, fallback: number[]): number[] =>
  v && (v.type === "Vector3" || v.type === "Vector2" || v.type === "Vector3int16" || v.type === "Vector2int16" || v.type === "NumberRange")
    ? v.value.map((n) => (Number.isFinite(n) ? round(n, 5) : 0))
    : fallback;
const cf = (v: RbxValue | undefined): number[] | null =>
  v && (v.type === "CFrame" || v.type === "OptionalCFrame") && v.value ? v.value.map((n) => round(n, 6)) : null;
const color3 = (v: RbxValue | undefined, fallback: number[]): number[] => {
  if (!v) return fallback;
  if (v.type === "Color3") return v.value.map((c) => round(Math.max(0, c), 4));
  if (v.type === "Color3uint8") return v.value.map((c) => round(c / 255, 4));
  if (v.type === "BrickColor") return brickColorRgb(v.value).map((c) => round(c / 255, 4));
  return fallback;
};
const numberSeq = (v: RbxValue | undefined, fallback: number): number[][] =>
  v?.type === "NumberSequence" && v.value.length ? v.value.map((k) => k.map((n) => round(n, 5))) : [[0, fallback, 0], [1, fallback, 0]];
const colorSeq = (v: RbxValue | undefined): number[][] => {
  if (v?.type === "ColorSequence" && v.value.length) return v.value.map(([t, r, g, b]) => [round(t, 5), round(r, 4), round(g, 4), round(b, 4)]);
  if (v?.type === "Color3") return [[0, ...v.value], [1, ...v.value]];
  return [[0, 1, 1, 1], [1, 1, 1, 1]];
};
const str = (v: RbxValue | undefined): string | null => {
  if (!v) return null;
  if (v.type === "String") return v.value || null;
  if (v.type === "Content") return v.value;
  return null;
};

function ref(ctx: Ctx, v: RbxValue | undefined): number | null {
  if (v?.type !== "Ref" || !v.value) return null;
  const target = ctx.doc.byRef.get(v.value);
  return target ? (ctx.index.get(target) ?? null) : null;
}

function resource(ctx: Ctx, raw: string | null, kind: ResourceKind, node: number, propName: string, affectsPreview = true): string | null {
  const contentId = normalizeContentId(raw);
  if (!contentId) return null;
  const existing = ctx.resources.get(`${kind}:${contentId}`);
  if (existing) {
    existing.uses.push({ node, prop: propName });
    existing.affectsPreview ||= affectsPreview;
  } else {
    ctx.resources.set(`${kind}:${contentId}`, {
      contentId,
      kind,
      builtin: isBuiltinContent(contentId),
      affectsPreview,
      uses: [{ node, prop: propName }],
    });
  }
  return contentId;
}

function partShape(inst: RbxInstance): number | string {
  switch (inst.className) {
    case "WedgePart":
      return 3;
    case "CornerWedgePart":
      return 4;
    case "TrussPart":
      return "truss";
    case "MeshPart":
      return "mesh";
    default:
      if (UNION_CLASSES.has(inst.className)) return "union";
      return num(prop(inst, "shape", "Shape"), 1);
  }
}

// ── 2D UI (ScreenGui / SurfaceGui / BillboardGui and their contents) ────────

/** Objects that draw something in a UI (GuiObject subclasses). */
export const GUI_OBJECTS = new Set([
  "Frame",
  "TextLabel",
  "TextButton",
  "TextBox",
  "ImageLabel",
  "ImageButton",
  "ScrollingFrame",
  "ViewportFrame",
  "VideoFrame",
  "CanvasGroup",
]);
/** Roots a UI is drawn into. */
export const LAYER_COLLECTORS = new Set(["ScreenGui", "SurfaceGui", "BillboardGui", "GuiMain"]);
/** Layout and appearance modifiers parented to a GuiObject. */
export const UI_MODIFIERS = new Set([
  "UICorner",
  "UIStroke",
  "UIGradient",
  "UIPadding",
  "UIListLayout",
  "UIGridLayout",
  "UIPageLayout",
  "UITableLayout",
  "UIAspectRatioConstraint",
  "UISizeConstraint",
  "UITextSizeConstraint",
  "UIScale",
  "UIFlexItem",
]);

/** Roblox's legacy Font enum → [FontFace family file, weight, italic]. */
const LEGACY_FONTS: Record<number, [string, number, number]> = {
  0: ["LegacyArial", 400, 0],
  1: ["Arial", 400, 0],
  2: ["Arial", 700, 0],
  3: ["SourceSansPro", 400, 0],
  4: ["SourceSansPro", 700, 0],
  5: ["SourceSansPro", 300, 0],
  6: ["SourceSansPro", 400, 1],
  7: ["AccanthisADFStd", 400, 0],
  8: ["Guru", 400, 0],
  9: ["ComicNeueAngular", 400, 0],
  10: ["Inconsolata", 400, 0],
  11: ["HighwayGothic", 400, 0],
  12: ["Zekton", 400, 0],
  13: ["PressStart2P", 400, 0],
  14: ["Balthazar", 400, 0],
  15: ["Kalam", 400, 0],
  16: ["SourceSansPro", 600, 0],
  17: ["GothamSSm", 400, 0],
  18: ["GothamSSm", 500, 0],
  19: ["GothamSSm", 700, 0],
  20: ["GothamSSm", 900, 0],
  21: ["AmaticSC", 400, 0],
  22: ["Bangers", 400, 0],
  23: ["Creepster", 400, 0],
  24: ["DenkOne", 400, 0],
  25: ["Fondamento", 400, 0],
  26: ["FredokaOne", 400, 0],
  27: ["GrenzeGotisch", 400, 0],
  28: ["IndieFlower", 400, 0],
  29: ["JosefinSans", 400, 0],
  30: ["Jura", 400, 0],
  31: ["Kalam", 400, 0],
  32: ["LuckiestGuy", 400, 0],
  33: ["Merriweather", 400, 0],
  34: ["Michroma", 400, 0],
  35: ["Nunito", 400, 0],
  36: ["Oswald", 400, 0],
  37: ["PatrickHand", 400, 0],
  38: ["PermanentMarker", 400, 0],
  39: ["Roboto", 400, 0],
  40: ["RobotoCondensed", 400, 0],
  41: ["RobotoMono", 400, 0],
  42: ["Sarpanch", 400, 0],
  43: ["SpecialElite", 400, 0],
  44: ["TitilliumWeb", 400, 0],
  45: ["Ubuntu", 400, 0],
  46: ["BuilderSans", 400, 0],
  47: ["BuilderSans", 500, 0],
  48: ["BuilderSans", 700, 0],
  49: ["BuilderSans", 800, 0],
  50: ["Arimo", 400, 0],
  51: ["Arimo", 700, 0],
};

/** { font: family key, fw: weight, fi: italic } from FontFace, else the legacy Font enum. */
function fontOf(inst: RbxInstance): { font: string; fw: number; fi: boolean } {
  const face = inst.props.get("FontFace");
  if (face?.type === "Font" && face.value.family) {
    const family = face.value.family;
    const file = /\/([^/]+)\.json$/i.exec(family)?.[1];
    const assetId = /^rbxassetid:\/\/(\d+)/i.exec(family)?.[1] ?? /[?&]id=(\d+)/.exec(family)?.[1];
    const key = file ?? (assetId ? `asset:${assetId}` : "SourceSansPro");
    return { font: key, fw: face.value.weight || 400, fi: face.value.style === "Italic" };
  }
  const [font, fw, fi] = LEGACY_FONTS[num(inst.props.get("Font"), 3)] ?? LEGACY_FONTS[3]!;
  return { font, fw, fi: fi === 1 };
}

/** Vector2 that may hold infinities (UISizeConstraint.MaxSize defaults to infinite). */
const v2big = (v: RbxValue | undefined, fallback: number[]): number[] =>
  v?.type === "Vector2" ? v.value.map((n) => (Number.isFinite(n) ? round(n, 3) : 1e9)) : fallback;

const udim = (v: RbxValue | undefined, fallback: number[]): number[] =>
  v?.type === "UDim" ? [round(v.value[0], 5), Math.round(v.value[1])] : fallback;
const udim2 = (v: RbxValue | undefined, fallback: number[]): number[] =>
  v?.type === "UDim2" ? [round(v.value[0], 5), Math.round(v.value[1]), round(v.value[2], 5), Math.round(v.value[3])] : fallback;
const rect = (v: RbxValue | undefined): number[] | null => (v?.type === "Rect" ? v.value.map((n) => round(n, 3)) : null);
const MAX_TEXT = 4000;

function guiProps(ctx: Ctx, inst: RbxInstance, i: number): Record<string, MValue> {
  const c = inst.className;
  const p = (...n: string[]) => prop(inst, ...n);

  if (LAYER_COLLECTORS.has(c)) {
    const base = { lc: c === "SurfaceGui" ? "surface" : c === "BillboardGui" ? "billboard" : "screen", en: bool(p("Enabled"), true), zb: num(p("ZIndexBehavior"), 0) };
    if (c === "SurfaceGui") {
      return { ...base, canvas: vec(p("CanvasSize"), [800, 600]), face: num(p("Face"), 5), ppu: round(num(p("PixelsPerStud"), 50), 3), sizing: num(p("SizingMode"), 0), adornee: ref(ctx, p("Adornee")) };
    }
    if (c === "BillboardGui") return { ...base, size: udim2(p("Size"), [0, 200, 0, 50]), adornee: ref(ctx, p("Adornee")) };
    return { ...base, inset: bool(p("IgnoreGuiInset"), false), order: num(p("DisplayOrder"), 0), si: num(p("ScreenInsets"), 2), safe: bool(p("ClipToDeviceSafeArea"), true) };
  }

  if (GUI_OBJECTS.has(c)) {
    const r: Record<string, MValue> = {
      g: 1,
      pos: udim2(p("Position"), [0, 0, 0, 0]),
      size: udim2(p("Size"), [0, 100, 0, 100]),
      anchor: vec(p("AnchorPoint"), [0, 0]),
      rot: round(num(p("Rotation"), 0), 3),
      bg: color3(p("BackgroundColor3"), [0.64, 0.64, 0.64]),
      bgT: round(num(p("BackgroundTransparency"), 0), 4),
      bd: num(p("BorderSizePixel"), 1),
      bdC: color3(p("BorderColor3"), [0.1, 0.16, 0.2]),
      bdM: num(p("BorderMode"), 0),
      vis: bool(p("Visible"), true),
      z: num(p("ZIndex"), 1),
      order: num(p("LayoutOrder"), 0),
      clip: bool(p("ClipsDescendants"), false),
      auto: num(p("AutomaticSize"), 0),
      sc: num(p("SizeConstraint"), 0),
    };
    if (c === "TextLabel" || c === "TextButton" || c === "TextBox") {
      const text = str(p("Text")) ?? "";
      Object.assign(r, {
        text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text,
        tc: color3(p("TextColor3"), [0.1, 0.1, 0.1]),
        ts: round(num(p("TextSize", "FontSize"), 14), 2),
        tScaled: bool(p("TextScaled"), false),
        wrap: bool(p("TextWrapped"), false),
        xa: num(p("TextXAlignment"), 2),
        ya: num(p("TextYAlignment"), 1),
        tT: round(num(p("TextTransparency"), 0), 4),
        sC: color3(p("TextStrokeColor3"), [0, 0, 0]),
        sT: round(num(p("TextStrokeTransparency"), 1), 4),
        rich: bool(p("RichText"), false),
        lh: round(num(p("LineHeight"), 1), 3),
        trunc: num(p("TextTruncate"), 0),
        maxG: num(p("MaxVisibleGraphemes"), -1),
        ...fontOf(inst),
      });
      if (c === "TextBox") {
        r.ph = str(p("PlaceholderText")) ?? "";
        r.phC = color3(p("PlaceholderColor3"), [0.7, 0.7, 0.7]);
      }
    }
    if (c === "ImageLabel" || c === "ImageButton") {
      Object.assign(r, {
        img: resource(ctx, str(p("ImageContent", "Image")), "texture", i, "Image"),
        iC: color3(p("ImageColor3"), [1, 1, 1]),
        iT: round(num(p("ImageTransparency"), 0), 4),
        st: num(p("ScaleType"), 0),
        slice: rect(p("SliceCenter")),
        sliceS: round(num(p("SliceScale"), 1), 4),
        tile: udim2(p("TileSize"), [1, 0, 1, 0]),
        ro: vec(p("ImageRectOffset"), [0, 0]),
        rs: vec(p("ImageRectSize"), [0, 0]),
        pix: num(p("ResampleMode"), 0) === 1,
      });
    }
    if (c === "TextButton" || c === "ImageButton") r.autoBtn = bool(p("AutoButtonColor"), true);
    if (c === "ScrollingFrame") {
      Object.assign(r, {
        canvas: udim2(p("CanvasSize"), [0, 0, 2, 0]),
        cpos: vec(p("CanvasPosition"), [0, 0]),
        sbT: num(p("ScrollBarThickness"), 12),
        sbC: color3(p("ScrollBarImageColor3"), [1, 1, 1]),
        sbTr: round(num(p("ScrollBarImageTransparency"), 0), 4),
        dir: num(p("ScrollingDirection"), 4),
        autoCanvas: num(p("AutomaticCanvasSize"), 0),
      });
    }
    if (c === "CanvasGroup") Object.assign(r, { gC: color3(p("GroupColor3"), [1, 1, 1]), gT: round(num(p("GroupTransparency"), 0), 4) });
    return r;
  }

  switch (c) {
    case "UICorner":
      return { rad: udim(p("CornerRadius"), [0, 8]) };
    case "UIStroke":
      return { th: round(num(p("Thickness"), 1), 3), c: color3(p("Color"), [0, 0, 0]), t: round(num(p("Transparency"), 0), 4), mode: num(p("ApplyStrokeMode"), 0), en: bool(p("Enabled"), true), join: num(p("LineJoinMode"), 0) };
    case "UIGradient":
      return { cs: colorSeq(p("Color")), ts: numberSeq(p("Transparency"), 0), rot: round(num(p("Rotation"), 0), 3), off: vec(p("Offset"), [0, 0]), en: bool(p("Enabled"), true) };
    case "UIPadding":
      return { pad: [...udim(p("PaddingTop"), [0, 0]), ...udim(p("PaddingRight"), [0, 0]), ...udim(p("PaddingBottom"), [0, 0]), ...udim(p("PaddingLeft"), [0, 0])] };
    case "UIListLayout":
    case "UIPageLayout":
    case "UITableLayout":
      return {
        layout: c === "UIListLayout" ? "list" : c === "UIPageLayout" ? "page" : "table",
        fd: num(p("FillDirection"), 1),
        ha: num(p("HorizontalAlignment"), 1),
        va: num(p("VerticalAlignment"), 1),
        so: num(p("SortOrder"), 2),
        gap: udim(p("Padding"), [0, 0]),
        wrap: bool(p("Wraps"), false),
        hf: num(p("HorizontalFlex"), 0),
        vf: num(p("VerticalFlex"), 0),
      };
    case "UIGridLayout":
      return {
        layout: "grid",
        cell: udim2(p("CellSize"), [0, 100, 0, 100]),
        cgap: udim2(p("CellPadding"), [0, 5, 0, 5]),
        fd: num(p("FillDirection"), 0),
        ha: num(p("HorizontalAlignment"), 1),
        va: num(p("VerticalAlignment"), 1),
        so: num(p("SortOrder"), 2),
        start: num(p("StartCorner"), 0),
        maxCells: num(p("FillDirectionMaxCells"), 0),
      };
    case "UIAspectRatioConstraint":
      return { ar: round(num(p("AspectRatio"), 1), 5), at: num(p("AspectType"), 0), da: num(p("DominantAxis"), 0) };
    case "UISizeConstraint":
      return { min: v2big(p("MinSize"), [0, 0]), max: v2big(p("MaxSize"), [1e9, 1e9]) };
    case "UITextSizeConstraint":
      return { tmin: num(p("MinTextSize"), 1), tmax: num(p("MaxTextSize"), 100) };
    case "UIScale":
      return { s: round(num(p("Scale"), 1), 5) };
    default:
      return {};
  }
}

function renderProps(ctx: Ctx, inst: RbxInstance, i: number): Record<string, MValue> {
  const c = inst.className;
  const p = (...n: string[]) => prop(inst, ...n);
  if (GUI_OBJECTS.has(c) || LAYER_COLLECTORS.has(c) || UI_MODIFIERS.has(c)) return guiProps(ctx, inst, i);

  if (PART_CLASSES.has(c)) {
    const r: Record<string, MValue> = {
      cf: cf(p("CFrame")),
      size: vec(p("size", "Size"), [4, 1, 2]),
      color: color3(p("Color3uint8", "Color", "BrickColor"), [0.64, 0.635, 0.647]),
      tr: round(num(p("Transparency"), 0), 4),
      refl: round(num(p("Reflectance"), 0), 4),
      mat: num(p("Material"), 256),
      shape: partShape(inst),
      shadow: bool(p("CastShadow"), true),
    };
    if (c === "MeshPart") {
      r.meshId = resource(ctx, str(p("MeshContent", "MeshId")), "mesh", i, "MeshId");
      r.texId = resource(ctx, str(p("TextureContent", "TextureID")), "texture", i, "TextureID");
      r.initSize = vec(p("InitialSize"), r.size as number[]);
      r.doubleSided = bool(p("DoubleSided"), false);
    }
    if (UNION_CLASSES.has(c)) {
      const assetId = str(p("AssetId"));
      r.hasMeshData = Boolean(p("MeshData") || assetId);
      r.usePartColor = bool(p("UsePartColor"), false);
    }
    return r;
  }

  switch (c) {
    case "SpecialMesh":
    case "FileMesh":
    case "BlockMesh":
    case "CylinderMesh": {
      const meshType = c === "BlockMesh" ? 6 : c === "CylinderMesh" ? "cylinderY" : c === "FileMesh" ? 5 : num(p("MeshType"), 0);
      const isFile = meshType === 5;
      return {
        meshType,
        meshId: isFile ? resource(ctx, str(p("MeshContent", "MeshId")), "mesh", i, "MeshId") : null,
        texId: resource(ctx, str(p("TextureContent", "TextureId")), "texture", i, "TextureId"),
        scale: vec(p("Scale"), [1, 1, 1]),
        offset: vec(p("Offset"), [0, 0, 0]),
        vcolor: vec(p("VertexColor"), [1, 1, 1]),
      };
    }
    case "Decal":
    case "Texture":
      return {
        texId: resource(ctx, str(p("TextureContent", "ColorMapContent", "Texture")), "texture", i, "Texture"),
        face: num(p("Face"), 5),
        tr: round(num(p("Transparency"), 0), 4),
        color: color3(p("Color3", "Color3uint8"), [1, 1, 1]),
        z: num(p("ZIndex"), 1),
        su: c === "Texture" ? num(p("StudsPerTileU"), 2) : null,
        sv: c === "Texture" ? num(p("StudsPerTileV"), 2) : null,
        ou: c === "Texture" ? num(p("OffsetStudsU"), 0) : null,
        ov: c === "Texture" ? num(p("OffsetStudsV"), 0) : null,
      };
    case "SurfaceAppearance":
      return {
        colorMap: resource(ctx, str(p("ColorMapContent", "ColorMap")), "texture", i, "ColorMap"),
        color: color3(p("Color"), [1, 1, 1]),
        // Enum.AlphaMode: 0 Overlay (alpha shows the part colour), 1 Transparency (alpha cuts holes), 2 TintMask.
        alphaMode: num(p("AlphaMode"), 0),
      };
    case "Attachment":
    case "Bone":
      return { cf: cf(p("CFrame")) ?? [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] };
    case "Motor6D":
    case "Motor":
    case "Weld":
    case "ManualWeld":
    case "Snap":
    case "Glue":
      return {
        p0: ref(ctx, p("Part0")),
        p1: ref(ctx, p("Part1")),
        c0: cf(p("C0")) ?? [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
        c1: cf(p("C1")) ?? [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
      };
    case "Humanoid":
      return { rigType: num(p("RigType"), 0), hipHeight: round(num(p("HipHeight"), 0), 4) };
    case "KeyframeSequence":
      return { loop: bool(p("Loop"), true), priority: num(p("Priority"), 2) };
    case "Keyframe":
      return { time: round(num(p("Time"), 0), 5) };
    case "Pose":
      return {
        cf: cf(p("CFrame")) ?? [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
        w: round(num(p("Weight"), 1), 4),
        es: num(p("EasingStyle"), 0),
        ed: num(p("EasingDirection"), 0),
      };
    case "KeyframeMarker":
      return { value: str(p("Value")) ?? "" };
    case "Animation":
      return { animId: resource(ctx, str(p("AnimationId")), "animation", i, "AnimationId", false) };
    case "Sound":
      return { soundId: resource(ctx, str(p("AudioContent", "SoundId")), "audio", i, "SoundId", false) };
    case "ParticleEmitter":
      return {
        tex: resource(ctx, str(p("TextureContent", "Texture")), "texture", i, "Texture"),
        enabled: bool(p("Enabled"), true),
        rate: round(num(p("Rate"), 20), 4),
        life: vec(p("Lifetime"), [5, 10]),
        speed: vec(p("Speed"), [5, 5]),
        spread: vec(p("SpreadAngle"), [0, 0]),
        accel: vec(p("Acceleration"), [0, 0, 0]),
        drag: round(num(p("Drag"), 0), 4),
        velInherit: round(num(p("VelocityInheritance"), 0), 4),
        locked: bool(p("LockedToPart"), false),
        rot: vec(p("Rotation"), [0, 0]),
        rotSpeed: vec(p("RotSpeed"), [0, 0]),
        size: numberSeq(p("Size"), 1),
        tr: numberSeq(p("Transparency"), 0),
        squash: numberSeq(p("Squash"), 0),
        color: colorSeq(p("Color")),
        le: round(num(p("LightEmission"), 0), 4),
        li: round(num(p("LightInfluence"), 1), 4),
        bright: round(num(p("Brightness"), 1), 4),
        zoff: round(num(p("ZOffset"), 0), 4),
        orient: num(p("Orientation"), 0),
        dir: num(p("EmissionDirection"), 1),
        shape: num(p("Shape"), 0),
        shapeStyle: num(p("ShapeStyle"), 0),
        shapeInOut: num(p("ShapeInOut"), 0),
        shapePartial: round(num(p("ShapePartial"), 1), 4),
        timeScale: round(num(p("TimeScale"), 1), 4),
        fbLayout: num(p("FlipbookLayout"), 0),
        fbMode: num(p("FlipbookMode"), 0),
        fbRate: vec(p("FlipbookFramerate"), [1, 1]),
        fbRandom: bool(p("FlipbookStartRandom"), false),
      };
    case "Beam":
      return {
        a0: ref(ctx, p("Attachment0")),
        a1: ref(ctx, p("Attachment1")),
        cs0: round(num(p("CurveSize0"), 0), 4),
        cs1: round(num(p("CurveSize1"), 0), 4),
        seg: Math.max(1, Math.min(1000, num(p("Segments"), 10))),
        w0: round(num(p("Width0"), 1), 4),
        w1: round(num(p("Width1"), 1), 4),
        face: bool(p("FaceCamera"), false),
        tex: resource(ctx, str(p("TextureContent", "Texture")), "texture", i, "Texture"),
        texMode: num(p("TextureMode"), 0),
        texLen: round(num(p("TextureLength"), 1), 4),
        texSpeed: round(num(p("TextureSpeed"), 1), 4),
        color: colorSeq(p("Color")),
        tr: numberSeq(p("Transparency"), 0.5),
        le: round(num(p("LightEmission"), 0), 4),
        li: round(num(p("LightInfluence"), 0), 4),
        bright: round(num(p("Brightness"), 1), 4),
        zoff: round(num(p("ZOffset"), 0), 4),
        enabled: bool(p("Enabled"), true),
      };
    case "Trail":
      return {
        a0: ref(ctx, p("Attachment0")),
        a1: ref(ctx, p("Attachment1")),
        life: round(num(p("Lifetime"), 2), 4),
        minLen: round(num(p("MinLength"), 0.1), 4),
        maxLen: round(num(p("MaxLength"), 0), 4),
        widthScale: numberSeq(p("WidthScale"), 1),
        color: colorSeq(p("Color")),
        tr: numberSeq(p("Transparency"), 0.5),
        tex: resource(ctx, str(p("TextureContent", "Texture")), "texture", i, "Texture"),
        texMode: num(p("TextureMode"), 0),
        texLen: round(num(p("TextureLength"), 1), 4),
        face: bool(p("FaceCamera"), false),
        le: round(num(p("LightEmission"), 0), 4),
        li: round(num(p("LightInfluence"), 1), 4),
        bright: round(num(p("Brightness"), 1), 4),
        enabled: bool(p("Enabled"), true),
      };
    case "PointLight":
    case "SpotLight":
    case "SurfaceLight":
      return {
        bright: round(num(p("Brightness"), 1), 4),
        range: round(num(p("Range"), c === "PointLight" ? 8 : 16), 4),
        color: color3(p("Color"), [1, 1, 1]),
        enabled: bool(p("Enabled"), true),
        shadows: bool(p("Shadows"), false),
        angle: c === "PointLight" ? null : round(num(p("Angle"), 90), 4),
        face: c === "PointLight" ? null : num(p("Face"), 5),
      };
    case "Fire":
      return {
        size: round(num(p("size_xml", "Size"), 5), 4),
        heat: round(num(p("heat_xml", "Heat"), 9), 4),
        color: color3(p("Color"), [0.93, 0.36, 0.1]),
        color2: color3(p("SecondaryColor"), [0.54, 0.21, 0.1]),
        enabled: bool(p("Enabled"), true),
        timeScale: round(num(p("TimeScale"), 1), 4),
      };
    case "Smoke":
      return {
        color: color3(p("Color"), [1, 1, 1]),
        opacity: round(num(p("opacity_xml", "Opacity"), 0.5), 4),
        rise: round(num(p("riseVelocity_xml", "RiseVelocity"), 1), 4),
        size: round(num(p("size_xml", "Size"), 1), 4),
        enabled: bool(p("Enabled"), true),
        timeScale: round(num(p("TimeScale"), 1), 4),
      };
    case "Sparkles":
      return { color: color3(p("SparkleColor", "Color"), [0.56, 0.31, 1]), enabled: bool(p("Enabled"), true), timeScale: round(num(p("TimeScale"), 1), 4) };
    case "Highlight":
      return {
        fill: color3(p("FillColor"), [1, 0.35, 0.35]),
        outline: color3(p("OutlineColor"), [1, 1, 1]),
        fillTr: round(num(p("FillTransparency"), 0.5), 4),
        outlineTr: round(num(p("OutlineTransparency"), 0), 4),
        adornee: ref(ctx, p("Adornee")),
        depth: num(p("DepthMode"), 0),
        enabled: bool(p("Enabled"), true),
      };
    case "Model":
    case "Actor":
    case "WorldModel":
      return { pivot: cf(p("WorldPivotData")), primary: ref(ctx, p("PrimaryPart")) };
    default:
      if (SCRIPT_CLASSES.has(c)) {
        const source = str(p("Source")) ?? "";
        return { lines: source ? source.split("\n").length : 0, disabled: bool(p("Disabled"), false) };
      }
      return {};
  }
}

function attributes(inst: RbxInstance): Record<string, MValue> | undefined {
  const blob = inst.props.get("AttributesSerialize");
  const bytes = blob?.type === "BinaryString" ? blob.value : blob?.type === "String" ? blob.bytes : undefined;
  const decoded = decodeAttributes(bytes);
  const entries = Object.entries(decoded).slice(0, 64);
  if (!entries.length) return undefined;
  return Object.fromEntries(entries.map(([k, v]) => [k, typeof v === "number" ? round(v, 5) : v]));
}

function findDescendants(inst: RbxInstance, predicate: (i: RbxInstance) => boolean, out: RbxInstance[] = []): RbxInstance[] {
  for (const c of inst.children) {
    if (predicate(c)) out.push(c);
    findDescendants(c, predicate, out);
  }
  return out;
}

function isAncestor(ancestor: RbxInstance, inst: RbxInstance): boolean {
  for (let p = inst.parent; p; p = p.parent) if (p === ancestor) return true;
  return false;
}

/** A Bone only does anything when it hangs off a part (directly or through other bones). */
function isMountedBone(inst: RbxInstance): boolean {
  if (inst.className !== "Bone") return false;
  let p = inst.parent;
  while (p && p.className === "Bone") p = p.parent;
  return Boolean(p && PART_CLASSES.has(p.className));
}

function detectRigs(ctx: Ctx, nodes: ManifestNode[]): RigInfo[] {
  const rigs: RigInfo[] = [];
  const claimed = new Set<RbxInstance>();
  // Deepest containers first, so a place with many characters yields one rig per character.
  const containers = ctx.doc.instances
    .filter((i) => i.className === "Model" || i.className === "Actor" || i.className === "WorldModel")
    .sort((a, b) => depth(b) - depth(a));
  for (const model of containers) {
    const joints = findDescendants(model, (i) => JOINT_CLASSES.has(i.className) && !claimed.has(i));
    const valid = joints.filter((j) => {
      const r = nodes[ctx.index.get(j)!]!.r;
      const p0 = typeof r.p0 === "number" ? ctx.doc.instances[r.p0] : undefined;
      const p1 = typeof r.p1 === "number" ? ctx.doc.instances[r.p1] : undefined;
      return p0 && p1 && isAncestor(model, p0) && isAncestor(model, p1);
    });
    // Skinned rigs: bones (under the rig's parts) are animated like joints.
    const bones = findDescendants(model, (i) => isMountedBone(i) && !claimed.has(i));
    if (valid.length === 0 && bones.length === 0) continue;
    valid.forEach((j) => claimed.add(j));
    bones.forEach((b) => claimed.add(b));
    const humanoid = findDescendants(model, (i) => i.className === "Humanoid")[0];
    const partNames = new Set(findDescendants(model, (i) => PART_CLASSES.has(i.className)).map((p) => p.name));
    let rigType: RigInfo["rigType"] = "custom";
    if (humanoid) rigType = num(humanoid.props.get("RigType"), 0) === 1 ? "R15" : "R6";
    else if (partNames.has("UpperTorso") && partNames.has("LowerTorso")) rigType = "R15";
    else if (partNames.has("Torso") && partNames.has("Left Arm")) rigType = "R6";
    const jointInfo = valid.map((j) => {
      const r = nodes[ctx.index.get(j)!]!.r;
      return { node: ctx.index.get(j)!, part0: r.p0 as number, part1: r.p1 as number };
    });
    const part1s = new Set(jointInfo.map((j) => j.part1));
    const hrp = findDescendants(model, (i) => i.name === "HumanoidRootPart" && PART_CLASSES.has(i.className))[0];
    let rootCandidate = hrp ? ctx.index.get(hrp)! : (jointInfo.find((j) => !part1s.has(j.part0))?.part0 ?? null);
    if (rootCandidate === null && bones.length) {
      let p = bones[0]!.parent;
      while (p && p.className === "Bone") p = p.parent;
      rootCandidate = p ? ctx.index.get(p)! : null;
    }
    rigs.push({ node: ctx.index.get(model)!, name: model.name, rigType, rootPart: rootCandidate, joints: jointInfo, bones: bones.map((b) => ctx.index.get(b)!) });
  }
  return rigs;
}

function depth(inst: RbxInstance): number {
  let d = 0;
  for (let p = inst.parent; p; p = p.parent) d++;
  return d;
}

function animationInfo(ctx: Ctx, nodes: ManifestNode[]): AnimationInfo[] {
  const out: AnimationInfo[] = [];
  for (const inst of ctx.doc.instances) {
    if (inst.className === "KeyframeSequence") {
      const node = ctx.index.get(inst)!;
      const keyframes = inst.children.filter((c) => c.className === "Keyframe");
      const joints = new Set<string>();
      const markers: AnimationInfo["markers"] = [];
      let length = 0;
      for (const kf of keyframes) {
        const time = nodes[ctx.index.get(kf)!]!.r.time as number;
        length = Math.max(length, time);
        if (kf.name && kf.name !== "Keyframe") markers.push({ time, name: kf.name });
        for (const m of kf.children) if (m.className === "KeyframeMarker") markers.push({ time, name: m.name });
        for (const pose of findDescendants(kf, (d) => d.className === "Pose")) {
          const w = nodes[ctx.index.get(pose)!]!.r.w as number;
          if (w > 0) joints.add(pose.name);
        }
      }
      const r = nodes[node]!.r;
      out.push({
        node,
        name: inst.name,
        length: round(length, 4),
        loop: Boolean(r.loop),
        priority: r.priority as number,
        keyframes: keyframes.length,
        joints: [...joints].filter((j) => j !== "HumanoidRootPart").sort(),
        markers: markers.sort((a, b) => a.time - b.time),
        kind: "keyframes",
      });
    } else if (inst.className === "CurveAnimation") {
      out.push({ node: ctx.index.get(inst)!, name: inst.name, length: 0, loop: false, priority: 2, keyframes: 0, joints: [], markers: [], kind: "curves" });
    }
  }
  return out;
}

export function buildManifest(doc: RbxDocument): RobloxManifest {
  const index = new Map<RbxInstance, number>();
  doc.instances.forEach((inst, i) => index.set(inst, i));
  const ctx: Ctx = { doc, index, resources: new Map(), warnings: [...doc.warnings] };

  const classCounts: Record<string, number> = {};
  const supportCounts = new Map<string, number>();
  const nodes: ManifestNode[] = doc.instances.map((inst, i) => {
    classCounts[inst.className] = (classCounts[inst.className] ?? 0) + 1;
    const r = renderProps(ctx, inst, i);
    const supportKey = inst.className === "SpecialMesh" && r.meshType === 5 ? "SpecialMesh (FileMesh)" : inst.className;
    supportCounts.set(supportKey, (supportCounts.get(supportKey) ?? 0) + 1);

    const x: Array<[string, string]> = [];
    const names = [...inst.props.keys()].filter((k) => !INSPECT_SKIP.has(k)).sort((a, b) => a.localeCompare(b));
    for (const name of names.slice(0, MAX_INSPECT_PROPS)) {
      const value = inst.props.get(name)!;
      if (name === "Tags") {
        const bytes = value.type === "BinaryString" ? value.value : value.type === "String" ? value.bytes : undefined;
        const tags = bytes?.length ? new TextDecoder().decode(bytes).split("\0").filter(Boolean) : [];
        if (tags.length) x.push(["Tags", tags.join(", ")]);
        continue;
      }
      x.push([name, display(value, doc, name, inst.className)]);
    }
    if (names.length > MAX_INSPECT_PROPS) x.push(["…", `${names.length - MAX_INSPECT_PROPS} more properties`]);

    const node: ManifestNode = { p: inst.parent ? index.get(inst.parent)! : -1, c: inst.className, n: inst.name, r, x };
    const a = attributes(inst);
    if (a) node.a = a;
    return node;
  });

  const rigs = detectRigs(ctx, nodes);
  const animations = animationInfo(ctx, nodes);

  const count = (pred: (c: string) => boolean) => Object.entries(classCounts).reduce((n, [c, k]) => n + (pred(c) ? k : 0), 0);
  const summary = {
    parts: count((c) => PART_CLASSES.has(c)),
    meshParts: count((c) => c === "MeshPart"),
    unions: count((c) => UNION_CLASSES.has(c)),
    animations: animations.length,
    emitters: count((c) => c === "ParticleEmitter"),
    beams: count((c) => c === "Beam"),
    trails: count((c) => c === "Trail"),
    lights: count((c) => LIGHT_CLASSES.has(c)),
    legacyEffects: count((c) => LEGACY_EFFECTS.has(c)),
    scripts: count((c) => SCRIPT_CLASSES.has(c)),
    guis: count((c) => LAYER_COLLECTORS.has(c)),
    guiObjects: count((c) => GUI_OBJECTS.has(c)),
  };
  const capabilities = {
    model: summary.parts > 0,
    animation: animations.some((a) => a.kind === "keyframes" && a.keyframes > 0),
    effects: summary.emitters + summary.beams + summary.trails + summary.legacyEffects > 0,
    ui: summary.guiObjects > 0,
  };

  if (summary.scripts) {
    ctx.warnings.push(`${summary.scripts} script${summary.scripts === 1 ? "" : "s"} in this file ${summary.scripts === 1 ? "is" : "are"} never executed. Anything they do at runtime isn't shown.`);
  }
  if (animations.some((a) => a.kind === "curves")) ctx.warnings.push("Curve animations were found; only keyframe animations can be played.");

  const support: SupportEntry[] = [...supportCounts.entries()]
    .map(([className, n]) => ({ className, count: n, ...classSupport(className) }))
    .sort((a, b) => b.count - a.count);

  return {
    v: ROBLOX_MANIFEST_VERSION,
    format: doc.format,
    nodes,
    classCounts,
    summary,
    capabilities,
    animations,
    rigs,
    resources: [...ctx.resources.values()],
    support,
    warnings: ctx.warnings.slice(0, 50),
  };
}

export function manifestMeta(m: RobloxManifest): RobloxFileMeta {
  return {
    manifestVersion: m.v,
    format: m.format,
    instanceCount: m.nodes.length,
    summary: m.summary,
    capabilities: m.capabilities,
    animationCount: m.animations.filter((a) => a.kind === "keyframes" && a.keyframes > 0).length,
    rigCount: m.rigs.length,
    externalResources: m.resources.filter((r) => r.affectsPreview).length,
    unsupportedClasses: m.support.filter((s) => s.level === "unsupported").map((s) => s.className),
    primary: primaryKind(m),
  };
}
