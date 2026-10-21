# TASK-906 "Stay on top of something" Kind Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A routine can be a "Stay on top of something" task. It carries `kind` and `goodWhen`, checks in no more often than every 15 minutes, and Always Allow never creates one or rewrites its brief without asking. Check-in behaviour doesn't change in this card: a task still fires its `promptBody` like a routine until slice 3.

**Architecture:** The contract (`@ax/routines-contract`) owns the new fields, the per-kind rules and two pure helpers. `touchesTaskBrief` is the authorization predicate. `routineTaskProposal` is a shared, input-only "is this a task proposal" reading. `@ax/routines` persists the fields through a version-3 migration. `@ax/tool-policy` refuses to relax consent for a brief-touching call. `@ax/decisions` words the hold as a task. channel-web projects the task's fields onto open approvals, fenced, and draws them in both approval renderers. No new hooks, plugins or external dependencies.

**Tech Stack:** TypeScript, zod 3, croner 8.1.2 (already a dependency of the contract), Kysely on Postgres (testcontainers), React with the shadcn semantic tokens, vitest with Testing Library.

**Spec:** the TASK-906 card body, and `docs/plans/2026-10-20-agent-tasks-design.md` §2, §3.2, §4.2, §4.5, §5.3, §7 and §15 Q2/Q3. Decisions: `.claude/memory/decisions/2026-10-20-TASK-906.md`. Read its rows 2 (the fixed-reference cron floor), 8 (`routineTaskProposal`) and 10 (the `task` wire field) before Task 1. Each departs from or extends the card's wording.

## Global Constraints

- `kind` is `z.enum(['repeat', 'stay-on-top'])`, default `'repeat'`. Don't add `'get-done'` or any other value.
- `goodWhen` is `z.string().max(1024).nullable()`, default `null`.
- The floor for `stay-on-top` is 15 minutes (900 s). Repeat routines keep the 60 s interval floor.
- The cron floor inspects 48 occurrences, starting from the fixed instant `2026-01-01T00:00:00.000Z` (decisions row 2). Review round 2 added the gap those can miss, from one hour's last run to the next hour's first (minute and hour sets read back through croner's public API, refused whatever the day fields say when hours 23 and 0 meet), and refuses `?` for a task, because croner fills it in from the clock.
- No new hook, no hook rename, and no new external dependency. The only package edge added is `@ax/tool-policy → @ax/routines-contract`, which is allowed by the `crossPluginImports` allow-list in `eslint.config.mjs`. Only Task 4 changes `pnpm-lock.yaml`.
- Model-authored text (name, `promptBody`, `goodWhen`, the cron expression) never reaches a string `@ax/decisions` writes. On the browser it crosses only inside the fenced `request` and `task` fields of an open decision, and it is drawn as React text: no markdown, no `dangerouslySetInnerHTML`.
- TDD and the Bug Fix Policy apply: run each new test against unmodified code and watch it fail before you change the source. Where a task only adds regression guards over existing behaviour (Task 8), prove each guard with the mutation named in that task.
- Run one test file as `pnpm --filter @ax/<pkg> test <file>`. Don't add `--`: with it pnpm runs the whole package (`.claude/memory/mistakes/2026-10-20-TASK-904.md`). Check the file count in vitest's summary line.
- vitest resolves workspace packages from their built `dist/` (no source aliases). After you change a package that another package's tests import, rebuild it before running those tests: `pnpm --filter @ax/<pkg> build`, or `pnpm build`. The contract feeds every later task, and tool-policy feeds the routines canary.
- The Postgres suites (routines, tool-policy, agents, decisions, and the channel-web server tests that boot a database) need an explicit `DOCKER_HOST`. On this machine that is `unix:///Users/vpulim/.orbstack/run/docker.sock`. For the whole routines package also set `VITEST_MAX_WORKERS=2`, because its container starts saturate otherwise (DBROUTINES-11).
- channel-web's `tsc` type-checks its test files (most packages exclude them), so a contract type change can break `pnpm build` from a fixture.
- Final gates (CLAUDE.md): `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`.
- Memory: write shards only, from `scripts/memory-write-target.sh --shard <kind> TASK-906`. Never touch a root `.claude/memory/*.md`, and never add a `Memory-Rewrite:` trailer.
- Copy below marked "exact" is decided. Paste it; don't reword it.
- Write the U+202E test input (Task 6) as the six characters `\u202E` inside a JS string. The Edit and Write tools can store it as the raw override character instead, which reorders how the line displays. This planner hit that while writing this file. Check the test file with a code-point scan, not grep: the snippet is in `.claude/memory/mistakes/2026-10-20-TASK-904.md`.

## Review Focus

1. **A cron whose short gap only shows at an hour boundary.** `*/16 * * * *` fires at :00, :16, :32, :48 and then :00 again, a 12-minute gap. It must be rejected for a task even though "every 16 minutes" reads as fine, and only a floor that inspects enough runs sees it. Pinned in Task 1 (`*/16` row, added in review; `*/14` is rejected by its plain 14-minute gaps).
2. **A task saved today has to stay valid on every future date.** The floor verdict must not depend on the clock, or `routines:list` and the tick's `claimDue` throw for a stored row. Pinned in Task 1 by `the cron floor gives the same verdict whatever the clock says`.
3. **An agent with Always Allow.** Pausing a task (`{enabled:false}`) or rescheduling it must not ask. Rewriting its instructions, name or going-well-when, or creating a task, must ask. Pinned in Task 4's table and end to end in Task 9.
4. **Model text that looks like markup or markdown on the approval card.** `<img onerror>`, `**bold**`, a U+202E override. It shows as literal text, fenced the same way as `request`. Pinned in Tasks 6 and 7.
5. **A person editing a task in Settings.** Saving an instructions change keeps `kind`/`goodWhen`. Switching it to a webhook or a 5-minute interval shows a plain message and blocks Save. Pinned in Task 8.

## For the sibling cards (TASK-907–912): what this card guarantees

- `RoutineDefinition`, `RoutinePatch` and `RoutineView` carry `kind: 'repeat' | 'stay-on-top'` and `goodWhen: string | null`. So do `routines:get`, `routines:list`, `routine_get` and `routineApi.list`.
- A `stay-on-top` routine always has `conversation: 'per-fire'` (TASK-907 binds reports by conversation) and `silenceToken: null` (TASK-908's report replaces silence). Its trigger is always `interval` or `cron`, never `webhook`.
- **TASK-908:** the person-written `brief` section may contain only `name`, `promptBody`, `goodWhen`, `kind` (the fields `touchesTaskBrief` protects) and host text. `description`, `trigger`, `activeHours` and `enabled` change under Always Allow without a person seeing it, so none of them may become instructions in the brief. For any non-`repeat` kind, `validateDefinition` refuses invisible characters in those three text fields on every parse (read paths included), so none of the brief is text the card can't draw.
- Exports to reuse rather than copy:
  - From `@ax/routines-contract`: `RoutineKindSchema`, `RoutineKind`, `TASK_CHECK_IN_FLOOR_SECONDS`, `touchesTaskBrief`, `routineTaskProposal`.
  - From channel-web: `describeCheckIns(trigger)` in `packages/channel-web/src/lib/task-schedule.ts`, and the `DecisionTask` wire type.
- Design PR 3 (`get-done`) must add the enum value and decide its rules in `validateDefinition`'s exhaustive `switch`. It must also swap the named CHECK `routines_v1_definitions_kind_chk`. `touchesTaskBrief` and `routineTaskProposal` already treat any non-`repeat` kind as a task.

## Order and file ownership

| Wave | Task | Touches | Depends on |
|---|---|---|---|
| 1 | T1 contract fields and rules | `routines-contract/src/{definition,services,tools}.ts`, its test; compile fixes in channel-web (`RoutineEditor.tsx`, routine fixtures) and, if flagged, `routines/src/services.ts` (`get-default`) | — |
| 2 | T2 contract helpers and model copy | `routines-contract/src/tools.ts` (helpers and descriptions only), its test; `agent-runner-core/src/system-prompt.ts` and its test | T1 |
| 2 | T3 persistence | `routines/src/{migrations,store}.ts`, routines tests | T1 |
| 2 | T8 Settings guards | `channel-web/src/components/routines/RoutineEditor.tsx` (`editableKeys`), `RoutineEditor.test.tsx`, `src/__tests__/routines-list.test.tsx` | T1 |
| 3 | T4 carve-out | `tool-policy/{package.json,tsconfig.json,src/plugin.ts}`, its canary test, `agents/src/__tests__/routine-consent.test.ts`, `pnpm-lock.yaml`, design §4.2 | T2 |
| 3 | T5 decisions wording | `decisions/src/{templates,pre-call}.ts`, decisions tests | T2 |
| 3 | T6 task projection | channel-web `lib/{workspace-types,task-schedule}.ts`, `server/routes-workspace.ts`, server test, `decision-fixture.ts` | T2 |
| 3 | T7 renderers and copy | channel-web `components/workspace/{DecisionTaskBlock,ApprovalCard,DecisionRow,decision-copy}`, `components/routines/RoutineConsentSection.tsx`, their tests | T6 |
| 4 | T9 canary | `routines/src/__tests__/canary.test.ts` | T3, T4, T5 |

Inside a wave the tasks touch disjoint files, so they can run in separate worktrees and be cherry-picked onto `yolo/TASK-906-stay-on-top-kind`, the way TASK-904 did. T1 and T2 both edit `tools.ts`, so they run in sequence. T1–T3 must ship in the same PR: between T1 and T3, a task created on the branch would persist as `repeat`.

---

### Task 1: The contract knows `kind` and `goodWhen` [tier: integration]

**Files:**
- Modify: `packages/routines-contract/src/definition.ts`: `RoutineEditableShape` (:57), `validateDefinition` (:69), `RoutineDefinitionObjectSchema` (:78), `RoutinePatchSchema` (:90), `editableDefinition` (:136)
- Modify: `packages/routines-contract/src/services.ts`: `RoutineGetDefaultOutputSchema` (:51), `RoutineUpsertDefaultInputSchema` (:59)
- Modify: `packages/routines-contract/src/tools.ts`: `editableProperties` (:58), `RoutineDefinitionJsonSchema` (:68), and the interval/cron descriptions in `trigger` (:44)
- Modify (compile only): `packages/channel-web/src/components/routines/RoutineEditor.tsx`. `empty()` (:51) gains `kind: 'repeat', goodWhen: null`. `DefaultRoutineEditor`'s save (:164) passes `{ ...definition, kind: 'repeat', goodWhen: null, trigger: definition.trigger }`.
- Modify (fixtures): `packages/channel-web/src/components/routines/__tests__/routine-fixture.ts`, and every other channel-web test literal `tsc` reports (expect the `DefaultRoutinesSection.test.tsx` default-detail mocks). Add `kind: 'repeat', goodWhen: null` and nothing else.
- Modify (compile, if `pnpm build` flags it): `packages/routines/src/services.ts:129-133`. The `get-default` handler spreads a `DefaultRoutineDetailRow`, whose `kind` is the full union, into an output typed `kind: 'repeat'`. Return `kind: 'repeat', goodWhen: null` explicitly. A stored default is always repeat, because `default_routines_v1` has no kind column.
- Test: `packages/routines-contract/src/__tests__/definition.test.ts`

**Interfaces:**
- Produces, from `definition.ts`:
  - `ROUTINE_KINDS = ['repeat', 'stay-on-top'] as const`, `RoutineKindSchema = z.enum(ROUTINE_KINDS)`, `type RoutineKind`
  - `ROUTINE_GOOD_WHEN_MAX_CHARS = 1024`, `TASK_CHECK_IN_FLOOR_SECONDS = 900`, `TASK_CRON_FLOOR_RUNS = 48`
  - `RoutineEditableShape.kind = RoutineKindSchema` and `RoutineEditableShape.goodWhen = z.string().max(ROUTINE_GOOD_WHEN_MAX_CHARS).nullable()`
  - Defaults `'repeat'` / `null` in `RoutineDefinitionObjectSchema`. Both fields optional in `RoutinePatchSchema`. Both copied by `editableDefinition`.
- Produces, from `services.ts`:
  - `RoutineGetDefaultOutputSchema` requires `kind: z.literal('repeat')` and `goodWhen: z.null()`.
  - `RoutineUpsertDefaultInputSchema` gains `kind: z.literal('repeat').default('repeat')` and `goodWhen: z.null().default(null)`.
- `RoutineViewSchema` needs no edit: it spreads `RoutineEditableShape`, so both fields become required on every view and the per-kind rules run on view parsing.

- [ ] **Step 1: Write the failing tests.**
  - Add `kind: 'repeat' as const, goodWhen: null` to the file's `base`. Every existing test keeps its meaning.
  - Append a `describe('task kinds (TASK-906)', …)` that pins the following. `task` is `{ ...base, kind: 'stay-on-top', goodWhen: 'No ticket stays open longer than an hour.', trigger: { kind: 'interval', every: '15m' } }`.
  - `defaults kind to repeat and goodWhen to null`. `RoutineDefinitionSchema.parse({ name, promptBody, trigger })` matches `{ kind: 'repeat', goodWhen: null }`.
  - `accepts a stay-on-top task at the floor`. `task` round-trips. So do `every: '900s'`, `'1h'`, and cron `0 * * * *` (UTC), `*/15 * * * *` (UTC) and `0 9 * * 1-5` (`America/New_York`).
  - `rejects each per-kind rule with a field path`. Use this `it.each` of `[value, path]`, asserting `safeParse(value).success === false` and `issues.map(i => i.path)` `toContainEqual(path)`:

    ```ts
    [{ ...base, goodWhen: 'x' }, ['goodWhen']],
    [{ ...task, goodWhen: null }, ['goodWhen']],
    [{ ...task, goodWhen: '   ' }, ['goodWhen']],
    [{ ...task, goodWhen: 'a'.repeat(1025) }, ['goodWhen']],
    [{ ...task, trigger: { kind: 'webhook', path: '/zendesk' } }, ['trigger']],
    [{ ...task, conversation: 'shared' }, ['conversation']],
    [{ ...task, silenceToken: 'ALL_GOOD' }, ['silenceToken']],
    [{ ...task, trigger: { kind: 'interval', every: '14m' } }, ['trigger', 'every']],
    [{ ...task, trigger: { kind: 'interval', every: '899s' } }, ['trigger', 'every']],
    [{ ...task, trigger: { kind: 'cron', expr: '*/10 * * * *', tz: 'UTC' } }, ['trigger', 'expr']],
    [{ ...task, trigger: { kind: 'cron', expr: '*/14 * * * *', tz: 'UTC' } }, ['trigger', 'expr']],
    [{ ...task, trigger: { kind: 'cron', expr: '*/30 * * * * *', tz: 'UTC' } }, ['trigger', 'expr']],
    ```

    Also assert the `14m` issue's message is exactly `Check-ins need to be at least 15 minutes apart.`
  - `repeat keeps everything it allows today`. A repeat routine with `every: '60s'`, and a repeat webhook routine with `silenceToken: 'OK'` and `conversation: 'shared'`, both parse.
  - `the cron floor gives the same verdict whatever the clock says`. Under `vi.useFakeTimers({ now: new Date('2026-03-08T06:30:00Z') })` and then `new Date('2031-07-01T00:00:00Z')`, compare `safeParse(...).success` for these crons: `0 * * * *`, `*/10 * * * *`, `0,50 1,3 * * *` (`America/New_York`), `0 0 29 2 *`. The results must be equal across the two clocks. Also assert the New York task is accepted at both. Restore real timers in `finally`.
    - Why that cron matters: on 2026-03-08 (US spring-forward), 01:50 EST and 03:00 EDT are 10 real minutes apart. A floor counted from "now" rejects it at the first clock and accepts it at the second, so this test goes red for exactly that implementation. Measured with croner 8.1.2.
  - `checks the floor without starting a scheduler`. Spy on `setTimeout` while parsing a `stay-on-top` cron task. It must not be called.
  - `revalidates kind rules after a patch merges`:
    - `applyRoutinePatch(task, { trigger: { kind: 'webhook', path: '/x' } })` throws.
    - `applyRoutinePatch(task, { kind: 'repeat' })` throws, because `goodWhen` is still set.
    - `applyRoutinePatch(task, { kind: 'repeat', goodWhen: null })` returns kind `repeat`.
    - `applyRoutinePatch(base, { kind: 'stay-on-top', goodWhen: 'x' })` returns a task.
  - `RoutinePatchSchema accepts kind and a goodWhen clear`. Both `{ goodWhen: null }` and `{ kind: 'stay-on-top' }` parse.
  - `views require kind and goodWhen and recheck them`:
    - `RoutineViewSchema` parses a view built from `task`.
    - A view without `kind` fails.
    - A view with `kind: 'stay-on-top'` and a webhook trigger fails.
  - `default routines stay repeat`:
    - `RoutineUpsertDefaultInputSchema` rejects `kind: 'stay-on-top'` (with a valid `goodWhen` and a `1h` interval).
    - `RoutineGetDefaultOutputSchema` rejects a `stay-on-top` detail, and rejects one missing `kind`.
  - `the JSON schema offers both fields`:
    - `RoutineDefinitionJsonSchema.properties.kind` matches `{ enum: ['repeat', 'stay-on-top'], default: 'repeat' }`.
    - `.goodWhen` matches `{ default: null }`.
    - The existing alignment test (`keeps JSON schema fields and required keys aligned`) must pass unchanged.

- [ ] **Step 2: Run, and see them fail.** `pnpm --filter @ax/routines-contract test src/__tests__/definition.test.ts`. Expect failures: strict schemas reject `kind`/`goodWhen` as unknown keys.

- [ ] **Step 3: Implement.**
  - **Fields:** add both to `RoutineEditableShape`. Give them defaults in `RoutineDefinitionObjectSchema`, add them as optional keys in `RoutinePatchSchema`, and add `kind: row.kind, goodWhen: row.goodWhen` to `editableDefinition`.
  - **Rules:** in `validateDefinition`, after the existing checks, add an exhaustive `switch (definition.kind)` whose `default` assigns to `never`. Exact rules and paths:

    | kind | condition that adds an issue | path | message (exact) |
    |---|---|---|---|
    | `repeat` | `goodWhen !== null` | `['goodWhen']` | `Only a task that stays on top of something can say when it’s going well.` |
    | `stay-on-top` | `goodWhen === null \|\| goodWhen.trim() === ''` | `['goodWhen']` | `Say how we’ll know this task is going well.` |
    | `stay-on-top` | `trigger.kind === 'webhook'` | `['trigger']` | `A task that stays on top of something checks in on a schedule, not from a webhook.` |
    | `stay-on-top` | `conversation !== 'per-fire'` | `['conversation']` | `A task that stays on top of something starts a fresh conversation for each check-in.` |
    | `stay-on-top` | `silenceToken !== null` | `['silenceToken']` | `A task that stays on top of something reports how it’s going, so it doesn’t use a silence token.` |
    | `stay-on-top` | interval with `durationToSeconds(every)` not null and `< TASK_CHECK_IN_FLOOR_SECONDS` | `['trigger','every']` | `Check-ins need to be at least 15 minutes apart.` |
    | `stay-on-top` | cron where `cronChecksInTooOften(expr, tz)` | `['trigger','expr']` | same as above |

    A null `durationToSeconds` and an unparseable cron add nothing here, because the trigger schema already reported them. The 1025-character `goodWhen` fails on `.max()`, not here.
  - **The floor check:** a private helper in `definition.ts`. This body is the algorithm decisions row 2 fixes:

    ```ts
    /** Fixed, so a saved definition's validity is a pure function of (expr, tz) and never changes with the clock. */
    const TASK_CRON_FLOOR_FROM = new Date('2026-01-01T00:00:00.000Z');
    function cronChecksInTooOften(expr: string, tz: string): boolean {
      let runs: Date[];
      try { runs = new Cron(expr, { timezone: tz }).nextRuns(TASK_CRON_FLOOR_RUNS, TASK_CRON_FLOOR_FROM); }
      catch { return false; }
      for (let i = 1; i < runs.length; i++) {
        if (runs[i]!.getTime() - runs[i - 1]!.getTime() < TASK_CHECK_IN_FLOOR_SECONDS * 1000) return true;
      }
      return false;
    }
    ```
  - **Default schemas:** the two `services.ts` changes from Interfaces.
  - **Tool JSON schema (`tools.ts`):** add to `editableProperties`:
    - `kind: { type: 'string', enum: ['repeat', 'stay-on-top'], description: 'What this is for. "repeat" (the default) does the same job each time. "stay-on-top" is a "Stay on top of something" task: it keeps checking and fixing something and never finishes, and it needs goodWhen.' }`
    - `goodWhen: { anyOf: [{ type: 'string', maxLength: 1024 }, { type: 'null' }], description: 'For a "stay-on-top" task only: how you and the person will know it is going well, in plain words, for example "No ticket stays open longer than an hour". Null for "repeat".' }`
    - In `RoutineDefinitionJsonSchema`, defaults `'repeat'` and `null`.
    - Interval `every` description becomes `Interval of at least 60 seconds (15 minutes for a "stay-on-top" task), within the valid date range.`
    - Cron `expr` description becomes `Croner cron expression. For a "stay-on-top" task, runs must be at least 15 minutes apart.`
  - **channel-web compile fixes:** the ones listed under Files.

- [ ] **Step 4: Run, and see them pass.**
  - Rerun the contract file, which must be green.
  - Then `pnpm build`. channel-web's `tsc` lists any fixture you missed; fix each by adding the two fields.
  - Then `pnpm --filter @ax/channel-web test src/components/routines src/components/admin src/__tests__/routines-client.test.ts src/__tests__/routines-list.test.tsx src/__tests__/routines-default-parity.test.tsx src/__tests__/routine-manager-producer.test.tsx`.
  - Then `pnpm --filter @ax/routines-admin-routes test`. All green.

- [ ] **Step 5: Commit.** `feat(routines-contract): kind and goodWhen, per-kind rules, 15-minute check-in floor (TASK-906)`

---

### Task 2: `touchesTaskBrief`, `routineTaskProposal`, and the words the model reads [tier: sensitive] (security-checklist)

**Files:**
- Modify: `packages/routines-contract/src/tools.ts`: two new exports and `RoutineToolDescriptions.routine_create` / `.routine_update` (:94–95)
- Modify: `packages/agent-runner-core/src/system-prompt.ts:443-447` (`routineNote`)
- Test: `packages/routines-contract/src/__tests__/definition.test.ts` (new describes), `packages/agent-runner-core/src/__tests__/prompt-engine.test.ts` (`routine guidance`, :518)

**Interfaces:**
- Consumes: T1's schemas.
- Produces, in `tools.ts`:
  - `export const TASK_BRIEF_FIELDS = ['name', 'promptBody', 'goodWhen', 'kind'] as const`
  - `export function touchesTaskBrief(call: { name: string; input: unknown }): boolean`
  - `export type RoutineTaskProposal = { action: 'start'; definition: RoutineDefinition } | { action: 'change'; patch: RoutinePatch } | null`
  - `export function routineTaskProposal(call: { name: string; input: unknown }): RoutineTaskProposal`
  - Both are pure, never throw, read only `call.name` and `call.input`, and look nothing up.

- [ ] **Step 1: Write the failing tests.**
  - **`touchesTaskBrief (TASK-906)`.** An `it.each` of `[label, call, expected]`. `repeatDef` is `RoutineDefinitionSchema.parse` of a `1h` repeat. `taskDef` is a parsed `stay-on-top` with `15m`. `upd(patch)` is `{ name: 'routine_update', input: { routineId: 'r', requestId: 'q', expectedRevision: 'v', patch } }`.

    | label | call | expected |
    |---|---|---|
    | create repeat | `routine_create` `{ requestId: 'q', definition: repeatDef }` | false |
    | create stay-on-top | same with `taskDef` | true |
    | create malformed | `routine_create` `{}` | true |
    | create invalid definition | `routine_create` `{ requestId: 'q', definition: { ...repeatDef, trigger: { kind: 'interval', every: '30s' } } }` | true |
    | update enabled | `upd({ enabled: false })` | false |
    | update trigger | `upd({ trigger: { kind: 'interval', every: '2h' } })` | false |
    | update description | `upd({ description: 'x' })` | false |
    | update promptBody / goodWhen / goodWhen null / name / kind | `upd({ promptBody: 'x' })`, `upd({ goodWhen: 'x' })`, `upd({ goodWhen: null })`, `upd({ name: 'x' })`, `upd({ kind: 'repeat' })` | true |
    | update empty patch | `upd({})` | true |
    | update smuggled key | `upd(JSON.parse('{"__proto__":{"promptBody":"x"}}'))` | true |
    | update non-object input | `{ name: 'routine_update', input: null }`, and `'x'` | true |
    | other tools | `routine_delete` and `routine_fire_now` with valid input, and `Bash` | false |

  - **`routineTaskProposal (TASK-906)`:**
    - A `stay-on-top` create returns `{ action: 'start', definition: taskDef }`. A repeat create returns null.
    - `upd({ goodWhen: 'x' })` returns `{ action: 'change', patch: { goodWhen: 'x' } }`.
    - `upd({ kind: 'stay-on-top', goodWhen: 'x' })` returns `change`.
    - `upd({ promptBody: 'x' })`, `upd({ kind: 'repeat', goodWhen: null })`, a malformed update and `routine_delete` all return null.
  - **`tells the model the task rules`.**
    - `routine_create`'s description contains `People call routines "tasks".`, `goodWhen`, `15 minutes`, and `Creating a "stay-on-top" task always asks the person, even with Always Allow.`
    - `routine_update`'s contains `Changing name, promptBody, goodWhen or kind always asks the person, even with Always Allow.`
  - **In `prompt-engine.test.ts`'s `routine guidance`,** also expect `normal` to contain `always asks the person`. The two existing substrings stay.

- [ ] **Step 2: Run, and see them fail.** Run `pnpm --filter @ax/routines-contract test src/__tests__/definition.test.ts`: it fails because the imports don't exist. Run `pnpm --filter @ax/agent-runner-core test src/__tests__/prompt-engine.test.ts`: it fails on the new substring.

- [ ] **Step 3: Implement.**
  - **`touchesTaskBrief`:**
    - `routine_create`: `!RoutineCreateToolInputSchema.safeParse(input).success || data.definition.kind !== 'repeat'`. It's `!== 'repeat'`, not `=== 'stay-on-top'`, so PR 3's `get-done` is carved out automatically.
    - `routine_update`: `!RoutineUpdateToolInputSchema.safeParse(input).success || TASK_BRIEF_FIELDS.some(k => Object.hasOwn(data.patch, k))`.
    - Anything else: false.
  - **`routineTaskProposal`:**
    - `start` for a valid create with `definition.kind !== 'repeat'`.
    - `change` for a valid update whose patch has a string `goodWhen`, or a `kind` that is present and not `'repeat'`.
    - Otherwise null.
  - **Descriptions (exact):**
    - `routine_create`: `Create unattended interval, cron or webhook work. People call routines "tasks". kind "repeat" (the default) does the same job each time. kind "stay-on-top" is a "Stay on top of something" task: it needs goodWhen, an interval or cron schedule whose check-ins are at least 15 minutes apart, conversation "per-fire" and no silenceToken. Creating a "stay-on-top" task always asks the person, even with Always Allow. Other creates are held for approval unless Always Allow is enabled for this person and agent. Enabled controls scheduling. Use a new logical requestId and reuse it only for retries. Report success only after confirmation.`
    - `routine_update`: `Patch an authored routine using its current expectedRevision. Omitted fields stay unchanged; null clears optional fields. Trigger and activeHours replace complete objects. Changing name, promptBody, goodWhen or kind always asks the person, even with Always Allow. Other edits are held for approval unless Always Allow is enabled for this person and agent. A "stay-on-top" task keeps check-ins at least 15 minutes apart. Set enabled false to stop scheduling. Reuse requestId for retries.`
  - **`routineNote` (exact; this is a stale-line fix):** replace its third concatenated literal with `Creates and edits require approval unless the person enabled Always Allow for this agent. Creating a "stay-on-top" task, or changing any routine's name, promptBody, goodWhen or kind, always asks the person.` plus one trailing space, as the literal it replaces has.
    - The text contains both `'` and `"`, so write it as a template literal, or escape the apostrophe.
    - Keep the first, second and last literals byte-for-byte.

- [ ] **Step 4: Run, and see them pass.** Rerun both files. Run the contract's browser-bundle test (same file); it must stay green, because the helpers import nothing new.

- [ ] **Step 5: Commit.** `feat(routines-contract): touchesTaskBrief and routineTaskProposal; task rules in tool descriptions (TASK-906)`

---

### Task 3: `@ax/routines` persists `kind` and `goodWhen` [tier: sensitive]

**Files:**
- Modify: `packages/routines/src/migrations.ts`:
  - `RoutinesDefinitionsRow` (:9) gains `kind: ColumnType<RoutineKind, RoutineKind | undefined, RoutineKind>` and `good_when: ColumnType<string | null, string | null | undefined, string | null>`, with `RoutineKind` as a type-only import from the contract.
  - `runRoutinesMigration` (:111) gets a version-3 step.
- Modify: `packages/routines/src/store.ts`. `definitionColumns` (:51) adds `kind: d.kind, good_when: d.goodWhen`, and `rowToRoutine` (:58) adds `kind: row.kind, goodWhen: row.good_when`.
- No change to `packages/routines/src/definition.ts`. This was verified: `StoredRoutineSchema` extends the contract's object schema, `createRequestHash` hashes the validated definition, and `spec_hash` is `inputHash(d)` over the whole definition, so all three pick the fields up.
- Test: `packages/routines/src/__tests__/migrations.test.ts`, `store.test.ts`, `services.test.ts`

**Interfaces:**
- Consumes: T1's `RoutineDefinition` with `kind`/`goodWhen`.
- Produces: the `routines_v1_definitions.kind` column (`text NOT NULL DEFAULT 'repeat'`), the `good_when` column (`text NULL`), the CHECK `routines_v1_definitions_kind_chk`, and the version row `3` in `routines_schema_versions`.

- [ ] **Step 1: Write the failing tests.**
  - **`migrations.test.ts`, `adds kind and good_when to a version-2 database; existing rows read back as repeat/null`:**
    - `runRoutinesMigration(db)`.
    - Rewind to v2 with `ALTER TABLE routines_v1_definitions DROP CONSTRAINT IF EXISTS routines_v1_definitions_kind_chk, DROP COLUMN IF EXISTS kind, DROP COLUMN IF EXISTS good_when` and `DELETE FROM routines_schema_versions WHERE version = 3`.
    - Insert a v2-shaped row with raw SQL, using the column list from `retirement.test.ts:50`.
    - Run `runRoutinesMigration(db)` twice.
    - Expect the row's `kind = 'repeat'` and `good_when IS NULL`, `createRoutinesStore(db).findOne(...)` to match `{ kind: 'repeat', goodWhen: null }`, and `routines_schema_versions` to hold `2` and `3`.
  - **`migrations.test.ts`, `refuses an unknown kind at the database`:** after `runRoutinesMigration(db)`, an INSERT with `kind = 'get-done'` rejects with `code: '23514'` and `constraint: 'routines_v1_definitions_kind_chk'`. Use the `retirement.test.ts:50` column list plus `kind`. It must be an INSERT, not an UPDATE: `beforeEach` drops the schema, so the table is empty and an UPDATE matches nothing and never raises.
  - **`migrations.test.ts`:** in the two legacy-path tests, also assert that `information_schema.columns` lists `kind` and `good_when` after migration.
  - **`store.test.ts`, `persists kind and goodWhen through create and update, and they enter spec_hash`:**
    - `createAuthored` with a `stay-on-top` definition (`15m`, a `goodWhen`) returns `{ kind: 'stay-on-top', goodWhen }`, and so does `findOne`.
    - Two otherwise-identical creates that differ only in `goodWhen` store different `spec_hash` values.
    - `updateAuthored` with `{ goodWhen: 'new' }` persists it.
    - `updateAuthored` with `{ trigger: { kind: 'webhook', path: '/x' } }` rejects with `{ toolCode: 'validation' }` and leaves the row unchanged.
  - **`services.test.ts`, `a created task round-trips kind and goodWhen through routines:get, routines:list and routine_get`:**
    - Create through `routines:create` as `h.owner` with a `stay-on-top` definition.
    - `routines:get`, the authored entry of `routines:list`, and `tool:execute:routine_get` all equal the create's view. For the last, use `makeAgentContext({ ...h.owner, agentId: h.agentId })` and `{ id: 'get', name: 'routine_get', input: { routineId } }`. All three carry the kind and the `goodWhen`.
    - After `materializePersonalDefaults(h)`, the default row in the list reads `{ kind: 'repeat', goodWhen: null }`.

- [ ] **Step 2: Run, and see them fail.** `DOCKER_HOST=… pnpm --filter @ax/routines test src/__tests__/migrations.test.ts`, then the same for `store.test.ts` and `services.test.ts`. Expect failures: missing columns, and a task reads back as `repeat`.

- [ ] **Step 3: Implement.**
  - Restructure `runRoutinesMigration`. Keep one transaction and the same advisory lock (`18427131`). The early `return` on version 2 becomes `if (!v2Done) { …the existing v2 body…; INSERT version 2 }`. Then add `if (!v3Done) { await addTaskColumns(trx); INSERT version 3 }`.
  - `addTaskColumns` runs:

    ```sql
    ALTER TABLE routines_v1_definitions ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'repeat';
    ALTER TABLE routines_v1_definitions ADD COLUMN IF NOT EXISTS good_when TEXT;
    -- in a DO $$ … $$ block shaped like routines_v1_default_next_run_at_chk (:251-264):
    -- add CONSTRAINT routines_v1_definitions_kind_chk CHECK (kind IN ('repeat','stay-on-top')) only if pg_constraint lacks it
    ```
  - Leave `default_routines_v1` alone. `materializeMissing`'s INSERT and `refreshStale`'s UPDATE list their columns explicitly, so defaults take `'repeat'`/NULL.
  - Then the two `store.ts` changes and the row type.

- [ ] **Step 4: Run, and see them pass.** Rerun the three files. Then run the whole package: `DOCKER_HOST=… VITEST_MAX_WORKERS=2 pnpm --filter @ax/routines test`. Every suite stays green, including the receipt replay tests in `tools.test.ts` (old-shape receipts parse with defaults).

- [ ] **Step 5: Commit.** `feat(routines): persist kind and goodWhen behind a version-3 migration (TASK-906)`

---

### Task 4: Always Allow never covers a task's brief [tier: sensitive] (security-checklist)

**Files:**
- Modify: `packages/tool-policy/package.json`, adding `"@ax/routines-contract": "workspace:*"` to `dependencies`.
- Modify: `packages/tool-policy/tsconfig.json`, adding `{ "path": "../routines-contract" }` to `references`. Mirror `packages/decisions/tsconfig.json`.
- Modify: `pnpm-lock.yaml`, by running `pnpm install`. Commit the result.
- Modify: `packages/tool-policy/src/plugin.ts:692-700`.
- Modify: `docs/plans/2026-10-20-agent-tasks-design.md:347-350` (§4.2's Always Allow bullet; a stale-line fix).
- Test: `packages/tool-policy/src/__tests__/routine-consent.canary.test.ts`, and `packages/agents/src/__tests__/routine-consent.test.ts:54-56`.

**Interfaces:**
- Consumes: `touchesTaskBrief` (T2).
- Produces: `tool-policy:evaluate` answers `hold` for a consent-eligible create/update that touches a task's brief, keeping the matched rule's `ruleId` and `capability`. Its answers to everything else are unchanged.

- [ ] **Step 1: Write the failing tests.**
  - **Fix the existing tests first.** In `routine-consent.canary.test.ts`, the `evaluate` helper (:49) sends `input: {}`, and malformed input now holds on purpose. Add a fifth parameter, `input = WELL_FORMED[name] ?? {}`, after the existing `(h, name, ctx, agentId)`. Line 80 passes `'agent-2'` as the fourth argument, so the position matters. Names outside the map keep `{}`, which `evaluate.ts` treats as no predicate match.
    - `routine_create` → `{ requestId: 'q', definition: { name: 'Weekly summary', promptBody: 'Summarize.', trigger: { kind: 'interval', every: '1h' } } }`
    - `routine_update` → `{ routineId: 'r', requestId: 'q', expectedRevision: 'v', patch: { enabled: false } }`
    - Every existing assertion keeps its meaning. Do the same in `packages/agents/src/__tests__/routine-consent.test.ts`'s `verdict()` (:54) with the create input.
  - **New test, `Always Allow never covers a task's brief (TASK-906)`.** After `grant(h)`, an `it.each` asserting `(await evaluate(h, name, actor(h), 'agent-1', input)).verdict`:
    - allow: create repeat; update `{ enabled: false }`; update `{ trigger: { kind: 'interval', every: '2h' } }`.
    - hold: create `stay-on-top` (`goodWhen: 'Queue empty.'`, `every: '15m'`); create `{}`; update `{ promptBody: 'x' }`, `{ goodWhen: 'x' }`, `{ name: 'x' }` and `{ kind: 'repeat' }`; update with `patch: {}`.
    - Each hold also answers `ruleId: 'routines.create'` or `'routines.update'`, plus the rule's capability (`create routines` / `edit routines`). Decisions' card text depends on those.

- [ ] **Step 2: Run, and see them fail.** `DOCKER_HOST=… pnpm --filter @ax/tool-policy test src/__tests__/routine-consent.canary.test.ts`. The new hold rows answer `allow`.

- [ ] **Step 3: Implement.**
  - Import `touchesTaskBrief` from `@ax/routines-contract`.
  - At :696 make the condition `eligibleHold && !touchesTaskBrief(call) && (input.agentId === undefined || input.agentId === ctx.agentId) && await consentAllowed(ctx, ctx.agentId)`. The brief check goes before the database read.
  - Extend the comment above it (:692) with one sentence: a task's brief — creating a task, or changing a routine's name, instructions, going-well-when or kind — never inherits consent, so it stays a hold that `@ax/decisions` puts in front of a person.
  - Leave `evaluate.ts` and the capability rail (`list-capabilities`, :1308) alone. The rail already says "in some cases" for these rows.
  - Doc fix. In design §4.2 replace "Today, Always Allow on routine changes lets the agent rewrite instructions without asking. An agent's edit to a task's "what to do" or "going well when" always needs a yes." with: "Done in TASK-906: creating a task, and changing any routine's name, instructions, "going well when" or kind, always needs a yes, even with Always Allow (`touchesTaskBrief` in `@ax/routines-contract`, checked by tool-policy before consent can relax a hold)."

- [ ] **Step 4: Run, and see them pass.**
  - Rerun the tool-policy file.
  - Run `pnpm --filter @ax/tool-policy build`. The agents test imports tool-policy's `dist/`.
  - Then `DOCKER_HOST=… pnpm --filter @ax/agents test src/__tests__/routine-consent.test.ts`.
  - Then `pnpm --filter @ax/tool-policy test` and `pnpm build`.
  - Lint must not flag the new import: `pnpm lint` (or eslint on `packages/tool-policy/src/plugin.ts`).

- [ ] **Step 5: Commit.** `feat(tool-policy): Always Allow never relaxes a hold that touches a task's brief (TASK-906)`

---

### Task 5: `@ax/decisions` words a task hold as a task [tier: integration]

**Files:**
- Modify: `packages/decisions/src/templates.ts`: `DecisionTextInput` (:102) and the routine branch of `decisionText` (:163-187)
- Modify: `packages/decisions/src/pre-call.ts:248` (the `decisionText({...})` call)
- Test: `packages/decisions/src/__tests__/templates.test.ts` and `packages/decisions/src/__tests__/routine-authorization.test.ts`

**Interfaces:**
- Consumes: `routineTaskProposal` (T2).
- Produces: `DecisionTextInput.routineTask?: 'start' | 'change' | null`, a closed vocabulary that never carries call input.

- [ ] **Step 1: Write the failing tests.**
  - **`templates.test.ts`, `words a task hold as a task (TASK-906)`:**
    - `decisionText({ capability: null, toolName: 'routine_create', routineTask: 'start' })` has `summary` exactly `Wants to start a task` and `detail` exactly `Review the task before allowing it.`
    - With `routine_update` and `'change'`: `Wants to change a task` and `Review the change to this task before allowing it.`
    - With `routineTask` omitted, `routine_create` still reads `Wants to create a routine`.
    - In all three cases `primaryLabel` stays `Allow once`.
  - **`routine-authorization.test.ts`, `stores task wording on a held task proposal (TASK-906)`:**
    - Boot with `boot()`. Call `held(h, c)` with `c = { id: 'c-task', name: 'routine_create', input: { requestId: 'r-task', definition: { name: 'Zero open tickets', promptBody: 'Keep the queue empty.', kind: 'stay-on-top', goodWhen: 'No ticket open longer than an hour.', trigger: { kind: 'interval', every: '15m' } } } }`. The decision's `summary` is `Wants to start a task`.
    - A held `routine_update` with `patch: { goodWhen: 'x' }` reads `Wants to change a task`.
    - The existing `call()` (`patch: { name: 'Changed' }`) still reads `Wants to edit a routine`.

- [ ] **Step 2: Run, and see them fail.** Run `pnpm --filter @ax/decisions test src/__tests__/templates.test.ts`, then `DOCKER_HOST=… pnpm --filter @ax/decisions test src/__tests__/routine-authorization.test.ts`.

- [ ] **Step 3: Implement.**
  - In the routine branch of `decisionText`, pick `summary`/`detail` from `routineTask` using the exact strings above. Every other field keeps today's routine text.
  - In `pre-call.ts`, pass `routineTask: routine ? routineTaskProposal(call)?.action ?? null : null`. `routine` is the existing `routineToolKind(call.name) === 'write'`.
  - Add one line to the file header's H6 paragraph: `routineTask` is a closed enum derived from the input, never input text.
  - Keep the existing "nothing in `decisionText`'s signature can carry input" test as it is.

- [ ] **Step 4: Run, and see them pass.** Rerun both files, then the whole package: `DOCKER_HOST=… pnpm --filter @ax/decisions test`.

- [ ] **Step 5: Commit.** `feat(decisions): "Wants to start a task" / "Wants to change a task" (TASK-906)`

---

### Task 6: Open approvals carry the proposed task, fenced [tier: sensitive] (security-checklist)

**Files:**
- Create: `packages/channel-web/src/lib/task-schedule.ts` and its test, `packages/channel-web/src/lib/__tests__/task-schedule.test.ts`
- Modify: `packages/channel-web/src/lib/workspace-types.ts` (beside `DecisionRequest`, :142, and `Decision.request`, :199)
- Modify: `packages/channel-web/src/server/routes-workspace.ts`: constants beside `DECISION_REQUEST_*` (:2321), `wireTask` beside `wireRequest` (:2518), and `toWireDecision` (:2594)
- Modify: `packages/channel-web/src/components/workspace/__tests__/decision-fixture.ts`, adding `task: null` next to `request: null`
- Test: `packages/channel-web/src/__tests__/server/routes-workspace.test.ts` (`describe('decisions')`, next to the TASK-699 tests at :3481; `WIRE_KEYS` at :3174)

**Interfaces:**
- Consumes: `routineTaskProposal` (T2), and `fenceLine`/`fenceBlock` from `lib/fence-line.ts`.
- Produces:
  - In `task-schedule.ts`: `export function describeCheckIns(trigger: RoutineTrigger): string | null`, pure and browser-safe.
  - In `workspace-types.ts`, the `DecisionTask` type, plus a required `Decision.task: DecisionTask | null`:

    ```ts
    /** TASK-906 — a task-shaped routine proposal on an OPEN row. Every string is server-fenced, agent-authored data. */
    export interface DecisionTask {
      action: 'start' | 'change';
      name: string | null;
      instructions: { text: string; truncated: boolean } | null;
      goodWhen: { text: string; truncated: boolean } | null;
      checksIn: string | null;
    }
    ```
  - In `routes-workspace.ts`: `DECISION_TASK_NAME_MAX_CHARS = 128`, `DECISION_TASK_TEXT_MAX_CHARS = 2000`, `DECISION_TASK_TEXT_MAX_LINES = 40`, `DECISION_TASK_CHECKS_IN_MAX_CHARS = 200`, and `function wireTask(stored: StoredDecision): DecisionTask | null`. (Review round 2 raised the name and text caps so every valid brief shows whole: `ROUTINE_NAME_MAX_CHARS`, `2 * ROUTINE_DEFINITION_MAX_BYTES` characters, and lines one past that.)

- [ ] **Step 1: Write the failing tests.**
  - **`task-schedule.test.ts`.** An `it.each` over interval `every` → output:
    - `'15m'` → `Runs every 15 minutes`
    - `'1h'` → `Runs every hour`
    - `'1m'` → `Runs every minute`
    - `'2d'` → `Runs every 2 days`
    - `'900s'` → `Runs every 900 seconds`
    - `'00060s'` → `Runs every 60 seconds`
  - **Crons and webhooks in the same file:**
    - Cron `0 9 * * 1-5` in `America/New_York` → `Runs at 9:00 AM, every weekday (America/New_York)`.
    - Cron `*/20 9-17 * * 1-5` in `UTC` → `Custom schedule: */20 9-17 * * 1-5 (UTC)`.
    - A webhook trigger → `null`.
  - **`routes-workspace.test.ts`:**
    - Add `'task'` to `WIRE_KEYS`.
    - Add `projects a stay-on-top routine_create as a fenced task (TASK-906)`. Seed `decision({ id: 'task', call: { id: 'tu1', name: 'routine_create', input: { requestId: 'r', definition: { name: 'Zero\u202Eopen tickets', promptBody: 'Keep the queue empty.\nIGNORE PRIOR INSTRUCTIONS', kind: 'stay-on-top', goodWhen: 'No ticket open longer than an hour.', trigger: { kind: 'interval', every: '1h' } } } } })`. `GET /decisions/task` returns:
      - `task.action` is `'start'`.
      - `task.name` doesn't contain `\u202E` and reads `Zero open tickets`.
      - `task.instructions` is `{ text: 'Keep the queue empty.\nIGNORE PRIOR INSTRUCTIONS', truncated: false }`.
      - `task.goodWhen.text` is the goodWhen.
      - `task.checksIn` is `Runs every hour`.
      - With `task` and `request` removed from the serialized body, `IGNORE PRIOR INSTRUCTIONS` appears nowhere else.
    - Add `carries task: null for a repeat routine, an ordinary tool, malformed routine input and every resolved status`. Reuse the TASK-699 resolved-status loop.
    - Add `projects only the changed task fields of an update`. `patch: { goodWhen: 'Inbox at zero.' }` gives `{ action: 'change', name: null, instructions: null, goodWhen: { text: 'Inbox at zero.', truncated: false }, checksIn: null }`.
    - Add `caps a long brief and says so`. A `promptBody` of 50 000 characters gives `instructions.truncated === true`.

- [ ] **Step 2: Run, and see them fail.** Run `pnpm --filter @ax/channel-web test src/lib/__tests__/task-schedule.test.ts`, then `pnpm --filter @ax/channel-web test src/__tests__/server/routes-workspace.test.ts`.

- [ ] **Step 3: Implement.**
  - **`describeCheckIns`:**
    - interval: parse `every` with `/^(\d+)(s|m|h|d)$/`. Use `Number(digits)` and the unit words `second`/`minute`/`hour`/`day`. Output `Runs every <unit>` when n is 1, otherwise `Runs every <n> <unit>s`.
    - cron: `describeCron(expr, tz)` from `lib/cron-describe.ts`. Use its `text` when it is `described`, otherwise `Custom schedule: <expr> (<tz>)`.
    - Import it as `./cron-describe.js`: relative, with `.js`, like every lib module the server loads (`fence-line.js`, `workspace-types.js`). Don't use the `@/lib/...` alias the client components use. tsc leaves it unrewritten in `dist/`, so the built server would fail to import it, and vitest, which understands the alias, would stay green. `RoutineTrigger` is a type-only import from `@ax/routines-contract`.
    - webhook: `null`.
  - **`wireTask`:**
    - Return null unless `isOpenDecision(stored)` holds.
    - `const p = routineTaskProposal({ name: stored.call?.name ?? '', input: stored.call?.input })`. Return null when `p` is null.
    - Take the fields from `p.definition` (start) or `p.patch` (change). Each of the following is null when its field is absent:
      - `name` = `fenceLine(fields.name, DECISION_TASK_NAME_MAX_CHARS)`
      - `instructions` = `fenceBlock(fields.promptBody, DECISION_TASK_TEXT_MAX_CHARS, DECISION_TASK_TEXT_MAX_LINES)`
      - `goodWhen` = `fenceBlock` of a string `goodWhen` (same caps)
      - `checksIn` = `fenceLine(describeCheckIns(fields.trigger), DECISION_TASK_CHECKS_IN_MAX_CHARS)`
    - It is total, like `wireRequest`.
  - **Wiring:** add `task: wireTask(stored)` right after `request` in `toWireDecision`.
  - **Comments:** mention `task` in the `Decision` doc comment next to `request`'s TASK-699 paragraph: agent-authored, fenced, open rows only, never on the SSE frame.

- [ ] **Step 4: Run, and see them pass.** Rerun both files, then `pnpm --filter @ax/channel-web build` (`decision-fixture.ts` must type-check) and `pnpm --filter @ax/channel-web test src/__tests__/server`.

- [ ] **Step 5: Commit.** `feat(channel-web): open approvals carry the proposed task's fields, fenced (TASK-906)`

---

### Task 7: Both approval renderers show the task, and the Always Allow line changes [tier: sensitive] (security-checklist)

Invoke the `shadcn` skill before editing UI (CLAUDE.md invariant 6). The block mirrors `DecisionRequestBlock`: `rounded-md border border-border bg-muted`, with `text-muted-foreground` for labels. No raw colours.

**Files:**
- Create: `packages/channel-web/src/components/workspace/DecisionTaskBlock.tsx`
- Modify: `packages/channel-web/src/components/workspace/ApprovalCard.tsx`. Render the block between `d.preview` (:303) and `d.request` (:312), and change the Always Allow line (:342).
- Modify: `packages/channel-web/src/components/workspace/DecisionRow.tsx`. Same placement (between :340 and :351), and change :418.
- Modify: `packages/channel-web/src/components/workspace/decision-copy.ts`, adding the two exports below.
- Modify: `packages/channel-web/src/components/routines/RoutineConsentSection.tsx:94`, the granted-state line (a stale-line fix).
- Test: `packages/channel-web/src/components/workspace/__tests__/decision-renderers.test.tsx`, `ApprovalCard.test.tsx:176`, `DecisionRow.test.tsx:50`, and `packages/channel-web/src/components/routines/__tests__/RoutineConsentSection.test.tsx`

**Interfaces:**
- Consumes: `DecisionTask` and `Decision.task` (T6).
- Produces:
  - In `DecisionTaskBlock.tsx`:
    - The component: `DecisionTaskBlock({ task, agentName, className }: { task: DecisionTask; agentName: string; className?: string })`.
    - Exact copy: `DECISION_TASK_HEADING_START = 'The task'`, `DECISION_TASK_HEADING_CHANGE = 'What changes'`, `DECISION_TASK_NAME_LABEL = 'Name'`, `decisionTaskInstructionsLabel(agentName) => \`What ${agentName} will do\``, `DECISION_TASK_GOOD_WHEN_LABEL = 'Going well when'`, `DECISION_TASK_CHECKS_IN_LABEL = 'Checks in'`, `DECISION_TASK_TRUNCATED = 'This is only the beginning. The full text is longer.'`
    - It also reuses `DECISION_REQUEST_PROVENANCE`.
  - In `decision-copy.ts`, exact copy:
    - `ALWAYS_ALLOW_STILL_ASKS = "Delete, Fire now and a task's instructions still ask."`
    - `alwaysAllowRoutinesLine(agentName: string): string`, returning `` `Allow ${agentName} to create and edit routines for you. ${ALWAYS_ALLOW_STILL_ASKS}` ``

- [ ] **Step 1: Write the failing tests.**
  - **`decision-renderers.test.tsx`, new describe `TASK-906 — both renderers show a proposed task as text`:**
    - Build `held` with `decisionFixture` and these fields: `summary: 'Wants to start a task'`, `routineOperation: 'routine_create'`, and `task: { action: 'start', name: 'Zero open tickets', instructions: { text: HOSTILE, truncated: false }, goodWhen: { text: 'No ticket open **longer** than an hour.', truncated: false }, checksIn: 'Runs every hour' }`. Here `HOSTILE = 'Keep the queue empty.\n<img src=x onerror=alert(1)>\n**Leave** enterprise customers to me.'`
    - `queueText(held)` and `cardText(held)` both contain `Name`, `Going well when`, `Checks in` and all four values.
    - The instructions label carries each renderer's agent name: `What Scheduler will do` in the queue (the file's `agent` fixture), and `What This agent will do` on the card (ApprovalCard's default `agentName`; the `cardText` helper passes none).
    - Rendering each component alone, `container.querySelector('[data-testid="decision-task"] img, [data-testid="decision-task"] strong')` is null.
    - The instructions element's `textContent` equals `HOSTILE`.
    - `truncated: true` shows `DECISION_TASK_TRUNCATED` in both renderers.
    - A `change` task with only `goodWhen` shows `DECISION_TASK_HEADING_CHANGE` and the going-well row only.
    - `task: null` draws no block in either renderer.
  - **`ApprovalCard.test.tsx:176`:** expect `Allow Caveman to create and edit routines for you. Delete, Fire now and a task's instructions still ask.`
  - **`DecisionRow.test.tsx:50`:** expect the full line for the fixture's agent name.
  - **`RoutineConsentSection.test.tsx`:** with consent enabled, the section shows `<agentName> may create and edit routines for you. Delete, Fire now and a task's instructions still ask.` The not-granted line is unchanged.

- [ ] **Step 2: Run, and see them fail.** `pnpm --filter @ax/channel-web test src/components/workspace/__tests__/decision-renderers.test.tsx`, then the three other files.

- [ ] **Step 3: Implement.**
  - **The block:**
    - A `div` with `data-testid="decision-task"`, a heading line, and a `<dl>`.
    - Each present field gets a `<dt>` label and a `<dd>`. The instructions and going-well `<dd>`s use `whitespace-pre-wrap break-words` and carry `data-testid="decision-task-instructions"` / `data-testid="decision-task-good-when"`.
    - Put the truncated note under a cut field, and the provenance line last.
    - Values are plain React text only.
  - **Placement:** draw `{d.task && <DecisionTaskBlock … />}` in both renderers, at the placements under Files. ApprovalCard passes `agentName` and DecisionRow passes `agent.name`.
  - **Always Allow line:** both renderers use `alwaysAllowRoutinesLine(...)`. The granted line in `RoutineConsentSection` becomes `` `${agentName} may create and edit routines for you. ${ALWAYS_ALLOW_STILL_ASKS}` ``.

- [ ] **Step 4: Run, and see them pass.** Rerun the four files. Then `pnpm --filter @ax/channel-web test src/components/workspace src/__tests__/workspace-decision-queue.test.tsx`, which covers the consent-focus and announce tests, and `pnpm --filter @ax/channel-web build`.

- [ ] **Step 5: Commit.** `feat(channel-web): approval cards show a proposed task; Always Allow says a task's instructions still ask (TASK-906)`

---

### Task 8: The Settings Routines tab keeps working on a task [tier: mechanical]

**Files:**
- Modify: `packages/channel-web/src/components/routines/RoutineEditor.tsx:65-75`, adding `'kind'` and `'goodWhen'` to `editableKeys`. No new form fields.
- Test: `packages/channel-web/src/components/routines/__tests__/RoutineEditor.test.tsx`, `packages/channel-web/src/__tests__/routines-list.test.tsx`

**Interfaces:**
- Consumes: T1's fields and messages.

- [ ] **Step 1: Write the regression guards.** `task` is `{ ...routineFixture, kind: 'stay-on-top', goodWhen: 'Inbox at zero.', trigger: { kind: 'interval', every: '1h' } }`.
  - **`RoutineEditor.test.tsx`, `keeps a task's kind and goodWhen when Settings edits its instructions (TASK-906)`:**
    - Mock `routineApi.get` to resolve `task`, then call `edit()`.
    - Change the "What should … do?" textarea to `Answer the easy ones.` and save.
    - `routineApi.update` is called with `{ agentId, routineId, requestId: expect.any(String), expectedRevision: task.revision, patch: { promptBody: 'Answer the easy ones.' } }`. The patch is exactly that one key.
  - **`RoutineEditor.test.tsx`, `explains the check-in floor and blocks Save for a task under 15 minutes`:**
    - With the same mock, set the Interval field to `5m`.
    - `Check-ins need to be at least 15 minutes apart.` is visible, and the Save button is disabled.
  - **`RoutineEditor.test.tsx`, `explains that a task can't run from a webhook and blocks Save`:**
    - With the same mock, choose `Webhook` in the "When to run" toggle group. It sets the valid default path `/project-updates` and clears active hours (`RoutineEditor.tsx:393-399`), so the first issue is the task rule.
    - `A task that stays on top of something checks in on a schedule, not from a webhook.` is visible, and Save is disabled.
  - **`routines-list.test.tsx`, `renders a stay-on-top task like any authored routine`:** `routineApi.list` resolves `[task]`, and the row shows its name and its Edit control.

- [ ] **Step 2: Run them.** `pnpm --filter @ax/channel-web test src/components/routines/__tests__/RoutineEditor.test.tsx src/__tests__/routines-list.test.tsx`. These guard behaviour T1 already made true, so they pass. Prove each guard bites:
  - Make `changed()` return the whole form. The first test must go red. Revert.
  - Replace `initial={loaded ? editableDefinition(loaded) : empty()}` with a version that forces `kind: 'repeat', goodWhen: null`. The floor test and the webhook test must both go red, because a repeat routine allows both. Revert.

- [ ] **Step 3: Implement.** Add the two keys to `editableKeys`. That way a future task editor field can't be silently left out of the patch.

- [ ] **Step 4: Run.** Rerun both files, plus `src/components/routines` and `src/__tests__/routines-default-parity.test.tsx`. All green.

- [ ] **Step 5: Commit.** `test(channel-web): a Settings edit keeps a task's kind and goodWhen (TASK-906)`

---

### Task 9: Canary — Always Allow, a held task, one approval [tier: integration]

**Files:**
- Test: `packages/routines/src/__tests__/canary.test.ts`. Add a new `it` to the `registered approval-to-tick-to-webhook cutover canary` describe.

**Interfaces:**
- Consumes: T3's persistence, T4's carve-out and T5's wording, through the real `createRoutineHarness()`. The harness boots real tool-policy, decisions, agents and Postgres.

- [ ] **Step 1: Write the canary.** Name it `with Always Allow granted, creating a task and editing its brief still ask, and one approval creates it (TASK-906)`. Sequence:

  ```ts
  h = await createRoutineHarness();
  h.setAttended(false); // unattended: an approval replays on the host now (decisions plugin.ts ~:876)
  const ctx = makeAgentContext({ ...h.owner, agentId: h.agentId, conversationId: 'conversation' });
  const store = createRoutinesStore(h.db);
  const create = (requestId: string, extra = {}) => ({ id: requestId, name: 'routine_create', input: { requestId,
    definition: RoutineDefinitionSchema.parse({ name: requestId, promptBody: 'Summarize.', trigger: { kind: 'interval', every: '1h' }, ...extra }) } });
  // 1. Grant Always Allow the real way: approve a repeat create with the agent-routines scope.
  const first = await h.bus.fire('tool:pre-call', ctx, create('weekly')); // isHold
  await h.bus.call('decisions:approve', ctx, { decisionId: first.hold.decisionId, userId: ctx.userId, approvalScope: 'agent-routines' });
  // expect tool-policy:get-routine-consent → enabled true; store.list has 'weekly'
  // 2. Consent is live: another repeat create is not held.
  // expect (await h.bus.fire('tool:pre-call', ctx, create('monthly'))).rejected === false
  // 3. A task create is still held, and reads as a task.
  const task = create('Zero open tickets', { kind: 'stay-on-top', goodWhen: 'No ticket open longer than an hour.', trigger: { kind: 'interval', every: '15m' } });
  const held = await h.bus.fire('tool:pre-call', ctx, task); // isHold
  // decisions:get { decisionId, userId } → decision.summary === 'Wants to start a task'
  // 4. One "Allow once" creates it.
  await h.bus.call('decisions:approve', ctx, { decisionId: held.hold.decisionId, userId: ctx.userId, approvalScope: 'once' });
  // store.list → the task row has kind 'stay-on-top' and the goodWhen; tool:execute:routine_get returns both
  // 5. Its brief still asks; pausing it does not.
  // routine_update { patch: { promptBody: 'Answer everything.' } } through tool:pre-call → isHold
  // routine_update { patch: { enabled: false } } → rejected === false
  ```

  If step 1 or step 4 doesn't execute inline in this harness, use the attended recipe the existing cutover canary uses (:107-110). Approve, then `h.advance(11_000)`, then call `tool:execute:routine_create` directly. Change the test's setup, not product code.

- [ ] **Step 2: Prove the canary bites without the carve-out.**
  - In the working tree, delete `!touchesTaskBrief(call) &&` from `packages/tool-policy/src/plugin.ts`.
  - Rebuild with `pnpm --filter @ax/tool-policy build`. The routines tests import tool-policy's `dist/`.
  - Run `DOCKER_HOST=… pnpm --filter @ax/routines test src/__tests__/canary.test.ts`. The task-create hold assertion (sequence step 3) must fail.
  - Commit everything first, so `plugin.ts` is committed-clean before you mutate it. Restore with `git checkout HEAD -- packages/tool-policy/src/plugin.ts` (with `HEAD`: the bare form restores from the index, which may hold the mutant), check `git status --short` is empty, rebuild, and rerun: green.

- [ ] **Step 3: Commit.** `test(routines): canary — Always Allow never covers a task's creation or brief (TASK-906)`

---

## Before the PR

- [ ] Run the full gates from Global Constraints, with an explicit `DOCKER_HOST`. All green, and `pnpm lint` clean.
- [ ] Run `security-checklist` once over T2, T4, T6 and T7, and put the note in the PR body. Answers to start from:
  - **Prompt injection.** The carve-out exists for this case: an instruction injected through a ticket can no longer get an Always Allowed agent to rewrite a task's brief. `touchesTaskBrief` reads only the call's own input through the strict contract schemas, looks nothing up by a model-named id, and fails toward asking: malformed input means hold. Model-drafted brief text crosses to the browser only in the fenced `task`/`request` fields of open rows, and is drawn as React text.
  - **Sandbox escape.** N/A. No sandbox, IPC transport or mount change. The tool input arrives over the existing host-tool path and is parsed strictly.
  - **Supply chain.** No new external package. `@ax/tool-policy` gains a workspace dependency on `@ax/routines-contract`, whose only dependencies are croner 8.1.2 and zod, both already locked.
- [ ] Boundary review, for the PR body:
  - No new hook.
  - `routines:create/update/get/list` and the `routine_*` tool schemas gain `kind` and `goodWhen`, which are domain words. The default-routine hooks carry `kind: 'repeat'` / `goodWhen: null` literals.
  - Alternate impl: an external tracker (Linear, Asana) behind the same hooks could carry both.
  - Leaking names: none.
  - Subscriber risk: none. No subscriber reads routine definitions: `@ax/routines` fires no events and nothing subscribes to `routines:*`.
  - Wire surface: the tool schemas stay in `@ax/routines-contract`.
  - channel-web's `Decision.task` is a browser projection, not a hook.
- [ ] Name in the PR body the choices a reviewer may question: decisions rows 2 (fixed-reference floor), 8 (input-only task wording), 10 (`Decision.task`, with the request block kept), 12 (the copy understates what still asks) and 19 (Always Allow still offered on a task card).
- [ ] Cut on purpose (YAGNI):
  - no editor fields or list badge for tasks
  - no cache for the cron floor
  - no new `SafeToolField` values
  - no task wording on receipts
  - no routine lookup for wording
  - no `get-done`
  - no change to firing, silence or the webhook handler
