import { decompress as zstdDecompress } from "fzstd";
import { lz4DecompressBlock } from "./lz4";
import {
  finalizeDocument,
  PARSE_LIMITS,
  RobloxParseError,
  type CFrame12,
  type RbxDocument,
  type RbxInstance,
  type RbxValue,
  type Vec3,
} from "./model";

/**
 * Reader for the Roblox binary model format (version 0), following the rbx-dom
 * specification: https://github.com/rojo-rbx/rbx-dom/blob/master/docs/binary.md
 */

const MAGIC = "<roblox!";
const SIGNATURE = [0x89, 0xff, 0x0d, 0x0a, 0x1a, 0x0a];

export function isBinaryRoblox(head: Uint8Array): boolean {
  if (head.length < 14) return false;
  for (let i = 0; i < MAGIC.length; i++) if (head[i] !== MAGIC.charCodeAt(i)) return false;
  return SIGNATURE.every((b, i) => head[8 + i] === b);
}

class Reader {
  pos = 0;
  private view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  private need(n: number) {
    if (n < 0 || this.pos + n > this.bytes.length) throw new RobloxParseError("Unexpected end of data.");
  }
  remaining() {
    return this.bytes.length - this.pos;
  }
  u8() {
    this.need(1);
    return this.bytes[this.pos++]!;
  }
  u16() {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  i16() {
    this.need(2);
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32() {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  i32() {
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f32() {
    this.need(4);
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f64() {
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
  bytesN(n: number) {
    this.need(n);
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  string() {
    const len = this.u32();
    return decoder.decode(this.bytesN(len));
  }
  rawString() {
    const len = this.u32();
    return this.bytesN(len);
  }
  /** Reads `count` values of `width` bytes stored column-wise; returns them row-wise (big-endian per value). */
  interleaved(count: number, width: number): Uint8Array {
    const src = this.bytesN(count * width);
    const out = new Uint8Array(count * width);
    for (let i = 0; i < count; i++) for (let b = 0; b < width; b++) out[i * width + b] = src[b * count + i]!;
    return out;
  }
  interleavedU32(count: number): number[] {
    const raw = this.interleaved(count, 4);
    const out = new Array<number>(count);
    for (let i = 0; i < count; i++) {
      const o = i * 4;
      out[i] = ((raw[o]! << 24) | (raw[o + 1]! << 16) | (raw[o + 2]! << 8) | raw[o + 3]!) >>> 0;
    }
    return out;
  }
  interleavedI32(count: number): number[] {
    return this.interleavedU32(count).map(untransformI32);
  }
  interleavedF32(count: number): number[] {
    return this.interleavedU32(count).map(robloxFloat);
  }
  interleavedI64(count: number): number[] {
    const raw = this.interleaved(count, 8);
    const out = new Array<number>(count);
    for (let i = 0; i < count; i++) {
      let v = 0n;
      for (let b = 0; b < 8; b++) v = (v << 8n) | BigInt(raw[i * 8 + b]!);
      const signed = (v >> 1n) ^ -(v & 1n);
      out[i] = Number(signed);
    }
    return out;
  }
  referents(count: number): number[] {
    const values = this.interleavedI32(count);
    let last = 0;
    for (let i = 0; i < count; i++) {
      last += values[i]!;
      values[i] = last;
    }
    return values;
  }
}

const decoder = new TextDecoder("utf-8", { fatal: false });
const scratch = new DataView(new ArrayBuffer(4));

function untransformI32(u: number): number {
  return (u >>> 1) ^ -(u & 1);
}

/** Roblox stores the sign bit last: eeeeeeee mmmmmmmm mmmmmmmm mmmmmmms. */
function robloxFloat(u: number): number {
  const standard = ((u >>> 1) | ((u & 1) << 31)) >>> 0;
  scratch.setUint32(0, standard);
  return scratch.getFloat32(0);
}

const NORMALS: Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  [-1, 0, 0],
  [0, -1, 0],
  [0, 0, -1],
];

/** Special-cased axis-aligned rotations: id-1 = 6·(column 0 normal) + (column 1 normal). */
function basicRotation(id: number): number[] | null {
  const n = id - 1;
  const x = NORMALS[Math.floor(n / 6)];
  const y = NORMALS[n % 6];
  if (!x || !y || n < 0 || n >= 36) return null;
  const z: Vec3 = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  if (z[0] === 0 && z[1] === 0 && z[2] === 0) return null;
  // Columns are x, y, z → row-major R00 R01 R02 / R10 R11 R12 / R20 R21 R22.
  return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
}

function readCFrames(r: Reader, count: number): CFrame12[] {
  const rotations: number[][] = [];
  for (let i = 0; i < count; i++) {
    const id = r.u8();
    if (id === 0) {
      const m: number[] = [];
      for (let k = 0; k < 9; k++) m.push(r.f32());
      rotations.push(m);
    } else {
      const m = basicRotation(id);
      if (!m) throw new RobloxParseError(`Unknown CFrame rotation id ${id}.`);
      rotations.push(m);
    }
  }
  const xs = r.interleavedF32(count);
  const ys = r.interleavedF32(count);
  const zs = r.interleavedF32(count);
  return rotations.map((m, i) => [xs[i]!, ys[i]!, zs[i]!, ...m] as CFrame12);
}

function readValues(r: Reader, typeId: number, count: number, sharedStrings: Uint8Array[]): RbxValue[] | null {
  const out: RbxValue[] = [];
  switch (typeId) {
    case 0x01: // String
      for (let i = 0; i < count; i++) {
        const raw = r.rawString();
        out.push({ type: "String", value: decoder.decode(raw), bytes: raw.slice() });
      }
      return out;
    case 0x02:
      for (let i = 0; i < count; i++) out.push({ type: "Bool", value: r.u8() !== 0 });
      return out;
    case 0x03:
      return r.interleavedI32(count).map((value) => ({ type: "Int32", value }));
    case 0x04:
      return r.interleavedF32(count).map((value) => ({ type: "Float32", value }));
    case 0x05:
      for (let i = 0; i < count; i++) out.push({ type: "Float64", value: r.f64() });
      return out;
    case 0x06: {
      const s = r.interleavedF32(count);
      const o = r.interleavedI32(count);
      return s.map((scale, i) => ({ type: "UDim", value: [scale, o[i]!] }));
    }
    case 0x07: {
      const xs = r.interleavedF32(count);
      const ys = r.interleavedF32(count);
      const xo = r.interleavedI32(count);
      const yo = r.interleavedI32(count);
      return xs.map((x, i) => ({ type: "UDim2", value: [x, xo[i]!, ys[i]!, yo[i]!] }));
    }
    case 0x08:
      for (let i = 0; i < count; i++) out.push({ type: "Ray", value: [r.f32(), r.f32(), r.f32(), r.f32(), r.f32(), r.f32()] });
      return out;
    case 0x09:
      for (let i = 0; i < count; i++) out.push({ type: "Faces", value: r.u8() });
      return out;
    case 0x0a:
      for (let i = 0; i < count; i++) out.push({ type: "Axes", value: r.u8() });
      return out;
    case 0x0b:
      return r.interleavedU32(count).map((value) => ({ type: "BrickColor", value }));
    case 0x0c: {
      const rs = r.interleavedF32(count);
      const gs = r.interleavedF32(count);
      const bs = r.interleavedF32(count);
      return rs.map((red, i) => ({ type: "Color3", value: [red, gs[i]!, bs[i]!] }));
    }
    case 0x0d: {
      const xs = r.interleavedF32(count);
      const ys = r.interleavedF32(count);
      return xs.map((x, i) => ({ type: "Vector2", value: [x, ys[i]!] }));
    }
    case 0x0e: {
      const xs = r.interleavedF32(count);
      const ys = r.interleavedF32(count);
      const zs = r.interleavedF32(count);
      return xs.map((x, i) => ({ type: "Vector3", value: [x, ys[i]!, zs[i]!] }));
    }
    case 0x0f:
      for (let i = 0; i < count; i++) out.push({ type: "Vector2int16", value: [r.i16(), r.i16()] });
      return out;
    case 0x10:
      return readCFrames(r, count).map((value) => ({ type: "CFrame", value }));
    case 0x12:
      return r.interleavedU32(count).map((value) => ({ type: "Enum", value }));
    case 0x13:
      return r.referents(count).map((ref) => ({ type: "Ref", value: ref === -1 ? null : String(ref) }));
    case 0x14:
      for (let i = 0; i < count; i++) out.push({ type: "Vector3int16", value: [r.i16(), r.i16(), r.i16()] });
      return out;
    case 0x15:
      for (let i = 0; i < count; i++) {
        const n = r.u32();
        if (n > 1024) throw new RobloxParseError("NumberSequence has too many keypoints.");
        const kps: Array<[number, number, number]> = [];
        for (let k = 0; k < n; k++) kps.push([r.f32(), r.f32(), r.f32()]);
        out.push({ type: "NumberSequence", value: kps });
      }
      return out;
    case 0x16:
      for (let i = 0; i < count; i++) {
        const n = r.u32();
        if (n > 1024) throw new RobloxParseError("ColorSequence has too many keypoints.");
        const kps: Array<[number, number, number, number, number]> = [];
        for (let k = 0; k < n; k++) kps.push([r.f32(), r.f32(), r.f32(), r.f32(), r.f32()]);
        out.push({ type: "ColorSequence", value: kps });
      }
      return out;
    case 0x17:
      for (let i = 0; i < count; i++) out.push({ type: "NumberRange", value: [r.f32(), r.f32()] });
      return out;
    case 0x18: {
      const a = r.interleavedF32(count);
      const b = r.interleavedF32(count);
      const c = r.interleavedF32(count);
      const d = r.interleavedF32(count);
      return a.map((x, i) => ({ type: "Rect", value: [x, b[i]!, c[i]!, d[i]!] }));
    }
    case 0x19:
      for (let i = 0; i < count; i++) {
        const flags = r.u8();
        if (flags & 1) {
          const values = [r.f32(), r.f32(), r.f32(), r.f32(), r.f32()];
          values.push(flags & 2 ? r.f32() : 1);
          out.push({ type: "PhysicalProperties", value: values });
        } else {
          out.push({ type: "PhysicalProperties", value: null });
        }
      }
      return out;
    case 0x1a: {
      const rs = r.bytesN(count);
      const gs = r.bytesN(count);
      const bs = r.bytesN(count);
      for (let i = 0; i < count; i++) out.push({ type: "Color3uint8", value: [rs[i]!, gs[i]!, bs[i]!] });
      return out;
    }
    case 0x1b:
      return r.interleavedI64(count).map((value) => ({ type: "Int64", value }));
    case 0x1c:
      return r.interleavedU32(count).map((index) => ({ type: "SharedString", value: sharedStrings[index] ?? new Uint8Array() }));
    case 0x1d:
      for (let i = 0; i < count; i++) {
        r.rawString();
        // Precompiled bytecode is never interpreted; keep only the fact that it exists.
        out.push({ type: "Unknown", value: "Bytecode" });
      }
      return out;
    case 0x1e: {
      if (r.u8() !== 0x10) throw new RobloxParseError("Malformed OptionalCoordinateFrame.");
      const frames = readCFrames(r, count);
      if (r.u8() !== 0x02) throw new RobloxParseError("Malformed OptionalCoordinateFrame.");
      for (let i = 0; i < count; i++) out.push({ type: "OptionalCFrame", value: r.u8() ? frames[i]! : null });
      return out;
    }
    case 0x1f: {
      const raw = r.interleaved(count, 16);
      for (let i = 0; i < count; i++) {
        let hex = "";
        for (let b = 0; b < 16; b++) hex += raw[i * 16 + b]!.toString(16).padStart(2, "0");
        out.push({ type: "UniqueId", value: hex });
      }
      return out;
    }
    case 0x20:
      for (let i = 0; i < count; i++) {
        const family = r.string();
        const weight = r.u16();
        const style = r.u8();
        const cachedFaceId = r.string();
        out.push({ type: "Font", value: { family, weight, style: style === 1 ? "Italic" : "Normal", cachedFaceId } });
      }
      return out;
    case 0x21: {
      const raw = r.interleaved(count, 8);
      for (let i = 0; i < count; i++) {
        let v = 0n;
        for (let b = 0; b < 8; b++) v = (v << 8n) | BigInt(raw[i * 8 + b]!);
        out.push({ type: "SecurityCapabilities", value: ((v >> 1n) ^ -(v & 1n)).toString() });
      }
      return out;
    }
    case 0x22: {
      const sourceTypes = r.interleavedI32(count);
      const uriCount = r.u32();
      const uris: string[] = [];
      for (let i = 0; i < uriCount; i++) uris.push(r.string());
      const objectCount = r.u32();
      if (objectCount) r.referents(objectCount);
      const externalCount = r.u32();
      if (externalCount) r.referents(externalCount);
      let u = 0;
      for (let i = 0; i < count; i++) {
        const t = sourceTypes[i];
        out.push({ type: "Content", value: t === 1 ? (uris[u++] ?? null) : null });
      }
      return out;
    }
    default:
      return null;
  }
}

function decompressChunk(name: string, payload: Uint8Array, compressedLength: number, uncompressedLength: number): Uint8Array {
  if (uncompressedLength > PARSE_LIMITS.maxChunkBytes) throw new RobloxParseError(`Chunk ${name} is too large.`);
  if (compressedLength === 0) return payload;
  if (payload[0] === 0x28 && payload[1] === 0xb5 && payload[2] === 0x2f && payload[3] === 0xfd) {
    const out = zstdDecompress(payload, new Uint8Array(uncompressedLength));
    if (out.length !== uncompressedLength) throw new RobloxParseError(`Corrupt ZSTD chunk ${name}.`);
    return out;
  }
  return lz4DecompressBlock(payload, uncompressedLength);
}

export function parseBinaryRoblox(bytes: Uint8Array): RbxDocument {
  if (!isBinaryRoblox(bytes)) throw new RobloxParseError("Not a binary Roblox file.");
  const head = new Reader(bytes);
  head.pos = 14;
  const version = head.u16();
  if (version !== 0) throw new RobloxParseError(`Unsupported binary format version ${version}.`);
  const classCount = head.i32();
  const instanceCount = head.i32();
  head.bytesN(8);
  if (instanceCount < 0 || instanceCount > PARSE_LIMITS.maxInstances || classCount < 0 || classCount > 100_000) {
    throw new RobloxParseError("This file declares more instances than the preview supports.");
  }

  const warnings: string[] = [];
  const meta: Record<string, string> = {};
  const classes = new Map<number, { className: string; refs: number[] }>();
  const byRef = new Map<number, RbxInstance>();
  const ordered: RbxInstance[] = [];
  let sharedStrings: Uint8Array[] = [];
  let parents: Array<[child: number, parent: number]> = [];
  let total = 0;
  let sawEnd = false;

  while (head.remaining() > 0) {
    const nameBytes = head.bytesN(4);
    let name = "";
    for (const b of nameBytes) if (b) name += String.fromCharCode(b);
    const compressedLength = head.u32();
    const uncompressedLength = head.u32();
    head.u32();
    const payload = head.bytesN(compressedLength || uncompressedLength);
    total += uncompressedLength;
    if (total > PARSE_LIMITS.maxDecompressedBytes) throw new RobloxParseError("This file expands to more data than the preview supports.");
    if (name === "END") {
      sawEnd = true;
      break;
    }
    const r = new Reader(decompressChunk(name, payload, compressedLength, uncompressedLength));

    switch (name) {
      case "META": {
        const n = r.u32();
        for (let i = 0; i < n; i++) meta[r.string()] = r.string();
        break;
      }
      case "SSTR": {
        r.u32();
        const n = r.u32();
        sharedStrings = [];
        for (let i = 0; i < n; i++) {
          r.bytesN(16);
          sharedStrings.push(r.rawString().slice());
        }
        break;
      }
      case "INST": {
        const classId = r.u32();
        const className = r.string();
        r.u8();
        const n = r.u32();
        if (ordered.length + n > PARSE_LIMITS.maxInstances) throw new RobloxParseError("Too many instances.");
        const refs = r.referents(n);
        classes.set(classId, { className, refs });
        for (const ref of refs) {
          const inst: RbxInstance = { ref: String(ref), className, name: className, parent: null, children: [], props: new Map() };
          byRef.set(ref, inst);
          ordered.push(inst);
        }
        break;
      }
      case "PROP": {
        const classId = r.u32();
        const propName = r.string();
        const typeId = r.u8();
        const cls = classes.get(classId);
        if (!cls) {
          warnings.push(`Property ${propName} refers to an unknown class.`);
          break;
        }
        let values: RbxValue[] | null;
        try {
          values = readValues(r, typeId, cls.refs.length, sharedStrings);
        } catch (error) {
          if (error instanceof RobloxParseError) {
            warnings.push(`Couldn't read ${cls.className}.${propName}: ${error.message}`);
            break;
          }
          throw error;
        }
        if (!values) {
          warnings.push(`${cls.className}.${propName} uses an unknown data type (0x${typeId.toString(16)}).`);
          break;
        }
        cls.refs.forEach((ref, i) => byRef.get(ref)?.props.set(propName, values![i]!));
        break;
      }
      case "PRNT": {
        r.u8();
        const n = r.u32();
        const children = r.referents(n);
        const parentRefs = r.referents(n);
        parents = children.map((c, i) => [c, parentRefs[i]!]);
        break;
      }
      default:
        // Unknown chunks (e.g. SIGN) are skipped by design.
        break;
    }
  }
  if (!sawEnd) warnings.push("The file has no END chunk; it may be truncated.");

  for (const [childRef, parentRef] of parents) {
    const child = byRef.get(childRef);
    if (!child) continue;
    if (parentRef === -1) continue;
    const parent = byRef.get(parentRef);
    if (!parent || parent === child) {
      warnings.push(`Instance ${child.className} has a missing parent.`);
      continue;
    }
    child.parent = parent;
    parent.children.push(child);
  }
  return finalizeDocument("binary", ordered, meta, warnings);
}
