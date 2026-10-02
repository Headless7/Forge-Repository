/**
 *   npm run db:seed    # seed an empty database
 *   npm run db:reset   # wipe everything (data + uploaded files) and reseed
 */
import { ensureEnvFile, isDatabaseSeeded, log, prepareDatabase } from "./lib/bootstrap";
import { loadEnv, requireEnv } from "./lib/env";

ensureEnvFile();
loadEnv();
const reset = process.argv.includes("--reset");
const handle = await prepareDatabase();
try {
  if (!reset && (await isDatabaseSeeded(requireEnv("DATABASE_URL")))) {
    log("Database already has data. Use `npm run db:reset` to wipe and reseed.");
  } else {
    const { seed } = await import("./seed/index");
    await seed({ reset });
  }
} finally {
  const { closeDb } = await import("../src/server/db");
  await closeDb();
  await handle?.stop();
}
process.exit(0);
