# TASK-991 Implementation Plan — facts export volume-only; host-supplied last-pass date for skill reflection

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task heading carries its tier tag.

**Goal:** `@ax/memory` writes the facts export only to the read-only `/memory` NFS volume (no git copy, no `workspace:*` calls), and the skill-reflection routine stops keeping `.ax/skill-reflection/last-run.json` because the host now fills the date of the routine's last completed pass into its prompt from the routines plugin's own fire records.

**Architecture:** The exporter loses its git half (list/read/apply + CAS retry) and only exists when a volume is configured. Its on-disk layout constant moves from `@ax/core`'s `workspace-policy.ts` to `@ax/sandbox-protocol`, next to `volumeAgentKey`, because the volume layout still uses it. The runner-immutable guard drops the facts subtree. For reflection, `@ax/routines` gains one host-rendered prompt token, `{{lastCompletedRun}}`, filled in `fire.ts` from a new store read before any webhook payload is rendered. The seeded prompt is rewritten to use it. A versioned migration (v21) swaps the catalog row only while its prompt is still byte-for-byte the previous seed.

**Tech Stack:** TypeScript, vitest, Kysely + Postgres (testcontainers), pnpm workspaces, Helm chart docs.

**Spec:** `docs/plans/2026-10-29-agent-files-simplification-design.md` §6a, §9 (skill-reflection row), §16 slice 2. Card: TASK-991. Decisions: `.claude/memory/decisions/2026-10-30-TASK-991.md`. Read the decisions shard before Task 1. It records why each choice below was made, and where the code contradicted the card.

## Global Constraints

- Host token literal: `{{lastCompletedRun}}` (exported as `LAST_COMPLETED_RUN_TOKEN`). Whitespace inside the braces is tolerated, as in the payload tokens: `/\{\{\s*lastCompletedRun\s*\}\}/`.
- Rendered value: the UTC date `YYYY-MM-DD` (`date.toISOString().slice(0, 10)`) of the newest qualifying run's `fired_at`, or the literal `never`.
- A qualifying run is a `routines_v1_fires` row for the same `(agent_id, routine_id)` with `status IN ('ok','silenced')` and `run_as_user_id` = the firing row's `ownerUserId`. A run with `status = 'error'` (including the sweep's `RUN_INTERRUPTED`) never counts.
- The token renders only for repeat routines (the non-task branch of `fire.ts`), and only when the prompt body contains it. It renders BEFORE `renderTemplate` (the payload pass), so payload text is never scanned for the host token.
- `SKILL_REFLECTION_SEED_HASH = 'seed-2026-10-30'`. Frozen previous seed: `SKILL_REFLECTION_MARKER_SEED_HASH = 'seed-2026-09-27'` and `SKILL_REFLECTION_MARKER_PROMPT` (the current `SKILL_REFLECTION_PROMPT` text, byte for byte).
- Routines schema version for the prompt swap: **21**. Before you commit Task 7, and again when you rebase, run `git log origin/main --oneline -- packages/routines/src/migrations.ts`. If another PR took 21, renumber to the next free version everywhere (migration and every `versions()` list).
- NFS layout is unchanged: `<volumeAgentKey(agentId)>/permanent/memory/facts/…`, mounted at `/memory` via that `subPath`. The constant keeps its name and value: `MEMORY_FACTS_EXPORT_ROOT = 'permanent/memory/facts'`.
- `memory:export:flush` keeps its I/O shape `{} → { changed: boolean }`. It is registered only together with `sandbox:memory-mounts`, and only when `exports.volume` is set.
- Out of scope. Do NOT touch any of these: deleting `workspace-policy.ts`, `.ax/`, the git tier, `workspace:*` hooks, or validator-identity's subscriber (TASK-995); memory rules (`rules.ts`, `MEMORY_RULES_PATH`, `RUNNER_IMMUTABLE_PATHS`, the `rules` option; TASK-989); `packages/memory/package.json`, `packages/memory/tsconfig.json`, `pnpm-lock.yaml` (the `@ax/workspace-git` devDependency stays; `rules.test.ts` still uses it until 989 lands).
- Test commands put `--filter` BEFORE the script. Docker-backed suites (routines, skills canary, preset-memory canary) need an explicit socket, e.g. `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock`. Tests are excluded from `tsc` in these packages, so run `pnpm --filter <pkg> build` as well as the tests.
- **Build before you test across packages.** Workspace packages import each other through `dist/`: each `package.json` `exports` points at `./dist/index.js`, and no vitest config aliases `src`. A test of package B that imports a package A you just changed sees the OLD A until A is rebuilt. So every verify step that crosses a package boundary starts with `pnpm build`, which is the root's incremental `tsc --build`. The commands below already do this.

## Review Focus

1. **An operator turned reflection on by re-sending the seed prompt through `routines:upsert-default`.** That gives the row a real `spec_hash` with an unchanged prompt. Expected: v21 still swaps the prompt and keeps the operator's hash and switch. The test is in Task 7.
2. **An operator customized the reflection prompt.** Expected: v21 leaves the row byte-identical, with `updated_at` unchanged. The test is in Task 7.
3. **A pass failed or was cut off after an earlier pass completed.** Expected: the prompt shows the completed pass's date, not the failed one's and not `never`. The test is in Task 5.
4. **A webhook payload carries the text `{{lastCompletedRun}}` or a `lastCompletedRun` field.** Expected: neither changes the host value, and payload text is never re-rendered. The test is in Task 5.
5. **A deployment has no memory export volume.** Expected: the host boots, there is no export or mount hook, nothing lands in the workspace, recall works, and the pod has no `/memory`. The test is in Task 2 (canary).

---

## File map

| File | Change | Task |
|---|---|---|
| `packages/memory/src/exporter.ts` | volume-only exporter; no `workspace:*` | 1 |
| `packages/memory/src/export-volume.ts` | `syncFactsVolume` returns `{ changed }` | 1 |
| `packages/memory/src/export-paths.ts` | delete dead `FactsChange` | 1 |
| `packages/memory/src/plugin.ts` | `exports.volume` required; manifest; init | 1 |
| `packages/memory/src/__tests__/{exporter,export,export-volume,note-tool,export-paths,rules}.test.ts` | rewrite to the volume | 1 |
| `presets/memory/src/index.ts`, `presets/memory/src/__tests__/{preset,canary}.test.ts` | pass `exports` only with a volume; canary proves no git copy | 2 |
| `packages/core/src/workspace-policy.ts`, `packages/core/src/index.ts`, `packages/core/src/__tests__/workspace-policy.test.ts`, `packages/ipc-core/src/handlers/__tests__/workspace-commit-notify.test.ts` | guard drops the facts subtree | 3 |
| `packages/sandbox-protocol/src/{volume-agent-key.ts,index.ts}`, new `packages/sandbox-protocol/src/__tests__/volume-agent-key.test.ts`, `packages/sandbox-k8s/src/storage-node/sources.ts`, memory src/tests imports, core | move `MEMORY_FACTS_EXPORT_ROOT` | 4 |
| `packages/routines/src/{template.ts,store.ts,fire.ts}`, `packages/routines/src/__tests__/{template,fire}.test.ts` | `{{lastCompletedRun}}` | 5 |
| `packages/routines/src/reflection-prompt.ts`, new `packages/routines/src/reflection-prompt-history.ts`, `packages/skills/src/__tests__/crystallization-canary.test.ts`, `presets/memory/src/__tests__/canary.test.ts` | prompt rewrite and canaries | 6 |
| `packages/routines/src/migrations.ts`, `packages/routines/src/__tests__/{migrations,dual-method-migration}.test.ts` | migration v21 | 7 |
| `deploy/charts/ax-next/values.yaml`, `deploy/GKE.md`, `docs/plans/2026-05-24-current-architecture.md`, new `.claude/memory/patterns/2026-10-30-TASK-991.md` | stale lines (rule 5) | 8 |

Order: 1 → 2 → 3 → 4, and 5 → 6 → 7. Task 8 can go anywhere. The two chains are independent.

---

### Task 1: `@ax/memory` exports facts to the volume only [tier: sensitive]

Needs `security-checklist`: this is the host writer into a volume that sandboxes mount read-only, and it shrinks the plugin's declared capabilities. The exporter's per-agent state machine (`dirty` / `running` / `flush` / `shutdown`) must keep its semantics. You are deleting the git half around it, not changing it.

**Files:**
- Modify: `packages/memory/src/exporter.ts`, `packages/memory/src/export-volume.ts`, `packages/memory/src/export-paths.ts:11-13`, `packages/memory/src/plugin.ts` (config doc ~:364, validation ~:517-528, manifest ~:546-583, init ~:636-677)
- Test: `packages/memory/src/__tests__/exporter.test.ts`, `export.test.ts`, `export-volume.test.ts`, `note-tool.test.ts:644-686`, `export-paths.test.ts:131-134`, `rules.test.ts:343-394`

**Interfaces:**
- Produces:
  - `interface MemoryExportConfig { debounceMs?: number; volume: MemoryVolumeConfig }`. `volume` is now required.
  - `createMemoryExporter(bus: HookBus, config: MemoryExportConfig)` with the same `{ schedule, flush, shutdown }` object. `flush(ctx): Promise<{ changed: boolean }>`.
  - `syncFactsVolume(volume, agentId, desired): Promise<{ changed: boolean }>`. `changed` is true iff a file was written (renamed into place) or unlinked.
  - `createMemoryPlugin({ exports })` throws `PluginError` `invalid-payload` with a message matching `/exports\.volume/` when `exports` is set without `volume`.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing tests**

  In `export.test.ts`, rewrite `makeExportHarness` around a volume. Create a temp `hostRoot`, pass `exports: { debounceMs: 5, volume: { hostRoot, backing: { server: 'nfs.internal', exportPath: '/srv/ax/memory' } } }`, and drop `createWorkspaceGitPlugin` everywhere in the file. `listPaths(ctx?)` walks `join(hostRoot, volumeAgentKey(agentId), ROOT)` and returns `${ROOT}/<relative posix path>`, so existing path assertions keep working. `readText(path, ctx?)` reads `join(hostRoot, volumeAgentKey(agentId), path)`.

  Add these tests:
  ```ts
  it('exports without a volume is refused at construction (TASK-991)', async () => {
    const { createMemoryPlugin } = await import('../plugin.js');
    expect(() => createMemoryPlugin({ exports: {} as never })).toThrowError(/exports\.volume/);
    expect(() => createMemoryPlugin({ exports: { debounceMs: 5 } as never })).toThrowError(/exports\.volume/);
  });
  it('an export-configured plugin calls no workspace hook and registers flush + mounts together', async () => {
    const { createMemoryPlugin } = await import('../plugin.js');
    const { manifest } = createMemoryPlugin({ exports: { volume: { hostRoot: '/tmp/x', backing: { server: 'nfs.internal', exportPath: '/srv/ax/memory' } } } });
    expect(manifest.calls.filter((h) => h.startsWith('workspace:'))).toEqual([]);
    expect(manifest.calls).toContain('memory:facts:scan');
    expect(manifest.registers).toEqual(expect.arrayContaining(['memory:export:flush', 'sandbox:memory-mounts']));
  });
  ```
  Then:
  - Merge `'no volume configured → the hook is not registered'` and `'plugin without exports config registers no flush service'` into one test: `makeMemoryHarness()` with no exports. Both `memory:export:flush` and `sandbox:memory-mounts` reject when called.
  - Delete `'a first export into a workspace that already has commits succeeds…'`. It is git-only, and foreign files are already covered by `export-volume.test.ts` `'removes only known obsolete FactsPaths…'`.
  - Rename `'publishes profile/recent/journal files through the real workspace'` to `'…into the volume'`.
  - Rewrite `'an unchanged projection makes no second apply…'` as `'an unchanged projection returns changed:false'`: first `flush()` gives `changed: true`, second gives `changed: false`, with no `workspace:applied` counting.
  - `'remember schedules an export without a manual flush'` now polls `listPaths()`.
  - In `makeVolumeHarness` and `'a volume sync failure means no mount is returned'`, delete the `createWorkspaceGitPlugin` lines.

  In `exporter.test.ts`, replace `stubWorkspace()` with a stub that registers ONLY `agents:resolve` and `memory:facts:scan`, plus spy services `workspace:list|read|apply` that push into `st.workspaceCalls`. Add a temp `hostRoot`, give every exporter `volume: { hostRoot, backing: {…} }`, and read results from `join(hostRoot, volumeAgentKey(AGENT), MEMORY_FACTS_EXPORT_ROOT, '<file>')`.
  - Delete the git-only tests:
    - `retries a parent-mismatch…`
    - `a non-parent-mismatch apply failure…`
    - `a parent-mismatch retry uses the reported actualParent…`
    - `a first read that exposes a newer version…`
    - the `it.each` `'refuses a malformed workspace read (%s)'` (`:399`)
    - the `it.each` `'refuses a malformed workspace apply reply (%s)'` (`:415`)
    - `refuses when a pinned read reports a different version…`
    - `fails closed when a pinned-listed file is missing on read`
    - `a stale null actualParent…`
  - Keep the `it.each` `'refuses a malformed scan (%s) without a partial export'` (`:219`). Its "nothing published" check becomes "the volume has no agent dir".
  - Adapt every other test to the volume, keeping its name.
    - Rename `'flush publishes the desired files through workspace:apply'` to `'flush writes the projection to the volume, reports changed, and calls no workspace hook'`. It asserts `profile.md`, `recent.md` and `user/2026-09.md` exist under the facts dir, `changed === true`, and `st.workspaceCalls` is `[]`.
    - Rename `'a volume sync failure rejects the flush even after the workspace commit lands'` to `'a volume sync failure rejects the flush'`.
  - Two kept tests act mid-pass through a workspace hook. Move that point into the SCAN stub, because apply and read are never called now:
    - `'a second flush during a pass waits for the dirty pass instead of dropping it'` (`:469`): call `exporter.schedule(ctx)` from inside the FIRST scan instead of from `setApply`. Still expect `scans === 2` and `changed === true`.
    - `'re-resolves access before the volume sync even when nothing changed'` (`:584`): hold the second flush's FIRST scan on a gate (that is after the first `resolveMemoryAccess`). Wait until that scan has been entered, then `st.allowed.clear()`, then release the gate. Expect `forbidden` and `readdir(hostRoot)` to have length 0. You may drop "even when nothing changed" from the name; the re-check now runs before every sync.

  In `export-volume.test.ts`, add `'reports changed only when a file was written or removed'`. The first sync gives `{ changed: true }`. The same `desired` again gives `{ changed: false }`. Dropping one path gives `{ changed: true }`.

  In `note-tool.test.ts` (`describe('a note feeds the derived export')`):
  - `'a valid note lands in the exported projection'` uses a volume harness, expects `flush.changed === true`, and reads `profile.md` from the volume (contains `Osaka`).
  - `'a failed projection does not fail the note or lose the row'` gets a volume whose `hostRoot` is a regular FILE (`writeFile(hostRoot, 'not a dir')`). That makes the sync fail and log `memory_export_failed`. The rest is unchanged.
  - Drop the `createWorkspaceGitPlugin` import.

  In `export-paths.test.ts`, delete the `FactsChange` type test (`:131-134`) and its import.

  `rules.test.ts` is TASK-989's file. Skip this if it no longer exists. In `'a note, an observer turn and an export leave the stored bytes untouched'`, drop `exports: { debounceMs: 5 }` and the `MEMORY_EXPORT_FLUSH_HOOK` call, and rename it to `'a note and an observer turn leave the stored bytes untouched'`. The exporter can no longer reach the workspace at all. Remove the unused import.

- [ ] **Step 2: Run the tests to verify they fail**

  Run: `pnpm --filter @ax/memory exec vitest run src/__tests__/export.test.ts src/__tests__/exporter.test.ts src/__tests__/export-volume.test.ts src/__tests__/note-tool.test.ts`
  Expected: FAIL. The construction refusal is not thrown, `calls` still contains `workspace:list`, `syncFactsVolume` returns `undefined`, and the exporter still calls `workspace:*`.

- [ ] **Step 3: Implement**
  - `export-volume.ts`: track `changed` in `syncFactsVolume`. Set it after a successful `fs.rename(tmp, target)` and after `fs.unlink(entryPath)`, and return `{ changed }`. Touch nothing else in that file. Its confinement checks are the security boundary.
  - `exporter.ts`: delete `WORKSPACE_*_HOOK`, `MAX_ATTEMPTS`, `listPaths`, `readFile`, `collectExisting`, `readBaseline`, and the parent-mismatch loop in `runPass`. Also delete the now-unused imports (`createHash`, `MEMORY_FACTS_EXPORT_ROOT`, `Workspace*` types, `FactsChange`, `parseFactsPath`). One pass is now: `resolveMemoryAccess` → `scanAll` → `buildFactsExport` → `resolveMemoryAccess` (re-check before publishing, as today) → `return syncFactsVolume(config.volume, ctx.agentId, desired)`. `runPass` is that pass with no retry. A failure is logged by the existing `fail()` and retried by the next schedule or flush. Keep `schedule`, `ensureRunning`, `flush`, `shutdown` and `scanAll` exactly as they are.
  - `export-paths.ts`: delete the `FactsChange` type. It has no users left.
  - `plugin.ts`:
    - Give `MemoryPluginConfig.exports` a doc comment: "Writes each agent's facts as files to the memory volume (`/memory` in runners) — the only file view of facts — and registers `memory:export:flush` and `sandbox:memory-mounts`. Without it there is no file view; recall is unaffected."
    - Validation: after the object check, if `exportsCfg !== undefined && exportsCfg.volume === undefined`, throw `new PluginError({ code: 'invalid-payload', plugin: PLUGIN_NAME, message: 'exports.volume is required: the facts export is written only to the memory volume' })`. Then call `validateVolumeConfig(exportsCfg.volume)` whenever `exportsCfg` is set.
    - Manifest `registers`: `...(exportsCfg !== undefined ? [MEMORY_EXPORT_FLUSH_HOOK, 'sandbox:memory-mounts'] : [])`.
    - Manifest `calls`: replace the nested ternary with two lines, so TASK-989 can delete the second one cleanly:
      ```ts
      ...(exportsCfg !== undefined ? [FACTS_SCAN_HOOK] : []),
      ...(config.rules === true ? ['workspace:read', 'workspace:apply'] : []),
      ```
    - In the manifest comment above `calls`, change "plus the export projection's four when `exports` is configured (TASK-494)" to "plus `memory:facts:scan` when `exports` is configured (the volume export, TASK-991)".
    - `init`: register `sandbox:memory-mounts` whenever `exporter !== undefined`, and drop the redundant `exportsCfg?.volume !== undefined` check.

- [ ] **Step 4: Run the tests to verify they pass**

  Run: `pnpm --filter @ax/memory build && pnpm --filter @ax/memory test`
  Expected: PASS with no type errors.

  Then: `grep -n "workspace:" packages/memory/src/exporter.ts packages/memory/src/export-volume.ts packages/memory/src/export-paths.ts`
  Expected: no output.

- [ ] **Step 5: Commit**

  `git commit -m "[TASK-991] @ax/memory: facts export written only to the memory volume"`, staging the files above.

---

### Task 2: the memory preset passes `exports` only with a volume; the canary proves there is no git copy [tier: integration]

**Files:**
- Modify: `presets/memory/src/index.ts:44-50` (doc) and `:173-182` (plugin config)
- Test: `presets/memory/src/__tests__/preset.test.ts:116-117`, `presets/memory/src/__tests__/canary.test.ts:1321-1336` (with-volume flush test), `:1764-1767` (comment), `:1777-1804` (no-volume test)

**Interfaces:**
- Consumes (Task 1): `exports: { volume }` is required when set, and without `exports` neither `memory:export:flush` nor `sandbox:memory-mounts` is registered.

- [ ] **Step 1: Write the failing tests**
  - `preset.test.ts` (`'builds, and @ax/memory does not register sandbox:memory-mounts'`): replace the comment and assertion with
    ```ts
    // No volume, no file view of facts (TASK-991): neither export hook is registered.
    expect(memory?.manifest.registers).not.toContain('memory:export:flush');
    ```
  - `canary.test.ts`, with-volume test `'flush writes exports under hostRoot; …'`: after the `profileBytes` check, add
    ```ts
    // TASK-991: the volume is the only copy; nothing lands in the agent's workspace.
    const gitCopy = await bus.call<{ path: string }, { found: boolean }>(
      'workspace:read', ctxFor(aliceAgentId, ALICE), { path: 'permanent/memory/facts/profile.md' });
    expect(gitCopy.found).toBe(false);
    ```
  - Canary no-volume describe. Change the comment above it to: "TASK-576/TASK-991: the NFS export volume is optional. Without it the assembly still boots and recall works, but there is no file view of facts anywhere: no export hooks, nothing in the workspace, no /memory mount."
  - Rename the no-volume test to `'boots with no export hooks; remember and recall work; no facts file anywhere; no /memory on the pod'`. Change `expect(bus.hasService('memory:export:flush')).toBe(true)` to `.toBe(false)`, delete the `memory:export:flush` call, and change the `workspace:read` expectation to `expect(read.found).toBe(false)` (drop the `TextDecoder`/`Lisbon` line). Keep the `exportHostRoot`, recall and pod assertions.

- [ ] **Step 2: Run to verify they fail**

  Run: `pnpm build && DOCKER_HOST=… pnpm --filter @ax/preset-memory exec vitest run src/__tests__/preset.test.ts src/__tests__/canary.test.ts`
  Expected: FAIL. With no volume, construction throws `exports.volume` (the preset still passes `exports: {}` to the rebuilt `@ax/memory`).

- [ ] **Step 3: Implement in `presets/memory/src/index.ts`**
  - Replace the `exports:` ternary and its "Always export" comment with
    ```ts
    // The facts export is written only to the memory volume (TASK-991). Without one there is no
    // file view of facts for people or agents; recall and the Memory tab are unaffected.
    ...(config.memoryExportVolume !== undefined ? { exports: { volume: config.memoryExportVolume } } : {}),
    ```
  - Rewrite the `memoryExportVolume` doc to: "The NFS-backed read-only `/memory` view for runners — the only file view of an agent's facts. Optional: without it there is no file view of facts at all (`memory:export:flush` and `sandbox:memory-mounts` are not registered, and runners get no `/memory` mount); recall and the Memory tab still work."

- [ ] **Step 4: Run to verify they pass**

  Run: `pnpm build && DOCKER_HOST=… pnpm --filter @ax/preset-memory test`
  Expected: PASS. This includes `boot-graph.test.ts` `'without the memory export volume'`.

- [ ] **Step 5: Commit**

  `git commit -m "[TASK-991] memory preset: export hooks only with the volume; canary proves no git copy"`

---

### Task 3: the runner-immutable guard drops the facts export subtree [tier: sensitive]

Needs `security-checklist`. This relaxes what a runner-originated commit may contain at the IPC boundary (`workspace.commit-notify`). It is safe only because Tasks 1 and 2 stopped the host from writing that subtree, and nothing reads `permanent/memory/facts/**` from a workspace: no prompt names it, and the Files tab hides `permanent/memory/` (`channel-web/src/server/routes-workspace.ts:2946-2951`). Existing workspaces keep a stale copy until the TASK-995 reset. The agent may now edit or delete it, and nothing trusts it.

**Files:**
- Modify: `packages/core/src/workspace-policy.ts:118-137` (SCOPE comment), `:148` (`RUNNER_IMMUTABLE_PREFIXES`), `:162-180` (function), `packages/core/src/index.ts:43`
- Test: `packages/core/src/__tests__/workspace-policy.test.ts` (imports `:2-10`, describe `:110-164`), `packages/ipc-core/src/handlers/__tests__/workspace-commit-notify.test.ts:868-934`

**Interfaces:**
- Produces: `findRunnerImmutableViolations(changes)` checks `RUNNER_IMMUTABLE_PATHS` only. `RUNNER_IMMUTABLE_PREFIXES` no longer exists. `MEMORY_FACTS_EXPORT_ROOT` stays exported from `@ax/core` until Task 4.

- [ ] **Step 1: Write the failing tests**
  - `workspace-policy.test.ts`: delete `describe('runner-immutable facts-export subtree (TASK-494)')` and the `MEMORY_FACTS_EXPORT_ROOT` / `RUNNER_IMMUTABLE_PREFIXES` imports. In `describe('findRunnerImmutableViolations')`, add
    ```ts
    it('the old facts export path is an ordinary agent path now (TASK-991)', () => {
      expect(findRunnerImmutableViolations([
        put('permanent/memory/facts/profile.md'), del('permanent/memory/facts/user/2026-09.md'),
        put('permanent'), del('permanent/memory'),
      ])).toEqual([]);
    });
    ```
  - `workspace-commit-notify.test.ts`: delete the three refusal tests:
    - `'refuses a runner-originated write under the facts export root (TASK-494)'`
    - `'refuses a delete and a bare-root replacement under the facts export root'`
    - `'refuses a runner write that would replace a reserved ancestor directory'`

    Rename `'leaves neighbouring permanent-memory writes alone'` to `'accepts writes under the old facts export path — the export left the workspace (TASK-991)'`. Its changes become a `put` of `permanent/memory/facts/profile.md`, a `delete` of `permanent/memory/facts/user/2026-09.md`, and a `put` of `permanent/memory/system/user.md`. It still expects `{ accepted: true }` and one `applyBundle` call.

- [ ] **Step 2: Run to verify they fail**

  Run: `pnpm --filter @ax/core exec vitest run src/__tests__/workspace-policy.test.ts && pnpm --filter @ax/ipc-core exec vitest run src/handlers/__tests__/workspace-commit-notify.test.ts`
  Expected: FAIL. The facts paths are still refused.

- [ ] **Step 3: Implement**
  - Delete `RUNNER_IMMUTABLE_PREFIXES` and the `RUNNER_IMMUTABLE_PREFIXES.some(…)` clause in `findRunnerImmutableViolations`, so only `RUNNER_IMMUTABLE_PATHS.has(c.path)` remains.
  - Remove the export from `packages/core/src/index.ts`.
  - Replace the SCOPE paragraph and the paths note (`:118-137`) with:
    ```
    // SCOPE. `system/rules.md` only, not `memory/**`. Under Strata the other
    // `memory/system/` files (`user.md`, `recent.md`, `map.md`) were the AGENT's
    // own memory, regenerated by its consolidator each pass; since Strata's
    // deletion (TASK-608) nothing reads them at all, and @ax/memory injects no
    // file under `memory/` other than `rules.md`. `rules.md` is the one file that
    // is both injected and never rewritten by anything but a person, which is what
    // makes it the durable vector. (The facts export used to be guarded here too,
    // as a host-owned subtree of the workspace. Since TASK-991 it is written only
    // to the read-only `/memory` volume, so `permanent/memory/facts/**` in a
    // workspace is an ordinary agent path.)
    //
    // Paths are posix — the exact shape `walkBundleChanges` emits
    // (`git diff-tree -r --name-status -z` reports repo-relative paths with no
    // `./` prefix), so an exact-set match is the whole comparison. No globs.
    ```
  - Leave `MEMORY_RULES_PATH`, `RUNNER_IMMUTABLE_PATHS` and the rules prose to TASK-989.
  - **Contingency (TASK-989 merged first).** Check `git log origin/main --oneline -- packages/core/src/workspace-policy.ts` now and again at rebase. If `RUNNER_IMMUTABLE_PATHS` is already gone, `findRunnerImmutableViolations` would check nothing after this task. Delete it entirely:
    - its definition and doc in `workspace-policy.ts`;
    - its export in `core/src/index.ts`;
    - in `packages/ipc-core/src/handlers/workspace-commit-notify.ts`, the import, the `immutableHits` refusal branch (~:430-470), and step 6b in the header comment (~:98-102);
    - every remaining test of it in the two test files.

    Never leave a check that can never fire (Half-Wired Code Policy).

- [ ] **Step 4: Run to verify they pass**

  Run: `pnpm build && pnpm --filter @ax/core test && pnpm --filter @ax/ipc-core test`
  Expected: PASS. `@ax/ipc-core` imports the guard from `@ax/core`'s `dist/`, so the build must come first.

- [ ] **Step 5: Commit**

  `git commit -m "[TASK-991] runner-immutable guard: drop the facts export subtree"`

---

### Task 4: move `MEMORY_FACTS_EXPORT_ROOT` to `@ax/sandbox-protocol` [tier: integration]

It is now volume layout only. It sits beside `volumeAgentKey` (the same "memory export mount contract") and leaves `workspace-policy.ts`, which TASK-995 deletes. This is a pure move: same name, same value, no behavior change.

**Files:**
- Modify: `packages/sandbox-protocol/src/volume-agent-key.ts`, `packages/sandbox-protocol/src/index.ts:5`, `packages/sandbox-k8s/src/storage-node/sources.ts:2`, `packages/memory/src/export-paths.ts:2`, `packages/memory/src/export-volume.ts:5`, `packages/core/src/workspace-policy.ts:146`, `packages/core/src/index.ts:41`
- Modify (imports): `packages/memory/src/__tests__/{export,exporter,export-render,export-volume,export-paths,note-tool}.test.ts`. `exporter.test.ts` uses the constant after Task 1. Tests aren't type-checked, so a stale `@ax/core` import only shows up at run time. Several imports span lines, so don't grep for them. Open each file listed here and move the name into an `@ax/sandbox-protocol` import. The Step 4 test run is the check.
- Create: `packages/sandbox-protocol/src/__tests__/volume-agent-key.test.ts`

**Interfaces:**
- Produces: `import { MEMORY_FACTS_EXPORT_ROOT, volumeAgentKey } from '@ax/sandbox-protocol'`, with `MEMORY_FACTS_EXPORT_ROOT = 'permanent/memory/facts' as const` (the literal type is kept: `FactsPath` is built from it). `@ax/core` no longer exports it.

- [ ] **Step 1: Write the failing test** in `volume-agent-key.test.ts`:
  ```ts
  it('pins the facts directory inside an agent\'s slot of the memory export volume', () => {
    // On-disk layout of every existing export: changing it strands them all.
    expect(MEMORY_FACTS_EXPORT_ROOT).toBe('permanent/memory/facts');
  });
  ```

- [ ] **Step 2: Run to verify it fails**

  Run: `pnpm --filter @ax/sandbox-protocol exec vitest run src/__tests__/volume-agent-key.test.ts`
  Expected: FAIL (not exported).

- [ ] **Step 3: Implement**
  - Add the constant to `volume-agent-key.ts` with this doc: "Where each agent's facts live inside its slot of the memory export volume: `<volumeAgentKey(agentId)>/permanent/memory/facts/…`, mounted read-only at `/memory`. The writer (@ax/memory) and the mount resolvers (@ax/sandbox-k8s) share this literal. Historical value (it once mirrored the facts' path in the git workspace, dropped in TASK-991); it is now on-disk layout."
  - Export it from `index.ts`.
  - Switch every import listed under Files from `@ax/core` to `@ax/sandbox-protocol`. Keep `safePath` from `@ax/core` in `export-volume.ts`.
  - Delete it from `workspace-policy.ts` and `core/src/index.ts`.

- [ ] **Step 4: Run to verify it passes**

  Run: `pnpm build && pnpm --filter @ax/sandbox-protocol test && pnpm --filter @ax/memory test && pnpm --filter @ax/sandbox-k8s test && pnpm --filter @ax/core test`
  Expected: PASS. Memory and sandbox-k8s read `@ax/sandbox-protocol` from `dist/`, and `export-paths.test.ts`'s type check reads its `.d.ts`.

  Then: `grep -rn "MEMORY_FACTS_EXPORT_ROOT" packages/core`
  Expected: no output.

- [ ] **Step 5: Commit**

  `git commit -m "[TASK-991] move the memory volume's facts dir constant to @ax/sandbox-protocol"`

---

### Task 5: routines render a host-only `{{lastCompletedRun}}` from their own fire records [tier: sensitive]

Needs `security-checklist`. This edits the routine prompt-rendering path that also carries untrusted webhook payloads (K9 single-pass rule, `template.ts:18-25`), and it puts a host value into a model prompt. The value must come only from `routines_v1_fires`. Never take it from the payload, the routine body, or the model.

**Files:**
- Modify: `packages/routines/src/template.ts`, `packages/routines/src/store.ts` (`RoutinesStore` interface near `recentReports` ~:258, implementation near `recentReports` ~:1676), `packages/routines/src/fire.ts:144` (deps `Pick`) and `:304-308` (non-task branch)
- Test: `packages/routines/src/__tests__/template.test.ts`, `packages/routines/src/__tests__/fire.test.ts`

**Interfaces:**
- Produces:
  - `template.ts`:
    - `export const LAST_COMPLETED_RUN_TOKEN = '{{lastCompletedRun}}'`
    - `export function usesLastCompletedRun(body: string): boolean`
    - `export function renderLastCompletedRun(body: string, lastCompletedRun: Date | null): string`. It replaces every occurrence with a replacer function, not a replacement string. The value is the UTC `YYYY-MM-DD` or `never`.
  - `RoutinesStore.lastCompletedRun(input: RoutineKey & Actor): Promise<Date | null>`: the `fired_at` of the newest fire for `(agentId, routineId)` with `status IN ('ok','silenced')` and `run_as_user_id = actorUserId`, or `null`. Use `orderBy('fired_at','desc').limit(1)` on `routines_v1_fires`. The `routines_v1_fires_by_routine` index serves it.
  - `FireDeps.store` adds `'lastCompletedRun'` to its `Pick`.

- [ ] **Step 1: Write the failing tests**

  In `template.test.ts`, add a `describe('renderLastCompletedRun (TASK-991)')`:
  ```ts
  expect(renderLastCompletedRun('a {{lastCompletedRun}} b {{ lastCompletedRun }}', null)).toBe('a never b never');
  expect(renderLastCompletedRun('last: {{lastCompletedRun}}', new Date('2030-12-28T23:30:00-05:00'))).toBe('last: 2030-12-29'); // UTC date
  expect(usesLastCompletedRun('x {{ lastCompletedRun }}')).toBe(true);
  expect(usesLastCompletedRun('x {{payload.lastCompletedRun}}')).toBe(false);
  expect(renderTemplate('{{lastCompletedRun}}', { payload: { lastCompletedRun: 'x' } })).toBe('{{lastCompletedRun}}'); // the payload pass never fills it
  ```

  In `fire.test.ts` (real Postgres via `fixture()`), first extend `setup()` with the option `lastCompletedRun?: () => Promise<Date | null>`, spread into `store` like `reports`. Then add `describe('the host-supplied last completed run (TASK-991)')`. Seed fires with raw SQL:
  ```sql
  INSERT INTO routines_v1_fires (agent_id, routine_id, fired_at, trigger_source, status, run_as_user_id) VALUES (…)
  ```
  Use agent `'a'`, `h.row.routineId`, and owner `'owner'`. The tests:
  1. `'a prompt that asks for it before any run completed gets "never"'`. The definition is `{ promptBody: 'Last: {{lastCompletedRun}}.' }`. Expect `h.pending.get(h.accepted.reqId)?.renderedPrompt` to be `'Last: never.'`, and the invoked message `content` to be the same.
  2. `'it is the start date of the newest run that finished ok or silenced, as the person the run acts as'`. Seed:
     - ok, 2030-12-20T10:00Z, as owner
     - silenced, 2030-12-28T10:00Z, as owner
     - error, 2030-12-31T10:00Z, as owner
     - silenced, 2030-12-30T10:00Z, as `'someone-else'`
     - silenced, 2030-12-31T09:00Z, for routine `'other'`
     - silenced, 2030-12-31T09:00Z, for agent `'b'`

     Expect `'Last: 2030-12-28.'`.
  3. `'a prompt without the token never reads run history'`. Pass `lastCompletedRun: vi.fn()` and expect it not to have been called. `renderedPrompt` equals the body.
  4. `'a payload can neither supply it nor have its own text rendered as it'`. The body is `'Last: {{lastCompletedRun}}; title: {{payload.title}}'`. Call `h.fire(h.accepted, { title: '{{lastCompletedRun}}', lastCompletedRun: '2099-01-01' })` and expect `renderedPrompt` to be `'Last: never; title: {{lastCompletedRun}}'`.
  5. `'a failed read fails the fire before the agent runs'`. Use `lastCompletedRun: async () => { throw new Error('database unavailable'); }` with the token in the body. Expect `result` to match `{ status: 'error', error: 'database unavailable', renderedPrompt: null }`, `h.invoked` not called, and `recentFires(h.row)` `[{ status: 'error' }]`. Copy the shape of `'a bind failure fails the fire before the agent runs'`.

- [ ] **Step 2: Run to verify they fail**

  Run: `pnpm --filter @ax/routines exec vitest run src/__tests__/template.test.ts` and `DOCKER_HOST=… pnpm --filter @ax/routines exec vitest run src/__tests__/fire.test.ts`
  Expected: FAIL (missing exports; token left literal).

- [ ] **Step 3: Implement**
  - `template.ts`: add the three exports. Extend the file doc: "One host value, never from the payload: `{{lastCompletedRun}}` (TASK-991), filled by `fire.ts` from this routine's own fire records BEFORE the payload pass, so payload text can't produce or re-render it." Leave `renderTemplate` and `TEMPLATE_RE` unchanged.
  - `store.ts`: add `lastCompletedRun` with this doc: "TASK-991. The start of this routine's newest run that finished `ok` or `silenced` as `actorUserId` — TASK-936's rule, so an earlier owner's runs never count — or null. A run that failed or was cut off (`error`, including the sweep's `RUN_INTERRUPTED`) never counts."
  - `fire.ts`, non-task branch:
    ```ts
    let body = row.promptBody;
    if (usesLastCompletedRun(body)) {
      try {
        body = renderLastCompletedRun(body, await deps.store.lastCompletedRun({ agentId: row.agentId, routineId: row.routineId, actorUserId: row.ownerUserId }));
      } catch (err) { return fail(err); }
    }
    prompt = payload !== undefined ? renderTemplate(body, { payload }) : body;
    ```
    Add a comment saying the host value is rendered first and why (see template.ts). Add `'lastCompletedRun'` to the `FireDeps.store` `Pick` and to its doc sentence.
  - If any test builds a hand-written `FireDeps.store` fake that lacks the method, add `lastCompletedRun: async () => null`. Tests are not type-checked, and it is only called when a prompt has the token.

- [ ] **Step 4: Run to verify they pass**

  Run: `pnpm --filter @ax/routines build && DOCKER_HOST=… pnpm --filter @ax/routines test`
  Expected: PASS.

- [ ] **Step 5: Commit**

  `git commit -m "[TASK-991] routines: host-rendered {{lastCompletedRun}} from the routine's own fire records"`

---

### Task 6: rewrite the reflection seed prompt (no marker file) and pin it in both canaries [tier: integration]

Needs `security-checklist` (a model-facing prompt). Fold its answers into the PR note from Task 5.

**Files:**
- Modify: `packages/routines/src/reflection-prompt.ts` (doc `:20-24` and `:41-49`, hash `:62`, prompt `:71-73` and `:90-91`)
- Create: `packages/routines/src/reflection-prompt-history.ts`
- Test: `packages/skills/src/__tests__/crystallization-canary.test.ts` (prompt guard `:456-462`, header bullet 4 `:50-53`, a new `it`), `presets/memory/src/__tests__/canary.test.ts:487-491`

**Interfaces:**
- Consumes (Task 5): `LAST_COMPLETED_RUN_TOKEN`, and rendering in `fire.ts`.
- Produces:
  - `SKILL_REFLECTION_SEED_HASH = 'seed-2026-10-30'`
  - `reflection-prompt-history.ts` exports `SKILL_REFLECTION_MARKER_SEED_HASH = 'seed-2026-09-27'` and `SKILL_REFLECTION_MARKER_PROMPT`. The latter is the current `SKILL_REFLECTION_PROMPT` template literal, moved verbatim from `git show HEAD:packages/routines/src/reflection-prompt.ts` lines 67-91. Do not retype it. Its doc: "Frozen — migration input only, never sent to a model. The 2026-09-27 seed (TASK-611), byte for byte: it told the agent to keep `.ax/skill-reflection/last-run.json`. Migration version 21 rewrites a catalog row only while its prompt equals this text. Never edit it."
  - `SKILL_REFLECTION_STRATA_SEED_HASH` stays where it is.

- [ ] **Step 1: Write the failing tests**
  - In the crystallization canary, replace `expect(p).toMatch(/\.ax\/skill-reflection\/last-run\.json/);` and its comment with:
    ```ts
    // TASK-991: no marker file. The host fills {{lastCompletedRun}} from the routine's own run
    // history; the prompt names no file and asks for no write.
    expect(p).toContain('Your last completed reflection pass: {{lastCompletedRun}}.');
    expect(p).toContain('"never" means no pass has completed yet');
    expect(p).not.toMatch(/last-run|\.json\b|\.ax\b/);
    expect(p).not.toMatch(/\bwrite\b/i);
    ```
    Keep the `REFLECTION_DONE` assertions. Add one sentence to header bullet 4: "…and that the prompt names no file and takes its last-pass date from the host (TASK-991)."
  - Add `it('reflection reads its last completed pass from the routine\'s own run history (TASK-991)', …)`:
    - Use `makeFireBus(async () => ({ kind: 'complete', messages: [] }))` and `routines:create` with the same definition as `fireReflection`.
    - Call `routines:fire-now` with requestId `'fire-1'`. `vi.waitFor` until `routines:recent-fires` → `fires[0].status === 'silenced'` (timeout `FIRE_RECORDED_TIMEOUT_MS`). Expect `fires[0].renderedPrompt` to contain `'Your last completed reflection pass: never.'` and not contain `'{{lastCompletedRun}}'`.
    - Call `fire-now` again with `'fire-2'` and the same `expectedRevision`. Wait until there are 2 fires and `fires[0].status === 'silenced'`. Expect `fires[0].renderedPrompt` to contain `` `Your last completed reflection pass: ${fires[1].firedAt.slice(0, 10)}.` ``.
  - In the memory preset canary `'skill-reflection runs the facts-memory prompt and can be turned on (TASK-611)'`, add `expect(def.promptBody).toContain('{{lastCompletedRun}}'); expect(def.promptBody).not.toContain('last-run.json');`.

- [ ] **Step 2: Run to verify they fail**

  Run: `pnpm build && DOCKER_HOST=… pnpm --filter @ax/skills exec vitest run src/__tests__/crystallization-canary.test.ts`
  Expected: FAIL (the prompt still names the marker).

- [ ] **Step 3: Implement**
  - Create `reflection-prompt-history.ts` as specified.
  - **Superseded in review (two rounds):** Step 1 as shipped compares "dated **on or after**" the date (day granularity: strict "after" could stop full passes for good), and counts only rows with a conversation number (a pass's own `-` rows would otherwise re-trigger a full pass daily). `reflection-prompt.ts` is the source of truth; the text below is the original plan.
  - In `SKILL_REFLECTION_PROMPT`, replace Step 1's body and Step 4's body with exactly this text. Steps 2, 3, the intro and Hard limits are unchanged:
    ```
    ## Step 1 — Short-circuit
    Your last completed reflection pass: ${LAST_COMPLETED_RUN_TOKEN}. That date comes from this routine's own run history; "never" means no pass has completed yet. If it says never, go straight to Step 2. Otherwise call the \`memory_recall\` tool with a query such as "procedures, workflows and step-by-step ways of doing things". If no evidence row is dated after that date, you are done: reply with exactly REFLECTION_DONE and stop. Otherwise continue.
    ```
    ```
    ## Step 4 — Finish
    Reply with exactly REFLECTION_DONE.
    ```
    Import `LAST_COMPLETED_RUN_TOKEN` from `./template.js`.
  - Bump `SKILL_REFLECTION_SEED_HASH` to `'seed-2026-10-30'`.
  - Doc fixes (rule 5; the "existing pattern in migrations.ts" pointer is stale). Replace the "Short-circuit marker" bullet (`:22-24`) with: "Last completed pass: the prompt asks for `{{lastCompletedRun}}`; the host fills it from this routine's own fire records (the start date of its newest run that finished ok or silenced) or "never" (TASK-991, `template.ts`). When `memory_recall` shows no evidence dated after it, the pass ends with REFLECTION_DONE. The agent writes no file." Replace the "⚠ Changing this text…" and "Keep the literal…" paragraphs (`:41-49`) with: "⚠ Changing this text does NOT reach an existing deployment by itself: the seed is copied once (`ON CONFLICT DO NOTHING`). Freeze the previous text in `reflection-prompt-history.ts`, add a versioned step in `migrations.ts` that rewrites the catalog row only while its prompt still equals that frozen text (version 21, `refreshReflectionSeed`, is the pattern), and bump `SKILL_REFLECTION_SEED_HASH`. Keep the literal `REFLECTION_DONE` token in sync with the seed's `silence_token` in `migrations.ts` and the crystallization canary in `@ax/skills`."

- [ ] **Step 4: Run to verify they pass**

  Run: `pnpm build && DOCKER_HOST=… pnpm --filter @ax/skills exec vitest run src/__tests__/crystallization-canary.test.ts && DOCKER_HOST=… pnpm --filter @ax/preset-memory exec vitest run src/__tests__/canary.test.ts`
  Expected: PASS. Both canaries import `@ax/routines` from `dist/`, so the new prompt is visible only after the build.

  Then: `grep -n "last-run" packages/routines/src/reflection-prompt.ts`
  Expected: no output (the frozen copy lives only in `reflection-prompt-history.ts`).

  `migrations.test.ts`'s fresh-seed test still passes, because it compares against the live constants.

- [ ] **Step 5: Commit**

  `git commit -m "[TASK-991] skill-reflection prompt: host-supplied last-pass date, no marker file"`

---

### Task 7: migration v21 swaps the untouched 2026-09-27 seed [tier: sensitive]

This rewrites stored rows in every deployment, so it is hard to reverse. Only the prompt and the seed hash move.

**Files:**
- Modify: `packages/routines/src/migrations.ts` (imports `:1-8`; runner after `done(20)` `~:405-409`; a new helper next to the other version helpers)
- Test: `packages/routines/src/__tests__/migrations.test.ts` (every `[2, …, 20]` list becomes `[2, …, 21]`, plus new cases), `packages/routines/src/__tests__/dual-method-migration.test.ts:61-62` (the genuine-v14 catalog equality WILL break, so change it)

**Interfaces:**
- Consumes (Task 6): `SKILL_REFLECTION_PROMPT`, `SKILL_REFLECTION_SEED_HASH`, `SKILL_REFLECTION_ROUTINE_NAME`, `SKILL_REFLECTION_MARKER_PROMPT`, `SKILL_REFLECTION_MARKER_SEED_HASH`.
- Produces: `async function refreshReflectionSeed(db: Kysely<RoutinesDatabase>): Promise<void>` (module-private), run as version 21.

- [ ] **Step 1: Write the failing tests** in `migrations.test.ts`
  - A helper `reflection()` reads the `skill-reflection` row of `default_routines_v1`. Each case runs `runRoutinesMigration(db)`, sets the row with SQL, runs `DELETE FROM routines_schema_versions WHERE version = 21`, runs `runRoutinesMigration(db)` again, and asserts:
    1. `'version 21 swaps the untouched 2026-09-27 reflection seed and moves its seed hash (TASK-991)'`. Set `prompt_body=MARKER_PROMPT, spec_hash=MARKER_SEED_HASH, updated_at='2020-01-01T00:00:00Z'`. Expect `prompt_body === SKILL_REFLECTION_PROMPT`, `spec_hash === SKILL_REFLECTION_SEED_HASH`, `updated_at > 2020-01-01`, and `versions()` ending in 21. The sentinel must be in the PAST: the container's `now()` is real time.
    2. `'version 21 swaps a re-sent seed but keeps the operator\'s hash and switch'`. Set `prompt_body=MARKER_PROMPT, spec_hash='h_operator', enabled=true`. Expect the new prompt, `spec_hash === 'h_operator'`, and `enabled === true`.
    3. `'version 21 leaves an edited prompt alone'`. Set `prompt_body='my prompt', spec_hash=MARKER_SEED_HASH, updated_at='2020-01-01T00:00:00Z'`. Expect all three unchanged.
  - Change every `versions()` expectation from `…, 19, 20]` to `…, 19, 20, 21]`. A replace-all on `18, 19, 20]` covers all of them, including the wrapped one near `:205`.
  - In `dual-method-migration.test.ts`, `'replaces exclusive authored columns while preserving every legacy method and identity'` (`:61-62`) asserts that the genuine-v14 catalog comes through the migration unchanged: `expect(jsonValue(defaults)).toEqual(frozen.defaults)`. v21 rewrites the reflection row, so that assertion must change. This is also the proof that the frozen constant is byte-identical to what deployments hold. (Checked: the fixture's prompt equals the current `SKILL_REFLECTION_PROMPT`, 2901 chars.) Replace it with:
    ```ts
    // TASK-991 (v21): only the genuine 2026-09-27 reflection seed moves (prompt, seed hash, updated_at).
    const frozenReflection = frozen.defaults.find((d: { name: string }) => d.name === 'skill-reflection');
    expect(frozenReflection.prompt_body).toBe(SKILL_REFLECTION_MARKER_PROMPT);
    expect(jsonValue(defaults)).toEqual(frozen.defaults.map((d: Record<string, unknown>) => d.name !== 'skill-reflection' ? d
      : { ...d, prompt_body: SKILL_REFLECTION_PROMPT, spec_hash: SKILL_REFLECTION_SEED_HASH, updated_at: expect.any(String) }));
    ```
    Import the three constants. `'runs twice without rewriting … catalog defaults …'` (`:132`) still holds: v21 runs once, and the second run is a no-op.

- [ ] **Step 2: Run to verify they fail**

  Run: `DOCKER_HOST=… pnpm --filter @ax/routines exec vitest run src/__tests__/migrations.test.ts src/__tests__/dual-method-migration.test.ts`
  Expected: FAIL (no version 21).

- [ ] **Step 3: Implement**
  - Add `if (!await done(21)) { await refreshReflectionSeed(trx); await sql\`INSERT INTO routines_schema_versions(version) VALUES(21)\`.execute(trx); }` to `runRoutinesMigration`.
  - The helper runs:
    ```sql
    UPDATE default_routines_v1
       SET prompt_body = ${SKILL_REFLECTION_PROMPT},
           spec_hash = CASE WHEN spec_hash = ${SKILL_REFLECTION_MARKER_SEED_HASH} THEN ${SKILL_REFLECTION_SEED_HASH} ELSE spec_hash END,
           updated_at = now()
     WHERE name = ${SKILL_REFLECTION_ROUTINE_NAME} AND prompt_body = ${SKILL_REFLECTION_MARKER_PROMPT}
    ```
  - Doc for the helper: "Version 21 (TASK-991). The 2026-09-27 reflection seed told the agent to keep a marker file; the host now supplies the last completed pass date (`{{lastCompletedRun}}`). Rewrites the catalog row only while its prompt is still exactly that seed. Turning reflection on means re-sending the whole definition through `routines:upsert-default`, which replaces `spec_hash` with a real hash, so the match is on the prompt, not the hash: a re-sent, unedited seed is swapped; an edited prompt is left alone. An untouched seed's hash moves to the new seed hash; an operator's stays. `updated_at` moves so `refreshStale` re-copies the prompt into every agent's materialized row (defaults.test.ts pins that). Agent-authored copies of the prompt are theirs and are not touched."

- [ ] **Step 4: Run to verify they pass**

  Run: `DOCKER_HOST=… pnpm --filter @ax/routines test && pnpm --filter @ax/routines build`
  Expected: PASS.

- [ ] **Step 5: Commit**

  `git commit -m "[TASK-991] routines migration v21: swap the untouched 2026-09-27 reflection seed"`

---

### Task 8: fix the stale lines that say facts are exported into the workspace [tier: mechanical]

**Files:**
- Modify: `deploy/charts/ax-next/values.yaml:64-66` and `:750-758`, `deploy/GKE.md:688-690`, `docs/plans/2026-05-24-current-architecture.md:572-573`
- Create: `.claude/memory/patterns/2026-10-30-TASK-991.md` (path from `scripts/memory-write-target.sh --shard patterns TASK-991`)

- [ ] **Step 1: Edit the docs**
  - `values.yaml:64-66` (host comment): "`memory.exports` (an NFS export) is OPTIONAL — set it to give runner pods a read-only `/memory` view of each agent's facts, the only file view of them; leave it empty and recall and the Memory tab still work."
  - `values.yaml:750-758`: replace "Empty means runners get no `/memory` mount; recall and the Memory tab still work, and each agent's facts are still exported into its workspace." with "Empty means no file view of facts anywhere: runners get no `/memory` mount and nothing is written into agents' workspaces; recall and the Memory tab still work." Also change the opening line to "OPTIONAL NFS export the host writes each agent's facts to, as files — the only file view of them". Leave the rest unchanged.
  - `GKE.md:688-690`: "Both-or-neither: leave both empty and facts memory still renders and runs (there's just no file view of facts: runners get no `/memory` mount); set only one and …" (rest unchanged).
  - `current-architecture.md:572-573`: "The NFS export volume (the runner's read-only `/memory` view) is optional and is the only file view of facts; without it there is none, and recall still works."
- [ ] **Step 2: Write the patterns shard** (create the directory first). Add one row superseding `.claude/memory/patterns.md:605`'s marker contract. Skill-reflection no longer short-circuits on `.ax/skill-reflection/last-run.json`. The host renders `{{lastCompletedRun}}` (`routines/src/template.ts`) from the routine's own fire records: ok or silenced, run as the current owner, UTC date, or `never`. A routine prompt change ships as a frozen previous text plus a versioned migration keyed on prompt equality (v21).
- [ ] **Step 3: Verify**

  Run: `grep -rn "exported into its workspace\|exported into the workspace" deploy docs/plans/2026-05-24-current-architecture.md`
  Expected: no output. `-r` is required, or `deploy/` is never searched.

  Run: `pnpm --filter @ax/chart-tests test`
  Expected: PASS (comments only).
- [ ] **Step 4: Commit**

  `git commit -m "[TASK-991] docs: no file view of facts without the memory volume"`

---

## Final verification (before the PR)

```bash
pnpm build
pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts   # with DOCKER_HOST set
pnpm lint
grep -rn "workspace:" packages/memory/src/exporter.ts packages/memory/src/export-volume.ts   # expect nothing
grep -n "last-run" packages/routines/src/reflection-prompt.ts                                # expect nothing (the live prompt)
grep -rn "skill-reflection/last-run" packages/routines/src packages/skills/src presets --include='*.ts' | grep -v reflection-prompt-history.ts   # expect nothing (out of scope: workspace-git-core's retire-routine-files test, deleted by TASK-995)
```

## PR body notes

- **Boundary review: not required.** No service-hook signature changes. `memory:export:flush` keeps `{} → { changed }`. It is now registered only with a volume, together with `sandbox:memory-mounts`, and `changed` now means "the volume changed". `{{lastCompletedRun}}` is a prompt-template token, not a hook, and the store read is internal. The kernel API changed: `@ax/core` no longer exports `MEMORY_FACTS_EXPORT_ROOT` or `RUNNER_IMMUTABLE_PREFIXES`, and `@ax/sandbox-protocol` exports `MEMORY_FACTS_EXPORT_ROOT`.
- **Security note (security-checklist, required).** Cover:
  - Task 3: the guard relaxation is safe because the host no longer writes that subtree and nothing reads it as trusted.
  - Task 1: capability reduction. `@ax/memory` drops `workspace:list/read/apply` for exports.
  - Tasks 5 and 6: the date is host-only, fixed-format, rendered before the payload, and absent for task runs. The model can no longer write a future date into a marker to skip passes.
  - Supply chain: no new dependency.
- **Deploy note.** No operator action. Existing workspaces keep a stale `permanent/memory/facts/**` copy until the TASK-995 reset; nothing reads it. A customized reflection prompt keeps its marker instructions. The operator can edit it to use `{{lastCompletedRun}}`.
