# TASK-939: Today re-reads tasks after an approval, and never says "nothing is waiting" before its first reads land: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an approved routine change goes through, the shell reads the tasks list again, so Today's task blocks and the sidebar badge follow at once. While the queue's read or the first tasks read is still in flight, Today's headline says it is still checking instead of claiming nothing is waiting.

**Architecture:** All of it is in `packages/channel-web`, client side. `useDecisionQueue` gets one more hook option, `onRoutineChangeSucceeded`. It fires once per decision when an answer or a row poll first says `routineOutcome: 'succeeded'`, and the shell passes `taskRead.reload` to it. `tasksForToday` gains `checking` (no tasks read has landed yet). `TodayView` takes it as `tasksChecking`, combines it with the queue's `loading`, and gates its headline and its empty list on the result.

**Tech Stack:** React + TypeScript (the channel-web SPA), Vitest + Testing Library on jsdom, jest-dom matchers.

**Spec:** the card (`[TASK-939]` on the board; its body is quoted in the dispatch); design doc `docs/plans/2026-10-20-agent-tasks-design.md` §3.5 and §15; `.claude/memory/decisions/2026-10-23-TASK-933.md`; this card's decisions, `.claude/memory/decisions/2026-10-26-TASK-939.md`. **Read the TASK-939 shard first.** Its rows 2–4 explain why the re-read is keyed to `routineOutcome: 'succeeded'` and not to "the approval is grouped".

## Global Constraints

- Only `packages/channel-web` and the design doc change. Nothing changes in the server, the wire, the hook bus, the schema or dependencies, and no shadcn component is added.
- Copy, exactly as `TodayView.tsx` already writes it: `Checking what is waiting on you…` (U+2026 ellipsis), `Nothing is waiting on you.`, `We could not check what is waiting on you.`. No new sentences.
- Run one test file with `pnpm --filter @ax/channel-web test <path>`, with no `--`. The `--` form runs the whole package (`.claude/memory/mistakes/2026-10-20-TASK-904.md`). Paths are relative to `packages/channel-web`.
- channel-web type-checks its tests: `tsconfig.json` includes `src`, and `build` is `tsc --build && vite build`. So a prop or type change updates every test call site in the same task. End every task with `pnpm --filter @ax/channel-web exec tsc --build` (exit 0).
- Rows go to the decisions shard `.claude/memory/decisions/2026-10-26-TASK-939.md` (review rounds, deviations). Never edit a root `.claude/memory/*.md` archive or another card's shard.
- Final gate, after Task 5: `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`.

## Review Focus

Each of these is pinned by a test in the task named.

1. **A routine change that failed** (`routineOutcome: 'failed'`) changed nothing, so it must not re-read. Task 3, "never for a routine change that failed".
2. **The same success seen twice.** A poll inside the undo window answers `succeeded` again on every tick, sometimes after an answer that already said so. That must give one re-read, not one per tick. Task 3, "calls it once when a poll first reads success…" and "an answer that says so, then polls that say so again, still call it once".
3. **An approval that is not a routine change (even one under a task), or a dismissal.** Neither changes a task, so neither re-reads. Task 3, "never for a dismissal" and "never for an approval that is not a routine change, even under a task". An Undo the server accepts leaves no outcome. An Undo it refuses because the change already ran carries that success. If no poll has reported it yet, that is a re-read the person is owed, and the once-per-id rule keeps it to one.
4. **A first tasks read that failed, then Try again.** Today keeps saying "We could not check…", never "Checking…". A re-read of a list already read never brings "Checking…" back. Task 1, both new tests.
5. **Something already read while the first tasks read runs.** The count shows (a floor), not "Checking…", and the Working filter still lists working agents. Task 2, "counts what it has already read" and "the Working filter still lists who is working".

Accepted and not tested here: a re-read that moves the answered approval's block later in the list drops focus to `<body>`. This can happen when the change takes the task out of Needs you and another needs-you block follows it. See the TASK-939 shard's "Known, not changed" row. Don't fix it in this card.

## Files

| File | Change | Task |
|---|---|---|
| `src/lib/workspace-tasks.ts` | `tasksForToday` returns `checking` (T1). Header trigger lists gain the routine change (T4). | 1, 4 |
| `src/components/workspace/TodayView.tsx` | `tasksChecking` prop; `checking = loading \|\| tasksChecking` gates the headline, the list line and the empty card | 2 |
| `src/components/workspace/WorkspaceShell.tsx` | Pass `tasksChecking` (T2). Move the tasks read above the queue, pass `onRoutineChangeSucceeded: taskRead.reload`, fix the stale comment (T4). | 2, 4 |
| `src/lib/workspace-decisions.ts` | `DecisionQueueHooks.onRoutineChangeSucceeded`, fired once per id from the answer path and the poll | 3 |
| `docs/plans/2026-10-20-agent-tasks-design.md` | §3.5 note, a new §15 row | 5 |
| `src/lib/__tests__/workspace-tasks.test.ts` | 5 `toEqual`s gain `checking`; 2 new tests | 1 |
| `src/components/workspace/__tests__/TodayView.test.tsx` | `tasksChecking={false}` at 3 render sites; one test extended; one new describe | 2 |
| `src/components/workspace/__tests__/consent-focus.test.tsx` | `tasksChecking={false}` at 2 render sites | 2 |
| `src/components/workspace/__tests__/WorkspaceShell.test.tsx` | 2 new tests in the TASK-933 describe | 2, 4 |
| `src/__tests__/workspace-decision-queue.test.tsx` | Hoist `mountWithHooks`; one new describe | 3 |

All paths below are under `packages/channel-web/` unless they start with `docs/`.

---

### Task 1: `tasksForToday` says when no tasks read has landed yet [tier: mechanical]

**Files:**
- Modify: `src/lib/workspace-tasks.ts:171-198` (`tasksForToday` and its doc)
- Test: `src/lib/__tests__/workspace-tasks.test.ts:393-475` (`describe('tasksForToday (TASK-933)')`)

**Interfaces:**
- Produces: `tasksForToday(state: TasksState): { tasks: TaskRow[]; unavailableAgents: UnavailableAgent[]; error: TasksReadError | null; refreshing: boolean; checking: boolean }`. `checking` is `true` iff `state.kind === 'loading' && state.retryingAfter === null`, else `false`. `loading` with `retryingAfter: null` happens only before any read has settled: `reload` from `loading` keeps `retryingAfter`, and from `failed` it carries the error.

- [ ] **Step 1: Write the failing tests**

In `describe('tasksForToday (TASK-933)')`, add `checking` to the five existing `toEqual` expectations: `checking: true` in "reads the first load as no rows and no error…", and `checking: false` in "keeps reporting the failure a retry is retrying after…" (the first `toEqual`), "gives a ready read its rows and agents…", "keeps the rows of a failed refresh…" and "gives a failed read no rows and its error". Then add:

```ts
it('says it is checking only until the first read lands; a re-read of a list never brings it back (TASK-939)', async () => {
  const first = deferred<TasksResponse>();
  tasksMock.mockReturnValueOnce(first.promise);
  const { result } = renderHook(() => useTasks());
  expect(tasksForToday(result.current.state).checking).toBe(true);

  // A reload during the first read is still the first read.
  const second = deferred<TasksResponse>();
  tasksMock.mockReturnValueOnce(second.promise);
  act(() => result.current.reload());
  expect(tasksForToday(result.current.state).checking).toBe(true);

  act(() => second.resolve(page()));
  await waitFor(() => expect(result.current.state.kind).toBe('ready'));
  expect(tasksForToday(result.current.state).checking).toBe(false);

  tasksMock.mockReturnValueOnce(new Promise<TasksResponse>(() => {}));
  act(() => result.current.reload());
  expect(tasksForToday(result.current.state)).toMatchObject({ refreshing: true, checking: false });
});

it('a retry after a failed first read keeps the failure and is not checking (TASK-939)', async () => {
  tasksMock.mockRejectedValueOnce(new WorkspaceApiError('/tasks', 500));
  const { result } = renderHook(() => useTasks());
  await waitFor(() => expect(result.current.state.kind).toBe('failed'));

  tasksMock.mockReturnValueOnce(new Promise<TasksResponse>(() => {}));
  act(() => result.current.retry());
  expect(tasksForToday(result.current.state)).toMatchObject({ error: 'failed', checking: false });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `pnpm --filter @ax/channel-web test src/lib/__tests__/workspace-tasks.test.ts`
Expected: FAIL. The five `toEqual`s fail on the missing `checking`, and the two new tests fail on `checking` being `undefined`.

- [ ] **Step 3: Add `checking` to `tasksForToday`**

Add `checking: boolean` to the return type and to each `switch` case: `state.retryingAfter === null` for `loading`, `false` for `ready` and `failed`. Extend the doc comment (`:171-178`) with one sentence: `checking` is true until the first read lands (a reload during it included). Until then Today doesn't know whether any task needs the person, so it says it is still checking (TASK-939). A retry after a failure isn't checking: it keeps reporting the failure.

- [ ] **Step 4: Run the tests and see them pass**

Run: `pnpm --filter @ax/channel-web test src/lib/__tests__/workspace-tasks.test.ts`, then `pnpm --filter @ax/channel-web exec tsc --build`
Expected: PASS; tsc exits 0. The field is additive, so no caller breaks.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/lib/workspace-tasks.ts packages/channel-web/src/lib/__tests__/workspace-tasks.test.ts
git commit -m "Agent Tasks: tasksForToday says when no tasks read has landed yet (TASK-939)"
```

---

### Task 2: Today says it's still checking while the queue's read or the first tasks read runs [tier: integration]

**Files:**
- Modify: `src/components/workspace/TodayView.tsx`. Header property 4 (`:21-24`), `Props` (`loading` doc `:126`; new prop after `tasksRefreshing` `:155-156`), the destructuring (`:165-194`), the headline (`:238-250`), the list card's gate (`:528-530`), the empty list line (`:574-594`).
- Modify: `src/components/workspace/WorkspaceShell.tsx:1014-1019` (one prop).
- Test: `src/components/workspace/__tests__/TodayView.test.tsx`. `renderToday` (`:82-104`); the inline `rerender`s at `:692-716` and `:765-789`; "the first read, before it lands" (`:303-308`); a new describe at the end of the file.
- Test: `src/components/workspace/__tests__/consent-focus.test.tsx`, the two `<TodayView` sites (`:818-838`, `:1125-1150`).
- Test: `src/components/workspace/__tests__/WorkspaceShell.test.tsx`, in `describe('tasks on Today, and one count (TASK-933)')` (`:606-835`).

**Interfaces:**
- Consumes: Task 1's `tasksForToday(state).checking`.
- Produces: `TodayView` prop `tasksChecking: boolean`. It is **required**, like every TASK-933 tasks prop, so the shell can't forget it.

Invoke the `shadcn` skill before editing `TodayView.tsx` (CLAUDE.md invariant 6). No component or class changes are expected: the change is which existing sentence the `<h1>` shows and whether the existing card renders. The copy is shipped copy, so `ux-design` isn't needed.

- [ ] **Step 1: Write the failing tests**

(a) Add `tasksChecking={false}` beside `tasksRefreshing={false}` in `renderToday`'s defaults (`TodayView.test.tsx:98`), in both inline `rerender`s (`:710`, `:783`), and at both `consent-focus.test.tsx` sites (`:837`, `:1144`). Without these, `tsc --build` fails once the prop exists.

(b) Add a module-level constant near the top of `TodayView.test.tsx`, beside `CHECK_ICON` (`:39`). It has to be at the top because the describe it's used in comes before `COULD_NOT_CHECK` (`:593`).

```ts
const CHECKING = 'Checking what is waiting on you…';
```

(c) Extend "does not flash the empty-queue claim while it is still checking" (`:304-308`). This is the queue's own first read: before the fix, its headline said "Nothing is waiting on you." over the list's "Checking…". Keep its existing two assertions and add:

```ts
    // TASK-939: the headline says it, once, and the list draws nothing yet.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(CHECKING);
    expect(screen.getAllByText(CHECKING)).toHaveLength(1);
    expect(screen.queryByText('Nothing is waiting on you.')).toBeNull();
    expect(screen.getByRole('group', { name: 'Your queue' })).toBeEmptyDOMElement();
```

(d) Add a describe at the end of `TodayView.test.tsx`:

```ts
describe('while the first tasks read runs (TASK-939)', () => {
  it('says it is still checking, not that nothing is waiting', () => {
    renderToday({ tasksChecking: true });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(CHECKING);
    expect(screen.getAllByText(CHECKING)).toHaveLength(1);
    expect(screen.queryByText('Nothing is waiting on you.')).toBeNull();
    expect(screen.queryByText(/wants your OK on/)).toBeNull();
    expect(screen.getByRole('group', { name: 'Your queue' })).toBeEmptyDOMElement();
  });

  it('counts what it has already read: the count is a floor', () => {
    renderToday({ tasksChecking: true, decisions: [decision()] });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('One thing is waiting on you.');
    expect(screen.queryByText(CHECKING)).toBeNull();
    expect(screen.getByText('Send the reply to Dana?')).toBeInTheDocument();
  });

  it('a grants read that failed outranks a tasks read still running', () => {
    renderToday({ tasksChecking: true, grantsError: 'failed' });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(COULD_NOT_CHECK);
  });

  it('a queue read that failed outranks a tasks read still running', () => {
    renderToday({ tasksChecking: true, error: { kind: 'failed', detail: 'boom' } });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(COULD_NOT_CHECK);
  });

  it('the Working filter still lists who is working', () => {
    renderToday({ tasksChecking: true, filter: 'working', agents: [agent({ state: 'working' })] });
    expect(screen.getByRole('button', { name: /Quill/ })).toBeInTheDocument();
  });
});
```

(e) In `WorkspaceShell.test.tsx`, inside `describe('tasks on Today, and one count (TASK-933)')`, after "reads the tasks once for the badge and Today":

```ts
it('while the first tasks read runs, Today says it is still checking, then counts what lands (TASK-939)', async () => {
  let land!: (page: { tasks: TaskRow[]; unavailableAgents: [] }) => void;
  tasksMock.mockReturnValueOnce(new Promise((res) => (land = res)));

  renderShell();

  expect(await screen.findByText('Checking what is waiting on you…')).toBeTruthy();
  // The queue read has landed, empty: only the tasks read is still out.
  await waitFor(() => expect(decisionsMock).toHaveBeenCalledTimes(1));
  await act(async () => {});
  expect(screen.getByText('Checking what is waiting on you…')).toBeTruthy();
  expect(screen.queryByText('Nothing is waiting on you.')).toBeNull();

  await act(async () => land({ tasks: [taskRow()], unavailableAgents: [] }));
  expect(await screen.findByText('One thing is waiting on you.')).toBeTruthy();
  expect(badge()?.textContent).toBe('1');
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `pnpm --filter @ax/channel-web test src/components/workspace/__tests__/TodayView.test.tsx`, then `pnpm --filter @ax/channel-web test src/components/workspace/__tests__/WorkspaceShell.test.tsx`
Expected: FAIL. In `TodayView`, two tests fail. The extended first-read test fails because the headline says "Nothing is waiting on you." and the region holds the card. "says it is still checking, not that nothing is waiting" fails the same way. The floor, failure-outranks and Working-filter tests already pass: they pin behaviour the change must keep. In the shell, the new test fails at its first `findByText('Checking what is waiting on you…')`. The shell shows "Loading your workspace…" until the board lands, and by then the queue read has usually landed too, so nothing on the page says it's checking while the headline says "Nothing is waiting on you.". Record which tests failed before the fix.

- [ ] **Step 3: Implement in `TodayView.tsx`**

- New prop, documented: `/** The tasks read's first answer hasn't landed (TASK-939): until it does, Today doesn't know whether any task needs the person. */ tasksChecking: boolean;`. Destructure it.
- Correct the `loading` doc (`:126`): it is true while any read of the queue is in flight. On Today that is in practice the first, because the only other read here is Try again, and that keeps its error. It is not the same as empty (TASK-939).
- After `waiting` (`:236`): `const checking = loading || tasksChecking;` and `const nothingListed = open.length === 0 && justResolved.length === 0 && grants.length === 0 && groups.length === 0;` (the condition the list line at `:574-578` already uses; reuse it there).
- Headline order: `!readable || (waiting === 0 && (grantsUnknown || tasksUnknown))` gives `'We could not check what is waiting on you.'`; otherwise `waiting === 0 && checking` gives `'Checking what is waiting on you…'`; otherwise `waiting === 0` gives `'Nothing is waiting on you.'`; otherwise the count, unchanged. Add one paragraph to the headline comment (`:238-244`): a read still in flight is a fourth way not to know. A failure outranks it, and a count stands as a floor over it.
- List card gate (`:528-530`): when `filter === 'needs'` and `readable`, draw the card unless `checking && nothingListed`. Every other branch stays as it is (`filter === 'working'` always draws; an unreadable queue draws only for grants or groups).
- List line (`:574-594`): draw the orientation line (`'When an agent hits something it wants your OK on, it’ll wait for you here.'`) only when `readable && nothingListed && !checking`. Delete the `loading ? 'Checking what is waiting on you…' :` branch, since the headline says it now. Rewrite the comment's second paragraph ("Held back while the FIRST read is still in flight…") to say: while a read is in flight, the headline says it is still checking, and nothing is drawn here (TASK-939).
- Header property 4 (`:21-24`): add one sentence. Nor while a read it depends on is still in flight: until then the headline says it is still checking (TASK-939).

In `WorkspaceShell.tsx`, pass `tasksChecking={tasksOnToday.checking}` beside `tasksRefreshing` (`:1016`).

- [ ] **Step 4: Run the tests and see them pass**

Run each, then the type check:
- `pnpm --filter @ax/channel-web test src/components/workspace/__tests__/TodayView.test.tsx`
- `pnpm --filter @ax/channel-web test src/components/workspace/__tests__/consent-focus.test.tsx`
- `pnpm --filter @ax/channel-web test src/components/workspace/__tests__/WorkspaceShell.test.tsx`
- `pnpm --filter @ax/channel-web test src/components/workspace/__tests__/responsive-shell.test.tsx` (it waits for "Nothing is waiting on you." with `findByText`)
- `pnpm --filter @ax/channel-web exec tsc --build`

Expected: all PASS; tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/components/workspace/TodayView.tsx packages/channel-web/src/components/workspace/WorkspaceShell.tsx packages/channel-web/src/components/workspace/__tests__/TodayView.test.tsx packages/channel-web/src/components/workspace/__tests__/consent-focus.test.tsx packages/channel-web/src/components/workspace/__tests__/WorkspaceShell.test.tsx
git commit -m "Agent Tasks: Today says it is still checking while its first reads run (TASK-939)"
```

---

### Task 3: The decision queue says when an approved routine change has gone through [tier: sensitive]

**Why sensitive:** it adds a call on the queue's answer path and on its race-guarded poll (`applyPolledRow`). The "once per id" rule has to hold across overlapping polls and an answer followed by a poll.

**Files:**
- Modify: `src/lib/workspace-decisions.ts`. The header (`:1-51`, add a paragraph), `DecisionQueueHooks` (`:303-321`), the destructuring (`:324`), `act` (`:447-510`), and the poll's `.then` (`:656-664`).
- Test: `src/__tests__/workspace-decision-queue.test.tsx`. Hoist `mountWithHooks` (`:445-453`) to file scope beside `mountWith` (`:82-87`) and delete the local copy; add a describe after the TASK-574 describe (`:431-520`).

**Interfaces:**
- Produces: `DecisionQueueHooks.onRoutineChangeSucceeded?: (decision: Decision) => void`.
  - It is called at most once per decision id for the life of the hook, with the row as answered or polled, when that row's `routineOutcome === 'succeeded'`.
  - It is called after the row is applied and outside any state updater.
  - It is read through a ref, so the newest function passed is the one called, and a new function identity never restarts the poll.
  - Task 4 passes the shell's `taskRead.reload` to it.

- [ ] **Step 1: Write the failing tests**

Hoist `mountWithHooks(rows, hooks)` unchanged to file scope (after `mountWith`). The TASK-574 describe then uses the hoisted one. Add:

```ts
/*
  TASK-939 — an approved routine change can change the tasks list, so the shell
  reads it again when one goes through. An unattended create, edit or delete is
  replayed inside the approve request, so its answer already says so; a fire-now
  (or an attended approval) says so on a later poll of its row.
*/
describe('useDecisionQueue — onRoutineChangeSucceeded (TASK-939)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-22T12:00:00.000Z'));
    listDecisions.mockReset();
    readDecision.mockReset();
    approveDecision.mockReset();
    dismissDecision.mockReset();
    undoDecision.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A routine edit held during a check-in, still open. */
  const held = () => decisionFixture({ id: 'd-edit', routineOperation: 'routine_update' });

  /** The approve answer around `decision`. */
  const approved = (decision: Decision, executed = false) => ({
    decision,
    executed,
    path: 'host-replays' as const,
    error: null,
    pendingUntil: null,
    streamReqId: null,
  });

  /** The edit, already replayed inside the approve: not undoable, outcome known. */
  const editWentThrough = () =>
    resolvedFixture('executed', {
      id: 'd-edit',
      routineOperation: 'routine_update',
      routineOutcome: 'succeeded',
      undoable: false,
    });

  it('calls it once when the approve answer already says the change went through', async () => {
    const onRoutineChangeSucceeded = vi.fn();
    const { result } = await mountWithHooks([held()], { onRoutineChangeSucceeded });

    approveDecision.mockResolvedValue(approved(editWentThrough(), true));
    act(() => result.current.approve('d-edit'));
    await settle();

    expect(onRoutineChangeSucceeded).toHaveBeenCalledTimes(1);
    expect(onRoutineChangeSucceeded.mock.calls[0]![0]).toMatchObject({ id: 'd-edit', routineOutcome: 'succeeded' });
  });

  it('an answer that says so, then polls that say so again, still call it once', async () => {
    const onRoutineChangeSucceeded = vi.fn();
    const { result } = await mountWithHooks([held()], { onRoutineChangeSucceeded });

    // Still undoable, so the row stays watched and every tick polls it.
    const went = resolvedFixture('executed', {
      id: 'd-edit',
      routineOperation: 'routine_update',
      routineOutcome: 'succeeded',
      undoable: true,
    });
    approveDecision.mockResolvedValue(approved(went, true));
    readDecision.mockResolvedValue({ decision: went });
    act(() => result.current.approve('d-edit'));
    await settle();
    await tick(POLL_MS * 3);

    expect(readDecision.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(onRoutineChangeSucceeded).toHaveBeenCalledTimes(1);
  });

  it('a new function on every render never restarts the poll', async () => {
    const fired = resolvedFixture('executed', {
      id: 'd-fire',
      routineOperation: 'routine_fire_now',
      routineOutcome: null,
      undoable: true,
      pendingUntil: new Date(Date.now() + UNDO_WINDOW_MS).toISOString(),
    });
    listDecisions.mockResolvedValue({ decisions: [fired] });
    readDecision.mockResolvedValue({ decision: fired });
    const { rerender } = renderHook(
      ({ cb }: { cb: (d: Decision) => void }) => useDecisionQueue({ onRoutineChangeSucceeded: cb }),
      { initialProps: { cb: vi.fn() } },
    );
    await settle();

    // A caller passing an inline arrow re-renders with a new one every 500 ms.
    for (let i = 0; i < 4; i++) {
      await tick(POLL_MS / 2);
      rerender({ cb: vi.fn() });
    }

    expect(readDecision.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('calls it once when a poll first reads success, and not while the outcome is pending', async () => {
    const onRoutineChangeSucceeded = vi.fn();
    const fired = resolvedFixture('executed', {
      id: 'd-fire',
      routineOperation: 'routine_fire_now',
      routineOutcome: null,
      undoable: true,
      pendingUntil: new Date(Date.now() + UNDO_WINDOW_MS).toISOString(),
    });
    await mountWithHooks([fired], { onRoutineChangeSucceeded });

    readDecision.mockResolvedValue({ decision: fired });
    await tick(POLL_MS);
    expect(readDecision).toHaveBeenCalled();
    expect(onRoutineChangeSucceeded).not.toHaveBeenCalled();

    // Still inside its undo window, so every tick polls it again and reads success again.
    readDecision.mockResolvedValue({ decision: { ...fired, routineOutcome: 'succeeded' } });
    const before = readDecision.mock.calls.length;
    await tick(POLL_MS * 3);
    expect(readDecision.mock.calls.length - before).toBeGreaterThanOrEqual(2);
    expect(onRoutineChangeSucceeded).toHaveBeenCalledTimes(1);
  });

  it('never for a routine change that failed', async () => {
    const onRoutineChangeSucceeded = vi.fn();
    const { result } = await mountWithHooks([held()], { onRoutineChangeSucceeded });

    approveDecision.mockResolvedValue(
      approved(resolvedFixture('executed', { id: 'd-edit', routineOperation: 'routine_update', routineOutcome: 'failed', undoable: false })),
    );
    act(() => result.current.approve('d-edit'));
    await settle();
    await tick(POLL_MS * 2);

    expect(onRoutineChangeSucceeded).not.toHaveBeenCalled();
  });

  it('never for a dismissal', async () => {
    const onRoutineChangeSucceeded = vi.fn();
    const { result } = await mountWithHooks([held()], { onRoutineChangeSucceeded });

    const dismissed = resolvedFixture('dismissed', { id: 'd-edit', routineOperation: 'routine_update' });
    dismissDecision.mockResolvedValue({ decision: dismissed });
    readDecision.mockResolvedValue({ decision: dismissed });
    act(() => result.current.dismiss('d-edit'));
    await settle();
    await tick(POLL_MS * 2);

    expect(onRoutineChangeSucceeded).not.toHaveBeenCalled();
  });

  it('never for an approval that is not a routine change, even under a task', async () => {
    const onRoutineChangeSucceeded = vi.fn();
    const mail = decisionFixture({ id: 'd-mail', checkIn: { routineId: 't1', taskName: 'Zero open support tickets' } });
    const { result } = await mountWithHooks([mail], { onRoutineChangeSucceeded });

    const parked = resolvedFixture('approved-pending-agent', { id: 'd-mail' });
    approveDecision.mockResolvedValue({ ...approved(parked), path: null });
    readDecision.mockResolvedValue({ decision: parked });
    act(() => result.current.approve('d-mail'));
    await settle();
    await tick(POLL_MS * 2);

    expect(onRoutineChangeSucceeded).not.toHaveBeenCalled();
  });

  it('calls the function from the latest render', async () => {
    const first = vi.fn();
    const second = vi.fn();
    listDecisions.mockResolvedValue({ decisions: [held()] });
    const { result, rerender } = renderHook(
      ({ cb }: { cb: (d: Decision) => void }) => useDecisionQueue({ onRoutineChangeSucceeded: cb }),
      { initialProps: { cb: first } },
    );
    await settle();
    rerender({ cb: second });

    approveDecision.mockResolvedValue(approved(editWentThrough(), true));
    act(() => result.current.approve('d-edit'));
    await settle();

    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});
```

Any test that leaves a row watched mocks `readDecision` first. A row is watched while it's inside its undo window, or while it's a routine change with no outcome yet. The poll reads a watched row through `readDecision`, and an unmocked one returns `undefined`, which throws inside the interval. The tests whose answers are `undoable: false` and carry an outcome leave nothing watched: the first one, "never for a routine change that failed", and "calls the function from the latest render".

- [ ] **Step 2: Run the tests and see them fail**

Run: `pnpm --filter @ax/channel-web test src/__tests__/workspace-decision-queue.test.tsx`
Expected: FAIL in four tests, because the hook never calls the option:
- "calls it once when the approve answer…"
- "an answer that says so, then polls that say so again…"
- "calls it once when a poll first reads success…"
- "calls the function from the latest render"

These pass before the fix:
- The three "never" tests. They pin the rule against a later "re-read on every answer".
- "a new function on every render never restarts the poll". It guards the ref: put the callback in the poll effect's dependencies instead, and the interval restarts every 500 ms, so it never polls.

The TASK-574 describe still passes on the hoisted `mountWithHooks`. `tsc` would also reject the unknown option, so run the type check in Step 4.

- [ ] **Step 3: Implement in `workspace-decisions.ts`**

- `DecisionQueueHooks` gains `onRoutineChangeSucceeded?: (decision: Decision) => void;` with a doc comment saying:
  - TASK-939: it fires once per decision, when an answer or a poll of its row first says its approved routine change succeeded (`routineOutcome: 'succeeded'`): a task was started, edited or deleted, or a check-in was started.
  - An unattended create, edit or delete is replayed inside the approve request, so the approve answer already says so. So is an unattended standing (`agent-routines`) approval whose consent was delivered in that request. A fire-now, an attended approval, or a standing one whose consent is still pending says so on a later poll.
  - A failed change, a dismissal, an Undo the server accepted and any other approval never fire it: none of them changes a task. An Undo refused because the change already ran carries its success and may fire it, once.
  - The shell reads the tasks list again when it fires.
- In `useDecisionQueue`:
  - **Placement:** declare the ref, the Set and `noteRoutineChange` before `applyServerRow` (`:407`), for example right after `appliedAtRead` (`:345`). `act`'s dependency list (`:509`) reads `noteRoutineChange` during render. If you declare it beside `decisionsRef` (`:610`), it is used before its `const` declaration: `tsc` fails with TS2448 and every render throws.
  - Destructure it.
  - Keep it in a ref written during render, like `decisionsRef` (`const routineSucceededRef = useRef(onRoutineChangeSucceeded); routineSucceededRef.current = onRoutineChangeSucceeded;`).
  - Keep a `useRef(new Set<string>())` of the ids already reported.
  - Add a stable `noteRoutineChange = useCallback((row: Decision) => { … }, [])`. It returns unless `row.routineOutcome === 'succeeded'` and the id isn't in the set; otherwise it adds the id and calls `routineSucceededRef.current?.(row)`.
- Call `noteRoutineChange(decision)` in `act`, right after `report?.(raw, decision)` (inside the `try`, after the `isRecord` guard). This covers the approve, dismiss and undo answers.
- Call `noteRoutineChange(out.decision)` in the poll's `.then`, right after `applyPolledRow(out.decision)`.
- Add `noteRoutineChange` to `act`'s and the poll effect's dependency lists. It is stable, so neither re-subscribes.
- Header (`:1-51`): add one short paragraph after the TASK-933 one. It says that an approved routine change is announced once (TASK-939), from whichever answer or poll first carries its success, so the shell can read the tasks list again; and that the set of reported ids lasts as long as the queue, one id per change.

- [ ] **Step 4: Run the tests and see them pass**

Run: `pnpm --filter @ax/channel-web test src/__tests__/workspace-decision-queue.test.tsx`, then `pnpm --filter @ax/channel-web exec tsc --build`
Expected: PASS (the whole file, existing describes included); tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/lib/workspace-decisions.ts packages/channel-web/src/__tests__/workspace-decision-queue.test.tsx
git commit -m "Agent Tasks: the decision queue says when an approved routine change went through (TASK-939)"
```

---

### Task 4: The shell reads the tasks again when an approved routine change goes through [tier: integration]

**Files:**
- Modify: `src/components/workspace/WorkspaceShell.tsx`. Move the tasks-read block (the comment at `:376-392` through the route-kind effect ending `:424`) to just above the queue's comment (`:355`). Pass the new option in `useDecisionQueue({...})` (`:372-375`), and edit both comments.
- Modify: `src/lib/workspace-tasks.ts:5-9` and `:14-18` (header comments only).
- Test: `src/components/workspace/__tests__/WorkspaceShell.test.tsx`, in `describe('tasks on Today, and one count (TASK-933)')`.

**Interfaces:**
- Consumes: Task 3's `DecisionQueueHooks.onRoutineChangeSucceeded`; `useTasks().reload` (`workspace-tasks.ts:150-161`).

- [ ] **Step 1: Write the failing test**

Import `resolvedFixture` beside `decisionFixture` (`WorkspaceShell.test.tsx:18`). In the TASK-933 describe's `beforeEach`, add `vi.mocked(workspaceApi.approveDecision).mockReset();`. Then add:

```ts
it('approving a routine change held in a task’s check-in reads the tasks again, so the block and the badge follow (TASK-939)', async () => {
  decisionsMock.mockResolvedValue({
    decisions: [
      decisionFixture({
        id: 'd1',
        agentId: 'a-quill',
        routineOperation: 'routine_update',
        checkIn: { routineId: 't1', taskName: 'Zero open support tickets' },
      }),
    ],
  });
  // Before: the task needs you. After the edit went through: it changed the
  // task's kind, which clears its report (TASK-956's warning), so it no longer does.
  tasksMock
    .mockResolvedValueOnce({ tasks: [taskRow()], unavailableAgents: [] })
    .mockResolvedValueOnce({
      tasks: [taskRow({ kind: 'get-done', steps: { done: 0, total: 0 }, task: null })],
      unavailableAgents: [],
    });
  // An unattended routine edit is replayed inside the approve, so its answer
  // already says it went through, and there is nothing left to undo.
  vi.mocked(workspaceApi.approveDecision).mockResolvedValue({
    decision: resolvedFixture('executed', {
      id: 'd1',
      agentId: 'a-quill',
      routineOperation: 'routine_update',
      routineOutcome: 'succeeded',
      undoable: false,
    }),
    executed: true,
    path: 'host-replays',
    error: null,
    pendingUntil: null,
    streamReqId: null,
  });

  renderShell();

  expect(await screen.findByText('Two things are waiting on you.')).toBeTruthy();
  expect(tasksMock).toHaveBeenCalledTimes(1);
  const block = screen.getByRole('group', { name: /Zero open support tickets/ });
  fireEvent.click(within(block).getByRole('button', { name: /Move your 1:1/ }));
  fireEvent.click(await within(block).findByRole('button', { name: 'Move it' }));

  await waitFor(() => expect(tasksMock).toHaveBeenCalledTimes(2));
  expect(await screen.findByText('Nothing is waiting on you.')).toBeTruthy();
  expect(badge()).toBeNull();
});
```

The answer is `undoable: false` with the outcome already in it, which is how the host answers an unattended routine change. So no row poll starts, and this file's `workspaceApi` mock needs no `decision`.

- [ ] **Step 2: Run the test and see it fail**

Run: `pnpm --filter @ax/channel-web test src/components/workspace/__tests__/WorkspaceShell.test.tsx`
Expected: FAIL. `tasksMock` stays at 1 call, and the headline stays "One thing is waiting on you.".

- [ ] **Step 3: Implement in `WorkspaceShell.tsx`**

- Move the tasks-read block above the queue: its comment, `const taskRead = useTasks();`, `tasksOnToday`, `retryTaskRead`, `reloadTaskRead`, `previousRouteKind`, `sawTaskWrites`, `routeKind` and the route-kind `useEffect`. The block is otherwise unchanged. The queue's options refer to `taskRead`, and a `const` has to be declared before it is used. Hooks keep a fixed order across renders, so the move is safe.
- Add `onRoutineChangeSucceeded: taskRead.reload,` to the `useDecisionQueue` options, after `onDecisionUndone`.
- Tasks-read comment, the old `:376-392`:
  - In the trigger list, add after the Duplicate clause: "and when an approved routine change goes through, wherever it was approved (TASK-939: the queue's `onRoutineChangeSucceeded`; an unattended create, edit or delete goes through inside the approval, a run-now about ten seconds later)".
  - Replace the closing sentence ("This is best-effort: an approved routine change lands after its undo window, so a read can still predate it."), which is false for unattended changes. The replacement says what still isn't announced: an agent's own routine change under Always Allow, and the report a check-in writes later. Entering Today or Tasks, and Try again, are the way to those.
- Queue comment (`:355-371`): add one sentence. When an approved routine change goes through, the queue says so (`onRoutineChangeSucceeded`) and the tasks list is read again (TASK-939).
- `workspace-tasks.ts`:
  - The header's first trigger list (`:7-9`) gains "when an approved routine change goes through (TASK-939)".
  - The `reload` list (`:14-18`) gains the same clause, since a read in flight may predate the change.

- [ ] **Step 4: Run the tests and see them pass**

Run each, then the whole package and the type check:
- `pnpm --filter @ax/channel-web test src/components/workspace/__tests__/WorkspaceShell.test.tsx`
- `pnpm --filter @ax/channel-web test src/components/workspace/__tests__/WorkspaceShellRouting.test.tsx` (the tasks-read call counts after the hook move)
- `pnpm --filter @ax/channel-web test src/components/workspace/__tests__/WorkspaceShellApproveContinuation.test.tsx` (approves through the shell)
- `pnpm --filter @ax/channel-web test`
- `pnpm --filter @ax/channel-web exec tsc --build`

Expected: all PASS; tsc exits 0. channel-web's Docker-backed files need `DOCKER_HOST` (CLAUDE.md). If Docker hangs, name the files you skipped in the handoff.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/components/workspace/WorkspaceShell.tsx packages/channel-web/src/lib/workspace-tasks.ts packages/channel-web/src/components/workspace/__tests__/WorkspaceShell.test.tsx
git commit -m "Agent Tasks: Today re-reads tasks when an approved routine change goes through (TASK-939)"
```

---

### Task 5: Design doc: the re-read after an approval and the first-read headline [tier: mechanical]

**Files:**
- Modify: `docs/plans/2026-10-20-agent-tasks-design.md`. §3.5: a new note after the TASK-956 note (`:310`). §15: a new row after the last row (`:1059`). §15 rows are append-only: leave the 2026-10-23 TASK-933 row as it is.

- [ ] **Step 1: Add the §3.5 note**

```markdown
> TASK-939: Today reads the list again as soon as an approval's routine change has gone through, wherever it was approved (Today, a chat or a check-in page), so a task's block and the badge follow. An unattended change goes through inside the approval, a run-now about ten seconds later. Approving anything else changes no task until its next check-in reports. Until the first reads of the queue and the tasks land, the headline says "Checking what is waiting on you…" instead of claiming nothing is waiting.
```

- [ ] **Step 2: Append the §15 row**

```markdown
| 2026-10-26 | Decided | Today reads the tasks list again when an approved routine change goes through (in the approval's answer for an unattended create, edit or delete; on the queue's poll for a run-now or an attended approval), wherever it was approved. Other approvals, dismissals and Undo don't, since no task changes until its next check-in. While the queue's read or the first tasks read is in flight, Today's headline says "Checking what is waiting on you…" rather than that nothing is waiting; a count already read still shows (TASK-939). |
```

- [ ] **Step 3: Check, then commit**

Run: `git diff --stat docs/plans/2026-10-20-agent-tasks-design.md`
Expected: 3 insertions (a blank line and the note in §3.5, the row in §15), 0 deletions. A deletion means an existing line or row was edited; restore it.

```bash
git add docs/plans/2026-10-20-agent-tasks-design.md
git commit -m "docs(agent-tasks): Today's re-read after an approval and its first-read headline (TASK-939)"
```

---

## After the last task

- Run the final gate in Global Constraints. In the PR:
  - Say no boundary review is needed. `DecisionQueueHooks` is a React hook option, not a bus hook, and no wire field changes.
  - Say `security-checklist` doesn't apply: the change is client-only, re-reads a route the shell already reads, and draws no new untrusted text.
- Append review-round rows to `.claude/memory/decisions/2026-10-26-TASK-939.md`, never to an archive.
- Hand-off notes for TASK-940 and TASK-959 (they wait on this card) are in the shard's "Reuse" row. `taskRead.reload` is the shell's one "a write landed, read again" entry point.
