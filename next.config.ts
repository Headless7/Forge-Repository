import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";
// Browsers remember HSTS: only send it when the app is really served over HTTPS (and not in development).
const httpsOnly = !isDev && (process.env.APP_URL ?? "").startsWith("https://");

// API responses (JSON, files, feeds) never run scripts or load anything: opened directly, they can
// only show an image or play media. Pages get a per-request policy with a nonce (src/proxy.ts).
const apiContentSecurityPolicy = [
  "default-src 'none'",
  "img-src 'self'",
  "media-src 'self'",
  "style-src 'unsafe-inline'",
  "base-uri 'none'",
  "form-action 'none'",
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
          // No other site's window keeps a handle on a Forge tab (sign-in flows are full-page redirects).
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
