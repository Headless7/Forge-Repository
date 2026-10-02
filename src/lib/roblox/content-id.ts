/**
 * Roblox content ids come in several spellings for the same asset. Normalising them
 * lets one resolved resource satisfy every reference to it.
 *   rbxassetid://123 · http(s)://www.roblox.com/asset/?id=123 · roblox.com/asset?id=123&… → rbxassetid://123
 *   rbxasset://textures/x.png (built into the Roblox client) → kept as is
 */
export function normalizeContentId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value) return null;
  const direct = /^rbxassetid:\/\/(\d+)/i.exec(value);
  if (direct) return `rbxassetid://${direct[1]}`;
  const web = /^(?:https?:\/\/)?(?:www\.)?roblox\.com\/asset\/?\?(?:.*&)?id=(\d+)/i.exec(value);
  if (web) return `rbxassetid://${web[1]}`;
  const delivery = /assetdelivery\.roblox\.com\/v1\/asset\/?\?(?:.*&)?id=(\d+)/i.exec(value);
  if (delivery) return `rbxassetid://${delivery[1]}`;
  if (/^\d+$/.test(value)) return `rbxassetid://${value}`;
  if (/^rbxasset:\/\//i.test(value)) return value.replace(/\\/g, "/");
  if (/^rbxthumb:\/\//i.test(value)) return value;
  return value;
}

export function assetIdOf(contentId: string): string | null {
  return /^rbxassetid:\/\/(\d+)$/.exec(contentId)?.[1] ?? null;
}

export function isBuiltinContent(contentId: string): boolean {
  return /^rbxasset:\/\//i.test(contentId);
}
