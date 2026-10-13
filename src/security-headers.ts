/**
 * Content Security Policy for pages, built per request by src/proxy.ts. In production scripts
 * need the request's nonce ('strict-dynamic' lets Next's own chunks load what they need), so
 * an injected <script> can't run. Development keeps 'unsafe-inline'/'unsafe-eval' for HMR and
 * React's debugging. Styles stay 'unsafe-inline': the UI uses inline style attributes.
 */
import { DISCORD_MEDIA_ORIGINS } from "@/lib/discord-links";

export function pageContentSecurityPolicy(options: { nonce: string | null; dev: boolean; storageOrigin: string }) {
  const { nonce, dev, storageOrigin } = options;
  const scripts = nonce && !dev ? `'self' 'nonce-${nonce}' 'strict-dynamic'` : `'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`;
  return [
    "default-src 'self'",
    `script-src ${scripts}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${storageOrigin}`.trim(),
    // Videos linked from Discord play inline (see src/lib/discord-links.ts); nothing else loads from there.
    `media-src 'self' blob: ${storageOrigin} ${DISCORD_MEDIA_ORIGINS.join(" ")}`.replace(/\s+/g, " ").trim(),
    `connect-src 'self' ${storageOrigin}${dev ? " ws: wss:" : ""}`.trim(),
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
