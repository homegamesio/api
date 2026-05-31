# Homegames API

The backend API for the Homegames platform. Handles user accounts, game management, asset storage, game publishing, and the developer studio.

## What it does

- **User auth** — signup, login, JWT-based sessions
- **Game management** — create, update, delete, list, and search games
- **Asset storage** — upload and serve images, audio, and fonts with magic byte validation and NSFW classification
- **Publishing pipeline** — submit games for validation via a RabbitMQ queue, processed by a worker that runs games in Docker containers
- **Developer studio** — API endpoints for the browser-based game editor (file management, versioning, builds via Forgejo)
- **Admin tools** — manage support messages, publish requests, featured games, and developer accounts

## Stack

- Node.js (vanilla `http` server, no framework)
- MongoDB (users, games, assets, binary document storage)
- RabbitMQ (publish request queue)
- Forgejo (game source code hosting and versioning)
- NSFWJS + TensorFlow.js (image classification)

## Setup

Requires: Node.js >= 18, MongoDB, RabbitMQ, Forgejo

```
npm install
node index.js
```

Configure via environment variables (see `config.js`):

- `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_NAME` — MongoDB connection
- `QUEUE_HOST` — RabbitMQ host
- `JWT_SECRET` — required, used for auth tokens
- `FORGEJO_URL`, `FORGEJO_ADMIN_TOKEN` — Forgejo instance
- `API_PUBLIC_URL` — public-facing URL of this API
- `HOMENAMES_URL` — URL of the Homenames session manager

The publish request worker runs separately:

```
node worker.js
```

## Related repos

- **homegames-core** — game session server
- **homegamesio** — public website and developer studio frontend
- **squish** — game state serialization library

## License

GPL-3.0
