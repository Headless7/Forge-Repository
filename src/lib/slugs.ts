/** Top-level URL segments that can't be used as studio slugs. */
export const RESERVED_STUDIO_SLUGS = new Set([
  "api", "sign-in", "sign-up", "sign-out", "forgot-password", "reset-password", "verify-email", "invite",
  "onboarding", "account", "dev", "_next", "static", "public", "favicon.ico", "robots.txt", "settings",
  "admin", "new", "login", "logout", "auth", "help", "about", "notifications", "studios",
]);

/** Second-level segments under a studio that can't be used as project slugs. */
export const RESERVED_PROJECT_SLUGS = new Set([
  "members", "settings", "activity", "notifications", "projects", "new", "search", "audit", "invite",
]);

export function slugify(value: string, maxLength = 40): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
}

/** "Universal Tower Defense" → "UTD"; single words use their first letters. */
export function projectKeyFrom(name: string): string {
  const words = name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  let key = words.length > 1 ? words.map((w) => w[0]).join("") : (words[0] ?? "PRJ").slice(0, 3);
  key = key.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (key.length < 2) key = (key + "PRJ").slice(0, 3);
  return key.slice(0, 5);
}
