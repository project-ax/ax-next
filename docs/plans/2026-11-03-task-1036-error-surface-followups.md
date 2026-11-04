# TASK-1036 Error-surface follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four TASK-1031 (#1116) leftovers. (1) The webhook and timer-drain fault logs use `@ax/core` `faultLogFields`. (2) A one-off scrub, approved by a human, rewrites old internal error text in run history and routines' last error. (3) Connectors' capabilities 400 is a fixed field-level message. (4) `fire.ts` reads the `agents:resolve` error through a guard.

**Architecture:** Items 1, 3 and 4 are small in-package edits, each with a test that fails first. Item 2 ships as a psql script owned by `@ax/routines` (`packages/routines/sql/`). A dry run is the default; `-v apply=1` writes in one transaction. A testcontainers test runs the same file through the container's own `psql`. A `deploy/GKE.md` §4g runbook runs it from a throwaway pod after a Cloud SQL backup. Nothing in this PR touches a cluster.

**Tech Stack:** TypeScript, vitest, kysely/pg, `@testcontainers/postgresql` 11.14.0 (`copyContentToContainer`, `exec`), zod v3 (connectors), psql (PG 16 in tests, 17 in the pod).

**Spec:** card TASK-1036 (board). Planner decisions and evidence: `.claude/memory/decisions/2026-11-03-TASK-1036.md`. Read its first two rows before Task 3 or Task 4.

## Global Constraints

- **No cluster, no prod.** The default kubectl context is GKE PROD. Run no `kubectl` or `gcloud` command while building. Test the scrub only against the testcontainers Postgres.
- Docker-backed tests need an explicit `DOCKER_HOST` (CLAUDE.md "Docker-backed tests").
- `pnpm --filter <pkg>` goes **before** the script. For one test file use `pnpm --filter <pkg> exec vitest run <path>`, not `test -- <path>`.
- Never log or store an error's message on any path touched here. Logs carry `faultLogFields(err)` only.
- Stay out of TASK-1035's areas: mcp-oauth `requireUser`, `RoutineEditor`/`use-routine-draft`, the TaskForm kind-switch Alert, and `plugin.ts:391` (`repeat_heartbeat_failed`).
- Don't touch the legacy `webhook.hmac` parse path in `packages/routines/src/definition.ts` (TASK-1027: hashes depend on it byte for byte).
- Memory goes only into the shard `.claude/memory/decisions/2026-11-03-TASK-1036.md`, never into a root archive, and no memory line is deleted.
- Shell in `deploy/*.md` must not assign or reference zsh-tied names (`path`, `status=`, …); `scripts/__tests__/docs-zsh-tied-variables.test.js` enforces this.
- Exact strings in this plan (log fields, messages, SQL, output labels) are the spec. Copy them; don't reword them.

## Review Focus

- **psql run without `-v apply`, or with `-v apply=0`** must be a dry run that changes nothing. Task 4, test 1 (both forms).
- **A client that isn't UTF-8 (`PGCLIENTENCODING=LATIN1`)** must still keep the curly-quoted sentences (`’ “ ” …`) instead of rewriting them. Task 4, test 3.
- **Old text that is empty, a bare `Error: …` value, or on a webhook-sourced row** is rewritten, not skipped. Task 4 seeds all three.
- **A caller-chosen `services[].env` key** in a refused capabilities value is never echoed. Task 2, PATCH test.
- **An `agents:resolve` error whose code is `not-found` but whose `hookName` can't be read** is recorded as a failed run and never purges the agent. Task 3, the `hookName` case.

## Files

| File | Task | Responsibility |
|---|---|---|
| `packages/routines/src/webhook-handler.ts` | 1 | Fault logs via `faultLogFields`; delete `faultCode` |
| `packages/routines/src/plugin.ts` (`:1`, `:24`, `:393` only) | 1 | Timer drain log via `faultLogFields` |
| `packages/routines/src/__tests__/webhook-admission.test.ts`, `repeat-plugin-start.test.ts` | 1 | Pin the new log fields |
| `packages/connectors/src/store.ts` (`checkCapabilities`) | 2 | Fixed field-level message |
| `packages/connectors/src/admin-routes.ts:757-759` | 2 | Comment that said `too_big` |
| `packages/connectors/src/__tests__/admin-routes.test.ts`, `store.test.ts` | 2 | Pin the messages |
| `packages/routines/src/fire.ts` | 3 | `isAgentGone`; comment at the `terminated:` writer |
| `packages/routines/src/__tests__/fire.test.ts` | 3 | Getter-throw cases |
| `packages/routines/sql/scrub-leaked-run-errors.sql` (new) | 4 | The scrub |
| `packages/routines/src/__tests__/scrub-leaked-run-errors.test.ts` (new) | 4 | Runs the scrub through psql |
| `deploy/GKE.md` (new §4g) | 5 | Runbook |
| `scripts/__tests__/run-error-scrub-runbook.test.js` (new) | 5 | The runbook quotes the script |

Tasks 1–4 are independent (disjoint files). Task 5 needs Task 4's file and output labels.

---

### Task 1: Webhook and timer-drain fault logs use `faultLogFields` [tier: mechanical]

**Files:**
- Modify: `packages/routines/src/webhook-handler.ts:5` (import), `:8` (import), `:20-26` (delete `faultCode` and its doc), `:71-78` (`logFault`), `:187-189` (drain log)
- Modify: `packages/routines/src/plugin.ts:1`, `:24`, `:393`
- Test: `packages/routines/src/__tests__/webhook-admission.test.ts:2`, `:146-224`; `packages/routines/src/__tests__/repeat-plugin-start.test.ts:49`

**Interfaces:**
- Consumes: `faultLogFields(err: unknown): FaultLogFields` from `@ax/core` (`packages/core/src/fault-code.ts:54`). It returns any of `code`, `causeCode`, `name`, `causeName`, `hookName`, `plugin`, each identifier-shaped. It never throws.
- Produces: nothing new. The `faultCode` export is removed.

- [ ] **Step 1: Update and extend the log tests**

In `webhook-admission.test.ts`, import `SafeToolError` from `@ax/core` and add these helpers inside the `a 503 logs its code, never its message (TASK-1027)` describe:

```ts
const pluginFault = { name: 'PluginError', plugin: '@ax/routines' };
const safeTool = () => new SafeToolError('unavailable', 'input');
const safeToolFields = { code: 'unavailable', name: 'PluginError', plugin: '@ax/core' };
/** What the bus throws when a service fails: `unknown`, with the real failure as its cause. */
const busWrap = () => new PluginError({ plugin: '@ax/blob-fs', hookName: 'blob:put', code: 'unknown', message: 'PRIVATE wrap',
  cause: Object.assign(new Error('PRIVATE cause'), { code: 'ENOSPC' }) });
const busWrapFields = { code: 'unknown', causeCode: 'ENOSPC', name: 'PluginError', causeName: 'Error', hookName: 'blob:put', plugin: '@ax/blob-fs' };
```

The third column of the observe-failure `it.each` (`:158-171`) becomes the expected field object, and the assertion spreads it: `toStrictEqual([{msg:'routines_webhook_observe_failed',level:'warn',agentId:'a',routineId:'r',observation:'signature',...fields}])`. Rows:

| name | error | fields |
|---|---|---|
| `a plugin error` | `failure('timeout','PRIVATE observe detail')` | `{code:'timeout',...pluginFault}` |
| `a database error` | `Object.assign(new Error('PRIVATE row detail'),{code:'40P01'})` | `{code:'40P01',name:'Error'}` |
| `an error with no code` | `new Error('PRIVATE detail')` | `{name:'Error'}` |
| `a SafeToolError` (new) | `safeTool()` | `safeToolFields` |

- Too-large test (`:180`): `code:'timeout'` → `code:'timeout',...pluginFault`.
- Slack verified test (`:190`): `code:'unknown'` → `code:'unknown',...pluginFault`.
- Admission test (`:192-200`): its input becomes `busWrap()`, and the expected entry becomes `{msg:'routines_webhook_admission_failed',level:'warn',agentId:'a',routineId:'r',...busWrapFields}`. Keep its `observeWebhook` assertion.
- Drain table (`:211-215`): third column becomes `{code:'timeout',...pluginFault}`, `{code:'40P01',name:'Error'}` and `{name:'Error'}`. Add the row `['a SafeToolError', safeTool(), safeToolFields]`. The assertion stays `toStrictEqual([{msg:'repeat_queue_drain_failed',level:'warn',agentId:'a',routineId:'r',...fields}])`.
- `repeat-plugin-start.test.ts:49`: expect `[{msg:'repeat_queue_drain_failed',level:'warn',code:'timeout',name:'PluginError',plugin:'@ax/routines'}]`.

Every existing `expect(logged()).not.toContain('PRIVATE')` stays.

- [ ] **Step 2: Run, and see them fail**

Run: `pnpm --filter @ax/routines exec vitest run src/__tests__/webhook-admission.test.ts src/__tests__/repeat-plugin-start.test.ts`
Expected: FAIL. The SafeToolError rows log `code:'invalid-payload'`, the bus-wrap admission case lacks `causeCode`/`hookName`, and the updated rows lack `name`/`plugin`.

- [ ] **Step 3: Implement**

- `webhook-handler.ts`:
  - Add `faultLogFields` to the `@ax/core` import (`:5`). `:8` becomes `import type { RoutinesStore } from './store.js';`, because `sqlState` is no longer used here; leave its export in `store.ts`. Delete `faultCode` and its doc comment (`:20-26`).
  - `logFault` logs `{ agentId: row.agentId, routineId: row.routineId, ...(observation === undefined ? {} : { observation }), ...faultLogFields(error) }`. Its comment (`:71`) says it logs the failure's `faultLogFields` (codes, class names and the failing hook), never the error's message, a header, the body or the secret.
  - The drain catch (`:187-189`) logs `repeat_queue_drain_failed` with `{ agentId: row.agentId, routineId: row.routineId, ...faultLogFields(error) }`.
  - Leave `unreadable` and the whole secret-fetch block (`:91-116`) unchanged (decisions row "Item 1: `unreadable`").
- `plugin.ts`:
  - `:1` becomes `import { answerBlobCollectRefs, faultLogFields } from '@ax/core';`.
  - `:24` becomes `import { createWebhookRouter } from './webhook-handler.js';`.
  - `:393`'s catch becomes `.catch((error:unknown)=>initCtx.logger.warn('repeat_queue_drain_failed',faultLogFields(error)))`.
  - Do not edit `:391`.

- [ ] **Step 4: Run, and see them pass; typecheck**

Run: the Step 2 command → PASS. Then `pnpm --filter @ax/routines build` → no errors. `grep -rn "faultCode" packages/routines/src` → no output.

- [ ] **Step 5: Commit**

```bash
git add packages/routines/src/webhook-handler.ts packages/routines/src/plugin.ts packages/routines/src/__tests__/webhook-admission.test.ts packages/routines/src/__tests__/repeat-plugin-start.test.ts
git commit -m "[TASK-1036] routines: webhook and timer-drain fault logs use faultLogFields; local faultCode removed"
```

---

### Task 2: Connectors answer an invalid `capabilities` value with a fixed field-level message [tier: mechanical]

**Files:**
- Modify: `packages/connectors/src/store.ts:3` (`import type { ZodError, ZodType } from 'zod';`), `:156-170` (`checkCapabilities`), plus a private helper beside it
- Modify: `packages/connectors/src/admin-routes.ts:757-759` (comment)
- Test: `packages/connectors/src/__tests__/admin-routes.test.ts` (new describe at the end; `:2220`); `packages/connectors/src/__tests__/store.test.ts:371-372`, `:397-398`

**Interfaces:**
- Produces: a module-private `capabilitiesIssueMessage(error: ZodError): string` in `store.ts`. `checkCapabilities` throws `invalid(capabilitiesIssueMessage(parsed.error))`. Every other `invalid(...)` message in the file is unchanged.

Rules (exact):
- Read only `error.issues[0]`.
- `field` = `issue.path[0]` if it is a string in `new Set(['allowedHosts', 'credentials', 'mcpServers', 'packages', 'services'])`. Otherwise there is no field.
- No field → `capabilities must be a valid Capabilities object`.
- `issue.code === 'too_big' && issue.type === 'array' && issue.path.length === 1` → `` `capabilities.${field} can have at most ${issue.maximum} entries` ``.
- Otherwise → `` `capabilities.${field} is not valid` ``.
- Never render another path segment or any zod text. `services[].env` keys are caller-chosen path segments.

- [ ] **Step 1: Write the failing tests**

Append to `admin-routes.test.ts`:

```ts
// TASK-1036: an invalid capabilities value gets a fixed message naming its field, never zod's issue JSON.
describe('an invalid capabilities value is a fixed field-level 400 (TASK-1036)', () => {
  it.each([
    ['a malformed server', () => ({ ...mcpCaps(), mcpServers: [{ ...mcpCaps().mcpServers[0]!, url: 5 }] }), 'capabilities.mcpServers is not valid'],
    ['a value that is not an object', () => 5, 'capabilities must be a valid Capabilities object'],
  ] as const)('POST answers %s with a fixed message', async (_name, capabilities, error) => {
    const h = await makeHarness();
    currentActor = { id: 'userA', isAdmin: true };
    const handlers = createAdminConnectorRouteHandlers({ bus: h.bus });
    const { res, captured } = makeRes();
    await handlers.create(makeReq({ body: { connectorId: 'bad-caps', name: 'Bad', keyMode: 'personal', capabilities: capabilities() } }), res);
    expect(captured.status).toBe(400);
    expect(captured.body).toEqual({ error });
  });
  it('PATCH never echoes a caller-chosen services env key', async () => {
    // Create 'svc' as userA with mcpCaps() (POST → 201), then PATCH it as userA with:
    const service = { name: 'db', image: `postgres@sha256:${'a'.repeat(64)}`, ports: [5432], env: { CALLER_CHOSEN_KEY: 'x'.repeat(2049) } };
    // body: { capabilities: { ...mcpCaps(), services: [service] } }
    expect(captured.status).toBe(400);
    expect(captured.body).toEqual({ error: 'capabilities.services is not valid' });
    expect(JSON.stringify(captured.body)).not.toContain('CALLER_CHOSEN_KEY');
  });
});
```

Update existing assertions:
- `admin-routes.test.ts:2220` → `expect(sCap.body).toEqual({ error: `capabilities.allowedHosts can have at most ${limit} entries` });`.
- `store.test.ts:398` → `expect((err as PluginError).message).toBe('capabilities.allowedHosts is not valid');`.
- `store.test.ts:372`'s "(zod text here)" becomes "(a fixed field-level message, TASK-1036)", and `:397` says the field-level message stays on the error (for the log).

- [ ] **Step 2: Run, and see them fail**

Run: `pnpm --filter @ax/connectors exec vitest run src/__tests__/admin-routes.test.ts src/__tests__/store.test.ts`
Expected: FAIL. Every new or updated assertion gets `capabilities must be a valid Capabilities object: [...zod JSON...]`.

- [ ] **Step 3: Implement `capabilitiesIssueMessage` and use it in `checkCapabilities`**

Its doc comment says three things: why zod text is never used (caller-chosen `env` keys in paths, echoed as the 400's `error`); that the read path (`fromStoredRow` → `corrupt-row`, skip logs) carries the same message; and that the limit sentence is what TASK-945's trim-to-save refusal relies on. Narrow the issue with `issue.code === 'too_big'` (zod v3 `ZodTooBigIssue` has `type` and `maximum`).

Update `admin-routes.ts:757-759`: "…gets a 400 naming that list and its limit here until its owner trims it."

- [ ] **Step 4: Run, and see them pass; typecheck**

Run: `pnpm --filter @ax/connectors exec vitest run src/__tests__/admin-routes.test.ts src/__tests__/store.test.ts src/__tests__/capability-limits.test.ts src/__tests__/admin-routes-corrupt-row.test.ts` → PASS. Then `pnpm --filter @ax/connectors build` → no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/connectors/src/store.ts packages/connectors/src/admin-routes.ts packages/connectors/src/__tests__/admin-routes.test.ts packages/connectors/src/__tests__/store.test.ts
git commit -m "[TASK-1036] connectors: an invalid capabilities value is a fixed field-level message, never zod JSON"
```

---

### Task 3: `fire.ts` reads the `agents:resolve` error through a guard [tier: sensitive]

Needs `security-checklist` (PR-level note). This code reads another plugin's error object, which is untrusted (invariant 5), before deciding a destructive `purgeAgent`.

**Files:**
- Modify: `packages/routines/src/fire.ts:192-199` (add `isAgentGone` right after `isRunClosed`), `:257-259` (the catch), `:446-447` (comment)
- Test: `packages/routines/src/__tests__/fire.test.ts`, in `describe('accepted DB fire dispatch')`, right after `purges only exact agents:resolve not-found…` (`:204-212`)

**Interfaces:**
- Produces: a module-private `isAgentGone(err: unknown): boolean`. It returns `err instanceof PluginError && err.code === 'not-found' && err.hookName === 'agents:resolve'`, with the same try/catch shape as `isRunClosed`, and `false` if anything throws. An error that can't be read is never a reason to purge. The catch becomes `} catch (err) { return fail(err, isAgentGone(err)); }`.

- [ ] **Step 1: Write the failing test**

```ts
// TASK-1036: an error's getters are arbitrary. Reading them must not cost the run its row,
// and an error that can't be read is never "the agent is gone".
it.each([
  ['code', RUN_FAILED],
  ['hookName', 'This run failed because of a problem on our side (code: not-found).'],
] as const)('records the run, and purges nothing, when the agents:resolve error throws reading %s', async (key, stored) => {
  const resolveError = new PluginError({ code: 'not-found', plugin: 'agents', hookName: 'agents:resolve', message: 'gone' });
  Object.defineProperty(resolveError, key, { get() { throw new Error('getter'); } });
  const h = await setup({ resolveError });
  await stdoutOf(async () => {
    const result = await h.fire(h.accepted);
    expect(result).toMatchObject({ status: 'error' });
    expect(result).not.toHaveProperty('agentGone');
  });
  expect(h.invoked).not.toHaveBeenCalled();
  expect(await f.store.findOne(h.row)).not.toBeNull();
  expect((await f.store.recentFires(h.row))[0]).toMatchObject({ status: 'error', error: stored });
});
```

- [ ] **Step 2: Run, and see it fail**

Run: `pnpm --filter @ax/routines exec vitest run src/__tests__/fire.test.ts -t "throws reading"`
Expected: FAIL in both cases. `h.fire` rejects with `getter`: the catch's own read of `code`/`hookName` throws.

- [ ] **Step 3: Implement `isAgentGone` and use it at `:258`**

Above `const reason = String(outcome.reason ?? 'unknown');` (`:447`) add exactly:

```ts
          // Not always an orchestrator code: a runner that fails reports its own
          // error as `${name}: ${message}` (agent-runner-core run-runner.ts), so a
          // run can store runner text here. What owners should see instead is a
          // separate card (TASK-1036 decisions).
```

- [ ] **Step 4: Run, and see it pass**

Run: `pnpm --filter @ax/routines exec vitest run src/__tests__/fire.test.ts` → PASS, including the existing `purges only exact agents:resolve not-found` and `records %s from another provider without purging` tests.

- [ ] **Step 5: Commit**

```bash
git add packages/routines/src/fire.ts packages/routines/src/__tests__/fire.test.ts
git commit -m "[TASK-1036] routines: fire reads the agents:resolve error through a guard; an unreadable error never purges"
```

---

### Task 4: The one-off scrub script and its psql test [tier: sensitive]

Needs `security-checklist` (PR-level note): this is a prod data change, hard to reverse, run after a backup.

**Files:**
- Create: `packages/routines/sql/scrub-leaked-run-errors.sql`
- Create: `packages/routines/src/__tests__/scrub-leaked-run-errors.test.ts`

**Interfaces:**
- Produces (Task 5 quotes these verbatim):
  - Path: `packages/routines/sql/scrub-leaked-run-errors.sql`.
  - Dry run: `psql -X -v ON_ERROR_STOP=1 -f <file>`. Apply: add `-v apply=1`.
  - Stdout lines: `run-history rows with old error text: <N>`, `routines with old error text: <M>`, then either `run-history rows rewritten: <N>` and `routines rewritten: <M>` (apply) or `Dry run: nothing was changed. Run again with -v apply=1 to rewrite them.` (dry run).
- Consumes (test): `RUN_CLOSED`, `RUN_INTERRUPTED`, `createRoutinesStore` (`../store.js`); `BRIEF_DIDNT_LOAD`, `BRIEF_TOO_LONG`, `BRIEF_UNCONFIRMED` (`../brief.js`); `runFailedText` (`../fire.js`); `runRoutinesMigration`, `RoutinesDatabase` (`../migrations.js`); `createInput` (`./store-fixture.js`).

The SQL file below is the spec. Every line is a decision: the keep-list, which rows, the new text, the transaction shape, and the output. Write it as is:

```sql
-- TASK-1036. One-off scrub of old run errors. Runbook: deploy/GKE.md, "4g. Scrub old run errors".
--
-- Before TASK-1031 (#1116), a run that failed for a host reason stored the failure's own
-- text (a hook's or a database's message) in routines_v1_fires.error and, as the routine's
-- last error, in routines_v1_definitions.last_error. Owners and team members read both,
-- and agents read the last error. This rewrites that text to the sentence runFailedText
-- (fire.ts) gives a host failure with no code.
--
-- It keeps every text the current writers record (the keep-list below); anything else on a
-- failed run is old internal text. It prints counts, never a row's text.
--
--   dry run (the default; counts, then rolls back):  psql -X -v ON_ERROR_STOP=1 -f scrub-leaked-run-errors.sql
--   apply (after a backup):                         psql -X -v ON_ERROR_STOP=1 -v apply=1 -f scrub-leaked-run-errors.sql
--
-- Safe to re-run: a second apply rewrites nothing. A one-off for the TASK-1036 release:
-- before reusing it, re-check the keep-list against every writer of these two columns.
--
-- `terminated: …` rows are kept on purpose: a runner's failure reason can be its own error
-- text, and what owners should see for it is a separate card (TASK-1036 decisions).

\set ON_ERROR_STOP on
\if :{?apply}
\else
\set apply false
\endif

SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;

BEGIN;

CREATE FUNCTION pg_temp.ax_kept_run_error(e text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $kept$
  SELECT e IN (
      'The routine run closed before it could start.',            -- RUN_CLOSED, store.ts
      'The routine run was interrupted by a host restart.',       -- RUN_INTERRUPTED, store.ts (getDispatchOutcome keys on it)
      'This app update could not run.',                            -- fire.ts, store.ts finishDispatch
      'This app update could not run. Try a new delivery.',        -- repeat-runtime.ts
      'This app update was cancelled because the job changed.',   -- repeat-deliveries.ts
      'the run finished without reporting a result',              -- fire.ts
      'We couldn’t confirm this task’s instructions loaded, so this check-in is marked as failed.', -- BRIEF_UNCONFIRMED, brief.ts
      'This routine is disabled.'                                  -- an older host sentence (e4f327190)
    )
    OR e LIKE 'This task’s instructions %'                         -- BRIEF_DIDNT_LOAD, BRIEF_TOO_LONG and its older wordings, brief.ts
    OR e ~ '^This run failed because of a problem on our side( \(code: [A-Za-z0-9][A-Za-z0-9_-]{0,39}\))?\.$'  -- runFailedText, fire.ts
    OR e LIKE 'terminated: %'                                      -- fire.ts; see the header
$kept$;

SELECT count(*) AS fires FROM routines_v1_fires
 WHERE status = 'error' AND error IS NOT NULL AND NOT pg_temp.ax_kept_run_error(error) \gset
SELECT count(*) AS routines FROM routines_v1_definitions
 WHERE last_status = 'error' AND last_error IS NOT NULL AND NOT pg_temp.ax_kept_run_error(last_error) \gset
\echo 'run-history rows with old error text:' :fires
\echo 'routines with old error text:' :routines

\if :apply
UPDATE routines_v1_fires SET error = 'This run failed because of a problem on our side.'
 WHERE status = 'error' AND error IS NOT NULL AND NOT pg_temp.ax_kept_run_error(error);
\echo 'run-history rows rewritten:' :ROW_COUNT
UPDATE routines_v1_definitions SET last_error = 'This run failed because of a problem on our side.'
 WHERE last_status = 'error' AND last_error IS NOT NULL AND NOT pg_temp.ax_kept_run_error(last_error);
\echo 'routines rewritten:' :ROW_COUNT
COMMIT;
\else
\echo 'Dry run: nothing was changed. Run again with -v apply=1 to rewrite them.'
ROLLBACK;
\endif
```

- [ ] **Step 1: Write the failing test**

Container setup follows `dual-method-migration.test.ts:20-27`: `startTestContainer(new PostgreSqlContainer('postgres:16-alpine'))`, a Kysely pool and `runRoutinesMigration(db)` in `beforeAll`, and destroy/stop in `afterAll`. `beforeEach` runs the same `TRUNCATE` list as `store-fixture.ts:17`.

```ts
const SCRUB = readFileSync(new URL('../../sql/scrub-leaked-run-errors.sql', import.meta.url), 'utf8');
const FIXED = runFailedText(undefined); // 'This run failed because of a problem on our side.'
const KEPT = [
  RUN_CLOSED, RUN_INTERRUPTED, 'This app update could not run.', 'This app update could not run. Try a new delivery.',
  'This app update was cancelled because the job changed.', 'the run finished without reporting a result',
  BRIEF_DIDNT_LOAD, BRIEF_TOO_LONG, BRIEF_UNCONFIRMED,
  'This task’s instructions are too long to load, so the check-in didn’t run. Shorten “What to do” and the next check-in will run.',
  'This task’s instructions are too long to load, so the check-in didn’t run. Shorten “What should … do?” in the agent’s settings and the next check-in will run.',
  'This routine is disabled.', FIXED,
  runFailedText(new PluginError({ plugin: 'test', code: 'timeout', message: 'PRIVATE' })),
  runFailedText(Object.assign(new Error('PRIVATE'), { code: 'ECONNRESET' })),
  'terminated: chat-run-timeout',
  'terminated: ClaudeSdkTurnError: runner text', // kept on purpose (TASK-1036 decisions)
];
const LEAKED = [
  "unknown: service hook 'conversations:create' threw: PRIVATE connection detail",
  "timeout: service hook 'agents:resolve' exceeded 30000ms",
  'PRIVATE bare database message',
  'Error: PRIVATE thrown value',
  '',
];
/** Runs the real file with the container's own psql, as the runbook's pod does. */
async function scrub(flags: string[] = [], env: Record<string, string> = {}): Promise<string> {
  await container.copyContentToContainer([{ content: SCRUB, target: '/tmp/scrub.sql' }]);
  const r = await container.exec(['psql', '-X', '-v', 'ON_ERROR_STOP=1', ...flags, '-U', container.getUsername(),
    '-d', container.getDatabase(), '-f', '/tmp/scrub.sql'], { env });
  expect(r.exitCode, r.output).toBe(0);
  return r.stdout;
}
```

Seed with a `seed()` helper:
- **Fires.** One `routines_v1_fires` row per `KEPT` and per `LEAKED` string, `status:'error'`, `agent_id:'a'`, `routine_id:'r'` (no definition row needed), `trigger_source:'tick'`. Make the `LEAKED[0]` row `'webhook'`. Add three more rows: `{status:'ok',error:null}`, `{status:'silenced',error:null}` and `{status:'error',error:null}`.
- **Definitions.** Two routines via `createRoutinesStore(db).createAuthored({ ...createInput('scrub-leaked'), definition: { ...createInput().definition, name: 'Scrub leaked' } })`, and the same with `'scrub-kept'` / `'Scrub kept'`. Then `UPDATE routines_v1_definitions SET last_status='error', last_error=…` sets `LEAKED[0]` and `RUN_INTERRUPTED` respectively.

Snapshot helper: every fires row's `id, status, error` and every definition's `routine_id, last_status, last_error, revision, updated_at`.

Tests:
1. `it.each([[[]], [['-v', 'apply=0']]])('a dry run (%j) counts the old rows and changes nothing')`. Asserts:
   - stdout has `run-history rows with old error text: 5`, `routines with old error text: 1` and `Dry run: nothing was changed.`
   - The snapshot is unchanged.
   - stdout does not contain `PRIVATE`.
2. `'apply rewrites only the old rows, and a dry run afterwards finds none'`. Asserts:
   - stdout has `run-history rows rewritten: 5` and `routines rewritten: 1`.
   - Every `LEAKED` fire is now `FIXED`; every `KEPT` fire and the three non-error/null rows are unchanged.
   - The leaked routine's `last_error` is `FIXED`, and its `revision`/`updated_at` are unchanged. The kept routine is unchanged.
   - A following `scrub()` prints `run-history rows with old error text: 0` and `routines with old error text: 0`.
3. `'a client that is not UTF-8 still keeps the curly-quoted sentences'`. `scrub(['-v', 'apply=1'], { PGCLIENTENCODING: 'LATIN1' })` leaves the `BRIEF_*` rows and both older wordings unchanged, and still prints `run-history rows rewritten: 5`.

- [ ] **Step 2: Run, and see it fail**

Run: `pnpm --filter @ax/routines exec vitest run src/__tests__/scrub-leaked-run-errors.test.ts`
Expected: FAIL (the SQL file does not exist yet: `ENOENT`).

- [ ] **Step 3: Create the SQL file exactly as above**

- [ ] **Step 4: Run, and see it pass**

Run: the Step 2 command → PASS (all 4 cases).

Then prove the encoding pin: temporarily delete the `SET client_encoding` line, see test 3 fail, and restore it. Don't commit the deletion.

- [ ] **Step 5: Commit**

```bash
git add packages/routines/sql/scrub-leaked-run-errors.sql packages/routines/src/__tests__/scrub-leaked-run-errors.test.ts
git commit -m "[TASK-1036] routines: one-off psql scrub of pre-#1116 run error text (dry run by default)"
```

---

### Task 5: Runbook step `deploy/GKE.md` §4g and its doc guard [tier: sensitive]

Needs `security-checklist` (PR-level note): a prod procedure that mounts the DB secret into a pod.

**Files:**
- Modify: `deploy/GKE.md`. Insert `### 4g. Scrub old run errors (TASK-1036)` after §4f's `#### Step 5: verify` (which ends "…proven against the new layout."), before the `---` above `## Step 5 — Static IP, DNS, and the managed certificate`.
- Create: `scripts/__tests__/run-error-scrub-runbook.test.js`

**Interfaces:**
- Consumes: Task 4's path, flags and the five output strings.

- [ ] **Step 1: Write the failing doc test**

`run-error-scrub-runbook.test.js` reads its files at module top level, as `gke-backups-docs.test.js` does. It needs no hooks and no timeouts (`scripts-suite-timeouts.test.js` polices hook budgets). The section is the text from `### 4g. Scrub old run errors` to the next `\n---\n`. Tests:
1. `'names the script that exists and the flag that writes'`:
   - the section contains `packages/routines/sql/scrub-leaked-run-errors.sql` and `-v apply=1`;
   - `existsSync` on that path is true.
2. `'quotes the lines the script prints'`. Each of `run-history rows with old error text:`, `routines with old error text:`, `run-history rows rewritten:`, `routines rewritten:` and `Dry run: nothing was changed.` appears in both the SQL file and the section.
3. `'names its context on every kubectl line and backs up before it writes'`:
   - every section line whose trimmed text starts with `kubectl ` contains `--context "$KCTX"`;
   - the first line containing `gcloud sql backups create` comes before the first line containing both `psql` and `-v apply=1`. Prose may mention the flag earlier; only the command line counts.

Run: `pnpm test:scripts` → FAIL (no §4g yet).

- [ ] **Step 2: Write §4g**

Prose, in the CLAUDE.md voice (direct, no jokes about the data change itself), covering:
- **Why.** Before TASK-1031, a run that failed for a host reason stored the hook's or database's own message. Owners and team members see it in run history and as the routine's last error, and agents read the last error. This rewrites old rows to "This run failed because of a problem on our side."
- **When.** Once, on the first deploy that includes TASK-1036, after the host runs that release (`rollout status` done). Before that, old code would keep writing such rows.
- **What people will see.** Old failed runs that showed internal text now show the fixed sentence. Untouched: interrupted and closed runs, app-update messages, task brief messages, and `terminated: …` reasons (a separate card).
- **Counts only.** It never prints a row's text, because the texts are what we're removing, and this output can land in a ticket or a chat.
- **Safety.** It is safe while the app is up: one short transaction that touches only failed runs' error text. It changes no revision or `updated_at` and cancels no queued app update.
- **Undo.** The Step 1 backup is the only undo, and restoring it reverts everything since.

Commands. Copy these exactly; the context block is §4f's three lines.

````markdown
```bash
KCTX=<your GKE context>        # kubectl config get-contexts
NS=ax-next
kubectl --context "$KCTX" get deploy ax-next-host -n "$NS"   # must be the cluster you mean
```

#### Step 1: back up first

```bash
gcloud sql backups create --instance=ax-next-db --project=$PROJECT_ID
gcloud sql backups list --instance=ax-next-db --project=$PROJECT_ID --limit=1   # status SUCCESSFUL
```

#### Step 2: load the script

From the repo root of a checkout of the release you just deployed:

```bash
kubectl --context "$KCTX" create configmap run-error-scrub -n "$NS" \
  --from-file=scrub.sql=packages/routines/sql/scrub-leaked-run-errors.sql
```

#### Step 3: dry run, and write the counts down

```bash
kubectl --context "$KCTX" create -n "$NS" -f - <<'YAML'
apiVersion: v1
kind: Pod
metadata:
  name: run-error-scrub-check
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  volumes:
    - name: scrub
      configMap: { name: run-error-scrub }
  containers:
    - name: psql
      image: postgres:17
      volumeMounts:
        - { name: scrub, mountPath: /sql, readOnly: true }
      env:
        - name: DATABASE_URL
          valueFrom: { secretKeyRef: { name: ax-next-db, key: url } }
      command: ["sh", "-c"]
      args:
        - |
          # Same DSN handling as 4f: libpq wants sslmode=require.
          psql "${DATABASE_URL%%\?*}?sslmode=require" -X -v ON_ERROR_STOP=1 -f /sql/scrub.sql
YAML
kubectl --context "$KCTX" wait --for=jsonpath='{.status.phase}'=Succeeded pod/run-error-scrub-check -n "$NS" --timeout=120s
kubectl --context "$KCTX" logs run-error-scrub-check -n "$NS"
kubectl --context "$KCTX" delete pod run-error-scrub-check -n "$NS"
```
````

After Step 3: expect `Dry run: nothing was changed.` and the two counts (write them down). If the wait times out, run `kubectl --context "$KCTX" describe pod run-error-scrub-check -n "$NS"`; delete the pod either way.

**Step 4: rewrite.** Use the same block with two changes, written out in full in the doc (no hand-editing in prod): `name: run-error-scrub-apply` (and in the three follow-up commands), and the psql line `... -X -v ON_ERROR_STOP=1 -v apply=1 -f /sql/scrub.sql`. Expect `run-history rows rewritten:` equal to Step 3's first count, and `routines rewritten:` equal to or lower than the second (a routine that ran again since Step 3 already has new text).

**Step 5: verify and clean up.**
- Run Step 3 again: both counts must be `0`.
- In the app, open a routine whose run failed before the deploy: its history shows the fixed sentence.
- Then `kubectl --context "$KCTX" delete configmap run-error-scrub -n "$NS"`.

Add no `](#…)` links unless their headings exist; `gke-backups-docs.test.js` checks every anchor.

- [ ] **Step 3: Run the guards**

Run: `pnpm test:scripts` → PASS. That includes the new test, `docs-zsh-tied-variables.test.js` and `gke-backups-docs.test.js`.

- [ ] **Step 4: Commit**

```bash
git add deploy/GKE.md scripts/__tests__/run-error-scrub-runbook.test.js
git commit -m "[TASK-1036] deploy: GKE runbook step to scrub old run errors after a backup"
```

---

## Before the PR (builder)

1. **TASK-1035 coordination.** `git fetch origin`. If TASK-1035 has merged and touched `packages/routines/src/plugin.ts`, rebase, then:
   - `grep -rn "faultCode" packages/routines/src` must print nothing;
   - check there is no duplicate `faultLogFields` import in `plugin.ts`;
   - re-run Task 1's tests and `pnpm --filter @ax/routines build`.
2. **Full gate,** with `DOCKER_HOST` set:
   - `pnpm build && pnpm lint`
   - `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`
3. **PR body:**
   - The security note (`security-checklist`: sandbox escape N/A; prompt injection: `lastError` reaches agents through `routine_list`/`routine_get`, the scrub removes old internal text, and the `terminated:` residual is named; supply chain: no new dependency, and the pod uses `postgres:17` as §4f does).
   - "No boundary review: no hook signature or payload changes. Only `connectors:upsert`'s refusal text and the webhook log fields change."
   - "Item 2 runs at deploy time, with human approval, after a backup (§4g). Nothing runs at merge."
   - The refuted premise below.
4. **Hand back to auto-ship as a follow-up card** (text ready to paste):
   > **Runner-terminated runs store the runner's own error text.**
   > - `packages/routines/src/fire.ts:446-448` stores `terminated: ${reason}`. For a runner failure, `reason` is `${err.name}: ${err.message}` (`agent-runner-core/src/run-runner.ts:1689`, `String(err)` at `:1696`), passed through unchanged (`chat-orchestrator/src/orchestrator.ts:1762`).
   > - It shows raw in Settings (RoutinesList `lastError`, FireRowsTable), on task pages (`channel-web/src/lib/task-updates.ts` `runFailureText` falls through), and to agents (`routine_list`/`routine_get` `lastError`).
   > - Decide what owners see. Keep code-shaped reasons (`terminated: chat-run-timeout`). Free text becomes fixed words plus a logged code. Note that some runner text is actionable for an owner, such as provider credit or rate limits.
   > - Then narrow TASK-1036's scrub keep-list from `terminated: %` to code-shaped reasons and run it again. Or land this before the TASK-1036 deploy so that one scrub run covers both.

## Refuted premise (for the PR body and the handoff)

The card assumes #1116 stopped new internal text from reaching `fires.error` and `last_error`, which would make the scrub a one-off. Not quite: the `terminated: <reason>` writer still stores runner text (decisions shard, rows 1–2).

The claim that made it look true is `.claude/memory/decisions/2026-11-03-TASK-1031.md:6` ("reasons are orchestrator codes, not error text"). It is corrected by this card's shard (R1 forbids editing it), and in code by Task 3's comment.

The scrub here covers what #1116 fixed and deliberately keeps `terminated:` rows.
