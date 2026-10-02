/**
 * Minimal writer for the Roblox binary model format (version 0). Used to generate
 * demo/test files and round-trip tests; chunks are written uncompressed, which the
 * format allows (compressed length 0).
 */
import type { CFrame12, RbxValue } from "./model";

export interface WriteInstance {
  className: string;
  props: Record<string, RbxValue>;
  children?: WriteInstance[];
}

const TYPE_IDS: Partial<Record<RbxValue["type"], number>> = {
  String: 0x01,
  BinaryString: 0x01,
  Bool: 0x02,
  Int32: 0x03,
  Float32: 0x04,
  Float64: 0x05,
  UDim: 0x06,
  UDim2: 0x07,
  BrickColor: 0x0b,
  Color3: 0x0c,
  Vector2: 0x0d,
  Vector3: 0x0e,
  CFrame: 0x10,
  Enum: 0x12,
  Ref: 0x13,
  NumberSequence: 0x15,
  ColorSequence: 0x16,
  NumberRange: 0x17,
  Rect: 0x18,
  Color3uint8: 0x1a,
  Int64: 0x1b,
  Font: 0x20,
};

class Bytes {
  private chunks: Uint8Array[] = [];
  length = 0;
  push(bytes: Uint8Array) {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }
  u8(v: number) {
    this.push(Uint8Array.of(v & 255));
  }
  u16(v: number) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v, true);
    this.push(b);
  }
  u32(v: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, true);
    this.push(b);
  }
  i32(v: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, v, true);
    this.push(b);
  }
  f32(v: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, v, true);
    this.push(b);
  }
  f64(v: number) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, true);
    this.push(b);
  }
  string(s: string | Uint8Array) {
    const bytes = typeof s === "string" ? new TextEncoder().encode(s) : s;
    this.u32(bytes.length);
    this.push(bytes);
  }
  concat(): Uint8Array {
    const out = new Uint8Array(this.length);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}

/** Big-endian per value, then byte-interleaved across the array. */
function interleave(values: Uint8Array[], width: number): Uint8Array {
  const out = new Uint8Array(values.length * width);
  values.forEach((v, i) => {
    for (let b = 0; b < width; b++) out[b * values.length + i] = v[b]!;
  });
  return out;
}

const be32 = (u: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, u >>> 0, false);
  return b;
};
const zigzag32 = (n: number) => ((n << 1) ^ (n >> 31)) >>> 0;
const robloxFloatBits = (f: number) => {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, f);
  const u = view.getUint32(0);
  return ((u << 1) | (u >>> 31)) >>> 0;
};

function interleavedI32(values: number[]) {
  return interleave(values.map((v) => be32(zigzag32(v))), 4);
}
function interleavedF32(values: number[]) {
  return interleave(values.map((v) => be32(robloxFloatBits(v))), 4);
}
function interleavedU32(values: number[]) {
  return interleave(values.map((v) => be32(v)), 4);
}
function referents(values: number[]) {
  let last = 0;
  return interleavedI32(
    values.map((v) => {
      const delta = v - last;
      last = v;
      return delta;
    }),
  );
}

function defaultFor(type: RbxValue["type"]): RbxValue {
  switch (type) {
    case "String":
      return { type, value: "" };
    case "BinaryString":
      return { type, value: new Uint8Array() };
    case "Bool":
      return { type, value: false };
    case "CFrame":
      return { type, value: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] };
    case "Vector3":
    case "Color3":
    case "Color3uint8":
      return { type, value: [0, 0, 0] } as RbxValue;
    case "Vector2":
    case "NumberRange":
    case "UDim":
      return { type, value: [0, 0] } as RbxValue;
    case "UDim2":
    case "Rect":
      return { type, value: [0, 0, 0, 0] } as RbxValue;
    case "Font":
      return { type, value: { family: "rbxasset://fonts/families/SourceSansPro.json", weight: 400, style: "Normal", cachedFaceId: "" } };
    case "NumberSequence":
      return { type, value: [[0, 0, 0], [1, 0, 0]] };
    case "ColorSequence":
      return { type, value: [[0, 1, 1, 1, 0], [1, 1, 1, 1, 0]] };
    case "Ref":
      return { type, value: null };
    default:
      return { type, value: 0 } as RbxValue;
  }
}

function encodeValues(type: RbxValue["type"], values: RbxValue[], refIndex: Map<string, number>): Uint8Array {
  const out = new Bytes();
  const v = values as Array<Extract<RbxValue, { type: typeof type }>>;
  switch (type) {
    case "String":
      for (const x of v as Array<Extract<RbxValue, { type: "String" }>>) out.string(x.bytes ?? x.value);
      break;
    case "BinaryString":
      for (const x of v as Array<Extract<RbxValue, { type: "BinaryString" }>>) out.string(x.value);
      break;
    case "Bool":
      for (const x of v as Array<Extract<RbxValue, { type: "Bool" }>>) out.u8(x.value ? 1 : 0);
      break;
    case "Int32":
      out.push(interleavedI32((v as Array<Extract<RbxValue, { type: "Int32" }>>).map((x) => x.value)));
      break;
    case "Float32":
      out.push(interleavedF32((v as Array<Extract<RbxValue, { type: "Float32" }>>).map((x) => x.value)));
      break;
    case "Float64":
      for (const x of v as Array<Extract<RbxValue, { type: "Float64" }>>) out.f64(x.value);
      break;
    case "BrickColor":
    case "Enum":
      out.push(interleavedU32((v as Array<{ value: number }>).map((x) => x.value)));
      break;
    case "Color3":
    case "Vector3": {
      const xs = v as Array<{ value: number[] }>;
      for (let c = 0; c < 3; c++) out.push(interleavedF32(xs.map((x) => x.value[c]!)));
      break;
    }
    case "Vector2": {
      const xs = v as Array<{ value: number[] }>;
      for (let c = 0; c < 2; c++) out.push(interleavedF32(xs.map((x) => x.value[c]!)));
      break;
    }
    case "Color3uint8": {
      const xs = v as Array<{ value: number[] }>;
      for (let c = 0; c < 3; c++) out.push(Uint8Array.from(xs.map((x) => x.value[c]!)));
      break;
    }
    case "CFrame": {
      const xs = v as Array<{ value: CFrame12 }>;
      for (const x of xs) {
        out.u8(0);
        for (let k = 3; k < 12; k++) out.f32(x.value[k]!);
      }
      for (let c = 0; c < 3; c++) out.push(interleavedF32(xs.map((x) => x.value[c]!)));
      break;
    }
    case "Ref":
      out.push(referents((v as Array<{ value: string | null }>).map((x) => (x.value === null ? -1 : (refIndex.get(x.value) ?? -1)))));
      break;
    case "NumberSequence":
      for (const x of v as Array<{ value: number[][] }>) {
        out.u32(x.value.length);
        for (const k of x.value) for (const n of k) out.f32(n);
      }
      break;
    case "ColorSequence":
      for (const x of v as Array<{ value: number[][] }>) {
        out.u32(x.value.length);
        for (const k of x.value) for (const n of k) out.f32(n);
      }
      break;
    case "NumberRange":
      for (const x of v as Array<{ value: number[] }>) {
        out.f32(x.value[0]!);
        out.f32(x.value[1]!);
      }
      break;
    case "UDim": {
      const xs = v as Array<{ value: number[] }>;
      out.push(interleavedF32(xs.map((x) => x.value[0]!)));
      out.push(interleavedI32(xs.map((x) => x.value[1]!)));
      break;
    }
    case "UDim2": {
      // Stored as xScale, yScale, xOffset, yOffset (each interleaved).
      const xs = v as Array<{ value: number[] }>;
      out.push(interleavedF32(xs.map((x) => x.value[0]!)));
      out.push(interleavedF32(xs.map((x) => x.value[2]!)));
      out.push(interleavedI32(xs.map((x) => x.value[1]!)));
      out.push(interleavedI32(xs.map((x) => x.value[3]!)));
      break;
    }
    case "Rect": {
      const xs = v as Array<{ value: number[] }>;
      for (let c = 0; c < 4; c++) out.push(interleavedF32(xs.map((x) => x.value[c]!)));
      break;
    }
    case "Font":
      for (const x of v as Array<Extract<RbxValue, { type: "Font" }>>) {
        out.string(x.value.family);
        out.u16(x.value.weight);
        out.u8(x.value.style === "Italic" ? 1 : 0);
        out.string(x.value.cachedFaceId);
      }
      break;
    case "Int64": {
      const bytes = (v as Array<{ value: number }>).map((x) => {
        const n = BigInt(Math.trunc(x.value));
        let z = BigInt.asUintN(64, (n << 1n) ^ (n >> 63n));
        const b = new Uint8Array(8);
        for (let i = 7; i >= 0; i--) {
          b[i] = Number(z & 255n);
          z >>= 8n;
        }
        return b;
      });
      out.push(interleave(bytes, 8));
      break;
    }
    default:
      throw new Error(`The writer doesn't support ${type}.`);
  }
  return out.concat();
}

function chunk(out: Bytes, name: string, data: Uint8Array) {
  const nameBytes = new Uint8Array(4);
  nameBytes.set(new TextEncoder().encode(name).subarray(0, 4));
  out.push(nameBytes);
  out.u32(0); // uncompressed
  out.u32(data.length);
  out.u32(0);
  out.push(data);
}

/** Serialises a tree of instances to a binary .rbxm file. `Ref` values name other instances by `props.__id`. */
export function writeBinaryModel(roots: WriteInstance[]): Uint8Array {
  const ordered: WriteInstance[] = [];
  const parentOf = new Map<WriteInstance, WriteInstance | null>();
  const visit = (inst: WriteInstance, parent: WriteInstance | null) => {
    ordered.push(inst);
    parentOf.set(inst, parent);
    for (const c of inst.children ?? []) visit(c, inst);
  };
  roots.forEach((r) => visit(r, null));
  const refOf = new Map(ordered.map((inst, i) => [inst, i]));
  // Ref values use a caller-chosen id stored in the "__id" string property.
  const refIndex = new Map<string, number>();
  ordered.forEach((inst, i) => {
    const id = inst.props.__id;
    if (id?.type === "String") refIndex.set(id.value, i);
  });

  const classNames = [...new Set(ordered.map((i) => i.className))].sort();
  const body = new Bytes();

  const meta = new Bytes();
  meta.u32(1);
  meta.string("ExplicitAutoJoints");
  meta.string("true");
  chunk(body, "META", meta.concat());

  classNames.forEach((className, classId) => {
    const members = ordered.filter((i) => i.className === className);
    const inst = new Bytes();
    inst.u32(classId);
    inst.string(className);
    inst.u8(0);
    inst.u32(members.length);
    inst.push(referents(members.map((m) => refOf.get(m)!)));
    chunk(body, "INST", inst.concat());
  });

  classNames.forEach((className, classId) => {
    const members = ordered.filter((i) => i.className === className);
    const propTypes = new Map<string, RbxValue["type"]>();
    for (const m of members) {
      for (const [name, value] of Object.entries(m.props)) {
        if (name === "__id") continue;
        if (!propTypes.has(name)) propTypes.set(name, value.type);
      }
    }
    if (!propTypes.has("Name")) propTypes.set("Name", "String");
    for (const [name, type] of propTypes) {
      const typeId = TYPE_IDS[type];
      if (typeId === undefined) throw new Error(`The writer doesn't support ${type}.`);
      const values = members.map((m) => {
        const value = m.props[name];
        if (value && value.type === type) return value;
        if (name === "Name") return { type: "String", value: className } as RbxValue;
        return defaultFor(type);
      });
      const prop = new Bytes();
      prop.u32(classId);
      prop.string(name);
      prop.u8(typeId);
      prop.push(encodeValues(type, values, refIndex));
      chunk(body, "PROP", prop.concat());
    }
  });

  // Studio writes PRNT depth-first post-order (children before their parent).
  const post: WriteInstance[] = [];
  const postVisit = (inst: WriteInstance) => {
    for (const c of inst.children ?? []) postVisit(c);
    post.push(inst);
  };
  roots.forEach(postVisit);
  const prnt = new Bytes();
  prnt.u8(0);
  prnt.u32(post.length);
  prnt.push(referents(post.map((i) => refOf.get(i)!)));
  prnt.push(referents(post.map((i) => (parentOf.get(i) ? refOf.get(parentOf.get(i)!)! : -1))));
  chunk(body, "PRNT", prnt.concat());

  const end = new Bytes();
  end.push(new TextEncoder().encode("</roblox>"));
  chunk(body, "END", end.concat());

  const header = new Bytes();
  header.push(new TextEncoder().encode("<roblox!"));
  header.push(Uint8Array.of(0x89, 0xff, 0x0d, 0x0a, 0x1a, 0x0a));
  header.u16(0);
  header.i32(classNames.length);
  header.i32(ordered.length);
  header.push(new Uint8Array(8));
  header.push(body.concat());
  return header.concat();
}

/** Encodes numeric/string/bool attributes into an AttributesSerialize blob. */
export function encodeAttributes(attrs: Record<string, number | string | boolean>): Uint8Array {
  const out = new Bytes();
  const entries = Object.entries(attrs);
  out.u32(entries.length);
  for (const [name, value] of entries) {
    out.string(name);
    if (typeof value === "number") {
      out.u8(0x06);
      out.f64(value);
    } else if (typeof value === "boolean") {
      out.u8(0x03);
      out.u8(value ? 1 : 0);
    } else {
      out.u8(0x02);
      out.string(value);
    }
  }
  return out.concat();
}

// ── Small builders for readable fixtures ────────────────────────────────────
export const R = {
  str: (value: string): RbxValue => ({ type: "String", value }),
  bin: (value: Uint8Array): RbxValue => ({ type: "BinaryString", value }),
  bool: (value: boolean): RbxValue => ({ type: "Bool", value }),
  int: (value: number): RbxValue => ({ type: "Int32", value }),
  f32: (value: number): RbxValue => ({ type: "Float32", value }),
  f64: (value: number): RbxValue => ({ type: "Float64", value }),
  enum: (value: number): RbxValue => ({ type: "Enum", value }),
  v3: (x: number, y: number, z: number): RbxValue => ({ type: "Vector3", value: [x, y, z] }),
  v2: (x: number, y: number): RbxValue => ({ type: "Vector2", value: [x, y] }),
  rgb: (r: number, g: number, b: number): RbxValue => ({ type: "Color3uint8", value: [r, g, b] }),
  color: (r: number, g: number, b: number): RbxValue => ({ type: "Color3", value: [r, g, b] }),
  range: (min: number, max = min): RbxValue => ({ type: "NumberRange", value: [min, max] }),
  ref: (id: string | null): RbxValue => ({ type: "Ref", value: id }),
  numSeq: (...kps: Array<[number, number, number?]>): RbxValue => ({ type: "NumberSequence", value: kps.map(([t, v, e]) => [t, v, e ?? 0]) }),
  colorSeq: (...kps: Array<[number, number, number, number]>): RbxValue => ({ type: "ColorSequence", value: kps.map(([t, r, g, b]) => [t, r, g, b, 0]) }),
  udim: (scale: number, offset: number): RbxValue => ({ type: "UDim", value: [scale, offset] }),
  udim2: (xScale: number, xOffset: number, yScale: number, yOffset: number): RbxValue => ({ type: "UDim2", value: [xScale, xOffset, yScale, yOffset] }),
  rect: (minX: number, minY: number, maxX: number, maxY: number): RbxValue => ({ type: "Rect", value: [minX, minY, maxX, maxY] }),
  /** A FontFace, e.g. R.font("GothamSSm", 700) → rbxasset://fonts/families/GothamSSm.json. */
  font: (family: string, weight = 400, style: "Normal" | "Italic" = "Normal"): RbxValue => ({
    type: "Font",
    value: { family: family.includes("://") ? family : `rbxasset://fonts/families/${family}.json`, weight, style, cachedFaceId: "" },
  }),
  cf: (x: number, y: number, z: number, rot: number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1]): RbxValue => ({ type: "CFrame", value: [x, y, z, ...rot] as CFrame12 }),
  /** CFrame from position + XYZ Euler angles in degrees (like CFrame.Angles, applied X then Y then Z). */
  cfa: (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): RbxValue => {
    const [a, b, c] = [rx, ry, rz].map((d) => (d * Math.PI) / 180) as [number, number, number];
    const cx = Math.cos(a), sx = Math.sin(a), cy = Math.cos(b), sy = Math.sin(b), cz = Math.cos(c), sz = Math.sin(c);
    // R = Rx * Ry * Rz
    const m = [
      cy * cz, -cy * sz, sy,
      cx * sz + sx * sy * cz, cx * cz - sx * sy * sz, -sx * cy,
      sx * sz - cx * sy * cz, sx * cz + cx * sy * sz, cx * cy,
    ];
    return { type: "CFrame", value: [x, y, z, ...m] as CFrame12 };
  },
};
