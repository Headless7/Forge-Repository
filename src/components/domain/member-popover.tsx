"use client";

import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { roleLabel } from "@/lib/permissions";
import { rpc } from "@/lib/rpc-client";
import type { MemberDTO, UserDTO } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useShell } from "../shell/shell-context";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/menu";
import { UserAvatar } from "./avatar";
import { DiscordIcon } from "./discord-icon";

/**
 * Tap or click a person (a comment's author, an assignee) to see their profile: studio name, Forge
 * username, title and role, and their connected Discord account. Uses the member list already on
 * screen when it has them; otherwise asks the server, which answers only for people the viewer may
 * see in this studio.
 */
export function MemberPopover({
  user,
  member,
  children,
  className,
}: {
  user: Pick<UserDTO, "id" | "displayName" | "avatarUrl" | "avatarColor">;
  /** The member's details when the screen already has them. */
  member?: MemberDTO;
  children: ReactNode;
  className?: string;
}) {
  const { studio } = useShell();
  const [open, setOpen] = useState(false);
  const fetched = useQuery({
    queryKey: ["member-profile", studio.id, user.id],
    queryFn: () => rpc("member.profile", { studioId: studio.id, userId: user.id }),
    enabled: open && !member,
    staleTime: 60_000,
    retry: false,
  });
  const m = member ?? fetched.data;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${user.displayName}: profile`}
          className={cn("inline-flex min-w-0 items-center gap-1.5 rounded-md text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent/60", className)}
        >
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 max-w-[calc(100vw-24px)]" collisionPadding={12}>
        <div className="flex items-start gap-3">
          <UserAvatar user={m ?? user} size="lg" online={m?.online} />
          <div className="min-w-0">
            <p className="break-words font-medium leading-snug">{m?.displayName ?? user.displayName}</p>
            {m ? (
              <p className="break-all text-[12px] text-fg-muted">
                @{m.username}
                {m.title ? <span className="break-words"> · {m.title}</span> : null}
              </p>
            ) : null}
            {m ? <p className="text-[11.5px] text-fg-subtle">{roleLabel(m.role)}</p> : null}
          </div>
        </div>
        {!m && fetched.isFetching ? <p className="mt-3 text-[12px] text-fg-subtle">Loading…</p> : null}
        {!m && fetched.isError ? <p className="mt-3 text-[12px] text-fg-subtle">This person&apos;s details aren&apos;t available to you.</p> : null}
        {m?.discord ? (
          <div className="mt-3 flex items-start gap-2 border-t border-border pt-3 text-[12.5px]">
            <DiscordIcon className="mt-0.5 size-3.5" label="Discord" />
            <div className="min-w-0">
              <p className="break-all">{m.discord.username}</p>
              {m.discord.displayName && m.discord.displayName !== m.displayName ? (
                <p className="break-words text-[11.5px] text-fg-muted">“{m.discord.displayName}” on Discord</p>
              ) : null}
            </div>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
