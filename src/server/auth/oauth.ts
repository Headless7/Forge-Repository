/**
 * OAuth 2.0 sign-in (Discord, Google). Providers are enabled only when their
 * credentials are configured. Accounts are linked through `oauth_accounts`, so
 * adding a provider never changes the user model.
 */
import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { oauthAccounts, users } from "../db/schema";
import { appOrigin, env } from "../env";
import { conflict, forbidden, invalid } from "../errors";
import { now } from "../clock";
import { pickAvatarColor, suggestUsername } from "../services/accounts";
import { onDiscordAccountLinked } from "../services/discord-dm";
import { applyAvatarSource, profileFromDiscordUser, recordDiscordConnection, scheduleDiscordAvatarCache, type DiscordProfileFields, type DiscordUserObject, type OAuthTokens } from "../services/discord-profile";
import { hasPendingInvitation, isPlatformAdminEmail } from "../services/platform";
import { generateToken, hmac, safeEqual } from "./crypto";
import { createSession } from "./session";

export type OAuthProviderId = "discord" | "google";

export interface OAuthProfile {
  id: string;
  email: string | null;
  emailVerified: boolean;
  username: string;
  displayName: string;
  /** Discord only: the username, display name and picture, as Discord reported them. */
  discord?: DiscordProfileFields;
}

interface ProviderConfig {
  id: OAuthProviderId;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientId: string;
  clientSecret: string;
  pkce: boolean;
  fetchProfile(accessToken: string): Promise<OAuthProfile>;
  /** Keep the tokens to refresh the profile later (Discord). */
  storeTokens: boolean;
}

export function oauthProvider(id: string): ProviderConfig | null {
  if (id === "discord" && env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET) {
    return {
      id,
      authorizeUrl: "https://discord.com/oauth2/authorize",
      tokenUrl: "https://discord.com/api/oauth2/token",
      // identify: id, username, display name, picture · email: needed to create an invited account.
      scopes: ["identify", "email"],
      clientId: env.DISCORD_CLIENT_ID,
      clientSecret: env.DISCORD_CLIENT_SECRET,
      pkce: false,
      storeTokens: true,
      async fetchProfile(token) {
        const res = await fetch(`${env.DISCORD_API_BASE}/users/@me`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw invalid("Couldn't read your Discord profile.");
        const p = (await res.json()) as DiscordUserObject & { email?: string | null; verified?: boolean };
        if (typeof p.id !== "string" || typeof p.username !== "string") throw invalid("Couldn't read your Discord profile.");
        const discord = profileFromDiscordUser(p);
        return { id: p.id, email: p.email?.toLowerCase() ?? null, emailVerified: Boolean(p.verified), username: p.username, displayName: discord.globalName || p.username, discord };
      },
    };
  }
  if (id === "google" && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    return {
      id,
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: ["openid", "email", "profile"],
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      pkce: true,
      storeTokens: false,
      async fetchProfile(token) {
        const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${token}` } });
        if (!res.ok) throw invalid("Couldn't read your Google profile.");
        const p = (await res.json()) as { sub: string; email?: string; email_verified?: boolean; name?: string };
        const email = p.email?.toLowerCase() ?? null;
        return { id: p.sub, email, emailVerified: Boolean(p.email_verified), username: email?.split("@")[0] ?? "user", displayName: p.name || email || "New user" };
      },
    };
  }
  return null;
}

export function redirectUri(provider: OAuthProviderId) {
  return `${appOrigin()}/api/auth/oauth/${provider}/callback`;
}

export interface OAuthState {
  provider: OAuthProviderId;
  state: string;
  verifier: string;
  next: string;
}

/** The state cookie is HMAC-signed so it can't be forged or altered. */
export function encodeState(value: OAuthState): string {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${payload}.${hmac(`oauth:${payload}`)}`;
}

export function decodeState(cookie: string | null): OAuthState | null {
  if (!cookie) return null;
  const [payload, sig] = cookie.split(".");
  if (!payload || !sig || !safeEqual(hmac(`oauth:${payload}`), sig)) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString()) as OAuthState;
  } catch {
    return null;
  }
}

export function startAuthorization(provider: ProviderConfig, next: string) {
  const state = generateToken(24);
  const verifier = generateToken(48);
  const params = new URLSearchParams({
    client_id: provider.clientId,
    redirect_uri: redirectUri(provider.id),
    response_type: "code",
    scope: provider.scopes.join(" "),
    state,
  });
  if (provider.pkce) {
    params.set("code_challenge", crypto.createHash("sha256").update(verifier).digest("base64url"));
    params.set("code_challenge_method", "S256");
  }
  if (provider.id === "google") params.set("prompt", "select_account");
  return { url: `${provider.authorizeUrl}?${params}`, cookie: encodeState({ provider: provider.id, state, verifier, next }) };
}

export async function exchangeCode(provider: ProviderConfig, code: string, verifier: string): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(provider.id),
    client_id: provider.clientId,
    client_secret: provider.clientSecret,
  });
  if (provider.pkce) body.set("code_verifier", verifier);
  const res = await fetch(provider.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  if (!res.ok) throw invalid("Sign-in was cancelled or expired. Please try again.");
  const json = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!json.access_token) throw invalid("Sign-in failed. Please try again.");
  return { accessToken: json.access_token, refreshToken: json.refresh_token ?? null, expiresIn: typeof json.expires_in === "number" ? json.expires_in : null };
}

/**
 * Signs in (or links) using a provider profile. Accounts are only ever linked by the provider's
 * stable account id, verified here on the server — never by matching an email address or a name:
 *  1. an existing link → sign in (and keep what the provider just told us)
 *  2. someone signed in → link it to them (one account per provider)
 *  3. otherwise create a new account — only for a verified address with a pending invitation (or an
 *     operator's), and never for an address that already has an account: its owner signs in and
 *     connects the provider from Account → Security instead
 */
export async function completeOAuth(
  providerId: OAuthProviderId,
  profile: OAuthProfile,
  currentUserId: string | null,
  meta: { ip: string | null; userAgent: string | null },
  tokens: OAuthTokens | null = null,
) {
  const label = providerId === "discord" ? "Discord" : "Google";
  const [linked] = await db
    .select()
    .from(oauthAccounts)
    .where(and(eq(oauthAccounts.provider, providerId), eq(oauthAccounts.providerAccountId, profile.id)));

  if (linked) {
    if (currentUserId && linked.userId !== currentUserId) throw conflict(`That ${label} account is already connected to another Forge account.`);
    if (providerId === "discord" && profile.discord) {
      // Signing in (or reconnecting) refreshes the profile and the authorization.
      await recordDiscordConnection(db, linked.id, profile.discord, tokens);
      scheduleDiscordAvatarCache(linked.userId);
    }
    return { session: await createSession(linked.userId, meta), isNew: false };
  }

  let userId = currentUserId;
  let isNew = false;
  if (!userId) {
    if (!profile.email || !profile.emailVerified) {
      throw invalid("Your account doesn't have a verified email address. Verify it with the provider, or sign up with email.");
    }
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, profile.email));
    if (existing) {
      throw conflict(`A Forge account already uses this email address. Sign in with your password (or reset it), then connect ${label} in Account → Security.`);
    }
    if (!isPlatformAdminEmail(profile.email) && !(await hasPendingInvitation(profile.email))) {
      throw forbidden("Forge is invitation-only. Ask a studio admin to invite this email address, or sign up with email and your activation key.");
    }
    const [created] = await db
      .insert(users)
      .values({
        email: profile.email,
        username: await suggestUsername(profile.username),
        displayName: profile.displayName.slice(0, 60),
        avatarColor: pickAvatarColor(profile.email),
        emailVerifiedAt: now(),
      })
      .returning();
    userId = created!.id;
    isNew = true;
  }
  const ownerId = userId;
  await db.transaction(async (tx) => {
    // One account per provider: serialise connections for this person and refuse a second one.
    const [owner] = await tx.select({ id: users.id, custom: users.customAvatarKey }).from(users).where(eq(users.id, ownerId)).for("update");
    if (!owner) throw invalid("That account no longer exists.");
    const [other] = await tx.select({ id: oauthAccounts.id }).from(oauthAccounts).where(and(eq(oauthAccounts.userId, ownerId), eq(oauthAccounts.provider, providerId)));
    if (other) throw conflict(`Your Forge account is already connected to a different ${label} account. Disconnect it first, then connect this one.`);
    const [row] = await tx
      .insert(oauthAccounts)
      .values({ userId: ownerId, provider: providerId, providerAccountId: profile.id, providerUsername: profile.discord?.username ?? profile.username })
      .returning({ id: oauthAccounts.id });
    if (providerId === "discord" && profile.discord) {
      await recordDiscordConnection(tx, row!.id, profile.discord, tokens);
      // Without an uploaded photo the Discord picture is used by default; an uploaded one is kept.
      if (!owner.custom) await tx.update(users).set({ avatarSource: "discord" }).where(eq(users.id, ownerId));
      await applyAvatarSource(tx, ownerId);
    }
  });
  if (providerId === "discord") {
    scheduleDiscordAvatarCache(ownerId);
    // Connecting Discord also turns on direct messages: start fresh and send a welcome.
    // Best effort: signing in never fails because the welcome couldn't be queued.
    await onDiscordAccountLinked(ownerId, profile.id).catch((error) => console.error("[discord] couldn't start direct messages", error));
  }
  return { session: await createSession(ownerId, meta), isNew };
}
