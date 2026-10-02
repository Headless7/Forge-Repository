import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Tests run against a dedicated database (<name>_test) on the same PostgreSQL server.
if (!process.env.DATABASE_URL && fs.existsSync(".env")) process.loadEnvFile(".env");
const base = new URL(process.env.DATABASE_URL ?? "postgres://forge:forge@127.0.0.1:54329/forge");
const testUrl = new URL(base);
testUrl.pathname = `/${base.pathname.replace(/^\//, "")}_test`;

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve("src"),
      "server-only": path.resolve("src/test/empty.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    globalSetup: ["./src/test/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: testUrl.toString(),
      BASE_DATABASE_URL: base.toString(),
      AUTH_SECRET: "test-secret-test-secret-test-secret",
      APP_URL: "http://localhost:3000",
      STORAGE_DRIVER: "local",
      STORAGE_LOCAL_DIR: ".data/test-storage",
      REALTIME_DRIVER: "memory",
      ENABLE_INPROCESS_JOBS: "false",
    },
  },
});
