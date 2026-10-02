"use client";

import { ListChecks, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { useCardMutation } from "@/lib/queries";
import type { ChecklistDTO } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/controls";
import { useWorkspace } from "./workspace-context";

function ChecklistBlock({ list }: { list: ChecklistDTO }) {
  const { card } = useWorkspace();
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
          <Button size="icon-xs" variant="ghost" aria-label="Delete checklist" className="opacity-0 group-hover/list:opacity-100" onClick={() => removeList.mutate({ checklistId: list.id })}>
            <Trash2 />
          </Button>
        ) : null}
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-4" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className={cn("h-full rounded-full transition-[width] duration-300", pct === 100 ? "bg-state-approved" : "bg-accent")} style={{ width: `${pct}%` }} />
      </div>
      <ul className="mt-1.5 grid">
        {list.items.map((item) => (
          <li key={item.id} className="group/item flex items-center gap-2 rounded-md px-1 py-1 hover:bg-surface-3/60">
            <Checkbox checked={item.isDone} disabled={!canEdit} onCheckedChange={(v) => update.mutate({ itemId: item.id, isDone: v === true })} aria-label={item.text} />
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
                className="h-6 flex-1 rounded border border-accent bg-surface-3 px-1.5 text-[13px] outline-none"
              />
            ) : (
              <span
                onDoubleClick={() => {
                  if (!canEdit) return;
                  setEditingId(item.id);
                  setEditText(item.text);
                }}
                className={cn("flex-1 text-[13px]", item.isDone && "text-fg-subtle line-through")}
              >
                {item.text}
              </span>
            )}
            {canEdit ? (
              <button type="button" aria-label={`Delete ${item.text}`} onClick={() => removeItem.mutate({ itemId: item.id })} className="text-fg-subtle opacity-0 hover:text-fg group-hover/item:opacity-100">
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
              className="h-7 flex-1 rounded-md border border-border-strong bg-surface-3 px-2 text-[13px] outline-none focus:border-accent"
            />
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Done
            </Button>
          </div>
        ) : (
          <button type="button" onClick={() => setAdding(true)} className="mt-1 flex items-center gap-1 px-1 text-[12px] text-fg-subtle hover:text-fg">
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
