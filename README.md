# Forge — production boards & media review for Roblox studios

Forge is an internal studio tool that combines a Trello-style project board with
Frame.io-style media review. Artists upload renders, clips, audio and Roblox files
to a card, reviewers leave feedback pinned to exact frames, pixels and moments, and
every revision, decision and comment stays attached to the work it belongs to.

- **Board first** — customisable categories (VFX, Animations, UI, Scripting…),
  drag-and-drop cards and columns, visual (media-first) and compact card layouts.
- **Card covers** — a card's tile shows its current revision automatically, or an
  image/video someone chose (uploaded just for the cover or picked from the card's
  files). A chosen cover stays through new revisions and reviews; covers never create
  revisions or change review status.
- **Two views of the same cards** — the **Category** view, and a **Production**
  view with *To-do → Completed → Published* stages. Each person's choice is
  remembered; filters, counts and quick-add work in both.
- **Deliverables** — a card can hold several pieces of work (a model, a rig, an
  animation, VFX, SFX…), each with its own owner, reviewer, due date, files,
  revisions, review state and feedback. Simple cards stay simple: one implicit
  deliverable, no extra UI.
- **Connected canvas** — deliverables on a pan/zoom canvas (or as a list) with
  *dependency* and *association* links; blocked work shows what it is waiting on.
- **Review workflow** — Not submitted → In progress → Needs review →
  Changes requested / Approved, per deliverable, rolled up onto the card.
- **Real previews** — videos, images, **audio** (.mp3/.ogg with waveform and
  timestamped feedback) and **Roblox files** (.rbxm/.rbxmx/.rbxl/.rbxlx): a 3D viewer
  with animation playback on rigs and particle/beam/trail effects, and a 2D view that
  draws ScreenGui/SurfaceGui/BillboardGui UI at real screen sizes.
- **Team features** — roles & permissions, invitations, @mentions, notifications,
  search, filters, milestones, activity history, realtime updates.

---

## Quick start (local)

Requirements: **Node.js 22.12+ (24 recommended)**. Nothing else — PostgreSQL and
ffmpeg are provided through npm packages.

```bash
npm install
npm run dev
```

Then open **http://localhost:3000**.

The first `npm run dev`:

1. creates `.env` with fresh random secrets,
2. starts a private PostgreSQL 18 server in `.data/postgres` (port 54329),
3. applies database migrations,
4. renders demo media (≈1 minute, first run only) and loads a demo studio,
5. starts Next.js.

`Ctrl+C` stops Next.js and shuts PostgreSQL down cleanly.

> npm 11 only runs install scripts for approved packages. `package.json` already
> approves the three this project needs (`ffmpeg-static`, `esbuild`,
> `@embedded-postgres/*`). If an install ever skips them, run
> `npm rebuild ffmpeg-static esbuild @embedded-postgres/windows-x64`.

### Demo accounts

All demo accounts use the password **`demo1234`**. In development the sign-in page
lists them for one-click login.

| Account | Role | Good for |
| --- | --- | --- |
| giorgos@nightfall.gg | Owner, Studio Lead | Reviewing, approving, publishing, settings |
| lena@nightfall.gg | Manager, Producer | Reviewing, organising the board, publishing |
| james@nightfall.gg | Member, VFX Artist | Uploading revisions, resolving feedback |
| alex@nightfall.gg / sofia@… / mike@… / kenji@… | Members | Animation, UI, models, scripting |
| ruby@nightfall.gg | Viewer | Read-only access |
| omar@emberlight.dev | Owner of a *different* studio | Checking studio isolation |

Emails (invitations, password resets, verification) are shown at
**http://localhost:3000/dev/outbox** while no SMTP server is configured.

### A 5-minute tour

1. Sign in as **Giorgos** → open **Universal Tower Defense**. Red cards need
   changes, amber cards need review, green cards are approved.
2. Switch the header to **Production** (or press `v`): the same cards, grouped by
   stage, each showing its category. Drag a card to **Completed** — if a required
   deliverable isn't approved, Forge explains exactly what is missing.
3. Open **Shrine Guardian Boss Kit**: six deliverables on a canvas. Arrows are
   dependencies (amber = still blocking), dashed lines are associations. Double-click
   a node (or use the list) to open a deliverable; *All deliverables* or `Esc` brings
   you back to the same spot on the canvas.
4. In that card: **Shrine tower prop** opens a Roblox model in the 3D viewer
   (Explorer, Properties, Resources and Fidelity panels); **Cursed Slash animation**
   plays on the guardian rig; **Cursed energy burst VFX** emits particles, beams and
   trails; **Slash SFX** is an audio review with a waveform and timestamped notes.
5. Open **Gojo Hollow Purple VFX** (`UTD-1`): the classic single-deliverable card —
   V1/V2 history, timestamp feedback on the video timeline, feedback still open from V1.
6. Sign in as **James** in another browser: drag a render onto a card to upload a
   new revision; watch Giorgos's board update live.

### Useful scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Postgres + migrations + seed (first run) + `next dev` |
| `npm start` | Same, but builds and runs the production server |
| `npm test` | Vitest suite (uses a separate `forge_test` database) |
| `npm run verify:server` | An isolated copy of Forge for verification: its own database (`<name>_verify`), storage (`.data/verify`) and build folder, on http://127.0.0.1:3100 — runs next to `npm run dev` |
| `npm run verify:flows` | Drives 12 end-to-end flows in a real browser (Edge or Chrome) and saves screenshots in `.verify/`. Flows create cards and upload files, so point them at the isolated server: `VERIFY_URL=http://127.0.0.1:3100 npm run verify:flows`. `npm run verify:flows -- 5 7` runs only some; flow 10 checks your own Roblox files (`VERIFY_ASSETS=<folder>`). |
| `npm run db:reset` | Wipe all data and uploaded files, then reseed the demo |
| `npm run db:start` | Run only PostgreSQL (e.g. with `npm run dev:next`) |
| `npm run db:generate` | Create a migration after changing `src/server/db/schema` |
| `npm run typecheck` | TypeScript strict type check |

---

## Architecture

| Concern | Choice |
| --- | --- |
| Framework | Next.js 16 (App Router, Turbopack), React 19, TypeScript (strict) |
| UI | Tailwind CSS 4, Radix primitives, lucide icons, dnd-kit, TanStack Query, React Flow (`@xyflow/react`) for the deliverable canvas, three.js for the Roblox viewer (both loaded only when needed) |
| Database | PostgreSQL + Drizzle ORM (parameterised queries, SQL migrations in `drizzle/`) |
| Auth | Built-in: scrypt password hashing, DB-backed sessions (hashed tokens, sliding 30-day expiry), optional Discord / Google OAuth |
| API | One typed RPC endpoint (`/api/rpc/[procedure]`) — each procedure has a Zod schema and calls a service |
| Realtime | Server-Sent Events + PostgreSQL `LISTEN/NOTIFY` fan-out (works across server instances) |
| Files | Private object storage: local disk (dev) or any S3-compatible bucket (AWS S3, Cloudflare R2, MinIO); signed, expiring URLs only |
| Media | sharp for image thumbnails; ffmpeg (bundled) for video posters, previews and transcodes, audio probing, waveform peaks and an AAC compatibility copy of OGG files; Forge's own Roblox file reader (binary + XML) for preview manifests |

```
src/
  app/                 routes: pages (auth, studio, board, settings, account) and API route handlers
  components/          UI — board/ (category + production views), card/ (workspace, deliverables,
                       canvas, production panel), media/ (image, video, audio players, compare),
                       roblox/ (3D viewer, effects, panels), comments/, shell/, ui/
  lib/                 code shared by client & server: DTO types, permissions, deliverable rules,
                       roblox/ (animation math, mesh reader, content ids, support table)
  server/
    access.ts          authorization — every lookup joins through the caller's membership
    auth/              sessions, password hashing, OAuth
    db/schema/         Drizzle schema (38 tables)
    roblox/            .rbxm/.rbxmx reader (LZ4/ZSTD chunks, XML), manifest builder, test writer
    rpc/               procedure registry
    services/          business logic (cards, deliverables, production, reviews, media, roblox, …)
    storage/ media/    object storage drivers, upload analysis, ffmpeg, audio
    realtime/ jobs/    event bus, background queue
  test/                Vitest helpers and global setup
scripts/               dev/setup/seed/migrate/verify tooling
```

### Key design decisions

- **A card is a piece of work; deliverables are its parts.** Every card has at
  least one deliverable. `asset_versions` (revisions), `reviews`, feedback and
  discussion belong to a deliverable, so revising or reviewing one never touches
  another. The card's review state is a roll-up: *Needs review* if anything waits on
  a reviewer, else *Changes requested*, else *Approved* once every required
  deliverable is approved (optional ones don't count).
- **Production stage is separate from review state.** `To-do / Completed /
  Published` is the card's own property. Completing or publishing is only allowed
  when every required deliverable is approved, and it records *which* approved
  revision of each deliverable was completed/published. New work afterwards keeps
  that record intact and shows as *pending changes* — it is never treated as
  approved or released. **Published is a tracking state; nothing is deployed to
  Roblox.**
- **Links are data, not decoration.** `deliverable_links` are either dependencies
  (the dependant shows as blocked until the prerequisite is approved) or
  associations. Self-links and cycles are refused by the server.
- **Feedback vs discussion.** Comments are `DISCUSSION` or `FEEDBACK`. Feedback is
  actionable and resolvable; "Request changes" bundles new items plus feedback
  already left on that revision.
- **Authorization is server-side and ID-proof.** Services resolve access through
  studio/project membership and return *not found* (not *forbidden*) for anything
  outside it — including deliverables, links, Roblox resources and previews.
  Card-level rules (`src/lib/permissions.ts`) are shared with the UI so buttons
  reflect exactly what the server allows.
- **Optimistic UI.** Moves, renames, state and stage changes and quick-add update
  the board immediately; failures roll back with a message.
- **Uploads never touch the database.** Browsers upload straight to storage, then
  the server verifies the file by content (magic bytes), extracts metadata and
  builds derived data (thumbnails, waveforms, Roblox manifests) in a background
  queue. Originals are never modified; derived data is stored next to the revision
  it came from.
- **Existing content was migrated, not recreated.** Migration `0001` gives every
  existing card one deliverable and moves its versions, reviews and feedback onto
  it; nothing is dropped.

### Roles

| Role | Can |
| --- | --- |
| Owner | Everything, including deleting the studio and managing owners |
| Admin | Manage projects, members, invitations, settings; permanent deletes |
| Manager | Create/edit any card and deliverable, assign, organise, review (approve / request changes), **mark work Published** |
| Member | Create cards, work on cards they created or are assigned to (incl. adding deliverables and marking approved work Completed), upload, comment, submit for review |
| Viewer | Read-only (sees deliverables, canvases and previews) |

Projects can be **private** (explicit members only) and give individuals a different
role per project. Roles are stored as strings and resolved through `roleHas()`, so
custom roles can be added by swapping in a table-backed lookup.

### Security

- **Accounts:** scrypt password hashing; hashed session, reset and invite tokens; reset
  and verification links are claimed atomically (single use even under concurrent
  requests); resets sign out every session. httpOnly SameSite=Lax cookies (Secure over
  HTTPS). OAuth uses signed state, PKCE where the provider supports it, and links only
  on a provider-verified email — and linking to an account whose address was never
  verified drops that account's password and sessions (no pre-registration takeover).
- **Requests:** Origin checks on every write (CSRF; in production only `APP_URL`'s
  origin). Zod validation on every input; JSON bodies are read with a size cap (1 MB for
  the API, 64 KB for sign-in forms). `X-Forwarded-*` headers are believed only from the
  number of proxies set in `TRUSTED_PROXY_HOPS`.
- **Rate limits:** sign-in failures per address *and* per account (password guessing
  spread over many addresses still stops), sign-up, resets, verification, invitations —
  kept in PostgreSQL, so every instance shares them. Per-user API, upload and comment
  throttles are in memory (per instance).
- **Content:** pages get a per-request nonce CSP in production (`script-src 'nonce-…'
  'strict-dynamic'`: injected inline scripts and event handlers don't run); HSTS over
  HTTPS; `nosniff`, frame denial, referrer and permissions policies. Comments,
  descriptions and Roblox text are rendered without ever interpreting HTML.
- **Files:** private storage with HMAC (local) or presigned (S3/R2) expiring URLs;
  S3 upload URLs are bound to the announced size; upload type sniffing, per-kind size
  limits, executables blocked, SVG/HTML never served inline; files served with
  `nosniff` and a sandbox CSP. Image decoding is capped at 120 MP; ffmpeg runs with a
  timeout; Roblox files are parsed as data only (scripts never run, their source is never
  sent to the browser; decompression, instance, mesh and bone counts are bounded).
  Uploads that are started but never finished are deleted after a day.
- **Server-side fetching** (image import from a URL, Roblox assets) refuses private,
  loopback, link-local and metadata addresses — including IPv4 hidden in IPv6 (mapped,
  NAT64, 6to4) and Teredo, literal IPs and every redirect hop — checks addresses at
  connect time (no DNS rebinding), and caps size and total time.
- **Audit log** of role changes, invitations, access changes and deletions (Studio
  settings → Audit log).

---

## Roblox previews — what is supported

Uploading a `.rbxm`, `.rbxmx`, `.rbxl` or `.rbxlx` file produces a preview manifest
(read by Forge's own parser; validated against 116 Studio-exported files from
[rojo-rbx/rbx-test-files](https://github.com/rojo-rbx/rbx-test-files), where the
binary and XML readers agree). Every preview shows a **Fidelity** panel listing what
in *that* file is rendered fully, approximated or not shown, so a partial preview is
never presented as complete.

**Model inspection**

- Parts, wedges, corner wedges, cylinders, balls, seats, spawn locations;
  SpecialMesh brick/sphere/cylinder/wedge/head shapes; Block/CylinderMesh scaling.
  Head shapes are approximated.
- MeshParts and FileMeshes render their real geometry once the mesh is provided
  (see *Resources*); until then they are labelled boxes of the right size.
- Unions/negate/intersect operations are drawn as boxes (their geometry is stored in
  Roblox-only data).
- Colours, transparency, reflectance; materials approximated with roughness,
  metalness and Neon glow (not Roblox's material textures). SurfaceAppearance colour
  maps (with cut-out alpha for `AlphaMode = Transparency`, e.g. hair and fur cards).
- Decals and Textures are projected along their face onto the part's real surface —
  the box of a part, a SpecialMesh head or file mesh, a MeshPart's mesh (deforming with
  it when skinned) — over that surface's bounds, with tint, transparency, ZIndex and
  tiling. Built-in images (`rbxasset://…`, e.g. the classic face) ship with Roblox
  Studio, not the web: the Resources panel says where to upload them from.
- Explorer (hierarchy, search, show/hide), Properties, frame selection / reset
  camera, backgrounds, lighting presets, grid, fullscreen.

**Animation**

- `KeyframeSequence` playback (play/pause, scrub, frame-step, speed, loop, keyframe
  markers, `KeyframeMarker`s) with Linear, Constant, Cubic, Elastic and Bounce
  easing, posed through `Motor6D` joints exactly as Roblox does
  (`Part1 = Part0 · C0 · Transform · C1⁻¹`) and through **Bones**
  (`Parent · CFrame · Transform`) for skinned rigs.
- **Skinned meshes:** MeshParts whose mesh carries a skeleton (mesh v4–v7, including
  Draco-compressed v7) deform with their Bones — up to four weighted bones per vertex,
  bound with the bind pose stored in the mesh, as Roblox does. Tracks are matched to
  joints by their pose path, so repeated bone names bind correctly. "Show bones" draws
  the skeleton; the preview warns when an animation moves bones but no skinned mesh is
  loaded, instead of showing a moving timeline over a still model.
- Files with several rigs play each animation on the rig it animates (on a tie, the rig
  it's stored in); repeated clip names are labelled with their rig.
- The rig comes from the same file, from another Roblox file on the card or
  project (chosen once and remembered for everyone), or — clearly labelled — a
  standard R6 block rig when the animation targets R6 joints. Missing joints are
  listed.
- Not played: `CurveAnimation`s (detected and reported), facial (FACS) poses,
  animation assets referenced by id but not inside the file.

**Effects**

- `ParticleEmitter` simulated in the browser from its properties (rate, lifetime,
  speed, spread, size/colour/transparency curves, rotation, drag, acceleration,
  flipbooks, light emission, `EmitCount` bursts), `Beam` (curved,
  textured, scrolling), `Trail` (use *Motion* to move the effect), point/spot/surface
  lights. Legacy `Fire`/`Smoke`/`Sparkles` use stand-in recipes. Timing, lighting
  and collisions are approximations of the engine, and the Fidelity panel says so.

**2D UI (ScreenGui, SurfaceGui, BillboardGui)**

Files with UI open on a **UI** tab that draws them like the Roblox client, at a chosen
screen size (desktop 1920×1080, laptop, tablet, phone landscape/portrait), below Roblox's
58 px top bar unless the ScreenGui ignores the inset.

- Layout: UDim2 size/position, AnchorPoint, SizeConstraint, Rotation, ZIndex, Visible,
  ClipsDescendants, UIPadding, UIListLayout (direction, alignment, padding, sort order,
  wrapping), UIGridLayout (cell size/padding, direction, start corner, max cells),
  UIAspectRatioConstraint (also on grid cells), UISizeConstraint, UIScale, AutomaticSize,
  ScrollingFrame canvases (scrollable in the preview), UIPageLayout (first page).
- Look: background colour/transparency, borders, UICorner, UIStroke (borders and text
  outlines), UIGradient (colour + transparency, rotation, offset), CanvasGroup
  transparency, AutoButtonColor hover/press on buttons.
- Text: TextScaled (largest size ≤ 100 that fits, with UITextSizeConstraint), wrapping,
  alignment, line height, stroke, truncation, MaxVisibleGraphemes, TextBox placeholder,
  and RichText (`b i u s font stroke mark uppercase smallcaps br`; parsed, never
  injected as HTML). Fonts: the open-licensed Roblox fonts are bundled
  (`public/roblox-fonts`, licences included, regenerated by
  `scripts/fetch-roblox-fonts.ts`); Gotham/Builder Sans and a few legacy faces are
  drawn with the closest open font and the Fidelity panel names them.
- Images: Stretch, Fit, Crop, Tile and 9-slice, sprite-sheet rects
  (ImageRectOffset/Size), ImageColor3 tint, transparency, pixelated resampling — once
  the image is provided or fetched (same pipeline as meshes and textures).
- "Show hidden" reveals objects that start hidden (Visible = false, disabled
  ScreenGuis), which scripts usually open in game. Clicking an element selects it in
  the Explorer/Properties panels.
- Approximated or not shown: ZIndexBehavior Global is drawn like Sibling; SurfaceGuis
  and BillboardGuis are drawn flat in the UI tab rather than on their parts in 3D;
  ViewportFrame (3D inside UI) and VideoFrame are labelled placeholders; UIFlexItem and
  UITableLayout aren't reproduced; text can wrap or size a pixel or word differently.

Checked against 12 public UI kits from the Roblox Toolbox (up to 457 elements and 94
images in one file): every file lays out without errors in under 5 ms.

**Resources (meshes, textures and UI images)**

Roblox files reference meshes and images by asset id. When someone who can add files
opens a preview, Forge downloads the missing ones from Roblox automatically, in one
batched request with up to 6 downloads at a time (texture ids that point at a Decal are
followed to its image). Downloads go through Roblox Open Cloud with
`ROBLOX_OPEN_CLOUD_API_KEY` — the key needs the **`legacy-asset` → manage** permission
(the Assets API's `asset` read/write isn't enough). With it, any public asset (including
other creators' catalog items) and anything the key's owner can access is fetched.
Without a key Forge tries Roblox's no-sign-in download, which in testing only works for
a few, mostly older, assets.

- **Cache:** fetched assets are stored per studio on the server and shared by every
  preview in that studio. Each request renews it; an asset nobody requests for **7 days**
  is deleted (an hourly job, also run by `/api/cron/due-dates`) and is simply fetched
  again when next needed. Files people upload are never evicted.
- **Rate limits:** Roblox limits Open Cloud per *key owner* — all keys from the same
  account or group share one quota (1000 asset requests/minute when tested) — so adding
  more keys from the same account doesn't add capacity, and Forge doesn't rotate keys.
  It stays well inside the quota by caching, counts only real downloads against its own
  per-person limit, and when Roblox answers 429 it waits as told (`retry-after`) and the
  preview retries those assets afterwards instead of marking them failed.
- **Formats:** Roblox `.mesh` v1–v7 (newer, Draco-compressed meshes are decoded once on
  the server with Google's `draco3d`; the original is kept), `.obj`, `.glb`, `.fbx`;
  PNG/JPEG/WebP/GIF images.
- Anything that can't be fetched (private to someone else, deleted) shows why in the
  *Resources* panel, where a project member can provide the file instead. An uploaded
  file always wins over Roblox's copy. Set `ROBLOX_PUBLIC_ASSET_FETCH=false` and leave
  the key unset if the server should never contact Roblox.

**Not shown**: terrain, sky/atmosphere/post-processing, sounds inside the file,
physics, avatar clothing, facial (FACS) animation, skinning of OBJ/GLB/FBX stand-ins
(only Roblox `.mesh` files carry Roblox bones), anything scripts would do at runtime.
Scripts are listed with their line count only.

When the reader improves, previews made by an older version are rebuilt in the
background at the next server start (and when someone opens them), and decoded meshes
are regenerated from the kept original the next time they're served — nothing has to
be uploaded again.

---

## Configuration

All settings live in `.env` (see `.env.example` for descriptions).

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `EMBEDDED_POSTGRES` | `true` = start the bundled local server; `false` = use your own database |
| `AUTH_SECRET` | Signs file URLs and OAuth state (generated for you) |
| `STORAGE_DRIVER` | `local` or `s3` (+ `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, keys, `STORAGE_PUBLIC_ORIGIN`) |
| `MAX_*_UPLOAD_MB` | Upload size limits per kind (image, video, audio, Roblox, file) |
| `ROBLOX_PUBLIC_ASSET_FETCH` | `true` (default): previews try Roblox's no-sign-in download for referenced meshes/textures (works for few, mostly older assets); `false` = never contact Roblox without a key |
| `ROBLOX_OPEN_CLOUD_API_KEY` | Open Cloud key with `legacy-asset` → manage. Lets previews fetch referenced meshes, textures and UI images (public ones and the owner's private ones) |
| `PLATFORM_ADMIN_EMAILS` | Site operators (comma-separated). With a confirmed email they create studios and issue activation keys at `/admin/keys`; nobody else can create a studio without a key |
| `STUDIO_STORAGE_LIMIT_GB` | Total uploaded originals per studio (default 200). Uploads past it are refused; owners/admins see usage in Studio settings |
| `RESEND_API_KEY` or `SMTP_URL`, `EMAIL_FROM` | Real email delivery (otherwise the dev outbox). `RESEND_API_KEY` sends over HTTPS — use it where outbound SMTP is blocked (Railway below Pro) |
| `DISCORD_CLIENT_ID/SECRET`, `GOOGLE_CLIENT_ID/SECRET` | Enable OAuth sign-in (redirect: `{APP_URL}/api/auth/oauth/{provider}/callback`) |
| `DISCORD_APPLICATION_ID`, `DISCORD_BOT_TOKEN` | With the Discord client id/secret: the Forge bot (team feeds, direct messages, slash commands). See [Discord bot](#discord-bot) |
| `REALTIME_DRIVER` | `postgres` (multi-instance) or `memory` |
| `ENABLE_INPROCESS_JOBS`, `CRON_SECRET` | Due-date reminders / email delivery in-process, or via `GET /api/cron/due-dates` with `Authorization: Bearer $CRON_SECRET` |
| `TRUSTED_PROXY_HOPS` | Reverse proxies in front of the app that append `X-Forwarded-For` (usually `1`). `0` (production default) ignores forwarded headers; per-IP limits then use shared budgets |
| `DEV_OUTBOX_KEY` | Development only: opens `/dev/outbox` without signing in. `npm run dev` generates one and prints the link |

### Deploying

**Production checklist** — the server refuses to start with a weak `AUTH_SECRET`
(< 32 characters or a placeholder), a placeholder `CRON_SECRET` or incomplete S3
settings, and logs warnings for the rest:

- Serve over **HTTPS** (`APP_URL=https://…`): Secure cookies and HSTS depend on it.
- Behind a reverse proxy, set `TRUSTED_PROXY_HOPS` (usually `1`) so per-IP limits and
  session records see real client addresses.
- Use a **private** S3/R2 bucket (no public read; CORS allowing `PUT` from your origin)
  and set `STORAGE_PUBLIC_ORIGIN` to its origin.
- Back up PostgreSQL (e.g. daily `pg_dump` plus point-in-time recovery from your
  provider) and the bucket (versioning or replication); test a restore.
- Monitor `GET /api/health` and the server logs (`[forge]` lines: failed jobs, unhandled
  errors, production-config warnings).
- `npm start` never loads the demo studio. Forge is invitation-only: set
  `PLATFORM_ADMIN_EMAILS` to your email, sign up with it and confirm it, then create the
  studio (no account is ever made an owner just by registering first). Keep `DEMO_MODE` off.
- The media queue is in memory and runs in one process: run a single worker with
  `ENABLE_INPROCESS_JOBS=true` (it re-queues interrupted work on start) and the others
  with `false`.

- **Any long-running Node host (Railway, Fly.io, Render, a VPS, Docker):** set
  `EMBEDDED_POSTGRES=false`, point `DATABASE_URL` at managed PostgreSQL, use
  `STORAGE_DRIVER=s3` with a private R2/S3 bucket, run `npm run build` then
  `npm run start:next`. Migrations: `npm run db:migrate`.
- **Vercel:** works for pages and the API. Use managed PostgreSQL and R2/S3, set
  `ENABLE_INPROCESS_JOBS=false` and schedule `/api/cron/due-dates`. SSE realtime and
  background media work (video transcodes, waveforms, Roblox manifests) need a
  long-lived process, so keep them on a small Node worker or replace them with hosted
  equivalents behind the existing `RealtimeBus` and `mediaQueue` interfaces.

### Discord bot

One Discord application does everything: "Sign in with Discord", studio team feeds, direct
messages and the slash commands. In the [Developer Portal](https://discord.com/developers/applications):

1. **OAuth2 → Redirects:** add `{APP_URL}/api/auth/oauth/discord/callback` and
   `{APP_URL}/api/integrations/discord/callback`.
2. **Bot:** copy the token into `DISCORD_BOT_TOKEN` (with `DISCORD_APPLICATION_ID`,
   `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET`).
3. **General Information → Interactions Endpoint URL:** `{APP_URL}/api/discord/interactions`
   (deploy first: Discord checks the URL answers correctly when you save it).

On start, a production server registers the commands (`/mywork`, `/reviews`, `/card`, `/due`, `/newcard`)
when they changed and reads the public key that signs Discord's requests (override with
`DISCORD_PUBLIC_KEY`). Commands work for people who connected Discord in Account → Security,
act with their own Forge permissions, and only they see the replies.

## Extending

- **More sign-in providers:** add a provider to `src/server/auth/oauth.ts`; accounts
  link through `oauth_accounts`.
- **More Roblox classes in the viewer:** add the class to the manifest builder
  (`src/server/roblox/manifest.ts`), render it in `src/components/roblox/scene.ts` or
  `effects.ts`, and update its row in `src/lib/roblox/support.ts` so the Fidelity
  panel stays honest.

## Tests

`npm test` runs 154 tests against a real PostgreSQL database: card creation and
ordering, moving (including rebalancing and concurrency), permissions and the role
matrix, review state transitions and history, deliverables (independent revisions
and reviews, roll-up, optional deliverables, links, cycle and self-link refusal,
archiving), production stages (completion rules, recorded revisions, pending changes,
publish permission, per-user board view), uploading and verifying images, video,
audio (waveforms, timestamped feedback) and Roblox files, comments/mentions,
annotations, project isolation, invitations, auth flows, due-date reminders — plus the
Roblox reader against the rbx-test-files corpus, Motor6D/keyframe animation maths, the
`.mesh` reader and Draco decoding, the 2D UI layout engine and rich-text parser, and the
Roblox asset cache (single download, per-studio isolation, 7-day eviction and renewal,
uploads winning, waiting out Roblox's 429s — Roblox itself is simulated in these tests),
skinned meshes (mesh v4 and Draco v7 skin data, bone matching by hierarchy, and real
`SkinnedMesh` deformation), decal projection, card covers (persistence through
revisions and reviews, cover uploads, permissions, foreign files), and the security
fixes (proxy headers, distributed password guessing, shared rate limits, reset-link
replay, OAuth pre-registration, body limits, SSRF address forms, S3 upload binding,
abandoned uploads).

`npm run verify:flows` drives the real UI in Edge/Chrome:

1. video review round trip · 2. image annotation · 3. board workflow · 4. permissions
5. production view (no duplicates, accurate counts, filters, quick add, reordering,
   refusing unapproved work with reasons) · 6. deliverables (canvas connections,
   persistence after reload, independent review/revision, completion and pending
   changes after publishing) · 7. Roblox model/animation/effects and audio review
   (pixel checks on the WebGL canvas, playback, scrubbing, timestamped feedback,
   resources, broken files) and a UI file (UI tab, TextScaled, images, screen sizes,
   inspecting elements) · 8. navigation (canvas position, revision memory, `Esc`,
   deep links) · 9. permissions on the new features and live sync between sessions
10. your own Roblox files (`VERIFY_ASSETS=<folder>`: processing, fetched resources, and
    per animation the rig and how much the picture changes) · 11. select menus (keyboard,
    focus ring, contrast of every state in both themes, position, fullscreen) · 12. card
    covers (upload, choose, automatic, remove, both boards, compact thumbnails, live
    updates, viewer permissions).

## Known limitations

- Comment formatting is Markdown-lite (bold, italic, code, links, lists, mentions)
  rather than a WYSIWYG editor.
- Image feedback uses point pins; rectangular regions are supported by the data
  model and API but not yet drawable in the viewer.
- Version comparison links play/pause/seek between videos; it isn't frame-locked.
- Roblox previews are faithful for parts, rigs, keyframe animation and 2D UI layout,
  and approximate for effects, materials and text metrics (see above); curve
  animations, terrain, and SurfaceGuis on their parts in 3D aren't rendered. The demo's animation and effect files were authored with
  Forge's own writer (`src/server/roblox/writer.ts`) because no redistributable
  Studio exports of animations were available; the parser itself is verified against
  real Studio exports.
- Security-sensitive rate limits are shared through PostgreSQL; per-user API throttles
  and the media job queue are per process (with several instances, run the queue in one
  worker or move it to a durable queue).
- The Discord/Google OAuth and S3/R2 code paths are implemented but were only exercised
  locally (bundled storage, no live OAuth apps). Roblox fetching was tested against the
  live Open Cloud API with a real key (public catalog meshes, textures and UI images);
  the no-key download works for some older assets only.
