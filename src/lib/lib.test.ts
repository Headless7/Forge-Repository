import { describe, expect, it } from "vitest";
import { countMyWork, isMyWork, matchesFilters, parseFilters, writeFilters, EMPTY_FILTERS } from "@/components/board/filters";
import { extractMentions } from "./mentions";
import { canGrantRole, canManageMember, cardPermissions, roleHas } from "./permissions";
import { positionBetween, resolveInsertIndex, spacedPositions } from "./positions";
import type { CardSummaryDTO } from "./types";
import { safeRedirectPath } from "./safe-redirect";
import { formatTimecode } from "./utils";

describe("positions", () => {
  it("places items between neighbours and signals when to rebalance", () => {
    expect(positionBetween(null, null)).toBe(1024);
    expect(positionBetween(1024, null)).toBe(2048);
    expect(positionBetween(null, 1024)).toBe(0);
    expect(positionBetween(1024, 2048)).toBe(1536);
    expect(positionBetween(1, 1 + 1e-9)).toBeNull();
    expect(spacedPositions(3)).toEqual([1024, 2048, 3072]);
  });

  it("prefers neighbour hints over raw indexes", () => {
    const list = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(resolveInsertIndex(list, { afterId: "b" })).toBe(2);
    expect(resolveInsertIndex(list, { beforeId: "a" })).toBe(0);
    expect(resolveInsertIndex(list, { afterId: "gone", index: 1 })).toBe(1);
    expect(resolveInsertIndex(list, { index: 99 })).toBe(3);
    expect(resolveInsertIndex(list, {})).toBe(3);
  });
});

describe("permissions", () => {
  it("maps roles to capabilities", () => {
    expect(roleHas("VIEWER", "project.view")).toBe(true);
    expect(roleHas("VIEWER", "comment.create")).toBe(false);
    expect(roleHas("CONTRIBUTOR", "card.review")).toBe(false);
    expect(roleHas("MANAGER", "card.review")).toBe(true);
    expect(roleHas("MANAGER", "project.update")).toBe(false);
    expect(roleHas("ADMIN", "studio.delete")).toBe(false);
    expect(roleHas("OWNER", "studio.delete")).toBe(true);
    expect(roleHas("CUSTOM", "project.view")).toBe(false);
  });

  it("derives card-level permissions from ownership", () => {
    const base = { userId: "u1", allowSelfApproval: false };
    const member = cardPermissions({ ...base, role: "CONTRIBUTOR", card: { createdById: "x", assigneeIds: ["u1"] } });
    expect(member).toMatchObject({ canEdit: true, canMove: true, canSubmit: true, canReview: false, canAssign: false, canSelfAssign: true });
    const stranger = cardPermissions({ ...base, role: "CONTRIBUTOR", card: { createdById: "x", assigneeIds: [] } });
    expect(stranger).toMatchObject({ canEdit: false, canMove: false, canSubmit: false, canComment: true, canUpload: false });
    const managerOnOwnWork = cardPermissions({ ...base, role: "MANAGER", card: { createdById: "x", assigneeIds: ["u1"] } });
    expect(managerOnOwnWork.canReview).toBe(false);
    expect(cardPermissions({ ...base, allowSelfApproval: true, role: "MANAGER", card: { createdById: "x", assigneeIds: ["u1"] } }).canReview).toBe(true);
    expect(cardPermissions({ ...base, role: "VIEWER", card: { createdById: "u1", assigneeIds: ["u1"] } })).toMatchObject({ canEdit: false, canComment: false });
  });

  it("restricts who can grant and manage roles", () => {
    expect(canGrantRole("ADMIN", "OWNER")).toBe(false);
    expect(canGrantRole("OWNER", "OWNER")).toBe(true);
    expect(canGrantRole("ADMIN", "MANAGER")).toBe(true);
    expect(canGrantRole("MANAGER", "CONTRIBUTOR")).toBe(false);
    expect(canManageMember("ADMIN", "OWNER")).toBe(false);
    expect(canManageMember("ADMIN", "ADMIN")).toBe(true);
  });
});

describe("mentions", () => {
  it("extracts lower-cased usernames, ignoring emails and duplicates", () => {
    expect(extractMentions("Hey @James and @giorgos, cc @james — mail me at a@b.com")).toEqual(["james", "giorgos"]);
    expect(extractMentions("(@alex) done")).toEqual(["alex"]);
    expect(extractMentions("no mentions")).toEqual([]);
  });
});

describe("timecodes", () => {
  it("formats milliseconds as mm:ss.hh", () => {
    expect(formatTimecode(4730)).toBe("00:04.73");
    expect(formatTimecode(61_000)).toBe("01:01.00");
    expect(formatTimecode(3_723_450)).toBe("1:02:03.45");
  });
});

describe("board filters", () => {
  const card = (patch: Partial<CardSummaryDTO>): CardSummaryDTO => ({
    id: "c",
    key: "UTD-1",
    number: 1,
    title: "Gojo Hollow Purple VFX",
    columnId: "col",
    position: 1,
    state: "IN_PROGRESS",
    productionStatus: "TODO",
    productionPosition: 1,
    progress: { total: 1, required: 1, withFiles: 0, inReview: 0, changesRequested: 0, inProgress: 1, notStarted: 0, approved: 0, approvedRequired: 0, blocked: 0 },
    pendingChanges: false,
    hasAudio: false,
    hasRoblox: false,
    priority: "NORMAL",
    displayMode: null,
    startAt: null,
    dueAt: null,
    milestoneId: null,
    assigneeIds: [],
    deliverableAssigneeIds: [],
    labelIds: [],
    cover: null,
    coverMode: "AUTO",
    counts: { comments: 0, attachments: 0, unresolvedFeedback: 0, resolvedFeedback: 0, checklistDone: 0, checklistTotal: 0, checklistMine: 0, checklistNextDue: null, versions: 0 },
    hasVideo: false,
    hasImage: false,
    unread: false,
    createdById: null,
    currentVersionNumber: null,
    updatedAt: "",
    lastActivityAt: "",
    ...patch,
  });
  const ctx = { userId: "me", members: new Map(), labels: new Map() };

  it("round-trips through the URL", () => {
    const f = { ...EMPTY_FILTERS, mine: true, states: ["NEEDS_REVIEW" as const, "APPROVED" as const], due: "overdue" as const, q: "gojo" };
    const params = writeFilters(f, new URLSearchParams("card=UTD-1"));
    expect(params.get("card")).toBe("UTD-1");
    expect(parseFilters(params)).toEqual(f);
  });

  it("combines multiple filters", () => {
    const f = { ...EMPTY_FILTERS, mine: true, states: ["NEEDS_REVIEW" as const], media: "video" as const };
    expect(matchesFilters(card({ assigneeIds: ["me"], state: "NEEDS_REVIEW", hasVideo: true }), f, ctx)).toBe(true);
    expect(matchesFilters(card({ assigneeIds: ["me"], state: "NEEDS_REVIEW", hasVideo: false }), f, ctx)).toBe(false);
    expect(matchesFilters(card({ assigneeIds: ["other"], state: "NEEDS_REVIEW", hasVideo: true }), f, ctx)).toBe(false);
  });

  it("counts work on a deliverable as yours", () => {
    const onDeliverable = card({ assigneeIds: ["lead"], deliverableAssigneeIds: ["me"] });
    expect(matchesFilters(onDeliverable, { ...EMPTY_FILTERS, mine: true }, ctx)).toBe(true);
    expect(matchesFilters(onDeliverable, { ...EMPTY_FILTERS, assignees: ["me"] }, ctx)).toBe(true);
    expect(matchesFilters(card({ assigneeIds: ["lead"] }), { ...EMPTY_FILTERS, mine: true }, ctx)).toBe(false);
  });

  it("counts My tasks exactly as the filter shows them, each card once", () => {
    // Regression: the badge counted card assignees only, the filter also deliverable owners/contributors.
    const cards = [
      card({ id: "a", assigneeIds: ["me"] }), // assignee
      card({ id: "b", assigneeIds: ["lead"], deliverableAssigneeIds: ["me"] }), // owns or contributes to a deliverable
      card({ id: "c", assigneeIds: ["me"], deliverableAssigneeIds: ["me", "other"] }), // both: still one card
      card({ id: "d", assigneeIds: ["other"], deliverableAssigneeIds: ["other"] }),
    ];
    const shown = cards.filter((c) => matchesFilters(c, { ...EMPTY_FILTERS, mine: true }, ctx));
    expect(countMyWork(cards, "me")).toBe(3);
    expect(countMyWork(cards, "me")).toBe(shown.length);
    expect(shown.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(isMyWork(cards[3]!, "me")).toBe(false);
  });

  it("handles due-date and text filters", () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    expect(matchesFilters(card({ dueAt: yesterday }), { ...EMPTY_FILTERS, due: "overdue" }, ctx)).toBe(true);
    expect(matchesFilters(card({ dueAt: yesterday, state: "APPROVED" }), { ...EMPTY_FILTERS, due: "overdue" }, ctx)).toBe(false);
    expect(matchesFilters(card({}), { ...EMPTY_FILTERS, q: "hollow vfx" }, ctx)).toBe(true);
    expect(matchesFilters(card({}), { ...EMPTY_FILTERS, q: "utd-1" }, ctx)).toBe(true);
    expect(matchesFilters(card({}), { ...EMPTY_FILTERS, q: "sukuna" }, ctx)).toBe(false);
  });
});

describe("redirect targets", () => {
  it("keep paths on this site", () => {
    expect(safeRedirectPath("/acme/game/b/1?card=GAM-4#x")).toBe("/acme/game/b/1?card=GAM-4#x");
    expect(safeRedirectPath("/invite/abc_DEF-123")).toBe("/invite/abc_DEF-123");
    expect(safeRedirectPath(undefined)).toBe("/");
    expect(safeRedirectPath(null, "/onboarding")).toBe("/onboarding");
  });

  it("refuse anything a browser could read as another site", () => {
    for (const value of ["//evil.com", "/\\evil.com", "/\\/evil.com", "\\\\evil.com", "https://evil.com", "evil.com", "/.//evil.com", "/%2e//evil.com", "/\t/evil.com", "/\n/evil.com", " /evil", "javascript:alert(1)", ["/a"]]) {
      expect(safeRedirectPath(value)).toBe("/");
    }
  });
});
