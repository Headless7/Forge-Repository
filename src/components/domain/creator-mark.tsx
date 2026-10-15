import type { UserDTO } from "@/lib/types";
import { cn } from "@/lib/utils";
import { UserAvatar } from "./avatar";

type Person = Pick<UserDTO, "displayName" | "username" | "avatarUrl" | "avatarColor">;

/**
 * Who made something, for lists and tiles: "by (avatar) @name", or just the avatar where space is
 * tight (the name is in the tooltip and for screen readers). Unknown people and people who left
 * the studio show nothing — dialogs say "Former member" instead.
 */
export function CreatorMark({ person, verb = "Created", avatarOnly, className }: { person: Person | null | undefined; verb?: "Created" | "Reported"; avatarOnly?: boolean; className?: string }) {
  if (!person) return null;
  const text = `${verb} by @${person.username}`;
  if (avatarOnly) {
    return (
      <span role="img" aria-label={text} title={text} className={cn("inline-flex shrink-0", className)}>
        <UserAvatar user={person} size="2xs" />
      </span>
    );
  }
  return (
    <span className={cn("inline-flex min-w-0 max-w-full items-center gap-1", className)} title={text}>
      <span className="sr-only">{text}</span>
      <span aria-hidden className="inline-flex min-w-0 items-center gap-1">
        by <UserAvatar user={person} size="2xs" />
        <span className="truncate">@{person.username}</span>
      </span>
    </span>
  );
}
