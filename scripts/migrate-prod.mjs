/**
 * Applies pending database migrations to DATABASE_URL — used by hosted deployments before each
 * release (Railway's pre-deploy command). Plain Node: no dev tooling, no embedded PostgreSQL,
 * no seeding. Locally, `npm run db:migrate` does the same and also starts the bundled database.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("[forge] DATABASE_URL is not set — nothing to migrate.");
  process.exit(1);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  await migrate(drizzle(sql), { migrationsFolder: "drizzle" });
  console.log("[forge] Database migrations are up to date.");
} catch (error) {
  console.error("[forge] Migration failed:", error);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
