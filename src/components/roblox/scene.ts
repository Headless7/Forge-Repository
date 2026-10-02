import * as THREE from "three";
import type { ManifestNode, RobloxManifest } from "@/lib/roblox/manifest";
import { bindInPart, matchSkinBones, skinCandidates } from "@/lib/roblox/skinning";
import { projectDecal } from "./decals";
import { MaterialCache, srgb } from "./materials";
import type { GeometrySkin, ResourceStore } from "./resources";

export type CF = number[];

export function matrixFromCFrame(cf: CF | null | undefined, target = new THREE.Matrix4()): THREE.Matrix4 {
  if (!cf) return target.identity();
  const [x, y, z, r00, r01, r02, r10, r11, r12, r20, r21, r22] = cf as [number, number, number, number, number, number, number, number, number, number, number, number];
  return target.set(r00, r01, r02, x, r10, r11, r12, y, r20, r21, r22, z, 0, 0, 0, 1);
}

const PART_CLASSES = new Set([
  "Part",
  "WedgePart",
  "CornerWedgePart",
  "TrussPart",
  "SpawnLocation",
  "Seat",
  "VehicleSeat",
  "SkateboardPlatform",
  "FlagStand",
  "Platform",
  "MeshPart",
  "UnionOperation",
  "NegateOperation",
  "IntersectOperation",
  "PartOperation",
]);
export const EFFECT_CLASSES = new Set(["ParticleEmitter", "Beam", "Trail", "Fire", "Smoke", "Sparkles"]);

// ── Shared unit geometries ───────────────────────────────────────────────────

function cornerWedgeGeometry() {
  // Studio: the peak stands over the (+X, -Z) corner.
  const g = new THREE.BoxGeometry(1, 1, 1);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) if (p.getY(i) > 0 && !(p.getX(i) > 0 && p.getZ(i) < 0)) p.setY(i, -0.5);
  const flat = g.toNonIndexed();
  flat.computeVertexNormals();
  return flat;
}

function headGeometry() {
  // Classic head: a rounded cylinder (the real head mesh isn't bundled).
  const r = 0.5;
  const h = 0.5;
  const c = 0.22;
  const pts: THREE.Vector2[] = [new THREE.Vector2(0, -h)];
  for (let i = 0; i <= 6; i++) {
    const a = -Math.PI / 2 + (i / 6) * (Math.PI / 2);
    pts.push(new THREE.Vector2(r - c + Math.cos(a) * c, -h + c + Math.sin(a) * c));
  }
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * (Math.PI / 2);
    pts.push(new THREE.Vector2(r - c + Math.cos(a) * c, h - c + Math.sin(a) * c));
  }
  pts.push(new THREE.Vector2(0, h));
  return new THREE.LatheGeometry(pts, 28);
}

export class GeometryKit {
  readonly box = new THREE.BoxGeometry(1, 1, 1);
  readonly sphere = new THREE.SphereGeometry(0.5, 28, 18);
  /** Along X, like Roblox cylinder parts. */
  readonly cylinderX = new THREE.CylinderGeometry(0.5, 0.5, 1, 28).rotateZ(Math.PI / 2);
  /** Along Y (CylinderMesh / SpecialMesh cylinders). */
  readonly cylinderY = new THREE.CylinderGeometry(0.5, 0.5, 1, 28);
  readonly wedge = (() => {
    const g = new THREE.BoxGeometry(1, 1, 1);
    const p = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) if (p.getZ(i) < 0) p.setY(i, -0.5);
    const flat = g.toNonIndexed();
    flat.computeVertexNormals();
    g.dispose();
    return flat;
  })();
  readonly cornerWedge = cornerWedgeGeometry();
  readonly head = headGeometry();
  readonly plane = new THREE.PlaneGeometry(1, 1);
  dispose() {
    for (const g of [this.box, this.sphere, this.cylinderX, this.cylinderY, this.wedge, this.cornerWedge, this.head, this.plane]) g.dispose();
  }
}

// NormalId: Right=0 (+X), Top=1 (+Y), Back=2 (+Z), Left=3 (-X), Bottom=4 (-Y), Front=5 (-Z)
export const FACE_NORMALS: THREE.Vector3[] = [
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, -1, 0),
  new THREE.Vector3(0, 0, -1),
];

export interface EffectSpec {
  node: number;
  className: string;
  /** The object the effect is parented to (part or attachment). */
  parent: THREE.Object3D;
  /** Size of the parent part, when the parent is a part (for shaped emission). */
  parentSize: THREE.Vector3 | null;
  r: ManifestNode["r"];
  a: ManifestNode["a"];
}

export interface SkinRuntime {
  /** Skinned MeshParts drawn as deforming meshes. */
  meshes: number;
  /** Mesh bones driven by a Bone in the file. */
  boundBones: number;
  /** Mesh bones with no Bone instance: their vertices stay in the bind pose (as in Roblox). */
  unboundBones: string[];
  /** Skinning data that couldn't be read (the mesh is drawn rigid). */
  errors: string[];
}

export interface BuiltScene {
  root: THREE.Group;
  partObjects: Map<number, THREE.Object3D>;
  /** Anything with a position that can be selected/framed in the explorer. */
  nodeObjects: Map<number, THREE.Object3D>;
  attachmentObjects: Map<number, THREE.Object3D>;
  /** Bone instances (also in attachmentObjects); their matrix is CFrame · Transform. */
  boneObjects: Map<number, THREE.Bone>;
  effects: EffectSpec[];
  lights: THREE.Light[];
  runtime: {
    placeholderMeshes: Set<string>;
    unionBoxes: number;
    missingDecals: number;
    /** Decals on parts whose mesh is missing (a decal needs the surface it is projected onto). */
    decalsWithoutMesh: Array<{ decal: string; part: string; meshId: string | null }>;
    headApprox: number;
    skin: SkinRuntime;
  };
  ready: Promise<void>;
  bounds: () => THREE.Box3;
  dispose: () => void;
}

function childOf(nodes: ManifestNode[], parent: number, classes: Set<string> | string[]) {
  const set = classes instanceof Set ? classes : new Set(classes);
  const out: number[] = [];
  nodes.forEach((n, i) => {
    if (n.p === parent && set.has(n.c)) out.push(i);
  });
  return out;
}

/**
 * A mesh placed in its part: centred on its bounds and stretched per axis to the part's size
 * (Roblox scales a mesh from its native bounds to Size). Normals get the inverse scale so
 * smooth shading survives non-uniform sizes.
 */
function fitMesh(source: THREE.BufferGeometry, center: THREE.Vector3, scale: THREE.Vector3): THREE.BufferGeometry {
  const fitted = source.clone();
  fitted.userData = source.userData;
  fitted.translate(-center.x, -center.y, -center.z);
  fitted.scale(scale.x, scale.y, scale.z);
  const normals = fitted.getAttribute("normal") as THREE.BufferAttribute | undefined;
  if (normals) {
    const n = new THREE.Vector3();
    const inverse = new THREE.Vector3(1 / (scale.x || 1), 1 / (scale.y || 1), 1 / (scale.z || 1));
    for (let k = 0; k < normals.count; k++) {
      n.fromBufferAttribute(normals, k).multiply(inverse);
      if (n.lengthSq() > 0) n.normalize();
      normals.setXYZ(k, n.x, n.y, n.z);
    }
    normals.needsUpdate = true;
  } else {
    fitted.computeVertexNormals();
  }
  return fitted;
}

function nearestPart(nodes: ManifestNode[], index: number): number | null {
  for (let p = nodes[index]!.p; p !== -1; p = nodes[p]!.p) if (PART_CLASSES.has(nodes[p]!.c)) return p;
  return null;
}

/**
 * Turns a manifest into a three.js scene. Parts sit at their saved world CFrames;
 * attachments are children of their part so animated rigs carry effects along.
 */
export function buildScene(manifest: RobloxManifest, store: ResourceStore, options: { only?: Set<number> } = {}): BuiltScene {
  const nodes = manifest.nodes;
  const kit = new GeometryKit();
  const materials = new MaterialCache();
  const root = new THREE.Group();
  root.name = "roblox-root";
  const partObjects = new Map<number, THREE.Object3D>();
  const nodeObjects = new Map<number, THREE.Object3D>();
  const attachmentObjects = new Map<number, THREE.Object3D>();
  const boneObjects = new Map<number, THREE.Bone>();
  const effects: EffectSpec[] = [];
  const lights: THREE.Light[] = [];
  const runtime = { placeholderMeshes: new Set<string>(), unionBoxes: 0, missingDecals: 0, decalsWithoutMesh: [] as Array<{ decal: string; part: string; meshId: string | null }>, headApprox: 0, skin: { meshes: 0, boundBones: 0, unboundBones: [] as string[], errors: [] as string[] } };
  const loads: Array<Promise<unknown>> = [];
  const disposables: Array<{ dispose: () => void }> = [];
  const include = (i: number) => !options.only || options.only.has(i);
  const childIndex = new Map<number, number[]>();
  nodes.forEach((n, i) => {
    const list = childIndex.get(n.p);
    if (list) list.push(i);
    else childIndex.set(n.p, [i]);
  });

  /** Parts whose surface arrives later (meshes): their decals are drawn when it does. */
  const deferredSurface = new Set<number>();
  /** A mesh that never arrived: its part's decals can't be placed (reported, not faked on the placeholder box). */
  const waitingForMesh = (partIndex: number, meshId: string | null) => {
    for (const d of childOf(nodes, partIndex, ["Decal", "Texture"])) runtime.decalsWithoutMesh.push({ decal: nodes[d]!.n, part: nodes[partIndex]!.n, meshId });
  };

  /**
   * Draws a part's Decals and Textures onto `surface` (the mesh that renders the part): the
   * image is projected along the face's normal over the surface's bounds on that side, onto
   * the triangles facing it, with the surface's own transform (or skeleton, so it deforms).
   */
  const drawDecals = (partIndex: number, obj: THREE.Object3D, surface: THREE.Mesh): Promise<unknown> => {
    const jobs: Array<Promise<void>> = [];
    surface.updateMatrix();
    for (const d of childOf(nodes, partIndex, ["Decal", "Texture"])) {
      const dr = nodes[d]!.r;
      const texId = dr.texId as string | null;
      if (!store.has("texture", texId)) {
        runtime.missingDecals += 1;
        void store.texture(texId);
        continue;
      }
      const projected = projectDecal(surface.geometry, surface.matrix, Number(dr.face ?? 5));
      if (!projected) continue;
      disposables.push(projected.geometry);
      jobs.push(
        store.texture(texId).then((tex) => {
          if (!tex) return;
          let map = tex;
          if (nodes[d]!.c === "Texture") {
            // Tiled: StudsPerTile/OffsetStuds over the projected size.
            const su = Number(dr.su ?? 2) || 2;
            const sv = Number(dr.sv ?? 2) || 2;
            map = tex.clone();
            map.wrapS = map.wrapT = THREE.RepeatWrapping;
            map.repeat.set(projected.size[0] / su, projected.size[1] / sv);
            map.offset.set(Number(dr.ou ?? 0) / su, Number(dr.ov ?? 0) / sv);
            map.needsUpdate = true;
            disposables.push(map);
          }
          const material = new THREE.MeshStandardMaterial({
            map,
            color: srgb((dr.color as number[]) ?? [1, 1, 1]),
            transparent: true,
            opacity: 1 - Number(dr.tr ?? 0),
            depthWrite: false,
            // Same triangles as the surface: pulled slightly towards the camera so they win the depth test without floating.
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -4,
            roughness: 0.8,
          });
          disposables.push(material);
          let overlay: THREE.Mesh;
          if ((surface as THREE.SkinnedMesh).isSkinnedMesh) {
            const skinned = new THREE.SkinnedMesh(projected.geometry, material);
            skinned.bind((surface as THREE.SkinnedMesh).skeleton, (surface as THREE.SkinnedMesh).bindMatrix);
            skinned.frustumCulled = false;
            overlay = skinned;
          } else {
            overlay = new THREE.Mesh(projected.geometry, material);
          }
          overlay.position.copy(surface.position);
          overlay.quaternion.copy(surface.quaternion);
          overlay.scale.copy(surface.scale);
          // Decals on the same face stack by ZIndex.
          overlay.renderOrder = 1 + Number(dr.z ?? 1);
          overlay.userData.node = d;
          obj.add(overlay);
        }),
      );
    }
    return Promise.all(jobs);
  };

  /** A skinned MeshPart: vertices follow the Bones named in the mesh (see lib/roblox/skinning). */
  const skinnedMesh = (partIndex: number, partObj: THREE.Object3D, geometry: THREE.BufferGeometry, skin: GeometrySkin, center: THREE.Vector3, scale: THREE.Vector3, material: THREE.Material) => {
    const matched = matchSkinBones(skin.bones, nodes, skinCandidates(nodes, partIndex, childIndex));
    const bones: THREE.Bone[] = [];
    const inverses: THREE.Matrix4[] = [];
    const c = [center.x, center.y, center.z];
    const s = [scale.x, scale.y, scale.z];
    skin.bones.forEach((bone, b) => {
      const bind = matrixFromCFrame(bindInPart(bone.cf, c, s));
      const node = matched[b];
      let obj = node !== null && node !== undefined ? boneObjects.get(node) : undefined;
      if (obj) {
        runtime.skin.boundBones += 1;
      } else {
        // No Bone drives it: it stays where the mesh was bound, with the part.
        obj = new THREE.Bone();
        obj.matrixAutoUpdate = false;
        obj.matrix.copy(bind);
        partObj.add(obj);
        runtime.skin.unboundBones.push(bone.name);
      }
      bones.push(obj);
      inverses.push(bind.clone().invert());
    });
    // Index bones.length: vertices no bone moves stay with the part.
    const anchor = new THREE.Bone();
    anchor.matrixAutoUpdate = false;
    partObj.add(anchor);
    bones.push(anchor);
    inverses.push(new THREE.Matrix4());
    const skeleton = new THREE.Skeleton(bones, inverses);
    disposables.push(skeleton);
    const out = new THREE.SkinnedMesh(geometry, material);
    // World = Σ w · Bone.world · Bind⁻¹ · vertex: the part's own transform cancels out (attached mode, identity bind matrix).
    out.bind(skeleton, new THREE.Matrix4());
    out.frustumCulled = false;
    runtime.skin.meshes += 1;
    return out;
  };

  // Parts
  nodes.forEach((n, i) => {
    if (!PART_CLASSES.has(n.c) || !include(i)) return;
    const r = n.r;
    const size = (r.size as number[]) ?? [4, 1, 2];
    const obj = new THREE.Object3D();
    obj.name = n.n;
    obj.userData.node = i;
    obj.matrixAutoUpdate = false;
    matrixFromCFrame(r.cf as CF, obj.matrix);
    obj.matrixWorldNeedsUpdate = true;
    root.add(obj);
    partObjects.set(i, obj);
    nodeObjects.set(i, obj);

    const color = (r.color as number[]) ?? [0.64, 0.64, 0.65];
    const baseMaterial = () =>
      materials.part({ color, material: Number(r.mat ?? 256), transparency: Number(r.tr ?? 0), reflectance: Number(r.refl ?? 0), doubleSided: Boolean(r.doubleSided) });
    const mesh = new THREE.Mesh<THREE.BufferGeometry, THREE.Material>(kit.box, baseMaterial());
    mesh.userData.node = i;
    mesh.castShadow = Boolean(r.shadow ?? true) && Number(r.tr ?? 0) < 0.5;
    mesh.receiveShadow = true;
    obj.add(mesh);

    const special = childOf(nodes, i, ["SpecialMesh", "BlockMesh", "CylinderMesh", "FileMesh"])[0];
    const shape = r.shape;
    if (special !== undefined) {
      const sr = nodes[special]!.r;
      const scale = (sr.scale as number[]) ?? [1, 1, 1];
      const offset = (sr.offset as number[]) ?? [0, 0, 0];
      const vcolor = (sr.vcolor as number[]) ?? [1, 1, 1];
      mesh.position.set(offset[0]!, offset[1]!, offset[2]!);
      const tinted = [color[0]! * vcolor[0]!, color[1]! * vcolor[1]!, color[2]! * vcolor[2]!];
      if (vcolor.some((v) => v !== 1)) mesh.material = materials.part({ color: tinted, material: Number(r.mat ?? 256), transparency: Number(r.tr ?? 0), reflectance: Number(r.refl ?? 0) });
      const mt = sr.meshType;
      if (mt === 0) {
        runtime.headApprox += 1;
        const across = Math.min(size[0]!, size[2]!) * 0.935;
        mesh.geometry = kit.head;
        mesh.scale.set(across * scale[0]!, size[1]! * 0.935 * scale[1]!, across * scale[2]!);
      } else if (mt === 3) {
        mesh.geometry = kit.sphere;
        mesh.scale.set(size[0]! * scale[0]!, size[1]! * scale[1]!, size[2]! * scale[2]!);
      } else if (mt === 4 || mt === "cylinderY") {
        mesh.geometry = kit.cylinderY;
        mesh.scale.set(size[0]! * scale[0]!, size[1]! * scale[1]!, size[2]! * scale[2]!);
      } else if (mt === 2) {
        mesh.geometry = kit.wedge;
        mesh.scale.set(size[0]! * scale[0]!, size[1]! * scale[1]!, size[2]! * scale[2]!);
      } else if (mt === 5) {
        const meshId = sr.meshId as string | null;
        mesh.geometry = kit.box;
        mesh.scale.set(size[0]!, size[1]!, size[2]!);
        mesh.material = materials.placeholder(color);
        if (meshId) runtime.placeholderMeshes.add(meshId);
        deferredSurface.add(i);
        loads.push(
          store.geometry(meshId).then(async (g) => {
            if (!g) return waitingForMesh(i, meshId);
            runtime.placeholderMeshes.delete(meshId!);
            mesh.geometry = g;
            mesh.scale.set(scale[0]!, scale[1]!, scale[2]!);
            const texture = await store.texture(sr.texId as string | null);
            mesh.material = materials.part({ color: texture ? vcolor : tinted, material: Number(r.mat ?? 256), transparency: Number(r.tr ?? 0), reflectance: Number(r.refl ?? 0), map: texture });
            await drawDecals(i, obj, mesh);
          }),
        );
      } else {
        // Brick (6) and legacy shapes (Torso, prisms) render as boxes.
        mesh.scale.set(size[0]! * scale[0]!, size[1]! * scale[1]!, size[2]! * scale[2]!);
      }
    } else if (shape === 0) {
      const d = Math.min(size[0]!, size[1]!, size[2]!);
      mesh.geometry = kit.sphere;
      mesh.scale.set(d, d, d);
    } else if (shape === 2) {
      const d = Math.min(size[1]!, size[2]!);
      mesh.geometry = kit.cylinderX;
      mesh.scale.set(size[0]!, d, d);
    } else if (shape === 3) {
      mesh.geometry = kit.wedge;
      mesh.scale.set(size[0]!, size[1]!, size[2]!);
    } else if (shape === 4) {
      mesh.geometry = kit.cornerWedge;
      mesh.scale.set(size[0]!, size[1]!, size[2]!);
    } else if (shape === "truss") {
      deferredSurface.add(i); // (lattice: no single surface to put decals on)
      obj.remove(mesh);
      const lattice = new THREE.Group();
      const long = size.indexOf(Math.max(...size));
      const t = 0.18;
      const bar = (sx: number, sy: number, sz: number, x: number, y: number, z: number) => {
        const b = new THREE.Mesh(kit.box, baseMaterial());
        b.scale.set(sx, sy, sz);
        b.position.set(x, y, z);
        b.userData.node = i;
        b.castShadow = true;
        lattice.add(b);
      };
      const [sx, sy, sz] = size as [number, number, number];
      for (const cx of [-1, 1]) {
        for (const cz of [-1, 1]) {
          if (long === 1) bar(t, sy, t, (cx * sx) / 2 - cx * t, 0, (cz * sz) / 2 - cz * t);
          else if (long === 0) bar(sx, t, t, 0, (cx * sy) / 2 - cx * t, (cz * sz) / 2 - cz * t);
          else bar(t, t, sz, (cx * sx) / 2 - cx * t, (cz * sy) / 2 - cz * t, 0);
        }
      }
      const length = size[long]!;
      for (let k = -length / 2 + 1; k < length / 2; k += 2) {
        if (long === 1) bar(sx, t, t, 0, k, 0);
        else if (long === 0) bar(t, sy, t, k, 0, 0);
        else bar(sx, t, t, 0, 0, k);
      }
      obj.add(lattice);
    } else if (shape === "mesh") {
      const meshId = r.meshId as string | null;
      mesh.scale.set(size[0]!, size[1]!, size[2]!);
      mesh.material = materials.placeholder(color);
      if (meshId) runtime.placeholderMeshes.add(meshId);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(kit.box), new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.08, gapSize: 0.06, transparent: true, opacity: 0.5 }));
      edges.computeLineDistances();
      edges.scale.copy(mesh.scale);
      edges.userData.placeholderFor = i;
      obj.add(edges);
      disposables.push(edges.geometry, edges.material as THREE.Material);
      const surface = childOf(nodes, i, ["SurfaceAppearance"])[0];
      deferredSurface.add(i);
      loads.push(
        store.geometry(meshId).then(async (g) => {
          if (!g) return waitingForMesh(i, meshId);
          runtime.placeholderMeshes.delete(meshId!);
          obj.remove(edges);
          // Roblox scales a mesh from its native bounds (InitialSize) to the part's Size.
          g.computeBoundingBox();
          const bb = g.boundingBox!;
          const dims = new THREE.Vector3();
          bb.getSize(dims);
          const center = new THREE.Vector3();
          bb.getCenter(center);
          const scale = new THREE.Vector3(size[0]! / (dims.x || 1), size[1]! / (dims.y || 1), size[2]! / (dims.z || 1));
          const fitted = fitMesh(g, center, scale);
          disposables.push(fitted);
          const texId = (surface !== undefined ? (nodes[surface]!.r.colorMap as string | null) : null) ?? (r.texId as string | null);
          const texture = await store.texture(texId);
          const material = materials.part({
            color: texture ? [1, 1, 1] : color,
            material: Number(r.mat ?? 256),
            transparency: Number(r.tr ?? 0),
            reflectance: Number(r.refl ?? 0),
            map: texture,
            doubleSided: Boolean(r.doubleSided),
            cutout: surface !== undefined && nodes[surface]!.r.alphaMode === 1,
          });
          const skin = g.userData.skin as GeometrySkin | undefined;
          if (typeof g.userData.skinError === "string") runtime.skin.errors.push(`${n.n}: ${g.userData.skinError}`);
          if (skin?.bones.length) {
            const skinned = skinnedMesh(i, obj, fitted, skin, center, scale, material);
            skinned.userData.node = i;
            skinned.castShadow = mesh.castShadow;
            skinned.receiveShadow = true;
            obj.remove(mesh);
            obj.add(skinned);
            await drawDecals(i, obj, skinned);
            return;
          }
          mesh.geometry = fitted;
          mesh.scale.set(1, 1, 1);
          mesh.material = material;
          await drawDecals(i, obj, mesh);
        }),
      );
    } else if (shape === "union") {
      runtime.unionBoxes += 1;
      mesh.scale.set(size[0]!, size[1]!, size[2]!);
      mesh.material = n.c === "NegateOperation" ? materials.placeholder([1, 0.3, 0.3]) : materials.part({ color, material: Number(r.mat ?? 256), transparency: Math.max(0.15, Number(r.tr ?? 0)), reflectance: 0 });
    } else {
      mesh.scale.set(size[0]!, size[1]!, size[2]!);
    }

    // Decals and textures: drawn on the final surface — now for primitives, once loaded for meshes.
    if (!deferredSurface.has(i)) loads.push(drawDecals(i, obj, mesh));
  });

  // Attachments and bones (children of their part so they move with it)
  const attach = (i: number) => {
    const n = nodes[i]!;
    if (attachmentObjects.has(i)) return attachmentObjects.get(i)!;
    const a = n.c === "Bone" ? new THREE.Bone() : new THREE.Object3D();
    a.name = n.n;
    a.userData.node = i;
    a.matrixAutoUpdate = false;
    matrixFromCFrame(n.r.cf as CF, a.matrix);
    if (a instanceof THREE.Bone) boneObjects.set(i, a);
    const parentNode = n.p;
    const parentObj = parentNode !== -1 ? (partObjects.get(parentNode) ?? (nodes[parentNode]!.c === "Bone" || nodes[parentNode]!.c === "Attachment" ? attach(parentNode) : undefined)) : undefined;
    (parentObj ?? root).add(a);
    attachmentObjects.set(i, a);
    nodeObjects.set(i, a);
    return a;
  };
  nodes.forEach((n, i) => {
    if ((n.c === "Attachment" || n.c === "Bone") && include(i)) attach(i);
  });

  // Lights and effects
  nodes.forEach((n, i) => {
    if (!include(i)) return;
    const parentIndex = n.p;
    const parentObj = parentIndex !== -1 ? (attachmentObjects.get(parentIndex) ?? partObjects.get(parentIndex)) : undefined;
    if ((n.c === "PointLight" || n.c === "SpotLight" || n.c === "SurfaceLight") && parentObj && n.r.enabled !== false) {
      const color = srgb(n.r.color as number[], [1, 1, 1]);
      const brightness = Number(n.r.bright ?? 1);
      const range = Number(n.r.range ?? 8);
      let light: THREE.Light;
      if (n.c === "PointLight") {
        light = new THREE.PointLight(color, brightness * 6, range * 1.6, 1.4);
      } else {
        const spot = new THREE.SpotLight(color, brightness * 8, range * 1.6, (Math.min(180, Number(n.r.angle ?? 90)) * Math.PI) / 360, 0.35, 1.4);
        const normal = FACE_NORMALS[Number(n.r.face ?? 5)] ?? FACE_NORMALS[5]!;
        spot.target.position.copy(normal);
        spot.add(spot.target);
        light = spot;
      }
      light.userData.node = i;
      parentObj.add(light);
      lights.push(light);
      nodeObjects.set(i, light);
    }
    if (EFFECT_CLASSES.has(n.c)) {
      const holder = parentObj ?? root;
      const partIndex = partObjects.has(parentIndex) ? parentIndex : null;
      const size = partIndex !== null ? ((nodes[partIndex]!.r.size as number[]) ?? [1, 1, 1]) : null;
      effects.push({ node: i, className: n.c, parent: holder, parentSize: size ? new THREE.Vector3(size[0], size[1], size[2]) : null, r: n.r, a: n.a });
      nodeObjects.set(i, holder);
    }
    if (n.c === "Highlight" && n.r.enabled !== false) {
      const adornee = typeof n.r.adornee === "number" ? n.r.adornee : n.p;
      const targets = [...partObjects.entries()].filter(([pi]) => pi === adornee || isDescendant(nodes, pi, adornee));
      const fill = new THREE.MeshBasicMaterial({ color: srgb(n.r.fill as number[]), transparent: true, opacity: 1 - Number(n.r.fillTr ?? 0.5), depthTest: n.r.depth !== 0, depthWrite: false });
      const outline = new THREE.LineBasicMaterial({ color: srgb(n.r.outline as number[]), transparent: true, opacity: 1 - Number(n.r.outlineTr ?? 0), depthTest: n.r.depth !== 0 });
      disposables.push(fill, outline);
      for (const [, obj] of targets) {
        const mesh = obj.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh | undefined;
        if (!mesh) continue;
        const overlay = new THREE.Mesh(mesh.geometry, fill);
        overlay.scale.copy(mesh.scale).multiplyScalar(1.01);
        overlay.position.copy(mesh.position);
        overlay.renderOrder = 5;
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 30), outline);
        edges.scale.copy(mesh.scale).multiplyScalar(1.01);
        edges.position.copy(mesh.position);
        edges.renderOrder = 6;
        disposables.push(edges.geometry);
        obj.add(overlay, edges);
      }
    }
  });

  root.updateMatrixWorld(true);
  const bounds = () => {
    root.updateMatrixWorld(true);
    const box = new THREE.Box3();
    for (const obj of partObjects.values()) box.expandByObject(obj);
    if (box.isEmpty()) {
      for (const obj of attachmentObjects.values()) box.expandByPoint(new THREE.Vector3().setFromMatrixPosition(obj.matrixWorld));
      if (!box.isEmpty()) box.expandByScalar(4);
    }
    if (box.isEmpty()) box.set(new THREE.Vector3(-4, -4, -4), new THREE.Vector3(4, 4, 4));
    return box;
  };

  return {
    root,
    partObjects,
    nodeObjects,
    attachmentObjects,
    boneObjects,
    effects,
    lights,
    runtime,
    ready: Promise.allSettled(loads).then(() => undefined),
    bounds,
    dispose: () => {
      for (const d of disposables) d.dispose();
      materials.dispose();
      kit.dispose();
    },
  };
}

function isDescendant(nodes: ManifestNode[], index: number, ancestor: number) {
  for (let p = nodes[index]!.p; p !== -1; p = nodes[p]!.p) if (p === ancestor) return true;
  return false;
}

export { nearestPart };
