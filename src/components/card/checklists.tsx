"use client";

import { CalendarPlus, Check, ListChecks, Plus, Trash2, UserPlus, UserRound, X } from "lucide-react";
import { useRef, useState } from "react";
import { canTakeChecklistItems, canTickChecklistItem } from "@/lib/checklist";
import { useCardMutation } from "@/lib/queries";
import type { ChecklistDTO, ChecklistItemDTO, MemberDTO } from "@/lib/types";
import { cn } from "@/lib/utils";
import { UserAvatar } from "../domain/avatar";
import { ChecklistDue } from "../domain/checklist-due";
import { DiscordHandle } from "../domain/discord-icon";
import { TipAnchor, useTutorial } from "../tutorial/tutorial";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/controls";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/menu";
import { useWorkspace } from "./workspace-context";

function ItemPerson({ person }: { person: MemberDTO | null }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-[11.5px] text-fg-muted">
      {person ? <UserAvatar user={person} size="xs" /> : <UserRound className="size-4 shrink-0 text-fg-subtle" aria-hidden />}
      <span className="max-w-28 truncate">{person?.displayName ?? "Former member"}</span>
    </span>
  );
}

/**
 * Who an item is given to and the day it's due. Card editors change both from one popover;
 * everyone else just sees them.
 */
function ItemPeople({ item, canEdit }: { item: ChecklistItemDTO; canEdit: boolean }) {
  const { card, members, membersById } = useWorkspace();
  const tutorial = useTutorial();
  // Someone was given the item or a day was set while the popover was open.
  const gave = useRef(false);
  const mutation = useCardMutation("checklist.updateItem", card.id, card.projectId);
  const update = (input: { itemId: string; assigneeId?: string | null; dueOn?: string | null }) => {
    if (input.assigneeId || input.dueOn) gave.current = true;
    mutation.mutate(input);
  };
  const person = item.assigneeId ? (membersById.get(item.assigneeId) ?? null) : null;
  const summary =
    item.assigneeId || item.dueOn ? (
      <>
        {item.dueOn ? <ChecklistDue dueOn={item.dueOn} isDone={item.isDone} /> : null}
        {item.assigneeId ? <ItemPerson person={person} /> : null}
      </>
    ) : null;

  if (!canEdit) return summary ? <span className="flex min-w-0 items-center gap-2">{summary}</span> : null;

  const candidates = members.filter((m) => canTakeChecklistItems(m.role));
  const choose = (assigneeId: string | null) => assigneeId !== item.assigneeId && update({ itemId: item.id, assigneeId });
  return (
    <Popover
      onOpenChange={(open) => {
        if (open || !gave.current) return;
        gave.current = false;
        // After giving an item a person or a day (popover closed): what that means for them.
        tutorial.trigger("card.checklist-people", { place: item.id });
      }}
    >
      <TipAnchor tip="card.checklist-people" place={item.id} facts={{ canEdit }}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={summary ? `Person and due date for ${item.text}` : `Give ${item.text} to someone or set a due date`}
            className={cn(
              "flex min-h-6 min-w-0 items-center gap-2 rounded-md px-1 text-fg-subtle hover:bg-surface-4 hover:text-fg",
              !summary && "hover-reveal opacity-0 focus-visible:opacity-100 group-hover/item:opacity-100 data-[state=open]:opacity-100",
            )}
          >
            {summary ?? (
              <>
                <UserPlus className="size-3.5" aria-hidden />
                <CalendarPlus className="size-3.5" aria-hidden />
              </>
            )}
          </button>
        </PopoverTrigger>
      </TipAnchor>
      <PopoverContent
        align="end"
        collisionPadding={8}
        className="flex max-h-[var(--radix-popover-content-available-height)] w-64 max-w-[calc(100vw-16px)] flex-col gap-3 overflow-y-auto p-2"
      >
        <div>
          <p className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">Given to</p>
          <ul className="scrollbar-thin max-h-56 overflow-y-auto">
            <li>
              <button type="button" onClick={() => choose(null)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-surface-4">
                <UserRound className="size-5 text-fg-subtle" aria-hidden />
                <span className="flex-1">Nobody</span>
                {!item.assigneeId ? <Check className="size-4 text-accent" aria-label="Selected" /> : null}
              </button>
            </li>
            {candidates.map((m) => (
              <li key={m.id}>
                <button type="button" onClick={() => choose(m.id)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-surface-4">
                  <UserAvatar user={m} size="xs" online={m.online} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{m.displayName}</span>
                    {m.discord ? <DiscordHandle username={m.discord.username} className="text-[11px]" /> : null}
                  </span>
                  {item.assigneeId === m.id ? <Check className="size-4 text-accent" aria-label="Selected" /> : null}
                </button>
              </li>
            ))}
            {item.assigneeId && !person ? (
              <li className="flex items-center gap-2 px-2 py-1.5 text-[13px] text-fg-muted">
                <UserRound className="size-5 text-fg-subtle" aria-hidden />
                <span className="flex-1">Former member</span>
                <Check className="size-4 text-accent" aria-label="Selected" />
              </li>
            ) : null}
          </ul>
        </div>
        <div className="border-t border-border px-1 pt-2">
          <label htmlFor={`due-${item.id}`} className="block pb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
            Due date
          </label>
          <div className="flex items-center gap-1">
            <input
              id={`due-${item.id}`}
              type="date"
              value={item.dueOn ?? ""}
              min="2000-01-01"
              max="2100-12-31"
              onChange={(e) => (e.target.value || item.dueOn) && e.target.value !== (item.dueOn ?? "") && update({ itemId: item.id, dueOn: e.target.value || null })}
              className="h-8 min-w-0 flex-1 rounded-md border border-border-strong/70 bg-surface-3/60 px-2 text-[13px] outline-none focus:border-accent [color-scheme:dark] light:[color-scheme:light]"
            />
            {item.dueOn ? (
              <Button size="xs" variant="ghost" onClick={() => update({ itemId: item.id, dueOn: null })}>
                Clear
              </Button>
            ) : null}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ChecklistBlock({ list }: { list: ChecklistDTO }) {
  const { card, viewerId } = useWorkspace();
  const canEdit = card.permissions.canEdit;
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const update = useCardMutation("checklist.updateItem", card.id, card.projectId);
  const addItem = useCardMutation("checklist.addItem", card.id, card.projectId, { onSuccess: () => setText("") });
  const removeItem = useCardMutation("checklist.deleteItem", card.id, card.projectId);
  const removeList = useCardMutation("checklist.delete", card.id, card.projectId);
  const rename = useCardMutation("checklist.rename", card.id, card.projectId);
  const done = list.items.filter((i) => i.isDone).length;
  const pct = list.items.length ? Math.round((done / list.items.length) * 100) : 0;

  return (
    <div className="group/list">
      <div className="flex items-center gap-2">
        <ListChecks className="size-4 text-fg-subtle" />
        <input
          defaultValue={list.title}
          key={list.title}
          readOnly={!canEdit}
          aria-label="Checklist title"
          onBlur={(e) => e.target.value.trim() && e.target.value !== list.title && rename.mutate({ checklistId: list.id, title: e.target.value })}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          className="min-w-0 flex-1 bg-transparent text-[13px] font-semibold outline-none"
        />
        <span className="text-[11.5px] tabular-nums text-fg-muted">
          {done}/{list.items.length}
        </span>
        {canEdit ? (
          <Button size="icon-xs" variant="ghost" aria-label="Delete checklist" className="hover-reveal opacity-0 focus-visible:opacity-100 group-hover/list:opacity-100" onClick={() => removeList.mutate({ checklistId: list.id })}>
            <Trash2 />
          </Button>
        ) : null}
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-4" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className={cn("h-full rounded-full transition-[width] duration-300", pct === 100 ? "bg-state-approved" : "bg-accent")} style={{ width: `${pct}%` }} />
      </div>
      <ul className="mt-1.5 grid">
          {list.items.map((item) => (
            <li key={item.id} className="group/item flex items-start gap-2 rounded-md px-1 py-1 hover:bg-surface-3/60">
              <Checkbox
                checked={item.isDone}
                disabled={!canTickChecklistItem(card.permissions, item, viewerId)}
                onCheckedChange={(v) => update.mutate({ itemId: item.id, isDone: v === true })}
                aria-label={item.text}
                className="mt-[3px]"
              />
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
                {editingId === item.id ? (
                  <input
                    autoFocus
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onBlur={() => {
                      if (editText.trim() && editText !== item.text) update.mutate({ itemId: item.id, text: editText });
                      setEditingId(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    className="h-6 min-w-32 flex-1 rounded border border-accent bg-surface-3 px-1.5 text-[13px] outline-none"
                  />
                ) : (
                  <span
                    onDoubleClick={() => {
                      if (!canEdit) return;
                      setEditingId(item.id);
                      setEditText(item.text);
                    }}
                    className={cn("min-w-32 flex-1 break-words text-[13px]", item.isDone && "text-fg-subtle line-through")}
                  >
                    {item.text}
                  </span>
                )}
                <span className="ml-auto flex min-w-0 max-w-full items-center">
                  <ItemPeople item={item} canEdit={canEdit} />
                </span>
              </div>
              {canEdit ? (
                <button
                  type="button"
                  aria-label={`Delete ${item.text}`}
                  onClick={() => removeItem.mutate({ itemId: item.id })}
                  className="hover-reveal touch-target mt-[3px] text-fg-subtle opacity-0 hover:text-fg focus-visible:opacity-100 group-hover/item:opacity-100"
                >
                  <X className="size-3.5" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      {canEdit ? (
        adding ? (
          <div className="mt-1 flex gap-1.5">
            <input
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter" && text.trim()) addItem.mutate({ checklistId: list.id, text });
                if (e.key === "Escape") setAdding(false);
              }}
              placeholder="Add an item and press Enter"
              aria-label="New checklist item"
              className="h-7 min-w-0 flex-1 rounded-md border border-border-strong bg-surface-3 px-2 text-[13px] outline-none focus:border-accent"
            />
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Done
            </Button>
          </div>
        ) : (
          <button type="button" onClick={() => setAdding(true)} className="mt-1 flex min-h-6 items-center gap-1 px-1 text-[12px] text-fg-subtle hover:text-fg">
            <Plus className="size-3.5" /> Add item
          </button>
        )
      ) : null}
    </div>
  );
}

export function Checklists() {
  const { card } = useWorkspace();
  const create = useCardMutation("checklist.create", card.id, card.projectId);
  if (!card.checklists.length && !card.permissions.canEdit) return null;
  return (
    <section aria-label="Checklists" className="grid gap-4">
      {card.checklists.map((list) => (
        <ChecklistBlock key={list.id} list={list} />
      ))}
      {card.permissions.canEdit ? (
        <div>
          <Button size="xs" variant="ghost" loading={create.isPending} onClick={() => create.mutate({ cardId: card.id, title: card.checklists.length ? "Checklist" : "Tasks" })}>
            <ListChecks /> Add checklist
          </Button>
        </div>
      ) : null}
    </section>
  );
}
