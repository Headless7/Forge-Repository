"use client";

import { Check, Ellipsis, File as FileIcon, MapPin, Pencil, Reply, SmilePlus, Timer, Trash2, Undo2 } from "lucide-react";
import { useState } from "react";
import { REACTION_EMOJIS } from "@/lib/mentions";
import type { CommentDTO } from "@/lib/types";
import { cn, formatBytes, formatDateTime, formatTimecode, timeAgo } from "@/lib/utils";
import { useWorkspace } from "../card/workspace-context";
import { UserAvatar } from "../domain/avatar";
import { MemberPopover } from "../domain/member-popover";
import { Button } from "../ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Popover, PopoverContent, PopoverTrigger, Tooltip } from "../ui/menu";
import { Composer } from "./composer";
import { RichText } from "./rich-text";

export interface CommentAnchorInfo {
  /** "①" style number for image pins, or timecode for video. */
  label: string;
  kind: "pin" | "time";
}

function Reactions({ comment, canReact }: { comment: CommentDTO; canReact: boolean }) {
  const { comments, viewerId, membersById } = useWorkspace();
  if (!comment.reactions.length && !canReact) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1">
      {comment.reactions.map((r) => {
        const mine = r.userIds.includes(viewerId);
        return (
          <Tooltip key={r.emoji} content={r.userIds.map((id) => membersById.get(id)?.displayName ?? "Someone").join(", ")}>
            <button
              type="button"
              disabled={!canReact}
              onClick={() => comments.react(comment.id, r.emoji)}
              aria-pressed={mine}
              className={cn("flex h-6 items-center gap-1 rounded-full border px-1.5 text-[12px]", mine ? "border-accent/60 bg-accent-soft" : "border-border-strong hover:bg-surface-3")}
            >
              <span>{r.emoji}</span>
              <span className="text-[11px] font-medium text-fg-muted">{r.userIds.length}</span>
            </button>
          </Tooltip>
        );
      })}
      {canReact ? (
        <Popover>
          <PopoverTrigger asChild>
            <button type="button" aria-label="Add reaction" className="hover-reveal flex h-6 w-7 items-center justify-center rounded-full text-fg-subtle opacity-0 hover:bg-surface-3 hover:text-fg group-hover/comment:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100">
              <SmilePlus className="size-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="flex gap-0.5 p-1" side="top">
            {REACTION_EMOJIS.map((emoji) => (
              <button key={emoji} type="button" aria-label={`React ${emoji}`} onClick={() => comments.react(comment.id, emoji)} className="flex size-8 items-center justify-center rounded-md text-base hover:bg-surface-4">
                {emoji}
              </button>
            ))}
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}

function CommentBody({
  comment,
  anchor,
  versionLabel,
  isReply,
  onReply,
}: {
  comment: CommentDTO;
  anchor?: CommentAnchorInfo | null;
  versionLabel?: string | null;
  isReply?: boolean;
  onReply?: () => void;
}) {
  const { card, membersById, viewerId, mentionSet, comments, focusComment, activeCommentId, members } = useWorkspace();
  const [editing, setEditing] = useState(false);
  const author = comment.authorId ? membersById.get(comment.authorId) : undefined;
  const own = comment.authorId === viewerId;
  const perms = card.permissions;
  const deleted = Boolean(comment.deletedAt);
  const isFeedback = comment.kind === "FEEDBACK" && !isReply;
  const resolvedBy = comment.resolvedById ? membersById.get(comment.resolvedById) : undefined;
  const active = activeCommentId === comment.id;

  return (
    <div id={`comment-${comment.id}`} className={cn("group/comment flex gap-2.5 rounded-lg px-2 py-2 transition-colors", active && "bg-accent-soft/50 ring-1 ring-accent/40", isFeedback && comment.resolvedAt && "opacity-70")}>
      <UserAvatar user={author} size={isReply ? "sm" : "md"} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px]">
          {author ? (
            // Tap the name for the profile (title, role, connected Discord account).
            <MemberPopover user={author} member={author} className="touch-target max-w-full font-semibold text-fg">
              <span className="truncate">{author.displayName}</span>
            </MemberPopover>
          ) : (
            <span className="font-semibold text-fg">Former member</span>
          )}
          {anchor ? (
            <button
              type="button"
              onClick={() => focusComment(comment)}
              className={cn(
                "touch-target inline-flex h-5 items-center gap-1 rounded px-1.5 font-mono text-[11px] font-semibold",
                comment.resolvedAt ? "bg-state-approved/15 text-state-approved" : "bg-state-changes/15 text-state-changes",
              )}
              title={anchor.kind === "time" ? "Jump to this moment" : "Show this spot"}
            >
              {anchor.kind === "time" ? <Timer className="size-3" /> : <MapPin className="size-3" />}
              {anchor.label}
            </button>
          ) : null}
          {versionLabel ? <span className="rounded bg-surface-4 px-1 font-mono text-[10.5px] text-fg-muted">{versionLabel}</span> : null}
          <time className="text-fg-subtle" dateTime={comment.createdAt} title={formatDateTime(comment.createdAt)}>
            {timeAgo(comment.createdAt)}
          </time>
          {comment.editedAt && !deleted ? <span className="text-fg-subtle">· edited</span> : null}
        </div>

        {deleted ? (
          <p className="mt-0.5 text-[13px] italic text-fg-subtle">This comment was deleted.</p>
        ) : editing ? (
          <div className="mt-1.5">
            <Composer
              members={members}
              initialValue={comment.body}
              autoFocus
              submitLabel="Save"
              onCancel={() => setEditing(false)}
              onSubmit={async ({ body }) => {
                await comments.edit(comment.id, body);
                setEditing(false);
              }}
            />
          </div>
        ) : (
          <>
            {comment.body ? <RichText text={comment.body} mentions={mentionSet} className="mt-0.5 text-fg" /> : null}
            {comment.attachments.length ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {comment.attachments.map((a) =>
                  a.kind === "IMAGE" && a.url ? (
                    <a key={a.id} href={a.url} target="_blank" rel="noopener noreferrer" className="block overflow-hidden rounded-md border border-border-strong">
                      <img src={a.thumbUrl ?? a.url} alt={a.filename} className="h-24 max-w-48 object-cover" loading="lazy" />
                    </a>
                  ) : (
                    <a key={a.id} href={a.downloadUrl ?? a.url ?? "#"} className="flex h-9 items-center gap-2 rounded-md border border-border-strong px-2 text-[12px] hover:bg-surface-3">
                      <FileIcon className="size-3.5 text-fg-subtle" />
                      <span className="max-w-40 truncate">{a.filename}</span>
                      <span className="text-fg-subtle">{formatBytes(a.sizeBytes)}</span>
                    </a>
                  ),
                )}
              </div>
            ) : null}
          </>
        )}

        {!deleted && !editing ? (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {isFeedback ? (
              <Button
                size="xs"
                variant={comment.resolvedAt ? "ghost" : "secondary"}
                disabled={!perms.canResolveFeedback}
                onClick={() => comments.resolve(comment.id, !comment.resolvedAt)}
                className={cn(comment.resolvedAt ? "text-state-approved" : "")}
                title={comment.resolvedAt ? `Resolved by ${resolvedBy?.displayName ?? "someone"} — click to reopen` : "Mark as resolved"}
              >
                {comment.resolvedAt ? (
                  <>
                    <Check /> Resolved{resolvedBy ? ` by ${resolvedBy.displayName.split(" ")[0]}` : ""}
                    <Undo2 className="ml-0.5 opacity-60" />
                  </>
                ) : (
                  <>
                    <Check /> Resolve
                  </>
                )}
              </Button>
            ) : null}
            {onReply && perms.canComment ? (
              <Button size="xs" variant="ghost" onClick={onReply}>
                <Reply /> Reply
              </Button>
            ) : null}
            <Reactions comment={comment} canReact={perms.canComment} />
            {(own && perms.canComment) || perms.canModerate ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon-xs" variant="ghost" aria-label="Comment actions" className="hover-reveal ml-auto opacity-0 group-hover/comment:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100">
                    <Ellipsis />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {own ? (
                    <DropdownMenuItem onSelect={() => setEditing(true)}>
                      <Pencil /> Edit
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem destructive onSelect={() => comments.remove(comment.id)}>
                    <Trash2 /> Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function CommentThread({ comment, anchor, versionLabel }: { comment: CommentDTO; anchor?: CommentAnchorInfo | null; versionLabel?: string | null }) {
  const { comments, members, uploadTarget, card } = useWorkspace();
  const [replying, setReplying] = useState(false);
  return (
    <div className="animate-slide-up">
      <CommentBody comment={comment} anchor={anchor} versionLabel={versionLabel} onReply={() => setReplying(true)} />
      {comment.replies.length || replying ? (
        <div className="ml-7 border-l border-border pl-2.5">
          {comment.replies.map((reply) => (
            <CommentBody key={reply.id} comment={reply} isReply onReply={() => setReplying(true)} />
          ))}
          {replying && card.permissions.canComment ? (
            <div className="py-1.5 pl-2">
              <Composer
                members={members}
                card={uploadTarget}
                autoFocus
                compact
                placeholder="Write a reply…"
                submitLabel="Reply"
                onCancel={() => setReplying(false)}
                onSubmit={async ({ body, attachmentIds }) => {
                  await comments.create({ body, parentId: comment.id, attachmentIds });
                  setReplying(false);
                }}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
