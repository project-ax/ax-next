# TASK-1203: Private channels are remembered, and people are told (design §4c card B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A team agent's Slack bot remembers private channels like any other channel, and every place a person meets a team agent says, once and plainly, that what it hears is shared with its team.

**Architecture:** channel-slack stops writing `not_remembered` for private channels and stops reading privacy anywhere (the `is_private` column, the binding field, the check's private-wins half and Slack's `is_private` flag all go); threads already marked stay refused. A new `notice_posted_at` column on the channel binding lets exactly one replica claim, then post, a top-level memory notice in each channel on its first turn. The bot's manifest description, the agent's Slack card (channel-slack status route + channel-web) and the web chat (channel-web agent detail) carry the same sentence. No hook changes.

**Tech Stack:** TypeScript, Kysely + Postgres (testcontainers), vitest, React + shadcn (channel-web), Slack Web API (`chat.postMessage`).

**Spec:** `docs/plans/2026-11-09-channel-slack-design.md` §4c (lines 1100-1143). Decisions: `.claude/memory/decisions/2026-11-22-TASK-1203.md` (read it: every "why" below is argued there with file:line evidence).

## Global Constraints

- Six invariants (CLAUDE.md). No cross-plugin imports: channel-slack and channel-web each read team names through `teams:list-for-user` on the bus.
- No hook, IPC action or manifest `calls`/`registers`/`subscribes` entry is added or removed. Only channel-slack's `teams:list-for-user` **degradation text** changes (Task 4).
- channel-slack logs are code-only: `installId`, `stage`, `code`, `reason`, counts. Never a name, team name, Slack id, email or message text.
- Slack-facing words live in `packages/channel-slack/src/copy.ts` (`COPY`), go out as mrkdwn, and pass every name from outside through `shown` (copy.ts:52). Never `<!`, `<@`, `<#` or a bare `@here`/`@channel`/`@everyone`; never the product name (`\bAX\b`, copy.test.ts).
- Agent Slack card copy: no plumbing words and no product name (`packages/channel-web/src/test-utils/slack-card-words.ts`).
- UI: shadcn primitives and semantic tokens only (`text-muted-foreground`, etc.); invoke the `shadcn` skill before touching channel-web UI.
- Threads already marked `not_remembered` stay marked and refused. Nothing clears the flag.
- Slack Connect and archived channels stay refused at turn start (router step 8b) and at an Allow (answers.ts step 8b). Outsiders' words stay unremembered (`channel-external-turn`).
- Slack's `display_information.description` cap: 140 characters.
- Test commands put `--filter` before the script: `pnpm --filter @ax/<pkg> test -- <file>`. Docker-backed suites (channel-slack `channel-store`/`plugin`/`store`/`agents-deleted`, preset-k8s composition) need `DOCKER_HOST` set; on shared-slot contention re-run with `AX_TESTCONTAINER_START_SLOT_WAIT_MS` raised (TASK-1202 learning).
- channel-slack and preset tests are not type-checked by `tsc` (channel-web's are). Run `pnpm --filter @ax/channel-slack build` alongside vitest so a stale `Pick<…>` or a removed field fails loudly.

## Brainstorm (self-answered)

- **Why now?** The TASK-1192 walk showed "answer, but don't remember" can't be enforced: a team agent wrote a refused fact to a file anyway. §4c stops promising secrecy and says plainly what happens. Success: a private channel's new threads are captured, every surface tells people, and no surface still promises secrecy.
- **Non-goals:** memory's speaker rule and team recall (TASK-1204), outsiders' rule (kept), personal agents (unchanged), an invite-time event, re-sending existing bots' manifests.
- **Anti-goals (a failure even if it "works"):** old private-era threads leak into memory; the notice pings a channel through a hostile team name; two replicas post twice; a bot can't be created because its description is too long; a personal agent's web chat says its memory is shared.
- **When is "first bind"?** At the first mention (no invite event exists: `DEDICATED_BOT_EVENTS = ['app_mention']`). The notice goes with the first turn that reaches step 9 in a bound channel, which also covers bindings made before this deploy.
- **Claim-before-post or post-then-mark?** Claim-before-post with release on failure (decisions shard).
- **Where does the notice go?** Top-level in the channel, so the whole channel sees it.
- **What is [team]?** The agent's AX team display name. Fallbacks: "my team" (bot's own words), "its team" (web).
- **Card's and web chat's team name?** The card asks channel-slack's status route; the web chat asks channel-web's agent detail. Both read @ax/teams through the bus.

## Copy (run past the `ux-designer` agent BEFORE Task 4, the first task that pins copy in tests; record taken and declined items in the decisions shard)

| Surface | Exact string | Fallback (team unreadable) |
|---|---|---|
| Channel notice (bot's top-level post, mrkdwn, first person) | `What I hear is shared with everyone on {team}, and I may bring it up elsewhere.` | `What I hear is shared with everyone on my team, and I may bring it up elsewhere.` |
| Bot profile description (manifest, plain text, ≤140, always this) | `What I hear is shared with everyone on my team, and I may bring it up elsewhere.` (80 chars) | (same) |
| Slack card: manager's Not in Slack form, and the Live card | `What {who} hears is shared with everyone on {team}, and {who} may bring it up elsewhere.` (`who` = agent name on the form; the card's existing `who` on Live: `@handle` or bot name) | `…everyone on its team, and {who} may…` |
| Slack card: channels lead (changed) | `{who} has answered in these channels.` | — |
| Slack card: removed | `Private channels aren't remembered.`; and the lead's `It remembers what team members say in public channels, never in private ones.` | — |
| Web chat, team agents only, under the composer | `{Agent}'s memory is shared with {team}.` | `{Agent}'s memory is shared with its team.` |
| Turn note (unchanged) | `This conversation isn't remembered: don't say you'll remember it.` (outsiders' threads, and threads marked before this card) | — |

Open copy question for the ux-designer: the bot's own post and profile are in the first person; the decided §4c sentence names the agent. Revert to the named form if the ux pass prefers it (profile must stay ≤140: the named form can't fit two 35-character names and a 128-character team).

## Review Focus

1. **Slack refuses the notice post** (`restricted_action` in an announcement-only channel, `not_in_channel`, a rate limit, a 5xx): the turn still runs, the claim is released, the next turn tries once more, and nothing logs `slack_event_failed`. Test in Task 4.
2. **A team name carrying Slack controls** (`<!channel> & <@U1> @here`): the notice shows it escaped and marked, and pings nobody. Tests in Task 4 (copy.test HOSTILE row, memory-notice test).
3. **A thread marked under an old rule** (private before this deploy, or the removed switch) that gets a new turn: still refused by the veto, still carries the not-remembered line; a NEW thread in the same private channel is captured. Tests in Tasks 1 and 8.
4. **A binding from before this deploy** (`notice_posted_at` NULL after the migration) posts once at its next turn; two replicas claiming one binding post once. Tests in Task 3.
5. **No readable team name** (no teams service, the person asked isn't on the team, a name blank after cleaning): every surface still shows the sentence with its fallback; a personal agent's web chat shows no line. Tests in Tasks 4, 6, 7.

## Security note seed (the PR's `security-checklist` output starts here)

- **Removed on purpose:** the private-channel capture refusal (TASK-1188). What members say to a team bot in a private channel is now remembered and can be recalled anywhere the team agent works. The four notices replace it.
- **Kept:** outsiders' words are never remembered; Slack Connect and archived channels are refused at turn start and at an Allow; threads marked before this card stay refused (memory's cursor).
- **New untrusted hop:** a team's display name (typed by an admin) goes into a Slack channel message (`shown`: mrkdwn-escaped, controls neutralized), into the Slack card (React text, `cleanLabel` server-side) and into the web chat (React text, `fenceLine` server-side). It never reaches the model.
- **Capability:** no new Slack scope (`chat:write`, posting only where the bot was invited); one fewer untrusted Slack flag read (`is_private`). No new dependency.
- **Concurrency/state:** the claim is one conditional `UPDATE`; `is_private` is dropped at boot (older code re-adds it with `DEFAULT false` at its own boot, so a rollback starts); `notice_posted_at` is nullable and ignored by older code.

## File map

- channel-slack: `channel-store.ts`, `migrations.ts`, `capture-veto.ts`, `channel-check.ts`, `slack-api.ts`, `router.ts`, `answers.ts`, `agent-routes.ts`, `copy.ts`, `manifest.ts`, `plugin.ts`, new `team-name.ts`, new `memory-notice.ts`, `bot-requests.ts`, `bot-request-dms.ts`, doc-only `channels.ts`, `turn-note.ts`.
- channel-slack tests: `channel-store.test.ts`, `memory-channel-store.ts`, `capture-veto.test.ts`, `channel-check.test.ts`, `slack-api.test.ts`, `router.test.ts`, `answers.test.ts`, `agent-routes.test.ts`, `plugin.test.ts`, `copy.test.ts`, `manifest.test.ts`, new `team-name.test.ts`, new `memory-notice.test.ts`, `bot-request-dms.test.ts` (import path).
- channel-web: `lib/agent-slack.ts`, `components/workspace/AgentSlack.tsx`, `AgentSlackBot.tsx`, `AgentSlackBotChannels.tsx`, `AgentView.tsx`, `AgentConversation.tsx`, `ChatComposer.tsx`, `memory-copy.ts`, `lib/workspace-types.ts`, `server/routes-chat.ts`, `server/routes-workspace.ts`, and their tests.
- presets/k8s: `src/__tests__/channel-slack-composition.test.ts`, `src/__tests__/preset.test.ts`.
- Docs: design doc, `.changeset/channel-slack-drop-remember-switch.md`, new `.changeset/slack-private-channels-remembered.md`.

---

### Task 1: A private channel is remembered like any other; the binding forgets privacy [tier: sensitive] (security-checklist)

**Files:**
- Modify: `packages/channel-slack/src/channel-store.ts` (header `:6-29`; `ChannelBinding` `:30-47`; `ChannelThread.notRemembered` doc `:55-62`; `upsert` doc `:95-111` and impl `:227-249`; `setPrivate` `:113-119,:263-272`; `markNotRemembered` `:120-124,:274-276`; `recordThread` doc `:126-156` and impl `:278-348`; `COLUMNS` `:164-172`; `toBinding` `:191-201`)
- Modify: `packages/channel-slack/src/migrations.ts` (docs `:30-33,:44-52`; `ChannelSlackChannelsTable.is_private` `:174`; delete the `ADD COLUMN … is_private` statement and its comment `:261-270`; add a `DROP COLUMN IF EXISTS is_private` statement in the every-boot section after `:423`)
- Modify: `packages/channel-slack/src/capture-veto.ts` (header `:15-32`; `REFUSALS` doc `:47-58`; `lookup` `:82-92`; veto doc `:98-137`)
- Modify: `packages/channel-slack/src/router.ts` (header steps 8-10 `:100-144`; `RouterDeps.channels` and its doc `:162-174`; `channelCheck` doc `:176-182`; step 8b `:677-691`; delete step 8c `:727-753`; step 9 `:754-783`; step 10 doc `:791-800`; `bindBotChannel` doc and `wrote` `:971-1023`)
- Modify: `packages/channel-slack/src/answers.ts` (header `:55-60`; `AnswerDeps.channels` `:136`; step 8b `:426-475`)
- Modify: `packages/channel-slack/src/agent-routes.ts` (`AgentSlackBotChannel` `:89-98`; the mapping `:389-400`)
- Modify (comments only): `channels.ts:20-27,176-189`, `plugin.ts:72-74`, `turn-note.ts:43-55` (do NOT touch `SLACK_NOTE_LEAD`: TASK-1199 edits it), `copy.ts:225-229` (drop "made private,")
- Test: `packages/channel-slack/src/__tests__/plugin.test.ts`, `channel-store.test.ts`, `memory-channel-store.ts`, `capture-veto.test.ts`, `router.test.ts`, `answers.test.ts`, `agent-routes.test.ts`, plus any other file `git grep -n -E "isPrivate|setPrivate|markNotRemembered|is_private" packages/channel-slack/src` lists (except `channel-check*`/`slack-api*`, which are Task 2's)

**Interfaces:**
- Produces (Tasks 3, 4, 6 rely on these):
  - `ChannelBinding = { installId; channelId; agentId; connectedByUserId; channelName; createdAt }` (no `isPrivate`)
  - `upsert(b: Pick<ChannelBinding, 'installId' | 'channelId' | 'agentId' | 'connectedByUserId' | 'channelName'>): Promise<'connected' | 'reconnected' | 'taken'>`
  - `recordThread(t: Omit<ChannelThread, 'notRemembered' | 'external' | 'speakerNames'> & { conversationId: string } & ThreadTurn): Promise<'recorded' | 'no-binding' | 'reconnected'>`: a new row's `not_remembered` is false; a conflict leaves the existing flag as it is.
  - `setPrivate` and `markNotRemembered` are gone. `RouterDeps.channels: Pick<ChannelStore, 'get' | 'recordThread' | 'getThread' | 'upsert' | 'remove'>`; `AnswerDeps.channels: Pick<ChannelStore, 'get'>`.
  - `AgentSlackBotChannel = { channelId: string; name: string }`.
  - Router and answers call `d.channelCheck.check(installId, token, channel)` with no 4th argument (the parameter itself goes in Task 2).

- [ ] **Step 1: Write the failing end-to-end test** in `plugin.test.ts`, beside `"memory through the wiring: a member's thread in a public channel is remembered…"` (`:3055`), using `mentionWhileSlackSays` (`:3127`) and `askMemory`:

```ts
it("memory through the wiring: a member's thread in a private channel is remembered too, with who speaks in it, and her turn carries no not-remembered line (TASK-1203, design §4c)", async () => {
  // conversations.info answers #support as private: is_private true, otherwise the public fixture.
  // Ada (a member) mentions the bot; her turn runs.
  // expect((await channels.getThread(thread))?.notRemembered).toBe(false);
  // expect(await askMemory(harness.bus, thread)).toEqual(<the let-through answer with Ada's names, as the :3055 test builds it>);
  // expect(<Ada's invoke content>).not.toContain(SLACK_NOT_REMEMBERED_LINE);
});
```

Also in `channel-store.test.ts` (Postgres):
- `it('a new thread is recorded remembered (TASK-1203)')`: `upsert` a binding, `recordThread` a member turn → `getThread(...)` has `notRemembered: false`.
- `it('a thread marked before TASK-1203 stays marked when a new turn records it')`: insert a thread row with `not_remembered = true` by SQL, `recordThread` the same conversation → `notRemembered: true`.
- `it("drops the bindings' is_private column: every binding keeps the rest of its row, every thread row (not_remembered included) is left as it was, and a second run changes nothing (TASK-1203)")`: copy the TASK-1202 drop test's recipe (`:178` region: build the old schema by SQL with `is_private`, seed one private binding and one marked thread, run `runMigrations` twice, read `information_schema.columns`). Assert `is_private` is absent both runs and the thread row is byte-identical.
- Update the TASK-1202 drop test: its old schema also carries `is_private`, so "only `remember` went" becomes "only `remember` and `is_private` went".

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @ax/channel-slack test -- src/__tests__/plugin.test.ts src/__tests__/channel-store.test.ts`
Expected: the private-channel test FAILS (`notRemembered` is true and `askMemory` answers `channel-not-remembered`); the drop test FAILS (`is_private` still listed).

- [ ] **Step 3: Implement** the Interfaces block. In `recordThread`'s SQL: the INSERT no longer names `not_remembered` (default false) and the binding CTE no longer selects `is_private`; the `ON CONFLICT … SET` drops the `not_remembered = … OR EXCLUDED.not_remembered` line (the row keeps its flag). In `capture-veto.ts` `lookup`, keep `thread.notRemembered !== false` (legacy marks, sticky) and keep `binding === null || binding.agentId !== thread.agentId`; drop `|| binding.isPrivate !== false`. `channel-not-remembered` now means: marked before TASK-1203 (a turn while the channel was private, or switched off), or no longer connected to the thread's agent. Router step 10's read-back (`:802-806`) is unchanged. In `answers.ts` step 8b, keep refused → `close('channel-not-allowed')`, token-scope → release + `botUnavailable`, unknown → `failed`; delete the private writes and `stillBound`. Migration: the boot drop, with this comment's substance: "TASK-1203 (design §4c): a private channel is remembered like any other, so nothing reads a binding's privacy. A rollback starts without help: older code re-adds the column with DEFAULT false at its own boot, and its next turn reads Slack again."

- [ ] **Step 4: Rewrite and delete the unit tests** that pinned the private refusal: in `capture-veto.test.ts` delete "private binding → refused" cases and keep (or add) `it("a thread marked before TASK-1203 is refused as channel-not-remembered, whatever its binding says")`; in `router.test.ts` delete the step-8c/`setPrivate` and private-marking cases, and keep a not-remembered-line test whose thread is pre-marked in the in-memory store (not made private through Slack); in `answers.test.ts` delete the private-mark cases and keep the refused/token-scope/unknown ones; in `agent-routes.test.ts` and `plugin.test.ts:3395-3403` drop `isPrivate` from the expected `botChannels`; mirror the store in `memory-channel-store.ts` (no `isPrivate`, no `setPrivate`/`markNotRemembered`, insert never marks, conflict keeps the flag). Fix the stale comment at `plugin.test.ts:3109-3120` ("reads public channels only (no groups:read) … never with a channel object flagged private"): a bot holds `groups:read` since TASK-1188, so Slack answers a private channel it was invited to with the channel, and since TASK-1203 that channel is remembered.

- [ ] **Step 5: Run the package and build**

Run: `pnpm --filter @ax/channel-slack test && pnpm --filter @ax/channel-slack build`
Expected: PASS; `tsc` reports nothing (a leftover `isPrivate`, `setPrivate` or `markNotRemembered` reference is a compile error).

- [ ] **Step 6: Mutation check** (commit first; restore with `git checkout HEAD -- <path>`; `git status --short` empty between mutants): (a) delete the `thread.notRemembered !== false` line in `capture-veto.ts` → the legacy-mark veto test FAILS; (b) set the conflict to `not_remembered = false` in `recordThread` → the sticky store test FAILS.

- [ ] **Step 7: Commit**

```bash
git add packages/channel-slack
git commit -m "[TASK-1203] channel-slack: a private channel is remembered like any other; threads marked before stay out"
```

### Task 2: The channel check stops reading privacy [tier: sensitive] (security-checklist)

**Files:**
- Modify: `packages/channel-slack/src/channel-check.ts` (header `:7-82`; `ChannelCheckResult` `:104-113`; `ChannelCheck.check` `:151-161`; `ask` `:185`; `createChannelCheck` `:188-276`)
- Modify: `packages/channel-slack/src/slack-api.ts` (header `:17-20`; `SlackChannel` `:151-168`; `channelOf` `:355-366`)
- Modify (comments only): `packages/channel-slack/src/manifest.ts:8-12,:50-60` (groups:read reads a private channel's archived/Slack Connect flags; drop "never remembers")
- Test: `packages/channel-slack/src/__tests__/channel-check.test.ts`, `slack-api.test.ts`, and fixtures in `router.test.ts`/`answers.test.ts` that still set `isPrivate` on a `SlackChannel`

**Interfaces:**
- Consumes: Task 1's callers already pass no 4th argument.
- Produces: `type ChannelCheckResult = { kind: 'allowed' } | { kind: 'refused'; code: string } | { kind: 'token-scope' } | { kind: 'unknown'; code: string }`; `check(installId: string, botToken: string, channelId: string): Promise<ChannelCheckResult>`; `SlackChannel = { id; name; isChannel; isArchived; isExtShared; isPendingExtShared }`.

- [ ] **Step 1: Write the failing tests**
  - `channel-check.test.ts`: rewrite `:147` as `it('a private, live channel of this workspace is allowed and kept like any allowed answer (TASK-1203)')` asserting `toEqual({ kind: 'allowed' })` and one Slack call across two checks. Rewrite `:501` as `it('an allowed answer still on its way when a refusal lands is not kept, whatever Slack said about privacy')`.
  - `slack-api.test.ts`: `it("conversations.info's is_private is not read: a private channel narrows to the same SlackChannel as a public one (TASK-1203)")` → `toStrictEqual` with no `isPrivate` key, for `is_private: true`, `false` and absent.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @ax/channel-slack test -- src/__tests__/channel-check.test.ts src/__tests__/slack-api.test.ts`
Expected: FAIL (results still carry `isPrivate`).

- [ ] **Step 3: Implement.** Delete `privates`/`privatesBefore`, the private-wins branch and `knownPrivate`; `allowedUntil` keeps only `until`. Keep exactly: a refusal bumps `refusals` and forgets the kept answer; an allowed answer is kept only when no refusal overtook it (`unrefused`); never-kept failures and token-scope. Header: the check answers "may a bot answer here" (live, not Slack Connect); say private-wins went with the private refusal (TASK-1203).

- [ ] **Step 4: Delete** the private-wins/`knownPrivate` tests (`:412`, `:432`, `:445`, `:459`, `:470`, `:483`); keep `:371`, `:391`, `:516` unchanged and green; drop `is_private` from `:277`'s flag combinations (four flags; `connectable` never read it). Drop `isPrivate` from `SlackChannel` fixtures elsewhere.

- [ ] **Step 5: Run the package and build**

Run: `pnpm --filter @ax/channel-slack test && pnpm --filter @ax/channel-slack build`
Expected: PASS.

- [ ] **Step 6: Mutation check:** (a) remove `allowedUntil.delete(key)` from the refused branch → `:391` FAILS; (b) keep an allowed answer even when `flight.refusals !== refusalsBefore` → `:371` FAILS.

- [ ] **Step 7: Commit**

```bash
git add packages/channel-slack
git commit -m "[TASK-1203] channel-slack: the channel check stops reading privacy; refusals still win"
```

### Task 3: Claim a channel's memory notice once per binding [tier: sensitive] (security-checklist)

**Files:**
- Modify: `packages/channel-slack/src/migrations.ts` (channels table doc; `ChannelSlackChannelsTable` gains `notice_posted_at: ColumnType<Date | null, Date | null | undefined, Date | null>`; `ALTER TABLE channel_slack_v1_channels ADD COLUMN IF NOT EXISTS notice_posted_at TIMESTAMPTZ NULL` right after the `channel_slack_v1_channels_agent` index statement, where Task 1 removed the `is_private` ADD; its comment: NULL means the channel hasn't been told yet, so a binding from before this column is told at its next turn)
- Modify: `packages/channel-slack/src/channel-store.ts` (`ChannelStore` gains two methods; `upsert` doc: a reconnect keeps the claim)
- Modify: `packages/channel-slack/src/__tests__/memory-channel-store.ts`
- Test: `packages/channel-slack/src/__tests__/channel-store.test.ts`

**Interfaces:**
- Produces (Task 4):
  - `claimNotice(installId: string, channelId: string, agentId: string): Promise<boolean>`: one `UPDATE channel_slack_v1_channels SET notice_posted_at = now() WHERE install_id = $1 AND channel_id = $2 AND agent_id = $3 AND notice_posted_at IS NULL`; true iff it updated a row.
  - `releaseNotice(installId: string, channelId: string, agentId: string): Promise<void>`: `SET notice_posted_at = NULL` on that binding.
  - The column is not on `ChannelBinding` (nothing reads it).

- [ ] **Step 1: Write the failing tests** (`channel-store.test.ts`, Postgres):
  - `it("claims a binding's notice once: the first claim wins, later ones don't (TASK-1203)")` → `[true, false]`.
  - `it('two replicas claiming one binding at once: exactly one wins')`: two `createChannelStore` instances on two separate `pg.Pool`s against the container; fire 8 claims split across them with `Promise.all` → exactly one `true`.
  - `it('a reconnect keeps the claim; a binding removed and bound again claims again')`: claim → `upsert` same agent (`reconnected`) → claim `false`; `remove` → `upsert` (`connected`) → claim `true`.
  - `it('release reopens the claim')`: claim → release → claim `true`.
  - `it("another agent's binding, or no binding, claims nothing")` → `false`, `false`.
  - `it('a binding from before TASK-1203 has its notice open after the migration, and a second run keeps a claim')`: old schema without the column (Task 1's drop test recipe), one binding; `runMigrations` → claim `true`; `runMigrations` again → claim `false`.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @ax/channel-slack test -- src/__tests__/channel-store.test.ts`
Expected: FAIL (`claimNotice is not a function`).

- [ ] **Step 3: Implement** the two methods and the column. Mirror them in `memory-channel-store.ts`: a claimed set keyed by install/channel, `claimNotice` true only for an existing binding of that agent not yet claimed, `releaseNotice` clears, `upsert`'s reconnect keeps it, `remove`/`removeForAgent` clear it.

- [ ] **Step 4: Run and build**

Run: `pnpm --filter @ax/channel-slack test -- src/__tests__/channel-store.test.ts && pnpm --filter @ax/channel-slack build`
Expected: PASS.

- [ ] **Step 5: Mutation check:** drop `AND notice_posted_at IS NULL` → the two-replica test FAILS (eight winners).

- [ ] **Step 6: Commit**

```bash
git add packages/channel-slack
git commit -m "[TASK-1203] channel-slack: a binding records its memory notice, claimed once across replicas"
```

### Task 4: Post the memory notice on a channel's first turn [tier: sensitive] (security-checklist)

**Files:**
- Create: `packages/channel-slack/src/team-name.ts`; Test: `packages/channel-slack/src/__tests__/team-name.test.ts`
- Create: `packages/channel-slack/src/memory-notice.ts`; Test: `packages/channel-slack/src/__tests__/memory-notice.test.ts`
- Modify: `packages/channel-slack/src/bot-requests.ts` (move `SeenAgent` + `agentSeenBy` `:231-271` and the closure's `teamNamesOf` `:426-446` out to `team-name.ts`; call sites `:472-477` import them), `bot-request-dms.ts:4` and `__tests__/bot-request-dms.test.ts:5` (import path only)
- Modify: `packages/channel-slack/src/slack-api.ts` (`SlackApi.postToChannel`)
- Modify: `packages/channel-slack/src/copy.ts` (`COPY.memoryNotice`, its comment, and the module header's line-group list)
- Modify: `packages/channel-slack/src/router.ts` (`RouterDeps.channels` becomes `Pick<ChannelStore, 'get' | 'recordThread' | 'getThread' | 'upsert' | 'remove' | 'claimNotice' | 'releaseNotice'>`; new step 9b right after the `recorded === 'reconnected'` early return, before step 10's comment; the header's numbered list gains step 9b)
- Modify: `packages/channel-slack/src/plugin.ts:307` (degradation text)
- Test: `copy.test.ts`, `slack-api.test.ts`, `router.test.ts` (fake gains `postToChannel`), `plugin.test.ts` (`:808` pin, and any first-mention Slack-call assertion that now sees the notice), `presets/k8s/src/__tests__/preset.test.ts:1348` (pin)

**Interfaces:**
- Consumes: Task 3's `claimNotice` / `releaseNotice`.
- Produces (Task 6 uses `agentTeamName`):
  - `team-name.ts`: `export interface SeenAgent` and `export async function agentSeenBy(...)` (moved unchanged); `export async function teamNamesOf(bus: HookBus, ctx: AgentContext, userId: string, onFault: (err: unknown) => void): Promise<ReadonlyMap<string, string>>` (moved; the closure's `failed('team', err, requestId)` becomes the caller's `onFault`); `export async function agentTeamName(bus: HookBus, ctx: AgentContext, i: { agentId: string; userId: string }, onFault: (err: unknown) => void): Promise<string | null>`: null without `teams:list-for-user` (asks nothing); otherwise `agentSeenBy(bus, ctx, { agentId: i.agentId, requestedByUserId: i.userId }, onFault)`'s `teamId`, looked up in `teamNamesOf(bus, ctx, i.userId, onFault)`; never throws.
  - `SlackApi.postToChannel(botToken: string, a: { channel: string; text: string }): Promise<void>`: `chat.postMessage` with `{ channel, text, unfurl_links: false, unfurl_media: false }` and no `thread_ts`.
  - `COPY.memoryNotice(team: string | null): string`: the Copy table's two notice strings; `team` through `shown`.
  - `memory-notice.ts`: `export async function postMemoryNotice(d: { bus: HookBus; api: Pick<SlackApi, 'postToChannel'>; channels: Pick<ChannelStore, 'claimNotice' | 'releaseNotice'> }, ctx: AgentContext, i: { installId: string; channelId: string; agentId: string; botToken: string; userId: string }, log: (level: 'info' | 'warn', msg: string, fields?: Record<string, string>) => void): Promise<void>`: claim; nothing more unless claimed; team name; post; on a failed post, release. Never throws. Logs `slack_notice_posted` (info) and `slack_notice_failed { stage: 'claim' | 'post' | 'release', code }` (warn) and `slack_team_name_failed { code }` (warn, from `onFault`). Never `slack_event_failed`: the turn goes on.
  - Router step 9b: `await postMemoryNotice(d, lookupCtx(runAs), { installId, channelId: m.channel, agentId, botToken, userId: runAs }, log)` after the thread is recorded, before step 10. DMs never reach it.
  - channel-slack's `teams:list-for-user` degradation becomes exactly: `"Admin › Slack's list of bot requests names no team, and a team bot's memory notice and Slack card say \"my team\" or \"its team\" instead of the team's name"`.

- [ ] **Step 1: Write the failing tests**
  - `team-name.test.ts`: `it('without teams:list-for-user it is null and asks nothing')`; `it("a team agent's team, as the person's own team list names it, cleaned")`; `it('a personal agent, an answer about another agent, a team missing from the list, or a name blank after cleaning: null')`; `it('a resolve or list that throws is null, and the fault goes to onFault; forbidden and not-found are quiet')`.
  - `slack-api.test.ts`: `it('postToChannel posts top-level mrkdwn text in the channel, unfurls off, no thread_ts')` → method `chat.postMessage`, body exactly `{ channel, text, unfurl_links: false, unfurl_media: false }`.
  - `copy.test.ts`: add `memoryNotice` to the exact key list (`:79`) and its args `[['Support'], [HOSTILE], [null]]`; `it("the memory notice names the team, or says 'my team' (TASK-1203)")` with both exact strings.
  - `memory-notice.test.ts`: `it('claimed: one post with the team named, then slack_notice_posted')`; `it('not claimed: no team lookup and no post')`; `it('a post Slack refuses releases the claim, logs stage post with its code, and resolves')`; `it('a claim that throws logs stage claim and posts nothing')`; `it('a release that throws after a failed post logs stage release and resolves')`; `it("no team name: the 'my team' line")`; `it('a hostile team name goes out escaped')` (contains `&lt;!channel&gt;`, no `<!`).
  - `router.test.ts`: `it("a channel's first turn posts the memory notice once, top-level, before the reply; its second turn posts none (TASK-1203)")` (assert the `postToChannel` call's args and that it precedes `startStream` in `calls`); `it('a notice Slack refuses is posted at the next turn, and both turns run')`; `it("an outsider's first turn posts it too")`; `it('a DM never posts one')`.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @ax/channel-slack test -- src/__tests__/team-name.test.ts src/__tests__/memory-notice.test.ts src/__tests__/copy.test.ts src/__tests__/slack-api.test.ts src/__tests__/router.test.ts`
Expected: FAIL (modules and methods don't exist).

- [ ] **Step 3: Implement** per the Interfaces block. Move `agentSeenBy`/`teamNamesOf` first and run `bot-requests.test.ts` + `bot-request-dms.test.ts` green before adding anything new. `COPY.memoryNotice` comment says: posted once per binding, top-level, on the first turn in a newly bound channel (or one bound before this notice existed); `team` is from outside.

- [ ] **Step 4: Update the pins and wiring tests:** the degradation text in `packages/channel-slack/src/plugin.ts:307`, `packages/channel-slack/src/__tests__/plugin.test.ts:808`, `presets/k8s/src/__tests__/preset.test.ts:1348`; in `plugin.test.ts`, any assertion on a first mention's Slack calls now sees one top-level `chat.postMessage` to the channel (the fake already answers it, `:348-350`).

- [ ] **Step 5: Run and build**

Run: `pnpm --filter @ax/channel-slack test && pnpm --filter @ax/channel-slack build && pnpm --filter @ax/preset-k8s test -- src/__tests__/preset.test.ts`
Expected: PASS.

- [ ] **Step 6: Mutation check:** (a) skip `releaseNotice` after a failed post → "a notice Slack refuses is posted at the next turn" FAILS; (b) post without checking the claim's answer → "its second turn posts none" FAILS; (c) drop `shown()` around the team → the hostile copy row FAILS.

- [ ] **Step 7: Commit**

```bash
git add packages/channel-slack presets/k8s/src/__tests__/preset.test.ts
git commit -m "[TASK-1203] channel-slack: a team bot tells each channel, once, that what it hears is shared with its team"
```

### Task 5: The bot's Slack profile says it [tier: mechanical]

**Files:**
- Modify: `packages/channel-slack/src/manifest.ts:81` (`DEDICATED_BOT_DESCRIPTION`) and `buildBotManifest`'s doc (`:153-157`)
- Test: `packages/channel-slack/src/__tests__/manifest.test.ts` (`:205` region)

**Interfaces:**
- Produces: `export const DEDICATED_BOT_DESCRIPTION = "What I hear is shared with everyone on my team, and I may bring it up elsewhere."` (exported so tests pin it). The shared app's `APP_DESCRIPTION` is unchanged.

- [ ] **Step 1: Write the failing test:** `it("a team bot's profile says what it hears is shared with its team, within Slack's 140 characters (TASK-1203)")` → `buildBotManifest('Ada Bot', urls).display_information.description` equals the string, and its `length <= 140`; update the full-manifest `toStrictEqual` at `:205`.
- [ ] **Step 2: Run:** `pnpm --filter @ax/channel-slack test -- src/__tests__/manifest.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Doc: every manifest send (create, so Set up again; rename; a token Replace) carries it, so an existing bot gets it at its next one.
- [ ] **Step 4: Run:** `pnpm --filter @ax/channel-slack test -- src/__tests__/manifest.test.ts src/__tests__/bots.test.ts src/__tests__/bot-changes.test.ts` → PASS (those two compare against `buildBotManifest(...)`, so they follow).
- [ ] **Step 5: Commit:** `git commit -m "[TASK-1203] channel-slack: a team bot's Slack profile says what it hears is shared"`

### Task 6: The agent's Slack card says it [tier: integration]

**Files:**
- Modify: `packages/channel-slack/src/agent-routes.ts` (`AgentSlackStatus`'s `ready` and `no-workspace` gain `teamName?: string`; `status` `:356-410` fills it with `agentTeamName(d.bus, a.ctx, { agentId: a.agentId, userId: a.userId }, <code-only warn>)`, only when found)
- Modify: `packages/channel-web/src/lib/agent-slack.ts` (`BotChannelRow` `:33-42` loses `isPrivate`; `parseBotChannels` `:222-235`; `AgentSlackStatus` `:85-117` and `parseStatus` `:237-280` gain optional `teamName` (a non-empty string, else the answer is unreadable); `AGENT_SLACK_COPY.privateChannelNotRemembered` removed; `AGENT_SLACK_CARD_COPY.channelsLead` `:457-458`; new `AGENT_SLACK_CARD_COPY.memoryShared`)
- Modify: `packages/channel-web/src/components/workspace/AgentSlack.tsx` (pass `teamName` from both states `:122-131,:182-193`), `AgentSlackBot.tsx` (`AgentSlackBotProps.teamName?: string`; the form `:466-467` renders the memory line first among its notes; Live `:755-756` renders it right before the help line), `AgentSlackBotChannels.tsx:35-45` (row note removed)
- Test: `packages/channel-slack/src/__tests__/agent-routes.test.ts`; `packages/channel-web/src/lib/__tests__/agent-slack.test.ts`, `components/workspace/__tests__/AgentSlackBot.test.tsx`, `AgentSlack.test.tsx`; any `presets/*/src/__tests__` assertion on the settings status body (`git grep -n "botChannels" presets`)

**Interfaces:**
- Consumes: Task 4's `agentTeamName`.
- Produces: `AGENT_SLACK_CARD_COPY.memoryShared(who: string, team: string | undefined): string` (Copy table); `channelsLead(t: InviteTarget): string` → `` `${botWho(t)} has answered in these channels.` ``.

- [ ] **Step 1: Write the failing tests:** agent-routes: `it("a team agent's status names its team for the viewer when the teams service knows it, and leaves it out otherwise (TASK-1203)")` (`ready` and `no-workspace`). agent-slack: `it('parses teamName, and refuses a non-string one')`; `it('a bot channel row carries only its id and name')`. AgentSlackBot: `it('the Live card says what @handle hears is shared with the team, beside the help line')`; `it("the manager's form says it before the bot exists, by the agent's name")`; `it("without a team name it says 'its team'")`; `it('no private-channel note and no memory clause in the channels lead')` (`queryByText("Private channels aren't remembered.")` null; the lead equals `@quill has answered in these channels.`). The words scan already covers every view: run it with `teamName` set.
- [ ] **Step 2: Run:** `pnpm --filter @ax/channel-slack test -- src/__tests__/agent-routes.test.ts` and `pnpm --filter @ax/channel-web test -- src/lib/__tests__/agent-slack.test.ts src/components/workspace/__tests__/AgentSlackBot.test.tsx src/components/workspace/__tests__/AgentSlack.test.tsx` → FAIL.
- [ ] **Step 3: Implement** (invoke the `shadcn` skill first). The memory line copies its neighbour's classes: `text-sm text-muted-foreground` on the form (as `outsidersUseYourAccess`), `text-[12.5px] text-muted-foreground` on Live (as the help line).
- [ ] **Step 4: Run** both packages' tests and `pnpm --filter @ax/channel-web build` (channel-web's tsc includes its tests) → PASS.
- [ ] **Step 5: Commit:** `git commit -m "[TASK-1203] Slack card: what the bot hears is shared with its team; the private-channel note goes"`

### Task 7: Web chat with a team agent says it [tier: integration]

**Files:**
- Modify: `packages/channel-web/src/server/routes-chat.ts` (`TeamsListForUserOutput` `:213-217` gains `displayName: string`; new exported `listTeamsForUser(bus, ctx, userId): Promise<Array<{ id: string; displayName: string }>>` with `listTeamIdsForUser`'s guards and its log key; `listTeamIdsForUser` `:389-409` maps it to ids)
- Modify: `packages/channel-web/src/server/routes-workspace.ts` (`ResolvedAgent` `:397-411` gains `ownerId?: string`; `readMemory` `:5700-5754`: inside the `factsAvailable` branch, when `agent.visibility === 'team'` and `ownerId` is a non-empty string, `teamName` = that team's `displayName` from `listTeamsForUser(bus, initCtx, userId)`, through `fenceLine(…, 128)` (a local `TEAM_NAME_MAX_CHARS = 128`, @ax/teams' `DISPLAY_NAME_MAX`); omitted when unknown; a failed lookup never fails the read)
- Modify: `packages/channel-web/src/lib/workspace-types.ts:856-866` (`AgentMemoryRead.teamName?: string`)
- Modify: `packages/channel-web/src/components/workspace/memory-copy.ts` (beside `MEMORY_TEAM_NOTICE` `:190-195`)
- Modify: `packages/channel-web/src/components/workspace/AgentView.tsx` (`:2226-2260`: pass `composerNote` when `detail.memory?.factsVisibility === 'team'`)
- Modify: `packages/channel-web/src/components/workspace/AgentConversation.tsx` (`Props` `:221`: `composerNote?: string`; render after `<ChatComposer>` `:972-993`, only when not read-only) and `ChatComposer.tsx:27` (`input`'s Pick adds `'aria-describedby'`)
- Test: `packages/channel-web/src/__tests__/server/routes-workspace.test.ts` and `routes-workspace-team-agent.test.ts`; `routes-chat.test.ts`; `components/workspace/__tests__/AgentView.test.tsx`; a new `AgentConversationMemoryNote.test.tsx`

**Interfaces:**
- Produces: `export function memorySharedWith(agentName: string, teamName: string | undefined): string` (Copy table); `AgentConversation`'s `composerNote?: string`.

- [ ] **Step 1: Write the failing tests:** server: `it("a team agent's detail names its team in memory.teamName, cleaned, when the reader's team list has it (TASK-1203)")`; `it("a personal agent's, or one whose team the reader's list lacks, or with the teams service absent or throwing, has no teamName, and the read still answers 200")`; `it('teamName rides only with factsAvailable')`. routes-chat: `/api/chat/agents` output unchanged (its exact test stays green). UI: `it("a team agent's chat says its memory is shared with the team, under the composer, and the field is described by it")` (`getByText("Fern's memory is shared with Support.")`, input `aria-describedby` equals the line's id); `it("without a team name it says 'its team'")`; `it("a personal agent's chat has no such line")`; `it('a read-only Slack conversation has no line')`.
- [ ] **Step 2: Run:** `pnpm --filter @ax/channel-web test -- src/__tests__/server/routes-workspace.test.ts src/__tests__/server/routes-workspace-team-agent.test.ts src/components/workspace/__tests__/AgentView.test.tsx src/components/workspace/__tests__/AgentConversationMemoryNote.test.tsx` → FAIL.
- [ ] **Step 3: Implement** (invoke the `shadcn` skill first). The line: `<p id={noteId} className="mt-2 text-[12.5px] text-muted-foreground">` (`useId`), as a sibling after `<ChatComposer>`, outside its gradient well; the input gets `'aria-describedby': noteId`. No team id, `ownerId` or `ownerType` in any response.
- [ ] **Step 4: Run:** `pnpm --filter @ax/channel-web test && pnpm --filter @ax/channel-web build` → PASS.
- [ ] **Step 5: Commit:** `git commit -m "[TASK-1203] web chat: a team agent's chat says its memory is shared with its team"`

### Task 8: End-to-end through the k8s preset [tier: integration]

**Files:**
- Test: `presets/k8s/src/__tests__/channel-slack-composition.test.ts` (fake Slack `:380-396`; the memory test `:1716`)

- [ ] **Step 1: Write the failing tests:** give the fake's `conversations.info` a private channel (`is_private: true`, otherwise like `SUPPORT_CHANNEL`). `it("memory and a private bot channel: a member's thread is captured with her names, like a public one's (TASK-1203)")` → `preCapture(conv)` equals the let-through answer with her names. `it("a bot channel's first turn posts the memory notice once, top-level, naming the agent's team; its second turn posts none (TASK-1203)")` → exactly one `chat.postMessage` to the channel with no `thread_ts` and text `What I hear is shared with everyone on <the preset's team name>, and I may bring it up elsewhere.`
- [ ] **Step 2: Prove each new test can fail** (Tasks 1-4 are in, so both pass at first; commit first, restore each mutant with `git checkout HEAD -- <path>`, `git status --short` empty between): (a) remove the router's step-9b `postMemoryNotice` call → the notice test FAILS; (b) make `recordThread`'s INSERT write `not_remembered` true → the private-channel test FAILS. Run: `pnpm --filter @ax/preset-k8s test -- src/__tests__/channel-slack-composition.test.ts`.
- [ ] **Step 3: Update** the existing composition tests that count a first mention's Slack calls (`channelTurnCalls`, `promptsIn`, `replyIn` users): each bot channel's first turn now has one extra top-level `chat.postMessage`.
- [ ] **Step 4: Run** the whole preset: `pnpm --filter @ax/preset-k8s test` → PASS.
- [ ] **Step 5: Commit:** `git commit -m "[TASK-1203] preset-k8s: a private bot channel is remembered, and the notice posts once"`

### Task 9: Docs, changeset and the copy pass [tier: mechanical]

**Files:**
- Modify: `docs/plans/2026-11-09-channel-slack-design.md`: §3 `:386-388` (`groups:read` reads a private channel's flags; since §4c it is remembered); §3 `:430-438` ("never remembering it" and "memory is refused" → as built); §4c `:1120` (append the as-built: the first turn in a bound channel, top-level, once per binding through `notice_posted_at`, claimed before it posts and released if Slack refuses; the bot's post and profile speak in the first person; the profile names no team because of Slack's 140 characters); `:1127-1128` (*Done (TASK-1203)*; threads marked before stay refused; the note stays for outsiders and those threads); `:1130` (replace "the private-wins channel check" with "the turn-start channel check and its refusal rules; its private-wins half went with the private refusal (TASK-1203)"); `:1138-1139` (card A's note: private channels are remembered since card B; card B *Done (TASK-1203)*). TASK-1204 edits `:1122-1134` too: if it merged first, rebase and keep both sides.
- Modify: `.changeset/channel-slack-drop-remember-switch.md:14` (drop "private channels still aren't remembered, and the agent is still told so in its turn. A follow-up changes that."; keep the outsiders sentence)
- Create: `.changeset/slack-private-channels-remembered.md` (`'@ax/channel-slack': minor`, `'@ax/channel-web': minor`; CLAUDE.md voice; says: private channels are remembered from their next thread, older private threads stay out; the bot says so once in each channel at its first turn there (existing channels included); the profile, the Slack card and the web chat say it too; the `is_private` column is dropped at boot and a rollback needs nothing)

- [ ] **Step 1: Grep gate.** Run: `git grep -n -i -E "isPrivate|is_private|setPrivate|markNotRemembered|knownPrivate|private wins|never remember|aren't remembered|privateChannelNotRemembered" -- packages presets docs/plans/2026-11-09-channel-slack-design.md .changeset`. Expected survivors only: `credential-proxy`/`mcp-oauth`/`web-tools` IP helpers (`isPrivateIp…`); lines about outsiders' threads, which are still never remembered; §4b.3's superseded history (under its "Superseded by §4c" banner); `.changeset` lines about the removed switch (the follow-up below); and lines that say what this card changed. Any other hit is a stale line: fix it.
- [ ] **Step 2: Edit** the docs and changesets above.
- [ ] **Step 3: Copy check on the rendered surfaces:** if the pre-Task-4 ux pass didn't see the Slack card and the web chat rendered, dispatch the `ux-designer` agent (no `name`; tell it to `cd` into this worktree and run every command there) on those two; apply what keeps one sentence and passes the words rules; record taken and declined items in the decisions shard.
- [ ] **Step 4: Commit:** `git commit -m "[TASK-1203] docs: private channels remembered and the notices, as built; changeset"`

---

## Final gate (before the PR)

- `pnpm build`, then `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`. Docker suites need `DOCKER_HOST`.
- PR description: the `security-checklist` note (seed above); "No hook surface change" (so no boundary review); the copy decisions; the follow-up below.
- Follow-up for auto-ship (not this card): pending changesets still describing the removed remember switch (`.changeset/channel-slack.md:18`, `channel-slack-ui.md:9`, `slack-bot-remember-switch.md`, `slack-switch-bind-lock.md`, `slack-agent-card.md`). Walk D (§4c cards) should check: a private channel's fact recalled in a public one; the notice in a newly invited channel and in one bound before the deploy; Slack accepting the new profile description on a rename.
