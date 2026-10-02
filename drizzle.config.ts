import fs from "node:fs";
import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL && fs.existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  schema: "./src/server/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  casing: "snake_case",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://forge:forge@127.0.0.1:54329/forge",
  },
  strict: true,
  verbose: false,
});
