# TASK-941 Fire-now asks and copy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The agent stops telling people to "enable Always Allow for routine_fire_now" (a setting that doesn't exist), a fire-now's approval card says what Allow once does, and a routine approval reads as waiting, not failing, during its undo window and until its outcome lands. Findings 4 and 5 of the TASK-934 walk (`deploy/kind/walks/2026-10-23-TASK-934/RESULTS.md`).

**Architecture:** Five small tasks in four packages plus the design doc. Model-facing words change in three places, because a check-in never reads its held call's note (Premises, Refuted (a)): the `routine_fire_now` and `routine_delete` tool descriptions (`@ax/routines-contract`), the system prompt's `routineNote()` (`@ax/agent-runner-core`), and the hold note (`@ax/decisions`, for conversations that go on). Person-facing words change in two: the fire-now card body (`@ax/decisions`, written onto the row at hold time) and `decisionOutcome`'s routine branch (`@ax/channel-web`, shared by the Today row, the in-thread card and the screen-reader announcement). No hook signature or payload change, no migration, no new component.

**Tech Stack:** TypeScript, vitest, React Testing Library (channel-web, jsdom).

**Spec:** the TASK-941 card; walk findings 4 and 5; `docs/plans/2026-10-20-agent-tasks-design.md`. Decisions behind this plan: `.claude/memory/decisions/2026-10-26-TASK-941.md` (rows cited as "row N").

## Premises, checked against b02df4118

**True.**
- `holdNote` (`packages/decisions/src/templates.ts:457-471`) never mentions Always Allow. It is called at `packages/decisions/src/pre-call.ts:209` (an approved routine call re-sent before its release) and `:351` (every new or reused hold).
- `routines.delete` and `routines.fire-now` carry no `routineConsent` (`packages/tool-policy/src/rules.ts:422-428`), so consent never relaxes them; `eligibleRoutineConsent` admits only `routine_create` and `routine_update` (`packages/decisions/src/routine-authorization.ts:42-44`). A brief-touching create or update never relaxes either (`touchesTaskBrief`, checked at `packages/tool-policy/src/plugin.ts:703`).
- The descriptions already said "Requires Allow once approval; Always Allow does not cover firing/deletion" (`packages/routines-contract/src/tools.ts:323-324`). The agent asked for Always Allow anyway.
- A fire-now's card body is the shared "Review the proposed routine change before allowing it." (`templates.ts:211-216`).
- During a fire-now's undo window the row is `executed`, `pendingUntil` is the future `replayDueAt` (`packages/channel-web/src/server/routes-workspace.ts:3015`; set at `packages/decisions/src/plugin.ts:725-734`) and `undoable` is true. `decisionOutcome`'s routine branch (`packages/channel-web/src/components/workspace/decision-copy.ts:368-375`) runs before the switch's `isAboutToHappen` check (`:380-385`), so it says "The approved routine operation has not completed." beside "Undo · 3s" (walk screenshot `05c-approved-stays-in-group-undo.png`).

**Refuted.**
- (a) "Make the held-call result say it … then check a check-in's report stops suggesting it" assumes the agent reads the held call's result before it reports. It doesn't. Both runners end the turn at a hold (`packages/agent-claude-sdk-runner/src/pre-tool-use.ts:119-141`, `continue: false`; `packages/agent-aisdk-runner/src/tools/policy-wrap.ts:175-185`, the `stopWhen` latch). A task check-in is one turn in a per-fire conversation nothing continues, and an unattended approval runs on the host without telling the agent. In the walk's transcript (`05e-checkin-transcript-held-during.png`) the held fire-now row precedes the report row in the same step: the report and its ask were written alongside the held call. So what a check-in says about approvals comes from its tool descriptions and system prompt (Tasks 1 and 2). The hold note (Task 3) still matters, and the card's acceptance names it: the model reads it on a later turn of a conversation that goes on (the person replies in chat; a repeat routine with a shared conversation runs again). Row 2.
- (b) "Give fire-now its own headline": it has one. "Wants to run a routine now" comes only from `routine_fire_now` (`templates.ts:192-199`, `:219-224`). Only the body was shared, so only the body changes. Row 6.

**Refined.**
- The undo-window bug is the routine branch's, not fire-now's: an attended create, edit or delete in chat (`pendingUntil` = `deliveryDueAt`) reads "has not completed" during its window too. Task 4's fix is generic.
- The renderers of these strings: `DecisionRow` (Today), `ApprovalCard` (agent chat and a check-in's See what it did page), `ConsentAnnouncement` (screen reader) and `thread-find` all read `decisionOutcome`; both cards draw `d.summary` / `d.detail` from the row. No other producer writes a routine row's detail or a hold note (`git grep` of `Review the`, `decisionText(`, `holdNote(` in `packages/decisions/src`).
- Baseline at b02df4118 (pure suites, measured): decisions `templates.test.ts` + `pre-call.test.ts` 74 passed; routines-contract `definition.test.ts` 414; agent-runner-core `prompt-engine.test.ts` 37; channel-web `decision-renderers.test.tsx` + `workspace-decision-queue.test.tsx` + `ApprovalCard.test.tsx` 80.

## The words (exact)

| Where | Reader | Text |
|---|---|---|
| `ROUTINE_ALWAYS_ASKS_SENTENCE`, `templates.ts` (new) | model, in the hold note | `This call needs that approval every time. Always Allow does not cover it and no setting changes that, so do not suggest turning on Always Allow or any other setting for it.` |
| `ROUTINE_FIRE_NOW_DETAIL`, `templates.ts` (new) | person, fire-now card body | `If you allow it, the routine runs once, right now. Its schedule and instructions stay as they are.` |
| fire-now summary (unchanged) | person | `Wants to run a routine now` |
| `routine_fire_now` description (rewritten) | model | `Fire an enabled routine now using its current expectedRevision. Reuse requestId for retries. Firing always asks the person, even with Always Allow. No setting changes that, so never suggest turning on Always Allow or any other setting for it. Confirmation acknowledges dispatch acceptance; final execution status appears in history.` |
| `routine_delete` description (rewritten) | model | `Delete an authored routine using its current expectedRevision. Deleting always asks the person, even with Always Allow. No setting changes that, so never suggest turning on Always Allow or any other setting for it. Defaults use separate default controls. Reuse requestId for retries.` |
| `routineNote()`, new sentence | model, system prompt | `Deleting a routine or firing one now always asks the person too. Always Allow never covers any of these, so never suggest turning it on for them.` |
| in the undo window (existing `DECISION_GOING_OUT` / `_NOTE`) | person, row and card | `You said yes — it is about to go ahead.` / `Nothing has happened yet. Undo stops it before it runs. Once it has run, we cannot take it back.` |
| `DECISION_ROUTINE_UNDERWAY` / `_NOTE`, `decision-copy.ts` (new) | person, after the window, before the outcome | `You said yes — it is going ahead now.` / `We’ll update this when it’s done.` |
| outcome lines (unchanged) | person | `The routine run was accepted.` (fire-now), `The approved routine operation completed.`, `The approved routine operation failed.` |

The full fire-now hold note, word for word:

```
Held for approval. Running routine_fire_now would run a routine now, and that needs a person's approval. This call needs that approval every time. Always Allow does not cover it and no setting changes that, so do not suggest turning on Always Allow or any other setting for it. The call has been recorded exactly as you made it and is waiting for the user. Do not retry it and do not look for another way to do the same thing. Tell the user what you were about to do and why, then end your turn.
```

The person-facing copy went through the `ux-design` framework in planning (row 6): the old body was misleading (a fire-now changes nothing), the in-window line read as a failure, and the after-window line would have dropped back to the failure wording after a reassuring one. Model-facing sentences are prohibitions: every sentence that names Always Allow says it does not, or never, cover the call.

## Global Constraints

- Base: origin/main b02df4118 or later. No migration, no service-hook signature or payload change, so no boundary review.
- `templates.ts` never reads `call.input`. `alwaysAsks` is a closed boolean computed in `pre-call.ts` by `routineConsentNeverCovers`, like `routineTask` and `routineSetsKind`.
- The sentence appears only on holds Always Allow can never lift (fire-now, delete, task create, brief change). Never on a repeat-routine create or a non-brief edit: there Always Allow is a real option.
- Copy is exact. New person-facing strings use U+2014 (`—`, with a space each side, as `DECISION_GOING_OUT` does) and U+2019 (`’`), both already in `decision-copy.ts`. Model-facing strings stay ASCII, as `holdNote`'s are. Type the characters, never a backslash-u escape. After each task run this scan over the lines you added; it must print `[]`:

  ```bash
  git diff -U0 origin/main -- <paths> | python3 -I -c "import sys;ok={0xa7,0xb1,0xb7,0x2014,0x2019,0x201c,0x201d,0x2026};t=sys.stdin.buffer.read().decode('utf-8');print(sorted({hex(ord(c)) for l in t.splitlines() if l.startswith('+') and not l.startswith('+++') for c in l if ord(c)>126 and ord(c) not in ok}))"
  ```
- `@typescript-eslint/no-unused-vars` is an error in test files too: import only what the tests use.
- One file: `pnpm --filter <pkg> exec vitest run <path>`. `pnpm --filter <pkg> test -- <file>` runs the whole package.
- `@ax/routines-contract` reaches its dependents through `dist/`: after Task 1, run `pnpm --filter @ax/routines-contract build`.
- channel-web's `tsc --build` type-checks its tests (it is the exception: most packages exclude tests). Run it after Task 4.
- Every test file this plan touches is pure (no Docker). The final gate also runs decisions' and routines' container suites: they need `DOCKER_HOST` (locally `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock`; check `timeout 15 docker info` first).
- Commit this plan and `.claude/memory/decisions/2026-10-26-TASK-941.md` before `pnpm test:scripts`: its cited-paths guard fails on a shard citing an untracked file.
- Task order: 1, 2, 3, 4, 5. Task 4's renderer test imports Task 3's `ROUTINE_FIRE_NOW_DETAIL`; the others are independent.

## Review Focus

1. The hold note's sentence appears for exactly the four kinds of call Always Allow never lifts, and never for one it could (Task 3's table test has both sides).
2. No model-facing text invites turning on Always Allow. Every sentence naming it negates it (Tasks 1-3 assert this per sentence).
3. A routine approval inside its undo window reads `DECISION_GOING_OUT` and offers Undo on both renderers; a recorded outcome still beats the clock.
4. The after-window line claims nothing unobserved: "going ahead", never "done" or "started". The queue does re-read the row until it settles (`needsRoutineRead`, `packages/channel-web/src/lib/workspace-decisions.ts:162-164`), which is what "We’ll update this" promises.
5. A fire-now's body is true for a repeat routine and for a task alike: a manual fire leaves the schedule alone, and a check-in never edits its brief.

## Security

`security-checklist` is not required (row 12). No sandbox, IPC schema, plugin loading, dependency, path, process or network change. Every new sentence is a host-written constant; the one input-derived value is a closed boolean from `touchesTaskBrief` (which catches its own errors), chosen outside `templates.ts`, so no model text reaches a note or a row. Say so in the PR description.

---

### Task 1: The fire-now and delete descriptions say no setting skips the question [tier: mechanical]

**Files:**
- Modify: `packages/routines-contract/src/tools.ts:323-324`
- Test: `packages/routines-contract/src/__tests__/definition.test.ts` (one new describe at the end; `RoutineToolDescriptions` is already imported at `:11`)

- [ ] **Step 1: Write the failing test.** Append:

```ts
describe('firing and deleting always ask, and the agent never offers a setting (TASK-941)', () => {
  it.each([
    ['routine_fire_now', 'Firing always asks the person, even with Always Allow.'],
    ['routine_delete', 'Deleting always asks the person, even with Always Allow.'],
  ] as const)('%s', (name, asks) => {
    const words = RoutineToolDescriptions[name];
    expect(words).toContain(asks);
    expect(words).toContain('No setting changes that, so never suggest turning on Always Allow or any other setting for it.');
    // The clause the TASK-934 walk's agent read past is replaced, not kept beside the new words.
    expect(words).not.toContain('Always Allow does not cover');
    expect(words).not.toContain('Requires Allow once approval');
    // Every sentence that names Always Allow forbids; none invites.
    expect(words).not.toMatch(/\b(enable|turn on|switch on)\s+Always Allow\b/i);
    for (const sentence of words.split(/(?<=\.)\s+/)) {
      if (sentence.includes('Always Allow')) expect(sentence).toMatch(/\b(even with|never|not)\b/);
    }
  });
});
```

- [ ] **Step 2: Run it.** `pnpm --filter @ax/routines-contract exec vitest run src/__tests__/definition.test.ts`. Expect 2 failures (the first `toContain`; on the old text the `not.toContain` lines fail too).

- [ ] **Step 3: Implement.** Replace the two entries of `RoutineToolDescriptions` with exactly:

```ts
  routine_delete: 'Delete an authored routine using its current expectedRevision. Deleting always asks the person, even with Always Allow. No setting changes that, so never suggest turning on Always Allow or any other setting for it. Defaults use separate default controls. Reuse requestId for retries.',
  routine_fire_now: 'Fire an enabled routine now using its current expectedRevision. Reuse requestId for retries. Firing always asks the person, even with Always Allow. No setting changes that, so never suggest turning on Always Allow or any other setting for it. Confirmation acknowledges dispatch acceptance; final execution status appears in history.',
```

- [ ] **Step 4: Run it again, then build.** Same command: all pass (414 + 2). Then `pnpm --filter @ax/routines-contract build`.

- [ ] **Step 5: Commit.** `fix(routines-contract): fire-now and delete say no setting skips their question (TASK-941)`

---

### Task 2: The system prompt names delete and fire-now as always asking [tier: mechanical]

**Files:**
- Modify: `packages/agent-runner-core/src/system-prompt.ts:443-448` (`routineNote`)
- Test: `packages/agent-runner-core/src/__tests__/prompt-engine.test.ts:518-529` (the `routine guidance` test)

- [ ] **Step 1: Write the failing assertions.** In `adds fixed guidance only in normal mode when the catalog includes routine tools`, right after `expect(normal).toContain('Creating a task (kind "stay-on-top" or "get-done")');`, add:

```ts
    // TASK-941: delete and fire-now ask every time, and the agent never offers Always Allow for them.
    expect(normal).toContain('Deleting a routine or firing one now always asks the person too.');
    expect(normal).toContain('Always Allow never covers any of these, so never suggest turning it on for them.');
    expect(normal).not.toMatch(/\b(enable|turn on|switch on)\s+Always Allow\b/i);
```

- [ ] **Step 2: Run it.** `pnpm --filter @ax/agent-runner-core exec vitest run src/__tests__/prompt-engine.test.ts`. Expect 1 failing test.

- [ ] **Step 3: Implement.** `routineNote()` becomes exactly (one new literal before the last):

```ts
export function routineNote(): string {
  return 'Use the routine tools to schedule unattended work with interval, cron, or webhook triggers. ' +
    'Use routine_list/routine_get to read current definitions and routine_get before editing. ' +
    `Creates and edits require approval unless the person enabled Always Allow for this agent. Creating a task (kind "stay-on-top" or "get-done"), or changing any routine's name, promptBody, goodWhen or kind, always asks the person. ` +
    'Deleting a routine or firing one now always asks the person too. Always Allow never covers any of these, so never suggest turning it on for them. ' +
    'Report success only after the tool confirms it. Do not create routine files.';
}
```

- [ ] **Step 4: Run it again.** All 37 pass. `pnpm --filter @ax/agent-runner-core build`.

- [ ] **Step 5: Commit.** `fix(agent-runner-core): the routine note says delete and fire-now always ask (TASK-941)`

---

### Task 3: The held-call note and the fire-now card body [tier: integration]

**Files:**
- Modify: `packages/decisions/src/templates.ts` (header `:11-13`; two constants after `ROUTINE_KIND_CHANGE_SENTENCE`, `:179-180`; `decisionText`'s `review`, `:211-216`; `holdNote`'s doc `:433-456` and body `:457-471`)
- Modify: `packages/decisions/src/routine-authorization.ts` (import `:11-15`; new export after `eligibleRoutineConsent`, `:42-44`)
- Modify: `packages/decisions/src/pre-call.ts` (import `:2`; after `:175`; `:209`; `:351`)
- Test: `packages/decisions/src/__tests__/templates.test.ts`
- Test: `packages/decisions/src/__tests__/pre-call.test.ts`

**Interfaces (Task 4 uses the first):**
- `templates.ts` exports `ROUTINE_FIRE_NOW_DETAIL: string` and `ROUTINE_ALWAYS_ASKS_SENTENCE: string`; `holdNote(input: { capability: string | null; toolName: string; alwaysAsks?: boolean | undefined }): string`.
- `routine-authorization.ts` exports `routineConsentNeverCovers(call: { name: string; input: unknown }): boolean`.

- [ ] **Step 1: Write the failing templates tests.** Add `ROUTINE_ALWAYS_ASKS_SENTENCE` and `ROUTINE_FIRE_NOW_DETAIL` to the import from `'../templates.js'`, then add:

```ts
describe('a fire-now says what Allow once does (TASK-941)', () => {
  it('uses the decided words and keeps its own headline', () => {
    expect(ROUTINE_FIRE_NOW_DETAIL).toBe(
      'If you allow it, the routine runs once, right now. Its schedule and instructions stay as they are.',
    );
    const text = decisionText({ capability: 'run a routine now', toolName: 'routine_fire_now' });
    expect(text.summary).toBe('Wants to run a routine now');
    expect(text.detail).toBe(ROUTINE_FIRE_NOW_DETAIL);
  });

  it('leaves the other routine tools as they were', () => {
    for (const toolName of ['routine_create', 'routine_delete']) {
      expect(decisionText({ capability: null, toolName }).detail).toBe(
        'Review the proposed routine change before allowing it.',
      );
    }
  });
});

describe('a hold Always Allow can never lift says so (TASK-941)', () => {
  const FIRE = { capability: 'run a routine now', toolName: 'routine_fire_now' };

  it('uses the decided words', () => {
    expect(ROUTINE_ALWAYS_ASKS_SENTENCE).toBe(
      'This call needs that approval every time. Always Allow does not cover it and no setting changes that, ' +
        'so do not suggest turning on Always Allow or any other setting for it.',
    );
  });

  it('a fire-now hold note, word for word', () => {
    expect(holdNote({ ...FIRE, alwaysAsks: true })).toBe(
      "Held for approval. Running routine_fire_now would run a routine now, and that needs a person's approval. " +
        'This call needs that approval every time. Always Allow does not cover it and no setting changes that, ' +
        'so do not suggest turning on Always Allow or any other setting for it. ' +
        'The call has been recorded exactly as you made it and is waiting for the user. ' +
        'Do not retry it and do not look for another way to do the same thing. ' +
        'Tell the user what you were about to do and why, then end your turn.',
    );
  });

  it('never invites turning Always Allow on', () => {
    const note = holdNote({ ...FIRE, alwaysAsks: true });
    expect(note).not.toMatch(/\b(enable|turn on|switch on)\s+Always Allow\b/i);
    for (const sentence of note.split(/(?<=\.)\s+/)) {
      if (sentence.includes('Always Allow')) expect(sentence).toMatch(/\b(not|never)\b/);
    }
  });

  it('says nothing about Always Allow unless told the hold can never lift', () => {
    for (const alwaysAsks of [undefined, false]) {
      expect(holdNote({ ...FIRE, alwaysAsks })).not.toContain('Always Allow');
    }
  });
});
```

Also add `holdNote({ capability: CAP, toolName: 'routine_fire_now', alwaysAsks: true })` to the `outputs` array of `drives every exported string producer and constant` (`:313-327`), so the decision-id guard covers the new branch.

- [ ] **Step 2: Write the failing gate tests.** In `pre-call.test.ts`, add `ROUTINE_ALWAYS_ASKS_SENTENCE` and `ROUTINE_FIRE_NOW_DETAIL` to the `'../templates.js'` import (`:16`) and append:

```ts
describe('tool:pre-call subscriber — a hold Always Allow can never lift (TASK-941)', () => {
  const FIRE_NOW: PolicyAnswer = {
    verdict: 'hold',
    ruleId: 'routines.fire-now',
    capability: 'run a routine now',
    irreversible: true,
  };
  const ROUTINE_HOLD: PolicyAnswer = { verdict: 'hold', ruleId: 'routines.update', capability: 'edit routines' };
  const mutation = (name: string, extra: Record<string, unknown> = {}): ToolCall => ({
    id: `c-${name}`,
    name,
    input: { requestId: `r-${name}`, routineId: 'rtn_a', expectedRevision: 'rev_a', ...extra },
  });
  const create = (definition: Record<string, unknown>): ToolCall => ({
    id: 'c-create',
    name: 'routine_create',
    input: { requestId: 'r-create', definition },
  });
  const REPEAT = { name: 'Daily', promptBody: 'Do work', trigger: { kind: 'interval', every: '1m' } };
  const TASK = {
    name: 'Zero open tickets',
    promptBody: 'Keep the queue empty.',
    kind: 'stay-on-top',
    goodWhen: 'No ticket open longer than an hour.',
    trigger: { kind: 'interval', every: '15m' },
  };

  /** A routine write is held only for someone who may manage the agent's routines. */
  function managing(): HookBus {
    const bus = new HookBus();
    bus.registerService('agents:can-manage-routines', 'agents', async () => ({ allowed: true }));
    return bus;
  }

  async function held(call: ToolCall, answer: PolicyAnswer, store: FakeStore = createFakeStore()) {
    const { sub } = build(answer, store, async () => 'unattended', managing());
    const r = await sub(ctx(), call);
    expect(isHold(r)).toBe(true);
    return (r as { hold: { decisionId: string; note: string } }).hold;
  }

  it('a held fire-now tells the agent no setting lifts it, and its card says what Allow once does', async () => {
    const store = createFakeStore();
    const { decisionId, note } = await held(mutation('routine_fire_now'), FIRE_NOW, store);
    expect(note).toContain(ROUTINE_ALWAYS_ASKS_SENTENCE);
    expect((await store.get(decisionId))!.detail).toBe(ROUTINE_FIRE_NOW_DETAIL);
  });

  it.each([
    ['a delete', mutation('routine_delete'), true],
    ['a task created', create(TASK), true],
    ["a change to a routine's instructions", mutation('routine_update', { patch: { promptBody: 'New words.' } }), true],
    ['a repeat routine created', create(REPEAT), false],
    ["a change to a routine's description", mutation('routine_update', { patch: { description: 'New words.' } }), false],
  ] as const)('%s', async (_label, call, says) => {
    // true: Always Allow never lifts it. false: it could, so the note must not say otherwise.
    const { note } = await held(call, ROUTINE_HOLD);
    expect(note.includes(ROUTINE_ALWAYS_ASKS_SENTENCE)).toBe(says);
  });

  it('says it again when the agent re-sends an approved fire-now before its release', async () => {
    const store = createFakeStore();
    const call = mutation('routine_fire_now');
    const { decisionId } = await held(call, FIRE_NOW, store);
    const later = new Date(NOW.getTime() + 10_000).toISOString();
    await store.claimForApproval(decisionId, {
      nowIso: NOW.toISOString(),
      status: 'executed',
      replayDueAt: later,
      approvalScope: 'once',
      routineReleaseAt: later,
    });
    // pre-call.ts:200-211: an approved routine call whose release is still ahead holds again.
    const again = await held(call, FIRE_NOW, store);
    expect(again.decisionId).toBe(decisionId);
    expect(again.note).toContain(ROUTINE_ALWAYS_ASKS_SENTENCE);
  });
});
```

- [ ] **Step 3: Run them.** `pnpm --filter @ax/decisions exec vitest run src/__tests__/templates.test.ts src/__tests__/pre-call.test.ts`. Expect red: the two constants don't exist yet, and the old note and old fire-now body don't match. Once Steps 4-6 land, the `false` rows and "says nothing about Always Allow unless told" are the guards against over-applying the sentence (they would pass on the old code too); every other new assertion fails on it.

- [ ] **Step 4: Implement `templates.ts`.**
  1. After `ROUTINE_KIND_CHANGE_SENTENCE` (`:179-180`) add:

     ```ts
     /**
      * TASK-941 — a fire-now's review line. Allow once runs the routine one time, now, outside its
      * schedule, and changes nothing about it, so the routine-change line the other routine tools
      * use was false here. True for a repeat routine and a task alike: a manual fire leaves the
      * schedule alone, and a check-in never edits its brief.
      */
     export const ROUTINE_FIRE_NOW_DETAIL =
       'If you allow it, the routine runs once, right now. Its schedule and instructions stay as they are.';

     /**
      * TASK-941 — what the model is told about a hold Always Allow can never lift: firing a routine
      * now, deleting one, creating a task or changing a routine's brief (`routineConsentNeverCovers`).
      * The TASK-934 walk's agent asked people to "enable Always Allow for routine_fire_now", a setting
      * that doesn't exist. Worded as a prohibition, never as an option.
      */
     export const ROUTINE_ALWAYS_ASKS_SENTENCE =
       'This call needs that approval every time. Always Allow does not cover it and no setting changes that, ' +
       'so do not suggest turning on Always Allow or any other setting for it.';
     ```
  2. `decisionText`'s `review` gains the fire-now branch before the fallback:

     ```ts
         const review =
           task === 'start'
             ? 'Review the task before allowing it.'
             : task === 'change'
               ? 'Review the change to this task before allowing it.'
               : input.toolName === 'routine_fire_now'
                 ? ROUTINE_FIRE_NOW_DETAIL
                 : 'Review the proposed routine change before allowing it.';
     ```
  3. `holdNote` takes `alwaysAsks` and inserts the sentence right after `what`:

     ```ts
     export function holdNote(input: {
       capability: string | null;
       toolName: string;
       /** TASK-941 — true when Always Allow can never lift this hold (`routineConsentNeverCovers`). A closed boolean, never input text. */
       alwaysAsks?: boolean | undefined;
     }): string {
       // …`capability`, `tool` and `what` exactly as today…
       return (
         `Held for approval. ${what} ` +
         (input.alwaysAsks === true ? `${ROUTINE_ALWAYS_ASKS_SENTENCE} ` : '') +
         `The call has been recorded exactly as you made it and is waiting for the user. ` +
         `Do not retry it and do not look for another way to do the same thing. ` +
         `Tell the user what you were about to do and why, then end your turn.`
       );
     }
     ```
  4. Rule 5, the doc that made the card look true. Replace the doc's first line, "The sentence the MODEL reads when its call is held.", with:

     ```
      * The sentence the MODEL reads about a call it held — on a LATER turn of the same
      * conversation, never in the turn the hold ended. Both runners end that turn at the hold
      * (the claude-sdk runner's `continue: false`, the aisdk runner's `stopWhen` latch), so the
      * model reads this when the conversation goes on: the person replies in chat, or a repeat
      * routine with a shared conversation runs again. A task check-in is one turn in a
      * conversation nothing continues, so its agent never reads this note: what its report says
      * about approvals comes from its tool descriptions and system prompt (TASK-941).
     ```
     Keep the rest of the doc.
  5. The header's parenthesis (`:11-13`) becomes: "(`routineTask`, `routineSetsKind` and `holdNote`'s `alwaysAsks` are the three input-derived values. Each is closed -- `'start' | 'change' | null` and two booleans -- and each is derived from the parsed call outside this file, by `@ax/routines-contract` helpers (`alwaysAsks` through `routineConsentNeverCovers`), never from input text.)"

- [ ] **Step 5: Implement `routine-authorization.ts`.** Add `touchesTaskBrief` to the `@ax/routines-contract` import, and after `eligibleRoutineConsent`:

```ts
/**
 * TASK-941 — a routine write Always Allow can never lift: delete, fire now, and a create or
 * update that `touchesTaskBrief` marks. The same two facts tool-policy relaxes on, read here
 * only to word the hold note (`holdNote`'s `alwaysAsks`). Never an authority. Never throws:
 * `touchesTaskBrief` catches its own errors and answers true.
 */
export function routineConsentNeverCovers(call: { name: string; input: unknown }): boolean {
  return (
    routineToolKind(call.name) === 'write' &&
    (!eligibleRoutineConsent(call.name) || touchesTaskBrief(call))
  );
}
```

- [ ] **Step 6: Wire it in `pre-call.ts`.** Import it with `checkedRoutineCall` (`:2`). Right after `const routine = routineToolKind(call.name) === 'write';` (`:175`) add `const alwaysAsks = routineConsentNeverCovers(call);`. Pass `alwaysAsks` to both `holdNote` calls: `:209` becomes `note: holdNote({ capability: routineAnswer?.capability ?? null, toolName: call.name, alwaysAsks }),` and `:351` becomes `const note = holdNote({ capability: answer.capability, toolName: call.name, alwaysAsks });`.

- [ ] **Step 7: Run again, then type-check.** Step 3's command: all pass. `pnpm --filter @ax/decisions build`.

- [ ] **Step 8: Commit.** `fix(decisions): a hold Always Allow can't lift says so, and a fire-now's card says what Allow once does (TASK-941)`

---

### Task 4: A routine approval reads as waiting, not failing [tier: mechanical]

Depends on Task 3 (one test imports `ROUTINE_FIRE_NOW_DETAIL`).

**Files:**
- Modify: `packages/channel-web/src/components/workspace/decision-copy.ts` (two constants after `DECISION_GOING_OUT_NOTE`, `:148-150`; `isAboutToHappen`'s doc `:333-340`; the routine branch, `:368-375`)
- Test: `packages/channel-web/src/__tests__/workspace-decision-queue.test.tsx` (imports `:29-33`; `routine scope after the grace window`, `:523-553`)
- Test: `packages/channel-web/src/components/workspace/__tests__/decision-renderers.test.tsx` (imports `:26-32` and `:53`; one new describe)

- [ ] **Step 1: Update the queue tests.** Add `DECISION_GOING_OUT`, `DECISION_GOING_OUT_NOTE`, `DECISION_ROUTINE_UNDERWAY` and `DECISION_ROUTINE_UNDERWAY_NOTE` to the `@/components/workspace/decision-copy` import. In `retains and polls an Allow once unknown outcome after grace until %s` (`:525-528`), replace

```ts
    expect(decisionOutcome(pending)?.line).toBe('The approved routine operation has not completed.');
```
with
```ts
    expect(decisionOutcome(pending)?.line).toBe(DECISION_ROUTINE_UNDERWAY);
    expect(decisionOutcome(pending)?.note).toBe(DECISION_ROUTINE_UNDERWAY_NOTE);
```
and add a test to the same describe:

```ts
  it('reads a routine approval in its undo window as about to go ahead; a recorded outcome beats the clock (TASK-941)', () => {
    const waiting = resolvedFixture('executed', {
      routineOperation: 'routine_fire_now', approvalScope: 'once', consentDeliveryState: 'none',
      routineOutcome: null, irreversible: true, pendingUntil: new Date(Date.now() + 9_000).toISOString(),
    });
    expect(decisionOutcome(waiting)).toEqual({ line: DECISION_GOING_OUT, note: DECISION_GOING_OUT_NOTE, tone: 'quiet' });
    expect(decisionOutcome({ ...waiting, routineOutcome: 'succeeded' })).toEqual({ line: 'The routine run was accepted.', note: null, tone: 'done' });
    expect(decisionOutcome({ ...waiting, pendingUntil: new Date(Date.now() - 1_000).toISOString() })).toEqual({
      line: DECISION_ROUTINE_UNDERWAY, note: DECISION_ROUTINE_UNDERWAY_NOTE, tone: 'quiet',
    });
  });
```

- [ ] **Step 2: Write the renderer tests.** In `decision-renderers.test.tsx` add `DECISION_GOING_OUT_NOTE`, `DECISION_ROUTINE_UNDERWAY` and `DECISION_ROUTINE_UNDERWAY_NOTE` to the `../decision-copy` import and `ROUTINE_FIRE_NOW_DETAIL` to the `../../../../../decisions/src/templates.js` import (`:53`), then add:

```tsx
describe('a fire-now, before and while it waits (TASK-941)', () => {
  const words = decisionText({ capability: 'run a routine now', toolName: 'routine_fire_now' });
  const fireNow = (over: Partial<Decision> = {}): Decision =>
    decisionFixture({
      routineOperation: 'routine_fire_now', irreversible: true, freshness: null,
      summary: words.summary, detail: words.detail, primaryLabel: words.primaryLabel,
      secondaryLabel: words.secondaryLabel, ghostLabel: words.ghostLabel,
      approvedText: words.approvedText, dismissedText: words.dismissedText,
      ...over,
    });
  const answered = (over: Partial<Decision>): Decision =>
    fireNow({
      status: 'executed', resolvedAt: new Date().toISOString(), undoable: true,
      approvalScope: 'once', consentDeliveryState: 'none', routineOutcome: null, ...over,
    });

  it('asks in its own words, in both places', () => {
    for (const text of [queueText(fireNow()), cardText(fireNow())]) {
      expect(text).toContain('Wants to run a routine now');
      expect(text).toContain(ROUTINE_FIRE_NOW_DETAIL);
      expect(text).not.toContain('Review the proposed routine change');
    }
  });

  it('in its undo window, says it is about to go ahead and offers Undo, in both places', () => {
    const waiting = answered({ pendingUntil: new Date(Date.now() + 9_000).toISOString() });
    for (const text of [queueText(waiting), cardText(waiting)]) {
      expect(text).toContain(DECISION_GOING_OUT);
      expect(text).toContain(DECISION_GOING_OUT_NOTE);
      expect(text).toMatch(/Undo/);
      expect(text).not.toContain('has not completed');
      expect(text).not.toContain('checking its outcome');
      expect(text).not.toContain(words.approvedText);
    }
  });

  it('after the window and before its outcome, says it is going ahead, in both places', () => {
    const going = answered({
      resolvedAt: new Date(Date.now() - 11_000).toISOString(),
      pendingUntil: new Date(Date.now() - 1_000).toISOString(),
      undoable: false,
    });
    for (const text of [queueText(going), cardText(going)]) {
      expect(text).toContain(DECISION_ROUTINE_UNDERWAY);
      expect(text).toContain(DECISION_ROUTINE_UNDERWAY_NOTE);
      expect(text).not.toContain(DECISION_GOING_OUT);
      expect(text).not.toContain('has not completed');
    }
  });

  it('turns from about to go ahead into going ahead on its own clock', () => {
    vi.useFakeTimers();
    try {
      const waiting = answered({ pendingUntil: new Date(Date.now() + 10_000).toISOString() });
      const { container } = render(
        <DecisionRow
          decision={waiting}
          agent={agent}
          expanded={false}
          onToggle={vi.fn()}
          onOpenAgent={vi.fn()}
          onApprove={vi.fn()}
          onDismiss={vi.fn()}
          onUndo={vi.fn()}
        />,
      );
      expect(container.textContent).toContain(DECISION_GOING_OUT);
      act(() => {
        vi.advanceTimersByTime(11_000);
      });
      expect(container.textContent).toContain(DECISION_ROUTINE_UNDERWAY);
      expect(container.textContent).not.toContain(DECISION_GOING_OUT);
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 3: Run them.** `pnpm --filter @ax/channel-web exec vitest run src/__tests__/workspace-decision-queue.test.tsx src/components/workspace/__tests__/decision-renderers.test.tsx`. Expect failures: on the old code the in-window rows read "The approved routine operation has not completed." and the new constants don't exist. ("asks in its own words" passes already, since Task 3 landed: it pins that the row shows the new body.)

- [ ] **Step 4: Implement.** After `DECISION_GOING_OUT_NOTE` add:

```ts
/**
 * TASK-941. A routine operation someone approved whose undo window has closed but whose
 * outcome hasn't come back: the host is running the call, or has told the agent to. It is
 * waiting, so it says so, in the going-ahead words above. Never "done": nobody has seen the
 * outcome. The queue keeps re-reading such a row until it lands (`needsRoutineRead`), which
 * is what "We’ll update this" promises. Only the routine branch of `decisionOutcome` reads it.
 */
export const DECISION_ROUTINE_UNDERWAY = 'You said yes — it is going ahead now.';
export const DECISION_ROUTINE_UNDERWAY_NOTE = 'We’ll update this when it’s done.';
```

The routine branch becomes:

```ts
  if (isRoutineDecision(d) && (d.status === 'executed' || d.status === 'approved-pending-agent')) {
    if (d.routineOutcome === 'succeeded') return {
      line: d.routineOperation === 'routine_fire_now' ? 'The routine run was accepted.' : 'The approved routine operation completed.',
      note: null, tone: 'done',
    };
    if (d.routineOutcome === 'failed') return { line: 'The approved routine operation failed.', note: null, tone: 'bad' };
    // TASK-941. In its undo window nothing has run, as for any other approval. A recorded
    // outcome above still wins: it was observed, and the clock is only a forecast.
    if (isAboutToHappen(d, now)) return { line: DECISION_GOING_OUT, note: DECISION_GOING_OUT_NOTE, tone: 'quiet' };
    return { line: DECISION_ROUTINE_UNDERWAY, note: DECISION_ROUTINE_UNDERWAY_NOTE, tone: 'quiet' };
  }
```

`isAboutToHappen`'s doc (`:333-340`): replace "an irreversible call the host deferred until the undo window closes" with "a call whose host replay, or hand-over to the agent (TASK-574), waits for the undo window to close, routine operations included (TASK-941)".

- [ ] **Step 5: Run again, then type-check.** Step 3's command: all pass. Then `pnpm --filter @ax/channel-web exec vitest run src/components/workspace/__tests__/ApprovalCard.test.tsx src/components/workspace/__tests__/consent-announce.test.tsx` (unchanged behaviour on the consent branch), and `pnpm --filter @ax/channel-web exec tsc --build` (it type-checks tests).

- [ ] **Step 6: Commit.** `fix(channel-web): a routine approval reads as waiting during and after its undo window (TASK-941)`

---

### Task 5: The design doc (rule 5) [tier: mechanical]

**Files:**
- Modify: `docs/plans/2026-10-20-agent-tasks-design.md:376-379` (§4.1 step 3)
- Modify: `docs/plans/2026-10-20-agent-tasks-design.md` (§15, a new last row after `:1059`)

- [ ] **Step 1: §4.1 step 3.** It describes a per-tool Always Allow, the very belief the walk's agent acted on. Replace the step with:

```
3. **The agent works** with its usual tools and connectors. Sending, paying and
   other outward actions wait for a person's OK unless the person has already
   allowed them, so the brief tells the agent to treat every outward action as
   final (TASK-908). A held call ends the check-in's turn, so the agent never
   reads that call's note: what it can tell the person about approvals comes
   from its tool descriptions and system prompt, which say that running a
   routine now, deleting one and a task's brief always ask, even with Always
   Allow (TASK-941).
```

- [ ] **Step 2: §15 row.** Append:

```
| 2026-10-26 | Decided | Running a routine now, deleting one and a task's brief always ask, even with Always Allow, and the agent is told so where it reads before acting: its tool descriptions and system prompt, and the note on a held call. A fire-now's approval card says what Allow once does. A routine approval reads as waiting, not failing, during its undo window and until its outcome lands (TASK-941). |
```

- [ ] **Step 3: Commit.** `docs(agent-tasks): Always Allow isn't per tool, and a check-in never reads a held call's note (TASK-941)`

---

## Final gate

- [ ] Escape scan (Global Constraints) over every added line: prints `[]`.
- [ ] Plan and decisions shard committed (the cited-paths guard).
- [ ] `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`. The recursive run alone is one of three suites; `--no-bail` keeps a Docker teardown timeout in `@ax/auth-better` from hiding later packages.

## Follow-ups (not in this PR; put them in the PR description)

1. **A held call in a task check-in turns the check-in into a miss.** The hold ends the turn, so a report the agent meant to send after it never goes and the run counts as `no-report` (`packages/routines/src/store.ts:619`). `routine_fire_now` is always held, so a task whose instructions fire a routine reaches Needs you after 3 such check-ins and auto-pauses after 5, unless the model sends its report in the same step, as the walk's did. The brief asks for the report "as the last thing you do" (`packages/routines/src/brief.ts:83`), the order that loses it. Needs a product call (row 13).
2. **Name the routine on a fire-now card.** Today the card shows only an opaque `routineId` in the raw request. Naming it needs a fenced label lookup, and a repeat routine's name is agent-writable under Always Allow, so it's a trust-boundary change of its own (row 6).
3. **Walk check.** The next Agent Tasks walk on kind: a fresh task that fires a routine at each check-in (not "Ping relay", whose saved notes re-teach the old ask). Its report's ask should not mention Always Allow; its approval row should read "You said yes — it is about to go ahead." with Undo, then "You said yes — it is going ahead now.", then "The routine run was accepted." (row 9).
