# Artifact-publish round-trip e2e — executor-driven seed

**Date:** 2026-05-20
**Status:** Spec for the single TODO item "Artifact-publish round-trip e2e
via real runner" under Attachments / artifacts. Scope is intentionally
narrow — a follow-up to PR #97/#100 that closes the executor↔chip drift
gap without dragging in the SDK-subprocess work explicitly deferred to
Phase 6 PR-B.

## Problem

Three layers cover the artifact_publish surface today, but they don't
touch:

  1. **Component layer** (`packages/channel-web/src/__tests__/artifact-chip.test.tsx`):
     pure render tests on `ArtifactChip` — displayName, size formatting,
     download trigger, link variant, unknown-id fallback. No backend.
  2. **Executor layer** (`packages/agent-claude-sdk-runner/src/__tests__/artifact-publish-e2e.test.ts`):
     dispatches the tool through the runner's real `createLocalDispatcher` +
     `buildSandboxToolEntries`, asserts the `tool_result` envelope shape
     `{ artifactId, downloadUrl, path, displayName, mediaType, sizeBytes,
     sha256 }`. No HTTP / ACL / chip.
  3. **HTTP+ACL canary** (`presets/k8s/src/__tests__/acceptance.test.ts`
     line 2036+ — "Phase 3 canary: artifact_publish round-trip"): boots
     the full plugin tree, mints a conversation, pre-commits a workspace
     file via `workspace:apply`, **seeds a hand-rolled jsonl** carrying
     a fabricated `artifactResult` (`artifactId: 'art-canary-1'`),
     asserts `GET /api/files` admits the path. No executor.

Nothing proves the executor's actual output shape matches the
ACL/chip's expected shape. If `ArtifactPublishOutput.path` is renamed
to `relativePath`, or `downloadUrl` switches format, or `artifactId`
becomes a UUID, **(2) still passes** (shape stays internally
consistent) and **(3) still passes** (the canary fabricates the same
shape it asserts against). Prod regression slips through.

The existing comment at `acceptance.test.ts:1594-1597` flags this
explicitly:

> Defers the artifact_publish round-trip to a follow-up canary:
> stubbing the runner end-to-end so an assistant turn lands a
> `tool_result` is significantly more wiring than the user-attachment
> path; the ArtifactChip surface is independently covered by component
> tests.

## Scope

In-scope:

  - Thread the **real `createArtifactPublishExecutor` output** through
    the existing "Phase 3 canary: artifact_publish round-trip" test
    (only test affected).
  - Add one focused assertion locking the executor's `artifactId` to
    the sha256-derived 16-hex-char shape that the chip + ACL consume.

Out-of-scope (deferred elsewhere):

  - Spawning the real runner subprocess with a mocked Anthropic
    backend. That's Phase 6 PR-B work (`project_codex_findings_2026_04_29.md`,
    TODO line 74), and is significantly heavier.
  - Replacing the canary's `agent:invoke` stub with a deterministic
    shim that exercises the runner's translation layer (option B in
    the brainstorm — middle ground, more wiring, lower marginal
    coverage given the executor↔chip seam is the load-bearing one).
  - Changes to `ArtifactPublishOutput` or `checkPathScope` shape
    itself. Both stay frozen.

## Design

### Workspace topology in the test

The canary already manages one tmp dir (`workspaceRoot`) — the git
server's bare-repo root passed to
`createWorkspaceGitPlugin({ repoRoot })`. The ACL,
`workspace:read`, and `GET /api/files` read through this view.

`createArtifactPublishExecutor` reads from
`path.join(workspaceRoot, rel)` via `fs.lstat` + `fs.readFile` —
i.e. it needs the bytes on a real working-tree path, not in a bare
git repo. In production that path is `/permanent/<rel>`, the runner's
materialized checkout.

We add a sibling tmp dir to the test, `runnerCheckoutRoot`, that
simulates the runner's `/permanent` view. The artifact bytes get
written twice:

  - via `workspace:apply` into the bare repo (existing path, line
    2241) — so the ACL admits the path through `workspace:read`.
  - via `fs.writeFile` into `runnerCheckoutRoot/<ARTIFACT_PATH>` — so
    the executor's `lstat` + `readFile` succeed.

Cleanup: `rm -rf runnerCheckoutRoot` in the same `finally` block that
already rms `workspaceRoot`.

### Wiring

The single-call shape:

```ts
const runnerCheckoutRoot = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), 'ax-phase-3-artifact-runner-')),
);
await fs.mkdir(path.join(runnerCheckoutRoot, 'workspace'), {
  recursive: true,
  mode: 0o755,
});
await fs.writeFile(
  path.join(runnerCheckoutRoot, ARTIFACT_PATH),
  ARTIFACT_BYTES,
);

const executor = createArtifactPublishExecutor({
  workspaceRoot: runnerCheckoutRoot,
});
const artifactResult = await executor({
  id: 'toolu_1',
  name: 'artifact_publish',
  input: {
    path: `/permanent/${ARTIFACT_PATH}`,
    displayName: 'summary.md',
  },
});
```

`artifactResult` replaces the hand-rolled object at canary lines
2271-2280. Everything downstream — the `tool_result.content` JSON
string at line 2307, the `assistantLine` envelope, the
`workspace:apply` seed at line 2331 — stays unchanged.

### New assertion

After the executor call, before seeding the jsonl, lock the
output shape the chip + ACL depend on:

```ts
expect(artifactResult.artifactId).toMatch(/^[0-9a-f]{16}$/);
expect(artifactResult.downloadUrl).toBe(
  `ax://artifact/${artifactResult.artifactId}`,
);
expect(artifactResult.path).toBe(ARTIFACT_PATH);
expect(artifactResult.mediaType).toBe('text/markdown');
expect(artifactResult.sizeBytes).toBe(ARTIFACT_BYTES.byteLength);
```

The downstream `GET /api/files` assertion at line 2349+ is unchanged —
it now exercises the executor↔ACL coupling implicitly (if `path`
field is renamed, that GET 404s).

### Dependency wiring

None. `@ax/agent-claude-sdk-runner` is already in
`presets/k8s/package.json` `dependencies` AND in
`presets/k8s/tsconfig.json` `references`. Verified before writing this
spec. The new import is a single line at the top of `acceptance.test.ts`.

## What this catches

Drift between `ArtifactPublishOutput` (produced by the runner-side
executor) and what `checkPathScope`'s artifact-block branch +
channel-web's `MarkdownText` resolver consume.

Concrete regression scenarios:

  - Rename `ArtifactPublishOutput.path` → `relativePath`: ACL stops
    finding the path in the tool_result, `GET /api/files` 404s, canary
    fails.
  - `downloadUrl` switches from `ax://artifact/<id>` to
    `https://example.com/artifact/<id>`: new assertion catches it.
  - `artifactId` becomes a UUID: new assertion catches it.
  - Executor produces extra fields the ACL/chip can't parse: canary
    still passes (forward-compatible), but the lock-down assertions
    pin the minimum contract.

## What this doesn't catch

  - SDK MCP-transport bugs (the executor is invoked directly here, not
    through `buildSandboxToolEntries`). Already covered by
    `artifact-publish-e2e.test.ts`.
  - The runner's own jsonl envelope shape (`type: 'assistant'`,
    `message.content`, etc.). Still hand-rolled here. Closing that gap
    needs the agent:invoke shim (option B) or the SDK subprocess
    (option C / Phase 6 PR-B).

## Manual verification

`pnpm test --filter @ax/preset-k8s -- --run acceptance.test` passes,
with the same set of canaries plus the executor-output coupling
locked.

`pnpm build` clean (the new import resolves through the existing
tsconfig reference).

## Not in scope

Task 2 from the same TODO section (`$CLAUDE_CONFIG_DIR/sessions/`
mirroring) is explicitly skipped this session — the trigger ("future
feature needs session metadata in the workspace") hasn't fired, and
the Phase E follow-up doc
(`docs/plans/2026-05-19-runner-jsonl-write-phase-e-followup.md:56`)
defers it for the same reason.
