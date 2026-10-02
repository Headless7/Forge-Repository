import { desc } from "drizzle-orm";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { db } from "@/server/db";
import { emailOutbox } from "@/server/db/schema";
import { getSession } from "@/server/auth/current";
import { safeEqual } from "@/server/auth/crypto";
import { env } from "@/server/env";

export const metadata = { title: "Dev outbox" };
export const dynamic = "force-dynamic";

function linkify(text: string) {
  return text.split(/(https?:\/\/\S+)/g).map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a key={i} href={part} className="break-all text-accent underline">
        {part}
      </a>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

/**
 * Development-only view of emails the app would have sent (invitations, resets,
 * verification). It contains live reset links and the dev server also listens on
 * the LAN, and the Host header is chosen by the client, so it also needs either a
 * signed-in user or the key `npm run dev` prints in its terminal (DEV_OUTBOX_KEY).
 */
export default async function DevOutboxPage({ searchParams }: { searchParams: Promise<{ key?: string | string[] }> }) {
  if (env.NODE_ENV === "production") notFound();
  const host = ((await headers()).get("host") ?? "").split(":")[0];
  if (!["localhost", "127.0.0.1", "[::1]"].includes(host ?? "")) notFound();
  const { key } = await searchParams;
  const keyOk = Boolean(env.DEV_OUTBOX_KEY) && typeof key === "string" && safeEqual(key, env.DEV_OUTBOX_KEY!);
  if (!keyOk && !(await getSession())) notFound();
  const emails = await db.select().from(emailOutbox).orderBy(desc(emailOutbox.createdAt)).limit(50);
  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-xl font-semibold">Dev outbox</h1>
      <p className="mt-1 text-[13px] text-fg-muted">
        Emails are recorded here because no <code className="rounded bg-surface-3 px-1">SMTP_URL</code> is configured. Links work as in a real inbox.
      </p>
      <div className="mt-6 grid gap-3">
        {emails.length === 0 ? <p className="text-[13px] text-fg-muted">No emails yet.</p> : null}
        {emails.map((email) => (
          <article key={email.id} className="rounded-lg border border-border-strong bg-surface-2 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-medium">{email.subject}</h2>
              <time className="text-xs text-fg-subtle">{email.createdAt.toLocaleString()}</time>
            </div>
            <p className="mt-0.5 text-xs text-fg-muted">
              To {email.to} · {email.template} · {email.status.toLowerCase()}
            </p>
            <pre className="mt-3 whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-fg">{linkify(email.textBody)}</pre>
          </article>
        ))}
      </div>
    </main>
  );
}
