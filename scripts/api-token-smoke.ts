/**
 * Smoke test for a Forge API token: calls every procedure a token may use, read-only, and prints
 * pass or fail for each. Writes only with `--write`, on one named item.
 *
 *   FORGE_URL=https://forge.example FORGE_TOKEN=forge_… FORGE_PROJECT_ID=<uuid> npx tsx scripts/api-token-smoke.ts
 *   … npx tsx scripts/api-token-smoke.ts --write --item UTD-B12 --assignee <user id> --tag <tag id> [--tag <tag id>]
 *
 * Options: --forum <slug> (default "bugs"), --item <key or id>, --assignee <user id>, --tag <tag id> (repeatable;
 * added to the item's current tags). Exit code 1 when any check fails. The token is never printed.
 * Standalone on purpose: only `fetch`, so it runs anywhere Node 18+ and tsx are available.
 */
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    write: { type: "boolean", default: false },
    forum: { type: "string", default: "bugs" },
    item: { type: "string" },
    assignee: { type: "string" },
    tag: { type: "string", multiple: true },
    help: { type: "boolean", default: false },
  },
});

if (args.help) {
  console.log("See the header of scripts/api-token-smoke.ts or docs/API_TOKENS.md.");
  process.exit(0);
}

const url = (process.env.FORGE_URL ?? "").replace(/\/+$/, "");
const token = process.env.FORGE_TOKEN ?? "";
const projectId = process.env.FORGE_PROJECT_ID ?? "";
if (!url || !token || !projectId) {
  console.error("Set FORGE_URL, FORGE_TOKEN and FORGE_PROJECT_ID in the environment.");
  process.exit(2);
}

interface RpcResponse {
  status: number;
  data?: unknown;
  error?: { code: string; message: string };
}

async function rpc(procedure: string, input: unknown): Promise<RpcResponse> {
  const res = await fetch(`${url}/api/rpc/${procedure}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => ({}))) as { data?: unknown; error?: RpcResponse["error"] };
  return { status: res.status, data: body.data, error: body.error };
}

let failures = 0;
function pass(label: string, detail = "") {
  console.log(`PASS  ${label}${detail ? `  ${detail}` : ""}`);
}
function fail(label: string, detail = "") {
  failures += 1;
  console.log(`FAIL  ${label}${detail ? `  ${detail}` : ""}`);
}
function skip(label: string, detail = "") {
  console.log(`SKIP  ${label}${detail ? `  ${detail}` : ""}`);
}
const describeError = (r: RpcResponse) => `${r.status} ${r.error?.code ?? ""} ${r.error?.message ?? ""}`.trim();

interface Forum {
  id: string;
  slug: string;
  name: string;
  itemLabel: string;
}
interface ItemSummary {
  id: string;
  key: string;
  number: number;
  title: string;
  status: string;
  assigneeId: string | null;
  tagIds: string[];
}
interface Tag {
  id: string;
  name: string;
}
interface ForumView {
  forum: Forum;
  items: ItemSummary[];
  tags: Tag[];
}
interface Person {
  userId: string;
  displayName: string;
  hasAccess: boolean;
  projectRole: string | null;
  studioRole: string;
}

async function main() {
  console.log(`Forge API token smoke test against ${url}`);

  // forum.list
  const forums = await rpc("forum.list", { projectId });
  if (forums.status !== 200 || !Array.isArray(forums.data)) {
    fail("forum.list", describeError(forums));
    return;
  }
  const list = forums.data as Forum[];
  pass("forum.list", `${list.length} forum(s): ${list.map((f) => f.slug).join(", ")}`);
  const forum = list.find((f) => f.slug === args.forum);
  if (!forum) {
    fail(`forum "${args.forum}"`, "not found in forum.list; pass --forum <slug>");
    return;
  }

  // forum.get (by project + slug, the shape a scheduler would use)
  const view = await rpc("forum.get", { projectId, slug: args.forum });
  if (view.status !== 200) {
    fail("forum.get", describeError(view));
    return;
  }
  const v = view.data as ForumView;
  const open = v.items.filter((i) => i.status === "OPEN");
  pass("forum.get", `${v.items.length} item(s), ${open.length} open, ${v.tags.length} tag(s)`);
  for (const t of v.tags) console.log(`        tag  ${t.id}  ${t.name}`);
  for (const i of open.slice(0, 5)) console.log(`        item ${i.id}  ${i.key}  “${i.title}”${i.assigneeId ? "" : "  (unassigned)"}`);
  if (open.length > 5) console.log(`        … ${open.length - 5} more open item(s)`);

  // project.access
  const people = await rpc("project.access", { projectId });
  if (people.status !== 200 || !Array.isArray(people.data)) fail("project.access", describeError(people));
  else {
    const roster = (people.data as Person[]).filter((p) => p.hasAccess);
    const leaked = (people.data as Array<Record<string, unknown>>).some((p) => "email" in p);
    if (leaked) fail("project.access", "response contains emails");
    else pass("project.access", `${roster.length} people can open the project`);
    for (const p of roster) console.log(`        user ${p.userId}  ${p.displayName}  (${p.projectRole ?? p.studioRole})`);
  }

  // item.get + item.activity on the first item (or the named one)
  const named = args.item ? v.items.find((i) => i.id === args.item || i.key.toLowerCase() === args.item!.toLowerCase()) : undefined;
  if (args.item && !named) fail(`item ${args.item}`, "not in this forum");
  const sample = named ?? v.items[0];
  if (!sample) {
    skip("item.get", "the forum has no items yet");
    skip("item.activity", "the forum has no items yet");
  } else {
    const item = await rpc("item.get", { itemId: sample.id });
    if (item.status !== 200) fail("item.get", describeError(item));
    else pass("item.get", `${sample.key} “${sample.title}”`);
    const activity = await rpc("item.activity", { itemId: sample.id });
    if (activity.status !== 200 || !Array.isArray(activity.data)) fail("item.activity", describeError(activity));
    else pass("item.activity", `${(activity.data as unknown[]).length} event(s)`);
  }

  // Scope check: a procedure that is never on a token must be refused.
  const refused = await rpc("item.setStatus", { itemId: sample?.id ?? "00000000-0000-0000-0000-000000000000", status: "RESOLVED" });
  if (refused.status === 403 && refused.error?.code === "FORBIDDEN") pass("scope enforced", "item.setStatus → 403 FORBIDDEN");
  else fail("scope enforced", `item.setStatus → ${describeError(refused)} (expected 403 FORBIDDEN)`);

  // Optional write
  if (!args.write) {
    skip("item.triage", "pass --write --item <key> with --assignee and/or --tag to try one real triage");
    return;
  }
  if (!named) {
    fail("item.triage", "--write needs --item <key or id> from this forum");
    return;
  }
  if (!args.assignee && !args.tag?.length) {
    fail("item.triage", "--write needs --assignee <user id> and/or --tag <tag id>");
    return;
  }
  const input: { itemId: string; assigneeId?: string; tagIds?: string[] } = { itemId: named.id };
  if (args.assignee) input.assigneeId = args.assignee;
  if (args.tag?.length) input.tagIds = [...new Set([...named.tagIds, ...args.tag])];
  const triage = await rpc("item.triage", input);
  if (triage.status !== 200) fail("item.triage", describeError(triage));
  else {
    const after = triage.data as ItemSummary;
    pass("item.triage", `${after.key}: assignee ${after.assigneeId ?? "none"}, tags ${after.tagIds.length}`);
  }
}

main()
  .catch((error) => {
    fail("request", error instanceof Error ? error.message : String(error));
  })
  .finally(() => {
    console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
    process.exit(failures ? 1 : 0);
  });
