import nextEnv from "@next/env";

let loaded = false;

/** Loads .env files with the same precedence rules Next.js uses. */
export function loadEnv(dev = true) {
  if (loaded) return;
  nextEnv.loadEnvConfig(process.cwd(), dev, { info: () => {}, error: console.error });
  loaded = true;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}. Did you run \`npm run setup\`?`);
  return value;
}
