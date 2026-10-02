/**
 * The preview manifest: a JSON description of a Roblox file that the in-app viewer
 * renders. It is derived on the server from the original upload (which is never
 * modified) and stored next to it, tagged with the parser version that made it.
 */

/** 2: adds 2D UI (ScreenGui/SurfaceGui/BillboardGui contents). 3: rigs include Bone skeletons (skinned meshes). */
export const ROBLOX_MANIFEST_VERSION = 3;

export type MValue = number | boolean | string | null | number[] | number[][];

export interface ManifestNode {
  /** Parent node index, or -1 for a root. */
  p: number;
  /** ClassName. */
  c: string;
  /** Name. */
  n: string;
  /** Normalised properties the viewer uses (names are stable across Roblox's renames). */
  r: Record<string, MValue>;
  /** Primitive attribute values (e.g. EmitCount). */
  a?: Record<string, MValue>;
  /** Every serialised property as display text, for the inspector. */
  x: Array<[name: string, value: string]>;
}

export type SupportLevel = "full" | "approximate" | "unsupported" | "data";

export interface SupportEntry {
  className: string;
  count: number;
  level: SupportLevel;
  note: string;
}

export type ResourceKind = "mesh" | "texture" | "animation" | "audio";

export interface ResourceUse {
  /** Normalised content id, e.g. "rbxassetid://123" or "rbxasset://textures/x.png". */
  contentId: string;
  kind: ResourceKind;
  /** Content bundled with the Roblox client (rbxasset://) rather than a user asset. */
  builtin: boolean;
  /** Whether the preview needs this resource to render faithfully. */
  affectsPreview: boolean;
  uses: Array<{ node: number; prop: string }>;
}

export interface AnimationInfo {
  node: number;
  name: string;
  /** Seconds (time of the last keyframe). */
  length: number;
  loop: boolean;
  priority: number;
  keyframes: number;
  /** Joint (Part1) names that have keyed poses. */
  joints: string[];
  markers: Array<{ time: number; name: string }>;
  kind: "keyframes" | "curves";
}

export interface RigJoint {
  /** Motor6D node. */
  node: number;
  part0: number;
  part1: number;
}

export interface RigInfo {
  /** The Model (or container) holding the rig. */
  node: number;
  name: string;
  rigType: "R6" | "R15" | "custom";
  rootPart: number | null;
  joints: RigJoint[];
  /** Bone instances in the rig (they deform skinned MeshParts). Absent in manifests before v3. */
  bones?: number[];
}

export interface ManifestSummary {
  parts: number;
  meshParts: number;
  unions: number;
  animations: number;
  emitters: number;
  beams: number;
  trails: number;
  lights: number;
  legacyEffects: number;
  scripts: number;
  /** ScreenGui / SurfaceGui / BillboardGui containers. */
  guis: number;
  /** Frames, labels, buttons, images… */
  guiObjects: number;
}

export interface RobloxManifest {
  v: number;
  format: "binary" | "xml";
  nodes: ManifestNode[];
  classCounts: Record<string, number>;
  summary: ManifestSummary;
  capabilities: { model: boolean; animation: boolean; effects: boolean; ui: boolean };
  animations: AnimationInfo[];
  rigs: RigInfo[];
  resources: ResourceUse[];
  support: SupportEntry[];
  warnings: string[];
}

/** What the upload pipeline stores on the attachment (small; shown on boards and lists). */
export interface RobloxFileMeta {
  manifestVersion: number;
  format: "binary" | "xml";
  instanceCount: number;
  summary: ManifestSummary;
  capabilities: RobloxManifest["capabilities"];
  animationCount: number;
  rigCount: number;
  /** Resources the preview needs that aren't in the file (before any resolution). */
  externalResources: number;
  unsupportedClasses: string[];
  primary: "model" | "animation" | "effects" | "ui" | "data";
}

export function primaryKind(m: Pick<RobloxManifest, "capabilities" | "summary">): RobloxFileMeta["primary"] {
  if (m.capabilities.animation) return "animation";
  if (m.capabilities.effects) return "effects";
  // A UI file's parts (if any) are usually incidental; its point is the interface.
  if (m.capabilities.ui && m.summary.guiObjects >= m.summary.parts) return "ui";
  if (m.capabilities.model) return "model";
  if (m.capabilities.ui) return "ui";
  return "data";
}
