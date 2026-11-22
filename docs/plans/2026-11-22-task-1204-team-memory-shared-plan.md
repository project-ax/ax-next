# TASK-1204: A team agent's memory is team-shared; speaker facts kept and filed under the speaker — Implementation Plan

> **Revised after review (2026-11-22).** The security review narrowed this plan, and the body below is superseded where it disagrees:
>
> - **Outsider turns keep shared-only recall** (with its backstop) and **get no `/memory` mount**, on any agent and whatever their audience stamp. Every "every session" line below now holds for members' turns only: for example the Goal, the Approach, Task 5's `recallAudienceScope` rule, Task 6's `'an outsider'` row in "a team agent's %s session gets its mount", and Task 7's "recall is unscoped in every team session, outsider turns included" and its security note.
> - **What a member says about themself is stamped `private`, not `shared`**, so it stays with the team: every member's turn recalls it, and no outsider's turn does.
>
> The decisions shard has the reasons (rows 39–41 and the review rows after them).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For team agents only, a member's channel turn keeps facts about people and files a fact about the member under the member's own key (`user:<ctx.userId>`, the key their web chats use); a team agent recalls everything in every session and keeps its `/memory` view. Outsiders' words stay unremembered, and personal agents don't change.

**Architecture:** One rule decides every write. `speakerScope(ctx, access)` says whose memory this is and who is talking: `private` (the owner's own turn, today's behavior), `team` (a team agent's shared turn run as the person who wrote), or `withheld` (any outsider turn, and any other shared turn: today's speaker rule). `speakerSubject(scope, about, userId, speakerNames)` returns the subject a write files under, or `undefined` (not stored). The observer, `memory_note` and the write door (`recordFacts`) all ask it, and the read door (`recallFacts`) stops scoping team agents. Team-ness comes from `resolveMemoryAccess` (`agents:resolve`), which every one of these points already calls. No new hook, no manifest change, no channel-slack change.

**Tech Stack:** TypeScript, vitest, the better-sqlite3 memory harness (`packages/memory/src/__tests__/harness.ts`).

**Spec:** card TASK-1204 + `docs/plans/2026-11-09-channel-slack-design.md` §4c card C (decided by Vinay 2026-11-22), §2a. Planner decisions, with every alternative weighed: `.claude/memory/decisions/2026-11-22-TASK-1204.md`. **Read it first.** Append your own rows there (never to a root archive).

## The premise, checked (brief claims found false)

- **"Never file it under `user:<ctx.userId>` (the requester)": false for every conversation memory captures.** A member's channel turn runs as the member (`channel-slack/src/channel-route.ts:73`, tier A "attended, as themselves"). Conversations are unique per (user, agent, external key) (`conversations/src/migrations.ts:161-163`; `router.ts:614-617`), so a member's thread conversation holds only that member's turns. The requester runs only outsiders' `:external` conversations, which channel-slack's veto refuses (`capture-veto.ts:82`). So in a member's turn `user:<ctx.userId>` IS the speaker, and it's the only key a later web-chat recall finds (the block's Profile reads `about: user:<id>`; `memory:recall {about:'user'}` rewrites the same way).
- **"Store it against their label name and Slack ID": rejected.** `speakerNames` is a flat, unpaired list (`format.ts:365` + the thread row's union), so memory would have to parse Slack IDs (invariant 1) or channel-slack would change its payload (TASK-1202 is rewriting `capture-veto.ts` now). Either way it's a second key per person (invariant 4) that splits on a rename, collides across two members named Alex, and that web-chat recall can't find (Postgres refuses `query`). The names still matter: they're how memory recognizes the speaker in a subject, then files it under the speaker's key.
- **"Multi-speaker threads": none in any captured conversation.** A Slack thread with members X and Y is two conversations, each with its own names. The only mixed-speaker conversation is `:external`, refused. The TASK-1146 plan refuted the same claim.
- **"Remove the speaker rule for team agents": kept for outsider turns.** In an `external` turn `ctx.userId` is the requester, so filing `user` there is exactly §2a's problem 2. The veto refuses those threads, but a subscriber that throws or misses memory's bound is skipped, so memory keeps the rule there as a backstop.
- **Missing from the card:** once team recall is unscoped and channel turns store `user:<id>` rows, an outsider's turn would show the **requester's** profile as "you". Task 5 stops that.
- The extractor does write the speaker's name: kind held 5 `vinay` rows vs 1 `user:` row (TASK-1146 decisions row 19), and the TASK-1134 walk stored `vinay | stated_standup_time`. So recognizing names is what makes this card work at all.

## Approach (chosen) and why the others lost

Chosen: canonical key `user:<ctx.userId>` for the speaker in a team agent's member turn, with names recognized by TASK-1146's `namesASpeaker`. Rejected (details in the shard): keep names as written (two subjects per person, slot collisions between same-named members, a rename splits them, web recall can't find them); label name + Slack ID (above); structured speakers with AX ids in the pre-capture answer (precise, but for a multi-speaker case that doesn't exist). For outsiders: shared-only recall for outsider turns was considered and offered to Vinay as the one-line reversal, but the card says "every session".

## Boundary review (no signature change; one subscriber-contract change)

- **`memory:pre-capture` `speakerNames` (semantics):** in a team agent's member turn, memory now **files** a subject made of these names under the person the turn runs as, where it used to drop it. So a subscriber names only the people whose words the conversation's user turns carry, and in an attended conversation that's the person the turn runs as. channel-slack complies today (one conversation per member; outsiders record none).
  - **Alternate impl:** Teams/Discord display names, email-in From names.
  - **Leaky field names:** none.
  - **Subscriber risk:** a subscriber that names a co-speaker in an attended conversation would get that person's words filed under the runner. That's why the contract text is changed in Task 7.
  - **Wire surface:** none (a host-only fire).
- **`AgentContext.audience` (doc only):** `'shared'` now limits recall and speaker facts only for personal agents.
- **`sandbox:memory-mounts`, `memory:recall`:** same shapes, wider answers for team agents. Covered in the security note (Task 7).

## Global Constraints

- **Personal agents:** behavior unchanged. Every existing personal-agent test passes with only call-signature updates, except the two call-order assertions named in Tasks 4 and 6.
- **Don't touch `packages/memory/src/extraction-prompt.ts`** (fingerprint-pinned `e7466bf4` / `06414f62`).
- **No edits under `packages/channel-slack` or `packages/channel-web`.** TASK-1202 is rewriting `capture-veto.ts`, `router.ts`, `channel-store.ts` and `migrations.ts` in parallel. The channel-slack comments that describe the old rule are listed as a follow-up in the PR body (Task 7).
- **No new hook name, and no manifest change** (`registers`/`calls`/`optionalCalls`/`subscribes`): the pins in `presets/k8s/src/__tests__/preset.test.ts` must not move.
- **Memory learns no Slack vocabulary.** `speakerNames` stay opaque strings, compared only through `namesASpeaker`. Nothing parses a label or a Slack ID.
- **A name never goes into a log line, an error message or a prompt.** Error messages name no statement.
- **Keep `audience` stamping on every row** (`recordFacts`).
- **A team turn never files a person key other than its runner's own** (`user:<ctx.userId>`). This is the invariant every test in Tasks 1–4 protects.
- **Commands:**
  - The filter goes BEFORE the script: `pnpm --filter @ax/memory exec vitest run src/__tests__/audience.test.ts`.
  - `tsc` doesn't type-check tests, so also run `pnpm --filter @ax/memory build`.
  - Full gate before the PR: `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts && pnpm lint`. Docker-backed suites need an explicit `DOCKER_HOST`.
- **Spell invisible characters in tests as `\u` escapes.**
- **Memory rows:** append to `.claude/memory/decisions/2026-11-22-TASK-1204.md` only.
- **In GitHub text,** `@ax/...` goes inside backticks.

## Review Focus

1. **A member whose display name is a work phrase or "Assistant".** Work facts in their own conversation may be filed under their own key (accepted). The agent's `assistant` facts never are, and nothing ever lands under another member's key. Pinned in Task 1 (rows and the property test).
2. **An outsider's turn when the veto doesn't answer.** No person fact lands under the requester (Task 3), and the block never shows the requester's profile as "you" (Task 5).
3. **A thread recorded before TASK-1146 (no names).** A name subject is kept as written, never under a key, and `user` still goes to the member's own key. Pinned in Tasks 1 and 3.
4. **Two members in one Slack thread.** Each member's facts land under their own key. A member's claim about the other is a third-party fact, under neither key. Pinned in Task 3.
5. **A member's note restating what the observer already stored.** One row, under one key (the twin check sees the canonical key). Pinned in Task 4.

## Files

| File | Change | Task |
|---|---|---|
| `packages/memory/src/audience.ts` | `SpeakerScope`, `speakerScope`, `speakerSubject` | 1 |
| | `recordFacts(…, access, …)` + its backstop | 2 |
| | `recallAudienceScope(ctx, access)`, `recallFacts(…, access, …)`; header `:7-27` | 5 |
| `packages/memory/src/observer.ts` | `RunObserverInput.speakerScope`; `toStatements` uses `speakerSubject`; docs `:95-103`, `:166-174`, `:742-755` | 3 |
| `packages/memory/src/plugin.ts` | record wrapper `~:1797-1812` and `recordHumanStatement` `~:1137` pass access | 2 |
| | `ObserveDeps.speakerScope`, `observe()`, both producers; comment `~:1520-1535` | 3 |
| | `memory:recall` reads + `ownSubject`; the three twin reads; `registerMemoryNote` call `~:1657` | 5 |
| | `sandbox:memory-mounts` `~:661-705`; `MEMORY_MOUNT_WITHHELD_EVENT` doc `:187-192` | 6 |
| `packages/memory/src/note-tool.ts` | `recordFacts` call | 2 |
| | flow + `TEAM_PERSON_KEY_MESSAGE` | 4 |
| | `NotePriorRowsFn` takes access | 5 |
| `packages/memory/src/augment.ts` | `self` gated on `isOutsiderTurn`; `recallFacts` access | 5 |
| `packages/memory/src/{subject,owner,capture}.ts` | comments only | 7 |
| `packages/memory/src/__tests__/audience.test.ts` | rule tables; recordFacts/recallFacts signature updates; team tests; drift guards | 1–5 |
| `packages/memory/src/__tests__/note-tool.test.ts` | team describe; `:872` call-order update | 4 |
| `packages/memory/src/__tests__/incremental.test.ts` | `setup(…, agent?)`; team pass test | 3 |
| `packages/memory/src/__tests__/export.test.ts` | team mount rows; withheld call list | 6 |
| `packages/core/src/context.ts:290-296`, `packages/core/src/memory-capture.ts:10-20` | doc comments | 7 |
| `docs/plans/2026-11-09-channel-slack-design.md` | §4c `:1128-1130` (stale premise) + As built; §6 `:1354-1356`, `:1388-1390` | 7 |
| `.changeset/memory-team-shared.md` | new | 7 |

Order: 1 → 2 → 3 → 4 → 5 → 6 → 7. Each task leaves `@ax/memory` building and green. Tasks 2 and 5 change door signatures, and their own steps update every caller.

---

### Task 1: One rule for every write: whose memory, and who is talking `[tier: sensitive]`

**security-checklist: required.** This rule decides where a fact about a person is filed, and the inputs that drive it (Slack display names) are untrusted. One note covers the PR (written in Task 7). Answer for this task: names only ever map to the runner's own key.

**Files:** Modify `packages/memory/src/audience.ts` (add after `breaksSpeakerRule`, `~:287`). Test: `packages/memory/src/__tests__/audience.test.ts` (new describe at the end).

**Interfaces (produces):**
```ts
import type { MemoryAccess } from './access.js';
export type SpeakerScope = 'private' | 'team' | 'withheld';
export function speakerScope(
  ctx: Pick<AgentContext, 'audience' | 'source'>,
  access: Pick<MemoryAccess, 'visibility'>,
): SpeakerScope;
export function speakerSubject(
  scope: SpeakerScope,
  about: string,
  userId: string,
  speakerNames: readonly string[],
): string | undefined;
```

The rules (exact, in order):

- **`speakerScope`:**
  - `isOutsiderTurn(ctx)` → `'withheld'`, whatever the audience. In an outsider's turn, `ctx.userId` is never the person talking. Today no outsider turn is private (channel-slack's `turnContextFields`), so this changes nothing live; it just fails closed.
  - Else `audienceOf(ctx) === 'private'` → `'private'`.
  - Else `access.visibility === 'team'` → `'team'`.
  - Else `'withheld'`.
  - `isOutsiderTurn` comes from `@ax/core` and fails closed for an unknown source. An unknown visibility is not `'team'`, so it fails closed too.
- **`speakerSubject`:**
  - `'private'` → `rewriteSpeaker(about, userId)` (unchanged behavior).
  - `'withheld'` → `breaksSpeakerRule('shared', about, speakerNames) ? undefined : about` (unchanged behavior).
  - `'team'`, checked in this order:
    1. `about.length > SPEAKER_RULE_READS_AT_MOST` → `undefined` (unread).
    2. `about === 'assistant'` → `about`. The extractor's own subject is never a person, whatever a display name says.
    3. `about === 'user'` or `about === \`user:${userId}\`` → `` `user:${userId}` ``.
    4. `namesASpeaker(about, speakerNames)` → `` `user:${userId}` ``.
    5. `isPersonSubject(about)` → `undefined` (`User`, ` user `, `user:<anyone else>`).
    6. Otherwise `about` (a work subject, or a third party by name).

- [ ] **Step 1: Write the failing tests** (describe `'one rule for every write: whose memory, and who is talking (TASK-1204)'`; `X = 'user-x'`, `OWN = 'user:user-x'`, `NAMES = Object.freeze(['Alice Smith', 'U123'])`):

```ts
it.each([
  // audience, source, visibility, expected
  [undefined, undefined, 'team', 'private'],
  ['private', 'routine', 'personal', 'private'],
  ['private', 'external', 'team', 'withheld'],  // an outsider's turn never files under its runner, whatever the audience
  ['private', 'external', 'personal', 'withheld'],
  ['shared', 'user', 'team', 'team'],
  ['shared', undefined, 'team', 'team'],
  ['shared', 'routine', 'team', 'team'],
  ['shared', 'external', 'team', 'withheld'],
  ['shared', 'bogus', 'team', 'withheld'],      // an unknown source fails closed
  ['public', 'user', 'team', 'team'],           // an unknown audience reads as shared
  ['shared', 'user', 'personal', 'withheld'],
  ['shared', 'user', 'bogus', 'withheld'],      // an unknown visibility fails closed
])('audience %j, source %j, %s agent: %s', (audience, source, visibility, expected) =>
  expect(speakerScope({ audience, source } as never, { visibility } as never)).toBe(expected));

it.each([
  ['user', OWN], [OWN, OWN],
  ['alice', OWN], ['Alice', OWN], ['alice_smith', OWN], ['smith_alice', OWN], ['alicesmith', OWN],
  ['Alice Smith', OWN], ['u123', OWN], ['U123', OWN], ['user_alice', OWN], ['user:U123', OWN], ['user:alice', OWN],
  ['User', undefined], [' user ', undefined], ['user:user-y', undefined], ['user:bob', undefined], ['user :x', undefined],
  ['a'.repeat(1025), undefined],
  ['team_standup', 'team_standup'], ['billing_service', 'billing_service'], ['ada', 'ada'],
  ['alice_laptop', 'alice_laptop'], ['alices_team', 'alices_team'], ['assistant', 'assistant'],
])('a team member turn files %j under %j', (about, expected) =>
  expect(speakerSubject('team', about, X, NAMES)).toBe(expected));
```

- Also add these `it`s (one assertion block each):
  - **`'with no names, a team member turn keeps a name as written and never under a key'`:**
    - `('alice_smith', [])` → `'alice_smith'`
    - `('user', [])` → `OWN`
    - `('user:U123', [])` → `undefined`
  - **`'a display name never files the agent's own facts, or anyone's key but the runner's'`:**
    - `('assistant', ['Assistant','U9'])` → `'assistant'`
    - `('user:user-y', ['user-y'])` → `OWN` (it lands on the runner's own key, never on `user:user-y`)
  - **`'accepted residuals: a name made of work words, or a namesake, files under the speaker'`** (pinned so they stay visible):
    - `('team_standup', ['Standup Team','U7'])` → `OWN`
    - `('alex', ['Alex Kim','U8'])` → `OWN`
  - **`'a display name changed mid-thread: every name the thread kept is the speaker'`:**
    - `('vp', ['Vinay Pulim','UHTE83XE1','vp'])` → `OWN`
    - `('vinay', …)` → `OWN`
  - **`'never a person key but the runner's own'` (property test):**
    - Inputs: every subject in `PERSON_SUBJECTS`, `NOT_PERSON_SUBJECTS`, `NAMES_A_SPEAKER`, `NOT_A_SPEAKER` and `TOO_LONG_TO_READ`, against each name list in `[[], NAMES, ['user-y'], ['Assistant']]`.
    - Assert: `out === undefined || out === about || out === OWN`.
    - Assert: `out === undefined || !isPersonSubject(out) || out === OWN`.
  - **`'withheld is the TASK-1146 rule, private is the narrow rewrite'`:** for the same subjects:
    - `speakerSubject('withheld', s, X, NAMES)` equals `breaksSpeakerRule('shared', s, NAMES) ? undefined : s`.
    - `speakerSubject('private', s, X, NAMES)` equals `rewriteSpeaker(s, X)`.

- [ ] **Step 2: Run them and see them fail.** Run: `pnpm --filter @ax/memory exec vitest run src/__tests__/audience.test.ts`. Expected: FAIL (`speakerScope` is not exported).
- [ ] **Step 3: Implement both functions in `audience.ts`** with the rules above. Add a doc comment on each saying why: the speaker's key in a member turn, and that it never produces another person's key. Import `isOutsiderTurn` from `@ax/core`.
- [ ] **Step 4: Run the tests and `pnpm --filter @ax/memory build`.** Expected: PASS, and the build is clean.
- [ ] **Step 5: Commit:** `feat(memory): one speaker rule by scope: private, team, withheld (TASK-1204)`.

---

### Task 2: The write door files by the rule: `recordFacts` takes access `[tier: sensitive]`

**security-checklist: required.** This is the backstop behind every write path.

**Files:**
- Modify `packages/memory/src/audience.ts`:
  - `recordFacts`, `askSpeakerNames` (`~:289-362`).
  - `refuseSpeakerFacts` (`~:364-382`) becomes `refuseUnfiled`.
- Modify the three callers:
  - `packages/memory/src/plugin.ts`: the record wrapper in `observe()` `~:1797-1812`, and `recordHumanStatement` `~:1137`.
  - `packages/memory/src/note-tool.ts:285`.
- Test: `audience.test.ts`, the `recordFacts` describe (`~:1093-1311`) and the drift guard (`~:1029-1091`).

**Interfaces:**
- **Consumes:** `speakerScope`, `speakerSubject` (Task 1).
- **Produces:**
```ts
export async function recordFacts<TOut>(
  bus: HookBus,
  ctx: AgentContext,
  access: MemoryAccess,                // REQUIRED: whose memory; the caller already resolved it
  hookName: string,
  input: { batchKey?: string; statements: ReadonlyArray<object> },
  speakerNames?: readonly string[],
): Promise<TOut | null>;
```

Behavior:

- `scope = speakerScope(ctx, access)`.
- **`'private'`:** stamp and call, with no check and no ask (unchanged).
- **Otherwise, in this order:**
  1. The cheap check with `[]` names.
  2. `names = speakerNames ?? await askSpeakerNames(…)`.
  3. The check with `names`.
  4. Stamp and call.
- **A statement fails the check** when its `about` is a string and `speakerSubject(scope, about, access.userId, names) !== about`. That throws `PluginError` `forbidden` for the whole batch, before anything is sent.
- **Messages:**
  - `withheld`: today's message, verbatim.
  - `team`: `` `a team agent's turn tried to write a statement through ${hookName} that isn't filed under its speaker: memory writes none of the batch rather than file someone's words under the wrong subject` ``.
  - Neither names a statement.

**Callers:**
- **Observer record wrapper:** `const fresh = await resolveMemoryAccess(bus, ctx);` then `recordFacts(bus, ctx, fresh, FACTS_RECORD_HOOK, input, check.speakerNames)`. It still re-resolves before each write, as today.
- **Note:** pass its resolved `access`.
- **`recordHumanStatement`:** pass its `access`.

- [ ] **Step 1: Update the existing calls.** Every `recordFacts(...)` in `audience.test.ts` (the unit tests and the drift guard) passes `{ userId: ALICE, visibility: 'personal' }`, with expectations unchanged. Then write the failing tests in the `recordFacts` describe. Let `turn()` take a `source`, with `NAMES = ['Vinay Pulim', 'UHTE83XE1']`:
  - **`'a team agent's member turn writes statements filed under the speaker, stamped shared'`:**
    - access `{ userId: ALICE, visibility: 'team' }`; ctx shared, `source: 'user'`; names `NAMES`.
    - statements `[{ about: \`user:${ALICE}\` }, { about: 'team_standup' }, { about: 'ada' }]`.
    - Expect: `written` holds all three, each `audience: 'shared'`.
  - **`it.each(['user', 'vinay', 'user_vinay', 'UHTE83XE1', 'User', \`user:${BOB}\`])('a team agent's member turn refuses %j: not yet filed under its speaker')`:**
    - Expect: rejects with `{ code: 'forbidden' }`, and `written` is `[]`.
  - **`'a team member turn refuses another person key before it asks'`:**
    - No names; statements `[{ about: \`user:${BOB}\` }]`.
    - Expect: `forbidden`, and a subscriber on `memory:pre-capture` is never called.
  - **`'a team member turn with no names handed asks once'`:**
    - statements `[{ about: 'team_standup' }]`.
    - Expect: one ask, and it's written.
  - **`'an outsider turn on a team agent keeps the speaker rule: nothing under the requester'`:**
    - ctx shared, `source: 'external'`; access team; statements `[{ about: \`user:${ALICE}\` }]`.
    - Expect: `forbidden`, with today's withheld message.
  - **`'a personal agent's member turn keeps the speaker rule'`:**
    - access personal; ctx shared, `source: 'user'`; statements `[{ about: \`user:${ALICE}\` }]`.
    - Expect: `forbidden`.
- [ ] **Step 2: Run and see the new tests fail** (`audience.test.ts`).
- [ ] **Step 3: Implement** the new `recordFacts`, then update the three callers. Observer and note behavior doesn't change yet: they still drop and refuse person facts with `breaksSpeakerRule` until Tasks 3 and 4.
- [ ] **Step 4: Run** `audience.test.ts note-tool.test.ts observer.test.ts incremental.test.ts`, then `pnpm --filter @ax/memory build`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(memory): the write door files by the speaker rule's scope (TASK-1204)`.

---

### Task 3: The observer keeps a member's facts, filed under them `[tier: sensitive]`

**security-checklist: required.** This is the main attribution path, and its input is the extractor's untrusted output.

**Files:**
- Modify `packages/memory/src/observer.ts`:
  - imports (`:6`, `:11`)
  - `RunObserverInput` (`~:252-276`): replace `audience` with `speakerScope`
  - `toStatements` (`~:742-841`)
  - the doc comments at `~:95-103`, `~:166-174` and `~:742-755` (they say "a shared turn keeps no speaker facts": scope it to `withheld`)
- Modify `packages/memory/src/plugin.ts`:
  - `ObserveDeps` (`~:1686-1704`): replace `audience` with `speakerScope`
  - `observe()`: after `const access = await resolveMemoryAccess(bus, ctx)`, pass `speakerScope: speakerScope(ctx, access)`
  - `observeMessages` and `runConversationPass`: forward it
  - the comment at `~:1520-1535`
- Test: `audience.test.ts` (new describe after the write-side observer tests at `~:830`; the drift guard's `toStatements` call), and `incremental.test.ts`.

**Interfaces:**
- **Consumes:** `SpeakerScope`, `speakerScope`, `speakerSubject` (Task 1); `recordFacts` (Task 2).
- **Produces:**
  - `RunObserverInput.speakerScope: SpeakerScope` (required; replaces `audience`). `RunTurnObserverInput` inherits it.
  - `toStatements(facts, { ownerUserId, conversationId?, speakerScope, speakerNames })`. For each fact it computes `const about = speakerSubject(opts.speakerScope, fact.subject, opts.ownerUserId, opts.speakerNames)`. If that's `undefined`, it counts `speakerFacts` and skips the fact, still first, before the self-report and date checks. Otherwise the statement uses `about`, and the `rewriteSpeaker` call goes away.
  - `ObserveDeps.speakerScope: SpeakerScope`.

Steps:

- [ ] **Step 1: Write the failing tests.** Add a describe in `audience.test.ts`: `"a team agent keeps what a member says about themself, under their own key (TASK-1204)"`.
  - Helpers:
    - `member(h, userId, conversationId)` = `h.ctx({ userId, conversationId, source: 'user', audience: 'shared' })`.
    - The `extractionReply`, `observeTurn` and `storedRows` helpers that already exist.
  - **`'a member's "my favorite color is teal" is kept under their own key: not the requester's, not their name'`** (acceptance 1):
    - Setup:
      - team harness
      - `answerSpeakerNames(h.bus, ['Alice Smith', 'U123'], 'conv-x')`
      - extraction `[alice_smith|favorite_color|teal, user|lives_in|Lisbon, billing_service|owner|Dana]`
      - the user message `'[Slack · #general · Alice Smith (U123)]: my favorite color is teal. I live in Lisbon. Dana owns billing.'`
    - Stored rows (`about|value|audience`, sorted): `` [`user:${ALICE}|teal|shared`, `user:${ALICE}|Lisbon|shared`, 'billing_service|Dana|shared'] ``.
    - Nothing about `alice_smith`. The log has `speakerFacts: 0`.
    - **Alice's later web chat finds it:** `values(await h.recall({ about: 'user' }, h.ctx({ conversationId: 'conv-web' })))` contains `'teal'` and `'Lisbon'`.
    - **Bob's own key doesn't:** `h.recall({ about: 'user' }, h.ctx({ userId: BOB, conversationId: 'conv-web-b' }))` has neither.
  - **`'two members in one Slack thread: each one's facts land under their own key, and a claim about the other under neither'`:**
    - Setup:
      - Alice: `conv-x`, names `['Alice Smith','U123']`.
      - Bob: `conv-y`, names `['Bob Jones','U456']`.
      - The LLM stub branches on whether the dialogue contains `'Bob Jones (U456)'`.
      - Bob's pass returns `bob_jones|lives_in|Berlin` and `alice|favorite_color|teal`.
      - Alice's pass returns `alice_smith|favorite_color|teal`.
    - Expect rows: `` `user:${ALICE}|teal` ``, `` `user:${BOB}|Berlin` ``, and `alice|teal` from Bob's pass (a third party). Nothing else.
  - **`'an outsider's words are still never remembered'`** (acceptance 3), as two `it`s:
    - **(a) With the veto:** a `memory:pre-capture` subscriber answers `reject({ reason: 'channel-external-turn' })`. The outsider ctx is `h.ctx({ userId: BOB, conversationId: 'conv-ext', source: 'external', audience: 'shared' })`. Expect `storedRows(h)` to be `[]`.
    - **(b) With no veto subscriber at all** (the backstop):
      - Extraction: `[user|lives_in|Paris, user:user-bob|works_at|Initech, billing_service|owner|Dana]`.
      - Expect: no stored `about` starts with `user:`; `speakerFacts: 2`; the billing row is stored.
      - Comment: work facts in an outsider's thread still ride on channel-slack's veto, as today.
  - **`'a personal agent's member turn is unchanged: no speaker fact, the work fact stamped shared'`** (acceptance 4):
    - Same input as acceptance 1, on the default personal harness with the `member` ctx.
    - Expect: only `billing_service|Dana|shared`, `speakerFacts: 2`.
  - **`'with no names answered, a member's name subject is kept as written, never under a key'`:**
    - Team harness, no `answerSpeakerNames`, acceptance 1's extraction.
    - Expect: `alice_smith|teal`, `` `user:${ALICE}|Lisbon` ``, `billing_service|Dana`.
  - **In `incremental.test.ts`:**
    - `setup` gains a third parameter `agent?: MemoryHarnessOptions['agent']`, passed as `{ llm, agent }`.
    - Add **`'an incremental pass in a team agent's channel conversation files the speaker under their own key (TASK-1204)'`**. It is the TASK-1146 test at `~:646` with `agent: { visibility: 'team' }`.
    - Expect rows `` [`user:${ALICE}` (standup), 'billing_service' (Dana)] ``, both shared, and `speakerFacts: 0`.
- [ ] **Step 2: Run and see them fail:** `pnpm --filter @ax/memory exec vitest run src/__tests__/audience.test.ts src/__tests__/incremental.test.ts`.
- [ ] **Step 3: Implement** the interface changes above. Update the drift guard's `toStatements` call to `speakerScope: speakerScope(ctx, { visibility: 'personal' })`.
- [ ] **Step 4: Run** every memory test (`pnpm --filter @ax/memory test`), then the build. Expected: PASS. All the existing personal shared-turn tests pass unchanged.
- [ ] **Step 5: Commit:** `feat(memory): a team agent's observer files a member's facts under them (TASK-1204)`.

---

### Task 4: `memory_note` saves a member's note under them `[tier: sensitive]`

**security-checklist: required.** The model writes the subject, so this is untrusted input.

**Files:**
- Modify `packages/memory/src/note-tool.ts`:
  - the messages at `~:87-90`
  - the handler at `~:224-300`
  - the comments at `~:233-243`, `~:263-267` and `~:308-311`
- Test: `note-tool.test.ts`; plus `audience.test.ts` (team drift guard).

**Interfaces:**
- **Consumes:** Tasks 1 and 2.
- **Produces** (exact copy, model-facing):
```ts
export const TEAM_PERSON_KEY_MESSAGE =
  "Save it again with `user` as `about` if it's about the person you're talking with, " +
  "or the name of the person or thing it's about. Don't write a `user:` id.";
```

The handler's order (private turns keep today's order exactly):

1. The input checks (unchanged), then `when`.
2. If `audienceOf(ctx) !== 'private' || isOutsiderTurn(ctx)`, resolve access now: `access = await resolveMemoryAccess(bus, ctx)`. Then `scope = speakerScope(ctx, access)`. Otherwise the scope is `'private'`, and access is resolved where it is today.
3. **The cheap check, before the ask:**
   - Applies when the scope isn't `'private'` and `speakerSubject(scope, about, access.userId, [])` is `undefined`.
   - Refuses `forbidden` with `TEAM_PERSON_KEY_MESSAGE` (team) or `PERSON_IN_SHARED_MESSAGE` (withheld).
4. `captureCheck` (unchanged), with its refusal.
5. `access ??= await resolveMemoryAccess(bus, ctx)` (a private turn, as today).
6. `about = speakerSubject(scope, input.about, access.userId, check.speakerNames)`. If that's `undefined`, refuse with the scope's message.
7. The twin check, using `about`.
8. `recordFacts(bus, ctx, access, …, check.speakerNames)`.

Steps:

- [ ] **Step 1: Write the failing tests** in `note-tool.test.ts`, in a new describe: `'memory_note in a team agent's channel turn (TASK-1204)'`.
  - Setup:
    - `withHarness({}, { agent: { visibility: 'team' } })`
    - `memberCtx`: `source: 'user'`, shared, conversation `conv-channel`
    - `answerSpeakerNames(h.bus, ['Vinay Pulim','UHTE83XE1'])`
  - **`it.each(['user', 'vinay', 'Vinay', 'vinay_pulim', 'UHTE83XE1', 'user_vinay'])('a member's note about themself (%j) is saved under their own key')`:**
    - Expect: `{ ok: true }`.
    - Expect: `readRows` is `[{ about: \`user:${ALICE}\`, audience: 'shared', provenance: 'agent' }]`.
  - **`'a note about the work, or a third party by name, is saved as written'`:** for `team_standup` and `ada`.
  - **`it.each(['User', ' user', \`user:${BOB}\`, 'user:someone'])('a note under %j is refused before memory asks, saying how to file it')`:**
    - Expect: `{ ok: false, error: 'forbidden', message: \`${NOT_SAVED} ${TEAM_PERSON_KEY_MESSAGE}\` }`.
    - Expect: the ask list is `[]`, and no rows.
  - **`'a member's note and the observer's fact land on one row'`:**
    - The observer pass (team, `conv-channel`) stores `` `user:${ALICE}` | favorite_color | teal ``.
    - Then `note({ about: 'vinay', relation: 'favorite_color', value: 'teal' })` → `{ ok: true }`.
    - Expect: still one row.
  - **`'in an outsider turn on a team agent, a note about the person is still refused'`:**
    - ctx `source: 'external'`, shared; `{ about: 'user' }`.
    - Expect: refused with `PERSON_IN_SHARED_MESSAGE`; the ask list is `[]`; no rows.
  - **`'a team member's note reads access, then asks, then reads its twin and writes'`:**
    - Spy on `bus.call`, filtered to `agents:resolve` and `memory:facts:*`.
    - Expect `['agents:resolve', 'memory:facts:recall', 'memory:facts:record']`, plus one ask.
  - **Update `note-tool.test.ts:872`** (a personal agent, shared turn):
    - It now expects `memory:facts:*` calls `[]` and exactly one `agents:resolve`.
    - Comment: "a shared turn reads whose memory it is first (TASK-1204); still no memory read or written".
  - **In `audience.test.ts`, add `'drift guard, team agent member turn: the observer, memory_note and recordFacts file exactly what speakerSubject says (TASK-1204)'`:**
    - Team harness; ctx shared with `source: 'user'`; names `NAMES`.
    - For each subject in the existing `SUBJECTS`, let `expected = speakerSubject('team', about, ALICE, NAMES)`. Collect disagreements:
      - the observer: `toStatements(...).statements[0]?.about`
      - the note: the saved row's `about`, or `undefined` when refused `forbidden` with `TEAM_PERSON_KEY_MESSAGE`; `TOO_LONG_TO_READ` is excluded, as today
      - `recordFacts` with the raw `about`: refused iff `expected !== about`
      - `recordFacts` with `expected`: accepted whenever it is defined
    - Expect: disagreements `[]`.
- [ ] **Step 2: Run and see them fail:** `note-tool.test.ts` and `audience.test.ts`.
- [ ] **Step 3: Implement** the new flow and `TEAM_PERSON_KEY_MESSAGE`.
- [ ] **Step 4: Run** the memory suite, then the build. Expected: PASS. The existing personal-agent note tests pass unchanged, apart from the `:872` update.
- [ ] **Step 5: Commit:** `feat(memory): memory_note files a member's note under them in a team agent's channel (TASK-1204)`.

---

### Task 5: A team agent recalls everything, and an outsider is never "you" `[tier: sensitive]`

**security-checklist: required.** This is the read-side privacy boundary, removed on purpose for team agents.

**Files:**
- `packages/memory/src/audience.ts`: `recallAudienceScope` and `recallFacts` (`~:29-97`).
- `packages/memory/src/plugin.ts`:
  - the three `recallFacts` calls in `memory:recall` (`~:785`, `~:908`, `~:972`)
  - `ownSubject` (`~:1017`) and `aboutText` (`~:1056-1063`)
  - `readPriorRows`, `readRetractedValue` and `readRetractedRows` (`~:2125-2224`) take `access`
  - their closures in `observe()`, and the `registerMemoryNote` call (`~:1657`)
- `packages/memory/src/note-tool.ts`: `NotePriorRowsFn` (`~:159-162`) and `restatesExtractedRow` pass access.
- `packages/memory/src/augment.ts`:
  - `renderSubject`, `renderRecent`, `rankDigestSubjects` and `renderDigest` take `self: string | undefined`
  - `buildMemoryBlock` (`~:578-726`)
- Tests: `audience.test.ts`.

**Interfaces:**
- **Consumes:** none from earlier tasks. Task 4 already holds `access` before the twin check.
- **Produces:**
```ts
export function recallAudienceScope(ctx: Pick<AgentContext, 'audience'>, access: Pick<MemoryAccess, 'visibility'>): { audience?: 'shared' };
export async function recallFacts<TOut>(bus: HookBus, ctx: AgentContext, access: Pick<MemoryAccess, 'visibility'>, hookName: string, input: Record<string, unknown>): Promise<TOut | null>;
export type NotePriorRowsFn = (ctx: AgentContext, access: MemoryAccess, query: { abouts: string[]; ownerUserId: string; conversationId: string }) => Promise<PriorRow[]>;
export function rankDigestSubjects(rows: EngineFactRecord[], speakerSubject: string | undefined, limit: number): Array<{ about: string; count: number; latest: string }>;
```

Rules:

- **`recallAudienceScope`:**
  - `access.visibility === 'team'` → `{}`.
  - Otherwise `{ audience: 'shared' }` when `audienceOf(ctx) === 'shared'`, else `{}`.
- **`recallFacts`:** still strips any caller-built `audience`. The stamp backstop still runs only when the scope is `{ audience: 'shared' }`.
- **"Self":** `const self = isOutsiderTurn(ctx) ? undefined : rewriteSpeaker(SPEAKER_SUBJECT, ownerUserId)`. It's used in `buildMemoryBlock` and as `memory:recall`'s `ownSubject`. When `self` is `undefined`:
  - The block makes no Profile read and no profile chain read, and has no `### Profile` section.
  - No subject renders as `you`.
  - The digest excludes nothing.
  - `aboutText` never says `'you'`, so the turn's own key reads `'a teammate'`.
- **`about: 'user'` / `profile: true`:** the input rewrite stays `rewriteSpeaker(…, ownerUserId)`. Only owner routes send it.

Steps:

- [ ] **Step 1: Update and write the tests:**
  - **Bare-bus `recallFacts` unit tests** (`~:421-491`): pass `{ visibility: 'personal' }`, expectations unchanged. Add **`'a team agent's read carries no audience scope, and its answer is not checked for stamps'`**:
    - The stub engine answers a private-stamped row.
    - Expect: `recallFacts(bus, sharedCtx, { visibility: 'team' }, …)` returns it.
    - Expect: the engine's input has no `audience` key, even when the caller put one in.
  - **Split `'a private statement is never recalled in a shared turn (%s agent)'` (`~:133`):**
    - Keep the `personal` row as written.
    - Replace the team row with **`'a team agent's shared turn recalls everything (TASK-1204)'`**: the same setup with `{ agent: { visibility: 'team' } }`. Every `RECALL_SHAPES` read, the block and the tool include `SECRET`.
  - **`'a team agent's channel turn recalls what a member said in a web chat'`** (acceptance 2):
    - Setup:
      - Alice's web turn: `h.remember({ about: 'user', relation: 'lives in', value: 'Lisbon' }, h.ctx({ conversationId: 'conv-web' }))`.
      - Bob's web turn: `h.remember({ about: 'launch_plan', relation: 'codename', value: SECRET }, h.ctx({ userId: BOB, conversationId: 'conv-web-b' }))`.
      - `channel = h.ctx({ conversationId: 'conv-x', source: 'user', audience: 'shared' })`.
    - Expect: `values(await h.recall({ about: 'user' }, channel))` contains `'Lisbon'`.
    - Expect: `values(await h.recall({}, channel))` contains `'Lisbon'` and `SECRET`.
    - Expect: `augment(h, channel)` contains `'### Profile'`, `'Lisbon'` and `'Nightjar'`.
  - **`'no engine read in a team agent's turn carries an audience scope'`:**
    - Use `engineReadsDuring` over `h.recall({}, …)`, `augment` and `recallTool`, for both a member ctx and an outsider ctx.
    - Expect: no input has an `audience` key.
  - **`'in an outsider turn, the requester's own memory is never the person talking'`:**
    - Setup: team harness. Bob's private turn remembers `user | lives in | Boston`. `outsider = h.ctx({ userId: BOB, conversationId: CHANNEL, source: 'external', audience: 'shared' })`.
    - The block (`augment(h, outsider)`): `not.toContain('### Profile')`.
    - The tool (`recallTool(h, outsider, 'Boston')`): `toContain('a teammate lives in: Boston')` and `not.toMatch(/\| user lives in: Boston/)`.
    - Control, with `member = h.ctx({ userId: BOB, conversationId: 'conv-b', source: 'user', audience: 'shared' })`:
      - the block contains `'### Profile'` and `'Boston'`
      - the tool contains `'user lives in: Boston'`
  - **Personal agents:** the existing tests at `~:178`, `~:196`, `~:254` and `~:328` pass unchanged.
- [ ] **Step 2: Run and see them fail:** `audience.test.ts`.
- [ ] **Step 3: Implement.** Thread `access` through every `recallFacts` caller. `observe()` and the note already hold it.
- [ ] **Step 4: Run** the memory suite, including `augment.test.ts`, `recall-tool.test.ts` and `profile.test.ts`, then the build. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(memory): a team agent recalls everything, and an outsider's turn is never the requester (TASK-1204)`.

---

### Task 6: A team agent's sessions keep their `/memory` view `[tier: sensitive]`

**security-checklist: required.** This decides what a sandbox mounts.

**Files:**
- Modify `packages/memory/src/plugin.ts`: the `sandbox:memory-mounts` resolver (`~:661-705`) and the `MEMORY_MOUNT_WITHHELD_EVENT` doc (`:187-192`). The doc now says the event fires for a personal agent's session only.
- Test: `packages/memory/src/__tests__/export.test.ts` (`~:214-285`).

**Behavior:**
1. Validate the owner (unchanged), then build `ownerCtx`.
2. `access = await resolveMemoryAccess(bus, ownerCtx)`.
3. If `access.visibility !== 'team'` and the owner's `audienceOf(...)` isn't `'private'`: log `memory_mount_withheld` (`reason: 'shared-audience'`) and return `{ mounts: [] }`, with no flush.
4. Otherwise flush and return the mount.

**Steps:**

- [ ] **Step 1: Write the tests:**
  - **Widen `makeVolumeHarness`'s owner type** with `source?: string`.
  - **Update the personal `'%s session gets no memory mount and nothing is flushed'`:**
    - The call list is now `['sandbox:memory-mounts', 'agents:resolve']`.
    - Comment: "withheld after the access check, before the flush".
  - **Add `it.each([['a shared', { audience: 'shared' }], ['an outsider', { audience: 'shared', source: 'external' }], ['an unknown-audience', { audience: 'public' }]])("a team agent's %s session gets its mount")`:**
    - Setup: `makeVolumeHarness({ agent: { visibility: 'team' } })`, then a remember.
    - Expect: exactly one mount, `toMatchObject({ role: 'memory', mountPath: '/memory', readOnly: true })`.
    - Expect: no `memory_mount_withheld` event, and the host root isn't empty.
  - **Add `'a shared session whose owner may not use the personal agent is refused, not quietly withheld'`:**
    - `userId: BOB`, `audience: 'shared'`.
    - Expect: rejects with `forbidden`.
- [ ] **Step 2: Run and see them fail:** `export.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `export.test.ts`, then the memory suite and the build. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(memory): a team agent's sessions keep their /memory view (TASK-1204)`.

---

### Task 7: Say what changed: design doc, core contracts, comments, changeset, PR notes `[tier: mechanical]`

**Files:**
- **`docs/plans/2026-11-09-channel-slack-design.md`:**
  - **§4c "What stays hard" (`:1128-1130`): the stale line.** It says to file speaker facts by label name and Slack ID, "never `user:<ctx.userId>`". Replace it with the facts: a member's turn runs as the member, so their facts go under their own key `user:<ctx.userId>`, the same one their web chats write and read. Subjects the extractor writes with their label names go there too. An outsider's turn runs as the requester, so it files no person fact.
  - **Add "As built (TASK-1204)" bullets under §4c:**
    - the three scopes
    - outsiders keep the rule and are never "you"
    - recall is unscoped in every team session, outsider turns included (For Vinay; the one-line reversal)
    - the accepted residuals
    - the follow-ups
  - **§6 (`:1354-1356`):** a `shared` turn's filter is for personal agents (§4c).
  - **§6 (`:1388-1390`):** the subscriber-risk line gets the new `speakerNames` contract (Boundary review above).
- **`packages/core/src/context.ts:290-296`:** for a personal agent, `'shared'` recalls only shared statements and stores no speaker facts. A team agent's memory is the team's in every turn (design §4c).
- **`packages/core/src/memory-capture.ts:10-20`:**
  - In a turn that isn't private, memory doesn't file a subject made of these names, except in a team agent's member turn. There it files the subject under the person the turn runs as.
  - So a subscriber names only the people whose words the conversation's user turns carry.
- **Comments only:**
  - `packages/memory/src/subject.ts:34-52`: the shared-turn rule is now by scope.
  - `packages/memory/src/owner.ts:32-41`: a team agent's member turn files a member's facts under them, and an outsider's keeps none.
  - `packages/memory/src/capture.ts:46-51`: the names drop a shared fact, or file it under the runner on a team agent.
- **New `.changeset/memory-team-shared.md`** (`'@ax/memory': minor`). Use CLAUDE.md's voice: plain, "we", short sentences, and direct about the privacy change. Say:
  - A team agent now remembers what members say about themselves in Slack, under their own name in AX. It brings that up anywhere the agent works.
  - Outsiders' words still aren't remembered.
  - Personal agents are unchanged.
  - The trade: this removes a privacy boundary on purpose, and §4c's notices replace it.
- **PR body sections:**
  - **Boundary review:** copy the section above.
  - **Security note:** run the `security-checklist` skill over the whole diff. Pre-answered points:
    - **Sandbox escape:** N/A. The `/memory` mount is read-only, with the same spec as today. A team agent's shared and outsider sessions now get it, so exposure widens; nothing can be written.
    - **Prompt injection:** untrusted display names now decide where a fact is filed, but only ever into the runner's own key. Names are never logged, prompted or put in an error. Outsiders' words are refused by the veto and by memory's speaker rule in outsider turns. Outsider turns now recall the team's whole memory (For Vinay; the one-line reversal).
    - **Privacy:** one boundary is removed on purpose (§4c), and the notices (cards A/B) replace it.
    - **Supply chain:** N/A, no new dependencies.
  - **Follow-ups:**
    - The stale channel-slack comment lines listed in the decisions shard. Sync them after TASK-1202 merges.
    - Render a member's display name for `user:<id>` subjects in a team agent's turns.
    - Walk D: test the member's own recall, and that nothing is attributed to the requester. A teammate asking about someone by name depends on the previous item.

**Steps:**

- [ ] **Step 1:** Make the edits above. Then confirm nothing outside the plan and memory history still states the old universal rule. Run `grep -rn 'stores no speaker facts\|never \`user:<ctx.userId>\`\|recalls only shared statements' docs/plans/2026-11-09-channel-slack-design.md packages/core/src packages/memory/src`. Expected: no hit that describes a team agent.
- [ ] **Step 2:** Run `pnpm --filter @ax/core build && pnpm --filter @ax/memory build`. Then rebase onto `origin/main`. TASK-1202 may have merged, and the design doc is the only file it could share with this branch; on a conflict keep both edits. Then run the full gate: `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts && pnpm lint`.
- [ ] **Step 3:** Append any builder decisions to the shard, then commit: `docs: team memory is team-shared, as built (TASK-1204)`.
