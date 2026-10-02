import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined));

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  APP_URL: z.url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  AUTH_SECRET: z.string().min(16, "AUTH_SECRET must be at least 16 characters"),

  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().default(".data/storage"),
  S3_BUCKET: optional,
  S3_REGION: z.string().default("auto"),
  S3_ENDPOINT: optional,
  S3_ACCESS_KEY_ID: optional,
  S3_SECRET_ACCESS_KEY: optional,
  S3_FORCE_PATH_STYLE: bool,

  MAX_IMAGE_UPLOAD_MB: z.coerce.number().positive().default(50),
  MAX_VIDEO_UPLOAD_MB: z.coerce.number().positive().default(2048),
  MAX_FILE_UPLOAD_MB: z.coerce.number().positive().default(500),
  MAX_AUDIO_UPLOAD_MB: z.coerce.number().positive().default(200),
  MAX_ROBLOX_UPLOAD_MB: z.coerce.number().positive().default(150),
  /** Optional Open Cloud key (scope legacy-asset:manage) so the server can fetch meshes/textures a model references. */
  ROBLOX_OPEN_CLOUD_API_KEY: optional,
  /** Download public meshes/textures from Roblox's public asset endpoint (no key needed). On by default. */
  ROBLOX_PUBLIC_ASSET_FETCH: z
    .enum(["true", "false", "1", "0", ""])
    .optional()
    .transform((v) => v === undefined || v === "" || v === "true" || v === "1"),

  EMAIL_FROM: z.string().default("Forge <no-reply@forge.local>"),
  SMTP_URL: optional,
  /** Sends through Resend's HTTPS API (preferred over SMTP_URL when both are set). */
  RESEND_API_KEY: optional,
  REQUIRE_EMAIL_VERIFICATION: bool,

  DISCORD_CLIENT_ID: optional,
  DISCORD_CLIENT_SECRET: optional,
  GOOGLE_CLIENT_ID: optional,
  GOOGLE_CLIENT_SECRET: optional,

  REALTIME_DRIVER: z.enum(["postgres", "memory"]).default("postgres"),
  CRON_SECRET: optional,
  ENABLE_INPROCESS_JOBS: z
    .enum(["true", "false", "1", "0", ""])
    .optional()
    .transform((v) => v === undefined || v === "" || v === "true" || v === "1"),
  DEMO_MODE: bool,
  FFMPEG_PATH: optional,
  /**
   * Reverse proxies in front of the app that append X-Forwarded-For (e.g. 1 for one nginx/Caddy/
   * load balancer). 0 = reached directly: forwarded headers are ignored, since anyone could send
   * them. Defaults to 1 in development (the dev server is local) and 0 in production.
   */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(10).optional(),
  /** Development only: opens /dev/outbox without signing in (generated and printed by `npm run dev`). */
  DEV_OUTBOX_KEY: optional,
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

/** Settings that make a production server unsafe to run at all. */
function productionErrors(e: Env): string[] {
  if (e.NODE_ENV !== "production") return [];
  const errors: string[] = [];
  if (e.AUTH_SECRET.length < 32 || /replace-me|change-me|example/i.test(e.AUTH_SECRET)) errors.push("AUTH_SECRET must be a random string of at least 32 characters (it signs file links and OAuth state).");
  if (e.CRON_SECRET && (e.CRON_SECRET.length < 24 || /replace-me/i.test(e.CRON_SECRET))) errors.push("CRON_SECRET must be a random string of at least 24 characters, or unset.");
  if (e.STORAGE_DRIVER === "s3" && !(e.S3_BUCKET && e.S3_ACCESS_KEY_ID && e.S3_SECRET_ACCESS_KEY)) errors.push("STORAGE_DRIVER=s3 needs S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.");
  return errors;
}

/** Settings a production server can run with, but probably shouldn't (logged at startup). */
export function productionWarnings(): string[] {
  if (env.NODE_ENV !== "production") return [];
  const warnings: string[] = [];
  if (!env.APP_URL.startsWith("https://")) warnings.push("APP_URL isn't https:// — session cookies aren't marked Secure and HSTS is off. Serve the app over HTTPS.");
  if (env.TRUSTED_PROXY_HOPS === undefined) warnings.push("TRUSTED_PROXY_HOPS is unset, so client IPs are unknown and per-IP rate limits fall back to shared budgets. Set it to the number of reverse proxies in front of the app (usually 1).");
  if (env.DEMO_MODE) warnings.push("DEMO_MODE is ignored in production (demo sign-in hints stay hidden).");
  if (env.REALTIME_DRIVER === "memory") warnings.push("REALTIME_DRIVER=memory only reaches users on this one process; use postgres when running more than one instance.");
  if (env.STORAGE_DRIVER === "local") warnings.push("STORAGE_DRIVER=local keeps files on this machine's disk: back up STORAGE_LOCAL_DIR and don't run several instances against it.");
  return warnings;
}

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  • ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}\nRun \`npm run setup\` to create a .env file.`);
  }
  const errors = productionErrors(parsed.data);
  if (errors.length) throw new Error(`Unsafe production configuration:\n${errors.map((e) => `  • ${e}`).join("\n")}`);
  return parsed.data;
}

/** Validated environment, parsed lazily so scripts can load .env first. */
export const env: Env = new Proxy({} as Env, {
  get(_target, prop: string) {
    cached ??= load();
    return cached[prop as keyof Env];
  },
});

export const isProduction = () => env.NODE_ENV === "production";

/** How many proxies in front of the app may be believed about the client (see TRUSTED_PROXY_HOPS). */
export const trustedProxyHops = () => env.TRUSTED_PROXY_HOPS ?? (isProduction() ? 0 : 1);

export function appOrigin(): string {
  return new URL(env.APP_URL).origin;
}
