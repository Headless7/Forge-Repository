"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Check, Flag, Lock, Plus, Rocket, Tag, Trash2, Users } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { LABEL_COLORS, PROJECT_BACKGROUNDS } from "@/lib/column-icons";
import { ROLE_LABELS, type Role } from "@/lib/permissions";
import { qk, useRpcMutation } from "@/lib/queries";
import { rpc } from "@/lib/rpc-client";
import type { BoardDTO, LabelDTO, MilestoneDTO } from "@/lib/types";
import { cn, formatShortDate } from "@/lib/utils";
import { ArchivedItems } from "../board/archived-dialog";
import { CreateBoardDialog } from "../board/board-switcher";
import { UserAvatar } from "../domain/avatar";
import { BoardIcon } from "../domain/board-icon";
import { LabelChip } from "../domain/state";
import { PROJECT_EMOJIS } from "../shell/create-project-dialog";
import { Button } from "../ui/button";
import { Checkbox, Select, Switch } from "../ui/controls";
import { TipAnchor, useTipOnOpen } from "../tutorial/tutorial";
import { ConfirmDialog } from "../ui/dialog";
import { Input, Label, Textarea } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/menu";

type BackgroundId = (typeof PROJECT_BACKGROUNDS)[number]["id"];

function Section({ id, title, description, children }: { id: string; title: string; description?: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6 rounded-xl border border-border bg-surface-2 p-5">
      <h2 className="text-[15px] font-semibold">{title}</h2>
      {description ? <p className="mt-0.5 text-[12.5px] text-fg-muted">{description}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function General({ board, canEdit, studioSlug }: { board: BoardDTO; canEdit: boolean; studioSlug: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const p = board.project;
  const [values, setValues] = useState({
    name: p.name,
    description: p.description,
    key: p.key,
    slug: p.slug,
    icon: p.icon,
    background: p.background as BackgroundId,
  });
  const update = useRpcMutation("project.update", {
    onSuccess: (project) => {
      toast.success("Project settings saved.");
      void queryClient.invalidateQueries({ queryKey: qk.board(p.id) });
      void queryClient.invalidateQueries({ queryKey: qk.projects(p.studioId) });
      if (project.slug !== p.slug) router.replace(`/${studioSlug}/${project.slug}/settings`);
      else router.refresh();
    },
  });
  const dirty = values.name !== p.name || values.description !== p.description || values.key !== p.key || values.slug !== p.slug || values.icon !== p.icon || values.background !== p.background;
  return (
    <Section id="general" title="General">
      <div className="grid gap-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_110px]">
          <div>
            <Label htmlFor="p-name">Project name</Label>
            <Input id="p-name" disabled={!canEdit} value={values.name} onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))} />
          </div>
          <div>
            <Label htmlFor="p-key">Card key</Label>
            <Input id="p-key" disabled={!canEdit} className="font-mono uppercase" maxLength={5} value={values.key} onChange={(e) => setValues((v) => ({ ...v, key: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") }))} />
          </div>
        </div>
        <div>
          <Label htmlFor="p-desc">Description</Label>
          <Textarea id="p-desc" disabled={!canEdit} value={values.description} onChange={(e) => setValues((v) => ({ ...v, description: e.target.value }))} />
        </div>
        <div>
          <Label htmlFor="p-slug">URL</Label>
          <div className="flex items-center gap-1 text-[13px] text-fg-subtle">
            <span className="shrink-0">/{studioSlug}/</span>
            <Input id="p-slug" disabled={!canEdit} value={values.slug} onChange={(e) => setValues((v) => ({ ...v, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") }))} />
          </div>
        </div>
        <div>
          <Label>Icon</Label>
          <div className="flex flex-wrap gap-1">
            {PROJECT_EMOJIS.map((emoji) => (
              <button key={emoji} type="button" disabled={!canEdit} onClick={() => setValues((v) => ({ ...v, icon: emoji }))} aria-pressed={values.icon === emoji} className={cn("flex size-8 items-center justify-center rounded-md text-base hover:bg-surface-4 disabled:cursor-not-allowed", values.icon === emoji && "bg-accent-soft ring-1 ring-accent")}>
                {emoji}
              </button>
            ))}
          </div>
        </div>
        <div>
          <Label>Board background</Label>
          <div className="flex flex-wrap gap-2">
            {PROJECT_BACKGROUNDS.map((bg) => (
              <button
                key={bg.id}
                type="button"
                disabled={!canEdit}
                onClick={() => setValues((v) => ({ ...v, background: bg.id }))}
                aria-pressed={values.background === bg.id}
                className={cn("h-14 w-24 overflow-hidden rounded-lg border text-left", `board-bg-${bg.id}`, values.background === bg.id ? "border-accent ring-1 ring-accent" : "border-border-strong")}
              >
                <span className="block px-2 pt-8 text-[11px] font-medium">{bg.label}</span>
              </button>
            ))}
          </div>
        </div>
        {canEdit ? (
          <div className="flex justify-end">
            <Button variant="primary" disabled={!dirty} loading={update.isPending} onClick={() => update.mutate({ projectId: p.id, ...values })}>
              Save changes
            </Button>
          </div>
        ) : null}
      </div>
    </Section>
  );
}

function Access({ board, canEdit }: { board: BoardDTO; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const p = board.project;
  // Opening project settings is when project roles and access are being managed.
  useTipOnOpen("access.scope", canEdit, { place: "project" });
  const access = useQuery({ queryKey: qk.projectAccess(p.id), queryFn: () => rpc("project.access", { projectId: p.id }) });
  const setMember = useRpcMutation("project.setMember", {
    onSuccess: (list) => {
      queryClient.setQueryData(qk.projectAccess(p.id), list);
      void queryClient.invalidateQueries({ queryKey: qk.board(p.id) });
    },
  });
  const update = useRpcMutation("project.update", {
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.board(p.id) });
      void queryClient.invalidateQueries({ queryKey: qk.projectAccess(p.id) });
      toast.success("Visibility updated.");
    },
  });
  return (
    <Section id="members" title="Members & permissions" description="Studio roles apply by default. Give someone a different role on this project, or make the project private.">
      <TipAnchor tip="access.scope" place="project" facts={{ place: "project", canManage: canEdit }}>
      <div className="mb-4 grid gap-2 sm:grid-cols-2">
        {(
          [
            ["STUDIO", Users, "Everyone in the studio", "All studio members can open this project with their studio role."],
            ["PRIVATE", Lock, "Private", "People you add below, plus studio Developers, Managers, Admins and the Owner."],
          ] as const
        ).map(([value, Icon, title, desc]) => (
          <button
            key={value}
            type="button"
            disabled={!canEdit}
            onClick={() => update.mutate({ projectId: p.id, visibility: value })}
            aria-pressed={p.visibility === value}
            className={cn("rounded-lg border p-3 text-left disabled:cursor-not-allowed", p.visibility === value ? "border-accent bg-accent-soft" : "border-border-strong hover:bg-surface-3")}
          >
            <span className="flex items-center gap-2 text-[13px] font-medium">
              <Icon className="size-4" /> {title}
            </span>
            <span className="mt-1 block text-[12px] text-fg-muted">{desc}</span>
          </button>
        ))}
      </div>
      </TipAnchor>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {(access.data ?? []).map((m) => {
          const privileged = m.studioRole === "OWNER" || m.studioRole === "ADMIN";
          // Private projects, and project-only collaborators anywhere, need to be added explicitly —
          // except people whose studio role already opens the project.
          const explicit = p.visibility === "PRIVATE" || m.projectsOnly;
          return (
            <li key={m.userId} className="flex flex-wrap items-center gap-3 px-3 py-2">
              {explicit ? (
                <Checkbox
                  checked={m.hasAccess}
                  disabled={!canEdit || privileged || m.automaticAccess}
                  title={m.automaticAccess ? `Has access as a studio ${ROLE_LABELS[m.studioRole]}` : undefined}
                  onCheckedChange={(v) => setMember.mutate({ projectId: p.id, userId: m.userId, member: v === true, role: m.projectRole })}
                  aria-label={`Give ${m.displayName} access`}
                />
              ) : null}
              <UserAvatar user={{ displayName: m.displayName, avatarUrl: m.avatarUrl, avatarColor: m.avatarColor }} size="md" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{m.displayName}</p>
                <p className="truncate text-[11.5px] text-fg-subtle">
                  @{m.username} · studio {ROLE_LABELS[m.studioRole]}
                  {m.projectsOnly ? " · projects only" : ""}
                  {explicit && m.automaticAccess && !privileged ? " · has access through their role" : ""}
                </p>
              </div>
              <div className="w-56">
                <Select<string>
                  aria-label={`Project role for ${m.displayName}`}
                  disabled={!canEdit || privileged || (!m.hasAccess && explicit)}
                  value={privileged ? m.studioRole : (m.projectRole ?? "INHERIT")}
                  onValueChange={(v) => setMember.mutate({ projectId: p.id, userId: m.userId, member: true, role: v === "INHERIT" ? null : (v as Role) })}
                  options={
                    privileged
                      ? [{ value: m.studioRole, label: `${ROLE_LABELS[m.studioRole]} (studio)` }]
                      : [
                          { value: "INHERIT", label: `Studio role · ${ROLE_LABELS[m.studioRole]}` },
                          { value: "MANAGER", label: "Manager on this project" },
                          { value: "CONTRIBUTOR", label: "Contributor on this project" },
                          { value: "VIEWER", label: "Viewer on this project" },
                        ]
                  }
                  className="h-7"
                />
              </div>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

/** The project's boards: rename, describe, reorder, archive (restore is in Archived items), create. */
function Boards({ board, canManage, studioSlug }: { board: BoardDTO; canManage: boolean; studioSlug: string }) {
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: qk.board(board.project.id) });
    void queryClient.invalidateQueries({ queryKey: ["projects"] });
  };
  const update = useRpcMutation("board.update", { onSuccess: refresh });
  const move = useRpcMutation("board.move", { onSuccess: refresh });
  const archive = useRpcMutation("board.archive", { onSuccess: () => { refresh(); toast.success("Board archived. Restore it from Archived items below."); } });
  const [creating, setCreating] = useState(false);
  const [archiving, setArchiving] = useState<BoardDTO["boards"][number] | null>(null);
  const list = board.boards;
  return (
    <Section id="boards" title={`Boards · ${list.length}`} description="Separate spaces for this project's work, each with its own columns and cards. Members, access, labels and milestones are shared by every board. The first board is where the project opens.">
      <ul className="divide-y divide-border rounded-lg border border-border">
        {list.map((b, i) => (
          <li key={b.id} className="flex flex-wrap items-start gap-2 px-3 py-2.5">
            <BoardIcon name={b.icon} className="mt-2 size-4 text-fg-subtle" />
            <div className="min-w-0 flex-1 basis-56">
              {canManage ? (
                <>
                  <input
                    defaultValue={b.name}
                    key={`name-${b.id}-${b.name}`}
                    maxLength={60}
                    aria-label={`Name of board ${b.name}`}
                    onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== b.name && update.mutate({ boardId: b.id, name: e.target.value.trim() })}
                    className="h-8 w-full rounded-md border border-transparent bg-transparent px-1.5 text-[13px] font-medium outline-none hover:border-border-strong focus:border-accent focus:bg-surface-3"
                  />
                  <textarea
                    defaultValue={b.description}
                    key={`desc-${b.id}-${b.description}`}
                    maxLength={2000}
                    rows={1}
                    placeholder="Add a description"
                    aria-label={`Description of board ${b.name}`}
                    onBlur={(e) => e.target.value.trim() !== b.description && update.mutate({ boardId: b.id, description: e.target.value })}
                    className="mt-0.5 w-full resize-y rounded-md border border-transparent bg-transparent px-1.5 py-1 text-[12.5px] text-fg-muted outline-none hover:border-border-strong focus:border-accent focus:bg-surface-3"
                  />
                </>
              ) : (
                <>
                  <p className="text-[13px] font-medium">{b.name}</p>
                  {b.description ? <p className="whitespace-pre-wrap text-[12.5px] text-fg-muted">{b.description}</p> : null}
                </>
              )}
              <p className="px-1.5 text-[11.5px] text-fg-subtle">
                {b.cards} card{b.cards === 1 ? "" : "s"}
                {i === 0 ? " · opens first" : ""} ·{" "}
                <Link href={`/${studioSlug}/${board.project.slug}/b/${b.number}`} className="text-accent hover:underline">
                  Open
                </Link>
              </p>
            </div>
            {canManage ? (
              <div className="flex items-center gap-1">
                <Button size="icon-sm" variant="ghost" aria-label={`Move ${b.name} up`} disabled={i === 0 || move.isPending} onClick={() => move.mutate({ boardId: b.id, index: i - 1 })}>
                  <ArrowUp />
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label={`Move ${b.name} down`} disabled={i === list.length - 1 || move.isPending} onClick={() => move.mutate({ boardId: b.id, index: i + 1 })}>
                  <ArrowDown />
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label={`Archive ${b.name}`} disabled={list.length < 2} title={list.length < 2 ? "A project needs at least one board" : undefined} onClick={() => setArchiving(b)}>
                  <Archive />
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {canManage ? (
        <Button className="mt-3" variant="secondary" size="sm" onClick={() => setCreating(true)}>
          <Plus /> Create board
        </Button>
      ) : null}
      <CreateBoardDialog open={creating} onOpenChange={setCreating} board={board} studioSlug={studioSlug} />
      <ConfirmDialog
        open={Boolean(archiving)}
        onOpenChange={(open) => !open && setArchiving(null)}
        title={`Archive “${archiving?.name ?? ""}”?`}
        description="Its columns and cards are hidden (with their notifications) until the board is restored from Archived items. Nothing is deleted."
        confirmLabel="Archive board"
        loading={archive.isPending}
        onConfirm={() => archiving && archive.mutate({ boardId: archiving.id, archived: true }, { onSuccess: () => setArchiving(null) })}
      />
    </Section>
  );
}

function Workflow({ board, canEdit }: { board: BoardDTO; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const p = board.project;
  const update = useRpcMutation("project.update", {
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.board(p.id) });
      toast.success("Saved.");
    },
  });
  const reviewers = board.members.filter((m) => ["OWNER", "ADMIN", "MANAGER"].includes(m.role));
  return (
    <Section id="workflow" title="Board & review workflow">
      <div className="grid gap-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-[13px] font-medium">Default card layout</p>
            <p className="text-[12px] text-fg-muted">Columns and individual cards can override this.</p>
          </div>
          <div className="w-48">
            <Select
              aria-label="Default card layout"
              disabled={!canEdit}
              value={p.defaultCardMode}
              onValueChange={(v) => update.mutate({ projectId: p.id, defaultCardMode: v as "VISUAL" | "COMPACT" })}
              options={[
                { value: "VISUAL", label: "Visual (media first)" },
                { value: "COMPACT", label: "Compact" },
              ]}
            />
          </div>
        </div>
        <label className="flex items-center justify-between gap-4">
          <span>
            <span className="block text-[13px] font-medium">Allow self-approval</span>
            <span className="block text-[12px] text-fg-muted">When off, people assigned to a card can&apos;t approve their own work.</span>
          </span>
          <Switch disabled={!canEdit} checked={p.settings.allowSelfApproval} onCheckedChange={(v) => update.mutate({ projectId: p.id, settings: { allowSelfApproval: v } })} />
        </label>
        <label className="flex items-center justify-between gap-4">
          <span>
            <span className="block text-[13px] font-medium">Require feedback when requesting changes</span>
            <span className="block text-[12px] text-fg-muted">Reviewers must leave at least one actionable item so artists know what to fix.</span>
          </span>
          <Switch disabled={!canEdit} checked={p.settings.requireFeedbackForChanges} onCheckedChange={(v) => update.mutate({ projectId: p.id, settings: { requireFeedbackForChanges: v } })} />
        </label>
        <div>
          <p className="text-[13px] font-medium">Default reviewers</p>
          <p className="mb-2 text-[12px] text-fg-muted">Added to every new card. With no reviewer set, all managers are asked when work is submitted.</p>
          <div className="flex flex-wrap gap-1.5">
            {reviewers.map((m) => {
              const on = p.settings.defaultReviewerIds.includes(m.id);
              return (
                <button
                  key={m.id}
                  type="button"
                  disabled={!canEdit}
                  onClick={() =>
                    update.mutate({
                      projectId: p.id,
                      settings: { defaultReviewerIds: on ? p.settings.defaultReviewerIds.filter((id) => id !== m.id) : [...p.settings.defaultReviewerIds, m.id] },
                    })
                  }
                  aria-pressed={on}
                  className={cn("flex h-8 items-center gap-2 rounded-full border pl-1 pr-3 text-[12.5px] disabled:cursor-not-allowed", on ? "border-accent bg-accent-soft" : "border-border-strong hover:bg-surface-3")}
                >
                  <UserAvatar user={m} size="sm" /> {m.displayName}
                  {on ? <Check className="size-3.5 text-accent" /> : null}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </Section>
  );
}

function Labels({ board, canEdit }: { board: BoardDTO; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: qk.board(board.project.id) });
  const create = useRpcMutation("label.create", { onSuccess: refresh });
  const update = useRpcMutation("label.update", { onSuccess: refresh });
  const remove = useRpcMutation("label.delete", { onSuccess: refresh });
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(LABEL_COLORS[0]);
  const colorPicker = (value: string, onPick: (c: string) => void) => (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" disabled={!canEdit} aria-label="Label colour" className="size-6 shrink-0 rounded-full ring-1 ring-border-strong" style={{ backgroundColor: value }} />
      </PopoverTrigger>
      <PopoverContent className="flex w-auto flex-wrap gap-1.5 p-2">
        {LABEL_COLORS.map((c) => (
          <button key={c} type="button" aria-label={c} onClick={() => onPick(c)} className={cn("size-6 rounded-full", c === value && "ring-2 ring-accent ring-offset-2 ring-offset-surface-2")} style={{ backgroundColor: c }} />
        ))}
      </PopoverContent>
    </Popover>
  );
  const row = (l: LabelDTO) => (
    <li key={l.id} className="flex items-center gap-2.5 px-3 py-2">
      {colorPicker(l.color, (c) => update.mutate({ labelId: l.id, color: c }))}
      <input
        defaultValue={l.name}
        key={l.name}
        disabled={!canEdit}
        aria-label="Label name"
        onBlur={(e) => e.target.value.trim() && e.target.value !== l.name && update.mutate({ labelId: l.id, name: e.target.value })}
        className="h-7 flex-1 rounded-md bg-transparent px-1.5 text-[13px] outline-none focus:bg-surface-3"
      />
      <LabelChip label={l} />
      {canEdit ? (
        <Button size="icon-xs" variant="ghost" aria-label={`Delete ${l.name}`} onClick={() => remove.mutate({ labelId: l.id })}>
          <Trash2 />
        </Button>
      ) : null}
    </li>
  );
  return (
    <Section id="labels" title="Labels" description="Tag cards for filtering — unit types, events, bugs…">
      <ul className="divide-y divide-border rounded-lg border border-border">{board.labels.map(row)}</ul>
      {canEdit ? (
        <div className="mt-3 flex items-center gap-2">
          {colorPicker(color, setColor)}
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New label"
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim()) {
                create.mutate({ projectId: board.project.id, name: name.trim(), color });
                setName("");
              }
            }}
          />
          <Button
            variant="secondary"
            disabled={!name.trim()}
            onClick={() => {
              create.mutate({ projectId: board.project.id, name: name.trim(), color });
              setName("");
            }}
          >
            <Tag /> Add
          </Button>
        </div>
      ) : null}
    </Section>
  );
}

function Milestones({ board, canEdit }: { board: BoardDTO; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: qk.board(board.project.id) });
  const create = useRpcMutation("milestone.create", { onSuccess: refresh });
  const update = useRpcMutation("milestone.update", { onSuccess: refresh });
  const [name, setName] = useState("");
  const [due, setDue] = useState("");
  const row = (m: MilestoneDTO) => (
    <li key={m.id} className={cn("flex flex-wrap items-center gap-2.5 px-3 py-2", m.archived && "opacity-60")}>
      <Flag className={cn("size-4", m.releasedAt ? "text-state-approved" : "text-fg-subtle")} />
      <input
        defaultValue={m.name}
        key={m.name}
        disabled={!canEdit}
        aria-label="Milestone name"
        onBlur={(e) => e.target.value.trim() && e.target.value !== m.name && update.mutate({ milestoneId: m.id, name: e.target.value })}
        className="h-7 min-w-32 flex-1 rounded-md bg-transparent px-1.5 text-[13px] font-medium outline-none focus:bg-surface-3"
      />
      <input
        type="date"
        disabled={!canEdit}
        aria-label="Due date"
        defaultValue={m.dueAt ? format(new Date(m.dueAt), "yyyy-MM-dd") : ""}
        onChange={(e) => update.mutate({ milestoneId: m.id, dueAt: e.target.value ? new Date(`${e.target.value}T18:00:00`).toISOString() : null })}
        className="h-7 rounded-md border border-border-strong/70 bg-surface-3/60 px-2 text-[12.5px] outline-none [color-scheme:dark] light:[color-scheme:light]"
      />
      {m.releasedAt ? <span className="text-[11.5px] text-state-approved">Released {formatShortDate(m.releasedAt)}</span> : null}
      {canEdit ? (
        <>
          <Button size="xs" variant="ghost" onClick={() => update.mutate({ milestoneId: m.id, released: !m.releasedAt })}>
            <Rocket /> {m.releasedAt ? "Unrelease" : "Mark released"}
          </Button>
          <Button size="xs" variant="ghost" onClick={() => update.mutate({ milestoneId: m.id, archived: !m.archived })}>
            {m.archived ? <ArchiveRestore /> : <Archive />} {m.archived ? "Restore" : "Archive"}
          </Button>
        </>
      ) : null}
    </li>
  );
  return (
    <Section id="milestones" title="Milestones & updates" description="Group cards by release (Update 6.0, Halloween Event…) and filter the board to one update.">
      {board.milestones.length ? <ul className="divide-y divide-border rounded-lg border border-border">{board.milestones.map(row)}</ul> : <p className="text-[13px] text-fg-muted">No milestones — they're optional.</p>}
      {canEdit ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input className="min-w-40 flex-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Update 6.5" />
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Milestone due date" className="h-8 rounded-md border border-border-strong/70 bg-surface-3/60 px-2 text-[13px] outline-none [color-scheme:dark] light:[color-scheme:light]" />
          <Button
            variant="secondary"
            disabled={!name.trim()}
            onClick={() => {
              create.mutate({ projectId: board.project.id, name: name.trim(), dueAt: due ? new Date(`${due}T18:00:00`).toISOString() : null });
              setName("");
              setDue("");
            }}
          >
            <Plus /> Add milestone
          </Button>
        </div>
      ) : null}
    </Section>
  );
}

function DangerZone({ board, studioSlug }: { board: BoardDTO; studioSlug: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const p = board.project;
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const archive = useRpcMutation("project.archive", {
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.projects(p.studioId) });
      void queryClient.invalidateQueries({ queryKey: qk.board(p.id) });
      toast.success(p.archived ? "Project restored." : "Project archived. It's now read-only.");
      router.refresh();
    },
  });
  const remove = useRpcMutation("project.delete", {
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.projects(p.studioId) });
      toast.success("Project deleted.");
      router.replace(`/${studioSlug}`);
    },
  });
  return (
    <Section id="danger" title="Danger zone">
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/40 p-3">
          <div>
            <p className="text-[13px] font-medium">{p.archived ? "Restore project" : "Archive project"}</p>
            <p className="text-[12px] text-fg-muted">Archived projects are hidden from the sidebar and become read-only. Nothing is deleted. Only the studio owner can archive and restore.</p>
          </div>
          <Button variant="secondary" loading={archive.isPending} onClick={() => archive.mutate({ projectId: p.id, archived: !p.archived })}>
            {p.archived ? <ArchiveRestore /> : <Archive />} {p.archived ? "Restore" : "Archive"}
          </Button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger/40 p-3">
          <div>
            <p className="text-[13px] font-medium text-danger">Delete project permanently</p>
            <p className="text-[12px] text-fg-muted">
              {p.archived
                ? "Removes the board, all cards, versions, media, feedback and history, and frees its storage. This can't be undone."
                : "Archive the project first — deletion is the last step after archiving."}
            </p>
          </div>
          <Button variant="danger" disabled={!p.archived} onClick={() => setOpen(true)}>
            <Trash2 /> Delete…
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Delete ${p.name}?`}
        destructive
        confirmLabel="Delete project forever"
        loading={remove.isPending}
        confirmDisabled={confirm.trim() !== p.name}
        onConfirm={() => remove.mutate({ projectId: p.id, confirm })}
        description={
          <>
            Type <strong>{p.name}</strong> to confirm. Every card and uploaded file in this project will be deleted.
          </>
        }
      >
        <Input className="mt-3" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={p.name} aria-label="Type the project name to confirm" />
      </ConfirmDialog>
    </Section>
  );
}

export function ProjectSettings({ initialBoard, studioSlug }: { initialBoard: BoardDTO; studioSlug: string }) {
  const { data: board } = useQuery({
    queryKey: qk.boardView(initialBoard.project.id, initialBoard.boardId),
    queryFn: () => rpc("board.get", { projectId: initialBoard.project.id, boardId: initialBoard.boardId }),
    initialData: initialBoard,
  });
  const perms = new Set(board.viewer.permissions);
  const canEdit = perms.has("project.update");
  const nav = [
    ["general", "General"],
    ["members", "Members & permissions"],
    ["boards", "Boards"],
    ["workflow", "Board & workflow"],
    ["labels", "Labels"],
    ["milestones", "Milestones"],
    ["archived", "Archived items"],
    ...(perms.has("project.delete") ? [["danger", "Danger zone"]] : []),
  ];
  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto grid max-w-5xl gap-8 px-4 py-8 md:px-8 lg:grid-cols-[180px_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-8 lg:self-start">
          <p className="text-[12px] text-fg-subtle">
            <Link href={`/${studioSlug}/${board.project.slug}`} className="hover:text-fg">
              {board.project.icon} {board.project.name}
            </Link>
          </p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">Settings</h1>
          <nav aria-label="Settings sections" className="mt-4 hidden gap-0.5 lg:grid">
            {nav.map(([id, label]) => (
              <a key={id} href={`#${id}`} className="rounded-md px-2 py-1.5 text-[13px] text-fg-muted hover:bg-surface-3 hover:text-fg">
                {label}
              </a>
            ))}
          </nav>
        </aside>
        <div className="grid gap-5">
          {!canEdit ? <p className="rounded-lg border border-border-strong bg-surface-2 px-3 py-2 text-[12.5px] text-fg-muted">Only studio owners and admins can change project settings. You&apos;re viewing them read-only.</p> : null}
          <General board={board} canEdit={canEdit} studioSlug={studioSlug} />
          <Access board={board} canEdit={canEdit} />
          <Boards board={board} canManage={perms.has("board.manage") && !board.project.archived} studioSlug={studioSlug} />
          <Workflow board={board} canEdit={canEdit} />
          <Labels board={board} canEdit={perms.has("label.manage")} />
          <Milestones board={board} canEdit={perms.has("milestone.manage")} />
          <Section id="archived" title="Archived items" description="Restore anything that was archived — boards, columns, cards, deliverables and files.">
            <ArchivedItems projectId={board.project.id} canDelete={perms.has("card.delete")} canRestoreColumns={perms.has("column.manage")} />
          </Section>
          {perms.has("project.delete") ? <DangerZone board={board} studioSlug={studioSlug} /> : null}
        </div>
      </div>
    </div>
  );
}
