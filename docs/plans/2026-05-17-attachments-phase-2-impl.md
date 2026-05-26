# Attachments & Artifacts — Phase 2 Implementation Plan (Agent-Side Wiring)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the agent-facing half of the attachments subsystem. Add the `artifact_publish` tool (sandbox-executed, returns a stable `ax://artifact/<id>` URL), teach the runner to translate `attachment` content blocks into Anthropic-shape image/document/text blocks before each LLM call, and lay the supporting plumbing (sandbox tool dispatch, `workspace.read` IPC action, `git-lfs` in the agent image). The agent can now publish artifacts and "see" user-uploaded files; users still can't upload from the browser — that's Phase 3.

**Architecture:** Five layered changes, agent-side. (1) A new `@ax/tool-artifact-publish` plugin contributes a sandbox-executed tool descriptor and a path-allowlist helper, both consumed by the runner. (2) `@ax/agent-claude-sdk-runner` gains a sandbox-MCP bridge that wires `executesIn: 'sandbox'` tools through the existing in-process SDK-MCP transport (dispatching to a local executor instead of round-tripping IPC), an `artifact_publish` executor that stat/hashes the file in `/permanent` directly, and an attachment-translation pass that maps `attachment` blocks → Anthropic blocks before the SDK call. (3) `@ax/ipc-protocol` extends `AgentMessage` with an optional `contentBlocks` field and adds a new `workspace.read` IPC action. (4) `@ax/ipc-core` adds the host-side `workspace.read` handler that exposes the existing `workspace:read` service hook to runners. (5) The agent container image gains `git-lfs` so the runner can checkout LFS-tracked uploads.

**Tech Stack:** TypeScript + vitest. Filesystem ops via `node:fs/promises`, hashing via `node:crypto`, child-process spawn for `git lfs install`. SDK integration via the existing `@anthropic-ai/claude-agent-sdk` pinned version. No new npm dependencies.

**Spec:** `docs/plans/2026-05-15-attachments-and-artifacts-design.md` — specifically the "@ax/tool-artifact-publish" section, the "@ax/ipc-protocol — ContentBlock extensions" runner translation rules, the "Sandbox + host LFS client config" subsection of "Storage tier", and the "Boundary D — `artifact_publish` tool" allowlist/symlink/size rules.

**Phase 1 status:** Shipped as PR #72 with follow-ups (commits `3721e5f2`→`30f75f53`). `@ax/attachments` is loaded by the canary preset with `store-temp`/`commit`/`download` hooks live; LFS endpoints on `@ax/workspace-git-server`; `attachment_ref` + `attachment` `ContentBlock` variants in `@ax/ipc-protocol`. No callers exist yet — Phase 2 adds the agent-side caller for one direction (artifact publish); Phase 3 adds the user-side caller (browser upload).

**Half-wired window:** Phase 1 opened a window; this PR keeps it OPEN. PR body must declare:
> "Half-wired window from Phase 1 remains open. Phase 2 wires the `artifact_publish` tool (sandbox-side) and the runner's attachment-translation pass, but the chat-messages handler does not yet emit `attachment_ref` or `attachment` blocks — that's Phase 3, which closes the window."

---

## Design deviations from the spec

Three issues surfaced during planning that the design doc does not explicitly resolve. Each is decided below; reviewers should flag pushback in PR comments rather than during impl.

**D1. `artifact_publish` executes sandbox-side, not host-side.** The design doc shows `@ax/tool-artifact-publish` in the host pod. But the tool must `stat` + sha256 a file in `/permanent`, which lives in the sandbox at call time (pre-commit — the runner's turn-end `git add -A` is what commits it). Only the sandbox process can read those bytes. We mark the descriptor `executesIn: 'sandbox'` and the executor lives in the runner. The `@ax/tool-artifact-publish` package stays as a thin host-side plugin that *registers* the descriptor via `tool:register` — the catalog needs an entry so the SDK advertises the tool to the model. The executor is a separate runner-side module that *imports* the descriptor + path-allowlist helpers from the same package as library code (not via the hook bus). I2 is satisfied: nothing in this package's *plugin* code is reached by another plugin.

**D2. `AgentMessage.content` extends to a union with `contentBlocks`.** Today `AgentMessageSchema` is `{ role, content: string }`. Attachment blocks need a richer payload. We add an optional `contentBlocks?: ContentBlock[]` field; when set, `content` is the empty string. The runner prefers `contentBlocks` if non-empty. The chat-messages handler still emits the string shape in Phase 2 (Phase 3 starts emitting `contentBlocks`), so all current callers are backward-compatible.

**D3. Runner reads attachment bytes via a new `workspace.read` IPC action, not directly from `/permanent`.** The spec says bytes come from the workspace path. But the runner's `/permanent` is a clone from session start — it has no mechanism to pull commits the host made mid-session (e.g. via `attachments:commit`). Rather than invert the bundle wire direction (sandbox-to-host today), we expose the host's existing `workspace:read` service hook through a new IPC action. The runner's translation pass calls `client.call('workspace.read', { path })` for image/document attachments. Bytes ride over IPC base64-encoded; existing IPC frame limits (Phase 1 raised these for bundle wire) accommodate the 25 MiB per-file cap.

---

## File Structure

**Modify:**
- `packages/ipc-protocol/src/actions.ts` — extend `AgentMessageSchema`; add `WorkspaceReadRequest`/`Response` schemas + `workspace.read` action.
- `packages/ipc-protocol/src/__tests__/actions.test.ts` — round-trip tests for the new shapes.
- `packages/ipc-core/src/handlers/` — add `workspace-read.ts` registering the IPC handler.
- `packages/ipc-core/src/index.ts` — export and wire the new handler.
- `packages/agent-claude-sdk-runner/src/main.ts` — wire local-dispatcher, register sandbox-MCP server alongside host-MCP, install attachment-translation in `userMessages()`, add `git lfs install --local` after materialize.
- `packages/agent-claude-sdk-runner/src/host-mcp-server.ts` — no change (kept distinct from the sandbox bridge for clarity); alternative: extend in place. We add a sibling file instead.
- `packages/agent-claude-sdk-runner/src/git-workspace.ts` — `git lfs install --local` step in `materializeWorkspace`.
- `packages/agent-claude-sdk-runner/package.json` — add `@ax/tool-artifact-publish` workspace dep.
- `presets/k8s/src/index.ts` + `presets/k8s/package.json` — register `@ax/tool-artifact-publish`.
- `presets/k8s/src/__tests__/preset.test.ts` + `acceptance.test.ts` + `multi-tenant-acceptance.test.ts` — extend plugin-list expectations.
- `packages/cli/src/main.ts` + `packages/cli/package.json` — register `@ax/tool-artifact-publish` on the chat path.
- `container/agent/Dockerfile` — `apt-get install --no-install-recommends git-lfs`.

**Create:**
- `packages/tool-artifact-publish/package.json`
- `packages/tool-artifact-publish/tsconfig.json`
- `packages/tool-artifact-publish/src/index.ts`
- `packages/tool-artifact-publish/src/descriptor.ts`
- `packages/tool-artifact-publish/src/path-allowlist.ts`
- `packages/tool-artifact-publish/src/plugin.ts`
- `packages/tool-artifact-publish/src/__tests__/descriptor.test.ts`
- `packages/tool-artifact-publish/src/__tests__/path-allowlist.test.ts`
- `packages/tool-artifact-publish/src/__tests__/plugin.test.ts`
- `packages/agent-claude-sdk-runner/src/sandbox-mcp-server.ts` — sibling of host-mcp-server; wires sandbox-executed tools through SDK MCP, dispatching via local-dispatcher.
- `packages/agent-claude-sdk-runner/src/artifact-publish-executor.ts` — the local executor that runs the artifact_publish work in-process.
- `packages/agent-claude-sdk-runner/src/attachment-translation.ts` — pure translation function (`attachment` block → Anthropic shape).
- `packages/agent-claude-sdk-runner/src/__tests__/sandbox-mcp-server.test.ts`
- `packages/agent-claude-sdk-runner/src/__tests__/artifact-publish-executor.test.ts`
- `packages/agent-claude-sdk-runner/src/__tests__/attachment-translation.test.ts`

**Do not touch:**
- `packages/channel-web/**` — that's Phase 3.
- `packages/attachments/**` — Phase 1 ships the host-side store + ACL; no Phase 2 changes needed.
- `packages/workspace-git-server/**` — LFS endpoints already shipped in Phase 1.

---

## Task 1: Add `git-lfs` binary to the agent runtime image

The runner clones a workspace at session start. If the workspace baseline has LFS-tracked files (e.g. uploads from prior sessions), checkout needs `git-lfs` smudge support or the tracked paths land as text pointer files. We pin the binary the same tag-only way `git` is pinned today, deferring strict version pinning to the CI image-build pipeline (consistent with the existing TODO in the Dockerfile).

**Files:**
- Modify: `container/agent/Dockerfile`

- [ ] **Step 1: Edit the apt-get install block**

Open `container/agent/Dockerfile`. Find the line that installs `ca-certificates tini git` (around line 102 per the current file — search for `apt-get install -y --no-install-recommends ca-certificates tini git` if line numbers shift). Add `git-lfs` to the package list and update the explanatory comment that follows:

```dockerfile
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini git git-lfs \
 && rm -rf /var/lib/apt/lists/*
# `git` is needed by the host pod's @ax/ipc-core workspace.materialize
# handler (it runs `git bundle` to seed the runner's /permanent dir at
# session start) AND by runner pods themselves (they spawn `git` to
# bundle turn-end diffs).
#
# `git-lfs` is needed by runner pods to checkout LFS-tracked files
# (user-uploaded attachments under `.ax/uploads/**`, agent artifacts
# matching the LFS .gitattributes) so they materialize as their real
# bytes rather than as LFS pointer text. The runner runs
# `git lfs install --local` in /permanent after clone (see
# packages/agent-claude-sdk-runner/src/git-workspace.ts).
```

(The exact pre-existing comment varies; the rule is: add the `git-lfs` line of justification, keep the rest of the comment intact.)

- [ ] **Step 2: Rebuild the image locally to verify**

Run from repo root:

```bash
docker build -f container/agent/Dockerfile -t ax-next/agent:phase2-verify .
```

Then check the binary is on `PATH` inside the image:

```bash
docker run --rm --entrypoint /bin/sh ax-next/agent:phase2-verify -c "git lfs version"
```

Expected: a `git-lfs/<version>` line. If `command not found`, re-check the apt-get line.

- [ ] **Step 3: Commit**

```bash
git add container/agent/Dockerfile
git commit -m "feat(agent-image): install git-lfs for LFS-tracked attachments"
```

---

## Task 2: `git lfs install --local` after workspace materialize

After cloning `/permanent` from the host bundle, the runner needs to enable LFS smudge filters locally so subsequent `git checkout`s (e.g. on a `resume` rehydration) pull binary bytes from the LFS server endpoints Phase 1 added. We do this once at session start inside the clone — never touching the user's HOME, never running `git lfs install --system`.

**Files:**
- Modify: `packages/agent-claude-sdk-runner/src/git-workspace.ts`
- Modify: `packages/agent-claude-sdk-runner/src/__tests__/git-workspace.test.ts`

- [ ] **Step 1: Write the failing test**

Open `packages/agent-claude-sdk-runner/src/__tests__/git-workspace.test.ts`. Find the existing `describe('materializeWorkspace', ...)` block. Add a new test at the end of it:

```ts
it('runs `git lfs install --local` after clone so LFS smudge is enabled', async () => {
  // Build a minimal baseline bundle in a temp source repo so the clone
  // step succeeds — same fixture pattern used by sibling tests.
  const src = await mkdtempIn(testTmp);
  await runGitInTest(src, ['init', '-b', 'main']);
  await runGitInTest(src, ['commit', '--allow-empty', '-m', 'init']);
  const bundlePath = path.join(testTmp, 'b.bundle');
  await runGitInTest(src, ['bundle', 'create', bundlePath, 'main']);
  const bundleBase64 = (await fs.readFile(bundlePath)).toString('base64');

  const target = await mkdtempIn(testTmp);
  await fs.rm(target, { recursive: true, force: true });

  await materializeWorkspace({ root: target, bundleBase64 });

  // The hook entry is what `git lfs install --local` writes — its
  // presence in .git/hooks/post-checkout (or .git/config under
  // `[filter "lfs"]`) is the durable signal. We check the filter block
  // because hook paths vary by git-lfs version.
  const cfg = await fs.readFile(path.join(target, '.git', 'config'), 'utf8');
  expect(cfg).toContain('[filter "lfs"]');
  expect(cfg).toMatch(/clean = git-lfs clean/);
  expect(cfg).toMatch(/smudge = git-lfs smudge/);
});
```

If `mkdtempIn` and `runGitInTest` are not already test helpers in this file, copy them from any sibling test that uses them (e.g. `git-workspace.test.ts` likely has its own variant already; otherwise define inline).

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test --filter @ax/agent-claude-sdk-runner -- git-workspace
```

Expected: FAIL — no `[filter "lfs"]` section yet because we never installed.

- [ ] **Step 3: Add the install step to `materializeWorkspace`**

In `packages/agent-claude-sdk-runner/src/git-workspace.ts`, find the section in `materializeWorkspace` that runs `git update-ref refs/heads/baseline HEAD` (after the clone, before the `rev-parse`). Add immediately AFTER the `update-ref` step:

```ts
// Phase 2 (attachments): enable git-lfs smudge filters in this clone so
// LFS-tracked files (uploads under .ax/uploads/**, artifacts matching
// .gitattributes) check out as real bytes. --local writes only into
// THIS repo's .git/config, never HOME/system. Idempotent; safe to re-run.
await expectOk(
  await runGit(['-C', root, 'lfs', 'install', '--local']),
  'git lfs install --local',
);
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm test --filter @ax/agent-claude-sdk-runner -- git-workspace
```

Expected: PASS. If git-lfs is not on the test machine's PATH, the test will fail with `git: 'lfs' is not a git command` — install via `brew install git-lfs` (macOS) or `apt-get install git-lfs` (Linux). Document the prereq in the test-file header if it's not already there.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-claude-sdk-runner/src/git-workspace.ts \
        packages/agent-claude-sdk-runner/src/__tests__/git-workspace.test.ts
git commit -m "feat(runner): git lfs install --local after materialize (Phase 2)"
```

---

## Task 3: Scaffold `@ax/tool-artifact-publish` package

Following the same shape used by `@ax/attachments` (Phase 1): tsconfig + package.json + skeleton `src/index.ts`, tests directory ready for vitest.

**Files:**
- Create: `packages/tool-artifact-publish/package.json`
- Create: `packages/tool-artifact-publish/tsconfig.json`
- Create: `packages/tool-artifact-publish/src/index.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@ax/tool-artifact-publish",
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
    "@ax/ipc-protocol": "workspace:*"
  },
  "devDependencies": {
    "typescript": "catalog:",
    "vitest": "catalog:"
  }
}
```

If the existing workspace catalog uses different keys (e.g. `^5.4`), copy the form from `packages/attachments/package.json`. Do not pin versions outside the catalog — that's the repo convention.

- [ ] **Step 2: Create `tsconfig.json`**

Copy verbatim from `packages/attachments/tsconfig.json`, then add references to `@ax/core` and `@ax/ipc-protocol`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "composite": true
  },
  "include": ["src/**/*.ts"],
  "references": [
    { "path": "../core" },
    { "path": "../ipc-protocol" }
  ]
}
```

- [ ] **Step 3: Create `src/index.ts` (stub)**

```ts
// Public surface — exports filled in by subsequent tasks.
export {} from './descriptor.js';
```

Initially empty re-exports will fail to typecheck; we'll fix on the first real export. Use a literal empty export for now:

```ts
export {};
```

- [ ] **Step 4: Add the package to the root tsconfig project references**

Open `tsconfig.json` (repo root). Find the `references` array. Add:

```json
{ "path": "./packages/tool-artifact-publish" }
```

Insert alphabetically among siblings.

- [ ] **Step 5: Install + verify build**

```bash
pnpm install
pnpm build --filter @ax/tool-artifact-publish
```

Expected: PASS (empty package builds clean).

- [ ] **Step 6: Commit**

```bash
git add packages/tool-artifact-publish tsconfig.json pnpm-lock.yaml
git commit -m "feat(tool-artifact-publish): scaffold package"
```

---

## Task 4: Define the tool descriptor and path-allowlist helper

The descriptor is the contract advertised to the model via `tool:list`. The allowlist helper is pure-function path validation that both the host plugin (for documentation in `description`) and the runner-side executor (for actual enforcement) reuse.

**Files:**
- Create: `packages/tool-artifact-publish/src/descriptor.ts`
- Create: `packages/tool-artifact-publish/src/path-allowlist.ts`
- Create: `packages/tool-artifact-publish/src/__tests__/descriptor.test.ts`
- Create: `packages/tool-artifact-publish/src/__tests__/path-allowlist.test.ts`
- Modify: `packages/tool-artifact-publish/src/index.ts`

- [ ] **Step 1: Write failing tests for `path-allowlist`**

`packages/tool-artifact-publish/src/__tests__/path-allowlist.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { checkPublishablePath, MAX_ARTIFACT_BYTES } from '../path-allowlist.js';

describe('checkPublishablePath', () => {
  it('accepts paths under /permanent/workspace/', () => {
    expect(checkPublishablePath('/permanent/workspace/reports/Q4.pdf')).toEqual({
      ok: true,
      relativePath: 'workspace/reports/Q4.pdf',
    });
  });

  it('accepts paths under /permanent/.ax/artifacts/', () => {
    expect(checkPublishablePath('/permanent/.ax/artifacts/img.png')).toEqual({
      ok: true,
      relativePath: '.ax/artifacts/img.png',
    });
  });

  it('rejects paths outside the allowlist', () => {
    const result = checkPublishablePath('/permanent/.ax/sessions/sess1.jsonl');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/not-publishable/);
    }
  });

  it('rejects relative paths (no /permanent/ prefix)', () => {
    const result = checkPublishablePath('workspace/reports/Q4.pdf');
    expect(result.ok).toBe(false);
  });

  it('rejects paths with traversal segments', () => {
    expect(checkPublishablePath('/permanent/workspace/../../etc/passwd').ok).toBe(false);
    expect(checkPublishablePath('/permanent/workspace/foo/../bar').ok).toBe(false);
  });

  it('rejects absolute paths outside /permanent/', () => {
    expect(checkPublishablePath('/etc/passwd').ok).toBe(false);
    expect(checkPublishablePath('/permanent').ok).toBe(false);  // bare prefix, no file
  });

  it('exposes the size cap', () => {
    expect(MAX_ARTIFACT_BYTES).toBe(100 * 1024 * 1024);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test --filter @ax/tool-artifact-publish -- path-allowlist
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `path-allowlist.ts`**

```ts
/**
 * Phase 2 — `artifact_publish` tool path-allowlist (design Boundary D).
 *
 * Pure-function path validation. No filesystem access. Reused by both
 * the host plugin's descriptor (for the model-facing `description`) and
 * the runner-side executor (for actual enforcement).
 *
 * Allowed prefixes:
 *  - /permanent/workspace/<sub>        — user project content
 *  - /permanent/.ax/artifacts/<sub>    — explicit artifact namespace
 *
 * Returns a `relativePath` (workspace-relative) on success so the
 * caller stores a path that matches what `workspace:read` expects and
 * what the path-scope ACL in `attachments:download` compares against.
 */

export const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024; // 100 MiB

const PERMANENT_PREFIX = '/permanent/';
const ALLOWED_RELATIVE_PREFIXES = ['workspace/', '.ax/artifacts/'];

export type PathCheckResult =
  | { ok: true; relativePath: string }
  | { ok: false; reason: string };

export function checkPublishablePath(absPath: string): PathCheckResult {
  if (typeof absPath !== 'string' || absPath.length === 0) {
    return { ok: false, reason: 'artifact-path-not-publishable: empty path' };
  }
  if (!absPath.startsWith(PERMANENT_PREFIX)) {
    return {
      ok: false,
      reason: `artifact-path-not-publishable: path must start with ${PERMANENT_PREFIX}`,
    };
  }
  const relative = absPath.slice(PERMANENT_PREFIX.length);
  if (relative.length === 0) {
    return { ok: false, reason: 'artifact-path-not-publishable: no file component' };
  }
  // Traversal defence — reject any '..' segment outright. Done on the
  // relative path so we catch both /permanent/workspace/../etc and
  // /permanent/workspace/foo/../bar variants.
  for (const seg of relative.split('/')) {
    if (seg === '..') {
      return { ok: false, reason: 'artifact-path-not-publishable: path contains ..' };
    }
  }
  const prefix = ALLOWED_RELATIVE_PREFIXES.find((p) => relative.startsWith(p));
  if (prefix === undefined) {
    return {
      ok: false,
      reason: `artifact-path-not-publishable: path must be under one of ${ALLOWED_RELATIVE_PREFIXES.map((p) => PERMANENT_PREFIX + p).join(', ')}`,
    };
  }
  // Must have at least one char after the prefix (no bare prefix paths).
  if (relative.length === prefix.length) {
    return { ok: false, reason: 'artifact-path-not-publishable: no file component after prefix' };
  }
  return { ok: true, relativePath: relative };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test --filter @ax/tool-artifact-publish -- path-allowlist
```

Expected: PASS.

- [ ] **Step 5: Write failing tests for `descriptor`**

`packages/tool-artifact-publish/src/__tests__/descriptor.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ARTIFACT_PUBLISH_DESCRIPTOR, ARTIFACT_PUBLISH_TOOL_NAME } from '../descriptor.js';

describe('artifact_publish descriptor', () => {
  it('declares the tool name', () => {
    expect(ARTIFACT_PUBLISH_TOOL_NAME).toBe('artifact_publish');
    expect(ARTIFACT_PUBLISH_DESCRIPTOR.name).toBe('artifact_publish');
  });

  it('executes in the sandbox (D1)', () => {
    expect(ARTIFACT_PUBLISH_DESCRIPTOR.executesIn).toBe('sandbox');
  });

  it('declares a JSON-schema for path + optional displayName', () => {
    const schema = ARTIFACT_PUBLISH_DESCRIPTOR.inputSchema as Record<string, unknown>;
    expect(schema.type).toBe('object');
    const props = (schema.properties as Record<string, unknown>) ?? {};
    expect((props.path as Record<string, unknown>).type).toBe('string');
    expect((props.displayName as Record<string, unknown>).type).toBe('string');
    expect(schema.required).toEqual(['path']);
  });

  it('description mentions the allowlist', () => {
    expect(ARTIFACT_PUBLISH_DESCRIPTOR.description).toMatch(/workspace/);
    expect(ARTIFACT_PUBLISH_DESCRIPTOR.description).toMatch(/artifacts/);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

```bash
pnpm test --filter @ax/tool-artifact-publish -- descriptor
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 7: Implement `descriptor.ts`**

```ts
import type { ToolDescriptor } from '@ax/core';

export const ARTIFACT_PUBLISH_TOOL_NAME = 'artifact_publish' as const;

/**
 * Phase 2 (`artifact_publish`). The model invokes this tool with a path
 * under /permanent/workspace/** or /permanent/.ax/artifacts/**; the
 * runner-side executor stats + hashes the file and returns the
 * artifactId/downloadUrl/path/displayName/mediaType/sizeBytes/sha256
 * shape the design doc specifies.
 *
 * Sandbox-executed (D1): the executor runs inside the runner pod
 * because only it has filesystem access to /permanent at call time.
 * The host-side plugin in this package only registers the descriptor
 * so the catalog advertises it to the model.
 */
export const ARTIFACT_PUBLISH_DESCRIPTOR: ToolDescriptor = {
  name: ARTIFACT_PUBLISH_TOOL_NAME,
  description: [
    'Publish a workspace file as a downloadable artifact for the user.',
    'Returns a stable ax://artifact/<id> URL that you can embed in your',
    'response text or markdown links.',
    '',
    'Allowed paths (others rejected):',
    '  - /permanent/workspace/**     (user project content)',
    '  - /permanent/.ax/artifacts/** (explicit artifact namespace)',
    '',
    'The tool does NOT commit the file — the workspace commit at turn',
    'end captures it. Symlinks and files larger than 100 MiB are rejected.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path under /permanent/ to publish.',
      },
      displayName: {
        type: 'string',
        description: 'Optional user-friendly name. Defaults to basename(path).',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  executesIn: 'sandbox',
};
```

- [ ] **Step 8: Run test to verify it passes**

```bash
pnpm test --filter @ax/tool-artifact-publish -- descriptor
```

Expected: PASS.

- [ ] **Step 9: Update `index.ts` to re-export**

```ts
export {
  ARTIFACT_PUBLISH_DESCRIPTOR,
  ARTIFACT_PUBLISH_TOOL_NAME,
} from './descriptor.js';
export {
  checkPublishablePath,
  MAX_ARTIFACT_BYTES,
  type PathCheckResult,
} from './path-allowlist.js';
```

- [ ] **Step 10: Build to verify type exports**

```bash
pnpm build --filter @ax/tool-artifact-publish
```

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add packages/tool-artifact-publish
git commit -m "feat(tool-artifact-publish): descriptor + path-allowlist helper"
```

---

## Task 5: Plugin factory — register the descriptor via `tool:register`

The plugin's only job is to add the descriptor to the global tool catalog at init time. It does NOT register a `tool:execute:artifact_publish` handler — that's sandbox-side, not host-side (D1).

**Files:**
- Create: `packages/tool-artifact-publish/src/plugin.ts`
- Create: `packages/tool-artifact-publish/src/__tests__/plugin.test.ts`
- Modify: `packages/tool-artifact-publish/src/index.ts`

- [ ] **Step 1: Write the failing test**

`packages/tool-artifact-publish/src/__tests__/plugin.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import {
  makeAgentContext,
  type AgentContext,
  type HookBus,
  type ToolDescriptor,
} from '@ax/core';
import { createToolArtifactPublishPlugin } from '../plugin.js';
import { ARTIFACT_PUBLISH_TOOL_NAME } from '../descriptor.js';

function fakeBus(): {
  bus: HookBus;
  calls: Array<{ hook: string; payload: unknown }>;
} {
  const calls: Array<{ hook: string; payload: unknown }> = [];
  const bus = {
    call: vi.fn(async (hook: string, _ctx: AgentContext, payload: unknown) => {
      calls.push({ hook, payload });
      return { ok: true };
    }),
    registerService: vi.fn(),
    subscribe: vi.fn(),
    fire: vi.fn(),
  } as unknown as HookBus;
  return { bus, calls };
}

describe('createToolArtifactPublishPlugin', () => {
  it('declares manifest with tool:register in calls', () => {
    const plugin = createToolArtifactPublishPlugin();
    expect(plugin.manifest.name).toBe('@ax/tool-artifact-publish');
    expect(plugin.manifest.calls).toContain('tool:register');
    expect(plugin.manifest.registers ?? []).not.toContain(
      `tool:execute:${ARTIFACT_PUBLISH_TOOL_NAME}`,
    );
  });

  it('registers the descriptor on init', async () => {
    const plugin = createToolArtifactPublishPlugin();
    const { bus, calls } = fakeBus();
    await plugin.init({ bus, config: {} as never });
    const registerCall = calls.find((c) => c.hook === 'tool:register');
    expect(registerCall).toBeDefined();
    const desc = registerCall!.payload as ToolDescriptor;
    expect(desc.name).toBe(ARTIFACT_PUBLISH_TOOL_NAME);
    expect(desc.executesIn).toBe('sandbox');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test --filter @ax/tool-artifact-publish -- plugin
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `plugin.ts`**

```ts
import {
  makeAgentContext,
  type AgentContext,
  type Plugin,
  type ToolDescriptor,
} from '@ax/core';
import { ARTIFACT_PUBLISH_DESCRIPTOR } from './descriptor.js';

const PLUGIN_NAME = '@ax/tool-artifact-publish';

/**
 * Phase 2 — host-side plugin that adds the `artifact_publish` descriptor
 * to the tool catalog. The executor that runs the tool's actual work
 * lives sandbox-side in `@ax/agent-claude-sdk-runner` (D1): only the
 * sandbox process has filesystem access to /permanent at call time.
 *
 * This plugin therefore does NOT register `tool:execute:artifact_publish`.
 * Tool dispatch for sandbox-executed tools happens inside the runner
 * through its local-dispatcher; no IPC round-trip.
 */
export function createToolArtifactPublishPlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [],
      calls: ['tool:register'],
      subscribes: [],
    },
    async init({ bus }) {
      // tool:register doesn't read ctx fields (pure registry write), but
      // bus.call still needs an AgentContext envelope. Synthesize a
      // minimal one — same pattern as test-host-tool.ts.
      const ctx: AgentContext = makeAgentContext({
        sessionId: 'init',
        agentId: PLUGIN_NAME,
        userId: 'init',
      });
      await bus.call<ToolDescriptor, { ok: true }>(
        'tool:register',
        ctx,
        ARTIFACT_PUBLISH_DESCRIPTOR,
      );
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test --filter @ax/tool-artifact-publish -- plugin
```

Expected: PASS.

- [ ] **Step 5: Re-export from `index.ts`**

```ts
export {
  ARTIFACT_PUBLISH_DESCRIPTOR,
  ARTIFACT_PUBLISH_TOOL_NAME,
} from './descriptor.js';
export {
  checkPublishablePath,
  MAX_ARTIFACT_BYTES,
  type PathCheckResult,
} from './path-allowlist.js';
export { createToolArtifactPublishPlugin } from './plugin.js';
```

- [ ] **Step 6: Build + full package test**

```bash
pnpm build --filter @ax/tool-artifact-publish
pnpm test --filter @ax/tool-artifact-publish
```

Expected: PASS, all three test files green.

- [ ] **Step 7: Commit**

```bash
git add packages/tool-artifact-publish
git commit -m "feat(tool-artifact-publish): plugin factory registers descriptor"
```

---

## Task 6: Sandbox-MCP bridge — dispatch sandbox tools through SDK MCP

`@ax/agent-claude-sdk-runner` currently has `host-mcp-server.ts` which exposes `executesIn: 'host'` tools to the SDK via in-process MCP. The handler does an IPC round-trip (`tool.execute-host`) back to the host plugin. For sandbox-executed tools, the handler must dispatch in-process via the runner's existing `local-dispatcher` (`createLocalDispatcher` in `local-dispatcher.ts` — written but not yet wired into `main.ts`). This task adds the sibling bridge `sandbox-mcp-server.ts` and the executor-registration plumbing.

**Files:**
- Create: `packages/agent-claude-sdk-runner/src/sandbox-mcp-server.ts`
- Create: `packages/agent-claude-sdk-runner/src/__tests__/sandbox-mcp-server.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/agent-claude-sdk-runner/src/__tests__/sandbox-mcp-server.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { ToolDescriptor } from '@ax/core';
import { createLocalDispatcher } from '../local-dispatcher.js';
import { buildSandboxToolEntries } from '../sandbox-mcp-server.js';

const sampleSandboxDescriptor: ToolDescriptor = {
  name: 'echo_local',
  description: 'echo (sandbox-executed)',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  executesIn: 'sandbox',
};

const sampleHostDescriptor: ToolDescriptor = {
  ...sampleSandboxDescriptor,
  name: 'echo_host',
  executesIn: 'host',
};

describe('buildSandboxToolEntries', () => {
  it('filters to executesIn=sandbox tools only', () => {
    const dispatcher = createLocalDispatcher();
    dispatcher.register('echo_local', async (call) => ({ echoed: call.input }));
    const entries = buildSandboxToolEntries(dispatcher, [
      sampleSandboxDescriptor,
      sampleHostDescriptor,
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('echo_local');
  });

  it('dispatches to local-dispatcher in-process (no IPC)', async () => {
    const dispatcher = createLocalDispatcher();
    let dispatched = 0;
    dispatcher.register('echo_local', async (call) => {
      dispatched += 1;
      return { input: call.input, name: call.name };
    });
    const [entry] = buildSandboxToolEntries(dispatcher, [sampleSandboxDescriptor]);

    // The SDK calls `entry.handler(args)` with the model's parsed input.
    const out = await entry.handler({ text: 'hi' }, { signal: undefined } as never);
    expect(dispatched).toBe(1);
    // SDK MCP wraps outputs as { content: [{ type: 'text', text }] }
    expect(out.content[0].type).toBe('text');
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.input).toEqual({ text: 'hi' });
    expect(parsed.name).toBe('echo_local');
    expect(out.isError ?? false).toBe(false);
  });

  it('returns isError on executor failure with the message', async () => {
    const dispatcher = createLocalDispatcher();
    dispatcher.register('echo_local', async () => {
      throw new Error('artifact-path-not-publishable: bad prefix');
    });
    const [entry] = buildSandboxToolEntries(dispatcher, [sampleSandboxDescriptor]);
    const out = await entry.handler({ text: 'x' }, { signal: undefined } as never);
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain('artifact-path-not-publishable');
  });

  it('errors on a sandbox descriptor with no registered executor', async () => {
    const dispatcher = createLocalDispatcher();
    // Note: no dispatcher.register for echo_local.
    const [entry] = buildSandboxToolEntries(dispatcher, [sampleSandboxDescriptor]);
    const out = await entry.handler({ text: 'x' }, { signal: undefined } as never);
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/echo_local/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test --filter @ax/agent-claude-sdk-runner -- sandbox-mcp-server
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `sandbox-mcp-server.ts`**

```ts
// ---------------------------------------------------------------------------
// Sandbox-MCP bridge: exposes `executesIn: 'sandbox'` tools to
// claude-agent-sdk via the same in-process SDK-MCP transport that
// host-mcp-server.ts uses for host tools. The difference is the handler
// dispatches through the runner's local-dispatcher (an in-process map of
// tool-name → executor) instead of doing a `tool.execute-host` IPC.
//
// Why a separate file from host-mcp-server.ts: the dispatch path is
// fundamentally different — IPC vs. in-process. Keeping them separate
// makes the "where does this tool actually run" question one grep away.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';
import type { ToolDescriptor } from '@ax/core';
import { z } from 'zod';
import type { LocalDispatcher } from './local-dispatcher.js';
import { MCP_SANDBOX_SERVER_NAME } from './tool-names.js';

function shapeFromInputSchema(
  inputSchema: Record<string, unknown>,
): Record<string, z.ZodTypeAny> {
  const rawProps = (inputSchema as { properties?: unknown }).properties;
  if (
    rawProps === null ||
    typeof rawProps !== 'object' ||
    Array.isArray(rawProps)
  ) {
    return {};
  }
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const key of Object.keys(rawProps as Record<string, unknown>)) {
    shape[key] = z.unknown();
  }
  return shape;
}

function renderOutput(output: unknown): {
  content: Array<{ type: 'text'; text: string }>;
} {
  const text = typeof output === 'string' ? output : JSON.stringify(output);
  return { content: [{ type: 'text', text }] };
}

export function buildSandboxToolEntries(
  dispatcher: LocalDispatcher,
  tools: ToolDescriptor[],
  idGen: () => string = () => randomUUID(),
): Array<SdkMcpToolDefinition> {
  const sandboxTools = tools.filter((t) => t.executesIn === 'sandbox');
  return sandboxTools.map((t) =>
    tool(
      t.name,
      t.description ?? '',
      shapeFromInputSchema(t.inputSchema),
      async (args) => {
        try {
          const out = await dispatcher.execute({
            id: idGen(),
            name: t.name,
            input: args,
          });
          return renderOutput(out);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: 'text', text: message }],
            isError: true,
          };
        }
      },
    ),
  );
}

export interface CreateSandboxMcpServerOptions {
  dispatcher: LocalDispatcher;
  tools: ToolDescriptor[];
  idGen?: () => string;
}

export function createSandboxMcpServer(
  opts: CreateSandboxMcpServerOptions,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: MCP_SANDBOX_SERVER_NAME,
    version: '0.0.0',
    tools: buildSandboxToolEntries(opts.dispatcher, opts.tools, opts.idGen),
  });
}
```

- [ ] **Step 4: Add `MCP_SANDBOX_SERVER_NAME` to `tool-names.ts`**

In `packages/agent-claude-sdk-runner/src/tool-names.ts`, near `MCP_HOST_SERVER_NAME`, add:

```ts
export const MCP_SANDBOX_SERVER_NAME = 'ax_sandbox';
```

Update any export barrel if needed (re-check `index.ts` of the runner if it re-exports tool-names symbols).

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm test --filter @ax/agent-claude-sdk-runner -- sandbox-mcp-server
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-claude-sdk-runner/src/sandbox-mcp-server.ts \
        packages/agent-claude-sdk-runner/src/tool-names.ts \
        packages/agent-claude-sdk-runner/src/__tests__/sandbox-mcp-server.test.ts
git commit -m "feat(runner): sandbox-MCP bridge dispatches via local-dispatcher"
```

---

## Task 7: `artifact_publish` executor — stat, hash, build result

The executor is a single async function that runs inside the runner. It validates the path against the allowlist, lstats the target (catches symlinks early), reads + sha256s the bytes, sniffs the media type from the extension, and returns the JSON shape the design specifies. It is invoked by the sandbox-MCP bridge when the model calls `artifact_publish`.

**Files:**
- Create: `packages/agent-claude-sdk-runner/src/artifact-publish-executor.ts`
- Create: `packages/agent-claude-sdk-runner/src/__tests__/artifact-publish-executor.test.ts`

- [ ] **Step 1: Write failing tests**

`packages/agent-claude-sdk-runner/src/__tests__/artifact-publish-executor.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createArtifactPublishExecutor } from '../artifact-publish-executor.js';

let permanent: string;

beforeEach(async () => {
  permanent = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-artifact-'));
});

async function writeFile(rel: string, bytes: Buffer | string): Promise<string> {
  const abs = path.join(permanent, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, bytes);
  return abs;
}

function executor() {
  // The executor takes the workspace root as a constructor arg so it
  // can rewrite the model's '/permanent/...' input to the actual root.
  return createArtifactPublishExecutor({ workspaceRoot: permanent });
}

describe('artifact_publish executor', () => {
  it('publishes a file under workspace/, returning the design shape', async () => {
    await writeFile('workspace/reports/Q4.pdf', Buffer.from('hello pdf'));
    const out = await executor()({
      id: 'toolu_1',
      name: 'artifact_publish',
      input: { path: '/permanent/workspace/reports/Q4.pdf' },
    });
    const parsed = typeof out === 'string' ? JSON.parse(out) : out;
    expect(parsed.path).toBe('workspace/reports/Q4.pdf');
    expect(parsed.displayName).toBe('Q4.pdf');
    expect(parsed.mediaType).toBe('application/pdf');
    expect(parsed.sizeBytes).toBe(9);
    expect(parsed.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.artifactId).toBe(parsed.sha256.slice(0, 16));
    expect(parsed.downloadUrl).toBe(`ax://artifact/${parsed.artifactId}`);
  });

  it('honours displayName when provided', async () => {
    await writeFile('workspace/data.bin', Buffer.from('x'));
    const out = await executor()({
      id: 'toolu_2',
      name: 'artifact_publish',
      input: { path: '/permanent/workspace/data.bin', displayName: 'Friendly Name.bin' },
    });
    const parsed = typeof out === 'string' ? JSON.parse(out) : out;
    expect(parsed.displayName).toBe('Friendly Name.bin');
  });

  it('falls back to application/octet-stream for unknown extensions', async () => {
    await writeFile('workspace/blob.xyzzy', Buffer.from('x'));
    const out = await executor()({
      id: 'toolu_3',
      name: 'artifact_publish',
      input: { path: '/permanent/workspace/blob.xyzzy' },
    });
    const parsed = typeof out === 'string' ? JSON.parse(out) : out;
    expect(parsed.mediaType).toBe('application/octet-stream');
  });

  it('rejects paths outside the allowlist with a tool_result is_error message', async () => {
    await writeFile('.ax/sessions/sess1.jsonl', 'x');
    await expect(
      executor()({
        id: 'toolu_4',
        name: 'artifact_publish',
        input: { path: '/permanent/.ax/sessions/sess1.jsonl' },
      }),
    ).rejects.toThrow(/artifact-path-not-publishable/);
  });

  it('rejects symlinks', async () => {
    const real = await writeFile('workspace/real.txt', 'r');
    const linkAbs = path.join(permanent, 'workspace/link.txt');
    await fs.symlink(real, linkAbs);
    await expect(
      executor()({
        id: 'toolu_5',
        name: 'artifact_publish',
        input: { path: '/permanent/workspace/link.txt' },
      }),
    ).rejects.toThrow(/symlink/i);
  });

  it('rejects directories', async () => {
    await fs.mkdir(path.join(permanent, 'workspace/dir'), { recursive: true });
    await expect(
      executor()({
        id: 'toolu_6',
        name: 'artifact_publish',
        input: { path: '/permanent/workspace/dir' },
      }),
    ).rejects.toThrow(/not a regular file/i);
  });

  it('rejects files larger than 100 MiB', async () => {
    const big = Buffer.alloc(100 * 1024 * 1024 + 1, 0);
    await writeFile('workspace/big.bin', big);
    await expect(
      executor()({
        id: 'toolu_7',
        name: 'artifact_publish',
        input: { path: '/permanent/workspace/big.bin' },
      }),
    ).rejects.toThrow(/100 MiB|too large/i);
  });

  it('rejects missing files', async () => {
    await expect(
      executor()({
        id: 'toolu_8',
        name: 'artifact_publish',
        input: { path: '/permanent/workspace/nope.txt' },
      }),
    ).rejects.toThrow(/not found|ENOENT/i);
  });

  it('rejects non-object / missing path input', async () => {
    await expect(
      executor()({ id: 'toolu_9', name: 'artifact_publish', input: {} }),
    ).rejects.toThrow(/path/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test --filter @ax/agent-claude-sdk-runner -- artifact-publish-executor
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `artifact-publish-executor.ts`**

```ts
// ---------------------------------------------------------------------------
// Sandbox-side executor for the `artifact_publish` tool. The model calls
// the tool through the SDK MCP transport; the sandbox-MCP bridge
// (sandbox-mcp-server.ts) dispatches to this function via the runner's
// local-dispatcher.
//
// Reads /permanent/<...> directly (no IPC). The path the model supplies
// is the sandbox-absolute path (e.g. /permanent/workspace/report.pdf);
// we rewrite it onto the real workspace root configured at runner startup.
//
// Validation order matches the design doc:
//   1. Allowlist (pure-path).
//   2. lstat → catches symlinks before any byte read.
//   3. Size cap.
//   4. read + sha256.
//   5. mediaType sniff (extension only — no content sniffing v1).
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ToolCall } from '@ax/ipc-protocol';
import {
  checkPublishablePath,
  MAX_ARTIFACT_BYTES,
} from '@ax/tool-artifact-publish';

const SANDBOX_PERMANENT_PREFIX = '/permanent/';

const EXTENSION_TO_MEDIA_TYPE: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
};

function mediaTypeFromExtension(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return EXTENSION_TO_MEDIA_TYPE[ext] ?? 'application/octet-stream';
}

export interface CreateArtifactPublishExecutorOptions {
  /** Absolute filesystem path the model's `/permanent/...` maps onto. */
  workspaceRoot: string;
}

export interface ArtifactPublishOutput {
  artifactId: string;
  downloadUrl: string;
  path: string;
  displayName: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
}

export function createArtifactPublishExecutor(
  opts: CreateArtifactPublishExecutorOptions,
) {
  return async function execute(
    call: ToolCall,
  ): Promise<ArtifactPublishOutput> {
    const input = call.input as { path?: unknown; displayName?: unknown };
    if (typeof input?.path !== 'string' || input.path.length === 0) {
      throw new Error('artifact_publish: input.path is required (string)');
    }
    if (
      input.displayName !== undefined &&
      typeof input.displayName !== 'string'
    ) {
      throw new Error('artifact_publish: input.displayName must be a string when provided');
    }

    const check = checkPublishablePath(input.path);
    if (!check.ok) {
      throw new Error(check.reason);
    }
    const relativePath = check.relativePath;

    // Map /permanent/<rel> onto <workspaceRoot>/<rel>. The model never
    // supplies a path that doesn't start with /permanent/ (caught by
    // checkPublishablePath), so this slice is safe.
    const absInWorkspace = path.join(
      opts.workspaceRoot,
      input.path.slice(SANDBOX_PERMANENT_PREFIX.length),
    );

    // lstat — NOT stat — so symlinks register as symlinks instead of
    // their resolved target. We reject symlinks defensively.
    const lst = await fs.lstat(absInWorkspace);
    if (lst.isSymbolicLink()) {
      throw new Error('artifact_publish: refusing to publish a symlink');
    }
    if (!lst.isFile()) {
      throw new Error('artifact_publish: target is not a regular file');
    }
    if (lst.size > MAX_ARTIFACT_BYTES) {
      throw new Error(
        `artifact_publish: file too large (${lst.size} bytes, max ${MAX_ARTIFACT_BYTES} = 100 MiB)`,
      );
    }

    const bytes = await fs.readFile(absInWorkspace);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const artifactId = sha256.slice(0, 16);

    const filename = path.basename(absInWorkspace);
    const displayName = input.displayName ?? filename;

    return {
      artifactId,
      downloadUrl: `ax://artifact/${artifactId}`,
      path: relativePath,
      displayName,
      mediaType: mediaTypeFromExtension(filename),
      sizeBytes: lst.size,
      sha256,
    };
  };
}
```

- [ ] **Step 4: Add `@ax/tool-artifact-publish` as a dep of the runner**

`packages/agent-claude-sdk-runner/package.json` — add to `dependencies`:

```json
"@ax/tool-artifact-publish": "workspace:*"
```

Then re-link:

```bash
pnpm install
```

Add the project reference to `packages/agent-claude-sdk-runner/tsconfig.json`:

```json
{ "path": "../tool-artifact-publish" }
```

(Insert into the existing `references` array.)

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm test --filter @ax/agent-claude-sdk-runner -- artifact-publish-executor
```

Expected: PASS, all nine tests green. The 100 MiB test allocates ~100 MiB — if the CI runner is memory-constrained, mark it `it.skipIf(process.env.CI_LOW_MEM === '1', ...)` and document the override.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-claude-sdk-runner/src/artifact-publish-executor.ts \
        packages/agent-claude-sdk-runner/src/__tests__/artifact-publish-executor.test.ts \
        packages/agent-claude-sdk-runner/package.json \
        packages/agent-claude-sdk-runner/tsconfig.json \
        pnpm-lock.yaml
git commit -m "feat(runner): artifact_publish executor (sandbox-side)"
```

---

## Task 8: Wire local-dispatcher + sandbox-MCP into `main.ts`

The runner's startup already builds the `host-MCP` server and passes it to `query({ mcpServers })`. Phase 2 wires `local-dispatcher` (already-written, not previously instantiated), registers the `artifact_publish` executor on it, and constructs a parallel sandbox-MCP server. Both MCP servers attach to the SDK so the model sees host + sandbox tools as one namespace.

**Files:**
- Modify: `packages/agent-claude-sdk-runner/src/main.ts`
- Modify: `packages/agent-claude-sdk-runner/src/__tests__/main.test.ts`

- [ ] **Step 1: Write a focused test asserting both MCP servers are passed to `query`**

Open `packages/agent-claude-sdk-runner/src/__tests__/main.test.ts`. Find the most similar existing test that asserts on the SDK `query()` mock arguments. Add a sibling test (do NOT duplicate the whole boot harness — reuse the existing fixture pattern):

```ts
it('passes both host and sandbox MCP servers to query (when artifact_publish is in the catalog)', async () => {
  // Use the existing helper that stubs IPC + SDK and returns the
  // captured query options. The exact helper name varies by file —
  // grep for `query.mock.calls` or `captureQueryOpts` in this test
  // file before writing the call.
  const opts = await runMainWithTools([
    /* whatever the existing stub for tool.list returns */,
    {
      name: 'artifact_publish',
      description: 'sandbox tool',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      executesIn: 'sandbox',
    },
  ]);
  const servers = opts.mcpServers ?? {};
  expect(Object.keys(servers)).toEqual(
    expect.arrayContaining([MCP_HOST_SERVER_NAME, MCP_SANDBOX_SERVER_NAME]),
  );
});
```

(If the existing test file doesn't have a `runMainWithTools` helper, copy the boot-harness pattern from the closest existing test — `main.test.ts` already has tests of this kind. Don't write a brand-new harness; reuse what's there.)

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test --filter @ax/agent-claude-sdk-runner -- main.test
```

Expected: FAIL — sandbox MCP server isn't constructed yet.

- [ ] **Step 3: Wire in `main.ts`**

In `packages/agent-claude-sdk-runner/src/main.ts`:

3a. Add imports near the top (alongside existing imports):

```ts
import { createLocalDispatcher } from './local-dispatcher.js';
import { createSandboxMcpServer } from './sandbox-mcp-server.js';
import { createArtifactPublishExecutor } from './artifact-publish-executor.js';
import { ARTIFACT_PUBLISH_TOOL_NAME } from '@ax/tool-artifact-publish';
import { MCP_HOST_SERVER_NAME, MCP_SANDBOX_SERVER_NAME } from './tool-names.js';
```

3b. Just AFTER the `const hostMcpServer = createHostMcpServer({ client, tools });` line, add:

```ts
// Phase 2: sandbox-MCP bridge. The local-dispatcher holds executors for
// tools marked `executesIn: 'sandbox'`. Today only `artifact_publish`
// uses this path; future sandbox tools register here too.
const localDispatcher = createLocalDispatcher();
if (tools.some((t) => t.name === ARTIFACT_PUBLISH_TOOL_NAME && t.executesIn === 'sandbox')) {
  localDispatcher.register(
    ARTIFACT_PUBLISH_TOOL_NAME,
    createArtifactPublishExecutor({ workspaceRoot: env.workspaceRoot }),
  );
}
const sandboxMcpServer = createSandboxMcpServer({
  dispatcher: localDispatcher,
  tools,
});
```

3c. In the `mcpServers` field of the `query()` options, add the sandbox server:

```ts
mcpServers: {
  [MCP_HOST_SERVER_NAME]: hostMcpServer,
  [MCP_SANDBOX_SERVER_NAME]: sandboxMcpServer,
},
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test --filter @ax/agent-claude-sdk-runner -- main.test
```

Expected: PASS.

- [ ] **Step 5: Run the full runner test suite**

```bash
pnpm test --filter @ax/agent-claude-sdk-runner
```

Expected: PASS. If existing tests now break because they didn't expect a second MCP server, update their assertions to either ignore the extra key (`toMatchObject` instead of `toEqual`) or include the sandbox server in expectations.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-claude-sdk-runner/src/main.ts \
        packages/agent-claude-sdk-runner/src/__tests__/main.test.ts
git commit -m "feat(runner): wire local-dispatcher + sandbox-MCP into main"
```

---

## Task 9: Extend `AgentMessageSchema` with `contentBlocks` (D2)

Adds the schema field so subsequent tasks can attach attachment blocks to user messages. Phase 2's chat-messages handler still emits the `string` shape — backward compat preserved.

**Files:**
- Modify: `packages/ipc-protocol/src/actions.ts`
- Modify: `packages/ipc-protocol/src/__tests__/actions.test.ts`

- [ ] **Step 1: Write failing tests**

In `packages/ipc-protocol/src/__tests__/actions.test.ts`, find the existing `describe('AgentMessageSchema', ...)` block (if it doesn't exist, create one). Add:

```ts
describe('AgentMessageSchema — Phase 2 contentBlocks', () => {
  it('round-trips a message with only content (string shape, backward compat)', () => {
    const msg = { role: 'user' as const, content: 'hello' };
    const parsed = AgentMessageSchema.parse(msg);
    expect(parsed.contentBlocks).toBeUndefined();
    expect(parsed.content).toBe('hello');
  });

  it('round-trips a message with contentBlocks (Phase 2)', () => {
    const msg = {
      role: 'user' as const,
      content: '',
      contentBlocks: [
        { type: 'text' as const, text: 'see attached' },
        {
          type: 'attachment' as const,
          path: '.ax/uploads/c1/t1/x.pdf',
          displayName: 'X.pdf',
          mediaType: 'application/pdf',
          sizeBytes: 100,
        },
      ],
    };
    const parsed = AgentMessageSchema.parse(msg);
    expect(parsed.contentBlocks).toHaveLength(2);
  });

  it('rejects contentBlocks with invalid variant', () => {
    expect(() =>
      AgentMessageSchema.parse({
        role: 'user',
        content: '',
        contentBlocks: [{ type: 'no-such-variant' }],
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test --filter @ax/ipc-protocol -- actions.test
```

Expected: FAIL — `contentBlocks` not in schema.

- [ ] **Step 3: Update the schema**

In `packages/ipc-protocol/src/actions.ts`, find the `AgentMessageSchema` definition (around line 19). Update:

```ts
import { ContentBlockSchema } from './content-blocks.js';

export const AgentMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  // Phase 2 (attachments). Optional richer payload — when present, the
  // runner prefers this over `content`. The chat-messages handler does
  // not emit this yet (Phase 3); shipping the schema first lets the
  // runner translation pass be testable. Backward-compat: omitting the
  // field reproduces the prior string-only shape exactly.
  contentBlocks: z.array(ContentBlockSchema).optional(),
});
export type AgentMessage = z.infer<typeof AgentMessageSchema>;
```

(Be careful with the import — if `content-blocks.ts` imports from `actions.ts` we'd have a cycle. Quick check: `grep -l "from './actions" packages/ipc-protocol/src/content-blocks.ts`. If a cycle exists, define a local re-export or split. The Phase 1 `content-blocks.ts` adds new variants but does not import from `actions.ts`, so the import direction `actions → content-blocks` should be cycle-free.)

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test --filter @ax/ipc-protocol -- actions.test
```

Expected: PASS. Run the full ipc-protocol suite to catch any consumer that broke:

```bash
pnpm test --filter @ax/ipc-protocol
```

- [ ] **Step 5: Build to surface downstream type errors**

```bash
pnpm build
```

Any package that does exhaustive destructuring on `AgentMessage` may flag the new optional field. Most consumers don't care (the field is optional). Fix any breakage now.

- [ ] **Step 6: Commit**

```bash
git add packages/ipc-protocol/src/actions.ts \
        packages/ipc-protocol/src/__tests__/actions.test.ts
git commit -m "feat(ipc-protocol): extend AgentMessage with optional contentBlocks (Phase 2)"
```

---

## Task 10: Add `workspace.read` IPC action (D3)

The runner's attachment-translation pass needs to fetch attachment bytes from the host (since `/permanent` doesn't auto-sync mid-session). This task wires the IPC action only — the runner's caller lands in Task 12.

**Files:**
- Modify: `packages/ipc-protocol/src/actions.ts` — request/response schemas + `workspace.read` action constant.
- Modify: `packages/ipc-protocol/src/__tests__/actions.test.ts` — schema round-trip tests.
- Create: `packages/ipc-core/src/handlers/workspace-read.ts` — host-side handler.
- Modify: `packages/ipc-core/src/index.ts` — register the new handler.
- Modify: `packages/ipc-core/src/__tests__/dispatcher.test.ts` (or sibling) — handler test.

- [ ] **Step 1: Write failing schema tests**

In `packages/ipc-protocol/src/__tests__/actions.test.ts`:

```ts
describe('workspace.read action', () => {
  it('round-trips request schema', () => {
    const parsed = WorkspaceReadRequestSchema.parse({
      path: '.ax/uploads/c1/t1/x.pdf',
    });
    expect(parsed.path).toBe('.ax/uploads/c1/t1/x.pdf');
  });

  it('rejects empty path', () => {
    expect(() => WorkspaceReadRequestSchema.parse({ path: '' })).toThrow();
  });

  it('round-trips found response', () => {
    const parsed = WorkspaceReadResponseSchema.parse({
      found: true,
      bytesBase64: 'aGk=',
    });
    expect(parsed).toEqual({ found: true, bytesBase64: 'aGk=' });
  });

  it('round-trips not-found response', () => {
    const parsed = WorkspaceReadResponseSchema.parse({ found: false });
    expect(parsed.found).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test --filter @ax/ipc-protocol -- actions.test
```

Expected: FAIL — schemas don't exist.

- [ ] **Step 3: Add schemas + action to `actions.ts`**

In `packages/ipc-protocol/src/actions.ts`, add near other workspace.* schemas (search for `workspace.materialize` to find the right block):

```ts
// workspace.read — Phase 2 (attachments translation, D3).
//
// Exposes the host's `workspace:read` service hook to runners over IPC.
// The runner's attachment-translation pass uses this to fetch attachment
// bytes that the host committed via `attachments:commit` after session
// start (the runner's /permanent doesn't auto-sync mid-session).
//
// Auth: caller's bearer token resolves to a session row; the host-side
// handler uses the session's workspaceId to scope `workspace:read`.
// Cross-session reads are impossible — there's no session id on the wire.
//
// Payload: path is workspace-relative (matches what attachment blocks
// carry, e.g. ".ax/uploads/<conv>/<turn>/file.pdf"). Bytes ride
// base64-encoded for JSON safety; future binary-frame transport could
// drop the encoding.
//
// Size: limited by the framework body cap (Phase 1 raised for bundle
// wire). 25 MiB per-file attachment cap is well within bounds.
export const WorkspaceReadRequestSchema = z.object({
  path: z.string().min(1),
});
export type WorkspaceReadRequest = z.infer<typeof WorkspaceReadRequestSchema>;

export const WorkspaceReadResponseSchema = z.discriminatedUnion('found', [
  z.object({
    found: z.literal(true),
    bytesBase64: z.string(),
  }),
  z.object({ found: z.literal(false) }),
]);
export type WorkspaceReadResponse = z.infer<typeof WorkspaceReadResponseSchema>;

export const WORKSPACE_READ_ACTION = 'workspace.read' as const;
```

If a central action-name registry/enum exists, add `WORKSPACE_READ_ACTION` there. (Grep for `workspace.materialize` to find the registry.)

- [ ] **Step 4: Run schema tests to verify they pass**

```bash
pnpm test --filter @ax/ipc-protocol -- actions.test
```

Expected: PASS.

- [ ] **Step 5: Write failing test for the host-side handler**

`packages/ipc-core/src/__tests__/workspace-read-handler.test.ts` (or extend an existing dispatcher.test.ts — check the file's conventions):

```ts
import { describe, it, expect, vi } from 'vitest';
import { createWorkspaceReadHandler } from '../handlers/workspace-read.js';
import { makeAgentContext, type HookBus } from '@ax/core';

function fakeBus(readImpl: (path: string) => Promise<unknown>): HookBus {
  return {
    call: vi.fn(async (hook: string, _ctx, payload: { path: string }) => {
      if (hook === 'workspace:read') return readImpl(payload.path);
      throw new Error(`unexpected hook ${hook}`);
    }),
    registerService: vi.fn(),
    subscribe: vi.fn(),
    fire: vi.fn(),
  } as unknown as HookBus;
}

describe('workspace.read handler', () => {
  it('returns base64 bytes for a found file', async () => {
    const bus = fakeBus(async (p) => {
      expect(p).toBe('foo/bar');
      return { found: true, bytes: Buffer.from('hello') };
    });
    const handler = createWorkspaceReadHandler({ bus });
    const result = await handler(
      makeAgentContext({ sessionId: 's1', agentId: 'a1', userId: 'u1' }),
      { path: 'foo/bar' },
    );
    expect(result).toEqual({ found: true, bytesBase64: Buffer.from('hello').toString('base64') });
  });

  it('returns found:false for a missing file', async () => {
    const bus = fakeBus(async () => ({ found: false }));
    const handler = createWorkspaceReadHandler({ bus });
    const result = await handler(
      makeAgentContext({ sessionId: 's1', agentId: 'a1', userId: 'u1' }),
      { path: 'missing' },
    );
    expect(result).toEqual({ found: false });
  });

  it('rejects empty path at the handler level (defence in depth)', async () => {
    const bus = fakeBus(async () => {
      throw new Error('should not call workspace:read');
    });
    const handler = createWorkspaceReadHandler({ bus });
    await expect(
      handler(
        makeAgentContext({ sessionId: 's1', agentId: 'a1', userId: 'u1' }),
        { path: '' },
      ),
    ).rejects.toThrow(/path/);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

```bash
pnpm test --filter @ax/ipc-core -- workspace-read
```

Expected: FAIL — handler doesn't exist.

- [ ] **Step 7: Implement `workspace-read.ts`**

`packages/ipc-core/src/handlers/workspace-read.ts`:

```ts
import {
  type AgentContext,
  type HookBus,
  type WorkspaceReadInput,
  type WorkspaceReadOutput,
} from '@ax/core';
import type { WorkspaceReadRequest, WorkspaceReadResponse } from '@ax/ipc-protocol';

export interface WorkspaceReadHandlerDeps {
  bus: HookBus;
}

/**
 * IPC handler for `workspace.read` (Phase 2 — attachments translation).
 *
 * Bridges the wire shape to the host's existing `workspace:read` service
 * hook. The caller's session row scopes which workspace is read; we
 * never accept a workspaceId on the wire (the session bearer is the
 * authority).
 *
 * Bytes round-trip base64-encoded. The hook returns `Bytes` (a Buffer);
 * we encode at the boundary so the JSON envelope is unambiguous.
 */
export function createWorkspaceReadHandler(deps: WorkspaceReadHandlerDeps) {
  return async function handle(
    ctx: AgentContext,
    request: WorkspaceReadRequest,
  ): Promise<WorkspaceReadResponse> {
    if (typeof request?.path !== 'string' || request.path.length === 0) {
      throw new Error('workspace.read: path is required');
    }
    const result = await deps.bus.call<WorkspaceReadInput, WorkspaceReadOutput>(
      'workspace:read',
      ctx,
      { path: request.path },
    );
    if (result.found) {
      return {
        found: true,
        bytesBase64: Buffer.from(result.bytes).toString('base64'),
      };
    }
    return { found: false };
  };
}
```

- [ ] **Step 8: Register the handler**

In `packages/ipc-core/src/index.ts` (or wherever the IPC actions are routed — grep `workspace.materialize` to find the registration site). Add the `workspace.read` route alongside, pointing at `createWorkspaceReadHandler({ bus })`.

If the IPC server has a central handler map, e.g.:

```ts
{
  'workspace.materialize': createMaterializeHandler({...}),
  'workspace.commit-notify': createCommitNotifyHandler({...}),
  // ...
}
```

Add:

```ts
'workspace.read': createWorkspaceReadHandler({ bus }),
```

- [ ] **Step 9: Run tests + build**

```bash
pnpm test --filter @ax/ipc-core
pnpm build
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/ipc-protocol/src/actions.ts \
        packages/ipc-protocol/src/__tests__/actions.test.ts \
        packages/ipc-core/src/handlers/workspace-read.ts \
        packages/ipc-core/src/index.ts \
        packages/ipc-core/src/__tests__/workspace-read-handler.test.ts
git commit -m "feat(ipc): workspace.read action + handler (Phase 2 D3)"
```

---

## Task 11: Attachment translation pass — pure function

Maps an array of `ContentBlock`s containing `attachment` variants into the Anthropic SDK's user-message content shape. Image attachments fetch bytes via `workspace.read` (passed in as an injected reader so this stays a pure-function unit test); PDF attachments either become `document` blocks (when the pinned SDK supports them) or text mentions; everything else becomes a text mention.

**Files:**
- Create: `packages/agent-claude-sdk-runner/src/attachment-translation.ts`
- Create: `packages/agent-claude-sdk-runner/src/__tests__/attachment-translation.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect, vi } from 'vitest';
import type { ContentBlock } from '@ax/ipc-protocol';
import { translateContentBlocks } from '../attachment-translation.js';

function fakeReader(map: Record<string, Buffer>) {
  return vi.fn(async (path: string) => {
    const bytes = map[path];
    if (bytes === undefined) return { found: false as const };
    return { found: true as const, bytesBase64: bytes.toString('base64') };
  });
}

describe('translateContentBlocks', () => {
  it('passes through plain text blocks unchanged', async () => {
    const blocks: ContentBlock[] = [{ type: 'text', text: 'hello' }];
    const out = await translateContentBlocks(blocks, {
      readWorkspace: fakeReader({}),
      supportsDocumentBlocks: true,
    });
    expect(out).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('maps image attachments to Anthropic image blocks (base64 source)', async () => {
    const png = Buffer.from('fake-png-bytes');
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'see' },
      {
        type: 'attachment',
        path: '.ax/uploads/c1/t1/img.png',
        displayName: 'img.png',
        mediaType: 'image/png',
        sizeBytes: png.length,
      },
    ];
    const out = await translateContentBlocks(blocks, {
      readWorkspace: fakeReader({ '.ax/uploads/c1/t1/img.png': png }),
      supportsDocumentBlocks: true,
    });
    expect(out).toEqual([
      { type: 'text', text: 'see' },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: png.toString('base64'),
        },
      },
    ]);
  });

  it('falls back to a text mention when the image is missing from the workspace', async () => {
    const blocks: ContentBlock[] = [
      {
        type: 'attachment',
        path: '.ax/uploads/c1/t1/missing.png',
        displayName: 'missing.png',
        mediaType: 'image/png',
        sizeBytes: 1,
      },
    ];
    const out = await translateContentBlocks(blocks, {
      readWorkspace: fakeReader({}),
      supportsDocumentBlocks: true,
    });
    expect(out).toEqual([
      {
        type: 'text',
        text: expect.stringMatching(
          /User attached 'missing\.png' at \.ax\/uploads\/c1\/t1\/missing\.png \(image\/png\)/,
        ),
      },
    ]);
  });

  it('maps PDF attachments to document blocks when SDK supports them', async () => {
    const pdf = Buffer.from('%PDF-');
    const blocks: ContentBlock[] = [
      {
        type: 'attachment',
        path: '.ax/uploads/c1/t1/x.pdf',
        displayName: 'X.pdf',
        mediaType: 'application/pdf',
        sizeBytes: pdf.length,
      },
    ];
    const out = await translateContentBlocks(blocks, {
      readWorkspace: fakeReader({ '.ax/uploads/c1/t1/x.pdf': pdf }),
      supportsDocumentBlocks: true,
    });
    expect(out).toEqual([
      {
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: pdf.toString('base64'),
        },
      },
    ]);
  });

  it('falls back to a text mention for PDFs when SDK does not support document blocks', async () => {
    const blocks: ContentBlock[] = [
      {
        type: 'attachment',
        path: '.ax/uploads/c1/t1/x.pdf',
        displayName: 'X.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 5,
      },
    ];
    const out = await translateContentBlocks(blocks, {
      readWorkspace: fakeReader({ '.ax/uploads/c1/t1/x.pdf': Buffer.from('%PDF-') }),
      supportsDocumentBlocks: false,
    });
    expect(out).toEqual([
      {
        type: 'text',
        text: expect.stringMatching(
          /User attached 'X\.pdf' at \.ax\/uploads\/c1\/t1\/x\.pdf \(application\/pdf\)/,
        ),
      },
    ]);
  });

  it('maps non-image non-PDF attachments to a text mention (no byte fetch)', async () => {
    const reader = fakeReader({});
    const blocks: ContentBlock[] = [
      {
        type: 'attachment',
        path: '.ax/uploads/c1/t1/notes.txt',
        displayName: 'notes.txt',
        mediaType: 'text/plain',
        sizeBytes: 12,
      },
    ];
    const out = await translateContentBlocks(blocks, {
      readWorkspace: reader,
      supportsDocumentBlocks: true,
    });
    expect(out).toEqual([
      {
        type: 'text',
        text: expect.stringMatching(
          /User attached 'notes\.txt' at \.ax\/uploads\/c1\/t1\/notes\.txt \(text\/plain\)/,
        ),
      },
    ]);
    expect(reader).not.toHaveBeenCalled();
  });

  it('passes through other ContentBlock variants (tool_use, thinking) unchanged', async () => {
    const blocks: ContentBlock[] = [
      { type: 'tool_use', id: 'toolu_1', name: 'foo', input: {} },
    ];
    const out = await translateContentBlocks(blocks, {
      readWorkspace: fakeReader({}),
      supportsDocumentBlocks: true,
    });
    expect(out).toEqual([{ type: 'tool_use', id: 'toolu_1', name: 'foo', input: {} }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test --filter @ax/agent-claude-sdk-runner -- attachment-translation
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `attachment-translation.ts`**

```ts
// ---------------------------------------------------------------------------
// Phase 2 — attachment-translation pass.
//
// Maps `ContentBlock[]` (the canonical stored-transcript shape) onto the
// Anthropic SDK's user-message content shape, one block at a time. Runs
// at user-message handoff to the SDK (and again on transcript replay).
//
// Translation rules per the design doc:
//   - `text` / `tool_use` / `tool_result` / etc.: pass through unchanged.
//   - `attachment` with mediaType image/*: read bytes via injected reader,
//     emit Anthropic `image` block with base64 source.
//   - `attachment` with mediaType application/pdf AND
//     `supportsDocumentBlocks`: read bytes, emit `document` block.
//   - Anything else (including missing bytes for image/pdf): text mention
//     `"User attached '<displayName>' at <path> (<mediaType>)"`.
//
// Byte fetch is via injected `readWorkspace` — the runner wires this to
// `client.call('workspace.read', { path })` at startup, but the
// translation function itself stays pure-function-testable.
// ---------------------------------------------------------------------------

import type { AttachmentBlock, ContentBlock } from '@ax/ipc-protocol';

export interface WorkspaceReader {
  (path: string): Promise<{ found: true; bytesBase64: string } | { found: false }>;
}

export interface TranslationOptions {
  readWorkspace: WorkspaceReader;
  supportsDocumentBlocks: boolean;
}

// Anthropic SDK shape — the union we emit. Loose typing here keeps the
// runner decoupled from the pinned SDK's internal types; the SDK
// accepts any compatible shape on the `message.content` field.
type AnthropicUserContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: string; data: string };
    }
  | {
      type: 'document';
      source: { type: 'base64'; media_type: string; data: string };
    }
  // Pass-through for blocks we don't touch (tool_use, thinking, etc.).
  // The SDK validates these by its own schema downstream.
  | Record<string, unknown>;

function textMention(att: AttachmentBlock): { type: 'text'; text: string } {
  return {
    type: 'text',
    text: `User attached '${att.displayName}' at ${att.path} (${att.mediaType})`,
  };
}

async function translateAttachment(
  att: AttachmentBlock,
  opts: TranslationOptions,
): Promise<AnthropicUserContentBlock> {
  const isImage = att.mediaType.startsWith('image/');
  const isPdf = att.mediaType === 'application/pdf';
  if (!isImage && !(isPdf && opts.supportsDocumentBlocks)) {
    return textMention(att);
  }
  const read = await opts.readWorkspace(att.path);
  if (!read.found) {
    return textMention(att);
  }
  if (isImage) {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: att.mediaType,
        data: read.bytesBase64,
      },
    };
  }
  // PDF + supportsDocumentBlocks branch.
  return {
    type: 'document',
    source: {
      type: 'base64',
      media_type: 'application/pdf',
      data: read.bytesBase64,
    },
  };
}

export async function translateContentBlocks(
  blocks: readonly ContentBlock[],
  opts: TranslationOptions,
): Promise<AnthropicUserContentBlock[]> {
  const out: AnthropicUserContentBlock[] = [];
  for (const block of blocks) {
    if (block.type === 'attachment') {
      out.push(await translateAttachment(block, opts));
      continue;
    }
    // `attachment_ref` is a transit-only variant — it should never reach
    // the runner. If it does, it's a host bug; emit a defensive text
    // mention so we don't crash mid-turn, and log via a thrown Error
    // would be safer but turn-fatal. Trade-off: silent skip is wrong
    // (model gets nothing), text mention preserves provenance.
    if (block.type === 'attachment_ref') {
      out.push({
        type: 'text',
        text: `[runner: attachment_ref ${(block as { attachmentId: string }).attachmentId} not committed]`,
      });
      continue;
    }
    out.push(block as AnthropicUserContentBlock);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test --filter @ax/agent-claude-sdk-runner -- attachment-translation
```

Expected: PASS, all seven tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-claude-sdk-runner/src/attachment-translation.ts \
        packages/agent-claude-sdk-runner/src/__tests__/attachment-translation.test.ts
git commit -m "feat(runner): attachment-translation pass (pure fn) (Phase 2)"
```

---

## Task 12: Wire translation into the runner's `userMessages()` generator

Plumbs the translation function into the SDK input loop. The `WorkspaceReader` is constructed at runner startup from `client.call('workspace.read', ...)`. The `supportsDocumentBlocks` feature-detect probes the pinned SDK at module load (see code).

**Files:**
- Modify: `packages/agent-claude-sdk-runner/src/main.ts`
- Modify: `packages/agent-claude-sdk-runner/src/__tests__/main.test.ts`

- [ ] **Step 1: Write a focused test**

In `packages/agent-claude-sdk-runner/src/__tests__/main.test.ts`, add a test asserting that an inbox entry carrying `contentBlocks` with an image attachment results in the SDK seeing an `image` content block. Use the existing boot-harness pattern. Sketch:

```ts
it('translates attachment contentBlocks to Anthropic image blocks before yielding to SDK', async () => {
  const png = Buffer.from('fake-png');
  // Wire the IPC stub so workspace.read returns the bytes.
  ipcStub.respond('workspace.read', { found: true, bytesBase64: png.toString('base64') });

  // Inject one user-message entry with attachment contentBlocks via the
  // inbox stub's existing helper.
  inboxStub.enqueue({
    type: 'user-message',
    payload: {
      role: 'user',
      content: '',
      contentBlocks: [
        {
          type: 'attachment',
          path: '.ax/uploads/c1/t1/img.png',
          displayName: 'img.png',
          mediaType: 'image/png',
          sizeBytes: png.length,
        },
      ],
    },
    reqId: 'req-1',
  });

  await runMainUntilFirstUserMessage();

  const yielded = capturedSdkUserMessages[0];
  expect(yielded.message.content).toEqual([
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') },
    },
  ]);
});
```

(Adapt to the actual fixture names in `main.test.ts`.)

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test --filter @ax/agent-claude-sdk-runner -- main.test
```

Expected: FAIL.

- [ ] **Step 3: Wire in `main.ts`**

3a. Near the top, add imports:

```ts
import {
  translateContentBlocks,
  type WorkspaceReader,
} from './attachment-translation.js';
import type {
  WorkspaceReadRequest,
  WorkspaceReadResponse,
} from '@ax/ipc-protocol';
```

3b. Feature-detect document blocks. Near the top of `main()`, after the SDK import region:

```ts
// Phase 2: feature-detect whether the pinned claude-agent-sdk supports
// `document` content blocks. The SDK exposes its accepted block types
// via a type-only export, so we probe by attempting a no-op shape
// validation at boot. Pinning the SDK version makes this a static
// answer in practice; we keep the detect so a future SDK bump doesn't
// silently regress.
const SUPPORTS_DOCUMENT_BLOCKS = (() => {
  // No public predicate from the SDK. Inspect a known version marker
  // and default to false to be safe. The SDK package exports
  // `version` (string) in its main entry — bump the lower bound when
  // we confirm document support in a release.
  // Conservative default: false. Override via env for early access.
  if (process.env.AX_SDK_DOCUMENT_BLOCKS === '1') return true;
  return false;
})();
```

(If the pinned SDK already exposes a real predicate, replace the env probe with it. Document the choice in a brief comment either way.)

3c. Build the `WorkspaceReader` after the IPC client is constructed:

```ts
const workspaceReader: WorkspaceReader = async (path) => {
  const resp = (await client.call('workspace.read', {
    path,
  } as WorkspaceReadRequest)) as WorkspaceReadResponse;
  return resp;
};
```

3d. Update the `userMessages()` generator to translate. Find the existing body — it currently yields:

```ts
yield {
  type: 'user',
  parent_tool_use_id: null,
  message: { role: 'user', content: entry.payload.content },
};
```

Replace with:

```ts
let messageContent: unknown;
if (entry.payload.contentBlocks && entry.payload.contentBlocks.length > 0) {
  messageContent = await translateContentBlocks(entry.payload.contentBlocks, {
    readWorkspace: workspaceReader,
    supportsDocumentBlocks: SUPPORTS_DOCUMENT_BLOCKS,
  });
} else {
  messageContent = entry.payload.content;
}
yield {
  type: 'user',
  parent_tool_use_id: null,
  message: { role: 'user', content: messageContent } as never,
};
```

(The `as never` cast is needed because the SDK's `SDKUserMessage.message.content` is typed `string` today; the SDK validates blocks at runtime regardless. Document the cast with a brief comment.)

3e. Update `chatEndHistory.push(...)` to capture the translated content too, so the chat-end event payload reflects what the SDK actually saw. Conservatively, keep `content` as the original string if `contentBlocks` was absent; otherwise stringify the block summary for telemetry (don't ship raw bytes into the history). Sketch:

```ts
chatEndHistory.push({
  role: 'user',
  content:
    entry.payload.contentBlocks && entry.payload.contentBlocks.length > 0
      ? `[${entry.payload.contentBlocks.length} blocks]`
      : entry.payload.content,
});
```

(If history payload semantics matter for downstream consumers, check `event.chat-end` callers before settling on this.)

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test --filter @ax/agent-claude-sdk-runner -- main.test
pnpm test --filter @ax/agent-claude-sdk-runner
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-claude-sdk-runner/src/main.ts \
        packages/agent-claude-sdk-runner/src/__tests__/main.test.ts
git commit -m "feat(runner): wire attachment-translation into userMessages()"
```

---

## Task 13: Register `@ax/tool-artifact-publish` in the CLI plugin list

Plugin must be loaded so the descriptor lands in the catalog. CLI-only chat-path users get the same agent-side capability as the canary preset.

**Files:**
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/cli/package.json`

- [ ] **Step 1: Add the dependency**

In `packages/cli/package.json`:

```json
"@ax/tool-artifact-publish": "workspace:*"
```

- [ ] **Step 2: Register the plugin**

In `packages/cli/src/main.ts`, near the existing `plugins.push(createToolDispatcherPlugin())` line (around line 248):

```ts
import { createToolArtifactPublishPlugin } from '@ax/tool-artifact-publish';

// ... in the chat-path plugin assembly:
plugins.push(createToolArtifactPublishPlugin());
```

(Insert after `createToolDispatcherPlugin()` — the dispatcher must register `tool:register` before this plugin's init calls it. The plugin runtime walks the array in declaration order today; if it parallelizes, the manifest's `calls: ['tool:register']` keeps the ordering correct.)

- [ ] **Step 3: Install + rebuild + smoke test**

```bash
pnpm install
pnpm build --filter @ax/cli
```

Run any existing CLI smoke / e2e tests that exercise the chat path:

```bash
pnpm test --filter @ax/cli
```

Expected: PASS. If a test asserts on the loaded-plugin list, update it.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/main.ts packages/cli/package.json pnpm-lock.yaml
git commit -m "feat(cli): register @ax/tool-artifact-publish on chat path"
```

---

## Task 14: Register `@ax/tool-artifact-publish` in the canary preset

Mirrors Task 13 for the k8s preset. The acceptance / preset tests assert on the plugin list, so they need updating.

**Files:**
- Modify: `presets/k8s/package.json`
- Modify: `presets/k8s/src/index.ts`
- Modify: `presets/k8s/src/__tests__/preset.test.ts`
- Modify: `presets/k8s/src/__tests__/acceptance.test.ts`
- Modify: `presets/k8s/src/__tests__/multi-tenant-acceptance.test.ts`

- [ ] **Step 1: Add the dependency**

In `presets/k8s/package.json`:

```json
"@ax/tool-artifact-publish": "workspace:*"
```

- [ ] **Step 2: Register the plugin**

In `presets/k8s/src/index.ts`, near `plugins.push(createAttachmentsPlugin())` (line 689 per current file):

```ts
import { createToolArtifactPublishPlugin } from '@ax/tool-artifact-publish';

// In the preset's plugin assembly (immediately after createAttachmentsPlugin):
plugins.push(createToolArtifactPublishPlugin());
```

- [ ] **Step 3: Update preset-list assertions**

In all three test files (`preset.test.ts` line 150, `acceptance.test.ts` line 162, `multi-tenant-acceptance.test.ts` line 145), find the expected plugin-name array. Add:

```ts
'@ax/tool-artifact-publish',
```

Keep the list alphabetized if the existing convention is alphabetical; otherwise insert near `@ax/attachments` for grouping.

- [ ] **Step 4: Install + test**

```bash
pnpm install
pnpm test --filter @ax/preset-k8s
```

Expected: PASS. If `multi-tenant-acceptance.test.ts` is heavy or k8s-bound, it may skip without a live cluster — that's fine.

- [ ] **Step 5: Commit**

```bash
git add presets/k8s/src/index.ts presets/k8s/package.json \
        presets/k8s/src/__tests__/preset.test.ts \
        presets/k8s/src/__tests__/acceptance.test.ts \
        presets/k8s/src/__tests__/multi-tenant-acceptance.test.ts \
        pnpm-lock.yaml
git commit -m "feat(preset-k8s): register @ax/tool-artifact-publish in canary preset"
```

---

## Task 15: End-to-end test — agent publishes artifact, tool_result shape verified

The contract test: spin up the in-process bus + runner against a workspace fixture, have a fake LLM call `artifact_publish` on a real file in `/permanent`, assert the tool_result envelope matches the design's JSON shape.

This test lives in the runner package (it exercises sandbox-MCP + executor end-to-end) and complements the existing canary path in `@ax/cli`.

**Files:**
- Create: `packages/agent-claude-sdk-runner/src/__tests__/artifact-publish-e2e.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createLocalDispatcher } from '../local-dispatcher.js';
import { buildSandboxToolEntries } from '../sandbox-mcp-server.js';
import { createArtifactPublishExecutor } from '../artifact-publish-executor.js';
import { ARTIFACT_PUBLISH_DESCRIPTOR } from '@ax/tool-artifact-publish';

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-e2e-'));
});

afterEach(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

describe('artifact_publish end-to-end (sandbox dispatch)', () => {
  it('produces a tool_result with the design-spec JSON shape', async () => {
    // 1. Fixture: a publishable file lives under /permanent/workspace/.
    const rel = 'workspace/reports/Q4.pdf';
    const abs = path.join(workspaceRoot, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, Buffer.from('REPORT'));

    // 2. Wire sandbox-MCP exactly as the runner does at startup.
    const dispatcher = createLocalDispatcher();
    dispatcher.register(
      ARTIFACT_PUBLISH_DESCRIPTOR.name,
      createArtifactPublishExecutor({ workspaceRoot }),
    );
    const [entry] = buildSandboxToolEntries(dispatcher, [ARTIFACT_PUBLISH_DESCRIPTOR]);

    // 3. Simulate the SDK invoking the tool with the model's args.
    const result = await entry.handler(
      { path: `/permanent/${rel}`, displayName: 'Quarter 4 Report' },
      { signal: undefined } as never,
    );

    // 4. Assert the tool_result envelope shape.
    expect(result.isError ?? false).toBe(false);
    expect(result.content[0].type).toBe('text');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.path).toBe(rel);
    expect(parsed.displayName).toBe('Quarter 4 Report');
    expect(parsed.mediaType).toBe('application/pdf');
    expect(parsed.sizeBytes).toBe(6);
    expect(parsed.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.artifactId).toHaveLength(16);
    expect(parsed.downloadUrl).toBe(`ax://artifact/${parsed.artifactId}`);
  });

  it('surfaces an error envelope when the path is outside the allowlist', async () => {
    const dispatcher = createLocalDispatcher();
    dispatcher.register(
      ARTIFACT_PUBLISH_DESCRIPTOR.name,
      createArtifactPublishExecutor({ workspaceRoot }),
    );
    const [entry] = buildSandboxToolEntries(dispatcher, [ARTIFACT_PUBLISH_DESCRIPTOR]);

    const result = await entry.handler(
      { path: '/permanent/.ax/sessions/leak.jsonl' },
      { signal: undefined } as never,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/artifact-path-not-publishable/);
  });
});
```

- [ ] **Step 2: Run the test**

```bash
pnpm test --filter @ax/agent-claude-sdk-runner -- artifact-publish-e2e
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/agent-claude-sdk-runner/src/__tests__/artifact-publish-e2e.test.ts
git commit -m "test(runner): end-to-end artifact_publish via sandbox-MCP dispatch"
```

---

## Task 16: Final verification + PR-body sketch

- [ ] **Step 1: Run the full repo build + tests + lint**

```bash
pnpm build
pnpm test
pnpm lint
```

All three must be clean. Fix anything that broke.

- [ ] **Step 2: Confirm git-lfs availability for CI**

The new `git-workspace.test.ts` LFS test (Task 2) requires `git-lfs` on the CI runner's PATH. Check `.github/workflows/*.yml` (or equivalent) — if the test job installs `git` but not `git-lfs`, add it. macOS jobs need `brew install git-lfs`; Ubuntu jobs need `apt-get install git-lfs`. Commit any workflow change separately:

```bash
git add .github/workflows/*.yml
git commit -m "ci: install git-lfs for runner LFS test"
```

- [ ] **Step 3: Walk the canary path manually**

If you have `make dev-fast` or equivalent against `ax-next-dev`, exercise an agent turn that calls `artifact_publish` on a workspace file. Verify the tool_result JSON in the runner log matches the e2e test's expectations. If you don't have a live cluster, the e2e + unit tests are the floor.

- [ ] **Step 4: Update the design doc's deviation log if one exists**

The design doc at `docs/plans/2026-05-15-attachments-and-artifacts-design.md` may have a "deviations" or "open questions" section. Update it with D1/D2/D3 from this plan if applicable. If not present, no change needed.

- [ ] **Step 5: Draft the PR body**

Copy this skeleton into the PR description and fill in the bracketed bits:

```markdown
## Summary

Phase 2 of the attachments & artifacts subsystem (design `docs/plans/2026-05-15-attachments-and-artifacts-design.md`, Phase 1 = PR #72).

Lands the agent-facing half:
- New `@ax/tool-artifact-publish` plugin contributes the `artifact_publish` tool descriptor (sandbox-executed).
- `@ax/agent-claude-sdk-runner` gains a sandbox-MCP bridge (`sandbox-mcp-server.ts`), the `artifact_publish` executor (filesystem stat/hash in `/permanent`), and an attachment-translation pass that maps `attachment` blocks to Anthropic image/document/text blocks before the LLM call.
- `@ax/ipc-protocol` extends `AgentMessage` with optional `contentBlocks` and adds the `workspace.read` IPC action.
- `@ax/ipc-core` adds the host-side `workspace.read` handler exposing the existing `workspace:read` service hook.
- Agent container image gains `git-lfs`; the runner runs `git lfs install --local` after materialize.

## Design deviations (flagged in plan §"Design deviations from the spec")

- **D1.** `artifact_publish` runs sandbox-side, not host-side as the design diagram suggests. Only the sandbox can stat/hash `/permanent/<path>` at call time.
- **D2.** `AgentMessage` adds optional `contentBlocks`; `content: string` stays as the backward-compat default.
- **D3.** New `workspace.read` IPC action lets the runner fetch attachment bytes from the host on demand (no auto-sync mid-session).

## Half-wired windows opened (and existing windows)

Phase 1's half-wired window stays OPEN. Phase 2 wires `artifact_publish` (one direction) and the translation pass (no caller yet — chat-messages handler doesn't emit `attachment` blocks until Phase 3). Phase 3 closes the window.

## Boundary review

- New hook surface: none. `workspace.read` is an IPC action (Section 4 of the design doc), not a new service hook.
- New IPC action: `workspace.read`. Alternate impl: a Postgres-BYTEA-backed store would expose the same shape via a different `workspace:read` registrar; this IPC stays unchanged. Payload field names (`path`, `bytesBase64`, `found`) carry no backend vocabulary.
- Subscriber risk: none — `workspace.read` is request/response, no broadcast.

## Security review

- Sandbox tool surface: new — `artifact_publish` is the first sandbox-executed tool. The executor only reads files under `<workspaceRoot>` (the runner's `/permanent`), enforces the allowlist + symlink refusal + 100 MiB cap, no `..` traversal, no shell.
- IPC: `workspace.read` is gated by the existing bearer-token-resolves-to-session pattern. Wrong session → wrong workspace → cannot read other tenants.
- Prompt-injection: a model that talks `artifact_publish` into reading `/permanent/.ax/sessions/...` hits the allowlist deny — `artifact-path-not-publishable` tool_result.
- Supply chain: one new apt package (`git-lfs`), pinned at distro version (tag-only until CI image-build pipeline pins).

## Tests

| Package | Coverage |
|---|---|
| `@ax/tool-artifact-publish` | descriptor shape, path-allowlist (8 cases), plugin factory registers descriptor |
| `@ax/agent-claude-sdk-runner` | sandbox-MCP bridge (filter/dispatch/error), executor (9 fs/edge cases), translation (7 mediaType paths), main wires both MCP servers, e2e through sandbox-MCP |
| `@ax/ipc-protocol` | AgentMessage round-trip with + without contentBlocks; workspace.read req/resp |
| `@ax/ipc-core` | workspace.read handler (found / not-found / empty-path) |
| `@ax/preset-k8s` | plugin-list assertion includes `@ax/tool-artifact-publish` |

## Test plan

- [ ] `pnpm build` clean
- [ ] `pnpm test` clean
- [ ] `pnpm lint` clean
- [ ] `make dev-fast` / live canary turn calls `artifact_publish` and tool_result matches expected JSON shape (if available)
```

- [ ] **Step 6: Self-review checklist before requesting review**

- All 16 task commits present? `git log --oneline phase-1-merge-base..HEAD`
- Every new file has its corresponding test file?
- Lint clean? `pnpm lint`
- Half-wired-window declaration present in PR body?
- D1/D2/D3 design deviations called out in PR body?
- CI workflow updated for `git-lfs` if needed?

---

## Summary

After 16 tasks:
- One new plugin (`@ax/tool-artifact-publish`) — host-side descriptor registrar.
- One new IPC action (`workspace.read`) — runner-side caller wired in Task 12.
- One new sandbox-MCP dispatch path (`sandbox-mcp-server.ts`) — first sandbox-executed tool pioneers it.
- One new attachment-translation pass — pure-function, swappable.
- One new container-image dependency (`git-lfs`) — enables LFS smudge on workspace clone.
- AgentMessage shape extension — optional `contentBlocks`; Phase 3 starts populating it.

## Half-wired windows

OPEN from Phase 1; still OPEN after Phase 2. Phase 3 closes the window by wiring `POST /api/attachments`, `POST /api/chat/messages` extension (emit `attachment_ref`), `GET /api/files`, and the browser-side adapter + chips.

## Boundary review

- No new service hooks.
- One new IPC action (`workspace.read`); payload `{ path }` + `{ found, bytesBase64 }` — no backend vocab.

## Test plan

- [ ] `pnpm build`, `pnpm test`, `pnpm lint` clean across the repo
- [ ] LFS install step verified by `git-workspace.test.ts`
- [ ] Sandbox-MCP dispatch verified by `sandbox-mcp-server.test.ts`
- [ ] Executor verified by `artifact-publish-executor.test.ts` (9 cases)
- [ ] Translation pass verified by `attachment-translation.test.ts` (7 cases)
- [ ] Plugin registration verified by preset list-assertions
- [ ] End-to-end shape verified by `artifact-publish-e2e.test.ts`

## Self-review checklist

- [ ] Every task's tests fail before impl, pass after
- [ ] No `executesIn: 'host'` artifact_publish ever sneaks in (D1)
- [ ] No reads from `/permanent` in translation pass (D3 uses `workspace.read`)
- [ ] `git lfs install --local` writes to `.git/config` only — never `--system` or HOME
- [ ] All new files have tests
- [ ] Half-wired-window declaration present in PR body
- [ ] D1/D2/D3 deviations called out
