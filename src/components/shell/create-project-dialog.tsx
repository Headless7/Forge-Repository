"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, FilePlus2, Lock, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { ROBLOX_TEMPLATE } from "@/lib/column-icons";
import { ROLE_LABELS } from "@/lib/permissions";
import { qk, useRpcMutation } from "@/lib/queries";
import { rpc } from "@/lib/rpc-client";
import { projectKeyFrom } from "@/lib/slugs";
import type { ProjectTemplatePreviewDTO } from "@/lib/types";
import { projectNameSchema } from "@/lib/validation";
import { cn } from "@/lib/utils";
import { UserAvatar } from "../domain/avatar";
import { Button } from "../ui/button";
import { Checkbox, Select, Skeleton } from "../ui/controls";
import { Dialog, DialogContent, DialogFooter } from "../ui/dialog";
import { FieldError, Input, Label } from "../ui/input";

export const PROJECT_EMOJIS = ["🎮", "🗼", "🏴‍☠️", "🧪", "⚔️", "🐉", "🏰", "🚀", "🌋", "🧟", "🎃", "🏎️", "🧙", "🥷", "🌌", "🏝️", "⚽", "👾", "🌙", "🔥", "💎", "🛡️", "🎯", "🌀"];

type Start = "blank" | "template";

/** What a template brings along — reviewed before the project is created. */
function TemplatePreview({ preview, included, onToggle }: { preview: ProjectTemplatePreviewDTO; included: Set<string>; onToggle: (userId: string, on: boolean) => void }) {
  const copyable = preview.people.filter((p) => !p.excluded);
  const excluded = preview.people.filter((p) => p.excluded);
  return (
    <div className="grid gap-3 rounded-lg border border-border-strong p-3 text-[12.5px]">
      <section aria-label="Boards that will be copied">
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">Boards · {preview.boards.length}</p>
        <ul className="grid gap-1">
          {preview.boards.map((b, i) => (
            <li key={i} className="rounded-md bg-surface-3/60 px-2 py-1.5">
              <span className="font-medium">{b.name}</span>
              <span className="text-fg-muted"> · {b.columns.length ? b.columns.map((c) => c.name).join(", ") : "no columns"}</span>
            </li>
          ))}
        </ul>
      </section>
      <section aria-label="Settings that will be copied">
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">Settings</p>
        <ul className="grid gap-0.5 text-fg-muted">
          <li className="flex items-center gap-1.5">
            {preview.settings.visibility === "PRIVATE" ? <Lock className="size-3.5" /> : <Users className="size-3.5" />}
            {preview.settings.visibility === "PRIVATE" ? "Private: members below, plus studio Developers and above" : "Open to everyone in the studio"}
          </li>
          <li>
            {preview.labels.length} label{preview.labels.length === 1 ? "" : "s"}
            {preview.labels.length ? ` (${preview.labels.map((l) => l.name).slice(0, 6).join(", ")}${preview.labels.length > 6 ? "…" : ""})` : ""}
          </li>
          <li>
            Review: {preview.settings.allowSelfApproval ? "self-approval allowed" : "no self-approval"} · {preview.settings.requireFeedbackForChanges ? "feedback required for changes" : "feedback optional"}
            {preview.settings.defaultReviewers ? ` · ${preview.settings.defaultReviewers} default reviewer${preview.settings.defaultReviewers === 1 ? "" : "s"}` : ""}
          </li>
        </ul>
      </section>
      <section aria-label="People who will be added">
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
          Project members · {copyable.filter((p) => included.has(p.userId)).length} of {copyable.length}
        </p>
        {copyable.length === 0 ? <p className="text-fg-muted">The template has no explicit members to copy. Studio roles still apply.</p> : null}
        <ul className="grid gap-1">
          {copyable.map((p) => (
            <li key={p.userId}>
              <label className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-1 hover:bg-surface-3">
                <Checkbox className="mt-1" checked={included.has(p.userId)} onCheckedChange={(v) => onToggle(p.userId, v === true)} aria-label={`Add ${p.displayName}`} />
                <UserAvatar user={{ displayName: p.displayName, avatarUrl: p.avatarUrl, avatarColor: p.avatarColor }} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{p.displayName}</span>
                  <span className="text-fg-muted">
                    {" "}
                    · {p.projectRole ? `${ROLE_LABELS[p.projectRole]} on the project` : `studio ${ROLE_LABELS[p.studioRole]}`}
                    {p.projectsOnly ? " · project-only collaborator (gets this new project too)" : ""}
                  </span>
                  {p.note ? <span className="block text-[11.5px] text-warning">{p.note}</span> : null}
                </span>
              </label>
            </li>
          ))}
        </ul>
        {excluded.length ? (
          <div className="mt-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">Not copied</p>
            <ul className="grid gap-0.5 text-fg-muted">
              {excluded.map((p) => (
                <li key={p.userId}>
                  {p.displayName} — {p.excluded}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>
      <p className="text-[11.5px] text-fg-subtle">Never copied: {preview.notCopied.join(" · ").toLowerCase()}. The new project starts empty and is independent of the template.</p>
    </div>
  );
}

export function CreateProjectDialog({ open, onOpenChange, studio }: { open: boolean; onOpenChange: (open: boolean) => void; studio: { id: string; slug: string } }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [keyEdited, setKeyEdited] = useState(false);
  const [icon, setIcon] = useState("🎮");
  const [start, setStart] = useState<Start>("blank");
  const [template, setTemplate] = useState<"roblox" | "empty">("roblox");
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [included, setIncluded] = useState<Set<string>>(new Set());
  const [visibility, setVisibility] = useState<"STUDIO" | "PRIVATE">("STUDIO");
  const [error, setError] = useState<string | null>(null);

  const projects = useQuery({ queryKey: qk.projects(studio.id), queryFn: () => rpc("project.list", { studioId: studio.id }), enabled: open && start === "template", staleTime: 30_000 });
  const preview = useQuery({
    queryKey: ["project-template", studio.id, sourceId],
    queryFn: () => rpc("project.templatePreview", { studioId: studio.id, sourceProjectId: sourceId! }),
    enabled: open && start === "template" && Boolean(sourceId),
  });
  // Everyone the template can bring is included until unticked.
  useEffect(() => {
    if (preview.data) setIncluded(new Set(preview.data.people.filter((p) => !p.excluded).map((p) => p.userId)));
  }, [preview.data]);

  const create = useRpcMutation("project.create", {
    onSuccess: (project) => {
      void queryClient.invalidateQueries({ queryKey: qk.projects(studio.id) });
      void queryClient.invalidateQueries({ queryKey: qk.home(studio.id) });
      onOpenChange(false);
      setName("");
      setKey("");
      setKeyEdited(false);
      setSourceId(null);
      setStart("blank");
      router.push(`/${studio.slug}/${project.slug}`);
      router.refresh();
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const parsed = projectNameSchema.safeParse(name);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Enter a name.");
      return;
    }
    if (start === "template" && (!sourceId || !preview.data)) {
      setError("Choose the project to use as a template.");
      return;
    }
    setError(null);
    create.mutate(
      start === "template"
        ? { studioId: studio.id, name: parsed.data, key: key || undefined, icon, templateProjectId: sourceId, templateMemberIds: [...included] }
        : { studioId: studio.id, name: parsed.data, key: key || undefined, icon, template, visibility },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="New project" description="Projects get their own boards, members and milestones." size={start === "template" ? "lg" : "md"}>
        <form onSubmit={onSubmit} className="scrollbar-thin -mr-1 grid max-h-[70vh] gap-4 overflow-y-auto pr-1">
          <div className="grid grid-cols-[1fr_96px] gap-3">
            <div>
              <Label htmlFor="project-name">Name</Label>
              <Input
                id="project-name"
                autoFocus
                placeholder="Universal Tower Defense"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (!keyEdited) setKey(e.target.value.trim() ? projectKeyFrom(e.target.value) : "");
                }}
                aria-invalid={Boolean(error)}
              />
              <FieldError>{error}</FieldError>
            </div>
            <div>
              <Label htmlFor="project-key">Card key</Label>
              <Input
                id="project-key"
                value={key}
                maxLength={5}
                onChange={(e) => {
                  setKeyEdited(true);
                  setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""));
                }}
                className="font-mono uppercase"
              />
            </div>
          </div>
          <div>
            <Label>Icon</Label>
            <div className="flex flex-wrap gap-1">
              {PROJECT_EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => setIcon(emoji)}
                  aria-label={`Use ${emoji}`}
                  aria-pressed={icon === emoji}
                  className={cn("flex size-8 items-center justify-center rounded-md text-base transition-colors hover:bg-surface-4", icon === emoji && "bg-accent-soft ring-1 ring-accent")}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
          <div role="radiogroup" aria-label="How to start">
            <Label>Start</Label>
            <div className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  ["blank", FilePlus2, "Start blank", "A new board with starter columns or none."],
                  ["template", Copy, "Use a project as a template", "Copy its boards, columns, labels, settings and members — never its work."],
                ] as const
              ).map(([value, Icon, title, desc]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={start === value}
                  onClick={() => setStart(value)}
                  className={cn("rounded-lg border p-3 text-left transition-colors", start === value ? "border-accent bg-accent-soft" : "border-border-strong hover:bg-surface-3")}
                >
                  <span className="flex items-center gap-1.5 text-[13px] font-medium">
                    <Icon className="size-4" /> {title}
                  </span>
                  <span className="mt-0.5 block text-[11.5px] leading-snug text-fg-muted">{desc}</span>
                </button>
              ))}
            </div>
          </div>

          {start === "blank" ? (
            <>
              <div>
                <Label>Board template</Label>
                <div className="grid gap-2 sm:grid-cols-2">
                  {(
                    [
                      ["roblox", "Roblox game", ROBLOX_TEMPLATE.map((c) => c.name).join(" · ")],
                      ["empty", "Blank board", "Start without categories"],
                    ] as const
                  ).map(([value, title, desc]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setTemplate(value)}
                      aria-pressed={template === value}
                      className={cn("rounded-lg border p-3 text-left transition-colors", template === value ? "border-accent bg-accent-soft" : "border-border-strong hover:bg-surface-3")}
                    >
                      <span className="block text-[13px] font-medium">{title}</span>
                      <span className="mt-0.5 block text-[11.5px] leading-snug text-fg-muted">{desc}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <Label>Visibility</Label>
                <div className="flex flex-wrap gap-2">
                  {(
                    [
                      ["STUDIO", "Everyone in the studio"],
                      ["PRIVATE", "Private"],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setVisibility(value)}
                      aria-pressed={visibility === value}
                      className={cn("h-8 rounded-md border px-3 text-[13px]", visibility === value ? "border-accent bg-accent-soft text-fg" : "border-border-strong text-fg-muted hover:bg-surface-3")}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {visibility === "PRIVATE" ? <p className="mt-1 text-[11.5px] text-fg-subtle">Members you add, plus studio Developers, Managers, Admins and the Owner.</p> : null}
              </div>
            </>
          ) : (
            <>
              <div>
                <Label>Template project</Label>
                <Select<string>
                  aria-label="Template project"
                  value={sourceId ?? undefined}
                  placeholder={projects.isLoading ? "Loading projects…" : "Choose a project"}
                  onValueChange={(v) => setSourceId(v)}
                  options={(projects.data ?? []).map((p) => ({ value: p.id, label: `${p.icon} ${p.name}` }))}
                />
                <p className="mt-1 text-[11.5px] text-fg-subtle">Projects you can open in this studio. Visibility comes from the template.</p>
              </div>
              {sourceId ? (
                preview.isLoading ? (
                  <Skeleton className="h-40" />
                ) : preview.data ? (
                  <TemplatePreview
                    preview={preview.data}
                    included={included}
                    onToggle={(userId, on) =>
                      setIncluded((prev) => {
                        const next = new Set(prev);
                        if (on) next.add(userId);
                        else next.delete(userId);
                        return next;
                      })
                    }
                  />
                ) : preview.isError ? (
                  <p role="alert" className="text-[12.5px] text-danger">
                    Couldn&apos;t load that template: {preview.error.message}
                  </p>
                ) : null
              ) : null}
            </>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={create.isPending} disabled={start === "template" && !preview.data}>
              Create project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
