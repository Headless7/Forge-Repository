/**
 * Discord slash commands: /mywork, /reviews, /card, /due and /newcard. Each runs as the Forge account
 * the person linked with "Connect Discord", with exactly the access and permissions they have in
 * Forge, and every reply is visible only to them. Actions (approve, request changes, submit for
 * review, mark completed or published, create a card) go through the same services as the app; the
 * one-click ones ask to confirm first, and every click is checked again.
 *
 * Replies use Discord's layout components: a coloured panel with a heading, rows grouped by what
 * needs doing and a View button on each. Like feeds and direct messages they carry names, states
 * and links, never files.
 */
import "server-only";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { roleHas } from "@/lib/permissions";
import type { CardDetailDTO, CardState, ChecklistItemDTO, MemberDTO, Priority, ProductionStatus } from "@/lib/types";
import { accessibleProjectIds, getProjectAccess, requireCard, requireDeliverable, type ProjectAccess } from "../access";
import { db } from "../db";
import { assetVersions, boardColumns, boards, cardReviewers, cards, checklistItems, checklists, deliverables, discordConnections, oauthAccounts, studioMembers, studios, users } from "../db/schema";
import { appOrigin, env } from "../env";
import { AppError } from "../errors";
import { enforceRateLimit } from "../rate-limit";
import { loadCardDetail } from "./card-dto";
import { createCard } from "./cards";
import { addChecklistItems, canTickItem, checklistAssignees, updateChecklistItem } from "./checklists";
import type { Actor } from "./context";
import { discordApi, discordConfigured } from "./discord";
import { discordTime, escapeMarkdown, truncate } from "./discord-message";
import { myChecklistItems, myDeliverables, type BoardRef, type MyChecklistItem, type MyDeliverableItem } from "./home";
import { listProjectMembers } from "./members-query";
import { moveProduction } from "./production";
import { approve, requestChanges, submitForReview } from "./reviews";
import { loadSchedule } from "./schedule";
import { searchCards } from "./search";

// ── Commands ────────────────────────────────────────────────────────────────────────────────

/** Usable in servers the bot is in and in the bot's direct messages (guild-installed app). */
const EVERYWHERE = { contexts: [0, 1], integration_types: [0] };
const PRIORITY_CHOICES = [
  { name: "Low", value: "LOW" },
  { name: "Normal", value: "NORMAL" },
  { name: "High", value: "HIGH" },
  { name: "Urgent", value: "URGENT" },
];

export const DISCORD_COMMANDS = [
  { name: "mywork", type: 1, description: "See your open work in Forge, overdue first.", ...EVERYWHERE },
  { name: "reviews", type: 1, description: "See work waiting for your review, and approve it or request changes.", ...EVERYWHERE },
  {
    name: "card",
    type: 1,
    description: "Look up a card by key or title, and act on it.",
    ...EVERYWHERE,
    options: [{ type: 3, name: "find", description: "A card key like UTD-4, or words from its title", required: true, autocomplete: true, max_length: 100 }],
  },
  {
    name: "due",
    type: 1,
    description: "See your deadlines coming up, and anything overdue.",
    ...EVERYWHERE,
    options: [
      { type: 4, name: "days", description: "How many days ahead to look (default 3)", required: false, min_value: 1, max_value: 30 },
      { type: 5, name: "team", description: "Show the whole team's deadlines (Managers and above)", required: false },
    ],
  },
  {
    name: "newcard",
    type: 1,
    description: "Create a card in one of your projects.",
    ...EVERYWHERE,
    options: [
      { type: 3, name: "title", description: "What the card is for, e.g. Sword VFX", required: true, max_length: 200 },
      { type: 3, name: "project", description: "Which project it goes in", required: true, autocomplete: true, max_length: 100 },
      { type: 3, name: "column", description: "Which column (default: the first one)", required: false, autocomplete: true, max_length: 100 },
      { type: 3, name: "assign", description: "Who works on it", required: false, autocomplete: true, max_length: 100 },
      { type: 3, name: "due", description: "Deadline, e.g. friday, tomorrow, in 3 days or 2026-10-20", required: false, autocomplete: true, max_length: 40 },
      { type: 3, name: "priority", description: "How urgent it is (default Normal)", required: false, choices: PRIORITY_CHOICES },
      { type: 3, name: "description", description: "Details for whoever picks it up", required: false, max_length: 2000 },
    ],
  },
  {
    name: "additem",
    type: 1,
    description: "Add an item to a card's checklist, with who does it and when it's due.",
    ...EVERYWHERE,
    options: [
      { type: 3, name: "card", description: "Card key or title, e.g. UTD-4", required: true, autocomplete: true, max_length: 100 },
      { type: 3, name: "item", description: "What needs doing", required: true, max_length: 500 },
      { type: 3, name: "assign", description: "Who does it", required: false, autocomplete: true, max_length: 100 },
      { type: 3, name: "due", description: "When it's due, e.g. friday, tomorrow, in 3 days or 2026-10-20", required: false, autocomplete: true, max_length: 40 },
      { type: 3, name: "list", description: "Which checklist (default: the card's first)", required: false, autocomplete: true, max_length: 100 },
    ],
  },
];

interface CommandShape {
  name: string;
  type: number;
  description: string;
  contexts?: number[] | null;
  integration_types?: number[];
  options?: Array<Record<string, unknown>>;
}

/** The parts of a command Forge sets, in a stable form (Discord adds ids and defaults). */
function comparable(command: CommandShape) {
  return JSON.stringify({
    name: command.name,
    type: command.type,
    description: command.description,
    contexts: [...(command.contexts ?? [])].sort(),
    integration_types: [...(command.integration_types ?? [0])].sort(),
    options: (command.options ?? []).map((o) => ({
      type: o.type,
      name: o.name,
      description: o.description,
      required: Boolean(o.required),
      autocomplete: Boolean(o.autocomplete),
      min_value: o.min_value ?? null,
      max_value: o.max_value ?? null,
      max_length: o.max_length ?? null,
      choices: Array.isArray(o.choices) ? (o.choices as Array<{ name: string; value: unknown }>).map((c) => ({ name: c.name, value: c.value })) : null,
    })),
  });
}

/** Registers the commands with Discord when they differ from what's registered (on startup in production). */
export async function syncDiscordCommands(): Promise<"skipped" | "unchanged" | "updated"> {
  if (!discordConfigured()) return "skipped";
  const path = `/applications/${env.DISCORD_APPLICATION_ID}/commands`;
  const current = await discordApi<CommandShape[]>(path);
  if (!current.ok) throw new Error(`Couldn't read the Discord commands (${current.message}).`);
  const have = (current.data ?? []).map(comparable).sort();
  const want = DISCORD_COMMANDS.map(comparable).sort();
  if (have.length === want.length && have.every((c, i) => c === want[i])) return "unchanged";
  const put = await discordApi(path, { method: "PUT", body: DISCORD_COMMANDS });
  if (!put.ok) throw new Error(`Couldn't register the Discord commands (${put.message}).`);
  return "updated";
}

// ── Discord's interaction and layout shapes (the parts Forge reads and writes) ───────────────

export interface Interaction {
  id: string;
  application_id: string;
  type: number;
  guild_id?: string;
  member?: { user?: { id: string } };
  user?: { id: string };
  data?: {
    name?: string;
    options?: Array<{ name: string; type: number; value?: string | number | boolean; focused?: boolean }>;
    custom_id?: string;
    values?: string[];
    components?: Array<{ components?: Array<{ custom_id?: string; value?: string }> }>;
  };
}

type Button = { type: 2; style: 1 | 2 | 3 | 4; label: string; custom_id: string; emoji?: { name: string } } | { type: 2; style: 5; label: string; url: string; emoji?: { name: string } };
type Row = { type: 1; components: Button[] };
type TextDisplay = { type: 10; content: string };
type Separator = { type: 14; divider: boolean; spacing: 1 | 2 };
type Section = { type: 9; components: TextDisplay[]; accessory: Button };
type Container = { type: 17; accent_color: number; components: Array<TextDisplay | Separator | Section | Row> };
export type Block = Container | TextDisplay | Row;

interface Reply {
  components: Block[];
}

export type InteractionResponse =
  | { type: 1 }
  | { type: 4 | 7; data: { components: Block[]; flags: number; allowed_mentions: { parse: [] } } }
  | { type: 8; data: { choices: Array<{ name: string; value: string }> } }
  | { type: 9; data: { custom_id: string; title: string; components: unknown[] } };

const EPHEMERAL = 1 << 6;
/** IS_COMPONENTS_V2: the message is laid out with containers, text and sections. */
const LAYOUT = 1 << 15;

/** A new private message (4) or an update of the message a button was on (7). Mentions never ping. */
function respond(type: 4 | 7, reply: Reply): InteractionResponse {
  return { type, data: { components: reply.components, flags: type === 4 ? EPHEMERAL | LAYOUT : LAYOUT, allowed_mentions: { parse: [] } } };
}

/** Discord's limits for one message laid out this way: 40 components and 4000 characters of text. */
export const LAYOUT_LIMITS = { components: 40, text: 4000 };

export function layoutSize(blocks: unknown[]): { components: number; text: number } {
  let components = 0;
  let text = 0;
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const n = node as { type?: number; content?: string; components?: unknown[]; accessory?: unknown };
    if (typeof n.type === "number") components += 1;
    if (n.type === 10 && typeof n.content === "string") text += n.content.length;
    for (const child of n.components ?? []) walk(child);
    if (n.accessory) walk(n.accessory);
  };
  for (const block of blocks) walk(block);
  return { components, text };
}

const text = (content: string): TextDisplay => ({ type: 10, content });
const divider = (): Separator => ({ type: 14, divider: true, spacing: 1 });
const row = (...buttons: Button[]): Row => ({ type: 1, components: buttons });
const panel = (accent: number, components: Container["components"]): Container => ({ type: 17, accent_color: accent, components });
const link = (label: string, url: string): Button => ({ type: 2, style: 5, label, url });

/** Custom ids must be unique within a message: a second button for the same card gets a suffix. */
function idMaker() {
  const used = new Set<string>();
  return (base: string) => {
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}:${n}`;
    used.add(id);
    return id;
  };
}

// ── Who's asking, and where ─────────────────────────────────────────────────────────────────

const COLORS = { work: 0x7c6cf2, review: 0xf5a524, late: 0xf0524f, done: 0x2ec27e, quiet: 0x94a3b8 };

function problem(message: string): Reply {
  return { components: [panel(COLORS.late, [text(`⚠️ ${escapeMarkdown(message)}`)])] };
}

function notLinked(): Reply {
  return {
    components: [
      panel(COLORS.work, [
        text(
          [
            "## 🔗 Connect Discord to Forge",
            "These commands use your Forge account, so Forge needs to know this Discord account is yours.",
            "1. In Forge, open **Account → Security**",
            "2. Choose **Connect** next to Discord",
            "3. Come back and run the command again",
          ].join("\n"),
        ),
        row(link("Open account settings", `${appOrigin()}/account/security`)),
      ]),
    ],
  };
}

/** The Forge account linked to a Discord user (Account → Security → Connect Discord). */
async function linkedUser(discordUserId: string) {
  const [row] = await db
    .select({ id: users.id })
    .from(oauthAccounts)
    .innerJoin(users, eq(users.id, oauthAccounts.userId))
    .where(and(eq(oauthAccounts.provider, "discord"), eq(oauthAccounts.providerAccountId, discordUserId)))
    .limit(1);
  return row ?? null;
}

interface Scope {
  userId: string;
  studios: Array<{ id: string; slug: string; name: string }>;
  /** Live projects the person can open, with their access. */
  accesses: Map<string, ProjectAccess>;
}

/**
 * The person's studios — in a Discord server connected to some of them, just those — and the
 * projects they can open there.
 */
async function scopeFor(userId: string, guildId: string | undefined): Promise<Scope> {
  const mine = await db
    .select({ id: studios.id, slug: studios.slug, name: studios.name })
    .from(studioMembers)
    .innerJoin(studios, eq(studios.id, studioMembers.studioId))
    .where(eq(studioMembers.userId, userId))
    .orderBy(asc(studios.name));
  let chosen = mine;
  if (guildId) {
    const rows = await db.select({ studioId: discordConnections.studioId }).from(discordConnections).where(and(eq(discordConnections.guildId, guildId), isNull(discordConnections.lostAt)));
    const connected = new Set(rows.map((r) => r.studioId));
    const here = mine.filter((s) => connected.has(s.id));
    if (here.length) chosen = here;
  }
  const accesses = new Map<string, ProjectAccess>();
  for (const studio of chosen) {
    for (const id of await accessibleProjectIds(userId, studio.id)) {
      const access = await getProjectAccess(userId, id);
      if (access && !access.project.archivedAt) accesses.set(id, access);
    }
  }
  return { userId, studios: chosen, accesses };
}

function cardUrl(studioSlug: string, projectSlug: string, boardNumber: number | null | undefined, key: string, deliverableNumber?: number) {
  return `${appOrigin()}/${studioSlug}/${projectSlug}${boardNumber ? `/b/${boardNumber}` : ""}?card=${encodeURIComponent(key)}${deliverableNumber ? `&d=${deliverableNumber}` : ""}`;
}

function studioLine(scope: Scope) {
  return escapeMarkdown(truncate(scope.studios.map((s) => s.name).join(" · ") || "Forge", 120));
}

async function boardRefs(projectIds: string[]) {
  const rows = projectIds.length
    ? await db.select({ id: boards.id, projectId: boards.projectId, number: boards.number, name: boards.name }).from(boards).where(and(inArray(boards.projectId, projectIds), isNull(boards.archivedAt)))
    : [];
  const perProject = new Map<string, number>();
  for (const b of rows) perProject.set(b.projectId, (perProject.get(b.projectId) ?? 0) + 1);
  const byId = new Map(rows.map((b) => [b.id, b]));
  return (boardId: string): BoardRef | null => {
    const b = byId.get(boardId);
    return b ? { number: b.number, name: b.name, shown: (perProject.get(b.projectId) ?? 0) > 1 } : null;
  };
}

const STATE_TEXT: Record<CardState, string> = {
  NOT_SUBMITTED: "not started",
  IN_PROGRESS: "in progress",
  NEEDS_REVIEW: "in review",
  CHANGES_REQUESTED: "changes requested",
  APPROVED: "approved",
};
const STATE_LABEL: Record<CardState, string> = { NOT_SUBMITTED: "Not started", IN_PROGRESS: "In progress", NEEDS_REVIEW: "In review", CHANGES_REQUESTED: "Changes requested", APPROVED: "Approved" };
const STATE_ICON: Record<CardState, string> = { NOT_SUBMITTED: "⚪", IN_PROGRESS: "🛠️", NEEDS_REVIEW: "📥", CHANGES_REQUESTED: "🔁", APPROVED: "✅" };
const PRODUCTION_LABEL: Record<ProductionStatus, string> = { TODO: "To do", COMPLETED: "Completed", PUBLISHED: "Published" };
const PRODUCTION_ICON: Record<ProductionStatus, string> = { TODO: "🗂️", COMPLETED: "🏁", PUBLISHED: "🚀" };
const STATE_COLOR: Record<CardState, number> = { NOT_SUBMITTED: COLORS.quiet, IN_PROGRESS: COLORS.work, NEEDS_REVIEW: COLORS.review, CHANGES_REQUESTED: COLORS.late, APPROVED: COLORS.done };

/** "[UTD-4 · Sword](url)" with whatever people typed escaped (and kept short). */
function cardLink(key: string, title: string, url: string, max = 70) {
  return `[${escapeMarkdown(`${key} · ${truncate(title, max)}`)}](${url})`;
}

/** A deliverable's name, unless it just repeats the card's title (single-deliverable cards). */
function deliverableName(name: string, cardTitle: string) {
  return name.trim().toLowerCase() === cardTitle.trim().toLowerCase() ? null : escapeMarkdown(truncate(name, 60));
}

function dueText(iso: string | null, nowMs: number) {
  if (!iso) return null;
  return `${Date.parse(iso) < nowMs ? "was due" : "due"} ${discordTime(iso, "R")}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One row of a list: the card (linking to Forge), a grey detail line, and a View button. */
function listRow(nextId: (base: string) => string, cardId: string, title: string, detail: string, button: { label: string; style: 1 | 2; verb?: "open" | "list" } = { label: "View", style: 2 }): Section {
  return {
    type: 9,
    components: [text(`**${title}**${detail ? `\n-# ${detail}` : ""}`)],
    accessory: { type: 2, style: button.style, label: button.label, custom_id: nextId(`fg:${button.verb ?? "open"}:${cardId}`) },
  };
}

/** Grouped rows under small headings, at most `max` rows; "…and N more" when they don't all fit. */
function groupedRows<T>(items: T[], groups: Array<{ title: string; test: (item: T) => boolean }>, toRow: (item: T) => Section, max: number) {
  const out: Container["components"] = [];
  let shown = 0;
  const placed = new Set<T>();
  for (const group of groups) {
    const members = items.filter((i) => !placed.has(i) && group.test(i));
    members.forEach((m) => placed.add(m));
    const room = Math.max(0, max - shown);
    if (!members.length || !room) continue;
    out.push(text(`### ${group.title}`));
    for (const item of members.slice(0, room)) out.push(toRow(item));
    shown += Math.min(room, members.length);
  }
  if (items.length > shown) out.push(text(`-# …and ${items.length - shown} more. Open Forge to see everything.`));
  return out;
}

// ── /mywork ─────────────────────────────────────────────────────────────────────────────────

const SOON_MS = 48 * 60 * 60 * 1000;

/** Your checklist items as one compact list (each line links to its card). */
function checklistLines(items: MyChecklistItem[], studioSlugOf: (projectId: string) => string, max = 8) {
  const today = todayDay();
  const lines = items.slice(0, max).map((i) => {
    const url = cardUrl(studioSlugOf(i.project.id), i.project.slug, i.board?.number, i.card.key);
    return `⬜ ${cardLink(i.card.key, i.card.title, url, 40)} — ${escapeMarkdown(truncate(i.text, 60))}${i.dueOn ? ` · ${itemDue(i.dueOn, today)}` : ""}`;
  });
  if (items.length > max) lines.push(`-# …and ${items.length - max} more. Open a card's checklist to tick items off.`);
  else lines.push("-# Open a card's checklist (View → Checklist) to tick items off.");
  return lines.join("\n");
}

export function myWorkView(items: MyDeliverableItem[], scope: Scope, studioSlugOf: (projectId: string) => string, nowMs = Date.now(), checklist: MyChecklistItem[] = []): Reply {
  const home = link("Open Forge", `${appOrigin()}/${scope.studios[0]?.slug ?? ""}`);
  const checklistBlock = checklist.length ? [text("### ☑️ Your checklist items"), text(checklistLines(checklist, studioSlugOf))] : [];
  if (!items.length && checklist.length) {
    return {
      components: [
        panel(COLORS.work, [
          text(`## 🧰 Your work\n-# No open deliverables · ${plural(checklist.length, "checklist item")} · ${studioLine(scope)}`),
          divider(),
          ...checklistBlock,
          divider(),
          row(home),
        ]),
      ],
    };
  }
  if (!items.length) {
    return {
      components: [
        panel(COLORS.done, [
          text(`## 🧰 Your work\nNothing on your plate right now. 🎉\n-# Work you're responsible for or contribute to shows up here · ${studioLine(scope)}`),
          row(home),
        ]),
      ],
    };
  }
  const due = (i: MyDeliverableItem) => (i.dueAt ? Date.parse(i.dueAt) : null);
  const late = (i: MyDeliverableItem) => due(i) !== null && due(i)! < nowMs;
  const overdue = items.filter(late).length;
  const nextId = idMaker();
  const toRow = (i: MyDeliverableItem) => {
    const url = cardUrl(studioSlugOf(i.project.id), i.project.slug, i.board?.number, i.card.key, i.deliverable.number);
    const status = i.waitingOn.length ? `waiting on ${escapeMarkdown(truncate(i.waitingOn.join(", "), 50))}` : STATE_TEXT[i.deliverable.state];
    const detail = [deliverableName(i.deliverable.name, i.card.title), status, dueText(i.dueAt, nowMs)].filter(Boolean).join(" · ");
    return listRow(nextId, i.card.id, cardLink(i.card.key, i.card.title, url), detail);
  };
  const rows = groupedRows(
    items,
    [
      { title: "🚨 Overdue", test: late },
      { title: "🔁 Changes requested", test: (i) => i.deliverable.state === "CHANGES_REQUESTED" },
      { title: "⏰ Due in the next 2 days", test: (i) => due(i) !== null && due(i)! - nowMs < SOON_MS && !i.waitingOn.length && i.deliverable.state !== "NEEDS_REVIEW" },
      { title: "🛠️ To do", test: (i) => !i.waitingOn.length && i.deliverable.state !== "NEEDS_REVIEW" },
      { title: "⛔ Waiting on others", test: (i) => i.waitingOn.length > 0 },
      { title: "📥 In review", test: () => true },
    ],
    toRow,
    8,
  );
  return {
    components: [
      panel(overdue ? COLORS.late : COLORS.work, [
        text(`## 🧰 Your work\n-# ${plural(items.length, "open deliverable")}${overdue ? ` · ${overdue} overdue` : ""}${checklist.length ? ` · ${plural(checklist.length, "checklist item")}` : ""} · ${studioLine(scope)}`),
        divider(),
        ...rows,
        ...checklistBlock,
        divider(),
        row(home),
      ]),
    ],
  };
}

async function myWork(scope: Scope): Promise<Reply> {
  const ids = [...scope.accesses.keys()];
  const projectRef = (id: string) => {
    const a = scope.accesses.get(id)!;
    return { id, slug: a.project.slug, name: a.project.name, icon: a.project.icon, key: a.project.key };
  };
  const boardRef = await boardRefs(ids);
  const items = ids.length ? await myDeliverables(scope.userId, ids, projectRef, boardRef) : [];
  const checklist = ids.length ? await myChecklistItems(scope.userId, ids, projectRef, boardRef, 30) : [];
  return myWorkView(items, scope, (id) => scope.accesses.get(id)!.studioSlug, Date.now(), checklist);
}

// ── /reviews ────────────────────────────────────────────────────────────────────────────────

interface ReviewItem {
  deliverable: { id: string; number: number; name: string };
  card: { id: string; key: string; title: string };
  url: string;
  versionNumber: number | null;
  submittedAt: string | null;
  submittedBy: string | null;
}

export function reviewsView(items: ReviewItem[], scope: Scope): Reply {
  const home = link("Open Forge", `${appOrigin()}/${scope.studios[0]?.slug ?? ""}`);
  if (!items.length) {
    return {
      components: [
        panel(COLORS.done, [
          text(`## 📥 Your reviews\nNothing waiting for your review. 🎉\n-# When someone submits work for you to review, it shows up here · ${studioLine(scope)}`),
          row(home),
        ]),
      ],
    };
  }
  const nextId = idMaker();
  const rows = items.slice(0, 10).map((i) => {
    const what = [deliverableName(i.deliverable.name, i.card.title), i.versionNumber ? `V${i.versionNumber}` : null].filter(Boolean).join(" ");
    const who = `submitted${i.submittedBy ? ` by ${escapeMarkdown(truncate(i.submittedBy, 40))}` : ""}${i.submittedAt ? ` ${discordTime(i.submittedAt, "R")}` : ""}`;
    return listRow(nextId, i.card.id, cardLink(i.card.key, i.card.title, i.url), [what, who].filter(Boolean).join(" · "), { label: "Review", style: 1 });
  });
  return {
    components: [
      panel(COLORS.review, [
        text(`## 📥 Waiting for your review\n-# ${plural(items.length, "submission")} · oldest first · ${studioLine(scope)}`),
        divider(),
        ...rows,
        ...(items.length > 10 ? [text(`-# …and ${items.length - 10} more. Open Forge to see everything.`)] : []),
        divider(),
        row(home),
      ]),
    ],
  };
}

/** Submitted deliverables this person may decide: theirs to review (or no reviewer named), and allowed by the project's rules. */
async function reviewQueue(scope: Scope): Promise<Reply> {
  const projectIds = [...scope.accesses.values()].filter((a) => roleHas(a.role, "card.review")).map((a) => a.project.id);
  if (!projectIds.length) return reviewsView([], scope);
  const rows = await db
    .select({
      d: { id: deliverables.id, number: deliverables.number, name: deliverables.name, projectId: deliverables.projectId },
      card: { id: cards.id, number: cards.number, title: cards.title, boardNumber: boards.number },
      versionNumber: assetVersions.versionNumber,
      submittedAt: assetVersions.submittedAt,
      submittedBy: users.displayName,
    })
    .from(deliverables)
    .innerJoin(cards, eq(cards.id, deliverables.cardId))
    .innerJoin(boardColumns, eq(boardColumns.id, cards.columnId))
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .leftJoin(assetVersions, eq(assetVersions.id, deliverables.currentVersionId))
    .leftJoin(users, eq(users.id, assetVersions.submittedById))
    .where(
      and(
        inArray(deliverables.projectId, projectIds),
        eq(deliverables.state, "NEEDS_REVIEW"),
        isNull(deliverables.archivedAt),
        isNull(cards.archivedAt),
        isNull(boardColumns.archivedAt),
        isNull(boards.archivedAt),
        sql`(${deliverables.reviewerId} = ${scope.userId} or (${deliverables.reviewerId} is null and (exists (select 1 from ${cardReviewers} r where r.card_id = ${cards.id} and r.user_id = ${scope.userId}) or not exists (select 1 from ${cardReviewers} r where r.card_id = ${cards.id}))))`,
      ),
    )
    .orderBy(sql`${assetVersions.submittedAt} asc nulls last`, asc(cards.lastActivityAt))
    .limit(60);
  const items: ReviewItem[] = [];
  for (const r of rows) {
    const ctx = await requireDeliverable(scope.userId, r.d.id).catch(() => null);
    if (!ctx?.dperms.canReview) continue;
    const access = scope.accesses.get(r.d.projectId)!;
    const key = `${access.project.key}-${r.card.number}`;
    items.push({
      deliverable: { id: r.d.id, number: r.d.number, name: r.d.name },
      card: { id: r.card.id, key, title: r.card.title },
      url: cardUrl(access.studioSlug, access.project.slug, r.card.boardNumber, key, r.d.number),
      versionNumber: r.versionNumber ?? null,
      submittedAt: r.submittedAt?.toISOString() ?? null,
      submittedBy: r.submittedBy ?? null,
    });
    if (items.length >= 25) break;
  }
  return reviewsView(items, scope);
}

// ── /due ────────────────────────────────────────────────────────────────────────────────────

const DAY = 86_400_000;

interface DueItem {
  due: number;
  dueAt: string;
  /** A checklist item: due on this day ("YYYY-MM-DD"), shown without a time; View opens the checklist. */
  day?: string;
  cardId: string;
  title: string;
  detail: string | null;
  people: string[];
}

async function deadlines(scope: Scope, days: number, teamRequested: boolean): Promise<Reply> {
  let accesses = scope.accesses;
  let team = teamRequested;
  let note: string | null = null;
  if (team) {
    const managed = new Map([...accesses].filter(([, a]) => roleHas(a.role, "reports.view")));
    if (managed.size) accesses = managed;
    else {
      team = false;
      note = "ℹ️ The whole team's deadlines are for Managers and above, so these are yours.";
    }
  }
  const at = Date.now();
  const end = at + days * DAY;
  const schedule = await loadSchedule({ userId: scope.userId }, { accesses, mineOnly: !team }, new Date(at - 120 * DAY).toISOString(), new Date(end).toISOString());
  const items: DueItem[] = [];
  for (const card of schedule.cards) {
    const url = cardUrl(card.project.studioSlug, card.project.slug, card.board.number, card.key);
    const cardCounts = Boolean(card.dueAt && card.state !== "APPROVED" && (team || card.assigneeIds.includes(scope.userId)) && Date.parse(card.dueAt) <= end);
    if (cardCounts) items.push({ due: Date.parse(card.dueAt!), dueAt: card.dueAt!, cardId: card.id, title: cardLink(card.key, card.title, url), detail: null, people: card.assigneeIds });
    for (const d of card.deliverables) {
      if (!d.dueAt || d.state === "APPROVED" || !(team || d.mine) || Date.parse(d.dueAt) > end) continue;
      // Following the card's deadline, it's already on the card's row.
      if (cardCounts && !d.ownDueAt) continue;
      items.push({ due: Date.parse(d.dueAt), dueAt: d.dueAt, cardId: card.id, title: cardLink(card.key, card.title, `${url}&d=${d.number}`), detail: deliverableName(d.name, card.title), people: [] });
    }
  }
  const endDay = new Date(end).toISOString().slice(0, 10);
  for (const item of schedule.checklistItems) {
    if (item.dueOn > endDay) continue;
    const url = cardUrl(item.card.project.studioSlug, item.card.project.slug, item.card.board.number, item.card.key);
    // Due by the end of that day.
    items.push({ due: Date.parse(`${item.dueOn}T23:59:59Z`), dueAt: `${item.dueOn}T23:59:59Z`, day: item.dueOn, cardId: item.card.id, title: cardLink(item.card.key, item.card.title, url), detail: `☑️ ${escapeMarkdown(truncate(item.text, 60))}`, people: item.assigneeId ? [item.assigneeId] : [] });
  }
  items.sort((a, b) => a.due - b.due);
  const names = new Map<string, string>();
  const peopleIds = [...new Set(items.flatMap((i) => i.people))];
  if (team && peopleIds.length) for (const u of await db.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, peopleIds))) names.set(u.id, u.name);
  const overdue = items.filter((i) => i.due < at).length;
  const heading = team ? "📅 Team deadlines" : "📅 Your deadlines";
  const range = `next ${plural(days, "day")}`;
  const calendar = link("Open calendar", `${appOrigin()}/${scope.studios[0]?.slug ?? ""}/calendar`);
  const intro = note ? [text(`-# ${note}`)] : [];
  if (!items.length) {
    return {
      components: [
        panel(COLORS.done, [
          text(`## ${heading}\nNothing ${team ? "" : "of yours "}is due in the ${range}, and nothing is overdue. 🎉\n-# ${studioLine(scope)}`),
          ...intro,
          row(calendar),
        ]),
      ],
    };
  }
  const nextId = idMaker();
  const toRow = (i: DueItem) => {
    const who = team && i.people.length ? escapeMarkdown(truncate(i.people.map((p) => names.get(p) ?? "?").join(", "), 50)) : null;
    const when = i.day ? itemDue(i.day, todayDay()) : `${dueText(i.dueAt, at)} (${discordTime(i.dueAt, "f")})`;
    const detail = [i.detail, when, who ? `👤 ${who}` : null].filter(Boolean).join(" · ");
    return listRow(nextId, i.cardId, i.title, detail, i.day ? { label: "View", style: 2, verb: "list" } : undefined);
  };
  const rows = groupedRows(
    items,
    [
      { title: "🚨 Overdue", test: (i) => i.due < at },
      { title: "⏰ In the next 24 hours", test: (i) => i.due - at < DAY },
      { title: `🗓️ Later in the ${range}`, test: () => true },
    ],
    toRow,
    8,
  );
  return {
    components: [
      panel(overdue ? COLORS.late : COLORS.review, [
        text(`## ${heading}\n-# ${[overdue ? `${overdue} overdue` : null, items.length - overdue ? `${items.length - overdue} coming up` : null, range, studioLine(scope)].filter(Boolean).join(" · ")}`),
        ...intro,
        divider(),
        ...rows,
        divider(),
        row(calendar),
      ]),
    ],
  };
}

// ── /card and its actions ───────────────────────────────────────────────────────────────────

type Verb = "approve" | "submit" | "complete" | "publish";

interface Pending {
  verb: Verb;
  /** A deliverable (approve, submit) or the card (complete, publish). */
  id: string;
  cardId: string;
  question: string;
  explanation: string;
  confirm: string;
}

/** What this person can do to the card from Discord, from the same permissions the app uses. */
export function cardActions(detail: CardDetailDTO) {
  const deliverableActions = new Map<string, "review" | "submit">();
  for (const d of detail.deliverables) {
    if (d.archivedAt) continue;
    if (d.state === "NEEDS_REVIEW" && d.permissions.canReview) deliverableActions.set(d.id, "review");
    else if (d.permissions.canSubmit && d.hasFiles && (d.state === "NOT_SUBMITTED" || d.state === "IN_PROGRESS" || d.state === "CHANGES_REQUESTED")) deliverableActions.set(d.id, "submit");
  }
  const ready = detail.readiness.ready && !detail.archivedAt;
  return {
    deliverables: deliverableActions,
    complete: ready && detail.productionStatus === "TODO" && detail.permissions.canEdit,
    publish: ready && detail.productionStatus === "COMPLETED" && detail.permissions.canPublish,
  };
}

/** 🟩🟩🟨⬜ — approved, in review, changes requested, the rest (scaled to 10 squares). */
function progressBar(counts: { approved: number; review: number; changes: number; rest: number }) {
  const total = counts.approved + counts.review + counts.changes + counts.rest;
  if (!total) return "";
  const scale = Math.min(1, 10 / total);
  const parts = [
    ["🟩", counts.approved],
    ["🟨", counts.review],
    ["🟥", counts.changes],
    ["⬜", counts.rest],
  ] as const;
  let squares = parts.map(([, n]) => Math.round(n * scale));
  const target = Math.min(10, total);
  // Rounding can over- or undershoot: adjust the largest part so the bar is always `target` long.
  const diff = target - squares.reduce((a, b) => a + b, 0);
  if (diff) {
    const largest = squares.indexOf(Math.max(...squares));
    squares = squares.map((s, i) => (i === largest ? Math.max(0, s + diff) : s));
  }
  return parts.map(([emoji], i) => emoji.repeat(squares[i]!)).join("");
}

interface CardInfo {
  url: string;
  projectName: string;
  boardName: string | null;
  studioName: string;
  names: Map<string, string>;
}

export function cardView(detail: CardDetailDTO, info: CardInfo, options: { banner?: string; pending?: Pending } = {}): Reply {
  if (options.pending) return confirmView(detail, info, options.pending);
  const nowMs = Date.now();
  const name = (id: string | null) => (id ? escapeMarkdown(truncate(info.names.get(id) ?? "Someone", 40)) : null);
  const live = detail.deliverables.filter((d) => !d.archivedAt);
  const versionOf = new Map(detail.versions.map((v) => [v.id, v.number]));
  const actions = cardActions(detail);
  const nextId = idMaker();

  const late = Boolean(detail.dueAt && detail.state !== "APPROVED" && Date.parse(detail.dueAt) < nowMs);
  const status = [
    `${STATE_ICON[detail.state]} **${STATE_LABEL[detail.state]}**`,
    `${PRODUCTION_ICON[detail.productionStatus]} **${PRODUCTION_LABEL[detail.productionStatus]}**`,
    detail.dueAt ? `${late ? "🚨" : "⏰"} ${dueText(detail.dueAt, nowMs)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const people = detail.assigneeIds.length ? `👤 ${detail.assigneeIds.map(name).join(", ")}` : "👤 Nobody assigned yet";

  const counts = { approved: 0, review: 0, changes: 0, rest: 0 };
  for (const d of live) {
    if (d.state === "APPROVED") counts.approved++;
    else if (d.state === "NEEDS_REVIEW") counts.review++;
    else if (d.state === "CHANGES_REQUESTED") counts.changes++;
    else counts.rest++;
  }
  const legend = [
    counts.approved ? `🟩 ${counts.approved} approved` : null,
    counts.review ? `🟨 ${counts.review} in review` : null,
    counts.changes ? `🟥 ${counts.changes} changes requested` : null,
    counts.rest ? `⬜ ${counts.rest} to do` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const body: Container["components"] = [
    text(`-# 📇 ${escapeMarkdown(truncate(info.projectName, 60))}${info.boardName ? ` · ${escapeMarkdown(truncate(info.boardName, 40))}` : ""}\n## ${cardLink(detail.key, detail.title, info.url, 120)}`),
    text(`${status}\n-# ${people}`),
    divider(),
  ];
  if (live.length) body.push(text(`### Deliverables · ${counts.approved} of ${live.length} approved\n${progressBar(counts)}\n-# ${legend}`));

  // Deliverables with something for this person to do get their buttons; the rest share one block.
  let plain: string[] = [];
  const flush = () => {
    if (plain.length) body.push(text(plain.join("\n")));
    plain = [];
  };
  let actionable = 0;
  let hidden = 0;
  for (const d of live.slice(0, 15)) {
    const version = d.currentVersionId && versionOf.get(d.currentVersionId) ? ` · V${versionOf.get(d.currentVersionId)}` : "";
    const action = actions.deliverables.get(d.id);
    const stateText = action === "review" ? "waiting for your review" : STATE_TEXT[d.state];
    const dLate = Boolean(d.dueAt && d.state !== "APPROVED" && Date.parse(d.dueAt) < nowMs);
    const facts = [
      d.ownerId ? `👤 ${name(d.ownerId)}` : null,
      d.reviewerId ? `🔍 ${name(d.reviewerId)}` : null,
      d.blockedBy.length ? "⛔ waiting on a prerequisite" : null,
      d.dueAt && d.state !== "APPROVED" ? `${dLate ? "🚨" : "⏰"} ${dueText(d.dueAt, nowMs)}` : null,
    ].filter(Boolean);
    const line = `${STATE_ICON[d.state]} **${escapeMarkdown(truncate(d.name, 60))}** — ${stateText}${version}${facts.length ? `\n-# ${facts.join(" · ")}` : ""}`;
    if (action && actionable < 5) {
      actionable++;
      flush();
      if (action === "review") {
        body.push(text(line));
        body.push(
          row(
            { type: 2, style: 3, label: "Approve", custom_id: nextId(`fg:approve:${d.id}`), emoji: { name: "✅" } },
            { type: 2, style: 4, label: "Request changes", custom_id: nextId(`fg:changes:${d.id}`), emoji: { name: "🔁" } },
          ),
        );
      } else {
        body.push({ type: 9, components: [text(line)], accessory: { type: 2, style: 1, label: "Submit for review", custom_id: nextId(`fg:submit:${d.id}`), emoji: { name: "📥" } } });
      }
    } else {
      if (action) hidden++;
      plain.push(line);
    }
  }
  flush();
  if (live.length > 15) body.push(text(`-# …and ${live.length - 15} more deliverables in Forge.`));
  if (hidden) body.push(text(`-# ${plural(hidden, "more deliverable")} need${hidden === 1 ? "s" : ""} you — open the card in Forge for those.`));

  const bottom: Button[] = [];
  if (actions.complete) bottom.push({ type: 2, style: 1, label: "Mark completed", custom_id: nextId(`fg:complete:${detail.id}`), emoji: { name: "🏁" } });
  if (actions.publish) bottom.push({ type: 2, style: 1, label: "Mark published", custom_id: nextId(`fg:publish:${detail.id}`), emoji: { name: "🚀" } });
  const listTotal = detail.checklists.reduce((n, l) => n + l.items.length, 0);
  const listDone = detail.checklists.reduce((n, l) => n + l.items.filter((i) => i.isDone).length, 0);
  if (listTotal || detail.permissions.canEdit) {
    bottom.push({ type: 2, style: 2, label: listTotal ? `Checklist ${listDone}/${listTotal}` : "Add checklist items", custom_id: nextId(`fg:list:${detail.id}`), emoji: { name: "☑️" } });
  }
  bottom.push(link("Open in Forge", info.url));
  body.push(divider(), row(...bottom));

  return { components: [...(options.banner ? [text(options.banner)] : []), panel(STATE_COLOR[detail.state], body)] };
}

/** "Approve V3 of Rig?" with what happens next, and Yes / Cancel. */
function confirmView(detail: CardDetailDTO, info: CardInfo, pending: Pending): Reply {
  return {
    components: [
      panel(COLORS.review, [
        text(`### ${pending.question}\n${pending.explanation}\n-# ${cardLink(detail.key, detail.title, info.url)} · ${escapeMarkdown(truncate(info.projectName, 60))}`),
        row(
          { type: 2, style: 3, label: truncate(pending.confirm, 80), custom_id: `fg:${pending.verb}!:${pending.id}` },
          { type: 2, style: 2, label: "Cancel", custom_id: `fg:open:${pending.cardId}` },
        ),
      ]),
    ],
  };
}

async function cardReply(userId: string, cardId: string, options: { banner?: string; pending?: Pending } = {}): Promise<Reply> {
  const ctx = await requireCard(userId, cardId);
  const detail = await loadCardDetail(ctx);
  const [board] = await db.select({ number: boards.number, name: boards.name }).from(boards).where(eq(boards.id, ctx.card.boardId));
  const ids = [...new Set([...detail.assigneeIds, ...detail.deliverables.flatMap((d) => [d.ownerId, d.reviewerId]).filter((v): v is string => Boolean(v))])];
  const names = new Map((ids.length ? await db.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, ids)) : []).map((u) => [u.id, u.name]));
  return cardView(
    detail,
    {
      url: cardUrl(ctx.access.studioSlug, ctx.access.project.slug, board?.number, detail.key),
      projectName: `${ctx.access.project.icon} ${ctx.access.project.name}`.trim(),
      boardName: board?.name ?? null,
      studioName: ctx.access.studioName,
      names,
    },
    options,
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A card from what was typed: an autocomplete pick (its id), a key like UTD-4, or words from its title. */
async function findCard(scope: Scope, actor: Actor, query: string): Promise<string | null> {
  const q = query.trim();
  if (UUID.test(q)) return q;
  const key = /^([A-Za-z0-9]{1,6})-(\d{1,7})$/.exec(q);
  if (key) {
    const projectIds = [...scope.accesses.values()].filter((a) => a.project.key.toUpperCase() === key[1]!.toUpperCase()).map((a) => a.project.id);
    if (projectIds.length) {
      const [hit] = await db.select({ id: cards.id }).from(cards).where(and(inArray(cards.projectId, projectIds), eq(cards.number, Number(key[2])), isNull(cards.archivedAt))).limit(1);
      if (hit) return hit.id;
    }
  }
  for (const studio of scope.studios.slice(0, 5)) {
    const [hit] = await searchCards(actor, { studioId: studio.id, q: q.slice(0, 100), limit: 1 });
    if (hit && scope.accesses.has(hit.project.id)) return hit.card.id;
  }
  return null;
}

type Choice = { name: string; value: string };

function choiceList() {
  const choices: Choice[] = [];
  const add = (value: string, label: string) => {
    if (value && choices.length < 25 && !choices.some((c) => c.value === value)) choices.push({ name: truncate(label, 100), value });
  };
  return { choices, add };
}

/** Card suggestions while typing /card: matches among the cards this person can see; their own work when empty. */
async function suggestCards(scope: Scope, actor: Actor, query: string): Promise<Choice[]> {
  const q = query.trim();
  const { choices, add } = choiceList();
  if (!q) {
    const ids = [...scope.accesses.keys()];
    if (!ids.length) return choices;
    const projectRef = (id: string) => {
      const a = scope.accesses.get(id)!;
      return { id, slug: a.project.slug, name: a.project.name, icon: a.project.icon, key: a.project.key };
    };
    for (const item of await myDeliverables(scope.userId, ids, projectRef, () => null)) add(item.card.id, `${item.card.key} · ${item.card.title}`);
    return choices;
  }
  for (const studio of scope.studios.slice(0, 5)) {
    for (const hit of await searchCards(actor, { studioId: studio.id, q: q.slice(0, 100), limit: 25 })) {
      if (scope.accesses.has(hit.project.id)) add(hit.card.id, `${hit.card.key} · ${hit.card.title}`);
    }
  }
  return choices;
}

const VERSION_ROW = (id: string) => db.select({ n: assetVersions.versionNumber }).from(assetVersions).where(eq(assetVersions.id, id));

/** The confirmation for an action, worded from the current state. */
async function pendingFor(userId: string, verb: Verb, id: string): Promise<Pending> {
  if (verb === "approve" || verb === "submit") {
    const ctx = await requireDeliverable(userId, id);
    const [version] = ctx.deliverable.currentVersionId ? await VERSION_ROW(ctx.deliverable.currentVersionId) : [];
    const what = `${version ? `**V${version.n}** of ` : ""}**${escapeMarkdown(truncate(ctx.deliverable.name, 60))}**`;
    return verb === "approve"
      ? { verb, id, cardId: ctx.card.id, question: `Approve ${what}?`, explanation: "Everyone working on it is told it's approved, and work waiting on it can start.", confirm: "Yes, approve" }
      : { verb, id, cardId: ctx.card.id, question: `Submit ${what} for review?`, explanation: "Its reviewer is asked to approve it or request changes.", confirm: "Yes, submit" };
  }
  const ctx = await requireCard(userId, id);
  const title = `**${escapeMarkdown(truncate(ctx.card.title, 80))}**`;
  return verb === "complete"
    ? { verb, id, cardId: id, question: `Mark ${title} as completed?`, explanation: "Every required deliverable is approved; this records the work as done.", confirm: "Yes, mark completed" }
    : { verb, id, cardId: id, question: `Mark ${title} as published?`, explanation: "This records the work as released.", confirm: "Yes, mark published" };
}

/** Shows the card with a message about what went wrong (the services' own wording). */
const failed = (userId: string, cardId: string, error: AppError) => cardReply(userId, cardId, { banner: `⚠️ ${escapeMarkdown(error.message)}` });

/** Carries out a confirmed action as the person (the services check their permissions), then shows the card again. */
async function perform(actor: Actor, verb: Verb, id: string): Promise<Reply> {
  if (verb === "approve" || verb === "submit") {
    const ctx = await requireDeliverable(actor.userId, id);
    const [version] = ctx.deliverable.currentVersionId ? await VERSION_ROW(ctx.deliverable.currentVersionId) : [];
    const what = `${version ? `**V${version.n}** of ` : ""}**${escapeMarkdown(truncate(ctx.deliverable.name, 60))}**`;
    try {
      if (verb === "approve") await approve(actor, { deliverableId: id });
      else await submitForReview(actor, { deliverableId: id });
    } catch (error) {
      if (error instanceof AppError) return failed(actor.userId, ctx.card.id, error);
      throw error;
    }
    return cardReply(actor.userId, ctx.card.id, { banner: verb === "approve" ? `✅ You approved ${what}.` : `📥 You submitted ${what} for review.` });
  }
  try {
    await moveProduction(actor, { cardId: id, status: verb === "complete" ? "COMPLETED" : "PUBLISHED" });
  } catch (error) {
    if (error instanceof AppError) return failed(actor.userId, id, error);
    throw error;
  }
  return cardReply(actor.userId, id, { banner: verb === "complete" ? "🏁 Marked **Completed**." : "🚀 Marked **Published**." });
}

/** The "Request changes" form: what needs to change, one item per line (each becomes a feedback item). */
async function changesModal(userId: string, deliverableId: string): Promise<InteractionResponse> {
  const ctx = await requireDeliverable(userId, deliverableId);
  if (ctx.deliverable.state !== "NEEDS_REVIEW" || !ctx.dperms.canReview) {
    return respond(7, await cardReply(userId, ctx.card.id, { banner: `⚠️ **${escapeMarkdown(ctx.deliverable.name)}** isn't waiting for your review any more.` }));
  }
  const required = Boolean(ctx.access.project.settings.requireFeedbackForChanges);
  return {
    type: 9,
    data: {
      custom_id: `fg:changes!:${deliverableId}`,
      title: truncate(`Request changes · ${ctx.deliverable.name}`, 45),
      components: [
        {
          type: 1,
          components: [
            {
              type: 4,
              custom_id: "items",
              style: 2,
              label: "What needs to change? (one per line)",
              placeholder: "Each line becomes a feedback item in Forge.",
              required,
              max_length: 4000,
            },
          ],
        },
      ],
    },
  };
}

async function submitChanges(actor: Actor, deliverableId: string, input: string): Promise<Reply> {
  const ctx = await requireDeliverable(actor.userId, deliverableId);
  const items = input
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*•]\s*/, "").trim())
    .filter(Boolean)
    .map((line) => line.slice(0, 2000))
    .slice(0, 30);
  try {
    await requestChanges(actor, { deliverableId, items });
  } catch (error) {
    if (error instanceof AppError) return failed(actor.userId, ctx.card.id, error);
    throw error;
  }
  const notes = items.length ? ` with ${plural(items.length, "feedback item")}` : "";
  return cardReply(actor.userId, ctx.card.id, { banner: `🔁 You requested changes on **${escapeMarkdown(ctx.deliverable.name)}**${notes}.` });
}

// ── /newcard ────────────────────────────────────────────────────────────────────────────────

/** Projects the person can create cards in. */
function creatable(scope: Scope) {
  return [...scope.accesses.values()].filter((a) => roleHas(a.role, "card.create")).sort((a, b) => a.project.name.localeCompare(b.project.name));
}

/** A project from an autocomplete pick (its id) or typed text (its name or key). */
function matchProject(list: ProjectAccess[], value: string): ProjectAccess | null {
  if (UUID.test(value)) return list.find((a) => a.project.id === value) ?? null;
  const v = value.trim().toLowerCase();
  if (!v) return null;
  const exact = list.filter((a) => a.project.name.toLowerCase() === v || a.project.key.toLowerCase() === v);
  if (exact.length === 1) return exact[0]!;
  const partial = list.filter((a) => a.project.name.toLowerCase().includes(v));
  return partial.length === 1 ? partial[0]! : null;
}

async function columnsOf(projectId: string) {
  const rows = await db
    .select({ id: boardColumns.id, name: boardColumns.name, board: boards.name })
    .from(boardColumns)
    .innerJoin(boards, eq(boards.id, boardColumns.boardId))
    .where(and(eq(boardColumns.projectId, projectId), isNull(boardColumns.archivedAt), isNull(boards.archivedAt)))
    .orderBy(asc(boards.position), asc(boardColumns.position));
  const severalBoards = new Set(rows.map((r) => r.board)).size > 1;
  return rows.map((r) => ({ id: r.id, name: r.name, label: severalBoards ? `${r.board} › ${r.name}` : r.name }));
}

function matchColumn(list: Awaited<ReturnType<typeof columnsOf>>, value: string) {
  if (UUID.test(value)) return list.find((c) => c.id === value) ?? null;
  const v = value.trim().toLowerCase();
  const exact = list.filter((c) => c.name.toLowerCase() === v || c.label.toLowerCase() === v);
  if (exact.length === 1) return exact[0]!;
  const partial = list.filter((c) => c.label.toLowerCase().includes(v));
  return partial.length === 1 ? partial[0]! : null;
}

/** Who may be assigned: anyone on the project for people who can assign others, otherwise only themselves. */
async function assignable(access: ProjectAccess) {
  const members = await listProjectMembers(access.project);
  return roleHas(access.role, "card.assign") ? members : members.filter((m) => m.id === access.userId);
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const SHORT_DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SHORT_MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n));
const dayLabel = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${SHORT_DAY[d.getUTCDay()]} ${d.getUTCDate()} ${SHORT_MONTH[d.getUTCMonth()]}`;
};

/** A calendar day ("YYYY-MM-DD") from what someone typed: a date, today/tomorrow, a weekday, "in 3 days", "2w"… */
export function parseDueDay(input: string, now = new Date()): string | null {
  const v = input.trim().toLowerCase().replace(/\s+/g, " ");
  if (!v) return null;
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const d = new Date(`${v}T00:00:00Z`);
    return Number.isNaN(d.getTime()) || isoDay(d) !== v ? null : v;
  }
  if (v === "today") return isoDay(today);
  if (v === "tomorrow" || v === "tmrw") return isoDay(addDays(today, 1));
  if (v === "next week") return isoDay(addDays(today, 7));
  const relative = /^(?:in )?(\d{1,3}) ?(d|day|days|w|wk|week|weeks)$/.exec(v);
  if (relative) return isoDay(addDays(today, Number(relative[1]) * (relative[2]!.startsWith("w") ? 7 : 1)));
  const weekday = WEEKDAYS.findIndex((day) => v === day || (v.length >= 3 && day.startsWith(v)) || v === `next ${day}`);
  if (weekday >= 0) return isoDay(addDays(today, (weekday - today.getUTCDay() + 7) % 7 || 7));
  return null;
}

/** Date-only deadlines are at 18:00 (UTC here: Discord doesn't say where people are; the reply shows their local time). */
const dueAtFor = (day: string) => new Date(`${day}T18:00:00Z`).toISOString();

function suggestDays(typed: string, now = new Date()): Choice[] {
  const { choices, add } = choiceList();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const parsed = parseDueDay(typed, now);
  if (parsed) add(parsed, `${typed.trim()} · ${dayLabel(parsed)}`);
  const presets: Array<[string, Date]> = [
    ["Today", today],
    ["Tomorrow", addDays(today, 1)],
    ["Friday", addDays(today, (5 - today.getUTCDay() + 7) % 7 || 7)],
    ["In 1 week", addDays(today, 7)],
    ["In 2 weeks", addDays(today, 14)],
  ];
  for (const [label, date] of presets) {
    if (!typed.trim() || label.toLowerCase().includes(typed.trim().toLowerCase())) add(isoDay(date), `${label} · ${dayLabel(isoDay(date))}`);
  }
  return choices;
}

function optionText(interaction: Interaction, name: string) {
  const value = interaction.data?.options?.find((o) => o.name === name)?.value;
  return typeof value === "string" ? value : value === undefined ? "" : String(value);
}

async function suggestForNewCard(scope: Scope, interaction: Interaction): Promise<Choice[]> {
  const focused = interaction.data?.options?.find((o) => o.focused);
  const typed = typeof focused?.value === "string" ? focused.value.trim().toLowerCase() : "";
  const { choices, add } = choiceList();
  const projects = creatable(scope);
  if (focused?.name === "project") {
    for (const a of projects) {
      if (!typed || a.project.name.toLowerCase().includes(typed) || a.project.key.toLowerCase().startsWith(typed)) add(a.project.id, `${a.project.icon} ${a.project.name} (${a.project.key})`.trim());
    }
    return choices;
  }
  if (focused?.name === "due") return suggestDays(typeof focused.value === "string" ? focused.value : "");
  const access = matchProject(projects, optionText(interaction, "project"));
  if (!access) return choices;
  if (focused?.name === "column") {
    for (const c of await columnsOf(access.project.id)) if (!typed || c.label.toLowerCase().includes(typed)) add(c.id, c.label);
  } else if (focused?.name === "assign") {
    if (!typed || "me".startsWith(typed)) add("me", "Me");
    for (const m of await assignable(access)) {
      if (m.id === scope.userId) continue;
      if (!typed || m.displayName.toLowerCase().includes(typed) || m.username.toLowerCase().includes(typed)) add(m.id, `${m.displayName} (@${m.username})`);
    }
  }
  return choices;
}

async function newCard(scope: Scope, actor: Actor, interaction: Interaction): Promise<Reply> {
  const title = optionText(interaction, "title").trim().slice(0, 200);
  if (!title) return problem("Give the card a title.");
  const projects = creatable(scope);
  if (!projects.length) return problem("You can't create cards in any project here. Ask a Manager for a role that can.");
  const access = matchProject(projects, optionText(interaction, "project"));
  if (!access) return problem("Choose a project from the list while typing.");
  const columns = await columnsOf(access.project.id);
  const columnText = optionText(interaction, "column");
  const column = columnText ? matchColumn(columns, columnText) : (columns[0] ?? null);
  if (!column) return problem(columns.length ? "Choose a column from the list while typing." : `${access.project.name} has no columns yet. Add one in Forge first.`);

  const assignText = optionText(interaction, "assign").trim();
  let assigneeIds: string[] = [];
  if (assignText) {
    if (assignText === "me" || assignText.toLowerCase() === "me") assigneeIds = [actor.userId];
    else {
      const members = await assignable(access);
      const v = assignText.toLowerCase().replace(/^@/, "");
      const match = UUID.test(assignText)
        ? members.find((m) => m.id === assignText)
        : (members.find((m) => m.username.toLowerCase() === v) ?? (members.filter((m) => m.displayName.toLowerCase().includes(v)).length === 1 ? members.find((m) => m.displayName.toLowerCase().includes(v)) : undefined));
      if (!match) return problem(roleHas(access.role, "card.assign") ? "Choose who works on it from the list while typing." : "You can assign cards only to yourself in this project.");
      assigneeIds = [match.id];
    }
  }
  const dueText = optionText(interaction, "due");
  const day = dueText ? parseDueDay(dueText) : null;
  if (dueText && !day) return problem("Forge didn't understand that deadline. Try friday, tomorrow, in 3 days or 2026-10-20.");
  const priorityValue = optionText(interaction, "priority");
  const priority = (["LOW", "NORMAL", "HIGH", "URGENT"] as const).includes(priorityValue as Priority) ? (priorityValue as Priority) : "NORMAL";

  let created;
  try {
    created = await createCard(actor, {
      projectId: access.project.id,
      columnId: column.id,
      title,
      description: optionText(interaction, "description").trim().slice(0, 2000) || undefined,
      priority,
      dueAt: day ? dueAtFor(day) : null,
      assigneeIds,
    });
  } catch (error) {
    if (error instanceof AppError) return problem(error.message);
    throw error;
  }
  return cardReply(actor.userId, created.id, {
    banner: `🆕 Created **${escapeMarkdown(created.key)}** in **${escapeMarkdown(truncate(access.project.name, 60))}** › ${escapeMarkdown(truncate(column.label, 60))}.`,
  });
}

// ── Checklists ──────────────────────────────────────────────────────────────────────────────

const todayDay = () => new Date().toISOString().slice(0, 10);

/** "📅 due Fri 16 Oct", "⏰ due today" or "🚨 was due Mon 12 Oct" (items are due by the end of their day). */
function itemDue(day: string, today: string) {
  return day < today ? `🚨 was due ${dayLabel(day)}` : day === today ? "⏰ due today" : `📅 due ${dayLabel(day)}`;
}

/** Most items shown in one checklist view (Discord's text and button limits); the rest are in Forge. */
const CHECKLIST_VIEW_ITEMS = 18;

export function checklistView(detail: CardDetailDTO, info: CardInfo & { viewerId: string }, banner?: string): Reply {
  const today = todayDay();
  const canEdit = detail.permissions.canEdit;
  const tickable = (item: ChecklistItemDTO) => canTickItem({ perms: detail.permissions }, item, info.viewerId);
  const nextId = idMaker();
  const all = detail.checklists.flatMap((l) => l.items);
  const done = all.filter((i) => i.isDone).length;
  const lists = detail.checklists.slice(0, 4);
  const body: Container["components"] = [
    text(`-# 📇 ${escapeMarkdown(truncate(info.projectName, 60))}${info.boardName ? ` · ${escapeMarkdown(truncate(info.boardName, 40))}` : ""}\n## ${cardLink(detail.key, detail.title, info.url, 120)}`),
    text(all.length ? `### ☑️ Checklist · ${done} of ${all.length} done` : `### ☑️ Checklist\nNo items yet.${canEdit ? " Add the first ones below." : ""}`),
    divider(),
  ];
  // Discord allows 40 components: whatever isn't needed for the frame goes to Tick off buttons.
  const frame = (banner ? 1 : 0) + 1 + body.length + lists.length * (canEdit ? 4 : 2) + (detail.checklists.length > lists.length ? 1 : 0) + 2 + 3;
  let buttons = Math.max(0, Math.floor((LAYOUT_LIMITS.components - frame) / 3));
  let shown = 0;
  for (const list of lists) {
    const listDone = list.items.filter((i) => i.isDone).length;
    body.push(text(`**${escapeMarkdown(truncate(list.title, 80))}** · ${listDone}/${list.items.length}`));
    let plain: string[] = [];
    const flush = () => {
      if (plain.length) body.push(text(plain.join("\n")));
      plain = [];
    };
    for (const item of list.items) {
      if (shown >= CHECKLIST_VIEW_ITEMS) break;
      shown++;
      const facts = [
        item.assigneeId ? `👤 ${escapeMarkdown(truncate(info.names.get(item.assigneeId) ?? "Former member", 40))}` : null,
        item.dueOn && !item.isDone ? itemDue(item.dueOn, today) : null,
      ].filter(Boolean);
      const label = escapeMarkdown(truncate(item.text, 90));
      const line = `${item.isDone ? `✅ ~~${label}~~` : `⬜ **${label}**`}${facts.length ? `\n-# ${facts.join(" · ")}` : ""}`;
      if (tickable(item) && buttons > 0) {
        buttons--;
        flush();
        body.push({
          type: 9,
          components: [text(line)],
          accessory: item.isDone
            ? { type: 2, style: 2, label: "Untick", custom_id: nextId(`fg:untick:${item.id}`) }
            : { type: 2, style: 3, label: "Tick off", custom_id: nextId(`fg:tick:${item.id}`), emoji: { name: "✅" } },
        });
      } else plain.push(line);
    }
    flush();
    if (canEdit) body.push(row({ type: 2, style: 2, label: truncate(`Add items to ${list.title}`, 80), custom_id: nextId(`fg:additems:${list.id}`), emoji: { name: "➕" } }));
  }
  const notShown = all.length - shown;
  if (notShown > 0 || detail.checklists.length > lists.length) body.push(text(`-# ${notShown > 0 ? `…and ${plural(notShown, "more item")}` : "More checklists"} in Forge.`));
  const bottom: Button[] = [{ type: 2, style: 2, label: "Back to card", custom_id: nextId(`fg:open:${detail.id}`) }];
  if (canEdit && !detail.checklists.length) bottom.push({ type: 2, style: 1, label: "Add items", custom_id: nextId(`fg:newlist:${detail.id}`), emoji: { name: "➕" } });
  bottom.push(link("Open in Forge", info.url));
  body.push(divider(), row(...bottom));
  return { components: [...(banner ? [text(banner)] : []), panel(all.length && done === all.length ? COLORS.done : COLORS.work, body)] };
}

async function checklistReply(userId: string, cardId: string, banner?: string): Promise<Reply> {
  const ctx = await requireCard(userId, cardId);
  const detail = await loadCardDetail(ctx);
  const [board] = await db.select({ number: boards.number, name: boards.name }).from(boards).where(eq(boards.id, ctx.card.boardId));
  const ids = [...new Set(detail.checklists.flatMap((l) => l.items.map((i) => i.assigneeId)).filter((v): v is string => Boolean(v)))];
  const names = new Map((ids.length ? await db.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, ids)) : []).map((u) => [u.id, u.name]));
  return checklistView(
    detail,
    {
      url: cardUrl(ctx.access.studioSlug, ctx.access.project.slug, board?.number, detail.key),
      projectName: `${ctx.access.project.icon} ${ctx.access.project.name}`.trim(),
      boardName: board?.name ?? null,
      studioName: ctx.access.studioName,
      names,
      viewerId: userId,
    },
    banner,
  );
}

/** A person from what was typed: an autocomplete pick (their id), "me", a username or a name. */
function matchMember(members: MemberDTO[], value: string, actorId: string): MemberDTO | null {
  const v = value.trim().replace(/^@/, "").toLowerCase();
  if (!v) return null;
  if (UUID.test(v)) return members.find((m) => m.id === v) ?? null;
  if (v === "me") return members.find((m) => m.id === actorId) ?? null;
  const byUsername = members.find((m) => m.username.toLowerCase() === v);
  if (byUsername) return byUsername;
  const exact = members.filter((m) => m.displayName.toLowerCase() === v);
  if (exact.length === 1) return exact[0]!;
  const partial = members.filter((m) => m.displayName.toLowerCase().includes(v));
  return partial.length === 1 ? partial[0]! : null;
}

/** After "Added …": who does them and when, if set. */
function addedSuffix(assignee: MemberDTO | null, day: string | null) {
  return `${assignee ? ` for **${escapeMarkdown(truncate(assignee.displayName, 40))}**` : ""}${day ? `, due ${dayLabel(day)}` : ""}`;
}

/** Ticks an item off (or back on) as the person: its assignee, or anyone who can edit the card. */
async function tickItem(actor: Actor, itemId: string, isDone: boolean): Promise<Reply> {
  const [item] = await db.select({ cardId: checklistItems.cardId, text: checklistItems.text }).from(checklistItems).where(eq(checklistItems.id, itemId));
  if (!item) return problem("That item was deleted. Run the command again.");
  try {
    await updateChecklistItem(actor, { itemId, isDone });
  } catch (error) {
    if (error instanceof AppError) return checklistReply(actor.userId, item.cardId, `⚠️ ${escapeMarkdown(error.message)}`);
    throw error;
  }
  const label = `“${escapeMarkdown(truncate(item.text, 80))}”`;
  return checklistReply(actor.userId, item.cardId, isDone ? `✅ Ticked off ${label}.` : `↩️ ${label} is open again.`);
}

/** The "Add items" form: one item per line, and optionally who does them and when they're due. */
async function addItemsModal(userId: string, target: { checklistId: string } | { cardId: string }): Promise<InteractionResponse> {
  let cardId: string;
  let title = "Checklist";
  if ("checklistId" in target) {
    const [list] = await db.select({ cardId: checklists.cardId, title: checklists.title }).from(checklists).where(eq(checklists.id, target.checklistId));
    if (!list) return respond(7, problem("That checklist was deleted. Run the command again."));
    cardId = list.cardId;
    title = list.title;
  } else cardId = target.cardId;
  const ctx = await requireCard(userId, cardId);
  if (!ctx.perms.canEdit) return respond(7, await checklistReply(userId, cardId, "⚠️ You can add checklist items only to cards you can edit."));
  const input = (custom_id: string, label: string, style: 1 | 2, required: boolean, placeholder: string, max_length: number) => ({ type: 1, components: [{ type: 4, custom_id, label, style, required, placeholder, max_length }] });
  return {
    type: 9,
    data: {
      custom_id: "checklistId" in target ? `fg:additems!:${target.checklistId}` : `fg:newlist!:${cardId}`,
      title: truncate(`Add items · ${title}`, 45),
      components: [
        input("items", "Items (one per line)", 2, true, "Export the hilt FBX\nRig the cape bones", 4000),
        input("assign", "Who does them? (optional)", 1, false, "A name, a username, or me", 100),
        input("due", "When are they due? (optional)", 1, false, "friday, tomorrow, in 3 days or 2026-10-20", 40),
      ],
    },
  };
}

function formValue(interaction: Interaction, id: string) {
  return interaction.data?.components?.flatMap((r) => r.components ?? []).find((c) => c.custom_id === id)?.value ?? "";
}

async function submitAddItems(actor: Actor, interaction: Interaction, target: { checklistId: string } | { cardId: string }): Promise<Reply> {
  let cardId: string;
  if ("checklistId" in target) {
    const [list] = await db.select({ cardId: checklists.cardId }).from(checklists).where(eq(checklists.id, target.checklistId));
    if (!list) return problem("That checklist was deleted. Run the command again.");
    cardId = list.cardId;
  } else cardId = target.cardId;
  const texts = formValue(interaction, "items")
    .slice(0, 4000)
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\[ ?\])\s*/, "").trim())
    .filter(Boolean);
  if (!texts.length) return checklistReply(actor.userId, cardId, "⚠️ Write at least one item.");
  const ctx = await requireCard(actor.userId, cardId);
  const assignText = formValue(interaction, "assign");
  const assignee = assignText.trim() ? matchMember(await checklistAssignees(ctx.access.project), assignText, actor.userId) : null;
  if (assignText.trim() && !assignee) return checklistReply(actor.userId, cardId, `⚠️ Forge couldn't find “${escapeMarkdown(truncate(assignText, 40))}” among the people who can work on this project. Nothing was added.`);
  const dueValue = formValue(interaction, "due");
  const day = dueValue.trim() ? parseDueDay(dueValue) : null;
  if (dueValue.trim() && !day) return checklistReply(actor.userId, cardId, "⚠️ Forge didn't understand that due date. Try friday, tomorrow, in 3 days or 2026-10-20. Nothing was added.");
  try {
    const result = await addChecklistItems(actor, { cardId, checklistId: "checklistId" in target ? target.checklistId : null, texts, assigneeId: assignee?.id ?? null, dueOn: day });
    return checklistReply(actor.userId, cardId, `✅ Added ${plural(result.added, "item")} to **${escapeMarkdown(truncate(result.checklist.title, 60))}**${addedSuffix(assignee, day)}.`);
  } catch (error) {
    if (error instanceof AppError) return checklistReply(actor.userId, cardId, `⚠️ ${escapeMarkdown(error.message)}`);
    throw error;
  }
}

/** /additem: one item on a card's checklist, optionally with who does it and when it's due. */
async function addItemCommand(scope: Scope, actor: Actor, interaction: Interaction): Promise<Reply> {
  const query = optionText(interaction, "card");
  const cardId = await findCard(scope, actor, query);
  if (!cardId) return problem(`No card you can see matches “${truncate(query, 60)}”.`);
  const itemText = optionText(interaction, "item").trim();
  if (!itemText) return problem("Say what needs doing.");
  const ctx = await requireCard(actor.userId, cardId);
  if (!ctx.perms.canEdit) return problem("You can add checklist items only to cards you can edit.");
  const assignText = optionText(interaction, "assign");
  const assignee = assignText.trim() ? matchMember(await checklistAssignees(ctx.access.project), assignText, actor.userId) : null;
  if (assignText.trim() && !assignee) return problem("Choose who does it from the list while typing: people who can work on this card's project.");
  const dueValue = optionText(interaction, "due");
  const day = dueValue.trim() ? parseDueDay(dueValue) : null;
  if (dueValue.trim() && !day) return problem("Forge didn't understand that due date. Try friday, tomorrow, in 3 days or 2026-10-20.");
  const listText = optionText(interaction, "list").trim();
  let checklistId: string | null = null;
  if (listText) {
    const lists = await db.select({ id: checklists.id, title: checklists.title }).from(checklists).where(eq(checklists.cardId, cardId)).orderBy(asc(checklists.position));
    const match = UUID.test(listText) ? lists.find((l) => l.id === listText) : lists.find((l) => l.title.toLowerCase() === listText.toLowerCase());
    if (!match) return problem("Choose a checklist from the list while typing (or leave it out for the card's first one).");
    checklistId = match.id;
  }
  try {
    const result = await addChecklistItems(actor, { cardId, checklistId, texts: [itemText], assigneeId: assignee?.id ?? null, dueOn: day });
    return checklistReply(actor.userId, cardId, `✅ Added “${escapeMarkdown(truncate(itemText, 80))}” to **${escapeMarkdown(truncate(result.checklist.title, 60))}**${addedSuffix(assignee, day)}.`);
  } catch (error) {
    if (error instanceof AppError) return problem(error.message);
    throw error;
  }
}

/** Suggestions while typing /additem: cards you can see, then (for that card) people, days and checklists. */
async function suggestForAddItem(scope: Scope, actor: Actor, interaction: Interaction): Promise<Choice[]> {
  const focused = interaction.data?.options?.find((o) => o.focused);
  const typed = typeof focused?.value === "string" ? focused.value : "";
  if (focused?.name === "card") return suggestCards(scope, actor, typed);
  if (focused?.name === "due") return suggestDays(typed);
  const cardId = await findCard(scope, actor, optionText(interaction, "card"));
  if (!cardId) return [];
  const ctx = await requireCard(actor.userId, cardId);
  const { choices, add } = choiceList();
  const q = typed.trim().toLowerCase();
  if (focused?.name === "assign") {
    const members = await checklistAssignees(ctx.access.project);
    if (members.some((m) => m.id === actor.userId) && (!q || "me".startsWith(q))) add("me", "Me");
    for (const m of members) {
      if (m.id === actor.userId) continue;
      if (!q || m.displayName.toLowerCase().includes(q) || m.username.toLowerCase().includes(q)) add(m.id, `${m.displayName} (@${m.username})`);
    }
  } else if (focused?.name === "list") {
    const lists = await db.select({ id: checklists.id, title: checklists.title }).from(checklists).where(eq(checklists.cardId, cardId)).orderBy(asc(checklists.position));
    for (const l of lists) if (!q || l.title.toLowerCase().includes(q)) add(l.id, l.title);
  }
  return choices;
}

// ── Dispatch ────────────────────────────────────────────────────────────────────────────────

const COMPONENT = /^fg:(open|approve|approve!|submit|submit!|changes|complete|complete!|publish|publish!|list|tick|untick|additems|newlist):([0-9a-f-]{36})(?::\d{1,2})?$/;

/**
 * Answers one interaction (already verified as coming from Discord). The person is identified by
 * their linked Discord account on every request — including each button click — and acts with
 * their own Forge permissions.
 */
export async function handleInteraction(interaction: Interaction): Promise<InteractionResponse> {
  if (interaction.type === 1) return { type: 1 };
  const discordUserId = interaction.member?.user?.id ?? interaction.user?.id;
  const updates = interaction.type === 3 || interaction.type === 5;
  const send = (reply: Reply) => respond(updates ? 7 : 4, reply);
  const noChoices: InteractionResponse = { type: 8, data: { choices: [] } };
  if (!discordUserId || !/^\d{5,25}$/.test(discordUserId)) return interaction.type === 4 ? noChoices : send(problem("Forge couldn't tell who sent this."));
  try {
    enforceRateLimit(`discord-command:${discordUserId}`, 40, 60_000);
  } catch (error) {
    if (interaction.type === 4) return noChoices;
    return send(problem(error instanceof AppError ? error.message : "Please wait a moment and try again."));
  }
  const user = await linkedUser(discordUserId);
  if (!user) return interaction.type === 4 ? noChoices : send(notLinked());
  const actor: Actor = { userId: user.id, userAgent: "Discord" };
  try {
    if (interaction.type === 4) {
      const scope = await scopeFor(user.id, interaction.guild_id);
      if (interaction.data?.name === "newcard") return { type: 8, data: { choices: await suggestForNewCard(scope, interaction) } };
      if (interaction.data?.name === "additem") return { type: 8, data: { choices: await suggestForAddItem(scope, actor, interaction) } };
      const typed = interaction.data?.options?.find((o) => o.focused)?.value;
      return { type: 8, data: { choices: await suggestCards(scope, actor, typeof typed === "string" ? typed : "") } };
    }
    if (interaction.type === 2) {
      const scope = await scopeFor(user.id, interaction.guild_id);
      switch (interaction.data?.name) {
        case "mywork":
          return send(await myWork(scope));
        case "reviews":
          return send(await reviewQueue(scope));
        case "due": {
          const days = Number(optionText(interaction, "days") || 3);
          const team = interaction.data.options?.some((o) => (o.name === "team" || o.name === "everyone") && o.value === true) ?? false;
          return send(await deadlines(scope, Number.isInteger(days) ? Math.min(30, Math.max(1, days)) : 3, team));
        }
        case "card": {
          // "card" was the option's first name; Discord may still send it until the client refreshes.
          const query = optionText(interaction, "find") || optionText(interaction, "card");
          const cardId = await findCard(scope, actor, query);
          if (!cardId) return send(problem(`No card you can see matches “${truncate(query, 60)}”.`));
          return send(await cardReply(user.id, cardId));
        }
        case "newcard":
          return send(await newCard(scope, actor, interaction));
        case "additem":
          return send(await addItemCommand(scope, actor, interaction));
        default:
          return send(problem("Forge doesn't know that command."));
      }
    }
    if (interaction.type === 3) {
      const customId = interaction.data?.custom_id ?? "";
      if (customId === "fg:pick") {
        // Menus from replies sent before the layout change.
        const cardId = interaction.data?.values?.[0] ?? "";
        if (!UUID.test(cardId)) return send(problem("Choose a card from the list."));
        return send(await cardReply(user.id, cardId));
      }
      const match = COMPONENT.exec(customId);
      if (!match || !UUID.test(match[2]!)) return send(problem("That button no longer works. Run the command again."));
      const [, verb, id] = match as unknown as [string, string, string];
      if (verb === "open") return send(await cardReply(user.id, id));
      if (verb === "list") return send(await checklistReply(user.id, id));
      if (verb === "tick" || verb === "untick") return send(await tickItem(actor, id, verb === "tick"));
      if (verb === "additems") return await addItemsModal(user.id, { checklistId: id });
      if (verb === "newlist") return await addItemsModal(user.id, { cardId: id });
      if (verb === "changes") return await changesModal(user.id, id);
      if (verb.endsWith("!")) return send(await perform(actor, verb.slice(0, -1) as Verb, id));
      const pending = await pendingFor(user.id, verb as Verb, id);
      return send(await cardReply(user.id, pending.cardId, { pending }));
    }
    if (interaction.type === 5) {
      const match = /^fg:(changes|additems|newlist)!:([0-9a-f-]{36})$/.exec(interaction.data?.custom_id ?? "");
      if (!match || !UUID.test(match[2]!)) return send(problem("That form no longer works. Run the command again."));
      if (match[1] === "additems") return send(await submitAddItems(actor, interaction, { checklistId: match[2]! }));
      if (match[1] === "newlist") return send(await submitAddItems(actor, interaction, { cardId: match[2]! }));
      return send(await submitChanges(actor, match[2]!, formValue(interaction, "items").slice(0, 4000)));
    }
    return send(problem("Forge doesn't handle that kind of interaction."));
  } catch (error) {
    if (error instanceof AppError) return interaction.type === 4 ? noChoices : send(problem(error.message));
    console.error("[discord] interaction failed", error);
    return interaction.type === 4 ? noChoices : send(problem("Something went wrong on Forge's side. Please try again."));
  }
}
