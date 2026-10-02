import * as THREE from "three";

/**
 * Decals and Textures as Roblox draws them: projected straight along their face's normal
 * onto the part's *rendered surface* — the box of an ordinary part, the head of a
 * SpecialMesh, the mesh of a MeshPart — covering that surface's bounds on that side. Only
 * triangles facing the decal's side receive it, so a face wraps around a rounded head
 * instead of floating in front of it as a flat card.
 */

/**
 * Image axes per NormalId, seen from outside the face: [u (image right), v (image up)].
 * Right=0 (+X), Top=1 (+Y), Back=2 (+Z), Left=3 (-X), Bottom=4 (-Y), Front=5 (-Z).
 * (Same orientation the viewer has always used for decals on part faces.)
 */
const AXES: Array<[THREE.Vector3, THREE.Vector3]> = [
  [new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0)],
  [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1)],
  [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)],
  [new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0)],
  [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)],
  [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0)],
];
const NORMALS = AXES.map(([u, v]) => new THREE.Vector3().crossVectors(u, v));

export interface ProjectedDecal {
  /** The facing triangles of the surface, in the surface's own space, with projected UVs. */
  geometry: THREE.BufferGeometry;
  /** Width and height (studs, in part space) the image is stretched over. */
  size: [number, number];
}

/**
 * Builds the decal geometry for one face of a surface. `matrix` places the surface geometry
 * in part space (e.g. a SpecialMesh's scale and offset); the result keeps the surface's own
 * vertex space (and skin weights), so it is drawn with the same transform or skeleton.
 */
export function projectDecal(surface: THREE.BufferGeometry, matrix: THREE.Matrix4, face: number): ProjectedDecal | null {
  const [uAxis, vAxis] = AXES[face] ?? AXES[5]!;
  const normal = NORMALS[face] ?? NORMALS[5]!;
  const flat = surface.index ? surface.toNonIndexed() : surface;
  const position = flat.getAttribute("position") as THREE.BufferAttribute | undefined;
  if (!position || position.count < 3) return null;

  // Bounds of the whole surface in part space, along the image axes.
  const p = new THREE.Vector3();
  const world = new Float32Array(position.count * 3);
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (let i = 0; i < position.count; i++) {
    p.fromBufferAttribute(position, i).applyMatrix4(matrix);
    world.set([p.x, p.y, p.z], i * 3);
    const u = p.dot(uAxis);
    const v = p.dot(vAxis);
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  const width = maxU - minU;
  const height = maxV - minV;
  if (!(width > 1e-6) || !(height > 1e-6)) return null;

  // Keep the triangles facing the decal's side.
  const keep: number[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let t = 0; t + 2 < position.count; t += 3) {
    a.fromArray(world, t * 3);
    b.fromArray(world, t * 3 + 3);
    c.fromArray(world, t * 3 + 6);
    n.subVectors(c, b).cross(a.clone().sub(b));
    const len = n.length();
    if (len > 0 && n.dot(normal) / len > 0.02) keep.push(t);
  }
  if (!keep.length) return null;

  const out = new THREE.BufferGeometry();
  const copy = (name: string) => {
    const attribute = flat.getAttribute(name) as THREE.BufferAttribute | undefined;
    if (!attribute) return;
    const size = attribute.itemSize;
    const ArrayType = attribute.array.constructor as new (length: number) => THREE.TypedArray;
    const data = new ArrayType(keep.length * 3 * size);
    keep.forEach((t, k) => data.set(attribute.array.subarray(t * size, (t + 3) * size), k * 3 * size));
    out.setAttribute(name, new THREE.BufferAttribute(data, size, attribute.normalized));
  };
  for (const name of ["position", "normal", "skinIndex", "skinWeight"]) copy(name);
  const uv = new Float32Array(keep.length * 3 * 2);
  keep.forEach((t, k) => {
    for (let j = 0; j < 3; j++) {
      a.fromArray(world, (t + j) * 3);
      uv[(k * 3 + j) * 2] = (a.dot(uAxis) - minU) / width;
      uv[(k * 3 + j) * 2 + 1] = (a.dot(vAxis) - minV) / height;
    }
  });
  out.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  if (!out.getAttribute("normal")) out.computeVertexNormals();
  if (flat !== surface) flat.dispose();
  return { geometry: out, size: [width, height] };
}
