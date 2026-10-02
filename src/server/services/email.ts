import { and, asc, eq, lt } from "drizzle-orm";
import nodemailer, { type Transporter } from "nodemailer";
import { now } from "../clock";
import { db, type Executor } from "../db";
import { emailOutbox } from "../db/schema";
import { env } from "../env";

export interface EmailMessage {
  to: string;
  subject: string;
  template: string;
  /** Plain-text paragraphs; escaped when rendered to HTML. */
  lines: string[];
  action?: { label: string; url: string };
}

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
export async function sendEmail(ex: Executor, message: EmailMessage) {
  const deliverable = Boolean(emailSender());
  await ex.insert(emailOutbox).values({
    to: message.to,
    subject: message.subject,
    template: message.template,
    textBody: renderText(message),
    htmlBody: renderHtml(message),
    status: deliverable ? "QUEUED" : "LOGGED",
    createdAt: now(),
  });
  if (deliverable) {
    setTimeout(() => void deliverOutbox().catch((error) => console.error("[forge] email delivery failed", error)), 200);
  } else if (env.NODE_ENV !== "test") {
    console.log(`\n\x1b[36m[email]\x1b[0m to ${message.to} — ${message.subject}${message.action ? `\n        ${message.action.url}` : ""}\n`);
  }
}

export async function deliverOutbox() {
  const send = emailSender();
  if (!send) return;
  const pending = await db
    .select()
    .from(emailOutbox)
    .where(and(eq(emailOutbox.status, "QUEUED"), lt(emailOutbox.attempts, 5)))
    .orderBy(asc(emailOutbox.createdAt))
    .limit(20);
  for (const email of pending) {
    try {
      await send({ id: email.id, to: email.to, subject: email.subject, text: email.textBody, html: email.htmlBody });
      await db.update(emailOutbox).set({ status: "SENT", sentAt: now(), attempts: email.attempts + 1 }).where(eq(emailOutbox.id, email.id));
    } catch (error) {
      const attempts = email.attempts + 1;
      await db
        .update(emailOutbox)
        .set({ attempts, status: attempts >= 5 ? "FAILED" : "QUEUED", error: String(error).slice(0, 500) })
        .where(eq(emailOutbox.id, email.id));
    }
  }
}

export async function listOutbox(limit = 50) {
  return db.select().from(emailOutbox).orderBy(emailOutbox.createdAt).limit(limit);
}
