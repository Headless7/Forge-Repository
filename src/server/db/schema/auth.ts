import { index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, pk, tsz, updatedAt } from "./columns";

export const users = pgTable(
  "users",
  {
    id: pk(),
    /** Always stored lower-cased. */
    email: text().notNull(),
    emailVerifiedAt: tsz(),
    /** Lower-case handle used for @mentions. */
    username: text().notNull(),
    displayName: text().notNull(),
    avatarKey: text(),
    avatarColor: text().notNull().default("#6366f1"),
    /** Null for accounts that only sign in through OAuth. */
    passwordHash: text(),
    themePreference: text({ enum: ["dark", "light", "system"] }).notNull().default("dark"),
    lastSeenAt: tsz(),
    lastStudioId: uuid(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("users_email_uq").on(t.email), uniqueIndex("users_username_uq").on(t.username)],
);

export const sessions = pgTable(
  "sessions",
  {
    /** SHA-256 of the session token; the raw token only ever lives in the cookie. */
    id: text().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: tsz().notNull(),
    lastActiveAt: tsz().notNull().defaultNow(),
    ipAddress: text(),
    userAgent: text(),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const oauthAccounts = pgTable(
  "oauth_accounts",
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text({ enum: ["discord", "google"] }).notNull(),
    providerAccountId: text().notNull(),
    providerUsername: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("oauth_provider_account_uq").on(t.provider, t.providerAccountId),
    index("oauth_user_idx").on(t.userId),
  ],
);

export const authTokens = pgTable(
  "auth_tokens",
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    purpose: text({ enum: ["EMAIL_VERIFICATION", "PASSWORD_RESET"] }).notNull(),
    tokenHash: text().notNull(),
    /** Email address the token was issued for (verification of a changed email). */
    email: text().notNull(),
    expiresAt: tsz().notNull(),
    usedAt: tsz(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("auth_tokens_hash_uq").on(t.tokenHash), index("auth_tokens_user_idx").on(t.userId)],
);
