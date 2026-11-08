"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, Plus, RefreshCw } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { API_TOKEN_EXPIRY_OPTIONS, API_TOKEN_PROCEDURE_NAMES, API_TOKEN_PROCEDURES, type ApiTokenProcedure } from "@/lib/api-tokens";
import { qk, useRpcMutation } from "@/lib/queries";
import { rpc, type RpcOutput } from "@/lib/rpc-client";
import { formatDateTime } from "@/lib/utils";
import { UserAvatar } from "../domain/avatar";
import { useShell } from "../shell/shell-context";
import { Button } from "../ui/button";
import { Badge, Checkbox, EmptyState, Select, Skeleton } from "../ui/controls";
import { ConfirmDialog, Dialog, DialogContent, DialogFooter } from "../ui/dialog";
import { FieldError, Input, Label } from "../ui/input";

type ApiToken = RpcOutput<"apiToken.list">[number];
interface Issued {
  token: string;
  name: string;
  expiresAt: string;
  /** The scoped projects, with their ids: the client needs them for every call. */
  projects: Array<{ id: string; name: string; icon: string }>;
}

const tokensKey = (studioId: string) => ["api-tokens", studioId] as const;
const STATUS: Record<ApiToken["status"], { label: string; tone: "success" | "neutral" | "danger" }> = {
  active: { label: "Active", tone: "success" },
  expired: { label: "Expired", tone: "neutral" },
  revoked: { label: "Revoked", tone: "danger" },
};
const EXPIRY_OPTIONS = API_TOKEN_EXPIRY_OPTIONS.map((days) => ({ value: String(days), label: `${days} days` }));
const READ_PROCEDURES = API_TOKEN_PROCEDURE_NAMES.filter((n) => API_TOKEN_PROCEDURES[n].group === "read");
const WRITE_PROCEDURES = API_TOKEN_PROCEDURE_NAMES.filter((n) => API_TOKEN_PROCEDURES[n].group === "write");

/** The raw token, shown exactly once. */
function IssuedToken({ issued, onDone }: { issued: Issued; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(issued.token);
      setCopied(true);
      toast.success("Token copied");
    } catch {
      toast.error("Couldn't copy. Select the token and copy it by hand.");
    }
  };
  return (
    <div className="grid gap-3">
      <p className="text-[13px] text-fg-muted">
        This is the only time Forge shows the token for <strong className="font-medium text-fg">{issued.name}</strong>. Put it in the client&apos;s secret store now. If
        it&apos;s lost, rotate the token to get a new one.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input readOnly value={issued.token} onFocus={(e) => e.currentTarget.select()} className="font-mono text-[12px]" aria-label="API token" />
        <Button variant="secondary" onClick={() => void copy()}>
          {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {issued.projects.length ? (
        <div>
          <p className="mb-1 text-[12px] font-medium text-fg">Project ids for the client</p>
          <ul className="grid gap-1">
            {issued.projects.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2 text-[12px]">
                <span className="min-w-0 truncate text-fg-muted">
                  {p.icon} {p.name}
                </span>
                <code className="min-w-0 truncate font-mono text-[11px] text-fg-subtle">{p.id}</code>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Copy the id of ${p.name}`}
                  onClick={() => void navigator.clipboard.writeText(p.id).then(() => toast.success("Project id copied"))}
                >
                  <Copy />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="text-[12px] text-fg-subtle">
        Send it as <code className="font-mono">Authorization: Bearer …</code> to <code className="font-mono">/api/rpc/&lt;procedure&gt;</code>. Expires{" "}
        {formatDateTime(issued.expiresAt)}. Request shapes are in <code className="font-mono">docs/API_TOKENS.md</code>.
      </p>
      <DialogFooter>
        <Button variant="primary" onClick={onDone}>
          Done
        </Button>
      </DialogFooter>
    </div>
  );
}

function ProcedureChecklist({ title, names, selected, onToggle }: { title: string; names: readonly ApiTokenProcedure[]; selected: ApiTokenProcedure[]; onToggle: (name: ApiTokenProcedure, checked: boolean) => void }) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-fg-subtle">{title}</p>
      <div className="grid gap-1">
        {names.map((name) => (
          <label key={name} className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 hover:bg-surface-3">
            <Checkbox className="mt-0.5" checked={selected.includes(name)} onCheckedChange={(checked) => onToggle(name, checked === true)} />
            <span className="min-w-0">
              <span className="block font-mono text-[12px] text-fg">{name}</span>
              <span className="block text-[12px] text-fg-muted">{API_TOKEN_PROCEDURES[name].description}</span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

function CreateTokenDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { studio } = useShell();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [userId, setUserId] = useState<string | undefined>(undefined);
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [procedures, setProcedures] = useState<ApiTokenProcedure[]>([...READ_PROCEDURES]);
  const [days, setDays] = useState<string>("90");
  const [errors, setErrors] = useState<{ name?: string; user?: string; projects?: string; procedures?: string }>({});
  const [issued, setIssued] = useState<Issued | null>(null);

  const members = useQuery({ queryKey: qk.members(studio.id), queryFn: () => rpc("member.list", { studioId: studio.id }), enabled: open, staleTime: 30_000 });
  const projects = useQuery({ queryKey: qk.projects(studio.id), queryFn: () => rpc("project.list", { studioId: studio.id }), enabled: open, staleTime: 30_000 });
  const create = useRpcMutation("apiToken.create", {
    onSuccess: (result) => {
      setIssued({
        token: result.token,
        name: name.trim(),
        expiresAt: result.expiresAt,
        projects: (projects.data ?? []).filter((p) => projectIds.includes(p.id)).map((p) => ({ id: p.id, name: p.name, icon: p.icon })),
      });
      void queryClient.invalidateQueries({ queryKey: tokensKey(studio.id) });
    },
  });

  const close = (next: boolean) => {
    if (!next) {
      setName("");
      setUserId(undefined);
      setProjectIds([]);
      setProcedures([...READ_PROCEDURES]);
      setDays("90");
      setErrors({});
      setIssued(null);
    }
    onOpenChange(next);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: typeof errors = {};
    if (!name.trim()) next.name = "Name the token, e.g. “UTD bug triage”.";
    if (!userId) next.user = "Choose the member the token acts as.";
    if (!projectIds.length) next.projects = "Choose at least one project.";
    if (!procedures.length) next.procedures = "Choose at least one procedure.";
    setErrors(next);
    if (Object.keys(next).length) return;
    create.mutate({ studioId: studio.id, userId: userId!, name: name.trim(), procedures, projectIds, expiresInDays: Number(days) });
  };

  const toggleProcedure = (procedure: ApiTokenProcedure, checked: boolean) =>
    setProcedures((list) => (checked ? [...list, procedure] : list.filter((p) => p !== procedure)));
  const memberOptions = (members.data ?? []).map((m) => ({ value: m.id, label: m.displayName }));

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        title={issued ? "Token created" : "New API token"}
        description={issued ? undefined : "A token calls Forge as the member you choose, limited to these projects and procedures. It never adds access: the member must already be able to open the projects."}
      >
        {issued ? (
          <IssuedToken issued={issued} onDone={() => close(false)} />
        ) : (
          <form onSubmit={submit} className="grid gap-4">
            <div>
              <Label htmlFor="token-name">Name</Label>
              <Input id="token-name" autoFocus placeholder="UTD bug triage" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} aria-invalid={Boolean(errors.name)} />
              <FieldError>{errors.name}</FieldError>
            </div>
            <div>
              <Label htmlFor="token-member">Acts as</Label>
              <Select
                value={userId}
                onValueChange={setUserId}
                options={memberOptions}
                placeholder={members.isPending ? "Loading members…" : "Choose a member"}
                aria-label="Member the token acts as"
                className="w-full"
              />
              <FieldError>{errors.user}</FieldError>
              <p className="mt-1 text-[11px] text-fg-subtle">Use a dedicated bot account. Its edits appear under this name in activity and history.</p>
            </div>
            <div>
              <Label>Projects</Label>
              <div className="scrollbar-thin grid max-h-40 gap-1 overflow-y-auto rounded-lg border border-border-strong p-2" aria-invalid={Boolean(errors.projects)}>
                {projects.data?.length ? (
                  projects.data.map((p) => (
                    <label key={p.id} className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[13px] hover:bg-surface-3">
                      <Checkbox checked={projectIds.includes(p.id)} onCheckedChange={(checked) => setProjectIds((ids) => (checked ? [...ids, p.id] : ids.filter((id) => id !== p.id)))} />
                      <span>{p.icon}</span>
                      <span className="truncate">{p.name}</span>
                    </label>
                  ))
                ) : (
                  <p className="px-1.5 py-1 text-[12px] text-fg-muted">{projects.isPending ? "Loading projects…" : "No projects yet."}</p>
                )}
              </div>
              <FieldError>{errors.projects}</FieldError>
            </div>
            <div>
              <Label>Procedures</Label>
              <div className="grid gap-3 rounded-lg border border-border-strong p-2">
                <ProcedureChecklist title="Read" names={READ_PROCEDURES} selected={procedures} onToggle={toggleProcedure} />
                <ProcedureChecklist title="Write" names={WRITE_PROCEDURES} selected={procedures} onToggle={toggleProcedure} />
              </div>
              <FieldError>{errors.procedures}</FieldError>
              <p className="mt-1 text-[11px] text-fg-subtle">Assigning people and changing tags needs the Manager role in the project. Anything not listed here can never be called with a token.</p>
            </div>
            <div>
              <Label htmlFor="token-expiry">Expires in</Label>
              <Select value={days} onValueChange={setDays} options={EXPIRY_OPTIONS} aria-label="Token expiry" className="w-full sm:w-48" />
            </div>
            <DialogFooter>
              <Button variant="ghost" type="button" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button variant="primary" type="submit" loading={create.isPending}>
                Create token
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Studio settings: the admin-only list of API tokens, with create, rotate and revoke. */
export function ApiTokens() {
  const { studio } = useShell();
  const queryClient = useQueryClient();
  const tokens = useQuery({ queryKey: tokensKey(studio.id), queryFn: () => rpc("apiToken.list", { studioId: studio.id }) });
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiToken | null>(null);
  const [rotating, setRotating] = useState<ApiToken | null>(null);
  const [rotated, setRotated] = useState<Issued | null>(null);
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: tokensKey(studio.id) });

  const revoke = useRpcMutation("apiToken.revoke", {
    onSuccess: () => {
      toast.success("Token revoked.");
      setRevoking(null);
      invalidate();
    },
  });
  const rotate = useRpcMutation("apiToken.rotate", {
    onSuccess: (result) => {
      setRotated({ token: result.token, name: rotating?.name ?? "this token", expiresAt: result.expiresAt, projects: rotating?.projects ?? [] });
      setRotating(null);
      invalidate();
    },
  });

  return (
    <section className="rounded-xl border border-border bg-surface-2 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold">
            <KeyRound className="size-4 text-fg-muted" /> API tokens
          </h2>
          <p className="mt-0.5 text-[12.5px] text-fg-muted">
            Let a script or bot call Forge as a member of this studio, limited to chosen projects and procedures. Tokens are shown once and only admins see this
            list.
          </p>
        </div>
        <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
          <Plus /> New token
        </Button>
      </div>
      <div className="mt-4">
        {tokens.isLoading ? (
          <div className="grid gap-2">
            {Array.from({ length: 2 }, (_, i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : tokens.data?.length ? (
          <ul className="divide-y divide-border">
            {tokens.data.map((t) => (
              <li key={t.id} className="grid gap-2 py-3 text-[12.5px] sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-fg">{t.name}</span>
                    <span className="font-mono text-[11px] text-fg-subtle">…{t.hint}</span>
                    <Badge tone={STATUS[t.status].tone}>{STATUS[t.status].label}</Badge>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-fg-muted">
                    <span className="flex items-center gap-1.5">
                      <UserAvatar user={t.user} size="xs" /> acts as {t.user?.displayName ?? "a removed member"}
                    </span>
                    <span className="truncate">{t.projects.map((p) => `${p.icon} ${p.name}`).join(", ") || "no projects"}</span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {t.procedures.map((p) => (
                      <span key={p} className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[10.5px] text-fg-muted">
                        {p}
                      </span>
                    ))}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-fg-subtle">
                    <span>
                      Created {formatDateTime(t.createdAt)}
                      {t.createdBy ? ` by ${t.createdBy.displayName}` : ""}
                    </span>
                    <span>Last used {t.lastUsedAt ? formatDateTime(t.lastUsedAt) : "never"}</span>
                    <span>{t.status === "revoked" && t.revokedAt ? `Revoked ${formatDateTime(t.revokedAt)}` : `Expires ${formatDateTime(t.expiresAt)}`}</span>
                  </div>
                </div>
                {t.status !== "revoked" ? (
                  <div className="flex flex-wrap gap-1.5 sm:justify-end">
                    {t.status === "active" ? (
                      <Button size="sm" variant="secondary" onClick={() => setRotating(t)}>
                        <RefreshCw /> Rotate
                      </Button>
                    ) : null}
                    <Button size="sm" variant="ghost" className="text-danger" onClick={() => setRevoking(t)}>
                      Revoke
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={<KeyRound />}
            title="No API tokens"
            description="Create one for a bot account to let a scheduled script read forums and triage items without a browser."
            action={
              <Button variant="secondary" size="sm" onClick={() => setCreating(true)}>
                <Plus /> New token
              </Button>
            }
          />
        )}
      </div>

      <CreateTokenDialog open={creating} onOpenChange={setCreating} />
      <Dialog open={Boolean(rotated)} onOpenChange={(open) => !open && setRotated(null)}>
        <DialogContent title="Token rotated">{rotated ? <IssuedToken issued={rotated} onDone={() => setRotated(null)} /> : null}</DialogContent>
      </Dialog>
      <ConfirmDialog
        open={Boolean(rotating)}
        onOpenChange={(open) => !open && setRotating(null)}
        title="Rotate this token?"
        description={
          <>
            The current token for <strong className="font-medium text-fg">{rotating?.name}</strong> stops working immediately. A new one with the same settings is shown once;
            update the client right after.
          </>
        }
        confirmLabel="Rotate"
        loading={rotate.isPending}
        onConfirm={() => rotating && rotate.mutate({ tokenId: rotating.id })}
      />
      <ConfirmDialog
        open={Boolean(revoking)}
        onOpenChange={(open) => !open && setRevoking(null)}
        title="Revoke this token?"
        description={
          <>
            Clients using <strong className="font-medium text-fg">{revoking?.name}</strong> get 401 from now on. This can&apos;t be undone; create a new token to reconnect them.
          </>
        }
        confirmLabel="Revoke"
        destructive
        loading={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate({ tokenId: revoking.id })}
      />
    </section>
  );
}
