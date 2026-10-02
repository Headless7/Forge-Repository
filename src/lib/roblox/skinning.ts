/**
 * Skinned MeshParts: which Bone instances deform a mesh, and where its bones sit in the part.
 *
 * Roblox deforms each vertex as Σ wᵢ · Boneᵢ.TransformedWorldCFrame · Bindᵢ⁻¹ · vertex, where
 * Bindᵢ is the bone's bind CFrame stored in the mesh, placed in the part like the vertices
 * are (mesh space → part space). Mesh bones are found by name among the Bones of the
 * MeshPart's model; a mesh bone with no Bone instance stays at its bind pose (its vertices
 * don't move).
 */
import type { Mat } from "./animation";
import type { ManifestNode } from "./manifest";
import type { MeshBone } from "./mesh";

const SCOPES = new Set(["Model", "Actor", "WorldModel", "Accessory", "Tool"]);

/** Bone nodes a MeshPart can be skinned to: those in its nearest model (or its whole tree). */
export function skinCandidates(nodes: ManifestNode[], meshPart: number, children: Map<number, number[]>): number[] {
  let scope = nodes[meshPart]!.p;
  while (scope !== -1 && !SCOPES.has(nodes[scope]!.c)) {
    const parent = nodes[scope]!.p;
    if (parent === -1) break;
    scope = parent;
  }
  const out: number[] = [];
  const stack = scope === -1 ? [meshPart] : [...(children.get(scope) ?? [])];
  while (stack.length) {
    const i = stack.pop()!;
    if (nodes[i]!.c === "Bone") out.push(i);
    stack.push(...(children.get(i) ?? []));
  }
  return out;
}

function nodeChain(nodes: ManifestNode[], i: number): string[] {
  const chain: string[] = [];
  for (let p = i; p !== -1 && nodes[p]!.c === "Bone"; p = nodes[p]!.p) chain.unshift(nodes[p]!.n);
  return chain;
}

function meshChain(bones: MeshBone[], i: number): string[] {
  const chain: string[] = [];
  for (let p = i, guard = 0; p !== -1 && p < bones.length && guard < bones.length; p = bones[p]!.parent, guard++) chain.unshift(bones[p]!.name);
  return chain;
}

/**
 * For each mesh bone, the Bone node that drives it (or null). Names decide; when several
 * Bones share a name, the one whose parent chain matches the mesh's skeleton wins.
 */
export function matchSkinBones(bones: MeshBone[], nodes: ManifestNode[], candidates: number[]): Array<number | null> {
  const byName = new Map<string, number[]>();
  for (const i of candidates) byName.set(nodes[i]!.n, [...(byName.get(nodes[i]!.n) ?? []), i]);
  return bones.map((bone, b) => {
    const options = byName.get(bone.name);
    if (!options?.length) return null;
    if (options.length === 1) return options[0]!;
    const want = meshChain(bones, b);
    let best = options[0]!;
    let bestScore = -1;
    for (const option of options) {
      const have = nodeChain(nodes, option);
      let score = 0;
      while (score < want.length && score < have.length && want[want.length - 1 - score] === have[have.length - 1 - score]) score++;
      if (score > bestScore) {
        best = option;
        bestScore = score;
      }
    }
    return best;
  });
}

/**
 * A mesh-space bind CFrame placed in the part: the same centring and per-axis scale as the
 * vertices (CFrames carry no scale, so only the position is scaled).
 */
export function bindInPart(cf: number[], center: number[], scale: number[]): Mat {
  return [
    (cf[0]! - center[0]!) * scale[0]!,
    (cf[1]! - center[1]!) * scale[1]!,
    (cf[2]! - center[2]!) * scale[2]!,
    cf[3]!,
    cf[4]!,
    cf[5]!,
    cf[6]!,
    cf[7]!,
    cf[8]!,
    cf[9]!,
    cf[10]!,
    cf[11]!,
  ];
}
