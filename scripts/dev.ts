/**
 * One command for local development:
 *   npm run dev        → ensures .env, starts PostgreSQL, migrates, seeds (first run), runs `next dev`
 *   npm start          → same, but builds if needed and runs `next start`
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import { ensureEnvFile, isDatabaseSeeded, log, prepareDatabase } from "./lib/bootstrap";
import { loadEnv, requireEnv } from "./lib/env";

const prod = process.argv.includes("--prod");
if (ensureEnvFile()) log("Created .env with fresh secrets.");
loadEnv(!prod);

const handle = await prepareDatabase();
if (!(await isDatabaseSeeded(requireEnv("DATABASE_URL")))) {
  if (prod) {
    // Never create the demo accounts (with their published password) on a production server.
    log("Empty database — open /sign-up to create the first account (the demo studio is only loaded by `npm run dev`).");
  } else {
    log("Empty database — loading demo studio.");
    const { seed } = await import("./seed/index");
    await seed({});
    const { closeDb } = await import("../src/server/db");
    await closeDb();
  }
}

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");
const port = process.env.PORT ?? "3000";

if (prod && !fs.existsSync(".next/BUILD_ID")) {
  log("No production build found — running `next build` …");
  const build = spawnSync(process.execPath, [nextBin, "build"], { stdio: "inherit", env: { ...process.env, NODE_ENV: "production" } });
  if (build.status !== 0) {
    await handle?.stop();
    process.exit(build.status ?? 1);
  }
}

log(`Starting Next.js (${prod ? "production" : "development"}) on http://localhost:${port}`);
if (!prod && !process.env.SMTP_URL) {
  // Emails are kept in a local outbox; this link (only in this terminal) opens it without signing in.
  process.env.DEV_OUTBOX_KEY ??= crypto.randomBytes(18).toString("base64url");
  log(`Dev outbox (password resets, invites): http://localhost:${port}/dev/outbox?key=${process.env.DEV_OUTBOX_KEY}`);
}
const child = spawn(process.execPath, [nextBin, prod ? "start" : "dev", "--port", port], {
  stdio: "inherit",
  env: { ...process.env, ...(prod ? { NODE_ENV: "production" } : {}) },
});

let stopping = false;
async function shutdown(code: number) {
  if (stopping) return;
  stopping = true;
  if (!child.killed) child.kill();
  await handle?.stop().catch(() => {});
  process.exit(code);
}
process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
child.on("exit", (code) => void shutdown(code ?? 0));
