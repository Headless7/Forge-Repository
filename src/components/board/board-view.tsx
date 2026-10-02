"use client";

import { DndContext, DragOverlay } from "@dnd-kit/core";
import { horizontalListSortingStrategy, SortableContext } from "@dnd-kit/sortable";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Eye, Sparkles, X } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ROBLOX_TEMPLATE } from "@/lib/column-icons";
import { CARD_STATE_META, CARD_STATE_ORDER, resolveDisplayMode } from "@/lib/card-meta";
import { cardPermissions, type Permission } from "@/lib/permissions";
import { positionBetween } from "@/lib/positions";
import { qk, useRpcMutation } from "@/lib/queries";
import { PRODUCTION_META } from "@/lib/deliverables";
import { errorMessage, rpc, RpcError } from "@/lib/rpc-client";
import type { BoardDTO, BoardView as BoardViewMode, CardDisplayMode, CardState, CardSummaryDTO, ColumnDTO, ProductionStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useHotkeys } from "@/hooks/use-hotkeys";
import { CardModal } from "../card/card-modal";
import { useRealtimeProject } from "../realtime";
import { UserAvatar } from "../domain/avatar";
import { Button } from "../ui/button";
import { useUploads } from "../upload/upload-manager";
import { ArchivedDialog } from "./archived-dialog";
import { BoardContext, pendingCardDrops, type BoardContextValue, type OpenCardOptions } from "./board-context";
import { BoardHeader } from "./board-header";
import { CardTile } from "./card-tile";
import { AddColumn, BoardColumn, type ColumnActions } from "./column";
import { activeFilterCount, EMPTY_FILTERS, hasAnyFilter, matchesFilters, parseFilters, writeFilters, type BoardFilters } from "./filters";
import { NotReadyDialog, ProductionBoard, type NotReadyInfo } from "./production-board";
import { useBoardDnd, type ItemsByColumn } from "./use-board-dnd";

const byPosition = (a: { position: number }, b: { position: number }) => a.position - b.position;

/** Files that become a new revision when dropped on a card (everything else is a reference file). */
function isMedia(file: File) {
  return (
    file.type.startsWith("image/") ||
    file.type.startsWith("video/") ||
    file.type.startsWith("audio/") ||
    /\.(png|jpe?g|gif|webp|avif|bmp|mp4|m4v|webm|mov|mkv|mp3|ogg|oga|rbxm|rbxmx|rbxl|rbxlx)$/i.test(file.name)
  );
}

export function BoardView({ initialBoard, studioSlug }: { initialBoard: BoardDTO; studioSlug: string }) {
  const projectId = initialBoard.project.id;
  const queryClient = useQueryClient();
  const uploads = useUploads();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const boardKey = qk.board(projectId);

  const { data: board } = useQuery({
    queryKey: boardKey,
    queryFn: () => rpc("board.get", { projectId }),
    initialData: initialBoard,
    staleTime: 15_000,
  });
  useRealtimeProject(projectId);

  // ── URL state: filters + open card ─────────────────────────────────────────
  const filters = useMemo(() => parseFilters(new URLSearchParams(searchParams.toString())), [searchParams]);
  const setFilters = useCallback(
    (next: BoardFilters) => {
      const params = writeFilters(next, new URLSearchParams(window.location.search));
      const query = params.toString();
      window.history.replaceState(null, "", `${pathname}${query ? `?${query}` : ""}`);
    },
    [pathname],
  );
  const cardKey = searchParams.get("card");
  const queueMode = searchParams.get("queue") === "review";
  const cardAction = searchParams.get("action");
  const focusComment = searchParams.get("comment");
  const pushedCard = useRef(false);
  useEffect(() => {
    if (!cardKey) pushedCard.current = false;
  }, [cardKey]);

  const openCard = useCallback(
    (key: string, options: OpenCardOptions = {}) => {
      if (!key || key === "…") return;
      const params = new URLSearchParams(window.location.search);
      if (params.get("card")?.toUpperCase() !== key.toUpperCase()) params.delete("d");
      params.set("card", key);
      for (const [name, value] of [["queue", options.queue], ["action", options.action], ["comment", options.comment]] as const) {
        if (value) params.set(name, value);
        else params.delete(name);
      }
      const url = `${pathname}?${params.toString()}`;
      if (params.get("card") && new URLSearchParams(window.location.search).get("card")) {
        window.history.replaceState(null, "", url);
      } else {
        window.history.pushState(null, "", url);
        pushedCard.current = true;
      }
    },
    [pathname],
  );

  const closeCard = useCallback(() => {
    if (pushedCard.current) {
      pushedCard.current = false;
      window.history.back();
      return;
    }
    const params = new URLSearchParams(window.location.search);
    for (const name of ["card", "d", "queue", "action", "comment"]) params.delete(name);
    const query = params.toString();
    window.history.replaceState(null, "", `${pathname}${query ? `?${query}` : ""}`);
  }, [pathname]);

  // ── Lookups & derived data ─────────────────────────────────────────────────
  const membersById = useMemo(() => new Map(board.members.map((m) => [m.id, m])), [board.members]);
  const labelsById = useMemo(() => new Map(board.labels.map((l) => [l.id, l])), [board.labels]);
  const columns = useMemo(() => [...board.columns].sort(byPosition), [board.columns]);
  const columnsById = useMemo(() => new Map(columns.map((c) => [c.id, c])), [columns]);
  const cardsById = useMemo(() => new Map(board.cards.map((c) => [c.id, c])), [board.cards]);
  const permissionSet = useMemo(() => new Set(board.viewer.permissions), [board.viewer.permissions]);
  const can = useCallback((p: Permission) => permissionSet.has(p) && !(board.project.archived && p !== "project.view"), [permissionSet, board.project.archived]);
  const cardPerms = useCallback(
    (card: CardSummaryDTO) => {
      const perms = cardPermissions({
        role: board.viewer.role,
        userId: board.viewer.userId,
        card: { createdById: card.createdById, assigneeIds: card.assigneeIds },
        allowSelfApproval: board.project.settings.allowSelfApproval,
      });
      if (card.id.startsWith("temp-") || board.project.archived) {
        return { ...perms, canMove: false, canEdit: false, canUpload: false, canArchive: false, canAssign: false, canSelfAssign: false };
      }
      return perms;
    },
    [board.viewer, board.project.settings.allowSelfApproval, board.project.archived],
  );

  // ── View: category columns or production stages (remembered per person) ──────
  const view: BoardViewMode = board.prefs.view ?? "CATEGORY";
  const setViewMutation = useRpcMutation("board.setView", { silent: true });
  const setView = useCallback(
    (next: BoardViewMode) => {
      queryClient.setQueryData<BoardDTO>(boardKey, (old) => (old ? { ...old, prefs: { ...old.prefs, view: next } } : old));
      setViewMutation.mutate({ projectId, view: next });
    },
    [queryClient, boardKey, setViewMutation, projectId],
  );
  const [notReady, setNotReady] = useState<NotReadyInfo | null>(null);

  const filterCtx = useMemo(() => ({ userId: board.viewer.userId, members: membersById, labels: labelsById }), [board.viewer.userId, membersById, labelsById]);
  const visibleCards = useMemo(() => board.cards.filter((c) => matchesFilters(c, filters, filterCtx)), [board.cards, filters, filterCtx]);
  const filtered = hasAnyFilter(filters);

  const totals = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of board.cards) map.set(c.columnId, (map.get(c.columnId) ?? 0) + 1);
    return map;
  }, [board.cards]);

  const derivedItems = useMemo(() => {
    const items: ItemsByColumn = {};
    for (const col of columns) items[col.id] = [];
    for (const card of [...visibleCards].sort(byPosition)) items[card.columnId]?.push(card.id);
    return items;
  }, [columns, visibleCards]);

  // Counts for header toggles reflect the milestone scope but not the other toggles.
  const scopeCards = useMemo(
    () => board.cards.filter((c) => matchesFilters(c, { ...EMPTY_FILTERS, milestone: filters.milestone }, filterCtx)),
    [board.cards, filters.milestone, filterCtx],
  );
  const stateCounts = useMemo(() => {
    const counts = Object.fromEntries(CARD_STATE_ORDER.map((s) => [s, 0])) as Record<CardState, number>;
    for (const c of scopeCards) counts[c.state] += 1;
    return counts;
  }, [scopeCards]);
  const mineCount = useMemo(() => scopeCards.filter((c) => c.assigneeIds.includes(board.viewer.userId)).length, [scopeCards, board.viewer.userId]);

  const reviewQueue = useMemo(() => {
    const order = new Map(columns.map((c, i) => [c.id, i]));
    return board.cards
      .filter((c) => c.state === "NEEDS_REVIEW" && matchesFilters(c, { ...EMPTY_FILTERS, milestone: filters.milestone }, filterCtx))
      .sort((a, b) => (order.get(a.columnId) ?? 0) - (order.get(b.columnId) ?? 0) || a.position - b.position);
  }, [board.cards, columns, filters.milestone, filterCtx]);

  // ── Cache helpers ──────────────────────────────────────────────────────────
  const patchBoard = useCallback((fn: (b: BoardDTO) => BoardDTO) => queryClient.setQueryData<BoardDTO>(boardKey, (old) => (old ? fn(old) : old)), [queryClient, boardKey]);
  const patchCard = useCallback(
    (cardId: string, patch: Partial<CardSummaryDTO>) => patchBoard((b) => ({ ...b, cards: b.cards.map((c) => (c.id === cardId ? { ...c, ...patch } : c)) })),
    [patchBoard],
  );
  const refreshBoard = useCallback(() => void queryClient.invalidateQueries({ queryKey: boardKey }), [queryClient, boardKey]);

  // ── Mutations ──────────────────────────────────────────────────────────────
  const moveCardMutation = useRpcMutation("card.move", { silent: true });
  const productionMutation = useRpcMutation("card.setProduction", { silent: true });
  const moveColumnMutation = useRpcMutation("column.move", { silent: true });

  const onMoveCard = useCallback(
    async (cardId: string, toColumnId: string, ordered: string[]) => {
      const index = ordered.indexOf(cardId);
      const afterId = ordered[index - 1] ?? null;
      const beforeId = ordered[index + 1] ?? null;
      const prev = afterId ? cardsById.get(afterId)?.position : null;
      const next = beforeId ? cardsById.get(beforeId)?.position : null;
      const optimistic = positionBetween(prev, next) ?? (prev ?? next ?? 0) + 0.001;
      await queryClient.cancelQueries({ queryKey: boardKey });
      const snapshot = queryClient.getQueryData<BoardDTO>(boardKey);
      patchCard(cardId, { columnId: toColumnId, position: optimistic });
      moveCardMutation.mutate(
        { cardId, toColumnId, afterCardId: afterId, beforeCardId: beforeId, index },
        {
          onSuccess: (result) => patchCard(cardId, { columnId: result.columnId, position: result.position }),
          onError: (error) => {
            if (snapshot) queryClient.setQueryData(boardKey, snapshot);
            toast.error(`Couldn't move the card — it was put back. ${errorMessage(error)}`);
          },
        },
      );
    },
    [cardsById, queryClient, boardKey, patchCard, moveCardMutation],
  );

  /** Moves a card between production stages (or reorders inside one). Never touches review state. */
  const moveProduction = useCallback(
    async (cardId: string, stage: ProductionStatus, hints: { afterId?: string | null; beforeId?: string | null; index?: number | null }) => {
      const card = cardsById.get(cardId);
      if (!card) return;
      const prev = hints.afterId ? cardsById.get(hints.afterId)?.productionPosition : null;
      const next = hints.beforeId ? cardsById.get(hints.beforeId)?.productionPosition : null;
      const optimistic = positionBetween(prev, next) ?? (prev ?? next ?? 0) + 0.001;
      await queryClient.cancelQueries({ queryKey: boardKey });
      const snapshot = queryClient.getQueryData<BoardDTO>(boardKey);
      patchCard(cardId, { productionStatus: stage, productionPosition: optimistic, pendingChanges: stage === "TODO" ? false : card.pendingChanges });
      productionMutation.mutate(
        { cardId, status: stage, afterCardId: hints.afterId ?? null, beforeCardId: hints.beforeId ?? null, index: hints.index ?? null },
        {
          onSuccess: (result) => {
            patchCard(cardId, { productionStatus: result.productionStatus, productionPosition: result.productionPosition });
            if (card.productionStatus !== stage) {
              toast.success(`${card.key} marked ${PRODUCTION_META[stage].label}.`);
              void queryClient.invalidateQueries({ queryKey: qk.card(cardId) });
              refreshBoard();
            }
          },
          onError: (error) => {
            if (snapshot) queryClient.setQueryData(boardKey, snapshot);
            const blockers = error instanceof RpcError ? (error.details?.blockers as NotReadyInfo["blockers"] | undefined) : undefined;
            if (blockers?.length) {
              setNotReady({ cardKey: card.key, title: card.title, target: stage, message: errorMessage(error), blockers });
            } else {
              toast.error(`Couldn't change the stage — it was put back. ${errorMessage(error)}`);
            }
          },
        },
      );
    },
    [cardsById, queryClient, boardKey, patchCard, productionMutation, refreshBoard],
  );

  const onMoveProduction = useCallback(
    (cardId: string, stage: ProductionStatus, ordered: string[]) => {
      const index = ordered.indexOf(cardId);
      void moveProduction(cardId, stage, { afterId: ordered[index - 1] ?? null, beforeId: ordered[index + 1] ?? null, index });
    },
    [moveProduction],
  );

  const onMoveColumn = useCallback(
    async (columnId: string, newOrder: string[]) => {
      const index = newOrder.indexOf(columnId);
      const afterId = newOrder[index - 1] ?? null;
      const beforeId = newOrder[index + 1] ?? null;
      const prev = afterId ? columnsById.get(afterId)?.position : null;
      const next = beforeId ? columnsById.get(beforeId)?.position : null;
      const optimistic = positionBetween(prev, next) ?? (prev ?? 0) + 0.001;
      await queryClient.cancelQueries({ queryKey: boardKey });
      const snapshot = queryClient.getQueryData<BoardDTO>(boardKey);
      patchBoard((b) => ({ ...b, columns: b.columns.map((c) => (c.id === columnId ? { ...c, position: optimistic } : c)) }));
      moveColumnMutation.mutate(
        { columnId, afterColumnId: afterId, beforeColumnId: beforeId },
        {
          onSuccess: (column) => patchBoard((b) => ({ ...b, columns: b.columns.map((c) => (c.id === columnId ? column : c)) })),
          onError: (error) => {
            if (snapshot) queryClient.setQueryData(boardKey, snapshot);
            toast.error(`Couldn't reorder columns — restored the previous order. ${errorMessage(error)}`);
          },
        },
      );
    },
    [columnsById, queryClient, boardKey, patchBoard, moveColumnMutation],
  );

  const columnOrder = useMemo(() => columns.map((c) => c.id), [columns]);
  const { items, activeId, activeType, dndProps } = useBoardDnd({ columnOrder, derivedItems, onMoveCard, onMoveColumn });

  // Quick add
  const [quickAddColumnId, setQuickAddColumnId] = useState<string | null>(null);
  const createCard = useCallback(
    async (column: ColumnDTO, title: string, open: boolean, where: "top" | "bottom" = "bottom") => {
      const tempId = `temp-${crypto.randomUUID()}`;
      const now = new Date().toISOString();
      const inColumn = board.cards.filter((c) => c.columnId === column.id);
      const milestoneId = filters.milestone && filters.milestone !== "none" ? filters.milestone : null;
      const selfAssign = filters.mine;
      patchBoard((b) => ({
        ...b,
        cards: [
          ...b.cards,
          {
            id: tempId,
            key: "…",
            number: 0,
            title,
            columnId: column.id,
            position: Math.max(0, ...inColumn.map((c) => c.position)) + 1024,
            state: "NOT_SUBMITTED",
            productionStatus: "TODO",
            productionPosition: Math.max(0, ...b.cards.filter((c) => c.productionStatus === "TODO").map((c) => c.productionPosition)) + 1024,
            progress: { total: 1, required: 1, withFiles: 0, inReview: 0, changesRequested: 0, inProgress: 0, notStarted: 1, approved: 0, approvedRequired: 0, blocked: 0 },
            pendingChanges: false,
            hasAudio: false,
            hasRoblox: false,
            priority: "NORMAL",
            displayMode: null,
            dueAt: null,
            milestoneId,
            assigneeIds: selfAssign ? [b.viewer.userId] : [],
            labelIds: [],
            cover: null,
            coverMode: "AUTO",
            counts: { comments: 0, attachments: 0, unresolvedFeedback: 0, resolvedFeedback: 0, checklistDone: 0, checklistTotal: 0, versions: 0 },
            hasVideo: false,
            hasImage: false,
            unread: false,
            createdById: b.viewer.userId,
            currentVersionNumber: null,
            updatedAt: now,
            lastActivityAt: now,
          },
        ],
      }));
      try {
        const card = await rpc("card.create", {
          projectId,
          columnId: column.id,
          title,
          milestoneId,
          assigneeIds: selfAssign ? [board.viewer.userId] : undefined,
          productionWhere: where,
        });
        patchBoard((b) => ({ ...b, cards: b.cards.map((c) => (c.id === tempId ? card : c)) }));
        if (open) {
          setQuickAddColumnId(null);
          openCard(card.key);
        }
      } catch (error) {
        patchBoard((b) => ({ ...b, cards: b.cards.filter((c) => c.id !== tempId) }));
        toast.error(errorMessage(error));
      }
    },
    [board.cards, board.viewer.userId, filters.milestone, filters.mine, patchBoard, projectId, openCard],
  );

  // Column actions
  const columnUpdate = useRpcMutation("column.update", { onError: refreshBoard });
  const columnArchive = useRpcMutation("column.archive", { onSuccess: refreshBoard });
  const columnDelete = useRpcMutation("column.delete", { onSuccess: refreshBoard });
  const columnDuplicate = useRpcMutation("column.duplicate", { onSuccess: () => { refreshBoard(); toast.success("Column duplicated."); } });
  const columnCollapse = useRpcMutation("column.collapse", { silent: true });
  const columnCreate = useRpcMutation("column.create", { onSuccess: refreshBoard });

  const columnActions = useMemo<ColumnActions>(
    () => ({
      rename: (column, name) => {
        patchBoard((b) => ({ ...b, columns: b.columns.map((c) => (c.id === column.id ? { ...c, name } : c)) }));
        columnUpdate.mutate({ columnId: column.id, name });
      },
      update: (column, patch) => {
        patchBoard((b) => ({ ...b, columns: b.columns.map((c) => (c.id === column.id ? { ...c, ...patch } : c)) }));
        columnUpdate.mutate({ columnId: column.id, ...patch });
      },
      archive: (column) => {
        patchBoard((b) => ({ ...b, columns: b.columns.filter((c) => c.id !== column.id), cards: b.cards.filter((c) => c.columnId !== column.id) }));
        columnArchive.mutate(
          { columnId: column.id, archived: true },
          {
            onSuccess: () =>
              toast(`Archived “${column.name}”`, {
                action: { label: "Undo", onClick: () => columnArchive.mutate({ columnId: column.id, archived: false }) },
              }),
          },
        );
      },
      remove: (column) => columnDelete.mutate({ columnId: column.id }),
      duplicate: (column, withCards) => columnDuplicate.mutate({ columnId: column.id, withCards }),
      toggleCollapsed: (column) => {
        const collapsed = board.prefs.collapsedColumnIds.includes(column.id);
        patchBoard((b) => ({
          ...b,
          prefs: {
            ...b.prefs,
            collapsedColumnIds: collapsed ? b.prefs.collapsedColumnIds.filter((id) => id !== column.id) : [...b.prefs.collapsedColumnIds, column.id],
          },
        }));
        columnCollapse.mutate({ columnId: column.id, collapsed: !collapsed });
      },
      createCard,
    }),
    [board.prefs.collapsedColumnIds, columnArchive, columnCollapse, columnDelete, columnDuplicate, columnUpdate, createCard, patchBoard],
  );

  // Card quick actions
  const renameMutation = useRpcMutation("card.update", { onError: refreshBoard });
  const stateMutation = useRpcMutation("card.setState", {
    onSuccess: (card) => {
      queryClient.setQueryData(qk.card(card.id), card);
      refreshBoard();
    },
    onError: refreshBoard,
  });
  const assigneeMutation = useRpcMutation("card.assignees", { onSuccess: refreshBoard, onError: refreshBoard });
  const archiveMutation = useRpcMutation("card.archive", { onError: refreshBoard });
  const duplicateMutation = useRpcMutation("card.duplicate", { onSuccess: (card) => { refreshBoard(); toast.success(`Duplicated as ${card.key}.`); } });

  // Media links are signed for a few hours; a board left open longer re-fetches them when one fails (at most every 30 s).
  const lastMediaRefresh = useRef(0);
  const refreshMedia = useCallback(() => {
    if (Date.now() - lastMediaRefresh.current < 30_000) return;
    lastMediaRefresh.current = Date.now();
    refreshBoard();
  }, [refreshBoard]);

  const boardValue = useMemo<BoardContextValue>(
    () => ({
      board,
      refreshMedia,
      view,
      studioSlug,
      membersById,
      labelsById,
      columnsById,
      cardsById,
      can,
      cardPerms,
      openCard,
      renameCard: (card, title) => {
        patchCard(card.id, { title });
        renameMutation.mutate({ cardId: card.id, title, base: { title: card.title } });
      },
      setCardState: (card, state) => {
        patchCard(card.id, { state });
        stateMutation.mutate({ cardId: card.id, state });
      },
      setProductionStage: (card, status) => void moveProduction(card.id, status, { index: 0 }),
      toggleAssignee: (card, userId) => {
        const has = card.assigneeIds.includes(userId);
        patchCard(card.id, { assigneeIds: has ? card.assigneeIds.filter((id) => id !== userId) : [...card.assigneeIds, userId] });
        assigneeMutation.mutate({ cardId: card.id, ...(has ? { remove: [userId] } : { add: [userId] }) });
      },
      archiveCard: (card) => {
        patchBoard((b) => ({ ...b, cards: b.cards.filter((c) => c.id !== card.id) }));
        archiveMutation.mutate(
          { cardId: card.id, archived: true },
          {
            onSuccess: () =>
              toast(`Archived “${card.title}”`, {
                action: { label: "Undo", onClick: () => archiveMutation.mutate({ cardId: card.id, archived: false }, { onSuccess: refreshBoard }) },
              }),
          },
        );
      },
      duplicateCard: (card) => duplicateMutation.mutate({ cardId: card.id, include: { assignees: true, labels: true, checklists: true, attachments: true } }),
      uploadToCard: (card, files) => {
        if (card.progress.total > 1) {
          // Several deliverables: the card asks which one the files belong to.
          pendingCardDrops.set(card.id, files);
          openCard(card.key);
          return;
        }
        const target = { id: card.id, projectId, title: card.title };
        const media = files.filter(isMedia);
        const other = files.filter((f) => !isMedia(f));
        if (media.length) void uploads.uploadVersion(target, media);
        if (other.length) void uploads.uploadFiles(target, other, "attachment");
      },
      startQuickAdd: (columnId) => setQuickAddColumnId(columnId),
      quickAddColumnId,
      stopQuickAdd: () => setQuickAddColumnId(null),
    }),
    [board, view, studioSlug, membersById, labelsById, columnsById, cardsById, can, cardPerms, openCard, patchCard, patchBoard, renameMutation, stateMutation, moveProduction, assigneeMutation, archiveMutation, duplicateMutation, refreshBoard, refreshMedia, projectId, uploads, quickAddColumnId],
  );

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  useHotkeys(
    {
      c: (e) => {
        const first = columns.find((c) => !board.prefs.collapsedColumnIds.includes(c.id));
        if (!first || !can("card.create")) return;
        e.preventDefault();
        setQuickAddColumnId(first.id);
        scroller.current?.scrollTo({ left: 0, behavior: "smooth" });
      },
      f: (e) => {
        e.preventDefault();
        setFiltersOpen(true);
      },
      m: () => setFilters({ ...filters, mine: !filters.mine }),
      v: () => setView(view === "CATEGORY" ? "PRODUCTION" : "CATEGORY"),
      r: () =>
        setFilters({
          ...filters,
          states: filters.states.includes("NEEDS_REVIEW") ? filters.states.filter((s) => s !== "NEEDS_REVIEW") : [...filters.states, "NEEDS_REVIEW"],
        }),
    },
    { enabled: !cardKey },
  );

  const templateColumns = async () => {
    for (const col of ROBLOX_TEMPLATE) {
      await columnCreate.mutateAsync({ projectId, name: col.name, icon: col.icon, color: col.color, defaultCardMode: col.mode }).catch(() => {});
    }
  };

  const activeCard = activeType === "card" && activeId ? cardsById.get(activeId) : undefined;
  const activeColumn = activeType === "column" && activeId ? columnsById.get(activeId) : undefined;
  const reviewView = filters.states.length === 1 && filters.states[0] === "NEEDS_REVIEW";
  const visibleCount = visibleCards.length;

  return (
    <BoardContext.Provider value={boardValue}>
      <div className={cn("flex h-full flex-col", `board-bg-${board.project.background}`)}>
        <BoardHeader
          board={board}
          studioSlug={studioSlug}
          filters={filters}
          onFiltersChange={setFilters}
          stateCounts={stateCounts}
          mineCount={mineCount}
          onCreateCard={(columnId, title) => {
            const column = columnsById.get(columnId);
            if (column) void createCard(column, title, true);
          }}
          onOpenArchived={() => setArchivedOpen(true)}
          filtersOpen={filtersOpen}
          onFiltersOpenChange={setFiltersOpen}
          view={view}
          onViewChange={setView}
        />

        {reviewView || (filtered && activeFilterCount(filters) + (filters.q ? 1 : 0) > 0) ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface/60 px-4 py-1.5 text-[12.5px]">
            {reviewView ? (
              <>
                <Eye className="size-4 text-state-review" />
                <span className="font-medium">
                  {reviewQueue.length ? `${reviewQueue.length} ${reviewQueue.length === 1 ? "item is" : "items are"} waiting for review` : "Nothing is waiting for review — nice work."}
                </span>
                {reviewQueue.length ? (
                  <div className="ml-1 hidden items-center gap-1 lg:flex">
                    {reviewQueue.slice(0, 8).map((c) => (
                      <button key={c.id} type="button" title={c.title} onClick={() => openCard(c.key, { queue: "review" })} className="h-6 w-10 overflow-hidden rounded border border-border-strong bg-surface-3">
                        {c.cover?.thumbUrl ? <img src={c.cover.thumbUrl} alt="" className="h-full w-full object-cover" /> : <span className="font-mono text-[9px] text-fg-subtle">{c.key}</span>}
                      </button>
                    ))}
                  </div>
                ) : null}
                <span className="flex-1" />
                {reviewQueue.length ? (
                  <Button size="xs" variant="primary" onClick={() => openCard(reviewQueue[0]!.key, { queue: "review" })}>
                    Start reviewing <ArrowRight />
                  </Button>
                ) : null}
              </>
            ) : (
              <>
                <span className="text-fg-muted">
                  Showing <strong className="text-fg">{visibleCount}</strong> of {board.cards.length} cards
                </span>
                {filters.mine ? <FilterChip label="My tasks" onRemove={() => setFilters({ ...filters, mine: false })} /> : null}
                {filters.states.map((s) => (
                  <FilterChip key={s} label={CARD_STATE_META[s].label} color={CARD_STATE_META[s].color} onRemove={() => setFilters({ ...filters, states: filters.states.filter((x) => x !== s) })} />
                ))}
                {filters.categories.map((id) => {
                  const col = columnsById.get(id);
                  return col ? <FilterChip key={id} label={col.name} color={col.color ?? undefined} onRemove={() => setFilters({ ...filters, categories: filters.categories.filter((x) => x !== id) })} /> : null;
                })}
                {filters.stages.map((s) => (
                  <FilterChip key={s} label={PRODUCTION_META[s].label} onRemove={() => setFilters({ ...filters, stages: filters.stages.filter((x) => x !== s) })} />
                ))}
                {filters.assignees.map((id) => {
                  const m = membersById.get(id);
                  return m ? <FilterChip key={id} label={m.displayName} avatar={<UserAvatar user={m} size="xs" />} onRemove={() => setFilters({ ...filters, assignees: filters.assignees.filter((x) => x !== id) })} /> : null;
                })}
                {filters.labels.map((id) => {
                  const l = labelsById.get(id);
                  return l ? <FilterChip key={id} label={l.name} color={l.color} onRemove={() => setFilters({ ...filters, labels: filters.labels.filter((x) => x !== id) })} /> : null;
                })}
                {filters.priorities.map((p) => (
                  <FilterChip key={p} label={`${p.charAt(0)}${p.slice(1).toLowerCase()} priority`} onRemove={() => setFilters({ ...filters, priorities: filters.priorities.filter((x) => x !== p) })} />
                ))}
                {filters.due ? <FilterChip label={{ overdue: "Overdue", today: "Due today", week: "Due in 7 days", none: "No due date" }[filters.due]} onRemove={() => setFilters({ ...filters, due: null })} /> : null}
                {filters.media ? <FilterChip label={{ video: "Has video", image: "Has image", audio: "Has audio", roblox: "Has Roblox file" }[filters.media]} onRemove={() => setFilters({ ...filters, media: null })} /> : null}
                {filters.unread ? <FilterChip label="Unread activity" onRemove={() => setFilters({ ...filters, unread: false })} /> : null}
                {filters.q ? <FilterChip label={`“${filters.q}”`} onRemove={() => setFilters({ ...filters, q: "" })} /> : null}
                <Button size="xs" variant="ghost" onClick={() => setFilters({ ...EMPTY_FILTERS, milestone: filters.milestone })}>
                  Reset filters
                </Button>
              </>
            )}
          </div>
        ) : null}

        {view === "PRODUCTION" && columns.length > 0 ? (
          <div className="min-h-0 flex-1">
            <ProductionBoard
              visibleCards={visibleCards}
              allCards={scopeCards}
              filtered={filtered}
              categoryFilter={filters.categories}
              onMove={onMoveProduction}
              onCreate={(columnId, title, open) => {
                const column = columnsById.get(columnId);
                if (column) void createCard(column, title, open);
              }}
            />
          </div>
        ) : null}
        <div ref={scroller} className={cn("scrollbar-thin min-h-0 flex-1 overflow-x-auto overflow-y-hidden max-md:snap-x max-md:snap-mandatory", view === "PRODUCTION" && columns.length > 0 && "hidden")}>
          {view === "PRODUCTION" && columns.length > 0 ? null : columns.length === 0 ? (
            <div className="flex h-full items-center justify-center p-6">
              <div className="w-full max-w-md rounded-xl border border-dashed border-border-strong bg-surface/70 p-6 text-center">
                <Sparkles className="mx-auto size-6 text-accent" />
                <h2 className="mt-3 text-[15px] font-semibold">Create your first category</h2>
                <p className="mt-1 text-[13px] text-fg-muted">Categories are the columns of your board — VFX, Animations, UI, Scripting… whatever your team works on.</p>
                {can("column.manage") ? (
                  <div className="mt-5 grid gap-2">
                    <AddColumn onCreate={(name) => columnCreate.mutate({ projectId, name })} />
                    <Button variant="ghost" size="sm" loading={columnCreate.isPending} onClick={() => void templateColumns()}>
                      Use the Roblox game template ({ROBLOX_TEMPLATE.map((c) => c.name).slice(0, 4).join(", ")}…)
                    </Button>
                  </div>
                ) : (
                  <p className="mt-4 text-[12.5px] text-fg-subtle">Ask a manager to set up the board.</p>
                )}
              </div>
            </div>
          ) : (
            <DndContext id={`board-${projectId}`} {...dndProps}>
              <SortableContext items={columnOrder} strategy={horizontalListSortingStrategy}>
                <div className="flex h-full items-start gap-3 p-3 md:p-4">
                  {columns.map((column) => (
                    <div key={column.id} className="h-full max-md:snap-start">
                      <BoardColumn
                        column={column}
                        cardIds={items[column.id] ?? []}
                        total={totals.get(column.id) ?? 0}
                        filtered={filtered}
                        collapsed={board.prefs.collapsedColumnIds.includes(column.id)}
                        actions={columnActions}
                      />
                    </div>
                  ))}
                  {can("column.manage") ? <AddColumn onCreate={(name) => columnCreate.mutate({ projectId, name })} /> : null}
                  <div className="w-1 shrink-0" />
                </div>
              </SortableContext>
              <DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" }}>
                {activeCard ? (
                  <div className="w-[272px]">
                    <CardTile card={activeCard} mode={resolveDisplayMode(activeCard, columnsById.get(activeCard.columnId), board.project)} overlay />
                  </div>
                ) : activeColumn ? (
                  <div className="flex h-24 w-[288px] items-start rounded-xl border border-border-strong bg-surface p-3 shadow-lg ring-1 ring-accent/40">
                    <span className="text-[13px] font-semibold">{activeColumn.name}</span>
                  </div>
                ) : null}
              </DragOverlay>
            </DndContext>
          )}
        </div>
      </div>

      {cardKey ? (
        <CardModal
          key={cardKey}
          cardKey={cardKey}
          queue={queueMode ? reviewQueue.map((c) => c.key) : null}
          initialAction={cardAction === "request-changes" || cardAction === "approve" ? cardAction : null}
          focusCommentId={focusComment}
          onClose={closeCard}
          onNavigate={(key) => openCard(key, { queue: queueMode ? "review" : undefined })}
        />
      ) : null}
      <NotReadyDialog
        info={notReady}
        onClose={() => setNotReady(null)}
        onOpenCard={(key) => {
          setNotReady(null);
          openCard(key);
        }}
      />
      <ArchivedDialog
        open={archivedOpen}
        onOpenChange={setArchivedOpen}
        projectId={projectId}
        canDelete={can("card.delete")}
        canRestoreColumns={can("column.manage")}
      />
    </BoardContext.Provider>
  );
}

function FilterChip({ label, onRemove, color, avatar }: { label: string; onRemove: () => void; color?: string; avatar?: React.ReactNode }) {
  return (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-md border border-border-strong bg-surface-3 pl-2 pr-1 text-[12px]">
      {avatar}
      {color ? <span className="size-2 rounded-full" style={{ backgroundColor: color }} /> : null}
      {label}
      <button type="button" onClick={onRemove} aria-label={`Remove filter ${label}`} className="rounded p-0.5 text-fg-subtle hover:bg-surface-4 hover:text-fg">
        <X className="size-3" />
      </button>
    </span>
  );
}
