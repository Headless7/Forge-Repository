/**
 * Builds Discord messages for team feeds. Pure (no I/O) so it can be tested directly.
 *
 * Messages say who did what and link back to Forge; they never include comment or feedback text
 * or files. Mentions are always disabled: a card title like "@everyone" must never ping anyone.
 */
import { DISCORD_EVENT_META, type DiscordEventType } from "@/lib/discord";

export interface DiscordEmbed {
  /** The small line above the title. */
  author?: { name: string };
  title?: string;
  url?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  timestamp?: string;
}

export interface DiscordMessage {
  content?: string;
  embeds: DiscordEmbed[];
  components: Array<{ type: 1; components: Array<{ type: 2; style: 5; label: string; url: string }> }>;
  allowed_mentions: { parse: [] };
}

/** Feed colours (Discord wants an integer), matching the app's review and production colours. */
export const DISCORD_COLORS: Record<DiscordEventType | "TEST", number> = {
  REVIEW_SUBMITTED: 0xf5a524,
  CHANGES_REQUESTED: 0xf0524f,
  APPROVED: 0x2ec27e,
  COMPLETED: 0x22c3b6,
  PUBLISHED: 0xb58cff,
  DUE_DIGEST: 0x94a3b8,
  TEST: 0x7c6cf2,
};

/** Escapes Discord markdown in text people typed (names, titles) so it shows as written. */
export function escapeMarkdown(text: string): string {
  return text.replace(/([\\*_~`|>#[\]()-])/g, "\\$1").replace(/@/g, "@\u200b");
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function buildDiscordMessage(input: {
  type: DiscordEventType | "TEST";
  /** Plain text (escaped here). */
  title: string;
  url: string;
  /** Already-escaped markdown (use `escapeMarkdown` for anything people typed). */
  description: string;
  /** Plain text, e.g. "Project · Board". */
  footer: string;
  timestamp?: string;
  buttonLabel?: string;
  /** Overrides the event's colour (direct messages use their own). */
  color?: number;
  /** A short label above the title ("📥 Review requested"). */
  author?: string;
  /** Small facts shown under the description (markdown values). */
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
}): DiscordMessage {
  return {
    embeds: [
      {
        ...(input.author ? { author: { name: truncate(input.author, 256) } } : {}),
        title: truncate(input.title, 256),
        url: input.url,
        description: truncate(input.description, 4000),
        color: input.color ?? DISCORD_COLORS[input.type],
        ...(input.fields?.length ? { fields: input.fields.slice(0, 25).map((f) => ({ name: truncate(f.name, 256), value: truncate(f.value, 1024), ...(f.inline ? { inline: true } : {}) })) } : {}),
        footer: { text: truncate(input.footer, 2048) },
        ...(input.timestamp ? { timestamp: input.timestamp } : {}),
      },
    ],
    components: [{ type: 1, components: [{ type: 2, style: 5, label: input.buttonLabel ?? "Open in Forge", url: input.url }] }],
    allowed_mentions: { parse: [] },
  };
}

/** One line per event: "**Lena Fischer** approved **V3** of Rig". */
export function eventSummary(input: {
  type: Exclude<DiscordEventType, "DUE_DIGEST">;
  actor: string | null;
  versionNumber?: number | null;
  /** Only on cards with several deliverables. */
  deliverable?: string | null;
  resubmission?: boolean;
}): string {
  const who = input.actor ? `**${escapeMarkdown(input.actor)}**` : "Someone";
  const version = input.versionNumber ? `**V${input.versionNumber}**` : null;
  const what = input.deliverable ? escapeMarkdown(input.deliverable) : null;
  const subject = [version, what].filter(Boolean).join(" of ") || (input.type === "COMPLETED" || input.type === "PUBLISHED" ? "the card" : "the work");
  switch (input.type) {
    case "REVIEW_SUBMITTED":
      return `${who} ${input.resubmission ? "resubmitted" : "submitted"} ${subject} for review.`;
    case "CHANGES_REQUESTED":
      return `${who} requested changes on ${subject}.`;
    case "APPROVED":
      return `${who} approved ${subject}.`;
    case "COMPLETED":
      return `${who} marked the card **Completed**.`;
    case "PUBLISHED":
      return `${who} marked the card **Published**.`;
  }
}

/** The label above a feed post's title: "📥 Submitted for review". */
export function feedLabel(type: DiscordEventType, resubmission = false): string {
  const meta = DISCORD_EVENT_META[type];
  return `${meta.emoji} ${type === "REVIEW_SUBMITTED" && resubmission ? "Resubmitted for review" : type === "DUE_DIGEST" ? "Daily deadlines" : meta.label}`;
}

/** A feed post's button names the next step. */
export function feedButton(type: DiscordEventType): string {
  return type === "REVIEW_SUBMITTED" ? "Review in Forge" : type === "CHANGES_REQUESTED" ? "See feedback" : type === "DUE_DIGEST" ? "Open the project" : "Open card";
}

/** People's names for a post (escaped, never pings): "Lena Fischer, James Walker +2". */
export function nameList(names: string[], max = 3): string {
  const shown = names.slice(0, max).map(escapeMarkdown).join(", ");
  return names.length > max ? `${shown} +${names.length - max}` : shown;
}

// ── Direct messages ─────────────────────────────────────────────────────────────────────────

/** How each kind of direct message looks: the label above the title, its colour and its button. */
export const DM_STYLES: Record<string, { label: string; color: number; button: string }> = {
  ASSIGNED: { label: "👤 Assigned to you", color: 0x7c6cf2, button: "Open card" },
  REVIEWER_ASSIGNED: { label: "🔍 You're the reviewer", color: 0x7c6cf2, button: "Open card" },
  REVIEW_REQUESTED: { label: "📥 Review requested", color: 0xf5a524, button: "Review in Forge" },
  CHANGES_REQUESTED: { label: "🔁 Changes requested", color: 0xf0524f, button: "See feedback" },
  APPROVED: { label: "✅ Approved", color: 0x2ec27e, button: "Open card" },
  UNBLOCKED: { label: "🟢 Ready to start", color: 0x2ec27e, button: "Open card" },
  BLOCKED: { label: "⛔ Waiting again", color: 0xf0524f, button: "Open card" },
  MENTIONED: { label: "💬 You were mentioned", color: 0x5b8def, button: "Open comment" },
  REPLY: { label: "↩️ New reply", color: 0x5b8def, button: "Open comment" },
  DUE_SOON: { label: "⏰ Due soon", color: 0xf5a524, button: "Open card" },
  OVERDUE: { label: "🚨 Overdue", color: 0xf0524f, button: "Open card" },
};
export const DM_DEFAULT_STYLE = { label: "🔔 Forge", color: 0x7c6cf2, button: "Open in Forge" };

/** Discord shows <t:…> in each reader's own time zone: "in 5 hours" (R) or a full date (f). */
export function discordTime(iso: string | null | undefined, style: "R" | "f"): string | null {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? `<t:${Math.floor(ms / 1000)}:${style}>` : null;
}

/**
 * The sentence of a direct message. The card is the message's title, so this says what happened
 * without repeating it: "**James Walker** submitted **V2** of **Rig** for your review."
 */
export function dmSentence(type: string, data: Record<string, unknown>, actor: string | null): string {
  const text = (v: unknown) => (typeof v === "string" && v ? v : null);
  const who = actor ? `**${escapeMarkdown(actor)}**` : "Someone";
  const deliverable = text(data.deliverable) ? `**${escapeMarkdown(text(data.deliverable)!)}**` : null;
  const version = typeof data.versionNumber === "number" && data.versionNumber > 0 ? `**V${data.versionNumber}**` : null;
  const target = deliverable ?? "this card";
  const work = [version, deliverable].filter(Boolean).join(" of ") || target;
  const due = (prefix: string) => {
    const relative = discordTime(text(data.dueAt), "R");
    return relative ? `${prefix} ${relative} (${discordTime(text(data.dueAt), "f")}).` : null;
  };
  switch (type) {
    case "ASSIGNED": {
      const role = data.role === "contributor" ? "a contributor to" : data.role === "reviewer" ? "the reviewer of" : "responsible for";
      return `${who} made you ${role} ${target}.`;
    }
    case "REVIEWER_ASSIGNED":
      return `${who} made you the reviewer of ${target}.`;
    case "REVIEW_REQUESTED":
      return `${who} ${data.resubmission ? "resubmitted" : "submitted"} ${work} for your review.`;
    case "CHANGES_REQUESTED":
      return `${who} requested changes on ${work}.`;
    case "APPROVED":
      return `${who} approved ${work}.`;
    case "UNBLOCKED":
      return `Everything ${target} waits on is approved, so it's ready to start.`;
    case "BLOCKED":
      return `${deliverable ?? "This card"} is waiting again: ${text(data.prerequisite) ? `**${escapeMarkdown(text(data.prerequisite)!)}**` : "a prerequisite"} is no longer approved.`;
    case "MENTIONED":
      return `${who} mentioned you in a comment.`;
    case "REPLY":
      return `${who} replied to you.`;
    case "DUE_SOON":
      return due("Due") ?? "Due soon.";
    case "OVERDUE":
      return due("Was due") ?? "Overdue.";
    default:
      return `${who} updated ${target}.`;
  }
}
