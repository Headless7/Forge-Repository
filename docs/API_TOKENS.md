# API tokens: connecting a bot to Forge

An API token lets a script or scheduled agent call Forge's RPC endpoint without a browser session.
The token acts as a member of the studio (a dedicated bot account), limited to an allowlist of
procedures and to chosen projects. It never grants anything that member could not already do.

This guide walks through the setup for a bug-triage bot: it reads a project's Bugs forum, then sets
an item's assignee and tags.

## 1. Create the bot member

1. Register a normal Forge account for the bot (for example with an email alias such as
   `you+triagebot@example.com`). Give it a clear display name like **Triage Bot**, since its edits
   show under that name in activity and history.
2. From **Members** in your studio, invite that account:
   - Role **Contributor**, access **Only specific projects**, and pick the project(s) it should see.
   - Accept the invitation while signed in as the bot.
3. Open the project's **Settings → Access** and give the bot the project role **Manager**.
   Assigning people and changing tags need the `item.assign` and `item.edit` permissions, which
   start at Manager. The project role applies only inside that project.

Keep the bot's password somewhere safe and don't use the account interactively.

## 2. Create a token (studio owners and admins)

1. Open **Studio settings → API tokens** and click **New token**.
2. Name it (e.g. "UTD bug triage"), choose the bot as **Acts as**, tick the project(s), and tick the
   procedures it needs. For triage: all **Read** procedures plus `item.triage`.
3. Choose an expiry (30 to 365 days) and click **Create token**.
4. Copy the token now. Forge shows it once and stores only a hash. If you lose it, use **Rotate**,
   which revokes the old secret and shows a new one with the same settings.

The list shows each token's name, last characters, bot, scope, creator, last use and expiry. Creating,
rotating, revoking, and any use of a revoked or expired token appear in the studio audit log.

## 3. Request shape

```
POST https://<your-forge-host>/api/rpc/<procedure>
Authorization: Bearer forge_…
Content-Type: application/json

{ ...procedure input... }
```

- Every call is a `POST` with a JSON body, even reads.
- A successful response is `200` with `{ "data": … }`.
- Bearer requests need no `Origin` header and no cookie. An invalid bearer token is refused
  outright; it never falls back to a cookie.
- Limits: 300 calls per minute per token, plus per-procedure limits (`item.triage`: 120 per minute).

## 4. Procedures a token may call

Only these six can ever be put on a token. Everything else (status changes, deletions, forum or
tag management, token management, account and studio procedures) is refused with `403`.

| Procedure | Input | Returns |
|---|---|---|
| `forum.list` | `{ "projectId" }` | the project's forums (`id`, `slug`, `name`, `kind`, `itemLabel`) |
| `forum.get` | `{ "projectId", "slug" }` or `{ "forumId" }` | the forum view: `items[]` (all statuses, resolved too), `tags[]`, `milestones[]`, `forums[]` |
| `item.get` | `{ "itemId" }` or `{ "forumId", "number" }` | one item with `description`, `attachments`, `comments`, `tagIds`, `assigneeId` |
| `item.activity` | `{ "itemId" }` | the item's history (who changed what, when) |
| `project.access` | `{ "projectId" }` | the project's people: `userId`, `displayName`, `username`, roles, `hasAccess`; no emails |
| `item.triage` | `{ "itemId", "assigneeId"?, "tagIds"?, "dueAt"? }` | the updated item. `dueAt` is an ISO datetime with offset, or `null`. Strict: any other field is a `400` |

### Finding ids

- **Project id**: shown with a copy button, next to the token, when a token is created or rotated.
  Admins can rotate an existing token to see the ids of its projects again.
- **Forum id**: `forum.list` with the project id; the Bugs forum has `slug: "bugs"`. You can also
  skip the id and call `forum.get` with `{ "projectId", "slug": "bugs" }`.
- **Tag ids**: `forum.get` returns `tags[]` with `id`, `name` and `color`. Tags belong to a forum.
- **Member ids**: `project.access` returns `userId` and `displayName` for everyone who can open the
  project (`hasAccess: true`). Use `userId` as `assigneeId`.
- **Item ids**: `forum.get` returns `items[]` with `id`, `key` (e.g. `UTD-B12`), `number`, `title`,
  `status`, `assigneeId`, `tagIds`, `reportedById`, `lastActivityAt`.

### curl examples

Set these once:

```sh
export FORGE_URL="https://your-forge-host"
export FORGE_TOKEN="forge_…"          # from Studio settings → API tokens
export PROJECT_ID="00000000-0000-0000-0000-000000000000"
```

List the project's forums:

```sh
curl -sS -X POST "$FORGE_URL/api/rpc/forum.list" \
  -H "Authorization: Bearer $FORGE_TOKEN" -H "Content-Type: application/json" \
  -d "{\"projectId\":\"$PROJECT_ID\"}"
```

Read the Bugs forum (items, tags, milestones):

```sh
curl -sS -X POST "$FORGE_URL/api/rpc/forum.get" \
  -H "Authorization: Bearer $FORGE_TOKEN" -H "Content-Type: application/json" \
  -d "{\"projectId\":\"$PROJECT_ID\",\"slug\":\"bugs\"}"
```

One item, by id or by forum and number:

```sh
curl -sS -X POST "$FORGE_URL/api/rpc/item.get" \
  -H "Authorization: Bearer $FORGE_TOKEN" -H "Content-Type: application/json" \
  -d '{"itemId":"<item id>"}'

curl -sS -X POST "$FORGE_URL/api/rpc/item.get" \
  -H "Authorization: Bearer $FORGE_TOKEN" -H "Content-Type: application/json" \
  -d '{"forumId":"<forum id>","number":12}'
```

The item's history:

```sh
curl -sS -X POST "$FORGE_URL/api/rpc/item.activity" \
  -H "Authorization: Bearer $FORGE_TOKEN" -H "Content-Type: application/json" \
  -d '{"itemId":"<item id>"}'
```

People who can be assigned:

```sh
curl -sS -X POST "$FORGE_URL/api/rpc/project.access" \
  -H "Authorization: Bearer $FORGE_TOKEN" -H "Content-Type: application/json" \
  -d "{\"projectId\":\"$PROJECT_ID\"}"
```

Set the assignee and tags (both optional; `tagIds` replaces the item's tag list, so include tags you
want to keep; `"assigneeId": null` clears the assignee):

```sh
curl -sS -X POST "$FORGE_URL/api/rpc/item.triage" \
  -H "Authorization: Bearer $FORGE_TOKEN" -H "Content-Type: application/json" \
  -d '{"itemId":"<item id>","assigneeId":"<user id>","tagIds":["<Lobby tag id>"]}'
```

To avoid overwriting a human's work, read the item first and only assign when `assigneeId` is null,
and merge your tag into the existing `tagIds`.

## 5. Errors

Every error is JSON: `{ "error": { "code", "message", "details"? } }`.

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION` | malformed JSON, missing or wrong fields, or an extra field on `item.triage` |
| 401 | `UNAUTHORIZED` | unknown, revoked or expired token (the message says which) |
| 403 | `FORBIDDEN` | procedure not on the token, project outside its scope, or the bot's role doesn't allow the change |
| 404 | `NOT_FOUND` | endpoint unknown, or an id the bot can't see (other studio, deleted) |
| 409 | `CONFLICT` | the change clashes with the item's current state |
| 429 | `RATE_LIMITED` | over budget; honour the `retry-after` header (seconds) |
| 500 | `INTERNAL` | server error; retry later |

## 6. Smoke test

`scripts/api-token-smoke.ts` calls every allowed procedure read-only and prints pass or fail. It
writes only with `--write` on a named item.

```sh
# read-only check (safe to repeat)
FORGE_URL=https://your-forge-host FORGE_TOKEN=forge_… FORGE_PROJECT_ID=<project id> \
  npx tsx scripts/api-token-smoke.ts

# one real triage: set the assignee and/or add a tag on item UTD-B12
FORGE_URL=… FORGE_TOKEN=… FORGE_PROJECT_ID=… \
  npx tsx scripts/api-token-smoke.ts --write --item UTD-B12 --assignee <user id> --tag <tag id>
```

Options: `--forum <slug>` (default `bugs`), `--item <key or id>`, `--assignee <user id>`,
`--tag <tag id>` (repeatable; added to the item's existing tags). The script never prints the token.

## 7. Operating notes

- Rotate a token if it may have leaked, and on a schedule if your policy asks for it. Rotation keeps
  the settings and expiry; the old secret stops at once.
- Revoke a token the moment the bot is retired. Removing the bot from the studio revokes its tokens.
- Tokens expire; create or rotate before the date shown in the list.
- A token cannot create, list or revoke tokens, and cannot be used for anything but the six
  procedures above.
