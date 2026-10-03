import type { ReactNode } from "react";
import { CARD_STATE_META, PRIORITY_META } from "@/lib/card-meta";
import type { ActivityDTO, CardState, Priority } from "@/lib/types";
import { formatShortDate } from "@/lib/utils";

type D = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const v = (d: D) => (d.versionNumber ? ` V${s(d.versionNumber)}` : "");

/**
 * Human-readable sentence for an activity event. `withCard` includes the card
 * name (project feed); card history omits it ("moved this card …").
 */
export function describeActivity(event: ActivityDTO, resolveUser: (id: string) => string, withCard: boolean): ReactNode {
  const d = event.data as D;
  const card = withCard && event.card ? <strong className="font-medium text-fg">{event.card.title}</strong> : null;
  const it = card ?? "this card";
  switch (event.type) {
    case "card.created":
      return <>created {card ?? "this card"}{d.columnName ? <> in <strong className="font-medium text-fg">{s(d.columnName)}</strong></> : null}</>;
    case "card.moved":
      return d.toBoardName ? (
        <>moved {it} to <strong className="font-medium text-fg">{s(d.toName)}</strong> on the <strong className="font-medium text-fg">{s(d.toBoardName)}</strong> board</>
      ) : (
        <>moved {it} from <strong className="font-medium text-fg">{s(d.fromName)}</strong> to <strong className="font-medium text-fg">{s(d.toName)}</strong></>
      );
    case "card.renamed":
      return <>renamed {withCard ? "a card" : "this card"} from “{s(d.from)}” to “{s(d.to)}”</>;
    case "card.archived":
      return <>archived {it}</>;
    case "card.restored":
      return <>restored {it}</>;
    case "card.duplicated":
      return <>created {it} by duplicating {s(d.sourceKey)}</>;
    case "card.assignee_added":
      return <>assigned <strong className="font-medium text-fg">{resolveUser(s(d.userId))}</strong>{withCard ? <> to {card}</> : null}</>;
    case "card.assignee_removed":
      return <>unassigned <strong className="font-medium text-fg">{resolveUser(s(d.userId))}</strong>{withCard ? <> from {card}</> : null}</>;
    case "card.reviewer_added":
      return <>added <strong className="font-medium text-fg">{resolveUser(s(d.userId))}</strong> as reviewer</>;
    case "card.reviewer_removed":
      return <>removed <strong className="font-medium text-fg">{resolveUser(s(d.userId))}</strong> as reviewer</>;
    case "card.due_changed":
      return d.to ? <>changed the due date{withCard ? <> of {card}</> : null} to {formatShortDate(s(d.to))}</> : <>removed the due date{withCard ? <> of {card}</> : null}</>;
    case "card.priority_changed":
      return <>set priority to {PRIORITY_META[s(d.to) as Priority]?.label ?? s(d.to)}</>;
    case "card.milestone_changed":
      return d.to ? <>moved {it} into {s(d.to)}</> : <>removed the milestone</>;
    case "card.labels_changed":
      return <>updated labels</>;
    case "card.description_changed":
      return <>updated the description</>;
    case "card.state_changed":
      return <>changed status to {CARD_STATE_META[s(d.to) as CardState]?.label ?? s(d.to)}</>;
    case "version.uploaded":
      return <>uploaded{v(d)}{withCard ? <> of {card}</> : null}</>;
    case "attachment.added":
      return <>attached {s(d.filename)}</>;
    case "card.cover_changed":
      return d.mode === "AUTO" ? <>set the cover back to automatic</> : d.mode === "NONE" ? <>removed the cover</> : <>set the cover to {s(d.filename)}</>;
    case "review.submitted":
      return <>submitted {it}{v(d)} for review</>;
    case "review.approved":
      return <>approved {it}{v(d)}</>;
    case "review.changes_requested":
      return <>requested changes on {it}{v(d)}{d.feedbackCount ? ` (${s(d.feedbackCount)} feedback)` : ""}</>;
    case "review.withdrawn":
      return <>withdrew the review submission</>;
    case "review.reopened":
      return <>reopened {it} for more work</>;
    case "feedback.resolved":
      return <>resolved feedback “{s(d.excerpt)}”</>;
    case "feedback.reopened":
      return <>reopened feedback “{s(d.excerpt)}”</>;
    case "checklist.completed":
      return <>completed the checklist “{s(d.checklistTitle)}”{withCard ? <> on {card}</> : null}</>;
    case "column.created":
      return <>created the category <strong className="font-medium text-fg">{s(d.columnName)}</strong></>;
    case "column.renamed":
      return <>renamed the category {s(d.from)} to {s(d.to)}</>;
    case "column.archived":
      return <>archived the category {s(d.columnName)}</>;
    case "column.restored":
      return <>restored the category {s(d.columnName)}</>;
    case "column.duplicated":
      return <>duplicated a category as {s(d.columnName)}</>;
    case "board.created":
      return <>created the board <strong className="font-medium text-fg">{s(d.boardName)}</strong></>;
    case "board.renamed":
      return <>renamed the board {s(d.from)} to {s(d.to)}</>;
    case "board.archived":
      return <>archived the board {s(d.boardName)}</>;
    case "board.restored":
      return <>restored the board {s(d.boardName)}</>;
    case "project.created":
      return d.template ? <>created the project from {s(d.template)}</> : <>created the project</>;
    default:
      return <>{event.type.replace(/[._]/g, " ")}</>;
  }
}
