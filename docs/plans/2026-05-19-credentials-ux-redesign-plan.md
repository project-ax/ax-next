# Credentials UX Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop exposing credential refs and kinds as user-facing form fields. Move all credential creation onto the destination surfaces that need them (provider tab, skill slot row, MCP env/header row, routine HMAC row), with refs computed deterministically and one shadcn `<CredentialSlotForm>` mounted everywhere.

**Architecture:** One new `refs.ts` helper in `@ax/credentials` mints `provider:<provider>`, `skill:<id>:<slot>`, `mcp:<id>:env:<name>`, `mcp:<id>:header:<name>`, `routine:<agentId>:<path>:hmac` refs. Storage layout (`(scope, ownerId, ref, kind, encrypted-payload)`) is unchanged. One new service hook `credentials:purge-by-owner` enables bulk cleanup on owner deletion. Wiring sites all live in `packages/channel-web` and compose two shared components: `<CredentialSlotRow>` (status pill + button) and `<CredentialSlotForm>` (paste-in-sheet). Old admin/settings credential UIs and HTTP routes are removed in the same PR.

**Tech Stack:** TypeScript, Node, pnpm monorepo, vitest, React + shadcn primitives, Kysely (postgres), zod, HookBus.

**Source design:** `docs/plans/2026-05-19-credentials-ux-redesign-design.md`

---

## Files

### New
- `packages/credentials/src/refs.ts` — destination → deterministic ref helper.
- `packages/credentials/src/__tests__/refs.test.ts`
- `packages/credentials/src/__tests__/purge-by-owner.test.ts`
- `packages/credentials/scripts/wipe-pre-redesign.ts`
- `packages/credentials-admin-routes/src/destination-routes.ts` — POST/DELETE `/{admin,settings}/destinations/:destinationKind/credential`.
- `packages/credentials-admin-routes/src/__tests__/destination-handlers.test.ts`
- `packages/channel-web/src/components/credentials/CredentialSlotForm.tsx`
- `packages/channel-web/src/components/credentials/CredentialSlotRow.tsx`
- `packages/channel-web/src/components/credentials/__tests__/CredentialSlotForm.test.tsx`
- `packages/channel-web/src/components/credentials/__tests__/CredentialSlotRow.test.tsx`
- `packages/channel-web/src/components/admin/ProvidersPanel.tsx`
- `packages/channel-web/src/components/admin/__tests__/ProvidersPanel.test.tsx`

### Modified
- `packages/credentials/src/plugin.ts` — relax `REF_RE` to permit `:`; register `credentials:purge-by-owner`; run wipe-once-on-first-boot.
- `packages/credentials-store-db/src/plugin.ts` — relax `REF_RE`; add `credentials:store-blob:purge-by-owner` backed by `storage:delete-prefix`.
- `packages/credentials-admin-routes/src/admin-routes.ts` — relax `REF_RE` (still used by remaining /admin/credentials list route during deprecation window).
- `packages/credentials-admin-routes/src/providers-routes.ts` — provider ref renames `anthropic-api` → `provider:anthropic`.
- `packages/credentials-admin-routes/src/plugin.ts` — mount new destination-routes; remove obsolete settings/oauth routes.
- `packages/chat-orchestrator/src/orchestrator.ts` — default provider ref renames to `provider:anthropic`.
- `packages/chat-orchestrator/src/__tests__/orchestrator.test.ts` — update test fixtures (18+ sites) to the new ref.
- `packages/cli/src/dev-agents-stub.ts` — default agent's `ANTHROPIC_API_KEY` binding renames to `provider:anthropic`.
- `packages/cli/src/main.ts` — update comments referencing the old ref name.
- `packages/onboarding/src/completion-tx.ts` — wizard writes `provider:anthropic` instead of `anthropic-api`.
- `packages/credentials/src/__tests__/plugin.test.ts` + `packages/credentials-store-db/src/__tests__/*.test.ts` — update test ref strings.
- `packages/skills/src/plugin.ts` — `skills:delete` fires `credentials:delete` for every `(scope, ownerId)` carrying `skill:<id>:<slot>`; `skills:upsert` diffs old-vs-new slot set and fires `credentials:delete` for removed slots.
- `packages/mcp-client/src/admin-routes.ts` — config-save diff drops; config-delete purges every declared env+header ref.
- `packages/mcp-client/src/plugin.ts` — add `credentials:delete` to manifest `calls`.
- `packages/routines/src/sync.ts` — workspace-applied "deleted" branch fires `credentials:delete` for the HMAC ref before `store.delete`.
- `packages/routines/src/plugin.ts` — add `credentials:delete` to manifest `calls`.
- `packages/agents/src/plugin.ts` — `deleteAgent` fires `credentials:purge-by-owner({ scope: 'agent', ownerId })` before `store.deleteById`.
- `packages/channel-web/src/components/admin/AdminSidebar.tsx` + `AdminShell.tsx` — rename "Provider keys" tab to "Providers", swap `ProviderKeysTab` for `ProvidersPanel`.
- `packages/channel-web/src/components/admin/SkillAttachmentsSection.tsx` — replace "pick ref" dropdown with `<CredentialSlotRow>` per slot; write deterministic ref into `credentialBindings[slot]` on save.
- `packages/channel-web/src/components/admin/McpServerForm.tsx` — replace `credentialRefs` / `headerCredentialRefs` JSON blob with per-env + per-header `<CredentialSlotRow>` lists; deterministic refs.
- `packages/channel-web/src/components/routines/RoutinesList.tsx` (or `RoutinesPanel.tsx`) — webhook-triggered routines render an HMAC `<CredentialSlotRow>`.
- `packages/channel-web/src/App.tsx` — drop the SettingsPanel-as-credentials wiring.
- `presets/k8s/src/__tests__/acceptance.test.ts` — extend canary: set provider credential via the new ref, set a skill-slot credential, delete the skill, assert credentials store ends empty.

### Deleted (same PR)
- `packages/channel-web/src/components/credentials/ApiKeyForm.tsx`
- `packages/channel-web/src/components/credentials/CredentialAddMenu.tsx`
- `packages/channel-web/src/components/credentials/CredentialsList.tsx`
- `packages/channel-web/src/components/settings/SettingsPanel.tsx`
- `packages/credentials-admin-routes/src/settings-routes.ts` + its tests
- `packages/credentials-admin-routes/src/oauth-routes.ts` + its tests
- The CRUD parts of `packages/credentials-admin-routes/src/admin-routes.ts` (only the `list`/`kinds` paths if anything stays — see Task 22)
- Stale fields from `packages/channel-web/src/lib/credentials.ts` (`adminCredentials.create`, `adminCredentials.delete`, `myCredentials.*`)

---

## Critical pre-flight: REF_RE must allow colons

The existing `REF_RE = /^[a-z0-9][a-z0-9_.-]{0,127}$/` rejects `:`. Every deterministic ref the design specifies (`provider:anthropic`, `skill:<id>:<slot>`, …) contains `:`. So **before** anything else, `REF_RE` is updated in three places (`packages/credentials/src/plugin.ts`, `packages/credentials-store-db/src/plugin.ts`, `packages/credentials-admin-routes/src/admin-routes.ts`) to allow `:` as a separator. Task 1 lands this with tests.

Note: the `credentials:store-blob:list` parser at `credentials-store-db/src/plugin.ts:252` already tolerates `:` in refs (it splits on the first two colons only). No parser change needed.

---

## Task 1: Relax `REF_RE` to permit `:` in three places

**Files:**
- Modify: `packages/credentials/src/plugin.ts:6`
- Modify: `packages/credentials-store-db/src/plugin.ts` (the `REF_RE` near the top of the file)
- Modify: `packages/credentials-admin-routes/src/admin-routes.ts:37`
- Test: `packages/credentials/src/__tests__/scope-validation.test.ts` (extend existing file)

- [ ] **Step 1: Write a failing test that a colon-bearing ref passes validation**

In `packages/credentials/src/__tests__/scope-validation.test.ts`, add:

```ts
it('accepts refs with colons (deterministic destination refs)', async () => {
  const h = await harness();
  // Should not throw.
  await h.bus.call('credentials:set', h.ctx, {
    scope: 'global',
    ownerId: null,
    ref: 'provider:anthropic',
    kind: 'api-key',
    payload: new TextEncoder().encode('sk-test'),
  });
  await h.bus.call('credentials:set', h.ctx, {
    scope: 'agent',
    ownerId: 'agt-1',
    ref: 'skill:linear-tracker:LINEAR_TOKEN',
    kind: 'api-key',
    payload: new TextEncoder().encode('linear-token'),
  });
});

it('still rejects refs containing whitespace or null bytes', async () => {
  const h = await harness();
  await expect(
    h.bus.call('credentials:set', h.ctx, {
      scope: 'global', ownerId: null, ref: 'foo bar',
      kind: 'api-key', payload: new TextEncoder().encode('x'),
    }),
  ).rejects.toThrow(/credential ref must match/);
});
```

The harness import / setup follows the existing pattern in `scope-validation.test.ts`; reuse the local helpers there.

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test --filter @ax/credentials -- scope-validation
```

Expected: the "accepts refs with colons" test fails — `credential ref must match /^[a-z0-9][a-z0-9_.-]{0,127}$/`.

- [ ] **Step 3: Update `REF_RE` in `@ax/credentials`**

In `packages/credentials/src/plugin.ts:6`, change:

```ts
const REF_RE = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
```

to:

```ts
// `:` is the separator for deterministic destination refs
// (provider:anthropic, skill:<id>:<slot>, mcp:<id>:env:<name>, etc.).
// The full ref including separators is one opaque string from the
// store's POV — refs are never parsed back out. See refs.ts.
const REF_RE = /^[a-z0-9][a-z0-9_.:-]{0,191}$/;
```

The length cap goes from 128 to 192 to comfortably fit `skill:<22-char-id>:<32-char-slot>` plus headroom. No production ref hits this; the value is documentation.

- [ ] **Step 4: Update `REF_RE` in `@ax/credentials-store-db`**

In `packages/credentials-store-db/src/plugin.ts`, find the `REF_RE` constant near the top of the file and change it to the same regex from Step 3.

- [ ] **Step 5: Update `REF_RE` in `@ax/credentials-admin-routes`**

In `packages/credentials-admin-routes/src/admin-routes.ts:37`, change the local `REF_RE` to the same value. (This file becomes obsolete in Task 22; for now keep it consistent so any remaining route doesn't 400.)

- [ ] **Step 6: Run the tests to verify they pass**

```bash
pnpm test --filter @ax/credentials
pnpm test --filter @ax/credentials-store-db
pnpm test --filter @ax/credentials-admin-routes
```

Expected: all pass, including the new "accepts refs with colons" test.

- [ ] **Step 7: Commit**

```bash
git add packages/credentials/src/plugin.ts \
        packages/credentials/src/__tests__/scope-validation.test.ts \
        packages/credentials-store-db/src/plugin.ts \
        packages/credentials-admin-routes/src/admin-routes.ts
git commit -m "feat(credentials): allow ':' in credential refs for destination-first refs"
```

---

## Task 2: Add `refs.ts` — deterministic ref helper

**Files:**
- Create: `packages/credentials/src/refs.ts`
- Create: `packages/credentials/src/__tests__/refs.test.ts`
- Modify: `packages/credentials/src/index.ts` (re-export)

- [ ] **Step 1: Write the failing tests**

Create `packages/credentials/src/__tests__/refs.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { refForDestination, type Destination } from '../refs.js';
import { PluginError } from '@ax/core';

describe('refForDestination', () => {
  it('computes provider ref', () => {
    expect(refForDestination({ kind: 'provider', provider: 'anthropic' }))
      .toBe('provider:anthropic');
  });
  it('computes skill-slot ref', () => {
    expect(refForDestination({
      kind: 'skill-slot', skillId: 'linear-tracker', slot: 'LINEAR_TOKEN',
    })).toBe('skill:linear-tracker:LINEAR_TOKEN');
  });
  it('computes mcp-env ref', () => {
    expect(refForDestination({
      kind: 'mcp-env', serverId: 'gh', envName: 'GH_TOKEN',
    })).toBe('mcp:gh:env:GH_TOKEN');
  });
  it('computes mcp-header ref', () => {
    expect(refForDestination({
      kind: 'mcp-header', serverId: 'gh', headerName: 'Authorization',
    })).toBe('mcp:gh:header:Authorization');
  });
  it('computes routine-hmac ref', () => {
    expect(refForDestination({
      kind: 'routine-hmac', agentId: 'agt-1', routinePath: '.ax/routines/cron.md',
    })).toBe('routine:agt-1:.ax/routines/cron.md:hmac');
  });

  it('rejects identifiers containing the reserved char ":"', () => {
    const tries: Destination[] = [
      { kind: 'provider', provider: 'an:thropic' as 'anthropic' },
      { kind: 'skill-slot', skillId: 'a:b', slot: 'SLOT' },
      { kind: 'skill-slot', skillId: 'ok', slot: 'A:B' },
      { kind: 'mcp-env', serverId: 'srv:1', envName: 'X' },
      { kind: 'mcp-env', serverId: 'ok', envName: 'X:Y' },
      { kind: 'mcp-header', serverId: 'srv:1', headerName: 'X' },
      { kind: 'mcp-header', serverId: 'ok', headerName: 'X:Y' },
      { kind: 'routine-hmac', agentId: 'a:b', routinePath: '.ax/r.md' },
      { kind: 'routine-hmac', agentId: 'ok', routinePath: 'has:colon' },
    ];
    for (const d of tries) {
      expect(() => refForDestination(d)).toThrow(PluginError);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test --filter @ax/credentials -- refs
```

Expected: FAIL with "Cannot find module './refs.js'".

- [ ] **Step 3: Implement `refs.ts`**

Create `packages/credentials/src/refs.ts`:

```ts
import { PluginError } from '@ax/core';

const PLUGIN_NAME = '@ax/credentials';

export type Destination =
  | { kind: 'provider'; provider: 'anthropic' }
  | { kind: 'skill-slot'; skillId: string; slot: string }
  | { kind: 'mcp-env'; serverId: string; envName: string }
  | { kind: 'mcp-header'; serverId: string; headerName: string }
  | { kind: 'routine-hmac'; agentId: string; routinePath: string };

function assertNoColon(field: string, value: string): void {
  if (value.includes(':')) {
    throw new PluginError({
      code: 'invalid-destination-identifier',
      plugin: PLUGIN_NAME,
      message: `${field} must not contain ':' (reserved as ref separator)`,
    });
  }
}

export function refForDestination(dest: Destination): string {
  switch (dest.kind) {
    case 'provider':
      assertNoColon('provider', dest.provider);
      return `provider:${dest.provider}`;
    case 'skill-slot':
      assertNoColon('skillId', dest.skillId);
      assertNoColon('slot', dest.slot);
      return `skill:${dest.skillId}:${dest.slot}`;
    case 'mcp-env':
      assertNoColon('serverId', dest.serverId);
      assertNoColon('envName', dest.envName);
      return `mcp:${dest.serverId}:env:${dest.envName}`;
    case 'mcp-header':
      assertNoColon('serverId', dest.serverId);
      assertNoColon('headerName', dest.headerName);
      return `mcp:${dest.serverId}:header:${dest.headerName}`;
    case 'routine-hmac':
      assertNoColon('agentId', dest.agentId);
      assertNoColon('routinePath', dest.routinePath);
      return `routine:${dest.agentId}:${dest.routinePath}:hmac`;
  }
}
```

- [ ] **Step 4: Re-export from the package index**

In `packages/credentials/src/index.ts`, add:

```ts
export { refForDestination, type Destination } from './refs.js';
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm test --filter @ax/credentials -- refs
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/credentials/src/refs.ts \
        packages/credentials/src/__tests__/refs.test.ts \
        packages/credentials/src/index.ts
git commit -m "feat(credentials): add refForDestination — deterministic destination → ref helper"
```

---

## Task 3: Add `credentials:store-blob:purge-by-owner` to `@ax/credentials-store-db`

The bulk purge has to know the storage key shape, so it lives in the store plugin (not the facade). The facade `credentials:purge-by-owner` (next task) calls into it.

**Files:**
- Modify: `packages/credentials-store-db/src/plugin.ts` — register new service hook.
- Create: `packages/credentials-store-db/src/__tests__/purge-by-owner.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/credentials-store-db/src/__tests__/purge-by-owner.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
// Reuse the in-memory harness from plugin.test.ts — extract or import similarly.
import { setupHarness } from './harness.js'; // create if needed; see existing tests

describe('credentials:store-blob:purge-by-owner', () => {
  it('deletes every blob under (scope, ownerId) and returns the count', async () => {
    const h = await setupHarness();
    // Seed 3 agent-scope rows for agt-X, 1 row for agt-Y, 1 global row.
    for (const ref of ['a', 'b', 'c']) {
      await h.bus.call('credentials:store-blob:put', h.ctx, {
        scope: 'agent', ownerId: 'agt-X', ref, blob: new Uint8Array([1]),
      });
    }
    await h.bus.call('credentials:store-blob:put', h.ctx, {
      scope: 'agent', ownerId: 'agt-Y', ref: 'a', blob: new Uint8Array([1]),
    });
    await h.bus.call('credentials:store-blob:put', h.ctx, {
      scope: 'global', ownerId: null, ref: 'g', blob: new Uint8Array([1]),
    });

    const out = await h.bus.call<
      { scope: 'agent'; ownerId: string },
      { deleted: number }
    >('credentials:store-blob:purge-by-owner', h.ctx, {
      scope: 'agent', ownerId: 'agt-X',
    });
    expect(out.deleted).toBe(3);

    // Other rows survive.
    const list = await h.bus.call('credentials:store-blob:list', h.ctx, {});
    const refs = list.entries.map((e) => `${e.scope}:${e.ownerId}:${e.ref}`);
    expect(refs.sort()).toEqual(['agent:agt-Y:a', 'global:null:g'].sort());
  });

  it('rejects scope=global', async () => {
    const h = await setupHarness();
    await expect(
      h.bus.call('credentials:store-blob:purge-by-owner', h.ctx, {
        scope: 'global', ownerId: null,
      }),
    ).rejects.toThrow(/global/);
  });

  it('returns deleted=0 when no rows match', async () => {
    const h = await setupHarness();
    const out = await h.bus.call('credentials:store-blob:purge-by-owner', h.ctx, {
      scope: 'agent', ownerId: 'never-seeded',
    });
    expect(out.deleted).toBe(0);
  });
});
```

If a harness module doesn't yet exist, factor the existing test setup in `packages/credentials-store-db/src/__tests__/plugin.test.ts` into a tiny `harness.ts` export (top of test file → its own file). Keep the change minimal.

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test --filter @ax/credentials-store-db -- purge-by-owner
```

Expected: FAIL — service hook not registered.

- [ ] **Step 3: Register the service hook**

In `packages/credentials-store-db/src/plugin.ts`, alongside the other `bus.registerService` calls inside `init()`, add:

```ts
bus.registerService<
  { scope: 'user' | 'agent'; ownerId: string },
  { deleted: number }
>(
  'credentials:store-blob:purge-by-owner',
  PLUGIN_NAME,
  async (ctx, input) => {
    const scope = validateScope(input.scope);
    if (scope === 'global') {
      throw new PluginError({
        code: 'purge-global-forbidden',
        plugin: PLUGIN_NAME,
        message: "credentials:purge-by-owner refuses scope='global'",
      });
    }
    const ownerId = validateOwnerId(scope, input.ownerId);
    if (ownerId === null) {
      // validateOwnerId would have thrown, but TS narrowing aid.
      throw new PluginError({
        code: 'invalid-payload',
        plugin: PLUGIN_NAME,
        message: 'ownerId is required',
      });
    }
    const prefix = `${KEY_PREFIX_V2}${scope}:${ownerId}:`;
    const out = await bus.call<
      { prefix: string },
      { deleted: number }
    >('storage:delete-prefix', ctx, { prefix });
    return { deleted: out.deleted };
  },
);
```

Add `'credentials:store-blob:purge-by-owner'` to the `registers:` list in the manifest at the top of the file.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm test --filter @ax/credentials-store-db
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/credentials-store-db/src/plugin.ts \
        packages/credentials-store-db/src/__tests__/purge-by-owner.test.ts \
        packages/credentials-store-db/src/__tests__/harness.ts
git commit -m "feat(credentials-store-db): add store-blob:purge-by-owner service hook"
```

---

## Task 4: Add `credentials:purge-by-owner` facade hook

**Files:**
- Modify: `packages/credentials/src/plugin.ts` — register `credentials:purge-by-owner`, declare the new `calls:` entry.
- Create: `packages/credentials/src/__tests__/purge-by-owner.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/credentials/src/__tests__/purge-by-owner.test.ts` — mirror the store-db test shape but exercise the facade-level call, asserting that `credentials:list` after purge returns no entries for `(scope, ownerId)`:

```ts
import { describe, expect, it } from 'vitest';
import { harness } from './harness.js'; // reuse existing pattern

describe('credentials:purge-by-owner', () => {
  it('bulk-deletes all credentials for (scope=agent, ownerId)', async () => {
    const h = await harness();
    const seed = async (ref: string) =>
      h.bus.call('credentials:set', h.ctx, {
        scope: 'agent', ownerId: 'agt-X', ref, kind: 'api-key',
        payload: new TextEncoder().encode('x'),
      });
    await seed('skill:s1:A');
    await seed('skill:s2:B');
    await h.bus.call('credentials:set', h.ctx, {
      scope: 'agent', ownerId: 'agt-Y', ref: 'skill:s1:A', kind: 'api-key',
      payload: new TextEncoder().encode('keep'),
    });

    const out = await h.bus.call<
      { scope: 'agent'; ownerId: string },
      { deleted: number }
    >('credentials:purge-by-owner', h.ctx, {
      scope: 'agent', ownerId: 'agt-X',
    });
    expect(out.deleted).toBe(2);

    const list = await h.bus.call('credentials:list', h.ctx, {
      scope: 'agent', ownerId: 'agt-X',
    });
    expect(list.credentials).toEqual([]);
  });

  it('rejects scope=global', async () => {
    const h = await harness();
    await expect(
      h.bus.call('credentials:purge-by-owner', h.ctx, {
        scope: 'global', ownerId: null,
      }),
    ).rejects.toThrow(/global/);
  });

  it('returns deleted=0 when nothing matches', async () => {
    const h = await harness();
    const out = await h.bus.call('credentials:purge-by-owner', h.ctx, {
      scope: 'user', ownerId: 'never',
    });
    expect(out.deleted).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test --filter @ax/credentials -- purge-by-owner
```

Expected: FAIL — service hook not registered.

- [ ] **Step 3: Register the facade hook**

In `packages/credentials/src/plugin.ts`, add to the public type surface (next to the other `Credentials*Input/Output` types):

```ts
export type CredentialsPurgeByOwnerInput =
  | { scope: 'user'; ownerId: string }
  | { scope: 'agent'; ownerId: string };
export interface CredentialsPurgeByOwnerOutput {
  deleted: number;
}
```

Inside `init({ bus })`, register the service:

```ts
bus.registerService<CredentialsPurgeByOwnerInput, CredentialsPurgeByOwnerOutput>(
  'credentials:purge-by-owner',
  PLUGIN_NAME,
  async (ctx, input) => {
    return bus.call<CredentialsPurgeByOwnerInput, CredentialsPurgeByOwnerOutput>(
      'credentials:store-blob:purge-by-owner', ctx, input,
    );
  },
);
```

Add to the manifest:
- `registers:` += `'credentials:purge-by-owner'`
- `calls:` += `'credentials:store-blob:purge-by-owner'`

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm test --filter @ax/credentials
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/credentials/src/plugin.ts \
        packages/credentials/src/__tests__/purge-by-owner.test.ts
git commit -m "feat(credentials): add purge-by-owner facade hook for actor-delete cleanup"
```

---

## Task 5: Rename provider ref `anthropic-api` → `provider:anthropic`

**Files:**
- Modify: `packages/chat-orchestrator/src/orchestrator.ts:830` (and the comment at line 772).
- Modify: `packages/chat-orchestrator/src/__tests__/orchestrator.test.ts` (18+ ref string sites).
- Modify: `packages/credentials-admin-routes/src/providers-routes.ts:52` (`ref: 'anthropic-api'` → `'provider:anthropic'`).
- Modify: `packages/cli/src/dev-agents-stub.ts:107` (`ref: 'anthropic-api'` → `'provider:anthropic'`).
- Modify: `packages/cli/src/main.ts:89,341` (comment strings only).
- Modify: `packages/onboarding/src/completion-tx.ts:96` (`ref: 'anthropic-api'` → `'provider:anthropic'`).
- Modify: `packages/credentials/src/__tests__/plugin.test.ts:112,125,135,154,164,171,192,202,209,215` (envFallback test ref).
- Modify: `packages/credentials-store-db/src/__tests__/plugin.test.ts:291,297` (`ref: 'anthropic-api'`).
- Leave `memory-strata/src/sensitive-gate.ts` alone — those refs are pattern names for the canary scanner, not credential refs.
- Leave `credentials-store-db/src/__tests__/v2-keys.test.ts` and `scope-set-delete.test.ts` alone — those reference `anthropic-api-key` (different string).

- [ ] **Step 1: Find every site to change**

```bash
grep -rn "'anthropic-api'\|\"anthropic-api\"" packages \
  | grep -v dist | grep -v node_modules
```

Cross-reference the list against the files above. (`anthropic-api-key` — with the trailing `-key` — is a different ref used by some legacy tests; leave it.)

- [ ] **Step 2: Update `chat-orchestrator/src/orchestrator.ts`**

At line 830, change:

```ts
? { ANTHROPIC_API_KEY: { ref: 'anthropic-api', kind: 'api-key' } }
```

to:

```ts
? { ANTHROPIC_API_KEY: { ref: 'provider:anthropic', kind: 'api-key' } }
```

Update the comment at line 772 to say `'provider:anthropic'` instead of `'anthropic-api'`.

- [ ] **Step 3: Update every orchestrator test fixture**

In `packages/chat-orchestrator/src/__tests__/orchestrator.test.ts`, do a file-scoped replace from `ref: 'anthropic-api'` to `ref: 'provider:anthropic'` (18+ occurrences from the grep at line 759, 820, 1315, 1627, 1662, 1691, 1736, 1784, 1838, 1906, 1957, 1999, 2046, 2112, 2164, 2204, 2241, 2286, …).

- [ ] **Step 4: Update the other call sites**

In each of the files in the Files list above, replace the literal `'anthropic-api'` with `'provider:anthropic'`. Where the string appears in a comment, update the comment too — staleness is a source of bugs.

- [ ] **Step 5: Run all affected package tests**

```bash
pnpm test --filter @ax/chat-orchestrator \
          --filter @ax/credentials \
          --filter @ax/credentials-store-db \
          --filter @ax/credentials-admin-routes \
          --filter @ax/cli \
          --filter @ax/onboarding
```

Expected: every test passes.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: rename provider credential ref 'anthropic-api' → 'provider:anthropic'"
```

---

## Task 6: Wipe-once-on-first-boot script

The wipe runs the first time a server boots on the redesigned codebase, then never again. Implementation: a marker storage key (`credentials:redesign-2026-05-19:wiped`); if absent, `storage:delete-prefix` on `'credential:'`, then set the marker. Lives in `@ax/credentials` `init()` to keep the wipe co-located with the plugin that owns the data.

**Files:**
- Create: `packages/credentials/scripts/wipe-pre-redesign.ts` — the standalone script (so an operator can re-run if needed).
- Modify: `packages/credentials/src/plugin.ts` — `init()` calls the wipe-once routine, gated on the marker.
- Create: `packages/credentials/src/__tests__/wipe-pre-redesign.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/credentials/src/__tests__/wipe-pre-redesign.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { harness } from './harness.js';

describe('credentials wipe-once on first boot', () => {
  it('drops all pre-existing credential rows the first time a server boots', async () => {
    const h = await harness({ skipFirstBootWipe: true }); // hypothetical knob; see step 3
    // Seed one row directly (representing pre-redesign data).
    await h.bus.call('credentials:set', h.ctx, {
      scope: 'global', ownerId: null, ref: 'old-ref',
      kind: 'api-key', payload: new TextEncoder().encode('legacy'),
    });
    expect((await h.bus.call('credentials:list', h.ctx, {})).credentials.length).toBe(1);

    // Boot a fresh harness that runs the first-boot wipe.
    const h2 = await harness({ reuseStorage: h.storage });
    expect((await h2.bus.call('credentials:list', h2.ctx, {})).credentials.length).toBe(0);
  });

  it('does not re-wipe on subsequent boots', async () => {
    const h = await harness();
    // Boot 1 — wipe runs, marker set.
    // Now seed a real credential after boot.
    await h.bus.call('credentials:set', h.ctx, {
      scope: 'global', ownerId: null, ref: 'provider:anthropic',
      kind: 'api-key', payload: new TextEncoder().encode('keep-me'),
    });
    // Boot 2 — wipe skipped, credential survives.
    const h2 = await harness({ reuseStorage: h.storage });
    expect((await h2.bus.call('credentials:list', h2.ctx, {})).credentials.length).toBe(1);
  });
});
```

If the existing harness doesn't support multi-boot / storage reuse, extend it minimally (the in-memory storage backend can be shared by reference across two boots).

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test --filter @ax/credentials -- wipe-pre-redesign
```

Expected: FAIL — wipe not implemented.

- [ ] **Step 3: Implement the wipe-once routine**

Create `packages/credentials/scripts/wipe-pre-redesign.ts`:

```ts
import type { AgentContext, HookBus } from '@ax/core';

const MARKER_KEY = 'credentials:redesign-2026-05-19:wiped';
const CREDENTIAL_PREFIX = 'credential:'; // strict superset of v1 + v2

/**
 * One-shot wipe of pre-redesign credential rows. Idempotent via a marker
 * key in `storage:set`. Safe to re-run; the second invocation reads the
 * marker and skips the delete.
 *
 * Pre-MVP / kind-dev only — see design §5.
 */
export async function wipePreRedesignCredentials(
  bus: HookBus,
  ctx: AgentContext,
): Promise<{ wiped: boolean; deleted: number }> {
  const marker = await bus.call<{ key: string }, { value: Uint8Array | undefined }>(
    'storage:get', ctx, { key: MARKER_KEY },
  );
  if (marker.value !== undefined && marker.value.length > 0) {
    return { wiped: false, deleted: 0 };
  }
  const { deleted } = await bus.call<
    { prefix: string },
    { deleted: number }
  >('storage:delete-prefix', ctx, { prefix: CREDENTIAL_PREFIX });
  await bus.call('storage:set', ctx, {
    key: MARKER_KEY,
    value: new TextEncoder().encode(new Date().toISOString()),
  });
  return { wiped: true, deleted };
}
```

In `packages/credentials/src/plugin.ts`, near the end of `init({ bus })` (after the `init` ctx is built but before `bus.registerService` calls? — actually: AFTER all services are registered, BEFORE we return, so the wipe can use the registered facade if we want, though here it goes through `storage:*` directly so order doesn't matter):

```ts
import { wipePreRedesignCredentials } from '../scripts/wipe-pre-redesign.js';
// …
// Run the one-shot pre-redesign wipe. No-op on second boot.
const wipeCtx = makeAgentContext({
  sessionId: 'credentials-wipe', agentId: PLUGIN_NAME, userId: 'system',
});
await wipePreRedesignCredentials(bus, wipeCtx);
```

(`makeAgentContext` is in `@ax/core`. If it isn't already imported in this file, add it.)

The plugin's manifest `calls:` already includes `credentials:store-blob:*`; add `'storage:delete-prefix'` and `'storage:get'`/`'storage:set'` if not already declared. (The store-blob plugin owns those, and `@ax/credentials` doesn't call them today, so declaring them is new.)

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm test --filter @ax/credentials -- wipe-pre-redesign
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/credentials/scripts/wipe-pre-redesign.ts \
        packages/credentials/src/plugin.ts \
        packages/credentials/src/__tests__/wipe-pre-redesign.test.ts
git commit -m "feat(credentials): one-shot pre-redesign wipe gated on storage-marker"
```

---

## Task 7: `<CredentialSlotForm>` — paste form, base64 on send

**Files:**
- Create: `packages/channel-web/src/components/credentials/CredentialSlotForm.tsx`
- Create: `packages/channel-web/src/components/credentials/__tests__/CredentialSlotForm.test.tsx`
- Modify: `packages/channel-web/src/lib/credentials.ts` — add `setDestinationCredential(...)` and `clearDestinationCredential(...)` (the two new HTTP route wrappers); these post to `/admin/destinations/...` or `/settings/destinations/...` per `scope`.

- [ ] **Step 1: Write the failing test for the component**

Create `packages/channel-web/src/components/credentials/__tests__/CredentialSlotForm.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CredentialSlotForm } from '../CredentialSlotForm';

describe('CredentialSlotForm', () => {
  it('POSTs base64-encoded payload to the right route for skill-slot', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    const onSaved = vi.fn();
    render(
      <CredentialSlotForm
        destination={{ kind: 'skill-slot', skillId: 'linear-tracker', slot: 'LINEAR_TOKEN' }}
        slot={{ label: 'LINEAR_TOKEN', kind: 'api-key' }}
        scope={{ scope: 'agent', ownerId: 'agt-1' }}
        current={{ set: false }}
        onSaved={onSaved}
        onCleared={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: 'sk-test-123' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      '/admin/destinations/skill-slot/credential',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining(
          // base64('sk-test-123') === 'c2stdGVzdC0xMjM='
          '"payloadB64":"c2stdGVzdC0xMjM="',
        ),
      }),
    );
  });

  it('routes user-scope to /settings/destinations/...', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    render(
      <CredentialSlotForm
        destination={{ kind: 'provider', provider: 'anthropic' }}
        slot={{ label: 'ANTHROPIC_API_KEY', kind: 'api-key' }}
        scope={{ scope: 'user', ownerId: 'alice' }}
        current={{ set: false }}
        onSaved={() => {}}
        onCleared={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe('/settings/destinations/provider/credential');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test --filter @ax/channel-web -- CredentialSlotForm
```

Expected: FAIL — component not implemented.

- [ ] **Step 3: Implement the component**

Create `packages/channel-web/src/components/credentials/CredentialSlotForm.tsx`:

```tsx
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import type { Destination } from '@ax/credentials';
import { setDestinationCredential } from '@/lib/credentials';

export interface CredentialSlotFormProps {
  destination: Destination;
  slot: { label: string; kind: 'api-key'; description?: string };
  scope: { scope: 'global' | 'user' | 'agent'; ownerId: string | null };
  current: { set: boolean; rotatedAt?: string };
  onSaved: () => void;
  onCleared: () => void;
}

export function CredentialSlotForm({
  destination, slot, scope, current, onSaved,
}: CredentialSlotFormProps) {
  const [payload, setPayload] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || payload.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await setDestinationCredential({ destination, slot, scope, payload });
      setPayload('');
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={(e) => void submit(e)}>
      {slot.description && (
        <p className="text-xs text-muted-foreground">{slot.description}</p>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-1.5">
        <Label htmlFor="cred-payload">
          {current.set ? 'Replace ' : ''}API key
        </Label>
        <Input
          id="cred-payload"
          type="password"
          autoComplete="off"
          value={payload}
          onChange={(e) => setPayload(e.target.value)}
          required
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="submit" disabled={busy || payload.length === 0}>
          {busy ? 'Saving…' : current.set ? 'Replace' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
```

In `packages/channel-web/src/lib/credentials.ts`, add:

```ts
import type { Destination } from '@ax/credentials';

export async function setDestinationCredential(args: {
  destination: Destination;
  slot: { kind: 'api-key' };
  scope: { scope: 'global' | 'user' | 'agent'; ownerId: string | null };
  payload: string;
}): Promise<void> {
  const base = args.scope.scope === 'user' ? '/settings' : '/admin';
  const url = `${base}/destinations/${args.destination.kind}/credential`;
  const body = {
    destination: args.destination,
    scope: args.scope.scope,
    ownerId: args.scope.ownerId,
    kind: args.slot.kind,
    payloadB64: btoa(args.payload),
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
}

export async function clearDestinationCredential(args: {
  destination: Destination;
  scope: { scope: 'global' | 'user' | 'agent'; ownerId: string | null };
}): Promise<void> {
  const base = args.scope.scope === 'user' ? '/settings' : '/admin';
  const url = `${base}/destinations/${args.destination.kind}/credential`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      destination: args.destination,
      scope: args.scope.scope,
      ownerId: args.scope.ownerId,
    }),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm test --filter @ax/channel-web -- CredentialSlotForm
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/components/credentials/CredentialSlotForm.tsx \
        packages/channel-web/src/components/credentials/__tests__/CredentialSlotForm.test.tsx \
        packages/channel-web/src/lib/credentials.ts
git commit -m "feat(channel-web): add <CredentialSlotForm> + setDestinationCredential client"
```

---

## Task 8: `<CredentialSlotRow>` — status pill + sheet trigger

**Files:**
- Create: `packages/channel-web/src/components/credentials/CredentialSlotRow.tsx`
- Create: `packages/channel-web/src/components/credentials/__tests__/CredentialSlotRow.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `packages/channel-web/src/components/credentials/__tests__/CredentialSlotRow.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CredentialSlotRow } from '../CredentialSlotRow';

describe('CredentialSlotRow', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/credentials')) {
        // The row uses credentials:list (via /admin/credentials list route)
        // filtered to ref=skill:linear-tracker:LINEAR_TOKEN.
        return new Response(JSON.stringify({ credentials: [] }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    });
  });

  it('renders the slot label and "Set credential" when not set', async () => {
    render(
      <CredentialSlotRow
        destination={{ kind: 'skill-slot', skillId: 'linear-tracker', slot: 'LINEAR_TOKEN' }}
        slot={{ label: 'LINEAR_TOKEN', kind: 'api-key' }}
        scope={{ scope: 'agent', ownerId: 'agt-1' }}
      />,
    );
    expect(await screen.findByText('LINEAR_TOKEN')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /set credential/i })).toBeInTheDocument();
  });

  it('opens the sheet on click', async () => {
    render(
      <CredentialSlotRow
        destination={{ kind: 'skill-slot', skillId: 'linear-tracker', slot: 'LINEAR_TOKEN' }}
        slot={{ label: 'LINEAR_TOKEN', kind: 'api-key' }}
        scope={{ scope: 'agent', ownerId: 'agt-1' }}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /set credential/i }));
    await waitFor(() =>
      expect(screen.getByRole('dialog')).toBeInTheDocument(),
    );
    expect(screen.getByText(/LINEAR_TOKEN/)).toBeInTheDocument();
  });
});
```

(If the project's shadcn `Sheet` renders something other than `role="dialog"`, replace the assertion with the actual semantics.)

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test --filter @ax/channel-web -- CredentialSlotRow
```

Expected: FAIL — component not implemented.

- [ ] **Step 3: Implement the component**

Create `packages/channel-web/src/components/credentials/CredentialSlotRow.tsx`:

```tsx
import { useEffect, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { refForDestination, type Destination } from '@ax/credentials';
import { CredentialSlotForm } from './CredentialSlotForm';
import { adminCredentials, myCredentials } from '@/lib/credentials';

export interface CredentialSlotRowProps {
  destination: Destination;
  slot: { label: string; kind: 'api-key'; description?: string };
  scope: { scope: 'global' | 'user' | 'agent'; ownerId: string | null };
}

export function CredentialSlotRow({ destination, slot, scope }: CredentialSlotRowProps) {
  const ref = refForDestination(destination);
  const [open, setOpen] = useState(false);
  const [isSet, setIsSet] = useState(false);

  const refresh = useCallback(async () => {
    const list = scope.scope === 'user'
      ? await myCredentials.list()
      : await adminCredentials.list({ scope: scope.scope, ownerId: scope.ownerId });
    setIsSet(list.some((c) => c.ref === ref
      && c.scope === scope.scope
      && c.ownerId === scope.ownerId));
  }, [ref, scope.scope, scope.ownerId]);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <>
      <div className="flex items-center justify-between gap-3 py-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs">{slot.label}</span>
          <span
            className={`px-2 py-0.5 rounded text-[10px] uppercase tracking-wide ${
              isSet
                ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                : 'bg-muted text-muted-foreground'
            }`}
          >
            {isSet ? 'Set' : 'Not set'}
          </span>
        </div>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          {isSet ? 'Replace' : 'Set credential'}
        </Button>
      </div>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>
              Set credential for {humanDestination(destination)}, slot {slot.label}
            </SheetTitle>
          </SheetHeader>
          <div className="mt-4">
            <CredentialSlotForm
              destination={destination}
              slot={slot}
              scope={scope}
              current={{ set: isSet }}
              onSaved={() => { setOpen(false); void refresh(); }}
              onCleared={() => { setOpen(false); void refresh(); }}
            />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

function humanDestination(d: Destination): string {
  switch (d.kind) {
    case 'provider':     return `provider ${d.provider}`;
    case 'skill-slot':   return `skill ${d.skillId}`;
    case 'mcp-env':      return `MCP server ${d.serverId}`;
    case 'mcp-header':   return `MCP server ${d.serverId}`;
    case 'routine-hmac': return `routine ${d.routinePath}`;
  }
}
```

If the shadcn `Sheet` primitive is not installed in `packages/channel-web`, run:

```bash
pnpm dlx shadcn@latest add sheet -c packages/channel-web
```

This is the only new shadcn primitive needed; everything else (`Button`, `Input`, `Label`, `Alert`) is already in.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm test --filter @ax/channel-web -- CredentialSlotRow
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/components/credentials/CredentialSlotRow.tsx \
        packages/channel-web/src/components/credentials/__tests__/CredentialSlotRow.test.tsx \
        packages/channel-web/src/components/ui/sheet.tsx \
        packages/channel-web/components.json
git commit -m "feat(channel-web): add <CredentialSlotRow> + shadcn Sheet primitive"
```

(`components.json` may pick up no change; include it only if shadcn touched it.)

---

## Task 9: New HTTP routes — `POST/DELETE /{admin,settings}/destinations/:kind/credential`

**Files:**
- Create: `packages/credentials-admin-routes/src/destination-routes.ts`
- Create: `packages/credentials-admin-routes/src/__tests__/destination-handlers.test.ts`
- Modify: `packages/credentials-admin-routes/src/plugin.ts` — mount the new routes.

- [ ] **Step 1: Write the failing test**

Create `packages/credentials-admin-routes/src/__tests__/destination-handlers.test.ts`. Mirror the shape of the existing `admin-handlers.test.ts` — a duck-typed `RouteRequest` / `RouteResponse` + a mock bus that records `credentials:set` calls.

```ts
import { describe, expect, it, vi } from 'vitest';
import { createDestinationHandlers } from '../destination-routes.js';
// Reuse the test helpers in the existing file:
import { mockBus, mockReq, mockRes, withAdminAuth } from './admin-handlers.test-helpers.js';

describe('POST /admin/destinations/:kind/credential', () => {
  it('computes the deterministic ref and calls credentials:set', async () => {
    const setMock = vi.fn().mockResolvedValue(undefined);
    const bus = mockBus({ 'credentials:set': setMock });
    withAdminAuth(bus);
    const h = createDestinationHandlers({ bus });
    const req = mockReq({
      params: { destinationKind: 'skill-slot' },
      body: {
        destination: { kind: 'skill-slot', skillId: 'linear-tracker', slot: 'LINEAR_TOKEN' },
        scope: 'agent', ownerId: 'agt-1', kind: 'api-key',
        payloadB64: 'c2stdGVzdC0xMjM=',
      },
    });
    const res = mockRes();
    await h.create(req, res);
    expect(res.status).toHaveBeenCalledWith(204);
    expect(setMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        scope: 'agent',
        ownerId: 'agt-1',
        ref: 'skill:linear-tracker:LINEAR_TOKEN',
        kind: 'api-key',
        payload: expect.any(Uint8Array),
      }),
    );
  });

  it('rejects mismatched destination.kind vs route param', async () => {
    const bus = mockBus({});
    withAdminAuth(bus);
    const h = createDestinationHandlers({ bus });
    const req = mockReq({
      params: { destinationKind: 'mcp-env' },
      body: {
        destination: { kind: 'skill-slot', skillId: 'x', slot: 'Y' },
        scope: 'global', ownerId: null, kind: 'api-key', payloadB64: 'eA==',
      },
    });
    const res = mockRes();
    await h.create(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('forces scope=user + ownerId=actor.id for settings variant', async () => {
    const setMock = vi.fn().mockResolvedValue(undefined);
    const bus = mockBus({ 'credentials:set': setMock });
    withUserAuth(bus, { userId: 'alice' });
    const h = createDestinationHandlers({ bus });
    const req = mockReq({
      params: { destinationKind: 'provider' },
      // Even if the client tries to specify scope=global, the handler must
      // override.
      body: {
        destination: { kind: 'provider', provider: 'anthropic' },
        scope: 'global', ownerId: null, kind: 'api-key', payloadB64: 'eA==',
      },
    });
    const res = mockRes();
    await h.createSettings(req, res);
    expect(setMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        scope: 'user', ownerId: 'alice', ref: 'provider:anthropic',
      }),
    );
  });
});

describe('DELETE /admin/destinations/:kind/credential', () => {
  it('computes the ref and calls credentials:delete', async () => {
    const delMock = vi.fn().mockResolvedValue(undefined);
    const bus = mockBus({ 'credentials:delete': delMock });
    withAdminAuth(bus);
    const h = createDestinationHandlers({ bus });
    const req = mockReq({
      params: { destinationKind: 'skill-slot' },
      body: {
        destination: { kind: 'skill-slot', skillId: 's', slot: 'T' },
        scope: 'agent', ownerId: 'agt-1',
      },
    });
    const res = mockRes();
    await h.destroy(req, res);
    expect(res.status).toHaveBeenCalledWith(204);
    expect(delMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: 'agent', ownerId: 'agt-1', ref: 'skill:s:T' }),
    );
  });
});
```

If `admin-handlers.test-helpers.js` doesn't yet exist, factor the test setup currently inline in `admin-handlers.test.ts` into that file. Keep edits minimal.

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test --filter @ax/credentials-admin-routes -- destination-handlers
```

Expected: FAIL — `destination-routes.ts` missing.

- [ ] **Step 3: Implement `destination-routes.ts`**

Create `packages/credentials-admin-routes/src/destination-routes.ts`:

```ts
import { makeAgentContext, type AgentContext, type HookBus } from '@ax/core';
import { refForDestination, type Destination } from '@ax/credentials';
import { z } from 'zod';
import {
  parseRequestBody, requireAdmin, requireUser, writeServiceError,
  type RouteRequest, type RouteResponse,
} from './shared.js';

const PLUGIN_NAME = '@ax/credentials-admin-routes/destinations';

const DestinationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('provider'), provider: z.literal('anthropic') }).strict(),
  z.object({ kind: z.literal('skill-slot'),
             skillId: z.string().min(1).max(128),
             slot: z.string().min(1).max(64) }).strict(),
  z.object({ kind: z.literal('mcp-env'),
             serverId: z.string().min(1).max(64),
             envName: z.string().min(1).max(64) }).strict(),
  z.object({ kind: z.literal('mcp-header'),
             serverId: z.string().min(1).max(64),
             headerName: z.string().min(1).max(128) }).strict(),
  z.object({ kind: z.literal('routine-hmac'),
             agentId: z.string().min(1).max(64),
             routinePath: z.string().min(1).max(256) }).strict(),
]);

const CreateBody = z.object({
  destination: DestinationSchema,
  scope: z.enum(['global', 'user', 'agent']),
  ownerId: z.string().min(1).max(128).nullable(),
  kind: z.literal('api-key'),
  payloadB64: z.string().min(1),
}).strict();

const DeleteBody = z.object({
  destination: DestinationSchema,
  scope: z.enum(['global', 'user', 'agent']),
  ownerId: z.string().min(1).max(128).nullable(),
}).strict();

export function createDestinationHandlers(deps: { bus: HookBus }): {
  create:        (req: RouteRequest, res: RouteResponse) => Promise<void>;
  createSettings:(req: RouteRequest, res: RouteResponse) => Promise<void>;
  destroy:       (req: RouteRequest, res: RouteResponse) => Promise<void>;
  destroySettings:(req: RouteRequest, res: RouteResponse) => Promise<void>;
} {
  const ctx = makeAgentContext({
    sessionId: 'credentials-destinations', agentId: PLUGIN_NAME, userId: 'system',
  });

  async function doCreate(req: RouteRequest, res: RouteResponse, forceUser: { userId: string } | null): Promise<void> {
    const body = parseRequestBody(req, res, CreateBody);
    if (body === null) return;
    if (body.destination.kind !== req.params?.destinationKind) {
      res.status(400).json({ error: 'destination.kind does not match route param' });
      return;
    }
    const scope = forceUser !== null ? 'user' as const : body.scope;
    const ownerId = forceUser !== null ? forceUser.userId : body.ownerId;
    let ref: string;
    try { ref = refForDestination(body.destination as Destination); }
    catch (err) { if (writeServiceError(res, err)) return; throw err; }
    try {
      await deps.bus.call('credentials:set', ctx, {
        scope, ownerId, ref, kind: body.kind,
        payload: new Uint8Array(Buffer.from(body.payloadB64, 'base64')),
      });
      res.status(204).end();
    } catch (err) { if (writeServiceError(res, err)) return; throw err; }
  }

  async function doDelete(req: RouteRequest, res: RouteResponse, forceUser: { userId: string } | null): Promise<void> {
    const body = parseRequestBody(req, res, DeleteBody);
    if (body === null) return;
    if (body.destination.kind !== req.params?.destinationKind) {
      res.status(400).json({ error: 'destination.kind does not match route param' });
      return;
    }
    const scope = forceUser !== null ? 'user' as const : body.scope;
    const ownerId = forceUser !== null ? forceUser.userId : body.ownerId;
    let ref: string;
    try { ref = refForDestination(body.destination as Destination); }
    catch (err) { if (writeServiceError(res, err)) return; throw err; }
    try {
      await deps.bus.call('credentials:delete', ctx, { scope, ownerId, ref });
      res.status(204).end();
    } catch (err) { if (writeServiceError(res, err)) return; throw err; }
  }

  return {
    async create(req, res) {
      const actor = await requireAdmin(deps.bus, ctx, req, res);
      if (actor === null) return;
      await doCreate(req, res, null);
    },
    async createSettings(req, res) {
      const actor = await requireUser(deps.bus, ctx, req, res);
      if (actor === null) return;
      await doCreate(req, res, { userId: actor.userId });
    },
    async destroy(req, res) {
      const actor = await requireAdmin(deps.bus, ctx, req, res);
      if (actor === null) return;
      await doDelete(req, res, null);
    },
    async destroySettings(req, res) {
      const actor = await requireUser(deps.bus, ctx, req, res);
      if (actor === null) return;
      await doDelete(req, res, { userId: actor.userId });
    },
  };
}

export async function registerDestinationRoutes(
  bus: HookBus, ctx: AgentContext,
): Promise<Array<() => void>> {
  const h = createDestinationHandlers({ bus });
  const unregisters: Array<() => void> = [];
  for (const [method, path, handler] of [
    ['POST',   '/admin/destinations/:destinationKind/credential',    h.create],
    ['DELETE', '/admin/destinations/:destinationKind/credential',    h.destroy],
    ['POST',   '/settings/destinations/:destinationKind/credential', h.createSettings],
    ['DELETE', '/settings/destinations/:destinationKind/credential', h.destroySettings],
  ] as const) {
    const out = await bus.call<
      { method: 'POST' | 'DELETE'; path: string; handler: unknown },
      { unregister: () => void }
    >('http:register-route', ctx, { method, path, handler });
    unregisters.push(out.unregister);
  }
  return unregisters;
}
```

In `packages/credentials-admin-routes/src/plugin.ts`, mount the new routes inside the existing try/catch unwind:

```ts
unregisterRoutes.push(...(await registerDestinationRoutes(bus, initCtx)));
```

Add to `calls:` if not already present: `'credentials:set'`, `'credentials:delete'`, `'http:register-route'`, `'auth:require-user'`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm test --filter @ax/credentials-admin-routes
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/credentials-admin-routes/src/destination-routes.ts \
        packages/credentials-admin-routes/src/plugin.ts \
        packages/credentials-admin-routes/src/__tests__/destination-handlers.test.ts \
        packages/credentials-admin-routes/src/__tests__/admin-handlers.test-helpers.ts
git commit -m "feat(credentials-admin-routes): destination-first POST/DELETE routes"
```

---

## Task 10: Wiring site 1 — Providers admin tab

**Files:**
- Create: `packages/channel-web/src/components/admin/ProvidersPanel.tsx`
- Create: `packages/channel-web/src/components/admin/__tests__/ProvidersPanel.test.tsx`
- Modify: `packages/channel-web/src/components/admin/AdminSidebar.tsx` — rename label "Provider keys" → "Providers".
- Modify: `packages/channel-web/src/components/admin/AdminShell.tsx` — swap `ProviderKeysTab` for `ProvidersPanel`.
- Modify: `packages/chat-orchestrator/src/index.ts` — export `KNOWN_PROVIDERS`.
- Modify: `packages/chat-orchestrator/src/orchestrator.ts` — define `KNOWN_PROVIDERS`.

- [ ] **Step 1: Write the failing test**

Create `packages/channel-web/src/components/admin/__tests__/ProvidersPanel.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProvidersPanel } from '../ProvidersPanel';

describe('ProvidersPanel', () => {
  it('renders one row per provider in KNOWN_PROVIDERS, with status pill', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ credentials: [] }), { status: 200 }),
    );
    render(<ProvidersPanel />);
    expect(await screen.findByText(/Anthropic/i)).toBeInTheDocument();
    expect(await screen.findAllByRole('button', { name: /set credential/i })).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test --filter @ax/channel-web -- ProvidersPanel
```

Expected: FAIL — component not implemented.

- [ ] **Step 3: Export `KNOWN_PROVIDERS` from chat-orchestrator**

In `packages/chat-orchestrator/src/orchestrator.ts`, add near the top:

```ts
export const KNOWN_PROVIDERS = [
  {
    provider: 'anthropic' as const,
    name: 'Anthropic',
    slot: 'ANTHROPIC_API_KEY' as const,
    description: 'API key from console.anthropic.com.',
  },
] as const;

export type KnownProvider = (typeof KNOWN_PROVIDERS)[number];
```

In `packages/chat-orchestrator/src/index.ts`, re-export:

```ts
export { KNOWN_PROVIDERS, type KnownProvider } from './orchestrator.js';
```

- [ ] **Step 4: Implement `ProvidersPanel`**

Create `packages/channel-web/src/components/admin/ProvidersPanel.tsx`:

```tsx
import { KNOWN_PROVIDERS } from '@ax/chat-orchestrator';
import { CredentialSlotRow } from '../credentials/CredentialSlotRow';

export function ProvidersPanel() {
  return (
    <div className="max-w-[640px] mx-auto font-sans">
      <div className="mb-5">
        <h2 className="text-2xl font-medium tracking-[-0.018em] mb-1.5">Providers</h2>
        <p className="text-sm leading-[1.55] text-muted-foreground max-w-[56ch]">
          Manage the API keys for the model providers wired into this deployment.
          Keys are encrypted at rest and never returned in plaintext.
        </p>
      </div>
      <div className="space-y-3">
        {KNOWN_PROVIDERS.map((p) => (
          <div key={p.provider} className="rounded-md border border-border p-4">
            <div className="font-medium mb-2">{p.name}</div>
            <CredentialSlotRow
              destination={{ kind: 'provider', provider: p.provider }}
              slot={{ label: p.slot, kind: 'api-key', description: p.description }}
              scope={{ scope: 'global', ownerId: null }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Wire into the admin shell**

In `packages/channel-web/src/components/admin/AdminSidebar.tsx`, change:

```ts
{ id: 'provider-keys', label: 'Provider keys', icon: KeyRound },
```

to:

```ts
{ id: 'providers', label: 'Providers', icon: KeyRound },
```

And update the `AdminTabId` union to use `'providers'` instead of `'provider-keys'`. Hunt the file for any other references.

In `packages/channel-web/src/components/admin/AdminShell.tsx`:

```ts
import { ProvidersPanel } from './ProvidersPanel';
// In TAB_META:
'providers': { eyebrow: 'Admin', title: 'Providers' },
// In the render switch:
{activeTab === 'providers' && <ProvidersPanel />}
```

Default initial tab stays as the first nav item — adjust the `useState<AdminTabId>('provider-keys')` initial value to `'providers'`.

- [ ] **Step 6: Add the new package dep**

`@ax/channel-web` imports `KNOWN_PROVIDERS` from `@ax/chat-orchestrator`. Verify the dep is present in `packages/channel-web/package.json` (look for an existing `@ax/chat-orchestrator` line; add if missing) and re-run `pnpm install`.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
pnpm test --filter @ax/channel-web -- ProvidersPanel
pnpm build
```

Expected: tests pass; the workspace `pnpm build` succeeds (no stray references to the removed `provider-keys` tab id).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(channel-web): replace Provider keys tab with destination-first ProvidersPanel"
```

---

## Task 11: Wiring site 2 — Skill attachment editor

**Files:**
- Modify: `packages/channel-web/src/components/admin/SkillAttachmentsSection.tsx` — replace per-slot dropdown with `<CredentialSlotRow>` per slot.
- Modify: `packages/channel-web/src/components/admin/__tests__/SkillAttachmentsSection.test.tsx`

- [ ] **Step 1: Write the failing test**

Update `packages/channel-web/src/components/admin/__tests__/SkillAttachmentsSection.test.tsx` (add a new test, don't delete existing scope/save tests yet):

```tsx
it('renders a CredentialSlotRow per skill slot (not a credential dropdown)', async () => {
  vi.mocked(listSkills).mockResolvedValue([
    {
      id: 'linear-tracker',
      description: 'tracks linear issues',
      version: 1,
      capabilities: {
        allowedHosts: [],
        credentials: [{ slot: 'LINEAR_TOKEN', kind: 'api-key' }],
      },
      defaultAttached: false,
      updatedAt: new Date().toISOString(),
    },
  ]);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ credentials: [] }), { status: 200 }),
  );
  render(
    <SkillAttachmentsSection
      agentId="agt-1"
      initialAttachments={[{ skillId: 'linear-tracker', credentialBindings: {} }]}
    />,
  );
  // The new UI has no "Select credential…" placeholder.
  await waitFor(() => {
    expect(screen.queryByText(/select credential/i)).not.toBeInTheDocument();
  });
  // It does have the slot label as a row.
  expect(screen.getByText('LINEAR_TOKEN')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /set credential/i })).toBeInTheDocument();
});
```

The existing tests that assert dropdown behavior (`SkillAttachmentsSection.test.tsx:98,115,140,154,186,187,217`) need to be rewritten to assert the new shape — the binding is now implicit (always equal to `refForDestination(...)`), so the user-facing UI is the row, and the saved attachment's `credentialBindings[slot]` is checked at save time. Update those tests in this step too.

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test --filter @ax/channel-web -- SkillAttachmentsSection
```

Expected: FAIL — old dropdown still rendering.

- [ ] **Step 3: Replace the dropdown with `<CredentialSlotRow>`**

In `packages/channel-web/src/components/admin/SkillAttachmentsSection.tsx`:

- Remove the `credentials` state + `adminCredentials.list()` fetch.
- Remove the `<Select>` block (lines ~141–183).
- For each `slot` in `skill.capabilities.credentials`, render:

```tsx
<CredentialSlotRow
  destination={{ kind: 'skill-slot', skillId: a.skillId, slot: slot.slot }}
  slot={{ label: slot.slot, kind: slot.kind, description: slot.description }}
  scope={{ scope: 'agent', ownerId: agentId }}
/>
```

- Update the `save()` function so that for every attachment, every declared slot's binding is set to `refForDestination({ kind: 'skill-slot', skillId, slot })`. The agent's `credentialBindings[slot]` becomes a write-only field at this layer.

```ts
function buildBindings(skillId: string, slots: { slot: string }[]): Record<string, string> {
  return Object.fromEntries(
    slots.map((s) => [
      s.slot,
      refForDestination({ kind: 'skill-slot', skillId, slot: s.slot }),
    ]),
  );
}

async function save() {
  setSaving(true); setError(null);
  try {
    const withBindings = attachments.map((a) => {
      const skill = skillById.get(a.skillId);
      return {
        ...a,
        credentialBindings: skill ? buildBindings(a.skillId, skill.capabilities.credentials) : {},
      };
    });
    await patchAgentSkillAttachments(agentId, withBindings);
    onSaved?.(withBindings);
  } catch (err) { /* … */ }
  finally { setSaving(false); }
}
```

- Drop the `Select`-related imports.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm test --filter @ax/channel-web -- SkillAttachmentsSection
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/components/admin/SkillAttachmentsSection.tsx \
        packages/channel-web/src/components/admin/__tests__/SkillAttachmentsSection.test.tsx
git commit -m "feat(channel-web): skill slots use destination-first CredentialSlotRow"
```

---

## Task 12: Wiring site 3 — MCP server config (env + headers)

**Files:**
- Modify: `packages/channel-web/src/components/admin/McpServerForm.tsx`
- Modify or create: `packages/channel-web/src/components/admin/__tests__/McpServerForm.test.tsx`

- [ ] **Step 1: Read the current MCP server form**

```bash
sed -n '1,80p' packages/channel-web/src/components/admin/McpServerForm.tsx
```

Identify how `credentialRefs` and `headerCredentialRefs` are currently surfaced (likely as a JSON blob input or as paired text inputs). This shape is being replaced.

- [ ] **Step 2: Write the failing test**

Add to (or create) `packages/channel-web/src/components/admin/__tests__/McpServerForm.test.tsx`:

```tsx
it('renders one CredentialSlotRow per declared env var', async () => {
  // Seed the form with a server that declares env vars but no credentialRefs.
  render(
    <McpServerForm
      initialConfig={{
        id: 'github',
        enabled: true,
        transport: 'stdio',
        command: 'mcp-github',
        args: [],
        env: { GH_TOKEN: '', GH_HOST: 'api.github.com' },
        ownerId: null,
      }}
    />,
  );
  expect(await screen.findByText('GH_TOKEN')).toBeInTheDocument();
  // GH_HOST is not credential-shaped; render rule is "per env var that's
  // treated as a credential" — by default, every env var.
  expect(screen.getByText('GH_HOST')).toBeInTheDocument();
});

it('renders one CredentialSlotRow per declared header (http transports)', async () => {
  render(
    <McpServerForm
      initialConfig={{
        id: 'gh-http', enabled: true, transport: 'streamable-http',
        url: 'https://example.com',
        headerCredentialRefs: { Authorization: '', 'X-Trace': '' },
        ownerId: null,
      }}
    />,
  );
  expect(await screen.findByText('Authorization')).toBeInTheDocument();
  expect(screen.getByText('X-Trace')).toBeInTheDocument();
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
pnpm test --filter @ax/channel-web -- McpServerForm
```

Expected: FAIL.

- [ ] **Step 4: Replace the credentialRefs/headerCredentialRefs editor**

Render `<CredentialSlotRow>` per env var (for stdio transport) and per header (for streamable-http / sse). The form computes the binding on save:

```ts
function buildEnvBindings(serverId: string, envNames: string[]): Record<string, string> {
  return Object.fromEntries(
    envNames.map((name) => [
      name,
      refForDestination({ kind: 'mcp-env', serverId, envName: name }),
    ]),
  );
}
function buildHeaderBindings(serverId: string, headerNames: string[]): Record<string, string> {
  return Object.fromEntries(
    headerNames.map((name) => [
      name,
      refForDestination({ kind: 'mcp-header', serverId, headerName: name }),
    ]),
  );
}
```

On save, set `config.credentialRefs = buildEnvBindings(id, Object.keys(env))` and `config.headerCredentialRefs = buildHeaderBindings(id, Object.keys(headerNames))`. The user enters the names + the values are credentials managed by the row.

Scope choice for MCP today: global (admin-managed system-wide MCP servers). Pass `scope={{ scope: 'global', ownerId: null }}` to the rows. (Open question §1 in the design — user-scope MCP comes later.)

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm test --filter @ax/channel-web -- McpServerForm
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/channel-web/src/components/admin/McpServerForm.tsx \
        packages/channel-web/src/components/admin/__tests__/McpServerForm.test.tsx
git commit -m "feat(channel-web): MCP server env+headers use destination-first CredentialSlotRow"
```

---

## Task 13: Wiring site 4 — Routine webhook HMAC

**Files:**
- Modify: `packages/channel-web/src/components/routines/RoutinesList.tsx`
- Modify or create: `packages/channel-web/src/components/routines/__tests__/RoutinesList.test.tsx`

Routines today live in workspace markdown files (`.ax/routines/<name>.md`), where the YAML frontmatter declares `trigger.kind=webhook` and `trigger.hmac.secretRef`. We do NOT add an editor for the spec itself. We DO add a per-row HMAC `<CredentialSlotRow>` for any webhook-triggered routine. The row's deterministic ref is `routine:<agentId>:<path>:hmac`.

**Caveat:** the routine's markdown still names a `secretRef`. For this redesign to make sense, the markdown-declared `secretRef` should equal the deterministic ref. A linter-style validation in `@ax/routines` could enforce this — but **out of scope for this PR**. The redesign assumes users write `secretRef: routine:<agentId>:<path>:hmac` in their markdown frontmatter (documented in design §3). We add a tooltip to the row showing the exact string to paste.

- [ ] **Step 1: Write the failing test**

In `packages/channel-web/src/components/routines/__tests__/RoutinesList.test.tsx`, add:

```tsx
it('shows an HMAC CredentialSlotRow for webhook-triggered routines', async () => {
  vi.mocked(listRoutines).mockResolvedValue([
    {
      agentId: 'agt-1',
      path: '.ax/routines/gh-webhook.md',
      trigger: { kind: 'webhook', path: '/gh', events: ['push'],
                 hmac: { secretRef: 'routine:agt-1:.ax/routines/gh-webhook.md:hmac',
                         header: 'X-Hub-Signature-256', algorithm: 'sha256' } },
      // …other RoutineRow fields…
    } as any,
  ]);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ credentials: [] }), { status: 200 }),
  );
  render(<RoutinesList refreshKey={0} onFired={() => {}} />);
  // The label string includes "HMAC" and the row exposes a "Set credential" CTA.
  expect(await screen.findByText(/HMAC/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /set credential/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test --filter @ax/channel-web -- RoutinesList
```

Expected: FAIL.

- [ ] **Step 3: Add the HMAC row for webhook routines**

In `RoutinesList.tsx`, for each routine where `trigger.kind === 'webhook'`, render below the existing row body:

```tsx
<CredentialSlotRow
  destination={{ kind: 'routine-hmac', agentId: row.agentId, routinePath: row.path }}
  slot={{ label: 'HMAC', kind: 'api-key',
          description: `Routine markdown should declare secretRef: ${
            refForDestination({ kind: 'routine-hmac', agentId: row.agentId, routinePath: row.path })
          }` }}
  scope={{ scope: 'agent', ownerId: row.agentId }}
/>
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm test --filter @ax/channel-web -- RoutinesList
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/components/routines/RoutinesList.tsx \
        packages/channel-web/src/components/routines/__tests__/RoutinesList.test.tsx
git commit -m "feat(channel-web): webhook routines expose HMAC CredentialSlotRow"
```

---

## Task 14: Owning-plugin delete — `@ax/skills` fires `credentials:delete` on skill removal

**Files:**
- Modify: `packages/skills/src/plugin.ts` — `skills:delete` enumerates and deletes; `skills:upsert` diffs old/new slot set and deletes removed slots' refs.
- Modify: `packages/skills/src/__tests__/plugin.test.ts`

Note: `skills:delete` currently refuses with `skill-in-use` when any agent has the skill attached. The credentials-delete therefore only ever fires when no agent has the skill attached — i.e. the cleanup is for any leftover *global* and *user*-scope rows for this skill's slots. The agent-scope rows for a detached agent are handled by the agent-delete or skill-detach path.

For manifest-edit-drops-slot, `skills:upsert` compares old and new slot lists; for each removed slot, fire `credentials:delete` across all `(scope, ownerId)` rows that exist for `skill:<id>:<slot>`. Implementation: `credentials:list({ scope: undefined })` then filter by ref locally — small N for v1.

- [ ] **Step 1: Write the failing tests**

In `packages/skills/src/__tests__/plugin.test.ts`, add:

```ts
it('skills:delete fires credentials:delete for every (scope, ownerId) row at skill:<id>:*', async () => {
  const h = await harness();
  // Seed a skill with no agent attachments.
  await h.bus.call('skills:upsert', h.ctx, {
    manifestYaml: yamlForSkill('linear-tracker', [{ slot: 'LINEAR_TOKEN', kind: 'api-key' }]),
    bodyMd: '...',
  });
  // Seed credentials at multiple scopes.
  await h.bus.call('credentials:set', h.ctx, {
    scope: 'global', ownerId: null, ref: 'skill:linear-tracker:LINEAR_TOKEN',
    kind: 'api-key', payload: new TextEncoder().encode('g'),
  });
  await h.bus.call('credentials:set', h.ctx, {
    scope: 'user', ownerId: 'alice', ref: 'skill:linear-tracker:LINEAR_TOKEN',
    kind: 'api-key', payload: new TextEncoder().encode('u'),
  });

  await h.bus.call('skills:delete', h.ctx, { skillId: 'linear-tracker' });

  const list = await h.bus.call('credentials:list', h.ctx, {});
  expect(list.credentials.filter(
    (c: any) => c.ref === 'skill:linear-tracker:LINEAR_TOKEN',
  )).toEqual([]);
});

it('skills:upsert fires credentials:delete for slots dropped in a manifest edit', async () => {
  const h = await harness();
  await h.bus.call('skills:upsert', h.ctx, {
    manifestYaml: yamlForSkill('s1', [
      { slot: 'OLD_SLOT', kind: 'api-key' },
      { slot: 'KEEPER',   kind: 'api-key' },
    ]),
    bodyMd: '',
  });
  await h.bus.call('credentials:set', h.ctx, {
    scope: 'global', ownerId: null, ref: 'skill:s1:OLD_SLOT',
    kind: 'api-key', payload: new TextEncoder().encode('x'),
  });
  await h.bus.call('credentials:set', h.ctx, {
    scope: 'global', ownerId: null, ref: 'skill:s1:KEEPER',
    kind: 'api-key', payload: new TextEncoder().encode('y'),
  });
  // Manifest edit: drop OLD_SLOT.
  await h.bus.call('skills:upsert', h.ctx, {
    manifestYaml: yamlForSkill('s1', [{ slot: 'KEEPER', kind: 'api-key' }]),
    bodyMd: '',
  });
  const list = await h.bus.call('credentials:list', h.ctx, {});
  expect(list.credentials.map((c: any) => c.ref).sort()).toEqual(['skill:s1:KEEPER']);
});
```

`yamlForSkill` is a small fixture helper — write a minimal version next to the test.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm test --filter @ax/skills
```

Expected: the two new tests FAIL.

- [ ] **Step 3: Implement the cleanup logic**

In `packages/skills/src/plugin.ts`:

- Add `'credentials:list'` and `'credentials:delete'` to manifest `calls:`.
- In `skills:upsert`, after `store.upsert(...)`, compute `removedSlots = oldSlots - newSlots`. For each removed slot, `credentials:list({})` filtered by `ref === 'skill:<id>:<slot>'`, then `credentials:delete` per matching `(scope, ownerId)`.
- In `skills:delete`, before `store.delete(input.skillId)` (after the `skill-in-use` check), enumerate every `credentials:list({})` row whose ref starts with `skill:<id>:`, and delete each. (`credentials:list` does not currently filter by ref prefix; reuse the existing list + local filter for v1.)

Sketch:

```ts
async function purgeSkillCredentials(
  bus: HookBus, ctx: AgentContext, skillId: string, slots: string[],
): Promise<void> {
  const refsToDelete = new Set(slots.map((s) => `skill:${skillId}:${s}`));
  const list = await bus.call<Record<string, never>, { credentials: any[] }>(
    'credentials:list', ctx, {},
  );
  for (const c of list.credentials) {
    if (!refsToDelete.has(c.ref)) continue;
    await bus.call('credentials:delete', ctx, {
      scope: c.scope, ownerId: c.ownerId, ref: c.ref,
    });
  }
}
```

Read `oldSlots` from the previous version of the skill (load via `store.get(skillId)` before the upsert) so the diff against the new manifest's slot list is correct.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm test --filter @ax/skills
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/skills/src/plugin.ts \
        packages/skills/src/__tests__/plugin.test.ts
git commit -m "feat(skills): purge per-slot credentials on skill delete / manifest slot removal"
```

---

## Task 15: Owning-plugin delete — `@ax/mcp-client` fires `credentials:delete` on config delete / edit

**Files:**
- Modify: `packages/mcp-client/src/admin-routes.ts` — on `saveConfig`, diff old config (if any) against new + delete refs for dropped env/header names. On `deleteConfig`, delete every declared ref.
- Modify: `packages/mcp-client/src/plugin.ts` — add `credentials:list`, `credentials:delete` to `calls:`.
- Modify: `packages/mcp-client/src/__tests__/admin-routes.test.ts` (or appropriate test file).

- [ ] **Step 1: Write the failing tests**

```ts
it('DELETE /admin/mcp-servers/:id purges every declared env+header credential', async () => {
  // Seed a stdio server with env GH_TOKEN, GH_HOST.
  await saveConfig(bus, ctx, {
    id: 'gh', enabled: true, transport: 'stdio', command: 'mcp-gh', args: [],
    env: { GH_TOKEN: '', GH_HOST: '' }, ownerId: null,
  });
  await bus.call('credentials:set', ctx, {
    scope: 'global', ownerId: null, ref: 'mcp:gh:env:GH_TOKEN', kind: 'api-key',
    payload: new TextEncoder().encode('t'),
  });

  await deleteHandler({ params: { id: 'gh' } } as any, makeRes());
  const list = await bus.call('credentials:list', ctx, {});
  expect(list.credentials.filter((c: any) => c.ref.startsWith('mcp:gh:'))).toEqual([]);
});

it('PUT /admin/mcp-servers/:id deletes credentials for dropped env names', async () => {
  await saveConfig(bus, ctx, {
    id: 'gh', enabled: true, transport: 'stdio', command: 'mcp-gh', args: [],
    env: { GH_TOKEN: '', LEGACY: '' }, ownerId: null,
  });
  await bus.call('credentials:set', ctx, {
    scope: 'global', ownerId: null, ref: 'mcp:gh:env:LEGACY', kind: 'api-key',
    payload: new TextEncoder().encode('x'),
  });
  await bus.call('credentials:set', ctx, {
    scope: 'global', ownerId: null, ref: 'mcp:gh:env:GH_TOKEN', kind: 'api-key',
    payload: new TextEncoder().encode('y'),
  });

  await saveConfig(bus, ctx, {
    id: 'gh', enabled: true, transport: 'stdio', command: 'mcp-gh', args: [],
    env: { GH_TOKEN: '' }, ownerId: null,
  });

  const list = await bus.call('credentials:list', ctx, {});
  expect(list.credentials.filter((c: any) => c.ref === 'mcp:gh:env:LEGACY')).toEqual([]);
  expect(list.credentials.filter((c: any) => c.ref === 'mcp:gh:env:GH_TOKEN')).toHaveLength(1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm test --filter @ax/mcp-client
```

Expected: the new tests FAIL.

- [ ] **Step 3: Implement the cleanup logic**

In `packages/mcp-client/src/admin-routes.ts`:

- Before `saveConfig`, fetch the existing config via `loadConfigById`. After the new config is saved, compute the dropped env names (and dropped header names for http transports) and call `credentials:delete` for each `mcp:<id>:env:<name>` / `mcp:<id>:header:<name>` row across all scopes (use the list+filter pattern from Task 14).
- Before `deleteConfig`, load the existing config; after the row is gone, purge every declared env/header credential for `mcp:<id>:`.

Both paths can share one helper `purgeMcpCredentials(bus, ctx, id, envNames, headerNames)`.

Add `'credentials:list'` and `'credentials:delete'` to the manifest `calls:` in `packages/mcp-client/src/plugin.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm test --filter @ax/mcp-client
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-client/src/admin-routes.ts \
        packages/mcp-client/src/plugin.ts \
        packages/mcp-client/src/__tests__/admin-routes.test.ts
git commit -m "feat(mcp-client): purge env+header credentials on server delete / config edit drop"
```

---

## Task 16: Owning-plugin delete — `@ax/routines` fires `credentials:delete` on routine delete

**Files:**
- Modify: `packages/routines/src/sync.ts` — in the `change.kind === 'deleted'` branch, before `store.delete(...)`, call `credentials:delete` for `routine:<agentId>:<path>:hmac` across all scopes.
- Modify: `packages/routines/src/plugin.ts` — add `credentials:list`, `credentials:delete` to `calls:`.
- Modify: `packages/routines/src/__tests__/sync.test.ts` (or existing sync test file).

- [ ] **Step 1: Write the failing test**

```ts
it('on workspace-applied delete, purges the routine HMAC credential', async () => {
  // Seed a webhook routine in the store + an HMAC credential at the agent scope.
  // (Set up via the existing sync test harness.)
  await bus.call('credentials:set', ctx, {
    scope: 'agent', ownerId: 'agt-1',
    ref: 'routine:agt-1:.ax/routines/gh.md:hmac',
    kind: 'api-key', payload: new TextEncoder().encode('s'),
  });

  await handleWorkspaceApplied(deps, ctx, {
    author: { agentId: 'agt-1', userId: 'alice' },
    changes: [{ path: '.ax/routines/gh.md', kind: 'deleted' }],
  } as any, new Date());

  const list = await bus.call('credentials:list', ctx, {});
  expect(list.credentials.filter(
    (c: any) => c.ref === 'routine:agt-1:.ax/routines/gh.md:hmac',
  )).toEqual([]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test --filter @ax/routines
```

Expected: FAIL.

- [ ] **Step 3: Implement the purge in `sync.ts`**

In `packages/routines/src/sync.ts:37` (the existing `if (change.kind === 'deleted')` branch), insert before `await deps.store.delete(...)`:

```ts
const hmacRef = `routine:${agentId}:${change.path}:hmac`;
try {
  const list = await deps.bus.call<
    Record<string, never>,
    { credentials: Array<{ scope: 'user' | 'agent' | 'global'; ownerId: string | null; ref: string }> }
  >('credentials:list', ctx, {});
  for (const c of list.credentials) {
    if (c.ref !== hmacRef) continue;
    await deps.bus.call('credentials:delete', ctx, {
      scope: c.scope, ownerId: c.ownerId, ref: c.ref,
    });
  }
} catch (err) {
  // Don't wedge a routine delete on a credentials hiccup — log and continue.
  ctx.logger.warn('routines_sync_credential_purge_failed', {
    agentId, path: change.path,
    err: err instanceof Error ? err.message : String(err),
  });
}
```

Add `'credentials:list'`, `'credentials:delete'` to `packages/routines/src/plugin.ts` `calls:`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm test --filter @ax/routines
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/routines/src/sync.ts \
        packages/routines/src/plugin.ts \
        packages/routines/src/__tests__/sync.test.ts
git commit -m "feat(routines): purge HMAC credential on workspace-driven routine delete"
```

---

## Task 17: Owning-plugin delete — `@ax/agents` fires `credentials:purge-by-owner` on agent delete

**Files:**
- Modify: `packages/agents/src/plugin.ts:471-488` — `deleteAgent()` calls `credentials:purge-by-owner({ scope: 'agent', ownerId })` before `store.deleteById`.
- Modify: `packages/agents/src/__tests__/plugin.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('agents:delete calls credentials:purge-by-owner({ scope: agent }) exactly once', async () => {
  const h = await harness();
  await h.bus.call('credentials:set', h.ctx, {
    scope: 'agent', ownerId: 'agt-1', ref: 'skill:s:T', kind: 'api-key',
    payload: new TextEncoder().encode('x'),
  });
  await h.bus.call('agents:delete', h.ctx, {
    agentId: 'agt-1', actor: { userId: 'admin', isAdmin: true },
  });
  const list = await h.bus.call('credentials:list', h.ctx, {
    scope: 'agent', ownerId: 'agt-1',
  });
  expect(list.credentials).toEqual([]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test --filter @ax/agents
```

Expected: FAIL.

- [ ] **Step 3: Wire the purge**

In `packages/agents/src/plugin.ts`, modify `deleteAgent`:

```ts
async function deleteAgent(
  store: AgentStore, bus: HookBus, ctx: AgentContext, input: DeleteInput,
): Promise<DeleteOutput> {
  const existing = await store.getById(input.agentId);
  if (existing === null) {
    throw new PluginError({
      code: 'not-found', plugin: PLUGIN_NAME, hookName: 'agents:delete',
      message: `agent '${input.agentId}' not found`,
    });
  }
  await assertWriteAllowed(existing, bus, ctx, input.actor);
  // Purge credentials FIRST — if it fails, the agent row stays, and the
  // operator can retry. If we deleted the agent first and the purge
  // failed, the agent's credential rows would be orphaned.
  if (bus.hasService('credentials:purge-by-owner')) {
    try {
      await bus.call('credentials:purge-by-owner', ctx, {
        scope: 'agent', ownerId: input.agentId,
      });
    } catch (err) {
      ctx.logger.warn('agents_delete_credential_purge_failed', {
        agentId: input.agentId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  await store.deleteById(input.agentId);
}
```

Add `'credentials:purge-by-owner'` to manifest `calls:`. Wrap in `hasService` so stripped presets without the credentials plugin still boot. The graceful-degrade matches the existing teams check.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm test --filter @ax/agents
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/plugin.ts \
        packages/agents/src/__tests__/plugin.test.ts
git commit -m "feat(agents): purge agent-scope credentials on agents:delete"
```

---

## Task 18: Delete the legacy credentials UI components

**Files:**
- Delete: `packages/channel-web/src/components/credentials/ApiKeyForm.tsx`
- Delete: `packages/channel-web/src/components/credentials/CredentialAddMenu.tsx`
- Delete: `packages/channel-web/src/components/credentials/CredentialsList.tsx`
- Delete: `packages/channel-web/src/components/settings/SettingsPanel.tsx`
- Delete: `packages/channel-web/src/components/credentials/__tests__/ApiKeyForm.test.tsx` (and any other component-specific tests under this dir aside from the new ones).
- Modify: `packages/channel-web/src/App.tsx` — drop the SettingsPanel import + mount.
- Modify: `packages/channel-web/src/lib/credentials.ts` — drop `adminCredentials.create`, `adminCredentials.delete`, `myCredentials.create`, `myCredentials.delete`. Keep `adminCredentials.list` and `myCredentials.list` (used by `<CredentialSlotRow>`).

- [ ] **Step 1: Identify every importer of the deleted files**

```bash
grep -rn "from '.*ApiKeyForm'\|from '.*CredentialAddMenu'\|from '.*CredentialsList'\|from '.*SettingsPanel'" packages/channel-web/src
```

Expect hits in `SettingsPanel.tsx` (self-references), `App.tsx`, and any storybook / demo. Each one must be reachable from no surviving caller after this step.

- [ ] **Step 2: Delete the files**

```bash
git rm packages/channel-web/src/components/credentials/ApiKeyForm.tsx \
       packages/channel-web/src/components/credentials/CredentialAddMenu.tsx \
       packages/channel-web/src/components/credentials/CredentialsList.tsx \
       packages/channel-web/src/components/settings/SettingsPanel.tsx
git rm packages/channel-web/src/components/credentials/__tests__/ApiKeyForm.test.tsx \
  2>/dev/null || true
git rm packages/channel-web/src/components/credentials/__tests__/CredentialAddMenu.test.tsx \
  2>/dev/null || true
git rm packages/channel-web/src/components/credentials/__tests__/CredentialsList.test.tsx \
  2>/dev/null || true
```

- [ ] **Step 3: Drop the SettingsPanel mount from `App.tsx`**

In `packages/channel-web/src/App.tsx`, remove:

```ts
import { SettingsPanel } from './components/settings/SettingsPanel';
```

and any `<SettingsPanel ...>` JSX + the state that opens it. Drop the settings nav item that triggered it (likely in a user-menu file — `grep -rn 'open.*settings\|Settings' packages/channel-web/src/components`).

- [ ] **Step 4: Shrink `lib/credentials.ts`**

Keep only the read paths:

```ts
export const adminCredentials = {
  async list(filter?: { scope: 'global' | 'user' | 'agent'; ownerId: string | null }): Promise<CredentialMeta[]> {
    const url = new URL('/admin/credentials', window.location.origin);
    if (filter !== undefined) {
      url.searchParams.set('scope', filter.scope);
      if (filter.ownerId !== null) url.searchParams.set('ownerId', filter.ownerId);
    }
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json() as { credentials: CredentialMeta[] };
    return body.credentials;
  },
};

export const myCredentials = {
  async list(): Promise<CredentialMeta[]> {
    const res = await fetch('/settings/credentials');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json() as { credentials: CredentialMeta[] };
    return body.credentials;
  },
};
```

Drop the `.create()` / `.delete()` methods — every caller is now routed through `setDestinationCredential` / `clearDestinationCredential` in Task 7.

- [ ] **Step 5: Run the build to find the long tail**

```bash
pnpm build
```

Expected: a few tsc errors pointing at stale references. Fix each. Re-run.

```bash
pnpm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore(channel-web): delete legacy credentials UI (ApiKeyForm/Add/List/SettingsPanel)"
```

---

## Task 19: Delete the legacy HTTP routes — settings, oauth, admin CRUD

**Files:**
- Delete: `packages/credentials-admin-routes/src/settings-routes.ts`
- Delete: `packages/credentials-admin-routes/src/oauth-routes.ts`
- Delete: `packages/credentials-admin-routes/src/__tests__/settings-handlers.test.ts`
- Delete: `packages/credentials-admin-routes/src/__tests__/oauth-flow.test.ts`
- Modify: `packages/credentials-admin-routes/src/admin-routes.ts` — keep `list` (still used by `<CredentialSlotRow>` for the status pill) + `kinds`; remove `create`, `destroy`.
- Modify: `packages/credentials-admin-routes/src/__tests__/admin-handlers.test.ts` — drop `create`/`destroy` tests.
- Modify: `packages/credentials-admin-routes/src/plugin.ts` — remove the `registerSettingsCredentialsRoutes` / `registerOauthRoutes` calls.

The kept `/admin/credentials` GET + `/admin/credentials/kinds` GET are the read-only support paths for the new UI. The kinds endpoint is otherwise unreferenced and could go, but per the design "kept at the service-hook layer", keep both at the route layer too — they're tiny.

Wait, design §3 actually lists `/admin/credentials` (POST list + DELETE) as deleted but lists `/settings/credentials` similarly. Reading again: GET is not in the delete list. So GET stays.

- [ ] **Step 1: Delete the files**

```bash
git rm packages/credentials-admin-routes/src/settings-routes.ts \
       packages/credentials-admin-routes/src/oauth-routes.ts \
       packages/credentials-admin-routes/src/__tests__/settings-handlers.test.ts \
       packages/credentials-admin-routes/src/__tests__/oauth-flow.test.ts
```

- [ ] **Step 2: Shrink `admin-routes.ts`**

Keep only the `list` and `kinds` handlers. Drop `create` and `destroy` along with their imports.

- [ ] **Step 3: Drop the imports + calls in `plugin.ts`**

In `packages/credentials-admin-routes/src/plugin.ts`, remove:

```ts
import { registerSettingsCredentialsRoutes } from './settings-routes.js';
import { registerOauthRoutes } from './oauth-routes.js';
```

and the corresponding `unregisterRoutes.push(...)` calls.

- [ ] **Step 4: Run the build + tests**

```bash
pnpm build
pnpm test --filter @ax/credentials-admin-routes
```

Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(credentials-admin-routes): delete settings + oauth + write CRUD; keep list/kinds"
```

---

## Task 20: Drop `@ax/credentials-anthropic-oauth` and `@ax/credentials-oauth-pending` from the production wire

Per design §3 non-goals: OAuth-paste flows are out for MVP. The plugins themselves can stay in-repo (they're tested) but the k8s preset should not load them, and the channel-web client should not advertise an OAuth flow in any UI surface. We're not deleting the packages outright — only ensuring no production preset wires them, so the `/admin/credentials/oauth/*` routes (deleted in Task 19) leave no orphan caller.

**Files:**
- Modify: `presets/k8s/src/index.ts` — drop the `createCredentialsOauthPendingPlugin()` line from the plugin list.

- [ ] **Step 1: Find the wire site**

```bash
grep -n "createCredentialsOauthPendingPlugin\|createCredentialsAnthropicOauthPlugin" presets/k8s/src/index.ts
```

- [ ] **Step 2: Remove the line(s)**

Comment out (don't `git rm` the package — it stays in the repo for future re-introduction):

```ts
// MVP: OAuth-paste flows deferred — see docs/plans/2026-05-19-credentials-ux-redesign-design.md §3.
// createCredentialsOauthPendingPlugin(),
// createCredentialsAnthropicOauthPlugin(),
```

- [ ] **Step 3: Run the preset acceptance test**

```bash
pnpm test --filter @ax/preset-k8s -- preset
```

Expected: the preset.test.ts static manifest assertion picks up the change — update its expected plugin list to match.

- [ ] **Step 4: Commit**

```bash
git add presets/k8s/src/index.ts \
        presets/k8s/src/__tests__/preset.test.ts
git commit -m "chore(preset-k8s): unload OAuth credential plugins for MVP redesign"
```

---

## Task 21: Cross-plugin lifecycle canary

Extend `presets/k8s/src/__tests__/acceptance.test.ts` (the canary that boots the full preset) with one new lifecycle assertion:

- Create one credential at each destination kind (provider via Providers tab path; skill-slot via attachment path; mcp-env via MCP server path; routine-hmac via workspace markdown path).
- Delete each destination one by one.
- Assert `credentials_v1_envelopes` ends empty (via `credentials:list({})`).

This is the design's "cross-plugin lifecycle test in acceptance.test.ts" obligation.

**Files:**
- Modify: `presets/k8s/src/__tests__/acceptance.test.ts`

- [ ] **Step 1: Add the test**

At the end of the existing canary `describe` block:

```ts
it('destination-first lifecycle: every credential outlives no longer than its destination', async () => {
  // [Boot the preset harness — reuse the existing setup at the top of the file.]
  const h = await bootPresetHarness();

  // Seed credentials at each destination kind.
  for (const args of [
    { scope: 'global', ownerId: null,
      ref: refForDestination({ kind: 'provider', provider: 'anthropic' }) },
    { scope: 'agent', ownerId: 'agt-1',
      ref: refForDestination({ kind: 'skill-slot', skillId: 's1', slot: 'T' }) },
    { scope: 'global', ownerId: null,
      ref: refForDestination({ kind: 'mcp-env', serverId: 'srv', envName: 'E' }) },
    { scope: 'agent', ownerId: 'agt-1',
      ref: refForDestination({ kind: 'routine-hmac', agentId: 'agt-1',
                                routinePath: '.ax/routines/r.md' }) },
  ] as const) {
    await h.bus.call('credentials:set', h.ctx, {
      ...args, kind: 'api-key', payload: new TextEncoder().encode('x'),
    });
  }

  // Verify all four are stored.
  expect((await h.bus.call('credentials:list', h.ctx, {})).credentials).toHaveLength(4);

  // Now delete each destination:
  await h.bus.call('skills:delete', h.ctx, { skillId: 's1' });           // skill-slot
  await deleteMcpServer(h, 'srv');                                       // mcp-env
  await applyWorkspaceDelete(h, '.ax/routines/r.md', 'agt-1', 'alice');  // routine-hmac
  await h.bus.call('agents:delete', h.ctx, {
    agentId: 'agt-1', actor: { userId: 'admin', isAdmin: true },
  });                                                                    // agent purge
  // (provider destination never goes away — the only cleanup path is an explicit delete.)
  await h.bus.call('credentials:delete', h.ctx, {
    scope: 'global', ownerId: null,
    ref: refForDestination({ kind: 'provider', provider: 'anthropic' }),
  });

  expect((await h.bus.call('credentials:list', h.ctx, {})).credentials).toEqual([]);
});
```

Adjust the harness boot bits to match the existing preset acceptance setup. The skill-delete path assumes the skill was attached only to `agt-1` and the agent purge handles it; if the skill-attached check rejects the delete, detach first in the test.

- [ ] **Step 2: Run the preset acceptance test**

```bash
pnpm test --filter @ax/preset-k8s
```

Expected: the new test passes.

- [ ] **Step 3: Commit**

```bash
git add presets/k8s/src/__tests__/acceptance.test.ts
git commit -m "test(preset-k8s): cross-plugin destination-first credential lifecycle canary"
```

---

## Task 22: Final pass — lint, typecheck, full test run

- [ ] **Step 1: Run lint, build, and full tests**

```bash
pnpm lint
pnpm build
pnpm test
```

Expected: all pass.

- [ ] **Step 2: Skim for orphans**

```bash
# refs that were missed
grep -rn "'anthropic-api'" packages | grep -v node_modules | grep -v dist
# unused imports the deletes might have left
grep -rn "ApiKeyForm\|CredentialAddMenu\|CredentialsList\|SettingsPanel" packages/channel-web/src
# orphaned routes
grep -rn "/admin/credentials/oauth\|/settings/credentials" packages
```

Expected: no hits.

- [ ] **Step 3: Commit any cleanup**

```bash
git add -A
git commit -m "chore: post-PR cleanup — remove stale references"
```

---

## Task 23: Update the memory note

- [ ] Add a project memory note recording: PR shipped, the six wiring sites, the deterministic ref convention, the wipe-once marker key (`credentials:redesign-2026-05-19:wiped`), and the deferred items (OAuth-paste, user-personal MCP, audit/inventory surface, reusable credentials across destinations, user-delete wiring in `@ax/auth-better`).

This isn't a code change — it's a note in `/Users/vpulim/.claude/projects/-Users-vpulim-dev-ai-ax-next/memory/` per the `auto memory` convention. Keep it under 200 chars in `MEMORY.md`.

---

## Open in this plan (deferred to follow-ups, NOT in this PR)

- **User-delete wiring in `@ax/auth-better`** — the auth-better plugin doesn't yet expose a user-delete service hook. When it lands, it should call `credentials:purge-by-owner({ scope: 'user', ownerId: userId })`. Tracked here, not implemented here.
- **Strict validator: routine markdown's declared `secretRef` must equal `refForDestination(...)`.** Today users have to manually type the right string. A linter in `@ax/validator-routine` could reject mismatches at upsert time. Out of scope.
- **Provider pre-save validation against the provider API.** The current `/admin/credentials/providers/:id/validate` route validates the key against Anthropic before saving. The new ProvidersPanel drops this — the save just stores. UX regression. Reintroducing it is a small additive Task 24 if reviewers push back; otherwise defer.
- **Bulk "all credentials" admin inventory view.** Design §3 non-goal.

---

## Notes for the executing engineer

- **Don't merge tasks 5 + 11 + 12 + 13 + 18 + 19 separately.** The design's I3 ("no half-wired plugins") requires the whole PR to land together. Use feature branches per task internally if you want fine-grained review, but the merge to `main` is one PR.
- **Test ordering:** if your harness for `@ax/credentials` is in-memory and brand-new boot per `harness()`, the wipe-once test (Task 6) is the only one sensitive to boot order — pass an explicit storage handle to share state across boots inside that test.
- **The `refs.ts` helper is the only place colons are minted.** Any other code that constructs a `skill:...` / `mcp:...` / etc. string by hand is wrong — make it call `refForDestination`.
- **REF_RE relaxation lands in Task 1, before any colon-bearing ref is written.** If Task 1 is skipped or split out, every subsequent `credentials:set` test fails with "credential ref must match /^[a-z0-9][a-z0-9_.-]{0,127}$/".
