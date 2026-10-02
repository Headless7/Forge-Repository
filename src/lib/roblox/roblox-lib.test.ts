import { describe, expect, it } from "vitest";
import { buildManifest } from "@/server/roblox/manifest";
import { parseRobloxFile } from "@/server/roblox/parse";
import { R, writeBinaryModel } from "@/server/roblox/writer";
import { skinnedMeshV4, type TestBone, type TestVertex } from "@/test/roblox-meshes";
import { boneWorldCFrames, buildClip, buildRigSolver, ease, inverse, lerpCFrame, mul, rigCompatibility, sampleClip, type Mat } from "./animation";
import { normalizeContentId } from "./content-id";
import type { ManifestNode } from "./manifest";
import { parseRobloxMesh } from "./mesh";
import { matchSkinBones, skinCandidates } from "./skinning";

const IDENTITY: Mat = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
const rotZ = (deg: number): Mat => {
  const r = (deg * Math.PI) / 180;
  return [0, 0, 0, Math.cos(r), -Math.sin(r), 0, Math.sin(r), Math.cos(r), 0, 0, 0, 1];
};

describe("content ids", () => {
  it("normalises the spellings of the same asset", () => {
    for (const raw of ["rbxassetid://123", "http://www.roblox.com/asset/?id=123", "https://www.roblox.com/asset?id=123&foo=1", "123"]) {
      expect(normalizeContentId(raw)).toBe("rbxassetid://123");
    }
    expect(normalizeContentId("rbxasset://textures/face.png")).toBe("rbxasset://textures/face.png");
    expect(normalizeContentId("  ")).toBeNull();
  });
});

describe("CFrame math", () => {
  it("multiplies and inverts rigid transforms", () => {
    const a: Mat = [1, 2, 3, ...rotZ(90).slice(3)] as Mat;
    const round = (m: Mat) => m.map((v) => Math.round(v * 1e6) / 1e6 + 0);
    expect(round(mul(a, inverse(a)))).toEqual(IDENTITY);
    const half = lerpCFrame(IDENTITY, rotZ(90), 0.5);
    expect(half[3]).toBeCloseTo(Math.cos(Math.PI / 4));
  });
  it("eases like Roblox pose styles", () => {
    expect(ease(0, 0, 0.25)).toBe(0.25); // linear
    expect(ease(1, 0, 0.9)).toBe(0); // constant holds
    expect(ease(3, 1, 0.5)).toBeCloseTo(0.875); // cubic out
    expect(ease(3, 0, 0.5)).toBeCloseTo(0.125); // cubic in
    expect(ease(4, 1, 1)).toBeCloseTo(1); // bounce ends on target
  });
});

describe("keyframe animation on a rig", () => {
  const right = [0, 0, 1, 0, 1, 0, -1, 0, 0];
  const I = (className: string, props: Record<string, never> | Record<string, ReturnType<typeof R.str>>, children: Parameters<typeof writeBinaryModel>[0] = []) => ({ className, props, children });
  const file = writeBinaryModel([
    I("Model", { Name: R.str("R6") }, [
      I("Part", { __id: R.str("hrp"), Name: R.str("HumanoidRootPart"), size: R.v3(2, 2, 1), CFrame: R.cf(0, 3, 0) }, [
        I("Motor6D", { Name: R.str("RootJoint"), Part0: R.ref("hrp"), Part1: R.ref("torso"), C0: R.cf(0, 0, 0), C1: R.cf(0, 0, 0) }),
      ]),
      I("Part", { __id: R.str("torso"), Name: R.str("Torso"), size: R.v3(2, 2, 1), CFrame: R.cf(0, 3, 0) }, [
        I("Motor6D", { Name: R.str("Right Shoulder"), Part0: R.ref("torso"), Part1: R.ref("arm"), C0: R.cf(1, 0.5, 0, right), C1: R.cf(-0.5, 0.5, 0, right) }),
      ]),
      I("Part", { __id: R.str("arm"), Name: R.str("Right Arm"), size: R.v3(1, 2, 1), CFrame: R.cf(1.5, 3, 0) }),
      I("KeyframeSequence", { Name: R.str("Raise") }, [
        I("Keyframe", { Time: R.f32(0) }, [I("Pose", { Name: R.str("HumanoidRootPart"), Weight: R.f32(0) }, [I("Pose", { Name: R.str("Torso"), Weight: R.f32(0) }, [I("Pose", { Name: R.str("Right Arm"), CFrame: R.cf(0, 0, 0), Weight: R.f32(1) })])])]),
        I("Keyframe", { Time: R.f32(1) }, [I("Pose", { Name: R.str("HumanoidRootPart"), Weight: R.f32(0) }, [I("Pose", { Name: R.str("Torso"), Weight: R.f32(0) }, [I("Pose", { Name: R.str("Right Arm"), CFrame: R.cfa(0, 0, 0, 0, 0, 90), Weight: R.f32(1) })])])]),
      ]),
    ]),
  ]);
  const manifest = buildManifest(parseRobloxFile(file));

  it("poses Part1 = Part0 · C0 · Transform · C1⁻¹", () => {
    const clip = buildClip(manifest, manifest.animations[0]!.node);
    expect(clip.length).toBe(1);
    expect([...clip.tracks.values()].map((t) => t.path)).toEqual([["HumanoidRootPart", "Torso", "Right Arm"]]);
    const solver = buildRigSolver(manifest, 0);
    expect(rigCompatibility(clip, solver)).toEqual({ keyed: 1, matched: 1, missing: [] });
    const binding = solver.bind(clip);
    const armNode = manifest.nodes.findIndex((n) => n.n === "Right Arm" && n.c === "Part");

    // Rest pose: the arm hangs at its saved position.
    const rest = solver.solve(sampleClip(clip, 0), binding).parts.get(armNode)!;
    expect(rest.slice(0, 3).map((v) => Math.round(v * 1000) / 1000)).toEqual([1.5, 3, 0]);

    // Rotating the shoulder 90° about its Z axis raises the arm forward (toward -Z).
    const raised = solver.solve(sampleClip(clip, 1), binding).parts.get(armNode)!;
    expect(raised[0]).toBeCloseTo(1.5, 3);
    expect(raised[1]).toBeCloseTo(3.5, 3);
    // The shoulder pivot is 0.5 below the arm top, so the arm centre swings to z = -0.5.
    expect(raised[2]).toBeCloseTo(-0.5, 3);

    // Halfway is interpolated, not snapped.
    const mid = solver.solve(sampleClip(clip, 0.5), binding).parts.get(armNode)!;
    expect(mid[2]).toBeLessThan(0);
    expect(mid[2]).toBeGreaterThan(-0.5);
  });
});

describe("keyframe animation on a skinned (Bone) rig", () => {
  const I = (className: string, props: Record<string, ReturnType<typeof R.str>>, children: Parameters<typeof writeBinaryModel>[0] = []) => ({ className, props, children });
  // Two bones are both called "Hand" (one per arm), like Blender exports often have.
  const poses = (handCf: ReturnType<typeof R.cf>) => [
    I("Pose", { Name: R.str("RootPart"), Weight: R.f32(0) }, [
      I("Pose", { Name: R.str("Hips"), Weight: R.f32(0) }, [
        I("Pose", { Name: R.str("ArmR"), Weight: R.f32(0) }, [I("Pose", { Name: R.str("Hand"), CFrame: handCf, Weight: R.f32(1) })]),
        I("Pose", { Name: R.str("Tail"), CFrame: R.cf(0, 0, 0), Weight: R.f32(1) }),
      ]),
    ]),
  ];
  const file = writeBinaryModel([
    I("Model", { Name: R.str("Creature") }, [
      I("Part", { Name: R.str("RootPart"), size: R.v3(1, 1, 1), CFrame: R.cf(0, 0, 0) }, [
        I("Bone", { Name: R.str("Hips"), CFrame: R.cf(0, 1, 0) }, [
          I("Bone", { Name: R.str("ArmL"), CFrame: R.cf(1, 0, 0) }, [I("Bone", { Name: R.str("Hand"), CFrame: R.cf(1, 0, 0) })]),
          I("Bone", { Name: R.str("ArmR"), CFrame: R.cf(-1, 0, 0) }, [I("Bone", { Name: R.str("Hand"), CFrame: R.cf(-1, 0, 0) })]),
        ]),
      ]),
      I("AnimationController", { Name: R.str("AnimationController") }),
      I("KeyframeSequence", { Name: R.str("Wave") }, [I("Keyframe", { Time: R.f32(0) }, poses(R.cf(0, 0, 0))), I("Keyframe", { Time: R.f32(1) }, poses(R.cfa(0, 0, 0, 0, 0, 90)))]),
    ]),
  ]);
  const manifest = buildManifest(parseRobloxFile(file));
  const node = (name: string, parentName: string) => manifest.nodes.findIndex((n) => n.n === name && manifest.nodes[n.p]?.n === parentName);

  it("detects a rig made only of bones", () => {
    expect(manifest.rigs).toHaveLength(1);
    expect(manifest.rigs[0]!.rigType).toBe("custom");
    expect(manifest.rigs[0]!.joints).toHaveLength(0);
    expect(manifest.rigs[0]!.bones).toHaveLength(5);
    expect(manifest.capabilities.animation).toBe(true);
  });

  it("binds tracks by their pose path, so a repeated bone name finds the right bone", () => {
    const clip = buildClip(manifest, manifest.animations[0]!.node);
    const solver = buildRigSolver(manifest, 0);
    const binding = solver.bind(clip);
    expect(binding.byTarget.get(node("Hand", "ArmR"))).toBeDefined();
    expect(binding.byTarget.has(node("Hand", "ArmL"))).toBe(false);
    // "Tail" is keyed but the rig has no such bone: reported, not silently ignored.
    expect({ keyed: binding.keyed, matched: binding.matched, missing: binding.missing }).toEqual({ keyed: 2, matched: 1, missing: ["Tail"] });
  });

  it("poses bones as Parent · CFrame · Transform", () => {
    const clip = buildClip(manifest, manifest.animations[0]!.node);
    const solver = buildRigSolver(manifest, 0);
    const binding = solver.bind(clip);
    const round = (m: Mat) => m.map((v) => Math.round(v * 1000) / 1000 + 0);
    const world = boneWorldCFrames(manifest, solver, solver.solve(sampleClip(clip, 1), binding));
    // The right hand turned 90° about Z in place; the left one didn't move.
    expect(round(world.get(node("Hand", "ArmR"))!)).toEqual([-2, 1, 0, 0, -1, 0, 1, 0, 0, 0, 0, 1]);
    expect(round(world.get(node("Hand", "ArmL"))!)).toEqual([2, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
    // Rest pose is the saved CFrames.
    const rest = boneWorldCFrames(manifest, solver, solver.solve(sampleClip(clip, 0), binding));
    expect(round(rest.get(node("Hand", "ArmR"))!)).toEqual([-2, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });
});

describe("skinned meshes", () => {
  const bones: TestBone[] = [
    { name: "Root", parent: -1, pos: [0, 0, 0] },
    { name: "Tip", parent: 0, pos: [0, 2, 0] },
  ];
  const verts: TestVertex[] = [
    { pos: [0, 0, 0], weights: [[0, 255]] },
    { pos: [1, 0, 0], weights: [[0, 128], [1, 127]] },
    { pos: [0, 3, 0] },
  ];

  it("reads bones, bind CFrames and normalised weights (mesh v4)", () => {
    const mesh = parseRobloxMesh(skinnedMeshV4(verts, [[0, 1, 2]], bones));
    expect(mesh.skinError).toBeUndefined();
    const skin = mesh.skin!;
    expect(skin.bones.map((b) => [b.name, b.parent, b.cf.slice(0, 3)])).toEqual([
      ["Root", -1, [0, 0, 0]],
      ["Tip", 0, [0, 2, 0]],
    ]);
    expect([...skin.indices.subarray(0, 8)]).toEqual([0, 0, 0, 0, 0, 1, 0, 0]);
    expect(skin.weights[4]! + skin.weights[5]!).toBeCloseTo(1, 6);
    expect(skin.weights[4]).toBeCloseTo(128 / 255, 6);
    // A vertex no bone moves stays with the part (index = bone count).
    expect(skin.indices[8]).toBe(2);
    expect(skin.weights[8]).toBe(1);
    expect(skin.unweighted).toBe(1);
  });

  it("still draws the mesh when its skinning data is damaged", () => {
    const bytes = skinnedMeshV4(verts, [[0, 1, 2]], bones);
    // Claim more subsets than the file holds.
    new DataView(bytes.buffer).setUint16("version 4.00\n".length + 20, 9, true);
    const mesh = parseRobloxMesh(bytes);
    expect(mesh.positions.length).toBe(9);
    expect(mesh.skin).toBeUndefined();
    expect(mesh.skinError).toMatch(/ends early/);
  });

  it("matches mesh bones to Bone instances by name and hierarchy", () => {
    const nodes = [
      { p: -1, c: "Model", n: "M", r: {}, x: [] },
      { p: 0, c: "Part", n: "RootPart", r: {}, x: [] },
      { p: 1, c: "Bone", n: "Hips", r: {}, x: [] },
      { p: 2, c: "Bone", n: "ArmL", r: {}, x: [] },
      { p: 3, c: "Bone", n: "Hand", r: {}, x: [] },
      { p: 2, c: "Bone", n: "ArmR", r: {}, x: [] },
      { p: 5, c: "Bone", n: "Hand", r: {}, x: [] },
      { p: 0, c: "MeshPart", n: "Body", r: {}, x: [] },
    ] satisfies ManifestNode[];
    const children = new Map<number, number[]>();
    nodes.forEach((n, i) => children.set(n.p, [...(children.get(n.p) ?? []), i]));
    const candidates = skinCandidates(nodes, 7, children);
    expect(candidates.sort()).toEqual([2, 3, 4, 5, 6]);
    const meshBones = [
      { name: "Hips", parent: -1, cf: [] },
      { name: "ArmR", parent: 0, cf: [] },
      { name: "Hand", parent: 1, cf: [] },
      { name: "Ghost", parent: 0, cf: [] },
    ];
    expect(matchSkinBones(meshBones, nodes, candidates)).toEqual([2, 5, 6, null]);
  });
});

describe("Roblox mesh parser", () => {
  function v2Mesh(): Uint8Array {
    const header = new TextEncoder().encode("version 2.00\n");
    const verts: number[][] = [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ];
    const body = new DataView(new ArrayBuffer(12 + verts.length * 36 + 12));
    let o = 0;
    body.setUint16(o, 12, true);
    body.setUint8(o + 2, 36);
    body.setUint8(o + 3, 12);
    body.setUint32(o + 4, verts.length, true);
    body.setUint32(o + 8, 1, true);
    o = 12;
    for (const v of verts) {
      [...v, 0, 0, 1, 0.25, 0.75].forEach((f, k) => body.setFloat32(o + k * 4, f, true));
      o += 36;
    }
    [0, 1, 2].forEach((idx, k) => body.setUint32(o + k * 4, idx, true));
    const out = new Uint8Array(header.length + body.byteLength);
    out.set(header);
    out.set(new Uint8Array(body.buffer), header.length);
    return out;
  }

  it("reads binary v2 geometry and flips V", () => {
    const mesh = parseRobloxMesh(v2Mesh());
    expect(mesh.version).toBe("2.00");
    expect([...mesh.positions]).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect([...mesh.indices]).toEqual([0, 1, 2]);
    expect(mesh.uvs[1]).toBeCloseTo(0.25);
  });

  it("reads text v1 (with the v1.00 half scale)", () => {
    const text = "version 1.00\n1\n[2,0,0][0,0,1][0,0,0][0,2,0][0,0,1][1,0,0][0,0,2][0,0,1][0,1,0]";
    const mesh = parseRobloxMesh(new TextEncoder().encode(text));
    expect([...mesh.positions.subarray(0, 3)]).toEqual([1, 0, 0]);
    expect(mesh.indices).toHaveLength(3);
  });

  it("explains Draco-compressed and invalid meshes", () => {
    const header = new TextEncoder().encode("version 7.00\n");
    const chunk = new Uint8Array(16 + 8);
    chunk.set(new TextEncoder().encode("COREMESH"));
    new DataView(chunk.buffer).setUint32(8, 2, true);
    new DataView(chunk.buffer).setUint32(12, 8, true);
    const file = new Uint8Array(header.length + chunk.length);
    file.set(header);
    file.set(chunk, header.length);
    expect(() => parseRobloxMesh(file)).toThrow(/Draco/);
    expect(() => parseRobloxMesh(new TextEncoder().encode("not a mesh"))).toThrow(/Not a Roblox mesh/);
    const broken = v2Mesh();
    new DataView(broken.buffer).setUint32(broken.length - 4, 99, true);
    expect(() => parseRobloxMesh(broken)).toThrow(/doesn't exist/);
  });
});
