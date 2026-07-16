# homegames-api

The central backend for the Homegames platform (`api.homegames.io`). A single vanilla-Node `http` server (no framework) plus a separate publish-validation worker.

## Responsibilities

- **Developer auth & accounts** — signup/login with PBKDF2 password hashing, short-lived HS256 JWTs (15 min, refreshed via `/auth/refresh`), email verification and password-reset codes via AWS SES.
- **Game catalog** — public listing/search/detail of published games (a game is public once it has a `gameVersions` doc with `published: true`), featured flag, NSFW filtering, play/download counters, comments.
- **Developer Studio backend** — the browser IDE served by [homegamesio](../homegamesio): create game (provisions a Forgejo repo + webhook + GPLv3 LICENSE + starter template), read/write/commit files, version history/restore, clone credentials, thumbnails, publish, and the LLM "modify my game" flow (currently gated off via `AI_EDITS_ENABLED` — local models aren't good/fast enough for full game generation).
- **Docs assistant** — the "ask something" box on docs.html: `POST /docs/ask` queues a `DOCS_QUESTION` job for the [worker](../worker)'s LLM, `GET /docs/ask/:id` polls for the answer. Heavily rate-limited (1/30s and 30/day per IP, global in-flight cap); gated by `DOCS_ASSISTANT_ENABLED` (on by default). See `docs-assistant.js`.
- **Publishing pipeline** — validates submitted commits before they go live (see below).
- **Asset storage** — images/audio/fonts uploaded to MongoDB (binary `documents` collection), magic-byte MIME detection, NSFW image classification (nsfwjs/TensorFlow), in-memory LRU byte cache (192MB) for serving, tags/metadata, public asset catalog.
- **TLS cert intake for self-hosted servers** — the client side of the `*.homegames.link` cert flow (see below).
- **Sessions** — proxies hosted-session creation to a Homenames instance ([homegames-core](../homegames-core)) at `HOMENAMES_URL`.
- **Local/offline play** — builds per-game local-play manifests, browser asset bundles, and self-contained single-file HTML downloads (inlining the [homegames-client](../homegames-client) UMD bundle from `CLIENT_BUNDLE_PATH`).
- **Admin/moderation console** — users/games/assets/comments listings, stats, publish-request approve/reject, NSFW overrides, featured toggle, support messages, developer deletion.
- Plus: blog, `/contact` support messages, `/bugs` reports (log-only), and an S3-backed podcast feed.

## Architecture

- `index.js` — the HTTP server. CORS is wide open; routing lives in `router.js` (regex route maps per method, with `requiresAuth` / `requiresVerified` gates; admin handlers additionally check `isAdmin`).
- `worker.js` — a separate process (`node worker.js`) consuming the RabbitMQ `publish_requests` queue. Distinct from the sibling [worker](../worker) repo, which consumes the `homegames-jobs` queue (CERT_REQUEST/LLM_REQUEST jobs this API publishes).
- Key modules: `auth.js` (account flows), `crypto.js` (JWT/PBKDF2), `db.js` (all MongoDB access), `email.js` (SES), `forgejo.js` (Forgejo REST client with admin-token + Sudo impersonation), `handlers.js` (most non-studio routes), `studio-handlers.js` (studio/publish/LLM/webhook, embedded squish-142 starter templates), `ast-scanner.js` (acorn safety scan), `detect.js` (magic-byte MIME), `nsfw.js`, `asset-cache.js`, `local-play.js`, `queue.js` (RabbitMQ publishers), `models.js`, `helpers.js`.

### Publishing flow

1. `POST /studio/games` creates the Mongo game record + Forgejo repo (auto-init, push webhook to `${API_PUBLIC_URL}/webhook/push`, GPLv3 LICENSE + template committed).
2. Edits are commits via `/studio/games/:id/save` (or the LLM flow: `/studio/games/:id/llm-modify` → RabbitMQ `LLM_REQUEST` → the [worker](../worker) → `POST /internal/llm-result` → committed to the repo).
3. Forgejo pushes hit `POST /webhook/push` (HMAC-verified with `FORGEJO_WEBHOOK_SECRET`), creating a build record.
4. `POST /studio/games/:id/publish` (requires description, thumbnail, and edits beyond the starter template) enqueues to `publish_requests`.
5. `worker.js` validates: index.js present and ≤5MB, LICENSE matches `gpl-3.0.txt` exactly, size limits (5MB/file, 20MB total), AST safety scan of every `.js` (bans Node built-ins, dynamic require, eval, etc. — only `squish-NNN` and relative requires allowed), sandboxed Docker run via homegames-common's `dockerHelper.validateGame` (`--network=none`), squishVersion/multiplayer/localPlayable derivation, NSFW checks. On success writes a published `gameVersions` doc.
6. Admins can approve/reject via `POST /admin/request/:id/action`.

### Cert flow

For a self-hosted server to serve HTTPS under `<md5(publicIp)>.homegames.link`:

1. `GET /cert-status` — returns the subdomain (`certDomain`) bound to the caller's public IP (rightmost `X-Forwarded-For` hop behind nginx, so not spoofable) plus any existing cert.
2. The client generates its keypair **locally** and submits only a CSR to `POST /request-cert` (rate-limited; rejected unless the CSR common name matches the IP-bound subdomain; gated by `CERTS_ENABLED`).
3. The request is enqueued as a `CERT_REQUEST` on `JOB_QUEUE_NAME`; the [worker](../worker) performs the Let's Encrypt dns-01 order via Route 53 and writes the cert to the Mongo `certs` collection.
4. The client polls `GET /cert-status` until the cert appears.

## Data stores

- **MongoDB** (`DB_NAME`, default `homegames`): `users`, `games`, `gameVersions`, `publishRequests`, `builds`, `llmRequests`, `docsQuestions`, `assets` + `documents` (binary blobs), `sessions`, `comments`, `blog`, `supportMessages`, `contentRequests`, `certs`. Indexes created by `initialize_mongo.sh`.
- **RabbitMQ**: `publish_requests` (consumed by this repo's `worker.js`) and `JOB_QUEUE_NAME` (default `homegames-jobs`, consumed by the sibling worker repo).
- **Forgejo** (self-hosted git): game source hosting; per-user accounts with passwords derived via HMAC(`forgejo-user-secret`, userId) — never stored.
- **S3** (read-only): `podcast.homegames.io` episodes.
- Assets live in Mongo, not S3; there is no active DynamoDB/Redis/Elasticsearch use (leftovers only).

## Endpoints (summary)

Public: `/health`, `/ip`, `/games` (+detail/versions/source-tree/source/local-manifest/asset-bundle/download/comments), `/catalog/assets`, `/assets/:id`, `/profile/:devId`, `/blog`, `/podcast`, `/cert-status`, `/request-cert`, `/sessions`, `/contact`, `/bugs`, `/auth/signup|login|forgot|reset`, `/studio/templates`, `/docs/ask` (+ `/docs/ask/:id`).

Authenticated (JWT): `/auth/me|refresh|verify|resend`, `/my-games`, `/assets`, `/profile`, comments/asset/game mutations, and the full `/studio/*` surface (create/save/restore/publish/llm/clone/thumbnail — most require a verified email).

Admin: `/admin/users|games|assets|comments|stats|sessions|support_messages|publish_requests`, feature/NSFW toggles, publish approve/reject, developer deletion.

Machine-to-machine: `POST /webhook/push` (Forgejo HMAC), `POST /internal/llm-result` and `POST /internal/docs-answer` (`LLM_WORKER_SECRET` bearer).

Nearly everything user-facing is rate-limited per IP (login, signup, cert requests, comments, session creation, asset uploads, etc.).

## Running

Requires Node ≥ 18, MongoDB, RabbitMQ, a Forgejo instance, and Docker (for the publish worker's sandbox).

```sh
npm install
node index.js     # API server (PORT, default 80)
node worker.js    # publish-request validator (separate process)
```

Configuration is env-driven (`config.js`): `JWT_SECRET` (**required** — process exits without it), `DB_HOST/DB_PORT/DB_USERNAME/DB_PASSWORD/DB_NAME`, `QUEUE_HOST`, `JOB_QUEUE_NAME`, `LLM_WORKER_SECRET`, `AI_EDITS_ENABLED` (default off), `DOCS_ASSISTANT_ENABLED` (default on), `CERTS_ENABLED`, `CERT_DOMAIN`, `AWS_ROUTE_53_HOSTED_ZONE_ID`, `FORGEJO_WEBHOOK_SECRET`, `API_PUBLIC_URL`, `WEB_PUBLIC_URL`, `HOMENAMES_URL`, `HOMENAMES_API_SECRET`, `SES_REGION`/`SES_FROM_ADDRESS` (unset = codes logged instead of emailed), `PORT`, `CLIENT_BUNDLE_PATH`. Forgejo credentials are read as files from `$CREDENTIALS_DIRECTORY` (`forgejo-admin-token`, `forgejo-user-secret` — required at startup).

Maintenance scripts: `backfill-display-names.js`, `backfill-game-play-meta.js`, `rotate-forgejo-secret.js` (all idempotent), `initialize_mongo.sh`.

## Related repos

- **[homegamesio](../homegamesio)** — the website/studio frontend consuming almost every endpoint here
- **[worker](../worker)** — consumes `homegames-jobs` (certs + LLM), posts back to `/internal/llm-result`
- **[homegames-core](../homegames-core)** — Homenames session manager this API proxies session creation to; also downloads game source via the public source endpoints
- **[homegames-common](../homegames-common)** — `dockerHelper.validateGame` used by `worker.js`
- **[homegames-client](../homegames-client)** — UMD bundle inlined into offline downloads
- **[homegames.link](../homegames.link)** — the domain the cert flow issues certs under

## Known cruft / caveats (as of this writing)

- The Forgejo URL is currently hardcoded in `config.js` (the env override is commented out).
- `local.env` / `prod.env` in the working directory contain real secrets — they're untracked, but keep them out of commits.
- The legacy publish paths (`/public_publish`, `/games/:id/publish`) predate the studio flow; the github variant is broken (`downloadFromGithub` no longer exists in helpers).
- `POST /admin/blog` is only JWT-gated, not admin-gated — any authenticated user can post.
- `/map`, `/verifyDns`, `/github_link` are stubs; `receiver.js`, `tes.js`, `dump.rdb`, and the DynamoDB-shaped code in `models.js` are dead; `db.updateGame` sets `created: game.description` (bug).
- `queue.js`'s `publishRequestMessage` hardcodes `amqp://localhost` and asserts a different queue than it publishes to.

## License

GPL-3.0
