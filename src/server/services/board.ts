import { and, asc, count, eq, inArray, isNotNull, isNull, max, ne, sql } from "drizzle-orm";
import { ROBLOX_TEMPLATE } from "@/lib/column-icons";
import { permissionsFor, roleHas } from "@/lib/permissions";
import { POSITION_GAP, positionBetween, resolveInsertIndex, spacedPositions } from "@/lib/positions";
import type { BoardDTO, BoardSummaryDTO, BoardView, CardDisplayMode, ColumnDTO, LabelDTO, MilestoneDTO, ProjectDTO } from "@/lib/types";
import { assertProjectPermission, getProjectAccessBySlug, requireProject, type ProjectAccess, type ProjectRow } from "../access";
import { db, type Executor } from "../db";
import { boardColumns, boards, cards, labels, milestones, notifications, projects, userBoardPrefs } from "../db/schema";
import { invalid, notFound } from "../errors";
import { now } from "../clock";
import { logActivity } from "./activity";
import { summarizeCards } from "./card-dto";
import type { Actor } from "./context";
import { Effects } from "./effects";
import { listProjectMembers } from "./members-query";

export type ColumnRow = typeof boardColumns.$inferSelect;
export type BoardRow = typeof boards.$inferSelect;

export function projectToDTO(p: ProjectRow): ProjectDTO {
  return {
    id: p.id,
    studioId: p.studioId,
    name: p.name,
    slug: p.slug,
    key: p.key,
    description: p.description,
    icon: p.icon,
    color: p.color,
    background: p.background,
    visibility: p.visibility,
    defaultCardMode: p.defaultCardMode,
    settings: p.settings,
    archived: Boolean(p.archivedAt),
  };
}

export function columnToDTO(c: ColumnRow): ColumnDTO {
  return {
    id: c.id,
    name: c.name,
    icon: c.icon,
    color: c.color,
    position: c.position,
    defaultCardMode: c.defaultCardMode,
  };
}

export function milestoneToDTO(m: typeof milestones.$inferSelect): MilestoneDTO {
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    dueAt: m.dueAt?.toISOString() ?? null,
    releasedAt: m.releasedAt?.toISOString() ?? null,
    archived: Boolean(m.archivedAt),
  };
}

export function boardToDTO(b: BoardRow, cardCount = 0): BoardSummaryDTO {
  return { id: b.id, number: b.number, name: b.name, description: b.description, position: b.position, cards: cardCount };
}

/** The project's default board: the first active one in switcher order. */
export async function defaultBoard(projectId: string, ex: Executor = db): Promise<BoardRow> {
  const rows = await ex
    .select()
    .from(boards)
    .where(and(eq(boards.projectId, projectId), isNull(boards.archivedAt)))
    .orderBy(asc(boards.position), asc(boards.number))
    .limit(1);
  if (!rows[0]) throw notFound("Board");
  return rows[0];
}

export async function defaultBoardId(projectId: string, ex: Executor = db): Promise<string> {
  return (await defaultBoard(projectId, ex)).id;
}

/** Active boards in switcher order with their active card counts — no board contents. */
export async function listBoards(projectId: string, ex: Executor = db): Promise<BoardSummaryDTO[]> {
  const [rows, counts] = await Promise.all([
    ex
      .select()
      .from(boards)
      .where(and(eq(boards.projectId, projectId), isNull(boards.archivedAt)))
      .orderBy(asc(boards.position), asc(boards.number)),
    ex
      .select({ boardId: cards.boardId, n: count() })
      .from(cards)
      .innerJoin(boardColumns, eq(boardColumns.id, cards.columnId))
      .where(and(eq(cards.projectId, projectId), isNull(cards.archivedAt), isNull(boardColumns.archivedAt)))
      .groupBy(cards.boardId),
  ]);
  const byBoard = new Map(counts.map((c) => [c.boardId, c.n]));
  return rows.map((b) => boardToDTO(b, byBoard.get(b.id) ?? 0));
}

/** A board of the project by id or number (active or archived); null when it isn't this project's. */
export async function findBoard(projectId: string, ref: { boardId?: string | null; number?: number | null }, ex: Executor = db): Promise<BoardRow | null> {
  if (!ref.boardId && !ref.number) return null;
  const rows = await ex
    .select()
    .from(boards)
    .where(and(eq(boards.projectId, projectId), ref.boardId ? eq(boards.id, ref.boardId) : eq(boards.number, ref.number!)))
    .limit(1);
  return rows[0] ?? null;
}

/** The board a request is about: the one named, or the project's default. Archived boards can't be opened. */
async function resolveBoard(access: ProjectAccess, ref: { boardId?: string | null; number?: number | null }, ex: Executor = db): Promise<BoardRow> {
  if (!ref.boardId && !ref.number) return defaultBoard(access.project.id, ex);
  const board = await findBoard(access.project.id, ref, ex);
  if (!board) throw notFound("Board");
  if (board.archivedAt) throw invalid("This board is archived. Restore it from Archived items to open it.");
  return board;
}

async function buildBoard(access: ProjectAccess, boardRow: BoardRow): Promise<BoardDTO> {
  const project = access.project;
  const boardId = boardRow.id;
  const [columnRows, cardRows, labelRows, milestoneRows, members, prefRows, boardList] = await Promise.all([
    db
      .select()
      .from(boardColumns)
      .where(and(eq(boardColumns.boardId, boardId), isNull(boardColumns.archivedAt)))
      .orderBy(asc(boardColumns.position)),
    db
      .select({ card: cards })
      .from(cards)
      .innerJoin(boardColumns, eq(boardColumns.id, cards.columnId))
      .where(and(eq(cards.boardId, boardId), isNull(cards.archivedAt), isNull(boardColumns.archivedAt)))
      .orderBy(asc(cards.position)),
    db.select().from(labels).where(eq(labels.projectId, project.id)).orderBy(asc(labels.name)),
    db
      .select()
      .from(milestones)
      .where(eq(milestones.projectId, project.id))
      .orderBy(asc(milestones.position), asc(milestones.createdAt)),
    listProjectMembers(project),
    db
      .select()
      .from(userBoardPrefs)
      .where(and(eq(userBoardPrefs.userId, access.userId), eq(userBoardPrefs.boardId, boardId))),
    listBoards(project.id),
  ]);

  const summaries = await summarizeCards(
    cardRows.map((r) => r.card),
    access.userId,
    new Map([[project.id, project.key]]),
  );

  return {
    project: projectToDTO(project),
    boardId,
    board: boardList.find((b) => b.id === boardId) ?? boardToDTO(boardRow, summaries.length),
    boards: boardList,
    columns: columnRows.map(columnToDTO),
    cards: summaries,
    members,
    labels: labelRows.map((l): LabelDTO => ({ id: l.id, name: l.name, color: l.color })),
    milestones: milestoneRows.map(milestoneToDTO),
    viewer: { userId: access.userId, role: access.role, permissions: permissionsFor(access.role) },
    prefs: { collapsedColumnIds: prefRows[0]?.collapsedColumnIds ?? [], view: prefRows[0]?.view ?? "CATEGORY" },
  };
}

/** A board's contents (the project's default board when none is named). */
export async function getBoard(actor: Actor, projectId: string, boardId?: string | null): Promise<BoardDTO> {
  const access = await requireProject(actor.userId, projectId, "project.view");
  return buildBoard(access, await resolveBoard(access, { boardId }));
}

export type BoardPage =
  | { status: "ok"; board: BoardDTO }
  /** The board exists but is archived: say so instead of a bare 404. */
  | { status: "archived"; project: ProjectDTO; boardId: string; boardName: string; canRestore: boolean };

/**
 * A board page by its URL (/studio/project or /studio/project/b/<number>); null when the project
 * or board doesn't exist or the person can't open it — the two look the same from outside.
 */
export async function getBoardPage(actor: Actor, studioSlug: string, projectSlug: string, boardNumber?: number | null): Promise<BoardPage | null> {
  const access = await getProjectAccessBySlug(actor.userId, studioSlug, projectSlug);
  if (!access) return null;
  if (!boardNumber) return { status: "ok", board: await buildBoard(access, await defaultBoard(access.project.id)) };
  const board = await findBoard(access.project.id, { number: boardNumber });
  if (!board) return null;
  if (board.archivedAt) {
    return {
      status: "archived",
      project: projectToDTO(access.project),
      boardId: board.id,
      boardName: board.name,
      canRestore: roleHas(access.role, "board.manage") && !access.project.archivedAt,
    };
  }
  return { status: "ok", board: await buildBoard(access, board) };
}

/** Project settings and other project-level pages: the project shown through its default board. */
export async function getBoardBySlug(actor: Actor, studioSlug: string, projectSlug: string): Promise<BoardDTO | null> {
  const access = await getProjectAccessBySlug(actor.userId, studioSlug, projectSlug);
  if (!access) return null;
  return buildBoard(access, await defaultBoard(access.project.id));
}

/**
 * Which board a card lives on, by its key ("UTD-12") — so project links (?card=UTD-12) open on the
 * right board. Null when the card doesn't exist in the project.
 */
export async function boardOfCard(projectId: string, projectKey: string, cardKey: string): Promise<{ number: number; archived: boolean } | null> {
  const match = /^([A-Za-z0-9]+)-(\d+)$/.exec(cardKey.trim());
  if (!match || match[1]!.toUpperCase() !== projectKey.toUpperCase()) return null;
  const rows = await db
    .select({ number: boards.number, archivedAt: boards.archivedAt })
    .from(cards)
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .where(and(eq(cards.projectId, projectId), eq(cards.number, Number(match[2]))))
    .limit(1);
  return rows[0] ? { number: rows[0].number, archived: Boolean(rows[0].archivedAt) } : null;
}

// ── Boards ──────────────────────────────────────────────────────────────────

async function loadBoard(actor: Actor, boardId: string, ex: Executor = db) {
  const rows = await ex.select().from(boards).where(eq(boards.id, boardId)).limit(1);
  const board = rows[0];
  if (!board) throw notFound("Board");
  const access = await requireProject(actor.userId, board.projectId, "board.manage", ex);
  return { board, access };
}

async function boardPositionAt(projectId: string, ex: Executor, hints: { afterId?: string | null; beforeId?: string | null; index?: number | null }, excludeId?: string) {
  const list = async () =>
    (
      await ex
        .select({ id: boards.id, position: boards.position })
        .from(boards)
        .where(and(eq(boards.projectId, projectId), isNull(boards.archivedAt)))
        .orderBy(asc(boards.position), asc(boards.number))
    ).filter((b) => b.id !== excludeId);
  let rows = await list();
  const index = resolveInsertIndex(rows, hints);
  let position = positionBetween(rows[index - 1]?.position, rows[index]?.position);
  if (position === null) {
    const spaced = spacedPositions(rows.length);
    for (let i = 0; i < rows.length; i++) await ex.update(boards).set({ position: spaced[i]! }).where(eq(boards.id, rows[i]!.id));
    rows = await list();
    position = positionBetween(rows[index - 1]?.position, rows[index]?.position)!;
  }
  return position;
}

/** Hands out the project's next board number (never reused, so old links never point elsewhere). */
async function nextBoardNumber(ex: Executor, projectId: string): Promise<number> {
  const [row] = await ex
    .update(projects)
    .set({ boardCounter: sql`${projects.boardCounter} + 1` })
    .where(eq(projects.id, projectId))
    .returning({ n: projects.boardCounter });
  if (!row) throw notFound("Project");
  return row.n;
}

/** Inserts a board (inside the caller's transaction) with the next number, at the end of the switcher. */
export async function insertBoard(
  ex: Executor,
  input: { projectId: string; name: string; description?: string; createdById: string | null; position?: number },
): Promise<BoardRow> {
  const number = await nextBoardNumber(ex, input.projectId);
  const position = input.position ?? (await boardPositionAt(input.projectId, ex, {}));
  const [row] = await ex
    .insert(boards)
    .values({ projectId: input.projectId, number, name: input.name.trim() || "Board", description: input.description?.trim() ?? "", position, createdById: input.createdById })
    .returning();
  return row!;
}

export type BoardColumnsSetup = "empty" | "roblox" | { copyFromBoardId: string };

/** Adds a board with no columns, the Roblox starter columns, or a copy of another board's columns (never its cards). */
export async function createBoard(actor: Actor, input: { projectId: string; name: string; description?: string; columns?: BoardColumnsSetup }): Promise<BoardSummaryDTO> {
  const access = await requireProject(actor.userId, input.projectId, "board.manage");
  const fx = new Effects();
  const board = await db.transaction(async (tx) => {
    const row = await insertBoard(tx, { projectId: access.project.id, name: input.name, description: input.description, createdById: actor.userId });
    const setup = input.columns ?? "empty";
    if (setup === "roblox") {
      await tx.insert(boardColumns).values(
        ROBLOX_TEMPLATE.map((c, i) => ({
          boardId: row.id,
          projectId: access.project.id,
          name: c.name,
          icon: c.icon,
          color: c.color,
          defaultCardMode: c.mode,
          position: (i + 1) * POSITION_GAP,
          createdById: actor.userId,
        })),
      );
    } else if (typeof setup === "object") {
      const source = await findBoard(access.project.id, { boardId: setup.copyFromBoardId }, tx);
      if (!source) throw notFound("Board");
      const columns = await tx
        .select()
        .from(boardColumns)
        .where(and(eq(boardColumns.boardId, source.id), isNull(boardColumns.archivedAt)))
        .orderBy(asc(boardColumns.position));
      if (columns.length) {
        await tx.insert(boardColumns).values(
          columns.map((c) => ({
            boardId: row.id,
            projectId: access.project.id,
            name: c.name,
            icon: c.icon,
            color: c.color,
            defaultCardMode: c.defaultCardMode,
            position: c.position,
            createdById: actor.userId,
          })),
        );
      }
    }
    await logActivity(tx, { studioId: access.studioId, projectId: access.project.id, actorId: actor.userId, type: "board.created", data: { boardId: row.id, boardName: row.name } });
    fx.project(access.project.id);
    return row;
  });
  fx.flush(actor.clientId);
  return boardToDTO(board);
}

export async function updateBoard(actor: Actor, input: { boardId: string; name?: string; description?: string }): Promise<BoardSummaryDTO> {
  const { board, access } = await loadBoard(actor, input.boardId);
  const patch: Partial<BoardRow> = {};
  if (input.name !== undefined) patch.name = input.name.trim() || board.name;
  if (input.description !== undefined) patch.description = input.description.trim();
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx.update(boards).set(patch).where(eq(boards.id, board.id)).returning();
    if (patch.name && patch.name !== board.name) {
      await logActivity(tx, {
        studioId: access.studioId,
        projectId: access.project.id,
        actorId: actor.userId,
        type: "board.renamed",
        data: { boardId: board.id, from: board.name, to: patch.name },
      });
    }
    return row!;
  });
  new Effects().project(access.project.id).flush(actor.clientId);
  return boardToDTO(updated);
}

export async function moveBoard(actor: Actor, input: { boardId: string; afterBoardId?: string | null; beforeBoardId?: string | null; index?: number | null }): Promise<BoardSummaryDTO> {
  const { board, access } = await loadBoard(actor, input.boardId);
  if (board.archivedAt) throw invalid("Restore the board before reordering it.");
  const updated = await db.transaction(async (tx) => {
    const position = await boardPositionAt(access.project.id, tx, { afterId: input.afterBoardId, beforeId: input.beforeBoardId, index: input.index }, board.id);
    const [row] = await tx.update(boards).set({ position }).where(eq(boards.id, board.id)).returning();
    return row!;
  });
  new Effects().project(access.project.id).flush(actor.clientId);
  return boardToDTO(updated);
}

/**
 * Archiving a board hides it with its columns and cards (and their notifications); restoring brings
 * everything back as it was. A project always keeps at least one active board.
 */
export async function setBoardArchived(actor: Actor, input: { boardId: string; archived: boolean }) {
  const { board, access } = await loadBoard(actor, input.boardId);
  const fx = new Effects();
  await db.transaction(async (tx) => {
    // Serialise board archiving per project, so two people can't archive the last two boards at once.
    await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, access.project.id)).for("update");
    if (input.archived) {
      const others = await tx
        .select({ id: boards.id })
        .from(boards)
        .where(and(eq(boards.projectId, access.project.id), isNull(boards.archivedAt), ne(boards.id, board.id)))
        .limit(1);
      if (!others.length) throw invalid("A project needs at least one board. Create another board before archiving this one.");
    }
    const patch = input.archived
      ? { archivedAt: now(), archivedById: actor.userId }
      : { archivedAt: null, archivedById: null, position: await boardPositionAt(access.project.id, tx, {}, board.id) };
    await tx.update(boards).set(patch).where(eq(boards.id, board.id));
    await logActivity(tx, {
      studioId: access.studioId,
      projectId: access.project.id,
      actorId: actor.userId,
      type: input.archived ? "board.archived" : "board.restored",
      data: { boardId: board.id, boardName: board.name },
    });
    fx.project(access.project.id);
    // Notifications about the board's work leave (or return to) people's inboxes right away.
    const people = await tx
      .selectDistinct({ userId: notifications.userId })
      .from(notifications)
      .innerJoin(cards, eq(cards.id, notifications.cardId))
      .where(eq(cards.boardId, board.id));
    fx.notify(people.map((p) => p.userId));
  });
  fx.flush(actor.clientId);
  return { ok: true };
}

/** Archived boards of a project (for Archived items). */
export async function listArchivedBoards(projectId: string, ex: Executor = db) {
  return ex
    .select()
    .from(boards)
    .where(and(eq(boards.projectId, projectId), isNotNull(boards.archivedAt)))
    .orderBy(asc(boards.number));
}

export async function boardsByIds(ids: string[], ex: Executor = db) {
  if (!ids.length) return new Map<string, BoardRow>();
  const rows = await ex.select().from(boards).where(inArray(boards.id, ids));
  return new Map(rows.map((b) => [b.id, b]));
}

// ── Columns ─────────────────────────────────────────────────────────────────

async function loadColumn(actor: Actor, columnId: string, ex: Executor = db) {
  const rows = await ex.select().from(boardColumns).where(eq(boardColumns.id, columnId)).limit(1);
  const column = rows[0];
  if (!column) throw notFound("Column");
  const access = await requireProject(actor.userId, column.projectId, undefined, ex);
  return { column, access };
}

async function activeColumns(boardId: string, ex: Executor, excludeId?: string) {
  const rows = await ex
    .select({ id: boardColumns.id, position: boardColumns.position })
    .from(boardColumns)
    .where(and(eq(boardColumns.boardId, boardId), isNull(boardColumns.archivedAt)))
    .orderBy(asc(boardColumns.position));
  return excludeId ? rows.filter((r) => r.id !== excludeId) : rows;
}

/** Computes a position at `index`, rebalancing the list when floating-point gaps run out. */
async function columnPositionAt(
  boardId: string,
  ex: Executor,
  hints: { afterId?: string | null; beforeId?: string | null; index?: number | null },
  excludeId?: string,
): Promise<number> {
  let list = await activeColumns(boardId, ex, excludeId);
  const index = resolveInsertIndex(list, hints);
  let position = positionBetween(list[index - 1]?.position, list[index]?.position);
  if (position === null) {
    const spaced = spacedPositions(list.length);
    for (let i = 0; i < list.length; i++) {
      await ex.update(boardColumns).set({ position: spaced[i]! }).where(eq(boardColumns.id, list[i]!.id));
    }
    list = await activeColumns(boardId, ex, excludeId);
    position = positionBetween(list[index - 1]?.position, list[index]?.position)!;
  }
  return position;
}

export async function createColumn(
  actor: Actor,
  input: {
    projectId: string;
    /** The board to add it to; the project's default board when omitted. */
    boardId?: string | null;
    name: string;
    icon?: string | null;
    color?: string | null;
    defaultCardMode?: CardDisplayMode | null;
    afterColumnId?: string | null;
    index?: number | null;
  },
): Promise<ColumnDTO> {
  const access = await requireProject(actor.userId, input.projectId, "column.manage");
  const fx = new Effects();
  const column = await db.transaction(async (tx) => {
    const board = await resolveBoard(access, { boardId: input.boardId }, tx);
    const position = await columnPositionAt(board.id, tx, { afterId: input.afterColumnId, index: input.index });
    const [row] = await tx
      .insert(boardColumns)
      .values({
        boardId: board.id,
        projectId: access.project.id,
        name: input.name.trim(),
        icon: input.icon ?? null,
        color: input.color ?? null,
        defaultCardMode: input.defaultCardMode ?? null,
        position,
        createdById: actor.userId,
      })
      .returning();
    await logActivity(tx, {
      studioId: access.studioId,
      projectId: access.project.id,
      actorId: actor.userId,
      type: "column.created",
      data: { columnId: row!.id, columnName: row!.name, boardId: board.id },
    });
    fx.project(access.project.id);
    return row!;
  });
  fx.flush(actor.clientId);
  return columnToDTO(column);
}

export async function updateColumn(
  actor: Actor,
  input: {
    columnId: string;
    name?: string;
    icon?: string | null;
    color?: string | null;
    defaultCardMode?: CardDisplayMode | null;
  },
): Promise<ColumnDTO> {
  const { column, access } = await loadColumn(actor, input.columnId);
  assertProjectPermission(access, "column.manage");
  const patch: Partial<ColumnRow> = {};
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.icon !== undefined) patch.icon = input.icon;
  if (input.color !== undefined) patch.color = input.color;
  if (input.defaultCardMode !== undefined) patch.defaultCardMode = input.defaultCardMode;
  const fx = new Effects();
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx.update(boardColumns).set(patch).where(eq(boardColumns.id, column.id)).returning();
    if (patch.name && patch.name !== column.name) {
      await logActivity(tx, {
        studioId: access.studioId,
        projectId: access.project.id,
        actorId: actor.userId,
        type: "column.renamed",
        data: { columnId: column.id, from: column.name, to: patch.name },
      });
    }
    return row!;
  });
  fx.project(access.project.id).flush(actor.clientId);
  return columnToDTO(updated);
}

export async function moveColumn(
  actor: Actor,
  input: { columnId: string; afterColumnId?: string | null; beforeColumnId?: string | null; index?: number | null },
): Promise<ColumnDTO> {
  const { column, access } = await loadColumn(actor, input.columnId);
  assertProjectPermission(access, "column.manage");
  const updated = await db.transaction(async (tx) => {
    const position = await columnPositionAt(
      column.boardId,
      tx,
      { afterId: input.afterColumnId, beforeId: input.beforeColumnId, index: input.index },
      column.id,
    );
    const [row] = await tx.update(boardColumns).set({ position }).where(eq(boardColumns.id, column.id)).returning();
    return row!;
  });
  new Effects().project(access.project.id).flush(actor.clientId);
  return columnToDTO(updated);
}

export async function setColumnArchived(actor: Actor, input: { columnId: string; archived: boolean }) {
  const { column, access } = await loadColumn(actor, input.columnId);
  assertProjectPermission(access, "column.manage");
  const fx = new Effects();
  await db.transaction(async (tx) => {
    const patch = input.archived
      ? { archivedAt: now() }
      : { archivedAt: null, position: await columnPositionAt(column.boardId, tx, {}, column.id) };
    await tx.update(boardColumns).set(patch).where(eq(boardColumns.id, column.id));
    await logActivity(tx, {
      studioId: access.studioId,
      projectId: access.project.id,
      actorId: actor.userId,
      type: input.archived ? "column.archived" : "column.restored",
      data: { columnId: column.id, columnName: column.name },
    });
    fx.project(access.project.id);
    // Cards in an archived column are archived work: their notifications follow the column.
    const people = await tx
      .selectDistinct({ userId: notifications.userId })
      .from(notifications)
      .innerJoin(cards, eq(cards.id, notifications.cardId))
      .where(eq(cards.columnId, column.id));
    fx.notify(people.map((p) => p.userId));
  });
  fx.flush(actor.clientId);
  return { ok: true };
}

/** Permanently removes an empty column (columns holding cards must be archived instead). */
export async function deleteColumn(actor: Actor, input: { columnId: string }) {
  const { column, access } = await loadColumn(actor, input.columnId);
  assertProjectPermission(access, "project.update");
  const remaining = await db.select({ id: cards.id }).from(cards).where(eq(cards.columnId, column.id)).limit(1);
  if (remaining.length) throw invalid("Only empty columns can be deleted. Archive the column instead, or move its cards first.");
  await db.delete(boardColumns).where(eq(boardColumns.id, column.id));
  new Effects().project(access.project.id).flush(actor.clientId);
  return { ok: true };
}

export async function duplicateColumn(actor: Actor, input: { columnId: string; withCards: boolean }): Promise<ColumnDTO> {
  const { column, access } = await loadColumn(actor, input.columnId);
  assertProjectPermission(access, "column.manage");
  const { duplicateCardInTx } = await import("./cards");
  const fx = new Effects();
  const copy = await db.transaction(async (tx) => {
    const position = await columnPositionAt(column.boardId, tx, { afterId: column.id });
    const [row] = await tx
      .insert(boardColumns)
      .values({
        boardId: column.boardId,
        projectId: column.projectId,
        name: `${column.name} (copy)`,
        icon: column.icon,
        color: column.color,
        defaultCardMode: column.defaultCardMode,
        position,
        createdById: actor.userId,
      })
      .returning();
    if (input.withCards) {
      const sourceCards = await tx
        .select()
        .from(cards)
        .where(and(eq(cards.columnId, column.id), isNull(cards.archivedAt)))
        .orderBy(asc(cards.position));
      for (const source of sourceCards) {
        await duplicateCardInTx(tx, actor, access, source, {
          toColumnId: row!.id,
          position: source.position,
          keepTitle: true,
          include: { assignees: true, labels: true, checklists: true, attachments: true },
        });
      }
    }
    await logActivity(tx, {
      studioId: access.studioId,
      projectId: access.project.id,
      actorId: actor.userId,
      type: "column.duplicated",
      data: { columnId: row!.id, sourceColumnId: column.id, columnName: row!.name },
    });
    return row!;
  });
  fx.project(access.project.id).flush(actor.clientId);
  return columnToDTO(copy);
}

export async function setColumnCollapsed(actor: Actor, input: { columnId: string; collapsed: boolean }) {
  const { column } = await loadColumn(actor, input.columnId);
  const existing = await db
    .select()
    .from(userBoardPrefs)
    .where(and(eq(userBoardPrefs.userId, actor.userId), eq(userBoardPrefs.boardId, column.boardId)));
  const set = new Set(existing[0]?.collapsedColumnIds ?? []);
  if (input.collapsed) set.add(column.id);
  else set.delete(column.id);
  const collapsedColumnIds = [...set];
  await db
    .insert(userBoardPrefs)
    .values({ userId: actor.userId, boardId: column.boardId, collapsedColumnIds })
    .onConflictDoUpdate({ target: [userBoardPrefs.userId, userBoardPrefs.boardId], set: { collapsedColumnIds } });
  return { collapsedColumnIds };
}

/** Remembers, per board, whether this person looks at it by category or by production stage. */
export async function setBoardView(actor: Actor, input: { projectId: string; boardId?: string | null; view: BoardView }) {
  const access = await requireProject(actor.userId, input.projectId, "project.view");
  const board = await resolveBoard(access, { boardId: input.boardId });
  await db
    .insert(userBoardPrefs)
    .values({ userId: actor.userId, boardId: board.id, view: input.view })
    .onConflictDoUpdate({ target: [userBoardPrefs.userId, userBoardPrefs.boardId], set: { view: input.view } });
  return { view: input.view };
}

export async function nextCardPosition(columnId: string, ex: Executor, where: "top" | "bottom" = "bottom") {
  if (where === "bottom") {
    const rows = await ex.select({ value: max(cards.position) }).from(cards).where(eq(cards.columnId, columnId));
    return positionBetween(rows[0]?.value ?? null, null)!;
  }
  const rows = await ex
    .select({ position: cards.position })
    .from(cards)
    .where(and(eq(cards.columnId, columnId), isNull(cards.archivedAt)))
    .orderBy(asc(cards.position))
    .limit(1);
  return positionBetween(null, rows[0]?.position ?? null)!;
}
