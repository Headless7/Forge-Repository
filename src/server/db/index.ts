import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Anything that can run queries: the pool or an open transaction. */
export type Executor = Db | Tx;

interface DbGlobals {
  __forgeSql?: postgres.Sql;
  __forgeDb?: Db;
}
const g = globalThis as unknown as DbGlobals;

function connect() {
  const client = postgres(env.DATABASE_URL, {
    max: env.NODE_ENV === "test" ? 5 : 15,
    idle_timeout: 30,
    connect_timeout: 15,
    onnotice: () => {},
  });
  return { client, database: drizzle(client, { schema, casing: "snake_case" }) };
}

function ensure(): Db {
  if (!g.__forgeDb) {
    const { client, database } = connect();
    // Reuse across hot reloads in development so we don't leak connection pools.
    g.__forgeSql = client;
    g.__forgeDb = database;
  }
  return g.__forgeDb;
}

export const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    const instance = ensure();
    const value = Reflect.get(instance, prop, instance);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});

export function rawSql(): postgres.Sql {
  ensure();
  return g.__forgeSql!;
}

export async function closeDb() {
  if (g.__forgeSql) await g.__forgeSql.end({ timeout: 5 });
  g.__forgeSql = undefined;
  g.__forgeDb = undefined;
}

export { schema };
