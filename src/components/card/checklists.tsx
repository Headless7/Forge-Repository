"use client";

import { CalendarPlus, Check, ExternalLink, ImageOff, ImagePlus, ListChecks, Loader2, Plus, Search, Trash2, Upload, UserPlus, UserRound, X } from "lucide-react";
import { useRef, useState, type ClipboardEvent } from "react";
import { toast } from "sonner";
import { canTakeChecklistItems, canTickChecklistItem } from "@/lib/checklist";
import { useCardMutation } from "@/lib/queries";
import type { AttachmentDTO, ChecklistDTO, ChecklistItemDTO, MemberDTO } from "@/lib/types";
import { cn } from "@/lib/utils";
import { LinkedText } from "../comments/rich-text";
import { UserAvatar } from "../domain/avatar";
import { ChecklistDue } from "../domain/checklist-due";
import { DiscordHandle } from "../domain/discord-icon";
import { ImageViewer } from "../media/image-viewer";
import { TipAnchor, useTutorial } from "../tutorial/tutorial";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/controls";
import { Dialog, DialogContent, DialogFooter } from "../ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/menu";
import { useUploads } from "../upload/upload-manager";
import { useWorkspace } from "./workspace-context";

const ITEM_IMAGE_TYPES = "image/png,image/jpeg,image/webp,image/gif";

/** Uploads an item's picture (replacing the one before), from a file picker or a paste. */
function useItemPicture(item: ChecklistItemDTO) {
  const { uploadTarget } = useWorkspace();
  const uploads = useUploads();
  const [uploading, setUploading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const upload = async (files: File[]) => {
    const file = files.find((f) => f.type.startsWith("image/"));
    if (!file) {
      if (files.length) toast.error("Choose an image (PNG, JPEG, WebP or GIF).");
      return;
    }
    setUploading(true);
    try {
      await uploads.uploadFiles({ ...uploadTarget, deliverableId: null, checklistItemId: item.id, label: "Checklist picture" }, [file], "checklist");
    } finally {
      setUploading(false);
    }
  };
  const fileInput = (
    <input
      ref={input}
      type="file"
      hidden
      accept={ITEM_IMAGE_TYPES}
      aria-label={`Picture for ${item.text}`}
      onChange={(e) => {
        void upload([...(e.target.files ?? [])]);
        e.target.value = "";
      }}
    />
  );
  return { upload, uploading, choose: () => input.current?.click(), fileInput };
}

/**
 * A pasted image (e.g. a fresh screenshot) goes to `onImage` — and stops here, so the card's own
 * "paste anywhere" doesn't also upload it as a revision.
 */
function pastedImage(onImage: (files: File[]) => void) {
  return (e: ClipboardEvent<HTMLElement>) => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    onImage(files);
  };
}

/** Adds a picture to an item that has none: upload one, or paste a screenshot. */
function AddItemPicture({ item }: { item: ChecklistItemDTO }) {
  const [open, setOpen] = useState(false);
  const picture = useItemPicture(item);
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Add a picture to ${item.text}`}
            title="Add a picture"
            disabled={picture.uploading}
            className={cn(
              "touch-target mt-[3px] text-fg-subtle hover:text-fg",
              !picture.uploading && "hover-reveal opacity-0 focus-visible:opacity-100 group-hover/item:opacity-100 data-[state=open]:opacity-100",
            )}
          >
            {picture.uploading ? <Loader2 className="size-3.5 animate-spin" aria-label="Uploading" /> : <ImagePlus className="size-3.5" />}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          collisionPadding={8}
          className="grid w-60 max-w-[calc(100vw-16px)] gap-2 p-3"
          onPaste={pastedImage((files) => {
            setOpen(false);
            void picture.upload(files);
          })}
        >
          <p className="text-[12px] font-medium text-fg">Picture for this item</p>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setOpen(false);
              picture.choose();
            }}
          >
            <Upload /> Upload image…
          </Button>
          <p className="text-[11.5px] leading-snug text-fg-muted [@media(pointer:coarse)]:hidden">Or paste a screenshot (Ctrl+V) while this is open.</p>
        </PopoverContent>
      </Popover>
      {picture.fileInput}
    </>
  );
}

/** An item's picture: a thumbnail that opens it large, where card editors replace or remove it. */
function ItemPicture({ item, image, canEdit }: { item: ChecklistItemDTO; image: AttachmentDTO; canEdit: boolean }) {
  const { card } = useWorkspace();
  const [open, setOpen] = useState(false);
  const picture = useItemPicture(item);
  const remove = useCardMutation("checklist.removeItemImage", card.id, card.projectId, { onSuccess: () => setOpen(false) });
  const src = image.thumbUrl ?? image.url;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`View the picture for ${item.text}`}
        className={cn(
          "relative mt-1 flex h-20 max-w-48 items-center justify-center overflow-hidden rounded-md border border-border-strong bg-surface-4 text-fg-subtle hover:border-accent focus-visible:ring-2 focus-visible:ring-ring",
          item.isDone && "opacity-60",
        )}
      >
        {src ? <img src={src} alt="" loading="lazy" decoding="async" className="h-full w-auto max-w-48 object-cover" /> : <Loader2 className="mx-6 size-4 animate-spin" aria-label="Processing" />}
        {picture.uploading ? (
          <span className="absolute inset-0 flex items-center justify-center bg-overlay">
            <Loader2 className="size-4 animate-spin text-fg" aria-label="Uploading" />
          </span>
        ) : null}
      </button>
      <DialogContent size="xl" title={item.text} hideTitle onPaste={canEdit ? pastedImage((files) => void picture.upload(files)) : undefined}>
        <p className="mb-3 pr-8 text-[13px] text-fg [overflow-wrap:anywhere]">
          <LinkedText text={item.text} />
        </p>
        <div className="h-[min(62dvh,560px)] overflow-hidden rounded-lg">
          {image.url ? (
            <ImageViewer src={image.url} alt={item.text} naturalWidth={image.width} naturalHeight={image.height} markers={[]} />
          ) : (
            <div className="flex h-full items-center justify-center bg-surface-4 text-fg-subtle">
              <Loader2 className="size-5 animate-spin" aria-label="Processing" />
            </div>
          )}
        </div>
        <DialogFooter className="justify-between">
          {image.url ? (
            <a href={image.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-fg-muted hover:bg-surface-4 hover:text-fg">
              <ExternalLink className="size-3.5" /> Open original
            </a>
          ) : (
            <span />
          )}
          {canEdit ? (
            <span className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="ghost" loading={remove.isPending} onClick={() => remove.mutate({ itemId: item.id })}>
                <ImageOff /> Remove
              </Button>
              <Button size="sm" variant="secondary" loading={picture.uploading} onClick={picture.choose}>
                <Upload /> Replace…
              </Button>
            </span>
          ) : null}
        </DialogFooter>
        {picture.fileInput}
      </DialogContent>
    </Dialog>
  );
}

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
  const [query, setQuery] = useState("");
  const person = item.assigneeId ? (membersById.get(item.assigneeId) ?? null) : null;
  const summary =
    item.assigneeId || item.dueOn ? (
      <>
        {item.dueOn ? <ChecklistDue dueOn={item.dueOn} isDone={item.isDone} /> : null}
        {item.assigneeId ? <ItemPerson person={person} /> : null}
      </>
    ) : null;

  if (!canEdit) return summary ? <span className="flex min-w-0 items-center gap-2">{summary}</span> : null;

  const q = query.trim().toLowerCase();
  const candidates = members
    .filter((m) => canTakeChecklistItems(m.role))
    .filter((m) => !q || [m.displayName, m.title, m.discord?.username].some((v) => v?.toLowerCase().includes(q)));
  const showNobody = !q || "nobody".includes(q);
  const choose = (assigneeId: string | null) => assigneeId !== item.assigneeId && update({ itemId: item.id, assigneeId });
  return (
    <Popover
      onOpenChange={(open) => {
        if (!open) setQuery("");
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
        // Opening focuses the search box — except on touch screens, where that would throw up the keyboard.
        onOpenAutoFocus={(e) => window.matchMedia("(pointer: coarse)").matches && e.preventDefault()}
      >
        <div>
          <p className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">Given to</p>
          <div className="relative mb-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // Enter gives it to the one person left (or the first match).
                if (e.key === "Enter" && q && candidates[0]) {
                  e.preventDefault();
                  choose(candidates[0].id);
                }
              }}
              placeholder="Search people…"
              aria-label="Search people"
              className="h-8 w-full rounded-md border border-border-strong bg-surface-3 pl-7 pr-2 text-[13px] outline-none focus:border-accent"
            />
          </div>
          <ul className="scrollbar-thin max-h-56 overflow-y-auto overscroll-contain" aria-label="People">
            {showNobody ? (
              <li>
                <button type="button" onClick={() => choose(null)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-surface-4">
                  <UserRound className="size-5 text-fg-subtle" aria-hidden />
                  <span className="flex-1">Nobody</span>
                  {!item.assigneeId ? <Check className="size-4 text-accent" aria-label="Selected" /> : null}
                </button>
              </li>
            ) : null}
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
            {q && !candidates.length && !showNobody ? <li className="px-2 py-1.5 text-[12.5px] text-fg-muted">No one matches “{query.trim()}”.</li> : null}
            {item.assigneeId && !person && !q ? (
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
  const images = new Map(card.attachments.map((a) => [a.id, a]));
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
                    data-inline-edit
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
                    className={cn("min-w-32 flex-1 text-[13px] [overflow-wrap:anywhere]", item.isDone && "text-fg-subtle line-through")}
                  >
                    <LinkedText text={item.text} />
                  </span>
                )}
                <span className="ml-auto flex min-w-0 max-w-full items-center">
                  <ItemPeople item={item} canEdit={canEdit} />
                </span>
                {item.imageId && images.has(item.imageId) ? (
                  <span className="flex basis-full">
                    <ItemPicture item={item} image={images.get(item.imageId)!} canEdit={canEdit} />
                  </span>
                ) : null}
              </div>
              {canEdit && !item.imageId ? <AddItemPicture item={item} /> : null}
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
              data-inline-edit
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
