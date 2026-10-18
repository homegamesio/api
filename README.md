# Homegames connection API

The active `index.js` serves IP/certificate helpers and RTC signaling. Games, source, assets, progress and user exports belong to players. No account, catalog, Studio publishing, profile, moderation or docs-AI routes are registered.

## Run

Use Node 24, `npm ci --omit=dev`, then run `node index.js`. The default listener is `127.0.0.1:8004` behind nginx (`BIND_HOST` and `PORT` override it). RTC is enabled by default; set `RTC_ENABLED=false` to disable it. Signaling and process health do not require MongoDB, RabbitMQ, JWT secrets or Forgejo.

- `GET /health`: process health plus certificate-runner availability; a certificate outage does not make the HTTP process unhealthy.
- `GET /ip`: caller address.
- `POST /request-cert`: `{csr, requestId?}`; validates all CSR names against the caller's assigned homegames.link domain, bounds/rate-limits requests and queues issuance.
- `GET /cert-status?requestId=…`: certificate/status for this caller and request.
- `POST /verifyDns`: compatibility acknowledgement only; does not change DNS.
- `/rtc`: WebSocket signaling for private rooms. No `/rooms` discovery route is exposed without an explicitly configured legacy catalog adapter. Private hosts must maintain their application heartbeat lease.

Enable issuance with `CERTS_ENABLED=true` after configuring and testing the [AL2023 cutover runbook](deploy/certificates-al2023.md). The API process owns a Mongo-backed background runner; it needs an explicit HTTPS `ACME_DIRECTORY_URL`, `ACME_EMAIL`, hosted-zone ID and persistent private ACME account-key path. Mongo uses `MONGODB_URI` or `DB_HOST`/`DB_PORT`, `DB_NAME`, and optional `DB_USERNAME`/`DB_PASSWORD`/`DB_AUTH_SOURCE`. EC2 uses its instance role for Route 53. The home server keeps its TLS private key and submits a signed CSR; only public certificate bytes return. The API no longer publishes certificate messages to RabbitMQ or requires the Mac worker.

Jobs are durable and request IDs bind to the observed IP and CSR. Ambiguous running attempts pause for operator review and block further issuance for that network. A returned certificate is retained while result persistence retries; saved attempts recover after restart. Existing certificate records and legacy request IDs remain readable. Old broker work must be imported/reconciled with the old consumers stopped before enabling the new runner. See `scripts/certificates.js` for local inspection, cleanup, completion, reviewed retry and safe migration; there is no public administration route.

Deployment coordinates can be filled in later: copy [deploy/deployment.env.example](deploy/deployment.env.example) to `deploy/deployment.env`, enter the SSH target, remote paths, unit and staging settings, then run `npm run check:deployment` with Node 24. This validates locally without connecting or deploying. Keep API runtime settings in a separate copy of [deploy/homegames-api.env.example](deploy/homegames-api.env.example); both local `.env` copies are ignored by Git.

With certificate issuance disabled, `/cert-status` returns `certificatesEnabled: false` without opening the database or performing DNS lookups. Optional self-host certificates remain supported; their persistent infrastructure is separate from the database-free static player/signaling path. See the [local-ownership audit and cutover checklist](../homegames-core/docs/local-ownership-audit.md) before retiring existing services.

`RTC_STUN_URLS`, `RTC_TURN_URLS` and `RTC_TURN_SECRET` configure ICE. `RTC_TRUST_PROXY=true` trusts a configured loopback reverse proxy; it must overwrite forwarding headers. HTTP helpers use the final `X-Forwarded-For` address; common signaling uses `X-Real-IP`. Forward `/rtc` upgrades to this process. Gameplay and game-copy bytes travel peer to peer, or through TURN when required.

Signaling defaults to 64 simultaneous sockets per IP, 120 connection attempts/minute per IP, 60 room registrations/minute per IP, and 600 registrations/minute process-wide. Configure these with the four `RTC_*` admission settings in the deployment environment example. Registration budgets include joins and invalid attempts and survive socket reconnects. They reset when the API restarts and are not shared across multiple API processes. Coturn still needs independent allocation, bandwidth and network-egress controls; anonymous invitations do not prevent a determined user from using granted relay credentials for other traffic.

Certificate status/intake share a 120-operations/minute/IP and 600/minute process budget, with at most four concurrent operations per IP and 32 total. New certificate submissions retain their additional ten/hour/IP cap. Bodies have a five-second deadline; Mongo pools and operation waits are bounded. Health remains available while these limits reject excess certificate traffic.

The active certificate adapter is [`acme-dns-client.js`](acme-dns-client.js), using Node cryptography and `@peculiar/x509`, without `acme-client`, Forge or Axios. It supports the DNS-01 account/order flow used here, persistent RSA and P-256/P-384/P-521 account keys, same-origin HTTPS CA endpoints, bounded responses/polling, and cancellation on loss of the durable job lease. Only explicit ACME `badNonce` rejections are retried; network errors, rate limits and server failures remain review cases. External-account binding, account rollover and revocation are not implemented; use an appropriate operator tool for those operations. Keep live staging issuance and renewal as release gates.

## Retired source and deployment

`router.js`, account/content handlers, Forgejo integration and `worker.js` (publishing) remain as historical source/tooling. The active entry point does not load them. Deploying this revision does not erase their databases or stop old worker services: back up stored material and retire those deployments separately. Do not launch the publish worker as part of the connection service.

Run `npm test` for connection/certificate checks and `npm run test:certificates:integration` for isolated real-Mongo/HTTP/HTTPS/restart tests (`mongod` must be available, or set `MONGOD_PATH`). The integration harness creates and removes its own database directories and binds ephemeral loopback ports; it never uses production environment credentials. The CA and DNS are mocked. Retired dependencies are preserved in [legacy/](legacy/README.md) for deliberate maintenance installs; they are excluded from the active lockfile. `npm run test:legacy` requires that separate installation.

License: MIT; see [LICENSE.md](LICENSE.md). Third-party dependencies retain their own notices.
