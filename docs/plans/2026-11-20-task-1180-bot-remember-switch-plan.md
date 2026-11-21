# TASK-1180: a remember switch for each bot channel, and the team's OFF kept through a Disconnect — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every channel a team agent's own Slack bot answers in gets the same "Let {agent} remember this channel" switch shared channels have, flipped only by a team admin of the agent's team and enforced by the capture veto. A switch the team turned off for a channel is never lost to a Disconnect (Admin › Slack, a moved row, or a rebuilt bot) before the bot first answers there.

**Architecture:** channel-slack keeps the agent's memory switch for each channel in a new table of its own, `channel_slack_v1_memory_switches`, keyed `(agent_id, channel_id)`. It is written in the same statement as every switch flip, filled at boot for bindings written before it existed, and deleted only with the agent. A flip writes every binding of that agent in that channel (shared and bot) at once. The bot's first mention starts from the agent's live shared binding (TASK-1179, unchanged), else the kept switch, else on. A new `POST …/bot/remember` flips a bot channel. The shared `POST …/remember` answers `409 own-bot` once the bot has answered in that channel. The status carries the bot's channels (`botChannels`), and channel-web draws them with the same switch.

**Tech Stack:** TypeScript, Kysely `sql` on Postgres (testcontainers), vitest, React + shadcn (channel-web). One additive migration. No hook, no IPC action, no new dependency.

**Spec:** card TASK-1180 (Vinay, 2026-11-20: ships before phase 2 deploys); `docs/plans/2026-11-09-channel-slack-design.md` §2a (the switch, `:217-222`), §4 As built TASK-1168 (`:457-463`) and TASK-1167 (`:524-540`, "Two known gaps remain"); `.claude/memory/decisions/2026-11-20-TASK-1179.md` rows 7–9. Decisions for this plan: `.claude/memory/decisions/2026-11-20-TASK-1180.md`.

## What the code says (the card's claims, checked)

Read at `1ec64a96b` (main). Line numbers are from that read.

1. **CONFIRMED: OFF is lost when the shared binding goes first.** The bot's first bind takes its switch from `sharedRemember` (`router.ts:887`, `:915-920`). It answers `true` when `installs.current()` is null (Admin › Slack Disconnect) or the binding is gone (`binding === null ? true`; the moved-row Disconnect is `agent-routes.ts:397-407` → `channel-store.ts remove`). A bot's own bindings go with its install (`store.ts remove`, `:547-573`), so a rebuilt bot after either Disconnect starts on too.
2. **CONFIRMED: no bot channel has a switch.** The status lists only shared bindings and drops the ones the bot answered in (`agent-routes.ts:309-314`). `POST …/remember` writes only `installs.current()`'s binding (`:409-420`). The capture veto and `recordThread` read the thread's OWN install's binding (`capture-veto.ts:84-89`, `channel-store.ts:292-305`), so flipping a bot binding is enforced server-side with no veto change.
3. **CONFIRMED: the shared toggle isn't refused on main** (`agent-routes.ts:409-420` has no bot check). This card closes TASK-1178 item 4 with TASK-1179 row 9's narrower rule: refused only where the bot has already answered.
4. **CONFIRMED: "can manage the agent"** is `checkRights(…, 'manage')`, which is `agents:resolve` for the person, then `agents:can-set-shared-credential` asked with `isAdmin: false` (`channels.ts:206-225`, `:253-270`), reached through `manages()` (`agent-routes.ts:271`). Reused as is.
5. **CONFIRMED: the shared "is the bot live" helper exists.** `liveOwnBot` (`channels.ts:281-287`) shipped with TASK-1168. Both new checks use it, so there is no new ad-hoc check. `router.ts:582`/`:749` and `bots.ts`'s inline checks stay TASK-1178's.
6. **What go-live is:** `bots.finish` (`bots.ts:621-647`) → `steps.storeGrant` (`slack-apps.ts:421-437`) → `installs.activate` (`store.ts:499-512`, `pending` → `active`), under the one app lock the callback takes (`bot-callback.ts:165-213`). **REFINED: this plan doesn't hook it** (Approaches, "When"). The switch is kept when it is set, which is always before go-live, so there's nothing left to copy at go-live.
7. **Pre-creating the bot's bindings at go-live is ruled out.** The first mention runs `conversations.info` and `connectable` only when no binding exists (`router.ts:797-822`), so a pre-made row skips the channel check. It would also empty TASK-1168's "still need @bot" list at once (`agent-routes.ts:309-315`: a binding on the bot's install means "answered"). And it goes with the bot on a rebuild.
8. **The new table is agent-keyed.** So `scripts/__tests__/agent-keyed-tables-are-cleaned.test.js` needs a delete in a non-migration file of channel-slack. `agents-deleted.ts:52-63` already calls `channels.removeForAgent`.
9. **Prod already has phase-1 shared bindings** (rev 86+), some switched off, and all written before the new table. The boot backfill gives each one a kept switch. See `patterns.md:812`: "No backfill" is a decision about the majority, so ask what it does to the minority.
10. **No `.claude/memory` row pins a touched file by blob sha.** Only `packages/memory/src/{capture,observer,plugin}.ts` and two scripts are pinned.

**What made the card look true (rule 5).** Two passages in the design were accurate on main and go stale once this lands:
- the TASK-1167 As built bullet that names both gaps (`:529-540`);
- TASK-1168's line saying the bot's own channels aren't listed (`:462-463`).

Stale code prose:
- `agent-routes.ts:27-31` ("The bot's own channels aren't listed");
- `AgentSlack.tsx:1-6`, `:211-213` ("carry nothing else") and `:373` ("the row shrinks to its hint");
- `channel-store.ts:38-42` (the `remember` doc) and `:105`;
- `router.ts:146-150`, `:853-866` and `:909-914`;
- the route lists in `plugin.ts:88-90` and `lib/agent-slack.ts:7-15`.

Tasks 2, 3, 4, 5, 6 and 7 fix these.

## Approaches

**Where the switch is kept once the shared binding is gone.**
- **A. Pre-create the bot's bindings at go-live.** Rejected (finding 7).
- **B. A column on the shared binding.** Rejected: the shared binding is exactly what a Disconnect deletes.
- **C. A table of channel-slack's own, keyed `(agent_id, channel_id)` (chosen).** It outlives every Disconnect and the bot's removal, and goes only with the agent. Slack channel ids are globally unique (TASK-1179 row 4), so no install is in the key.

**When it is written.**
- **A. At go-live, copied from the agent's shared bindings (the card's wording).** The shared toggle would still have to update it afterwards (card: "before that, it sets the bot's starting value"). It needs a hook in `bots.finish` or `activate`, where TASK-1169 and TASK-1171 are working now. And it still loses an OFF whose shared binding was deleted before go-live: Admin › Slack Disconnect, then a bot.
- **B. Whenever the switch is set, in the same statement, plus a boot backfill (chosen).** This is strictly earlier than go-live, so there is no window, and nothing is left to copy at go-live. It covers a Disconnect before the bot exists, and it needs no edit to `bots.ts`, `store.ts` or `bot-callback.ts`. Every OFF comes from one of three places, and each one has a kept switch:
  - a flip;
  - a binding written before the table (the backfill);
  - a bot bind that read one.

**What a flip writes.**
- **A. Only the binding it names, plus the kept switch.** Rejected. Switch a bot channel off, then disconnect the bot: the shared bot answers there again (TASK-1172) with its old ON, and memory captures.
- **B. Every binding of that agent in that channel, on any install, plus the kept switch, in one statement (chosen).** It touches only that agent's rows, so a route that checked rights on agent A still can't touch agent B's.

**What the bot's first mention starts from.** The agent's live shared binding (TASK-1179, unchanged), else the kept switch, else on. The shared binding comes first because a fresh connect writes no kept switch (`upsert` is untouched). So a live binding is never staler than the kept switch, and the kept switch only matters once that binding is gone.

**How a bot channel is flipped.** A new `POST /settings/slack/:agentId/bot/remember`. The shared route isn't redirected, because the card says the shared toggle is *refused* where the bot has answered.

**How the status lists them.** A top-level `botChannels`, present only while the route's own read finds a live bot (as TASK-1168's `answered` set is). It isn't put inside `bot`, which `bots.ts` builds and siblings are editing. And it isn't always present: that would change every `ready` and `no-workspace` exact pin, sibling branches' included.

## Global Constraints

- **Ownership.** Every query against `channel_slack_v1_memory_switches` lives in `channel-store.ts`, plus its DDL and backfill in `migrations.ts`. There are no foreign keys. All SQL is parameterized through Kysely or the `sql` tag. A bare parameter in a SELECT list is cast (`CAST(${x} AS text)`, `CAST(${b} AS boolean)`), as `recordThread` does.
- **Writes are scoped to the named agent.** A flip changes nothing unless the named install's binding of the channel is that agent's. It never touches another agent's row or another channel.
- **Never guess the switch.** A store fault while reading it fails the bind (`say.failed('bind')`), as TASK-1179 row 5 does. A route fault is the route's 500, logged code-only.
- **Logs are code-only.** There is no new log line: a flip logs nothing, which matches the shared toggle. The route wrapper logs failures as `slack_channel_route_failed { stage: 'bot-remember', code }`.
- **No app lock.** Nothing here needs it, and it isn't re-entrant.
- **Don't edit** these files: `bots.ts`, `bot-callback.ts`, `store.ts`, `slack-apps.ts`, `channels.ts`, `commands.ts`, `copy.ts`, `capture-veto.ts`, `AgentSlackBot.tsx`. This card doesn't need them, and TASK-1169 and TASK-1171 are editing `bots.ts`, `AgentSlackBot.tsx` and nearby.
- **Web.** The words live in `lib/agent-slack.ts` `AGENT_SLACK_COPY`. The SPA mirrors channel-slack's wire by shape and never imports it (invariant 2). The UI uses only the shadcn primitives and semantic tokens `AgentSlack.tsx` already imports (invariant 6). Invoke the `shadcn` skill before Task 6.
- **Tests.**
  - One file: `pnpm --filter @ax/channel-slack exec vitest run <file>`, or the same with `@ax/channel-web`. `--filter` goes before the script.
  - Postgres-backed files (`channel-store`, `store`, `agents-deleted`, `plugin`) need `DOCKER_HOST` set, as CLAUDE.md says.
  - `pnpm build` type-checks src. channel-web's tsc also type-checks its tests.
- **Every TRUNCATE in a channel-slack test that shares a database lists the new table** (Task 2). Otherwise a switch kept by one test changes another test's first bind.
- **Commits:** subjects start `[TASK-1180]`, and messages end with the session's attribution lines.

## Review Focus

1. **Bindings written before this deploy** (prod's phase-1 channels, some off). Expect the boot backfill to give each one a kept switch, off if any of that agent's bindings of the channel is off, and never to overwrite one already kept. Task 2 test 7.
2. **A rebuilt bot, after the team switched the old bot's channel off.** Expect the new bot's first mention to start off. The flip wrote the shared binding and the kept switch, and both outlive the bot's removal. Task 2 tests 3 and 5, and Task 3 tests 1 and 2.
3. **A channel switched off, disconnected, then connected again fresh.** Expect it to start on while that fresh connection is live, because the live binding wins over the older kept switch. Task 3 test 3.
4. **A stale page flips a moved row after the bot has answered there.** Expect the server to answer `409 own-bot` and change nothing, and the page to read the status again with no error line. Task 4 test 1 and Task 6 test 9.
5. **The kept switch can't be read at the first mention.** Expect nothing to be bound and nothing to run: the person is told to try again, and the switch is never guessed on. Task 3 test 4.

## Invariants, boundary review, security

- **No boundary review needed.** There's no hook, no service-hook signature, no subscriber payload, no IPC action and no manifest `calls` change. The one new HTTP route goes through the existing `http:register-route`, and channel-web mirrors the status and route by shape.
- **Invariants:**
  1. No hook payloads change.
  2. The SPA mirrors by shape.
  3. One PR, wired end to end, and the new route is on the memory canary's route loop (Task 4).
  4. The runtime switch is still the binding, which `recordThread` and the veto read. The kept switch is one plugin's durable default, written in the same statement as the bindings, and it decides only a binding that doesn't exist yet. Its single writer is `setRemember`, and its single reader is the bot's first bind.
  5. The new route only lets a team admin of the agent's team flip that agent's switch, with the shared toggle's gates. The status shows public channel names and a switch to people who can already see the agent, as the shared rows do.
  6. shadcn only.
- **`security-checklist` is required for Tasks 2, 3 and 4**, and the PR's privacy note comes out of them (the card asks for it). The walk covers:
  - **Task 2:** parameterized SQL, agent-scoped writes, a kept switch written only when the named binding is the agent's, the every-boot backfill (idempotent, off wins), cleanup on `agents:deleted`, and that the table holds only opaque ids and a boolean.
  - **Task 3:** never guess the switch, and which way (toward off or on) each accepted race fails.
  - **Task 4:**
    - the gate order (401, the same 404 for an outsider, a workspace admin outside the team, another team's admin and a missing agent, 403 for a member and for a workspace admin who is a plain member, 409 for a personal agent), all before a body is read;
    - the CSRF check kept, the body cap, the key allow-list, `SLACK_ID_RE` and the boolean check;
    - that the 409 tells the page nothing it doesn't already show.

  Tasks 5 and 6 touch no boundary: React renders channel names as text, and they were cleaned when stored (`cleanChannelName`). Supply chain: N/A.

## File map

| File | Change | Task |
|---|---|---|
| `packages/channel-slack/src/__tests__/plugin.test.ts` | acceptance tests 1a, 1b and 2, plus helpers (1); TRUNCATE (2); route-list pin (4) | 1, 2, 4 |
| `packages/channel-slack/src/__tests__/agent-routes.test.ts` | acceptance test 3 (1); route tests, pins, `EVERY_ROUTE`, status tests (4) | 1, 4 |
| `packages/channel-slack/src/migrations.ts` | the table, the backfill, `ChannelSlackDatabase`, header | 2 |
| `packages/channel-slack/src/channel-store.ts` | `setRemember` writes all of the agent's bindings plus the kept switch; `keptRemember`; `removeForAgent`; docs | 2 |
| `packages/channel-slack/src/__tests__/memory-channel-store.ts` | the same rules, plus `switches` and `kept()` | 2 |
| `packages/channel-slack/src/__tests__/{channel-store,agents-deleted,store}.test.ts` | Postgres tests and TRUNCATE lists | 2 |
| `packages/channel-slack/src/router.ts` | `startingRemember`, `sharedRemember` returns `boolean \| null`, the `channels` Pick, docs | 3 |
| `packages/channel-slack/src/__tests__/router.test.ts` | world `keptRemember` and `keptReadFails`; four tests | 3 |
| `packages/channel-slack/src/agent-routes.ts` | the shared toggle's 409, `POST …/bot/remember`, `botChannels`, header | 4 |
| `packages/channel-slack/src/plugin.ts` | the route-list comment and the switch paragraph | 4 |
| `presets/memory/src/__tests__/canary.test.ts` | `'/bot/remember'` added to the bot-route loop | 4 |
| `packages/channel-web/src/lib/agent-slack.ts` (+ `lib/__tests__/agent-slack.test.ts`) | `BotChannelRow`, `botChannels?`, the parser, `setSlackBotChannelRemember`, `botChannelsNotice`, header | 5 |
| `packages/channel-web/src/components/workspace/SlackRememberField.tsx` | **new**: the switch and its note, lifted out of `ChannelRow` | 6 |
| `packages/channel-web/src/components/workspace/AgentSlackBotChannels.tsx` | **new**: the bot's channel list | 6 |
| `packages/channel-web/src/components/workspace/AgentSlack.tsx` (+ test) | renders both components; moved rows get the switch back; header and comments | 6 |
| `docs/plans/2026-11-09-channel-slack-design.md`, `.changeset/slack-bot-remember-switch.md` | as built | 7 |

Tasks 5 and 6 (channel-web) can run in parallel with Tasks 2–4 (channel-slack). The packages are disjoint, and this plan fixes the wire, as the TASK-1168 and TASK-1172 builders did.

---

### Task 1: The three acceptance tests, red on main `[tier: integration]`

**Files:**
- Test: `packages/channel-slack/src/__tests__/plugin.test.ts`: helpers next to `mentionBody` (`:561`); tests 1a, 1b and 2 at the end of `describe('@ax/channel-slack plugin')`.
- Test: `packages/channel-slack/src/__tests__/agent-routes.test.ts`: `Suffix` (`:267-276`) gains `'/bot/remember'`; test 3 is a new `describe` after `'disconnect and remember'` (`:1553`).

**Interfaces:**
- Consumes, at run time only:
  - Task 2's table and `memory.kept()`;
  - Task 3's bind;
  - Task 4's `POST /settings/slack/:agentId/bot/remember` → `200 {}`, `botChannels` and `409 { error: 'own-bot' }`.
- They stay red until Task 4 lands. channel-slack's tsc doesn't type-check tests, so they compile on main.

- [ ] **Step 1: Add the helpers to `plugin.test.ts`.**

```ts
/** The agent's own bot's signing secret and Slack user id, as seedSupportBot stores them (TASK-1180). */
const BOT_SIGNING_SECRET = 'test-bot-signing-secret-03';
const BOT_USER_ID = 'U07HELPERBOT';
/** An @mention of the agent's own bot in #support (mentionBody's envelope with api_app_id BOT_APP_ID, text `<@${BOT_USER_ID}> ${text}`). */
function botMentionBody(eventId: string, ts: string, text: string, user = ADA_SLACK): Buffer;
/** disconnectSlackFetch, with conversations.info describing #support as a live public channel the bot may bind. */
function botChannelSlackFetch(): { fetchImpl: typeof fetch; calls: Array<{ method: string; auth: string | null; body: Record<string, unknown> }> };
```

  - `conversations.info` answers `{ ok: true, channel: { id: SUPPORT_CH, name: 'support', is_channel: true, is_private: false, is_archived: false, is_ext_shared: false, is_pending_ext_shared: false, is_member: true } }`. `slack-api.ts channelOf` fails closed on a missing flag, so set every one.
  - Each test also defines two closures:
    - `postToBot(body)` is `call('POST', '/slack/events/:installId', request('POST', \`/slack/events/${BOT_INSTALL_ID}\`, { params: { installId: BOT_INSTALL_ID }, body, headers: signed(body, NOW_MS, BOT_SIGNING_SECRET) }))`;
    - `settings(suffix, body, as = ADMIN.id)` POSTs JSON to `/settings/slack/${TEAM_AGENT.id}${suffix}` with `params: { agentId: TEAM_AGENT.id }`.

- [ ] **Step 2: Write test 1a, the moved row's Disconnect.** Name: `"a channel the team switched off stays off when the agent's own bot first answers there, after its shared connection was disconnected (TASK-1180)"`.

```ts
const slack = botChannelSlackFetch();
const { s, call, harness } = await boot({ fetchImpl: slack.fetchImpl });
await seedSupportBot(s);
const channels = createChannelStore(probe);
// The bot hasn't answered in #support yet: the channel is still waiting for it (TASK-1168).
expect(await channels.remove(BOT_INSTALL_ID, SUPPORT_CH, TEAM_AGENT.id)).toBe(true);
expect(await settings('/remember', { channelId: SUPPORT_CH, remember: false })).toEqual({ status: 200, body: {}, done: true });
expect(await settings('/disconnect', { channelId: SUPPORT_CH })).toEqual({ status: 200, body: { removed: true }, done: true });
expect(await channels.get(INSTALL_ID, SUPPORT_CH)).toBeNull();

expect((await postToBot(botMentionBody('Ev07ABCDEF60', '1763036000.000600', 'hello there'))).status).toBe(200);
await vi.waitFor(() => expect(s.invokesReturned).toBe(1));
expect((await channels.get(BOT_INSTALL_ID, SUPPORT_CH))?.remember).toBe(false);
const thread = `conv:slack:${BOT_INSTALL_ID}:${SUPPORT_CH}:1763036000.000600`;
expect((await channels.getThread(thread))?.notRemembered).toBe(true);
expect(await askMemory(harness.bus, thread)).toEqual(NOT_REMEMBERED);
```

- [ ] **Step 3: Write test 1b, Admin › Slack's Disconnect.** Name: `"…after Slack was disconnected in Admin › Slack (TASK-1180)"`. Test 1a's setup, but instead of the moved row's Disconnect:
  - call `call('POST', '/admin/slack/disconnect', request('POST', '/admin/slack/disconnect', { as: ADMIN.id }))`;
  - expect `status` 200;
  - expect `installCount()` to be 1, because the bot stays.

  The same assertions follow: the bot's binding is off, the thread is `notRemembered`, and the thread is `NOT_REMEMBERED`.
- [ ] **Step 4: Write test 2, the bot channel's switch through the wiring.** Name: `"a bot channel's switch: only the agent's team admin flips it, the settings show it, and memory follows it (TASK-1180)"`. Use `seedSupportBot`: #support is bound on both installs, and on.
  1. Ada's mention `'Ev07ABCDEF61'`/`'1763036100.000610'` runs a turn. Its thread `T1` gets `askMemory` → `{ rejected: false, payload: { conversationId: T1, speakerNames: ['Ada', ADA_SLACK] } }`.
  2. `GET /settings/slack/:agentId` as Ada `toMatchObject({ status: 200, body: { state: 'ready', bot: { state: 'live' }, botChannels: [{ channelId: SUPPORT_CH, name: 'support', remember: true }] } })`.
  3. As `'usr_bob'`, `settings('/bot/remember', { channelId: SUPPORT_CH, remember: false }, 'usr_bob')` → `{ status: 404, body: { error: 'not-found' } }`, and the bot's binding is still on.
  4. Ada flips it off: `200 {}`. The bot's binding is off, and so is the agent's shared binding of #support (`channels.get(INSTALL_ID, SUPPORT_CH)`). `askMemory(T1)` → `NOT_REMEMBERED`.
  5. The shared switch is the bot's now: `settings('/remember', { channelId: SUPPORT_CH, remember: true })` → `{ status: 409, body: { error: 'own-bot' } }`, and nothing changes.
  6. A mention while it is off (`'Ev07ABCDEF62'`/`'1763036200.000620'`) records thread `T2` as `notRemembered: true`.
  7. Ada flips it on: `200 {}`. `askMemory(T1)` is let through again, since no turn ran in it while off. `askMemory(T2)` stays `NOT_REMEMBERED`.
- [ ] **Step 5: Write test 3 in `agent-routes.test.ts`.** Name: `"only a team admin of the agent's team flips a bot channel's switch: everyone else gets the shared toggle's answer, and no switch moves (TASK-1180)"`.

```ts
const w = world();
await w.connect(SUPPORT.id, SUPPORT_CH, ADA);
w.state.bot = OWN_BOT; // the route reads the bot itself (liveOwnBot); bots.status isn't asked
await w.memory.store.upsert({ installId: OWN_BOT.installId, channelId: SUPPORT_CH, agentId: SUPPORT.id, connectedByUserId: 'usr_grace', channelName: 'support-desk' });
const flip = async (agentId: string, as: TestUser | null) => {
  const a = await w.call('POST', '/bot/remember', agentId, as, { channelId: SUPPORT_CH, remember: false });
  return { status: a.status, body: a.body };
};
expect((await flip(SUPPORT.id, null)).status).toBe(401);
for (const as of [OTTO, WANDA, SAM]) expect(await flip(SUPPORT.id, as), as.id).toEqual(NOT_FOUND);
expect(await flip('agt_nobody', ADA)).toEqual(NOT_FOUND);
for (const as of [MEL, WILL]) expect(await flip(SUPPORT.id, as), as.id).toEqual(FORBIDDEN);
expect(await flip(PATS.id, PAT)).toEqual({ status: 409, body: { error: 'personal-agent' } });
expect(w.memory.row(OWN_BOT.installId, SUPPORT_CH)?.remember).toBe(true);
expect(w.memory.row(INSTALL_ID, SUPPORT_CH)?.remember).toBe(true);
expect(w.memory.kept(SUPPORT.id, SUPPORT_CH)).toBeUndefined();
expect(w.memory.calls).not.toContain('setRemember');
expect(await flip(SUPPORT.id, ADA)).toEqual({ status: 200, body: {} });
expect(w.memory.row(OWN_BOT.installId, SUPPORT_CH)?.remember).toBe(false);
```

- [ ] **Step 6: Run them and watch them fail.**
  - `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/plugin.test.ts -t "TASK-1180"`. Tests 1a and 1b fail on `expected true to be false`, because main binds the channel on. Test 2 fails on `no route POST /settings/slack/:agentId/bot/remember` (or a missing `botChannels`).
  - `… vitest run src/__tests__/agent-routes.test.ts -t "TASK-1180"` fails with `no route POST /settings/slack/:agentId/bot/remember`.
- [ ] **Step 7: Commit (red).** `[TASK-1180] test: acceptance tests for bot-channel memory switches (red until Task 4)`

---

### Task 2: Keep the agent's switch for each channel apart from its bindings `[tier: sensitive]`, **security-checklist required**

**Files:**
- Modify `packages/channel-slack/src/migrations.ts`:
  - header `:3-114`: a paragraph for the new table;
  - `ChannelSlackDatabase` `:168-173`;
  - the end of `runMigrations` `:330-335`: the table and the backfill.
- Modify `packages/channel-slack/src/channel-store.ts`:
  - header `:6-29`;
  - the `ChannelBinding.remember` doc `:38-42`;
  - the interface `:105-111`;
  - `setRemember` `:248-257`;
  - `removeForAgent` `:259-265`;
  - a new `keptRemember`.
- Modify `packages/channel-slack/src/__tests__/memory-channel-store.ts`: the doc (`:5-28`), `setRemember`, `removeForAgent`, `keptRemember`, `switches`, and `kept()` in the return.
- Test files and their TRUNCATE lists:
  - `channel-store.test.ts`: tests, and TRUNCATE `:43`;
  - `agents-deleted.test.ts`: TRUNCATE `:80`, and a test;
  - `store.test.ts`: TRUNCATE `:31`;
  - `plugin.test.ts`: TRUNCATE `:409`.

**Interfaces:**
- Produces, for Tasks 3 and 4 and the test worlds:

```ts
// migrations.ts
export interface ChannelSlackMemorySwitchesTable {
  agent_id: string;
  channel_id: string;
  remember: boolean;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}
// ChannelSlackDatabase gains: channel_slack_v1_memory_switches: ChannelSlackMemorySwitchesTable;

// channel-store.ts, ChannelStore
/**
 * Flip the agent's memory switch for a channel. `installId`'s binding of the channel must be THIS agent's,
 * else false and nothing is written. Then, in ONE statement, every binding of the agent in that channel, on
 * any install (its shared binding while its own bot answers there, and the bot's), takes it, and so does the
 * switch kept apart from the bindings (keptRemember). Another agent's rows and other channels are never touched.
 */
setRemember(installId: string, channelId: string, agentId: string, remember: boolean): Promise<boolean>;
/**
 * The switch last set for this agent in this channel (TASK-1180): kept when the bindings go (a Disconnect, a
 * removed install, a removed bot), deleted only with the agent. Null when none was ever set or backfilled.
 */
keptRemember(agentId: string, channelId: string): Promise<boolean | null>;
// removeForAgent: also deletes the agent's kept switches, in the same transaction. Return shape unchanged.

// memory-channel-store.ts return gains:
switches: Map<string, boolean>;                                   // key `${agentId}/${channelId}`
kept: (agentId: string, channelId: string) => boolean | undefined; // no call recorded
```

- **Unchanged on purpose:** `upsert`, which never writes the kept switch (Approaches); `remove`, which keeps it; and `store.ts`.

- [ ] **Step 1: Write the failing Postgres tests in `channel-store.test.ts`.** Add a new `describe('the switch kept for the agent and channel (TASK-1180)')`. Add `channel_slack_v1_memory_switches` to its TRUNCATE first.
  1. `'setRemember keeps the switch apart from the binding: a Disconnect keeps it, keptRemember reads it'`: connect, `setRemember(INSTALL, SUPPORT, AGENT, false)` → `true`, then `remove(INSTALL, SUPPORT, AGENT)` → `true`. `keptRemember(AGENT, SUPPORT)` is `false`. Flip it again after reconnecting, on: `true`.
  2. `"keptRemember is null where nothing was set; another agent's switch is that agent's"`: `keptRemember(AGENT, SALES)` is `null`. Bind GENERAL to OTHER_AGENT and switch it off. `keptRemember(AGENT, GENERAL)` is `null`, and `keptRemember(OTHER_AGENT, GENERAL)` is `false`.
  3. `"a flip on one binding flips every binding of the same agent in the channel, on any install, and no other agent's or channel's"`:
     - set up SUPPORT for AGENT on INSTALL and on OTHER_INSTALL, SALES for AGENT on INSTALL, and SUPPORT for OTHER_AGENT on a third install id `'Y2hhbm5lbC1zbGFjay0wMw'`;
     - `setRemember(OTHER_INSTALL, SUPPORT, AGENT, false)` → `true`;
     - both of AGENT's SUPPORT rows are off, SALES is still on, OTHER_AGENT's SUPPORT is still on, and the kept switch is off.
  4. `"a flip named on a binding that isn't the agent's writes nothing: no row moves and nothing is kept"`:
     - connect SUPPORT for AGENT on INSTALL only;
     - `setRemember(OTHER_INSTALL, SUPPORT, AGENT, false)` with no binding there → `false`;
     - `setRemember(INSTALL, SUPPORT, OTHER_AGENT, false)` → `false`;
     - `rawRow(INSTALL, SUPPORT)` is unchanged, and `keptRemember(AGENT, SUPPORT)` is `null`.
  5. `"the kept switch outlives its install's removal (Admin › Slack's Disconnect, a bot's removal)"`:
     - insert the install row first (`installs.insertPending({ installId: INSTALL, appId: 'A07QF9ZK2MN', clientId: '1.2', botName: 'canopy', connectedByUserId: ADA })`, as `:563` does), so `installs.remove` takes the row and its bindings in one statement;
     - connect, switch off, `installs.remove(INSTALL)`;
     - the binding is gone (`channels.get(INSTALL, SUPPORT)` is `null`), and `keptRemember(AGENT, SUPPORT)` is `false`.
  6. `"removeForAgent takes the agent's kept switches with its bindings and threads, and no other agent's"`: kept for AGENT and OTHER_AGENT. After `removeForAgent(AGENT)`, AGENT's is `null` and OTHER_AGENT's stays.
  7. `'runMigrations keeps a switch for every binding written before the table: off if any of the agent\'s bindings of the channel is, never over one already kept, and a second run changes nothing'`:
     - connect SUPPORT on INSTALL and on OTHER_INSTALL; `UPDATE channel_slack_v1_channels SET remember = false WHERE install_id = ${OTHER_INSTALL}` (raw, so nothing is kept);
     - connect SALES;
     - connect GENERAL for OTHER_AGENT, and raw-insert its kept switch as `false` while its binding stays on;
     - `await runMigrations(db)`;
     - expect AGENT/SUPPORT `false`, AGENT/SALES `true` and OTHER_AGENT/GENERAL `false`;
     - run `await runMigrations(db)` again: the same answers.

  Also extend the existing `'runMigrations' > 'a second run keeps every binding and thread'` test (`:177`) so that a kept switch survives the second run too.

  `agents-deleted.test.ts`: in its existing Postgres-backed delete test, or a new one, switch off a channel of the deleted agent and one of another agent first. After `agents:deleted`, the deleted agent's kept switch is gone, and the other's stays.
- [ ] **Step 2: Run them and watch them fail.** `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/channel-store.test.ts src/__tests__/agents-deleted.test.ts` fails with `relation "channel_slack_v1_memory_switches" does not exist`, or with `keptRemember is not a function`.
- [ ] **Step 3: Add the table and the backfill at the end of `runMigrations`.**

```sql
CREATE TABLE IF NOT EXISTS channel_slack_v1_memory_switches (
  agent_id    TEXT NOT NULL,
  channel_id  TEXT NOT NULL,
  remember    BOOLEAN NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, channel_id)
)
```

```sql
-- Every boot: a binding written before this table, or by an older replica, gets its switch kept.
-- Off wins across an agent's bindings of one channel; a switch already kept is never overwritten.
INSERT INTO channel_slack_v1_memory_switches (agent_id, channel_id, remember)
SELECT agent_id, channel_id, bool_and(remember)
  FROM channel_slack_v1_channels
 GROUP BY agent_id, channel_id
ON CONFLICT (agent_id, channel_id) DO NOTHING
```

  Header paragraph, in the file's voice. Cover:
  - the switch the team last set for an agent in a channel, kept apart from the bindings so it outlives a Disconnect;
  - its single writer, `setRemember`, and its single reader, a team agent's own bot's first bind (router.ts);
  - deleted with the agent (agents-deleted.ts), so it is agent-keyed, and the hook is named unquoted, as the existing paragraph does (`:101-105`);
  - the backfill and why it runs every boot.
- [ ] **Step 4: Implement `setRemember` as ONE statement.** It replaces the Kysely update at `:248-257`. Keep the `WHERE` exactly as below. The flip of other installs' rows and the kept switch are both gated on the named binding being this agent's.

```ts
const r = await sql<{ changed: number }>`
  WITH flipped AS (
    UPDATE channel_slack_v1_channels
       SET remember = ${remember}, updated_at = now()
     WHERE channel_id = ${channelId}
       AND agent_id = ${agentId}
       AND EXISTS (
         SELECT 1 FROM channel_slack_v1_channels n
          WHERE n.install_id = ${installId} AND n.channel_id = ${channelId} AND n.agent_id = ${agentId}
       )
    RETURNING install_id
  ), kept AS (
    INSERT INTO channel_slack_v1_memory_switches (agent_id, channel_id, remember)
    SELECT CAST(${agentId} AS text), CAST(${channelId} AS text), CAST(${remember} AS boolean)
     WHERE EXISTS (SELECT 1 FROM flipped WHERE install_id = ${installId})
    ON CONFLICT (agent_id, channel_id) DO UPDATE SET remember = EXCLUDED.remember, updated_at = now()
  )
  SELECT (SELECT count(*) FROM flipped WHERE install_id = ${installId})::int AS changed
`.execute(db);
return (r.rows[0]?.changed ?? 0) > 0;
```

  - `keptRemember` is one Kysely `selectFrom` by `(agent_id, channel_id)`, answering `row?.remember ?? null`.
  - `removeForAgent` adds `trx.deleteFrom(SWITCHES).where('agent_id', '=', agentId)` inside its transaction, with `const SWITCHES = 'channel_slack_v1_memory_switches'`. The repo guard resolves a `const` name.
  - Update the docs: the header gets a paragraph, `ChannelBinding.remember` becomes "on for a new binding unless its writer says otherwise (a team agent's own bot starts from the agent's switch for the channel, TASK-1179/1180)", and the interface docs come from the Interfaces block above.
- [ ] **Step 5: Mirror the rules in `memory-channel-store.ts`.**
  - `setRemember`: false unless the named row is the agent's; else set `remember` on every row with that `channelId` and `agentId`, and `switches.set(\`${agentId}/${channelId}\`, remember)`.
  - `keptRemember` records `'keptRemember'` in `calls` and answers `switches.get(…) ?? null`.
  - `removeForAgent` also deletes that agent's `switches` entries.
  - `upsert` and `remove` don't touch `switches`.
  - Export `switches` and `kept`, and update the doc.
- [ ] **Step 6: Add the new table to the four TRUNCATE lists** (see Files).
- [ ] **Step 7: Run and pass.**
  - `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/channel-store.test.ts src/__tests__/agents-deleted.test.ts src/__tests__/store.test.ts src/__tests__/agent-routes.test.ts src/__tests__/channels.test.ts src/__tests__/router.test.ts`: PASS, except the Task 1 tests, which wait for Task 4.
  - `pnpm test:scripts`: PASS. The agent-keyed guard sees the new delete.
- [ ] **Step 8: Commit.** `[TASK-1180] channel-slack: keep the agent's memory switch for a channel apart from its bindings`

---

### Task 3: A bot's first mention starts from the kept switch once the shared binding is gone `[tier: sensitive]`, **security-checklist required**

**Files:**
- Modify `packages/channel-slack/src/router.ts`:
  - the `RouterDeps.channels` doc and Pick (`:144-151`);
  - the `bindBotChannel` doc (`:853-866`) and its call (`:887`);
  - `sharedRemember` (`:909-920`);
  - a new `startingRemember`.
- Test `packages/channel-slack/src/__tests__/router.test.ts`:
  - `world(o)` (`:360-390`) gains `keptReadFails?: boolean`;
  - `bindings` (`:578-597`) gains `keptRemember`;
  - four tests after the TASK-1179 block (`:2782-2850`).

**Interfaces:**
- Consumes: `ChannelStore.keptRemember` (Task 2).
- Produces: `RouterDeps.channels: Pick<ChannelStore, 'get' | 'recordThread' | 'upsert' | 'keptRemember'>`. `plugin.ts` already passes the full store.

```ts
/** The agent's binding of the channel on the shared app's switch (TASK-1179), or null: no shared app, or no binding of THIS agent there. A store failure throws. */
async function sharedRemember(d: RouterDeps, agentId: string, channelId: string): Promise<boolean | null>;
/** What a team agent's own bot binds a channel with: sharedRemember ?? channels.keptRemember (TASK-1180) ?? true. A store failure throws. */
async function startingRemember(d: RouterDeps, agentId: string, channelId: string): Promise<boolean>;
```

- [ ] **Step 1: Write the failing tests.** In the world, `bindings.keptRemember(agentId, channelId)` throws `new PluginError({ code: 'store-unavailable', plugin: 'fake-store', message: 'db down: #support' })` when `o.keptReadFails`, else delegates to `channels.store.keptRemember`.
  1. `"a channel the team switched off stays off when the bot first answers there, after its shared connection was disconnected (TASK-1180)"`: `setRemember(INSTALL_ID, SUPPORT, SUPPORT_AGENT.id, false)`, then `remove(INSTALL_ID, SUPPORT, SUPPORT_AGENT.id)`, then `putInstall(OWN_BOT)` and a mention. Expect `w.channels.row(OWN_BOT_ID, SUPPORT)` to equal `ownBinding({ remember: false, createdAt: expect.any(Date) })`, and `threadWrites` → `[[OWN_BOT_ID, true]]`.
  2. `"…after Slack was disconnected in Admin › Slack"`: switch off, then `w.disconnect()` plus `w.channels.rows.delete(\`${INSTALL_ID}/${SUPPORT}\`)` (the real `store.remove` takes the install's bindings with it). The bot's binding is off. A rebuilt bot is the same case to the router (no shared binding, a kept switch). That the switch outlives the old bot is Task 2 tests 3 and 5.
  3. `"a channel connected again since it was switched off starts on: the live connection wins over the switch kept from before"`: switch off, remove, then `upsert` a fresh shared binding for the same agent. The bot's binding is on.
  4. `"a kept switch that can't be read binds nothing and runs nothing: the switch is never guessed"`: remove the shared binding and use `world({ keptReadFails: true })`. Expect no bot binding, no invokes, the `COPY.turnFailed` ephemeral, and exactly `{ level: 'error', msg: 'slack_event_failed', fields: { installId: OWN_BOT_ID, stage: 'bind', code: 'store-unavailable' } }`.
- [ ] **Step 2: Run them and watch them fail.** `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/router.test.ts`. Tests 1 and 2 bind on, and test 4 binds on instead of failing.
- [ ] **Step 3: Implement.** `bindBotChannel` uses `startingRemember`. `sharedRemember` returns `null` where it now returns `true`, and its doc says so. Rewrite the two docs, `RouterDeps.channels` and `bindBotChannel`, to name the kept switch. The TASK-1179 tests stay unchanged and green: the binding-read count is the same.
- [ ] **Step 4: Run and pass** the router tests, plus the Task 1 test 1a/1b assertions that no longer need Task 4. 1a and 1b go green here; test 2 and test 3 wait for Task 4.
- [ ] **Step 5: Commit.** `[TASK-1180] channel-slack: a bot's first bind starts from the agent's kept switch once its shared binding is gone`

---

### Task 4: The bot channel's switch route, the shared toggle's refusal, and `botChannels` `[tier: sensitive]`, **security-checklist required**

**Files:**
- Modify `packages/channel-slack/src/agent-routes.ts`:
  - header `:24-70`: replace `:27-31`'s "The bot's own channels aren't listed", and add the route line;
  - `AgentSlackStatus` `:72-105`;
  - `status` `:273-338`;
  - `remember` `:409-420`;
  - a new `rememberBotChannel`;
  - the routes list `:510-521`.
- Modify `packages/channel-slack/src/plugin.ts`: the route comment `:88-90` (`POST …/{connect,disconnect,remember}` and `…/bot{,/install-url,/cancel,/disconnect,/remember}`), and the switch paragraph `:126-131`. Add one sentence: a team agent's own bot's channels have the switch too, and the agent's switch for a channel is kept after a Disconnect.
- Test `packages/channel-slack/src/__tests__/agent-routes.test.ts`:
  - the route pin `:499-555`;
  - `EVERY_ROUTE` `:279-289`;
  - the suffix loops at `:656` and `:1224`;
  - the TASK-1168 live pin `:940-952`;
  - new tests.
- Test `packages/channel-slack/src/__tests__/plugin.test.ts`: the route pin `:763-801`.
- Test `presets/memory/src/__tests__/canary.test.ts`: the bot-route loop `:856`.

**Interfaces:**
- Consumes: `liveOwnBot` (`channels.ts`), and `setRemember` / `listForAgent` (Task 2).
- Produces, the wire Task 5 mirrors:

```ts
/** A channel the agent's own bot has answered in (a binding on its install), with that binding's memory switch (TASK-1180). */
export interface AgentSlackBotChannel { channelId: string; name: string; remember: boolean }
// AgentSlackStatus 'no-workspace' and 'ready' each gain:
/** The agent's own bot's channels, oldest first. Present only when the route's own read finds the bot live (as `needsInvite` is). */
botChannels?: AgentSlackBotChannel[];
```

  - `POST /settings/slack/:agentId/bot/remember { channelId, remember } → 200 {}`. Every refusal is the shared toggle's answer, in the same order: 401; the same 404 `not-found` (outsider, a workspace admin outside the team, another team's admin, a missing agent); 403 `forbidden` (a member, a workspace admin who is a plain member); 409 `personal-agent`. All of these come before the body is read. Then 400 `invalid-body` for an unknown key, a bad `channelId` or a non-boolean `remember`, and 413 past `ADMIN_BODY_MAX_BYTES`. Then 404 `not-connected` when the agent has no live bot or the bot has no binding of that channel. It works with no shared app.
  - `POST /settings/slack/:agentId/remember`: after today's `install === null` → 404 `not-connected`, if the agent's live bot has a binding of `channelId` for this agent, it answers `409 { error: 'own-bot' }` and writes nothing.
  - Register the new route with `route('POST', '/bot/remember', 'bot-remember', rememberBotChannel)`, **immediately after** `route('POST', '/remember', …)`. That spot is away from where sibling cards add bot routes.

- [ ] **Step 1: Write the failing tests in `agent-routes.test.ts`.**
  1. `"the shared switch is refused with 409 own-bot once the agent's own bot has answered in that channel, and nothing changes; before that it flips the shared binding and the kept switch the bot will start from"`:
     - connect SUPPORT and SALES; `w.state.bot = OWN_BOT`;
     - `remember(SALES_CH, false)` → `200 {}`, the shared row is off, and `w.memory.kept(SUPPORT.id, SALES_CH)` is `false`;
     - upsert the bot's binding of SUPPORT; `remember(SUPPORT_CH, false)` → `409 { error: 'own-bot' }`; both rows stay on, and the `'setRemember'` count doesn't change.
  2. `'a pending bot changes nothing: the shared switch flips as before'`: with `PENDING_BOT`, → `200 {}`.
  3. `"the bot's switch flips the bot's binding, the agent's shared binding of that channel and the kept switch; 404 not-connected where the bot hasn't answered, with no bot, or with a pending one"`. Flipping SALES_CH, where the bot has no binding, → 404.
  4. `'the bot channel switch needs no shared app'`: `w.state.install = null`, a live bot with a binding → `200 {}`.
  5. `"the bot channel switch takes only its own keys and a boolean"`: an extra `agentId` key → 400, `remember` of `'false'`, `0` or `null` → 400, and nothing written.
  6. `"a store fault reading the agent's bot is the bot switch's 500, logged as slack_channel_route_failed { stage: 'bot-remember', code } and never naming the channel"`.
  7. `"the section lists the live bot's own channels with their switches, oldest first, to managers and members, with or without the shared app; no botChannels without a live bot"`:
     - connect SUPPORT and SALES through the shared app; `w.state.bot = OWN_BOT`;
     - the bot binds SUPPORT (`w.memory.store.upsert` on `OWN_BOT.installId`), then switch it off through the fake's `setRemember` on the bot's install;
     - `status(MEL)` has `botChannels: [{ channelId: SUPPORT_CH, name: 'support-desk', remember: false }]`, and `channels` is SALES only, with `needsInvite: true`;
     - with `w.state.install = null`, the `no-workspace` body has the same `botChannels`;
     - with `PENDING_BOT`, `expect(body).not.toHaveProperty('botChannels')`.

  Update the pins:
  - add the route to the route-list pin, right after `/remember`, with `maxBodyBytes: ADMIN_BODY_MAX_BYTES`;
  - add `{ method: 'POST', suffix: '/bot/remember', body: { channelId: SUPPORT_CH, remember: false } }` to `EVERY_ROUTE`;
  - add `'/bot/remember'` to the suffix lists at `:656` (rights before body) and `:1224` (413);
  - add `botChannels: []` to the TASK-1168 live `toEqual` at `:940-952`.

  The TASK-1172 no-workspace pin at `:827-834` stays as it is: it sets no `w.state.bot`, so the route's own read finds no bot. That proves the field is absent then.

  Other updates:
  - `plugin.test.ts`: add the route to the route-list pin, right after `/remember`, with `bypassCsrf: false`.
  - The canary: add `'/bot/remember'` to the loop at `:856`. It expects the CSRF 403, then the route's 404.
- [ ] **Step 2: Run them and watch them fail.** `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/agent-routes.test.ts` fails with `no route POST …/bot/remember` and a missing `botChannels`.
- [ ] **Step 3: Implement.**
  - **`status`.** Compute `own` once, as today (`bot.state === 'live' ? await liveOwnBot(d.installs, a.agentId) : null`), but BEFORE the `!sharedActive` return. Then `const ownBindings = own === null ? null : await d.channels.listForAgent(own.installId, a.agentId)` and `botChannels = ownBindings?.map(b => ({ channelId: b.channelId, name: b.channelName, remember: b.remember }))`. Add `...(botChannels !== undefined ? { botChannels } : {})` to both bodies. `answered` comes from `ownBindings`, with no second read.
  - **`remember`.** Insert the `own-bot` check: `liveOwnBot`, then `d.channels.get(own.installId, channelId)`, and `binding.agentId === a.agentId`.
  - **`rememberBotChannel`.** It runs in this order:
    1. `manages`;
    2. `readBody(a.req, ['channelId', 'remember'])` and the boolean check;
    3. `liveOwnBot`;
    4. `own !== null && setRemember(own.installId, …)`;
    5. answer `200 {}`, or 404 `not-connected`.
  - Update the header's route lines and its TASK-1168 sentence. It now reads: the bot's own channels are listed too (`botChannels`), each with a switch flipped by `…/bot/remember`, and the shared toggle answers `409 own-bot` once the bot has answered in a channel.
- [ ] **Step 4: Run and pass.**
  - `pnpm --filter @ax/channel-slack test`: every Task 1 test is green now.
  - `pnpm --filter @ax/preset-memory exec vitest run src/__tests__/canary.test.ts` (Docker).
  - `pnpm build`.
- [ ] **Step 5: Commit.** `[TASK-1180] channel-slack: a switch for each bot channel, the shared one refused where the bot answers, and the bot's channels in the status`

---

### Task 5: channel-web reads `botChannels` and can flip one `[tier: mechanical]`

**Files:**
- Modify `packages/channel-web/src/lib/agent-slack.ts`:
  - header `:7-15`: add the route line;
  - types `:28-100`;
  - `parseStatus` `:214-247`;
  - a new `setSlackBotChannelRemember` next to `setSlackChannelRemember` (`:354`);
  - `AGENT_SLACK_COPY` `:416-437`.
- Test `packages/channel-web/src/lib/__tests__/agent-slack.test.ts`.

**Interfaces:**
- Consumes: the wire from Task 4.
- Produces, for Task 6:

```ts
/** A channel the agent's own bot has answered in, with its memory switch (TASK-1180). */
export interface BotChannelRow { channelId: string; name: string; remember: boolean }
// 'no-workspace' and 'ready' each gain:
/** The agent's own bot's channels, oldest first, only while `bot` is live. An older host omits it; that reads as none. */
botChannels?: BotChannelRow[];
/** Turn "remember this channel" on or off for one of the bot's channels. Resolves once the server holds it. */
export async function setSlackBotChannelRemember(agentId: string, channelId: string, remember: boolean): Promise<void>;
AGENT_SLACK_COPY.botChannelsNotice: (t: InviteTarget) => string
// handle:    `@${t.handle} has answered in these channels.`
// no handle: `${t.botName} has answered in these channels.`
```

  The parser omits `botChannels` when it's absent. When it's present, it must be an array whose every entry has a string `channelId`, a string `name` and a boolean `remember`. Anything else makes the whole answer a `bad-response`, never a half-drawn list.

- [ ] **Step 1: Write the failing tests.**
  1. `"reads the agent's own bot's channels on ready and no-workspace; an older host that omits them reads none; a malformed one is a bad response (TASK-1180)"`. Cover these cases: absent; `[]`; a row; a row whose `remember` is `'yes'`; and `botChannels: {}`.
  2. `'setSlackBotChannelRemember POSTs {channelId, remember} to /settings/slack/:agentId/bot/remember with the write headers'`. Use `a/1` to pin the encoding (`/settings/slack/a%2F1/bot/remember`).
  3. `"the bot channel line names the bot's @handle, or its name when Slack never said one"`.
- [ ] **Step 2: Run them and watch them fail.** `pnpm --filter @ax/channel-web exec vitest run src/lib/__tests__/agent-slack.test.ts`.
- [ ] **Step 3: Implement** the Interfaces block.
- [ ] **Step 4: Run and pass**, then run `pnpm --filter @ax/channel-web build` (tsc type-checks the tests too).
- [ ] **Step 5: Commit.** `[TASK-1180] channel-web: read the bot's channels and flip one`

---

### Task 6: Agent settings show each bot channel's switch, and a moved row's switch again `[tier: integration]`

**Files:**
- Create `packages/channel-web/src/components/workspace/SlackRememberField.tsx`.
- Create `packages/channel-web/src/components/workspace/AgentSlackBotChannels.tsx`.
- Modify `packages/channel-web/src/components/workspace/AgentSlack.tsx`:
  - header `:1-14`;
  - the no-workspace view `:146-166`;
  - `ReadySection` `:194-357`, including the comment at `:211-213`;
  - `ChannelRow` `:359-466`: the moved branch `:383-408`, the switch block `:439-458`, and the prop doc `:373`.
- Test `packages/channel-web/src/components/workspace/__tests__/AgentSlack.test.tsx`: add `setSlackBotChannelRemember` to the `vi.mock` list (`:26-36`); change one TASK-1168 test (`:186-195`); add a new `describe`.

**Interfaces:**
- Consumes: `BotChannelRow`, `botChannels?`, `setSlackBotChannelRemember`, `AGENT_SLACK_COPY.botChannelsNotice` and `rememberFailed`, `agentSlackWriteStale` and `InviteTarget` (Task 5).
- Produces:

```tsx
// SlackRememberField.tsx: exactly what ChannelRow draws today at :439-458, lifted so both lists match.
export function SlackRememberField(props: {
  id: string;            // the Switch's id; its note is `${id}-note`
  agentName: string;
  remember: boolean;
  canManage: boolean;    // a manager gets the Switch; anyone else the note, only while it is on
  busy: boolean;         // disables the Switch at its old position (never optimistic)
  onChange: (on: boolean) => void;
}): JSX.Element | null;

// AgentSlackBotChannels.tsx: null when `channels` is empty.
export function AgentSlackBotChannels(props: {
  agentId: string;
  agentName: string;
  canManage: boolean;
  invite: InviteTarget;  // the live bot, for the lead-in line
  channels: BotChannelRow[];
  onStale: () => void;   // a 403/404/409: read the status again
}): JSX.Element | null;
```

- **Layout.**
  - The bot channels list has a muted lead-in `<p className="text-[13px] text-muted-foreground">` with `botChannelsNotice(invite)`.
  - Under it is the same `Card`/`CardContent`/`ul` as the shared list, with `aria-label="Channels its own bot has answered in"`.
  - Each row has the `#`-icon name line, then `SlackRememberField` with `id={\`slack-bot-remember-${channelId}\`}`, then the row's error line (the shared row's `role="alert"` paragraph).
  - There is no Disconnect and no "Connected by".
  - Rows live in local state seeded from props. A re-read remounts the component, because the loading face unmounts it. A write follows `ReadySection.remember`: mark busy, clear the row's error, `await setSlackBotChannelRemember`, then update the row. On failure, `agentSlackWriteStale` → `onStale()`, else the row's error `AGENT_SLACK_COPY.rememberFailed`. Always unmark at the end.
- **Placement.**
  - In `ReadySection`, when `invite !== null` and `(ready.botChannels ?? []).length > 0`, the list goes right after the `notice` Alert and before the shared list.
  - In the no-workspace view, when `state.bot.state === 'live'`, it goes after the "Slack isn't connected" line and before `AgentSlackBot`, with `canManage={state.canManage}` and `onStale={read}`.
- **Moved rows.** A moved row gets `SlackRememberField` between its header and its error, wired to the existing `onRemember`. It now sets the bot's starting value. Its hint, Disconnect and the missing "Connected by" and Reconnect stay as they are. Rewrite the `:211-213` comment and the `:373` prop doc to say this.

- [ ] **Step 1: Invoke the `shadcn` skill** (`-c packages/channel-web`). No new primitive is expected.
- [ ] **Step 2: Write the failing tests** in `describe("the agent's own bot's channels (TASK-1180)")`. Use the fixture `const BOT_SUPPORT: BotChannelRow = { channelId: 'C0BOTSUP01', name: 'help', remember: true }` and `renderIt({ ...ready([], true, LIVE_BOT), botChannels: [BOT_SUPPORT] } as AgentSlackRead)`.
  1. `'live: the channels its own bot has answered in are listed under one line, each with the same memory switch a shared channel has'`. Check the text `'@quill has answered in these channels.'`, the list `'Channels its own bot has answered in'` containing `'help'`, a checked switch `'Let Quill remember this channel'`, and the shared rows' accessible description.
  2. `'a manager flips one: the switch holds its old place while the write is out, then lands'`. Use a deferred `setSlackBotChannelRemember`: it was called with `('a1', 'C0BOTSUP01', false)`, the switch is disabled and checked while pending, and unchecked after.
  3. `'a failed flip leaves the switch where it was and says nothing changed'`. A rejection of `AgentSlackError(500, 'internal')` gives an alert with `rememberFailed`, and the switch stays checked.
  4. `'a refusal that says the page is stale (403, 404, 409) reads the status again'`. Use `it.each`: `fetchStatus` is called twice.
  5. `'a member sees each channel, and the note only where memory is on; no switch'`.
  6. `"with Slack not connected, a live bot's channels are still listed, and a manager can flip them"`.
  7. `'no botChannels (an older host, or no live bot): no list'`.
  8. `'with no handle, the line names the bot'`: `'Quill has answered in these channels.'`.
  9. `"a moved channel's switch is the bot's starting value: a manager flips it through the shared route, and a 409 own-bot reads the status again"`. `setSlackChannelRemember` was called with `('a1', 'C0SUPPORT1', true)`, then a rejection of `AgentSlackError(409, 'own-bot')`, then `fetchStatus` is called twice.

  **Change** the TASK-1168 test at `:186` to `'a channel it still needs has its memory switch, but no "Connected by" and no Reconnect: its hint and, for a manager, Disconnect'`. Swap `queryByRole('switch')` → null for `getByRole('switch', { name: 'Let Quill remember this channel' })`. The `/remembers what people with access/` check now expects the switch's description, not null. The member test at `:207` stays as it is: `MOVED` is off, so there's no note.
- [ ] **Step 3: Run them and watch them fail.** `pnpm --filter @ax/channel-web exec vitest run src/components/workspace/__tests__/AgentSlack.test.tsx`.
- [ ] **Step 4: Implement** the two new files and the `AgentSlack.tsx` changes. The existing shared-switch tests (`:454-480`, `:559-630`) must pass unchanged. They prove the lift changed nothing.
- [ ] **Step 5: Run and pass**, then `pnpm --filter @ax/channel-web build` and `pnpm lint`.
- [ ] **Step 6: Commit.** `[TASK-1180] channel-web: a memory switch for each bot channel, and a moved channel's switch back`

---

### Task 7: The design says what was built, plus the changeset `[tier: mechanical]`

**Files:**
- Modify `docs/plans/2026-11-09-channel-slack-design.md`: §2a `:217-222`, §4 `:457-463` and `:529-540`, and §9 `:1081-1086`.
- Create `.changeset/slack-bot-remember-switch.md`.

**Interfaces:** none.

- [ ] **Step 1: Edit the design.**
  - **§2a, after the switch bullet.** "A team agent's own bot's channels have the same switch, in the same place (TASK-1180). AX also keeps the agent's switch for each channel apart from its connections, so a Disconnect (of the channel, or of Slack in Admin › Slack) doesn't lose it: the agent's own bot starts there where the team left it. A brand-new channel still starts on."
  - **§4, TASK-1168 As built.** Replace "The bot's own channels aren't listed yet, so a channel that left the list doesn't come back if the bot is later removed from it." with "A channel that leaves this list moves to the bot's own list, which has its own memory switch (TASK-1180). AX hears only mentions, so a channel the bot was later removed from stays on that list."
  - **§4, TASK-1167 As built: the remember bullet (`:529-540`).** Replace it with two bullets:
    - "That binding starts with the switch the team last set for the agent in that channel: the shared app's binding of it while there is one (TASK-1179), else the switch AX keeps for the agent and channel, which outlives a Disconnect (of the channel, or of Slack in Admin › Slack) and a rebuilt bot (TASK-1180). With neither, it starts on. If the switch can't be read, nothing is bound and nothing runs."
    - "Each of the bot's channels has its own switch in the agent's settings. Only a team admin of the agent's team flips it, and the capture veto enforces it, as on the shared app. A flip also sets the agent's shared binding of that channel, so the shared bot carries on with it if the bot is disconnected. The shared connection's switch is refused (`409 own-bot`) only once the bot has answered in that channel. Before that it is the bot's starting value, so a moved channel's row shows it. A flip racing the bot's first answer in that channel can leave the bot on the value from just before the flip: the page shows which."
  - **§9, item 8 *Progress*.** Add a line: "TASK-1180 gave each bot channel its memory switch, and keeps the agent's switch for a channel after a Disconnect."
- [ ] **Step 2: Write the changeset.** Patch for `'@ax/channel-slack'` and `'@ax/channel-web'`, in the CLAUDE.md voice:

```md
Each channel a team agent's own Slack bot answers in now has its own "remember this channel" switch in the agent's settings, just like the shared bot's channels, and only a team admin of the agent's team can flip it. When the team switched memory off for a channel, it stays off when the agent's own bot first answers there, even if the shared connection was disconnected in between. We don't forget that you asked us to forget.
```

- [ ] **Step 3: Check it.** `pnpm test:scripts` checks the doc's paths and the memory guards. Expected: PASS.
- [ ] **Step 4: Commit.** `[TASK-1180] docs: as built for bot-channel memory switches`

---

## Final gate (before the PR)

1. These must list nothing:
   - `git grep -n "carry nothing else" packages`
   - `git grep -n "shrinks to its hint" packages`
   - `git grep -n "aren't listed" packages/channel-slack/src/agent-routes.ts docs/plans/2026-11-09-channel-slack-design.md` (both old sentences break across a line, so grep the short phrase)

   `git grep -n "keptRemember\|channel_slack_v1_memory_switches" packages` lists only `migrations.ts`, `channel-store.ts`, `router.ts` and tests.
2. `pnpm build && pnpm lint`.
3. `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, with `DOCKER_HOST` set as CLAUDE.md says. A Docker slot-wait or teardown timeout in an untouched package gets re-run alone, not waved through. `AX_TESTCONTAINER_START_SLOT_WAIT_MS` above 600000 is a config error (TASK-1172).
4. Rebase on `origin/main` first. TASK-1169 and TASK-1171 work in the same files, so expect textual conflicts in these places. Keep both sides, then re-run the targeted files.
   - `agent-routes.ts` (the route list and the header);
   - `agent-routes.test.ts` (`EVERY_ROUTE`, the route pin);
   - `plugin.test.ts` (the route pin, TRUNCATE);
   - the canary loop;
   - `AgentSlack.tsx`;
   - `lib/agent-slack.ts` (the header, `AGENT_SLACK_COPY`);
   - the design's §4 and §9;
   - the `plugin.ts` comment.

## For the builder's handoff

**For auto-ship:** TASK-1178 item 4 (refuse the shared toggle) is done here, with the narrower rule (`409 own-bot` only where the bot has answered). Drop it from that card.

**Residuals for the PR's privacy note** (accepted; candidate follow-ups):
1. **A flip racing the bot's first answer in that channel** (a window of milliseconds) can leave the bot's binding with the value from just before the flip. If the flip was to off, members' words in those first threads are remembered. The page shows the bot channel's real switch. Closing it needs a row lock both sides take: the bind reads the kept switch `FOR UPDATE`, and the flip upserts it first and then updates the bindings in a second statement.
2. **Switched off, disconnected, connected again fresh, then disconnected again before the bot first answers.** The bot starts off, from the older kept switch, though the fresh connection was on. This fails toward off, and the switch is shown. The fix, if it matters: `upsert`'s insert writes the kept switch too.
3. **A bot channel the bot was `/kick`ed from stays listed.** AX hears only mentions.
4. **Two flips at once** of one agent's channel, on two bindings, can deadlock. Postgres aborts one with a 500, and a retry works.
5. **A bootstrap reset leaves kept switches as orphans,** keyed by agent ids that no longer exist, as thread rows already are. They're unreadable, and they hold no personal data.

**Learnings:**
- A switch that has to follow a resource to its next owner is best kept at the moment it is *set*, not copied at the hand-off. That way nothing depends on what deletes the source first, and go-live needs no hook.
- `setRemember` now writes every binding of that agent in the channel, plus the kept switch. A future writer of `remember` must keep that one-statement rule, or a bot's removal hands the shared bot a stale value.
- `botChannels` is present only when the route's own read finds the bot live, as TASK-1168's `answered` set is. A test that sets `bots.answers.status` to live but no `state.bot` gets no `botChannels`.
