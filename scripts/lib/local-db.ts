import EmbeddedPostgres from "embedded-postgres";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import postgres from "postgres";

export interface ParsedDbUrl {
  user: string;
  password: string;
  host: string;
  port: number;
  database: string;
}

export function parseDatabaseUrl(url: string): ParsedDbUrl {
  const u = new URL(url);
  return {
    user: decodeURIComponent(u.username || "postgres"),
    password: decodeURIComponent(u.password || ""),
    host: u.hostname,
    port: Number(u.port || 5432),
    database: u.pathname.replace(/^\//, ""),
  };
}

export function canConnect(host: string, port: number, timeoutMs = 600): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

const DATA_DIR = path.resolve(".data/postgres");

function pgCtlPath(): string | null {
  const candidates = [
    path.resolve("node_modules/@embedded-postgres/windows-x64/native/bin/pg_ctl.exe"),
    path.resolve("node_modules/@embedded-postgres/linux-x64/native/bin/pg_ctl"),
    path.resolve("node_modules/@embedded-postgres/darwin-arm64/native/bin/pg_ctl"),
    path.resolve("node_modules/@embedded-postgres/darwin-x64/native/bin/pg_ctl"),
    path.resolve("node_modules/@embedded-postgres/linux-arm64/native/bin/pg_ctl"),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

/** Graceful shutdown (fast mode) so the cluster never needs crash recovery. */
function pgCtlStop(): Promise<boolean> {
  const bin = pgCtlPath();
  if (!bin) return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn(bin, ["stop", "-D", DATA_DIR, "-m", "fast", "-w"], { stdio: "ignore" });
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

export interface LocalDatabaseHandle {
  /** True when this process started the server (and therefore owns shutdown). */
  started: boolean;
  stop: () => Promise<void>;
}

/**
 * Makes sure a PostgreSQL server is reachable at DATABASE_URL. When nothing is
 * listening on the configured localhost port, a private embedded cluster is
 * initialised in .data/postgres and started. Missing databases are created.
 */
export async function ensureLocalDatabase(options: {
  databaseUrl: string;
  extraDatabases?: string[];
  log?: (message: string) => void;
}): Promise<LocalDatabaseHandle> {
  const cfg = parseDatabaseUrl(options.databaseUrl);
  const log = options.log ?? ((m: string) => console.log(m));

  if (!["127.0.0.1", "localhost", "::1"].includes(cfg.host)) {
    throw new Error("EMBEDDED_POSTGRES=true requires DATABASE_URL to point at localhost.");
  }

  let instance: EmbeddedPostgres | null = null;
  let started = false;

  if (await canConnect(cfg.host, cfg.port)) {
    log(`• PostgreSQL already running on port ${cfg.port}`);
  } else {
    instance = new EmbeddedPostgres({
      databaseDir: DATA_DIR,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      authMethod: "scram-sha-256",
      persistent: true,
      // UTF-8 everywhere; the builtin C.UTF-8 provider gives Unicode-aware lower()/ILIKE
      // independent of the host OS locale (Windows would otherwise pick a legacy codepage).
      initdbFlags: [
        "--encoding=UTF8",
        "--locale-provider=builtin",
        "--builtin-locale=C.UTF-8",
        "--lc-collate=C",
        "--lc-ctype=C",
      ],
      postgresFlags: ["-c", "max_connections=200", "-c", "listen_addresses=127.0.0.1"],
      onLog: () => {},
      onError: (err) => {
        const message = err instanceof Error ? err.message : String(err);
        if (message.trim()) log(`[postgres] ${message.trim()}`);
      },
    });

    if (!fs.existsSync(path.join(DATA_DIR, "PG_VERSION"))) {
      log("• Initialising local PostgreSQL cluster in .data/postgres …");
      fs.mkdirSync(path.dirname(DATA_DIR), { recursive: true });
      await instance.initialise();
    }
    // A stale lock file from a hard-killed server blocks startup; postgres removes it
    // itself when the recorded PID is gone, so we only need to start.
    log(`• Starting PostgreSQL on port ${cfg.port} …`);
    await instance.start();
    started = true;
  }

  const admin = postgres({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: "postgres",
    max: 1,
    onnotice: () => {},
  });
  try {
    for (const name of [cfg.database, ...(options.extraDatabases ?? [])]) {
      const rows = await admin`select 1 from pg_database where datname = ${name}`;
      if (rows.length === 0) {
        if (!/^[a-z0-9_]+$/i.test(name)) throw new Error(`Refusing to create database with unsafe name "${name}"`);
        await admin.unsafe(`create database "${name}"`);
        log(`• Created database "${name}"`);
      }
    }
  } finally {
    await admin.end({ timeout: 2 });
  }

  return {
    started,
    stop: async () => {
      if (!instance || !started) return;
      const graceful = await pgCtlStop();
      if (graceful) {
        // embedded-postgres registers an exit hook that waits for the server process it spawned;
        // after pg_ctl already stopped it, clear the handle so exiting doesn't stall for 10s.
        (instance as unknown as { process?: unknown }).process = undefined;
      } else {
        await instance.stop();
      }
    },
  };
}
