/**
 * Roblox RichText markup → a small tree the preview renders as React elements. Never turned
 * into HTML strings, so text from an uploaded file can't inject anything.
 * Supported: <b> <i> <u> <s> <font color size face family weight transparency>
 * <stroke color thickness transparency> <mark color transparency> <uppercase>/<uc>
 * <smallcaps>/<sc> <br/>, comments and the &lt; &gt; &quot; &apos; &amp; escapes.
 */

export interface RichStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** 0–1 RGB. */
  color?: [number, number, number];
  size?: number;
  /** FontFace family key (e.g. "Michroma") from face="…" or family="rbxasset://fonts/families/X.json". */
  face?: string;
  weight?: number;
  transparency?: number;
  stroke?: { color: [number, number, number]; thickness: number; transparency: number };
  mark?: { color: [number, number, number]; transparency: number };
  uppercase?: boolean;
  smallcaps?: boolean;
}

export type RichNode = { type: "text"; text: string } | { type: "br" } | { type: "span"; style: RichStyle; children: RichNode[] };

const TAGS = new Set(["b", "i", "u", "s", "font", "stroke", "mark", "uppercase", "uc", "smallcaps", "sc", "br"]);
const WEIGHTS: Record<string, number> = { thin: 100, extralight: 200, light: 300, regular: 400, medium: 500, semibold: 600, bold: 700, extrabold: 800, heavy: 900 };

function unescape(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

export function parseColor(value: string): [number, number, number] | undefined {
  const v = value.trim();
  const hex = /^#?([0-9a-f]{6})$/i.exec(v)?.[1];
  if (hex) return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(v);
  if (rgb) return [rgb[1], rgb[2], rgb[3]].map((n) => Math.min(255, Number(n)) / 255) as [number, number, number];
  return undefined;
}

function attrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(/([a-z]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) out[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? "";
  return out;
}

function styleFor(tag: string, a: Record<string, string>): RichStyle {
  switch (tag) {
    case "b":
      return { bold: true };
    case "i":
      return { italic: true };
    case "u":
      return { underline: true };
    case "s":
      return { strike: true };
    case "uppercase":
    case "uc":
      return { uppercase: true };
    case "smallcaps":
    case "sc":
      return { smallcaps: true };
    case "font": {
      const s: RichStyle = {};
      if (a.color) s.color = parseColor(a.color);
      if (a.size && Number.isFinite(Number(a.size))) s.size = Number(a.size);
      if (a.face) s.face = a.face.replace(/\s+/g, "");
      if (a.family) s.face = /\/([^/]+)\.json$/i.exec(a.family)?.[1] ?? s.face;
      if (a.weight) s.weight = WEIGHTS[a.weight.toLowerCase()] ?? (Number.isFinite(Number(a.weight)) ? Number(a.weight) : undefined);
      if (a.transparency && Number.isFinite(Number(a.transparency))) s.transparency = Number(a.transparency);
      return s;
    }
    case "stroke":
      return {
        stroke: {
          color: parseColor(a.color ?? "") ?? [0, 0, 0],
          thickness: Number.isFinite(Number(a.thickness)) ? Number(a.thickness) : 1,
          transparency: Number.isFinite(Number(a.transparency)) ? Number(a.transparency) : 0,
        },
      };
    case "mark":
      return { mark: { color: parseColor(a.color ?? "") ?? [1, 1, 0], transparency: Number.isFinite(Number(a.transparency)) ? Number(a.transparency) : 0 } };
    default:
      return {};
  }
}

/** Parses RichText. Unknown or unbalanced tags are kept as literal text, like Roblox shows them. */
export function parseRichText(input: string): RichNode[] {
  const source = input.replace(/<!--[\s\S]*?-->/g, "");
  const root: RichNode[] = [];
  const stack: Array<{ tag: string; node: Extract<RichNode, { type: "span" }> }> = [];
  const target = () => (stack.length ? stack[stack.length - 1]!.node.children : root);
  const pushText = (text: string) => {
    if (!text) return;
    const list = target();
    const last = list[list.length - 1];
    if (last?.type === "text") last.text += text;
    else list.push({ type: "text", text });
  };
  const re = /<(\/?)([a-z]+)((?:\s+[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/gi;
  let at = 0;
  for (const m of source.matchAll(re)) {
    const [whole, closing, rawTag, rawAttrs, selfClosing] = m;
    const tag = rawTag!.toLowerCase();
    pushText(unescape(source.slice(at, m.index)));
    at = m.index! + whole.length;
    if (!TAGS.has(tag)) {
      pushText(whole);
      continue;
    }
    if (tag === "br") {
      target().push({ type: "br" });
      continue;
    }
    if (closing) {
      const open = stack.findLastIndex((s) => s.tag === tag || (s.tag === "uc" && tag === "uppercase") || (s.tag === "sc" && tag === "smallcaps"));
      if (open === -1) pushText(whole);
      else stack.length = open;
      continue;
    }
    if (selfClosing) continue;
    const node: Extract<RichNode, { type: "span" }> = { type: "span", style: styleFor(tag, attrs(rawAttrs ?? "")), children: [] };
    target().push(node);
    stack.push({ tag, node });
  }
  pushText(unescape(source.slice(at)));
  return root;
}
