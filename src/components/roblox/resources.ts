import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { parseRobloxMesh, type MeshBone, type ParsedMesh } from "@/lib/roblox/mesh";

export interface ResolvedResource {
  contentId: string;
  kind: "mesh" | "texture";
  url: string;
  format: string;
  filename: string;
  /** "roblox" = fetched and cached for 7 days after last use; "upload" = provided by the team. */
  source?: "upload" | "roblox";
  expiresAt?: string | null;
}

export type ResourceStatus = { state: "loaded" } | { state: "missing" } | { state: "error"; message: string };

/** Skeleton of a skinned Roblox mesh, kept on `geometry.userData.skin` (weights are the skinIndex/skinWeight attributes). */
export interface GeometrySkin {
  bones: MeshBone[];
  unweighted: number;
}

/** Keeps only position/normal/uv (and skin weights) so meshes from any source merge cleanly. */
function normaliseGeometry(source: THREE.BufferGeometry, matrix?: THREE.Matrix4): THREE.BufferGeometry {
  let g = source.index ? source.toNonIndexed() : source.clone();
  if (matrix) g.applyMatrix4(matrix);
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", g.getAttribute("position"));
  if (g.getAttribute("normal")) out.setAttribute("normal", g.getAttribute("normal"));
  const uv = g.getAttribute("uv");
  out.setAttribute("uv", uv ?? new THREE.BufferAttribute(new Float32Array((g.getAttribute("position").count || 0) * 2), 2));
  if (!out.getAttribute("normal")) out.computeVertexNormals();
  if (!matrix && g.getAttribute("skinIndex") && g.getAttribute("skinWeight")) {
    out.setAttribute("skinIndex", g.getAttribute("skinIndex"));
    out.setAttribute("skinWeight", g.getAttribute("skinWeight"));
    out.userData.skin = source.userData.skin;
  }
  g.dispose();
  g = out;
  return g;
}

function mergeObject(object: THREE.Object3D): THREE.BufferGeometry {
  object.updateMatrixWorld(true);
  const parts: THREE.BufferGeometry[] = [];
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry) parts.push(normaliseGeometry(mesh.geometry, mesh.matrixWorld));
  });
  if (!parts.length) throw new Error("The file has no mesh geometry.");
  const merged = parts.length === 1 ? parts[0]! : mergeGeometries(parts, false);
  if (!merged) throw new Error("Couldn't combine the meshes in this file.");
  return merged;
}

async function loadGeometry(res: ResolvedResource): Promise<THREE.BufferGeometry> {
  const response = await fetch(res.url);
  if (!response.ok) throw new Error(`Download failed (${response.status}).`);
  const buffer = await response.arrayBuffer();
  switch (res.format) {
    case "mesh":
      return geometryFromMesh(parseRobloxMesh(buffer));
    case "obj": {
      const { OBJLoader } = await import("three/examples/jsm/loaders/OBJLoader.js");
      return mergeObject(new OBJLoader().parse(new TextDecoder().decode(buffer)));
    }
    case "glb": {
      const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
      const gltf = await new GLTFLoader().parseAsync(buffer, "");
      return mergeObject(gltf.scene);
    }
    case "fbx": {
      const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
      return mergeObject(new FBXLoader().parse(buffer, ""));
    }
    default:
      throw new Error(`Unsupported mesh format “${res.format}”.`);
  }
}

/** A parsed Roblox mesh as viewer geometry; skinned meshes keep their weights and skeleton. */
export function geometryFromMesh(mesh: ParsedMesh): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(mesh.uvs, 2));
  g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  if (mesh.skin && mesh.skin.bones.length) {
    g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(mesh.skin.indices, 4));
    g.setAttribute("skinWeight", new THREE.Float32BufferAttribute(mesh.skin.weights, 4));
    g.userData.skin = { bones: mesh.skin.bones, unweighted: mesh.skin.unweighted } satisfies GeometrySkin;
  }
  const out = normaliseGeometry(g);
  g.dispose();
  if (mesh.skinError) out.userData.skinError = mesh.skinError;
  return out;
}

/** Loads resolved stand-ins for Roblox content (once each) and remembers what's missing. */
export class ResourceStore {
  private byKey = new Map<string, ResolvedResource>();
  private textures = new Map<string, Promise<THREE.Texture | null>>();
  private geometries = new Map<string, Promise<THREE.BufferGeometry | null>>();
  private owned: Array<THREE.Texture | THREE.BufferGeometry> = [];
  readonly status = new Map<string, ResourceStatus>();
  private fallback: THREE.Texture | null = null;

  constructor(resources: ResolvedResource[], private onChange?: () => void) {
    for (const r of resources) this.byKey.set(`${r.kind}:${r.contentId}`, r);
  }

  has(kind: "mesh" | "texture", contentId: string | null | undefined) {
    return Boolean(contentId && this.byKey.has(`${kind}:${contentId}`));
  }

  private mark(contentId: string, status: ResourceStatus) {
    this.status.set(contentId, status);
    this.onChange?.();
  }

  texture(contentId: string | null | undefined): Promise<THREE.Texture | null> {
    if (!contentId) return Promise.resolve(null);
    const cached = this.textures.get(contentId);
    if (cached) return cached;
    const res = this.byKey.get(`texture:${contentId}`);
    const promise = !res
      ? Promise.resolve(null).then(() => {
          this.mark(contentId, { state: "missing" });
          return null;
        })
      : new THREE.TextureLoader()
          .loadAsync(res.url)
          .then((t) => {
            t.colorSpace = THREE.SRGBColorSpace;
            t.anisotropy = 4;
            this.owned.push(t);
            this.mark(contentId, { state: "loaded" });
            return t;
          })
          .catch(() => {
            this.mark(contentId, { state: "error", message: "The image couldn't be loaded." });
            return null;
          });
    this.textures.set(contentId, promise);
    return promise;
  }

  geometry(contentId: string | null | undefined): Promise<THREE.BufferGeometry | null> {
    if (!contentId) return Promise.resolve(null);
    const cached = this.geometries.get(contentId);
    if (cached) return cached;
    const res = this.byKey.get(`mesh:${contentId}`);
    const promise = !res
      ? Promise.resolve(null).then(() => {
          this.mark(contentId, { state: "missing" });
          return null;
        })
      : loadGeometry(res)
          .then((g) => {
            this.owned.push(g);
            this.mark(contentId, { state: "loaded" });
            return g;
          })
          .catch((error: unknown) => {
            this.mark(contentId, { state: "error", message: error instanceof Error ? error.message : "The mesh couldn't be read." });
            return null;
          });
    this.geometries.set(contentId, promise);
    return promise;
  }

  /** Soft round sprite used when a particle/beam texture isn't available (flagged in the fidelity panel). */
  placeholderSprite(): THREE.Texture {
    if (this.fallback) return this.fallback;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext("2d")!;
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.35, "rgba(255,255,255,0.8)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    this.fallback = new THREE.CanvasTexture(canvas);
    this.fallback.colorSpace = THREE.SRGBColorSpace;
    this.owned.push(this.fallback);
    return this.fallback;
  }

  dispose() {
    for (const o of this.owned) o.dispose();
    this.owned = [];
  }
}
