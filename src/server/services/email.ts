import { and, asc, eq, inArray, lt, lte, ne, sql } from "drizzle-orm";
import nodemailer, { type Transporter } from "nodemailer";
import { now } from "../clock";
import { accessibleProjectIds } from "../access";
import { db, type Executor } from "../db";
import { emailOutbox } from "../db/schema";
import { env } from "../env";
import type { NotificationType } from "@/lib/notifications";

export interface EmailMessage {
  to: string;
  subject: string;
  template: string;
  /** Plain-text paragraphs; escaped when rendered to HTML. */
  lines: string[];
  action?: { label: string; url: string };
}

/**
 * Emails whose link is a credential (password reset, address confirmation, invitation). Tokens are
 * stored hashed so a database leak can't use them, so once sent (or too old to matter) the outbox
 * keeps no copy of these emails' text either.
 */
const ONE_TIME_LINK_TEMPLATES = ["password-reset", "verify-email", "invitation"];
const REMOVED_BODY = "(Removed after sending: this email contained a one-time link.)";
/** Longer than any of those links stays valid (invitations: 7 days). */
const ONE_TIME_LINK_RETENTION_MS = 8 * 24 * 60 * 60 * 1000;

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

function renderHtml(message: EmailMessage): string {
  const paragraphs = message.lines
    .map((line) => `<p style="margin:0 0 14px;color:#c9ccd3;font-size:14px;line-height:1.6">${escapeHtml(line)}</p>`)
    .join("");
  const button = message.action
    ? `<p style="margin:22px 0"><a href="${escapeHtml(message.action.url)}" style="background:#7c6cf2;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px">${escapeHtml(message.action.label)}</a></p>
       <p style="margin:0;color:#7d828d;font-size:12px">Or paste this link into your browser:<br>${escapeHtml(message.action.url)}</p>`
    : "";
  return `<!doctype html><html><body style="margin:0;background:#0e0f12;font-family:Segoe UI,Helvetica,Arial,sans-serif">
  <div style="max-width:520px;margin:0 auto;padding:32px 24px">
    <div style="color:#fff;font-weight:700;font-size:16px;margin-bottom:20px">◆ Forge</div>
    <div style="background:#17191e;border:1px solid #2a2e36;border-radius:10px;padding:24px">
      <h1 style="margin:0 0 16px;color:#fff;font-size:18px">${escapeHtml(message.subject)}</h1>
      ${paragraphs}${button}
    </div>
  </div></body></html>`;
}

function renderText(message: EmailMessage): string {
  return [...message.lines, ...(message.action ? ["", `${message.action.label}: ${message.action.url}`] : [])].join("\n\n");
}

interface OutgoingMail {
  /** Outbox row id: a retry after an unrecorded success must not send twice. */
  id: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}
type Sender = (mail: OutgoingMail) => Promise<void>;

/** Resend's HTTPS API: works where outbound SMTP is blocked (e.g. Railway below the Pro plan). */
function resendSender(apiKey: string): Sender {
  return async (mail) => {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "idempotency-key": mail.id },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Resend API ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  };
}

function smtpSender(transport: Transporter): Sender {
  return async (mail) => {
    await transport.sendMail({ from: env.EMAIL_FROM, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html });
  };
}

let sender: Sender | null | undefined;
function emailSender(): Sender | null {
  if (sender !== undefined) return sender;
  sender = env.RESEND_API_KEY ? resendSender(env.RESEND_API_KEY) : env.SMTP_URL ? smtpSender(nodemailer.createTransport(env.SMTP_URL)) : null;
  return sender;
}

/**
 * Records the email in the outbox inside the caller's transaction, so emails are
 * only sent for work that actually committed. Delivery happens right after.
 */
/** Whether real email can be sent (otherwise emails are only recorded/logged). */
export function emailDeliveryConfigured(): boolean {
  return Boolean(emailSender());
}

/**
 * `about`: for notification emails, whose they are and which project — re-checked when sending,
 * so someone who lost access in the meantime isn't emailed.
 */
export async function sendEmail(ex: Executor, message: EmailMessage, about: { userId?: string | null; projectId?: string | null; notificationId?: string | null } = {}) {
  const deliverable = Boolean(emailSender());
  await ex.insert(emailOutbox).values({
    userId: about.userId ?? null,
    projectId: about.projectId ?? null,
    notificationId: about.notificationId ?? null,
    to: message.to,
    subject: message.subject,
    template: message.template,
    textBody: renderText(message),
    htmlBody: renderHtml(message),
    status: deliverable ? "QUEUED" : "LOGGED",
    createdAt: now(),
  });
  if (deliverable) {
    // Shortly after the caller commits (the per-minute job picks up anything this misses). Tests
    // deliver explicitly so they control the timing.
    if (env.NODE_ENV !== "test") setTimeout(() => void deliverOutbox().catch((error) => console.error("[forge] email delivery failed", error)), 200);
  } else if (env.NODE_ENV === "production") {
    // No email service: links can be credentials, so they aren't written to the server's logs.
    console.warn(`[email] not sent (no email service configured): ${message.template} to ${message.to}`);
  } else if (env.NODE_ENV !== "test") {
    console.log(`\n\x1b[36m[email]\x1b[0m to ${message.to} — ${message.subject}${message.action ? `\n        ${message.action.url}` : ""}\n`);
  }
}

/** Retries back off: 1 min, 5 min, 15 min, 1 h, 3 h, 6 h, 12 h, then give up after ~1 day. */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 3 * 60 * 60_000, 6 * 60 * 60_000, 12 * 60 * 60_000];
export const MAX_EMAIL_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

/**
 * Sends due outbox emails. Each row is claimed before sending (several workers can run this at
 * once), uses the row id as the provider's idempotency key, and retries with backoff on failure.
 */
export async function deliverOutbox() {
  const send = emailSender();
  if (!send) return;
  const pending = await db
    .select()
    .from(emailOutbox)
    .where(and(eq(emailOutbox.status, "QUEUED"), lte(emailOutbox.nextAttemptAt, sql`now()`)))
    .orderBy(asc(emailOutbox.createdAt))
    .limit(20);
  for (const email of pending) {
    // Claim: push the next attempt out so a concurrent worker skips this row.
    const [claimed] = await db
      .update(emailOutbox)
      .set({ nextAttemptAt: new Date(now().getTime() + 2 * 60_000) })
      .where(and(eq(emailOutbox.id, email.id), eq(emailOutbox.status, "QUEUED"), lte(emailOutbox.nextAttemptAt, sql`now()`)))
      .returning({ id: emailOutbox.id });
    if (!claimed) continue;
    if (email.userId && email.projectId && !(await accessibleProjectIds(email.userId)).has(email.projectId)) {
      await db.update(emailOutbox).set({ status: "SKIPPED", error: "Recipient no longer has access." }).where(eq(emailOutbox.id, email.id));
      continue;
    }
    if (email.notificationId) {
      // Like device notifications: not for archived work, and not if the person switched emails for this type off.
      const { channelEnabled, notificationStillDeliverable } = await import("./notifications");
      const n = await notificationStillDeliverable(db, email.notificationId);
      const reason = !n ? "The work was archived or removed, or access was lost." : !(await channelEnabled(db, n.userId, n.type as NotificationType, "EMAIL")) ? "Emails for this type were switched off." : null;
      if (reason) {
        await db.update(emailOutbox).set({ status: "SKIPPED", error: reason }).where(eq(emailOutbox.id, email.id));
        continue;
      }
    }
    try {
      await send({ id: email.id, to: email.to, subject: email.subject, text: email.textBody, html: email.htmlBody });
      const removed = ONE_TIME_LINK_TEMPLATES.includes(email.template) ? { textBody: REMOVED_BODY, htmlBody: REMOVED_BODY } : {};
      await db.update(emailOutbox).set({ status: "SENT", sentAt: now(), attempts: email.attempts + 1, ...removed }).where(eq(emailOutbox.id, email.id));
    } catch (error) {
      const attempts = email.attempts + 1;
      const delay = RETRY_DELAYS_MS[attempts - 1];
      await db
        .update(emailOutbox)
        .set({
          attempts,
          status: delay === undefined ? "FAILED" : "QUEUED",
          nextAttemptAt: new Date(now().getTime() + (delay ?? 0)),
          error: String(error).slice(0, 500),
        })
        .where(eq(emailOutbox.id, email.id));
    }
  }
}

/** Removes the text of one-time-link emails that were never sent (or failed) once their links have expired. Hourly. */
export async function scrubExpiredOutboxLinks() {
  const rows = await db
    .update(emailOutbox)
    .set({ textBody: REMOVED_BODY, htmlBody: REMOVED_BODY })
    .where(
      and(
        inArray(emailOutbox.template, ONE_TIME_LINK_TEMPLATES),
        lt(emailOutbox.createdAt, new Date(now().getTime() - ONE_TIME_LINK_RETENTION_MS)),
        ne(emailOutbox.textBody, REMOVED_BODY),
      ),
    )
    .returning({ id: emailOutbox.id });
  return rows.length;
}

export async function listOutbox(limit = 50) {
  return db.select().from(emailOutbox).orderBy(emailOutbox.createdAt).limit(limit);
}
