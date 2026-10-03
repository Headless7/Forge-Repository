"use client";

import { CalendarClock, Eye, Users } from "lucide-react";
import type { DeliverableDTO } from "@/lib/types";
import { cn, formatShortDate } from "@/lib/utils";
import { UserAvatar } from "../domain/avatar";
import { useWorkspace } from "./workspace-context";

/**
 * Who works on a deliverable, its deadline and its reviewer — with inherited values (the card's
 * assignees, deadline or reviewers) marked as such, so nothing looks set when it isn't.
 */
export function DeliverableWork({ d, className }: { d: DeliverableDTO; className?: string }) {
  const { card, membersById } = useWorkspace();
  const people = [d.ownerId, ...d.contributorIds].map((id) => (id ? membersById.get(id) : undefined)).filter((m): m is NonNullable<typeof m> => Boolean(m));
  const inheritedPeople = !d.ownerId && d.contributorIds.length === 0;
  const due = d.dueAt ?? card.dueAt;
  const overdue = Boolean(due && d.state !== "APPROVED" && new Date(due).getTime() < Date.now());
  const reviewer = d.reviewerId ? membersById.get(d.reviewerId) : undefined;
  const owner = d.ownerId ? membersById.get(d.ownerId) : undefined;
  return (
    <span className={cn("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-fg-muted", className)}>
      {inheritedPeople ? (
        <span className="inline-flex items-center gap-1 text-fg-subtle" title="No one is set on this deliverable, so the card's assignees are responsible">
          <Users className="size-3" /> card assignees
        </span>
      ) : (
        <span className="inline-flex min-w-0 items-center gap-1" title={people.map((m, i) => `${m.displayName}${i === 0 && owner ? " (responsible)" : ""}`).join(", ")}>
          <span className="flex -space-x-1">
            {people.slice(0, 3).map((m) => (
              <UserAvatar key={m.id} user={m} size="xs" />
            ))}
          </span>
          <span className="truncate">
            {owner ? owner.displayName : "Contributors"}
            {people.length > 1 ? ` +${people.length - 1}` : ""}
          </span>
        </span>
      )}
      {due ? (
        <span
          className={cn("inline-flex items-center gap-0.5", overdue ? "font-semibold text-danger" : "", !d.dueAt && "italic")}
          title={d.dueAt ? "Its own deadline" : "Inherits the card's deadline"}
        >
          <CalendarClock className="size-3" />
          {overdue ? "overdue · " : ""}
          {!d.dueAt ? "card · " : ""}
          {formatShortDate(due)}
        </span>
      ) : null}
      {reviewer ? (
        <span className="inline-flex items-center gap-0.5" title={`Reviewer: ${reviewer.displayName}`}>
          <Eye className="size-3" /> {reviewer.displayName.split(" ")[0]}
        </span>
      ) : null}
    </span>
  );
}
