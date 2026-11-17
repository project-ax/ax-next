# TASK-1136: One speaker rule for `memory_note` and the observer; no assistant self-narration facts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In a shared (channel) turn, `memory_note` and the idle observer decide by one function and reach the same outcome for a work fact, and the observer stops storing the agent's narration of its own memory operations and tool failures.

**Architecture:** All in `@ax/memory`. `audience.ts` gains `breaksSpeakerRule(audience, about)`, which the observer's `toStatements`, the `memory_note` tool and `recordFacts` all call, pinned by a cross-path contract test. `memory_note`'s person refusal in a shared turn tells the agent to save a work fact with the work as `about`. TASK-612's `isAgentContextSelfReport` learns three more pattern families. No hook, payload, IPC, schema or dependency change.

**Tech Stack:** TypeScript, vitest, the better-sqlite3 memory harness (`packages/memory/src/__tests__/harness.ts`).

**Spec:** card TASK-1136 (walk `deploy/kind/walks/2026-11-16-TASK-1134/REPORT.md`, findings 3 and 4); `docs/plans/2026-11-09-channel-slack-design.md` §2a; prior decisions `.claude/memory/decisions/2026-11-12-TASK-1091.md` (speaker rule) and `2026-09-27-TASK-612.md` (self-report filter). Planner decisions, with the alternatives: `.claude/memory/decisions/2026-11-17-TASK-1136.md`. Read it first. Tasks 1 and 3 append their security-checklist rows there.

## The premise, checked

The card says the two paths "must apply the same rule". They already do. `observer.ts:749`, `note-tool.ts:228` and `audience.ts:161,175` all come down to "the audience isn't private AND `isPersonSubject(subject)`", and `plugin.ts:1804` feeds the observer `audienceOf(ctx)`. What differed in the walk was the **subject**:

- `memory_note`'s descriptor tells the model to write `user`, so the note was refused.
- The extractor named the speaker `vinay` from the Slack sender label in the user turn. `isPersonSubject` deliberately doesn't match a name: design §2a lists "the extractor may name the speaker from the sender label" as an accepted gap.

Probed on the built dist: `isPersonSubject('vinay') === false`, and `isAgentContextSelfReport` flags no `assistant | could_not_save_memory | …` row.

So the rule stays as it is, and we converge in the design's direction. §2a keeps facts about the work in a shared turn, and "Team standup moved to 10:15 on Tuesdays" is a process fact. The note path should land it, not dead-end and tell the channel it couldn't.

## Global Constraints

- Don't touch `packages/memory/src/extraction-prompt.ts`. It's fingerprint-pinned (`e7466bf4` / `06414f62`).
- No change to a hook signature, hook payload, IPC action, schema, migration or dependency, so no boundary review. Touch nothing outside `@ax/memory`, the design doc and `.changeset/`.
- Regexes over model output use bounded quantifiers only. Predicate patterns are `^`-anchored. Text patterns run over the existing 1,000-character `MAX_SCANNED_CHARS` slice.
- Refusal text is a fixed string that never echoes `about`, `relation` or `value`.
- Commands: `pnpm --filter @ax/memory exec vitest run src/__tests__/<file>.test.ts` for one file, `pnpm --filter @ax/memory test` for the package (the filter goes BEFORE the script). `tsc` doesn't type-check tests here, so also run `pnpm --filter @ax/memory build`. Full gate before the PR: `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts && pnpm lint`.
- Memory rows go only to `.claude/memory/decisions/2026-11-17-TASK-1136.md`, appended. Never edit a root archive or delete a memory line.
- The changeset follows the CLAUDE.md voice. In GitHub text, `@ax/memory` goes inside backticks.

## Review Focus

1. **The agent retries a work note in a conversation memory may not learn from** (an outsider's thread, or the remember switch is off). The retry must hit `memory:pre-capture` and save nothing. Pinned in Task 2 by `the retried work note still honours memory:pre-capture`.
2. **A subject that names the speaker (`vinay`) in a shared turn.** Both paths keep it, alike (design §2a's gap). Pinned in Task 1: the contract table includes `vinay`.
3. **An audience this build doesn't know (`'public'`).** All three paths refuse a person subject. Pinned in Task 1 by unit and contract rows.
4. **A huge, repetitive, untrusted predicate or object.** It stays fast. Pinned in Task 3 by the timing test.
5. **A person's own failure, or assistant content that mentions memory or saving** (`user | could_not_attend`, "how to save data to memory on an Arduino"). Both are kept. Pinned in Task 3 by the keep table.

## Files

| File | Change | Task |
|---|---|---|
| `packages/memory/src/audience.ts` | `breaksSpeakerRule`; `recordFacts` uses it; comments | 1, 4 |
| `packages/memory/src/observer.ts` | `toStatements` uses it (`:6`, `:747-752`); comments | 1, 3, 4 |
| `packages/memory/src/note-tool.ts` | uses it (`:11`, `:228`); `PERSON_IN_SHARED_MESSAGE` exported (1), new text (2) | 1, 2 |
| `packages/memory/src/self-report.ts` | three new pattern families; a header section | 3 |
| `packages/memory/src/__tests__/audience.test.ts` | rule table; cross-path contract test; comment `:488` | 1, 4 |
| `packages/memory/src/__tests__/note-tool.test.ts` | two pinned texts; two new tests | 2 |
| `packages/memory/src/__tests__/self-report.test.ts` | narration flag/keep tables; timing | 3 |
| `packages/memory/src/__tests__/observer.test.ts` | the walk's batch, end to end | 3 |
| `packages/memory/src/{subject,owner,plugin}.ts` | comments only | 3, 4 |
| `docs/plans/2026-11-09-channel-slack-design.md` | §2a, two bullets (`:141-145`) | 4 |
| `.changeset/memory-shared-speaker-rule.md` | new, `'@ax/memory': patch` | 4 |

Order: 1 → 2 → 3 → 4. Task 3 doesn't depend on 1 or 2. Task 4 goes last because it edits comments in files the others touch.

---

### Task 1: One speaker rule, called by every write path `[tier: sensitive]`

**security-checklist: required.** This is the shared-memory privacy and integrity filter on all three write paths.

**Files:**
- Modify: `packages/memory/src/audience.ts:1` (import `type AgentContextAudience`), after `:122` (new function), `:160-161`, `:171-184`
- Modify: `packages/memory/src/observer.ts:6`, `:747-752`
- Modify: `packages/memory/src/note-tool.ts:11`, `:89` (add `export` only; Task 2 changes the text), `:228`
- Test: `packages/memory/src/__tests__/audience.test.ts`, two new `describe`s after `isPersonSubject — …` (`:667`)

**Interfaces (produces):** `export function breaksSpeakerRule(audience: AgentContextAudience, about: string): boolean` in `audience.ts`, and `export const PERSON_IN_SHARED_MESSAGE: string` in `note-tool.ts`.

- [ ] **Step 1: Write the failing tests.** Imports: `breaksSpeakerRule`, `toStatements` from `../observer.js`, `PERSON_IN_SHARED_MESSAGE` and `type MemoryNoteResult` from `../note-tool.js`, `audienceOf` and `PluginError` from `@ax/core`.

```ts
describe('breaksSpeakerRule — the one speaker rule (TASK-1136)', () => {
  it.each(PERSON_SUBJECTS)('%j breaks it in a shared or unknown audience, never in a private one', (about) => {
    expect(breaksSpeakerRule('shared', about)).toBe(true);
    expect(breaksSpeakerRule('public' as AgentContextAudience, about)).toBe(true);
    expect(breaksSpeakerRule('private', about)).toBe(false);
  });
  it.each([...NOT_PERSON_SUBJECTS, 'vinay'])('%j never breaks it', (about) => {
    for (const audience of ['private', 'shared', 'public'] as AgentContextAudience[]) {
      expect(breaksSpeakerRule(audience, about)).toBe(false);
    }
  });
});

describe('one speaker rule governs every write path: the observer, memory_note and recordFacts agree (TASK-1136)', () => {
  // Walk TASK-1134: memory_note refused `user` while the observer kept `vinay`:
  // the same rule, different subjects. `vinay` is here so both paths stay
  // pinned to treat a name alike.
  const SUBJECTS = [...PERSON_SUBJECTS, ...NOT_PERSON_SUBJECTS, 'vinay'];
  it.each([
    ['an absent', undefined],
    ['a private', 'private'],
    ['a shared', 'shared'],
    ['an unknown', 'public'],
  ] as const)('%s audience', async (_label, audience) => {
    const h = await makeHarness();
    const ctx = h.ctx({
      conversationId: CHANNEL,
      ...(audience !== undefined ? { audience: audience as AgentContextAudience } : {}),
    });
    const engine = new HookBus();
    engine.registerService(FACTS_RECORD_HOOK, 'stub-engine', async () => ({ records: [{ id: 'row-1' }] }));
    const disagreements: string[] = [];
    for (const about of SUBJECTS) {
      const rule = breaksSpeakerRule(audienceOf(ctx), about);
      const observer =
        toStatements([{ subject: about, predicate: 'r', object: 'v', validStart: JAN }], {
          ownerUserId: ALICE,
          audience: audienceOf(ctx),
        }).speakerFacts === 1;
      const result = await h.bus.call<unknown, MemoryNoteResult>(MEMORY_NOTE_TOOL_HOOK, ctx, {
        input: { about, relation: 'r', value: 'v' },
      });
      // Refused FOR THIS RULE: the backstop's generic `forbidden` doesn't count.
      const note = !result.ok && result.error === 'forbidden' && result.message.endsWith(PERSON_IN_SHARED_MESSAGE);
      const record = await recordFacts(engine, ctx, FACTS_RECORD_HOOK, { statements: [{ about }] }).then(
        () => false,
        (err: unknown) => err instanceof PluginError && err.code === 'forbidden',
      );
      if (observer !== rule || note !== rule || record !== rule) {
        disagreements.push(`${JSON.stringify(about)}: rule ${rule}, observer ${observer}, note ${note}, record ${record}`);
      }
    }
    expect(disagreements).toEqual([]);
    // Not vacuous: a shared or unknown audience refuses every person subject, and nothing else.
    expect(SUBJECTS.filter((about) => breaksSpeakerRule(audienceOf(ctx), about))).toHaveLength(
      audienceOf(ctx) === 'shared' ? PERSON_SUBJECTS.length : 0,
    );
  });
});
```

- [ ] **Step 2: Run it and expect FAIL.** Run `pnpm --filter @ax/memory exec vitest run src/__tests__/audience.test.ts`. It fails on imports: `breaksSpeakerRule` and `PERSON_IN_SHARED_MESSAGE` aren't exported yet.
- [ ] **Step 3: Implement.**
  - `audience.ts`: `breaksSpeakerRule` returns `audience !== 'private' && isPersonSubject(about)`. Its JSDoc covers four points:
    - It is the speaker rule (TASK-1091, design §2a), the ONE test every memory write asks. The observer drops, `memory_note` refuses and `recordFacts` refuses on it, so the three can't drift (TASK-1136).
    - `!== 'private'` means an audience this build doesn't know fails closed.
    - The parameter type makes callers go through `audienceOf`.
    - A person named any other way (`vinay`) doesn't break it. A fact naming who owns what is work, which the design keeps. A speaker the extractor names from a sender label is §2a's accepted gap.
  - `recordFacts`: drop the `if (audience === 'shared')` guard and always call `refuseSpeakerFacts(audience, input.statements, hookName)`. Its loop tests `breaksSpeakerRule(audience, about)`.
  - `observer.ts:749`: `if (breaksSpeakerRule(opts.audience, fact.subject))`. Swap the import at `:6`.
  - `note-tool.ts:228`: `if (breaksSpeakerRule(audienceOf(ctx), input.about as string))`. Swap the import at `:11`, and export `PERSON_IN_SHARED_MESSAGE`.
- [ ] **Step 4: Run it and expect PASS.** Run the whole `pnpm --filter @ax/memory test`: the TASK-1091 tests must stay green with no edits. Then run `pnpm --filter @ax/memory build`.
- [ ] **Step 5: Mutation check.** One mutant at a time. Restore with `git checkout -- <file>` and keep a clean tree between mutants.

| Mutant | Killed by |
|---|---|
| `breaksSpeakerRule`: `!== 'private'` → `=== 'shared'` | unit table (`'public'` rows) |
| `breaksSpeakerRule`: `&&` → `\|\|` | unit table (private rows, not-person rows) |
| the note tool tests raw `ctx.audience === 'shared'` | contract, unknown audience (falls through to the backstop's generic text) |
| the note tool's own check deleted | contract, shared; existing `memory_note about a person (%j) in a shared turn saves nothing` |
| `recordFacts`' backstop deleted | contract, shared/unknown; existing `memory:remember about %j in a shared turn is refused forbidden…` |
| the observer's check deleted | contract, shared/unknown; existing `a shared turn stores no speaker facts` |
| one path drifts, e.g. the observer tests `subject.trim().toLowerCase() === 'user'` | contract (`user:abc` and fullwidth rows) |

Not killed, by design: a change to `isPersonSubject` itself. All three paths share it, and the existing `isPersonSubject` table pins it.

- [ ] **Step 6: Security-checklist walk.** Write its row to the decisions shard and the note to the PR. Commit (shard included) as `fix(memory): one speaker rule for the observer, memory_note and recordFacts (TASK-1136)`.

### Task 2: A refused person-note points the agent at the work `[tier: mechanical]`

The text is fixed below. Task 1's security walk covers it, because it's the same boundary.

**Files:** Modify `packages/memory/src/note-tool.ts:89`. Test: `packages/memory/src/__tests__/note-tool.test.ts` (`:524-529`, `:780`, two new tests).

**Interfaces (consumes):** `PERSON_IN_SHARED_MESSAGE`, exported in Task 1. Its new value, exactly:

```ts
export const PERSON_IN_SHARED_MESSAGE =
  "Notes about a person (`user` or `user:<id>`) aren't saved in a shared conversation. " +
  "Don't save it under their name instead. If it's about the work (a project, a decision, a process, " +
  'or who owns what), save it again with the work as `about`, for example `team_standup`.';
```

- [ ] **Step 1: Update the pins and write the new tests.**
  - `:524-529`: the expected `message` becomes `'NOT SAVED: nothing was written to memory — do not tell the person it was saved. '` + the text above. Write it as a literal in the test, not the import, so a copy change shows up in review.
  - `:780`: `toMatch(/about a person/)` → ``toMatch(/with the work as `about`/)``.
  - New, in `describe('a note in a shared turn (TASK-1091)')`: `a refused person-note points at the work, and the work note it suggests is saved, stamped shared`.
    - Context: an attended channel turn, `h.ctx({ conversationId: 'conv-channel', source: 'user', audience: 'shared' })`.
    - `{ about: 'user', relation: 'standup_time', value: '10:15 on Tuesdays' }` → `expectRefused(…, 'forbidden')`, and the message matches ``/with the work as `about`/``.
    - `{ about: 'team_standup', relation: 'time', value: '10:15 on Tuesdays' }` → `{ ok: true }`.
    - The table holds exactly `[{ about: 'team_standup', audience: 'shared' }]`. Query it the way `a note about anything else is saved, stamped shared` does.
  - New, in `describe('a note in a conversation memory may not learn from (TASK-1094)')`: `the retried work note still honours memory:pre-capture`.
    - Setup: `refuseEverything(h)`, with the same shared context.
    - The person note → the person refusal, and `asked` stays `[]`.
    - The work note → `{ ok: false, error: 'forbidden', message: REFUSED_MESSAGE }`, and `asked` has one entry.
    - `readRows` is empty.
- [ ] **Step 2: Run it and expect FAIL.** Run `pnpm --filter @ax/memory exec vitest run src/__tests__/note-tool.test.ts`. Both pins and the first new test's regex fail. The veto test may already pass; it pins Review Focus 1.
- [ ] **Step 3: Change the constant** to the text above.
- [ ] **Step 4: Run it and expect PASS.** Then run `pnpm --filter @ax/memory build`.
- [ ] **Step 5: Mutation check.**
  - Text reverted → caught by the pins.
  - Redirect sentence dropped → caught by the pins and the regex.
  - Person check moved after `captureRefusal` → caught by the existing `bad input, or a person-note in a shared turn, is refused for that reason before memory asks` and the new veto test.
- [ ] **Step 6: Commit** as `fix(memory): a refused person-note in a shared turn points the agent at the work (TASK-1136)`.

### Task 3: The agent's narration of its own memory operations and tool failures is not a fact `[tier: sensitive]`

**security-checklist: required.** The new regexes run synchronously on the host over untrusted model output, and TASK-612 once measured an O(n²) there.

**Files:**
- Modify: `packages/memory/src/self-report.ts` (a new header section, constants, `isAgentContextSelfReport`)
- Comments: `packages/memory/src/observer.ts:88-94`, `:158-163`, `:753-757`; `packages/memory/src/plugin.ts:2321-2322`
- Test: `packages/memory/src/__tests__/self-report.test.ts` (a new `describe`). `packages/memory/src/__tests__/observer.test.ts`: a new `describe` after TASK-612's at `:794`, and `audience: string | null` added to the `readRows` row type at `:1217`.

**Interfaces:** `isAgentContextSelfReport({ subject, predicate, object }): boolean` keeps its name and signature, and now also flags narration. A drop still counts as `selfReports`, with skip reason `only-self-reports`.

- [ ] **Step 1: Write the failing tests.** First, `self-report.test.ts`:

```ts
describe('the agent narrating its own memory operations and tool failures (TASK-1136)', () => {
  // Walk TASK-1134 stored `assistant | could_not_save_memory`; its object wasn't recorded.
  it.each(['', 'the standup time', 'Team standup moved to 10:15 on Tuesdays', "Notes about a person aren't saved in a shared conversation."])(
    'flags the walk row whatever its object (%j)',
    (object) => {
      expect(isAgentContextSelfReport({ subject: 'assistant', predicate: 'could_not_save_memory', object })).toBe(true);
    },
  );

  it.each([
    ['agent', 'could_not_save_memory', 'x'],
    ['Assistant', 'Could Not Save', 'the note'],
    ['assistant', "couldn't_save", 'the note'],
    ['assistant', 'couldnt_save_note', 'about Vinay'],
    ['assistant', 'cannot_save_notes', 'about a person in a shared conversation'],
    ['assistant', 'could_not_fetch', 'the weather page'],
    ['assistant', 'failed_to_connect', 'Gmail'],
    ['assistant', 'unable_to_access', 'the shared drive'],
    ['assistant', 'was_unable_to', 'save the note'],
    ['assistant', 'was_not_able_to_open', 'the attachment'],
    ['assistant', 'saved_to_memory', 'team standup time is 10:15 on Tuesdays'],
    ['assistant', 'stored_in_memory', 'the standup time'],
    ['assistant', 'added_to_long_term_memory', 'the standup time'],
    ['assistant', 'stated', "I couldn't save that to memory"],
    ['assistant', 'stated', 'Saved it to memory: standup is 10:15 on Tuesdays'],
    ['assistant', 'confirmed', 'it noted this in memory'],
    ['assistant', 'used', 'memory_note to save the standup time'],
    ['assistant', 'called', 'the memory note tool, which refused the note'],
  ])('flags %s | %s | %s', (subject, predicate, object) => {
    expect(isAgentContextSelfReport({ subject, predicate, object })).toBe(true);
  });

  it.each([
    ['user', 'could_not_attend', 'the offsite'],
    ['sam', 'failed_to_submit', 'the expense report'],
    ['vinay', 'could_not_save_memory', 'x'],
    ['assistant', 'explained', 'how to save data to memory on an Arduino with EEPROM.write'],
    ['assistant', 'explained', 'data saved to memory is lost on reboot unless written to flash'],
    ['assistant', 'recommended', 'upgrading the laptop to 32GB of memory'],
    ['assistant', 'recommended', 'a memory card reader for the camera'],
    ['assistant', 'did_not_recommend', 'the Hilton, because of the noise complaints'],
    ['assistant', 'explained', "the user couldn't save the file because the drive was full"],
    ['assistant', 'listed', 'steps to save notes in Apple Notes'],
    ['assistant', 'saved', 'the Q3 report draft to the shared drive'],
    ['assistant', 'cantilevered', 'the shelf design'],
  ])('keeps %s | %s | %s', (subject, predicate, object) => {
    expect(isAgentContextSelfReport({ subject, predicate, object })).toBe(false);
  });

  it('stays fast on a huge, repetitive, untrusted predicate and object', () => {
    const start = performance.now();
    for (const word of ['save that to ', 'memory note ', 'could not ', 'saved it into the ', 'noted ']) {
      isAgentContextSelfReport({
        subject: 'assistant',
        predicate: `${word.replace(/ /g, '_').repeat(20_000)}x`,
        object: `${word.repeat(40_000)}x`,
      });
    }
    expect(performance.now() - start).toBeLessThan(250);
  });
});
```

Then `observer.test.ts`, which replays the walk's batch end to end:

```ts
describe("the agent's narration of its own operations is not a fact (TASK-1136)", () => {
  it("walk TASK-1134's channel batch: the narration is dropped and counted, the work fact kept, stamped shared", async () => {
    const h = await withLlm(() =>
      reply(extraction([
        fact({ subject: 'vinay', predicate: 'stated_standup_time', object: 'Team standup moved to 10:15 on Tuesdays' }),
        fact({ network: 'experience', subject: 'assistant', predicate: 'could_not_save_memory', object: 'the standup time' }),
      ])),
    );
    await chatEnd(h, {
      ctx: h.ctx({ conversationId: 'conv-channel', source: 'user', audience: 'shared' }),
      messages: [
        { role: 'user', content: 'Vinay: remember that team standup moved to 10:15 on Tuesdays' },
        { role: 'assistant', content: "I couldn't save that to memory." },
      ],
    });
    // `vinay` stays on purpose: a work fact under the sender's name is design §2a's accepted gap.
    expect(readRows(h.databasePath).map((r) => [r.about, r.audience])).toEqual([['vinay', 'shared']]);
    const run = eventsNamed(h.logs, OBSERVER_RUN_EVENT).find((l) => l.bindings.outcome === 'recorded');
    expect(run?.bindings).toMatchObject({ recorded: 1, selfReports: 1, speakerFacts: 0 });
  });
});
```

- [ ] **Step 2: Run it and expect FAIL.** The flag rows fail, and the e2e test stores 2 rows with `selfReports: 0`. Every keep row and every existing TASK-612 row should already pass. The negation filter keeps the narration because its predicate carries the negation itself.
- [ ] **Step 3: Implement in `self-report.ts`.** A probe validated these patterns against both tables and TASK-612's keep rows: no misses, and 11 ms on the timing inputs.
  - `normalizePredicate(p)`: trim, lowercase, strip `'`, `‘` and `’`, and collapse `[\s-]+` to `_`. Use it only for the two new predicate tests. Leave `CONTEXT_PREDICATE`'s input as it is.
  - `FAILURE_PREDICATE = /^(?:could_?not|couldnt|can_?not|cant|(?:was_|were_|is_)?unable_to|failed_to|(?:was_|were_|is_)?not_able_to|wasnt_able_to)(?:_|$)/`
  - `MEMORY_OP_PREDICATE = /^(?:save|saved|store|stored|note|noted|add|added|record|recorded|write|wrote|written|keep|kept)_(?:(?:it|that|this)_)?(?:to|in|into)_(?:(?:my|its|the|long_term)_)?memor(?:y|ies)(?:_|$)/`
  - Append two entries to `CONTEXT_PATTERNS`, so they run over the existing capped `text`:
    - `/\bmemory[_ ]notes?\b/`
    - `/\b(?:save|saved|saving|store|stored|storing|note|noted|noting|record|recorded|recording|add|added|adding|keep|kept|keeping|write|wrote|written|writing) (?:it|that|this|these|those|them) (?:to|in|into) (?:(?:my|its|the|long-term|long term) )?memor(?:y|ies)\b/`
  - Order inside the function: the agent-subject check stays FIRST. Then `CONTEXT_PREDICATE`, `FAILURE_PREDICATE` and `MEMORY_OP_PREDICATE`, then the text patterns.
  - New header section, `## Its narration of its own operations (TASK-1136)`, covering:
    - What the walk stored.
    - Why it's never a durable fact: memory's store and each tool's own state are the source of truth, so a transcript report of a save or a failure is stale on arrival (invariant 4, TASK-612's argument).
    - Why it's narrow on purpose: it needs the agent as subject plus a failure predicate or a memory anchor. A person's failure is theirs to keep, and `did_not_*` is content.
    - The accepted losses: a content outcome phrased as a failure (`could_not_find | flights…`), and "how to save it to memory on an Arduino".
  - Comments: the `only-self-reports` and `selfReports` docs in `observer.ts`, and the log comment at `plugin.ts:2321`, now name "its own context, its memory operations and its tool failures (TASK-612, TASK-1136)".
- [ ] **Step 4: Run it and expect PASS.** Run the whole `@ax/memory` suite, then `pnpm --filter @ax/memory build`.
- [ ] **Step 5: Mutation check.**

| Mutant | Killed by |
|---|---|
| `FAILURE_PREDICATE` removed | walk rows, failure flag rows, e2e |
| `MEMORY_OP_PREDICATE` removed | `saved_to_memory`, `stored_in_memory`, `added_to_long_term_memory` |
| `memory[_ ]note` pattern removed | `used \| memory_note…`, `called \| the memory note tool…` |
| pronoun-object pattern removed | `I couldn't save that to memory`, `Saved it to memory…`, `it noted this in memory` |
| the new checks run before the agent-subject check | the `user`, `sam` and `vinay` keep rows |
| `(?:_\|$)` dropped from `FAILURE_PREDICATE` | keep `cantilevered` |
| the pronoun list widened to any word (`\S+`) | keep "save data to memory on an Arduino" |
| an unbounded `(?:\S+ )*` between the verb and "memory" | timing test |
| the patterns land but `toStatements` stops calling the function | e2e (and TASK-612's observer tests) |

- [ ] **Step 6: Security-checklist walk.** Write its row to the decisions shard and the note to the PR. Commit as `fix(memory): the observer drops the agent's narration of its own memory operations and tool failures (TASK-1136)`.

### Task 4: Say what the rule really is, where the prose overclaimed it, and add the changeset `[tier: mechanical]`

These lines made the card look true. They say a shared turn stores "nothing about a person", but the rule is "nothing under a person subject (`user`, `user:<id>`)". The walker found a stored `vinay | …` row while the agent was telling the channel "Notes about a person aren't saved".

**Edits (comments and docs only):**
- `packages/memory/src/audience.ts:10-11`: → "…and a shared turn stores nothing under a person subject (`user`, `user:<id>`; {@link breaksSpeakerRule})."
- `packages/memory/src/audience.ts:142`: "any statement about a person" → "any statement with a person subject".
- `packages/memory/src/subject.ts:36-39`: "…so a shared turn stores no speaker." → "…so a shared turn stores nothing under a speaker subject. A speaker the extractor names from a channel's sender label (`vinay | …`, seen in the TASK-1134 walk) isn't one: design §2a's accepted gap."
- `packages/memory/src/owner.ts:37-38`: "say nothing about a person" → "none has a person subject".
- `packages/memory/src/plugin.ts:1530-1531`: "stores nothing about a person (`toStatements`, `recordFacts`)" → "stores nothing under a person subject (`breaksSpeakerRule`)".
- `packages/memory/src/plugin.ts:2323`: "Facts about a person" → "Facts with a person subject".
- `packages/memory/src/observer.ts`:
  - `:96`: "Every fact was about a person" → "Every fact had a person subject (`user`, `user:<id>`)".
  - `:165`: "were about a person in a shared turn" → "had a person subject, in a shared turn".
  - `:256`: "every fact about a person" → "every fact with a person subject".
  - `:731-732`: "every fact about a person (`isPersonSubject`: …)" → "every fact with a person subject (`breaksSpeakerRule`: …)".
- `packages/memory/src/__tests__/audience.test.ts:488`: → "nothing under a person subject".
- `docs/plans/2026-11-09-channel-slack-design.md:141-145`:
  - After "…is dropped.", add: "The observer, `memory_note` and the write door ask one function (`breaksSpeakerRule`, TASK-1136), and a refused note tells the agent to save a work fact with the work as `about`."
  - In the gaps bullet, after "from the sender label", add: "(the TASK-1134 walk saw it: `vinay | stated_standup_time | Team standup moved to 10:15 on Tuesdays`, stored shared; TASK-1136 kept it as a work fact)".
- Create `.changeset/memory-shared-speaker-rule.md`:

```md
---
'@ax/memory': patch
---

In a shared conversation (a Slack channel, say), the agent's own notes and our background note-taker now share one rule about people, and a test keeps them in step. Both keep facts about the work. Neither keeps a note about "the person I'm talking to". One gap we know about: the note-taker can still file a work fact under the speaker's name, because channel messages carry it.

When a note gets turned down for being about a person, the agent now hears what to do instead: save it with the work as the subject. So "standup moved to 10:15" gets remembered, instead of the agent telling the channel it couldn't save it.

Memory also stops keeping the agent's commentary on itself, like "I couldn't save that", "saved it to memory" or "couldn't reach the page". Those describe one conversation's hiccups, and they're stale the moment they're written.
```

- [ ] **Step 1: Make the edits.**
- [ ] **Step 2: Verify.** `git grep -n -E "nothing about a person|stores no speaker\.|every fact about a person|were about a person|was about a person|Facts about a person" -- packages/memory` prints nothing, and `pnpm --filter @ax/memory build && pnpm --filter @ax/memory test` passes.
- [ ] **Step 3: Commit** as `docs(memory): the speaker rule is about subjects, not people; changeset (TASK-1136)`.

## Before the PR

- Run the full gate from Global Constraints.
- PR body:
  - "Boundary review: not required: no hook, payload or IPC change."
  - Paste the two security-checklist notes.
  - Add the **For Vinay** row from the decisions shard (close the sender-label gap?) as a non-blocking follow-up.
- Not built, on purpose (reasons are in the shard): closing the sender-label gap, a descriptor change, a separate narration counter, renaming `isAgentContextSelfReport`, reordering the note's checks.
