import { and, desc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { validateSessionToken } from "@/server/auth/session";
import { pinClock } from "@/server/clock";
import { db } from "@/server/db";
import { authTokens, emailOutbox, notifications, users } from "@/server/db/schema";
import { expectAppError, setupStudio } from "@/test/helpers";
import * as accounts from "./accounts";
import * as cardService from "./cards";
import { runDueDateReminders } from "./due-dates";

const meta = { ip: "127.0.0.1", userAgent: "vitest" };
const stamp = () => Math.random().toString(36).slice(2, 8);

async function latestLink(email: string, template: string) {
  const [mail] = await db.select().from(emailOutbox).where(and(eq(emailOutbox.to, email), eq(emailOutbox.template, template))).orderBy(desc(emailOutbox.createdAt)).limit(1);
  const token = /token=([A-Za-z0-9_-]+)/.exec(mail?.textBody ?? "")?.[1];
  return token!;
}

describe("authentication", () => {
  it("signs up with a hashed password, a session and a verification email", async () => {
    const email = `new_${stamp()}@test.dev`;
    const { user, session } = await accounts.signUp({ email: email.toUpperCase(), password: "correct horse", displayName: "New Person" }, meta);
    expect(user.email).toBe(email);
    expect(user.passwordHash).toMatch(/^scrypt\$/);
    expect(user.passwordHash).not.toContain("correct horse");
    expect(user.emailVerifiedAt).toBeNull();
    expect((await validateSessionToken(session.token))?.user.id).toBe(user.id);
    await expectAppError(accounts.signUp({ email, password: "another pass", displayName: "Dup" }, meta), "CONFLICT");

    const token = await latestLink(email, "verify-email");
    await accounts.verifyEmail(token);
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row?.emailVerifiedAt).not.toBeNull();
    await expectAppError(accounts.verifyEmail(token), "VALIDATION");
  });

  it("rejects wrong passwords without revealing which emails exist", async () => {
    const email = `login_${stamp()}@test.dev`;
    await accounts.signUp({ email, password: "right password", displayName: "Login" }, meta);
    await expectAppError(accounts.signIn({ email, password: "wrong password" }, meta), "UNAUTHORIZED");
    await expectAppError(accounts.signIn({ email: `nobody_${stamp()}@test.dev`, password: "whatever" }, meta), "UNAUTHORIZED");
    await expect(accounts.signIn({ email, password: "right password" }, meta)).resolves.toHaveProperty("session");
  });

  it("locks out repeated failures but never counts successful sign-ins", async () => {
    const email = `brute_${stamp()}@test.dev`;
    const ip = { ip: `10.9.${Math.floor(Math.random() * 250)}.1`, userAgent: "vitest" };
    await accounts.signUp({ email, password: "real password", displayName: "Target" }, meta);
    for (let i = 0; i < 20; i++) await accounts.signIn({ email, password: "real password" }, ip);
    for (let i = 0; i < 10; i++) await expectAppError(accounts.signIn({ email, password: `guess ${i}` }, ip), "UNAUTHORIZED");
    await expectAppError(accounts.signIn({ email, password: "real password" }, ip), "RATE_LIMITED");
  });

  it("resets passwords with a single-use token and signs out other sessions", async () => {
    const email = `reset_${stamp()}@test.dev`;
    const { session: old } = await accounts.signUp({ email, password: "old password", displayName: "Reset" }, meta);
    await accounts.requestPasswordReset({ email }, meta);
    await expect(accounts.requestPasswordReset({ email: `ghost_${stamp()}@test.dev` }, meta)).resolves.toEqual({ ok: true });
    const token = await latestLink(email, "password-reset");
    const [stored] = await db.select().from(authTokens).where(eq(authTokens.purpose, "PASSWORD_RESET")).orderBy(desc(authTokens.createdAt)).limit(1);
    expect(stored?.tokenHash).not.toBe(token);

    await accounts.resetPassword({ token, password: "new password!" }, meta);
    expect(await validateSessionToken(old.token)).toBeNull();
    await expectAppError(accounts.resetPassword({ token, password: "again again" }, meta), "VALIDATION");
    await expectAppError(accounts.signIn({ email, password: "old password" }, meta), "UNAUTHORIZED");
    await expect(accounts.signIn({ email, password: "new password!" }, meta)).resolves.toHaveProperty("session");
  });
});

describe("due-date reminders", () => {
  it("notifies assignees once when a card becomes due within 24 hours", async () => {
    const f = await setupStudio();
    const soon = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    const later = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const dueSoon = await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title: "Due soon", dueAt: soon, assigneeIds: [f.member.id] });
    await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title: "Due later", dueAt: later, assigneeIds: [f.member.id] });
    pinClock(null);
    await runDueDateReminders();
    await runDueDateReminders();
    const sent = await db.select().from(notifications).where(and(eq(notifications.userId, f.member.id), eq(notifications.type, "DUE_SOON")));
    expect(sent.map((n) => n.cardId)).toEqual([dueSoon.id]);
  });
});
