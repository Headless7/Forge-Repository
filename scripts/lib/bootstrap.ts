import crypto from "node:crypto";
import fs from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { requireEnv } from "./env";
import { ensureLocalDatabase, type LocalDatabaseHandle } from "./local-db";

export const log = (message: string) => console.log(`\x1b[35m[forge]\x1b[0m ${message}`);

/** Creates .env from .env.example with fresh random secrets. Returns true when created. */
export function ensureEnvFile(): boolean {
  if (fs.existsSync(".env")) return false;
  const template = fs.readFileSync(".env.example", "utf8");
  const secret = () => crypto.randomBytes(32).toString("base64url");
  const content = template
    .replace(/^AUTH_SECRET=.*$/m, `AUTH_SECRET=${secret()}`)
    .replace(/^CRON_SECRET=.*$/m, `CRON_SECRET=${secret()}`);
  fs.writeFileSync(".env", content);
  return true;
}

export function testDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${url.pathname.replace(/^\//, "")}_test`;
  return url.toString();
}

export async function runMigrations(databaseUrl: string) {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(sql), { migrationsFolder: "drizzle" });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function isDatabaseSeeded(databaseUrl: string): Promise<boolean> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    const rows = await sql`select count(*)::int as count from users`;
    return (rows[0]?.count ?? 0) > 0;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Starts the embedded server when enabled, creates databases and applies migrations. */
export async function prepareDatabase(): Promise<LocalDatabaseHandle | null> {
  const databaseUrl = requireEnv("DATABASE_URL");
  let handle: LocalDatabaseHandle | null = null;
  if (process.env.EMBEDDED_POSTGRES === "true") {
    const testDb = new URL(testDatabaseUrl(databaseUrl)).pathname.slice(1);
    handle = await ensureLocalDatabase({ databaseUrl, extraDatabases: [testDb], log });
  }
  log("Applying database migrations …");
  await runMigrations(databaseUrl);
  return handle;
}
