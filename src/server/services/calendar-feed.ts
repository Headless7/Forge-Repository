/**
 * Private calendar subscriptions (ICS). A person gets one secret link that calendar apps (Google,
 * Apple, Outlook) poll without signing in. Only a hash of its token is stored; regenerating
 * replaces the link and revokes the old one. Every fetch rebuilds the feed from the person's
 * current access, so work they lose access to — or that is archived — disappears from it.
 */
import { eq } from "drizzle-orm";
import { generateToken, hashToken } from "../auth/crypto";
import { now } from "../clock";
import { db } from "../db";
import { calendarFeeds } from "../db/schema";
import { appOrigin } from "../env";
import type { Actor } from "./context";
import { personalSchedule } from "./schedule";

const DAY = 86_400_000;

export async function getCalendarFeed(actor: Actor) {
  const [row] = await db.select().from(calendarFeeds).where(eq(calendarFeeds.userId, actor.userId));
  return { active: Boolean(row), createdAt: row?.createdAt.toISOString() ?? null, lastUsedAt: row?.lastUsedAt?.toISOString() ?? null };
}

/** Creates (or replaces) the person's link. The URL is shown once; it can't be read back later. */
export async function createCalendarFeed(actor: Actor) {
  const token = generateToken(32);
  await db
    .insert(calendarFeeds)
    .values({ userId: actor.userId, tokenHash: hashToken(token) })
    .onConflictDoUpdate({ target: calendarFeeds.userId, set: { tokenHash: hashToken(token), createdAt: now(), lastUsedAt: null } });
  return { url: `${appOrigin()}/api/calendar/${token}.ics`, ...(await getCalendarFeed(actor)) };
}

export async function revokeCalendarFeed(actor: Actor) {
  await db.delete(calendarFeeds).where(eq(calendarFeeds.userId, actor.userId));
  return getCalendarFeed(actor);
}

// ── ICS (RFC 5545) ──────────────────────────────────────────────────────────

function escapeText(value: string) {
  // Any line break (a lone CR too) becomes "\n": raw ones would start a new property in the feed.
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
}

/** Folds a content line at 75 octets (continuation lines start with a space). */
function fold(line: string) {
  const out: string[] = [];
  let current = "";
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch);
    if (bytes + size > (out.length ? 74 : 75)) {
      out.push(current);
      current = "";
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join("\r\n ");
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const dateOnly = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");

interface CalendarEvent {
  uid: string;
  summary: string;
  description: string;
  url: string;
  /** A deadline (timed) or a milestone (all-day). */
  at: Date;
  allDay?: boolean;
}

export function renderCalendar(events: CalendarEvent[], generatedAt: Date): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Forge//Studio deadlines//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Forge — my work", "X-PUBLISHED-TTL:PT1H", "REFRESH-INTERVAL;VALUE=DURATION:PT1H"];
  for (const e of events) {
    lines.push("BEGIN:VEVENT", `UID:${e.uid}`, `DTSTAMP:${stamp(generatedAt)}`);
    if (e.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${dateOnly(e.at)}`, `DTEND;VALUE=DATE:${dateOnly(new Date(e.at.getTime() + DAY))}`);
    } else {
      lines.push(`DTSTART:${stamp(e.at)}`, `DTEND:${stamp(new Date(e.at.getTime() + 15 * 60_000))}`);
    }
    lines.push(`SUMMARY:${escapeText(e.summary)}`, `DESCRIPTION:${escapeText(e.description)}`, `URL:${e.url}`, "TRANSP:TRANSPARENT", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

/**
 * The feed behind a token, or null when the token isn't (or no longer is) valid. Deadlines of the
 * person's unfinished work (cards they're assigned to; deliverables they're responsible for,
 * contribute to or review) from a month ago to a year ahead, plus their projects' milestones.
 */
export async function calendarFeedFor(token: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const [feed] = await db.select().from(calendarFeeds).where(eq(calendarFeeds.tokenHash, hashToken(token)));
  if (!feed) return null;
  const at = now();
  await db.update(calendarFeeds).set({ lastUsedAt: at }).where(eq(calendarFeeds.id, feed.id));
  const schedule = await personalSchedule(feed.userId, new Date(at.getTime() - 30 * DAY).toISOString(), new Date(at.getTime() + 365 * DAY).toISOString());
  const origin = appOrigin();
  const events: CalendarEvent[] = [];
  for (const card of schedule.cards) {
    const link = `${origin}/${card.project.studioSlug}/${card.project.slug}/b/${card.board.number}?card=${encodeURIComponent(card.key)}`;
    const assigned = card.assigneeIds.includes(feed.userId);
    if (assigned && card.dueAt && card.state !== "APPROVED") {
      events.push({ uid: `card-${card.id}-due@forge`, summary: `${card.key} ${card.title} — due`, description: `${card.project.name} · ${card.board.name}\n${link}`, url: link, at: new Date(card.dueAt) });
    }
    for (const d of card.deliverables) {
      if (!d.mine || !d.dueAt || d.state === "APPROVED") continue;
      // A deliverable following the card's deadline is already covered by the card's event.
      if (assigned && !d.ownDueAt && card.dueAt) continue;
      const url = `${link}&d=${d.number}`;
      events.push({ uid: `deliverable-${d.id}-due@forge`, summary: `${card.key} · D${d.number} ${d.name} — due`, description: `${card.title}\n${card.project.name} · ${card.board.name}\n${url}`, url, at: new Date(d.dueAt) });
    }
  }
  for (const m of schedule.milestones) {
    if (m.released) continue;
    const url = `${origin}/${m.project.studioSlug}/${m.project.slug}`;
    events.push({ uid: `milestone-${m.id}@forge`, summary: `${m.project.icon} ${m.project.name}: ${m.name}`, description: "Milestone", url, at: new Date(m.dueAt), allDay: true });
  }
  return renderCalendar(events, at);
}
