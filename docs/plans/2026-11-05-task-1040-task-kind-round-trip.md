# TASK-1040 Implementation Plan: a task's trip through Repeat and back changes nothing

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switching a task to Repeat and back puts back its "Going well when" line and its app-update response time. A pure round trip leaves Save with nothing to send.

**Architecture:**
- One change, in `useRoutineDraft`'s `changeKind` (`packages/channel-web`). It mirrors TASK-1037's `leftRepeat`.
- A new ref, `leftTask`, stashes what a switch from a task kind to Repeat clears: the going-well line, plus the webhook draft as it was before its response time was taken off.
- A switch back to either task kind puts both back.
- No change to TaskForm markup or copy, the contract, the host, any bus hook or any IPC action.

**Tech stack:** TypeScript, React 18 hooks, vitest + @testing-library/react (jsdom).

**Spec:** the card (below), plus the decisions shard `.claude/memory/decisions/2026-11-05-TASK-1040.md`. The predecessor is TASK-1037: Task 2 of `docs/plans/2026-11-04-TASK-1037-plan.md`, and `.claude/memory/decisions/2026-11-04-TASK-1037.md`. Read the shard before you deviate.

> **Card.** In TaskForm, switching a saved task to Repeat and back to a task before saving silently loses two fields:
> - `goodWhen` is cleared;
> - `webhook.respondWithin` is dropped, so the save resets the response time to the 5m default.
>
> **Fix:** make a kind round trip a no-op for the task side too, as #1119 did for Repeat. Otherwise, say so before Save.
>
> **Acceptance:** a TaskForm / use-routine-draft test. Load a task with `goodWhen` and a webhook `respondWithin`, switch to Repeat and back: the draft equals the loaded definition, and no patch is sent.

## What the code does today (verified)

- **Switch to Repeat.** `use-routine-draft.ts:164-167` strips `respondWithin` from `webhookDraft.current`, and `:176` puts that stripped copy in `form.webhook`. Nothing ever puts it back. The same line, `:172`, sets `goodWhen: null`.
- **Switch back to a task kind.** `:172` gives `goodWhen: f.goodWhen ?? ''`, so the line comes back as `''`.
- **What the person sees.** After Stay on top → Repeat → Stay on top on a saved task:
  - "Going well when" is empty. Save is refused ("Say how we’ll know this task is going well.") until the line is retyped.
  - The response time reads 5 min.
  - Once the line is retyped, Save sends a webhook with no `respondWithin`. The host runs that as 5 minutes (`packages/routines/src/task-events.ts:19`).
- **One correction to the card.** Losing the going-well line is visible, not silent: the field is empty and Save is refused. Losing the response time *is* silent; only the chip's wording changes.

## Design calls

- **Put back what the switch cleared, not what was loaded.** The stash is taken at the moment of the switch, as `leftRepeat` is. Putting back `initial` would throw away an edit made as a task before the switch.
- **No "say so before Save" notice, and no new copy.**
  - While it is a Repeat, neither value has a control. TaskForm draws "Going well when" (`TaskForm.tsx:332`) and "React within" (`:449`) only for task kinds. So putting them back never overrides a choice the person made.
  - Both are always put back, so nothing is left to announce.
- **An untouched webhook comes back as the captured object itself.** This is a reference check against the stripped copy, like TASK-1037's `f.schedule === left.filledSchedule`.
  - `changed()` compares with `JSON.stringify` (`use-routine-draft.ts:34`), so a rebuilt copy could read as a change through key order alone.
  - The client doesn't parse the loaded view (`lib/routines.ts:187-192`), so the key order is whatever the host sent.
- **A webhook edited while it was a Repeat keeps the edit and gets its response time back.** More options shows the address name and the event filter for any kind (`TaskForm.tsx:508-513`).
- **App updates turned off while it was a Repeat stay off.** The stash (`webhookDraft`) gets its response time back, so turning updates on again as a task brings it back.
- **Back to either task kind**, a trip through Get done included. This matches TASK-1037, which restores on a return to Repeat from either task kind.
- **Settings is unaffected.** Its `RoutineForm` has no kind control and never calls `changeKind`. Its tests run as a guard (Task 1, Step 5).
- **Out of scope**, logged in the shard:
  - A schedule turned off while it was a Repeat comes back as hourly once it is a task again. That is an explicit edit, and the "How often" chip shows it.
  - A memory setting or quiet word chosen while it was a Repeat. The task rules then apply, and validation says so.

## Global Constraints

- Only these files change:
  - `packages/channel-web/src/components/routines/use-routine-draft.ts`
  - its test, `__tests__/use-routine-draft.test.ts`
  - `packages/channel-web/src/components/workspace/__tests__/TaskForm.test.tsx`
  - the TASK-1040 memory shards
- `TaskForm.tsx` stays as it is. If you do end up touching its markup, invoke the `shadcn` skill first (CLAUDE.md invariant 6).
- Do not edit `packages/routines/**`: sibling cards TASK-1044 and TASK-1041 own it. Do not edit `packages/routines-contract/**` either.
- No new dependency, bus hook, IPC action, contract field or copy. That means no boundary review and no `security-checklist`.
- **Keep the `setForm` updater pure.** Write refs before `setForm`, and read only locals inside it. React may call an updater twice; this is the TASK-1037 patterns rule.
- **See each new test fail before you write the fix.** That is the CLAUDE.md bug-fix policy and the card's acceptance.
- **Fresh worktree?** Run `pnpm install --frozen-lockfile && pnpm build` before the first test run. A wall of `Failed to resolve entry for package "@ax/…"` means the tree isn't built yet, not that the change broke it.
- **Run tests per file:** `pnpm --filter @ax/channel-web exec vitest run <paths>`. Never write `pnpm test --filter`: that runs the whole repo.
- **Type-check:** `pnpm --filter @ax/channel-web exec tsc --build`. channel-web's `tsc` checks its test files too.
- **Lint:** run `pnpm exec eslint <files>` from the worktree root.
- **zsh:** never name a shell variable `path`.

## Review Focus

1. **A webhook edited while it was a Repeat** keeps the edit and gets its response time back. Pinned by Task 1's hook test "keeps an address renamed while it was a Repeat, with its response time".
2. **App updates turned off while it was a Repeat** stay off, and turning them back on as a task brings the response time. Pinned by Task 1's hook test "keeps app updates turned off while it was a Repeat off, and brings the response time back with them".
3. **An edit made as a task before the switch** survives the trip, because the stash is taken at the switch, not from the loaded definition. Pinned by Task 1's hook test "keeps an edit made before the switch".
4. **The Repeat side of the round trip (TASK-1037) is still a no-op**, and a task switched to Repeat still saves a webhook with no response time (Repeat refuses one). Pinned by two existing tests, both run in Task 1 Step 5:
   - `use-routine-draft.test.ts`, describe `a kind switch away from Repeat and back`;
   - `RoutineEditor.methods.test.tsx`, test `keeps the app configuration when switching task kinds and removes task timing for Repeat`.
5. **An untouched round trip puts back the loaded webhook object itself**, so key order can't make the form dirty. Pinned by the `toBe(savedTask.webhook)` assertion in Task 1's first hook test.

---

### Task 1: a switch back from Repeat to a task kind puts back what the switch cleared [tier: integration]

**Files:**
- Modify: `packages/channel-web/src/components/routines/use-routine-draft.ts`
  - a new ref right after `leftRepeat` (`:76-77`)
  - `changeKind` and its JSDoc (`:155-179`)
- Test: `packages/channel-web/src/components/routines/__tests__/use-routine-draft.test.ts`: a new `describe` after the TASK-1037 one, which ends at `:78`.
- Test: `packages/channel-web/src/components/workspace/__tests__/TaskForm.test.tsx`: a new `it` right after TASK-1037's round-trip `it.each`, which ends at `:416`.

**Interfaces:**
- Consumes these existing test helpers:
  - `draft()` and `savedRepeat` (`use-routine-draft.test.ts:41-45`);
  - `edit()`, `task` and `routineApi` (`TaskForm.test.tsx:13`, `:25-31`).
- Produces: no new export. `useRoutineDraft`'s return shape is unchanged.

- [ ] **Step 1: Write the hook tests.** Insert after `:78` of `use-routine-draft.test.ts`:

```ts
// TASK-1040. The task side of the same round trip. A switch from a task kind to Repeat clears the
// going-well line and the response time, which a Repeat can't have; a switch back to a task kind puts
// both back, so the trip changes nothing and Save has nothing to send. A lost response time would have
// saved as the 5-minute default.
describe('a kind switch away from a task kind and back', () => {
  const savedTask: RoutineDefinition = { ...savedRepeat, kind: 'stay-on-top', goodWhen: 'Calm.', silenceToken: null,
    webhook: { kind: 'webhook', path: '/updates', events: ['push'], respondWithin: '10m' } };
  it.each<[string, Array<RoutineDefinition['kind']>]>([
    ['straight back', ['stay-on-top']],
    ['back through the other task kind', ['get-done', 'stay-on-top']],
  ])('puts back the going-well line and the response time (%s)', (_label, route) => {
    const result = draft(savedTask);
    act(() => result.current.changeKind('repeat'));
    expect(result.current.form.goodWhen).toBeNull();
    expect(result.current.form.webhook).not.toHaveProperty('respondWithin');
    for (const kind of route) act(() => result.current.changeKind(kind));
    expect(result.current.form).toStrictEqual(savedTask);
    // The loaded webhook itself, not a rebuilt copy whose key order could read as a change.
    expect(result.current.form.webhook).toBe(savedTask.webhook);
    expect(result.current.dirty).toBe(false);
  });
  it('keeps an edit made before the switch', () => {
    const result = draft(savedTask);
    act(() => result.current.update('goodWhen', 'Calmer.'));
    act(() => result.current.update('webhook', { ...result.current.form.webhook!, respondWithin: '1h' }));
    act(() => result.current.changeKind('repeat'));
    act(() => result.current.changeKind('stay-on-top'));
    expect(result.current.form.goodWhen).toBe('Calmer.');
    expect(result.current.form.webhook?.respondWithin).toBe('1h');
  });
  it('keeps an address renamed while it was a Repeat, with its response time', () => {
    const result = draft(savedTask);
    act(() => result.current.changeKind('repeat'));
    act(() => result.current.update('webhook', { ...result.current.form.webhook!, path: '/renamed' }));
    act(() => result.current.changeKind('stay-on-top'));
    expect(result.current.form.webhook).toStrictEqual({ kind: 'webhook', path: '/renamed', events: ['push'], respondWithin: '10m' });
  });
  it('keeps app updates turned off while it was a Repeat off, and brings the response time back with them', () => {
    const result = draft(savedTask);
    act(() => result.current.changeKind('repeat'));
    act(() => result.current.toggleWebhook(false));
    act(() => result.current.changeKind('stay-on-top'));
    expect(result.current.form.webhook).toBeNull();
    act(() => result.current.toggleWebhook(true));
    expect(result.current.form).toStrictEqual(savedTask);
    expect(result.current.dirty).toBe(false);
  });
});
```

- [ ] **Step 2: Write the TaskForm test.** Insert after `:416` of `TaskForm.test.tsx`, inside `describe('task form More options')` and before `const repeatWithUpdates`. This is the card's acceptance as the person sees it.

```tsx
  // TASK-1040. The task side: a switch from a task kind to Repeat clears "Going well when" and the
  // response time, which a Repeat can't have. Switching back puts both back, so Save has nothing to send.
  it('leaves a task with nothing to save after a switch to Repeat and back', async () => {
    const { onCancel } = await edit({ ...task, webhook: { kind: 'webhook', path: '/updates', respondWithin: '1h' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Repeat' }));
    expect(screen.queryByLabelText('Going well when')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'App updates: On' })).toBeVisible();
    fireEvent.click(screen.getByRole('radio', { name: 'Stay on top' }));
    expect(screen.queryByText(/Switching kinds starts this task over/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Going well when')).toHaveValue('Nothing waits.');
    expect(screen.getByRole('button', { name: 'App updates: On, react within 60 min' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(routineApi.update).not.toHaveBeenCalled();
  });
```

- [ ] **Step 3: Run the new tests and watch them fail.**
  - Run: `pnpm --filter @ax/channel-web exec vitest run src/components/routines/__tests__/use-routine-draft.test.ts src/components/workspace/__tests__/TaskForm.test.tsx`
  - Expected: exactly 6 failures, and every other test passes.
    - 5 hook tests fail: both rows of `puts back the going-well line…` (`goodWhen` is `''`, and the webhook has no `respondWithin`), `keeps an edit made before the switch`, `keeps an address renamed…` and `keeps app updates turned off…`.
    - 1 TaskForm test fails: "Going well when" has the value `''`.
  - Any other failure means the tree is stale or the tests are wrong. Fix that before Step 4.

- [ ] **Step 4: Implement it in `use-routine-draft.ts`.**
  - Add the ref right after `leftRepeat` (`:77`):

```ts
  // TASK-1040. What the last switch from a task kind to Repeat cleared, so a switch back can put it back:
  // the going-well line, and the webhook draft before its response time was taken off (`cleared` is the
  // copy without it, so a switch back can tell whether the webhook was edited while it was a Repeat).
  const leftTask = useRef<{ goodWhen: RoutineDefinition['goodWhen']; webhook: WebhookTrigger; cleared: WebhookTrigger } | null>(null);
```

  - Replace `changeKind` and its JSDoc (`:155-179`) with the code below. The `schedule` and `conversation` lines inside `setForm` are today's, copied unchanged. Only `goodWhen`, `webhook` and the lines before `setForm` change. Note that the stripped copy is now named `cleared`: an inner `webhook` would shadow the new outer `const webhook`.

```ts
  /**
   * A task keeps a schedule and a fresh conversation; Repeat has no response timing or going-well line.
   * Leaving Repeat for a task kind forces a fresh conversation and, when the Repeat had no schedule,
   * fills in an hourly one. Leaving a task kind for Repeat clears the going-well line and the response
   * time. Coming back undoes what leaving did: the schedule only while it is still the one filled in and
   * no active hours need it, and the webhook as it was unless it was edited meanwhile (then the edit gets
   * its response time back). So a switch away and back changes nothing: a changed conversation would
   * cancel a saved Repeat's waiting app updates (TASK-1037), and a lost response time would save as the
   * 5-minute default (TASK-1040).
   */
  function changeKind(value: RoutineDefinition['kind']) {
    const toRepeat = value === 'repeat';
    const back = !toRepeat && form.kind === 'repeat' ? leftTask.current : null;
    if (toRepeat) {
      const { respondWithin: _respondWithin, ...cleared } = webhookDraft.current;
      if (form.kind !== 'repeat') leftTask.current = { goodWhen: form.goodWhen, webhook: webhookDraft.current, cleared };
      webhookDraft.current = cleared;
    } else if (back !== null) {
      const { respondWithin } = back.webhook;
      const now = webhookDraft.current;
      webhookDraft.current = now === back.cleared ? back.webhook
        : respondWithin === undefined ? now : { ...now, respondWithin };
      leftTask.current = null;
    }
    const webhook = webhookDraft.current;
    const left = toRepeat ? leftRepeat.current : null;
    const hourly: RoutineSchedule = { kind: 'interval', every: '1h' };
    if (toRepeat) leftRepeat.current = null;
    else if (form.kind === 'repeat') leftRepeat.current = { conversation: form.conversation, filledSchedule: form.schedule === null ? hourly : null };
    setForm(f => ({ ...f, kind: value, goodWhen: toRepeat ? null : (back?.goodWhen ?? f.goodWhen ?? ''),
      schedule: toRepeat
        ? (left !== null && left.filledSchedule !== null && f.schedule === left.filledSchedule && f.activeHours === null ? null : f.schedule)
        : (f.schedule ?? hourly),
      webhook: f.webhook !== null && (toRepeat || back !== null) ? webhook : f.webhook,
      conversation: toRepeat ? (left?.conversation ?? f.conversation) : 'per-fire' }));
    clearErrors();
  }
```

  - Why the code has this shape:
    - `back` is read only when leaving Repeat, and the stash is written only when leaving a task kind. So a switch between the two task kinds touches neither.
    - Restoring `webhookDraft` (not just `form.webhook`) is what makes the "turned off" case work.
    - `webhookDraft.current === form.webhook` whenever app updates are on. `update` and `toggleWebhook` keep it that way, and every other webhook write goes through them. That is what lets `now === back.cleared` tell "untouched while it was a Repeat" apart from "edited".

- [ ] **Step 5: Run green, Settings' editor included.**
  - Run: `pnpm --filter @ax/channel-web exec vitest run src/components/routines/__tests__/use-routine-draft.test.ts src/components/workspace/__tests__/TaskForm.test.tsx src/components/routines/__tests__/RoutineEditor.test.tsx src/components/routines/__tests__/RoutineEditor.methods.test.tsx`
  - Expected: all pass, including:
    - the three TASK-1037 Repeat round-trip hook tests and both rows of its TaskForm `it.each`;
    - `cancelsWaitingUpdates`' `its kind` row;
    - RoutineEditor's `warns about changing a Done task kind…`;
    - `keeps the app configuration when switching task kinds and removes task timing for Repeat`.
  - Then run `pnpm --filter @ax/channel-web exec tsc --build`. Expected: no errors.
  - Then run `pnpm exec eslint packages/channel-web/src/components/routines/use-routine-draft.ts packages/channel-web/src/components/routines/__tests__/use-routine-draft.test.ts packages/channel-web/src/components/workspace/__tests__/TaskForm.test.tsx`. Expected: no errors.

- [ ] **Step 6: Commit.**

```bash
git add packages/channel-web/src/components/routines/use-routine-draft.ts packages/channel-web/src/components/routines/__tests__/use-routine-draft.test.ts packages/channel-web/src/components/workspace/__tests__/TaskForm.test.tsx
git commit -m "fix(channel-web): a kind switch back from Repeat puts back a task's going-well line and response time (TASK-1040)"
```

- **Mutants worth running** (commit first; restore each with `git checkout HEAD -- <file>`). Each line gives the predicted reds:
  - Drop the reference branch, so the webhook is always rebuilt as `{ ...now, respondWithin }`: both rows of `puts back…` go red (the `toBe` assertion).
  - Drop `|| back !== null` from the `webhook:` line: both rows of `puts back…`, `keeps an edit…`, `keeps an address renamed…`, and the TaskForm test.
  - Stash `initial.goodWhen` instead of `form.goodWhen`: `keeps an edit made before the switch`.
  - Replace the merge with `now`: `keeps an address renamed…`.
  - Skip the `webhookDraft` restore while `form.webhook` is null: `keeps app updates turned off…`.

---

### Task 2: memory says the task side is undone too [tier: mechanical]

**Files:**
- Create: `.claude/memory/patterns/2026-11-05-TASK-1040.md`.

**Interfaces:**
- Consumes: Task 1's behavior, as merged.
- Produces: none.

- [ ] **Step 1: Write the patterns row.** The last sentence of `.claude/memory/patterns/2026-11-04-TASK-1037.md:2` reads "Not undone yet: task → Repeat → task drops `goodWhen` and `respondWithin`." Task 1 makes that false.
  - Don't edit that file. Memory guard R1 forbids deleting any line under `.claude/memory/`, and editing a line counts as deleting it.
  - Write one superseding row in the new shard:

```markdown
- **`changeKind` undoes a kind round trip both ways since TASK-1040; this supersedes the TASK-1037 row's "Not undone yet" sentence.** Leaving a task kind for Repeat stashes the going-well line and the webhook draft with its response time (`leftTask`), and a switch back to either task kind puts them back. While the webhook is untouched it comes back as the captured object (a reference check against the stripped copy): `changed()` diffs by `JSON.stringify` and the client doesn't parse the loaded view, so a rebuilt copy could read as a change by key order alone. An address edited while it was a Repeat keeps the edit and gets the response time back; app updates turned off stay off, with the response time back in the stash. The stash is taken at the switch, so an edit made as a task before it survives. Still not undone, because it is an explicit edit and the chip shows it: a schedule turned off while it was a Repeat comes back hourly.
```

- [ ] **Step 2: Check the memory guard.**
  - Run: `scripts/memory-append-check.sh origin/main`
  - Expected: it passes. Nothing under `.claude/memory/` is deleted, and no root archive is touched.

- [ ] **Step 3: Commit.**

```bash
git add .claude/memory/patterns/2026-11-05-TASK-1040.md
git commit -m "docs(memory): TASK-1040 patterns"
```
