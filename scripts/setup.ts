/**
 * One-time local setup: creates .env with random secrets, starts the embedded
 * PostgreSQL server (if enabled), applies migrations and loads demo data.
 *
 *   npm run setup            # idempotent
 *   npm run setup -- --reset # wipe and re-seed demo data
 */
import { ensureEnvFile, isDatabaseSeeded, log, prepareDatabase } from "./lib/bootstrap";
import { loadEnv, requireEnv } from "./lib/env";

if (ensureEnvFile()) log("Created .env with fresh secrets.");
loadEnv();

const reset = process.argv.includes("--reset");
const handle = await prepareDatabase();

try {
  const databaseUrl = requireEnv("DATABASE_URL");
  if (reset || !(await isDatabaseSeeded(databaseUrl))) {
    const { seed } = await import("./seed/index");
    await seed({ reset });
  } else {
    log("Database already contains data — skipping demo seed (use --reset to reseed).");
  }
  log("Setup complete. Run `npm run dev` and open http://localhost:3000");
} finally {
  await handle?.stop();
}
process.exit(0);
