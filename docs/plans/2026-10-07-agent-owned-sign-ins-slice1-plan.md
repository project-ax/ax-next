# Agent-owned sign-ins — Slice 1 (credential purge + delete cleanup) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `credentials:purge-account`, and make deleting a shared connector or an agent leave no orphaned connector sign-ins or reconnect markers.

**Architecture:** A new service hook in `@ax/credentials` tombstones every `account:<connectorId>` / `account:<connectorId>:*` row (or every `account:` row) in the given scopes, reusing the existing `credentials:store-blob:list|put` seam — no store-backend change. `@ax/connectors`' delete path calls it for **shared** connectors at agent scope. `@ax/mcp-oauth`'s existing `agents:deleted` subscriber also deletes the agent's reconnect markers.

**Tech Stack:** TypeScript, vitest, Kysely + Postgres (testcontainers), `@ax/core` HookBus.

**Spec:** `docs/plans/2026-10-07-agent-owned-connector-sign-ins-design.md` (slice 1 of 7).

## Global Constraints

- No cross-plugin imports (invariant 2): `@ax/connectors` reaches the new hook via `bus.call` + `bus.hasService`, declared as an `optionalCalls` entry.
- Hook payloads are storage-agnostic (invariant 1): `connectorId`, `scopes`, `purged` — no table/key vocabulary.
- Fail closed on bad input: an invalid `connectorId` or empty/invalid `scopes` is a `PluginError`, never a purge of everything.
- `connectorId` grammar: `/^[a-z0-9][a-z0-9_-]{0,127}$/` (same as `connector_propose`).
- Run tests with `DOCKER_HOST=unix:///var/run/docker.sock` exported (Postgres testcontainers).
- `pnpm --filter <pkg> test` — the filter goes **before** the script.
- Commit trailers: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01YZ4rcdtzRxcf4xooEWqvx8`.

## Review Focus

- **A connector id that is a prefix of another** (`gmail` vs `gmail2`): purging `gmail` must not touch `account:gmail2`. Pinned in Task 1.
- **A private connector sharing a shared connector's id**: deleting the private one must not purge the shared one's agent sign-ins (TASK-711 squatting). Pinned in Task 2.
- **Undecryptable rows** (key rotation aftermath): purge must not throw; it tombstones them. Pinned in Task 1.
- **Already-tombstoned rows** are not double-counted. Pinned in Task 1.
- **Non-`account:` refs** (`provider:`, `skill:`, `routine:`) are never touched, even with no `connectorId`. Pinned in Task 1.

---

### Task 0: Worktree baseline

- [ ] **Step 1:** In `/Users/vpulim/dev/ai/ax-next/.claude/worktrees/agent-owned-sign-ins` run `pnpm install && pnpm build`. Expected: success.
- [ ] **Step 2:** `export DOCKER_HOST=unix:///var/run/docker.sock; pnpm --filter @ax/credentials test && pnpm --filter @ax/connectors test && pnpm --filter @ax/mcp-oauth test`. Expected: all pass (baseline). If a package fails here, stop and report — it is pre-existing.

### Task 1: `credentials:purge-account`

**Files:**
- Modify: `packages/credentials/src/plugin.ts` (types near `CredentialsPurgeByOwnerInput` ~line 315; manifest `registers` ~line 415; new service after `credentials:purge-by-owner` ~line 1125)
- Modify: `packages/credentials/src/index.ts` (export the two types)
- Test: `packages/credentials/src/__tests__/purge-account.test.ts` (new)

**Interfaces:**
- Produces:
  ```ts
  export interface CredentialsPurgeAccountInput {
    /** Omit to purge EVERY `account:` row in `scopes`. */
    connectorId?: string;
    /** Non-empty; each one of 'user' | 'agent' | 'global'. */
    scopes: CredentialScope[];
  }
  export interface CredentialsPurgeAccountOutput {
    /** Live rows tombstoned. */
    purged: number;
  }
  ```
  Hook name: `'credentials:purge-account'`.

- [ ] **Step 1: Write the failing test** — `purge-account.test.ts`. Copy the `memStoragePlugin()` helper, `TEST_KEY_HEX`, and `makeHarness()` from `purge-by-owner.test.ts` verbatim (lines 1–70), then:

```ts
const enc = (s: string) => new TextEncoder().encode(s);

async function put(bus: HookBus, scope: 'user' | 'agent' | 'global', ownerId: string | null, ref: string) {
  await bus.call('credentials:set', ctx(), { scope, ownerId, ref, kind: 'api-key', payload: enc('v') });
}

async function refs(bus: HookBus): Promise<string[]> {
  const out = await bus.call<object, { credentials: Array<{ scope: string; ownerId: string | null; ref: string }> }>(
    'credentials:list', ctx(), {},
  );
  return out.credentials.map((c) => `${c.scope}:${c.ownerId ?? '_'}:${c.ref}`).sort();
}

describe('credentials:purge-account', () => {
  beforeEach(() => { process.env.AX_CREDENTIALS_KEY = TEST_KEY_HEX; });

  it('tombstones one connector\'s rows in the given scopes only', async () => {
    const { bus } = await makeHarness();
    await put(bus, 'agent', 'agt1', 'account:gmail');
    await put(bus, 'agent', 'agt2', 'account:gmail:HEADER_X');
    await put(bus, 'agent', 'agt1', 'account:gmail2');          // prefix neighbour — must survive
    await put(bus, 'user', 'u1', 'account:gmail');              // scope not requested — must survive
    await put(bus, 'global', null, 'account:gmail');            // scope not requested — must survive
    await put(bus, 'agent', 'agt1', 'provider:anthropic');      // other namespace — must survive
    const out = await bus.call('credentials:purge-account', ctx(), { connectorId: 'gmail', scopes: ['agent'] });
    expect(out).toEqual({ purged: 2 });
    expect(await refs(bus)).toEqual([
      'agent:agt1:account:gmail2',
      'agent:agt1:provider:anthropic',
      'global:_:account:gmail',
      'user:u1:account:gmail',
    ]);
  });

  it('with no connectorId purges every account: row in the scopes, nothing else', async () => {
    const { bus } = await makeHarness();
    await put(bus, 'user', 'u1', 'account:a');
    await put(bus, 'user', 'u2', 'account:b:SLOT');
    await put(bus, 'user', 'u1', 'skill:x');
    await put(bus, 'user', 'u1', 'routine:r');
    await put(bus, 'agent', 'agt1', 'account:a');
    const out = await bus.call('credentials:purge-account', ctx(), { scopes: ['user'] });
    expect(out).toEqual({ purged: 2 });
    expect(await refs(bus)).toEqual(['agent:agt1:account:a', 'user:u1:routine:r', 'user:u1:skill:x']);
  });

  it('does not count rows that are already tombstoned', async () => {
    const { bus } = await makeHarness();
    await put(bus, 'agent', 'agt1', 'account:gmail');
    await bus.call('credentials:delete', ctx(), { scope: 'agent', ownerId: 'agt1', ref: 'account:gmail' });
    const out = await bus.call('credentials:purge-account', ctx(), { connectorId: 'gmail', scopes: ['agent'] });
    expect(out).toEqual({ purged: 0 });
  });

  it('purges an undecryptable row without throwing', async () => {
    const { bus } = await makeHarness();
    await put(bus, 'agent', 'agt1', 'account:gmail');
    // Overwrite the stored blob with garbage (different-key aftermath).
    await bus.call('credentials:store-blob:put', ctx(), {
      scope: 'agent', ownerId: 'agt1', ref: 'account:gmail', blob: new Uint8Array([1, 2, 3]),
    });
    const out = await bus.call('credentials:purge-account', ctx(), { connectorId: 'gmail', scopes: ['agent'] });
    expect(out).toEqual({ purged: 1 });
    await expect(
      bus.call('credentials:get', makeAgentContext({ sessionId: 's', agentId: 'agt1', userId: 'u' }), { ref: 'account:gmail', userId: 'u' }),
    ).rejects.toThrow();
  });

  it.each([
    [{ connectorId: 'Gmail', scopes: ['agent'] }],
    [{ connectorId: 'a:b', scopes: ['agent'] }],
    [{ connectorId: '', scopes: ['agent'] }],
    [{ connectorId: 'gmail', scopes: [] }],
    [{ connectorId: 'gmail', scopes: ['team'] }],
    [{ connectorId: 'gmail' }],
  ])('rejects invalid input %j without purging anything', async (input) => {
    const { bus } = await makeHarness();
    await put(bus, 'agent', 'agt1', 'account:gmail');
    await expect(bus.call('credentials:purge-account', ctx(), input)).rejects.toMatchObject({ code: 'invalid-payload' });
    expect(await refs(bus)).toEqual(['agent:agt1:account:gmail']);
  });
});
```

- [ ] **Step 2: Run** `pnpm --filter @ax/credentials test -- purge-account`. Expected: FAIL (no service registered for `credentials:purge-account`).

- [ ] **Step 3: Implement.** In `plugin.ts`, after `CredentialsPurgeByOwnerOutput`:

```ts
/**
 * `credentials:purge-account` — tombstone connector credentials (`account:` refs).
 *
 * With `connectorId`: `account:<id>` and `account:<id>:<anything>` only — the
 * trailing `:` keeps `gmail` from matching `gmail2`. Without it: every
 * `account:` row. Only in the listed `scopes`. Other ref namespaces are never
 * touched. Used when a shared connector is deleted (agent scope) and by the
 * boot migration (user scope).
 *
 * Boundary review: alternate impl = a KMS/vault backend deleting by tag; no
 * backend vocabulary in the payload.
 */
export interface CredentialsPurgeAccountInput {
  connectorId?: string;
  scopes: CredentialScope[];
}

export interface CredentialsPurgeAccountOutput {
  purged: number;
}

const PURGE_CONNECTOR_ID_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;
```

Add `'credentials:purge-account'` to the manifest `registers` array after `'credentials:purge-by-owner'`.

After the `credentials:purge-by-owner` registration:

```ts
      bus.registerService<CredentialsPurgeAccountInput, CredentialsPurgeAccountOutput>(
        'credentials:purge-account',
        PLUGIN_NAME,
        async (ctx, input) => {
          const invalidPurge = (message: string) =>
            new PluginError({ code: 'invalid-payload', plugin: PLUGIN_NAME, message });
          if (!Array.isArray(input.scopes) || input.scopes.length === 0) {
            throw invalidPurge('scopes must be a non-empty array');
          }
          const scopes = [...new Set(input.scopes.map((s) => validateScope(s)))];
          let prefix: string | undefined;
          if (input.connectorId !== undefined) {
            if (typeof input.connectorId !== 'string' || !PURGE_CONNECTOR_ID_RE.test(input.connectorId)) {
              throw invalidPurge('connectorId is not a valid connector id');
            }
            prefix = `${GUARDED_ACCOUNT_REF_PREFIX}${input.connectorId}`;
          }
          const matches = (ref: string): boolean =>
            prefix === undefined
              ? ref.startsWith(GUARDED_ACCOUNT_REF_PREFIX)
              : ref === prefix || ref.startsWith(`${prefix}:`);
          let purged = 0;
          for (const scope of scopes) {
            const out = await bus.call<
              { scope: CredentialScope },
              { entries: Array<{ scope: CredentialScope; ownerId: string | null; ref: string; blob: Uint8Array }> }
            >('credentials:store-blob:list', ctx, { scope });
            for (const e of out.entries) {
              if (!matches(e.ref)) continue;
              let live = true;
              try {
                live = !unwrapEnvelope(e.blob).isTombstone;
              } catch {
                // Undecryptable (key-rotation aftermath): still ours to purge.
              }
              if (!live) continue;
              await bus.call('credentials:store-blob:put', ctx, {
                scope: e.scope,
                ownerId: e.ownerId,
                ref: e.ref,
                blob: encryptWithKey(key, ''),
              });
              purged++;
            }
          }
          return { purged };
        },
      );
```

Verify `validateScope` throws `PluginError({code:'invalid-payload'})` for `'team'`; if its code differs, make the test's `it.each` row for `'team'` assert that code instead — do not change `validateScope`.

In `index.ts` add `CredentialsPurgeAccountInput, CredentialsPurgeAccountOutput` to the `export type { … } from './plugin.js'` list.

- [ ] **Step 4: Run** `pnpm --filter @ax/credentials test`. Expected: all pass (new file + existing). Also `pnpm --filter @ax/credentials exec tsc --noEmit -p .` — no errors.

- [ ] **Step 5: Commit** `git add packages/credentials && git commit -m "credentials: add credentials:purge-account (tombstone a connector's account: rows by scope)"` (+ trailers).

### Task 2: Deleting a shared connector purges every agent's sign-ins for it

**Files:**
- Modify: `packages/connectors/src/purge.ts` (after the `credentials:delete` loop, before the `connectors:deleted` fire)
- Modify: `packages/connectors/src/plugin.ts` (`optionalCalls` ~line 227)
- Test: `packages/connectors/src/__tests__/hooks.test.ts` (purge-on-delete section ~line 585)

**Interfaces:**
- Consumes: `credentials:purge-account` `{ connectorId, scopes: ['agent'] }` → `{ purged }` (Task 1).

- [ ] **Step 1: Write the failing tests.** In `hooks.test.ts`, add a harness next to `makeHarnessWithCredSpy`:

```ts
async function makeHarnessWithPurgeSpy(): Promise<{ h: TestHarness; purges: unknown[] }> {
  const purges: unknown[] = [];
  const h = await createTestHarness({
    services: {
      'credentials:delete': async () => {},
      'credentials:purge-account': async (_ctx, input) => {
        purges.push(input);
        return { purged: 0 };
      },
    },
    plugins: [createDatabasePostgresPlugin({ connectionString }), createConnectorsPlugin()],
  });
  harnesses.push(h);
  return { h, purges };
}

describe('@ax/connectors hooks — delete purges agents\' sign-ins (agent-owned sign-ins slice 1)', () => {
  it('a SHARED connector delete purges agent-scope rows for its id', async () => {
    const { h, purges } = await makeHarnessWithPurgeSpy();
    await h.bus.call<UpsertInput, UpsertOutput>('connectors:upsert', h.ctx({ userId: 'admin' }),
      upsertInput({ userId: 'admin', connectorId: 'sf', keyMode: 'workspace', visibility: 'shared', capabilities: cliCaps() }));
    await h.bus.call<DeleteInput, DeleteOutput>('connectors:delete', h.ctx({ userId: 'admin' }),
      { userId: 'admin', connectorId: 'sf', purgeGlobal: true });
    expect(purges).toEqual([{ connectorId: 'sf', scopes: ['agent'] }]);
  });

  it('a PRIVATE connector delete never purges agent rows (could share a shared connector\'s id)', async () => {
    const { h, purges } = await makeHarnessWithPurgeSpy();
    await h.bus.call<UpsertInput, UpsertOutput>('connectors:upsert', h.ctx({ userId: 'userA' }), upsertInput());
    await h.bus.call<DeleteInput, DeleteOutput>('connectors:delete', h.ctx({ userId: 'userA' }),
      { userId: 'userA', connectorId: 'gdrive' });
    expect(purges).toEqual([]);
  });

  it('a purge failure is logged and the delete still succeeds', async () => {
    const h = await createTestHarness({
      services: {
        'credentials:delete': async () => {},
        'credentials:purge-account': async () => { throw new Error('boom'); },
      },
      plugins: [createDatabasePostgresPlugin({ connectionString }), createConnectorsPlugin()],
    });
    harnesses.push(h);
    await h.bus.call<UpsertInput, UpsertOutput>('connectors:upsert', h.ctx({ userId: 'admin' }),
      upsertInput({ userId: 'admin', connectorId: 'sf', keyMode: 'workspace', visibility: 'shared', capabilities: cliCaps() }));
    const del = await h.bus.call<DeleteInput, DeleteOutput>('connectors:delete', h.ctx({ userId: 'admin' }),
      { userId: 'admin', connectorId: 'sf', purgeGlobal: true });
    expect(del.deleted).toBe(true);
  });
});
```

If `upsertInput()`'s default visibility is not `'private'`, pass `visibility: 'private'` explicitly in the second test.

- [ ] **Step 2: Run** `pnpm --filter @ax/connectors test -- hooks`. Expected: the shared-connector test FAILS (`purges` is `[]`).

- [ ] **Step 3: Implement.** In `purge.ts`, immediately before the `// Announce the removal` comment:

```ts
  // Agent-owned sign-ins (2026-10-07 design): every agent's sign-in / per-agent
  // key for this connector lives at AGENT scope under `account:<id>[:SLOT]`.
  // Only a SHARED connector's delete may purge them: agent-scope rows are
  // readable only for the sole shared definition (TASK-711), so a private
  // connector that happens to share the id must never wipe them. Best-effort,
  // like the credential purge above.
  if (connector.visibility === 'shared' && bus.hasService('credentials:purge-account')) {
    try {
      await bus.call('credentials:purge-account', ctx, { connectorId, scopes: ['agent'] });
    } catch (err) {
      ctx.logger.warn('connectors_delete_agent_signins_purge_failed', {
        connectorId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
```

In `plugin.ts` `optionalCalls`, add after the `credentials:delete` entry:

```ts
        {
          hook: 'credentials:purge-account',
          degradation:
            "the connector is deleted but agents' sign-ins for it are left in the vault (unreadable once the connector is gone)",
        },
```

- [ ] **Step 4: Run** `pnpm --filter @ax/connectors test` and `pnpm --filter @ax/connectors exec tsc --noEmit -p .`. Expected: pass. If a manifest snapshot test lists `optionalCalls`, update it to include the new entry.

- [ ] **Step 5: Commit** `git commit -am "connectors: deleting a shared connector purges every agent's sign-ins for it"` (+ trailers).

### Task 3: Deleting an agent removes its reconnect markers

**Files:**
- Modify: `packages/mcp-oauth/src/store.ts` (`deleteAllForAgent` doc ~line 45–58 and impl ~line 205)
- Modify: `packages/mcp-oauth/src/plugin.ts` (`agents:deleted` subscriber comment + log ~line 318–340)
- Modify: `packages/agents/src/plugin.ts` (comment above the purge ~line 855)
- Test: `packages/mcp-oauth/src/__tests__/store.test.ts` (`deleteAllForAgent` block ~line 459), `packages/mcp-oauth/src/__tests__/plugin.test.ts` (TASK-718 block ~line 771)

**Interfaces:**
- Produces: `deleteAllForAgent(agentId: string): Promise<{ deleted: number; markers: number }>` — `deleted` keeps its meaning (pending rows), `markers` is reconnect markers removed.

- [ ] **Step 1: Write the failing test.** In the `store.test.ts` `deleteAllForAgent` describe, add:

```ts
    it('also deletes the agent\'s reconnect markers, and only that agent\'s', async () => {
      const store = createMcpOAuthStore(db);
      await store.markNeedsReconnect({ kind: 'agent', agentId: 'agt_del' }, 'gmail');
      await store.markNeedsReconnect({ kind: 'agent', agentId: 'agt_del' }, 'linear');
      await store.markNeedsReconnect({ kind: 'agent', agentId: 'agt_keep' }, 'gmail');
      const out = await store.deleteAllForAgent('agt_del');
      expect(out.markers).toBe(2);
      expect(await store.hasNeedsReconnect({ kind: 'agent', agentId: 'agt_del' }, 'gmail')).toBe(false);
      expect(await store.hasNeedsReconnect({ kind: 'agent', agentId: 'agt_keep' }, 'gmail')).toBe(true);
    });
```

(Use whatever `db` handle the surrounding describe already uses.)

- [ ] **Step 2: Run** `pnpm --filter @ax/mcp-oauth test -- store`. Expected: FAIL (`out.markers` undefined / marker still present).

- [ ] **Step 3: Implement.** In `store.ts` change the interface return type to `Promise<{ deleted: number; markers: number }>` and update its doc comment: "Touches `mcp_oauth_v1_pending` and `mcp_oauth_v1_needs_reconnect_agent` …" (keep the `clients` note). Implementation, replacing the body after the empty-id guard:

```ts
      return db.transaction().execute(async (trx) => {
        const pending = await trx
          .deleteFrom('mcp_oauth_v1_pending')
          .where('agent_id', '=', agentId)
          .executeTakeFirst();
        const markers = await trx
          .deleteFrom('mcp_oauth_v1_needs_reconnect_agent')
          .where('agent_id', '=', agentId)
          .executeTakeFirst();
        return {
          deleted: Number(pending.numDeletedRows ?? 0n),
          markers: Number(markers.numDeletedRows ?? 0n),
        };
      });
```

In `plugin.ts` update the subscriber: comment "…and its reconnect markers must go with it"; log `{ agentId, deleted, markers }`. In `agents/src/plugin.ts` replace the comment block above `if (bus.hasService('credentials:purge-by-owner'))` with:

```ts
  // Credential purge is best-effort: a failure is logged and the agent row is
  // deleted anyway. Leftover agent-scope rows are unreadable (no agent) and a
  // re-created agent gets a fresh id, so they can never be resolved again.
```

- [ ] **Step 4: Run** `pnpm --filter @ax/mcp-oauth test` and `pnpm --filter @ax/agents test`, plus `tsc --noEmit -p .` in both. Expected: pass. Fix any existing assertion that compared the whole `deleteAllForAgent` result object (`toEqual({ deleted: n })` → `toMatchObject({ deleted: n })`).

- [ ] **Step 5: Commit** `git commit -am "mcp-oauth: deleting an agent also removes its reconnect markers"` (+ trailers).

### Task 4: Gate + memory

- [ ] **Step 1:** `pnpm build && pnpm lint && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`. Expected: green. A pure container-start timeout with zero assertion failures is the machine — re-run that package alone.
- [ ] **Step 2:** Write a decisions shard: `shard=$(scripts/memory-write-target.sh --shard decisions agent-owned-signins-s1); mkdir -p "$(dirname "$shard")"` — record: slice order changed (lookup flip last, because 22 test files in 7 packages assume person-level `account:` rows); purge is tombstone-based via store-blob; shared-only purge on connector delete (TASK-711). Commit it.
