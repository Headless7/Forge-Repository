# Deploying Forge (Railway + Cloudflare R2 + Resend)

The setup this guide builds:

| Piece | Service | Rough cost |
| --- | --- | --- |
| App server (Next.js, background media work) | Railway, 1 instance | $5–20/month (usage) |
| Database | Railway PostgreSQL | included in Railway usage (~$5–10) |
| Uploaded files | Cloudflare R2, private bucket | ~$0.015/GB-month after 10 GB free, no download fees |
| Email (resets, invitations) | Resend | free up to 3,000 emails/month |
| Domain | any registrar (Cloudflare is convenient) | ~$10–15/year for .com |

Secrets (API keys, passwords) go **only** into the services' dashboards or your local `.env` —
never into chat, tickets or git.

---

## 1. Code (done)

- `railway.json` — build `npm run build`, migrate before every release
  (`npm run db:migrate:prod`), start `npm run start:next`, health check `/api/health`,
  one instance.
- `package.json` pins Node 24.
- `.gitignore` keeps out `.env`, `.data/` (local database and uploads), and the unrelated
  `tmp/`, `outputs/` and `prompt.txt`.

## 2. GitHub

1. Create a **private** repository on github.com (no README/licence — the project has them).
2. Push the local repository to it (`git remote add origin …` then `git push -u origin main`).
   Railway deploys every push to `main` from then on.

## 3. Cloudflare (domain + R2)

1. Domain: buy one (Cloudflare Registrar sells at cost) or add an existing one to Cloudflare.
   The app will live at e.g. `forge.yourdomain.com`.
2. R2 → **Create bucket** `forge-media` (location: automatic). Leave public access **off**.
   Create a second one, `forge-media-staging`, for testing before launch.
3. R2 → bucket → Settings → **CORS policy** (replace the origin with yours; for the staging
   bucket use `http://127.0.0.1:3100` and `http://localhost:3000`):

   ```json
   [
     {
       "AllowedOrigins": ["https://forge.yourdomain.com"],
       "AllowedMethods": ["GET", "HEAD", "PUT"],
       "AllowedHeaders": ["content-type", "range"],
       "ExposeHeaders": ["ETag", "Content-Length", "Content-Range", "Accept-Ranges"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

   (Browsers upload straight to R2 and the 3D viewer/audio player read files with `fetch`, so
   both need CORS.)
4. R2 → **Manage API tokens** → Create token: *Object Read & Write*, limited to the two
   buckets. Note the **Access Key ID**, **Secret Access Key** and your **Account ID**.

## 4. Resend (email)

1. Add your domain (e.g. `yourdomain.com`) and create the DNS records Resend lists (in
   Cloudflare DNS). Wait until it shows *Verified*.
2. Create an API key with *Sending access*.

## 5. Roblox

Create a **new** Open Cloud API key (creator dashboard → Open Cloud → API keys) with
`legacy-asset` → **manage**, and delete the old key (it was shared outside your machine).

## 6. Railway

1. railway.com → New project → **Deploy from GitHub repo** → pick the repository.
2. In the project: **+ New → Database → PostgreSQL**.
3. App service → **Variables** (Raw editor), fill in your values:

   ```
   APP_URL=https://forge.yourdomain.com
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   EMBEDDED_POSTGRES=false
   AUTH_SECRET=<48+ random characters>
   CRON_SECRET=<32+ random characters>
   TRUSTED_PROXY_HOPS=1
   REALTIME_DRIVER=postgres
   ENABLE_INPROCESS_JOBS=true
   DEMO_MODE=false
   REQUIRE_EMAIL_VERIFICATION=true

   STORAGE_DRIVER=s3
   S3_BUCKET=forge-media
   S3_REGION=auto
   S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
   S3_FORCE_PATH_STYLE=true
   S3_ACCESS_KEY_ID=<R2 access key id>
   S3_SECRET_ACCESS_KEY=<R2 secret>
   STORAGE_PUBLIC_ORIGIN=https://<ACCOUNT_ID>.r2.cloudflarestorage.com

   SMTP_URL=smtps://resend:<RESEND_API_KEY>@smtp.resend.com:465
   EMAIL_FROM=Forge <noreply@yourdomain.com>

   ROBLOX_OPEN_CLOUD_API_KEY=<new key>
   ```

   Random secrets: run `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`
   twice and paste the results. The server refuses to start with weak or placeholder secrets.
4. App service → Settings → **Networking → Custom domain** `forge.yourdomain.com`, then add the
   CNAME record Railway shows in Cloudflare DNS (*DNS only*, grey cloud). HTTPS is automatic.
5. Deploy. The log shows `Database migrations are up to date`, then the health check passes.
   Production starts empty: open the site, **Sign up** — the first account creates its studio.

## 7. Before inviting the team

- Upload an image, a video, an audio file and a Roblox file; open each preview; leave
  feedback; check the email for an invitation arrives.
- Railway → Postgres → Backups: turn on scheduled backups. R2: keep a copy of important
  files elsewhere or enable object versioning when available.
- Add an uptime check for `https://forge.yourdomain.com/api/health` (UptimeRobot / Better
  Stack free tier).
- Keep one app instance: background media work and some limits live in that process.
