"use client";

import { createContext, useContext } from "react";
import type { CardPermissions, Permission } from "@/lib/permissions";
import type { BoardDTO, BoardView, CardState, CardSummaryDTO, ColumnDTO, LabelDTO, MemberDTO, ProductionStatus } from "@/lib/types";

export interface OpenCardOptions {
  queue?: "review";
  action?: "request-changes" | "approve";
  comment?: string;
  /** Open this deliverable (by number) inside the card. */
  deliverable?: number;
}

/** Files dropped on a card with several deliverables wait here until the card asks which deliverable they belong to. */
export const pendingCardDrops = new Map<string, File[]>();

export interface BoardContextValue {
  board: BoardDTO;
  view: BoardView;
  studioSlug: string;
  membersById: Map<string, MemberDTO>;
  labelsById: Map<string, LabelDTO>;
  columnsById: Map<string, ColumnDTO>;
  cardsById: Map<string, CardSummaryDTO>;
  can: (permission: Permission) => boolean;
  cardPerms: (card: CardSummaryDTO) => CardPermissions;
  openCard: (key: string, options?: OpenCardOptions) => void;
  renameCard: (card: CardSummaryDTO, title: string) => void;
  setCardState: (card: CardSummaryDTO, state: CardState) => void;
  setProductionStage: (card: CardSummaryDTO, status: ProductionStatus) => void;
  /** Moves a card to the end of another column (the no-drag alternative). */
  moveCardToColumn: (card: CardSummaryDTO, columnId: string) => void;
  /** Moves a card to another board of the project (top of its first column). */
  moveCardToBoard: (card: CardSummaryDTO, boardId: string) => void;
  toggleAssignee: (card: CardSummaryDTO, userId: string) => void;
  archiveCard: (card: CardSummaryDTO) => void;
  duplicateCard: (card: CardSummaryDTO) => void;
  uploadToCard: (card: CardSummaryDTO, files: File[]) => void;
  /** A signed media URL stopped working (expired): fetch fresh ones. */
  refreshMedia: () => void;
  startQuickAdd: (columnId: string) => void;
  quickAddColumnId: string | null;
  stopQuickAdd: () => void;
}

export const BoardContext = createContext<BoardContextValue | null>(null);

export function useBoard(): BoardContextValue {
  const ctx = useContext(BoardContext);
  if (!ctx) throw new Error("useBoard must be used inside a board");
  return ctx;
}
