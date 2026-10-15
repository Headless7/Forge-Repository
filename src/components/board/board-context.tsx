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
  /** Opened from this card's link (its key and board number): the card offers the way back. */
  from?: string;
  fromBoard?: number;
  /** A new history entry even when a card is open (following a link), so Back returns to it. */
  push?: boolean;
}

/** Cards opened on top of the board in this tab's history (each following a link adds one). */
export function cardDepth(): number {
  const depth = (window.history.state as { forgeCardDepth?: unknown } | null)?.forgeCardDepth;
  return typeof depth === "number" && depth > 0 ? depth : 0;
}

// Links followed in this tab, newest last: "back" retraces them through the browser history.
const LINK_STEPS = "forge:link-steps";
type LinkStep = { from: string; to: string };

function readSteps(): LinkStep[] {
  try {
    const parsed: unknown = JSON.parse(window.sessionStorage.getItem(LINK_STEPS) ?? "[]");
    return Array.isArray(parsed) ? (parsed as LinkStep[]) : [];
  } catch {
    return [];
  }
}

function writeSteps(steps: LinkStep[]) {
  try {
    window.sessionStorage.setItem(LINK_STEPS, JSON.stringify(steps.slice(-20)));
  } catch {
    // Blocked storage: "back" opens the card instead of stepping back.
  }
}

export function rememberLinkStep(step: LinkStep) {
  writeSteps([...readSteps(), step]);
}

/** True (and forgotten) when the last link followed went from `from` to `to`: the browser's previous entry is that card. */
export function takeLinkStep(step: LinkStep): boolean {
  const steps = readSteps();
  const last = steps.at(-1);
  if (!last || last.from.toUpperCase() !== step.from.toUpperCase() || last.to.toUpperCase() !== step.to.toUpperCase()) return false;
  writeSteps(steps.slice(0, -1));
  return true;
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
