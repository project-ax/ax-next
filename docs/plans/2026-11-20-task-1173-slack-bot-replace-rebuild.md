# TASK-1173 Slack phase 2: replace a team bot's token, rebuild a bot whose approver left, claim a bot whose requester left — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A team bot's approver can replace their dead configuration token (from the agent's settings, or from Admin › Slack); a bot whose approver has left shows as needing a rebuild on both surfaces, and a team admin can rebuild it (Disconnect, then the request form prefilled with the old name); a team admin can claim a live bot whose requester is no longer a team admin; Cancel names the pending bot by its install id; Admin › Slack's Rename and Replace stop leaving vault tombstones after a reset race.

**Architecture:** TASK-1128's Replace core (rotate the PASTED token, check it with `apps.manifest.update`, only then store it as the app's person's) moves out of `admin-routes.ts` into one shared step, `AppSteps.replaceConfigToken` in `slack-apps.ts`; Admin › Slack's Replace uses it unchanged, and `bot-changes.ts` gains `replaceToken` / `replaceTokenForAdmin` (approver only) and `claim` (one-statement `InstallStore.claimBot`). `bots.ts` adds two read-only status fields (`approverGone`, `viewerIsApprover`), keys Cancel by install id, and marks each Admin › Slack row the viewer approved. Three new HTTP routes; Rebuild is client-side (TASK-1172's Disconnect, then the existing request form). channel-web adds a shared token dialog and the Rebuild/Claim dialogs.

**Tech Stack:** TypeScript, vitest (+ Testcontainers Postgres for `store.test.ts`), React + shadcn (channel-web). No new dependency, hook, IPC action, Slack method, table or column.

**Spec:** `docs/plans/2026-11-09-channel-slack-design.md` §3 "Replacing the token", §4 "Lifecycle", the 2026-11-19/20 decisions and the As-built notes, §8 Q5–Q6. Card TASK-1173 (decisions 1–6 and the 2026-11-20 update override its body). **Decisions: `.claude/memory/decisions/2026-11-20-TASK-1173.md` — read it first; every choice below has a row there, and you append your security-checklist rows to it.**

---

## Brainstorm, self-answered

- **What and why.** Design §4 Lifecycle: "Only the approver can manage the bot … When it dies, the fix is Replace with a new token from the same approver … If the approver is gone … the bot can only be rebuilt". Decision update 2026-11-20: an outsider's turn runs as the bot's requester, and when they're no longer a team admin "the bot shows 'needs a team admin to claim it', and a team admin can claim it" (TASK-1167 shipped the state, not the action).
- **Replace, under one token per person.** The bot's token IS its approver's per-person token (TASK-1175), so a Replace fixes every app of theirs. Nothing needs extending for that: `saveRotatedToken` already writes `configTokenRef(app.connectedByUserId)`.
- **Approaches for Replace.** A (chosen): extract TASK-1128's flow as one step both Replaces call. B: reuse `changeApp` — impossible, it spends the dead STORED token. C: copy the closure into `bot-changes.ts` — two copies of the check-before-store rule.
- **Approaches for Rebuild.** A (chosen): client-side — the existing Disconnect, then the existing form, prefilled. B: a server route doing both — can't, the request needs the person's self/ask choice and maybe a paste.
- **Claim.** Live bots only (the requester ≠ approver inference is read only for pending bots), one statement for the row and its bindings, manage rights re-checked in the lock.
- **Non-goals.** A stored "token is dead" state; dates moved by Replace; the leftover pass on a bot Replace; an AX admin re-creating a team's bot; claiming a pending bot; `needsClaim` in Admin › Slack.
- **Anti-goals.** Reading or rotating the stored token during a Replace. Storing the paste under the paster when they aren't the approver. Moving the requester without the bindings (or the reverse). A new "bot is live" spelling (use `liveOwnBot`). Any behaviour change to Admin › Slack's Replace except the `onlyIfStored` release.

## What the brief got wrong (decisions row 1 lists them)

1. "Reuse `changeApp`/`appChangeError` for Replace": `changeApp` reads and rotates the STORED token (`slack-apps.ts:398-420`). Replace spends the PASTED one and checks before storing. Task 1 extracts TASK-1128's flow instead (row 2).
2. "Store the new `config_token_added_at`" / "the new owner-date shows": no per-bot token date exists under one token per person (TASK-1172 row 13; `store.ts:55-65`). The bot's Replace moves no date (row 4).
3. "The status says the bot needs its approver's new token" as a stored state: death is only learned by spending the token. The dead-token message stays at the change that finds it (TASK-1171's dialogs); the gone approver is a computed status (row 6).
4. "Claim pending bots only, or add a stored marker" (TASK-1169 learning): claim LIVE bots only, no marker (row 8).
5. "Rebuild … also offered in Admin › Slack": an AX admin can't open a team agent's request form; there it is "Needs rebuilding" plus the Disconnect that starts it (row 7).
6. "Under the bot install's lock": there is one app lock (`plugin.ts` `appLock`).

## Before you start

- [ ] `cd /Users/vpulim/dev/ai/ax-next/.claude/worktrees/agent-aca14e04e937cc91c && git fetch origin main && git log --oneline HEAD..origin/main`. If `[TASK-1170]` or `[TASK-1180]` landed, `git rebase origin/main`, then `pnpm install --frozen-lockfile && pnpm build`.
- [ ] Repeat before Tasks 6, 9 and 11 (each touches a sibling hot file). Commit before rebasing. Expected conflicts, all mechanical: `agent-routes.ts` (header route list, route registrations; TASK-1180 also edits `status`), `plugin.ts` (header, the `createBotChanges`/`createAdminBotRoutes` calls), `plugin.test.ts` (route shapes; every `toHaveLength(N)` becomes main's N + 3), `presets/memory/src/__tests__/canary.test.ts` (suffix loop, title), `lib/agent-slack.ts` (header, parser), `AgentSlack.tsx` (state next to `leftOver`). After any rebase: `pnpm build`.
- [ ] Copy no code from sibling branches.

## Global Constraints

- Run every command from `/Users/vpulim/dev/ai/ax-next/.claude/worktrees/agent-aca14e04e937cc91c` (start each Bash call with `cd` there; tell every subagent the same).
- Gate: `pnpm build && pnpm lint && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`. One package: `pnpm --filter @ax/<pkg> test <file>` (filter BEFORE the script). Run `pnpm --filter @ax/<pkg> build` (tsc) with vitest; channel-web's tsc also checks its tests, channel-slack's doesn't.
- Docker-backed suites need an explicit `DOCKER_HOST` (CLAUDE.md). Under sibling load they wait for start slots; that is load, not a hang.
- Every use of a configuration token runs under the one app lock. `mutex.ts` isn't re-entrant: each domain method takes it exactly once; nothing it calls takes it.
- Replace never reads or rotates the stored token. The pasted refresh token goes only to `tooling.tokens.rotate`. The minted refresh token is saved as `bot.connectedByUserId`'s, and only after Slack accepted the check.
- Only the approver replaces: 403 `not-approver` inside the lock, before any vault read or Slack call.
- Claim: live bots only; manage rights asked again inside the lock, first; the row and its bindings move in ONE statement.
- Log lines are code-only. New outcome lines: `slack_bot_token_replaced { installId }`, `slack_bot_claimed { installId }`. Step failures keep `slack_bot_failed { installId, stage, code }`. Never a token, a person's or agent's id, a name or a handle.
- No new `SlackApi` method; don't edit `__tests__/fake-slack-config.ts` (TASK-1170 edits it) unless a type-check forces it, then add only typed stubs.
- Bodies: all three new POSTs and Cancel cap at `ADMIN_BODY_MAX_BYTES` (16,384); an unknown key is 400 `invalid-body`.
- channel-web mirrors wire shapes, never imports channel-slack. UI uses installed shadcn primitives (`Dialog`, `Button`, `Alert`, `Badge`, `Field*` via `TokenField`, `Spinner`) and semantic tokens; invoke the `shadcn` skill for Tasks 8–10.
- Copy: the live and pending bot views and their dialogs never write "AX" (`AgentSlackBot.test.tsx` `describe('words')`). Security copy, so no jokes. Copy below is pinned verbatim.
- The pasted token in the browser is an uncontrolled password input (`TokenField`), never React state, cleared before the request goes, never rendered or logged.
- Fake tokens come from `__tests__/fake-slack-tokens.ts`. Never type a backslash-u escape (`source-hygiene.test.ts`). A `beforeEach` gets a block body.
- If implementers run in parallel in this one worktree, each commits with `git commit -m … -- <its paths>` (TASK-1171 mistake: a bare `git commit` sweeps a peer's staged files).
- Mutation checks: commit first, restore with `git checkout HEAD -- <path>`, `git status --short` empty between mutants; predict which tests go red before each.
- security-checklist: one walk per sensitive task (1–6, 8), each recorded as a row in the decisions shard, in the shape of `decisions/2026-11-20-TASK-1171.md` rows 27–29.

## Review Focus

1. **A team admin who isn't the approver, with their own live token stored, replaces the bot's token** (via the UI or a crafted POST): 403 `not-approver`, nothing read, the paste never reaches Slack, the approver's token untouched. Tests: Task 4 "RT2", Task 6 pass-through.
2. **The approver pastes a token that Slack rotates but that can't manage the bot** (a colleague's, or another workspace's): 502 `slack-not-app-manager`, the stored token kept, the dialog says only a token of the bot's setter works. Tests: Task 4 "RT6", Task 7 copy, Task 8 dialog.
3. **A stale page** (the bot was rebuilt, claimed or cancelled in another tab): Replace, Claim, Cancel and Rebuild touch nothing new and the page re-reads silently. Tests: Task 4 "RT9", "CL5"; Task 5 "cancel names the pending bot"; Task 9 stale cases.
4. **Auth can't answer while someone views a live bot:** no "needs rebuilding", the page still renders, one warn line. Test: Task 5 "approverGone".
5. **A CLI reset racing a Replace or a Claim:** 409 `not-live`, no orphaned token, no tombstone, no half-claimed bindings. Tests: Task 2, Task 3 "one statement", Task 4 "RT8", "CL6".

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `packages/channel-slack/src/slack-apps.ts` | + `ReplaceRefusal`, `replaceCheckError`, `AppSteps.replaceConfigToken` | 1 |
| `packages/channel-slack/src/admin-routes.ts` | Replace uses the step; gone-row releases `onlyIfStored` | 1, 2 |
| `packages/channel-slack/src/store.ts`, `__tests__/memory-install-store.ts` | `InstallStore.claimBot` | 3 |
| `packages/channel-slack/src/bot-changes.ts` | `replaceToken`, `replaceTokenForAdmin`, `claim` | 4 |
| `packages/channel-slack/src/bots.ts` | live `approverGone`/`viewerIsApprover`; `cancel` by id; admin rows' `viewerIsApprover` | 5 |
| `packages/channel-slack/src/agent-routes.ts`, `admin-bot-routes.ts`, `plugin.ts` | three routes, Cancel's body, wiring | 6 |
| `packages/channel-web/src/lib/agent-slack.ts`, `lib/slack-bots-admin.ts`, `lib/slack-token-copy.ts` | wire calls, parsers, copy | 7 |
| `packages/channel-web/src/components/slack/BotTokenReplaceDialog.tsx` (create), `components/workspace/AgentSlackBotChanges.tsx` | the shared token dialog; the approver's "Slack token" row | 8 |
| `packages/channel-web/src/components/workspace/AgentSlackBotLifecycle.tsx` (create), `AgentSlackBot.tsx`, `AgentSlack.tsx` | Rebuild, Claim, Cancel by id, the needs-attention lines | 9 |
| `packages/channel-web/src/components/admin/SlackBotsCard.tsx` | "Needs rebuilding", Replace for the viewer's own bots | 10 |
| design doc, `migrations.ts`, `.changeset/slack-bot-replace-rebuild.md` | stale lines, as-built, release note, final gate | 11 |

**Order.** Server: 1 → 2; 3 and 5 any time; 4 after 1 and 3; 6 after 4 and 5. Web: 7 → (8 ∥ 9) → 10 (10 uses 8's dialog). 11 last. The server and web chains may run in parallel (path-scoped commits).

---

### Task 1: One shared "replace a person's token with a pasted one" step [tier: sensitive] — security-checklist

**Files:**
- Modify: `packages/channel-slack/src/slack-apps.ts` — header `:12-31` (add the step to the list); after `appChangeError` `:141-160`; `AppSteps` `:180-293`; `createAppSteps` body and return `:322-546`.
- Modify: `packages/channel-slack/src/admin-routes.ts` — imports `:16-36` (drop `REFRESH_TOKEN_REFUSED`, now unused; keep `refreshTokenError` for Connect `:522` and `RotatedConfigToken` for `mintForPass` `:403`); remove `NOT_APP_MANAGER` `:221-233` and `replaceCheckError` `:266-278`; `replaceToken` `:772-798` becomes one step call.
- Test (UNCHANGED, the proof): `packages/channel-slack/src/__tests__/admin-routes.test.ts` `describe('POST /admin/slack/replace-token (TASK-1128)')` `:2888-…` and `'secrets never leave'`.

**Interfaces — Produces (`slack-apps.ts`):**
```ts
/** Why a pasted refresh token didn't replace its person's token, as the person is told it (a 502). */
export type ReplaceRefusal = 'slack-refresh-token' | 'slack-not-app-manager' | 'slack-error';
// moved verbatim from admin-routes.ts, docs included (module-private is fine):
//   NOT_APP_MANAGER = { no_permission, app_not_owned_by_manager_app, app_not_found }
//   function replaceCheckError(err: unknown): ReplaceRefusal
// AppSteps gains:
replaceConfigToken(
  app: SecretOwner,
  pasted: string,
  check: (accessToken: string) => Promise<void>,
): Promise<{ ok: true; accessToken: string } | { ok: false; refusal: ReplaceRefusal | 'token-not-kept' }>;
```
Exactly today's `admin-routes.ts:772-798`: rotate `pasted` (throw → `failed('try-refresh-token', err, app.installId)`, refusal `refreshTokenError(err)`); `check(minted.accessToken)` (throw → `failed('check-app', err, app.installId)`, refusal `replaceCheckError(err)`); `saveRotatedToken(app, minted.refreshToken)` false → `'token-not-kept'`; else `{ ok: true, accessToken: minted.accessToken }`. The comments at `:779-783` ("the check comes BEFORE the store") and `:794-797` ("written as the … person's token, never the pasting admin's") move into the step, worded for any app. Admin's Replace then calls it with `check = (t) => d.api.updateApp(t, install.appId, buildAppManifest(install.botName, slackUrls(d.publicOrigin, installId)))`, maps `'token-not-kept'` → `INTERNAL` and any other refusal → `json(502, { error })`, and keeps everything after (`setConfigTokenAddedAt`, the gone-row release, the log line, the leftover pass with `tried.accessToken`).

- [ ] **Step 1: Run the proof first.** `pnpm --filter @ax/channel-slack test admin-routes` — all green; note the count.
- [ ] **Step 2: Move and wire as above.**
- [ ] **Step 3: Verify.** The same command: the same count, zero test edits. `pnpm --filter @ax/channel-slack build` and `pnpm lint` clean (no unused import).
- [ ] **Step 4: Commit, then mutation-check** (predict first): (a) save before `check` → the replace tests that pin the trail and the "check refused keeps the old token" cases go red (TASK-1128 row 23's M1 set); (b) drop `app_not_found` from `NOT_APP_MANAGER` → the `slack-not-app-manager` case red; (c) log the check as `'try-refresh-token'` → that case's line pin red.
- [ ] **Step 5: security-checklist walk** (moved credential code: "N/A, refactor" is the checklist's anti-pattern; show the move widens nothing). Append the row to the decisions shard.
- [ ] **Step 6: Commit** `-- packages/channel-slack/src/slack-apps.ts packages/channel-slack/src/admin-routes.ts .claude/memory/decisions/2026-11-20-TASK-1173.md`.

### Task 2: Admin › Slack's Rename and Replace gone-row releases read first [tier: sensitive] — security-checklist

**Files:**
- Modify: `packages/channel-slack/src/admin-routes.ts` — rename `:723-738` (`release(install)` → `release(install, { onlyIfStored: true })`, comment updated); replace `:802-815` (same).
- Test: `packages/channel-slack/src/__tests__/admin-routes.test.ts` rename R7 `:2751`, replace-token R7 `:3211`.

- [ ] **Step 1: Write the failing tests.**
  - Rename R7, first case: `w.trail.slice(-3)` `toEqual(['store:personHasApps', 'vault:get config-refresh-token', 'vault:delete config-refresh-token'])`. Add a **wiped** case (the vault wiped AFTER `changeApp` saved the successor): `w.slack.on.updateApp = async () => { w.vault.clear(); await w.memory.store.removeAll(); }` → `{ status: 409, body: { error: 'not-connected' } }`; trail ends `['store:setBotName', 'store:personHasApps', 'vault:get config-refresh-token']`; no `vault:delete config-refresh-token` after the mark; `w.lines` `[]`.
  - Replace R7: the first case's expected trail gains `'vault:get config-refresh-token'` before `'vault:delete config-refresh-token'`; the raced case also asserts `raced.trail.at(-2) === 'vault:get config-refresh-token'`. Add a **wiped** case: swap `setConfigTokenAddedAt` to `w.vault.clear(); w.memory.rows.clear();` then call through → 409 `not-connected`; trail after the mark `[...ONE_REPLACE.slice(0, STOPS_AFTER['save-added-at']), 'store:personHasApps', 'vault:get config-refresh-token']`; no delete.
  - Kept cases (a leftover names Ada) stay as they are: the release stops at `store:personHasApps`.
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-slack test admin-routes` — the new and changed R7 assertions FAIL (`vault:delete` where `vault:get` is expected).
- [ ] **Step 3: Pass `{ onlyIfStored: true }` at both releases.**
- [ ] **Step 4: Run** — green; nothing else in the file moved (TASK-1171 row 34 measured: only the two R7 tests).
- [ ] **Step 5: security-checklist row** (credential deletion narrowed, the reset race), then **commit** `-- packages/channel-slack/src/admin-routes.ts packages/channel-slack/src/__tests__/admin-routes.test.ts .claude/memory/decisions/2026-11-20-TASK-1173.md`.

### Task 3: `InstallStore.claimBot`: the requester and the bindings move in one statement [tier: sensitive] — security-checklist

**Files:**
- Modify: `packages/channel-slack/src/store.ts` — `InstallRow.requestedByUserId` doc `:45-51` ("…or the team admin who claimed it since (TASK-1173); a claim moves it and every binding's copy together, `claimBot`"); interface after `setConfigTokenAddedAt` `:265-274`; implementation after `:666-674`.
- Modify: `packages/channel-slack/src/__tests__/memory-install-store.ts` — `claimBot`.
- Test: `packages/channel-slack/src/__tests__/store.test.ts` — a new `describe("a claim moves a live bot's requester and its bindings together (TASK-1173)")` after `:762`.

**Interfaces — Produces:**
```ts
/**
 * Hand a LIVE team bot to the team admin who claims it: its `requested_by_user_id`, and the
 * `connected_by_user_id` of every channel binding of its install, become `userId`, in ONE
 * statement. Only a `kind 'bot'`, `status 'active'` row; otherwise nothing moves and it throws
 * `install-not-active` (missing, pending, the shared app, or removed by a reset meanwhile).
 */
claimBot(installId: string, userId: string): Promise<void>;
```
Postgres: one `sql` statement — CTE `claimed` = `UPDATE channel_slack_v1_installs SET requested_by_user_id = $user WHERE install_id = $id AND kind = 'bot' AND status = 'active' RETURNING install_id`; CTE `moved` = `UPDATE channel_slack_v1_channels SET connected_by_user_id = $user, updated_at = now() WHERE install_id IN (SELECT install_id FROM claimed) RETURNING install_id`; final `SELECT (SELECT count(*) FROM claimed)::int AS claimed, (SELECT count(*) FROM moved)::int AS moved`; `claimed === 0` → `throw new InstallStoreError('install-not-active')`. Comment it like `remove`'s (`:676-687`). Memory fake: record `store:claimBot`, same row rule and throw, set `requestedByUserId`; its doc says bindings live in `memory-channel-store.ts`, so the binding move is pinned on Postgres only.

- [ ] **Step 1: Write the failing tests** (seed through the store's own API, plus direct `INSERT INTO channel_slack_v1_channels` for bindings):
  - `claimBot moves a live bot's requester and every binding of its install, and nothing else`: a shared install with a binding of channel C1 (agent A, `usr_shared`); bot B1 (active, agent A, requester `usr_ada`, approver `usr_grace`) with bindings C1 and C2 (`usr_ada`); bot B2 (active, agent S, `usr_sam`) with binding C3. `claimBot(B1, 'usr_bob')` → B1's row equals its old row except `requestedByUserId === 'usr_bob'` (`connectedByUserId` still `usr_grace`); B1's two bindings say `usr_bob` and their `updated_at` moved; the shared binding of C1 and everything of B2 unchanged.
  - `claimBot moves nothing for a pending bot, the shared app or an unknown id`: each rejects `InstallStoreError` `install-not-active`; seed a binding on the pending bot by SQL to prove it stays.
  - `claimBot is one statement: a binding update that fails leaves the requester as it was`: in a `try/finally`, `CREATE FUNCTION … RAISE EXCEPTION` + `CREATE TRIGGER … BEFORE UPDATE ON channel_slack_v1_channels`; `claimBot` rejects; B1's requester is still `usr_ada`; drop trigger and function in `finally`.
  - `claimBot claims a live bot with no bindings`.
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-slack test store` — FAIL (`claimBot` is not a function).
- [ ] **Step 3: Implement** the interface, the Postgres statement and the memory fake.
- [ ] **Step 4: Run** — green. Mutation (predict first): two statements instead of one → the trigger test red; drop `AND status = 'active'` → the pending case red; drop the bindings CTE → the first test red.
- [ ] **Step 5: security-checklist row**, then **commit** `-- packages/channel-slack/src/store.ts packages/channel-slack/src/__tests__/memory-install-store.ts packages/channel-slack/src/__tests__/store.test.ts .claude/memory/decisions/2026-11-20-TASK-1173.md`.

### Task 4: `bot-changes.ts`: the approver's Replace, and a team admin's Claim [tier: sensitive] — security-checklist

**Files:**
- Modify: `packages/channel-slack/src/bot-changes.ts` — header `:12-60` (rename/picture take no actor; Replace takes one only to compare with the approver; Claim's actor becomes the requester); `BotChangesDeps` `:62-76` + `bus: HookBus`; `BotChanges` `:78-96`; new methods beside `rename`/`setPicture`; return `:253`.
- Test: `packages/channel-slack/src/__tests__/bot-changes.test.ts` — the world `:137-183` gains `fakeAgents(bus)` (support team: Ada admin, Bob admin `usr_bob`, Mel member; sales team: Sam admin), passes `bus`, and helpers `replace(actor, pasted, agentId?)`, `replaceForAdmin(actor, installId, pasted)`, `claim(actor, installId, agentId?)`.

**Interfaces — Consumes:** `AppSteps.replaceConfigToken` (Task 1); `InstallStore.claimBot` (Task 3); `checkRights`, `teamAdminAccess`, `liveOwnBot` (`channels.ts`); `buildBotManifest`, `botUrls` (`manifest.ts`).
**Produces (`BotChanges`):**
```ts
/** The approver replaces their own token through the agent's live bot. 200 {}; 409 not-live; 403 not-approver;
 *  409 public-origin-not-https; 502 slack-refresh-token | slack-not-app-manager | slack-error; 500 internal. */
replaceToken(i: { actorUserId: string; agentId: string; refreshToken: string }): Promise<BotReply>;
/** The same, from Admin › Slack, by install id: 409 no-bot for an id no team bot has (the shared app's too). */
replaceTokenForAdmin(i: { actorUserId: string; installId: string; refreshToken: string }): Promise<BotReply>;
/** A team admin claims the agent's live bot whose requester is no longer a team admin. 200 {};
 *  404/403/409 as the rights re-check says; 409 not-live | no-bot | claim-not-needed. */
claim(i: { ctx: AgentContext; actorUserId: string; agentId: string; installId: string }): Promise<BotReply>;
```
Each takes `d.lock.run` once.
- **Replace** (one private `replaceFor(bot, actorUserId, refreshToken)`): `actorUserId !== bot.connectedByUserId` → 403 `not-approver`; `!canConnect` → 409 `public-origin-not-https`; `steps.replaceConfigToken(bot, refreshToken, (t) => d.api.updateApp(t, bot.appId, buildBotManifest(bot.botName, botUrls(d.publicOrigin, bot.installId))))` → `'token-not-kept'` 500, other refusal 502; then `goneMeanwhile(bot)` → `NOT_LIVE`; log `slack_bot_token_replaced { installId }`; 200 `{}`. `replaceToken` finds the bot with `liveOwnBot` (null → `NOT_LIVE`). `replaceTokenForAdmin`: `installs.get(installId)` null, not `kind 'bot'`, or no `agentId` → 409 `no-bot`; then `liveOwnBot(row.agentId)` null or another id → `NOT_LIVE`. No date write, no leftover pass (decisions rows 4–5).
- **Claim**: `checkRights(bus, ctx, agentId, actorUserId, 'manage')` FIRST (refusal → 403 `forbidden` / 409 `personal-agent` / 404 `not-found`, a local `rightsRefused` like `bots.ts:436-440`); `liveOwnBot` null → `NOT_LIVE`; `bot.installId !== installId` → 409 `no-bot`; requester = `bot.requestedByUserId === null ? 'no' : await teamAdminAccess(bus, ctx, agentId, bot.requestedByUserId)`: `'yes'` → 409 `claim-not-needed`, `'agent-gone'` → 404 `not-found`, `'not-team'` → 409 `personal-agent`; then `claimBot(bot.installId, actorUserId)` (`InstallStoreError` → `NOT_LIVE`; anything else throws); log `slack_bot_claimed { installId }`; 200 `{}`. No vault, no Slack.

- [ ] **Step 1: Write the failing Replace tests.** `PASTED = fakeConfigRefreshToken('GRACEPASTEDSECRET')`.
  - `RT1 the approver replaces: one rotate of the PASTED token, Slack gets the bot's whole manifest under its stored name, then the minted refresh token is hers; nothing else moves`: `w.replace(GRACE, PASTED)` → `{ status: 200, body: {} }`; `w.trail` `toEqual(['store:botForAgent', 'slack:rotateConfigToken', 'slack:updateApp', 'vault:set config-refresh-token', 'store:get'])`; rotate's argument `PASTED`; `updateApp` args `[MINTED_ACCESS, SUPPORT_APP, buildBotManifest(OLD_NAME, botUrls(ORIGIN, SUPPORT_BOT))]`; `vault.get(configTokenRef(GRACE)) === mintedRefresh(1)`; Ada's `ADA_STORED` and the bot token unchanged; `supportRow(w)` equal to its seeded value; `w.lines` `[{ level: 'info', msg: 'slack_bot_token_replaced', fields: { installId: SUPPORT_BOT } }]`.
  - `RT2 anyone but the approver is refused before the vault or Slack`: Ada (requester, live token stored), Sam, a stranger → each 403 `{ error: 'not-approver' }`; `reached(w)` `[]`; `PASTED` in no Slack call.
  - `RT3 no live bot (none, or pending) → 409 not-live, nothing reached`.
  - `RT4 an http origin → 409 public-origin-not-https for the approver; a non-approver still gets not-approver`.
  - `RT5 Slack refuses the pasted token at the rotate`: `invalid_refresh_token`, `token_revoked` → 502 `slack-refresh-token`; `ratelimited` → 502 `slack-error`; `vault.get(configTokenRef(GRACE)) === GRACE_STORED`; no `updateApp`; line `slack_bot_failed { installId: SUPPORT_BOT, stage: 'try-refresh-token', code }` at warn.
  - `RT6 Slack refuses the check`: `no_permission`, `app_not_owned_by_manager_app`, `app_not_found` → 502 `slack-not-app-manager`; `ratelimited` → `slack-error`; no `vault:set`; `GRACE_STORED` kept; stage `check-app`.
  - `RT7 the minted token won't save → 500 internal` (`vaultFailures` on `credentials:set`); stage `save-config-token` at error.
  - `RT8 a reset meanwhile → 409 not-live`: (a) `updateApp` swapped to `removeAll()` → trail ends `['store:get', 'store:personHasApps', 'vault:get config-refresh-token', 'vault:delete config-refresh-token']`, Grace's token gone; (b) a leftover naming Grace → trail ends `store:personHasApps`, token `mintedRefresh(1)` kept; (c) `w.memory.store.get` swapped to `w.vault.clear(); await removeAll()` then call through → no `vault:delete`.
  - `RT9 Admin › Slack's path, by install id`: Grace + `SUPPORT_BOT` → 200, trail starts `['store:get', 'store:botForAgent']`; Grace + `SALES_BOT` → 403 `not-approver`; `SHARED_INSTALL` and an unknown 22-character id → 409 `no-bot`; a pending support bot's id → 409 `not-live`; nothing reached on any refusal.
  - `RT10 both wait for the one app lock` (hold the lock as the existing lock tests do; nothing is read until it is released).
  - Extend the file's leak scan: a Replace, and its RT5–RT8 worlds, put no `PASTED`, `MINTED_ACCESS`, `mintedRefresh(n)`, `GRACE_STORED`, person id, name or handle in any reply or line.
- [ ] **Step 2: Write the failing Claim tests.**
  - `CL1 a team admin claims a live bot whose requester is no longer a team admin`: `people.setRole(SUPPORT_TEAM, ADA, 'member')`; `w.claim(BOB, SUPPORT_BOT)` → 200 `{}`; `w.memory.calls` includes `{ method: 'claimBot', args: [SUPPORT_BOT, BOB] }`; `supportRow(w).requestedByUserId === BOB`; `reached(w)` `[]`; line `{ level: 'info', msg: 'slack_bot_claimed', fields: { installId: SUPPORT_BOT } }`.
  - `CL2 a requester taken off the team counts too` (`setRole(…, ADA, null)`) → 200.
  - `CL3 a requester still a team admin → 409 claim-not-needed, no claimBot`.
  - `CL4 rights first, inside the lock`: Mel → 403 `forbidden`; Sam (another team) → 404 `not-found`; each with `w.memory.calls` empty.
  - `CL5 the bot the page showed`: `SALES_BOT` id on the support agent → 409 `no-bot`; support bot none or pending → 409 `not-live`.
  - `CL6 a claim racing a reset → 409 not-live` (`memory.failures.set('claimBot', new InstallStoreError('install-not-active'))`); a plain store fault rejects.
  - `CL7 a team admin demoted while the claim waited on the lock is refused 403, nothing read`.
  - `CL8 an outage asking about the requester throws, nothing written` (fake agents fault).
- [ ] **Step 3: Run** `pnpm --filter @ax/channel-slack test bot-changes` — the new tests FAIL; the existing rename/picture tests still pass with `bus` added.
- [ ] **Step 4: Implement** the deps change and the three methods.
- [ ] **Step 5: Run** — green. Mutation (predict first): the approver check after the rotate (RT2: Slack reached); the approver check comparing the requester (RT2: Ada gets through); the minted token saved under the requester (RT1); no `goneMeanwhile` (RT8); `liveOwnBot` replaced by `botForAgent` (RT3, pending); rights asked after `liveOwnBot` (CL4, CL7); no `claim-not-needed` check (CL3).
- [ ] **Step 6: security-checklist row** (who may replace, whose slot, whose identity outsiders borrow), then **commit** `-- packages/channel-slack/src/bot-changes.ts packages/channel-slack/src/__tests__/bot-changes.test.ts .claude/memory/decisions/2026-11-20-TASK-1173.md`.

### Task 5: `bots.ts`: who set the bot up, Cancel by install id, the admin rows the viewer approved [tier: sensitive] — security-checklist

**Files:**
- Modify: `packages/channel-slack/src/bots.ts` — doc `:35-37` (requester: "or the team admin who claimed it since"), `:83-91` (Cancel by the install id its page showed), `AgentSlackBot` live `:135-148`, `AdminSlackBot` `:150-165`, `Bots.cancel` doc `:302-310`, `listForAdmin` doc `:380-391`, `cancel` `:683-692`, `needsClaim` doc `:820-824` ("until a team admin claims it, bot-changes.ts `claim`"), `status` `:836-881`, `listForAdmin` `:883-902`.
- Test: `packages/channel-slack/src/__tests__/bots.test.ts` — `cancel` `:1495`, `listForAdmin` `:1991`, `status` `:2158`, and every exact pin of a live status or admin row (six live pins, two admin pins: add the new keys).

**Interfaces — Produces:**
```ts
// AgentSlackBot, state 'live', gains:
approverGone: boolean;      // auth answers null for the approver; a fault reads false
viewerIsApprover: boolean;  // viewerUserId === bot.connectedByUserId
// AdminSlackBot gains:
viewerIsApprover: boolean;
// Bots:
cancel(i: { agentId: string; installId: string }): Promise<BotReply>;
listForAdmin(i: { ctx: AgentContext; viewerUserId: string }): Promise<AdminSlackBot[]>;
```
`status`: a private `approverOf(i, bot)` replaces the `personName` call — `accountName(bus, ctx, bot.connectedByUserId, { allowEmail: false, fallback: APPROVER_FALLBACK })` in a try: null → `{ name: APPROVER_FALLBACK, gone: true }`, a string → `{ name, gone: false }`, a throw → `steps.failed('approver', err, bot.installId, 'warn')` and `{ name: APPROVER_FALLBACK, gone: false }`. Pending uses only the name (its shape and answers unchanged). `cancel`: `bot === null || bot.status !== 'pending' || bot.installId !== i.installId` → `NOT_PENDING`, nothing touched.

- [ ] **Step 1: Write the failing tests.**
  - `status: a live bot says whether its approver has left`: delete Grace from `users` → `approverGone: true`, `approver: 'A teammate'`; with `auth.fault` set → `approverGone: false` and one warn line `slack_bot_failed { installId, stage: 'approver', code }`; normally `false`.
  - `status: viewerIsApprover is true only for the approver` (Grace true; Ada, Mel false).
  - `status: a pending bot's shape is unchanged` (no new keys).
  - `cancel names the pending bot by the install id its page showed`: another id (a stale page after a new request) → 409 `not-pending`, `reached(w)` `[]`, the bot still pending; existing cancel tests pass the right id.
  - `listForAdmin: viewerIsApprover marks the viewing admin's own bots only`.
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-slack test bots` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — green. Mutation: `personName` kept for live (the gone case red); a fault read as gone (the fault case red); cancel ignoring the id (the stale case red).
- [ ] **Step 5: security-checklist row** (a destructive Cancel keyed by id; reads only), then **commit** `-- packages/channel-slack/src/bots.ts packages/channel-slack/src/__tests__/bots.test.ts .claude/memory/decisions/2026-11-20-TASK-1173.md`.

### Task 6: The routes, Cancel's body, the wiring, the canary [tier: sensitive] — security-checklist

**Files:**
- Modify: `packages/channel-slack/src/agent-routes.ts` — header `:26-79` (route list; "Install-url reads no body; Cancel, Disconnect and Claim take the install id of the bot the page showed"); keys `:129-139` + `REPLACE_KEYS = ['refreshToken']`; a `readReplaceBody` beside `readRenameBody`; `readBotDisconnectBody` `:236-257` doc ("Disconnect, Cancel and Claim"); `cancelBot` `:531-536`; two handlers; route list `:640-656`.
- Modify: `packages/channel-slack/src/admin-bot-routes.ts` — header `:10-37`, deps `:42-46` + `changes: Pick<BotChanges, 'replaceTokenForAdmin'>`, `list` `:77-81` passes `viewerUserId: actor.id`, a `replaceToken` handler, route list `:127-130`, `export const ADMIN_BOT_REPLACE_TOKEN_PATH = '/admin/slack/bots/replace-token'`.
- Modify: `packages/channel-slack/src/plugin.ts` — header `:73-104`; `createBotChanges({ …, bus })` `:416-425`; `createAdminBotRoutes({ bus, bots, changes: botChanges, logger })` `:442`.
- Test: `agent-routes.test.ts` (`Suffix` `:270-286`, `EVERY_ROUTE` `:288-303`, the body-before-rights list `:744-760`, the route pin, the `changes` stub), `admin-bot-routes.test.ts` (new route; tripwire `:302-310`), `plugin.test.ts` (route shapes from `:742`; `toHaveLength(30)` at `:2194`, `:2216`, `:2245`, `:2771` → 33; title "thirty-three routes"), `presets/memory/src/__tests__/canary.test.ts` (title `:742`, suffix loop `:884-893`, admin block `:907-923`).

**Routes:**
| Route | Gate | Body | Domain |
|---|---|---|---|
| `POST /settings/slack/:agentId/bot/replace-token` | manage (`manages`) | `{ refreshToken }` alone; `configToken(…, REFRESH_TOKEN_PREFIX)` else 400 `invalid-refresh-token` (missing included) | `changes.replaceToken({ actorUserId: a.userId, agentId: a.agentId, refreshToken })`, stage `bot-replace-token` |
| `POST /settings/slack/:agentId/bot/claim` | manage | `readBotDisconnectBody` | `changes.claim({ ctx: a.ctx, actorUserId: a.userId, agentId: a.agentId, installId })`, stage `bot-claim` |
| `POST /settings/slack/:agentId/bot/cancel` (changed) | manage | `readBotDisconnectBody` (`{}` → 400 `invalid-install-id`) | `bots.cancel({ agentId: a.agentId, installId })` |
| `POST /admin/slack/bots/replace-token` | `checkAdmin` | keys within `installId`, `refreshToken` else 400 `invalid-body`; `INSTALL_ID_RE` else 400 `invalid-install-id`; `configToken` else 400 `invalid-refresh-token` | `changes.replaceTokenForAdmin({ actorUserId: actor.id, installId, refreshToken })`, stage `bot-replace-token` |

All four: 413 past `ADMIN_BODY_MAX_BYTES`, CSRF kept (no `bypassCsrf`), rights before the body.

- [ ] **Step 1: Write the failing tests.**
  - `agent-routes.test.ts`: `Suffix` and `EVERY_ROUTE` gain `{ method: 'POST', suffix: '/bot/replace-token', body: { refreshToken: REFRESH } }` and `{ method: 'POST', suffix: '/bot/claim', body: { installId: OWN_BOT.installId } }`; `/bot/cancel` gets `body: { installId: OWN_BOT.installId }` (the domain is a stub: any well-formed id); the body-before-rights list gains both. New: `replace-token: an object holding refreshToken alone` (ACCESS, none, `null`, `42` → `invalid-refresh-token`; `{ refreshToken, agentId }` → `invalid-body`; one byte past the cap → 413; the domain gets exactly `{ actorUserId, agentId }` from the path and the person, plus the token); `claim and cancel take the page's install id` (`{}` → `invalid-install-id`, 21 characters → `invalid-install-id`, the domain gets the path's agent); `answers pass through` (`not-approver` 403, `claim-not-needed` 409, `not-pending` 409, `{ appDeleted }`); `a fault is a 500 logged code-only` (stages `bot-replace-token`, `bot-claim`; the token in the fault's message never in a line).
  - `admin-bot-routes.test.ts`: the gate first (401, 403, 500) with any body; the bodies above (plus not-JSON, an array, `null`, bytes that aren't UTF-8); the domain gets exactly `{ actorUserId: <admin id>, installId, refreshToken }`; answers pass through; fault → `slack_admin_failed { stage: 'bot-replace-token', code }`; `list` hands the domain `viewerUserId: actor.id`. Tripwire: regex `\b(?:listForAdmin|disconnectForAdmin|replaceTokenForAdmin)\b`, definers excluded `bots.ts` and `bot-changes.ts`, expect `['admin-bot-routes.ts']`.
  - `plugin.test.ts`: the three POSTs in the route shapes (`bypassCsrf: false`, `maxBodyBytes: ADMIN_BODY_MAX_BYTES`); counts 33.
  - Canary: the suffix loop gains `'/bot/replace-token'`, `'/bot/claim'`; after the bots Disconnect block, `/admin/slack/bots/replace-token` without the CSRF header → 403, with it and `{ installId: 'A'.repeat(22), refreshToken: 'xoxe-1-CANARY' }` → `{ status: 409, json: { error: 'no-bot' } }`; the title gains TASK-1173.
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-slack test agent-routes admin-bot-routes plugin` — FAIL; and, before rebuilding, `pnpm --filter @ax/preset-memory test canary` — RED against the old dist (the router's 405 for the unmounted POSTs).
- [ ] **Step 3: Implement the routes and wiring.** `pnpm --filter @ax/channel-slack build && pnpm build` (the canary runs the built dist).
- [ ] **Step 4: Run** the three files, then the whole package, then `pnpm --filter @ax/preset-memory test` (a changed route body can break its canary — the brief's warning) — green.
- [ ] **Step 5: Mutation** (predict first): replace-token without `manages` (the member loop), the body read before rights (body-before-rights), cancel not passing the id (pass-through), the admin route without `checkAdmin` (gate test), a second caller of `replaceTokenForAdmin` (tripwire).
- [ ] **Step 6: security-checklist row** (three signed-in routes, one taking a pasted credential), then **commit** the files listed above and the shard, path-scoped.

### Task 7: channel-web: wire calls, parsers, copy [tier: integration]

**Files:**
- Modify: `packages/channel-web/src/lib/agent-slack.ts` — header `:7-20`; live type `:71-79`; `parseBot` live `:220-228`; `cancelSlackBot` `:427-433`; new calls; `AGENT_SLACK_BOT_CHANGE_COPY` `:591-596`; `agentSlackBotChangeErrorCopy` `:598-626`; `agentSlackBotStale` `:635-648`.
- Modify: `packages/channel-web/src/lib/slack-bots-admin.ts` — header `:1-16`; `AdminSlackBot` `:20-32`; `parseBot` `:59-70`; new call; `teamBotGone` `:130-133`.
- Modify: `packages/channel-web/src/lib/slack-token-copy.ts` — `BOT_TOKEN_COPY`.
- Modify (call sites this task's signatures break; channel-web's tsc checks tests too): `components/workspace/AgentSlackBot.tsx` `Pending` `:456-519` (Cancel calls `cancelSlackBot(agentId, bot.installId)` and is rendered only when `bot.installId !== null`); `components/workspace/AgentSlackBotChanges.tsx` `:226`, `:364` (pass `bot`); every test fixture typed as a live `AgentSlackBot` or an `AdminSlackBot` (`AgentSlackBot.test.tsx`, `AgentSlackBotChanges.test.tsx`, `AgentSlack.test.tsx`, `SlackBotsCard.test.tsx`, `SlackTab.test.tsx`, both lib tests) gains `approverGone: false, viewerIsApprover: false` / `viewerIsApprover: false`.
- Test: `src/lib/__tests__/agent-slack.test.ts`, `src/lib/__tests__/slack-bots-admin.test.ts`, and one case in `components/workspace/__tests__/AgentSlackBot.test.tsx`: Pending's Cancel posts the pending bot's id, and there is no Cancel without one.

**Interfaces — Produces:**
```ts
// agent-slack.ts
// AgentSlackBot 'live' gains: approverGone: boolean; viewerIsApprover: boolean
//   (absent → false; present and not boolean → bad-response)
export function cancelSlackBot(agentId: string, installId: string): Promise<{ appDeleted: boolean }>; // posts { installId }
export function replaceAgentSlackBotToken(agentId: string, refreshToken: string): Promise<void>;     // POST /bot/replace-token { refreshToken }
export function claimAgentSlackBot(agentId: string, installId: string): Promise<void>;               // POST /bot/claim { installId }
export function agentSlackBotReplaceErrorCopy(err: unknown): { field: 'refreshToken' | null; message: string };
export function agentSlackBotReplaceStale(err: unknown): boolean; // agentSlackBotStale(err) || 403 not-approver
export function agentSlackBotChangeErrorCopy(
  err: unknown,
  bot: Pick<Extract<AgentSlackBot, { state: 'live' }>, 'approver' | 'approverGone' | 'viewerIsApprover'>,
): { field: 'botName' | null; message: string };
// agentSlackBotStale gains 409 'claim-not-needed'.
// slack-bots-admin.ts
// AdminSlackBot gains viewerIsApprover: boolean (absent → false; not boolean → bad-response)
export function replaceTeamBotToken(installId: string, refreshToken: string): Promise<void>; // POST /admin/slack/bots/replace-token
export function teamBotReplaceErrorCopy(err: unknown): { field: 'refreshToken' | null; message: string };
export function teamBotReplaceStale(err: unknown): boolean; // teamBotGone(err) || 403 not-approver
// teamBotGone also matches 409 'not-live'.
// slack-token-copy.ts
export const BOT_TOKEN_COPY: Readonly<{ 'slack-not-app-manager': string; replaced: (botName: string) => string }>;
```
**Copy (pinned):**
- `BOT_TOKEN_COPY['slack-not-app-manager']`: "Slack says that token can't manage this bot. Only the person who set a bot up can replace its token, with a new token of their own from this Slack workspace."
- `BOT_TOKEN_COPY.replaced(botName)`: "Token replaced. We now use it for {botName} and every other Slack app you set up here. Don't revoke the token you just pasted: it's the one we use now."
- Both replace-copy functions: `invalid-refresh-token`, `slack-refresh-token` → `SLACK_TOKEN_COPY[code]` under the field; `slack-not-app-manager` → `BOT_TOKEN_COPY` under the field; `public-origin-not-https` → `SLACK_ERROR_COPY['public-origin-not-https']`; `slack-error` → `SLACK_ERROR_COPY.generic`; anything else → the surface's generic line.
- `AGENT_SLACK_BOT_CHANGE_COPY` gains `yourTokenNeedsReplacing`: "Your Slack token stopped working. Replace it under Slack token, then try again." and `tokenDeadApproverLeft`: "This bot's Slack token stopped working, and the person who set it up has left. Rebuild the bot to change it." `slack-config-token` picks: `viewerIsApprover` → the first; else `approverGone` → the second; else the existing `tokenNeedsReplacing(approver)` (TASK-1171's sentence, unchanged).

- [ ] **Step 1: Write the failing tests**: parser defaults and refusals for both new live fields and `viewerIsApprover`; the three agent calls and the admin call post exactly their bodies with the write headers and throw `AgentSlackError`/`SlackAdminError` codes; `agentSlackBotStale` on `claim-not-needed`; `teamBotGone` on `not-live`; both `…ReplaceStale` on 403 `not-approver`; each copy branch, verbatim; Pending's Cancel case.
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-web test agent-slack slack-bots-admin AgentSlackBot` — FAIL.
- [ ] **Step 3: Implement**, with the call sites and fixtures listed under Files in the same commit, so tsc stays green (Tasks 8–10 then build on them).
- [ ] **Step 4: Run** the files and `pnpm --filter @ax/channel-web build` — green.
- [ ] **Step 5: Commit** the lib files, the call sites and the tests, path-scoped.

### Task 8: The shared token dialog, and the approver's "Slack token" row [tier: sensitive] — security-checklist

**Files:**
- Create: `packages/channel-web/src/components/slack/BotTokenReplaceDialog.tsx`; test `src/components/slack/__tests__/BotTokenReplaceDialog.test.tsx`.
- Modify: `packages/channel-web/src/components/workspace/AgentSlackBotChanges.tsx` — header `:1-26`; `BotChanges` `:66-137` (a third row and a success notice); test `__tests__/AgentSlackBotChanges.test.tsx`.

**Interfaces — Produces:**
```ts
export interface BotTokenReplaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  botName: string;
  /** Sends the pasted refresh token; rejects with the surface's own error. */
  replace: (refreshToken: string) => Promise<void>;
  errorCopy: (err: unknown) => { field: 'refreshToken' | null; message: string };
  /** A refusal meaning the page is out of date: the dialog closes, then `onStale`. */
  isStale: (err: unknown) => boolean;
  onReplaced: () => void;
  onStale: () => void;
}
export function BotTokenReplaceDialog(props: BotTokenReplaceDialogProps): JSX.Element;
```
Model it on SlackTab's `ReplaceTokenDialog`/`ReplaceTokenForm` (`SlackTab.tsx:641-770`): the dialog owns `busy` (Escape and the overlay wait), the form under `DialogContent` remounts on each opening, `TokenField` (id `slack-bot-replace-refresh-token`, label "Refresh token", hint "Starts with xoxe-") is read once, trimmed and cleared before `replace` is called, the field is focused after an error, and the dialog closes itself before `onReplaced`/`onStale`. **Text (pinned, no "AX"):** title "Replace your Slack token"; description "Do this when the configuration token we have for you stops working. {botName} stays in its channels, and nobody has to invite it again."; steps (1) "Open <SlackAppsLink />. Under **Your App Configuration Tokens**, find this workspace. Slack allows one token per person there, so if one is listed, revoke it, then click **Generate Token**." (2) "Paste its refresh token below. We keep it encrypted, and nobody can read it back."; buttons "Cancel", "Replace token" (busy "Replacing…").

`BotChanges`: when `bot.viewerIsApprover`, a third row `<dt>Slack token</dt>` with an outline `sm` Button "Replace token"; the dialog gets `replace={(t) => replaceAgentSlackBotToken(agentId, t)}`, `errorCopy={agentSlackBotReplaceErrorCopy}`, `isStale={agentSlackBotReplaceStale}`, `onStale={onChanged}`; success shows an `Alert` with `BOT_TOKEN_COPY.replaced(bot.botName)` (cleared when any dialog opens, like `pictureSaved`).

- [ ] **Step 1: Write the failing tests.** Dialog: the pasted value is never in `document.body.innerHTML` before, during or after the request, on success and every error path; the field is empty when `replace` is called; a field error sits under the field and a form error in the Alert; `isStale` → closes and calls `onStale`, no error shown; Escape is ignored while busy; reopening shows no old error; no `\bAX\b` in the open dialog. Changes: the row shows only when `viewerIsApprover`; a replace shows the pinned notice; a 403 `not-approver` closes and calls `onChanged`; rename's and picture's `slack-config-token` read the three variants.
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-web test BotTokenReplaceDialog AgentSlackBotChanges` — FAIL.
- [ ] **Step 3: Implement** (invoke the `shadcn` skill; compose `Dialog`, `Alert`, `Button`, `Spinner`, `TokenField`, `SlackAppsLink`).
- [ ] **Step 4: Run** — green; `pnpm --filter @ax/channel-web build` (tsc covers tests).
- [ ] **Step 5: security-checklist row** (a credential in the browser, the TASK-1128 Task 4 walk's shape), then **commit**, path-scoped.

### Task 9: Rebuild, Claim, and the needs-attention lines in agent settings [tier: integration]

**Files:**
- Create: `packages/channel-web/src/components/workspace/AgentSlackBotLifecycle.tsx` (`RebuildBotDialog`, `ClaimBotDialog`); test `__tests__/AgentSlackBotLifecycle.test.tsx`.
- Modify: `packages/channel-web/src/components/workspace/AgentSlackBot.tsx` — header `:1-43` (Pending's Cancel by id included); `BotCancelled` `:95-101` + `approverGone?: boolean`; props `:103-129`; `AppLeftOverNote` `:165-182`; the switch `:184-226`; `RequestForm` `:228-405`; `Live` `:521-576`; `DisconnectBotDialog` `:582-663`.
- Modify: `packages/channel-web/src/components/workspace/AgentSlack.tsx` — state beside `leftOver` `:82-97`.
- Test: `__tests__/AgentSlackBot.test.tsx`, `__tests__/AgentSlack.test.tsx`.

**Interfaces — Produces:**
```ts
/** The bot a Rebuild took away, so the form can offer its name back. */
export interface RebuildFrom { botName: string; handle: string | null }
// AgentSlackBotProps gains:
rebuilding: RebuildFrom | null;            // held by AgentSlack, like leftOver
onRebuilt: (from: RebuildFrom) => void;
// RequestForm gains initialBotName?: string (useState(initialBotName ?? agentName))
```
- `AgentSlack`: `rebuilding` state reset on agent change and by `onRequesting` (as `leftOver` is), passed through `botCallbacks`.
- `Live` (`who` = `@handle`, else the bot name), in order:
  - managers' approver line: `viewerIsApprover` → "You set it up."; `approverGone` → "Set up by someone who has left."; else "Set up by {approver}."
  - when `approverGone`, an `Alert` for everyone: "{botName} needs rebuilding. The person who set it up has left, so nobody can replace its Slack token any more." + " Rebuild it to set it up again under your own token." when the Rebuild button shows, else " A team admin can rebuild it."
  - the existing `needsClaim` line, plus an outline Button "Claim bot" for managers with an `installId`.
  - `BotChanges` (Task 8).
  - managers with an `installId`: "Rebuild bot" (only when `sharedConnected`) beside "Disconnect bot".
- `RebuildBotDialog` (pinned): title "Rebuild {who}?"; description "We'll disconnect {who} and delete its Slack app. Then you set up a new bot here. It gets a new @handle, so every channel needs /invite again. If Slack won't let us delete the old app, it may need deleting by hand in Slack's app settings."; buttons "Keep it" / "Rebuild" (busy "Disconnecting…"). Confirm → `disconnectSlackBot(agentId, installId)` → `onCancelled({ how: 'disconnected', appDeleted, approverIsViewer: bot.viewerIsApprover, approver: bot.approver, approverGone: bot.approverGone })`, `onRebuilt({ botName: bot.botName, handle: bot.handle })`, `onChanged()`. Stale (`agentSlackBotStale`) → close, `onChanged()`; else the Alert with `agentSlackBotErrorCopy(err).message`.
- `ClaimBotDialog` (pinned): title "Claim {who}?"; description "Right now {who} answers only team members. Once you claim it, it answers people outside the team with your access, and anything it needs approved waits in your Today."; buttons "Not now" / "Claim it" (busy "Claiming…"). Confirm → `claimAgentSlackBot(agentId, installId)` → `onChanged()`; stale → close, `onChanged()`; else `AGENT_SLACK_COPY.generic`.
- `RequestForm` notice when `rebuilding !== null` (above the left-over note): "{who} is disconnected. Set up its replacement below. It gets a new @handle, so invite it to each channel again." (who from `rebuilding`).
- `AppLeftOverNote`: with `approverGone`, no "{approver} set it up and can also delete it…" sentence.
- `DisconnectBotDialog`: `approverIsViewer: bot.viewerIsApprover`, `approverGone: bot.approverGone`.

- [ ] **Step 1: Write the failing tests**: the three approver lines; the Alert's two endings; Claim only for managers with `needsClaim` and an id; Rebuild only for managers with `sharedConnected` and an id (none in no-workspace); Rebuild's confirm order (disconnect with the shown id, then `onCancelled`, `onRebuilt`, `onChanged`) and its stale and error paths; Claim posts the shown id and re-reads, `claim-not-needed` closes silently; `AgentSlack` after a Rebuild shows the form prefilled with the old name, the rebuild notice and (when `appDeleted` false) the left-over note, and a new request or another agent clears them; the `words` rule extended to the live view with every new element and both dialogs open.
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-web test AgentSlackBot AgentSlack AgentSlackBotLifecycle` — FAIL.
- [ ] **Step 3: Implement** (invoke the `shadcn` skill).
- [ ] **Step 4: Run** — green; `pnpm --filter @ax/channel-web build`.
- [ ] **Step 5: Commit**, path-scoped.

### Task 10: Admin › Slack: "Needs rebuilding", and Replace for the viewer's own bots [tier: integration]

**Files:**
- Modify: `packages/channel-web/src/components/admin/SlackBotsCard.tsx` — header `:1-29`; status cell `:204-210`; actions `:211-220`; footnote `:225-230`; `DisconnectBotDialog` `:245-325`.
- Test: `src/components/admin/__tests__/SlackBotsCard.test.tsx`.

- Status cell: `state === 'live' && approver === null` → `<Badge variant="warning">Needs rebuilding</Badge>`; else as today.
- Actions: when `viewerIsApprover && state === 'live'`, an outline `sm` "Replace token" (`aria-label` "Replace token for {botName}") before Disconnect, opening `BotTokenReplaceDialog` with `replace={(t) => replaceTeamBotToken(bot.installId, t)}`, `errorCopy={teamBotReplaceErrorCopy}`, `isStale={teamBotReplaceStale}`; success → a card `Alert` with `BOT_TOKEN_COPY.replaced(botName)` (held like `leftOver`); stale → `staleRow()`.
- Disconnect dialog, for a live row whose approver is null, appends: " Its approver has left, so this is how it gets rebuilt: once it's disconnected, a team admin of its agent sets up a new one from the agent's settings, and every channel needs /invite again."
- Footnote: "When the person who set up a bot has left, nobody can replace its Slack token any more, so it needs rebuilding: disconnect it here, and a team admin of its agent can set up a new one."

- [ ] **Step 1: Write the failing tests**: the badge only for live + approver null; Replace only on the viewer's live rows, with its label; a replace posts `{ installId, refreshToken }` and shows the notice; a stale replace re-reads; the rebuild sentence only on such rows' dialog; the footnote.
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-web test SlackBotsCard` — FAIL.
- [ ] **Step 3: Implement** (invoke the `shadcn` skill).
- [ ] **Step 4: Run** — green; `pnpm --filter @ax/channel-web build`.
- [ ] **Step 5: Commit**, path-scoped.

### Task 11: Stale lines, as-built, changeset, and the full gate [tier: mechanical]

**Files:**
- Modify: `docs/plans/2026-11-09-channel-slack-design.md` — §3 `:301-302` ("when it was last added" → the date moves only with Admin › Slack's Connect or Replace; a paste or Replace through a team bot changes the same token without moving it); §4 Lifecycle `:478-488` (Rebuild first tries to delete the old app with the approver's stored token, which can still work after they leave AX; only when Slack won't does it go on the leftover list); `:490-495` and `:543-545` (the claim is built: a team admin of the team claims it, see below); a new "As built (TASK-1173)" after `:626` (Replace on both surfaces, approver only, no date, no leftover pass; `approverGone` and why a dead token is told at the change that finds it; Rebuild client-side and its Admin › Slack half; Claim live-only in one statement; Cancel by install id; the `onlyIfStored` releases); §9 `:1198` ("Replace of a live bot is still to do" → done by TASK-1173, with Rebuild and Claim).
- Modify: `packages/channel-slack/src/migrations.ts` `:12-23` (`requested_by_user_id`: "or the team admin who claimed it since").
- Modify: `packages/channel-slack/src/store.ts` `:55-65` (a bot's own Replace moves no date either) — only if Task 3 didn't.
- Create: `.changeset/slack-bot-replace-rebuild.md` — `'@ax/channel-slack': patch`, `'@ax/channel-web': patch`; one paragraph in the project voice: the person who set up a team bot can replace their Slack token from the agent's settings or Admin › Slack; a bot whose setter left says it needs rebuilding, and Rebuild starts it again under your own token; a team admin can claim a bot whose requester left.

- [ ] **Step 1:** `git grep -n "Replace of a live bot is still to do\|when it was last added\|The old app goes on the leftover-apps list\|Install-url and Cancel read no body\|take no actor"` — fix every hit this card made false (the shard's "Rule 5" row lists them, with the code-prose lines each task already fixed). Don't edit walk reports, earlier plans or earlier shards.
- [ ] **Step 2: Full gate:** `pnpm build && pnpm lint && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`; also `pnpm --filter @ax/preset-memory test` and `pnpm --filter @ax/preset-k8s test` by name (channel-slack's dependents). A Docker start-slot timeout in an untouched package passes when re-run alone; say so in the handoff rather than skipping it.
- [ ] **Step 3: Commit**, path-scoped.

---

## Security checklist scope

One `security-checklist` walk per sensitive task (1–6, 8), each a row in `.claude/memory/decisions/2026-11-20-TASK-1173.md`. The planner's residuals for the PR note are that file's "Residuals" row; add what your walks find. No boundary review: no hook, IPC action or manifest `calls` change (claim's `agents:resolve`/`agents:can-set-shared-credential` and the status's `auth:get-user` are already called), so the `presets/k8s` manifest pins don't move.

## Cut, and handed back

YAGNI cuts and follow-ups are the shard's "YAGNI cuts" and "Follow-ups" rows. Return the follow-ups in your handoff; don't build them.
