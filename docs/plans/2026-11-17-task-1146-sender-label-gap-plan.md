# TASK-1146: No shared fact under the speaker's name (the sender-label gap) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In a shared (channel) turn, no write path (the observer, `memory_note`, `recordFacts`) stores a statement whose subject is the speaker's name as the conversation labels them (`vinay`). Work facts are still stored under a work subject. The walk's fact ends up stored once.

**Architecture:** `memory:pre-capture` is the question memory already asks before every extraction pass and every note. Its answer can now carry `speakerNames`. channel-slack records each member's sender-label name and Slack ID on the thread's row before their turn runs, and returns them when it lets memory learn. `breaksSpeakerRule(audience, about, speakerNames)` (TASK-1136's one rule) then also drops subjects made of those names, on all three paths. No new hook, no manifest change. One additive column.

**Tech Stack:** TypeScript, zod (`@ax/core`), Kysely + Postgres (channel-slack store, testcontainers), vitest, the better-sqlite3 memory harness (`packages/memory/src/__tests__/harness.ts`).

**Spec:** card TASK-1146 + Vinay's decision (2026-11-17, "CLOSE THE GAP"); walk `deploy/kind/walks/2026-11-16-TASK-1134/REPORT.md` finding 3; `docs/plans/2026-11-09-channel-slack-design.md` §2a, §6. Planner decisions, with every alternative weighed: `.claude/memory/decisions/2026-11-17-TASK-1146.md`. Read it first. Tasks 1–3 append their security-checklist rows there.

## The premise, checked

- **Measured on kind (read-only).** The walk's thread `cnv_jpTdTP3hA3slBoH0kWG2gQ` starts `[Slack · #ax-test-internal · vinay (UHTE83XE1)]: <@…> Our team standup moved to 10:15 on Tuesdays.` The facts store's only shared row is `vinay | stated_standup_time | Team standup moved to 10:15 on Tuesdays` (extracted). The walk's note was `about: 'user'` and was refused.
- **Why it slips through.** `isPersonSubject` (`audience.ts:119`) matches only `user` and `user:…`. The pinned extraction prompt asks for "snake_case entity identifiers" and never says `user`, so with a name in the content the extractor uses the name.
- **Refuted from the brief: "a Slack thread has multiple speakers across turns."** No conversation memory captures does. Conversations are keyed by user, agent and external key (`conversations/src/store.ts:1005`, `router.ts:476`), so a member's channel conversation holds only that member's turns. The outsiders' `:external` conversation mixes speakers, and the capture veto refuses it (`capture-veto.ts:57`). What does vary: a member's display name can change between turns, and the idle observer runs after the turn. So the names must be durable, and kept as a union.
- **The double store is code-true but was never observed.** `twins.ts:145` requires the same `about`, so `team_standup | time` (note) and `vinay | stated_standup_time` (observer) can't merge. The walk itself ran before TASK-1136's redirect, so the note was refused. Once a shared turn can't store `vinay | …` at all, the pair is just the note's row (pinned in Task 2).
- **`breaksSpeakerRule(audience, about)` can't close it as it stands.** The rule needs the names, so it gains a required third parameter. It stays one function.

## Approach (chosen) and why the others lost

Chosen: names ride `memory:pre-capture`'s answer. Rejected (details in the decisions shard):
- The AX name via `auth:get-user`. Slack nicknames aren't the AX name, and it gives memory a profile-read.
- A new ctx field. That's TASK-1091's 7-package session chain, fixed at spawn.
- A new hook. It would repeat the same lookup and fail open on its own.
- Memory parsing labels. That puts Slack vocabulary in memory.
- channel-slack re-parsing the transcript on every ask.
- An in-memory registry. It's lost on restart, and the idle pass runs after the turn.

## Boundary review (a changed subscriber payload: `memory:pre-capture`)

- **What changes:** `MemoryPreCapturePayload` gains optional `speakerNames: string[]` (≤ 32, each 1–256 code units). A subscriber that lets memory learn from a conversation, and labels the people speaking in its transcript, ADDS names to it. It appends and never removes. Memory reads the fire's final payload.
- **Alternate impl:** any channel that labels who wrote each message: Teams or Discord (display names), email-in (the From name). @ax/routines answers the same hook and adds no names.
- **Payload field names that might leak:** none. `speakerNames` are whatever the channel shows. Memory treats them as opaque text and only compares words.
- **Subscriber risk:** a subscriber that drops or rewrites names an earlier one added would let facts under them through, so the contract is append-only. A Slack-shaped value (a member ID) is just another name to memory.
- **Wire surface:** none. A host-only fire, never an IPC action.

## Global Constraints

- Don't touch `packages/memory/src/extraction-prompt.ts` (fingerprint-pinned `e7466bf4` / `06414f62`).
- Memory learns no Slack vocabulary. It doesn't parse labels, doesn't type-check member IDs, and imports nothing from channel-slack (invariants 1, 2). `speakerNames` are opaque strings.
- No new hook name and no manifest change (`registers`/`calls`/`optionalCalls`/`subscribes`), so the exact-list pins in `presets/k8s/src/__tests__/preset.test.ts` must not move.
- A name never goes into a log line, an error message or a prompt, in either package. channel-slack log lines stay ids, codes and counts only.
- Refusal texts are unchanged: `PERSON_IN_SHARED_MESSAGE`, `NOT_SAVED_HERE_MESSAGE`.
- `memory_note`'s order: input checks → the `user` check → `memory:pre-capture` → **the name check (new)** → access → twin read → write. The `user` refusal still comes before the ask (TASK-1094's pinned test `bad input, or a person-note in a shared turn, is refused for that reason before memory asks`).
- channel-slack sources spell invisible characters as `\u` escapes (`source-hygiene.test.ts`). Do the same in memory tests.
- The migration is additive and idempotent (it runs on every boot).
- Commands: the filter goes BEFORE the script (`pnpm --filter @ax/memory exec vitest run src/__tests__/audience.test.ts`). `tsc` doesn't type-check tests here, so also run `pnpm --filter <pkg> build`. Docker-backed suites (`channel-store.test.ts`, the k8s composition test) need an explicit `DOCKER_HOST`; `AX_TESTCONTAINER_START_SLOT_WAIT_MS` caps at 600000. Full gate before the PR: `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts && pnpm lint`.
- Memory rows go only to `.claude/memory/decisions/2026-11-17-TASK-1146.md`, appended. Never edit a root archive or delete a memory line.
- In GitHub text, `@ax/...` goes inside backticks.

## Review Focus

1. **A member's display name made of common work words** ("Standup Team"). Only that member's own conversation loses facts with those words as subject, and no other conversation is affected. Pinned in Task 3: two members' threads keep separate names. Pinned in Task 2: the rule reads only the names it is given.
2. **A display name changed mid-thread.** Both the old and the new name apply to later passes. Pinned in Task 3: the union test.
3. **An outsider's thread.** No names are stored, and memory is still refused. Pinned in Task 3 (store and router).
4. **A slow, failing or unreadable answer.** Nothing is captured or noted: it never counts as "allowed, with no names". Pinned in Task 2 (an unreadable answer throws on all three paths). Task 3 keeps the existing deadline/failure refusals green.
5. **Work facts and ownership values are kept** (`team_standup | owner | vinay`, `vinays_team | …`, `billing_service | …`). Pinned in Task 2: the matching table and the walk test.

## Files

| File | Change | Task |
|---|---|---|
| `packages/core/src/memory-capture.ts` | `speakerNames` in the schema; two bounds; header doc | 1 |
| `packages/core/src/index.ts:57-58` | export the two bounds | 1 |
| `packages/core/src/__tests__/memory-capture.test.ts` | schema rows | 1 |
| `packages/memory/src/capture.ts` | `captureRefusal` → `captureCheck` | 2 |
| `packages/memory/src/audience.ts` | `namesASpeaker`; `breaksSpeakerRule` 3rd param; `recordFacts` names; comments `:6-24`, `:96-145`, `:147-176` | 2 |
| `packages/memory/src/observer.ts` | `RunObserverInput.speakerNames`; `toStatements` opts; comments `:97`, `:168`, `:254-262`, `:732-740` | 2 |
| `packages/memory/src/note-tool.ts` | name check after the ask; names into `recordFacts`; comment `:225-231` | 2 |
| `packages/memory/src/plugin.ts` | `observe()` uses `captureCheck`; `ObserveDeps.speakerNames`; both producers pass it; comments `:1531`, `:2325` | 2 |
| `packages/memory/src/subject.ts:34-43`, `packages/memory/src/owner.ts:37-38` | comments only | 2 |
| `packages/memory/src/__tests__/{harness,audience,note-tool,observer,incremental}.test.ts` | helper + tests (harness is `harness.ts`) | 2 |
| `packages/channel-slack/src/migrations.ts` | `speaker_names` column; header `:23-41` | 3 |
| `packages/channel-slack/src/limits.ts` | `THREAD_SPEAKER_NAMES_MAX = 16` | 3 |
| `packages/channel-slack/src/format.ts` | `senderLabelNames` | 3 |
| `packages/channel-slack/src/channel-store.ts` | `ChannelThread.speakerNames`, `ThreadTurn`, `recordThread`, `getThread`; docs | 3 |
| `packages/channel-slack/src/router.ts:534-540` | pass names for a member's turn | 3 |
| `packages/channel-slack/src/capture-veto.ts` | return names when it lets memory learn; header `:13-21` | 3 |
| `packages/channel-slack/src/__tests__/{memory-channel-store.ts,channel-store,plugin,capture-veto,router,format}.test.ts` | fake + tests | 3 |
| `presets/k8s/src/__tests__/channel-slack-composition.test.ts:1586-1660` | names through the real preset | 4 |
| `docs/plans/2026-11-09-channel-slack-design.md` | §2a `:155-164`; §6 after `:571` | 5 |
| `.changeset/memory-shared-speaker-rule.md`, new `.changeset/memory-speaker-names.md` | release notes | 5 |

Order: 1 → (2 ∥ 3) → 4 → 5. Tasks 2 and 3 touch disjoint packages and both consume only Task 1.

---

### Task 1: The `memory:pre-capture` answer can name the speakers `[tier: sensitive]`

**security-checklist: required.** It's a hook payload that carries external-system text (Slack profile names) into a privacy filter. One walk covers Tasks 1 and 3's payload: sandbox N/A, injection (bounded, opaque, compared only), supply chain N/A.

**Files:** Modify `packages/core/src/memory-capture.ts`, `packages/core/src/index.ts:57-58`. Test: `packages/core/src/__tests__/memory-capture.test.ts`.

**Interfaces (produces):**
```ts
export const MEMORY_PRE_CAPTURE_SPEAKER_NAMES_MAX = 32;
export const MEMORY_PRE_CAPTURE_SPEAKER_NAME_MAX = 256; // UTF-16 code units
export const MemoryPreCapturePayloadSchema: z.ZodObject<{
  conversationId: z.ZodString;                                   // unchanged
  speakerNames: z.ZodOptional<z.ZodArray<z.ZodString>>;          // .min(1).max(NAME_MAX) items, .max(NAMES_MAX)
}>;
export type MemoryPreCapturePayload = { conversationId: string; speakerNames?: string[] };
```

- [ ] **Step 1: Write the failing tests** (in the existing `describe`):

```ts
it('bounds speaker names at 32, each at most 256 code units', () => {
  expect(MEMORY_PRE_CAPTURE_SPEAKER_NAMES_MAX).toBe(32);
  expect(MEMORY_PRE_CAPTURE_SPEAKER_NAME_MAX).toBe(256);
});
it('keeps the speaker names a subscriber added (TASK-1146)', () =>
  expect(MemoryPreCapturePayloadSchema.parse({ conversationId: 'c', speakerNames: ['Vinay Pulim', 'UHTE83XE1'] }))
    .toEqual({ conversationId: 'c', speakerNames: ['Vinay Pulim', 'UHTE83XE1'] }));
it('accepts 32 names of 256', () =>
  expect(MemoryPreCapturePayloadSchema.safeParse({ conversationId: 'c', speakerNames: Array(32).fill('x'.repeat(256)) }).success).toBe(true));
it.each([
  ['speakerNames that is not a list', { conversationId: 'c', speakerNames: 'vinay' }],
  ['a speaker name that is not a string', { conversationId: 'c', speakerNames: [7] }],
  ['an empty speaker name', { conversationId: 'c', speakerNames: [''] }],
  ['a speaker name over 256', { conversationId: 'c', speakerNames: ['x'.repeat(257)] }],
  ['33 speaker names', { conversationId: 'c', speakerNames: Array(33).fill('x') }],
])('refuses %s', (_l, value) => expect(MemoryPreCapturePayloadSchema.safeParse(value).success).toBe(false));
```

- [ ] **Step 2: Run** `pnpm --filter @ax/core exec vitest run src/__tests__/memory-capture.test.ts`. Expected: FAIL (the constants aren't exported; `speakerNames` is stripped).
- [ ] **Step 3: Implement.** Add the field and the two constants. Extend the header comment with the contract. A subscriber that lets memory learn from the conversation, and labels the people speaking in its transcript by name, appends those names as `speakerNames`, and never removes one an earlier subscriber added. In a turn that isn't private, memory stores no statement whose subject is made of them (TASK-1146). They're untrusted display text: memory only compares words with them, and never logs them or puts them in a prompt. Export both constants from `index.ts:57`.
- [ ] **Step 4: Run** the file again (PASS) and `pnpm --filter @ax/core build` (clean).
- [ ] **Step 5: Commit** `[TASK-1146] core: memory:pre-capture answers can name the speakers`.

---

### Task 2: Memory drops a speaker's name on every write path `[tier: sensitive]`

**security-checklist: required.** It's the shared-memory privacy filter on all three write paths, run over untrusted model output (subjects) and untrusted display names.

**Files:**
- Modify: `packages/memory/src/capture.ts` (the whole file), `audience.ts`, `observer.ts`, `note-tool.ts`, `plugin.ts`, plus `subject.ts` and `owner.ts` (comments only)
- Test: `packages/memory/src/__tests__/harness.ts` (helper), `audience.test.ts`, `note-tool.test.ts`, `observer.test.ts`, `incremental.test.ts`

**Interfaces:**
- Consumes: Task 1's `MemoryPreCapturePayloadSchema` and `MemoryPreCapturePayload`.
- Produces (memory-internal):
```ts
// capture.ts: replaces captureRefusal (delete it; plugin.ts and note-tool.ts are its only callers)
export type CaptureCheck =
  | { readonly refusal: Rejection; readonly speakerNames?: undefined }
  | { readonly refusal?: undefined; readonly speakerNames: readonly string[] };
export async function captureCheck(bus: HookBus, ctx: AgentContext): Promise<CaptureCheck>;
// audience.ts
export function namesASpeaker(about: string, speakerNames: readonly string[]): boolean;
export function breaksSpeakerRule(audience: AgentContextAudience, about: string, speakerNames: readonly string[]): boolean; // 3rd param REQUIRED
export async function recordFacts<TOut>(bus: HookBus, ctx: AgentContext, hookName: string,
  input: { batchKey?: string; statements: ReadonlyArray<object> }, speakerNames?: readonly string[]): Promise<TOut | null>;
// observer.ts
RunObserverInput.speakerNames: readonly string[];            // required, like `audience`
toStatements(facts, opts: { ownerUserId: string; conversationId?: string | undefined;
  audience: AgentContextAudience; speakerNames: readonly string[] });
// plugin.ts (private)
ObserveDeps.speakerNames: readonly string[];
// harness.ts (test helper)
export function answerSpeakerNames(bus: HookBus, names: readonly string[], conversationId?: string): MemoryPreCapturePayload[];
```

**Behaviour to implement:**
- `captureCheck`. No `ctx.conversationId`: `{ speakerNames: [] }`, no fire. Otherwise fire `{ conversationId }` exactly as `captureRefusal` does today: same bound, and `speakerNames` is NOT pre-filled, so the existing `asked` payload assertions hold. A rejection returns `{ refusal }`. Otherwise `MemoryPreCapturePayloadSchema.safeParse(asked.payload)`. Failure throws `PluginError({ code: 'invalid-return', plugin: PLUGIN_NAME, hookName: MEMORY_PRE_CAPTURE_HOOK })` with a message that names no value. Use `invalid-return`, NOT `invalid-payload`: `memory_note`'s catch maps `invalid-payload` to `invalid-input`, whose text ("a field may be too long…") would make the model retry a fine note, while `invalid-return` maps to `memory-unavailable`, as `recallFacts`' backstop does for an answer it can't trust. Success returns `{ speakerNames: data.speakerNames ?? [] }`.
- `namesASpeaker`. Compute the words of a text as `text.normalize('NFKC').replace(/\p{Cf}/gu, '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').match(/[\p{L}\p{N}]+/gu) ?? []`. A subject with no words is `false`. It is `true` when (a) every subject word is a word of some speaker name (the pool is the union over all names), or (b) the subject's words joined with `''` equal one name's words joined with `''`. `isPersonSubject` is unchanged.
- `breaksSpeakerRule`: `audience !== 'private' && (isPersonSubject(about) || namesASpeaker(about, speakerNames))`.
- `recordFacts`. Use `speakerNames` when given. If it isn't given and the audience isn't private, call `captureCheck`. A refusal throws `PluginError({ code: 'forbidden', hookName })` that names no statement (e.g. "a shared-audience write through ${hookName} in a conversation memory may not learn from: memory writes none of the batch"). Then `refuseSpeakerFacts(audience, statements, names, hookName)`. A private write never asks.
- `observe()` (`plugin.ts:1734`). `const check = await captureCheck(bus, ctx)`. A refusal logs and returns exactly as today (`refusedBy: check.refusal.source`, `reason: check.refusal.reason`). Pass `speakerNames: check.speakerNames` in the deps, and `recordFacts(bus, ctx, FACTS_RECORD_HOOK, input, check.speakerNames)` in `record`. `observeMessages` (`:1872`) and the incremental `runTurnObserver` call (`:2037`) pass `speakerNames` through. `extractAndRecord` passes `input.speakerNames` to `toStatements`, which calls `breaksSpeakerRule(opts.audience, fact.subject, opts.speakerNames)`.
- `memory_note`. Keep `breaksSpeakerRule(audienceOf(ctx), about, [])` where it is (`:232`). Comment: the `user` half, before the ask, TASK-1094's order. Replace `captureRefusal` with `captureCheck` (same refusal handling). Right after it, `if (breaksSpeakerRule(audienceOf(ctx), about, check.speakerNames)) throw new NoteInputError(PERSON_IN_SHARED_MESSAGE, 'forbidden')`. Pass `check.speakerNames` to `recordFacts`. A note asks once.

- [ ] **Step 1: Add the harness helper** `answerSpeakerNames` to `harness.ts`. It subscribes `memory:pre-capture` as `'test-speaker-names'`, records each payload it is asked with, and, when `conversationId` is absent or matches, returns `{ ...payload, speakerNames: [...(payload.speakerNames ?? []), ...names] }`. Otherwise it returns `undefined`.

- [ ] **Step 2: Write the failing tests.**

`audience.test.ts`. The matching table (new constants next to `PERSON_SUBJECTS`):
```ts
// Spelled as escapes in the test file, never as the characters (one is invisible, one a lookalike):
const FULLWIDTH_VINAY = '\uFF56\uFF49\uFF4E\uFF41\uFF59'; // fullwidth "vinay"
const ZWSP_VINAY = 'vi\u200Bnay';                                // zero-width space inside
const NAMES = ['Vinay Pulim', 'UHTE83XE1'];
const NAMES_A_SPEAKER = ['vinay', 'Vinay', 'VINAY', ' vinay ', 'pulim', 'vinay_pulim', 'Vinay Pulim', 'vinay-pulim',
  'vinay.pulim', 'pulim_vinay', 'vinaypulim', 'uhte83xe1', 'vinay_uhte83xe1', FULLWIDTH_VINAY, ZWSP_VINAY];
const NOT_A_SPEAKER = ['team_standup', 'vinays_team', 'vinay_s_team', 'vinay_laptop', 'user_vinay', 'billing_service',
  'assistant', 'v', 'vin', '', '___'];
describe("namesASpeaker — a subject made of a speaker's names (TASK-1146)", () => {
  it.each(NAMES_A_SPEAKER)('%j names a speaker', (about) => expect(namesASpeaker(about, NAMES)).toBe(true));
  it.each(NOT_A_SPEAKER)('%j does not', (about) => expect(namesASpeaker(about, NAMES)).toBe(false));
  it.each(['jose', 'José', 'JOSÉ', 'garcia', 'jose_garcia'])('%j names José García: accents fold both ways', (about) =>
    expect(namesASpeaker(about, ['José García'])).toBe(true));
  it('a run-together name matches its split spelling, both ways', () => {
    expect(namesASpeaker('vinay_pulim', ['VinayPulim'])).toBe(true);
    expect(namesASpeaker('vinaypulim', ['Vinay Pulim'])).toBe(true);
  });
  it('no names, or names with no letters or digits, match nothing', () => {
    expect(namesASpeaker('vinay', [])).toBe(false);
    expect(namesASpeaker('x', ['🌴', '()'])).toBe(false);
  });
});
```
`breaksSpeakerRule`. Every existing call gains `[]`. The existing `'%j never breaks it'` row keeps `'vinay'` and is renamed "with no speaker names, %j never breaks it". New:
```ts
it.each(NAMES_A_SPEAKER)("%j breaks it in a shared or unknown audience when a speaker has that name, never in a private one", (about) => {
  expect(breaksSpeakerRule('shared', about, NAMES)).toBe(true);
  expect(breaksSpeakerRule('public' as AgentContextAudience, about, NAMES)).toBe(true);
  expect(breaksSpeakerRule('private', about, NAMES)).toBe(false);
});
it.each(NOT_A_SPEAKER)('%j never breaks it, names or not', (about) => { /* false for private, shared, public with NAMES */ });
```
The drift guard (`:699`). `SUBJECTS = [...new Set([...PERSON_SUBJECTS, ...NOT_PERSON_SUBJECTS, ...NAMES_A_SPEAKER, ...NOT_A_SPEAKER])]`. Call `answerSpeakerNames(h.bus, NAMES)` and `answerSpeakerNames(engine, NAMES)`. `rule = breaksSpeakerRule(audienceOf(ctx), about, NAMES)`. The observer gets `speakerNames: NAMES`. `recordFacts` is called WITHOUT names, so it asks the `engine` bus. Non-vacuous count: shared → `PERSON_SUBJECTS.length + NAMES_A_SPEAKER.length`, else 0. Update its header comment: names now break it, and the walk's `vinay` is in `NAMES_A_SPEAKER`.

The observer, end to end (in the speaker `describe`, `:577`):
- `'a shared turn stores nothing under a speaker name either (TASK-1146)'`. The LLM returns `SPEAKER_FACTS` plus `{ subject: 'vinay', predicate: 'stated_standup_time', object: 'Team standup moved to 10:15 on Tuesdays' }` and `{ subject: 'Vinay_Pulim', predicate: 'prefers', object: 'tea' }`. Call `answerSpeakerNames(h.bus, NAMES)`. `storedRows(h)` equals the billing row alone, and the run line has `{ outcome: 'recorded', recorded: 1, speakerFacts: 6 }`.
- `'a private turn files a speaker name as written: names only matter where others read'`. Same names, `h.ctx({ conversationId: PRIVATE_CONV })`, and a row `about: 'vinay'` is stored `private`.
- `'the walk, end to end: the work note is the one row, and nothing is filed under the speaker (TASK-1134, TASK-1146)'`. LLM returns `vinay | stated_standup_time | Team standup moved to 10:15 on Tuesdays` and `assistant | could_not_save_memory | the standup time`. Call `answerSpeakerNames(h.bus, ['vinay', 'UHTE83XE1'])`. `ctx = h.ctx({ conversationId: CHANNEL, source: 'user', audience: 'shared' })`. Notes: `about: 'user'` is refused `forbidden`; `about: 'vinay'` is refused `forbidden` with `PERSON_IN_SHARED_MESSAGE`; `{ about: 'team_standup', relation: 'time', value: '10:15 on Tuesdays' }` gives `{ ok: true }`. Then `observeTurn(h, ctx, [{ role: 'user', content: '[Slack · #ax-test-internal · vinay (UHTE83XE1)]: Our team standup moved to 10:15 on Tuesdays.' }, { role: 'assistant', content: 'Got it: team standup is at 10:15 on Tuesdays.' }])`. `storedRows(h).map((r) => [r.about, r.audience])` equals `[['team_standup', 'shared']]`, and the run line has `{ outcome: 'skipped', reason: 'only-speaker-facts', speakerFacts: 1 }`. **Control** (same test, a fresh harness with NO names answer): the observer pass stores `vinay` too. That's the bug this card fixes, and it shows the test isn't vacuous.

`recordFacts` (in `recordFacts — the one door…`):
- `'with no names given, a shared write asks memory:pre-capture once and refuses a speaker name, sending nothing'`. Answer `['vinay']`, statement `{ about: 'vinay' }`: `forbidden`, the engine was never called, the answer recorded `[{ conversationId }]`, and the message doesn't contain `vinay`. The ctx needs a `conversationId`: extend the local `turn()` helper.
- `'names given: it asks nothing'`. Spy on `bus.fire`, pass `['vinay']`: no `memory:pre-capture` fire, and still `forbidden`.
- `'a refused ask refuses the batch'`. A subscriber rejects: `forbidden`, nothing written.
- `'a private write never asks'`. Spy on `bus.fire`: zero `memory:pre-capture` fires.
- `'an answer memory cannot read throws invalid-return, and nothing is written'`. The subscriber returns `{ ...payload, speakerNames: 'vinay' }`.

`note-tool.test.ts`. New `describe('a note under a speaker name in a shared turn (TASK-1146)')`, with `memberCtx = h.ctx({ conversationId: 'conv-channel', source: 'user', audience: 'shared' })`:
- `it.each(['vinay', 'Vinay', 'vinay_pulim', 'UHTE83XE1'])('memory_note about %j is refused like `user`, after memory asks once')`. With `asked = answerSpeakerNames(h.bus, ['Vinay Pulim', 'UHTE83XE1'])`, the result equals `{ ok: false, error: 'forbidden', message: \`NOT SAVED: nothing was written to memory — do not tell the person it was saved. ${PERSON_IN_SHARED_MESSAGE}\` }`, `asked` equals `[{ conversationId: 'conv-channel' }]`, and no rows are stored. Control: the same note in `h.ctx({ conversationId: 'conv-9' })` is `{ ok: true }`.
- `'a work note in the same turn is saved, stamped shared, with one ask'`. `{ about: 'team_standup', relation: 'owner', value: 'vinay' }` gives `{ ok: true }`, `asked` has length 1 (no second ask from `recordFacts`), and the row is `{ about: 'team_standup', audience: 'shared' }`. This also pins Review Focus 5: a person in the VALUE is kept.
- `'with no names answered, a note under a name is saved: names come only from memory:pre-capture'`. `about: 'vinay'` gives `{ ok: true }`. This documents the contract channels must meet.
- `'an answer memory cannot read saves nothing'`. The subscriber returns `speakerNames: 'vinay'`: `error: 'memory-unavailable'`, no rows.

`observer.test.ts`:
- `'an answer memory cannot read records nothing, warns, and keeps the turns for the next pass'`. `chat:end` on a conversation whose subscriber returns `{ ...payload, speakerNames: [7] }`: no rows, the LLM is never called, and an `OBSERVER_FAILED_EVENT` line at `warn` with `reason: 'observer-threw'`.

`incremental.test.ts` (next to `an unrefused conversation is captured as before…`, `:679`):
- `'an incremental pass in a shared conversation drops the speaker name too (TASK-1146)'`. Same env, the ctx gets `audience: 'shared', source: 'user'`. Call `answerSpeakerNames(env.h.bus, ['Vinay Pulim', 'UHTE83XE1'])`. The stub extractor returns `vinay | stated_standup_time | …` and `billing_service | owner | Dana`. After the pass, only the billing row is stored, and the run line has `speakerFacts: 1`.

- [ ] **Step 3: Run** `pnpm --filter @ax/memory exec vitest run src/__tests__/audience.test.ts src/__tests__/note-tool.test.ts src/__tests__/observer.test.ts src/__tests__/incremental.test.ts`. Expected: the new tests FAIL (`namesASpeaker` doesn't exist; `vinay` is stored; `vinay` notes are saved).
- [ ] **Step 4: Implement** `capture.ts`, then `audience.ts`, then `observer.ts` + `plugin.ts`, then `note-tool.ts`, per *Behaviour to implement*.
- [ ] **Step 5: Comments (rule 5, in this task's files).** Wherever a comment defines the rule as only `user`/`user:<id>` or calls the label name "§2a's accepted gap", say instead that it covers `user`, `user:<id>` and the speakers' names from `memory:pre-capture`. Those comments: `audience.ts:6-24` (header), `:96-107` (keep `isPersonSubject`'s own residual, and point at `namesASpeaker` for names), `:124-145`, `:163-176`; `subject.ts:34-43`; `observer.ts:97`, `:168`, `:254-262` (the new field's doc), `:732-740`; `plugin.ts:1531`, `:2325`; `owner.ts:37-38`; `capture.ts` header; `note-tool.ts:225-231`.
- [ ] **Step 6: Run** `pnpm --filter @ax/memory test` (all PASS) and `pnpm --filter @ax/memory build` (clean). Grep: `grep -rn "captureRefusal\|accepted gap" packages/memory/src` → no hits.
- [ ] **Step 7: Mutation spot-checks, one at a time, each expected to fail ≥ 1 test.** Record the results in the decisions shard. The mutants:
  - `toStatements` ignores names
  - the note's name check is removed
  - `recordFacts` neither uses nor asks for names
  - `captureCheck` returns `[]` whatever the answer
  - an unreadable answer is treated as `[]`
  - "every word" becomes "any word"
  - the accent fold is dropped
  - NFKC is dropped
  - `!== 'private'` becomes `=== 'shared'`
  - the joined-spelling rule is removed
  - the note asks twice (`recordFacts` re-asks even when given names)
- [ ] **Step 8: security-checklist** (sandbox N/A, injection, supply chain N/A). Append the row to the decisions shard.
- [ ] **Step 9: Commit** `[TASK-1146] memory: no shared fact filed under the speaker's name`.

---

### Task 3: channel-slack records each member's label names and hands them to memory `[tier: sensitive]`

**security-checklist: required.** It stores untrusted Slack profile text (a migration), and that text crosses the bus.

**Files:**
- Modify: `migrations.ts`, `limits.ts`, `format.ts`, `channel-store.ts`, `router.ts:534-540`, `capture-veto.ts` (all under `packages/channel-slack/src/`)
- Test: `__tests__/memory-channel-store.ts` (the fake), `channel-store.test.ts` and `plugin.test.ts` (real Postgres), `capture-veto.test.ts`, `router.test.ts`, `format.test.ts`

**Interfaces:**
- Consumes: Task 1's `MEMORY_PRE_CAPTURE_SPEAKER_NAMES_MAX` and `MemoryPreCapturePayload`.
- Produces:
```ts
// limits.ts
export const THREAD_SPEAKER_NAMES_MAX = 16;
// format.ts: the names a sender label shows for its sender, in label order, each once, empties dropped
export function senderLabelNames(name: string, slackUserId: string): string[];
// channel-store.ts
interface ChannelThread { /* …existing… */ speakerNames: string[] }
export type ThreadTurn = { mode: 'attended'; speakerNames: readonly string[] } | { mode: 'external'; runAs: string };
// capture-veto.ts
export async function channelCaptureVeto(channels, ctx, payload, deadlineMs?):
  Promise<Rejection | MemoryPreCapturePayload | undefined>;
```

**Behaviour to implement:**
- **Migration.** Add `ALTER TABLE channel_slack_v1_threads ADD COLUMN IF NOT EXISTS speaker_names TEXT[] NOT NULL DEFAULT '{}'`, with `speaker_names: ColumnType<string[], string[] | undefined, string[]>` in the table type. Header: the threads paragraph says the row also keeps the names a member's turns were labelled with, for memory's speaker rule. The "Nor is anyone's name" sentence (`:39-41`) becomes true again by saying the threads table holds members' Slack display names and IDs (Slack's text, as the label showed it), and auth's names stay auth's.
- **`recordThread`, the same single statement.** INSERT `speaker_names = ${names}::text[]`. That binds the JS array as one Postgres array parameter, as `packages/attachments/src/store.ts:315` does; `sql.join` would expand it, so don't use it. `names` is the attended turn's names, deduplicated and capped at the last 16. An external turn gets `[]`. ON CONFLICT keeps the union, ordered by last seen, holding the 16 most recent:
  ```sql
  speaker_names = (SELECT COALESCE(array_agg(n ORDER BY seen), '{}') FROM (
    SELECT n, max(o) AS seen FROM unnest(channel_slack_v1_threads.speaker_names || EXCLUDED.speaker_names)
      WITH ORDINALITY AS u(n, o) GROUP BY n ORDER BY max(o) DESC LIMIT ${THREAD_SPEAKER_NAMES_MAX}) AS kept)
  ```
  The `recordThread` parameter type becomes `Omit<ChannelThread, 'notRemembered' | 'external' | 'speakerNames'> & { conversationId: string } & ThreadTurn`, so names arrive only through an attended `ThreadTurn`. `getThread` selects the column as `speakerNames`. The fake (`memory-channel-store.ts`) mirrors the same union, order and cap in TypeScript, and its header comment (`:12-19`) says so. Doc comments:
  - `ChannelThread.speakerNames`: the names member turns here were labelled with (display name, Slack ID), oldest first, at most 16. Empty for an outsiders' thread, and for a row from before TASK-1146 until its next member turn.
  - `recordThread`: a member's turn adds its names to the thread's, in the same statement.
- **Router.** The attended branch passes `{ mode: 'attended', speakerNames: senderLabelNames(admission.name, m.sender) }`, the same `admission.name` and `m.sender` the label at `:556` uses. The external branch is unchanged.
- **Veto.** `refusalFor` becomes a lookup returning `{ refusal: Refusal | null; speakerNames: readonly string[] }`. Names come only from a thread it doesn't refuse (an unrecorded conversation has none). After the existing refusal logic, which is unchanged: `names = dedupe([...own names from every id asked, ...(parsed.success ? parsed.data.speakerNames ?? [] : [])]).slice(0, MEMORY_PRE_CAPTURE_SPEAKER_NAMES_MAX)`. None means `undefined` (no opinion, as today). Otherwise return `{ conversationId: parsed.success ? parsed.data.conversationId : ctx.conversationId, speakerNames: names }`. Read `thread.speakerNames` as typed, with no `?? []` default. A thread row without the field then throws inside the veto's `try` and is refused as `capture-check-failed`, which fails closed. A default would quietly answer with no names. Names aren't logged. Update the header `:13-21`. Add a comment at the external refusal (`:56-57`): outsiders' threads record no names, so lifting this refusal must record theirs first.

- [ ] **Step 1: Write the failing tests.**
  - `format.test.ts`. `senderLabelNames('Vinay Pulim', 'U123')` equals `['Vinay Pulim', 'U123']`. `senderLabelNames('', 'U123')` equals `['U123']`. Every name it returns appears in `channelSenderLabel('support', 'Vinay Pulim', 'U123')`, which pins that the names are the label's.
  - `channel-store.test.ts` (real Postgres). Extend the `record()` helper with an optional `speakerNames` (default `['Mel', 'U07MEL00001']` for attended). Tests:
    - `'a member turn records its label names; getThread returns them'`.
    - `'a second turn adds nothing it already has, and a rename adds the new name: both stay'`. `['Mel', 'U1']`, then `['Mel B', 'U1']`, gives `['Mel', 'Mel B', 'U1']` (`U1` was seen last).
    - `'keeps the 16 most recently seen names'`. 17 turns `['n0'..'n16']`, each with `'U1'`: the result has length 16, contains `'U1'` and `'n16'`, and doesn't contain `'n0'`.
    - `"an outsider's turn records no names"`.
    - `"two members' threads keep their own names"` (Review Focus 1).
    - Migration: `'adds speaker_names to a thread table made before it, every old row with none'`. Model on the existing `external` migration test, `:158`.
    - The existing idempotence test still passes, with `speakerNames` in its expected thread.
  - `capture-veto.test.ts`. The `thread()` helper default gains `speakerNames: []` (existing "no opinion" tests stay `undefined`). New `describe('channelCaptureVeto: the speakers memory must not file facts under (TASK-1146)')`:
    - `'a thread it lets memory learn from answers with its names'`. Result `{ conversationId: THREAD, speakerNames: ['Mel', 'U07MEL00001'] }`.
    - `'a refused thread answers the refusal and no names'`. Both the not-remembered thread and the outsider thread.
    - `"keeps names an earlier subscriber added, after its own, once each, at most 32"`.
    - `'both ids asked about contribute names'`.
    - `'an unreadable payload: ctx.conversationId, and its own names'`.
    - The existing deadline/failure tests still refuse (no names on any failure).
  - `plugin.test.ts`, the end-to-end switch test (real store, real wiring, `:1626-1655`). `getThread(offThread)` now also equals `speakerNames: ['Ada', 'U07ADA00001']`: the fixture's `real_name: 'Ada'`, and `ADA_SLACK` (`:84`). `askMemory(harness.bus, onThread)` equals `{ rejected: false, payload: { conversationId: onThread, speakerNames: ['Ada', 'U07ADA00001'] } }`. `conv_web_chat` is unchanged (no names). The refused threads are unchanged.
  - `router.test.ts`. The expected attended write in `"switch off: the turn's conversation is recorded…"` (`:2374`) gains `speakerNames: ['Alice Smith', 'U07ALICE001']`. The default sender is ALICE, whose fixture has an empty `display_name`, so the label falls back to `real_name`. The external write (`:2396`) has no `speakerNames`. New: `'a sender with no display name is recorded by their Slack id alone'`. Add a `member(…)` fixture with an empty `real_name` too: the result is `speakerNames: [<its id>]`.
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/format.test.ts src/__tests__/capture-veto.test.ts src/__tests__/router.test.ts`, and, with `DOCKER_HOST` set, `src/__tests__/channel-store.test.ts src/__tests__/plugin.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** per *Behaviour to implement*.
- [ ] **Step 4: Run** `pnpm --filter @ax/channel-slack test` (all PASS, `source-hygiene.test.ts` included) and `pnpm --filter @ax/channel-slack build`.
- [ ] **Step 5: Mutation spot-checks, each expected to fail ≥ 1 test:**
  - the router passes `[]`
  - outsiders' names are recorded
  - the conflict overwrites instead of taking the union
  - the cap keeps the oldest
  - the veto returns names for a refused thread
  - the veto drops an earlier subscriber's names
  - `getThread` omits the column
- [ ] **Step 6: security-checklist.** One walk covers Task 1's field and this task. Append the row to the decisions shard.
- [ ] **Step 7: Commit** `[TASK-1146] channel-slack: tell memory who is speaking in a member's thread`.

---

### Task 4: Names reach memory's question through the real k8s preset `[tier: integration]`

**Files:** Modify `presets/k8s/src/__tests__/channel-slack-composition.test.ts`, the test `the channel's memory switch…` (`:1586`).

**Interfaces:** consumes Tasks 1 and 3. Mel is `{ slackId: 'U07MEL00001', name: 'Mel' }` (`:119`). The Slack fake serves `display_name: p.name` (`:278`).

- [ ] **Step 1: Write the assertions** (replace the bare `.rejected` checks after Mel's first turn):
```ts
expect(await preCapture(conv1)).toEqual({ rejected: false, payload: { conversationId: conv1, speakerNames: ['Mel', 'U07MEL00001'] } });
expect(await preCapture('cnv_a_web_chat')).toEqual({ rejected: false, payload: { conversationId: 'cnv_a_web_chat' } });
```
  After `conv3` (a new thread, switch on): `speakerNames: ['Mel', 'U07MEL00001']` too. The outsider and switch-off assertions are unchanged (refused, no payload).
- [ ] **Step 2: Run** `pnpm --filter @ax/preset-k8s exec vitest run src/__tests__/channel-slack-composition.test.ts` with `DOCKER_HOST` set. Expected: PASS once Tasks 1 and 3 are committed. Without Task 3's router change, the first assertion fails: the payload has no `speakerNames`. That is the wiring miss this task exists to catch.
- [ ] **Step 3: Commit** `[TASK-1146] preset-k8s: a member's mention hands memory their label names`.

---

### Task 5: Docs, stale lines, changesets `[tier: mechanical]`

**Files:** `docs/plans/2026-11-09-channel-slack-design.md`, `.changeset/memory-shared-speaker-rule.md`, create `.changeset/memory-speaker-names.md`. No code.

- [ ] **Step 1: §2a (`:155-164`).** Replace the speaker-rule bullet and the "Known gaps, accepted" bullet with this:
  - The rule drops `user`, `user:…`, AND a subject made of the speakers' label names (TASK-1146). channel-slack records each member's label name and Slack ID on the thread's row before their turn runs, and hands them over with its `memory:pre-capture` answer. Outsiders' threads record none, since memory never learns from them.
  - A subject counts when all its words are words of those names (`vinay`, `vinay_pulim`), so `vinays_team`, `team_standup` and `team_standup | owner | vinay` are kept. One function, `breaksSpeakerRule`, serves all three paths.
  - Known gaps, accepted: someone named only in what's said ("Ada is out next week") is still stored (telling a person from a thing would need the pinned extraction prompt); a nickname the label doesn't show; slot closure is tenant-wide; a Fix on a shared memory saves as private.
  - Keep the walk's measured example, as the reason the rule exists.
- [ ] **Step 2: §6.** Insert the *Boundary review* above (a short paragraph and four bullets) after `:571`, before **Finding a user by verified email**.
- [ ] **Step 3: `.changeset/memory-shared-speaker-rule.md`.** Delete the two sentences starting "One gap we know about" and "The note-taker does that on its own". They're false once this ships, and both changesets land in the same release notes.
- [ ] **Step 4: Create `.changeset/memory-speaker-names.md`** with `'@ax/core': minor`, `'@ax/memory': patch`, `'@ax/channel-slack': patch`, in the CLAUDE.md voice ("we", plain, honest about limits). What changed: in a channel, nothing is saved under the speaker's name, by any path, and work facts still are. How: channel-slack tells memory each member's label names. The limits: nicknames the label doesn't show, and people named only in passing. Outsiders' names aren't stored.
- [ ] **Step 5: Verify.** `grep -rn "accepted gap\|Known gaps, accepted: the extractor" docs/plans/2026-11-09-channel-slack-design.md packages/memory/src packages/channel-slack/src` → no stale hit. `pnpm test:scripts` passes. Its `memory-cited-paths-exist` guard requires every path the shard cites to be a TRACKED file, so run it after this plan and the shard are committed.
- [ ] **Step 6: Commit** `[TASK-1146] docs: the sender-label gap is closed; boundary review for the pre-capture answer`.

---

## Follow-up to file at handoff (not this PR)

**`[TASK-n] (walk) Slack: re-walk team memory in a channel after TASK-1146`**. Depends on: TASK-1146. It needs a member typing in Slack: connector posts are refused as `bot`.
- Kind is rebuilt from a main that has TASK-1146 (the host image; the migration runs at boot). Use a NEW thread, since warm sessions keep their prompt.
- A member says "Our team standup moved to 10:15 on Tuesdays."
- **Pass:** no shared row under the member's name, read-only from the facts store. `memory_observer_run` shows `speakerFacts` ≥ 1 if the extractor named them. At most one shared work row holds the fact. The reply doesn't tell the channel it couldn't save.
- **Record:** whether the model followed the refusal's redirect. TASK-1136's open question.
- If it didn't follow, file a follow-up: a member-session line in `turn-note.ts` telling the agent to save work facts with a work subject.

## Not done (YAGNI; reasons in the decisions shard)

- AX-identity names as a second source.
- A names count in the run log.
- Names for outsiders' threads.
- Backfilling names onto existing threads.
- Clearing names when a conversation is deleted.
- Cross-subject dedupe.
- Any change to the extraction prompt, the descriptor or the turn note.
- Rewriting a DM's display-name subject to `user:<id>` (FOR VINAY, decisions shard).
