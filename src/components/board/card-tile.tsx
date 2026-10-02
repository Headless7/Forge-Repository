"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Archive,
  Box,
  Check,
  CheckSquare,
  Layers,
  Music,
  Copy,
  Ellipsis,
  ExternalLink,
  Film,
  Link2,
  MessageSquare,
  Paperclip,
  Pencil,
  Play,
  Upload,
  UserPlus,
} from "lucide-react";
import { memo, useEffect, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { toast } from "sonner";
import { CARD_STATE_META, CARD_STATE_ORDER } from "@/lib/card-meta";
import { PRODUCTION_META } from "@/lib/deliverables";
import type { CardDisplayMode, CardSummaryDTO } from "@/lib/types";
import { cn, formatDuration } from "@/lib/utils";
import { AvatarStack, UserAvatar } from "../domain/avatar";
import { ColumnIcon } from "../domain/column-icon";
import { DeliverableProgress, PRODUCTION_COLOR, PRODUCTION_ICONS, PRODUCTION_ORDER, ProductionPill } from "../domain/production";
import { DueChip, LabelChip, PriorityIcon, STATE_ICONS, StatePill } from "../domain/state";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Tooltip,
} from "../ui/menu";
import { useBoard } from "./board-context";

/** Hover-to-play for video covers: only after a short pause on the tile, never with reduced motion. */
function useHoverPreview(enabled: boolean) {
  const [playing, setPlaying] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return {
    playing,
    onPointerEnter: () => {
      if (!enabled || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      timer.current = setTimeout(() => setPlaying(true), 350);
    },
    onPointerLeave: () => {
      if (timer.current) clearTimeout(timer.current);
      setPlaying(false);
    },
  };
}

function MetaRow({ card, compact }: { card: CardSummaryDTO; compact?: boolean }) {
  const { membersById } = useBoard();
  const assignees = card.assigneeIds.map((id) => membersById.get(id)).filter((m): m is NonNullable<typeof m> => Boolean(m));
  const { counts } = card;
  return (
    <div className="mt-2 flex items-center gap-2.5 text-[11px] text-fg-subtle">
      {card.priority !== "NORMAL" ? <PriorityIcon priority={card.priority} /> : null}
      <DueChip dueAt={card.dueAt} done={card.state === "APPROVED" || card.productionStatus !== "TODO"} />
      {counts.comments ? (
        <span className="inline-flex items-center gap-0.5" title={`${counts.comments} comments`}>
          <MessageSquare className="size-3" aria-hidden /> {counts.comments}
        </span>
      ) : null}
      {counts.attachments ? (
        <span className="inline-flex items-center gap-0.5" title={`${counts.attachments} attachments`}>
          <Paperclip className="size-3" aria-hidden /> {counts.attachments}
        </span>
      ) : null}
      {counts.checklistTotal ? (
        <span
          className={cn("inline-flex items-center gap-0.5", counts.checklistDone === counts.checklistTotal && "text-state-approved")}
          title="Checklist progress"
        >
          <CheckSquare className="size-3" aria-hidden /> {counts.checklistDone}/{counts.checklistTotal}
        </span>
      ) : null}
      {compact && counts.versions ? <span className="font-mono">V{card.currentVersionNumber}</span> : null}
      <span className="flex-1" />
      {card.unread ? <span className="size-1.5 rounded-full bg-accent" title="New activity" /> : null}
      {assignees.length === 1 ? (
        <span className="inline-flex items-center gap-1 text-fg-muted" title={assignees[0]!.displayName}>
          <UserAvatar user={assignees[0]!} size="xs" />
          <span className="max-w-20 truncate">@{assignees[0]!.username}</span>
        </span>
      ) : (
        <AvatarStack users={assignees} />
      )}
    </div>
  );
}

function OpenFeedbackBadge({ card }: { card: CardSummaryDTO }) {
  if (!card.counts.unresolvedFeedback || card.state === "CHANGES_REQUESTED") return null;
  return (
    <span className="inline-flex h-5 items-center gap-1 rounded-md border border-state-changes/40 px-1.5 text-[10.5px] font-semibold text-state-changes" title="Unresolved feedback">
      {card.counts.unresolvedFeedback} open feedback
    </span>
  );
}

function QuickActions({ card, onRename }: { card: CardSummaryDTO; onRename: () => void }) {
  const { cardPerms, board, openCard, setCardState, setProductionStage, toggleAssignee, archiveCard, duplicateCard, studioSlug, can } = useBoard();
  const perms = cardPerms(card);
  const multi = card.progress.total > 1;
  const copyLink = () => {
    const url = `${window.location.origin}/${studioSlug}/${board.project.slug}?card=${card.key}`;
    void navigator.clipboard.writeText(url).then(() => toast.success("Link copied"));
  };
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Actions for ${card.title}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          className="flex size-6 items-center justify-center rounded-md bg-surface-4/90 text-fg-muted opacity-0 shadow-sm backdrop-blur transition-opacity hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
        >
          <Ellipsis className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem onSelect={() => openCard(card.key)}>
          <ExternalLink /> Open card
        </DropdownMenuItem>
        {perms.canEdit ? (
          <DropdownMenuItem onSelect={onRename}>
            <Pencil /> Edit title
          </DropdownMenuItem>
        ) : null}
        {perms.canAssign || perms.canSelfAssign ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <UserPlus /> Assign
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-72 w-56 overflow-y-auto">
              {board.members
                .filter((m) => perms.canAssign || m.id === board.viewer.userId)
                .map((m) => (
                  <DropdownMenuItem key={m.id} onSelect={(e) => { e.preventDefault(); toggleAssignee(card, m.id); }}>
                    <UserAvatar user={m} size="xs" />
                    <span className="flex-1 truncate">{m.displayName}</span>
                    {card.assigneeIds.includes(m.id) ? <Check className="!text-accent" /> : null}
                  </DropdownMenuItem>
                ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        {perms.canEdit || perms.canPublish ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              {(() => {
                const Icon = PRODUCTION_ICONS[card.productionStatus];
                return <Icon />;
              })()}
              Production stage
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-52">
              {PRODUCTION_ORDER.map((status) => {
                const Icon = PRODUCTION_ICONS[status];
                const needsPublish = status === "PUBLISHED" || card.productionStatus === "PUBLISHED";
                return (
                  <DropdownMenuItem key={status} disabled={card.productionStatus === status || (needsPublish && !perms.canPublish)} onSelect={() => setProductionStage(card, status)}>
                    <Icon style={{ color: PRODUCTION_COLOR[status] }} />
                    <span className="flex-1">{PRODUCTION_META[status].label}</span>
                    {card.productionStatus === status ? <Check className="!text-accent" /> : null}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        {multi && (perms.canEdit || perms.canReview || perms.canSubmit) ? (
          <DropdownMenuItem onSelect={() => openCard(card.key)}>
            <Layers /> Review deliverables…
          </DropdownMenuItem>
        ) : null}
        {!multi && (perms.canEdit || perms.canReview || perms.canSubmit) ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              {(() => {
                const Icon = STATE_ICONS[card.state];
                return <Icon />;
              })()}
              Set status
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-52">
              {CARD_STATE_ORDER.map((state) => {
                const Icon = STATE_ICONS[state];
                const reviewOnly = state === "APPROVED" || state === "CHANGES_REQUESTED";
                const disabled = (reviewOnly && !perms.canReview) || (state === "NEEDS_REVIEW" && !perms.canSubmit) || (!reviewOnly && state !== "NEEDS_REVIEW" && !perms.canEdit && !perms.canReview);
                return (
                  <DropdownMenuItem
                    key={state}
                    disabled={disabled || card.state === state}
                    onSelect={() => (state === "CHANGES_REQUESTED" ? openCard(card.key, { action: "request-changes" }) : setCardState(card, state))}
                  >
                    <Icon style={{ color: CARD_STATE_META[state].color }} />
                    <span className="flex-1">{CARD_STATE_META[state].label}</span>
                    {card.state === state ? <Check className="!text-accent" /> : null}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={copyLink}>
          <Link2 /> Copy link
        </DropdownMenuItem>
        {can("card.create") ? (
          <DropdownMenuItem onSelect={() => duplicateCard(card)}>
            <Copy /> Duplicate
          </DropdownMenuItem>
        ) : null}
        {perms.canArchive ? (
          <DropdownMenuItem onSelect={() => archiveCard(card)}>
            <Archive /> Archive
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function InlineTitleEditor({ card, onDone }: { card: CardSummaryDTO; onDone: () => void }) {
  const { renameCard } = useBoard();
  const [value, setValue] = useState(card.title);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = () => {
    const title = value.trim();
    if (title && title !== card.title) renameCard(card, title);
    onDone();
  };
  return (
    <textarea
      ref={ref}
      value={value}
      rows={2}
      aria-label="Card title"
      onChange={(e) => setValue(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") onDone();
      }}
      onBlur={commit}
      className="w-full resize-none rounded-md border border-accent bg-surface-3 px-1.5 py-1 text-[13px] font-medium leading-snug outline-none"
    />
  );
}

export interface CardTileProps {
  card: CardSummaryDTO;
  mode: CardDisplayMode;
  overlay?: boolean;
  dragging?: boolean;
}

/** Board tile. Visual tiles lead with media; compact tiles lead with the title. */
export const CardTile = memo(function CardTile({ card, mode, overlay, dragging }: CardTileProps) {
  const { labelsById, openCard, cardPerms, uploadToCard, view, columnsById, refreshMedia } = useBoard();
  const multi = card.progress.total > 1;
  const category = columnsById.get(card.columnId);
  const [editing, setEditing] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const perms = cardPerms(card);
  const labels = card.labelIds.map((id) => labelsById.get(id)).filter((l): l is NonNullable<typeof l> => Boolean(l));
  const cover = card.cover;
  const visual = mode === "VISUAL" && Boolean(cover);
  const hover = useHoverPreview(visual && cover?.kind === "VIDEO" && Boolean(cover.previewUrl) && !overlay);
  const CoverKindIcon = cover?.kind === "AUDIO" ? Music : cover?.kind === "ROBLOX" ? Box : Film;
  const meta = CARD_STATE_META[card.state];
  const attention = card.state === "CHANGES_REQUESTED" ? "ring-1 ring-state-changes/55" : card.state === "NEEDS_REVIEW" ? "ring-1 ring-state-review/45" : "";

  const onDragOver = (e: DragEvent) => {
    if (!perms.canUpload || !e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    if (!dropActive) setDropActive(true);
  };
  const onDrop = (e: DragEvent) => {
    if (!perms.canUpload || !e.dataTransfer.files.length) return;
    e.preventDefault();
    setDropActive(false);
    uploadToCard(card, [...e.dataTransfer.files]);
  };
  const unresolved = card.state === "CHANGES_REQUESTED" && card.counts.unresolvedFeedback ? `${card.counts.unresolvedFeedback} unresolved` : null;

  return (
    <article
      aria-label={`${card.title} — ${meta.label}`}
      onClick={() => !editing && openCard(card.key)}
      onPointerEnter={hover.onPointerEnter}
      onPointerLeave={hover.onPointerLeave}
      onDragOver={onDragOver}
      onDragLeave={() => setDropActive(false)}
      onDrop={onDrop}
      className={cn(
        "group relative cursor-pointer overflow-hidden rounded-lg border border-border bg-surface-2 text-left shadow-sm transition-[border-color,box-shadow,transform] duration-150 hover:border-border-strong",
        attention,
        !visual && "border-l-[3px]",
        dragging && "border-dashed border-accent/70 opacity-35 shadow-none",
        overlay && "rotate-[1.5deg] scale-[1.02] cursor-grabbing border-border-strong shadow-lg ring-1 ring-accent/40",
      )}
      style={!visual ? { borderLeftColor: meta.color } : undefined}
    >
      {visual && cover ? (
        <div className="relative aspect-video w-full overflow-hidden bg-black/50">
          {cover.thumbUrl ? (
            <img src={cover.thumbUrl} alt="" loading="lazy" decoding="async" draggable={false} onError={refreshMedia} className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-1 bg-gradient-to-br from-surface-3 to-surface-4 text-fg-subtle">
              {cover.status === "PROCESSING" || cover.status === "PENDING" ? (
                "Processing…"
              ) : (
                <>
                  <CoverKindIcon className="size-7" />
                  {cover.kind === "ROBLOX" ? <span className="text-[11px] font-medium">Roblox file</span> : null}
                </>
              )}
            </div>
          )}
          {hover.playing && cover.previewUrl ? (
            <video src={cover.previewUrl} poster={cover.thumbUrl ?? undefined} muted autoPlay loop playsInline preload="metadata" disablePictureInPicture onError={refreshMedia} className="absolute inset-0 h-full w-full object-cover animate-fade-in" />
          ) : null}
          <div className="pointer-events-none absolute inset-x-0 top-0 h-12 bg-gradient-to-b from-black/45 to-transparent" />
          <StatePill state={card.state} size="sm" variant="solid" extra={unresolved} className="absolute left-2 top-2" />
          {card.currentVersionNumber ? (
            <span className="absolute bottom-2 left-2 rounded bg-black/65 px-1.5 font-mono text-[10px] font-semibold leading-4 text-white">V{card.currentVersionNumber}</span>
          ) : null}
          {cover.kind === "VIDEO" ? (
            <span className="absolute bottom-2 right-2 inline-flex items-center gap-1 rounded bg-black/65 px-1.5 text-[10px] font-medium leading-4 text-white">
              <Play className="size-2.5 fill-current" /> {formatDuration(cover.durationMs)}
            </span>
          ) : cover.kind === "AUDIO" ? (
            <span className="absolute bottom-2 right-2 inline-flex items-center gap-1 rounded bg-black/65 px-1.5 text-[10px] font-medium leading-4 text-white">
              <Music className="size-2.5" /> {formatDuration(cover.durationMs)}
            </span>
          ) : null}
          {multi ? (
            <span className="absolute bottom-2 right-2 inline-flex items-center gap-1 rounded bg-black/65 px-1.5 text-[10px] font-medium leading-4 text-white" style={cover.kind === "VIDEO" || cover.kind === "AUDIO" ? { bottom: 26 } : undefined}>
              <Layers className="size-2.5" /> {card.progress.total}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className={cn("p-2.5", visual ? "pt-2" : "")}>
        {view === "PRODUCTION" && category ? (
          <p className="mb-1 inline-flex max-w-full items-center gap-1 text-[11px] font-medium text-fg-muted">
            <ColumnIcon name={category.icon} color={category.color} className="size-3" />
            <span className="truncate">{category.name}</span>
          </p>
        ) : null}
        {labels.length ? (
          <div className="mb-1.5 flex flex-wrap gap-1">
            {labels.map((l) => (
              <LabelChip key={l.id} label={l} />
            ))}
          </div>
        ) : null}
        <div className="flex items-start gap-1.5">
          {editing ? (
            <InlineTitleEditor card={card} onDone={() => setEditing(false)} />
          ) : (
            <h3 className="line-clamp-2 min-w-0 flex-1 text-[13px] font-medium leading-snug text-fg">{card.title}</h3>
          )}
          {!visual && cover ? (
            // Compact tiles keep a small thumbnail of the cover (the same poster image, never a video).
            <span className="mr-6 flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-surface-4 text-fg-subtle" aria-hidden>
              {cover.thumbUrl ? <img src={cover.thumbUrl} alt="" loading="lazy" decoding="async" draggable={false} onError={refreshMedia} className="h-full w-full object-cover" /> : <CoverKindIcon className="size-4" />}
            </span>
          ) : null}
        </div>
        {!visual ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <StatePill state={card.state} size="sm" extra={unresolved} />
            {view === "CATEGORY" && card.productionStatus !== "TODO" ? <ProductionPill status={card.productionStatus} pending={card.pendingChanges} /> : null}
            <OpenFeedbackBadge card={card} />
          </div>
        ) : (card.counts.unresolvedFeedback && card.state !== "CHANGES_REQUESTED") || (view === "CATEGORY" && card.productionStatus !== "TODO") ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {view === "CATEGORY" && card.productionStatus !== "TODO" ? <ProductionPill status={card.productionStatus} pending={card.pendingChanges} /> : null}
            {card.counts.unresolvedFeedback && card.state !== "CHANGES_REQUESTED" ? <OpenFeedbackBadge card={card} /> : null}
          </div>
        ) : null}
        {view === "PRODUCTION" && card.pendingChanges ? (
          <p className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-state-review/12 px-1.5 text-[10.5px] font-semibold leading-5 text-state-review" title="A deliverable changed after this was recorded. The recorded revisions are unchanged.">
            Pending changes since {PRODUCTION_META[card.productionStatus].label.toLowerCase()}
          </p>
        ) : null}
        {multi ? <DeliverableProgress progress={card.progress} className="mt-2" detailed={!visual || mode === "VISUAL"} /> : null}
        <MetaRow card={card} compact={!visual} />
      </div>

      {!overlay && !editing ? (
        <div className="absolute right-1.5 top-1.5">
          <QuickActions card={card} onRename={() => setEditing(true)} />
        </div>
      ) : null}

      {dropActive ? (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-accent bg-accent-soft/90 text-[12px] font-semibold text-fg backdrop-blur-[1px]">
          <Upload className="size-5 text-accent" />
          {multi ? "Drop, then choose the deliverable" : `Drop to upload V${(card.currentVersionNumber ?? 0) + 1}`}
        </div>
      ) : null}
    </article>
  );
});

/**
 * Sortable wrapper — the whole tile is the drag handle; clicks still open the card.
 * Keyboard: Enter opens the card, Space picks it up for keyboard dragging.
 */
export const SortableCard = memo(function SortableCard({ card, mode }: { card: CardSummaryDTO; mode: CardDisplayMode }) {
  const { cardPerms, openCard } = useBoard();
  const disabled = !cardPerms(card).canMove;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    data: { type: "card", columnId: card.columnId },
    disabled,
  });
  const style: CSSProperties = { transform: CSS.Translate.toString(transform), transition };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn("cv-auto rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring", isDragging && "relative z-10")}
      {...attributes}
      {...listeners}
      tabIndex={0}
      aria-roledescription={disabled ? undefined : "draggable card"}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target === e.currentTarget) {
          e.preventDefault();
          openCard(card.key);
          return;
        }
        listeners?.onKeyDown?.(e);
      }}
    >
      <CardTile card={card} mode={mode} dragging={isDragging} />
    </div>
  );
});
