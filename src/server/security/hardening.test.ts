import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { completeOAuth } from "@/server/auth/oauth";
import { validateSessionToken } from "@/server/auth/session";
import { db } from "@/server/db";
import { attachments, oauthAccounts, users } from "@/server/db/schema";
import { clientIpFrom, readBodyLimited, readJsonBody } from "@/server/http";
import { noticeIsAuthentic, withNotice } from "@/notice-signature";
import { storedContentType } from "@/server/storage/s3";
import { sharedRateLimiter } from "@/server/rate-limit";
import * as accounts from "@/server/services/accounts";
import { recoverMediaJobs } from "@/server/services/media";
import * as media from "@/server/services/media";
import { storage } from "@/server/storage";
import { expectAppError, pendingInvite, setupStudio } from "@/test/helpers";
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

  it("caps a streamed body that announces no size", async () => {
    const chunk = new Uint8Array(32 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        // Endless unless the reader stops: the cap has to.
        sent += chunk.length;
        controller.enqueue(chunk);
      },
    });
    const chunked = new Request("http://localhost/api", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    expect(chunked.headers.get("content-length")).toBeNull();
    await expectAppError(readBodyLimited(chunked, 256 * 1024), "PAYLOAD_TOO_LARGE");
    expect(sent).toBeLessThan(1024 * 1024);
  });
});

describe("messages carried in URLs", () => {
  const secret = "test-secret-for-notices-0123456789";

  it("trust only what this server signed", async () => {
    const signed = new URL(await withNotice("/sign-in", "error", "Sign-in expired. Please try again.", secret), "https://forge.test");
    expect(await noticeIsAuthentic(signed.searchParams, secret)).toBe(true);
    expect(await noticeIsAuthentic(new URLSearchParams(""), secret)).toBe(true);

    const altered = new URLSearchParams(signed.searchParams);
    altered.set("error", "Forge has moved: sign in at evil.example");
    expect(await noticeIsAuthentic(altered, secret)).toBe(false);
    expect(await noticeIsAuthentic(new URLSearchParams("error=Forge+has+moved"), secret)).toBe(false);
    expect(await noticeIsAuthentic(signed.searchParams, "another-secret-0123456789abcdef")).toBe(false);

    // A valid signature for one parameter can't vouch for another, or for a second copy.
    const moved = new URLSearchParams({ oauthError: signed.searchParams.get("error")!, ns: signed.searchParams.get("ns")! });
    expect(await noticeIsAuthentic(moved, secret)).toBe(false);
    const doubled = new URLSearchParams(signed.searchParams);
    doubled.append("error", "second");
    expect(await noticeIsAuthentic(doubled, secret)).toBe(false);
  });

  it("keep the path and fragment they were added to", async () => {
    expect(await withNotice("/acme/settings#discord", "discordError", "Cancelled.", secret)).toMatch(/^\/acme\/settings\?discordError=Cancelled\.&ns=[\w-]+#discord$/);
  });
});

describe("object storage types", () => {
  it("stores anything a browser could run as a download", () => {
    for (const type of ["text/html", "image/svg+xml", "application/xhtml+xml", "text/xml", "application/javascript", "TEXT/HTML; charset=utf-8", "model/obj", ""]) {
      expect(storedContentType(type)).toBe("application/octet-stream");
    }
    for (const type of ["image/png", "image/jpeg", "image/webp", "video/mp4", "video/webm", "audio/mpeg", "audio/mp4", "application/json"]) {
      expect(storedContentType(type)).toBe(type);
    }
  });
});

describe("sign-up", () => {
  it("doesn't tell someone without an invitation or key whether an address has an account", async () => {
    const email = `taken-${stamp()}@test.dev`;
    await accounts.signUp({ email, password: "a good password", displayName: "Taken", inviteToken: await pendingInvite(email) }, { ip: "192.0.2.50", userAgent: "vitest" });
    await expectAppError(accounts.signUp({ email, password: "another password", displayName: "Prober" }, { ip: "192.0.2.51", userAgent: "vitest" }), "FORBIDDEN");
  });
});

describe("sign-in throttling", () => {
  it("stops password guessing spread over many addresses", async () => {
    const email = `target_${stamp()}@test.dev`;
    await accounts.signUp({ email, password: "the real password", displayName: "Target", inviteToken: await pendingInvite(email) }, { ip: "192.0.2.1", userAgent: "vitest" });
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
    await accounts.signUp({ email, password: "old password", displayName: "Reset", inviteToken: await pendingInvite(email) }, meta);
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
  it("never links or takes over an existing account because an email address matches", async () => {
    const meta = { ip: "192.0.2.3", userAgent: "vitest" };
    for (const verified of [false, true]) {
      const email = `owner_${verified ? "v" : "u"}_${stamp()}@test.dev`;
      const { user, session } = await accounts.signUp({ email, password: "owner password", displayName: "Owner", inviteToken: await pendingInvite(email) }, meta);
      if (verified) await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, user.id));
      // Someone signs in with a provider account reporting the same (verified) address: refused.
      for (const provider of ["google", "discord"] as const) {
        await expectAppError(completeOAuth(provider, { id: `${provider}-${stamp()}`, email, emailVerified: true, username: "someone", displayName: "Someone" }, null, meta), "CONFLICT");
      }
      // Nothing about the existing account changed, and nothing was linked to it.
      const [row] = await db.select().from(users).where(eq(users.id, user.id));
      expect(row!.passwordHash).not.toBeNull();
      expect(Boolean(row!.emailVerifiedAt)).toBe(verified);
      expect(await validateSessionToken(session.token)).not.toBeNull();
      expect(await db.select().from(oauthAccounts).where(eq(oauthAccounts.userId, user.id))).toEqual([]);
      // Its owner connects the provider while signed in instead.
      await completeOAuth("google", { id: `google-own-${stamp()}`, email: "other@example.com", emailVerified: true, username: "owner", displayName: "Owner" }, user.id, meta);
      expect(await db.select().from(oauthAccounts).where(eq(oauthAccounts.userId, user.id))).toHaveLength(1);
    }
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
