import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildManifest, manifestMeta } from "./manifest";
import { RobloxParseError, type RbxDocument, type RbxInstance, type RbxValue } from "./model";
import { parseRobloxFile } from "./parse";
import { encodeAttributes, R, writeBinaryModel } from "./writer";
import { decodeAttributes } from "./attributes";
import { lz4DecompressBlock } from "./lz4";

const FIXTURES = path.resolve("src/server/roblox/__fixtures__/rbx-test-files");

function looksBinary(s: string) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 0xfffd) return true;
  }
  return false;
}

/** Binary and XML encode some values differently (blobs, empty content); compare what they mean. */
function norm(v: RbxValue): unknown {
  if (v.type === "String") {
    if (v.value === "") return null;
    if (v.bytes && looksBinary(v.value)) return Buffer.from(v.bytes).toString("base64");
    return v.value;
  }
  if (v.type === "Content") return v.value || null;
  if (v.type === "BinaryString" || v.type === "SharedString") {
    if (!v.value.length) return null;
    const text = Buffer.from(v.value).toString("utf8");
    return looksBinary(text) ? Buffer.from(v.value).toString("base64") : text;
  }
  if (v.type === "UniqueId" || v.type === "Unknown") return "skip";
  if (v.type === "Font") return { ...v.value, cachedFaceId: v.value.cachedFaceId || "" };
  return v.value;
}

function close(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return a === b || (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) <= 1e-4 * Math.max(1, Math.abs(a), Math.abs(b));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => close(x, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => close((a as never)[k], (b as never)[k]));
  }
  return a === b;
}

function refPath(doc: RbxDocument, ref: string | null) {
  if (!ref) return null;
  const parts: string[] = [];
  for (let p: RbxInstance | null = doc.byRef.get(ref) ?? null; p; p = p.parent) parts.unshift(`${p.className}:${p.name}`);
  return parts.join("/");
}

function compare(a: RbxDocument, b: RbxDocument) {
  const issues: string[] = [];
  let props = 0;
  const walk = (x: RbxInstance[], y: RbxInstance[], where: string) => {
    if (x.length !== y.length && where === "") {
      // Places serialise different service sets per format: compare the shared ones.
      const pool = [...y];
      const pairs = x
        .map((ix) => {
          const k = pool.findIndex((iy) => iy.className === ix.className && iy.name === ix.name);
          return [ix, k >= 0 ? pool.splice(k, 1)[0] : undefined] as const;
        })
        .filter(([, iy]) => iy);
      x = pairs.map((p) => p[0]);
      y = pairs.map((p) => p[1]!);
    }
    if (x.length !== y.length) return issues.push(`${where}: ${x.length} vs ${y.length} children`);
    x.forEach((ix, i) => {
      const iy = y[i]!;
      const here = `${where}/${ix.className}:${ix.name}`;
      if (ix.className !== iy.className || ix.name !== iy.name) issues.push(`${here} vs ${iy.className}:${iy.name}`);
      for (const [key, vx] of ix.props) {
        const vy = iy.props.get(key);
        if (!vy) continue;
        props++;
        if (vx.type === "Ref" && vy.type === "Ref") {
          if (refPath(a, vx.value) !== refPath(b, vy.value)) issues.push(`${here}.${key} ref`);
        } else if (!close(norm(vx), norm(vy))) {
          issues.push(`${here}.${key}: ${JSON.stringify(norm(vx))?.slice(0, 80)} vs ${JSON.stringify(norm(vy))?.slice(0, 80)}`);
        }
      }
      walk(ix.children, iy.children, here);
    });
  };
  walk(a.roots, b.roots, "");
  return { issues, props };
}

describe("Roblox file reader (Studio-exported corpus)", () => {
  const dirs = fs.readdirSync(FIXTURES, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

  it.each(dirs)("reads %s identically from binary and XML", (dir) => {
    const files = fs.readdirSync(path.join(FIXTURES, dir));
    const bin = parseRobloxFile(new Uint8Array(fs.readFileSync(path.join(FIXTURES, dir, files.find((f) => /^binary\./.test(f))!))));
    const xml = parseRobloxFile(new Uint8Array(fs.readFileSync(path.join(FIXTURES, dir, files.find((f) => /^xml\./.test(f))!))));
    expect(bin.format).toBe("binary");
    expect(xml.format).toBe("xml");
    const { issues, props } = compare(bin, xml);
    expect(issues).toEqual([]);
    expect(props).toBeGreaterThan(0);
  });

  it("decodes every property type Studio writes (all-instances place)", () => {
    const doc = parseRobloxFile(new Uint8Array(fs.readFileSync(path.join(FIXTURES, "all-instances-415/binary.rbxl"))));
    expect(doc.instances.length).toBeGreaterThan(200);
    expect(doc.warnings.filter((w) => /unknown data type/.test(w))).toEqual([]);
    const classes = new Set(doc.instances.map((i) => i.className));
    for (const c of ["KeyframeSequence", "Pose", "Motor6D", "ParticleEmitter", "Beam", "Trail", "MeshPart", "UnionOperation", "Script"]) expect(classes).toContain(c);
  });

  it("rejects files that aren't Roblox models, and hostile input doesn't crash", () => {
    expect(() => parseRobloxFile(new TextEncoder().encode("<html>not a model</html>"))).toThrow(RobloxParseError);
    const truncated = new Uint8Array(fs.readFileSync(path.join(FIXTURES, "three-beams/binary.rbxm"))).subarray(0, 120);
    expect(() => parseRobloxFile(truncated)).toThrow(RobloxParseError);
    expect(() => parseRobloxFile(new TextEncoder().encode('<roblox version="4"><!DOCTYPE x [<!ENTITY a "b">]></roblox>'))).toThrow(/document type/);
    expect(() => lz4DecompressBlock(Uint8Array.from([0xf0, 1, 2]), 100)).toThrow(RobloxParseError);
  });
});

describe("binary writer", () => {
  it("round-trips through the reader", () => {
    const bytes = writeBinaryModel([
      {
        className: "Model",
        props: { Name: R.str("Tower"), PrimaryPart: R.ref("base") },
        children: [
          { className: "Part", props: { __id: R.str("base"), Name: R.str("Base"), size: R.v3(4, 1, 2), CFrame: R.cfa(1, 2, 3, 0, 90, 0), Color3uint8: R.rgb(255, 0, 128), Anchored: R.bool(true), Transparency: R.f32(0.25) } },
          {
            className: "ParticleEmitter",
            props: {
              Name: R.str("Sparks"),
              Rate: R.f32(12.5),
              Lifetime: R.range(0.5, 1.5),
              Size: R.numSeq([0, 1, 0.1], [1, 0]),
              Color: R.colorSeq([0, 1, 0, 0], [1, 0, 0, 1]),
              AttributesSerialize: R.bin(encodeAttributes({ EmitCount: 24, Label: "burst", Loop: true })),
            },
          },
        ],
      },
    ]);
    const doc = parseRobloxFile(bytes);
    expect(doc.warnings).toEqual([]);
    const [model] = doc.roots;
    expect(model!.name).toBe("Tower");
    const part = model!.children.find((c) => c.className === "Part")!;
    expect(part.props.get("size")).toEqual({ type: "Vector3", value: [4, 1, 2] });
    expect(part.props.get("Color3uint8")).toEqual({ type: "Color3uint8", value: [255, 0, 128] });
    const cf = part.props.get("CFrame") as Extract<RbxValue, { type: "CFrame" }>;
    expect(cf.value.slice(0, 3)).toEqual([1, 2, 3]);
    expect(cf.value[5]).toBeCloseTo(1); // rotated 90° about Y: R02 = sin(90°)
    expect(model!.props.get("PrimaryPart")).toEqual({ type: "Ref", value: part.ref });
    const emitter = model!.children.find((c) => c.className === "ParticleEmitter")!;
    const attrs = emitter.props.get("AttributesSerialize") as Extract<RbxValue, { type: "String" }>;
    expect(decodeAttributes(attrs.bytes)).toEqual({ EmitCount: 24, Label: "burst", Loop: true });
  });
});

describe("preview manifest", () => {
  it("finds rigs, animations, effects, resources and never includes script source", () => {
    const I = (className: string, props: Record<string, RbxValue>, children: Parameters<typeof writeBinaryModel>[0] = []) => ({ className, props, children });
    const right = [0, 0, 1, 0, 1, 0, -1, 0, 0];
    const bytes = writeBinaryModel([
      I("Model", { Name: R.str("Rig") }, [
        I("Part", { __id: R.str("torso"), Name: R.str("Torso"), size: R.v3(2, 2, 1), CFrame: R.cf(0, 3, 0) }, [
          I("Motor6D", { Name: R.str("Right Shoulder"), Part0: R.ref("torso"), Part1: R.ref("arm"), C0: R.cf(1, 0.5, 0, right), C1: R.cf(-0.5, 0.5, 0, right) }),
        ]),
        I("MeshPart", { __id: R.str("arm"), Name: R.str("Right Arm"), size: R.v3(1, 2, 1), CFrame: R.cf(1.5, 3, 0), MeshId: R.str("http://www.roblox.com/asset/?id=123"), TextureID: R.str("rbxassetid://456") }),
        I("Folder", { Name: R.str("AnimSaves") }, [
          I("KeyframeSequence", { Name: R.str("Wave"), Loop: R.bool(false) }, [
            I("Keyframe", { Name: R.str("Start"), Time: R.f32(0) }, [I("Pose", { Name: R.str("HumanoidRootPart"), Weight: R.f32(0) }, [I("Pose", { Name: R.str("Right Arm"), CFrame: R.cf(0, 0, 0), Weight: R.f32(1) })])]),
            I("Keyframe", { Name: R.str("Keyframe"), Time: R.f32(0.8) }, [I("KeyframeMarker", { Name: R.str("Hit"), Value: R.str("hit") })]),
          ]),
        ]),
        I("Script", { Name: R.str("Danger"), Source: R.str("while true do end\nprint('never runs')") }),
      ]),
    ]);
    const m = buildManifest(parseRobloxFile(bytes));
    expect(m.rigs).toHaveLength(1);
    expect(m.rigs[0]!.joints).toHaveLength(1);
    expect(m.animations[0]).toMatchObject({ name: "Wave", length: 0.8, loop: false, keyframes: 2, joints: ["Right Arm"] });
    expect(m.animations[0]!.markers.map((x) => x.name)).toEqual(["Start", "Hit"]);
    expect(m.resources.map((r) => `${r.kind}:${r.contentId}`).sort()).toEqual(["mesh:rbxassetid://123", "texture:rbxassetid://456"]);
    expect(JSON.stringify(m)).not.toContain("never runs");
    const script = m.nodes.find((n) => n.c === "Script")!;
    expect(script.x.find(([k]) => k === "Source")?.[1]).toBe("2 lines (never executed)");
    expect(m.warnings.join(" ")).toMatch(/never executed/);
    expect(m.support.find((s) => s.className === "Script")?.level).toBe("unsupported");
    expect(manifestMeta(m)).toMatchObject({ primary: "animation", rigCount: 1, animationCount: 1, externalResources: 2 });
  });

  it("reads real Studio emitters and beams", () => {
    const doc = parseRobloxFile(new Uint8Array(fs.readFileSync(path.join(FIXTURES, "two-particleemitters/binary.rbxm"))));
    const m = buildManifest(doc);
    const emitter = m.nodes.find((n) => n.c === "ParticleEmitter")!;
    expect(emitter.r).toMatchObject({ rate: 2, speed: [2, 5], enabled: true, tex: "rbxasset://textures/particles/sparkles_main.dds" });
    expect(m.resources[0]).toMatchObject({ kind: "texture", builtin: true });
    expect(m.capabilities.effects).toBe(true);
    const beams = buildManifest(parseRobloxFile(new Uint8Array(fs.readFileSync(path.join(FIXTURES, "three-beams/binary.rbxm")))));
    expect(beams.nodes.filter((n) => n.c === "Beam")).toHaveLength(3);
  });
});

describe("Draco-compressed meshes (mesh v7)", () => {
  /** A unit cube (8 corners, 12 triangles) encoded the way Roblox stores v7 meshes. */
  async function dracoCubeMesh(lods: number[], skinning: Uint8Array | null = null): Promise<Buffer> {
    const { createEncoderModule } = await import("draco3d");
    const m = await createEncoderModule({});
    const positions = new Float32Array([-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5]);
    const normals = new Float32Array(positions.map((v) => v * 2 * 0.577));
    const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1]);
    const faces = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5]);
    const builder = new m.MeshBuilder();
    const mesh = new m.Mesh();
    builder.AddFacesToMesh(mesh, 12, faces);
    builder.AddFloatAttribute(mesh, m.POSITION, 8, 3, positions);
    builder.AddFloatAttribute(mesh, m.GENERIC, 8, 3, normals);
    builder.AddFloatAttribute(mesh, m.TEX_COORD, 8, 2, uvs);
    const encoder = new m.Encoder();
    encoder.SetEncodingMethod(m.MESH_SEQUENTIAL_ENCODING);
    const out = new m.DracoInt8Array();
    const length = encoder.EncodeMeshToDracoBuffer(mesh, out);
    const stream = Buffer.alloc(length);
    for (let i = 0; i < length; i++) stream.writeInt8(out.GetValue(i), i);
    for (const x of [out, encoder, mesh, builder]) m.destroy(x);

    const chunk = (type: string, version: number, data: Buffer) => {
      const head = Buffer.alloc(16);
      head.write(type, 0, "latin1");
      head.writeUInt32LE(version, 8);
      head.writeUInt32LE(data.length, 12);
      return Buffer.concat([head, data]);
    };
    const core = Buffer.concat([Buffer.from(Uint32Array.of(length).buffer), stream]);
    const lodData = Buffer.alloc(7 + lods.length * 4);
    lodData.writeUInt8(1, 2);
    lodData.writeUInt32LE(lods.length, 3);
    lods.forEach((o, i) => lodData.writeUInt32LE(o, 7 + i * 4));
    const parts = [Buffer.from("version 7.00\n", "latin1"), chunk("COREMESH", 2, core), chunk("LODS", 1, lodData)];
    if (skinning) parts.push(chunk("SKINNING", 1, Buffer.from(skinning)));
    return Buffer.concat(parts);
  }

  it("decodes the geometry into a plain mesh the viewer reads", async () => {
    const { convertDracoMesh, isDracoMesh } = await import("./draco-mesh");
    const { meshBounds, parseRobloxMesh } = await import("@/lib/roblox/mesh");
    const file = await dracoCubeMesh([0, 0]);
    expect(isDracoMesh(file)).toBe(true);
    // The viewer alone can't read it…
    expect(() => parseRobloxMesh(new Uint8Array(file))).toThrow(/Draco/);
    // …but the converted copy is an ordinary uncompressed (v6) mesh with the same shape.
    const mesh = parseRobloxMesh(new Uint8Array(await convertDracoMesh(file)));
    expect(mesh.version).toBe("6.00");
    expect(mesh.skin).toBeUndefined();
    expect(mesh.positions.length / 3).toBe(8);
    expect(mesh.indices.length / 3).toBe(12);
    const { min, max } = meshBounds(mesh);
    for (let k = 0; k < 3; k++) {
      expect(min[k]).toBeCloseTo(-0.5, 2);
      expect(max[k]).toBeCloseTo(0.5, 2);
    }
    expect(Math.min(...mesh.uvs)).toBeCloseTo(0, 2);
    expect(Math.max(...mesh.uvs)).toBeCloseTo(1, 2);
  });

  it("keeps only the full-detail level", async () => {
    const { convertDracoMesh } = await import("./draco-mesh");
    const { parseRobloxMesh } = await import("@/lib/roblox/mesh");
    const mesh = parseRobloxMesh(new Uint8Array(await convertDracoMesh(await dracoCubeMesh([0, 8, 12]))));
    expect(mesh.indices.length / 3).toBe(8);
  });

  it("keeps the skeleton and per-vertex weights, in vertex order", async () => {
    const { convertDracoMesh } = await import("./draco-mesh");
    const { parseRobloxMesh } = await import("@/lib/roblox/mesh");
    const { skinningChunkBody } = await import("@/test/roblox-meshes");
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
    // Bottom corners follow "Lower", top ones "Upper"; corner 2 is blended 75/25.
    const verts = corners.map((pos, i) => ({
      pos,
      weights: (pos[1] < 0 ? [[0, 255]] : i === 2 ? [[1, 191], [0, 64]] : [[1, 255]]) as Array<[number, number]>,
    }));
    const bones = [
      { name: "Lower", parent: -1, pos: [0, -0.5, 0] as [number, number, number] },
      { name: "Upper", parent: 0, pos: [0, 0.5, 0] as [number, number, number], rot: [0, -1, 0, 1, 0, 0, 0, 0, 1] },
    ];
    const file = await dracoCubeMesh([0, 0], skinningChunkBody(verts, 12, bones));
    const mesh = parseRobloxMesh(new Uint8Array(await convertDracoMesh(file)));
    expect(mesh.skinError).toBeUndefined();
    const skin = mesh.skin!;
    expect(skin.bones).toEqual([
      { name: "Lower", parent: -1, cf: [0, -0.5, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] },
      { name: "Upper", parent: 0, cf: [0, 0.5, 0, 0, -1, 0, 1, 0, 0, 0, 0, 1] },
    ]);
    expect(skin.unweighted).toBe(0);
    for (let v = 0; v < 8; v++) {
      // The weights still belong to the same corners after decoding.
      const top = mesh.positions[v * 3 + 1]! > 0;
      expect(skin.indices[v * 4]).toBe(top ? 1 : 0);
      if (v === 2) expect([skin.weights[v * 4]!, skin.weights[v * 4 + 1]!].map((w) => Math.round(w * 100))).toEqual([75, 25]);
      else expect(skin.weights[v * 4]).toBe(1);
    }
  });

  it("explains a broken compressed mesh", async () => {
    const { convertDracoMesh } = await import("./draco-mesh");
    const file = await dracoCubeMesh([0, 0]);
    const broken = Buffer.from(file);
    broken.fill(0x7f, 40, 80); // corrupt the Draco bitstream
    await expect(convertDracoMesh(broken)).rejects.toBeInstanceOf(RobloxParseError);
  });
});
