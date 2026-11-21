# TASK-1170: Slack DMs for bot requests (admins asked, owner told) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a team admin asks an AX admin for their agent's own bot, the shared bot DMs every AX admin it can find in the workspace (Approve = a link to Admin › Slack, Decline = a button that works only for a current AX admin while the request is open), each admin's DM is redrawn with who approved or declined it, and the requester is DMed when an admin-approved bot goes live or is declined.

**Architecture:** One new host-internal auth hook, `auth:list-admins` (`{} → { admins: [{ userId, email }] }`, verified emails only), registered by `@ax/auth-better`. In `@ax/channel-slack`, a new `bot-request-dms.ts` owns every DM: the admin fan-out, an in-memory record of each DM's channel and ts (for the redraw), and the owner notices. All of it runs off the request path, outside the app lock, tracked by the plugin's lifetime, and never fails anything. `bot-requests.ts` tells it when a request opens and closes; `bot-callback.ts` tells it when a bot goes live. A new action id on the interactions route hands a Decline click to a new gate, `bot-request-click.ts`, which re-proves the clicker (users.info → `auth:find-user-by-email` → `auth:get-user` isAdmin) and then runs the same `decline` Admin › Slack runs. channel-web gains one deep link, `/?admin=slack`, that opens Admin › Slack for an admin. No migration, no new route, no new Slack scope.

**Tech Stack:** TypeScript, Kysely + Postgres (testcontainers), vitest, React (channel-web; no new component).

**Spec:** the TASK-1170 card (brief: `/private/tmp/claude-501/-Users-vpulim-dev-ai-ax-next/b9feba9b-916e-4979-b5be-adabf94d3c15/scratchpad/cards/TASK-1170-brief.md`, lines 1–61, with its predecessor learnings) and `docs/plans/2026-11-09-channel-slack-design.md` §4 steps 2 and 4. Planner decisions: `.claude/memory/decisions/2026-11-20-TASK-1170.md`. The code was read at `bb0c61513` (main); file:line refs below are from that read.

---

## What the brief got wrong (evidence; the plan follows the code)

1. **"the bot's real `name` field (read back from `users.info`, stored as `bot_handle`)".** Already built. TASK-1167's `keepHandle` reads `users.info` at the Allow and stores it (`bots.ts:717-739` → `store.setBotHandle`); the row exposes `botHandle` (`store.ts:53-57`). No migration, no store change.
2. **"`users.lookupByEmail`, already allowed by `users:read.email`".** The scope allows it (`manifest.ts:35-45`), but channel-slack's Slack client is a fixed method allowlist ("eighteen methods … and no others", `slack-api.ts:7`, `SlackMethod` `:234-252`) with no such method. Task 2 adds it. Its answer is used for the user id only: whether its user object carries `is_email_confirmed` is unmeasured, so admission runs on `users.info` (the measured path, `admission.ts:136-152`).
3. **Copy "An AX admin declined @<name>."** COPY never names the product: `copy.test.ts:161-163` fails any line matching `\bAX\b` (the deployment is white-labeled). It becomes "An admin declined …".
4. **"an Approve URL button that opens Admin > Slack".** No URL does that today. `?slack=` and `?slack-bot=…&from=admin` both open Admin › Slack but also toast an outcome (`channel-web/src/App.tsx:280-320`). Task 4 adds a plain deep link, `/?admin=slack`.
5. **"Decline click: through the shared install's existing interactions route (`interactions.ts`, `answers.ts`)".** The route reads only a prompt's Allow/Deny (`blocks.ts:50-54 actionOf`, `PROMPT_ID_RE`, `interactions.ts:170-176`) and hands every click to the prompt gate (`answers.ts`), which keys on the in-memory prompt registry. Decline gets its own action id, a shared-install-only read in the route, and its own gate (a new file). `answers.ts` is not edited.
6. **"then the same decline the Admin tab runs (TASK-1169)".** That decline takes `{ requestId }` only and deletes without reading (`bot-requests.ts:298-304`). It has to learn who declined (the redraw names them; the owner DM is skipped when the decliner is the requester) and read the request before deleting it (its requester and bot name). Task 7 changes its signature, and `bot-request-routes.ts:125-127` passes the admin.
7. **Builder note "where it approves (bot-callback `finish()`)".** Approve and go-live are two events. Approve is `bot-requests.ts approve` → `bots.create` (the request is deleted, a pending bot made): the admins' DMs are redrawn then. Go-live is the approver's Allow, `bot-callback.ts` → `bots.finish` → `connected`: the owner's "is live" DM goes then.
8. **Builder note "mcp-oauth `captureRouteServices` e2e stubs + `plugin.test.ts` pin".** Not affected: mcp-oauth neither calls nor registers the new hook (`git grep "'auth:" packages/mcp-oauth` shows only `require-user`/`get-user` stubs). The pins that do change are listed in Task 9.
9. **Each DM's redraw needs the DM channel id.** `chat.update` needs the IM's `D…` id, not the user id the message was posted to. Slack returns it as `channel` in `chat.postMessage`'s answer. `postBlocks` (`slack-api.ts:631-648`) needs a thread and reads only `ts`, so Task 2 adds a DM post that reads both.
10. **Not refuted, INFERRED:** `chat.postMessage` with a user id as `channel` posts into the bot's DM with that person (the App Home Messages tab, on and writable for the shared app, `manifest.ts:124-127`) with `chat:write` only. `im:write` is for `conversations.open`, which we don't call. That's from Slack's docs and wasn't measured here, so the walk checks it. If Slack refuses, no DM goes out, the failure is logged code-only, and the request still waits in Admin › Slack.

## Design decisions (rows in the decisions shard)

- **D1. The hook.** `auth:list-admins`: `{}` → `{ admins: Array<{ userId: string; email: string }> }`. It returns every account whose role is admin now AND whose email a provider verified, oldest first (`created_at`, then `id`). Nothing else: no name, role or domain verdict. A strict zod `returns` schema, host-internal only. It goes in RULE 1 of the repo scan, so only auth-better and channel-slack may name it. channel-slack takes it in `calls` (required), as it takes the other auth hooks.
- **D2. Who gets a DM.** For each listed admin except the requester (first `BOT_REQUEST_DMS_MAX` = 20): `users.lookupByEmail` gives the Slack id only; `admitSender` (users.info) must admit them (full member of the shared install's workspace, confirmed email); and `auth:find-user-by-email` on THAT confirmed email must answer the same AX user. That's the click gate's own identity rule, so everyone DMed can also Decline. The requester's owner DMs use the same rule, with their email from `auth:get-user`.
- **D3. DM records live in memory.** Each record holds the request's subject as drawn, every `{ channel, ts }` posted, and its close. The redraw is best-effort (card), the host is pinned to one replica (`mutex.ts:6-8`), and the prompt registry already lives in memory. TASK-1171 and TASK-1180 are changing `migrations.ts`/`store.ts`/`channel-store.ts` in parallel. Bounded: `BOT_REQUEST_DM_RECORDS_MAX` = 200, `BOT_REQUEST_DM_TTL_MS` = 7 days. After a restart, old DMs aren't redrawn when someone else answers. (As built, after review: the request is on Postgres, so a Decline clicked in one still declines a request that's open, and the DM it was clicked in is redrawn; on a closed request the click says "This request was already handled.")
- **D4. Abuse bound.** At most `BOT_REQUEST_FANOUTS_MAX` = 3 fan-outs per requester per `BOT_REQUEST_FANOUT_WINDOW_MS` = 10 minutes (an ask/cancel loop otherwise makes the shared bot DM every admin each time, and burns the `users.info` budget everyone's admission shares). A fan-out stops at its first temporary Slack failure (`ratelimited`, `timeout`, `network`, `http-5xx`, Slack's transient codes). A skipped or stopped fan-out is logged code-only, and the request still shows in Admin › Slack.
- **D5. Off the request path.** Every DM runs after the app lock is released, tracked by the plugin lifetime (`lifetime.ts`), and is never awaited by a route. A DM failure never changes an answer.
- **D6. Decline.** `decline({ requestId, actorUserId })`: under the app lock it reads the request (404 when gone), deletes it (404 if that fails to delete), logs, then (after the lock) closes the DMs as declined by the actor. No in-lock admin re-check, as before (it only takes something away; TASK-1169's lock map).
- **D7. The click gate** (new `bot-request-click.ts`). Checks in order: bot token → admission (refused: silence; temporary: "try again") → `auth:find-user-by-email` → `auth:get-user` isAdmin (either fails: "Only an admin can answer this.") → `decline` (404: "This request was already handled."; a fault: `COPY.promptFailed`). The admin check comes before anything reads the request, so a non-admin learns nothing about it. Decline is at most once by construction: the domain deletes under the lock, and a second click gets 404.
- **D8. Redraws.** An approve that made the bot, and every decline, redraw each recorded DM: the same subject, and "<name> approved this." / "<name> declined this." where the buttons were. A cancel, an agent's deletion and a reset don't (YAGNI); the click fallback covers them. A close that lands while the fan-out is still posting stops new DMs at once, and any DM posted in that window is redrawn exactly once.
- **D9. Owner notices**, from the shared bot, only when the approver (or decliner) isn't the requester. Live: "@handle is live" + `/invite`, or the bot's name when no handle was kept, plus the agent's shared-app channels (they now need the bot), at most `BOT_LIVE_DM_CHANNELS_MAX` = 10 named. Declined: "An admin declined …". The rule lives in `bot-request-dms.ts` only; callers call unconditionally.
- **D10. Copy.** The admin DM's subject frames outside names as `plain_text`, like `hostSubject`/`skillSubject`. Its notification text is a generic COPY line naming nobody. Slack shows the requester by display name only (Slack keeps a copy under its own retention: design §8 Q4), falling back to "A team admin". The agent is named as its requester sees it; when it can't be named, the subject leaves it out. No line names the product.
- **D11. Approve link** = `<publicOrigin>/?admin=slack`. channel-web reads that exact pair once and strips it. For `role === 'admin'` it opens Admin › Slack with no toast; for anyone else it means nothing.
- **D12. Footprint** (TASK-1171 and TASK-1180 are building in parallel): don't edit `bots.ts`, `agent-routes.ts`, `slack-apps.ts`, `store.ts`, `migrations.ts`, `channel-store.ts`, `router.ts`, `admin-routes.ts`, `answers.ts` or any `channel-web/src/components/workspace/*` file.

## Boundary review (paste into the PR)

**`auth:list-admins`** (new service hook, `@ax/auth-better`):
- **Alternate impl:** an OIDC/SCIM directory group (e.g. an "AX admins" group in Okta, each member with a verified address), or a static admin list from config.
- **Payload field names that might leak:** none (`admins`, `userId`, `email`).
- **Subscriber risk:** none (a service hook with one caller). Caller risk: using `email` as a Slack identity on its own. channel-slack never does: every DM target is re-proved through Slack's `users.info` (full member, confirmed email) and mapped back through `auth:find-user-by-email`.
- **Wire surface:** none. Host-internal; never an HTTP route or an IPC action (ipc-core's `dependencies.test.ts` keeps every `auth:` hook off the runner's actions; `scripts/__tests__/channel-slack-boundaries.test.js` keeps every other package from naming it).

No other hook, IPC action or route changes. The interactions route gains an action id, not a route.

## Global Constraints

- **Never under the app lock:** no `bot-request-dms.ts` method is called inside `lock.run`, and none takes the lock. Every method returns a promise that never rejects; request paths `void` it and never await it.
- **Log lines are code-only:** an `installId`, a `requestId` (our own random id), a `stage`, a `reason`, a `code` from `logCode(err)`, or counts. Never an email, a name, a person's or an agent's id, a Slack user or channel id, a ts, or a token.
- **Slack-bound text:** names from outside reach Slack only as `plain_text` (the DM subject) or through COPY's `shown()` in mrkdwn. A notification (`text`) holds no outside text. No line holds `<`, `>`, `<!`, `<@`, `<#` or a bare broadcast word (copy.test.ts's blanket checks cover every new line: add each to `ARGS`).
- **Scopes:** no change to `BOT_SCOPES`/`DEDICATED_BOT_SCOPES`. The only new egress is `users.lookupByEmail` on `https://slack.com/api/`.
- Fake tokens in tests keep Slack's prefix with short digit groups (`.claude/memory/mistakes/2026-11-13-TASK-1093.md`).
- Under zsh, keep vitest file lists in an array: `T=(a.test.ts b.test.ts); pnpm --filter @ax/channel-slack exec vitest run "${T[@]}"`.
- Docker-backed tests (auth-better's contract tests, channel-slack `plugin.test.ts`, the presets) need `DOCKER_HOST` set and `AX_TESTCONTAINER_START_SLOT_WAIT_MS=600000` (never above 600000). Sibling builders share the daemon: a slow start is load, not a hang.
- channel-web's tsc checks its test files: run `pnpm --filter @ax/channel-web build` after its tests pass. channel-slack's tsc does NOT check its tests, so add new `SlackApi` methods to every shared fake by hand (`fake-slack-config.ts`, plus any fake the new tests use).
- Mutation testing (yolo-ship Phase 4): commit before mutating; restore with `git checkout HEAD -- <path>`; `git status --short` empty between mutants. Mutants worth running are listed per task.

## Review Focus

1. **A Slack member who isn't an AX admin (or no longer is) clicks Decline.** They get one private "Only an admin can answer this." Nothing reads the request and nothing changes. Task 8: `gate › a member who is not an AX admin …`.
2. **A Slack account whose confirmed email maps to someone else, or to nobody, gets no DM.** That covers an admin whose AX email is unverified, off an approved domain, or ambiguous. Task 5: `opened › skips …`.
3. **A request is approved or declined while the fan-out is still posting.** No new DM goes out after the close, and a DM posted in that window is redrawn once. Task 5: `closed › a close during the fan-out …`.
4. **Slack refuses the DM** (`chat.postMessage` to a user id, a rate limit, a missing token). The ask, approve and decline still answer exactly as before, and the request still waits in Admin › Slack. Tasks 5 and 7.
5. **No notice runs under the app lock**, so a slow Slack can't hold up approvals, connects or Allows. Task 7: `… after the lock is free`.
6. **An ask/cancel loop can't flood the admins.** The fourth fan-out in 10 minutes by one requester DMs nobody. Task 5.

---

## File map

| File | Responsibility | Task |
|---|---|---|
| `packages/auth-better/src/types.ts`, `index.ts`, `plugin.ts` | `auth:list-admins` | 1 |
| `packages/auth-better/src/__tests__/list-admins.test.ts` (new) | its contract | 1 |
| `scripts/__tests__/channel-slack-boundaries.test.js` | caller allowlist gains the hook | 1 |
| `packages/channel-slack/src/slack-api.ts` | `usersLookupByEmail`, `postDirect` | 2 |
| `packages/channel-slack/src/copy.ts`, `blocks.ts` | DM copy, Block Kit, action ids | 3 |
| `packages/channel-web/src/lib/slack-admin-link.ts` (new), `App.tsx` | `/?admin=slack` | 4 |
| `packages/channel-slack/src/bot-request-dms.ts` (new) | fan-out, DM records, redraws, owner notices | 5, 6 |
| `packages/channel-slack/src/limits.ts` | the new bounds | 5, 6 |
| `packages/channel-slack/src/admission.ts` | export `isTemporarySlackCode` | 5 |
| `packages/channel-slack/src/bot-requests.ts` | `agentSeenBy` exported (5); dms calls, `decline` signature (7) | 5, 7 |
| `packages/channel-slack/src/bot-request-routes.ts` | Decline passes the admin | 7 |
| `packages/channel-slack/src/bot-callback.ts` | live notice after the lock | 7 |
| `packages/channel-slack/src/interactions.ts` | reads a Decline click | 8 |
| `packages/channel-slack/src/bot-request-click.ts` (new) | the Decline gate | 8 |
| `packages/channel-slack/src/plugin.ts` | wiring, manifest `calls`, header | 9 |
| `presets/k8s/src/__tests__/preset.test.ts`, `channel-slack-composition.test.ts`, `presets/memory/src/__tests__/canary.test.ts` | pins and stubs | 9 |
| `docs/plans/2026-11-09-channel-slack-design.md`, `manifest.ts` header, `.changeset/` | stale lines, as-built | 10 |

---

### Task 1: `auth:list-admins` in @ax/auth-better [tier: sensitive] (security-checklist)

Sensitive: a new hook that hands admins' email addresses to another plugin. Its surface, its caller allowlist and its "verified only" rule are the security decisions.

**Files:**
- Modify: `packages/auth-better/src/types.ts` (after `IsApprovedEmailOutput`)
- Modify: `packages/auth-better/src/index.ts` (export the two types)
- Modify: `packages/auth-better/src/plugin.ts` (header `:116-138`, schemas `:67-74`, `registers` `:167-174`, services `:312-330`, a `listAdmins()` beside `getUserById` `:584-602`)
- Test (new): `packages/auth-better/src/__tests__/list-admins.test.ts` (mirror `find-user-by-email.test.ts`'s harness: Postgres testcontainer, `createTestHarness` with pass-through envelope hooks, rows seeded after boot)
- Modify: `scripts/__tests__/channel-slack-boundaries.test.js` (header `:1-14`, `AUTH_EMAIL_HOOKS` `:68`, the describe title, `expect.arrayContaining` `~:210`, case rows `~:225-240`)

**Interfaces — Produces (types.ts):**
```ts
/**
 * `auth:list-admins` input (TASK-1170): nothing.
 *
 * CONTRACT — every auth implementation registering this hook MUST keep these:
 *   - Host-internal only. Never an HTTP route or an IPC action.
 *   - Every account that is an admin NOW and whose email a provider verified.
 *     An admin whose email nobody verified is left out: an unproved address
 *     could be someone else's, and the caller writes to that address's owner.
 *   - Each as `{ userId, email }`, the verified email as stored. Nothing else:
 *     no name, no role, no domain verdict.
 *   - Oldest account first (then by id), so callers that cap the list keep the
 *     same people. `{ admins: [] }` when there are none.
 *   - No log line, whatever the answer: the addresses are personal data.
 * Callers use the email only to find that person in another system they
 * already trust, and must prove the match there (channel-slack maps the
 * other system's confirmed email back through `auth:find-user-by-email`).
 */
export type ListAdminsInput = Record<string, never>;
/** `auth:list-admins` output. See `ListAdminsInput` for the contract. */
export interface ListAdminsOutput {
  admins: Array<{ userId: string; email: string }>;
}
```
**plugin.ts:** `const ListAdminsOutputSchema = z.object({ admins: z.array(z.object({ userId: z.string().min(1), email: z.string().min(1) }).strict()) }).strict();`. `registerService<ListAdminsInput, ListAdminsOutput>('auth:list-admins', PLUGIN_NAME, (_ctx) => listAdmins(localDb), { returns: ListAdminsOutputSchema })`. `listAdmins` selects `id, email` from `auth_better_v1_users` where `role = 'admin'` and `email_verified = true`, ordered by `created_at` then `id`, and maps rows to `{ userId: id, email }`. It ignores its input, logs nothing, and lets a database fault throw.

- [ ] **Step 1: Write the failing contract tests** (`list-admins.test.ts`, describe `auth:list-admins contract`):
  - `lists every admin whose email is verified, oldest first, as { userId, email } and nothing else`. Seed: admin A verified (older), admin B verified (newer), admin C unverified, user D verified. Answer: `{ admins: [{ userId: A, email: a }, { userId: B, email: b }] }`, `toStrictEqual`.
  - `breaks a created_at tie by id`. Two verified admins share one `created_at`; insert the higher id FIRST, so a missing tie-break shows (TASK-1169 row 23's lesson). Expect id order.
  - `with no admins, or none verified, answers { admins: [] }`.
  - `reads the table at call time`: demote A (`role = 'user'`) and he's gone; verify C and she appears.
  - `is registered with a strict returns schema`: spy on `HookBus.prototype.registerService` before boot (TASK-1092's pattern). The captured `opts.returns` rejects `{ admins: [{ userId: 'u', email: 'e', name: 'n' }] }` and `{ admins: [], more: 1 }`, and accepts `{ admins: [] }`.
  - `logs no address`: capture the logger during a call with two admins; no captured line or field contains either email.
  - `the manifest registers it`: `createAuthBetterPlugin().manifest.registers` contains `'auth:list-admins'`.
- [ ] **Step 2: Run, expect FAIL.** `pnpm --filter @ax/auth-better exec vitest run src/__tests__/list-admins.test.ts` (Docker env per Global Constraints).
- [ ] **Step 3: Implement** types, export, schema, `listAdmins`, `registerService`, `registers`. Header comment: add "`auth:list-admins` (TASK-1170): host-internal list of the admins with a verified email, for @ax/channel-slack's DMs; returns only `{ userId, email }`".
- [ ] **Step 4: Run, expect PASS**, plus the whole auth-better suite (`pnpm --filter @ax/auth-better test`).
- [ ] **Step 5: The caller allowlist.** In `channel-slack-boundaries.test.js`: add `'auth:list-admins'` to `AUTH_EMAIL_HOOKS`. Header RULE 1 becomes three hooks: "the third lists the admins and their verified emails, so a caller learns who can run the deployment". Update the describe title and the `arrayContaining` list. Add case rows: an offender (`packages/agents/src/x.ts`, `bus.call('auth:list-admins', ctx, {})`), a clean channel-slack call, and the clean auth-better `registerService`. The three allowlisted preset files keep their entries; append "and `auth:list-admins`" to the reason of each that will stub or pin it (canary, composition, preset.test.ts). Run `pnpm test:scripts`; expect PASS (no other package names the hook).
- [ ] **Step 6: Mutants** (commit first): drop `email_verified = true` → test 1 fails; drop `role = 'admin'` → test 1; drop the `id` tie-break → test 2; add `name` to each row → test 5 / every call throws `invalid-return`. Restore each with `git checkout HEAD --`.
- [ ] **Step 7: Commit:** `[TASK-1170] auth-better: auth:list-admins, the admins with a verified email`.

---

### Task 2: Slack client — `users.lookupByEmail` and a DM post [tier: mechanical]

**Files:**
- Modify: `packages/channel-slack/src/slack-api.ts` (header `:1-36`: "eighteen" → "nineteen", add `users.lookupByEmail` to the form-only list; interface `:156-232`; `SlackMethod` `:234-252`; implementations beside `usersInfo` `:567-573` and `postBlocks` `:631-648`)
- Modify: `packages/channel-slack/src/__tests__/fake-slack-config.ts` (both new methods `notHere` in `fakeSlack`'s api, `:144-145` style)
- Test: `packages/channel-slack/src/__tests__/slack-api.test.ts` (`everyMethod` `~:160-187`, `FORM_METHODS` `:190-200`, new cases)

**Interfaces — Produces:**
```ts
/**
 * The Slack user id `email` belongs to in the token's workspace
 * (`users.lookupByEmail`, `users:read.email`). Only the id is read: who that
 * is (a full member? a confirmed email?) is users.info's to say. Slack's
 * `users_not_found` is a SlackApiError with that code.
 */
usersLookupByEmail(botToken: string, email: string): Promise<string>;
/**
 * A top-level message to one person by their user id: Slack posts it in the
 * bot's DM with them (`chat.postMessage`). Answers that DM's channel id
 * (`chat.update` needs it; a user id won't do) and the message's ts.
 */
postDirect(
  botToken: string,
  a: { user: string; text: string; blocks?: readonly SlackBlock[] },
): Promise<{ channel: string; ts: string }>;
```
- `usersLookupByEmail`: `call('users.lookupByEmail', bearer(token), form({ email }))`; `idOf(user.id)` when `user` is a record, else `bad-response`.
- `postDirect`: `call('chat.postMessage', bearer(token), json({ channel: a.user, text: a.text, ...(a.blocks !== undefined ? { blocks: a.blocks } : {}), unfurl_links: false, unfurl_media: false }))`; `idOf(r.channel)` and `idOf(r.ts)`, either missing → `bad-response`. No `thread_ts`.

- [ ] **Step 1: Failing tests:**
  - `every method POSTs …` (existing): `everyMethod` gains both (`['users.lookupByEmail', () => api.usersLookupByEmail(BOT, 'ada@example.com')]`, `['chat.postMessage', () => api.postDirect(BOT, { user: 'U07ADA00001', text: 'hi' })]`). Give `EVERY_FIELD` a `user: { id }` and a `channel` id if it lacks them.
  - `FORM_METHODS` gains `'users.lookupByEmail'` (the content-type check).
  - `usersLookupByEmail sends the email as a form field and answers the user's id`: the body is exactly `email=…`, with a bearer token.
  - `usersLookupByEmail: an answer with no usable id is bad-response; users_not_found keeps its code; the error never holds the address` (`err.message` is exactly `slack users.lookupByEmail: users_not_found`).
  - `postDirect posts to the user id at the top level with unfurls off, and answers the DM's channel and the ts`: no `thread_ts` key; `blocks` only when given.
  - `postDirect: an answer missing the channel or the ts is bad-response`.
- [ ] **Step 2: Run, expect FAIL** (`src/__tests__/slack-api.test.ts`).
- [ ] **Step 3: Implement**, and add both methods to `fakeSlack` as `notHere`.
- [ ] **Step 4: Run, expect PASS** (the file, then the package).
- [ ] **Step 5: Commit:** `[TASK-1170] channel-slack: look a person up by email, and DM them`.

---

### Task 3: Copy and Block Kit for the DMs [tier: mechanical]

**Files:**
- Modify: `packages/channel-slack/src/copy.ts` (header `:5-32` gains the DM group; new keys in `COPY`)
- Modify: `packages/channel-slack/src/blocks.ts` (header; action ids after `:42-44`; two draw functions)
- Test: `packages/channel-slack/src/__tests__/copy.test.ts` (the exact key list `:95-159`, `ARGS` `:20-82`, a new describe)
- Test: `packages/channel-slack/src/__tests__/blocks.test.ts`

**Interfaces — Produces (suggested words; keep the rules, refine the voice):**
```ts
// copy.ts — a bot request's DMs (TASK-1170). mrkdwn unless marked.
botRequestAsked: 'A team asked for its own Slack bot.',            // notification + fallback: names nobody
botRequestSubject: (i: { requester: string; botName: string; agentName: string | null }) =>
  i.agentName === null
    ? `${i.requester} wants to add @${i.botName} for a team agent.`
    : `${i.requester} wants to add @${i.botName} (${i.agentName} agent).`, // plain_text ONLY, raw, cleaned at draw
botRequestApprove: 'Approve',                                         // plain_text button label
botRequestDecline: 'Decline',                                         // plain_text button label
botRequestHow: "Approve opens Slack settings in the web app, where you add the bot with your own configuration token. Nothing secret goes through Slack.",
botRequestApproved: (name: string) => `${shown(name)} approved this.`,
botRequestDeclined: (name: string) => `${shown(name)} declined this.`,
botRequestOnlyAdmin: 'Only an admin can answer this.',               // private, to a refused clicker
botRequestHandled: 'This request was already handled.',              // private, a click on a closed request
botLiveForOwner: (bot: { botName: string; handle: string | null }, channels: readonly string[], more: number) => string,
// handle: `@${shown(h, '@')} is live. Invite it to a channel with /invite @${shown(h, '@')}.`
// none:   `${shown(botName)} is live. Invite it to a channel with /invite.`
// + when channels.length > 0: ` These channels still need it: #a, #b and #c` (+ ` and ${more} more`) `. Run /invite … in each one.`
botDeclinedForOwner: (botName: string) =>
  `An admin declined your request for @${shown(botName, '@')}. You can ask again from the agent's Slack settings in the web app.`,
```
```ts
// blocks.ts
export const ACTION_BOT_REQUEST_APPROVE = 'ax_bot_request_approve'; // a URL button: its click is ignored
export const ACTION_BOT_REQUEST_DECLINE = 'ax_bot_request_decline';
/** The admin's DM: the subject (plain_text), Approve (url) and Decline (value = the request id), then botRequestHow. `text` is botRequestAsked. */
export function botRequestBlocks(i: { subject: string; requestId: string; approveUrl: string }): { text: string; blocks: SlackBlock[] };
/** The same DM once answered: the same subject, then `line` where the buttons were. `text` is `line`. */
export function botRequestOutcomeBlocks(i: { subject: string; line: string }): { text: string; blocks: SlackBlock[] };
```
The subject section is `plain_text` with `emoji: false`, cleaned by `cleanPromptSubject`. When nothing printable is left, it falls back to `COPY.botRequestAsked`, never `heldAsked`: give `subjectSection` a fallback parameter, or add a sibling. Both functions take the subject exactly as the fan-out built it (blocks.ts `:31-33`'s rule). Approve: `{ type: 'button', text: plainText(COPY.botRequestApprove), style: 'primary', url: i.approveUrl, action_id: ACTION_BOT_REQUEST_APPROVE }`, with no `value`. Decline: `{ type: 'button', text: plainText(COPY.botRequestDecline), action_id: ACTION_BOT_REQUEST_DECLINE, value: i.requestId }`. `actionOf` stays prompt-only.

- [ ] **Step 1: Failing tests.**
  - copy.test.ts: the exact key list gains the eleven keys. `ARGS` gets every function. Hostile names go through the blanket "never pings", "never names the product" and "no bare broadcast" loops: `botRequestApproved`/`botRequestDeclined` with `HOSTILE`; `botLiveForOwner` with `{ botName: HOSTILE, handle: HOSTILE }`, `{ handle: null }`, `handle: 'here'`, and channels `[HOSTILE]` with more `0` and `3`; `botDeclinedForOwner(HOSTILE)`. `botRequestSubject` takes benign args only (it's `plain_text`, like `skillSubject`; its hostile case lives in blocks.test.ts).
  - copy.test.ts, a new describe `COPY: a bot request's DMs (TASK-1170)`. No line holds `<` or `>` of its own or a Markdown link. A hostile name shows escaped and marked. The live line names the handle after `@`, or the bot's name without one, and lists channels with `#`, the count past the cap, and the `/invite` instruction. The declined line says how to ask again. The subject has a variant with and without the agent. None says "AX".
  - blocks.test.ts: `botRequestBlocks` draws the subject as plain_text (a hostile subject stays as typed, never in `text`); `text` is `COPY.botRequestAsked`. Approve carries the url and its action id and no value; Decline carries its action id and the request id. Context is `botRequestHow` as mrkdwn. `botRequestOutcomeBlocks` keeps the subject section identical and puts the line where the buttons were, with nothing left to click and `text === line`. An empty subject falls back to `botRequestAsked`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Copy header: add the DM group, saying the subject frames outside names as plain_text and is never mrkdwn, a notification or a log.
- [ ] **Step 4: Run, expect PASS**; commit `[TASK-1170] channel-slack: what the bot says about a bot request in a DM`.

---

### Task 4: channel-web — `/?admin=slack` opens Admin › Slack [tier: mechanical]

No visual change and no new component (invariant 6 is untouched). It reuses the state `?slack=` already sets.

**Files:**
- Create: `packages/channel-web/src/lib/slack-admin-link.ts`
- Modify: `packages/channel-web/src/App.tsx` (read once beside `slackReturn` `:144-157`; pass to `AppContent`; fold into the initial `adminSettingsOpen`/`adminSettingsTab` `:285-300`)
- Test (new): `packages/channel-web/src/lib/__tests__/slack-admin-link.test.ts`
- Test (new): `packages/channel-web/src/__tests__/slack-admin-link-app.test.tsx` (copy `slack-bot-return-app.test.tsx`'s mocks)

**Interfaces — Produces:**
```ts
/**
 * A link that opens Admin › Slack (TASK-1170): @ax/channel-slack's DM to an AX
 * admin about a bot request carries `<origin>/?admin=slack` on its Approve
 * button. Only that exact pair is read; nothing from the URL reaches the page.
 * For anyone but an admin it means nothing. Keep the literal in step with
 * channel-slack's `bot-request-dms.ts`.
 */
export function readSlackAdminLink(search: string): boolean;
/** `search` without `admin=slack`, keeping everything else ('' when nothing is left). */
export function withoutSlackAdminLink(search: string): string;
```
- [ ] **Step 1: Failing tests.** Lib: `?admin=slack` → true; `?admin=Slack`, `?admin=`, `?admin=slack-x`, none → false; strip keeps other params, and `admin=` with another value is left alone. App: an admin opening `/?admin=slack` lands in Admin › Slack with no toast, and the address becomes `/`. A non-admin gets the workspace, no Settings, and a cleaned address. With `?slack=connected` too, the install's toast still shows once.
- [ ] **Step 2: Run, expect FAIL** (`pnpm --filter @ax/channel-web exec vitest run …`).
- [ ] **Step 3: Implement**: `useState(() => readSlackAdminLink(window.location.search))`, an effect that strips it like `slackReturn`'s, and AppContent opening Settings on `'slack'` when `user.role === 'admin'`.
- [ ] **Step 4: Run, expect PASS**; `pnpm --filter @ax/channel-web build` (tsc checks tests here); commit `[TASK-1170] channel-web: a link that opens Admin › Slack`.

---

### Task 5: The admins' DMs — fan-out, records, redraws [tier: sensitive] (security-checklist)

Sensitive: it maps outside identities (Slack accounts) to AX admins, sends names chosen by team admins into Slack, bounds an amplification a team admin can trigger, and handles the race between a fan-out and a close.

**Files:**
- Create: `packages/channel-slack/src/bot-request-dms.ts`
- Modify: `packages/channel-slack/src/limits.ts` (after `BOT_REQUESTS_MAX` `:65`): `BOT_REQUEST_DMS_MAX = 20`, `BOT_REQUEST_FANOUTS_MAX = 3`, `BOT_REQUEST_FANOUT_WINDOW_MS = 600_000`, `BOT_REQUEST_DM_RECORDS_MAX = 200`, `BOT_REQUEST_DM_TTL_MS = 604_800_000`, each with a one-line why
- Modify: `packages/channel-slack/src/admission.ts` (`:164-177`): export `isTemporarySlackCode(code: string | undefined): boolean` over `TEMPORARY_LOOKUP_CODE`; `isTemporaryLookupFailure` uses it
- Modify: `packages/channel-slack/src/bot-requests.ts`: move `agentSeenBy` (`:311-333`) to module level and export it as `agentSeenBy(bus, ctx, r: Pick<BotRequest, 'agentId' | 'requestedByUserId' | 'requestId'>, onFault: (err) => void): Promise<{ name: string | null; teamId: string | null }>`. `name` is null when it can't be named. `list` maps null to `AGENT_FALLBACK`, which keeps its behavior byte-identical: TASK-1169's list tests stay green unchanged.
- Test (new): `packages/channel-slack/src/__tests__/bot-request-dms.test.ts`

**Interfaces — Produces:**
```ts
export interface BotRequestDmsDeps {
  bus: HookBus;
  api: Pick<SlackApi, 'usersLookupByEmail' | 'usersInfo' | 'postDirect' | 'updateMessage'>;
  installs: Pick<InstallStore, 'current' | 'get'>;
  channels: Pick<ChannelStore, 'listForAgent'>;            // Task 6
  secrets: Pick<SecretStore, 'get'>;
  /** Every DM runs tracked: shutdown drains it. */
  lifetime: Lifetime;
  /** For the Approve link: `<origin>/?admin=slack`. */
  publicOrigin: string;
  logger: Logger;
  /** Epoch ms: the fan-out window and the records' TTL. */
  now: () => number;
}
export interface BotRequestDms {
  /** A request just opened: DM the admins. Call AFTER the app lock; never await it on a request path. Never rejects. */
  opened(i: { requestId: string; agentId: string; requesterUserId: string; botName: string }): Promise<void>;
  /** A request was approved (a bot made) or declined: redraw the admins' DMs; a decline also tells the requester (Task 6). Never rejects. */
  closed(i: { requestId: string; requesterUserId: string; botName: string; outcome: 'approved' | 'declined'; byUserId: string }): Promise<void>;
  /** A bot just went live (Task 6). Never rejects. */
  live(i: { installId: string }): Promise<void>;
}
export function createBotRequestDms(d: BotRequestDmsDeps): BotRequestDms;
```
**Behavior:**
- **Shared workspace:** `installs.current()` active, its `teamId`, and `secrets.get(shared, 'bot-token')`. Without them nothing is sent, logged `slack_bot_request_dm_failed { requestId, stage: 'workspace' | 'bot-token', code }`.
- **`memberFor(token, teamId, ax: { userId, email })` → Slack user id | null** (shared with Task 6): `api.usersLookupByEmail` (`users_not_found` → null, counted as skipped, no warn line) → `admitSender(api, token, id, teamId)` (refused → null) → `findSenderUser(bus, lookupCtx, admission.email, { installId, logger })` must `=== ax.userId` (else null). `lookupCtx` is answers.ts's (`:166-167`: no agent, userId `''`). `findSenderUser` logs its own code-only `slack_sender_not_mapped` on a miss, which is fine. A temporary code at any step (`isTemporarySlackCode`, or `isTemporaryLookupFailure` for admission) is surfaced so the fan-out can stop.
- **Every public method** is `async` and returns `d.lifetime.track(work).catch((err) => log(…code-only…))`, so its promise never rejects (a closed lifetime's `LifetimeClosedError` included). Tests await it; production `void`s it.
- **`opened`, synchronous part:** if the requester has had `BOT_REQUEST_FANOUTS_MAX` fan-outs in the window, log `slack_bot_request_dms_skipped { requestId, reason: 'too-many-asks' }` and resolve. Otherwise record the fan-out time and create the request's record `{ subject: null, sent: [], closing: false, line: null, at }`, pruning expired or excess records and limiter entries. All of this happens before anything is awaited, so a `closed` that follows always finds the record.
- **`opened`, tracked part:**
  1. `bus.call('auth:list-admins', ctx, {})`. A fault, or an answer that isn't `{ admins: [...] }`, sends nothing (logged stage `admins`). Entries without a non-empty string `userId` and `email` (≤ `EMAIL_MAX`) are skipped.
  2. Drop the requester. Take the first `BOT_REQUEST_DMS_MAX`.
  3. Subject: `COPY.botRequestSubject({ requester: personName(…, { allowEmail: false, fallback: 'A team admin' }), botName, agentName: (await agentSeenBy(…)).name })`, with the agent asked as the requester. Store it on the record.
  4. For each admin, in order: stop if `record.closing`; `memberFor`; `api.postDirect(token, { user, ...botRequestBlocks({ subject, requestId, approveUrl }) })`; push `{ channel, ts }`; then, if `record.line !== null`, redraw that one DM now.
  5. A temporary failure stops the loop (stage and code logged once). Any other per-admin failure is logged and the loop goes on.
  6. One summary line: `slack_bot_request_dms_sent { requestId, sent, skipped }`.
- **`closed`, synchronous part:** `record.closing = true` (if a record exists).
- **`closed`, tracked part:** line = `COPY.botRequestApproved|Declined(personName(byUserId, { allowEmail: false, fallback: 'An admin' }))`. Set `record.line`, snapshot `record.sent`, and redraw each with `api.updateMessage(token, { channel, ts, ...botRequestOutcomeBlocks({ subject: record.subject, line }) })`. Setting the line and taking the snapshot happen in one synchronous step, so a DM pushed later is the fan-out's to redraw (step 4), and every DM is redrawn exactly once. A failed redraw is logged and the rest go on. No record means no redraw. Then Task 6's owner notice for `declined`.
- `approveUrl` = `${withoutTrailingSlashes(publicOrigin)}/?admin=slack` (the literal channel-web reads, Task 4).

- [ ] **Step 1: Failing tests** (`bot-request-dms.test.ts`). The world is a HookBus with stubbed `auth:list-admins`, `auth:find-user-by-email`, `auth:get-user` and `agents:resolve`, plus `memoryStore` with a seeded active shared install, `memoryChannelStore`, a fake vault/secrets with the bot token, a recording fake Slack (lookup by email table, users.info table, posts with D-ids and ts, updates), a real `createLifetime()`, and a controllable clock. Await the method's returned promise.
  - `opened › DMs every AX admin who is a full member and whose confirmed email maps back to them`. Each DM: the subject names the requester's display name, the bot and the agent; Approve's url is `https://…/?admin=slack`; Decline's value is the request id; the text names nobody.
  - `opened › skips the requester, an admin Slack doesn't know, a guest, a deactivated or unconfirmed member, and one whose Slack email maps to another account or to none`. Nobody's email, name or Slack id is in any log line.
  - `opened › no shared install, an inactive one, no bot token, or an auth:list-admins fault sends nothing, logged code-only; it never rejects`.
  - `opened › stops at the first temporary Slack failure (ratelimited on lookup; timeout on post): no further Slack call`.
  - `opened › one admin's failed post doesn't stop the others; the summary line counts sent and skipped`.
  - `opened › DMs at most BOT_REQUEST_DMS_MAX admins, in the order auth listed them`.
  - `opened › a requester's fourth ask inside the window DMs nobody, logged too-many-asks; one window later it DMs again`.
  - `opened › the requester shows by display name, never email; with none, "A team admin"; an agent the requester can't see leaves the agent out of the subject`.
  - `closed › approved: every DM the fan-out posted is redrawn: the same subject, "<name> approved this." where the buttons were`.
  - `closed › declined: the same, "<name> declined this."; with no display name, "An admin"`.
  - `closed › a close during the fan-out: no DM after the close; a DM posted while the close looked up the name is redrawn once` (hold `postDirect` and `auth:get-user` on deferreds to force each interleaving).
  - `closed › a request with no record (skipped, forgotten) redraws nothing and never rejects`.
  - `closed › a failed redraw is logged and the others are still redrawn`.
  - `records are bounded: past BOT_REQUEST_DM_RECORDS_MAX the oldest is forgotten, and past the TTL too`.
  - `agentSeenBy` (bot-requests.test.ts or the new file): `null` name for a request whose requester can't see the agent; the list still shows "A team agent" (the existing list tests, unchanged).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Header comment: what is sent to whom, the identity rule (D2), the bounds (D3, D4), off the request path (D5), what is logged. `isTemporarySlackCode` in admission.ts, and the `agentSeenBy` extraction.
- [ ] **Step 4: Run, expect PASS**, then the whole channel-slack package.
- [ ] **Step 5: Mutants** (commit first): drop the map-back check (`=== ax.userId`) → `skips … maps to another account`; drop `admitSender` → `skips … a guest`; keep the requester in the list → `skips the requester`; drop the window check → `fourth ask`; drop the temporary stop → `stops at the first temporary …`; post without checking `closing` → `a close during the fan-out`; set `line` without the fan-out's own redraw → same test; `allowEmail: true` → `never email`.
- [ ] **Step 6: Commit:** `[TASK-1170] channel-slack: DM the AX admins about a bot request, and redraw each DM once it's answered`.

---

### Task 6: The owner's DMs — live and declined [tier: sensitive] (security-checklist)

Sensitive: the same identity mapping, for the requester, from an email auth may not have verified (`auth:get-user` carries no verified flag, so the map-back is what proves it).

**Files:**
- Modify: `packages/channel-slack/src/bot-request-dms.ts` (`live`; the declined notice inside `closed`)
- Modify: `packages/channel-slack/src/limits.ts`: `BOT_LIVE_DM_CHANNELS_MAX = 10`
- Test: `packages/channel-slack/src/__tests__/bot-request-dms.test.ts`

**Behavior:**
- **`notifyOwner(requesterUserId, text)`:** shared workspace and token as in Task 5. `auth:get-user(requesterUserId)` must answer about that id with a string `email`, else stop (logged stage `owner-email`). Then `memberFor` and `api.postDirect(token, { user, text })`, text only with no blocks. Failures are logged code-only (`slack_bot_request_dm_failed { requestId? | installId?, stage, code }`), and nothing is retried.
- **`live({ installId })`:** `installs.get(installId)` must be `kind 'bot'`, `status 'active'`, with an `agentId`, and `requestedByUserId !== null && requestedByUserId !== connectedByUserId`. Anything else does nothing (the self path saw the browser's toast). Channels: `channels.listForAgent(shared.installId, agentId)` minus `channels.listForAgent(installId, agentId)`; names are the bindings' stored `channelName`; the first `BOT_LIVE_DM_CHANNELS_MAX`, plus a count of the rest. Text: `COPY.botLiveForOwner({ botName, handle: botHandle }, names, more)`.
- **`closed` with `outcome: 'declined'` and `byUserId !== requesterUserId`:** `notifyOwner(requesterUserId, COPY.botDeclinedForOwner(botName))`, whether or not a record exists. `approved` sends no owner DM (it comes at `live`).

- [ ] **Step 1: Failing tests:**
  - `live › an admin-approved bot: one DM to its requester from the shared bot with its @handle and /invite`.
  - `live › names the channels the agent had through the shared bot, at most BOT_LIVE_DM_CHANNELS_MAX, then "and N more"; a channel the bot already answers in isn't named`.
  - `live › with no handle kept, names the bot`.
  - `live › a self-approved bot (approver is the requester), a pending bot, a shared install, or an unknown id: nothing`.
  - `live › a requester with no email, not in Slack, a guest, or whose Slack email maps elsewhere: nothing, logged code-only`.
  - `closed › declined by an admin who isn't the requester: one DM to the requester naming the bot; with no record too`.
  - `closed › declined by the requester themselves: no owner DM`.
  - `closed › approved: no owner DM`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS**; mutants: drop the approver≠requester rule → `self-approved`; drop the decliner≠requester rule → `declined by the requester`; drop the map-back → `maps elsewhere`; send on `approved` → `approved: no owner DM`.
- [ ] **Step 5: Commit:** `[TASK-1170] channel-slack: tell the requester their bot is live, or was declined`.

---

### Task 7: Call the DMs from the request paths and the Allow [tier: sensitive]

Sensitive: lock ordering. Every call goes after the app lock is released. And `decline`'s contract changes.

**Files:**
- Modify: `packages/channel-slack/src/bot-requests.ts` (deps `:106-119` gain `dms: Pick<BotRequestDms, 'opened' | 'closed'>`; `ask` `:220-254`, `approve` `:265-296`, `decline` `:298-304`; the interface docs `:121-177`; header `:16-75`: DMs, and decline's actor)
- Modify: `packages/channel-slack/src/bot-request-routes.ts` (`decline` `:125-127` passes `actorUserId: actor.id`; requests Pick unchanged)
- Modify: `packages/channel-slack/src/bot-callback.ts` (deps `:58-69` gain `dms: Pick<BotRequestDms, 'live'>`; `visit` `:175-230`: remember the connected install inside the lock, call `void d.dms.live({ installId })` after `lock.run` resolves; header `:11-56`)
- Test: `bot-requests.test.ts` (`world()` `:123-262` gains a recording `dms` fake and a lock wrapper that reports whether it's held), `bot-request-routes.test.ts`, `bot-callback.test.ts`

**Contract changes:**
```ts
// bot-requests.ts
decline(i: { requestId: string; actorUserId: string }): Promise<BotReply>;
// lock → getBotRequest (null → 404) → removeBotRequest (false → 404) → log → 200 {};
// after the lock, on 200: void d.dms.closed({ requestId, requesterUserId: r.requestedByUserId, botName: r.botName, outcome: 'declined', byUserId: actorUserId })
```
- `ask`: capture the minted `requestId` inside the lock; after it, on 200: `void d.dms.opened({ requestId, agentId, requesterUserId: actorUserId, botName })`.
- `approve`: capture the request read inside the lock; after it, when `create` answered 200: `void d.dms.closed({ …, outcome: 'approved', byUserId: actorUserId })`.
- Nothing on any refusal or throw. The dms methods are `async` and each wraps its work as `lifetime.track(work).catch(log)` (Task 5), so the promise never rejects and can't throw synchronously: call sites just `void` it. No try at the call site. (Node ends the process on an unhandled rejection, which is why the guarantee sits inside dms, where it's tested.)

- [ ] **Step 1: Failing tests:**
  - bot-requests.test.ts `ask › an opened request tells the admins once, after the lock is free, with its id, agent, requester and name; a refused ask tells nobody` (cover each 409 and the rights refusals).
  - `approve › an approve that made the bot closes the DMs as approved by her, after the lock; one that made nothing (409/502/404) closes nothing`.
  - `decline › closes the DMs as declined by who declined, after the lock; a gone request is 404 and closes nothing`. Update the existing decline tests for the new argument and the trail (`store:getBotRequest` before `store:removeBotRequest`).
  - `a notice that never settles doesn't hold the answer` (the fake's promise never resolves; the reply still comes).
  - bot-request-routes.test.ts: `POST …/decline hands the domain the admin's id`.
  - bot-callback.test.ts: `a connected Allow tells the DMs the bot is live, once, after the lock; a refused, cancelled, expired, mismatched or failed one doesn't`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement**, including the header prose.
- [ ] **Step 4: Run, expect PASS** (the three files, then the package; then `pnpm --filter @ax/preset-memory test`, since the decline route's body changed: TASK-1169's learning).
- [ ] **Step 5: Mutants:** call `opened` inside the lock → `after the lock is free`; call `closed` on a 409 → `closes nothing`; drop decline's read → the owner/redraw fields test; call `live` on a failed finish → the callback test.
- [ ] **Step 6: Commit:** `[TASK-1170] channel-slack: a bot request's DMs go out when it opens, closes and goes live`.

---

### Task 8: The Decline click [tier: sensitive] (security-checklist)

Sensitive: a new interaction action that untrusted Slack users can send.

**Files:**
- Modify: `packages/channel-slack/src/interactions.ts` (header `:12-55`; types `:62-86`; `readClick` `:158-190`; `handle` `:232-237`)
- Create: `packages/channel-slack/src/bot-request-click.ts`
- Test: `packages/channel-slack/src/__tests__/interactions.test.ts`; new `bot-request-click.test.ts`

**Interfaces — Produces:**
```ts
// interactions.ts
/** A click on a bot request DM's Decline (TASK-1170), as Slack signed it. */
export interface BotRequestClick { slackUserId: string; channel: string; messageTs: string; requestId: string }
export type BotRequestClickHandler = (install: InstallRow, click: BotRequestClick) => Promise<void>;
// InteractionsHandlerDeps gains: onBotRequestClick: BotRequestClickHandler
// Reading: action_id === ACTION_BOT_REQUEST_DECLINE → only on install.kind === 'shared' and a value matching
// INSTALL_ID_RE (a request id, ingress.ts), else ignored('action'); the same step-7 reads of user, channel and
// message (factor them out); → { kind: 'bot-request', click }. The 200 goes out first, then
// `void d.lifetime.track(() => d.onBotRequestClick(install, click)).catch(log)` as for prompts.
// Approve's URL click (ACTION_BOT_REQUEST_APPROVE) stays ignored('action'), an empty 200.

// bot-request-click.ts
export interface BotRequestClickDeps {
  bus: HookBus;
  api: Pick<SlackApi, 'usersInfo' | 'postEphemeral'>;
  secrets: Pick<SecretStore, 'get'>;
  requests: Pick<BotRequests, 'decline'>;
  logger: Logger;
}
export function createBotRequestClickHandler(d: BotRequestClickDeps): BotRequestClickHandler;
```
**The gate, in order:**
1. `secrets.get(install, 'bot-token')`: none or a fault → log, say nothing.
2. `install.teamId` null → nothing.
3. `admitSender(api, token, click.slackUserId, teamId)`: refused → silence, logged reason only; temporary (`isTemporaryLookupFailure`) → `tell(COPY.promptFailed)`.
4. `findSenderUser(bus, ctx, admission.email, …)`: fault → `tell(COPY.promptFailed)`; null → `tell(COPY.botRequestOnlyAdmin)`.
5. `isAxAdmin(bus, ctx, userId)`: fault → `promptFailed`; false → `botRequestOnlyAdmin`.
6. `requests.decline({ requestId: click.requestId, actorUserId: userId })`: 404 → `tell(COPY.botRequestHandled)`; 200 → nothing (the DM's redraw is the answer); anything else or a throw → `promptFailed`, logged.

`tell` = `api.postEphemeral(token, { channel: click.channel, user: click.slackUserId, text })`; a failure is logged and never thrown. Log lines are `slack_bot_request_click_* { installId, reason | stage, code }`: never a Slack id, an email or the request id's name. The request id is ours and may be logged.

- [ ] **Step 1: Failing tests.**
  - interactions.test.ts: `a Decline on the shared install's DM → an empty 200, then onBotRequestClick once with who, where and which request, and onClick never`. Then `Decline on a bot's own install, a value that isn't a request id, or Approve's URL click → an empty 200, ignored 'action', nothing handed on`, and `a Decline whose user, channel or message is malformed → 400`. The existing prompt cases are unchanged.
  - bot-request-click.test.ts: `an AX admin's click declines it, as her, and tells her nothing more`. `a member whose account isn't an AX admin, or who has no account: one private "Only an admin can answer this.", and decline is never called`. `a guest, deactivated, other-workspace or unconfirmed clicker: silence, and no AX lookup`. `Slack briefly unavailable: "try again" privately`. `an auth fault mapping or checking: "try again", logged code-only, decline never called`. `a request already handled (404): "This request was already handled."`. `a decline that throws or answers 500: "try again"`. `the admin check runs before anything touches the request` (trail: no decline call for a non-admin). `no bot token: logged, nothing said`. `log lines carry no Slack id, email or name`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement**; interactions.ts header: the route now hands on two kinds of click, and what each may do is its gate's to decide.
- [ ] **Step 4: Run, expect PASS**; mutants: drop the `isAxAdmin` check → `a member … not an AX admin`; decline before the admin check → `before anything touches the request`; accept a Decline on a bot install → interactions case; tell a refused clicker → `silence`; accept any value shape → interactions case.
- [ ] **Step 5: Commit:** `[TASK-1170] channel-slack: an AX admin declines a bot request from its Slack DM`.

---

### Task 9: Plugin wiring, manifest, pins [tier: integration]

**Files:**
- Modify: `packages/channel-slack/src/plugin.ts`:
  - header `:69-170`: the interactions route also takes a bot request's Decline; the shared bot DMs AX admins and requesters about bot requests.
  - `calls` `:254-269`: add `'auth:list-admins'` after `'auth:is-approved-email'`, commented "a bot request's DMs: who the AX admins are".
  - `createBotRequestDms({ bus, api, installs: store, channels: channelStore, secrets, lifetime: life, publicOrigin, logger, now })` before `createBotRequests` (`:400`), which gets `dms`.
  - `createBotRequestClickHandler({ bus, api, secrets, requests: botRequests, logger })` → `onBotRequestClick` in the interactions route's deps (`:467-499`).
  - `dms` into `createBotCallbackRoute` (`:505`).
- Test: `packages/channel-slack/src/__tests__/plugin.test.ts`: the services map `:182-190` gains `'auth:list-admins'`; the manifest pin `:633-660` gains it. The fake fetch (`~:255-300`) answers `users.lookupByEmail` and adds a `channel` to `chat.postMessage`. One wiring test (Postgres): `a bot request DMs the AX admin through the wiring, and her Decline click in that DM declines it`. Ask through `POST /settings/slack/:agentId/bot-request`, wait for the DM's `chat.postMessage`, then send a signed Decline click to `/slack/interactions/:installId`, and see the request gone from `GET /admin/slack/bot-requests` and the DM's `chat.update`. Wait on the condition you assert (`vi.waitFor(() => expect(…).toHaveLength(n))`), never on an earlier event (`.claude/memory/mistakes/2026-11-15-TASK-1095.md`). The DMs run after the 200.
- Modify: `presets/k8s/src/__tests__/preset.test.ts` (`:1292-1311`, channel-slack `calls` pin, with a comment).
- Modify: `presets/k8s/src/__tests__/channel-slack-composition.test.ts` (`:200-256`: the stubs plugin registers `'auth:list-admins'` → `{ admins: [] }`).
- Modify: `presets/memory/src/__tests__/canary.test.ts` (`:47-104`: the auth stub registers `'auth:list-admins'` → `{ admins: [] }`, commented like its neighbours).

- [ ] **Step 1:** Update the pins and stubs; add the wiring test; run each (FAIL for the wiring test until Step 2).
- [ ] **Step 2: Wire plugin.ts.**
- [ ] **Step 3: Run, expect PASS:** `pnpm --filter @ax/channel-slack test`, `pnpm --filter @ax/preset-k8s test`, `pnpm --filter @ax/preset-memory test`, `pnpm test:scripts`.
- [ ] **Step 4: Commit:** `[TASK-1170] channel-slack: wire a bot request's DMs and the Decline click`.

---

### Task 10: Docs, stale lines, changesets [tier: mechanical]

**Files and lines (rule 5: what made the card look true, and what goes stale with it):**
- `docs/plans/2026-11-09-channel-slack-design.md:887`: "**No other new hooks** (apart from `auth:is-approved-email` above …)" is stale once this lands. Add an `auth:list-admins` paragraph beside `:849-886`'s, with the rules (verified only, admins now, `{ userId, email }`, oldest first), the caller allowlist, the alternate impl and the leaky names. Note that TASK-1170 adds no routes, and that the interactions route gains a Decline.
- `:330-335` (§3 Scopes): `chat:write` also DMs people about a bot request; `users:read.email` also finds an AX admin or a bot's requester by email (TASK-1170). No new scope.
- `:408-415` (§4 step 2) and `:428-430` (step 4): as built. Approve is a link to Admin › Slack (tokens never pass through Slack). The notification names nobody. The owner hears from the shared bot only when someone else approved.
- New "**As built (TASK-1170).**" after TASK-1172's (`~:597`): who gets a DM (D2), the bounds (D3, D4), what's redrawn and what isn't (D8), the owner notices (D9), and the click gate (D7). Unmeasured: `chat.postMessage` to a user id with `chat:write` only (walk checks). After a restart, old DMs aren't redrawn. The DMs land in the person's DM with the shared bot, where their personal agent also answers; the bot's own messages never start a turn (`admission.ts screenEvent`).
- `:1166-1173` (§9 progress): add TASK-1170.
- `packages/channel-slack/src/manifest.ts:23-32` (scope jobs): the same two lines as §3.
- `.changeset/`: `@ax/auth-better` minor (the hook), `@ax/channel-slack` minor (the DMs), `@ax/channel-web` patch (the link). Mirror `.changeset/auth-approved-email.md`'s shape and the README voice.

- [ ] **Step 1:** Edit. `git grep -n "No other new hooks\|TASK-1095 adds none" docs/` must show the new wording only.
- [ ] **Step 2: Commit:** `[TASK-1170] docs: as built for a bot request's Slack DMs`.

---

## Final gate

1. `pnpm build`
2. `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts` (CLAUDE.md: never only the recursive part). Untouched Docker-backed packages may time out locally under sibling load; CI is the authority for those, and say so in the handoff.
3. `pnpm lint`.
4. `security-checklist` skill: required (new interaction action from untrusted Slack users, new PII hook, outbound DMs with names chosen by team admins, identity mapping). Residuals for the PR's note (planner's view):
   - (a) Redraws are best-effort and in memory. After a restart, old DMs keep their buttons when someone else answers. (As built, after review: a Decline clicked in one still declines a request that's open and redraws that DM; on a closed request it says "This request was already handled.")
   - (b) `chat.postMessage` to a user id with `chat:write` only is from Slack's docs, not measured. If Slack refuses, nobody is DMed (logged), and Admin › Slack still lists the request.
   - (c) An admin's email goes to Slack's `users.lookupByEmail`, so Slack sees the lookup even for an admin it doesn't know.
   - (d) A team admin can make the shared bot DM up to 20 admins per ask, at most 3 asks per 10 minutes. The window lives in memory; a restart resets it.
   - (e) Names chosen by team admins (agent, bot) and the requester's display name reach admins' Slack as plain text, kept by Slack under its retention (§8 Q4). No email goes to Slack.
   - (f) A Decline from Slack isn't re-checked inside the app lock (nor is Admin › Slack's), so a demotion racing the click can only remove a request.
   - (g) A signed-out admin following Approve lands on the root after sign-in (`lib/auth.ts:91` keeps share routes only).
   - (h) The new hook can be called by any host plugin at runtime. The repo scan covers names spelled in source, not ones built at runtime.
5. Boundary review section above → PR description.

## Out of scope (follow-ups, in the decisions shard)

Each item below is cut because nothing in the card's acceptance needs it now:
- Redraw on Cancel, on agent deletion and on reset (stale clicks already say "already handled").
- DM records that survive a restart (a table).
- Keeping `?admin=slack` across sign-in.
- A confirm dialog on Slack's Decline (the web Decline has none).
- The team name in the admin DM (Admin › Slack shows it).
- A DM to the requester at approve time (they hear at go-live).
- A once-per-request refusal cache for repeat clicks by non-admins.
- A restart-safe confirmation for the clicker when their DM can't be redrawn. (Done in review: the DM a Decline was clicked in is redrawn without its record.)
