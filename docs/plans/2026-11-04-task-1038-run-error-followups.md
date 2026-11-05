# TASK-1038 Run-error follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the TASK-1036 (#1118) leftovers.
1. A run whose invoke ended `terminated` stores fixed words and a host code. It never stores the runner's own error text.
2. The scrub's keep-list narrows, so its next run rewrites the old runner text.
3. Three error reads in `@ax/routines`, plus one more in `tick.ts`, stop trusting the error object.

**Architecture:** Everything is inside `@ax/routines`. No hook, payload or `returns` schema changes.
- `fire.ts` gains `terminatedRunText(reason)`. It returns runFailedText's sentence with a code. The code is the reason only when the reason has the host-code shape; otherwise it is `runner-error`.
- The psql scrub keeps that sentence. It also keeps old `terminated: <host code>` rows. Every other `terminated:` row is old runner text, and the scrub rewrites it.
- `tick.ts` and `webhook-handler.ts` read errors inside try/catch, the same way `isAgentGone` and `faultLogFields` do.

**Tech Stack:** TypeScript, vitest, kysely/pg, `@testcontainers/postgresql` (`copyContentToContainer`, `exec`), psql (PG 16 in tests, 17 in the §4g pod).

**Spec:** card TASK-1038 (board). The planner's decisions and evidence are in `.claude/memory/decisions/2026-11-04-TASK-1038.md`. Read its rows 3, 6 and 9 before Tasks 1, 2 and 4. The predecessor plan is `docs/plans/2026-11-03-task-1036-error-surface-followups.md`.

## Global Constraints

- **No cluster, no prod.** The default kubectl context is GKE PROD. Don't run any `kubectl` or `gcloud` command. Test the scrub only against the testcontainers Postgres. Prod is running today's §4g as you build. Your script change ships in a later deploy.
- Most routines tests start a Postgres testcontainer: everything built on `store-fixture.ts` or `support/routine-harness.ts`, plus `scrub-leaked-run-errors.test.ts`. They need an explicit `DOCKER_HOST` (CLAUDE.md, "Docker-backed tests"). `webhook-admission.test.ts` uses fakes and doesn't.
- `pnpm --filter <pkg>` goes **before** the script. For one file, use `pnpm --filter @ax/routines exec vitest run <path>`.
- Never store or log an error's message or a terminated reason on any path touched here. The only exceptions are the existing stderr lines in `tick.ts`, which print a readable error's message as they do today.
- Stay out of `packages/routines/src/definition.ts` (TASK-1027: the legacy `webhook.hmac` parse is hashed byte for byte), `packages/routines/src/store.ts` (TASK-913 is building there) and `packages/channel-web` (TASK-1037).
- Exact strings in this plan are the spec: stored texts, regexes, SQL, the fallback log text and the runbook prose. Copy them; don't reword them.
- Two rules for the new SQL keep-list lines:
  - Indent them like their neighbours. The runbook doc test replays only column-0 lines, so a new column-0 line fails it.
  - Keep `:` after `0-9` inside `[a-z0-9:-]`. In a bracket, `[:` starts a POSIX class name.
- Memory goes only into the shard `.claude/memory/decisions/2026-11-04-TASK-1038.md`. Never touch a root archive, and don't delete any memory line.

## Review Focus

1. **A host code followed by a second line** (`chat-run-timeout\nPRIVATE …`) stores `runner-error`, not the code. JS `$` without `m` and the scrub's ARE both anchor at the string's end. (Task 1 row `a host code with a second line`; Task 2 `RUNNER_TEXT`'s `terminated: chat-run-timeout\n…`.)
2. **The 64-character limit, at the limit and one past it,** must agree between the writer and the scrub. A 64-character code is shown and kept. A 65-character one is `runner-error`, and an old 65-character `terminated:` row is rewritten. (Task 1 rows `'a'.repeat(64)` / `'a'.repeat(65)`; Task 2 `KEPT` / `RUNNER_TEXT`.)
3. **A webhook run that a runner ended** still stores only `This app update could not run.` (Task 1, the webhook test.)
4. **A database that today's TASK-1036 scrub already rewrote** changes only in its old runner-text `terminated:` rows, and a second apply writes nothing. (Task 2, the focused test.)
5. **A secret read that fails with an error nobody can read** never counts as "no secret saved", which would accept an unsigned update. It refuses as `secret`, and nothing is admitted. (Task 4, both secret-read rows.)

## Files

| File | Task | Responsibility |
|---|---|---|
| `packages/routines/src/fire.ts` (`:190`, `:458-463`) | 1 | `terminatedRunText`; the terminated branch uses it |
| `packages/routines/src/__tests__/fire.test.ts` (`:258-269`, new describe) | 1 | Pin the stored text |
| `packages/routines/sql/scrub-leaked-run-errors.sql` (`:1`, `:15-16`, `:40-41`, `:69`) | 2 | Narrowed keep-list and header |
| `packages/routines/src/__tests__/scrub-leaked-run-errors.test.ts` | 2 | Fixtures and a focused test |
| `deploy/GKE.md` §4g (`:767-787`) | 2 | Run it again for TASK-1038; what it now rewrites |
| `packages/routines/src/tick.ts` (`:81`, `:141`) | 3 | `logDetail` guard |
| `packages/routines/src/__tests__/tick.test.ts` | 3 | Hostile-error rows |
| `packages/routines/src/webhook-handler.ts` (`:18`, `:91-105`, `:165-170`) | 4 | `pluginErrorCode`, `isQuotaRefusal` |
| `packages/routines/src/__tests__/webhook-admission.test.ts` | 4 | Hostile-error rows |

Order: Task 1 comes before Task 2, because Task 2's test imports `terminatedRunText` and its regex mirrors Task 1's. Tasks 3 and 4 are independent of everything else and of each other. Commit Task 2 last (1, 3, 4, then 2). §4g Step 2 lists the routines commits made after the script's own last commit, so ending on the script's commit keeps that deploy check empty even if the PR isn't squashed.

---

### Task 1: A terminated run stores fixed words and a host code [tier: sensitive]

Needs `security-checklist` (PR-level note). Runner output is untrusted (invariant 5). Today it is stored as a routine's `lastError` and in its run history. Owners and team members see both, and the agent reads `lastError` through `routine_list`/`routine_get`.

**Files:**
- Modify: `packages/routines/src/fire.ts`. Add the new function after `OWNER_CODE_RE` (`:190`), and replace the body of the terminated branch (`:458-463`).
- Test: `packages/routines/src/__tests__/fire.test.ts`. Update `:258-269`, and add a new describe after `describe('accepted DB fire dispatch')` (which ends at `:277`).

**Interfaces:**
- Produces: `export function terminatedRunText(reason: string): string` in `fire.ts`.
  - It returns `` `This run failed because of a problem on our side (code: ${code}).` ``.
  - `code` is `reason` when `HOST_REASON_RE.test(reason)`, else `'runner-error'`.
  - Module-private `const HOST_REASON_RE = /^[a-z0-9][a-z0-9:-]{0,63}$/;`. Task 2 repeats this pattern in SQL.
- Consumes: `briefRunError`, `briefRunMiss`, `refusedBeforeAssembly`. All are unchanged, and they keep reading the raw reason.

- [ ] **Step 1: Update the pre-assembly gate test and write the new describe**

At `:258-259`, replace the two comment lines with:

```ts
  // TASK-908: `system-prompt:` is the landed veto's, fired before connector assembly too. A repeat routine's run
  // stores the reason as its code (TASK-1038); only a task's is worded (checkin.test.ts).
```

In that `it.each` (`:260-269`), both the stderr matcher's prefix and the `error` expectation become ``This run failed because of a problem on our side (code: ${reason}).`` in place of ``terminated: ${reason}``.

New describe:

```ts
// TASK-1038: a `terminated` reason can be the runner's own error text, and runner output is untrusted. A run's
// error is its history row and the routine's lastError (owners, team members and the agent read both): fixed
// words and a code, which is the reason only when it is shaped like a host code.
describe('a run its invoke ended terminated stores fixed words and a code (TASK-1038)', () => {
  const stored = (code: string) => `This run failed because of a problem on our side (code: ${code}).`;
  /** Fires once with an invoke that ends `terminated` with `reason`: the run's error, the routine's lastError, and the stderr line. */
  async function terminatedWith(reason: unknown, source?: 'webhook') {
    const h = await setup({ invoke: async () => ({ kind: 'terminated', reason }) });
    const prefix = `[ax/routines] agent:invoke failed for a/${h.row.routineId}: `;
    const diagnostic = captureExpectedStderr(message => message.startsWith(prefix));
    await h.fire(source === undefined ? h.accepted : { ...h.accepted, source });
    await expect.poll(async () => (await f.store.recentFires(h.row)).length).toBe(1);
    return {
      error: (await f.store.recentFires(h.row))[0]?.error,
      lastError: (await f.store.findOne(h.row))?.lastError,
      stderr: diagnostic.messages.map(m => m.slice(prefix.length)),
    };
  }
  it.each([
    'chat-run-timeout', 'sandbox-exit-before-chat-end', 'connector-needs-reconnect',
    'chat:start:usage-limit-daily', 'agent-resolve:forbidden', 'system-prompt:identity-unavailable',
    'a'.repeat(64),
  ])('keeps the host code %s', async (reason) => {
    expect(await terminatedWith(reason)).toEqual({ error: stored(reason), lastError: stored(reason), stderr: [`${stored(reason)}\n`] });
  });
  it.each([
    ['a runner error', 'ClaudeSdkTurnError: Claude SDK turn failed (error_during_execution): PRIVATE provider reply'],
    ['a bare runner message', 'PRIVATE connection reset by peer'],
    ['a gate prefix with words after it', 'chat:start:PRIVATE words the runner chose'],
    ['capital letters', 'PRIVATE-CODE'],
    ['a dot, which could spell a host', 'private.example.com'],
    ['a slash', 'private/path'],
    ['a host code with a second line', 'chat-run-timeout\nPRIVATE second line'],
    ['a code one character too long', 'a'.repeat(65)],
    ['nothing', ''],
  ])('stores runner-error, never %s', async (_name, reason) => {
    const fixed = stored('runner-error');
    expect(await terminatedWith(reason)).toEqual({ error: fixed, lastError: fixed, stderr: [`${fixed}\n`] });
  });
  it.each([
    ['a number', 42],
    ['an object whose toString throws', { toString() { throw new Error('PRIVATE'); } }],
    ['missing', undefined],
  ])('stores unknown when the reason is %s, not a string', async (_name, reason) => {
    expect((await terminatedWith(reason)).error).toBe(stored('unknown'));
  });
  it('a webhook run that a runner ended still says only that the app update could not run', async () => {
    const run = await terminatedWith('ClaudeSdkTurnError: PRIVATE runner text', 'webhook');
    expect(run).toEqual({ error: 'This app update could not run.', lastError: 'This app update could not run.', stderr: ['This app update could not run.\n'] });
  });
});
```

- [ ] **Step 2: Run, and see them fail**

Run: `pnpm --filter @ax/routines exec vitest run src/__tests__/fire.test.ts`

Expected: FAIL. Every row stores `terminated: <reason>`. The throwing-`toString` row writes no row at all, because `String()` throws inside the invoke's `.then`. Its poll times out after the package's 15 s `expect.poll` budget (`vitest.config.ts`). The webhook test passes already; it is a guard, not a red test.

- [ ] **Step 3: Implement**

`terminatedRunText` and `HOST_REASON_RE` go after `OWNER_CODE_RE`. Its doc comment says four things:
- Why. A runner that fails gives its own error as the reason (`${name}: ${message}`, agent-runner-core `run-runner.ts`). Runner output is untrusted, and this text becomes the routine's `lastError`, which owners, team members and the agent read.
- The rule. The reason is the code only when it has the host-code shape. Every orchestrator reason and gate code (`chat:start:`, `agent-resolve:`, `system-prompt:`) has it. Anything else, which today is always a runner's own text, becomes `runner-error`.
- The residual. A runner can still choose a reason with that shape. It shows as one token of at most 64 lowercase letters, digits, `-` and `:`. With no space, `.` or `/`, it can't spell a sentence, a URL, a path or a dotted host name. It can still spell a bare `name:port`, which is why runFailedText's own codes (from host errors, which can carry infrastructure) keep excluding `:`.
- That the scrub's keep-list (`packages/routines/sql/scrub-leaked-run-errors.sql`) repeats the pattern. Change both together.

Inside `if (outcome?.kind === 'terminated') {` (`:457`), replace `:458-463` with exactly the lines below. That covers the four comment lines, the `const reason` line and the `settleWithoutTurn` call. Keep `:457` itself and the `} else if (deps.pending.has(reqId)) {` branch at `:464`.

```ts
          // The reason decides a task run's wording (briefRunError), why it left
          // no report (briefRunMiss) and whether the last warning moves
          // (refusedBeforeAssembly). It is stored only through terminatedRunText:
          // a runner that fails gives its own error text as the reason, and
          // runner output is untrusted (TASK-1038).
          const reason = typeof outcome.reason === 'string' ? outcome.reason : 'unknown';
          await settleWithoutTurn(entry => briefRunError(entry, reason) ?? terminatedRunText(reason), !refusedBeforeAssembly(reason), entry => briefRunMiss(entry, reason));
```

`settleWithoutTurn`'s webhook override and its stderr line stay as they are.

- [ ] **Step 4: Run, and see them pass; typecheck**

Run: `pnpm --filter @ax/routines exec vitest run src/__tests__/fire.test.ts src/__tests__/checkin.test.ts src/__tests__/brief.test.ts src/__tests__/plugin.test.ts` → PASS. `checkin.test.ts:188` and `:234` pin that task runs still get BRIEF_DIDNT_LOAD and BRIEF_TOO_LONG. Then run `pnpm --filter @ax/routines build` → no errors. Then `grep -nF 'terminated: ${' packages/routines/src/fire.ts` → no output.

- [ ] **Step 5: Commit**

```bash
git add packages/routines/src/fire.ts packages/routines/src/__tests__/fire.test.ts
git commit -m "[TASK-1038] routines: a terminated run stores fixed words and a host code, never runner text"
```

---

### Task 2: The scrub stops keeping runner text in `terminated:` rows; §4g says to run it again [tier: sensitive]

Needs `security-checklist` (PR-level note). This is a prod data change, hard to reverse, run by hand after a backup. It must stay a safe no-op on rows that today's version, which prod runs at the #1108–#1118 deploy, already rewrote.

**Files:**
- Modify: `packages/routines/sql/scrub-leaked-run-errors.sql`: the header at `:1`, `:15-16` and `:40-41`, and the keep-list at `:69`.
- Modify: `packages/routines/src/__tests__/scrub-leaked-run-errors.test.ts`.
- Modify: `deploy/GKE.md` §4g, `:767-787`.

**Interfaces:**
- Consumes: `terminatedRunText` from `../fire.js` (Task 1), plus everything the test imports today.
- Produces: nothing new. The script's flags, `\echo` lines, statements and output stay unchanged, and so do the runbook's sample logs.

- [ ] **Step 1: Update the fixtures and write the focused test**

- Import `terminatedRunText` beside `runFailedText` (`:11`).
- `KEPT`:
  - Delete `'terminated: ClaudeSdkTurnError: runner text', // kept on purpose (TASK-1036 decisions)` (`:34`).
  - Add `terminatedRunText('chat-run-timeout')`, `terminatedRunText('chat:start:usage-limit-daily')`, `terminatedRunText('ClaudeSdkTurnError: PRIVATE runner text')` (the writer's `runner-error` sentence), `terminatedRunText('a'.repeat(64))`, `'terminated: chat:start:usage-limit-daily'`, `'terminated: agent-resolve:forbidden'` and `` `terminated: ${'a'.repeat(64)}` ``. Keep `'terminated: chat-run-timeout'`.
  - Its doc comment becomes:

    ```ts
    /** Every shape a current writer records, an older host sentence, and old `terminated:` rows whose reason was a host code: the scrub must leave each alone. */
    ```
- After `LEAKED`, add:

```ts
/** TASK-1038: what fire.ts stored before it for a run a runner ended: `terminated: ` and the runner's own text. */
const RUNNER_TEXT = [
  'terminated: ClaudeSdkTurnError: Claude SDK turn failed (error_during_execution): PRIVATE provider reply',
  'terminated: PRIVATE bare runner message',
  'terminated: Error: PRIVATE thrown value',
  'terminated: chat:start:PRIVATE words after a gate prefix',
  'terminated: chat-run-timeout\nPRIVATE second line',
  `terminated: ${'a'.repeat(65)}`,
  'terminated: ',
];
```

- A new test, last in the describe:

```ts
// TASK-1038: fire.ts no longer stores a runner's text. A database the TASK-1036 version already ran on holds the
// fixed sentence, which stays as it is; the old runner text in `terminated:` rows is now rewritten too.
it('rewrites runner text in old terminated rows, keeps host codes, and changes nothing else in a database it already scrubbed', async () => {
  // What the TASK-1036 apply left behind: the fixed sentence where old text was, and every row it kept.
  const scrubbed = [await addFire('error', FIXED), await addFire('error', FIXED, 'a', 'webhook')];
  for (const error of KEPT) await addFire('error', error);
  const runnerFires = new Set<string>();
  for (const error of RUNNER_TEXT) runnerFires.add(await addFire('error', error));
  const runnerRoutine = await addRoutine('Scrub runner text', 'error', RUNNER_TEXT[0]!);
  const scrubbedRoutine = await addRoutine('Scrub scrubbed', 'error', FIXED);
  const before = await snapshot();

  expect(lines(await scrub())).toEqual([...PREAMBLE,
    `run-history rows with old error text: ${RUNNER_TEXT.length}`,
    'routines with old error text: 1',
    'old rows that look like a host sentence: 0',
    'Dry run: nothing was changed. Run again with -v apply=1 to rewrite them.',
    'ROLLBACK',
  ]);
  expect(await snapshot()).toEqual(before);

  const out = await scrub(['-v', 'apply=1']);
  expect(lines(out).slice(-5)).toEqual(['UPDATE 1', `UPDATE ${RUNNER_TEXT.length}`,
    `run-history rows rewritten: ${RUNNER_TEXT.length}`, 'routines rewritten: 1', 'COMMIT']);
  expect(out).not.toContain('PRIVATE');
  const after = await snapshot();
  expect(after.fires).toEqual(before.fires.map(row => (runnerFires.has(row.id) ? { ...row, error: FIXED } : row)));
  expect(after.routines).toEqual(before.routines.map(row => (row.routine_id === runnerRoutine ? { ...row, last_error: FIXED } : row)));
  expect(after.fires.filter(row => scrubbed.includes(row.id)).map(row => row.error)).toEqual([FIXED, FIXED]);
  expect(after.routines.find(row => row.routine_id === scrubbedRoutine)?.last_error).toBe(FIXED);

  expect(lines(await scrub(['-v', 'apply=1'])).slice(-5)).toEqual(['UPDATE 0', 'UPDATE 0',
    'run-history rows rewritten: 0', 'routines rewritten: 0', 'COMMIT']);
});
```

Every other test keeps its counts. `LEAKED` is unchanged, and new `KEPT` rows are never counted.

- [ ] **Step 2: Run, and see it fail**

Run: `pnpm --filter @ax/routines exec vitest run src/__tests__/scrub-leaked-run-errors.test.ts`

Expected: FAIL. Today's `LIKE 'terminated: %'` keeps every `RUNNER_TEXT` row and the runner routine. Meanwhile it counts the two new `KEPT` sentences, the one with a `:` code and the one with a 64-character code, and the guard counts them too, because they start with "This" and end with ".". So the focused dry run reads 2 rows, 0 routines and a guard of 2, where 7, 1 and 0 are expected. The existing tests' counts and guard lines are off by the same two.

- [ ] **Step 3: Change the SQL**

- `:1` becomes `-- TASK-1036, narrowed in TASK-1038. Scrub of old run errors. Runbook: deploy/GKE.md, "4g. Scrub old run errors".`
- `:15-16` become:

```sql
-- Safe to re-run: a second apply rewrites nothing. On a database an earlier version of this script
-- already ran on (TASK-1036), it changes only the rows this version no longer keeps: the sentence
-- that version wrote is on the keep-list. Run it once per release that changes the keep-list
-- (deploy/GKE.md 4g says when), and before reusing it, re-check the keep-list against every writer
-- of these two columns.
```

- `:40-41` become:

```sql
-- Runs an invoke ended `terminated` (fire.ts). Since TASK-1038 they store terminatedRunText: the
-- fixed sentence and a code, which is the reason only when it is shaped like a host code (lowercase
-- letters, digits, - and :, at most 64, like `chat-run-timeout` or `chat:start:usage-limit-daily`).
-- Before, they stored `terminated: <reason>`, and a runner that fails gives its own error text as the
-- reason. Those old rows are kept when the reason has that host-code shape; the rest are old runner
-- text and are rewritten like any other old text. The guard never counts them: they start with
-- `terminated:`.
```

- `:69` (`OR e LIKE 'terminated: %' …`) becomes these two lines. Indent them like the line they replace:

```sql
    OR e ~ '^This run failed because of a problem on our side \(code: [a-z0-9][a-z0-9:-]{0,63}\)\.$'  -- terminatedRunText, fire.ts (TASK-1038)
    OR e ~ '^terminated: [a-z0-9][a-z0-9:-]{0,63}$'               -- fire.ts before TASK-1038, when the reason was a host code; see the header
```

Nothing else in the file changes: no flags, `\echo` lines, UPDATEs, guard or lock order.

- [ ] **Step 4: Rewrite §4g's opening paragraphs**

In `deploy/GKE.md`, replace the intro paragraph (`:767-771`) with:

```markdown
Before TASK-1031 (#1116), a routine run that failed for a host reason stored the
failing hook's or database's own error message. Before TASK-1038, a run that the
agent's runner ended stored the runner's own error text, as `terminated: …`.
Owners and team members see that text in run history and as the routine's last
error, and agents read the last error too. This step rewrites those old rows to
the sentence the host writes now: "This run failed because of a problem on our
side."
```

Replace **When** (`:773-778`) with:

```markdown
**When.** On the first deploy that includes TASK-1036, and again on the first
deploy that includes TASK-1038, each time after the host is running that release
(`rollout status deploy/ax-next-host` has returned). If one deploy brings both,
run it once. Before then, the old code is still writing this kind of text.
Running it a second time is safe: what the first run wrote is on the script's
keep-list, so the second run changes only the `terminated: …` rows the first one
left alone. Each run is a one-off for its release: the script keeps a list of
the messages the app writes today, and a release that changes one needs that
list updated first. Step 2 checks the release you deployed for that.
```

Replace **What people will see afterwards** (`:780-787`) with:

```markdown
**What people will see afterwards.** Old failed runs that showed internal text
now show the fixed sentence, in run history and as the routine's last error
(which agents read too). Every sentence the current code writes is left alone:
interrupted and closed runs, app-update messages, the messages about a task's
instructions, and "This run failed because of a problem on our side", with or
without a code. So are old `terminated: …` reasons that are just a code, like
`terminated: chat-run-timeout`. Old text that an agent already read may still be
in that agent's conversation transcripts. This step doesn't touch those.
```

Leave the heading and every command block unchanged. Add no `](#…)` link.

- [ ] **Step 5: Run, and see it pass**

- Run: `pnpm --filter @ax/routines exec vitest run src/__tests__/scrub-leaked-run-errors.test.ts` → PASS (all cases).
- Then prove each new keep-list line. Delete it on its own, run the test, then put it back exactly as Step 3 wrote it. The file is uncommitted here, so don't use `git checkout`, which would drop Step 3. Never commit a deletion.
  - Without the first line, the dry-run test reads 7 rows of old text, with the guard at 2. The `chat:start:…` and 64-character sentences are counted, and they read like host sentences.
  - Without the second line, it reads 9 rows instead of 5, with the guard at 0. The four old `terminated: <host code>` rows in `KEPT` are counted.
- Run: `pnpm test:scripts` → PASS. That includes `run-error-scrub-runbook.test.js` (its replay, sample-log and command pins are unchanged), `docs-zsh-tied-variables.test.js` and `gke-backups-docs.test.js`.

- [ ] **Step 6: Commit**

```bash
git add packages/routines/sql/scrub-leaked-run-errors.sql packages/routines/src/__tests__/scrub-leaked-run-errors.test.ts deploy/GKE.md
git commit -m "[TASK-1038] routines: the run-error scrub rewrites old runner text in terminated rows; GKE 4g runs it again"
```

---

### Task 3: `tick.ts` reads an error for its log lines without trusting it [tier: mechanical]

**Files:**
- Modify: `packages/routines/src/tick.ts`. Add the helper after `computeNextRunAt` or before `runTickOnce`, and change the expressions at `:81` and `:141`.
- Test: `packages/routines/src/__tests__/tick.test.ts`.

**Interfaces:**
- Produces: module-private `function logDetail(err: unknown): string`. Inside one try/catch it returns `err instanceof Error ? String(err.message) : String(err)`, and `'(unreadable error)'` when anything throws. Its doc comment says why: `instanceof` can run a Proxy's trap, and a `message` getter or a `toString` can throw. A throw here would skip the work after the log line: recording the run, the rest of the batch, and I-R10's claims. The owner never sees this text (runFailedText).

- [ ] **Step 1: Write the failing tests**

After `edit` (`:17`), add:

```ts
/** TASK-1038: errors whose reading throws. A plugin's error reaches a caller as it was thrown (hook-bus.ts). */
const HOSTILE = [
  ['a message getter that throws', () => Object.defineProperty(new Error('PRIVATE'), 'message', { get() { throw new Error('getter'); } })],
  ['a Proxy whose instanceof check throws', () => new Proxy({}, { getPrototypeOf() { throw new Error('trap'); } })],
  ['a value whose toString throws', () => ({ toString() { throw new Error('toString'); } })],
  ['a value with no prototype', () => Object.create(null) as unknown],
] as const;
```

In `describe('DB scheduler')`:

```ts
it.each(HOSTILE)('still claims authored routines when owner enumeration fails with %s', async (_name, make) => {
  await f.store.createAuthored(createInput());
  const fire = vi.fn(async () => result);
  const diagnostic = captureExpectedStderr(message => message === '[ax/routines] materialize/refresh error: (unreadable error)\n');
  await tick({ fire, getAgents: async () => { throw make(); } });
  expect(fire).toHaveBeenCalledOnce();
  expect(diagnostic.messages).toHaveLength(1);
});
it.each(HOSTILE)('records the run and fires the rest of the batch when a fire fails with %s', async (_name, make) => {
  const failing = await f.store.createAuthored(createInput());
  await f.store.createAuthored({ ...createInput('second'), definition: { ...createInput().definition, name: 'Second' } });
  const fire = vi.fn(async (accepted: AcceptedDispatch) => { if (accepted.row.routineId === failing.routineId) throw make(); return result; });
  const diagnostic = captureExpectedStderr(message => message === `[ax/routines] fire failed for ${failing.agentId}/${failing.routineId}: (unreadable error)\n`);
  await tick({ fire });
  expect(fire).toHaveBeenCalledTimes(2);
  expect((await f.store.recentFires(failing))[0]).toMatchObject({ status: 'error', error: 'This run failed because of a problem on our side.' });
  expect(diagnostic.messages).toHaveLength(1);
});
```

- [ ] **Step 2: Run, and see them fail**

Run: `pnpm --filter @ax/routines exec vitest run src/__tests__/tick.test.ts`

Expected: FAIL in all 8 rows, because `tick()` rejects. The catch's own read throws, `runTickOnce` exits, and the failing routine's run is never recorded.

- [ ] **Step 3: Implement**

Add `logDetail`. At `:81` and `:141`, replace `${err instanceof Error ? err.message : String(err)}` with `${logDetail(err)}`. Leave `:228` alone: decisions row 8 explains why. The existing lines (`tick.test.ts:101`, `:111`) print exactly what they print today.

- [ ] **Step 4: Run, and see them pass; typecheck**

Run: the Step 2 command → PASS, including the existing `records an unexpected dispatcher error once` and `still claims authored routines if owner enumeration fails`. Then `pnpm --filter @ax/routines build` → no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/routines/src/tick.ts packages/routines/src/__tests__/tick.test.ts
git commit -m "[TASK-1038] routines: the tick's log lines read errors through a guard, so a run is still recorded"
```

---

### Task 4: The webhook reads a failure's code without trusting it [tier: sensitive]

Needs `security-checklist` (PR-level note). The secret read's catch decides between "no secret saved" (accept unsigned updates) and a refusal. An error that can't be read must never land on the first branch.

**Files:**
- Modify: `packages/routines/src/webhook-handler.ts`. Add two helpers after `TRANSIENT_SECRET_READ_CODES` (`:18`), and change the secret-read catch (`:91-105`) and the admission catch (`:165-170`).
- Test: `packages/routines/src/__tests__/webhook-admission.test.ts`.

**Interfaces:**
- Produces two module-private helpers. Both run every read inside one try/catch:
  - `function pluginErrorCode(error: unknown): string | undefined`. When `error instanceof PluginError`, it reads `error.code` once and returns it if it's a string. Otherwise, or if anything throws, it returns `undefined`.
  - `function isQuotaRefusal(error: unknown): boolean`. Today's duck-typed `error !== null && typeof error === 'object' && 'code' in error && error.code === 'rejected'` (blob-put-facade's veto). It returns `false` if anything throws.

- [ ] **Step 1: Write the failing tests**

In `describe('the saved secret decides (TASK-1026)')`, after the test at `:126-139`:

```ts
// TASK-1038: the bus hands a PluginError back as it was thrown, getters and all (hook-bus.ts). A code that can't be
// read is no code: it fails closed as `secret`, never as a retry, and never as "none saved" (an unsigned acceptance).
it('refuses as secret, logging no code, when the secret read fails with a plugin error whose code getter throws', async () => {
  const hostile = Object.defineProperty(new PluginError({ plugin: '@ax/credentials', code: 'credential-not-found', message: 'PRIVATE vault detail' }),
    'code', { get() { throw new Error('PRIVATE getter'); } });
  const { vault, warnings } = failing(() => { throw hostile; });
  const f = fixture('accepted', plain, vault), r = response(); await f.handler(request(), r.res);
  expect(r.state.code).toBe(401);
  expect(f.observeWebhook).toHaveBeenCalledWith(expect.objectContaining({ observation: 'secret' }), expect.any(Function));
  expect(warnings).toEqual([{ message: 'routines_webhook_secret_fetch_failed', fields: { agentId: 'a', routineId: 'r' } }]);
  expect(f.admit).not.toHaveBeenCalled(); expect(f.writes).not.toHaveBeenCalled();
});
```

Then a second test, `'… whose instanceof check throws'`. Copy `:126-139` exactly, including its `callJoined` spy. A Proxy can pass the bus's own `instanceof` and throw on a later one, and the spy stands in for that. The only change: the spy throws `new Proxy({}, { getPrototypeOf() { throw new Error('PRIVATE trap'); } })` in place of `new Error('PRIVATE vault detail')`. Its expectations are the same as above: 401, `observation: 'secret'`, the warning without a code, and nothing admitted.

In `describe('a 503 logs its code, never its message (TASK-1027)')`, after `logs nothing for a quota refusal` (`:208-215`):

```ts
// TASK-1038: the quota check reads the failure's code without trusting it. One it can't read is a 503 like any other.
it.each([
  ['a code getter that throws', () => Object.defineProperty(new Error('PRIVATE admission detail'), 'code', { get() { throw new Error('PRIVATE getter'); } }), { name: 'Error' }],
  ['a Proxy whose `in` check throws', () => new Proxy({}, { has() { throw new Error('PRIVATE trap'); } }), {}],
] as const)('answers 503 and logs a failed admission whose code can’t be read: %s', async (_name, make, fields) => {
  const logged = captureStdout(), f = fixture('accepted', plain);
  f.admit.mockRejectedValueOnce(make());
  const r = response(); await f.handler(request(), r.res);
  expect(r.state.code).toBe(503);
  expect(logged()).not.toContain('PRIVATE');
  expect(entries(logged(), 'routines_webhook_admission_failed')).toStrictEqual([{ msg: 'routines_webhook_admission_failed', level: 'warn', agentId: 'a', routineId: 'r', ...fields }]);
  expect(f.observeWebhook).toHaveBeenCalledWith(expect.objectContaining({ observation: 'unavailable' }), expect.any(Function));
});
```

- [ ] **Step 2: Run, and see them fail**

Run: `pnpm --filter @ax/routines exec vitest run src/__tests__/webhook-admission.test.ts`

Expected: FAIL in all 4. `f.handler` rejects, because the catch's own read of `code`, `instanceof` or `in` throws. In production that escapes to http-server's catch-all.

- [ ] **Step 3: Implement**

Add the two helpers. Their doc comments name TASK-1038 and say an unreadable failure is never "none saved". In the secret-read catch, read `const code = pluginErrorCode(error);` once. The test becomes `if (code !== 'credential-not-found') { unreadable(code); … }`, and the transient check and `refuse` calls inside stay as they are. Keep the comment at `:92-96`. In the admission catch, `const quota = isQuotaRefusal(error);`. Don't touch `unreadable`'s fields, `logFault`, `definition.ts`, or anything outside the two catches.

- [ ] **Step 4: Run, and see them pass; typecheck**

Run: `pnpm --filter @ax/routines exec vitest run src/__tests__/webhook-admission.test.ts src/__tests__/webhook-router.test.ts src/__tests__/secret-only-signatures.integration.test.ts` → PASS. Every TASK-1026 and TASK-1027 row is unchanged. Then `pnpm --filter @ax/routines build` → no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/routines/src/webhook-handler.ts packages/routines/src/__tests__/webhook-admission.test.ts
git commit -m "[TASK-1038] routines: the webhook reads a failure's code through a guard; an unreadable one fails closed"
```

---

## Not in this plan

- **Item 3, the counted acknowledgement flag, is deferred** (decisions row 11). It only matters if a dry run's `old rows that look like a host sentence:` is non-zero. Until the deploy running now reports, nobody knows the prod count. If it is non-zero, the follow-up card text is below.
- **`tick.ts:228` and `fire.ts:448`** keep their unguarded reads. With Task 3 in place, they see only routines' own store errors (decisions row 8).
- **Owner wording per code**, such as a usage-limit sentence in place of "a problem on our side", is a UI copy card. channel-web's `ERROR_LABELS` already has sentences for most of these codes.

## Before the PR (builder)

1. **Sibling merges.**
   - `git fetch origin`, then `git log --oneline 640e95fdb..origin/main -- packages/routines/src packages/routines/sql`.
   - For each listed commit (TASK-913 is likely), read its diff for a new string a run stores as its error. Look in `finishDispatch` outcomes, `fail(...)` and `settleWithoutTurn(...)`.
   - If you find one, add it to the scrub's keep-list and to `KEPT` (Task 2) before the PR. Otherwise the next §4g run would rewrite a sentence the app writes, or refuse.
   - TASK-913 works on `store.ts`'s `claimDue`. If it also edited `tick.ts` around the claim (`:86-90`), expect a clean merge: this plan edits only `:81` and `:141`. Re-check both still read `${logDetail(err)}` after the rebase.
   - Rebase, then re-run Tasks 1–4's test commands and `pnpm --filter @ax/routines build`.
2. **Full gate,** with `DOCKER_HOST` set: run `pnpm build && pnpm lint`, then `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`.
3. **PR body:**
   - **Security note** (`security-checklist`):
     - Sandbox escape: N/A. Nothing changes what the sandbox can reach.
     - Prompt injection: runner text no longer reaches `lastError`, which agents read through `routine_list`/`routine_get`, or the run history people read. The stored text is now bounded too. `DispatchOutcomeSchema.error` (`dispatch.ts:10`) has no cap, and the IPC `reason` is a bare `z.string()`, so before this a hostile runner's reason could be stored whole, up to the 4 MiB IPC body limit. Name the residual (decisions row 4): a runner can choose a ≤64-character `[a-z0-9:-]` token, and it could already spoof host gate codes.
     - Webhook: an unreadable secret-read failure fails closed as `secret`.
     - Supply chain: no new dependency.
   - "No boundary review: no hook signature, payload or `returns` schema changes. Only the stored text of a terminated run changes."
   - **Deploy note:** "At the first deploy that includes this PR, run deploy/GKE.md §4g (dry run, then rewrite) after the host rollout. It is safe on a database the #1118 run already scrubbed: it changes only `terminated:` rows that hold runner text. If the #1118 run was refused by its guard (`old rows that look like a host sentence:` was not 0), this run is refused for the same rows. See the follow-up card."
   - Brief claims checked and refuted: decisions row 1.
4. **Follow-up card for auto-ship,** only if a §4g dry run printed `old rows that look like a host sentence:` above 0 (text ready to paste):
   > **Scrub guard: don't count the known old Postgres and Node messages.**
   > - Add an exact list to `pg_temp.ax_host_sentence` (`packages/routines/sql/scrub-leaked-run-errors.sql`): Postgres's 57P03 messages `the database system is starting up`, `the database system is shutting down`, `the database system is in recovery mode`, `the database system is not yet accepting connections`, and Node's `This operation was aborted`, `The operation was aborted due to timeout`, `This socket has been ended by the other party`. The guard doesn't count these, and the scrub rewrites them like any old text.
   > - Pin them in the psql test: counted as old text, not as host sentences, and rewritten.
   > - Update §4g Step 3's paragraph that names them.
   > - Prefer this to a counted `-v` acknowledgement. §4g prints counts only, so no one can confirm what the N rows are (TASK-1038 decisions row 11).
   > - If the count is still above 0 after this, telling the remaining rows apart without printing them needs its own design.
