/**
 * Builders for small Roblox .mesh files used by tests (layouts follow the community spec,
 * https://devforum.roblox.com/t/roblox-mesh-format/326114).
 */

export interface TestVertex {
  pos: [number, number, number];
  /** Up to 4 [boneIndex (mesh-wide), weight 0–255] pairs. */
  weights?: Array<[number, number]>;
}

export interface TestBone {
  name: string;
  parent: number;
  pos: [number, number, number];
  /** Row-major 3×3 rotation (default identity). */
  rot?: number[];
}

const IDENTITY_ROT = [1, 0, 0, 0, 1, 0, 0, 0, 1];

class Writer {
  private chunks: Uint8Array[] = [];
  bytes(b: Uint8Array) {
    this.chunks.push(b);
    return this;
  }
  text(s: string) {
    return this.bytes(new TextEncoder().encode(s));
  }
  view(size: number, fill: (v: DataView) => void) {
    const v = new DataView(new ArrayBuffer(size));
    fill(v);
    return this.bytes(new Uint8Array(v.buffer));
  }
  done() {
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}

/** 40-byte vertices (position, normal +Z, UV, tangent, colour). */
export function vertexBytes(verts: TestVertex[]): Uint8Array {
  return new Writer()
    .view(verts.length * 40, (v) => {
      verts.forEach((vert, i) => {
        const o = i * 40;
        [...vert.pos, 0, 0, 1, 0, 0].forEach((f, k) => v.setFloat32(o + k * 4, f, true));
        v.setUint32(o + 36, 0xffffffff, true);
      });
    })
    .done();
}

/** One subset holding every vertex, so subset-local bone indices equal mesh-wide ones (≤ 26 bones). */
export function skinBytes(verts: TestVertex[], bones: TestBone[]) {
  const envelopes = new Writer()
    .view(verts.length * 8, (v) => {
      verts.forEach((vert, i) => {
        (vert.weights ?? []).slice(0, 4).forEach(([bone, w], k) => {
          v.setUint8(i * 8 + k, bone);
          v.setUint8(i * 8 + 4 + k, w);
        });
      });
    })
    .done();
  const nameOffsets: number[] = [];
  let namesText = "";
  for (const b of bones) {
    nameOffsets.push(new TextEncoder().encode(namesText).length);
    namesText += `${b.name}\0`;
  }
  const names = new TextEncoder().encode(namesText);
  const boneRecords = new Writer()
    .view(bones.length * 60, (v) => {
      bones.forEach((b, i) => {
        const o = i * 60;
        v.setUint32(o, nameOffsets[i]!, true);
        v.setUint16(o + 4, b.parent < 0 ? 0xffff : b.parent, true);
        v.setUint16(o + 6, 0xffff, true);
        v.setFloat32(o + 8, 1, true);
        (b.rot ?? IDENTITY_ROT).forEach((f, k) => v.setFloat32(o + 12 + k * 4, f, true));
        b.pos.forEach((f, k) => v.setFloat32(o + 48 + k * 4, f, true));
      });
    })
    .done();
  const subset = (faces: number) =>
    new Writer()
      .view(72, (v) => {
        v.setUint32(0, 0, true);
        v.setUint32(4, faces, true);
        v.setUint32(8, 0, true);
        v.setUint32(12, verts.length, true);
        v.setUint32(16, bones.length, true);
        bones.forEach((_, k) => v.setUint16(20 + k * 2, k, true));
      })
      .done();
  return { envelopes, names, boneRecords, subset };
}

function faceBytes(faces: Array<[number, number, number]>) {
  return new Writer()
    .view(faces.length * 12, (v) => faces.forEach((f, i) => f.forEach((x, k) => v.setUint32(i * 12 + k * 4, x, true))))
    .done();
}

/** A skinned "version 4.00" mesh. */
export function skinnedMeshV4(verts: TestVertex[], faces: Array<[number, number, number]>, bones: TestBone[]): Uint8Array {
  const skin = skinBytes(verts, bones);
  return new Writer()
    .text("version 4.00\n")
    .view(24, (v) => {
      v.setUint16(0, 24, true);
      v.setUint16(2, 0, true);
      v.setUint32(4, verts.length, true);
      v.setUint32(8, faces.length, true);
      v.setUint16(12, 0, true);
      v.setUint16(14, bones.length, true);
      v.setUint32(16, skin.names.length, true);
      v.setUint16(20, 1, true);
    })
    .bytes(vertexBytes(verts))
    .bytes(skin.envelopes)
    .bytes(faceBytes(faces))
    .bytes(skin.boneRecords)
    .bytes(skin.names)
    .bytes(skin.subset(faces.length))
    .done();
}

function chunk(type: string, version: number, data: Uint8Array) {
  return new Writer()
    .view(16, (v) => {
      for (let k = 0; k < 8; k++) v.setUint8(k, k < type.length ? type.charCodeAt(k) : 0);
      v.setUint32(8, version, true);
      v.setUint32(12, data.length, true);
    })
    .bytes(data)
    .done();
}

/** The SKINNING (v1) chunk body of a v6/v7 mesh. */
export function skinningChunkBody(verts: TestVertex[], faces: number, bones: TestBone[]): Uint8Array {
  const skin = skinBytes(verts, bones);
  const u32 = (n: number) => new Writer().view(4, (v) => v.setUint32(0, n, true)).done();
  return new Writer()
    .bytes(u32(verts.length))
    .bytes(skin.envelopes)
    .bytes(u32(bones.length))
    .bytes(skin.boneRecords)
    .bytes(u32(skin.names.length))
    .bytes(skin.names)
    .bytes(u32(1))
    .bytes(skin.subset(faces))
    .done();
}

/**
 * A skinned unit cube stored the way Roblox stores current meshes: "version 7.00", Draco-compressed
 * COREMESH (sequential encoding) and a SKINNING chunk (bottom corners on "Lower", top on "Upper").
 */
export async function dracoSkinnedCube(): Promise<Uint8Array> {
  const { createEncoderModule } = await import("draco3d");
  const m = await createEncoderModule({});
  const corners: Array<[number, number, number]> = [
    [-0.5, -0.5, -0.5],
    [0.5, -0.5, -0.5],
    [0.5, 0.5, -0.5],
    [-0.5, 0.5, -0.5],
    [-0.5, -0.5, 0.5],
    [0.5, -0.5, 0.5],
    [0.5, 0.5, 0.5],
    [-0.5, 0.5, 0.5],
  ];
  const faces = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5]);
  const builder = new m.MeshBuilder();
  const mesh = new m.Mesh();
  builder.AddFacesToMesh(mesh, 12, faces);
  builder.AddFloatAttribute(mesh, m.POSITION, 8, 3, new Float32Array(corners.flat()));
  const encoder = new m.Encoder();
  encoder.SetEncodingMethod(m.MESH_SEQUENTIAL_ENCODING);
  const out = new m.DracoInt8Array();
  const length = encoder.EncodeMeshToDracoBuffer(mesh, out);
  const stream = new Uint8Array(length);
  for (let i = 0; i < length; i++) stream[i] = out.GetValue(i) & 0xff;
  for (const x of [out, encoder, mesh, builder]) m.destroy(x);
  const verts: TestVertex[] = corners.map((pos) => ({ pos, weights: [[pos[1] < 0 ? 0 : 1, 255]] }));
  const bones: TestBone[] = [
    { name: "Lower", parent: -1, pos: [0, -0.5, 0] },
    { name: "Upper", parent: 0, pos: [0, 0.5, 0] },
  ];
  return dracoMeshV7(stream, skinningChunkBody(verts, 12, bones));
}

/** A "version 7.00" mesh whose COREMESH is the given Draco bitstream, plus a SKINNING chunk. */
export function dracoMeshV7(draco: Uint8Array, skinning: Uint8Array | null): Uint8Array {
  const core = new Writer().view(4, (v) => v.setUint32(0, draco.length, true)).bytes(draco).done();
  const w = new Writer().text("version 7.00\n").bytes(chunk("COREMESH", 2, core));
  if (skinning) w.bytes(chunk("SKINNING", 1, skinning));
  return w.done();
}
