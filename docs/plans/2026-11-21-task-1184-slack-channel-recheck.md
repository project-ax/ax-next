# TASK-1184: Slack re-checks a bound channel when each turn starts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Update (TASK-1186):** this plan's shared-app parts are retired by design §4b.1. The shared app no longer connects or answers in channels, so only a team bot's channels are re-checked, with its own token. `ChannelStore.remove` and `channel-check.ts` stay. Read "the shared app" below as history.

**Goal:** No channel turn runs, on the shared app or on a team agent's own bot, in a channel that Slack now says is private, archived or Slack Connect. That channel's binding goes, its sender is told once, and if Slack can't answer, no turn runs either.

**Architecture:** A new `channel-check.ts` asks `conversations.info` with the install's bot token. It keeps an *allowed* answer per install and channel for `CHANNEL_CHECK_TTL_MS` (60 s), and never keeps a refusal or a failure. The router's queued `job` asks it after the existing re-reads and right before `recordThread`. On a definitive refusal, the job removes the binding with `channels.remove`, the same delete a team admin's Disconnect makes. The one turn whose remove took the binding tells its sender privately. Any other answer from Slack means no turn and "try again", and the binding stays. `plugin.ts` builds the check next to `createSeenEvents`.

**Tech Stack:** TypeScript, vitest, `@ax/channel-slack`. No new dependency.

**Spec:** Card TASK-1184 (a bug the TASK-1174 walk found, PR #1219, `main` `8f0aeb7f0`). Design: `docs/plans/2026-11-09-channel-slack-design.md` §1 rule 6, §3 "The channel", §4. The design record for this plan is `.claude/memory/decisions/2026-11-21-TASK-1184.md`: the approaches, the brief claims it refuted, the residuals and the security note. Read it with this plan.

**Approaches (decided, see the decisions shard):**
1. **Chosen:** re-check at turn start with a short cache, remove the binding on a definitive refusal, and tell the sender once.
2. Re-check, keep the binding, and refuse every turn. Rejected: settings would still list the dead channel as connected, memory would keep learning from its threads (the capture veto only refuses threads of a channel with no binding), and "once" would need in-memory state.
3. A `suspended` column. Rejected: it needs a migration, and the card says not to redesign binding.
4. Subscribe to Slack's conversion, archive and share events. Rejected for this PR: nobody has measured whether they reach a bot; every existing install would need a Disconnect and Connect to get them; events can be missed; and the turn-start check would still be the backstop.

## Global Constraints

- No new Slack scope, event, method, route, hook, IPC action, migration or dependency. `conversations.info` and `channels:read` already exist on both apps.
- COPY never names the product (copy.test.ts fails `\bAX\b`) and never holds `<`, `>`, `](`, `<!`, `<@`, `<#` or a bare `@here`/`@channel`/`@everyone`.
- Log lines carry only `installId`, `reason`, `stage`, `count` and `code`. Never a channel id or name, a Slack user id, an email, an agent id, a bot name or message text. Router `Log` field values are `string | number`.
- Sources never spell an invisible or bidi character literally (source-hygiene.test.ts). Never type a backslash-u escape in tool input: the tools decode it (mistakes shard TASK-1093).
- Fake tokens come from `fakeBotToken(...)` (short digit groups), never a real token's shape.
- `beforeEach`/`beforeAll` take a block body (`() => { ...; }`).
- `pnpm --filter <pkg>` goes BEFORE the script. Use `pnpm -r --no-bail` for multi-package runs. `plugin.test.ts`, the store tests and the preset-k8s composition need Docker, with `DOCKER_HOST` named explicitly (CLAUDE.md "Docker-backed tests").
- A sibling builder (TASK-1185, a bot's @handle) is editing `packages/channel-slack` at the same time. Keep each shared-file hunk as small as this plan names it. Commit with a pathspec (`git commit -- <paths>`), never a bare `git commit` (mistakes shard TASK-1171).
- No boundary review: nothing here changes a hook surface.

## Review Focus

1. **A turn that waited longer than the minute behind a long turn:** it must ask Slack again, never reuse an "allowed" that has gone stale. Pinned by Task 2's "the walk's sequence" test (the clock crosses `CHANNEL_CHECK_TTL_MS`) and Task 1's expiry tests.
2. **Slack can't answer the check** (rate limit, revoked token, 5xx, an answer with no channel object, a network throw, an answer about another channel): no turn, the binding kept, nothing remembered. Pinned by Task 1's unknown cases and Task 2's "when Slack can't say" test.
3. **Two people mentioning at once in a channel that just turned private:** one line, one disconnect, no turn. Pinned by Task 2's "told once" test.
4. **A channel that turns public again after a refusal:** nothing refused was cached, and the bot binds it again with the switch the team set. Pinned by Task 1's "never kept" cases and Task 2's round-trip test.
5. **Log lines from the new paths naming the channel or a person:** pinned by the leak assertion in Task 2's matrix test.

## Files

| File | Change | Task |
|---|---|---|
| `packages/channel-slack/src/channel-check.ts` | **Create.** `createChannelCheck`, `ChannelCheck`, `ChannelCheckResult`, `CHANNEL_REFUSED_CODES` | 1 |
| `packages/channel-slack/src/__tests__/channel-check.test.ts` | **Create.** Unit tests | 1 |
| `packages/channel-slack/src/limits.ts` | `CHANNEL_CHECK_TTL_MS`, `CHANNEL_CHECK_MAX`, after `CHANNEL_NAME_MAX` (`:164`) | 1 |
| `packages/channel-slack/src/router.ts` | T1: drop the local `CHANNEL_REFUSED_CODES` (`:837-844`) and import it. T2: `RouterDeps` (`:133-156`), the job's check (between `:610` and `:611`), header (`:71-84`, `:107-114`) | 1, 2 |
| `packages/channel-slack/src/copy.ts` | `channelNoLongerAllowed`, right after `channelUnavailable` (`:226`) | 2 |
| `packages/channel-slack/src/__tests__/copy.test.ts` | key list (`:120`), `PRIVATE` (`:397`), one test after `:420` | 2 |
| `packages/channel-slack/src/plugin.ts` | import, plus one `channelCheck` line in `createEventRouter({...})` (`:500-507`) | 2 |
| `packages/channel-slack/src/__tests__/router.test.ts` | world (`now`, `removeFails`, `remove`, `channelCheck`), 3 assertions (`:2751`, `:2792`, `:3237`), a new describe at the end | 2 |
| `packages/channel-slack/src/__tests__/plugin.test.ts` | `fakeSlackFetch` answers `conversations.info`; `botChannelSlackFetch` (`:396-422`) deleted, its 5 callers use `disconnectSlackFetch()` | 2 |
| `docs/plans/2026-11-09-channel-slack-design.md` | `:392-394`, `:550-552`, and a "Known gaps, accepted (TASK-1184)" block before `## 7.` (`:1239`) | 3 |
| `packages/channel-slack/src/channels.ts` | prose only: `:25-30`, `:431-434` | 3 |

---

### Task 1: `channel-check.ts`, Slack's word on a bound channel kept for a minute [tier: sensitive]

Needs `security-checklist`: it sorts Slack's untrusted answer into allow or refuse, and a wrong cache entry would fail open.

**Files:**
- Create: `packages/channel-slack/src/channel-check.ts`
- Create: `packages/channel-slack/src/__tests__/channel-check.test.ts`
- Modify: `packages/channel-slack/src/limits.ts` (Channels section, after `CHANNEL_NAME_MAX`)
- Modify: `packages/channel-slack/src/router.ts:837-844` (the local set goes; `import { CHANNEL_REFUSED_CODES } from './channel-check.js'`)

**Interfaces:**
- Consumes: `connectable(c: SlackChannel): boolean` (`channels.ts:436`), `SlackApiError`, `SlackApi`, `SlackChannel` (`slack-api.ts`), `logCode(err): string` (`log-code.ts`).
- Produces:

```ts
/** Slack's codes for a channel a bot reading public channels only can't serve: definitive, never "try again". */
export const CHANNEL_REFUSED_CODES: ReadonlySet<string>; // exactly 'channel_not_found', 'missing_scope'

export type ChannelCheckResult =
  | { kind: 'allowed' }
  /** Definitive. code: 'not-public' | 'archived' | 'shared' (from the flags) or Slack's 'channel_not_found' | 'missing_scope'. */
  | { kind: 'refused'; code: string }
  /** Slack couldn't say. code: Slack's own, logCode's, or 'id-mismatch'. */
  | { kind: 'unknown'; code: string };

export interface ChannelCheck {
  /** Never rejects. Asks Slack only when no allowed answer younger than ttlMs is kept. */
  check(installId: string, botToken: string, channelId: string): Promise<ChannelCheckResult>;
}

export function createChannelCheck(o: {
  api: Pick<SlackApi, 'conversationsInfo'>;
  now: () => number;
  ttlMs: number;
  max: number;
}): ChannelCheck;
```

- [ ] **Step 1: Write the failing tests** in `channel-check.test.ts`

Fixtures: `INSTALL = 'q3VtZ0xH4kTn9Wb2LmPa1A'`, `OTHER_INSTALL = 'Tq2Lw8vNc5Xr1Bm7Kd4JsA'`, `CH = 'C07SUPPORT1'`, `CH2 = 'C07OPSROOM1'`, `TOKEN = fakeBotToken('CHANNELCHECKSECRET')`, `TTL = 60_000`. `live(id, over)` builds a `SlackChannel` with `isChannel: true`, `isMember: true` and every refusing flag false. `setup(answer, max = 100)` gives `{ calls, check, at(ms) }`. Its fake `conversationsInfo` records `[token, channel]` and throws an `Error` answer; `now` reads a variable that `at(ms)` sets to `1_000_000 + ms`.

```ts
it("a public, live channel is allowed, asked with the install's token about that channel", async () => {
  const { calls, check } = setup((c) => live(c));
  expect(await check.check(INSTALL, TOKEN, CH)).toEqual({ kind: 'allowed' });
  expect(calls).toEqual([[TOKEN, CH]]);
});

it('an allowed answer is kept for ttlMs from when it arrived, then asked again', async () => {
  const { calls, check, at } = setup((c) => live(c));
  await check.check(INSTALL, TOKEN, CH);
  at(TTL - 1); await check.check(INSTALL, TOKEN, CH);
  expect(calls).toHaveLength(1);
  at(TTL); expect(await check.check(INSTALL, TOKEN, CH)).toEqual({ kind: 'allowed' });
  expect(calls).toHaveLength(2);
});

it.each([
  ['private', { isPrivate: true }, 'not-public'],
  ['a private group, not a channel', { isChannel: false }, 'not-public'],
  ['archived', { isArchived: true }, 'archived'],
  ['Slack Connect', { isExtShared: true }, 'shared'],
  ['a pending Slack Connect invitation', { isPendingExtShared: true }, 'shared'],
] as const)('a channel Slack describes as %s is refused, and the refusal is never kept', async (_n, over, code) => {
  const { calls, check } = setup((c) => live(c, over));
  expect(await check.check(INSTALL, TOKEN, CH)).toEqual({ kind: 'refused', code });
  await check.check(INSTALL, TOKEN, CH);
  expect(calls).toHaveLength(2);
});

it.each(['channel_not_found', 'missing_scope'])('Slack answering %s is a refusal, never kept', async (code) => { /* same shape, SlackApiError('conversations.info', code) */ });

it('CHANNEL_REFUSED_CODES is exactly channel_not_found and missing_scope', () => {
  expect([...CHANNEL_REFUSED_CODES].sort()).toEqual(['channel_not_found', 'missing_scope']);
});

it("allowed exactly when channels.ts connectable says so, for every combination of the five flags", async () => {
  // i = 0..31 → isChannel, isPrivate, isArchived, isExtShared, isPendingExtShared from i's bits; a fresh setup each time.
  // expect((await check.check(...)).kind === 'allowed').toBe(connectable(info));
});

it.each([
  ['a rate limit', new SlackApiError('conversations.info', 'ratelimited'), 'ratelimited'],
  ['a Slack error', new SlackApiError('conversations.info', 'internal_error'), 'internal_error'],
  ['a token Slack refuses', new SlackApiError('conversations.info', 'token_revoked'), 'token_revoked'],
  ['an unreadable answer', new SlackApiError('conversations.info', 'bad-response'), 'bad-response'],
  ['a network failure', new Error('socket hang up'), 'unknown'],
  ['an answer about another channel', live(CH2), 'id-mismatch'],
] as const)("%s is unknown, and nothing is kept: the next check asks again", async (_n, answer, code) => {
  const { calls, check } = setup(() => answer);
  expect(await check.check(INSTALL, TOKEN, CH)).toEqual({ kind: 'unknown', code });
  await check.check(INSTALL, TOKEN, CH);
  expect(calls).toHaveLength(2);
});

it('never rejects, even when the client throws before it awaits anything', async () => {
  // api.conversationsInfo is a plain (non-async) function that throws → resolves { kind: 'unknown', code: 'unknown' }
});

it('an expired answer that Slack now fails to give is unknown, never the old allowed', async () => { /* allowed at 0; failing answer at TTL → unknown */ });

it('answers are kept per install and per channel', async () => {
  // allowed (INSTALL, CH) → (OTHER_INSTALL, CH) asks; (INSTALL, CH2) asks; (INSTALL, CH) doesn't. calls length 3.
});

it('keeps at most max answers, forgetting the oldest first', async () => {
  // max 2: CH, CH2, 'C07THIRDCH1' allowed → CH asks again (4 calls), 'C07THIRDCH1' doesn't.
});

it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('ttlMs and max must be positive integers (%s)', (bad) => {
  expect(() => createChannelCheck({ api, now: () => 0, ttlMs: bad, max: 1 })).toThrow(RangeError);
  expect(() => createChannelCheck({ api, now: () => 0, ttlMs: 1, max: bad })).toThrow(RangeError);
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/channel-check.test.ts`
Expected: FAIL, because `../channel-check.js` doesn't exist yet.

- [ ] **Step 3: Implement `createChannelCheck` in `channel-check.ts`, add the limits, and move the set**

`check` runs, in order:
1. If the key `${installId}/${channelId}` has an entry and `now() < expiresAt`, return `allowed` without asking Slack. An expired entry is dropped.
2. `await o.api.conversationsInfo(botToken, channelId)` inside `try`. A `SlackApiError` whose code is in `CHANNEL_REFUSED_CODES` → `refused` with that code. Any other throw → `unknown` with `logCode(err)`.
3. `info.id !== channelId` → `unknown`, `'id-mismatch'`.
4. `!connectable(info)` → `refused`, with code `'not-public'` when `!isChannel || isPrivate`, else `'archived'`, else `'shared'`. That is `channels.ts connectChannel`'s order (`:374-376`).
5. While the map holds `max` or more entries, delete the oldest (insertion order, as `secret-cache.ts` does). Then set `expiresAt = now() + ttlMs`, reading `now()` after the answer arrives, and return `allowed`.

Throw `RangeError('createChannelCheck: ttlMs and max must be positive integers')` unless both pass `Number.isSafeInteger(v) && v > 0`. The module never logs.

Its header comment says four things: why it exists (TASK-1184: a channel can change after it is bound; an `app_mention` carries no channel type), what counts as refused, the keep-only-allowed rule (and why: a kept refusal would delete a binding re-made within the minute), and that `missing_scope` is definitive here because a binding exists only after this install's own token read the channel. Move the doc comment of `router.ts:837-843` onto `CHANNEL_REFUSED_CODES`.

`limits.ts`, in the Channels section after `CHANNEL_NAME_MAX`:

```ts
/**
 * How long Slack's word that a connected channel is still public, live and
 * not Slack Connect is trusted before a turn there asks again
 * (channel-check.ts, TASK-1184). A channel made private, archived or shared
 * meanwhile still gets the turns that start within this long.
 */
export const CHANNEL_CHECK_TTL_MS = 60_000;
/** At most this many channels' answers are kept, the oldest forgotten first. */
export const CHANNEL_CHECK_MAX = 1_000;
```

- [ ] **Step 4: Run the new tests and the router's own**

Run: `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/channel-check.test.ts src/__tests__/router.test.ts && pnpm --filter @ax/channel-slack build`
Expected: PASS. `bindBotChannel`'s refusals (`router.test.ts` "no binding, no turn, no line" cases) still pass with the imported set, and tsc is clean.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-slack/src/channel-check.ts packages/channel-slack/src/__tests__/channel-check.test.ts packages/channel-slack/src/limits.ts packages/channel-slack/src/router.ts
git commit -m "[TASK-1184] channel-slack: channel-check, Slack's word on a bound channel kept for a minute" -- packages/channel-slack/src/channel-check.ts packages/channel-slack/src/__tests__/channel-check.test.ts packages/channel-slack/src/limits.ts packages/channel-slack/src/router.ts
```

---

### Task 2: each channel turn asks first; a refused channel is disconnected and its sender told once [tier: sensitive]

Needs `security-checklist`. This is the privacy boundary for which channels a team agent with its owner's connectors answers in. Slack's untrusted answer drives a binding delete, and a concurrent "once" rides on `remove`'s single winner.

**Files:**
- Modify: `packages/channel-slack/src/__tests__/router.test.ts`
- Modify: `packages/channel-slack/src/router.ts`
- Modify: `packages/channel-slack/src/copy.ts`, `packages/channel-slack/src/__tests__/copy.test.ts`
- Modify: `packages/channel-slack/src/plugin.ts`
- Modify: `packages/channel-slack/src/__tests__/plugin.test.ts`

**Interfaces:**
- Consumes: `createChannelCheck`, `ChannelCheck`, `CHANNEL_CHECK_TTL_MS`, `CHANNEL_CHECK_MAX` (Task 1). `ChannelStore.remove(installId, channelId, agentId): Promise<boolean>`, which is true only for the caller that deleted the row; the kept switch stays.
- Produces: `RouterDeps.channelCheck: ChannelCheck`; `RouterDeps.channels: Pick<ChannelStore, 'get' | 'recordThread' | 'bindBot' | 'remove'>`; `COPY.channelNoLongerAllowed: string`. Log lines: `slack_channel_disconnected {installId, reason:'channel-not-allowed', code}` (info, only from the turn whose remove returned true), `slack_turns_dropped {installId, reason:'channel-not-allowed', count:1, code}` (info, every refused turn), `slack_event_failed {installId, stage:'channel-check'|'channel-remove', code}` (error).

- [ ] **Step 1: Give the test world the check** (`router.test.ts`)

Add world options `now?: () => number` (the channel check's clock only; default `() => Date.now()`, so reply-stream timing stays on `systemClock`) and `removeFails?: boolean`. `bindings` gains `remove(installId, channelId, agentId)`. When `removeFails` is set it throws `new PluginError({ code: 'store-unavailable', plugin: 'fake-store', message: 'db down: #support' })`; otherwise it returns `channels.store.remove(...)`. `createEventRouter({...})` gains `channelCheck: createChannelCheck({ api: slack.api, now: o.now ?? (() => Date.now()), ttlMs: CHANNEL_CHECK_TTL_MS, max: CHANNEL_CHECK_MAX })`. Import the two constants from `../limits.js` and `createChannelCheck` from `../channel-check.js`.

- [ ] **Step 2: Write the failing tests**: a new describe at the end of `router.test.ts`, `'createEventRouter: a bound channel Slack no longer allows (TASK-1184)'`

Locals: `infoCalls(w)` (the `conversationsInfo` calls), and `WAYS`, the two ways in:

| `way` | `install` | `installId` | `token` | `mention(over)` | `live(w)` (install only) | `bound(w)` (plus a binding made while public) | `next` (ephemerals for a mention after removal) |
|---|---|---|---|---|---|---|---|
| `'the shared app'` | `INSTALL` | `INSTALL_ID` | `BOT_TOKEN` | `mention(over)` | nothing | nothing (the world binds #support) | `[{ channel: SUPPORT, user: ALICE, text: COPY.channelNotConnected }]` |
| `"a team agent's own bot"` | `OWN_BOT` | `OWN_BOT_ID` | `OWN_BOT_TOKEN` | `botMention(over)` | `w.putInstall(OWN_BOT)` | `putInstall` plus `w.channels.rows.set(\`${OWN_BOT_ID}/${SUPPORT}\`, {installId: OWN_BOT_ID, channelId: SUPPORT, agentId: SUPPORT_AGENT.id, connectedByUserId: 'usr_ada', channelName: 'support', remember: true, createdAt: new Date('2026-11-19T11:00:00Z')})` | `[]` (`bindBotChannel` refuses silently) |

`REFUSED`: `['made private', slackChannel(SUPPORT, 'support', { isPrivate: true }), 'not-public']`, `['a private group', …{ isChannel: false }, 'not-public']`, `['archived', …{ isArchived: true }, 'archived']`, `['shared with another company', …{ isExtShared: true }, 'shared']`, `['invited to Slack Connect', …{ isPendingExtShared: true }, 'shared']`, `['hidden by its missing scope (the walk measured this)', new SlackApiError('conversations.info', 'missing_scope'), 'missing_scope']`, `['not found', new SlackApiError('conversations.info', 'channel_not_found'), 'channel_not_found']`.

```ts
// A: WAYS × REFUSED (14 cases)
it.each(WAYS.flatMap((way) => REFUSED.map(([what, answer, code]) => [way.way, what, way, answer, code] as const)))(
  '%s: a turn in a bound channel Slack now says is %s never runs; the binding goes and the sender is told once',
  async (_w, _what, way, answer, code) => {
    const w = world({ channelInfo: () => answer });
    way.bound(w);
    await w.dispatch(way.install, way.mention());
    await w.idle();
    expect(w.invokes).toEqual([]);
    expect(w.threadWrites).toEqual([]);
    expect(w.channels.row(way.installId, SUPPORT)).toBeUndefined();
    expect(infoCalls(w).map((c) => [c.token, c.args])).toEqual([[way.token, { channel: SUPPORT }]]);
    expect(methods(w.slack.calls)).toEqual(['usersInfo', 'conversationsInfo', 'postEphemeral']);
    expect(ephemerals(w.slack.calls)).toEqual([{ channel: SUPPORT, user: ALICE, text: COPY.channelNoLongerAllowed }]);
    expect(w.slack.calls.find((c) => c.method === 'postEphemeral')!.token).toBe(way.token);
    expect(w.slack.reactions).toEqual([]);
    expect(w.lines).toEqual([
      { level: 'info', msg: 'slack_channel_disconnected', fields: { installId: way.installId, reason: 'channel-not-allowed', code } },
      { level: 'info', msg: 'slack_turns_dropped', fields: { installId: way.installId, reason: 'channel-not-allowed', count: 1, code } },
    ]);
    const all = JSON.stringify(w.lines);
    for (const leak of ['@', 'usr_', 'agt_', 'U07', 'C07', 'support', 'Support']) expect(all, leak).not.toContain(leak);
  },
);

// B: it.each(WAYS) "%s: an outsider's turn there never runs either": world({ channelInfo: () => missing_scope });
//    way.bound(w); dispatch way.mention({ user: BOB }) → invokes [], binding gone,
//    ephemerals [{ channel: SUPPORT, user: BOB, text: COPY.channelNoLongerAllowed }].

// C: it.each(WAYS) "%s: two turns waiting in a channel that turned private: one line, one disconnect, no turn"
//    missing_scope; way.bound(w); dispatch way.mention({ user: ALICE }) and way.mention({ user: BOB, ts: '1763035301.000301' }); idle →
//    expect(w.invokes).toEqual([]);
//    expect(ephemerals(w.slack.calls).filter((a) => a['text'] === COPY.channelNoLongerAllowed)).toHaveLength(1);
//    expect(w.lines.filter((l) => l.msg === 'slack_channel_disconnected')).toHaveLength(1);
//    expect(w.lines.filter((l) => l.msg === 'slack_turns_dropped')).toHaveLength(2);   // reason may be 'disconnected' for the loser
//    then const before = w.slack.calls.length; dispatch way.mention({ ts: '1763035302.000302' }); idle →
//    expect(w.invokes).toEqual([]); expect(ephemerals(w.slack.calls.slice(before))).toEqual(way.next);

// D: it.each(WAYS) "%s: bound while public, then made private: turns go on for at most CHANNEL_CHECK_TTL_MS, then stop" (the walk's sequence)
//    let answer: SlackChannel | Error = slackChannel(SUPPORT, 'support'); let t = Date.parse('2026-11-21T12:00:00Z');
//    const w = world({ channelInfo: () => answer, now: () => t }); way.live(w);  // the bot binds at its first mention, as on the walk
//    mention → invokes 1; const asked = infoCalls(w).length;                    // shared 1, bot 2 (bind + turn)
//    answer = new SlackApiError('conversations.info', 'missing_scope'); t += CHANNEL_CHECK_TTL_MS - 1;
//    mention ts '1763035301.000301' → invokes 2, infoCalls(w) still `asked`     // the accepted window
//    t += 1; mention ts '1763035302.000302' → invokes 2, binding gone,
//    ephemerals [{ channel: SUPPORT, user: ALICE, text: COPY.channelNoLongerAllowed }].

// E: it.each([
//      ['rate limited', new SlackApiError('conversations.info', 'ratelimited'), 'ratelimited'],
//      ['its token refused', new SlackApiError('conversations.info', 'token_revoked'), 'token_revoked'],
//      ['an unreadable answer', new SlackApiError('conversations.info', 'bad-response'), 'bad-response'],
//      ['a network failure', new Error('socket hang up'), 'unknown'],
//      ['an answer about another channel', slackChannel(OPS, 'ops'), 'id-mismatch'],
//    ]) "when Slack can't say (%s), no turn runs, the binding stays, the sender is told to try again, and nothing is kept"
//    shared app, let answer = failure → invokes [], threadWrites [], binding still there,
//    ephemerals [{ channel: SUPPORT, user: ALICE, text: COPY.turnFailed }],
//    lines exactly [{ level: 'error', msg: 'slack_event_failed', fields: { installId: INSTALL_ID, stage: 'channel-check', code } }];
//    then answer = slackChannel(SUPPORT, 'support'); mention ts '1763035301.000301' → invokes 1, infoCalls 2.

// F: "a binding the store can't remove: no turn, and the sender is told to try again"
//    world({ channelInfo: () => missing_scope, removeFails: true }); shared mention → invokes [], binding still there,
//    ephemerals [turnFailed], lines exactly [{ level: 'error', msg: 'slack_event_failed',
//    fields: { installId: INSTALL_ID, stage: 'channel-remove', code: 'store-unavailable' } }].

// G: "a team agent's own bot binds the channel again once it is public, with the switch the team set"
//    answer public, t fixed; w.putInstall(OWN_BOT);
//    await w.channels.store.setRemember(INSTALL_ID, SUPPORT, SUPPORT_AGENT.id, false);   // kept switch: off
//    await w.channels.store.remove(INSTALL_ID, SUPPORT, SUPPORT_AGENT.id);              // only the kept switch says so now
//    botMention → binding remember false; answer = missing_scope; t += CHANNEL_CHECK_TTL_MS;
//    botMention ts '…301' → binding gone, expect(w.channels.kept(SUPPORT_AGENT.id, SUPPORT)).toBe(false);
//    answer public; botMention ts '…302' → binding remember false, invokes 2.
```

- [ ] **Step 3: Run them on today's router and confirm they fail** (Bug Fix Policy evidence)

Run: `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/router.test.ts -t "no longer allows"`
Expected: FAIL in every new test, because the turn runs (`w.invokes` isn't empty) and the binding stays. The suite's other tests still PASS, since the router ignores the extra dep. Copy the failing test names into the PR body.

- [ ] **Step 4: Add the line to `copy.ts`, right after `channelUnavailable`**

```ts
  /*
    A connected channel Slack no longer allows (TASK-1184): made private,
    archived or shared with another company since it was connected (or since
    a team agent's own bot first answered there). Checked when each turn
    starts. The turn that finds it disconnects the channel and says this once,
    to its sender. Archived and deleted channels take no line at all, so it
    names the two cases someone can read it in. It names nothing else.
  */
  channelNoLongerAllowed:
    "I've stopped answering in this channel: it's private now, or shared with another organization. " +
    'I only answer in public channels of this workspace.',
```

In `copy.test.ts`: add `'channelNoLongerAllowed',` after `'channelUnavailable',` in the key list (`:120`), add it to `PRIVATE` (`:397`), and add this test after `:420`:

```ts
it('a channel Slack no longer allows: says it stopped and why, and names nothing', () => {
  expect(COPY.channelNoLongerAllowed).toMatch(/stopped answering/);
  expect(COPY.channelNoLongerAllowed).toMatch(/private/);
  expect(COPY.channelNoLongerAllowed).toMatch(/another organization/);
  expect(COPY.channelNoLongerAllowed).toMatch(/public channels/);
  expect(new Set([COPY.channelNoLongerAllowed, COPY.channelUnavailable, COPY.channelNotConnected]).size).toBe(3);
});
```

- [ ] **Step 5: Put the check in `router.ts`**

`RouterDeps`: `channels` becomes `Pick<ChannelStore, 'get' | 'recordThread' | 'bindBot' | 'remove'>`, and its doc gains "…and removed when Slack says its channel can't be served any more (TASK-1184)". Add:

```ts
  /**
   * Slack's word that a connected channel is still public, live and not Slack
   * Connect, asked when each channel turn starts and kept for a minute
   * (channel-check.ts, TASK-1184).
   */
  channelCheck: ChannelCheck;
```

In `job`, after the requester block (`:610`) and before the `// 9. The memory switch` comment (`:611`):

```ts
    // 8b. The channel itself, as Slack describes it now (TASK-1184): […why, as the header says].
    const channel = await d.channelCheck.check(installId, botToken, m.channel);
    if (channel.kind === 'unknown') {
      log('error', 'slack_event_failed', { stage: 'channel-check', code: channel.code });
      await tell(COPY.turnFailed);
      return;
    }
    if (channel.kind === 'refused') {
      let removed: boolean;
      try {
        removed = await d.channels.remove(installId, m.channel, agentId);
      } catch (err) {
        await failed('channel-remove', err);
        return;
      }
      if (removed) log('info', 'slack_channel_disconnected', { reason: 'channel-not-allowed', code: channel.code });
      log('info', 'slack_turns_dropped', { reason: 'channel-not-allowed', count: 1, code: channel.code });
      // Only the turn whose remove took the binding says so: once, however many were waiting.
      if (removed) await tell(COPY.channelNoLongerAllowed);
      return;
    }
```

Header: step 8 (`:71-84`) gains, at its end: *last, Slack itself is asked about the channel with the install's token (channel-check.ts, at most once a minute per channel). A channel it now says is private, archived or Slack Connect, or can't find, loses its binding as a team admin's Disconnect would take it (the memory switch kept for the agent and channel stays). The one turn whose removal took it tells its sender, privately and once (`channelNoLongerAllowed`); every turn it stops is dropped (`slack_turns_dropped`, `channel-not-allowed`). Slack not answering is no turn either: "try again", and the binding stays.* The bot section (`:107-114`) gains *…and asked again when each turn starts, as on the shared app (step 8)* after the `connectable` sentence.

- [ ] **Step 6: Wire it in `plugin.ts`**

Import `createChannelCheck` from `./channel-check.js`, and add `CHANNEL_CHECK_MAX` and `CHANNEL_CHECK_TTL_MS` to the `./limits.js` import. In `createEventRouter({...})` (`:500-507`), after `externalQueue,`:

```ts
                channelCheck: createChannelCheck({ api, now, ttlMs: CHANNEL_CHECK_TTL_MS, max: CHANNEL_CHECK_MAX }),
```

- [ ] **Step 7: Update the existing tests the check changes**

`router.test.ts`, where a turn now asks Slack once (no seeding, by decision):
- `:2750-2751`: "Slack is asked about the channel with the bot's own token twice: to bind it, then when its turn starts (TASK-1184)." → `toEqual([[OWN_BOT_TOKEN, { channel: SUPPORT }], [OWN_BOT_TOKEN, { channel: SUPPORT }]])`.
- `:2788-2792`: "A second mention there reads the binding, and the turn's check is still fresh: Slack isn't asked again." → `expect(infoCalls(w)).toHaveLength(2)`.
- `:3237`: "Only the shared app's own turn checks, with its own token: nothing is asked with the bot's." → `expect(infoCalls(w).map((c) => [c.token, c.args])).toEqual([[BOT_TOKEN, { channel: SUPPORT }], [BOT_TOKEN, { channel: OPS }]])`.

`plugin.test.ts`: `fakeSlackFetch` (`:278-334`) answers `conversations.info`. For `body['channel'] === SUPPORT_CH` it returns the channel object now in `botChannelSlackFetch` (`:406-415`, every flag set as Slack sets them); any other channel gets `{ ok: false, error: 'channel_not_found' }`. Its doc comment names this, and says why (TASK-1184: every channel turn asks). Delete `botChannelSlackFetch` (`:396-422`), and its five callers (`:3221`, `:3271`, `:3336`, `:3365`, `:3488`) use `disconnectSlackFetch()`. Without this, each shared-app channel turn there gets `bad-response`, fails closed, and the tests built on `:1458`, `:2687` and `:3057` time out.

- [ ] **Step 8: Run the package and confirm everything passes**

Run:
```bash
pnpm --filter @ax/channel-slack exec vitest run src/__tests__/router.test.ts src/__tests__/copy.test.ts src/__tests__/channel-check.test.ts
DOCKER_HOST=<your socket> pnpm --filter @ax/channel-slack test
pnpm --filter @ax/channel-slack build
pnpm exec eslint packages/channel-slack
```
Expected: all PASS. That includes plugin.test.ts, which needs Postgres. If Docker is missing, plugin.test.ts can't run, so the step isn't done.

- [ ] **Step 9: Run the dependents** (lesson from TASK-1093: a package-only gate missed the preset-k8s composition)

Run: `DOCKER_HOST=<your socket> pnpm -r --no-bail --filter "...@ax/channel-slack" run test`
Expected: PASS, preset-k8s `channel-slack-composition.test.ts` included. Its fake answers `conversations.info` for `SUPPORT_CHANNEL` as a live public channel (`:380-396`), so its turns pass the check.

- [ ] **Step 10: Commit**

```bash
git add packages/channel-slack/src/router.ts packages/channel-slack/src/copy.ts packages/channel-slack/src/plugin.ts packages/channel-slack/src/__tests__/router.test.ts packages/channel-slack/src/__tests__/copy.test.ts packages/channel-slack/src/__tests__/plugin.test.ts
git commit -m "[TASK-1184] channel-slack: a turn in a channel Slack no longer allows never runs; the channel is disconnected and its sender told once" -- packages/channel-slack/src/router.ts packages/channel-slack/src/copy.ts packages/channel-slack/src/plugin.ts packages/channel-slack/src/__tests__/router.test.ts packages/channel-slack/src/__tests__/copy.test.ts packages/channel-slack/src/__tests__/plugin.test.ts
```

---

### Task 3: the design's channel rule, its known gaps, and the prose in channels.ts [tier: mechanical]

The rule 5 stale lines. On `main`, each says or implies that a channel is checked only when it is connected.

**Files:**
- Modify: `docs/plans/2026-11-09-channel-slack-design.md:392-394`, `:550-552`, and a new block before `## 7. Spike results` (`:1239`)
- Modify: `packages/channel-slack/src/channels.ts:25-30`, `:431-434` (comments only)

**Interfaces:** none. Prose only, matching what Tasks 1 and 2 built.

- [ ] **Step 1: The design doc**
  - `:392-394` ("**The channel:** public only. … refused. The bot joins the channel itself, after those checks pass."): append *Slack is asked again when each turn starts, and its answer is trusted for a minute (TASK-1184). A connected channel that has since become private, archived or Slack Connect is disconnected, as a team admin's Disconnect would do it. The person whose turn found it is told once, privately, and no turn runs. If Slack can't answer, no turn runs either.*
  - `:550-552` (a bot's binding "after the channel check (public, live, not Slack Connect)"): append *…and checked again when each turn starts, as on the shared app (§3, TASK-1184).*
  - Before `## 7.`: a **"Known gaps, accepted (TASK-1184):"** list. Write it from the residuals row of `.claude/memory/decisions/2026-11-21-TASK-1184.md`: the one-minute window, and a turn already running finishes; a continuation after an Allow isn't checked again; memory may learn from window turns until the binding goes; a spurious `channel_not_found` disconnects (a reconnect starts with memory on; a bot re-binds with the team's switch); a bot's removal leaves the agent's shared binding, which settings may list as waiting for an `/invite`; the name isn't refreshed; Slack's conversion, archive and share events aren't subscribed.

- [ ] **Step 2: `channels.ts`**
  - `:25-30`: after "…a refused or failed step binds nothing.", add *A channel can change after that, so the router asks Slack again when each turn starts (channel-check.ts, TASK-1184).*
  - `:431-434` (`connectable`): "Also what a team agent's own bot binds at its first mention in a channel (router.ts, TASK-1167), and what every channel turn is checked against before it runs (channel-check.ts, TASK-1184), so none of them can disagree."

- [ ] **Step 3: Verify, then commit**

Run: `git diff --stat` (only the two files) and `pnpm --filter @ax/channel-slack build` (comments only, but this catches a stray `*/`).

```bash
git commit -m "[TASK-1184] docs: a connected channel is checked again when each turn starts; known gaps" -- docs/plans/2026-11-09-channel-slack-design.md packages/channel-slack/src/channels.ts
```

---

## PR notes (for the builder's PR body)

- **Bug Fix Policy:** name Task 2 Step 3's failing tests, run on today's router. Every new router test fails there because the turn runs.
- **Security review:** run `security-checklist` for Tasks 1 and 2. The pre-answered note is the "Security note" row of the decisions shard. In short: no new reach (one existing method on the existing single-destination client, the dependency narrowed to `Pick<SlackApi, 'conversationsInfo'>`). The untrusted answer is narrowed fail-closed, and nothing of it reaches the model or a log. The only destructive write is the Disconnect primitive, on a definitive refusal. The privacy gap is closed, with the residuals stated. Availability now depends on Slack answering once a minute per channel, and fails closed.
- **No boundary review:** no hook, IPC, manifest, route, migration, scope or event change.
- **Before the PR:** `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts` (with `DOCKER_HOST` set), plus `pnpm lint`.
- **For the next Slack walk** (follow-up, not this PR): convert a bound channel to private on each bot, then mention. Expect one private line, no turn, the channel gone from the agent's Slack settings, and `slack_channel_disconnected reason:channel-not-allowed code:missing_scope`. Convert it back and check that the bot re-binds with the team's switch.
  - **Record Slack's raw `needed` and `provided`** (added after review round 2). The rule that tells a token's missing scope from a channel's (`channel-check.ts` `channelInfoFailure`) reads `provided` first and falls back to `needed`, and nobody has measured either. Ask `conversations.info` directly, outside AX, with the bot's own token, and keep both fields of each answer: `curl -s https://slack.com/api/conversations.info -H "Authorization: Bearer $BOT_TOKEN" --data-urlencode "channel=$CHANNEL_ID"`. Do it twice: (1) for the channel while it is private, with a token that holds `channels:read`; (2) for a public channel, with a token that doesn't (an app reinstalled without `channels:read`). Expected, if the rule is right: (1) a `provided` that includes `channels:read`; (2) one that doesn't. Don't paste the token into the report.
