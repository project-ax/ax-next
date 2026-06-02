# User Personal-Agent Bootstrap — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a brand-new non-admin user an openclaw-style first-run flow that creates their personal agent — name → soul/identity → purpose — then drops them into a chat with it active.

**Architecture:** A new server route `POST /api/agents/bootstrap` (in `@ax/channel-web`) calls the existing `agents:create` service hook with hardcoded `visibility: 'personal'`, `ownerId = caller`, and the **wildcard** tool scope (`allowedTools: []`, `mcpConfigIds: []`) — identical to the onboarding "Default Agent" — so a user's personal agent has the full in-sandbox tool catalog. We can't reuse `POST /admin/agents` because it deliberately rejects the wildcard. A new SPA surface `<AgentBootstrap>` (reusing the existing `SetupShell`) drives the three steps. `App.tsx`'s `AppContent` gates on a new tri-state agent-load signal: render the bootstrap full-pane when the agent list loads empty.

**Tech Stack:** React + `useSyncExternalStore` (the existing `agent-store`), shadcn primitives (`SetupShell`/`Card`, `Input`, `Textarea`, `Button`, `Badge`, `Alert`), the `@ax/core` hook bus, Vitest + Testing Library.

---

## Decisions baked into this plan (the resolved open questions)

1. **Default tool set = wildcard** (`allowedTools: []`, `mcpConfigIds: []`), matching the onboarding Default Agent (`packages/onboarding/src/completion-tx.ts:104`). Requires the dedicated route (the admin route rejects wildcard at `packages/agents/src/admin-routes.ts:415`). The route hardcodes the scope; it ignores any client-supplied tools/model/visibility.
2. **Default model = `claude-sonnet-4-6`**, hidden — no model question. There is no persisted "default chat model" setting to read (only `settings:fast-model` exists), and `claude-sonnet-4-6` is the shared fallback across `StepModel`, `AgentForm`, and onboarding.
3. **"+ New agent"** entry added to `AgentMenu` — reuses the same `<AgentBootstrap>` surface (full-pane), so first-run and second-agent share one component.
4. **Entry condition = `agents:list-for-user` returns empty** (today == zero personal agents) — gate on the same list the chip already fetches; forward-compatible with team agents.
5. **Loading-vs-empty signal** = a tri-state `agentsStatus: 'loading' | 'ready' | 'error'` on the store, so we never flash the bootstrap before the list loads, and a transient fetch error does **not** force an existing user into the create flow.

**Deviation from the ux-designer spec:** no `accordion` install. The soul/purpose `Textarea`s are themselves the editable source of truth and the chips just pre-fill them, so the "Advanced — edit full instructions" reveal is redundant. Progressive disclosure is "chips for the timid, textarea for the bold."

**Invariant notes:**
- Invariant #2 (no cross-plugin imports): the new route declares its hook payload types **locally** (structural typing), exactly like `routes-chat.ts:108-127`. Do **not** `import` types from `@ax/agents`.
- Invariant #5 (capabilities) + untrusted input: the route handles browser-supplied `displayName`/`systemPrompt`. **Invoke the `security-checklist` skill when implementing Task 3.**
- Invariant #6 (one UI language): all UI composes existing shadcn primitives in `packages/channel-web`. No new primitives required (all present).
- Boundary review: no new service-hook signature is added (this is an HTTP route calling an existing hook), so only the manifest `calls` list changes (Task 4).

---

## File Structure

**Backend (`@ax/channel-web` host plugin):**
- Create `packages/channel-web/src/server/routes-agent-bootstrap.ts` — handler factory for `POST /api/agents/bootstrap`. Auth → validate `{ displayName, systemPrompt }` → `agents:create` (wildcard/personal/owner) → `201 { agent }`.
- Modify `packages/channel-web/src/server/plugin.ts` — register the route; add `agents:create` to `manifest.calls`.

**Frontend (`@ax/channel-web` SPA):**
- Modify `packages/channel-web/src/lib/agent-store.ts` — add `agentsStatus` tri-state + `setAgentsError` action.
- Create `packages/channel-web/src/lib/hydrate-agents.ts` — `hydrateAgentsOnce()` (extracted fetch+map logic, callable on demand for post-create re-hydrate).
- Create `packages/channel-web/src/lib/agent-bootstrap.ts` — `bootstrapAgent({ displayName, systemPrompt })` client wire.
- Create `packages/channel-web/src/components/onboard/AgentBootstrap.tsx` — the name → soul → purpose → done flow.
- Modify `packages/channel-web/src/components/AgentChip.tsx` — `useHydrateAgents` delegates to `hydrateAgentsOnce`; drop the inlined fetch + `agentColorFor` (moved).
- Modify `packages/channel-web/src/components/SessionHeader.tsx` — stop calling `useHydrateAgents` (lifted to `AppContent`); accept + forward an `onCreateAgent` prop.
- Modify `packages/channel-web/src/components/AgentChip.tsx` — accept + forward `onCreateNew` to `AgentMenu`.
- Modify `packages/channel-web/src/components/AgentMenu.tsx` — add a "+ New agent" footer row.
- Modify `packages/channel-web/src/App.tsx` — lift `useHydrateAgents`; gate `AppContent` on `agentsStatus`; render `<AgentBootstrap>` full-pane when ready-and-empty or when "+ New agent" is clicked.

**Tests:**
- `packages/channel-web/src/__tests__/server/routes-agent-bootstrap.test.ts`
- `packages/channel-web/src/__tests__/agent-store-status.test.ts`
- `packages/channel-web/src/__tests__/hydrate-agents.test.ts`
- `packages/channel-web/src/__tests__/agent-bootstrap-client.test.ts`
- `packages/channel-web/src/components/__tests__/AgentBootstrap.test.tsx`
- `packages/channel-web/src/components/__tests__/AgentMenu.test.tsx` (extend if present, else create)

---

## Task 1: Store tri-state agent-load signal

**Files:**
- Modify: `packages/channel-web/src/lib/agent-store.ts`
- Test: `packages/channel-web/src/__tests__/agent-store-status.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/channel-web/src/__tests__/agent-store-status.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  agentStoreActions,
  getAgentStoreSnapshot,
} from '../lib/agent-store';

describe('agent-store load status', () => {
  beforeEach(() => {
    // Reset to a known baseline (module singleton).
    agentStoreActions.resetForTest();
  });

  it('starts in loading status with no agents', () => {
    const s = getAgentStoreSnapshot();
    expect(s.agentsStatus).toBe('loading');
    expect(s.agents).toEqual([]);
  });

  it('setAgents flips status to ready (even for an empty list)', () => {
    agentStoreActions.setAgents([]);
    expect(getAgentStoreSnapshot().agentsStatus).toBe('ready');
    expect(getAgentStoreSnapshot().agents).toEqual([]);
  });

  it('setAgentsError flips status to error without touching the agent list', () => {
    agentStoreActions.setAgents([
      { id: 'a1', name: 'Ada' } as never,
    ]);
    agentStoreActions.setAgentsError();
    const s = getAgentStoreSnapshot();
    expect(s.agentsStatus).toBe('error');
    expect(s.agents).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --filter @ax/channel-web -- agent-store-status`
Expected: FAIL — `agentsStatus`, `setAgentsError`, `resetForTest`, `getAgentStoreSnapshot` not defined.

- [ ] **Step 3: Implement the store changes**

In `packages/channel-web/src/lib/agent-store.ts`:

Add the status type and extend the state interface:

```ts
export type AgentsStatus = 'loading' | 'ready' | 'error';

export interface AgentStoreState {
  agents: Agent[];
  /** Tri-state load signal for the agent list (drives the first-run gate). */
  agentsStatus: AgentsStatus;
  selectedAgentId: string | null;
  pendingAgentId: string | null;
  activeSessionId: string | null;
  activeSessionHasMessages: boolean;
}

const initialState: AgentStoreState = {
  agents: [],
  agentsStatus: 'loading',
  selectedAgentId: null,
  pendingAgentId: null,
  activeSessionId: null,
  activeSessionHasMessages: false,
};
```

Export a snapshot getter for tests (the hook already uses `getSnapshot` internally):

```ts
export const getAgentStoreSnapshot = (): AgentStoreState => state;
```

In `agentStoreActions`, change `setAgents` to flip status, and add the two new actions:

```ts
  setAgents: (agents: Agent[]): void => {
    set({ agents, agentsStatus: 'ready' });
  },

  /** Mark the agent-list load as failed (transient fetch/parse error). */
  setAgentsError: (): void => {
    set({ agentsStatus: 'error' });
  },

  /** Test-only: restore the module singleton to its initial state. */
  resetForTest: (): void => {
    set({ ...initialState });
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --filter @ax/channel-web -- agent-store-status`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/lib/agent-store.ts packages/channel-web/src/__tests__/agent-store-status.test.ts
git commit -m "feat(channel-web): tri-state agentsStatus on the agent store"
```

---

## Task 2: Extract `hydrateAgentsOnce` + wire error status

**Files:**
- Create: `packages/channel-web/src/lib/hydrate-agents.ts`
- Modify: `packages/channel-web/src/components/AgentChip.tsx:124-170` (the `useHydrateAgents` hook + `agentColorFor`)
- Test: `packages/channel-web/src/__tests__/hydrate-agents.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/channel-web/src/__tests__/hydrate-agents.test.ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { hydrateAgentsOnce } from '../lib/hydrate-agents';
import { agentStoreActions, getAgentStoreSnapshot } from '../lib/agent-store';

describe('hydrateAgentsOnce', () => {
  beforeEach(() => agentStoreActions.resetForTest());
  afterEach(() => vi.restoreAllMocks());

  it('maps the wire list and sets status ready', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(
        JSON.stringify([
          { agentId: 'a1', displayName: 'Ada', visibility: 'personal' },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ));
    await hydrateAgentsOnce();
    const s = getAgentStoreSnapshot();
    expect(s.agentsStatus).toBe('ready');
    expect(s.agents.map((a) => a.name)).toEqual(['Ada']);
  });

  it('sets status ready with an empty list when the user owns no agents', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
    ));
    await hydrateAgentsOnce();
    const s = getAgentStoreSnapshot();
    expect(s.agentsStatus).toBe('ready');
    expect(s.agents).toEqual([]);
  });

  it('sets status error on a non-ok response (does not force empty)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    await hydrateAgentsOnce();
    expect(getAgentStoreSnapshot().agentsStatus).toBe('error');
  });

  it('sets status error when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await hydrateAgentsOnce();
    expect(getAgentStoreSnapshot().agentsStatus).toBe('error');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --filter @ax/channel-web -- hydrate-agents`
Expected: FAIL — cannot find module `../lib/hydrate-agents`.

- [ ] **Step 3: Create `hydrate-agents.ts`**

```ts
// packages/channel-web/src/lib/hydrate-agents.ts
import type { Agent } from '../../mock/agents';
import { agentStoreActions } from './agent-store';

/**
 * Fetch the caller's agent list once and push it into the store.
 *
 * Sets `agentsStatus`:
 *   - 'ready'  on a successful load (INCLUDING an empty list — that's the
 *              signal the first-run bootstrap gate keys off).
 *   - 'error'  on a non-ok response, a non-array body, or a thrown fetch.
 *              We deliberately do NOT set agents to [] on error: a transient
 *              blip must not push an existing user into the create flow.
 *
 * Safe to call on demand (e.g. to re-hydrate after creating an agent).
 */
export async function hydrateAgentsOnce(): Promise<void> {
  try {
    const res = await fetch('/api/chat/agents', { credentials: 'include' });
    if (!res.ok) {
      agentStoreActions.setAgentsError();
      return;
    }
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) {
      agentStoreActions.setAgentsError();
      return;
    }
    const wireAgents = body as Array<{
      agentId: string;
      displayName: string;
      visibility: 'personal' | 'team';
    }>;
    const mapped: Agent[] = wireAgents.map((a) => ({
      id: a.agentId,
      owner_id: '',
      owner_type: a.visibility === 'team' ? ('team' as const) : ('user' as const),
      name: a.displayName,
      tag: '',
      desc: '',
      color: agentColorFor(a.agentId),
      system_prompt: '',
      allowed_tools: [],
      mcp_config_ids: [],
      model: '',
      created_at: 0,
      updated_at: 0,
    }));
    agentStoreActions.setAgents(mapped);
  } catch (err) {
    console.warn('[hydrate-agents] failed', err);
    agentStoreActions.setAgentsError();
  }
}

export function agentColorFor(agentId: string): string {
  const palette = ['#7aa6c9', '#b08968', '#9c89b8', '#90a955', '#d4a373', '#9b5de5'];
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = (hash * 31 + agentId.charCodeAt(i)) >>> 0;
  }
  return palette[hash % palette.length] ?? palette[0]!;
}
```

> Note: copy the real body of `agentColorFor` from `packages/channel-web/src/components/AgentChip.tsx` (the hashing loop continues past line 170 in the current file) — the version above is the canonical full implementation; verify the palette + hash match before deleting the original.

- [ ] **Step 4: Update `AgentChip.tsx` to delegate**

Replace the `useHydrateAgents` body and remove the now-moved `agentColorFor`:

```ts
// AgentChip.tsx — near the existing imports
import { hydrateAgentsOnce, agentColorFor } from '../lib/hydrate-agents';

// ...replace the whole useHydrateAgents function with:
export function useHydrateAgents(): void {
  useEffect(() => {
    void hydrateAgentsOnce();
  }, []);
}
```

Delete the old in-file `agentColorFor` definition (now imported). Keep using `agentColorFor` wherever the chip referenced it (it now comes from the import).

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test --filter @ax/channel-web -- hydrate-agents`
Expected: PASS (4 tests).
Run: `pnpm test --filter @ax/channel-web -- AgentChip` (regression — existing chip tests still green).
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/channel-web/src/lib/hydrate-agents.ts packages/channel-web/src/components/AgentChip.tsx packages/channel-web/src/__tests__/hydrate-agents.test.ts
git commit -m "refactor(channel-web): extract hydrateAgentsOnce with ready/error status"
```

---

## Task 3: Backend route `POST /api/agents/bootstrap`

> **Invoke the `security-checklist` skill before implementing — this route handles untrusted browser input and creates an agent.**

**Files:**
- Create: `packages/channel-web/src/server/routes-agent-bootstrap.ts`
- Test: `packages/channel-web/src/__tests__/server/routes-agent-bootstrap.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/channel-web/src/__tests__/server/routes-agent-bootstrap.test.ts
import { describe, it, expect } from 'vitest';
import { HookBus, PluginError, makeAgentContext, type AgentContext } from '@ax/core';
import { makeAgentBootstrapHandler } from '../../server/routes-agent-bootstrap.js';
import type { RouteRequest, RouteResponse } from '../../server/routes-chat.js';

function fakeReq(opts: { body?: unknown } = {}): RouteRequest {
  const buf =
    opts.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(opts.body), 'utf8');
  return { headers: {}, body: buf, cookies: {}, query: {}, params: {}, signedCookie: () => null };
}
function fakeRes(): { res: RouteResponse; captured: { statusCode: number; body: unknown } } {
  const captured = { statusCode: 0, body: undefined as unknown };
  const res: RouteResponse = {
    status(n) { captured.statusCode = n; return res; },
    json(v) { captured.body = v; },
    text() {}, end() {},
  };
  return { res, captured };
}
const initCtx: AgentContext = makeAgentContext({ sessionId: 'init', agentId: 'test', userId: 'system' });

function busWith(opts: {
  user?: { id: string; isAdmin: boolean } | 'reject';
  onCreate?: (input: unknown) => unknown;
}): { bus: HookBus; created: Array<{ ctx: AgentContext; input: unknown }> } {
  const created: Array<{ ctx: AgentContext; input: unknown }> = [];
  const bus = new HookBus();
  bus.registerService('auth:require-user', 'auth', async () => {
    if (opts.user === 'reject') throw new PluginError('unauthenticated', 'auth', 'no session');
    return { user: opts.user ?? { id: 'u1', isAdmin: false } };
  });
  bus.registerService('agents:create', 'agents', async (ctx, input) => {
    created.push({ ctx, input });
    if (opts.onCreate) return opts.onCreate(input);
    return { agent: { id: 'new-agent-1', displayName: (input as { input: { displayName: string } }).input.displayName, visibility: 'personal' } };
  });
  return { bus, created };
}

describe('POST /api/agents/bootstrap', () => {
  it('creates a personal wildcard agent owned by the caller and returns 201', async () => {
    const { bus, created } = busWith({ user: { id: 'u1', isAdmin: false } });
    const h = makeAgentBootstrapHandler({ bus, initCtx });
    const { res, captured } = fakeRes();
    await h.bootstrap(fakeReq({ body: { displayName: 'Ada', systemPrompt: 'You are Ada.' } }), res);
    expect(captured.statusCode).toBe(201);
    expect(captured.body).toEqual({ agent: { agentId: 'new-agent-1', displayName: 'Ada', visibility: 'personal' } });
    expect(created).toHaveLength(1);
    const input = created[0]!.input as { actor: { userId: string }; input: Record<string, unknown> };
    expect(input.actor.userId).toBe('u1');
    expect(input.input.visibility).toBe('personal');
    expect(input.input.allowedTools).toEqual([]);
    expect(input.input.mcpConfigIds).toEqual([]);
    expect(input.input.model).toBe('claude-sonnet-4-6');
  });

  it('ignores client-supplied tools/model/visibility (cannot over-grant)', async () => {
    const { bus, created } = busWith({});
    const h = makeAgentBootstrapHandler({ bus, initCtx });
    const { res } = fakeRes();
    await h.bootstrap(
      fakeReq({ body: { displayName: 'X', systemPrompt: '', allowedTools: ['Bash'], visibility: 'team', model: 'evil' } }),
      res,
    );
    const input = created[0]!.input as { input: Record<string, unknown> };
    expect(input.input.allowedTools).toEqual([]);
    expect(input.input.visibility).toBe('personal');
    expect(input.input.model).toBe('claude-sonnet-4-6');
  });

  it('rejects an unauthenticated caller with 401', async () => {
    const { bus } = busWith({ user: 'reject' });
    const h = makeAgentBootstrapHandler({ bus, initCtx });
    const { res, captured } = fakeRes();
    await h.bootstrap(fakeReq({ body: { displayName: 'Ada', systemPrompt: '' } }), res);
    expect(captured.statusCode).toBe(401);
  });

  it('rejects a missing/blank displayName with 400', async () => {
    const { bus } = busWith({});
    const h = makeAgentBootstrapHandler({ bus, initCtx });
    const { res, captured } = fakeRes();
    await h.bootstrap(fakeReq({ body: { displayName: '   ', systemPrompt: '' } }), res);
    expect(captured.statusCode).toBe(400);
  });

  it('rejects a displayName longer than 128 chars with 400', async () => {
    const { bus } = busWith({});
    const h = makeAgentBootstrapHandler({ bus, initCtx });
    const { res, captured } = fakeRes();
    await h.bootstrap(fakeReq({ body: { displayName: 'a'.repeat(129), systemPrompt: '' } }), res);
    expect(captured.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --filter @ax/channel-web -- routes-agent-bootstrap`
Expected: FAIL — cannot find module `routes-agent-bootstrap.js`.

- [ ] **Step 3: Implement the route**

```ts
// packages/channel-web/src/server/routes-agent-bootstrap.ts
import { PluginError, isRejection, type AgentContext, type HookBus } from '@ax/core';
import { z } from 'zod';
import type { RouteRequest, RouteResponse } from './routes-chat.js';

const PLUGIN_NAME = '@ax/channel-web';

/** Hidden default — see plan decision #2. No persisted "default model" setting exists. */
const DEFAULT_PERSONAL_AGENT_MODEL = 'claude-sonnet-4-6';

// Locally-declared hook payload shapes (Invariant #2 — no cross-plugin
// imports; the hook bus is the contract, each side names the shape it needs).
interface AuthRequireUserInput {
  req: RouteRequest;
}
interface AuthRequireUserOutput {
  user: { id: string; isAdmin: boolean };
}
interface AgentsCreateInput {
  actor: { userId: string; isAdmin: boolean };
  input: {
    displayName: string;
    systemPrompt: string;
    allowedTools: string[];
    mcpConfigIds: string[];
    model: string;
    visibility: 'personal' | 'team';
  };
}
interface AgentsCreateAgent {
  id: string;
  displayName: string;
  visibility: 'personal' | 'team';
}
interface AgentsCreateOutput {
  agent: AgentsCreateAgent;
}

// Mirror the admin route's displayName contract (1-128, no surrounding
// whitespace) and the store's 32 KiB systemPrompt cap. We only accept the
// two user-authored fields; everything else is fixed server-side.
const BootstrapBody = z.object({
  displayName: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1, 'displayName 1-128').max(128, 'displayName 1-128')),
  systemPrompt: z.string().max(32 * 1024, 'systemPrompt too large').default(''),
});

export interface AgentBootstrapDeps {
  bus: HookBus;
  initCtx: AgentContext;
}

export function makeAgentBootstrapHandler(deps: AgentBootstrapDeps) {
  const { bus, initCtx } = deps;
  return {
    /** POST /api/agents/bootstrap */
    async bootstrap(req: RouteRequest, res: RouteResponse): Promise<void> {
      // 1) Auth.
      let actor: { id: string; isAdmin: boolean };
      try {
        const result = await bus.call<AuthRequireUserInput, AuthRequireUserOutput>(
          'auth:require-user',
          initCtx,
          { req },
        );
        actor = { id: result.user.id, isAdmin: result.user.isAdmin };
      } catch (err) {
        if (err instanceof PluginError || isRejection(err)) {
          res.status(401).json({ error: 'unauthenticated' });
          return;
        }
        throw err;
      }

      // 2) Parse + validate. Only displayName + systemPrompt are honored.
      let parsed: { displayName: string; systemPrompt: string };
      try {
        const raw = req.body.length === 0 ? {} : (JSON.parse(req.body.toString('utf8')) as unknown);
        const r = BootstrapBody.safeParse(raw);
        if (!r.success) {
          res.status(400).json({ error: 'invalid-payload' });
          return;
        }
        parsed = r.data;
      } catch {
        res.status(400).json({ error: 'invalid-payload' });
        return;
      }

      // 3) Create — wildcard tool scope, personal visibility, owner = caller.
      //    Identical capability profile to the onboarding Default Agent. The
      //    admin HTTP route rejects the wildcard; the service hook allows it.
      try {
        const out = await bus.call<AgentsCreateInput, AgentsCreateOutput>(
          'agents:create',
          initCtx,
          {
            actor: { userId: actor.id, isAdmin: actor.isAdmin },
            input: {
              displayName: parsed.displayName,
              systemPrompt: parsed.systemPrompt,
              allowedTools: [],
              mcpConfigIds: [],
              model: DEFAULT_PERSONAL_AGENT_MODEL,
              visibility: 'personal',
            },
          },
        );
        res.status(201).json({
          agent: {
            agentId: out.agent.id,
            displayName: out.agent.displayName,
            visibility: out.agent.visibility,
          },
        });
      } catch (err) {
        if (err instanceof PluginError) {
          // Validation failures from the store surface as 'invalid'.
          if (err.code === 'invalid') {
            res.status(400).json({ error: 'invalid-payload' });
            return;
          }
        }
        initCtx.logger.warn('agent_bootstrap_create_failed', {
          plugin: PLUGIN_NAME,
          err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
        });
        res.status(500).json({ error: 'create-failed' });
      }
    },
  };
}
```

> Verify `z` (zod) is already a dependency of `@ax/channel-web` (it is — `routes-chat.ts` uses zod schemas). If `pnpm build` reports it undeclared, add `zod` to `packages/channel-web/package.json` `dependencies` matching the version used elsewhere in the repo.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --filter @ax/channel-web -- routes-agent-bootstrap`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/server/routes-agent-bootstrap.ts packages/channel-web/src/__tests__/server/routes-agent-bootstrap.test.ts
git commit -m "feat(channel-web): POST /api/agents/bootstrap (personal wildcard agent)"
```

---

## Task 4: Wire the route into the plugin + manifest

**Files:**
- Modify: `packages/channel-web/src/server/plugin.ts` (manifest `calls` ~line 90-105; route registration ~line 290-310)

- [ ] **Step 1: Add `agents:create` to the manifest `calls`**

In the `calls: [...]` array (after `'agents:list-for-user'`):

```ts
        'agents:list-for-user',
        // First-run personal-agent bootstrap (POST /api/agents/bootstrap)
        // creates the user's own agent with the wildcard tool scope, exactly
        // like onboarding's Default Agent. Hard dep — the route is dead
        // without it.
        'agents:create',
```

- [ ] **Step 2: Register the route**

Add the import near the other route imports at the top of `plugin.ts`:

```ts
import { makeAgentBootstrapHandler } from './routes-agent-bootstrap.js';
```

Inside the plugin `init` (alongside the `allow-host` route registration, ~line 299), add:

```ts
      // First-run personal-agent bootstrap. The SPA's <AgentBootstrap> POSTs
      // { displayName, systemPrompt } here; the handler fixes visibility +
      // owner + wildcard tools server-side. CSRF-gated automatically by
      // @ax/http-server on state-changing methods. Ships with its consumer
      // (the SPA surface) in the same PR (no half-wired surface).
      const agentBootstrap = makeAgentBootstrapHandler({ bus, initCtx });
      const agentBootstrapRoute = await bus.call<unknown, { unregister: () => void }>(
        'http:register-route',
        initCtx,
        {
          method: 'POST',
          path: '/api/agents/bootstrap',
          handler: agentBootstrap.bootstrap as unknown as (
            req: RouteRequest,
            res: RouteResponse,
          ) => Promise<void>,
        },
      );
      unregisterRoutes.push(agentBootstrapRoute.unregister);
```

- [ ] **Step 3: Build + verify wiring**

Run: `pnpm build --filter @ax/channel-web`
Expected: clean (tsc passes — confirms the local hook types + manifest compile).

Run: `pnpm test --filter @ax/channel-web -- plugin`
Expected: PASS — if `plugin.test.ts` asserts the manifest `calls` list, update its expected array to include `'agents:create'`.

- [ ] **Step 4: Commit**

```bash
git add packages/channel-web/src/server/plugin.ts
git commit -m "feat(channel-web): register agent-bootstrap route + declare agents:create"
```

---

## Task 5: Client wire `bootstrapAgent`

**Files:**
- Create: `packages/channel-web/src/lib/agent-bootstrap.ts`
- Test: `packages/channel-web/src/__tests__/agent-bootstrap-client.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/channel-web/src/__tests__/agent-bootstrap-client.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { bootstrapAgent } from '../lib/agent-bootstrap';

afterEach(() => vi.restoreAllMocks());

describe('bootstrapAgent', () => {
  it('POSTs to /api/agents/bootstrap with CSRF header + credentials and returns the agent', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ agent: { agentId: 'a9', displayName: 'Ada', visibility: 'personal' } }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const agent = await bootstrapAgent({ displayName: 'Ada', systemPrompt: 'You are Ada.' });
    expect(agent).toEqual({ agentId: 'a9', displayName: 'Ada', visibility: 'personal' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/agents/bootstrap');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).credentials).toBe('include');
    expect((init as Record<string, Record<string, string>>).headers['x-requested-with']).toBe('ax-admin');
  });

  it('throws on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"create-failed"}', { status: 500 })));
    await expect(bootstrapAgent({ displayName: 'Ada', systemPrompt: '' })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --filter @ax/channel-web -- agent-bootstrap-client`
Expected: FAIL — cannot find module `../lib/agent-bootstrap`.

- [ ] **Step 3: Implement the client wire**

```ts
// packages/channel-web/src/lib/agent-bootstrap.ts

export interface BootstrappedAgent {
  agentId: string;
  displayName: string;
  visibility: 'personal' | 'team';
}

/**
 * Create the caller's personal agent via the first-run bootstrap route.
 * Mirrors the channel-web client convention: `x-requested-with: ax-admin`
 * (CSRF bypass header) + `credentials: 'include'` on writes.
 */
export async function bootstrapAgent(input: {
  displayName: string;
  systemPrompt: string;
}): Promise<BootstrappedAgent> {
  const res = await fetch('/api/agents/bootstrap', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'ax-admin' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(`bootstrap agent: ${res.status}`);
  }
  const body = (await res.json()) as { agent: BootstrappedAgent };
  return body.agent;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --filter @ax/channel-web -- agent-bootstrap-client`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/lib/agent-bootstrap.ts packages/channel-web/src/__tests__/agent-bootstrap-client.test.ts
git commit -m "feat(channel-web): bootstrapAgent client wire"
```

---

## Task 6: `<AgentBootstrap>` flow component

**Files:**
- Create: `packages/channel-web/src/components/onboard/AgentBootstrap.tsx`
- Test: `packages/channel-web/src/components/__tests__/AgentBootstrap.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// packages/channel-web/src/components/__tests__/AgentBootstrap.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AgentBootstrap } from '../onboard/AgentBootstrap';
import { agentStoreActions } from '../../lib/agent-store';

vi.mock('../../lib/agent-bootstrap', () => ({
  bootstrapAgent: vi.fn(async () => ({ agentId: 'a-new', displayName: 'Ada', visibility: 'personal' })),
}));
vi.mock('../../lib/hydrate-agents', () => ({ hydrateAgentsOnce: vi.fn(async () => {}) }));

import { bootstrapAgent } from '../../lib/agent-bootstrap';
import { hydrateAgentsOnce } from '../../lib/hydrate-agents';

beforeEach(() => agentStoreActions.resetForTest());
afterEach(() => vi.clearAllMocks());

describe('AgentBootstrap', () => {
  it('walks name → soul → purpose → done and creates the agent', async () => {
    const onDone = vi.fn();
    render(<AgentBootstrap onDone={onDone} />);

    // Step 1: name (Continue disabled until non-empty)
    const nameInput = screen.getByLabelText(/what should we call/i);
    fireEvent.change(nameInput, { target: { value: 'Ada' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    // Step 2: soul
    expect(screen.getByText(/give ada a personality/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/personality/i), { target: { value: 'Warm and patient.' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    // Step 3: purpose → create
    expect(screen.getByText(/here to help with/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/help with/i), { target: { value: 'help me write' } });
    fireEvent.click(screen.getByRole('button', { name: /create ada/i }));

    await waitFor(() => expect(bootstrapAgent).toHaveBeenCalledTimes(1));
    const arg = (bootstrapAgent as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as {
      displayName: string;
      systemPrompt: string;
    };
    expect(arg.displayName).toBe('Ada');
    expect(arg.systemPrompt).toContain('Warm and patient.');
    expect(arg.systemPrompt).toContain('Your job: help me write');

    // post-create: re-hydrate + select + done screen
    await waitFor(() => expect(hydrateAgentsOnce).toHaveBeenCalled());
    expect(screen.getByText(/ada is ready/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /start chatting/i }));
    expect(onDone).toHaveBeenCalled();
  });

  it('"Surprise me" fills a name so Continue enables', () => {
    render(<AgentBootstrap onDone={() => {}} />);
    const continueBtn = screen.getByRole('button', { name: /continue/i }) as HTMLButtonElement;
    expect(continueBtn.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /surprise me/i }));
    expect((screen.getByLabelText(/what should we call/i) as HTMLInputElement).value.length).toBeGreaterThan(0);
  });

  it('shows a Back-to-chat affordance only when canCancel is true', () => {
    const onCancel = vi.fn();
    const { rerender } = render(<AgentBootstrap onDone={() => {}} />);
    expect(screen.queryByRole('button', { name: /back to chat/i })).toBeNull();
    rerender(<AgentBootstrap onDone={() => {}} canCancel onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: /back to chat/i }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('surfaces a friendly error when create fails', async () => {
    (bootstrapAgent as unknown as { mockRejectedValueOnce: (e: unknown) => void }).mockRejectedValueOnce(
      new Error('bootstrap agent: 500'),
    );
    render(<AgentBootstrap onDone={() => {}} />);
    fireEvent.change(screen.getByLabelText(/what should we call/i), { target: { value: 'Ada' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    fireEvent.click(screen.getByRole('button', { name: /continue/i })); // soul left default
    fireEvent.click(screen.getByRole('button', { name: /create ada/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --filter @ax/channel-web -- AgentBootstrap`
Expected: FAIL — cannot find module `../onboard/AgentBootstrap`.

- [ ] **Step 3: Implement the component**

```tsx
// packages/channel-web/src/components/onboard/AgentBootstrap.tsx
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { SetupShell } from '../setup/SetupShell';
import { bootstrapAgent } from '../../lib/agent-bootstrap';
import { hydrateAgentsOnce } from '../../lib/hydrate-agents';
import { agentStoreActions } from '../../lib/agent-store';

type Step = 'name' | 'soul' | 'purpose' | 'done';

const NAME_SUGGESTIONS = ['Ada', 'Sol', 'Wren', 'Pilot'] as const;

const TRAIT_CHIPS: ReadonlyArray<{ label: string; sentence: string }> = [
  { label: 'Warm & encouraging', sentence: 'You are warm and encouraging, and never make me feel dumb for asking.' },
  { label: 'Direct & concise', sentence: 'You are direct and concise — you get to the point without padding.' },
  { label: 'Playful', sentence: 'You keep a light, playful tone and a sense of humor.' },
  { label: 'Careful & thorough', sentence: 'You are careful and thorough, and double-check your work before sharing it.' },
  { label: 'Asks before acting', sentence: 'You check in with me before taking any significant or irreversible action.' },
];

const PURPOSE_CHIPS: ReadonlyArray<{ label: string; sentence: string }> = [
  { label: 'Help me write', sentence: 'help me draft and edit writing' },
  { label: 'Think through problems', sentence: 'think through hard problems with me' },
  { label: 'Organize my work', sentence: 'help me organize and keep track of my work' },
  { label: 'Learn alongside me', sentence: 'help me learn new things' },
  { label: 'A bit of everything', sentence: 'be a general-purpose assistant for whatever comes up' },
];

function appendSentence(current: string, sentence: string): string {
  const trimmed = current.trim();
  if (trimmed.includes(sentence)) return current;
  return trimmed.length === 0 ? sentence : `${trimmed} ${sentence}`;
}

function composeSystemPrompt(opts: { name: string; soul: string; purpose: string }): string {
  const parts: string[] = [];
  const soul = opts.soul.trim();
  parts.push(soul.length > 0 ? soul : `You are ${opts.name}, a helpful personal assistant.`);
  const purpose = opts.purpose.trim();
  if (purpose.length > 0) parts.push(`Your job: ${purpose}`);
  return parts.join('\n\n');
}

export interface AgentBootstrapProps {
  /** Called when the user finishes (clicks "Start chatting") or after a fresh agent is active. */
  onDone: () => void;
  /** When true, show a "Back to chat" escape (used for the steady-state "+ New agent" entry). */
  canCancel?: boolean;
  onCancel?: () => void;
}

export function AgentBootstrap({ onDone, canCancel = false, onCancel }: AgentBootstrapProps) {
  const [step, setStep] = useState<Step>('name');
  const [name, setName] = useState('');
  const [soul, setSoul] = useState('');
  const [purpose, setPurpose] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const trimmedName = name.trim();

  async function create() {
    setBusy(true);
    setErr(null);
    try {
      const agent = await bootstrapAgent({
        displayName: trimmedName,
        systemPrompt: composeSystemPrompt({ name: trimmedName, soul, purpose }),
      });
      await hydrateAgentsOnce();
      agentStoreActions.setSelectedAgent(agent.agentId);
      setStep('done');
    } catch {
      setErr("We couldn't create your agent just now. This is on us, not you — give it another go in a moment.");
    } finally {
      setBusy(false);
    }
  }

  const backToChat =
    canCancel && onCancel ? (
      <Button variant="ghost" className="w-full mt-1" onClick={onCancel} type="button">
        ← Back to chat
      </Button>
    ) : null;

  if (step === 'done') {
    return (
      <SetupShell title={`${trimmedName} is ready`} description={`That's it — ${trimmedName} is yours. Say hi, ask anything, and tweak the details whenever you like.`}>
        <Button className="w-full" onClick={onDone} type="button">
          Start chatting →
        </Button>
      </SetupShell>
    );
  }

  if (step === 'name') {
    return (
      <SetupShell title="Let's make your first agent" description="Think of this as hiring a teammate — except it never steals your lunch. Three quick steps, and you can change everything later.">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="bootstrap-name">What should we call them?</Label>
            <Input
              id="bootstrap-name"
              autoFocus
              maxLength={128}
              placeholder="Ada"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">A name makes it feel less like a tool and more like a teammate. You can rename it later.</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[10.5px] tracking-[0.04em] uppercase text-muted-foreground">Need a nudge?</span>
            <div className="flex flex-wrap gap-1.5">
              {NAME_SUGGESTIONS.map((s) => (
                <Badge key={s} asChild variant="outline">
                  <button type="button" onClick={() => setName(s)}>{s}</button>
                </Badge>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-2 pt-1">
            <Button type="button" disabled={trimmedName.length === 0} onClick={() => setStep('soul')}>
              Continue
            </Button>
            <Button type="button" variant="ghost" onClick={() => setName(NAME_SUGGESTIONS[Math.floor(Math.random() * NAME_SUGGESTIONS.length)]!)}>
              Surprise me
            </Button>
            {backToChat}
          </div>
        </div>
      </SetupShell>
    );
  }

  if (step === 'soul') {
    return (
      <SetupShell title={`Give ${trimmedName} a personality`} description={`How should ${trimmedName} talk to you? Warm and chatty, or short and to the point? No wrong answers — and we won't tell ${trimmedName} you hesitated.`}>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="bootstrap-soul">Personality</Label>
            <Textarea
              id="bootstrap-soul"
              rows={4}
              placeholder="Friendly and encouraging. Explains things in plain language and never makes me feel dumb for asking."
              value={soul}
              onChange={(e) => setSoul(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">You can rewrite this anytime in settings.</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[10.5px] tracking-[0.04em] uppercase text-muted-foreground">Or start from a vibe:</span>
            <div className="flex flex-wrap gap-1.5">
              {TRAIT_CHIPS.map((t) => (
                <Badge key={t.label} asChild variant="outline">
                  <button type="button" onClick={() => setSoul((c) => appendSentence(c, t.sentence))}>{t.label}</button>
                </Badge>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-2 pt-1">
            <Button type="button" onClick={() => setStep('purpose')}>Continue</Button>
            <Button type="button" variant="ghost" onClick={() => setStep('purpose')}>Keep it simple</Button>
            {backToChat}
          </div>
        </div>
      </SetupShell>
    );
  }

  // step === 'purpose'
  return (
    <SetupShell title={`What's ${trimmedName} here to help with?`} description={`A rough idea is plenty — "help me write" or "think through hard problems" both work. ${trimmedName} figures out the rest with you.`}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="bootstrap-purpose">What should it help with?</Label>
          <Textarea
            id="bootstrap-purpose"
            rows={3}
            placeholder="Help me draft and edit writing, and talk through ideas before I commit to them."
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[10.5px] tracking-[0.04em] uppercase text-muted-foreground">Or pick a starting point:</span>
          <div className="flex flex-wrap gap-1.5">
            {PURPOSE_CHIPS.map((p) => (
              <Badge key={p.label} asChild variant="outline">
                <button type="button" onClick={() => setPurpose((c) => appendSentence(c, p.sentence))}>{p.label}</button>
              </Badge>
            ))}
          </div>
        </div>
        {err !== null && (
          <Alert variant="destructive">
            <AlertDescription>{err}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-col gap-2 pt-1">
          <Button type="button" disabled={busy} onClick={() => void create()}>
            {busy ? 'Creating…' : `Create ${trimmedName}`}
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => void create()}>
            Just give me the basics
          </Button>
          {backToChat}
        </div>
      </div>
    </SetupShell>
  );
}
```

> If `Badge asChild` is not supported by the installed `badge.tsx` (it lacks a Radix `Slot`), fall back to a plain `<button>` styled with the badge classes, e.g. `className="inline-flex items-center rounded-md border border-border px-2 py-0.5 text-xs hover:bg-muted"`. Check `packages/channel-web/src/components/ui/badge.tsx` for an `asChild` prop before relying on it.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --filter @ax/channel-web -- AgentBootstrap`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/components/onboard/AgentBootstrap.tsx packages/channel-web/src/components/__tests__/AgentBootstrap.test.tsx
git commit -m "feat(channel-web): AgentBootstrap name→soul→purpose first-run flow"
```

---

## Task 7: Gate `AppContent` on the load status + render bootstrap

**Files:**
- Modify: `packages/channel-web/src/App.tsx` (`AppContent`)
- Modify: `packages/channel-web/src/components/SessionHeader.tsx:16` (drop `useHydrateAgents`)

- [ ] **Step 1: Lift hydration into `AppContent`**

In `App.tsx`, add the import:

```ts
import { useHydrateAgents } from './components/AgentChip';
import { AgentBootstrap } from './components/onboard/AgentBootstrap';
```

At the top of `AppContent`, call the hook (it runs once) and read the status:

```ts
const AppContent = ({ user }: { user: AuthUser }) => {
  useTitleEvents();
  useHydrateAgents(); // lifted from SessionHeader so the first-run gate can read the result
  const { agents, agentsStatus, selectedAgentId, pendingAgentId } = useAgentStore();
  const runtime = useAxChatRuntime(user.id);
  const [adminSettingsOpen, setAdminSettingsOpen] = useState(false);
  const [routinesOpen, setRoutinesOpen] = useState(false);
  const [userSkillsOpen, setUserSkillsOpen] = useState(false);
  const [createAgentOpen, setCreateAgentOpen] = useState(false);
  const sidebarOpen = useSidebarOpen();
  // ...existing useEffect for hydrateSidebarCollapsed/theme/keyboard stays unchanged...
```

- [ ] **Step 2: Branch before rendering the chat shell**

Immediately before the existing `return (<UserProvider ...>` add:

```ts
  if (agentsStatus === 'loading') {
    return (
      <div className="flex items-center justify-center min-h-screen text-muted-foreground font-mono text-xs tracking-[0.04em]">
        loading your agents…
      </div>
    );
  }

  // First-run (no personal agent yet) OR the explicit "+ New agent" entry.
  // 'error' deliberately falls through to the chat shell — a transient blip
  // must not force an existing user into the create flow; "+ New agent"
  // remains available from the agent menu.
  const noAgents = agentsStatus === 'ready' && agents.length === 0;
  if (createAgentOpen || noAgents) {
    return (
      <UserProvider value={user}>
        <AgentBootstrap
          canCancel={!noAgents}
          onCancel={() => setCreateAgentOpen(false)}
          onDone={() => setCreateAgentOpen(false)}
        />
        <ToastStack />
      </UserProvider>
    );
  }
```

> `onDone`/`onCancel` both just clear `createAgentOpen`. After `onDone`, `agents.length > 0` (we re-hydrated + selected in the component), so `noAgents` is false and the chat shell renders with the new agent active.

- [ ] **Step 3: Pass the "+ New agent" opener into the header**

Change the `<SessionHeader />` render in `AppContent` to:

```tsx
                <SessionHeader onCreateAgent={() => setCreateAgentOpen(true)} />
```

- [ ] **Step 4: Drop the now-duplicated hydrate from `SessionHeader` + accept the prop**

In `packages/channel-web/src/components/SessionHeader.tsx`:
- Remove the `useHydrateAgents()` call (line 16) and its import if unused elsewhere in the file.
- Add a prop and forward it to the chip:

```tsx
export function SessionHeader({ onCreateAgent }: { onCreateAgent?: () => void }) {
  // ...existing body, minus useHydrateAgents()...
  // wherever <AgentChip /> is rendered:
  //   <AgentChip onCreateNew={onCreateAgent} />
}
```

> Keep `useHydrateAgents` **exported** from `AgentChip.tsx` (App.tsx now imports it). Only the *call site* moves.

- [ ] **Step 5: Run the build + existing App/SessionHeader tests**

Run: `pnpm build --filter @ax/channel-web`
Expected: clean.
Run: `pnpm test --filter @ax/channel-web -- SessionHeader App`
Expected: PASS — update any SessionHeader test that asserted a hydrate fetch fired from the header (it now fires from `AppContent`).

- [ ] **Step 6: Commit**

```bash
git add packages/channel-web/src/App.tsx packages/channel-web/src/components/SessionHeader.tsx
git commit -m "feat(channel-web): gate first-run agent bootstrap in AppContent"
```

---

## Task 8: "+ New agent" entry in `AgentMenu`

**Files:**
- Modify: `packages/channel-web/src/components/AgentChip.tsx` (accept + forward `onCreateNew`)
- Modify: `packages/channel-web/src/components/AgentMenu.tsx` (footer row)
- Test: `packages/channel-web/src/components/__tests__/AgentMenu.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// packages/channel-web/src/components/__tests__/AgentMenu.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgentMenu } from '../AgentMenu';

const agents = [
  { id: 'a1', name: 'Ada', desc: 'writer', color: '#7aa6c9' } as never,
];

describe('AgentMenu "+ New agent"', () => {
  it('renders a New agent row and calls onCreateNew', () => {
    const onCreateNew = vi.fn();
    render(<AgentMenu agents={agents} activeId="a1" onPick={() => {}} onCreateNew={onCreateNew} />);
    fireEvent.click(screen.getByRole('button', { name: /new agent/i }));
    expect(onCreateNew).toHaveBeenCalled();
  });

  it('omits the New agent row when onCreateNew is not provided', () => {
    render(<AgentMenu agents={agents} activeId="a1" onPick={() => {}} />);
    expect(screen.queryByRole('button', { name: /new agent/i })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --filter @ax/channel-web -- AgentMenu`
Expected: FAIL — `onCreateNew` not a prop; no "New agent" button.

- [ ] **Step 3: Add the prop + footer row to `AgentMenu.tsx`**

Extend the props interface:

```ts
export interface AgentMenuProps {
  agents: Agent[];
  activeId: string | null;
  onPick: (agentId: string) => void;
  /** When provided, renders a "+ New agent" row that opens the bootstrap flow. */
  onCreateNew?: () => void;
}
```

Replace the existing footnote `<div className="mt-1 pt-1 border-t border-border">…</div>` block with:

```tsx
      <div className="mt-1 pt-1 border-t border-border">
        {onCreateNew && (
          <button
            type="button"
            className="
              agent-menu-new group flex w-full items-center gap-2.5 cursor-pointer
              px-2.5 py-[7px] rounded-md transition-colors hover:bg-muted text-left
            "
            onClick={onCreateNew}
          >
            <AvatarTile size={22} background="muted">
              <span aria-hidden="true" className="text-[13px] leading-none text-muted-foreground">+</span>
            </AvatarTile>
            <span className="text-[14px] tracking-[-0.01em] leading-[1.1] text-foreground">New agent</span>
          </button>
        )}
        <div className="px-2.5 pt-2 pb-1 text-[10.5px] tracking-[0.04em] text-ink-ghost text-center">
          a new session starts on your next message
        </div>
      </div>
```

- [ ] **Step 4: Forward the prop through `AgentChip`**

In `AgentChip.tsx`:
- Add `onCreateNew?: () => void` to the chip's props.
- Pass it to the menu: `{open && <AgentMenu agents={agents} activeId={activeId} onPick={handlePick} onCreateNew={onCreateNew} />}`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test --filter @ax/channel-web -- AgentMenu`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/channel-web/src/components/AgentMenu.tsx packages/channel-web/src/components/AgentChip.tsx packages/channel-web/src/components/__tests__/AgentMenu.test.tsx
git commit -m "feat(channel-web): + New agent entry in the agent menu"
```

---

## Task 9: Full verification + manual acceptance

**Files:** none (verification only)

- [ ] **Step 1: Whole-package build + test + lint (the pre-PR gate)**

Run: `pnpm build`
Expected: clean (tsc across refs — catches undeclared deps the per-package vitest tolerates).

Run: `pnpm test --filter @ax/channel-web`
Expected: all green, including the six new test files.

Run: `pnpm lint` (scope to changed files if `.worktrees/` noise appears — see project memory `feedback_workspace_lint_stale_worktree_noise`).
Expected: clean.

- [ ] **Step 2: Manual acceptance on the kind cluster `ax-next-dev`**

Use the `k8s-acceptance-loop` skill (host-side TypeScript only → fast hostPath dist loop, no image rebuild). Drive with Playwright MCP:

1. Sign in as a **fresh non-admin user** with zero personal agents (mint a session cookie per `reference_headless_authed_chat_kind`, or create a new user via the auth flow).
2. Confirm the SPA renders `<AgentBootstrap>` (title "Let's make your first agent") instead of the chat — NOT a chat bound to "—".
3. Walk name → soul (click a vibe chip, confirm it fills the textarea) → purpose → "Create {name}".
4. Confirm the done screen, then "Start chatting →" lands in a blank thread with the new agent in the chip.
5. Send a message; confirm a turn completes (the agent has the full tool catalog — try a prompt that needs a tool).
6. Open the agent menu → click "+ New agent" → confirm the same flow opens with a "← Back to chat" escape; cancel returns to chat.
7. Reload the page; confirm the user goes straight to chat (now has an agent) — no bootstrap re-trigger.

- [ ] **Step 3: Update project memory**

Append a short note to `.claude/memory/` (your branch copy — see CLAUDE.md parallel-agent rule) recording: the bootstrap route reuses `agents:create` with the wildcard (matching onboarding's Default Agent), the tri-state `agentsStatus` gate, and the model/tools/visibility decisions. Commit it on the branch.

- [ ] **Step 4: Open the PR**

PR description must include the **boundary-review** note (no new hook signature; only `manifest.calls` gained `agents:create`) and the **security-checklist** output from Task 3 (untrusted `displayName`/`systemPrompt`; route fixes visibility/owner/tools server-side so it can't over-grant).

```bash
git push -u origin <branch>
gh pr create --title "User personal-agent bootstrap (first-run name→soul→purpose)" --body "<filled per above>"
```

---

## Self-Review (completed)

**Spec coverage:** name step ✓ (Task 6), soul/identity ✓, purpose ✓, hidden model/tools/visibility ✓ (Task 3 server-fixed), entry condition = empty list ✓ (Task 7), loading-vs-empty signal ✓ (Task 1), "+ New agent" ✓ (Task 8), wildcard default ✓ (Task 3), error-doesn't-force-bootstrap ✓ (Task 7 fall-through). All five decisions implemented.

**Type consistency:** `agentsStatus` / `setAgentsError` / `resetForTest` / `getAgentStoreSnapshot` (Task 1) used identically in Tasks 2, 6, 7. `hydrateAgentsOnce` (Task 2) called in Tasks 6, 7. `bootstrapAgent({ displayName, systemPrompt })` (Task 5) called with the same shape in Task 6. Route returns `{ agent: { agentId, displayName, visibility } }` (Task 3) consumed by `bootstrapAgent`'s `BootstrappedAgent` (Task 5). `onCreateNew` (Task 8) ↔ `onCreateAgent` (Task 7) wired chip→header→AppContent.

**Placeholders:** none — every step ships real code, exact commands, and expected output. Trait/purpose/name constants are concrete strings; `composeSystemPrompt` and `appendSentence` are fully defined.
