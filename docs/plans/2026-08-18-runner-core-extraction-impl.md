# `@ax/agent-runner-core` Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the loop-agnostic 56% of `@ax/agent-claude-sdk-runner` into a new shared library `@ax/agent-runner-core`, with **no behaviour change**, so a second runner can reuse it.

**Architecture:** New private workspace package `packages/agent-runner-core` holding workspace/transcript/skills/proxy/prompt machinery plus a runner-agnostic tool policy. `@ax/agent-claude-sdk-runner` keeps only the Claude Agent SDK loop, its hook adapters, and the jsonl transcript locator, importing everything else from core. Three modules split along a policy/adapter seam rather than moving whole; `main.ts` becomes a `runRunner()` shell parameterized over a `Loop` interface.

**Tech Stack:** TypeScript 6, pnpm workspaces, tsconfig project references, vitest 4, zod 3.

**Spec:** `docs/plans/2026-08-18-provider-agnostic-runner-design.md` (§1 and §2)

## Global Constraints

- **No behaviour change.** This PR adds no feature and changes no runtime semantics. Every existing test must pass unmodified except for import-path updates. If a test needs a logic change to pass, stop — that is a bug in the move, not in the test.
- **No new runtime dependencies.** `@ax/agent-runner-core` may depend only on what `@ax/agent-claude-sdk-runner` already depends on, minus `@anthropic-ai/claude-agent-sdk`.
- **`@anthropic-ai/claude-agent-sdk` must never appear in `packages/agent-runner-core`.** Task 9 asserts this mechanically.
- **Invariant 2 (no cross-plugin imports):** `@ax/agent-runner-core` must be added to the `no-restricted-imports` allowlist in `eslint.config.mjs` (Task 1). This is a **boundary-review item** for the PR description.
- **Package scaffolding is fixed by convention** — copy `packages/skills-parser/package.json`, `tsconfig.json`, and `packages/ipc-protocol/vitest.config.ts` shapes exactly.
- **Tests live in `src/__tests__/*.test.ts`** and import the module under test with an explicit `.js` extension (e.g. `../home-bin-env.js`).
- **Pre-PR check is `pnpm build && pnpm test && pnpm lint`** — vitest tolerates undeclared workspace deps, `tsc` does not.
- **Scope `pnpm lint` to changed files.** A repo-wide `pnpm lint` exits 1 from stale `.worktrees/` copies.

---

### Task 1: Scaffold `@ax/agent-runner-core` and move the four pure env builders

Proves the whole wiring path — workspace membership, tsconfig references, eslint allowlist, vitest — using the smallest, purest modules in the package. Nothing here has a dependency on anything else in the runner.

**Files:**
- Create: `packages/agent-runner-core/package.json`
- Create: `packages/agent-runner-core/tsconfig.json`
- Create: `packages/agent-runner-core/vitest.config.ts`
- Create: `packages/agent-runner-core/src/index.ts`
- Move: `packages/agent-claude-sdk-runner/src/{home-bin-env,tty-hint-env,tool-cache-env,commit-trace}.ts` → `packages/agent-runner-core/src/`
- Move: `packages/agent-claude-sdk-runner/src/__tests__/{home-bin-env,tty-hint-env,tool-cache-env}.test.ts` → `packages/agent-runner-core/src/__tests__/`
- Modify: `tsconfig.json` (root — add a project reference)
- Modify: `eslint.config.mjs:145-161` (allowlist + message)
- Modify: `packages/agent-claude-sdk-runner/package.json` (add dep), `tsconfig.json` (add reference)

**Interfaces:**
- Consumes: nothing.
- Produces: `@ax/agent-runner-core` exporting `buildHomeBinEnv`, `buildTtyHintEnv`, `buildToolCacheEnv`, `commitTrace` (re-exported from `src/index.ts`). All later tasks add exports to this same barrel file.

- [ ] **Step 1: Create the package manifest**

```json
{
  "name": "@ax/agent-runner-core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": { "build": "tsc --build", "test": "vitest run", "test:watch": "vitest" },
  "dependencies": {
    "@ax/agent-identity-templates": "workspace:*",
    "@ax/core": "workspace:*",
    "@ax/credential-proxy-bridge": "workspace:*",
    "@ax/ipc-protocol": "workspace:*",
    "@ax/tool-artifact-publish": "workspace:*",
    "@ax/tool-skill-propose": "workspace:*",
    "undici": "^6.28.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^25.6.0",
    "typescript": "^6.0.3",
    "vitest": "^4.1.4"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json` and `vitest.config.ts`**

`packages/agent-runner-core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*"],
  "exclude": ["src/__tests__/**", "dist", "node_modules"],
  "references": [
    { "path": "../core" },
    { "path": "../ipc-protocol" },
    { "path": "../credential-proxy-bridge" },
    { "path": "../agent-identity-templates" },
    { "path": "../tool-artifact-publish" },
    { "path": "../tool-skill-propose" }
  ]
}
```

`packages/agent-runner-core/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
  },
});
```

- [ ] **Step 3: Register the package in the root tsconfig and the eslint allowlist**

In root `tsconfig.json`, add to the `references` array (alongside the other entries):

```json
    { "path": "packages/agent-runner-core" },
```

In `eslint.config.mjs`, add to the `group` array immediately after `'!@ax/ipc-core',`:

```js
                '!@ax/agent-runner-core',
```

And in the same rule's `message` string, insert this clause after the `@ax/ipc-core (transport-agnostic IPC library)` clause:

```
@ax/agent-runner-core (loop-agnostic runner machinery shared between @ax/agent-claude-sdk-runner and @ax/agent-aisdk-runner),
```

- [ ] **Step 4: Move the four modules and their tests**

```bash
cd /Users/vpulim/dev/ai/ax-next
mkdir -p packages/agent-runner-core/src/__tests__
for f in home-bin-env tty-hint-env tool-cache-env commit-trace; do
  git mv packages/agent-claude-sdk-runner/src/$f.ts packages/agent-runner-core/src/$f.ts
done
for f in home-bin-env tty-hint-env tool-cache-env; do
  git mv packages/agent-claude-sdk-runner/src/__tests__/$f.test.ts \
         packages/agent-runner-core/src/__tests__/$f.test.ts
done
```

- [ ] **Step 5: Create the barrel export**

`packages/agent-runner-core/src/index.ts`:

```ts
// @ax/agent-runner-core — loop-agnostic runner machinery.
//
// Everything a runner does that is NOT the agent loop: workspace
// materialize/commit/bundle, the transcript delta protocol, uploads, the
// skills projection, proxy bootstrap, prompt composition, and the tool
// policy. Shared by @ax/agent-claude-sdk-runner and @ax/agent-aisdk-runner.
//
// This package must never import @anthropic-ai/claude-agent-sdk.
export { buildHomeBinEnv } from './home-bin-env.js';
export { buildTtyHintEnv } from './tty-hint-env.js';
export { buildToolCacheEnv } from './tool-cache-env.js';
export { commitTrace } from './commit-trace.js';
```

Verify the exported names match the actual declarations — if any differ, use the real name:

```bash
grep -hoE "export (function|const) [A-Za-z]+" packages/agent-runner-core/src/*.ts
```

- [ ] **Step 6: Re-point the runner's imports**

In `packages/agent-claude-sdk-runner/src/main.ts`, replace the four local imports:

```ts
import { buildToolCacheEnv } from './tool-cache-env.js';
import { buildHomeBinEnv } from './home-bin-env.js';
import { buildTtyHintEnv } from './tty-hint-env.js';
```

with a single core import (keep `commitTrace`'s existing import site in whichever file uses it):

```ts
import {
  buildToolCacheEnv,
  buildHomeBinEnv,
  buildTtyHintEnv,
} from '@ax/agent-runner-core';
```

Find every remaining referrer and update it the same way:

```bash
grep -rn "from './\(home-bin-env\|tty-hint-env\|tool-cache-env\|commit-trace\)\.js'" \
  packages/agent-claude-sdk-runner/src
```

Add to `packages/agent-claude-sdk-runner/package.json` dependencies:

```json
    "@ax/agent-runner-core": "workspace:*",
```

and to its `tsconfig.json` `references`:

```json
    { "path": "../agent-runner-core" },
```

- [ ] **Step 7: Install, build, and run both packages' tests**

```bash
pnpm install
pnpm build
pnpm --filter @ax/agent-runner-core test
pnpm --filter @ax/agent-claude-sdk-runner test
```

Expected: build succeeds; the three moved tests pass under `@ax/agent-runner-core`; the runner's remaining tests pass unchanged. If `tsc` reports an unresolved `@ax/agent-runner-core`, the root tsconfig reference or the runner's `references` entry is missing.

- [ ] **Step 8: Verify the SDK is absent from core**

```bash
grep -r "claude-agent-sdk" packages/agent-runner-core/ --include='*.ts' --include='*.json' | grep -v node_modules
```

Expected: no output.

- [ ] **Step 9: Lint the changed files only**

```bash
pnpm exec eslint packages/agent-runner-core/src packages/agent-claude-sdk-runner/src eslint.config.mjs
```

Expected: clean. A `no-restricted-imports` error on `@ax/agent-runner-core` means Step 3's allowlist edit did not take.

- [ ] **Step 10: Commit**

```bash
git add packages/agent-runner-core packages/agent-claude-sdk-runner tsconfig.json eslint.config.mjs pnpm-lock.yaml
git commit -m "refactor(runner-core): scaffold @ax/agent-runner-core + move pure env builders

No behaviour change. Establishes the package, its tsconfig reference, and
its eslint allowlist entry (invariant 2 boundary review), proven by moving
the four dependency-free env builders and their tests.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Move the remaining self-contained modules

Seven modules with no dependency on the SDK and no policy seam. Mechanical, but the largest single reduction in the runner's size.

**Files:**
- Move: `packages/agent-claude-sdk-runner/src/{env,identity-templates,local-dispatcher,proxy-ca-from-env,attachment-translation,materialize-uploads,python-venv}.ts` → `packages/agent-runner-core/src/`
- Move: the matching `src/__tests__/{env,identity-templates,local-dispatcher,proxy-ca-from-env,attachment-translation,materialize-uploads,python-venv}.test.ts`
- Modify: `packages/agent-runner-core/src/index.ts`
- Modify: importers under `packages/agent-claude-sdk-runner/src/`

**Interfaces:**
- Consumes: the `@ax/agent-runner-core` package from Task 1.
- Produces: additional barrel exports — `readRunnerEnv`, `createLocalDispatcher`, `writeProxyCaFromEnv`, `translateContentBlocks`, `materializeUploads`, `resolveMaterializedPath`, `uploadsBaseDir`, `buildPythonVenvEnv`, `scaffoldPythonVenv`, plus the identity-template re-exports, and the `WorkspaceReader` type.

- [ ] **Step 1: Move the modules and tests**

```bash
cd /Users/vpulim/dev/ai/ax-next
for f in env identity-templates local-dispatcher proxy-ca-from-env \
         attachment-translation materialize-uploads python-venv; do
  git mv packages/agent-claude-sdk-runner/src/$f.ts packages/agent-runner-core/src/$f.ts
  if [ -f packages/agent-claude-sdk-runner/src/__tests__/$f.test.ts ]; then
    git mv packages/agent-claude-sdk-runner/src/__tests__/$f.test.ts \
           packages/agent-runner-core/src/__tests__/$f.test.ts
  fi
done
```

- [ ] **Step 2: Extend the barrel**

Append to `packages/agent-runner-core/src/index.ts`:

```ts
export { readRunnerEnv } from './env.js';
export { createLocalDispatcher } from './local-dispatcher.js';
export { writeProxyCaFromEnv } from './proxy-ca-from-env.js';
export { translateContentBlocks } from './attachment-translation.js';
export type { WorkspaceReader } from './attachment-translation.js';
export {
  materializeUploads,
  resolveMaterializedPath,
  uploadsBaseDir,
} from './materialize-uploads.js';
export { buildPythonVenvEnv, scaffoldPythonVenv } from './python-venv.js';
export * from './identity-templates.js';
```

Confirm every name exists (fix any mismatch to the real name before proceeding):

```bash
grep -hoE "export (async function|function|const|type|interface) [A-Za-z]+" \
  packages/agent-runner-core/src/{env,local-dispatcher,proxy-ca-from-env,attachment-translation,materialize-uploads,python-venv,identity-templates}.ts
```

- [ ] **Step 3: Re-point importers**

```bash
grep -rn "from './\(env\|identity-templates\|local-dispatcher\|proxy-ca-from-env\|attachment-translation\|materialize-uploads\|python-venv\)\.js'" \
  packages/agent-claude-sdk-runner/src
```

Rewrite each hit to import from `@ax/agent-runner-core`. Merge into the existing core import block in `main.ts` rather than adding a second one.

- [ ] **Step 4: Build and test**

```bash
pnpm build
pnpm --filter @ax/agent-runner-core test
pnpm --filter @ax/agent-claude-sdk-runner test
```

Expected: all green, no test bodies edited.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-runner-core packages/agent-claude-sdk-runner
git commit -m "refactor(runner-core): move env, uploads, attachments, venv, dispatcher

No behaviour change; import paths only.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Move the workspace and proxy machinery

The heaviest modules by line count. Still mechanical — none of them import the SDK — but `git-workspace.ts` and `proxy-startup.ts` carry the most edge-case history in the package, so they get their own commit and their own review.

**Files:**
- Move: `packages/agent-claude-sdk-runner/src/{git-workspace,commit-notify-resync,proxy-startup,inbox-loop}.ts` → `packages/agent-runner-core/src/`
- Move: matching tests, plus `src/__tests__/{flush-workspace-host-teardown,flush-workspace-host.e2e}.test.ts`
- Modify: `packages/agent-runner-core/src/index.ts`, runner importers

**Interfaces:**
- Consumes: Task 1 package.
- Produces: barrel exports `commitTurnAndBundle`, `materializeWorkspace`, `scaffoldSdkProjectsSymlink`, `scaffoldWorkspaceGitignore`, `commitNotifyWithResync`, `flushWorkspaceToHost`, `setupProxy`, `createInboxLoop`, and the `FlushOutcome` type.

- [ ] **Step 1: Move the modules and tests**

```bash
cd /Users/vpulim/dev/ai/ax-next
for f in git-workspace commit-notify-resync proxy-startup inbox-loop; do
  git mv packages/agent-claude-sdk-runner/src/$f.ts packages/agent-runner-core/src/$f.ts
  if [ -f packages/agent-claude-sdk-runner/src/__tests__/$f.test.ts ]; then
    git mv packages/agent-claude-sdk-runner/src/__tests__/$f.test.ts \
           packages/agent-runner-core/src/__tests__/$f.test.ts
  fi
done
for t in flush-workspace-host-teardown flush-workspace-host.e2e; do
  git mv packages/agent-claude-sdk-runner/src/__tests__/$t.test.ts \
         packages/agent-runner-core/src/__tests__/$t.test.ts
done
```

`scaffoldSdkProjectsSymlink` moves with `git-workspace.ts` even though only the SDK runner calls it. It is filesystem scaffolding with no SDK import, and splitting one function out of a 579-line module would cost more than it saves. Note it in the PR description as knowingly SDK-flavoured code living in core.

- [ ] **Step 2: Extend the barrel**

```ts
export {
  commitTurnAndBundle,
  materializeWorkspace,
  scaffoldSdkProjectsSymlink,
  scaffoldWorkspaceGitignore,
} from './git-workspace.js';
export { commitNotifyWithResync, flushWorkspaceToHost } from './commit-notify-resync.js';
export type { FlushOutcome } from './commit-notify-resync.js';
export { setupProxy } from './proxy-startup.js';
export { createInboxLoop } from './inbox-loop.js';
```

- [ ] **Step 3: Re-point importers, build, and test**

```bash
grep -rn "from './\(git-workspace\|commit-notify-resync\|proxy-startup\|inbox-loop\)\.js'" \
  packages/agent-claude-sdk-runner/src
pnpm build
pnpm --filter @ax/agent-runner-core test
pnpm --filter @ax/agent-claude-sdk-runner test
```

Expected: all green. `proxy-startup.test.ts` asserts the `ENV_ALLOWLIST` contents — if it fails, an import rewrite changed a constant, which is a behaviour change and must be reverted.

- [ ] **Step 4: Commit**

```bash
git add packages/agent-runner-core packages/agent-claude-sdk-runner
git commit -m "refactor(runner-core): move git-workspace, commit-notify-resync, proxy-startup, inbox-loop

No behaviour change; import paths only.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Move skills, prompt, and the two tool executors

**Files:**
- Move: `packages/agent-claude-sdk-runner/src/{installed-skills,prompt-engine,skill-propose-executor,artifact-publish-executor}.ts` → `packages/agent-runner-core/src/`
- Move: matching tests, plus `src/__tests__/artifact-publish-e2e.test.ts`
- Modify: `packages/agent-runner-core/src/index.ts`, runner importers, `packages/agent-claude-sdk-runner/src/main.ts` (its re-export block)

**Interfaces:**
- Consumes: Task 1 package.
- Produces: barrel exports `materializeInstalledSkillsFromEnv`, `buildSystemPrompt`, `createSkillProposeExecutor`, `createArtifactPublishExecutor`, and the types `ArtifactPublishOutput`, `CreateArtifactPublishExecutorOptions`.

- [ ] **Step 1: Move the modules and tests**

```bash
cd /Users/vpulim/dev/ai/ax-next
for f in installed-skills prompt-engine skill-propose-executor artifact-publish-executor; do
  git mv packages/agent-claude-sdk-runner/src/$f.ts packages/agent-runner-core/src/$f.ts
  if [ -f packages/agent-claude-sdk-runner/src/__tests__/$f.test.ts ]; then
    git mv packages/agent-claude-sdk-runner/src/__tests__/$f.test.ts \
           packages/agent-runner-core/src/__tests__/$f.test.ts
  fi
done
git mv packages/agent-claude-sdk-runner/src/__tests__/artifact-publish-e2e.test.ts \
       packages/agent-runner-core/src/__tests__/artifact-publish-e2e.test.ts
```

- [ ] **Step 2: Extend the barrel**

```ts
export { materializeInstalledSkillsFromEnv } from './installed-skills.js';
export { buildSystemPrompt } from './prompt-engine.js';
export { createSkillProposeExecutor } from './skill-propose-executor.js';
export { createArtifactPublishExecutor } from './artifact-publish-executor.js';
export type {
  ArtifactPublishOutput,
  CreateArtifactPublishExecutorOptions,
} from './artifact-publish-executor.js';
```

- [ ] **Step 3: Preserve the runner's public re-exports**

`packages/agent-claude-sdk-runner/src/main.ts` currently re-exports the two executors (the canary acceptance test imports `createArtifactPublishExecutor` from the runner). Keep that surface intact by re-exporting from core instead of from local files:

```ts
export {
  createArtifactPublishExecutor,
  createSkillProposeExecutor,
} from '@ax/agent-runner-core';
export type {
  ArtifactPublishOutput,
  CreateArtifactPublishExecutorOptions,
} from '@ax/agent-runner-core';
```

- [ ] **Step 4: Build and run the full suite**

```bash
pnpm build
pnpm test
```

Expected: green repo-wide. The canary acceptance test in `packages/cli` exercises `createArtifactPublishExecutor` through the runner's export — if it fails to resolve, Step 3 did not take.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-runner-core packages/agent-claude-sdk-runner
git commit -m "refactor(runner-core): move installed-skills, prompt-engine, tool executors

Runner keeps its public re-export surface (canary imports it) by
re-exporting from core. No behaviour change.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Split the tool policy out of the PreToolUse hook

The load-bearing task. Today `createPreToolUseHook` does five things: classify an SDK tool name, deny disabled tools, re-root governed paths, call `tool.pre-call`, and map the verdict into the SDK's `hookSpecificOutput` shape. Only the first, second, and last are SDK-specific.

This task is genuine TDD: the policy is new code with a new interface, tested directly.

**Files:**
- Create: `packages/agent-runner-core/src/tool-policy.ts`
- Create: `packages/agent-runner-core/src/__tests__/tool-policy.test.ts`
- Move: `packages/agent-claude-sdk-runner/src/pre-tool-use.ts` path-resolution helpers → `packages/agent-runner-core/src/governed-paths.ts`
- Modify: `packages/agent-claude-sdk-runner/src/pre-tool-use.ts` (becomes a thin adapter)
- Modify: `packages/agent-runner-core/src/index.ts`
- Keep: `packages/agent-claude-sdk-runner/src/__tests__/pre-tool-use.test.ts` in place, unmodified

**Interfaces:**
- Consumes: `@ax/agent-runner-core` from Task 1.
- Produces:

```ts
export type PreToolVerdict =
  | { decision: 'deny'; reason: string }
  | { decision: 'allow'; updatedInput?: Record<string, unknown> };

export interface ToolPolicy {
  preToolUse(
    axToolName: string,
    toolInput: unknown,
    toolUseId: string,
  ): Promise<PreToolVerdict>;
}

export function createToolPolicy(opts: {
  client: IpcClient;
  workspaceRoot: string;
  broaden?: boolean;
  recognizedRoots?: readonly string[];
}): ToolPolicy;
```

  Also `resolveGovernedPaths` and `resolveAttachmentPaths`, moved verbatim to `governed-paths.ts`.

- [ ] **Step 1: Write the failing test**

`packages/agent-runner-core/src/__tests__/tool-policy.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createToolPolicy } from '../tool-policy.js';

function fakeClient(response: unknown) {
  return { call: vi.fn().mockResolvedValue(response) } as never;
}

describe('createToolPolicy', () => {
  it('forwards the re-rooted input to tool.pre-call and allows on accept', async () => {
    const client = fakeClient({ verdict: 'allow' });
    const policy = createToolPolicy({ client, workspaceRoot: '/agent' });

    const verdict = await policy.preToolUse(
      'Read',
      { file_path: '.ax/uploads/c1/t1/a.pdf' },
      'call-1',
    );

    expect(verdict).toEqual({
      decision: 'allow',
      updatedInput: { file_path: '/agent/.ax/uploads/c1/t1/a.pdf' },
    });
    expect((client as never as { call: ReturnType<typeof vi.fn> }).call)
      .toHaveBeenCalledWith('tool.pre-call', {
        call: {
          id: 'call-1',
          name: 'Read',
          input: { file_path: '/agent/.ax/uploads/c1/t1/a.pdf' },
        },
      });
  });

  it('denies when the host rejects, carrying the reason', async () => {
    const client = fakeClient({ verdict: 'reject', reason: 'npm not permitted' });
    const policy = createToolPolicy({ client, workspaceRoot: '/agent' });

    await expect(policy.preToolUse('Bash', { command: 'npm i' }, 'call-2'))
      .resolves.toEqual({ decision: 'deny', reason: 'npm not permitted' });
  });

  it('denies (fail-closed) when the IPC call throws', async () => {
    const client = { call: vi.fn().mockRejectedValue(new Error('socket closed')) } as never;
    const policy = createToolPolicy({ client, workspaceRoot: '/agent' });

    await expect(policy.preToolUse('Bash', { command: 'ls' }, 'call-3'))
      .resolves.toEqual({ decision: 'deny', reason: 'socket closed' });
  });

  it('prefers the host modifiedCall input over our re-rooted input', async () => {
    // modifiedCall is a full ToolCallSchema — { id, name, input }.
    const client = fakeClient({
      verdict: 'allow',
      modifiedCall: {
        id: 'call-4',
        name: 'Read',
        input: { file_path: '/permanent/a.pdf' },
      },
    });
    const policy = createToolPolicy({ client, workspaceRoot: '/agent' });

    await expect(
      policy.preToolUse('Read', { file_path: '.ax/uploads/c1/t1/a.pdf' }, 'call-4'),
    ).resolves.toEqual({
      decision: 'allow',
      updatedInput: { file_path: '/permanent/a.pdf' },
    });
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
pnpm --filter @ax/agent-runner-core test -- tool-policy
```

Expected: FAIL — cannot resolve `../tool-policy.js`.

- [ ] **Step 3: Move the path helpers to core**

```bash
cd /Users/vpulim/dev/ai/ax-next
git mv packages/agent-claude-sdk-runner/src/pre-tool-use.ts \
       packages/agent-runner-core/src/governed-paths.ts
```

Then in `governed-paths.ts`, delete `createPreToolUseHook`, `CreatePreToolUseHookOptions`, and every `@anthropic-ai/claude-agent-sdk` and `classifySdkToolName` import. Keep the path-resolution helpers and their two exported entry points (`resolveGovernedPaths`, `resolveAttachmentPaths`) plus the private helpers they call. Verify nothing SDK-shaped survives:

```bash
grep -nE "claude-agent-sdk|HookCallback|classifySdkToolName" packages/agent-runner-core/src/governed-paths.ts
```

Expected: no output.

- [ ] **Step 4: Write the policy**

`packages/agent-runner-core/src/tool-policy.ts`:

```ts
// Runner-agnostic tool policy. Re-roots governed paths, then adjudicates the
// call against the host's `tool.pre-call` hook. The SDK's PreToolUse hook and
// the aisdk runner's per-tool `execute` wrapper are both thin adapters over
// this — one policy, two runners (see the 2026-08-18 design, §2 and §3).
//
// Fail-closed: an IPC failure denies, so a racing disconnection cannot
// bypass host subscribers.
import { randomUUID } from 'node:crypto';
import {
  ToolPreCallResponseSchema,
  type IpcClient,
  type ToolPreCallResponse,
} from '@ax/ipc-protocol';
import { resolveGovernedPaths } from './governed-paths.js';

export type PreToolVerdict =
  | { decision: 'deny'; reason: string }
  | { decision: 'allow'; updatedInput?: Record<string, unknown> };

export interface ToolPolicy {
  preToolUse(
    axToolName: string,
    toolInput: unknown,
    toolUseId: string,
  ): Promise<PreToolVerdict>;
}

export interface CreateToolPolicyOptions {
  client: IpcClient;
  /** The governed root (`/agent`) re-rooting targets. Never cwd. */
  workspaceRoot: string;
  /** Widen from the `.ax/uploads/` safety-net to the full validator policy. */
  broaden?: boolean;
  recognizedRoots?: readonly string[];
  idGen?: () => string;
}

export function createToolPolicy(opts: CreateToolPolicyOptions): ToolPolicy {
  const idGen = opts.idGen ?? ((): string => randomUUID());
  const broaden = opts.broaden ?? false;
  const recognizedRoots = opts.recognizedRoots ?? [];

  return {
    async preToolUse(axToolName, toolInput, toolUseId) {
      const resolved = resolveGovernedPaths(toolInput, opts.workspaceRoot, {
        broaden,
        recognizedRoots,
      });

      let parsed: ToolPreCallResponse;
      try {
        const raw = await opts.client.call('tool.pre-call', {
          call: {
            id: toolUseId || idGen(),
            name: axToolName,
            input: resolved.input,
          },
        });
        parsed = ToolPreCallResponseSchema.parse(raw) as ToolPreCallResponse;
      } catch (err) {
        return {
          decision: 'deny',
          reason: err instanceof Error ? err.message : String(err),
        };
      }

      if (parsed.verdict === 'reject') {
        return { decision: 'deny', reason: parsed.reason };
      }

      const hostModified =
        parsed.modifiedCall?.input !== undefined &&
        parsed.modifiedCall.input !== null &&
        typeof parsed.modifiedCall.input === 'object';
      if (hostModified) {
        return {
          decision: 'allow',
          updatedInput: parsed.modifiedCall!.input as Record<string, unknown>,
        };
      }
      if (resolved.changed) {
        return { decision: 'allow', updatedInput: resolved.input };
      }
      return { decision: 'allow' };
    },
  };
}
```

- [ ] **Step 5: Run the policy test**

```bash
pnpm --filter @ax/agent-runner-core test -- tool-policy
```

Expected: PASS, all four cases.

- [ ] **Step 6: Rewrite the SDK hook as an adapter**

Create `packages/agent-claude-sdk-runner/src/pre-tool-use.ts` (the file was moved in Step 3; this is a new, much smaller file):

```ts
// SDK adapter over the runner-agnostic ToolPolicy in @ax/agent-runner-core.
// Responsibilities kept here are exactly the SDK-shaped ones: classifying the
// SDK's tool name, short-circuiting disabled built-ins, and mapping a
// PreToolVerdict onto `hookSpecificOutput`.
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { createToolPolicy, type CreateToolPolicyOptions } from '@ax/agent-runner-core';
import { classifySdkToolName } from './tool-names.js';

export type CreatePreToolUseHookOptions = CreateToolPolicyOptions;

export function createPreToolUseHook(
  opts: CreatePreToolUseHookOptions,
): HookCallback {
  const policy = createToolPolicy(opts);

  return async (input, toolUseID, _options) => {
    if (input.hook_event_name !== 'PreToolUse') {
      return {};
    }

    const klass = classifySdkToolName(input.tool_name);
    if (klass.kind === 'disabled') {
      // Belt-and-braces: disallowedTools should already block these.
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'tool disabled by policy',
        },
      };
    }

    const verdict = await policy.preToolUse(
      klass.axName,
      input.tool_input,
      toolUseID ?? '',
    );

    if (verdict.decision === 'deny') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: verdict.reason,
        },
      };
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        ...(verdict.updatedInput !== undefined
          ? { updatedInput: verdict.updatedInput }
          : {}),
      },
    };
  };
}
```

- [ ] **Step 7: Export the policy from core and re-point the path-helper importers**

Append to `packages/agent-runner-core/src/index.ts`:

```ts
export { createToolPolicy } from './tool-policy.js';
export type {
  ToolPolicy,
  PreToolVerdict,
  CreateToolPolicyOptions,
} from './tool-policy.js';
export { resolveGovernedPaths, resolveAttachmentPaths } from './governed-paths.js';
```

Find anything still importing the helpers from the old path and re-point it to `@ax/agent-runner-core`:

```bash
grep -rn "resolveGovernedPaths\|resolveAttachmentPaths" packages/agent-claude-sdk-runner/src
```

- [ ] **Step 8: Run the untouched pre-tool-use test**

```bash
pnpm build
pnpm --filter @ax/agent-claude-sdk-runner test -- pre-tool-use
```

Expected: PASS with **no edits to the test file**. This is the proof the refactor preserved behaviour — the existing suite covers the disabled-tool short-circuit, re-rooting, reject mapping, and `updatedInput` forwarding. If a case fails, the adapter's mapping is wrong; fix the adapter, not the test.

The one legitimate exception: if a test imported `resolveGovernedPaths` from `'../pre-tool-use.js'`, update that **import line only** to `'@ax/agent-runner-core'`. No assertion may change.

- [ ] **Step 9: Commit**

```bash
git add packages/agent-runner-core packages/agent-claude-sdk-runner
git commit -m "refactor(runner-core): extract ToolPolicy from the PreToolUse hook

The re-root + tool.pre-call adjudication is now runner-agnostic; the SDK
hook is a thin adapter that classifies the tool name and maps the verdict.
One security policy, two runners. Existing pre-tool-use tests pass
unmodified.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Split the PostToolUse hook the same way

**Files:**
- Modify: `packages/agent-runner-core/src/tool-policy.ts` (add `postToolUse`)
- Modify: `packages/agent-runner-core/src/__tests__/tool-policy.test.ts`
- Create: `packages/agent-runner-core/src/egress-note.ts`
- Modify: `packages/agent-claude-sdk-runner/src/post-tool-use.ts` (thin adapter)
- Keep: `packages/agent-claude-sdk-runner/src/__tests__/post-tool-use.test.ts` unmodified

**Interfaces:**
- Consumes: `ToolPolicy` from Task 5.
- Produces:

```ts
postToolUse(
  axToolName: string,
  toolUseId: string,
  toolInput: unknown,
  toolOutput: unknown,
): Promise<{ note?: string }>;
```

  on `ToolPolicy`, plus `buildEgressBlockNote(hosts: string[]): string` (moved verbatim). Two behaviours, both preserved exactly from the current hook: fire `event.tool-post-call` fire-and-forget (a dropped audit event is recoverable; a hung turn is not), and — **only for `Bash`** — drain the session's egress blocks and return a remediation note. A drain failure degrades to silent.

- [ ] **Step 1: Write the failing test**

Append to `packages/agent-runner-core/src/__tests__/tool-policy.test.ts`:

```ts
describe('ToolPolicy.postToolUse', () => {
  function policyWith(drain: () => Promise<string[]>) {
    const client = { call: vi.fn(), event: vi.fn().mockResolvedValue(undefined) };
    const policy = createToolPolicy({
      client: client as never,
      workspaceRoot: '/agent',
      drainEgressBlocks: drain,
    });
    return { policy, client };
  }

  it('fires event.tool-post-call with the call and output', async () => {
    const { policy, client } = policyWith(async () => []);
    await policy.postToolUse('Read', 'call-1', { file_path: '/agent/a.ts' }, 'contents');
    expect(client.event).toHaveBeenCalledWith('event.tool-post-call', {
      call: { id: 'call-1', name: 'Read', input: { file_path: '/agent/a.ts' } },
      output: 'contents',
    });
  });

  it('returns a remediation note when Bash hit blocked hosts', async () => {
    const { policy } = policyWith(async () => ['registry.npmjs.org']);
    const out = await policy.postToolUse('Bash', 'call-2', { command: 'npm i' }, '');
    expect(out.note).toContain('registry.npmjs.org');
  });

  it('does not drain for non-Bash tools', async () => {
    const drain = vi.fn().mockResolvedValue(['registry.npmjs.org']);
    const { policy } = policyWith(drain);
    await expect(policy.postToolUse('Read', 'call-3', {}, '')).resolves.toEqual({});
    expect(drain).not.toHaveBeenCalled();
  });

  it('degrades to silent when the drain throws', async () => {
    const { policy } = policyWith(async () => {
      throw new Error('proxy gone');
    });
    await expect(policy.postToolUse('Bash', 'call-4', { command: 'ls' }, ''))
      .resolves.toEqual({});
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
pnpm --filter @ax/agent-runner-core test -- tool-policy
```

Expected: FAIL — `policy.postToolUse is not a function`.

- [ ] **Step 3: Move the note builder**

Move `buildEgressBlockNote` verbatim out of `packages/agent-claude-sdk-runner/src/post-tool-use.ts` into a new `packages/agent-runner-core/src/egress-note.ts`, exporting it unchanged. Copy the function body exactly — the wording is agent-facing and must not drift.

- [ ] **Step 4: Add `postToolUse` to the policy**

In `tool-policy.ts`, add to `CreateToolPolicyOptions`:

```ts
  /** Drain the hosts this session was allowlist-blocked on since the last call. */
  drainEgressBlocks?: () => Promise<string[]>;
```

add to the `ToolPolicy` interface:

```ts
  postToolUse(
    axToolName: string,
    toolUseId: string,
    toolInput: unknown,
    toolOutput: unknown,
  ): Promise<{ note?: string }>;
```

and add to the returned object:

```ts
    async postToolUse(axToolName, toolUseId, toolInput, toolOutput) {
      // Fire-and-forget. Failures here must not stall the turn loop; dropping
      // an audit event is recoverable, a hung turn is not.
      void opts.client
        .event('event.tool-post-call', {
          call: { id: toolUseId, name: axToolName, input: toolInput },
          output: toolOutput,
        })
        .catch(() => {
          /* swallow — fire-and-forget */
        });

      // Bash is the one tool through which the agent initiates sandbox egress
      // (npx / curl / git / pip), so we drain its blocks right after it runs.
      // The proxy denies the CONNECT before the command returns, so by here
      // the block is already buffered.
      if (opts.drainEgressBlocks === undefined || axToolName !== 'Bash') {
        return {};
      }
      let hosts: string[] = [];
      try {
        hosts = await opts.drainEgressBlocks();
      } catch {
        // A best-effort note must never break the turn loop — degrade to silent.
        hosts = [];
      }
      return hosts.length > 0 ? { note: buildEgressBlockNote(hosts) } : {};
    },
```

with `import { buildEgressBlockNote } from './egress-note.js';` at the top.

- [ ] **Step 5: Run the test**

```bash
pnpm --filter @ax/agent-runner-core test -- tool-policy
```

Expected: PASS, all six cases.

- [ ] **Step 6: Rewrite the SDK hook as an adapter and export from core**

Rewrite `packages/agent-claude-sdk-runner/src/post-tool-use.ts`:

```ts
// SDK adapter over ToolPolicy.postToolUse. Keeps only the SDK-shaped parts:
// event-name narrowing, tool-name classification, and mapping a note onto
// `hookSpecificOutput.additionalContext`.
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { createToolPolicy, type CreateToolPolicyOptions } from '@ax/agent-runner-core';
import { classifySdkToolName } from './tool-names.js';

export type CreatePostToolUseHookOptions = CreateToolPolicyOptions;

export function createPostToolUseHook(
  opts: CreatePostToolUseHookOptions,
): HookCallback {
  const policy = createToolPolicy(opts);

  return async (input, toolUseID, _options) => {
    // Defensive narrow — a misconfigured hook map must not leak a different
    // payload shape onto the wire.
    if (input.hook_event_name !== 'PostToolUse') {
      return {};
    }

    const klass = classifySdkToolName(input.tool_name);
    if (klass.kind === 'disabled') {
      return {};
    }

    const { note } = await policy.postToolUse(
      klass.axName,
      toolUseID ?? '',
      input.tool_input,
      input.tool_response,
    );

    return note === undefined
      ? {}
      : {
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: note,
          },
        };
  };
}
```

Note the Bash gate moved into the policy but the `klass.kind === 'builtin'` half of the original condition is now implicit: only a built-in can be named `Bash`, since MCP tool names are prefix-stripped to their ax names and no MCP server registers a tool called `Bash`. If `post-tool-use.test.ts` has a case asserting an MCP tool named `Bash` is not drained, keep the explicit `klass.kind === 'builtin'` check in this adapter and pass a boolean through instead.

Append to `packages/agent-runner-core/src/index.ts`:

```ts
export { buildEgressBlockNote } from './egress-note.js';
```

- [ ] **Step 7: Build and run both suites**

```bash
pnpm build
pnpm --filter @ax/agent-runner-core test
pnpm --filter @ax/agent-claude-sdk-runner test -- post-tool-use
```

Expected: PASS with no edits to `post-tool-use.test.ts` assertions.

- [ ] **Step 8: Commit**

```bash
git add packages/agent-runner-core packages/agent-claude-sdk-runner
git commit -m "refactor(runner-core): extract postToolUse + egress note into ToolPolicy

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Split the transcript delta protocol behind a `TranscriptSource`

`transcript-delta.ts` has no SDK import but is semantically bound to it: `locateJsonl` readdir-walks `$CLAUDE_CONFIG_DIR/projects/<cwd-slug>/` because the slug is the SDK's private encoding of `realpath(cwd)`. The delta/`prefixHash`/resync protocol above it is runner-agnostic.

**Files:**
- Move: `packages/agent-claude-sdk-runner/src/transcript-delta.ts` → `packages/agent-runner-core/src/transcript-delta.ts`
- Create: `packages/agent-claude-sdk-runner/src/jsonl-transcript-source.ts`
- Create: `packages/agent-claude-sdk-runner/src/__tests__/jsonl-transcript-source.test.ts`
- Move: `packages/agent-claude-sdk-runner/src/__tests__/transcript-delta.test.ts` → core
- Modify: `packages/agent-runner-core/src/index.ts`, `main.ts`

**Interfaces:**
- Consumes: Task 1 package.
- Produces:

```ts
export interface TranscriptSource {
  /** Absolute path to the transcript bytes, or null when none exists yet. */
  locate(sessionId: string): Promise<string | null>;
}
```

  plus the existing `shipTranscriptDelta`, `restoreTranscriptForResume`, `splitCompleteLines`, `hashBytes`, `encodeProjectSlug`, and the `TranscriptShipState` / `ShipDeltaResult` types, all moved verbatim. `shipTranscriptDelta` and `restoreTranscriptForResume` take a `source: TranscriptSource` in place of calling `locateJsonl` directly.

- [ ] **Step 1: Move the module and its test**

```bash
cd /Users/vpulim/dev/ai/ax-next
git mv packages/agent-claude-sdk-runner/src/transcript-delta.ts \
       packages/agent-runner-core/src/transcript-delta.ts
git mv packages/agent-claude-sdk-runner/src/__tests__/transcript-delta.test.ts \
       packages/agent-runner-core/src/__tests__/transcript-delta.test.ts
```

- [ ] **Step 2: Introduce the interface in core**

In `packages/agent-runner-core/src/transcript-delta.ts`, add:

```ts
/**
 * Where a runner's transcript bytes live. The SDK runner hunts for the SDK's
 * jsonl; a runner that owns its own messages serializes them itself. The
 * delta/prefixHash protocol below is identical either way.
 */
export interface TranscriptSource {
  locate(sessionId: string): Promise<string | null>;
}
```

Change `shipTranscriptDelta` and `restoreTranscriptForResume` to accept `source: TranscriptSource` in their input object and call `input.source.locate(sessionId)` where they currently call `locateJsonl(...)`. Move `locateJsonl` and `encodeProjectSlug` **out** of this file (Step 3) — everything else stays byte-for-byte.

- [ ] **Step 3: Create the SDK's implementation**

`packages/agent-claude-sdk-runner/src/jsonl-transcript-source.ts` — move `locateJsonl` and `encodeProjectSlug` here verbatim, then:

```ts
import type { TranscriptSource } from '@ax/agent-runner-core';

/**
 * The Claude Agent SDK writes `${CLAUDE_CONFIG_DIR}/projects/<cwd-slug>/<sid>.jsonl`.
 * We don't know the slug a priori (it's the SDK's encoding of realpath(cwd)),
 * so we readdir-walk the projects dir and pick the dir holding the file.
 */
export function createJsonlTranscriptSource(workspaceRoot: string): TranscriptSource {
  return {
    locate: (sessionId: string) => locateJsonl(workspaceRoot, sessionId),
  };
}
```

Match `locateJsonl`'s real parameter order when writing the call — check it before assuming:

```bash
grep -n -A6 "export async function locateJsonl" packages/agent-claude-sdk-runner/src/jsonl-transcript-source.ts
```

- [ ] **Step 4: Write a test for the SDK source**

`packages/agent-claude-sdk-runner/src/__tests__/jsonl-transcript-source.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJsonlTranscriptSource } from '../jsonl-transcript-source.js';

describe('createJsonlTranscriptSource', () => {
  it('finds the jsonl under an unknown project slug', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonl-src-'));
    const dir = join(root, '.claude', 'projects', '-some-encoded-slug');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'sess-1.jsonl'), '{"type":"user"}\n');

    const source = createJsonlTranscriptSource(root);
    await expect(source.locate('sess-1')).resolves.toBe(join(dir, 'sess-1.jsonl'));
  });

  it('returns null when no transcript exists yet', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonl-src-'));
    const source = createJsonlTranscriptSource(root);
    await expect(source.locate('sess-missing')).resolves.toBeNull();
  });
});
```

- [ ] **Step 5: Run it**

```bash
pnpm build
pnpm --filter @ax/agent-claude-sdk-runner test -- jsonl-transcript-source
```

Expected: PASS. If the first case fails on the path layout, read `locateJsonl`'s actual walk and fix the **test fixture** to match the real directory shape — this test documents existing behaviour, so the implementation is the source of truth here.

- [ ] **Step 6: Wire the source through `main.ts` and export from core**

In `main.ts`, construct the source once and pass it to both call sites:

```ts
import { createJsonlTranscriptSource } from './jsonl-transcript-source.js';
// ...
const transcriptSource = createJsonlTranscriptSource(env.workspaceRoot);
```

then add `source: transcriptSource` to the existing `shipTranscriptDelta({...})` and `restoreTranscriptForResume({...})` call sites.

Append to `packages/agent-runner-core/src/index.ts`:

```ts
export {
  shipTranscriptDelta,
  restoreTranscriptForResume,
  splitCompleteLines,
  hashBytes,
} from './transcript-delta.js';
export type {
  TranscriptSource,
  TranscriptShipState,
  ShipDeltaResult,
} from './transcript-delta.js';
```

- [ ] **Step 7: Run the full suite**

```bash
pnpm build
pnpm test
```

Expected: green repo-wide. `transcript-delta.test.ts` moved to core and must pass with only its import line and a `source` stub added — no assertion changes.

- [ ] **Step 8: Commit**

```bash
git add packages/agent-runner-core packages/agent-claude-sdk-runner
git commit -m "refactor(runner-core): move the transcript delta protocol behind TranscriptSource

The offset/prefixHash/resync protocol is runner-agnostic; locating the bytes
is not. The SDK's projects-dir walk becomes createJsonlTranscriptSource.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Extract the `runRunner` shell from `main.ts`

The least mechanical task. `main.ts` (1,827 lines) is mostly boot orchestration — env read, IPC client construction, workspace materialize, uploads, skills projection, inbox wiring, turn-end commit and flush, `event.chat-end` emission — with the SDK `query()` options literal and the message loop embedded in the middle. The orchestration moves; the loop stays behind an interface.

**Review this task line by line. Do not bulk-move it.**

**Files:**
- Create: `packages/agent-runner-core/src/run-runner.ts`
- Create: `packages/agent-runner-core/src/__tests__/run-runner.test.ts`
- Modify: `packages/agent-claude-sdk-runner/src/main.ts`
- Keep: `packages/agent-claude-sdk-runner/src/__tests__/main.test.ts` — assertions unmodified

**Interfaces:**
- Consumes: everything exported in Tasks 1–7.
- Produces:

```ts
export interface LoopContext {
  /** Pulls the next user message; resolves null when the inbox says cancel. */
  nextMessage(): Promise<AgentMessage | null>;
  /** Emit an assistant text delta to the host (event.stream-chunk). */
  emitChunk(text: string): Promise<void>;
  /** Close a turn: ships the transcript delta, commits, flushes. */
  endTurn(input: EndTurnInput): Promise<void>;
}

export interface Loop {
  /** Runs until the inbox cancels or the loop errors. Resolves the exit code. */
  run(ctx: LoopContext): Promise<number>;
}

export interface RunnerSeams {
  /** Defaults to readRunnerEnv. Injected so the shell is testable without a live endpoint. */
  readEnv?: () => RunnerEnv;
}

export function runRunner(
  makeLoop: (deps: RunnerDeps) => Loop,
  seams?: RunnerSeams,
): Promise<number>;
```

  `RunnerDeps` carries the constructed `client`, `env`, `policy`, `transcriptSource`, and composed system prompt. Define its exact shape from what `main.ts` actually builds — do not invent fields. `RunnerEnv` is the return type of `readRunnerEnv` (Task 2); export it from core if it is not already exported.

- [ ] **Step 1: Inventory the boot sequence before moving anything**

```bash
grep -nE "^  (const|let|await|try|for|if|return)" packages/agent-claude-sdk-runner/src/main.ts | head -60
```

Write the ordered list of boot steps into the PR description as a checklist. Each one either moves to `runRunner` or stays with the loop; there is no third option. Exit-code semantics (0 normal, 1 abnormal, 2 fatal-during-bootstrap) and the "boot failures return 2 without firing `event.chat-end`" contract belong to `runRunner`.

- [ ] **Step 2: Write the failing test for the shell's exit-code contract**

`packages/agent-runner-core/src/__tests__/run-runner.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { runRunner } from '../run-runner.js';

describe('runRunner', () => {
  it('returns 2 and does not fire chat-end when boot fails', async () => {
    const makeLoop = vi.fn();
    const code = await runRunner(makeLoop, {
      readEnv: () => {
        throw new Error('missing AX_RUNNER_ENDPOINT');
      },
    });
    expect(code).toBe(2);
    expect(makeLoop).not.toHaveBeenCalled();
  });

  it('returns the loop exit code on a normal run', async () => {
    const loop = { run: vi.fn().mockResolvedValue(0) };
    const code = await runRunner(() => loop, { readEnv: () => fakeEnv() });
    expect(code).toBe(0);
    expect(loop.run).toHaveBeenCalledOnce();
  });

  it('returns 1 when the loop throws', async () => {
    const loop = { run: vi.fn().mockRejectedValue(new Error('sdk exploded')) };
    const code = await runRunner(() => loop, { readEnv: () => fakeEnv() });
    expect(code).toBe(1);
  });
});
```

Define `fakeEnv()` in the test file to return the minimal `RunnerEnv` shape `readRunnerEnv` produces — read `packages/agent-runner-core/src/env.ts` for the exact fields rather than guessing.

- [ ] **Step 3: Run it to confirm it fails**

```bash
pnpm --filter @ax/agent-runner-core test -- run-runner
```

Expected: FAIL — cannot resolve `../run-runner.js`.

- [ ] **Step 4: Move the boot orchestration**

Create `run-runner.ts` with this skeleton, then move each step from the Step 1 inventory that is not SDK-specific into the marked regions, **in its original order**:

```ts
import { readRunnerEnv } from './env.js';
import { createToolPolicy } from './tool-policy.js';
// ...remaining core imports as the moved steps require

export function runRunner(
  makeLoop: (deps: RunnerDeps) => Loop,
  seams: RunnerSeams = {},
): Promise<number> {
  return runRunnerInner(makeLoop, seams.readEnv ?? readRunnerEnv);
}

async function runRunnerInner(
  makeLoop: (deps: RunnerDeps) => Loop,
  readEnv: () => RunnerEnv,
): Promise<number> {
  // --- boot: any throw here returns 2 WITHOUT firing event.chat-end. The
  //     orchestrator's handle.exited watcher synthesizes the terminated
  //     outcome, so chat:end still fires exactly once per agent:invoke.
  let env: RunnerEnv;
  try {
    env = readEnv();
  } catch (err) {
    process.stderr.write(
      `runner: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  try {
    // MOVE HERE, in original order: IPC client construction, initial
    // tool.list, proxy CA + setupProxy, workspace materialize, uploads
    // materialize, installed-skills projection, python venv, prompt
    // composition, transcript restore-for-resume, inbox loop construction.
    // Any failure before the loop starts returns 2.
  } catch (err) {
    process.stderr.write(
      `runner: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  try {
    const loop = makeLoop(deps);
    return await loop.run(ctx);
  } catch {
    // --- loop threw: abnormal termination.
    return 1;
  } finally {
    // MOVE HERE: turn-end flush/teardown and event.chat-end emission, exactly
    // as main.ts orders them today.
  }
}
```

Do not restructure the moved steps while moving them. If a step's ordering looks wrong, leave it and raise it in review — reordering is a behaviour change.

- [ ] **Step 5: Run the shell test**

```bash
pnpm --filter @ax/agent-runner-core test -- run-runner
```

Expected: PASS, all three cases.

- [ ] **Step 6: Reduce `main.ts` to a loop**

`main.ts` keeps: the `query()` options literal, the `for await` message loop, `system-prompt.ts`, the two MCP servers, `can-use-tool`, `tool-names`, `telemetry-env`, `turn-end-uuid`, and the two hook adapters. Its `main()` becomes:

```ts
export async function main(): Promise<number> {
  return runRunner((deps) => createClaudeSdkLoop(deps));
}
```

Keep the existing executor re-exports at the top of the file (Task 4, Step 3) — the canary imports them.

- [ ] **Step 7: Run the full suite plus the canary**

```bash
pnpm build
pnpm test
pnpm --filter @ax/cli test
```

Expected: green, including `main.test.ts` with unmodified assertions and the CLI's canary acceptance test. This is the real gate on the extraction.

- [ ] **Step 8: Commit**

```bash
git add packages/agent-runner-core packages/agent-claude-sdk-runner
git commit -m "refactor(runner-core): extract runRunner shell; main.ts becomes the SDK loop

Boot orchestration (env, IPC, materialize, uploads, skills, inbox, turn-end
commit, chat-end) moves to core behind a Loop interface. Exit-code contract
(0/1/2) and the no-chat-end-on-boot-failure rule move with it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Guardrails, docs, and the PR

Locks the invariant mechanically so a later change cannot quietly reintroduce an SDK dependency into core.

**Files:**
- Create: `packages/agent-runner-core/src/__tests__/no-sdk-dependency.test.ts`
- Create: `packages/agent-runner-core/README.md`
- Modify: `.claude/memory/patterns.md`

- [ ] **Step 1: Write the guardrail test**

```ts
import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const SRC = new URL('..', import.meta.url).pathname;

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await tsFiles(full)));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('@ax/agent-runner-core', () => {
  it('never imports the Claude Agent SDK', async () => {
    const offenders: string[] = [];
    for (const file of await tsFiles(SRC)) {
      const body = await readFile(file, 'utf8');
      // Match real import/require sites, not prose. src/index.ts documents
      // this very rule in a comment, so a substring match self-trips.
      if (/(from|require\()\s*['"]@anthropic-ai\/claude-agent-sdk/.test(body)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('does not declare the SDK as a dependency', async () => {
    const pkg = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain(
      '@anthropic-ai/claude-agent-sdk',
    );
  });
});
```

- [ ] **Step 2: Run it**

```bash
pnpm --filter @ax/agent-runner-core test -- no-sdk-dependency
```

Expected: PASS both cases.

- [ ] **Step 3: Write the README**

`packages/agent-runner-core/README.md` — state what the package is (loop-agnostic runner machinery), the one hard rule (never import the Claude Agent SDK, enforced by test), the three seams (`ToolPolicy`, `TranscriptSource`, `Loop`), and a pointer to `docs/plans/2026-08-18-provider-agnostic-runner-design.md`.

- [ ] **Step 4: Record the pattern in project memory**

Append to `.claude/memory/patterns.md` a short entry: the policy/adapter seam (one `ToolPolicy`, per-runner adapters), the `TranscriptSource` seam, and the rule that core is SDK-free with a test enforcing it. Commit it with this task per the repo's memory policy.

- [ ] **Step 5: Full verification**

```bash
pnpm build
pnpm test
pnpm exec eslint packages/agent-runner-core/src packages/agent-claude-sdk-runner/src
```

Expected: all green. Do not run a repo-wide `pnpm lint` — it exits 1 from stale `.worktrees/` copies.

- [ ] **Step 6: Confirm the size split landed**

```bash
echo "core:   $(cat packages/agent-runner-core/src/*.ts | wc -l) lines"
echo "runner: $(cat packages/agent-claude-sdk-runner/src/*.ts | wc -l) lines"
```

Expected: roughly 4,600 in core and 2,700 in the runner (the design's 3,609 wholesale moves plus the split modules). A runner still over ~3,500 means Task 8 left orchestration behind.

- [ ] **Step 7: Commit and open the PR**

```bash
git add packages/agent-runner-core .claude/memory/patterns.md
git commit -m "test(runner-core): enforce the SDK-free invariant; README + memory

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

The PR description must contain the **boundary review** (required by CLAUDE.md, because the eslint allowlist changed):

- *Alternate impl this could have:* `@ax/agent-aisdk-runner` — the entire reason for the split.
- *Payload field names that might leak:* none — no hook signature changed in this PR.
- *Subscriber risk:* none — no hook payloads changed.
- *Wire surface:* none — no IPC action changed.

Plus the Step 1 boot-sequence checklist from Task 8, and a note that `scaffoldSdkProjectsSymlink` lives in core despite being SDK-flavoured (Task 3, Step 1).

---

## Notes for the executor

- **If a test needs its assertions changed to pass, stop and escalate.** This PR is behaviour-preserving by construction; a changed assertion means the move altered semantics. Import-line-only edits are the sole allowed test change.
- **Do not fold Task 8 into an earlier commit.** It is the risky one and needs to be reviewable alone.
- **Do not start `@ax/agent-aisdk-runner` in this PR.** The new runner is the next plan; a half-built runner here would violate the half-wired policy.
