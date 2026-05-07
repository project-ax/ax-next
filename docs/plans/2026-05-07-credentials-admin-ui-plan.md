# Credentials Admin UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up admin and per-user surfaces for managing credentials in channel-web (HTTP routes + React UI), backed by a three-scope data model (`global` / `user` / `agent`) and a web-paste OAuth flow that doesn't require localhost binding.

**Architecture:** Bottom-up (Approach A from spec §7). Storage migration → facade scope axis → HTTP routes → OAuth state-holder + paste-flow routes → admin UI → settings UI → Phase F canary → cleanup. Each phase is one PR; no half-wired code merges (CLAUDE.md invariant 3).

**Tech Stack:** TypeScript, Node.js, pnpm workspaces, vitest, zod, React + assistant-ui, AES-256-GCM (existing in `@ax/credentials`), PKCE OAuth (existing in `@ax/credentials-anthropic-oauth`).

**Spec:** `docs/plans/2026-05-06-credentials-admin-ui-design.md`

---

## File Structure

### Modified files

- `packages/credentials/src/plugin.ts` — facade `set/get/delete` grow `scope`/`ownerId`; add `list` + `list-kinds`; precedence chain in `get`
- `packages/credentials/src/index.ts` — re-export new types
- `packages/credentials-store-db/src/plugin.ts` — new key format `credential:v2:${scope}:${ownerId??"_"}:${ref}`; v1-key read-fallback; new `credentials:store-blob:list`
- `packages/credentials/src/__tests__/*.test.ts` — facade tests
- `packages/credentials-store-db/src/__tests__/*.test.ts` — store-blob tests
- `packages/cli/src/commands/credentials.ts` — pass `scope='user'`/`ownerId=CLI_USER_ID` on `set`; add new `migrate` subcommand
- `packages/channel-web/src/components/admin/AdminPanel.tsx` — add `'credentials'` view
- `packages/channel-web/src/lib/admin.ts` — add `'credentials'` to `AdminView` union
- `presets/k8s/src/index.ts` — load `@ax/credentials-admin-routes`; surface `AX_CREDENTIALS_ADMIN_ENABLED` env var
- `presets/k8s/src/__tests__/acceptance.test.ts` — Phase F canary: scope precedence + paste-flow OAuth
- `deploy/charts/ax-next/values.yaml` + `templates/host/deployment.yaml` — chart wiring
- `deploy/MANUAL-ACCEPTANCE.md` — manual browser walkthrough
- `presets/k8s/src/__tests__/k8s-e2e/helpers.ts` — add `seedAdminCredential` helper for canary

### New files

- `packages/credentials-admin-routes/` (new package) — HTTP routes for `/admin/credentials*` + `/settings/credentials*`
- `packages/credentials-oauth-pending/` (new package) — in-memory PKCE state holder
- `packages/channel-web/src/components/credentials/` — shared list + form components
- `packages/channel-web/src/components/settings/SettingsPanel.tsx` — per-user modal
- `packages/channel-web/src/lib/credentials.ts` — typed wire client

---

## PHASE 1 — Storage + facade scope axis

**Outcome:** `@ax/credentials` exposes `scope`/`ownerId` on `set`/`delete`, walks the resolution precedence chain in `get`, and returns metadata via the new `credentials:list` hook. Storage uses the new `v2:` key format with read-fallback for v1. CLI keeps working unchanged (writes `scope='user'`, `ownerId=CLI_USER_ID`).

**PR title:** `feat(credentials): scope axis (global/user/agent) + list/list-kinds + v2 keys`

### Task 1.1: Add scope types and validators to facade

**Files:**
- Modify: `packages/credentials/src/plugin.ts:1-80` (top-of-file types and validators)
- Test: `packages/credentials/src/__tests__/scope-validation.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// packages/credentials/src/__tests__/scope-validation.test.ts
import { describe, it, expect } from 'vitest';
import { validateScope, validateOwnerIdForScope, SCOPE_VALUES } from '../plugin.js';

describe('scope validation', () => {
  it('accepts the three documented scope values', () => {
    expect(SCOPE_VALUES).toEqual(['global', 'user', 'agent']);
    for (const s of SCOPE_VALUES) expect(() => validateScope(s)).not.toThrow();
  });

  it('rejects unknown scope', () => {
    expect(() => validateScope('team')).toThrow(/scope must be one of/);
  });

  it('requires ownerId=null for scope=global', () => {
    expect(() => validateOwnerIdForScope('global', null)).not.toThrow();
    expect(() => validateOwnerIdForScope('global', 'alice')).toThrow(/ownerId must be null when scope='global'/);
  });

  it('requires non-null ownerId for scope=user|agent', () => {
    expect(() => validateOwnerIdForScope('user', 'alice')).not.toThrow();
    expect(() => validateOwnerIdForScope('agent', 'agent-1')).not.toThrow();
    expect(() => validateOwnerIdForScope('user', null)).toThrow(/ownerId is required/);
    expect(() => validateOwnerIdForScope('agent', null)).toThrow(/ownerId is required/);
  });

  it('validates ownerId character set (mirrors existing USER_ID_RE)', () => {
    expect(() => validateOwnerIdForScope('user', 'a..b')).not.toThrow();
    expect(() => validateOwnerIdForScope('user', 'has space')).toThrow();
    expect(() => validateOwnerIdForScope('user', '')).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ax/credentials test scope-validation`
Expected: FAIL with `validateScope is not exported`.

- [ ] **Step 3: Implement the exports**

In `packages/credentials/src/plugin.ts`, add near the top:

```ts
export const SCOPE_VALUES = ['global', 'user', 'agent'] as const;
export type CredentialScope = (typeof SCOPE_VALUES)[number];

export function validateScope(scope: unknown): CredentialScope {
  if (typeof scope !== 'string' || !(SCOPE_VALUES as readonly string[]).includes(scope)) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `scope must be one of ${SCOPE_VALUES.join('|')}`,
    });
  }
  return scope as CredentialScope;
}

export function validateOwnerIdForScope(
  scope: CredentialScope,
  ownerId: unknown,
): string | null {
  if (scope === 'global') {
    if (ownerId !== null) {
      throw new PluginError({
        code: 'invalid-payload',
        plugin: PLUGIN_NAME,
        message: "ownerId must be null when scope='global'",
      });
    }
    return null;
  }
  if (typeof ownerId !== 'string' || ownerId.length === 0) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `ownerId is required when scope='${scope}'`,
    });
  }
  // Reuse the existing USER_ID_RE — same character set is fine for agent ids.
  if (!USER_ID_RE.test(ownerId)) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `ownerId must match ${USER_ID_RE.source}`,
    });
  }
  return ownerId;
}
```

- [ ] **Step 4: Run tests; verify pass**

Run: `pnpm --filter @ax/credentials test scope-validation`
Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add packages/credentials/src/plugin.ts packages/credentials/src/__tests__/scope-validation.test.ts
git commit -m "feat(credentials): add scope + ownerId validators"
```

---

### Task 1.2: Update store-blob keys to v2 format with v1 read-fallback

**Files:**
- Modify: `packages/credentials-store-db/src/plugin.ts`
- Test: `packages/credentials-store-db/src/__tests__/v2-keys.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// packages/credentials-store-db/src/__tests__/v2-keys.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { bootstrap, HookBus, makeAgentContext } from '@ax/core';
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
import { createCredentialsStoreDbPlugin, v2StorageKey, v1StorageKey } from '../plugin.js';

describe('store-blob v2 keys with v1 fallback', () => {
  it('encodes the v2 key correctly for each scope', () => {
    expect(v2StorageKey('global', null, 'anthropic-api-key'))
      .toBe('credential:v2:global:_:anthropic-api-key');
    expect(v2StorageKey('user', 'alice', 'gh-token'))
      .toBe('credential:v2:user:alice:gh-token');
    expect(v2StorageKey('agent', 'linear-bot', 'linear-api'))
      .toBe('credential:v2:agent:linear-bot:linear-api');
  });

  it('encodes the v1 key for backward-read', () => {
    expect(v1StorageKey('alice', 'gh-token'))
      .toBe('credential:alice:gh-token');
  });

  it('v2 put then v2 get round-trips', async () => {
    const bus = new HookBus();
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
    await bootstrap({ bus, plugins: [createStorageSqlitePlugin({ path: ':memory:' }), createCredentialsStoreDbPlugin()] });
    const blob = new Uint8Array([1, 2, 3]);
    await bus.call('credentials:store-blob:put', ctx, {
      scope: 'global', ownerId: null, ref: 'anthropic-api-key', blob,
    });
    const got = await bus.call('credentials:store-blob:get', ctx, {
      scope: 'global', ownerId: null, ref: 'anthropic-api-key',
    });
    expect((got as { blob: Uint8Array | undefined }).blob).toEqual(blob);
  });

  it('v2 get falls back to v1 when scope=user and no v2 row exists', async () => {
    const bus = new HookBus();
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
    await bootstrap({ bus, plugins: [createStorageSqlitePlugin({ path: ':memory:' }), createCredentialsStoreDbPlugin()] });
    // Seed a v1 key directly via storage:set.
    await bus.call('storage:set', ctx, { key: v1StorageKey('alice', 'gh-token'), value: new Uint8Array([9]) });
    const got = await bus.call('credentials:store-blob:get', ctx, {
      scope: 'user', ownerId: 'alice', ref: 'gh-token',
    });
    expect((got as { blob: Uint8Array | undefined }).blob).toEqual(new Uint8Array([9]));
  });

  it('v2 get does NOT fall back to v1 for scope=global or scope=agent', async () => {
    const bus = new HookBus();
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
    await bootstrap({ bus, plugins: [createStorageSqlitePlugin({ path: ':memory:' }), createCredentialsStoreDbPlugin()] });
    // Seeding under a v1-style key for an agent-scoped ref must NOT be visible.
    await bus.call('storage:set', ctx, { key: v1StorageKey('agent-1', 'foo'), value: new Uint8Array([5]) });
    const got = await bus.call('credentials:store-blob:get', ctx, {
      scope: 'agent', ownerId: 'agent-1', ref: 'foo',
    });
    expect((got as { blob: Uint8Array | undefined }).blob).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run; verify fails**

Run: `pnpm --filter @ax/credentials-store-db test v2-keys`
Expected: FAIL with `v2StorageKey is not exported`.

- [ ] **Step 3: Implement v2 keys + v1 fallback**

Replace the body of `packages/credentials-store-db/src/plugin.ts`:

```ts
import { PluginError, type Plugin } from '@ax/core';

const PLUGIN_NAME = '@ax/credentials-store-db';
const KEY_PREFIX_V2 = 'credential:v2:';
const KEY_PREFIX_V1 = 'credential:';
const REF_RE = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
const OWNER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/;
const SCOPE_VALUES = ['global', 'user', 'agent'] as const;
type Scope = (typeof SCOPE_VALUES)[number];

export interface StoreBlobPutInput {
  scope: Scope;
  ownerId: string | null;
  ref: string;
  blob: Uint8Array;
}
export interface StoreBlobGetInput {
  scope: Scope;
  ownerId: string | null;
  ref: string;
}
export interface StoreBlobGetOutput {
  blob: Uint8Array | undefined;
}
export interface StoreBlobListInput {
  // null means "all scopes" (admin list); otherwise filter to one.
  scope?: Scope;
  ownerId?: string | null;
}
export interface StoreBlobListEntry {
  scope: Scope;
  ownerId: string | null;
  ref: string;
  blob: Uint8Array;
}
export interface StoreBlobListOutput {
  entries: StoreBlobListEntry[];
}

export function v2StorageKey(scope: Scope, ownerId: string | null, ref: string): string {
  return `${KEY_PREFIX_V2}${scope}:${ownerId ?? '_'}:${ref}`;
}

export function v1StorageKey(userId: string, ref: string): string {
  return `${KEY_PREFIX_V1}${userId}:${ref}`;
}

function validateScope(scope: unknown): Scope {
  if (typeof scope !== 'string' || !(SCOPE_VALUES as readonly string[]).includes(scope)) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `scope must be one of ${SCOPE_VALUES.join('|')}`,
    });
  }
  return scope as Scope;
}
function validateOwnerId(scope: Scope, ownerId: unknown): string | null {
  if (scope === 'global') {
    if (ownerId !== null) {
      throw new PluginError({ code: 'invalid-payload', plugin: PLUGIN_NAME, message: "ownerId must be null when scope='global'" });
    }
    return null;
  }
  if (typeof ownerId !== 'string' || !OWNER_ID_RE.test(ownerId)) {
    throw new PluginError({ code: 'invalid-payload', plugin: PLUGIN_NAME, message: `ownerId must match ${OWNER_ID_RE.source}` });
  }
  return ownerId;
}
function validateRef(ref: unknown): string {
  if (typeof ref !== 'string' || !REF_RE.test(ref)) {
    throw new PluginError({ code: 'invalid-payload', plugin: PLUGIN_NAME, message: `ref must match ${REF_RE.source}` });
  }
  return ref;
}

export function createCredentialsStoreDbPlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [
        'credentials:store-blob:put',
        'credentials:store-blob:get',
        'credentials:store-blob:list',
      ],
      calls: ['storage:get', 'storage:set', 'storage:list-prefix'],
      subscribes: [],
    },
    async init({ bus }) {
      bus.registerService<StoreBlobPutInput, void>(
        'credentials:store-blob:put',
        PLUGIN_NAME,
        async (ctx, input) => {
          const scope = validateScope(input.scope);
          const ownerId = validateOwnerId(scope, input.ownerId);
          const ref = validateRef(input.ref);
          if (!(input.blob instanceof Uint8Array)) {
            throw new PluginError({ code: 'invalid-payload', plugin: PLUGIN_NAME, message: 'blob must be Uint8Array' });
          }
          await bus.call('storage:set', ctx, { key: v2StorageKey(scope, ownerId, ref), value: input.blob });
        },
      );

      bus.registerService<StoreBlobGetInput, StoreBlobGetOutput>(
        'credentials:store-blob:get',
        PLUGIN_NAME,
        async (ctx, input) => {
          const scope = validateScope(input.scope);
          const ownerId = validateOwnerId(scope, input.ownerId);
          const ref = validateRef(input.ref);
          const v2 = await bus.call<{ key: string }, { value: Uint8Array | undefined }>(
            'storage:get', ctx, { key: v2StorageKey(scope, ownerId, ref) });
          if (v2.value !== undefined) return { blob: v2.value };
          // Fallback to v1 ONLY for scope='user' (v1 keys were per-userId only).
          if (scope === 'user' && ownerId !== null) {
            const v1 = await bus.call<{ key: string }, { value: Uint8Array | undefined }>(
              'storage:get', ctx, { key: v1StorageKey(ownerId, ref) });
            return { blob: v1.value };
          }
          return { blob: undefined };
        },
      );

      bus.registerService<StoreBlobListInput, StoreBlobListOutput>(
        'credentials:store-blob:list',
        PLUGIN_NAME,
        async (ctx, input) => {
          // Build prefix based on filters.
          let prefix = KEY_PREFIX_V2;
          if (input.scope !== undefined) {
            const scope = validateScope(input.scope);
            prefix += `${scope}:`;
            if (input.ownerId !== undefined) {
              const ownerId = validateOwnerId(scope, input.ownerId);
              prefix += `${ownerId ?? '_'}:`;
            }
          }
          const out = await bus.call<{ prefix: string }, { entries: Array<{ key: string; value: Uint8Array }> }>(
            'storage:list-prefix', ctx, { prefix });
          const entries: StoreBlobListEntry[] = [];
          for (const e of out.entries) {
            const rest = e.key.slice(KEY_PREFIX_V2.length); // "scope:owner:ref"
            const firstColon = rest.indexOf(':');
            const secondColon = rest.indexOf(':', firstColon + 1);
            if (firstColon < 0 || secondColon < 0) continue;
            const scope = rest.slice(0, firstColon) as Scope;
            const ownerRaw = rest.slice(firstColon + 1, secondColon);
            const ref = rest.slice(secondColon + 1);
            entries.push({
              scope,
              ownerId: ownerRaw === '_' ? null : ownerRaw,
              ref,
              blob: e.value,
            });
          }
          return { entries };
        },
      );
    },
  };
}
```

- [ ] **Step 4: Add `storage:list-prefix` to `@ax/storage-sqlite`**

In `packages/storage-sqlite/src/plugin.ts`, register a new service:

```ts
// Inside init({ bus }), alongside storage:get / storage:set:
bus.registerService<{ prefix: string }, { entries: Array<{ key: string; value: Uint8Array }> }>(
  'storage:list-prefix',
  PLUGIN_NAME,
  async (_ctx, input) => {
    if (typeof input.prefix !== 'string' || input.prefix.length === 0) {
      throw new PluginError({ code: 'invalid-payload', plugin: PLUGIN_NAME, message: 'prefix is required' });
    }
    const rows = db.prepare('SELECT key, value FROM kv WHERE key LIKE ?').all(`${input.prefix}%`) as Array<{ key: string; value: Buffer }>;
    return { entries: rows.map((r) => ({ key: r.key, value: new Uint8Array(r.value) })) };
  },
);
// And update the manifest's `registers` array to include 'storage:list-prefix'.
```

(If `@ax/storage-postgres` is loaded in the preset, add the equivalent there: `SELECT key, value FROM kv WHERE key LIKE $1` with `$1 = prefix || '%'`.)

- [ ] **Step 5: Run tests and commit**

Run: `pnpm --filter @ax/credentials-store-db test v2-keys && pnpm --filter @ax/storage-sqlite test`
Expected: all PASS.

```bash
git add packages/credentials-store-db packages/storage-sqlite packages/storage-postgres
git commit -m "feat(credentials-store-db): v2 key format + scope axis + list (with v1 read-fallback)"
```

---

### Task 1.3: Update facade `set` / `delete` to take scope/ownerId

**Files:**
- Modify: `packages/credentials/src/plugin.ts` (set, delete handlers)
- Test: `packages/credentials/src/__tests__/scope-set-delete.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// packages/credentials/src/__tests__/scope-set-delete.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { bootstrap, HookBus, makeAgentContext } from '@ax/core';
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '../plugin.js';

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('credentials:set / :delete with scope', () => {
  beforeEach(() => { process.env.AX_CREDENTIALS_KEY = KEY; });

  async function makeBus() {
    const bus = new HookBus();
    await bootstrap({ bus, plugins: [
      createStorageSqlitePlugin({ path: ':memory:' }),
      createCredentialsStoreDbPlugin(),
      createCredentialsPlugin(),
    ]});
    return bus;
  }

  it('writes a global credential', async () => {
    const bus = await makeBus();
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'admin' });
    await bus.call('credentials:set', ctx, {
      scope: 'global', ownerId: null, ref: 'anthropic-api-key', kind: 'api-key',
      payload: new TextEncoder().encode('sk-test'),
    });
    const value = await bus.call('credentials:get', ctx, { ref: 'anthropic-api-key', userId: 'someone' });
    expect(value).toBe('sk-test');
  });

  it('writes a user-scoped credential reachable only by that user', async () => {
    const bus = await makeBus();
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'alice' });
    await bus.call('credentials:set', ctx, {
      scope: 'user', ownerId: 'alice', ref: 'gh-token', kind: 'api-key',
      payload: new TextEncoder().encode('ghp_alice'),
    });
    expect(await bus.call('credentials:get', ctx, { ref: 'gh-token', userId: 'alice' })).toBe('ghp_alice');
    await expect(bus.call('credentials:get', ctx, { ref: 'gh-token', userId: 'bob' })).rejects.toThrow(/credential-not-found/);
  });

  it('rejects scope=global with non-null ownerId', async () => {
    const bus = await makeBus();
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'admin' });
    await expect(bus.call('credentials:set', ctx, {
      scope: 'global', ownerId: 'alice', ref: 'x', kind: 'api-key', payload: new Uint8Array([1]),
    })).rejects.toThrow(/ownerId must be null/);
  });

  it('rejects scope=user with null ownerId', async () => {
    const bus = await makeBus();
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'admin' });
    await expect(bus.call('credentials:set', ctx, {
      scope: 'user', ownerId: null, ref: 'x', kind: 'api-key', payload: new Uint8Array([1]),
    })).rejects.toThrow(/ownerId is required/);
  });

  it('delete writes a tombstone', async () => {
    const bus = await makeBus();
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'alice' });
    await bus.call('credentials:set', ctx, {
      scope: 'user', ownerId: 'alice', ref: 'gh-token', kind: 'api-key',
      payload: new TextEncoder().encode('x'),
    });
    await bus.call('credentials:delete', ctx, { scope: 'user', ownerId: 'alice', ref: 'gh-token' });
    await expect(bus.call('credentials:get', ctx, { ref: 'gh-token', userId: 'alice' })).rejects.toThrow(/credential-not-found/);
  });
});
```

- [ ] **Step 2: Run; verify FAIL**

Run: `pnpm --filter @ax/credentials test scope-set-delete`
Expected: FAIL — current `credentials:set` body shape doesn't accept `scope`.

- [ ] **Step 3: Update `credentials:set` and `credentials:delete` handlers**

In `packages/credentials/src/plugin.ts`:

Replace the `CredentialsSetInput` interface:
```ts
export interface CredentialsSetInput {
  scope: CredentialScope;
  ownerId: string | null;
  ref: string;
  kind: string;
  payload: Uint8Array;
  expiresAt?: number;
  metadata?: Record<string, unknown>;
}
export interface CredentialsDeleteInput {
  scope: CredentialScope;
  ownerId: string | null;
  ref: string;
}
```

Replace the `credentials:set` handler body:
```ts
bus.registerService<CredentialsSetInput, CredentialsSetOutput>(
  'credentials:set',
  PLUGIN_NAME,
  async (ctx, input) => {
    const scope = validateScope(input.scope);
    const ownerId = validateOwnerIdForScope(scope, input.ownerId);
    const ref = validateRef(input.ref);
    const kind = validateKind(input.kind);
    if (!(input.payload instanceof Uint8Array)) {
      throw new PluginError({ code: 'invalid-payload', plugin: PLUGIN_NAME, message: 'payload must be Uint8Array' });
    }
    const blob = wrapEnvelope(kind, input.payload, input.expiresAt, input.metadata);
    await bus.call('credentials:store-blob:put', ctx, { scope, ownerId, ref, blob });
  },
);
```

Replace the `credentials:delete` handler body:
```ts
bus.registerService<CredentialsDeleteInput, CredentialsDeleteOutput>(
  'credentials:delete',
  PLUGIN_NAME,
  async (ctx, input) => {
    const scope = validateScope(input.scope);
    const ownerId = validateOwnerIdForScope(scope, input.ownerId);
    const ref = validateRef(input.ref);
    const tombstone = encryptWithKey(key, '');
    await bus.call('credentials:store-blob:put', ctx, { scope, ownerId, ref, blob: tombstone });
  },
);
```

(Also update the manifest's `calls` array to include the new `credentials:store-blob:put`/`get` shape — already there, just confirm.)

- [ ] **Step 4: Run; verify PASS (set/delete cases) — get tests will still partially fail (precedence not yet wired)**

Run: `pnpm --filter @ax/credentials test scope-set-delete`
Expected: 4/5 PASS; the precedence-related case may fail until Task 1.4. Tag failing test with `it.todo` if needed for clean commit, then re-enable in Task 1.4.

- [ ] **Step 5: Commit**

```bash
git add packages/credentials/src/plugin.ts packages/credentials/src/__tests__/scope-set-delete.test.ts
git commit -m "feat(credentials): scope/ownerId on set + delete"
```

---

### Task 1.4: Implement resolution precedence in `credentials:get`

**Files:**
- Modify: `packages/credentials/src/plugin.ts` (get handler + doResolve)
- Test: `packages/credentials/src/__tests__/scope-precedence.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// packages/credentials/src/__tests__/scope-precedence.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { bootstrap, HookBus, makeAgentContext } from '@ax/core';
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '../plugin.js';

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('credentials:get scope precedence (user > agent > global)', () => {
  beforeEach(() => { process.env.AX_CREDENTIALS_KEY = KEY; });

  async function makeBus() {
    const bus = new HookBus();
    await bootstrap({ bus, plugins: [
      createStorageSqlitePlugin({ path: ':memory:' }),
      createCredentialsStoreDbPlugin(),
      createCredentialsPlugin(),
    ]});
    return bus;
  }

  it('returns global when only global exists', async () => {
    const bus = await makeBus();
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'agent-1', userId: 'alice' });
    await bus.call('credentials:set', ctx, { scope: 'global', ownerId: null, ref: 'k', kind: 'api-key', payload: new TextEncoder().encode('GLOBAL') });
    expect(await bus.call('credentials:get', ctx, { ref: 'k', userId: 'alice' })).toBe('GLOBAL');
  });

  it('agent overrides global', async () => {
    const bus = await makeBus();
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'agent-1', userId: 'alice' });
    await bus.call('credentials:set', ctx, { scope: 'global', ownerId: null, ref: 'k', kind: 'api-key', payload: new TextEncoder().encode('GLOBAL') });
    await bus.call('credentials:set', ctx, { scope: 'agent', ownerId: 'agent-1', ref: 'k', kind: 'api-key', payload: new TextEncoder().encode('AGENT') });
    expect(await bus.call('credentials:get', ctx, { ref: 'k', userId: 'alice' })).toBe('AGENT');
  });

  it('user overrides agent overrides global', async () => {
    const bus = await makeBus();
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'agent-1', userId: 'alice' });
    await bus.call('credentials:set', ctx, { scope: 'global', ownerId: null, ref: 'k', kind: 'api-key', payload: new TextEncoder().encode('GLOBAL') });
    await bus.call('credentials:set', ctx, { scope: 'agent', ownerId: 'agent-1', ref: 'k', kind: 'api-key', payload: new TextEncoder().encode('AGENT') });
    await bus.call('credentials:set', ctx, { scope: 'user', ownerId: 'alice', ref: 'k', kind: 'api-key', payload: new TextEncoder().encode('USER') });
    expect(await bus.call('credentials:get', ctx, { ref: 'k', userId: 'alice' })).toBe('USER');
  });

  it("agent scope only matched when ctx.agentId is set", async () => {
    const bus = await makeBus();
    const ctxNoAgent = makeAgentContext({ sessionId: 's', agentId: '', userId: 'alice' });
    await bus.call('credentials:set', ctxNoAgent, { scope: 'agent', ownerId: 'agent-1', ref: 'k', kind: 'api-key', payload: new TextEncoder().encode('AGENT') });
    await expect(bus.call('credentials:get', ctxNoAgent, { ref: 'k', userId: 'alice' })).rejects.toThrow(/credential-not-found/);
  });

  it("envFallback fires only when no v2 row exists in any scope", async () => {
    const bus = new HookBus();
    process.env.MY_FALLBACK = 'ENV_VALUE';
    await bootstrap({ bus, plugins: [
      createStorageSqlitePlugin({ path: ':memory:' }),
      createCredentialsStoreDbPlugin(),
      createCredentialsPlugin({ envFallback: { 'k': 'MY_FALLBACK' } }),
    ]});
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'agent-1', userId: 'alice' });
    expect(await bus.call('credentials:get', ctx, { ref: 'k', userId: 'alice' })).toBe('ENV_VALUE');
    // Now write a global; it should win over env.
    await bus.call('credentials:set', ctx, { scope: 'global', ownerId: null, ref: 'k', kind: 'api-key', payload: new TextEncoder().encode('GLOBAL') });
    expect(await bus.call('credentials:get', ctx, { ref: 'k', userId: 'alice' })).toBe('GLOBAL');
  });
});
```

- [ ] **Step 2: Run; verify FAIL**

Run: `pnpm --filter @ax/credentials test scope-precedence`
Expected: FAIL — current `doResolve` only checks one storage location.

- [ ] **Step 3: Implement the precedence chain in `doResolve`**

In `packages/credentials/src/plugin.ts`, replace the `doResolve` function:

```ts
async function doResolve(
  ctx: Parameters<Parameters<typeof bus.registerService>[2]>[0],
  userId: string,
  ref: string,
): Promise<string> {
  // Walk precedence: user → agent → global → envFallback → not-found.
  type Scope = 'user' | 'agent' | 'global';
  const attempts: Array<{ scope: Scope; ownerId: string | null }> = [];
  attempts.push({ scope: 'user', ownerId: userId });
  if (ctx.agentId !== undefined && ctx.agentId !== '') {
    attempts.push({ scope: 'agent', ownerId: ctx.agentId });
  }
  attempts.push({ scope: 'global', ownerId: null });

  for (const a of attempts) {
    const got = await bus.call<
      { scope: Scope; ownerId: string | null; ref: string },
      { blob: Uint8Array | undefined }
    >('credentials:store-blob:get', ctx, { scope: a.scope, ownerId: a.ownerId, ref });
    if (got.blob === undefined) continue;
    const env = unwrapEnvelope(got.blob);
    if (env.isTombstone) continue; // tombstone in this scope; try next
    // Resolve via per-kind sub-service (existing logic).
    const subService = `credentials:resolve:${env.kind}`;
    if (bus.hasService(subService)) {
      const out = await bus.call<CredentialsResolveInput, CredentialsResolveOutput>(
        subService, ctx, { payload: env.payload, userId, ref });
      if (out.refreshed !== undefined) {
        const refreshArgs: CredentialsSetInput = {
          scope: a.scope,
          ownerId: a.ownerId,
          ref, kind: env.kind,
          payload: out.refreshed.payload,
        };
        if (out.refreshed.expiresAt !== undefined) refreshArgs.expiresAt = out.refreshed.expiresAt;
        const md = out.refreshed.metadata ?? env.metadata;
        if (md !== undefined) refreshArgs.metadata = md;
        await bus.call('credentials:set', ctx, refreshArgs);
      }
      return out.value;
    }
    if (env.kind === 'api-key') return new TextDecoder().decode(env.payload);
    throw new PluginError({
      code: 'unsupported-credential-kind', plugin: PLUGIN_NAME,
      message: `no resolver registered for credential kind '${env.kind}' (ref='${ref}')`,
    });
  }
  // None of the v2 scopes had it. Try envFallback.
  const envName = envFallback[ref];
  if (envName !== undefined) {
    const v = process.env[envName];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  throw new PluginError({
    code: 'credential-not-found', plugin: PLUGIN_NAME,
    message: `no credential for ref='${ref}'`,
  });
}
```

Note: the per-(userId, ref) mutex in the existing code stays — adjust it to key off the resolved attempt's scope+ownerId+ref to avoid collisions across scopes.

- [ ] **Step 4: Run; verify PASS**

Run: `pnpm --filter @ax/credentials test`
Expected: all credentials tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/credentials
git commit -m "feat(credentials): user>agent>global resolution precedence in get()"
```

---

### Task 1.5: Add `credentials:list` and `credentials:list-kinds`

**Files:**
- Modify: `packages/credentials/src/plugin.ts` (new services)
- Test: `packages/credentials/src/__tests__/list.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// packages/credentials/src/__tests__/list.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { bootstrap, HookBus, makeAgentContext } from '@ax/core';
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '../plugin.js';

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('credentials:list + credentials:list-kinds', () => {
  beforeEach(() => { process.env.AX_CREDENTIALS_KEY = KEY; });

  async function makeBus() {
    const bus = new HookBus();
    await bootstrap({ bus, plugins: [
      createStorageSqlitePlugin({ path: ':memory:' }),
      createCredentialsStoreDbPlugin(),
      createCredentialsPlugin(),
    ]});
    return bus;
  }

  it('list returns metadata only — no payload field', async () => {
    const bus = await makeBus();
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'admin' });
    await bus.call('credentials:set', ctx, {
      scope: 'global', ownerId: null, ref: 'anthropic', kind: 'api-key',
      payload: new TextEncoder().encode('SECRET-DO-NOT-LEAK'),
    });
    const out = await bus.call('credentials:list', ctx, {}) as { credentials: any[] };
    expect(out.credentials).toHaveLength(1);
    const e = out.credentials[0];
    expect(e.scope).toBe('global');
    expect(e.ownerId).toBeNull();
    expect(e.ref).toBe('anthropic');
    expect(e.kind).toBe('api-key');
    expect(typeof e.createdAt).toBe('string');
    expect(e).not.toHaveProperty('payload');
    expect(e).not.toHaveProperty('blob');
    // Sanity: serialized JSON must not contain the secret.
    expect(JSON.stringify(out)).not.toContain('SECRET-DO-NOT-LEAK');
  });

  it('list filters by scope', async () => {
    const bus = await makeBus();
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'alice' });
    await bus.call('credentials:set', ctx, { scope: 'global', ownerId: null, ref: 'g', kind: 'api-key', payload: new Uint8Array([1]) });
    await bus.call('credentials:set', ctx, { scope: 'user', ownerId: 'alice', ref: 'u', kind: 'api-key', payload: new Uint8Array([2]) });
    const all = (await bus.call('credentials:list', ctx, {}) as { credentials: any[] }).credentials;
    expect(all).toHaveLength(2);
    const userOnly = (await bus.call('credentials:list', ctx, { scope: 'user', ownerId: 'alice' }) as { credentials: any[] }).credentials;
    expect(userOnly.map(e => e.ref)).toEqual(['u']);
  });

  it('list-kinds reports api-key always; oauth kinds when their plugin loaded', async () => {
    const bus = await makeBus();
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'admin' });
    const out = await bus.call('credentials:list-kinds', ctx, {}) as { kinds: Array<{ kind: string; flow: string }> };
    expect(out.kinds.find(k => k.kind === 'api-key')).toBeDefined();
    // No anthropic-oauth plugin loaded in this test bus, so it should NOT appear.
    expect(out.kinds.find(k => k.kind === 'anthropic-oauth')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run; verify FAIL**

Run: `pnpm --filter @ax/credentials test list`
Expected: FAIL — services don't exist.

- [ ] **Step 3: Implement the new services**

In `packages/credentials/src/plugin.ts`, add these exports near the top:

```ts
export interface CredentialsListInput {
  scope?: CredentialScope;
  ownerId?: string | null;
}
export interface CredentialMeta {
  scope: CredentialScope;
  ownerId: string | null;
  ref: string;
  kind: string;
  createdAt: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}
export interface CredentialsListOutput {
  credentials: CredentialMeta[];
}
export interface CredentialsListKindsOutput {
  kinds: Array<{ kind: string; flow: 'paste' | 'oauth' }>;
}
```

Update the manifest:
```ts
registers: ['credentials:get', 'credentials:set', 'credentials:delete',
            'credentials:list', 'credentials:list-kinds'],
calls: ['credentials:store-blob:get', 'credentials:store-blob:put',
        'credentials:store-blob:list'],
```

Inside `init({ bus })`, after the existing handlers:

```ts
bus.registerService<CredentialsListInput, CredentialsListOutput>(
  'credentials:list', PLUGIN_NAME,
  async (ctx, input) => {
    const filter: { scope?: CredentialScope; ownerId?: string | null } = {};
    if (input.scope !== undefined) filter.scope = validateScope(input.scope);
    if (input.ownerId !== undefined && filter.scope !== undefined) {
      filter.ownerId = validateOwnerIdForScope(filter.scope, input.ownerId);
    }
    const out = await bus.call<typeof filter, { entries: Array<{ scope: CredentialScope; ownerId: string | null; ref: string; blob: Uint8Array }> }>(
      'credentials:store-blob:list', ctx, filter);
    const meta: CredentialMeta[] = [];
    for (const e of out.entries) {
      try {
        const env = unwrapEnvelope(e.blob);
        if (env.isTombstone) continue;
        const m: CredentialMeta = {
          scope: e.scope,
          ownerId: e.ownerId,
          ref: e.ref,
          kind: env.kind,
          createdAt: new Date().toISOString(), // store doesn't track createdAt yet — see Task 1.7 follow-up
        };
        if (env.expiresAt !== undefined) m.expiresAt = new Date(env.expiresAt).toISOString();
        if (env.metadata !== undefined) m.metadata = env.metadata;
        meta.push(m);
      } catch {
        // Skip undecryptable blobs (different AX_CREDENTIALS_KEY) silently.
      }
    }
    return { credentials: meta };
  },
);

bus.registerService<{}, CredentialsListKindsOutput>(
  'credentials:list-kinds', PLUGIN_NAME,
  async () => {
    const kinds: Array<{ kind: string; flow: 'paste' | 'oauth' }> = [
      { kind: 'api-key', flow: 'paste' },
    ];
    // Discover OAuth kinds by introspecting registered services.
    const svcs = bus.listServices();
    const prefix = 'credentials:login:';
    for (const svc of svcs) {
      if (svc.startsWith(prefix)) {
        kinds.push({ kind: svc.slice(prefix.length), flow: 'oauth' });
      }
    }
    return { kinds };
  },
);
```

NOTE on `createdAt`: store-blob layer doesn't track creation time today. Filed as a follow-up in Task 1.7 — for MVP, return `new Date().toISOString()` so the wire shape is non-empty; the Phase F canary doesn't depend on the exact value.

- [ ] **Step 4: Run; verify PASS**

Run: `pnpm --filter @ax/credentials test list`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add packages/credentials
git commit -m "feat(credentials): add list + list-kinds (metadata only, no plaintext)"
```

---

### Task 1.6: Update CLI to pass scope/ownerId; add `migrate` subcommand

**Files:**
- Modify: `packages/cli/src/commands/credentials.ts`
- Test: `packages/cli/src/__tests__/credentials-set.test.ts` (existing — update assertions)
- Test: `packages/cli/src/__tests__/credentials-migrate.test.ts` (new)

- [ ] **Step 1: Update existing CLI callers to include scope='user'/ownerId=CLI_USER_ID**

In `packages/cli/src/commands/credentials.ts`:

Search for all `bus.call('credentials:set', ...)` calls. For each, change the body to include:
```ts
scope: 'user', ownerId: CLI_USER_ID,
```
plus the existing `userId: CLI_USER_ID` (kept for `credentials:get` compatibility).

Run existing tests to confirm no regression:
```bash
pnpm --filter @ax/cli test credentials
```

- [ ] **Step 2: Write the failing migrate test**

```ts
// packages/cli/src/__tests__/credentials-migrate.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCredentialsCommand } from '../commands/credentials.js';
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '@ax/credentials';
import { bootstrap, HookBus, makeAgentContext } from '@ax/core';

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('ax-next credentials migrate', () => {
  beforeEach(() => { process.env.AX_CREDENTIALS_KEY = KEY; });

  it('copies v1 keys to v2 with scope=user', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ax-cred-mig-'));
    const dbPath = join(dir, 'db.sqlite');

    // Seed a v1 row by writing through the OLD API shape (storage:set directly).
    {
      const bus = new HookBus();
      await bootstrap({ bus, plugins: [createStorageSqlitePlugin({ path: dbPath })] });
      const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'cli' });
      // Use a minimal "encrypted" envelope — for the migrate test we don't decrypt; we just copy bytes.
      await bus.call('storage:set', ctx, { key: 'credential:cli:legacy-ref', value: new Uint8Array([0xde, 0xad, 0xbe, 0xef]) });
    }

    const lines: string[] = [];
    const code = await runCredentialsCommand({
      argv: ['migrate', '--yes'],
      stdin: (async function* () {})(),
      stdout: (l) => lines.push(l),
      stderr: (l) => lines.push(l),
      sqlitePath: dbPath,
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toMatch(/migrated 1 credential/i);

    // Verify v2 row exists with same bytes.
    const bus = new HookBus();
    await bootstrap({ bus, plugins: [createStorageSqlitePlugin({ path: dbPath })] });
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'cli' });
    const v2 = await bus.call('storage:get', ctx, { key: 'credential:v2:user:cli:legacy-ref' });
    expect((v2 as { value: Uint8Array | undefined }).value).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });
});
```

- [ ] **Step 3: Run; verify FAIL**

Run: `pnpm --filter @ax/cli test credentials-migrate`
Expected: FAIL — `migrate` subcommand doesn't exist.

- [ ] **Step 4: Implement `migrate` subcommand**

In `packages/cli/src/commands/credentials.ts`, in the `runCredentialsCommand` switch:

```ts
if (verb === 'migrate') {
  return runMigrateCommand(opts, out, err);
}
```

Add the function:
```ts
async function runMigrateCommand(
  opts: RunCredentialsOptions,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const bus = new HookBus();
  await bootstrap({ bus, plugins: [createStorageSqlitePlugin({ path: opts.sqlitePath ?? DEFAULT_SQLITE_PATH })] });
  const ctx = makeAgentContext({ sessionId: 'cli', agentId: 'cli', userId: CLI_USER_ID });

  // Find v1 keys.
  const list = await bus.call<{ prefix: string }, { entries: Array<{ key: string; value: Uint8Array }> }>(
    'storage:list-prefix', ctx, { prefix: 'credential:' });
  const v1Entries = list.entries.filter((e) => !e.key.startsWith('credential:v2:'));
  if (v1Entries.length === 0) {
    out('no v1 credentials found; nothing to migrate');
    return 0;
  }

  // Confirm unless --yes.
  if (!opts.argv.includes('--yes')) {
    err(`would migrate ${v1Entries.length} credentials. Re-run with --yes to proceed.`);
    return 1;
  }

  let migrated = 0;
  for (const e of v1Entries) {
    // Key shape: credential:${userId}:${ref} — split on first colon after prefix.
    const rest = e.key.slice('credential:'.length);
    const colon = rest.indexOf(':');
    if (colon < 0) continue;
    const userId = rest.slice(0, colon);
    const ref = rest.slice(colon + 1);
    const newKey = `credential:v2:user:${userId}:${ref}`;
    await bus.call('storage:set', ctx, { key: newKey, value: e.value });
    migrated++;
  }
  out(`migrated ${migrated} credentials from v1 to v2 (scope=user)`);
  out('v1 keys are still present and readable as a fallback. Remove them only after verifying the migration with `ax-next credentials migrate --tombstone-v1`.');
  return 0;
}
```

(The `--tombstone-v1` flag is left as a follow-up; document the manual `DELETE FROM kv WHERE key NOT LIKE 'credential:v2:%' AND key LIKE 'credential:%'` step in `MANUAL-ACCEPTANCE.md` Phase 7.)

Update USAGE string to include the new verb.

- [ ] **Step 5: Run tests + commit**

Run: `pnpm --filter @ax/cli test`
Expected: PASS.

```bash
git add packages/cli
git commit -m "feat(cli): pass scope=user on set; add `credentials migrate` subcommand"
```

---

### Task 1.7: Add createdAt tracking to store-blob

**Files:**
- Modify: `packages/credentials-store-db/src/plugin.ts` (envelope wrapper to include createdAt)
- Modify: `packages/credentials/src/plugin.ts` (envelope: include createdAt; expose in unwrap output)
- Test: `packages/credentials/src/__tests__/list.test.ts` (extend existing tests)

- [ ] **Step 1: Extend the envelope to carry createdAt**

In `packages/credentials/src/plugin.ts`, update `wrapEnvelope` to include `createdAt: Date.now()` if not already present (callers don't pass it; the facade stamps it). Update `unwrapEnvelope` to return `createdAt`. Update `CredentialMeta` rendering in `credentials:list` to use `env.createdAt`.

```ts
function wrapEnvelope(
  kind: string,
  payload: Uint8Array,
  expiresAt: number | undefined,
  metadata: Record<string, unknown> | undefined,
  createdAt: number,
): Uint8Array {
  const env: { kind: string; payloadB64: string; createdAt: number; expiresAt?: number; metadata?: Record<string, unknown> } = {
    kind,
    payloadB64: Buffer.from(payload).toString('base64'),
    createdAt,
  };
  if (expiresAt !== undefined) env.expiresAt = expiresAt;
  if (metadata !== undefined) env.metadata = metadata;
  return encryptWithKey(key, JSON.stringify(env));
}
```

In the `set` handler, pass `Date.now()` as `createdAt`. In `unwrapEnvelope`, parse `createdAt` and return it (preserve backward-compat: if missing, default to 0 → renders as 1970 — flagged once in audit-log when migrated v1 rows surface).

- [ ] **Step 2: Update the list test to assert createdAt round-trips**

```ts
it('list returns createdAt from the envelope', async () => {
  const bus = await makeBus();
  const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'admin' });
  const before = Date.now();
  await bus.call('credentials:set', ctx, { scope: 'global', ownerId: null, ref: 'k', kind: 'api-key', payload: new Uint8Array([1]) });
  const after = Date.now();
  const out = await bus.call('credentials:list', ctx, {}) as { credentials: Array<{ createdAt: string }> };
  const ts = Date.parse(out.credentials[0].createdAt);
  expect(ts).toBeGreaterThanOrEqual(before);
  expect(ts).toBeLessThanOrEqual(after);
});
```

- [ ] **Step 3: Run; verify PASS**

Run: `pnpm --filter @ax/credentials test list`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/credentials
git commit -m "feat(credentials): persist createdAt in envelope; surface in list metadata"
```

---

### Task 1.8: Phase 1 final integration — run full test suite + commit

- [ ] **Step 1: Run all tests across affected packages**

Run: `pnpm test --filter @ax/credentials --filter @ax/credentials-store-db --filter @ax/storage-sqlite --filter @ax/storage-postgres --filter @ax/cli`
Expected: all PASS.

- [ ] **Step 2: Run `pnpm build`**

Run: `pnpm build`
Expected: type-check + build clean across the monorepo.

- [ ] **Step 3: Update PR description with Phase 1 boundary review**

The PR notes go in the commit body or a `docs/plans/` doc — see precedent at `docs/plans/2026-04-25-week-9.5-pr-notes.md`. Include:
- Hooks added: `credentials:list`, `credentials:list-kinds`, `credentials:store-blob:list`, `storage:list-prefix`
- Field names: scope/ownerId/ref/kind — domain vocab; no leakage
- Subscriber risk: none (service-only)
- Half-wired: none — CLI is the bottom-of-stack consumer; `credentials:list` is consumed by Phase 2's HTTP routes (declared in the PR description)

- [ ] **Step 4: Open PR**

Branch name: `feat/credentials-scope-axis`
PR title: `feat(credentials): scope axis (global/user/agent) + list/list-kinds + v2 keys`

---

## PHASE 2 — HTTP admin routes (CRUD only, no OAuth)

**Outcome:** New `@ax/credentials-admin-routes` plugin mounts `/admin/credentials*` and `/settings/credentials*` (CRUD only, no OAuth start/finish yet). Loaded in k8s preset and chart wiring done. Acceptance test against the k8s helpers proves admin can create / list / delete a global api-key.

**PR title:** `feat(credentials-admin-routes): /admin/credentials* and /settings/credentials* CRUD`

### Task 2.1: Scaffold `@ax/credentials-admin-routes` package

**Files:**
- Create: `packages/credentials-admin-routes/package.json`
- Create: `packages/credentials-admin-routes/tsconfig.json`
- Create: `packages/credentials-admin-routes/src/index.ts`
- Create: `packages/credentials-admin-routes/src/plugin.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@ax/credentials-admin-routes",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" } },
  "scripts": { "build": "tsc -b", "test": "vitest run" },
  "dependencies": {
    "@ax/core": "workspace:*",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@ax/credentials": "workspace:*",
    "@ax/credentials-store-db": "workspace:*",
    "@ax/storage-sqlite": "workspace:*",
    "@types/node": "^22.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json (mirror the agents tsconfig)**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "./dist", "rootDir": "./src" },
  "references": [
    { "path": "../core" }
  ],
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create the plugin skeleton**

`packages/credentials-admin-routes/src/index.ts`:
```ts
export { createCredentialsAdminRoutesPlugin } from './plugin.js';
```

`packages/credentials-admin-routes/src/plugin.ts`:
```ts
import { type Plugin, makeAgentContext } from '@ax/core';
import { registerAdminCredentialsRoutes } from './admin-routes.js';
import { registerSettingsCredentialsRoutes } from './settings-routes.js';

const PLUGIN_NAME = '@ax/credentials-admin-routes';

export function createCredentialsAdminRoutesPlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [],
      calls: [
        'auth:require-user',
        'http:register-route',
        'credentials:list',
        'credentials:set',
        'credentials:delete',
        'credentials:list-kinds',
      ],
      subscribes: [],
    },
    async init({ bus }) {
      const ctx = makeAgentContext({ sessionId: 'credentials-admin', agentId: PLUGIN_NAME, userId: 'admin' });
      const unregisters: Array<() => void> = [];
      unregisters.push(...await registerAdminCredentialsRoutes(bus, ctx));
      unregisters.push(...await registerSettingsCredentialsRoutes(bus, ctx));
      // Stash unregisters on a closed-over variable; expose via shutdown.
      return { async shutdown() { for (const u of unregisters) u(); } };
    },
  };
}
```

- [ ] **Step 4: Add to root `pnpm-workspace.yaml` if not auto-discovered (it should be)**

- [ ] **Step 5: Commit scaffolding**

```bash
git add packages/credentials-admin-routes
git commit -m "scaffold(credentials-admin-routes): empty plugin"
```

---

### Task 2.2: Implement admin route handlers (CRUD only)

**Files:**
- Create: `packages/credentials-admin-routes/src/admin-routes.ts`
- Create: `packages/credentials-admin-routes/src/shared.ts` (route helpers shared with settings)
- Test: `packages/credentials-admin-routes/src/__tests__/admin-handlers.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/credentials-admin-routes/src/__tests__/admin-handlers.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { bootstrap, HookBus, makeAgentContext } from '@ax/core';
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '@ax/credentials';
import { createAdminCredentialsHandlers, type RouteRequest, type RouteResponse } from '../admin-routes.js';

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function mkRes() {
  let _status = 200;
  let _body: unknown = undefined;
  return {
    res: {
      status(n: number) { _status = n; return this; },
      json(v: unknown) { _body = v; },
      text(s: string) { _body = s; },
      end() {},
    } as RouteResponse,
    statusOf: () => _status,
    bodyOf: () => _body,
  };
}

function mkReq(opts: { body?: unknown; isAdmin: boolean; userId?: string; params?: Record<string, string> }): RouteRequest {
  return {
    headers: {},
    body: Buffer.from(opts.body === undefined ? '' : JSON.stringify(opts.body)),
    cookies: {},
    query: {},
    params: opts.params ?? {},
    signedCookie: () => null,
  } as RouteRequest;
}

describe('admin credentials handlers', () => {
  beforeEach(() => { process.env.AX_CREDENTIALS_KEY = KEY; });

  async function makeBus(authedUser: { id: string; isAdmin: boolean }) {
    const bus = new HookBus();
    await bootstrap({ bus, plugins: [
      createStorageSqlitePlugin({ path: ':memory:' }),
      createCredentialsStoreDbPlugin(),
      createCredentialsPlugin(),
    ]});
    bus.registerService('auth:require-user', 'test', async () => ({ user: authedUser }));
    return bus;
  }

  it('non-admin gets 403 on POST /admin/credentials', async () => {
    const bus = await makeBus({ id: 'alice', isAdmin: false });
    const handlers = createAdminCredentialsHandlers({ bus });
    const { res, statusOf } = mkRes();
    await handlers.create(mkReq({ body: { scope: 'global', ownerId: null, ref: 'k', kind: 'api-key', payload: 'eA==' } }), res);
    expect(statusOf()).toBe(403);
  });

  it('admin can POST a global api-key credential', async () => {
    const bus = await makeBus({ id: 'admin', isAdmin: true });
    const handlers = createAdminCredentialsHandlers({ bus });
    const { res, statusOf, bodyOf } = mkRes();
    await handlers.create(mkReq({ body: { scope: 'global', ownerId: null, ref: 'anthropic-api-key', kind: 'api-key', payload: Buffer.from('sk-test').toString('base64') } }), res);
    expect(statusOf()).toBe(201);
    expect(bodyOf()).toMatchObject({ credential: { scope: 'global', ownerId: null, ref: 'anthropic-api-key', kind: 'api-key' } });
  });

  it('GET /admin/credentials returns metadata only', async () => {
    const bus = await makeBus({ id: 'admin', isAdmin: true });
    await bus.call('credentials:set', makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'admin' }), {
      scope: 'global', ownerId: null, ref: 'k', kind: 'api-key', payload: new TextEncoder().encode('SHHH'),
    });
    const handlers = createAdminCredentialsHandlers({ bus });
    const { res, statusOf, bodyOf } = mkRes();
    await handlers.list(mkReq({}), res);
    expect(statusOf()).toBe(200);
    const body = bodyOf() as { credentials: any[] };
    expect(body.credentials).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain('SHHH');
  });

  it('rejects body > 64 KiB', async () => {
    const bus = await makeBus({ id: 'admin', isAdmin: true });
    const handlers = createAdminCredentialsHandlers({ bus });
    const { res, statusOf } = mkRes();
    const req: RouteRequest = mkReq({});
    (req as any).body = Buffer.alloc(65 * 1024); // > 64 KiB
    await handlers.create(req, res);
    expect(statusOf()).toBe(413);
  });

  it('rejects scope=global with non-null ownerId at the route layer', async () => {
    const bus = await makeBus({ id: 'admin', isAdmin: true });
    const handlers = createAdminCredentialsHandlers({ bus });
    const { res, statusOf, bodyOf } = mkRes();
    await handlers.create(mkReq({ body: { scope: 'global', ownerId: 'alice', ref: 'k', kind: 'api-key', payload: 'eA==' } }), res);
    expect(statusOf()).toBe(400);
    expect((bodyOf() as { error: string }).error).toMatch(/ownerId must be null/);
  });

  it('DELETE /admin/credentials/:scope/:ownerId/:ref returns 204', async () => {
    const bus = await makeBus({ id: 'admin', isAdmin: true });
    await bus.call('credentials:set', makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'admin' }), {
      scope: 'user', ownerId: 'alice', ref: 'k', kind: 'api-key', payload: new Uint8Array([1]),
    });
    const handlers = createAdminCredentialsHandlers({ bus });
    const { res, statusOf } = mkRes();
    await handlers.destroy(mkReq({ params: { scope: 'user', ownerId: 'alice', ref: 'k' } }), res);
    expect(statusOf()).toBe(204);
  });
});
```

- [ ] **Step 2: Run; verify FAIL**

Run: `pnpm --filter @ax/credentials-admin-routes test admin-handlers`
Expected: FAIL — handlers don't exist.

- [ ] **Step 3: Implement `admin-routes.ts`**

(Mirror `packages/agents/src/admin-routes.ts` structure.)

```ts
// packages/credentials-admin-routes/src/admin-routes.ts
import { isRejection, makeAgentContext, PluginError, type AgentContext, type HookBus } from '@ax/core';
import { z } from 'zod';

export const ADMIN_BODY_MAX_BYTES = 64 * 1024;
const PLUGIN_NAME = '@ax/credentials-admin-routes';

export interface RouteRequest {
  readonly headers: Record<string, string>;
  readonly body: Buffer;
  readonly cookies: Record<string, string>;
  readonly query: Record<string, string>;
  readonly params: Record<string, string>;
  signedCookie(name: string): string | null;
}
export interface RouteResponse {
  status(n: number): RouteResponse;
  json(v: unknown): void;
  text(s: string): void;
  end(): void;
}

const REF_RE = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
const KIND_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const OWNER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/;

const createBodySchema = z.object({
  scope: z.enum(['global', 'user', 'agent']),
  ownerId: z.string().regex(OWNER_ID_RE).nullable(),
  ref: z.string().regex(REF_RE),
  kind: z.string().regex(KIND_RE),
  payload: z.string().min(1),                  // base64
  expiresAt: z.number().int().positive().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict().superRefine((v, ctx) => {
  if (v.scope === 'global' && v.ownerId !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "ownerId must be null when scope='global'", path: ['ownerId'] });
  if ((v.scope === 'user' || v.scope === 'agent') && v.ownerId === null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `ownerId is required when scope='${v.scope}'`, path: ['ownerId'] });
});

async function requireAdmin(bus: HookBus, ctx: AgentContext, req: RouteRequest, res: RouteResponse): Promise<{ id: string; isAdmin: boolean } | null> {
  try {
    const result = await bus.call<{ req: RouteRequest }, { user: { id: string; isAdmin: boolean } }>('auth:require-user', ctx, { req });
    if (!result.user.isAdmin) {
      res.status(403).json({ error: 'forbidden' });
      return null;
    }
    return result.user;
  } catch (err) {
    if (err instanceof PluginError || isRejection(err)) {
      res.status(401).json({ error: 'unauthenticated' });
      return null;
    }
    throw err;
  }
}

function writeServiceError(res: RouteResponse, err: unknown): boolean {
  if (err instanceof PluginError) {
    if (err.code === 'forbidden') { res.status(403).json({ error: 'forbidden' }); return true; }
    if (err.code === 'not-found' || err.code === 'credential-not-found') { res.status(404).json({ error: 'not-found' }); return true; }
    if (err.code === 'invalid-payload') { res.status(400).json({ error: err.message }); return true; }
  }
  return false;
}

interface Deps { bus: HookBus }

export function createAdminCredentialsHandlers(deps: Deps) {
  const ctx = makeAgentContext({ sessionId: 'credentials-admin', agentId: PLUGIN_NAME, userId: 'admin' });
  return {
    async list(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireAdmin(deps.bus, ctx, req, res);
      if (!actor) return;
      const out = await deps.bus.call<{}, { credentials: unknown[] }>('credentials:list', ctx, {});
      res.status(200).json(out);
    },

    async create(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireAdmin(deps.bus, ctx, req, res);
      if (!actor) return;
      if (req.body.length > ADMIN_BODY_MAX_BYTES) { res.status(413).json({ error: 'body-too-large' }); return; }
      let raw: unknown;
      try { raw = req.body.length === 0 ? {} : JSON.parse(req.body.toString('utf8')); } catch { res.status(400).json({ error: 'invalid-json' }); return; }
      const parsed = createBodySchema.safeParse(raw);
      if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid-payload' }); return; }
      let payload: Uint8Array;
      try { payload = new Uint8Array(Buffer.from(parsed.data.payload, 'base64')); } catch { res.status(400).json({ error: 'invalid-payload' }); return; }
      try {
        await deps.bus.call('credentials:set', ctx, {
          scope: parsed.data.scope, ownerId: parsed.data.ownerId, ref: parsed.data.ref, kind: parsed.data.kind, payload,
          ...(parsed.data.expiresAt !== undefined ? { expiresAt: parsed.data.expiresAt } : {}),
          ...(parsed.data.metadata !== undefined ? { metadata: parsed.data.metadata } : {}),
        });
        // Echo metadata-only back.
        res.status(201).json({ credential: {
          scope: parsed.data.scope, ownerId: parsed.data.ownerId, ref: parsed.data.ref, kind: parsed.data.kind,
          createdAt: new Date().toISOString(),
          ...(parsed.data.expiresAt !== undefined ? { expiresAt: new Date(parsed.data.expiresAt).toISOString() } : {}),
          ...(parsed.data.metadata !== undefined ? { metadata: parsed.data.metadata } : {}),
        } });
      } catch (err) { if (writeServiceError(res, err)) return; throw err; }
    },

    async destroy(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireAdmin(deps.bus, ctx, req, res);
      if (!actor) return;
      const { scope, ownerId, ref } = req.params;
      if (!scope || !ownerId || !ref) { res.status(400).json({ error: 'missing-params' }); return; }
      const ownerIdResolved = ownerId === '_' ? null : ownerId;
      try {
        await deps.bus.call('credentials:delete', ctx, { scope: scope as 'global'|'user'|'agent', ownerId: ownerIdResolved, ref });
        res.status(204).end();
      } catch (err) { if (writeServiceError(res, err)) return; throw err; }
    },
  };
}

export async function registerAdminCredentialsRoutes(bus: HookBus, initCtx: AgentContext): Promise<Array<() => void>> {
  const handlers = createAdminCredentialsHandlers({ bus });
  const routes: Array<{ method: 'GET'|'POST'|'DELETE'; path: string; handler: (req: RouteRequest, res: RouteResponse) => Promise<void> }> = [
    { method: 'GET', path: '/admin/credentials', handler: handlers.list },
    { method: 'POST', path: '/admin/credentials', handler: handlers.create },
    { method: 'DELETE', path: '/admin/credentials/:scope/:ownerId/:ref', handler: handlers.destroy },
  ];
  const unregisters: Array<() => void> = [];
  for (const route of routes) {
    const result = await bus.call<unknown, { unregister: () => void }>('http:register-route', initCtx, route);
    unregisters.push(result.unregister);
  }
  return unregisters;
}
```

- [ ] **Step 4: Run; verify PASS**

Run: `pnpm --filter @ax/credentials-admin-routes test admin-handlers`
Expected: PASS (6/6).

- [ ] **Step 5: Commit**

```bash
git add packages/credentials-admin-routes
git commit -m "feat(credentials-admin-routes): /admin/credentials* CRUD handlers"
```

---

### Task 2.3: Implement settings route handlers (user-only)

**Files:**
- Create: `packages/credentials-admin-routes/src/settings-routes.ts`
- Test: `packages/credentials-admin-routes/src/__tests__/settings-handlers.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/credentials-admin-routes/src/__tests__/settings-handlers.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { bootstrap, HookBus, makeAgentContext } from '@ax/core';
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '@ax/credentials';
import { createSettingsCredentialsHandlers } from '../settings-routes.js';

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

// (mkReq/mkRes helpers — copy from admin-handlers test)

describe('settings credentials handlers', () => {
  beforeEach(() => { process.env.AX_CREDENTIALS_KEY = KEY; });

  it('any authed user can POST a credential to their own bag', async () => {
    /* bootstrap; bus.registerService('auth:require-user', ...) returning {id:'alice', isAdmin:false}; */
    /* call handlers.create with body {ref, kind, payload}; assert 201 + scope='user' + ownerId='alice' */
  });

  it('forces scope=user and ownerId=actor.id even if body tries to override', async () => {
    /* call create with body {scope:'global', ownerId:'admin', ref, kind, payload}; */
    /* expect 201 with scope='user', ownerId='alice' (body fields silently ignored) */
  });

  it('list filters to scope=user AND ownerId=actor.id', async () => {
    /* seed two creds: scope=global ownerId=null, scope=user ownerId='alice'; */
    /* call list as alice; expect only the alice user-cred */
  });

  it('DELETE /settings/credentials/:ref deletes the alice user-cred', async () => {
    /* seed alice's user-cred; call destroy with params.ref; expect 204 + alice no longer sees it */
  });
});
```

- [ ] **Step 2: Implement `settings-routes.ts`**

(Same shape as admin-routes but: `requireUser` instead of `requireAdmin`; force `scope='user'`, `ownerId=actor.id`; routes prefix `/settings/credentials*`.)

- [ ] **Step 3: Wire into the plugin's init**

Update `packages/credentials-admin-routes/src/plugin.ts` to call `registerSettingsCredentialsRoutes` (already in scaffolding).

- [ ] **Step 4: Run; verify PASS**

Run: `pnpm --filter @ax/credentials-admin-routes test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/credentials-admin-routes
git commit -m "feat(credentials-admin-routes): /settings/credentials* user-only handlers"
```

---

### Task 2.4: Wire `@ax/credentials-admin-routes` into k8s preset + chart

**Files:**
- Modify: `presets/k8s/src/index.ts`
- Modify: `presets/k8s/package.json` (add `@ax/credentials-admin-routes` dep)
- Modify: `deploy/charts/ax-next/values.yaml`
- Modify: `deploy/charts/ax-next/templates/host/deployment.yaml`
- Test: `presets/k8s/src/__tests__/credentials-admin-loaded.test.ts` (new)

- [ ] **Step 1: Write the failing wiring test**

```ts
// presets/k8s/src/__tests__/credentials-admin-loaded.test.ts
import { describe, it, expect } from 'vitest';
import { createK8sPlugins, type K8sPresetConfig } from '../index.js';

describe('credentials-admin-routes loaded conditionally', () => {
  const baseCfg: K8sPresetConfig = { /* same as other tests in this file */ } as K8sPresetConfig;

  it('loads when cfg.credentialsAdmin === true', () => {
    const plugins = createK8sPlugins({ ...baseCfg, credentialsAdmin: true });
    expect(plugins.find(p => p.manifest.name === '@ax/credentials-admin-routes')).toBeDefined();
  });

  it('does NOT load when credentialsAdmin is undefined', () => {
    const plugins = createK8sPlugins(baseCfg);
    expect(plugins.find(p => p.manifest.name === '@ax/credentials-admin-routes')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Update the preset**

In `presets/k8s/src/index.ts`:

```ts
// Add to K8sPresetConfig:
export interface K8sPresetConfig {
  // ... existing fields
  /** When true, load @ax/credentials-admin-routes (mounts /admin/credentials* + /settings/credentials*). */
  credentialsAdmin?: boolean;
}

// In createK8sPlugins, add (after existing admin-routes plugins):
if (cfg.credentialsAdmin === true) {
  plugins.push(createCredentialsAdminRoutesPlugin());
}

// In loadK8sConfigFromEnv:
if ((process.env.AX_CREDENTIALS_ADMIN_ENABLED ?? '').toLowerCase() === 'true') {
  cfg.credentialsAdmin = true;
}
```

Update the comment block at lines 387 / 563 / etc. to point to this design instead of "Phase 9.5 placeholder".

- [ ] **Step 3: Update the chart**

`deploy/charts/ax-next/values.yaml`:
```yaml
credentials:
  admin:
    # When true, mount /admin/credentials* (admin-only) and
    # /settings/credentials* (per-user) HTTP routes. Requires
    # AX_CREDENTIALS_KEY to be set on the host pod.
    enabled: false
```

`deploy/charts/ax-next/templates/host/deployment.yaml` — add to env list:
```yaml
{{- if .Values.credentials.admin.enabled }}
- name: AX_CREDENTIALS_ADMIN_ENABLED
  value: "true"
{{- end }}
```

- [ ] **Step 4: Run all tests**

Run: `pnpm test --filter '@ax/preset-k8s' --filter '@ax/credentials-admin-routes'`
Expected: PASS (the wiring test passes; no chart unit tests affected).

- [ ] **Step 5: Commit**

```bash
git add presets/k8s deploy/charts/ax-next
git commit -m "feat(preset-k8s): conditionally load @ax/credentials-admin-routes; chart values"
```

---

### Task 2.5: Phase 2 acceptance test in k8s preset

**Files:**
- Modify: `presets/k8s/src/__tests__/acceptance.test.ts` (extend Phase F section)
- Modify: `presets/k8s/src/__tests__/k8s-e2e/helpers.ts` (add `seedAdminCredential` helper)

- [ ] **Step 1: Add `seedAdminCredential` helper**

In `presets/k8s/src/__tests__/k8s-e2e/helpers.ts`:

```ts
export async function seedAdminCredential(opts: {
  scope: 'global' | 'user' | 'agent';
  ownerId: string | null;
  ref: string;
  kind: string;
  payload: string;
  bearerToken?: string;
}): Promise<void> {
  const res = await fetch(`${HOST_BASE_URL}/admin/credentials`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-requested-with': 'ax-admin',
      ...(opts.bearerToken ? { authorization: `Bearer ${opts.bearerToken}` } : {}),
    },
    body: JSON.stringify({
      scope: opts.scope,
      ownerId: opts.ownerId,
      ref: opts.ref,
      kind: opts.kind,
      payload: Buffer.from(opts.payload).toString('base64'),
    }),
  });
  if (!res.ok) throw new Error(`POST /admin/credentials failed: ${res.status} ${await res.text()}`);
}
```

- [ ] **Step 2: Add canary test for the round-trip**

In `presets/k8s/src/__tests__/acceptance.test.ts`, in the Phase F section, add a test:

```ts
it('Phase F: admin can create a global api-key via /admin/credentials and a session resolves it', async () => {
  await seedAdminCredential({ scope: 'global', ownerId: null, ref: 'anthropic-api-key', kind: 'api-key', payload: 'sk-test-via-admin' });
  // Run the existing canary chat flow; assert it succeeds (the LLM mock checks ANTHROPIC_API_KEY is the seeded value).
  // ... (reuse existing Phase F harness)
});
```

- [ ] **Step 3: Run acceptance tests**

Run: `pnpm --filter '@ax/preset-k8s' test acceptance`
Expected: PASS.

- [ ] **Step 4: Commit and open PR**

```bash
git add presets/k8s
git commit -m "test(preset-k8s/acceptance): admin /admin/credentials round-trip in Phase F canary"
```

Branch: `feat/credentials-admin-routes`
PR title: `feat(credentials-admin-routes): /admin/credentials* and /settings/credentials* CRUD`

PR body must include the Phase 2 boundary review (admin-routes-shape, ACL, error mapping) and explicit `Half-wired window: NONE — preset loads it, route tests + acceptance test prove end-to-end`.

---

## PHASE 3 — OAuth state-holder + paste-flow routes

**Outcome:** New `@ax/credentials-oauth-pending` plugin (in-memory, TTL+cap, userId-bound). `oauth/start` + `oauth/finish` routes added to credentials-admin-routes. End-to-end web-paste flow works against `@ax/credentials-anthropic-oauth` with stubbed exchange.

**PR title:** `feat(credentials-admin-routes): OAuth web-paste flow (start/finish) + pending state holder`

### Task 3.1: Scaffold `@ax/credentials-oauth-pending`

**Files:**
- Create: `packages/credentials-oauth-pending/{package.json,tsconfig.json,src/index.ts,src/plugin.ts,src/state.ts}`

- [ ] **Step 1: package.json + tsconfig (mirror Phase 2 scaffold)**

- [ ] **Step 2: Write the state.ts test FIRST**

```ts
// packages/credentials-oauth-pending/src/__tests__/state.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPendingStore } from '../state.js';

describe('PendingStore', () => {
  it('stash returns a pendingId; claim returns the entry', () => {
    const store = createPendingStore({ ttlMs: 60_000, capacity: 10 });
    const id = store.stash({ codeVerifier: 'v', state: 's', scope: 'user', ownerId: 'alice', ref: 'r', kind: 'k', userId: 'alice' });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(20);
    const entry = store.claim(id, 'alice');
    expect(entry).toMatchObject({ codeVerifier: 'v', state: 's' });
  });

  it('claim is single-use', () => {
    const store = createPendingStore({ ttlMs: 60_000, capacity: 10 });
    const id = store.stash({ codeVerifier: 'v', state: 's', scope: 'user', ownerId: 'alice', ref: 'r', kind: 'k', userId: 'alice' });
    expect(store.claim(id, 'alice')).toBeDefined();
    expect(store.claim(id, 'alice')).toBeUndefined();
  });

  it('claim with wrong userId returns undefined', () => {
    const store = createPendingStore({ ttlMs: 60_000, capacity: 10 });
    const id = store.stash({ codeVerifier: 'v', state: 's', scope: 'user', ownerId: 'alice', ref: 'r', kind: 'k', userId: 'alice' });
    expect(store.claim(id, 'bob')).toBeUndefined();
    // Original stash is consumed (defensive — no information leak about whether the id existed):
    expect(store.claim(id, 'alice')).toBeUndefined();
  });

  it('expired entries are not claimable', () => {
    vi.useFakeTimers();
    try {
      const store = createPendingStore({ ttlMs: 1000, capacity: 10 });
      const id = store.stash({ codeVerifier: 'v', state: 's', scope: 'user', ownerId: 'alice', ref: 'r', kind: 'k', userId: 'alice' });
      vi.advanceTimersByTime(1500);
      expect(store.claim(id, 'alice')).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });

  it('capacity overflow evicts oldest by expiresAt', () => {
    const store = createPendingStore({ ttlMs: 60_000, capacity: 2 });
    const id1 = store.stash({ codeVerifier: '1', state: 's', scope: 'user', ownerId: 'a', ref: 'r', kind: 'k', userId: 'a' });
    const id2 = store.stash({ codeVerifier: '2', state: 's', scope: 'user', ownerId: 'a', ref: 'r', kind: 'k', userId: 'a' });
    const id3 = store.stash({ codeVerifier: '3', state: 's', scope: 'user', ownerId: 'a', ref: 'r', kind: 'k', userId: 'a' });
    expect(store.claim(id1, 'a')).toBeUndefined(); // evicted
    expect(store.claim(id2, 'a')).toBeDefined();
    expect(store.claim(id3, 'a')).toBeDefined();
  });
});
```

- [ ] **Step 3: Implement `state.ts`**

```ts
// packages/credentials-oauth-pending/src/state.ts
import { randomBytes } from 'node:crypto';

export interface PendingEntryInput {
  codeVerifier: string;
  state: string;
  scope: 'global' | 'user' | 'agent';
  ownerId: string | null;
  ref: string;
  kind: string;
  userId: string;
}
export interface PendingEntry extends PendingEntryInput {
  expiresAt: number;
}

export interface PendingStore {
  stash(entry: PendingEntryInput): string;
  claim(pendingId: string, expectedUserId: string): PendingEntry | undefined;
}

export function createPendingStore(opts: { ttlMs: number; capacity: number }): PendingStore {
  const map = new Map<string, PendingEntry>();

  function evictExpired(now: number) {
    for (const [k, v] of map) if (v.expiresAt <= now) map.delete(k);
  }
  function evictOldestIfOverCapacity() {
    while (map.size >= opts.capacity) {
      let oldestKey: string | undefined;
      let oldestExp = Infinity;
      for (const [k, v] of map) if (v.expiresAt < oldestExp) { oldestExp = v.expiresAt; oldestKey = k; }
      if (oldestKey === undefined) break;
      map.delete(oldestKey);
    }
  }

  return {
    stash(entry) {
      const now = Date.now();
      evictExpired(now);
      evictOldestIfOverCapacity();
      const pendingId = randomBytes(32).toString('base64url');
      map.set(pendingId, { ...entry, expiresAt: now + opts.ttlMs });
      return pendingId;
    },
    claim(pendingId, expectedUserId) {
      const now = Date.now();
      evictExpired(now);
      const entry = map.get(pendingId);
      if (entry === undefined) return undefined;
      // Always consume on lookup — even on userId mismatch, to avoid timing/behavior oracles.
      map.delete(pendingId);
      if (entry.userId !== expectedUserId) return undefined;
      return entry;
    },
  };
}
```

- [ ] **Step 4: Implement the plugin wrapper**

```ts
// packages/credentials-oauth-pending/src/plugin.ts
import { type Plugin, PluginError } from '@ax/core';
import { createPendingStore, type PendingEntryInput } from './state.js';

const PLUGIN_NAME = '@ax/credentials-oauth-pending';

export function createCredentialsOauthPendingPlugin(opts: { ttlMs?: number; capacity?: number } = {}): Plugin {
  const store = createPendingStore({ ttlMs: opts.ttlMs ?? 5 * 60 * 1000, capacity: opts.capacity ?? 1000 });
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      // SINGLE-REPLICA ONLY: in-memory state means a different replica won't see
      // the pending entry. Multi-replica deployments need either (a) sticky
      // sessions for 5min, or (b) a DB-backed sibling plugin.
      registers: ['credentials:oauth:stash-pending', 'credentials:oauth:claim-pending'],
      calls: [],
      subscribes: [],
    },
    async init({ bus }) {
      bus.registerService<PendingEntryInput, { pendingId: string }>('credentials:oauth:stash-pending', PLUGIN_NAME, async (_ctx, input) => ({ pendingId: store.stash(input) }));
      bus.registerService<{ pendingId: string; expectedUserId: string }, { entry: PendingEntryInput | undefined }>(
        'credentials:oauth:claim-pending', PLUGIN_NAME,
        async (_ctx, input) => {
          if (typeof input.pendingId !== 'string' || typeof input.expectedUserId !== 'string') throw new PluginError({ code: 'invalid-payload', plugin: PLUGIN_NAME, message: 'pendingId and expectedUserId required' });
          const entry = store.claim(input.pendingId, input.expectedUserId);
          if (entry === undefined) return { entry: undefined };
          // Strip expiresAt before returning — caller doesn't need it.
          const { expiresAt: _e, ...rest } = entry;
          return { entry: rest };
        },
      );
    },
  };
}

export { type PendingEntryInput } from './state.js';
```

- [ ] **Step 5: Run tests + commit**

Run: `pnpm --filter '@ax/credentials-oauth-pending' test`
Expected: PASS.

```bash
git add packages/credentials-oauth-pending
git commit -m "feat(credentials-oauth-pending): in-memory PKCE state holder (TTL+cap+userId-bound)"
```

---

### Task 3.2: Add OAuth start/finish handlers to admin + settings routes

**Files:**
- Create: `packages/credentials-admin-routes/src/oauth-routes.ts` (shared between admin and settings flows)
- Modify: `admin-routes.ts` and `settings-routes.ts` to register the new routes
- Test: `packages/credentials-admin-routes/src/__tests__/oauth-flow.test.ts`

- [ ] **Step 1: Write the failing test (admin flow)**

```ts
// packages/credentials-admin-routes/src/__tests__/oauth-flow.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { bootstrap, HookBus, makeAgentContext } from '@ax/core';
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '@ax/credentials';
import { createCredentialsOauthPendingPlugin } from '@ax/credentials-oauth-pending';
import { createAdminOauthHandlers } from '../oauth-routes.js';
// ... mkReq/mkRes helpers

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('admin OAuth start/finish handlers', () => {
  beforeEach(() => { process.env.AX_CREDENTIALS_KEY = KEY; });

  async function makeBus(authedUser: { id: string; isAdmin: boolean }) {
    const bus = new HookBus();
    await bootstrap({ bus, plugins: [
      createStorageSqlitePlugin({ path: ':memory:' }),
      createCredentialsStoreDbPlugin(),
      createCredentialsPlugin(),
      createCredentialsOauthPendingPlugin(),
    ]});
    bus.registerService('auth:require-user', 'test', async () => ({ user: authedUser }));
    // Stub out per-kind login + exchange for 'fake-oauth'.
    bus.registerService('credentials:login:fake-oauth', 'test', async () => ({
      authorizeUrl: 'https://provider.example/auth?state=xyz',
      codeVerifier: 'verifier-xyz',
      state: 'xyz',
    }));
    bus.registerService('credentials:exchange:fake-oauth', 'test', async (_ctx, input: any) => {
      if (input.codeVerifier !== 'verifier-xyz') throw new Error('verifier mismatch');
      return { blob: new TextEncoder().encode('TOKEN-' + input.code), expiresAt: Date.now() + 3600_000, kind: 'fake-oauth' };
    });
    return bus;
  }

  it('admin start returns pendingId + authorizeUrl', async () => {
    const bus = await makeBus({ id: 'admin', isAdmin: true });
    const handlers = createAdminOauthHandlers({ bus });
    const { res, statusOf, bodyOf } = mkRes();
    await handlers.start(mkReq({ body: { scope: 'global', ownerId: null, ref: 'fake', kind: 'fake-oauth' } }), res);
    expect(statusOf()).toBe(200);
    const body = bodyOf() as { pendingId: string; authorizeUrl: string };
    expect(body.pendingId).toBeDefined();
    expect(body.authorizeUrl).toBe('https://provider.example/auth?state=xyz');
  });

  it('finish completes the round-trip and stores the credential', async () => {
    const bus = await makeBus({ id: 'admin', isAdmin: true });
    const handlers = createAdminOauthHandlers({ bus });
    const start = mkRes();
    await handlers.start(mkReq({ body: { scope: 'global', ownerId: null, ref: 'fake', kind: 'fake-oauth' } }), start.res);
    const { pendingId } = start.bodyOf() as { pendingId: string };
    const finish = mkRes();
    await handlers.finish(mkReq({ body: { pendingId, code: 'AUTH-CODE-123' } }), finish.res);
    expect(finish.statusOf()).toBe(201);
    // Verify the credential was set.
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
    const value = await bus.call('credentials:get', ctx, { ref: 'fake', userId: 'u' });
    expect(value).toBe('TOKEN-AUTH-CODE-123');
  });

  it('finish with unknown pendingId returns 410', async () => {
    const bus = await makeBus({ id: 'admin', isAdmin: true });
    const handlers = createAdminOauthHandlers({ bus });
    const { res, statusOf } = mkRes();
    await handlers.finish(mkReq({ body: { pendingId: 'nonexistent', code: 'x' } }), res);
    expect(statusOf()).toBe(410);
  });

  it('finish with wrong actor returns 410 (single-use)', async () => {
    const bus = await makeBus({ id: 'admin', isAdmin: true });
    const adminHandlers = createAdminOauthHandlers({ bus });
    const start = mkRes();
    await adminHandlers.start(mkReq({ body: { scope: 'global', ownerId: null, ref: 'fake', kind: 'fake-oauth' } }), start.res);
    const { pendingId } = start.bodyOf() as { pendingId: string };
    // Now simulate a different user trying to claim:
    bus.registerService('auth:require-user', 'test-evil', async () => ({ user: { id: 'eve', isAdmin: true } }));
    // (in real wiring requireAdmin would be called — so create handlers AFTER swapping the auth)
    const eveHandlers = createAdminOauthHandlers({ bus });
    const finish = mkRes();
    await eveHandlers.finish(mkReq({ body: { pendingId, code: 'x' } }), finish.res);
    expect(finish.statusOf()).toBe(410);
  });
});
```

- [ ] **Step 2: Implement `oauth-routes.ts`**

```ts
// packages/credentials-admin-routes/src/oauth-routes.ts
import { isRejection, makeAgentContext, PluginError, type AgentContext, type HookBus } from '@ax/core';
import { z } from 'zod';
import type { RouteRequest, RouteResponse } from './admin-routes.js';

const PLUGIN_NAME = '@ax/credentials-admin-routes';
const REF_RE = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
const KIND_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const OWNER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/;

const adminStartSchema = z.object({
  scope: z.enum(['global','user','agent']),
  ownerId: z.string().regex(OWNER_ID_RE).nullable(),
  ref: z.string().regex(REF_RE),
  kind: z.string().regex(KIND_RE),
}).strict();

const finishSchema = z.object({
  pendingId: z.string().min(20).max(64),
  code: z.string().min(1).max(2048),
}).strict();

export interface OauthDeps { bus: HookBus }

export function createAdminOauthHandlers(deps: OauthDeps) {
  const ctx = makeAgentContext({ sessionId: 'credentials-admin-oauth', agentId: PLUGIN_NAME, userId: 'admin' });

  async function authActor(req: RouteRequest, res: RouteResponse): Promise<{ id: string; isAdmin: boolean } | null> {
    try {
      const { user } = await deps.bus.call<{ req: RouteRequest }, { user: { id: string; isAdmin: boolean } }>('auth:require-user', ctx, { req });
      if (!user.isAdmin) { res.status(403).json({ error: 'forbidden' }); return null; }
      return user;
    } catch (err) {
      if (err instanceof PluginError || isRejection(err)) { res.status(401).json({ error: 'unauthenticated' }); return null; }
      throw err;
    }
  }

  return {
    async start(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await authActor(req, res); if (!actor) return;
      let raw: unknown; try { raw = JSON.parse(req.body.toString('utf8') || '{}'); } catch { res.status(400).json({ error: 'invalid-json' }); return; }
      const parsed = adminStartSchema.safeParse(raw);
      if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid-payload' }); return; }
      const loginService = `credentials:login:${parsed.data.kind}`;
      if (!deps.bus.hasService(loginService)) { res.status(400).json({ error: `unsupported kind: ${parsed.data.kind}` }); return; }
      const login = await deps.bus.call<unknown, { authorizeUrl: string; codeVerifier: string; state: string }>(loginService, ctx, {});
      const stash = await deps.bus.call<unknown, { pendingId: string }>('credentials:oauth:stash-pending', ctx, {
        codeVerifier: login.codeVerifier, state: login.state,
        scope: parsed.data.scope, ownerId: parsed.data.ownerId,
        ref: parsed.data.ref, kind: parsed.data.kind, userId: actor.id,
      });
      res.status(200).json({
        pendingId: stash.pendingId,
        authorizeUrl: login.authorizeUrl,
        instructions: 'Open the link, sign in, copy the code from the page, and paste it back here.',
      });
    },

    async finish(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await authActor(req, res); if (!actor) return;
      let raw: unknown; try { raw = JSON.parse(req.body.toString('utf8') || '{}'); } catch { res.status(400).json({ error: 'invalid-json' }); return; }
      const parsed = finishSchema.safeParse(raw);
      if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid-payload' }); return; }
      const claim = await deps.bus.call<unknown, { entry: any }>('credentials:oauth:claim-pending', ctx, { pendingId: parsed.data.pendingId, expectedUserId: actor.id });
      if (claim.entry === undefined) { res.status(410).json({ error: 'pending-expired-or-not-found' }); return; }
      const exchange = await deps.bus.call<unknown, { blob: Uint8Array; expiresAt?: number; kind: string }>(
        `credentials:exchange:${claim.entry.kind}`, ctx,
        { code: parsed.data.code, codeVerifier: claim.entry.codeVerifier, state: claim.entry.state });
      await deps.bus.call('credentials:set', ctx, {
        scope: claim.entry.scope, ownerId: claim.entry.ownerId,
        ref: claim.entry.ref, kind: exchange.kind, payload: exchange.blob,
        ...(exchange.expiresAt !== undefined ? { expiresAt: exchange.expiresAt } : {}),
      });
      res.status(201).json({ credential: {
        scope: claim.entry.scope, ownerId: claim.entry.ownerId,
        ref: claim.entry.ref, kind: exchange.kind,
        createdAt: new Date().toISOString(),
        ...(exchange.expiresAt !== undefined ? { expiresAt: new Date(exchange.expiresAt).toISOString() } : {}),
      } });
    },
  };
}

// createSettingsOauthHandlers: same shape but requireUser (any authed) + force scope='user' / ownerId=actor.id.
export function createSettingsOauthHandlers(deps: OauthDeps) { /* analogous, omitted for brevity — mirror admin */ }

export async function registerOauthRoutes(bus: HookBus, ctx: AgentContext): Promise<Array<() => void>> {
  const admin = createAdminOauthHandlers({ bus });
  const settings = createSettingsOauthHandlers({ bus });
  const routes = [
    { method: 'POST', path: '/admin/credentials/oauth/start', handler: admin.start },
    { method: 'POST', path: '/admin/credentials/oauth/finish', handler: admin.finish },
    { method: 'POST', path: '/settings/credentials/oauth/start', handler: settings.start },
    { method: 'POST', path: '/settings/credentials/oauth/finish', handler: settings.finish },
  ];
  const unregisters: Array<() => void> = [];
  for (const r of routes) {
    const result = await bus.call<unknown, { unregister: () => void }>('http:register-route', ctx, r);
    unregisters.push(result.unregister);
  }
  return unregisters;
}
```

- [ ] **Step 3: Wire into the plugin**

In `packages/credentials-admin-routes/src/plugin.ts`, in `init`, also call `registerOauthRoutes(bus, ctx)` and add returned unregisters. Update manifest's `calls` to include `credentials:login:*`, `credentials:exchange:*`, `credentials:oauth:stash-pending`, `credentials:oauth:claim-pending`.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter '@ax/credentials-admin-routes' test oauth-flow`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add packages/credentials-admin-routes
git commit -m "feat(credentials-admin-routes): OAuth web-paste start/finish (admin + settings)"
```

---

### Task 3.3: Wire `@ax/credentials-oauth-pending` into k8s preset + Phase F canary

**Files:**
- Modify: `presets/k8s/src/index.ts` (load `@ax/credentials-oauth-pending` whenever credentialsAdmin is on)
- Modify: `presets/k8s/src/__tests__/acceptance.test.ts` (add OAuth paste-flow canary with stub provider)

- [ ] **Step 1: Load oauth-pending whenever credentialsAdmin is on**

In `createK8sPlugins`:
```ts
if (cfg.credentialsAdmin === true) {
  plugins.push(createCredentialsOauthPendingPlugin());
  plugins.push(createCredentialsAdminRoutesPlugin());
}
```

- [ ] **Step 2: Acceptance test for OAuth paste flow**

In `presets/k8s/src/__tests__/acceptance.test.ts`:

```ts
it('Phase F: anthropic-oauth web-paste flow stores a credential', async () => {
  // Stub credentials:exchange:anthropic-oauth to return a deterministic blob.
  // Stub credentials:login:anthropic-oauth to return a fixed authorizeUrl.
  // POST /admin/credentials/oauth/start → expect pendingId + authorizeUrl
  // POST /admin/credentials/oauth/finish with the fake code → expect 201
  // Verify GET /admin/credentials shows the new entry with kind='anthropic-oauth'
});
```

(The actual stubs go in the same harness that already mocks `chat:stream-chunk` etc. — wire via the existing `register*` helpers.)

- [ ] **Step 3: Run acceptance tests**

Run: `pnpm --filter '@ax/preset-k8s' test acceptance`
Expected: PASS.

- [ ] **Step 4: Commit + open PR**

```bash
git add presets/k8s packages/credentials-admin-routes
git commit -m "feat(preset-k8s): conditionally load credentials-oauth-pending; Phase F OAuth canary"
```

PR title: `feat(credentials-admin-routes): OAuth web-paste flow + state holder`

---

## PHASE 4 — Admin UI: Credentials tab

**Outcome:** `AdminPanel` adds a `'credentials'` view; `components/credentials/*` shared components implement the table + add menu + ApiKeyForm + OAuthFlowForm. `lib/credentials.ts` is the typed wire client. User-menu entry for admins.

**PR title:** `feat(channel-web): admin Credentials tab + shared credentials components`

### Task 4.1: Add wire client `lib/credentials.ts`

**Files:**
- Create: `packages/channel-web/src/lib/credentials.ts`
- Test: `packages/channel-web/src/lib/__tests__/credentials.test.ts`

- [ ] **Step 1: Write the failing test (mock `fetch`)**

```ts
// packages/channel-web/src/lib/__tests__/credentials.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { adminCredentials, myCredentials } from '../credentials.js';

describe('credentials wire client', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('adminCredentials.list GETs /admin/credentials', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ credentials: [] }), { status: 200 }));
    await adminCredentials.list();
    expect(fetchMock).toHaveBeenCalledWith('/admin/credentials', expect.objectContaining({ credentials: 'include' }));
  });

  it('adminCredentials.create POSTs base64-encoded payload', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ credential: {} }), { status: 201 }));
    await adminCredentials.create({ scope: 'global', ownerId: null, ref: 'k', kind: 'api-key', payload: 'sk-test' });
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(body.payload).toBe(Buffer.from('sk-test').toString('base64'));
  });

  it('myCredentials.create hits /settings/credentials', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ credential: {} }), { status: 201 }));
    await myCredentials.create({ ref: 'k', kind: 'api-key', payload: 'sk-test' });
    expect(fetchMock.mock.calls[0][0]).toBe('/settings/credentials');
  });

  it('writes carry x-requested-with: ax-admin', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    await adminCredentials.delete({ scope: 'user', ownerId: 'alice', ref: 'k' });
    expect(fetchMock.mock.calls[0][1]!.headers).toMatchObject({ 'x-requested-with': 'ax-admin' });
  });
});
```

- [ ] **Step 2: Implement `lib/credentials.ts`**

```ts
// packages/channel-web/src/lib/credentials.ts
export interface CredentialMeta {
  scope: 'global' | 'user' | 'agent';
  ownerId: string | null;
  ref: string;
  kind: string;
  createdAt: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

const writeHeaders = { 'content-type': 'application/json', 'x-requested-with': 'ax-admin' } as const;

function b64(s: string): string {
  // Browser: use btoa on UTF-8 bytes.
  const enc = new TextEncoder().encode(s);
  let bin = '';
  for (const b of enc) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function list(prefix: string): Promise<CredentialMeta[]> {
  const res = await fetch(prefix, { credentials: 'include' });
  if (!res.ok) throw new Error(`list credentials: ${res.status}`);
  return ((await res.json()) as { credentials: CredentialMeta[] }).credentials;
}

async function listKinds(): Promise<Array<{ kind: string; flow: 'paste' | 'oauth' }>> {
  // The list-kinds service is exposed via a sub-route on the admin namespace
  // (see Task 4.2 for route addition). Both panels consume from /admin/credentials/kinds.
  const res = await fetch('/admin/credentials/kinds', { credentials: 'include' });
  if (!res.ok) throw new Error(`list-kinds: ${res.status}`);
  return ((await res.json()) as { kinds: Array<{ kind: string; flow: 'paste' | 'oauth' }> }).kinds;
}

async function deleteAdmin(input: { scope: 'global'|'user'|'agent'; ownerId: string | null; ref: string }): Promise<void> {
  const owner = input.ownerId ?? '_';
  const res = await fetch(`/admin/credentials/${input.scope}/${encodeURIComponent(owner)}/${encodeURIComponent(input.ref)}`, {
    method: 'DELETE', headers: { 'x-requested-with': 'ax-admin' }, credentials: 'include',
  });
  if (!res.ok) throw new Error(`delete: ${res.status}`);
}

async function deleteSettings(ref: string): Promise<void> {
  const res = await fetch(`/settings/credentials/${encodeURIComponent(ref)}`, {
    method: 'DELETE', headers: { 'x-requested-with': 'ax-admin' }, credentials: 'include',
  });
  if (!res.ok) throw new Error(`delete: ${res.status}`);
}

export const adminCredentials = {
  list: () => list('/admin/credentials'),
  listKinds,
  async create(input: { scope: 'global'|'user'|'agent'; ownerId: string | null; ref: string; kind: string; payload: string; expiresAt?: number; metadata?: Record<string, unknown> }): Promise<CredentialMeta> {
    const body = { ...input, payload: b64(input.payload) };
    const res = await fetch('/admin/credentials', { method: 'POST', headers: writeHeaders, credentials: 'include', body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`create: ${res.status}`);
    return ((await res.json()) as { credential: CredentialMeta }).credential;
  },
  delete: deleteAdmin,
  async oauthStart(input: { scope: 'global'|'user'|'agent'; ownerId: string | null; ref: string; kind: string }): Promise<{ pendingId: string; authorizeUrl: string; instructions: string }> {
    const res = await fetch('/admin/credentials/oauth/start', { method: 'POST', headers: writeHeaders, credentials: 'include', body: JSON.stringify(input) });
    if (!res.ok) throw new Error(`oauth-start: ${res.status}`);
    return res.json();
  },
  async oauthFinish(input: { pendingId: string; code: string }): Promise<CredentialMeta> {
    const res = await fetch('/admin/credentials/oauth/finish', { method: 'POST', headers: writeHeaders, credentials: 'include', body: JSON.stringify(input) });
    if (!res.ok) throw new Error(`oauth-finish: ${res.status}`);
    return ((await res.json()) as { credential: CredentialMeta }).credential;
  },
};

export const myCredentials = {
  list: () => list('/settings/credentials'),
  listKinds,
  async create(input: { ref: string; kind: string; payload: string; expiresAt?: number; metadata?: Record<string, unknown> }): Promise<CredentialMeta> {
    const body = { ...input, payload: b64(input.payload) };
    const res = await fetch('/settings/credentials', { method: 'POST', headers: writeHeaders, credentials: 'include', body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`create: ${res.status}`);
    return ((await res.json()) as { credential: CredentialMeta }).credential;
  },
  delete: deleteSettings,
  async oauthStart(input: { ref: string; kind: string }): Promise<{ pendingId: string; authorizeUrl: string; instructions: string }> {
    const res = await fetch('/settings/credentials/oauth/start', { method: 'POST', headers: writeHeaders, credentials: 'include', body: JSON.stringify(input) });
    if (!res.ok) throw new Error(`oauth-start: ${res.status}`);
    return res.json();
  },
  async oauthFinish(input: { pendingId: string; code: string }): Promise<CredentialMeta> {
    const res = await fetch('/settings/credentials/oauth/finish', { method: 'POST', headers: writeHeaders, credentials: 'include', body: JSON.stringify(input) });
    if (!res.ok) throw new Error(`oauth-finish: ${res.status}`);
    return ((await res.json()) as { credential: CredentialMeta }).credential;
  },
};
```

- [ ] **Step 3: Add a `GET /admin/credentials/kinds` route in Phase 2 plugin**

In `packages/credentials-admin-routes/src/admin-routes.ts`, add a `kinds` handler that calls `credentials:list-kinds` and returns the result. Register at `/admin/credentials/kinds` (admin OR any authed user — relax the gate here; same as `auth:require-user` only).

- [ ] **Step 4: Run tests + commit**

Run: `pnpm --filter @ax/channel-web test credentials && pnpm --filter @ax/credentials-admin-routes test`
Expected: PASS.

```bash
git add packages/channel-web packages/credentials-admin-routes
git commit -m "feat(channel-web): credentials wire client; add /admin/credentials/kinds route"
```

---

### Task 4.2: Build `CredentialsList` component

**Files:**
- Create: `packages/channel-web/src/components/credentials/CredentialsList.tsx`
- Test: `packages/channel-web/src/components/credentials/__tests__/CredentialsList.test.tsx`

- [ ] **Step 1: Write a failing component test**

```tsx
// packages/channel-web/src/components/credentials/__tests__/CredentialsList.test.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CredentialsList } from '../CredentialsList';

describe('CredentialsList', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('renders the table with the seed list', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      credentials: [{ scope: 'global', ownerId: null, ref: 'anthropic', kind: 'api-key', createdAt: '2026-05-07T00:00:00Z' }],
    }), { status: 200 }));
    render(<CredentialsList variant="admin" />);
    await waitFor(() => expect(screen.getByText('anthropic')).toBeInTheDocument());
    expect(screen.getByText('global')).toBeInTheDocument();
    expect(screen.getByText('api-key')).toBeInTheDocument();
  });

  it('clicking delete fires a DELETE then refetches', async () => {
    const responses = [
      new Response(JSON.stringify({ credentials: [{ scope: 'user', ownerId: 'alice', ref: 'gh', kind: 'api-key', createdAt: '2026-05-07T00:00:00Z' }] }), { status: 200 }),
      new Response(null, { status: 204 }),
      new Response(JSON.stringify({ credentials: [] }), { status: 200 }),
    ];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(responses.shift()!));
    render(<CredentialsList variant="admin" />);
    await waitFor(() => expect(screen.getByText('gh')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /delete gh/i }));
    // Confirm prompt — assume CredentialsList uses window.confirm; stub it.
    // (or: trigger a confirm inside the component. Mocked elsewhere.)
    await waitFor(() => expect(screen.queryByText('gh')).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 2: Implement `CredentialsList`**

```tsx
// packages/channel-web/src/components/credentials/CredentialsList.tsx
import { useEffect, useState } from 'react';
import { adminCredentials, myCredentials, type CredentialMeta } from '../../lib/credentials';

export function CredentialsList({ variant }: { variant: 'admin' | 'user' }) {
  const [list, setList] = useState<CredentialMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const client = variant === 'admin' ? adminCredentials : myCredentials;

  async function reload() {
    setError(null);
    try { setList(await client.list()); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  useEffect(() => { void reload(); }, []);

  async function onDelete(c: CredentialMeta) {
    if (!confirm(`Delete credential "${c.ref}"? This cannot be undone.`)) return;
    try {
      if (variant === 'admin') await adminCredentials.delete({ scope: c.scope, ownerId: c.ownerId, ref: c.ref });
      else await myCredentials.delete(c.ref);
      await reload();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  if (list === null && error === null) return <div>Loading…</div>;
  if (error !== null) return <div className="error">Error: {error}</div>;
  return (
    <table className="credentials-list">
      <thead><tr><th>Scope</th><th>Owner</th><th>Ref</th><th>Kind</th><th>Created</th><th></th></tr></thead>
      <tbody>
        {list!.map((c) => (
          <tr key={`${c.scope}:${c.ownerId ?? '_'}:${c.ref}`}>
            <td>{c.scope}</td>
            <td>{c.ownerId ?? '—'}</td>
            <td>{c.ref}</td>
            <td>{c.kind}</td>
            <td>{new Date(c.createdAt).toLocaleString()}</td>
            <td><button type="button" aria-label={`Delete ${c.ref}`} onClick={() => onDelete(c)}>Delete</button></td>
          </tr>
        ))}
        {list!.length === 0 && <tr><td colSpan={6}>No credentials yet.</td></tr>}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 3: Run; verify PASS**

Run: `pnpm --filter @ax/channel-web test CredentialsList`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/channel-web/src/components/credentials packages/channel-web/src/components/credentials/__tests__
git commit -m "feat(channel-web): CredentialsList component"
```

---

### Task 4.3: Build `ApiKeyForm` + `OAuthFlowForm` + `CredentialAddMenu`

**Files:**
- Create: `packages/channel-web/src/components/credentials/ApiKeyForm.tsx`
- Create: `packages/channel-web/src/components/credentials/OAuthFlowForm.tsx`
- Create: `packages/channel-web/src/components/credentials/CredentialAddMenu.tsx`
- Tests: matching `__tests__` files

- [ ] **Step 1: Write failing tests**

(One test file per component; for `ApiKeyForm` cover: shows scope picker iff `variant='admin'`; calls correct create() with base64 payload; form-submit clears state. For `OAuthFlowForm` cover: clicking "Open" calls `oauthStart()`, opens window, stashes pendingId; submit calls `oauthFinish()`. For `CredentialAddMenu` cover: clicking opens dropdown; selecting api-key opens ApiKeyForm; selecting an oauth kind opens OAuthFlowForm.)

- [ ] **Step 2: Implement the three components**

(See spec §6.4 for the form layouts. Use `react-hook-form` only if already present; otherwise vanilla `useState`. For `OAuthFlowForm`, the "Open" button uses `window.open(authorizeUrl, '_blank', 'noopener,noreferrer')`.)

- [ ] **Step 3: Run tests + commit**

```bash
git add packages/channel-web
git commit -m "feat(channel-web): ApiKeyForm + OAuthFlowForm + CredentialAddMenu"
```

---

### Task 4.4: Wire Credentials into `AdminPanel` + user menu

**Files:**
- Modify: `packages/channel-web/src/lib/admin.ts` (extend `AdminView`)
- Modify: `packages/channel-web/src/components/admin/AdminPanel.tsx` (add `'credentials'` view)
- Modify: `packages/channel-web/src/components/UserMenu.tsx` (add admin entry)

- [ ] **Step 1: Extend `AdminView` and `TITLES`**

```ts
export type AdminView = 'agents' | 'mcp-servers' | 'teams' | 'credentials' | null;
```
Update `TITLES` in `AdminPanel.tsx`:
```ts
const TITLES: Record<Exclude<AdminView, null>, string> = {
  agents: 'Agents',
  'mcp-servers': 'MCP Servers',
  teams: 'Teams',
  credentials: 'Credentials',
};
```
Render `<CredentialsList variant="admin" />` + `<CredentialAddMenu variant="admin" onAdded={refresh} />` when `view === 'credentials'`.

- [ ] **Step 2: Add the user-menu entry (admin-only)**

In `UserMenu.tsx`, add an entry "Credentials" inside the admin-only block alongside Agents/MCP Servers/Teams.

- [ ] **Step 3: Run all channel-web tests**

Run: `pnpm --filter @ax/channel-web test`
Expected: PASS.

- [ ] **Step 4: Commit + open PR**

```bash
git add packages/channel-web
git commit -m "feat(channel-web): admin Credentials tab + user-menu entry"
```

PR title: `feat(channel-web): admin Credentials tab + shared credentials components`

---

## PHASE 5 — Settings UI: My credentials panel

**Outcome:** New `SettingsPanel.tsx` modal mounted from user menu (any signed-in user). Reuses `components/credentials/*` with `variant='user'`.

**PR title:** `feat(channel-web): SettingsPanel — My credentials`

### Task 5.1: Create `SettingsPanel.tsx`

**Files:**
- Create: `packages/channel-web/src/components/settings/SettingsPanel.tsx`
- Test: `packages/channel-web/src/components/settings/__tests__/SettingsPanel.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
// SettingsPanel.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SettingsPanel } from '../SettingsPanel';

it('opens with My credentials section', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ credentials: [] }), { status: 200 }));
  render(<SettingsPanel open={true} onClose={() => {}} />);
  expect(screen.getByText(/My credentials/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Implement (mirror AdminPanel chrome)**

```tsx
import { CredentialsList } from '../credentials/CredentialsList';
import { CredentialAddMenu } from '../credentials/CredentialAddMenu';

export function SettingsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="settings-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="settings-panel" role="dialog" aria-modal="true">
        <div className="settings-panel-header">
          <h2 className="settings-panel-title">My credentials</h2>
          <button type="button" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <div className="settings-panel-body">
          <CredentialAddMenu variant="user" />
          <CredentialsList variant="user" />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Wire into UserMenu**

In `UserMenu.tsx`, add a "My credentials" entry visible to ALL signed-in users (not gated on isAdmin). Clicking it opens `SettingsPanel`.

- [ ] **Step 4: Run tests + commit**

```bash
git add packages/channel-web
git commit -m "feat(channel-web): SettingsPanel — My credentials"
```

PR title: `feat(channel-web): SettingsPanel — My credentials`

---

## PHASE 6 — Phase F canary upgrades

**Outcome:** Acceptance test in `presets/k8s/src/__tests__/acceptance.test.ts` covers all four scenarios end-to-end: (a) global api-key resolution, (b) agent override of global, (c) user override of agent, (d) anthropic-oauth paste flow with stub.

**PR title:** `test(preset-k8s/acceptance): credentials scope precedence + OAuth paste-flow canaries`

### Task 6.1: Add four targeted acceptance test cases

**Files:**
- Modify: `presets/k8s/src/__tests__/acceptance.test.ts`

- [ ] **Step 1: Write test (a) — global resolution**

```ts
it('Phase F: a session resolves a global api-key seeded via /admin/credentials', async () => {
  await seedAdminCredential({ scope: 'global', ownerId: null, ref: 'anthropic-api-key', kind: 'api-key', payload: 'sk-global' });
  // Run a chat turn; the anthropic-llm stub asserts the api-key it received is 'sk-global'.
});
```

- [ ] **Step 2: Write test (b) — agent override**

```ts
it('Phase F: agent-scoped credential overrides global', async () => {
  await seedAdminCredential({ scope: 'global', ownerId: null, ref: 'anthropic-api-key', kind: 'api-key', payload: 'sk-global' });
  await seedAdminCredential({ scope: 'agent', ownerId: 'agent-canary', ref: 'anthropic-api-key', kind: 'api-key', payload: 'sk-agent' });
  // Run a chat turn against agent-canary; the stub asserts 'sk-agent'.
});
```

- [ ] **Step 3: Write test (c) — user override**

```ts
it('Phase F: user-scoped credential overrides agent and global', async () => {
  await seedAdminCredential({ scope: 'global', ownerId: null, ref: 'anthropic-api-key', kind: 'api-key', payload: 'sk-global' });
  await seedAdminCredential({ scope: 'agent', ownerId: 'agent-canary', ref: 'anthropic-api-key', kind: 'api-key', payload: 'sk-agent' });
  // Now POST as alice via /settings/credentials:
  await seedSettingsCredential({ asUser: 'alice', ref: 'anthropic-api-key', kind: 'api-key', payload: 'sk-alice' });
  // Run a chat turn as alice; stub asserts 'sk-alice'.
});
```

- [ ] **Step 4: Write test (d) — OAuth paste flow** (covered partially in Task 3.3; expand to the full canary loop here)

- [ ] **Step 5: Run + commit**

Run: `pnpm --filter '@ax/preset-k8s' test acceptance`
Expected: PASS.

```bash
git add presets/k8s
git commit -m "test(preset-k8s/acceptance): scope precedence + OAuth paste-flow canaries"
```

PR title: `test(preset-k8s/acceptance): credentials scope precedence + OAuth paste-flow canaries`

---

## PHASE 7 — Cleanup + docs

**Outcome:** `envFallback` is documented or removed (operator decides). `MANUAL-ACCEPTANCE.md` walkthrough updated. Chart marks `ANTHROPIC_API_KEY` env optional.

**PR title:** `chore(credentials): document envFallback retirement; MANUAL-ACCEPTANCE walkthrough; mark ANTHROPIC_API_KEY optional`

### Task 7.1: Add manual-acceptance walkthrough

**Files:**
- Modify: `deploy/MANUAL-ACCEPTANCE.md`

- [ ] **Step 1: Add a "Credentials Admin" section**

Sections to cover (each as a step-by-step):
- Open chat UI → click user menu → click "Credentials" (admin only)
- Click "Add credential" → choose "api-key" → fill in scope=global, ref=anthropic-api-key → paste a test secret → Save
- Verify it appears in the list (with kind="api-key", no plaintext shown)
- Open a chat with the canary agent; verify the LLM call works (proves end-to-end resolution)
- For OAuth: click "Add" → choose "anthropic-oauth" → click "Open Anthropic sign-in" → complete flow in the new tab → copy code → paste → Submit → verify the entry shows kind="anthropic-oauth"
- Open user menu → click "My credentials" → repeat the api-key flow as a non-admin user; verify only that user's credential appears

- [ ] **Step 2: Commit**

```bash
git add deploy/MANUAL-ACCEPTANCE.md
git commit -m "docs(MANUAL-ACCEPTANCE): credentials admin + settings walkthrough"
```

---

### Task 7.2: Mark `ANTHROPIC_API_KEY` env optional in chart

**Files:**
- Modify: `deploy/charts/ax-next/values.yaml` + comments
- Modify: `deploy/charts/ax-next/templates/host/deployment.yaml`

- [ ] **Step 1: Update values.yaml comment**

```yaml
# When credentials.admin.enabled=true, ANTHROPIC_API_KEY is optional —
# operators can seed it via POST /admin/credentials with scope=global instead.
# The env-fallback shim (process.env.ANTHROPIC_API_KEY) still works as a
# bottom-of-precedence-chain default for kind/dev. See
# docs/plans/2026-05-06-credentials-admin-ui-design.md §3.2.
anthropic:
  apiKey: ""
```

- [ ] **Step 2: Run chart-shape tests**

Run: `pnpm --filter '@ax/charts' test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add deploy/charts/ax-next
git commit -m "chore(chart): mark ANTHROPIC_API_KEY optional when credentials.admin.enabled"
```

---

### Task 7.3: Decide on envFallback retirement

**Files:**
- Modify: `packages/credentials/src/plugin.ts` (envFallback comment block — clarify it's now bottom-of-chain only)
- (Optional) Remove `envFallback` if zero deployments still need it

- [ ] **Step 1: Update the envFallback comment block**

In `packages/credentials/src/plugin.ts`, update the `CredentialsPluginConfig.envFallback` JSDoc:

```ts
/**
 * Optional process-env fallback for credential refs that have no entry
 * in any of the v2 storage scopes (global / agent / user). Used as the
 * BOTTOM of the resolution chain — if any v2 row exists, this is
 * skipped.
 *
 * SECURITY: env values are universal (same for every user). Only safe
 * for single-tenant kind/dev where there's one admin user. Multi-tenant
 * deployments should leave this empty and use POST /admin/credentials
 * (scope='global') instead. The plugin warns at boot when fallback is
 * configured to make the trade-off impossible to miss.
 *
 * Future: a follow-up may remove this entirely once kind/dev migrates.
 * Today (2026-05-07) the k8s preset still wires AX_CREDENTIALS_KEY +
 * ANTHROPIC_API_KEY → envFallback['anthropic-api-key'] for ergonomics.
 */
```

- [ ] **Step 2: Commit**

```bash
git add packages/credentials
git commit -m "docs(credentials): clarify envFallback as bottom-of-chain after scope axis"
```

PR title: `chore(credentials): document envFallback retirement; MANUAL-ACCEPTANCE walkthrough; mark ANTHROPIC_API_KEY optional`

---

## Cross-phase reminders

1. **Bug-fix policy (CLAUDE.md):** Any bug found during implementation that wasn't caught by an existing test → write the regression test FIRST, then fix.
2. **Boundary review (CLAUDE.md):** Each PR description must answer the four boundary-review questions for any new hook signature.
3. **Half-wired window (CLAUDE.md):** No phase merges with infrastructure that isn't wired through to a real consumer in the same PR. Each PR's notes must explicitly state "Half-wired window: NONE" with a one-line proof.
4. **Security checklist:** When PRs touch IPC / sandbox / plugin loading / untrusted content (Phases 2, 3 in particular), invoke the `security-checklist` skill before finalizing.
5. **YAGNI check:** Before each phase, audit the task list for "load-bearing at MVP, or pure dead code?" Defer or drop anything in the latter category.

---

## Self-Review Notes

- **Spec coverage:** Each spec section maps to a phase: §3 → Phase 1; §4 → Phase 2; §5 → Phases 3 (state-holder + paste flow); §6 → Phases 4 + 5; §7 → all phases (phasing); §8 → tests within each phase + Phase 6 canary; §9 → boundary-review reminder above + per-PR security-checklist invocation.
- **Placeholder scan:** Some component-test bodies in Phase 4 (Tasks 4.3 in particular) describe scenarios in prose rather than full code — this is intentional because the channel-web testing-library setup is well-established and the implementer can copy from existing component tests like `AgentForm.test.tsx`. If running this plan via subagent-driven-development, the subagent should read the existing component tests for style before implementing.
- **Type consistency:** `CredentialMeta` is defined in spec §3.5, in facade Phase 1.5, in routes Phase 2 (response shape), and in client Phase 4.1 — all four definitions use identical field names and types.
