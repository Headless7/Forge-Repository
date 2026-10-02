/**
 * Parser for Roblox FileMesh files (.mesh), following the community specification
 * (https://devforum.roblox.com/t/roblox-mesh-format/326114). Reads positions, normals, UVs,
 * the highest-detail LOD's triangles and — for skinned meshes (v4+) — the skeleton: bone
 * names, parents and bind CFrames, plus up to four bone weights per vertex.
 *
 * Supported: 1.00, 1.01, 2.00, 3.00, 3.01, 4.00, 4.01, 5.00 and 6.00/7.00 with an
 * uncompressed COREMESH chunk. Draco-compressed COREMESH (v2) is decoded on the server when the
 * mesh is added (src/server/roblox/draco-mesh.ts); the viewer receives that plain copy, which
 * keeps the original SKINNING chunk.
 */

export interface MeshBone {
  name: string;
  /** Index of the parent bone, or -1. */
  parent: number;
  /** Bind CFrame in mesh space (x, y, z, then the 3×3 rotation row by row). */
  cf: number[];
}

export interface MeshSkin {
  bones: MeshBone[];
  /** Four bone indices per vertex (into `bones`). Vertices no bone moves use index `bones.length` (the part itself). */
  indices: Uint16Array;
  /** Four weights per vertex, summing to 1. */
  weights: Float32Array;
  /** Vertices with no bone weight (they stay with the part). */
  unweighted: number;
}

export interface ParsedMesh {
  version: string;
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  skin?: MeshSkin;
  /** Why skinning data present in the file couldn't be used (the mesh is then drawn unskinned). */
  skinError?: string;
}

export class MeshFormatError extends Error {
  constructor(
    message: string,
    readonly code: "unsupported" | "corrupt" = "corrupt",
  ) {
    super(message);
    this.name = "MeshFormatError";
  }
}

const MAX_VERTS = 2_000_000;
const MAX_FACES = 4_000_000;
const MAX_BONES = 4096;
const MAX_SUBSETS = 4096;

function readVersion(bytes: Uint8Array): { version: string; offset: number } {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 16));
  const match = /^version (\d\.\d\d)\r?\n/.exec(head);
  if (!match) throw new MeshFormatError("Not a Roblox mesh file (missing \"version x.xx\" header).");
  return { version: match[1]!, offset: match[0].length };
}

function fromText(text: string, version: string): ParsedMesh {
  const lines = text.split(/\r?\n/);
  const faces = Number(lines[1]);
  if (!Number.isFinite(faces) || faces < 0 || faces > MAX_FACES) throw new MeshFormatError("Invalid face count.");
  const vectors = [...(lines[2] ?? "").matchAll(/\[([^\]]*)\]/g)].map((m) => m[1]!.split(",").map(Number));
  if (vectors.length < faces * 9) throw new MeshFormatError("The mesh ends early.");
  const scale = version === "1.00" ? 0.5 : 1;
  const count = faces * 3;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  for (let v = 0; v < count; v++) {
    const [p, n, t] = [vectors[v * 3]!, vectors[v * 3 + 1]!, vectors[v * 3 + 2]!];
    positions.set([p[0]! * scale, p[1]! * scale, p[2]! * scale], v * 3);
    normals.set([n[0]!, n[1]!, n[2]!], v * 3);
    uvs.set([t[0]!, 1 - t[1]!], v * 2);
  }
  return { version, positions, normals, uvs, indices: Uint32Array.from({ length: count }, (_, i) => i) };
}

class Cursor {
  view: DataView;
  constructor(
    readonly bytes: Uint8Array,
    public pos: number,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  need(n: number) {
    if (n < 0 || this.pos + n > this.bytes.length) throw new MeshFormatError("The mesh ends early.");
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
  u32() {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  take(n: number) {
    this.need(n);
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

function readVerts(c: Cursor, count: number, stride: number) {
  if (count > MAX_VERTS) throw new MeshFormatError("Too many vertices.");
  if (stride < 32) throw new MeshFormatError("Invalid vertex size.");
  c.need(count * stride);
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const o = c.pos + i * stride;
    const f = (k: number) => c.view.getFloat32(o + k * 4, true);
    positions[i * 3] = f(0);
    positions[i * 3 + 1] = f(1);
    positions[i * 3 + 2] = f(2);
    normals[i * 3] = f(3);
    normals[i * 3 + 1] = f(4);
    normals[i * 3 + 2] = f(5);
    uvs[i * 2] = f(6);
    uvs[i * 2 + 1] = 1 - f(7);
  }
  c.pos += count * stride;
  return { positions, normals, uvs };
}

function readFaces(c: Cursor, count: number, stride = 12) {
  if (count > MAX_FACES) throw new MeshFormatError("Too many faces.");
  c.need(count * stride);
  const indices = new Uint32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const o = c.pos + i * stride;
    indices[i * 3] = c.view.getUint32(o, true);
    indices[i * 3 + 1] = c.view.getUint32(o + 4, true);
    indices[i * 3 + 2] = c.view.getUint32(o + 8, true);
  }
  c.pos += count * stride;
  return indices;
}

// ── Skinning ────────────────────────────────────────────────────────────────

interface RawBone {
  nameIndex: number;
  parent: number;
  cf: number[];
}

interface Subset {
  vertsBegin: number;
  vertsLength: number;
  bones: number[];
}

/** 60-byte bone records: name offset, parent (0xFFFF = none), LOD parent, culling radius, rotation, position. */
function readBones(c: Cursor, count: number): RawBone[] {
  if (count > MAX_BONES) throw new MeshFormatError("Too many bones.");
  c.need(count * 60);
  const bones: RawBone[] = [];
  for (let i = 0; i < count; i++) {
    const o = c.pos + i * 60;
    const f = (k: number) => c.view.getFloat32(o + k, true);
    const parent = c.view.getUint16(o + 4, true);
    bones.push({
      nameIndex: c.view.getUint32(o, true),
      parent: parent === 0xffff ? -1 : parent,
      cf: [f(48), f(52), f(56), f(12), f(16), f(20), f(24), f(28), f(32), f(36), f(40), f(44)],
    });
  }
  c.pos += count * 60;
  return bones;
}

/** 72-byte subset records: face range, vertex range, and the (≤ 26) bones its vertices index into. */
function readSubsets(c: Cursor, count: number): Subset[] {
  if (count > MAX_SUBSETS) throw new MeshFormatError("Too many mesh subsets.");
  c.need(count * 72);
  const subsets: Subset[] = [];
  for (let i = 0; i < count; i++) {
    const o = c.pos + i * 72;
    const n = Math.min(26, c.view.getUint32(o + 16, true));
    subsets.push({
      vertsBegin: c.view.getUint32(o + 8, true),
      vertsLength: c.view.getUint32(o + 12, true),
      bones: Array.from({ length: n }, (_, k) => c.view.getUint16(o + 20 + k * 2, true)),
    });
  }
  c.pos += count * 72;
  return subsets;
}

/**
 * Resolves per-vertex envelopes (4 subset-local bone indices + 4 byte weights) into mesh-wide
 * bone indices and normalised weights.
 */
function assembleSkin(numVerts: number, envelopes: Uint8Array, raw: RawBone[], names: Uint8Array, subsets: Subset[]): MeshSkin {
  if (envelopes.length < numVerts * 8) throw new MeshFormatError("The skinning data is shorter than the vertex list.");
  const decoder = new TextDecoder();
  const bones: MeshBone[] = raw.map((b) => {
    if (b.nameIndex >= names.length) throw new MeshFormatError("A bone name is outside the name table.");
    let end = names.indexOf(0, b.nameIndex);
    if (end < 0) end = names.length;
    return { name: decoder.decode(names.subarray(b.nameIndex, end)), parent: b.parent < raw.length ? b.parent : -1, cf: b.cf };
  });
  const none = bones.length;
  const indices = new Uint16Array(numVerts * 4);
  const weights = new Float32Array(numVerts * 4);
  const covered = new Uint8Array(numVerts);
  for (const subset of subsets) {
    const end = Math.min(numVerts, subset.vertsBegin + subset.vertsLength);
    for (let v = subset.vertsBegin; v < end; v++) {
      covered[v] = 1;
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        const w = envelopes[v * 8 + 4 + k]!;
        const bone = subset.bones[envelopes[v * 8 + k]!];
        if (w === 0 || bone === undefined || bone >= bones.length) continue;
        indices[v * 4 + k] = bone;
        weights[v * 4 + k] = w;
        sum += w;
      }
      if (sum > 0) for (let k = 0; k < 4; k++) weights[v * 4 + k]! /= sum;
    }
  }
  let unweighted = 0;
  for (let v = 0; v < numVerts; v++) {
    if (covered[v] && weights[v * 4]! + weights[v * 4 + 1]! + weights[v * 4 + 2]! + weights[v * 4 + 3]! > 0) continue;
    // No bone moves this vertex: it stays with the part.
    indices.fill(0, v * 4, v * 4 + 4);
    indices[v * 4] = none;
    weights.fill(0, v * 4, v * 4 + 4);
    weights[v * 4] = 1;
    unweighted++;
  }
  return { bones, indices, weights, unweighted };
}

function skinOrError(build: () => MeshSkin): Pick<ParsedMesh, "skin" | "skinError"> {
  try {
    return { skin: build() };
  } catch (error) {
    return { skinError: error instanceof Error ? error.message : "The skinning data couldn't be read." };
  }
}

/** Keeps only the highest-detail LOD's faces. */
function lod0(indices: Uint32Array, offsets: number[]): Uint32Array {
  if (offsets.length < 2) return indices;
  const start = offsets[0]!;
  const end = offsets[1]!;
  if (end <= start || end * 3 > indices.length) return indices;
  return indices.subarray(start * 3, end * 3);
}

function validate(mesh: ParsedMesh): ParsedMesh {
  const vertexCount = mesh.positions.length / 3;
  for (const i of mesh.indices) if (i >= vertexCount) throw new MeshFormatError("A face points at a vertex that doesn't exist.");
  return mesh;
}

export function parseRobloxMesh(input: ArrayBuffer | Uint8Array): ParsedMesh {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const { version, offset } = readVersion(bytes);
  if (version === "1.00" || version === "1.01") {
    return validate(fromText(new TextDecoder("latin1").decode(bytes), version));
  }
  const c = new Cursor(bytes, offset);

  if (version === "2.00") {
    const start = c.pos;
    const headerSize = c.u16();
    const vertexSize = c.u8();
    const faceSize = c.u8();
    const numVerts = c.u32();
    const numFaces = c.u32();
    c.pos = start + headerSize;
    const verts = readVerts(c, numVerts, vertexSize);
    return validate({ version, ...verts, indices: readFaces(c, numFaces, faceSize) });
  }

  if (version === "3.00" || version === "3.01") {
    const start = c.pos;
    const headerSize = c.u16();
    const vertexSize = c.u8();
    const faceSize = c.u8();
    c.u16();
    const numLods = c.u16();
    const numVerts = c.u32();
    const numFaces = c.u32();
    c.pos = start + headerSize;
    const verts = readVerts(c, numVerts, vertexSize);
    const indices = readFaces(c, numFaces, faceSize);
    const offsets: number[] = [];
    for (let i = 0; i < numLods; i++) offsets.push(c.u32());
    return validate({ version, ...verts, indices: lod0(indices, offsets) });
  }

  if (version === "4.00" || version === "4.01" || version === "5.00") {
    const start = c.pos;
    const headerSize = c.u16();
    c.u16(); // lodType
    const numVerts = c.u32();
    const numFaces = c.u32();
    const numLods = c.u16();
    const numBones = c.u16();
    const namesSize = c.u32();
    const numSubsets = c.u16();
    c.pos = start + headerSize;
    const verts = readVerts(c, numVerts, 40);
    const envelopes = numBones > 0 ? c.take(numVerts * 8) : null;
    const indices = readFaces(c, numFaces);
    const offsets: number[] = [];
    for (let i = 0; i < numLods; i++) offsets.push(c.u32());
    const mesh: ParsedMesh = { version, ...verts, indices: lod0(indices, offsets) };
    if (envelopes) {
      Object.assign(
        mesh,
        skinOrError(() => {
          const raw = readBones(c, numBones);
          const names = c.take(namesSize);
          return assembleSkin(numVerts, envelopes, raw, names, readSubsets(c, numSubsets));
        }),
      );
    }
    return validate(mesh);
  }

  if (version === "6.00" || version === "7.00") {
    let core: { positions: Float32Array; normals: Float32Array; uvs: Float32Array; indices: Uint32Array } | null = null;
    let offsets: number[] = [];
    let skinning: Cursor | null = null;
    while (c.pos + 16 <= bytes.length) {
      const type = new TextDecoder("latin1").decode(bytes.subarray(c.pos, c.pos + 8)).replace(/\0+$/, "");
      c.pos += 8;
      const chunkVersion = c.u32();
      const size = c.u32();
      c.need(size);
      const end = c.pos + size;
      if (type === "COREMESH") {
        if (chunkVersion !== 1) {
          throw new MeshFormatError("This mesh is Draco-compressed (mesh v7) and wasn't decoded when it was added. Remove it in Resources and fetch or upload it again.", "unsupported");
        }
        const numVerts = c.u32();
        const verts = readVerts(c, numVerts, 40);
        const numFaces = c.u32();
        core = { ...verts, indices: readFaces(c, numFaces) };
      } else if (type === "LODS" && chunkVersion === 1) {
        c.u16();
        c.u8();
        const n = c.u32();
        offsets = [];
        for (let i = 0; i < n; i++) offsets.push(c.u32());
      } else if (type === "SKINNING" && chunkVersion === 1) {
        skinning = new Cursor(bytes.subarray(0, end), c.pos);
      }
      c.pos = end;
    }
    if (!core) throw new MeshFormatError("The mesh has no geometry chunk.");
    const mesh: ParsedMesh = { version, ...core, indices: lod0(core.indices, offsets) };
    if (skinning) {
      const s = skinning;
      const numVerts = core.positions.length / 3;
      Object.assign(
        mesh,
        skinOrError(() => {
          const numSkinnings = s.u32();
          if (numSkinnings !== numVerts) throw new MeshFormatError("The skinning data doesn't match the vertex count.");
          const envelopes = s.take(numSkinnings * 8);
          const raw = readBones(s, s.u32());
          const names = s.take(s.u32());
          return assembleSkin(numVerts, envelopes, raw, names, readSubsets(s, s.u32()));
        }),
      );
    }
    return validate(mesh);
  }

  throw new MeshFormatError(`Mesh version ${version} isn't supported.`, "unsupported");
}

/** Axis-aligned bounds of a parsed mesh. */
export function meshBounds(mesh: Pick<ParsedMesh, "positions">) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = mesh.positions[i + k]!;
      if (v < min[k]!) min[k] = v;
      if (v > max[k]!) max[k] = v;
    }
  }
  return { min, max };
}
