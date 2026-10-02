import * as THREE from "three";

/**
 * Roblox materials rendered as flat PBR approximations (Roblox's material textures
 * and normal maps are not reproduced). Values are tuned by eye, not measured.
 */
const MATERIAL_PROPS: Record<number, { name: string; roughness: number; metalness: number }> = {
  256: { name: "Plastic", roughness: 0.62, metalness: 0 },
  272: { name: "SmoothPlastic", roughness: 0.35, metalness: 0 },
  288: { name: "Neon", roughness: 1, metalness: 0 },
  512: { name: "Wood", roughness: 0.82, metalness: 0 },
  528: { name: "WoodPlanks", roughness: 0.82, metalness: 0 },
  784: { name: "Marble", roughness: 0.3, metalness: 0 },
  788: { name: "Basalt", roughness: 0.9, metalness: 0 },
  800: { name: "Slate", roughness: 0.88, metalness: 0 },
  804: { name: "CrackedLava", roughness: 0.9, metalness: 0 },
  816: { name: "Concrete", roughness: 0.92, metalness: 0 },
  820: { name: "Limestone", roughness: 0.9, metalness: 0 },
  832: { name: "Granite", roughness: 0.75, metalness: 0 },
  836: { name: "Pavement", roughness: 0.93, metalness: 0 },
  848: { name: "Brick", roughness: 0.9, metalness: 0 },
  864: { name: "Pebble", roughness: 0.9, metalness: 0 },
  880: { name: "Cobblestone", roughness: 0.9, metalness: 0 },
  896: { name: "Rock", roughness: 0.93, metalness: 0 },
  912: { name: "Sandstone", roughness: 0.9, metalness: 0 },
  1040: { name: "CorrodedMetal", roughness: 0.7, metalness: 0.6 },
  1056: { name: "DiamondPlate", roughness: 0.4, metalness: 0.85 },
  1072: { name: "Foil", roughness: 0.25, metalness: 0.9 },
  1088: { name: "Metal", roughness: 0.38, metalness: 0.85 },
  1280: { name: "Grass", roughness: 0.95, metalness: 0 },
  1284: { name: "LeafyGrass", roughness: 0.95, metalness: 0 },
  1296: { name: "Sand", roughness: 0.97, metalness: 0 },
  1312: { name: "Fabric", roughness: 0.95, metalness: 0 },
  1328: { name: "Snow", roughness: 0.8, metalness: 0 },
  1344: { name: "Mud", roughness: 0.95, metalness: 0 },
  1360: { name: "Ground", roughness: 0.95, metalness: 0 },
  1376: { name: "Asphalt", roughness: 0.95, metalness: 0 },
  1392: { name: "Salt", roughness: 0.9, metalness: 0 },
  1536: { name: "Ice", roughness: 0.12, metalness: 0 },
  1552: { name: "Glacier", roughness: 0.2, metalness: 0 },
  1568: { name: "Glass", roughness: 0.05, metalness: 0 },
  1584: { name: "ForceField", roughness: 1, metalness: 0 },
  1792: { name: "Air", roughness: 1, metalness: 0 },
  2048: { name: "Water", roughness: 0.1, metalness: 0 },
};

export function materialName(value: number): string {
  return MATERIAL_PROPS[value]?.name ?? `Material ${value}`;
}

export function srgb(rgb: number[] | undefined, fallback = [0.64, 0.64, 0.65]): THREE.Color {
  const [r, g, b] = rgb && rgb.length >= 3 ? rgb : fallback;
  return new THREE.Color().setRGB(r!, g!, b!, THREE.SRGBColorSpace);
}

export class MaterialCache {
  private cache = new Map<string, THREE.Material>();
  private owned: THREE.Material[] = [];

  /** `cutout`: the texture's alpha cuts holes (SurfaceAppearance AlphaMode = Transparency, e.g. hair and fur cards). */
  part(opts: { color: number[]; material: number; transparency: number; reflectance: number; map?: THREE.Texture | null; doubleSided?: boolean; cutout?: boolean }): THREE.Material {
    const key = `${opts.color.join(",")}|${opts.material}|${opts.transparency}|${opts.reflectance}|${opts.map?.uuid ?? ""}|${opts.doubleSided ? 1 : 0}|${opts.cutout ? 1 : 0}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const props = MATERIAL_PROPS[opts.material] ?? MATERIAL_PROPS[256]!;
    const color = srgb(opts.color);
    const opacity = 1 - Math.min(1, Math.max(0, opts.transparency));
    let material: THREE.Material;
    if (props.name === "Neon") {
      // Neon glows in Roblox; emissive + no tone mapping gets close without bloom.
      material = new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(1.35), transparent: opacity < 1, opacity, toneMapped: false });
    } else if (props.name === "ForceField") {
      material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: Math.min(0.45, opacity), blending: THREE.AdditiveBlending, depthWrite: false });
    } else {
      const glassLike = props.name === "Glass" || props.name === "Ice" || props.name === "Water";
      material = new THREE.MeshStandardMaterial({
        color,
        map: opts.map ?? null,
        roughness: props.roughness * (1 - Math.min(1, opts.reflectance) * 0.8),
        metalness: Math.max(props.metalness, Math.min(1, opts.reflectance) * 0.6),
        transparent: opacity < 1,
        opacity: glassLike && opacity < 1 ? Math.max(0.15, opacity) : opacity,
        envMapIntensity: 0.6 + opts.reflectance,
        side: opts.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
        alphaTest: opts.cutout && opts.map ? 0.5 : 0,
      });
    }
    if (opacity < 1) material.depthWrite = false;
    if (opacity <= 0) material.visible = false;
    this.cache.set(key, material);
    this.owned.push(material);
    return material;
  }

  /** Box shown for content that needs a resource we don't have (mesh, union). */
  placeholder(color: number[]): THREE.Material {
    const key = `placeholder|${color.join(",")}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const material = new THREE.MeshStandardMaterial({ color: srgb(color), roughness: 0.8, transparent: true, opacity: 0.55, depthWrite: false });
    this.cache.set(key, material);
    this.owned.push(material);
    return material;
  }

  dispose() {
    for (const m of this.owned) m.dispose();
    this.cache.clear();
    this.owned = [];
  }
}
