/** Curated column icons (lucide names) and accent colours users can pick from. */
export const COLUMN_ICONS = [
  "sparkles",
  "person-standing",
  "box",
  "layout-panel-top",
  "code",
  "map",
  "scale",
  "megaphone",
  "music",
  "bug",
  "image",
  "clapperboard",
  "palette",
  "swords",
  "shield",
  "trophy",
  "gem",
  "flame",
  "zap",
  "users",
  "wrench",
  "flask-conical",
  "gamepad-2",
  "rocket",
] as const;

export type ColumnIconName = (typeof COLUMN_ICONS)[number];

export const ACCENT_COLORS = [
  "#a78bfa",
  "#818cf8",
  "#60a5fa",
  "#22d3ee",
  "#34d399",
  "#a3e635",
  "#facc15",
  "#fb923c",
  "#f87171",
  "#f472b6",
  "#94a3b8",
] as const;

export const LABEL_COLORS = ACCENT_COLORS;

export const PROJECT_BACKGROUNDS = [
  { id: "default", label: "Graphite" },
  { id: "midnight", label: "Midnight" },
  { id: "violet", label: "Violet haze" },
  { id: "forest", label: "Forest" },
  { id: "ember", label: "Ember" },
  { id: "ocean", label: "Deep ocean" },
] as const;

export const ROBLOX_TEMPLATE: Array<{ name: string; icon: ColumnIconName; color: string; mode: "VISUAL" | "COMPACT" }> = [
  { name: "VFX", icon: "sparkles", color: "#a78bfa", mode: "VISUAL" },
  { name: "Animations", icon: "person-standing", color: "#60a5fa", mode: "VISUAL" },
  { name: "Models", icon: "box", color: "#22d3ee", mode: "VISUAL" },
  { name: "UI", icon: "layout-panel-top", color: "#f472b6", mode: "VISUAL" },
  { name: "Scripting", icon: "code", color: "#34d399", mode: "COMPACT" },
  { name: "Maps", icon: "map", color: "#a3e635", mode: "VISUAL" },
  { name: "Balancing", icon: "scale", color: "#facc15", mode: "COMPACT" },
  { name: "Marketing", icon: "megaphone", color: "#fb923c", mode: "VISUAL" },
];
