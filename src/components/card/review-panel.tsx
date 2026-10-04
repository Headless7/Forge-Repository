"use client";

import { ArrowRight, Check, CircleAlert, CircleCheck, Eye, Plus, Send, Undo2, Upload, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useHotkeys } from "@/hooks/use-hotkeys";
import { useCardMutation } from "@/lib/queries";
import type { CommentDTO, ReviewDTO } from "@/lib/types";
import { cn, formatTimecode, timeAgo } from "@/lib/utils";
import { UserAvatar } from "../domain/avatar";
import { TipAnchor, useTutorial } from "../tutorial/tutorial";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/controls";
import { Dialog, DialogContent, DialogFooter } from "../ui/dialog";
import { Textarea } from "../ui/input";
import { RichText } from "../comments/rich-text";
import { useWorkspace } from "./workspace-context";

export function allFeedback(comments: CommentDTO[]) {
  return comments.filter((c) => c.kind === "FEEDBACK" && !c.parentId && !c.deletedAt);
}

function lastReview(reviews: ReviewDTO[], actions: ReviewDTO["action"][]) {
  return [...reviews].reverse().find((r) => actions.includes(r.action)) ?? null;
}

export function useReviewDialogs(initialAction: "request-changes" | "approve" | null) {
  const [dialog, setDialog] = useState<"approve" | "changes" | "submit" | null>(null);
  useEffect(() => {
    if (initialAction === "request-changes") setDialog("changes");
    if (initialAction === "approve") setDialog("approve");
  }, [initialAction]);
  return { dialog, setDialog };
}

/** Prominent banner at the top of the card: what's the review situation right now? */
export function ReviewBanner({
  onRequestChanges,
  onApprove,
  onUploadVersion,
  nextInQueue,
  onNext,
  decidedInQueue,
}: {
  onRequestChanges: () => void;
  onApprove: () => void;
  onUploadVersion: () => void;
  nextInQueue: string | null;
  onNext: () => void;
  decidedInQueue: boolean;
}) {
  const { scope, membersById, comments, focusComment, mentionSet, multi } = useWorkspace();
  const tutorial = useTutorial();
  if (!scope) return null;
  const feedback = allFeedback(scope.comments);
  const unresolved = feedback.filter((c) => !c.resolvedAt);
  const perms = scope.permissions;
  const versionOf = (id: string | null) => scope.versions.find((v) => v.id === id);

  if (decidedInQueue && nextInQueue) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-accent/40 bg-accent-soft px-4 py-3 animate-slide-up">
        <CircleCheck className="size-5 text-accent" />
        <p className="flex-1 text-[13px] font-medium">Decision saved. Ready for the next one?</p>
        <Button size="sm" variant="primary" onClick={onNext}>
          Review next <ArrowRight />
        </Button>
      </div>
    );
  }

  if (scope.state === "CHANGES_REQUESTED") {
    const review = lastReview(scope.reviews, ["CHANGES_REQUESTED"]);
    const reviewer = review?.actorId ? membersById.get(review.actorId) : undefined;
    const version = versionOf(review?.versionId ?? null);
    return (
      <section aria-label="Changes requested" className="overflow-hidden rounded-xl border border-state-changes/50 bg-state-changes/[0.07]">
        <TipAnchor
          tip="card.resolve-feedback"
          facts={{ canResolveFeedback: perms.canResolveFeedback, canUpload: perms.canUpload, canSubmit: perms.canSubmit, state: scope.state, unresolved: unresolved.length }}
        >
        <div className="flex flex-wrap items-center gap-3 border-b border-state-changes/25 px-4 py-2.5">
          <CircleAlert className="size-5 text-state-changes" />
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-semibold text-state-changes">
              Changes requested{version ? ` on V${version.number}` : ""} · {unresolved.length} unresolved
            </p>
            <p className="text-[12px] text-fg-muted">
              {reviewer ? `${reviewer.displayName} · ` : ""}
              {review ? timeAgo(review.createdAt) : null}
            </p>
          </div>
          {perms.canUpload ? (
            <Button size="sm" variant="secondary" onClick={onUploadVersion}>
              <Upload /> Upload new version
            </Button>
          ) : null}
        </div>
        </TipAnchor>
        {review?.note ? <RichText text={review.note} mentions={mentionSet} className="border-b border-state-changes/15 px-4 py-2 text-fg" /> : null}
        {unresolved.length ? (
          <ul className="divide-y divide-state-changes/10">
            {unresolved.slice(0, 8).map((c) => {
              const v = versionOf(c.versionId);
              return (
                <li key={c.id} className="flex items-start gap-2.5 px-4 py-2">
                  <Checkbox
                    className="mt-0.5"
                    checked={false}
                    disabled={!perms.canResolveFeedback}
                    onCheckedChange={() => {
                      comments.resolve(c.id, true);
                      tutorial.trigger("card.resolve-feedback");
                    }}
                    aria-label="Mark resolved"
                  />
                  <button type="button" onClick={() => focusComment(c)} className="min-h-6 min-w-0 flex-1 text-left text-[13px] hover:text-fg">
                    {c.annotation?.type === "TIMESTAMP" && c.annotation.timestampMs != null ? (
                      <span className="mr-1.5 rounded bg-state-changes/15 px-1 font-mono text-[11px] font-semibold text-state-changes">{formatTimecode(c.annotation.timestampMs)}</span>
                    ) : null}
                    {v && v.id !== scope.currentVersionId ? <span className="mr-1.5 rounded bg-surface-4 px-1 font-mono text-[10.5px] text-fg-muted">V{v.number}</span> : null}
                    <span className="text-fg">{c.body}</span>
                  </button>
                </li>
              );
            })}
            {unresolved.length > 8 ? <li className="px-4 py-2 text-[12px] text-fg-muted">+ {unresolved.length - 8} more in the feedback list</li> : null}
          </ul>
        ) : (
          <p className="px-4 py-2 text-[12.5px] text-fg-muted">All feedback is resolved — upload a new version and resubmit when ready.</p>
        )}
      </section>
    );
  }

  if (scope.state === "NEEDS_REVIEW") {
    const submission = lastReview(scope.reviews, ["SUBMITTED"]);
    const submitter = submission?.actorId ? membersById.get(submission.actorId) : undefined;
    const version = versionOf(submission?.versionId ?? null);
    return (
      <section aria-label="Waiting for review" className="flex flex-wrap items-center gap-3 rounded-xl border border-state-review/45 bg-state-review/[0.08] px-4 py-3">
        <Eye className="size-5 text-state-review" />
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-semibold text-state-review">Waiting for review{version ? ` · V${version.number}` : ""}</p>
          <p className="flex items-center gap-1.5 text-[12px] text-fg-muted">
            {submitter ? <UserAvatar user={submitter} size="xs" /> : null}
            Submitted by {submitter?.displayName ?? "someone"} {submission ? timeAgo(submission.createdAt) : ""}
            {unresolved.length ? <span className="text-state-changes">· {unresolved.length} open feedback</span> : null}
          </p>
          {submission?.note ? <p className="mt-1 text-[12.5px] text-fg">“{submission.note}”</p> : null}
        </div>
        {perms.canReview ? (
          <TipAnchor tip="card.review-decision" facts={{ canReview: perms.canReview, state: scope.state, deliverableName: multi ? scope.deliverable.name : null }}>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" className="border-state-changes/60 text-state-changes hover:bg-state-changes/10" onClick={onRequestChanges}>
                <CircleAlert /> Request changes
              </Button>
              <Button size="sm" variant="success" onClick={onApprove}>
                <Check /> Approve
              </Button>
            </div>
          </TipAnchor>
        ) : null}
      </section>
    );
  }

  if (scope.state === "APPROVED") {
    const review = lastReview(scope.reviews, ["APPROVED"]);
    const reviewer = review?.actorId ? membersById.get(review.actorId) : undefined;
    const version = versionOf(review?.versionId ?? null);
    return (
      <section aria-label="Approved" className="flex items-center gap-3 rounded-xl border border-state-approved/40 bg-state-approved/[0.07] px-4 py-2.5">
        <CircleCheck className="size-5 text-state-approved" />
        <p className="flex-1 text-[13px]">
          <span className="font-semibold text-state-approved">Approved{version ? ` · V${version.number}` : ""}</span>
          <span className="text-fg-muted">
            {" "}
            by {reviewer?.displayName ?? "a reviewer"} {review ? timeAgo(review.createdAt) : ""}
          </span>
          {review?.note ? <span className="text-fg"> — “{review.note}”</span> : null}
        </p>
      </section>
    );
  }
  return null;
}

/** Compact counts that jump to the feedback list. */
export function FeedbackSummary() {
  const { scope, scrollTo } = useWorkspace();
  if (!scope) return null;
  const feedback = allFeedback(scope.comments);
  if (!feedback.length && scope.state !== "NEEDS_REVIEW") return null;
  const unresolved = feedback.filter((c) => !c.resolvedAt).length;
  const resolved = feedback.length - unresolved;
  return (
    <button type="button" onClick={() => scrollTo("feedback")} className="flex min-h-6 flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-fg-muted hover:text-fg">
      <span className={cn("font-semibold", unresolved ? "text-state-changes" : "text-fg-muted")}>{unresolved} unresolved feedback</span>
      <span>·</span>
      <span className="text-state-approved">{resolved} resolved</span>
      {scope.state === "NEEDS_REVIEW" ? (
        <>
          <span>·</span>
          <span className="text-state-review">1 approval pending</span>
        </>
      ) : null}
    </button>
  );
}

export function ApproveDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (open: boolean) => void; onDone: () => void }) {
  const { card, scope, multi } = useWorkspace();
  const [note, setNote] = useState("");
  const [resolveAll, setResolveAll] = useState(true);
  const unresolved = scope ? allFeedback(scope.comments).filter((c) => !c.resolvedAt).length : 0;
  const approve = useCardMutation("review.approve", card.id, card.projectId, {
    onSuccess: () => {
      onOpenChange(false);
      setNote("");
      onDone();
    },
  });
  if (!scope) return null;
  const current = scope.versions.find((v) => v.id === scope.currentVersionId);
  const target = { deliverableId: scope.deliverable.id };
  const heading = multi ? `Approve ${scope.deliverable.name}${current ? ` V${current.number}` : ""}` : `Approve ${current ? `V${current.number}` : "this card"}`;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={heading} description={multi ? `${card.title} · only this deliverable is approved` : card.title}>
        <Textarea
          autoFocus
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Optional note for the team…"
          onKeyDown={(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && approve.mutate({ ...target, note, resolveOpenFeedback: resolveAll && unresolved > 0 })}
        />
        {unresolved ? (
          <label className="mt-3 flex items-center gap-2 text-[13px]">
            <Checkbox checked={resolveAll} onCheckedChange={(v) => setResolveAll(v === true)} />
            Also mark the {unresolved} open feedback item{unresolved === 1 ? "" : "s"} as resolved
          </label>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="success" loading={approve.isPending} onClick={() => approve.mutate({ ...target, note, resolveOpenFeedback: resolveAll && unresolved > 0 })}>
            <Check /> Approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RequestChangesDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (open: boolean) => void; onDone: () => void }) {
  const { card, scope, multi } = useWorkspace();
  const [note, setNote] = useState("");
  const [items, setItems] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const current = scope?.versions.find((v) => v.id === scope.currentVersionId);
  const pending = useMemo(
    () => (scope ? allFeedback(scope.comments).filter((c) => !c.resolvedAt && !c.reviewId && (!current || c.versionId === current.id || !c.versionId)) : []),
    [scope, current],
  );
  const request = useCardMutation("review.requestChanges", card.id, card.projectId, {
    onSuccess: () => {
      onOpenChange(false);
      setNote("");
      setItems([]);
      setDraft("");
      onDone();
    },
  });
  const allItems = draft.trim() ? [...items, draft.trim()] : items;
  const submit = () => scope && request.mutate({ deliverableId: scope.deliverable.id, note, items: allItems });
  const addItem = () => {
    if (!draft.trim()) return;
    setItems((list) => [...list, draft.trim()]);
    setDraft("");
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={multi && scope ? `Request changes on ${scope.deliverable.name}${current ? ` V${current.number}` : ""}` : `Request changes${current ? ` on V${current.number}` : ""}`}
        description={multi ? "Each item becomes a feedback task on this deliverable only — other deliverables are unaffected." : "Each item becomes a feedback task the artist can resolve."}
        size="lg"
      >
        {pending.length ? (
          <div className="mb-3 rounded-lg border border-border-strong bg-surface-3/50 p-3">
            <p className="text-[12px] font-semibold text-fg-muted">Included from this version ({pending.length})</p>
            <ul className="mt-1.5 grid gap-1 text-[13px]">
              {pending.map((c) => (
                <li key={c.id} className="flex gap-2">
                  {c.annotation?.timestampMs != null ? <span className="font-mono text-[11px] text-state-changes">{formatTimecode(c.annotation.timestampMs)}</span> : <span className="text-state-changes">•</span>}
                  <span className="line-clamp-1">{c.body}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="mb-1.5 text-xs font-medium text-fg-muted">Feedback items</p>
        <ul className="grid gap-1.5">
          {items.map((item, i) => (
            <li key={i} className="flex items-start gap-2 rounded-md border border-state-changes/30 bg-state-changes/[0.06] px-2.5 py-1.5 text-[13px]">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-state-changes" />
              <span className="flex-1">{item}</span>
              <button type="button" aria-label="Remove item" onClick={() => setItems((list) => list.filter((_, j) => j !== i))} className="text-fg-subtle hover:text-fg">
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex gap-2">
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                submit();
              } else if (e.key === "Enter") {
                e.preventDefault();
                addItem();
              }
            }}
            placeholder="e.g. Reduce the camera shake — press Enter to add"
            aria-label="New feedback item"
            className="h-8 flex-1 rounded-md border border-border-strong bg-surface-3 px-2.5 text-[13px] outline-none focus:border-accent"
          />
          <Button size="md" variant="secondary" onClick={addItem} disabled={!draft.trim()}>
            <Plus /> Add
          </Button>
        </div>
        <Textarea className="mt-3" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional summary for the artist…" />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="danger" loading={request.isPending} onClick={submit}>
            <CircleAlert /> Request changes{allItems.length + pending.length ? ` (${allItems.length + pending.length})` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SubmitDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { card, scope, multi } = useWorkspace();
  const [note, setNote] = useState("");
  const [versionId, setVersionId] = useState<string | null>(scope?.currentVersionId ?? null);
  useEffect(() => setVersionId(scope?.currentVersionId ?? null), [scope?.currentVersionId]);
  const submit = useCardMutation("review.submit", card.id, card.projectId, {
    onSuccess: () => {
      onOpenChange(false);
      setNote("");
    },
  });
  if (!scope) return null;
  const current = scope.versions.find((v) => v.id === versionId);
  const lastDecision = lastReview(scope.reviews, ["CHANGES_REQUESTED"]);
  const noNewVersion = scope.state === "CHANGES_REQUESTED" && lastDecision?.versionId === scope.currentVersionId && scope.currentVersionId;
  const unresolved = allFeedback(scope.comments).filter((c) => !c.resolvedAt).length;
  const blocked = scope.deliverable.blockedBy.length;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={multi ? `Submit ${scope.deliverable.name} for review` : "Submit for review"} description={card.title}>
        {blocked ? (
          <p className="mb-3 rounded-md border border-border-strong bg-surface-3/50 px-3 py-2 text-[12.5px] text-fg-muted">
            This deliverable depends on {blocked === 1 ? "a prerequisite that is" : `${blocked} prerequisites that are`} not approved yet. You can still submit — reviewers will see the dependency.
          </p>
        ) : null}
        {scope.versions.length ? (
          <div className="mb-3 flex flex-wrap gap-1.5">
            {[...scope.versions].reverse().map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => setVersionId(v.id)}
                aria-pressed={versionId === v.id}
                className={cn("h-7 rounded-md border px-2 font-mono text-[12px]", versionId === v.id ? "border-accent bg-accent-soft" : "border-border-strong hover:bg-surface-3")}
              >
                V{v.number}
                {v.id === scope.currentVersionId ? " · current" : ""}
              </button>
            ))}
          </div>
        ) : null}
        {noNewVersion ? (
          <p className="mb-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[12.5px]">
            Changes were requested on V{current?.number}. Consider uploading a new version first — you can still resubmit the same one.
          </p>
        ) : null}
        {unresolved ? (
          <p className="mb-3 rounded-md border border-state-changes/30 bg-state-changes/[0.06] px-3 py-2 text-[12.5px]">
            {unresolved} feedback item{unresolved === 1 ? " is" : "s are"} still unresolved and will stay visible to the reviewer.
          </p>
        ) : null}
        <Textarea autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed? Anything the reviewer should look at?" />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={submit.isPending} onClick={() => submit.mutate({ deliverableId: scope.deliverable.id, versionId, note })}>
            <Send /> Submit{current ? ` V${current.number}` : ""} for review
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Primary review action for the sidebar — changes with state and permissions. */
export function ReviewActions({ onApprove, onRequestChanges, onSubmit, onUploadVersion }: { onApprove: () => void; onRequestChanges: () => void; onSubmit: () => void; onUploadVersion: () => void }) {
  const { card, scope, viewerId } = useWorkspace();
  const perms = scope?.permissions;
  const withdraw = useCardMutation("review.withdraw", card.id, card.projectId);
  const reopen = useCardMutation("deliverable.setState", card.id, card.projectId);
  useHotkeys({ a: () => scope?.state === "NEEDS_REVIEW" && perms?.canReview && onApprove() });
  if (!scope || !perms) return null;
  const state = scope.state;
  // Submitting is the artist's move; reviewers can still do it on their behalf, less prominently.
  const worksOnCard =
    scope.deliverable.ownerId === viewerId || card.assigneeIds.includes(viewerId) || (card.assigneeIds.length === 0 && card.createdById === viewerId);

  return (
    <div className="grid gap-1.5">
      {state === "NEEDS_REVIEW" && perms.canReview ? (
        <>
          <Button variant="success" onClick={onApprove}>
            <Check /> Approve
          </Button>
          <Button variant="outline" className="border-state-changes/60 text-state-changes hover:bg-state-changes/10" onClick={onRequestChanges}>
            <CircleAlert /> Request changes
          </Button>
        </>
      ) : null}
      {state !== "NEEDS_REVIEW" && perms.canSubmit ? (
        <TipAnchor tip="card.upload-vs-submit" facts={{ canSubmit: perms.canSubmit, state }}>
          <Button variant={state === "APPROVED" || !worksOnCard ? "secondary" : "primary"} onClick={onSubmit}>
            <Send /> {state === "CHANGES_REQUESTED" ? "Resubmit for review" : "Submit for review"}
          </Button>
        </TipAnchor>
      ) : null}
      {state === "NEEDS_REVIEW" && perms.canSubmit && !perms.canReview ? (
        <Button variant="ghost" loading={withdraw.isPending} onClick={() => withdraw.mutate({ deliverableId: scope.deliverable.id })}>
          <Undo2 /> Withdraw submission
        </Button>
      ) : null}
      {state === "APPROVED" && perms.canReview ? (
        <Button variant="ghost" loading={reopen.isPending} onClick={() => reopen.mutate({ deliverableId: scope.deliverable.id, state: "IN_PROGRESS" })}>
          <Undo2 /> Reopen for more work
        </Button>
      ) : null}
      {perms.canUpload ? (
        <Button variant="secondary" onClick={onUploadVersion}>
          <Upload /> Upload new version
        </Button>
      ) : null}
    </div>
  );
}
