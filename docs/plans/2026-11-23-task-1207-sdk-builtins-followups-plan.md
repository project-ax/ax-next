# TASK-1207: SDK built-ins follow-ups (rail deny rows, bundled skills, e2e env strip) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** These are the TASK-1200 follow-ups.
- The rail says the scheduling denial out loud, and it accounts for every other denied SDK built-in in writing.
- The claude-sdk runner's agent can no longer see `loop`/`claude-api` or invoke any skill AX didn't install.
- No real-SDK e2e test hands the CLI its parent Claude Code env.

**Architecture:**
- **Item 1 (`@ax/tool-policy`, the drift guard).** It adds one deny row, `builtins.cron-create`. It widens the drift guard from `DISABLED_BUILTINS` to the runner's full denied set: every denied name is a rail row or an `OFF_RAIL` entry with a written reason.
- **Item 2 (`@ax/agent-claude-sdk-runner` only).**
  - Two CLI env switches remove `loop` and `claude-api`.
  - The PreToolUse hook refuses any `Skill` whose name isn't a folder in AX's skill projection.
- **Item 3 (test-only).** A shared `stripClaudeCodeEnv()` helper, plus a source scan that forbids `...process.env` in real-SDK e2e files.

No hook, IPC action or schema changes.

**Tech Stack:** TypeScript, vitest. It runs on the pinned `@anthropic-ai/claude-agent-sdk` 0.2.119 / `claude` CLI 2.1.119 native binary. There's no new dependency.

**Spec:** card TASK-1207, `/private/tmp/claude-501/-Users-vpulim-dev-ai-ax-next/b9feba9b-916e-4979-b5be-adabf94d3c15/scratchpad/TASK-1207/card.md`. Items 1–3 are planned. Item 4 (the live re-walk) is not: walk TASK-1205 already passed it.
- **Read first:** the planner's decisions, `.claude/memory/decisions/2026-11-23-TASK-1207.md`, and TASK-1200's shards, `.claude/memory/{decisions,patterns}/2026-11-22-TASK-1200.md`.
- Append your own rows to the TASK-1207 shard, never to a root archive.

## The premise, checked

- **Item 1 is half true.** The rail has 4 `builtins.*` rows. The runner denies 24 names: `KNOWN_SDK_BUILTINS` (33) minus `ALLOWED_SDK_BUILTINS` (9), see `tool-names.ts:158-232`.
  - **But a deny row renders "Cannot X"** (`channel-web/src/lib/permission-frames.ts:54`). For six of the 20, that sentence would be FALSE, because an allowed tool still does the same thing:
    - Monitor, TaskOutput and TaskStop: Bash and Read still can.
    - NotebookEdit: Edit and Write still can.
    - EnterWorktree and ExitWorktree: Bash `git` still can.
  - A false "Cannot" understates reach, the direction design H4 forbids. The rest are:
    - UI modes: plan mode.
    - Aliases or companions: `Agent` is `Task` on the wire; Cron*/ScheduleWakeup/RemoteTrigger are scheduling; Team*/SendMessage are helper agents.
    - Inert in an AX session: PushNotification.
    - MCP-resource readers the rail has no word for.
  - **So:** one new row (scheduling, the TASK-1192 walk bug). Every other denied name gets a written reason the guard enforces. Decision row 1.
- **Item 1 needs no channel-web or @ax/decisions edits.** Their rail pins are mock fixtures: `routes-workspace-rail.test.ts:89-94`, `AgentRail.test.tsx:97`. `decisions.canary.test.ts:219` takes the FIRST deny rule, which stays `builtins.web-fetch`. That leaves TASK-1214 (channel-web) untouched.
- **Item 2 is true, measured on the real binary** (see below). `loop`'s body says "Call CronCreate with:" and uses `ScheduleWakeup` for dynamic mode.
- **Item 3 is true.** These three spread `...process.env` into the CLI env:
  - `connector-mcp-real-sdk.e2e.test.ts:230`;
  - `fold-replay-real-sdk.e2e.test.ts:143`;
  - `interrupt-real-sdk.e2e.test.ts:212`.

  These two are already clean:
  - `tool-allowlist` has a local `cleanEnv`, `:145-152`;
  - `agent-files-guards` builds its env from helpers, `:246-264`.

  `artifact-publish-e2e.test.ts` never spawns the CLI.

## What made the card look true (stale lines this plan corrects)

- `packages/tool-policy/src/rules.ts:76-80`: the "KNOWN GAP (TASK-1200)" comment calls 4-of-~20 a gap to widen with rows. That premise is wrong for 19 of the 20. Task 2 rewrites it.
- `scripts/__tests__/disabled-builtin-rail-drift.test.js:1-3, 11-13, 67-73`: "four `builtins.*` deny rows", plus pointers to KNOWN GAP. Task 2.
- `packages/tool-policy/src/rules.ts:361-364`: "the claude-sdk runner passes through the SDK's own set, which is a superset". This has been false since TASK-1200. Task 2.
- `packages/tool-policy/src/__tests__/rules.test.ts:144-147`: "exactly the four SDK builtins we disable". Task 2.
- `packages/agent-claude-sdk-runner/src/tool-names.ts:33-38, 283-290`: says the guard reads `DISABLED_BUILTINS`. Task 2.
- `tool-names.ts:61-65`: "Hiding bundled skills is a follow-up." Task 4.
- `packages/agent-claude-sdk-runner/SECURITY.md:117`: "What we have NOT audited is the CLI's bundled skills … they can only point the model at tools it no longer has". That's false for `update-config`, which points at Write/Edit of a settings file nothing loads. Task 4.
- `packages/agent-claude-sdk-runner/src/main.ts:609-612`: "the CLI's bundled skills ship in the binary". Task 4.
- Root memory archive `context.md` rows "4 denies" are frozen (rule R2). Don't edit them. Task 5 writes a context shard instead.

## Measured on the pinned binary (do not re-derive)

These are planner probes against CLI 2.1.119, configured like `main.ts`: `tools` allowlist, `disallowedTools`, `settingSources: ['user']`, telemetry flags, parent env stripped, and one user skill `weekly-report` in `$CLAUDE_CONFIG_DIR/skills/`.

**Default state:**
- `system/init` `skills`: `update-config, debug, simplify, batch, fewer-permission-prompts, loop, claude-api, weekly-report`.
- The model-facing listing (system-reminder "…skills are available for use with the Skill tool"): `update-config, keybindings-help, simplify, fewer-permission-prompts, loop, claude-api, weekly-report, init, review, security-review`.

**Switches that work:**
- `CLAUDE_CODE_DISABLE_CRON=1` takes `loop` out of both lists. `Skill({skill:'loop'})` then returns is_error `<tool_use_error>Unknown skill: loop</tool_use_error>`, and the PreToolUse hook is never called.
  - Its gate is `!CLAUDE_CODE_DISABLE_CRON && flag("tengu_kairos_cron")`.
  - The same gate covers only cron things: the three Cron tools (already excluded), cron restore, a cron tip, the interactive scheduler and dream's schedule mode.
- `CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL=1` takes `claude-api` out.
- A PreToolUse hook sees `{tool_name:'Skill', tool_input:{skill:'/init'}}` verbatim, leading `/` included. A `permissionDecision:'deny'` reason arrives as an is_error tool_result. An allowed AX skill returns `Launching skill: weekly-report`.
- **Naming.** The CLI lists a user skill by FOLDER name. `Skill('<frontmatter name>')` also resolves when they differ. AX guarantees folder == name: `skills-parser/src/manifest.ts:295` sets `id: name`, and connector bundles use `connector-union.ts:968,1010`.

**Dead ends (all rejected, see the decisions shard):**
- `settings.skillOverrides` with `'off'` changes nothing: the CLI's resolver is compiled to `return "on"`.
- The session `skills` allowlist exists only on the control-protocol initialize request, and `query()` in SDK 0.2.119 never sends it.
- `CLAUDE_CODE_ENTRYPOINT=local-agent` drops all bundled skills, but it also switches on the CLI's subprocess env scrub and MCP env allowlist.
- `CLAUDE_CODE_SIMPLE=1` drops AX's user skills too.

## Boundary review

No service-hook signature changes, no new subscriber hook, no IPC change. `tool-policy:list-capabilities` returns one more row of the existing shape, so no boundary review is needed. Say so in the PR body.

## Global Constraints

- Stay on SDK 0.2.119 / CLI 2.1.119: no upgrade, no `pnpm patch`, no new dependency.
- Edit only `packages/tool-policy`, `packages/agent-claude-sdk-runner`, `scripts/__tests__/disabled-builtin-rail-drift.test.js`, `.changeset/` and `.claude/memory/<kind>/` shards. Nothing in `packages/channel-web` or `packages/decisions`.
- The four existing `builtins.*` rows keep their ids, clauses and order. The new row goes after them.
- Every rail clause passes `capability-lint.ts`: at most 60 chars, no verdict words (`can`, `never`, `first`, `on its own`, …), no `_`, backtick or camelCase.
- No real-SDK e2e test spreads `process.env` into the CLI env. Use `stripClaudeCodeEnv()`.
- Model-controlled strings are interpolated into a refusal only if they match `^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$`.
- Memory goes to shards only. Commit before any mutation-for-RED, then restore (TASK-408 lesson: `git checkout --` drops uncommitted edits).
- Test commands: `pnpm --filter <pkg> …` puts `--filter` BEFORE the script. The full gate is `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`.

## Review Focus

1. **A `Skill` call with surrounding whitespace or a leading `/`** (`" /weekly-report "`). It must still resolve to the installed AX skill, not be refused. The test is in Task 4 (`skillRefusal` normalization).
2. **A model-supplied `skill` that is not a string, is empty, is 200 chars, or contains a newline plus markdown.** The refusal must not echo the raw value into the transcript. Task 4.
3. **A session with no skills installed** (`$CLAUDE_CONFIG_DIR/skills` missing). Boot must not crash and must log nothing, and every `Skill` call is refused. Task 4 (the missing-dir reader test, and the "no projection passed" pre-tool-use test).
4. **A connector's usage-note bundle**, which is a projected folder too. It must stay invocable through `Skill`. Task 4 (a reader test with two folders) and Task 5 (the e2e allows a projected skill).
5. **The deny group on the rail grows by exactly one line.** It's the new clause, after the four, with no effect badge. Task 2 (`rules.test.ts` order and clause pins). The canary in `tool-policy.canary.test.ts:86-102` already keeps every deny row.

---

## File map

| File | Task | Responsibility |
|---|---|---|
| `packages/agent-claude-sdk-runner/src/__tests__/real-sdk-env.ts` (new) | 1 | `stripClaudeCodeEnv()`, the test-only env helper |
| `packages/agent-claude-sdk-runner/src/__tests__/real-sdk-env.test.ts` (new) | 1 | helper unit test and the no-`...process.env` scan |
| `…/__tests__/{tool-allowlist,connector-mcp,fold-replay,interrupt}-real-sdk.e2e.test.ts` | 1 | adopt the helper |
| `packages/tool-policy/src/rules.ts` | 2 | the new row and the rewritten comments |
| `packages/tool-policy/src/__tests__/rules.test.ts` | 2 | pins |
| `scripts/__tests__/disabled-builtin-rail-drift.test.js` | 2 | full denied set and `OFF_RAIL` accounting |
| `packages/agent-claude-sdk-runner/src/tool-names.ts` | 2, 4 | comments only |
| `packages/agent-claude-sdk-runner/src/bundled-skills-env.ts` (new) + test | 3 | the two CLI switches |
| `packages/agent-claude-sdk-runner/src/main.ts` | 3, 4 | env spread; read the projection; pass it to the hook |
| `…/__tests__/main.test.ts` | 3, 4 | wiring pins |
| `…/__tests__/agent-files-guards-real-sdk.e2e.test.ts:246-264` | 3 | keep the `productionEnv` mirror of main.ts honest |
| `packages/agent-claude-sdk-runner/src/projected-skills.ts` (new) + test | 4 | `readProjectedSkillNames`, `skillRefusal` |
| `packages/agent-claude-sdk-runner/src/pre-tool-use.ts` + test | 4 | the `Skill` refusal branch |
| `packages/agent-claude-sdk-runner/SECURITY.md:117` | 4 | the known-scope-limits line |
| `…/__tests__/bundled-skills-real-sdk.e2e.test.ts` (new) | 5 | real-binary proof for item 2 |
| `.changeset/sdk-builtins-followups.md` (new), memory shards | 5 | release note, learnings |

Order: Task 1 → Task 2 (independent) → Task 3 → Task 4 → Task 5. Task 5 needs Tasks 1, 3 and 4.

---

### Task 1: One parent-env strip for every real-SDK e2e test [tier: integration]

**Files:**
- Create: `packages/agent-claude-sdk-runner/src/__tests__/real-sdk-env.ts`
- Create: `packages/agent-claude-sdk-runner/src/__tests__/real-sdk-env.test.ts`
- Modify:
  - `…/__tests__/tool-allowlist-real-sdk.e2e.test.ts:138-152` (delete the local `cleanEnv`, import the helper) and `:190`;
  - `…/__tests__/connector-mcp-real-sdk.e2e.test.ts:230`;
  - `…/__tests__/fold-replay-real-sdk.e2e.test.ts:143`;
  - `…/__tests__/interrupt-real-sdk.e2e.test.ts:212`.

**Interfaces:**
- Produces: `export function stripClaudeCodeEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined>`.
  - It returns a NEW object without `CLAUDECODE`, any `CLAUDE_*` key or any `ANTHROPIC_*` key, and never mutates its input.
  - Move the existing `cleanEnv` docstring onto it (`tool-allowlist…:138-144`, the agent-teams measurement). Add one line: a parent `CLAUDE_CODE_USE_BEDROCK`/`_VERTEX` or `CLAUDE_CODE_ENTRYPOINT` would also reroute or re-identify the CLI.
  - The file is not a `*.test.ts`, so vitest won't collect it. `tsconfig` excludes `__tests__`, so it never ships.

- [ ] **Step 1: Write the failing tests** in `real-sdk-env.test.ts`:
  - `it('drops every variable that steers a Claude Code CLI and keeps the rest')`: input `{CLAUDECODE:'1', CLAUDE_CODE_ENTRYPOINT:'cli', CLAUDE_CODE_USE_BEDROCK:'1', CLAUDE_CONFIG_DIR:'/parent/cfg', ANTHROPIC_BASE_URL:'https://parent.example', ANTHROPIC_MODEL:'parent-model', PATH:'/usr/bin', HOME:'/home/me', TMPDIR:'/tmp/x'}`. Expect `toEqual({PATH:'/usr/bin', HOME:'/home/me', TMPDIR:'/tmp/x'})`.
  - `it('does not mutate its input')`.
  - `it('no real-SDK e2e test hands the CLI the parent process env')`:
    - Read this directory (`fileURLToPath(new URL('.', import.meta.url))`) for files matching `/real-sdk.*\.e2e\.test\.ts$/`.
    - `expect(files.length).toBeGreaterThanOrEqual(5)`, the non-vacuity floor.
    - For each, `expect(source, file).not.toMatch(/\.\.\.\s*process\.env\b/)`.
- [ ] **Step 2: Run, expect RED.** Run `pnpm --filter @ax/agent-claude-sdk-runner exec vitest run src/__tests__/real-sdk-env.test.ts`. Expected: the helper cases fail (module missing). After you add the helper, the scan fails naming connector-mcp, fold-replay and interrupt. Paste that RED output in the PR body: it's the test that would have caught the bug.
- [ ] **Step 3: Implement the helper.** In the four e2e files, replace `...process.env` (and `...cleanEnv()`) with `...stripClaudeCodeEnv()`. Explicit overrides like `PATH` for the keychain stub stay as they are.
- [ ] **Step 4: Run GREEN, including the real binary.** Run `pnpm --filter @ax/agent-claude-sdk-runner exec vitest run src/__tests__/real-sdk-env.test.ts src/__tests__/tool-allowlist-real-sdk.e2e.test.ts src/__tests__/connector-mcp-real-sdk.e2e.test.ts src/__tests__/fold-replay-real-sdk.e2e.test.ts src/__tests__/interrupt-real-sdk.e2e.test.ts`. Expected: all pass, and the e2e cases are NOT skipped (the darwin-arm64 binary is installed in this worktree). Run it from inside your Claude Code session, which is exactly the leaky environment.
- [ ] **Step 5: Commit** `[TASK-1207] Real-SDK e2e tests: one parent Claude Code env strip, and a scan that forbids spreading process.env`.

### Task 2: The rail states the scheduling denial and accounts for every denied built-in [tier: sensitive]

Run `security-checklist` for this task: it's a consent-surface claim, and the orchestrator requires it. Enforcement doesn't change: these rows never fire, because the runner classifier refuses first. The one exception is that `tool-policy:evaluate('CronCreate')` now answers deny instead of falling through to allow, which is defence in depth.

**Files:**
- Modify `packages/tool-policy/src/rules.ts`:
  - `:51-80`, the deny-block comment, which loses the KNOWN GAP;
  - insert the new rule after `:121`;
  - `:361-374`, the sandbox-floor comment.
- Modify `packages/tool-policy/src/__tests__/rules.test.ts:144-161`, `:297-309`.
- Modify `scripts/__tests__/disabled-builtin-rail-drift.test.js` (whole file).
- Modify `packages/agent-claude-sdk-runner/src/tool-names.ts:33-38`, `:275-291` (comments only).

**Interfaces:**
- Produces this rule, exactly:
  ```ts
  { id: 'builtins.cron-create', match: { tool: 'CronCreate' }, providedBy: 'sandbox', verdict: 'deny',
    capability: 'set itself to run again later outside routines', subject: 'agent', provenance: 'rule' }
  ```
  It renders as "Cannot set itself to run again later outside routines", next to "Can create routines — asks you first".
  (Narrowed in review from "schedule work for later outside routines". Bash `(sleep N; ...) &` and a connector's own API can still start work that runs later, so that "Cannot" was false. What is gone is the agent setting itself to run again.)

- [ ] **Step 1: Write the failing pins** in `rules.test.ts`:
  - Rename the `:144` case to `'the builtins.* denies name exactly the five SDK built-ins the rail describes'`.
    - Expected sorted tools: `['AskUserQuestion','CronCreate','Task','WebFetch','WebSearch']`. Every `builtins.*` rule has verdict `deny`.
    - Rewrite its comment: it pins; the guard checks drift.
  - New case `'states the scheduling denial after the four, without moving the first deny'`:
    - The `builtins.cron-create` rule `toMatchObject` the object above.
    - The deny ids in table order equal `['builtins.web-fetch','builtins.web-search','builtins.task','builtins.ask-user-question','builtins.cron-create']`. The first deny is pinned because `@ax/decisions`' canary takes it.
    - `lintCapability('set itself to run again later outside routines')` returns `[]`.
  - Add `'CronCreate'` to the `by('sandbox')` list at `:297`.
- [ ] **Step 2: Rewrite the guard (RED first).** In `disabled-builtin-rail-drift.test.js`:
  - **Parsers.**
    - A generic `arrayLiteral(src, name)` that THROWS on a miss (the existing message style).
    - `claudeSdkDeniedBuiltins()` = `[...new Set([...KNOWN_SDK_BUILTINS, ...DISABLED_BUILTINS])]` minus `ALLOWED_SDK_BUILTINS`, all three read from `tool-names.ts`. This mirrors `DENIED_SDK_BUILTINS`, which is computed, not a literal.
    - `railBuiltinDenyRows()` returns `{id, tool}[]`.
    - Keep `aisdkRegisteredBuiltins()` unchanged.
  - **`OFF_RAIL`**, a frozen object: name → `{ coveredBy?: string, why: string }`, with exactly these 19 entries:
    - `Agent` → `builtins.task`: "Task's name on the wire; the Task row already says it".
    - `TeamCreate` → `builtins.task`: "starts a team of helper agents".
    - `TeamDelete` → `builtins.task`: "disbands a team only TeamCreate could start".
    - `SendMessage` → `builtins.task`: "messages helper agents only Agent or TeamCreate could start".
    - `CronDelete` → `builtins.cron-create`: "cancels a schedule only CronCreate could make".
    - `CronList` → `builtins.cron-create`: "lists schedules only CronCreate could make".
    - `ScheduleWakeup` → `builtins.cron-create`: "a timer that wakes this session later: the agent setting itself to run again".
    - `RemoteTrigger` → `builtins.cron-create`: "schedules agent runs on Anthropic's cloud: the agent setting itself to run again later, outside routines".
    - `Monitor`: "watches a background command; Bash run_in_background plus Read can still watch one, so a Cannot row would understate reach (H4). Being woken by it later is the agent running again, which the builtins.cron-create row already says".
    - `TaskOutput`: "reads a background task's output; Read still can".
    - `TaskStop`: "stops a background task; Bash still can".
    - `NotebookEdit`: "edits notebook cells; Edit and Write still can".
    - `EnterWorktree`: "makes a git worktree and moves the session into it; Bash can still make one, and moving the session is no reach".
    - `ExitWorktree`: "leaves a worktree session; no reach".
    - `EnterPlanMode`: "a read-only planning mode; no reach".
    - `ExitPlanMode`: "leaves plan mode; no reach".
    - `PushNotification`: "notifies through the CLI's terminal and a paired Claude app; a headless API-key session has neither".
    - `ListMcpResourcesTool`: "lists MCP resources; the rail describes a connection by its tools, which have their own rows".
    - `ReadMcpResourceTool`: "reads MCP resources; the rail describes a connection by its tools, which have their own rows".
  - **Cases.**
    - `'parsed real data out of all three files'`: denied at least 20 names including `CronCreate`; KNOWN and ALLOWED each contain `Bash`; plus the existing aisdk and rail floors. The three runner literals all live in `tool-names.ts`.
    - `'every rail deny names a tool BOTH runners keep from the agent'`: each row's tool is in (denied − aisdk-registered); compare un-deduped (a duplicate row fails).
    - `'every denied built-in is a rail row or has a written reason in OFF_RAIL — never both, never neither'`.
    - `'OFF_RAIL holds no stale names, and every coveredBy names a real rail row'`: keys are in the intersection; `coveredBy` is in the row ids; `why` is non-empty.
  - **Failure messages** say what to do: "write a `builtins.*` row in `packages/tool-policy/src/rules.ts` BY HAND (capability-lint) only if 'Cannot <clause>' is true and a person would look for it; otherwise add the name to OFF_RAIL with the reason".
  - **Rewrite the header (`:1-43`)**: the rail accounts for the whole denied set, why some names get no row (H4), and that the TASK-245 cross-runner rules still hold.

  Run `pnpm test:scripts disabled-builtin-rail-drift`. Expected RED: `CronCreate` is unaccounted (no row yet).
- [ ] **Step 3: Add the rule and rewrite the comments.**
  - `rules.ts:51-80`. Say that:
    - the claude-sdk runner denies every built-in outside `ALLOWED_SDK_BUILTINS`;
    - rows exist only where "Cannot X" is true and worth a person's attention;
    - every other denied name has its reason in the guard's `OFF_RAIL`;
    - "THESE FOUR" becomes "THESE ROWS";
    - delete KNOWN GAP and keep the TASK-245 ruling.
  - `rules.ts:361-364`: the claude-sdk runner loads exactly `ALLOWED_SDK_BUILTINS` (these six plus TodoWrite, Skill and ToolSearch).
  - `tool-names.ts:33-38` and `:283-290`: the guard reads `KNOWN_SDK_BUILTINS`/`ALLOWED_SDK_BUILTINS`/`DISABLED_BUILTINS` as text. CronCreate now has a rail row too.
- [ ] **Step 4: Prove the guard RED six ways, then GREEN.** Commit first. Inject each mutation, observe RED, restore:
  - (A) a new name `'FooTool'` in `KNOWN_SDK_BUILTINS`;
  - (B) delete the `builtins.cron-create` rule (CronCreate is unaccounted AND four `coveredBy` targets are dangling);
  - (C) move `'NotebookEdit'` into `ALLOWED_SDK_BUILTINS` (stale OFF_RAIL);
  - (D) add a `    WebFetch: tool({` entry to `agent-aisdk-runner/src/tools/builtins.ts` (row for a tool aisdk registers);
  - (E) duplicate the `builtins.task` rule;
  - (F) rename the `KNOWN_SDK_BUILTINS` literal (the parse throws).

  Then `git status` must be clean. Record the six outcomes in the PR body.

  Run:
  - `pnpm test:scripts disabled-builtin-rail-drift`
  - `pnpm --filter @ax/tool-policy test`
  - `pnpm --filter @ax/tool-policy lint:capabilities`
  - `pnpm --filter @ax/tool-policy build`

  Expected: all green.
- [ ] **Step 5: Commit** `[TASK-1207] Rail: say the agent cannot set itself to run again later outside routines; every denied SDK built-in is a row or a written reason`.

### Task 3: Switch off the two bundled skills the CLI lets us switch off [tier: integration]

**Files:**
- Create: `packages/agent-claude-sdk-runner/src/bundled-skills-env.ts`
- Create: `packages/agent-claude-sdk-runner/src/__tests__/bundled-skills-env.test.ts`
- Modify:
  - `packages/agent-claude-sdk-runner/src/main.ts:429` (env literal);
  - `…/__tests__/main.test.ts` (beside the telemetry pin, `~:700-707`);
  - `…/__tests__/agent-files-guards-real-sdk.e2e.test.ts`, in `productionEnv` (`:246-264`), directly after its `...buildTelemetryEnv(),`.

**Interfaces:**
- Produces: `export function buildBundledSkillsEnv(): Record<string, string>`. It returns a fresh `{ CLAUDE_CODE_DISABLE_CRON: '1', CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL: '1' }`.
- Header comment, in the `telemetry-env.ts` style:
  - the measured gates (see "Measured" above);
  - that nothing switches off the other bundled skills, which is why Task 4 refuses them at the call;
  - the dead ends (`skillOverrides` is a no-op; `local-agent`; bare mode);
  - the ordering contract: spread AFTER `...buildTelemetryEnv()`, a floor.

- [ ] **Step 1: Write the failing tests.**
  - `bundled-skills-env.test.ts`:
    - `it('turns off the cron-backed loop skill and the claude-api skill')`: `toEqual` the exact object.
    - `it('returns a fresh object each call')`.
  - `main.test.ts`: `expect(queryArg.options.env.CLAUDE_CODE_DISABLE_CRON).toBe('1')` and `expect(queryArg.options.env.CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL).toBe('1')`. Use the same captured `queryArg` as the telemetry pin.
- [ ] **Step 2: Run, expect RED.** Run `pnpm --filter @ax/agent-claude-sdk-runner exec vitest run src/__tests__/bundled-skills-env.test.ts src/__tests__/main.test.ts`.
- [ ] **Step 3: Implement.**
  - Add the module.
  - In main.ts, put `...buildBundledSkillsEnv(),` right after `...buildTelemetryEnv(),`, with a two-line comment.
  - In `agent-files-guards…`'s `productionEnv`, add `...buildBundledSkillsEnv(),` after `...buildTelemetryEnv(),`. That function claims to layer "in main.ts's order from the same helpers".
- [ ] **Step 4: Run GREEN.** Run `pnpm --filter @ax/agent-claude-sdk-runner exec vitest run src/__tests__/bundled-skills-env.test.ts src/__tests__/main.test.ts src/__tests__/agent-files-guards-real-sdk.e2e.test.ts`, then `pnpm --filter @ax/agent-claude-sdk-runner build`.
- [ ] **Step 5: Commit** `[TASK-1207] claude-sdk runner: turn off the CLI's loop and claude-api skills`.

### Task 4: Only AX's own skills can be invoked [tier: sensitive]

Run `security-checklist` for this task. It touches the pre-call gate and model-controlled input (`tool_input.skill`), and the refusal is written into the transcript.

**Files:**
- Create: `packages/agent-claude-sdk-runner/src/projected-skills.ts`
- Create: `packages/agent-claude-sdk-runner/src/__tests__/projected-skills.test.ts`
- Modify:
  - `packages/agent-claude-sdk-runner/src/pre-tool-use.ts:29-50` (option), and after `:94` (branch);
  - `…/__tests__/pre-tool-use.test.ts`;
  - `packages/agent-claude-sdk-runner/src/main.ts` (beside `:174`, and the `createPreToolUseHook` call at `:570`; comment at `:609-612`);
  - `…/__tests__/main.test.ts`;
  - `packages/agent-claude-sdk-runner/src/tool-names.ts:55-69`;
  - `packages/agent-claude-sdk-runner/SECURITY.md:117`.

**Interfaces:**
- Produces `export async function readProjectedSkillNames(configDir: string | undefined, log?: (line: string) => void): Promise<ReadonlySet<string>>`:
  - It returns the folder names (`Dirent.isDirectory()`, so symlinks are excluded) under `<configDir>/skills`.
  - It never throws. A missing dir (ENOENT) gives an empty set, silently. An undefined configDir or any other error gives an empty set plus one log line.
  - The default `log` is `(line) => process.stderr.write(\`runner: projected-skills: ${line}\n\`)`, mirroring runner-core's `loadProjectedMcpServers`.
  - There's no frontmatter parsing (folder == name by construction; decision row 5).
- Produces `export function skillRefusal(toolInput: unknown, projected: ReadonlySet<string>): string | undefined`:
  - `name` = `toolInput.skill` if it's a string, then `.trim()`, then strip ONE leading `/` (the CLI's own rule). Otherwise `''`.
  - It returns `undefined` iff `name !== ''` and `projected.has(name)`.
  - Otherwise it returns this exact copy: `` `${label} is not one of this agent's skills, so it isn't available here. Use the skills and tools you were given. To do something on a schedule, create a routine.` `` (Review narrowed the last sentence to scheduling names, `loop`/`schedule`/`cron`, and added a separate refusal for a projection that could not be read.)
    - `label` is `"${name}"` (in double quotes) when `name` matches `^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$`.
    - Otherwise it's `That skill`.
- `CreatePreToolUseHookOptions` gains `projectedSkills?: ReadonlySet<string>`. Absent means an empty set, so it fails closed; say so in its doc. `main.ts` always passes it.
- New branch, placed after the `disabled` branch and before `policy.preToolUse`: when `input.tool_name === 'Skill'` and `skillRefusal(input.tool_input, opts.projectedSkills ?? EMPTY)` returns a reason, return `{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }` with NO IPC call.

- [ ] **Step 1: Write the failing tests.**
  - `projected-skills.test.ts`, reader:
    - two folders (`weekly-report`, plus a second, connector-like one) plus a stray file plus a symlinked folder give exactly the two folder names;
    - a missing `skills/` dir gives an empty set and the log is never called;
    - `undefined` gives an empty set and one log line;
    - an unreadable dir gives an empty set and one log line, with no throw.
  - `projected-skills.test.ts`, refusal:
    - `{skill:'weekly-report'}` and `{skill:' /weekly-report '}` give `undefined`;
    - `{skill:'update-config'}` contains `'"update-config" is not one of this agent\'s skills'` (after review, with no routine pointer);
    - `{skill:'/init'}` contains `'"init"'`;
    - `{}`, `{skill:42}` and `{skill:''}` start with `'That skill'`;
    - `{skill:'x'.repeat(200)}` and `{skill:'evil\n# heading'}` give a string that does NOT contain the input, starting with `'That skill'`.
  - `pre-tool-use.test.ts`, using the existing `mkClient`:
    - `'refuses a Skill call for a skill AX did not install, without touching IPC'` (`update-config`, projected `{'weekly-report'}`): `calls` is `[]`, and the deny reason contains `not one of this agent's skills`.
    - `'forwards a Skill call for an installed skill to tool.pre-call'`: one `tool.pre-call` with `name: 'Skill'`, then allow.
    - `'refuses every Skill call when no projection was passed'` (fail closed).
  - `main.test.ts`, following the `:1273-1280` fresh-config-dir pattern: plant `<cfg>/skills/weekly-report/SKILL.md` and boot with `setEnv({...COMPLETE_ENV, CLAUDE_CONFIG_DIR: cfg})`. Leave `AX_INSTALLED_SKILLS_JSON` unset: the materializer returns early, `installed-skills.ts:157`. Fire the captured `options.hooks.PreToolUse[0].hooks[0]`, as at `:1601`:
    - `Skill {skill:'update-config'}` is denied with no `tool.pre-call`;
    - `Skill {skill:'weekly-report'}` reaches `tool.pre-call`.
- [ ] **Step 2: Run, expect RED.** Run `pnpm --filter @ax/agent-claude-sdk-runner exec vitest run src/__tests__/projected-skills.test.ts src/__tests__/pre-tool-use.test.ts src/__tests__/main.test.ts`.
- [ ] **Step 3: Implement.**
  - Write the module and the branch.
  - In main.ts, hoist the config-dir expression at `:175` into a `const configDir`. Use it for `loadProjectedMcpServers(configDir)` and `const projectedSkills = await readProjectedSkillNames(configDir)`. Both are read once, after materialization and before the first turn. Pass `projectedSkills` into `createPreToolUseHook`.
  - Rewrite the stale prose:
    - `tool-names.ts:55-69`: bundled skills are off via `buildBundledSkillsEnv()` where the CLI allows it, and every other non-AX skill is refused by `pre-tool-use.ts`.
    - `main.ts:609-612`: say the same in one line.
    - `SECURITY.md:117`: replace the "NOT audited" sentence. Name what's switched off, what's refused, the measured dead ends, and the e2e that pins it (Task 5).
- [ ] **Step 4: Run GREEN.** Run the same command, then `pnpm --filter @ax/agent-claude-sdk-runner test` and `pnpm --filter @ax/agent-claude-sdk-runner build`.
- [ ] **Step 5: Commit** `[TASK-1207] claude-sdk runner: refuse Skill calls for anything AX did not install`.

### Task 5: Prove item 2 on the real binary; changeset; memory [tier: integration]

**Files:**
- Create: `packages/agent-claude-sdk-runner/src/__tests__/bundled-skills-real-sdk.e2e.test.ts`. The name matches Task 1's scan.
- Create: `.changeset/sdk-builtins-followups.md`
- Create: memory shards via `scripts/memory-write-target.sh --shard patterns TASK-1207` and `--shard context TASK-1207`. `mkdir -p` the dirname first.

**Interfaces:**
- Consumes:
  - `stripClaudeCodeEnv()` (Task 1);
  - `buildBundledSkillsEnv()` (Task 3);
  - `readProjectedSkillNames`, and `createPreToolUseHook({ client, projectedSkills })` (Task 4);
  - `buildTelemetryEnv()`, `ALLOWED_SDK_BUILTINS`, `DENIED_SDK_BUILTINS`.

- [ ] **Step 1: Write the e2e.** Copy the fake `/v1/messages` SSE server and the `HAVE_BINARY` skip from `tool-allowlist-real-sdk.e2e.test.ts`.
  - **Server behavior.** When a case sets `skillCall`, the FIRST agent-loop call answers a `tool_use` `Skill` with input `{ skill: skillCall }`. The case then reads the `tool_result` (`is_error` and its text) from the second agent-loop request body.
  - **Setup.**
    - Plant `cfg/skills/weekly-report/SKILL.md` (frontmatter `name: weekly-report`, plus a description).
    - Env: `{ ...stripClaudeCodeEnv(), HOME: tmp, CLAUDE_CONFIG_DIR: cfg, ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY: 'sk-ant-fake-for-a-local-scripted-server', ...buildTelemetryEnv(), DISABLE_AUTOUPDATER: '1' }`, plus `...buildBundledSkillsEnv()` when the case is "like main.ts".
    - Options: `settingSources: ['user']`, `tools: [...ALLOWED_SDK_BUILTINS]`, `disallowedTools: [...DENIED_SDK_BUILTINS]`, `allowedTools: ['Skill']`, and an allow `canUseTool`.
    - When "like main.ts", also set `hooks.PreToolUse = [{ hooks: [createPreToolUseHook({ client: stubClient, projectedSkills: await readProjectedSkillNames(cfg) })] }]`. `stubClient` answers `{ verdict: 'allow' }` and records calls (the `mkClient` shape from `pre-tool-use.test.ts`).
  - **Cases** (60 s timeout each):
    - `'CONTROL: the CLI ships loop and update-config by default'`: without `buildBundledSkillsEnv` and without the hook, `system/init` `skills` contains `loop`, `update-config` and `weekly-report`.
    - `'FIX: configured like main.ts, the session has the installed skill and neither loop nor claude-api'`: `system/init` `skills` contains `weekly-report` and contains neither `loop` nor `claude-api`. Measured: `["update-config","debug","simplify","batch","fewer-permission-prompts","weekly-report"]`.
    - `'FIX: update-config is refused by the runner'`: is_error, and the text contains `not one of this agent's skills`.
    - `'FIX: /init is refused by the runner'`: is_error with `"init"`.
    - `'FIX: the installed skill launches'`: not is_error, contains `Launching skill: weekly-report`, and `stubClient` saw one `tool.pre-call`.
    - `'FIX: loop is unknown to the CLI'`: is_error, contains `Unknown skill: loop`.
- [ ] **Step 2: Run on the real binary.** Run `pnpm --filter @ax/agent-claude-sdk-runner exec vitest run src/__tests__/bundled-skills-real-sdk.e2e.test.ts src/__tests__/real-sdk-env.test.ts`. Expected: 6 passed, none skipped. The scan now counts 6 files.
  - To show the FIX cases bite: temporarily drop the `buildBundledSkillsEnv()` spread and the hook from the "like main.ts" setup, then restore. The listing case and the update-config case should go RED.
- [ ] **Step 3: Write the changeset.** Use `'@ax/agent-claude-sdk-runner': patch` and `'@ax/tool-policy': patch`. Voice per CLAUDE.md, plain and short. For example: "Agents now say plainly that they can't set themselves to run again later outside routines. Claude Code's own built-in skills (like `loop`) are switched off, so an agent asked to do something every weekday sets up a routine you can approve instead of a schedule that never runs."
- [ ] **Step 4: Memory shards.**
  - **patterns:** the measured CLI facts as reusable lessons:
    - `skillOverrides` is a no-op in 2.1.119;
    - `CLAUDE_CODE_DISABLE_CRON` / `CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL` are the only working switches;
    - `local-agent` skips bundled skills but turns on env scrubbing;
    - a PreToolUse deny works for `Skill`;
    - the probe recipe is the new e2e.
  - **context:** the rail's deny rows are now five, and `OFF_RAIL` in the drift guard holds the reasons for the other 19. This supersedes the "4 denies" rows in the frozen `context.md`.
  - Add any build-time decisions to `.claude/memory/decisions/2026-11-23-TASK-1207.md`. Never touch a root archive.
- [ ] **Step 5: Full gate.** Run:
  - `pnpm build`
  - `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`
  - `pnpm lint`

  Expected: green apart from known Docker-only flakes (see CLAUDE.md). Note any in the PR.
- [ ] **Step 6: Commit** `[TASK-1207] Real-binary proof that only AX's skills can be invoked; changeset; memory`.

## PR notes

- **Security note:** one `security-checklist` pass covering Task 2 (consent claim) and Task 4 (model input at the pre-call gate). Mention that Task 3 only removes CLI features (no reach added).
- **Boundary review:** not required (no hook-surface change). State it.
- **Card item 4:** not done here. Walk TASK-1205 covered it.
- **Refuted premise:** say that the card asked for ~20 rows, why it got one, and point at `OFF_RAIL`.
