# TASK-1186: team agents reach channels only through their own bot — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task heading carries its `[tier: …]` tag; dispatch each implementer at the model and effort that tag maps to.

**Goal:** Remove the shared Slack app's channel path end to end (design §4b.1), so a team agent is reached in a channel only through its own bot, and the shared bot keeps only DMs, approval buttons and the bot-request DMs.

**Architecture:** This is a removal, not a migration: prod has no real users (Vinay, 2026-11-21). The router answers a shared-bot mention in a channel with one private line. It never reads a binding or runs a turn for one. `/ax`, the agent-settings routes for available, connect, disconnect and remember, and the connect core in `channels.ts` all go. The shared manifest drops `channels:read`, `channels:join`, `commands` and its slash command. Every boot deletes the shared install's rows from `channel_slack_v1_channels`, after the existing memory-switch backfills have run. A bot's first bind reads only the kept switch. channel-web loses the channel picker, the shared "Connected channels" list and the moved-channels list.

**Tech stack:** TypeScript; Kysely on Postgres (testcontainers); vitest; React with shadcn in `packages/channel-web`.

**Spec:** `docs/plans/2026-11-09-channel-slack-design.md` §4b.1, lines 800–844 (card A of "Order and cards", lines 906–923). The card brief is in the builder's scratchpad (`cards/TASK-1186-brief.md`). Decisions are in `.claude/memory/decisions/2026-11-21-TASK-1186.md`, and the builder appends to it.

**Where the brief is wrong or incomplete.** Each of these was checked against the code.
- **`channel-route.ts` has no routes.** It is the pure sender-tier decider (`decideTier`, `runsAsConnector`), and the bot path still uses it. It stays; only its prose changes (Task 3). The shared routes live in `agent-routes.ts`.
- **Also dead after removal, and not in the brief:**
  - the TASK-1170 "bot is live" DM's shared-channel list: `bot-request-dms.ts` `stillWaiting`, `COPY.botLiveForOwner`'s channel arguments, and `BOT_LIVE_DM_CHANNELS_MAX` (Task 5);
  - `TOKEN_REFUSED_CODES` and `isTokenRefused`, plus `ChannelStore.listAll` and `ChannelDeps` (Task 4);
  - the Admin sentences "The shared bot answers … again in any channel it was connected to before" (in `AgentSlackBot.tsx` and `SlackBotsCard.tsx`), and the Rename, Replace and `slack-app-gone` copy (Task 6);
  - the pending changesets that describe removed features (Task 7).
- **`channels:read` is unused too.** Once `connectChannel` and `listAvailableChannels` are gone, nothing calls `conversations.*` with the shared token. So it goes along with the two scopes the design names (Task 4).
- **TASK-1184 makes `ChannelStore.remove` live again.** It is in flight on `auto-ship/TASK-1184-slack-channel-recheck`, and its router calls `channels.remove(...)`. See Step 0.

---

## Step 0: TASK-1184, before Task 1 and again before the PR

TASK-1184 re-checks a bound channel each turn. It edits `router.ts`, `router.test.ts`, `copy.ts`, `channels.ts`, `plugin.ts`, `slack-api.ts` and the design doc. It adds `channel-check.ts`. When Slack refuses a bound channel, its router calls `d.channels.remove(installId, channel, agentId)`. Find out whether it has merged:

```bash
git fetch origin && git log --oneline origin/main | grep -m1 'TASK-1184'
```

- **Case A: it has merged.** Run `git merge origin/main` first. Then, through every task:
  - Keep `ChannelStore.remove`, its in-memory fake and its store tests. The router's channel check uses them.
  - Task 3 also deletes 1184's shared-install branches. For example, `install.kind === 'shared' ? COPY.channelUnavailable : COPY.botUnavailable` becomes `COPY.botUnavailable`. It also deletes 1184's shared-install router tests.
  - Task 4 fixes `channel-check.ts` prose that names `connectChannel` or says both apps read public channels: only the bot's manifest has `channels:read` now.
  - Keep `COPY.channelNoLongerAllowed`.
- **Case B: it hasn't merged.** Task 4 removes `ChannelStore.remove`, and the handoff's `learnings:` says TASK-1184 must add it back.
- **If it merges mid-build,** merge `origin/main` at the next task boundary and apply Case A from there.

## Global constraints

- **Memory.** Never delete a line under `.claude/memory/` (rule R1) and never touch a root archive (rule R2). New rows go into TASK-1186 shards only.
- **Copy (channel-slack `copy.ts`).** No line names the product (`\bAX\b`). No line holds `<`, `>`, `<@`, `<!`, `<#`, or a bare `@here`, `@channel` or `@everyone` (`copy.test.ts`).
- **Logs** stay code-only: never a Slack id, an email, a person's or channel's name or id, a bot handle, or message text.
- **Test fixtures.** Fake Slack tokens keep the short digit groups that `fakeBotToken(...)` makes. No literal invisible characters (`source-hygiene.test.ts`).
- **channel-web** uses shadcn primitives and semantic tokens only. This card only removes UI. Invoke the `shadcn` skill before editing it. channel-web's `tsc` covers its test files, so run its build, not just vitest.
- **Running tests.** Use `pnpm --filter <pkg> test`: the filter goes before the script. The Docker-backed suites need an explicit `DOCKER_HOST`: channel-slack's `channel-store`, `store`, `agents-deleted` and `plugin` tests, the preset-k8s composition test, and the preset-memory canary.
- **No hook is added, removed or reshaped,** so no boundary review is needed. One degradation string is pinned in three places, which change together (Task 4).
- **The task order is deliberate.** Task 1 makes preset-k8s independent of the shared path before anything removes it, so every package stays green after every task.
- **Line numbers are as of `8c4c474af`.** After a merge of `origin/main` (Step 0, Case A), find each spot by the test name, function or heading this plan gives.
- **Final gate:** `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts && pnpm lint`.

## Review focus

1. **A leftover shared binding.** Someone mentions the shared bot in a channel that still has a binding row on the shared install. An older replica could have written one after boot, or the boot delete hasn't run yet. Expect no binding read, no turn, and one private line. Test: Task 3, step 1, first test.
2. **A shared binding switched OFF at deploy, with no kept switch.** After boot the binding is gone and the kept switch is OFF, so the agent's bot later starts OFF there. Test: Task 2, migration test.
3. **Bindings that aren't the shared install's.** Boot with a bot's binding and with a binding whose install row is missing. Both stay: only rows whose install is `kind = 'shared'` go. Test: Task 2, migration test.
4. **`/ax` typed before the admin's Disconnect + Connect.** Slack posts to `/slack/commands/<id>`. Nothing serves that path any more, so the answer is 403 (the CSRF check refuses a request with no CSRF header before routing; as built, Task 4) and no handler runs. Test: Task 4, canary assertion.
5. **The `ready` status with and without `channels`.** channel-web parses a `ready` answer that has no `channels` (the new server). It also parses one that still has `channels` (a host one deploy behind), ignoring the key. Test: Task 6, step 1.

---

### Task 1 [tier: integration]: Port the k8s Slack composition test from shared-app channels to the agent's own bot

`security-checklist`: not required, because this task changes tests only.

**Why first:** this task changes tests only, and the bot path already exists, so the suite is green before and after. Once it's done, no later task can break preset-k8s.

**Files:**
- Modify: `presets/k8s/src/__tests__/channel-slack-composition.test.ts`

**Interfaces:**
- **Produces** these test-local helpers:
  - `supportBot(): Promise<{ installId: string; botId: string; teamId: string; agentId: string }>`. `installId` is the shared install; `botId` is the bot's.
  - `botMention(from: SlackPerson, ts: string, text: string, threadTs?: string): Record<string, unknown>`. The text starts with `<@${OWN_BOT_USER_ID}>` and the channel is `SUPPORT_CHANNEL`.

- [ ] **Step 1: Build `supportBot()` from the own-bot test's steps 1–2 (lines ~1974–2016).**
  - `connectWorkspace()`, then `teamWithAgent('usr_ada', 'usr_mel')`.
  - As Ada, `POST /settings/slack/:agentId/bot` with `{ botName: OWN_BOT_NAME, refreshToken: CONFIG_REFRESH_TOKEN }`.
  - `GET /slack/bots/oauth/callback` with the install URL's `state`.
  - Read the bot's install id from `channel_slack_v1_installs WHERE kind = 'bot'`.
  - Add `botMention`. Deliver it with `deliverToOwnBot(botId, …)`.
  - Delete `supportChannel()`.
- [ ] **Step 2: Port every test that used `supportChannel()`.** In each one:
  - conversation keys become `slack:${botId}:${SUPPORT_CHANNEL}:${ts}`, plus `:external` for outsiders;
  - Slack calls carry `Bearer ${OWN_BOT_TOKEN}`;
  - clicks go to the bot's interactions route, signed with `OWN_SIGNING_SECRET`;
  - outsiders run as the requester, `usr_ada`.

  Per test:
  - **`:1285`, tiers A–E.** Keep A–D. Tier E becomes "Ada is demoted to member, so an outsider gets one private line and no turn". Assert the call shape, not the text.
  - **`:1390`, the outsider's held call.** Port.
  - **`:1477`, `:1594`, `:1653`, `:1722`, the approval prompts.** Port. The prompt is posted with the bot's token, and the click arrives on the bot's interactions route.
  - **`:1807`, the memory switch.** The first mention binds #support-desk. Flip with `POST /settings/slack/:agentId/bot/remember`. The old shared disconnect step becomes `POST /settings/slack/:agentId/bot/disconnect { installId: botId }`, and the thread stays refused after it.
  - **`:1897`, Replace.** Drop the channel assertions and the shared-bot channel mention at `:1956`. The install, its secrets and its DMs stay.
  - **`:1974`, the own bot.** Start from `connectWorkspace()` and `teamWithAgent()`, with no shared channel. Replace step 5 with this: the shared bot, mentioned in #support-desk by Mel, makes exactly `users.info` then `chat.postEphemeral` (to Mel, in that channel), and no `chat.startStream`; `invokes` doesn't change. Don't assert the line's text, because Task 3 changes it.
  - **Cleanup.** Every ported test ends by deleting its agent with `dropAgent`, in a `finally` or `afterEach` as the existing tests do. Deleting the agent deletes its bot, so the next test's `supportBot()` never meets a bot name that's already taken.
- [ ] **Step 3: Delete what only the shared connect path used.**
  - Delete `:1120–1189`, the test for connecting from settings and from `/ax`.
  - Delete `slash()` (`:572–590`).
  - Delete the fake Slack's `conversations.join` answer (`:381`) and `conversations.list` answer (`:398–414`).
  - Reword the stale comments at `:31–35`, `:842–845` and `:1191`.
  - Keep `:868`'s lines `1080–1099`: a shared mention in a channel with no agent is answered by `users.info` plus `chat.postEphemeral`. It pins the shape Task 3 keeps. Reword its comment only.
- [ ] **Step 4: Verify.**
  - `pnpm --filter @ax/preset-k8s test` → PASS.
  - `grep -nE "slack/commands|slash\(|/settings/slack/[^/]+/(connect|disconnect|available|remember)" presets/k8s/src/__tests__/channel-slack-composition.test.ts` → no hits.
- [ ] **Step 5: Commit** `[TASK-1186] preset-k8s: Slack composition tests run channel turns through the agent's own bot`.

---

### Task 2 [tier: sensitive]: Boot deletes the shared install's bindings; a bot's first bind reads only the kept switch

`security-checklist`: **required**. Boot now deletes rows from a durable table, and the change touches the bind that the switch lock serializes.

**Files:**
- Modify: `packages/channel-slack/src/migrations.ts`: the end of `runMigrations`, and the header prose for `channel_slack_v1_channels`, for `channel_slack_v1_memory_switches` (around line 104: "from the agent's live shared binding, else from this, else on") and for "Additive-only and idempotent".
- Modify: `packages/channel-slack/src/channel-store.ts`: `ChannelStore.bindBot`, `bindBot` in `createChannelStore`, the header paragraphs on the kept switch and the lock, and the `upsert` "fresh connect on the shared app" exception.
- Modify: `packages/channel-slack/src/router.ts`: `bindBotChannel`, and `RouterDeps.installs` with its doc.
- Modify: `packages/channel-slack/src/__tests__/memory-channel-store.ts`: `bindBot`, and the header.
- Test: `packages/channel-slack/src/__tests__/channel-store.test.ts` and `packages/channel-slack/src/__tests__/router.test.ts`.

**Interfaces:**
- **Produces:**
  - `ChannelStore.bindBot(b: Pick<ChannelBinding, 'installId' | 'channelId' | 'agentId' | 'connectedByUserId' | 'channelName'>): Promise<boolean>`. Its one transaction runs `lockSwitch` (READ COMMITTED, the lock in a statement of its own, as today), then `keptRemember(agentId, channelId) ?? true`, then `upsert({ ...b, remember })`, and returns the switch.
  - `RouterDeps['installs']` is `Pick<InstallStore, 'get' | 'botForAgent'>`.

- [ ] **Step 1: Write the failing tests in `channel-store.test.ts`.**

  **a. The migration test.** In `describe('runMigrations')`, add "deletes the shared install's channel bindings at boot, after keeping an off one's switch; a bot's bindings, a binding with no install row and every thread stay; a second run changes nothing (TASK-1186)".
  - Insert two rows into `channel_slack_v1_installs` with raw SQL:
    - INSTALL, `kind 'shared'`: `status 'active'`, an `app_id`, a `client_id`, a `bot_name`, and `connected_by_user_id` ADA;
    - OTHER_INSTALL, `kind 'bot'`, with `agent_id` AGENT and `requested_by_user_id` BOB.
  - Create bindings with `connect()`:
    - (INSTALL, SUPPORT, AGENT, `remember: false`);
    - (INSTALL, SALES, AGENT);
    - (OTHER_INSTALL, GENERAL, AGENT, `connectedByUserId: BOB`);
    - (a 22-character id with no install row, GENERAL, OTHER_AGENT).
  - Record a thread (CONV) on (INSTALL, SUPPORT, AGENT).
  - Run `runMigrations(db)` twice. After each run, check:
    - `get(INSTALL, SUPPORT)` and `get(INSTALL, SALES)` are `null`;
    - the bot's binding and the binding with no install are unchanged;
    - `keptRemember(AGENT, SUPPORT)` is `false` and `keptRemember(AGENT, SALES)` is `true`;
    - `getThread(CONV)` is still there.

  **b. The `bindBot` cases.** Rewrite the `it.each` in `describe("a team agent's own bot's first bind (bindBot)")` for one argument. Seed kept switches with raw `INSERT INTO channel_slack_v1_memory_switches`. Each case asserts the stored binding and that the kept switch is unchanged.

  | Setup | `bindBot` returns |
  |---|---|
  | an OFF kept for the agent and channel | `false` |
  | an ON kept | `true` |
  | nothing kept | `true` |
  | another agent's OFF kept | `true` |
  | the agent's own binding of the channel on INSTALL is OFF, and nothing is kept (it is never read) | `true` |

  **c. The two lock tests.** Port both, using `underRepeatableRead`, with no `connect()` on INSTALL:
  - (i) The bind waits while the holder session commits `INSERT … ON CONFLICT (agent_id, channel_id) DO UPDATE SET remember = false` into the kept switches. The bind returns `false`, and the binding is OFF.
  - (ii) `setRemember(OTHER_INSTALL, SUPPORT, AGENT, false)` waits while the holder inserts that binding with `remember true`. It returns `true`, the binding is OFF, and the kept switch is OFF.
- [ ] **Step 2: Run the tests and watch them fail.** `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/channel-store.test.ts` → FAIL. The migration test still finds the shared rows; the one-argument cases read the shared binding.
- [ ] **Step 3: Implement.**
  - **`migrations.ts`.** Append this as the last statement, after both backfills:
    ```sql
    DELETE FROM channel_slack_v1_channels c USING channel_slack_v1_installs i
     WHERE c.install_id = i.install_id AND i.kind = 'shared'
    ```
    Its comment says four things:
    - It runs every boot, and nothing writes such a row again.
    - It runs after the backfills, so a shared binding's OFF survives as the kept switch.
    - Threads and kept switches stay: the capture veto refuses a thread whose binding is gone.
    - Only the shared install's rows go.

    Amend the header: the schema is additive, and one data step deletes.
  - **`channel-store.ts`.** Make `bindBot` match the Interfaces block. Rewrite the prose that names the shared binding or TASK-1179.
  - **`router.ts` `bindBotChannel`.** Drop `const shared = await d.installs.current()`, call `d.channels.bindBot(wrote)`, and rewrite its doc.
  - **The in-memory fake.** `bindBot(b)` reads `switches`, then defaults to `true`.
- [ ] **Step 4: Update the router tests** in `describe("a team agent's own Slack bot (TASK-1167)")`.
  - **Rewrite** "a channel the team set not to be remembered on the shared app stays not remembered when the bot binds it". It becomes "a switch the team kept off for the agent and channel stays off when the bot binds it", seeded with `w.channels.switches.set(\`${SUPPORT_AGENT.id}/${SUPPORT}\`, false)`.
  - **Keep** "…bound with the switch on…", without its `store.remove` line.
  - **Rewrite** "another agent's switch on the shared app…". It becomes "another agent's kept switch is that agent's: the bot's binding starts on".
  - **Delete:**
    - "with no shared app installed…";
    - both "(TASK-1180)" shared-disconnect cases, which the rewritten kept-switch test covers;
    - "a channel connected again since it was switched off starts on…", because that rule is retired;
    - the `["shared app's install", { sharedReadFails: true }]` row.
  - **Remove** the `sharedReadFails` world option and the fake installs' `current()`, unless something else uses them.
- [ ] **Step 5: Verify.**
  - `pnpm --filter @ax/channel-slack build && pnpm --filter @ax/channel-slack test` → PASS. That includes `plugin.test.ts`. A test there that fails only because it expected a live shared binding to beat the kept switch is retired behavior: delete it.
  - Mutation checks (commit first, restore with `git checkout HEAD -- <path>`):
    - move the DELETE above the backfills → test (a) fails on `keptRemember`;
    - drop `i.kind = 'shared'` → the bot's binding is deleted;
    - drop `lockSwitch` from `bindBot`, then from `setRemember` → tests c(i) and c(ii) fail.
- [ ] **Step 6: Commit** `[TASK-1186] channel-slack: boot deletes the shared install's channel bindings; a bot's first bind reads only the kept switch`.

---

### Task 3 [tier: sensitive]: A shared-bot mention in a channel runs no turn and answers one private line

`security-checklist`: **required**. This changes how untrusted Slack events are routed, and who a channel turn runs as.

**Files:**
- Modify: `packages/channel-slack/src/router.ts`
- Modify: `packages/channel-slack/src/copy.ts`
- Modify: `packages/channel-slack/src/turn-note.ts` (`SLACK_NOTE_OUTSIDER`)
- Modify (prose only): `packages/channel-slack/src/channel-route.ts` and `packages/channel-slack/src/turn.ts`. "The person who connected the channel" becomes "the bot's requester, copied into the binding at its first mention; a Claim moves it".
- Test: `router.test.ts`, `admission.test.ts`, `copy.test.ts`, `turn-note.test.ts`, `plugin.test.ts`.

**Interfaces:**
- **Produces:**
  - `COPY.sharedBotInChannel`, exactly: `"I don't answer in channels. To talk to your own agent, send me a direct message. To bring a team agent into this channel, invite its own bot with /invite."`
  - The log line `slack_event_ignored { installId, reason: 'shared-channel' }`.
  - `RouterDeps['installs']` becomes `Pick<InstallStore, 'get'>`.
- **Removes:** `COPY.channelNotConnected`, `COPY.channelUnavailable` and `COPY.answersAsOwnBot`.
- **Changes:** in `SLACK_NOTE_OUTSIDER`, "…your owner, the person who connected this channel, who answers…" becomes "…your owner, the team admin who set you up in Slack, who answers…".

- [ ] **Step 1: Write the failing tests** in a new `describe("a mention of the shared bot in a channel (TASK-1186)")` in `router.test.ts`.
  - **"a member's mention runs no turn, even with a leftover binding row: one private line, and no binding, agent or channel is asked about".**
    - Setup: `w.putInstall(OWN_BOT)`, and a binding row on (INSTALL_ID, SUPPORT) set through `w.channels.rows`.
    - Dispatch `w.dispatch(INSTALL, mention())`.
    - Expect:
      - `w.invokes` and `w.conversations` are both `[]`;
      - the Slack calls are exactly `usersInfo(ALICE)`, then `postEphemeral({ channel: SUPPORT, user: ALICE, text: COPY.sharedBotInChannel })`;
      - `w.channels.calls` contains none of `get`, `bindBot` or `recordThread`;
      - there is no `conversationsInfo` call, and `w.agents.inputs('agents:resolve')` is `[]`;
      - the non-debug lines are exactly `[{ level: 'info', msg: 'slack_event_ignored', fields: { installId: INSTALL_ID, reason: 'shared-channel' } }]`.
  - **"in a thread, the line goes to that thread"**: the `postEphemeral` call carries `threadTs`.
  - **`it.each` over GUEST and STRANGER: "a refused sender gets silence"**: no `postEphemeral`.
  - **"a users.info that failed for a moment stays silent"**: replaces `:1689`.
  - **"a channel with no binding gets none"**: afterwards `w.channels.row(INSTALL_ID, GENERAL)` is `undefined`, and there is no `bindBot` call.
- [ ] **Step 2: Run the tests and watch them fail.** `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/router.test.ts` → FAIL: today the router reads the binding and runs a turn.
- [ ] **Step 3: Implement.**
  - **`router.ts`:**
    - Add the shared branch. A mention whose `install.kind === 'shared'` logs the line above, then calls `answerAdmitted(d, botToken, teamId, m, COPY.sharedBotInChannel, log)` and returns, before any binding read.
    - Delete `reachShared`.
    - Delete the job's shared own-bot re-check (`reason: 'own-bot'`).
    - The connector check is always `teamAdminAccess`, and the unavailable line is always `COPY.botUnavailable`.
    - Narrow `RouterDeps.installs`.
    - Rewrite the header: mentions are a bot's; the shared app gets DMs, and one line for a channel mention.
    - In Case A, delete 1184's shared branches too.
  - **`copy.ts`:** add `sharedBotInChannel`, delete the three removed keys, and fix the header sentence that lists them.
  - **`turn-note.ts`:** make the sentence change from the Interfaces block.
- [ ] **Step 4: Port and prune the router tests.**
  - **Set up the world for the bot path.**
    - Remove `world()`'s default shared binding of #support.
    - Hoist `ownBinding()` and `botKey()` to module level.
    - A test that needs a binding before the first mention seeds `w.channels.rows.set(\`${OWN_BOT_ID}/${SUPPORT}\`, ownBinding({ … }))`.
  - **Move the shared-channel describes to `OWN_BOT`.** These are "a mention in a connected channel", "the memory switch, recorded before each channel turn", and the member and outsider prompt tests (`:1267`, `:1292`). For each:
    - call `w.putInstall(OWN_BOT)` and use `botMention`;
    - use `OWN_BOT_ID` in keys and lanes, and `OWN_BOT_TOKEN`;
    - "reconnected by another team admin" becomes a Claim: set the bot binding's `connectedByUserId` to `'usr_ben'` in `w.channels.rows`;
    - `COPY.channelUnavailable` becomes `COPY.botUnavailable`.
  - **Delete** duplicates and retired cases:
    - tier A, which the bot block's first test already covers;
    - tier E connector-no-access, which the requester `it.each` covers;
    - "logs never name…", which the bot logs test covers;
    - "the shared bot can't tell whether…";
    - "the shared bot answers as today while…pending…";
    - "a shared turn still waiting when the agent's own bot goes live…";
    - the `it.each` "the shared bot in a channel whose agent's bot is live…";
    - the `'own-bot'` row of the binding-failure `it.each`, and the `botReadFails` option;
    - "a mention where nothing is connected…", which step 1 replaces;
    - the bot block's assertion that "the shared app's binding of the same channel is its own".
  - **Other test files:**
    - `admission.test.ts` uses `COPY.sharedBotInChannel` as its sample line.
    - `copy.test.ts`: the new line passes the rules, and the removed keys are dropped.
    - `turn-note.test.ts` pins the new sentence.
  - **`plugin.test.ts`.** Three tests post `mentionBody(…)` to `/slack/events/${INSTALL_ID}` and expect a turn: lines `1484`–`1485`, `2701` and `2755`, and `3079`–`3113`.
    - "turns waiting in both lanes at shutdown…" (`:1457`) runs on the bot. Seed the bot's install, its secrets and its binding the way `seedSupportBot` does, and post `botMentionBody(…)` to `/slack/events/${BOT_INSTALL_ID}`, signed with `BOT_SIGNING_SECRET`.
    - "the memory switch through the wiring" (`:3056`) runs on `BOT_INSTALL_ID`: bind there, flip with `setRemember(BOT_INSTALL_ID, …)`, and mention the bot.
    - In the TASK-1172 test "after a team admin disconnects the agent's own bot, a mention of the shared bot … runs a turn again" (`:2686`), both shared mentions get exactly `users.info` and `chat.postEphemeral`, and no turn. Drop "runs a turn again".
- [ ] **Step 5: Verify.**
  - `pnpm --filter @ax/channel-slack build && pnpm --filter @ax/channel-slack test && pnpm --filter @ax/preset-k8s test` → PASS.
  - Mutation check: delete the shared early return, and step 1's first test must fail.
- [ ] **Step 6: Commit** `[TASK-1186] channel-slack: a mention of the shared bot in a channel runs no turn; it answers one private line`.

---

### Task 4 [tier: sensitive]: Remove `/ax`, the settings connect routes, the connect core, and the scopes they needed

`security-checklist`: **required**. A capability is removed: a public, Slack-signed ingress route, three scopes from the shared app, and a slash command. Agent settings also stop holding the Slack client and the vault.

**Files:**
- **Delete:** `packages/channel-slack/src/commands.ts` and `src/__tests__/commands.test.ts`.
- **Modify** (`packages/channel-slack/src/`): `channels.ts`, `agent-routes.ts`, `channel-store.ts`, `__tests__/memory-channel-store.ts`, `slack-api.ts`, `limits.ts`, `ingress.ts`, `copy.ts`, `manifest.ts`, `plugin.ts`.
- **Modify, prose only:**
  - `format.ts:229`;
  - `admin-routes.ts:559`, where "`/ax`, the scopes" becomes "the scopes";
  - `bots.ts:91-92`, where "the shared bot … answers in the agent's channels again" goes;
  - `agents-deleted.ts:30`, where "until someone runs `/ax disconnect`" goes;
  - in Case A, `channel-check.ts`.
- **Modify, outside the package:**
  - `presets/k8s/src/index.ts:1519-1524`, the comment: two routes skip CSRF, with no commands route;
  - `presets/k8s/src/__tests__/preset.test.ts`: the pin at `:1320-1324` and the comment at `:1307-1309`;
  - `presets/memory/src/__tests__/canary.test.ts`: the title at `:746` and the block at `:854-863`.
- **Test:**
  - `channels.test.ts`, `agent-routes.test.ts`, `channel-store.test.ts`, `agents-deleted.test.ts`, `slack-api.test.ts`, `manifest.test.ts`, `admin-routes.test.ts`, `copy.test.ts`, `plugin.test.ts`;
  - `answers.test.ts`, in Case B;
  - the SlackApi fakes in `prompt-post.test.ts`, `bot-request-dms.test.ts`, `answers.test.ts`, `bot-request-click.test.ts` and `turn.test.ts`.

**Interfaces (Produces):**
- **`manifest.ts`:**
  - `BOT_SCOPES` is `['app_mentions:read', 'chat:write', 'im:history', 'reactions:write', 'users:read', 'users:read.email']`, and `BOT_EVENTS` doesn't change.
  - `SlackUrls` is `{ eventsUrl, redirectUrl, interactionsUrl }`.
  - `buildAppManifest`'s `features` has no `slash_commands`, and `SLASH_COMMAND` is gone.
- **`agent-routes.ts`:**
  - `export interface AgentRoutesDeps { bus: HookBus; installs: Pick<InstallStore, 'current' | 'botForAgent'>; channels: Pick<ChannelStore, 'listForAgent' | 'setRemember'>; logger: Logger }`
  - `createAgentSlackRoutes(d: AgentRoutesDeps, bots, requests, changes)`.
  - The `ready` variant of `AgentSlackStatus` is `{ state: 'ready'; botName; workspaceName; canManage; bot; botChannels? }`, with no `channels`. Task 6 mirrors it.
- **`channels.ts`** keeps exactly `AgentAccess`, `Rights`, `agentAccess`, `teamAdminAccess`, `checkRights`, `liveOwnBot` and `connectable`. `ChannelDeps` goes.
- **`ChannelStore`** loses `listAll` in both cases, and `remove` in Case B only.
- **`SlackApi`** loses `conversationsList` and `conversationsJoin`, and `'conversations.list'` and `'conversations.join'` leave `SlackMethod`. `TOKEN_REFUSED_CODES` and `isTokenRefused` go.
- **`plugin.ts`:** the `teams:list-for-user` degradation becomes `"Admin › Slack's list of bot requests names no team"`. The hook stays in `optionalCalls`, because `bot-requests.ts` calls it.

- [ ] **Step 1: Write the failing tests.**
  - **`manifest.test.ts`:**
    - "asks for exactly six bot scopes and two events".
    - The banned-scope test adds `'channels:read'`, `'channels:join'` and `'commands'`.
    - "declares no slash command": `features` has no `slash_commands` key.
    - `slackUrls` has no `commandsUrl`.
  - **`canary.test.ts`.** Replace the block that says the `/ax` route is mounted with "the `/ax` route is gone: an unserved POST answers 405". Expect `command.status` to be 405. Retitle `:746` "only the events and interactions routes skip CSRF".
  - **`plugin.test.ts`:**
    - The route list loses `/slack/commands/:installId`, plus `/available`, `/connect`, `/disconnect` and `/remember` under `/settings/slack/:agentId`. That leaves twenty-nine routes. Retitle the test to say only the events and interactions routes bypass CSRF.
    - The manifest pin uses the new degradation string.
  - **`agent-routes.test.ts`:** "the ready section carries the bot and its channels, and no shared channel list". The body has no `channels` key.
- [ ] **Step 2: Run the tests and watch them fail.** `pnpm --filter @ax/channel-slack test` and `pnpm --filter @ax/preset-memory test` → FAIL.
- [ ] **Step 3: Remove the source.**
  - **`commands.ts`:** delete the handler and its route.
  - **`channels.ts`:**
    - Remove the connect core: `connectChannel`, `listAvailableChannels`, the refusal maps, `workspace`, `noWorkspace`, `compare` and `quietly`, plus the types that only they use.
    - Rewrite the header as "who may manage a team agent's Slack bot and its channels, and which channel a bot may bind".
  - **`agent-routes.ts`:**
    - Remove `available`, `connect`, `disconnect` and `remember`, plus `ownBotAnswers`, `connectorName`, `CONNECTOR_FALLBACK`, `once` and the loop that builds `ready.channels`.
    - Rewrite the route table in the header.
  - **`channel-store.ts`:** remove `listAll` (and `remove` in Case B), from the code and from its prose.
  - **`slack-api.ts`:** remove the two `conversations.*` methods from the interface, the implementation and the method union, plus the token-refused list.
  - **`limits.ts`:** remove `CHANNEL_LIST_PAGE_LIMIT`, `CHANNEL_LIST_MAX_PAGES` and the whole "/ax command" section. Keep `CHANNEL_NAME_MAX`.
  - **`ingress.ts`:** drop `'slack_command'` from the `logPrefix` union and from the header.
  - **`copy.ts`:** remove every `slash*` line, `CONNECT`, `DISCONNECT`, `ChannelNotAllowed` and the `SLASH_COMMAND` import. Keep `listed()`, which skill reach uses.
  - **`manifest.ts`:**
    - Apply the Interfaces block.
    - Header comment: the shared app has six scopes, two events, no slash command, and interactivity. "Deliberately NOT requested" adds `channels:read`, `channels:join` and `commands`, because the shared app no longer serves channels (design §4b.1, TASK-1186).
  - **`plugin.ts`:**
    - Remove the commands route, `channelDeps`, and the `ChannelDeps` and `COMMANDS_MAX_BODY_BYTES` imports.
    - Call `createAgentSlackRoutes({ bus, installs: store, channels: channelStore, logger }, …)`.
    - Header: the route table, "the TWO routes that bypass CSRF", and the channel paragraph (a team agent's own bot answers mentions in channels it was invited to).
    - Apply the degradation text.
  - **The prose edits** listed under Files, and the preset-k8s pin and comment.
- [ ] **Step 4: Fix the remaining tests.**
  - **`commands.test.ts`:** delete the file.
  - **`channels.test.ts`:** delete the `connectChannel` and `listAvailableChannels` describes, and reword the header.
  - **`agent-routes.test.ts`:**
    - Delete `describe('connect')`, `describe('available')` and `describe('disconnect and remember')`.
    - Delete the shared-list section tests, about lines 1016–1222, including the TASK-1168 sub-describe.
    - Delete the TASK-1180 tests "the shared switch is refused with 409 own-bot…" and "a pending bot changes nothing: the shared switch flips as before".
    - Drop the shared-binding assertions in "only a team admin … flips a bot channel's switch…" and "the bot's switch flips the bot's binding, the agent's shared binding…".
    - Update the route and rights lists.
    - Build the deps from `AgentRoutesDeps`.
  - **`channel-store.test.ts`:** delete the `listAll` test. In Case B, delete the `remove` tests too, and seed with raw `DELETE` SQL wherever the tests called `remove`.
  - **`agents-deleted.test.ts`:** use a raw `SELECT` instead of `listAll`, and in Case B a raw `DELETE` instead of `remove`. Reword the header at `:43`.
  - **`answers.test.ts`, in Case B:** delete rows from `w.channels.rows` instead of calling `store.remove`.
  - **`slack-api.test.ts`:** delete the `conversations.list` and `conversations.join` tests.
  - **The five SlackApi fakes:** remove `conversationsList` and `conversationsJoin`.
  - **`admin-routes.test.ts`, the rename test (`:2451`):** the manifest sent has no `slash_commands`, and its scopes are `[...BOT_SCOPES]`.
  - **`copy.test.ts`:** drop the slash tests.
  - **`plugin.test.ts`:**
    - Drop the `/slack/commands` probe (`:1061`).
    - `seedSupportBot` binds the bot install only.
    - Delete the two TASK-1180 shared-route tests (`:3220`, `:3270`), and the whole `describe("a memory switch flip and the agent's own bot's first bind take turns (TASK-1182)")`. A flip can't come before a bot's binding now, and Task 2's store tests pin the lock.
    - Drop the shared-binding assertions in `:3364`.
    - In Case B, `:3323` seeds with raw SQL instead of `remove`.
- [ ] **Step 5: Sweep for dead exports.** This must print nothing:
  ```bash
  grep -rnE "COMMANDS_ROUTE_PATH|createCommandsHandler|connectChannel|listAvailableChannels|ChannelDeps|conversationsJoin|conversationsList|TOKEN_REFUSED_CODES|isTokenRefused|SLASH_COMMAND|commandsUrl|CHANNEL_LIST_|SLASH_TEXT_MAX|SLASH_REPLY_DEADLINE_MS|AGENT_NAME_ARG_MAX|COMMANDS_MAX_BODY_BYTES|slack_command|listAll\(" packages presets --include='*.ts' --include='*.tsx' | grep -v node_modules
  ```
- [ ] **Step 6: Verify.** `pnpm --filter @ax/channel-slack build && pnpm --filter @ax/channel-slack test && pnpm --filter @ax/preset-k8s test && pnpm --filter @ax/preset-memory test && pnpm lint` → PASS.
- [ ] **Step 7: Commit** `[TASK-1186] channel-slack: remove /ax, the settings connect routes, the connect core, and the shared app's channels:read, channels:join and commands scopes`.

---

### Task 5 [tier: mechanical]: The "bot is live" DM stops listing shared-app channels

`security-checklist`: not required. This removes dead code inside the plugin and doesn't change any boundary.

**Files:**
- Modify: `packages/channel-slack/src/bot-request-dms.ts`. Delete `stillWaiting`, the `channels` dependency and the header lines about shared-app channels.
- Modify: `packages/channel-slack/src/copy.ts` (`botLiveForOwner`).
- Modify: `packages/channel-slack/src/limits.ts`. Delete `BOT_LIVE_DM_CHANNELS_MAX`.
- Modify: `packages/channel-slack/src/plugin.ts`. Stop passing `channels` to `createBotRequestDms`.
- Test: `bot-request-dms.test.ts`, `copy.test.ts`, and `plugin.test.ts`'s TASK-1170 "tells that team admin it is live" test (`:2998`).

**Interfaces:**
- **Produces:**
  - `COPY.botLiveForOwner(bot: { botName: string; handle: string | null }): string`. It returns the existing first sentence only, for example "@h is live. Invite it to a channel with /invite @h."
  - `BotRequestDmsDeps` has no `channels`.

- [ ] **Step 1: Write the failing test.** In `bot-request-dms.test.ts`, add "the requester's live DM says the bot is live and how to invite it, and names no channel". The posted text equals `COPY.botLiveForOwner({ botName, handle })`, and the deps carry no channel store.
- [ ] **Step 2: Run it and watch it fail.** `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/bot-request-dms.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
  - `announce` posts `COPY.botLiveForOwner({ botName: bot.botName, handle: bot.botHandle })`.
  - Delete `stillWaiting`, `BotRequestDmsDeps.channels`, `BOT_LIVE_DM_CHANNELS_MAX` and the channel arguments of `botLiveForOwner`.
  - `plugin.ts` stops passing `channels: channelStore` to `createBotRequestDms`.
  - Then delete the channel-list tests in `bot-request-dms.test.ts` and `copy.test.ts`, and update `plugin.test.ts` `:2998` if it asserts a channel list.
- [ ] **Step 4: Verify.** `pnpm --filter @ax/channel-slack build && pnpm --filter @ax/channel-slack test` → PASS. `grep -rn "BOT_LIVE_DM_CHANNELS_MAX\|stillWaiting" packages` → nothing.
- [ ] **Step 5: Commit** `[TASK-1186] channel-slack: the bot-is-live DM no longer lists shared-app channels`.

---

### Task 6 [tier: integration]: channel-web drops the shared channel UI and the copy that promises channel connections

`security-checklist`: not required. This task only removes UI and copy. Invoke `shadcn` before editing; no component is added.

**Files** (under `packages/channel-web/src/`):
- **`lib/agent-slack.ts`.** Remove:
  - `SlackChannelRow`, and `channels` from `ready`;
  - `AvailableSlackChannel(s)` and `parseRow`;
  - `fetchAvailableChannels`, `connectSlackChannel`, `disconnectSlackChannel` and `setSlackChannelRemember`;
  - the refusal keys in `AGENT_SLACK_COPY` (`notPublic` … `slackError`), plus `movedNotice`, `movedRow` and `movedDisconnect`;
  - `agentSlackErrorCopy` and `agentSlackStateChanged`.

  The `ready` parse must stop requiring `channels`: today's `!Array.isArray(channels)` check would turn every `ready` answer into a bad response. Keep `generic`, `rememberFailed`, `botChannelsNotice`, `InviteTarget` (its doc loses "moved-channel lines") and `agentSlackWriteStale`.
- **`components/workspace/AgentSlack.tsx`.** Remove:
  - `Busy`, and the `onChange` prop;
  - the row state, `refuse`, `mark`, the shared `remember` and `reconnect` handlers, the notice alert, the channels list, the picker and the disconnect dialog;
  - `ChannelRow`, `ChannelPicker` and `DisconnectDialog`, and the imports that go dead with them.

  Rewrite the header. `ready` renders `AgentSlackBotChannels`, when the bot is live and has channels, and then `AgentSlackBot`.
- **`components/workspace/AgentSlackBot.tsx`.** Remove the dialog sentence "The shared bot answers for {agentName} again in any channel it was connected to before." Remove `agentName` from `DisconnectBotDialog` and `Live` if it becomes unused. **Keep** `sharedConnected`, which still gates Rebuild, and reword its doc: a bot request needs Slack connected.
- **`components/admin/SlackBotsCard.tsx`.** Remove the `sharedConnected` prop and its sentence. `components/admin/SlackTab.tsx:1017` stops passing it.
- **`components/admin/SlackTab.tsx` copy:**
  - Disconnect (`:426`) becomes "The bot leaves Slack, and people can't message their own agents there anymore. Team agents' own bots stay in their channels. Conversations stay here."
  - Rename (`:560`) becomes "Only the name changes. Conversations keep working."
  - Replace (`:698-699`) becomes "Do this when the token we have stops working, or when whoever generated it is leaving. Conversations keep working."
- **`lib/slack-admin.ts:317` (`slack-app-gone`):** drop "Channels will need connecting again after that."
- **Header prose only:** `components/workspace/SlackRememberField.tsx` and `AgentSlackBotChannels.tsx`, where "a shared channel" and "Connected by" go.
- **Tests:**
  - `lib/__tests__/agent-slack.test.ts`;
  - `components/workspace/__tests__/AgentSlack.test.tsx`;
  - `components/workspace/__tests__/AgentSlackBot.test.tsx`;
  - `components/admin/__tests__/SlackTab.test.tsx`;
  - `components/admin/__tests__/SlackBotsCard.test.tsx`;
  - `__tests__/admin-slack.test.tsx`.

**Interfaces:**
- **Consumes** Task 4's `ready` shape. The type here must match it field for field: `{ state: 'ready'; botName: string; workspaceName: string; canManage: boolean; bot: AgentSlackBot; botChannels?: BotChannelRow[] }`.

- [ ] **Step 1: Write the failing tests.**
  - **`agent-slack.test.ts`:** "a ready answer without channels parses; a stray channels key is ignored". Both bodies give the same `AgentSlackRead`, and neither carries `channels`.
  - **`AgentSlack.test.tsx`:** "the ready section shows the bot's channels and the bot card, and no picker or shared list". None of these texts appear: "Connect a channel", "Connected channels", "still need", or "/ax".
  - **`SlackTab.test.tsx`:** the three new strings.
  - **`SlackBotsCard.test.tsx`** and **`AgentSlackBot.test.tsx`:** the Disconnect dialog doesn't contain "The shared bot answers".
- [ ] **Step 2: Run them and watch them fail.** `pnpm --filter @ax/channel-web test` → FAIL.
- [ ] **Step 3: Remove and reword** everything listed under Files.
- [ ] **Step 4: Fix the existing tests.**
  - **`AgentSlack.test.tsx`:**
    - Delete the single tests at `188`, `199`, `209`, `222`, `232`, `251`, `445` and `956`.
    - Delete the describe blocks "the list", "connecting", "remember", "a write on a stale picture…", "disconnecting" and "needs reconnecting".
    - Delete the mocks and fixtures of the four removed functions, plus `SUPPORT`, `MOVED`, `OPS`, `AVAILABLE` and `openPicker`.
    - Change `ready()` so it builds no `channels`.
    - Edit the fixtures of the tests that keep only bot behavior: `240`, `260`, `307`, `325`, `346`, `363`, `373`, `397`, `416`, `433`, `501`, `510`, `521`, `530`, `854`, `872`, `887`, `898`, `913`, `938`, `945` and `951`.
  - **`agent-slack.test.ts`:**
    - Delete `124`, the `fetchAvailableChannels` describe, `313`, `326`, `332`, `638`, `656`, `664` and `685`.
    - Move `357` (a non-code `error` becomes `unknown`) onto a bot route rather than losing it.
    - Edit the `channels:` fixtures at `97`, `135`, `165`, `174`, `184`, `204`, `224` and `253`.
  - **`AgentSlackBot.test.tsx`:** edit `676` and `694`.
  - **`SlackTab.test.tsx`:** edit `582`, `675`, `837` and `1001`.
  - **`SlackBotsCard.test.tsx`:** delete `203` and `211`, and drop `sharedConnected` from `renderCard` and its renders.
  - **`admin-slack.test.tsx`:** edit the `slack-app-gone` row (`:401-405`).
- [ ] **Step 5: Verify.**
  - `pnpm --filter @ax/channel-web build && pnpm --filter @ax/channel-web test && pnpm lint` → PASS. The build runs tsc, which covers the test files.
  - `grep -rnE "connectSlackChannel|disconnectSlackChannel|setSlackChannelRemember|fetchAvailableChannels|SlackChannelRow|agentSlackErrorCopy|agentSlackStateChanged|movedNotice|movedRow|movedDisconnect" packages/channel-web/src` → nothing.
- [ ] **Step 6: Commit** `[TASK-1186] channel-web: remove the shared app's channel picker, its channel list and the moved-channels list`.

---

### Task 7 [tier: mechanical]: Docs, release notes and memory say the shared channel path is retired

`security-checklist`: not required. This task changes docs only.

**Files:**
- Modify: `docs/plans/2026-11-09-channel-slack-design.md`.
- Modify or delete: these files in `.changeset/`: `channel-slack.md`, `channel-slack-ui.md`, `slack-dedicated-bot.md`, `slack-bot-disconnect.md`, `slack-bot-remember-switch.md`, `slack-bot-moved-channels.md` and `slack-bot-remember.md`.
- Create: `.changeset/slack-channels-only-through-bot.md`.
- Create: `.claude/memory/patterns/2026-11-21-TASK-1186.md`.
- Append to: `.claude/memory/decisions/2026-11-21-TASK-1186.md`.

Steps:

- [ ] **Step 1: Update the design doc.** Keep the old text as history, and add retirement notes.
  - **§3 "Scopes" (`:341-378`).** "Nine bot scopes" becomes six. `channels:read`, `channels:join` and `commands` are marked "retired by §4b (TASK-1186)".
  - **§3 "Connecting a channel to a team agent" (`:380`).** Add a first line: "Retired by §4b.1 (TASK-1186): the shared app no longer connects channels; …".
  - **§4 "Channels it was already in" (`:477`) and "As built (TASK-1168)" (`:485`).** Mark both the same way.
  - **§4b.1.** Add an "As built (TASK-1186)" paragraph covering:
    - a shared-bot channel mention gets `COPY.sharedBotInChannel`, and only an admitted sender sees it;
    - `/ax` and its route are gone (a POST from Slack, which carries no CSRF header, is refused with 403 before routing);
    - the shared manifest has six scopes;
    - every boot deletes the shared install's bindings after the backfills;
    - a bot's first bind reads only the kept switch.

    The paragraph also lists the as-built bullets that are now retired:
    - TASK-1167 "steps aside" and "the shared app's binding of it while there is one (TASK-1179)";
    - TASK-1180's shared flip and the `409 own-bot`;
    - TASK-1172 "The shared bot answers again in the agent's old shared channels";
    - TASK-1170's channel list in the "is live" DM.

    Close with the deploy step: Disconnect + Connect sheds the scopes.
  - **§6 (`:1229`).** "Signed like the events and `/ax`" becomes "signed like the events".
- [ ] **Step 2: Update the changesets.** TASK-995 is the precedent for removing an unreleased feature's notes.
  - **Delete** `slack-bot-moved-channels.md` and `slack-bot-remember.md`. Both describe features that are now removed.
  - **`channel-slack.md`:** remove the `/ax` and settings-picker paragraph, the three-scope paragraph, and "An existing Slack connection has none of these…". Re-word "Once a channel is connected …" as "A team agent answers in a channel through its own bot (see that note) …". Keep the tier, mention-only, remember-switch and approval paragraphs, with "the person who connected the channel" changed to "the team admin who set up the agent's bot".
  - **`channel-slack-ui.md`:** remove the agent-settings channel paragraph's connect, list and reconnect sentences, and the Admin Disconnect sentence.
  - **`slack-dedicated-bot.md`:** remove ", and the shared bot steps aside for that agent".
  - **`slack-bot-disconnect.md`:** remove "The shared bot answers again in the channels where it used to."
  - **`slack-bot-remember-switch.md`:** remove the comparison to the shared bot's channels and the shared-connection carry-over sentence.
  - **Add `slack-channels-only-through-bot.md`** as a patch for `@ax/channel-slack` and `@ax/channel-web`. It says:
    - team agents reach channels only through their own bot;
    - the shared bot does DMs, and in a channel it replies with one private line;
    - `/ax` is gone;
    - the shared app asks for three fewer permissions;
    - an existing connection sheds them with Disconnect, then Connect, in Admin › Slack;
    - shared-app channel connections are deleted at the first boot.

    Follow the voice rules in CLAUDE.md.
- [ ] **Step 3: Write the memory rows.** `R1` forbids editing old rows, so this step supersedes them in new shards.
  - **`patterns/2026-11-21-TASK-1186.md`** says: "SUPERSEDES patterns/2026-11-20-TASK-1180.md:3 and :5. A team agent's own bot's first bind reads the switch kept for the agent and channel, then ON; nothing reads a shared binding (they no longer exist). There is no shared `/remember` and no `409 own-bot`. Keep the one-statement rule for any writer of `remember`."
  - **The decisions shard** gets one row naming the stale decision rows this card makes false:
    - `decisions/2026-11-20-TASK-1172.md:9`;
    - `decisions/2026-11-19-TASK-1167.md:20`;
    - `decisions/2026-11-20-TASK-1168.md:8–26`;
    - `decisions/2026-11-20-TASK-1180.md:10,13,15`;
    - `decisions/2026-11-20-TASK-1182.md:9`;
    - `decisions/2026-11-20-TASK-1170.md:18`;
    - `decisions/2026-11-13-TASK-1094.md:9,16,34,36,37,41`.
- [ ] **Step 4: Verify.**
  - `pnpm test:scripts` → PASS (the memory guard and the changeset checks).
  - `grep -nE "/ax connect|channels:join" .changeset/*.md` → the new changeset only.
  - `git diff --stat origin/main -- .claude/memory` → additions only, in TASK-1186 shards.
- [ ] **Step 5: Commit** `[TASK-1186] docs: the shared app's channel path is retired (design §3/§4 notes, release notes, memory)`.

---

## PR notes (the builder copies these into the PR body)

- **Security note** (from the `security-checklist` run): a capability is **removed**.
  - The shared app drops `channels:read`, `channels:join`, `commands` and the `/ax` slash command.
  - The public route `POST /slack/commands/:installId` is gone, along with `conversations.list` and `conversations.join` egress.
  - The agent-settings routes no longer hold the Slack client or the vault.
  - Untrusted input: a shared-bot channel mention now reaches only `users.info` and one ephemeral line. No text goes anywhere.
- **Deploy note** (prod and kind): after the deploy, go to Admin › Slack → **Disconnect**, then **Connect**. The shared app then sheds the three scopes and `/ax`. Until then, `/ax` in Slack fails, because the host answers 403 (CSRF refuses it before routing). The first boot deletes the shared install's channel bindings, and keeps any switch that was off as the agent's kept switch.
- **Boundary review:** not applicable, because no hook changed.
- **TASK-1184:** say which case applied (Step 0).
