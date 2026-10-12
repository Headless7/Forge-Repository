"use client";

import { Pencil, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { roleHas, type Role } from "@/lib/permissions";
import { useItemMutation } from "@/lib/queries";
import type { ForumItemDetailDTO, MemberDTO } from "@/lib/types";
import { formatDateTime, timeAgo } from "@/lib/utils";
import { Composer } from "../comments/composer";
import { RichText } from "../comments/rich-text";
import { UserAvatar } from "../domain/avatar";
import { MemberPopover } from "../domain/member-popover";
import { Button } from "../ui/button";

/** Repro notes and questions on an item: a flat thread with @mentions. */
export function ItemComments({ item, members, viewerId, viewerRole }: { item: ForumItemDetailDTO; members: MemberDTO[]; viewerId: string; viewerRole: Role }) {
  const membersById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const mentionSet = useMemo(() => new Set(members.map((m) => m.username)), [members]);
  const comment = useItemMutation("item.comment", item.id, item.projectId);
  const edit = useItemMutation("item.editComment", item.id, item.projectId);
  const remove = useItemMutation("item.deleteComment", item.id, item.projectId);
  const [editing, setEditing] = useState<string | null>(null);
  const canModerate = roleHas(viewerRole, "comment.moderate");
  const live = item.comments.filter((c) => !c.deletedAt);

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
                    {(own || canModerate) && editing !== c.id && item.permissions.canComment ? (
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
                    <RichText text={c.body} mentions={mentionSet} className="mt-0.5 text-fg" />
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="text-[13px] text-fg-subtle">No comments yet.</p>
      )}
      {item.permissions.canComment ? (
        <div className="mt-3">
          <Composer members={members} placeholder="Repro steps, questions, what you tried…" submitLabel="Comment" onSubmit={({ body }) => comment.mutateAsync({ itemId: item.id, body })} />
        </div>
      ) : null}
    </section>
  );
}
