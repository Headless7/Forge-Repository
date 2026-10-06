"use client";

import { useState } from "react";
import type { UserDTO } from "@/lib/types";
import { cn, initials } from "@/lib/utils";

const sizes = {
  xs: "size-5 text-[9px]",
  sm: "size-6 text-[10px]",
  md: "size-7 text-[11px]",
  lg: "size-9 text-[13px]",
  xl: "size-16 text-xl",
} as const;

export function UserAvatar({
  user,
  size = "sm",
  online,
  className,
  ring,
}: {
  user: Pick<UserDTO, "displayName" | "avatarUrl" | "avatarColor"> | null | undefined;
  size?: keyof typeof sizes;
  online?: boolean;
  className?: string;
  ring?: boolean;
}) {
  const name = user?.displayName ?? "Unknown";
  // A picture that fails to load (expired link, removed file) falls back to the initials.
  const [failed, setFailed] = useState<string | null>(null);
  const src = user?.avatarUrl && user.avatarUrl !== failed ? user.avatarUrl : null;
  return (
    <span className={cn("relative inline-flex shrink-0", className)}>
      {src ? (
        <img
          src={src}
          alt={name}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(src)}
          className={cn("rounded-full object-cover", sizes[size], ring && "ring-2 ring-surface-2")}
        />
      ) : (
        <span
          role="img"
          aria-label={name}
          className={cn("inline-flex items-center justify-center rounded-full font-semibold text-white", sizes[size], ring && "ring-2 ring-surface-2")}
          style={{ backgroundColor: user?.avatarColor ?? "#4b5563" }}
        >
          {initials(name)}
        </span>
      )}
      {online ? (
        <span className="absolute -bottom-px -right-px size-2 rounded-full border-2 border-surface-2 bg-state-approved" aria-label="Online" />
      ) : null}
    </span>
  );
}

export function AvatarStack({
  users,
  max = 3,
  size = "xs",
  className,
}: {
  users: Array<Pick<UserDTO, "id" | "displayName" | "avatarUrl" | "avatarColor">>;
  max?: number;
  size?: keyof typeof sizes;
  className?: string;
}) {
  if (users.length === 0) return null;
  const shown = users.slice(0, max);
  const extra = users.length - shown.length;
  return (
    <span className={cn("flex items-center -space-x-1.5", className)} title={users.map((u) => u.displayName).join(", ")}>
      {shown.map((u) => (
        <UserAvatar key={u.id} user={u} size={size} ring />
      ))}
      {extra > 0 ? (
        <span className={cn("inline-flex items-center justify-center rounded-full bg-surface-4 font-semibold text-fg-muted ring-2 ring-surface-2", sizes[size])}>
          +{extra}
        </span>
      ) : null}
    </span>
  );
}
