# TASK-1209: Outsiders recall a team agent's memory like members; members' names in recall; the stamp is where a row was learned — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a team agent, an outsider's turn recalls everything a member's turn does and gets the `/memory` view. What a member says about themself is stamped with the turn's own audience again, so the memory view's "Shared" badge comes back. Another member's `user:<id>` reads as their display name, not a raw id or "a teammate". Capture and personal agents don't change.

**Architecture:** Three small cuts in `@ax/memory`, plus one new read-only helper.
- `recallAudienceScope` checks `visibility === 'team'` before the outsider step.
- `sandbox:memory-mounts` withholds only on personal agents.
- `recordFacts` loses TASK-1204's private-stamp exception.
- A new `member-names.ts` asks the existing `auth:get-user` hook (declared in `optionalCalls`) for display names. It's used by `memory:recall`'s `aboutText` (the memory view, the `memory_recall` tool, recall receipts) and by the injected block's Recent and Digest. Team agents only.
  - *(Coordinator security review of Task 4: it asks only about a current member of the agent's team, proven first by the existing `teams:is-member` hook, also declared in `optionalCalls`. Any other `user:<id>` reads "a teammate" with no `auth:get-user` call.)*

No new hook, and no hook signature change.

**Tech Stack:** TypeScript, vitest, the better-sqlite3 memory harness (`packages/memory/src/__tests__/harness.ts`).

**Spec:** card TASK-1209 (TASK-1204 follow-ups). DECIDED by Vinay 2026-11-22: "Do whatever is the simplest in terms of code complexity and for users to understand: treat outsiders the same as insiders." Capture is unchanged: outsiders' words are never remembered, and Slack Connect stays refused. Design: `docs/plans/2026-11-09-channel-slack-design.md` §4c. **Read the planner's decisions first: `.claude/memory/decisions/2026-11-22-TASK-1209.md`.** Append your own rows there, never to a root archive.

## The premise, checked

- **All three outsider restrictions are where the card says.**
  - Recall: `recallAudienceScope` checks the outsider step first (`packages/memory/src/audience.ts:81`).
  - Mount: `sandbox:memory-mounts` withholds it (`packages/memory/src/plugin.ts:720-729`).
  - Stamp: `recordFacts`' `ownKey` stamp (`audience.ts:553-567`).
- **The `/memory` mount check lives only in `@ax/memory`.** `sandbox-k8s` asks `sandbox:memory-mounts` and never reads audience or source for it (`packages/sandbox-k8s/src/open-session.ts:363-371`). No other package changes for item 1.
  - The outsider read-only `/files` home (TASK-1122, `open-session.ts:276-281`) is a write boundary. It stays.
- **Nothing else needs the private stamp.** The stamp is read in two places only:
  - the recall scope (engine filter + `requireSharedRows`);
  - `toMemoryStatement`'s `audience: 'shared'` (the badge, `plugin.ts:2584`).

  After Task 1 no team-agent read is scoped. An agent's visibility can never change (`packages/agents/src/store.ts:385-386`). So on a team agent the stamp only drives the badge, and F2 is exactly item 3's bug.
- **Item 3 needs no new bit.** Once F2 is gone, the stamp means "where it was learned" on every agent. It filters reads only on personal agents, where the two meanings coincide. That is the brief's own fallback.
- **Item 2 fits inside memory, through an existing hook.**
  - `auth:get-user` (`packages/auth-better/src/plugin.ts:323-327`) answers `{ id, email, displayName: string | null, isAdmin } | null`. It reads no ctx and has no `returns` schema.
  - Six plugins already declare it to name a user by id.
  - TASK-1204 row 23 ("a name source memory doesn't have") is superseded in the shard.
  - The only pin it moves is memory's own `surface.test.ts`. No preset test pins memory's `optionalCalls` exactly (`presets/memory/.../boot-graph.test.ts:87` uses `toContain`).
- **TASK-1203's notice copy becomes wrong.** It says "shared with everyone on {team}" (`copy.ts` `memoryNotice`, channel-web `memorySharedWith`, on branch `auto-ship/TASK-1203-slack-private-remembered-notices`). After Task 1, anyone who talks to the bot can be told what it remembers. Task 6 fixes the design, and a second commit in this PR updates the code copy in channel-slack and channel-web (the coordinator authorized exactly that copy).

## Boundary review (no new hook, no signature change)

- **`memory:recall` `aboutText` (meaning only).** On a team agent, another member's key now reads as their display name. Otherwise it reads "a teammate".
  - It is never `you` for anyone but the caller, and never a raw id.
  - **Alternate impl:** any identity provider that answers `auth:get-user`.
  - **Leaky names:** none.
  - **Subscriber risk:** `aboutText === 'you'` is the self sentinel in channel-web (`memory-copy.ts:208`) and in memory's evidence table (`evidence.ts:107`). So a name that reads as `you`, `user` or the agent is never emitted (Task 4).
  - **Wire:** none new. The channel-web route already forwards the answer.
- **`@ax/memory` manifest:** `optionalCalls` gains `auth:get-user`. That is a capability, not a hook surface.
  - It adds a boot edge memory → auth-better. No cycle: auth-better calls only `database:get-instance`, `http:register-route` and `credentials:envelope-*`, and none of those reach memory. `presets/memory`'s boot-graph test checks it.
  - *(Coordinator security review: it also gains `teams:is-member`, so names are asked only about current members of the agent's team. That adds a boot edge memory → teams. No cycle: teams calls only `database:get-instance`, plus `http:register-route` and `auth:require-user` with its admin routes. The boot-graph test checks it.)*
- **`sandbox:memory-mounts`, `memory:recall`:** same shapes, wider answers for outsiders on team agents. The security note covers it.

## Global Constraints

- **Personal agents: byte-for-byte unchanged.** That covers recall scope, backstop, mount, stamps and labels, and they make no `auth:get-user` call. Every personal-agent test passes unedited.
- **Capture: unchanged.** Don't touch these:
  - `speakerScope`, `speakerSubject`, `breaksSpeakerRule`, `observer.ts`'s filing, `note-tool.ts`'s rules, `capture.ts`;
  - channel-slack's veto.

  An outsider's turn is still `withheld`, and stores no person fact.
- **"Outsiders are never 'you'" stays.** In an outsider's turn, `self` is undefined (`augment.ts:606`) and so is `ownSubject` (`plugin.ts:1061`).
- **No edits under `packages/channel-slack` or `packages/channel-web`** (TASK-1203 is in flight there), or under `packages/tool-policy` or the proxy (TASK-1208).
- **Outside `packages/memory`, touch only:**
  - `packages/core/src/context.ts` (doc, Task 1)
  - `packages/memory-facts-contract/src/index.ts` (doc, Task 3)
  - `docs/plans/2026-11-09-channel-slack-design.md` (Task 6)
  - `.changeset/` (Task 6)
- **Don't touch `packages/memory/src/extraction-prompt.ts`.** It is fingerprint-pinned.
- **Names:** read only `displayName`. Never render or log `email` or `isAdmin`.
  - No account id, name or email goes into a log line or an error message.
  - Clean names only with `@ax/core`'s helpers (`replaceSurfaceRewriters` from `@ax/core/surface-text`, `toWellFormedText`, `clampCodeUnits`). `scripts/__tests__/surface-text-single-owner.test.js` forbids a hand-copied character class.
- **Spell invisible characters in tests as `\u` escapes.**
- **Commands:**
  - The filter goes BEFORE the script: `pnpm --filter @ax/memory exec vitest run src/__tests__/<file>.test.ts`.
  - `tsc` doesn't type-check tests, so also run `pnpm --filter @ax/memory build`.
  - After Task 4: `pnpm --filter @ax/preset-memory test` (boot graph + canary).
  - Full gate before the PR: `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts && pnpm lint`.
- **Mutations:** commit first, restore with `git checkout HEAD -- <path>`, and assert `git status --short` is empty between mutants.
- **Memory rows** go only in `.claude/memory/decisions/2026-11-22-TASK-1209.md`.
- **In GitHub text,** `@ax/...` goes inside backticks.

## Review Focus

1. **A personal agent's outsider turn, shared turn, or unknown source (`'satellite'`) still fails closed.** That means shared-only recall, the backstop, and no mount. Pinned by the new personal rows in Task 1's rule table and Task 2's mount table.
2. **A member's display name that reads as the person talking or as the agent never does.** Examples: "You", " YOU ", fullwidth "ｙｏｕ", "User", "user:x", "Assistant", "AI Assistant". The same goes for a name that hides characters (U+202E, zero-width, newlines). It never reads as the person talking or the agent, and it lands on one clean line. Pinned in Tasks 4 and 5.
3. **When `auth:get-user` is missing, answers oddly, or throws, recall and the block still answer.** Odd answers are `null`, no `displayName`, email only, or another account's `id`. Every such member reads "a teammate". One warn by error code, with no id, name or email in it. Pinned in Task 4.
4. **An outsider's turn on a team agent recalls everything,** including the requester's private web chat. The requester's rows still read by their name: never "you", and no Profile. Pinned in Tasks 1, 4 and 5.
5. **Email never surfaces.** Not in `aboutText`, the tool's text, the block, or a log, even when auth answers an email and no name. Pinned in Task 4.

## Files

| File | Change | Task |
|---|---|---|
| `packages/memory/src/audience.ts` | `recallAudienceScope` order; header and `recallAudienceScope`/`recallFacts` docs; `speakerSubject` doc `~:406-411` | 1 |
| | `recordFacts` drops `ownKey`; its doc `~:455-498`; header `~:26-33` | 3 |
| `packages/memory/src/augment.ts` | comments `~:13-14`, `~:186-190`, `~:596-605`, `~:610-613` | 1 |
| | `recentGroups`; labels in `renderSubject`/`renderRecent`/`renderDigest`; `buildMemoryBlock` | 5 |
| `packages/memory/src/plugin.ts` | comments `~:810-818`, `~:1052-1060`, `~:2185-2192` | 1 |
| | mount condition `~:720-729`; docs `~:187-196`, `~:394-402`, `~:689-719` | 2 |
| | docs `~:336-343`, `~:1576-1587` | 3 |
| | `optionalCalls` + `memory:recall` `aboutText` `~:1052-1107` | 4 |
| `packages/memory/src/member-names.ts` | new | 4 |
| `packages/memory/src/{types,note-tool,owner}.ts` | doc comments (`types.ts:114-121`, `note-tool.ts:329-331`, `owner.ts:36-45`) | 3 |
| `packages/memory/src/types.ts` | `aboutText` doc | 4 |
| `packages/core/src/context.ts:290-302` | `audience` doc | 1 |
| `packages/memory-facts-contract/src/index.ts:146-152` | stamp doc back to the pre-F2 sentence | 3 |
| `packages/memory/src/__tests__/audience.test.ts` | flips listed per task; new rule rows | 1, 3 |
| `packages/memory/src/__tests__/export.test.ts` | mount tables | 2 |
| `packages/memory/src/__tests__/{note-tool,incremental,shared-turn-replay}.test.ts` | stamp flips (`shared-turn-replay` recall half in 1) | 1, 3 |
| `packages/memory/src/__tests__/harness.ts` | `authUser` option + `authCalls` | 4 |
| `packages/memory/src/__tests__/member-names.test.ts` | new | 4 |
| `packages/memory/src/__tests__/surface.test.ts` | `optionalCalls` pins | 4 |
| `packages/memory/src/__tests__/augment.test.ts` | team describe `~:1454-1490` | 5 |
| `docs/plans/2026-11-09-channel-slack-design.md` | §2a marker, §4c, §6 | 6 |
| `.changeset/memory-outsiders-same-as-members.md` (new), `.changeset/memory-team-shared.md` | release notes | 6 |

Order: 1 → 2 → 3 → 4 → 5 → 6. Each task leaves `@ax/memory` building and green, with its own comments true at its commit.

---

### Task 1: An outsider's turn on a team agent recalls what a member's does `[tier: sensitive]`

**security-checklist: required.** This removes a privacy boundary on purpose: an outsider (no AX access to the agent) can now be told what members said in private web chats. Walk it for the PR's one security note (Task 6). Two answers to record:
- Personal agents keep every filter, the unknown-source case included.
- "Never you" still holds.

**Files:**
- Modify: `packages/memory/src/audience.ts:77-84` (the rule), docs `:16-48`, `:50-76`, `:98-102`, `:406-411`.
- Modify: comments only in `packages/memory/src/augment.ts` (`~:13-14`, `~:186-190`, `~:596-605`, `~:610-613`) and `packages/memory/src/plugin.ts` (`~:810-818`, `~:1052-1060`, `~:2185-2192`).
- Modify: doc only in `packages/core/src/context.ts:290-302`.
- Test: `packages/memory/src/__tests__/audience.test.ts`, `packages/memory/src/__tests__/shared-turn-replay.test.ts`.

**Interfaces:**
- Produces: `recallAudienceScope(ctx, access)`, same signature, now decided in this order:
  1. `access.visibility === 'team'` → `{}`;
  2. `isOutsiderTurn(ctx)` → `{ audience: 'shared' }`;
  3. `audienceOf(ctx) === 'shared'` → `{ audience: 'shared' }`;
  4. otherwise `{}`.

  `requireSharedRows` still runs whenever the scope is sent, so on personal agents only.

- [ ] **Step 1: Turn the team-outsider tests into the new rule (RED).** Line numbers are at `4d65f31f9`.
  - `audience.test.ts:665`, the rule table "the recall scope of audience %j, source %j on a %s agent is %j":
    - These six rows become `{}`: `['shared','external','team']`, `['public','external','team']`, `['shared','satellite','team']`, `['private','external','team']`, `[undefined,'external','team']`, `['private','satellite','team']`.
    - Add three rows that must stay `{ audience: 'shared' }`: `['private','satellite','personal']`, `[undefined,'satellite','personal']`, `['shared','external','bogus']`.
    - All other rows are unchanged.
  - `audience.test.ts:638`, "an outsider's read keeps the shared scope and its backstop on any agent…": split it.
    - The `PERSONAL_AGENT` pass is unchanged.
    - A new team test, "an outsider's read on a team agent is unscoped and never backstopped: audience %j, source %j", runs the same six (audience, source) rows. Assert the engine saw no `audience` (`asked` equals `[{ limit: 5 }]`). Assert that a private row comes back, with no throw.
  - `audience.test.ts:148`, `:195` and `:432` are `it.each` over both agents, and their titles say "never". Split each into its unchanged personal case(s) and a team case with an inverted title and assertions:
    - `:148` team: "a private statement IS recalled in an outsider's turn on a team agent". Recall holds `PUBLIC` and `SECRET`, and the block and tool contain `Nightjar`.
    - `:195` team rows `['team','private']` and `['team',undefined]`: same, and every engine read carries no `audience`.
    - `:432` team: the bare outsider read returns the private row; nothing throws.
  - `audience.test.ts:1420`: rename it to "an outsider's turn on the same agent recalls everything a member's turn recalls, the requester's web chat included". New assertions:
    - For every `RECALL_SHAPES` input, the sorted statement ids (`.statements.map((s) => s.id).sort()`) of `h.recall(input, outsider)` equal those of `h.recall(input, alicesChannelTurn)`, where `alicesChannelTurn = h.ctx({ conversationId: 'conv-x', source: 'user', audience: 'shared' })` runs as the same user. Compare ids, not `aboutText`, because "you" differs between the two.
    - The block contains `Nightjar` and `Lisbon`, but not `### Profile` and not `you lives in`.
    - The tool text contains `Nightjar`.
  - `audience.test.ts:1442`: rename it to "no engine read on a team agent carries an audience scope, in a member's turn or an outsider's". The outsider branch now asserts `input.audience` is absent.
  - The recall halves of the R1+R3 tests (their stamp halves wait for Task 3):
    - `:1152`: the outsider's recall now also holds both members' rows.
    - `:1196`: rename to "what a member says about themself in a channel is the team's: members and outsiders recall it". The outsider recall gains Lisbon and teal. Drop the block and tool `not.toContain` checks, and replace them with `toContain`.
    - `:1509`: keep only the "never you" half. No `### Profile`, `aboutText` not `you`, the tool text not `| user lives in: Boston`. The outsider now finds Boston.
  - `audience.test.ts:1535-1539`: the comment "No writer in this build stores a SHARED row…" goes stale, because an outsider's read is no longer shared-only. Rewrite it to say the fixture is simply a row under the requester's key. Assertions unchanged.
  - `shared-turn-replay.test.ts:231`: rename to "an outsider's turn in the channel recalls it too". `recallTool(outsider…)` now contains `9:30`.
  - Run: `pnpm --filter @ax/memory exec vitest run src/__tests__/audience.test.ts src/__tests__/shared-turn-replay.test.ts`. Expected: the flipped team cases FAIL, and every personal case passes.

- [ ] **Step 2: Reorder `recallAudienceScope` and make the docs true.**
  - The new order is in Interfaces.
  - Rewrite the `audience.ts` header and the `recallAudienceScope` and `recallFacts` docs. They now say:
    - A team agent's memory is read unscoped in every turn: member, outsider, any audience stamp, an unknown source. That's TASK-1209, design §4c: anyone who can talk to a team agent can be told what it remembers.
    - The backstop runs only on a personal agent's shared or outsider read.
    - Personal agents keep the F3 fail-closed rule.
  - `speakerSubject` doc `~:406-411`: drop "can reach an outsider's recall; accepted, same class". Every row reaches an outsider on a team agent now.
  - `augment.ts` and `plugin.ts` comments: drop "an outsider's turn keeps shared-only recall". Keep the "never you" reasoning, and say the requester's key reads as any member's.
  - `core/src/context.ts:290-302` `audience` doc becomes, in substance:
    - On a personal agent, a shared turn recalls only shared statements and stores no speaker facts, and so does an outsider's turn whatever this field says.
    - A team agent's memory is shared with anyone who talks to it (design §4c, TASK-1209): every turn on it recalls everything, and a member's turn files their facts under them.
    - An outsider's turn on any agent stores no person fact.

- [ ] **Step 3: Run tests.** Run the Step 1 command, then `pnpm --filter @ax/memory exec vitest run` and `pnpm --filter @ax/memory build`. Expected: all PASS.

- [ ] **Step 4: Mutations (owner's tree, committed first).** Expected results:
  - M1: put the outsider step back first. The new team rows and the 1420 equality fail.
  - M2: delete the outsider step. The personal `external` and `satellite` rows fail.
  - M3: never send the backstop. The personal backstop cases (`:432` personal, `:638` personal) fail.

  Record the counts in the shard.

- [ ] **Step 5: Commit.**
```bash
git add packages/memory/src/audience.ts packages/memory/src/augment.ts packages/memory/src/plugin.ts packages/core/src/context.ts packages/memory/src/__tests__/audience.test.ts packages/memory/src/__tests__/shared-turn-replay.test.ts .claude/memory/decisions/2026-11-22-TASK-1209.md
git commit -m "feat(memory): an outsider's turn on a team agent recalls what a member's does (TASK-1209)"
```

---

### Task 2: A team agent's sessions always get the `/memory` view `[tier: sensitive]`

**security-checklist: required.** This is a sandbox mount: the read-only export of every fact the agent has now reaches outsider-opened sessions on team agents. Record two answers:
- It is still read-only. `sandbox-k8s` refuses anything but one `readOnly: true` nfs mount at `/memory`.
- Personal agents still withhold.

**Files:**
- Modify: `packages/memory/src/plugin.ts:720-729` (the condition), docs `~:187-196` (`MEMORY_MOUNT_WITHHELD_EVENT`), `~:394-402` (`exports` config), `~:689-719` (inline).
- Test: `packages/memory/src/__tests__/export.test.ts`.

**Interfaces:**
- Produces: withhold iff `access.visibility !== 'team' && (outsider || shared)`. `outsider` and `shared` are computed as today. Access is still resolved first, a refused caller still gets `forbidden`, and the event keeps `reason: 'shared-audience'`.

- [ ] **Step 1: Tests (RED).**
  - `export.test.ts:318` ("a %s agent: %s session gets no mount and nothing is flushed"): move its six `team` rows into a new table, "a team agent's %s session gets its mount, flushed". Assert:
    - exactly one mount (`memoryMountSpec` shape, `readOnly: true`);
    - the flush ran;
    - no `memory_mount_withheld` event.

    Keep the two `personal` rows. Add `['personal','an unknown-source shared', { audience: 'shared', source: 'satellite' }]` and `['personal','an unknown-source private-stamped', { audience: 'private', source: 'satellite' }]`; both are withheld.
  - `export.test.ts:355`: rename to "a team agent's shared session opened by an outsider's turn gets its mount". Both cases (owner shared, owner private) get one mount, and the withheld event count is 0.
  - Run `pnpm --filter @ax/memory exec vitest run src/__tests__/export.test.ts`. Expected: the moved team rows and `:355` FAIL.

- [ ] **Step 2: Change the condition, and make the three docs say the new rule.** A personal agent's session that isn't private, or an outsider's on a personal agent, gets no view. A team agent's session gets it in every audience, outsiders' included, because its recall reads everything (TASK-1209).

- [ ] **Step 3: Run** `export.test.ts`, the whole `@ax/memory` suite, and the build. Expected: PASS.

- [ ] **Step 4: Mutations.**
  - M4: `outsider ||` back in front. The team-outsider rows fail.
  - M5: drop `outsider` entirely. The personal outsider rows fail.

- [ ] **Step 5: Commit** (`feat(memory): a team agent's sessions always get the /memory view (TASK-1209)`), including the shard rows.

---

### Task 3: The stamp is where a row was learned, with no exceptions `[tier: sensitive]`

**security-checklist: required.** This changes the privacy stamp written on every new row. Record the answer: after Task 1 the stamp gates no team-agent read, and visibility is immutable. So the only effect is the "Shared" badge. Rows F2 already stamped private (kind only; TASK-1204 is not deployed) keep no badge, and get no migration.

**Files:**
- Modify: `packages/memory/src/audience.ts:553-567` (drop `ownKey`), the `recordFacts` doc `~:455-498`, header `~:26-33`.
- Modify: docs only in `packages/memory/src/plugin.ts` (`~:336-343` `EngineFactRecord.audience`, `~:1576-1587`), `packages/memory/src/types.ts:114-121`, `packages/memory/src/note-tool.ts:329-331`, `packages/memory/src/owner.ts:36-45`.
- Modify: doc only in `packages/memory-facts-contract/src/index.ts:146-152`. Restore "Decided and stamped by the product layer — `@ax/memory` copies it off the turn's context — and echoed back exactly as supplied."
- Test: `audience.test.ts`, `note-tool.test.ts`, `shared-turn-replay.test.ts`, `incremental.test.ts`.

**Interfaces:**
- Produces: `recordFacts` stamps every statement `audience: audienceOf(ctx)`. Keep `Array.from`, so a hole still becomes a subject-less statement the engine refuses. The backstop (`refuseUnfiled`) is unchanged.

- [ ] **Step 1: Tests (RED).** These flip a team member's self-fact stamp in a shared turn from `'private'` to `'shared'`:
  - `audience.test.ts:1126`, `:1152`, `:1196` (stamp half; its title already changed in Task 1), `:1317`, `:1362`, `:1509` (if it still asserts a stamp).
  - `audience.test.ts:2134`: rename to "a team agent's member turn writes statements filed under the speaker, each stamped with the turn".
  - `audience.test.ts:2155`: all four rows; the own key gets the turn's stamp.
  - `audience.test.ts:2191`.
  - `audience.test.ts:2202`: delete it, or rename to "every statement carries the turn's stamp in every scope". Its title names a special stamp that no longer exists.
  - `note-tool.test.ts:1001` (`filed(h)` audience) and `:1059`. One row, now `'shared'`, still exactly one.
  - `shared-turn-replay.test.ts:191`, `incremental.test.ts:684`.
  - **New:** "the memory view shows a member's channel fact about themself as Shared". This is item 3's visible effect.
    - On a team agent, Alice's member channel turn (`source: 'user'`, `audience: 'shared'`) notes `user` | `lives_in` | `Lisbon`.
    - Alice's private web turn (`h.ctx()`) notes `user` | `favorite_color` | `teal`.
    - `h.recall({}, h.ctx())` gives the Lisbon row `audience: 'shared'`, and the teal row no `audience`.
  - Run the four files. Expected: the flipped cases FAIL.

- [ ] **Step 2: Drop `ownKey` and make the docs say the stamp is the audience of the turn it was learned in, with no exception.** It gates reads only on personal agents. On a team agent it is display only (the badge).

- [ ] **Step 3: Run** the four files, the whole suite and the build. Expected: PASS.

- [ ] **Step 4: Mutation.** M6: put the `ownKey` exception back. The new badge test and the flipped stamp tests fail.

- [ ] **Step 5: Commit** (`fix(memory): a member's fact about themself carries the turn's stamp; the Shared badge is back (TASK-1209)`).

---

### Task 4: Members' display names in `memory:recall` `[tier: sensitive]`

**security-checklist: required.** This adds a capability (memory reads account display names through `auth:get-user`), and it brings account-holder text into the model's tool output and the UI. Walk these points:
- Only `displayName` is read, and email and `isAdmin` never leave the helper.
- Lookups happen only on team agents, for keys already in an answer.
- A name is cleaned and clamped, and a reserved name falls back.
- Failures are soft and logged by code only.
- Display names are persisted in recall receipts' snapshots (`recall-receipts.ts:88`), as rendered.
- ~~Residual: `auth:get-user` isn't team-scoped, so a writer who already knows another account's id can store `user:<that id>` and have it shown by name. Accepted (decisions shard). A `teams:is-member` gate is a follow-up if review wants it.~~ *Closed by the coordinator's security review of Task 4.* A stored subject is model output, so `user:<id>` can name any account. So memory asks `teams:is-member` about the agent's team (`MemoryAccess.teamId`) first. It asks `auth:get-user` only about an id answered exactly `member: true`. A non-member, a former member, an odd answer, a throw, no team id or no service: that id reads "a teammate", with no `auth:get-user` call (decisions shard).
- Residual: outsiders on a team agent now see members' AX display names beside their facts. Decided ("outsiders the same as insiders").

**Files:**
- Create: `packages/memory/src/member-names.ts`.
- Modify: `packages/memory/src/plugin.ts`: `optionalCalls` (append LAST, `~:628-650`), and `memory:recall` `aboutText` (`~:1052-1107`).
- Modify: `packages/memory/src/types.ts`: the `aboutText` doc.
- Test: create `packages/memory/src/__tests__/member-names.test.ts`. Modify `harness.ts` and `surface.test.ts`.

**Interfaces (produces):**
```ts
// packages/memory/src/member-names.ts
export const AUTH_GET_USER_HOOK = 'auth:get-user';
/** What another member's key reads as when memory has no name to show. */
export const TEAMMATE_TEXT = 'a teammate';
export const MEMBER_NAMES_FAILED_EVENT = 'memory_member_names_failed';
/** The longest name shown, in UTF-16 code units (channel-slack's sender-name cap). */
export const MEMBER_NAME_MAX = 80;

/** `user:<id>` with a non-empty id → `<id>`; anything else (`user`, `user:`, `User:x`, `acme`) → undefined. */
export function memberKeyId(about: string): string | undefined;

/** A display name fit to show for a member, or undefined: not a string, nothing printable, or reserved. */
export function memberName(raw: unknown): string | undefined;

/**
 * How each OTHER member's key among `subjects` reads, on a team agent: its display
 * name, else TEAMMATE_TEXT. Never includes `self`. Empty on any other agent, with no
 * lookup at all. Never throws.
 */
export async function memberLabels(
  bus: HookBus,
  ctx: AgentContext,
  access: Pick<MemoryAccess, 'visibility' | 'teamId'>, // `teamId`: coordinator security review
  subjects: Iterable<string>,
  self: string | undefined,
): Promise<ReadonlyMap<string, string>>;
```

`memberName` composes core's helpers, the same composition as channel-slack's `cleanLabel`. Do not copy any character class:

```ts
const flat = toWellFormedText(replaceSurfaceRewriters(raw)).replace(/\s+/g, ' ').trim();
const name = clampCodeUnits(flat, MEMBER_NAME_MAX).trimEnd();
// reserved: name.normalize('NFKC').toLowerCase() === 'you' || isPersonSubject(name) || isAgentSubject(name)
```

`memberLabels`:
1. Return an empty map unless `access.visibility === 'team'`.
2. Collect the distinct subjects with a `memberKeyId` that aren't `self`. With none, return an empty map.
3. With no service (`bus.hasService`), map each one to `TEAMMATE_TEXT`.
4. Otherwise make one `bus.call(AUTH_GET_USER_HOOK, ctx, { userId })` per distinct id, in parallel. An answer counts only if it is a non-null, non-array object whose `id === userId`. Then the label is `memberName(answer.displayName) ?? TEAMMATE_TEXT`.
   - *(Coordinator security review: first, per id, `bus.call(TEAMS_IS_MEMBER_HOOK, ctx, { teamId: access.teamId, userId })`. Ask `auth:get-user` only when it answered exactly `member: true`. No team id, or no `teams:is-member` service: no lookups at all.)*
5. A throw labels that member `TEAMMATE_TEXT`. Remember the first error, and after all lookups call `ctx.logger.warn(MEMBER_NAMES_FAILED_EVENT, { agentId: ctx.agentId, ...faultLogFields(err) })` once, inside a `try`.

`isPersonSubject` comes from `./audience.js` and `isAgentSubject` from `./self-report.js`.

In `memory:recall`: `const labels = await memberLabels(bus, ctx, access, page.map((row) => row.about), ownSubject);`, then:
`aboutText: ownSubject !== undefined && row.about === ownSubject ? 'you' : labels.get(row.about) ?? (row.about.startsWith(`${SPEAKER_SUBJECT}:`) ? TEAMMATE_TEXT : row.about.replace(/_/g, ' '))`.
A personal agent gets an empty map, so its output is unchanged.

Manifest, appended after the storage entries: `{ hook: AUTH_GET_USER_HOOK, degradation: "on a team agent, another member's memories read \"a teammate\" instead of their name" }`. *(Coordinator security review: then `{ hook: TEAMS_IS_MEMBER_HOOK, … }`, with the same "a teammate" degradation.)*

Harness: `MemoryHarnessOptions.authUser?: (userId: string) => unknown | Promise<unknown>` registers `auth:get-user` (plugin `'@ax/test-auth'`) and pushes each `userId` to a new `MemoryHarness.authCalls: string[]`. Without the option, no service is registered and `authCalls` stays `[]`.

- [ ] **Step 1: Unit tests (RED).** In `member-names.test.ts`, `describe('member names (TASK-1209)')`:
  - `memberName`:
    - `'Bob Smith'` → `'Bob Smith'`.
    - `'Bob‮ \n Smith​'` → `'Bob Smith'`.
    - `'a'.repeat(79) + '\u{1F600}'` → exactly `'a'.repeat(79)`. The cut would split the pair, so the whole emoji goes.
    - `null`, `42`, `''`, `'   '`, `'​'` → `undefined`.
    - Reserved → `undefined`: `'you'`, `'You'`, `' YOU '`, `'ｙｏｕ'`, `'user'`, `'User'`, `'user:abc'`, `'Assistant'`, `'AI Assistant'`, `'the agent'`.
  - `memberKeyId`: `'user:abc'` → `'abc'`. `'user:'`, `'user'`, `'User:abc'`, `'acme_corp'` → `undefined`.
  - `memberLabels`, on a bare `HookBus` with a spy `auth:get-user`:
    - A personal agent returns an empty map with 0 calls.
    - A team agent with subjects `['user:u-bob','user:u-bob','user:u-alice','acme_corp','user']` and self `'user:u-alice'` makes exactly 1 call, for `u-bob`, and maps `user:u-bob` → `'Bob Smith'`.
    - With no service, every member key maps to `'a teammate'`, with no warn.
    - These answers each give `'a teammate'` with no warn: `null`, `[]`, `{ id: 'u-bob' }`, `{ id: 'u-bob', displayName: '  ' }`, `{ id: 'u-bob', displayName: null, email: 'bob@x.test' }`, and `{ id: 'u-carol', displayName: 'Carol' }` (the wrong account).
    - One of two lookups throws `new PluginError({ code: 'store-unavailable', plugin: 'x', message: 'bob@x.test u-bob' })`. The other is still named. Exactly one warn `memory_member_names_failed`, with `agentId` and `code`, and `JSON.stringify(bindings)` contains none of `u-bob`, `bob@x.test`, `Bob`.
    - A logger that throws doesn't throw out.
- [ ] **Step 2: Integration tests (RED),** `describe('memory:recall names a teammate (TASK-1209)')` in the same file, using `makeHarness({ agent: { visibility: 'team' } }, { authUser })` where `authUser` answers `{ id, displayName, email }` for `ALICE` ("Alice Jones") and `BOB` ("Bob Smith"):
  - Seed with `engineRecord`, or the real `memory_note` path, under `user:${BOB}`, `user:${ALICE}` and `launch_plan`.
  - In Alice's private turn, `aboutText`s are `'Bob Smith'`, `'you'`, `'launch plan'`, and `authCalls` is `[BOB]`.
  - With no `authUser`, Bob's row reads `'a teammate'`.
  - On a personal agent with a `user:${BOB}` row (ownerUserId ALICE), it reads `'a teammate'` and `authCalls` is `[]`.
  - In an outsider's turn run as Alice (`source: 'external'`, `audience: 'shared'`), Alice's own row reads `'Alice Jones'` (never `'you'`) and Bob's reads `'Bob Smith'`.
  - When Bob's `displayName` is `'You'`, his `lives_in Boston` row reads `'a teammate'`. The `recallTool` text contains `a teammate lives in: Boston` and not `user lives in: Boston`. Alice holds no `lives_in` row of her own in this fixture.
  - `recallTool(h, aliceTurn, 'Boston')` contains `Bob Smith lives in: Boston`.
  - With `displayName: null` and an email, `JSON.stringify(await h.recall({}, aliceTurn))` does not contain the email.
  - `surface.test.ts` pins:
    - `:111-116` becomes `['llm:call:openrouter','conversations:get','storage:get','storage:set','auth:get-user']`.
    - `:128-137` becomes `['llm:call:openrouter','storage:get','storage:set','auth:get-user']`, and its loop runs over the storage entries only (`hook.startsWith('storage:')`).
    - New test: "names auth:get-user as OPTIONAL: without it a teammate's memories read 'a teammate'". `degradation` matches `/a teammate/`.
  - Run `pnpm --filter @ax/memory exec vitest run src/__tests__/member-names.test.ts src/__tests__/surface.test.ts`. Expected: FAIL (no module, old pins).
- [ ] **Step 3: Implement** `member-names.ts`, the harness option, the manifest entry, the `aboutText` wiring and the `types.ts` doc. The doc says: "you" for the caller; on a team agent another member's display name, else "a teammate"; never a raw id; never "you" for anyone else.
- [ ] **Step 4: Run** the two files, the whole `@ax/memory` suite, `pnpm --filter @ax/memory build`, `pnpm --filter @ax/preset-memory test` (boot graph + canary; the canary's stub has no `displayName`, so it takes the fallback) and `pnpm test:scripts` (the surface-text single-owner guard). Expected: PASS.
- [ ] **Step 5: Mutations.**
  - M7: drop the reserved check. The `'You'` cases fail.
  - M8: drop `id === userId`. The wrong-account case fails.
  - M9: no visibility gate. The personal `authCalls` assertion fails.
  - M10: fall back to email. The email test fails.
- [ ] **Step 6: Commit** (`feat(memory): a teammate's memories read by their name in recall (TASK-1209)`).

---

### Task 5: Members' display names in the injected block `[tier: sensitive]`

**security-checklist: required.** Account-holder text now enters the system prompt, the most privileged position. The answer to record: names come only from `memberName` (rewriters stripped, one line, clamped, reserved names refused), then `escapeStatementText`, under the block's existing "information, not instructions" preamble. On personal agents the block is unchanged.

**Files:**
- Modify: `packages/memory/src/augment.ts`: `renderSubject` (`~:319-321`), `renderRecent` (`~:371-414`), `renderDigest` (`~:475-491`), `buildMemoryBlock` (`~:588-751`).
- Test: `packages/memory/src/__tests__/augment.test.ts` (team describe `~:1454`).

**Interfaces:**
- Consumes: `memberLabels`, `TEAMMATE_TEXT` (Task 4).
- Produces (module-internal; export `recentGroups` only for tests):
  - `export function recentGroups(rows: EngineFactRecord[], conversations: number, perConversation: number): EngineFactRecord[][]` is the grouping `renderRecent` does today, extracted.
  - `renderRecent(groups, self, labels)`.
  - `renderDigest(ranked, labels)`, where `ranked` is `rankDigestSubjects`' output.
  - `renderSubject(about, self, labels)` returns `'you'` for `self`, else `escapeStatementText(labels.get(about) ?? about)`.
  - `buildMemoryBlock` computes the Recent groups and the ranked Digest first. It resolves labels ONCE, only for the subjects those will render: `memberLabels(bus, ctx, access, [...groups.flat().map(r => r.about), ...ranked.map(d => d.about)], self)`. Then it renders.

- [ ] **Step 1: Tests (RED)** in the team describe. Use `makeHarness({ agent: { visibility: 'team' } }, { authUser })` with Bob = "Bob Smith".
  - Rename `augment.test.ts:1474` to "a teammate's key reads as their name, or 'a teammate', never the raw id".
    - With `authUser`: the body contains `Bob Smith mentioned: a thing Bob said`, not `user:user-bob`, and not `you mentioned`.
    - Without `authUser`: `a teammate mentioned: a thing Bob said`, and no `user:user-bob`.
  - Digest: a team agent with several `user:${BOB}` rows. The Digest line contains `Bob Smith (` and not `user:user-bob`.
  - Escaping: `displayName: 'Bob | Smith‮\nX'` renders as one line, containing `Bob \| Smith X` and no `‮`.
  - Reserved: `displayName: 'You'` gives `a teammate mentioned`, never `you mentioned`.
  - Only rendered subjects are looked up. With `block: { recentConversations: 1, recentPerConversation: 1, digestSubjects: 1 }` and rows under three members' keys, `authCalls` holds only the keys the body shows.
  - Outsider's turn run as Alice: Alice's rows read `— Alice Jones …` in Recent. No `### Profile`, and the body doesn't match `/— you /`.
  - Personal agent: a `user:${BOB}` row owned by Alice still renders `user:user-bob`, and `authCalls` is `[]`.
  - Run `pnpm --filter @ax/memory exec vitest run src/__tests__/augment.test.ts`. Expected: the new cases FAIL.
- [ ] **Step 2: Implement** the extraction and the label threading, and update `renderSubject`'s and `buildMemoryBlock`'s doc comments: a teammate reads by name or "a teammate" on a team agent; raw on a personal agent.
- [ ] **Step 3: Run** `augment.test.ts`, `audience.test.ts` (its block assertions), the whole suite and the build. Expected: PASS.
- [ ] **Step 4: Mutations.**
  - M11: labels for every scanned subject. The rendered-only test fails.
  - M12: skip `escapeStatementText` on a label. The escaping test fails.
- [ ] **Step 5: Commit** (`feat(memory): the injected block names teammates (TASK-1209)`).

---

### Task 6: Docs, release notes and the notice copy `[tier: mechanical]`

**Files:**
- Modify: `docs/plans/2026-11-09-channel-slack-design.md`.
- Create: `.changeset/memory-outsiders-same-as-members.md`.
- Modify: `.changeset/memory-team-shared.md`.

**Conflict warning.** TASK-1203 (branch `auto-ship/TASK-1203-slack-private-remembered-notices`) edits §4c lines `~1113`, `~1128`, `~1130` and `~1151`, and inserts an "As built (TASK-1203)" block after `~1124`. Check `git log origin/main --oneline | grep TASK-1203` first, and rebase if it has merged. Never insert text right after `~1124`, and leave rule 4 (`~1113`), rule 5 (`~1114`) and card lines `~1150-1153` alone. Line `~1129` will conflict if TASK-1203 lands first: keep its `~1128` and `~1130` and our `~1129`.

- [ ] **Step 1: Design doc edits.**
  - `:140` (§2a marker): append ", and since TASK-1209 with anyone who talks to it".
  - `:1110` rule 1: "**A team agent's memory is shared with anyone who talks to it, everywhere.** What it hears in a public channel, a private channel, or a web chat with a team member can be remembered and brought up anywhere the agent works, for anyone who talks to it: its team, and anyone else in a channel it's in (TASK-1209)."
  - `:1118` canonical sentence: *"What [Fern] hears is shared with anyone who talks to [Fern], and [Fern] may bring it up elsewhere."* Append, in the same paragraph, the per-surface copy below and the line "Built by a follow-up card. TASK-1209 doesn't deploy without it."
  - `:1122` web line: "[Fern]'s memory is shared with anyone who talks to [Fern]."
  - `:1129`: every session on a team agent recalls everything and keeps the view, outsiders' included (TASK-1209). An outsider's turn still files no person fact.
  - Append an italic "*(Superseded by TASK-1209: …)*" to each of these "As built (TASK-1204)" bullets:
    - `:1139`: every turn, outsiders' included.
    - `:1141`: stamped with the turn again; the badge is back.
    - `:1142`: lifted for team agents; personal agents keep it.
    - `:1146`: names done; the export headings and query-by-name remain.
  - Add "**As built (TASK-1209).**" after `:1146`, before "### Cards":
    - Recall order and backstop scope.
    - Mount rule.
    - The stamp's meaning.
    - Capture unchanged.
    - "Never you" kept.
    - Names, with their fallback and reserved names.
    - What's not done: export headings, query-by-name.
    - The privacy sentence: one more boundary removed on purpose; an outsider can be told what members said in private web chats; the notices replace it.
  - §6 `:1370-1376`: drop the F2 exception from "stamps each statement…". The personal-agent sentence gains "and an outsider's turn keeps that filter whatever its stamp". The team sentence becomes "A team agent's turns all recall everything, outsiders' included (§4c, TASK-1209); a member's turn files the speaker's facts under them, and an outsider's files none."
- [ ] **Step 2: Per-surface copy** (exact, for the follow-up card; a ux pass may reword but must keep "anyone who talks to"):
  - Channel notice: "Heads up: what I hear in this channel is shared with anyone who talks to me, and I may bring it up elsewhere."
  - Bot profile: "What I hear is shared with anyone who talks to me, and I may bring it up elsewhere." (83 characters, under Slack's 140.)
  - Slack card: "What {name} hears is shared with anyone who talks to {name}, and {name} may bring it up elsewhere."
  - Web chat: "{Agent}'s memory is shared with anyone who talks to {Agent}."
  - Memory view `MEMORY_TEAM_NOTICE`: "Memories saved with this shared agent can come up for anyone who talks to it. Team members can fix or forget them."
- [ ] **Step 3: Changesets.**
  - New `.changeset/memory-outsiders-same-as-members.md`: `'@ax/memory': minor`, `'@ax/core': patch`, `'@ax/memory-facts-contract': patch`. Write it in the CLAUDE.md voice and cover:
    - Outsiders on a team agent now recall what members do and get `/memory`.
    - Teammates read by name.
    - The Shared badge is back.
    - What didn't change: their words still aren't remembered, Slack Connect is refused, personal agents are unchanged.
    - The plain privacy sentence.
  - `.changeset/memory-team-shared.md` (TASK-1204, unreleased): its claims that outsiders never get members' facts back, keep shared-only recall and get no `/memory` view are false now. Reword them to point at the new entry, and keep "their words still aren't remembered".
- [ ] **Step 4: Gate.** `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts && pnpm lint`. Docker suites need an explicit `DOCKER_HOST`. If a Docker suite can't run locally, say so in the handoff.
- [ ] **Step 5: Commit** (`docs: outsiders recall a team agent's memory like members (TASK-1209)`).

## PR body must say

- **Capture is unchanged, on purpose (Vinay, 2026-11-22, "keep both").** Outsiders' words are never remembered, and Slack Connect stays refused.
- **Security note** (one, from Tasks 1–5's walks). One privacy boundary is removed on purpose. The new capability is `auth:get-user` (display name only), asked only about current members of the agent's team, proven by `teams:is-member` (coordinator security review). Account-holder text now reaches the prompt, cleaned. Residuals: members' names visible to outsiders; names frozen in receipts.
- **Deploy gate.** Ship with TASK-1204, TASK-1203 and the copy follow-up, never before: the notices are what replace the boundary.
- **Follow-ups:**
  1. Notice copy "anyone who talks to [Fern]" in channel-slack and channel-web: the four strings above, `MEMORY_TEAM_NOTICE`, and channel-web `workspace-types.ts:897-904`'s stale F2 doc on `FactMemoryStatement.audience`.
  2. Member names in the `/memory` export's `## user:<id>` headings.
  3. Find a teammate's facts by name in a `query`.
  4. ~~Optional `teams:is-member` gate on names, if review wants it.~~ Done in this PR (coordinator security review of Task 4).
