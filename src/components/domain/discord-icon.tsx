import { cn } from "@/lib/utils";

/** Discord's mark, for "Continue with Discord" and connected Discord handles. Decorative unless labelled. */
export function DiscordIcon({ className, label }: { className?: string; label?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("size-4 shrink-0", className)} fill="#5865F2" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <path d="M20.3 4.4A19.8 19.8 0 0 0 15.4 3l-.6 1.3a18.3 18.3 0 0 0-5.6 0L8.6 3a19.7 19.7 0 0 0-4.9 1.5C.6 9.2-.3 13.8.1 18.3a19.9 19.9 0 0 0 6 3l1.3-2a12.9 12.9 0 0 1-2-1l.5-.4a14.2 14.2 0 0 0 12.2 0l.5.4c-.6.4-1.3.7-2 1l1.3 2a19.8 19.8 0 0 0 6-3c.5-5.2-.9-9.8-3.7-13.9ZM8 15.6c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Zm8 0c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Z" />
    </svg>
  );
}

/** A connected Discord handle, shown beside (never instead of) the studio name. Long handles wrap. */
export function DiscordHandle({ username, className }: { username: string; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1 text-fg-muted", className)}>
      <DiscordIcon className="size-3" label="Discord" />
      <span className="min-w-0 break-all">{username}</span>
    </span>
  );
}
