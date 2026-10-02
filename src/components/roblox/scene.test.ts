import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { buildClip, buildRigSolver, sampleClip, type Mat } from "@/lib/roblox/animation";
import { parseRobloxMesh } from "@/lib/roblox/mesh";
import { buildManifest } from "@/server/roblox/manifest";
import { parseRobloxFile } from "@/server/roblox/parse";
import { R, writeBinaryModel } from "@/server/roblox/writer";
import { skinnedMeshV4 } from "@/test/roblox-meshes";
import { geometryFromMesh, type ResourceStore } from "./resources";
import { buildScene, matrixFromCFrame } from "./scene";

/**
 * The viewer's skinned-mesh setup, checked on the CPU with three.js's own skinning maths
 * (SkinnedMesh.applyBoneTransform is what the GPU shader computes).
 */
describe("skinned MeshPart deformation", () => {
  const I = (className: string, props: Record<string, ReturnType<typeof R.str>>, children: Parameters<typeof writeBinaryModel>[0] = []) => ({ className, props, children });
  const pose = (tip: ReturnType<typeof R.cf>) => [
    I("Pose", { Name: R.str("RootPart"), Weight: R.f32(0) }, [I("Pose", { Name: R.str("Root"), Weight: R.f32(0) }, [I("Pose", { Name: R.str("Tip"), CFrame: tip, Weight: R.f32(1) })])]),
  ];
  const file = writeBinaryModel([
    I("Model", { Name: R.str("Rig") }, [
      I("Part", { Name: R.str("RootPart"), size: R.v3(1, 1, 1), CFrame: R.cf(0, 0, 0), Transparency: R.f32(1) }, [
        I("Bone", { Name: R.str("Root"), CFrame: R.cf(0, 0, 0) }, [I("Bone", { Name: R.str("Tip"), CFrame: R.cf(0, 2, 0) })]),
      ]),
      // The mesh's bounds are x 0–1, y 0–3, so the part sits at their centre with the same size.
      I("MeshPart", { Name: R.str("Body"), size: R.v3(1, 3, 1), InitialSize: R.v3(1, 3, 1), CFrame: R.cf(0.5, 1.5, 0), MeshId: R.str("rbxassetid://1") }),
      I("KeyframeSequence", { Name: R.str("Bend") }, [I("Keyframe", { Time: R.f32(0) }, pose(R.cf(0, 0, 0))), I("Keyframe", { Time: R.f32(1) }, pose(R.cfa(0, 0, 0, 0, 0, 90)))]),
    ]),
  ]);
  const manifest = buildManifest(parseRobloxFile(file));
  // Bind pose: "Root" at the origin, "Tip" 2 studs up; "Ghost" has no Bone in the file.
  const mesh = parseRobloxMesh(
    skinnedMeshV4(
      [
        { pos: [0, 0, 0], weights: [[0, 255]] },
        { pos: [1, 0, 0], weights: [[0, 255]] },
        { pos: [0, 3, 0], weights: [[1, 255]] },
        { pos: [1, 3, 0], weights: [[2, 255]] },
      ],
      [
        [0, 1, 2],
        [0, 3, 1],
      ],
      [
        { name: "Root", parent: -1, pos: [0, 0, 0] },
        { name: "Tip", parent: 0, pos: [0, 2, 0] },
        { name: "Ghost", parent: 0, pos: [1, 2, 0] },
      ],
    ),
  );

  async function build() {
    const store = { geometry: async () => geometryFromMesh(mesh), texture: async () => null, has: () => false } as unknown as ResourceStore;
    const built = buildScene(manifest, store);
    await built.ready;
    built.root.updateMatrixWorld(true);
    const body = manifest.nodes.findIndex((n) => n.n === "Body");
    const skinned = built.partObjects.get(body)!.children.find((c) => (c as THREE.SkinnedMesh).isSkinnedMesh) as THREE.SkinnedMesh;
    // Vertex position in the world, as the GPU would draw it. (Geometry is non-indexed: face corners in order.)
    const world = (corner: number) => {
      const v = new THREE.Vector3().fromBufferAttribute(skinned.geometry.getAttribute("position") as THREE.BufferAttribute, corner);
      return skinned.applyBoneTransform(corner, v).applyMatrix4(skinned.matrixWorld).toArray().map((x) => Math.round(x * 1000) / 1000 + 0);
    };
    return { built, skinned, world };
  }

  it("draws a skinned MeshPart as a SkinnedMesh bound to the file's bones", async () => {
    const { built, skinned, world } = await build();
    expect(skinned).toBeDefined();
    expect(built.runtime.skin).toEqual({ meshes: 1, boundBones: 2, unboundBones: ["Ghost"], errors: [] });
    // Rest pose: exactly where the mesh was modelled.
    expect(world(0)).toEqual([0, 0, 0]);
    expect(world(2)).toEqual([0, 3, 0]);
    expect(world(4)).toEqual([1, 3, 0]);
  });

  it("deforms the mesh when the animation turns a bone", async () => {
    const { built, world } = await build();
    const solver = buildRigSolver(manifest, 0);
    const clip = buildClip(manifest, manifest.animations[0]!.node);
    const posed = solver.solve(sampleClip(clip, 1), solver.bind(clip));
    // What the viewer does every frame:
    for (const [node, cf] of posed.bones) built.boneObjects.get(node)!.matrix.copy(matrixFromCFrame(cf as Mat));
    for (const [node, cf] of posed.parts) built.partObjects.get(node)!.matrix.copy(matrixFromCFrame(cf as Mat));
    built.root.updateMatrixWorld(true);
    // "Tip" turned 90° about Z around (0, 2, 0): the vertex 1 stud above it swings to its -X side.
    expect(world(2)).toEqual([-1, 2, 0]);
    // Vertices on "Root" stay; the one on the unbound "Ghost" bone stays in its bind pose.
    expect(world(0)).toEqual([0, 0, 0]);
    expect(world(1)).toEqual([1, 0, 0]);
    expect(world(4)).toEqual([1, 3, 0]);
  });
});
