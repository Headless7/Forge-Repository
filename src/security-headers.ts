/**
 * Content Security Policy for pages, built per request by src/proxy.ts. In production scripts
 * need the request's nonce ('strict-dynamic' lets Next's own chunks load what they need), so
 * an injected <script> can't run. Development keeps 'unsafe-inline'/'unsafe-eval' for HMR and
 * React's debugging. Styles stay 'unsafe-inline': the UI uses inline style attributes.
 */
export function pageContentSecurityPolicy(options: { nonce: string | null; dev: boolean; storageOrigin: string }) {
  const { nonce, dev, storageOrigin } = options;
  const scripts = nonce && !dev ? `'self' 'nonce-${nonce}' 'strict-dynamic'` : `'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`;
  return [
    "default-src 'self'",
    `script-src ${scripts}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${storageOrigin}`.trim(),
    `media-src 'self' blob: ${storageOrigin}`.trim(),
    `connect-src 'self' ${storageOrigin}${dev ? " ws: wss:" : ""}`.trim(),
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
