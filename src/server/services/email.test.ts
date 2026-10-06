import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/server/db";
import { emailOutbox } from "@/server/db/schema";
import { deliverOutbox, scrubExpiredOutboxLinks } from "./email";

// The environment is read lazily, so this applies before the email service first looks at it.
vi.hoisted(() => {
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.EMAIL_FROM = "Forge <noreply@test.dev>";
});

const resendApi = vi.fn<(url: string, init: RequestInit) => Response>();
vi.stubGlobal("fetch", (url: string, init: RequestInit) => Promise.resolve(resendApi(url, init)));

async function queue(to: string, template = "verify-email", extra: Partial<typeof emailOutbox.$inferInsert> = {}) {
  const [row] = await db
    .insert(emailOutbox)
    .values({ to, subject: "Confirm your email for Forge", template, textBody: "text", htmlBody: "<p>html</p>", status: "QUEUED", ...extra })
    .returning();
  return row!;
}

const stored = async (id: string) => (await db.select().from(emailOutbox).where(eq(emailOutbox.id, id)))[0]!;

describe("email delivery through Resend's HTTPS API", () => {
  beforeEach(() => resendApi.mockReset());

  it("posts the queued email and marks it sent", async () => {
    resendApi.mockReturnValue(new Response(JSON.stringify({ id: "resend-id" }), { status: 200 }));
    const row = await queue("first@test.dev");
    await deliverOutbox();

    const [url, init] = resendApi.mock.calls.find(([, i]) => JSON.parse(String(i.body)).to[0] === "first@test.dev")!;
    expect(url).toBe("https://api.resend.com/emails");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer re_test_key");
    expect(headers.get("idempotency-key")).toBe(row.id);
    expect(JSON.parse(String(init.body))).toMatchObject({ from: "Forge <noreply@test.dev>", to: ["first@test.dev"], subject: "Confirm your email for Forge", html: "<p>html</p>" });
    expect(await stored(row.id)).toMatchObject({ status: "SENT", attempts: 1 });
  });

  it("keeps no copy of one-time links once sent, or once they've expired", async () => {
    resendApi.mockReturnValue(new Response(JSON.stringify({ id: "resend-id" }), { status: 200 }));
    const reset = await queue("reset@test.dev", "password-reset");
    const note = await queue("note@test.dev", "notification");
    await deliverOutbox();
    expect((await stored(reset.id)).textBody).not.toBe("text");
    expect((await stored(reset.id)).htmlBody).not.toContain("html");
    // Ordinary notifications keep their text.
    expect((await stored(note.id)).textBody).toBe("text");

    // Never sent (no email service at the time) and older than any link stays valid.
    const old = await queue("old@test.dev", "invitation", { status: "LOGGED", createdAt: new Date(Date.now() - 9 * 86_400_000) });
    const recent = await queue("recent@test.dev", "invitation", { status: "LOGGED" });
    await scrubExpiredOutboxLinks();
    expect((await stored(old.id)).textBody).not.toBe("text");
    expect((await stored(recent.id)).textBody).toBe("text");
  });

  it("keeps a rejected email queued with Resend's reason, for the next attempt", async () => {
    resendApi.mockReturnValue(new Response(JSON.stringify({ message: "The forgedev.app domain is not verified." }), { status: 403 }));
    const row = await queue("second@test.dev");
    await deliverOutbox();

    const after = await stored(row.id);
    expect(after).toMatchObject({ status: "QUEUED", attempts: 1 });
    expect(after.error).toContain("Resend API 403");
    expect(after.error).toContain("domain is not verified");
  });
});
