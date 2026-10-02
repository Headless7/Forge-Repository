import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { projectDecal } from "./decals";

const FRONT = 5;
const TOP = 1;

function uvAt(geometry: THREE.BufferGeometry, x: number, y: number, z: number) {
  const pos = geometry.getAttribute("position");
  const uv = geometry.getAttribute("uv");
  for (let i = 0; i < pos.count; i++) {
    if (Math.abs(pos.getX(i) - x) < 1e-4 && Math.abs(pos.getY(i) - y) < 1e-4 && Math.abs(pos.getZ(i) - z) < 1e-4) return [uv.getX(i), uv.getY(i)].map((v) => Math.round(v * 1000) / 1000);
  }
  return null;
}

describe("decal projection", () => {
  it("covers exactly the front face of an ordinary part, oriented like Studio", () => {
    // A 4×2×1 part: the unit box scaled to its size.
    const matrix = new THREE.Matrix4().makeScale(4, 2, 1);
    const result = projectDecal(new THREE.BoxGeometry(1, 1, 1), matrix, FRONT)!;
    expect(result.size).toEqual([4, 2]);
    // Only the two front triangles, all on z = -0.5 (in the box's own space).
    const pos = result.geometry.getAttribute("position");
    expect(pos.count).toBe(6);
    for (let i = 0; i < pos.count; i++) expect(pos.getZ(i)).toBeCloseTo(-0.5);
    // Seen from the front, the image's left edge is at +X and its top at +Y.
    expect(uvAt(result.geometry, 0.5, 0.5, -0.5)).toEqual([0, 1]);
    expect(uvAt(result.geometry, -0.5, -0.5, -0.5)).toEqual([1, 0]);
  });

  it("wraps around a rounded head instead of floating in front of it", () => {
    // A cylinder-ish head 1.2 studs across, as a SpecialMesh head would draw it.
    const head = new THREE.CylinderGeometry(0.5, 0.5, 1, 24);
    const matrix = new THREE.Matrix4().makeScale(1.2, 1.2, 1.2);
    const result = projectDecal(head, matrix, FRONT)!;
    // Stretched over the head's own bounds (not the 2×1 part box).
    expect(result.size[0]).toBeCloseTo(1.2, 2);
    expect(result.size[1]).toBeCloseTo(1.2, 2);
    // Every vertex lies on the head surface (radius 0.5 in its space) and faces forward (z ≤ 0).
    const pos = result.geometry.getAttribute("position");
    for (let i = 0; i < pos.count; i++) {
      expect(pos.getZ(i)).toBeLessThanOrEqual(1e-6);
      if (Math.abs(pos.getY(i)) < 0.49) expect(Math.hypot(pos.getX(i), pos.getZ(i))).toBeCloseTo(0.5, 5);
    }
    // The centre of the face lands on the front-most point of the head.
    const uv = result.geometry.getAttribute("uv");
    let best = -1;
    for (let i = 0; i < pos.count; i++) if (best < 0 || pos.getZ(i) < pos.getZ(best)) best = i;
    expect(uv.getX(best)).toBeCloseTo(0.5, 1);
  });

  it("keeps skin weights so the decal deforms with a skinned mesh", () => {
    const g = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
    const count = g.getAttribute("position").count;
    g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(new Uint16Array(count * 4).fill(3), 4));
    g.setAttribute("skinWeight", new THREE.Float32BufferAttribute(new Float32Array(count * 4).fill(0.25), 4));
    const result = projectDecal(g, new THREE.Matrix4(), TOP)!;
    expect(result.geometry.getAttribute("skinIndex").getX(0)).toBe(3);
    expect(result.geometry.getAttribute("skinWeight").count).toBe(6);
  });

  it("returns nothing for a surface with no side facing the decal", () => {
    const flat = new THREE.PlaneGeometry(1, 1); // faces +Z only
    expect(projectDecal(flat, new THREE.Matrix4(), FRONT)).toBeNull();
  });
});
