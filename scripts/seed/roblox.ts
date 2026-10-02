/**
 * Generates the demo Roblox files, stand-in resources and audio used by the seed.
 * The .rbxm files are written with the binary writer (validated against Roblox
 * Studio's own exports by the parser tests), so they exercise the real preview path.
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { runFfmpeg } from "@/server/media/ffmpeg";
import type { RbxValue } from "@/server/roblox/model";
import { encodeAttributes, R, writeBinaryModel, type WriteInstance } from "@/server/roblox/writer";

const I = (className: string, props: Record<string, RbxValue>, children: WriteInstance[] = []): WriteInstance => ({ className, props, children });

// Standard R6 joint frames (identical to the ones Roblox Studio writes).
const R6 = {
  root: [-1, 0, 0, 0, 0, 1, 0, 1, 0],
  right: [0, 0, 1, 0, 1, 0, -1, 0, 0],
  left: [0, 0, -1, 0, 1, 0, 1, 0, 0],
};

function part(name: string, size: [number, number, number], pos: [number, number, number], rgb: [number, number, number], extra: Record<string, RbxValue> = {}, children: WriteInstance[] = []) {
  return I("Part", { __id: R.str(name), Name: R.str(name), size: R.v3(...size), CFrame: R.cf(...pos), Color3uint8: R.rgb(...rgb), Anchored: R.bool(true), Material: R.enum(256), ...extra }, children);
}

function motor(name: string, p0: string, p1: string, c0: [number, number, number, number[]], c1: [number, number, number, number[]]) {
  return I("Motor6D", { Name: R.str(name), Part0: R.ref(p0), Part1: R.ref(p1), C0: R.cf(c0[0], c0[1], c0[2], c0[3]), C1: R.cf(c1[0], c1[1], c1[2], c1[3]) });
}

/** A blocky R6 character rig with Motor6D joints and a Humanoid. */
function r6Rig(name: string, extraChildren: WriteInstance[] = []): WriteInstance {
  const skin: [number, number, number] = [234, 184, 146];
  const robe: [number, number, number] = [44, 36, 66];
  const pants: [number, number, number] = [28, 26, 34];
  return I("Model", { Name: R.str(name), PrimaryPart: R.ref("HumanoidRootPart") }, [
    part("HumanoidRootPart", [2, 2, 1], [0, 3, 0], [163, 162, 165], { Transparency: R.f32(1) }, [
      motor("RootJoint", "HumanoidRootPart", "Torso", [0, 0, 0, R6.root], [0, 0, 0, R6.root]),
    ]),
    part("Torso", [2, 2, 1], [0, 3, 0], robe, {}, [
      motor("Neck", "Torso", "Head", [0, 1, 0, R6.root], [0, -0.5, 0, R6.root]),
      motor("Right Shoulder", "Torso", "Right Arm", [1, 0.5, 0, R6.right], [-0.5, 0.5, 0, R6.right]),
      motor("Left Shoulder", "Torso", "Left Arm", [-1, 0.5, 0, R6.left], [0.5, 0.5, 0, R6.left]),
      motor("Right Hip", "Torso", "Right Leg", [1, -1, 0, R6.right], [0.5, 1, 0, R6.right]),
      motor("Left Hip", "Torso", "Left Leg", [-1, -1, 0, R6.left], [-0.5, 1, 0, R6.left]),
    ]),
    part("Head", [2, 1, 1], [0, 4.5, 0], skin, {}, [
      I("SpecialMesh", { MeshType: R.enum(0), Scale: R.v3(1.25, 1.25, 1.25) }),
      I("Decal", { Name: R.str("face"), Texture: R.str("rbxasset://textures/face.png"), Face: R.enum(5) }),
    ]),
    part("Left Arm", [1, 2, 1], [-1.5, 3, 0], skin),
    part("Right Arm", [1, 2, 1], [1.5, 3, 0], skin),
    part("Left Leg", [1, 2, 1], [-0.5, 1, 0], pants),
    part("Right Leg", [1, 2, 1], [0.5, 1, 0], pants),
    I("Humanoid", { RigType: R.enum(0), HipHeight: R.f32(0) }),
    ...extraChildren,
  ]);
}

type Rot = [number, number, number];
interface KeySpec {
  time: number;
  name?: string;
  marker?: string;
  style?: number;
  direction?: number;
  poses: Partial<Record<"Torso" | "Head" | "Right Arm" | "Left Arm" | "Right Leg" | "Left Leg", Rot>>;
}

/** KeyframeSequence for an R6 rig; rotations are XYZ degrees in each joint's space. */
function keyframeSequence(name: string, loop: boolean, keys: KeySpec[]): WriteInstance {
  const pose = (jointName: string, rot: Rot | undefined, style: number, direction: number, children: WriteInstance[] = []) =>
    I(
      "Pose",
      {
        Name: R.str(jointName),
        CFrame: R.cfa(0, 0, 0, ...(rot ?? [0, 0, 0])),
        Weight: R.f32(rot ? 1 : 0),
        EasingStyle: R.enum(style),
        EasingDirection: R.enum(direction),
      },
      children,
    );
  return I(
    "KeyframeSequence",
    { Name: R.str(name), Loop: R.bool(loop), Priority: R.enum(2) },
    keys.map((k) => {
      const style = k.style ?? 3;
      const dir = k.direction ?? 2;
      const limbs = (["Head", "Right Arm", "Left Arm", "Right Leg", "Left Leg"] as const).map((j) => pose(j, k.poses[j], style, dir));
      return I("Keyframe", { Name: R.str(k.name ?? "Keyframe"), Time: R.f32(k.time) }, [
        pose("HumanoidRootPart", undefined, style, dir, [pose("Torso", k.poses.Torso, style, dir, limbs)]),
        ...(k.marker ? [I("KeyframeMarker", { Name: R.str(k.marker), Value: R.str(k.marker.toLowerCase()) })] : []),
      ]);
    }),
  );
}

export function slashAnimation(): WriteInstance {
  // Windup → slash → follow-through → recover. Shoulder Z rotation swings the arm forward/up.
  return keyframeSequence("Cursed Slash", false, [
    { time: 0, poses: { Torso: [0, 0, 0], "Right Arm": [0, 0, 0], "Left Arm": [0, 0, 0] } },
    { time: 0.35, name: "Windup", style: 3, direction: 1, poses: { Torso: [0, 0, 32], Head: [0, 0, -18], "Right Arm": [0, 0, 165], "Left Arm": [0, 0, -40], "Right Leg": [0, 0, 12], "Left Leg": [0, 0, -12] } },
    { time: 0.55, name: "Hit", marker: "SlashVFX", style: 0, poses: { Torso: [-8, 0, -38], Head: [0, 0, 22], "Right Arm": [0, 20, 40], "Left Arm": [0, 0, -15], "Right Leg": [0, 0, -18], "Left Leg": [0, 0, 20] } },
    { time: 0.8, style: 3, direction: 1, poses: { Torso: [-5, 0, -52], Head: [0, 0, 28], "Right Arm": [0, 35, 12], "Left Arm": [0, 0, -8], "Right Leg": [0, 0, -14], "Left Leg": [0, 0, 16] } },
    { time: 1.4, name: "Recover", style: 3, direction: 2, poses: { Torso: [0, 0, 0], Head: [0, 0, 0], "Right Arm": [0, 0, 0], "Left Arm": [0, 0, 0], "Right Leg": [0, 0, 0], "Left Leg": [0, 0, 0] } },
  ]);
}

function idleAnimation(): WriteInstance {
  return keyframeSequence("Idle Breathe", true, [
    { time: 0, poses: { Torso: [0, 0, 0], Head: [0, 0, 0], "Right Arm": [0, 0, 3], "Left Arm": [0, 0, -3] } },
    { time: 1, style: 3, direction: 2, poses: { Torso: [4, 0, 0], Head: [-5, 0, 4], "Right Arm": [0, 0, 8], "Left Arm": [0, 0, -8] } },
    { time: 2, style: 3, direction: 2, poses: { Torso: [0, 0, 0], Head: [0, 0, 0], "Right Arm": [0, 0, 3], "Left Arm": [0, 0, -3] } },
  ]);
}

export const RESOURCE_IDS = {
  coreGlow: "rbxassetid://15812203001",
  sparks: "rbxassetid://15812203002",
  ring: "rbxassetid://15812203003",
  burstSheet: "rbxassetid://15812203004",
  beam: "rbxassetid://15812203005",
  crystalMesh: "rbxassetid://15812203006",
  skullMesh: "rbxassetid://15812203007",
  sigil: "rbxassetid://15812203008",
  face: "rbxasset://textures/face.png",
};

function burstEffect(): WriteInstance {
  const purple = (t: number): [number, number, number, number] => [t, 0.62, 0.3, 1];
  return I("Model", { Name: R.str("Cursed Energy Burst") }, [
    part("Emitter", [1, 1, 1], [0, 3, 0], [255, 255, 255], { Transparency: R.f32(1), CanCollide: R.bool(false) }, [
      I("Attachment", { __id: R.str("Center"), Name: R.str("Center"), CFrame: R.cf(0, 0, 0) }, [
        I("ParticleEmitter", {
          Name: R.str("Core Glow"),
          Texture: R.str(RESOURCE_IDS.coreGlow),
          Rate: R.f32(28),
          Lifetime: R.range(0.6, 0.9),
          Speed: R.range(0, 0),
          Size: R.numSeq([0, 1.5], [0.4, 3.2], [1, 3.8]),
          Transparency: R.numSeq([0, 1], [0.15, 0.25], [1, 1]),
          Color: R.colorSeq([0, 0.75, 0.45, 1], [1, 0.35, 0.3, 1]),
          LightEmission: R.f32(1),
          Rotation: R.range(0, 360),
          RotSpeed: R.range(-45, 45),
          ZOffset: R.f32(0.5),
        }),
        I("ParticleEmitter", {
          Name: R.str("Sparks"),
          Texture: R.str(RESOURCE_IDS.sparks),
          Rate: R.f32(55),
          Lifetime: R.range(0.35, 0.75),
          Speed: R.range(10, 18),
          SpreadAngle: R.v2(180, 180),
          Acceleration: R.v3(0, -22, 0),
          Drag: R.f32(2.5),
          Size: R.numSeq([0, 0.35], [1, 0]),
          Squash: R.numSeq([0, 1.6], [1, 0.4]),
          Orientation: R.enum(2),
          Color: R.colorSeq([0, 1, 1, 1], [1, 0.72, 0.4, 1]),
          LightEmission: R.f32(1),
        }),
        I("ParticleEmitter", {
          Name: R.str("Shockwave"),
          Texture: R.str(RESOURCE_IDS.ring),
          Enabled: R.bool(false),
          Rate: R.f32(0),
          Lifetime: R.range(0.55, 0.55),
          Speed: R.range(0.01, 0.01),
          Size: R.numSeq([0, 1], [1, 16]),
          Transparency: R.numSeq([0, 0], [0.6, 0.35], [1, 1]),
          Color: R.colorSeq(purple(0), [1, 0.4, 0.25, 1]),
          Orientation: R.enum(3),
          EmissionDirection: R.enum(1),
          LightEmission: R.f32(1),
          AttributesSerialize: R.bin(encodeAttributes({ EmitCount: 1, EmitDelay: 0.15 })),
        }),
        I("ParticleEmitter", {
          Name: R.str("Burst"),
          Texture: R.str(RESOURCE_IDS.burstSheet),
          Enabled: R.bool(false),
          Rate: R.f32(0),
          Lifetime: R.range(0.5, 0.9),
          Speed: R.range(18, 30),
          SpreadAngle: R.v2(180, 180),
          Drag: R.f32(4),
          Size: R.numSeq([0, 1.4], [1, 0.2]),
          Color: R.colorSeq([0, 1, 0.85, 1], [1, 0.55, 0.3, 1]),
          LightEmission: R.f32(1),
          FlipbookLayout: R.enum(2),
          FlipbookMode: R.enum(1),
          Rotation: R.range(0, 360),
          AttributesSerialize: R.bin(encodeAttributes({ EmitCount: 36 })),
        }),
      ]),
      I("PointLight", { Color: R.color(0.7, 0.4, 1), Brightness: R.f32(3), Range: R.f32(14) }),
    ]),
    part("Orb A", [0.6, 0.6, 0.6], [-5, 3, 0], [150, 90, 255], { Material: R.enum(288), shape: R.enum(0) }, [
      I("Attachment", { __id: R.str("BeamA"), Name: R.str("BeamA"), CFrame: R.cf(0, 0, 0) }),
    ]),
    part("Orb B", [0.6, 0.6, 0.6], [5, 3, 0], [255, 90, 160], { Material: R.enum(288), shape: R.enum(0) }, [
      I("Attachment", { __id: R.str("BeamB"), Name: R.str("BeamB"), CFrame: R.cf(0, 0, 0) }),
    ]),
    I("Beam", {
      Name: R.str("Tether"),
      Attachment0: R.ref("BeamA"),
      Attachment1: R.ref("BeamB"),
      CurveSize0: R.f32(3),
      CurveSize1: R.f32(-3),
      Segments: R.int(32),
      Width0: R.f32(1.2),
      Width1: R.f32(0.5),
      FaceCamera: R.bool(true),
      Texture: R.str(RESOURCE_IDS.beam),
      TextureMode: R.enum(1),
      TextureLength: R.f32(2),
      TextureSpeed: R.f32(1.5),
      LightEmission: R.f32(1),
      Color: R.colorSeq([0, 0.6, 0.4, 1], [1, 1, 0.4, 0.7]),
      Transparency: R.numSeq([0, 0.3], [0.5, 0], [1, 0.3]),
    }),
    part("Blade", [0.4, 3, 0.4], [0, 3, -2.5], [210, 210, 230], { Transparency: R.f32(0.6) }, [
      I("Attachment", { __id: R.str("TrailTop"), Name: R.str("TrailTop"), CFrame: R.cf(0, 1.5, 0) }),
      I("Attachment", { __id: R.str("TrailBottom"), Name: R.str("TrailBottom"), CFrame: R.cf(0, -1.5, 0) }),
      I("Trail", {
        Attachment0: R.ref("TrailTop"),
        Attachment1: R.ref("TrailBottom"),
        Lifetime: R.f32(0.35),
        MinLength: R.f32(0.05),
        LightEmission: R.f32(1),
        Color: R.colorSeq([0, 0.85, 0.6, 1], [1, 0.4, 0.25, 1]),
        Transparency: R.numSeq([0, 0.1], [1, 1]),
        WidthScale: R.numSeq([0, 1], [1, 0.2]),
      }),
    ]),
    I("Script", { Name: R.str("EffectController"), Source: R.str("-- Plays the burst when the attack lands.\nlocal burst = script.Parent.Emitter.Center.Burst\nburst:Emit(burst:GetAttribute(\"EmitCount\"))\n") }),
  ]);
}

function shrineProp(): WriteInstance {
  const stone: [number, number, number] = [72, 70, 82];
  const dark: [number, number, number] = [38, 36, 48];
  const neon: [number, number, number] = [170, 90, 255];
  const cyl = (name: string, size: [number, number, number], pos: [number, number, number], rgb: [number, number, number], extra: Record<string, RbxValue> = {}) =>
    I("Part", {
      Name: R.str(name),
      size: R.v3(...size),
      // Cylinders run along X; rotate 90° about Z so the pillar stands upright.
      CFrame: R.cf(pos[0], pos[1], pos[2], [0, -1, 0, 1, 0, 0, 0, 0, 1]),
      Color3uint8: R.rgb(...rgb),
      shape: R.enum(2),
      Anchored: R.bool(true),
      Material: R.enum(816),
      ...extra,
    });
  return I("Model", { Name: R.str("Cursed Shrine Tower") }, [
    part("Base", [12, 1.5, 12], [0, 0.75, 0], dark, { Material: R.enum(800) }, [
      I("Decal", { Name: R.str("Sigil"), Texture: R.str(RESOURCE_IDS.sigil), Face: R.enum(1), Transparency: R.f32(0.1) }),
    ]),
    part("Step", [9, 1, 9], [0, 2, 0], stone, { Material: R.enum(816) }),
    cyl("Pillar NE", [9, 1.4, 1.4], [3.2, 7, 3.2], stone),
    cyl("Pillar NW", [9, 1.4, 1.4], [-3.2, 7, 3.2], stone),
    cyl("Pillar SE", [9, 1.4, 1.4], [3.2, 7, -3.2], stone),
    cyl("Pillar SW", [9, 1.4, 1.4], [-3.2, 7, -3.2], stone),
    part("Neon Ring Low", [8.4, 0.3, 8.4], [0, 3, 0], neon, { Material: R.enum(288), Transparency: R.f32(0.1) }),
    part("Roof Slab", [10, 1, 10], [0, 12, 0], dark, { Material: R.enum(800) }),
    I("WedgePart", { Name: R.str("Roof Front"), size: R.v3(10, 3, 5), CFrame: R.cf(0, 14, -2.5), Color3uint8: R.rgb(120, 32, 48), Anchored: R.bool(true), Material: R.enum(512) }),
    I("WedgePart", { Name: R.str("Roof Back"), size: R.v3(10, 3, 5), CFrame: R.cf(0, 14, 2.5, [-1, 0, 0, 0, 1, 0, 0, 0, -1]), Color3uint8: R.rgb(120, 32, 48), Anchored: R.bool(true), Material: R.enum(512) }),
    I("CornerWedgePart", { Name: R.str("Finial"), size: R.v3(1.5, 2, 1.5), CFrame: R.cf(0, 16.5, 0), Color3uint8: R.rgb(214, 170, 60), Anchored: R.bool(true), Material: R.enum(1088) }),
    part("Orb", [2.4, 2.4, 2.4], [0, 7, 0], [190, 140, 255], { shape: R.enum(0), Material: R.enum(1568), Transparency: R.f32(0.35), Reflectance: R.f32(0.2) }, [
      I("PointLight", { Color: R.color(0.7, 0.45, 1), Brightness: R.f32(2.5), Range: R.f32(16) }),
    ]),
    I("MeshPart", {
      Name: R.str("Crystal"),
      MeshId: R.str(RESOURCE_IDS.crystalMesh),
      size: R.v3(1.6, 3.2, 1.6),
      InitialSize: R.v3(1, 2, 1),
      CFrame: R.cf(0, 4.2, 0),
      Color3uint8: R.rgb(150, 110, 255),
      Anchored: R.bool(true),
      Material: R.enum(288),
    }),
    I("MeshPart", {
      Name: R.str("Skull Ornament"),
      MeshId: R.str(RESOURCE_IDS.skullMesh),
      size: R.v3(1.4, 1.4, 1.6),
      InitialSize: R.v3(1.4, 1.4, 1.6),
      CFrame: R.cf(0, 12.2, -5.3),
      Color3uint8: R.rgb(226, 220, 205),
      Anchored: R.bool(true),
    }),
    I("TrussPart", { Name: R.str("Ladder"), size: R.v3(2, 10, 2), CFrame: R.cf(6.5, 6.5, 0), Color3uint8: R.rgb(90, 90, 96), Anchored: R.bool(true), Material: R.enum(1088) }),
    part("Lantern", [1, 1, 1], [4.8, 13, -4.8], [230, 150, 70], {}, [I("SpecialMesh", { MeshType: R.enum(3), Scale: R.v3(0.9, 1.3, 0.9) })]),
  ]);
}

// ── Stand-in resources (what an artist would upload to resolve missing assets) ──

async function png(file: string, svg: string, size = 256) {
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(file);
}

function sparkSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><defs><radialGradient id="g"><stop offset="0" stop-color="#fff"/><stop offset="0.25" stop-color="#fff" stop-opacity="0.9"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs><rect width="256" height="256" fill="none"/><ellipse cx="128" cy="128" rx="30" ry="120" fill="url(#g)"/><ellipse cx="128" cy="128" rx="120" ry="18" fill="url(#g)" opacity="0.6"/></svg>`;
}

function ringSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><defs><radialGradient id="r"><stop offset="0.62" stop-color="#fff" stop-opacity="0"/><stop offset="0.78" stop-color="#fff" stop-opacity="1"/><stop offset="0.86" stop-color="#fff" stop-opacity="0.5"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs><circle cx="128" cy="128" r="128" fill="url(#r)"/></svg>`;
}

function beamSvg() {
  const stripes = Array.from({ length: 8 }, (_, i) => `<rect x="${i * 32}" y="0" width="14" height="256" fill="#fff" opacity="${0.35 + (i % 2) * 0.5}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><defs><linearGradient id="v" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.5" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient><mask id="m"><rect width="256" height="256" fill="url(#v)"/></mask></defs><g mask="url(#m)">${stripes}</g></svg>`;
}

/** 4×4 flipbook: an expanding, fading burst. */
function burstSheetSvg() {
  const cells: string[] = [];
  for (let i = 0; i < 16; i++) {
    const cx = (i % 4) * 128 + 64;
    const cy = Math.floor(i / 4) * 128 + 64;
    const r = 10 + i * 3.4;
    const o = 1 - i / 17;
    cells.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#b)" opacity="${o.toFixed(2)}"/>`);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + i * 0.2;
      cells.push(`<line x1="${cx}" y1="${cy}" x2="${(cx + Math.cos(a) * (r + 14)).toFixed(1)}" y2="${(cy + Math.sin(a) * (r + 14)).toFixed(1)}" stroke="#fff" stroke-width="3" opacity="${(o * 0.8).toFixed(2)}"/>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><defs><radialGradient id="b"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>${cells.join("")}</svg>`;
}

function sigilSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="none"/><g fill="none" stroke="#b27cff" stroke-width="6" opacity="0.95"><circle cx="128" cy="128" r="110"/><circle cx="128" cy="128" r="84"/><path d="M128 30 L213 177 L43 177 Z"/><path d="M128 226 L43 79 L213 79 Z"/></g></svg>`;
}

function faceSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="none"/><ellipse cx="90" cy="100" rx="14" ry="22" fill="#111"/><ellipse cx="166" cy="100" rx="14" ry="22" fill="#111"/><path d="M78 160 Q128 205 178 160" fill="none" stroke="#111" stroke-width="12" stroke-linecap="round"/></svg>`;
}

/** A faceted crystal as OBJ (the kind of export an artist has for a MeshPart). */
function crystalObj() {
  const v: string[] = [];
  const f: string[] = [];
  const n = 6;
  v.push("v 0 1 0");
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    v.push(`v ${(Math.cos(a) * 0.5).toFixed(4)} 0.25 ${(Math.sin(a) * 0.5).toFixed(4)}`);
  }
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + Math.PI / n;
    v.push(`v ${(Math.cos(a) * 0.42).toFixed(4)} -0.45 ${(Math.sin(a) * 0.42).toFixed(4)}`);
  }
  v.push("v 0 -1 0");
  for (let i = 0; i < n; i++) {
    const a = 2 + i;
    const b = 2 + ((i + 1) % n);
    const c = 2 + n + i;
    const d = 2 + n + ((i + 1) % n);
    f.push(`f 1 ${b} ${a}`, `f ${a} ${b} ${c}`, `f ${b} ${d} ${c}`, `f ${c} ${d} ${2 * n + 2}`);
  }
  return `# Crystal ornament — exported from Blender\no Crystal\n${v.join("\n")}\n${f.join("\n")}\n`;
}

// ── Audio ────────────────────────────────────────────────────────────────────

async function synth(file: string, seconds: number, expr: string, codec: string[]) {
  const { code, stderr } = await runFfmpeg(["-y", "-f", "lavfi", "-i", `aevalsrc=exprs='${expr}':s=44100:d=${seconds}`, "-ac", "2", ...codec, file]);
  if (code !== 0) throw new Error(`Audio synthesis failed: ${stderr.slice(-400)}`);
}

export async function generateRobloxDemo(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const out = (name: string) => path.join(dir, name);
  const write = (name: string, roots: WriteInstance[]) => {
    if (!fs.existsSync(out(name))) fs.writeFileSync(out(name), writeBinaryModel(roots));
  };
  write("guardian_rig.rbxm", [r6Rig("Shrine Guardian", [I("Folder", { Name: R.str("AnimSaves") }, [idleAnimation()])])]);
  write("cursed_slash_v1.rbxm", [slashAnimation()]);
  write("cursed_slash_v2.rbxm", [
    keyframeSequence("Cursed Slash", false, [
      { time: 0, poses: { Torso: [0, 0, 0], "Right Arm": [0, 0, 0], "Left Arm": [0, 0, 0] } },
      { time: 0.4, name: "Windup", style: 3, direction: 1, poses: { Torso: [0, 0, 38], Head: [0, 0, -20], "Right Arm": [0, 0, 170], "Left Arm": [0, 0, -50], "Right Leg": [0, 0, 14], "Left Leg": [0, 0, -14] } },
      { time: 0.58, name: "Hit", marker: "SlashVFX", style: 0, poses: { Torso: [-10, 0, -42], Head: [0, 0, 24], "Right Arm": [0, 25, 35], "Left Arm": [0, 0, -18], "Right Leg": [0, 0, -20], "Left Leg": [0, 0, 22] } },
      { time: 0.95, style: 2, direction: 1, poses: { Torso: [-6, 0, -58], Head: [0, 0, 30], "Right Arm": [0, 40, 8], "Left Arm": [0, 0, -10], "Right Leg": [0, 0, -16], "Left Leg": [0, 0, 18] } },
      { time: 1.6, name: "Recover", style: 3, direction: 2, poses: { Torso: [0, 0, 0], Head: [0, 0, 0], "Right Arm": [0, 0, 0], "Left Arm": [0, 0, 0], "Right Leg": [0, 0, 0], "Left Leg": [0, 0, 0] } },
    ]),
  ]);
  write("cursed_burst_vfx.rbxm", [burstEffect()]);
  write("shrine_tower.rbxm", [shrineProp()]);

  const resources: Array<[string, () => Promise<void>]> = [
    ["tex_sparks.png", () => png(out("tex_sparks.png"), sparkSvg())],
    ["tex_ring.png", () => png(out("tex_ring.png"), ringSvg())],
    ["tex_beam.png", () => png(out("tex_beam.png"), beamSvg())],
    ["tex_burst_sheet.png", () => png(out("tex_burst_sheet.png"), burstSheetSvg(), 512)],
    ["tex_sigil.png", () => png(out("tex_sigil.png"), sigilSvg())],
    ["tex_face.png", () => png(out("tex_face.png"), faceSvg())],
    ["crystal.obj", async () => fs.writeFileSync(out("crystal.obj"), crystalObj())],
    [
      "slash_sfx_v1.mp3",
      () =>
        synth(
          out("slash_sfx_v1.mp3"),
          1.6,
          "0.55*(random(0)*2-1)*exp(-9*abs(t-0.42))*lt(t,0.9)+0.8*sin(2*PI*(55+260*exp(-18*max(t-0.52,0)))*t)*exp(-5*max(t-0.52,0))*gte(t,0.52)",
          ["-c:a", "libmp3lame", "-b:a", "192k"],
        ),
    ],
    [
      "slash_sfx_v2.mp3",
      () =>
        synth(
          out("slash_sfx_v2.mp3"),
          1.6,
          "0.5*(random(0)*2-1)*exp(-10*abs(t-0.4))*lt(t,0.8)+0.9*sin(2*PI*(50+300*exp(-20*max(t-0.46,0)))*t)*exp(-4.5*max(t-0.46,0))*gte(t,0.46)",
          ["-c:a", "libmp3lame", "-b:a", "192k"],
        ),
    ],
    [
      "shrine_ambience.ogg",
      () =>
        synth(
          out("shrine_ambience.ogg"),
          8,
          "0.28*sin(2*PI*55*t)*(0.6+0.4*sin(2*PI*0.25*t))+0.12*sin(2*PI*82.5*t)+0.18*sin(2*PI*660*t)*exp(-2.5*mod(t,2))+0.06*(random(0)*2-1)*(0.5+0.5*sin(2*PI*0.1*t))",
          ["-c:a", "libvorbis", "-q:a", "5"],
        ),
    ],
  ];
  for (const [name, run] of resources) if (!fs.existsSync(out(name))) await run();
  return out;
}
