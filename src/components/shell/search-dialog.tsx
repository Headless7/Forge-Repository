"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CornerDownLeft, Search } from "lucide-react";
import { Dialog as D, VisuallyHidden } from "radix-ui";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { qk } from "@/lib/queries";
import { rpc } from "@/lib/rpc-client";
import type { BoardDTO, SearchResultDTO } from "@/lib/types";
import { cn } from "@/lib/utils";
import { AvatarStack } from "../domain/avatar";
import { StatePill } from "../domain/state";
import { Kbd } from "../ui/controls";

/** The board of a project most recently loaded in this tab (the one on screen). */
export function openBoardData(queryClient: ReturnType<typeof useQueryClient>, projectId: string): BoardDTO | undefined {
  const queries = queryClient
    .getQueryCache()
    .findAll({ queryKey: qk.board(projectId) })
    // Board views only: timeline/calendar data shares the key prefix (and also has `cards`).
    .filter((query) => query.state.data && "columns" in (query.state.data as object))
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt);
  return queries[0]?.state.data as BoardDTO | undefined;
}

function useDebounced<T>(value: T, ms: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export function SearchDialog({
  open,
  onOpenChange,
  studio,
  currentProject,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  studio: { id: string; slug: string };
  currentProject: { id: string; slug: string; name: string } | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<"project" | "studio">(currentProject ? "project" : "studio");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const debounced = useDebounced(q.trim(), 140);
  const projectId = scope === "project" ? (currentProject?.id ?? null) : null;

  useEffect(() => {
    if (open) {
      setQ("");
      setActive(0);
      setScope(currentProject ? "project" : "studio");
    }
  }, [open, currentProject]);

  const server = useQuery({
    queryKey: qk.search(studio.id, projectId, debounced),
    queryFn: ({ signal }) => rpc("search.cards", { studioId: studio.id, projectId, q: debounced }, { signal }),
    enabled: open && debounced.length > 0,
    staleTime: 10_000,
    placeholderData: (prev) => prev,
  });

  // Instant matches from the board already in memory while the server search runs.
  const local = useMemo<SearchResultDTO[]>(() => {
    const needle = q.trim().toLowerCase();
    if (!needle || !currentProject) return [];
    const board = openBoardData(queryClient, currentProject.id);
    if (!board) return [];
    const columnNames = new Map(board.columns.map((c) => [c.id, c.name]));
    return board.cards
      .filter((c) => c.title.toLowerCase().includes(needle) || c.key.toLowerCase() === needle)
      .slice(0, 8)
      .map((card) => ({
        card,
        project: { id: board.project.id, slug: board.project.slug, name: board.project.name, icon: board.project.icon, key: board.project.key },
        board: { id: board.board.id, number: board.board.number, name: board.board.name },
        columnName: columnNames.get(card.columnId) ?? "",
        matchedIn: ["title"],
        snippet: null,
      }));
  }, [q, currentProject, queryClient]);

  const fresh = server.data && !server.isPlaceholderData && debounced === q.trim();
  const results = fresh ? server.data! : local.length ? local : (server.data ?? []);
  const openBoard = currentProject ? openBoardData(queryClient, currentProject.id) : undefined;
  const members = openBoard?.members ?? [];
  // Name the board when it isn't obvious: across the studio, or in a project with several boards.
  const showBoard = scope === "studio" || (openBoard?.boards.length ?? 1) > 1;

  useEffect(() => setActive(0), [debounced, scope]);

  const openResult = (result: SearchResultDTO) => {
    onOpenChange(false);
    const projectPath = `/${studio.slug}/${result.project.slug}`;
    const boardPath = `${projectPath}/b/${result.board.number}`;
    // Already looking at the card's board: just open the card over it.
    const onBoard = pathname === boardPath || (pathname === projectPath && openBoardData(queryClient, result.project.id)?.boardId === result.board.id);
    if (onBoard) {
      const params = new URLSearchParams(window.location.search);
      params.set("card", result.card.key);
      for (const name of ["comment", "d", "v"]) params.delete(name);
      window.history.pushState(null, "", `${pathname}?${params.toString()}`);
    } else {
      router.push(`${boardPath}?card=${encodeURIComponent(result.card.key)}`);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" && results[active]) {
      e.preventDefault();
      openResult(results[active]!);
    } else if (e.key === "Tab" && currentProject) {
      e.preventDefault();
      setScope((s) => (s === "project" ? "studio" : "project"));
    }
  };

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-overlay data-[state=open]:animate-fade-in" />
        <D.Content
          onKeyDown={onKeyDown}
          className="fixed left-1/2 top-[10vh] z-50 flex max-h-[70vh] w-[calc(100vw-24px)] max-w-2xl -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border-strong bg-surface-2 shadow-lg outline-none data-[state=open]:animate-pop-in"
        >
          <VisuallyHidden.Root>
            <D.Title>Search cards</D.Title>
            <D.Description>Search by title, description, assignee, label, column or comment.</D.Description>
          </VisuallyHidden.Root>
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="size-4 text-fg-subtle" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={scope === "project" && currentProject ? `Search ${currentProject.name}…` : "Search all projects…"}
              className="h-12 flex-1 bg-transparent text-[15px] outline-none"
              aria-label="Search cards"
              role="combobox"
              aria-expanded
              aria-controls="search-results"
            />
            {server.isFetching ? <span className="size-3.5 animate-spin rounded-full border-2 border-fg-subtle border-t-transparent" /> : null}
            {currentProject ? (
              <div className="flex rounded-md bg-surface-3 p-0.5 text-xs">
                {(["project", "studio"] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setScope(s)}
                    className={cn("h-6 rounded px-2 font-medium", scope === s ? "bg-surface-4 text-fg" : "text-fg-muted hover:text-fg")}
                  >
                    {s === "project" ? "This project" : "All projects"}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <ul id="search-results" ref={listRef} role="listbox" className="scrollbar-thin flex-1 overflow-y-auto p-1.5">
            {!q.trim() ? (
              <li className="px-3 py-8 text-center text-[13px] text-fg-muted">
                Search titles, descriptions, people, labels, columns and comments. Try <span className="font-mono text-fg">UTD-12</span>.
              </li>
            ) : results.length === 0 && !server.isFetching ? (
              <li className="px-3 py-8 text-center text-[13px] text-fg-muted">No cards match “{q}”.</li>
            ) : (
              results.map((r, i) => (
                <li
                  key={r.card.id}
                  data-index={i}
                  role="option"
                  aria-selected={i === active}
                  onMouseMove={() => setActive(i)}
                  onClick={() => openResult(r)}
                  className={cn("flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2", i === active ? "bg-surface-4" : "")}
                >
                  {r.card.cover?.thumbUrl ? (
                    <img src={r.card.cover.thumbUrl} alt="" className="h-9 w-14 shrink-0 rounded object-cover" />
                  ) : (
                    <span className="flex h-9 w-14 shrink-0 items-center justify-center rounded bg-surface-3 font-mono text-[10px] text-fg-subtle">{r.project.key}</span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[11px] text-fg-subtle">{r.card.key}</span>
                      <span className="truncate text-[13.5px] font-medium">{r.card.title}</span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 truncate text-[11.5px] text-fg-subtle">
                      {scope === "studio" ? (
                        <span>
                          {r.project.icon} {r.project.name} ·
                        </span>
                      ) : null}
                      {showBoard ? <span>{r.board.name} ·</span> : null}
                      <span>{r.columnName}</span>
                      {r.snippet ? <span className="truncate">· {r.snippet}</span> : null}
                      {r.matchedIn.includes("comment") && !r.snippet ? <span>· matched a comment</span> : null}
                    </div>
                  </div>
                  <AvatarStack users={members.filter((m) => r.card.assigneeIds.includes(m.id))} />
                  <StatePill state={r.card.state} size="sm" />
                </li>
              ))
            )}
          </ul>
          <footer className="flex items-center gap-3 border-t border-border px-3 py-2 text-[11px] text-fg-subtle">
            <span className="flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> navigate
            </span>
            <span className="flex items-center gap-1">
              <Kbd>
                <CornerDownLeft className="size-3" />
              </Kbd>
              open
            </span>
            {currentProject ? (
              <span className="flex items-center gap-1">
                <Kbd>Tab</Kbd> switch scope
              </span>
            ) : null}
          </footer>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
