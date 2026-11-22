# TASK-1208: a website Allow lasts for the agent; web confirmation; runner test fakes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a Slack Allow on a blocked website keeps the site on the agent's own allowed sites (so later sessions reach it), the web app confirms a host Allow, and the claude-sdk runner's test fakes answer the TASK-1199 drain.

**Architecture:** no new hook, no new store. Slack's host answer (`packages/channel-slack/src/permission-prompts.ts` `createHostAnswer`) keeps calling `proxy:add-host` for the live session, then calls the existing `host-grants:grant` (owned by `@ax/host-grants`, the one per-(person, agent) allowed-sites list that Settings › Allowed sites, the web's "Always for this agent", and the orchestrator's session-open load already use). channel-web's `grantHost` starts reading the `{ added }` the route already returns, and `GrantRow` shows the app toast as the row leaves. `main.test.ts` fakes answer `proxy.drain-allowed-hosts` with `{ hosts: [] }`.

**Tech Stack:** TypeScript, React, vitest, pnpm workspace. No new dependencies.

**Spec:** card TASK-1208 plus Vinay's DECIDED block (2026-11-22): "a website (host) Allow outlives the session. Simplest form: per agent. Allow adds the host to the agent's own egress allowlist (the same one an owner edits), so every later session of that agent can reach it. Change the copy from 'Allowed for now. Ask me again and I'll try it.' to say it's allowed from now on. Keep who may click Allow unchanged. The owner can still see and remove the host wherever the agent's allowed hosts are shown. Keep TASK-1199's 'now allowed' line for the live session. Run the security-checklist skill." Decisions: `.claude/memory/decisions/2026-11-22-TASK-1208.md`.

**Tasks:** 6 (3 mechanical, 2 integration, 1 sensitive). Order: 1 → 2; 3, 4 and 5 are independent of each other and of 1–2; 6 last.

## Premise check (verified in code at 4d65f31f9)

- **Holds:** a Slack host Allow is session-only today. `createHostAnswer` (`permission-prompts.ts:142-177`) calls only `proxy:add-host`, and the doc comment says so (`:28-33`). `COPY.hostAllowed` is "Allowed for now. Ask me again and I'll try it." (`copy.ts:158`).
- **Holds:** the web shows no confirmation. `grantHost` (`channel-web/src/lib/credentials.ts:306-318`) returns `Promise<void>` and never reads the body, and `GrantRow.allow` (`GrantRow.tsx:346-358`) drops the row. The route already answers `{ added }` (`routes-allow-host.ts:159-161`), and `added: false` (session ended) is also dropped silently.
- **Holds:** 48 inline fakes in `agent-claude-sdk-runner/src/__tests__/main.test.ts` end in ``throw new Error(`unexpected call: ${action}`)`` and don't answer the drain, so every turn takes the logged failure path (`run-runner.ts:1087-1091`). The aisdk fakes already answer it (`parity.e2e.test.ts:336-337`, `interrupt.e2e.test.ts:255-256`). No change there.
- **Refined, not blocking.** "The agent's own egress allowlist (the same one an owner edits)" is `@ax/host-grants`. Its key is per person and agent: `host_grants_v1_grants` PK is `(owner_user_id, agent_id, host)`, and the orchestrator loads `host-grants:list({ ownerUserId: ctx.userId, agentId })` at every session open (`chat-orchestrator/src/orchestrator.ts:4543-4562`). There is no agent-wide list. Production `@ax/agents` persists no `allowedHosts` (`orchestrator.ts:4010-4016`, `:4206-4209`: only the CLI dev stub has one). The JIT design defines host grants as per `(user, agent)` (`2026-05-26-just-in-time-capabilities-design.md:253`, decision 12 at `:346`), and TASK-1199's follow-up framed the question as "per agent (like the web's 'Always for this agent' through `host-grants:grant`)". So "per agent" means that list. For a personal agent that is every later session of the agent. For a team agent it covers the sessions of the person who clicked, plus outsider turns when that person is the bot's requester (outsider turns run as the requester: `channel-slack/src/router.ts:85-107`). A team-mate's own turn is still asked. An agent-wide list would be a new scope and a wider capability, so it goes to follow-up 1, not into this card.
- **What made the card true:** the Slack design (`2026-11-09-channel-slack-design.md:1301-1309`: "never saved … stays a web-app choice … 'Allowed for now'"), TASK-1095's copy decision (row (b) in `.claude/memory/decisions/2026-11-14-TASK-1095.md:72`), TASK-1199's "NOT decided" row, and the copy test that pins "for now" (`channel-slack/src/__tests__/copy.test.ts:254-264`). All are corrected by Tasks 1 and 5, or superseded in the decisions shard (memory rows are append-only).

## Global Constraints

- **No new hooks and no hook signature changes.** Slack calls the existing `host-grants:grant` with `{ ownerUserId, agentId, host }`. `host-grants:*` and `proxy:add-host` stay host-internal and are never IPC actions.
- **Who may click is unchanged.** Do not edit `channel-slack/src/answers.ts` (the click gate) or the prompt-offering rules in `turn.ts`.
- **The remember key comes from the gate's ctx** (`ctx.userId`, `ctx.agentId` = the prompt's user and agent, which gate steps 6–7 re-prove). Never from the click payload, and never the `agentId` that `proxy:add-host` returns.
- **Live first, then remember.** A proxy refusal (`forbidden`, `invalid-host`), an unreadable proxy answer, a missing `proxy:add-host`, Deny, or a host that fails `HOST_RE` remembers nothing.
- **Exact copy.** Slack (straight apostrophes, as `copy.ts` uses):
  - ``hostSubject: (host: string) => `Wants to connect to ${host}. Once allowed, it stays allowed.` ``
  - `hostAllowed: "Allowed from now on. Ask me again and I'll try it."`
  - `hostAllowedForNow: "Allowed for now. Ask me again and I'll try it."` (the old line, now the keep-failed fallback)
  - `hostEnded` and `hostDenied` are unchanged.
  - Web (curly ’, as `grant-copy.ts` uses): `HOST_ALLOWED_TITLE = 'Site allowed'`, `HOST_ALLOWED_DETAIL = 'Ask your assistant again and it’ll try.'`, `HOST_ENDED_TITLE = 'Nothing changed'`, `HOST_ENDED_DETAIL = 'Your assistant had already finished working on that. If it needs the site again, it’ll ask.'`
- **Slack degradation string** (identical in `plugin.ts`, `plugin.test.ts` and `preset.test.ts`): `'a website allowed from Slack is let through for the live session only, not kept for the agent'`.
- **Logs.** `slack_prompt_failed` keeps exactly `{ installId, kind, stage, code }`. The new stage is `'remember'`. Never log the host, session, user, agent or a token.
- **The web keeps both of its choices** ("Just this once", "Always for this agent"), and its route is unchanged. The toast carries fixed copy only, never the host (model-chosen text).
- **Invariant #6:** no new UI components. Reuse the app toast (`toastActions.show`, `components/Toast.tsx`, already used for `grantResumedTitle`). Invoke the `shadcn` skill before touching `GrantRow.tsx`; the expected outcome is no new primitive.
- **Stay off sibling cards' ground.** TASK-1209 owns `packages/memory/**`. TASK-1203 edits `answers.ts`, `turn-note.ts`, `router.ts`, `channel-store.ts`, `capture-veto.ts` and `migrations.ts` in channel-slack, and the Slack design at `:383`, `:431` and `:1100-1160`. Edit the Slack design only in §1 (append item 10), the §5 host bullet (`:1298-1311`), and the TASK-1095 PR B known-gaps list (`:1557`). In the manifest pins, insert the new entry right after `proxy:add-host` (TASK-1203 changes the `teams:list-for-user` entry a few lines up).
- Run package tests as `pnpm --filter @ax/<pkg> test`, with the filter before the script. The composition test needs Docker: set `DOCKER_HOST` (see CLAUDE.md "Docker-backed tests").

## Review Focus

1. **A late Slack click.** Prompts live a day and the session is reaped after 5 minutes idle. Allow on an ended session must still keep the host and say "Allowed from now on". Pinned by Task 1 `R2`.
2. **A team channel.** Mel allows a site. Ada's turns, and an outsider's turn (which runs as Ada), must not get Mel's grant. The grant is filed under Mel and the channel's agent, never the proxy's `agentId`. Pinned by Task 1 `R4` and Task 2 `C1`/`C2`.
3. **The list can't take it.** At the 256 cap, or with an answer that can't be read, the line must not claim "from now on". On a transient failure the prompt must stay answerable, and a second click must not add twice or produce a second "now allowed" line. Pinned by Task 1 `R5`–`R9`. Idempotence comes from `proxy:add-host`, which records only new hosts (TASK-1199 `A2`/`A3`), and from `host-grants:grant` (`created: false`).
4. **Refusals and forgeries remember nothing:** a bystander, a non-owner session, an invalid host, an unreadable proxy answer, Deny. Pinned by Task 1 `R10`, plus the gate's existing tests.
5. **The web's other outcomes.** A session that had already ended says "Nothing changed". A 200 the client can't read shows no toast. A failed POST keeps the row and shows no toast. Pinned by Task 3 `W3`–`W5`.

---

## Design

### Approaches

| Option | Verdict |
|---|---|
| **Slack's host answer also calls the existing `host-grants:grant`** (chosen) | One owner of the list (`@ax/host-grants`), already loaded at session open, already shown and revocable in Settings › Allowed sites and on the agent's "Granted by you" (`routes-workspace.ts:6657-6710`, `routes-connections.ts:404-570`). The web's "Always for this agent" does the same (`routes-allow-host.ts:139-157`). No hook surface changes. |
| A new agent-wide list (every member's sessions) | A new scope in host-grants, new rules for who may add or revoke for a whole team, and a wider capability: one member's click would widen egress for every member and every outsider turn. Not "simplest form". Follow-up 1. |
| A new orchestrator hook `egress:allow-host` that does both steps | Moves two existing calls behind a new hook with one caller per channel. It needs a boundary review and buys nothing. |
| `proxy:add-host` persists by calling host-grants itself | Couples the egress proxy to a settings store. The proxy also forgets a session once it ends, so a late click could not be kept. |
| Keep only when the live add succeeds (the web route's rule) | Its rule exists because the browser is no trusted source of `agentId`. Slack's prompt is host-side, and the gate re-proves the asker's reach to the agent, so a late click can still be kept. That matches "Allow adds the host to the agent's own egress allowlist". |
| Web: in-row sentence plus "Got it" (GrantRow's `stalled` pattern) | Local state is lost when the row unmounts (tab hidden, route change), so the question would reappear. It also costs an extra click for good news. The toast is the existing grant-outcome pattern (`WorkspaceShell.tsx:749-757`). |
| Web: say "from now on" after "Always for this agent" | The route keeps the grant on a best-effort basis and silently (`routes-allow-host.ts:144-157`), so the claim could be false. The button the person pressed already says how long. |

### Slack host answer, outcomes (Task 1)

| `proxy:add-host` | `host-grants:grant` | Line | Log (`slack_prompt_failed`) |
|---|---|---|---|
| throws `forbidden` / `invalid-host` | not called | `promptClosed` | `add-host` / code |
| throws anything else | not called | thrown to the gate ("try again") | — |
| answer without a boolean `added` | not called | `promptClosed` | `add-host` / `bad-response` |
| `added: true` or `false` | answers `{ created: boolean }` | `hostAllowed` | — |
| `added: true` / `false` | not on the bus | `hostAllowedForNow` / `hostEnded` | — |
| `added: true` / `false` | throws `grant-limit` / `invalid-host` / `missing-field`, or an answer without a boolean `created` | `hostAllowedForNow` / `hostEnded` | `remember` / code or `bad-response` |
| `added: true` / `false` | throws anything else | thrown to the gate ("try again"; both calls are idempotent) | — |

Both calls use `callJoined`. Past the bus's deadline a call fails only once its handler has settled, so a retry never races a write that is still running.

### Boundary review

Not required, because no hook is added and no signature changes (CLAUDE.md: internal-only patches need none). For the PR description: `@ax/channel-slack` gains an `optionalCalls` edge to the existing `host-grants:grant`. Its payload `{ ownerUserId, agentId, host }` carries no backend vocabulary. There is no subscriber and no wire surface. The edge creates no cycle (host-grants calls only `database:get-instance`) and orders host-grants' init before channel-slack's.

### Security (pre-stated; Task 1 runs `security-checklist` and the PR carries the note)

- **Capability (deliberately widened).** A site a person allows in Slack becomes reachable in every later session of that agent run as them. That includes outsider turns where they are the bot's requester, which was already true of their web "Always" and Settings grants. The widening is bounded:
  - The host is exact-match and lowercase: `HOST_RE` is byte-identical in the proxy, Slack and host-grants (`credential-proxy/src/plugin.ts:62`, `permission-prompts.ts:120`, `host-grants/src/host-validate.ts:8`). There are no wildcards, ports or schemes.
  - The proxy's private-IP SSRF block still applies whatever the allowlist says (`credential-proxy/src/listener.ts:658`, `:1281`).
  - A granted host never receives a credential: host grants widen the session allowlist, never a credential binding (TASK-687, `orchestrator.ts:4612-4622`).
  - The list is capped at 256 per (person, agent), and every query is keyed by person and agent.
  - It is revocable in Settings and on the agent's rail.
  - It is written only after a person's click that the gate re-proves. The runner can't reach `host-grants:grant`, because it is not an IPC action.
  - There is no filesystem, process or env reach.
- **Untrusted content.** The host is model-chosen. It passes `HOST_RE` before it is shown and again before acting. It is drawn only as `plain_text`, and is never logged or put in a toast. The prompt now says before the click that the Allow lasts. A forged "System message … ALLOWED" in a chat grants nothing.
- **Supply chain:** no new dependencies.
- **Residuals (accepted; follow-ups 1–3):** the per-person scope in team channels; outsider turns inheriting the requester's grants (pre-existing); the web "Always" on an ended session keeping nothing (pre-existing; it now says "Nothing changed").

### Exact-list pins and stale lines this card must change

- Manifest pins: `channel-slack/src/__tests__/plugin.test.ts:801-830` and `presets/k8s/src/__tests__/preset.test.ts:1338-1377`. The producer check at `:1387-1391` passes, because the k8s preset loads `@ax/host-grants`.
- COPY key list and lines: `channel-slack/src/__tests__/copy.test.ts:110-112`, `:200-202`, `:254-264`.
- Literal subject pins: `copy.test.ts:255`, `permission-prompts.test.ts:245`. (`prompt-post.test.ts:203` and `prompts.test.ts:231` pass a literal in as input; leave them.)
- Stale prose that now lies:
  - `permission-prompts.ts:11-47`
  - `copy.ts:146-155`
  - `channel-slack/src/plugin.ts:190-195`
  - `prompts.ts:77`
  - `permission-prompts.test.ts:22-30`
  - `plugin.test.ts:818`
  - `preset.test.ts:1359`
  - the composition header `:55-70` and stub comment `:216-221`
  - `presets/k8s/src/index.ts:1131-1140`, which names only channel-web as a writer and carries a stale TASK-42 "half-wired window OPEN" note
  - the Slack design `:1298-1311`
  - JIT design `:105`
  - `.changeset/slack-permission-buttons.md:5`
  - `.changeset/egress-allowed-hosts-line.md:11`
  - `GrantRow.tsx:22-31`

---

### Task 1: Slack's Allow keeps the host for the asker's agent `[tier: sensitive]` (security-checklist)

**Files:**
- Modify: `packages/channel-slack/src/permission-prompts.ts`. Change the doc comment `:11-47`, add constants after `ADD_HOST` (`:124`), and change `createHostAnswer` (`:142-177`).
- Modify: `packages/channel-slack/src/copy.ts:146-160`: the comment, `hostSubject`, `hostAllowed`, and the new `hostAllowedForNow` right after it.
- Modify: `packages/channel-slack/src/plugin.ts`: the header comment `:190-195`, and the `optionalCalls` entry after `proxy:add-host` (`:316-318`).
- Modify: `packages/channel-slack/src/prompts.ts:77` (comment only).
- Test: `packages/channel-slack/src/__tests__/permission-prompts.test.ts`, `copy.test.ts`, `plugin.test.ts`, `answers.test.ts` (`hostWorld`, `:1859-1885`).

**Interfaces:**
- Produces:
  - `export const REMEMBER_HOST = 'host-grants:grant';`
  - a module-private `const REMEMBER_REFUSALS: ReadonlySet<string> = new Set(['grant-limit', 'invalid-host', 'missing-field']);`
  - `COPY.hostAllowedForNow`
  - the manifest `optionalCalls` entry `{ hook: 'host-grants:grant', degradation: <the Global Constraints string> }`
- `createHostAnswer(d: { bus: HookBus }): SubjectAnswer` keeps its signature. Behavior follows the outcomes table above.
- The private `failed` helper becomes `failed(stage: 'add-host' | 'remember', code: string)`.
- Consumes: `host-grants:grant` `(ctx, { ownerUserId: string; agentId: string; host: string }) → { created: boolean }`, which throws PluginError `grant-limit` / `invalid-host` / `missing-field`.

- [ ] **Step 1: Extend the test harness.** In `permission-prompts.test.ts`, change `world(proxy, grants: GrantOptions | 'absent' = {})`. `GrantOptions` is `{ answer?: () => unknown; timeoutMs?: number; until?: Promise<void> }`. By default it registers `host-grants:grant` as `'fake-host-grants'`. The fake records `{ ctx, input }` into `w.remembered`, keeps a `Set` of `owner|agent|host`, and answers `{ created: !had }`. Also add a shared `w.order: string[]` that both fakes push to (`'add-host'`, `'remember'`).
- [ ] **Step 2: Write the failing tests** in `describe('createHostAnswer: …')`. `MEL_KEY` is `{ ownerUserId: 'usr_mel', agentId: 'agt_mel', host: HOST }`.
  - `R1` (replaces the `:258` case): Allow → `{ line: COPY.hostAllowed, settle: true }`. `w.calls[0].input` equals `{ sessionId: SESSION, host: HOST }`. `w.remembered.map((r) => r.input)` equals `[MEL_KEY]`, its ctx has `userId 'usr_mel'` and `agentId 'agt_mel'`. `w.order` equals `['add-host', 'remember']`. `w.allowlist` equals `new Set([HOST])`. `w.lines` equals `[]`.
  - `R2` (replaces `:276`): `world({ ended: true })` → `COPY.hostAllowed`. `w.allowlist.size` is `0`, `w.remembered` inputs equal `[MEL_KEY]`, no logs.
  - `R3`: grants `answer: () => ({ created: false })` → `COPY.hostAllowed`.
  - `R4`: proxy `answer: () => ({ added: true, agentId: 'agt_other' })` → remembered `agentId` is `'agt_mel'`.
  - `R5`: `world({}, 'absent')` → `COPY.hostAllowedForNow`. `world({ ended: true }, 'absent')` → `COPY.hostEnded`. No logs.
  - `R6`: for each of `grant-limit`, `invalid-host` and `missing-field` (grants `answer` throws `new PluginError({ code, plugin: 'fake-host-grants', message: 'x' })`): live → `hostAllowedForNow`, ended → `hostEnded`. Each logs `[{ installId: INSTALL_ID, kind: 'host', stage: 'remember', code }]`.
  - `R7`: for each of `[undefined, null, [], {}, { created: 'yes' }]` as the grant's answer: live → `hostAllowedForNow`, logged `stage: 'remember', code: 'bad-response'`.
  - `R8`: grants throw PluginError `store-unavailable` → `rejects.toBe(err)`. `w.calls` and `w.remembered` each have length 1.
  - `R9`: copy the `:317` deadline test with grants `{ timeoutMs: 1_000, until }`. Nothing settles before `until.release()`, then the result is a PluginError with code `'timeout'`.
  - `R10`: `w.remembered` stays `[]` for owner `usr_ada` (forbidden), a proxy `invalid-host` throw, a proxy `store-unavailable` throw, a proxy answer of `null`, `world('absent')`, Deny, and host `'<!channel>'`.
  - Update `:395` ("every answer is one of its COPY lines"): add an `outs` entry from `world({}, 'absent')`, and add `COPY.hostAllowedForNow` to the expected set.
  - Update `:420` ("logs name …"): add a `grant-limit` world. Expect 4 lines, each keyed exactly `['code','installId','kind','stage']`, with no leak of `HOST`, `SESSION`, `usr_mel`, `agt_mel`, `conv_mel_dm`, `BOT_TOKEN` or the prompt id.
  - `hostSubject` (`:243-247`): the literal becomes `'Wants to connect to api.example.com. Once allowed, it stays allowed.'`, and add `expect(COPY.hostSubject(LONGEST).length).toBeLessThanOrEqual(PROMPT_SUBJECT_MAX)`.
  - `copy.test.ts`:
    - add `'hostAllowedForNow'` after `'hostAllowed'` in the key list (`:110`), and `['hostAllowedForNow', COPY.hostAllowedForNow]` in `PROMPT_LINES` (`:200`)
    - rewrite `:254-264` as "a host prompt: its subject says the Allow lasts, Allow says from now on, the fallback says for now, and nothing links anywhere"
    - assert the subject literal above, `COPY.hostAllowed` toBe the exact line, and `COPY.hostAllowedForNow` toBe the exact line
    - `not.toMatch(/\bchat\b/i)` for `hostAllowed`, `hostAllowedForNow` and `hostEnded`
    - the existing no-link/Today check over all five host lines
  - `plugin.test.ts`:
    - manifest pin: after the `proxy:add-host` entry (`:820`), add `// A website allowed from Slack is kept on the agent's allowed sites for the asker (TASK-1208).` and the entry
    - the host e2e at `~:1225`: register a fake `host-grants:grant` next to the fake proxy (`:1246`) that records `{ userId: ctx.userId, input }`, and assert it was called once with `{ ownerUserId: 'usr_alice', agentId: <that test's agent id>, host: 'api.example.com' }`
    - rename the test to "…lets it through for the live session and keeps it for the asker's agent…"
  - `answers.test.ts` `hostWorld`: register a fake `host-grants:grant` answering `{ created: true }` in `services`. Its expectations of `COPY.hostAllowed` stay.
- [ ] **Step 3: Run and see them fail.** Run `pnpm --filter @ax/channel-slack test -- permission-prompts copy plugin answers`. Expected: FAIL (no `hostAllowedForNow`, no remember call, the subject literal differs, the manifest pin differs).
- [ ] **Step 4: Implement.**
  - Constants, `failed(stage, code)`, the outcomes table, and the copy.
  - The remember input is exactly `{ ownerUserId: ctx.userId, agentId: ctx.agentId, host: subject.host }`.
  - Rewrite the doc comments listed in Files to say what Allow does now: live session plus "now allowed" line (TASK-1199), then kept for the asker on that agent's allowed sites, even after the session has ended; the subject says so before the click.
  - The `copy.ts` comment drops "'Always' stays a web choice" and "for now, never this chat". It keeps the "never 'chat'" rule.
- [ ] **Step 5: Run and see them pass.** Run `pnpm --filter @ax/channel-slack test`. Expected: PASS.
- [ ] **Step 6: Security note.** Run the `security-checklist` skill against this diff, starting from the Design › Security section. Save the note in your task scratch dir for the PR.
- [ ] **Step 7: Commit.** Message: `[TASK-1208] channel-slack: a website Allow keeps the site for the asker's agent`.

### Task 2: the preset proves it end to end with the real `@ax/host-grants` `[tier: integration]`

**Files:**
- Modify: `presets/k8s/src/__tests__/preset.test.ts:1359-1361`. After the `proxy:add-host` entry, add the new `optionalCalls` entry with the comment `// A website allowed in Slack is kept on the agent's allowed sites for the asker (TASK-1208); its producer is @ax/host-grants.` Update the `:1359` comment, which says "for the live session only".
- Modify: `presets/k8s/src/__tests__/channel-slack-composition.test.ts`:
  - add `'@ax/host-grants'` to `KEEP` (`:73-84`)
  - change the header (`:55-70`) and the stub comment (`:216-221`): Allow's keep step runs against the real store
  - change the host test (`:1504-1560`)
- Modify: `presets/k8s/src/index.ts:1131-1140` (comment only). Writers: channel-web's allow-host route ("Always for this agent") and its Settings "Add a site", plus channel-slack's host prompt Allow (TASK-1208). It is revoked from Settings › Allowed sites and the agent's "Granted by you". Drop the stale TASK-42 half-wired note.

**Interfaces:**
- Consumes: Task 1's manifest entry and behavior. Real `host-grants:list` `(ctx, { ownerUserId, agentId }) → { hosts: Array<{ host: string; grantedAt: string }> }`.

- [ ] **Step 1: Write the failing assertions** in the host test, renamed "…Allow lets it through and keeps it for her on the agent; an outsider's turn gets none (TASK-1095, TASK-1208)":
  - The `chat.update` text is `"Allowed from now on. Ask me again and I'll try it."`.
  - The prompt blocks contain `'Once allowed, it stays allowed.'`.
  - `C1`: after Mel's Allow, `theBus!.call('host-grants:list', makeAgentContext({ sessionId: 'test', agentId: '', userId: 'usr_mel' }), { ownerUserId: 'usr_mel', agentId })` lists exactly `['api.example.com']`. The same call for `usr_ada` lists `[]`.
  - `C2`: after Carol's outsider turn (which runs as Ada and gets no prompt), Ada's list is still `[]` and Mel's is unchanged.
  - The existing `addHostCalls` assertions stay.
- [ ] **Step 2: Run and see them fail.** Run `pnpm --filter @ax/preset-k8s test` with `DOCKER_HOST` set. Expected: FAIL at the `KEEP` check or the list assertions until both edits land. The manifest pin fails until the `preset.test.ts` entry is added.
- [ ] **Step 3: Make the edits above.**
- [ ] **Step 4: Run and see them pass.** Run the same command. Expected: PASS. If local Docker can't run the composition, say so in the handoff; never skip it silently.
- [ ] **Step 5: Commit.** Message: `[TASK-1208] preset-k8s: a Slack Allow lands in the real allowed-sites store, for the asker only`.

### Task 3: the web confirms a host Allow `[tier: integration]`

**Files:**
- Modify: `packages/channel-web/src/lib/credentials.ts:306-318` (`grantHost`).
- Modify: `packages/channel-web/src/lib/grant-copy.ts`: add the four constants after `HOST_ALLOWING_LABEL` (`:165`), with a doc line. They are said as the row leaves, the way a resumed skill grant is (`grantResumedTitle`). They carry no duration, because the button already said it.
- Modify: `packages/channel-web/src/components/workspace/GrantRow.tsx`: `allow()` (`:346-358`) and the header comment (`:22-31`). A host Allow also goes, and says so in a toast.
- Test: `packages/channel-web/src/components/workspace/__tests__/GrantRow.test.tsx`, in `describe('a host grant')` (`:313`) and the host case at `:488`.

**Interfaces:**
- Produces:
  - `grantHost(input: { sessionId: string; host: string; persist?: boolean }): Promise<boolean | null>`. It returns `true` when the session took it (`added: true`), `false` when the session had already ended (`added: false`), and `null` for a 200 whose JSON has no boolean `added` (read with `res.json()` and a catch → `null`). A non-2xx response still throws `HttpError`.
  - `HOST_ALLOWED_TITLE`, `HOST_ALLOWED_DETAIL`, `HOST_ENDED_TITLE`, `HOST_ENDED_DETAIL` (exact text in Global Constraints).
- `allow()`: `true` → `toastActions.show({ title: HOST_ALLOWED_TITLE, detail: HOST_ALLOWED_DETAIL })`. `false` → `toastActions.show({ title: HOST_ENDED_TITLE, detail: HOST_ENDED_DETAIL })`. `null` → no toast. In every case it then calls `resolveAndReturnFocus()`, the existing focus path. The failure path is unchanged.

- [ ] **Step 1: Invoke the `shadcn` skill** (invariant #6). Confirm the app toast is the surface and no primitive is needed.
- [ ] **Step 2: Write the failing tests.** `const show = vi.spyOn(toastActions, 'show')`. Add `toastActions.reset()` to the `afterEach`. Add `hostFetch(added: unknown)`, which mocks fetch with a 200 whose body is `{ added }`.
  - `W1` "'Just this once' on a live session: the row goes, and a toast says the site is allowed and to ask again". `hostFetch(true)`. After `onResolved('host:example.org')`, `show` was called once with `{ title: HOST_ALLOWED_TITLE, detail: HOST_ALLOWED_DETAIL }`.
  - `W2` "'Always for this agent' says the same". `hostFetch(true)`. The body contains `"persist":true`, and the same single toast is shown.
  - `W3` "a session that had already ended: the row goes, and the toast says nothing changed". `hostFetch(false)` → `{ title: HOST_ENDED_TITLE, detail: HOST_ENDED_DETAIL }`.
  - `W4` "an answer it can't read: the row goes with no toast". `okFetch()` (`{ ok: true }`) → `onResolved` called, `show` not called.
  - `W5` in `:488` ("when the POST fails", host): `expect(show).not.toHaveBeenCalled()`.
  - In `W1`–`W3`, `JSON.stringify(show.mock.calls)` does not contain `'example.org'`.
- [ ] **Step 3: Run and see them fail.** Run `pnpm --filter @ax/channel-web test -- GrantRow`. Expected: `W1`–`W3` FAIL (no toast).
- [ ] **Step 4: Implement** as in Interfaces.
- [ ] **Step 5: Run and see them pass.** Run `pnpm --filter @ax/channel-web test -- GrantRow WorkspaceGrantResume consent-focus TodayView`, then `pnpm --filter @ax/channel-web test`. Expected: PASS. `WorkspaceGrantResume.test.tsx:326` still passes, because its `{ ok: true }` body gives `null`, so no toast.
- [ ] **Step 6: Commit.** Message: `[TASK-1208] channel-web: say so when a website is allowed`.

### Task 4: claude-sdk `main.test.ts` fakes answer the drain `[tier: mechanical]`

**Files:**
- Test: `packages/agent-claude-sdk-runner/src/__tests__/main.test.ts`.

**Interfaces:**
- Consumes: the action `'proxy.drain-allowed-hosts'` → `{ hosts: string[] }`, and the line from `buildEgressAllowedNote` (TASK-1199).

- [ ] **Step 1: Write the failing tests.**
  - In the happy path (`:455-560`), spy `process.stderr.write` with `mockImplementation(() => true)` and restore it at the end, as `:1139-1158` does. Assert no captured write contains `'drain-allowed-hosts'`. Rewrite the comment at `:506-508`: the fake answers `{ hosts: [] }`, so the drain is called once and adds nothing.
  - New test after the happy path, "a host allowed since the last turn reaches the SDK in front of the person's words (TASK-1199, TASK-1208)". Copy the happy path's fake, adding `if (action === 'proxy.drain-allowed-hosts') return { hosts: ['example.com'] };`. Capture the first `SDKUserMessage` as `:4220-4240` does. Expect `(sdkUserMessages[0]!.message as { content: unknown }).content` toBe `` `${NOW_ALLOWED}\n\nplease summarize` ``, where `` NOW_ALLOWED = 'System message (not from the user): network egress is now ALLOWED for: `example.com`. Requests to these hosts are no longer blocked, so you can retry one that was.' ``.
- [ ] **Step 2: Run and see them fail.** Run `pnpm --filter @ax/agent-claude-sdk-runner test -- main`. Expected: the happy-path stderr assertion FAILS (`runner: drain-allowed-hosts failed (continuing): unexpected call: proxy.drain-allowed-hosts`). The new test may already pass, because it answers the drain itself.
- [ ] **Step 3: Answer the drain in every fake.** Before each of the 48 lines ``throw new Error(`unexpected call: ${action}`);``, insert `if (action === 'proxy.drain-allowed-hosts') return { hosts: [] };` at the same indentation (6, 8 or 10 spaces):
  ```bash
  perl -0pi -e 's/^([ \t]*)(throw new Error\(`unexpected call: \$\{action\}`\);)/${1}if (action === '\''proxy.drain-allowed-hosts'\'') return { hosts: [] };\n${1}${2}/mg' packages/agent-claude-sdk-runner/src/__tests__/main.test.ts
  ```
  This inserts 49 lines: the 48 old fakes plus the new test's. The new test answers the drain itself first, so its inserted line is unreachable. Delete that one. Then `grep -c "proxy.drain-allowed-hosts') return { hosts: \[\] }" packages/agent-claude-sdk-runner/src/__tests__/main.test.ts` must print `48`, and `git diff` must show only `+` lines plus the Step 1 edits.
- [ ] **Step 4: Run and see them pass.** Run `pnpm --filter @ax/agent-claude-sdk-runner test`. Expected: PASS.
- [ ] **Step 5: Commit.** Message: `[TASK-1208] claude-sdk runner tests: fakes answer the allowed-hosts drain`.

### Task 5: write the decision into the design, and fix the lines that said otherwise `[tier: mechanical]`

**Files:**
- Modify: `docs/plans/2026-11-09-channel-slack-design.md`, in three places:
  1. **§1, append after item 9 (`:56-57`):** "10. **A website Allow lasts (decided 2026-11-22, Vinay; TASK-1208).** Allow on a blocked website's prompt keeps the site on the agent's own allowed sites (`@ax/host-grants`, the list its people see and remove in Settings › Allowed sites and on the agent's "Granted by you"), so the agent's later sessions can reach it, not just the one that asked. The list is per person and agent (JIT design P1), so on a team agent it covers the sessions of the person who allowed it. Who may answer is unchanged (§5's click gate), and the live session still gets TASK-1199's "now allowed" line."
  2. **§5, replace the host bullet (`:1298-1311`).** Keep its first and last sentences, and say:
     - the subject now ends "Once allowed, it stays allowed."
     - Allow is, in order, `proxy:add-host` (the live session; only its owner; the "now allowed" line at the next turn) and then `host-grants:grant` with the prompt's user, agent and host (the web app's "Always for this agent")
     - the host is kept even when the session has already ended, so the line reads "Allowed from now on"
     - if it can't be kept (no `host-grants:grant`, the list is full, an answer that can't be read), the line says "Allowed for now" while the session lives, or "I'd already finished working on that" once it has ended
     - Deny is unchanged
  3. **Known gaps (TASK-1095, PR B), after the first bullet (`:1559`), add two bullets:**
     - "**A website Allow is kept for the person who clicked it** (TASK-1208). Allowed sites are per person and agent. In a team agent's channel, a team-mate's own turn is still asked, though the thread shows "Allowed from now on". An outsider's turn runs as the bot's requester, so it reaches the sites the requester allowed, as it already did their web "Always" ones."
     - "**The web app's "Always for this agent" keeps nothing once the session has ended.** Its route keeps a site only after the live widen succeeds, while a Slack Allow keeps it anyway. The web says "Nothing changed"."
- Modify: `docs/plans/2026-05-26-just-in-time-capabilities-design.md:105`. Append: " Slack's host prompt has one Allow, and it is this choice (TASK-1208): it widens the live session and keeps the grant."
- Modify: `.changeset/slack-permission-buttons.md:5`. Replace "Allow lets that one website through for now, like the web app's "Just this once". Once the agent has been idle a while, that permission is gone, and nothing is remembered: if you want it allowed for good, that is still a choice in the web app." with "Allow lets that website through, and the agent keeps it from then on, like the web app's "Always for this agent" (you can remove it in Settings)."
- Modify: `.changeset/egress-allowed-hosts-line.md:11`. Replace the paragraph with: "In the web app, "Just this once" still lasts only for that session. A Slack Allow now keeps the site for the agent's later sessions too."

- [ ] **Step 1: Make the edits.** No behavior changes.
- [ ] **Step 2: Check.** Run `git diff --stat` (only these four files) and `pnpm lint`. Expected: PASS. Then run `git grep -n "Allowed for now"`. Expected: only `copy.ts` (`hostAllowedForNow`), its tests, the Slack design's fallback sentence, and dated plan or memory files.
- [ ] **Step 3: Commit.** Message: `[TASK-1208] docs: a website Allow lasts for the agent (Vinay, 2026-11-22)`.

### Task 6: changeset, full gate, PR notes `[tier: mechanical]`

**Files:**
- Create: `.changeset/slack-host-allow-remembered.md` with frontmatter `'@ax/channel-slack': minor` and `'@ax/channel-web': patch`. Body, in the project voice ("we", plain, short):
  - Allowing a website from Slack now sticks. It goes on that agent's allowed sites, the same list in Settings › Allowed sites, where it can be removed.
  - The prompt says so before the click, and the reply says "Allowed from now on".
  - On a team agent it's kept for the person who clicked.
  - The web app now says when a site is allowed, or that nothing changed because the conversation had already moved on.

- [ ] **Step 1: Write the changeset.**
- [ ] **Step 2: Run the full gate:** `pnpm build && pnpm lint && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`. Expected: all pass. A Docker teardown timeout in `@ax/auth-better` with all assertions green is the known local flake. Report it, don't hide it.
- [ ] **Step 3: Write the PR description.** Include:
  - the boundary-review statement (Design › Boundary review)
  - the `security-checklist` note from Task 1 Step 6
  - the premise refinement (per person and agent)
  - the follow-ups below
- [ ] **Step 4: Commit** the changeset together with this plan and the decisions shard.

## Follow-ups (return as cards; do not build here)

1. **PRODUCT (Vinay): on a team agent, should a website Allow apply to every member?** Today it is kept for the person who clicked, on the per-(person, agent) list. Every member would need an agent-wide scope in `@ax/host-grants`, plus rules for who may add and remove it for the team.
2. **Web: keep "Always for this agent" even after the session has ended**, as Slack now does. The route would take the agent from the grant and check it with `agents:resolve`, because the browser is not a trusted source of `agentId`.
3. **Should an outsider's turn load the requester's allowed sites?** That is pre-existing behavior, and this card makes such grants more common.
