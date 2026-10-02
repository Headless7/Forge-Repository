import fs from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { ensureLocalDatabase, type LocalDatabaseHandle } from "../../scripts/lib/local-db";

/**
 * Prepares a clean test database: starts the embedded server if needed, then
 * drops and re-migrates the <name>_test database before the suite runs.
 */
export default async function setup() {
  if (fs.existsSync(".env")) process.loadEnvFile(".env");
  const base = process.env.DATABASE_URL ?? "postgres://forge:forge@127.0.0.1:54329/forge";
  const testUrl = new URL(base);
  testUrl.pathname = `/${new URL(base).pathname.replace(/^\//, "")}_test`;

  let handle: LocalDatabaseHandle | null = null;
  if (process.env.EMBEDDED_POSTGRES !== "false") {
    handle = await ensureLocalDatabase({ databaseUrl: base, extraDatabases: [testUrl.pathname.slice(1)], log: () => {} });
  }

  const sql = postgres(testUrl.toString(), { max: 1, onnotice: () => {} });
  await sql.unsafe("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;");
  await migrate(drizzle(sql), { migrationsFolder: path.resolve("drizzle") });
  await sql.end();
  fs.rmSync(path.resolve(".data/test-storage"), { recursive: true, force: true });

  return async () => {
    await handle?.stop();
  };
}
