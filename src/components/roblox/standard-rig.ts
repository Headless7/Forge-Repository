import type { ManifestNode, RobloxManifest } from "@/lib/roblox/manifest";
import { ROBLOX_MANIFEST_VERSION } from "@/lib/roblox/manifest";

/**
 * A blocky R6 rig with Roblox's standard R6 joint frames, for previewing R6
 * animations when no rig was provided. It's labelled as a stand-in everywhere:
 * it shows the motion, not the real character.
 */
const R6_ROOT = [-1, 0, 0, 0, 0, 1, 0, 1, 0];
const R6_RIGHT = [0, 0, 1, 0, 1, 0, -1, 0, 0];
const R6_LEFT = [0, 0, -1, 0, 1, 0, 1, 0, 0];

export const R6_JOINTS = ["Torso", "Head", "Left Arm", "Right Arm", "Left Leg", "Right Leg"];

export function looksLikeR6(joints: string[]) {
  const set = new Set(joints);
  return joints.length > 0 && joints.every((j) => R6_JOINTS.includes(j)) && (set.has("Torso") || set.has("Left Arm"));
}

export function standardR6Manifest(): RobloxManifest {
  const nodes: ManifestNode[] = [];
  const add = (node: Omit<ManifestNode, "x">) => {
    nodes.push({ ...node, x: [] });
    return nodes.length - 1;
  };
  const model = add({ p: -1, c: "Model", n: "Standard R6 rig (stand-in)", r: {} });
  const part = (name: string, size: number[], pos: number[], color: number[], transparency = 0) =>
    add({ p: model, c: "Part", n: name, r: { cf: [...pos, 1, 0, 0, 0, 1, 0, 0, 0, 1], size, color, tr: transparency, refl: 0, mat: 256, shape: 1, shadow: true } });
  const grey = [0.64, 0.64, 0.66];
  const hrp = part("HumanoidRootPart", [2, 2, 1], [0, 3, 0], grey, 1);
  const torso = part("Torso", [2, 2, 1], [0, 3, 0], [0.3, 0.45, 0.7]);
  const head = part("Head", [2, 1, 1], [0, 4.5, 0], [0.96, 0.8, 0.41]);
  add({ p: head, c: "SpecialMesh", n: "Mesh", r: { meshType: 0, scale: [1.25, 1.25, 1.25], offset: [0, 0, 0], vcolor: [1, 1, 1] } });
  const la = part("Left Arm", [1, 2, 1], [-1.5, 3, 0], [0.96, 0.8, 0.41]);
  const ra = part("Right Arm", [1, 2, 1], [1.5, 3, 0], [0.96, 0.8, 0.41]);
  const ll = part("Left Leg", [1, 2, 1], [-0.5, 1, 0], [0.2, 0.25, 0.3]);
  const rl = part("Right Leg", [1, 2, 1], [0.5, 1, 0], [0.2, 0.25, 0.3]);
  const motor = (parent: number, name: string, p0: number, p1: number, c0: number[], c1: number[]) =>
    add({ p: parent, c: "Motor6D", n: name, r: { p0, p1, c0, c1 } });
  const joints = [
    motor(hrp, "RootJoint", hrp, torso, [0, 0, 0, ...R6_ROOT], [0, 0, 0, ...R6_ROOT]),
    motor(torso, "Neck", torso, head, [0, 1, 0, ...R6_ROOT], [0, -0.5, 0, ...R6_ROOT]),
    motor(torso, "Right Shoulder", torso, ra, [1, 0.5, 0, ...R6_RIGHT], [-0.5, 0.5, 0, ...R6_RIGHT]),
    motor(torso, "Left Shoulder", torso, la, [-1, 0.5, 0, ...R6_LEFT], [0.5, 0.5, 0, ...R6_LEFT]),
    motor(torso, "Right Hip", torso, rl, [1, -1, 0, ...R6_RIGHT], [0.5, 1, 0, ...R6_RIGHT]),
    motor(torso, "Left Hip", torso, ll, [-1, -1, 0, ...R6_LEFT], [-0.5, 1, 0, ...R6_LEFT]),
  ];
  add({ p: model, c: "Humanoid", n: "Humanoid", r: { rigType: 0, hipHeight: 0 } });
  const byNode = new Map(nodes.map((n, i) => [i, n]));
  return {
    v: ROBLOX_MANIFEST_VERSION,
    format: "binary",
    nodes,
    classCounts: {},
    summary: { parts: 7, meshParts: 0, unions: 0, animations: 0, emitters: 0, beams: 0, trails: 0, lights: 0, legacyEffects: 0, scripts: 0, guis: 0, guiObjects: 0 },
    capabilities: { model: true, animation: false, effects: false, ui: false },
    animations: [],
    rigs: [{ node: model, name: "Standard R6 rig (stand-in)", rigType: "R6", rootPart: hrp, joints: joints.map((j) => ({ node: j, part0: byNode.get(j)!.r.p0 as number, part1: byNode.get(j)!.r.p1 as number })) }],
    resources: [],
    support: [],
    warnings: [],
  };
}
