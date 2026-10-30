# TASK-994 — Agent files: replacement security guards + SDK transcripts to /tmp/transcripts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the design's four §11 security guards into tests and startup checks that fail when their protection is removed. Move the Claude SDK's transcript working copy from `/agent` to a pod-private directory. Make `delete_user.sh` delete agents through the host, so that `agents:deleted` fires.

**Architecture:**
- **Startup guard.** A runner-core guard refuses to boot unless `CLAUDE_CONFIG_DIR` meets all of these:
  - it is set;
  - it is absolute;
  - it exists;
  - after realpath, it does not overlap the agent's home.
- **Side files.** That same guard keeps the SDK's side files out of `/files`. They already follow `CLAUDE_CONFIG_DIR` (measured, see below).
- **Transcript location.** The claude-sdk runner gets a small `transcript-dir` module:
  - When the sandbox stamps `AX_TRANSCRIPTS_ROOT`, the transcripts live there, and `$CLAUDE_CONFIG_DIR/projects` is a symlink to it. k8s stamps `/tmp/transcripts`, and the warm-pool allowlist pins that value.
  - Otherwise the transcripts live in the SDK's own `$CLAUDE_CONFIG_DIR/projects`. Under the subprocess sandbox, that is already a per-session temp directory.
- **Proof.** Real-binary e2e tests prove four things: planted canary files have no effect; HOME stays empty; transcripts go where we say; resume works. Each check has a control in the suite that shows it fails when the protection is removed.
- **`delete_user.sh`.** It calls the existing `DELETE /admin/agents/:id` route from inside the host pod.

**Tech Stack:** TypeScript (Node ESM), vitest 5, `@anthropic-ai/claude-agent-sdk` 0.2.119 (pinned; native `claude` binary), bash, and plain-JS vitest under `scripts/__tests__` (`pnpm test:scripts`).

**Spec:** the card body (builder scratchpad `ship/TASK-994.md`) and `docs/plans/2026-10-29-agent-files-simplification-design.md` §3, §4, §8 and §11. Decisions: `.claude/memory/decisions/2026-10-30-TASK-994.md`.

---

## What the planner measured (read before Task 1)

The planner ran a probe against the pinned native CLI (`query()` from the SDK, with a local scripted Anthropic server and no network). The layout: HOME = cwd = `files/`; `CLAUDE_CONFIG_DIR` = a separate `runner-home/.ax/session`; `settingSources: ['user']`.

1. **The side files don't land in HOME.**
   - After a text turn and after a Bash turn, `files/` was empty.
   - `.claude.json`, `backups/`, `projects/`, `sessions/`, `session-env/` and `shell-snapshots/` were all in `CLAUDE_CONFIG_DIR`.
   - The reason: the CLI resolves its global config as `join(CLAUDE_CONFIG_DIR || homedir(), '.claude.json')`.
   - The main.ts comment at `:402-407` and `:421-422` is stale. It predates the Phase 0 `CLAUDE_CONFIG_DIR` forward. Design §11 copied the claim from it.
2. **One HOME write remains: the CLI's env-paths cache (MCP logs).**
   - It is written whenever any MCP server is configured, and main.ts always configures two.
   - Linux: `${XDG_CACHE_HOME:-~/.cache}/claude-cli-nodejs/<cwd-slug>/mcp-logs-<server>/`. In production, `buildToolCacheEnv` sets `XDG_CACHE_HOME` to the scratch tier, so nothing lands in `/files`.
   - macOS: `~/Library/Caches/claude-cli-nodejs/...` regardless of XDG. A local CLI on a Mac therefore gets `Library/` in `/files`. This is accepted for dev only (see decisions).
3. **Canary.** I planted `.ax/SOUL.md`, `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/settings.json` (SessionStart, UserPromptSubmit and Stop hooks that `touch` markers), `.mcp.json` (a stdio server that `touch`es a marker), `.claude.json` (a user-scope stdio server) and `.claude/skills/canary-skill/SKILL.md` in HOME = cwd:
   - **Production config:** none had any effect. No text reached a request, no marker appeared, `mcp_servers` was `[]`, and `canary-skill` was absent from init `skills`.
   - **`settingSources: ['user','project']`:** the `CLAUDE.md` text reached the request, all three hooks ran, and the `.mcp.json` server was spawned.
   - **`CLAUDE_CONFIG_DIR` unset:** the hooks ran, the `.claude.json` server was spawned, the `.claude/CLAUDE.md` text reached the request, and `canary-skill` loaded. HOME also gained `.claude/{backups,projects,sessions,session-env}`.
   - **`CLAUDE_CONFIG_DIR = files/.claude`:** the hooks ran, `.claude/CLAUDE.md` reached the request, and `canary-skill` loaded.

## Card and brief claims that turned out wrong (and the fix)

| Claim | Reality | In this plan |
|---|---|---|
| "The SDK's side files … today land in its HOME (main.ts ~:402)" | Not while `CLAUDE_CONFIG_DIR` is set, and it always is (k8s `pod-spec.ts:642`, pinned in `bootstrap.ts`; subprocess `open-session.ts:307,542`). | Nothing to move. The guard plus the e2e keep it that way. Task 3 fixes the comments and Task 9 the design line. |
| "Test: `settingSources === ['user']`" (as new work) | It already exists: `main.test.ts:673`, `:1067`, `:4242`, `:4873`. | No duplicate. The §11 canary (Task 6) re-asserts it, and Task 10 shows the mutation. |
| "…plus `proxy-startup.ts`, take a transcript directory" | `proxy-startup.ts` has no transcript code. It only has a stale comment (`:117-137`). | Comment fix (Task 3). |
| "Making `/files` the SDK cwd is TASK-995" | cwd is already `runnerHomeDir(env)`, which is `/files` whenever `AX_USERFILES_ROOT` is wired (TASK-164). TASK-992 and TASK-995 only remove the fallback. | The canary plants in HOME = cwd = files, which is the production shape now and after TASK-995. |
| "Tool caches and venvs go to `/tmp` (`buildToolCacheEnv`)" | They go to `AX_EPHEMERAL_ROOT`. Both providers always set it, and it is never `/files`. Moving it to `/tmp` is the `/ephemeral` merge in TASK-995. | No change (see decisions). |
| `delete_user.sh` "raw SQL" (implied: it works) | It is kind-only. Its routines statements use renamed columns, and everything runs in one `ON_ERROR_STOP` transaction, so today it most likely deletes nothing. | Task 8 rewrites it, drops the broken routines lines, and records the team-agent routines gap. |
| Design §4 "overlap refusal … pod-spec ~:528-548" | It is at `pod-spec.ts:561-586`. | Not this card's line, so not touched. |

## Global Constraints

- Transcript root in k8s: `/tmp/transcripts` (the pod-private, disk-backed `/tmp` emptyDir). Subprocess and local CLI: a per-session directory under the sandbox's own temp root — never a shared host `/tmp/transcripts`.
- k8s `CLAUDE_CONFIG_DIR` is `/home/runner/.ax/session`, already pinned in the pool bootstrap allowlist. Don't change it.
- `settingSources` stays `['user']`.
- The DB stays the transcript source of truth. `shipTranscriptDelta` and `restoreTranscriptForResume` must not change.
- Out of scope (sibling cards; don't pre-empt them):
  - TASK-995: deleting `git-workspace.ts`, the git tier, `/agent`, `.ax/`, the `workspace:*` hooks or the pre-apply vetoes.
  - TASK-992: chart, presets, blob root, kind NFS, the required durable home.
  - TASK-989: identity, Instructions, prompt-engine.
  - TASK-991: facts export.
  - In the shared files `pod-spec.ts` and `main.ts`, keep the diff to the lines named here.
- Commands — `--filter` goes before the script:
  - one package: `pnpm --filter @ax/<pkg> test`;
  - full gate: `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts && pnpm lint`;
  - run tsc as well as vitest, because tsc excludes test files.
- `delete_user.sh`:
  - keep `ctx=kind-ax-next-dev`;
  - every line that mentions kubectl must read `kubectl --context "$ctx" …`, which `scripts/__tests__/kind-tooling-pinned-to-kind-context.test.js:761-797` enforces;
  - never add a `kubectl` mention to a non-comment line any other way.
- Memory:
  - only shards, never root archives;
  - any backticked rooted repo path in a shard must be a tracked file (`scripts/__tests__/memory-cited-paths-exist.test.js`).
- Error copy for security refusals is direct, with no jokes (CLAUDE.md voice rules).

## Review Focus

1. **A relative or `~`-prefixed `CLAUDE_CONFIG_DIR`** (`.claude`, `~/.claude`). The SDK resolves it against its cwd, which is the agent's home, so the runner must refuse it rather than realpath it against its own cwd. Test: Task 1 env tests.
2. **An agent home that is itself a symlink, or whose realpath differs** (an NFS mount, macOS `/var` → `/private/var`). Compare realpaths on both sides. Test: Task 1, case "home is a symlink".
3. **A legitimate `CLAUDE_CONFIG_DIR` with a trailing slash, or a sibling sharing a name prefix** (`/files-cfg` next to `/files`). Accept it; don't false-refuse. Test: Task 1, cases "trailing slash" and "prefix sibling".
4. **An email with a quote or SQL metacharacters in `delete_user.sh`** (`o'brien+x@example.com`). Pass it as a psql variable, never spliced into SQL. Test: Task 8 "never splices the email".
5. **The host refuses or fails one agent delete** (cookie drift → 401, host restarting → 503, agent already gone → 404). The script stops before any raw SQL and removes the session it minted. Test: Task 8 "stops before any SQL".

## YAGNI pass — what was cut

- **Code that moves the SDK's side files:** cut. There is nothing to move (measured).
- **Stamping `AX_TRANSCRIPTS_ROOT` in the subprocess sandbox:** cut. The fallback is already per-session.
- **Re-pointing `buildToolCacheEnv` at `/tmp`:** cut. That belongs to TASK-995.
- **Fixing the routines SQL in `delete_user.sh`:** cut. The statements are dropped, with a comment.
- **A host-side `CLAUDE_CONFIG_DIR` requirement in the pool bootstrap schema:** cut. Pod-spec stamps the value and `fixedPaths` pins it.
- **A second `settingSources` test:** cut. Four already exist.
- **A HOME≠cwd canary variant:** cut. HOME and cwd are the same directory in production, now and after TASK-995.
- **Plants under `additionalDirectories`:** cut. Out of the card's scope.
- **`isDirectory` checks in the guard:** cut. The SDK fails loudly on its own.
- **Hardening the transcript reader against symlinks:** cut. An agent that can plant a symlink can already read the runner's `/proc` through Bash, so the exposure is no different from `/agent` today. The security note records this.

Kept: one task per §11 guard and §8 bullet; target-based transcript writes (they remove an ordering hazard); the e2e controls (they are the "fails when protection is removed" evidence).

Tiers: 2 mechanical (7, 9), 4 integration (2, 3, 6, 10), 4 sensitive (1, 4, 5, 8). `security-checklist` is required for 1, 4 and 8; Tasks 5 and 6 are its evidence.

## File structure

| File | Responsibility | Task |
|---|---|---|
| `packages/agent-runner-core/src/env.ts` | `RunnerEnv.claudeConfigDir` (required, absolute) and `transcriptsRoot?` (absolute) | 1, 3 |
| `packages/agent-runner-core/src/config-dir-guard.ts` (new) | `assertConfigDirOutsideAgentHome` | 1 |
| `packages/agent-runner-core/src/run-runner.ts` | Call the guard first. Doc and comment fixes. | 1, 3 |
| `packages/agent-claude-sdk-runner/src/jsonl-transcript-source.ts`, `turn-end-uuid.ts` | Readers and writer take a transcript directory. One `locateJsonl`. | 2 |
| `packages/agent-claude-sdk-runner/src/transcript-dir.ts` (new) | `sdkTranscriptDir`, `prepareTranscriptDir` (symlink logic moved here) | 3 |
| `packages/agent-claude-sdk-runner/src/main.ts` | Wiring and comment sweep | 2, 3 |
| `packages/agent-runner-core/src/git-workspace.ts`, `src/index.ts` | Remove `scaffoldSdkProjectsSymlink` | 3 |
| `packages/sandbox-k8s/src/pod-spec.ts`, `packages/sandbox-protocol/src/bootstrap.ts` | Stamp and pin `AX_TRANSCRIPTS_ROOT=/tmp/transcripts` | 4 |
| `packages/agent-claude-sdk-runner/src/__tests__/agent-files-guards-real-sdk.e2e.test.ts` (new) | Real-binary e2e: HOME stays empty, transcripts, resume, canary, controls | 5 |
| `packages/agent-claude-sdk-runner/src/__tests__/main.test.ts` | Runner-level refusals, wiring, canary | 1, 2, 3, 6 |
| `packages/tool-artifact-publish/src/__tests__/path-allowlist.test.ts`, `packages/agent-runner-core/src/__tests__/artifact-publish-executor.test.ts` | `/memory` refused | 7 |
| `delete_user.sh`, `scripts/delete-user-agents.mjs` (new), `scripts/__tests__/delete-user*.test.js` (new) | Host-routed agent delete | 8 |
| `docs/plans/2026-10-29-agent-files-simplification-design.md`, `packages/sandbox-subprocess/SECURITY.md`, memory shards | Stale prose | 9 |

Dependency order: 1 → 2 → 3 → 4 → 5 → 6. Tasks 7 and 8 are independent. Task 9 runs after Task 3. Task 10 runs last.

---

### Task 1: `CLAUDE_CONFIG_DIR` startup guard [tier: sensitive] [security-checklist]

**Files:**
- Modify: `packages/agent-runner-core/src/env.ts` (the `RunnerEnv` interface, `readRunnerEnv`)
- Create: `packages/agent-runner-core/src/config-dir-guard.ts`
- Modify: `packages/agent-runner-core/src/run-runner.ts:406-422` (insert the guard between `readEnv()` and `seams.createTranscriptSource(env)`)
- Test:
  - `packages/agent-runner-core/src/__tests__/env.test.ts`
  - `packages/agent-runner-core/src/__tests__/config-dir-guard.test.ts` (new)
  - `packages/agent-runner-core/src/__tests__/run-runner.test.ts`
  - `packages/agent-claude-sdk-runner/src/__tests__/main.test.ts`

**Interfaces:**
- Produces:
  - `RunnerEnv.claudeConfigDir: string` — required and absolute, read from `CLAUDE_CONFIG_DIR`.
  - `assertConfigDirOutsideAgentHome(env: Pick<RunnerEnv, 'claudeConfigDir' | 'userFilesRoot' | 'ephemeralRoot' | 'workspaceRoot'>): Promise<void>` — throws an `Error` whose message starts with `refusing to start: CLAUDE_CONFIG_DIR`.

- [ ] **Step 1: Write the failing env tests.** Add `CLAUDE_CONFIG_DIR: '/home/runner/.ax/session'` to `PROXY_TCP` and `PROXY_UNIX`. Add `'CLAUDE_CONFIG_DIR'` to the `MissingEnvError` loop (`:133-150`). Then add:

```ts
it('reads claudeConfigDir from CLAUDE_CONFIG_DIR', () => {
  expect(readRunnerEnv({ ...PROXY_TCP }).claudeConfigDir).toBe('/home/runner/.ax/session');
});
it.each(['.claude', '~/.claude', 'home/.ax/session'])(
  'rejects a relative CLAUDE_CONFIG_DIR %j — it would resolve against the SDK cwd (the agent home)', (v) => {
    expect(() => readRunnerEnv({ ...PROXY_TCP, CLAUDE_CONFIG_DIR: v })).toThrow(InvalidEnvError);
    expect(() => readRunnerEnv({ ...PROXY_TCP, CLAUDE_CONFIG_DIR: v })).toThrow(/CLAUDE_CONFIG_DIR/);
  });
```

- [ ] **Step 2: Write the failing guard tests** in `config-dir-guard.test.ts`. Use real dirs under `fs.mkdtemp(path.join(os.tmpdir(), 'ax-cfg-guard-'))`, removed in `afterEach`. Let `home = <t>/files` (mkdir) and `env = { workspaceRoot: <t>/agent, userFilesRoot: home, claudeConfigDir }`. Expected outcomes:

| Case | claudeConfigDir / layout | Expect |
|---|---|---|
| sibling (production shape) | `<t>/runner/.ax/session` | resolves |
| trailing slash | `<t>/runner/.ax/session/` | resolves |
| prefix sibling | `<t>/files-cfg` | resolves |
| inside home | `<t>/files/.claude` | rejects `/refusing to start: CLAUDE_CONFIG_DIR/` |
| equal to home | `<t>/files` | rejects |
| home inside config | config `<t>/a`, `userFilesRoot` `<t>/a/files` | rejects |
| config is a symlink into home | `<t>/cfg-link -> <t>/files/.claude` | rejects |
| config's parent is a symlink into home | `<t>/runner -> <t>/files`, config `<t>/runner/.ax/session` | rejects |
| home is a symlink | `userFilesRoot` `<t>/home-link -> <t>/real`, config `<t>/real/.claude` | rejects |
| no durable home; scratch is HOME | `userFilesRoot` unset, `ephemeralRoot` `<t>/scratch`, config `<t>/scratch/.ax` | rejects (`runnerHomeDir` = scratch) |
| config missing | `<t>/nope` | rejects `/does not exist/` |
| home missing | `userFilesRoot` `<t>/not-yet`, config `<t>/runner` | resolves (a missing root can't contain an existing dir) |

- [ ] **Step 3: Run both test files and confirm they fail.** Run `pnpm --filter @ax/agent-runner-core test -- env config-dir-guard`. Expected: failures (missing field, missing module).

- [ ] **Step 4: Implement.**
  - **`env.ts`.** Read the field as `claudeConfigDir: need('CLAUDE_CONFIG_DIR')`. If `!path.isAbsolute(v)`, throw `new InvalidEnvError('CLAUDE_CONFIG_DIR', "expected an absolute path — a relative one resolves against the SDK's working directory, which is the agent's home")`. Document the field next to the other roots.
  - **`config-dir-guard.ts`:**
    1. `realConfig = await fs.realpath(env.claudeConfigDir)`. On failure, throw `refusing to start: CLAUDE_CONFIG_DIR (${env.claudeConfigDir}) does not exist or cannot be resolved. The sandbox creates it before starting the runner, so a missing one means the sandbox is misconfigured.`
    2. Roots are the unique entries of `[runnerHomeDir(env), env.userFilesRoot]`, defined ones only.
    3. For each root: `realRoot = await fs.realpath(root).catch(() => path.resolve(root))`.
    4. Refuse when `isSameOrInside(realConfig, realRoot) || isSameOrInside(realRoot, realConfig)`, with the message `refusing to start: CLAUDE_CONFIG_DIR resolves to ${realConfig}, which overlaps the agent's home ${realRoot}. Anything the agent writes there (settings.json hooks, CLAUDE.md, skills, MCP servers in .claude.json) would load as the SDK's own trusted configuration. Point CLAUDE_CONFIG_DIR at a runner-private directory outside the agent's files (k8s: /home/runner/.ax/session).`
    5. `isSameOrInside(child, parent)` uses `rel = path.relative(parent, child)` and returns true iff `rel === ''`, or `rel !== '..'` and `!rel.startsWith('..' + path.sep)` and `!path.isAbsolute(rel)`. That handles `..foo` names and a `/` root.
    6. Leave `workspaceRoot` and a non-HOME `ephemeralRoot` out of the roots (decisions shard row 3).
  - **`run-runner.ts`.** Right after the `readEnv()` try/catch and before `createTranscriptSource`: `try { await assertConfigDirOutsideAgentHome(env); } catch (err) { process.stderr.write(\`runner: ${message}\n\`); return 2; }`. It must run before `writeProxyCaFromEnv`, `setupProxy` and `materializeInstalledSkillsFromEnv`, which write into or under it.

- [ ] **Step 5: Write the runner-level failing tests.**
  - In `run-runner.test.ts`: `refuses to start before any IPC or filesystem work when CLAUDE_CONFIG_DIR is inside the agent's files`. `readEnv` returns `claudeConfigDir = <t>/files/.claude` (exists) and `userFilesRoot = <t>/files`. Expect `runRunner(...)` to return `2`; `createIpcClientMock`, `setupProxy` and `materializeInstalledSkillsFromEnv` (all already mocked in this file) not called; stderr to match `/CLAUDE_CONFIG_DIR/`.
  - In `main.test.ts`:
    - `refuses to start when CLAUDE_CONFIG_DIR is unset`: `setEnv({...COMPLETE_ENV, CLAUDE_CONFIG_DIR: undefined})`; `main()` resolves `2`; `queryMock` not called; stderr matches `/missing required env: CLAUDE_CONFIG_DIR/`.
    - `refuses to start when CLAUDE_CONFIG_DIR reaches the agent's files through a symlink`: `AX_USERFILES_ROOT=<t>/files` and `CLAUDE_CONFIG_DIR=<t>/link`, where `link -> <t>/files/.claude`; `main()` resolves `2`; `queryMock` not called.

- [ ] **Step 6: Fix fixtures without weakening the guard.**
  - `main.test.ts`: give `COMPLETE_ENV` a `CLAUDE_CONFIG_DIR` from a module-scope `fs.mkdtempSync(path.join(os.tmpdir(), 'ax-main-cfg-'))`, removed in `afterAll`. The `I-P0-1` forward test (`~:4726-4790`) must use a real temp dir.
  - `run-runner.test.ts`: every fake `RunnerEnv` gets a real temp `claudeConfigDir`.
  - Then run `pnpm --filter @ax/agent-runner-core test`, `pnpm --filter @ax/agent-claude-sdk-runner test` and `pnpm --filter @ax/agent-aisdk-runner test`. Any test that now fails only because `CLAUDE_CONFIG_DIR` is missing or nonexistent gets a real temp dir outside its home. Any other failure is a finding: stop and report.

- [ ] **Step 7: Verify.** Run the three package commands above, plus `pnpm --filter @ax/agent-runner-core build` and `pnpm --filter @ax/agent-claude-sdk-runner build`. Expected: all pass.

- [ ] **Step 8: Commit.** Message: `[TASK-994] Refuse to start when CLAUDE_CONFIG_DIR is unset or inside the agent's home`.

---

### Task 2: Transcript readers take a transcript directory (behavior-preserving) [tier: integration]

**Files:**
- Modify:
  - `packages/agent-claude-sdk-runner/src/jsonl-transcript-source.ts` (`:15-36`, `:128-183`)
  - `packages/agent-claude-sdk-runner/src/turn-end-uuid.ts` (delete the private `locateJsonl` at `:170-191` and import the exported one)
  - `packages/agent-claude-sdk-runner/src/main.ts` (call sites `:1030-1032`, `:1050-1054`, `:1083-1091`)
- Test:
  - `src/__tests__/jsonl-transcript-source.test.ts`
  - `turn-end-uuid.test.ts`
  - `cross-runner-transcript.test.ts:94`
  - `main.test.ts` (`:1173`, `:2174-2179`, `:3757`, `:4154`, `:4213`)

**Interfaces:**
- Produces. Throughout, `transcriptDir` is the directory that directly holds `<cwd-slug>/<sessionId>.jsonl`.
  - `locateJsonl(transcriptDir: string, sessionId: string): Promise<string | null>` (the single copy)
  - `createJsonlTranscriptSource(transcriptDir: string, sdkCwd: string): TranscriptSource` (`sdkCwd` becomes required)
  - `readLastTurnUuid(transcriptDir, sessionId, type)`
  - `waitForTranscriptUuid(transcriptDir, sessionId, targetUuid, opts)`
  - `hasResumableTranscript(transcriptDir, sessionId)`

- [ ] **Step 1: Re-point the existing unit tests and confirm they fail.** Plant under `transcriptDir = join(root, 'transcripts')` instead of `join(root, '.claude', 'projects')`. The writer test asserts that `write(sid, bytes)` lands at `join(transcriptDir, encodeProjectSlug(realpath(sdkCwd)), sid + '.jsonl')`. In `cross-runner-transcript.test.ts`, assert `readdir(transcriptDir)` rejects. Run `pnpm --filter @ax/agent-claude-sdk-runner test -- jsonl-transcript-source turn-end-uuid cross-runner-transcript`; expect failures.
- [ ] **Step 2: Change the signatures.** `locateJsonl` walks `transcriptDir` directly, and `writeJsonl` writes `join(transcriptDir, slug)`. Rewrite each function's doc comment to say "the transcript directory".
- [ ] **Step 3: Keep main.ts behavior identical.**
  - The five call sites pass `path.join(env.workspaceRoot, '.claude', 'projects')`, which is exactly today's location; Task 3 moves it.
  - `createTranscriptSource` passes `(that dir, runnerHomeDir(env))`.
  - Update the five `main.test.ts` assertions to expect `/tmp/workspace/.claude/projects` as the first argument.
- [ ] **Step 4: Verify.** Run `pnpm --filter @ax/agent-claude-sdk-runner test` and `pnpm --filter @ax/agent-claude-sdk-runner build`. Expected: pass.
- [ ] **Step 5: Commit.** Message: `[TASK-994] Transcript readers take a transcript directory`.

---

### Task 3: `transcript-dir` module, `AX_TRANSCRIPTS_ROOT`, and main.ts wiring [tier: integration]

**Files:**
- Create: `packages/agent-claude-sdk-runner/src/transcript-dir.ts` and `src/__tests__/transcript-dir.test.ts`
- Modify: `packages/agent-runner-core/src/env.ts` and `src/__tests__/env.test.ts` (add `transcriptsRoot`)
- Modify: `packages/agent-claude-sdk-runner/src/main.ts` (wiring and comment sweep)
- Modify:
  - `packages/agent-runner-core/src/git-workspace.ts`: delete `scaffoldSdkProjectsSymlink` (`:242-311`) and fix the cross-reference in `scaffoldWorkspaceGitignore`'s comment (`:225-229`); leave the `.claude/projects/` gitignore entry at `:204` alone, since TASK-995 deletes the file
  - `src/index.ts` (drop the export at `:31`)
  - `src/__tests__/git-workspace.test.ts`: move the `describe('scaffoldSdkProjectsSymlink')` block (`:329-~425`) into `transcript-dir.test.ts`
  - `src/__tests__/run-runner.test.ts:61` (drop the mock line)
- Comment-only fixes:
  - `packages/agent-runner-core/src/run-runner.ts`: the `afterMaterialize` doc at `:380-386` and `:569-573`, plus the comments at `:1386-1390` and `:1502`
  - `src/proxy-startup.ts:117-137`
  - `src/transcript-delta.ts:62-67`
  - `packages/sandbox-subprocess/src/open-session.ts:535-540`
  - `packages/agent-aisdk-runner/src/memory-transcript-source.ts:~6`

**Interfaces:**
- Consumes: `RunnerEnv.claudeConfigDir` (Task 1); the readers (Task 2).
- Produces:
  - `RunnerEnv.transcriptsRoot?: string` — read from `AX_TRANSCRIPTS_ROOT`. When set it must be absolute; otherwise throw `InvalidEnvError('AX_TRANSCRIPTS_ROOT', 'expected an absolute path')`.
  - `sdkTranscriptDir(env: Pick<RunnerEnv, 'claudeConfigDir' | 'transcriptsRoot'>): string`, which returns `env.transcriptsRoot ?? path.join(env.claudeConfigDir, 'projects')`.
  - `prepareTranscriptDir(env: Pick<RunnerEnv, 'claudeConfigDir' | 'transcriptsRoot'>): Promise<void>`.

- [ ] **Step 1: Write the failing tests.**
  - `env.test.ts`: `reads transcriptsRoot when AX_TRANSCRIPTS_ROOT is set, omits it otherwise`; `rejects a relative AX_TRANSCRIPTS_ROOT`.
  - `transcript-dir.test.ts`. Port the six moved cases, now targeting `transcriptsRoot` rather than `<workspaceRoot>/.claude/projects`, and add:
    - `without a transcripts root the SDK's own projects dir is used, as a plain directory` — `sdkTranscriptDir` returns `<cfg>/projects`, and after prepare `lstat` shows a directory, not a link.
    - `with a transcripts root, $CLAUDE_CONFIG_DIR/projects links to it and SDK writes land in the root` — `readlink` returns the root; a file written as `<cfg>/projects/s/x.jsonl` exists at `<root>/s/x.jsonl`; the root's mode is `0o700`.
    - `replaces a dangling link and a link to the wrong place` — plus the ported regular-file, directory and idempotence cases.
    - `a root equal to $CLAUDE_CONFIG_DIR/projects stays a directory and keeps its contents` — plant a file first; it survives, and there's no self-link.
  - `main.test.ts`:
    - `with AX_TRANSCRIPTS_ROOT, the SDK's projects dir links to it and every transcript reader uses it`. Set `AX_TRANSCRIPTS_ROOT=<t>/transcripts` and run a one-turn session. Then:
      - `lstat(<cfg>/projects).isSymbolicLink()`, and `readlink` returns the root;
      - `createJsonlTranscriptSourceSpy` was called with `(root, <sdkHome>)`;
      - the first argument to `waitForTranscriptUuidMock` and `readLastTurnUuidMock` is the root;
      - in the existing non-conversation F2a test, the first argument to `hasResumableTranscriptMock` is the root.
    - `without AX_TRANSCRIPTS_ROOT, transcripts stay in the per-session $CLAUDE_CONFIG_DIR/projects`. Re-point Task 2's five assertions to `<COMPLETE_ENV cfg>/projects`.
  - Run: `pnpm --filter @ax/agent-runner-core test -- env` and `pnpm --filter @ax/agent-claude-sdk-runner test -- transcript-dir main`. Expected: failures.

- [ ] **Step 2: Implement `transcript-dir.ts`.**
  1. Create the target with `mkdir(target, { recursive: true, mode: 0o700 })`.
  2. If `transcriptsRoot` is unset, or `path.resolve(target) === path.resolve(linkPath)`, return.
  3. Otherwise `mkdir(claudeConfigDir, { recursive: true, mode: 0o755 })`.
  4. Then reuse the moved logic verbatim: if `readlink(linkPath)` already equals the target, return; else `rm(linkPath, { recursive: true, force: true })`, then `symlink(target, linkPath)`; on `EEXIST`, re-check `readlink` and accept the raced correct link.
  5. Carry over the doc comment, rewritten: why a link (the SDK hard-codes `join(configDir, 'projects')`), why the target is on disk (tmpfs counts against pod memory), and why readers use the target (a restore must never create a real directory at the link path).

- [ ] **Step 3: Wire main.ts.**
  - In `createClaudeSdkLoop`, add `const transcriptDir = sdkTranscriptDir(env)` and use it in `waitForTranscriptUuid` and `readLastTurnUuid`.
  - Set `createTranscriptSource: (env) => createJsonlTranscriptSource(sdkTranscriptDir(env), runnerHomeDir(env))`.
  - Set `hasLocalTranscript: (env, id) => hasResumableTranscript(sdkTranscriptDir(env), id)`.
  - Make `afterMaterialize` an unconditional `await prepareTranscriptDir(env)`. Keep it in this seam: it is bootstrap-fatal and runs before the resume restore.
  - Drop the import of `scaffoldSdkProjectsSymlink`.

- [ ] **Step 4: Sweep the comments** — make each listed comment state the new truth.
  - In main.ts, fix `:239-243`, `:343-352`, the env-literal block `:357-427` and `:1074-1121`.
  - The side-files sentence (`:402-407` and `:421-422`) must become this measured fact: with `CLAUDE_CONFIG_DIR` set, the SDK's `.claude.json`, backups and session state land there, not in HOME. The runner refuses to start without it (`config-dir-guard`). The CLI's MCP-log cache follows `XDG_CACHE_HOME` on Linux (`buildToolCacheEnv`), but uses `HOME/Library/Caches` on macOS.
  - Then run `git grep -n -E 'scaffoldSdkProjectsSymlink|<workspaceRoot>/\.claude' -- 'packages/**/*.ts' ':!**/dist/**'`. Expected: zero hits. Task 9 covers the Markdown docs.

- [ ] **Step 5: Verify.** Run `pnpm --filter @ax/agent-runner-core test`, `pnpm --filter @ax/agent-claude-sdk-runner test`, `pnpm --filter @ax/agent-aisdk-runner test`, and `pnpm build`. Expected: pass.

- [ ] **Step 6: Commit.** Message: `[TASK-994] Move the SDK transcript working copy to a pod-private transcripts dir`.

---

### Task 4: k8s stamps `AX_TRANSCRIPTS_ROOT=/tmp/transcripts`; the warm-pool allowlist pins it [tier: sensitive] [security-checklist]

**Files:**
- Modify: `packages/sandbox-k8s/src/pod-spec.ts:810-823` — add `const RUNNER_TRANSCRIPTS_ROOT = '/tmp/transcripts'` with a one-line why (disk emptyDir, not the tmpfs HOME), and add `{ name: 'AX_TRANSCRIPTS_ROOT', value: RUNNER_TRANSCRIPTS_ROOT }` after `AX_EPHEMERAL_ROOT`.
- Modify: `packages/sandbox-protocol/src/bootstrap.ts:11-30` — add `'AX_TRANSCRIPTS_ROOT'` to `controlNames`, and `AX_TRANSCRIPTS_ROOT: '/tmp/transcripts'` to `fixedPaths`.
- Test: `packages/sandbox-k8s/src/__tests__/pod-spec.test.ts`, `packages/sandbox-protocol/src/__tests__/bootstrap.test.ts`, and the existing `packages/sandbox-k8s/src/__tests__/shared-pool.test.ts`, which should pass unchanged.

**Interfaces:** Produces the env contract that Task 3's runner reads. The value is exactly `/tmp/transcripts`.

- [ ] **Step 1: Write the failing tests.**
  - `pod-spec.test.ts`: `stamps AX_TRANSCRIPTS_ROOT=/tmp/transcripts on the pod-private disk /tmp`. Assert that the runner env has the value `'/tmp/transcripts'`; that the runner has a volumeMount at `/tmp`; and that the volume backing it is an `emptyDir` with no `medium` (disk, not tmpfs).
  - `bootstrap.test.ts`: `accepts the pinned AX_TRANSCRIPTS_ROOT` (`'/tmp/transcripts'` → success), and `it.each(['/files/transcripts', '/home/runner/.ax/session/projects'])('rejects AX_TRANSCRIPTS_ROOT %j', …)` → failure.
- [ ] **Step 2: Stamp pod-spec first, then run `pnpm --filter @ax/sandbox-k8s test -- pod-spec shared-pool`.** Expected: `pod-spec` passes, but `shared-pool` fails with `shared bootstrap configuration invalid`. That proves the allowlist is load-bearing; note it in the PR.
- [ ] **Step 3: Pin the value in `bootstrap.ts`.** Run `pnpm --filter @ax/sandbox-protocol test`, then `pnpm --filter @ax/sandbox-k8s test`. Expected: all pass.
- [ ] **Step 4: Build.** Run `pnpm --filter @ax/sandbox-protocol build` and `pnpm --filter @ax/sandbox-k8s build`.
- [ ] **Step 5: Commit.** Message: `[TASK-994] k8s runners keep SDK transcripts in /tmp/transcripts`.

---

### Task 5: Real-binary e2e — HOME stays empty, transcripts, resume, canary, and controls [tier: sensitive]

**Files:** Create `packages/agent-claude-sdk-runner/src/__tests__/agent-files-guards-real-sdk.e2e.test.ts`.

**Interfaces:** Consumes:
- `prepareTranscriptDir` (Task 3);
- `locateJsonl` and `createJsonlTranscriptSource` (Task 2), plus `readLastTurnUuid`, `waitForTranscriptUuid` and `hasResumableTranscript`;
- `buildToolCacheEnv` and `buildTtyHintEnv` (`@ax/agent-runner-core`);
- `buildTelemetryEnv` (`../telemetry-env.js`);
- `MCP_HOST_SERVER_NAME` and `MCP_SANDBOX_SERVER_NAME` (`../tool-names.js`);
- `query` and `createSdkMcpServer` (the SDK).

**Harness:** copy the shape of `connector-mcp-real-sdk.e2e.test.ts`. That means:
- the `HAVE_BINARY` skip;
- a scripted local server on `127.0.0.1:0` that records request bodies and can return one `Bash` `tool_use` (`{"command":"echo hi"}`) on the first agent-loop call;
- the darwin `security` stub on `PATH`;
- in `finally`, close the query and wait for the CLI to exit (cap 15 s) before any filesystem assertion;
- a 60 s timeout per case.

Per-case layout under `mkdtemp`: `files/` (HOME and cwd), `runner-home/.ax/session/` (cfg, containing `skills/`), `transcripts/`, `scratch/` and `markers/`. `markers/` sits outside `files`.

`productionOptions` mirrors main.ts:
- `settingSources: ['user']`, `cwd: files`, `allowedTools: ['Skill']`, a `canUseTool` that always allows, `model: 'claude-sonnet-4-5'`;
- `mcpServers`: the two names above, each `createSdkMcpServer({ name, version: '0', tools: [] })`;
- env layered in main.ts order: `{...buildTtyHintEnv(), PATH, ...buildTelemetryEnv(), HOME: files, CLAUDE_CONFIG_DIR: cfg, ...buildToolCacheEnv(scratch), ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY: 'sk-ant-fake-for-a-local-scripted-server'}`.

Call `prepareTranscriptDir({ claudeConfigDir: cfg, transcriptsRoot: transcripts })` before each run.

**Permissions, Steps 3–5:** run the canary and both controls with `permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true` in place of `allowedTools`/`canUseTool`, keeping everything else from `productionOptions`. There are two reasons:
- "No effect even under bypass" is the stronger claim.
- It is the mode in which the planner measured the controls going live. Production's prompt-based shape might hold back a project `.mcp.json` server for approval, and a control must show each plant is live.

Steps 1–2 keep the production permission shape.

- [ ] **Step 1:** `it('a fresh session leaves the agent home empty and writes its transcript into the transcripts root')`. Run one Bash turn, then assert:
  - `result.subtype === 'success'`;
  - with `sid` from init and `uuid` = the last `SDKAssistantMessage.uuid`, `await waitForTranscriptUuid(transcripts, sid, uuid, { timeoutMs: 10_000, intervalMs: 50 })` is `true`;
  - `await readLastTurnUuid(transcripts, sid, 'assistant')` equals `uuid`;
  - `(await locateJsonl(transcripts, sid))!.startsWith(transcripts)`;
  - the recursive listing of `files` is `[]` on Linux;
  - on `darwin`, every entry starts with `Library/` and lies under `Library/Caches/claude-cli-nodejs/` — the env-paths cache measured 2026-10-30. Write that in a comment, and do NOT extend this allowance to Linux.
- [ ] **Step 2:** `it('a resumed session in a fresh pod finds the transcript the runner restored')`.
  1. In pod A's dirs, run a turn with prompt `remember PINEAPPLE-42`.
  2. Read `bytes = await createJsonlTranscriptSource(transcriptsA, files).read(sid)`.
  3. Set up pod B: new `cfgB` and `transcriptsB`, then run `prepareTranscriptDir`.
  4. `await createJsonlTranscriptSource(transcriptsB, files).write(sid, bytes!)` returns `'accepted'`, and `await hasResumableTranscript(transcriptsB, sid)` is `true`.
  5. Run with `resume: sid` and prompt `what did I ask you to remember?`.
  6. Expect `success`, and some recorded request body containing `PINEAPPLE-42`.
- [ ] **Step 3:** `it('files the agent planted in its home reach neither the prompt nor settings, hooks or MCP servers')`.
  - Plant in `files`:
    - `.ax/SOUL.md` = `CANARY-SOUL-7f3a`;
    - `CLAUDE.md` = `CANARY-CLAUDEMD-91bc`;
    - `.claude/CLAUDE.md` = `CANARY-DOTCLAUDE-55aa`;
    - `.claude/settings.json` with `SessionStart`, `UserPromptSubmit` and `Stop` command hooks running `touch <markers>/settings-<Event>`;
    - `.mcp.json` with a stdio server `canaryproj` whose command is `/bin/sh -c "touch <markers>/mcp-json-spawned; sleep 1"`;
    - `.claude.json` with a stdio server `canaryhome` that touches `claude-json-spawned`;
    - `.claude/skills/canary-skill/SKILL.md`, whose description is `CANARY-SKILL-3c1d`.
  - With `productionOptions`, assert:
    - no request body contains any `CANARY-` string;
    - `markers/` is empty;
    - init `mcp_servers` names exclude `canaryproj` and `canaryhome`;
    - init `skills` excludes `canary-skill`;
    - the listing of `files` equals exactly the planted paths. On darwin, also allow the same `Library/Caches/claude-cli-nodejs/` subtree.
- [ ] **Step 4:** `it("control: the 'project' setting source makes the same plants live")`. Use the same plants with `settingSources: ['user', 'project']`. Assert that a request body contains `CANARY-CLAUDEMD-91bc`, that `markers/settings-UserPromptSubmit` exists, and that `markers/mcp-json-spawned` exists.
- [ ] **Step 5:** `it('control: without CLAUDE_CONFIG_DIR the SDK reads and writes the agent home')`. Use the same plants, and omit `CLAUDE_CONFIG_DIR` from the env. Assert:
  - `markers/claude-json-spawned` exists;
  - `markers/settings-UserPromptSubmit` exists;
  - a request body contains `CANARY-DOTCLAUDE-55aa`;
  - init `skills` include `canary-skill`;
  - the listing of `files` includes `.claude/projects/`.

  This control is why Task 1's guard exists.
- [ ] **Step 6: Run the file twice to catch flakes.** Run `pnpm --filter @ax/agent-claude-sdk-runner test -- agent-files-guards-real-sdk` twice. Expected: 5 passed, twice. CI (Linux) is the authoritative run for the strict empty-HOME assertion. If CI shows a new Linux HOME entry, that is a production finding: redirect it the way `XDG_CACHE_HOME` is redirected (an env var in `buildToolCacheEnv`) or report back. Never allowlist it.
- [ ] **Step 7: Commit.** Message: `[TASK-994] Real-binary e2e for agent-home guards, transcripts and resume`.

---

### Task 6: Runner-level §11 canary in main.test.ts [tier: integration]

**Files:** Modify `packages/agent-claude-sdk-runner/src/__tests__/main.test.ts` — add `describe('agent files §11 guards')` and move Task 1's two refusal tests into it.

**Interfaces:** Consumes Tasks 1–3.

- [ ] **Step 1:** `it('files planted in the agent home reach neither the runner prompt nor the SDK options, and the runner writes nothing there')`.
  - Env: `COMPLETE_ENV` with `AX_USERFILES_ROOT=<t>/files`, `AX_WORKSPACE_ROOT=<t>/agent` (an empty dir) and `CLAUDE_CONFIG_DIR=<t>/cfg` (containing `skills/`).
  - Use the same plants as Task 5 Step 3, but with `markers` outside `files`.
  - Run one turn. On `queryArg.options`, assert:
    - `systemPrompt` contains no `CANARY-`;
    - `Object.keys(mcpServers).sort()` deep-equals `[MCP_HOST_SERVER_NAME, MCP_SANDBOX_SERVER_NAME].sort()`;
    - `settingSources` equals `['user']`;
    - `cwd` and `env.HOME` both equal `<t>/files`;
    - `env.CLAUDE_CONFIG_DIR` equals `<t>/cfg`;
    - `'CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD' in env` is `false`.
  - Finally, the recursive listing of `<t>/files` equals exactly the planted set.
- [ ] **Step 2: Run it and confirm it passes on the current code.** Run `pnpm --filter @ax/agent-claude-sdk-runner test -- main`. Then do the predicted mutation (Task 10, M3) to confirm it is not vacuous.
- [ ] **Step 3: Commit.** Message: `[TASK-994] Runner-level canary for agent-planted files`.

---

### Task 7: `/memory` stays unpublishable [tier: mechanical]

**Files:** `packages/tool-artifact-publish/src/__tests__/path-allowlist.test.ts`, `packages/agent-runner-core/src/__tests__/artifact-publish-executor.test.ts`.

- [ ] **Step 1:** In path-allowlist, add `describe('the facts export (/memory) is not publishable — design §11')`:
  - `checkPublishablePath('/memory/facts/a.md', { userFilesRoot: '/files', ephemeralRoot: '/ephemeral' })` and `checkPublishablePath('/memory', …)` both return `ok: false`;
  - with subprocess-shaped roots `<base>/files` and `<base>/ephemeral`, `<base>/memory/facts/a.md` returns `ok: false`.
- [ ] **Step 2:** In the executor tests, add `it('refuses a real file in a sibling memory tree, directly and through a link in the agent files')`:
  - Layout: `<t>/files`, and `<t>/memory/facts/a.md` holding real bytes. Construct the executor the way `run-runner.ts:795-800` does — `userFilesRoot` and `ephemeralRoot` only.
  - Publishing `<t>/memory/facts/a.md` is rejected.
  - With `<t>/files/mem -> <t>/memory`, publishing `<t>/files/mem/facts/a.md` is rejected.
- [ ] **Step 3: Verify, then commit.** Run `pnpm --filter @ax/tool-artifact-publish test` and `pnpm --filter @ax/agent-runner-core test -- artifact-publish-executor`. Expected: pass. Commit message: `[TASK-994] Pin /memory as unpublishable`.

---

### Task 8: `delete_user.sh` deletes agents through the host [tier: sensitive] [security-checklist]

**Files:** Rewrite `delete_user.sh`. Create `scripts/delete-user-agents.mjs`, `scripts/__tests__/delete-user.test.js` and `scripts/__tests__/delete-user-agents.test.js`. Keep `scripts/__tests__/kind-tooling-pinned-to-kind-context.test.js` passing unchanged.

**Script contract** — `bash delete_user.sh <email>`, kind only. Add `#!/usr/bin/env bash` and `set -euo pipefail`, and keep the function `delete_ax_user`:
1. Look up `uid`. Send the SQL on stdin, with the email passed as `-v email=…` and referenced as `:'email'`. A missing user gives exit 1.
2. List the agents: `SELECT agent_id FROM agents_v1_agents WHERE owner_type = 'user' AND owner_id = :'uid'`. Columns are per `packages/agents/src/migrations.ts:29-41`.
3. If there are any agents:
   1. Mint a session for `uid`: id = random, token = 64 hex characters from `openssl rand -hex 32`, `expires_at = now() + interval '10 minutes'` (columns per `packages/auth-better/src/migrations.ts:83-92`).
   2. Set an `EXIT` trap that deletes that session row.
   3. Pipe `token\nid1\nid2…` into `kubectl --context "$ctx" -n "$ns" exec -i deploy/ax-next-host -c host -- node --input-type=module -e "$(cat "$repo/scripts/delete-user-agents.mjs")"`.
   4. If that exits non-zero, print its output and exit 1. Send no SQL.
4. Count the user's personal agents again. If any remain, exit 1 without SQL.
5. Run one transaction with `ON_ERROR_STOP`, using the `:'uid'` variable everywhere. It contains the current statements minus three things:
   - `DELETE FROM agents_v1_agents`;
   - the three routines statements, which use renamed columns. Add a comment: personal-agent routines are cleaned by `agents:deleted`, and the user's routines on team agents are not deleted (an open product question);
   - anything else that fails the migration check below.

   Check every remaining table and column against `packages/{conversations,attachments,session-postgres,connectors,auth-better}/src/migrations.ts`. Auth rows go last. Keep the ADMIN warning.

**Helper contract** — `scripts/delete-user-agents.mjs`, node built-ins only:
- Stdin: line 1 is the session token; each further non-empty line is an agent id.
- Key: `AX_HTTP_COOKIE_KEY` must be 64 hex characters or base64 that decodes to 32 bytes. Anything else exits 2 before making a request.
- Per id, in order: `DELETE http://127.0.0.1:${AX_HTTP_PORT}/admin/agents/${encodeURIComponent(id)}` with:
  - header `cookie: ax_auth_session=<base64url(token)>.<base64url(HMAC-SHA256(key, token))>`, the format from `packages/http-server/src/cookies.ts`, which a comment should cite;
  - header `x-requested-with: ax-admin`.
- On 204, print `deleted <id>`.
- On the first non-204, print `failed <id> <status> <body ≤500 chars>` and exit 1.

- [ ] **Step 1: Write the failing helper tests** in `delete-user-agents.test.js`. Spawn the helper with `node` against a fake server on `127.0.0.1:0`.
  - `sends one authenticated DELETE per agent with the CSRF header`: run once with a hex key and once with a base64 key. Check the cookie with an independent `createHmac('sha256', key)` in the test.
  - `stops at the first refusal and exits non-zero`: with ids `[a, b, c]` and `b` answering 500, `c` is never requested and the exit code is 1.
  - `refuses a malformed cookie key`: exit 2, and no request.
- [ ] **Step 2: Write the failing script tests** in `delete-user.test.js`.
  - Stub pattern from `scripts/__tests__/gke-backups.test.js:57-135`: a stub `kubectl` in a temp bin dir placed first on `PATH`. It appends `{argv, stdin}` JSON lines to `STUB_LOG` and dispatches on argv and SQL text:
    - the secret → base64 of `pw`;
    - the user lookup → `STUB_UID`;
    - the agent listing → `STUB_AGENTS`;
    - the remaining count → `STUB_REMAINING` (default `0`);
    - the session `INSERT`/`DELETE` and `BEGIN` → succeed;
    - `exec … deploy/ax-next-host` → `deleted <id>` for each id, failing on any id listed in `STUB_FAIL_IDS`;
    - anything unrecognised → exit 99.
  - Run both `bash` and `/bin/bash`, as that file does. Tests:
    - `deletes each personal agent through the host before any row is removed`: both ids are sent to the host exec in one call; that call is logged before the `BEGIN` call; and the transaction SQL does not match `/DELETE\s+FROM\s+agents_v1_agents/i`.
    - `stops before any SQL when the host refuses an agent, and removes the session it minted`: non-zero exit; no `BEGIN`; a `DELETE FROM auth_better_v1_sessions` is logged.
    - `skips the host when the user owns no personal agents`: no host exec, no session insert, and `BEGIN` runs.
    - `refuses to delete rows while personal agents remain`: with `STUB_REMAINING=1`, the exit is non-zero and there is no `BEGIN`.
    - `never splices the email into SQL`: for `o'brien+x@example.com`, the email appears only as a `-v email=…` argv element, never in any logged stdin.
    - `pins every kubectl call to kind`: every logged argv contains `--context`, `kind-ax-next-dev`.
- [ ] **Step 3: Confirm the new tests fail.** Run `pnpm test:scripts -- delete-user`.
- [ ] **Step 4: Implement the script and the helper,** then run `pnpm test:scripts`. Expected: all pass, including the existing kind-context scan.
- [ ] **Step 5: Commit.** Message: `[TASK-994] delete_user.sh deletes agents through the host so agents:deleted fires`.

**Chain of evidence for the acceptance "fires `agents:deleted` for each agent":**
- this task shows the script issues one host `DELETE /admin/agents/:id` per agent before any SQL;
- `packages/agents/src/admin-routes.ts:687-706` routes that request to `agents:delete`;
- `packages/agents/src/__tests__/plugin.test.ts:361` shows `agents:delete` fires `agents:deleted`.

State this composition honestly in the PR. Running against a live kind cluster is optional; if possible, delete a throwaway user created per the headless-auth recipe.

---

### Task 9: Stale prose — the design §11 line and the memory shards [tier: mechanical]

- [ ] **Step 1:** In `docs/plans/2026-10-29-agent-files-simplification-design.md`, rewrite the §11 bullet at `~:264-267`:
  - the SDK's side files already land in `CLAUDE_CONFIG_DIR` whenever it is set (measured 2026-10-30, SDK 0.2.119);
  - the runner refuses to start without it, so they never reach `/files`;
  - the MCP-log cache follows `XDG_CACHE_HOME` on Linux but uses `HOME/Library/Caches` on macOS (local CLI only).

  Touch no other section; sibling cards edit this doc too.

  Also fix `packages/sandbox-subprocess/SECURITY.md:43`, which says two things that are no longer true:
  - "overrides `HOME=workspaceRoot`" — HOME is now the agent's home, `runnerHomeDir`;
  - "the SDK would fall back to `<HOME>/.claude`" — the runner now refuses to start when `CLAUDE_CONFIG_DIR` is unset, relative, missing, or overlaps that home.

  Leave `:44` (the I-P0-4 skills symlink) alone; it is not this card's.
- [ ] **Step 2: Write the memory shards** (`scripts/memory-write-target.sh --shard <kind> TASK-994`; `mkdir -p` the dirname first, and never edit a root archive):
  - **context** — the measured facts from the top of this plan (side files follow `CLAUDE_CONFIG_DIR`; the env-paths cache per platform; what the canary showed under each control); the pool bootstrap allowlist refusing unlisted `AX_*` names.
  - **patterns** — corrections to two archived rows:
    - the artifact-publish row (`patterns.md` ~:480) says `PublishRoot = 'ephemeral' | 'agent'`; it is now `'user-files' | 'ephemeral'`;
    - the row saying the transcript symlink targets `<workspaceRoot>/.claude/projects` (`patterns.md` ~:111): it now targets `AX_TRANSCRIPTS_ROOT`, or there is no link and transcripts sit in `$CLAUDE_CONFIG_DIR/projects`.
  - **mistakes** — one row: a stale code comment (main.ts side files) became a design premise and then a card requirement; measure SDK behavior before planning around a comment.
  - Backtick only paths that exist, and run `pnpm test:scripts -- memory`.
- [ ] **Step 3: Commit.** Message: `[TASK-994] Correct the side-files claim; memory shards`.

---

### Task 10: Mutation evidence, full gate, security note [tier: integration]

- [ ] **Step 1: Run each mutation.** Use the yolo-ship Phase 4 mutation-restore protocol: commit first, mutate one file, run, restore with `git checkout -- ':(literal)<path>'`, and confirm `git status --porcelain` is clean. Record predicted vs. actual for each. A mismatch is a finding: fix the test.

| # | Mutation | Predicted red |
|---|---|---|
| M1 | `main.ts:659` → `settingSources: ['user','project']` | `main.test.ts` (Phase 3 default `:673`, HR1 `:1067`, memory root `:4242`, connector `:4873`) and the Task 6 canary. The e2e is unaffected (its control proves the live effect). |
| M2a | delete the guard call in `run-runner.ts` | the Task 1 `run-runner.test.ts` refusal; the `main.test.ts` symlink refusal. The guard unit tests stay green. |
| M2b | `fs.realpath` → `path.resolve` in the guard | the guard cases "config is a symlink", "parent is a symlink", "home is a symlink"; the main.test symlink refusal |
| M2c | drop the absolute check in `env.ts` | the three relative-path env tests |
| M2d | drop the reverse-direction overlap | the guard case "home inside config" |
| M3 | `run-runner.ts:1558`: pass `homeDir` instead of `env.workspaceRoot` to `buildSystemPrompt` | the Task 6 canary (SOUL marker in the prompt) |
| M4 | remove `XDG_CACHE_HOME` from `tool-cache-env.ts` | Linux only: the Task 5 empty-HOME case. Predicted green on darwin. State this; don't push the mutant. |
| M5 | add the memory root as a publish root | the Task 7 allowlist and executor tests |
| M6 | restore `DELETE FROM agents_v1_agents …` and drop the host step | Task 8 "deletes each personal agent through the host" |
| M7a | revert the readers to `<workspaceRoot>/.claude/projects` | the Task 2 and Task 3 unit tests; the Task 3 main wiring test; Task 5 Step 1 |
| M7b | drop `prepareTranscriptDir` from `afterMaterialize` | the Task 3 main wiring test (`projects` is a link) |
| M8 | remove the `bootstrap.ts` pin while pod-spec still stamps | `shared-pool.test.ts` and `bootstrap.test.ts` |

- [ ] **Step 2: Run the full gate.** `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts && pnpm lint`. Expected: all green. If `@ax/auth-better` fails only on its Docker teardown, report that rather than rerunning blindly.
- [ ] **Step 3: Write the security note.** Invoke `security-checklist` and write the note for the PR. It covers:
  - the startup guard (sandbox boundary);
  - the new env contract and the pool allowlist pin (no new reach: a fixed value inside the pod's own `/tmp`);
  - unchanged exposure — the agent's Bash can still tamper with its own transcript working copy, exactly as it can under `/agent` today, and the DB stays the source of truth;
  - `delete_user.sh`: it mints a 10-minute session for the target user only, the key stays in-pod, it is destructive, and it fails closed;
  - the canary evidence.
- [ ] **Step 4: PR body.**
  - Say there is no hook-surface change, so no boundary review is needed; add the env-contract note.
  - Include the mutation table with results.
  - Include the macOS limitation.
  - Hand-off for TASK-995: when `materialize` goes, keep `prepareTranscriptDir` running before the resume restore (the Task 3 wiring test goes red otherwise); keep the §11 describe blocks and the e2e; `/ephemeral` → `/tmp` for tool caches is yours.
  - Hand-off for TASK-992: the guard reads `runnerHomeDir(env)`, so a required `/files` needs no guard change.
