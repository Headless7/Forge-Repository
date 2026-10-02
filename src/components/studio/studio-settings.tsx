"use client";

import { useQuery } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { useRpcMutation } from "@/lib/queries";
import { rpc } from "@/lib/rpc-client";
import { formatDateTime } from "@/lib/utils";
import { UserAvatar } from "../domain/avatar";
import { PROJECT_EMOJIS } from "../shell/create-project-dialog";
import { useShell } from "../shell/shell-context";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/controls";
import { Input, Label } from "../ui/input";
import { cn } from "@/lib/utils";

const AUDIT_TEXT: Record<string, string> = {
  "studio.created": "created the studio",
  "studio.updated": "updated studio settings",
  "project.created": "created a project",
  "project.updated": "changed project settings",
  "project.archived": "archived a project",
  "project.restored": "restored a project",
  "project.deleted": "permanently deleted a project",
  "project.member_set": "changed project access",
  "project.member_removed": "removed someone from a project",
  "member.role_changed": "changed a member's role",
  "member.removed": "removed a member",
  "member.left": "left the studio",
  "invitation.created": "invited someone",
  "invitation.revoked": "revoked an invitation",
  "invitation.accepted": "accepted an invitation",
  "card.deleted": "permanently deleted a card",
};

function auditDetail(data: Record<string, unknown>) {
  const parts: string[] = [];
  if (typeof data.email === "string") parts.push(data.email);
  if (typeof data.name === "string") parts.push(data.name);
  if (typeof data.key === "string") parts.push(`${data.key}${typeof data.title === "string" ? ` “${data.title}”` : ""}`);
  if (typeof data.from === "string" && typeof data.to === "string") parts.push(`${data.from} → ${data.to}`);
  if (typeof data.role === "string" && !data.from) parts.push(data.role.toLowerCase());
  return parts.join(" · ");
}

export function StudioSettings() {
  const { studio, can } = useShell();
  const router = useRouter();
  const [name, setName] = useState(studio.name);
  const [slug, setSlug] = useState(studio.slug);
  const [icon, setIcon] = useState(studio.iconEmoji ?? "🌙");
  const update = useRpcMutation("studio.update", {
    onSuccess: (s) => {
      toast.success("Studio updated.");
      router.replace(`/${s.slug}/settings`);
      router.refresh();
    },
  });
  const audit = useQuery({ queryKey: ["audit", studio.id], queryFn: () => rpc("audit.list", { studioId: studio.id }), enabled: can("audit.view") });

  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto grid max-w-3xl gap-6 px-4 py-8 md:px-8">
        <div>
          <p className="text-[12px] text-fg-subtle">{studio.name}</p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">Studio settings</h1>
        </div>
        <section className="rounded-xl border border-border bg-surface-2 p-5">
          <div className="grid gap-4">
            <div>
              <Label htmlFor="studio-name">Studio name</Label>
              <Input id="studio-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="studio-slug">URL</Label>
              <div className="flex items-center gap-1 text-[13px] text-fg-subtle">
                <span>forge /</span>
                <Input id="studio-slug" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} />
              </div>
            </div>
            <div>
              <Label>Icon</Label>
              <div className="flex flex-wrap gap-1">
                {PROJECT_EMOJIS.map((e) => (
                  <button key={e} type="button" onClick={() => setIcon(e)} aria-pressed={icon === e} className={cn("flex size-8 items-center justify-center rounded-md text-base hover:bg-surface-4", icon === e && "bg-accent-soft ring-1 ring-accent")}>
                    {e}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex justify-end">
              <Button variant="primary" loading={update.isPending} disabled={name === studio.name && slug === studio.slug && icon === studio.iconEmoji} onClick={() => update.mutate({ studioId: studio.id, name, slug, iconEmoji: icon })}>
                Save changes
              </Button>
            </div>
          </div>
        </section>

        {can("audit.view") ? (
          <section className="rounded-xl border border-border bg-surface-2 p-5">
            <h2 className="flex items-center gap-2 text-[15px] font-semibold">
              <ShieldCheck className="size-4 text-fg-muted" /> Audit log
            </h2>
            <p className="mt-0.5 text-[12.5px] text-fg-muted">Security-relevant changes: roles, invitations, access and deletions.</p>
            <div className="mt-4">
              {audit.isLoading ? (
                <div className="grid gap-2">
                  {Array.from({ length: 5 }, (_, i) => (
                    <Skeleton key={i} className="h-8" />
                  ))}
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {(audit.data ?? []).map((entry) => (
                    <li key={entry.id} className="flex items-center gap-2.5 py-2 text-[12.5px]">
                      <UserAvatar user={entry.actor} size="xs" />
                      <span className="min-w-0 flex-1 truncate text-fg-muted">
                        <strong className="font-medium text-fg">{entry.actor?.displayName ?? "System"}</strong> {AUDIT_TEXT[entry.action] ?? entry.action}
                        {auditDetail(entry.data) ? <span className="text-fg-subtle"> · {auditDetail(entry.data)}</span> : null}
                      </span>
                      <span className="shrink-0 text-[11px] text-fg-subtle">{formatDateTime(entry.createdAt)}</span>
                      {entry.ipAddress ? <span className="hidden shrink-0 font-mono text-[10.5px] text-fg-subtle md:inline">{entry.ipAddress}</span> : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
