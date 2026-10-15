import { describe, expect, it } from "vitest";
import { DEFAULT_ITEM_FILTERS, compareItems, filterItems, hasNarrowingFilters, type ItemFilters } from "./forum-filter";
import type { ForumItemSummaryDTO } from "./types";

const ME = "me-id";
const ANA = "ana-id";
const BO = "bo-id";

type Item = Parameters<typeof filterItems>[0][number];
let n = 0;
function item(overrides: Partial<ForumItemSummaryDTO> & { title: string }): Item {
  n++;
  return {
    key: `UTD-B${n}`,
    status: "OPEN",
    priority: "MEDIUM",
    milestoneId: null,
    tagIds: [],
    assigneeId: null,
    reviewerId: null,
    reportedById: null,
    dueAt: null,
    createdAt: `2026-10-${String(n).padStart(2, "0")}T10:00:00.000Z`,
    lastActivityAt: `2026-10-${String(n).padStart(2, "0")}T10:00:00.000Z`,
    ...overrides,
  };
}

const items = [
  item({ title: "Mine to fix, Ana reported", assigneeId: ME, reportedById: ANA }),
  item({ title: "Ana fixes, I reported", assigneeId: ANA, reportedById: ME }),
  item({ title: "Unassigned, Bo reported", reportedById: BO }),
  item({ title: "Bo fixes, I verify", assigneeId: BO, reviewerId: ME, reportedById: BO }),
  item({ title: "Verified one", status: "VERIFIED", assigneeId: ME, reportedById: ANA }),
];

const titles = (f: Partial<ItemFilters>, sort: Parameters<typeof filterItems>[3] = "newest") => filterItems(items, { ...DEFAULT_ITEM_FILTERS, ...f }, ME, sort).map((i) => i.title);

describe("forum list filters", () => {
  it("shows unresolved items by default, newest first", () => {
    expect(titles({})).toEqual(["Bo fixes, I verify", "Unassigned, Bo reported", "Ana fixes, I reported", "Mine to fix, Ana reported"]);
    expect(titles({ status: "resolved" })).toEqual(["Verified one"]);
    expect(titles({ status: "all" })).toHaveLength(5);
  });

  it("filters by assignee: a member, me, or nobody", () => {
    expect(titles({ assignee: ANA })).toEqual(["Ana fixes, I reported"]);
    expect(titles({ assignee: "me" })).toEqual(["Mine to fix, Ana reported"]);
    expect(titles({ assignee: "none" })).toEqual(["Unassigned, Bo reported"]);
  });

  it("filters by reporter: a member or me", () => {
    expect(titles({ reporter: BO })).toEqual(["Bo fixes, I verify", "Unassigned, Bo reported"]);
    expect(titles({ reporter: "me" })).toEqual(["Ana fixes, I reported"]);
  });

  it("combines the assignee and reporter filters", () => {
    expect(titles({ assignee: BO, reporter: BO })).toEqual(["Bo fixes, I verify"]);
    expect(titles({ assignee: "none", reporter: BO })).toEqual(["Unassigned, Bo reported"]);
    expect(titles({ assignee: ANA, reporter: BO })).toEqual([]);
    expect(titles({ assignee: "me", reporter: ANA, status: "all" })).toEqual(["Verified one", "Mine to fix, Ana reported"]);
  });

  it("keeps Mine as everything I'm on (assignee, reviewer or reporter), and it combines too", () => {
    expect(titles({ mine: true })).toEqual(["Bo fixes, I verify", "Ana fixes, I reported", "Mine to fix, Ana reported"]);
    expect(titles({ mine: true, reporter: BO })).toEqual(["Bo fixes, I verify"]);
  });

  it("searches the key and title, and filters by priority, tag and update", () => {
    const more = [...items, item({ title: "Lamp floats", priority: "HIGH", tagIds: ["lobby"], milestoneId: "u65" })];
    const pick = (f: Partial<ItemFilters>) => filterItems(more, { ...DEFAULT_ITEM_FILTERS, ...f }, ME, "newest").map((i) => i.title);
    expect(pick({ query: "lamp" })).toEqual(["Lamp floats"]);
    expect(pick({ query: more.at(-1)!.key.toLowerCase() })).toEqual(["Lamp floats"]);
    expect(pick({ priority: "HIGH" })).toEqual(["Lamp floats"]);
    expect(pick({ tagId: "lobby" })).toEqual(["Lamp floats"]);
    expect(pick({ scope: "u65" })).toEqual(["Lamp floats"]);
    expect(pick({ scope: "none" })).not.toContain("Lamp floats");
  });

  it("knows when a filter (beyond the tabs) narrows the list", () => {
    expect(hasNarrowingFilters(DEFAULT_ITEM_FILTERS)).toBe(false);
    expect(hasNarrowingFilters({ ...DEFAULT_ITEM_FILTERS, scope: "u65", status: "all" })).toBe(false);
    for (const f of [{ assignee: "none" }, { reporter: "me" }, { mine: true }, { query: " x " }, { priority: "LOW" }, { tagId: "t" }] as Array<Partial<ItemFilters>>) {
      expect(hasNarrowingFilters({ ...DEFAULT_ITEM_FILTERS, ...f })).toBe(true);
    }
    expect(hasNarrowingFilters({ ...DEFAULT_ITEM_FILTERS, query: "   " })).toBe(false);
  });
});

describe("forum list sorting", () => {
  it("sorts by due date, soonest first, items with no date last (newest first among them)", () => {
    const list = [
      item({ title: "No date, older" }),
      item({ title: "Due later", dueAt: "2026-11-20T10:00:00.000Z" }),
      item({ title: "Overdue", dueAt: "2026-10-01T10:00:00.000Z" }),
      item({ title: "No date, newer" }),
      item({ title: "Due sooner", dueAt: "2026-11-02T10:00:00.000Z" }),
    ];
    expect([...list].sort(compareItems("due")).map((i) => i.title)).toEqual(["Overdue", "Due sooner", "Due later", "No date, newer", "No date, older"]);
  });

  it("sorts by priority (highest first) and by recent activity", () => {
    const list = [item({ title: "Low", priority: "LOW" }), item({ title: "Breaking", priority: "GAME_BREAKING" }), item({ title: "High", priority: "HIGH", lastActivityAt: "2027-01-01T00:00:00.000Z" })];
    expect([...list].sort(compareItems("priority")).map((i) => i.title)).toEqual(["Breaking", "High", "Low"]);
    expect([...list].sort(compareItems("updated")).map((i) => i.title)[0]).toBe("High");
  });
});
