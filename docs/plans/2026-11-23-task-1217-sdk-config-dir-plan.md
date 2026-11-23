# TASK-1217: the CLI's config dir, reserved skill names, `/` messages, background tasks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nothing the agent writes into `$CLAUDE_CONFIG_DIR` — or starts in the background, or a person types after a `/` — reaches the Claude Code CLI as configuration, instructions, a command, or an unprompted turn.

**Architecture (four controls, no prompts):**
- **Item 1a — `@ax/agent-runner-core`.** A boot guard, `assertConfigDirFresh`, runs right after the TASK-994 overlap guard. It refuses to start (exit 2, nothing written or deleted) unless `$CLAUDE_CONFIG_DIR` holds nothing but a plain `skills/` directory. That covers every sandbox (cold k8s pod, shared warm pool, subprocess), because all three boot through `runRunner`.
- **Item 1b — `@ax/agent-claude-sdk-runner`.** A `ConfigChange` SDK hook blocks every config reload for the life of the session (settings and skills).
- **Item 1c — same package.** The `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` env floor: the CLI never loads `CLAUDE.md`, `rules/*.md` or auto-memory `MEMORY.md` from its config dir, at start or after compaction.
- **Item 2 — same package.** The `Skill` gate refuses an AX skill whose name the CLI already answers to (`CLI_COMMAND_NAMES`, 16 names, pinned by a real-binary drift test). Reserving those names at skill *creation* is a follow-up card (see "Follow-ups").
- **Item 3 — same package.** `keepSlashAsText`: any turn text that starts with `/` gets an invisible U+200B in front, so the CLI reads it as words, never as a slash command.
- **Item 4 — same package.** The `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` env floor: no `run_in_background`, no auto-backgrounding at timeout, no task-notification wake-ups.

No hook, IPC action, wire schema or rail-clause changes.

**Tech Stack:** TypeScript, vitest, pinned `@anthropic-ai/claude-agent-sdk` 0.2.119 / `claude` CLI 2.1.119 native binary. No new dependency.

**Spec:** board card TASK-1217 (project-ax TO DO #1). Items 1–4 are planned. Item 5 (check prod homes for `.claude/scheduled_tasks.json` on deploy) is out of scope (needs prod access and Vinay's OK); it goes back as a follow-up.
- **Read first:** `.claude/memory/decisions/2026-11-23-TASK-1217.md` (this plan's decisions) and the TASK-1207 shards `.claude/memory/{context,decisions,patterns}/2026-11-23-TASK-1207.md`.
- **Reference probe (scratch, never commit):** `/private/tmp/claude-501/-Users-vpulim-dev-ai-ax-next/b9feba9b-916e-4979-b5be-adabf94d3c15/scratchpad/TASK-1217/planner/probe.mjs`. It is a plain-node harness (fake `/v1/messages` server, sequential turns, a `ConfigChange` hook toggle) that produced every "measured" line below. Reuse its shapes for the e2e files; don't copy its shortcuts (it `close()`s without draining).

## The premise, checked

**Item 1 ("a planted settings.json runs on later turns in the same sandbox or home"): refuted as written, true in three other shapes.**
- Today no later CLI process starts on a config dir an earlier session could write:
  - k8s cold pod: one runner, one `query()` per pod (`main.ts:351`), `restartPolicy: Never`, and `/home/runner` is a per-pod `emptyDir` (`pod-spec.ts:664,900,955`).
  - Warm pool: an assignment is taken once and never reassigned (`agent-runner-core/src/standby.ts`).
  - Subprocess: a per-session `mkdtemp` (`sandbox-subprocess/src/open-session.ts:296,318`), one spawn, no respawn (`:719`).
- Inside one CLI process, settings hooks and env don't hot-reload ONLY because no `settings.json` exists when the CLI starts. The CLI's settings watcher watches a settings dir only if its settings file existed at startup. Seed `{}` and a mid-session plant goes live (measured, M3).
- **Live today, measured:**
  - The CLI hot-reloads `$CLAUDE_CONFIG_DIR/skills/` mid-session. The 0555 lock is a belt, not a wall: the agent's shell is the same uid and can `chmod -R u+w` it. After that, an edited `SKILL.md` body is what `Skill(name)` launches, and a planted folder's description shows up in the model's skill listing (M5).
  - The CLI re-reads `$CLAUDE_CONFIG_DIR/CLAUDE.md` (plus `rules/*.md` and auto-memory `MEMORY.md`) after compaction. An agent-written line then comes back framed as "the user's private global instructions" (M6).
- **The acceptance test** ("an agent-written settings.json doesn't change the next session's env or hooks") is satisfied by the boot guard (Task 1), proven on the real binary in Task 6.

**Item 2: true** (TASK-1207 patterns shard, measured). An AX skill named `simplify` passes the folder allowlist, but the CLI launches its bundled `simplify`. The CLI answers to 16 names in the runner's configuration (M9), not the 7 in the model's listing.

**Item 3: true, and worse than the card says** (M8).
- `/update-config …` expands the bundled skill with no `Skill` call, so `tool.pre-call` never sees it.
- `/clear` makes no model call and switches the CLI to a NEW session id. The runner keeps the first `system/init` id (`main.ts:686-697`), so the shipped transcript stops following the conversation.
- `/hello there` (any unknown word) gets the CLI's own "Unknown command: /hello" reply, and the model never sees the message.
- Nothing in AX offers `/` commands (web composer is plain text; Slack always puts a label first; only a plain routine's prompt can start with `/`).

**Item 4: true, and wider than the card says** (M7). Besides `run_in_background`, ANY Bash command that outlives its `timeout` (default 2 min) is auto-moved to the background. When it finishes, it wakes the model for an unprompted `<task-notification>` turn.

## Contradictions with the builder's reading (all measured, M-numbers below)

1. "CLAUDE.md in the config dir IS re-read live: every model request after the write carries it." **Artifact.** The probe's marker string was inside the Bash `tool_use` input, which stays in the history of every later request. Build the marker from parts (`printf 'PLANTED-%s-T1217' LIVE`) and a mid-session write is NOT re-read per request or per turn. It IS re-read after compaction (M6).
2. "Hooks and settings env are snapshotted at CLI startup; NOT hot-reloaded." **Conditional.** That holds only because no `settings.json` exists at CLI start (M3).
3. "Residual live exposure today: CLAUDE.md." **Incomplete.** The bigger live one is the skills hot reload (M5).

## What made the card look true (stale lines this plan corrects)

- `docs/notes/2026-05-17-sdk-setting-sources-audit.md:40-44` says the `'user'` root "is populated by host code (via `runner-host-dist` symlink) and is not writable by the sandbox". `:67` says "agent cannot write" for `settings.json`, and `:77-80` says "none of these paths are writable by an agent". All false since the agent got Bash: same uid, per-session tmpfs/tempdir, no runner-host-dist link. **Task 8.** This is the primary stale-line fix.
- `packages/agent-claude-sdk-runner/SECURITY.md:7,64` and `src/main.ts:637` call `CLAUDE_CONFIG_DIR` "runner-private". It is private to the session, not to the agent. **Task 8.**
- `packages/agent-runner-core/src/env.ts:55` says "The runner-private directory…". **Task 8**, one clause.
- `packages/agent-claude-sdk-runner/src/projected-skills.ts:18` says "nothing rewrites it mid-session". The agent can, and the CLI reloads it (M5). The snapshot of NAMES is still exact for the allowlist. **Task 8.**
- `run_in_background` "kept on purpose / stays" prose becomes false after Task 2: `packages/tool-policy/src/rules.ts:156-160`, `scripts/__tests__/disabled-builtin-rail-drift.test.js:29,143-147` (+ the TaskOutput/TaskStop `why`s), `packages/agent-claude-sdk-runner/src/tool-names.ts:156`, `SECURITY.md:57`. **Task 8.** The rail clause itself ("schedule things with its built-in timer instead of a routine") stays true and is NOT changed: a shell `(sleep N; …) &` still runs work later.
- `SECURITY.md:120-121` ("Two ways a bundled skill still runs"): both are closed by Tasks 4–5. **Task 8.**
- Memory rows in the TASK-1207 shards that say `run_in_background` is "kept on purpose" can't be edited (rule R1). Task 8 writes superseding rows in TASK-1217 shards.

## Measured on the pinned binary (planner probes, CLI 2.1.119, configured like main.ts; do not re-derive)

The setup matched `main.ts`: `tools`/`disallowedTools` lists, `settingSources: ['user']`, `buildTelemetryEnv()` + `buildBundledSkillsEnv()`, parent env stripped, HOME=cwd=agent home, its own `CLAUDE_CONFIG_DIR`, and turns sent one at a time. Yielding two prompts at once makes the CLI fold or coalesce them, so the e2e must await each `result` before yielding the next.

- **M1 (builder).** A NEW CLI process on a config dir whose `settings.json` the previous session's Bash wrote runs its `SessionStart`, `UserPromptSubmit` and `PreToolUse` command hooks, and Bash sees its `env`. `CLAUDE.md` there loads too.
- **M2.** Same process, NO `settings.json` at CLI start: a mid-session `settings.json` plant (env + hooks) changes nothing (marker file empty, `ENV=[]`).
- **M3.** Same process, `settings.json` = `{}` present at CLI start: the mid-session plant hot-reloads. On the next turn the planted `UserPromptSubmit` and `PreToolUse` hooks fire (marker `ups\npre\n`) and Bash sees `ENV=[yes]`. Binary: the watcher (`awaitWriteFinish` 1000 ms / poll 500 ms) watches a settings dir only if its file existed at init. On change it runs `ConfigChange` hooks and then re-snapshots hooks (`BOH()`).
- **M4.** An SDK callback hook `ConfigChange: [{ hooks: [async () => ({ decision: 'block', reason }) ] }]` stops M3 (marker empty, `ENV=[]`) and M5 (original body, no planted listing). It receives `{ hook_event_name: 'ConfigChange', source: 'user_settings' | 'skills' | …, file_path }`. A session with no tampering gets zero events (`ignoreInitial`). `policy_settings` changes can't be blocked (by design: root-owned, outside the sandbox).
- **M5.** Skills hot reload, live today. The probe ran `chmod -R u+w "$CLAUDE_CONFIG_DIR/skills"`, appended to `weekly-report/SKILL.md`, and wrote a new `evil/SKILL.md` whose description carried a marker. The next turn's request listed `evil` with the planted description, and `Skill('weekly-report')` launched the TAMPERED body. The runner's name allowlist still refuses `Skill('evil')`. Binary: the skills watcher (stability 1000 ms, debounce 300 ms) watches `$CLAUDE_CONFIG_DIR/skills`, `…/commands`, `<cwd>/.claude/skills` and each additional directory's `.claude/skills`. There is no env switch; only bare mode turns it off, and that drops AX skills.
- **M6.** `$CLAUDE_CONFIG_DIR/CLAUDE.md`, `rules/*.md` and `projects/<cwd-slug>/memory/MEMORY.md` (auto memory is ON by default; `system/init` reports `memory_paths.auto`) all load at session start.
  - A mid-session write is NOT in later requests, even 1.5 s into a new turn.
  - After `/compact` the next turn carries it.
  - With `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`, none of them loads at start or after compaction. Binary: the gate sits in the user-context builder, and auto-memory `MEMORY.md` is loaded through that same list. With a custom string system prompt, the CLI adds no auto-memory section (`f!==void 0&&JB_()?…`). So `CLAUDE_CODE_DISABLE_AUTO_MEMORY` is not needed.
- **M7.** Background tasks.
  - `Bash {run_in_background:true, command:'sleep 2; echo …'}` produces an unprompted model call about 2 s after the turn's `result`; its last user block is `<task-notification>…<status>completed</status>…`.
  - `Bash {command:"bash -c 'sleep 4; echo …'", timeout:1000}` (no `run_in_background`) returns "Command running in background with ID: …", then wakes the model the same way. Binary: `shouldAutoBackground` is true for any command whose first word isn't `sleep`.
  - With `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`:
    - the Bash `input_schema.properties` lose `run_in_background`;
    - a call that sends it anyway returns is_error `InputValidationError: … An unexpected parameter \`run_in_background\` was provided`;
    - the timeout case returns `Exit code 143`;
    - zero unprompted calls happen.
  - Bash has no interrupt→background path in 2.1.119 (only `explicitly_backgrounded` and `timeout_backgrounded`), so interrupts are unaffected.
- **M8.** A person's text in SDK streaming mode:
  - `/update-config add a hook please` is expanded: the request's last user block ends with the settings schema plus `## User Request\n\nadd a hook please`, and there is no `Skill` call.
  - `/simplify` is expanded the same way.
  - `/clear` makes no model call, and its `result` is `""`. The next `system/init` carries a different `session_id`.
  - `/hello there friend` returns the result `Unknown command: /hello` with no model call.
  - These reach the model as plain text: `/tmp/x.txt what is in this file?`, `  /compact` (leading spaces), `​/update-config …`, `!touch …` (no shell runs) and `#remember …`.
  - Binary: for an array the CLI takes the LAST text block as the command text, and its queued-message path `trim()`s before testing for `/`, so a leading space is not a safe neutralizer. JS `trim()` does not remove U+200B.
- **M9.** CLI command names, runner configuration with all four floors (telemetry, bundled skills, instruction files, background tasks) and no AX skill installed. The lists match with or without the two new floors.
  - Model-facing listing ("…available for use with the Skill tool:", `- name:` lines): `update-config, keybindings-help, simplify, fewer-permission-prompts, init, review, security-review`.
  - `system/init` `skills`: `update-config, debug, simplify, batch, fewer-permission-prompts`.
  - `system/init` `slash_commands`: `update-config, debug, simplify, batch, fewer-permission-prompts, clear, compact, context, heapdump, init, review, security-review, usage, insights, team-onboarding`.
  - Union (16): `batch, clear, compact, context, debug, fewer-permission-prompts, heapdump, init, insights, keybindings-help, review, security-review, simplify, team-onboarding, update-config, usage`.
- **M10.** One ordinary session leaves `.claude.json`, `backups/`, `projects/`, `sessions/` (and `skills/`) in the config dir. That is exactly what the boot guard must refuse in a reused dir.

## Boundary review

No service-hook signature change, no new subscriber hook, no IPC action or schema change. The `ConfigChange` hook is an SDK callback inside the claude-sdk runner, not an AX hook-bus hook. Say "no boundary review needed" in the PR body.

## Global Constraints

- Stay on SDK 0.2.119 / CLI 2.1.119. No upgrade, no `pnpm patch`, no new dependency.
- Edit only:
  - `packages/agent-runner-core`, `packages/agent-claude-sdk-runner`;
  - comment-only in `packages/tool-policy/src/rules.ts`;
  - prose-only in `scripts/__tests__/disabled-builtin-rail-drift.test.js`;
  - `docs/notes/2026-05-17-sdk-setting-sources-audit.md`, `.changeset/`, and TASK-1217 shards under `.claude/memory/<kind>/`;
  - test-fixture-only edits in `packages/agent-aisdk-runner` IF the full gate shows its suites reuse one config dir across boots.

  Never `packages/memory` (TASK-1210 in flight), `packages/skills`, or `packages/channel-web`.
- The boot guard never creates, modifies or deletes anything. It reads and refuses.
- Never echo an agent-influenced name or path into a log or refusal unless it matches the task's showable-name regex. The `ConfigChange` log prints only the `source` enum.
- Every real-SDK e2e builds its env with `stripClaudeCodeEnv()` (the scan in `real-sdk-env.test.ts` forbids `...process.env`). Use the production builders and hooks, never copies.
- Runner tests load runner-core from `dist`: after editing runner-core, run `pnpm --filter @ax/agent-runner-core build` before the claude-sdk runner suites.
- `--filter` goes BEFORE the script. The full gate is `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, plus `pnpm build` (tsc) and `pnpm lint`.
- Memory goes to TASK-1217 shards only (`scripts/memory-write-target.sh --shard <kind> TASK-1217`; `mkdir -p` the dir first; never name the variable `path`).
- Commit before any mutation-for-RED, then restore.

## Review Focus

1. **The boot guard is first, read-only and non-destructive.** Give it a planted dir (`settings.json`, `CLAUDE.md`, `.claude.json`, `projects`). It must exit 2 before the CA write, proxy, materialization, IPC client and loop, and every planted file must still be there afterwards (Task 1).
2. **A `skills` entry that is a symlink (into the agent home) or a regular file is refused.** A real `skills/` dir, including a 0555 one with content, is accepted (Task 1).
3. **An entry name with a newline or control characters is counted, never printed** (Task 1).
4. **The `ConfigChange` hook blocks every source and logs only the enum.** A session with no tampering never calls it (Tasks 3, 6).
5. **`keepSlashAsText` never mutates its input.** It leaves non-text blocks alone, handles `"  /clear"` and arrays (every text block), and leaves text that doesn't start with `/` byte-identical (Task 4).
6. **A projected skill named `simplify` is refused with the rename message; `weekly-report` still reaches the host.** `" /weekly-report "` still resolves (Task 5).
7. **Each env floor wins over a `providerEnv` credential-placeholder slot of the same name** (the `ax-cred:` value rule) (Task 2).
8. **Fixture changes don't weaken old assertions.** `main.test.ts` keeps asserting `${CONFIG_DIR}/projects` paths (Task 1).
9. **The agent-files canary still isolates `settingSources`.** Its `productionEnv` deliberately omits the instruction-files floor (Task 2).

---

## File map

| File | Task | Responsibility |
|---|---|---|
| `packages/agent-runner-core/src/config-dir-guard.ts` | 1, 8 | `assertConfigDirFresh` + header rationale |
| `packages/agent-runner-core/src/run-runner.ts` (~L413-425) | 1 | call it right after `assertConfigDirOutsideAgentHome` |
| `packages/agent-runner-core/src/index.ts` | 1 | export `assertConfigDirFresh` |
| `packages/agent-runner-core/src/__tests__/{config-dir-guard,run-runner}.test.ts` | 1 | unit + boot-order tests |
| `packages/agent-claude-sdk-runner/src/__tests__/main.test.ts` | 1, 2, 3, 4 | fresh config dir per test; wiring pins |
| `packages/agent-claude-sdk-runner/src/instruction-files-env.ts` (new) + test | 2 | `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` |
| `packages/agent-claude-sdk-runner/src/background-tasks-env.ts` (new) + test | 2 | `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` |
| `packages/agent-claude-sdk-runner/src/main.ts` | 2, 3, 4, 8 | env floors, `ConfigChange` hook, `keepSlashAsText`, comment fix |
| `…/__tests__/{agent-files-guards,bundled-skills,cron-scheduler}-real-sdk.e2e.test.ts` | 2 | keep their "like main.ts" env honest |
| `packages/agent-claude-sdk-runner/src/config-change.ts` (new) + test | 3 | `createConfigChangeHook` |
| `packages/agent-claude-sdk-runner/src/slash-text.ts` (new) + test | 4 | `keepSlashAsText` |
| `packages/agent-claude-sdk-runner/src/projected-skills.ts` + test, `pre-tool-use.test.ts` | 5, 8 | `CLI_COMMAND_NAMES`, collision refusal |
| `…/__tests__/scripted-model.ts` (new, test helper) | 6 | fake model server + session runner for the new e2e files |
| `…/__tests__/config-dir-next-session-real-sdk.e2e.test.ts` (new) | 6 | item 1 acceptance |
| `…/__tests__/config-dir-mid-session-real-sdk.e2e.test.ts` (new) | 6 | settings/skills reload, CLAUDE.md after compaction |
| `…/__tests__/zz-probe-settings-plant.e2e.test.ts` | 6 | DELETE (builder's temporary probe) |
| `…/__tests__/background-tasks-real-sdk.e2e.test.ts` (new) | 7 | item 4 |
| `…/__tests__/slash-text-real-sdk.e2e.test.ts` (new) | 7 | item 3 |
| `…/__tests__/bundled-skills-real-sdk.e2e.test.ts` | 7 | item 2 drift + collision |
| docs/notes audit, SECURITY.md, env.ts, tool-names.ts, rules.ts, drift test, changeset, memory shards | 8 | stale lines, security note, release note, learnings |

**Order:** Task 1, then Tasks 2 → 3 → 4 (serial: all three edit `main.ts`), then Task 5, Task 6 (needs 1, 2, 3), Task 7 (needs 2, 4, 5), and Task 8 last. Task 5 is independent of 2–4 and can go anywhere before 7.

---

### Task 1: The config dir must be fresh at boot [tier: sensitive]

**security-checklist: required.** This is the sandbox boundary: what the CLI loads as trusted configuration.

**Files:**
- Modify: `packages/agent-runner-core/src/config-dir-guard.ts`
- Modify: `packages/agent-runner-core/src/run-runner.ts` (the TASK-994 block at ~L413-425)
- Modify: `packages/agent-runner-core/src/index.ts`
- Test: `packages/agent-runner-core/src/__tests__/config-dir-guard.test.ts`, `packages/agent-runner-core/src/__tests__/run-runner.test.ts`
- Fixture: `packages/agent-claude-sdk-runner/src/__tests__/main.test.ts` (shared `CONFIG_DIR`, L190-196; the prepare-failure test at ~L1285)

**Spec.**
```ts
/** Shown in a refusal only when it matches; anything else is counted. */
const SHOWABLE_ENTRY_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_SHOWN = 8;

/**
 * Throws unless `env.claudeConfigDir` holds nothing but a plain `skills/`
 * directory (or nothing at all). Reads only: never creates, changes or deletes.
 */
export async function assertConfigDirFresh(
  env: Pick<RunnerEnv, 'claudeConfigDir'>,
): Promise<void>;
```
- `fs.readdir(dir)`. On error, throw `refusing to start: CLAUDE_CONFIG_DIR (${dir}) cannot be listed (${errno}), so it cannot be checked for leftovers.` Reuse the module's `errnoOf`.
- For an entry named `skills`, use `fs.lstat(path.join(dir, 'skills'))`, not the Dirent: some filesystems report `DT_UNKNOWN`. It is fine only when `isDirectory()` (a symlink is not). Otherwise it is a leftover, shown as `skills (not a plain directory)`.
- Every other entry is a leftover.
- If there are leftovers, throw:
  `refusing to start: CLAUDE_CONFIG_DIR (${dir}) is not fresh: it already holds ${n} unexpected ${n === 1 ? 'entry' : 'entries'} (${shown}). The sandbox gives every session a new one with nothing in it but skills/, so this one was used before. The Claude Code CLI loads what is in it as its own configuration (settings.json hooks and env, CLAUDE.md, MCP servers in .claude.json), so nothing an earlier session wrote may be there when it starts.`
  - `${shown}`: the showable names sorted, at most `MAX_SHOWN`, then `, and N more` for the rest. Unshowable names are only counted.
- Header comment: add a TASK-1217 paragraph. Cite M1/M3/M10 in one line each. Say why it refuses rather than resets:
  - a reset would delete whatever a misconfigured `CLAUDE_CONFIG_DIR` points at, e.g. a developer's real `~/.claude`;
  - it would hide a sandbox that started reusing dirs;
  - it can't vouch for `skills/` either.

  Also say it runs before anything writes into the dir.

**Wiring** (`run-runner.ts`, the existing try at ~L417):
```ts
    await assertConfigDirOutsideAgentHome(env);
    await assertConfigDirFresh(env);
```
Extend the comment above it with one sentence: the dir must also be fresh (TASK-1217). Export from `index.ts` next to the other runner-core exports (`export { assertConfigDirFresh } from './config-dir-guard.js';`). Task 6's e2e imports it from `@ax/agent-runner-core`.

- [ ] **Step 1: Write the failing unit tests** in `config-dir-guard.test.ts`, under a new `describe('assertConfigDirFresh (TASK-1217)')`, each with its own `mkdtemp` (realpath it):
  - accepts an empty dir;
  - accepts a dir holding only `skills/` with a skill folder inside, also when `skills/` is chmod 0555 (restore 0755 in `finally` before `rm`);
  - refuses each of `settings.json`, `CLAUDE.md`, `.claude.json`, a `projects/` dir, and a `projects` symlink to another temp dir. Each message starts `refusing to start: CLAUDE_CONFIG_DIR` and contains the entry name;
  - refuses a `skills` symlink to a real directory, and a regular file named `skills` (`/skills \(not a plain directory\)/`);
  - refuses 10 entries with exactly 8 names shown, sorted, plus `and 2 more`;
  - refuses an entry named `evil\nrunner: ok`: the message has `1 unexpected entry`, no `\n`, and no `runner: ok`;
  - is non-destructive: after a refusal, `readdir` returns the same names and the `projects` symlink's target dir still has its file;
  - a missing dir is refused with `cannot be listed (ENOENT)`.
- [ ] **Step 2: Run — expect FAIL** (`assertConfigDirFresh` is not exported): `pnpm --filter @ax/agent-runner-core exec vitest run src/__tests__/config-dir-guard.test.ts`
- [ ] **Step 3: Implement** `assertConfigDirFresh` to the spec, plus the export.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: The boot-order test** in `run-runner.test.ts`. Copy the TASK-994 test at ~L668. The new case is `refuses to start before any IPC or filesystem work when CLAUDE_CONFIG_DIR is not fresh (TASK-1217)`:
  - `cfg` is a temp dir OUTSIDE `files`, holding a `settings.json` with `{"hooks":{}}`;
  - expect code 2;
  - expect stderr matching `/not fresh/` and `/settings\.json/`;
  - expect none of these called: CA write, `setupProxy`, materialize, `createIpcClientMock`, `makeLoop`, `fakeClient.event`;
  - expect `readdir(cfg)` still to be `['settings.json']`.

  Add `boots when CLAUDE_CONFIG_DIR holds only skills/` if no existing happy-path case has a `skills/` dir present. Wire the call, then run `pnpm --filter @ax/agent-runner-core test`. Expect PASS.
- [ ] **Step 6: Fix the claude-sdk runner fixtures.**
  - `pnpm --filter @ax/agent-runner-core build`.
  - Run `pnpm --filter @ax/agent-claude-sdk-runner test`. `main.test.ts` shares one `CONFIG_DIR` across boots, and `prepareTranscriptDir` leaves `projects/` in it, so every boot after the first is now refused.
  - Add a top-level `beforeEach` that removes every entry of `CONFIG_DIR` except `skills` (`fs.rm(…, { recursive: true, force: true })`). Keep the path stable: tests assert `${CONFIG_DIR}/projects`.
  - The test at ~L1285 ("the transcript directory cannot be laid down") made `cfg/projects` a regular file, which the guard now refuses first. Keep its intent: the failure must come from `prepareSession`, after `session.get-config`. Use an empty `cfg` chmod 0555, so `mkdir cfg/projects` fails with EACCES (`it.skipIf(process.getuid?.() === 0)`), and restore 0755 in `onTestFinished`. Keep every other assertion (exit 2, no restore, no query).
- [ ] **Step 7: Run the other runner suites:** `pnpm --filter @ax/agent-claude-sdk-runner test` and `pnpm --filter @ax/agent-aisdk-runner test`. If an aisdk suite reuses one config dir across boots, apply the same `beforeEach` pattern. Fixture only.
- [ ] **Step 8: Commit.** `git commit -m "[TASK-1217] runner-core: refuse a config dir an earlier session could have written"`

---

### Task 2: Two more CLI env floors — instruction files and background tasks [tier: sensitive]

**security-checklist: required.** Both close measured holes: M6 (prompt injection persisting past compaction with "user instructions" framing) and M7 (unprompted turns).

**Files:**
- Create: `packages/agent-claude-sdk-runner/src/instruction-files-env.ts` with `buildInstructionFilesEnv(): Record<string, string>` returning `{ CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' }`.
- Create: `packages/agent-claude-sdk-runner/src/background-tasks-env.ts` with `buildBackgroundTasksEnv(): Record<string, string>` returning `{ CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' }`.
- Create: `src/__tests__/instruction-files-env.test.ts`, `src/__tests__/background-tasks-env.test.ts` (copy `bundled-skills-env.test.ts`: exact object, fresh object per call).
- Modify: `src/main.ts`: spread both right after `...buildBundledSkillsEnv(),` (L445), each with a 3-line comment, same floor contract.
- Modify: `src/__tests__/main.test.ts`:
  - in the env assertions next to the TASK-1207 ones (~L711-721), expect both vars `'1'`;
  - add a floor-order test next to ~L3775 with `ax-cred:` placeholder values for both names, and expect `'1'`.
- Modify (keep "like main.ts" honest):
  - `bundled-skills-real-sdk.e2e.test.ts:189` and `cron-scheduler-real-sdk.e2e.test.ts:197`: in the `likeMain` branch, spread `buildInstructionFilesEnv()` and `buildBackgroundTasksEnv()` after `buildBundledSkillsEnv()`;
  - `agent-files-guards-real-sdk.e2e.test.ts:259` (`productionEnv`): add ONLY `...buildBackgroundTasksEnv()`, plus a comment: *deliberately without `buildInstructionFilesEnv()`: this canary proves `settingSources: ['user']` alone keeps the home's CLAUDE.md and rules out; the floor would mask a regression in that gate, and it has its own e2e (`config-dir-mid-session-real-sdk.e2e.test.ts`). Its controls at ~L601-660 expect planted CLAUDE.md files to load, which the floor would also stop.*

**Header comments (the why; each module ≈ the size of `bundled-skills-env.ts`):**
- `instruction-files-env.ts` covers M6.
  - The CLI loads `CLAUDE.md`, `rules/*.md` and auto-memory `MEMORY.md` from `$CLAUDE_CONFIG_DIR` and frames them as the user's own instructions.
  - The agent's shell can write all of them (same uid).
  - A mid-session write isn't re-read per request, but it IS re-read after compaction, so injected text would outlive the compaction that drops the tool output it came from.
  - AX composes its own system prompt and writes no `CLAUDE.md`, so this switch removes nothing AX uses.
  - `CLAUDE_CODE_DISABLE_AUTO_MEMORY` is not needed (see M6).
  - Keep it on every CLI bump; re-run the e2e.
- `background-tasks-env.ts` covers M7.
  - Both `run_in_background` and the CLI's auto-background-at-timeout produce a `<task-notification>` that wakes the model for a turn no person or routine asked for, while the runner is warm.
  - With the switch, a command past its timeout is killed (exit 143). The model can use a longer `timeout` (max 10 min) or a shell `&` plus Read.
  - Interrupts are unaffected (no Bash interrupt→background path in 2.1.119).

- [ ] **Step 1: Write the two module unit tests** and the `main.test.ts` pins. Run: FAIL.
- [ ] **Step 2: Create the modules, wire `main.ts`, update the three e2e env mirrors.** Run `pnpm --filter @ax/agent-claude-sdk-runner test`. Expect PASS, including the three real-binary e2e files, which run when the native binary is installed (it is, locally and in CI). If `agent-files-guards` FIX or control cases change outcome, stop and investigate. Don't edit assertions to fit.
- [ ] **Step 3: Commit.** `git commit -m "[TASK-1217] claude-sdk runner: env floors for config-dir instruction files and background tasks"`

---

### Task 3: Freeze the CLI's configuration for the session (`ConfigChange`) [tier: sensitive]

**security-checklist: required.** It closes M5 (live skills-projection tamper) and backs up Task 1 for settings (M3).

**Files:**
- Create: `packages/agent-claude-sdk-runner/src/config-change.ts`
- Create: `src/__tests__/config-change.test.ts`
- Modify: `src/main.ts` `hooks` (L570-620): add `ConfigChange: [{ hooks: [createConfigChangeHook()] }]` after `PostToolUse`.
- Modify: `src/__tests__/main.test.ts`: pin that `options.hooks.ConfigChange[0].hooks[0]` returns `decision: 'block'` for `{ hook_event_name: 'ConfigChange', source: 'skills' }`.

**Spec.**
```ts
const KNOWN_SOURCES = new Set(['user_settings', 'project_settings', 'local_settings', 'policy_settings', 'skills']);

export function createConfigChangeHook(
  log: (line: string) => void = (l) => process.stderr.write(`${l}\n`),
): HookCallback;
```
- For a non-`ConfigChange` input, return `{}`.
- For a `ConfigChange` input:
  - log `runner: blocked a mid-session change to the CLI's ${source} (its configuration is fixed when the session starts)`, where `source` is the input's `source` if it is in `KNOWN_SOURCES`, else `unknown`. Never log `file_path`: it is agent-influenced;
  - return `{ decision: 'block', reason: "This session's configuration is fixed when it starts." }`.
- Header comment: M3, M4 and M5 in a few lines.
  - Nothing legitimate changes the CLI's configuration mid-session: both sandboxes write the projection before the CLI starts, and AX never writes settings.
  - The CLI can't be told to stop watching (only bare mode does that, and it drops AX skills), so blocking the reload is the control.
  - `policy_settings` can't be blocked by the CLI's design; it is root-owned and outside the sandbox.
  - The runner's name allowlist (`projected-skills.ts`) stays: it stops a planted folder from launching even if this hook ever regressed.

- [ ] **Step 1: Unit tests.**
  - Each known source gets `{decision:'block'}` and one log line naming that source.
  - A source of `'weird\nsource'` is logged as `unknown`, and the line has no newline.
  - The `file_path` value never appears in a log line.
  - A `PreToolUse` input returns `{}` and logs nothing.
  - Add the `main.test.ts` pin. Run: FAIL.
- [ ] **Step 2: Implement + wire.** Run `pnpm --filter @ax/agent-claude-sdk-runner test`: PASS.
- [ ] **Step 3: Commit.** `git commit -m "[TASK-1217] claude-sdk runner: block mid-session CLI config reloads (skills, settings)"`

---

### Task 4: A turn's text never becomes a CLI slash command [tier: sensitive]

**security-checklist: required.** This is untrusted input (a person, a Slack outsider, a routine prompt) reaching the CLI's command processor, outside `tool.pre-call`.

**Files:**
- Create: `packages/agent-claude-sdk-runner/src/slash-text.ts`
- Create: `src/__tests__/slash-text.test.ts`
- Modify: `src/main.ts` `userMessages()` (L256-276): `message: { role: 'user', content: keepSlashAsText(next.content) } as never`
- Modify: `src/__tests__/main.test.ts`: an inbox message `/clear` reaches the SDK prompt stream as `'​/clear'`; `hello` arrives unchanged; an attachment turn `[{type:'text',text:'/update-config x'}, …]` arrives with that text block prefixed. Echo matching is by uuid only (`main.ts:803-809`, `run-runner.ts:915-925`), so the fold tests stay green.

**Spec.**
```ts
/** U+200B ZERO WIDTH SPACE. JS `trim()` keeps it, so the CLI's queued-message check cannot strip it either. */
export const SLASH_TEXT_GUARD = '​';

/**
 * Returns `content` with SLASH_TEXT_GUARD in front of every text that would
 * otherwise start with `/` (after leading whitespace): a string, or each
 * `{ type: 'text', text }` block of an array. Everything else is returned as
 * is. Never mutates its input; returns the same reference when nothing changes.
 */
export function keepSlashAsText(content: unknown): unknown;
```
Header comment:
- What the CLI does with `/` (M8: expansion with no `Skill` call, `/clear` switches session id, unknown words swallowed).
- Why every slash and not just CLI names: nothing in AX offers `/` commands; the CLI's direct expansion skips `tool.pre-call`; the model can still open an AX skill through the `Skill` tool, which is checked.
- Why U+200B (a leading space doesn't survive the queued path's `trim()`; an array doesn't help because the CLI reads the last text block).
- The person's words and the display log are unchanged: only the CLI's copy carries the invisible character.
- The aisdk runner already treats `/` as text, so both runners now agree.

- [ ] **Step 1: Unit tests.**
  - `'/clear'` becomes `'​/clear'`.
  - `'  /compact'` becomes `'​  /compact'`.
  - `'hello /x'` and `''` come back unchanged (same reference).
  - In `[{type:'text',text:'/a'},{type:'image',…},{type:'text',text:'b'}]` only the first block changes; the input array and its blocks are not mutated (deep-equal to a pre-call clone).
  - `null`, a number, and `{}` are returned as is.
  - A block with a non-string `text` is left alone.
  - Run: FAIL.
- [ ] **Step 2: Implement + wire + `main.test.ts` pins.** Run `pnpm --filter @ax/agent-claude-sdk-runner test`: PASS.
- [ ] **Step 3: Commit.** `git commit -m "[TASK-1217] claude-sdk runner: a turn's text is never a CLI slash command"`

---

### Task 5: Refuse an AX skill whose name the CLI already answers to [tier: sensitive]

**security-checklist: required.** The `Skill` name is model-controlled input at the pre-call gate.

**Files:**
- Modify: `packages/agent-claude-sdk-runner/src/projected-skills.ts`
- Test: `src/__tests__/projected-skills.test.ts`, `src/__tests__/pre-tool-use.test.ts`

**Spec.**
```ts
/**
 * Every name the pinned CLI (2.1.119) answers to in the runner's configuration:
 * the model's skill listing ∪ `system/init` `skills` ∪ `system/init`
 * `slash_commands`, measured with no AX skill installed. An AX skill with one
 * of these names never runs: the CLI resolves the name to its own command
 * first. `bundled-skills-real-sdk.e2e.test.ts` (DRIFT) pins this list on every
 * CLI bump.
 */
export const CLI_COMMAND_NAMES: ReadonlySet<string> = new Set([
  'batch', 'clear', 'compact', 'context', 'debug', 'fewer-permission-prompts',
  'heapdump', 'init', 'insights', 'keybindings-help', 'review',
  'security-review', 'simplify', 'team-onboarding', 'update-config', 'usage',
]);
```
- In `skillRefusal`, after the `loadError` branch and BEFORE `if (name !== '' && projected.names.has(name)) return undefined;`, add:
  ```ts
  if (name !== '' && projected.names.has(name) && CLI_COMMAND_NAMES.has(name)) {
    return (
      `${label} can't be opened here, because the agent's toolkit has a built-in command ` +
      'with the same name and that would run instead. Ask the person to give the skill a different name.'
    );
  }
  ```
  A non-projected name keeps today's "not one of this agent's skills" refusal.
- Comment next to the set: aliases of built-in local commands (e.g. `/clear`'s) are not in those lists. The CLI refuses them through `Skill` itself ("is a built-in CLI command, not a skill"), so nothing runs in their place, and Task 4 keeps people from typing them.

- [ ] **Step 1: Tests.**
  - projected `{simplify, weekly-report}`: `simplify` → the rename refusal containing `"simplify"`; `/simplify` and `" simplify "` → the same;
  - `weekly-report` → `undefined`;
  - non-projected `update-config` → the old refusal;
  - `pre-tool-use.test.ts`: a projected `simplify` call is denied with the rename reason and `tool.pre-call` is NOT sent, while a projected `weekly-report` call is sent to the host (copy the TASK-1207 cases).
  - Run: FAIL.
- [ ] **Step 2: Implement.** Run `pnpm --filter @ax/agent-claude-sdk-runner test`: PASS.
- [ ] **Step 3: Commit.** `git commit -m "[TASK-1217] claude-sdk runner: refuse an AX skill shadowed by a built-in CLI command"`

---

### Task 6: Real-binary proof for item 1 (the card's acceptance) [tier: integration]

Depends on Tasks 1, 2, 3 (rebuild runner-core first).

**Files:**
- Create: `packages/agent-claude-sdk-runner/src/__tests__/scripted-model.ts`. A test helper, not a test, used only by the NEW e2e files; don't refactor existing ones. It needs:
  - a fake `/v1/messages` SSE server driven by a step script (`{ tool, input }` or text), recording `{ t, body, agentLoop }` per call. "agentLoop" means the request has `tools`;
  - a `session()` that runs `query()` like `main.ts`: `stripClaudeCodeEnv()`, the production floor builders (each toggleable per case), `settingSources: ['user']`, the `tools`/`disallowedTools` lists, `allowedTools: ['Skill']`, `extraArgs: { 'replay-user-messages': null }`, HOME=cwd=files, optional hooks;
  - turns sent one at a time (await each `result`, then yield the next), with stdin held open on a gate;
  - helpers for: tool_result texts, the last user block of a request, the `system/init` message(s).

  Skip the whole file when the native binary is missing (copy `nativeBinaryInstalled` from the cron e2e).
- Create: `src/__tests__/config-dir-next-session-real-sdk.e2e.test.ts`
- Create: `src/__tests__/config-dir-mid-session-real-sdk.e2e.test.ts`
- Delete: `src/__tests__/zz-probe-settings-plant.e2e.test.ts`

**Plants.** The model's own Bash writes them, like an injected agent would:
- `settings.json` holds `{ env: { PLANTED_T1217: 'yes' }, hooks: { SessionStart, UserPromptSubmit, PreToolUse → echo <tag> >> <marker file> } }`.
- `CLAUDE.md` and skill-body markers are built with `printf 'PLANTED-%s-T1217' X`, so the literal never appears in a `tool_use` input (contradiction 1).

**`config-dir-next-session-…` cases:**
- **CONTROL** (M1): session A on a fresh `cfg` plants `settings.json` and `CLAUDE.md` via Bash. Session B, a NEW `query()` on the SAME `cfg`: the marker file gets the SessionStart/UserPromptSubmit/PreToolUse tags, and Bash `echo "ENV=[$PLANTED_T1217]"` returns `ENV=[yes]`.
- **FIX** (the acceptance): after session A plants, `await expect(assertConfigDirFresh({ claudeConfigDir: cfg })).rejects.toThrow(/refusing to start: CLAUDE_CONFIG_DIR .* is not fresh/)`, so the runner never starts a CLI there (Task 1's run-runner test shows exit 2 with no IPC and no query). The session the sandbox actually gives next is a fresh `cfg2` with `skills/` only. `assertConfigDirFresh` resolves on it, and a session there shows an empty marker file and `ENV=[]`.

**`config-dir-mid-session-…` cases:**
- **Settings CONTROL** (M3): seed `cfg/settings.json` = `{}`, run without the production `ConfigChange` hook but with an observe-only `ConfigChange` hook (returns `{}`, records the event). Turn 1 plants. Wait until the observer saw `source: 'user_settings'`, plus ~300 ms. Turn 2 runs Bash `echo "ENV=[$PLANTED_T1217]"`. Expect the marker to contain `ups` and `pre`, and `ENV=[yes]`.
- **Settings FIX** (M4): same seed, but with `createConfigChangeHook()` (production) wrapped to record its calls. Wait until it was called. Expect the marker empty and `ENV=[]`. Also `assertConfigDirFresh` rejects the seeded dir: Task 1 refuses this dir before a CLI ever starts; this case proves the second layer on its own.
- **Skills CONTROL** (M5): project `weekly-report/SKILL.md` with body `ORIGINAL-SKILL-BODY-T1217` (dirs 0555, file 0444) and use the observer hook. Turn 1's Bash does `chmod -R u+w "$CLAUDE_CONFIG_DIR/skills"`, appends a `PLANTED-%s-T1217`/`SKILL` line to `weekly-report/SKILL.md`, and writes `evil/SKILL.md` whose description is `PLANTED-%s-T1217`/`DESC`. Wait for the observer's `source: 'skills'`. Turn 2's model calls `Skill({skill:'weekly-report'})`. Expect: a request lists `PLANTED-DESC-T1217`, and the request after the Skill call carries `PLANTED-SKILL-T1217`. Restore 0755 in teardown before `rm`.
- **Skills FIX** (M4): same, with the production hook and the production PreToolUse hook (`readProjectedSkills(cfg)` read BEFORE turn 1). Expect: no request ever carries `PLANTED-DESC-T1217` or `PLANTED-SKILL-T1217`, `Skill('weekly-report')` launches the original body (`ORIGINAL-SKILL-BODY-T1217` present), and the hook was called with `source: 'skills'`.
- **Instruction files CONTROL** (M6): write `cfg/CLAUDE.md` = `ORIGINAL-MEMORY-T1217` before start, without `buildInstructionFilesEnv()`. Turn 1's Bash appends a `PLANTED-%s-T1217`/`LIVE` line. Turn 2 is `/compact` (raw: this case measures the CLI, not the runner). Turn 3 is `third`. Expect turn 1's first request to carry `ORIGINAL-MEMORY-T1217`, and turn 3's request to carry `PLANTED-LIVE-T1217`.
- **Instruction files FIX:** the same with `buildInstructionFilesEnv()`. Expect no request ever to carry either marker.
- **No interference:** in the Skills FIX session, before turn 1's Bash, the hook was not called. Optionally add a one-turn plain session asserting zero `ConfigChange` calls.

Timing: wait on hook signals, not fixed sleeps, with a hard cap (e.g. 15 s) and a clear failure message. Per-case timeouts as in the cron e2e (`60_000`).

- [ ] **Step 1: Write the helper and both files. Run each file and confirm every CONTROL passes** (each proves its plant is live on this binary): `pnpm --filter @ax/agent-claude-sdk-runner exec vitest run src/__tests__/config-dir-next-session-real-sdk.e2e.test.ts src/__tests__/config-dir-mid-session-real-sdk.e2e.test.ts`
- [ ] **Step 2: Mutation check** (commit first). Remove each control in turn and confirm the matching FIX goes red, then restore:
  - the `assertConfigDirFresh` call (or make it resolve);
  - the `ConfigChange` entry in the FIX config;
  - `buildInstructionFilesEnv()` from the FIX env.

  Record the results in the PR body.
- [ ] **Step 3: Delete `zz-probe-settings-plant.e2e.test.ts`.** Run the package suite: PASS.
- [ ] **Step 4: Commit.** `git commit -m "[TASK-1217] e2e: a planted config dir never reaches the next session or this one"`

---

### Task 7: Real-binary proof for items 2–4 [tier: integration]

Depends on Tasks 2, 4, 5.

**Files:**
- Create: `src/__tests__/background-tasks-real-sdk.e2e.test.ts` (uses `scripted-model.ts`)
- Create: `src/__tests__/slash-text-real-sdk.e2e.test.ts` (uses `scripted-model.ts`)
- Modify: `src/__tests__/bundled-skills-real-sdk.e2e.test.ts`

**`background-tasks-…` cases (M7).** Unprompted = an agent-loop call after the turn's `result` while the prompt stream is gated.
- **CONTROL** (without `buildBackgroundTasksEnv()`):
  - (a) the model's `Bash {command:'sleep 1; echo BG-T1217', run_in_background:true}` leads to an unprompted call whose last user block contains `<task-notification>`;
  - (b) `Bash {command:"bash -c 'sleep 3; echo LATE-T1217'", timeout:1000}` returns a tool_result containing `running in background`, followed by an unprompted `<task-notification>` call.

  Record time-to-first-unprompted-call, like `controlFirstFireMs` in the cron e2e.
- **FIX** (like main.ts):
  - the first agent-loop request's `Bash` `input_schema.properties` has no `run_in_background`;
  - (a) the tool_result is is_error and contains `run_in_background`;
  - (b) the tool_result contains `Exit code 143`;
  - for both, zero unprompted calls over `max(5 s, 3× CONTROL)` (capped).

**`slash-text-…` cases (M8).** Sequential turns:
- **CONTROL**, raw strings:
  - `/update-config add a hook please`: the last user block of that turn's request contains `## User Request`;
  - `/clear`: no agent-loop call for that turn, and a later `system/init` has a different `session_id`;
  - `/hello there friend`: the result is `Unknown command: /hello`, with no agent-loop call for that turn.
- **FIX**: every prompt passes through `keepSlashAsText` (the real export). Expect:
  - each turn makes exactly one agent-loop call whose last user block text is `'​' + original`;
  - no `## User Request` appears;
  - every `system/init` carries the same `session_id`;
  - no result is `Unknown command…`.

**`bundled-skills-…` additions (item 2).**
- **DRIFT** (in an existing like-main case, so no new session): compute `listing ∪ init.skills ∪ init.slash_commands`, minus the projected names (`weekly-report`), and `expect([...union].sort()).toEqual([...CLI_COMMAND_NAMES].sort())`. Parse the listing from the first agent-loop request: the text block containing `The following skills are available for use with the Skill tool`, names from lines matching `/^- ([a-z0-9:-]+):/m`. The failure message must say: "the CLI's command names changed — update CLI_COMMAND_NAMES and re-check Task 5's refusal".
- **Collision CONTROL**: a SEPARATE `cfg` projects `simplify/SKILL.md` (frontmatter `name: simplify`, body `AX-SIMPLIFY-T1217`), likeMain env, NO PreToolUse hook. The model's `Skill({skill:'simplify'})` launches, and the next request carries the bundled body (contains `Review changed code for reuse`) and NOT `AX-SIMPLIFY-T1217`. This is the TASK-1207 known hole, re-pinned.
- **Collision FIX**: the same `cfg` with the production PreToolUse hook (`readProjectedSkills(cfg)`). The tool_result is is_error and contains `give the skill a different name`, and neither marker reaches the model. Keep `simplify` OUT of the DRIFT case's projection: subtracting it would hide the name from the union.

- [ ] **Step 1: Write the files. Run each and confirm every CONTROL passes.**
- [ ] **Step 2: Mutation check** (commit first). Drop `buildBackgroundTasksEnv()` from the FIX env; skip `keepSlashAsText` in the FIX; remove the collision branch. Each matching FIX must go red. Restore and record.
- [ ] **Step 3: Run** `pnpm --filter @ax/agent-claude-sdk-runner test` (and the `real-sdk-env.test.ts` scan): PASS.
- [ ] **Step 4: Commit.** `git commit -m "[TASK-1217] e2e: background tasks, slash text and shadowed skill names on the real binary"`

---

### Task 8: Stale lines, security note, rail prose, release note, memory [tier: mechanical]

**Files and edits.** Prose only; no behavior.
- `docs/notes/2026-05-17-sdk-setting-sources-audit.md`. Add a dated block under the TL;DR: "**Correction 2026-11-23 (TASK-1217):** the agent's shell runs as the same user as the CLI and CAN write `<USER_ROOT>`; nothing is symlinked from host code any more (k8s: a per-pod tmpfs; subprocess: a per-session temp dir)." Name what keeps those writes inert: Task 1's freshness guard, Task 3's `ConfigChange` block, Task 2's instruction-files floor. Then amend `:40-44`, the `:67` stance cell and `:77-80` to match.
- `packages/agent-claude-sdk-runner/SECURITY.md`:
  - `:7` and `:64`: replace "runner-private" with "private to the session and outside the agent's home, but writable by the agent's shell (same user)", plus the three controls;
  - `:57`: the `Monitor`/`TaskOutput`/`TaskStop` clause. Background tasks are off (`buildBackgroundTasksEnv()`); Read and Bash still read files and stop processes;
  - `:120-121`: rewrite "Two ways a bundled skill still runs": both are closed (Task 5 refusal, Task 4 text guard). Name the residual: creation-time reservation is a follow-up;
  - add a `### TASK-1217` Sandbox / Injection / Supply chain section from the security-checklist walk.
- `packages/agent-claude-sdk-runner/src/main.ts:637`: the same "runner-private" correction, one or two lines.
- `packages/agent-runner-core/src/env.ts:55`: "The runner-private directory…" becomes "The per-session directory (outside the agent's home; the agent's shell can still write it, see `assertConfigDirFresh`)…".
- `packages/agent-claude-sdk-runner/src/projected-skills.ts:18`: "nothing rewrites it mid-session" becomes "the agent's shell can rewrite it (same user), but the CLI's reload is blocked (`config-change.ts`), and this snapshot of NAMES is what the allowlist trusts".
- `packages/agent-claude-sdk-runner/src/tool-names.ts:156`: "Bash's own `run_in_background` stays" becomes "background tasks are off (`buildBackgroundTasksEnv()`)".
- `packages/tool-policy/src/rules.ts:156-160`: replace the `run_in_background` sentence. Background tasks are off, so a finished command no longer wakes the model; a shell `(sleep 600; …) &` and a connector's own API still start work later, so "Cannot schedule work for later" would still be false. Do NOT change the clause, id or order.
- `scripts/__tests__/disabled-builtin-rail-drift.test.js`:
  - header `:29`: the same correction;
  - `OFF_RAIL` `Monitor.why`: "watches a background command; a shell `cmd &` plus Read can still watch one, so a Cannot row would understate reach (H4)";
  - `TaskOutput.why`: "reads a background task's output; background tasks are off, and Read still reads any file";
  - `TaskStop.why`: "stops a background task; background tasks are off, and Bash still stops processes".
- `.changeset/sdk-config-dir-readonly.md`: `'@ax/agent-runner-core': patch`, `'@ax/agent-claude-sdk-runner': patch`. Voice: plain and "we". Say:
  - a session won't start on a config folder an earlier session could have written;
  - the CLI's settings and skills can't be changed mid-session;
  - agent-written instruction files are never loaded;
  - long commands no longer wake the agent later (they stop at their timeout);
  - a message starting with `/` is read as words;
  - a skill named like a built-in command gets a "please rename" answer.
- Memory shards (`scripts/memory-write-target.sh --shard <kind> TASK-1217`; `mkdir -p` first):
  - **context:** M3, M5, M6, M7, M8 and the four controls. A row SUPERSEDING the TASK-1207 context row (r2) that says `run_in_background` is "kept on purpose".
  - **patterns:**
    - (a) A marker that appears in a `tool_use` input is in every later request body. Build markers from parts (`printf 'X-%s-Y' Z`) before claiming a live re-read.
    - (b) Settings hot reload needs the settings file to exist at CLI start; a `ConfigChange` SDK hook returning `{decision:'block'}` freezes settings and skills mid-session.
    - (c) Send turns one at a time in real-binary probes: yielding prompts together folds or coalesces them.
  - **mistakes:** the planner's/builder's live-re-read misreading (contradiction 1) as a one-line lesson.

- [ ] **Step 1: Make the edits.** Run `pnpm build && pnpm lint`, then the full gate: `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`.
- [ ] **Step 2: Commit.** `git commit -m "[TASK-1217] docs: the config dir is the agent's to write, and what keeps that inert"`

---

## Follow-ups (return to the orchestrator; not in this PR)

1. **Reserve CLI command names when an AX skill is CREATED** (card item 2's literal ask). There is no single choke point: `skills:upsert` (`packages/skills/src/plugin.ts:405`), `catalog:admit` (`:882`) and `skills:propose` (`:1018`) each parse on their own.
   - A parser-level rule would hide EXISTING skills: agents' authored-caps projection drops them, aisdk's skills-index skips them, and `SkillForm` blocks Save.
   - It needs a create-only check in all three, like `assertConnectorIdCreatable` (`connectors/src/store.ts:58-66`).
   - It needs a list home the host can read: `@ax/skills-parser` is a plain library, but neither runner depends on it today.
   - It needs UI copy plus `BAD_REQUEST_CODES` / `STRUCTURAL_REJECT_CODES` entries.
   - Task 5's runner refusal already stops the bundled skill from running in place of AX's.
2. **Card item 5:** on deploy, check prod homes for `.claude/scheduled_tasks.json` (needs prod access and Vinay's OK).
3. **Unverified, worth a card:** the transcript working copy (k8s `/tmp/transcripts`, subprocess `$CLAUDE_CONFIG_DIR/projects`) is agent-writable, and the runner ships it to the host store, which a later session resumes from. A forged `user` line appended there could persist into later sessions. Probe before designing.
4. **Unmeasured:** whether the CLI re-reads `$CLAUDE_CONFIG_DIR/.claude.json` mid-session. It is believed startup-only, and Task 1 keeps a planted one out of a new session.
