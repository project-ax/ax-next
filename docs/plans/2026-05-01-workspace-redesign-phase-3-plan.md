# Phase 3 Implementation Plan — Bundle wire + git-status diff + skill validator

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.
>
> **Canonical save location at execution time:** `docs/plans/2026-05-01-workspace-redesign-phase-3-plan.md` (this draft lives in `.claude/plans/` per plan-mode constraint; copy it on your way in.)

**Goal:** Replace the sandbox-host change-detection wire with a git-bundle-based protocol over `git status` of `/permanent`, closing the `.claude/projects/<sessionId>.jsonl` gap and the Bash-deletes-are-invisible gap. Land the first `workspace:pre-apply` subscriber (`@ax/validator-skill`) in the same PR.

**Architecture:** Sandbox materializes `/permanent` from a host-streamed baseline bundle at session start, runs the agent against a real git working tree, ships per-turn changes as `git bundle create baseline..HEAD` over the existing IPC channel. Host unpacks the bundle, verifies every commit's author is `ax-runner`, builds canonical `WorkspaceChange[]`, fires `workspace:pre-apply` with the `.ax/**`-filtered subset, then `workspace:apply` with the full set against the existing `@ax/workspace-git-server` host-storage path (unchanged).

**Tech Stack:** Node + TypeScript, vitest, @ax/core hook bus, child_process git, zod schemas, base64 over JSON IPC, K8s pod spec (`@ax/sandbox-k8s`).

---

## Context

### Why this change

The shipped runner detects workspace changes via PostToolUse on `Write/Edit/MultiEdit` (`packages/agent-claude-sdk-runner/src/workspace-diff.ts`). Three concrete gaps surface as defects:

1. **Bash deletes/moves are invisible.** `rm`, `mv`, `>file` redirects bypass the SDK's tool-call interception, so the workspace plugin never sees them.
2. **MCP tool writes are invisible.** Anything that writes to disk outside the SDK's three watched tools is silently lost.
3. **The jsonl gap.** The SDK writes `.claude/projects/<sessionId>.jsonl` internally (no tool call). This is the load-bearing failure that motivated the workspace redesign — Phase B's runner-owned sessions design depended on capturing it.

Phase 3 fixes all three by switching to `git status -based change detection over a real working tree under `/permanent`. Anything the agent writes — through any tool — is caught by `git add -A` at turn end.

### What's already shipped (verified)

- **Phase 1:** `@ax/workspace-git-server` — sharded storage tier with real `git` binary, smart-HTTP wire, REST CRUD lifecycle. Host pod talks git smart-HTTP to it.
- **Phase 2:** `createWorkspaceGitServerPlugin` — host-side client wrapping `MirrorCache` + `RepoLifecycleClient` + `GitEngine`. Discriminated by `K8sWorkspaceConfig.backend === 'git-protocol'`. Acceptance test exercises this end-to-end (`presets/k8s/src/__tests__/acceptance.test.ts:347-481`).
- **IPC handler scaffolding:** `packages/ipc-core/src/handlers/workspace-commit-notify.ts` already fires `workspace:pre-apply` (line 59), `workspace:apply` (83), and `workspace:applied` (115). Phase 3 doesn't add new bus hook surfaces — the sandbox-host **wire** changes, the bus contract doesn't.

### What Phase 3 changes

1. Sandbox image: add `git` binary + paranoid env (`GIT_CONFIG_NOSYSTEM=1`, `core.hooksPath=/dev/null`, `protocol.allow=never`, plus `GIT_AUTHOR_*` / `GIT_COMMITTER_*` pinned to `ax-runner`).
2. Sandbox layout: `/permanent` (git working tree) + `/ephemeral` (caches + scratch). Replaces today's single `/workspace` emptyDir.
3. Session-start materialize: new IPC action `workspace.materialize` — host streams a baseline bundle; sandbox runs `git clone -b baseline` and pins `refs/heads/baseline`.
4. Turn-end change detection: replace `workspace-diff.ts` (PostToolUse observer) with `git status` against `/permanent`, then `git commit` and `git bundle create baseline..HEAD`.
5. Wire shape: `workspace.commit-notify`'s `changes: FileChange[]` becomes `bundleBytes: string` (base64). Host unpacks, verifies author is `ax-runner`, builds canonical `WorkspaceChange[]`.
6. Filter: pre-apply receives the `.ax/**`-restricted subset; apply receives the full set.
7. New plugin: `@ax/validator-skill` subscribes to `workspace:pre-apply`, parses YAML frontmatter on `.ax/skills/**/SKILL.md`, vetoes malformed.
8. Wire validator into k8s preset and CLI; extend canary acceptance test with skill-add scenarios (accept + veto + Bash-delete).

### What Phase 3 does NOT change

- Host-storage wire (git smart-HTTP via `@ax/workspace-git-server`) — unchanged.
- `workspace:apply` / `read` / `list` / `diff` hook contracts — unchanged.
- `workspace:pre-apply` / `applied` payload shapes — unchanged.
- Identity validator (`IDENTITY.md`/`SOUL.md`) — deferred to Phase 4 per design doc.

---

## Five invariants check (CLAUDE.md)

- **I1 (storage-agnostic hook payloads):** `workspace:pre-apply` payload stays `{ changes: WorkspaceChange[]; parent; reason }` — no git vocabulary. `bundleBytes` lives only on the sandbox-host wire and is decoded host-side before any subscriber sees a thing. The bundler is internal IPC-handler code, not a hook.
- **I2 (no cross-plugin imports):** `@ax/validator-skill` imports only `@ax/core`. The host bundler lives inside `@ax/ipc-core` (the existing handler package) — no new cross-plugin coupling.
- **I3 (no half-wired plugins):** `@ax/validator-skill` lands in CLI + k8s preset + canary acceptance test in this same PR. The `workspace:pre-apply` hook gains its first real subscriber here.
- **I4 (one source of truth):** `git status` on `/permanent` becomes THE source of truth for "what the agent wrote this turn." `workspace-diff.ts` and `diff-accumulator.ts` are deleted in the same PR — no two ways to detect.
- **I5 (capabilities minimized):** git binary added to sandbox image (and host image — both already have one for the workspace-git-server plugin path; sandbox is the new addition). Paranoid env locks down hooks/protocols/global-config. Sandbox NetworkPolicy unchanged (egress to host only).

---

## Architecture diagram

```
┌──────────────────────────────────────┐
│ Sandbox pod                          │
│  /permanent  ← git working tree      │
│  /ephemeral  ← caches + scratch      │
│  git binary (paranoid env)           │
│  GIT_AUTHOR_*=ax-runner pinned       │
└──────────────┬───────────────────────┘
               │ IPC over HTTP
               │  ┌─ workspace.materialize  (new) ──→ host bundle stream
               │  ├─ workspace.commit-notify (CHANGED): bundleBytes ──→
               │  └─ event.* (unchanged)
               ▼
┌──────────────────────────────────────┐
│ Host pod                             │
│  ipc-core handler:                   │
│    1. unpack bundle (temp clone)     │
│    2. verify ax-runner author        │
│    3. tree-diff → WorkspaceChange[]  │
│    4. filter to .ax/**               │
│    5. fire workspace:pre-apply       │
│       └─ @ax/validator-skill (NEW)   │
│    6. call workspace:apply           │
│    7. fire workspace:applied         │
└──────────────┬───────────────────────┘
               │ git smart-HTTP (unchanged)
               ▼
┌──────────────────────────────────────┐
│ Storage tier (@ax/workspace-git-...) │
└──────────────────────────────────────┘
```

---

## Slice plan

Each slice is a TDD-shaped commit boundary. The PR may rebase or squash at the end; commit-by-commit lands cleanly because each slice has its own tests passing.

### Slice 0 — Pre-flight (audit, not code)

Confirm assumptions before touching code. Output of this slice is a short ADR appended to this plan, no source changes.

**Step 0a:** Read `presets/k8s/src/__tests__/acceptance.test.ts:347-481` and confirm the git-protocol backend canary actually completes today (run `pnpm test --filter @ax/preset-k8s` and verify the test passes). If it doesn't, Phase 3 is blocked on a bug not described here — STOP and surface the failure.

**Step 0b:** Read `deploy/charts/ax-next/` host image base + sandbox image base. Confirm:
- Host image already has `git` (it should — `@ax/workspace-git-server` host plugin spawns git for mirror cache).
- Sandbox image does NOT have `git` (the new add).
- If host image lacks git, file an issue and patch host Dockerfile in Slice 1.

**Step 0c:** Resolve open questions (see "Open Questions" below) — pick `.ax/**` vs `.claude/**` filter; decide on `commitRef` retention; pick bundle-size cap. Document in this plan before proceeding.

**Commit:** none (planning slice).

---

### Slice 1 — Sandbox image gains `git` + paranoid env

**Files:**
- Modify: `deploy/sandbox-image/Dockerfile` (or whichever path the chart uses — confirm in Slice 0; install `git` from the base distro's package manager, version-pinned)
- Modify: `packages/sandbox-k8s/src/pod-spec.ts` (extend env list)
- Modify: `packages/sandbox-k8s/SECURITY.md` (extend the capability budget walk — git is a new spawn capability)
- Test: `packages/sandbox-k8s/src/__tests__/pod-spec.test.ts`

**Step 1a: Write failing test**

Add to `pod-spec.test.ts`:
```typescript
it('carries paranoid git env on the runner container', () => {
  const spec = buildPodSpec({ /* ...existing fixture... */ });
  const env = spec.spec.containers[0].env ?? [];
  const byName = (n: string) => env.find((e) => e.name === n)?.value;

  expect(byName('GIT_CONFIG_NOSYSTEM')).toBe('1');
  expect(byName('GIT_CONFIG_GLOBAL')).toBe('/dev/null');
  expect(byName('HOME')).toBe('/nonexistent');
  expect(byName('GIT_AUTHOR_NAME')).toBe('ax-runner');
  expect(byName('GIT_AUTHOR_EMAIL')).toBe('ax-runner@example.com');
  expect(byName('GIT_COMMITTER_NAME')).toBe('ax-runner');
  expect(byName('GIT_COMMITTER_EMAIL')).toBe('ax-runner@example.com');
});
```

**Step 1b: Run test — confirm fail**

`pnpm test --filter @ax/sandbox-k8s -t "paranoid git env"` → FAIL: env vars absent.

**Step 1c: Implement minimum**

In `pod-spec.ts`, append the seven env vars to the container's env list. Write a brief comment header "git binary is in the image — these are the locked-down rails per design doc Phase 3 / SECURITY.md."

**Step 1d: Run test — confirm pass**

Same command → PASS.

**Step 1e: Update SECURITY.md**

In `packages/sandbox-k8s/SECURITY.md`, under the capability budget section, add a paragraph: "Git binary as of Phase 3. Locked-down env (above) prevents repo-init from reading user-global config, refuses remote helpers, and pins commit author to `ax-runner` so a compromised sandbox can't forge a commit attributed to a different user."

**Step 1f: Commit**

```bash
git add packages/sandbox-k8s deploy/sandbox-image
git commit -m "sandbox-k8s: add git binary and paranoid env to runner pod spec"
```

---

### Slice 2 — Sandbox `/permanent` + `/ephemeral` mount layout

**Files:**
- Modify: `packages/sandbox-k8s/src/pod-spec.ts` (mount layout)
- Modify: `packages/sandbox-k8s/src/__tests__/pod-spec.test.ts`
- Modify: `packages/agent-claude-sdk-runner/src/env.ts` (read `AX_WORKSPACE_ROOT=/permanent`; today's value is whatever `env.workspaceRoot` resolves to — confirm and switch)

**Step 2a: Write failing test**

```typescript
it('mounts /permanent (workspace) and /ephemeral (scratch) emptyDirs', () => {
  const spec = buildPodSpec({ /* ...existing fixture... */ });
  const mounts = spec.spec.containers[0].volumeMounts ?? [];
  expect(mounts.find((m) => m.mountPath === '/permanent')).toBeDefined();
  expect(mounts.find((m) => m.mountPath === '/ephemeral')).toBeDefined();
  // No legacy /workspace mount
  expect(mounts.find((m) => m.mountPath === '/workspace')).toBeUndefined();

  const volumes = spec.spec.volumes ?? [];
  const permanent = volumes.find((v) => v.name === 'permanent');
  expect(permanent?.emptyDir).toBeDefined();
  const ephemeral = volumes.find((v) => v.name === 'ephemeral');
  expect(ephemeral?.emptyDir).toBeDefined();
});
```

**Step 2b–d: Standard TDD cycle**

Run, confirm fail; implement minimum (replace `workspace` volume/mount with the two new ones); run, confirm pass.

**Step 2e: Update runner env reader**

In `packages/agent-claude-sdk-runner/src/env.ts`, default `workspaceRoot` to `/permanent` (or read `AX_WORKSPACE_ROOT` if set). Update existing test fixtures that referenced `/workspace`.

**Step 2f: Commit**

```bash
git commit -m "sandbox-k8s + claude-sdk-runner: switch to /permanent + /ephemeral mount layout"
```

---

### Slice 3 — IPC action `workspace.materialize` (host streams baseline bundle)

**Files:**
- Modify: `packages/ipc-protocol/src/actions.ts` (new schemas)
- Create: `packages/ipc-core/src/handlers/workspace-materialize.ts`
- Create: `packages/ipc-core/src/handlers/__tests__/workspace-materialize.test.ts`
- Modify: `packages/ipc-core/src/dispatcher.ts` (register handler)
- Modify: `packages/ipc-protocol/src/__tests__/schemas.test.ts`

**Step 3a: Write the schema test first**

```typescript
it('round-trips an empty bundle (brand-new workspace)', () => {
  const parsed = WorkspaceMaterializeResponseSchema.parse({ bundleBytes: '' });
  expect(parsed.bundleBytes).toBe('');
});
it('round-trips a non-empty bundle', () => {
  const b64 = Buffer.from('PACK\x00\x00').toString('base64');
  const parsed = WorkspaceMaterializeResponseSchema.parse({ bundleBytes: b64 });
  expect(parsed.bundleBytes).toBe(b64);
});
```

**Step 3b: Add schema in `actions.ts`**

```typescript
// ---------------------------------------------------------------------------
// workspace.materialize
//
// Sandbox -> Host RPC fired exactly once at session start, before the SDK
// query begins. The host produces a `git bundle` over its local mirror's
// current ref (or empty bytes for a brand-new workspace) and returns it
// base64-encoded. Sandbox unpacks into `/permanent`.
//
// Wire field `bundleBytes` is git-vocabulary — but per Invariant I1 this
// is allowed: bundle bytes are an opaque transport on the sandbox-host
// axis. They never reach a subscriber. Documented here, mirrored on
// workspace.commit-notify.
// ---------------------------------------------------------------------------
export const WorkspaceMaterializeRequestSchema = z.object({}).strict();
export type WorkspaceMaterializeRequest = z.infer<typeof WorkspaceMaterializeRequestSchema>;
export const WorkspaceMaterializeResponseSchema = z.object({
  bundleBytes: z.string(),  // base64; empty string => empty workspace
});
export type WorkspaceMaterializeResponse = z.infer<typeof WorkspaceMaterializeResponseSchema>;
```

**Step 3c: Write handler test**

```typescript
it('produces an empty bundle when workspace has no current version', async () => {
  const bus = makeBusWithFakeWorkspaceListReturning([]); // empty
  const res = await workspaceMaterializeHandler({}, ctx, bus);
  expect(res.body.bundleBytes).toBe('');
});

it('produces a bundle reachable from the workspace HEAD', async () => {
  const bus = makeBusWithFakeWorkspaceWithFiles({ '.ax/CLAUDE.md': 'hi' });
  const res = await workspaceMaterializeHandler({}, ctx, bus);
  // Decode + run `git bundle verify` in a tempdir → must succeed.
  expect(verifyBundleBase64(res.body.bundleBytes)).toBe(true);
});
```

**Step 3d: Implement handler**

Strategy: handler queries `workspace:list({})` to learn what's in the workspace. If empty, return `{ bundleBytes: '' }`. Otherwise, in a tempdir:
1. `git init --bare scratch.git`
2. For each path returned by `list`, `workspace:read` it, hash-object → tree → commit (single commit named "baseline").
3. `git bundle create baseline.bundle baseline`.
4. Read bytes, base64-encode, return.

**Alternative implementation note:** if the host workspace plugin already has its mirror cache populated (`@ax/workspace-git-server`'s `MirrorCache`), prefer asking the plugin for the bundle via a NEW host-side internal interface rather than reconstructing from `workspace:read`. Decision deferred to implementation — the slow path (reconstruct via list+read) keeps I2 clean (no plugin-internal access). Recommend: start with the slow path for correctness; add an internal `workspace:bundle` service hook later only if profiling shows the materialize path is hot. Document this trade-off in the handler header.

**Step 3e: Register in dispatcher**

```typescript
ACTIONS.set('/workspace.materialize', { method: 'POST', handler: workspaceMaterializeHandler });
```

**Step 3f: Commit**

```bash
git commit -m "ipc-protocol + ipc-core: add workspace.materialize for baseline bundle streaming"
```

---

### Slice 4 — Sandbox runner: session-start materialize + git init/clone

**Files:**
- Create: `packages/agent-claude-sdk-runner/src/git-workspace.ts` (NEW — owns: spawn git, materialize from bundle, baseline ref tracking)
- Create: `packages/agent-claude-sdk-runner/src/__tests__/git-workspace.test.ts`
- Modify: `packages/agent-claude-sdk-runner/src/main.ts` (call materialize after `session.get-config`, before `query()`)

**Step 4a: Write failing test for empty-bundle path**

```typescript
it('initializes /permanent as an empty repo when bundleBytes is empty', async () => {
  const tmpRoot = await mkdtempPermanent();
  await materializeWorkspace({ root: tmpRoot, bundleBase64: '' });
  // /permanent/.git exists; HEAD is unborn but valid
  expect(await fs.stat(path.join(tmpRoot, '.git'))).toBeDefined();
  // baseline ref doesn't exist yet (first commit will create it)
  const refs = await spawnCapture('git', ['-C', tmpRoot, 'show-ref'], { allowFail: true });
  expect(refs.stdout).toBe('');
});
```

**Step 4b: Write failing test for non-empty bundle**

```typescript
it('clones from a non-empty baseline bundle and pins refs/heads/baseline to HEAD', async () => {
  const bundle = await makeBundleWithFile({ '.ax/CLAUDE.md': 'hello' });
  const tmpRoot = await mkdtempPermanent();
  await materializeWorkspace({ root: tmpRoot, bundleBase64: bundle.toString('base64') });

  expect(await fs.readFile(path.join(tmpRoot, '.ax/CLAUDE.md'), 'utf8')).toBe('hello');
  const baseline = await spawnCapture('git', ['-C', tmpRoot, 'rev-parse', 'refs/heads/baseline']);
  const head = await spawnCapture('git', ['-C', tmpRoot, 'rev-parse', 'HEAD']);
  expect(baseline.stdout.trim()).toBe(head.stdout.trim());
});
```

**Step 4c: Implement `git-workspace.ts`**

```typescript
export async function materializeWorkspace({ root, bundleBase64 }: { root: string; bundleBase64: string }): Promise<void> {
  if (bundleBase64 === '') {
    await spawn('git', ['init', root]);
    return;
  }
  const bundlePath = path.join(root, '.git-baseline.bundle');
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(bundlePath, Buffer.from(bundleBase64, 'base64'));
  // Clone into root from the bundle file. `--branch baseline` pulls the named ref.
  await spawn('git', ['clone', '--branch', 'baseline', bundlePath, root]);
  await fs.unlink(bundlePath);
  await spawn('git', ['-C', root, 'update-ref', 'refs/heads/baseline', 'HEAD']);
}
```

**Step 4d: Wire into main.ts boot**

After `session.get-config` returns and before `query()` opens, call:
```typescript
const matResp = await client.call('workspace.materialize', {}) as WorkspaceMaterializeResponse;
await materializeWorkspace({ root: env.workspaceRoot, bundleBase64: matResp.bundleBytes });
```

Place it after `agentConfig` resolves and before any tool work. Failure here is bootstrap-fatal (exit code 2 — the runner can't operate without a workspace).

**Step 4e: Commit**

```bash
git commit -m "claude-sdk-runner: materialize /permanent from host-streamed baseline bundle at session start"
```

---

### Slice 5 — Wire schema change: `workspace.commit-notify` carries `bundleBytes`

**Half-wired window OPENS here.** The next slice (S6 host bundler + S5b sandbox sender) closes it.

**Files:**
- Modify: `packages/ipc-protocol/src/actions.ts:148-179`
- Modify: `packages/ipc-protocol/src/__tests__/schemas.test.ts`
- Modify: `packages/ipc-core/src/handlers/workspace-commit-notify.ts` (temporarily error on receipt with a clear "bundle wire not yet implemented" message — closes the gap to S6)

**Step 5a: Update the request schema**

```typescript
export const WorkspaceCommitNotifyRequestSchema = z.object({
  parentVersion: z.string().nullable(),
  reason: z.string(),
  bundleBytes: z.string(),  // base64; empty = no-op turn (no commits)
});
```

Drop `commitRef` (was opaque, never used host-side — see Open Question 2). Rename `message` to `reason` for symmetry with the bus payload.

**Step 5b: Schema tests**

Round-trip (accept), missing field (reject), wrong type (reject).

**Step 5c: Stub the handler**

Replace the body of `workspaceCommitNotifyHandler` with a temporary 501 path that logs "bundle wire not yet implemented" and returns `{ accepted: false, reason: 'bundle-wire-not-implemented' }`. **This is the half-wired window.** Document it loudly in the commit message and in a `// TODO(phase-3-S6)` comment.

**Step 5d: Commit**

```bash
git commit -m "ipc-protocol: switch workspace.commit-notify to bundleBytes wire shape (handler stubbed pending S6)"
```

---

### Slice 6 — Host bundler: unpack, verify ax-runner author, build canonical changes

**Half-wired window TIGHTENS here. Closes when S5b (sandbox sender) lands in S7.**

**Files:**
- Create: `packages/ipc-core/src/bundler/verify.ts` (author check)
- Create: `packages/ipc-core/src/bundler/walk.ts` (tree-diff → `WorkspaceChange[]`)
- Create: `packages/ipc-core/src/bundler/filter.ts` (`.ax/**` matcher)
- Create: `packages/ipc-core/src/bundler/__tests__/{verify,walk,filter}.test.ts`
- Modify: `packages/ipc-core/src/handlers/workspace-commit-notify.ts` (replace stub with real implementation)
- Modify: `packages/ipc-core/SECURITY.md` (extend — git binary appears in host's IPC handler now)

**Step 6a: Write the verifier test**

```typescript
it('accepts a bundle whose every commit author/committer is ax-runner', async () => {
  const bundle = await makeBundle([{ author: 'ax-runner', committer: 'ax-runner', files: { 'foo.txt': 'a' } }]);
  await expect(verifyAuthor(bundle)).resolves.toBeUndefined();
});
it('rejects a bundle with any commit authored by something else', async () => {
  const bundle = await makeBundle([{ author: 'eve', committer: 'ax-runner', files: { 'foo.txt': 'a' } }]);
  await expect(verifyAuthor(bundle)).rejects.toThrow(/author=eve/);
});
```

**Step 6b: Write the walker test**

```typescript
it('emits a put change for an added file', async () => {
  const bundle = await makeBundleAddingFile('.ax/CLAUDE.md', 'hi');
  const changes = await walkBundleChanges({ bundle, baseline: null });
  expect(changes).toEqual([{ path: '.ax/CLAUDE.md', kind: 'put', content: Buffer.from('hi') }]);
});
it('emits a delete change for a removed file', async () => {
  const baseline = await makeBundleAddingFile('.ax/SOUL.md', 'old');
  const bundle = await makeBundleDeletingFile('.ax/SOUL.md', { baseline });
  const changes = await walkBundleChanges({ bundle, baseline });
  expect(changes).toContainEqual({ path: '.ax/SOUL.md', kind: 'delete' });
});
```

**Step 6c: Write the filter test**

```typescript
it('keeps .ax/ paths and drops everything else', () => {
  const all: WorkspaceChange[] = [
    { path: '.ax/CLAUDE.md', kind: 'put', content: Buffer.from('') },
    { path: '.ax/skills/foo/SKILL.md', kind: 'put', content: Buffer.from('---\nname: foo\n---\n') },
    { path: 'workspace/src/main.ts', kind: 'put', content: Buffer.from('') },
    { path: '.gitignore', kind: 'delete' },
  ];
  const filtered = filterToAx(all);
  expect(filtered.map((c) => c.path)).toEqual(['.ax/CLAUDE.md', '.ax/skills/foo/SKILL.md']);
});
```

**Step 6d: Implement the three modules**

`verify.ts`: in a scratch bare repo, `git fetch <bundle-file> 'refs/*:refs/*'`, then for each commit in `baseline..FETCH_HEAD` (or all commits when baseline is null), run `git cat-file -p <oid>` and parse author/committer lines. Reject if either name is not exactly `ax-runner`.

`walk.ts`: `git diff-tree -r --no-commit-id <baseline> <head>` over the scratch repo; for each line, parse the status (A/M/D) and the path. For A/M, `git cat-file blob <new-oid>` to fetch content. Build `WorkspaceChange[]`.

`filter.ts`: pure path-prefix check `path.startsWith('.ax/')`. (See Open Question 1 for `.claude/` discussion.)

**Step 6e: Replace the handler stub**

```typescript
export const workspaceCommitNotifyHandler: ActionHandler = async (raw, ctx, bus) => {
  const parsed = WorkspaceCommitNotifyRequestSchema.safeParse(raw);
  if (!parsed.success) return validationError(`workspace.commit-notify: ${parsed.error.message}`);
  const { parentVersion, reason, bundleBytes } = parsed.data;

  // Empty bundle = no-op turn; skip commit-notify
  if (bundleBytes === '') {
    return { status: 200, body: { accepted: true, version: parentVersion ?? 'unborn', delta: null } };
    // Or maybe an explicit "no-op" path; finalize during impl.
  }

  // Unpack into a tempdir, verify, walk
  const tmp = await mkdtempBundle();
  try {
    await writeBundle(tmp, bundleBytes);
    await verifyAuthor(tmp);
    const allChanges = await walkBundleChanges({ bundle: tmp, baseline: parentVersion });
    const axChanges = filterToAx(allChanges);

    const pre = await bus.fire('workspace:pre-apply', ctx, {
      changes: axChanges,
      parent: parentVersion as WorkspaceVersion | null,
      reason,
    });
    if (pre.rejected) {
      return { status: 200, body: { accepted: false, reason: pre.reason } };
    }

    // Apply uses the FULL change set, not the .ax-filtered one
    const applied = await bus.call('workspace:apply', ctx, {
      changes: allChanges,
      parent: parentVersion,
      reason,
    });
    await bus.fire('workspace:applied', ctx, applied.delta);
    return { status: 200, body: { accepted: true, version: applied.version, delta: null } };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
};
```

**Step 6f: Run handler tests** — extend `workspace-commit-notify.test.ts` with:
- Empty-bundle accepted no-op
- Non-ax-runner author rejects before pre-apply fires (assert pre-apply not called)
- pre-apply sees `.ax/`-only changes
- apply sees full changes
- pre-apply veto returns `accepted: false`
- apply parent-mismatch returns `accepted: false`

**Step 6g: Commit**

```bash
git commit -m "ipc-core: implement bundle unpacker, ax-runner verifier, .ax/ filter"
```

---

### Slice 7 — Sandbox runner: git-status diff at turn end + bundle creation + baseline tracking

**Half-wired window CLOSES here.**

**Files:**
- Modify: `packages/agent-claude-sdk-runner/src/main.ts:515-549` (turn-end logic)
- Modify: `packages/agent-claude-sdk-runner/src/git-workspace.ts` (add `commitTurn` + `rollbackToBaseline` helpers)
- Create: `packages/agent-claude-sdk-runner/src/__tests__/main-turn-end.test.ts` (or extend existing)
- Delete: `packages/agent-claude-sdk-runner/src/post-tool-use.ts`'s `diffs` parameter usage (drop the workspace-diff observer call; preserve other PostToolUse responsibilities if any)

**Step 7a: Write integration test for turn end**

Use a real tmpdir + spawn `git`. Stub the IPC client. Scenario: file written via raw fs (simulates Bash), turn boundary, expect `workspace.commit-notify` called with non-empty `bundleBytes`. Decode and inspect the bundle: must contain a commit authored by ax-runner that adds the file.

**Step 7b: Write rollback test**

Scenario: same setup, but stub IPC to return `{ accepted: false, reason: 'veto' }`. After turn end, the file must be gone (`git reset --hard baseline`).

**Step 7c: Implement helpers in `git-workspace.ts`**

```typescript
export async function commitTurnAndBundle({ root, reason }: { root: string; reason: string }): Promise<Buffer | null> {
  await spawn('git', ['-C', root, 'add', '-A']);
  // Detect empty turn: no diff cached
  const status = await spawnCapture('git', ['-C', root, 'diff', '--cached', '--quiet'], { allowFail: true });
  if (status.exitCode === 0) return null;  // no changes
  await spawn('git', ['-C', root, 'commit', '-m', reason]);
  const bundlePath = path.join(root, '.git-turn.bundle');
  await spawn('git', ['-C', root, 'bundle', 'create', bundlePath, 'baseline..HEAD']);
  const bytes = await fs.readFile(bundlePath);
  await fs.unlink(bundlePath);
  return bytes;
}
export async function advanceBaseline(root: string): Promise<void> {
  await spawn('git', ['-C', root, 'update-ref', 'refs/heads/baseline', 'HEAD']);
}
export async function rollbackToBaseline(root: string): Promise<void> {
  await spawn('git', ['-C', root, 'reset', '--hard', 'baseline']);
}
```

**Step 7d: Replace turn-end block in `main.ts`**

```typescript
} else if (msg.type === 'result') {
  // Turn boundary: stage everything in /permanent, commit if non-empty,
  // bundle, ship. PostToolUse-based observation is gone.
  const bundle = await commitTurnAndBundle({ root: env.workspaceRoot, reason: 'turn' });
  if (bundle !== null) {
    try {
      const resp = (await client.call('workspace.commit-notify', {
        parentVersion,
        reason: 'turn',
        bundleBytes: bundle.toString('base64'),
      })) as WorkspaceCommitNotifyResponse;
      if (resp.accepted) {
        parentVersion = resp.version as unknown as string;
        await advanceBaseline(env.workspaceRoot);
      } else {
        // Surface the rejection text into the SDK as a system message
        // (impl detail — needs design); for MVP, log + rollback.
        process.stderr.write(`runner: workspace rejected: ${resp.reason}\n`);
        await rollbackToBaseline(env.workspaceRoot);
      }
    } catch (err) {
      // Network / 5xx: keep working tree intact, retry next turn
      process.stderr.write(`runner: commit-notify failed: ${(err as Error).message}\n`);
    }
  }
  // ...existing event.turn-end emission unchanged
}
```

**Step 7e: Drop the workspace-diff observer**

In `packages/agent-claude-sdk-runner/src/post-tool-use.ts`, remove the `diffs` constructor argument and any `observePostToolUse(diffs, ...)` calls. The hook's other responsibilities (e.g., emitting `event.tool-post-call`) stay.

In `main.ts`, remove the `createDiffAccumulator()` line and the `diffs:` reference in the `createPostToolUseHook` call.

**Step 7f: Commit**

```bash
git commit -m "claude-sdk-runner: replace PostToolUse diff observer with git-status at turn end"
```

---

### Slice 8 — `@ax/validator-skill` plugin

**Files (mirroring `packages/credentials/`):**
- Create: `packages/validator-skill/package.json`
- Create: `packages/validator-skill/tsconfig.json`
- Create: `packages/validator-skill/vitest.config.ts`
- Create: `packages/validator-skill/src/index.ts`
- Create: `packages/validator-skill/src/plugin.ts`
- Create: `packages/validator-skill/src/frontmatter.ts`
- Create: `packages/validator-skill/src/__tests__/frontmatter.test.ts`
- Create: `packages/validator-skill/src/__tests__/plugin.test.ts`
- Create: `packages/validator-skill/SECURITY.md`
- Create: `packages/validator-skill/README.md`

**Step 8a: Frontmatter parser test**

```typescript
it('accepts well-formed frontmatter', () => {
  const md = '---\nname: foo\ndescription: a thing\n---\n# Body\n';
  const r = parseFrontmatter(md);
  expect(r.ok).toBe(true);
  expect(r.fields).toEqual({ name: 'foo', description: 'a thing' });
});
it('rejects missing opening fence', () => {
  expect(parseFrontmatter('# Body').ok).toBe(false);
});
it('rejects missing required name', () => {
  expect(parseFrontmatter('---\ndescription: x\n---\n').ok).toBe(false);
});
it('rejects invalid YAML', () => {
  expect(parseFrontmatter('---\n: bad\n---\n').ok).toBe(false);
});
it('handles non-UTF-8 bytes by rejecting cleanly', () => {
  const bytes = new Uint8Array([0xff, 0xfe, 0x00]);
  const r = parseFrontmatterBytes(bytes);
  expect(r.ok).toBe(false);
});
```

**Step 8b: Implement frontmatter parser**

Hand-rolled splitter (no new dependency unless `js-yaml` is already in the lockfile — check before adding). Logic:
1. Decode bytes as UTF-8 strict; on failure return `{ ok: false, reason: 'not utf-8' }`.
2. Match `/^---\n([\s\S]*?)\n---\n/`. If no match: `{ ok: false, reason: 'no frontmatter block' }`.
3. Parse the captured body as YAML (use `js-yaml` if available; else hand-roll a minimal `key: value` parser since SKILL.md frontmatter is conventionally flat).
4. Require `name` (string, non-empty) and `description` (string, non-empty). Anything else permitted but not validated.
5. Return `{ ok: true, fields }`.

**Step 8c: Plugin test**

```typescript
it('allows changes that don\'t touch SKILL.md', async () => {
  const harness = await bootstrapWith({ plugins: [createValidatorSkillPlugin()] });
  const decision = await harness.bus.fire('workspace:pre-apply', ctx, {
    changes: [{ path: '.ax/CLAUDE.md', kind: 'put', content: Buffer.from('hi') }],
    parent: null,
    reason: 'turn',
  });
  expect(decision.rejected).toBe(false);
});

it('vetoes a SKILL.md add with malformed frontmatter', async () => {
  const harness = await bootstrapWith({ plugins: [createValidatorSkillPlugin()] });
  const decision = await harness.bus.fire('workspace:pre-apply', ctx, {
    changes: [{ path: '.ax/skills/foo/SKILL.md', kind: 'put', content: Buffer.from('# no frontmatter\n') }],
    parent: null,
    reason: 'turn',
  });
  expect(decision.rejected).toBe(true);
  expect(decision.reason).toMatch(/frontmatter/);
});

it('allows a SKILL.md add with valid frontmatter', async () => {
  const harness = await bootstrapWith({ plugins: [createValidatorSkillPlugin()] });
  const md = '---\nname: foo\ndescription: a thing\n---\n# Body\n';
  const decision = await harness.bus.fire('workspace:pre-apply', ctx, {
    changes: [{ path: '.ax/skills/foo/SKILL.md', kind: 'put', content: Buffer.from(md) }],
    parent: null,
    reason: 'turn',
  });
  expect(decision.rejected).toBe(false);
});

it('passes through SKILL.md deletes (no content to validate)', async () => {
  const harness = await bootstrapWith({ plugins: [createValidatorSkillPlugin()] });
  const decision = await harness.bus.fire('workspace:pre-apply', ctx, {
    changes: [{ path: '.ax/skills/foo/SKILL.md', kind: 'delete' }],
    parent: null,
    reason: 'turn',
  });
  expect(decision.rejected).toBe(false);
});
```

**Step 8d: Implement plugin**

```typescript
const PLUGIN_NAME = '@ax/validator-skill';
const SKILL_PATH = /^\.ax\/skills\/[^/]+\/SKILL\.md$/;

export function createValidatorSkillPlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [],
      calls: [],
      subscribes: ['workspace:pre-apply'],
    },
    init({ bus }) {
      bus.subscribe('workspace:pre-apply', PLUGIN_NAME, async (_ctx, input) => {
        for (const c of input.changes) {
          if (c.kind !== 'put' || !SKILL_PATH.test(c.path)) continue;
          const r = parseFrontmatterBytes(c.content);
          if (!r.ok) {
            return { decision: 'veto', reasons: [`${c.path}: ${r.reason}`] };
          }
        }
        return { decision: 'allow' };
      });
    },
  };
}
```

**Step 8e: Write SECURITY.md**

Voice per CLAUDE.md. Three-section structure: capability budget (no spawn, no network, no file IO; consumes only payload bytes), threat model (untrusted SKILL.md content from agent — parser must not eval, must not interpolate), known limits (only flat frontmatter validated; nested YAML allowed but unchecked).

**Step 8f: Write README.md**

Voice per CLAUDE.md (warm, slightly self-deprecating). Two paragraphs: what it does, what it doesn't.

**Step 8g: Commit**

```bash
git commit -m "validator-skill: add plugin subscribing to workspace:pre-apply"
```

---

### Slice 9 — Wire `@ax/validator-skill` into presets + canary

**Files:**
- Modify: `packages/cli/src/main.ts` (push `createValidatorSkillPlugin()`)
- Modify: `presets/k8s/src/index.ts` (push after `auditLogPlugin()`)
- Modify: `presets/k8s/src/__tests__/preset.test.ts` (extend expected plugin set)
- Modify: `presets/k8s/src/__tests__/acceptance.test.ts` (new scenarios)

**Step 9a: Extend `preset.test.ts` plugin-list assertion**

The existing test at `'contains the expected production plugin set'` fails because `@ax/validator-skill` is now expected. Run, confirm fail.

**Step 9b: Wire into both presets**

- In `presets/k8s/src/index.ts`, after `plugins.push(auditLogPlugin())`, add `plugins.push(createValidatorSkillPlugin())`. Add the import.
- In `packages/cli/src/main.ts`, the same — keep CLI and k8s parity per project pattern (memory: "every new-plugin phase loads it in CLI + k8s preset same PR").

**Step 9c: Run preset.test.ts** — confirm pass.

**Step 9d: Add canary scenarios to `acceptance.test.ts`**

Three new tests (mirror the existing `'boots a preset-equivalent plugin set with the git-protocol workspace and completes a chat'` pattern):
- `'workspace.commit-notify accepts a turn that adds a valid SKILL.md'`
- `'workspace.commit-notify rejects a turn that adds a SKILL.md with bad frontmatter'`
- `'workspace.commit-notify catches a Bash-deleted file (the gap that motivated Phase 3)'`

Each scenario uses the existing in-process git-protocol harness, the stub runner shape, and asserts on the response status + workspace state after the turn.

**Step 9e: Commit**

```bash
git commit -m "presets/k8s + cli: wire @ax/validator-skill; extend canary with skill + Bash-delete scenarios"
```

---

### Slice 10 — Cleanup: delete the legacy diff observer

**Files (deletions):**
- `packages/agent-claude-sdk-runner/src/workspace-diff.ts`
- `packages/agent-claude-sdk-runner/src/diff-accumulator.ts`
- `packages/agent-claude-sdk-runner/src/__tests__/workspace-diff.test.ts`
- `packages/agent-claude-sdk-runner/src/__tests__/diff-accumulator.test.ts`
- `packages/ipc-protocol/src/actions.ts`: drop `FileChangeSchema` if grep shows no other consumers.

**Files (modifications):**
- `packages/agent-claude-sdk-runner/src/post-tool-use.ts`: drop the now-unused `diffs` parameter from the factory signature; update its callers and its tests.
- `packages/agent-native-runner/`: search for `diff-accumulator` imports; if any, retire the same way (the native runner shares the pattern). If different, address per-runner in a follow-up — flag in PR notes.

**Step 10a: Run full test suite**

```bash
pnpm test
```

Expect: green. Anything that now imports a deleted file fails — fix by completing the deletion.

**Step 10b: Commit**

```bash
git commit -m "claude-sdk-runner: delete legacy PostToolUse diff observer (superseded by git-status)"
```

---

## Boundary review

Per CLAUDE.md `Boundary review (required for new hooks)`, this PR adds two IPC actions and changes one. Bus hook surfaces are **unchanged** — no new `workspace:*` service or subscriber hooks.

### `workspace.materialize` (new IPC action)

- **Alternate impl this hook could have:** materialize via host's local mirror cache instead of by reconstructing from `workspace:list` + `workspace:read`. Both fit the same wire shape.
- **Payload field names that might leak:** `bundleBytes`. Justified: this is the sandbox-host transport axis, not a subscriber-visible hook payload (per design doc lines 401-405). Documented inline.
- **Subscriber risk:** N/A — this is a wire-only action, no bus hook fires.
- **Wire surface:** schema lives in `@ax/ipc-protocol` (same place `workspace.commit-notify` lives).

### `workspace.commit-notify` (changed IPC action)

- **Alternate impl this hook could have:** could ship per-tool-call notifications instead of per-turn bundles. We stick with per-turn because (a) the bundle is the natural unit of "what did this turn do," (b) per-tool-call doubles or triples IPC volume.
- **Payload field names that might leak:** `bundleBytes`, `parentVersion`. Same justification as above. The host bundler immediately decodes to backend-agnostic `WorkspaceChange[]` before any subscriber visibility.
- **Subscriber risk:** subscribers (skill validator) only see `WorkspaceChange[]` — no bundle vocabulary. Confirmed by the plugin test that asserts no bundle field reaches the subscriber.
- **Wire surface:** schema in `@ax/ipc-protocol`.

### `workspace:pre-apply` (existing subscriber hook, first real subscriber added)

- **Hook payload:** `{ changes: WorkspaceChange[]; parent: WorkspaceVersion | null; reason: string }`. Unchanged from today.
- **Filtering decision:** the bundler filters to `.ax/**` before firing the hook. This is documented in the handler header. Validators authored later (e.g., identity validator in Phase 4) will see the same filtered payload.

---

## Verification plan

### Unit tests

Each slice ships its own tests. Cumulative coverage:
- `pod-spec.test.ts`: paranoid env + mount layout pinned (S1, S2).
- `workspace-materialize.test.ts`: empty + non-empty bundle paths (S3).
- `git-workspace.test.ts`: materialize/commitTurn/rollback under real `git` (S4, S7).
- `bundler/{verify,walk,filter}.test.ts`: author check, tree-diff, path filter (S6).
- `workspace-commit-notify.test.ts` (extended): empty bundle, non-ax-runner author rejected, pre-apply filter, apply-full set, parent-mismatch (S6).
- `frontmatter.test.ts` + `plugin.test.ts`: YAML parse + bus contract (S8).
- `preset.test.ts`: plugin manifest list pinned (S9).

### Acceptance test (canary)

`presets/k8s/src/__tests__/acceptance.test.ts` gains three scenarios per S9. The existing chat scenario (line 368) continues to pass — Phase 3 is additive on the canary.

### End-to-end smoke (manual)

After merge, deploy the chart with `workspace.backend: git-protocol` (already supported). Run a chat that:
1. Adds a valid `.ax/skills/foo/SKILL.md` — confirm accepted, view in storage tier with `git log` (commit author = `ax-runner`).
2. Adds an invalid `.ax/skills/bar/SKILL.md` — confirm the agent receives the rejection text in the next turn.
3. Runs `Bash` with `rm /permanent/.ax/CLAUDE.md` — confirm the next turn's bundle records the delete (jsonl gap closed by extension).

---

## Open questions to resolve before execution

These are decisions the user should make. Slice 0 is the place to surface them; do not start S1 without resolution.

### Q1: `.ax/**` filter scope vs `.claude/skills/**`

The design doc has an internal inconsistency:
- Line 102-104 lays out `/permanent/.ax/skills/<skill>/SKILL.md` as the on-disk layout.
- Line 303 says the validator filters paths matching `.claude/skills/**/SKILL.md`.

These are different namespaces. The runner today uses `settingSources: []` (the SDK does NOT read `.claude/`), so `.claude/` content is purely an agent-managed convention.

**Recommendation:** filter to `.ax/**` (per design doc line 274 — the canonical filter spec). Validator looks at `.ax/skills/**/SKILL.md`. Treat line 303 as a typo. Confirm before S6/S8.

### Q2: Drop `commitRef` from `workspace.commit-notify`?

Today's schema has `commitRef: z.string()` — opaque, runner-side, unused on the host. Recommend drop. Confirm.

### Q3: Bundle bytes — base64 vs streaming endpoint

For MVP, base64 in JSON keeps the wire simple and reuses the existing `MAX_FRAME` (4 MiB) cap. A turn's diff is typically tiny (jsonl growth + maybe one or two file writes). Recommend base64 + a documented size cap. Confirm.

### Q4: Empty-bundle materialize

A brand-new workspace has no `refs/heads/main`; the host's local mirror doesn't exist. Recommend: handler returns `{ bundleBytes: '' }` and the runner's `materializeWorkspace` does `git init` (no clone). Confirm.

### Q5: Host pod git binary

The host pod image must already have `git` (the `@ax/workspace-git-server` plugin spawns it). Confirm via the chart's host Dockerfile in Slice 0; if absent, add to Slice 1.

### Q6: Materialize implementation strategy (slow vs fast)

Slow path (handler reconstructs bundle from `workspace:list` + `workspace:read`) is correct and I2-clean. Fast path (handler reaches into the workspace plugin's local mirror) is faster but couples ipc-core to a specific plugin. **Recommend slow path for Phase 3**; revisit if profiling shows materialize is hot. Confirm.

---

## Critical files

- `/Users/vpulim/dev/ai/ax-next/docs/plans/2026-05-01-workspace-redesign-design.md` — source design.
- `/Users/vpulim/dev/ai/ax-next/packages/ipc-core/src/handlers/workspace-commit-notify.ts` — handler being rewritten.
- `/Users/vpulim/dev/ai/ax-next/packages/ipc-protocol/src/actions.ts` — wire schemas.
- `/Users/vpulim/dev/ai/ax-next/packages/agent-claude-sdk-runner/src/main.ts` — runner entry, turn-end logic.
- `/Users/vpulim/dev/ai/ax-next/packages/agent-claude-sdk-runner/src/workspace-diff.ts` — to be deleted.
- `/Users/vpulim/dev/ai/ax-next/packages/agent-claude-sdk-runner/src/diff-accumulator.ts` — to be deleted.
- `/Users/vpulim/dev/ai/ax-next/packages/sandbox-k8s/src/pod-spec.ts` — mount + env changes.
- `/Users/vpulim/dev/ai/ax-next/presets/k8s/src/index.ts` — wire validator (line 393 area, after audit-log).
- `/Users/vpulim/dev/ai/ax-next/presets/k8s/src/__tests__/acceptance.test.ts:347-481` — canary anchor.
- `/Users/vpulim/dev/ai/ax-next/packages/credentials/` — layout reference for the new validator package.
- `/Users/vpulim/dev/ai/ax-next/packages/workspace-git-server/src/client/plugin.ts` — host workspace plugin (unchanged but referenced for context).

---

## PR notes preview (to be written at PR creation)

- Closes Phase 3 of `docs/plans/2026-05-01-workspace-redesign-design.md`.
- Closes the jsonl gap, the Bash-delete gap, and the MCP-write gap.
- Half-wired window: opens at S5 (wire schema bumped, handler stubbed), closes at S7 (sandbox sender + handler real). Single PR per design doc.
- Five invariants: I1 reaffirmed (bundle bytes never reach a subscriber); I3 satisfied (validator wired into k8s preset + CLI + canary same PR); I4 satisfied (legacy observer deleted in same PR).
- Boundary review: see "Boundary review" section above.
- Deviation from design doc: the validator filters `.ax/**` (not `.claude/**`); see Q1 resolution.
