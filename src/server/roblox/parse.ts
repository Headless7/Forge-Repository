import { isBinaryRoblox, parseBinaryRoblox } from "./binary";
import { RobloxParseError, type RbxDocument } from "./model";
import { isXmlRoblox, parseXmlRoblox } from "./xml";

export function detectRobloxFormat(head: Uint8Array): "binary" | "xml" | null {
  if (isBinaryRoblox(head)) return "binary";
  if (isXmlRoblox(head)) return "xml";
  return null;
}

/** Parses a .rbxm/.rbxmx/.rbxl/.rbxlx file. Throws RobloxParseError for anything that isn't one. */
export function parseRobloxFile(bytes: Uint8Array): RbxDocument {
  const format = detectRobloxFormat(bytes);
  if (format === "binary") return parseBinaryRoblox(bytes);
  if (format === "xml") return parseXmlRoblox(bytes);
  throw new RobloxParseError("This isn't a Roblox model file (.rbxm / .rbxmx).");
}
