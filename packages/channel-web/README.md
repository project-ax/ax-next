# `@ax/channel-web`

The browser chat UI for ax-next. Tide design, assistant-ui plumbing, mocked backend for now.

## Getting started

```bash
pnpm install
pnpm --filter @ax/channel-web dev
```

Open http://localhost:5173. You'll see a login screen — click **Sign in with Google**. (It's a mock; no real OAuth round-trip happens. We just hand you a session cookie and pretend.)

You sign in as **Alice** (`alice@local`, regular user) by default. To sign in as the admin, hit `http://localhost:5173/api/auth/callback?user=u1` directly — that gives you the admin session, which unlocks the admin entries in the user menu.

## Two seeded users

| User | Email | Role |
|------|-------|------|
| `u1` | `admin@local` | admin |
| `u2` | `alice@local` | user |

## Mock data

Lives in `.mock-data/` at the package root. JSON files per collection: `users.json`, `agents.json`, `sessions.json`, `messages.json`, `mcp-servers.json`, `teams.json`. Gitignored. Survives Vite restarts.

To reset: `rm -rf .mock-data/` and restart the dev server. The next launch re-seeds from `mock/seed.ts`.

## Testing

```bash
pnpm --filter @ax/channel-web test
```

Tests cover: design tokens, mock store + auth + sessions + completions + admin endpoints, ported assistant-ui transport + adapters, every UI component, every state machine. ~120 tests, all hermetic (no shared state between tests).

## Building for production

```bash
pnpm --filter @ax/channel-web build
```

Outputs to `dist/`. The mock backend is **not** in the production bundle — it's loaded via dynamic import inside the Vite plugin's `configureServer` hook, which only runs in dev/preview. You can verify with:

```bash
grep -r "createMockHandler\|mockMiddleware" dist/ || echo "OK: mock not in production"
```

## When the real backend lands

The mock implements `/api/auth/*`, `/api/agents`, `/api/chat/*`, `/api/admin/*`. When Week 9.5 (`@ax/auth`, `@ax/http-server`, `@ax/agents`) and Week 10–12 (`@ax/conversations`, `@ax/channel-chat-ui`) ship, the migration is:

1. The React tree (`src/`) survives unchanged. URL constants stay the same.
2. `mock/` directory gets deleted.
3. The `configureServer` plugin in `vite.config.ts` gets removed.
4. `@ax/channel-web` becomes a plugin that registers HTTP routes against `@ax/http-server`. The handlers live where `mock/` used to.

See `docs/plans/2026-04-25-chat-ui-pulled-forward.md` for the full handoff context.

## What's NOT in the MVP

- File uploads (the attach button is disabled — `/api/files/*` isn't implemented).
- Search filtering (the search bar toggles a feature flag for "semantic" search; literal substring filtering needs an assistant-ui API that's still firming up).
- Team management UI (read-only list; full CRUD ships with Week 9.5).
- Real auth / real persistence / real LLM streaming.

## Manual smoke (12 steps)

See [`MANUAL_ACCEPTANCE.md`](./MANUAL_ACCEPTANCE.md) for the full runbook — login, send a message, admin flows, theme, collapse, edit-retry, agent switch.
