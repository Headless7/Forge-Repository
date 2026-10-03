/**
 * Deliverable canvas geometry shared by the canvas and the server: node sizes and the connection
 * points arrows attach to. Point ids are stable — side plus position along it in percent, e.g.
 * "t-25" is a quarter of the way along the top edge — so a saved arrow keeps meaning the same spot
 * however the node moves or grows. Longer edges offer more points; when a node shrinks and a used
 * point disappears, the arrow moves to the nearest remaining point on the same side.
 */
export const NODE_DEFAULT = { w: 236, h: 112 } as const;
export const NODE_MIN = { w: 180, h: 88 } as const;
export const NODE_MAX = { w: 720, h: 560 } as const;

export const SIDES = ["t", "r", "b", "l"] as const;
export type Side = (typeof SIDES)[number];

/** Points by edge length: the middle always; quarters from 200 px; eighths from 400 px. */
const TIERS: Array<{ minLength: number; points: number[] }> = [
  { minLength: 0, points: [50] },
  { minLength: 200, points: [25, 75] },
  { minLength: 400, points: [12, 37, 62, 87] },
];

/** Default ends for arrows saved before points existed: out of the right side, into the left. */
export const DEFAULT_FROM_POINT = "r-50";
export const DEFAULT_TO_POINT = "l-50";

export function clampSize(w: number, h: number): { w: number; h: number } {
  const round = (n: number) => Math.round(n);
  return { w: round(Math.min(NODE_MAX.w, Math.max(NODE_MIN.w, w))), h: round(Math.min(NODE_MAX.h, Math.max(NODE_MIN.h, h))) };
}

/** Percent positions available along an edge of this length, in order. */
export function pointsAlong(length: number): number[] {
  return TIERS.filter((t) => length >= t.minLength)
    .flatMap((t) => t.points)
    .sort((a, b) => a - b);
}

export function edgeLength(side: Side, size: { w: number; h: number }) {
  return side === "t" || side === "b" ? size.w : size.h;
}

export function availablePoints(size: { w: number; h: number }): string[] {
  return SIDES.flatMap((side) => pointsAlong(edgeLength(side, size)).map((pct) => `${side}-${pct}`));
}

export function parsePoint(id: string | null | undefined): { side: Side; pct: number } | null {
  const m = /^([trbl])-(\d{1,2})$/.exec(id ?? "");
  if (!m) return null;
  const pct = Number(m[2]);
  return TIERS.some((t) => t.points.includes(pct)) ? { side: m[1] as Side, pct } : null;
}

/** Fraction along the edge (12 → 0.125: eighths are named by their whole percent). */
export function pointFraction(pct: number): number {
  return [12, 37, 62, 87].includes(pct) ? (pct + 0.5) / 100 : pct / 100;
}

export function isValidPoint(id: string | null | undefined): boolean {
  return parsePoint(id) !== null;
}

/**
 * The point an arrow end actually uses on a node of this size: the saved point if the node still
 * has it, otherwise the nearest point on the same side (never another side, never removed).
 */
export function remapPoint(id: string | null | undefined, size: { w: number; h: number }, fallback: string): string {
  const p = parsePoint(id) ?? parsePoint(fallback)!;
  const options = pointsAlong(edgeLength(p.side, size));
  if (options.includes(p.pct)) return `${p.side}-${p.pct}`;
  const nearest = options.reduce((best, x) => (Math.abs(pointFraction(x) - pointFraction(p.pct)) < Math.abs(pointFraction(best) - pointFraction(p.pct)) ? x : best), options[0]!);
  return `${p.side}-${nearest}`;
}

const SIDE_NAMES: Record<Side, string> = { t: "Top", r: "Right", b: "Bottom", l: "Left" };

/** "Top, left quarter" — for screen readers and the connection-point menus. */
export function pointLabel(id: string): string {
  const p = parsePoint(id);
  if (!p) return id;
  const horizontal = p.side === "t" || p.side === "b";
  const where = p.pct === 50 ? "middle" : p.pct < 50 ? (horizontal ? "towards the left" : "towards the top") : horizontal ? "towards the right" : "towards the bottom";
  return `${SIDE_NAMES[p.side]}, ${where}${p.pct !== 50 ? ` (${Math.round(pointFraction(p.pct) * 100)}%)` : ""}`;
}

/** The node size used for geometry: its saved size, or the default. */
export function nodeSize(d: { canvasW: number | null; canvasH: number | null }): { w: number; h: number } {
  return { w: d.canvasW ?? NODE_DEFAULT.w, h: d.canvasH ?? NODE_DEFAULT.h };
}
