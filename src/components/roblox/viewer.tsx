"use client";

import {
  Box,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Download,
  Expand,
  Grid3x3,
  Home,
  Loader2,
  Pause,
  PanelRight,
  Play,
  Repeat,
  RotateCcw,
  Scan,
  Shrink,
  Sparkles,
  Sun,
  PersonStanding,
  LayoutTemplate,
  Bone,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { buildClip, buildRigSolver, sampleClip, type AnimationClip, type ClipBinding, type Mat, type RigSolver } from "@/lib/roblox/animation";
import type { RobloxManifest } from "@/lib/roblox/manifest";
import { cn, formatTimecode } from "@/lib/utils";
import type { TimelineHandle } from "../card/workspace-context";
import { PortalContainer, Select } from "../ui/controls";
import { keyBelongsToControl } from "../ui/keys";
import { Tooltip } from "../ui/menu";
import { TipAnchor, useTipOnOpen } from "../tutorial/tutorial";
import { EffectRuntime, type EffectInfo } from "./effects";
import { EffectsPanel, ExplorerPanel, FidelityPanel, PropertiesPanel, ResourcesPanel, type ResourceActions } from "./panels";
import { ResourceStore, type ResolvedResource } from "./resources";
import { buildScene, matrixFromCFrame, type BuiltScene } from "./scene";

// The 2D UI renderer (and its bundled fonts) only loads for files that have UI.
const UiStage = dynamic(() => import("./ui-stage"), { ssr: false });

export type ViewerMode = "model" | "animation" | "effects" | "ui";

export interface RigChoice {
  manifest: RobloxManifest;
  rigIndex: number;
  label: string;
  source: "file" | "attachment" | "standard";
}

export interface TimeMarker {
  id: string;
  timestampMs: number;
  author: string;
  text: string;
  resolved: boolean;
}

export interface ViewerProps {
  manifest: RobloxManifest;
  filename: string;
  downloadUrl: string | null;
  rig: RigChoice | null;
  rigPicker: ReactNode;
  resources: Array<ResolvedResource & { id?: string }>;
  resourceActions: ResourceActions;
  initialMode: ViewerMode;
  timelineRef: RefObject<TimelineHandle | null>;
  markers: TimeMarker[];
  activeMarkerId: string | null;
  onMarkerClick: (id: string) => void;
  onTimelineActive: (active: boolean) => void;
  onPlayingChange?: (playing: boolean) => void;
  onTimeChange?: (ms: number) => void;
  /** The KeyframeSequence node of the animation now selected (lets the container pick a matching rig). */
  onClipChange?: (animationNode: number) => void;
}

type Background = "dark" | "light" | "black" | "checker" | "sky";
type Lighting = "studio" | "day" | "night" | "flat";
type Motion = "none" | "orbit" | "swing" | "spin";
type Panel = "explorer" | "properties" | "resources" | "fidelity" | "effects";

const SPEED_OPTIONS = [0.25, 0.5, 1, 1.5, 2].map((v) => ({ value: String(v), label: `${v}×` }));

const BACKGROUNDS: Record<Background, string> ={ dark: "#15161c", light: "#e7e8ee", black: "#000000", checker: "#2a2b31", sky: "#7fb4e8" };

/** Name of the rig (or model) an animation is stored in. */
function ownerOf(manifest: RobloxManifest, node: number): string {
  const rigNodes = new Set(manifest.rigs.map((r) => r.node));
  let model: string | null = null;
  for (let p = manifest.nodes[node]!.p; p !== -1; p = manifest.nodes[p]!.p) {
    if (rigNodes.has(p)) return manifest.nodes[p]!.n;
    if (!model && manifest.nodes[p]!.c === "Model" && manifest.nodes[p]!.n !== "AnimSaves") model = manifest.nodes[p]!.n;
  }
  return model ?? manifest.nodes[manifest.nodes[node]!.p]?.n ?? "file";
}

/**
 * Where the camera starts: in front of the first rig's root part (Roblox characters face their
 * LookVector), slightly to its right and above. Only the horizontal part of the LookVector is
 * used — bone rigs' root parts are often tilted (Blender is Z-up) — and world up stays up.
 */
function viewDirection(manifest: RobloxManifest, rigIndex: number): THREE.Vector3 {
  const fallback = new THREE.Vector3(1, 0.62, 1.1).normalize();
  const rootPart = manifest.rigs[rigIndex]?.rootPart;
  const cf = rootPart !== null && rootPart !== undefined ? (manifest.nodes[rootPart]?.r.cf as number[] | undefined) : undefined;
  if (!cf) return fallback;
  const look = new THREE.Vector3(-cf[5]!, 0, -cf[11]!);
  if (look.lengthSq() < 0.25) return fallback;
  look.normalize();
  const right = look.clone().cross(new THREE.Vector3(0, 1, 0));
  return look.multiplyScalar(1.1).addScaledVector(right, 0.6).add(new THREE.Vector3(0, 0.62, 0)).normalize();
}

function checkerTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#3a3b42";
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = "#2b2c32";
  ctx.fillRect(0, 0, 32, 32);
  ctx.fillRect(32, 32, 32, 32);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(24, 14);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function skyTexture() {
  const c = document.createElement("canvas");
  c.width = 2;
  c.height = 256;
  const ctx = c.getContext("2d")!;
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, "#3d7bd1");
  g.addColorStop(0.6, "#9cc8f0");
  g.addColorStop(1, "#dbe9f5");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 2, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function IconButton({ label, onClick, active, children, shortcut, disabled }: { label: string; onClick: () => void; active?: boolean; children: ReactNode; shortcut?: string; disabled?: boolean }) {
  return (
    <Tooltip content={label} shortcut={shortcut}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        disabled={disabled}
        onClick={onClick}
        className={cn("flex size-8 items-center justify-center rounded-md text-white/80 hover:bg-white/10 hover:text-white disabled:opacity-40 [&_svg]:size-4", active && "bg-white/15 text-white")}
      >
        {children}
      </button>
    </Tooltip>
  );
}

export default function RobloxViewer(props: ViewerProps) {
  const { manifest, rig, resources, initialMode, timelineRef, onTimelineActive, onPlayingChange, onTimeChange } = props;
  // The preview opening is the moment to explain inspection, missing resources and fidelity.
  useTipOnOpen("roblox.preview");
  const container = useRef<HTMLDivElement>(null);
  const canvasHost = useRef<HTMLDivElement>(null);

  const [webglError, setWebglError] = useState<string | null>(null);
  const modes = useMemo(() => {
    const list: ViewerMode[] = [];
    // Without WebGL only the 2D UI view can run.
    if (!webglError) {
      if (manifest.summary.parts > 0) list.push("model");
      if (manifest.capabilities.animation) list.push("animation");
      if (manifest.capabilities.effects) list.push("effects");
    }
    if (manifest.capabilities.ui) list.push("ui");
    return list.length ? list : (["model"] as ViewerMode[]);
  }, [manifest, webglError]);
  const [mode, setMode] = useState<ViewerMode>(modes.includes(initialMode) ? initialMode : modes[0]!);
  useEffect(() => {
    if (!modes.includes(mode)) setMode(modes[0]!);
  }, [modes, mode]);
  const [uiNotes, setUiNotes] = useState<string[]>([]);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [background, setBackground] = useState<Background>("dark");
  const [lighting, setLighting] = useState<Lighting>(manifest.capabilities.effects && !manifest.capabilities.animation ? "night" : "studio");
  const [grid, setGrid] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [resourceVersion, setResourceVersion] = useState(0);

  // Animation state
  const playable = useMemo(() => manifest.animations.filter((a) => a.kind === "keyframes" && a.keyframes > 0), [manifest]);
  const clips = useMemo<AnimationClip[]>(() => playable.map((a) => buildClip(manifest, a.node)), [manifest, playable]);
  // Files with several characters often repeat clip names ("Run" for each): say whose each one is.
  const clipLabels = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of clips) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
    return playable.map((a, i) => (counts.get(clips[i]!.name)! > 1 ? `${clips[i]!.name} · ${ownerOf(manifest, a.node)}` : clips[i]!.name));
  }, [manifest, playable, clips]);
  const [clipIndex, setClipIndex] = useState(0);
  const clip = clips[clipIndex] ?? null;
  const onClipChange = props.onClipChange;
  useEffect(() => {
    const node = playable[clipIndex]?.node;
    if (node !== undefined) onClipChange?.(node);
  }, [playable, clipIndex, onClipChange]);
  // Skinned meshes on stage (known once their meshes have loaded) and the skeleton overlay.
  const [skinInfo, setSkinInfo] = useState<{ meshes: number; missingMeshes: number } | null>(null);
  const [showBones, setShowBones] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(clip?.loop ?? true);
  const [speed, setSpeed] = useState(1);
  const [time, setTime] = useState(0);
  useEffect(() => setLoop(clip?.loop ?? true), [clip]);

  // Effects state
  const [effectsPlaying, setEffectsPlaying] = useState(true);
  const [loopBursts, setLoopBursts] = useState(true);
  const [effectSpeed, setEffectSpeed] = useState(1);
  const [motion, setMotion] = useState<Motion>("none");
  const [effectInfo, setEffectInfo] = useState<EffectInfo[]>([]);
  const [runtimeNotes, setRuntimeNotes] = useState<string[]>([]);

  // What's on stage: the rig (for a standalone animation) or the file itself.
  const displayManifest = mode === "animation" && rig && rig.source !== "file" ? rig.manifest : manifest;
  const resourcesKey = resources.map((r) => `${r.kind}:${r.contentId}:${r.url.split("?")[0]}`).join("|");

  // Mutable three.js state lives in refs; React state is only for UI.
  const three = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    envTexture: THREE.Texture;
    hemi: THREE.HemisphereLight;
    sun: THREE.DirectionalLight;
    ambient: THREE.AmbientLight;
    gridHelper: THREE.GridHelper | null;
    selection: THREE.BoxHelper | null;
    marker: THREE.Mesh;
    built: BuiltScene | null;
    effects: EffectRuntime | null;
    store: ResourceStore | null;
    solver: RigSolver | null;
    /** Track-to-joint bindings of the current solver, per clip. */
    bindings: WeakMap<AnimationClip, ClipBinding>;
    clock: THREE.Clock;
    visible: boolean;
    bgTextures: THREE.Texture[];
  } | null>(null);
  // Parent callbacks change identity every render; read them through a ref so the renderer lives once.
  const callbacks = useRef({ onPlayingChange, onTimeChange });
  callbacks.current = { onPlayingChange, onTimeChange };
  const live = useRef({ mode, playing, loop, speed, time: 0, clip, effectsPlaying, loopBursts, effectSpeed, motion, motionTime: 0, burstTimer: 0 });
  live.current.mode = mode;
  live.current.playing = playing;
  live.current.loop = loop;
  live.current.speed = speed;
  live.current.clip = clip;
  live.current.effectsPlaying = effectsPlaying;
  live.current.loopBursts = loopBursts;
  live.current.effectSpeed = effectSpeed;
  live.current.motion = motion;

  // ── Renderer lifecycle ─────────────────────────────────────────────────────
  useEffect(() => {
    const host = canvasHost.current;
    if (!host) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false, powerPreference: "high-performance" });
    } catch {
      setWebglError("WebGL isn't available in this browser, so the 3D preview can't run. Download the original to open it in Roblox Studio.");
      return;
    }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(renderer.domElement);
    renderer.domElement.className = "block h-full w-full outline-none";
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute("aria-label", "3D preview — drag to orbit, right-drag to pan, scroll to zoom");

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 5000);
    camera.position.set(12, 9, 12);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.screenSpacePanning = true;
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const envTexture = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    pmrem.dispose();
    scene.environment = envTexture;
    const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x3a3530, 1.1);
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(30, 50, 20);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const ambient = new THREE.AmbientLight(0xffffff, 0);
    scene.add(hemi, sun, sun.target, ambient);
    const marker = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 8), new THREE.MeshBasicMaterial({ color: 0x8b7bff, depthTest: false, transparent: true, opacity: 0.9 }));
    marker.renderOrder = 100;
    marker.visible = false;
    scene.add(marker);

    const state: NonNullable<typeof three.current> = { renderer, scene, camera, controls, envTexture, hemi, sun, ambient, gridHelper: null, selection: null, marker, built: null, effects: null, store: null, solver: null, bindings: new WeakMap(), clock: new THREE.Clock(), visible: true, bgTextures: [] };
    three.current = state;

    const resize = () => {
      const w = host.clientWidth || 1;
      const h = host.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();
    // Don't burn the GPU when the preview is scrolled out of view.
    const io = new IntersectionObserver(([entry]) => {
      state.visible = Boolean(entry?.isIntersecting);
    });
    io.observe(host);

    let uiTick = 0;
    renderer.setAnimationLoop(() => {
      const dt = Math.min(0.1, state.clock.getDelta());
      // The 2D UI view covers the canvas: don't spend the GPU on a scene nobody sees.
      if (!state.visible || document.hidden || live.current.mode === "ui") return;
      const l = live.current;
      const built = state.built;
      // Animation
      if (built && state.solver && l.mode === "animation" && l.clip) {
        if (l.playing) {
          l.time += dt * l.speed;
          if (l.time > l.clip.length) {
            if (l.loop && l.clip.length > 0) l.time %= l.clip.length;
            else {
              l.time = l.clip.length;
              l.playing = false;
              setPlaying(false);
              callbacks.current.onPlayingChange?.(false);
              callbacks.current.onTimeChange?.(Math.round(l.time * 1000));
            }
          }
        }
        let binding = state.bindings.get(l.clip);
        if (!binding) {
          binding = state.solver.bind(l.clip);
          state.bindings.set(l.clip, binding);
        }
        const pose = state.solver.solve(sampleClip(l.clip, l.time), binding);
        for (const [node, cf] of pose.parts) {
          const obj = built.partObjects.get(node);
          if (!obj) continue;
          matrixFromCFrame(cf as Mat, obj.matrix);
          obj.matrixWorldNeedsUpdate = true;
        }
        for (const [node, cf] of pose.bones) {
          const obj = built.boneObjects.get(node);
          if (!obj) continue;
          matrixFromCFrame(cf as Mat, obj.matrix);
          obj.matrixWorldNeedsUpdate = true;
        }
      }
      // Effects (+ motion so trails and velocity inheritance have something to show)
      if (built && state.effects) {
        const running = l.mode === "effects" && l.effectsPlaying;
        const step = running ? dt * l.effectSpeed : 0;
        if (running) {
          l.motionTime += step;
          const t = l.motionTime;
          built.root.position.set(0, 0, 0);
          built.root.rotation.set(0, 0, 0);
          if (l.motion === "orbit") {
            built.root.position.set(Math.cos(t * 2) * 4, 0, Math.sin(t * 2) * 4);
          } else if (l.motion === "swing") {
            built.root.rotation.z = Math.sin(t * 3) * 0.6;
          } else if (l.motion === "spin") {
            built.root.rotation.y = t * 2.5;
          }
          if (l.loopBursts && state.effects.hasBursts) {
            l.burstTimer -= step;
            if (l.burstTimer <= 0) {
              state.effects.burst();
              l.burstTimer = state.effects.burstPeriod;
            }
          }
        }
        built.root.updateMatrixWorld(true);
        state.effects.group.visible = l.mode === "effects";
        state.effects.update(step, camera);
      } else if (built) {
        built.root.updateMatrixWorld(true);
      }
      state.selection?.update();
      controls.update();
      renderer.render(scene, camera);
      uiTick += dt;
      if (uiTick > 0.1) {
        uiTick = 0;
        if (l.mode === "animation" && l.playing) setTime(l.time);
        if (l.mode === "effects" && state.effects) setEffectInfo(state.effects.info());
      }
    });

    const onFullscreen = () => setFullscreen(document.fullscreenElement === container.current);
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreen);
      renderer.setAnimationLoop(null);
      ro.disconnect();
      io.disconnect();
      state.effects?.dispose();
      state.built?.dispose();
      state.store?.dispose();
      state.selection?.dispose();
      state.gridHelper?.dispose();
      for (const t of state.bgTextures) t.dispose();
      marker.geometry.dispose();
      (marker.material as THREE.Material).dispose();
      envTexture.dispose();
      controls.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      three.current = null;
    };
  }, []);

  // ── Frame the camera ───────────────────────────────────────────────────────
  // The default view: in front of a character (its root part's LookVector), else from the front-right corner.
  const defaultView = useRef(new THREE.Vector3(1, 0.62, 1.1).normalize());
  const frame = useCallback((box: THREE.Box3, fromDefault = false) => {
    const s = three.current;
    if (!s || box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(0.5, sphere.radius);
    const distance = radius / Math.sin((s.camera.fov * Math.PI) / 360) * 1.05;
    const dir = fromDefault ? defaultView.current.clone() : s.camera.position.clone().sub(s.controls.target).normalize();
    s.controls.target.copy(sphere.center);
    s.camera.position.copy(sphere.center).addScaledVector(dir, distance);
    s.camera.near = Math.max(0.02, distance / 500);
    s.camera.far = Math.max(1000, distance * 50);
    s.camera.updateProjectionMatrix();
    s.controls.update();
  }, []);

  /** What "frame all" shows: the animated rig in animation mode (a place file's map would dwarf it), else everything. */
  const stageBounds = useCallback((forMode: ViewerMode) => {
    const s = three.current;
    if (!s?.built) return null;
    const all = s.built.bounds();
    if (forMode !== "animation" || !s.solver?.parts.size) return all;
    s.built.root.updateMatrixWorld(true);
    const rigBox = new THREE.Box3();
    for (const node of s.solver.parts.keys()) {
      const obj = s.built.partObjects.get(node);
      if (obj) rigBox.expandByObject(obj);
    }
    if (rigBox.isEmpty()) return all;
    // Only zoom in when the rig is a small part of the scene.
    return rigBox.getBoundingSphere(new THREE.Sphere()).radius < all.getBoundingSphere(new THREE.Sphere()).radius * 0.5 ? rigBox : all;
  }, []);

  const frameAll = useCallback(() => {
    const box = stageBounds(live.current.mode);
    if (box) frame(box, true);
  }, [frame, stageBounds]);

  // Switching between animation and the other modes re-frames when that changes what's worth looking at.
  const framedFor = useRef<"rig" | "all">("all");
  useEffect(() => {
    const s = three.current;
    if (!s?.built || mode === "ui") return;
    const box = stageBounds(mode);
    const target = box && mode === "animation" && box !== null && !box.equals(s.built.bounds()) ? "rig" : "all";
    if (target !== framedFor.current && box) {
      framedFor.current = target;
      frame(box, true);
    }
  }, [mode, stageBounds, frame]);

  const frameSelection = useCallback(() => {
    const s = three.current;
    if (!s?.built) return;
    if (selected === null) return frameAll();
    const obj = s.built.nodeObjects.get(selected);
    if (!obj) return frameAll();
    const box = new THREE.Box3().setFromObject(obj);
    if (box.isEmpty() || !Number.isFinite(box.min.x)) {
      const p = new THREE.Vector3().setFromMatrixPosition(obj.matrixWorld);
      box.setFromCenterAndSize(p, new THREE.Vector3(4, 4, 4));
    }
    frame(box);
  }, [selected, frame, frameAll]);

  // ── Build the scene whenever what's on stage changes ───────────────────────
  useEffect(() => {
    const s = three.current;
    if (!s) return;
    const store = new ResourceStore(resources, () => setResourceVersion((v) => v + 1));
    const built = buildScene(displayManifest, store);
    s.scene.add(built.root);
    const effects = displayManifest === manifest && manifest.capabilities.effects ? new EffectRuntime(built.effects, built.attachmentObjects, store) : null;
    if (effects) s.scene.add(effects.group);
    s.built = built;
    s.effects = effects;
    s.store = store;
    live.current.burstTimer = 0.2;
    live.current.motionTime = 0;
    // Rig solver for animation mode.
    s.solver = null;
    s.bindings = new WeakMap();
    if (rig) {
      try {
        s.solver = rig.source === "file" ? buildRigSolver(manifest, rig.rigIndex) : displayManifest === rig.manifest ? buildRigSolver(rig.manifest, rig.rigIndex) : null;
      } catch {
        s.solver = null;
      }
    }
    defaultView.current = viewDirection(displayManifest, rig && (rig.source === "file" || displayManifest === rig.manifest) ? rig.rigIndex : 0);
    const initial = stageBounds(live.current.mode) ?? built.bounds();
    framedFor.current = initial.equals(built.bounds()) ? "all" : "rig";
    frame(initial, true);
    // Grid under the model.
    const box = built.bounds();
    const size = box.getSize(new THREE.Vector3());
    const extent = Math.max(8, Math.ceil(Math.max(size.x, size.z) * 1.6 / 4) * 4);
    s.gridHelper?.removeFromParent();
    s.gridHelper?.dispose();
    const gridHelper = new THREE.GridHelper(extent, Math.max(4, extent / 2), 0x5b5f6b, 0x33363f);
    // Under the model, wherever it sits in the world (place files are rarely centred on the origin).
    const centre = box.getCenter(new THREE.Vector3());
    gridHelper.position.set(centre.x, box.min.y - 0.01, centre.z);
    (gridHelper.material as THREE.Material).transparent = true;
    (gridHelper.material as THREE.Material).opacity = 0.5;
    gridHelper.visible = grid;
    s.scene.add(gridHelper);
    s.gridHelper = gridHelper;
    // Shadow camera covers the model.
    const r = Math.max(10, size.length());
    const cam = s.sun.shadow.camera as THREE.OrthographicCamera;
    cam.left = cam.bottom = -r;
    cam.right = cam.top = r;
    cam.near = 0.5;
    cam.far = r * 6;
    s.sun.position.copy(box.getCenter(new THREE.Vector3())).add(new THREE.Vector3(r * 0.8, r * 1.6, r * 0.6));
    s.sun.target.position.copy(box.getCenter(new THREE.Vector3()));
    cam.updateProjectionMatrix();
    setSkinInfo(null);
    void built.ready.then(() => {
      if (s.built !== built) return;
      const notes: string[] = [];
      const skin = built.runtime.skin;
      setSkinInfo({ meshes: skin.meshes, missingMeshes: built.runtime.placeholderMeshes.size });
      if (skin.meshes) notes.push(`${skin.meshes} skinned mesh${skin.meshes === 1 ? "" : "es"} deform${skin.meshes === 1 ? "s" : ""} with ${skin.boundBones} bone${skin.boundBones === 1 ? "" : "s"} from this file (linear blend skinning, up to 4 bones per vertex, like Roblox).`);
      if (skin.unboundBones.length) {
        const names = [...new Set(skin.unboundBones)];
        notes.push(`${names.length} mesh bone${names.length === 1 ? " has" : "s have"} no Bone of the same name in the model (${names.slice(0, 5).join(", ")}${names.length > 5 ? "…" : ""}); the vertices ${names.length === 1 ? "it moves" : "they move"} stay in the bind pose.`);
      }
      for (const error of skin.errors) notes.push(`Skinning data couldn't be read — drawn rigid: ${error}`);
      if (built.runtime.placeholderMeshes.size) notes.push(`${built.runtime.placeholderMeshes.size} mesh${built.runtime.placeholderMeshes.size === 1 ? " is" : "es are"} missing — those parts are shown as translucent boxes of the right size. Provide them in Resources.`);
      if (built.runtime.unionBoxes) notes.push(`${built.runtime.unionBoxes} union${built.runtime.unionBoxes === 1 ? "" : "s"} shown as boxes (solid-modelling geometry isn't decoded).`);
      if (built.runtime.missingDecals) notes.push(`${built.runtime.missingDecals} decal/texture image${built.runtime.missingDecals === 1 ? " is" : "s are"} missing and not drawn — provide ${built.runtime.missingDecals === 1 ? "it" : "them"} in Resources.`);
      if (built.runtime.decalsWithoutMesh.length) {
        const first = built.runtime.decalsWithoutMesh[0]!;
        notes.push(
          `${built.runtime.decalsWithoutMesh.length} decal${built.runtime.decalsWithoutMesh.length === 1 ? "" : "s"} (e.g. “${first.decal}” on ${first.part}) can't be placed until ${built.runtime.decalsWithoutMesh.length === 1 ? "its part's mesh" : "their parts' meshes"}${first.meshId ? ` (${first.meshId})` : ""} ${built.runtime.decalsWithoutMesh.length === 1 ? "is" : "are"} provided — a decal is projected onto the mesh surface.`,
        );
      }
      if (built.runtime.headApprox) notes.push("Classic heads are drawn as rounded cylinders (Roblox's head mesh isn't bundled).");
      if (effects?.info().some((e) => e.texture === "placeholder")) notes.push("Some effects use a soft placeholder sprite because their texture wasn't provided.");
      if (displayManifest !== manifest && rig?.source === "standard") notes.push("Animation shown on a standard block rig — a stand-in, not your character.");
      setRuntimeNotes(notes);
      if (effects) setEffectInfo(effects.info());
    });
    if (effects) setEffectInfo(effects.info());
    return () => {
      s.selection?.removeFromParent();
      s.selection?.dispose();
      s.selection = null;
      s.marker.visible = false;
      built.root.removeFromParent();
      effects?.group.removeFromParent();
      effects?.dispose();
      built.dispose();
      store.dispose();
      if (s.built === built) {
        s.built = null;
        s.effects = null;
        s.store = null;
        s.solver = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayManifest, resourcesKey, rig]);

  // Visibility toggles from the explorer.
  useEffect(() => {
    const s = three.current;
    if (!s?.built) return;
    for (const [node, obj] of s.built.partObjects) obj.visible = !hidden.has(node);
    for (const e of s.built.effects) s.effects?.setEnabled(e.node, !hidden.has(e.node) && e.r.enabled !== false);
  }, [hidden]);

  // Background, grid and lighting presets.
  useEffect(() => {
    const s = three.current;
    if (!s) return;
    for (const t of s.bgTextures) t.dispose();
    s.bgTextures = [];
    if (background === "checker") {
      const t = checkerTexture();
      s.bgTextures.push(t);
      s.scene.background = t;
    } else if (background === "sky") {
      const t = skyTexture();
      s.bgTextures.push(t);
      s.scene.background = t;
    } else {
      s.scene.background = new THREE.Color(BACKGROUNDS[background]);
    }
  }, [background]);
  useEffect(() => {
    if (three.current?.gridHelper) three.current.gridHelper.visible = grid;
  }, [grid]);
  useEffect(() => {
    const s = three.current;
    if (!s) return;
    const presets: Record<Lighting, { hemi: number; sun: number; ambient: number; env: boolean; shadows: boolean; exposure: number }> = {
      studio: { hemi: 1.1, sun: 2.2, ambient: 0, env: true, shadows: true, exposure: 1 },
      day: { hemi: 1.4, sun: 3.2, ambient: 0, env: true, shadows: true, exposure: 1.05 },
      night: { hemi: 0.12, sun: 0.25, ambient: 0.05, env: false, shadows: false, exposure: 1.1 },
      flat: { hemi: 0, sun: 0, ambient: 2.4, env: false, shadows: false, exposure: 1 },
    };
    const p = presets[lighting];
    s.hemi.intensity = p.hemi;
    s.sun.intensity = p.sun;
    s.sun.castShadow = p.shadows;
    s.ambient.intensity = p.ambient;
    s.scene.environment = p.env ? s.envTexture : null;
    s.renderer.toneMappingExposure = p.exposure;
    if (lighting === "day") s.hemi.color.set(0xbfdcff);
    else s.hemi.color.set(0xdfe8ff);
  }, [lighting]);

  // Selection highlight.
  useEffect(() => {
    const s = three.current;
    if (!s) return;
    s.selection?.removeFromParent();
    s.selection?.dispose();
    s.selection = null;
    s.marker.visible = false;
    if (selected === null || !s.built) return;
    const obj = s.built.nodeObjects.get(selected);
    if (!obj) return;
    if (s.built.partObjects.has(selected)) {
      const helper = new THREE.BoxHelper(obj, 0x8b7bff);
      (helper.material as THREE.Material).depthTest = false;
      helper.renderOrder = 99;
      s.scene.add(helper);
      s.selection = helper;
    } else {
      s.marker.position.setFromMatrixPosition(obj.matrixWorld);
      s.marker.visible = true;
    }
  }, [selected, displayManifest]);

  // Click to select.
  useEffect(() => {
    const s = three.current;
    if (!s) return;
    const el = s.renderer.domElement;
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
    };
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || !s.built) return;
      const rect = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, s.camera);
      const hit = ray.intersectObject(s.built.root, true).find((h) => h.object.visible && (h.object as THREE.Mesh).isMesh);
      let node: number | null = null;
      for (let o: THREE.Object3D | null = hit?.object ?? null; o; o = o.parent) {
        if (typeof o.userData.node === "number") {
          node = o.userData.node;
          break;
        }
      }
      setSelected(node);
      if (node !== null) setPanel((p) => (p === null || p === "explorer" || p === "fidelity" ? "properties" : p));
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
    };
  }, []);

  // ── Animation timeline handle (for timestamped feedback) ───────────────────
  const seek = useCallback(
    (ms: number) => {
      const c = live.current.clip;
      if (!c) return;
      live.current.time = Math.min(c.length, Math.max(0, ms / 1000));
      setTime(live.current.time);
      callbacks.current.onTimeChange?.(Math.round(live.current.time * 1000));
    },
    [],
  );
  const setPlay = useCallback(
    (value: boolean) => {
      const c = live.current.clip;
      if (value && c && live.current.time >= c.length && !live.current.loop) live.current.time = 0;
      live.current.playing = value;
      setPlaying(value);
      callbacks.current.onPlayingChange?.(value);
      if (!value) {
        setTime(live.current.time);
        callbacks.current.onTimeChange?.(Math.round(live.current.time * 1000));
      }
    },
    [],
  );
  const animationActive = mode === "animation" && Boolean(clip) && Boolean(three.current?.solver ?? rig);
  useEffect(() => {
    if (!animationActive) {
      onTimelineActive(false);
      return;
    }
    timelineRef.current = {
      seek,
      play: () => setPlay(true),
      pause: () => setPlay(false),
      currentTimeMs: () => Math.round(live.current.time * 1000),
    };
    onTimelineActive(true);
    return () => {
      timelineRef.current = null;
      onTimelineActive(false);
    };
  }, [animationActive, seek, setPlay, timelineRef, onTimelineActive]);

  // Leaving animation mode puts the rig back in its saved pose.
  useEffect(() => {
    const s = three.current;
    if (mode === "animation" || !s?.built || !s.solver) return;
    for (const [node, part] of s.solver.parts) {
      const obj = s.built.partObjects.get(node);
      if (obj) {
        matrixFromCFrame(part.rest, obj.matrix);
        obj.matrixWorldNeedsUpdate = true;
      }
    }
    for (const [node, bone] of s.solver.bones) {
      const obj = s.built.boneObjects.get(node);
      if (obj) {
        matrixFromCFrame(bone.rest, obj.matrix);
        obj.matrixWorldNeedsUpdate = true;
      }
    }
    setPlay(false);
  }, [mode, setPlay]);

  useEffect(() => {
    live.current.time = 0;
    setTime(0);
  }, [clipIndex]);

  const compatibility = useMemo(() => {
    if (!clip || !rig) return null;
    try {
      const solver = rig.source === "file" ? buildRigSolver(manifest, rig.rigIndex) : buildRigSolver(rig.manifest, rig.rigIndex);
      const binding = solver.bind(clip);
      const boneTracks = solver.targets.filter((t) => t.kind === "bone" && binding.byTarget.has(t.node)).length;
      return { ...binding, boneTracks, rigBones: solver.bones.size };
    } catch {
      return null;
    }
  }, [clip, rig, manifest]);

  // Skeleton overlay (bones drawn as lines), for rigs with Bones.
  useEffect(() => {
    const s = three.current;
    if (!s?.built || !showBones || mode !== "animation" || !s.built.boneObjects.size) return;
    const helper = new THREE.SkeletonHelper(s.built.root);
    const material = helper.material as THREE.LineBasicMaterial;
    material.depthTest = false;
    material.transparent = true;
    helper.renderOrder = 50;
    s.scene.add(helper);
    return () => {
      helper.removeFromParent();
      helper.dispose();
    };
  }, [showBones, mode, displayManifest, resourcesKey, rig]);

  // Keyboard (only while the viewer has focus; never leaks to page shortcuts).
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (keyBelongsToControl(e)) return;
    const key = e.key.toLowerCase();
    let handled = true;
    if (key === "f") frameSelection();
    else if (key === "home") frameAll();
    else if (key === " " && mode === "animation" && clip) setPlay(!playing);
    else if (key === " " && mode === "effects") setEffectsPlaying((p) => !p);
    else if (key === "arrowleft" && mode === "animation" && clip) seek(live.current.time * 1000 - 1000 / 30);
    else if (key === "arrowright" && mode === "animation" && clip) seek(live.current.time * 1000 + 1000 / 30);
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    } else if (/^[a-z]$/.test(key)) {
      // Keep single-letter page shortcuts (e.g. approve) from firing while exploring the model.
      e.stopPropagation();
    }
  };

  const toggleFullscreen = () => {
    const el = container.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.().catch(() => {});
  };

  const renderable = useMemo(() => {
    const set = new Set<number>();
    displayManifest.nodes.forEach((n, i) => {
      if (n.r.size || ["ParticleEmitter", "Beam", "Trail", "Fire", "Smoke", "Sparkles"].includes(n.c)) set.add(i);
    });
    return set;
  }, [displayManifest]);

  const missingCount = manifest.resources.filter((r) => r.affectsPreview && (r.kind === "mesh" || r.kind === "texture") && !resources.some((x) => x.contentId === r.contentId && x.kind === r.kind)).length;
  const approximated = manifest.support.filter((s) => s.level === "approximate" || s.level === "unsupported").length;
  void resourceVersion;

  if (webglError && !manifest.capabilities.ui) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-white/80">
        <CircleAlert className="size-7 text-state-review" />
        <p className="max-w-md text-[13px]">{webglError}</p>
        {props.downloadUrl ? (
          <a href={props.downloadUrl} className="mt-1 inline-flex items-center gap-1.5 rounded-md bg-white/10 px-3 py-1.5 text-[12.5px] hover:bg-white/15">
            <Download className="size-4" /> Download original
          </a>
        ) : null}
      </div>
    );
  }

  return (
    // While fullscreen, menus and tooltips must render inside the fullscreen element to be seen.
    <PortalContainer.Provider value={fullscreen ? container.current : null}>
      <div ref={container} tabIndex={-1} onKeyDown={onKeyDown} className="relative flex h-full w-full overflow-hidden bg-[#15161c] text-white outline-none">
        <div className="relative min-w-0 flex-1">
          <div ref={canvasHost} className="absolute inset-0" />
          {mode === "ui" ? <UiStage manifest={manifest} resources={resources} selected={selected} onSelect={setSelected} onNotes={setUiNotes} /> : null}

          {/* Mode tabs */}
          <div className="absolute left-2 top-2 z-10 flex items-center gap-1 rounded-lg bg-black/55 p-1 backdrop-blur" role="tablist" aria-label="Preview mode">
            {modes.map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                onClick={() => setMode(m)}
                className={cn("inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium [&_svg]:size-3.5", mode === m ? "bg-white/15 text-white" : "text-white/70 hover:text-white")}
              >
                {m === "model" ? <Box /> : m === "animation" ? <PersonStanding /> : m === "ui" ? <LayoutTemplate /> : <Sparkles />}
                {m === "model" ? "Model" : m === "animation" ? "Animation" : m === "ui" ? "UI" : "Effects"}
              </button>
            ))}
          </div>

          {/* Status chips */}
          <div className="absolute left-2 top-12 z-10 flex max-w-[70%] flex-wrap gap-1">
            {missingCount ? (
              <button type="button" onClick={() => setPanel("resources")} className="inline-flex h-6 items-center gap-1 rounded-md bg-state-review/85 px-2 text-[11px] font-semibold text-black">
                <CircleAlert className="size-3.5" /> {missingCount} missing resource{missingCount === 1 ? "" : "s"}
              </button>
            ) : null}
            {props.resourceActions.autoFetching ? (
              <span className="inline-flex h-6 items-center gap-1 rounded-md bg-black/60 px-2 text-[11px] font-medium text-white/85 backdrop-blur">
                <Loader2 className="size-3.5 animate-spin" /> Fetching {props.resourceActions.autoFetching} from Roblox…
              </span>
            ) : null}
            {approximated || runtimeNotes.length || (mode === "ui" && uiNotes.length) ? (
              <button type="button" onClick={() => setPanel("fidelity")} className="inline-flex h-6 items-center gap-1 rounded-md bg-black/60 px-2 text-[11px] font-medium text-white/85 backdrop-blur hover:bg-black/75">
                Preview fidelity · {approximated} approximated/not shown
              </button>
            ) : null}
          </div>

          {/* Camera & scene toolbar */}
          <TipAnchor tip="roblox.preview" facts={{}}>
          <div className="absolute right-2 top-2 z-10 flex items-center gap-0.5 rounded-lg bg-black/55 p-1 backdrop-blur">
            {mode !== "ui" ? (
              <>
                <IconButton label={selected !== null ? "Frame selection" : "Frame model"} shortcut="F" onClick={frameSelection}>
                  <Scan />
                </IconButton>
                <IconButton label="Reset camera" shortcut="Home" onClick={frameAll}>
                  <Home />
                </IconButton>
                <IconButton label={grid ? "Hide grid" : "Show grid"} active={grid} onClick={() => setGrid((g) => !g)}>
                  <Grid3x3 />
                </IconButton>
                <Select
                  variant="media"
                  aria-label="Background"
                  value={background}
                  onValueChange={setBackground}
                  className="mx-0.5"
                  options={[
                    { value: "dark", label: "Dark" },
                    { value: "light", label: "Light" },
                    { value: "black", label: "Black" },
                    { value: "checker", label: "Checker" },
                    { value: "sky", label: "Sky" },
                  ]}
                />
                <span className="hidden items-center gap-1 sm:flex">
                  <Sun className="ml-1 size-3.5 text-white/60" aria-hidden />
                  <Select
                    variant="media"
                    aria-label="Lighting"
                    value={lighting}
                    onValueChange={setLighting}
                    options={[
                      { value: "studio", label: "Studio light" },
                      { value: "day", label: "Daylight" },
                      { value: "night", label: "Night" },
                      { value: "flat", label: "Flat" },
                    ]}
                  />
                </span>
              </>
            ) : null}
            <IconButton label={panel ? "Hide panel" : "Explorer & details"} active={Boolean(panel)} onClick={() => setPanel((p) => (p ? null : "explorer"))}>
              <PanelRight />
            </IconButton>
            <IconButton label={fullscreen ? "Exit fullscreen" : "Fullscreen"} onClick={toggleFullscreen}>
              {fullscreen ? <Shrink /> : <Expand />}
            </IconButton>
            {props.downloadUrl ? (
              <Tooltip content={`Download original: ${props.filename}`}>
                <a href={props.downloadUrl} aria-label="Download original" className="flex size-8 items-center justify-center rounded-md text-white/80 hover:bg-white/10 hover:text-white">
                  <Download className="size-4" />
                </a>
              </Tooltip>
            ) : null}
          </div>
          </TipAnchor>

          {/* Bottom bars */}
          {mode === "animation" ? (
            <div className="absolute inset-x-2 bottom-2 z-10 rounded-lg bg-black/70 p-2 backdrop-blur">
              {!clip ? (
                <p className="text-[12px] text-white/75">This file has no playable keyframe animation.</p>
              ) : !rig ? (
                <div className="grid gap-1.5 text-[12px]">
                  <p className="flex items-center gap-1.5 font-semibold text-state-review">
                    <CircleAlert className="size-4" /> This animation needs a rig to play on.
                  </p>
                  <p className="text-white/70">
                    It contains poses for {clip.tracks.size} joint{clip.tracks.size === 1 ? "" : "s"} ({[...clip.tracks.values()].slice(0, 6).map((t) => t.name).join(", ")}
                    {clip.tracks.size > 6 ? "…" : ""}) but no character. Choose the rig it was made for:
                  </p>
                  {props.rigPicker}
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2 text-[12px]">
                    <button type="button" onClick={() => setPlay(!playing)} aria-label={playing ? "Pause" : "Play"} className="flex size-8 items-center justify-center rounded-full bg-white text-black hover:bg-white/90">
                      {playing ? <Pause className="size-4 fill-current" /> : <Play className="ml-0.5 size-4 fill-current" />}
                    </button>
                    <IconButton label="Restart" onClick={() => { seek(0); setPlay(true); }}>
                      <RotateCcw />
                    </IconButton>
                    <IconButton label="Previous frame" shortcut="←" onClick={() => { setPlay(false); seek(live.current.time * 1000 - 1000 / 30); }}>
                      <ChevronLeft />
                    </IconButton>
                    <IconButton label="Next frame" shortcut="→" onClick={() => { setPlay(false); seek(live.current.time * 1000 + 1000 / 30); }}>
                      <ChevronRight />
                    </IconButton>
                    <span className="font-mono tabular-nums">
                      {formatTimecode(time * 1000)} <span className="text-white/50">/ {formatTimecode(clip.length * 1000)}</span>
                    </span>
                    <IconButton label={loop ? "Looping" : "Play once"} active={loop} onClick={() => setLoop((l) => !l)}>
                      <Repeat />
                    </IconButton>
                    <Select variant="media" aria-label="Playback speed" value={String(speed)} onValueChange={(v) => setSpeed(Number(v))} options={SPEED_OPTIONS} />
                    {clips.length > 1 ? (
                      <Select
                        variant="media"
                        aria-label="Animation"
                        title={clip.name}
                        value={String(clipIndex)}
                        onValueChange={(v) => setClipIndex(Number(v))}
                        className="max-w-48"
                        options={clipLabels.map((label, i) => ({ value: String(i), label }))}
                      />
                    ) : (
                      <span className="truncate text-white/70">{clip.name}</span>
                    )}
                    {compatibility?.rigBones ? (
                      <IconButton label={showBones ? "Hide bones" : "Show bones"} active={showBones} onClick={() => setShowBones((v) => !v)}>
                        <Bone />
                      </IconButton>
                    ) : null}
                    <span className="flex-1" />
                    <span className="truncate text-[11.5px] text-white/60" title={rig.label}>
                      Rig: {rig.label}
                    </span>
                    {props.rigPicker}
                  </div>
                  <div className="relative mt-2 h-7">
                    <input
                      type="range"
                      min={0}
                      max={Math.max(0.001, clip.length)}
                      step={0.001}
                      value={time}
                      aria-label="Animation position"
                      onChange={(e) => {
                        setPlay(false);
                        seek(Number(e.target.value) * 1000);
                      }}
                      className="absolute inset-x-0 top-1 w-full accent-[var(--accent)]"
                    />
                    {clip.keyTimes.map((t) => (
                      <span key={`k-${t}`} className="pointer-events-none absolute top-0 h-1.5 w-px bg-white/50" style={{ left: `${(t / (clip.length || 1)) * 100}%` }} />
                    ))}
                    {clip.markers.map((m) => (
                      <Tooltip key={`m-${m.time}-${m.name}`} content={`${m.name} · ${formatTimecode(m.time * 1000)}`}>
                        <button type="button" onClick={() => seek(m.time * 1000)} className="absolute -top-1 size-2.5 -translate-x-1/2 rotate-45 bg-sky-400" style={{ left: `${(m.time / (clip.length || 1)) * 100}%` }} aria-label={`Marker ${m.name}`} />
                      </Tooltip>
                    ))}
                    {props.markers.map((m) => (
                      <Tooltip key={m.id} content={`${formatTimecode(m.timestampMs)} · ${m.author}: ${m.text}`}>
                        <button
                          type="button"
                          onClick={() => {
                            seek(m.timestampMs);
                            props.onMarkerClick(m.id);
                          }}
                          aria-label={`Feedback at ${formatTimecode(m.timestampMs)}`}
                          className={cn("absolute bottom-0 size-3 -translate-x-1/2 rounded-full border-2 border-black", m.resolved ? "bg-state-approved" : "bg-state-changes", props.activeMarkerId === m.id && "ring-2 ring-accent")}
                          style={{ left: `${Math.min(100, (m.timestampMs / 1000 / (clip.length || 1)) * 100)}%` }}
                        />
                      </Tooltip>
                    ))}
                  </div>
                  {compatibility && compatibility.keyed > 0 && compatibility.matched === 0 ? (
                    <p className="mt-1 text-[11.5px] text-state-review">
                      None of the {compatibility.keyed} animated joints exist on this rig, so nothing moves. Choose the rig this animation was made for.
                    </p>
                  ) : compatibility && compatibility.missing.length ? (
                    <p className="mt-1 text-[11.5px] text-state-review">
                      {compatibility.matched} of {compatibility.keyed} animated joints exist on this rig — missing: {compatibility.missing.slice(0, 6).join(", ")}
                      {compatibility.missing.length > 6 ? "…" : ""}. Those joints stay still.
                    </p>
                  ) : null}
                  {compatibility?.boneTracks && skinInfo && skinInfo.meshes === 0 ? (
                    <p className="mt-1 text-[11.5px] text-state-review">
                      This animation moves {compatibility.boneTracks} bone{compatibility.boneTracks === 1 ? "" : "s"}, but no skinned mesh that uses them is loaded
                      {skinInfo.missingMeshes ? ` (${skinInfo.missingMeshes} mesh${skinInfo.missingMeshes === 1 ? " is" : "es are"} missing — see Resources)` : ""}, so nothing deforms yet. Use “Show bones” to watch the skeleton.
                    </p>
                  ) : null}
                </>
              )}
            </div>
          ) : mode === "effects" ? (
            <div className="absolute inset-x-2 bottom-2 z-10 flex flex-wrap items-center gap-2 rounded-lg bg-black/70 p-2 text-[12px] backdrop-blur">
              <button type="button" onClick={() => setEffectsPlaying((p) => !p)} aria-label={effectsPlaying ? "Pause effects" : "Play effects"} className="flex size-8 items-center justify-center rounded-full bg-white text-black hover:bg-white/90">
                {effectsPlaying ? <Pause className="size-4 fill-current" /> : <Play className="ml-0.5 size-4 fill-current" />}
              </button>
              <button
                type="button"
                onClick={() => {
                  three.current?.effects?.reset();
                  three.current?.effects?.burst();
                  live.current.burstTimer = three.current?.effects?.burstPeriod ?? 2;
                  setEffectsPlaying(true);
                }}
                className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-white/85 hover:bg-white/10"
              >
                <RotateCcw className="size-4" /> Replay
              </button>
              <button type="button" onClick={() => three.current?.effects?.burst()} className="inline-flex h-8 items-center gap-1 rounded-md bg-accent px-2.5 font-medium text-accent-fg hover:bg-accent-hover">
                <Sparkles className="size-4" /> Emit
              </button>
              <label className="inline-flex items-center gap-1 text-white/80">
                <input type="checkbox" checked={loopBursts} onChange={(e) => setLoopBursts(e.target.checked)} /> Loop bursts
              </label>
              <Select variant="media" aria-label="Effect speed" value={String(effectSpeed)} onValueChange={(v) => setEffectSpeed(Number(v))} options={SPEED_OPTIONS} />
              <span className="inline-flex items-center gap-1 text-white/80">
                <span aria-hidden>Motion</span>
                <Select
                  variant="media"
                  aria-label="Motion"
                  value={motion}
                  onValueChange={setMotion}
                  options={[
                    { value: "none", label: "None" },
                    { value: "orbit", label: "Orbit" },
                    { value: "swing", label: "Swing" },
                    { value: "spin", label: "Spin" },
                  ]}
                />
              </span>
              <span className="flex-1" />
              <button type="button" onClick={() => setPanel("effects")} className="text-[11.5px] text-white/70 hover:text-white">
                {effectInfo.length} effect{effectInfo.length === 1 ? "" : "s"} · {effectInfo.reduce((n, e) => n + e.live, 0)} particles
              </button>
            </div>
          ) : null}
        </div>

        {panel ? (
          <aside className="absolute inset-y-0 right-0 z-20 flex w-[min(300px,85%)] flex-col border-l border-white/10 bg-[#1b1c23]/95 text-fg backdrop-blur md:static md:w-72" aria-label="Preview details">
            <div className="scrollbar-none flex shrink-0 gap-0.5 overflow-x-auto border-b border-white/10 p-1" role="tablist">
              {(["explorer", "properties", "resources", "fidelity", ...(manifest.capabilities.effects ? (["effects"] as const) : [])] as Panel[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  role="tab"
                  aria-selected={panel === p}
                  onClick={() => setPanel(p)}
                  className={cn("h-7 shrink-0 rounded-md px-2 text-[11.5px] font-medium capitalize", panel === p ? "bg-white/15 text-white" : "text-white/65 hover:text-white")}
                >
                  {p}
                  {p === "resources" && missingCount ? <span className="ml-1 rounded bg-state-review px-1 text-[10px] text-black">{missingCount}</span> : null}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 text-white/90">
              {panel === "explorer" ? (
                <ExplorerPanel
                  manifest={displayManifest}
                  selected={selected}
                  onSelect={(n) => {
                    setSelected(n);
                  }}
                  hidden={hidden}
                  renderable={renderable}
                  onToggleHidden={(n) =>
                    setHidden((h) => {
                      const next = new Set(h);
                      if (next.has(n)) next.delete(n);
                      else next.add(n);
                      return next;
                    })
                  }
                />
              ) : panel === "properties" ? (
                <PropertiesPanel manifest={displayManifest} node={selected} />
              ) : panel === "resources" ? (
                <ResourcesPanel manifest={manifest} resolved={resources} status={three.current?.store?.status ?? new Map()} actions={props.resourceActions} onSelectNode={(n) => { setSelected(n); }} />
              ) : panel === "fidelity" ? (
                <FidelityPanel manifest={manifest} runtimeNotes={[...runtimeNotes, ...(manifest.capabilities.ui ? uiNotes : [])]} />
              ) : (
                <EffectsPanel
                  manifest={manifest}
                  info={effectInfo}
                  onToggle={(n, enabled) => {
                    three.current?.effects?.setEnabled(n, enabled);
                    setEffectInfo(three.current?.effects?.info() ?? []);
                  }}
                  onEmit={(n, count) => three.current?.effects?.emit(n, count)}
                  onSelect={(n) => setSelected(n)}
                />
              )}
            </div>
          </aside>
        ) : null}
      </div>
    </PortalContainer.Provider>
  );
}
