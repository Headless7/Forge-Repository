import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { completeOAuth } from "@/server/auth/oauth";
import { createSession, validateSessionToken } from "@/server/auth/session";
import { db } from "@/server/db";
import { attachments, users } from "@/server/db/schema";
import { clientIpFrom, readJsonBody } from "@/server/http";
import { sharedRateLimiter } from "@/server/rate-limit";
import * as accounts from "@/server/services/accounts";
import { recoverMediaJobs } from "@/server/services/media";
import * as media from "@/server/services/media";
import { storage } from "@/server/storage";
import { expectAppError, setupStudio } from "@/test/helpers";
import * as cardService from "@/server/services/cards";

const stamp = () => crypto.randomBytes(4).toString("hex");

describe("proxy headers", () => {
  const headers = (xff: string) => new Headers({ "x-forwarded-for": xff });

  it("ignores X-Forwarded-For unless a proxy in front is trusted", () => {
    expect(clientIpFrom(headers("6.6.6.6"), 0)).toBeNull();
  });

  it("takes the address the trusted proxy saw, not what the client wrote", () => {
    // The client claims 6.6.6.6; our proxy appends the real peer address.
    expect(clientIpFrom(headers("6.6.6.6, 203.0.113.9"), 1)).toBe("203.0.113.9");
    expect(clientIpFrom(headers("6.6.6.6, 198.51.100.4, 10.0.0.2"), 2)).toBe("198.51.100.4");
    expect(clientIpFrom(headers("203.0.113.9"), 1)).toBe("203.0.113.9");
  });
});

describe("request bodies", () => {
  it("refuses an oversized JSON body while reading it", async () => {
    const big = new Request("http://localhost/api", { method: "POST", body: JSON.stringify({ text: "x".repeat(70_000) }) });
    await expectAppError(readJsonBody(big, 64 * 1024), "PAYLOAD_TOO_LARGE");
    const ok = new Request("http://localhost/api", { method: "POST", body: JSON.stringify({ a: 1 }) });
    expect(await readJsonBody(ok, 64 * 1024)).toEqual({ a: 1 });
  });
});

describe("sign-in throttling", () => {
  it("stops password guessing spread over many addresses", async () => {
    const email = `target_${stamp()}@test.dev`;
    await accounts.signUp({ email, password: "the real password", displayName: "Target" }, { ip: "192.0.2.1", userAgent: "vitest" });
    // 30 wrong guesses, each from a different address (no per-address budget is ever reached).
    for (let i = 0; i < 30; i++) {
      await expectAppError(accounts.signIn({ email, password: `guess ${i}` }, { ip: `198.51.100.${i}`, userAgent: "vitest" }), "UNAUTHORIZED");
    }
    await expectAppError(accounts.signIn({ email, password: "guess 31" }, { ip: "203.0.113.200", userAgent: "vitest" }), "RATE_LIMITED");
  });

  it("keeps budgets in the database, shared by every app instance", async () => {
    const key = `test:${stamp()}`;
    expect((await sharedRateLimiter.consume(key, 2, 60_000)).ok).toBe(true);
    expect((await sharedRateLimiter.consume(key, 2, 60_000)).ok).toBe(true);
    const third = await sharedRateLimiter.consume(key, 2, 60_000);
    expect(third.ok).toBe(false);
    expect(third.retryAfterMs).toBeGreaterThan(0);
  });
});

describe("one-time tokens", () => {
  it("lets only one of two simultaneous requests use a password-reset link", async () => {
    const email = `reset_${stamp()}@test.dev`;
    const meta = { ip: "192.0.2.2", userAgent: "vitest" };
    await accounts.signUp({ email, password: "old password", displayName: "Reset" }, meta);
    await accounts.requestPasswordReset({ email }, meta);
    const { emailOutbox } = await import("@/server/db/schema");
    const { and, desc } = await import("drizzle-orm");
    const [mail] = await db.select().from(emailOutbox).where(and(eq(emailOutbox.to, email), eq(emailOutbox.template, "password-reset"))).orderBy(desc(emailOutbox.createdAt)).limit(1);
    const token = /token=([A-Za-z0-9_-]+)/.exec(mail!.textBody)![1]!;
    const results = await Promise.allSettled([
      accounts.resetPassword({ token, password: "attacker choice 1" }, meta),
      accounts.resetPassword({ token, password: "attacker choice 2" }, meta),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
});

describe("OAuth sign-in", () => {
  it("doesn't hand over an account someone pre-registered with an unverified address", async () => {
    const email = `victim_${stamp()}@test.dev`;
    const meta = { ip: "192.0.2.3", userAgent: "vitest" };
    // The attacker registers the victim's address with their own password (never verified).
    const { user, session } = await accounts.signUp({ email, password: "attacker password", displayName: "Squatter" }, meta);
    expect(user.emailVerifiedAt).toBeNull();
    // The victim signs in with Google, which verified the address.
    await completeOAuth("google", { id: `g-${stamp()}`, email, emailVerified: true, username: "victim", displayName: "Victim" }, null, meta);
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row!.emailVerifiedAt).not.toBeNull();
    expect(row!.passwordHash).toBeNull(); // the attacker's password no longer works…
    expect(await validateSessionToken(session.token)).toBeNull(); // …and their session is gone
    await expectAppError(accounts.signIn({ email, password: "attacker password" }, meta), "UNAUTHORIZED");
    // A normal verified account keeps its password when its owner links Google.
    const owner = `owner_${stamp()}@test.dev`;
    const created = await accounts.signUp({ email: owner, password: "owner password", displayName: "Owner" }, meta);
    await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, created.user.id));
    const ownerSession = await createSession(created.user.id, meta);
    await completeOAuth("google", { id: `g-${stamp()}`, email: owner, emailVerified: true, username: "owner", displayName: "Owner" }, null, meta);
    expect((await db.select().from(users).where(eq(users.id, created.user.id)))[0]!.passwordHash).not.toBeNull();
    expect(await validateSessionToken(ownerSession.token)).not.toBeNull();
  });
});

describe("media recovery after a restart", () => {
  it("frees uploads that were started but never finished", async () => {
    const f = await setupStudio();
    const card = await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title: "Abandoned" });
    const intent = await media.createUpload(f.manager.actor, { cardId: card.id, filename: "half.png", size: 100, contentType: "image/png", purpose: "attachment" });
    const [row] = await db.select().from(attachments).where(eq(attachments.id, intent.attachmentId));
    await storage().put(row!.storageKey, Buffer.from("partial"), "image/png");
    // Not yet abandoned…
    await recoverMediaJobs(new Date());
    expect((await db.select().from(attachments).where(eq(attachments.id, row!.id)))[0]!.status).toBe("PENDING");
    // …a day later it is.
    const result = await recoverMediaJobs(new Date(Date.now() + 25 * 60 * 60 * 1000));
    expect(result.abandonedUploads).toBeGreaterThanOrEqual(1);
    expect((await db.select().from(attachments).where(eq(attachments.id, row!.id)))[0]!.status).toBe("FAILED");
    expect(await storage().stat(row!.storageKey)).toBeNull();
  });
});
