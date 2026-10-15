"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Check, Plus, Tag, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { SUGGESTED_FORUM_TAGS } from "@/lib/forum-meta";
import { LABEL_COLORS } from "@/lib/column-icons";
import { qk, useRpcMutation } from "@/lib/queries";
import type { ForumTagDTO } from "@/lib/types";
import { cn, dueStatus, toLocalInput } from "@/lib/utils";
import { DueChip, LabelChip } from "../domain/state";
import { Button } from "../ui/button";
import { Dialog, DialogContent } from "../ui/dialog";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/menu";

export { PersonPicker } from "../domain/people-menu";

/** How long a typed deadline waits before it's saved: typing a date passes through other valid dates. */
const DUE_SAVE_DELAY_MS = 800;

/**
 * An item's deadline, like the card sidebar's: a date-and-time field with a clear button, or the
 * due chip when read-only. `done` items (verified, closed) never show as overdue. With `deferred`,
 * edits are saved once typing pauses (or on Enter, blur or close) rather than on every keystroke,
 * so one change makes one save, one history entry and one notice.
 */
export function DueDateField({ value, onChange, canEdit, done, deferred, className }: { value: string | null; onChange: (dueAt: string | null) => void; canEdit: boolean; done?: boolean; deferred?: boolean; className?: string }) {
  const [draft, setDraft] = useState(() => toLocalInput(value));
  const pending = useRef<{ local: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const save = useRef(onChange);
  useEffect(() => {
    save.current = onChange;
  });
  const flush = useCallback(() => {
    const p = pending.current;
    if (!p) return;
    clearTimeout(p.timer);
    pending.current = null;
    save.current(p.local ? new Date(p.local).toISOString() : null);
  }, []);
  // An edit still waiting is saved when the field goes away (the dialog closes).
  useEffect(() => flush, [flush]);
  // Follow the saved value (and other people's changes) unless an edit is waiting.
  useEffect(() => {
    if (!pending.current) setDraft(toLocalInput(value));
  }, [value]);
  const edit = (local: string) => {
    setDraft(local);
    if (!deferred) return onChange(local ? new Date(local).toISOString() : null);
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = { local, timer: setTimeout(flush, DUE_SAVE_DELAY_MS) };
  };
  const clear = () => {
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = null;
    setDraft("");
    onChange(null);
  };
  const due = dueStatus(draft ? new Date(draft).toISOString() : null, done);
  if (!canEdit) return value ? <DueChip dueAt={value} done={done} className={className} /> : <span className={cn("text-fg-subtle", className)}>None</span>;
  return (
    <div className={cn("flex min-w-0 items-center gap-1", className)}>
      <input
        type="datetime-local"
        aria-label="Due date"
        value={draft}
        onChange={(e) => edit(e.target.value)}
        onBlur={flush}
        onKeyDown={(e) => e.key === "Enter" && flush()}
        className={cn(
          "h-7 min-w-0 flex-1 rounded-md border border-border-strong/70 bg-surface-3/60 px-2 text-[12.5px] outline-none focus:border-accent [color-scheme:dark] light:[color-scheme:light]",
          due === "overdue" && "text-state-changes",
          (due === "today" || due === "soon") && "text-state-review",
        )}
      />
      {draft ? (
        <Button type="button" size="icon-xs" variant="ghost" aria-label="Clear due date" className="touch-target" onClick={clear}>
          <X />
        </Button>
      ) : null}
    </div>
  );
}

/** Creates a tag and tells the forum; `onCreated` gets the new tag (e.g. to select it). */
function useCreateTag(projectId: string, onCreated?: (tag: ForumTagDTO) => void) {
  const queryClient = useQueryClient();
  return useRpcMutation("forumTag.create", {
    onSuccess: (tag) => {
      void queryClient.invalidateQueries({ queryKey: qk.forums(projectId) });
      onCreated?.(tag);
    },
  });
}

/** Where an item happens: chips plus a popover to toggle tags (and, for managers, make new ones). */
export function TagPicker({
  selected,
  tags,
  forumId,
  projectId,
  canEdit,
  canManage,
  onChange,
}: {
  selected: string[];
  tags: ForumTagDTO[];
  forumId: string;
  projectId: string;
  canEdit: boolean;
  canManage: boolean;
  onChange: (tagIds: string[]) => void;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(LABEL_COLORS[0]!);
  const create = useCreateTag(projectId, (tag) => {
    onChange([...selected, tag.id]);
    setName("");
  });
  const chosen = selected.map((id) => tags.find((t) => t.id === id)).filter((t): t is ForumTagDTO => Boolean(t));
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const chips = chosen.map((t) => <LabelChip key={t.id} label={t} />);
  if (!canEdit) return <span className="flex flex-wrap gap-1">{chips.length ? chips : <span className="text-fg-subtle">None</span>}</span>;
  return (
    <Popover>
      <span className="flex flex-wrap items-center gap-1">
        {chips}
        <PopoverTrigger asChild>
          <button type="button" aria-label="Choose tags" className="touch-target inline-flex h-[18px] items-center gap-1 rounded border border-dashed border-border-strong px-1.5 text-[10.5px] font-medium text-fg-subtle hover:border-fg-subtle hover:text-fg">
            <Plus className="size-3" /> {chips.length ? null : "Tag"}
          </button>
        </PopoverTrigger>
      </span>
      <PopoverContent className="flex w-64 max-w-[calc(100vw-16px)] flex-col gap-2 p-2">
        <p className="px-1 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">Tags</p>
        {tags.length ? (
          <ul className="scrollbar-thin max-h-56 overflow-y-auto overscroll-contain">
            {tags.map((t) => {
              const on = selected.includes(t.id);
              return (
                <li key={t.id}>
                  <button type="button" onClick={() => toggle(t.id)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-surface-4" aria-pressed={on}>
                    <LabelChip label={t} />
                    <span className="flex-1" />
                    {on ? <Check className="size-4 text-accent" aria-label="Selected" /> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="px-1 text-[12.5px] text-fg-muted">No tags yet.{canManage ? " Make some: where in the game it happens." : ""}</p>
        )}
        {canManage ? (
          <div className="border-t border-border pt-2">
            {!tags.length ? (
              <div className="mb-2 flex flex-wrap gap-1">
                {SUGGESTED_FORUM_TAGS.map((s) => (
                  <Button key={s.name} size="xs" variant="secondary" loading={create.isPending && create.variables?.name === s.name} onClick={() => create.mutate({ forumId, name: s.name, color: s.color })}>
                    <Plus /> {s.name}
                  </Button>
                ))}
              </div>
            ) : null}
            <form
              className="flex items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim()) create.mutate({ forumId, name: name.trim(), color });
              }}
            >
              <ColorDot color={color} onChange={setColor} />
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New tag…" aria-label="New tag name" className="h-7 text-[12.5px]" maxLength={40} />
              <Button type="submit" size="xs" variant="secondary" disabled={!name.trim()} loading={create.isPending}>
                Add
              </Button>
            </form>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/** Cycles through the label palette on each press. */
function ColorDot({ color, onChange }: { color: string; onChange: (color: string) => void }) {
  return (
    <button
      type="button"
      aria-label="Tag colour (press to change)"
      title="Change colour"
      onClick={() => onChange(LABEL_COLORS[((LABEL_COLORS as readonly string[]).indexOf(color) + 1) % LABEL_COLORS.length]!)}
      className="touch-target size-5 shrink-0 rounded-full border border-border-strong"
      style={{ backgroundColor: color }}
    />
  );
}

/** Rename, recolour and delete a forum's tags (managers). */
export function TagManagerDialog({ open, onOpenChange, tags, forumId, projectId }: { open: boolean; onOpenChange: (open: boolean) => void; tags: ForumTagDTO[]; forumId: string; projectId: string }) {
  const queryClient = useQueryClient();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: qk.forums(projectId) });
  const update = useRpcMutation("forumTag.update", { onSuccess: refresh });
  const remove = useRpcMutation("forumTag.delete", { onSuccess: refresh });
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(LABEL_COLORS[0]!);
  const create = useCreateTag(projectId, () => setName(""));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Tags" description="Where in the game an item happens — Lobby, Play Area, UI… Every item can carry several.">
        {tags.length ? (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {tags.map((t) => (
              <li key={t.id} className="flex items-center gap-2 px-2 py-1.5">
                <ColorDot color={t.color} onChange={(c) => update.mutate({ tagId: t.id, color: c })} />
                <input
                  key={t.name}
                  defaultValue={t.name}
                  aria-label="Tag name"
                  maxLength={40}
                  onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== t.name && update.mutate({ tagId: t.id, name: e.target.value.trim() })}
                  className="h-7 min-w-0 flex-1 rounded-md bg-transparent px-1.5 text-[13px] font-medium outline-none focus:bg-surface-3"
                />
                <LabelChip label={t} />
                <Button size="icon-xs" variant="ghost" aria-label={`Delete tag ${t.name}`} onClick={() => remove.mutate({ tagId: t.id })} className="touch-target text-fg-subtle hover:text-danger">
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-fg-muted">No tags yet.</p>
        )}
        {!tags.length ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {SUGGESTED_FORUM_TAGS.map((s) => (
              <Button key={s.name} size="sm" variant="secondary" onClick={() => create.mutate({ forumId, name: s.name, color: s.color })}>
                <Plus /> {s.name}
              </Button>
            ))}
          </div>
        ) : null}
        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate({ forumId, name: name.trim(), color });
          }}
        >
          <ColorDot color={color} onChange={setColor} />
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New tag…" aria-label="New tag name" maxLength={40} />
          <Button type="submit" variant="secondary" disabled={!name.trim()} loading={create.isPending}>
            <Tag /> Add
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
