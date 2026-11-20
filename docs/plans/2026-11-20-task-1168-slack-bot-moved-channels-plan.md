# TASK-1168: the channels a team agent's own bot still needs, and no shared-app connects once it is live — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a team agent's own Slack bot is live, its settings list the channels it was connected to through the shared app that still need `/invite @handle` (each drops off once the bot has answered there), and both ways of connecting through the shared app (`POST /settings/slack/:agentId/connect` and `/ax connect`) refuse that agent and name the bot to invite instead.

**Architecture:** One rule in `channels.ts connectChannel`, the core both connect paths already call: an agent whose own bot is live is refused (`own-bot`) before Slack is asked anything. The agent-settings status marks each shared-app channel row `needsInvite` while the bot is live and hasn't bound that channel yet, and leaves out the ones it has bound. channel-web parses the flag, re-reads on a `409 own-bot`, and draws those rows with the `/invite` hint.

**Tech Stack:** TypeScript, vitest, React + shadcn (channel-web). No migration, no hook, no new dependency.

**Spec:** `docs/plans/2026-11-09-channel-slack-design.md` §4 "Channels it was already in" (`:445-451`, decided 2026-11-18) and §3 "Connecting a channel to a team agent" (`:363-391`); card TASK-1168; TASK-1167 review finding #8 (`.claude/memory/decisions/2026-11-19-TASK-1167.md` row 47). Decisions for this plan: `.claude/memory/decisions/2026-11-20-TASK-1168.md`.

## What the code says (the card's claims, checked)

The planner read `main` at `3cf5673d0`. Line numbers are from that read.

1. **"Live" means `status === 'active'`.** A bot row's status is `'pending' | 'active'`, and anything but `active` reads as pending (`store.ts:23`, `:266`). `bots.ts status()` shows `live` for an active row (`:580-594`), and the router's step-aside checks `own?.status === 'active'` (`router.ts:581`, `:748`). `needsClaim` is shown beside `live`; it isn't a status.
2. **The handle is `InstallRow.botHandle`** (`store.ts:48-52`). It's read once at Allow through `users.info` (`bots.ts:475-497`) and kept only if it matches `HANDLE_RE` and isn't a reserved word (`bots.ts:239`, `:488`). **It can be null**, so every line needs a wording that names the bot instead (`bots.ts:95-99`). The status already sends it as `bot.handle`.
3. **A binding records its install** in `ChannelBinding.installId` (`channel-store.ts:30-41`). Shared-app bindings carry `current().installId`; a bot's bindings carry the bot's own install id. `listForAgent(installId, agentId)` lists one install's bindings (`:184-194`).
4. **A bot binding is written at the bot's first mention in a channel, never at `/invite`.** `router.ts reachOwnBot`/`bindBotChannel` (`:768-899`) write it after the sender is admitted, the text isn't empty, and `conversations.info` shows a channel `connectable` accepts. A dedicated bot subscribes to `app_mention` only (`manifest.ts:66`), so AX never hears about the invite itself. A channel the bot was invited to but never mentioned in stays on the list. The notice says so.
5. **The web parser isn't zod.** But it strips just like one: `parseRow` (`agent-slack.ts:121-134`) builds a new object from the five fields it knows. So a new field must be read there, or the UI never sees it.
6. **REFUTED: "Rows for the bot's own channels are listed as today."** Today the status lists only the shared install's bindings (`agent-routes.ts:251`). A bot's channels aren't listed at all. Listing them, with their memory switch, is TASK-1167's follow-up 5. This card keeps them unlisted.
7. **True: the server lets either way connect an agent whose bot is live.** `connectChannel` (`channels.ts:286-381`) has no such check, and the UI only hides the picker (`AgentSlack.tsx:312-313`).
8. **No memory row pins a touched file by blob sha.** The only blob-pinned files are `packages/memory/src/{capture,observer,plugin}.ts` and two scripts. So TASK-1167's two-guard deadlock (its decisions row 46) can't recur here.

**What made the card look true (rule 5).** Two header lines say the section lists "the channels it answers in": `agent-routes.ts:23` and `AgentSlack.tsx:2-3`. Since TASK-1167 that's stale, because a live bot answers in channels the section never lists. TASK-1167's live line (`AgentSlack.tsx:285-289`) tells you to invite the bot to every listed channel, including the ones it already answers in. The design's connect rules (`:371-391`) don't have the own-bot rule. Tasks 2, 3, 5 and 6 fix each of these lines.

## Approaches

**How a row says "moved".**
- **A. `needsInvite: boolean` on every row (chosen).** It's true only when the same answer's `bot` is live and the bot hasn't bound that channel. It sits beside `needsReconnect`. The handle stays in one place (`bot.handle`, already on the wire), and the parser can default a missing field to `false` for an older host.
- **B. `movedTo: <handle>` (the card's spelling).** The handle can be null. A row whose bot has no handle would then say `movedTo: null`, and a reader can't tell that apart from "not moved". It also repeats the handle on every row.
- **C. `movedTo: { botName, handle }` per row.** Self-describing, but it's a second copy of the live bot's identity in one answer.

**Where the rule lives, and whether it locks.**
- **Chosen: inside `connectChannel`, with a plain store read** (`installs.botForAgent`). Both callers already go through it (`agent-routes.ts:286`, `commands.ts:475`), so neither caller can skip it, and neither can a later one.
- **Rejected: taking the app lock.** The lock serializes Slack-app writes and the bot's Allow. Holding it across `conversations.info` and `conversations.join` (each up to `SLACK_API_TIMEOUT_MS`) would stall every Admin › Slack step behind a channel connect.
- **What the lockless race can do.** A connect racing an Allow can leave one shared binding for an agent whose bot just went live. That's the same state as a channel connected a minute earlier. The router already ignores it for that agent and fails closed if it can't tell (`router.ts:573-585`, `:740-752`), and this card's status lists it as `needsInvite`.

## Design

- **Status** (`GET /settings/slack/:agentId`, `ready` only):
  - When `bots.status` answered `live`, the route reads the agent's live bot again (`liveOwnBot`) and lists that bot install's channel ids.
  - Each shared row whose channel is in that set is **left out**: the bot answers there now. Its shared binding stays, and nothing is deleted.
  - Every other shared row gets `needsInvite: true` and `needsReconnect: false`. No agents lookup is made for its connector, because no outsider runs as them while the bot is live.
  - Without a live bot, every row gets `needsInvite: false`, as today.
  - The connect answer's row carries `needsInvite: false`, so a row has one shape everywhere.
- **Connect refusal:**
  - `connectChannel` checks the bot after the workspace check (so `no-workspace` still comes first) and before `conversations.info`.
  - Its answer is `{ ok: false, reason: 'own-bot', ownBot: { botName, handle } }`. It logs `slack_channel_refused { installId, reason: 'own-bot', stage: 'own-bot' }`.
  - A store fault propagates, which fails closed: the route's 500, or `/ax`'s `slashFailed`.
  - The settings route answers `409 { error: 'own-bot' }`.
  - `/ax connect` answers `COPY.slashOwnBot(agentName, ownBot)`. Rights come first, so someone who can't manage the agent learns nothing about the bot.
  - Disconnect is untouched, on both sides.
- **channel-web:**
  - `parseRow` reads `needsInvite`, defaulting to `false`.
  - A `409 own-bot` means the page is stale, because the picker and Reconnect only show while the page thinks no bot is live, so the SPA reads the status again.
  - With a live bot:
    - The old live line is replaced by the moved notice over the rows it introduces.
    - Each moved row shows its hint, plus Disconnect for a manager. It has no memory switch (a shared binding's switch does nothing while the bot is live), no "Connected by", and no Reconnect (that would be refused).
    - Disconnect's dialog gets its own line.
    - The "no channels yet" line never shows, because the bot may be answering in channels this list doesn't show.
- **Pinned copy:**

| Where | Text |
|---|---|
| `/ax connect`, handle known | `*{agent}* has its own Slack bot now, so I can't connect it here. Invite it to this channel with /invite @{handle} instead.` |
| `/ax connect`, no handle | `*{agent}* has its own Slack bot now, so I can't connect it here. Invite {botName} to this channel with /invite instead.` |
| Notice above the moved rows, handle known | `These channels still need @{handle}: run /invite @{handle} in each one. A channel leaves this list once @{handle} answers there.` |
| Notice, no handle | `These channels still need {botName}: invite it to each one with /invite. A channel leaves this list once {botName} answers there.` |
| Each moved row, handle known | `Run /invite @{handle} here.` |
| Each moved row, no handle | `Invite {botName} here with /invite.` |
| Disconnect dialog, moved row | `We'll take #{name} off this list. The agent answers there only after its own bot is invited.` |

The notice's first sentence is the card's, word for word. The second sentence is added, because AX learns about the bot only from a mention (item 4 above).

## Global Constraints

- **Slack words:**
  - Every Slack-facing word lives in `copy.ts` `COPY`.
  - Outside text goes through `shown()`, and a handle after the line's own `@` goes through `shown(handle, '@')`.
  - No line holds `<`, `>`, `<!`, `<@`, `<#` or a bare `@here`, `@channel` or `@everyone`. `copy.test.ts` `everyLine` enforces it, and a new function needs an `ARGS` entry.
- **Web words:** they live in `lib/agent-slack.ts` `AGENT_SLACK_COPY`. The SPA mirrors channel-slack's wire by shape and never imports it (invariant 2).
- **Logs are code-only.** The new line is exactly `slack_channel_refused { installId, reason: 'own-bot', stage: 'own-bot' }` at `info`. It never carries a channel id or name, a person, the bot's name or its handle.
- **No app lock** anywhere in this card. The lock isn't re-entrant (`mutex.ts`), and nothing here needs it.
- **Don't edit** `router.ts`, `bots.ts`, `AgentSlackBot.tsx`, `store.ts`, `channel-store.ts` or `migrations.ts`. This card doesn't need them, and sibling builders (TASK-1169, TASK-1172) are in `bots.ts` and `AgentSlackBot.tsx`.
- **UI** uses only shadcn primitives and semantic tokens already in `AgentSlack.tsx`, with no new component and no raw colours (invariant 6). Invoke the `shadcn` skill before Task 5.
- **Test commands:**
  - Run one file with `pnpm --filter @ax/channel-slack exec vitest run <file>` or `pnpm --filter @ax/channel-web exec vitest run <file>`; `--filter` goes before the script.
  - `pnpm build` type-checks src, and channel-web's tsc also type-checks its tests. Run it after every channel-web task.
- **Commits:** subjects start `[TASK-1168]` and end with the session's attribution lines.

## Review Focus

1. **The bot was invited to a moved channel but nobody has mentioned it yet.** The row stays, and the notice says a channel leaves the list once the bot answers there. Task 3 test 1 shows the row stays until a bot binding exists. Tasks 4 and 5 pin the sentence.
2. **A live bot with no handle** (Slack's `users.info` failed at Allow). Every new line names the bot instead. Covered by Task 1's copy test, Task 2 tests 3 and 8, and Task 5's no-handle test.
3. **A stale settings page whose bot went live in another tab.** Picking a channel, or clicking Reconnect, gets `409 own-bot` and quietly re-reads the page, with no error line. Covered by Task 4's stale test and Task 5 test 8.
4. **The store can't say whether the bot is live.** The connect fails closed (500, or `slashFailed`), and so does the status (500), and Slack is asked nothing. Covered by Task 2 tests 4 and 11 and Task 3 test 4.
5. **A pending bot, or one that was cancelled.** Nothing changes: connects work, and no row is marked. Covered by Task 2 tests 2, 9 and 13, and Task 3 test 2.

## Invariants, boundary review, security

- No hook, IPC action or manifest `calls` change. `botForAgent` is channel-slack's own store, so no boundary review is needed.
- Invariants:
  - **1:** no hook payloads change.
  - **2:** the SPA mirrors by shape.
  - **3:** one PR, wired end to end.
  - **4:** the handle stays only on `bot`; rows carry a flag.
  - **5:** the rule only narrows what a team admin can do, and the status reads one more row and one more list from channel-slack's own tables.
  - **6:** shadcn only.
- **`security-checklist`: required for Task 2.** It walks:
  - the rule on the public `/ax` route and on the settings route;
  - the lockless race;
  - the fail-closed read;
  - the order: rights first, so non-managers learn nothing;
  - Slack's handle text in an mrkdwn reply. This covers Task 1's line.

  The other tasks touch no boundary: React renders the handle as text, and it was checked when it was stored.

## File map

| File | Change | Task |
|---|---|---|
| `packages/channel-slack/src/copy.ts` | `slashOwnBot` | 1 |
| `packages/channel-slack/src/__tests__/copy.test.ts` | key list, `ARGS`, one test | 1 |
| `packages/channel-slack/src/channels.ts` | `ChannelDeps.installs` widened, `OwnBot`, `liveOwnBot`, the `own-bot` outcome and check, header | 2 |
| `packages/channel-slack/src/commands.ts` | `connectRefusal` own-bot case, header step 4 | 2 |
| `packages/channel-slack/src/agent-routes.ts` | connect `case 'own-bot'` (2); status rows, row type, header (3) | 2, 3 |
| `packages/channel-slack/src/__tests__/{channels,commands,agent-routes}.test.ts` | `botForAgent` stubs and tests | 2, 3 |
| `packages/channel-web/src/lib/agent-slack.ts` (+ test) | `needsInvite`, `InviteTarget`, copy, `own-bot` stale | 4 |
| `packages/channel-web/src/components/workspace/AgentSlack.tsx` (+ test) | moved notice and rows, empty state, dialog line, header | 5 |
| `docs/plans/2026-11-09-channel-slack-design.md`, `.changeset/slack-bot-moved-channels.md` | as built | 6 |

---

### Task 1: The `/ax connect` line for an agent with its own bot `[tier: mechanical]`

**Files:**
- Modify: `packages/channel-slack/src/copy.ts` (add `slashOwnBot` in the `/ax replies` group, after `slashChannelTaken` `:263-265`)
- Test: `packages/channel-slack/src/__tests__/copy.test.ts`

**Interfaces:**
- Produces: `COPY.slashOwnBot(agent: string, bot: { botName: string; handle: string | null }): string` (Task 2 calls it).

- [ ] **Step 1: Write the failing test.**
  - Add `'slashOwnBot'` to the sorted key list in `'has exactly the lines the plan names'` (`:75-136`).
  - Add an `ARGS` entry: `[['Support', { botName: 'Support Bot', handle: 'supportbot' }], ['Support', { botName: 'Support Bot', handle: null }], [HOSTILE, { botName: HOSTILE, handle: HOSTILE }], [HOSTILE, { botName: HOSTILE, handle: null }], ['Ops', { botName: 'Ops', handle: 'here' }], ['Ops', { botName: 'Ops', handle: 'channel' }], ['Ops', { botName: 'Ops', handle: 'everyone' }]]`.
  - In `describe('COPY: the /ax replies (mrkdwn)')`, add:

```ts
it("an agent whose own bot is live: names the agent, then the bot's @handle to /invite, or its name without one (TASK-1168)", () => {
  expect(COPY.slashOwnBot('Support', { botName: 'Support Bot', handle: 'supportbot' })).toBe(
    "*Support* has its own Slack bot now, so I can't connect it here. Invite it to this channel with /invite @supportbot instead.",
  );
  expect(COPY.slashOwnBot('Support', { botName: 'Support Bot', handle: null })).toBe(
    "*Support* has its own Slack bot now, so I can't connect it here. Invite Support Bot to this channel with /invite instead.",
  );
  // After the line's own `@`, a broadcast word gets its mark.
  expect(COPY.slashOwnBot('Ops', { botName: 'Ops', handle: 'here' })).toContain(`/invite @${ZWSP}here instead.`);
  const hostile = COPY.slashOwnBot(HOSTILE, { botName: HOSTILE, handle: HOSTILE }).split(ZWSP).join('');
  expect(hostile).toContain('*&lt;!channel&gt; &amp; &lt;@U1&gt; @here* has its own Slack bot now');
});
```

- [ ] **Step 2: Run it and see it fail.** Run `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/copy.test.ts`. Expected: FAIL. The key list differs, `everyLine` has no `slashOwnBot` to call, and `COPY.slashOwnBot is not a function`.
- [ ] **Step 3: Implement it.** Add the line, with a block comment. The comment says it's `/ax connect` for an agent whose own bot is live (TASK-1168); that the invoker manages the agent, so the agent is named; and that the bot is named by its handle through `shown(handle, '@')`, or by its name when Slack never said a handle. Exact body:

```ts
  slashOwnBot: (agent: string, bot: { botName: string; handle: string | null }) =>
    bot.handle === null
      ? `*${shown(agent)}* has its own Slack bot now, so I can't connect it here. ` +
        `Invite ${shown(bot.botName)} to this channel with /invite instead.`
      : `*${shown(agent)}* has its own Slack bot now, so I can't connect it here. ` +
        `Invite it to this channel with /invite @${shown(bot.handle, '@')} instead.`,
```

- [ ] **Step 4: Run it and see it pass.** Same command. Expected: PASS, the whole file (the `everyLine`, broadcast and no-`<>` checks included).
- [ ] **Step 5: Commit.** `[TASK-1168] channel-slack: the /ax line for an agent whose own bot is live`

---

### Task 2: Refuse a shared-app connect for an agent whose own bot is live, on both paths `[tier: sensitive]` — **security-checklist required**

**Files:**
- Modify: `packages/channel-slack/src/channels.ts`:
  - header `:10-34`;
  - `ChannelDeps` `:36-43`;
  - `ConnectOutcome` `:71-73`;
  - `connectChannel` doc `:273-285` and body after the `refusedBySlack` closure (`:313-316`), before `conversationsInfo` (`:318`).
- Modify: `packages/channel-slack/src/commands.ts`:
  - header step 4 `:50-55`;
  - `connectRefusal` `:221-248`;
  - its call `:482`.
- Modify: `packages/channel-slack/src/agent-routes.ts`: the `connect` switch `:307-321`, and the route list comment `:30`.
- Test: `packages/channel-slack/src/__tests__/channels.test.ts`, `commands.test.ts`, `agent-routes.test.ts`.

**Interfaces:**
- Consumes: `COPY.slashOwnBot` (Task 1).
- Produces (Task 3 uses the helper and the agent-routes test world):

```ts
// channels.ts
export interface ChannelDeps { installs: Pick<InstallStore, 'current' | 'botForAgent'>; /* rest unchanged */ }
/** The agent's own bot as a refused connect names it. */
export interface OwnBot { botName: string; handle: string | null }
export type ConnectOutcome =
  | { ok: true; binding: ChannelBinding; reconnected: boolean }
  | { ok: false; reason: ConnectRefusal; code?: string }   // ConnectRefusal itself is unchanged
  | { ok: false; reason: 'own-bot'; ownBot: OwnBot };
/** The agent's own bot once its Allow is done (status 'active'), else null. A store failure propagates. */
export async function liveOwnBot(installs: Pick<InstallStore, 'botForAgent'>, agentId: string): Promise<InstallRow | null>;
```

- HTTP: `POST /settings/slack/:agentId/connect` → `409 { error: 'own-bot' }`.
- Test worlds: each of the three worlds' `installs` stub gains `botForAgent`. Each `state` gains `bot: InstallRow | null` (default `null`) and `botFault: unknown`, and each world returns `botLookups: string[]`.

Keep `'own-bot'` OUT of `ConnectRefusal`. Then `switch (outcome.reason)` narrows to the `ownBot` member, and `refuse()` stays as it is.

- [ ] **Step 1: Give the three test worlds a `botForAgent` stub.** Each stub records the agent id into `botLookups`, throws `state.botFault` when it's set, and returns a copy of `state.bot` only when `state.bot.agentId` is the agent asked about, else `null`. Add an active bot row fixture to `channels.test.ts` and `agent-routes.test.ts`:

```ts
const OWN_BOT: InstallRow = {
  ...INSTALL,
  installId: 'Hb7Kq2Lw8vNc5Xr1Bm7KdA',
  kind: 'bot',
  appId: 'A07HELPER01',
  botName: 'Support Helper',
  botUserId: 'U07HELPER01',
  connectedByUserId: 'usr_grace',
  agentId: 'agt_support',
  requestedByUserId: 'usr_grace',
  botHandle: 'supporthelper',
};
```

  **Trap:** `commands.test.ts` already has an active `OWN_BOT` row for `agt_support` (`:98-110`) in its `installs` map. It's the install that signs requests in the "ignored" test. The new stub must NOT return it by default. Default `state.bot` to `null`, and have tests set `w.state.bot = OWN_BOT`. Deriving it from the map would refuse every existing `/ax connect Support` test.

- [ ] **Step 2: Write the failing tests.**

  `channels.test.ts`, in `describe('connectChannel')`:
  1. `'refuses an agent whose own bot is live as own-bot, naming the bot, before Slack is asked anything: nothing joined, nothing bound (TASK-1168)'`. Set `w.state.bot = OWN_BOT`, then call `w.connect(SUPPORT_CH)`. Assert:
     - the result `toEqual({ ok: false, reason: 'own-bot', ownBot: { botName: 'Support Helper', handle: 'supporthelper' } })`;
     - `w.slack.calls` is `[]`;
     - `w.memory.store.listAll(INSTALL_ID)` resolves `[]`;
     - `w.botLookups` is `[SUPPORT.id]`;
     - `w.lines` `toEqual([{ level: 'info', msg: 'slack_channel_refused', fields: { installId: INSTALL_ID, reason: 'own-bot', stage: 'own-bot' } }])`;
     - `JSON.stringify(w.lines)` contains neither `'Support Helper'` nor `'supporthelper'`.
  2. `'a pending bot changes nothing: the connect goes through'`. Use `{ ...OWN_BOT, status: 'pending', teamId: null, teamName: null, botUserId: null, installedAt: null, botHandle: null }` and assert `toMatchObject({ ok: true, reconnected: false })`.
  3. `'a live bot Slack never gave a handle is named by its name alone'`. Use `{ ...OWN_BOT, botHandle: null }` and assert `ownBot` equals `{ botName: 'Support Helper', handle: null }`.
  4. `'a fault reading the agent's bot fails the connect: it propagates, and Slack is asked nothing'`. Set `state.botFault = Object.assign(new Error('relation gone'), { code: '42P01' })`. Assert it `rejects.toBe(fault)` and `w.slack.calls` is `[]`.
  5. `'no workspace still comes first: the bot is never looked up without one'`. Set `w.state.install = null`. Assert `{ ok: false, reason: 'no-workspace' }` and `w.botLookups` is `[]`.

  `commands.test.ts`, in `describe('/ax connect')`:

  7. `'an agent whose own bot is live → slashOwnBot naming its @handle; nothing joined or bound, logged by code alone (TASK-1168)'`. Set `w.state.bot = OWN_BOT`, then send `slash({ text: 'connect Support' })`. Assert:
     - the reply `toStrictEqual(said(COPY.slashOwnBot('Support', { botName: 'Support Bot', handle: 'supportbot' })))`;
     - `w.slack.methods()` is `['users.info']`;
     - `w.memory.rows.size` is `0`;
     - `msgs(w.lines, 'slack_channel_refused')` is `[{ installId: INSTALL_ID, reason: 'own-bot', stage: 'own-bot' }]`;
     - `JSON.stringify(w.lines)` contains neither `'Support Bot'` nor `'supportbot'`.
  8. `'… a live bot with no handle → the line names the bot'`. Use `{ ...OWN_BOT, botHandle: null }` and expect `COPY.slashOwnBot('Support', { botName: 'Support Bot', handle: null })`.
  9. `'… a pending bot → connects as before'`. Use the pending variant and expect `said(COPY.slashConnected('Support', 'support-desk'))`.
  10. `"… someone who can't manage the agent → slashNotManager, and the bot is never looked up"`. Send as `MEL`. Expect `said(COPY.slashNotManager)` and `w.botLookups` `[]`.
  11. `'… a fault reading the bot → slashFailed, logged by code alone'`. Expect `msgs(w.lines, 'slack_command_failed')` `[{ installId: INSTALL_ID, stage: 'connect', code: '42P01' }]` and `w.slack.methods()` `['users.info']`.
  12. In `describe('/ax disconnect')`: `'a shared binding of an agent whose own bot is live still disconnects'`. Call `connected(w)`, set `w.state.bot = OWN_BOT`, send as `GRACE`. Expect `said(COPY.slashDisconnected)` and the row gone.

  `agent-routes.test.ts`, in `describe('connect')`:

  13. `"answers 409 own-bot while the agent's own bot is live: Slack is asked nothing and nothing is bound; a pending bot connects as before (TASK-1168)"`. With `w.state.bot = OWN_BOT`:
      - `w.connect(SUPPORT.id, SALES_CH, ADA)` `toEqual({ status: 409, body: { error: 'own-bot' } })`;
      - `w.slack.sent` is `[]`;
      - `w.memory.row(INSTALL_ID, SALES_CH)` is `undefined`.

      Then with the pending variant, expect `toMatchObject({ status: 200 })`.

  In `describe('disconnect and remember')`:

  14. `'disconnect still removes a shared channel of an agent whose own bot is live'`. Connect first, then set `w.state.bot = OWN_BOT`. Expect `{ status: 200, body: { removed: true } }`.

- [ ] **Step 3: Run them and see them fail.** Run `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/channels.test.ts src/__tests__/commands.test.ts src/__tests__/agent-routes.test.ts`. Expected:
  - Tests 1, 3, 4, 7, 8, 11 and 13 FAIL, because the connect goes through.
  - Tests 2, 5, 9, 10, 12 and 14 PASS already. They pin behaviour this task must not change.
  - Every existing test PASSES: the stubs exist but nothing calls them yet.
- [ ] **Step 4: Implement it.**
  - **channels.ts:**
    - Widen `ChannelDeps.installs`, and add `OwnBot`, the outcome member and `liveOwnBot` (the Interfaces block).
    - In `connectChannel`, right after the `refusedBySlack` closure: `const own = await liveOwnBot(d.installs, i.agentId)`. If it isn't null, log the line above through `quietly`, and return `{ ok: false, reason: 'own-bot', ownBot: { botName: own.botName, handle: own.botHandle } }`.
    - Add the step to the doc comment's arrow chain: "→ the agent has no live bot of its own".
    - Add to the header: an agent whose own bot is live takes no channel through the shared app (TASK-1168), because its bot answers for it and the shared bot steps aside (router.ts); both ways in are refused here, before Slack, naming the bot; it's a store read, not under the app lock, because a connect racing the Allow leaves a binding the router already ignores for that agent and the status lists as `needsInvite`; a pending bot changes nothing.
  - **commands.ts:** `connectRefusal(outcome, agentName: string)` gets `case 'own-bot': return COPY.slashOwnBot(agentName, outcome.ownBot);`, and the call passes `chosen.agentName`. Header step 4 gains: "connectChannel refuses an agent whose own bot is live (TASK-1168): the reply names that bot and says to /invite it."
  - **agent-routes.ts:** add `case 'own-bot': return json(409, { error: 'own-bot' });` with a comment. The page that offered the connect is stale (it hides the picker and Reconnect while the bot is live), and reading the status again shows the bot and how to invite it. The route-list comment gets `· 409 own-bot while its own bot is live`.
- [ ] **Step 5: Run them and see them pass.** Same command. Expected: PASS. Then `pnpm --filter @ax/channel-slack build`, which shows `connectRefusal` covers every reason.
- [ ] **Step 6: Security walk.** Run the `security-checklist` skill over this task and Task 1's line. Record the PR note lines in the decisions shard. Each must be answered:
  - no new reach;
  - both callers of `connectChannel` are covered (`git grep -n "connectChannel(" packages/channel-slack/src` → only `agent-routes.ts` and `commands.ts`);
  - rights come first;
  - a fault fails closed;
  - the race leaves a binding the router steps aside on;
  - the handle reaches mrkdwn only through `shown(…, '@')`;
  - the log line has no name or handle;
  - no dependency change.
- [ ] **Step 7: Commit.** `[TASK-1168] channel-slack: no shared-app connect for an agent whose own bot is live`

---

### Task 3: The status marks the channels the live bot still needs `[tier: integration]`

**Files:**
- Modify: `packages/channel-slack/src/agent-routes.ts`:
  - header `:22-53` (replace "the channels it answers in" at `:23`);
  - `AgentSlackStatus` row type `:69-75`;
  - `status()` `:221-271`;
  - connect's answer row `:297-303`.
- Test: `packages/channel-slack/src/__tests__/agent-routes.test.ts`

**Interfaces:**
- Consumes: `liveOwnBot`, the world's `state.bot` and `state.botFault` (Task 2).
- Produces: wire field `needsInvite: boolean` on every `ready` row and on `POST …/connect`'s `channel`. It's true only when the same answer's `bot.state === 'live'`.

- [ ] **Step 1: Write the failing tests.** In `describe('the section')`, with `const LIVE: AgentSlackBot = { state: 'live', botName: 'Support Helper', handle: 'supporthelper', approver: 'Grace Hopper', needsClaim: false }`:
  1. `"with its own bot live, lists the shared channels it hasn't answered in yet, each needsInvite and never needsReconnect; one it has answered in leaves the list, and its shared binding stays (TASK-1168)"`.
     - Connect `SUPPORT_CH` as Ada and `SALES_CH` as Grace FIRST. Task 2 refuses a connect once the bot is live, so this is also what really happens.
     - Then set `w.state.bot = OWN_BOT` and `w.bots.answers.status = LIVE`.
     - `w.status(SUPPORT.id, MEL)` `toEqual` the full `ready` body. Its two rows are `{ channelId: SUPPORT_CH, name: 'support-desk', remember: true, connectedBy: 'Ada Admin', needsReconnect: false, needsInvite: true }` and the `SALES_CH` row for Grace, with `bot: LIVE`.
     - Then `w.memory.store.upsert({ installId: OWN_BOT.installId, channelId: SUPPORT_CH, agentId: SUPPORT.id, connectedByUserId: 'usr_grace', channelName: 'support-desk' })`. That's the bot's first mention there (router.ts).
     - The status's channel ids are now exactly `[SALES_CH]`.
     - `w.memory.row(INSTALL_ID, SUPPORT_CH)` still `toMatchObject({ agentId: SUPPORT.id, connectedByUserId: 'usr_ada' })`.
  2. `"a pending bot, no bot, or a live answer whose bot is gone by the route's own read: every row needsInvite false"`. Loop over these pairs and expect every row `needsInvite: false`:
     - pending row + `{ state: 'pending', botName: 'Support Helper', approver: 'Grace Hopper', canContinue: false }`;
     - `null` + `{ state: 'none', configTokenStored: false }`;
     - `null` + `LIVE`.
  3. `"a channel waiting for the bot doesn't ask agents about its connector: no outsider runs as them while the bot is live"`.
     - Connect as Ada, then `w.people.setRole(SUPPORT_TEAM, ADA.id, null)`.
     - Set `const before = w.people.inputs('agents:resolve').length`, then make the bot live.
     - `w.status(SUPPORT.id, GRACE)` has the row `needsReconnect: false, needsInvite: true`.
     - `w.people.inputs('agents:resolve').slice(before)` doesn't contain `{ agentId: SUPPORT.id, userId: ADA.id }`.
  4. `"a store fault reading the bot's channels is the route's 500, logged by code alone"`. Set the bot live and `state.botFault` to `42P01`. Expect `{ status: 500, body: { error: 'internal' } }`, and `w.lines` contains `{ level: 'error', msg: 'slack_channel_route_failed', fields: { stage: 'status', code: '42P01' } }`.

  Shifts in existing tests: add `needsInvite: false` to the exact rows at `:744`, `:745`, `:819` and `:918`. Those are the status list and connect's answer rows. Nothing else in the file changes.
- [ ] **Step 2: Run it and see it fail.** Run `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/agent-routes.test.ts`. Expected: FAIL on the four new tests and the four shifted rows.
- [ ] **Step 3: Implement it.**
  - Document `needsInvite` on the row type: the agent's own bot is live and hasn't answered in this channel yet, so the shared bot steps aside here and nobody reaches the agent in it until someone runs `/invite` for the bot. It's only ever true when `bot` is live in the same answer.
  - Connect's answer row gets `needsInvite: false`.
  - In `status()`, after the `no-workspace` return, use this. It's the one piece of logic the tests leave open:

```ts
// The channels the agent's own bot has answered in (a binding on its install), read only while
// `bot` says live: bots.status read its own, and a row must never need a bot this answer doesn't show.
const own = bot.state === 'live' ? await liveOwnBot(d.installs, a.agentId) : null;
const answered =
  own === null ? null : new Set((await d.channels.listForAgent(own.installId, a.agentId)).map((c) => c.channelId));
for (const b of await d.channels.listForAgent(install.installId, a.agentId)) {
  // Its own bot answers here now: off the list. The shared binding stays, unused.
  if (answered?.has(b.channelId) === true) continue;
  const needsInvite = answered !== null;
  channels.push({
    channelId: b.channelId,
    name: b.channelName,
    remember: b.remember,
    connectedBy: await nameOf(b.connectedByUserId),
    // The shared bot steps aside for this agent while its own bot is live: no outsider runs as the connector here.
    needsReconnect: !needsInvite && (await accessOf(b.connectedByUserId)) !== 'yes',
    needsInvite,
  });
}
```

  - Header: replace "the channels it answers in" (`:23`) with "the channels connected to it through the shared app". Add a paragraph: with its own bot live (TASK-1168), those are the ones still waiting for the bot, each `needsInvite` until the bot has answered there (a binding on the bot's install), then off the list; the bot's own channels aren't listed; and `POST …/connect` refuses that agent with `409 own-bot` (channels.ts).
- [ ] **Step 4: Run it and see it pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `[TASK-1168] channel-slack: agent settings mark the channels a live bot still needs, and drop the ones it answers in`

---

### Task 4: channel-web reads `needsInvite`, re-reads on `own-bot`, and has the copy `[tier: mechanical]`

**Files:**
- Modify: `packages/channel-web/src/lib/agent-slack.ts`:
  - `SlackChannelRow` `:26-32`;
  - `parseRow` `:121-134`;
  - `AGENT_SLACK_COPY` `:350-362`;
  - `agentSlackStateChanged` `:392-402`;
  - header route list `:9`.
- Test: `packages/channel-web/src/lib/__tests__/agent-slack.test.ts`

**Interfaces:**
- Consumes: the wire from Tasks 2 and 3.
- Produces (Task 5 uses all of it):

```ts
export interface SlackChannelRow { /* the five fields */ needsInvite: boolean }
/** A live bot as the moved-channel lines name it: its @handle, or its name when Slack never said one. */
export interface InviteTarget { botName: string; handle: string | null }
AGENT_SLACK_COPY.movedNotice(t: InviteTarget): string
AGENT_SLACK_COPY.movedRow(t: InviteTarget): string
AGENT_SLACK_COPY.movedDisconnect(channel: string): string
agentSlackStateChanged(new AgentSlackError(409, 'own-bot')) === true
```

- [ ] **Step 1: Write the failing tests.**
  - Fixture: `ROW` (`:45`) gains `needsInvite: false`.
  - New in `describe('fetchAgentSlack')`: `"reads whether a row still needs the agent's own bot invited; an older host that omits it reads false; a wrong-typed one is a bad response"`.
    - A `ready` body whose row has `needsInvite: true` resolves with it.
    - The same row without the key resolves with `needsInvite: false`.
    - `needsInvite: 'yes'` rejects `toMatchObject({ code: 'bad-response' })`.
  - In `describe('writes')`: connect's answer row without the key comes back with `needsInvite: false`.
  - In `'personal-agent and no-workspace refusals mean the picture is stale'` (`:342`): add `expect(agentSlackStateChanged(new AgentSlackError(409, 'own-bot'))).toBe(true)`.
  - New: `"the moved-channel lines name the bot's @handle, or its name when Slack never said one"`. It pins the five strings in the Design table, through `AGENT_SLACK_COPY.movedNotice({ botName: 'Quill', handle: 'quill' })`, its `handle: null` twin, `movedRow` (both) and `movedDisconnect('support')`.
- [ ] **Step 2: Run it and see it fail.** Run `pnpm --filter @ax/channel-web exec vitest run src/lib/__tests__/agent-slack.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement it.**
  - `parseRow` destructures `needsInvite = false` and refuses a non-boolean.
  - Document the row field: an older host omits it, and that reads as false.
  - `agentSlackStateChanged` adds `'own-bot'` to its 409 codes. Its doc says the agent's own bot went live since this page was drawn.
  - The three copy functions return exactly the Design table's strings.
- [ ] **Step 4: Run it and see it pass.** Same command, then `pnpm --filter @ax/channel-web build`. Expected: PASS. tsc flags any `SlackChannelRow` fixture that still needs the field; Task 5 fixes `AgentSlack.test.tsx`'s.
- [ ] **Step 5: Commit.** `[TASK-1168] channel-web: read needsInvite, re-read on own-bot, and the moved-channel copy`

---

### Task 5: Agent settings list the channels the bot still needs `[tier: integration]`

**Files:**
- Modify: `packages/channel-web/src/components/workspace/AgentSlack.tsx`:
  - header `:1-13`;
  - `ReadySection` `:207`, `:277-311`, `:333-342`;
  - `ChannelRow` `:347-426`;
  - `DisconnectDialog` `:546-615`.
- Test: `packages/channel-web/src/components/workspace/__tests__/AgentSlack.test.tsx`

**Interfaces:**
- Consumes: `SlackChannelRow.needsInvite`, `InviteTarget`, `AGENT_SLACK_COPY.movedNotice`/`movedRow`/`movedDisconnect`, and `agentSlackStateChanged` (Task 4).
- Produces: nothing later tasks use.

Invoke the `shadcn` skill first. No new primitive is needed: the notice stays the muted `<p>` it replaces, and the rows stay in the existing `Card` list.

- [ ] **Step 1: Write the failing tests.**
  - Fixtures: `SUPPORT` (`:47-53`) gains `needsInvite: false`; add `const MOVED: SlackChannelRow = { ...SUPPORT, needsInvite: true }`.
  - Replace the three tests in `describe("the agent's own bot, around the channel list")` (`:164-184`) and add more:
  1. `'live: the channels it still needs are listed under one line that says to /invite it; the picker is gone'`. Use `ready([MOVED, { ...MOVED, channelId: 'C0OPS00001', name: 'ops' }], true, LIVE_BOT)`. Assert:
     - the notice has the exact handle text;
     - both names are in the `Connected channels` list;
     - `within(list).getAllByText('Run /invite @quill here.')` has length 2;
     - no `Connect a channel` combobox.
  2. `'a channel it still needs has no memory switch, no "Connected by" and no Reconnect: only the hint and, for a manager, Disconnect'`. Use `ready([{ ...OPS, needsInvite: true }], true, LIVE_BOT)`, so `needsReconnect` is true in the fixture. Assert there's:
     - no `switch`;
     - no `/Connected by/`;
     - no `'Needs reconnecting'`;
     - no `Reconnect` button;
     - no `/remembers what people with access/`;
     - a `Disconnect` button.
  3. `'live with no handle: the lines name the bot instead'`. Use `{ ...LIVE_BOT, handle: null }`: the no-handle notice, and `'Invite Quill here with /invite.'`.
  4. `'a member reads the same notice and hint, with no Disconnect'`.
  5. `'live, with no channel left to invite: no "no channels" line for a manager or a member, and the live line still says how to invite it'`. Use `ready([], true|false, LIVE_BOT)`:
     - `'@quill is live. Invite it to a channel with /invite @quill.'` shows;
     - neither `/isn't answering in any channels yet/` nor `/isn't connected to any Slack channels yet/` shows;
     - no `/still need/`.
  6. `'not live: the picker stays, and a row marked needsInvite is drawn as an ordinary row'`. Use `ready([MOVED])`, which has no bot: the combobox shows, there's no `/still need/` and no `/Run \/invite/`, and the remember switch is there.
  7. In `describe('disconnecting')`: `'a channel the bot still needs: the dialog says what Disconnect does then; confirming takes it off the list, and the line goes with the last one'`.
     - The dialog `'Disconnect #support?'` shows `"We'll take #support off this list. The agent answers there only after its own bot is invited."`, and no `/connect it again any time/`.
     - After confirming, `disconnect` is called with `('a1', 'C0SUPPORT1')`.
     - The list goes, with no `/still need/` and no `/isn't answering in any channels yet/`.
  8. In `describe('a write on a stale picture re-reads the section')`: `'connect refused with 409 own-bot (its bot went live meanwhile) re-reads, with no error line'`.
     - Start from `ready([])`; `fetchStatus.mockResolvedValueOnce(ready([], true, LIVE_BOT))`.
     - Pick `#sales`, and `connect` rejects `new AgentSlackError(409, 'own-bot')`.
     - The live line shows, `fetchStatus` was called twice, and there's no `alert`.
- [ ] **Step 2: Run it and see it fail.** Run `pnpm --filter @ax/channel-web exec vitest run src/components/workspace/__tests__/AgentSlack.test.tsx`. Expected: FAIL on 1-5 and 7. Tests 6 and 8 may pass already, because they pin existing behaviour.
- [ ] **Step 3: Implement it.**
  - **`ReadySection`:**
    - Add `const invite: InviteTarget | null = bot.state === 'live' ? { botName: bot.botName, handle: bot.handle } : null` and `isMoved = (row) => invite !== null && row.needsInvite`.
    - With no channels, render the existing empty line only when `bot.state !== 'live'`. A live bot answers wherever it was invited, which this list doesn't show.
    - Replace the TASK-1167 live line (`:285-290`) with `invite !== null && channels.some(isMoved)` → the same muted `<p>` holding `AGENT_SLACK_COPY.movedNotice(invite)`.
    - Pass `invite={isMoved(row) ? invite : null}` to each `ChannelRow`, and `moved={disconnecting !== null && isMoved(disconnecting)}` to `DisconnectDialog`.
  - **`ChannelRow`:** gains `invite: InviteTarget | null`. When it's set, the `<li>` shows:
    - the `#name` line;
    - a muted `AGENT_SLACK_COPY.movedRow(invite)`;
    - `Disconnect` for a manager;
    - the row error line.

    It has no badge, no Reconnect, no "Connected by" and no switch or note.
  - **`DisconnectDialog`:** gains `moved: boolean`. When it's true, the description is `AGENT_SLACK_COPY.movedDisconnect(row?.name ?? '')`.
  - **Header:** "the channels it answers in" (`:2-3`) becomes "the channels connected to it through the shared Slack app". Add a sentence: once the agent's own bot is live (TASK-1168), the list is the channels that still need that bot invited, and nothing more is connected through the shared app.
- [ ] **Step 4: Run it and see it pass.** Same command, then `pnpm --filter @ax/channel-web build`. Expected: PASS, including tsc over the test fixtures.
- [ ] **Step 5: Commit.** `[TASK-1168] channel-web: agent settings list the channels its own bot still needs`

---

### Task 6: The design says what was built, plus the changeset `[tier: mechanical]`

**Files:**
- Modify: `docs/plans/2026-11-09-channel-slack-design.md`:
  - §3 rules `:371-391`;
  - §4 "Channels it was already in" `:445-451`;
  - §9 item 8 *Progress* `:1083-1086`.
- Create: `.changeset/slack-bot-moved-channels.md`

**Interfaces:** none.

- [ ] **Step 1: Edit the design.**
  - **§3 rules:** add a bullet. "**An agent with its own bot:** once that bot is live (§4), neither way in connects a channel to the agent through the shared app. The answer names the bot's @handle and says to `/invite` it (TASK-1168). A pending bot changes nothing, and disconnecting an old connection still works."
  - **§4, after the "Channels it was already in" paragraph:** "**As built (TASK-1168).** The agent's settings list each of those channels under 'These channels still need @ada: run /invite @ada in each one.' A channel leaves the list once @ada has answered there: AX hears only mentions, and the first one binds the channel to the bot. The old shared connection stays, unused, and Disconnect still removes it. The bot's own channels aren't listed yet."
  - **§9 item 8 *Progress*:** add one sentence on its own line: "TASK-1168 lists the already-connected channels that still need the new handle, and refuses connecting the agent through the shared app once its bot is live."
- [ ] **Step 2: Write the changeset.** Patch for `'@ax/channel-slack'` and `'@ax/channel-web'`, in the CLAUDE.md voice, one paragraph: when a team agent gets its own Slack bot, its settings list the channels it was already connected to through the shared bot that still need the new one (`/invite @handle` in each; a channel leaves the list once the bot has answered there); while its own bot is live, connecting that agent through the shared bot, from its settings or with `/ax connect`, is refused, and the reply names the bot to invite instead.
- [ ] **Step 3: Check it.** Run `pnpm test:scripts`. It covers the memory and docs guards, and the doc must cite only paths that exist. Expected: PASS.
- [ ] **Step 4: Commit.** `[TASK-1168] docs: as built for the channels a team bot still needs`

---

## Final gate (before the PR)

1. `git grep -n "connectChannel(" packages/channel-slack/src` lists only `channels.ts`, `agent-routes.ts` and `commands.ts`. `git grep -n "the channels it answers in" packages` lists nothing.
2. `pnpm build && pnpm lint`.
3. `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, with `DOCKER_HOST` set as CLAUDE.md says. A Docker teardown timeout in an untouched package is re-run alone, not waved through.
4. Rebase on `origin/main` first. TASK-1169 and TASK-1172 work in the same package, so expect textual conflicts in `copy.ts`/`copy.test.ts` (the sorted key list), `agent-routes.ts`, `AgentSlack.tsx`, `lib/agent-slack.ts` and the design doc's §9. Keep both sides, then re-run the targeted files.

## For the builder's handoff

**Follow-ups to file (not built here):**
1. **Privacy: the bot's first mention resets the channel's memory switch to on.** Take a channel whose shared memory switch was turned off. At the bot's first mention, it gets a bot binding with the switch on (`router.ts bindBotChannel` → `upsert` defaults `remember` to true). So members' words there start being remembered after the move. Carry `remember` over from the shared binding at that first bind. This is related to TASK-1167 residual (d).
2. List the bot's own channels in agent settings, with their memory switch (TASK-1167 follow-up 5). Until then, a channel drops off the page once the bot answers there.
3. `router.ts` checks `own?.status === 'active'` inline twice (`:581`, `:748`). It could call `channels.ts liveOwnBot`, so "live" has one spelling. Left alone here because siblings are editing the router.

**Learnings:**
- A dedicated bot's channel binding is written at its first admitted, non-empty mention, never at `/invite`. Its manifest subscribes to `app_mention` only.
- `connectChannel` is the one core for both connect paths. A rule added there covers `/ax connect` and the settings picker.
- In the status, `needsInvite` is true only when the same answer's `bot` is live.
- The channels, commands and agent-routes test worlds now stub `installs.botForAgent`. `commands.test.ts`'s existing `OWN_BOT` install row is not returned as the agent's bot unless a test sets `state.bot`.
