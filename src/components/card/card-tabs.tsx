"use client";

import { useQuery } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, Eye, History, MessageSquare, Send, Undo2, Activity as ActivityIcon, Workflow } from "lucide-react";
import { useMemo } from "react";
import { VERSION_STATUS_META } from "@/lib/card-meta";
import { PRODUCTION_META } from "@/lib/deliverables";
import { qk } from "@/lib/queries";
import { rpc } from "@/lib/rpc-client";
import type { CommentDTO, ReviewDTO, VersionDTO } from "@/lib/types";
import { cn, formatDateTime, timeAgo } from "@/lib/utils";
import { Composer } from "../comments/composer";
import { CommentThread } from "../comments/comment-thread";
import { describeActivity } from "../domain/activity-text";
import { UserAvatar } from "../domain/avatar";
import { PRODUCTION_COLOR, PRODUCTION_ICONS } from "../domain/production";
import { StatePill } from "../domain/state";
import { Button } from "../ui/button";
import { Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/controls";
import { useWorkspace } from "./workspace-context";

/**
 * Discussion for one scope: the whole card (overview), one deliverable (focus), or —
 * on a simple card — both at once, since the card and its only deliverable are one piece of work.
 */
function discussionThreads(comments: CommentDTO[], scope: string | null, merged: boolean) {
  return comments.filter(
    (c) => !c.parentId && c.kind === "DISCUSSION" && !c.annotation && (merged || (scope === null ? c.deliverableId === null : c.deliverableId === scope)),
  );
}

function Discussion({ scopeId, merged }: { scopeId: string | null; merged: boolean }) {
  const { card, members, uploadTarget, comments, multi, deliverables } = useWorkspace();
  const threads = discussionThreads(card.comments, scopeId, merged);
  const scopeName = scopeId ? deliverables.find((d) => d.id === scopeId)?.name : null;
  return (
    <div className="grid gap-1">
      {multi ? (
        <p className="px-2 pb-1 text-[12px] text-fg-subtle">
          {scopeName ? `Discussion about ${scopeName} only. File-specific notes live in the feedback panel.` : "Discussion about the card as a whole. Each deliverable has its own discussion."}
        </p>
      ) : null}
      {threads.length === 0 ? <p className="px-2 py-4 text-[12.5px] text-fg-muted">No discussion yet. Questions, links and non-blocking notes go here.</p> : null}
      {threads.map((c) => (
        <CommentThread
          key={c.id}
          comment={c}
          versionLabel={c.versionId ? `V${card.versions.find((v) => v.id === c.versionId)?.number ?? "?"}` : null}
        />
      ))}
      {card.permissions.canComment ? (
        <div className="mt-2">
          <Composer
            members={members}
            card={uploadTarget}
            placeholder={scopeName ? `Discuss ${scopeName}… (@ to mention)` : "Ask a question or share a note… (@ to mention)"}
            onSubmit={({ body, attachmentIds }) => comments.create({ body, kind: "DISCUSSION", attachmentIds, deliverableId: merged ? null : scopeId })}
          />
        </div>
      ) : (
        <p className="mt-2 px-2 text-[12px] text-fg-subtle">You have view-only access to this project.</p>
      )}
    </div>
  );
}

const REVIEW_ICON: Record<ReviewDTO["action"], React.ReactNode> = {
  SUBMITTED: <Send className="text-state-review" />,
  APPROVED: <CircleCheck className="text-state-approved" />,
  CHANGES_REQUESTED: <CircleAlert className="text-state-changes" />,
  WITHDRAWN: <Undo2 className="text-fg-subtle" />,
  REOPENED: <Undo2 className="text-state-progress" />,
};

const REVIEW_TEXT: Record<ReviewDTO["action"], string> = {
  SUBMITTED: "submitted for review",
  APPROVED: "approved",
  CHANGES_REQUESTED: "requested changes",
  WITHDRAWN: "withdrew the submission",
  REOPENED: "reopened",
};

function VersionHistory({ versions, reviews, currentVersionId, approvedVersionId }: { versions: VersionDTO[]; reviews: ReviewDTO[]; currentVersionId: string | null; approvedVersionId?: string | null }) {
  const { card, membersById, setVersionId, scrollTo } = useWorkspace();
  const rows = useMemo(() => {
    const byVersion = new Map<string | null, ReviewDTO[]>();
    for (const r of reviews) byVersion.set(r.versionId, [...(byVersion.get(r.versionId) ?? []), r]);
    return { byVersion, versions: [...versions].reverse() };
  }, [reviews, versions]);
  const loose = rows.byVersion.get(null) ?? [];

  const event = (r: ReviewDTO) => {
    const actor = r.actorId ? membersById.get(r.actorId) : undefined;
    return (
      <li key={r.id} className="flex items-start gap-2 text-[12.5px]">
        <span className="mt-0.5 [&_svg]:size-3.5">{REVIEW_ICON[r.action]}</span>
        <span className="min-w-0 flex-1">
          <strong className="font-medium">{actor?.displayName ?? "Someone"}</strong> <span className="text-fg-muted">{REVIEW_TEXT[r.action]}</span>
          {r.feedbackIds.length && r.action === "CHANGES_REQUESTED" ? <span className="text-state-changes"> · {r.feedbackIds.length} feedback</span> : null}
          {r.note ? <span className="block text-fg-muted">“{r.note}”</span> : null}
        </span>
        <time className="shrink-0 text-[11px] text-fg-subtle" title={formatDateTime(r.createdAt)}>
          {timeAgo(r.createdAt)}
        </time>
      </li>
    );
  };

  const versionBlock = (v: VersionDTO) => {
    const uploader = v.createdById ? membersById.get(v.createdById) : undefined;
    const thumb = card.attachments.find((a) => v.attachmentIds.includes(a.id) && a.thumbUrl);
    const current = v.id === currentVersionId;
    const recorded = card.productionSnapshot.some((s) => s.versionId === v.id) && card.productionStatus !== "TODO";
    return (
      <li key={v.id} className={cn("rounded-lg border p-3", current ? "border-accent/50 bg-accent-soft/30" : "border-border bg-surface-2")}>
        <div className="flex items-start gap-3">
          {thumb?.thumbUrl ? <img src={thumb.thumbUrl} alt="" className="h-12 w-20 shrink-0 rounded object-cover" /> : <span className="flex h-12 w-20 shrink-0 items-center justify-center rounded bg-surface-4 font-mono text-[12px] text-fg-subtle">V{v.number}</span>}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-[13px] font-semibold">V{v.number}</span>
              {current ? <span className="rounded bg-accent px-1.5 text-[10.5px] font-semibold text-accent-fg">Current</span> : null}
              <StatePill state={VERSION_STATUS_META[v.status].state} size="sm" />
              {approvedVersionId === v.id && !current ? <span className="rounded bg-state-approved/15 px-1.5 text-[10.5px] font-semibold text-state-approved">Last approved</span> : null}
              {recorded ? (
                <span className="rounded px-1.5 text-[10.5px] font-semibold" style={{ color: PRODUCTION_COLOR[card.productionStatus], backgroundColor: `color-mix(in srgb, ${PRODUCTION_COLOR[card.productionStatus]} 15%, transparent)` }}>
                  {PRODUCTION_META[card.productionStatus].label}
                </span>
              ) : null}
              {v.feedbackCount ? (
                <span className="text-[11.5px] text-fg-muted">
                  {v.feedbackCount} feedback{v.unresolvedCount ? <span className="text-state-changes"> · {v.unresolvedCount} open</span> : null}
                </span>
              ) : null}
            </div>
            <p className="mt-0.5 flex items-center gap-1.5 text-[12px] text-fg-muted">
              <UserAvatar user={uploader} size="xs" /> {uploader?.displayName ?? "Someone"} uploaded {timeAgo(v.createdAt)}
            </p>
            {v.notes ? <p className="mt-1 text-[12.5px]">“{v.notes}”</p> : null}
          </div>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              setVersionId(v.id);
              scrollTo("media");
            }}
          >
            <Eye /> View
          </Button>
        </div>
        {(rows.byVersion.get(v.id) ?? []).length ? <ul className="mt-2 grid gap-1.5 border-t border-border pt-2">{(rows.byVersion.get(v.id) ?? []).map(event)}</ul> : null}
      </li>
    );
  };

  if (!versions.length && !loose.length) return <p className="px-2 py-4 text-[12.5px] text-fg-muted">No revisions or reviews yet.</p>;
  return (
    <ul className="grid gap-2">
      {rows.versions.map(versionBlock)}
      {loose.length ? (
        <li className="rounded-lg border border-border bg-surface-2 p-3">
          <p className="mb-2 text-[12px] font-semibold text-fg-muted">Reviews without files</p>
          <ul className="grid gap-1.5">{loose.map(event)}</ul>
        </li>
      ) : null}
    </ul>
  );
}

/** Every completion/publication with exactly what was recorded — kept even after later revisions. */
export function ProductionHistory() {
  const { card, membersById } = useWorkspace();
  if (!card.productionEvents.length) {
    return <p className="px-2 py-4 text-[12.5px] text-fg-muted">Not completed or published yet. Moving a card between stages is recorded here with the approved revisions it included.</p>;
  }
  return (
    <ol className="grid gap-2">
      {[...card.productionEvents].reverse().map((e) => {
        const actor = e.actorId ? membersById.get(e.actorId) : undefined;
        const Icon = PRODUCTION_ICONS[e.toStatus];
        return (
          <li key={e.id} className="rounded-lg border border-border bg-surface-2 p-3 text-[12.5px]">
            <p className="flex flex-wrap items-center gap-1.5">
              <Icon className="size-4" style={{ color: PRODUCTION_COLOR[e.toStatus] }} />
              <strong className="font-medium">{actor?.displayName ?? "Someone"}</strong>
              <span className="text-fg-muted">
                moved it from {PRODUCTION_META[e.fromStatus].label} to <strong className="text-fg">{PRODUCTION_META[e.toStatus].label}</strong>
              </span>
              <time className="ml-auto text-[11px] text-fg-subtle" title={formatDateTime(e.createdAt)}>
                {timeAgo(e.createdAt)}
              </time>
            </p>
            {e.note ? <p className="mt-1 text-fg-muted">“{e.note}”</p> : null}
            {e.snapshot.length ? (
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {e.snapshot.map((s) => (
                  <li key={s.deliverableId} className="rounded-md border border-border-strong px-1.5 py-0.5 text-[11.5px]">
                    {s.name} <span className="font-mono text-fg-muted">{s.versionNumber ? `V${s.versionNumber}` : "—"}</span>
                    {!s.required ? <span className="text-fg-subtle"> · optional</span> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function ActivityLog() {
  const { card, membersById } = useWorkspace();
  const query = useQuery({ queryKey: qk.cardActivity(card.id), queryFn: () => rpc("card.activity", { cardId: card.id }) });
  if (query.isLoading) {
    return (
      <div className="grid gap-2">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-6" />
        ))}
      </div>
    );
  }
  const events = query.data ?? [];
  if (!events.length) return <p className="px-2 py-4 text-[12.5px] text-fg-muted">No activity yet.</p>;
  return (
    <ol className="relative ml-2 grid gap-3 border-l border-border pl-4">
      {events.map((e) => (
        <li key={e.id} className="relative text-[12.5px]">
          <span className="absolute -left-[22px] top-0.5">
            <UserAvatar user={e.actor} size="xs" />
          </span>
          <span className="text-fg-muted">
            <strong className="font-medium text-fg">{e.actor?.displayName ?? "System"}</strong> {describeActivity(e, (id) => membersById.get(id)?.displayName ?? "someone", false)}
          </span>
          <time className="ml-1.5 text-[11px] text-fg-subtle" title={formatDateTime(e.createdAt)}>
            {timeAgo(e.createdAt)}
          </time>
        </li>
      ))}
    </ol>
  );
}

/**
 * - simple card: one discussion + the only deliverable's revisions (as before deliverables existed)
 * - overview: card-level discussion, production history, activity
 * - deliverable: that deliverable's discussion and revisions
 */
export function CardTabs({ mode }: { mode: "simple" | "overview" | "deliverable" }) {
  const { card, scope } = useWorkspace();
  const scopeId = mode === "deliverable" ? (scope?.deliverable.id ?? null) : null;
  const merged = mode === "simple";
  const discussionCount = discussionThreads(card.comments, scopeId, merged).filter((c) => !c.deletedAt).length;
  const versions = mode === "overview" ? [] : (scope?.versions ?? []);
  return (
    <Tabs defaultValue="discussion" id="discussion">
      <TabsList>
        <TabsTrigger value="discussion">
          <MessageSquare /> {mode === "deliverable" ? "Deliverable discussion" : "Discussion"} {discussionCount ? <span className="text-fg-subtle">{discussionCount}</span> : null}
        </TabsTrigger>
        {mode === "overview" ? (
          <TabsTrigger value="production" id="history">
            <Workflow /> Production history {card.productionEvents.length ? <span className="text-fg-subtle">{card.productionEvents.length}</span> : null}
          </TabsTrigger>
        ) : (
          <TabsTrigger value="history" id="history">
            <History /> Revisions & reviews {versions.length ? <span className="text-fg-subtle">{versions.length}</span> : null}
          </TabsTrigger>
        )}
        <TabsTrigger value="activity">
          <ActivityIcon /> Activity
        </TabsTrigger>
      </TabsList>
      <TabsContent value="discussion" className="pt-3">
        <Discussion scopeId={scopeId} merged={merged} />
      </TabsContent>
      {mode === "overview" ? (
        <TabsContent value="production" className="pt-3">
          <ProductionHistory />
        </TabsContent>
      ) : (
        <TabsContent value="history" className="pt-3">
          {mode === "simple" ? <ProductionHistoryInline /> : null}
          <VersionHistory versions={versions} reviews={scope?.reviews ?? []} currentVersionId={scope?.currentVersionId ?? null} approvedVersionId={scope?.deliverable.approvedVersionId} />
        </TabsContent>
      )}
      <TabsContent value="activity" className="pt-3">
        <ActivityLog />
      </TabsContent>
    </Tabs>
  );
}

function ProductionHistoryInline() {
  const { card } = useWorkspace();
  if (!card.productionEvents.length) return null;
  return (
    <details className="mb-3 rounded-lg border border-border bg-surface-2 px-3 py-2">
      <summary className="cursor-pointer text-[12.5px] font-medium">Production history ({card.productionEvents.length})</summary>
      <div className="mt-2">
        <ProductionHistory />
      </div>
    </details>
  );
}
