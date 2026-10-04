"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Plus, Search, Settings2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { toast } from "sonner";
import { BOARD_ICONS, DEFAULT_BOARD_ICON } from "@/lib/board-icons";
import { ROBLOX_TEMPLATE } from "@/lib/column-icons";
import { qk, useRpcMutation } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc-client";
import type { BoardDTO, BoardSummaryDTO, ProjectListItemDTO } from "@/lib/types";
import { cn } from "@/lib/utils";
import { BOARD_ICON_COMPONENTS, BoardIcon } from "../domain/board-icon";
import { IconGrid } from "../domain/icon-grid";
import { TipAnchor, useTutorial } from "../tutorial/tutorial";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogFooter } from "../ui/dialog";
import { FieldError, Input, Label, Textarea } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/menu";

export function boardHref(studioSlug: string, projectSlug: string, board: Pick<BoardSummaryDTO, "number">) {
  return `/${studioSlug}/${projectSlug}/b/${board.number}`;
}

/**
 * The current project › board breadcrumb, opening the list of the project's boards. Searchable once
 * there are more than a handful, and scrolls however many there are.
 */
export function BoardSwitcher({ board, studioSlug, canManage }: { board: BoardDTO; studioSlug: string; canManage: boolean }) {
  const tutorial = useTutorial();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const boards = needle ? board.boards.filter((b) => b.name.toLowerCase().includes(needle) || b.description.toLowerCase().includes(needle)) : board.boards;
  return (
    <>
      <Popover
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) setQ("");
        }}
      >
        <PopoverTrigger asChild>
          <TipAnchor tip="board.boards" facts={{ boardCount: board.boards.length }}>
            <button
              type="button"
              aria-label={`Board: ${board.board.name}. Switch board`}
              className="inline-flex h-7 min-w-0 max-w-[46vw] items-center gap-1.5 rounded-md border border-border-strong px-2 text-[12.5px] font-medium hover:bg-surface-3 md:max-w-64"
            >
              <BoardIcon name={board.board.icon} className="size-3.5 text-fg-subtle" />
              <span className="min-w-0 truncate">{board.board.name}</span>
              {board.boards.length > 1 ? <span className="shrink-0 text-[11px] font-normal text-fg-subtle">{board.boards.length}</span> : null}
              <ChevronDown className="size-3.5 shrink-0 text-fg-subtle" />
            </button>
          </TipAnchor>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[min(320px,calc(100vw-24px))] p-0">
          <div className="border-b border-border px-3 py-2">
            <p className="text-[12px] text-fg-subtle">
              {board.project.icon} {board.project.name}
            </p>
            <p className="text-[13px] font-semibold">Boards · {board.boards.length}</p>
          </div>
          {board.boards.length > 6 ? (
            <div className="relative border-b border-border p-2">
              <Search className="pointer-events-none absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Find a board…"
                aria-label="Find a board"
                className="h-8 w-full rounded-md border border-border-strong bg-surface-3 pl-7 pr-2 text-[13px] outline-none focus:border-accent"
              />
            </div>
          ) : null}
          <ul className="scrollbar-thin max-h-[min(360px,55vh)] overflow-y-auto p-1" aria-label="Boards">
            {boards.map((b) => {
              const current = b.id === board.boardId;
              return (
                <li key={b.id}>
                  <Link
                    href={boardHref(studioSlug, board.project.slug, b)}
                    aria-current={current ? "page" : undefined}
                    onClick={() => {
                      setOpen(false);
                      // Opening another board is when the shared/separate split matters.
                      if (!current) tutorial.trigger("board.boards", { afterNavigation: true });
                    }}
                    className={cn("flex min-h-10 items-start gap-2 rounded-md px-2 py-1.5 hover:bg-surface-3", current && "bg-surface-3")}
                  >
                    <Check className={cn("mt-0.5 size-3.5 shrink-0", current ? "text-accent" : "invisible")} />
                    <BoardIcon name={b.icon} className="mt-0.5 size-3.5 text-fg-subtle" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{b.name}</span>
                      {b.description ? <span className="block truncate text-[11.5px] text-fg-subtle">{b.description}</span> : null}
                    </span>
                    <span className="shrink-0 text-[11px] tabular-nums text-fg-subtle">{b.cards} card{b.cards === 1 ? "" : "s"}</span>
                  </Link>
                </li>
              );
            })}
            {boards.length === 0 ? <li className="px-3 py-2 text-[12.5px] text-fg-muted">No board matches “{q}”.</li> : null}
          </ul>
          <div className="flex flex-wrap gap-1 border-t border-border p-1.5">
            {canManage ? (
              <Button
                size="sm"
                variant="ghost"
                className="flex-1 justify-start"
                onClick={() => {
                  setOpen(false);
                  setCreating(true);
                }}
              >
                <Plus /> Create board
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" asChild className="flex-1 justify-start">
              <Link href={`/${studioSlug}/${board.project.slug}/settings#boards`} onClick={() => setOpen(false)}>
                <Settings2 /> Manage boards
              </Link>
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      <CreateBoardDialog open={creating} onOpenChange={setCreating} board={board} studioSlug={studioSlug} />
    </>
  );
}

type Setup = "copy" | "roblox" | "empty";

export function CreateBoardDialog({ open, onOpenChange, board, studioSlug }: { open: boolean; onOpenChange: (open: boolean) => void; board: BoardDTO; studioSlug: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [setup, setSetup] = useState<Setup>(board.columns.length ? "copy" : "roblox");
  const [error, setError] = useState<string | null>(null);
  const create = useRpcMutation("board.create", {
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: qk.board(board.project.id) });
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      toast.success(`Board “${created.name}” created.`);
      onOpenChange(false);
      setName("");
      setDescription("");
      router.push(boardHref(studioSlug, board.project.slug, created));
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Name the board.");
      return;
    }
    setError(null);
    create.mutate({
      projectId: board.project.id,
      name: name.trim(),
      description: description.trim() || undefined,
      columns: setup === "copy" ? { copyFromBoardId: board.boardId } : setup,
    });
  };
  const options: Array<[Setup, string, string]> = [
    ...(board.columns.length ? ([["copy", `Same columns as “${board.board.name}”`, board.columns.map((c) => c.name).slice(0, 5).join(", ") + (board.columns.length > 5 ? "…" : "")]] as Array<[Setup, string, string]>) : []),
    ["roblox", "Roblox starter columns", ROBLOX_TEMPLATE.map((c) => c.name).slice(0, 5).join(", ") + "…"],
    ["empty", "No columns", "Start empty and add your own."],
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Create board" description={`A new space in ${board.project.name}, with its own columns and cards. Members, labels and access stay the project's.`}>
        <form onSubmit={submit} className="scrollbar-thin -mr-1 grid max-h-[min(70vh,calc(100dvh-160px))] gap-4 overflow-y-auto pr-1">
          <div>
            <Label htmlFor="board-name">Name</Label>
            <Input id="board-name" autoFocus maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Update 7, Marketing, Bugs" aria-invalid={Boolean(error)} />
            <FieldError>{error}</FieldError>
          </div>
          <div>
            <Label htmlFor="board-description">Description (optional)</Label>
            <Textarea id="board-description" maxLength={2000} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this board is for" />
          </div>
          <div role="radiogroup" aria-label="Columns" className="grid gap-1.5">
            <Label>Columns</Label>
            {options.map(([value, title, hint]) => (
              <label key={value} className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border-strong p-2.5 has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
                <input type="radio" name="board-setup" value={value} checked={setup === value} onChange={() => setSetup(value)} className="mt-1 accent-[var(--accent)]" />
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium">{title}</span>
                  <span className="block truncate text-[12px] text-fg-muted">{hint}</span>
                </span>
              </label>
            ))}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={create.isPending}>
              <Plus /> Create board
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Rename a board or change its description. The form is mounted per opening (dialog content is
 * unmounted when closed), so every opening starts from the latest saved details and Cancel
 * discards the draft.
 */
export function EditBoardDialog({
  open,
  onOpenChange,
  board,
  returnFocusRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  board: BoardDTO;
  /** Where focus goes back to when the dialog closes (it's opened from a menu, not a trigger). */
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Board details"
        onCloseAutoFocus={(e) => {
          if (!returnFocusRef?.current) return;
          e.preventDefault();
          returnFocusRef.current.focus();
        }}
      >
        <BoardDetailsForm board={board} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function BoardDetailsForm({ board, onDone }: { board: BoardDTO; onDone: () => void }) {
  const queryClient = useQueryClient();
  const saved = { name: board.board.name, description: board.board.description };
  /** The saved details this draft started from. */
  const [base, setBase] = useState(saved);
  const [name, setName] = useState(saved.name);
  const [description, setDescription] = useState(saved.description);
  const [error, setError] = useState<string | null>(null);
  const dirty = name !== base.name || description !== base.description;
  const changedElsewhere = saved.name !== base.name || saved.description !== base.description;

  // Someone else saved new details while this is open: adopt them if nothing's been typed here,
  // otherwise keep the draft and say so (never overwrite it silently).
  useEffect(() => {
    if (!changedElsewhere || dirty) return;
    setBase(saved);
    setName(saved.name);
    setDescription(saved.description);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved.name, saved.description]);

  const update = useRpcMutation("board.update", {
    silent: true, // shown in the form instead
    onMutate: () => setError(null),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.board(board.project.id) });
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      toast.success("Board updated.");
      onDone();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) update.mutate({ boardId: board.boardId, name: name.trim(), description: description.trim() });
      }}
      className="grid gap-4"
    >
      {changedElsewhere && dirty ? (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/50 bg-warning/10 px-3 py-2 text-[12.5px]">
          <span className="min-w-0 flex-1">Someone else changed these details while you were editing. Saving keeps your version.</span>
          <Button
            type="button"
            size="xs"
            variant="secondary"
            onClick={() => {
              setBase(saved);
              setName(saved.name);
              setDescription(saved.description);
            }}
          >
            Use the latest
          </Button>
        </div>
      ) : null}
      <div>
        <Label htmlFor="edit-board-name">Name</Label>
        <Input id="edit-board-name" autoFocus maxLength={60} value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!name.trim()} />
      </div>
      <div>
        <Label htmlFor="edit-board-description">Description</Label>
        <Textarea id="edit-board-description" maxLength={2000} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this board is for" />
      </div>
      {error ? (
        <p role="alert" className="flex items-start gap-1.5 text-[12.5px] text-danger">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> Couldn&apos;t save: {error} Your changes are still here — try again.
        </p>
      ) : update.isPaused ? (
        <p role="status" className="text-[12.5px] text-fg-muted">
          Waiting for a connection — your changes will be saved when you&apos;re back online.
        </p>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={update.isPending} disabled={!name.trim()}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * Board icon. Picking one saves straight away (dismissing without picking changes nothing); "Use
 * default" resets it. Every cached copy (board views, the sidebar) updates at once; a failed save
 * restores the saved icon unless a newer choice is already on its way.
 */
export function useBoardIcon(board: BoardDTO) {
  const queryClient = useQueryClient();
  const projectId = board.project.id;
  const boardId = board.boardId;
  const latest = useRef(0);
  const confirmed = useRef(board.board.icon);
  const pending = useRef(0);
  if (pending.current === 0) confirmed.current = board.board.icon;

  const show = (icon: string | null) => {
    queryClient.setQueriesData<BoardDTO>({ queryKey: qk.board(projectId) }, (old) =>
      old && "columns" in old
        ? { ...old, board: old.boardId === boardId ? { ...old.board, icon } : old.board, boards: old.boards.map((b) => (b.id === boardId ? { ...b, icon } : b)) }
        : old,
    );
    queryClient.setQueriesData<ProjectListItemDTO[]>({ queryKey: ["projects"] }, (old) =>
      Array.isArray(old) ? old.map((p) => (p.id === projectId ? { ...p, boards: p.boards.map((b) => (b.id === boardId ? { ...b, icon } : b)) } : p)) : old,
    );
  };
  const update = useRpcMutation("board.update", { silent: true });
  const change = (icon: string | null) => {
    const request = ++latest.current;
    pending.current++;
    show(icon);
    update.mutate(
      { boardId, icon: icon as (typeof BOARD_ICONS)[number] | null },
      {
        onSettled: () => {
          pending.current--;
        },
        onSuccess: (saved) => {
          confirmed.current = saved.icon;
          if (request !== latest.current) return; // a newer choice will refresh
          void queryClient.invalidateQueries({ queryKey: qk.board(projectId) });
          void queryClient.invalidateQueries({ queryKey: ["projects"] });
        },
        onError: (error) => {
          if (request !== latest.current) return; // superseded by a newer choice
          show(confirmed.current);
          toast.error("Couldn't change the board icon", {
            description: `${errorMessage(error)} It's still ${confirmed.current ? "the icon it had" : "the default icon"}.`,
            action: { label: "Retry", onClick: () => change(icon) },
          });
        },
      },
    );
  };
  return change;
}

/** The icon picker's content (rendered inside a Popover anchored to the board menu). */
export function BoardIconPicker({
  board,
  onPick,
  contentProps,
}: {
  board: BoardDTO;
  onPick: (icon: string | null) => void;
  contentProps: { onInteractOutside: () => void; onCloseAutoFocus: (e: Event) => void };
}) {
  return (
    <PopoverContent
      align="end"
      collisionPadding={8}
      aria-label={`Icon for ${board.board.name}`}
      className="max-h-[var(--radix-popover-content-available-height)] max-w-[calc(100vw-16px)] overflow-y-auto overscroll-contain"
      {...contentProps}
    >
      <div className="w-64 max-w-full">
        <p className="mb-1.5 truncate text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">Icon for {board.board.name}</p>
        <IconGrid
          label="Board icon"
          icons={BOARD_ICONS}
          components={BOARD_ICON_COMPONENTS}
          value={board.board.icon ?? DEFAULT_BOARD_ICON}
          onSelect={(icon) => onPick(icon === DEFAULT_BOARD_ICON ? null : icon)}
        />
        <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-border pt-2">
          <span className="text-[11.5px] text-fg-subtle">Saved as soon as you pick one.</span>
          <Button size="xs" variant="ghost" disabled={!board.board.icon} onClick={() => onPick(null)}>
            Use default
          </Button>
        </div>
      </div>
    </PopoverContent>
  );
}
