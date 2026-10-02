/**
 * KeyframeSequence playback. Pure math (no rendering) so it can be unit-tested and
 * shared by the viewer.
 *
 * A KeyframeSequence holds Keyframes (Time) containing a Pose tree that mirrors the rig:
 * the root part, then Motor6D joints by their Part1 names, and Bones (skinned rigs) under
 * the part — and the bone — they hang from. Each Pose.CFrame is that joint's Transform:
 *   Motor6D:  Part1 = Part0 · C0 · Transform · C1⁻¹
 *   Bone:     World = Parent · CFrame · Transform
 * Tracks keep their full pose path, so repeated names (e.g. two "Hand" bones under
 * different arms) bind to the right joint.
 */
import type { ManifestNode, RobloxManifest } from "./manifest";

export type Mat = [number, number, number, number, number, number, number, number, number, number, number, number]; // CFrame12

export interface PoseKey {
  time: number;
  cf: Mat;
  easingStyle: number;
  easingDirection: number;
}

export interface Track {
  /** The joint's name (the last pose name in the path). */
  name: string;
  /** Pose names from the sequence's root pose down to this one. */
  path: string[];
  keys: PoseKey[];
}

export interface AnimationClip {
  name: string;
  length: number;
  loop: boolean;
  /** By path key (see `pathKey`). */
  tracks: Map<string, Track>;
  markers: Array<{ time: number; name: string }>;
  keyTimes: number[];
}

/** Map key for a pose path (names can contain "/", so a control character separates them). */
export const pathKey = (path: string[]) => path.join("\u001f");

const IDENTITY: Mat = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];

function children(nodes: ManifestNode[], parent: number): number[] {
  const out: number[] = [];
  nodes.forEach((n, i) => {
    if (n.p === parent) out.push(i);
  });
  return out;
}

/** Builds per-joint tracks from a KeyframeSequence node. Poses with Weight 0 only carry hierarchy. */
export function buildClip(manifest: RobloxManifest, sequenceNode: number): AnimationClip {
  const nodes = manifest.nodes;
  const childIndex = new Map<number, number[]>();
  nodes.forEach((n, i) => {
    const list = childIndex.get(n.p) ?? [];
    list.push(i);
    childIndex.set(n.p, list);
  });
  const kids = (i: number) => childIndex.get(i) ?? children(nodes, i);
  const tracks = new Map<string, Track>();
  const markers: AnimationClip["markers"] = [];
  const keyTimes: number[] = [];
  let length = 0;

  for (const kf of kids(sequenceNode)) {
    const node = nodes[kf]!;
    if (node.c !== "Keyframe") continue;
    const time = Number(node.r.time ?? 0);
    length = Math.max(length, time);
    keyTimes.push(time);
    if (node.n && node.n !== "Keyframe") markers.push({ time, name: node.n });
    const walk = (i: number, parentPath: string[]) => {
      for (const c of kids(i)) {
        const child = nodes[c]!;
        if (child.c === "KeyframeMarker") markers.push({ time, name: child.n });
        if (child.c !== "Pose") continue;
        const path = [...parentPath, child.n];
        const weight = Number(child.r.w ?? 1);
        if (weight > 0 && child.n !== "HumanoidRootPart") {
          const key = pathKey(path);
          const track = tracks.get(key) ?? { name: child.n, path, keys: [] };
          track.keys.push({
            time,
            cf: (child.r.cf as Mat) ?? IDENTITY,
            easingStyle: Number(child.r.es ?? 0),
            easingDirection: Number(child.r.ed ?? 0),
          });
          tracks.set(key, track);
        }
        walk(c, path);
      }
    };
    walk(kf, []);
  }
  for (const track of tracks.values()) track.keys.sort((a, b) => a.time - b.time);
  const seq = nodes[sequenceNode]!;
  return {
    name: seq.n,
    length,
    loop: Boolean(seq.r.loop),
    tracks,
    markers: markers.sort((a, b) => a.time - b.time),
    keyTimes: [...new Set(keyTimes)].sort((a, b) => a - b),
  };
}

// ── Easing (Enum.PoseEasingStyle / PoseEasingDirection: In=0, Out=1, InOut=2) ──

function bounceOut(t: number) {
  const n = 7.5625;
  const d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
}

function elasticOut(t: number) {
  if (t === 0 || t === 1) return t;
  return Math.pow(2, -10 * t) * Math.sin(((t * 10 - 0.75) * (2 * Math.PI)) / 3) + 1;
}

function withDirection(out: (t: number) => number, direction: number, t: number) {
  const inFn = (x: number) => 1 - out(1 - x);
  if (direction === 1) return out(t);
  if (direction === 2) return t < 0.5 ? inFn(t * 2) / 2 : 0.5 + out(t * 2 - 1) / 2;
  return inFn(t);
}

export function ease(style: number, direction: number, t: number): number {
  const x = Math.min(1, Math.max(0, t));
  switch (style) {
    case 1: // Constant: hold the previous pose until the next keyframe
      return 0;
    case 2:
      return withDirection(elasticOut, direction, x);
    case 3:
    case 5: // Cubic, CubicV2
      return withDirection((v) => 1 - Math.pow(1 - v, 3), direction, x);
    case 4:
      return withDirection(bounceOut, direction, x);
    default:
      return x; // Linear
  }
}

// ── CFrame math on 12-number arrays ─────────────────────────────────────────

export function mul(a: Mat, b: Mat): Mat {
  const [ax, ay, az, a00, a01, a02, a10, a11, a12, a20, a21, a22] = a;
  const [bx, by, bz, b00, b01, b02, b10, b11, b12, b20, b21, b22] = b;
  return [
    a00 * bx + a01 * by + a02 * bz + ax,
    a10 * bx + a11 * by + a12 * bz + ay,
    a20 * bx + a21 * by + a22 * bz + az,
    a00 * b00 + a01 * b10 + a02 * b20,
    a00 * b01 + a01 * b11 + a02 * b21,
    a00 * b02 + a01 * b12 + a02 * b22,
    a10 * b00 + a11 * b10 + a12 * b20,
    a10 * b01 + a11 * b11 + a12 * b21,
    a10 * b02 + a11 * b12 + a12 * b22,
    a20 * b00 + a21 * b10 + a22 * b20,
    a20 * b01 + a21 * b11 + a22 * b21,
    a20 * b02 + a21 * b12 + a22 * b22,
  ];
}

/** Inverse of a rigid transform (rotation transposed). */
export function inverse(m: Mat): Mat {
  const [x, y, z, r00, r01, r02, r10, r11, r12, r20, r21, r22] = m;
  return [
    -(r00 * x + r10 * y + r20 * z),
    -(r01 * x + r11 * y + r21 * z),
    -(r02 * x + r12 * y + r22 * z),
    r00,
    r10,
    r20,
    r01,
    r11,
    r21,
    r02,
    r12,
    r22,
  ];
}

type Quat = [number, number, number, number];

function toQuat(m: Mat): Quat {
  const [, , , m00, m01, m02, m10, m11, m12, m20, m21, m22] = m;
  const trace = m00 + m11 + m22;
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    w = 0.25 / s;
    x = (m21 - m12) * s;
    y = (m02 - m20) * s;
    z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  const len = Math.hypot(x, y, z, w) || 1;
  return [x / len, y / len, z / len, w / len];
}

function fromQuat([x, y, z, w]: Quat, px: number, py: number, pz: number): Mat {
  return [
    px,
    py,
    pz,
    1 - 2 * (y * y + z * z),
    2 * (x * y - z * w),
    2 * (x * z + y * w),
    2 * (x * y + z * w),
    1 - 2 * (x * x + z * z),
    2 * (y * z - x * w),
    2 * (x * z - y * w),
    2 * (y * z + x * w),
    1 - 2 * (x * x + y * y),
  ];
}

function slerp(a: Quat, b: Quat, t: number): Quat {
  let [bx, by, bz, bw] = b;
  let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  if (cos > 0.9995) {
    const q: Quat = [a[0] + (bx - a[0]) * t, a[1] + (by - a[1]) * t, a[2] + (bz - a[2]) * t, a[3] + (bw - a[3]) * t];
    const len = Math.hypot(...q) || 1;
    return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
  }
  const theta = Math.acos(cos);
  const sin = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sin;
  const wb = Math.sin(t * theta) / sin;
  return [a[0] * wa + bx * wb, a[1] * wa + by * wb, a[2] * wa + bz * wb, a[3] * wa + bw * wb];
}

export function lerpCFrame(a: Mat, b: Mat, t: number): Mat {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const q = slerp(toQuat(a), toQuat(b), t);
  return fromQuat(q, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
}

/** Joint transforms at time `t` (seconds), by track key. The pose at the start of a segment decides its easing. */
export function sampleClip(clip: AnimationClip, t: number): Map<string, Mat> {
  const out = new Map<string, Mat>();
  for (const [joint, { keys }] of clip.tracks) {
    if (!keys.length) continue;
    if (t <= keys[0]!.time) {
      out.set(joint, keys[0]!.cf);
      continue;
    }
    const last = keys[keys.length - 1]!;
    if (t >= last.time) {
      out.set(joint, last.cf);
      continue;
    }
    let i = 0;
    while (i < keys.length - 1 && keys[i + 1]!.time <= t) i++;
    const k0 = keys[i]!;
    const k1 = keys[i + 1]!;
    const span = k1.time - k0.time;
    const alpha = span > 0 ? ease(k0.easingStyle, k0.easingDirection, (t - k0.time) / span) : 1;
    out.set(joint, lerpCFrame(k0.cf, k1.cf, alpha));
  }
  return out;
}

export interface RigPart {
  node: number;
  name: string;
  /** Saved world CFrame. */
  rest: Mat;
}

export interface RigBone {
  node: number;
  name: string;
  /** Saved CFrame, relative to the parent bone or part. */
  rest: Mat;
}

/** Something an animation track can drive: a Motor6D (by its Part1) or a Bone. */
export interface RigTarget {
  kind: "joint" | "bone";
  /** The Motor6D/Motor or Bone node. */
  node: number;
  name: string;
  /** Names from the rig's root part down to this joint — the pose path that animates it. */
  path: string[];
}

/** Which track drives which target, for one clip on one rig. */
export interface ClipBinding {
  /** Target node → track key. */
  byTarget: Map<number, string>;
  /** Keyed joints that found a target. */
  matched: number;
  /** Names of keyed joints the rig doesn't have. */
  missing: string[];
  keyed: number;
}

export interface SolvedPose {
  /** World CFrame of every rig part. */
  parts: Map<number, Mat>;
  /** Every bone's CFrame relative to its parent (CFrame · Transform). */
  bones: Map<number, Mat>;
}

export interface RigSolver {
  parts: Map<number, RigPart>;
  bones: Map<number, RigBone>;
  targets: RigTarget[];
  bind: (clip: AnimationClip) => ClipBinding;
  /** The rig posed with sampled track transforms (see `sampleClip`). */
  solve: (transforms: Map<string, Mat>, binding: ClipBinding) => SolvedPose;
}

const JOINTS = new Set(["Motor6D", "Motor", "Weld", "ManualWeld", "Snap", "Glue"]);

/** How many trailing names two paths share (the joint's own name included). */
function sharedSuffix(a: string[], b: string[]) {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

/**
 * Builds a solver for a rig in a manifest: Motor6D joints and Bones are animated, other
 * welds are rigid, and anything not connected to the root keeps its saved position.
 */
export function buildRigSolver(manifest: RobloxManifest, rigIndex: number): RigSolver {
  const rig = manifest.rigs[rigIndex]!;
  const nodes = manifest.nodes;
  const parts = new Map<number, RigPart>();
  // (Binary files don't list parents before children: walk the tree.)
  const childIndex = new Map<number, number[]>();
  nodes.forEach((n, i) => {
    const list = childIndex.get(n.p);
    if (list) list.push(i);
    else childIndex.set(n.p, [i]);
  });
  const inRig = new Uint8Array(nodes.length);
  for (const stack = [...(childIndex.get(rig.node) ?? [])]; stack.length; ) {
    const i = stack.pop()!;
    if (inRig[i]) continue;
    inRig[i] = 1;
    stack.push(...(childIndex.get(i) ?? []));
  }
  const within = (i: number) => inRig[i] === 1;
  nodes.forEach((n, i) => {
    if (n.r.cf && n.r.size && within(i)) parts.set(i, { node: i, name: n.n, rest: n.r.cf as Mat });
  });
  type Joint = { node: number; part0: number; part1: number; c0: Mat; c1inv: Mat; animated: boolean };
  const joints: Joint[] = [];
  nodes.forEach((n, i) => {
    if (!within(i) || !JOINTS.has(n.c)) return;
    const p0 = n.r.p0 as number | null;
    const p1 = n.r.p1 as number | null;
    if (typeof p0 !== "number" || typeof p1 !== "number" || !parts.has(p0) || !parts.has(p1)) return;
    joints.push({ node: i, part0: p0, part1: p1, c0: n.r.c0 as Mat, c1inv: inverse(n.r.c1 as Mat), animated: n.c === "Motor6D" || n.c === "Motor" });
  });
  const byPart0 = new Map<number, Joint[]>();
  for (const j of joints) byPart0.set(j.part0, [...(byPart0.get(j.part0) ?? []), j]);
  const root = rig.rootPart ?? joints.find((j) => !joints.some((k) => k.part1 === j.part0))?.part0 ?? null;

  // Pose paths: the root part, then each joint's Part1 along the joint tree.
  const partPath = new Map<number, string[]>();
  const order: Joint[] = [];
  if (root !== null && parts.has(root)) {
    partPath.set(root, [nodes[root]!.n]);
    const queue = [root];
    while (queue.length) {
      const part0 = queue.shift()!;
      for (const j of byPart0.get(part0) ?? []) {
        if (partPath.has(j.part1)) continue;
        partPath.set(j.part1, [...partPath.get(part0)!, nodes[j.part1]!.n]);
        order.push(j);
        queue.push(j.part1);
      }
    }
  }
  const pathOfPart = (i: number) => partPath.get(i) ?? [nodes[i]!.n];

  // Bones hang from a part (directly or through other bones); their path continues the part's.
  // (Bones not mounted on a part do nothing in Roblox either.) Parents are added before children.
  const bones = new Map<number, RigBone>();
  const bonePath = new Map<number, string[]>();
  const mount = (parent: number, base: string[]) => {
    for (const i of childIndex.get(parent) ?? []) {
      const n = nodes[i]!;
      if (n.c !== "Bone") continue;
      const path = [...base, n.n];
      bones.set(i, { node: i, name: n.n, rest: (n.r.cf as Mat) ?? IDENTITY });
      bonePath.set(i, path);
      mount(i, path);
    }
  };
  for (const i of parts.keys()) mount(i, pathOfPart(i));

  const targets: RigTarget[] = [
    ...order.filter((j) => j.animated).map((j) => ({ kind: "joint" as const, node: j.node, name: nodes[j.part1]!.n, path: partPath.get(j.part1)! })),
    ...[...bones.values()].map((b) => ({ kind: "bone" as const, node: b.node, name: b.name, path: bonePath.get(b.node)! })),
  ];
  const targetsByName = new Map<string, RigTarget[]>();
  for (const t of targets) targetsByName.set(t.name, [...(targetsByName.get(t.name) ?? []), t]);

  return {
    parts,
    bones,
    targets,
    bind: (clip) => {
      // Names first; when several joints share a name, the one whose ancestors match the pose path wins.
      const best = new Map<number, { key: string; score: number }>();
      const missing: string[] = [];
      let keyed = 0;
      for (const [key, track] of clip.tracks) {
        const candidates = targetsByName.get(track.name);
        if (!candidates) {
          // A root pose (e.g. "RootPart") only anchors the tree; it isn't a joint.
          if (track.path.length > 1) {
            keyed++;
            missing.push(track.name);
          }
          continue;
        }
        keyed++;
        let pick = candidates[0]!;
        let score = -1;
        for (const c of candidates) {
          const s = sharedSuffix(track.path, c.path);
          if (s > score) {
            pick = c;
            score = s;
          }
        }
        const previous = best.get(pick.node);
        if (!previous || score > previous.score) best.set(pick.node, { key, score });
      }
      const byTarget = new Map([...best].map(([node, { key }]) => [node, key]));
      return { byTarget, matched: byTarget.size, missing: [...new Set(missing)], keyed };
    },
    solve: (transforms, binding) => {
      const at = (node: number) => {
        const key = binding.byTarget.get(node);
        return (key !== undefined ? transforms.get(key) : undefined) ?? IDENTITY;
      };
      const world = new Map<number, Mat>();
      for (const [i, p] of parts) world.set(i, p.rest);
      for (const j of order) world.set(j.part1, mul(mul(mul(world.get(j.part0)!, j.c0), j.animated ? at(j.node) : IDENTITY), j.c1inv));
      const local = new Map<number, Mat>();
      for (const [i, b] of bones) local.set(i, binding.byTarget.has(i) ? mul(b.rest, at(i)) : b.rest);
      return { parts: world, bones: local };
    },
  };
}

/** How well an animation fits a rig: which keyed joints exist on it. */
export function rigCompatibility(clip: AnimationClip, solver: RigSolver) {
  const { keyed, matched, missing } = solver.bind(clip);
  return { keyed, matched, missing };
}

/** World CFrames of a rig's bones for a solved pose (parents before children). */
export function boneWorldCFrames(manifest: RobloxManifest, solver: RigSolver, pose: SolvedPose): Map<number, Mat> {
  const out = new Map<number, Mat>();
  for (const [i] of solver.bones) {
    const p = manifest.nodes[i]!.p;
    const parent = out.get(p) ?? pose.parts.get(p) ?? IDENTITY;
    out.set(i, mul(parent, pose.bones.get(i)!));
  }
  return out;
}
