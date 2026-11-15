# TASK-1095: Slack approval buttons for attended turns — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In a Slack DM or an attended channel turn, anything the agent needs the person's OK for shows up in the thread as Allow / Deny buttons that only that person can answer; after Allow the agent carries on in the same thread. External turns never get buttons.

**Architecture:** `@ax/channel-slack` gains a signed interactivity route (`POST /slack/interactions/:installId`), an in-memory registry of open prompts (an opaque id rides in each button), Block Kit builders, and one click gate that re-proves the clicker is the turn's own person before it calls an existing hook. PR A covers held calls: `@ax/decisions` starts treating Slack conversations as attended, Allow calls `decisions:approve` with a continuation reqId channel-slack mints, and channel-slack streams the woken agent's continuation back into the thread. PR B covers the two `chat:permission-request` cards the card names: the egress-wall host card (`proxy:add-host`) and the catalog skill card (`agent:apply-capability-grant`, behind the same checks `/api/chat/permission-decision` makes).

**Tech Stack:** TypeScript (exactOptionalPropertyTypes), vitest, Kysely on Postgres (composition test via Testcontainers). No new dependencies, no Slack SDK.

**Spec:** `docs/plans/2026-11-09-channel-slack-design.md` (§2, §3, §5 steps 5–6, §6). Card: TASK-1095. Planner decisions, with the why and the alternatives: `.claude/memory/decisions/2026-11-14-TASK-1095.md`. Stack context: `.claude/memory/decisions/2026-11-13-TASK-1093.md` (rows 13, 24, 34: manifest, origin `'slack'`, measured Slack facts), `.claude/memory/decisions/2026-11-13-TASK-1094.md` (rows 14, 29, 33: the held signal, residuals), `.claude/memory/mistakes/2026-11-13-TASK-1093.md` (fake tokens, invisible characters, fake `agent:invoke` timeouts, zsh arrays, `beforeEach` bodies).

---

## Why this is not quite the card as written (yolo-ship rule 5)

The card says: `chat:permission-request` → Allow/Deny → `agent:apply-capability-grant`, "the way `/api/chat/permission-decision` does (routes-chat.ts:825)". That line was copied from design §5.6 (`docs/plans/2026-11-09-channel-slack-design.md:376-378`), and it is stale in three ways:

1. **In a Slack turn, the approval people actually meet is a HELD CALL, not a permission card.** The k8s preset holds `request_capability` itself (`packages/tool-policy/src/rules.ts:141-152`, `verdict: 'hold'`), so `@ax/decisions` stops it before it runs and no permission card fires in that turn. Held calls are resolved by `decisions:approve` / `decisions:dismiss` (`packages/decisions/src/plugin.ts:622-640, 1034-1077`), never by `agent:apply-capability-grant`, which only attaches a skill.
2. **The design and the code already assign held-call buttons to TASK-1095:** design §5.6 bullets 3–4 (`:381-384`, "until TASK-1095's buttons"), `packages/decisions/src/__tests__/attendance.test.ts:182-192` ("TASK-1095 adds the buttons and must flip this (and this test) on purpose"), `packages/conversations/src/types.ts:128-133`, and `packages/decisions/src/types.ts:4-5` ("three renderers: … later Slack's interactive message").
3. **The cited line moved:** `/api/chat/permission-decision` is `packages/channel-web/src/server/routes-chat.ts:885-1041`, and design §5.5's "the way channel-web does (`plugin.ts:807-857`)" points at buffer-fill subscribers; the per-connection matching is `channel-web/src/server/sse.ts:590-619` (host cards by `payload.reqId`, skill cards by `ctx.conversationId`).

So PR A builds held-call buttons (the common case, and the flip the code waits for), and PR B builds the permission-card buttons the card names (TASK-1094 residual 8: "permission-request cards … aren't shown in Slack until TASK-1095"). The stale lines are fixed in Tasks 11 and 15.

## What exists today (read at `5899fb121`, not run, unless noted)

- **Turns** (`packages/channel-slack/src/turn.ts`): `runTurn` builds the ctx from `turnContextFields(mode)` (`dm` → `user`/`private`, `attended` → `user`/`shared`, `external` → `external`/`shared`, `:63-76`), registers a reqId sink with the turn registry before `agent:invoke` (`:305-311`), and on a `tool-result` chunk with `held: true` calls `stream.held(approver)` (`:286-292`, `approver = source === 'user' ? 'sender' : 'owner'`, `:206`). `reply-stream.ts` `finish()` writes the closing lines (`:594-630`): `COPY.heldForSender(todayLink)` / `COPY.heldForOwner`. The turn ends right after a hold (both runners; `decisions/src/templates.ts:546-548`).
- **Turn registry** (`turn-registry.ts`): subscribes `chat:stream-chunk`, `chat:turn-end`, `chat:turn-error` only (`:24`); chunks matched by `payload.reqId`; turn-end by ctx conversation + payload reqId (absent → every sink in the conversation, a "dark" turn).
- **Ingress** (`ingress.ts`): `verifySignedRequest(d, req, res, {pathPrefix, maxBodyBytes, logPrefix})` → `{install, nowMs} | null` (body cap 413, install id spelled in the raw path, install, signing secret → one 404; v0 signature → 401). `admittedHandler(lifetime, handle)` answers 503 after `stopAdmission`. The `/ax` route (`commands.ts`) is the form-encoded pattern to copy, including its app/status/team ignore checks (`:302-317`).
- **Slack client** (`slack-api.ts`): 16 methods, one destination `https://slack.com/api/<method>`; `postMessage` sends `markdown_text` and returns nothing (`:541-554`). No `chat.update`.
- **Manifest** (`manifest.ts`): 9 scopes, 2 events, `/ax`; "no interactivity" (`:6`); `slackUrls()` has `eventsUrl`, `redirectUrl`, `commandsUrl`.
- **Decisions** (from an Explore pass, file:line in `.claude/memory/decisions/2026-11-14-TASK-1095.md`): `attendanceFor` (`attendance.ts:119-128`) → `unattended` for an outsider turn, else `origin === 'web'` → attended; `conversationChannel` coerces any other origin, `'slack'` included, to `'routine'` (`:95`). A hold writes the row with `ownerUserId: ctx.userId` and fires `decisions:raised` only for a NEW row (`pre-call.ts:351-400`). Nothing waits on a button: the turn ends at the hold, and an attended approval (live session) hands a `decision-resolved` entry to the warm runner after the 10 s undo window (`machine.ts:58`, `plugin.ts:797-947`); the runner starts a new turn under the caller's `continuationReqId` and re-issues the call. Warm sessions are reaped after 5 min idle + 10 s (`chat-orchestrator/src/orchestrator.ts:2150-2211`). `decisions:approve` needs `ctx.userId === input.userId` and reads the row owner-scoped; `decisions:dismiss` trusts `input.userId` (no ctx check); neither calls `agents:resolve` (the web route does, `channel-web/src/server/routes-workspace.ts:5825-5861`). `decisions:recent-for-conversation` needs `ctx.userId === input.userId && ctx.agentId === input.agentId` (`plugin.ts:492-501`). No event fires when a decision is resolved. Statuses: `pending | executed | approved-pending-agent | dismissed | stale | expired | failed` (`types.ts:98-106`). Late approvals of a connector call held in an ATTENDED conversation park as `approved-pending-agent` (`host-executor.ts:158`, TASK-1046 F1): the agent's next identical call cashes the yes.
- **Permission cards** (Explore pass): two fire sites, both `bus.fire`. Skill card from `request_capability` (`skill-broker/src/tools/request-capability.ts:316`): `{kind:'skill', skillId, description, hosts, slots:[{slot, kind:'api-key', account?, service?, slotTag?, haveExisting?}], packages}`, no reqId; the firing ctx (IPC listener, `ipc-server/src/listener.ts:197-210`) carries the session's `conversationId`, `userId`, `agentId`. Host card from the egress wall (`chat-orchestrator/src/orchestrator.ts:2019-2053`): `{kind:'host', host, sessionId, reqId}`, reqId = the turn's `agent:invoke` reqId, only while an `agent:invoke` waiter is open (so never in a continuation). `host` is whatever the sandbox tried to reach (checked only non-empty at fire time). `agent:apply-capability-grant` (`orchestrator.ts:4911-4961`, input `{conversationId, userId, agentId, skillId}` → `{attached}`) checks NOTHING itself; the web route checks `conversations:get {conversationId, userId}` and `agents:resolve` first (`routes-chat.ts:934-960`). `proxy:add-host` (`credential-proxy/src/plugin.ts:920-960`) validates `HOST_RE`, answers `{added:false}` for a closed session, throws `forbidden` unless `ctx.userId` owns the session.
- **Composition test** (`presets/k8s/src/__tests__/channel-slack-composition.test.ts`): KEEPs database, storage, credentials, agents, teams, conversations, decisions, tool-policy, channel-slack (`:58-69`); stubs auth, `http:register-route`, `agent:invoke`; fake Slack behind `fetchImpl`. Its held-call test (`:1055-1120`) holds `request_capability` on the real policy and expects the attended reply to link Today (`:1104`). No session plugin and no skill-broker, so an approval there lands as `approved-pending-agent`.
- **Memory canary** (`presets/memory/src/__tests__/canary.test.ts:775-800`) pins that the events and `/ax` routes are mounted. **CLI reset kernel** (`packages/cli/src/commands/admin/reset-bootstrap.ts:150-215`) boots channel-slack without decisions, chat-orchestrator, credential-proxy or conversations, so every new hook channel-slack calls must be an `optionalCalls` entry.

**Slack facts.** Read on docs.slack.dev 2026-11-14 (raw pages in the planner's scratchpad): interaction payloads are POSTed form-encoded with one `payload` parameter holding JSON; ack with HTTP 200 within 3 s; `block_actions` carries `user.id`, `team.id`, `api_app_id`, `container` (`message_ts`, `channel_id`, `is_ephemeral`), `channel.id`, `message`, `actions[{action_id, value, type}]`; `chat.update` (bot `chat:write`, Tier 3) updates the bot's own non-ephemeral messages, `blocks` + `text`, and can't touch ephemeral ones; `markdown_text` can't be combined with `blocks`; `chat.postMessage` takes `blocks` with `text` as the notification fallback (special limit, about 1 message/s per channel); section text ≤ 3000; button text `plain_text` ≤ 75; `action_id` ≤ 255; `value` ≤ 2000; manifest `settings.interactivity: { is_enabled, request_url }` (URL ≤ 3500). **Assumed, not measured (TASK-1097 walk checks):** interactivity needs no OAuth scope; Slack signs `block_actions` with the same v0 signature (Bolt verifies every request; the docs' list names Shortcuts, which share the interactivity URL); a click on our message is delivered only to our app (`api_app_id`); `message.thread_ts` is present for a threaded prompt; `plain_text` doesn't parse `<!channel>`; interaction payloads are not retried. Button `visible_to_user_ids` exists in the docs but is unmeasured and NOT used.

## Delivery: one card, two PRs, both to `main`

- **PR A, Tasks 1–11: held-call buttons.** Reachable alone: an attended Slack turn's held call gets buttons; Allow resumes the agent in the thread.
- **PR B, Tasks 12–15: permission-card buttons.** Branch from PR A; open it against `main` after PR A merges (a PR based on another branch gets no CI). One PR for both is acceptable if the builder runs the review gate after Task 11.
- Review gates (ax-code-reviewer): after Task 11 and after Task 15. **security-checklist is required for both PRs** (new public route, approvals, untrusted text into a shared channel, an egress widen); tasks tagged (security-checklist) feed it.

## Global Constraints

- **No new dependencies. Egress stays `https://slack.com/api/<method>` only.** This card adds `chat.update` to the client. No `response_url`, no `hooks.slack.com`.
- **Scopes and events unchanged** (9 scopes, `app_mention` + `message.im`). The manifest adds `settings.interactivity: { is_enabled: true, request_url: <origin>/slack/interactions/<installId> }`. An existing install reconnects to get it (Disconnect, then Connect); its prompts still carry the Today link.
- **Route:** `POST /slack/interactions/:installId`, `bypassCsrf: true`, `maxBodyBytes: INTERACTIONS_MAX_BODY_BYTES` (65_536), wrapped in `admittedHandler`.
- **Prompts exist only for `dm` and `attended` turns.** `PromptContext.mode` is typed `'dm' | 'attended'`, the registry throws on anything else at runtime, and an outsider who somehow reached the gate would still fail its re-map (an outsider's AX user is never the turn's). External turns keep today's lines (`heldForOwner`) and post no blocks.
- **Who may answer a prompt**, in this order, every check before any action hook: the prompt exists and is open; it was posted for this install and channel; the clicker's signed Slack user id is the prompt's asker; the clicker is admitted again by `users.info` (`admitSender`); their verified email maps (`auth:find-user-by-email`) to the prompt's AX user; that user still reaches the agent (`agentAccess` is `'yes'` or `'not-team'`); for an `attended` prompt, the channel is still connected to that agent (`channels.get`). Never from message text or button labels.
- **One answer per prompt.** `claim` → `settle` or `release` in a `try/finally`; a second click while one is being handled is silent.
- **Copy:** every Slack-facing word lives in `copy.ts` `COPY` (tests use `COPY.*`); `copy.test.ts` pins the exact key list, so each task adds its keys there. No line names the product, none holds `<!`, `<@`, `<#` or a bare broadcast word. Text from outside a COPY line (a decision summary, a host, a skill description) is a prompt **subject**: `cleanPromptSubject()` (Task 2), rendered as `plain_text` only.
- **Logs:** code-only fields (`installId`, `kind`, `action`, `reason`, `stage`, `code`, `outcome`, counts, booleans). Never a Slack user or channel id, a name, an email, a host, a skill id, a decision summary or a token. New lines are named in the task that adds them.
- **Limits** (all in `limits.ts`, one named constant each): `INTERACTIONS_MAX_BODY_BYTES = 65_536`, `PROMPT_ID_BYTES = 16` (base64url, 22 chars), `PROMPT_TTL_MS = 86_400_000`, `PROMPT_MAX = 1_000`, `PROMPT_SUBJECT_MAX = 300`, `DECISION_LOOKUP_TIMEOUT_MS = 5_000`, `CONTINUATION_START_GRACE_MS = 60_000`, and in PR B `PERMISSION_PROMPTS_PER_TURN_MAX = 3`.
- **Single replica.** The prompt registry is in-process, like the turn registry and the event dedupe; the chart's one-host pin keeps that honest. A restart forgets open prompts: a click then gets "this isn't waiting here anymore", and decisions are still in Today.
- **Repo hygiene:** fake Slack tokens keep short digit groups (`fakeBotToken`, `xoxb-1111-2222-…`); grep `xox[bpe]-[0-9]{10,13}-` before committing. No literal invisible or bidi character in any file (build U+200B with `String.fromCharCode(0x200b)`; never type a `\u` escape into a tool, `source-hygiene.test.ts` checks `src/`). `beforeEach` bodies are blocks. A fake long-running service copies the real registration's `timeoutMs`. Under zsh keep test-file lists in arrays. Never bare `kubectl`.
- **Every test fake that builds a whole `SlackApi`** (turn, router, reply-stream, commands, channels, admin-routes and plugin tests) gains the two new methods, as `notHere` where the code under test must not call them. channel-slack's tests are not type-checked (TASK-1124), so a missing method fails only at runtime; `pnpm --filter @ax/channel-slack run build` type-checks `src`.

## Review Focus

These are the cases most likely to bite someone in Slack that no single happy-path test reaches. Each one has its pinning test in the owning task.

1. **A double click** (or two quick clicks) by the asker → exactly one `decisions:approve` and one `chat.update`; the second click is silent. (Task 5.)
2. **A click after a restart or past the TTL** (registry miss) → an ephemeral "isn't waiting here anymore" linking Today, and no hook called. (Task 5.)
3. **The continuation never arrives** (session reaped inside the undo window → host fallback, or a usage-limit veto) → no empty "I didn't have anything to add" message; the follower gives up quietly at the start deadline. (Task 8.)
4. **An install from before this card** (no interactivity URL, so Slack errors on the click) → the prompt itself carries the Today link. (Task 2.)
5. **The channel was disconnected, or the asker lost the agent, between the turn and the click** → no action hook runs; the prompt closes. (Task 5.)

---

## PR A — held-call buttons

### Task 1: Slack surface: interactivity in the manifest, `chat.update` and blocks in the client [tier: mechanical]

**Files:**
- Modify: `packages/channel-slack/src/manifest.ts` (`SlackUrls`, `slackUrls`, `buildAppManifest`, header comment `:1-21`)
- Modify: `packages/channel-slack/src/slack-api.ts` (`SlackApi`, `SlackMethod`, header "sixteen methods")
- Test: `packages/channel-slack/src/__tests__/manifest.test.ts`, `packages/channel-slack/src/__tests__/slack-api.test.ts`

**Interfaces:**
- Produces: `SlackUrls.interactionsUrl: string` (`${origin}/slack/interactions/${encodeURIComponent(installId)}`).
- Produces: `SlackBlock = Readonly<Record<string, unknown>>` (exported from `slack-api.ts`).
- Produces: `SlackApi.postBlocks(botToken, a: { channel: string; threadTs: string; text: string; blocks: readonly SlackBlock[] }): Promise<{ ts: string }>` → `chat.postMessage` JSON `{ channel, thread_ts, text, blocks, unfurl_links: false, unfurl_media: false }`; a missing/invalid `ts` is `bad-response`.
- Produces: `SlackApi.updateMessage(botToken, a: { channel: string; ts: string; text: string; blocks: readonly SlackBlock[] }): Promise<void>` → `chat.update` JSON `{ channel, ts, text, blocks }`.

- [ ] **Step 1: Write the failing tests.** manifest: `buildAppManifest(...).settings.interactivity` equals `{ is_enabled: true, request_url: 'https://ax.example/slack/interactions/<id>' }`; `slackUrls('https://ax.example/', id).interactionsUrl` has no double slash; scopes and events are unchanged (existing pins). slack-api: `postBlocks` POSTs `https://slack.com/api/chat.postMessage` with exactly the JSON keys above and returns `{ ts }`; an answer without `ts` → `SlackApiError` code `bad-response`; `updateMessage` POSTs `chat.update` with exactly `{ channel, ts, text, blocks }`; both send `Authorization: Bearer`, never a token in the body; errors stay code-only (reuse the file's existing error-shape tests by adding the two methods to its method matrix).
- [ ] **Step 2: Run them, expect FAIL.** `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/manifest.test.ts src/__tests__/slack-api.test.ts`
- [ ] **Step 3: Implement.** Add `'chat.update'` to `SlackMethod`. Update the manifest header ("one slash command, and interactivity for approval buttons (TASK-1095)") and the client header method count.
- [ ] **Step 4: Add the two methods to every whole-`SlackApi` test fake** (see Global Constraints) and run the package: `pnpm --filter @ax/channel-slack run build && pnpm --filter @ax/channel-slack test`. Expected: PASS.
- [ ] **Step 5: Commit** (stage paths explicitly).

### Task 2: Prompt blocks, prompt copy and limits [tier: sensitive] (security-checklist)

**Files:**
- Create: `packages/channel-slack/src/blocks.ts`
- Modify: `packages/channel-slack/src/format.ts` (add `cleanPromptSubject`), `packages/channel-slack/src/copy.ts`, `packages/channel-slack/src/limits.ts`
- Test: `packages/channel-slack/src/__tests__/blocks.test.ts` (new), `format.test.ts`, `copy.test.ts`

**Interfaces:**
- Produces (`limits.ts`): every constant in Global Constraints › Limits except `PERMISSION_PROMPTS_PER_TURN_MAX` (PR B).
- Produces (`format.ts`): `cleanPromptSubject(raw: string): string`: the `cleanStatusTitle` recipe (`:143-147`) with `PROMPT_SUBJECT_MAX`: `replaceSurfaceRewriters`, whitespace collapsed, `neutralizeSlackControls`, `clampCodeUnits`, neutralize again, `trimEnd`. Empty when nothing printable is left.
- Produces (`blocks.ts`):
  - `ACTION_ALLOW = 'ax_prompt_allow'`, `ACTION_DENY = 'ax_prompt_deny'`; `type PromptAction = 'allow' | 'deny'`; `actionOf(actionId: string): PromptAction | null` (exact match only).
  - `promptBlocks(i: { subject: string; promptId: string; todayLink: string }): { text: string; blocks: SlackBlock[] }`: a `section` whose text is `{ type: 'plain_text', text: cleanPromptSubject(subject) || COPY.heldAsked, emoji: false }` (Slack refuses an empty section text, so a subject with nothing printable left falls back to the generic line); an `actions` block with two buttons, Allow (`style: 'primary'`) and Deny (no style), both `value: promptId`; a `context` block (mrkdwn) holding `COPY.promptOnlyAsker` and `COPY.promptToday(todayLink)`. `text` (the notification fallback) is `COPY.heldAsked`. No `block_id`s (Slack mints them; a new id per update is what Slack asks for).
  - `outcomeBlocks(i: { subject: string; line: string }): { text: string; blocks: SlackBlock[] }`: the same `section`, then one `context` with `line`; no `actions`. `text` is `line`.
- Produces (`copy.ts`, PR A keys; exact words may be tuned with the `ux-design` skill, the keys may not):
  - `heldAsked: 'I need your OK before I can do part of this.'`
  - `promptAllow: 'Allow'`, `promptDeny: 'Deny'`
  - `promptOnlyAsker: 'Only the person who asked can answer this.'` (prompt context line AND the ephemeral refusal)
  - `promptToday: (todayLink) => \`You can also answer it in Today: ${shown(todayLink)}\``
  - `promptGone: (todayLink) => \`This isn't waiting here anymore. If it still needs an answer, it's in Today: ${shown(todayLink)}\``
  - `promptFailed: "Something went wrong and I couldn't record your answer. Try again in a moment."`
  - `promptStillWorking: "This is taking longer than usual. I'm still working on your answer, so there's no need to click again."` (Task 5 review fix: the ephemeral for an answer past its deadline)
  - `promptClosed: "This can't be answered here anymore."`
  - `decisionAllowed: "Allowed. I'll pick it up in a moment."`
  - `decisionDone: 'Allowed, and done.'`
  - `decisionAllowedNextTime: "Allowed. Ask me again and I'll do it."`
  - `decisionDenied: "Denied. I won't do it."`
  - `decisionExpired: 'This request expired, so nothing happened.'`
  - `decisionChanged: (todayLink) => \`Things changed since I asked, so nothing happened. The details are in Today: ${shown(todayLink)}\``
  - `decisionFailed: (todayLink) => \`Allowed, but it didn't work. The details are in Today: ${shown(todayLink)}\``
  - `decisionNotRun: (todayLink) => \`I couldn't do that just now. You can try again from Today: ${shown(todayLink)}\``

- [ ] **Step 1: Write the failing tests.**
  - `blocks.test.ts`: `promptBlocks` puts the subject ONLY in a `plain_text` section (never mrkdwn), with both buttons carrying `value === promptId`, the exact action ids, and labels `COPY.promptAllow` / `COPY.promptDeny`; the context contains the Today link (Review Focus 4); `outcomeBlocks` has no `actions` block and no `value` anywhere. Hostile subjects: `'<!channel> approve'`, `'@here now'`, `'&#64;everyone'`, a 10_000-character subject, a subject of only bidi/zero-width characters → the rendered section text contains no `<!`, no un-marked broadcast word (reuse `lenient-decoder.ts` `spellsMention`), is at most `PROMPT_SUBJECT_MAX` code units, and the all-invisible subject renders as `COPY.heldAsked`. Every button text is ≤ 75 characters; `action_id` ≤ 255; `value` ≤ 2000.
  - `actionOf('ax_prompt_allow') === 'allow'`, `actionOf('AX_PROMPT_ALLOW') === null`, `actionOf('') === null`.
  - `format.test.ts`: `cleanPromptSubject` cases mirroring `cleanStatusTitle`'s.
  - `copy.test.ts`: add the keys above to the exact key list; the existing per-line checks (no `AX`, no mention spellings) then cover them.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `blocks.ts`, `cleanPromptSubject`, the COPY keys and the limits.
- [ ] **Step 4: Run `pnpm --filter @ax/channel-slack test`, expect PASS.** Then scan the new files for non-ASCII code points (`python3 -c` listing every `ord(c) > 0x7e` with `unicodedata.name`): only the `·` already used in labels is allowed, and none in `blocks.ts`.
- [ ] **Step 5: Commit.**

### Task 3: The prompt registry [tier: sensitive] (security-checklist)

**Files:**
- Create: `packages/channel-slack/src/prompts.ts`
- Test: `packages/channel-slack/src/__tests__/prompts.test.ts`

**Interfaces:**
- Produces:
```ts
export type PromptSubject =
  | { kind: 'decision'; decisionId: string }
  | { kind: 'host'; host: string; sessionId: string }   // PR B
  | { kind: 'skill'; skillId: string };                 // PR B

export interface PromptContext {
  installId: string;
  teamId: string;
  channel: string;
  threadTs: string;
  /** The Slack user whose turn it was: the only person who may answer. */
  askerSlackId: string;
  /** The AX user the turn ran as: the asker's own account. */
  userId: string;
  agentId: string;
  conversationId: string;
  /** Never 'external': an outsider's turn has no prompts. */
  mode: 'dm' | 'attended';
}

export interface Prompt extends PromptContext {
  id: string;
  subject: PromptSubject;
  /** The subject line as shown (already cleaned), so an update can redraw it. */
  subjectText: string;
  messageTs: string | null;
  expiresAt: number;
}

export type Claim =
  | { ok: true; prompt: Prompt }
  | { ok: false; reason: 'gone' | 'busy' }
  // The clicker isn't the asker: no lock taken, nothing to release.
  | { ok: false; reason: 'not-asker'; prompt: Prompt };

export interface PromptRegistry {
  add(c: PromptContext, subject: PromptSubject, subjectText: string): Prompt;
  posted(id: string, messageTs: string): void;
  remove(id: string): void;
  /** Only the prompt's asker can take it; anyone else's click takes no lock (review fix: a bystander can't make the asker's click `busy`). */
  claim(id: string, slackUserId: string): Claim;
  settle(id: string): void;
  release(id: string): void;
  /** True the first time `slackUserId` is refused on this prompt (one ephemeral each). */
  firstRefusal(id: string, slackUserId: string): boolean;
  size(): number;
}
export const PROMPT_ID_RE: RegExp; // /^[A-Za-z0-9_-]{22}$/
export function createPromptRegistry(o: {
  now: () => number;
  randomBytes: (size: number) => Buffer;
  ttlMs: number;
  max: number;
}): PromptRegistry;
```

- [ ] **Step 1: Write the failing tests.** `add` mints a 22-char base64url id from `randomBytes(PROMPT_ID_BYTES)` (a fake `randomBytes` makes it deterministic) and refuses (throws) a context whose `mode` is anything but `'dm' | 'attended'` at runtime (a cast `'external'` must throw: defense in depth for a type the caller could bypass); `claim(id, asker)` on an open prompt → `{ok:true}` and marks it busy; `claim(id, anyoneElse)` → `{ok:false, reason:'not-asker', prompt}` and takes NO lock, so the asker's claim right after it is `ok` (and a non-asker is `not-asker`, never `busy`, while the asker's click is being answered); a second `claim` → `{ok:false, reason:'busy'}`; after `release`, `claim` works again; after `settle`, `claim` → `'gone'`; an unknown id, or one past `expiresAt` (fake clock), → `'gone'` and the expired entry is dropped; `add` beyond `max` evicts the oldest NOT-busy entry first (a busy one is never evicted mid-answer); `firstRefusal(id, u)` is true once per user, false after, and the per-prompt set is bounded (20 users; beyond that it answers false); `posted` records `messageTs`; `size()` counts live entries.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** with one `Map` in insertion order; expiry swept lazily on `add` and `claim`. No timers (nothing to unref, nothing to leak).
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit.**

### Task 4: The interactions route [tier: sensitive] (security-checklist)

**Files:**
- Create: `packages/channel-slack/src/interactions.ts`
- Modify: `packages/channel-slack/src/ingress.ts` (`IngressOptions.logPrefix` gains `'slack_interaction'`; header comment names the third route)
- Test: `packages/channel-slack/src/__tests__/interactions.test.ts`; extend the shared ingress matrix in `commands.test.ts` (`signed(…, route)` at `:363`, the `['rawPath …']` cases at `:577-580`) to include `'interactions'`

**Interfaces:**
- Consumes: `verifySignedRequest`, `admittedHandler` (`ingress.ts`); `actionOf` (Task 2); `PROMPT_ID_RE` (Task 3); `SLACK_ID_RE`, `INTERACTIONS_MAX_BODY_BYTES`.
- Produces:
```ts
export const INTERACTIONS_ROUTE_PATH = '/slack/interactions/:installId';
export interface ButtonClick {
  /** Signed by Slack: who clicked. */
  slackUserId: string;
  channel: string;
  /** The clicked message (`container.message_ts`). */
  messageTs: string;
  /** The message's `thread_ts`, when Slack sent one. */
  threadTs: string | null;
  action: PromptAction;
  promptId: string;
}
export type ClickHandler = (install: InstallRow, click: ButtonClick) => Promise<void>;
export interface InteractionsHandlerDeps {
  store: Pick<InstallStore, 'get'>;
  secrets: Pick<SecretStore, 'get'>;
  lifetime: Lifetime;
  logger: Logger;
  now: () => number;
  onClick: ClickHandler;
}
export function createInteractionsHandler(d: InteractionsHandlerDeps): RouteHandler;
```
- Mounting note: this route is registered in Task 10; until then nothing serves it.
- Order (after ingress steps 0–4): form `application/x-www-form-urlencoded`, UTF-8 (fatal decoder), `payload` exactly once → `JSON.parse` in a `try` → an object; `ssl_check=1` with no payload → 200 empty. Anything else malformed → 400, log `slack_interaction_refused {installId, reason:'malformed'}`. Then: `type !== 'block_actions'` → 200 ignored (`slack_interaction_ignored {installId, reason:'type'}`); `api_app_id !== install.appId` → `'app'`; `install.status !== 'active'` → `'status'`; `team.id !== install.teamId` → `'team'`; `container.type !== 'message'` or `container.is_ephemeral === true` → `'container'`; `actions` not an array of exactly one `type: 'button'` element with a known `action_id` and a `value` matching `PROMPT_ID_RE` → `'action'`. Ids (`user.id`, `channel.id` falling back to `container.channel_id`, `container.message_ts` falling back to `message.ts`, optional `message.thread_ts`) must match `SLACK_ID_RE`, else 400 malformed. Then `res.status(200).end()` FIRST, and only then `void d.lifetime.track(() => d.onClick(install, click)).catch(log code-only 'slack_interaction_failed')`. Never awaits the click.

- [ ] **Step 1: Write the failing tests.** With a real HMAC over the raw body (copy `signatureHeaders` from `commands.test.ts:328-331`): a valid click → 200 empty body, and `onClick` called once with exactly the parsed `ButtonClick` AFTER the response was sent (record ordering); **a forged signature → 401 and `onClick` never called** (card acceptance); a stale timestamp → 401; unknown install / misspelled path → the router's 404; a 65_537-byte body → 413; each `ignored` reason → 200 and no `onClick`; each malformed shape (no `payload`, two `payload`s, bad JSON, JSON array, missing `user.id`, a `user.id` with a space) → 400; `ssl_check=1` → 200; after `lifetime.stopAdmission()` → 503. Make every negative case valid on every other rule (the TASK-1093 mutation lesson). An `onClick` that rejects never changes the 200 and logs `slack_interaction_failed` with a code only.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement**, copying `parseCommandForm`'s decoding approach (no import of `commands.ts` internals beyond what is already exported).
- [ ] **Step 4: Run the package tests, expect PASS.**
- [ ] **Step 5: Commit.**

### Task 5: The click gate [tier: sensitive] (security-checklist)

**Files:**
- Create: `packages/channel-slack/src/answers.ts`
- Test: `packages/channel-slack/src/__tests__/answers.test.ts`

**Interfaces:**
- Consumes: `PromptRegistry` (Task 3); `admitSender`, `isTemporaryLookupFailure`, `findSenderUser` (`admission.ts`); `agentAccess` (`channels.ts`); `outcomeBlocks` (Task 2); `SlackApi.updateMessage`, `postEphemeral`.
- Produces:
```ts
/** What one answer did: the line the prompt now shows, and work that follows it (never awaited by the route). */
export interface Answer {
  line: string;
  /** False when the prompt should stay answerable (a transient failure the asker can retry). */
  settle: boolean;
  follow?: () => void;
}
export type SubjectAnswer = (
  ctx: AgentContext,
  prompt: Prompt,
  action: PromptAction,
  extra: { install: InstallRow; botToken: string },
) => Promise<Answer>;
export interface AnswerDeps {
  bus: HookBus;
  api: SlackApi;
  secrets: Pick<SecretStore, 'get'>;
  prompts: PromptRegistry;
  channels: Pick<ChannelStore, 'get'>;
  publicOrigin: string;
  logger: Logger;
  /** One per subject kind. PR A registers `decision`; PR B adds `host` and `skill`. */
  answers: Partial<Record<PromptSubject['kind'], SubjectAnswer>>;
}
export function createClickHandler(d: AnswerDeps): ClickHandler;
```
- The gate, exactly in this order. Every refusal releases the claim this click took (unless it says settle); `gone`, `busy` and `not-asker` took none, and must NOT release (a release there would drop the asker's own lock), logs `slack_prompt_declined {installId, kind, reason}` (`kind` is absent before step 2), and calls no action hook:
  1. Bot token from `secrets.get(install, 'bot-token')`; missing or throws → log `slack_prompt_failed {installId, stage:'bot-token'}` and stop (nothing can be said without it; no claim was taken).
  2. `claim(click.promptId, click.slackUserId)`: `'gone'` → ephemeral `COPY.promptGone(todayLink)` to the clicker (thread: `click.threadTs` when present), reason `gone`; `'busy'` → silence, reason `busy`. `'not-asker'` took no lock (nothing to release) and carries the prompt: run step 3 on it, then step 4.
  3. `prompt.installId !== install.installId || prompt.channel !== click.channel` → silence, reason `mismatch`.
  4. The registry said `'not-asker'` (the clicker isn't `prompt.askerSlackId`; the registry compares, so a bystander's click never holds the prompt's lock) → ephemeral `COPY.promptOnlyAsker` (only when `firstRefusal` is true), reason `not-asker`. **No users.info, no AX lookup for them.** The gate keeps its own `click.slackUserId !== prompt.askerSlackId` check after an `ok` claim as defense in depth.
  5. `admitSender(api, botToken, click.slackUserId, install.teamId)` not ok → temporary failure: ephemeral `COPY.promptFailed`; otherwise silence; reason `not-admitted`.
  6. `findSenderUser(...)` (throws → `promptFailed`, release) `!== prompt.userId` → ephemeral `COPY.promptOnlyAsker`, reason `not-mapped`.
  7. `agentAccess(bus, ctx, prompt.agentId, prompt.userId)`: `'no' | 'agent-gone'` → settle, update the prompt to `COPY.promptClosed`, reason `no-access`; a throw → `promptFailed`, release.
  8. `prompt.mode === 'attended'`: `channels.get(installId, channel)` is null or names another agent → settle, update to `COPY.promptClosed`, reason `disconnected` (Review Focus 5). A throw → `promptFailed`, release.
  9. `answers[prompt.subject.kind]` absent → settle, `COPY.promptClosed`, reason `unsupported`. Else call it with `ctx = makeAgentContext({ sessionId: 'channel-slack', agentId: prompt.agentId, userId: prompt.userId, conversationId: prompt.conversationId, logger })`. A throw → ephemeral `promptFailed`, release, log `slack_prompt_failed {stage:'answer', code}`. **Past `PROMPT_STEP_TIMEOUT_MS` (Task 5 review fix): NOT released**, because the abandoned answer may still act and a retry would be a second answer (Allow-then-Deny = approve AND dismiss). Log `{stage:'answer', code:'timeout'}`, ephemeral `COPY.promptStillWorking`, and the click ends; the prompt stays taken (every click on it is the silent busy one) until the answer settles, then ends exactly as that answer says (a late throw → `promptFailed` + release, logged `stage:'late-answer'`), after the still-working line. One that never settles is bounded by the registry: a taken prompt is dropped `ttlMs` past its expiry (Task 3).
  10. `api.updateMessage` on `prompt.messageTs ?? click.messageTs` with `outcomeBlocks({ subject: prompt.subjectText, line })` (a failure is logged `slack_prompt_failed {stage:'update'}`, never fatal); `settle` or `release` per `Answer.settle`; log `slack_prompt_answered {installId, kind, action}`; then `answer.follow?.()`, not awaited.
- A `finally` releases a claim THIS click took (an `ok` claim) that nothing settled, never one it didn't take.

- [ ] **Step 1: Write the failing tests** (fake api recording calls, a real `createPromptRegistry`, fake bus with `auth:find-user-by-email` and `agents:resolve`, a recording `answers.decision`). Right person → the answer runs once with the prompt's user and agent, the prompt message is updated with the answer's line and no buttons, the prompt is settled. **Anyone else's click → refused, ephemeral `COPY.promptOnlyAsker` once (a second click by the same person: nothing), no users.info call, the answer never runs** (card acceptance). One test per gate step 1–9 proving that step alone refuses: each case is valid on every other rule (mutation-proof). Double click: two `onClick` calls racing, the answer gated on a deferred promise → the answer runs once, one update, the second click silent (Review Focus 1). A `gone` id → ephemeral `promptGone` and no answer (Review Focus 2). A bystander's click before the asker's, and one during the asker's pending answer → the asker's click still answers exactly once (never `busy`), and the bystander's refusal releases nothing (the asker's second click during the pending answer stays silent). The answer's ctx always carries the prompt's `userId`, `agentId` and `conversationId`, whoever clicked.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.** Mutation check (protocol in yolo-ship): delete each of gate steps 4, 5, 6, 7, 8 in turn; predict which tests fail before each run; every mutant must be killed.
- [ ] **Step 5: Commit.**

### Task 6: decisions: a Slack conversation is attended [tier: sensitive] (security-checklist)

**Files:**
- Modify: `packages/decisions/src/attendance.ts` (`:9-36` header, `:63` type, `:95` narrowing, `:114-128` doc + rule), `packages/decisions/src/types.ts` (`:4-5`, "later Slack's interactive message" → now), `packages/conversations/src/types.ts:128-133` (the TASK-1095 promise)
- Test: `packages/decisions/src/__tests__/attendance.test.ts:182-192` (flipped on purpose)

**Interfaces:**
- Produces: `ConversationLookup.origin: 'web' | 'routine' | 'slack'`; `attendanceFor` → `'attended'` for origin `'web'` or `'slack'` unless `isOutsiderTurn(ctx)`. Keep the outsider check FIRST and the unknown-origin → `'routine'` coercion for everything else.

- [ ] **Step 1: Rewrite the test at `:182-192` as `'a slack conversation is attended: Slack shows approval buttons (TASK-1095)'`:** origin `'slack'` with `source: 'user'` → `'attended'`; with no source → `'attended'`; add `'an external turn in a slack conversation is unattended'` (`source: 'external'` → `'unattended'`) and `'an unknown source in a slack conversation is unattended'`. Keep `'carrier-pigeon'` → `'unattended'` (`:169-180`) and routine → `'unattended'` untouched.
- [ ] **Step 2: Run, expect FAIL** on the flipped assertions: `pnpm --filter @ax/decisions exec vitest run src/__tests__/attendance.test.ts`
- [ ] **Step 3: Implement** the three code lines and rewrite the comments: Slack threads are chats a person answers in (the web card, or Slack's buttons since TASK-1095); the F1 consequence (a connector call held in a Slack thread and approved after the session ended parks for the agent's next identical call, `host-executor.ts:158`) is the same as a web chat's and is intended. conversations' comment: Slack conversations are attended for decisions, outsider turns are not (decisions checks `ctx.source` first).
- [ ] **Step 4: Run all decisions tests, expect PASS:** `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock AX_TESTCONTAINER_START_SLOT_WAIT_MS=600000 pnpm --filter @ax/decisions test`
- [ ] **Step 5: Commit** (decisions + conversations comment together).

### Task 7: A held call in an attended turn posts its prompt [tier: sensitive] (security-checklist)

**Files:**
- Create: `packages/channel-slack/src/decision-prompts.ts` (lookup only; Task 9 adds the answer)
- Create: `packages/channel-slack/src/prompt-post.ts`
- Modify: `packages/channel-slack/src/turn.ts` (held handling, after-finish posting, `TurnDeps.prompts`), `packages/channel-slack/src/reply-stream.ts` (`held(who: 'owner' | 'sender' | 'asked')`, `finish` line), `packages/channel-slack/src/router.ts` (`RouterDeps` carries `prompts` through `TurnDeps`)
- Test: `decision-prompts.test.ts` (new), `prompt-post.test.ts` (new), `turn.test.ts`, `reply-stream.test.ts:893-927`, `router.test.ts` (fixtures gain `prompts`)

**Interfaces:**
- Produces (`decision-prompts.ts`): `findHeldDecision(bus: HookBus, ctx: AgentContext, q: { userId: string; agentId: string; conversationId: string; toolCallId: string }, timeoutMs: number): Promise<{ decisionId: string; summary: string } | null>`. `bus.hasService('decisions:recent-for-conversation')` else null; calls it with `{ userId, agentId, conversationId }` under the turn's ctx; narrows each row with `typeof` (`id`, `status`, `summary`, `call.id`); returns the row with `status === 'pending'` and `call.id === toolCallId`; null on no match, a throw, an unreadable answer or the timeout (log `slack_prompt_failed {stage:'lookup', code}` on throw/timeout). Never rejects. A reused hold (same call already waiting, different `call.id`) is a miss on purpose: its reply keeps the Today link.
- Produces (`prompt-post.ts`): `postPrompt(d: { api: SlackApi; botToken: string; prompts: PromptRegistry; logger: Logger; todayLink: string }, c: PromptContext, subject: PromptSubject, subjectText: string): Promise<boolean>`: `prompts.add` → `promptBlocks` → `api.postBlocks` (retry `ratelimited` up to `REPLY_RATE_LIMIT_RETRIES` after Retry-After, like `reply-stream.ts` `post`) → `prompts.posted(id, ts)` → true. Any other failure → `prompts.remove(id)`, log `slack_reply_failed {installId, stage:'prompt', code}`, false.
- Changes `runTurn`: when `approver === 'sender'`, the first held chunk records `heldCallId` and does NOT call `stream.held` yet. After the turn decides and before `stream.finish`: `found = heldCallId ? await findHeldDecision(..., DECISION_LOOKUP_TIMEOUT_MS) : null`; then `stream.held(found ? 'asked' : 'sender')` when a call was held. After `await stream.finish(outcome)`, and before `runTurn` returns (so the conversation's lane still orders it): if `found`, `postPrompt` with `{kind:'decision', decisionId}` and `found.summary` as the subject; if that returns false, post `COPY.heldForSender(todayLink)` with `api.postMessage` (logged on failure). `external` turns are unchanged: `stream.held('owner')` at chunk time, no lookup, no blocks.
- `reply-stream.ts`: `'asked'` → closing line `COPY.heldAsked`, same position as today's held line.

- [ ] **Step 1: Write the failing tests.** `decision-prompts.test.ts`: match by `call.id`; skips `status !== 'pending'`; skips another call's row; null without the service; null when the call throws or exceeds `timeoutMs` (fake timers); an answer with junk rows doesn't throw. `prompt-post.test.ts`: registry gets the prompt with `messageTs` after success; a failed post leaves `prompts.size() === 0`; a `ratelimited` then ok → one prompt. `turn.test.ts` (DM and attended): a held chunk + a pending decision whose `call.id` matches → the reply ends with `COPY.heldAsked` (not `heldForSender`), then exactly one `postBlocks` in the same thread after the stream stopped, whose button value is a live prompt for that decision, asker = the sender, `userId`/`agentId`/`conversationId` = the turn's; no match → today's `heldForSender` line and no blocks; prompt post fails → `heldForSender` posted as a message. **External turn with a held chunk → `heldForOwner`, `decisions:recent-for-conversation` never called, no `postBlocks`** (card acceptance). `reply-stream.test.ts`: `held('asked')` writes `COPY.heldAsked` once; first hold still decides.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Keep `turnContextFields` the only place mode becomes `source`/`audience`; derive "prompts allowed" from `source === 'user'` (it is exactly `dm | attended`).
- [ ] **Step 4: Run the package tests, expect PASS.** Mutation check: make the external branch post blocks → the external test must fail.
- [ ] **Step 5: Commit.**

### Task 8: Following the agent's continuation into the thread [tier: sensitive] (security-checklist)

**Files:**
- Modify: `packages/channel-slack/src/turn.ts` (extract the shared reply engine; add `followContinuation`)
- Test: `packages/channel-slack/src/__tests__/turn.test.ts`

**Interfaces:**
- Produces:
```ts
export interface ContinuationRequest {
  prompt: Prompt;
  install: InstallRow;
  botToken: string;
  /** The `streamReqId` decisions:approve echoed: the woken runner emits under it. */
  reqId: string;
  /** ISO instant the agent is woken (the undo window's end), or null. */
  pendingUntil: string | null;
}
/** Follow a woken agent's turn into the prompt's thread. Never rejects; not tracked by the lifetime. */
export function followContinuation(d: TurnDeps, c: ContinuationRequest): Promise<void>;
```
- Refactor `runTurn` into one private engine both use (`followReply`), so the chunk handling (text, status, artifact, held → Task 7's prompt, and PR B's permission cards) exists once. `runTurn`'s behaviour and its existing tests stay exactly as they are.
- Continuation specifics: ctx from `turnContextFields(prompt.mode)` with `reqId`, `userId`, `agentId`, `conversationId` from the prompt; target = prompt channel and thread, `recipientUserId: prompt.askerSlackId`, `recipientTeamId: prompt.teamId`; **the sink is registered synchronously, before the function's first `await`** (the click handler calls it with `void`); no `working()` (no message to react to); not queued in the conversation's lane (the sink must exist before `pendingUntil`, and a lane can hold it back). Start deadline = `max(0, Date.parse(pendingUntil) - now) + CONTINUATION_START_GRACE_MS` (pendingUntil null or unparseable → the grace alone). If nothing arrives by then (no chunk, no turn-end, no turn-error): unregister, log `slack_continuation_missed {installId}`, return WITHOUT finishing the reply (no Slack call at all; Review Focus 3). The first chunk arms `TURN_HARD_CAP_MS` (cap → error line + the same `agent:interrupt` the turn sends). A turn-end before anything was said is the same quiet end. Otherwise it ends like a turn (turn-end → complete, turn-error → error), and a call held inside the continuation gets its own prompt (recursion through the shared engine).

- [ ] **Step 1: Write the failing tests:** chunks under the continuation reqId stream into the prompt's thread with the asker as recipient and end at its turn-end; nothing arrives → after the deadline (fake clock) no Slack call was made and the registry has no sink (Review Focus 3); turn-end with no text → no message; a held chunk inside the continuation posts a new prompt; the cap interrupts with `{conversationId, userId}` of the prompt; a chunk for another reqId is ignored; `followContinuation` returns a promise but the sink exists right after the synchronous call. All existing `turn.test.ts` cases pass unchanged.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm --filter @ax/channel-slack test`, expect PASS** (router and reply-stream suites included: they exercise `runTurn`).
- [ ] **Step 5: Commit.**

### Task 9: Answering a held call [tier: sensitive] (security-checklist)

**Files:**
- Modify: `packages/channel-slack/src/decision-prompts.ts` (add the answer)
- Test: `packages/channel-slack/src/__tests__/decision-prompts.test.ts`

**Interfaces:**
- Consumes: `Answer`, `SubjectAnswer` (Task 5); `ContinuationRequest` and `followContinuation` (Task 8), taken as a dependency so this task's tests use a recording fake.
- Produces: `createDecisionAnswer(d: { bus: HookBus; publicOrigin: string; follow: (c: ContinuationRequest) => void }): SubjectAnswer`, and the pure `decisionOutcome(out: unknown, todayLink: string): { line: string; follow: boolean }`.
- Allow: `continuationReqId = makeReqId()`; `bus.call('decisions:approve', ctx, { decisionId, userId: prompt.userId, continuationReqId, requestShownInFull: false })` (no `approvalScope`: once). `requestShownInFull` is false because Slack shows only the host-authored summary, never the recorded call (TASK-1046 F2 fails closed). When `decisionOutcome` says `follow`, `Answer.follow = () => d.follow({ prompt, install, botToken, reqId: streamReqId, pendingUntil })`.
- Deny: `bus.call('decisions:dismiss', ctx, { decisionId, userId: prompt.userId })`. `decisions:dismiss` does no ctx check, so the gate (Task 5) is the only thing standing between a click and this call; never pass any other user id.
- `decisionOutcome` (narrow `out` with `typeof`; a closed local copy of the seven statuses, no import):

| `out` | line | follow |
|---|---|---|
| `decision` null / unreadable | `promptClosed` | no |
| `error` non-null | `decisionNotRun(today)` | no |
| `status 'executed'`, `path 'agent-executes'`, `streamReqId` string | `decisionAllowed` | yes |
| `status 'executed'`, `path 'host-replays'`, `executed: true` | `decisionDone` | no |
| `status 'executed'`, otherwise (deferred replay, no stream) | `decisionAllowed` | no |
| `status 'approved-pending-agent'` | `decisionAllowedNextTime` | no |
| `status 'dismissed'` | `decisionDenied` | no |
| `status 'expired'` | `decisionExpired` | no |
| `status 'stale'` | `decisionChanged(today)` | no |
| `status 'failed'` | `decisionFailed(today)` | no |
| `status 'pending'` or anything else | `decisionNotRun(today)` | no |

  `Answer.settle` is true for every row of the table (the answer landed or can't land here; Today has the rest). A throw from either hook propagates (the gate turns it into `promptFailed` + release). A hook slower than `PROMPT_STEP_TIMEOUT_MS` keeps the prompt taken until it settles (Task 5 review fix), so no retry runs beside it; still read an already-approved or already-dismissed decision as answered, since a release after a late throw opens the prompt to a retry.

- [ ] **Step 1: Write the failing tests:** a table test over `decisionOutcome` (one case per row, plus `streamReqId` present but `path 'host-replays'` → no follow); Allow calls `decisions:approve` with exactly `{decisionId, userId, continuationReqId, requestShownInFull:false}` and a ctx whose `userId` equals `input.userId`, and `follow` receives the returned `streamReqId` and `pendingUntil`; Deny calls `decisions:dismiss` with exactly `{decisionId, userId}`; a dismiss answering an already-executed row → `decisionAllowed`/`decisionDone` per the table, not `decisionDenied`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit.**

### Task 10: Wiring, presets, canary and the composition test [tier: integration]

**Files:**
- Modify: `packages/channel-slack/src/plugin.ts` (route, registry, click handler, manifest `optionalCalls`, header comment `:43-94` and the "TWO routes that bypass CSRF" line), `packages/channel-slack/src/index.ts` (exports, if the canary needs any)
- Modify: `presets/k8s/src/index.ts:1516-1520` (stale "the plugin's one route that skips CSRF": three routes now)
- Modify: `presets/k8s/src/__tests__/preset.test.ts` (channel-slack's new `optionalCalls` producers are loaded; the call graph stays acyclic)
- Modify: `presets/memory/src/__tests__/canary.test.ts:775-800` (the interactions route is mounted: an unknown install gets the route's own 404, same as the events route)
- Modify: `presets/k8s/src/__tests__/channel-slack-composition.test.ts` (held-call test `:1055-1120`, new test, a `click()` helper beside `deliver()`/`command()` at `:421-445`)
- Test: `packages/channel-slack/src/__tests__/plugin.test.ts`

**Interfaces:**
- Consumes everything above. `plugin.ts` creates `createPromptRegistry({ now, randomBytes, ttlMs: PROMPT_TTL_MS, max: PROMPT_MAX })`, passes it to the router (`TurnDeps.prompts`) and to `createClickHandler({ …, answers: { decision: createDecisionAnswer({ bus, publicOrigin, follow: (c) => void followContinuation(turnDeps, c) }) } })`, and mounts `{ method: 'POST', path: INTERACTIONS_ROUTE_PATH, bypassCsrf: true, maxBodyBytes: INTERACTIONS_MAX_BODY_BYTES, handler: createInteractionsHandler({ store, secrets, lifetime: life, logger, now, onClick }) }`.
- Manifest `optionalCalls` (each guarded with `bus.hasService` where called): `decisions:recent-for-conversation`, `decisions:approve`, `decisions:dismiss`, all with degradation `'a call held in a Slack turn links to Today instead of showing Allow and Deny buttons'`. `agents:resolve` and `auth:find-user-by-email` are already hard calls.

- [ ] **Step 1: Write the failing tests.** `plugin.test.ts`: the route is registered with `bypassCsrf: true` and the cap, and is answered 503 after `stopAdmission`. `preset.test.ts`: every hook in channel-slack's `optionalCalls` has a producer in the k8s preset. Memory canary: `/slack/interactions/AAAAAAAAAAAAAAAAAAAAAA` POST → same status, content type and body as the unserved reference. Composition (real decisions over real tool-policy, real conversations; this IS the card's acceptance, end to end): (a) Mel's attended mention holds `request_capability` → the reply ends with `COPY.heldAsked` and a `chat.postMessage` with blocks follows in the thread (replace the `:1104` Today assertion); (b) **Ada clicks Mel's prompt** (signed, Ada's Slack id) → 200, an ephemeral `COPY.promptOnlyAsker` to Ada, Mel's row still `pending`; (c) **Mel clicks Allow** → 200, the row leaves `pending` (`approved-pending-agent` here: no session plugin, no skill-broker), `chat.update` shows `COPY.decisionAllowedNextTime` and no `actions`; (d) **Carol's external turn** → `heldForOwner`, no `chat.postMessage` with blocks, Ada's row `pending`; (e) **a forged signature** on Mel's click → 401 and the row unchanged. Wait for the click's tracked work before asserting (await the route's lifetime drain helper or poll the fake Slack calls with a bound). The test's fake Slack (behind `fetchImpl`) learns `chat.postMessage` with `blocks` (answers a `ts`), `chat.update` and `chat.postEphemeral`; today it answers unknown methods with `unknown_method`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement the wiring.**
- [ ] **Step 4: Run the local gate (below), expect PASS.**
- [ ] **Step 5: Commit.**

### Task 11: Design doc, stale lines and changeset (PR A) [tier: mechanical]

**Files:**
- Modify: `docs/plans/2026-11-09-channel-slack-design.md`
- Create: `.changeset/slack-approval-buttons.md` (`'@ax/channel-slack': minor`, `'@ax/decisions': minor`)

- [ ] **Step 1: Design edits** (each is a stale line this card fixes; verify it is in the diff at review):
  - §3 Scopes `:236-237` "no interactivity until TASK-1095" → the interactivity request URL (`/slack/interactions/<installId>`), no new scope, an existing install reconnects (Disconnect, Connect).
  - §5.5 `:336-338`: channel-slack subscribes to `chat:stream-chunk`, `chat:turn-end`, `chat:turn-error` (no `chat:phase`); permission cards arrive in PR B; the cite is channel-web `sse.ts:590-619`, not `plugin.ts:807-857`.
  - §5.6 `:375-384`, rewrite: held calls in `dm`/attended turns → a prompt in the thread after the reply (the decision's own summary, Allow/Deny, a Today link); only the asker, re-proved (Global Constraints' list), may answer; Allow → `decisions:approve` with a continuation channel-slack follows into the thread; Deny → `decisions:dismiss`; external turns: no buttons, unchanged note; Slack conversations are attended for decisions (TASK-1095); permission cards (`chat:permission-request`) come in PR B of this card, and the skill card goes through `agent:apply-capability-grant` behind the checks `routes-chat.ts:885` makes.
  - §6: one more public route (signed, like the other two); decisions' attendance now covers `'slack'`; still no new hooks. Add the PR A residuals to "Known gaps" (see the decisions shard's residual row).
- [ ] **Step 2: Changeset**, in the project voice: Slack DMs and attended channel threads now show Allow/Deny when the agent needs an OK; only the person who asked can answer; Allow lets the agent carry on in the thread; outsiders' turns still wait for the connector in Today; an existing Slack connection must be disconnected and connected again for the buttons to work; decisions now treat a Slack thread like a web chat.
- [ ] **Step 3: Run `pnpm lint`, expect PASS. Commit.**

**Review gate (PR A):** ax-code-reviewer over the whole branch, with the security-checklist note covering Tasks 2–10.

---

## PR B — permission-card buttons

### Task 12: The turn registry hears permission cards [tier: integration]

**Files:**
- Modify: `packages/channel-slack/src/turn-registry.ts` (`TURN_EVENT_HOOKS` adds `'chat:permission-request'`; `TurnSink.permission?`; `onPermissionRequest`; `subscribeTurnEvents`)
- Test: `packages/channel-slack/src/__tests__/turn-registry.test.ts`

**Interfaces:**
- Produces:
```ts
export type PermissionIn =
  | { kind: 'host'; host: string; sessionId: string }
  | { kind: 'skill'; skillId: string; description: string; needsKey: boolean };
// TurnSink gains: permission?(p: PermissionIn): void;
// TurnRegistry gains: onPermissionRequest(ctx: Pick<AgentContext, 'conversationId'>, payload: unknown): void;
```
- Matching copies channel-web `sse.ts:590-619`: `host` → `payload.reqId` names the sink (the firing ctx's reqId is useless); `skill` → `ctx.conversationId` equals the sink's (every such sink; in practice one). Narrow with `typeof`: `host`/`sessionId` non-empty strings, `skillId` non-empty string, `description` string (absent → `''`), `needsKey` = `slots` is not an array, or any slot is not an object with `haveExisting === true`. Any other `kind`, or a field of the wrong type → dropped. The registry passes the strings through untouched; validating a host is Task 13's.

- [ ] **Step 1: Failing tests:** host routed by payload reqId only (a matching ctx conversation is not enough); skill routed by ctx conversation only; `needsKey` true for a slot without `haveExisting`, a non-object slot, or non-array `slots`, false for `[]` and all-`true`; malformed payloads dropped; a throwing sink doesn't break the bus; `TURN_EVENT_HOOKS` has four hooks in subscribe order.
- [ ] **Step 2–4:** fail, implement, pass.
- [ ] **Step 5: Commit.**

### Task 13: Host cards: allow a host for the live session [tier: sensitive] (security-checklist)

**Files:**
- Create: `packages/channel-slack/src/permission-prompts.ts`
- Modify: `packages/channel-slack/src/turn.ts` (collect `permission` events in the shared engine; post after the reply), `copy.ts`, `limits.ts` (`PERMISSION_PROMPTS_PER_TURN_MAX = 3`), `plugin.ts` (`answers.host`; `optionalCalls` `proxy:add-host`, degradation `'a blocked host in a Slack turn is not offered for approval'`)
- Test: `permission-prompts.test.ts` (new), `turn.test.ts`, `copy.test.ts`

**Interfaces:**
- Produces: `HOST_RE` (a copy of `credential-proxy/src/plugin.ts:62-63`, not an import, with a comment naming its twin); `hostSubject(host: string): string | null` (null unless `HOST_RE` matches; then `COPY.hostSubject(host)`); `createHostAnswer(d: { bus: HookBus }): SubjectAnswer`.
- Collection (shared engine): `dm`/attended only; dedupe by `host:<host>` / `skill:<skillId>`; at most `PERMISSION_PROMPTS_PER_TURN_MAX` per reply, the rest logged as a count (`slack_permission_skipped {installId, reason:'cap', count}`); external → dropped, logged as a count with `reason:'outsider'`. Posted after the reply (and after a held-call prompt) through `postPrompt`.
- Allow → `bus.call('proxy:add-host', ctx, { sessionId, host })` under the prompt's ctx (`userId` = the verified asker; the proxy re-checks session ownership). `{added:true}` → `COPY.hostAllowed`; `{added:false}` → `COPY.hostEnded`; a `PluginError` `forbidden`/`invalid-host` → `COPY.promptClosed`, settle; anything else throws (gate: `promptFailed`, release). Session only: no `host-grants:grant` ("always" stays a web choice). Deny → no hook; `COPY.hostDenied`.
- COPY keys: `hostSubject: (host) => \`Wants to connect to ${host}\``, `hostAllowed: "Allowed for this chat. Ask me again and I'll try it."`, `hostEnded: "That chat already ended, so nothing changed. If I need it again, I'll ask."`, `hostDenied: "Okay. I won't connect to it."`.

- [ ] **Step 1: Failing tests:** an attended turn with a host card for `api.example.com` → after the reply, a prompt whose subject is `COPY.hostSubject('api.example.com')`; a host that fails `HOST_RE` (`'<!channel>'`, `'a b'`, `'EXAMPLE.com'`, 254 characters) → no prompt, logged; two cards for one host → one prompt; four distinct hosts → three prompts and a cap log; **an external turn's host card → no prompt** (card acceptance); Allow → `proxy:add-host` with exactly `{sessionId, host}` and the asker's `userId`; each `proxy:add-host` answer maps to its line; Deny calls nothing.
- [ ] **Step 2–4:** fail, implement, pass. Mutation check: drop the `HOST_RE` gate → the hostile-host test must fail.
- [ ] **Step 5: Commit.**

### Task 14: Skill cards: attach a catalog skill, the way the web route does [tier: sensitive] (security-checklist)

**Files:**
- Modify: `packages/channel-slack/src/permission-prompts.ts`, `turn.ts` (skill cards in the shared engine), `copy.ts`, `plugin.ts` (`answers.skill`; `optionalCalls` `agent:apply-capability-grant` and `conversations:get`, degradation `'a skill request in a Slack turn links to the web app instead of showing buttons'`)
- Test: `permission-prompts.test.ts`, `turn.test.ts`, `copy.test.ts`

**Interfaces:**
- Produces: `skillPromptFor(p: Extract<PermissionIn, {kind:'skill'}>): { kind: 'buttons'; subjectText: string } | { kind: 'web'; subjectText: string }`: `'web'` when `needsKey` (Slack never collects a key) or the grant service is absent; `createSkillAnswer(d: { bus: HookBus; publicOrigin: string }): SubjectAnswer`.
- A `'web'` card posts `linkOnly` blocks (the subject + `COPY.skillNeedsWeb(todayLink)`, no `actions`, nothing registered), so nobody can click anything.
- Allow, in this order, each failure `COPY.skillFailed(today)` + settle unless it throws: `conversations:get { conversationId: prompt.conversationId, userId: prompt.userId }` must answer that conversation with `agentId === prompt.agentId` (the web route's ownership check, `routes-chat.ts:934-939`); `agents:resolve` already passed in the gate; then `agent:apply-capability-grant { conversationId, userId, agentId, skillId }` (it checks nothing itself, so these checks are the only ones) → `COPY.skillAllowed`. Deny → no hook (the web's durable "Not now" marker is channel-web's own storage), `COPY.skillDenied`. The authored-skill path (`agent:apply-authored-capability-grant`) is not called: `request_capability` only fires cards for catalog skills (`request-capability.ts:147-165`).
- COPY keys: `skillSubject: (description) => \`Wants to start using a skill: ${description}\`` (an empty description → `'Wants to start using a skill.'`), `skillAllowed: "Connected. Send your message again and I'll use it."`, `skillDenied: "Okay. I won't use it."`, `skillNeedsWeb: (todayLink) => \`This one needs a key or a closer look first. Finish it in the web app: ${shown(todayLink)}\``, `skillFailed: (todayLink) => \`I couldn't connect it from here. Finish it in the web app: ${shown(todayLink)}\``. Add `linkOnlyBlocks(i: { subject: string; line: string })` to `blocks.ts` (same section, one context line, no `actions`).

- [ ] **Step 1: Failing tests:** a skill card in a continuation (Task 8) → a prompt in the thread; `needsKey` → link-only blocks, nothing registered, no buttons anywhere in the payload; Allow → `conversations:get` then `agent:apply-capability-grant` with exactly `{conversationId, userId, agentId, skillId}` from the prompt (never from the payload or the click); `conversations:get` naming another agent → `skillFailed`, the grant never called; a throw from `conversations:get` → the gate's `promptFailed`; **an external turn's skill card → nothing posted** (card acceptance); Deny calls nothing.
- [ ] **Step 2–4:** fail, implement, pass. Mutation check: drop the ownership read → its test must fail.
- [ ] **Step 5: Commit.**

### Task 15: PR B wiring, composition test, docs and changeset [tier: integration]

**Files:**
- Modify: `presets/k8s/src/__tests__/channel-slack-composition.test.ts`, `presets/k8s/src/__tests__/preset.test.ts` (the three new optional producers are loaded), `docs/plans/2026-11-09-channel-slack-design.md` (§5.5 and §5.6: the permission-card half; §6 residual 8 closed), `packages/channel-slack/src/plugin.ts` header
- Create: `.changeset/slack-permission-buttons.md` (`'@ax/channel-slack': minor`)

- [ ] **Step 1: Composition test:** with a stub `proxy:add-host` and stubs for `agent:apply-capability-grant` (both recording; the real producers need a sandbox), a host card fired with Mel's turn reqId → a prompt; Ada's click refused (stub not called); Mel's Allow → the stub called with the prompt's session and host and Mel's user id; an external turn's host card → no prompt; a skill card fired from inside Mel's invoke script with her turn's ctx (as `request_capability` fires it when it runs; in production that is the continuation after its hold is approved, Task 8) → a prompt after the reply, Mel's Allow → the grant stub called after the real `conversations:get` agreed.
- [ ] **Step 2: Design:** §5.5 now lists `chat:permission-request` (host by reqId, skill by conversation); §5.6 adds the two cards and what each button calls; §6 residuals (the PR B ones from the shard).
- [ ] **Step 3: Changeset** (Slack can now allow a blocked website for the current chat, and connect a skill that needs nothing but a yes; anything that needs a key still goes through the web app).
- [ ] **Step 4: Run the local gate, expect PASS. Commit.**

**Review gate (PR B):** ax-code-reviewer over the whole branch, security-checklist note covering Tasks 12–14.

---

## Local gate (before each review gate and before calling anything green)

```bash
cd /Users/vpulim/dev/ai/ax-next/.claude/worktrees/TASK-1095
export DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock
export AX_TESTCONTAINER_START_SLOT_WAIT_MS=600000
pnpm build
pnpm -r --no-bail --filter "...@ax/channel-slack" --filter "...@ax/decisions" --filter "@ax/conversations" run test
pnpm test:scripts
pnpm test:eslint-rules
pnpm lint
```

`--filter` before `run test`; `--no-bail`, or the first failing package hides the rest. PR B touches only channel-slack and presets, so its gate can drop the decisions and conversations filters.

## Security notes (input for each PR's security-checklist walk)

- **Sandbox escape:** one new public route, authenticated like the other two (install id in the raw path, signing secret, v0 signature, 5-minute window); nothing in the body is read before the signature. One new Slack method (`chat.update`), same destination. New host calls (`decisions:*`, `proxy:add-host`, `agent:apply-capability-grant`, `conversations:get`) are host-internal, none is an IPC action, and each runs only after the click gate. The runner can't reach the route's authority: it has no signing secret, and a prompt id grants nothing without the asker's signed click.
- **Prompt injection:** a prompt's subject is never model text: a decision's host-authored summary (`templates.ts:268`), a host that passed `HOST_RE`, or a catalog skill's description, each cleaned by `cleanPromptSubject` and shown as `plain_text`. The model can't choose what a button does (the value is a host-minted id) or who may answer it. Identity comes from Slack's signed `user.id`, then `users.info` and AX, never from text.
- **Supply chain:** no new dependency.
- **Residuals to state in the PRs:** (1) prompts live in memory: a restart or the 24 h TTL turns a click into "answer it in Today"; (2) a call identical to one already waiting reuses that row and its reply links Today instead (`decisions:raised`/`call.id` can't name it); (3) a Slack hold approved in web Today wakes the agent, but its continuation isn't posted to Slack (only Slack clicks follow one); (4) a connector call approved after the warm session ended parks until the agent's next identical call (F1, now true of Slack threads as of web chats); (5) the agent's reaction to Deny runs without a stream (`decisions:dismiss` takes no continuation id); (6) a host prompt shows the host to everyone in a connected channel; (7) refused clickers each cost one vault read and, once per prompt, one ephemeral; (8) an install from before this card has no interactivity URL until reconnected (its prompts keep the Today link); (9) (updated after commit 0723ea2b1) a standing approval is now spent only by its owner's own turn and never by an outsider's turn; the remaining limit is that one person's yes per agent and call can stand at a time.
