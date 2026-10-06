/**
 * Discord slash commands: /mywork, /reviews, /card and /due. Each runs as the Forge account the
 * person linked with "Connect Discord", with exactly the access and permissions they have in Forge,
 * and every reply is visible only to them. Actions (approve, request changes, submit for review,
 * mark completed or published) go through the same services as the app, after a confirmation step,
 * and are checked again on every click.
 */
import "server-only";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { roleHas } from "@/lib/permissions";
import type { CardDetailDTO, CardState, ProductionStatus } from "@/lib/types";
import { accessibleProjectIds, getProjectAccess, requireCard, requireDeliverable, type ProjectAccess } from "../access";
import { db } from "../db";
import { assetVersions, boardColumns, boards, cardReviewers, cards, deliverables, discordConnections, oauthAccounts, studioMembers, studios, users } from "../db/schema";
import { appOrigin, env } from "../env";
import { AppError } from "../errors";
import { enforceRateLimit } from "../rate-limit";
import { loadCardDetail } from "./card-dto";
import type { Actor } from "./context";
import { discordApi, discordConfigured } from "./discord";
import { discordTime, escapeMarkdown, truncate, type DiscordEmbed } from "./discord-message";
import { myDeliverables, type BoardRef, type MyDeliverableItem } from "./home";
import { moveProduction } from "./production";
import { approve, requestChanges, submitForReview } from "./reviews";
import { loadSchedule } from "./schedule";
import { searchCards } from "./search";

// ── Commands ────────────────────────────────────────────────────────────────────────────────

/** Usable in servers the bot is in and in the bot's direct messages (guild-installed app). */
const EVERYWHERE = { contexts: [0, 1], integration_types: [0] };

export const DISCORD_COMMANDS = [
  { name: "mywork", type: 1, description: "Your open work in Forge: what you're responsible for or contribute to.", ...EVERYWHERE },
  { name: "reviews", type: 1, description: "Work waiting for your review in Forge.", ...EVERYWHERE },
  {
    name: "card",
    type: 1,
    description: "Look up a Forge card and act on it.",
    ...EVERYWHERE,
    options: [{ type: 3, name: "card", description: "Card key or title, e.g. UTD-4", required: true, autocomplete: true, max_length: 100 }],
  },
  {
    name: "due",
    type: 1,
    description: "Your deadlines coming up, and anything overdue.",
    ...EVERYWHERE,
    options: [
      { type: 4, name: "days", description: "How many days ahead (default 3)", required: false, min_value: 1, max_value: 30 },
      { type: 5, name: "everyone", description: "The whole team's deadlines (Managers and above)", required: false },
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

// ── Discord's interaction shapes (the parts Forge reads and writes) ───────────────────────────

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

type Button = { type: 2; style: 1 | 2 | 3 | 4; label: string; custom_id: string; emoji?: { name: string } } | { type: 2; style: 5; label: string; url: string };
type Select = { type: 3; custom_id: string; placeholder: string; options: Array<{ label: string; value: string; description?: string }> };
type Row = { type: 1; components: Array<Button | Select> };

interface Reply {
  /** A short line above the embed: the outcome of an action, or a problem. */
  content?: string;
  embeds: DiscordEmbed[];
  components: Row[];
}

export type InteractionResponse =
  | { type: 1 }
  | { type: 4 | 7; data: { content?: string; embeds: DiscordEmbed[]; components: Row[]; flags?: number; allowed_mentions: { parse: [] } } }
  | { type: 8; data: { choices: Array<{ name: string; value: string }> } }
  | { type: 9; data: { custom_id: string; title: string; components: unknown[] } };

const EPHEMERAL = 64;

/** A new private message (4) or an update of the message a button was on (7). Mentions never ping. */
function respond(type: 4 | 7, reply: Reply): InteractionResponse {
  return {
    type,
    data: {
      ...(type === 7 ? { content: reply.content ?? "" } : reply.content ? { content: reply.content } : {}),
      embeds: reply.embeds,
      components: reply.components,
      ...(type === 4 ? { flags: EPHEMERAL } : {}),
      allowed_mentions: { parse: [] },
    },
  };
}

// ── Who's asking, and where ─────────────────────────────────────────────────────────────────

const COLORS = { work: 0x7c6cf2, review: 0xf5a524, late: 0xf0524f, done: 0x2ec27e, quiet: 0x94a3b8 };

function problem(text: string): Reply {
  return { embeds: [{ description: `⚠️ ${escapeMarkdown(text)}`, color: COLORS.late }], components: [] };
}

function notLinked(): Reply {
  return {
    embeds: [
      {
        author: { name: "🔗 Connect Discord to Forge" },
        description: "These commands work with your Forge account. In Forge, open **Account → Security** and choose **Connect** next to Discord, then try again.",
        color: COLORS.work,
      },
    ],
    components: [{ type: 1, components: [{ type: 2, style: 5, label: "Open Forge", url: `${appOrigin()}/account/security` }] }],
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

function studioFooter(scope: Scope) {
  return { text: truncate(scope.studios.map((s) => s.name).join(" · ") || "Forge", 2048) };
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

/** "Open a card…" for a list's cards (Discord shows at most 25). */
function openCardMenu(placeholder: string, items: Array<{ cardId: string; label: string; description: string }>): Row | null {
  const seen = new Set<string>();
  const options: Array<{ label: string; value: string; description?: string }> = [];
  for (const item of items) {
    if (seen.has(item.cardId) || options.length >= 25) continue;
    seen.add(item.cardId);
    options.push({ label: truncate(item.label, 100), value: item.cardId, ...(item.description ? { description: truncate(item.description, 100) } : {}) });
  }
  return options.length ? { type: 1, components: [{ type: 3, custom_id: "fg:pick", placeholder, options }] } : null;
}

function linkRow(label: string, url: string): Row {
  return { type: 1, components: [{ type: 2, style: 5, label, url }] };
}

const STATE_TEXT: Record<CardState, string> = {
  NOT_SUBMITTED: "not started",
  IN_PROGRESS: "in progress",
  NEEDS_REVIEW: "waiting for review",
  CHANGES_REQUESTED: "changes requested",
  APPROVED: "approved",
};
const STATE_ICON: Record<CardState, string> = { NOT_SUBMITTED: "⚪", IN_PROGRESS: "🛠️", NEEDS_REVIEW: "📥", CHANGES_REQUESTED: "🔁", APPROVED: "✅" };
const PRODUCTION_TEXT: Record<ProductionStatus, string> = { TODO: "To do", COMPLETED: "Completed", PUBLISHED: "Published" };

/** A deliverable's name, unless it just repeats the card's title (single-deliverable cards). */
function deliverableName(name: string, cardTitle: string) {
  return name.trim().toLowerCase() === cardTitle.trim().toLowerCase() ? null : `**${escapeMarkdown(truncate(name, 60))}**`;
}

/** "[UTD-4 Sword](url)" with whatever people typed escaped (and kept short). */
function cardLink(key: string, title: string, url: string) {
  return `[${escapeMarkdown(`${key} ${truncate(title, 60)}`)}](${url})`;
}

function dueText(iso: string | null, nowMs: number) {
  if (!iso) return null;
  return `${Date.parse(iso) < nowMs ? "was due" : "due"} ${discordTime(iso, "R")}`;
}

/** Lines that fit an embed (4096 characters), with "…and N more" when they don't all. */
function listLines(lines: string[], max = 12) {
  const shown: string[] = [];
  let length = 0;
  for (const line of lines.slice(0, max)) {
    if (length + line.length + 1 > 3800) break;
    shown.push(line);
    length += line.length + 1;
  }
  if (shown.length < lines.length) shown.push(`…and ${lines.length - shown.length} more in Forge.`);
  return shown.join("\n");
}

// ── /mywork ─────────────────────────────────────────────────────────────────────────────────

export function myWorkView(items: MyDeliverableItem[], scope: Scope, studioSlugOf: (projectId: string) => string, nowMs = Date.now()): Reply {
  const home = `${appOrigin()}/${scope.studios[0]?.slug ?? ""}`;
  if (!items.length) {
    return {
      embeds: [{ author: { name: "🧰 Your work" }, title: "Nothing on your plate", description: "You have no unfinished deliverables. 🎉", color: COLORS.done, footer: studioFooter(scope) }],
      components: scope.studios.length ? [linkRow("Open Forge", home)] : [],
    };
  }
  const overdue = items.filter((i) => i.dueAt && Date.parse(i.dueAt) < nowMs).length;
  const lines = items.map((i) => {
    const url = cardUrl(studioSlugOf(i.project.id), i.project.slug, i.board?.number, i.card.key, i.deliverable.number);
    const late = Boolean(i.dueAt && Date.parse(i.dueAt) < nowMs);
    const icon = late ? "🚨" : i.waitingOn.length ? "⛔" : STATE_ICON[i.deliverable.state];
    const status = i.waitingOn.length ? `waiting on ${escapeMarkdown(truncate(i.waitingOn.join(", "), 60))}` : STATE_TEXT[i.deliverable.state];
    return [`${icon} ${cardLink(i.card.key, i.card.title, url)}`, deliverableName(i.deliverable.name, i.card.title), status, dueText(i.dueAt, nowMs)].filter(Boolean).join(" · ");
  });
  const menu = openCardMenu(
    "Open a card to act on it…",
    items.map((i) => ({ cardId: i.card.id, label: `${i.card.key} ${i.card.title}`, description: `${i.deliverable.name} · ${STATE_TEXT[i.deliverable.state]}` })),
  );
  return {
    embeds: [
      {
        author: { name: "🧰 Your work" },
        title: `${items.length} open deliverable${items.length === 1 ? "" : "s"}${overdue ? ` · ${overdue} overdue` : ""}`,
        description: listLines(lines),
        color: overdue ? COLORS.late : COLORS.work,
        footer: studioFooter(scope),
      },
    ],
    components: [...(menu ? [menu] : []), linkRow("Open Forge", home)],
  };
}

async function myWork(scope: Scope): Promise<Reply> {
  const ids = [...scope.accesses.keys()];
  const projectRef = (id: string) => {
    const a = scope.accesses.get(id)!;
    return { id, slug: a.project.slug, name: a.project.name, icon: a.project.icon, key: a.project.key };
  };
  const items = ids.length ? await myDeliverables(scope.userId, ids, projectRef, await boardRefs(ids)) : [];
  return myWorkView(items, scope, (id) => scope.accesses.get(id)!.studioSlug);
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
  const home = `${appOrigin()}/${scope.studios[0]?.slug ?? ""}`;
  if (!items.length) {
    return {
      embeds: [{ author: { name: "📥 Your reviews" }, title: "Nothing waiting for your review", description: "When someone submits work for you to review, it shows up here.", color: COLORS.done, footer: studioFooter(scope) }],
      components: scope.studios.length ? [linkRow("Open Forge", home)] : [],
    };
  }
  const lines = items.map((i) => {
    const what = [deliverableName(i.deliverable.name, i.card.title), i.versionNumber ? `**V${i.versionNumber}**` : null].filter(Boolean).join(" ");
    const who = i.submittedBy ? `submitted by ${escapeMarkdown(truncate(i.submittedBy, 40))}` : "submitted";
    return [`📥 ${cardLink(i.card.key, i.card.title, i.url)}`, what || null, `${who}${i.submittedAt ? ` ${discordTime(i.submittedAt, "R")}` : ""}`].filter(Boolean).join(" · ");
  });
  const menu = openCardMenu(
    "Review one…",
    items.map((i) => ({ cardId: i.card.id, label: `${i.card.key} ${i.card.title}`, description: `${i.deliverable.name}${i.versionNumber ? ` V${i.versionNumber}` : ""}` })),
  );
  return {
    embeds: [
      {
        author: { name: "📥 Your reviews" },
        title: `${items.length} waiting for your review`,
        description: listLines(lines),
        color: COLORS.review,
        footer: studioFooter(scope),
      },
    ],
    components: [...(menu ? [menu] : []), linkRow("Open Forge", home)],
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
  for (const row of rows) {
    const ctx = await requireDeliverable(scope.userId, row.d.id).catch(() => null);
    if (!ctx?.dperms.canReview) continue;
    const access = scope.accesses.get(row.d.projectId)!;
    const key = `${access.project.key}-${row.card.number}`;
    items.push({
      deliverable: { id: row.d.id, number: row.d.number, name: row.d.name },
      card: { id: row.card.id, key, title: row.card.title },
      url: cardUrl(access.studioSlug, access.project.slug, row.card.boardNumber, key, row.d.number),
      versionNumber: row.versionNumber ?? null,
      submittedAt: row.submittedAt?.toISOString() ?? null,
      submittedBy: row.submittedBy ?? null,
    });
    if (items.length >= 25) break;
  }
  return reviewsView(items, scope);
}

// ── /due ────────────────────────────────────────────────────────────────────────────────────

const DAY = 86_400_000;

async function deadlines(scope: Scope, days: number, everyoneRequested: boolean): Promise<Reply> {
  let accesses = scope.accesses;
  let everyone = everyoneRequested;
  let note: string | undefined;
  if (everyone) {
    const managed = new Map([...accesses].filter(([, a]) => roleHas(a.role, "reports.view")));
    if (managed.size) accesses = managed;
    else {
      everyone = false;
      note = "The whole team's deadlines are for Managers and above — here are yours.";
    }
  }
  const at = Date.now();
  const end = at + days * DAY;
  const schedule = await loadSchedule({ userId: scope.userId }, { accesses, mineOnly: !everyone }, new Date(at - 120 * DAY).toISOString(), new Date(end).toISOString());
  const items: Array<{ due: number; dueAt: string; line: string; cardId: string; label: string; description: string; people: string[] }> = [];
  for (const card of schedule.cards) {
    const link = cardUrl(card.project.studioSlug, card.project.slug, card.board.number, card.key);
    const cardCounts = Boolean(card.dueAt && card.state !== "APPROVED" && (everyone || card.assigneeIds.includes(scope.userId)) && Date.parse(card.dueAt) <= end);
    if (cardCounts) {
      items.push({ due: Date.parse(card.dueAt!), dueAt: card.dueAt!, line: cardLink(card.key, card.title, link), cardId: card.id, label: `${card.key} ${card.title}`, description: "", people: card.assigneeIds });
    }
    for (const d of card.deliverables) {
      if (!d.dueAt || d.state === "APPROVED" || !(everyone || d.mine) || Date.parse(d.dueAt) > end) continue;
      // Following the card's deadline, it's already on the card's line.
      if (cardCounts && !d.ownDueAt) continue;
      items.push({
        due: Date.parse(d.dueAt),
        dueAt: d.dueAt,
        line: [cardLink(card.key, card.title, `${link}&d=${d.number}`), deliverableName(d.name, card.title)].filter(Boolean).join(" · "),
        cardId: card.id,
        label: `${card.key} ${card.title}`,
        description: d.name,
        people: [],
      });
    }
  }
  items.sort((a, b) => a.due - b.due);
  const names = new Map<string, string>();
  const ids = [...new Set(items.flatMap((i) => i.people))];
  if (everyone && ids.length) for (const u of await db.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, ids))) names.set(u.id, u.name);
  const overdue = items.filter((i) => i.due < at).length;
  const lines = items.map((i) => {
    const who = everyone && i.people.length ? ` · ${escapeMarkdown(truncate(i.people.map((p) => names.get(p) ?? "?").join(", "), 60))}` : "";
    return `${i.due < at ? "🚨" : "⏰"} ${i.line} · ${dueText(i.dueAt, at)}${who}`;
  });
  const calendar = `${appOrigin()}/${scope.studios[0]?.slug ?? ""}/calendar`;
  const title = items.length ? [overdue ? `${overdue} overdue` : null, items.length - overdue ? `${items.length - overdue} coming up` : null].filter(Boolean).join(" · ") : "Nothing due";
  const menu = openCardMenu("Open a card to act on it…", items.map((i) => ({ cardId: i.cardId, label: i.label, description: i.description })));
  return {
    content: note,
    embeds: [
      {
        author: { name: `📅 ${everyone ? "Team deadlines" : "Your deadlines"} · next ${days} day${days === 1 ? "" : "s"}` },
        title,
        description: items.length ? listLines(lines, 15) : `Nothing ${everyone ? "" : "of yours "}is due in the next ${days} day${days === 1 ? "" : "s"}, and nothing is overdue.`,
        color: overdue ? COLORS.late : items.length ? COLORS.review : COLORS.done,
        footer: studioFooter(scope),
      },
    ],
    components: [...(menu ? [menu] : []), ...(scope.studios.length ? [linkRow("Open calendar", calendar)] : [])],
  };
}

// ── /card and its actions ───────────────────────────────────────────────────────────────────

type Verb = "approve" | "submit" | "complete" | "publish";

interface Pending {
  verb: Verb;
  /** A deliverable (approve, submit) or the card (complete, publish). */
  id: string;
  question: string;
  confirm: string;
}

/** What this person can do to the card from Discord, from the same permissions the app uses. */
export function cardActions(detail: CardDetailDTO) {
  const deliverableActions: Array<{ kind: "review" | "submit"; id: string; name: string }> = [];
  for (const d of detail.deliverables) {
    if (d.archivedAt) continue;
    if (d.state === "NEEDS_REVIEW" && d.permissions.canReview) deliverableActions.push({ kind: "review", id: d.id, name: d.name });
    else if (d.permissions.canSubmit && d.hasFiles && (d.state === "NOT_SUBMITTED" || d.state === "IN_PROGRESS" || d.state === "CHANGES_REQUESTED")) deliverableActions.push({ kind: "submit", id: d.id, name: d.name });
  }
  const ready = detail.readiness.ready && !detail.archivedAt;
  return {
    deliverables: deliverableActions,
    complete: ready && detail.productionStatus === "TODO" && detail.permissions.canEdit,
    publish: ready && detail.productionStatus === "COMPLETED" && detail.permissions.canPublish,
  };
}

interface CardInfo {
  url: string;
  projectName: string;
  boardName: string | null;
  studioName: string;
  names: Map<string, string>;
}

export function cardView(detail: CardDetailDTO, info: CardInfo, options: { banner?: string; pending?: Pending } = {}): Reply {
  const nowMs = Date.now();
  const name = (id: string | null) => (id ? escapeMarkdown(info.names.get(id) ?? "Someone") : null);
  const live = detail.deliverables.filter((d) => !d.archivedAt);
  const versionOf = new Map(detail.versions.map((v) => [v.id, v.number]));
  const lines = [
    `**Review:** ${STATE_TEXT[detail.state]} · **Production:** ${PRODUCTION_TEXT[detail.productionStatus]}`,
    ...(detail.dueAt ? [`**Due** ${discordTime(detail.dueAt, "R")} (${discordTime(detail.dueAt, "f")})`] : []),
    ...(detail.assigneeIds.length ? [`**Assigned:** ${detail.assigneeIds.map(name).join(", ")}`] : []),
    "",
    ...live.slice(0, 12).map((d) => {
      const version = d.currentVersionId && versionOf.get(d.currentVersionId) ? ` · V${versionOf.get(d.currentVersionId)}` : "";
      const responsible = d.ownerId ? ` · ${name(d.ownerId)}` : "";
      const reviewer = d.reviewerId ? ` · reviewer ${name(d.reviewerId)}` : "";
      const waiting = d.blockedBy.length ? " · ⛔ waiting on a prerequisite" : "";
      const late = d.dueAt && d.state !== "APPROVED" && Date.parse(d.dueAt) < nowMs ? ` · 🚨 ${dueText(d.dueAt, nowMs)}` : "";
      return `${STATE_ICON[d.state]} **${escapeMarkdown(truncate(d.name, 60))}** — ${STATE_TEXT[d.state]}${version}${responsible}${reviewer}${waiting}${late}`;
    }),
    ...(live.length > 12 ? [`…and ${live.length - 12} more deliverables in Forge.`] : []),
  ];
  const embed: DiscordEmbed = {
    author: { name: truncate(`📇 ${info.projectName}${info.boardName ? ` · ${info.boardName}` : ""}`, 256) },
    title: truncate(`${detail.key} ${detail.title}`, 256),
    url: info.url,
    description: truncate(lines.join("\n"), 4000),
    color: detail.state === "APPROVED" ? COLORS.done : detail.state === "CHANGES_REQUESTED" ? COLORS.late : detail.state === "NEEDS_REVIEW" ? COLORS.review : COLORS.work,
    footer: { text: truncate(info.studioName, 2048) },
  };
  const open: Button = { type: 2, style: 5, label: "Open in Forge", url: info.url };
  const rows: Row[] = [];
  let content = options.banner;
  if (options.pending) {
    content = options.pending.question;
    rows.push({
      type: 1,
      components: [
        { type: 2, style: 3, label: truncate(options.pending.confirm, 80), custom_id: `fg:${options.pending.verb}!:${options.pending.id}` },
        { type: 2, style: 2, label: "Cancel", custom_id: `fg:open:${detail.id}` },
      ],
    });
  } else {
    const actions = cardActions(detail);
    for (const a of actions.deliverables.slice(0, 4)) {
      const label = truncate(a.name, 50);
      rows.push({
        type: 1,
        components:
          a.kind === "review"
            ? [
                { type: 2, style: 3, label: `Approve ${label}`, custom_id: `fg:approve:${a.id}`, emoji: { name: "✅" } },
                { type: 2, style: 4, label: "Request changes", custom_id: `fg:changes:${a.id}`, emoji: { name: "🔁" } },
              ]
            : [{ type: 2, style: 1, label: `Submit ${label} for review`, custom_id: `fg:submit:${a.id}`, emoji: { name: "📥" } }],
      });
    }
    const last: Button[] = [];
    if (actions.complete) last.push({ type: 2, style: 1, label: "Mark completed", custom_id: `fg:complete:${detail.id}`, emoji: { name: "🏁" } });
    if (actions.publish) last.push({ type: 2, style: 1, label: "Mark published", custom_id: `fg:publish:${detail.id}`, emoji: { name: "🚀" } });
    last.push(open);
    rows.push({ type: 1, components: last });
    if (actions.deliverables.length > 4) content = [content, `${actions.deliverables.length - 4} more deliverables need you — open the card in Forge for those.`].filter(Boolean).join("\n");
  }
  return { content, embeds: [embed], components: rows };
}

async function cardReply(userId: string, cardId: string, options: { banner?: string; pending?: Pending } = {}): Promise<Reply> {
  const ctx = await requireCard(userId, cardId);
  const detail = await loadCardDetail(ctx);
  const [board] = await db.select({ number: boards.number, name: boards.name }).from(boards).where(eq(boards.id, ctx.card.boardId));
  const ids = [...new Set([...detail.assigneeIds, ...detail.deliverables.flatMap((d) => [d.ownerId, d.reviewerId]).filter((v): v is string => Boolean(v))])];
  const names = new Map((ids.length ? await db.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, ids)) : []).map((u) => [u.id, u.name]));
  return cardView(detail, {
    url: cardUrl(ctx.access.studioSlug, ctx.access.project.slug, board?.number, detail.key),
    projectName: `${ctx.access.project.icon} ${ctx.access.project.name}`.trim(),
    boardName: board?.name ?? null,
    studioName: ctx.access.studioName,
    names,
  }, options);
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
      const [row] = await db.select({ id: cards.id }).from(cards).where(and(inArray(cards.projectId, projectIds), eq(cards.number, Number(key[2])), isNull(cards.archivedAt))).limit(1);
      if (row) return row.id;
    }
  }
  for (const studio of scope.studios.slice(0, 5)) {
    const [hit] = await searchCards(actor, { studioId: studio.id, q: q.slice(0, 100), limit: 1 });
    if (hit && scope.accesses.has(hit.project.id)) return hit.card.id;
  }
  return null;
}

/** Card suggestions while typing /card: matches among the cards this person can see; their own work when empty. */
async function suggestCards(scope: Scope, actor: Actor, query: string) {
  const q = query.trim();
  const choices: Array<{ name: string; value: string }> = [];
  const add = (id: string, label: string) => {
    if (choices.length < 25 && !choices.some((c) => c.value === id)) choices.push({ name: truncate(label, 100), value: id });
  };
  if (!q) {
    const ids = [...scope.accesses.keys()];
    if (!ids.length) return choices;
    const projectRef = (id: string) => {
      const a = scope.accesses.get(id)!;
      return { id, slug: a.project.slug, name: a.project.name, icon: a.project.icon, key: a.project.key };
    };
    for (const item of await myDeliverables(scope.userId, ids, projectRef, () => null)) add(item.card.id, `${item.card.key} ${item.card.title}`);
    return choices;
  }
  for (const studio of scope.studios.slice(0, 5)) {
    for (const hit of await searchCards(actor, { studioId: studio.id, q: q.slice(0, 100), limit: 25 })) {
      if (scope.accesses.has(hit.project.id)) add(hit.card.id, `${hit.card.key} ${hit.card.title}`);
    }
  }
  return choices;
}

/** Confirmation wording for an action, from the current state (null when it no longer applies). */
async function pendingFor(userId: string, verb: Verb, id: string): Promise<{ cardId: string; pending: Pending }> {
  if (verb === "approve" || verb === "submit") {
    const ctx = await requireDeliverable(userId, id);
    const [version] = ctx.deliverable.currentVersionId
      ? await db.select({ n: assetVersions.versionNumber }).from(assetVersions).where(eq(assetVersions.id, ctx.deliverable.currentVersionId))
      : [];
    const what = `${version ? `**V${version.n}** of ` : ""}**${escapeMarkdown(ctx.deliverable.name)}**`;
    return verb === "approve"
      ? { cardId: ctx.card.id, pending: { verb, id, question: `Approve ${what}?`, confirm: "Yes, approve" } }
      : { cardId: ctx.card.id, pending: { verb, id, question: `Submit ${what} for review?`, confirm: "Yes, submit" } };
  }
  const ctx = await requireCard(userId, id);
  return verb === "complete"
    ? { cardId: ctx.card.id, pending: { verb, id, question: `Mark **${escapeMarkdown(ctx.card.title)}** as **Completed**?`, confirm: "Yes, mark completed" } }
    : { cardId: ctx.card.id, pending: { verb, id, question: `Mark **${escapeMarkdown(ctx.card.title)}** as **Published**?`, confirm: "Yes, mark published" } };
}

/** Carries out a confirmed action as the person (the services check their permissions), then shows the card again. */
async function perform(actor: Actor, verb: Verb, id: string): Promise<Reply> {
  if (verb === "approve" || verb === "submit") {
    const ctx = await requireDeliverable(actor.userId, id);
    const label = `**${escapeMarkdown(ctx.deliverable.name)}**`;
    try {
      if (verb === "approve") await approve(actor, { deliverableId: id });
      else await submitForReview(actor, { deliverableId: id });
    } catch (error) {
      if (error instanceof AppError) return cardReply(actor.userId, ctx.card.id, { banner: `⚠️ ${escapeMarkdown(error.message)}` });
      throw error;
    }
    return cardReply(actor.userId, ctx.card.id, { banner: verb === "approve" ? `✅ You approved ${label}.` : `📥 You submitted ${label} for review.` });
  }
  try {
    await moveProduction(actor, { cardId: id, status: verb === "complete" ? "COMPLETED" : "PUBLISHED" });
  } catch (error) {
    if (error instanceof AppError) return cardReply(actor.userId, id, { banner: `⚠️ ${escapeMarkdown(error.message)}` });
    throw error;
  }
  return cardReply(actor.userId, id, { banner: verb === "complete" ? "🏁 Marked **Completed**." : "🚀 Marked **Published**." });
}

/** The "Request changes" form: what needs to change, one item per line (each becomes a feedback item). */
async function changesModal(userId: string, deliverableId: string): Promise<InteractionResponse> {
  const ctx = await requireDeliverable(userId, deliverableId);
  if (ctx.deliverable.state !== "NEEDS_REVIEW" || !ctx.dperms.canReview) {
    return respond(7, await cardReply(userId, ctx.card.id, { banner: `⚠️ ${escapeMarkdown(ctx.deliverable.name)} isn't waiting for your review any more.` }));
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

async function submitChanges(actor: Actor, deliverableId: string, text: string): Promise<Reply> {
  const ctx = await requireDeliverable(actor.userId, deliverableId);
  const items = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*•]\s*/, "").trim())
    .filter(Boolean)
    .map((line) => line.slice(0, 2000))
    .slice(0, 30);
  try {
    await requestChanges(actor, { deliverableId, items });
  } catch (error) {
    if (error instanceof AppError) return cardReply(actor.userId, ctx.card.id, { banner: `⚠️ ${escapeMarkdown(error.message)}` });
    throw error;
  }
  const notes = items.length ? ` (${items.length} feedback item${items.length === 1 ? "" : "s"})` : "";
  return cardReply(actor.userId, ctx.card.id, { banner: `🔁 You requested changes on **${escapeMarkdown(ctx.deliverable.name)}**${notes}.` });
}

// ── Dispatch ────────────────────────────────────────────────────────────────────────────────

const COMPONENT = /^fg:(open|approve|approve!|submit|submit!|changes|complete|complete!|publish|publish!):([0-9a-f-]{36})$/;

function option(interaction: Interaction, name: string) {
  return interaction.data?.options?.find((o) => o.name === name);
}

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
  if (!discordUserId || !/^\d{5,25}$/.test(discordUserId)) return send(problem("Forge couldn't tell who sent this."));
  try {
    enforceRateLimit(`discord-command:${discordUserId}`, 40, 60_000);
  } catch (error) {
    if (interaction.type === 4) return { type: 8, data: { choices: [] } };
    return send(problem(error instanceof AppError ? error.message : "Please wait a moment and try again."));
  }
  const user = await linkedUser(discordUserId);
  if (!user) return interaction.type === 4 ? { type: 8, data: { choices: [] } } : send(notLinked());
  const actor: Actor = { userId: user.id, userAgent: "Discord" };
  try {
    if (interaction.type === 4) {
      const typed = interaction.data?.options?.find((o) => o.focused)?.value;
      return { type: 8, data: { choices: await suggestCards(await scopeFor(user.id, interaction.guild_id), actor, typeof typed === "string" ? typed : "") } };
    }
    if (interaction.type === 2) {
      const scope = await scopeFor(user.id, interaction.guild_id);
      switch (interaction.data?.name) {
        case "mywork":
          return send(await myWork(scope));
        case "reviews":
          return send(await reviewQueue(scope));
        case "due": {
          const days = Number(option(interaction, "days")?.value ?? 3);
          return send(await deadlines(scope, Number.isInteger(days) ? Math.min(30, Math.max(1, days)) : 3, option(interaction, "everyone")?.value === true));
        }
        case "card": {
          const query = String(option(interaction, "card")?.value ?? "");
          const cardId = await findCard(scope, actor, query);
          if (!cardId) return send(problem(`No card you can see matches “${truncate(query, 60)}”.`));
          return send(await cardReply(user.id, cardId));
        }
        default:
          return send(problem("Forge doesn't know that command."));
      }
    }
    if (interaction.type === 3) {
      const customId = interaction.data?.custom_id ?? "";
      if (customId === "fg:pick") {
        const cardId = interaction.data?.values?.[0] ?? "";
        if (!UUID.test(cardId)) return send(problem("Choose a card from the list."));
        return send(await cardReply(user.id, cardId));
      }
      const match = COMPONENT.exec(customId);
      if (!match || !UUID.test(match[2]!)) return send(problem("That button no longer works. Run the command again."));
      const [, verb, id] = match as unknown as [string, string, string];
      if (verb === "open") return send(await cardReply(user.id, id));
      if (verb === "changes") return await changesModal(user.id, id);
      if (verb.endsWith("!")) return send(await perform(actor, verb.slice(0, -1) as Verb, id));
      const { cardId, pending } = await pendingFor(user.id, verb as Verb, id);
      return send(await cardReply(user.id, cardId, { pending }));
    }
    if (interaction.type === 5) {
      const match = /^fg:changes!:([0-9a-f-]{36})$/.exec(interaction.data?.custom_id ?? "");
      if (!match || !UUID.test(match[1]!)) return send(problem("That form no longer works. Run the command again."));
      const text = interaction.data?.components?.flatMap((row) => row.components ?? []).find((c) => c.custom_id === "items")?.value ?? "";
      return send(await submitChanges(actor, match[1]!, text.slice(0, 4000)));
    }
    return send(problem("Forge doesn't handle that kind of interaction."));
  } catch (error) {
    if (error instanceof AppError) return interaction.type === 4 ? { type: 8, data: { choices: [] } } : send(problem(error.message));
    console.error("[discord] interaction failed", error);
    return interaction.type === 4 ? { type: 8, data: { choices: [] } } : send(problem("Something went wrong on Forge's side. Please try again."));
  }
}
