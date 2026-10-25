# TASK-957 Agent Tasks PR 3 hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four gaps PR 3's builders handed on: the Settings routes give the browser a task's agent-written text, a report's text skips the brief's two combining-mark rules, a `task_steps` value that isn't a list reads as "no steps" without a word, and `routines_task_completed` logs on presses that changed nothing.

**Architecture:** Four independent tasks in three packages. No service-hook signature changes, no migration (routines stays at schema version 13), no UI change. Task 1 projects every routine view and run the Settings routes answer (`task: null`, `steps: []`, a run's `report: null`). Task 2 adds `BASELESS_MARK` and `MARK_STACK` to the contract's `reportText`. Task 3 makes `rowToRoutine` write one stderr line, ids only, when `task_steps` isn't a list. Task 4 has `completeTask` say what it did, and `routines:complete` logs only when the task moved to Done.

**Tech Stack:** TypeScript, zod 3.25.76, Kysely on Postgres 16 (testcontainers), vitest.

**Spec:** the TASK-957 card (its items 1-4 are restated, checked, under Premises) and `docs/plans/2026-10-20-agent-tasks-design.md` §7. The decisions behind this plan: `.claude/memory/decisions/2026-10-25-TASK-957.md`.

## Premises, checked against 4718946da

**True.**
- Item 1: the Settings handlers (`packages/routines-admin-routes/src/routes.ts:101-220`) send the routines services' answers as they parse. For the task's owner, `list`, `get`, `create` and `update` carry `task` (`update`, `ask`, `reading.label`, `agentNotes`) and `steps[].text`, and `fires` carries each run's `report` (`update`, `ask`, `reading.label`). The workspace routes fence the same text (`packages/channel-web/src/server/routes-workspace.ts:3580`, `:3648`, `:3742`, `:3978`, `:4022`).
- Item 2: `reportText` (`packages/routines-contract/src/definition.ts:504-514`, not "around 480") refuses blank text, line breaks in one-line fields, hidden characters and broken ones, and nothing else. `BASELESS_MARK` (`:310`) and `MARK_STACK` (`:312`) are used only by `briefFieldIssue` (`:332-333`).
- Item 3: `storedSteps` (`packages/routines/src/steps.ts:59-61`) reads a non-list as `[]` and says nothing. Its callers: `rowToRoutine` (`packages/routines/src/store.ts:617`: every read, `claimDue`'s included), `setSteps`' replay (`:1288`) and `copiedSteps` (`packages/routines/src/duplicate.ts:48`).
- Item 4: `routines:complete` logs after every `store.completeTask` (`packages/routines/src/services.ts:444`), and `completeTask` answers `{ done: true }` alike for a move, a task already Done (`store.ts:1198`) and a receipt replay (`store.ts:745`).

**Refined.**
- `reportText` also checks `notes` (`definition.ts:535`), so Task 2 reaches four fields: update, ask, notes and the reading's label.
- No shared fence exists. `@ax/core/surface-text` holds only the character class and `replaceSurfaceRewriters`; `fenceLine`/`fenceBlock` live in `packages/channel-web/src/lib/fence-line.ts`, which `@ax/routines-admin-routes` may not import (invariant 2; its dependencies are `@ax/core`, `@ax/routines-contract` and `zod`). The Settings UI reads none of these fields (decisions row 2), so Task 1 takes the card's "leave it out" branch.
- The store has no logger (`createRoutinesStore(db)`), and `storedSteps` is pure and stays so. The store's own diagnostics are stderr lines with ids only (`store.ts:996`, `:1000`); Task 3 uses that form.
- What made item 4 look covered: `packages/routines/src/__tests__/done.test.ts:121-138` ("...once, and says so in one line") sends its replay (`:135`) through a fresh context, so nobody read the replay's line.

## Global Constraints

- Base: origin/main 4718946da or later. Routines schema stays at version 13: this card adds no migration.
- No service-hook signature or subscriber payload changes, so no boundary review. `completeTask` is a store method; `routines:complete`'s input and output stay as they are.
- `@ax/routines-admin-routes` imports only `@ax/core`, `@ax/routines-contract` and `zod` (invariant 2).
- Report text rules hold at the writer's input only. Stored text and views are never re-checked (TASK-913).
- Log lines carry ids, counts and closed words only: never a report's text, a step's text or a stored value.
- Copy, exact. The two messages use U+2019 apostrophes, as `reportText`'s other messages do; the stderr line is ASCII:
  - `A report can’t have an accent or other combining mark at the start of a line or after a space.`
  - `A report can’t stack more than 8 accents or other combining marks on one character.`
  - `` `[ax/routines] steps of routine ${agentId}/${routineId} aren't stored as a list, so they read as none\n` ``
- Test inputs with combining marks, non-Latin letters or invisible characters are escape text (`'\u0301'`), never raw characters. The Write and Edit tools have turned such escapes into raw characters seven times (`.claude/memory/mistakes/2026-10-24-TASK-951.md`). After each task, run this escape check over the lines you added (not whole files: the design doc and `store.ts` already hold arrows and dashes outside the list). It must print `[]`:

  ```bash
  git diff -U0 origin/main -- <paths> | python3 -I -c "import sys;ok={0xa7,0xb1,0xb7,0x2014,0x2019,0x201c,0x201d,0x2026};t=sys.stdin.buffer.read().decode('utf-8');print(sorted({hex(ord(c)) for l in t.splitlines() if l.startswith('+') and not l.startswith('+++') for c in l if ord(c)>126 and ord(c) not in ok}))"
  ```
  To repair a file, re-escape with a script that builds the backslash from `chr(92)` (never typed): BMP code points as backslash-u plus four hex digits, astral ones as backslash-u-brace form.
- `@typescript-eslint/no-unused-vars` is an error in test files too, so a test file imports only what its tests use (`.claude/memory/mistakes/2026-10-24-TASK-948.md`).
- `@ax/routines-contract` reaches its dependents through `dist/`: after Task 2, run `pnpm --filter @ax/routines-contract build` before any routines or routines-admin-routes test.
- One file: `pnpm --filter <pkg> exec vitest run <path>`. `pnpm --filter <pkg> test -- <file>` runs the whole package.
- Docker-backed suites: every `packages/routines/src/__tests__/*.test.ts` that calls `fixture()` or `createRoutineHarness` (every routines test file Tasks 3 and 4 change, and `report-tool.test.ts`), and `packages/routines-admin-routes/src/__tests__/human-rest-integration.test.ts`. They need `DOCKER_HOST`; locally `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock`, checked first with `timeout 15 docker info`. If Docker hangs, use the card's Postgres stand-in, drop every database you create, and name each skipped suite in the handoff. CI's postgres:16 run is the gate. Pure (no Docker): everything in `packages/routines-contract`, `routes.test.ts`, `stored-steps.test.ts`, `checkin-message.test.ts`.
- Parallel cards: TASK-944 (no shared files) and TASK-945 (`.max()` on untrusted zod arrays; it may edit `packages/routines-contract/src/*.ts`). If either merges first, rebase and re-run the suites each task names.

## Review Focus

1. A later card adds a field to `RoutineView` or `RoutineFireView` that an agent writes. Settings must not pass it on unreviewed. Task 1 pins both key sets, so the new field fails a test until someone decides.
2. Ordinary text in scripts that use combining marks (Vietnamese in NFD, Hindi, Thai, pointed Hebrew, vowelled Arabic, a Tibetan stack) and emoji keycaps must still pass in every report field. Task 2 extends the acceptance cases.
3. A due get-done task whose `task_steps` isn't a list must still be claimed by the tick, with no steps, and never stop the batch. Task 3 claims one.
4. Two Mark done presses at once on a running task must give exactly one `completed` (one log line) and one `already-done`. Task 4 runs them together.
5. A Mark done retried after a Reopen must replay: no write, the task keeps running, no log line. Task 4 covers it at the store and at the service.

## Security

Run the `security-checklist` skill for Task 1 (agent-written text crossing to a browser) and Task 2 (validation of agent-written text), and paste its `## Security review` block (Sandbox, Injection, Supply chain, each with a reason) into the PR. Expected shape: sandbox escape N/A (no sandbox, IPC, path, process or network change); prompt injection: Task 1 removes a path by which agent text reaches the Settings page, and Task 2 refuses mark tricks before a report is stored, both on the host; supply chain: no new dependency. Tasks 3 and 4 change log behaviour only, and their tests pin that no agent text reaches a log line.

---

### Task 1: The Settings routes answer no task state [tier: sensitive]

Needs `security-checklist`.

**Files:**
- Modify: `packages/routines-admin-routes/src/routes.ts` (two helpers above `createRoutinesAdminHandlers`, `:91`; its `list`, `get`, `create`, `update` and `fires` handlers, `:101-220`)
- Test: `packages/routines-admin-routes/src/__tests__/routes.test.ts` (`setup`, `:82-130`; one new describe)
- Test: `packages/routines-admin-routes/src/__tests__/human-rest-integration.test.ts:289-404` (Docker)
- Modify, stale prose: `packages/routines/src/services.ts:50-53`; `packages/routines/src/__tests__/report-tool.test.ts:231-234`
- Modify, comment: `packages/channel-web/src/lib/routines.ts:14-15`
- Modify, doc: `docs/plans/2026-10-20-agent-tasks-design.md:674-675` (§7)

**Interfaces:**
- Produces nothing other tasks use. Module-private in `routes.ts`: `settingsView(view: C.RoutineView): C.RoutineView`, returning `{ ...view, task: null, steps: [] }`, and `settingsFire(fire: C.RoutineFireView): C.RoutineFireView`, returning `{ ...fire, report: null }`.

- [ ] **Step 1: Write the failing unit tests**

In `routes.test.ts`, give `setup` an optional `answers?: { view?: unknown; fires?: unknown[] }`. When `view` is set, `routines:list` answers `{ routines: [view] }` and `routines:get`, `routines:create` and `routines:update` answer `view`; when `fires` is set, `routines:recent-fires` answers `{ fires }`. Every other answer stays as it is. Import `RoutineViewSchema` beside `RoutineDefinitionSchema`. Then add:

```ts
describe('the Settings routes answer no task state (TASK-957)', () => {
  // Text only an agent writes: a task's report, notes and reading label, its steps, and each run's report.
  const AGENT_TEXT = {
    update: 'Agent update 5d1c', ask: 'Agent ask 5d1c', notes: 'Agent notes 5d1c', label: 'Agent label 5d1c',
    agentStep: 'Agent step 5d1c', personStep: 'Person step 5d1c',
    runUpdate: 'Run update 5d1c', runAsk: 'Run ask 5d1c', runLabel: 'Run label 5d1c',
  };
  /** A Done get-done task as the services answer its owner: every field set. */
  const taskView = {
    ...RoutineDefinitionSchema.parse({
      name: 'Move the help docs', promptBody: 'Move our help docs to the new site.', enabled: false,
      trigger: { kind: 'interval', every: '1h' }, kind: 'get-done', goodWhen: 'Every article is on the new site.',
    }),
    agentId: 'a', routineId: 'rtn_a', revision: 'rev1', origin: 'authored', defaultRoutineId: null,
    nextRunAt: null, lastRunAt: '2026-10-25T09:00:00.000Z', lastStatus: 'ok', lastError: null, lastWarning: null,
    permissions: { edit: true, stop: true, fire: true, manageSecret: true },
    task: {
      status: 'needs-you', update: AGENT_TEXT.update, ask: AGENT_TEXT.ask, reading: { value: 3, label: AGENT_TEXT.label },
      doneClaimed: false, reportedAt: '2026-10-25T09:05:00.000Z', agentNotes: AGENT_TEXT.notes,
    },
    noRecentUpdate: { inARow: 2, reason: 'no-report', at: '2026-10-25T09:30:00.000Z', autoPaused: false },
    steps: [
      { id: 's000001', text: AGENT_TEXT.agentStep, done: true, addedBy: 'agent' },
      { id: 's000002', text: AGENT_TEXT.personStep, done: false, addedBy: 'person' },
    ],
    finishBy: '2026-11-01', done: { at: '2026-10-25T09:40:00.000Z' },
  };
  const runView = {
    agentId: 'a', routineId: 'rtn_a', firedAt: '2026-10-25T09:00:00.000Z', triggerSource: 'tick', conversationId: 'conv_1',
    status: 'ok', error: null, renderedPrompt: null, warning: null,
    report: { status: 'on-track', update: AGENT_TEXT.runUpdate, ask: AGENT_TEXT.runAsk, reading: { value: 2, label: AGENT_TEXT.runLabel } },
  };
  /**
   * Every field a Settings routine view carries, reviewed. A new field fails here on purpose: if an agent
   * writes any of it, settingsView leaves it out; if only the host or a person writes it, add it here.
   */
  const VIEW_KEYS = ['activeHours', 'agentId', 'conversation', 'defaultRoutineId', 'description', 'done', 'enabled',
    'finishBy', 'goodWhen', 'kind', 'lastError', 'lastRunAt', 'lastStatus', 'lastWarning', 'name', 'nextRunAt',
    'noRecentUpdate', 'origin', 'permissions', 'promptBody', 'revision', 'routineId', 'silenceMaxChars',
    'silenceToken', 'steps', 'task', 'trigger'];
  /** Every field a Settings run carries, reviewed the same way. */
  const RUN_KEYS = ['agentId', 'conversationId', 'error', 'firedAt', 'renderedPrompt', 'report', 'routineId',
    'status', 'triggerSource', 'warning'];
  // the three tests below
});
```

The three tests, each on `setup({ answers: { view: taskView, fires: [runView] } })`:

1. `it('no route answers any text an agent wrote, to the task’s owner included')`: a record `requests` from handler name to request, one per handler: `list: req()`, `get: req()`, `create: req({ requestId: 'create', definition })`, `update: req({ requestId: 'edit', expectedRevision: 'rev1', patch: { name: 'Renamed' } })`, `destroy: req({ requestId: 'delete', expectedRevision: 'rev1' })`, `fire: req({ requestId: 'fire', expectedRevision: 'rev1' })`, `fires: req()`, `consent: req()`, `revokeConsent: req({})`, `receiver: req()`. Assert `Object.keys(requests).sort()` equals `Object.keys(h).sort()`, so a new route can't skip this test. For each, the status is in 200..299 and `JSON.stringify(body)` contains none of `Object.values(AGENT_TEXT)`; label each `expect` with the handler's name and the text.
2. `it('a routine view keeps the routine and what the host wrote, with task null and steps empty')`: for `list` (its `routines[0]`) and `get`, `create`, `update` (their `routine`): the view equals `{ ...taskView, task: null, steps: [] }`; `Object.keys(view).sort()` equals `[...VIEW_KEYS].sort()`; `RoutineViewSchema.safeParse(view).success` is `true` (the SPA types this answer as a `RoutineView`).
3. `it('a run keeps everything but its report')`: the `fires` body equals `{ fires: [{ ...runView, report: null }] }`, and its run's sorted keys equal `[...RUN_KEYS].sort()`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @ax/routines-admin-routes exec vitest run src/__tests__/routes.test.ts`
Expected: the three new tests FAIL (the served JSON contains `Agent update 5d1c`; `task` isn't null). The existing tests pass.

- [ ] **Step 3: Implement the projection in `routes.ts`**

Add `settingsView` and `settingsFire` (see Interfaces) above `createRoutinesAdminHandlers`, under one doc comment that says, in substance: TASK-957. Settings shows a routine, never a task's state. A task's report (its update, ask, reading and notes), its steps and each run's report are the agent's text; the task page reads them through channel-web's workspace routes, which fence and cap every line, and Settings draws none of them. So every Settings answer leaves them out, the values the services already give anyone but the task's owner: `task` null, `steps` empty, a run's `report` null. What the host writes (missed check-ins, when it was marked done) and the person's finish date stay.

Route each view through `settingsView` (`list`: `{ routines: out.routines.map(settingsView) }`; `get`, `create` and `update`: `{ routine: settingsView(...) }`) and each run through `settingsFire` (`fires`: `{ fires: out.fires.map(settingsFire) }`). Status codes, parse schemas and the order of checks stay as they are.

- [ ] **Step 4: Run the unit tests to see them pass**

Run: `pnpm --filter @ax/routines-admin-routes exec vitest run src/__tests__/routes.test.ts`
Expected: PASS, every test in the file.

- [ ] **Step 5: Turn the integration test to the owner (Docker)**

In `human-rest-integration.test.ts`, the test at `:289` ("serves a team task's state and its runs' reports only to the task's owner") becomes `it("serves a task's state and its runs' reports to no one, its owner included (TASK-957)")`:
- `createRoutineHarness({ authenticatedUserId: 'owner' })`: the Settings routes now act as the task's owner, the case that used to leak.
- The task is `kind: 'get-done'`, with `goodWhen: 'Every article is on the new site.'` (name, promptBody and trigger as now). `recordReport` also sends `steps: [{ op: 'add', text: STEP }]`, with `const STEP = 'Ask Dana to review billing.'`, so its assertion changes from `.toBe('recorded')` to `.toEqual({ outcome: 'recorded', applied: 1, skipped: 0 })`.
- Through the Settings routes: the listed view and the got view have `task: null` and `steps: []`, the run's `report` is `null`, and the served JSON contains none of `notes`, `report.update`, `report.ask`, `reading.label` and `STEP`.
- The owner's own service reads still have all of it: `routines:get` as `h.owner` keeps today's `task` assertion and adds `steps` equal to `[{ id: expect.any(String), text: STEP, done: false, addedBy: 'agent' }]`; the `routines:recent-fires` assertion stays.
- The comment at `:290-291` ("TASK-907: the routes serve the routines services' answers as they are, so the services decide. ...") becomes, in substance: TASK-957: Settings never draws a task's state, so its routes leave it out for everyone, the owner included; the services still decide who else may read it (TASK-907), and the owner's own reads below have all of it.

Run: `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm --filter @ax/routines-admin-routes test`
Expected: PASS, both files. Then check that the tests bite, one helper at a time: with `settingsView` returning `view` unchanged, unit tests 1 and 2 and this test fail; with `settingsFire` returning `fire` unchanged, unit tests 1 and 3 and this test fail. Restore both.

- [ ] **Step 6: Fix the prose this change makes false**

- `packages/routines/src/services.ts:50-53` says no caller, the Settings routes included, "needs a rule of its own for these". Make it say no caller (a tool, the Settings routes, the Tasks page) needs an owner rule of its own for these, and that the Settings routes go further and leave a task's state out for everyone, the owner included, since Settings never draws it (TASK-957).
- `packages/routines/src/__tests__/report-tool.test.ts:231-234`: "the services, which the Settings routes (and the Tasks page) serve as they are" becomes: the services (the Tasks page shows their text through fenced routes; the Settings routes leave a task's state out, TASK-957), and the tools in that person's own chat with the agent.
- `packages/channel-web/src/lib/routines.ts:14-15`, above `export type Routine = RoutineView;`: a doc comment saying a Settings answer carries no task state (TASK-957): `task` is always null, `steps` always empty and a run's `report` always null; a task's page reads them, fenced, through `workspaceApi`.
- Design §7, `docs/plans/2026-10-20-agent-tasks-design.md:674-675`: after "They are length-capped and rendered as plain text.", add: "The task page gets them through channel-web's workspace routes, which fence each line; the Settings routes leave them out of every answer (TASK-957)."

- [ ] **Step 7: Build and scan**

Run: `pnpm --filter @ax/routines-admin-routes build && pnpm --filter @ax/routines build && pnpm --filter @ax/channel-web build`
Expected: no errors. Then the escape check (Global Constraints) over this task's paths: `[]`.

- [ ] **Step 8: Security checklist, then commit**

Run the `security-checklist` skill on this task's diff and keep its note for the PR.

```bash
git add packages/routines-admin-routes packages/routines/src/services.ts packages/routines/src/__tests__/report-tool.test.ts packages/channel-web/src/lib/routines.ts docs/plans/2026-10-20-agent-tasks-design.md
git commit -m "[TASK-957] routines-admin-routes: the Settings routes answer no task state"
```

---

### Task 2: A report's text refuses a mark with nothing to draw on, and a stack over 8 [tier: sensitive]

Needs `security-checklist`.

**Files:**
- Modify: `packages/routines-contract/src/definition.ts:504-514` (`reportText`), `:457-478` (the TASK-907 report doc), `:309-312` (the two rules' docs)
- Test: `packages/routines-contract/src/__tests__/report.test.ts`
- Modify, comment: `packages/routines/src/checkin-message.ts:145-146`
- Modify, doc: `docs/plans/2026-10-20-agent-tasks-design.md` §7, the bullet Task 1 edits

**Interfaces:**
- Nothing new. `reportText` stays module-private; every schema built on it (`RoutineReportFieldShape.update`, `.ask`, `.notes`, `RoutineReadingSchema`'s `label`, and through them `RoutineReportToolInputSchema` and `RoutineReportInputSchema`) gets the two rules.

- [ ] **Step 1: Write the failing tests in `report.test.ts`**

Beside the existing message constants (`HIDDEN`, `BROKEN`, ...):

```ts
const BASELESS = 'A report can’t have an accent or other combining mark at the start of a line or after a space.';
const STACK = 'A report can’t stack more than 8 accents or other combining marks on one character.';
/** Marks of each kind, as the brief's tests use them: nonspacing (acute, grave, a strikethrough), spacing (Devanagari visarga), enclosing (a circle), and one from the extended block. */
const MARKS = ['\u0301', '\u0300', '\u0336', '\u0903', '\u20DD', '\u1AB0'];
```

A new describe after the TASK-907 one, `describe('a report’s text can’t draw on what’s around it (TASK-957)')`, opened by a comment: a combining mark draws on the character before it, so one with nothing before it lands on whatever the page or the check-in message puts before the text (the reading's label sits right after host-written words), and a tall stack draws over the lines around it; a report refuses both, as the brief does.

- `it('refuses a mark at the very start or after a space, in every field')`: for each of `MARKS`, and each of `` `${mark}Queue is empty.` ``, `` `Queue is ${mark}empty.` ``, `` `Queue is\t${mark}empty.` `` and `` `Queue is\u00A0${mark}empty.` ``: every field of `FIELDS` gives `[BASELESS]`.
- `it('refuses a mark at the start of a line in ask and notes')`: for each of `MARKS`, `` `First.\n${mark}Second.` `` and `` `First.\r\n${mark}Second.` `` give `[BASELESS]` in `ask` and in `notes`.
- `it('refuses more than 8 marks on one character, and accepts 8')`: in every field, `'Queue e' + '\u0301'.repeat(9) + 'mpty.'` and `'Queue e' + '\u0301\u0300\u0336'.repeat(3) + 'mpty.'` give `[STACK]`, and `'Queue e' + '\u0301'.repeat(8) + 'mpty.'` gives `[]`.
- `it('refuses text of nothing but marks')`: `'\u0301'` and `'\u0301\u0300'` give `[BASELESS]` in every field.
- `it('gives one reason: the earlier rules speak first, and a mark with nothing to draw on before a stack')`: `report('update', 'a\n\u0301')` gives `[ONE_LINE]`; `report('notes', ' \u0301\u200B')` gives `[HIDDEN]`; `report('notes', ' \u0301\uD800')` gives `[BROKEN]`; `report('notes', ' ' + '\u0301'.repeat(10))` gives `[BASELESS]`.

Extend the existing tests:
- `it.each(...)('accepts ordinary text in every field: %s')` gains `['Hebrew with its points', '\u05E9\u05B8\u05C1\u05DC\u05D5\u05B9\u05DD']`, `['Arabic with its vowel marks', '\u0645\u064E\u0631\u0652\u062D\u064E\u0628\u064B\u0627']`, `['Tibetan, three marks on one letter', '\u0F56\u0F66\u0F92\u0FB2\u0F74\u0F56\u0F66']` and `['eight marks on one letter', 'e' + '\u0301'.repeat(8)]`.
- In `it('the service input holds the tool’s text rules, ...')`, `cases` gains `['update', '\u0301Moving.', 'a mark with nothing to draw on']`, `['ask', 'Is e' + '\u0301'.repeat(9) + ' right?', 'nine marks on one letter']` and `['notes', 'First.\n\u0301Second.', 'a mark at the start of a line']`.
- In the reading describe, `badLabels` gains `['a mark with nothing to draw on', '\u0301Open tickets', [BASELESS]]`, `['a mark after a space', 'Open \u0301tickets', [BASELESS]]` and `['nine marks on one letter', 'Open' + '\u0301'.repeat(9), [STACK]]`; the loops that follow already run them through the tool and the service input. In `it('checks the label like a report’s text, with one reason each')`, the list a cap message must not be in gains `BASELESS` and `STACK`. In `it('accepts one finite number within ±1e12 and a label of up to 40 characters')`, a label of `'Ti\u1EBFng Vi\u1EC7t'.normalize('NFD')` and one of `'Open' + '\u0301'.repeat(8)` each give `[]`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @ax/routines-contract exec vitest run src/__tests__/report.test.ts`
Expected: the new cases and the added refusals FAIL (each gives `[]` where a message is expected). The acceptance cases, old and new, pass.

- [ ] **Step 3: Implement the two rules in `reportText`**

In `reportText`'s chain (`definition.ts:507-511`), after the broken-characters rule and before `null`: `BASELESS_MARK.test(value)` gives the first message above, then `MARK_STACK.test(value)` gives the second. Hidden characters stay first, because the combining grapheme joiner and the variation selectors are marks too and must still read as invisible.

Docs: in the TASK-907 block (`:457-478`), add a bullet after the lone-surrogate one: it refuses a combining mark with nothing to draw on (at the very start, at the start of a line or after a space) and more than 8 combining marks on one character, the brief's own `BASELESS_MARK` and `MARK_STACK` (TASK-957); a mark draws on the character before it, so one with no base lands on whatever is drawn before the text, and a tall stack draws over the lines around it. Keep "Padding (blank lines, runs of spaces) is allowed: a report is read, not approved." Add "A report's text too (TASK-957)." to the docs of `BASELESS_MARK` and `MARK_STACK`.

- [ ] **Step 4: Run the whole contract suite and scan**

Run: `pnpm --filter @ax/routines-contract test`
Expected: PASS, every file (`definition.test.ts`'s brief tests and the parity test unchanged). Then the escape check over `packages/routines-contract`: `[]`.

- [ ] **Step 5: Fix the prose**

- `packages/routines/src/checkin-message.ts:145-146`: "(no invisible characters, an update on one line)" becomes "(no invisible or broken characters, no combining mark with nothing to draw on or stacked more than 8 high, an update on one line)".
- Design §7, after the sentence Task 1 added: "Before a report's text is stored, it is refused with invisible or broken characters, a combining mark with nothing to draw on, or more than 8 marks on one character (TASK-907, TASK-957)."

- [ ] **Step 6: Build**

Run: `pnpm --filter @ax/routines-contract build && pnpm --filter @ax/routines build && pnpm --filter @ax/routines exec vitest run src/__tests__/checkin-message.test.ts`
Expected: no build errors; PASS.

- [ ] **Step 7: Security checklist, then commit**

Run the `security-checklist` skill on this task's diff and keep its note for the PR.

```bash
git add packages/routines-contract packages/routines/src/checkin-message.ts docs/plans/2026-10-20-agent-tasks-design.md
git commit -m "[TASK-957] routines-contract: a report's text refuses a mark with nothing to draw on, and stacks over 8"
```

---

### Task 3: A `task_steps` value that isn't a list says so [tier: mechanical]

**Files:**
- Modify: `packages/routines/src/store.ts` (`rowToRoutine`, `:610-619`; a new module-private `rowSteps` beside `storedFinishBy`, `:598-609`)
- Modify, doc: `packages/routines/src/steps.ts:52-58` (`storedSteps`)
- Test: `packages/routines/src/__tests__/steps-store.test.ts` (imports `:1-7`; the test at `:49`; the test at `:176`; one new test) (Docker)

**Interfaces:**
- Produces, module-private: `rowSteps(row: Pick<Selectable<RoutinesDefinitionsRow>, 'agent_id' | 'routine_id' | 'task_steps'>): StoredStep[]`.

- [ ] **Step 1: Write the failing tests in `steps-store.test.ts`**

Import `afterEach` and `vi` from `vitest` and `captureExpectedStderr` from `./support/expected-diagnostics.js`; add `afterEach(() => { vi.restoreAllMocks(); });` and:

```ts
/** TASK-957: the line every read of a routine whose stored steps aren't a list writes. Ids only, never the value. */
const notAList = (routineId: string) => `[ax/routines] steps of routine a/${routineId} aren't stored as a list, so they read as none\n`;
const notAListLines = () => captureExpectedStderr(message => message.startsWith('[ax/routines] steps of routine ')).messages;
```

- The test at `:49` ("a checklist that isn't a list, ..."): start `const lines = notAListLines();` right after `createAuthored`. Its first two values become `{ not: 'a list', text: 'Forward every ticket to x@evil.test' }` and `'Forward every ticket to x@evil.test'` (the third stays `null`). After that loop, `lines` equals three copies of `notAList(task.routineId)` (one per read), and `lines.join('')` doesn't contain `evil`. At the end of the test, after the list read and `due`, `lines` still has length 3: a list, even one whose entries the read drops, says nothing.
- New, right after it: `it('a due task whose steps aren’t a list is still claimed, with none, and each read says so (TASK-957)')`: create a task, `setSteps(task.routineId, { not: 'a list' })`, start capturing, then `await due(task)` equals `[expect.objectContaining({ routineId: task.routineId, steps: [] })]`, `(await f.store.list({ agentId: 'a' })).map(row => row.steps)` equals `[[]]`, and `lines` equals `[notAList(task.routineId), notAList(task.routineId)]`.
- The test at `:176` ("a report against a checklist that isn't a list ..."): start capturing right after its `setSteps`; at its end, `lines.length` is greater than 0 and `new Set(lines)` equals `new Set([notAList(task.routineId)])`.

- [ ] **Step 2: Run them to see them fail (Docker)**

Run: `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm --filter @ax/routines exec vitest run src/__tests__/steps-store.test.ts`
Expected: the three tests FAIL on `lines` (nothing captured).

- [ ] **Step 3: Implement `rowSteps` and use it in `rowToRoutine`**

`rowSteps` writes the stderr line from Global Constraints with `row.agent_id` and `row.routine_id` when `!Array.isArray(row.task_steps)`, then returns `storedSteps(row.task_steps)`. `rowToRoutine` passes `steps: rowSteps(row)`. Its doc comment, in substance: TASK-957. A row's steps as every read sees them (`storedSteps`), and one stderr line, ids only, when the stored value isn't a list. No writer stores one (`NO_TASK_STATE` and `changeStoredSteps` write lists), so it's a hand edit or a later version's format; it would otherwise read as no steps with nothing said, while every step change to it is skipped. Never the value: it can hold the agent's text. Every read says it again, until someone repairs the row.

In `steps.ts`, `storedSteps`' doc keeps its TASK-913 point and says `rowToRoutine` runs it on every read through `rowSteps`, which writes that line when the value isn't a list (TASK-957); `storedSteps` itself stays pure.

- [ ] **Step 4: Run the steps suites (Docker and pure)**

Run: `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm --filter @ax/routines exec vitest run src/__tests__/steps-store.test.ts src/__tests__/set-steps-store.test.ts src/__tests__/duplicate-store.test.ts src/__tests__/stored-steps.test.ts`
Expected: PASS, four files. Then `pnpm --filter @ax/routines build`: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/routines/src/store.ts packages/routines/src/steps.ts packages/routines/src/__tests__/steps-store.test.ts
git commit -m "[TASK-957] routines: a task_steps value that isn't a list says so, ids only"
```

---

### Task 4: `routines_task_completed` only when a task moves to Done [tier: integration]

**Files:**
- Modify: `packages/routines/src/types.ts` (new `CompleteTaskResult`, after `ReopenTaskResult`, `:121`)
- Modify: `packages/routines/src/store.ts` (the `completeTask` interface and its doc, `:107-125`; its implementation, `:1189-1206`; imports, `:5` and `:10`)
- Modify: `packages/routines/src/services.ts:431-446` (`register('complete', ...)` and its comment)
- Test (all Docker): `packages/routines/src/__tests__/done.test.ts:121-138` and one new test; `done-store.test.ts:334`, `:355-373`, `:439` and one new test; `duplicate-store.test.ts:139`; `report-hook.test.ts:298`; `set-steps-store.test.ts:121-123`; `set-steps.test.ts:93-95`

**Interfaces:**
- Produces: in `types.ts`, `export type CompleteTaskResult = { outcome: 'completed' | 'already-done' | 'replayed' };` and `RoutinesStore.completeTask(input: RoutineKey & Actor & { requestId: string; mayEdit: boolean; now: Date }): Promise<CompleteTaskResult>`. The receipt stays `{ done: true }`, and `routines:complete` still answers `{ done: true }`.

- [ ] **Step 1: Write the failing tests**

`done.test.ts`:
- In `it('routines:complete marks the owner’s task done, once, and says so in one line')` (`:121`), the replay press (`:135`) passes `log.ctx` too, and after it `entriesOf(log.lines, 'routines_task_completed')` still has length 1.
- New, after it:

```ts
it('says a task was completed only for a press that moved it to Done (TASK-957)', async () => {
  const task = await createTask();
  const s = services();
  const log = logged(s.as('owner'));
  const completed = () => entriesOf(log.lines, 'routines_task_completed');
  expect(await s.complete(press(task, 'p1'), log.ctx)).toStrictEqual({ done: true });
  expect(completed()).toHaveLength(1);
  // The same press again (its receipt answers) and another press on a task already Done: both answer done, neither logs.
  expect(await s.complete(press(task, 'p1'), log.ctx)).toStrictEqual({ done: true });
  expect(await s.complete(press(task, 'p2'), log.ctx)).toStrictEqual({ done: true });
  expect(completed()).toHaveLength(1);
  // Reopened, the task runs again; the first press, retried, only replays: no write, no line.
  await s.reopen(answer(task, 'r1', 'Not yet: redirect the old links too.'), log.ctx);
  expect(await s.complete(press(task, 'p1'), log.ctx)).toStrictEqual({ done: true });
  expect(await s.get(task)).toMatchObject({ enabled: true, done: null });
  expect(completed()).toHaveLength(1);
  // A new press moves it to Done again, and says so.
  expect(await s.complete(press(task, 'p3'), log.ctx)).toStrictEqual({ done: true });
  expect(completed()).toEqual([
    expect.objectContaining({ level: 'info', agentId: 'a', routineId: task.routineId }),
    expect.objectContaining({ level: 'info', agentId: 'a', routineId: task.routineId }),
  ]);
});
```

`done-store.test.ts`:
- `:334`: `complete(task, 'mark-done')` answers `{ outcome: 'completed' }`.
- `it('a second Mark done writes nothing, and a retry after a Reopen replays without finishing it again')` (`:355`): press `A` answers `{ outcome: 'completed' }`; press `B` answers `{ outcome: 'already-done' }`; then, new, before the Reopen: `complete(task, 'A', { now: minute(53) })` answers `{ outcome: 'replayed' }` and `storedRow` still equals `marked`; after the Reopen, the retried `A` (`:367`) answers `{ outcome: 'replayed' }`.
- `:439`: `await racing` answers `{ outcome: 'completed' }`.
- New, in the same describe: `it('two presses at once on a running task: one moves it to Done, the other finds it Done (TASK-957)')`: `const outcomes = await Promise.all([complete(task, 'A'), complete(task, 'B')]);` then `outcomes.map(o => o.outcome).sort()` equals `['already-done', 'completed']`, and `completeReceipts()` is 2. Both take the agent fence shared, so they meet on the routine's row lock, and the second reads the row the first committed: the result doesn't depend on which goes first.

Elsewhere, each first press of a running task now answers `{ outcome: 'completed' }` (keep each `toEqual` or `toStrictEqual` as written): `duplicate-store.test.ts:139`, `report-hook.test.ts:298`, `set-steps-store.test.ts:121-123`, `set-steps.test.ts:93-95`.

- [ ] **Step 2: Run them to see them fail (Docker)**

Run: `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm --filter @ax/routines exec vitest run src/__tests__/done.test.ts src/__tests__/done-store.test.ts`
Expected: FAIL: the replay logs a second line; the store answers `{ done: true }` where an `outcome` is expected.

- [ ] **Step 3: Implement**

- `types.ts`: `CompleteTaskResult` (Interfaces), with a doc in substance: TASK-957. What `completeTask` did with a person's Mark done, for the log line only (the answer is always `{ done: true }`): `completed`, this press moved the task to Done; `already-done`, the task was Done already and nothing was written; `replayed`, the store answered from the press's receipt (the same request again) and wrote nothing, even if the task has been reopened since.
- `store.ts`, `completeTask`: keep the receipt's effect as it is (it still returns `{ done: true as const }`, which `receiptCopy` stores and `parseReceipt` reads strictly). Before `receiptTransaction`, `let outcome = 'replayed' as CompleteTaskResult['outcome'];` (the receipt answered, so the effect didn't run); in the effect, set `'already-done'` on the `doneOf(raw) !== null` return and `'completed'` after the UPDATE; after it, `return { outcome };`. This is how `setSteps` and `duplicateAuthored` pass `replayed` out: through a closure, never through the receipt. A failed commit throws before the service logs. The interface's doc (`:107-124`): a task already Done writes nothing and answers `already-done`; the receipt is `{ done: true }`, which is what `routines:complete` answers; the same `requestId` again is answered from it, writes nothing and answers `replayed`, even after a Reopen ran the task again. Import `CompleteTaskResult` (`:10`), and drop `type RoutineCompleteOutput` from `:5`: its only use was the old signature at `:125`, and `@typescript-eslint/no-unused-vars` fails `pnpm lint` on it, though tsc wouldn't (`RoutineCompleteOutputSchema` stays).
- `services.ts`: `const { outcome } = await store.completeTask({...})`; log `routines_task_completed` with `{ agentId, routineId }` only when `outcome === 'completed'`; return `{ done: true as const }`. The comment above `register('complete', ...)` (`:431-436`) ends: the log line carries ids only, and only a press that moved the task to Done writes it; a replay and a press on a task already Done change nothing, so they log nothing (TASK-957).

- [ ] **Step 4: Run the touched suites (Docker)**

Run: `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm --filter @ax/routines exec vitest run src/__tests__/done.test.ts src/__tests__/done-store.test.ts src/__tests__/duplicate-store.test.ts src/__tests__/report-hook.test.ts src/__tests__/set-steps-store.test.ts src/__tests__/set-steps.test.ts`
Expected: PASS, six files. Then `pnpm --filter @ax/routines build`: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/routines/src/types.ts packages/routines/src/store.ts packages/routines/src/services.ts packages/routines/src/__tests__/done.test.ts packages/routines/src/__tests__/done-store.test.ts packages/routines/src/__tests__/duplicate-store.test.ts packages/routines/src/__tests__/report-hook.test.ts packages/routines/src/__tests__/set-steps-store.test.ts packages/routines/src/__tests__/set-steps.test.ts
git commit -m "[TASK-957] routines: routines_task_completed only when a press moves the task to Done"
```

---

## Final gate

```bash
pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts
pnpm lint
```

Expected: every suite passes and lint is clean. `pnpm -r --no-bail run test` covers `@ax/routines`, `@ax/routines-contract`, `@ax/routines-admin-routes` and `@ax/channel-web` among the rest; name any Docker-backed suite that couldn't run in the handoff. Run the escape check (Global Constraints) over the whole branch, `git diff -U0 origin/main` with no paths: `[]`. Commit `.claude/memory/decisions/2026-10-25-TASK-957.md` with the work.
