"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, LayoutGrid, Plus, Search, Settings2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ROBLOX_TEMPLATE } from "@/lib/column-icons";
import { qk, useRpcMutation } from "@/lib/queries";
import type { BoardDTO, BoardSummaryDTO } from "@/lib/types";
import { cn } from "@/lib/utils";
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
          <button
            type="button"
            aria-label={`Board: ${board.board.name}. Switch board`}
            className="inline-flex h-7 min-w-0 max-w-[46vw] items-center gap-1.5 rounded-md border border-border-strong px-2 text-[12.5px] font-medium hover:bg-surface-3 md:max-w-64"
          >
            <LayoutGrid className="size-3.5 shrink-0 text-fg-subtle" />
            <span className="min-w-0 truncate">{board.board.name}</span>
            {board.boards.length > 1 ? <span className="shrink-0 text-[11px] font-normal text-fg-subtle">{board.boards.length}</span> : null}
            <ChevronDown className="size-3.5 shrink-0 text-fg-subtle" />
          </button>
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
                    onClick={() => setOpen(false)}
                    className={cn("flex min-h-10 items-start gap-2 rounded-md px-2 py-1.5 hover:bg-surface-3", current && "bg-surface-3")}
                  >
                    <Check className={cn("mt-0.5 size-3.5 shrink-0", current ? "text-accent" : "invisible")} />
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

/** Rename a board or change its description. */
export function EditBoardDialog({ open, onOpenChange, board }: { open: boolean; onOpenChange: (open: boolean) => void; board: BoardDTO }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(board.board.name);
  const [description, setDescription] = useState(board.board.description);
  const update = useRpcMutation("board.update", {
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.board(board.project.id) });
      toast.success("Board updated.");
      onOpenChange(false);
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (v) {
          setName(board.board.name);
          setDescription(board.board.description);
        }
      }}
    >
      <DialogContent title="Board details">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) update.mutate({ boardId: board.boardId, name: name.trim(), description: description.trim() });
          }}
          className="grid gap-4"
        >
          <div>
            <Label htmlFor="edit-board-name">Name</Label>
            <Input id="edit-board-name" autoFocus maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="edit-board-description">Description</Label>
            <Textarea id="edit-board-description" maxLength={2000} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this board is for" />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={update.isPending} disabled={!name.trim()}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
