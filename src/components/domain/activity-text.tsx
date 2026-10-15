import type { ReactNode } from "react";
import { ITEM_RESOLUTION_META, priorityLabel, statusLabel } from "@/lib/forum-meta";
import { CARD_STATE_META, PRIORITY_META } from "@/lib/card-meta";
import { formatDueDay } from "@/lib/checklist";
import type { ActivityDTO, CardState, ForumKind, ItemPriority, ItemResolution, ItemStatus, Priority } from "@/lib/types";
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
  const noun = typeof d.noun === "string" && d.noun ? d.noun : "item";
  const kind = (typeof d.kind === "string" ? d.kind : "CUSTOM") as ForumKind;
  const item = withCard ? <strong className="font-medium text-fg">{event.item ? `${event.item.key} ${event.item.title}` : `a ${noun}`}</strong> : `this ${noun}`;
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
      return d.demo ? <>added a demonstration clip ({s(d.filename)})</> : <>attached {s(d.filename)}</>;
    case "version.file_added":
      return <>added {s(d.filename)} to{v(d)}{d.deliverable ? <> of <strong className="font-medium text-fg">{s(d.deliverable)}</strong></> : null}</>;
    case "attachment.removed":
      return <>removed {s(d.filename)} from{v(d)}{d.deliverable ? <> of <strong className="font-medium text-fg">{s(d.deliverable)}</strong></> : null}</>;
    case "attachment.restored":
      return <>put {s(d.filename)} back in{v(d)}{d.deliverable ? <> of <strong className="font-medium text-fg">{s(d.deliverable)}</strong></> : null}</>;
    case "card.linked":
      return d.deliverable ? (
        <>shared <strong className="font-medium text-fg">{s(d.deliverable)}</strong> from {s(d.cardKey)} here{d.needed ? " (needed to complete this card)" : ""}</>
      ) : (
        <>linked <strong className="font-medium text-fg">{s(d.cardKey)} {s(d.cardTitle)}</strong></>
      );
    case "card.linked_from":
      return d.deliverable ? (
        <>shared <strong className="font-medium text-fg">{s(d.deliverable)}</strong> with {s(d.cardKey)} {s(d.cardTitle)}</>
      ) : (
        <>linked this card from <strong className="font-medium text-fg">{s(d.cardKey)} {s(d.cardTitle)}</strong></>
      );
    case "card.unlinked":
      return d.deliverable ? <>stopped sharing <strong className="font-medium text-fg">{s(d.deliverable)}</strong> from {s(d.cardKey)}</> : <>removed the link to {s(d.cardKey)} {s(d.cardTitle)}</>;
    case "card.unlinked_from":
      return d.deliverable ? <>stopped sharing <strong className="font-medium text-fg">{s(d.deliverable)}</strong> with {s(d.cardKey)}</> : <>removed the link from {s(d.cardKey)} {s(d.cardTitle)}</>;
    case "card.link_needed":
      return d.needed ? (
        <>made this card wait for <strong className="font-medium text-fg">{s(d.deliverable)}</strong> from {s(d.cardKey)} to be approved</>
      ) : (
        <>stopped this card waiting for <strong className="font-medium text-fg">{s(d.deliverable)}</strong> from {s(d.cardKey)}</>
      );
    case "card.link_removed":
      return <>deleted {d.deliverable ? <><strong className="font-medium text-fg">{s(d.deliverable)}</strong> on {s(d.cardKey)}</> : <strong className="font-medium text-fg">{s(d.cardKey)} {s(d.cardTitle)}</strong>} for good, so its link here was removed</>;
    case "demo.cleared":
      return <>removed {d.count === 1 ? "the demonstration clip" : `${d.count} demonstration clips`} on publish to free storage</>;
    case "card.cover_changed":
      return d.mode === "AUTO" ? <>set the cover back to automatic</> : d.mode === "NONE" ? <>removed the cover</> : <>set the cover to {s(d.filename)}</>;
    case "deliverable.cover_changed": {
      const of = <strong className="font-medium text-fg">{s(d.deliverable)}</strong>;
      return d.mode === "AUTO" ? <>set the cover of {of} back to automatic</> : d.mode === "NONE" ? <>removed the cover of {of}</> : <>set the cover of {of} to {s(d.filename)}</>;
    }
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
    case "checklist.item_assigned":
      return d.userId ? <>gave the checklist item “{s(d.item)}” to <strong className="font-medium text-fg">{resolveUser(s(d.userId))}</strong></> : <>took the person off the checklist item “{s(d.item)}”</>;
    case "checklist.item_due":
      return d.to ? <>set the checklist item “{s(d.item)}” due {formatDueDay(s(d.to))}</> : <>removed the due date of the checklist item “{s(d.item)}”</>;
    case "checklist.item_done":
      return <>ticked off the checklist item “{s(d.item)}”</>;
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
    case "card.start_changed":
      return d.to ? <>set the start of {it} to {formatShortDate(s(d.to))}</> : <>removed the start date of {it}</>;
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
    case "forum.created":
      return <>created the forum <strong className="font-medium text-fg">{s(d.forumName)}</strong></>;
    case "forum.renamed":
      return <>renamed the forum {s(d.from)} to {s(d.to)}</>;
    case "forum.archived":
      return <>archived the forum {s(d.forumName)}</>;
    case "forum.restored":
      return <>restored the forum {s(d.forumName)}</>;
    case "item.created":
      return <>reported {item}{d.milestoneName ? <> for <strong className="font-medium text-fg">{s(d.milestoneName)}</strong></> : null}{withCard && event.item ? <> in {event.item.forumName}</> : null}</>;
    case "item.renamed":
      return <>renamed {withCard ? `a ${noun}` : `this ${noun}`} from “{s(d.from)}” to “{s(d.to)}”</>;
    case "item.description_changed":
      return <>updated the description{withCard ? <> of {item}</> : null}</>;
    case "item.status_changed": {
      const to = s(d.to) as ItemStatus;
      const reason = to === "CLOSED" && d.resolution ? <> ({ITEM_RESOLUTION_META[s(d.resolution) as ItemResolution]?.label ?? s(d.resolution)})</> : null;
      if (to === "IN_PROGRESS" && (d.from === "FIXED" || d.from === "VERIFIED" || d.from === "CLOSED")) return <>sent {item} back</>;
      if (to === "IN_PROGRESS") return <>started on {item}</>;
      if (to === "FIXED") return <>marked {item} {kind === "BUGS" ? "fixed" : "done"} — waiting for verification</>;
      if (to === "VERIFIED") return <>verified {item}</>;
      if (to === "CLOSED") return <>closed {item}{reason}</>;
      if (to === "OPEN") return <>reopened {item}</>;
      return <>set {item} to {(["OPEN", "IN_PROGRESS", "FIXED", "VERIFIED", "CLOSED"] as string[]).includes(to) ? statusLabel(kind, to).label : s(d.to)}</>;
    }
    case "item.priority_changed":
      return <>set the priority{withCard ? <> of {item}</> : null} to {(["LOW", "MEDIUM", "HIGH", "GAME_BREAKING"] as string[]).includes(s(d.to)) ? priorityLabel(kind, s(d.to) as ItemPriority) : s(d.to)}</>;
    case "item.due_changed":
      return d.to ? <>changed the due date{withCard ? <> of {item}</> : null} to {formatShortDate(s(d.to))}</> : <>removed the due date{withCard ? <> of {item}</> : null}</>;
    case "item.milestone_changed":
      return d.to ? <>moved {item} into <strong className="font-medium text-fg">{s(d.to)}</strong></> : <>took {item} out of its update</>;
    case "item.assignee_changed":
      return d.userId ? <>gave {item} to <strong className="font-medium text-fg">{resolveUser(s(d.userId))}</strong></> : <>unassigned {item}</>;
    case "item.reviewer_changed":
      return d.userId ? <>made <strong className="font-medium text-fg">{resolveUser(s(d.userId))}</strong> the reviewer{withCard ? <> of {item}</> : null}</> : <>removed the reviewer{withCard ? <> of {item}</> : null}</>;
    case "item.tags_changed":
      return <>updated the tags{withCard ? <> of {item}</> : null}</>;
    case "item.attachment_added":
      return <>added {s(d.kind) === "VIDEO" ? "a clip" : "a picture"}{withCard ? <> to {item}</> : null} ({s(d.filename)})</>;
    case "item.attachment_removed":
      return <>removed {s(d.filename)}{withCard ? <> from {item}</> : null}</>;
    case "item.commented":
      return <>commented{withCard ? <> on {item}</> : null}{d.excerpt ? <>: “{s(d.excerpt)}”</> : null}</>;
    default:
      return <>{event.type.replace(/[._]/g, " ")}</>;
  }
}
