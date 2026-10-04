/**
 * Builds Discord messages for team feeds. Pure (no I/O) so it can be tested directly.
 *
 * Messages say who did what and link back to Forge; they never include comment or feedback text
 * or files. Mentions are always disabled: a card title like "@everyone" must never ping anyone.
 */
import type { DiscordEventType } from "@/lib/discord";

export interface DiscordEmbed {
  title?: string;
  url?: string;
  description?: string;
  color?: number;
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
}): DiscordMessage {
  return {
    embeds: [
      {
        title: truncate(input.title, 256),
        url: input.url,
        description: truncate(input.description, 4000),
        color: DISCORD_COLORS[input.type],
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
      return `${who} marked it **Completed**, recording the approved revisions.`;
    case "PUBLISHED":
      return `${who} marked it **Published**. (Forge tracks releases; it doesn't deploy anything.)`;
  }
}
