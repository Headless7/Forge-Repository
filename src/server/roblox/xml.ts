import {
  finalizeDocument,
  PARSE_LIMITS,
  RobloxParseError,
  type CFrame12,
  type RbxDocument,
  type RbxInstance,
  type RbxValue,
  type Vec3,
} from "./model";

/**
 * Reader for the Roblox XML model format (version 4), following
 * https://github.com/rojo-rbx/rbx-dom/blob/master/docs/xml.md
 *
 * Uses a deliberately small XML tokenizer: no DTDs, no external or custom entities
 * (so no XXE or entity-expansion attacks), only the five predefined entities and
 * numeric character references.
 */

interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}

const ENTITY: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return ENTITY[body] ?? whole;
  });
}

function parseXml(source: string): XmlElement {
  const root: XmlElement = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlElement[] = [root];
  let i = 0;
  const n = source.length;
  const fail = (msg: string) => {
    throw new RobloxParseError(`Invalid XML: ${msg}`);
  };

  while (i < n) {
    const lt = source.indexOf("<", i);
    if (lt === -1) {
      stack[stack.length - 1]!.text += decodeEntities(source.slice(i));
      break;
    }
    if (lt > i) stack[stack.length - 1]!.text += decodeEntities(source.slice(i, lt));
    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4);
      if (end === -1) fail("unterminated comment");
      i = end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", lt)) {
      const end = source.indexOf("]]>", lt + 9);
      if (end === -1) fail("unterminated CDATA");
      stack[stack.length - 1]!.text += source.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (source.startsWith("<?", lt)) {
      const end = source.indexOf("?>", lt + 2);
      if (end === -1) fail("unterminated processing instruction");
      i = end + 2;
      continue;
    }
    if (source.startsWith("<!", lt)) fail("document type declarations are not allowed");
    const gt = source.indexOf(">", lt + 1);
    if (gt === -1) fail("unterminated tag");
    const inner = source.slice(lt + 1, gt);
    i = gt + 1;

    if (inner[0] === "/") {
      const name = inner.slice(1).trim();
      const top = stack.pop();
      if (!top || top.name !== name || stack.length === 0) fail(`unexpected </${name}>`);
      continue;
    }
    const selfClosing = inner.endsWith("/");
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const nameMatch = /^\s*([^\s/>]+)/.exec(body);
    if (!nameMatch) fail("missing tag name");
    const el: XmlElement = { name: nameMatch![1]!, attrs: {}, children: [], text: "" };
    const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    const attrSource = body.slice(nameMatch![0].length);
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(attrSource))) el.attrs[m[1]!] = decodeEntities(m[3] ?? m[4] ?? "");
    stack[stack.length - 1]!.children.push(el);
    if (!selfClosing) {
      stack.push(el);
      if (stack.length > PARSE_LIMITS.maxXmlDepth) fail("nesting is too deep");
    }
  }
  if (stack.length !== 1) fail("unclosed elements");
  return root;
}

const child = (el: XmlElement, name: string) => el.children.find((c) => c.name === name);
const childText = (el: XmlElement, name: string) => child(el, name)?.text.trim() ?? "";

function num(text: string): number {
  const t = text.trim();
  if (t === "INF" || t === "inf" || t === "Infinity") return Infinity;
  if (t === "-INF" || t === "-inf" || t === "-Infinity") return -Infinity;
  if (/^-?nan/i.test(t)) return NaN;
  return Number(t);
}

function nums(text: string): number[] {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(num);
}

function base64(text: string): Uint8Array {
  const cleaned = text.replace(/\s+/g, "");
  if (!cleaned) return new Uint8Array();
  return new Uint8Array(Buffer.from(cleaned, "base64"));
}

function cframe(el: XmlElement): CFrame12 {
  const keys = ["X", "Y", "Z", "R00", "R01", "R02", "R10", "R11", "R12", "R20", "R21", "R22"];
  return keys.map((k) => num(childText(el, k) || (k[0] === "R" ? (k[1] === k[2] ? "1" : "0") : "0"))) as CFrame12;
}

function vec3(el: XmlElement): Vec3 {
  return [num(childText(el, "X") || "0"), num(childText(el, "Y") || "0"), num(childText(el, "Z") || "0")];
}

function contentValue(el: XmlElement): string | null {
  const c = el.children[0];
  if (!c) {
    const text = el.text.trim();
    return text || null;
  }
  if (c.name === "url" || c.name === "uri") return c.text.trim() || null;
  return null;
}

function decodeProperty(el: XmlElement, sharedByKey: Map<string, Uint8Array>, pendingShared: Array<() => void>): RbxValue {
  const text = el.text;
  switch (el.name) {
    case "string":
    case "ProtectedString":
      return { type: "String", value: text };
    case "BinaryString":
      return { type: "BinaryString", value: base64(text) };
    case "bool":
      return { type: "Bool", value: text.trim() === "true" };
    case "int":
      return { type: "Int32", value: num(text) };
    case "int64":
      return { type: "Int64", value: num(text) };
    case "float":
      return { type: "Float32", value: num(text) };
    case "double":
      return { type: "Float64", value: num(text) };
    case "token":
      return { type: "Enum", value: num(text) };
    case "BrickColor":
      return { type: "BrickColor", value: num(text) };
    case "Vector3":
      return { type: "Vector3", value: vec3(el) };
    case "Vector2":
      return { type: "Vector2", value: [num(childText(el, "X") || "0"), num(childText(el, "Y") || "0")] };
    case "Vector3int16":
      return { type: "Vector3int16", value: vec3(el) };
    case "Vector2int16":
      return { type: "Vector2int16", value: [num(childText(el, "X") || "0"), num(childText(el, "Y") || "0")] };
    case "CoordinateFrame":
      return { type: "CFrame", value: cframe(el) };
    case "OptionalCoordinateFrame": {
      const inner = child(el, "CFrame");
      return { type: "OptionalCFrame", value: inner ? cframe(inner) : null };
    }
    case "Color3": {
      if (!el.children.length && text.trim()) {
        const packed = num(text) >>> 0;
        return { type: "Color3", value: [((packed >> 16) & 255) / 255, ((packed >> 8) & 255) / 255, (packed & 255) / 255] };
      }
      return { type: "Color3", value: [num(childText(el, "R") || "0"), num(childText(el, "G") || "0"), num(childText(el, "B") || "0")] };
    }
    case "Color3uint8": {
      const packed = num(text) >>> 0;
      return { type: "Color3uint8", value: [(packed >> 16) & 255, (packed >> 8) & 255, packed & 255] };
    }
    case "UDim":
      return { type: "UDim", value: [num(childText(el, "S") || "0"), num(childText(el, "O") || "0")] };
    case "UDim2":
      return {
        type: "UDim2",
        value: [num(childText(el, "XS") || "0"), num(childText(el, "XO") || "0"), num(childText(el, "YS") || "0"), num(childText(el, "YO") || "0")],
      };
    case "Rect2D": {
      const min = child(el, "min");
      const max = child(el, "max");
      return {
        type: "Rect",
        value: [
          num(min ? childText(min, "X") || "0" : "0"),
          num(min ? childText(min, "Y") || "0" : "0"),
          num(max ? childText(max, "X") || "0" : "0"),
          num(max ? childText(max, "Y") || "0" : "0"),
        ],
      };
    }
    case "Ray": {
      const origin = child(el, "origin");
      const direction = child(el, "direction");
      return { type: "Ray", value: [...(origin ? vec3(origin) : [0, 0, 0]), ...(direction ? vec3(direction) : [0, 0, 0])] as never };
    }
    case "NumberRange": {
      const v = nums(text);
      return { type: "NumberRange", value: [v[0] ?? 0, v[1] ?? v[0] ?? 0] };
    }
    case "NumberSequence": {
      const v = nums(text);
      const kps: Array<[number, number, number]> = [];
      for (let k = 0; k + 2 < v.length; k += 3) kps.push([v[k]!, v[k + 1]!, v[k + 2]!]);
      return { type: "NumberSequence", value: kps };
    }
    case "ColorSequence": {
      const v = nums(text);
      const kps: Array<[number, number, number, number, number]> = [];
      for (let k = 0; k + 4 < v.length; k += 5) kps.push([v[k]!, v[k + 1]!, v[k + 2]!, v[k + 3]!, v[k + 4]!]);
      return { type: "ColorSequence", value: kps };
    }
    case "PhysicalProperties": {
      if (childText(el, "CustomPhysics") !== "true") return { type: "PhysicalProperties", value: null };
      const fields = ["Density", "Friction", "Elasticity", "FrictionWeight", "ElasticityWeight", "AcousticAbsorption"];
      return { type: "PhysicalProperties", value: fields.map((f) => num(childText(el, f) || (f === "AcousticAbsorption" ? "1" : "0"))) };
    }
    case "Ref": {
      const t = text.trim();
      return { type: "Ref", value: t && t !== "null" ? t : null };
    }
    case "Content":
    case "ContentId":
      return { type: "Content", value: contentValue(el) };
    case "Font": {
      const family = child(el, "Family");
      const cached = child(el, "CachedFaceId");
      return {
        type: "Font",
        value: {
          family: family ? (contentValue(family) ?? "") : "",
          weight: num(childText(el, "Weight") || "400"),
          style: childText(el, "Style") || "Normal",
          cachedFaceId: cached ? (contentValue(cached) ?? "") : "",
        },
      };
    }
    case "Faces":
      return { type: "Faces", value: num(childText(el, "faces") || text || "0") };
    case "Axes":
      return { type: "Axes", value: num(childText(el, "axes") || text || "0") };
    case "UniqueId":
      return { type: "UniqueId", value: text.trim().toLowerCase() };
    case "SecurityCapabilities":
      return { type: "SecurityCapabilities", value: text.trim() };
    case "SharedString":
    case "NetAssetRef": {
      const key = text.trim();
      const value: RbxValue = { type: "SharedString", value: new Uint8Array() };
      // Definitions live at the end of the file; resolve once everything is read.
      pendingShared.push(() => {
        value.value = sharedByKey.get(key) ?? new Uint8Array();
      });
      return value;
    }
    default:
      return { type: "Unknown", value: el.name };
  }
}

export function isXmlRoblox(head: Uint8Array): boolean {
  const text = new TextDecoder().decode(head.subarray(0, Math.min(head.length, 512))).replace(/^﻿/, "").trimStart();
  return /^(<\?xml[^>]*>\s*)?<roblox[\s>]/.test(text) && !text.startsWith("<roblox!");
}

export function parseXmlRoblox(bytes: Uint8Array): RbxDocument {
  const source = new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
  const doc = parseXml(source);
  const robloxEl = doc.children.find((c) => c.name === "roblox");
  if (!robloxEl) throw new RobloxParseError("Not a Roblox XML file.");

  const warnings: string[] = [];
  const meta: Record<string, string> = {};
  const sharedByKey = new Map<string, Uint8Array>();
  const pendingShared: Array<() => void> = [];
  const ordered: RbxInstance[] = [];
  const refCounts = new Map<string, number>();

  for (const c of robloxEl.children) {
    if (c.name === "Meta" && c.attrs.name) meta[c.attrs.name] = c.text;
    if (c.name === "SharedStrings") {
      for (const s of c.children) if (s.name === "SharedString" && s.attrs.md5) sharedByKey.set(s.attrs.md5, base64(s.text));
    }
  }

  const visit = (el: XmlElement, parent: RbxInstance | null) => {
    if (ordered.length >= PARSE_LIMITS.maxInstances) throw new RobloxParseError("This file has more instances than the preview supports.");
    let ref = el.attrs.referent || `anon-${ordered.length}`;
    const seen = refCounts.get(ref) ?? 0;
    refCounts.set(ref, seen + 1);
    if (seen) {
      warnings.push(`Duplicate referent ${ref}.`);
      ref = `${ref}#${seen}`;
    }
    const inst: RbxInstance = { ref, className: el.attrs.class || "Instance", name: "", parent, children: [], props: new Map() };
    ordered.push(inst);
    if (parent) parent.children.push(inst);
    for (const c of el.children) {
      if (c.name === "Properties") {
        for (const p of c.children) {
          const name = p.attrs.name;
          if (!name) continue;
          inst.props.set(name, decodeProperty(p, sharedByKey, pendingShared));
        }
      } else if (c.name === "Item") {
        visit(c, inst);
      }
    }
  };
  for (const c of robloxEl.children) if (c.name === "Item") visit(c, null);
  for (const resolve of pendingShared) resolve();
  return finalizeDocument("xml", ordered, meta, warnings);
}
