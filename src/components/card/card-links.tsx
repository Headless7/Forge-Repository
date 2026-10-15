"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArrowUpRight, Check, ChevronDown, ChevronRight, Ellipsis, Link2, Lock, Search, Share2, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { getRecentLinks, linkName, rememberLink, type LinkPick } from "@/lib/canvas-links";
import { qk, useCardMutation } from "@/lib/queries";
import { rpc } from "@/lib/rpc-client";
import type { BacklinkDTO, CanvasLinkDTO, CardState, LinkCandidatesDTO } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ColumnIcon } from "../domain/column-icon";
import { DeliverableProgress, ProductionPill } from "../domain/production";
import { StateDot, StatePill } from "../domain/state";
import { TipAnchor, useTutorial } from "../tutorial/tutorial";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/controls";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, Popover, PopoverContent, PopoverTrigger } from "../ui/menu";
import { useWorkspace, type LinkTarget } from "./workspace-context";

/**
 * Links to other cards, and deliverables shared from them (see lib/canvas-links): the menu that
 * adds them, the rows the list shows, the cards linking here, and the actions behind them.
 * Canvas nodes for links live in canvas-link-node (they load with the canvas).
 */

const quote = (name: string) => `“${name}”`;

export function linkTarget(link: CanvasLinkDTO): LinkTarget {
  return { key: link.card.key, boardNumber: link.card.board.number, deliverableNumber: link.deliverable?.number ?? null };
}

export function backlinkTarget(b: BacklinkDTO): LinkTarget {
  return { key: b.card.key, boardNumber: b.card.board.number };
}

/** "Props · Assets board" — where a linked card sits (the board only when it isn't this one). */
export function whereLabel(link: CanvasLinkDTO, boardId: string): string {
  return [link.card.column?.name, link.card.board.id !== boardId ? `${link.card.board.name} board` : null].filter(Boolean).join(" · ");
}

// ── Actions ─────────────────────────────────────────────────────────────────

/** Adding, removing and "needed" for this card's links: with Undo, and the other card refreshed too. */
export function useLinkActions() {
  const { card } = useWorkspace();
  const tutorial = useTutorial();
  const queryClient = useQueryClient();
  const create = useCardMutation("link.create", card.id, card.projectId);
  const remove = useCardMutation("link.remove", card.id, card.projectId);
  const needed = useCardMutation("link.setNeeded", card.id, card.projectId);
  const refreshOther = (cardId: string) => void queryClient.invalidateQueries({ queryKey: qk.card(cardId) });

  const add = (input: { targetCardId: string; targetDeliverableId?: string | null; needed?: boolean; groupId?: string | null; x?: number; y?: number }, label: string, quiet = false) =>
    create.mutateAsync({ cardId: card.id, ...input }).then((detail) => {
      refreshOther(input.targetCardId);
      void queryClient.invalidateQueries({ queryKey: qk.linkCandidates(card.id) });
      const made = detail.canvasLinks.find((l) => l.card.id === input.targetCardId && (l.deliverable?.id ?? null) === (input.targetDeliverableId ?? null)) ?? null;
      if (!quiet) {
        toast.success(input.targetDeliverableId ? `Shared ${label} here.` : `Linked ${label}.`, {
          description: input.targetDeliverableId ? "Its work and reviews stay on its own card." : undefined,
          action: made ? { label: "Undo", onClick: () => remove.mutate({ linkId: made.id }, { onSuccess: () => refreshOther(input.targetCardId) }) } : undefined,
        });
        tutorial.trigger("card.links");
      }
      return made;
    });

  return {
    add,
    adding: create.isPending,
    remove: (link: CanvasLinkDTO) =>
      remove.mutateAsync({ linkId: link.id }).then(() => {
        refreshOther(link.card.id);
        toast.success(link.deliverable ? `Stopped sharing ${quote(link.deliverable.name)} here.` : `Removed the link to ${link.card.key}.`, {
          description: "Neither card's work changed.",
          action: {
            label: "Undo",
            onClick: () =>
              void add({ targetCardId: link.card.id, targetDeliverableId: link.deliverable?.id ?? null, needed: link.needed, groupId: link.groupId, x: link.canvasX, y: link.canvasY }, linkName(link), true).catch(() => {}),
          },
        });
      }),
    setNeeded: (link: CanvasLinkDTO, value: boolean) =>
      needed.mutate(
        { linkId: link.id, needed: value },
        { onSuccess: () => toast.success(value ? `This card now waits for ${quote(linkName(link))} to be approved.` : `${quote(linkName(link))} no longer holds this card back.`) },
      ),
  };
}

// ── The link menu ───────────────────────────────────────────────────────────

type Candidate = LinkCandidatesDTO["cards"][number];
type Row = { kind: "card"; card: Candidate; pick: LinkPick } | { kind: "deliverable"; card: Candidate; deliverable: Candidate["deliverables"][number]; pick: LinkPick };

/**
 * Searchable list of the project's cards, by board and category, each with its deliverables to
 * share. Arrow keys move, Enter picks, → / ← show or hide a card's deliverables. Recent picks
 * come first while nothing is typed.
 */
export function LinkPicker({ onPick, linked }: { onPick: (card: Candidate, deliverable: Candidate["deliverables"][number] | null) => void; linked: ReadonlySet<LinkPick> }) {
  const { card } = useWorkspace();
  const { data, isLoading, isError } = useQuery({ queryKey: qk.linkCandidates(card.id), queryFn: () => rpc("link.candidates", { cardId: card.id }), staleTime: 30_000 });
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [active, setActive] = useState(0);
  const [recent] = useState(() => getRecentLinks(card.projectId));
  const list = useRef<HTMLUListElement>(null);
  const q = query.trim().toLowerCase();

  const sections = useMemo(() => {
    if (!data) return [];
    const columns = new Map(data.boards.flatMap((b) => b.columns.map((c) => [c.id, { ...c, board: b }] as const)));
    const matches = (c: Candidate) => !q || [c.key, c.title, columns.get(c.columnId)?.name ?? ""].some((v) => v.toLowerCase().includes(q));
    const deliverableMatches = (d: Candidate["deliverables"][number]) => Boolean(q) && [d.name, d.assetType].some((v) => v.toLowerCase().includes(q));
    const rowsFor = (c: Candidate): Row[] => {
      const own = matches(c);
      const hits = c.deliverables.filter(deliverableMatches);
      if (!own && !hits.length) return [];
      const shown = expanded.has(c.id) ? c.deliverables : hits;
      return [{ kind: "card", card: c, pick: `card:${c.id}` }, ...shown.map((d) => ({ kind: "deliverable" as const, card: c, deliverable: d, pick: `deliverable:${d.id}` as LinkPick }))];
    };
    const out: Array<{ label: string; icon?: ReactNode; rows: Row[] }> = [];
    if (!q && recent.length) {
      const rows: Row[] = [];
      for (const pick of recent) {
        const [kind, id] = pick.split(":") as ["card" | "deliverable", string];
        const c = kind === "card" ? data.cards.find((x) => x.id === id) : data.cards.find((x) => x.deliverables.some((d) => d.id === id));
        if (!c) continue;
        if (kind === "card") rows.push({ kind: "card", card: c, pick });
        else rows.push({ kind: "deliverable", card: c, deliverable: c.deliverables.find((d) => d.id === id)!, pick });
      }
      if (rows.length) out.push({ label: "Recent", rows });
    }
    // This card's board first, then the others in switcher order.
    const boards = [...data.boards].sort((a, b) => Number(b.id === card.boardId) - Number(a.id === card.boardId));
    for (const b of boards) {
      for (const col of b.columns) {
        const rows = data.cards.filter((c) => c.columnId === col.id).flatMap(rowsFor);
        if (rows.length) out.push({ label: data.boards.length > 1 ? `${b.name} › ${col.name}` : col.name, icon: <ColumnIcon name={col.icon} color={col.color} className="size-3.5" />, rows });
      }
    }
    return out;
  }, [data, q, expanded, recent, card.boardId]);

  const flat = useMemo(() => sections.flatMap((s) => s.rows), [sections]);
  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-row="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (row: Row) => {
    if (linked.has(row.pick)) return;
    rememberLink(card.projectId, row.pick);
    onPick(row.card, row.kind === "deliverable" ? row.deliverable : null);
  };
  const toggle = (id: string, open?: boolean) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (open ?? !next.has(id)) next.add(id);
      else next.delete(id);
      return next;
    });
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const row = flat[active];
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(flat.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" && row) {
      e.preventDefault();
      pick(row);
    } else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && row?.kind === "card" && row.card.deliverables.length) {
      e.preventDefault();
      toggle(row.card.id, e.key === "ArrowRight");
    }
  };

  let index = -1;
  return (
    <div className="flex min-h-0 flex-col gap-1.5">
      <p className="px-0.5 text-[11.5px] text-fg-muted">Link a card, or share one of its deliverables here.</p>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" aria-hidden />
        <input
          type="search"
          value={query}
          autoFocus={typeof window !== "undefined" && !window.matchMedia("(pointer: coarse)").matches}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search cards and deliverables…"
          aria-label="Search cards and deliverables"
          role="combobox"
          aria-expanded
          aria-controls="link-picker-results"
          aria-activedescendant={flat[active] ? `link-row-${active}` : undefined}
          className="h-8 w-full rounded-md border border-border-strong bg-surface-3 pl-7 pr-2 text-[13px] outline-none focus:border-accent"
        />
      </div>
      <ul ref={list} id="link-picker-results" role="listbox" aria-label="Cards and deliverables" className="scrollbar-thin max-h-[min(360px,calc(var(--radix-popover-content-available-height,400px)-110px))] min-h-0 overflow-y-auto overscroll-contain">
        {isLoading ? <li className="px-2 py-3 text-[12.5px] text-fg-muted">Loading cards…</li> : null}
        {isError ? <li className="px-2 py-3 text-[12.5px] text-danger">Couldn&apos;t load the cards. Close this and try again.</li> : null}
        {data && !flat.length ? <li className="px-2 py-3 text-[12.5px] text-fg-muted">{q ? "Nothing matches." : "There are no other active cards in this project yet."}</li> : null}
        {sections.map((s) => (
          <li key={s.label} role="presentation">
            <p className="flex items-center gap-1.5 px-2 pb-0.5 pt-2 text-[10.5px] font-semibold uppercase tracking-wide text-fg-subtle">
              {s.icon} <span className="truncate">{s.label}</span>
            </p>
            <ul role="group" aria-label={s.label}>
              {s.rows.map((row) => {
                index += 1;
                const i = index;
                const done = linked.has(row.pick);
                const isActive = i === active;
                if (row.kind === "card") {
                  const open = expanded.has(row.card.id);
                  return (
                    <li key={`${s.label}-${row.pick}`} className="flex items-center gap-0.5">
                      <button
                        type="button"
                        id={`link-row-${i}`}
                        data-row={i}
                        role="option"
                        aria-selected={isActive}
                        aria-disabled={done}
                        onMouseMove={() => setActive(i)}
                        onClick={() => pick(row)}
                        className={cn("flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left text-[13px]", isActive && "bg-surface-4", done ? "cursor-default opacity-60" : "hover:bg-surface-4")}
                      >
                        <StateDot state={row.card.state} />
                        <span className="shrink-0 font-mono text-[11px] text-fg-muted">{row.card.key}</span>
                        <span className="min-w-0 flex-1 truncate">{row.card.title}</span>
                        {done ? (
                          <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-accent">
                            <Check className="size-3.5" /> Linked
                          </span>
                        ) : null}
                      </button>
                      {row.card.deliverables.length ? (
                        <button
                          type="button"
                          aria-expanded={open}
                          aria-label={`${open ? "Hide" : "Show"} the deliverables of ${row.card.key}`}
                          title={`${row.card.deliverables.length} deliverable${row.card.deliverables.length === 1 ? "" : "s"} to share`}
                          onClick={() => toggle(row.card.id)}
                          className="touch-target flex h-8 shrink-0 items-center gap-0.5 rounded-md px-1.5 text-[11px] text-fg-subtle hover:bg-surface-4 hover:text-fg"
                        >
                          {row.card.deliverables.length} {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                        </button>
                      ) : null}
                    </li>
                  );
                }
                return (
                  <li key={`${s.label}-${row.pick}`}>
                    <button
                      type="button"
                      id={`link-row-${i}`}
                      data-row={i}
                      role="option"
                      aria-selected={isActive}
                      aria-disabled={done}
                      onMouseMove={() => setActive(i)}
                      onClick={() => pick(row)}
                      className={cn("ml-5 flex min-h-8 w-[calc(100%-20px)] items-center gap-2 rounded-md px-2 py-1 text-left text-[12.5px]", isActive && "bg-surface-4", done ? "cursor-default opacity-60" : "hover:bg-surface-4")}
                    >
                      <Share2 className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">
                        {row.deliverable.name}
                        {s.label === "Recent" ? <span className="text-fg-subtle"> · {row.card.key}</span> : null}
                      </span>
                      {done ? (
                        <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-accent">
                          <Check className="size-3.5" /> Shared
                        </span>
                      ) : (
                        <StatePill state={row.deliverable.state} size="sm" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "Link card": opens the menu; picking links the card (or shares the deliverable) and closes it. */
export function AddLinkButton({ onLinked, groupId, className, label = "Link card" }: { onLinked?: (link: CanvasLinkDTO) => void; groupId?: string | null; className?: string; label?: string }) {
  const { card } = useWorkspace();
  const actions = useLinkActions();
  const [open, setOpen] = useState(false);
  const linked = useMemo(() => new Set<LinkPick>(card.canvasLinks.map((l) => (l.deliverable ? `deliverable:${l.deliverable.id}` : `card:${l.card.id}`) as LinkPick)), [card.canvasLinks]);
  return (
    <TipAnchor tip="card.links" facts={{ canEdit: card.permissions.canEdit, linkCount: card.canvasLinks.length + card.linkedFrom.length }}>
      <span className="inline-flex">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button size="sm" variant="secondary" className={className} loading={actions.adding}>
            <Link2 /> {label}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="flex w-[min(380px,calc(100vw-16px))] flex-col p-2" onOpenAutoFocus={(e) => window.matchMedia("(pointer: coarse)").matches && e.preventDefault()}>
          <LinkPicker
            linked={linked}
            onPick={(target, deliverable) => {
              setOpen(false);
              void actions
                .add({ targetCardId: target.id, targetDeliverableId: deliverable?.id ?? null, groupId: groupId ?? null }, deliverable ? `${quote(deliverable.name)} from ${target.key}` : `${target.key} ${quote(target.title)}`)
                .then((made) => made && onLinked?.(made))
                .catch(() => {});
            }}
          />
        </PopoverContent>
      </Popover>
      </span>
    </TipAnchor>
  );
}

// ── Rows (list view, simple cards) ──────────────────────────────────────────

/** What a link says about itself in one line: where it lives and how it stands. */
export function LinkFacts({ link, boardId, className }: { link: CanvasLinkDTO; boardId: string; className?: string }) {
  const d = link.deliverable;
  const archived = link.card.archived || d?.archived;
  return (
    <span className={cn("flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-fg-muted", className)}>
      {d ? (
        <span>
          {d.assetType || "Deliverable"} · {d.versionCount ? `V${d.versionCount}` : "no files yet"}
          {d.approvedVersionNumber && d.state !== "APPROVED" ? ` · V${d.approvedVersionNumber} approved` : ""}
        </span>
      ) : (
        <span>{whereLabel(link, boardId) || "Card"}</span>
      )}
      {archived ? (
        <span className="inline-flex items-center gap-0.5 font-medium text-warning">
          <Archive className="size-3" /> {d?.archived ? `Archived on ${link.card.key}` : "Archived"}
        </span>
      ) : null}
      {link.card.board.archived && !archived ? <span className="font-medium text-warning">On an archived board</span> : null}
    </span>
  );
}

export function NeededBadge({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-0.5 rounded bg-state-review/15 px-1 text-[10.5px] font-semibold text-state-review", className)} title="This card can't be completed until it's approved">
      <Lock className="size-3" /> Needed here
    </span>
  );
}

/** A link in the deliverables list (or a simple card's links): tap to open it; editors get its actions. */
export function LinkRow({ link }: { link: CanvasLinkDTO }) {
  const { card, openLinked } = useWorkspace();
  const actions = useLinkActions();
  const canEdit = card.permissions.canEdit;
  const d = link.deliverable;
  const cover = d ? d.cover : link.card.cover;
  const state: CardState = d ? d.state : link.card.state;
  const archived = link.card.archived || d?.archived;
  const tutorial = useTutorial();
  return (
    <li className={cn("group flex items-center gap-2 rounded-lg border border-dashed border-border-strong bg-surface-2 px-2.5 py-2", archived && "opacity-70")}>
      <button
        type="button"
        onClick={() => {
          // Explained on the card it opens, which lists this one under "Linked from".
          tutorial.trigger("card.links", { afterNavigation: true });
          openLinked(linkTarget(link));
        }}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
        aria-label={d ? `Open ${d.name} on ${link.card.key}` : `Open ${link.card.key} ${link.card.title}`}
      >
        <span className="relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-4">
          {cover?.thumbUrl ? <img src={cover.thumbUrl} alt="" className="h-full w-full object-cover" /> : d ? <Share2 className="size-4 text-fg-subtle" /> : <Link2 className="size-4 text-fg-subtle" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-fg-subtle">
            {d ? <Share2 className="size-3" aria-hidden /> : <Link2 className="size-3" aria-hidden />}
            {d ? `Shared from ${link.card.key}` : `Linked card ${link.card.key}`}
          </span>
          <span className="block truncate text-[13px] font-medium">{d ? d.name : link.card.title}</span>
          <LinkFacts link={link} boardId={card.boardId} className="mt-0.5" />
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <StatePill state={state} size="sm" />
          {link.needed ? <NeededBadge /> : !d && link.card.productionStatus !== "TODO" ? <ProductionPill status={link.card.productionStatus} /> : null}
        </span>
        <ArrowUpRight className="hidden size-4 shrink-0 text-fg-subtle sm:block" aria-hidden />
      </button>
      {canEdit ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label={`Actions for the link to ${linkName(link)}`}>
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuItem onSelect={() => openLinked(linkTarget(link))}>
              <ArrowUpRight /> Open {d ? `on ${link.card.key}` : link.card.key}
            </DropdownMenuItem>
            {d ? (
              <DropdownMenuItem onSelect={() => actions.setNeeded(link, !link.needed)}>
                <Lock /> {link.needed ? "Don't wait for it" : "Needed to complete this card"}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void actions.remove(link).catch(() => {})} className="text-danger">
              <Trash2 /> {d ? "Stop sharing here" : "Remove link"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </li>
  );
}

/** The "needed" choice for a shared deliverable, with what it means. */
export function NeededToggle({ link, compact }: { link: CanvasLinkDTO; compact?: boolean }) {
  const { card } = useWorkspace();
  const actions = useLinkActions();
  if (!link.deliverable) return null;
  return (
    <label className={cn("flex items-start gap-2", compact ? "text-[12px]" : "text-[12.5px]")}>
      <Checkbox className="mt-0.5" checked={link.needed} disabled={!card.permissions.canEdit} onCheckedChange={(v) => actions.setNeeded(link, v === true)} />
      <span>
        <span className="font-medium">Needed to complete this card</span>
        <span className="block text-[11.5px] text-fg-muted">
          {link.needed ? "This card can't be marked Completed until it's approved." : "Off: it's here for reference and never holds this card back."}
        </span>
      </span>
    </label>
  );
}

// ── The other direction ─────────────────────────────────────────────────────

/**
 * Cards that link here, or share this card's deliverables, one chip per card (with what it
 * shares): each opens that card.
 */
export function LinkedFrom({ className }: { className?: string }) {
  const { card, openLinked } = useWorkspace();
  if (!card.linkedFrom.length) return null;
  const names = new Map(card.deliverables.map((d) => [d.id, d.name]));
  const byCard = new Map<string, BacklinkDTO[]>();
  for (const b of card.linkedFrom) byCard.set(b.card.id, [...(byCard.get(b.card.id) ?? []), b]);
  return (
    <TipAnchor tip="card.links" place="linked-from" facts={{ canEdit: card.permissions.canEdit, linkCount: card.canvasLinks.length + card.linkedFrom.length }}>
    <div className={cn("flex flex-wrap items-center gap-1.5 text-[12px]", className)}>
      <span className="inline-flex items-center gap-1 text-fg-muted">
        <Link2 className="size-3.5" aria-hidden /> Linked from
      </span>
      {[...byCard.values()].map((links) => {
        const from = links[0]!.card;
        const shares = links.filter((b) => b.deliverableId).map((b) => ({ name: names.get(b.deliverableId!) ?? "a deliverable", needed: b.needed }));
        const title = shares.length
          ? `${from.key} ${from.title} shows ${shares.map((s) => `${s.name}${s.needed ? " (needs it approved to be completed)" : ""}`).join(", ")}`
          : `${from.key} ${from.title} links to this card`;
        return (
          <button
            key={from.id}
            type="button"
            onClick={() => openLinked(backlinkTarget(links[0]!))}
            title={title}
            aria-label={`Open ${from.key} ${from.title}. ${title}`}
            className={cn("inline-flex min-h-7 max-w-full items-center gap-1.5 rounded-md border border-border-strong bg-surface-2 px-2 text-left hover:border-accent", from.archived && "opacity-60")}
          >
            <StateDot state={from.state} />
            <span className="shrink-0 font-mono text-[11px] text-fg-muted">{from.key}</span>
            <span className="min-w-0 truncate">{from.title}</span>
            {shares.length ? (
              <span className="inline-flex min-w-0 items-center gap-0.5 text-[11px] text-fg-muted">
                · <Share2 className="size-3 shrink-0" aria-hidden /> <span className="truncate">{shares.map((s) => s.name).join(", ")}</span>
                {shares.some((s) => s.needed) ? <Lock className="size-3 shrink-0 text-state-review" aria-label="needed there" /> : null}
              </span>
            ) : null}
            {from.archived ? <span className="shrink-0 text-[11px] text-warning">archived</span> : null}
          </button>
        );
      })}
    </div>
    </TipAnchor>
  );
}

/** The cards one of this card's deliverables is shared with. */
export function sharedWith(linkedFrom: BacklinkDTO[], deliverableId: string): BacklinkDTO[] {
  return linkedFrom.filter((b) => b.deliverableId === deliverableId);
}

/** "Shared with UTD-9, UTD-14": chips that open those cards (in a deliverable's header). */
export function SharedWithChips({ deliverableId }: { deliverableId: string }) {
  const { card, openLinked } = useWorkspace();
  const list = sharedWith(card.linkedFrom, deliverableId);
  if (!list.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
      <span className="inline-flex items-center gap-1 text-fg-muted">
        <Share2 className="size-3.5" aria-hidden /> Shared with
      </span>
      {list.map((b) => (
        <button
          key={b.id}
          type="button"
          onClick={() => openLinked(backlinkTarget(b))}
          title={b.needed ? `${b.card.key} can't be completed until this is approved` : `${b.card.key} shows this deliverable`}
          className="inline-flex min-h-6 max-w-full items-center gap-1 rounded-md border border-border-strong bg-surface-2 px-1.5 text-[11.5px] hover:border-accent"
        >
          <span className="font-mono text-fg-muted">{b.card.key}</span>
          <span className="min-w-0 truncate">{b.card.title}</span>
          {b.needed ? <Lock className="size-3 shrink-0 text-state-review" aria-label="needs it approved" /> : null}
        </button>
      ))}
      <span className="w-full text-[11px] text-fg-subtle sm:w-auto">The work and its reviews happen here; those cards show it live.</span>
    </div>
  );
}

/**
 * A simple (one-deliverable) card has no canvas: its links and the cards linking to it are listed
 * here, with "Link card" for editors.
 */
export function CardLinksSection() {
  const { card } = useWorkspace();
  const canEdit = card.permissions.canEdit;
  if (!card.canvasLinks.length && !card.linkedFrom.length && !canEdit) return null;
  return (
    <section aria-label="Linked cards" className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[13px] font-semibold">Linked cards</h3>
        {card.canvasLinks.length ? <span className="rounded-full bg-surface-4 px-1.5 text-[11px] font-medium text-fg-muted">{card.canvasLinks.length}</span> : null}
        <span className="flex-1" />
        {canEdit ? <AddLinkButton /> : null}
      </div>
      {card.canvasLinks.length ? (
        <ul className="grid gap-1.5" aria-label="Links">
          {card.canvasLinks.map((l) => (
            <LinkRow key={l.id} link={l} />
          ))}
        </ul>
      ) : canEdit && !card.linkedFrom.length ? (
        <p className="text-[12px] text-fg-subtle">Link related cards, or share a deliverable from another card, to see it here live.</p>
      ) : null}
      <LinkedFrom />
    </section>
  );
}

/** For a linked card's summary: its progress line (deliverables approved, in review…). */
export function LinkedCardProgress({ link }: { link: CanvasLinkDTO }) {
  return <DeliverableProgress progress={link.card.progress} detailed />;
}
