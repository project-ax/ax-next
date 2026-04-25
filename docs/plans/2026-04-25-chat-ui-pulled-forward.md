# Chat UI pulled forward (`@ax/channel-web`) — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stand up the user-facing chat UI now (in parallel with Week 7–9 follow-ups), backed by an in-process mock API under `/api/*` and `/api/admin/*` so it has zero dependency on Week 9.5 / Week 10–12 deliverables. Implement the Tide visual design from `design_handoff_tide/` using assistant-ui primitives where they fit.

**Architecture:** A new workspace package `packages/channel-web` containing a Vite + React + TypeScript SPA. Mock backend lives in a Vite middleware (`vite.config.ts → configureServer`) that persists state to JSON files under `.mock-data/` (gitignored). Assistant-ui plumbing (transport, runtime, history adapter, thread-list adapter) is ported from `~/dev/ai/ax/ui/chat/src/lib/` with URL prefixes rebased from `/v1/*` to `/api/*` and `/api/auth/*` shape preserved. UI shell follows Tide tokens + structure pixel-by-pixel; assistant-ui `ThreadPrimitive` / `MessagePrimitive` / `ComposerPrimitive` / `ActionBarPrimitive` render the timeline + composer with Tide CSS class names. When real backend lands (Week 9.5 + 10–12), the mock middleware is deleted and the package registers HTTP routes against `@ax/http-server`; the React tree survives unchanged.

**Tech Stack:** React 19 + Vite 6 + TypeScript 6 + `@assistant-ui/react` + `@assistant-ui/react-ai-sdk` + `@assistant-ui/react-markdown` + `ai` + `@ai-sdk/react` + `assistant-stream` + `lucide-react`. Vitest + jsdom for unit tests; Playwright deferred to Week 10–12 (acceptance is manual smoke + targeted vitest).

**Out of scope:** Real auth (mocked), real chat completions (mocked), real persistence (JSON file), team management form (placeholder + TODO), Playwright tests, Slack channel, audit, canary scanner, mobile responsive polish beyond what falls out of Tide's media query.

**Boundary review:** N/A — this PR adds no service hooks, no subscriber hooks, no IPC actions. The package is a frontend SPA + a dev-only mock server. When Week 9.5 / 10–12 wire real backend, that PR will own the boundary review for `http:register-route` and the new admin endpoints.

**Security note:** The mock backend speaks plain HTTP on Vite's dev server, accepts any session cookie value, and stores fixture data in plaintext JSON. **Production gates this behind real `@ax/auth` + `@ax/http-server` from Week 9.5.** The mock includes a `MOCK_BACKEND_WARNING.md` at the package root so nobody mistakes it for real. No `security-checklist` is invoked here — the trust-boundary slice belongs to Week 9.5.

---

## Layout produced by this plan

```
packages/channel-web/
├── package.json
├── tsconfig.json
├── vite.config.ts                  # mounts mock middleware in dev only
├── vitest.config.ts
├── index.html
├── public/
│   └── ax-logo.svg                 # copied from design_handoff_tide
├── src/
│   ├── main.tsx
│   ├── App.tsx                     # auth gate + AssistantRuntimeProvider
│   ├── index.css                   # Tide tokens (root + dark)
│   ├── components/
│   │   ├── Sidebar.tsx
│   │   ├── AgentChip.tsx
│   │   ├── AgentMenu.tsx
│   │   ├── NewSessionButton.tsx
│   │   ├── SessionList.tsx
│   │   ├── SessionRow.tsx
│   │   ├── UserMenu.tsx
│   │   ├── SessionHeader.tsx
│   │   ├── Thread.tsx              # assistant-ui Thread w/ Tide styling
│   │   ├── Composer.tsx
│   │   ├── MarkdownText.tsx
│   │   ├── LoginPage.tsx
│   │   └── admin/
│   │       ├── AdminPanel.tsx
│   │       ├── AgentForm.tsx
│   │       └── McpServerForm.tsx
│   ├── lib/
│   │   ├── transport.ts            # ported AxChatTransport, /api/chat/completions
│   │   ├── runtime.tsx             # ported useAxChatRuntime
│   │   ├── thread-list-adapter.ts  # ported, /api/chat/sessions
│   │   ├── history-adapter.ts      # ported, /api/chat/sessions/:id/history
│   │   ├── auth.ts                 # /api/auth/*
│   │   ├── agents.ts               # /api/agents
│   │   ├── admin.ts                # /api/admin/*
│   │   └── theme.ts
│   └── __tests__/
│       ├── transport.test.ts
│       ├── thread-list-adapter.test.ts
│       ├── history-adapter.test.ts
│       └── agent-switch.test.ts
└── mock/
    ├── server.ts                   # connect-style middleware exported to vite.config.ts
    ├── store.ts                    # JSON file persistence under .mock-data/
    ├── seed.ts                     # default agents + one team agent + admin user
    ├── auth.ts
    ├── chat.ts                     # sessions + history + completions SSE
    ├── agents.ts
    ├── admin/
    │   ├── agents.ts
    │   ├── mcp-servers.ts
    │   └── teams.ts
    └── __tests__/
        ├── chat-sse.test.ts
        ├── sessions.test.ts
        └── admin-agents.test.ts
```

`.mock-data/` lives at the **package root** (i.e. `packages/channel-web/.mock-data/`), is ignored by `.gitignore`, and contains: `users.json`, `sessions.json`, `messages.json`, `agents.json`, `mcp-servers.json`, `teams.json`.

---

## API surface (what the mock implements, what the real backend must match)

```
GET    /api/auth/get-session              → { user } | 401
POST   /api/auth/sign-in/social           body: { provider, callbackURL }
                                          → { url } (mock auto-completes)
POST   /api/auth/sign-out                 → 204

GET    /api/agents                        → { agents: Agent[] }   (visible to caller)
GET    /api/chat/sessions                 → { sessions: Session[] }
POST   /api/chat/sessions                 body: { agentId } → { id }
GET    /api/chat/sessions/:id/history     → { messages: HistoryMessage[] }
PATCH  /api/chat/sessions/:id             body: { title? }
DELETE /api/chat/sessions/:id             → 204
POST   /api/chat/completions              OpenAI-shaped request → SSE
                                          response (text/event-stream)

GET    /api/admin/agents                  → { agents: Agent[] }   (admin sees all)
POST   /api/admin/agents                  body: AgentInput → { id }
PATCH  /api/admin/agents/:id              body: Partial<AgentInput>
DELETE /api/admin/agents/:id              → 204

GET    /api/admin/mcp-servers             → { servers: McpServer[] }
POST   /api/admin/mcp-servers             body: McpServerInput → { id }
PATCH  /api/admin/mcp-servers/:id         body: Partial<McpServerInput>
DELETE /api/admin/mcp-servers/:id         → 204
POST   /api/admin/mcp-servers/:id/test    → { ok, error? }

GET    /api/admin/teams                   → { teams: Team[] }     (placeholder)
```

All `/api/admin/*` endpoints check `user.role === 'admin'` and return 403 otherwise. All `/api/*` endpoints require a session cookie and return 401 otherwise. The mock issues a `mock-session=<userId>` cookie; the real backend will use BetterAuth-shaped cookies from `@ax/auth`.

---

## Task 1: Scaffold the package

**Files:**
- Create: `packages/channel-web/package.json`
- Create: `packages/channel-web/tsconfig.json`
- Create: `packages/channel-web/vitest.config.ts`
- Create: `packages/channel-web/vite.config.ts` (placeholder, no mock yet)
- Create: `packages/channel-web/index.html`
- Create: `packages/channel-web/src/main.tsx` (renders `<App />`)
- Create: `packages/channel-web/src/App.tsx` (renders `<div>boot</div>`)
- Create: `packages/channel-web/src/index.css` (empty for now)
- Create: `packages/channel-web/.gitignore` (`.mock-data/`, `dist/`)
- Modify: root `.changeset/chat-ui-pulled-forward.md` (new changeset)

**Step 1: Write the failing baseline test**

`packages/channel-web/src/__tests__/boot.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { App } from '../App';

describe('boot', () => {
  it('mounts the App without throwing', () => {
    const { container } = render(<App />);
    expect(container.textContent).toContain('boot');
  });
});
```

**Step 2: Run it — must fail**

```
pnpm --filter @ax/channel-web test
```

Expected: package not yet a workspace member or vitest-react-jsx not configured → red.

**Step 3: Add package.json + tsconfig + vitest.config + minimal App.tsx**

`packages/channel-web/package.json`:
```json
{
  "name": "@ax/channel-web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --build && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@ai-sdk/react": "^3.0.136",
    "@assistant-ui/react": "^0.12.19",
    "@assistant-ui/react-ai-sdk": "^1.3.14",
    "@assistant-ui/react-markdown": "^0.12.6",
    "ai": "^6.0.134",
    "assistant-stream": "^0.3.6",
    "lucide-react": "^0.474.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "remark-gfm": "^4.0.1"
  },
  "devDependencies": {
    "@testing-library/react": "^16.0.0",
    "@types/react": "^19.0.8",
    "@types/react-dom": "^19.0.3",
    "@vitejs/plugin-react": "^4.3.4",
    "jsdom": "^26.0.0",
    "typescript": "^6.0.3",
    "vite": "^6.4.2",
    "vitest": "^4.1.4"
  }
}
```

`packages/channel-web/tsconfig.json`: extends `../../tsconfig.base.json`; sets `jsx: "react-jsx"`, `lib: ["ES2023","DOM","DOM.Iterable"]`, `moduleResolution: "bundler"`, `outDir: "./dist"`, `include: ["src", "mock"]`.

`packages/channel-web/vite.config.ts`:
```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});
```

`packages/channel-web/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: { environment: 'jsdom', globals: false, include: ['src/**/*.test.{ts,tsx}', 'mock/**/*.test.ts'] },
});
```

`packages/channel-web/index.html`: standard Vite root that mounts `/src/main.tsx`.

`src/main.tsx`:
```tsx
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';
createRoot(document.getElementById('root')!).render(<App />);
```

`src/App.tsx`:
```tsx
export const App = () => <div>boot</div>;
```

**Step 4: Run test — must pass**

```
pnpm install
pnpm --filter @ax/channel-web test
```

Expected: 1 passed.

**Step 5: Verify the workspace `pnpm build` still works**

```
pnpm build
```

Expected: green across all packages including the new `@ax/channel-web` (note: `pnpm build` runs `tsc --build` only; `vite build` runs only via `pnpm --filter @ax/channel-web build`).

**Step 6: Commit**

```bash
git add packages/channel-web .changeset/chat-ui-pulled-forward.md
git commit -m "feat(channel-web): scaffold package with vite + react + vitest"
```

---

## Task 2: Tide design tokens

Establish `--bg`, `--ink`, `--accent`, `--rule`, etc. as CSS custom properties at `:root` plus `:root[data-theme="dark"]` and the `prefers-color-scheme: dark` mirror, exactly matching the table in `design_handoff_tide/README.md`. Also the typography variables (`--sans`, `--mono`, `--serif`), shadow tokens, and a `box-sizing: border-box` reset. Load IBM Plex Sans + Mono from Google Fonts in `index.html`.

**Files:**
- Modify: `packages/channel-web/index.html` (preconnect + Plex link)
- Modify: `packages/channel-web/src/index.css` (full token set)
- Create: `packages/channel-web/src/__tests__/theme.test.ts`

**Step 1: Failing test**
```ts
import { describe, it, expect, beforeAll } from 'vitest';
import '../index.css?inline';

describe('design tokens', () => {
  it('declares Tide palette on :root', () => {
    const css = (window.getComputedStyle as any) ? '' : '';
    // We can't read `:root` vars without mounting; test sources instead:
    const fs = require('node:fs') as typeof import('node:fs');
    const src = fs.readFileSync(__dirname + '/../index.css', 'utf-8');
    for (const tok of ['--bg', '--ink', '--accent', '--rule', '--surface-raised',
                       '--bg-deep', '--ink-soft', '--ink-mute', '--ink-ghost',
                       '--accent-soft', '--you-wash', '--you-ink', '--danger',
                       '--shadow-sm', '--shadow-md', '--sans', '--mono', '--serif']) {
      expect(src).toContain(tok);
    }
    expect(src).toContain('[data-theme="dark"]');
    expect(src).toContain('prefers-color-scheme: dark');
  });
});
```

**Step 2: Run it — fails (tokens not present)**
**Step 3:** Paste the full token block from `design_handoff_tide/Tide Sessions.html` `:root` (lines 18–80) into `src/index.css`. Add the Plex Sans + Mono `<link>` to `index.html` (matching `design_handoff_tide/Tide Sessions.html` lines 7–9).
**Step 4: Run it — passes**
**Step 5: Commit**

```bash
git commit -am "feat(channel-web): add Tide design tokens (light + dark)"
```

---

## Task 3: Mock store with JSON-file persistence

A small synchronous-write store (`fs.writeFileSync`) keyed by collection name. Survives Vite restarts. Fresh on first launch via `seed.ts`.

**Files:**
- Create: `packages/channel-web/mock/store.ts`
- Create: `packages/channel-web/mock/seed.ts`
- Create: `packages/channel-web/mock/__tests__/store.test.ts`

**Step 1: Failing test**
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store';

describe('Store', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mock-store-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('persists across Store instances', () => {
    const a = new Store(dir);
    a.collection<{ id: string }>('agents').upsert({ id: 'a1' });
    const b = new Store(dir);
    expect(b.collection<{ id: string }>('agents').list()).toEqual([{ id: 'a1' }]);
  });

  it('seeds the default fixture set on first read of an empty dir', () => {
    const s = new Store(dir);
    s.seed();
    expect(s.collection<{ id: string }>('agents').list().length).toBeGreaterThanOrEqual(2);
    expect(s.collection<{ id: string }>('users').list().length).toBeGreaterThanOrEqual(1);
  });
});
```

**Step 2: Run — red.**
**Step 3:** Implement `Store` with `collection<T>(name)` returning `{ list(), get(id), upsert(row), remove(id) }`. Each collection is a JSON file in `dir/<name>.json`. `seed()` writes default rows from `seed.ts` only if the file is missing. Default seeds:
- `users.json`: `{ id: 'u1', email: 'admin@local', name: 'Admin', role: 'admin' }`, `{ id: 'u2', email: 'alice@local', name: 'Alice', role: 'user' }`
- `agents.json`: `{ id: 'tide', owner_id: 'u1', owner_type: 'user', name: 'tide', tag: 'work', desc: 'your default work agent', color: '#7aa6c9', system_prompt: '...', allowed_tools: [], mcp_config_ids: [], model: 'claude-sonnet-4-6' }`, `{ id: 'mercy', ... }`, `{ id: 'team-engineering', owner_id: 't1', owner_type: 'team', ... }`
- `teams.json`: `{ id: 't1', name: 'Engineering', members: ['u1','u2'] }`
- `mcp-servers.json`: `[]`
- `sessions.json`: `[]`
- `messages.json`: `[]`

**Step 4: Run — green.**
**Step 5: Commit:** `feat(channel-web): mock store with JSON file persistence`.

---

## Task 4: Mock auth middleware

`mock/auth.ts` exposes a connect-style middleware that mounts under `/api/auth/*` and a helper `requireSession(req)` re-used by every other mock route. Sign-in writes `mock-session=<userId>` (httpOnly false in mock so we can poke it from tests), sign-out clears it.

**Files:**
- Create: `packages/channel-web/mock/auth.ts`
- Create: `packages/channel-web/mock/__tests__/auth.test.ts`

**Step 1: Failing test**: simulate `getSession` (no cookie → 401), `signIn social provider=google → 200 with url`, follow url → cookie set, `getSession → 200 with user`.

**Step 2: Run — red.**
**Step 3:** Implement the middleware. Use `node:http` typings; parse cookies from `req.headers.cookie`. The "OAuth flow" is fully synthetic: `POST /api/auth/sign-in/social` returns `{ url: '/api/auth/callback?user=u2' }`; `GET /api/auth/callback` writes the cookie and 302's to `/`.
**Step 4: Run — green.**
**Step 5: Commit:** `feat(channel-web): mock auth (sign-in / sign-out / get-session)`.

---

## Task 5: Mock sessions + history endpoints

Sessions are owned by `user_id` and bound to one `agent_id`. List filters by current user. History is stored as `(role, content_blocks)` rows.

**Files:**
- Create: `packages/channel-web/mock/chat.ts` (sessions + history; completions in Task 6)
- Create: `packages/channel-web/mock/__tests__/sessions.test.ts`

**Step 1–2: Failing test** for: list returns only caller's sessions; create returns id + 201; rename via PATCH; delete via DELETE 204; cross-tenant access → 403.
**Step 3:** Implement against `Store`.
**Step 4: green.**
**Step 5: Commit:** `feat(channel-web): mock chat sessions + history endpoints`.

---

## Task 6: Mock chat completions SSE (realistic streaming)

Speak OpenAI-shaped SSE: `data: {"choices":[{"delta":{"content":"..."}}]}` interleaved with named events (`event: status\n data: {...}\n\n`) and a final `data: [DONE]`. Generate a deterministic-ish reply char-by-char with a 12ms tick. Insert one `event: status` ("planning…") at start, one `event: diagnostic` (info severity) ~30% of turns. Title auto-derives from first user message.

The transport on the client side is the v1 `AxChatTransport` (Task 9), so this endpoint must be wire-compatible.

**Files:**
- Modify: `packages/channel-web/mock/chat.ts`
- Create: `packages/channel-web/mock/__tests__/chat-sse.test.ts`

**Step 1: Failing test:** POST with `messages=[{role:'user',content:'hi'}]`, parse the response stream, assert it begins with `event: status`, contains at least one `data: {"choices":...}` chunk, and ends with `data: [DONE]`. Assert the session's history is updated with both user + assistant turns afterwards.
**Step 2: Run — red.**
**Step 3:** Implement. Use `res.write()` + `res.flushHeaders()`. Reuse the chunk shape from v1's transport tests. On stream-end, append the assistant turn to `messages.json`. If `?session=<id>` doesn't exist, auto-create it (matches v1's `chatSessions.ensureExists()`).
**Step 4: green.**
**Step 5: Commit:** `feat(channel-web): mock chat completions SSE with status + diagnostic events`.

---

## Task 7: Mock admin endpoints

Three groups: agents, mcp-servers, teams. Each does CRUD + ACL: only `role: 'admin'` users can write; non-admins see only their own agents in non-admin reads (the `/api/agents` endpoint, which is different from `/api/admin/agents`).

**Files:**
- Create: `packages/channel-web/mock/admin/agents.ts`
- Create: `packages/channel-web/mock/admin/mcp-servers.ts`
- Create: `packages/channel-web/mock/admin/teams.ts`
- Create: `packages/channel-web/mock/agents.ts` (the user-scoped read endpoint)
- Create: `packages/channel-web/mock/__tests__/admin-agents.test.ts`
- Create: `packages/channel-web/mock/__tests__/agents.test.ts`

**Step 1–2:** Failing tests for: admin list returns all agents; non-admin to admin endpoint → 403; non-admin to `/api/agents` returns only personal + team-member agents (not other users'); POST creates with generated id; PATCH partial updates; DELETE 204; MCP test endpoint returns `{ok:true}` for the seeded server.

**Step 3:** Implement.
**Step 4: green.**
**Step 5: Commit:** `feat(channel-web): mock admin endpoints (agents, mcp-servers, teams)`.

---

## Task 8: Wire mock middleware into Vite

`mock/server.ts` exports `mockMiddleware()` returning a connect-compatible handler. `vite.config.ts` mounts it via `configureServer(server) { server.middlewares.use(mockMiddleware()) }`. Production `vite build` does not include the mock — it's dev-only.

**Files:**
- Create: `packages/channel-web/mock/server.ts`
- Modify: `packages/channel-web/vite.config.ts`

**Step 1:** Add a smoke test `mock/__tests__/server.test.ts` that boots a `node:http` server with `mockMiddleware()` and asserts a fetch to `/api/auth/get-session` returns 401, then signs in and returns 200.
**Step 2: red.**
**Step 3:** Implement `server.ts` as a router that dispatches to `auth.ts` / `chat.ts` / `agents.ts` / `admin/*.ts` based on URL prefix. Common: parse JSON body via `node:stream/consumers.json()`. CORS unnecessary — Vite serves both UI and mock from the same origin.
**Step 4: green.**
**Step 5: Commit:** `feat(channel-web): wire mock middleware into Vite dev server`.

---

## Task 9: Port `AxChatTransport`

Copy `~/dev/ai/ax/ui/chat/src/lib/ax-chat-transport.ts` to `packages/channel-web/src/lib/transport.ts`. Replace `/v1/chat/completions` with `/api/chat/completions`. Replace `/v1/files/...` with `/api/files/...` (file uploads are out of scope for the mock — leave the constant pointing at `/api/files/` and let it 404 in dev). Keep all stream-parsing logic. Port the existing `ax-chat-transport.test.ts` and update URLs.

**Files:**
- Create: `packages/channel-web/src/lib/transport.ts`
- Create: `packages/channel-web/src/__tests__/transport.test.ts`

**Step 1: Failing test:** the v1 test suite, ported, against a `ReadableStream`-driven mock. Fixtures cover: text-only stream, status events, diagnostic events, tool-call → tool-output, finish-reason mapping.
**Step 2: red (file doesn't exist).**
**Step 3:** Copy + rebase URLs. No logic changes.
**Step 4: green.**
**Step 5: Commit:** `feat(channel-web): port AxChatTransport with /api/* URLs`.

---

## Task 10: Port runtime + adapters

Copy `useAxChatRuntime.tsx`, `thread-list-adapter.ts`, `history-adapter.ts` from v1. Rebase URLs to `/api/chat/sessions` and `/api/chat/sessions/:id/history`. Drop the BetterAuth-specific bits — auth state is handled by `App.tsx`'s session check (Task 14).

**Files:**
- Create: `packages/channel-web/src/lib/runtime.tsx`
- Create: `packages/channel-web/src/lib/thread-list-adapter.ts`
- Create: `packages/channel-web/src/lib/history-adapter.ts`
- Create: `packages/channel-web/src/__tests__/thread-list-adapter.test.ts`
- Create: `packages/channel-web/src/__tests__/history-adapter.test.ts`

**Step 1: Failing tests** mirror v1's adapter tests if present; otherwise test against `vi.fn()` fetch mocks for: list parses sessions, fetch returns regular thread, initialize is a no-op, generateTitle polls and resolves, history maps content blocks to parts.
**Step 2: red.**
**Step 3:** Port + rebase.
**Step 4: green.**
**Step 5: Commit:** `feat(channel-web): port runtime + thread-list + history adapters`.

---

## Task 11: Sidebar shell with brand + new-session button + sessions scroll + user row

Tide markup. CSS classes match `design_handoff_tide/Tide Sessions.html` so the rules carry over verbatim. Internally a column flex: brand top, agent chip + new-session button, sessions list (`flex: 1`), user-row bottom. Width 240px, sticky, border-right `var(--rule)`.

**Files:**
- Create: `packages/channel-web/src/components/Sidebar.tsx`
- Create: `packages/channel-web/src/__tests__/sidebar.test.tsx`

**Step 1:** Failing render test that asserts `[data-testid="sidebar"]` exists with the expected child structure (`.brand`, `.agent-chip`, `.new-session-btn`, `.sessions-scroll`, `.user-row-wrap`).
**Step 2: red.**
**Step 3:** Implement. Brand is `Tide` wordmark; agent chip + new-session button are stub buttons (real handlers in Task 12 + 13).
**Step 4: green.**
**Step 5: Commit:** `feat(channel-web): sidebar shell with Tide structure`.

Reference: copy the relevant CSS rules from `Tide Sessions.html` (`.sidebar`, `.sidebar-head`, `.brand`, `.user-row`, `.user-row-wrap`, etc.) into `index.css`. Pixel-match.

---

## Task 12: Agent chip + agent menu with deferred-switch semantics

The agent chip opens a popover (`agent-menu`) listing accessible agents (from `/api/agents`). Selecting:
- If current session is empty → retag in place; **no new session**.
- If current session has messages → set `pendingAgentId` (zustand or local state); chat view goes blank ("One conversation. Say anything."); the next user message creates a new session under `pendingAgentId` and clears the pending flag.

Switching to another session, or clicking new-session, clears `pendingAgentId` too.

**Files:**
- Create: `packages/channel-web/src/components/AgentChip.tsx`
- Create: `packages/channel-web/src/components/AgentMenu.tsx`
- Create: `packages/channel-web/src/lib/agent-store.ts` (tiny zustand-style store; or `useState` lifted to App)
- Create: `packages/channel-web/src/__tests__/agent-switch.test.tsx`

**Step 1: Failing test** that exercises the deferred semantics — render with a non-empty session, switch agents, assert no new session POSTed; send a message, assert exactly one session created tagged with the new agent.
**Step 2: red.**
**Step 3:** Implement. Use `useAui()` to peek at the active thread's message count; lift `pendingAgentId` to a small store consumed by `AgentChip`, `AgentMenu`, and the empty-state Thread.
**Step 4: green.**
**Step 5: Commit:** `feat(channel-web): agent chip + menu with deferred-switch semantics`.

---

## Task 13: Sessions list + day grouping + active row + new session button

Wraps `useRemoteThreadListRuntime`'s thread list. Day groups: "today / yesterday / earlier". Each row uses fixed height 34px (so inline delete confirm doesn't reflow). Active row gets the 2px accent bar pseudo-element + bg `--bg-deep`.

**Files:**
- Create: `packages/channel-web/src/components/SessionList.tsx`
- Create: `packages/channel-web/src/components/SessionRow.tsx`
- Create: `packages/channel-web/src/components/NewSessionButton.tsx`
- Modify: `packages/channel-web/src/lib/runtime.tsx` (expose session metadata: agent color, last-message timestamp)
- Create: `packages/channel-web/src/__tests__/session-list.test.tsx`

**Step 1–2:** Failing test that lists 5 mock sessions across two days and asserts day labels render in the right order.
**Step 3:** Implement.
**Step 4: green.**
**Step 5: Commit:** `feat(channel-web): sessions list with day grouping`.

---

## Task 14: Inline rename + inline delete confirm with 5s auto-revert

Double-click on session row title → `contenteditable="plaintext-only"`, Enter commits via PATCH, Esc cancels. The `⋯` row menu has a "delete" item that swaps the row contents in place to the confirm UI; "delete" button → DELETE call; "cancel" or 5s timeout reverts. Row height stays 34px throughout.

**Files:**
- Modify: `packages/channel-web/src/components/SessionRow.tsx`
- Create: `packages/channel-web/src/__tests__/inline-rename.test.tsx`
- Create: `packages/channel-web/src/__tests__/inline-delete.test.tsx`

**Step 1–2:** Failing tests: rename emits PATCH; delete confirm + click → DELETE; auto-revert after 5s using `vi.useFakeTimers()`.
**Step 3:** Implement.
**Step 4: green.**
**Step 5: Commit:** `feat(channel-web): inline rename + delete confirm with 5s auto-revert`.

---

## Task 15: Sidebar collapsed state + toggle + persistence

Body class `sidebar-collapsed` toggled from a sidebar-toggle button in the session header. State persisted to `localStorage['tide-sidebar-collapsed']`. Composer's `left` adjusts via CSS rule (`body.sidebar-collapsed .composer { left: 56px }`).

**Files:**
- Modify: `packages/channel-web/src/App.tsx` (apply body class)
- Modify: `packages/channel-web/src/components/SessionHeader.tsx` (toggle button)
- Modify: `packages/channel-web/src/index.css` (collapsed rules from Tide Sessions)
- Create: `packages/channel-web/src/__tests__/sidebar-collapse.test.tsx`

**Step 1–2:** Failing test: click toggle → body has class; reload simulation → class persists.
**Step 3:** Implement.
**Step 4: green.**
**Step 5: Commit:** `feat(channel-web): sidebar collapse toggle persisted`.

---

## Task 16: Session header (sticky, serif title, ⌘N + ⋯ + sidebar-toggle)

Sticky 56px top bar in main pane. Title is serif 17/500, double-click to inline-rename. Right-aligned actions: `⌘N` (calls newSession), `⋯` (more menu — for now: "rename", "delete"), sidebar-toggle (panel-with-rail glyph).

**Files:**
- Create: `packages/channel-web/src/components/SessionHeader.tsx`
- Create: `packages/channel-web/src/__tests__/session-header.test.tsx`

**Step 1–2:** Failing test for double-click rename + ⌘N keyboard shortcut.
**Step 3:** Implement.
**Step 4: green.**
**Step 5: Commit:** `feat(channel-web): session header with sticky bar + actions`.

---

## Task 17: Composer (fixed bottom, attach + textarea + send circle)

Fixed bottom; left aligns with sidebar (`left: 240px` desktop, `56px` collapsed, `0` mobile). Outer max-width 640. `composer-field` is the visible card: `surface-raised` bg, 1px rule, 8px radius, `shadow-sm`, focus halo. Children: 28px attach (`+`) button, textarea (`min-height: 28px`), 30px send circle (`--ink-ghost` default → `--accent` when there's text).

Use `ComposerPrimitive.Root / Input / Send / Cancel` from assistant-ui — only the visual chrome is Tide-styled.

**Files:**
- Create: `packages/channel-web/src/components/Composer.tsx`
- Create: `packages/channel-web/src/__tests__/composer.test.tsx`

**Step 1–2:** Failing test: typing toggles send button class to `.ready`; pressing Enter (without shift) submits.
**Step 3:** Implement.
**Step 4: green.**
**Step 5: Commit:** `feat(channel-web): composer with attach + textarea + send`.

---

## Task 18: Thread + welcome + assistant/user message styling

Wraps `ThreadPrimitive.Root` / `Viewport` / `Messages`. ThreadWelcome empty state copy: "One conversation. Say anything." (matches Tide). Assistant message uses serif body + `you-wash` background bubble for user. Message actions per design: agent has copy + retry; user has copy + edit. Thread max-width 720px, centered, top-padded, bottom-padded to clear composer.

`MarkdownText` is ported from v1 with `@assistant-ui/react-markdown` + `remark-gfm`.

**Files:**
- Create: `packages/channel-web/src/components/Thread.tsx`
- Create: `packages/channel-web/src/components/MarkdownText.tsx`
- Create: `packages/channel-web/src/__tests__/thread.test.tsx`

**Step 1–2:** Failing test that renders a synthetic thread with one user + one assistant message and asserts the action buttons are present in the right order.
**Step 3:** Implement.
**Step 4: green.**
**Step 5: Commit:** `feat(channel-web): thread + message styling per Tide`.

---

## Task 19: Edit + retry truncation semantics

`ActionBarPrimitive.Edit` + `Reload` are wired. Both **truncate the conversation**: every message after the edited user message (or after the prompt that produced the retried agent reply) is removed from in-memory state and the persisted history; a fresh agent turn runs. Mirror ChatGPT/Claude.ai. No branch tree.

Assistant-ui's built-in edit/reload primitives already implement truncation in their default runtime; the v1 history adapter is a no-op on append (server is authoritative). Confirm round-trip by integration test.

**Files:**
- Modify: `packages/channel-web/src/components/Thread.tsx`
- Create: `packages/channel-web/src/__tests__/edit-retry.test.tsx`

**Step 1–2:** Failing test: render 4-message thread (u/a/u/a), edit message[0], assert messages[1..3] are gone and a new turn starts.
**Step 3:** Implement (mostly wiring; the primitive handles truncation, but the mock backend needs to honor it: when a `messages[]` array shorter than persisted history arrives, truncate persisted history to match).
**Step 4: green.**
**Step 5: Commit:** `feat(channel-web): edit + retry truncate conversation history`.

---

## Task 20: Auth gate + LoginPage

`App.tsx` calls `GET /api/auth/get-session` on mount. 401 → `<LoginPage />` with a single "Sign in with Google" button. Success → `<AssistantRuntimeProvider>` with `<AppContent>`.

LoginPage matches Tide aesthetic: centered card, brand wordmark, single CTA. No multi-provider list — Google only for the mock; the button POSTs to `/api/auth/sign-in/social` and follows the returned URL.

**Files:**
- Modify: `packages/channel-web/src/App.tsx`
- Create: `packages/channel-web/src/components/LoginPage.tsx`
- Modify: `packages/channel-web/src/lib/auth.ts`
- Create: `packages/channel-web/src/__tests__/auth-gate.test.tsx`

**Step 1–2:** Failing test: 401 response → LoginPage renders; 200 with user → AppContent renders.
**Step 3:** Implement.
**Step 4: green.**
**Step 5: Commit:** `feat(channel-web): auth gate with mock-Google login`.

---

## Task 21: User menu with admin entries

Bottom of sidebar. Click user row → popover with: "Account", "Preferences", **"Admin · Agents"**, **"Admin · MCP Servers"**, **"Admin · Teams"** (only when `user.role === 'admin'`), divider, theme tri-toggle (auto/light/dark), divider, "Sign out". Footer carries the AX logo.

**Files:**
- Create: `packages/channel-web/src/components/UserMenu.tsx`
- Modify: `packages/channel-web/src/components/Sidebar.tsx`
- Create: `packages/channel-web/src/__tests__/user-menu.test.tsx`
- Copy: `design_handoff_tide/ax-logo.svg` → `packages/channel-web/public/ax-logo.svg`

**Step 1–2:** Failing test: admin user sees admin entries; non-admin doesn't.
**Step 3:** Implement.
**Step 4: green.**
**Step 5: Commit:** `feat(channel-web): user menu with role-gated admin entries`.

**Important:** the gating is **UI affordance only**. The mock backend (and the future real backend) checks `role === 'admin'` on every `/api/admin/*` call regardless of menu visibility. Comment to that effect goes in `UserMenu.tsx`.

---

## Task 22: Admin — Agents form modal

Click "Admin · Agents" → modal panel listing all agents (admin scope). Each row: name, owner, visibility, model, edit, delete. "+ New agent" opens a form with: name, description, color, owner_type (user/team), owner (dropdown of users or teams), visibility, system_prompt (textarea), model (select), allowed_tools (chip multiselect), mcp_config_ids (chip multiselect from existing servers).

**Files:**
- Create: `packages/channel-web/src/components/admin/AdminPanel.tsx` (router for the three admin views)
- Create: `packages/channel-web/src/components/admin/AgentForm.tsx`
- Create: `packages/channel-web/src/lib/admin.ts` (typed clients for `/api/admin/*`)
- Create: `packages/channel-web/src/__tests__/admin-agents.test.tsx`

**Step 1–2:** Failing test: opening the panel fetches `/api/admin/agents`; submitting a new agent POSTs the right payload; PATCH on edit; DELETE with confirm.
**Step 3:** Implement.
**Step 4: green.**
**Step 5: Commit:** `feat(channel-web): admin agents CRUD form`.

---

## Task 23: Admin — MCP Servers form modal

Same shape. List + form (name, URL, transport, credentials_id), edit, delete, **Test** button (calls `/api/admin/mcp-servers/:id/test`, surfaces ok/error inline).

**Files:**
- Create: `packages/channel-web/src/components/admin/McpServerForm.tsx`
- Modify: `packages/channel-web/src/components/admin/AdminPanel.tsx`
- Modify: `packages/channel-web/src/lib/admin.ts`
- Create: `packages/channel-web/src/__tests__/admin-mcp.test.tsx`

**Step 1–2:** Failing test: list, create, edit, delete, test button success path + error path.
**Step 3:** Implement.
**Step 4: green.**
**Step 5: Commit:** `feat(channel-web): admin MCP servers CRUD + test button`.

---

## Task 24: Admin — Teams placeholder

A read-only list showing seeded teams + a `<TeamForm />` stub that displays "Team management ships in Week 9.5+ — see docs/plans/2026-04-24-week-9.5-multi-tenant-handoff.md". Real form deferred. The placeholder still calls `GET /api/admin/teams` to verify the wire is alive.

**Files:**
- Modify: `packages/channel-web/src/components/admin/AdminPanel.tsx`
- Create: `packages/channel-web/src/__tests__/admin-teams.test.tsx`

**Step 1–2:** Failing test for the read-only list.
**Step 3:** Implement.
**Step 4: green.**
**Step 5: Commit:** `feat(channel-web): admin teams placeholder + TODO`.

---

## Task 25: Theme tri-toggle (auto / light / dark)

`User menu → theme: [auto] [light] [dark]`. Persists to `localStorage['tide-theme']`. `auto` removes `data-theme`; `light` sets `data-theme="light"`; `dark` sets `data-theme="dark"`. Read on mount in `App.tsx`.

**Files:**
- Modify: `packages/channel-web/src/lib/theme.ts`
- Modify: `packages/channel-web/src/components/UserMenu.tsx`
- Create: `packages/channel-web/src/__tests__/theme-toggle.test.tsx`

**Step 1–2:** Failing test: initial render reads from localStorage; clicking dark sets data-theme + persists.
**Step 3:** Implement.
**Step 4: green.**
**Step 5: Commit:** `feat(channel-web): theme tri-toggle persisted`.

---

## Task 26: Search mode

A search action in the session header (or as part of `⋯`) flips the composer into search mode. Body class `searching` hides attach button. Filtered timeline highlights substring matches; "no literal match" empty state with an offer to escalate to "semantic" search — gate behind a feature flag (constant in `src/lib/features.ts: SEMANTIC_SEARCH = false`) so it doesn't ship in MVP.

**Files:**
- Modify: `packages/channel-web/src/components/SessionHeader.tsx`
- Modify: `packages/channel-web/src/components/Composer.tsx`
- Modify: `packages/channel-web/src/components/Thread.tsx`
- Create: `packages/channel-web/src/lib/features.ts`
- Create: `packages/channel-web/src/__tests__/search-mode.test.tsx`

**Step 1–2:** Failing test: search input toggles body class and filters timeline.
**Step 3:** Implement.
**Step 4: green.**
**Step 5: Commit:** `feat(channel-web): search mode with substring filter`.

---

## Task 27: Mobile slide-over sidebar

`@media (max-width: 720px)` rules from Tide Sessions: sidebar becomes `position: fixed` overlay, hidden by default, shown via body class `sidebar-open`. Sidebar-toggle button appears on mobile only.

**Files:**
- Modify: `packages/channel-web/src/index.css`
- Modify: `packages/channel-web/src/components/SessionHeader.tsx`
- Create: `packages/channel-web/src/__tests__/mobile-sidebar.test.tsx`

**Step 1–2:** Failing test: at 360px viewport, sidebar is hidden until toggle is pressed.
**Step 3:** Implement.
**Step 4: green.**
**Step 5: Commit:** `feat(channel-web): mobile slide-over sidebar`.

---

## Task 28: README + MOCK_BACKEND_WARNING

Two short documents.

`packages/channel-web/README.md` — getting started:
- `pnpm --filter @ax/channel-web dev` → http://localhost:5173
- `pnpm --filter @ax/channel-web test` → vitest
- Mock data lives in `.mock-data/` (gitignored). Delete it to reset.
- Two seeded users: `admin@local` (admin) + `alice@local` (regular). Sign-in is mock-Google → click button, no real OAuth.
- When real backend lands (Week 9.5 + 10–12), the `mock/` directory is deleted and `vite.config.ts` is reverted.

`packages/channel-web/MOCK_BACKEND_WARNING.md` — one paragraph for anyone who finds this directory: this is design plumbing, not a real backend. Do not deploy. Do not store secrets in `.mock-data/`. Real auth + real persistence ship in Week 9.5 + 10–12.

**Files:**
- Create: `packages/channel-web/README.md`
- Create: `packages/channel-web/MOCK_BACKEND_WARNING.md`

**Step 5: Commit:** `docs(channel-web): README + mock backend warning`.

---

## Task 29: Acceptance — golden-path E2E (manual + targeted vitest)

Manual smoke runbook in the README:

1. `pnpm --filter @ax/channel-web dev`. Open http://localhost:5173.
2. See LoginPage → click "Sign in with Google". Authenticated as Alice (regular user).
3. Sidebar shows seeded agents; pick "tide" from agent menu.
4. Send "hello, what can you do?" — observe streaming response, status chip, eventual diagnostic banner ~30% of turns.
5. Reload the page. Conversation history reappears via `/api/chat/sessions/:id/history`.
6. Sign out, sign back in as Admin. User menu shows admin entries.
7. Admin → Agents → create a new personal agent. Sign out + back in as Alice; the new agent isn't in her list (created under admin).
8. Admin → MCP Servers → create + Test → success badge.
9. Toggle theme to dark; reload; theme persists.
10. Collapse sidebar; reload; collapsed state persists.
11. Edit user message; assert subsequent assistant turn is gone and a new one streams.
12. Switch agent mid-conversation; assert new session is created on next message, prior session intact.

**Targeted vitest** (`src/__tests__/golden-path.test.tsx`): a happy-path render that verifies the Tide structure end-to-end against an in-process mock backend. Not a full E2E (no Playwright) — just confidence that the wiring holds.

**Step 5: Final commit:** `test(channel-web): golden-path acceptance test + manual runbook`.

---

## After all tasks complete

1. `pnpm build && pnpm test` — both green across all packages.
2. `pnpm --filter @ax/channel-web build` — Vite production bundle builds without referencing the mock middleware (verify via `grep -r mockMiddleware dist/` returning nothing).
3. Push branch `feat/chat-ui-pulled-forward` and open a PR titled "feat(channel-web): chat UI pulled forward with mock backend". PR description recaps:
   - What ships (the Layout + API surface tables from this plan)
   - What's mocked (auth, completions, sessions, history, agents, admin)
   - What survives the rename (everything in `src/`)
   - What gets deleted in Week 10–12 (everything in `mock/` + the dev-only middleware in `vite.config.ts`)
   - **No boundary review** (no new hook surface)
   - **No security checklist** (no real trust-boundary additions; the mock is dev-only)
   - Manual acceptance runbook (12 steps from Task 29)

When Week 9.5 lands, the migration is:
- Replace `src/lib/auth.ts` calls' shape with whatever `@ax/auth` ships — same endpoints, same `{ user }` response shape, so likely just delete the mock middleware.
- Replace `src/lib/admin.ts` URL constants if they change (recommend they don't).

When Week 10–12 lands, the migration is:
- `@ax/channel-web` registers HTTP routes against `@ax/http-server` for `/api/chat/*` (channels-driven, not mock-driven).
- Delete `mock/` directory and the `configureServer` block in `vite.config.ts`.
- The React tree is untouched.
