import * as THREE from "three";
import type { MValue } from "@/lib/roblox/manifest";
import type { ResourceStore } from "./resources";
import { FACE_NORMALS, type EffectSpec } from "./scene";

/**
 * Browser simulation of Roblox ParticleEmitter / Beam / Trail (+ legacy Fire, Smoke,
 * Sparkles as stand-ins). Driven entirely by the file's properties — no scripts run.
 * It is an approximation: engine-exact timing, lighting and collisions differ.
 */

type Seq = number[][];

function evalNumberSeq(seq: Seq | undefined, t: number, rand: number, fallback: number): number {
  if (!seq?.length) return fallback;
  if (t <= seq[0]![0]!) return seq[0]![1]! + (seq[0]![2] ?? 0) * (rand * 2 - 1);
  for (let i = 0; i < seq.length - 1; i++) {
    const a = seq[i]!;
    const b = seq[i + 1]!;
    if (t <= b[0]!) {
      const k = b[0]! - a[0]! > 0 ? (t - a[0]!) / (b[0]! - a[0]!) : 0;
      const v = a[1]! + (b[1]! - a[1]!) * k;
      const e = (a[2] ?? 0) + ((b[2] ?? 0) - (a[2] ?? 0)) * k;
      return v + e * (rand * 2 - 1);
    }
  }
  const last = seq[seq.length - 1]!;
  return last[1]! + (last[2] ?? 0) * (rand * 2 - 1);
}

const tmpColor = new THREE.Color();
function evalColorSeq(seq: Seq | undefined, t: number, out: THREE.Color): THREE.Color {
  if (!seq?.length) return out.setRGB(1, 1, 1);
  let r = seq[seq.length - 1]!;
  let rgb: [number, number, number] = [r[1]!, r[2]!, r[3]!];
  for (let i = 0; i < seq.length - 1; i++) {
    const a = seq[i]!;
    const b = seq[i + 1]!;
    if (t <= b[0]!) {
      const k = b[0]! - a[0]! > 0 ? Math.max(0, (t - a[0]!) / (b[0]! - a[0]!)) : 0;
      rgb = [a[1]! + (b[1]! - a[1]!) * k, a[2]! + (b[2]! - a[2]!) * k, a[3]! + (b[3]! - a[3]!) * k];
      r = a;
      break;
    }
  }
  void r;
  return out.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
}

const lerp = (range: MValue | undefined, t: number, fallback: number) => {
  const r = range as number[] | undefined;
  return r && r.length >= 2 ? r[0]! + (r[1]! - r[0]!) * t : fallback;
};

function effectMaterial(map: THREE.Texture, lightEmission: number) {
  return new THREE.ShaderMaterial({
    uniforms: { map: { value: map }, lightEmission: { value: Math.min(1, Math.max(0, lightEmission)) } },
    vertexShader: /* glsl */ `
      attribute vec4 pcolor;
      varying vec4 vColor;
      varying vec2 vUv;
      void main() {
        vColor = pcolor;
        vUv = uv;
        gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      uniform float lightEmission;
      varying vec4 vColor;
      varying vec2 vUv;
      void main() {
        vec4 t = texture2D(map, vUv);
        float a = vColor.a * t.a;
        if (a < 0.002) discard;
        // Roblox LightEmission blends between normal (0) and additive (1) blending.
        gl_FragColor = vec4(vColor.rgb * t.rgb * a, a * (1.0 - lightEmission));
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    side: THREE.DoubleSide,
  });
}

// ── Particle emitters ───────────────────────────────────────────────────────

const GRID: Record<number, number> = { 0: 1, 1: 2, 2: 4, 3: 8 };

interface EmitterSettings {
  enabled: boolean;
  rate: number;
  life: number[];
  speed: number[];
  spread: number[];
  accel: number[];
  drag: number;
  velInherit: number;
  locked: boolean;
  rot: number[];
  rotSpeed: number[];
  size: Seq;
  tr: Seq;
  squash: Seq;
  color: Seq;
  le: number;
  bright: number;
  zoff: number;
  orient: number;
  dir: number;
  shape: number;
  shapeStyle: number;
  shapeInOut: number;
  shapePartial: number;
  timeScale: number;
  fbLayout: number;
  fbMode: number;
  fbRate: number[];
  fbRandom: boolean;
  tex: string | null;
}

function emitterSettings(spec: EffectSpec): EmitterSettings {
  const r = spec.r;
  const num = (v: MValue | undefined, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const arr = (v: MValue | undefined, d: number[]) => (Array.isArray(v) ? (v as number[]) : d);
  if (spec.className === "Fire") {
    const size = num(r.size, 5);
    const heat = num(r.heat, 9);
    const c = arr(r.color, [0.93, 0.36, 0.1]);
    const c2 = arr(r.color2, [0.54, 0.21, 0.1]);
    return base({ rate: 60, life: [0.7, 1.2], speed: [heat * 0.45, heat * 0.6], spread: [12, 12], size: [[0, size * 0.55, 0], [1, size * 0.15, 0]], tr: [[0, 0.15, 0], [1, 1, 0]], color: [[0, ...c], [1, ...c2]], le: 0.9, enabled: r.enabled !== false, timeScale: num(r.timeScale, 1) });
  }
  if (spec.className === "Smoke") {
    const size = num(r.size, 1);
    const c = arr(r.color, [1, 1, 1]);
    const opacity = num(r.opacity, 0.5);
    return base({ rate: 10, life: [4, 6], speed: [num(r.rise, 1), num(r.rise, 1) * 1.3], spread: [15, 15], size: [[0, size * 0.6, 0], [1, size * 2.4, 0]], tr: [[0, 1 - opacity, 0], [1, 1, 0]], color: [[0, ...c], [1, ...c]], le: 0, rotSpeed: [-20, 20], rot: [0, 360], enabled: r.enabled !== false, timeScale: num(r.timeScale, 1) });
  }
  if (spec.className === "Sparkles") {
    const c = arr(r.color, [0.56, 0.31, 1]);
    return base({ rate: 25, life: [0.5, 1], speed: [2, 4], spread: [180, 180], size: [[0, 0.45, 0], [1, 0, 0]], tr: [[0, 0, 0], [1, 0.4, 0]], color: [[0, ...c], [1, ...c]], le: 1, enabled: r.enabled !== false, timeScale: num(r.timeScale, 1) });
  }
  return {
    enabled: r.enabled !== false,
    rate: num(r.rate, 20),
    life: arr(r.life, [5, 10]),
    speed: arr(r.speed, [5, 5]),
    spread: arr(r.spread, [0, 0]),
    accel: arr(r.accel, [0, 0, 0]),
    drag: num(r.drag, 0),
    velInherit: num(r.velInherit, 0),
    locked: Boolean(r.locked),
    rot: arr(r.rot, [0, 0]),
    rotSpeed: arr(r.rotSpeed, [0, 0]),
    size: (r.size as Seq) ?? [[0, 1, 0], [1, 1, 0]],
    tr: (r.tr as Seq) ?? [[0, 0, 0], [1, 0, 0]],
    squash: (r.squash as Seq) ?? [[0, 0, 0], [1, 0, 0]],
    color: (r.color as Seq) ?? [[0, 1, 1, 1], [1, 1, 1, 1]],
    le: num(r.le, 0),
    bright: num(r.bright, 1),
    zoff: num(r.zoff, 0),
    orient: num(r.orient, 0),
    dir: num(r.dir, 1),
    shape: num(r.shape, 0),
    shapeStyle: num(r.shapeStyle, 0),
    shapeInOut: num(r.shapeInOut, 0),
    shapePartial: num(r.shapePartial, 1),
    timeScale: num(r.timeScale, 1),
    fbLayout: num(r.fbLayout, 0),
    fbMode: num(r.fbMode, 0),
    fbRate: arr(r.fbRate, [1, 1]),
    fbRandom: Boolean(r.fbRandom),
    tex: (r.tex as string | null) ?? null,
  };
  function base(o: Partial<EmitterSettings>): EmitterSettings {
    return {
      enabled: true,
      rate: 20,
      life: [1, 1],
      speed: [1, 1],
      spread: [0, 0],
      accel: [0, 0, 0],
      drag: 0,
      velInherit: 0,
      locked: false,
      rot: [0, 0],
      rotSpeed: [0, 0],
      size: [[0, 1, 0], [1, 1, 0]],
      tr: [[0, 0, 0], [1, 0, 0]],
      squash: [[0, 0, 0], [1, 0, 0]],
      color: [[0, 1, 1, 1], [1, 1, 1, 1]],
      le: 0,
      bright: 1,
      zoff: 0,
      orient: 0,
      dir: 1,
      shape: 0,
      shapeStyle: 0,
      shapeInOut: 0,
      shapePartial: 1,
      timeScale: 1,
      fbLayout: 0,
      fbMode: 0,
      fbRate: [1, 1],
      fbRandom: false,
      tex: null,
      ...o,
    };
  }
}

const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const v3 = new THREE.Vector3();
const q1 = new THREE.Quaternion();

class EmitterRuntime {
  readonly settings: EmitterSettings;
  readonly mesh: THREE.Mesh;
  private geometry = new THREE.BufferGeometry();
  private material: THREE.ShaderMaterial;
  private cap = 0;
  private count = 0;
  private px!: Float32Array; private py!: Float32Array; private pz!: Float32Array;
  private vx!: Float32Array; private vy!: Float32Array; private vz!: Float32Array;
  private age!: Float32Array; private life!: Float32Array; private rot!: Float32Array; private rotSpeed!: Float32Array;
  private seed!: Float32Array; private frame!: Float32Array; private fps!: Float32Array;
  private accumulator = 0;
  private lastOrigin = new THREE.Vector3();
  private hasOrigin = false;
  private burstTimers: number[] = [];
  private durationLeft = 0;
  enabled: boolean;
  textureState: "file" | "placeholder" | "none" = "none";
  readonly emitCount: number;
  readonly emitDelay: number;
  readonly emitDuration: number;

  constructor(readonly spec: EffectSpec, store: ResourceStore) {
    this.settings = emitterSettings(spec);
    this.enabled = this.settings.enabled;
    const a = spec.a ?? {};
    this.emitCount = typeof a.EmitCount === "number" ? Math.max(0, Math.min(2000, Math.round(a.EmitCount))) : 0;
    this.emitDelay = typeof a.EmitDelay === "number" ? Math.max(0, a.EmitDelay) : 0;
    this.emitDuration = typeof a.EmitDuration === "number" ? Math.max(0, a.EmitDuration) : 0;
    const placeholder = store.placeholderSprite();
    this.material = effectMaterial(placeholder, this.settings.le);
    this.textureState = this.settings.tex ? "placeholder" : "none";
    if (this.settings.tex && store.has("texture", this.settings.tex)) {
      void store.texture(this.settings.tex).then((t) => {
        if (t) {
          this.material.uniforms.map!.value = t;
          this.textureState = "file";
        }
      });
    } else if (this.settings.tex) {
      void store.texture(this.settings.tex);
    }
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10 + Math.round(this.settings.zoff);
    this.mesh.userData.node = spec.node;
    this.grow(64);
  }

  private grow(n: number) {
    const cap = Math.min(8000, Math.max(n, this.cap * 2));
    if (cap <= this.cap) return;
    const copy = (a: Float32Array | undefined) => {
      const b = new Float32Array(cap);
      if (a) b.set(a.subarray(0, this.count));
      return b;
    };
    this.px = copy(this.px); this.py = copy(this.py); this.pz = copy(this.pz);
    this.vx = copy(this.vx); this.vy = copy(this.vy); this.vz = copy(this.vz);
    this.age = copy(this.age); this.life = copy(this.life); this.rot = copy(this.rot); this.rotSpeed = copy(this.rotSpeed);
    this.seed = copy(this.seed); this.frame = copy(this.frame); this.fps = copy(this.fps);
    this.cap = cap;
    this.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(cap * 12), 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(cap * 8), 2).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute("pcolor", new THREE.BufferAttribute(new Float32Array(cap * 16), 4).setUsage(THREE.DynamicDrawUsage));
    const index = new Uint32Array(cap * 6);
    for (let i = 0; i < cap; i++) index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    this.geometry.setIndex(new THREE.BufferAttribute(index, 1));
  }

  get live() {
    return this.count;
  }

  private emitterMatrix() {
    this.spec.parent.updateWorldMatrix(true, false);
    return this.spec.parent.matrixWorld;
  }

  emit(n: number) {
    const m = this.emitterMatrix();
    const s = this.settings;
    if (this.count + n > this.cap) this.grow(this.count + n);
    n = Math.min(n, this.cap - this.count);
    const normalLocal = FACE_NORMALS[s.dir] ?? FACE_NORMALS[1]!;
    const size = this.spec.parentSize;
    for (let k = 0; k < n; k++) {
      const i = this.count++;
      // Spawn point and outward direction in the emitter's local space.
      const pos = v1.set(0, 0, 0);
      let dir = v2.copy(normalLocal);
      if (size) {
        const [hx, hy, hz] = [size.x / 2, size.y / 2, size.z / 2];
        if (s.shape === 1) {
          const r = Math.min(hx, hy, hz);
          const u = v3.randomDirection();
          if (s.shapePartial < 1 && u.dot(normalLocal) < 1 - 2 * s.shapePartial) u.reflect(normalLocal).negate();
          const radius = s.shapeStyle === 1 ? r : r * Math.cbrt(Math.random());
          pos.copy(u).multiplyScalar(radius);
          dir = v2.copy(u);
        } else if (s.shape === 2 || s.shape === 3) {
          const a = Math.random() * Math.PI * 2;
          const rr = (s.shapeStyle === 1 ? 1 : Math.sqrt(Math.random())) * Math.min(hx, hz);
          pos.set(Math.cos(a) * rr, s.shape === 2 ? (Math.random() * 2 - 1) * hy : 0, Math.sin(a) * rr);
          dir = v2.set(Math.cos(a), 0, Math.sin(a));
        } else if (s.shapeStyle === 1) {
          // Box surface: the face in the emission direction.
          pos.set((Math.random() * 2 - 1) * hx, (Math.random() * 2 - 1) * hy, (Math.random() * 2 - 1) * hz);
          if (normalLocal.x) pos.x = hx * Math.sign(normalLocal.x);
          if (normalLocal.y) pos.y = hy * Math.sign(normalLocal.y);
          if (normalLocal.z) pos.z = hz * Math.sign(normalLocal.z);
        } else {
          pos.set((Math.random() * 2 - 1) * hx, (Math.random() * 2 - 1) * hy, (Math.random() * 2 - 1) * hz);
        }
        if (s.shapeInOut === 1) dir.negate();
        else if (s.shapeInOut === 2 && Math.random() < 0.5) dir.negate();
      }
      // Spread: tilt the direction by up to SpreadAngle.X / .Y degrees around two perpendicular axes.
      const t1 = v3.set(1, 0, 0);
      if (Math.abs(dir.dot(t1)) > 0.9) t1.set(0, 0, 1);
      t1.cross(dir).normalize();
      const ax = ((Math.random() * 2 - 1) * s.spread[0]! * Math.PI) / 180;
      const ay = ((Math.random() * 2 - 1) * (s.spread[1] ?? 0) * Math.PI) / 180;
      dir.applyQuaternion(q1.setFromAxisAngle(t1, ax));
      const t2 = t1.clone().cross(dir).normalize();
      dir.applyQuaternion(q1.setFromAxisAngle(t2, ay)).normalize();
      const speed = lerp(s.speed, Math.random(), 0);
      if (s.locked) {
        this.px[i] = pos.x; this.py[i] = pos.y; this.pz[i] = pos.z;
        this.vx[i] = dir.x * speed; this.vy[i] = dir.y * speed; this.vz[i] = dir.z * speed;
      } else {
        pos.applyMatrix4(m);
        dir.transformDirection(m);
        this.px[i] = pos.x; this.py[i] = pos.y; this.pz[i] = pos.z;
        this.vx[i] = dir.x * speed; this.vy[i] = dir.y * speed; this.vz[i] = dir.z * speed;
      }
      this.age[i] = 0;
      this.life[i] = Math.max(0.01, lerp(s.life, Math.random(), 1));
      this.rot[i] = lerp(s.rot, Math.random(), 0);
      this.rotSpeed[i] = lerp(s.rotSpeed, Math.random(), 0);
      this.seed[i] = Math.random();
      const frames = GRID[s.fbLayout] ?? 1;
      this.frame[i] = s.fbRandom || s.fbMode === 3 ? Math.floor(Math.random() * frames * frames) : 0;
      this.fps[i] = lerp(s.fbRate, Math.random(), 1);
    }
  }

  /** Plays the file's EmitCount burst (after EmitDelay), like a typical VFX script would. */
  burst() {
    if (this.emitCount > 0) this.burstTimers.push(this.emitDelay);
    if (this.emitDuration > 0) this.durationLeft = this.emitDuration + this.emitDelay;
  }

  clear() {
    this.count = 0;
    this.accumulator = 0;
    this.burstTimers = [];
    this.durationLeft = 0;
    this.hasOrigin = false;
  }

  update(dt: number, camera: THREE.Camera) {
    const s = this.settings;
    const step = dt * s.timeScale;
    const m = this.emitterMatrix();
    const origin = v1.setFromMatrixPosition(m);
    const parentVelocity = this.hasOrigin && step > 0 ? origin.clone().sub(this.lastOrigin).divideScalar(Math.max(1e-4, dt)) : new THREE.Vector3();
    this.lastOrigin.copy(origin);
    this.hasOrigin = true;

    if (step > 0) {
      this.burstTimers = this.burstTimers.map((t) => t - step);
      for (const t of this.burstTimers) if (t <= 0) this.emit(this.emitCount);
      this.burstTimers = this.burstTimers.filter((t) => t > 0);
      const emitting = this.enabled || this.durationLeft > 0;
      if (this.durationLeft > 0) this.durationLeft -= step;
      if (emitting && s.rate > 0) {
        this.accumulator += s.rate * step;
        const n = Math.floor(this.accumulator);
        this.accumulator -= n;
        if (n > 0) {
          const before = this.count;
          this.emit(Math.min(n, 500));
          if (s.velInherit && !s.locked) {
            for (let i = before; i < this.count; i++) {
              this.vx[i]! += parentVelocity.x * s.velInherit;
              this.vy[i]! += parentVelocity.y * s.velInherit;
              this.vz[i]! += parentVelocity.z * s.velInherit;
            }
          }
        }
      }
      // Integrate and cull.
      const dragK = Math.exp(-s.drag * step);
      const [ax, ay, az] = s.accel as [number, number, number];
      let w = 0;
      for (let i = 0; i < this.count; i++) {
        const age = this.age[i]! + step;
        if (age >= this.life[i]!) continue;
        this.age[w] = age;
        this.life[w] = this.life[i]!;
        this.vx[w] = (this.vx[i]! + ax * step) * dragK;
        this.vy[w] = (this.vy[i]! + ay * step) * dragK;
        this.vz[w] = (this.vz[i]! + az * step) * dragK;
        this.px[w] = this.px[i]! + this.vx[w]! * step;
        this.py[w] = this.py[i]! + this.vy[w]! * step;
        this.pz[w] = this.pz[i]! + this.vz[w]! * step;
        this.rot[w] = this.rot[i]! + this.rotSpeed[i]! * step;
        this.rotSpeed[w] = this.rotSpeed[i]!;
        this.seed[w] = this.seed[i]!;
        this.frame[w] = this.frame[i]!;
        this.fps[w] = this.fps[i]!;
        w++;
      }
      this.count = w;
    }
    this.writeGeometry(camera, m);
  }

  private writeGeometry(camera: THREE.Camera, m: THREE.Matrix4) {
    const s = this.settings;
    const pos = this.geometry.getAttribute("position") as THREE.BufferAttribute;
    const uv = this.geometry.getAttribute("uv") as THREE.BufferAttribute;
    const col = this.geometry.getAttribute("pcolor") as THREE.BufferAttribute;
    const cam = camera.matrixWorld;
    const camRight = new THREE.Vector3().setFromMatrixColumn(cam, 0);
    const camUp = new THREE.Vector3().setFromMatrixColumn(cam, 1);
    const camPos = new THREE.Vector3().setFromMatrixPosition(cam);
    const grid = GRID[s.fbLayout] ?? 1;
    const frames = grid * grid;
    const center = new THREE.Vector3();
    const vel = new THREE.Vector3();
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    const toCam = new THREE.Vector3();
    const P = pos.array as Float32Array;
    const U = uv.array as Float32Array;
    const C = col.array as Float32Array;
    for (let i = 0; i < this.count; i++) {
      const t = this.age[i]! / this.life[i]!;
      const seed = this.seed[i]!;
      center.set(this.px[i]!, this.py[i]!, this.pz[i]!);
      vel.set(this.vx[i]!, this.vy[i]!, this.vz[i]!);
      if (s.locked) {
        center.applyMatrix4(m);
        vel.transformDirection(m).multiplyScalar(Math.hypot(this.vx[i]!, this.vy[i]!, this.vz[i]!));
      }
      toCam.copy(camPos).sub(center).normalize();
      if (s.zoff) center.addScaledVector(toCam, s.zoff);
      const size = Math.max(0, evalNumberSeq(s.size, t, seed, 1));
      const squash = Math.max(-0.95, Math.min(3, evalNumberSeq(s.squash, t, 0.5, 0)));
      const k = 1 + squash;
      const halfW = (size / k) * 0.5;
      const halfH = size * k * 0.5;
      const angle = (this.rot[i]! * Math.PI) / 180;
      if (s.orient === 2 && vel.lengthSq() > 1e-8) {
        up.copy(vel).normalize();
        right.crossVectors(up, toCam).normalize();
      } else if (s.orient === 3 && vel.lengthSq() > 1e-8) {
        const n = vel.clone().normalize();
        right.set(1, 0, 0);
        if (Math.abs(n.x) > 0.9) right.set(0, 0, 1);
        right.cross(n).normalize();
        up.crossVectors(n, right).normalize();
        const c = Math.cos(angle);
        const sn = Math.sin(angle);
        const r2 = right.clone().multiplyScalar(c).addScaledVector(up, sn);
        up.copy(up).multiplyScalar(c).addScaledVector(right, -sn);
        right.copy(r2);
      } else if (s.orient === 1) {
        up.set(0, 1, 0);
        right.crossVectors(up, toCam).normalize();
      } else {
        const c = Math.cos(angle);
        const sn = Math.sin(angle);
        right.copy(camRight).multiplyScalar(c).addScaledVector(camUp, sn);
        up.copy(camUp).multiplyScalar(c).addScaledVector(camRight, -sn);
      }
      const o = i * 12;
      for (let corner = 0; corner < 4; corner++) {
        const sx = corner === 0 || corner === 3 ? -1 : 1;
        const sy = corner < 2 ? -1 : 1;
        P[o + corner * 3] = center.x + right.x * halfW * sx + up.x * halfH * sy;
        P[o + corner * 3 + 1] = center.y + right.y * halfW * sx + up.y * halfH * sy;
        P[o + corner * 3 + 2] = center.z + right.z * halfW * sx + up.z * halfH * sy;
      }
      let frame = 0;
      if (frames > 1) {
        const age = this.age[i]!;
        const start = this.frame[i]!;
        if (s.fbMode === 1) frame = Math.min(frames - 1, Math.floor(t * frames));
        else if (s.fbMode === 2) {
          const f = Math.floor(age * this.fps[i]! + start) % (frames * 2 - 2 || 1);
          frame = f < frames ? f : frames * 2 - 2 - f;
        } else if (s.fbMode === 3) frame = start;
        else frame = Math.floor(age * this.fps[i]! + start) % frames;
      }
      const cx = frame % grid;
      const cy = Math.floor(frame / grid);
      const u0 = cx / grid;
      const u1 = (cx + 1) / grid;
      const vTop = 1 - cy / grid;
      const vBottom = 1 - (cy + 1) / grid;
      const uo = i * 8;
      U[uo] = u0; U[uo + 1] = vBottom;
      U[uo + 2] = u1; U[uo + 3] = vBottom;
      U[uo + 4] = u1; U[uo + 5] = vTop;
      U[uo + 6] = u0; U[uo + 7] = vTop;
      evalColorSeq(s.color, t, tmpColor);
      const alpha = 1 - Math.min(1, Math.max(0, evalNumberSeq(s.tr, t, seed, 0)));
      const co = i * 16;
      for (let corner = 0; corner < 4; corner++) {
        C[co + corner * 4] = tmpColor.r * s.bright;
        C[co + corner * 4 + 1] = tmpColor.g * s.bright;
        C[co + corner * 4 + 2] = tmpColor.b * s.bright;
        C[co + corner * 4 + 3] = alpha;
      }
    }
    pos.needsUpdate = uv.needsUpdate = col.needsUpdate = true;
    this.geometry.setDrawRange(0, this.count * 6);
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ── Beams ───────────────────────────────────────────────────────────────────

function worldOf(obj: THREE.Object3D | undefined) {
  if (!obj) return null;
  obj.updateWorldMatrix(true, false);
  return obj.matrixWorld;
}

class BeamRuntime {
  readonly mesh: THREE.Mesh;
  private geometry = new THREE.BufferGeometry();
  private material: THREE.ShaderMaterial;
  private segments: number;
  private scroll = 0;
  textureState: "file" | "placeholder" | "none" = "none";
  enabled: boolean;

  constructor(readonly spec: EffectSpec, private attachments: Map<number, THREE.Object3D>, store: ResourceStore) {
    const r = spec.r;
    this.enabled = r.enabled !== false;
    this.segments = Math.max(1, Math.min(200, Number(r.seg ?? 10)));
    this.material = effectMaterial(store.placeholderSprite(), Number(r.le ?? 0));
    const tex = r.tex as string | null;
    this.textureState = tex ? "placeholder" : "none";
    if (tex && store.has("texture", tex)) {
      void store.texture(tex).then((t) => {
        if (!t) return;
        const clone = t.clone();
        clone.wrapS = THREE.RepeatWrapping;
        clone.needsUpdate = true;
        this.material.uniforms.map!.value = clone;
        this.textureState = "file";
      });
    } else if (tex) void store.texture(tex);
    const n = this.segments + 1;
    this.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 6), 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(n * 4), 2).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute("pcolor", new THREE.BufferAttribute(new Float32Array(n * 8), 4).setUsage(THREE.DynamicDrawUsage));
    const index: number[] = [];
    for (let i = 0; i < this.segments; i++) index.push(i * 2, i * 2 + 1, i * 2 + 3, i * 2, i * 2 + 3, i * 2 + 2);
    this.geometry.setIndex(index);
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 9;
    this.mesh.userData.node = spec.node;
  }

  get valid() {
    return this.attachments.has(this.spec.r.a0 as number) && this.attachments.has(this.spec.r.a1 as number);
  }

  update(dt: number, camera: THREE.Camera) {
    const r = this.spec.r;
    const m0 = worldOf(this.attachments.get(r.a0 as number));
    const m1 = worldOf(this.attachments.get(r.a1 as number));
    this.mesh.visible = Boolean(m0 && m1 && this.enabled);
    if (!m0 || !m1 || !this.enabled) return;
    this.scroll += dt * Number(r.texSpeed ?? 1);
    const p0 = new THREE.Vector3().setFromMatrixPosition(m0);
    const p1 = new THREE.Vector3().setFromMatrixPosition(m1);
    const a0 = new THREE.Vector3().setFromMatrixColumn(m0, 0).normalize();
    const a1 = new THREE.Vector3().setFromMatrixColumn(m1, 0).normalize();
    const y0 = new THREE.Vector3().setFromMatrixColumn(m0, 1).normalize();
    const y1 = new THREE.Vector3().setFromMatrixColumn(m1, 1).normalize();
    const c0 = p0.clone().addScaledVector(a0, Number(r.cs0 ?? 0));
    const c1 = p1.clone().addScaledVector(a1, -Number(r.cs1 ?? 0));
    const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    const pos = this.geometry.getAttribute("position") as THREE.BufferAttribute;
    const uv = this.geometry.getAttribute("uv") as THREE.BufferAttribute;
    const col = this.geometry.getAttribute("pcolor") as THREE.BufferAttribute;
    const point = new THREE.Vector3();
    const tangent = new THREE.Vector3();
    const side = new THREE.Vector3();
    let travelled = 0;
    let previous: THREE.Vector3 | null = null;
    const total = (() => {
      let len = 0;
      let prev = p0.clone();
      for (let i = 1; i <= this.segments; i++) {
        const next = new THREE.CubicBezierCurve3(p0, c0, c1, p1).getPoint(i / this.segments);
        len += next.distanceTo(prev);
        prev = next;
      }
      return len || 1;
    })();
    const curve = new THREE.CubicBezierCurve3(p0, c0, c1, p1);
    const texLen = Math.max(0.01, Number(r.texLen ?? 1));
    for (let i = 0; i <= this.segments; i++) {
      const t = i / this.segments;
      curve.getPoint(t, point);
      curve.getTangent(t, tangent);
      if (previous) travelled += point.distanceTo(previous);
      previous = point.clone();
      if (r.face) side.crossVectors(tangent, camPos.clone().sub(point)).normalize();
      else side.copy(y0).lerp(y1, t).normalize();
      const width = Number(r.w0 ?? 1) + (Number(r.w1 ?? 1) - Number(r.w0 ?? 1)) * t;
      pos.setXYZ(i * 2, point.x + side.x * width * 0.5, point.y + side.y * width * 0.5, point.z + side.z * width * 0.5);
      pos.setXYZ(i * 2 + 1, point.x - side.x * width * 0.5, point.y - side.y * width * 0.5, point.z - side.z * width * 0.5);
      const u = (Number(r.texMode ?? 0) === 0 ? t * texLen : travelled / texLen) - this.scroll;
      uv.setXY(i * 2, u, 1);
      uv.setXY(i * 2 + 1, u, 0);
      evalColorSeq(r.color as Seq, t, tmpColor);
      const alpha = 1 - Math.min(1, Math.max(0, evalNumberSeq(r.tr as Seq, t, 0.5, 0.5)));
      const b = Number(r.bright ?? 1);
      col.setXYZW(i * 2, tmpColor.r * b, tmpColor.g * b, tmpColor.b * b, alpha);
      col.setXYZW(i * 2 + 1, tmpColor.r * b, tmpColor.g * b, tmpColor.b * b, alpha);
    }
    void total;
    pos.needsUpdate = uv.needsUpdate = col.needsUpdate = true;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ── Trails ──────────────────────────────────────────────────────────────────

class TrailRuntime {
  readonly mesh: THREE.Mesh;
  private geometry = new THREE.BufferGeometry();
  private material: THREE.ShaderMaterial;
  private points: Array<{ a: THREE.Vector3; b: THREE.Vector3; time: number }> = [];
  private clock = 0;
  private static MAX = 256;
  textureState: "file" | "placeholder" | "none" = "none";
  enabled: boolean;

  constructor(readonly spec: EffectSpec, private attachments: Map<number, THREE.Object3D>, store: ResourceStore) {
    const r = spec.r;
    this.enabled = r.enabled !== false;
    this.material = effectMaterial(store.placeholderSprite(), Number(r.le ?? 0));
    const tex = r.tex as string | null;
    this.textureState = tex ? "placeholder" : "none";
    if (tex && store.has("texture", tex)) {
      void store.texture(tex).then((t) => {
        if (!t) return;
        const clone = t.clone();
        clone.wrapS = THREE.RepeatWrapping;
        clone.needsUpdate = true;
        this.material.uniforms.map!.value = clone;
        this.textureState = "file";
      });
    } else if (tex) void store.texture(tex);
    const n = TrailRuntime.MAX + 1;
    this.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 6), 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(n * 4), 2).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute("pcolor", new THREE.BufferAttribute(new Float32Array(n * 8), 4).setUsage(THREE.DynamicDrawUsage));
    const index: number[] = [];
    for (let i = 0; i < TrailRuntime.MAX; i++) index.push(i * 2, i * 2 + 1, i * 2 + 3, i * 2, i * 2 + 3, i * 2 + 2);
    this.geometry.setIndex(index);
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
    this.mesh.userData.node = spec.node;
  }

  clear() {
    this.points = [];
  }

  update(dt: number, camera: THREE.Camera) {
    const r = this.spec.r;
    this.clock += dt;
    const m0 = worldOf(this.attachments.get(r.a0 as number));
    const m1 = worldOf(this.attachments.get(r.a1 as number));
    if (!m0 || !m1) {
      this.mesh.visible = false;
      return;
    }
    const a = new THREE.Vector3().setFromMatrixPosition(m0);
    const b = new THREE.Vector3().setFromMatrixPosition(m1);
    const lifetime = Math.max(0.01, Number(r.life ?? 2));
    const minLen = Math.max(0, Number(r.minLen ?? 0.1));
    const last = this.points.at(-1);
    if (this.enabled && dt > 0 && (!last || last.a.distanceTo(a) + last.b.distanceTo(b) > minLen * 2)) {
      this.points.push({ a, b, time: this.clock });
      if (this.points.length > TrailRuntime.MAX) this.points.shift();
    }
    this.points = this.points.filter((p) => this.clock - p.time < lifetime);
    const maxLen = Number(r.maxLen ?? 0);
    if (maxLen > 0) {
      let len = 0;
      for (let i = this.points.length - 1; i > 0; i--) {
        len += this.points[i]!.a.distanceTo(this.points[i - 1]!.a);
        if (len > maxLen) {
          this.points = this.points.slice(i);
          break;
        }
      }
    }
    const samples = [...this.points, { a, b, time: this.clock }];
    this.mesh.visible = samples.length > 1;
    const pos = this.geometry.getAttribute("position") as THREE.BufferAttribute;
    const uv = this.geometry.getAttribute("uv") as THREE.BufferAttribute;
    const col = this.geometry.getAttribute("pcolor") as THREE.BufferAttribute;
    const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    const texLen = Math.max(0.01, Number(r.texLen ?? 1));
    let travelled = 0;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[samples.length - 1 - i]!;
      const age = Math.min(1, (this.clock - s.time) / lifetime);
      const widthScale = Math.max(0, evalNumberSeq(r.widthScale as Seq, age, 0.5, 1));
      const mid = s.a.clone().add(s.b).multiplyScalar(0.5);
      let halfA = s.a.clone().sub(mid).multiplyScalar(widthScale);
      if (r.face && i < samples.length - 1) {
        const next = samples[samples.length - 2 - i]!;
        const tangent = next.a.clone().add(next.b).multiplyScalar(0.5).sub(mid).normalize();
        halfA = tangent.cross(camPos.clone().sub(mid)).normalize().multiplyScalar(s.a.distanceTo(s.b) * 0.5 * widthScale);
      }
      pos.setXYZ(i * 2, mid.x + halfA.x, mid.y + halfA.y, mid.z + halfA.z);
      pos.setXYZ(i * 2 + 1, mid.x - halfA.x, mid.y - halfA.y, mid.z - halfA.z);
      if (i > 0) {
        const prev = samples[samples.length - i]!;
        travelled += prev.a.clone().add(prev.b).multiplyScalar(0.5).distanceTo(mid);
      }
      const u = Number(r.texMode ?? 0) === 0 ? i / Math.max(1, samples.length - 1) : travelled / texLen;
      uv.setXY(i * 2, u, 1);
      uv.setXY(i * 2 + 1, u, 0);
      evalColorSeq(r.color as Seq, age, tmpColor);
      const alpha = 1 - Math.min(1, Math.max(0, evalNumberSeq(r.tr as Seq, age, 0.5, 0.5)));
      const br = Number(r.bright ?? 1);
      col.setXYZW(i * 2, tmpColor.r * br, tmpColor.g * br, tmpColor.b * br, alpha);
      col.setXYZW(i * 2 + 1, tmpColor.r * br, tmpColor.g * br, tmpColor.b * br, alpha);
    }
    pos.needsUpdate = uv.needsUpdate = col.needsUpdate = true;
    this.geometry.setDrawRange(0, Math.max(0, samples.length - 1) * 6);
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ── Runtime ─────────────────────────────────────────────────────────────────

export interface EffectInfo {
  node: number;
  className: string;
  enabled: boolean;
  live: number;
  emitCount: number;
  texture: "file" | "placeholder" | "none";
  issue: string | null;
}

export class EffectRuntime {
  readonly group = new THREE.Group();
  private emitters: EmitterRuntime[] = [];
  private beams: BeamRuntime[] = [];
  private trails: TrailRuntime[] = [];

  constructor(specs: EffectSpec[], attachments: Map<number, THREE.Object3D>, store: ResourceStore) {
    this.group.name = "effects";
    for (const spec of specs) {
      if (spec.className === "Beam") {
        const b = new BeamRuntime(spec, attachments, store);
        this.beams.push(b);
        this.group.add(b.mesh);
      } else if (spec.className === "Trail") {
        const t = new TrailRuntime(spec, attachments, store);
        this.trails.push(t);
        this.group.add(t.mesh);
      } else {
        const e = new EmitterRuntime(spec, store);
        this.emitters.push(e);
        this.group.add(e.mesh);
      }
    }
  }

  get empty() {
    return !this.emitters.length && !this.beams.length && !this.trails.length;
  }

  get hasBursts() {
    return this.emitters.some((e) => e.emitCount > 0 || e.emitDuration > 0);
  }

  /** Longest particle lifetime + delay — used to space looping bursts. */
  get burstPeriod() {
    let max = 1;
    for (const e of this.emitters) max = Math.max(max, e.emitDelay + (e.settings.life[1] ?? 1));
    return max + 0.4;
  }

  update(dt: number, camera: THREE.Camera) {
    for (const e of this.emitters) e.update(dt, camera);
    for (const b of this.beams) b.update(dt, camera);
    for (const t of this.trails) t.update(dt, camera);
  }

  burst() {
    for (const e of this.emitters) e.burst();
  }

  emit(node: number, count: number) {
    this.emitters.find((e) => e.spec.node === node)?.emit(count);
  }

  reset() {
    for (const e of this.emitters) e.clear();
    for (const t of this.trails) t.clear();
  }

  setEnabled(node: number, enabled: boolean) {
    for (const x of [...this.emitters, ...this.beams, ...this.trails]) if (x.spec.node === node) x.enabled = enabled;
  }

  info(): EffectInfo[] {
    return [
      ...this.emitters.map((e) => ({
        node: e.spec.node,
        className: e.spec.className,
        enabled: e.enabled,
        live: e.live,
        emitCount: e.emitCount,
        texture: e.textureState,
        issue:
          e.spec.className !== "ParticleEmitter"
            ? "Legacy effect — drawn with a stand-in recipe"
            : !e.settings.enabled && !e.emitCount
              ? "Disabled in the file (usually started by a script) — use Emit"
              : null,
      })),
      ...this.beams.map((b) => ({ node: b.spec.node, className: "Beam", enabled: b.enabled, live: 0, emitCount: 0, texture: b.textureState, issue: b.valid ? null : "Missing an attachment" })),
      ...this.trails.map((t) => ({ node: t.spec.node, className: "Trail", enabled: t.enabled, live: 0, emitCount: 0, texture: t.textureState, issue: "Appears when its attachments move — try Motion" })),
    ];
  }

  dispose() {
    for (const x of [...this.emitters, ...this.beams, ...this.trails]) x.dispose();
    this.group.clear();
  }
}
