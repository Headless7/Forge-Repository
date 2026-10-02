import { prepareDatabase, log } from "./lib/bootstrap";
import { loadEnv } from "./lib/env";

loadEnv();

const handle = await prepareDatabase();
log("Migrations applied.");
await handle?.stop();
process.exit(0);
