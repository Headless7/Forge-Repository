/**
 * An isolated Forge instance for automated and visual verification. It has its own database
 * (`<name>_verify` on the same PostgreSQL server), its own storage folder (.data/verify) and
 * its own Next output folder (.next-verify), and listens on http://127.0.0.1:3100 — so
 * `verify:flows` and test uploads never touch your working data, and it can run next to
 * `npm run dev`. (127.0.0.1 rather than localhost keeps its sign-in cookie apart from :3000.)
 *
 *   npm run verify:server
 *   VERIFY_URL=http://127.0.0.1:3100 npm run verify:flows
 *
 * The verification database is seeded with the demo studio on first start. To start over,
 * stop it and delete .data/verify (the database is recreated empty only if you drop it).
 *
 * VERIFY_STORAGE=r2 runs the same thing against a real Cloudflare R2 bucket instead of local
 * files (database `<name>_staging`, bucket R2_STAGING_BUCKET or `forge-media-staging`, keys
 * R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY from .env) — the production storage
 * path, end to end, before going live.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { log, isDatabaseSeeded, runMigrations } from "./lib/bootstrap";
import { loadEnv, requireEnv } from "./lib/env";
import { ensureLocalDatabase } from "./lib/local-db";

loadEnv(true);
const useR2 = process.env.VERIFY_STORAGE === "r2";
const base = new URL(requireEnv("DATABASE_URL"));
const verifyName = `${base.pathname.replace(/^\//, "")}_${useR2 ? "staging" : "verify"}`;
const verify = new URL(base);
verify.pathname = `/${verifyName}`;
if (verify.toString() === base.toString()) throw new Error("Refusing to run verification against the working database.");

const port = process.env.VERIFY_PORT ?? "3100";
const origin = `http://127.0.0.1:${port}`;
const handle = await ensureLocalDatabase({ databaseUrl: base.toString(), extraDatabases: [verifyName], log });

// Everything below — migrations, seed, the server — sees only the verification copy.
const storageEnv: Record<string, string> = useR2
  ? (() => {
      const endpoint = `https://${requireEnv("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`;
      return {
        STORAGE_DRIVER: "s3",
        S3_BUCKET: process.env.R2_STAGING_BUCKET ?? "forge-media-staging",
        S3_REGION: "auto",
        S3_ENDPOINT: endpoint,
        S3_FORCE_PATH_STYLE: "true",
        S3_ACCESS_KEY_ID: requireEnv("R2_ACCESS_KEY_ID"),
        S3_SECRET_ACCESS_KEY: requireEnv("R2_SECRET_ACCESS_KEY"),
        STORAGE_PUBLIC_ORIGIN: endpoint,
      };
    })()
  : { STORAGE_DRIVER: "local", STORAGE_LOCAL_DIR: path.resolve(".data/verify/storage") };
if (storageEnv.STORAGE_DRIVER === "s3" && storageEnv.S3_BUCKET === "forge-media") throw new Error("Refusing to test against the production bucket.");
Object.assign(process.env, {
  DATABASE_URL: verify.toString(),
  ...storageEnv,
  APP_URL: origin,
  NEXT_DIST_DIR: ".next-verify",
  DEV_ALLOWED_ORIGINS: "127.0.0.1",
});
log(`Verification database: ${verifyName}; storage: ${useR2 ? `R2 bucket ${storageEnv.S3_BUCKET}` : ".data/verify/storage"}`);
await runMigrations(verify.toString());
if (!(await isDatabaseSeeded(verify.toString()))) {
  log("Empty verification database — loading the demo studio.");
  const { seed } = await import("./seed/index");
  await seed({});
  const { closeDb } = await import("../src/server/db");
  await closeDb();
}

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");
log(`Starting the verification server on ${origin}`);
const child = spawn(process.execPath, [nextBin, "dev", "--port", port], { stdio: "inherit", env: process.env });
const stop = async (code: number) => {
  if (!child.killed) child.kill();
  await handle.stop().catch(() => {});
  process.exit(code);
};
process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));
child.on("exit", (code) => void stop(code ?? 0));
