# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm start` — run the server (`node server.js`)
- `npm run dev` — run with `--watch` for auto-restart on changes
- No test suite or linter is configured.

Server requires a `.env` file (see `.env.example`). `ADMIN_PASSWORD` and `VIEW_PASSWORD` are mandatory — the server exits at startup if either is missing.

## Architecture

A warehouse activity tracker: each worker has a per-user "switch" page (`/user.html?id=<uuid>`) where they pick their current state (`OFF`, `Przerwa`, `Zbieranie`, `Pakowanie`, `Rozkładanie`, `Inne`); an admin dashboard (`/`) shows everyone's current state and daily totals in real time. UI strings are in Polish.

### Three top-level modules

- **`server.js`** — Express app. REST API under `/api/*`, plus an SSE endpoint `/api/events` for live dashboard updates. Serves static frontend from `public/`. Boots the DB, schedules cron jobs, then listens.
- **`db.js`** — `mysql2` connection pool exported as a promise-API. Exposes `initDB()` which runs `CREATE TABLE IF NOT EXISTS` for `users`, `activity_logs`, `wms_data`, then runs idempotent `ALTER TABLE` migrations (checked via `SHOW COLUMNS` / `information_schema`). **All schema changes belong here as another migration block — don't write separate migration files.**
- **`sync.js`** — Optional MSSQL → MySQL pull of WMS package data, gated by `MSSQL_SYNC_ENABLED=true`. Incremental: reads `MAX(id)` from `wms_data`, fetches rows with `Id > lastId` from MSSQL, `INSERT IGNORE`s into MySQL. On first run (empty table) it backfills `WMS_DATA_RETENTION_DAYS` of history. Cleanup pass at the end deletes rows older than the retention window.

### Activity log state model

`activity_logs` is the source of truth for "who is in what state right now":
- A row with `end_time IS NULL` is the user's **active session**.
- Changing state (`POST /api/logs`) closes any open row for that user (`SET end_time = NOW(), duration_seconds = TIMESTAMPDIFF(...)`) and inserts a new row — **unless** the new state is `OFF`, in which case it only closes the active row (no `OFF` row is created). The dashboard query treats "no open row" as `OFF`.
- The user's `name` is copied into `activity_logs.user_name` at insert time so logs survive user rename/delete.
- Users are soft-deleted (`users.deleted = 1`); list/detail endpoints filter on `deleted = 0`.

### Real-time updates

Every state-changing endpoint calls `broadcastUpdate({...})`, which writes an SSE `event: update` to every connected client in `sseClients`. The frontend (`public/app.js` → `connectSSE`) reconnects automatically on error and also polls every 10s (dashboard) / 30s (user page) as a backup. `setPos()` in `app.js` is **optimistic** — it updates the UI immediately and rolls back on fetch failure.

### Scheduled jobs (node-cron, started inside `app.listen` callback)

- WMS sync — daily at `MSSQL_SYNC_HOUR:00` (default 20:00). Also runs once at startup.
- Auto-OFF reset — daily at `AUTO_OFF_TIME` (default 23:59). Closes every open `activity_logs` row and broadcasts `{ type: 'RESET_ALL' }` so all clients refresh.

### Auth

Two shared passwords, no per-user accounts:
- `VIEW_PASSWORD` — gates the dashboard behind a login overlay; stored in `sessionStorage.isViewAuthenticated`.
- `ADMIN_PASSWORD` — required in the JSON body of every mutating admin endpoint (create/update/delete user). Frontend stashes it in `sessionStorage.adminPassword` after admin login and replays it on each call. There is no session token — the password is the credential on every request.

### Frontend

Plain HTML/CSS/JS in `public/`, no build step. `app.js` is shared between `index.html` (dashboard) and `user.html` (switch) — it branches on whether `#userGrid` exists in the DOM.

## Notes

- `data/database.sqlite` and `backup_/` are legacy artifacts from a pre-MySQL version; current code does not touch them.
- Times are stored in MySQL with `timezone: 'Z'` on the pool; WMS timestamps from MSSQL are UTC (`DateCreatedUtc`).
