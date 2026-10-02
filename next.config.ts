import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";
// Browsers remember HSTS: only send it when the app is really served over HTTPS (and not in development).
const httpsOnly = !isDev && (process.env.APP_URL ?? "").startsWith("https://");

// Extra origins that may serve private media (S3/R2 presigned URLs). Local storage is same-origin.
const storageOrigin = process.env.STORAGE_PUBLIC_ORIGIN ?? "";

// API responses (JSON, files) never run scripts; pages get a per-request policy with a nonce (src/proxy.ts).
const apiContentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${storageOrigin}`.trim(),
  `media-src 'self' blob: ${storageOrigin}`.trim(),
  `connect-src 'self' ${storageOrigin}${isDev ? " ws: wss:" : ""}`.trim(),
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  // An isolated verification instance (scripts/verify-server.ts) builds into its own folder so it
  // can run next to `npm run dev` (Next allows one dev server per output folder).
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  // Dev only: extra hosts allowed to load dev assets (the verification instance uses 127.0.0.1).
  ...(process.env.DEV_ALLOWED_ORIGINS ? { allowedDevOrigins: process.env.DEV_ALLOWED_ORIGINS.split(",") } : {}),
  poweredByHeader: false,
  reactStrictMode: true,
  devIndicators: false,
  // Native / binary-resolving packages must stay outside the server bundle.
  serverExternalPackages: ["ffmpeg-static", "sharp", "postgres", "nodemailer", "embedded-postgres", "draco3d"],
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [{ key: "Content-Security-Policy", value: apiContentSecurityPolicy }],
      },
      {
        source: "/:path*",
        headers: [
          ...(httpsOnly ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }] : []),
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
