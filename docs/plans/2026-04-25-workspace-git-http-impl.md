# `@ax/workspace-git-http` implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan one task at a time, with code review between tasks.

**Goal:** Make the four `workspace:*` service hooks work across multiple host replicas without serializing through a single in-process mutex, by extracting the existing implementation into `@ax/workspace-git-core` and shipping a new `@ax/workspace-git-http` plugin pair (host-side HTTP client plugin + pod-side HTTP server) plus the Helm chart pieces (git-server Deployment / Service / PVC / NetworkPolicy / values).

**Architecture:** Three-package split mirroring `@ax/ipc-core` / `@ax/ipc-http` from PR #10. `@ax/workspace-git-core` exports the existing impl as a function (mutex stays — it's still correct *for a single-process owner of the repo*). `@ax/workspace-git` shrinks to a thin wrapper that registers hooks against a local bare repo (single-replica path, kept for the local CLI). `@ax/workspace-git-http` exports both a host-side plugin (registers four hooks, forwards each over HTTP) and a pod-side server factory (wraps core, listens on TCP, single replica by design — exactly one process owns the repo). All nine `runWorkspaceContract` assertions plus a new multi-replica concurrency test become the I1 proof.

**Tech Stack:** TypeScript, `node:http` (no framework), `isomorphic-git`, `picomatch`, `zod` for wire-protocol schemas, vitest, Helm.

**Pre-flight assumptions verified:**
- Current branch: `main`. ✓
- Follow-up #1 (HTTP runner-IPC) is merged: PR #10, commit `aac0dfd`. ✓
- `@ax/ipc-core` exists with reusable primitives (`authenticate`, `readJsonBody`, `writeJsonOk`, `writeJsonError`, error helpers). ✓
- `@ax/workspace-git`'s `impl.ts` is intact at `packages/workspace-git/src/impl.ts` — registers all four hooks, mutex at lines 48-63, validatePath at 84-136, empty-turn short-circuit at 388-397.
- `runWorkspaceContract` (`packages/test-harness/src/workspace-contract.ts`) ships 9 assertions and is genuinely backend-agnostic (mock-workspace test proves it).

**Branch:** `feat/workspace-git-http`, off `main`.

**Estimated total: ~1100–1500 LOC across impl, tests, chart, and SECURITY.md docs. 2–3 focused days.**

---

## Operating notes for the executing session

- **Read these first** (already covered, but reload if context gets pruned):
  - `docs/plans/2026-04-25-workspace-git-http-handoff.md` — architecture rationale + scope decisions.
  - `packages/workspace-git/src/impl.ts` — the code being extracted.
  - `packages/ipc-http/src/listener.ts` + `packages/ipc-http/src/plugin.ts` — the structural model to mirror for the pod-side server.
  - `packages/agent-runner-core/src/ipc-client.ts` — the structural model to mirror for the host-side HTTP client (request loop, retry, timeout, response cap).
  - `packages/ipc-http/SECURITY.md` — the SECURITY.md template for `@ax/workspace-git-http`.
  - `packages/workspace-git/SECURITY.md` — the substantive walk that mostly moves into `@ax/workspace-git-core/SECURITY.md`.
- **Invariants this slice must NOT regress** (from `CLAUDE.md`):
  - **I1** transport/storage-agnostic hook surface — neither package exposes git or HTTP vocabulary in payloads. The `WorkspaceVersion` opaque-string contract holds end-to-end.
  - **I2** no cross-plugin imports beyond the hook bus. `@ax/workspace-git-http`'s host-side plugin must NOT import `@ax/workspace-git-core` (the host doesn't know git). The pod-side server is a process, not a plugin, so it can import core directly.
  - **I3** no half-wired plugins. Each new package ships with tests + acceptance hookup in the same PR.
  - **I4** one source of truth — protocol schemas live in one place (decision below).
  - **I5** capabilities explicit and minimized — host-side plugin has network-out only to a configured base URL; pod-side server has filesystem to one repoRoot, network-in on one port, no egress.
- **Bug-fix-policy reminder:** any bug surfaced during execution gets a regression test BEFORE the fix is considered done.
- **Empty-turn short-circuit (`impl.ts:388-397`)** must be preserved over the wire — the host plugin detects `changes.length === 0 && currentVersion !== null` *client-side* and returns the no-op delta without round-tripping. This keeps quiet turns from hammering the git-server pod.
- **Scope decisions** (resolved up-front from the handoff so the executing session doesn't relitigate):
  1. **Protocol location:** workspace-specific request/response schemas live in a new `packages/workspace-protocol` package. Why not in `@ax/ipc-protocol`: workspace and runner-IPC are different concerns and we don't want a circular dependency where every workspace plugin pulls the IPC protocol's wire-error envelope. Keep them adjacent but separate; both reuse `@ax/ipc-core`'s primitives at the transport layer.
  2. **Reuse ipc-core server-side primitives:** YES. `authenticate`, `readJsonBody`, `writeJsonOk`, `writeJsonError` are all transport-shaped, not action-shaped. The git-server's HTTP listener becomes ~80 lines of "compose primitives, register routes, listen." If a primitive turns out to be tied too tightly to `session:resolve-token` semantics (workspace-git-http uses a static shared token, NOT a session token), copy the primitive into `@ax/workspace-protocol` and refactor the duplication out later — degrade gracefully.
  3. **Single-image vs separate:** same image. The git-server entrypoint becomes another binary (`dist/git-server/index.js`) baked into the same image as host + runners. Coordinate with follow-up #4 (`Dockerfile.agent`); if it lands first, follow its conventions; if this slice lands first, document the entrypoint contract so #4 can integrate. The chart references the same `image.repository` + `image.tag`.
  4. **Conflict retry:** host plugin propagates `parent-mismatch` PluginError unchanged. No retry-with-backoff loop — adding it without a real workload is guessing (handoff scope decision 4).
  5. **DR / backup:** documented as an explicit "no DR yet" known-limit in `@ax/workspace-git-http/SECURITY.md`. No DR mechanism in this slice.
- **Auth model is different from #1:**
  - In `@ax/ipc-http`, the bearer token is a per-session token resolved via `session:resolve-token`. Each token belongs to exactly one session.
  - In `@ax/workspace-git-http`, the bearer token is a **shared service token** between the host pod and the git-server pod, provisioned via a Helm-managed Secret. There's no session boundary at the workspace layer — a workspace is owned by the cluster, not by a session. The server compares the supplied token against an env-loaded expected token using `crypto.timingSafeEqual`. Document this distinction in SECURITY.md so future readers don't reflexively try to plug `session:resolve-token` in here.
- **Ordering with follow-up #4:** if `Dockerfile.agent` doesn't exist when this slice lands, declare the entrypoint contract in `deploy/README.md` (`/opt/ax-next/git-server/index.js` or similar) so #4 has a target.
- **Production wiring discovery:** the deploy chart's `values.yaml:154` comment references `@ax/preset-k8s` but no such package exists today. The host pod runs `node dist/cli/index.js serve` and `packages/cli/src/main.ts` does NOT currently register `@ax/workspace-git`. **Before Task 19, run `grep -rln "createWorkspaceGitPlugin\|@ax/workspace-git" packages/ deploy/` to find the actual wiring point.** If there isn't one, the chart is currently shipping a host that has no workspace plugin at all (consistent with follow-up #5 which says workspace-git isn't wired into the local preset either). In that case, Task 19 becomes "wire workspace-git-http into the cli's serve command, gated by `AX_WORKSPACE_BACKEND=http`," and the existing local-mode plugin gap stays as follow-up #5.

---

## Phase A — package extraction (`@ax/workspace-git-core`)

### Task 1: Create `@ax/workspace-git-core` skeleton

**Files:**
- Create: `packages/workspace-git-core/package.json`
- Create: `packages/workspace-git-core/tsconfig.json`
- Create: `packages/workspace-git-core/vitest.config.ts`
- Create: `packages/workspace-git-core/src/index.ts` (empty stub: `export {};`)
- Create: `packages/workspace-git-core/src/__tests__/scaffold.test.ts`
- Modify: `tsconfig.json` (root) — add the new package to `references`
- Modify: `pnpm-workspace.yaml` — already includes `packages/*`, no change needed (verify)

**Step 1: Verify pnpm-workspace.yaml glob covers `packages/*`**

Run: `cat pnpm-workspace.yaml`
Expected: contains `- 'packages/*'` (or equivalent). If yes, no edit. If no, add the new path explicitly.

**Step 2: Copy package.json from `@ax/workspace-git`, rename**

```json
{
  "name": "@ax/workspace-git-core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist", "SECURITY.md"],
  "scripts": {
    "build": "tsc --build",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@ax/core": "workspace:*",
    "isomorphic-git": "1.37.5",
    "picomatch": "4.0.4"
  },
  "devDependencies": {
    "@ax/test-harness": "workspace:*",
    "@types/node": "^25.6.0",
    "@types/picomatch": "^4.0.2",
    "typescript": "^6.0.3",
    "vitest": "^4.1.4"
  }
}
```

(Note: `zod` is dropped from deps — it wasn't actually used by the impl, just imported by the wrapper's package.json by mistake. Verify by grepping `packages/workspace-git/src/` for `zod` usage — there should be none.)

**Step 3: Copy `tsconfig.json` and `vitest.config.ts` verbatim from `@ax/workspace-git`**

Run: `cp packages/workspace-git/tsconfig.json packages/workspace-git-core/tsconfig.json && cp packages/workspace-git/vitest.config.ts packages/workspace-git-core/vitest.config.ts`

**Step 4: Write the scaffold test**

```typescript
// packages/workspace-git-core/src/__tests__/scaffold.test.ts
import { describe, it, expect } from 'vitest';

describe('@ax/workspace-git-core scaffold', () => {
  it('package builds and the test runner can find it', () => {
    expect(true).toBe(true);
  });
});
```

**Step 5: Add to root tsconfig references**

Modify `tsconfig.json` (root). Find the `references` array, add `{ "path": "./packages/workspace-git-core" }` in alphabetical position.

**Step 6: Install + verify build + verify scaffold test passes**

Run: `pnpm install && pnpm --filter @ax/workspace-git-core build && pnpm --filter @ax/workspace-git-core test`
Expected: install succeeds; build succeeds; one test passes.

**Step 7: Commit**

```bash
git add packages/workspace-git-core tsconfig.json pnpm-lock.yaml
git commit -m "scaffold(workspace-git-core): empty package skeleton"
```

---

### Task 2: Move impl.ts and helpers into `@ax/workspace-git-core`

**Files:**
- Create: `packages/workspace-git-core/src/impl.ts` (moved from `packages/workspace-git/src/impl.ts`, with the `WorkspaceGitConfig` import lifted to a local `interface WorkspaceGitCoreConfig { repoRoot: string }` so core doesn't depend on the wrapper)
- Create: `packages/workspace-git-core/src/index.ts` (replace stub with real exports)
- Test: `packages/workspace-git-core/src/__tests__/contract.test.ts` (drives the existing contract test against the bare core API)

**Step 1: Write the failing contract test for core**

```typescript
// packages/workspace-git-core/src/__tests__/contract.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkspaceContract } from '@ax/test-harness';
import type { Plugin } from '@ax/core';
import { registerWorkspaceGitHooks } from '../impl.js';

// Test-only Plugin shim so we can drive `registerWorkspaceGitHooks` (the
// core's bare API) through the contract suite. Production callers go through
// the @ax/workspace-git wrapper, which has a real manifest.
function makeCorePlugin(repoRoot: string): Plugin {
  return {
    manifest: {
      name: '@ax/workspace-git-core-test-shim',
      version: '0.0.0',
      registers: [
        'workspace:apply',
        'workspace:read',
        'workspace:list',
        'workspace:diff',
      ],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      registerWorkspaceGitHooks(bus, { repoRoot });
    },
  };
}

runWorkspaceContract('@ax/workspace-git-core', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'ax-ws-core-'));
  return makeCorePlugin(repoRoot);
});
```

**Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ax/workspace-git-core test`
Expected: FAIL — `Cannot find module '../impl.js'`.

**Step 3: Move `impl.ts` from `@ax/workspace-git` into `@ax/workspace-git-core`**

```bash
git mv packages/workspace-git/src/impl.ts packages/workspace-git-core/src/impl.ts
```

Modify `packages/workspace-git-core/src/impl.ts`:
- Replace `import type { WorkspaceGitConfig } from './plugin.js';` with `export interface WorkspaceGitCoreConfig { repoRoot: string; }` at the top of the file.
- Change the function signature `export function registerWorkspaceGitHooks(bus: HookBus, config: WorkspaceGitConfig): void` → `export function registerWorkspaceGitHooks(bus: HookBus, config: WorkspaceGitCoreConfig): void`.
- Update the `PLUGIN_NAME` constant from `'@ax/workspace-git'` to `'@ax/workspace-git-core'`. **Read note below first.**

**Note on `PLUGIN_NAME`:** The constant is used in `PluginError.plugin` (visible in error envelopes). Keeping it as `'@ax/workspace-git'` would lie to anyone reading an error from the http variant; renaming to `'@ax/workspace-git-core'` would invalidate any existing error-handling code that grep'd for the old name. The handoff doc doesn't pin this. **Decision:** rename to `'@ax/workspace-git-core'`. Anyone reading an error envelope is debugging plugin internals; the rename is the honest answer. If the contract test or any other test pins the old name string, update those tests in this same task (they'll fail loudly under Step 5 and become a single-pattern fix).

**Step 4: Write `packages/workspace-git-core/src/index.ts`**

```typescript
export { registerWorkspaceGitHooks } from './impl.js';
export type { WorkspaceGitCoreConfig } from './impl.js';
```

**Step 5: Run core's contract test**

Run: `pnpm --filter @ax/workspace-git-core test`
Expected: PASS — all 9 contract assertions plus the scaffold test (10 total).

**Step 6: Verify `@ax/workspace-git`'s tests now FAIL (because impl.ts moved away)**

Run: `pnpm --filter @ax/workspace-git test`
Expected: FAIL — `Cannot find module './impl.js'` from `plugin.ts`.

This is expected — Task 3 fixes it.

**Step 7: Commit**

```bash
git add packages/workspace-git-core packages/workspace-git
git commit -m "refactor(workspace-git-core): extract impl.ts from @ax/workspace-git"
```

---

### Task 3: Convert `@ax/workspace-git` to thin wrapper

**Files:**
- Modify: `packages/workspace-git/src/plugin.ts` (replace `./impl.js` import with `@ax/workspace-git-core`)
- Modify: `packages/workspace-git/package.json` (add `@ax/workspace-git-core` dep, remove `isomorphic-git` + `picomatch` since core owns them now)
- (Existing test stays unchanged — that's the point of preserving the hook surface.)

**Step 1: Rewrite `packages/workspace-git/src/plugin.ts`**

```typescript
import type { Plugin } from '@ax/core';
import { registerWorkspaceGitHooks } from '@ax/workspace-git-core';

const PLUGIN_NAME = '@ax/workspace-git';

export interface WorkspaceGitConfig {
  /**
   * Absolute path to the directory that will host the bare repository at
   * `<repoRoot>/repo.git`. The plugin will idempotently `git.init` it on
   * first use. Capabilities are scoped to this directory only — nothing
   * outside `repoRoot` is read or written.
   */
  repoRoot: string;
}

/**
 * Single-replica workspace plugin backed by a bare `isomorphic-git`
 * repository on disk. Thin wrapper over `@ax/workspace-git-core` — registers
 * the four `workspace:*` service hooks against a local repoRoot. Use this
 * for the local CLI / single-pod deployments. Multi-replica deployments
 * use `@ax/workspace-git-http` instead.
 */
export function createWorkspaceGitPlugin(config: WorkspaceGitConfig): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [
        'workspace:apply',
        'workspace:read',
        'workspace:list',
        'workspace:diff',
      ],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      registerWorkspaceGitHooks(bus, { repoRoot: config.repoRoot });
    },
  };
}
```

**Step 2: Update `packages/workspace-git/package.json`**

Drop `isomorphic-git`, `picomatch`, `zod` from `dependencies`; add `@ax/workspace-git-core: workspace:*`. Drop `@types/picomatch` from devDeps (the wrapper doesn't need it). Final `dependencies`:

```json
{
  "@ax/core": "workspace:*",
  "@ax/workspace-git-core": "workspace:*"
}
```

**Step 3: Run install + wrapper test**

Run: `pnpm install && pnpm --filter @ax/workspace-git test`
Expected: PASS — all 9 contract assertions in the wrapper's existing contract.test.ts.

**Step 4: Run the full monorepo test as a smoke check**

Run: `pnpm test`
Expected: PASS across all packages. If anything else imports from `@ax/workspace-git`'s impl.ts internals (it shouldn't — impl was internal), fix the import paths to `@ax/workspace-git-core` in the same commit.

**Step 5: Commit**

```bash
git add packages/workspace-git pnpm-lock.yaml
git commit -m "refactor(workspace-git): convert to thin wrapper over @ax/workspace-git-core"
```

---

### Task 4: SECURITY.md for `@ax/workspace-git-core` and update for `@ax/workspace-git`

**Files:**
- Create: `packages/workspace-git-core/SECURITY.md` (substantively the existing `@ax/workspace-git/SECURITY.md`, with package boundary updated)
- Modify: `packages/workspace-git/SECURITY.md` (shrink to "this is now a wrapper; substantive review lives in `@ax/workspace-git-core/SECURITY.md`"; drop the "Single-replica only" known-limit since the http variant addresses it)

**Step 1: Invoke `security-checklist` skill for `@ax/workspace-git-core`**

The package is the actual implementation now. Walk all three threat models. The substantive content is mostly a copy from `packages/workspace-git/SECURITY.md` because the code didn't change — just where it lives. Update the boundary review to reflect:
- Package is now `@ax/workspace-git-core` (not `@ax/workspace-git`).
- Two consumers: `@ax/workspace-git` (in-process), `@ax/workspace-git-http` (over HTTP, server-side only — host-side never imports core).
- The mutex is correct *for a single-process owner of the repo*; both consumers satisfy that property.

**Step 2: Write `packages/workspace-git-core/SECURITY.md`**

Use `packages/workspace-git/SECURITY.md` as the base. Update the opening paragraph to clarify the new boundary. Keep all the substantive sections (Sandbox / Filesystem reach / Process spawn / Env vars / Network / Argv injection / Prompt injection / Supply chain) verbatim — the code didn't change. In "Known limits," drop the "Single-replica only" entry (or replace with "Used in single-process mode by both consumers — `@ax/workspace-git` is the wrapper for in-process use; `@ax/workspace-git-http` runs core in a dedicated git-server pod that's `replicas: 1` by design").

**Step 3: Shrink `packages/workspace-git/SECURITY.md`**

Replace with a short doc that points readers at `@ax/workspace-git-core/SECURITY.md` for the substantive walk, calls out that this package is a thin wrapper, and lists the (now-empty) "Known limits" section. Drop the "Single-replica only" limit (the http variant addresses it for production use).

**Step 4: Commit**

```bash
git add packages/workspace-git-core/SECURITY.md packages/workspace-git/SECURITY.md
git commit -m "docs(workspace-git-core): SECURITY.md (security-checklist output) + retire single-replica limit on wrapper"
```

---

## Phase B — wire protocol (`@ax/workspace-protocol`)

### Task 5: Scaffold `@ax/workspace-protocol`

**Files:**
- Create: `packages/workspace-protocol/package.json`
- Create: `packages/workspace-protocol/tsconfig.json`
- Create: `packages/workspace-protocol/vitest.config.ts`
- Create: `packages/workspace-protocol/src/index.ts`
- Create: `packages/workspace-protocol/src/actions.ts` (Zod schemas + action name union)
- Create: `packages/workspace-protocol/src/timeouts.ts` (per-action default timeouts)
- Create: `packages/workspace-protocol/src/errors.ts` (wire-error envelope mirror of `@ax/ipc-protocol`)
- Create: `packages/workspace-protocol/src/__tests__/actions.test.ts` (parses-and-rejects suite)
- Modify: root `tsconfig.json` references

**Step 1: Write the failing schema-roundtrip test**

```typescript
// packages/workspace-protocol/src/__tests__/actions.test.ts
import { describe, it, expect } from 'vitest';
import {
  WorkspaceApplyRequestSchema,
  WorkspaceApplyResponseSchema,
  WorkspaceReadRequestSchema,
  WorkspaceReadResponseSchema,
  WorkspaceListRequestSchema,
  WorkspaceListResponseSchema,
  WorkspaceDiffRequestSchema,
  WorkspaceDiffResponseSchema,
} from '../actions.js';

describe('workspace wire schemas', () => {
  it('apply request: rejects extra fields and wrong types', () => {
    const ok = WorkspaceApplyRequestSchema.safeParse({
      changes: [{ path: 'a', kind: 'put', contentBase64: 'aGVsbG8=' }],
      parent: null,
    });
    expect(ok.success).toBe(true);

    const bad = WorkspaceApplyRequestSchema.safeParse({
      changes: [{ path: 'a', kind: 'put', content: 'hello' }], // raw bytes, no base64 wrapping
      parent: null,
    });
    expect(bad.success).toBe(false);
  });

  it('list response: paths must be string array', () => {
    const ok = WorkspaceListResponseSchema.safeParse({ paths: ['a', 'b'] });
    expect(ok.success).toBe(true);
    const bad = WorkspaceListResponseSchema.safeParse({ paths: 'a,b' });
    expect(bad.success).toBe(false);
  });

  // (One concrete test per schema follows the same pattern; see Step 4.)
});
```

**Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ax/workspace-protocol test`
Expected: FAIL — package doesn't exist yet.

**Step 3: Scaffold the package files**

`package.json`:

```json
{
  "name": "@ax/workspace-protocol",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc --build",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@ax/core": "workspace:*",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^25.6.0",
    "typescript": "^6.0.3",
    "vitest": "^4.1.4"
  }
}
```

Copy `tsconfig.json` and `vitest.config.ts` from `@ax/ipc-protocol` (smaller and closer in shape to what we need than `@ax/workspace-git-core`).

Add to root `tsconfig.json` references.

**Step 4: Write `packages/workspace-protocol/src/actions.ts`**

Define Zod schemas for each of the four hooks. Wire shape — `Bytes` (Uint8Array) is wrapped as base64-encoded strings on the wire because JSON can't carry binary cleanly:

```typescript
import { z } from 'zod';

export type WorkspaceActionName =
  | 'workspace.apply'
  | 'workspace.read'
  | 'workspace.list'
  | 'workspace.diff';

// Wire-side change shape: bytes go as base64 strings.
const WireFileChangeSchema = z.discriminatedUnion('kind', [
  z.object({
    path: z.string(),
    kind: z.literal('put'),
    contentBase64: z.string(),
  }),
  z.object({
    path: z.string(),
    kind: z.literal('delete'),
  }),
]).strict();

export const WorkspaceApplyRequestSchema = z.object({
  changes: z.array(WireFileChangeSchema),
  parent: z.string().nullable(),
  reason: z.string().optional(),
}).strict();

// Delta wire shape: changes carry contentBefore/contentAfter as base64
// strings (eagerly resolved server-side; the laziness lives in the host
// plugin's adapter, which wraps the wire bytes back as `() => Promise<Bytes>`
// closures so subscribers see the same shape regardless of transport).
const WireWorkspaceChangeSchema = z.discriminatedUnion('kind', [
  z.object({
    path: z.string(),
    kind: z.literal('added'),
    contentAfterBase64: z.string(),
  }),
  z.object({
    path: z.string(),
    kind: z.literal('modified'),
    contentBeforeBase64: z.string(),
    contentAfterBase64: z.string(),
  }),
  z.object({
    path: z.string(),
    kind: z.literal('deleted'),
    contentBeforeBase64: z.string(),
  }),
]).strict();

const WireDeltaSchema = z.object({
  before: z.string().nullable(),
  after: z.string(),
  changes: z.array(WireWorkspaceChangeSchema),
  reason: z.string().optional(),
  author: z.object({
    agentId: z.string(),
    userId: z.string(),
    sessionId: z.string(),
  }).optional(),
}).strict();

export const WorkspaceApplyResponseSchema = z.object({
  version: z.string(),
  delta: WireDeltaSchema,
}).strict();

export const WorkspaceReadRequestSchema = z.object({
  path: z.string(),
  version: z.string().optional(),
}).strict();

export const WorkspaceReadResponseSchema = z.discriminatedUnion('found', [
  z.object({ found: z.literal(true), bytesBase64: z.string() }).strict(),
  z.object({ found: z.literal(false) }).strict(),
]);

export const WorkspaceListRequestSchema = z.object({
  pathGlob: z.string().optional(),
  version: z.string().optional(),
}).strict();

export const WorkspaceListResponseSchema = z.object({
  paths: z.array(z.string()),
}).strict();

export const WorkspaceDiffRequestSchema = z.object({
  from: z.string().nullable(),
  to: z.string(),
}).strict();

export const WorkspaceDiffResponseSchema = z.object({
  delta: WireDeltaSchema,
}).strict();

export const WORKSPACE_ACTION_PATHS: Record<WorkspaceActionName, string> = {
  'workspace.apply': '/workspace.apply',
  'workspace.read': '/workspace.read',
  'workspace.list': '/workspace.list',
  'workspace.diff': '/workspace.diff',
};
```

**Step 5: Write `packages/workspace-protocol/src/timeouts.ts`**

```typescript
import type { WorkspaceActionName } from './actions.js';

// Defaults. Apply gets the longest because tree-write + commit can block
// behind the mutex on a busy git-server. Read/list are fast.
export const WORKSPACE_TIMEOUTS_MS: Record<WorkspaceActionName, number> = {
  'workspace.apply': 30_000,
  'workspace.read': 10_000,
  'workspace.list': 10_000,
  'workspace.diff': 30_000,
};
```

**Step 6: Write `packages/workspace-protocol/src/errors.ts`**

```typescript
import { z } from 'zod';

// Wire-error envelope. Same shape as @ax/ipc-protocol's IpcErrorEnvelope, but
// we don't import that package — keeps workspace-protocol independent of the
// IPC protocol. Both packages happen to use this exact shape because it's the
// natural one for HTTP-JSON RPC error bodies.
export const WorkspaceErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    // Optional structured fields for parent-mismatch (the only error that
    // benefits from a machine-readable detail today).
    expectedParent: z.string().nullable().optional(),
    actualParent: z.string().nullable().optional(),
  }),
}).strict();

export type WorkspaceErrorEnvelope = z.infer<typeof WorkspaceErrorEnvelopeSchema>;
```

**Step 7: Write `packages/workspace-protocol/src/index.ts`**

```typescript
export * from './actions.js';
export * from './errors.js';
export * from './timeouts.js';
```

**Step 8: Round out the test (one parses-and-rejects pair per schema)**

Add tests for `WorkspaceReadRequestSchema`, `WorkspaceReadResponseSchema`, `WorkspaceListRequestSchema`, `WorkspaceListResponseSchema`, `WorkspaceDiffRequestSchema`, `WorkspaceDiffResponseSchema`, `WorkspaceApplyResponseSchema`, `WorkspaceErrorEnvelopeSchema`. Each is a 4-line test: one input that passes, one that doesn't.

**Step 9: Run protocol tests**

Run: `pnpm install && pnpm --filter @ax/workspace-protocol build && pnpm --filter @ax/workspace-protocol test`
Expected: PASS.

**Step 10: Commit**

```bash
git add packages/workspace-protocol tsconfig.json pnpm-lock.yaml
git commit -m "feat(workspace-protocol): wire schemas + per-action timeouts for HTTP workspace transport"
```

---

## Phase C — `@ax/workspace-git-http` server side

### Task 6: Scaffold `@ax/workspace-git-http`

**Files:**
- Create: `packages/workspace-git-http/package.json`
- Create: `packages/workspace-git-http/tsconfig.json`
- Create: `packages/workspace-git-http/vitest.config.ts`
- Create: `packages/workspace-git-http/src/index.ts` (stub)
- Create: `packages/workspace-git-http/src/__tests__/scaffold.test.ts`
- Modify: root `tsconfig.json` references

**Step 1: Write `packages/workspace-git-http/package.json`**

```json
{
  "name": "@ax/workspace-git-http",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./server": {
      "types": "./dist/server/index.d.ts",
      "default": "./dist/server/index.js"
    }
  },
  "files": ["dist", "SECURITY.md"],
  "scripts": {
    "build": "tsc --build",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@ax/core": "workspace:*",
    "@ax/workspace-protocol": "workspace:*",
    "@ax/workspace-git-core": "workspace:*"
  },
  "devDependencies": {
    "@ax/test-harness": "workspace:*",
    "@types/node": "^25.6.0",
    "typescript": "^6.0.3",
    "vitest": "^4.1.4"
  }
}
```

**Notes on this package.json:**
- The host-side plugin (default export) only depends on `@ax/core` + `@ax/workspace-protocol` at the source level — it does NOT `import` `@ax/workspace-git-core` (Invariant I2: the host doesn't know git). The pod-side server is a separate sub-export under `./server` and DOES import core.
- `@ax/workspace-git-core` is in `dependencies` (not `devDependencies`) because the server entrypoint needs it at runtime in the same image. Invariant I2 enforcement happens at the import-graph level (lint), not at the package.json level — having a dep listed isn't the same as importing it. Consider adding an explicit `no-restricted-imports` lint rule that allows `@ax/workspace-git-core` only inside `src/server/**` if the executing session has time.

**Step 2: Copy `tsconfig.json` and `vitest.config.ts` from `@ax/ipc-http`**

Run: `cp packages/ipc-http/tsconfig.json packages/workspace-git-http/tsconfig.json && cp packages/ipc-http/vitest.config.ts packages/workspace-git-http/vitest.config.ts`

Adjust the tsconfig if needed so the `outDir` resolves and the new `./server` sub-export builds into `dist/server/`.

**Step 3: Stub `packages/workspace-git-http/src/index.ts`**

```typescript
export {};
```

**Step 4: Scaffold test**

```typescript
import { describe, it, expect } from 'vitest';
describe('@ax/workspace-git-http scaffold', () => {
  it('package exists', () => { expect(true).toBe(true); });
});
```

**Step 5: Add to root tsconfig references, install, build, test**

Run: `pnpm install && pnpm --filter @ax/workspace-git-http build && pnpm --filter @ax/workspace-git-http test`
Expected: PASS.

**Step 6: Commit**

```bash
git add packages/workspace-git-http tsconfig.json pnpm-lock.yaml
git commit -m "scaffold(workspace-git-http): empty package skeleton"
```

---

### Task 7: Pod-side HTTP server — auth gate + body framing

**Files:**
- Create: `packages/workspace-git-http/src/server/auth.ts` — bearer token check via `crypto.timingSafeEqual` against an env-loaded expected token
- Test: `packages/workspace-git-http/src/server/__tests__/auth.test.ts`

**Step 1: Write the failing auth test**

```typescript
// packages/workspace-git-http/src/server/__tests__/auth.test.ts
import { describe, it, expect } from 'vitest';
import { checkBearerToken } from '../auth.js';

describe('git-server bearer auth', () => {
  it('accepts the exact token', () => {
    const r = checkBearerToken('Bearer abc123', 'abc123');
    expect(r.ok).toBe(true);
  });
  it('rejects missing header', () => {
    const r = checkBearerToken(undefined, 'abc123');
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
  });
  it('rejects wrong scheme', () => {
    const r = checkBearerToken('Basic abc123', 'abc123');
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
  });
  it('rejects wrong token', () => {
    const r = checkBearerToken('Bearer wrong', 'abc123');
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
  });
  it('does not echo token in error message', () => {
    const r = checkBearerToken('Bearer my-leaked-token', 'abc123');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).not.toContain('my-leaked-token');
  });
  it('mismatched-length token does not throw on timingSafeEqual', () => {
    // timingSafeEqual would throw on raw buffers of different length;
    // we canonicalize first. Just assert no exception.
    expect(() => checkBearerToken('Bearer x', 'abc123')).not.toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @ax/workspace-git-http test`
Expected: FAIL — `Cannot find module '../auth.js'`.

**Step 3: Implement `packages/workspace-git-http/src/server/auth.ts`**

```typescript
import { timingSafeEqual } from 'node:crypto';

const BEARER_PREFIX = 'bearer ';

export type BearerCheckResult =
  | { ok: true }
  | { ok: false; status: number; message: string };

/**
 * Validate `Authorization: Bearer <token>` against the expected service token.
 *
 * Different from @ax/ipc-core's `authenticate`: there's no session resolution
 * here, just a static shared token between the host pod and the git-server
 * pod (provisioned via the Helm `gitServerAuth` Secret). Token never appears
 * in any error message — invariant I9 carried over from the IPC slice.
 */
export function checkBearerToken(
  authHeader: string | undefined,
  expectedToken: string,
): BearerCheckResult {
  if (authHeader === undefined || authHeader.length === 0) {
    return { ok: false, status: 401, message: 'missing authorization' };
  }
  if (authHeader.length <= BEARER_PREFIX.length ||
      authHeader.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX) {
    return { ok: false, status: 401, message: 'invalid authorization scheme' };
  }
  const presented = authHeader.slice(BEARER_PREFIX.length).trim();
  if (presented.length === 0) {
    return { ok: false, status: 401, message: 'invalid authorization scheme' };
  }
  // Constant-time compare. timingSafeEqual REQUIRES equal-length buffers;
  // mismatched lengths short-circuit to false without leaking the difference.
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expectedToken, 'utf8');
  if (a.length !== b.length) {
    return { ok: false, status: 401, message: 'unknown token' };
  }
  if (!timingSafeEqual(a, b)) {
    return { ok: false, status: 401, message: 'unknown token' };
  }
  return { ok: true };
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @ax/workspace-git-http test`
Expected: PASS — six new tests + the scaffold test.

**Step 5: Commit**

```bash
git add packages/workspace-git-http
git commit -m "feat(workspace-git-http/server): bearer-token gate (timingSafeEqual against env-loaded expected token)"
```

---

### Task 8: Pod-side HTTP server — request handlers (one per workspace action)

**Files:**
- Create: `packages/workspace-git-http/src/server/handlers.ts` — translates wire requests → core API calls → wire responses
- Create: `packages/workspace-git-http/src/server/codec.ts` — bytes ↔ base64 helpers
- Test: `packages/workspace-git-http/src/server/__tests__/handlers.test.ts`

**Step 1: Write the failing test for the apply handler**

```typescript
// packages/workspace-git-http/src/server/__tests__/handlers.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { handleApply, handleRead, handleList, handleDiff } from '../handlers.js';

describe('git-server handlers', () => {
  function freshRepo(): string {
    return mkdtempSync(join(tmpdir(), 'ax-ws-srv-'));
  }

  it('apply round-trips: returns version + delta with base64 contentAfter', async () => {
    const repoRoot = freshRepo();
    const r = await handleApply(repoRoot, {
      changes: [{ path: 'a.txt', kind: 'put', contentBase64: Buffer.from('hi').toString('base64') }],
      parent: null,
    });
    expect(typeof r.version).toBe('string');
    expect(r.delta.before).toBeNull();
    expect(r.delta.changes).toHaveLength(1);
    const ch = r.delta.changes[0]!;
    expect(ch.kind).toBe('added');
    if (ch.kind === 'added') {
      expect(Buffer.from(ch.contentAfterBase64, 'base64').toString()).toBe('hi');
    }
  });

  // ... read / list / diff handlers, plus parent-mismatch case (one each).
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @ax/workspace-git-http test`
Expected: FAIL.

**Step 3: Write `packages/workspace-git-http/src/server/codec.ts`**

```typescript
export function bytesToBase64(b: Uint8Array): string {
  return Buffer.from(b).toString('base64');
}
export function base64ToBytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}
```

**Step 4: Write `packages/workspace-git-http/src/server/handlers.ts`**

The handlers create an *ephemeral* in-process bus, register the core's hooks against the requested `repoRoot`, call the right hook with the wire payload (decoded from base64), and shape the result back to wire form.

Sketch (full impl follows the same pattern for read/list/diff):

```typescript
import { join } from 'node:path';
import {
  HookBus,
  asWorkspaceVersion,
  makeChatContext,
  type WorkspaceApplyInput,
  type WorkspaceApplyOutput,
  type WorkspaceReadInput,
  type WorkspaceReadOutput,
  type WorkspaceListInput,
  type WorkspaceListOutput,
  type WorkspaceDiffInput,
  type WorkspaceDiffOutput,
  type WorkspaceDelta,
  type FileChange,
} from '@ax/core';
import { registerWorkspaceGitHooks } from '@ax/workspace-git-core';
import type { z } from 'zod';
import type {
  WorkspaceApplyRequestSchema,
  WorkspaceApplyResponseSchema,
  WorkspaceReadRequestSchema,
  WorkspaceReadResponseSchema,
  WorkspaceListRequestSchema,
  WorkspaceListResponseSchema,
  WorkspaceDiffRequestSchema,
  WorkspaceDiffResponseSchema,
} from '@ax/workspace-protocol';
import { base64ToBytes, bytesToBase64 } from './codec.js';

// One-bus-per-repoRoot cache. The git-server pod owns a single repoRoot for
// its lifetime today (the chart wires `gitServer.storage` to one PVC), but
// the cache is keyed by repoRoot so a future multi-tenant variant where one
// pod owns N repos drops in cleanly.
const REGISTRY = new Map<string, HookBus>();

function busFor(repoRoot: string): HookBus {
  let bus = REGISTRY.get(repoRoot);
  if (bus !== undefined) return bus;
  bus = new HookBus();
  registerWorkspaceGitHooks(bus, { repoRoot });
  REGISTRY.set(repoRoot, bus);
  return bus;
}

function serverCtx(repoRoot: string) {
  // The git-server has no real session — it's an infrastructure component.
  // Use synthetic identifiers that are obviously infra, not user data.
  return makeChatContext({
    sessionId: 'git-server',
    agentId: 'git-server',
    userId: 'git-server',
    workspace: { rootPath: repoRoot },
  });
}

export async function handleApply(
  repoRoot: string,
  req: z.infer<typeof WorkspaceApplyRequestSchema>,
): Promise<z.infer<typeof WorkspaceApplyResponseSchema>> {
  const bus = busFor(repoRoot);
  const changes: FileChange[] = req.changes.map((c) =>
    c.kind === 'put'
      ? { path: c.path, kind: 'put', content: base64ToBytes(c.contentBase64) }
      : { path: c.path, kind: 'delete' },
  );
  const out = await bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
    'workspace:apply',
    serverCtx(repoRoot),
    {
      changes,
      parent: req.parent === null ? null : asWorkspaceVersion(req.parent),
      ...(req.reason !== undefined ? { reason: req.reason } : {}),
    },
  );
  return { version: out.version as string, delta: await wireDelta(out.delta) };
}

async function wireDelta(d: WorkspaceDelta): Promise<z.infer<typeof WorkspaceApplyResponseSchema>['delta']> {
  // Eagerly resolve every contentBefore/contentAfter so the wire response
  // has plain base64. The HOST plugin re-wraps each as `() => Promise<Bytes>`
  // so subscribers see the same lazy shape they'd get from the in-process
  // backend (laziness lives in the adapter, not on the wire).
  const wireChanges = await Promise.all(
    d.changes.map(async (c) => {
      if (c.kind === 'added') {
        const bytes = await c.contentAfter!();
        return { path: c.path, kind: 'added' as const, contentAfterBase64: bytesToBase64(bytes) };
      }
      if (c.kind === 'modified') {
        const before = await c.contentBefore!();
        const after = await c.contentAfter!();
        return {
          path: c.path,
          kind: 'modified' as const,
          contentBeforeBase64: bytesToBase64(before),
          contentAfterBase64: bytesToBase64(after),
        };
      }
      const before = await c.contentBefore!();
      return { path: c.path, kind: 'deleted' as const, contentBeforeBase64: bytesToBase64(before) };
    }),
  );
  return {
    before: d.before === null ? null : (d.before as string),
    after: d.after as string,
    changes: wireChanges,
    ...(d.reason !== undefined ? { reason: d.reason } : {}),
    ...(d.author !== undefined ? { author: d.author } : {}),
  };
}

// handleRead, handleList, handleDiff follow the same pattern — decode the
// request, call the right hook on `busFor(repoRoot)`, encode the response.
```

**Step 5: Run handler tests until green**

Add the rest of the test cases (read found / not found, list with glob, diff between two versions, parent-mismatch propagates as PluginError that the dispatcher will translate to a 409 wire error).

Run: `pnpm --filter @ax/workspace-git-http test`
Expected: PASS.

**Step 6: Commit**

```bash
git add packages/workspace-git-http
git commit -m "feat(workspace-git-http/server): per-action handlers wrapping @ax/workspace-git-core (base64 codec for bytes)"
```

---

### Task 9: Pod-side HTTP server — listener glue

**Files:**
- Create: `packages/workspace-git-http/src/server/listener.ts` — `node:http` server, routes by method+path, dispatches to handlers, maps PluginError → wire error envelope
- Create: `packages/workspace-git-http/src/server/index.ts` — `createWorkspaceGitServer({ repoRoot, host, port, token })` factory
- Test: `packages/workspace-git-http/src/server/__tests__/listener.test.ts` — drives the server over real TCP using `fetch` from inside the test process

**Step 1: Write the failing listener test**

```typescript
// packages/workspace-git-http/src/server/__tests__/listener.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { createWorkspaceGitServer, type WorkspaceGitServer } from '../index.js';

describe('git-server listener', () => {
  let server: WorkspaceGitServer | null = null;

  afterEach(async () => {
    if (server !== null) await server.close();
    server = null;
  });

  it('rejects requests without bearer auth (401)', async () => {
    server = await createWorkspaceGitServer({
      repoRoot: mkdtempSync(join(tmpdir(), 'ax-ws-srv-')),
      host: '127.0.0.1',
      port: 0,
      token: 'secret',
    });
    const r = await fetch(`http://127.0.0.1:${server.port}/workspace.list`, {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
    });
    expect(r.status).toBe(401);
    const body = await r.json();
    expect(body.error.message).not.toContain('secret');
  });

  it('apply round-trips with bearer auth', async () => {
    server = await createWorkspaceGitServer({
      repoRoot: mkdtempSync(join(tmpdir(), 'ax-ws-srv-')),
      host: '127.0.0.1',
      port: 0,
      token: 'secret',
    });
    const r = await fetch(`http://127.0.0.1:${server.port}/workspace.apply`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer secret',
      },
      body: JSON.stringify({
        changes: [{ path: 'a', kind: 'put', contentBase64: Buffer.from('x').toString('base64') }],
        parent: null,
      }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(typeof body.version).toBe('string');
    expect(body.delta.changes[0].kind).toBe('added');
  });

  it('parent mismatch returns 409 with structured detail', async () => {
    server = await createWorkspaceGitServer({
      repoRoot: mkdtempSync(join(tmpdir(), 'ax-ws-srv-')),
      host: '127.0.0.1',
      port: 0,
      token: 'secret',
    });
    // First apply succeeds (parent: null)
    await fetch(`http://127.0.0.1:${server.port}/workspace.apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer secret' },
      body: JSON.stringify({ changes: [], parent: null }),
    });
    // Second apply with a wrong parent → 409
    const r = await fetch(`http://127.0.0.1:${server.port}/workspace.apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer secret' },
      body: JSON.stringify({ changes: [], parent: 'definitely-not-real' }),
    });
    expect(r.status).toBe(409);
    const body = await r.json();
    expect(body.error.code).toBe('parent-mismatch');
  });

  it('GET /healthz returns 200 without auth', async () => {
    server = await createWorkspaceGitServer({
      repoRoot: mkdtempSync(join(tmpdir(), 'ax-ws-srv-')),
      host: '127.0.0.1',
      port: 0,
      token: 'secret',
    });
    const r = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(r.status).toBe(200);
  });

  it('rejects oversize body (413)', async () => {
    server = await createWorkspaceGitServer({
      repoRoot: mkdtempSync(join(tmpdir(), 'ax-ws-srv-')),
      host: '127.0.0.1',
      port: 0,
      token: 'secret',
    });
    // Send a body whose declared Content-Length exceeds MAX_FRAME (4 MiB).
    // We don't actually need to send 4 MiB of bytes — fail-fast on the
    // header is enough.
    const big = 'x'.repeat(5 * 1024 * 1024);
    const r = await fetch(`http://127.0.0.1:${server.port}/workspace.apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer secret' },
      body: big,
    });
    expect(r.status).toBe(413);
  });

  it('unknown path returns 404', async () => {
    server = await createWorkspaceGitServer({
      repoRoot: mkdtempSync(join(tmpdir(), 'ax-ws-srv-')),
      host: '127.0.0.1',
      port: 0,
      token: 'secret',
    });
    const r = await fetch(`http://127.0.0.1:${server.port}/nonsense`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer secret' },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(404);
  });
});
```

**Step 2: Implement `packages/workspace-git-http/src/server/listener.ts`**

Mirror `packages/ipc-http/src/listener.ts` structurally but with workspace-specific routing and bearer-vs-session-token auth. Reuse `@ax/ipc-core`'s `readJsonBody`, `writeJsonOk`, `writeJsonError` — they're transport-shaped, not action-shaped.

Key shape (mirror the ipc-http listener's gates in order):

```typescript
import * as http from 'node:http';
import {
  readJsonBody, writeJsonError, writeJsonOk,
  BadJsonError, TooLargeError,
} from '@ax/ipc-core';
import { MAX_FRAME, PluginError } from '@ax/core';
import { z } from 'zod';
import {
  WorkspaceApplyRequestSchema, WorkspaceReadRequestSchema,
  WorkspaceListRequestSchema, WorkspaceDiffRequestSchema,
} from '@ax/workspace-protocol';
import { checkBearerToken } from './auth.js';
import { handleApply, handleRead, handleList, handleDiff } from './handlers.js';

const ROUTES = new Map<string, {
  schema: z.ZodTypeAny;
  handle: (repoRoot: string, req: any) => Promise<unknown>;
}>([
  ['/workspace.apply', { schema: WorkspaceApplyRequestSchema, handle: handleApply }],
  ['/workspace.read',  { schema: WorkspaceReadRequestSchema,  handle: handleRead  }],
  ['/workspace.list',  { schema: WorkspaceListRequestSchema,  handle: handleList  }],
  ['/workspace.diff',  { schema: WorkspaceDiffRequestSchema,  handle: handleDiff  }],
]);

// Five gates, identical to @ax/ipc-http but auth is static-token instead of session-token:
//   1. method (POST / GET only)
//   2. /healthz pre-auth GET → 200
//   3. content-type must be application/json on POST
//   4. bearer auth via checkBearerToken against opts.token
//   5. body cap via readJsonBody (MAX_FRAME)
// Then per-action: Zod schema, handler, PluginError → wire-error mapping
// (parent-mismatch → 409; unknown-version → 404; invalid-path → 400; default → 500).
```

The key non-obvious bits:
- The `repoRoot` is fixed at server creation time and passed to every handler — handlers don't read it from the request.
- The MAX_FRAME cap is the same 4 MiB `@ax/ipc-core` already enforces.
- `parent-mismatch` is the most-frequent error under multi-replica load. Map it to HTTP 409 with the `parent-mismatch` code in the envelope so the host plugin can recognize it without parsing the message. Include the actual current head as `actualParent` in the envelope so the host can rebase against it without an extra round trip.
- Other PluginError codes map: `invalid-path` → 400; `unknown-version` → 404; everything else → 500 (we log the cause server-side, return a generic envelope).
- After `listen()` succeeds, install a permanent `'error'` handler so a stray server-level error doesn't crash the process (mirror `ipc-http/src/listener.ts:147-151`).

**Step 3: Implement `packages/workspace-git-http/src/server/index.ts`**

```typescript
import { createWorkspaceGitListener, type WorkspaceGitListener } from './listener.js';

export interface CreateWorkspaceGitServerOptions {
  repoRoot: string;
  host: string;
  port: number; // 0 → OS-assigned
  token: string;
}

export interface WorkspaceGitServer {
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

export async function createWorkspaceGitServer(
  opts: CreateWorkspaceGitServerOptions,
): Promise<WorkspaceGitServer> {
  return createWorkspaceGitListener(opts);
}
```

**Step 4: Run listener tests**

Run: `pnpm --filter @ax/workspace-git-http test`
Expected: PASS — auth tests + handler tests + listener tests, all green.

**Step 5: Commit**

```bash
git add packages/workspace-git-http
git commit -m "feat(workspace-git-http/server): TCP HTTP listener with five-gate inbound + PluginError → wire envelope mapping"
```

---

### Task 10: Pod-side HTTP server — entrypoint binary

**Files:**
- Create: `packages/workspace-git-http/src/server/main.ts` — runnable Node entrypoint that reads env, calls `createWorkspaceGitServer`, handles SIGTERM
- Modify: `packages/workspace-git-http/package.json` — add a `bin` entry pointing at the built main file
- Test: `packages/workspace-git-http/src/server/__tests__/main.test.ts` — boot the entrypoint module in-process, verify it logs the bound URL on stderr and exits cleanly when `close()` is called

**Step 1: Implementation note for testing the entrypoint**

The cleanest way to test the entrypoint without spawning a subprocess is to import the `createWorkspaceGitServer` factory directly and validate the env-parsing logic separately. Spawning a real subprocess would need `node:child_process`, which is overkill — the env-parsing + signal-handling logic can be factored out and unit-tested on its own.

**Decompose the entrypoint into:**
- `main.ts` — exports an async `runServer(env: NodeJS.ProcessEnv): Promise<{ close: () => Promise<void> }>` AND a top-level invocation gated by `if (import.meta.url === pathToFileURL(process.argv[1]).href)`.
- The test imports `runServer`, passes a fake env object, asserts the returned handle is alive on the bound port, and tears it down via `close()`.

```typescript
// packages/workspace-git-http/src/server/__tests__/main.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { runServer } from '../main.js';

describe('git-server entrypoint', () => {
  it('boots from env, serves /healthz, closes cleanly', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'ax-ws-main-'));
    const handle = await runServer({
      AX_GIT_SERVER_REPO_ROOT: repoRoot,
      AX_GIT_SERVER_PORT: '0',
      AX_GIT_SERVER_TOKEN: 'test-token',
      AX_GIT_SERVER_HOST: '127.0.0.1',
    });
    const r = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
    expect(r.status).toBe(200);
    await handle.close();
  });

  it('refuses to start without AX_GIT_SERVER_TOKEN', async () => {
    await expect(
      runServer({ AX_GIT_SERVER_REPO_ROOT: '/tmp', AX_GIT_SERVER_PORT: '0' }),
    ).rejects.toThrow(/AX_GIT_SERVER_TOKEN/);
  });
});
```

**Step 2: Implement `packages/workspace-git-http/src/server/main.ts`**

```typescript
import { pathToFileURL } from 'node:url';
import { createWorkspaceGitServer, type WorkspaceGitServer } from './index.js';

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (v === undefined || v.length === 0) {
    throw new Error(`${name} is required`);
  }
  return v;
}

export interface RunServerHandle {
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

/** Test-friendly entrypoint. The CLI gate at the bottom calls this. */
export async function runServer(env: NodeJS.ProcessEnv): Promise<RunServerHandle> {
  const repoRoot = requireEnv(env, 'AX_GIT_SERVER_REPO_ROOT');
  const token = requireEnv(env, 'AX_GIT_SERVER_TOKEN');
  const host = env.AX_GIT_SERVER_HOST ?? '0.0.0.0';
  const port = Number(env.AX_GIT_SERVER_PORT ?? '7780');

  const server: WorkspaceGitServer = await createWorkspaceGitServer({
    repoRoot, host, port, token,
  });
  process.stderr.write(`[ax/workspace-git-http/server] listening on http://${server.host}:${server.port}\n`);
  return server;
}

// CLI gate — runs only when executed as a script, not when imported.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runServer(process.env)
    .then((handle) => {
      // Clean shutdown: close listener, then exit. Without this we leave
      // dangling git objects if SIGTERM arrives mid-commit. (Follow-up #3
      // will integrate this with the kernel shutdown lifecycle; until then,
      // this local handler does the right thing.)
      let shuttingDown = false;
      const shutdown = async (sig: NodeJS.Signals): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;
        process.stderr.write(`[ax/workspace-git-http/server] ${sig} — closing listener\n`);
        try {
          await handle.close();
          process.exit(0);
        } catch (err) {
          process.stderr.write(`[ax/workspace-git-http/server] shutdown error: ${(err as Error).message}\n`);
          process.exit(1);
        }
      };
      process.on('SIGTERM', () => void shutdown('SIGTERM'));
      process.on('SIGINT', () => void shutdown('SIGINT'));
    })
    .catch((err) => {
      process.stderr.write(`[ax/workspace-git-http/server] fatal: ${(err as Error).message}\n`);
      process.exit(1);
    });
}
```

**Step 3: Update `package.json` to expose the bin**

Add to `packages/workspace-git-http/package.json`:

```json
"bin": {
  "ax-git-server": "./dist/server/main.js"
}
```

**Step 4: Run the test**

Run: `pnpm --filter @ax/workspace-git-http build && pnpm --filter @ax/workspace-git-http test`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/workspace-git-http
git commit -m "feat(workspace-git-http/server): runnable entrypoint with env-loaded config + SIGTERM/SIGINT shutdown"
```

---

## Phase D — `@ax/workspace-git-http` host side

### Task 11: Host-side HTTP client (per-action POSTs)

**Files:**
- Create: `packages/workspace-git-http/src/client.ts` — `createWorkspaceGitHttpClient({ baseUrl, token })` factory; one method per action; retry + timeout per `@ax/workspace-protocol`
- Create: `packages/workspace-git-http/src/errors.ts` — `WorkspaceServerUnavailableError` (analogous to `HostUnavailableError`)
- Test: `packages/workspace-git-http/src/__tests__/client.test.ts` — drives the client against an in-process `createWorkspaceGitServer`

**Step 1: Write the failing client test**

```typescript
// packages/workspace-git-http/src/__tests__/client.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { createWorkspaceGitServer, type WorkspaceGitServer } from '../server/index.js';
import { createWorkspaceGitHttpClient } from '../client.js';

describe('workspace-git-http client', () => {
  let server: WorkspaceGitServer | null = null;
  afterEach(async () => { if (server) await server.close(); server = null; });

  async function freshClient() {
    server = await createWorkspaceGitServer({
      repoRoot: mkdtempSync(join(tmpdir(), 'ax-ws-client-')),
      host: '127.0.0.1',
      port: 0,
      token: 'secret',
    });
    return createWorkspaceGitHttpClient({
      baseUrl: `http://127.0.0.1:${server.port}`,
      token: 'secret',
    });
  }

  it('apply round-trips end-to-end', async () => {
    const c = await freshClient();
    const r = await c.apply({
      changes: [{ path: 'a', kind: 'put', contentBase64: Buffer.from('x').toString('base64') }],
      parent: null,
    });
    expect(r.delta.changes[0]?.kind).toBe('added');
  });

  it('parent-mismatch from server surfaces as a recognizable PluginError', async () => {
    const c = await freshClient();
    await c.apply({ changes: [], parent: null });
    await expect(
      c.apply({ changes: [], parent: 'wrong' }),
    ).rejects.toMatchObject({ code: 'parent-mismatch' });
  });

  it('connection refused surfaces as WorkspaceServerUnavailableError', async () => {
    const c = createWorkspaceGitHttpClient({
      baseUrl: 'http://127.0.0.1:1', // port 1 is unbound
      token: 'secret',
      maxRetries: 0,
    });
    await expect(c.list({})).rejects.toMatchObject({ name: 'WorkspaceServerUnavailableError' });
  });

  it('respects per-action timeout', async () => {
    const c = await freshClient();
    const fast = createWorkspaceGitHttpClient({
      baseUrl: `http://127.0.0.1:${server!.port}`,
      token: 'secret',
      timeouts: { 'workspace.apply': 1 },
      maxRetries: 0,
    });
    await expect(fast.apply({ changes: [], parent: null })).rejects.toMatchObject({
      name: 'WorkspaceServerUnavailableError',
    });
  });
});
```

**Step 2: Implement `packages/workspace-git-http/src/errors.ts`**

```typescript
export class WorkspaceServerUnavailableError extends Error {
  cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'WorkspaceServerUnavailableError';
    this.cause = cause;
  }
}
```

**Step 3: Implement `packages/workspace-git-http/src/client.ts`**

Mirror `packages/agent-runner-core/src/ipc-client.ts`'s shape for the request loop. Key differences from the IPC client:
- No `unix://` transport — workspace-git-http is HTTP-only (the use case is multi-replica k8s; local mode uses `@ax/workspace-git`).
- No `parseRunnerEndpoint` — the caller passes a `baseUrl` directly.
- The server's wire-error envelope (`{error: {code, message, expectedParent?, actualParent?}}`) maps back to a `PluginError`-shaped object on the client side: 409 → `new PluginError({code: 'parent-mismatch', plugin: '@ax/workspace-git-http', hookName: 'workspace:apply', message, cause: { actualParent } })`. The `cause` carries the structured detail for retry loops. Other 4xx → `PluginError` with the server-supplied code. 5xx + connection errors → `WorkspaceServerUnavailableError`.
- Retry policy: same exponential backoff (100, 200, 400, 800, ... cap 30s) on connection errors and 5xx; never retry 4xx.
- Body cap on the response side: `MAX_FRAME` (4 MiB).

Public API:

```typescript
export interface WorkspaceGitHttpClient {
  apply(req: WorkspaceApplyRequest): Promise<WorkspaceApplyResponse>;
  read(req: WorkspaceReadRequest): Promise<WorkspaceReadResponse>;
  list(req: WorkspaceListRequest): Promise<WorkspaceListResponse>;
  diff(req: WorkspaceDiffRequest): Promise<WorkspaceDiffResponse>;
}

export interface CreateWorkspaceGitHttpClientOptions {
  baseUrl: string;
  token: string;
  timeouts?: Partial<Record<WorkspaceActionName, number>>;
  maxRetries?: number;
}

export function createWorkspaceGitHttpClient(
  opts: CreateWorkspaceGitHttpClientOptions,
): WorkspaceGitHttpClient { /* ... */ }
```

**Step 4: Run client tests**

Run: `pnpm --filter @ax/workspace-git-http build && pnpm --filter @ax/workspace-git-http test`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/workspace-git-http
git commit -m "feat(workspace-git-http/client): per-action HTTP client (retry on 5xx + connect errors, parent-mismatch as PluginError with structured cause)"
```

---

### Task 12: Host-side plugin (registers four hooks, forwards via client, preserves empty-turn short-circuit + lazy delta wrapping)

**Files:**
- Create: `packages/workspace-git-http/src/plugin.ts` — `createWorkspaceGitHttpPlugin({ baseUrl, token })`
- Modify: `packages/workspace-git-http/src/index.ts` — re-export the plugin factory + the host-side types
- Test: `packages/workspace-git-http/src/__tests__/contract.test.ts` — drives the full contract test suite end-to-end against an in-process server (the I1 proof)

**Step 1: Write the contract test (this is the I1 proof)**

```typescript
// packages/workspace-git-http/src/__tests__/contract.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkspaceContract } from '@ax/test-harness';
import {
  createWorkspaceGitServer,
} from '../server/index.js';
import { createWorkspaceGitHttpPluginAsync } from '../plugin.js';

// Each contract assertion gets a fresh server (per-test repoRoot) so
// version histories don't bleed across tests. The async plugin factory
// boots the server inside `init()`, which the test harness awaits.

runWorkspaceContract('@ax/workspace-git-http', () =>
  createWorkspaceGitHttpPluginAsync({
    boot: async () => {
      const server = await createWorkspaceGitServer({
        repoRoot: mkdtempSync(join(tmpdir(), 'ax-ws-http-')),
        host: '127.0.0.1',
        port: 0,
        token: 'secret',
      });
      return { baseUrl: `http://127.0.0.1:${server.port}`, token: 'secret' };
    },
  }),
);
```

**Note on the plugin's API shape:** The contract test's `makePlugin()` is sync, but spinning up an HTTP server is async. Two clean options:

- **(a)** Provide an async `boot` callback that the plugin calls in `init()`. The contract test takes advantage of this.
- **(b)** Force the test to do its own ahead-of-time async setup and a sync `makePlugin()`. Uglier but more honest about what the production plugin does (which is take a static `baseUrl`).

**Decision:** ship BOTH. The production factory is `createWorkspaceGitHttpPlugin({ baseUrl, token })` (sync inputs). For tests, provide a *separate* `createWorkspaceGitHttpPluginAsync({ boot })` factory in the same module that's labeled clearly as test-only (`@internal`/JSDoc). This keeps the production API tight and the test setup honest.

**Step 2: Implement `packages/workspace-git-http/src/plugin.ts`**

```typescript
import {
  PluginError,
  asWorkspaceVersion,
  type Bytes,
  type FileChange,
  type HookBus,
  type Plugin,
  type WorkspaceApplyInput,
  type WorkspaceApplyOutput,
  type WorkspaceChange,
  type WorkspaceDelta,
  type WorkspaceDiffInput,
  type WorkspaceDiffOutput,
  type WorkspaceListInput,
  type WorkspaceListOutput,
  type WorkspaceReadInput,
  type WorkspaceReadOutput,
  type WorkspaceVersion,
} from '@ax/core';
import {
  createWorkspaceGitHttpClient,
  type WorkspaceGitHttpClient,
} from './client.js';
// codec helpers live in @ax/workspace-protocol so server + host don't
// duplicate them; if not yet there, add them in Task 5 step 4 follow-up.
import { base64ToBytes, bytesToBase64 } from '@ax/workspace-protocol';

const PLUGIN_NAME = '@ax/workspace-git-http';

export interface CreateWorkspaceGitHttpPluginOptions {
  baseUrl: string;
  token: string;
}

export function createWorkspaceGitHttpPlugin(
  opts: CreateWorkspaceGitHttpPluginOptions,
): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['workspace:apply', 'workspace:read', 'workspace:list', 'workspace:diff'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      const client = createWorkspaceGitHttpClient({ baseUrl: opts.baseUrl, token: opts.token });
      registerHostHooks(bus, client);
    },
  };
}

/** @internal Test-only async variant — spins up the client inside init().
 *  Production callers use createWorkspaceGitHttpPlugin with a static baseUrl. */
export function createWorkspaceGitHttpPluginAsync(
  opts: { boot: () => Promise<{ baseUrl: string; token: string }> },
): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['workspace:apply', 'workspace:read', 'workspace:list', 'workspace:diff'],
      calls: [],
      subscribes: [],
    },
    async init({ bus }) {
      const { baseUrl, token } = await opts.boot();
      const client = createWorkspaceGitHttpClient({ baseUrl, token });
      registerHostHooks(bus, client);
    },
  };
}

function registerHostHooks(bus: HookBus, client: WorkspaceGitHttpClient): void {
  bus.registerService<WorkspaceApplyInput, WorkspaceApplyOutput>(
    'workspace:apply',
    PLUGIN_NAME,
    async (ctx, input) => {
      // Empty-turn short-circuit, client-side. If parent is a real version
      // and there are no changes, return a no-op delta WITHOUT round-tripping
      // to the server. Mirrors the optimization in @ax/workspace-git-core
      // (impl.ts:388-397) so quiet turns don't hammer the git-server pod.
      // Note: when input.parent === null we MUST round-trip — the empty-repo
      // first-apply still needs to mint a version.
      if (input.changes.length === 0 && input.parent !== null) {
        const delta: WorkspaceDelta = {
          before: input.parent,
          after: input.parent,
          changes: [],
          author: { agentId: ctx.agentId, userId: ctx.userId, sessionId: ctx.sessionId },
        };
        if (input.reason !== undefined) delta.reason = input.reason;
        return { version: input.parent, delta };
      }

      const wireRes = await client.apply({
        changes: input.changes.map((c) =>
          c.kind === 'put'
            ? { path: c.path, kind: 'put', contentBase64: bytesToBase64(c.content) }
            : { path: c.path, kind: 'delete' },
        ),
        parent: input.parent === null ? null : (input.parent as string),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      });

      return {
        version: asWorkspaceVersion(wireRes.version),
        delta: hydrateDelta(wireRes.delta),
      };
    },
  );

  // Re-wrap each wire change as a lazy `() => Promise<Bytes>` so subscribers
  // see the same lazy shape they'd get from @ax/workspace-git's in-process
  // backend. The bytes are already in memory at this point — the laziness
  // is just for shape parity.
  function hydrateDelta(d: any /* wire shape */): WorkspaceDelta { /* ... */ return d; }

  bus.registerService<WorkspaceReadInput, WorkspaceReadOutput>(/* ... forwards via client.read */);
  bus.registerService<WorkspaceListInput, WorkspaceListOutput>(/* ... forwards via client.list */);
  bus.registerService<WorkspaceDiffInput, WorkspaceDiffOutput>(/* ... forwards via client.diff */);
}
```

**Step 3: Add codec helpers to `@ax/workspace-protocol`**

Move the two-line `bytesToBase64` / `base64ToBytes` helpers into `packages/workspace-protocol/src/codec.ts` and re-export them from the package index, so server and host don't each maintain a copy. Update Task 8's handler imports accordingly.

**Step 4: Run the contract test (the I1 proof)**

Run: `pnpm --filter @ax/workspace-git-http build && pnpm --filter @ax/workspace-git-http test`
Expected: PASS — all 9 contract assertions plus the auth/handler/listener/client tests.

**This is the moment of truth — if any of the 9 contract assertions fails, debug systematically per `superpowers:systematic-debugging` BEFORE moving on. The point of this slice is to prove I1 holds end-to-end.**

**Step 5: Commit**

```bash
git add packages/workspace-git-http packages/workspace-protocol
git commit -m "feat(workspace-git-http): host plugin forwards four hooks via HTTP, preserves empty-turn short-circuit, hydrates lazy deltas"
```

---

### Task 13: Multi-replica concurrency test (the bonus I1 proof)

**Files:**
- Create: `packages/workspace-git-http/src/__tests__/multi-replica.test.ts`

**Step 1: Write the multi-replica test**

```typescript
// packages/workspace-git-http/src/__tests__/multi-replica.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import {
  createWorkspaceGitServer,
  type WorkspaceGitServer,
} from '../server/index.js';
import { createTestHarness } from '@ax/test-harness';
import { createWorkspaceGitHttpPlugin } from '../plugin.js';
import type {
  WorkspaceApplyInput,
  WorkspaceApplyOutput,
  WorkspaceListInput,
  WorkspaceListOutput,
  WorkspaceVersion,
} from '@ax/core';
import { PluginError } from '@ax/core';

describe('multi-replica concurrent applies', () => {
  let server: WorkspaceGitServer | null = null;

  afterEach(async () => { if (server) await server.close(); server = null; });

  it('three host replicas firing concurrent applies: exactly one wins, others get parent-mismatch, retry produces linear history with all changes', async () => {
    server = await createWorkspaceGitServer({
      repoRoot: mkdtempSync(join(tmpdir(), 'ax-ws-multi-')),
      host: '127.0.0.1',
      port: 0,
      token: 'secret',
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;

    // Three independent host replicas, each with its own bus + harness +
    // plugin. They share the same baseUrl + token (they're "replicas" of
    // the same logical host).
    const harnesses = await Promise.all(
      [0, 1, 2].map(async () =>
        createTestHarness({
          plugins: [createWorkspaceGitHttpPlugin({ baseUrl, token: 'secret' })],
        }),
      ),
    );

    // Initial seed: replica 0 commits parent: null so all three replicas
    // know the same starting version.
    const enc = new TextEncoder();
    const seed = await harnesses[0]!.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
      'workspace:apply', harnesses[0]!.ctx(),
      { changes: [{ path: 'seed', kind: 'put', content: enc.encode('s') }], parent: null },
    );

    // Each replica wants to add its own file from the same parent. Fire all
    // three concurrently. Exactly one will win on the first attempt; the
    // other two will get parent-mismatch, then read the new head from the
    // PluginError's `cause.actualParent`, and retry.
    async function applyWithRetry(idx: number, currentParent: WorkspaceVersion): Promise<WorkspaceVersion> {
      let attempt = 0;
      let p = currentParent;
      while (true) {
        try {
          const r = await harnesses[idx]!.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
            'workspace:apply', harnesses[idx]!.ctx(),
            {
              changes: [{ path: `replica-${idx}.txt`, kind: 'put', content: enc.encode(`r${idx}`) }],
              parent: p,
            },
          );
          return r.version;
        } catch (err) {
          if (err instanceof PluginError && err.code === 'parent-mismatch') {
            attempt++;
            if (attempt > 5) throw err;
            const cause = err.cause as { actualParent?: WorkspaceVersion | null } | undefined;
            const actual = cause?.actualParent;
            if (actual === undefined || actual === null) throw err;
            p = actual;
          } else {
            throw err;
          }
        }
      }
    }

    const results = await Promise.all([0, 1, 2].map((i) => applyWithRetry(i, seed.version)));
    // All three should have succeeded (after retries) and produced 3 distinct versions.
    expect(new Set(results).size).toBe(3);

    // Final list (from any replica) shows seed + all three replica files.
    const finalList = await harnesses[0]!.bus.call<WorkspaceListInput, WorkspaceListOutput>(
      'workspace:list', harnesses[0]!.ctx(), {},
    );
    expect([...finalList.paths].sort()).toEqual(
      ['replica-0.txt', 'replica-1.txt', 'replica-2.txt', 'seed'],
    );
  });
});
```

**Step 2: Run the multi-replica test**

Run: `pnpm --filter @ax/workspace-git-http test multi-replica`
Expected: PASS.

**If it flakes**, the most likely cause is `Promise.all` not actually serializing through the server's mutex (e.g., the test's three apply calls finish before the third even arrives). Add a deliberate barrier — block all three on a shared Promise that resolves after a 50ms tick, so all three race the mutex genuinely. Don't paper over — if the mutex isn't being exercised, the test isn't proving what it claims.

**Step 3: Commit**

```bash
git add packages/workspace-git-http
git commit -m "test(workspace-git-http): multi-replica concurrent applies — exactly one wins, others retry, linear history (the I1 proof)"
```

---

### Task 14: `security-checklist` walk for `@ax/workspace-git-http`

**Files:**
- Create: `packages/workspace-git-http/SECURITY.md`

**Step 1: Invoke `security-checklist` skill**

Walk all three threat models for `@ax/workspace-git-http`:
- **Sandbox.** Two surfaces: (1) the pod-side server opens a TCP listener — perimeter is the new NetworkPolicy (Task 17); auth is the static service token (Task 7) compared with `crypto.timingSafeEqual`. Blast radius if the git-server pod is compromised: read every workspace's content (every session, every user). That's a meaningful escalation from `@ax/workspace-git`'s blast radius (one host pod's PVC). Call this out explicitly. (2) The host-side plugin opens outbound HTTP only to one configured `baseUrl`. No filesystem, no shell, no env leakage.
- **Prompt injection.** Tool output → `workspace:apply` → wire body. The validation chokepoint (`validatePath` in core) runs server-side because the host doesn't import core. Document that the wire format never carries unvalidated bytes (Zod schema rejects shape drift before the dispatcher hands the request to handlers); the path validation runs on the server side as the canonical gate. Why is this safe even if the host plugin were buggy? Because the server is the trust boundary for the workspace's filesystem, not the host. Schema-validate every request body the same way `@ax/ipc-core` does.
- **Supply chain.** Runtime deps: `@ax/core`, `@ax/workspace-protocol`, `@ax/workspace-git-core`. Server transport: Node built-in `node:http`. No new external deps. Resist adding any HTTP framework — same rule as `@ax/ipc-http`.

Document the auth-token rotation story explicitly:
- Token is provisioned via Helm-managed Secret `<release>-git-server-auth` (key `token`). Operators rotate by `kubectl create secret generic ... --dry-run | kubectl apply` then rolling restart of both the host Deployment and the git-server Deployment. The git-server picks up the new token on container restart; the host's plugin reads the token from env at boot.
- During rotation, there's a window where some pods have the old token and some have the new one. Token mismatch → 401 → host plugin's retry budget exhausts → workspace operations fail loudly. Document this — the rotation is operationally painful in this slice. A future improvement is dual-token acceptance (server accepts `tokenOld OR tokenNew` for the rotation window). Listed as a known limit.

Document the no-DR limit:
- The git-server PVC is now the single source of workspace truth. If the PVC dies, every workspace is lost. Operators are responsible for storage-class-level backup (e.g., volume snapshots, Longhorn replication, periodic `git bundle` cron). This slice ships zero DR primitives.

**Step 2: Write `packages/workspace-git-http/SECURITY.md`**

Use `packages/ipc-http/SECURITY.md` as the structural template. The opening paragraph distinguishes this from `@ax/ipc-http` (no `session:resolve-token`; a single static service token instead). Sections: Sandbox / Prompt injection / Supply chain / Known limits.

**Step 3: Commit**

```bash
git add packages/workspace-git-http/SECURITY.md
git commit -m "docs(workspace-git-http): SECURITY.md (security-checklist output)"
```

---

## Phase E — Helm chart additions

### Task 15: `git-server` Deployment + Service + PVC

**Files:**
- Create: `deploy/charts/ax-next/templates/git-server/deployment.yaml`
- Create: `deploy/charts/ax-next/templates/git-server/service.yaml`
- Create: `deploy/charts/ax-next/templates/git-server/pvc.yaml`
- Create: `deploy/charts/ax-next/templates/git-server/serviceaccount.yaml`
- Create: `deploy/charts/ax-next/templates/git-server-auth-secret.yaml` (Helm-managed Secret holding the service token)
- Modify: `deploy/charts/ax-next/values.yaml` — add `gitServer:` block; add `workspace.backend: local|http` toggle
- Modify: `deploy/charts/ax-next/templates/_helpers.tpl` — add helpers for git-server name, namespace, service URL, auth secret name

**Step 1: Add the values block**

```yaml
# values.yaml — extend the existing `workspace:` block, add `gitServer:` block.

# ─── Workspace backend ────────────────────────────────────────────
# Single-replica deployments use `local` — the host pod's @ax/workspace-git
# writes directly to the PVC mounted at workspace.mountPath.
# Multi-replica deployments use `http` — the host pod's @ax/workspace-git-http
# forwards every workspace operation to the dedicated git-server pod.
workspace:
  backend: local      # local | http
  storage: 10Gi
  storageClassName: ""
  accessMode: ReadWriteOnce
  mountPath: /var/lib/ax-next/workspaces

# ─── Git-server pod (workspace.backend: http only) ────────────────
# Dedicated pod that owns the bare repo on a PVC. Every host replica
# talks to it for workspace operations. ALWAYS replicas: 1 — adding more
# would re-introduce the multi-writer race we're solving here.
gitServer:
  enabled: false       # set to true when workspace.backend == "http"
  port: 7780
  service:
    port: 7780
  storage: 10Gi
  storageClassName: ""
  accessMode: ReadWriteOnce
  mountPath: /var/lib/ax-next/repo
  # Bot identity for commits is hard-coded in @ax/workspace-git-core.
  # The auth token is auto-generated at install via the chart's secret
  # template (see git-server-auth-secret.yaml) unless overridden.
  auth:
    # If empty, the chart generates a 48-char random token at install time
    # via the lookup-or-generate pattern. Operators can override here for
    # deterministic deploys (e.g., GitOps).
    token: ""
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 512Mi
  # Same image as host + runners — bundled-binary pattern.
  command: ["node", "/opt/ax-next/git-server/index.js"]
  terminationGracePeriodSeconds: 30
  readinessProbe:
    httpGet:
      path: /healthz
      port: git
    initialDelaySeconds: 5
    periodSeconds: 10
  livenessProbe:
    httpGet:
      path: /healthz
      port: git
    initialDelaySeconds: 10
    periodSeconds: 30
```

**Step 2: Add helpers to `_helpers.tpl`**

Add four helpers (mirror the existing `host.*` helpers' shape):
- `ax-next.gitServerComponentName` — `<release>-<chart>-git-server` truncated to 63 chars
- `ax-next.gitServerServiceUrl` — `http://<svc>.<ns>.svc:<port>` — the URL the host plugin uses for `baseUrl`
- `ax-next.gitServerAuthSecretName` — `<release>-git-server-auth`
- `ax-next.gitServerLabels` — selector labels for the deployment + service + network policy

Reference the existing `ax-next.hostComponentName` and `ax-next.hostIpcUrl` for the truncation/labelling pattern.

**Step 3: Write `deploy/charts/ax-next/templates/git-server/deployment.yaml`**

```yaml
{{- if .Values.gitServer.enabled }}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "ax-next.gitServerComponentName" . }}
  namespace: {{ include "ax-next.hostNamespace" . }}
  labels:
    {{- include "ax-next.componentLabels" (dict "component" "git-server" "context" $) | nindent 4 }}
    ax.io/plane: storage
spec:
  # ALWAYS 1 — adding more replicas would re-introduce the multi-writer
  # race we're solving with this pod. The mutex inside the core relies on
  # being the unique writer. NEVER make this configurable.
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      {{- include "ax-next.selectorLabels" (dict "component" "git-server" "context" $) | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "ax-next.selectorLabels" (dict "component" "git-server" "context" $) | nindent 8 }}
        ax.io/plane: storage
    spec:
      serviceAccountName: {{ include "ax-next.gitServerComponentName" . }}
      terminationGracePeriodSeconds: {{ .Values.gitServer.terminationGracePeriodSeconds | default 30 }}
      {{- with .Values.imagePullSecrets }}
      imagePullSecrets:
        {{- range . }}
        - name: {{ . }}
        {{- end }}
      {{- end }}
      containers:
        - name: git-server
          image: {{ include "ax-next.image" . }}
          imagePullPolicy: {{ .Values.image.pullPolicy | default "IfNotPresent" }}
          command: {{ .Values.gitServer.command | toJson }}
          ports:
            - name: git
              containerPort: {{ .Values.gitServer.port }}
              protocol: TCP
          env:
            - name: AX_GIT_SERVER_HOST
              value: "0.0.0.0"
            - name: AX_GIT_SERVER_PORT
              value: {{ .Values.gitServer.port | quote }}
            - name: AX_GIT_SERVER_REPO_ROOT
              value: {{ .Values.gitServer.mountPath | quote }}
            - name: AX_GIT_SERVER_TOKEN
              valueFrom:
                secretKeyRef:
                  name: {{ include "ax-next.gitServerAuthSecretName" . }}
                  key: token
          resources:
            {{- toYaml .Values.gitServer.resources | nindent 12 }}
          {{- with .Values.gitServer.readinessProbe }}
          readinessProbe:
            {{- toYaml . | nindent 12 }}
          {{- end }}
          {{- with .Values.gitServer.livenessProbe }}
          livenessProbe:
            {{- toYaml . | nindent 12 }}
          {{- end }}
          # The git-server pod doesn't need privilege; pin a non-root user
          # matching the same UID convention the runner pods use.
          securityContext:
            runAsUser: 1000
            runAsNonRoot: true
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
          volumeMounts:
            - name: repo
              mountPath: {{ .Values.gitServer.mountPath }}
            # readOnlyRootFilesystem requires writable /tmp for any temp
            # files isomorphic-git might want; size-cap it.
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: repo
          persistentVolumeClaim:
            claimName: {{ include "ax-next.gitServerComponentName" . }}-repo
        - name: tmp
          emptyDir:
            sizeLimit: 64Mi
{{- end }}
```

**Step 4: Write `service.yaml`**

```yaml
{{- if .Values.gitServer.enabled }}
apiVersion: v1
kind: Service
metadata:
  name: {{ include "ax-next.gitServerComponentName" . }}
  namespace: {{ include "ax-next.hostNamespace" . }}
  labels:
    {{- include "ax-next.componentLabels" (dict "component" "git-server" "context" $) | nindent 4 }}
spec:
  type: ClusterIP
  selector:
    {{- include "ax-next.selectorLabels" (dict "component" "git-server" "context" $) | nindent 4 }}
  ports:
    - name: git
      port: {{ .Values.gitServer.service.port }}
      targetPort: git
      protocol: TCP
{{- end }}
```

**Step 5: Write `pvc.yaml`**

```yaml
{{- if .Values.gitServer.enabled }}
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: {{ include "ax-next.gitServerComponentName" . }}-repo
  namespace: {{ include "ax-next.hostNamespace" . }}
  labels:
    {{- include "ax-next.componentLabels" (dict "component" "git-server" "context" $) | nindent 4 }}
spec:
  accessModes:
    - {{ .Values.gitServer.accessMode | default "ReadWriteOnce" }}
  resources:
    requests:
      storage: {{ .Values.gitServer.storage }}
  {{- if .Values.gitServer.storageClassName }}
  storageClassName: {{ .Values.gitServer.storageClassName }}
  {{- end }}
{{- end }}
```

**Step 6: Write `serviceaccount.yaml`** — empty SA (no RBAC needed; the git-server doesn't talk to k8s API).

**Step 7: Write `git-server-auth-secret.yaml`**

The Secret holds the static service token. Generate at install time with the lookup-or-generate pattern (the same pattern used elsewhere in the chart for credentials):

```yaml
{{- if .Values.gitServer.enabled }}
{{- $existing := lookup "v1" "Secret" .Release.Namespace (include "ax-next.gitServerAuthSecretName" .) -}}
{{- $token := "" -}}
{{- if .Values.gitServer.auth.token -}}
  {{- $token = .Values.gitServer.auth.token -}}
{{- else if and $existing $existing.data $existing.data.token -}}
  {{- $token = (index $existing.data "token") | b64dec -}}
{{- else -}}
  {{- $token = randAlphaNum 48 -}}
{{- end -}}
apiVersion: v1
kind: Secret
metadata:
  name: {{ include "ax-next.gitServerAuthSecretName" . }}
  namespace: {{ include "ax-next.hostNamespace" . }}
  labels:
    {{- include "ax-next.labels" . | nindent 4 }}
type: Opaque
data:
  token: {{ $token | b64enc | quote }}
{{- end }}
```

**Step 8: Verify `helm template` renders cleanly**

Run: `helm template test deploy/charts/ax-next --set gitServer.enabled=true --set workspace.backend=http`
Expected: emits valid YAML for all five new manifests + the rest of the chart unchanged. No template errors.

Run: `helm template test deploy/charts/ax-next` (default values)
Expected: emits the chart unchanged from before this PR — none of the new manifests appear because `gitServer.enabled` defaults to false.

If you have `kubeconform` installed locally (follow-up #8), pipe through it for a stricter check:

Run: `helm template test deploy/charts/ax-next --set gitServer.enabled=true | kubeconform -strict`
Expected: no errors.

**Step 9: Commit**

```bash
git add deploy/charts/ax-next
git commit -m "feat(deploy): git-server Deployment + Service + PVC + auth Secret (gitServer.enabled, workspace.backend: http)"
```

---

### Task 16: Wire host pod to `workspace.backend: http` (env vars)

**Files:**
- Modify: `deploy/charts/ax-next/templates/host/deployment.yaml`
- Modify: `deploy/charts/ax-next/templates/host/pvc.yaml` (gate `if eq .Values.workspace.backend "local"` so the local PVC isn't created in http mode — saves storage and avoids confusion)

**Step 1: Add new env vars to host deployment**

In `deploy/charts/ax-next/templates/host/deployment.yaml`, after the existing `AX_WORKSPACE_ROOT` env var, add:

```yaml
            # Workspace backend selection. The host's plugin loader reads
            # AX_WORKSPACE_BACKEND and registers the matching plugin.
            - name: AX_WORKSPACE_BACKEND
              value: {{ .Values.workspace.backend | quote }}
            {{- if eq .Values.workspace.backend "http" }}
            - name: AX_WORKSPACE_GIT_HTTP_URL
              value: {{ include "ax-next.gitServerServiceUrl" . | quote }}
            - name: AX_WORKSPACE_GIT_HTTP_TOKEN
              valueFrom:
                secretKeyRef:
                  name: {{ include "ax-next.gitServerAuthSecretName" . }}
                  key: token
            {{- end }}
```

**Step 2: Gate the host workspace volume + volumeMount + PVC on the local backend**

In `host/deployment.yaml`, wrap the workspace `volumeMount` and `volume` blocks with `{{- if eq .Values.workspace.backend "local" }}` ... `{{- end }}`. Same for the `AX_WORKSPACE_ROOT` env var (the host doesn't need a local workspace path when the backend is http). In `host/pvc.yaml`, wrap the entire manifest similarly.

**Step 3: Validate both backends render cleanly**

Run: `helm template test deploy/charts/ax-next --set workspace.backend=local`
Expected: host deployment includes the workspace volume/mount; PVC manifest exists; gitServer manifests do NOT exist.

Run: `helm template test deploy/charts/ax-next --set workspace.backend=http --set gitServer.enabled=true`
Expected: host deployment does NOT include the workspace volume/mount; host PVC manifest does NOT exist; gitServer manifests exist; host deployment has the new env vars.

**Step 4: Commit**

```bash
git add deploy/charts/ax-next
git commit -m "feat(deploy): host pod env-wires AX_WORKSPACE_BACKEND + AX_WORKSPACE_GIT_HTTP_{URL,TOKEN}; PVC gated on backend == local"
```

---

### Task 17: NetworkPolicy — host pods CAN reach git-server, runner pods CANNOT

**Files:**
- Create: `deploy/charts/ax-next/templates/networkpolicies/git-server-network.yaml`
- Modify: `deploy/charts/ax-next/templates/networkpolicies/agent-runtime-network.yaml` (no change expected — already denies runner pod egress except to the host's IPC port; verify by re-reading)

**Step 1: Invoke `security-checklist` skill for the chart's new git-server pod**

Walk all three threat models for the new pod:

- **Sandbox.** New pod opens TCP `:7780`. Reach is bounded by the new NetworkPolicy: ingress from host pods labeled `ax.io/plane: ingress` only, egress none (the git-server doesn't talk to anything — it's a leaf service). Pod runs non-root UID 1000, drops all caps, `readOnlyRootFilesystem: true` with sized `emptyDir` for `/tmp`. Bearer auth is the wall behind the perimeter (Task 7). Blast radius: read access to every workspace's content if compromised. Mitigation: tight perimeter + bearer auth + non-root + read-only rootfs.
- **Prompt injection.** Same as `@ax/workspace-git-http`'s package SECURITY.md.
- **Supply chain.** Same image as host + runners; same image-scanning story; the new container's process surface is just `node + dist/server/main.js`.

The chart-level SECURITY.md gets an update in Task 18.

**Step 2: Write `git-server-network.yaml`**

```yaml
{{- if and .Values.networkPolicies.enabled .Values.gitServer.enabled }}
{{/*
git-server pod NetworkPolicy.

  - INGRESS from host pods (cross-component within the same namespace) on
    the git-server port. Runner pods MUST NOT reach the git-server — they
    talk to the host's IPC listener via @ax/ipc-http and the host plugin
    forwards workspace ops on their behalf. The pod-selector below is the
    enforcement.
  - EGRESS: none. The git-server doesn't talk to postgres, k8s API, DNS,
    or anything else. It's a leaf service.

If a future feature requires the git-server to reach the network (e.g.,
periodic git bundle push to S3 for DR), add the egress rule HERE explicitly
— never relax to allow-all. Same paranoia we apply to the runner pod
NetworkPolicy: the perimeter is the security boundary.
*/}}
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: {{ include "ax-next.gitServerComponentName" . }}-network
  namespace: {{ include "ax-next.hostNamespace" . }}
  labels:
    {{- include "ax-next.labels" . | nindent 4 }}
spec:
  podSelector:
    matchLabels:
      {{- include "ax-next.selectorLabels" (dict "component" "git-server" "context" $) | nindent 6 }}
  policyTypes:
    - Ingress
    - Egress
  ingress:
    # Host pods → git-server (same namespace, distinguished by component
    # label). Note: NO ingress from the runner namespace — runners must
    # never reach the git-server directly.
    - from:
        - podSelector:
            matchLabels:
              {{- include "ax-next.selectorLabels" (dict "component" "host" "context" $) | nindent 14 }}
      ports:
        - port: {{ .Values.gitServer.port }}
          protocol: TCP
  egress: []
{{- end }}
```

**Step 3: Re-read `agent-runtime-network.yaml` and verify runner pods cannot reach the git-server**

Run: `cat deploy/charts/ax-next/templates/networkpolicies/agent-runtime-network.yaml`
Expected: runner pod egress is allowed ONLY to the host pod's IPC port. There is no rule that would allow egress to the git-server's port. (If there is — e.g., a too-broad egress rule — call it out and fix it as a separate commit with a regression test.)

**Step 4: Validate the NetworkPolicy renders correctly**

Run: `helm template test deploy/charts/ax-next --set gitServer.enabled=true --set workspace.backend=http`
Expected: emits `git-server-network.yaml` correctly, with selector labels matching the git-server Deployment.

Spot-check by grep: `helm template test deploy/charts/ax-next --set gitServer.enabled=true --set workspace.backend=http | grep -A5 'kind: NetworkPolicy'` — confirm only host pods are listed in the git-server's `from`.

**Step 5: Commit**

```bash
git add deploy/charts/ax-next
git commit -m "feat(deploy): NetworkPolicy for git-server — host pods only, no egress (security-checklist output)"
```

---

### Task 18: Update `deploy/charts/ax-next/SECURITY.md`

**Files:**
- Modify: `deploy/charts/ax-next/SECURITY.md`

**Step 1: Add a "git-server pod" section**

Document:
- New pod, new PVC, new Service, new NetworkPolicy, new Secret (auth token).
- Pod runs non-root UID 1000, all caps dropped, readOnlyRootFilesystem with sized `/tmp` emptyDir.
- NetworkPolicy: ingress from host pods only; egress none.
- Auth token: provisioned via Secret, accepted via env, compared via `crypto.timingSafeEqual` server-side. Rotation requires rolling restart of both Deployments; document the painful operational story.
- Known limit: no DR. The PVC IS the source of truth. Storage-class redundancy is what operators have. Future work: volume snapshot policy or `git bundle` cron.

**Step 2: Commit**

```bash
git add deploy/charts/ax-next/SECURITY.md
git commit -m "docs(deploy/SECURITY): git-server pod section (RBAC, NetworkPolicy, PVC, no-DR limit)"
```

---

## Phase F — production wiring + acceptance

### Task 19: Wire `@ax/workspace-git-http` into the host preset

**Files:**
- Modify: wherever the production host registers plugins (TBD; investigate first)
- Modify: `packages/cli/src/main.ts` if that's the wiring point
- Possibly create: `packages/preset-k8s/` if it's referenced by the chart but doesn't exist
- Modify: `deploy/charts/ax-next/values.yaml` config block to switch `workspace.backend` to `http` when the host preset is `k8s` (only if the wiring is config-driven)

**Step 1: Discover the actual wiring point**

Run: `grep -rln "createWorkspaceGitPlugin\|@ax/workspace-git\b" packages/ deploy/ | grep -v __tests__ | grep -v node_modules | grep -v dist`
Expected: file list. Per the operating notes above, today this returns:
- `packages/workspace-git/*` (the package itself)
- `packages/test-harness/*` (test fixtures)
- `deploy/charts/ax-next/values.yaml` (a comment referencing `@ax/preset-k8s` that may not exist)
- `deploy/charts/ax-next/templates/host/pvc.yaml` (a comment referencing the package)

If nothing in `packages/cli/`, `packages/preset-*`, or any production plugin loader appears, then **`@ax/workspace-git` is currently NOT wired into the production host**. That's consistent with follow-up #5 and the empty-turn workaround in `turn-loop.ts:115-119`. Two paths:

- **(a) Out of scope for this slice:** Document the discovery in the plan and ship the new packages + the chart wiring without flipping the production host's plugin set. Production gets the option (set `workspace.backend: http`, the chart wires the env vars), but the actual plugin selection in the cli's `serve` command is a separate small follow-up. **Recommended.** This keeps the slice focused on what the handoff doc actually says is in scope (extract core, ship http, ship chart).
- **(b) Bundle the wiring:** Add a workspace plugin selection to `packages/cli/src/main.ts`'s plugin list, gated by `AX_WORKSPACE_BACKEND`. Extends the slice to also fix follow-up #5 implicitly for k8s mode (local-mode wiring is still a follow-up).

**Decision:** Run the grep first. If the discovery confirms no production wiring exists, ship path (a) — document explicitly in `deploy/README.md` that production wiring is a separate slice. If a wiring point IS found that wasn't visible in the initial grep, do path (b) (one-line plugin swap based on `AX_WORKSPACE_BACKEND`).

**Step 2: If path (a):**

Add a one-paragraph "Wiring (TODO)" section to `deploy/README.md` that:
- Notes the chart now ships `gitServer.enabled` + `workspace.backend: http` for operators who want multi-replica.
- Notes that the host pod's plugin selection still needs to be wired (`@ax/workspace-git-http` instead of `@ax/workspace-git`) — this should land before the multi-replica MANUAL-ACCEPTANCE step in Task 20 can actually pass.
- Cross-references follow-up #5 (local-preset workspace wiring).

Add a TODO to `packages/cli/src/main.ts` near where plugins are registered, pointing at this discovery.

**Step 3: If path (b):**

In the cli's plugin registration (or wherever the host's plugin set is assembled), add:

```typescript
const wsBackend = process.env.AX_WORKSPACE_BACKEND ?? 'local';
if (wsBackend === 'http') {
  const baseUrl = process.env.AX_WORKSPACE_GIT_HTTP_URL;
  const token = process.env.AX_WORKSPACE_GIT_HTTP_TOKEN;
  if (baseUrl === undefined || token === undefined) {
    throw new Error('AX_WORKSPACE_BACKEND=http requires AX_WORKSPACE_GIT_HTTP_URL and AX_WORKSPACE_GIT_HTTP_TOKEN');
  }
  plugins.push(createWorkspaceGitHttpPlugin({ baseUrl, token }));
} else if (wsBackend === 'local') {
  const repoRoot = process.env.AX_WORKSPACE_ROOT;
  if (repoRoot !== undefined) {
    plugins.push(createWorkspaceGitPlugin({ repoRoot }));
  }
  // (else: no workspace plugin — matches today's behavior)
}
```

Add a unit test that verifies:
- `AX_WORKSPACE_BACKEND=http` registers `@ax/workspace-git-http`.
- `AX_WORKSPACE_BACKEND=local` with `AX_WORKSPACE_ROOT` registers `@ax/workspace-git`.
- Missing required env vars in `http` mode throws loudly.

**Step 4: Commit**

```bash
git add packages/ deploy/
git commit -m "feat(cli|deploy): host preset selects workspace plugin via AX_WORKSPACE_BACKEND (or: defer wiring to follow-up if path-a)"
```

---

### Task 20: MANUAL-ACCEPTANCE additions

**Files:**
- Modify: `deploy/MANUAL-ACCEPTANCE.md`

**Step 1: Add a "multi-replica chat" section**

Document the new manual-acceptance scenario:
- Deploy with `--set replicas=2 --set gitServer.enabled=true --set workspace.backend=http`.
- Send concurrent chat requests to the host Service.
- Verify both succeed.
- Port-forward into the git-server pod, run `git -C /var/lib/ax-next/repo/repo.git log --oneline` (assuming `git` is available; if not, use a small node script that reads via isomorphic-git).
- Assert: linear history with both versions visible.

**Step 2: Note the dependency on Task 19's wiring path**

If Task 19 took path (a), explicitly note that this MANUAL-ACCEPTANCE scenario depends on the wiring landing in a follow-up. If path (b), no caveat needed.

**Step 3: Commit**

```bash
git add deploy/MANUAL-ACCEPTANCE.md
git commit -m "docs(deploy): MANUAL-ACCEPTANCE — multi-replica chat scenario"
```

---

### Task 21: Changeset

**Files:**
- Create: `.changeset/<auto-name>.md` via `pnpm changeset` interactive (or hand-write per the existing changeset format)

**Step 1: Write the changeset**

```markdown
---
'@ax/workspace-git-core': minor
'@ax/workspace-git-http': minor
'@ax/workspace-protocol': minor
'@ax/workspace-git': patch
---

Multi-replica workspace support via @ax/workspace-git-http.

- Extracted @ax/workspace-git-core (the impl + path validation + delta builder).
  @ax/workspace-git is now a thin wrapper for single-replica use; the canonical
  walk lives in @ax/workspace-git-core/SECURITY.md.
- New @ax/workspace-git-http: host-side plugin (forwards four hooks via HTTP) +
  pod-side server (wraps core, listens on TCP, single replica by design). Auth
  is a static service token via Helm-managed Secret.
- New @ax/workspace-protocol: Zod schemas + per-action timeouts for the wire
  shape.
- Helm chart adds gitServer.enabled + workspace.backend: local|http; new
  Deployment / Service / PVC / NetworkPolicy / Secret for the git-server pod.
  Host pod env-wires AX_WORKSPACE_BACKEND + AX_WORKSPACE_GIT_HTTP_{URL,TOKEN}.
- runWorkspaceContract passes against both backends (the I1 proof). New
  multi-replica concurrency test in @ax/workspace-git-http.
```

**Step 2: Commit**

```bash
git add .changeset/
git commit -m "chore: changeset for workspace-git-http"
```

---

### Task 22: Final verification + PR

**Step 1: Full monorepo test + build**

Run: `pnpm install && pnpm build && pnpm test`
Expected: green across all packages.

If anything fails, treat it as a regression — debug per `superpowers:systematic-debugging`. Don't paper over with `.skip`.

**Step 2: Re-render the chart for both backends and diff against current main**

Run: `helm template test deploy/charts/ax-next > /tmp/chart-default.yaml && git stash && helm template test deploy/charts/ax-next > /tmp/chart-baseline.yaml && git stash pop && diff /tmp/chart-baseline.yaml /tmp/chart-default.yaml`
Expected: minimal diff (only the new `workspace.backend` value default reaches the host env, and the host PVC manifest stays the same because backend defaults to `local`).

Run: `helm template test deploy/charts/ax-next --set gitServer.enabled=true --set workspace.backend=http`
Expected: emits the new git-server manifests; host deployment swaps to use the env-wired plugin selection.

**Step 3: Use `superpowers:verification-before-completion` skill** before claiming done. Specifically:
- Confirm `pnpm test` ran clean (paste the summary).
- Confirm the multi-replica concurrency test was actually exercised (look for the test name in vitest output).
- Confirm the contract test ran against `@ax/workspace-git-http` and emitted the I1 success line.

**Step 4: Open the PR**

Use a HEREDOC for the body so formatting survives. Title: `feat: multi-replica workspace via @ax/workspace-git-http (follow-up #2)`.

Body should include:

```markdown
## Summary

Implements [follow-up #2](docs/plans/2026-04-25-week-7-9-followups.md) per [the handoff doc](docs/plans/2026-04-25-workspace-git-http-handoff.md). Multi-replica workspace support via a three-package split:

- **`@ax/workspace-git-core`** — extracted impl + path validation + delta builder (the mutex stays here, scoped per-`gitdir`).
- **`@ax/workspace-git`** — thin wrapper for single-replica / local-CLI use.
- **`@ax/workspace-git-http`** — new package, two exports: host-side plugin (forwards four hooks via HTTP) and pod-side server (wraps core, listens on TCP, single replica by design).
- **`@ax/workspace-protocol`** — Zod schemas + per-action timeouts for the wire shape.
- **Helm chart** — `gitServer.enabled` + `workspace.backend: local|http`; new Deployment / Service / PVC / NetworkPolicy / Secret for the git-server pod.

## Boundary review

- **Alternate impl this hook could have:** the four `workspace:*` hooks now have two real implementations (`@ax/workspace-git`, `@ax/workspace-git-http`) plus the existing mock in `@ax/test-harness`. The handoff considered RWM-mounted PVCs (rejected: no fcntl in isomorphic-git) and stock `git-http-backend` (rejected: pulls in network capability the SECURITY.md deliberately excludes).
- **Payload field names that might leak:** none. Wire schemas use `contentBase64` / `bytesBase64` / `parent` / `version` — none of them git-specific. The opaque `WorkspaceVersion` contract holds end-to-end (a future non-git backend could emit non-SHA versions and subscribers wouldn't notice).
- **Subscriber risk:** none new. Subscribers consume `WorkspaceDelta`, which has the same shape regardless of backend.
- **Wire surface (this is also an IPC action):** schemas live in `@ax/workspace-protocol`, adjacent to (not inside) `@ax/ipc-protocol`. Protocol-vs-action separation matches the IPC slice's pattern.

## Security

- `@ax/workspace-git-core/SECURITY.md` — substantive walk (mostly the existing `@ax/workspace-git/SECURITY.md`, with the package boundary updated).
- `@ax/workspace-git-http/SECURITY.md` — new wire surface; bearer auth is a static service token (NOT a session token); explicit no-DR known limit; rotation story documented.
- `deploy/charts/ax-next/SECURITY.md` — git-server pod section (RBAC, NetworkPolicy, PVC, no-DR limit).
- `@ax/workspace-git/SECURITY.md` — drops the "single-replica only" known limit (the http variant addresses it for production).

## I1 proof

- `runWorkspaceContract('@ax/workspace-git-http', ...)` passes — all 9 assertions, same suite as `@ax/workspace-git`.
- `runWorkspaceContract('@ax/workspace-git-core', ...)` passes — proves the extraction is honest.
- Multi-replica concurrency test in `@ax/workspace-git-http` passes — three host plugins fire concurrent applies, exactly one wins per round, retries produce a linear history with all changes.

## What's NOT in this PR (deliberate)

- HPA + PDB (follow-up #9 from the followups doc — needs a soak test under load).
- DR / backup mechanism (documented as a known limit; future work).
- Conflict-retry-with-backoff loop in the host plugin (handoff scope decision 4 — defer until a real workload demands it).
- Production wiring discovery showed [path A or B from Task 19] — see commit history.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

**Step 5: Report**

Reply with the PR URL and a one-paragraph summary of the contract-test + multi-replica-test outcomes. If any test was skipped, marked `.todo`, or papered over — call it out explicitly. Use `superpowers:requesting-code-review` if appropriate.

---

## Acceptance criteria summary

**Automated:**
- ☐ `runWorkspaceContract('@ax/workspace-git-http', ...)` passes — all 9 assertions (the I1 proof).
- ☐ `runWorkspaceContract('@ax/workspace-git-core', ...)` passes (the extraction is honest).
- ☐ `runWorkspaceContract('@ax/workspace-git', ...)` still passes (the wrapper rewrite didn't regress).
- ☐ Multi-replica concurrency test passes (3 host plugins, one git-server, linear history with all changes).
- ☐ Auth tests pass (timing-safe compare, no token echo).
- ☐ Listener tests pass (five gates: method, healthz, content-type, auth, body cap).
- ☐ Client tests pass (round-trip, parent-mismatch, connection-refused, timeout).
- ☐ Server entrypoint test passes (boots from env, logs URL, clean shutdown).
- ☐ `pnpm test` green across the monorepo.

**Manual:**
- ☐ `helm template` renders cleanly for both `workspace.backend=local` and `workspace.backend=http --set gitServer.enabled=true`.
- ☐ `deploy/MANUAL-ACCEPTANCE.md` has a multi-replica chat section.
- ☐ Three SECURITY.md updates (workspace-git-core: new; workspace-git-http: new; workspace-git: shrunk; chart: git-server section added).

**Process:**
- ☐ Branch is `feat/workspace-git-http` off `main`.
- ☐ One commit per task (no megacommits).
- ☐ Changeset present.
- ☐ Bug-fix policy: any bug surfaced during execution had a regression test added BEFORE the fix.
