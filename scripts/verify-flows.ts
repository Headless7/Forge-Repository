/**
 * End-to-end verification of the user flows against a running app (npm run dev).
 * Drives the real UI in Microsoft Edge/Chrome via Playwright, logs in as
 * different demo users, and saves screenshots to .verify/.
 *
 *   1 video review · 2 image annotation · 3 board workflow · 4 permissions
 *   5 production view · 6 deliverables, canvas & completion
 *   7 Roblox model/animation/effects + audio review · 8 navigation · 9 permissions & live sync
 *   10 your own Roblox files (opt-in: VERIFY_ASSETS=<folder>) · 11 select menus: keyboard, focus, contrast
 *   12 card covers (upload, choose, automatic, remove, boards, live updates, permissions)
 *
 *   npm run verify:flows            # all flows
 *   npm run verify:flows -- 3 7     # only flows 3 and 7
 *
 * Flows create cards and upload files: run them against the isolated verification server
 * (npm run verify:server, then VERIFY_URL=http://127.0.0.1:3100), not your working data.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, request, type Browser, type BrowserContext, type Page } from "playwright-core";
import sharp from "sharp";
import { R, writeBinaryModel, type WriteInstance } from "../src/server/roblox/writer";
import { RESOURCE_IDS } from "./seed/roblox";

const BASE = process.env.VERIFY_URL ?? "http://localhost:3000";
const OUT = path.resolve(".verify");
const MEDIA = path.resolve(".data/seed-media");
const PASSWORD = "demo1234";
const RUN = new Date().toISOString().slice(11, 19).replace(/:/g, "");
const only = process.argv.slice(2).filter((a) => /^\d+$/.test(a));

fs.mkdirSync(OUT, { recursive: true });

let browser: Browser;
const results: Array<{ flow: string; step: string; ok: boolean; detail?: string }> = [];

function check(flow: string, step: string, ok: boolean, detail?: string) {
  results.push({ flow, step, ok, detail });
  console.log(`${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} [${flow}] ${step}${detail ? ` — ${detail}` : ""}`);
  if (!ok) throw new Error(`${flow}: ${step} failed${detail ? ` (${detail})` : ""}`);
}

async function session(email: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1680, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (e) => console.log(`  ! page error (${email}): ${e.message}`));
  page.on("console", (m) => {
    // Browser errors (React update loops, failed renders) — Playwright's own caret-hiding style trips a harmless hydration warning, so skip that one.
    if (m.type() === "error" && !m.text().includes("hydrated but some attributes")) console.log(`  ! console error (${email}): ${m.text().slice(0, 1500)}`);
  });
  await page.goto(`${BASE}/sign-in`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 30_000 });
  return { context, page };
}

async function rpc<T = unknown>(page: Page, name: string, input: unknown): Promise<{ status: number; data?: T; error?: { code: string; message: string } }> {
  const res = await page.request.post(`${BASE}/api/rpc/${name}`, { data: input, headers: { origin: BASE } });
  const json = (await res.json().catch(() => ({}))) as { data?: T; error?: { code: string; message: string } };
  return { status: res.status(), ...json };
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}

interface BoardCard {
  id: string;
  key: string;
  title: string;
  state: string;
  columnId: string;
  position: number;
}
interface Board {
  project: { id: string };
  columns: Array<{ id: string; name: string; position: number }>;
  cards: BoardCard[];
}

async function board(page: Page, projectId: string) {
  const res = await rpc<Board>(page, "board.get", { projectId });
  return res.data!;
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, what: string, timeout = 30_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Chooses an option in one of the app's (Radix) selects, the way a person does. */
async function pick(page: Page, label: string, option: string | RegExp) {
  await page.getByRole("combobox", { name: label }).click();
  await page.getByRole("option", { name: option, exact: typeof option === "string" }).click();
}

async function openCard(page: Page, key: string) {
  await page.goto(`${BASE}/nightfall/universal-tower-defense?card=${key}`);
  await page.getByRole("dialog").getByRole("heading").first().waitFor();
}

async function tileState(page: Page, title: string) {
  const tile = page.locator("article", { hasText: title }).first();
  await tile.waitFor();
  return (await tile.getAttribute("aria-label")) ?? "";
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 8, from.y + 8, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 18 });
  await page.waitForTimeout(250);
  await page.mouse.move(to.x + 1, to.y + 1, { steps: 2 });
  await page.mouse.up();
  await page.waitForTimeout(700);
}

// ── Flow 1 ──────────────────────────────────────────────────────────────────
async function flow1() {
  const F = "Flow 1 · VFX submission";
  const title = `Gojo Hollow Purple VFX · run ${RUN}`;
  const manager = await session("giorgos@nightfall.gg");
  const james = await session("james@nightfall.gg");
  const utd = (await rpc<Array<{ id: string; slug: string }>>(manager.page, "project.list", { studioId: (await rpc<Array<{ id: string; slug: string }>>(manager.page, "studio.list", {})).data!.find((s) => s.slug === "nightfall")!.id })).data!.find((p) => p.slug === "universal-tower-defense")!;

  // Manager creates the card from the board header and assigns James.
  await manager.page.goto(`${BASE}/nightfall/universal-tower-defense`);
  await manager.page.locator("header").getByRole("button", { name: "Add card", exact: true }).click();
  await manager.page.getByLabel("Card title").fill(title);
  await manager.page.getByRole("button", { name: "Create & open" }).click();
  const dialog = manager.page.getByRole("dialog");
  await dialog.getByRole("heading", { name: title }).waitFor();
  const created = await waitFor(async () => (await board(manager.page, utd.id)).cards.find((c) => c.title === title), "card creation");
  check(F, "Manager creates the card", Boolean(created), created.key);
  const vfx = (await board(manager.page, utd.id)).columns.find((c) => c.name === "VFX")!;
  if (created.columnId !== vfx.id) await rpc(manager.page, "card.move", { cardId: created.id, toColumnId: vfx.id });

  await dialog.locator("aside").getByRole("button", { name: /Assign yourself|Nobody/ }).first().click();
  await manager.page.getByRole("button", { name: /James Walker/ }).click();
  await waitFor(async () => (await rpc<{ assigneeIds: string[] }>(manager.page, "card.get", { cardId: created.id })).data?.assigneeIds.length, "assignment");
  check(F, "Manager assigns James", true);
  await manager.page.keyboard.press("Escape");

  // James uploads gojo_v1.mp4 and submits for review.
  await openCard(james.page, created.key);
  await james.page.getByRole("button", { name: "Upload V1" }).click();
  const up = james.page.getByRole("dialog", { name: "Upload V1" });
  await up.locator('input[type="file"]').setInputFiles(path.join(MEDIA, "hp_v1.mp4"));
  await up.getByText("Submit V1 for review when the upload finishes").click();
  await up.getByRole("button", { name: "Upload as V1" }).click();
  await waitFor(async () => (await rpc<{ state: string }>(james.page, "card.get", { cardId: created.id })).data?.state === "NEEDS_REVIEW", "submission");
  await james.page.getByText("Waiting for review").first().waitFor();
  await shot(james.page, "flow1-01-james-submitted");
  check(F, "James uploads gojo_v1.mp4 and submits → Needs review", true);

  // Manager is notified.
  const notes = await rpc<{ items: Array<{ type: string; card: { id: string } | null }> }>(manager.page, "notification.list", { limit: 20 });
  check(F, "Manager receives a review-request notification", Boolean(notes.data?.items.some((n) => n.type === "REVIEW_REQUESTED" && n.card?.id === created.id)));

  // Manager pauses at 00:04.7 and leaves timestamp feedback, then a second item.
  await openCard(manager.page, created.key);
  const video = manager.page.locator("video").first();
  await video.waitFor();
  await video.evaluate(async (el: HTMLVideoElement) => {
    if (el.readyState < 1) await new Promise((r) => el.addEventListener("loadedmetadata", r, { once: true }));
    el.pause();
    el.currentTime = 4.7;
    await new Promise((r) => el.addEventListener("seeked", r, { once: true }));
  });
  const composer = manager.page.getByPlaceholder("Feedback at this moment…");
  await composer.click();
  await composer.fill("Increase the impact here.");
  await manager.page.getByRole("button", { name: "Add feedback" }).click();
  await manager.page.getByText("Increase the impact here.").first().waitFor();
  await video.evaluate(async (el: HTMLVideoElement) => {
    el.currentTime = 2.2;
    await new Promise((r) => el.addEventListener("seeked", r, { once: true }));
  });
  await composer.click();
  await composer.fill("Reduce camera shake.");
  await manager.page.getByRole("button", { name: "Add feedback" }).click();
  await manager.page.getByText("Reduce camera shake.").first().waitFor();
  const withFeedback = await rpc<{ comments: Array<{ body: string; annotation: { timestampMs: number | null } | null }> }>(manager.page, "card.get", { cardId: created.id });
  const impact = withFeedback.data!.comments.find((c) => c.body === "Increase the impact here.");
  check(F, "Timestamp feedback stored at 00:04.70", impact?.annotation?.timestampMs === 4700, `timestampMs=${impact?.annotation?.timestampMs}`);
  await shot(manager.page, "flow1-02-manager-feedback");

  await manager.page.getByRole("button", { name: "Request changes" }).first().click();
  const rc = manager.page.getByRole("dialog", { name: /Request changes/ });
  await rc.getByRole("button", { name: /Request changes/ }).click();
  await waitFor(async () => (await rpc<{ state: string }>(manager.page, "card.get", { cardId: created.id })).data?.state === "CHANGES_REQUESTED", "changes requested");
  await manager.page.keyboard.press("Escape");
  await manager.page.goto(`${BASE}/nightfall/universal-tower-defense`);
  const label = await tileState(manager.page, title);
  await shot(manager.page, "flow1-03-board-changes-requested");
  check(F, "Board shows 🔴 Changes requested", label.includes("Changes requested"), label);

  const jamesNotes = await rpc<{ items: Array<{ type: string; card: { id: string } | null }> }>(james.page, "notification.list", { limit: 20 });
  check(F, "James receives a changes-requested notification", Boolean(jamesNotes.data?.items.some((n) => n.type === "CHANGES_REQUESTED" && n.card?.id === created.id)));

  // James uploads V2 and resubmits; V1 stays available.
  await openCard(james.page, created.key);
  await james.page.getByRole("button", { name: "Upload new version" }).first().click();
  const up2 = james.page.getByRole("dialog", { name: "Upload V2" });
  await up2.locator('input[type="file"]').setInputFiles(path.join(MEDIA, "hp_v2.mp4"));
  await up2.getByText("Submit V2 for review when the upload finishes").click();
  await up2.getByRole("button", { name: "Upload as V2" }).click();
  await waitFor(async () => (await rpc<{ state: string; versions: unknown[] }>(james.page, "card.get", { cardId: created.id })).data?.state === "NEEDS_REVIEW", "resubmission");
  const afterV2 = await rpc<{ versions: Array<{ number: number; status: string }>; comments: Array<{ versionId: string | null; body: string }> }>(james.page, "card.get", { cardId: created.id });
  check(F, "V2 uploaded and resubmitted", afterV2.data!.versions.length === 2, afterV2.data!.versions.map((v) => `V${v.number}:${v.status}`).join(" "));
  check(F, "V1 remains with its review result", afterV2.data!.versions[0]!.status === "CHANGES_REQUESTED");
  await james.page.getByRole("button", { name: "Previous revision" }).click();
  await james.page.getByText("Increase the impact here.").first().waitFor();
  await shot(james.page, "flow1-04-james-v1-still-accessible");

  // Manager approves V2.
  await openCard(manager.page, created.key);
  await manager.page.getByRole("button", { name: "Approve" }).first().click();
  await manager.page.getByRole("dialog", { name: /Approve V2/ }).getByRole("button", { name: "Approve" }).click();
  await waitFor(async () => (await rpc<{ state: string }>(manager.page, "card.get", { cardId: created.id })).data?.state === "APPROVED", "approval");
  await manager.page.keyboard.press("Escape");
  await manager.page.goto(`${BASE}/nightfall/universal-tower-defense`);
  const approvedLabel = await tileState(manager.page, title);
  await shot(manager.page, "flow1-05-board-approved");
  check(F, "Board shows 🟢 Approved", approvedLabel.includes("Approved"), approvedLabel);

  const final = await rpc<{ reviews: Array<{ action: string }> }>(manager.page, "card.get", { cardId: created.id });
  const history = final.data!.reviews.map((r) => r.action).join(" → ");
  check(F, "Entire review history preserved", history === "SUBMITTED → CHANGES_REQUESTED → SUBMITTED → APPROVED", history);
  await openCard(manager.page, created.key);
  await manager.page.getByRole("tab", { name: /Revisions & reviews/ }).click();
  await manager.page.waitForTimeout(500);
  await shot(manager.page, "flow1-06-history");
  await manager.context.close();
  await james.context.close();
}

// ── Flow 2 ──────────────────────────────────────────────────────────────────
async function flow2() {
  const F = "Flow 2 · Screenshot review";
  const title = `Shop Icons Pass · run ${RUN}`;
  const sofia = await session("sofia@nightfall.gg");
  const manager = await session("giorgos@nightfall.gg");
  const projects = (await rpc<Array<{ id: string; slug: string }>>(sofia.page, "project.list", { studioId: (await rpc<Array<{ id: string; slug: string }>>(sofia.page, "studio.list", {})).data!.find((s) => s.slug === "nightfall")!.id })).data!;
  const utd = projects.find((p) => p.slug === "universal-tower-defense")!;
  const ui = (await board(sofia.page, utd.id)).columns.find((c) => c.name === "UI")!;
  const card = (await rpc<BoardCard>(sofia.page, "card.create", { projectId: utd.id, columnId: ui.id, title })).data!;

  // Designer uploads UI.png
  await openCard(sofia.page, card.key);
  await sofia.page.getByRole("button", { name: "Upload V1" }).click();
  const up = sofia.page.getByRole("dialog", { name: "Upload V1" });
  await up.locator('input[type="file"]').setInputFiles({ name: "UI.png", mimeType: "image/png", buffer: fs.readFileSync(path.join(MEDIA, "battlepass_v1.png")) });
  await up.getByText("Submit V1 for review when the upload finishes").click();
  await up.getByRole("button", { name: "Upload as V1" }).click();
  await waitFor(async () => (await rpc<{ state: string }>(sofia.page, "card.get", { cardId: card.id })).data?.state === "NEEDS_REVIEW", "UI.png submission");
  check(F, "Designer uploads UI.png", true);

  // Manager clicks an exact spot on the screenshot and leaves feedback.
  await openCard(manager.page, card.key);
  const viewer = manager.page.getByRole("application").first();
  await viewer.waitFor();
  await manager.page.waitForTimeout(600);
  const box = (await viewer.boundingBox())!;
  const img = manager.page.locator('img[alt="UI.png"]').first();
  const imgBox = (await img.boundingBox())!;
  const target = { x: imgBox.x + imgBox.width * 0.19, y: imgBox.y + imgBox.height * 0.5 };
  await manager.page.mouse.click(target.x, target.y);
  const composer = manager.page.getByPlaceholder("Feedback on this image…");
  await composer.fill("Increase spacing here.");
  await manager.page.getByRole("button", { name: "Add feedback" }).click();
  await manager.page.getByRole("button", { name: /Feedback 1: Increase spacing here/ }).waitFor();
  const detail = await rpc<{ comments: Array<{ id: string; body: string; annotation: { x: number; y: number; versionId: string | null } | null }>; versions: Array<{ id: string }> }>(manager.page, "card.get", { cardId: card.id });
  const pin = detail.data!.comments.find((c) => c.body === "Increase spacing here.")!;
  const nx = pin.annotation!.x;
  const ny = pin.annotation!.y;
  check(F, "Annotation stored in normalised coordinates", Math.abs(nx - 0.19) < 0.02 && Math.abs(ny - 0.5) < 0.02, `x=${nx.toFixed(3)} y=${ny.toFixed(3)} (viewer ${Math.round(box.width)}px)`);
  await shot(manager.page, "flow2-01-annotation-marker");
  check(F, "Numbered marker appears on the image", await manager.page.getByRole("button", { name: /Feedback 1:/ }).isVisible());

  // Designer replies and resolves.
  await openCard(sofia.page, card.key);
  const thread = sofia.page.locator(`#comment-${pin.id}`);
  await thread.getByRole("button", { name: "Reply" }).click();
  await sofia.page.getByPlaceholder("Write a reply…").fill("Bumping the gap to 24px.");
  await sofia.page.getByRole("button", { name: "Reply", exact: true }).last().click();
  await sofia.page.getByText("Bumping the gap to 24px.").waitFor();
  await thread.getByRole("button", { name: "Resolve" }).click();
  await waitFor(async () => (await rpc<{ comments: Array<{ id: string; resolvedAt: string | null }> }>(sofia.page, "card.get", { cardId: card.id })).data?.comments.find((c) => c.id === pin.id)?.resolvedAt, "resolution");
  check(F, "Designer replies and resolves the feedback", true);

  // New version; the annotation stays on V1.
  await sofia.page.getByRole("button", { name: "New revision", exact: true }).click();
  const up2 = sofia.page.getByRole("dialog", { name: "Upload V2" });
  await up2.locator('input[type="file"]').setInputFiles({ name: "UI.png", mimeType: "image/png", buffer: fs.readFileSync(path.join(MEDIA, "battlepass_v2.png")) });
  await up2.getByRole("button", { name: "Upload as V2" }).click();
  const after = await waitFor(async () => {
    const d = (await rpc<{ versions: Array<{ id: string; number: number }>; comments: Array<{ id: string; annotation: { versionId: string | null } | null }> }>(sofia.page, "card.get", { cardId: card.id })).data;
    return d && d.versions.length === 2 ? d : null;
  }, "V2 upload");
  const v1 = after.versions.find((v) => v.number === 1)!;
  const stillOnV1 = after.comments.find((c) => c.id === pin.id)?.annotation?.versionId === v1.id;
  check(F, "Previous annotation stays attached to V1", stillOnV1);
  await sofia.page.waitForTimeout(800);
  await sofia.page.getByRole("button", { name: "Previous revision" }).click();
  await sofia.page.getByRole("button", { name: /Feedback 1:/ }).waitFor();
  await shot(sofia.page, "flow2-02-v1-annotations-kept");
  await sofia.context.close();
  await manager.context.close();
}

// ── Flow 3 ──────────────────────────────────────────────────────────────────
async function flow3() {
  const F = "Flow 3 · Trello workflow";
  const { context, page } = await session("giorgos@nightfall.gg");
  const studios = (await rpc<Array<{ id: string; slug: string }>>(page, "studio.list", {})).data!;
  const utd = (await rpc<Array<{ id: string; slug: string }>>(page, "project.list", { studioId: studios.find((s) => s.slug === "nightfall")!.id })).data!.find((p) => p.slug === "universal-tower-defense")!;
  const columnName = `Sound Design ${RUN}`;
  await page.goto(`${BASE}/nightfall/universal-tower-defense`);

  // Create the column from the board.
  const scroller = page.locator("section[aria-label$='column']").first();
  await scroller.waitFor();
  await page.getByRole("button", { name: "Add category" }).scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "Add category" }).click();
  await page.getByLabel("New category name").fill(columnName);
  await page.getByLabel("New category name").press("Enter");
  await page.locator(`section[aria-label="${columnName} column"]`).waitFor();
  check(F, "Create column “Sound Design”", true);

  // Drag it between VFX and Animations.
  await page.locator("section[aria-label='VFX column']").scrollIntoViewIfNeeded();
  const handle = page.getByRole("button", { name: `Reorder ${columnName} column` });
  await handle.scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    const el = document.querySelector("section[aria-label='VFX column']")?.closest(".overflow-x-auto") as HTMLElement | null;
    el?.scrollTo({ left: 0 });
  });
  await page.waitForTimeout(300);
  // The new column is off-screen at the end; move it with the keyboard sensor instead of a long pointer drag.
  await handle.focus();
  await page.keyboard.press("Space");
  await page.waitForTimeout(200);
  let order = (await board(page, utd.id)).columns.sort((a, b) => a.position - b.position).map((c) => c.name);
  const presses = order.indexOf(columnName) - 1;
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(120);
  }
  await page.keyboard.press("Space");
  await page.waitForTimeout(1200);
  order = (await board(page, utd.id)).columns.sort((a, b) => a.position - b.position).map((c) => c.name);
  check(F, "Move it between VFX and Animations", order[1] === columnName, order.slice(0, 4).join(" | "));

  // Create three cards with quick add.
  const col = (await board(page, utd.id)).columns.find((c) => c.name === columnName)!;
  const section = page.locator(`section[aria-label="${columnName} column"]`);
  await section.scrollIntoViewIfNeeded();
  await section.getByRole("button", { name: /Add card/ }).first().click();
  const titles = [`Footsteps pass ${RUN}`, `UI click sounds ${RUN}`, `Boss roar ${RUN}`];
  for (const t of titles) {
    await page.getByLabel("New card title").fill(t);
    await page.getByLabel("New card title").press("Enter");
    await section.locator("article", { hasText: t }).waitFor();
  }
  await page.getByLabel("New card title").press("Escape");
  await waitFor(async () => (await board(page, utd.id)).cards.filter((c) => c.columnId === col.id && !c.id.startsWith("temp-")).length === 3, "three cards");
  check(F, "Create three cards", true);

  // Reorder: drag the third card above the first.
  const third = section.locator("article", { hasText: titles[2] });
  const first = section.locator("article", { hasText: titles[0] });
  const tb = (await third.boundingBox())!;
  const fb = (await first.boundingBox())!;
  await drag(page, { x: tb.x + tb.width / 2, y: tb.y + tb.height / 2 }, { x: fb.x + fb.width / 2, y: fb.y + 6 });
  const inCol = async () =>
    (await board(page, utd.id)).cards
      .filter((c) => c.columnId === col.id)
      .sort((a, b) => a.position - b.position)
      .map((c) => c.title);
  let current = await waitFor(async () => {
    const list = await inCol();
    return list[0] === titles[2] ? list : null;
  }, "reorder persisted", 10_000).catch(async () => inCol());
  check(F, "Reorder cards by dragging", current[0] === titles[2], current.join(" | "));

  // Move one card to another column (Animations).
  const animations = page.locator("section[aria-label='Animations column']");
  const moving = section.locator("article", { hasText: titles[1] });
  const mb = (await moving.boundingBox())!;
  const ab = (await animations.boundingBox())!;
  await drag(page, { x: mb.x + mb.width / 2, y: mb.y + mb.height / 2 }, { x: ab.x + ab.width / 2, y: ab.y + 60 });
  const animCol = (await board(page, utd.id)).columns.find((c) => c.name === "Animations")!;
  const moved = await waitFor(async () => (await board(page, utd.id)).cards.find((c) => c.title === titles[1] && c.columnId === animCol.id), "cross-column move", 10_000).catch(() => null);
  check(F, "Move a card to another column", Boolean(moved));
  await shot(page, "flow3-01-before-refresh");

  // Refresh: everything stays in place.
  await page.reload();
  // (:visible — while the page streams in, Next.js briefly holds a hidden copy of the markup.)
  await page.locator(`section[aria-label="${columnName} column"]:visible`).waitFor();
  const domOrder = await page.locator(`section[aria-label="${columnName} column"]:visible article h3`).allTextContents();
  const columnsDom = await page.locator("section[aria-label$=' column']:visible").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  const inAnimations = await page.locator("section[aria-label='Animations column']:visible article h3").allTextContents();
  current = await inCol();
  check(F, "After refresh: column order persisted", columnsDom[1] === `${columnName} column`, columnsDom.slice(0, 3).join(" | "));
  check(F, "After refresh: card order persisted", domOrder.join("|") === [titles[2], titles[0]].join("|"), domOrder.join(" | "));
  check(F, "After refresh: moved card is in Animations", inAnimations.includes(titles[1]));
  await shot(page, "flow3-02-after-refresh");
  // Tidy up so repeated runs don't pile columns onto the demo board (archived = recoverable).
  await rpc(page, "column.archive", { columnId: col.id, archived: true });
  await context.close();
}

// ── Flow 4 ──────────────────────────────────────────────────────────────────
async function flow4() {
  const F = "Flow 4 · Permissions";
  const insider = await session("giorgos@nightfall.gg");
  const utdBoard = await (async () => {
    const studios = (await rpc<Array<{ id: string; slug: string }>>(insider.page, "studio.list", {})).data!;
    const utd = (await rpc<Array<{ id: string; slug: string }>>(insider.page, "project.list", { studioId: studios.find((s) => s.slug === "nightfall")!.id })).data!.find((p) => p.slug === "universal-tower-defense")!;
    return board(insider.page, utd.id);
  })();
  const someCard = utdBoard.cards[0]!;

  const outsider = await session("omar@emberlight.dev");
  const res = await outsider.page.goto(`${BASE}/nightfall/universal-tower-defense`);
  await shot(outsider.page, "flow4-01-outsider-404");
  check(F, "Studio B member opening Studio A's project URL gets 404", res?.status() === 404, `HTTP ${res?.status()}`);
  const apiBoard = await rpc(outsider.page, "board.get", { projectId: utdBoard.project.id });
  check(F, "API rejects reading the board by ID", apiBoard.status === 404, `${apiBoard.status} ${apiBoard.error?.code}`);
  const apiCard = await rpc(outsider.page, "card.get", { cardId: someCard.id });
  check(F, "API rejects reading a card by ID", apiCard.status === 404, `${apiCard.status} ${apiCard.error?.code}`);
  const apiWrite = await rpc(outsider.page, "comment.create", { cardId: someCard.id, body: "sneaky" });
  check(F, "API rejects commenting on another studio's card", apiWrite.status === 404, `${apiWrite.status} ${apiWrite.error?.code}`);
  const apiMove = await rpc(outsider.page, "card.move", { cardId: someCard.id, toColumnId: someCard.columnId });
  check(F, "API rejects moving another studio's card", apiMove.status === 404, `${apiMove.status}`);

  const viewer = await session("ruby@nightfall.gg");
  const create = await rpc(viewer.page, "card.create", { projectId: utdBoard.project.id, columnId: utdBoard.columns[0]!.id, title: "viewer attempt" });
  check(F, "Viewer role cannot create cards (server-side)", create.status === 403, `${create.status} ${create.error?.message}`);
  // Reviews are per deliverable; resolve the card's (only) deliverable as an insider first.
  const deliverableOf = async (cardId: string) => (await rpc<{ deliverables: Array<{ id: string }> }>(insider.page, "card.get", { cardId })).data!.deliverables[0]!.id;
  const approve = await rpc(viewer.page, "review.approve", { deliverableId: await deliverableOf(someCard.id) });
  check(F, "Viewer role cannot approve work", approve.status === 403, `${approve.status}`);

  const member = await session("kenji@nightfall.gg");
  const vfxCard = utdBoard.cards.find((c) => c.title === "Sukuna Domain Expansion VFX")!;
  const memberApprove = await rpc(member.page, "review.approve", { deliverableId: await deliverableOf(vfxCard.id) });
  check(F, "Member cannot approve reviews", memberApprove.status === 403, `${memberApprove.status}`);
  const memberEdit = await rpc(member.page, "card.update", { cardId: vfxCard.id, title: "hijacked" });
  check(F, "Member cannot edit a card they don't work on", memberEdit.status === 403, `${memberEdit.status}`);

  const anonymous = await request.newContext();
  const noSession = await anonymous.post(`${BASE}/api/rpc/board.get`, { data: { projectId: utdBoard.project.id }, headers: { origin: BASE } });
  await anonymous.dispose();
  const crossSite = await insider.page.request.post(`${BASE}/api/rpc/card.create`, {
    data: { projectId: utdBoard.project.id, columnId: utdBoard.columns[0]!.id, title: "csrf" },
    headers: { origin: "https://evil.example" },
  });
  check(F, "Cross-site POST is blocked (CSRF)", crossSite.status() === 403, `HTTP ${crossSite.status()}`);
  check(F, "Unauthenticated API call is rejected", noSession.status() === 401, `HTTP ${noSession.status()}`);
  for (const s of [insider, outsider, viewer, member]) await s.context.close();
}

// ── Helpers for the production / deliverable / preview flows ────────────────
interface DeliverableRow {
  id: string;
  number: number;
  name: string;
  state: string;
  required: boolean;
  versionCount: number;
  currentVersionId: string | null;
  approvedVersionId: string | null;
  blockedBy: string[];
  canvasX: number;
  canvasY: number;
  archivedAt: string | null;
}
interface AttachmentRow {
  id: string;
  kind: string;
  status: string;
  filename: string;
  purpose: string;
  versionId: string | null;
  deliverableId: string | null;
  meta: Record<string, unknown> | null;
  error: string | null;
}
interface CommentRow {
  id: string;
  body: string;
  kind: string;
  deliverableId: string | null;
  versionId: string | null;
  annotation: { timestampMs: number | null } | null;
}
interface Detail {
  id: string;
  key: string;
  title: string;
  state: string;
  columnId: string;
  productionStatus: string;
  pendingChanges: boolean;
  progress: { total: number; approved: number; inReview: number; withFiles: number; blocked: number };
  deliverables: DeliverableRow[];
  deliverableLinks: Array<{ id: string; fromId: string; toId: string; type: string }>;
  readiness: { ready: boolean; blockers: Array<{ deliverableId: string; name: string; reason: string }>; pendingChanges: Array<{ deliverableId: string; name: string; detail: string }> };
  productionSnapshot: Array<{ deliverableId: string; name: string; versionNumber: number | null }>;
  productionEvents: Array<{ toStatus: string }>;
  versions: Array<{ id: string; number: number; deliverableId: string; status: string }>;
  attachments: AttachmentRow[];
  comments: CommentRow[];
}
type ProductionCard = BoardCard & { productionStatus: string; productionPosition: number; pendingChanges: boolean };
interface FullBoard extends Board {
  cards: ProductionCard[];
  prefs: { view: string; collapsedColumnIds: string[] };
}

const STAGE_LABEL: Record<string, string> = { TODO: "To-do", COMPLETED: "Completed", PUBLISHED: "Published" };
const ROBLOX_MEDIA = path.join(MEDIA, "roblox");

async function utdProject(page: Page) {
  const studios = (await rpc<Array<{ id: string; slug: string }>>(page, "studio.list", {})).data!;
  const studio = studios.find((s) => s.slug === "nightfall")!;
  const project = (await rpc<Array<{ id: string; slug: string }>>(page, "project.list", { studioId: studio.id })).data!.find((p) => p.slug === "universal-tower-defense")!;
  return { studioId: studio.id, projectId: project.id };
}
const fullBoard = async (page: Page, projectId: string) => (await rpc<FullBoard>(page, "board.get", { projectId })).data!;
const detail = async (page: Page, cardId: string) => (await rpc<Detail>(page, "card.get", { cardId })).data!;
const named = (d: Detail, name: string) => d.deliverables.find((x) => x.name === name && !x.archivedAt)!;

/** Deep link to a deliverable — the URL carries its number within the card (…?card=UTD-12&d=3). */
async function openDeliverable(page: Page, key: string, deliverable: { number: number }) {
  await page.goto(`${BASE}/nightfall/universal-tower-defense?card=${key}&d=${deliverable.number}`);
  await page.getByRole("navigation", { name: "Breadcrumb" }).waitFor();
}

/** Uploads the next revision of the open deliverable through the real upload dialog. */
async function uploadRevision(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }, submit = false) {
  const first = page.getByRole("button", { name: "Upload V1" });
  if (await first.count()) await first.first().click();
  else await page.getByRole("button", { name: "New revision", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /^Upload .*V\d+$/ });
  await dialog.waitFor();
  await dialog.locator('input[type="file"]').setInputFiles(file);
  if (submit) await dialog.getByText(/Submit V\d+ for review when the upload finishes/).click();
  await dialog.getByRole("button", { name: /Upload as V\d+/ }).click();
}

/** Waits until the given revision's file has finished processing (or failed). */
async function waitProcessed(page: Page, cardId: string, deliverableId: string, number: number, timeout = 90_000) {
  return waitFor(
    async () => {
      const d = await detail(page, cardId);
      const v = d.versions.find((x) => x.deliverableId === deliverableId && x.number === number);
      const a = v ? d.attachments.find((x) => x.versionId === v.id) : undefined;
      return a && (a.status === "READY" || a.status === "FAILED") ? { d, a } : null;
    },
    `V${number} processing`,
    timeout,
  );
}

/** Standard deviation of the rendered pixels — ~0 for a blank or single-colour canvas. */
async function pixelSpread(locator: ReturnType<Page["locator"]>) {
  const stats = await sharp(await locator.screenshot()).stats();
  return stats.channels.slice(0, 3).reduce((n, c) => n + c.stdev, 0) / 3;
}

/** Mean absolute per-pixel difference between two screenshots of the same size. */
async function pixelDiff(a: Buffer, b: Buffer) {
  const [ra, rb] = await Promise.all([sharp(a).removeAlpha().raw().toBuffer(), sharp(b).removeAlpha().raw().toBuffer()]);
  let sum = 0;
  const n = Math.min(ra.length, rb.length);
  for (let i = 0; i < n; i++) sum += Math.abs(ra[i]! - rb[i]!);
  return sum / n;
}

/** A plain pointer double-click at the element's centre (what a person does). */
async function dblclickCenter(page: Page, locator: ReturnType<Page["locator"]>) {
  const b = (await locator.boundingBox())!;
  await page.mouse.dblclick(b.x + b.width / 2, b.y + b.height / 2);
}

async function dragBetween(page: Page, from: ReturnType<Page["locator"]>, to: ReturnType<Page["locator"]>, toOffsetY = 0) {
  // Centre the source inside its scrolling column so the pointer lands on it, not on a footer.
  // Long columns use content-visibility, so sizes settle after a scroll — repeat until it's really inside.
  let last = "";
  for (let i = 0; i < 10; i++) {
    await from.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(150);
    const where = await from.evaluate((el) => {
      let box: HTMLElement | null = el.parentElement;
      while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
      const r = el.getBoundingClientRect();
      const c = box ? box.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
      return { inside: r.top >= c.top - 1 && r.bottom <= c.bottom + 1, at: Math.round(r.top) };
    });
    if (where.inside && String(where.at) === last) break;
    last = String(where.at);
  }
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await drag(page, { x: a.x + a.width / 2, y: a.y + a.height / 2 }, { x: b.x + b.width / 2, y: b.y + toOffsetY + (toOffsetY ? 0 : b.height / 2) });
}

// ── Flow 5 ──────────────────────────────────────────────────────────────────
async function flow5() {
  const F = "Flow 5 · Production view";
  const { context, page } = await session("giorgos@nightfall.gg");
  const { projectId } = await utdProject(page);
  await rpc(page, "board.setView", { projectId, view: "CATEGORY" });
  await page.goto(`${BASE}/nightfall/universal-tower-defense`);
  await page.locator("section[aria-label$=' column']:visible").first().waitFor();

  // Switch views with the header control.
  await page.getByRole("radio", { name: /Production/ }).click();
  await page.locator("section[aria-label='To-do stage']:visible").waitFor();
  await page.waitForTimeout(600);
  let b = await fullBoard(page, projectId);
  const titlesIn = (stage: string) => page.locator(`section[aria-label='${STAGE_LABEL[stage]} stage']:visible article h3`).allTextContents();
  const shown: Record<string, string[]> = {};
  for (const s of ["TODO", "COMPLETED", "PUBLISHED"]) shown[s] = await titlesIn(s);
  const everything = [...shown.TODO!, ...shown.COMPLETED!, ...shown.PUBLISHED!];
  const expected = b.cards.map((c) => c.title);
  check(F, "Every card appears exactly once across the three stages", JSON.stringify([...everything].sort()) === JSON.stringify([...expected].sort()), `${everything.length} tiles for ${expected.length} cards`);
  for (const s of ["TODO", "COMPLETED", "PUBLISHED"]) {
    const want = b.cards.filter((c) => c.productionStatus === s).sort((x, y) => x.productionPosition - y.productionPosition).map((c) => c.title);
    const count = (await page.locator(`section[aria-label='${STAGE_LABEL[s]} stage']:visible header span.rounded-full`).first().textContent())?.trim();
    check(F, `${STAGE_LABEL[s]}: right cards, stable order, accurate count`, JSON.stringify(shown[s]) === JSON.stringify(want) && count === String(want.length), `${count} shown, ${want.length} expected`);
  }
  const sample = b.cards.find((c) => c.productionStatus === "TODO")!;
  const sampleCategory = b.columns.find((c) => c.id === sample.columnId)!.name;
  const chip = await page.locator(`section[aria-label='To-do stage']:visible article`, { hasText: sample.title }).first().locator("p").first().textContent();
  check(F, "Tiles show their category in the production view", chip?.trim() === sampleCategory, `${sample.title} → ${chip?.trim()}`);
  await shot(page, "flow5-01-production-view");

  b = await fullBoard(page, projectId);
  check(F, "The chosen view is saved for this user", b.prefs.view === "PRODUCTION", b.prefs.view);
  await page.reload();
  await page.locator("section[aria-label='To-do stage']:visible").waitFor();
  check(F, "After refresh the production view is still shown", (await page.locator("section[aria-label$=' column']:visible").count()) === 0);

  // Filter by category (shareable URL filter, same as the category view uses).
  const busiest = [...b.columns].sort((x, y) => b.cards.filter((c) => c.columnId === y.id).length - b.cards.filter((c) => c.columnId === x.id).length)[0]!;
  const inBusiest = b.cards.filter((c) => c.columnId === busiest.id);
  await page.goto(`${BASE}/nightfall/universal-tower-defense?category=${busiest.id}`);
  await page.locator("section[aria-label='To-do stage']:visible").waitFor();
  await page.waitForTimeout(500);
  const filteredTiles = await page.locator("section[aria-label$=' stage']:visible article").count();
  const todoCount = (await page.locator("section[aria-label='To-do stage']:visible header span.rounded-full").first().textContent())?.trim();
  const todoTotal = b.cards.filter((c) => c.productionStatus === "TODO").length;
  const todoShown = inBusiest.filter((c) => c.productionStatus === "TODO").length;
  check(F, `Filter by category (${busiest.name})`, filteredTiles === inBusiest.length && todoCount === `${todoShown} / ${todoTotal}`, `${filteredTiles} tiles, To-do shows “${todoCount}”`);
  await shot(page, "flow5-02-filtered");

  // Create a card straight into To-do from the production view.
  await page.goto(`${BASE}/nightfall/universal-tower-defense`);
  await page.locator("section[aria-label='To-do stage']:visible").waitFor();
  const title = `Stage drag ${RUN}`;
  await page.getByRole("button", { name: "Add card to To-do" }).click();
  await page.getByLabel("New card title").fill(title);
  await page.getByLabel("New card title").press("Enter");
  const todo = page.locator("section[aria-label='To-do stage']:visible");
  await todo.locator("article", { hasText: title }).waitFor();
  await page.getByLabel("New card title").press("Escape");
  const created = await waitFor(async () => (await fullBoard(page, projectId)).cards.find((c) => c.title === title && !c.id.startsWith("temp-")), "created card");
  check(F, "Create a card from the production view (lands in To-do with a category)", created.productionStatus === "TODO" && Boolean(b.columns.find((c) => c.id === created.columnId)));

  // Reorder inside To-do: drag it above its neighbour; the order persists.
  const tile = (t: string) => todo.locator("article").filter({ has: page.locator("h3").getByText(t, { exact: true }) });
  await tile(title).scrollIntoViewIfNeeded();
  const orderBefore = await todo.locator("article h3").allTextContents();
  const neighbour = orderBefore[orderBefore.indexOf(title) - 1]!;
  await dragBetween(page, tile(title), tile(neighbour), 6);
  const todoOrder = async () => (await fullBoard(page, projectId)).cards.filter((c) => c.productionStatus === "TODO").sort((x, y) => x.productionPosition - y.productionPosition).map((c) => c.title);
  const reordered = await waitFor(async () => {
    const list = await todoOrder();
    return list.indexOf(title) === list.indexOf(neighbour) - 1 ? list : null;
  }, "stage reorder", 10_000).catch(() => null);
  await page.reload();
  await todo.locator("article").first().waitFor();
  const orderAfter = await todo.locator("article h3").allTextContents();
  check(F, "Reordering within a stage persists after refresh", Boolean(reordered) && orderAfter.indexOf(title) === orderAfter.indexOf(neighbour) - 1, `${title} now above ${neighbour}`);

  // Dragging unfinished work to Completed is refused with an explanation.
  const completed = page.locator("section[aria-label='Completed stage']:visible");
  await tile(title).scrollIntoViewIfNeeded();
  await dragBetween(page, tile(title), completed);
  const notReady = page.getByRole("dialog", { name: /isn't ready to be Completed/ });
  await notReady.waitFor();
  const reason = await notReady.locator("li").first().textContent();
  await shot(page, "flow5-03-not-ready");
  await notReady.getByRole("button", { name: "Close", exact: true }).last().click();
  const after = (await fullBoard(page, projectId)).cards.find((c) => c.id === created.id)!;
  check(F, "Dragging unapproved work to Completed explains what's missing and doesn't move it", after.productionStatus === "TODO" && /no files|not submitted|waiting|in progress/i.test(reason ?? ""), reason ?? "");
  const serverRefusal = await rpc(page, "card.setProduction", { cardId: created.id, status: "COMPLETED" });
  check(F, "Server enforces completion rules too", serverRefusal.status === 409, `${serverRefusal.status} ${serverRefusal.error?.message}`);

  // A card whose required deliverables are all approved can be dragged to Completed.
  const candidates = (await fullBoard(page, projectId)).cards.filter((c) => c.productionStatus === "TODO" && c.state === "APPROVED");
  let ready: ProductionCard | undefined;
  for (const c of candidates) if ((await detail(page, c.id)).readiness.ready) ready = ready ?? c;
  if (ready) {
    await page.locator("section[aria-label='To-do stage']:visible article", { hasText: ready.title }).first().scrollIntoViewIfNeeded();
    await dragBetween(page, page.locator("section[aria-label='To-do stage']:visible article", { hasText: ready.title }).first(), completed);
    const moved = await waitFor(async () => ((await detail(page, ready.id)).productionStatus === "COMPLETED" ? true : null), "completion", 10_000).catch(() => false);
    const d = await detail(page, ready.id);
    check(F, "Dragging approved work to Completed records the approved revisions", moved === true && d.productionSnapshot.length > 0 && d.productionEvents.at(-1)?.toStatus === "COMPLETED", `${ready.title}: ${d.productionSnapshot.map((s) => `${s.name} V${s.versionNumber}`).join(", ")}`);
    await rpc(page, "card.setProduction", { cardId: ready.id, status: "TODO", note: "verification reset" });
  } else {
    console.log("  (no approved To-do card on this board to drag — flow 6 covers dragging a ready card)");
  }

  // Back to the category view: no duplicates, stage visible on tiles.
  await page.getByRole("radio", { name: /Categories/ }).click();
  await page.locator("section[aria-label$=' column']:visible").first().waitFor();
  await page.waitForTimeout(500);
  b = await fullBoard(page, projectId);
  const collapsed = new Set(b.prefs.collapsedColumnIds);
  const categoryTitles = await page.locator("section[aria-label$=' column']:visible article h3").allTextContents();
  const expectedCategory = b.cards.filter((c) => !collapsed.has(c.columnId)).map((c) => c.title);
  check(F, "Category view shows each card once", JSON.stringify([...categoryTitles].sort()) === JSON.stringify([...expectedCategory].sort()), `${categoryTitles.length} tiles`);
  const published = b.cards.find((c) => c.productionStatus === "PUBLISHED" && !collapsed.has(c.columnId));
  if (published) {
    const tileText = await page.locator("section[aria-label$=' column']:visible article", { hasText: published.title }).first().textContent();
    check(F, "Category view shows the production stage on tiles", Boolean(tileText?.includes("Published")), published.title);
  }
  check(F, "Switching back is remembered too", (await fullBoard(page, projectId)).prefs.view === "CATEGORY");
  await shot(page, "flow5-04-category-view");
  await context.close();
}

// ── Flow 6 ──────────────────────────────────────────────────────────────────
async function flow6() {
  const F = "Flow 6 · Deliverables & completion";
  const { context, page } = await session("giorgos@nightfall.gg");
  const { projectId } = await utdProject(page);
  await rpc(page, "board.setView", { projectId, view: "CATEGORY" });
  const title = `Guardian kit ${RUN}`;
  await page.goto(`${BASE}/nightfall/universal-tower-defense`);
  await page.locator("header").getByRole("button", { name: "Add card", exact: true }).click();
  await page.getByLabel("Card title").fill(title);
  await page.getByRole("button", { name: "Create & open" }).click();
  const modal = page.getByRole("dialog");
  await modal.getByRole("heading", { name: title }).waitFor();
  const card = await waitFor(async () => (await fullBoard(page, projectId)).cards.find((c) => c.title === title && !c.id.startsWith("temp-")), "card");
  check(F, "A new card starts simple — one implicit deliverable, no canvas", (await page.locator("section#deliverables").count()) === 0 && (await detail(page, card.id)).deliverables.length === 1);

  // Add deliverables through the UI (no fixed template).
  const addDeliverable = async (name: string, type: string, required = true) => {
    const trigger = page.getByRole("button", { name: /Add another deliverable|Add deliverable/ }).first();
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Add a deliverable" });
    await dialog.getByPlaceholder(/e\.g\. Ultimate animation/).fill(name);
    await dialog.getByPlaceholder("Any label").fill(type);
    if (!required) await dialog.getByText("Required to complete the card").click();
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await waitFor(async () => (await detail(page, card.id)).deliverables.some((d) => d.name === name), `deliverable ${name}`);
  };
  await addDeliverable("Model", "Model");
  await page.locator("section#deliverables").waitFor();
  await addDeliverable("Animation", "Animation");
  await addDeliverable("Impact SFX", "Audio", false);
  // The implicit first deliverable becomes an optional concept pass (edited like any other).
  const primary = (await detail(page, card.id)).deliverables.find((d) => d.name === title)!;
  await rpc(page, "deliverable.update", { deliverableId: primary.id, name: "Concept", required: false });
  let d = await detail(page, card.id);
  check(F, "Card now has four deliverables with their own types and required flags", d.deliverables.length === 4 && named(d, "Impact SFX").required === false && named(d, "Model").required === true);

  // Connect on the canvas by dragging from one node's handle to another's.
  await page.getByRole("radio", { name: /Canvas/ }).click();
  await page.locator(".react-flow__node").nth(3).waitFor();
  const node = (name: string) => page.locator(`.react-flow__node[data-id="${named(d, name).id}"]`);
  await page.waitForTimeout(600);
  const pane = (await page.locator(".react-flow").boundingBox())!;
  const offCanvas: string[] = [];
  for (const name of ["Concept", "Model", "Animation", "Impact SFX"]) {
    const b = (await node(name).boundingBox())!;
    if (b.x < pane.x || b.x + b.width > pane.x + pane.width) offCanvas.push(name);
  }
  check(F, "Newly added deliverables are brought into view on the canvas", offCanvas.length === 0, offCanvas.join(", "));
  const connect = async (from: string, to: string, type: "Dependency" | "Association") => {
    const s = (await node(from).locator(".react-flow__handle.source").boundingBox())!;
    const t = (await node(to).locator(".react-flow__handle.target").boundingBox())!;
    await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
    await page.mouse.down();
    await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 20 });
    await page.mouse.up();
    const dialog = page.getByRole("dialog", { name: "Connect deliverables" });
    await dialog.waitFor();
    await dialog.getByRole("radio", { name: new RegExp(type) }).click();
    await dialog.getByRole("button", { name: "Connect", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.waitForTimeout(500); // let the dialog overlay finish closing
  };
  await connect("Model", "Animation", "Dependency");
  await connect("Animation", "Impact SFX", "Association");
  d = await waitFor(async () => {
    const x = await detail(page, card.id);
    return x.deliverableLinks.length === 2 ? x : null;
  }, "links");
  const dep = d.deliverableLinks.find((l) => l.type === "DEPENDENCY");
  check(F, "Canvas creates a dependency and an association", dep?.fromId === named(d, "Model").id && dep?.toId === named(d, "Animation").id && d.deliverableLinks.some((l) => l.type === "ASSOCIATION"));
  check(F, "Dependant shows as blocked by its prerequisite", named(d, "Animation").blockedBy.includes(named(d, "Model").id));
  const cycle = await rpc(page, "deliverable.link", { cardId: card.id, fromId: named(d, "Animation").id, toId: named(d, "Model").id, type: "DEPENDENCY" });
  const self = await rpc(page, "deliverable.link", { cardId: card.id, fromId: named(d, "Model").id, toId: named(d, "Model").id, type: "ASSOCIATION" });
  check(F, "Cycles and self-links are refused", cycle.status >= 400 && cycle.status < 500 && self.status >= 400 && self.status < 500, `${cycle.status} “${cycle.error?.message}” / ${self.status}`);

  // Move a node; the layout persists.
  const before = named(d, "Impact SFX");
  const box = (await node("Impact SFX").boundingBox())!;
  await drag(page, { x: box.x + box.width / 2, y: box.y + 20 }, { x: box.x + box.width / 2, y: box.y + 160 });
  const movedNode = await waitFor(async () => {
    const x = named(await detail(page, card.id), "Impact SFX");
    return Math.abs(x.canvasY - before.canvasY) > 40 ? x : null;
  }, "node layout", 10_000).catch(() => null);
  check(F, "Dragging a node saves its position", Boolean(movedNode), movedNode ? `y ${Math.round(before.canvasY)} → ${Math.round(movedNode.canvasY)}` : "not saved");
  await shot(page, "flow6-01-canvas");

  await page.reload();
  await page.locator(".react-flow__node").nth(3).waitFor();
  await page.waitForTimeout(600);
  const nodesAfter = await page.locator(".react-flow__node").count();
  const edgesAfter = await page.locator(".react-flow__edge").count();
  check(F, "After refresh: deliverables and connections are all there", nodesAfter === 4 && edgesAfter === 2, `${nodesAfter} nodes, ${edgesAfter} edges`);

  // Files + review for one deliverable at a time.
  await openDeliverable(page, card.key, named(d, "Model"));
  await uploadRevision(page, path.join(MEDIA, "tower_v1.png"), true);
  await waitFor(async () => named(await detail(page, card.id), "Model").state === "NEEDS_REVIEW", "Model submitted");
  await openDeliverable(page, card.key, named(d, "Animation"));
  await uploadRevision(page, path.join(MEDIA, "hp_v1.mp4"), true);
  await waitFor(async () => named(await detail(page, card.id), "Animation").state === "NEEDS_REVIEW", "Animation submitted");
  d = await detail(page, card.id);
  check(F, "Card rolls up its deliverables (2 in review, 2 with files)", d.state === "NEEDS_REVIEW" && d.progress.inReview === 2 && d.progress.withFiles === 2, `${d.state} · ${JSON.stringify(d.progress)}`);

  await openDeliverable(page, card.key, named(d, "Model"));
  await page.getByRole("button", { name: "Approve" }).first().click();
  await page.getByRole("dialog", { name: /Approve Model V1/ }).getByRole("button", { name: "Approve" }).click();
  await waitFor(async () => named(await detail(page, card.id), "Model").state === "APPROVED", "Model approved");
  await openDeliverable(page, card.key, named(d, "Animation"));
  await page.getByRole("button", { name: "Request changes" }).first().click();
  const rc = page.getByRole("dialog", { name: /Request changes on Animation V1/ });
  await rc.getByPlaceholder(/Reduce the camera shake/).fill("Hold the pose longer before the hit");
  await rc.getByPlaceholder(/Reduce the camera shake/).press("Enter");
  await rc.getByRole("button", { name: /Request changes/ }).click();
  await waitFor(async () => named(await detail(page, card.id), "Animation").state === "CHANGES_REQUESTED", "changes requested");
  d = await detail(page, card.id);
  const modelV1 = named(d, "Model").approvedVersionId;
  check(F, "Reviewing one deliverable leaves the other untouched", named(d, "Model").state === "APPROVED" && named(d, "Animation").state === "CHANGES_REQUESTED" && named(d, "Animation").blockedBy.length === 0, `card: ${d.state}`);

  // Parent progress and unmet completion requirements.
  check(F, "Card can't complete yet and says why", !d.readiness.ready && d.readiness.blockers.some((x) => x.name === "Animation"), d.readiness.blockers.map((x) => `${x.name}: ${x.reason}`).join("; "));
  await openCard(page, card.key);
  const productionPanel = page.getByRole("region", { name: "Production", exact: true });
  await productionPanel.getByText("Before it can be completed:").waitFor();
  check(F, "Production panel lists what remains and disables Mark completed", (await productionPanel.getByRole("button", { name: "Mark completed" }).isDisabled()) && (await productionPanel.getByText("Animation", { exact: true }).count()) > 0);
  await shot(page, "flow6-02-not-ready");

  // Revise just the animation.
  await openDeliverable(page, card.key, named(d, "Animation"));
  await uploadRevision(page, path.join(MEDIA, "hp_v2.mp4"), true);
  await waitFor(async () => named(await detail(page, card.id), "Animation").versionCount === 2 && named(await detail(page, card.id), "Animation").state === "NEEDS_REVIEW", "Animation V2");
  d = await detail(page, card.id);
  const animV1 = d.versions.find((v) => v.deliverableId === named(d, "Animation").id && v.number === 1)!;
  check(F, "A new animation revision doesn't touch the model", named(d, "Model").versionCount === 1 && named(d, "Model").state === "APPROVED" && named(d, "Model").approvedVersionId === modelV1 && animV1.status === "CHANGES_REQUESTED", `Animation V1 kept as ${animV1.status}`);
  await page.getByRole("button", { name: "Approve" }).first().click();
  await page.getByRole("dialog", { name: /Approve Animation V2/ }).getByRole("button", { name: "Approve" }).click();
  d = await waitFor(async () => {
    const x = await detail(page, card.id);
    return x.readiness.ready ? x : null;
  }, "ready");
  check(F, "Optional deliverables don't block completion", d.readiness.ready && named(d, "Impact SFX").state !== "APPROVED" && named(d, "Concept").state !== "APPROVED");

  // Complete from the card, then publish by dragging on the production board.
  await openCard(page, card.key);
  await productionPanel.getByRole("button", { name: "Mark completed" }).click();
  await page.getByRole("dialog", { name: "Mark completed" }).getByRole("button", { name: "Confirm" }).click();
  d = await waitFor(async () => {
    const x = await detail(page, card.id);
    return x.productionStatus === "COMPLETED" ? x : null;
  }, "completed");
  const snap = Object.fromEntries(d.productionSnapshot.map((s) => [s.name, s.versionNumber]));
  check(F, "Completing records the approved revisions (Model V1, Animation V2)", snap.Model === 1 && snap.Animation === 2 && d.state === "APPROVED", JSON.stringify(snap));
  await page.keyboard.press("Escape");
  await page.goto(`${BASE}/nightfall/universal-tower-defense`);
  await page.getByRole("radio", { name: /Production/ }).click();
  const completedStage = page.locator("section[aria-label='Completed stage']:visible");
  await completedStage.locator("article", { hasText: title }).waitFor();
  await dragBetween(page, completedStage.locator("article", { hasText: title }), page.locator("section[aria-label='Published stage']:visible"));
  const pub = await waitFor(async () => ((await detail(page, card.id)).productionStatus === "PUBLISHED" ? true : null), "published", 10_000).catch(() => false);
  check(F, "Drag a ready card from Completed to Published", pub === true);

  // A new revision after publication is tracked as pending — never as approved or released.
  await openDeliverable(page, card.key, named(d, "Model"));
  await uploadRevision(page, path.join(MEDIA, "lobby_v1.png"));
  await waitProcessed(page, card.id, named(d, "Model").id, 2);
  d = await detail(page, card.id);
  const snapAfter = Object.fromEntries(d.productionSnapshot.map((s) => [s.name, s.versionNumber]));
  check(
    F,
    "Revision after publishing: stays Published, record unchanged, change shown as pending",
    d.productionStatus === "PUBLISHED" && d.pendingChanges && snapAfter.Model === 1 && named(d, "Model").state !== "APPROVED" && d.readiness.pendingChanges.length === 1 && d.readiness.pendingChanges[0]!.name === "Model",
    d.readiness.pendingChanges.map((p) => `${p.name}: ${p.detail}`).join("; "),
  );
  await page.goto(`${BASE}/nightfall/universal-tower-defense`);
  const pendingTile = page.locator("section[aria-label='Published stage']:visible article", { hasText: title });
  await pendingTile.waitFor();
  check(F, "Production board flags the pending change", (await pendingTile.getByText("Pending changes since published").count()) === 1);
  await shot(page, "flow6-03-pending-changes");
  await rpc(page, "board.setView", { projectId, view: "CATEGORY" });
  await context.close();
}

// ── Flow 7 ──────────────────────────────────────────────────────────────────
const SKULL_OBJ = ["o Skull", "v -0.5 0 -0.5", "v 0.5 0 -0.5", "v 0.5 0 0.5", "v -0.5 0 0.5", "v 0 0.9 0", "f 1 2 5", "f 2 3 5", "f 3 4 5", "f 4 1 5", "f 1 4 3 2", ""].join("\n");

async function flow7() {
  const F = "Flow 7 · Roblox & audio previews";
  const { context, page } = await session("giorgos@nightfall.gg");
  page.setDefaultTimeout(30_000);
  const { projectId } = await utdProject(page);
  const b = await fullBoard(page, projectId);
  const column = b.columns.find((c) => c.name === "Models") ?? b.columns[0]!;
  const card = (await rpc<{ id: string; key: string }>(page, "card.create", { projectId, columnId: column.id, title: `Roblox review ${RUN}` })).data!;
  const first = (await detail(page, card.id)).deliverables[0]!;
  await rpc(page, "deliverable.update", { deliverableId: first.id, name: "Tower model", assetType: "Model" });
  for (const [name, assetType] of [["Guardian rig", "Rig"], ["Slash animation", "Animation"], ["Burst VFX", "VFX"], ["Slash SFX", "Audio"], ["Ambience loop", "Audio"], ["Broken export", "Model"], ["Shop UI", "UI"]]) {
    await rpc(page, "deliverable.create", { cardId: card.id, name, assetType });
  }
  let d = await detail(page, card.id);

  // Upload every file through the real dialog + processing pipeline.
  const files: Array<[string, string | { name: string; mimeType: string; buffer: Buffer }]> = [
    ["Tower model", path.join(ROBLOX_MEDIA, "shrine_tower.rbxm")],
    ["Guardian rig", path.join(ROBLOX_MEDIA, "guardian_rig.rbxm")],
    ["Slash animation", path.join(ROBLOX_MEDIA, "cursed_slash_v1.rbxm")],
    ["Burst VFX", path.join(ROBLOX_MEDIA, "cursed_burst_vfx.rbxm")],
    ["Slash SFX", path.join(ROBLOX_MEDIA, "slash_sfx_v1.mp3")],
    ["Ambience loop", path.join(ROBLOX_MEDIA, "shrine_ambience.ogg")],
    ["Broken export", { name: "broken_export.rbxm", mimeType: "application/octet-stream", buffer: fs.readFileSync(path.join(ROBLOX_MEDIA, "guardian_rig.rbxm")).subarray(0, 300) }],
    ["Shop UI", { name: "shop_ui.rbxm", mimeType: "application/octet-stream", buffer: shopUiFile() }],
  ];
  const processed = new Map<string, AttachmentRow>();
  for (const [name, file] of files) {
    await openDeliverable(page, card.key, named(d, name));
    await uploadRevision(page, file);
    processed.set(name, (await waitProcessed(page, card.id, named(d, name).id, 1)).a);
  }
  const kinds = [...processed.entries()].map(([n, a]) => `${n}: ${a.kind}/${a.status}`).join(", ");
  check(F, "Uploads are classified and processed (.rbxm → ROBLOX, .mp3/.ogg → AUDIO)", ["Tower model", "Guardian rig", "Slash animation", "Burst VFX"].every((n) => processed.get(n)?.kind === "ROBLOX" && processed.get(n)?.status === "READY") && ["Slash SFX", "Ambience loop"].every((n) => processed.get(n)?.kind === "AUDIO" && processed.get(n)?.status === "READY"), kinds);
  d = await detail(page, card.id);

  // Model inspection.
  await openDeliverable(page, card.key, named(d, "Tower model"));
  await page.getByRole("tablist", { name: "Preview mode" }).waitFor();
  await page.waitForTimeout(2500);
  const canvas = page.locator("canvas").first();
  const spread = await pixelSpread(canvas);
  check(F, "Model renders in the in-app 3D viewer (not blank)", spread > 8, `pixel spread ${spread.toFixed(1)}`);
  await shot(page, "flow7-01-model");
  const missingChip = page.getByRole("button", { name: /1 missing resource/ });
  await missingChip.click();
  const details = page.getByRole("complementary", { name: "Preview details" });
  await details.getByText(/1 of \d+ needed resources missing/).waitFor();
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), details.getByRole("button", { name: "Upload file" }).first().click()]);
  await chooser.setFiles({ name: "skull_ornament.obj", mimeType: "text/plain", buffer: Buffer.from(SKULL_OBJ) });
  await details.getByText(/All \d+ resources provided/).waitFor({ timeout: 30_000 });
  check(F, "Missing mesh resolved with a user-provided file (project-scoped)", (await missingChip.count()) === 0);
  await page.waitForTimeout(800);
  await shot(page, "flow7-02-resource-provided");
  await details.locator("li", { hasText: "Using skull_ornament.obj" }).getByRole("button", { name: "Remove" }).click();
  await page.getByRole("button", { name: /1 missing resource/ }).waitFor();
  check(F, "Removing the resource puts the model back to “missing” (original file untouched)", true);
  await details.getByRole("tab", { name: "explorer" }).click();
  await details.getByLabel("Find in hierarchy").fill("Skull");
  check(F, "Explorer lists the file's instances", (await details.getByText(/Skull/).count()) > 0);

  // Animation playback on the rig from the same card.
  await openDeliverable(page, card.key, named(d, "Slash animation"));
  await page.getByRole("tab", { name: "Animation", selected: true }).waitFor();
  await page.getByText(/^Rig: /).waitFor();
  const rigLabel = await page.getByText(/^Rig: /).textContent();
  check(F, "Animation resolves the rig uploaded to the same card", Boolean(rigLabel?.includes("Guardian rig")), rigLabel ?? "");
  const position = page.getByLabel("Animation position");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForTimeout(700);
  const t1 = Number(await position.inputValue());
  await page.waitForTimeout(300);
  const t2 = Number(await position.inputValue());
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  check(F, "Animation plays (timeline advances)", t2 > t1 && t1 > 0, `${t1.toFixed(2)}s → ${t2.toFixed(2)}s`);
  const animCanvas = page.locator("canvas").first();
  const scrubTo = async (fraction: number) => {
    await animCanvas.scrollIntoViewIfNeeded();
    const track = (await position.boundingBox())!;
    await page.mouse.click(track.x + 8 + (track.width - 16) * fraction, track.y + track.height / 2);
    await page.waitForTimeout(400);
    return Number(await position.inputValue());
  };
  await scrubTo(0);
  const poseA = await animCanvas.screenshot();
  const scrubbed = await scrubTo(0.375);
  const poseB = await animCanvas.screenshot();
  const poseDiff = await pixelDiff(poseA, poseB);
  check(F, "Scrubbing changes the rig's pose", poseDiff > 0.5, `mean pixel change ${poseDiff.toFixed(2)}`);
  await shot(page, "flow7-03-animation");
  await page.getByPlaceholder("Feedback at this moment…").fill("Arc of the blade dips here.");
  await page.getByRole("button", { name: "Add feedback" }).click();
  const animNote = await waitFor(async () => (await detail(page, card.id)).comments.find((c) => c.body.includes("Arc of the blade")), "animation feedback");
  check(F, "Timestamped feedback on the animation", animNote.deliverableId === named(d, "Slash animation").id && Math.abs((animNote.annotation?.timestampMs ?? -1) - scrubbed * 1000) < 60, `at ${animNote.annotation?.timestampMs} ms (playhead ${Math.round(scrubbed * 1000)} ms)`);

  // Effects emission.
  await openDeliverable(page, card.key, named(d, "Burst VFX"));
  await page.getByRole("tab", { name: "Effects", selected: true }).waitFor();
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: "Emit" }).click();
  await page.waitForTimeout(500);
  const stats = await page.getByText(/\d+ effects? · \d+ particles/).textContent();
  const particles = Number(/· (\d+) particles/.exec(stats ?? "")?.[1] ?? 0);
  const vfxSpread = await pixelSpread(page.locator("canvas").first());
  check(F, "Effects emit particles in the viewer", particles > 0 && vfxSpread > 8, `${stats} · pixel spread ${vfxSpread.toFixed(1)}`);
  await shot(page, "flow7-04-effects");

  // Broken file: explained, original kept.
  await openDeliverable(page, card.key, named(d, "Broken export"));
  const broken = processed.get("Broken export")!;
  const brokenReason = broken.status === "FAILED" ? (broken.error ?? "This upload failed.") : String((broken.meta as { previewError?: string } | null)?.previewError ?? "");
  await page.getByText(brokenReason).first().waitFor();
  check(F, "An unreadable Roblox file shows an actionable error, not a fake preview", brokenReason.length > 0 && (await page.getByRole("tablist", { name: "Preview mode" }).count()) === 0, `${broken.status}: ${brokenReason}`);

  // Audio review.
  await openDeliverable(page, card.key, named(d, "Slash SFX"));
  const player = page.locator("[aria-label^='Audio player']");
  await player.waitFor();
  await player.getByText(/MP3/).waitFor();
  const audio = player.locator("audio");
  const audioState = (el: HTMLAudioElement) => ({ t: el.currentTime, paused: el.paused, ready: el.readyState, error: el.error?.message ?? null, src: el.currentSrc });
  const whenPlaying = (locator: ReturnType<Page["locator"]>) =>
    waitFor(async () => {
      const st = await locator.evaluate(audioState);
      return st.t > 0.1 && !st.paused ? st : null;
    }, "audio playback", 8_000).catch(() => locator.evaluate(audioState));
  await player.getByRole("button", { name: "Play", exact: true }).click();
  const playing = await whenPlaying(audio);
  check(F, "MP3 plays in the in-app player", playing.t > 0.1 && !playing.paused, `t=${playing.t.toFixed(2)}s ready=${playing.ready} ${playing.error ?? ""}`);
  await player.getByRole("button", { name: "Pause", exact: true }).click();
  const wave = player.locator("canvas").first();
  const wb = (await wave.boundingBox())!;
  await page.mouse.click(wb.x + wb.width * 0.5, wb.y + wb.height / 2);
  await page.waitForTimeout(300);
  const seeked = await audio.evaluate((el: HTMLAudioElement) => ({ t: el.currentTime, d: el.duration }));
  check(F, "Seeking by clicking the waveform", Math.abs(seeked.t - seeked.d / 2) < 0.15, `${seeked.t.toFixed(2)} of ${seeked.d.toFixed(2)}s`);
  await player.getByRole("button", { name: "Loop" }).click();
  await player.getByRole("button", { name: "Mute" }).click();
  const toggles = await audio.evaluate((el: HTMLAudioElement) => ({ loop: el.loop, muted: el.muted }));
  await player.getByRole("button", { name: "Unmute" }).click();
  check(F, "Loop and mute controls", toggles.loop && toggles.muted);
  await page.getByPlaceholder("Feedback at this moment…").fill("Tail is too long here.");
  await page.getByRole("button", { name: "Add feedback" }).click();
  const audioNote = await waitFor(async () => (await detail(page, card.id)).comments.find((c) => c.body.includes("Tail is too long")), "audio feedback");
  check(F, "Timestamped feedback on audio", Math.abs((audioNote.annotation?.timestampMs ?? -1) - seeked.t * 1000) < 150, `at ${audioNote.annotation?.timestampMs} ms`);
  await player.getByRole("button", { name: /^Feedback at / }).first().waitFor();
  await shot(page, "flow7-05-audio");

  // New revision; earlier revision and its feedback stay reachable.
  await uploadRevision(page, path.join(ROBLOX_MEDIA, "slash_sfx_v2.mp3"));
  await waitProcessed(page, card.id, named(d, "Slash SFX").id, 2);
  await player.getByText("slash_sfx_v2.mp3").waitFor();
  await page.getByRole("button", { name: "Previous revision" }).click();
  await player.getByText("slash_sfx_v1.mp3").waitFor();
  check(F, "Revision selection: V1 and its timestamped feedback are still there", (await player.getByRole("button", { name: /^Feedback at / }).count()) > 0);

  // Playback stops when switching deliverables and when closing.
  await player.getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Next deliverable" }).click();
  await page.locator("[aria-label^='Audio player: shrine_ambience']").waitFor();
  const anyPlaying = () => page.evaluate(() => [...document.querySelectorAll("audio")].some((a) => !a.paused));
  check(F, "Switching deliverables stops the previous audio", !(await anyPlaying()));
  const ogg = page.locator("[aria-label^='Audio player: shrine_ambience']");
  await ogg.getByRole("button", { name: "Play", exact: true }).click();
  const oggState = await whenPlaying(ogg.locator("audio"));
  check(F, "OGG plays (original, or the AAC compatibility copy if the browser can't decode it)", oggState.t > 0.1 && !oggState.paused, `t=${oggState.t.toFixed(2)}s via ${oggState.src.includes(".m4a") ? "AAC copy" : "original"}`);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  check(F, "Closing the card stops playback", !(await anyPlaying()) && !new URL(page.url()).searchParams.get("card"));

  // 2D UI: a ScreenGui drawn in the UI tab.
  await openDeliverable(page, card.key, named(d, "Shop UI"));
  await page.getByRole("tab", { name: "UI", selected: true }).waitFor();
  const uiStage = page.getByRole("img", { name: /Roblox UI preview/ });
  await uiStage.waitFor();
  await page.waitForTimeout(1500);
  const uiNode = (name: string) => uiStage.locator(`[data-ui-node][title^="${name} ("]`);
  check(F, "A UI file opens on the UI tab and draws its elements", (await uiStage.locator("[data-ui-node]").count()) >= 4 && (await uiNode("Title").innerText()).includes("SHRINE SHOP"));
  const titleSize = await uiNode("Title").locator("span").first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  check(F, "TextScaled text is fitted to its box", titleSize > 30 && titleSize <= 100, `${titleSize}px`);
  await uiNode("Sigil").locator("canvas").waitFor();
  const sigilSpread = await pixelSpread(uiNode("Sigil").locator("canvas"));
  check(F, "ImageLabels draw the project's texture", sigilSpread > 8, `pixel spread ${sigilSpread.toFixed(1)}`);
  const desktopWidth = await uiNode("ShopPanel").evaluate((el) => (el as HTMLElement).offsetWidth);
  await pick(page, "Screen size", "Phone 844×390");
  await page.waitForTimeout(800);
  const phoneWidth = await uiNode("ShopPanel").evaluate((el) => (el as HTMLElement).offsetWidth);
  check(F, "Switching to a phone screen lays the UI out again", desktopWidth === 960 && phoneWidth === 422, `${desktopWidth}px → ${phoneWidth}px`);
  await uiNode("BuyButton").click({ position: { x: 4, y: 4 } });
  await page.getByRole("button", { name: "Explorer & details" }).click();
  const uiDetails = page.getByRole("complementary", { name: "Preview details" });
  await uiDetails.getByRole("tab", { name: "properties" }).click();
  check(F, "Clicking a UI element inspects it", (await uiDetails.innerText()).includes("BuyButton"));
  await shot(page, "flow7-06-ui");
  await context.close();
}

/** A small shop UI made with Forge's own writer (no third-party assets). */
function shopUiFile(): Buffer {
  const I = (className: string, props: WriteInstance["props"], children: WriteInstance[] = []): WriteInstance => ({ className, props, children });
  const file = writeBinaryModel([
    I("ScreenGui", { Name: R.str("ShopGui"), IgnoreGuiInset: R.bool(false) }, [
      I("Frame", { Name: R.str("ShopPanel"), Size: R.udim2(0.5, 0, 0.6, 0), Position: R.udim2(0.5, 0, 0.5, 0), AnchorPoint: R.v2(0.5, 0.5), BackgroundColor3: R.color(0.12, 0.1, 0.2) }, [
        I("UICorner", { CornerRadius: R.udim(0, 16) }),
        I("UIStroke", { Thickness: R.f32(3), Color: R.color(1, 0.8, 0.3) }),
        I("UIPadding", { PaddingTop: R.udim(0, 16), PaddingRight: R.udim(0, 16), PaddingBottom: R.udim(0, 16), PaddingLeft: R.udim(0, 16) }),
        I("UIListLayout", { Padding: R.udim(0, 12), HorizontalAlignment: R.enum(0), SortOrder: R.enum(2) }),
        I("TextLabel", { Name: R.str("Title"), LayoutOrder: R.int(1), Size: R.udim2(1, 0, 0, 80), Text: R.str("SHRINE SHOP"), TextScaled: R.bool(true), FontFace: R.font("LuckiestGuy"), TextColor3: R.color(1, 1, 1), BackgroundTransparency: R.f32(1) }),
        I("ImageLabel", { Name: R.str("Sigil"), LayoutOrder: R.int(2), Size: R.udim2(0, 160, 0, 160), Image: R.str(RESOURCE_IDS.sigil), ScaleType: R.enum(3), BackgroundTransparency: R.f32(1) }),
        I("TextButton", { Name: R.str("BuyButton"), LayoutOrder: R.int(3), Size: R.udim2(0.6, 0, 0, 60), Text: R.str("BUY · 250"), TextScaled: R.bool(true), FontFace: R.font("GothamSSm", 700), BackgroundColor3: R.color(0.2, 0.7, 0.3) }, [
          I("UICorner", { CornerRadius: R.udim(0.5, 0) }),
        ]),
      ]),
    ]),
  ]);
  return Buffer.from(file);
}

// ── Flow 8 ──────────────────────────────────────────────────────────────────
async function flow8() {
  const F = "Flow 8 · Navigation";
  const { context, page } = await session("giorgos@nightfall.gg");
  const { projectId } = await utdProject(page);
  const kit = (await fullBoard(page, projectId)).cards.find((c) => c.title === "Shrine Guardian Boss Kit");
  if (!kit) throw new Error("Demo card “Shrine Guardian Boss Kit” not found — run npm run db:reset first.");
  const d = await detail(page, kit.id);
  await openCard(page, kit.key);
  await page.locator("section#deliverables").waitFor();
  await page.getByRole("radio", { name: /Canvas/ }).click();
  await page.locator(".react-flow__node").first().waitFor();
  await page.waitForTimeout(800);
  await page.locator(".react-flow__controls-zoomout").click();
  await page.locator(".react-flow__controls-zoomout").click();
  await page.waitForTimeout(700);
  const viewport = () => page.locator(".react-flow__viewport").evaluate((el) => (el as HTMLElement).style.transform);
  const saved = await viewport();

  const anim = named(d, "Cursed Slash animation");
  await dblclickCenter(page, page.locator(`.react-flow__node[data-id="${anim.id}"]`));
  await page.getByRole("navigation", { name: "Breadcrumb" }).waitFor();
  check(F, "Double-clicking a canvas node opens the deliverable (deep-linkable)", new URL(page.url()).searchParams.get("d") === String(anim.number));
  await page.getByRole("button", { name: "Previous revision" }).click();
  const earlier = page.getByText(/You're looking at/);
  const onV1 = Boolean((await earlier.textContent())?.includes("V1"));
  await page.getByRole("button", { name: "Next deliverable" }).click();
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Previous deliverable" }).click();
  await page.waitForTimeout(400);
  check(F, "Returning to a deliverable keeps the revision you were looking at", onV1 && Boolean((await earlier.textContent().catch(() => ""))?.includes("V1")) && new URL(page.url()).searchParams.get("d") === String(anim.number));

  await page.getByRole("button", { name: "All deliverables" }).click();
  await page.locator(".react-flow__node").first().waitFor();
  await page.waitForTimeout(500);
  check(F, "Back to the overview lands on the same canvas position", (await viewport()) === saved, saved);
  await shot(page, "flow8-01-back-to-canvas");

  await dblclickCenter(page, page.locator(`.react-flow__node[data-id="${anim.id}"]`));
  await page.getByRole("navigation", { name: "Breadcrumb" }).waitFor();
  await page.keyboard.press("Escape");
  await page.locator("section#deliverables").waitFor();
  check(F, "Esc steps back from a deliverable to the card", !new URL(page.url()).searchParams.get("d"));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  check(F, "Esc again closes the card", !new URL(page.url()).searchParams.get("card"));

  const sfx = named(d, "Slash SFX");
  await openDeliverable(page, kit.key, sfx);
  const crumb = await page.getByRole("navigation", { name: "Breadcrumb" }).innerText();
  check(F, "A shared deliverable link opens straight to it", crumb.includes("Slash SFX") && crumb.includes("Shrine Guardian Boss Kit"), crumb.replace(/\s+/g, " "));
  await context.close();
}

// ── Flow 9 ──────────────────────────────────────────────────────────────────
async function flow9() {
  const F = "Flow 9 · Permissions & live sync";
  const manager = await session("giorgos@nightfall.gg");
  const { studioId, projectId } = await utdProject(manager.page);
  const b = await fullBoard(manager.page, projectId);
  const kit = b.cards.find((c) => c.title === "Shrine Guardian Boss Kit") ?? b.cards[0]!;
  const kd = await detail(manager.page, kit.id);
  const del = kd.deliverables[0]!;
  const robloxFile = kd.attachments.find((a) => a.kind === "ROBLOX");

  const outsider = await session("omar@emberlight.dev");
  const attempts: Array<[string, unknown]> = [
    ["deliverable.create", { cardId: kit.id, name: "sneaky" }],
    ["deliverable.update", { deliverableId: del.id, name: "sneaky" }],
    ["deliverable.layout", { cardId: kit.id, positions: [{ id: del.id, x: 0, y: 0 }] }],
    ["deliverable.link", { cardId: kit.id, fromId: del.id, toId: kd.deliverables[1]?.id ?? del.id, type: "ASSOCIATION" }],
    ["review.approve", { deliverableId: del.id }],
    ["card.setProduction", { cardId: kit.id, status: "PUBLISHED" }],
    ["board.setView", { projectId, view: "PRODUCTION" }],
    ["roblox.resources", { cardId: kit.id, contentIds: [] }],
    ["roblox.rigs", { cardId: kit.id }],
    ["comment.create", { cardId: kit.id, deliverableId: del.id, body: "sneaky" }],
    ...(robloxFile ? ([["roblox.previewConfig", { attachmentId: robloxFile.id, rigAttachmentId: null }]] as Array<[string, unknown]>) : []),
  ];
  const leaks: string[] = [];
  for (const [name, input] of attempts) {
    const res = await rpc(outsider.page, name, input);
    if (res.status !== 404) leaks.push(`${name} → ${res.status}`);
  }
  check(F, `Another studio gets 404 for deliverables, links, stages and Roblox previews (${attempts.length} calls)`, leaks.length === 0, leaks.join(", "));

  const viewer = await session("ruby@nightfall.gg");
  const canRead = await rpc<Detail>(viewer.page, "card.get", { cardId: kit.id });
  const vCreate = await rpc(viewer.page, "deliverable.create", { cardId: kit.id, name: "viewer attempt" });
  const vLayout = await rpc(viewer.page, "deliverable.layout", { cardId: kit.id, positions: [{ id: del.id, x: 1, y: 1 }] });
  const vStage = await rpc(viewer.page, "card.setProduction", { cardId: kit.id, status: "COMPLETED" });
  check(F, "Viewer can see deliverables but not change them or the stage", canRead.status === 200 && (canRead.data?.deliverables.length ?? 0) > 0 && [vCreate, vLayout, vStage].every((r) => r.status === 403), `${vCreate.status}/${vLayout.status}/${vStage.status}`);
  if (robloxFile) {
    const vRig = await rpc(viewer.page, "roblox.previewConfig", { attachmentId: robloxFile.id, rigAttachmentId: null });
    check(F, "Viewer can't change a preview's rig", vRig.status === 403, `${vRig.status}`);
  }

  const members = (await rpc<Array<{ id: string; username: string; displayName: string }>>(manager.page, "member.list", { studioId })).data!;
  const kenjiId = members.find((m) => /kenji/i.test(m.username) || /kenji/i.test(m.displayName))!.id;
  const kenji = await session("kenji@nightfall.gg");
  const own = (await rpc<{ id: string; key: string }>(manager.page, "card.create", { projectId, columnId: b.columns[0]!.id, title: `Kenji's task ${RUN}`, assigneeIds: [kenjiId] })).data!;
  const kAdd = await rpc(kenji.page, "deliverable.create", { cardId: own.id, name: "Kenji's extra piece" });
  const kPublish = await rpc(kenji.page, "card.setProduction", { cardId: own.id, status: "PUBLISHED" });
  const kOther = await rpc(kenji.page, "deliverable.update", { deliverableId: del.id, name: "hijacked" });
  check(F, "Member can add deliverables to their own card", kAdd.status === 200, `${kAdd.status}`);
  check(F, "Member can't publish (managers only) or edit others' deliverables", (kPublish.status === 403 || kPublish.status === 409) && kOther.status === 403, `publish ${kPublish.status} ${kPublish.error?.message ?? ""} / other ${kOther.status}`);

  // Live sync across sessions.
  const james = await session("james@nightfall.gg");
  const managerView = (await fullBoard(manager.page, projectId)).prefs.view;
  await rpc(james.page, "board.setView", { projectId, view: managerView === "PRODUCTION" ? "CATEGORY" : "PRODUCTION" });
  const managerViewAfter = (await fullBoard(manager.page, projectId)).prefs.view;
  await rpc(james.page, "board.setView", { projectId, view: "PRODUCTION" });
  check(F, "Board view choice is per user", managerView === managerViewAfter, `manager stays on ${managerView}`);
  await james.page.goto(`${BASE}/nightfall/universal-tower-defense`);
  await james.page.locator("section[aria-label='To-do stage']:visible").waitFor();
  await james.page.waitForTimeout(1500);
  const syncTitle = `Live sync ${RUN}`;
  const synced = (await rpc<{ id: string; key: string }>(manager.page, "card.create", { projectId, columnId: b.columns[0]!.id, title: syncTitle })).data!;
  const appeared = await james.page
    .locator("section[aria-label='To-do stage']:visible article", { hasText: syncTitle })
    .waitFor({ timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  check(F, "A card created elsewhere appears in another user's production view", appeared);

  await openCard(james.page, synced.key);
  await james.page.waitForTimeout(1000);
  await rpc(manager.page, "deliverable.create", { cardId: synced.id, name: "Added remotely" });
  // James stays on what he was looking at; the card now shows a second deliverable to navigate to.
  const arrived = await james.page
    .getByText("Added remotely")
    .first()
    .waitFor({ timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  const crumb = await james.page.getByRole("navigation", { name: "Breadcrumb" }).count();
  check(F, "A deliverable added elsewhere shows up in an open card (without pulling the viewer away)", arrived && crumb === 1);
  await shot(james.page, "flow9-01-live-deliverable");
  await rpc(james.page, "board.setView", { projectId, view: "CATEGORY" });
  for (const s of [manager, outsider, viewer, kenji, james]) await s.context.close();
}

// ── Flow 10 ─────────────────────────────────────────────────────────────────
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

/** The option labels of a (Radix) select, read by opening it. */
async function optionsOf(page: Page, label: string) {
  await page.getByRole("combobox", { name: label }).click();
  const names = await page.getByRole("option").allInnerTexts();
  await page.keyboard.press("Escape");
  return names.map((n) => n.trim());
}

/**
 * Your own Roblox files (opt-in: VERIFY_ASSETS=<folder>). Uploads every .rbxm/.rbxmx/.rbxl/.rbxlx
 * in the folder to a new card, lets the preview fetch what the files reference, and reports per
 * animation which rig it plays on, the preview's own warnings, and how much the picture changes
 * across the clip. Screenshots: .verify/flow10-*.png.
 */
async function flow10() {
  const F = "Flow 10 · Your Roblox files";
  const dir = process.env.VERIFY_ASSETS;
  if (!dir) {
    console.log(`- [${F}] skipped — set VERIFY_ASSETS to a folder of .rbxm/.rbxl files`);
    return;
  }
  const files = fs.readdirSync(dir).filter((f) => /\.(rbxm|rbxmx|rbxl|rbxlx)$/i.test(f));
  const { context, page } = await session("giorgos@nightfall.gg");
  page.setDefaultTimeout(60_000);
  const { projectId } = await utdProject(page);
  const b = await fullBoard(page, projectId);
  const column = b.columns.find((c) => c.name === "Models") ?? b.columns[0]!;
  const card = (await rpc<{ id: string; key: string }>(page, "card.create", { projectId, columnId: column.id, title: `Asset check ${RUN}` })).data!;
  const first = (await detail(page, card.id)).deliverables[0]!;
  const nameOf = (file: string) => file.replace(/\.[^.]+$/, "").slice(0, 60);
  for (const [i, file] of files.entries()) {
    if (i === 0) await rpc(page, "deliverable.update", { deliverableId: first.id, name: nameOf(file) });
    else await rpc(page, "deliverable.create", { cardId: card.id, name: nameOf(file) });
  }
  let d = await detail(page, card.id);
  for (const file of files) {
    await (files.length > 1 ? openDeliverable(page, card.key, named(d, nameOf(file))) : openCard(page, card.key)); // one file: the card is its page
    await uploadRevision(page, path.join(dir, file));
    const { a } = await waitProcessed(page, card.id, named(d, nameOf(file)).id, 1, 300_000);
    const meta = (a.meta ?? {}) as { previewError?: string; rigCount?: number; animationCount?: number; instanceCount?: number };
    check(F, `${file}: read and processed`, a.status === "READY" && !meta.previewError, `${meta.instanceCount} instances, ${meta.rigCount} rigs, ${meta.animationCount} animations${meta.previewError ? ` — ${meta.previewError}` : ""}`);
  }
  d = await detail(page, card.id);

  for (const file of files) {
    await (files.length > 1 ? openDeliverable(page, card.key, named(d, nameOf(file))) : openCard(page, card.key)); // one file: the card is its page
    const tabs = page.getByRole("tablist", { name: "Preview mode" });
    await tabs.waitFor();
    // Referenced meshes/textures are fetched from Roblox once per studio; wait for that to finish.
    await page.waitForTimeout(2500);
    await waitFor(async () => (await page.getByText(/Fetching \d+ from Roblox/).count()) === 0, "Roblox downloads", 240_000);
    await page.waitForTimeout(2500);
    const missing = await page.getByRole("button", { name: /missing resources?/ }).textContent().catch(() => null);
    await shot(page, `flow10-${slug(file)}-model`);
    console.log(`  · ${file}: ${missing ?? "all referenced meshes/textures available"}`);
    if (!(await tabs.getByRole("tab", { name: "Animation" }).count())) continue;
    await tabs.getByRole("tab", { name: "Animation" }).click();
    await page.getByLabel("Animation position").waitFor();
    const clips = (await page.getByRole("combobox", { name: "Animation" }).count()) ? await optionsOf(page, "Animation") : [null];
    for (const [index, clipName] of clips.slice(0, 12).entries()) {
      if (clipName) {
        await page.getByRole("combobox", { name: "Animation" }).click();
        await page.getByRole("option").nth(index).click();
      }
      await page.waitForTimeout(2000);
      const canvas = page.locator("canvas").first();
      const position = page.getByLabel("Animation position");
      const length = Number(await position.getAttribute("max"));
      const at = async (fraction: number) => {
        await position.evaluate((el: HTMLInputElement, v: number) => {
          const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
          set.call(el, String(v));
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }, length * fraction);
        await page.waitForTimeout(350);
        return canvas.screenshot();
      };
      const start = await at(0);
      const quarter = await at(0.25);
      const mid = await at(0.5);
      const change = Math.max(await pixelDiff(start, quarter), await pixelDiff(start, mid));
      const rig = (await page.getByText(/^Rig: /).textContent().catch(() => null)) ?? "no rig";
      const warnings = (await page.locator("p.text-state-review").allInnerTexts()).join(" | ");
      await shot(page, `flow10-${slug(file)}-${slug(clipName ?? "clip")}`);
      check(F, `${file} › ${clipName ?? "animation"}`, true, `${rig}; picture change ${change.toFixed(2)}${warnings ? `; ${warnings}` : ""}`);
    }
  }
  await context.close();
}

// ── Flow 11 ─────────────────────────────────────────────────────────────────
/** WCAG contrast ratio of two CSS rgb() colours. */
function contrast(a: string, b: string) {
  const lum = (css: string) => {
    const [r, g, bl] = (css.match(/[\d.]+/g) ?? []).slice(0, 3).map((v) => Number(v) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

async function flow11() {
  const F = "Flow 11 · Select menus (keyboard, focus, contrast)";
  const { context, page } = await session("giorgos@nightfall.gg");
  page.setDefaultTimeout(30_000);
  const { projectId } = await utdProject(page);
  const b = await fullBoard(page, projectId);
  const column = b.columns.find((c) => c.name === "Animations") ?? b.columns[0]!;
  const card = (await rpc<{ id: string; key: string }>(page, "card.create", { projectId, columnId: column.id, title: `Menus ${RUN}` })).data!;
  const first = (await detail(page, card.id)).deliverables[0]!;
  await rpc(page, "deliverable.update", { deliverableId: first.id, name: "Rig", assetType: "Rig" });
  await rpc(page, "deliverable.create", { cardId: card.id, name: "Slash", assetType: "Animation" });
  let d = await detail(page, card.id);
  for (const [name, file] of [["Rig", "guardian_rig.rbxm"], ["Slash", "cursed_slash_v1.rbxm"]] as const) {
    await openDeliverable(page, card.key, named(d, name));
    await uploadRevision(page, path.join(ROBLOX_MEDIA, file));
    await waitProcessed(page, card.id, named(d, name).id, 1);
  }
  d = await detail(page, card.id);

  for (const theme of ["dark", "light"] as const) {
    await openDeliverable(page, card.key, named(d, "Slash"));
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.getByLabel("Animation position").waitFor();

    // Keyboard: Tab onto the speed select, open it, move, choose; focus comes back to it.
    await page.getByRole("button", { name: /^(Looping|Play once)$/ }).focus();
    await page.keyboard.press("Tab");
    const speed = page.getByRole("combobox", { name: "Playback speed" });
    const focus = await speed.evaluate((el) => ({ focused: document.activeElement === el, visible: el.matches(":focus-visible"), ring: getComputedStyle(el).boxShadow }));
    // Tailwind's ring is a 2px box-shadow in the theme's --ring colour (the other shadows in the list are transparent).
    const ring = /(rgba?\((?!0, 0, 0, 0\))[^)]*\)) 0px 0px 0px 2px/.exec(focus.ring)?.[1];
    check(F, `${theme}: the speed select takes keyboard focus with a visible ring`, focus.focused && focus.visible && Boolean(ring), ring ?? focus.ring.slice(0, 80));
    await page.keyboard.press("Enter");
    const list = page.getByRole("listbox");
    await list.waitFor();
    // The current option is focused first; then the arrow keys move from it.
    await list.locator("[data-highlighted]").waitFor();
    const initial = await list.locator("[data-highlighted]").innerText();
    await page.keyboard.press("ArrowDown");
    const highlighted = await waitFor(async () => {
      const now = await list.locator("[data-highlighted]").innerText();
      return now !== initial ? now : null;
    }, "the highlight to move");
    await page.keyboard.press("Enter");
    await list.waitFor({ state: "detached" });
    const chosen = (await speed.innerText()).trim();
    const back = await waitFor(() => speed.evaluate((el) => document.activeElement === el), "focus to return to the select", 3000).catch(() => false);
    check(F, `${theme}: arrow keys + Enter choose an option, focus returns`, chosen === highlighted.trim() && chosen === "1.5×" && back, `chose ${chosen}`);
    // Space opens it too, Escape closes without changing anything.
    await page.keyboard.press(" ");
    await list.waitFor();
    await page.keyboard.press("Escape");
    await list.waitFor({ state: "detached" });
    check(F, `${theme}: Space opens, Escape closes and keeps the value (and doesn't toggle playback)`, (await speed.innerText()).trim() === "1.5×" && (await page.getByRole("button", { name: "Play", exact: true }).count()) === 1);

    // Contrast of every state, and the menu stays on screen next to its trigger.
    // (An open menu hides the rest of the page from assistive tech, so measure the trigger first.)
    const triggerBox = (await page.getByRole("combobox", { name: "Background" }).boundingBox())!;
    await page.getByRole("combobox", { name: "Background" }).click();
    await list.locator("[data-highlighted]").waitFor();
    await page.keyboard.press("ArrowDown");
    // Let the opening animation finish, then judge what is actually drawn (opacity included).
    await list.evaluate((el) => Promise.all(el.closest("[data-radix-popper-content-wrapper]")!.getAnimations({ subtree: true }).map((a) => a.finished)));
    const colours = await list.evaluate((el) => {
      const menu = el.closest("[data-radix-popper-content-wrapper]")?.firstElementChild ?? el;
      const bg = getComputedStyle(menu).backgroundColor;
      let opacity = 1;
      for (let n: Element | null = el; n; n = n.parentElement) opacity *= Number(getComputedStyle(n).opacity);
      return {
        bg,
        opacity,
        items: [...el.querySelectorAll("[role=option]")].map((o) => {
          const s = getComputedStyle(o);
          return { text: o.textContent, color: s.color, bg: s.backgroundColor === "rgba(0, 0, 0, 0)" ? bg : s.backgroundColor, state: o.hasAttribute("data-highlighted") ? "highlighted" : o.getAttribute("data-state") === "checked" ? "selected" : "normal" };
        }),
      };
    });
    const worst = Math.min(...colours.items.map((i) => contrast(i.color, i.bg)));
    check(F, `${theme}: every option is readable (normal, highlighted, selected)`, worst >= 4.5 && colours.opacity === 1, `lowest contrast ${worst.toFixed(1)}:1, opacity ${colours.opacity} · ${colours.items.map((i) => `${i.text} ${i.state}`).join(", ")}`);
    const menuBox = (await list.boundingBox())!;
    const viewport = page.viewportSize()!;
    check(F, `${theme}: the menu opens beside its trigger, inside the window`, menuBox.y >= triggerBox.y + triggerBox.height - 1 && menuBox.x + menuBox.width <= viewport.width && menuBox.y + menuBox.height <= viewport.height, `menu at ${Math.round(menuBox.x)},${Math.round(menuBox.y)}`);
    await shot(page, `flow11-menu-${theme}`);
    await page.keyboard.press("Escape");
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));

  // Fullscreen: the menu renders inside the fullscreen viewer, so it is still visible.
  await page.getByRole("button", { name: "Fullscreen" }).click();
  const isFull = await page.waitForFunction(() => Boolean(document.fullscreenElement), null, { timeout: 5000 }).then(() => true).catch(() => false);
  if (isFull) {
    await page.getByRole("combobox", { name: "Lighting" }).click();
    const inside = await page.getByRole("listbox").evaluate((el) => Boolean(document.fullscreenElement?.contains(el)));
    check(F, "In fullscreen the menu is drawn inside the fullscreen viewer", inside);
    await shot(page, "flow11-menu-fullscreen");
    await page.keyboard.press("Escape");
    await page.evaluate(() => document.exitFullscreen());
  } else {
    console.log(`- [${F}] fullscreen not available in this browser session — skipped that check`);
  }
  await context.close();
}

// ── Flow 12 ─────────────────────────────────────────────────────────────────
interface CoverState {
  coverMode: string;
  cover: { attachmentId: string; kind: string; thumbUrl: string | null } | null;
  versions: unknown[];
  state: string;
  attachments: Array<{ id: string; purpose: string; filename: string; kind: string }>;
}

async function flow12() {
  const F = "Flow 12 · Card covers";
  const { context, page } = await session("giorgos@nightfall.gg");
  const lena = await session("lena@nightfall.gg");
  const ruby = await session("ruby@nightfall.gg");
  page.setDefaultTimeout(30_000);
  const { projectId } = await utdProject(page);
  const b = await fullBoard(page, projectId);
  const column = b.columns.find((c) => c.name === "UI") ?? b.columns[0]!;
  const title = `Cover ${RUN}`;
  const card = (await rpc<{ id: string; key: string }>(page, "card.create", { projectId, columnId: column.id, title })).data!;
  await rpc(page, "card.update", { cardId: card.id, displayMode: "VISUAL" });
  const coverOf = async () => (await rpc<CoverState>(page, "card.get", { cardId: card.id })).data!;
  const tile = (p: Page) => p.locator("article", { hasText: title }).first();

  // V1 of the deliverable: the automatic cover.
  let d = await detail(page, card.id);
  await openCard(page, card.key); // one deliverable: the card is its page
  await uploadRevision(page, path.join(MEDIA, "battlepass_v1.png"));
  await waitProcessed(page, card.id, d.deliverables[0]!.id, 1);
  const v1 = await coverOf();
  check(F, "Without a choice, the cover follows the current revision", v1.coverMode === "AUTO" && Boolean(v1.cover));

  // Another member watches the board: covers update live.
  await lena.page.goto(`${BASE}/nightfall/universal-tower-defense`);
  await tile(lena.page).waitFor();
  const lenaSrcBefore = await tile(lena.page).locator("img").first().getAttribute("src");

  // Upload a dedicated cover from the card's sidebar.
  await openCard(page, card.key);
  const sidebar = page.getByRole("complementary", { name: "Card details" });
  await sidebar.getByText(/^Automatic/).waitFor();
  await sidebar.getByRole("button", { name: "Change cover" }).click();
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("menuitem", { name: /Upload image or video/ }).click()]);
  await chooser.setFiles(path.join(MEDIA, "opr_thumb.png"));
  await sidebar.getByText(/^Chosen: opr_thumb\.png/).waitFor();
  const chosen = await coverOf();
  const coverFile = chosen.attachments.find((a) => a.purpose === "COVER");
  check(
    F,
    "Uploading a cover sets it without creating a revision or changing status",
    chosen.coverMode === "MANUAL" && chosen.cover?.attachmentId === coverFile?.id && chosen.versions.length === v1.versions.length && chosen.state === v1.state,
    `${chosen.versions.length} revision(s), state ${chosen.state}`,
  );
  await shot(page, "flow12-01-cover-uploaded");
  await waitFor(async () => (await tile(lena.page).locator("img").first().getAttribute("src")) !== lenaSrcBefore, "the cover to reach another member's board", 20_000);
  check(F, "Another member's open board shows the new cover without reloading", true);

  // A new revision, submission and processing don't replace a chosen cover.
  d = await detail(page, card.id);
  await openCard(page, card.key); // one deliverable: the card is its page
  await uploadRevision(page, path.join(MEDIA, "battlepass_v2.png"), true);
  await waitProcessed(page, card.id, d.deliverables[0]!.id, 2);
  const afterRevision = await coverOf();
  check(F, "A new (submitted) revision keeps the chosen cover", afterRevision.cover?.attachmentId === coverFile?.id && afterRevision.state === "NEEDS_REVIEW", afterRevision.state);

  // Both boards show it, the compact layout as a thumbnail.
  await page.goto(`${BASE}/nightfall/universal-tower-defense`);
  await tile(page).locator("img").first().waitFor();
  const categorySrc = await tile(page).locator("img").first().getAttribute("src");
  await page.getByRole("radio", { name: /Production/ }).click();
  await tile(page).locator("img").first().waitFor();
  const productionSrc = await tile(page).locator("img").first().getAttribute("src");
  check(F, "Category and Production boards show the same cover", Boolean(categorySrc) && categorySrc === productionSrc);
  await shot(page, "flow12-02-production-board");
  await rpc(page, "board.setView", { projectId, view: "CATEGORY" });
  await rpc(page, "card.update", { cardId: card.id, displayMode: "COMPACT" });
  await page.goto(`${BASE}/nightfall/universal-tower-defense`);
  const compactThumb = tile(page).locator("img").first();
  await compactThumb.waitFor();
  const thumbBox = (await compactThumb.boundingBox())!;
  check(F, "Compact tiles show a small thumbnail of the cover", thumbBox.width <= 40 && thumbBox.height <= 40, `${Math.round(thumbBox.width)}×${Math.round(thumbBox.height)}`);
  await shot(page, "flow12-03-compact-thumbnail");
  await rpc(page, "card.update", { cardId: card.id, displayMode: "VISUAL" });

  // Choose an existing file, go back to automatic, remove.
  await openCard(page, card.key);
  await sidebar.getByRole("button", { name: "Change cover" }).click();
  await page.getByRole("menuitem", { name: /Choose from this card/ }).click();
  await sidebar.getByRole("button", { name: "Use battlepass_v1.png as the cover" }).click();
  await sidebar.getByText(/^Chosen: battlepass_v1\.png/).waitFor();
  const reused = await coverOf();
  const old = (await rpc<CoverState>(page, "card.get", { cardId: card.id })).data!.attachments.find((a) => a.id === coverFile?.id);
  check(F, "An existing revision file can be chosen; the replaced cover upload is retired", reused.cover?.attachmentId !== coverFile?.id && !old, reused.cover?.attachmentId ?? "");
  await sidebar.getByRole("button", { name: "Done" }).click();
  await sidebar.getByRole("button", { name: "Change cover" }).click();
  await page.getByRole("menuitem", { name: "Use automatic cover" }).click();
  await sidebar.getByText(/^Automatic/).waitFor();
  check(F, "“Use automatic cover” follows the current revision again", (await coverOf()).coverMode === "AUTO");
  await sidebar.getByRole("button", { name: "Change cover" }).click();
  await page.getByRole("menuitem", { name: "Remove cover" }).click();
  await sidebar.getByText("No cover").waitFor();
  const none = await coverOf();
  check(F, "“Remove cover” shows no cover", none.coverMode === "NONE" && none.cover === null);
  await shot(page, "flow12-04-cover-removed");

  // Read-only members can't change it, in the UI or through the API.
  await openCard(ruby.page, card.key);
  const rubyChange = await ruby.page.getByRole("complementary", { name: "Card details" }).getByRole("button", { name: "Change cover" }).count();
  const rubyRpc = await rpc(ruby.page, "card.setCoverMode", { cardId: card.id, mode: "AUTO" });
  check(F, "Viewers see no cover controls and the server refuses them", rubyChange === 0 && rubyRpc.status === 403, `HTTP ${rubyRpc.status}`);
  for (const s of [lena, ruby]) await s.context.close();
  await context.close();
}

async function main() {
  browser = await chromium.launch({
    channel: process.env.VERIFY_CHANNEL ?? "msedge",
    headless: process.env.HEADED ? false : true,
    // Software WebGL so the Roblox viewer renders on machines/CI without a GPU.
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const flows: Array<[string, () => Promise<void>]> = [
    ["1", flow1],
    ["2", flow2],
    ["3", flow3],
    ["4", flow4],
    ["5", flow5],
    ["6", flow6],
    ["7", flow7],
    ["8", flow8],
    ["9", flow9],
    ["10", flow10],
    ["11", flow11],
    ["12", flow12],
  ];
  let failed = false;
  for (const [id, fn] of flows) {
    if (only.length && !only.includes(id)) continue;
    try {
      await fn();
    } catch (error) {
      failed = true;
      console.log(`\x1b[31m  Flow ${id} stopped: ${(error as Error).message}\x1b[0m`);
      // Capture whatever was on screen in each still-open session.
      let n = 0;
      for (const context of browser.contexts()) {
        for (const page of context.pages()) await page.screenshot({ path: path.join(OUT, `failure-flow${id}-${++n}.png`) }).catch(() => {});
        await context.close().catch(() => {});
      }
    }
  }
  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed. Screenshots in ${OUT}`);
  process.exit(failed ? 1 : 0);
}

void main();
