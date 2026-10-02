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
import { hasPendingInvitation, isPlatformAdminEmail } from "../services/platform";
import { generateToken, hmac, safeEqual } from "./crypto";
import { createSession, invalidateUserSessions } from "./session";

export type OAuthProviderId = "discord" | "google";

export interface OAuthProfile {
  id: string;
  email: string | null;
  emailVerified: boolean;
  username: string;
  displayName: string;
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
}

export function oauthProvider(id: string): ProviderConfig | null {
  if (id === "discord" && env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET) {
    return {
      id,
      authorizeUrl: "https://discord.com/oauth2/authorize",
      tokenUrl: "https://discord.com/api/oauth2/token",
      scopes: ["identify", "email"],
      clientId: env.DISCORD_CLIENT_ID,
      clientSecret: env.DISCORD_CLIENT_SECRET,
      pkce: false,
      async fetchProfile(token) {
        const res = await fetch("https://discord.com/api/users/@me", { headers: { authorization: `Bearer ${token}` } });
        if (!res.ok) throw invalid("Couldn't read your Discord profile.");
        const p = (await res.json()) as { id: string; username: string; global_name?: string | null; email?: string | null; verified?: boolean };
        return { id: p.id, email: p.email?.toLowerCase() ?? null, emailVerified: Boolean(p.verified), username: p.username, displayName: p.global_name || p.username };
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

export async function exchangeCode(provider: ProviderConfig, code: string, verifier: string): Promise<string> {
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
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw invalid("Sign-in failed. Please try again.");
  return json.access_token;
}

/**
 * Signs in (or links) using a provider profile:
 *  1. existing link → sign in
 *  2. signed-in user → link to them
 *  3. verified email matching an account → link and sign in
 *  4. otherwise create a new account — only for an address with a pending invitation (or an
 *     operator's), since Forge is private; activation keys go through email sign-up
 */
export async function completeOAuth(
  providerId: OAuthProviderId,
  profile: OAuthProfile,
  currentUserId: string | null,
  meta: { ip: string | null; userAgent: string | null },
) {
  const [linked] = await db
    .select()
    .from(oauthAccounts)
    .where(and(eq(oauthAccounts.provider, providerId), eq(oauthAccounts.providerAccountId, profile.id)));

  if (linked) {
    if (currentUserId && linked.userId !== currentUserId) throw conflict("That account is already linked to another Forge user.");
    return { session: await createSession(linked.userId, meta), isNew: false };
  }

  let userId = currentUserId;
  let isNew = false;
  if (!userId && profile.email && profile.emailVerified) {
    const [existing] = await db.select({ id: users.id, emailVerifiedAt: users.emailVerifiedAt }).from(users).where(eq(users.email, profile.email));
    userId = existing?.id ?? null;
    if (existing && !existing.emailVerifiedAt) {
      // Whoever registered this address never proved they own it, but the provider just did:
      // drop that password and its sessions so a pre-registered account can't be taken over.
      await db.update(users).set({ emailVerifiedAt: now(), passwordHash: null }).where(eq(users.id, existing.id));
      await invalidateUserSessions(existing.id);
    }
  }
  if (!userId) {
    if (!profile.email || !profile.emailVerified) {
      throw invalid("Your account doesn't have a verified email address. Verify it with the provider, or sign up with email.");
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
  await db.insert(oauthAccounts).values({ userId, provider: providerId, providerAccountId: profile.id, providerUsername: profile.username });
  return { session: await createSession(userId, meta), isNew };
}
