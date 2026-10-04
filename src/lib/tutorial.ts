/**
 * Contextual tutorial tips: one short lesson shown beside a feature the first time someone
 * meaningfully uses it. Shared by the server (validating saved progress) and the client (copy and
 * eligibility).
 *
 * Ids are stable: copy edits keep the id and version. Bump `version` only when the workflow changes
 * enough that people who dismissed the old tip need fresh guidance.
 *
 * `eligible` receives facts taken from the effective permissions on screen (project overrides,
 * assignments, deliverable ownership, self-approval, archived/read-only), and copy never offers an
 * action the viewer can't take.
 */
import type { CardState, ProductionStatus } from "./types";

export type TipSide = "top" | "right" | "bottom" | "left";

export interface TipDefinition<F> {
  version: number;
  title: (facts: F) => string;
  body: (facts: F) => string;
  eligible: (facts: F) => boolean;
  side: TipSide;
  align: "start" | "center" | "end";
}

type None = Record<string, never>;

/** What each tip's anchor reports about the current context. */
export interface TipFacts {
  "board.status": None;
  "board.my-work": { worksOnCount: number };
  "board.boards": { boardCount: number };
  /** On a card, only once production matters there: ready to complete, or already recorded. */
  "production.stages": { place: "board" | "card"; relevant: boolean };
  /** `ready`: the schedule has loaded, so the copy is settled before the tip shows. */
  "schedule.dates": { view: "timeline" | "calendar"; canEditAny: boolean; ready: boolean };
  "dashboard.reading": None;
  "card.workspace": None;
  "card.deliverables": { deliverableCount: number };
  "card.canvas": { deliverableCount: number };
  "card.revisions": { revisionCount: number };
  "card.feedback": { canComment: boolean; media: "image" | "timed" | "other" };
  "card.upload-vs-submit": { canSubmit: boolean; state: CardState };
  "card.review-decision": { canReview: boolean; state: CardState; deliverableName: string | null };
  "card.resolve-feedback": { canResolveFeedback: boolean; canUpload: boolean; canSubmit: boolean; state: CardState; unresolved: number };
  "card.attachments": { place: "attachments" | "cover"; canUpload: boolean; canEdit: boolean };
  "card.pending-changes": { pendingCount: number; status: ProductionStatus; canPublish: boolean };
  "card.assignment": { canAssign: boolean; multi: boolean };
  "roblox.preview": None;
  "access.scope": { place: "studio" | "project"; canManage: boolean };
}

export type TipId = keyof TipFacts;

const always = () => true;

export const TIPS: { [K in TipId]: TipDefinition<TipFacts[K]> } = {
  "board.status": {
    version: 1,
    title: () => "Columns are categories, not status",
    body: () =>
      "Columns group cards by type of work, so moving a card never changes its review status. Status — Needs review, Changes requested, Approved — changes only through submissions and review decisions; filter by it here.",
    eligible: always,
    side: "bottom",
    align: "end",
  },
  "board.my-work": {
    version: 1,
    title: () => "Find your work",
    body: () => "My tasks narrows this board to cards you're assigned to or work on a deliverable of. Home lists your work across every project, and My calendar shows your deadlines.",
    eligible: (f) => f.worksOnCount > 0,
    side: "bottom",
    align: "start",
  },
  "board.boards": {
    version: 1,
    title: () => "Each board is its own space",
    body: () => "Boards have their own columns and cards, while members, labels and milestones are shared across the project. Search finds cards on every board.",
    eligible: (f) => f.boardCount > 1,
    side: "bottom",
    align: "start",
  },
  "production.stages": {
    version: 1,
    title: () => "Approval and production are separate",
    body: () =>
      "Reviews approve revisions; the production stage — To-do, Completed, Published — tracks release and only moves on once every required deliverable is approved. Completing or publishing records those approved revisions, and Published doesn't deploy anything to Roblox.",
    eligible: (f) => f.place === "board" || f.relevant,
    side: "bottom",
    align: "start",
  },
  "schedule.dates": {
    version: 1,
    title: () => "Planned dates",
    body: (f) =>
      f.view === "timeline"
        ? `Bars run from start to deadline; deliverables without their own dates follow the card's and show dashed.${f.canEditAny ? " Drag a bar to reschedule, or select it to set exact dates." : ""}`
        : `Cards appear on their deadlines; a deliverable gets its own entry only when it has its own dates, otherwise it follows the card's.${f.canEditAny ? " Select an item to change its dates." : ""}`,
    eligible: (f) => f.ready,
    side: "bottom",
    align: "start",
  },
  "dashboard.reading": {
    version: 1,
    title: () => "Every number opens its list",
    body: () =>
      "Needs attention flags overdue, blocked, unassigned and stale work, and workload counts each person's open deliverables — select any number to see the cards behind it. Milestone forecasts are estimates from the last 28 days of approvals.",
    eligible: always,
    side: "bottom",
    align: "start",
  },
  "card.workspace": {
    version: 1,
    title: () => "One card, one piece of work",
    body: () => "A card keeps everything for one piece of work together: its files and revisions, who's assigned and reviewing, the feedback, and every decision along the way.",
    eligible: always,
    side: "bottom",
    align: "start",
  },
  "card.deliverables": {
    version: 1,
    title: () => "Deliverables move independently",
    body: () => "Each deliverable has its own owner, revisions and approval, so one can be approved while another is still in progress. Open one to see its files and feedback.",
    eligible: (f) => f.deliverableCount > 1,
    side: "bottom",
    align: "start",
  },
  "card.canvas": {
    version: 1,
    title: () => "Dependencies and associations",
    body: () => "An arrow is a dependency: the deliverable it points to stays blocked until the other is approved. A plain line is an association — related work that doesn't block anything.",
    eligible: (f) => f.deliverableCount > 1,
    side: "bottom",
    align: "end",
  },
  "card.revisions": {
    version: 1,
    title: () => "Earlier revisions keep their feedback",
    body: () => "Earlier revisions stay here with the feedback left on them, so you can see what changed and why. Approvals always point to a specific revision.",
    eligible: (f) => f.revisionCount > 1,
    side: "bottom",
    align: "start",
  },
  "card.feedback": {
    version: 1,
    title: () => "Feedback or comment?",
    body: (f) =>
      `Feedback is a to-do that stays open until it's resolved, so reviewers can see what's outstanding; comments are discussion only.${
        f.media === "image" ? " Click the image to pin feedback to a spot." : f.media === "timed" ? " Feedback is stamped at the moment you pause on." : ""
      }`,
    eligible: (f) => f.canComment,
    side: "top",
    align: "start",
  },
  "card.upload-vs-submit": {
    version: 1,
    title: () => "Uploaded, not yet submitted",
    body: () => "A new revision doesn't ask anyone to review it. When it's ready, choose Submit for review — the reviewer then decides on that revision.",
    eligible: (f) => f.canSubmit && f.state !== "NEEDS_REVIEW",
    side: "left",
    align: "start",
  },
  "card.review-decision": {
    version: 1,
    title: () => "Deciding on a submission",
    body: (f) =>
      f.deliverableName
        ? `Your decision applies only to ${f.deliverableName}'s submitted revision; the card's other deliverables are reviewed separately. Request changes sends it back with your open feedback as the to-do list.`
        : "Approve records the submitted revision as the approved one. Request changes sends it back with your open feedback as the to-do list.",
    eligible: (f) => f.canReview && f.state === "NEEDS_REVIEW",
    side: "bottom",
    align: "end",
  },
  "card.resolve-feedback": {
    version: 1,
    title: () => "Resolving isn't approving",
    body: (f) =>
      `Tick feedback off as you address it so everyone can see what's left. Resolving doesn't approve anything${
        f.canUpload && f.canSubmit
          ? " — upload a new revision and resubmit it for a decision."
          : f.canSubmit
            ? " — resubmit for review when the work is ready."
            : " — a reviewer still decides on the next revision."
      }`,
    eligible: (f) => f.canResolveFeedback && f.state === "CHANGES_REQUESTED" && f.unresolved > 0,
    side: "bottom",
    align: "start",
  },
  "card.attachments": {
    version: 1,
    title: () => "Attachments aren't revisions",
    body: () =>
      "Attachments hold reference material — briefs, place files, docs — and aren't reviewed. Work for review goes in as a new revision of a deliverable, and the cover only sets the picture on the board.",
    eligible: (f) => (f.place === "cover" ? f.canEdit : f.canUpload),
    side: "top",
    align: "start",
  },
  "card.pending-changes": {
    version: 1,
    title: () => "Changed since it was recorded",
    body: (f) =>
      `The revisions recorded when this card was ${f.status === "PUBLISHED" ? "published" : "completed"} stay as they were, and new work isn't treated as released.${
        f.canPublish ? " Once the new revisions are approved, record them with a new completion or publication." : ""
      }`,
    eligible: (f) => f.pendingCount > 0 && f.status !== "TODO",
    side: "left",
    align: "start",
  },
  "card.assignment": {
    version: 1,
    title: () => "Who's responsible",
    body: (f) =>
      f.multi
        ? "Card assignees are responsible for the work and get its updates. Giving a deliverable its own owner or contributors makes them responsible for just that part."
        : "Assignees are responsible for this card and get its updates. If you split the work into several deliverables, each one can have its own owner.",
    eligible: (f) => f.canAssign,
    side: "left",
    align: "start",
  },
  "roblox.preview": {
    version: 1,
    title: () => "Inspecting Roblox files",
    body: () =>
      "Explorer & details shows the file's parts and properties, and Resources lists meshes or textures that couldn't be loaded. The browser preview approximates some lighting and materials — Fidelity lists what may differ from Roblox Studio.",
    eligible: always,
    side: "bottom",
    align: "end",
  },
  "access.scope": {
    version: 1,
    title: () => "Whole studio or specific projects",
    body: (f) =>
      f.place === "studio"
        ? "Whole-studio members can open every project shared with the studio; private projects also need Developer or above, or an invitation. Projects-only collaborators see just the projects they're added to, whatever their role."
        : "Studio roles apply here by default, and a project role overrides it for this project only. Private projects and projects-only collaborators need to be added here to get access.",
    eligible: (f) => f.canManage,
    side: "bottom",
    align: "start",
  },
};

export const TIP_IDS = Object.keys(TIPS) as TipId[];

export function isTipId(value: string): value is TipId {
  return Object.prototype.hasOwnProperty.call(TIPS, value);
}

/** Saved progress: the version of each tip the person has dismissed. */
export type TutorialProgress = Record<string, number>;

export interface TutorialStateDTO {
  enabled: boolean;
  seen: TutorialProgress;
}

export function tipEligible<K extends TipId>(tip: K, facts: TipFacts[K]): boolean {
  return TIPS[tip].eligible(facts);
}

/** Dismissed at (or beyond) the current version. */
export function tipSeen(progress: TutorialProgress, tip: TipId): boolean {
  return (progress[tip] ?? 0) >= TIPS[tip].version;
}
