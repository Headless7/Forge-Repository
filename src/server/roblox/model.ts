/**
 * In-memory representation of a Roblox model/place file (.rbxm / .rbxmx / .rbxl / .rbxlx).
 * Both the binary and the XML readers produce this shape, so everything downstream
 * (validation, the preview manifest) is format-independent.
 *
 * Nothing here is ever executed: scripts are data like any other property.
 */

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
/** x, y, z, R00, R01, R02, R10, R11, R12, R20, R21, R22 (row-major rotation). */
export type CFrame12 = [number, number, number, number, number, number, number, number, number, number, number, number];

export type RbxValue =
  | { type: "String"; value: string; /** Raw bytes (binary files store binary blobs as String). */ bytes?: Uint8Array }
  | { type: "BinaryString"; value: Uint8Array }
  | { type: "Bool"; value: boolean }
  | { type: "Int32"; value: number }
  | { type: "Int64"; value: number }
  | { type: "Float32"; value: number }
  | { type: "Float64"; value: number }
  | { type: "UDim"; value: [scale: number, offset: number] }
  | { type: "UDim2"; value: [xScale: number, xOffset: number, yScale: number, yOffset: number] }
  | { type: "Ray"; value: [ox: number, oy: number, oz: number, dx: number, dy: number, dz: number] }
  | { type: "Faces"; value: number }
  | { type: "Axes"; value: number }
  | { type: "BrickColor"; value: number }
  | { type: "Color3"; value: Vec3 }
  | { type: "Color3uint8"; value: Vec3 }
  | { type: "Vector2"; value: Vec2 }
  | { type: "Vector3"; value: Vec3 }
  | { type: "Vector2int16"; value: Vec2 }
  | { type: "Vector3int16"; value: Vec3 }
  | { type: "CFrame"; value: CFrame12 }
  | { type: "OptionalCFrame"; value: CFrame12 | null }
  | { type: "Enum"; value: number }
  | { type: "Ref"; value: string | null }
  | { type: "NumberSequence"; value: Array<[time: number, value: number, envelope: number]> }
  | { type: "ColorSequence"; value: Array<[time: number, r: number, g: number, b: number, envelope: number]> }
  | { type: "NumberRange"; value: Vec2 }
  | { type: "Rect"; value: [minX: number, minY: number, maxX: number, maxY: number] }
  | { type: "PhysicalProperties"; value: number[] | null }
  | { type: "SharedString"; value: Uint8Array }
  | { type: "Font"; value: { family: string; weight: number; style: string; cachedFaceId: string } }
  | { type: "UniqueId"; value: string }
  | { type: "SecurityCapabilities"; value: string }
  | { type: "Content"; value: string | null }
  | { type: "Unknown"; value: string };

export interface RbxInstance {
  /** Referent: an opaque id that is unique within the file. */
  ref: string;
  className: string;
  name: string;
  parent: RbxInstance | null;
  children: RbxInstance[];
  props: Map<string, RbxValue>;
}

export interface RbxDocument {
  format: "binary" | "xml";
  roots: RbxInstance[];
  /** Every instance in document order. */
  instances: RbxInstance[];
  byRef: Map<string, RbxInstance>;
  meta: Record<string, string>;
  /** Non-fatal oddities encountered while reading (unknown types, dangling refs …). */
  warnings: string[];
}

export class RobloxParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RobloxParseError";
  }
}

/** Hard ceilings so a hostile file can't exhaust memory or CPU. */
export const PARSE_LIMITS = {
  maxInstances: 250_000,
  maxDecompressedBytes: 512 * 1024 * 1024,
  maxChunkBytes: 256 * 1024 * 1024,
  maxXmlDepth: 512,
};

export function finalizeDocument(format: RbxDocument["format"], instances: RbxInstance[], meta: Record<string, string>, warnings: string[]): RbxDocument {
  const byRef = new Map<string, RbxInstance>();
  for (const inst of instances) byRef.set(inst.ref, inst);
  // A crafted file could declare a parent cycle; cut it so every traversal terminates.
  for (const inst of instances) {
    const seen = new Set<RbxInstance>([inst]);
    for (let p = inst.parent; p; p = p.parent) {
      if (seen.has(p)) {
        warnings.push(`Parent cycle at ${inst.className}; detached.`);
        const parent = inst.parent!;
        parent.children = parent.children.filter((c) => c !== inst);
        inst.parent = null;
        break;
      }
      seen.add(p);
    }
  }
  for (const inst of instances) {
    const name = inst.props.get("Name");
    inst.name = name?.type === "String" ? name.value : inst.className;
  }
  return { format, roots: instances.filter((i) => !i.parent), instances, byRef, meta, warnings };
}
