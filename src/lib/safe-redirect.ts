/**
 * Where to send someone after signing in (or a similar hop) from a `next` parameter. Only paths on
 * this site come back: anything a browser could read as another site ("//evil.com", "/\evil.com",
 * "https://…", "/.//evil.com" once normalised, control characters) falls back to `fallback`.
 * Shared by the server (redirects) and the client (router navigation).
 */
export function safeRedirectPath(value: unknown, fallback = "/"): string {
  if (typeof value !== "string" || value.length > 2048) return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value)) return fallback;
  const base = "https://forge.invalid";
  try {
    const url = new URL(value, base);
    if (url.origin !== base || url.pathname.startsWith("//")) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}
