# Week 7–9 — Production Deployment Shapes (k8s + Postgres + Workspace) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Dispatch one fresh subagent per task, review between tasks, commit after each.

**Goal:** Swap the single-host plugins shipped in Weeks 1–6.5e for their production-shape equivalents so v2 can deploy to, and run a real chat on, a real k8s cluster — without changing any subscriber code, and without `@ax/preset-local` regressing.

**Architecture:**
- Invariant 1 (transport/storage-agnostic hooks) is the load-bearing claim of this slice. We validate it by shipping production impls behind the same hook surfaces and by introducing the workspace contract (Section 4.5) with **two backends** (`@ax/workspace-git` + a `MockWorkspace` test plugin) so the contract is never validated against a single implementation.
- Workspace commits are **turn-end, not per-tool-call**. The runner's `workspace.commit-notify` IPC fires once per turn with the aggregate diff; the host's `@ax/workspace-git` processes one `workspace:pre-apply` per turn. Per-tool redaction lives in `llm:pre-call` already (decision D4 of the 6.5 design doc; see MVP direction memo).
- Postgres plugins follow the per-plugin-migrations rule from architecture doc Section 6: each store owns its tables, no cross-plugin foreign keys. A dedicated `@ax/database-postgres` plugin owns the connection pool and exposes `database:get-instance`.
- `@ax/sandbox-k8s` ports the Tasks 1–7 hardening from legacy: per-pod child logger pre-bound with `reqId`/`podName`/`pid`, lifecycle reason capture (container vs pod-level), kill-with-reqId cleanup. Image bundles both runner binaries (`@ax/agent-native-runner` + `@ax/agent-claude-sdk-runner`); session config picks which to start.
- `@ax/preset-k8s` is a meta-package that pins the k8s plugin set, including `@ax/mcp-client` + `@ax/credentials` from 6.5e.
- Single-replica only. `@ax/workspace-git-http` is **deferred** to Week 10+ when multi-replica is actually needed (handoff scope decision 2 → recommendation a).

**Tech Stack:** TypeScript (strict), pnpm workspace, vitest, Zod, Kysely + `pg` driver, `isomorphic-git` for the workspace backend (pure-JS, no system git dependency at runtime — decision in Task 8), `@kubernetes/client-node` for the k8s sandbox, `testcontainers` for postgres-dependent tests, kind/minikube for local k8s verification.

**Branch:** `feat/week-7-9-k8s-deployment`, branched off tip of 6.5e (which merged to `main` at `0959a2d`). Implementation happens in a git worktree (see Task 0).

**Five-invariant audit (this slice's audit trail — see Week 4–6 PR #5 for the I1–I12 precedent):**
- **I1 (transport/storage-agnostic hooks):** Workspace hooks use the opaque `WorkspaceVersion` brand and lazy `() => Promise<Bytes>` fetchers; field names contain no `sha`, `commit`, `branch`, `bundle`, `ref`, `parent-array`, `bucket`, `manifest`. Storage / session / eventbus / sandbox hook signatures are byte-identical to their single-host predecessors. ✅ Verified by Task 4 contract-suite test asserting MockWorkspace and `@ax/workspace-git` are interchangeable.
- **I2 (no cross-plugin imports):** Every new plugin depends on `@ax/core` only. Type duplication at the boundary is intentional (same pattern as `@ax/sandbox-subprocess` borrowing `SessionCreateInput` shape from `@ax/session-inmemory` without importing it). Enforced in CI via `pnpm-workspace.yaml` package boundaries plus `eslint no-restricted-imports` (already in place from Week 4–6).
- **I3 (no half-wired plugins):** Each new plugin is wired into `@ax/cli` (or `@ax/preset-k8s`) and exercised by an acceptance test in the same PR. The plan rejects "wire later" — `@ax/sandbox-k8s` lights up via the kind-based acceptance test (Task 22) before merge.
- **I4 (one source of truth per concept):** Sessions live in exactly one of `@ax/session-inmemory` (local preset) or `@ax/session-postgres` (k8s preset) at boot, never both — duplicate `registers` is a kernel boot-time error. Workspace state lives in exactly one of `MockWorkspace` (tests) or `@ax/workspace-git` (prod). Storage same: sqlite OR postgres, never both.
- **I5 (capabilities minimized):** Per-package `SECURITY.md` (Tasks 7, 11, 14, 17, 19, 21) walks all three threat models; checklist output goes into the PR. k8s namespace + RBAC are minimum-needed (pod create/delete/get/watch in one namespace; no cluster-scoped verbs). Postgres role for the host has no DDL beyond migration time.

**Boundary review output (for PR description, accumulated as we go):**
- **Alternate impl for `workspace:apply` / `read` / `list` / `diff`:** `@ax/workspace-gcs` (manifest-object pattern, Section 4.5) and `@ax/workspace-s3` are the obvious candidates. The contract test-suite (Task 4) is precisely the suite they will be required to pass.
- **Alternate impl for `database:get-instance`:** A future `@ax/database-mysql` or `@ax/database-cockroach` would register the same hook returning a Kysely instance for that dialect. (We don't ship one; we just keep the surface honest.)
- **Alternate impl for `eventbus:emit` / `subscribe`:** `@ax/eventbus-inprocess` (this slice) and `@ax/eventbus-postgres` (this slice) are the two impls that validate the contract on day one. A future `@ax/eventbus-redis` or `@ax/eventbus-nats` would slot in identically.
- **Alternate impl for `sandbox:open-session`:** `@ax/sandbox-subprocess` (already shipped) and `@ax/sandbox-k8s` (this slice). A future `@ax/sandbox-firecracker` would register the same hook.
- **Payload field names that might leak:** None — every field name has been reviewed against architecture doc Section 4.5's intentionally-absent list. `parentVersion`/`version` are already in IPC protocol from 6.5a; we keep them. `rootPath` on `ChatContext.workspace` is a host-side concept (where the runner's working tree lives on disk inside the pod), not a workspace-backend concept — orthogonal.
- **Subscriber risk:** `workspace:applied` will be the integration point for `@ax/scanner-canary` (Week 10–12) and `@ax/skills-validator` (Week 13+). Lazy `contentBefore`/`contentAfter` fetchers ensure subscribers that only care about specific path globs don't pay for full diff bytes. Tested in Task 4.
- **Wire surface:** `workspace.commit-notify` IPC action already exists (6.5a stub). This slice replaces the stub handler with one that calls `bus.fire('workspace:pre-apply')` then `bus.call('workspace:apply')` — IPC schema unchanged.

**Security review (per-package outputs):** Tasks 7, 11, 14, 17, 19, 21 each invoke the `security-checklist` skill and produce a `SECURITY.md` in the package directory. The PR description aggregates the three-line summary from each.

---

## Slice map (subagent-driven order)

Tasks are grouped into six phases. Within a phase, later tasks depend on earlier ones; between phases, commit + code-review checkpoint. Subagents work in worktree `.worktrees/week-7-9` (set up in Task 0).

| Phase | Tasks | Produces |
|---|---|---|
| 0. Setup | 0 | Worktree + branch + baseline green |
| A. Workspace contract & test scaffold | 1–7 | `@ax/core` workspace types, `@ax/eventbus-inprocess` (real impl), `MockWorkspace`, contract test-suite, `@ax/workspace-git`, IPC stub replacement |
| B. Postgres plumbing | 8–13 | `@ax/database-postgres`, `@ax/storage-postgres`, `@ax/eventbus-postgres`, `@ax/session-postgres` (additive schema for 9.5) |
| C. k8s sandbox | 14–17 | `@ax/sandbox-k8s` with ported lifecycle/logging/kill-with-reqId, RBAC, pod-spec template |
| D. Preset & deploy | 18–19 | `@ax/preset-k8s`, deploy manifests (Helm chart ported from legacy) |
| E. Acceptance + ship | 20–24 | CI acceptance (mocked k8s + testcontainers pg), manual kind acceptance, changeset, PR notes |

**Security gate:** every new package gets a `security-checklist` walk **before** Phase E begins. Don't defer to the end.

---

## Task 0: Set up worktree and branch

**Skill:** `@superpowers:using-git-worktrees`

**Step 1: Verify baseline is green on tip of main (which is tip of 6.5e)**

Run:
```bash
cd /Users/vpulim/dev/ai/ax-next
git fetch origin
git rev-parse HEAD                         # expect 0959a2d (or descendant)
pnpm install
pnpm build && pnpm test
```
Expected: all packages build, all tests pass. If red, **STOP and surface to user** — do not layer work on a broken tree.

**Step 2: Create the worktree**

```bash
git worktree add -b feat/week-7-9-k8s-deployment .worktrees/week-7-9 main
cd .worktrees/week-7-9
pnpm install
```

**Step 3: Sanity-check existing artifacts this slice extends**

Confirm the following exist (they are from 6.5a and will be replaced/extended, not duplicated):

```bash
grep -n "WorkspaceVersion" packages/ipc-protocol/src/actions.ts
# expect: branded WorkspaceVersion already exported

cat packages/ipc-server/src/handlers/workspace-commit-notify.ts | head -30
# expect: STUB handler that returns {accepted: true, version: 'stub', delta: null}

ls packages/eventbus-inprocess/
# expect: only dist/ + node_modules/ — no src/ yet (skeleton from Week 4–6 build).
# Task 1 fills it in.
```

**Step 4: Commit nothing yet — plan-only setup task. Move on.**

---

## Phase A — Workspace contract & test scaffold

The contract has to outlive its first backend. Land the types in `@ax/core`, write a `MockWorkspace` test plugin, build the contract test-suite, then implement `@ax/workspace-git` against it. Replace the IPC stub last.

### Task 1: `@ax/eventbus-inprocess` — fill in the skeleton

The package directory exists but `src/` is empty. The handoff (decision 3) calls for shipping it here so the `eventbus:emit` / `eventbus:subscribe` contract has two impls (in-process + postgres) validating it from day one.

**Files:**
- Create: `packages/eventbus-inprocess/src/plugin.ts`
- Create: `packages/eventbus-inprocess/src/index.ts`
- Create: `packages/eventbus-inprocess/src/__tests__/plugin.test.ts`
- Create: `packages/eventbus-inprocess/package.json` (verify present; create if missing)
- Create: `packages/eventbus-inprocess/tsconfig.json`
- Create: `packages/eventbus-inprocess/vitest.config.ts`

**Step 1: Write the failing test**

```ts
// packages/eventbus-inprocess/src/__tests__/plugin.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createTestHarness } from '@ax/test-harness';
import { createEventbusInprocessPlugin } from '../plugin.js';

describe('@ax/eventbus-inprocess', () => {
  it('delivers payloads to subscribers in order', async () => {
    const harness = createTestHarness();
    await harness.load(createEventbusInprocessPlugin());
    const seen: string[] = [];
    await harness.bus.call('eventbus:subscribe', harness.ctx, {
      channel: 'demo',
      handler: async (p) => { seen.push(String(p)); },
    });
    await harness.bus.call('eventbus:emit', harness.ctx, { channel: 'demo', payload: 'a' });
    await harness.bus.call('eventbus:emit', harness.ctx, { channel: 'demo', payload: 'b' });
    expect(seen).toEqual(['a', 'b']);
  });

  it('isolates a throwing subscriber (other subscribers still fire)', async () => {
    const harness = createTestHarness();
    await harness.load(createEventbusInprocessPlugin());
    const ok = vi.fn(async () => {});
    await harness.bus.call('eventbus:subscribe', harness.ctx, {
      channel: 'x',
      handler: async () => { throw new Error('bad sub'); },
    });
    await harness.bus.call('eventbus:subscribe', harness.ctx, { channel: 'x', handler: ok });
    await harness.bus.call('eventbus:emit', harness.ctx, { channel: 'x', payload: 1 });
    expect(ok).toHaveBeenCalledOnce();
  });

  it('unsubscribe stops delivery', async () => {
    const harness = createTestHarness();
    await harness.load(createEventbusInprocessPlugin());
    const seen: number[] = [];
    const sub = await harness.bus.call<
      { channel: string; handler: (p: unknown) => Promise<void> },
      { unsubscribe: () => void }
    >('eventbus:subscribe', harness.ctx, {
      channel: 'y',
      handler: async (p) => { seen.push(p as number); },
    });
    await harness.bus.call('eventbus:emit', harness.ctx, { channel: 'y', payload: 1 });
    sub.unsubscribe();
    await harness.bus.call('eventbus:emit', harness.ctx, { channel: 'y', payload: 2 });
    expect(seen).toEqual([1]);
  });
});
```

Run: `pnpm test --filter @ax/eventbus-inprocess` — expect FAIL (`plugin.ts` not present).

**Step 2: Implement `plugin.ts`**

Mirror the `.d.ts` already on disk (`packages/eventbus-inprocess/dist/plugin.d.ts`). Key invariants:
- One `Map<string, Set<EventbusHandler>>` keyed by channel.
- `eventbus:subscribe` is a service hook returning `{ unsubscribe: () => void }`.
- `eventbus:emit` iterates the channel's handler set, awaiting each in registration order. Subscriber throws are caught + logged at error level via `ctx.logger.error('eventbus_subscriber_failed', {...})` and **must not halt fan-out** (matches the `@ax/core` hook bus subscriber-isolation pattern; the `chat_terminated` rule is for service hooks only).
- Manifest: `registers: ['eventbus:emit', 'eventbus:subscribe']`, `subscribes: []`, `calls: []`.

**Step 3: Run tests, expect PASS.**

**Step 4: Commit**

```bash
git add packages/eventbus-inprocess
git commit -m "feat(eventbus-inprocess): in-process pub/sub impl"
```

### Task 2: Workspace contract types in `@ax/core`

The whole point of Section 4.5 is that the types outlive any one backend. Land them in `@ax/core` so nothing is tempted to reach into `@ax/workspace-git` for a shared type.

`WorkspaceVersion` is **already exported** from `@ax/ipc-protocol` (used by `WorkspaceCommitNotifyResponseSchema`). Move the canonical declaration to `@ax/core`; have `@ax/ipc-protocol` import it from there. (`@ax/ipc-protocol` already depends on `@ax/core` transitively via the `ChatMessage` import path; verify.)

**Files:**
- Create: `packages/core/src/workspace.ts`
- Modify: `packages/core/src/index.ts` — re-export new symbols
- Modify: `packages/ipc-protocol/src/actions.ts` — import `WorkspaceVersion` from `@ax/core`, drop local declaration
- Test: `packages/core/src/__tests__/workspace.test.ts`

**Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/workspace.test.ts
import { describe, it, expect } from 'vitest';
import {
  asWorkspaceVersion,
  type WorkspaceVersion,
  type FileChange,
  type WorkspaceDelta,
  type WorkspaceChangeKind,
} from '../workspace.js';

describe('workspace contract', () => {
  it('brands WorkspaceVersion (raw strings cannot be assigned)', () => {
    const v: WorkspaceVersion = asWorkspaceVersion('opaque-token');
    expect(v).toBe('opaque-token');
    // @ts-expect-error — raw string must not be assignable
    const bad: WorkspaceVersion = 'plain';
    void bad;
  });

  it('FileChange union has exactly put and delete variants', () => {
    const put: FileChange = { path: 'a', kind: 'put', content: new Uint8Array([1]) };
    const del: FileChange = { path: 'a', kind: 'delete' };
    expect(put.kind).toBe('put');
    expect(del.kind).toBe('delete');
  });

  it('WorkspaceDelta exposes lazy contentBefore/contentAfter fetchers', async () => {
    const kinds: WorkspaceChangeKind[] = ['added', 'modified', 'deleted'];
    expect(kinds).toContain('modified');
    const d: WorkspaceDelta = {
      before: null,
      after: asWorkspaceVersion('v1'),
      reason: 'test',
      changes: [{
        path: 'x',
        kind: 'added',
        contentAfter: async () => new Uint8Array([42]),
      }],
    };
    const bytes = await d.changes[0].contentAfter!();
    expect(bytes[0]).toBe(42);
  });

  it('WorkspaceDelta.changes never holds bytes eagerly', () => {
    // Type-level assertion: contentBefore/contentAfter are () => Promise<Bytes>, never Bytes.
    type Change = WorkspaceDelta['changes'][number];
    type Cb = NonNullable<Change['contentBefore']>;
    const _proof: Cb extends () => Promise<Uint8Array> ? true : false = true;
    expect(_proof).toBe(true);
  });
});
```

Run: `pnpm test --filter @ax/core -- workspace` → FAIL.

**Step 2: Implement**

```ts
// packages/core/src/workspace.ts

// ---------------------------------------------------------------------------
// Workspace contract (architecture doc Section 4.5)
//
// Subscribers never parse a WorkspaceVersion. They pass it back to workspace
// hooks. Git impl makes it a commit SHA; GCS impl makes it a manifest object
// name. Neither leaks at this surface.
//
// Snapshots, not commits: the surface is "full set of path → content at a
// version." Backends derive that however they want. Per Section 4.5 this is
// the GCS-natural shape; git can always derive it (`git ls-tree` +
// `git diff-tree`).
// ---------------------------------------------------------------------------

export type WorkspaceVersion = string & { readonly __brand: 'WorkspaceVersion' };

export const asWorkspaceVersion = (s: string): WorkspaceVersion =>
  s as WorkspaceVersion;

export type Bytes = Uint8Array;

export type FileChange =
  | { path: string; kind: 'put'; content: Bytes }
  | { path: string; kind: 'delete' };

export type WorkspaceChangeKind = 'added' | 'modified' | 'deleted';

export interface WorkspaceChange {
  path: string;
  kind: WorkspaceChangeKind;
  // Lazy on purpose — skill validator only wants .claude/skills/**, canary
  // wants everything, indexer wants neither. Forcing eager bytes makes every
  // workspace change pay full cost regardless of who's listening.
  contentBefore?: () => Promise<Bytes>;
  contentAfter?: () => Promise<Bytes>;
}

export interface WorkspaceDelta {
  before: WorkspaceVersion | null;          // null = initial state
  after: WorkspaceVersion;
  reason?: string;                          // agent-supplied at apply time
  author?: { agentId?: string; userId?: string; sessionId?: string };
  changes: WorkspaceChange[];
}

// Service-hook payloads.
export interface WorkspaceApplyInput {
  changes: FileChange[];
  parent: WorkspaceVersion | null;
  reason?: string;
}
export interface WorkspaceApplyOutput {
  version: WorkspaceVersion;
  delta: WorkspaceDelta;
}

export interface WorkspaceReadInput {
  path: string;
  version?: WorkspaceVersion;
}
// `workspace:read` returns a discriminated result, not a thrown error, so
// subscribers can branch on absence without try/catch every time.
export type WorkspaceReadOutput =
  | { found: true; bytes: Bytes }
  | { found: false };

export interface WorkspaceListInput {
  version?: WorkspaceVersion;
  pathGlob?: string;
}
export interface WorkspaceListOutput {
  paths: string[];
}

export interface WorkspaceDiffInput {
  from: WorkspaceVersion | null;            // null = initial state
  to: WorkspaceVersion;
}
export interface WorkspaceDiffOutput {
  delta: WorkspaceDelta;
}
```

Add re-exports in `packages/core/src/index.ts`. In `packages/ipc-protocol/src/actions.ts`, replace the local `WorkspaceVersion` declaration with `import type { WorkspaceVersion } from '@ax/core'`.

**Step 3: Run all tests** — `pnpm build && pnpm test`. Both `@ax/core` and `@ax/ipc-protocol` must remain green. Existing 6.5a stub handler still satisfies the schema.

**Step 4: Commit**

```bash
git commit -am "feat(core): workspace contract types (Section 4.5)"
```

### Task 3: `MockWorkspace` test-harness plugin

The handoff explicitly calls this out: *"write a test-harness `MockWorkspace` plugin that passes the exact same assertions as `@ax/workspace-git`."* This is what proves the contract isn't accidentally git-shaped.

**Files:**
- Create: `packages/test-harness/src/mock-workspace.ts`
- Modify: `packages/test-harness/src/index.ts` — re-export
- Test: `packages/test-harness/src/__tests__/mock-workspace.test.ts`

**Step 1: Write the failing test**

```ts
// packages/test-harness/src/__tests__/mock-workspace.test.ts
import { describe, it, expect } from 'vitest';
import { createTestHarness } from '../harness.js';
import { createMockWorkspacePlugin } from '../mock-workspace.js';
import type {
  WorkspaceApplyInput, WorkspaceApplyOutput,
  WorkspaceReadInput,  WorkspaceReadOutput,
  WorkspaceVersion,
} from '@ax/core';

describe('MockWorkspace', () => {
  it('apply → read round-trips bytes', async () => {
    const harness = createTestHarness();
    await harness.load(createMockWorkspacePlugin());
    const r = await harness.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
      'workspace:apply', harness.ctx,
      { changes: [{ path: 'a.txt', kind: 'put', content: new TextEncoder().encode('hi') }],
        parent: null, reason: 'test' });
    const read = await harness.bus.call<WorkspaceReadInput, WorkspaceReadOutput>(
      'workspace:read', harness.ctx, { path: 'a.txt', version: r.version });
    expect(read.found).toBe(true);
    if (read.found) expect(new TextDecoder().decode(read.bytes)).toBe('hi');
  });

  it('parent mismatch rejects with a structured PluginError', async () => {
    const harness = createTestHarness();
    await harness.load(createMockWorkspacePlugin());
    const first = await harness.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
      'workspace:apply', harness.ctx, { changes: [], parent: null });
    await expect(harness.bus.call('workspace:apply', harness.ctx, {
      changes: [], parent: 'wrong' as WorkspaceVersion,
    })).rejects.toMatchObject({ code: 'parent-mismatch' });
  });
});
```

Run: FAIL (file missing).

**Step 2: Implement `MockWorkspace`**

In-memory linear history. Store `Map<WorkspaceVersion, Map<path, Bytes>>` plus `latest: WorkspaceVersion | null`. `apply` checks `parent === latest`; if not, throw `PluginError({ code: 'parent-mismatch', plugin: '@ax/test-harness/mock-workspace', hookName: 'workspace:apply', ... })`. Mint version as `mock-${counter++}` (intentionally NOT a SHA — proves nothing breaks if backends use opaque non-hash tokens). Implement all four service hooks (`apply`, `read`, `list`, `diff`).

**Step 3: Run tests, expect PASS.**

**Step 4: Commit** — `feat(test-harness): MockWorkspace plugin for contract validation`

### Task 4: Shared workspace contract test-suite

**The point:** an exported `runWorkspaceContract(loadPlugin)` function, called from both `MockWorkspace` test and `@ax/workspace-git` test (Task 7). Same assertions, different impls — proves the contract is interchangeable.

**Files:**
- Create: `packages/test-harness/src/workspace-contract.ts`
- Modify: `packages/test-harness/src/index.ts` — re-export `runWorkspaceContract`
- Modify: `packages/test-harness/src/__tests__/mock-workspace.test.ts` — call `runWorkspaceContract(createMockWorkspacePlugin)` and let it own the assertions

**Step 1: Write the contract suite (TDD here means: contract first, then re-run against MockWorkspace)**

```ts
// packages/test-harness/src/workspace-contract.ts
import { describe, it, expect } from 'vitest';
import type { Plugin } from '@ax/core';
import { createTestHarness } from './harness.js';
import type {
  WorkspaceApplyInput, WorkspaceApplyOutput,
  WorkspaceReadInput,  WorkspaceReadOutput,
  WorkspaceListInput,  WorkspaceListOutput,
  WorkspaceDiffInput,  WorkspaceDiffOutput,
  WorkspaceVersion,
} from '@ax/core';

export function runWorkspaceContract(label: string, makePlugin: () => Plugin): void {
  describe(`workspace contract: ${label}`, () => {
    async function load() {
      const h = createTestHarness();
      await h.load(makePlugin());
      return h;
    }
    const enc = new TextEncoder();

    it('initial apply uses parent: null', async () => {
      const h = await load();
      const r = await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply', h.ctx,
        { changes: [{ path: 'a', kind: 'put', content: enc.encode('1') }], parent: null });
      expect(r.delta.before).toBeNull();
      expect(r.delta.after).toBe(r.version);
      expect(r.delta.changes).toHaveLength(1);
      expect(r.delta.changes[0]).toMatchObject({ path: 'a', kind: 'added' });
    });

    it('second apply must pass the previous version as parent', async () => {
      const h = await load();
      const v1 = (await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply', h.ctx,
        { changes: [{ path: 'a', kind: 'put', content: enc.encode('1') }], parent: null }
      )).version;
      const v2 = await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply', h.ctx,
        { changes: [{ path: 'a', kind: 'put', content: enc.encode('2') }], parent: v1 });
      expect(v2.delta.before).toBe(v1);
      expect(v2.delta.changes[0].kind).toBe('modified');
    });

    it('parent mismatch raises PluginError with code: parent-mismatch', async () => {
      const h = await load();
      await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply', h.ctx, { changes: [], parent: null });
      await expect(h.bus.call('workspace:apply', h.ctx, {
        changes: [], parent: 'definitely-not-a-real-version' as WorkspaceVersion,
      })).rejects.toMatchObject({ code: 'parent-mismatch' });
    });

    it('read returns { found: false } for unknown path', async () => {
      const h = await load();
      const r = await h.bus.call<WorkspaceReadInput, WorkspaceReadOutput>(
        'workspace:read', h.ctx, { path: 'nope' });
      expect(r.found).toBe(false);
    });

    it('list with pathGlob honors the glob', async () => {
      const h = await load();
      await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>('workspace:apply', h.ctx, {
        changes: [
          { path: 'src/a.ts', kind: 'put', content: enc.encode('a') },
          { path: 'src/b.ts', kind: 'put', content: enc.encode('b') },
          { path: 'README.md', kind: 'put', content: enc.encode('r') },
        ], parent: null });
      const list = await h.bus.call<WorkspaceListInput, WorkspaceListOutput>(
        'workspace:list', h.ctx, { pathGlob: 'src/**' });
      expect([...list.paths].sort()).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('delete shows up as kind: deleted in the next delta', async () => {
      const h = await load();
      const v1 = (await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply', h.ctx,
        { changes: [{ path: 'a', kind: 'put', content: enc.encode('x') }], parent: null }
      )).version;
      const v2 = await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply', h.ctx,
        { changes: [{ path: 'a', kind: 'delete' }], parent: v1 });
      expect(v2.delta.changes[0]).toMatchObject({ path: 'a', kind: 'deleted' });
    });

    it('contentAfter is lazy — not invoked unless called', async () => {
      const h = await load();
      const r = await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply', h.ctx,
        { changes: [{ path: 'a', kind: 'put', content: enc.encode('x') }], parent: null });
      const ch = r.delta.changes[0];
      expect(typeof ch.contentAfter).toBe('function');
      expect(await ch.contentAfter!()).toEqual(enc.encode('x'));
    });

    it('diff between two versions returns the same delta shape', async () => {
      const h = await load();
      const v1 = (await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply', h.ctx,
        { changes: [{ path: 'a', kind: 'put', content: enc.encode('1') }], parent: null }
      )).version;
      const v2 = (await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply', h.ctx,
        { changes: [{ path: 'a', kind: 'put', content: enc.encode('2') }], parent: v1 }
      )).version;
      const diff = await h.bus.call<WorkspaceDiffInput, WorkspaceDiffOutput>(
        'workspace:diff', h.ctx, { from: v1, to: v2 });
      expect(diff.delta.before).toBe(v1);
      expect(diff.delta.after).toBe(v2);
      expect(diff.delta.changes[0].kind).toBe('modified');
    });

    it('opaque versions: subscribers must NOT depend on version string format', async () => {
      const h = await load();
      const r = await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply', h.ctx, { changes: [], parent: null });
      // Just a string — assert nothing about its shape. This test exists
      // primarily as a documentation pin: if a subscriber reaches in to
      // r.version.startsWith('sha') someday, they're violating the contract.
      expect(typeof r.version).toBe('string');
    });
  });
}
```

**Step 2: Wire MockWorkspace through the contract**

Replace `mock-workspace.test.ts` with:

```ts
import { runWorkspaceContract } from '../workspace-contract.js';
import { createMockWorkspacePlugin } from '../mock-workspace.js';
runWorkspaceContract('MockWorkspace', createMockWorkspacePlugin);
```

Run: `pnpm test --filter @ax/test-harness` — all suite assertions PASS against MockWorkspace.

**Step 3: Commit** — `test(test-harness): shared workspace contract suite`

### Task 5: Scaffold `@ax/workspace-git` package

**Files:**
- Create: `packages/workspace-git/package.json` — `dependencies`: `@ax/core`, `isomorphic-git`, `zod`. `devDependencies`: `@ax/test-harness`, `vitest`, `@types/node`. Pin `isomorphic-git` exactly (e.g. `1.27.1` — verify latest at implementation time and check for `postinstall` scripts per security-checklist).
- Create: `packages/workspace-git/tsconfig.json` (mirror `@ax/storage-sqlite`).
- Create: `packages/workspace-git/vitest.config.ts`.
- Create: `packages/workspace-git/src/plugin.ts` — empty exported factory `createWorkspaceGitPlugin(config: { repoRoot: string }): Plugin` that returns a manifest with `registers: ['workspace:apply', 'workspace:read', 'workspace:list', 'workspace:diff']`, `init` is a stub that throws `'not implemented'`.
- Create: `packages/workspace-git/src/index.ts`.
- Modify: root `pnpm-workspace.yaml` — already covers `packages/*`, no change needed.
- Modify: top-level `tsconfig.json` `references` array — add `{ "path": "packages/workspace-git" }`.

**Step 1: Write a failing import-only smoke test**

```ts
// packages/workspace-git/src/__tests__/scaffold.test.ts
import { describe, it, expect } from 'vitest';
import { createWorkspaceGitPlugin } from '../plugin.js';

describe('@ax/workspace-git scaffold', () => {
  it('exports a factory that builds a Plugin manifest', () => {
    const p = createWorkspaceGitPlugin({ repoRoot: '/tmp/repo' });
    expect(p.manifest.name).toBe('@ax/workspace-git');
    expect(p.manifest.registers).toEqual(
      expect.arrayContaining(['workspace:apply', 'workspace:read', 'workspace:list', 'workspace:diff']),
    );
  });
});
```

**Step 2: Run** — `pnpm install` (picks up new package), then `pnpm build && pnpm test --filter @ax/workspace-git`. Expect PASS.

**Step 3: Commit** — `scaffold(workspace-git): package skeleton + isomorphic-git pin`

### Task 6: TDD `@ax/workspace-git` against the shared contract

**Files:**
- Modify: `packages/workspace-git/src/plugin.ts` — implement `apply`/`read`/`list`/`diff`.
- Create: `packages/workspace-git/src/git.ts` — internal helpers wrapping `isomorphic-git`.
- Create: `packages/workspace-git/src/__tests__/contract.test.ts`.

**Step 1: Wire the shared contract test against `@ax/workspace-git`**

```ts
// packages/workspace-git/src/__tests__/contract.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkspaceContract } from '@ax/test-harness';
import { createWorkspaceGitPlugin } from '../plugin.js';

runWorkspaceContract('@ax/workspace-git', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'ax-ws-git-'));
  return createWorkspaceGitPlugin({ repoRoot });
});
```

Run: FAIL (suite hits the `'not implemented'` stub).

**Step 2: Implement against `isomorphic-git`**

Choose `isomorphic-git` over shelling out to `git` (decision rationale to record in `SECURITY.md` Task 7): pure-JS, no system git dependency at runtime in pods, no shell-injection surface from `git` argv construction. Cost: ~200KB bundle.

Per-instance bare repository at `repoRoot/repo.git`. `init()` calls `git.init({ fs, dir: repoRoot, bare: true, defaultBranch: 'main' })` and is idempotent (checks for `repoRoot/repo.git/HEAD`).

- **`workspace:apply`** — atomic ref update with parent-version check:
  1. If `parent !== null`, resolve `refs/heads/main`. If it doesn't equal `parent`, throw `PluginError({ code: 'parent-mismatch', plugin: '@ax/workspace-git', hookName: 'workspace:apply', message: \`expected parent ${parent}, got ${actual}\` })`.
  2. Build the new tree from the parent tree + changes (write blobs via `git.writeBlob`, build tree via `git.writeTree`). Empty change-set is allowed and yields a no-op commit (parent SHA returned as new version is acceptable; pick one rule and document — recommendation: **no-op apply returns the parent version unchanged, no commit written** — keeps history clean).
  3. Write commit with parent + agent-supplied `reason || 'workspace apply'`. Commit author/email comes from a fixed bot identity (no agent-supplied identity flows here — see security-checklist).
  4. Atomically update `refs/heads/main`. `isomorphic-git`'s `git.writeRef` accepts a `force` boolean; we use the lower-level pattern: read current ref, compare to expected parent, write new ref via `git.writeRef({ value: newSha })`. (Note: `isomorphic-git` does **not** expose `update-ref`'s native expected-old-value CAS. Implement compare-and-set in a small per-repo `Mutex` — single-replica only this slice.)
  5. Build the `WorkspaceDelta` from a `git.walk` between parent tree and new tree. Wrap `version: asWorkspaceVersion(newSha)`.

- **`workspace:read`** — `version ?? HEAD`, `git.readBlob({ oid, filepath })`. Catch `NotFoundError` → return `{ found: false }`.

- **`workspace:list`** — `git.walk` on the version tree; filter by `pathGlob` using `picomatch` (add to deps; pin) or a tiny in-repo glob (recommend `picomatch` — established).

- **`workspace:diff`** — walk `from` and `to` trees in lockstep; emit `added`/`modified`/`deleted` based on oid comparison.

- **Single-replica mutex.** Per-repo `Mutex` around apply (avoid two concurrent applies racing the ref). `node:async_hooks`-free; just a `Promise<void>` chain.

**Step 3: Run** — `pnpm test --filter @ax/workspace-git`. All contract assertions PASS.

**Step 4: Commit** — `feat(workspace-git): impl workspace:apply/read/list/diff via isomorphic-git`

### Task 7: `security-checklist` walk + `@ax/workspace-git` SECURITY.md

**Skill:** `security-checklist`

**Step 1: Walk the three threat models for `@ax/workspace-git`**

- **Sandbox:** Filesystem reach is `repoRoot` (caller-config'd at construction). Validate that `path` field of every `FileChange` is normalized + cannot escape (`..`, absolute, NUL bytes, drive letters). Use the legacy `safePath` helper as a port reference (`~/dev/ai/ax/src/utils/safe-path.ts`, 64 LOC) — port to `packages/workspace-git/src/safe-path.ts` (or `@ax/core/util/safe-path.ts` if a second plugin is about to need it; since k8s sandbox in Task 14 will, **port to `@ax/core` once and import**). Reject paths matching `/^\.git\//` or containing `/.git/` segments — agent must not write into `.git/` of the working tree even if there is no working tree (defense in depth).
- **Injection:** No prompt injection surface — no model output is interpolated into shell commands or HTTP URLs. `commit.message` is agent-supplied but only ever flows into the git object database; consumers via `workspace:applied` see it as an opaque `reason` string. Document: subscribers MUST NOT exec / interpolate `reason`.
- **Supply chain:** New runtime deps: `isomorphic-git` (pinned exactly), `picomatch` (pinned exactly). For each: check `npm view <pkg>@<v> scripts` for `pre/postinstall`/`prepare` (none expected for either, but verify); record maintainer org and download counts; `pnpm why isomorphic-git` to surface transitive surface.

**Step 2: Write `packages/workspace-git/SECURITY.md`**

Format: same shape as `packages/credentials/SECURITY.md` from 6.5e (read it first as a template). Sections: Sandbox / Injection / Supply chain, with the three-line summary at the top for paste-into-PR.

**Step 3: Commit** — `docs(workspace-git): SECURITY.md`

### Task 7b: Replace the IPC `workspace.commit-notify` stub

**Files:**
- Modify: `packages/ipc-server/src/handlers/workspace-commit-notify.ts` — replace stub with real impl.
- Modify: `packages/ipc-server/package.json` — `dependencies`: keep `@ax/core`. (Do **not** depend on `@ax/workspace-git` — invariant I2.)
- Test: `packages/ipc-server/src/handlers/__tests__/workspace-commit-notify.test.ts`.

**Background:** The runner sends one `workspace.commit-notify` per turn (turn-end, NOT per-tool-call — see MVP direction memo). Wire shape today: `{ parentVersion, commitRef, message }` and response `{ accepted, version, delta: null }`. The handler must:

1. Resolve `commitRef` (the runner's local snapshot identifier — runner-side this is its own working-tree commit SHA, but the host treats it as opaque) into the actual `FileChange[]` it represents. **Open question:** the current 6.5a stub doesn't ferry diff bytes; the real impl needs a way to obtain them. Two options the plan must close:

   - **(a)** Runner POSTs the diff in the request body alongside `commitRef`. Schema gains `changes: FileChange[]`. (Crisp; one round-trip.)
   - **(b)** Host's `@ax/workspace-git` pulls from the runner via an outbound IPC action. (Adds a second IPC direction; out of scope for this slice.)

   **Decision: (a).** Extend `WorkspaceCommitNotifyRequestSchema` to include `changes: FileChange[]` (already a `@ax/core` type — re-export through `@ax/ipc-protocol` as a Zod-validated mirror). Bump the IPC schema. Runner side (Task 7c) fans the diff into the request.

2. Fire `workspace:pre-apply` subscribers via `bus.fire('workspace:pre-apply', ctx, { changes, parent: parentVersion, reason: message })`. If rejected, return `{ accepted: false, reason }`.

3. Call `bus.call('workspace:apply', ctx, { changes, parent: parentVersion, reason: message })` to land the snapshot. Wrap in `try/catch` for `parent-mismatch` and surface as `{ accepted: false, reason: 'parent-mismatch: ...' }`.

4. Fire `workspace:applied` (subscriber-only) with the returned delta — observers (audit, scanners, skill validator) get it. The wire response stays `{ accepted: true, version, delta: null }` — **the wire NEVER carries a delta** (lazy fetchers don't survive serialization, and exposing it widens trust boundary). Subscribers run host-side only.

**Step 1: TDD the handler**

Write one happy-path and three sad-path tests (pre-apply rejects; parent mismatch; apply throws). Use a tiny mock workspace plugin (the Task 3 `MockWorkspace` is fit-for-purpose).

**Step 2: Implement.**

**Step 3: Commit** — `feat(ipc-server): real workspace.commit-notify wired to bus.fire/call`

### Task 7c: Runner-side — send diff with `workspace.commit-notify`

**Files:**
- Modify: `packages/agent-runner-core/src/ipc-client.ts` — add `changes` to the `workspace.commit-notify` payload type.
- Modify: `packages/agent-native-runner/src/turn-loop.ts` (or wherever the native runner currently fires the stub call) — collect file changes accumulated during the turn and send them.
- Modify: `packages/agent-claude-sdk-runner/src/runner.ts` (or the equivalent boundary file) — collect post-tool diffs and send them on `SDKResultMessage` / turn end.
- Test: each runner gets one test that exercises a multi-tool turn and asserts a single `workspace.commit-notify` request with the aggregate diff.

**Step 1: Write failing tests** for both runners. Use a fake IPC client that captures requests.

**Step 2: Implement.** Approach for both runners: maintain a per-turn `Map<path, { kind: 'put' | 'delete', content?: Bytes }>` populated by the file-io tool's PostToolUse hook (claude-sdk) or post-tool callback (native). On turn end, materialize as `FileChange[]` and send.

**Step 3: Commit** — `feat(runners): aggregate per-turn workspace diff into single commit-notify`

---

## Phase B — Postgres plumbing

### Task 8: `@ax/database-postgres` — Kysely instance factory

The handoff (deliverable 2) and architecture doc Section 6 both call out a dedicated database plugin. It owns the connection pool; stores call `database:get-instance` to obtain a Kysely client.

**Files:**
- Create: `packages/database-postgres/{package.json,tsconfig.json,vitest.config.ts}`. Deps: `@ax/core`, `kysely`, `pg`, `zod`. Pin all exactly.
- Create: `packages/database-postgres/src/plugin.ts`.
- Create: `packages/database-postgres/src/pool.ts` — `pg.Pool` wrapper.
- Test: `packages/database-postgres/src/__tests__/plugin.test.ts` — uses `testcontainers` to start a postgres container.

**Step 1: TDD** — three tests:
- `database:get-instance` returns a working Kysely instance (run `SELECT 1`).
- Two sequential calls return the **same** instance (singleton per plugin lifetime).
- Boot fails with a structured error if `connectionString` env var is missing.

Add `@testcontainers/postgresql` to `devDependencies` (not `dependencies`).

**Step 2: Implement**

```ts
// packages/database-postgres/src/plugin.ts
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { Plugin } from '@ax/core';
import { PluginError } from '@ax/core';

const PLUGIN_NAME = '@ax/database-postgres';

export interface DatabasePostgresConfig {
  connectionString: string;
  poolMax?: number;
}

export function createDatabasePostgresPlugin(config: DatabasePostgresConfig): Plugin {
  let db: Kysely<unknown> | undefined;
  let pool: Pool | undefined;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['database:get-instance'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      if (!config.connectionString) {
        throw new PluginError({
          code: 'invalid-config', plugin: PLUGIN_NAME,
          message: 'connectionString is required',
        });
      }
      pool = new Pool({ connectionString: config.connectionString, max: config.poolMax ?? 10 });
      db = new Kysely({ dialect: new PostgresDialect({ pool }) });

      bus.registerService<{}, { db: Kysely<unknown> }>(
        'database:get-instance',
        PLUGIN_NAME,
        async () => ({ db: db! }),
      );

      // TODO(kernel-shutdown): release pool on plugin shutdown when the kernel
      // ships the lifecycle hook (same TODO as @ax/storage-sqlite). One-shot
      // CLI runs are fine without it; long-lived host needs it before merge of
      // any "host stays up across requests" change.
    },
  };
}
```

**Step 3: Run tests with testcontainers** — `pnpm test --filter @ax/database-postgres`. Expect ~10–20s on cold container start.

**Step 4: Commit** — `feat(database-postgres): Kysely instance factory + pg pool`

### Task 9: `@ax/storage-postgres`

Same `storage:get` / `storage:set` contract as `@ax/storage-sqlite`. Owns its `kv_v1` table + per-plugin migration.

**Files:**
- Create: `packages/storage-postgres/{package.json,tsconfig.json,vitest.config.ts,src/plugin.ts,src/migrations.ts,src/__tests__/plugin.test.ts}`.

**Step 1: TDD** — one round-trip test (`set` → `get` returns same bytes), one absent-key test (`get` returns `{ value: undefined }`), one upsert test (`set` over existing key replaces value).

**Step 2: Implement**

- Migration runs in `init()`: read Kysely instance via `bus.call('database:get-instance')`, run `CREATE TABLE IF NOT EXISTS storage_postgres_v1_kv (key TEXT PRIMARY KEY, value BYTEA NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`. Table prefix `storage_postgres_v1_` is the plugin's namespace — the per-plugin-tables rule from Section 6.
- `storage:get` / `storage:set` wrap the same Kysely calls as sqlite, using `bytea` for value column. `Buffer ↔ Uint8Array` conversion at the edge.

**Step 3: Run** — testcontainers, expect PASS.

**Step 4: Commit** — `feat(storage-postgres): storage:get/set against postgres + per-plugin migration`

### Task 10: `@ax/eventbus-postgres`

LISTEN/NOTIFY-backed pub/sub. Same hook contract as `@ax/eventbus-inprocess`.

**Files:**
- Create: `packages/eventbus-postgres/{package.json,tsconfig.json,vitest.config.ts,src/plugin.ts,src/listener.ts,src/__tests__/plugin.test.ts}`.

**Step 1: TDD** — same three tests as in Task 1 but against postgres. Plus one cross-connection test: open two `@ax/eventbus-postgres` instances against the same DB, subscribe on instance A, emit from instance B, expect delivery.

**Step 2: Implement**

- One dedicated `pg.Client` (NOT pooled) per plugin instance, held open for `LISTEN`. Pool clients can be returned mid-listen, breaking subscriptions.
- Channel names quoted via `pg.escapeIdentifier` — never string-concatenated. Reject channel names containing characters outside `[a-zA-Z0-9_]` to keep the LISTEN identifier sanitization simple. (Documented invariant.)
- Payload: JSON-serialize `payload`. Postgres NOTIFY payload size cap is 8000 bytes — reject larger payloads with a structured `PluginError({ code: 'payload-too-large' })`. Document in `SECURITY.md` Task 11.
- Reconnect: on `Client.on('error')`, reconnect with exponential backoff (1s, 2s, 4s, capped at 30s); re-LISTEN every active channel.

**Step 3: Run** — testcontainers, expect PASS.

**Step 4: Commit** — `feat(eventbus-postgres): LISTEN/NOTIFY pub/sub with reconnect`

### Task 11: `security-checklist` for the postgres trio (database, storage, eventbus)

**Skill:** `security-checklist`

Walk the three threat models **once per package** (database-postgres, storage-postgres, eventbus-postgres). Write `SECURITY.md` in each. Per the handoff:

- **`@ax/database-postgres`** — connection string handling. `connectionString` comes from config (not user input); never logged at info+ (it contains password). Validate scheme is `postgres://` or `postgresql://`. Pool size capped (default 10).
- **`@ax/storage-postgres`** — Kysely parametrizes by default; spot-check no `sql.raw(${userInput})` anywhere. Migrations are version-pinned literal SQL.
- **`@ax/eventbus-postgres`** — channel name allow-list; payload size cap; identifier escaping.

Three SECURITY.md files committed.

**Commit:** `docs(postgres-trio): SECURITY.md for database/storage/eventbus`

### Task 12: `@ax/session-postgres`

Same `session:*` hook contract as `@ax/session-inmemory` (5 hooks: `create`, `resolve-token`, `queue-work`, `claim-work`, `terminate`). Long-poll wakeup uses LISTEN/NOTIFY through `@ax/eventbus-postgres` so cross-replica handoff works in Week 10+.

**Critical schema decision (handoff scope decision 4 + week-9.5 handoff scope decision 6):**

> Initial schema is session-resolution-only (token + sandbox metadata). `user_id` and `agent_id` columns are added by Week 9.5's migration — design the initial schema additively so 9.5 lands as a forward-only migration.

Translation: ship a `sessions_v1` table with **only** `(session_id PK, token UNIQUE, workspace_root, terminated, created_at)`. Do NOT add `user_id`/`agent_id` placeholders even nullable — Week 9.5 owns that migration.

**Files:**
- Create: `packages/session-postgres/{package.json,tsconfig.json,vitest.config.ts,src/plugin.ts,src/migrations.ts,src/store.ts,src/inbox.ts,src/__tests__/plugin.test.ts}`.

**Step 1: TDD** — port the test surface from `packages/session-inmemory/src/__tests__/` (the in-memory plugin already has good coverage). Run the **same** suite via a shared `runSessionContract` test fixture (factor out, similar approach to the workspace contract).

Optional but high-value: extract `runSessionContract` into `@ax/test-harness` and have `@ax/session-inmemory` adopt it too. Consider — but scope-cap at "if it's <30min of work, do it; else defer to a follow-up commit."

**Step 2: Implement**

Tables (this plugin owns them, prefix `session_postgres_v1_`):
- `session_postgres_v1_sessions (session_id TEXT PK, token TEXT UNIQUE NOT NULL, workspace_root TEXT NOT NULL, terminated BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`
- `session_postgres_v1_inbox (id BIGSERIAL PK, session_id TEXT NOT NULL, cursor BIGINT NOT NULL, type TEXT NOT NULL, payload JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(session_id, cursor))` — inbox cursor is per-session, monotonic.

NO foreign keys between these — even though `inbox.session_id` references `sessions.session_id` semantically, the per-plugin-tables rule says no FKs and we're already inside one plugin so it's fine; but recall the rule for cross-plugin: never. (Reaffirm in code comment.)

`session:claim-work` long-poll: `LISTEN session_inbox_<session_id>`; `NOTIFY session_inbox_<session_id>` on `queue-work`. Per Task 10, channel names are `session_inbox_` + session_id (sanitized at construction time — session IDs are `[a-zA-Z0-9-]+`).

Token minting matches `@ax/session-inmemory` exactly: `randomBytes(32).toString('base64url')` (43 chars, never JWT — invariant I9 from Week 4–6 audit).

**Step 3: Run tests** — testcontainers, expect PASS, including any imported contract suite.

**Step 4: Commit** — `feat(session-postgres): port session:* hooks with LISTEN/NOTIFY long-poll`

### Task 13: `@ax/preset-local` regression test

**The whole point of the plugin model** (handoff scope decision 6) is that switching deploy shapes doesn't change code. Verify `@ax/preset-local` (the single-host preset) still works after Phase B.

**Files:**
- Modify: `packages/cli/src/__tests__/main.test.ts` (or whichever existing CLI smoke test runs the local preset) — re-run against `pnpm test`, full suite green.

If `@ax/preset-local` doesn't exist yet as a meta-package (the cli today wires plugins directly in `main.ts`), this task is just a re-run of the existing CLI acceptance test. Confirm green; do not introduce a new `@ax/preset-local` here — Week 10+ can collapse the cli's hardcoded plugin set into a preset if it earns its keep.

**Commit:** none if no code changed; otherwise a small commit titled `test(cli): regression — local preset green after postgres trio lands`

---

## Phase C — k8s sandbox

### Task 14: `@ax/sandbox-k8s` — port + adapt

The architecture doc Section 10 explicitly names: *"per-pod logger, lifecycle reason capture, kill-with-reqId all carry over from Task 1-7."* Source: `~/dev/ai/ax/src/providers/sandbox/k8s.ts` (475 LOC, read-only reference).

This plugin registers `sandbox:open-session` (the same contract `@ax/sandbox-subprocess` from 6.5a registers). Pod image bundles **both** runner binaries (`@ax/agent-native-runner` + `@ax/agent-claude-sdk-runner`); session config picks which one starts (per handoff deliverable 1).

**Files:**
- Create: `packages/sandbox-k8s/{package.json,tsconfig.json,vitest.config.ts}`. Deps: `@ax/core`, `@kubernetes/client-node`, `zod`. Pin exactly. Dev deps: `@ax/test-harness`, `@ax/session-inmemory` (for tests).
- Create: `packages/sandbox-k8s/src/plugin.ts` — registers `sandbox:open-session`.
- Create: `packages/sandbox-k8s/src/pod-spec.ts` — port `buildPodSpec` from legacy.
- Create: `packages/sandbox-k8s/src/lifecycle.ts` — port `watchPodExit` (lifecycle reason capture: container-level `terminated.reason` + pod-level `status.reason`).
- Create: `packages/sandbox-k8s/src/kill.ts` — port the kill path with `reqId` binding through.
- Create: `packages/sandbox-k8s/src/k8s-api.ts` — thin wrapper around `@kubernetes/client-node` to make mocking trivial.
- Create: `packages/sandbox-k8s/src/__tests__/{open-session,lifecycle,kill}.test.ts`.

**Step 1: TDD with mocked k8s API**

Six tests (in order, each its own `it()` in the relevant file):

1. `open-session` mints a pod name `ax-sandbox-${shortUuid}`, builds a pod spec with `AX_REQUEST_ID`, `AX_SESSION_TOKEN`, `AX_SESSION_ID`, `AX_RUNNER_BINARY` env vars (the same quadruple `@ax/sandbox-subprocess` passes today), calls `coreV1Api.createNamespacedPod` with the spec.
2. Per-pod child logger is `ctx.logger.child({ reqId, podName, pid })` and is bound **before** the pod is created (so the create-failure log carries the bindings).
3. Lifecycle reason capture distinguishes container-level (`terminated.reason === 'OOMKilled' | 'Error'`) from pod-level (`status.reason === 'Evicted' | 'NodeLost'`). Both surface in the `exited` promise's resolution as `{ reason: '...' }`.
4. `kill()` sends `deleteNamespacedPod` with `gracePeriodSeconds: 5` (matching legacy `SIGKILL_DELAY_MS = 5_000`); on 404 (pod-already-gone, see legacy `isPodGoneError`), resolves successfully without warn.
5. Runner-binary selection: `open-session` reads `runnerBinary` from input (the same `OpenSessionInputSchema` `@ax/sandbox-subprocess` validates) and passes it through to the pod env. The pod's container `command` invokes `node $AX_RUNNER_BINARY` — same shape as subprocess.
6. Pod spec sets `runtimeClassName: 'gvisor'` by default (per legacy line 27), `imagePullSecrets` from config, resource limits `cpu: 1, memory: '1Gi'` (defaults from legacy lines 30–32). Image is config-supplied with sane default `ax-next/agent:latest`.

**Step 2: Implement.**

Adapt the legacy patterns. **Do NOT carry over** legacy's orchestration glue (`server-completions.ts`, IPC handler dispatcher) — the architecture doc Section 10 is explicit. Lift only the adapters: `buildPodSpec`, `watchPodExit`, `isPodGoneError`, the per-pod child-logger pattern.

Important shape change from legacy: legacy's `SandboxProvider.spawn` returns a `SandboxProcess` with synthetic PID + IPC dispatch. v2's `sandbox:open-session` returns `{ socketPath: string, handle: { kill, exited, ... } }` — for k8s, `socketPath` is replaced by an HTTP URL the runner connects back over. The 6.5a design doc Section "Wire surface" calls this out: in k8s mode `ipc:transport` is `ipc-http` (vs `ipc-unix-socket` for subprocess). **Out of scope for this slice:** building `@ax/ipc-http`. For Week 7–9, `@ax/sandbox-k8s` returns a placeholder socket path that the kind/minikube acceptance test (Task 22) port-forwards to the pod's HTTP port. Document this seam clearly in `SECURITY.md` Task 17 — the real `ipc-http` plugin is Week 10–12 deliverable.

Wait — re-read handoff. The handoff goal is *"deploy v2 to a real k8s cluster, run a real chat."* That requires `ipc-http`. Let me revise: **add `@ax/ipc-http` as a Phase C deliverable.** Insert as Task 14b.

### Task 14b: `@ax/ipc-http` — HTTP-mode IPC server + client

Mirror of `@ax/ipc-server` (which is Unix-socket today). Same dispatcher, same handlers — just an HTTP listener.

**Files:**
- Create: `packages/ipc-http/{package.json,tsconfig.json,vitest.config.ts,src/{plugin,listener}.ts,src/__tests__/listener.test.ts}`.
- Modify: `packages/ipc-server/src/dispatcher.ts` — verify it's already shape-compatible (handlers take `(rawPayload, ctx)`, return `{status, body}`); if not, factor the dispatcher into a transport-agnostic core.

The Section 4 transport-agnostic constraint says core never sees socket paths or URLs. Today `@ax/sandbox-subprocess` returns `{ socketPath }`; for k8s it should return... what? The right answer: **`SandboxHandle` exposes opaque `connectInfo`** (not socket-path, not URL — opaque to the runner-spawner). The runner reads it. For subprocess, runner's IPC client is told a Unix socket path via env. For k8s, the runner is told an HTTP URL (the pod itself listens on `0.0.0.0:7777`; the host connects out via `cluster-internal-IP:7777`).

**Punt judgment:** This is a non-trivial design fork. Two options:

- **(a)** Keep `socketPath` in the `sandbox:open-session` return, treat it as opaque path-or-URL — runner-side IPC client branches on prefix (`http://` vs `/`). Quick, but field name `socketPath` lies for k8s.
- **(b)** Rename `sandbox:open-session` return to `{ runnerEndpoint: string }` (opaque URI). Both subprocess and k8s impls return a URI; subprocess returns `unix:///tmp/.../sock`, k8s returns `http://10.0.0.5:7777`. Runner-side IPC client parses the scheme.

**Recommendation (b).** I1 says no transport-specific field names. Today's `socketPath` was added in 6.5a before k8s was on the table — this slice is the right time to fix the field name. **Cost:** touches `@ax/sandbox-subprocess`, `@ax/agent-runner-core`'s IPC client, `@ax/ipc-server`, `@ax/chat-orchestrator`. All in one PR, all behind tests.

Adjust Task 14b: rename `socketPath` → `runnerEndpoint` across the codebase; introduce two transport adapters (`unix:` and `http:`) in `@ax/agent-runner-core/src/ipc-client.ts`. Same handler set on the host.

**Step 1: TDD** — write the rename test first: a sandbox impl whose `open-session` returns `{ runnerEndpoint: 'unix:///tmp/xyz/sock' }` works end-to-end via `@ax/ipc-server`; another impl returns `{ runnerEndpoint: 'http://127.0.0.1:0/' }` and works via `@ax/ipc-http` (port-0 lets node bind to any free port).

**Step 2: Implement** — the rename, then `@ax/ipc-http` listener (Node `http` module, no Express; the dispatcher is already framework-free).

**Step 3: Run full suite** — every existing test in `@ax/sandbox-subprocess`, `@ax/ipc-server`, `@ax/agent-runner-core`, `@ax/chat-orchestrator` must remain green after the rename.

**Step 4: Commit** — `refactor(sandbox): rename socketPath → runnerEndpoint (opaque URI)` + `feat(ipc-http): HTTP-mode IPC listener`

### Task 15: `@ax/sandbox-k8s` — wire `runnerEndpoint`

Continue Task 14: now that the field is opaque, `@ax/sandbox-k8s.open-session` returns `{ runnerEndpoint: 'http://${podIp}:7777' }`. The host's `@ax/ipc-http` plugin listens on `0.0.0.0:7777` inside its own pod; the runner pod connects out to the host pod's service DNS — but wait, that's host-side. Re-clarify direction:

In 6.5a the topology is **runner-runs-IPC-server, host-connects-in.** Re-read `packages/sandbox-subprocess/src/open-session.ts`:

> *"The runner connects back over a unix socket whose path we create in a mode-0700 tempdir."*

So **runner is the IPC server**. For subprocess: runner listens on a Unix socket; host connects to it. For k8s: runner pod listens on HTTP (`0.0.0.0:7777`); host connects via `http://<pod-ip>:7777`.

OK — Task 15 implementation: pod spec exposes containerPort 7777, host's `sandbox:open-session` waits for the pod to be `Ready`, fetches `pod.status.podIP`, returns `runnerEndpoint: \`http://${podIP}:7777\``. The k8s `NetworkPolicy` (Task 19 manifests) restricts pod-to-pod traffic so only the host pod can reach `7777`.

**Step 1: Add a test** that mocks the k8s API to return `podIP: '10.42.0.5'` and asserts the returned `runnerEndpoint === 'http://10.42.0.5:7777'`.

**Step 2: Implement** — pod-readiness wait via `watch` API on `metadata.name=...` until `status.conditions[type=Ready].status === 'True'` (timeout 60s, configurable).

**Step 3: Commit** — `feat(sandbox-k8s): runnerEndpoint resolution from pod IP`

### Task 16: `@ax/sandbox-k8s` lifecycle hardening

Port the legacy lifecycle robustness items from `~/dev/ai/ax/src/providers/sandbox/k8s.ts`:

- `isPodGoneError` (legacy lines 38–50) — port verbatim into `kill.ts`. 404 from `deleteNamespacedPod` is success (idempotent kill).
- Container-level vs pod-level reason (legacy lines 280–288) — port into `lifecycle.ts`. The `exited` promise resolves with `{ code, signal, reason }` where `reason` is `'OOMKilled' | 'Error' | 'Evicted' | 'NodeLost' | 'Completed' | undefined`.
- k8s-native safety net (legacy line 210): `activeDeadlineSeconds` on the pod spec — kills the pod even if the host crashes. Defaults to 3600s (1h), configurable per session.
- Per-pod child logger (legacy line 347) — `reqId.slice(-8)` as `reqId` short-form, plus `podName` and synthetic `pid`. Logger is bound once at pod-create time and reused for every lifecycle log.

Each is a dedicated test under `packages/sandbox-k8s/src/__tests__/lifecycle.test.ts`.

**Commit:** `feat(sandbox-k8s): lifecycle reason capture + idempotent kill + activeDeadlineSeconds`

### Task 17: `security-checklist` for `@ax/sandbox-k8s`

**Skill:** `security-checklist`

The handoff calls this *"the single biggest blast-radius surface."* Walk all three threat models in detail. Output `packages/sandbox-k8s/SECURITY.md`.

- **Sandbox escape (pod-to-node, pod-to-pod, pod-to-control-plane):**
  - `runtimeClassName: 'gvisor'` by default — userspace kernel reduces pod-to-node syscall surface. Document fallback (some clusters lack gvisor; explicit config opt-out required + warn-loud).
  - `automountServiceAccountToken: false` on the pod spec — runner pods do **not** get k8s API access (host pod does, via its own SA).
  - `securityContext: { runAsNonRoot: true, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, readOnlyRootFilesystem: true (with emptyDir for /tmp + /workspace) }`.
  - Resource limits enforced (cpu, memory, ephemeral-storage). No `cpu` request without limit (k8s schedules without bound otherwise).
  - NetworkPolicy (Task 19): runner pods cannot egress to non-host pods, cannot reach k8s API server, can reach approved domains via web-proxy only (Week 10+ adds the proxy; for now egress is restricted to host pod + DNS).
  - **Host's k8s capability:** the host pod's ServiceAccount needs `pods: create/delete/get/list/watch` in **one namespace** (the runner namespace). No cluster-scoped verbs. No `pods/exec`. Document the minimal Role.
- **Prompt injection:** Pod spec is built from validated config + caller-supplied `sessionId`/`runnerBinary` (already validated by `OpenSessionInputSchema`). LLM output never reaches `buildPodSpec`. Tool outputs flow through the runner's IPC client; they round-trip back to the host as opaque payloads, never interpolated into k8s API calls. State this in one line.
- **Supply chain:** New runtime dep `@kubernetes/client-node` (pinned exactly). Check install-time scripts (none expected; verify). The k8s client has a non-trivial transitive surface; spot-check via `pnpm why @kubernetes/client-node`.

**Commit:** `docs(sandbox-k8s): SECURITY.md (security-checklist output)`

---

## Phase D — Preset & deploy

### Task 18: `@ax/preset-k8s` meta-package

Per architecture doc Section 9: a preset is just a meta-package with deps. Bumping it ships a coordinated release of "k8s mode is now this set of plugin versions."

**Files:**
- Create: `presets/k8s/package.json` — `dependencies` exactly: `@ax/core`, `@ax/cli`, `@ax/database-postgres`, `@ax/storage-postgres`, `@ax/eventbus-postgres`, `@ax/session-postgres`, `@ax/workspace-git`, `@ax/sandbox-k8s`, `@ax/ipc-http`, `@ax/llm-anthropic`, `@ax/llm-proxy-anthropic-format`, `@ax/agent-claude-sdk-runner`, `@ax/agent-runner-core`, `@ax/chat-orchestrator`, `@ax/tool-bash`, `@ax/tool-file-io`, `@ax/tool-dispatcher`, `@ax/audit-log`, `@ax/mcp-client`, `@ax/credentials`. (Verify exact deps against current `presets/local/package.json` for shape; create `presets/local` first if absent — see Task 13.)
- Create: `presets/k8s/src/index.ts` — exports `createK8sPlugins(config)` that returns the assembled plugin array (matches the pattern in `packages/cli/src/main.ts` today).
- Modify: `pnpm-workspace.yaml` — already covers `presets/*`.

**Step 1: TDD** — one test that loads the preset against an in-memory bus + mocks for k8s/postgres and verifies all required `registers` are satisfied (no `no-service` errors at boot). The test does NOT need a real cluster — preset assembly is a wiring concern.

**Step 2: Implement** the wiring.

**Step 3: Commit** — `feat(preset-k8s): meta-package + plugin wiring`

### Task 19: Deploy manifests — port from legacy Helm chart

The handoff (scope decision 5): *"Helm? Kustomize? Raw manifests? Out of scope for the plan itself — whatever legacy uses (`~/dev/ai/ax/deploy/` or similar) is fine. Port, don't design."*

Legacy uses Helm: `~/dev/ai/ax/charts/ax/`. Port the relevant subset to `deploy/charts/ax-next/`.

**Files to port (from `~/dev/ai/ax/charts/ax/templates/`):**
- `host/deployment.yaml` — host pod spec (replicas: 1).
- `host/service.yaml` — host service (ClusterIP).
- `host/ingress.yaml` — ingress (optional; gate behind values.ingress.enabled).
- `host/serviceaccount.yaml`, `host/role.yaml`, `host/rolebinding.yaml` — RBAC. **Re-write Role from scratch** with the minimum verbs (`pods: create/delete/get/list/watch`); legacy's role is too broad for this slice.
- `networkpolicies/sandbox-restrict.yaml` — runner pod egress restriction.
- `networkpolicies/agent-runtime-network.yaml` — host↔runner allow.
- `postgresql-init-job.yaml` — bootstraps the database (owned-by-host vs externally provisioned: support both via `values.postgres.external` flag).
- `configmap-ax-config.yaml` — mounts `ax.config.ts` into the host pod.
- `hook-secret.yaml` — `AX_CREDENTIALS_KEY` (from 6.5e) + postgres password.

**Files to NOT port:**
- `git-server-*.yaml` — legacy used a separate git-server pod for multi-replica. We're single-replica; `@ax/workspace-git` writes to a local PVC. Add a `host/pvc.yaml` for the workspace volume instead.
- `web-proxy-*.yaml` — Week 10+ adds the egress proxy.
- Anything related to admin OAuth / agents — Week 9.5.

**Files:**
- Create: `deploy/charts/ax-next/Chart.yaml`, `deploy/charts/ax-next/values.yaml`, `deploy/charts/ax-next/templates/host/{deployment,service,role,rolebinding,serviceaccount,pvc}.yaml`, `deploy/charts/ax-next/templates/networkpolicies/{sandbox-restrict,agent-runtime-network}.yaml`, `deploy/charts/ax-next/templates/{configmap-ax-config,hook-secret,postgresql-init-job}.yaml`, `deploy/charts/ax-next/kind-dev-values.yaml`.
- Create: `deploy/README.md` — how to deploy to kind for local verification (`kind create cluster`, `helm install ax-next ./deploy/charts/ax-next -f kind-dev-values.yaml`).

**Step 1: Port** — for each file, `cp` from legacy + adjust resource names (`ax` → `ax-next`), strip references to deferred features. Diff against legacy to make scope cuts visible in the PR.

**Step 2: Lint** — `helm lint deploy/charts/ax-next` and `helm template deploy/charts/ax-next -f deploy/charts/ax-next/kind-dev-values.yaml | kubeval -` (or `kubeconform`). Both green before commit.

**Step 3: Commit** — `feat(deploy): Helm chart for k8s deployment (ported from legacy)`

### Task 19b: `security-checklist` for the deploy manifests

**Skill:** `security-checklist`

The Helm chart isn't application code, but it's a security boundary. Walk:

- **Sandbox:** RBAC verbs, NetworkPolicies, runtimeClassName, pod securityContext defaults. State each non-default capability granted.
- **Injection:** N/A with reason — manifests are static templates with no model/tool input flowing in. Helm values are operator-provided.
- **Supply chain:** subchart `postgresql-16.7.27.tgz` — pin exactly, document where it came from (Bitnami chart repo), check for known CVEs at the pinned version.

Output: `deploy/charts/ax-next/SECURITY.md`.

**Commit:** `docs(deploy): SECURITY.md`

---

## Phase E — Acceptance & ship

### Task 20: CI acceptance — `@ax/preset-k8s` end-to-end with mocked k8s + real postgres

The handoff acceptance line: *"Automated (CI): mock k8s API, mock postgres (or use testcontainers), exercise the full plugin chain end-to-end on a laptop. Plan for ~30s test runtime."*

**Files:**
- Create: `presets/k8s/src/__tests__/acceptance.test.ts`.

**Step 1: Write the test**

Boots `@ax/preset-k8s` against:
- `testcontainers` postgres (real DB),
- mocked `k8s:api` (the same `mockKubeApi()` used in Task 14 unit tests, but driven from preset-load),
- mocked `llm:call` returning a canned response that triggers a single bash tool call,
- the real claude-sdk runner OR a fake runner that exercises the host-side workspace + storage path. (Choose the fake — testing the real claude-sdk runner end-to-end belongs to its own test file. The preset acceptance test is checking *wiring*, not runner behavior.)

Asserts: a chat completes, a row landed in `session_postgres_v1_sessions`, a row landed in `storage_postgres_v1_kv` (audit-log writes via storage), a workspace version was minted in `@ax/workspace-git`'s repo dir.

Expected runtime: 25–40s (testcontainers cold start). Mark with `it.concurrent` carefully — postgres container is a shared resource; serial is safer.

**Step 2: Run** — `pnpm test --filter @ax/preset-k8s -- acceptance`. Expect PASS.

**Step 3: CI integration** — verify the existing GitHub Actions workflow (or `pnpm test` root) runs preset tests. If not, add a job. Testcontainers needs Docker available — gate on `runs-on: ubuntu-latest` (Docker is preinstalled).

**Step 4: Commit** — `test(preset-k8s): CI acceptance — full chain end-to-end with testcontainers pg`

### Task 21: Manual acceptance on `kind`

Not subagent-executable (manual). Document the steps; produce a `deploy/MANUAL-ACCEPTANCE.md`.

**Steps to document:**

```bash
# 1. Build the runner image
docker build -t ax-next/agent:dev -f deploy/Dockerfile.agent .
kind create cluster --name ax-next-dev
kind load docker-image ax-next/agent:dev --name ax-next-dev

# 2. Install the chart
helm install ax-next deploy/charts/ax-next \
  -f deploy/charts/ax-next/kind-dev-values.yaml \
  --set anthropic.apiKey=$ANTHROPIC_API_KEY

# 3. Port-forward the host
kubectl port-forward svc/ax-next-host 8080:80

# 4. Send a chat via the CLI
ax-next chat --endpoint http://localhost:8080 "list the files in /workspace"

# 5. Verify
#    - Response includes a bash output with file listing
#    - kubectl get pods -l ax-runner shows a pod was created+terminated
#    - kubectl exec ax-next-host -- psql -c "select count(*) from session_postgres_v1_sessions" > 0
#    - kubectl exec ax-next-host -- ls /workspace-data/repo.git/refs/heads/main exists
```

**Acceptance criteria** (any failure = block merge):
- Chat returns a response that actually executed a bash tool in a runner pod.
- `chat:end` event landed in `@ax/audit-log`'s storage rows (read via psql).
- A workspace version was minted (head ref exists).
- No errors in host pod logs at level >= warn.
- Cleanup: `helm uninstall ax-next` followed by `kubectl get pods` shows zero `ax-runner-*` pods within 60s.

**Commit:** `docs(deploy): manual acceptance steps for kind`

### Task 22: Changeset

**Skill:** none — this is a `@changesets/cli` mechanical step.

```bash
pnpm changeset
```

Choose **minor bump** for every new package (`@ax/eventbus-inprocess`, `@ax/database-postgres`, `@ax/storage-postgres`, `@ax/eventbus-postgres`, `@ax/session-postgres`, `@ax/workspace-git`, `@ax/sandbox-k8s`, `@ax/ipc-http`, `@ax/preset-k8s`). Patch bump for `@ax/core` (workspace types added — additive), `@ax/ipc-protocol` (`changes` field added to `WorkspaceCommitNotifyRequest` — additive), `@ax/agent-runner-core`, `@ax/agent-native-runner`, `@ax/agent-claude-sdk-runner`, `@ax/sandbox-subprocess`, `@ax/ipc-server`, `@ax/chat-orchestrator` (all touched by the `socketPath → runnerEndpoint` rename).

Changeset summary copy: paraphrase the goal + invariant audit from this plan's header. Aim for ~10 lines.

**Commit:** `chore: changeset for week 7-9 (k8s + postgres + workspace)`

### Task 23: PR notes

**Files:**
- Create: `docs/plans/2026-04-24-week-7-9-pr-notes.md`.

Sections (mirror `docs/plans/2026-04-24-week-6.5e-pr-notes.md` for shape):
1. **Summary** — one paragraph.
2. **Five-invariant audit** — copy from this plan's header, marking each ✅ with the test/file that proves it.
3. **Boundary review** — copy from this plan's header.
4. **Per-package security review** — three-line summary from each `SECURITY.md` (Tasks 7, 11, 17, 19b).
5. **Acceptance evidence** — paste the CI acceptance test output (Task 20) + a `kind` run summary (Task 21).
6. **Scope cuts deferred to Week 10–12** — `@ax/workspace-git-http` (multi-replica), `@ax/web-proxy` (egress proxy), `@ax/audit-postgres` (still using `@ax/storage-postgres` for now via `@ax/audit-log`).
7. **Diff stats** — `git diff --stat main..HEAD`.

**Commit:** `docs: PR notes for week 7-9`

### Task 24: Final verification pass

**Skill:** `superpowers:verification-before-completion`

**Steps:**

1. `pnpm install && pnpm build` — clean build from scratch; expect zero errors.
2. `pnpm test` — full suite; expect ALL green. Note runtime; flag if >5min total.
3. `pnpm lint` — no errors.
4. `git status` — only the expected files; no stray artifacts.
5. `git log --oneline main..HEAD | wc -l` — task count is reasonable (~25 commits).
6. Re-read this plan's header. For each ✅ in the five-invariant audit, name the file + line that proves it. Any ✅ without proof → fix.
7. Re-read each `SECURITY.md` produced. Each must have non-N/A entries for the threat models the package actually crosses.
8. Push the branch: `git push -u origin feat/week-7-9-k8s-deployment`.
9. Open the PR: `gh pr create --title "Week 7-9: k8s deployment shape" --body "$(cat docs/plans/2026-04-24-week-7-9-pr-notes.md)"`.
10. Report PR URL.

---

## Appendix A — Files touched (running list, for code review)

By package, alphabetical:

- `@ax/agent-claude-sdk-runner` — turn-end diff aggregation (Task 7c)
- `@ax/agent-native-runner` — turn-end diff aggregation (Task 7c)
- `@ax/agent-runner-core` — `runnerEndpoint` URI parsing in IPC client (Task 14b)
- `@ax/chat-orchestrator` — handle the renamed return field (Task 14b)
- `@ax/cli` — preset-k8s wiring smoke (Task 13, 18)
- `@ax/core` — workspace types (Task 2), maybe `@ax/core/util/safe-path` if shared (Task 7/14)
- `@ax/database-postgres` — new (Task 8) + SECURITY.md (Task 11)
- `@ax/eventbus-inprocess` — fill in skeleton (Task 1)
- `@ax/eventbus-postgres` — new (Task 10) + SECURITY.md (Task 11)
- `@ax/ipc-http` — new (Task 14b)
- `@ax/ipc-protocol` — `WorkspaceCommitNotifyRequest` gains `changes` (Task 7b), `WorkspaceVersion` import path change (Task 2)
- `@ax/ipc-server` — real `workspace.commit-notify` handler (Task 7b), `runnerEndpoint` rename (Task 14b)
- `@ax/sandbox-k8s` — new (Tasks 14, 14b, 15, 16) + SECURITY.md (Task 17)
- `@ax/sandbox-subprocess` — `runnerEndpoint` rename (Task 14b)
- `@ax/session-postgres` — new (Task 12)
- `@ax/storage-postgres` — new (Task 9) + SECURITY.md (Task 11)
- `@ax/test-harness` — `MockWorkspace` (Task 3), `runWorkspaceContract` (Task 4)
- `@ax/workspace-git` — new (Tasks 5, 6) + SECURITY.md (Task 7)
- `@ax/preset-k8s` — new (Task 18)
- `deploy/charts/ax-next/` — new Helm chart (Task 19) + SECURITY.md (Task 19b)
- `docs/plans/2026-04-24-week-7-9-pr-notes.md` — new (Task 23)

---

## Appendix B — Decisions log for this plan

- **Single workspace impl** (vs both `workspace-git` + `workspace-git-http`). **Single.** Multi-replica is a hard problem; single-replica deploy proves the shape. (Handoff scope decision 2 → recommendation a.)
- **Ship `@ax/eventbus-inprocess` now.** Two impls validate the contract on day one. (Handoff scope decision 3.)
- **Per-plugin migrations, no cross-FK.** Architecture doc Section 6 + handoff scope decision 4.
- **`isomorphic-git` over shelling to git binary.** Pure-JS, no shell-injection surface, no system git dependency in pods. Cost: ~200KB.
- **`@ax/ipc-http` joins this slice.** k8s acceptance requires HTTP IPC; can't ship a k8s preset that doesn't actually work. Catalogued as Task 14b.
- **Rename `socketPath` → `runnerEndpoint`** (opaque URI). Cleans up an I1 violation that 6.5a introduced before k8s was on the table. Same PR — touches subprocess/k8s/runner-core/ipc-server/chat-orchestrator atomically.
- **Initial `@ax/session-postgres` schema is session-resolution-only.** No `user_id`/`agent_id` placeholders — Week 9.5 owns that migration as forward-only. (Handoff deliverable 5 + Week 9.5 handoff scope decision 6.)
- **Workspace commits are turn-end.** Single `workspace.commit-notify` per turn with aggregate diff; no per-tool-call commits. (Handoff line 38 + MVP direction memo.)
- **`MockWorkspace` test plugin is a deliverable, not just test scaffolding.** It's how we prove the contract isn't accidentally git-shaped. (Handoff scope decision 1.)
- **`@ax/preset-local` does not regress.** Verified by Task 13. Plugin model = deploy-shape switching without code changes (handoff scope decision 6).
- **Helm chart, ported from legacy.** `git-server-*.yaml`, `web-proxy-*.yaml`, admin/OAuth templates intentionally NOT ported. (Handoff scope decision 5.)
