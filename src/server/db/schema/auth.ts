import { index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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
    /**
     * The picture everyone sees (the one shared avatar path): the cached Discord picture when
     * `avatarSource` is "discord" and there is one, otherwise the uploaded photo. Written only by
     * `applyAvatarSource` (services/discord-profile).
     */
    avatarKey: text(),
    /** The photo the person uploaded, kept while their Discord picture is shown. */
    customAvatarKey: text(),
    /** Which picture to show: the uploaded photo ("custom") or the connected Discord picture. */
    avatarSource: text({ enum: ["custom", "discord"] }).notNull().default("custom"),
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
    /** The provider's stable account id (Discord: the user id) — the only thing accounts are linked by. */
    providerAccountId: text().notNull(),
    /** Discord: the unique username (handle), e.g. "headless7". Refreshed from Discord. */
    providerUsername: text(),
    /** Discord: the display name (`global_name`), when the person set one. */
    displayName: text(),
    /** Discord: the avatar hash (null = Discord's default picture). */
    avatarHash: text(),
    /** Our copy of that picture (a static WebP in storage), so browsers never load Discord's CDN. */
    avatarKey: text(),
    /** Discord OAuth tokens, encrypted at rest (auth/secret-box); never sent to browsers or logged. */
    accessToken: text(),
    refreshToken: text(),
    tokenExpiresAt: tsz(),
    /** Last successful profile refresh. */
    profileSyncedAt: tsz(),
    /** Last refresh problem (kept with the last good profile until a refresh succeeds). */
    syncError: text(),
    syncFailures: integer().notNull().default(0),
    /** When the next background refresh may run (freshness interval or backoff). */
    nextSyncAt: tsz(),
    /** A refresh in progress holds this lease, so two can't race over tokens or the profile. */
    syncLeaseUntil: tsz(),
    /** Discord no longer accepts our authorization: the person needs to reconnect. */
    needsReauthAt: tsz(),
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
