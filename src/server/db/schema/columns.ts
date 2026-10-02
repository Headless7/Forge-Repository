import { timestamp, uuid } from "drizzle-orm/pg-core";

/** Shared column builders so every table uses the same id/timestamp conventions. */
export const pk = () => uuid().primaryKey().defaultRandom();

export const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const tsz = () => timestamp({ withTimezone: true });
