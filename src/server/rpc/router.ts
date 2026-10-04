/**
 * Every client→server operation is a named procedure with a Zod input schema.
 * Business rules and authorization live in the services; procedures only map
 * validated input onto them. The client imports `AppRouter` as a type only.
 */
import { z } from "zod";
import type { DashboardListKey } from "@/lib/types";
import {
  annotationSchema,
  cardLinkSchema,
  cardStateSchema,
  cardTitleSchema,
  colorSchema,
  boardNameSchema,
  columnNameSchema,
  displayModeSchema,
  emailSchema,
  emojiSchema,
  idSchema,
  isoDateSchema,
  notificationTypeSchema,
  passwordSchema,
  prioritySchema,
  projectNameSchema,
  memberAccessSchema,
  roleSchema,
  studioNameSchema,
  usernameSchema,
  displayNameSchema,
} from "@/lib/validation";
import { BOARD_ICONS } from "@/lib/board-icons";
import { DISCORD_EVENTS } from "@/lib/discord";
import { COLUMN_ICONS } from "@/lib/column-icons";
import * as accounts from "../services/accounts";
import * as archive from "../services/archive";
import { listAuditLog, listCardActivity, listProjectActivity } from "../services/activity";
import * as board from "../services/board";
import * as cards from "../services/cards";
import * as checklists from "../services/checklists";
import * as comments from "../services/comments";
import * as deliverables from "../services/deliverables";
import { getStudioHome } from "../services/home";
import * as labels from "../services/labels";
import * as media from "../services/media";
import * as notifications from "../services/notifications";
import * as production from "../services/production";
import * as calendarFeed from "../services/calendar-feed";
import * as dashboard from "../services/dashboard";
import * as purge from "../services/purge";
import * as schedule from "../services/schedule";
import * as tutorial from "../services/tutorial";
import * as discord from "../services/discord";
import * as discordDm from "../services/discord-dm";
import * as push from "../services/push";
import * as projectTemplates from "../services/project-templates";
import * as projects from "../services/projects";
import * as reviews from "../services/reviews";
import * as roblox from "../services/roblox";
import * as platform from "../services/platform";
import { searchCards } from "../services/search";
import { getStudioStorage } from "../services/storage-quota";
import * as studios from "../services/studios";
import { requireCard, requireProject, requireStudio, getProjectAccess } from "../access";
import { proc } from "./procedure";

const columnIcon = z.enum(COLUMN_ICONS).nullable().optional();
const purgeTargetSchema = z.object({ type: z.enum(purge.PURGE_TYPES), id: idSchema });
const dashboardFilters = z.object({
  projectId: idSchema,
  boardId: idSchema.nullable().optional(),
  milestoneId: idSchema.nullable().optional(),
  from: isoDateSchema,
  to: isoDateSchema,
});
/** A deliverable-canvas connection point, e.g. "r-50" (see lib/canvas-points). */
const canvasPointSchema = z.string().regex(/^[trbl]-\d{1,2}$/, "Unknown connection point.");
/** A browser push subscription endpoint: an https capability URL issued by the browser's push service. */
const pushEndpointSchema = z.string().url().max(2048).refine((v) => v.startsWith("https://"), "Unsupported push endpoint.");
const text = (max: number) => z.string().max(max);

export const appRouter = {
  // ── Board & columns ───────────────────────────────────────────────────────
  "board.get": proc({
    input: z.object({ projectId: idSchema, boardId: idSchema.nullable().optional() }),
    handler: ({ actor }, i) => board.getBoard(actor, i.projectId, i.boardId),
  }),
  "board.create": proc({
    input: z.object({
      projectId: idSchema,
      name: boardNameSchema,
      description: text(2000).optional(),
      columns: z.union([z.enum(["empty", "roblox"]), z.object({ copyFromBoardId: idSchema })]).optional(),
    }),
    limit: { max: 60, windowMs: 60_000 },
    handler: ({ actor }, i) => board.createBoard(actor, i),
  }),
  "board.update": proc({
    input: z.object({ boardId: idSchema, name: boardNameSchema.optional(), description: text(2000).optional(), icon: z.enum(BOARD_ICONS).nullable().optional() }),
    handler: ({ actor }, i) => board.updateBoard(actor, i),
  }),
  "board.move": proc({
    input: z.object({
      boardId: idSchema,
      afterBoardId: idSchema.nullable().optional(),
      beforeBoardId: idSchema.nullable().optional(),
      index: z.number().int().min(0).nullable().optional(),
    }),
    handler: ({ actor }, i) => board.moveBoard(actor, i),
  }),
  "board.archive": proc({
    input: z.object({ boardId: idSchema, archived: z.boolean() }),
    handler: ({ actor }, i) => board.setBoardArchived(actor, i),
  }),
  "board.archived": proc({
    input: z.object({ projectId: idSchema }),
    handler: ({ actor }, i) => archive.listArchivedContent(actor, i.projectId),
  }),
  "archive.projects": proc({
    input: z.object({ studioId: idSchema }),
    handler: ({ actor }, i) => archive.listArchivedProjects(actor, i.studioId),
  }),
  "archive.preview": proc({
    input: z.object({ targets: z.array(purgeTargetSchema).min(1).max(500) }),
    limit: { max: 120, windowMs: 60_000 },
    handler: ({ actor }, i) => purge.previewPurge(actor, i),
  }),
  "archive.purge": proc({
    input: z.object({ targets: z.array(purgeTargetSchema).min(1).max(500), confirm: z.literal("DELETE") }),
    limit: { max: 20, windowMs: 60_000 },
    handler: ({ actor }, i) => purge.purge(actor, { targets: i.targets }),
  }),
  "column.create": proc({
    input: z.object({
      projectId: idSchema,
      boardId: idSchema.nullable().optional(),
      name: columnNameSchema,
      icon: columnIcon,
      color: colorSchema.nullable().optional(),
      defaultCardMode: displayModeSchema.nullable().optional(),
      afterColumnId: idSchema.nullable().optional(),
      index: z.number().int().min(0).nullable().optional(),
    }),
    handler: ({ actor }, i) => board.createColumn(actor, i),
  }),
  "column.update": proc({
    input: z.object({
      columnId: idSchema,
      name: columnNameSchema.optional(),
      icon: columnIcon,
      color: colorSchema.nullable().optional(),
      defaultCardMode: displayModeSchema.nullable().optional(),
    }),
    handler: ({ actor }, i) => board.updateColumn(actor, i),
  }),
  "column.move": proc({
    input: z.object({
      columnId: idSchema,
      afterColumnId: idSchema.nullable().optional(),
      beforeColumnId: idSchema.nullable().optional(),
      index: z.number().int().min(0).nullable().optional(),
    }),
    handler: ({ actor }, i) => board.moveColumn(actor, i),
  }),
  "column.archive": proc({
    input: z.object({ columnId: idSchema, archived: z.boolean() }),
    handler: ({ actor }, i) => board.setColumnArchived(actor, i),
  }),
  "column.delete": proc({
    input: z.object({ columnId: idSchema }),
    handler: ({ actor }, i) => board.deleteColumn(actor, i),
  }),
  "column.duplicate": proc({
    input: z.object({ columnId: idSchema, withCards: z.boolean() }),
    handler: ({ actor }, i) => board.duplicateColumn(actor, i),
  }),
  "column.collapse": proc({
    input: z.object({ columnId: idSchema, collapsed: z.boolean() }),
    handler: ({ actor }, i) => board.setColumnCollapsed(actor, i),
  }),
  "board.setView": proc({
    input: z.object({ projectId: idSchema, boardId: idSchema.nullable().optional(), view: z.enum(["CATEGORY", "PRODUCTION", "TIMELINE", "CALENDAR"]) }),
    handler: ({ actor }, i) => board.setBoardView(actor, i),
  }),

  // ── Cards ─────────────────────────────────────────────────────────────────
  "card.create": proc({
    input: z.object({
      projectId: idSchema,
      columnId: idSchema,
      title: cardTitleSchema,
      where: z.enum(["top", "bottom"]).optional(),
      description: text(50_000).optional(),
      priority: prioritySchema.optional(),
      displayMode: displayModeSchema.nullable().optional(),
      startAt: isoDateSchema.nullable().optional(),
      dueAt: isoDateSchema.nullable().optional(),
      milestoneId: idSchema.nullable().optional(),
      assigneeIds: z.array(idSchema).max(20).optional(),
      labelIds: z.array(idSchema).max(30).optional(),
      productionWhere: z.enum(["top", "bottom"]).optional(),
    }),
    limit: { max: 120, windowMs: 60_000 },
    handler: ({ actor }, i) => cards.createCard(actor, i),
  }),
  "card.get": proc({
    input: z.union([
      z.object({ cardId: idSchema }),
      z.object({ projectId: idSchema, number: z.number().int().positive() }),
    ]),
    handler: async ({ actor }, i) =>
      cards.getCardDetail(actor, "cardId" in i ? i.cardId : await cards.findCardIdByNumber(actor, i.projectId, i.number)),
  }),
  "card.update": proc({
    input: z.object({
      cardId: idSchema,
      title: cardTitleSchema.optional(),
      description: text(50_000).optional(),
      priority: prioritySchema.optional(),
      startAt: isoDateSchema.nullable().optional(),
      dueAt: isoDateSchema.nullable().optional(),
      milestoneId: idSchema.nullable().optional(),
      displayMode: displayModeSchema.nullable().optional(),
      estimateHours: z.number().min(0).max(10_000).nullable().optional(),
      links: z.array(cardLinkSchema).max(20).optional(),
      base: z.object({ title: text(200).optional(), description: text(50_000).optional() }).optional(),
    }),
    handler: ({ actor }, i) => cards.updateCard(actor, i),
  }),
  "card.move": proc({
    input: z.object({
      cardId: idSchema,
      toColumnId: idSchema,
      afterCardId: idSchema.nullable().optional(),
      beforeCardId: idSchema.nullable().optional(),
      index: z.number().int().min(0).nullable().optional(),
    }),
    handler: ({ actor }, i) => cards.moveCard(actor, i),
  }),
  "card.moveToBoard": proc({
    input: z.object({ cardId: idSchema, boardId: idSchema }),
    handler: ({ actor }, i) => cards.moveCardToBoard(actor, i),
  }),
  "card.archive": proc({
    input: z.object({ cardId: idSchema, archived: z.boolean() }),
    handler: ({ actor }, i) => cards.setCardArchived(actor, i),
  }),
  "card.delete": proc({
    input: z.object({ cardId: idSchema, confirm: text(40) }),
    handler: ({ actor }, i) => cards.deleteCardPermanently(actor, i),
  }),
  "card.duplicate": proc({
    input: z.object({
      cardId: idSchema,
      include: z.object({ assignees: z.boolean(), labels: z.boolean(), checklists: z.boolean(), attachments: z.boolean() }),
    }),
    handler: ({ actor }, i) => cards.duplicateCard(actor, i),
  }),
  "card.assignees": proc({
    input: z.object({ cardId: idSchema, add: z.array(idSchema).max(20).optional(), remove: z.array(idSchema).max(20).optional() }),
    handler: ({ actor }, i) => cards.setAssignees(actor, i),
  }),
  "card.reviewers": proc({
    input: z.object({ cardId: idSchema, add: z.array(idSchema).max(20).optional(), remove: z.array(idSchema).max(20).optional() }),
    handler: ({ actor }, i) => cards.setReviewers(actor, i),
  }),
  "card.watch": proc({
    input: z.object({ cardId: idSchema, watching: z.boolean() }),
    handler: ({ actor }, i) => cards.setWatching(actor, i),
  }),
  "card.labels": proc({
    input: z.object({ cardId: idSchema, labelIds: z.array(idSchema).max(30) }),
    handler: ({ actor }, i) => cards.setLabels(actor, i),
  }),
  "card.viewed": proc({
    input: z.object({ cardId: idSchema }),
    handler: ({ actor }, i) => cards.markCardViewed(actor, i.cardId),
  }),
  "card.activity": proc({
    input: z.object({ cardId: idSchema }),
    handler: async ({ actor }, i) => {
      await requireCard(actor.userId, i.cardId);
      return listCardActivity(i.cardId);
    },
  }),
  "card.setState": proc({
    input: z.object({ cardId: idSchema, state: cardStateSchema }),
    handler: ({ actor }, i) => reviews.setCardState(actor, i),
  }),
  "card.setProduction": proc({
    input: z.object({
      cardId: idSchema,
      status: z.enum(["TODO", "COMPLETED", "PUBLISHED"]),
      afterCardId: idSchema.nullable().optional(),
      beforeCardId: idSchema.nullable().optional(),
      index: z.number().int().min(0).nullable().optional(),
      note: text(2000).optional(),
    }),
    handler: ({ actor }, i) => production.moveProduction(actor, i),
  }),

  // ── Deliverables ──────────────────────────────────────────────────────────
  "deliverable.create": proc({
    input: z.object({
      cardId: idSchema,
      name: z.string().trim().min(1).max(120),
      description: text(5000).optional(),
      assetType: text(40).optional(),
      required: z.boolean().optional(),
      ownerId: idSchema.nullable().optional(),
      contributorIds: z.array(idSchema).max(20).optional(),
      reviewerId: idSchema.nullable().optional(),
      startAt: isoDateSchema.nullable().optional(),
      dueAt: isoDateSchema.nullable().optional(),
      canvasX: z.number().finite().min(-100_000).max(100_000).optional(),
      canvasY: z.number().finite().min(-100_000).max(100_000).optional(),
      linkFrom: z.object({ id: idSchema, type: z.enum(["DEPENDENCY", "ASSOCIATION"]) }).nullable().optional(),
    }),
    limit: { max: 120, windowMs: 60_000 },
    handler: ({ actor }, i) => deliverables.createDeliverable(actor, i),
  }),
  "deliverable.update": proc({
    input: z.object({
      deliverableId: idSchema,
      name: z.string().trim().min(1).max(120).optional(),
      description: text(5000).optional(),
      assetType: text(40).optional(),
      required: z.boolean().optional(),
      ownerId: idSchema.nullable().optional(),
      contributorIds: z.array(idSchema).max(20).optional(),
      reviewerId: idSchema.nullable().optional(),
      startAt: isoDateSchema.nullable().optional(),
      dueAt: isoDateSchema.nullable().optional(),
    }),
    handler: ({ actor }, i) => deliverables.updateDeliverable(actor, i),
  }),
  "deliverable.archive": proc({
    input: z.object({ deliverableId: idSchema, archived: z.boolean() }),
    handler: ({ actor }, i) => deliverables.setDeliverableArchived(actor, i),
  }),
  "deliverable.layout": proc({
    input: z.object({
      cardId: idSchema,
      positions: z
        .array(
          z.object({
            id: idSchema,
            x: z.number().finite().min(-100_000).max(100_000).optional(),
            y: z.number().finite().min(-100_000).max(100_000).optional(),
            w: z.number().finite().min(1).max(10_000).nullable().optional(),
            h: z.number().finite().min(1).max(10_000).nullable().optional(),
          }),
        )
        .min(1)
        .max(200),
    }),
    limit: { max: 600, windowMs: 60_000 },
    handler: ({ actor }, i) => deliverables.layoutDeliverables(actor, i),
  }),
  "deliverable.move": proc({
    input: z.object({ deliverableId: idSchema, beforeId: idSchema.nullable().optional(), afterId: idSchema.nullable().optional() }),
    handler: ({ actor }, i) => deliverables.moveDeliverable(actor, i),
  }),
  "deliverable.setState": proc({
    input: z.object({ deliverableId: idSchema, state: cardStateSchema }),
    handler: ({ actor }, i) => reviews.setDeliverableState(actor, i),
  }),
  "deliverable.link": proc({
    input: z.object({
      cardId: idSchema,
      fromId: idSchema,
      toId: idSchema,
      type: z.enum(["DEPENDENCY", "ASSOCIATION"]),
      note: text(500).optional(),
      fromPoint: canvasPointSchema.nullable().optional(),
      toPoint: canvasPointSchema.nullable().optional(),
    }),
    handler: ({ actor }, i) => deliverables.linkDeliverables(actor, i),
  }),
  "deliverable.updateLink": proc({
    input: z.object({
      linkId: idSchema,
      note: text(500).optional(),
      reverse: z.boolean().optional(),
      fromPoint: canvasPointSchema.nullable().optional(),
      toPoint: canvasPointSchema.nullable().optional(),
    }),
    handler: ({ actor }, i) => deliverables.updateLink(actor, i),
  }),
  "deliverable.unlink": proc({
    input: z.object({ linkId: idSchema }),
    handler: ({ actor }, i) => deliverables.unlinkDeliverables(actor, i),
  }),

  // ── Review workflow (per deliverable) ─────────────────────────────────────
  "review.submit": proc({
    input: z.object({ deliverableId: idSchema, versionId: idSchema.nullable().optional(), note: text(2000).optional() }),
    handler: ({ actor }, i) => reviews.submitForReview(actor, i),
  }),
  "review.withdraw": proc({
    input: z.object({ deliverableId: idSchema }),
    handler: ({ actor }, i) => reviews.withdrawSubmission(actor, i),
  }),
  "review.approve": proc({
    input: z.object({ deliverableId: idSchema, note: text(2000).optional(), resolveOpenFeedback: z.boolean().optional() }),
    handler: ({ actor }, i) => reviews.approve(actor, i),
  }),
  "review.requestChanges": proc({
    input: z.object({ deliverableId: idSchema, note: text(2000).optional(), items: z.array(text(2000)).max(30).optional() }),
    handler: ({ actor }, i) => reviews.requestChanges(actor, i),
  }),

  // ── Versions & uploads ────────────────────────────────────────────────────
  "version.create": proc({
    input: z
      .object({ deliverableId: idSchema.nullable().optional(), cardId: idSchema.nullable().optional(), notes: text(2000).optional() })
      .refine((i) => Boolean(i.deliverableId || i.cardId), "A deliverable or card is required."),
    handler: ({ actor }, i) => media.createVersion(actor, i),
  }),
  "version.notes": proc({
    input: z.object({ versionId: idSchema, notes: text(2000) }),
    handler: ({ actor }, i) => media.updateVersionNotes(actor, i),
  }),
  "upload.create": proc({
    input: z.object({
      cardId: idSchema,
      filename: z.string().min(1).max(255),
      size: z.number().int().positive(),
      contentType: z.string().max(200),
      purpose: z.enum(["version", "attachment", "comment", "resource", "cover"]),
      versionId: idSchema.nullable().optional(),
      deliverableId: idSchema.nullable().optional(),
    }),
    handler: ({ actor }, i) => media.createUpload(actor, i),
  }),
  "upload.complete": proc({
    input: z.object({
      attachmentId: idSchema,
      clientMeta: z
        .object({
          durationMs: z.number().int().min(0).max(86_400_000).optional(),
          width: z.number().int().min(1).max(20_000).optional(),
          height: z.number().int().min(1).max(20_000).optional(),
        })
        .optional(),
    }),
    handler: ({ actor }, i) => media.completeUpload(actor, i),
  }),
  "upload.importUrl": proc({
    input: z.object({
      cardId: idSchema,
      url: z.url().max(2000),
      purpose: z.enum(["version", "attachment", "comment", "cover"]),
      versionId: idSchema.nullable().optional(),
      deliverableId: idSchema.nullable().optional(),
    }),
    handler: ({ actor }, i) => media.importFromUrl(actor, i),
  }),
  "attachment.archive": proc({
    input: z.object({ attachmentId: idSchema }),
    handler: ({ actor }, i) => media.archiveAttachment(actor, i),
  }),
  "attachment.restore": proc({
    input: z.object({ attachmentId: idSchema }),
    handler: ({ actor }, i) => media.restoreAttachment(actor, i),
  }),
  "attachment.setCover": proc({
    input: z.object({ cardId: idSchema, attachmentId: idSchema }),
    handler: ({ actor }, i) => media.setCover(actor, i),
  }),
  "card.setCoverMode": proc({
    input: z.object({ cardId: idSchema, mode: z.enum(["AUTO", "NONE"]) }),
    handler: ({ actor }, i) => media.setCoverMode(actor, i),
  }),

  // ── Roblox previews ───────────────────────────────────────────────────────
  "roblox.resources": proc({
    input: z.object({ cardId: idSchema, contentIds: z.array(z.string().max(500)).max(500) }),
    handler: async ({ actor }, i) => ({ resources: await roblox.listResources(actor, i), ...roblox.robloxFetchAvailable() }),
  }),
  "roblox.resolve": proc({
    input: z.object({ cardId: idSchema, contentId: z.string().min(1).max(500), kind: z.enum(["mesh", "texture"]), attachmentId: idSchema }),
    handler: ({ actor }, i) => roblox.resolveResource(actor, i),
  }),
  "roblox.unresolve": proc({
    input: z.object({ cardId: idSchema, resourceId: idSchema }),
    handler: ({ actor }, i) => roblox.unresolveResource(actor, i),
  }),
  "roblox.fetch": proc({
    input: z.object({ cardId: idSchema, contentId: z.string().min(1).max(500), kind: z.enum(["mesh", "texture"]) }),
    limit: { max: 120, windowMs: 60_000 },
    handler: ({ actor }, i) => roblox.fetchResourceFromRoblox(actor, i),
  }),
  "roblox.fetchMany": proc({
    input: z.object({
      cardId: idSchema,
      items: z.array(z.object({ contentId: z.string().min(1).max(500), kind: z.enum(["mesh", "texture"]) })).min(1).max(50),
    }),
    limit: { max: 60, windowMs: 60_000 },
    handler: ({ actor }, i) => roblox.fetchManyFromRoblox(actor, i),
  }),
  "roblox.rigs": proc({
    input: z.object({ cardId: idSchema }),
    handler: ({ actor }, i) => roblox.listRigCandidates(actor, i),
  }),
  "roblox.previewConfig": proc({
    input: z.object({
      attachmentId: idSchema,
      rigAttachmentId: idSchema.nullable().optional(),
      rigNode: z.number().int().min(0).max(1_000_000).nullable().optional(),
    }),
    handler: ({ actor }, i) => roblox.setPreviewConfig(actor, i),
  }),
  "roblox.rebuild": proc({
    input: z.object({ attachmentId: idSchema }),
    handler: ({ actor }, i) => roblox.rebuildPreview(actor, i),
  }),

  // ── Comments & feedback ───────────────────────────────────────────────────
  "comment.create": proc({
    input: z.object({
      cardId: idSchema,
      body: text(10_000),
      kind: z.enum(["DISCUSSION", "FEEDBACK"]).optional(),
      parentId: idSchema.nullable().optional(),
      deliverableId: idSchema.nullable().optional(),
      versionId: idSchema.nullable().optional(),
      attachmentId: idSchema.nullable().optional(),
      annotation: annotationSchema.nullable().optional(),
      attachmentIds: z.array(idSchema).max(10).optional(),
    }),
    handler: ({ actor }, i) => comments.createComment(actor, i),
  }),
  "comment.edit": proc({
    input: z.object({ commentId: idSchema, body: text(10_000) }),
    handler: ({ actor }, i) => comments.editComment(actor, i),
  }),
  "comment.delete": proc({
    input: z.object({ commentId: idSchema }),
    handler: ({ actor }, i) => comments.deleteComment(actor, i),
  }),
  "comment.resolve": proc({
    input: z.object({ commentId: idSchema, resolved: z.boolean() }),
    handler: ({ actor }, i) => comments.setFeedbackResolved(actor, i),
  }),
  "comment.react": proc({
    input: z.object({ commentId: idSchema, emoji: z.string().max(16) }),
    handler: ({ actor }, i) => comments.toggleReaction(actor, i),
  }),

  // ── Checklists ────────────────────────────────────────────────────────────
  "checklist.create": proc({
    input: z.object({ cardId: idSchema, title: text(120), items: z.array(text(500)).max(100).optional() }),
    handler: ({ actor }, i) => checklists.createChecklist(actor, i),
  }),
  "checklist.rename": proc({
    input: z.object({ checklistId: idSchema, title: text(120) }),
    handler: ({ actor }, i) => checklists.renameChecklist(actor, i),
  }),
  "checklist.delete": proc({
    input: z.object({ checklistId: idSchema }),
    handler: ({ actor }, i) => checklists.deleteChecklist(actor, i),
  }),
  "checklist.addItem": proc({
    input: z.object({ checklistId: idSchema, text: text(500) }),
    handler: ({ actor }, i) => checklists.addChecklistItem(actor, i),
  }),
  "checklist.updateItem": proc({
    input: z.object({ itemId: idSchema, text: text(500).optional(), isDone: z.boolean().optional() }),
    handler: ({ actor }, i) => checklists.updateChecklistItem(actor, i),
  }),
  "checklist.moveItem": proc({
    input: z.object({ itemId: idSchema, index: z.number().int().min(0) }),
    handler: ({ actor }, i) => checklists.moveChecklistItem(actor, i),
  }),
  "checklist.deleteItem": proc({
    input: z.object({ itemId: idSchema }),
    handler: ({ actor }, i) => checklists.deleteChecklistItem(actor, i),
  }),

  // ── Labels & milestones ───────────────────────────────────────────────────
  "label.create": proc({
    input: z.object({ projectId: idSchema, name: z.string().trim().min(1).max(40), color: colorSchema }),
    handler: ({ actor }, i) => labels.createLabel(actor, i),
  }),
  "label.update": proc({
    input: z.object({ labelId: idSchema, name: z.string().trim().min(1).max(40).optional(), color: colorSchema.optional() }),
    handler: ({ actor }, i) => labels.updateLabel(actor, i),
  }),
  "label.delete": proc({
    input: z.object({ labelId: idSchema }),
    handler: ({ actor }, i) => labels.deleteLabel(actor, i),
  }),
  "milestone.create": proc({
    input: z.object({ projectId: idSchema, name: z.string().trim().min(1).max(60), description: text(2000).optional(), dueAt: isoDateSchema.nullable().optional() }),
    handler: ({ actor }, i) => labels.createMilestone(actor, i),
  }),
  "milestone.update": proc({
    input: z.object({
      milestoneId: idSchema,
      name: z.string().trim().min(1).max(60).optional(),
      description: text(2000).optional(),
      dueAt: isoDateSchema.nullable().optional(),
      released: z.boolean().optional(),
      archived: z.boolean().optional(),
    }),
    handler: ({ actor }, i) => labels.updateMilestone(actor, i),
  }),

  // ── Projects ──────────────────────────────────────────────────────────────
  "project.list": proc({
    input: z.object({ studioId: idSchema, includeArchived: z.boolean().optional() }),
    handler: ({ actor }, i) => projects.listProjects(actor, i.studioId, i.includeArchived),
  }),
  "project.create": proc({
    input: z.object({
      studioId: idSchema,
      name: projectNameSchema,
      key: z.string().trim().regex(/^[A-Za-z0-9]{2,5}$/, "Keys are 2–5 letters or numbers.").optional(),
      icon: emojiSchema.optional(),
      color: colorSchema.optional(),
      description: text(2000).optional(),
      template: z.enum(["roblox", "empty"]).optional(),
      templateProjectId: idSchema.nullable().optional(),
      templateMemberIds: z.array(idSchema).max(500).nullable().optional(),
      visibility: z.enum(["STUDIO", "PRIVATE"]).optional(),
    }),
    limit: { max: 30, windowMs: 60_000 },
    handler: ({ actor }, i) => projects.createProject(actor, i),
  }),
  "project.templatePreview": proc({
    input: z.object({ studioId: idSchema, sourceProjectId: idSchema }),
    handler: ({ actor }, i) => projectTemplates.previewProjectTemplate(actor, i),
  }),
  "project.update": proc({
    input: z.object({
      projectId: idSchema,
      name: projectNameSchema.optional(),
      slug: z.string().trim().min(1).max(40).optional(),
      key: z.string().trim().regex(/^[A-Za-z0-9]{2,5}$/, "Keys are 2–5 letters or numbers.").optional(),
      description: text(2000).optional(),
      icon: emojiSchema.optional(),
      color: colorSchema.optional(),
      background: z.enum(["default", "midnight", "violet", "forest", "ember", "ocean"]).optional(),
      defaultCardMode: displayModeSchema.optional(),
      visibility: z.enum(["STUDIO", "PRIVATE"]).optional(),
      settings: z
        .object({
          allowSelfApproval: z.boolean().optional(),
          requireFeedbackForChanges: z.boolean().optional(),
          defaultReviewerIds: z.array(idSchema).max(20).optional(),
        })
        .optional(),
    }),
    handler: ({ actor }, i) => projects.updateProject(actor, i),
  }),
  "project.archive": proc({
    input: z.object({ projectId: idSchema, archived: z.boolean() }),
    handler: ({ actor }, i) => projects.setProjectArchived(actor, i),
  }),
  "project.delete": proc({
    input: z.object({ projectId: idSchema, confirm: text(100) }),
    handler: ({ actor }, i) => projects.deleteProject(actor, i),
  }),
  "project.access": proc({
    input: z.object({ projectId: idSchema }),
    handler: ({ actor }, i) => projects.listProjectAccess(actor, i.projectId),
  }),
  "project.setMember": proc({
    input: z.object({ projectId: idSchema, userId: idSchema, member: z.boolean(), role: roleSchema.nullable().optional() }),
    handler: ({ actor }, i) => projects.setProjectMember(actor, i),
  }),
  "project.activity": proc({
    input: z.object({ projectId: idSchema, before: isoDateSchema.optional(), all: z.boolean().optional() }),
    handler: async ({ actor }, i) => {
      await requireProject(actor.userId, i.projectId, "project.view");
      return listProjectActivity([i.projectId], {
        before: i.before ? new Date(i.before) : undefined,
        limit: 40,
        all: i.all,
        excludeTypes: i.all ? ["feedback.resolved", "feedback.reopened", "card.description_changed"] : undefined,
      });
    },
  }),

  // ── Studio ────────────────────────────────────────────────────────────────
  "studio.list": proc({
    input: z.object({}),
    handler: ({ actor }) => studios.listStudiosForUser(actor.userId),
  }),
  "studio.create": proc({
    input: z.object({ name: studioNameSchema, iconEmoji: emojiSchema.optional(), activationKey: z.string().trim().max(60).optional() }),
    limit: { max: 10, windowMs: 60 * 60_000 },
    handler: ({ actor }, i) => studios.createStudio(actor, i),
  }),
  "studio.update": proc({
    input: z.object({ studioId: idSchema, name: studioNameSchema.optional(), slug: z.string().trim().min(2).max(40).optional(), iconEmoji: emojiSchema.nullable().optional() }),
    handler: ({ actor }, i) => studios.updateStudio(actor, i),
  }),
  "studio.storage": proc({
    input: z.object({ studioId: idSchema }),
    handler: ({ actor }, i) => getStudioStorage(actor, i.studioId),
  }),
  "studio.home": proc({
    input: z.object({ studioId: idSchema }),
    handler: ({ actor }, i) => getStudioHome(actor, i.studioId),
  }),
  "studio.activity": proc({
    input: z.object({ studioId: idSchema, before: isoDateSchema.optional() }),
    handler: async ({ actor }, i) => {
      await requireStudio(actor.userId, i.studioId);
      const list = await projects.listProjects(actor, i.studioId);
      const ids: string[] = [];
      for (const p of list) if (await getProjectAccess(actor.userId, p.id)) ids.push(p.id);
      return listProjectActivity(ids, { before: i.before ? new Date(i.before) : undefined, limit: 40 });
    },
  }),
  "audit.list": proc({
    input: z.object({ studioId: idSchema }),
    handler: async ({ actor }, i) => {
      await requireStudio(actor.userId, i.studioId, "audit.view");
      return listAuditLog(i.studioId);
    },
  }),
  "member.list": proc({
    input: z.object({ studioId: idSchema }),
    handler: ({ actor }, i) => studios.listMembers(actor, i.studioId),
  }),
  "member.update": proc({
    input: z.object({
      studioId: idSchema,
      userId: idSchema,
      role: roleSchema.optional(),
      access: memberAccessSchema.optional(),
      title: z.string().trim().max(60).nullable().optional(),
    }),
    handler: ({ actor }, i) => studios.updateMember(actor, i),
  }),
  "member.remove": proc({
    input: z.object({ studioId: idSchema, userId: idSchema }),
    handler: ({ actor }, i) => studios.removeMember(actor, i),
  }),
  "invitation.list": proc({
    input: z.object({ studioId: idSchema }),
    handler: ({ actor }, i) => studios.listInvitations(actor, i.studioId),
  }),
  "invitation.create": proc({
    input: z.object({
      studioId: idSchema,
      email: emailSchema,
      role: roleSchema,
      access: memberAccessSchema.optional(),
      projectIds: z.array(idSchema).max(50).optional(),
    }),
    limit: { max: 60, windowMs: 60 * 60_000 },
    handler: ({ actor }, i) => studios.createInvitation(actor, i),
  }),
  "invitation.revoke": proc({
    input: z.object({ invitationId: idSchema }),
    handler: ({ actor }, i) => studios.revokeInvitation(actor, i),
  }),
  "invitation.accept": proc({
    input: z.object({ token: z.string().min(10).max(200) }),
    handler: ({ actor }, i) => studios.acceptInvitation(actor, i),
  }),

  // ── Site operator: activation keys ──────────────────────────────────────
  "platform.status": proc({
    input: z.object({}),
    handler: ({ actor }) => platform.accessStatus(actor.userId),
  }),
  "platform.keys": proc({
    input: z.object({}),
    handler: ({ actor }) => platform.listActivationKeys(actor),
  }),
  "platform.issueKey": proc({
    input: z.object({
      label: z.string().trim().min(1, "Say who the key is for.").max(80),
      email: emailSchema.nullable().optional(),
      expiresInDays: z.number().int().min(1).max(90).optional(),
    }),
    limit: { max: 50, windowMs: 60 * 60_000 },
    handler: ({ actor }, i) => platform.issueActivationKey(actor, i),
  }),
  "platform.revokeKey": proc({
    input: z.object({ keyId: idSchema }),
    handler: ({ actor }, i) => platform.revokeActivationKey(actor, i),
  }),

  // ── Notifications ─────────────────────────────────────────────────────────
  "notification.list": proc({
    input: z.object({ unreadOnly: z.boolean().optional(), before: isoDateSchema.optional(), limit: z.number().int().min(1).max(100).optional() }),
    handler: ({ actor }, i) => notifications.listNotifications(actor, i),
  }),
  "notification.unreadCount": proc({
    input: z.object({}),
    handler: async ({ actor }) => ({ count: await notifications.unreadCount(actor.userId) }),
  }),
  "notification.markRead": proc({
    input: z.object({ ids: z.array(idSchema).max(200).optional(), all: z.boolean().optional(), read: z.boolean().optional() }),
    handler: ({ actor }, i) => notifications.markNotificationsRead(actor, i),
  }),
  "notification.preferences": proc({
    input: z.object({}),
    handler: ({ actor }) => notifications.getNotificationPreferences(actor),
  }),
  "notification.setPreference": proc({
    input: z.object({ type: notificationTypeSchema, inApp: z.boolean().optional(), push: z.boolean().optional(), email: z.boolean().optional() }),
    handler: ({ actor }, i) => notifications.setNotificationPreference(actor, i),
  }),

  // ── Producer dashboard (Managers and above) ─────────────────────────────
  "dashboard.project": proc({
    input: dashboardFilters,
    limit: { max: 120, windowMs: 60_000 },
    handler: ({ actor }, i) => dashboard.projectDashboard(actor, i),
  }),
  "dashboard.list": proc({
    input: dashboardFilters.extend({ key: z.string().regex(/^(state:(NOT_SUBMITTED|IN_PROGRESS|NEEDS_REVIEW|CHANGES_REQUESTED|APPROVED)|overdue|dueSoon|blocked|unassigned|stale|queue|person:[0-9a-f-]{36}|milestone:[0-9a-f-]{36})$/) }),
    limit: { max: 240, windowMs: 60_000 },
    handler: ({ actor }, i) => dashboard.dashboardList(actor, { ...i, key: i.key as DashboardListKey }),
  }),
  "dashboard.studio": proc({
    input: z.object({ studioId: idSchema }),
    limit: { max: 60, windowMs: 60_000 },
    handler: ({ actor }, i) => dashboard.studioDashboard(actor, i),
  }),

  // ── Schedule (timeline, calendars, calendar subscriptions) ──────────────
  "schedule.board": proc({
    input: z.object({ projectId: idSchema, boardId: idSchema.nullable().optional(), from: isoDateSchema, to: isoDateSchema }),
    limit: { max: 240, windowMs: 60_000 },
    handler: ({ actor }, i) => schedule.boardSchedule(actor, i),
  }),
  "schedule.studio": proc({
    input: z.object({ studioId: idSchema, from: isoDateSchema, to: isoDateSchema, scope: z.enum(["mine", "all"]) }),
    limit: { max: 240, windowMs: 60_000 },
    handler: ({ actor }, i) => schedule.studioSchedule(actor, i),
  }),
  "calendarFeed.get": proc({
    input: z.object({}),
    handler: ({ actor }) => calendarFeed.getCalendarFeed(actor),
  }),
  "calendarFeed.create": proc({
    input: z.object({}),
    limit: { max: 20, windowMs: 60 * 60_000 },
    handler: ({ actor }) => calendarFeed.createCalendarFeed(actor),
  }),
  "calendarFeed.revoke": proc({
    input: z.object({}),
    handler: ({ actor }) => calendarFeed.revokeCalendarFeed(actor),
  }),

  // ── Device notifications (Web Push) ─────────────────────────────────────
  "push.config": proc({
    input: z.object({}),
    handler: async () => push.pushPublicConfig(),
  }),
  "push.status": proc({
    input: z.object({ endpoint: pushEndpointSchema }),
    handler: ({ actor }, i) => push.pushStatus(actor, i),
  }),
  "push.subscribe": proc({
    input: z.object({ endpoint: pushEndpointSchema, p256dh: z.string().min(80).max(120), auth: z.string().min(16).max(40) }),
    limit: { max: 30, windowMs: 60 * 60_000 },
    handler: ({ actor }, i) => push.subscribePush(actor, i),
  }),
  "push.unsubscribe": proc({
    input: z.object({ endpoint: pushEndpointSchema }),
    handler: ({ actor }, i) => push.unsubscribePush(actor, i),
  }),
  "push.devices": proc({
    input: z.object({}),
    handler: ({ actor }) => push.listPushDevices(actor),
  }),
  "push.removeDevice": proc({
    input: z.object({ id: idSchema }),
    handler: ({ actor }, i) => push.removePushDevice(actor, i),
  }),
  "push.test": proc({
    input: z.object({ endpoint: pushEndpointSchema.nullable().optional() }),
    limit: { max: 10, windowMs: 10 * 60_000 },
    handler: ({ actor }, i) => push.sendTestPush(actor, i),
  }),

  // ── Search ────────────────────────────────────────────────────────────────
  "search.cards": proc({
    input: z.object({ studioId: idSchema, projectId: idSchema.nullable().optional(), q: z.string().max(100), limit: z.number().int().min(1).max(50).optional() }),
    limit: { max: 240, windowMs: 60_000 },
    handler: ({ actor }, i) => searchCards(actor, i),
  }),

  // ── Account ───────────────────────────────────────────────────────────────
  "account.profile": proc({
    input: z.object({}),
    handler: ({ actor }) => accounts.getProfile(actor),
  }),
  "account.disconnectAccount": proc({
    input: z.object({ provider: z.enum(["discord", "google"]) }),
    limit: { max: 10, windowMs: 60_000 },
    handler: ({ actor }, i) => accounts.disconnectOAuth(actor, i),
  }),
  "account.retryDiscordDms": proc({
    input: z.object({}),
    limit: { max: 5, windowMs: 60_000 },
    handler: ({ actor }) => discordDm.retryDiscordDms(actor),
  }),
  // ── Discord team feeds (connect: Admins/Owner; feeds: Managers and above) ──
  "discord.status": proc({
    input: z.object({ studioId: idSchema }),
    handler: ({ actor }, i) => discord.discordStatus(actor, i.studioId),
  }),
  "discord.disconnect": proc({
    input: z.object({ studioId: idSchema }),
    limit: { max: 10, windowMs: 60_000 },
    handler: ({ actor }, i) => discord.disconnectDiscord(actor, i.studioId),
  }),
  "discord.studioFeeds": proc({
    input: z.object({ studioId: idSchema }),
    handler: ({ actor }, i) => discord.listStudioFeeds(actor, i.studioId),
  }),
  "discord.channels": proc({
    input: z.object({ projectId: idSchema }),
    limit: { max: 30, windowMs: 60_000 },
    handler: ({ actor }, i) => discord.listDiscordChannels(actor, i.projectId),
  }),
  "discord.feeds": proc({
    input: z.object({ projectId: idSchema }),
    handler: ({ actor }, i) => discord.listProjectFeeds(actor, i.projectId),
  }),
  "discord.saveFeed": proc({
    input: z.object({
      projectId: idSchema,
      feedId: idSchema.nullable().optional(),
      boardId: idSchema.nullable(),
      channelId: z.string().regex(/^\d{5,25}$/, "Choose a channel."),
      events: z.array(z.enum(DISCORD_EVENTS)).min(1, "Choose at least one kind of event.").max(DISCORD_EVENTS.length),
      confirmPrivate: z.boolean().default(false),
    }),
    limit: { max: 30, windowMs: 60_000 },
    handler: ({ actor }, i) => discord.saveDiscordFeed(actor, i),
  }),
  "discord.deleteFeed": proc({
    input: z.object({ feedId: idSchema }),
    handler: ({ actor }, i) => discord.deleteDiscordFeed(actor, i.feedId),
  }),
  "discord.testFeed": proc({
    input: z.object({ feedId: idSchema }),
    limit: { max: 10, windowMs: 60_000 },
    handler: ({ actor }, i) => discord.testDiscordFeed(actor, i.feedId),
  }),
  // ── Contextual tutorial tips (progress is per person, across studios and devices) ──
  "tutorial.get": proc({
    input: z.object({}),
    limit: { max: 60, windowMs: 60_000 },
    handler: ({ actor }) => tutorial.tutorialState(actor.userId),
  }),
  "tutorial.dismiss": proc({
    input: z.object({ tipId: z.string().min(1).max(80), version: z.number().int().min(1).max(1000) }),
    limit: { max: 120, windowMs: 60_000 },
    handler: ({ actor }, i) => tutorial.dismissTip(actor, i),
  }),
  "tutorial.setEnabled": proc({
    input: z.object({ enabled: z.boolean() }),
    limit: { max: 60, windowMs: 60_000 },
    handler: ({ actor }, i) => tutorial.setTipsEnabled(actor, i.enabled),
  }),
  "tutorial.reset": proc({
    input: z.object({}),
    limit: { max: 20, windowMs: 60_000 },
    handler: ({ actor }) => tutorial.resetTutorial(actor),
  }),
  "account.update": proc({
    input: z.object({ displayName: displayNameSchema.optional(), username: usernameSchema.optional(), theme: z.enum(["dark", "light", "system"]).optional() }),
    handler: ({ actor }, i) => accounts.updateProfile(actor, i),
  }),
  "account.changeEmail": proc({
    input: z.object({ email: emailSchema, password: z.string().max(200).optional() }),
    handler: ({ actor }, i) => accounts.changeEmail(actor, i),
  }),
  "account.changePassword": proc({
    input: z.object({ currentPassword: z.string().max(200).optional(), newPassword: passwordSchema }),
    handler: ({ actor }, i) => accounts.changePassword(actor, i),
  }),
  "account.sessions": proc({
    input: z.object({}),
    handler: ({ actor }) => accounts.listSessions(actor),
  }),
  "account.revokeSession": proc({
    input: z.object({ sessionId: z.string().max(128).optional(), allOthers: z.boolean().optional() }),
    handler: ({ actor }, i) => accounts.revokeSession(actor, i),
  }),
  "account.resendVerification": proc({
    input: z.object({ next: z.string().regex(/^\/invite\/[A-Za-z0-9_-]{10,200}$/).optional() }),
    handler: ({ actor }, i) => accounts.resendVerification(actor, i.next),
  }),
  "account.removeAvatar": proc({
    input: z.object({}),
    handler: ({ actor }) => accounts.setAvatar(actor, null),
  }),
};

export type AppRouter = typeof appRouter;
export type ProcedureName = keyof AppRouter;
