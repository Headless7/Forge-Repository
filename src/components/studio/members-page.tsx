"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, LogOut, MailPlus, RefreshCw, Trash2, UserMinus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { canGrantRole, canManageMember, ROLE_DESCRIPTIONS, ROLE_LABELS, ROLES, type Role } from "@/lib/permissions";
import { qk, useRpcMutation } from "@/lib/queries";
import { rpc } from "@/lib/rpc-client";
import type { MemberDTO } from "@/lib/types";
import { emailSchema } from "@/lib/validation";
import { formatShortDate, timeAgo } from "@/lib/utils";
import { UserAvatar } from "../domain/avatar";
import { useShell } from "../shell/shell-context";
import { Button } from "../ui/button";
import { Badge, Select } from "../ui/controls";
import { ConfirmDialog, Dialog, DialogContent, DialogFooter } from "../ui/dialog";
import { FieldError, Input, Label } from "../ui/input";

function InviteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { studio } = useShell();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("MEMBER");
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const invite = useRpcMutation("invitation.create", {
    onSuccess: (result) => {
      setLink(result.url);
      void queryClient.invalidateQueries({ queryKey: qk.invitations(studio.id) });
      toast.success(`Invitation sent to ${result.email}.`);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = emailSchema.safeParse(email.trim());
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Enter a valid email.");
      return;
    }
    setError(null);
    invite.mutate({ studioId: studio.id, email: parsed.data, role });
  };
  const close = (value: boolean) => {
    onOpenChange(value);
    if (!value) {
      setLink(null);
      setEmail("");
      setRole("MEMBER");
    }
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent title="Invite a member" description={`They'll join ${studio.name} after signing in or creating an account.`}>
        {link ? (
          <div className="grid gap-3">
            <p className="text-[13px] text-fg-muted">We emailed the invitation. You can also share this link directly — it expires in 7 days and only works for {email}.</p>
            <div className="flex gap-2">
              <Input readOnly value={link} onFocus={(e) => e.currentTarget.select()} className="font-mono text-[12px]" />
              <Button variant="secondary" onClick={() => void navigator.clipboard.writeText(link).then(() => toast.success("Link copied"))}>
                <Copy /> Copy
              </Button>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setLink(null)}>
                Invite someone else
              </Button>
              <Button variant="primary" onClick={() => close(false)}>
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="grid gap-4">
            <div>
              <Label htmlFor="invite-email">Email</Label>
              <Input id="invite-email" type="email" autoFocus placeholder="teammate@studio.gg" value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={Boolean(error)} />
              <FieldError>{error}</FieldError>
            </div>
            <div>
              <Label>Role</Label>
              <div className="grid gap-1.5">
                {ROLES.filter((r) => canGrantRole(studio.role, r)).map((r) => (
                  <label key={r} className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border-strong p-2.5 has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
                    <input type="radio" name="role" value={r} checked={role === r} onChange={() => setRole(r)} className="mt-1 accent-[var(--accent)]" />
                    <span>
                      <span className="block text-[13px] font-medium">{ROLE_LABELS[r]}</span>
                      <span className="block text-[12px] text-fg-muted">{ROLE_DESCRIPTIONS[r]}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" loading={invite.isPending}>
                <MailPlus /> Send invitation
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function MembersPage({ initialMembers }: { initialMembers: MemberDTO[] }) {
  const { studio, user, can } = useShell();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [removing, setRemoving] = useState<MemberDTO | null>(null);
  const members = useQuery({ queryKey: qk.members(studio.id), queryFn: () => rpc("member.list", { studioId: studio.id }), initialData: initialMembers });
  const invitations = useQuery({ queryKey: qk.invitations(studio.id), queryFn: () => rpc("invitation.list", { studioId: studio.id }), enabled: can("members.invite") });
  const update = useRpcMutation("member.update", { onSuccess: (list) => queryClient.setQueryData(qk.members(studio.id), list) });
  const remove = useRpcMutation("member.remove", {
    onSuccess: (_, vars) => {
      setRemoving(null);
      if (vars.userId === user.id) {
        toast.success(`You left ${studio.name}.`);
        router.replace("/");
        router.refresh();
      } else {
        void queryClient.invalidateQueries({ queryKey: qk.members(studio.id) });
        toast.success("Member removed.");
      }
    },
  });
  const revoke = useRpcMutation("invitation.revoke", { onSuccess: () => void queryClient.invalidateQueries({ queryKey: qk.invitations(studio.id) }) });
  const resend = useRpcMutation("invitation.create", {
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: qk.invitations(studio.id) });
      void navigator.clipboard.writeText(result.url).catch(() => {});
      toast.success("New invitation sent. The fresh link is on your clipboard.");
    },
  });
  const me = members.data.find((m) => m.id === user.id);

  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-4 py-8 md:px-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-[12px] text-fg-subtle">{studio.name}</p>
            <h1 className="mt-1 text-xl font-semibold tracking-tight">Members · {members.data.length}</h1>
          </div>
          {can("members.invite") ? (
            <Button variant="primary" onClick={() => setInviteOpen(true)}>
              <MailPlus /> Invite member
            </Button>
          ) : null}
        </div>

        <ul className="mt-6 divide-y divide-border rounded-xl border border-border bg-surface-2">
          {members.data.map((m) => {
            const manageable = m.id !== user.id && canManageMember(studio.role, m.role);
            return (
              <li key={m.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <UserAvatar user={m} size="lg" online={m.online} />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 truncate text-[13.5px] font-medium">
                    {m.displayName} {m.id === user.id ? <Badge>You</Badge> : null}
                  </p>
                  <p className="truncate text-[12px] text-fg-subtle">
                    @{m.username}
                    {m.online ? <span className="text-state-approved"> · online</span> : null}
                  </p>
                </div>
                <input
                  defaultValue={m.title ?? ""}
                  key={m.title ?? ""}
                  disabled={!(manageable || m.id === user.id)}
                  placeholder="Studio role, e.g. VFX Artist"
                  aria-label={`Title for ${m.displayName}`}
                  onBlur={(e) => e.target.value !== (m.title ?? "") && update.mutate({ studioId: studio.id, userId: m.id, title: e.target.value || null })}
                  className="h-8 w-44 rounded-md border border-transparent bg-transparent px-2 text-[12.5px] text-fg-muted outline-none hover:border-border-strong focus:border-accent focus:bg-surface-3 disabled:hover:border-transparent"
                />
                <div className="w-32">
                  {manageable ? (
                    <Select<Role>
                      aria-label={`Role for ${m.displayName}`}
                      value={m.role}
                      onValueChange={(role) => update.mutate({ studioId: studio.id, userId: m.id, role })}
                      options={ROLES.filter((r) => canGrantRole(studio.role, r) || r === m.role).map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
                      className="h-8"
                    />
                  ) : (
                    <span className="text-[13px] text-fg-muted">{ROLE_LABELS[m.role]}</span>
                  )}
                </div>
                {manageable ? (
                  <Button size="icon-sm" variant="ghost" aria-label={`Remove ${m.displayName}`} onClick={() => setRemoving(m)}>
                    <UserMinus />
                  </Button>
                ) : (
                  <span className="w-8" />
                )}
              </li>
            );
          })}
        </ul>

        {can("members.invite") ? (
          <section className="mt-8">
            <h2 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-fg-subtle">Pending invitations</h2>
            {invitations.data?.length ? (
              <ul className="divide-y divide-border rounded-xl border border-border bg-surface-2">
                {invitations.data.map((inv) => (
                  <li key={inv.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-[13px]">
                    <span className="min-w-0 flex-1 truncate font-medium">{inv.email}</span>
                    <span className="text-fg-muted">{ROLE_LABELS[inv.role as Role] ?? inv.role}</span>
                    <span className="text-[12px] text-fg-subtle">
                      {inv.expired ? <span className="text-danger">expired</span> : `expires ${formatShortDate(inv.expiresAt)}`} · by {inv.invitedBy ?? "someone"} {timeAgo(inv.createdAt)}
                    </span>
                    <Button size="xs" variant="ghost" loading={resend.isPending && resend.variables?.email === inv.email} onClick={() => resend.mutate({ studioId: studio.id, email: inv.email, role: inv.role as Role })}>
                      <RefreshCw /> Resend
                    </Button>
                    <Button size="xs" variant="danger-ghost" onClick={() => revoke.mutate({ invitationId: inv.id })}>
                      <Trash2 /> Revoke
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-fg-muted">No pending invitations.</p>
            )}
          </section>
        ) : null}

        {me && me.role !== "OWNER" ? (
          <div className="mt-10 flex items-center justify-between rounded-xl border border-border p-4">
            <div>
              <p className="text-[13px] font-medium">Leave {studio.name}</p>
              <p className="text-[12px] text-fg-muted">You&apos;ll lose access to its projects until someone invites you again.</p>
            </div>
            <Button variant="danger-ghost" onClick={() => setRemoving(me)}>
              <LogOut /> Leave studio
            </Button>
          </div>
        ) : null}
      </div>
      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />
      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={removing?.id === user.id ? `Leave ${studio.name}?` : `Remove ${removing?.displayName}?`}
        destructive
        confirmLabel={removing?.id === user.id ? "Leave studio" : "Remove member"}
        loading={remove.isPending}
        onConfirm={() => removing && remove.mutate({ studioId: studio.id, userId: removing.id })}
        description={removing?.id === user.id ? "You can rejoin only with a new invitation." : "They lose access to every project in this studio immediately. Their past work and comments stay in the history."}
      />
    </div>
  );
}
