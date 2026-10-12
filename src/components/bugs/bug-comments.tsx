"use client";

import { Pencil, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { roleHas } from "@/lib/permissions";
import { useBugMutation } from "@/lib/queries";
import type { Role } from "@/lib/permissions";
import type { BugCommentDTO, BugDetailDTO, MemberDTO } from "@/lib/types";
import { formatDateTime, timeAgo } from "@/lib/utils";
import { Composer } from "../comments/composer";
import { RichText } from "../comments/rich-text";
import { UserAvatar } from "../domain/avatar";
import { MemberPopover } from "../domain/member-popover";
import { Button } from "../ui/button";

/** Repro notes and questions on a bug: a flat thread with @mentions. */
export function BugComments({ bug, members, viewerId, viewerRole }: { bug: BugDetailDTO; members: MemberDTO[]; viewerId: string; viewerRole: Role }) {
  const membersById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const mentionSet = useMemo(() => new Set(members.map((m) => m.username)), [members]);
  const comment = useBugMutation("bug.comment", bug.id, bug.projectId);
  const edit = useBugMutation("bug.editComment", bug.id, bug.projectId);
  const remove = useBugMutation("bug.deleteComment", bug.id, bug.projectId);
  const [editing, setEditing] = useState<string | null>(null);
  const canModerate = roleHas(viewerRole, "comment.moderate");
  const live = bug.comments.filter((c) => !c.deletedAt);

  return (
    <section aria-label="Comments">
      <h3 className="mb-2 text-[13px] font-semibold">
        Comments {live.length ? <span className="font-normal text-fg-subtle">· {live.length}</span> : null}
      </h3>
      {live.length ? (
        <ol className="grid gap-3">
          {live.map((c) => {
            const author = c.authorId ? membersById.get(c.authorId) : undefined;
            const own = c.authorId === viewerId;
            return (
              <li key={c.id} className="flex items-start gap-2.5">
                {author ? (
                  <MemberPopover user={author} member={author}>
                    <UserAvatar user={author} size="md" online={author.online} />
                  </MemberPopover>
                ) : (
                  <UserAvatar user={null} size="md" />
                )}
                <div className="min-w-0 flex-1 text-[13px]">
                  <p className="flex flex-wrap items-center gap-x-2 text-[12px] text-fg-muted">
                    <strong className="font-medium text-fg">{author?.displayName ?? "Former member"}</strong>
                    <time title={formatDateTime(c.createdAt)}>{timeAgo(c.createdAt)}</time>
                    {c.editedAt ? <span className="text-fg-subtle">· edited</span> : null}
                    {(own || canModerate) && editing !== c.id && bug.permissions.canComment ? (
                      <span className="ml-auto flex items-center gap-0.5">
                        {own ? (
                          <Button size="icon-xs" variant="ghost" aria-label="Edit comment" onClick={() => setEditing(c.id)} className="touch-target">
                            <Pencil />
                          </Button>
                        ) : null}
                        <Button size="icon-xs" variant="ghost" aria-label="Delete comment" loading={remove.isPending && remove.variables?.commentId === c.id} onClick={() => remove.mutate({ commentId: c.id })} className="touch-target text-fg-subtle hover:text-danger">
                          <Trash2 />
                        </Button>
                      </span>
                    ) : null}
                  </p>
                  {editing === c.id ? (
                    <div className="mt-1">
                      <Composer
                        members={members}
                        initialValue={c.body}
                        autoFocus
                        compact
                        submitLabel="Save"
                        onCancel={() => setEditing(null)}
                        onSubmit={async ({ body }) => {
                          await edit.mutateAsync({ commentId: c.id, body });
                          setEditing(null);
                        }}
                      />
                    </div>
                  ) : (
                    <CommentBody comment={c} mentionSet={mentionSet} />
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="text-[13px] text-fg-subtle">No comments yet.</p>
      )}
      {bug.permissions.canComment ? (
        <div className="mt-3">
          <Composer members={members} placeholder="Repro steps, questions, what you tried…" submitLabel="Comment" onSubmit={({ body }) => comment.mutateAsync({ bugId: bug.id, body })} />
        </div>
      ) : null}
    </section>
  );
}

function CommentBody({ comment, mentionSet }: { comment: BugCommentDTO; mentionSet: Set<string> }) {
  return <RichText text={comment.body} mentions={mentionSet} className="mt-0.5 text-fg" />;
}
