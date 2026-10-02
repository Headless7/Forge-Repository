import type { SupportLevel } from "./manifest";

/**
 * What the in-app viewer does with each Roblox class. This table is the single source
 * of truth for the fidelity report shown next to every preview, so the viewer never
 * implies more than it renders.
 */

export interface ClassSupport {
  level: SupportLevel;
  note: string;
}

const S = (level: SupportLevel, note: string): ClassSupport => ({ level, note });

const PARTS = S("full", "Geometry, size, colour, transparency and position.");
const CONTAINER = S("data", "Container.");
const DATA = S("data", "Data only — nothing to draw.");
const PHYSICS = S("unsupported", "Physics isn't simulated; parts stay where they were saved.");
const GUI = S("unsupported", "UI isn't rendered in the 3D preview.");
const POST = S("unsupported", "Scene post-processing isn't reproduced.");
const SCRIPT = S("unsupported", "Never executed. Anything a script would do at runtime isn't shown.");
const CLOTHING = S("unsupported", "Avatar clothing and appearance aren't applied.");
const AUDIO = S("unsupported", "Sounds aren't played in the 3D preview.");

const TABLE: Record<string, ClassSupport> = {
  Part: PARTS,
  WedgePart: PARTS,
  CornerWedgePart: PARTS,
  SpawnLocation: PARTS,
  Seat: PARTS,
  VehicleSeat: PARTS,
  SkateboardPlatform: PARTS,
  FlagStand: PARTS,
  Platform: PARTS,
  TrussPart: S("approximate", "Drawn as a lattice box; the truss style isn't reproduced."),
  MeshPart: S("approximate", "Real geometry once its mesh is provided (see Resources); until then a labelled box of the part's size. Skinned meshes deform with their Bones."),
  UnionOperation: S("approximate", "Solid-modelling results use Roblox-only mesh data; drawn as a box of the part's size."),
  NegateOperation: S("approximate", "Negative parts are drawn as translucent boxes."),
  IntersectOperation: S("approximate", "Drawn as a box of the part's size."),
  PartOperation: S("approximate", "Drawn as a box of the part's size."),
  SpecialMesh: S("full", "Brick, sphere, cylinder, wedge and head shapes with scale and offset."),
  "SpecialMesh (FileMesh)": S("approximate", "Real geometry once the mesh is provided; otherwise a labelled box."),
  FileMesh: S("approximate", "Real geometry once the mesh is provided; otherwise a labelled box."),
  BlockMesh: S("full", "Scale and offset."),
  CylinderMesh: S("full", "Scale and offset."),
  Decal: S("approximate", "Projected onto the part's surface (box, head or mesh) on its face once the image is provided; ZIndex orders decals on the same face."),
  Texture: S("approximate", "Tiled across the part's surface on its face once the image is provided."),
  SurfaceAppearance: S("approximate", "Colour map, with cut-out alpha for AlphaMode Transparency (hair, fur); normal, metalness and roughness maps aren't applied, and Overlay alpha isn't blended with the part colour."),
  Attachment: S("full", "Positions joints and effects."),
  Bone: S("full", "Deforms skinned meshes and is animated by poses (matched by name and hierarchy). “Show bones” draws the skeleton."),
  Motor6D: S("full", "Joint used to pose the rig."),
  Motor: S("full", "Joint used to pose the rig."),
  Weld: DATA,
  ManualWeld: DATA,
  Snap: DATA,
  Glue: DATA,
  WeldConstraint: DATA,
  NoCollisionConstraint: DATA,
  Humanoid: S("approximate", "Used to identify the rig; humanoid physics and scaling aren't applied."),
  HumanoidDescription: CLOTHING,
  KeyframeSequence: S("full", "Played on a rig with linear, constant, cubic, elastic and bounce easing."),
  Keyframe: S("full", "Part of a keyframe animation."),
  Pose: S("full", "Part of a keyframe animation."),
  KeyframeMarker: S("full", "Shown on the animation timeline."),
  NumberPose: S("unsupported", "Facial animation (FACS) poses aren't played."),
  CurveAnimation: S("unsupported", "Curve animations are detected but not played yet."),
  FloatCurve: S("unsupported", "Part of a curve animation (not played)."),
  Vector3Curve: S("unsupported", "Part of a curve animation (not played)."),
  EulerRotationCurve: S("unsupported", "Part of a curve animation (not played)."),
  RotationCurve: S("unsupported", "Part of a curve animation (not played)."),
  MarkerCurve: S("unsupported", "Part of a curve animation (not played)."),
  Animation: S("data", "Refers to an animation asset that isn't inside this file."),
  AnimationController: DATA,
  Animator: DATA,
  ParticleEmitter: S(
    "approximate",
    "Simulated in the browser from its properties (rate, lifetime, speed, spread, size/colour/transparency curves, rotation, drag, acceleration, flipbooks, light emission). Engine-exact timing, lighting and collisions may differ.",
  ),
  Beam: S("approximate", "Curved, textured and scrolling between its attachments; lighting may differ."),
  Trail: S("approximate", "Drawn from attachment motion — use Motion to move the effect so trails appear."),
  PointLight: S("approximate", "Real-time light; Roblox's lighting engine looks different."),
  SpotLight: S("approximate", "Real-time light; Roblox's lighting engine looks different."),
  SurfaceLight: S("approximate", "Approximated as a spotlight from its face."),
  Fire: S("approximate", "Legacy effect drawn with a stand-in particle recipe."),
  Smoke: S("approximate", "Legacy effect drawn with a stand-in particle recipe."),
  Sparkles: S("approximate", "Legacy effect drawn with a stand-in particle recipe."),
  Explosion: S("unsupported", "Explosions are runtime objects and aren't simulated."),
  Highlight: S("approximate", "Fill and outline drawn by the viewer."),
  SelectionBox: S("unsupported", "Adornments aren't drawn."),
  Script: SCRIPT,
  LocalScript: SCRIPT,
  ModuleScript: SCRIPT,
  CoreScript: SCRIPT,
  Sound: AUDIO,
  SoundGroup: AUDIO,
  Shirt: CLOTHING,
  Pants: CLOTHING,
  ShirtGraphic: CLOTHING,
  BodyColors: CLOTHING,
  CharacterMesh: CLOTHING,
  Accessory: CONTAINER,
  Accoutrement: CONTAINER,
  Hat: CONTAINER,
  Tool: CONTAINER,
  Model: CONTAINER,
  WorldModel: CONTAINER,
  Folder: CONTAINER,
  Configuration: CONTAINER,
  Actor: CONTAINER,
  Workspace: CONTAINER,
  Camera: DATA,
  Lighting: POST,
  Sky: POST,
  Atmosphere: POST,
  Clouds: POST,
  BloomEffect: POST,
  BlurEffect: POST,
  ColorCorrectionEffect: POST,
  DepthOfFieldEffect: POST,
  SunRaysEffect: POST,
  Terrain: S("unsupported", "Terrain isn't rendered."),
  TerrainRegion: S("unsupported", "Terrain isn't rendered."),
  ProximityPrompt: GUI,
  // 2D UI — drawn in the UI tab.
  ScreenGui: S("full", "Drawn in the UI tab at the chosen screen size, below Roblox's top bar unless IgnoreGuiInset is on."),
  GuiMain: S("full", "Legacy ScreenGui; drawn in the UI tab."),
  SurfaceGui: S("approximate", "Drawn flat in the UI tab at its canvas size; not placed onto its part in the 3D view."),
  BillboardGui: S("approximate", "Drawn flat in the UI tab; not attached above its part in the 3D view."),
  Frame: S("full", "Size, position, anchor, rotation, colour, transparency, border and clipping."),
  TextLabel: S("approximate", "Text is set by the browser in the same font (or a close substitute for Roblox-only fonts); wrapping and TextScaled sizes can differ slightly."),
  TextButton: S("approximate", "Drawn like a TextLabel, with the hover/press darkening of AutoButtonColor."),
  TextBox: S("approximate", "Shows its text (or placeholder); not editable in the preview."),
  ImageLabel: S("full", "Stretch, Fit, Crop, Tile and 9-slice, sprite-sheet rects, tint and transparency — once the image is provided (see Resources)."),
  ImageButton: S("full", "Drawn like an ImageLabel, with AutoButtonColor hover/press."),
  ScrollingFrame: S("approximate", "Scrollable in the preview with its canvas size; scroll bar styling is approximated."),
  CanvasGroup: S("approximate", "Group colour and transparency applied to everything inside."),
  ViewportFrame: S("unsupported", "3D inside a UI isn't rendered; shown as a labelled placeholder."),
  VideoFrame: S("unsupported", "Video isn't played; shown as a labelled placeholder."),
  UICorner: S("full", "Rounded corners."),
  UIStroke: S("approximate", "Borders and text outlines; line-join styles are approximated."),
  UIGradient: S("approximate", "Colour and transparency gradients on backgrounds and text; on images the tint is approximated."),
  UIPadding: S("full", "Padding inside the parent."),
  UIListLayout: S("approximate", "Direction, alignment, padding, sort order and wrapping; Flex settings are ignored."),
  UIGridLayout: S("full", "Cell size, padding, direction, start corner and alignment."),
  UIPageLayout: S("approximate", "Shows the first page; paging animations aren't played."),
  UITableLayout: S("unsupported", "Table layout isn't reproduced; children are stacked as a list."),
  UIAspectRatioConstraint: S("full", "Keeps the aspect ratio (also for grid cells)."),
  UISizeConstraint: S("full", "Minimum and maximum size."),
  UITextSizeConstraint: S("full", "Minimum and maximum text size for TextScaled."),
  UIScale: S("full", "Scales the object and everything inside it."),
  UIFlexItem: S("unsupported", "Flex sizing is ignored."),
  ClickDetector: DATA,
  RemoteEvent: DATA,
  RemoteFunction: DATA,
  BindableEvent: DATA,
  BindableFunction: DATA,
  ObjectValue: DATA,
};

const SERVICE_CONTAINERS = new Set([
  "Instance",
  "Players",
  "ReplicatedFirst",
  "ReplicatedStorage",
  "ServerStorage",
  "StarterGui",
  "StarterPack",
  "StarterPlayer",
  "StarterPlayerScripts",
  "StarterCharacterScripts",
  "StarterGear",
  "Teams",
  "Team",
  "Chat",
  "Debris",
  "Selection",
  "StudioData",
  "Backpack",
  "LocalizationTable",
  "Packages",
  "PackageLink",
  "StandalonePluginScripts",
]);

const GUI_CLASSES = /^(ScreenGui|SurfaceGui|BillboardGui|Frame|ScrollingFrame|TextLabel|TextButton|TextBox|ImageLabel|ImageButton|ViewportFrame|VideoFrame|CanvasGroup|UI[A-Z]\w*|GuiMain)$/;

export function classSupport(className: string): ClassSupport {
  const hit = TABLE[className];
  if (hit) return hit;
  if (GUI_CLASSES.test(className)) return GUI;
  if (/Value$/.test(className)) return DATA;
  if (/Service$/.test(className) || SERVICE_CONTAINERS.has(className) || /^ReflectionMetadata/.test(className)) return CONTAINER;
  if (/Constraint$|^Body[A-Z]|^Align|^LinearVelocity$|^AngularVelocity$|^VectorForce$|^Torque$|^LineForce$/.test(className)) return PHYSICS;
  if (/SoundEffect$/.test(className)) return AUDIO;
  if (/Adornment$|^Handles$|^ArcHandles$|^Selection/.test(className)) return S("unsupported", "Studio adornments aren't drawn.");
  return S("unsupported", "Not shown in the preview.");
}

export const SUPPORT_LABELS: Record<SupportLevel, string> = {
  full: "Rendered",
  approximate: "Approximated",
  unsupported: "Not shown",
  data: "No visual",
};
