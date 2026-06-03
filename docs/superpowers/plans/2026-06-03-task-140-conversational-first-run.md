# TASK-140 — Conversational first-run + backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Wire the Phase-1 runner prompt-engine to a real entry point — `POST /api/agents/bootstrap` creates a *bare* agent and seeds `/permanent/.ax/BOOTSTRAP.md`, the SPA first-run auto-creates a bare agent and opens chat (no form), and every existing agent is backfilled to `.ax/IDENTITY.md` + `.ax/SOUL.md`.

**Architecture:** Host seeds at create (verified "first apply creates main" path). `BOOTSTRAP_TEMPLATE` moves to a new pure-data package `@ax/agent-identity-templates` so both `@ax/channel-web` and `@ax/agent-claude-sdk-runner` import it without a cross-plugin runtime import (Invariant #2). Backfill runs once in `@ax/agents` init, guarded by `bus.hasService('workspace:apply')` (degrades when no workspace backend), idempotent via a `workspace:read('.ax/IDENTITY.md')` probe.

**Tech Stack:** TypeScript, pnpm workspace + tsconfig refs, vitest, React 19 + zustand-ish store, Kysely, the AX hook bus.

**Seeding-owner decision (PR-notes pin):** **host-at-create**. Verified `@ax/workspace-git-server`'s `git-engine.apply` lazy-creates the repo (`ensureRepoCreated`) and `buildScratch(mirrorHead=null)` inits `-b main`, pushing `--force-with-lease=refs/heads/main:` (empty lease) — so a brand-new agent's first `workspace:apply({ parent: null })` creates `main`. No runner-first-session fallback needed.

---

## File Structure

**New package `@ax/agent-identity-templates`** (pure data, no `@ax/core` dep — mirrors `@ax/skills-parser`):
- Create `packages/agent-identity-templates/package.json`
- Create `packages/agent-identity-templates/tsconfig.json`
- Create `packages/agent-identity-templates/vitest.config.ts` (if needed — copy a sibling)
- Create `packages/agent-identity-templates/src/index.ts` — re-exports `BOOTSTRAP_TEMPLATE`, `IDENTITY_SCAFFOLD`, `SOUL_SCAFFOLD`
- Create `packages/agent-identity-templates/src/templates.ts` — the moved template constants + a `backfillIdentityFile(displayName)` helper
- Create `packages/agent-identity-templates/src/__tests__/templates.test.ts`

**`@ax/agent-claude-sdk-runner`** (Phase 1 owner of the template — now re-exports from the shared pkg):
- Modify `packages/agent-claude-sdk-runner/src/identity-templates.ts` — re-export from `@ax/agent-identity-templates` (keep the import path stable for existing tests)
- Modify `packages/agent-claude-sdk-runner/package.json` — add the dep
- Modify `packages/agent-claude-sdk-runner/tsconfig.json` — add the ref

**`eslint.config.mjs`** — add `@ax/agent-identity-templates` to the `no-restricted-imports` allow-list.

**`@ax/agents`** (backfill):
- Create `packages/agents/src/backfill-identity.ts` — the backfill routine (`runIdentityBackfill`)
- Modify `packages/agents/src/plugin.ts` — call `runIdentityBackfill` at end of init (guarded); add `optionalCalls` for `workspace:apply` + `workspace:read`
- Modify `packages/agents/src/store.ts` — add `listAll()` returning full `Agent[]` (or reuse `listAllIds`+`getById`); we add a `listAll()` for efficiency + test clarity
- Modify `packages/agents/package.json` — add `@ax/agent-identity-templates` dep
- Modify `packages/agents/tsconfig.json` — add the ref
- Create `packages/agents/src/__tests__/backfill-identity.test.ts`

**`@ax/agents` store — accept absent systemPrompt:**
- Modify `packages/agents/src/store.ts` — `validateSystemPrompt` accepts `undefined` → `''`; wire into `validateCreateInput`
- Modify `packages/agents/src/__tests__/store.test.ts` — add a "bare create" case

**`@ax/channel-web` bootstrap route + plugin:**
- Modify `packages/channel-web/src/server/routes-agent-bootstrap.ts` — create bare agent (no `systemPrompt` in body), then `workspace:apply` BOOTSTRAP.md routed to the new agent's ctx
- Modify `packages/channel-web/src/server/plugin.ts` — add `workspace:apply` to manifest `calls`; pass nothing new to the handler (handler already has `bus`)
- Modify `packages/channel-web/package.json` + `tsconfig.json` — add `@ax/agent-identity-templates` dep + ref
- Modify `packages/channel-web/src/__tests__/server/routes-agent-bootstrap.test.ts` — assert bare create + BOOTSTRAP seed

**`@ax/channel-web` SPA first-run gate:**
- Create `packages/channel-web/src/lib/auto-create-agent.ts` — `autoCreateBareAgent()` (POST bootstrap with `{ displayName }` only, returns id)
- Modify `packages/channel-web/src/App.tsx` — replace `<AgentBootstrap>` branch with an auto-create-then-open-chat effect/component
- Create `packages/channel-web/src/components/onboard/FirstRunAutoCreate.tsx` — the headless auto-create + spinner UI
- Delete `packages/channel-web/src/components/onboard/AgentBootstrap.tsx`
- Delete `packages/channel-web/src/lib/agent-bootstrap.ts` (replaced by `auto-create-agent.ts`)
- Delete `packages/channel-web/src/components/__tests__/AgentBootstrap.test.tsx`
- Delete `packages/channel-web/src/components/__tests__/composeSystemPrompt.test.ts`
- Delete `packages/channel-web/src/components/__tests__/AgentBootstrapGate.test.tsx` IF it depends on the form (check; keep the gate-decision test, drop only form assertions)
- Delete `packages/channel-web/src/__tests__/agent-bootstrap-client.test.ts` (tests the deleted `agent-bootstrap.ts`)
- Modify `packages/channel-web/src/lib/agent-bootstrap-gate.ts` — KEEP `shouldShowAgentBootstrap` decision unchanged
- Create `packages/channel-web/src/components/__tests__/FirstRunAutoCreate.test.tsx`

---

## Task 1: Shared template package `@ax/agent-identity-templates`

**Files:**
- Create: `packages/agent-identity-templates/package.json`, `tsconfig.json`, `src/templates.ts`, `src/index.ts`, `src/__tests__/templates.test.ts`

- [ ] **Step 1: Scaffold the package files.** Copy `@ax/skills-parser`'s shape (no deps).

`packages/agent-identity-templates/package.json`:
```json
{
  "name": "@ax/agent-identity-templates",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": { "build": "tsc --build", "test": "vitest run", "test:watch": "vitest" },
  "devDependencies": { "@types/node": "^25.6.0", "typescript": "^6.0.3", "vitest": "^4.1.4" }
}
```

`packages/agent-identity-templates/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "rootDir": "src", "outDir": "dist" }, "include": ["src/**/*"], "exclude": ["src/__tests__/**", "dist", "node_modules"], "references": [] }
```

- [ ] **Step 2: Write the failing test** `src/__tests__/templates.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { BOOTSTRAP_TEMPLATE, IDENTITY_SCAFFOLD, SOUL_SCAFFOLD, backfillIdentityFile } from '../index.js';

describe('agent-identity-templates', () => {
  it('BOOTSTRAP_TEMPLATE names its own deletable path and uses the Write tool', () => {
    expect(BOOTSTRAP_TEMPLATE).toContain('.ax/BOOTSTRAP.md');
    expect(BOOTSTRAP_TEMPLATE).toContain('`Write`');
    expect(BOOTSTRAP_TEMPLATE).toContain('.ax/IDENTITY.md');
    expect(BOOTSTRAP_TEMPLATE).toContain('.ax/SOUL.md');
  });
  it('scaffolds are non-empty markdown', () => {
    expect(IDENTITY_SCAFFOLD).toContain('# Identity');
    expect(SOUL_SCAFFOLD).toContain('# Soul');
  });
  it('backfillIdentityFile names the agent', () => {
    expect(backfillIdentityFile('Ada')).toBe('You are Ada, a helpful personal assistant.');
  });
});
```

- [ ] **Step 3: Run it — verify it fails** (`pnpm --filter @ax/agent-identity-templates test`) — FAIL (no module).

- [ ] **Step 4: Create `src/templates.ts`.** MOVE the three constants verbatim from `packages/agent-claude-sdk-runner/src/identity-templates.ts` (the `BOOTSTRAP_TEMPLATE`, `IDENTITY_SCAFFOLD`, `SOUL_SCAFFOLD` exports — copy the exact template body and the explanatory header comment). Then ADD:
```ts
/**
 * The canonical one-line IDENTITY.md body the backfill writes for an existing
 * agent. Names the agent (closing the "says Claude" gap) without attempting to
 * split identity from personality (design open-question #4 — the whole legacy
 * system_prompt goes verbatim into SOUL.md instead).
 */
export function backfillIdentityFile(displayName: string): string {
  return `You are ${displayName}, a helpful personal assistant.`;
}
```

- [ ] **Step 5: Create `src/index.ts`:**
```ts
export { BOOTSTRAP_TEMPLATE, IDENTITY_SCAFFOLD, SOUL_SCAFFOLD, backfillIdentityFile } from './templates.js';
```

- [ ] **Step 6: Add the package to the root workspace + eslint allow-list.** In `eslint.config.mjs` add `'!@ax/agent-identity-templates',` to the `no-restricted-imports` `group` array (after `'!@ax/skills-parser',`) and append it to the `message` string's allow-list enumeration. (No pnpm-workspace edit needed — `packages/*` is globbed.)

- [ ] **Step 7: Run `pnpm install` then the test — PASS.**
```bash
pnpm install
pnpm --filter @ax/agent-identity-templates build
pnpm --filter @ax/agent-identity-templates test
```

- [ ] **Step 8: Commit.**
```bash
git add packages/agent-identity-templates eslint.config.mjs pnpm-lock.yaml
git commit -m "feat(agent-identity-templates): pure-data package for the bootstrap/identity templates"
```

## Task 2: Point the runner's `identity-templates.ts` at the shared package

**Files:**
- Modify: `packages/agent-claude-sdk-runner/src/identity-templates.ts`, `packages/agent-claude-sdk-runner/package.json`, `packages/agent-claude-sdk-runner/tsconfig.json`

- [ ] **Step 1: Add the dep + ref.** `package.json` `dependencies`: add `"@ax/agent-identity-templates": "workspace:*"`. `tsconfig.json` `references`: add `{ "path": "../agent-identity-templates" }`.

- [ ] **Step 2: Replace the body of `identity-templates.ts`** with a thin re-export so every existing import path (`./identity-templates.js`) keeps working:
```ts
// ---------------------------------------------------------------------------
// Canonical agent-identity templates — re-exported from the shared
// `@ax/agent-identity-templates` pure-data package so a second consumer
// (@ax/channel-web's bootstrap route, TASK-140) can import the SAME bytes
// without a cross-plugin runtime import (Invariant #2). The runner keeps this
// module path stable for its own imports + tests.
// ---------------------------------------------------------------------------
export { BOOTSTRAP_TEMPLATE, IDENTITY_SCAFFOLD, SOUL_SCAFFOLD } from '@ax/agent-identity-templates';
```

- [ ] **Step 3: Run the runner's identity-templates test + build.**
```bash
pnpm install
pnpm --filter @ax/agent-claude-sdk-runner build
pnpm --filter @ax/agent-claude-sdk-runner test -- identity-templates
```
Expected: PASS (the existing `__tests__/identity-templates.test.ts` asserts the same constants).

- [ ] **Step 4: Commit.**
```bash
git add packages/agent-claude-sdk-runner
git commit -m "refactor(runner): re-export identity templates from @ax/agent-identity-templates"
```

## Task 3: `agents:create` accepts an absent `systemPrompt`

**Files:**
- Modify: `packages/agents/src/store.ts` (`validateSystemPrompt`), `packages/agents/src/__tests__/store.test.ts`

- [ ] **Step 1: Write the failing test** in `store.test.ts` (find the `validateCreateInput` describe block; add):
```ts
it('defaults an absent systemPrompt to empty string (bare create)', () => {
  const out = validateCreateInput(
    { displayName: 'Bare', allowedTools: [], mcpConfigIds: [], model: 'claude-sonnet-4-6', visibility: 'personal' } as any,
    { allowedModels: ['claude-sonnet-4-6'] },
  );
  expect(out.systemPrompt).toBe('');
});
it('still rejects a non-string systemPrompt', () => {
  expect(() => validateCreateInput(
    { displayName: 'X', systemPrompt: 123, allowedTools: [], mcpConfigIds: [], model: 'claude-sonnet-4-6', visibility: 'personal' } as any,
    { allowedModels: ['claude-sonnet-4-6'] },
  )).toThrow();
});
```
(Confirm `validateCreateInput` is exported from store.ts — it is, line ~250.)

- [ ] **Step 2: Run — FAIL** (`pnpm --filter @ax/agents test -- store`). The absent-prompt case throws `systemPrompt must be a string`.

- [ ] **Step 3: Edit `validateSystemPrompt`** in `store.ts`:
```ts
function validateSystemPrompt(value: unknown): string {
  // TASK-140: absent systemPrompt is now legal — a BARE agent (no identity
  // string) gets its identity from `.ax/` files, not this column. Default
  // undefined → '' so the bootstrap route can create an agent with no prompt.
  // A non-string that's PRESENT is still a hard reject (a typo'd payload, not
  // an intentional omission).
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value !== 'string') {
    throw invalid('systemPrompt must be a string');
  }
  if (value.length > SYSTEM_PROMPT_MAX) {
    throw invalid(`systemPrompt must be at most ${SYSTEM_PROMPT_MAX} chars`);
  }
  return value;
}
```

- [ ] **Step 4: Run — PASS.**

- [ ] **Step 5: Commit.**
```bash
git add packages/agents/src/store.ts packages/agents/src/__tests__/store.test.ts
git commit -m "feat(agents): agents:create accepts an absent systemPrompt (bare agent)"
```

## Task 4: Backfill routine in `@ax/agents`

**Files:**
- Create: `packages/agents/src/backfill-identity.ts`, `packages/agents/src/__tests__/backfill-identity.test.ts`
- Modify: `packages/agents/src/store.ts` (add `listAll`), `packages/agents/package.json`, `packages/agents/tsconfig.json`

- [ ] **Step 1: Add `listAll` to the store.** In `store.ts`, add to the `AgentStore` interface and impl (near `listAllIds`):
  - Interface: `listAll(): Promise<Agent[]>;`
  - Impl:
```ts
async listAll() {
  const rows = await db.selectFrom('agents_v1_agents').selectAll().execute();
  return rows.map(rowToAgent);
},
```
(Use the same `selectAll` + `rowToAgent` shape as `getById`; the eslint tenant-table guard allows `agents_v1_*` selects inside `store.ts`.)

- [ ] **Step 2: Add the dep + ref.** `packages/agents/package.json` deps: `"@ax/agent-identity-templates": "workspace:*"`. `tsconfig.json` refs: `{ "path": "../agent-identity-templates" }`.

- [ ] **Step 3: Write the failing test** `src/__tests__/backfill-identity.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { makeAgentContext } from '@ax/core';
import { runIdentityBackfill } from '../backfill-identity.js';
import { backfillIdentityFile } from '@ax/agent-identity-templates';

type Agent = { id: string; ownerId: string; ownerType: 'user' | 'team'; displayName: string; systemPrompt: string };

function fakeStore(agents: Agent[]) {
  return { listAll: async () => agents } as any;
}

function fakeBus(opts: { existing?: Set<string> } = {}) {
  const existing = opts.existing ?? new Set<string>();
  const applies: Array<{ agentId: string; userId: string; changes: any[] }> = [];
  const bus = {
    hasService: (h: string) => h === 'workspace:apply' || h === 'workspace:read',
    call: vi.fn(async (hook: string, ctx: any, input: any) => {
      if (hook === 'workspace:read') {
        return existing.has(ctx.agentId) ? { found: true, bytes: new Uint8Array() } : { found: false };
      }
      if (hook === 'workspace:apply') {
        applies.push({ agentId: ctx.agentId, userId: ctx.userId, changes: input.changes });
        return { version: 'v1', delta: { before: null, after: 'v1', changes: [] } };
      }
      throw new Error(`unexpected hook ${hook}`);
    }),
  } as any;
  return { bus, applies };
}

const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe('runIdentityBackfill', () => {
  it('writes IDENTITY.md + SOUL.md for a personal agent with no .ax files', async () => {
    const store = fakeStore([{ id: 'a1', ownerId: 'u1', ownerType: 'user', displayName: 'Ada', systemPrompt: 'You are warm.' }]);
    const { bus, applies } = fakeBus();
    await runIdentityBackfill({ bus, store, initCtx: makeAgentContext({ sessionId: 'init', agentId: '@ax/agents', userId: 'system' }) });
    expect(applies).toHaveLength(1);
    expect(applies[0]!.agentId).toBe('a1');
    expect(applies[0]!.userId).toBe('u1'); // real owner, not 'system'
    const byPath = new Map(applies[0]!.changes.map((c: any) => [c.path, dec(c.content)]));
    expect(byPath.get('.ax/IDENTITY.md')).toBe(backfillIdentityFile('Ada'));
    expect(byPath.get('.ax/SOUL.md')).toBe('You are warm.');
    const apply = bus.call.mock.calls.find((c: any[]) => c[0] === 'workspace:apply');
    expect(apply![2].parent).toBeNull();
  });

  it('skips an agent that already has .ax/IDENTITY.md (idempotent)', async () => {
    const store = fakeStore([{ id: 'a1', ownerId: 'u1', ownerType: 'user', displayName: 'Ada', systemPrompt: 'x' }]);
    const { bus, applies } = fakeBus({ existing: new Set(['a1']) });
    await runIdentityBackfill({ bus, store, initCtx: makeAgentContext({ sessionId: 'init', agentId: '@ax/agents', userId: 'system' }) });
    expect(applies).toHaveLength(0);
  });

  it('skips team agents (no real personal owner ctx)', async () => {
    const store = fakeStore([{ id: 't1', ownerId: 'team-x', ownerType: 'team', displayName: 'Team Bot', systemPrompt: 'x' }]);
    const { bus, applies } = fakeBus();
    await runIdentityBackfill({ bus, store, initCtx: makeAgentContext({ sessionId: 'init', agentId: '@ax/agents', userId: 'system' }) });
    expect(applies).toHaveLength(0);
  });

  it('is a no-op when no workspace backend is registered', async () => {
    const store = fakeStore([{ id: 'a1', ownerId: 'u1', ownerType: 'user', displayName: 'Ada', systemPrompt: 'x' }]);
    const bus = { hasService: () => false, call: vi.fn() } as any;
    await runIdentityBackfill({ bus, store, initCtx: makeAgentContext({ sessionId: 'init', agentId: '@ax/agents', userId: 'system' }) });
    expect(bus.call).not.toHaveBeenCalled();
  });

  it('continues past one agent whose apply throws', async () => {
    const store = fakeStore([
      { id: 'bad', ownerId: 'u1', ownerType: 'user', displayName: 'Bad', systemPrompt: 'x' },
      { id: 'good', ownerId: 'u2', ownerType: 'user', displayName: 'Good', systemPrompt: 'y' },
    ]);
    const applies: string[] = [];
    const bus = {
      hasService: () => true,
      call: vi.fn(async (hook: string, ctx: any) => {
        if (hook === 'workspace:read') return { found: false };
        if (ctx.agentId === 'bad') throw new Error('boom');
        applies.push(ctx.agentId);
        return { version: 'v1', delta: { before: null, after: 'v1', changes: [] } };
      }),
    } as any;
    await runIdentityBackfill({ bus, store, initCtx: makeAgentContext({ sessionId: 'init', agentId: '@ax/agents', userId: 'system' }) });
    expect(applies).toEqual(['good']);
  });
});
```

- [ ] **Step 4: Run — FAIL** (no module). `pnpm --filter @ax/agents test -- backfill-identity`.

- [ ] **Step 5: Implement `backfill-identity.ts`:**
```ts
import { makeAgentContext, makeReqId, type AgentContext, type HookBus } from '@ax/core';
import { backfillIdentityFile } from '@ax/agent-identity-templates';

const PLUGIN_NAME = '@ax/agents';

/** Minimal agent shape the backfill needs (a subset of the store's Agent). */
interface BackfillAgent {
  id: string;
  ownerId: string;
  ownerType: 'user' | 'team';
  displayName: string;
  systemPrompt: string;
}
interface BackfillStore {
  listAll(): Promise<BackfillAgent[]>;
}

export interface IdentityBackfillDeps {
  bus: HookBus;
  store: BackfillStore;
  initCtx: AgentContext;
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * One-shot, idempotent migration: give every EXISTING personal agent the two
 * `.ax/` identity files the file-reading runner now expects.
 *
 *   `.ax/IDENTITY.md` = `You are <displayName>, a helpful personal assistant.`
 *   `.ax/SOUL.md`     = the agent's legacy `system_prompt`, VERBATIM
 *
 * (design open-question #4: no attempt to split identity from personality — the
 * whole legacy blob is the soul; the IDENTITY line just finally names the agent,
 * closing the "says Claude" gap.) No `AGENTS.md`. The DB `system_prompt` column
 * is NOT dropped here (that's Phase 4) — the string fallback still covers the
 * brief in-flight window before this runs on a given agent.
 *
 * Idempotent: an agent that already has `.ax/IDENTITY.md` is skipped (a re-run,
 * or an agent that bootstrapped itself, is free). Team agents are skipped — a
 * team workspace has no single personal-owner ctx to route the apply under, and
 * routing a default identity under a team is a policy question, not a migration
 * (mirrors `agents:list-personal-owners`). Each agent is best-effort: an apply
 * failure is logged and the loop continues, never blocking boot.
 *
 * No-op when no workspace backend is registered (a preset that strips workspace
 * — the agent simply gets its identity later via the runner string fallback).
 */
export async function runIdentityBackfill(deps: IdentityBackfillDeps): Promise<void> {
  const { bus, store, initCtx } = deps;
  if (!bus.hasService('workspace:apply') || !bus.hasService('workspace:read')) {
    return;
  }
  const agents = await store.listAll();
  for (const agent of agents) {
    if (agent.ownerType !== 'user') continue; // team agents: skip (no personal-owner ctx)
    // Route reads/writes to THIS agent's workspace: ctx carries (userId, agentId).
    const ctx = makeAgentContext({
      reqId: makeReqId(),
      sessionId: 'identity-backfill',
      agentId: agent.id,
      userId: agent.ownerId,
    });
    try {
      const existing = await bus.call<{ path: string }, { found: boolean }>(
        'workspace:read',
        ctx,
        { path: '.ax/IDENTITY.md' },
      );
      if (existing.found) continue; // already has identity files — idempotent skip
      await bus.call('workspace:apply', ctx, {
        changes: [
          { path: '.ax/IDENTITY.md', kind: 'put', content: enc(backfillIdentityFile(agent.displayName)) },
          { path: '.ax/SOUL.md', kind: 'put', content: enc(agent.systemPrompt) },
        ],
        parent: null,
        reason: 'identity-backfill',
      });
    } catch (err) {
      initCtx.logger.warn('agents_identity_backfill_failed', {
        plugin: PLUGIN_NAME,
        agentId: agent.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
```

- [ ] **Step 6: Run — PASS.** `pnpm --filter @ax/agents test -- backfill-identity`.

- [ ] **Step 7: Commit.**
```bash
git add packages/agents/src/backfill-identity.ts packages/agents/src/__tests__/backfill-identity.test.ts packages/agents/src/store.ts packages/agents/package.json packages/agents/tsconfig.json
git commit -m "feat(agents): identity backfill routine — .ax/IDENTITY.md + .ax/SOUL.md per existing agent"
```

## Task 5: Wire the backfill into `@ax/agents` init

**Files:**
- Modify: `packages/agents/src/plugin.ts`

- [ ] **Step 1: Add `optionalCalls`.** In the manifest, append to `optionalCalls`:
```ts
{ hook: 'workspace:apply', degradation: 'identity backfill is skipped (no workspace backend) — agents fall back to the runner string identity' },
{ hook: 'workspace:read', degradation: 'identity backfill is skipped (no workspace backend)' },
```
(They MUST be `optionalCalls`, not `calls`: a preset that strips the workspace plugin must still boot. The `hasService` guard inside `runIdentityBackfill` is the degradation.)

- [ ] **Step 2: Import + call the backfill** at the END of `init` (after all services + admin routes are registered, so the workspace backend's services are live — topological order already guarantees workspace inits before agents because of the optionalCalls edge). Add the import at top: `import { runIdentityBackfill } from './backfill-identity.js';`. At the end of `init`, after `unregisterRoutes.push(...unregisters);`:
```ts
// TASK-140: one-shot idempotent identity backfill. Runs after every service
// is registered; guarded + best-effort inside (no-op without a workspace
// backend, logs+continues per agent). Awaited so a fresh deploy has files
// before the first chat, but a failure here must not fail boot — the routine
// swallows per-agent errors internally.
await runIdentityBackfill({ bus, store: localStore, initCtx });
```

- [ ] **Step 3: Run the agents plugin test suite + build.**
```bash
pnpm --filter @ax/agents build
pnpm --filter @ax/agents test
```
Expected: PASS. (Existing `plugin.test.ts` boots the plugin without a workspace backend → backfill is a no-op via `hasService` guard, so no new failures.)

- [ ] **Step 4: Add a plugin-level integration test** asserting the backfill fires when a workspace backend IS present. Append to `packages/agents/src/__tests__/plugin.test.ts` (follow the file's existing harness for booting the plugin with a bus; if it uses `createMockWorkspacePlugin`, register it before agents). If the existing harness makes this awkward, instead assert in `plugin.test.ts` that booting WITHOUT a workspace backend does NOT throw (the no-op path) — the per-routine behavior is already covered by Task 4's unit tests. Pick whichever the existing harness supports; prefer the real-mock-workspace integration if cheap.

- [ ] **Step 5: Run — PASS. Commit.**
```bash
git add packages/agents/src/plugin.ts packages/agents/src/__tests__/plugin.test.ts
git commit -m "feat(agents): run identity backfill at init (guarded, best-effort)"
```

## Task 6: Bootstrap route — bare agent + seed BOOTSTRAP.md

**Files:**
- Modify: `packages/channel-web/src/server/routes-agent-bootstrap.ts`, `packages/channel-web/package.json`, `packages/channel-web/tsconfig.json`, `packages/channel-web/src/server/plugin.ts`
- Modify: `packages/channel-web/src/__tests__/server/routes-agent-bootstrap.test.ts`

- [ ] **Step 1: Add dep + ref.** `packages/channel-web/package.json` deps: `"@ax/agent-identity-templates": "workspace:*"`. `tsconfig.json` refs: `{ "path": "../agent-identity-templates" }`.

- [ ] **Step 2: Update the route test FIRST** (`routes-agent-bootstrap.test.ts`). Change the body contract from `{ displayName, systemPrompt }` to `{ displayName }` only, and add a `workspace:apply` capture to `busWith`. Replace the file's `busWith` + first two tests:
```ts
function busWith(opts: {
  user?: { id: string; isAdmin: boolean } | 'reject';
  onCreate?: (input: unknown) => unknown;
}): { bus: HookBus; created: Array<{ ctx: AgentContext; input: unknown }>; applies: Array<{ ctx: AgentContext; input: any }> } {
  const created: Array<{ ctx: AgentContext; input: unknown }> = [];
  const applies: Array<{ ctx: AgentContext; input: any }> = [];
  const bus = new HookBus();
  bus.registerService('auth:require-user', 'auth', async () => {
    if (opts.user === 'reject')
      throw new PluginError({ code: 'unauthenticated', plugin: 'auth', message: 'no session' });
    return { user: opts.user ?? { id: 'u1', isAdmin: false } };
  });
  bus.registerService('agents:create', 'agents', async (ctx, input) => {
    created.push({ ctx, input });
    if (opts.onCreate) return opts.onCreate(input);
    return { agent: { id: 'new-agent-1', displayName: (input as { input: { displayName: string } }).input.displayName, visibility: 'personal' } };
  });
  bus.registerService('workspace:apply', 'workspace', async (ctx, input) => {
    applies.push({ ctx, input });
    return { version: 'v1', delta: { before: null, after: 'v1', changes: [] } };
  });
  return { bus, created, applies };
}
```
Then rewrite the happy-path test:
```ts
it('creates a BARE personal agent and seeds .ax/BOOTSTRAP.md', async () => {
  const { bus, created, applies } = busWith({ user: { id: 'u1', isAdmin: false } });
  const h = makeAgentBootstrapHandler({ bus, initCtx });
  const { res, captured } = fakeRes();
  await h.bootstrap(fakeReq({ body: { displayName: 'Ada' } }), res);
  expect(captured.statusCode).toBe(201);
  expect(captured.body).toEqual({ agent: { agentId: 'new-agent-1', displayName: 'Ada', visibility: 'personal' } });
  // bare create: no systemPrompt sent
  const cin = created[0]!.input as { input: Record<string, unknown> };
  expect(cin.input.systemPrompt).toBeUndefined();
  expect(cin.input.visibility).toBe('personal');
  expect(cin.input.allowedTools).toEqual([]);
  // seed BOOTSTRAP.md routed to the NEW agent's workspace
  expect(applies).toHaveLength(1);
  expect(applies[0]!.ctx.agentId).toBe('new-agent-1');
  expect(applies[0]!.ctx.userId).toBe('u1');
  expect(applies[0]!.input.parent).toBeNull();
  const change = applies[0]!.input.changes[0];
  expect(change.path).toBe('.ax/BOOTSTRAP.md');
  expect(new TextDecoder().decode(change.content)).toContain('.ax/BOOTSTRAP.md');
});
```
Keep the "ignores client-supplied tools/model/visibility", "401", "blank displayName 400", "129-char 400" tests (drop any `systemPrompt` from their bodies). Add:
```ts
it('returns 201 even if seeding BOOTSTRAP.md fails (agent already created)', async () => {
  const { bus } = busWith({ user: { id: 'u1', isAdmin: false } });
  // re-register apply to throw
  bus.registerService('workspace:apply', 'workspace', async () => { throw new Error('seed boom'); });
  const h = makeAgentBootstrapHandler({ bus, initCtx });
  const { res, captured } = fakeRes();
  await h.bootstrap(fakeReq({ body: { displayName: 'Ada' } }), res);
  // The agent exists; the SPA opens chat and the runner seeds nothing yet —
  // but we must not 500 after a successful create. 201 with a seeded:false hint.
  expect(captured.statusCode).toBe(201);
});
```
NOTE: `HookBus.registerService` twice for the same hook may throw "duplicate". If so, add a `seedThrows?: boolean` option to `busWith` instead of re-registering. Implementer: check `HookBus` behavior and use whichever compiles.

- [ ] **Step 3: Run — FAIL.** `pnpm --filter @ax/channel-web test -- routes-agent-bootstrap`.

- [ ] **Step 4: Rewrite the route.** In `routes-agent-bootstrap.ts`:
  - Import: `import { makeAgentContext, makeReqId, ... } from '@ax/core';` (add `makeAgentContext`, `makeReqId`) and `import { BOOTSTRAP_TEMPLATE } from '@ax/agent-identity-templates';`.
  - Change `BootstrapBody` to drop `systemPrompt`: `const BootstrapBody = z.object({ displayName: z.string().transform((s) => s.trim()).pipe(z.string().min(1, 'displayName 1-128').max(128, 'displayName 1-128')) });`
  - Change `AgentsCreateInput.input` to make `systemPrompt` optional (drop it from the sent object).
  - In the create call, build `input` WITHOUT `systemPrompt`:
```ts
input: {
  displayName: parsed.displayName,
  allowedTools: [],
  mcpConfigIds: [],
  model: DEFAULT_PERSONAL_AGENT_MODEL,
  visibility: 'personal',
},
```
  - After a successful create, seed BOOTSTRAP.md (best-effort — the agent already exists; never 500 after create):
```ts
const newAgentId = out.agent.id;
// Seed the bootstrap script into the NEW agent's durable workspace. ctx
// carries (userId, agentId) so workspace:apply routes to THIS agent. parent:
// null is the first apply — the git backend lazy-creates `main` (verified
// "first apply creates main" path). Best-effort: the agent is already
// created and the SPA will open a chat; a seed failure is logged, not fatal
// (the runner string-fallback covers the gap until a later apply lands).
try {
  const seedCtx = makeAgentContext({
    reqId: makeReqId(),
    sessionId: 'agent-bootstrap-seed',
    agentId: newAgentId,
    userId: actor.id,
  });
  await bus.call('workspace:apply', seedCtx, {
    changes: [{ path: '.ax/BOOTSTRAP.md', kind: 'put', content: new TextEncoder().encode(BOOTSTRAP_TEMPLATE) }],
    parent: null,
    reason: 'agent-bootstrap-seed',
  });
} catch (err) {
  initCtx.logger.warn('agent_bootstrap_seed_failed', {
    plugin: PLUGIN_NAME,
    agentId: newAgentId,
    err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
  });
}
res.status(201).json({ agent: { agentId: newAgentId, displayName: out.agent.displayName, visibility: out.agent.visibility } });
```
  (Move the existing `res.status(201).json(...)` to AFTER the seed block — keep one 201 response.)

- [ ] **Step 5: Add `workspace:apply` to the channel-web manifest `calls`** in `plugin.ts` (after `'agents:create',`):
```ts
// TASK-140: the bootstrap route seeds .ax/BOOTSTRAP.md into the new agent's
// /permanent via workspace:apply. Hard dep in k8s (channel-web only loads
// there, alongside a workspace backend); the seed is best-effort at runtime.
'workspace:apply',
```

- [ ] **Step 6: Run — PASS.** `pnpm --filter @ax/channel-web test -- routes-agent-bootstrap` and `pnpm --filter @ax/channel-web build`.

- [ ] **Step 7: Commit.**
```bash
git add packages/channel-web/src/server/routes-agent-bootstrap.ts packages/channel-web/src/server/plugin.ts packages/channel-web/src/__tests__/server/routes-agent-bootstrap.test.ts packages/channel-web/package.json packages/channel-web/tsconfig.json
git commit -m "feat(channel-web): bootstrap route creates a bare agent + seeds .ax/BOOTSTRAP.md"
```

## Task 7: SPA first-run — auto-create + open chat (retire the form)

**Files:**
- Create: `packages/channel-web/src/lib/auto-create-agent.ts`, `packages/channel-web/src/components/onboard/FirstRunAutoCreate.tsx`, `packages/channel-web/src/components/__tests__/FirstRunAutoCreate.test.tsx`
- Modify: `packages/channel-web/src/App.tsx`
- Delete: `AgentBootstrap.tsx`, `agent-bootstrap.ts`, and their tests (`AgentBootstrap.test.tsx`, `composeSystemPrompt.test.ts`, `agent-bootstrap-client.test.ts`); review `AgentBootstrapGate.test.tsx`

- [ ] **Step 1: Create `auto-create-agent.ts`** (the bare-create client; replaces `agent-bootstrap.ts`'s `bootstrapAgent`):
```ts
export interface CreatedAgent {
  agentId: string;
  displayName: string;
  visibility: 'personal' | 'team';
}

/**
 * Create the caller's first personal agent as a BARE agent (no system prompt).
 * The server seeds `.ax/BOOTSTRAP.md`; the new agent wakes up in bootstrap mode
 * and discovers its identity through chat. The SPA picks a friendly default
 * displayName — the agent renames itself during bootstrap by writing
 * `.ax/IDENTITY.md`, so this is just a placeholder until then.
 */
export async function autoCreateBareAgent(displayName = 'New agent'): Promise<CreatedAgent> {
  const res = await fetch('/api/agents/bootstrap', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'ax-admin' },
    body: JSON.stringify({ displayName }),
  });
  if (!res.ok) throw new Error(`auto-create agent: ${res.status}`);
  const body = (await res.json()) as { agent: CreatedAgent };
  return body.agent;
}
```

- [ ] **Step 2: Write the failing test** `FirstRunAutoCreate.test.tsx`:
```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { FirstRunAutoCreate } from '../onboard/FirstRunAutoCreate';
import * as autoCreate from '../../lib/auto-create-agent';
import * as hydrate from '../../lib/hydrate-agents';
import { agentStoreActions } from '../../lib/agent-store';

describe('FirstRunAutoCreate', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('auto-creates a bare agent, selects it, hydrates, and calls onDone', async () => {
    const create = vi.spyOn(autoCreate, 'autoCreateBareAgent').mockResolvedValue({ agentId: 'a9', displayName: 'New agent', visibility: 'personal' });
    const hyd = vi.spyOn(hydrate, 'hydrateAgentsOnce').mockResolvedValue();
    const select = vi.spyOn(agentStoreActions, 'setSelectedAgent');
    const onDone = vi.fn();
    render(<FirstRunAutoCreate onDone={onDone} />);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(select).toHaveBeenCalledWith('a9');
    expect(hyd).toHaveBeenCalled();
  });

  it('creates exactly once even under StrictMode-style double mount', async () => {
    const create = vi.spyOn(autoCreate, 'autoCreateBareAgent').mockResolvedValue({ agentId: 'a9', displayName: 'New agent', visibility: 'personal' });
    vi.spyOn(hydrate, 'hydrateAgentsOnce').mockResolvedValue();
    const { rerender } = render(<FirstRunAutoCreate onDone={vi.fn()} />);
    rerender(<FirstRunAutoCreate onDone={vi.fn()} />);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  });

  it('shows a retry affordance when create fails', async () => {
    vi.spyOn(autoCreate, 'autoCreateBareAgent').mockRejectedValue(new Error('boom'));
    render(<FirstRunAutoCreate onDone={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy());
  });
});
```

- [ ] **Step 3: Run — FAIL** (no component). `pnpm --filter @ax/channel-web test -- FirstRunAutoCreate`.

- [ ] **Step 4: Implement `FirstRunAutoCreate.tsx`** (composes shadcn primitives — Invariant #6; use `SetupShell` like the old component, `Button`, `Alert`):
```tsx
import { useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { SetupShell } from '../setup/SetupShell';
import { autoCreateBareAgent } from '../../lib/auto-create-agent';
import { hydrateAgentsOnce } from '../../lib/hydrate-agents';
import { agentStoreActions } from '../../lib/agent-store';

/**
 * First-run: no form. We create a BARE agent server-side (which seeds
 * `.ax/BOOTSTRAP.md`), select it, hydrate the agent store, and hand control to
 * the chat shell. The new agent wakes up in bootstrap mode and figures out who
 * it is through conversation. A `ran` ref guards React 18 StrictMode's
 * double-invoke so we never create two agents.
 */
export function FirstRunAutoCreate({ onDone }: { onDone: () => void }) {
  const ran = useRef(false);
  const [err, setErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const agent = await autoCreateBareAgent();
        if (cancelled) return;
        agentStoreActions.setSelectedAgent(agent.agentId);
        await hydrateAgentsOnce();
        if (cancelled) return;
        onDone();
      } catch {
        if (!cancelled) setErr("We couldn't set up your agent just now. This one's on us — give it another go.");
      }
    })();
    return () => { cancelled = true; };
    // attempt is in deps so "Try again" re-runs the effect (ran ref is reset below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  if (err !== null) {
    return (
      <SetupShell title="Let's get you started" description="Setting up your first agent.">
        <div className="flex flex-col gap-4">
          <Alert variant="destructive"><AlertDescription>{err}</AlertDescription></Alert>
          <Button
            type="button"
            onClick={() => { ran.current = false; setErr(null); setAttempt((a) => a + 1); }}
          >
            Try again
          </Button>
        </div>
      </SetupShell>
    );
  }

  return (
    <SetupShell title="Setting up your agent…" description="One moment — we're bringing your new agent online.">
      <div className="flex items-center justify-center py-6 text-muted-foreground font-mono text-xs tracking-[0.04em]">
        creating your agent…
      </div>
    </SetupShell>
  );
}
```

- [ ] **Step 5: Run — PASS.** `pnpm --filter @ax/channel-web test -- FirstRunAutoCreate`.

- [ ] **Step 6: Wire into `App.tsx`.** Replace the `import { AgentBootstrap } ...` line with `import { FirstRunAutoCreate } from './components/onboard/FirstRunAutoCreate';`. Replace the gate branch (lines ~211-222). The gate still decides WHETHER to bootstrap; only the rendering changes. The old branch supported a steady-state "+ New agent" (`createAgentOpen`) entry that showed the form with cancel. For first-run (no agents) we auto-create. For the explicit "+ New agent" entry we ALSO auto-create (a bare agent that bootstraps itself) — but it must be cancelable / not loop. Simplest correct behavior: render `FirstRunAutoCreate` whenever the gate is open; on done, close `createAgentOpen`:
```tsx
if (shouldShowAgentBootstrap({ agentsStatus, agentCount: agents.length, createAgentOpen })) {
  return (
    <UserProvider value={user}>
      <FirstRunAutoCreate
        onDone={() => setCreateAgentOpen(false)}
      />
      <ToastStack />
    </UserProvider>
  );
}
```
(The `canCancel`/`onCancel` props are gone — auto-create has no form to cancel. The "+ New agent" path now creates a fresh bootstrapping agent and drops the user straight into its chat, which is the new conversational model.)

- [ ] **Step 7: Delete the retired form + dead client + their tests.**
```bash
git rm packages/channel-web/src/components/onboard/AgentBootstrap.tsx \
       packages/channel-web/src/lib/agent-bootstrap.ts \
       packages/channel-web/src/components/__tests__/AgentBootstrap.test.tsx \
       packages/channel-web/src/components/__tests__/composeSystemPrompt.test.ts \
       packages/channel-web/src/__tests__/agent-bootstrap-client.test.ts
```

- [ ] **Step 8: Handle `AgentBootstrapGate.test.tsx`.** Read it. If it renders `<AgentBootstrap>` (the form), rewrite it to render `<FirstRunAutoCreate>` (mock `autoCreateBareAgent`) OR fold its gate-decision assertions into a pure `shouldShowAgentBootstrap` unit test and `git rm` the component-rendering file. Keep the gate-decision coverage; drop only the form-rendering assertions.

- [ ] **Step 9: Grep for stragglers.** `grep -rn "AgentBootstrap\|composeSystemPrompt\|agent-bootstrap'\|bootstrapAgent\|from './lib/agent-bootstrap'\|onboard/AgentBootstrap" packages/channel-web/src` — fix every remaining import (golden-path.test.tsx may reference them).

- [ ] **Step 10: Run the whole channel-web suite + build.**
```bash
pnpm --filter @ax/channel-web build
pnpm --filter @ax/channel-web test
```
Expected: PASS.

- [ ] **Step 11: Commit.**
```bash
git add -A packages/channel-web/src
git commit -m "feat(channel-web): first-run auto-creates a bare agent and opens chat (retire the bootstrap form)"
```

## Task 8: Whole-branch gate + security note

- [ ] **Step 1: Full build + test + scoped lint.**
```bash
pnpm build
pnpm test
git diff --name-only main...HEAD | grep -E '\.(ts|tsx|mjs)$' | xargs pnpm exec eslint
```
Expected: all green. (Scope lint to changed files per [[feedback_workspace_lint_stale_worktree_noise]].)

- [ ] **Step 2: Security-checklist.** The bootstrap route takes untrusted input (displayName) to create an agent; the seeded `BOOTSTRAP_TEMPLATE` is trusted code. Run the `security-checklist` skill, produce the PR security note. Confirm: displayName is zod length-bounded + passed as DATA; the template is a compile-time constant (no interpolation); `workspace:apply` is policy-filtered (`.ax/**`) by the facade; backfill writes only `.ax/` paths.

- [ ] **Step 3: Update memory + commit.** Append the shipped-summary + learnings to `.claude/memory/` (decisions already logged in Phase 1; add a project note).

## Self-review notes

- **Spec coverage:** bootstrap route bare-create + seed (T6), `agents:create` absent systemPrompt (T3), SPA auto-create + deletions (T7), backfill two files + idempotent (T4/T5), seeding-owner chosen+documented (PR notes + T6), tests for all three (T3/T4/T6/T7). ✔
- **Half-wired window:** Phase 1 left the runner reading `.ax/` with a string fallback. This PR makes new agents seed BOOTSTRAP and backfills existing agents — closing the "no files" gap for the live path. The `system_prompt` column + string fallback stay (Phase 4). State this in PR notes.
- **Boundary review:** no new hook signature; rides `workspace:apply`/`workspace:read`/`agents:create`. `agents:create` LOSES a required field (systemPrompt now optional). New pure-data package on the eslint allow-list. Document in PR.
- **Type consistency:** `autoCreateBareAgent` / `CreatedAgent` (T7); `runIdentityBackfill` / `BackfillAgent` (T4); `backfillIdentityFile` (T1, used in T4). Consistent.
