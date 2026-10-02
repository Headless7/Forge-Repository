/** Runs only the local PostgreSQL server (e.g. while running `npm run dev:next` or tests). Ctrl+C to stop. */
import { ensureEnvFile, log, prepareDatabase } from "./lib/bootstrap";
import { loadEnv } from "./lib/env";

ensureEnvFile();
loadEnv();
const handle = await prepareDatabase();
log("PostgreSQL is running. Press Ctrl+C to stop.");

const stop = async () => {
  await handle?.stop();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
setInterval(() => {}, 1 << 30);
