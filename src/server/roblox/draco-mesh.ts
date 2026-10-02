import { RobloxParseError } from "./model";

/**
 * Roblox stores most recently uploaded meshes as "version 7.00" files whose COREMESH chunk
 * (chunk version 2) is a Draco-compressed bitstream. Browsers can't read that directly, so the
 * server decodes it once — with Google's reference decoder (draco3d) — and writes the
 * full-detail level as an uncompressed "version 6.00" mesh (COREMESH chunk version 1). Every
 * other chunk the viewer uses — SKINNING (bones, bind pose, vertex weights) — is copied
 * byte for byte; Draco's sequential encoding keeps the vertex order those weights refer to.
 * The original file is never modified.
 */

/**
 * Name of the decoded copy stored next to the original. Bump it whenever the output changes:
 * copies with another name are regenerated from the original the next time they're served.
 * (v2 dropped the skeleton; v3 keeps it.)
 */
export const DECODED_MESH_NAME = "decoded-v3.mesh";

interface Chunk {
  type: string;
  version: number;
  data: Buffer;
}

const MAX_VERTS = 2_000_000;

function chunksOf(bytes: Buffer): Chunk[] | null {
  const header = bytes.subarray(0, 16).toString("latin1");
  if (!/^version [67]\.\d\d/.test(header)) return null;
  let o = bytes.indexOf(10) + 1;
  const chunks: Chunk[] = [];
  while (o > 0 && o + 16 <= bytes.length) {
    const type = bytes.toString("latin1", o, o + 8).replace(/\0+$/, "");
    const version = bytes.readUInt32LE(o + 8);
    const size = bytes.readUInt32LE(o + 12);
    if (o + 16 + size > bytes.length) throw new RobloxParseError("The mesh file is truncated.");
    chunks.push({ type, version, data: bytes.subarray(o + 16, o + 16 + size) });
    o += 16 + size;
  }
  return chunks;
}

/** True for a v6/v7 mesh whose geometry is Draco-compressed (judged from the file's first bytes). */
export function isDracoMesh(head: Buffer): boolean {
  if (!/^version [67]\.\d\d/.test(head.subarray(0, 16).toString("latin1"))) return false;
  const o = head.indexOf(10) + 1;
  if (o <= 0 || o + 16 > head.length) return false;
  return head.toString("latin1", o, o + 8).replace(/\0+$/, "") === "COREMESH" && head.readUInt32LE(o + 8) === 2;
}

type DracoModule = Awaited<ReturnType<typeof import("draco3d").createDecoderModule>>;
let decoderModule: Promise<DracoModule> | null = null;
function draco() {
  decoderModule ??= import("draco3d").then((m) => m.createDecoderModule({}));
  return decoderModule;
}

/** Decodes a Draco-compressed Roblox mesh into an uncompressed "version 6.00" mesh file. */
export async function convertDracoMesh(bytes: Buffer): Promise<Buffer> {
  const chunks = chunksOf(bytes);
  const core = chunks?.find((c) => c.type === "COREMESH");
  if (!core || core.version !== 2) throw new RobloxParseError("This isn't a Draco-compressed Roblox mesh.");
  const length = core.data.readUInt32LE(0);
  if (length + 4 > core.data.length) throw new RobloxParseError("The compressed mesh data is truncated.");
  const stream = core.data.subarray(4, 4 + length);

  const m = await draco();
  const decoder = new m.Decoder();
  const buffer = new m.DecoderBuffer();
  const mesh = new m.Mesh();
  try {
    buffer.Init(new Int8Array(stream.buffer, stream.byteOffset, stream.byteLength), stream.byteLength);
    if (decoder.GetEncodedGeometryType(buffer) !== m.TRIANGULAR_MESH) throw new RobloxParseError("The compressed mesh isn't a triangle mesh.");
    const status = decoder.DecodeBufferToMesh(buffer, mesh);
    if (!status.ok()) throw new RobloxParseError(`The compressed mesh couldn't be decoded (${status.error_msg()}).`);

    const numPoints = mesh.num_points();
    const numFaces = mesh.num_faces();
    if (numPoints > MAX_VERTS) throw new RobloxParseError("The mesh has too many vertices.");
    // The skin weights are listed per vertex in the file's order; they only line up with
    // sequentially encoded geometry (edgebreaker may reorder vertices).
    const skinning = chunks!.find((c) => c.type === "SKINNING" && c.version === 1);
    const sequential = stream.length > 8 && stream[8] === 0;
    const skinCount = skinning && skinning.data.length >= 4 ? skinning.data.readUInt32LE(0) : -1;
    const keepSkin = Boolean(skinning) && sequential && skinCount === numPoints;

    const read = (attributeType: number, components: number, nth = 0): Float32Array | null => {
      let seen = 0;
      for (let i = 0; i < mesh.num_attributes(); i++) {
        // (attribute_type exists at runtime; @types/draco3d omits it.)
        const attribute = decoder.GetAttribute(mesh, i) as ReturnType<typeof decoder.GetAttribute> & { attribute_type(): number };
        if (attribute.attribute_type() !== attributeType || attribute.num_components() !== components) continue;
        if (seen++ < nth) continue;
        const values = new m.DracoFloat32Array();
        try {
          decoder.GetAttributeFloatForAllPoints(mesh, attribute, values);
          const out = new Float32Array(numPoints * components);
          for (let k = 0; k < out.length; k++) out[k] = values.GetValue(k);
          return out;
        } finally {
          m.destroy(values);
        }
      }
      return null;
    };
    const positions = read(m.POSITION, 3);
    if (!positions) throw new RobloxParseError("The compressed mesh has no positions.");
    // Roblox writes normals as the first 3-component generic attribute (tangents are 4-component).
    const normals = read(m.NORMAL, 3) ?? read(m.GENERIC, 3);
    const uvs = read(m.TEX_COORD, 2);

    const faces = new m.DracoInt32Array();
    let indices: Uint32Array;
    try {
      indices = new Uint32Array(numFaces * 3);
      for (let f = 0; f < numFaces; f++) {
        decoder.GetFaceFromMesh(mesh, f, faces);
        indices[f * 3] = faces.GetValue(0);
        indices[f * 3 + 1] = faces.GetValue(1);
        indices[f * 3 + 2] = faces.GetValue(2);
      }
    } finally {
      m.destroy(faces);
    }

    // Keep the full-detail level only (LODS lists face ranges; [0, 0] means "no LODs").
    const lods = chunks!.find((c) => c.type === "LODS" && c.version === 1);
    if (lods && lods.data.length >= 7) {
      const count = lods.data.readUInt32LE(3);
      const offsets: number[] = [];
      for (let i = 0; i < count && 7 + i * 4 + 4 <= lods.data.length; i++) offsets.push(lods.data.readUInt32LE(7 + i * 4));
      const [start, end] = offsets;
      if (offsets.length >= 2 && end! > start! && end! * 3 <= indices.length) indices = indices.slice(start! * 3, end! * 3);
    }

    return encodeMeshV6(positions, normals, uvs, indices, keepSkin ? skinning!.data : null);
  } finally {
    m.destroy(mesh);
    m.destroy(buffer);
    m.destroy(decoder);
  }
}

function chunk(type: string, version: number, data: Buffer): Buffer {
  const head = Buffer.alloc(16);
  head.write(type, 0, 8, "latin1");
  head.writeUInt32LE(version, 8);
  head.writeUInt32LE(data.length, 12);
  return Buffer.concat([head, data]);
}

/**
 * Writes an uncompressed Roblox "version 6.00" mesh: COREMESH v1 (40-byte vertices — position,
 * normal, UV, tangent, RGBA — and 12-byte faces), plus the original SKINNING chunk if given.
 */
function encodeMeshV6(positions: Float32Array, normals: Float32Array | null, uvs: Float32Array | null, indices: Uint32Array, skinning: Buffer | null): Buffer {
  const count = positions.length / 3;
  const core = Buffer.alloc(4 + count * 40 + 4 + indices.length * 4);
  core.writeUInt32LE(count, 0);
  let o = 4;
  for (let i = 0; i < count; i++) {
    core.writeFloatLE(positions[i * 3]!, o);
    core.writeFloatLE(positions[i * 3 + 1]!, o + 4);
    core.writeFloatLE(positions[i * 3 + 2]!, o + 8);
    core.writeFloatLE(normals ? normals[i * 3]! : 0, o + 12);
    core.writeFloatLE(normals ? normals[i * 3 + 1]! : 1, o + 16);
    core.writeFloatLE(normals ? normals[i * 3 + 2]! : 0, o + 20);
    core.writeFloatLE(uvs ? uvs[i * 2]! : 0, o + 24);
    core.writeFloatLE(uvs ? uvs[i * 2 + 1]! : 0, o + 28);
    core.writeInt8(0, o + 32); // tangent (unused by the viewer)
    core.writeInt8(0, o + 33);
    core.writeInt8(-127, o + 34);
    core.writeInt8(127, o + 35);
    core.writeUInt32LE(0xffffffff, o + 36); // vertex colour: white, opaque
    o += 40;
  }
  core.writeUInt32LE(indices.length / 3, o);
  o += 4;
  for (const index of indices) {
    core.writeUInt32LE(index, o);
    o += 4;
  }
  const parts = [Buffer.from("version 6.00\n", "latin1"), chunk("COREMESH", 1, core)];
  if (skinning) parts.push(chunk("SKINNING", 1, skinning));
  return Buffer.concat(parts);
}
