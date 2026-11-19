# TASK-1139: Slack admin success log lines (Disconnect's appDeleted, a finished install, a deleted leftover) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After the fact, a log reader can tell whether a Disconnect deleted the Slack app, whether a callback finished an install, and whether Connect deleted a leftover app. Finding 9 (two `slack_install_refused {reason:'unauthenticated'}` during a connect that worked) is explained where the next walk will read it.

**Architecture:** Three `info` lines, written through `admin-routes.ts`'s existing `log()` helper. Each one is written after the change it reports and right before the answer. No hook, route, response, store or UI change. The two walk reports and the acceptance-loop skill get the finding-9 explanation and how to avoid it.

**Tech Stack:** TypeScript, vitest, `@ax/channel-slack`.

**Spec:** the card (TASK-1139, from `deploy/kind/walks/2026-11-16-TASK-1134/REPORT.md` findings 8 and 9) and `.claude/memory/decisions/2026-11-18-TASK-1139.md`. Read the shard first: it has the names, the evidence and every cut. **After review:** the shard's last row corrects Task 3's pinned texts (the TASK-1097 note is a different browser and stays unexplained; the user-facing claim is from the code, not watched; the cookie wording is "belongs to the host it was set on"). The committed walk notes and skill bullet are the source of truth, not the texts below.

## What the code shows (both premises hold)

- **A Disconnect that answers 200 logs nothing** (`admin-routes.ts:786-801`). `deleteSlackApp` and `secrets.removeAll` log only failures.
- **A callback that finishes an install logs nothing** (`:535`). Neither does Connect's leftover pass when a delete works (`:420-437`; TASK-1132 handed that line to this card).
- **`slack_install_refused` has one call site** (`:330`). `reason:'unauthenticated'` with no installId reaches it only from `route()`'s gate branch for the one browser route, the OAuth callback (`:852`). The gate refuses before the state is read, so nothing is spent (pinned, `admin-routes.test.ts:681-697`). The JSON routes answer that refusal with a 401 and log nothing (`:651-667`).

## Finding 9, answered (for the PR body and Task 3's notes)

- **Which request (MEASURED, code):** the OAuth callback on the public (tunnel) address, twice. A later callback did finish the install: the 01:18:07 Rename reached `rotate`, which only an active install reaches (`admin-routes.ts:712`).
- **Why no session (INFERRED, the pod's logs are gone):** the browser Slack sent back had no session cookie for the tunnel's address. The walk's session was on the `localhost` port-forward (`.claude/memory/patterns/2026-10-23-TASK-934.md`), and cookies are per host, not per port. TASK-1097's report gave the same cause for the same refusal (`:64`). In production the cookie is host-only and `SameSite=Lax` (`auth-better/src/plugin.ts:1009-1013`), so Slack's redirect carries it. There a refusal needs a browser with no live session on the public address: another browser or device, signed out, or a session past its 7 days.
- **What the user sees (MEASURED, code):** no Slack error, only the sign-in page. The callback sends the browser to `<publicOrigin>/?slack=failed`. The app reads `?slack=` once and strips it as it loads (`App.tsx:142-151`), shows the sign-in page when signed out (`:219-220`), and shows the "couldn't finish connecting Slack" toast only to a signed-in admin (`:256`, `:274`). Sign-in returns to `/` (`LoginPage.tsx:77`, `lib/auth.ts:91`). Admin › Slack then shows "Finish in Slack" with Continue in Slack, which works because nothing was spent.

## Design (decided; the shard has the alternatives)

| Line | Where | Fields | Level |
|---|---|---|---|
| `slack_disconnected` | `disconnect()`, after `secrets.removeAll`, right before the 200 | `{ installId, appDeleted }`, `appDeleted` a boolean (the answer's own field) | info |
| `slack_connected` | `finishInstall`, right before `backToApp('connected')` | `{ installId }` | info |
| `slack_leftover_app_deleted` | `deleteLeftoverApps`, after `forgetLeftoverApp` succeeds | `{ installId }` (the leftover's own old install id), plus `reason: 'already-gone'` when Slack answered `app_not_found` | info |

- A path that answers an error logs none of them. Disconnect's 500 (the row won't delete) has no `slack_disconnected`, and its retry logs one.
- **Not changing:** any answer, route, hook, store method, the gate, the refusal line (no cookie or header field, cut in the shard), `connect()`, `createInstall()`, the forget route, channel-web.

## Global Constraints

- Log fields allowed after this PR: `installId`, `reason`, `stage`, `code`, `appDeleted` (a boolean). No token, cookie, header, query value or Slack text in any line. The new names are exactly `slack_disconnected`, `slack_connected`, `slack_leftover_app_deleted`, and the only new literal is `'already-gone'`.
- Every new line goes through `log()`, never `d.logger` directly: a throwing log sink must never change an answer.
- TASK-1159 is editing the Connect path in parallel. Don't touch `connect()` (`admin-routes.ts:663-684`), `createInstall()` (`:439-475`) or the header's pasted-token bullets (`:42-56`).
- Fake tokens come from `packages/channel-slack/src/__tests__/fake-slack-tokens.ts`, never a token-shaped literal. Before each commit, `git diff --cached | grep -nE 'xox[bpe]-[0-9]{10,13}-'` prints nothing.
- No literal invisible characters in `packages/channel-slack/src` (`source-hygiene.test.ts` fails on them).
- `--filter` goes before the script. Package `tsc` excludes test files, so also run `pnpm --filter @ax/channel-slack build`.
- `store.test.ts` and `plugin.test.ts` are Docker-backed: set `DOCKER_HOST` as CLAUDE.md "Docker-backed tests" says.
- After Task 2, run the package and its dependents: `pnpm -r --no-bail --filter "...@ax/channel-slack" run test`.
- Full gate before the PR: `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts && pnpm lint`.
- Memory: new rows go only to `.claude/memory/decisions/2026-11-18-TASK-1139.md`. Never edit a root archive or delete a memory line.
- Prose a person reads (changeset, walk notes, skill line) uses the CLAUDE.md voice. The texts below are pinned; change a word only if it is false. GitHub text: `@ax` only inside backticks.

## Review Focus

1. **A Disconnect whose row won't delete** answers 500 with no `slack_disconnected`, and the retry that answers 200 logs exactly one. Pinned: Task 1 tests g and h.
2. **A callback that spends the state but fails** (Slack refuses the code, the bot token won't store, activate throws), **or a replay after success,** logs no `slack_connected`. Only the callback that finishes logs it, once. Pinned: Task 2 tests c to e, plus the exact arrays at `admin-routes.test.ts:1361` and `:1438`, which must stay as they are.
3. **A leftover whose forget fails, a refused delete, or a pass that stops** on a Slack or token failure logs no success line for that leftover (nor for any after a stop). The next Connect logs `reason: 'already-gone'`. Pinned: Task 1 tests l to o.
4. **A log sink that throws** changes no answer: Connect still 200, Allow still lands `connected`, Disconnect still 200 with `appDeleted`. Pinned: Task 2 test f.
5. **A secret inside a Slack, vault or store error** on these paths never reaches a line, and `appDeleted` is only ever a boolean. Pinned: Task 1 tests p to r (the leak test).

---

## Files

| File | Change | Task |
|---|---|---|
| `packages/channel-slack/src/admin-routes.ts` | `log()` field type; `slack_disconnected`; `slack_leftover_app_deleted`; comments `:58`, `:409-419`, `:791-796` | 1 |
| `packages/channel-slack/src/admin-routes.ts` | `slack_connected`; comments `:80`, `:477-481` | 2 |
| `packages/channel-slack/src/__tests__/admin-routes.test.ts` | Disconnect, leftover and leak tests | 1 |
| `packages/channel-slack/src/__tests__/admin-routes.test.ts` | `world({ logFault })`, `connectedWorld()`, callback tests, the guard test | 2 |
| `deploy/kind/walks/2026-11-16-TASK-1134/REPORT.md:41`, `deploy/kind/walks/2026-11-15-TASK-1097/REPORT.md:67` | "Found later (TASK-1139)" notes | 3 |
| `.claude/skills/k8s-acceptance-loop/SKILL.md` (after `:261`) | one gotcha bullet | 3 |
| `.changeset/slack-admin-log-lines.md` | new | 3 |

---

### Task 1: Disconnect and Connect's leftover pass say whether Slack deleted the app `[tier: mechanical]`

**Files:**
- Modify: `packages/channel-slack/src/admin-routes.ts:58`, `:304`, `:409-437`, `:786-801`
- Test: `packages/channel-slack/src/__tests__/admin-routes.test.ts`

**Interfaces:**
- Produces: `log(level, msg, fields: Record<string, string | boolean>)` (widened from `Record<string, string>`). Lines `slack_disconnected { installId: string; appDeleted: boolean }` and `slack_leftover_app_deleted { installId: string; reason?: 'already-gone' }`, both `info`. Task 2's guard test relies on both.

- [ ] **Step 1: Write the failing tests.** Line numbers are today's. Every `w.lines` entry has the shape `{ level, msg, fields }`.
  - **a.** `'rotate + deleteApp succeed …'` (`:1445`), at the end: `expect(w.lines).toEqual([{ level: 'info', msg: 'slack_disconnected', fields: { installId, appDeleted: true } }]);`
  - **b.** `'rotate fails, deleteApp fails or the token is gone …'` (`:1479`): replace the `toContainEqual` with an exact per-breaker check:
    ```ts
    expect(w.lines, stage).toEqual([
      { level: 'warn', msg: 'slack_admin_failed', fields: { installId, stage, code } },
      { level: 'info', msg: 'slack_disconnected', fields: { installId, appDeleted: false } },
    ]);
    ```
  - **c.** `'an app Slack says is already gone (app_not_found) …'` (`:1529`): destructure `installId` from `connectedWorld()`, and replace the `slack_admin_failed` filter with `expect(w.lines).toEqual([{ level: 'info', msg: 'slack_disconnected', fields: { installId, appDeleted: true } }]);`
  - **d.** `'cancels a pending install too'` (`:1545`): `expect(w.lines).toEqual([{ level: 'info', msg: 'slack_disconnected', fields: { installId: mintedInstallId(w), appDeleted: true } }]);`
  - **e.** `'with nothing connected → 409 not-connected'` (`:1554`): `expect(w.lines).toEqual([]);`
  - **f.** `'storing the new refresh token failing …'` (`:1580`): the exact array gains a second entry, `{ level: 'info', msg: 'slack_disconnected', fields: { installId, appDeleted: true } }`, after the `save-config-token` error. The title's "one error line" becomes "one error line, then slack_disconnected".
  - **g.** `'a row that will not delete → 500 …'` (`:1602`): after the 500, `expect(w.lines.map((l) => l.msg)).not.toContain('slack_disconnected');`. After the retry's 200, `expect(w.lines.filter((l) => l.msg === 'slack_disconnected')).toEqual([{ level: 'info', msg: 'slack_disconnected', fields: { installId, appDeleted: true } }]);`
  - **h.** `'Slack refusing the delete and the row refusing to go …'` (`:1618`): the same two checks, with `appDeleted: false` after the retry.
  - **i.** `'two renames in a row, then Disconnect …'` (`:2088`): destructure `installId`, and `expect(w.lines).toEqual([])` becomes `expect(w.lines).toEqual([{ level: 'info', msg: 'slack_disconnected', fields: { installId, appDeleted: true } }]);`
  - **j.** `'a refused install, Cancel with a configuration token Slack no longer takes …'` (`:1641`), at the end. The log follows the app from the refused callback to its deletion:
    ```ts
    expect(w.lines).toEqual([
      { level: 'info', msg: 'slack_install_refused', fields: { reason: 'unauthenticated' } },
      { level: 'warn', msg: 'slack_admin_failed', fields: { installId: firstInstallId, stage: 'rotate', code: 'invalid_refresh_token' } },
      { level: 'info', msg: 'slack_disconnected', fields: { installId: firstInstallId, appDeleted: false } },
      { level: 'info', msg: 'slack_leftover_app_deleted', fields: { installId: firstInstallId } },
    ]);
    ```
  - **k.** `'Connect deletes every leftover app …'` (`:1683`), at the end:
    ```ts
    expect(w.lines).toEqual([
      { level: 'info', msg: 'slack_leftover_app_deleted', fields: { installId: LEFT_1.installId } },
      { level: 'info', msg: 'slack_leftover_app_deleted', fields: { installId: LEFT_2.installId, reason: 'already-gone' } },
    ]);
    ```
  - **l.** `it.each` `'a %s refusal is about that one app …'` (`:1758`): the exact array gains `{ level: 'info', msg: 'slack_leftover_app_deleted', fields: { installId: LEFT_2.installId } }` after the warn.
  - **m.** `it.each` `'a %s answer is about Slack or the token …'` (`:1785`): unchanged, and it must still pass. A pass that stops logs no success line.
  - **n.** `'forgetting a deleted leftover failing …'` (`:1854`): the first exact array stays (a failed forget logs no success line). At the end:
    ```ts
    expect(w.lines.filter((l) => l.msg === 'slack_leftover_app_deleted')).toEqual([
      { level: 'info', msg: 'slack_leftover_app_deleted', fields: { installId: LEFT_1.installId, reason: 'already-gone' } },
    ]);
    ```
  - **o.** `"a leftover app Slack won't delete stays listed …"` (`:1717`): the exact array at `:1727` stays (a refused delete logs no success line).
  - **p.** Leak test (`:2483`), the happy path: after its last `await happy.status();` (`:2500`), add `leaveApp(happy, LEFT_2); await happy.connect();`. The next Connect deletes a leftover, so that line is scanned too.
  - **q-r.** Leak test, the closing loop (`:2608-2613`) becomes:
    ```ts
    const lines = worlds.flatMap((w) => w.lines);
    // The new lines are in the scan (TASK-1139), so the allowlist is tested on them.
    expect(lines.map((l) => l.msg)).toEqual(expect.arrayContaining(['slack_disconnected', 'slack_leftover_app_deleted']));
    for (const line of lines) {
      expect(line.msg, JSON.stringify(line)).toMatch(/^slack_/);
      for (const key of Object.keys(line.fields ?? {})) {
        expect(['installId', 'reason', 'stage', 'code', 'appDeleted'], JSON.stringify(line)).toContain(key);
      }
      // The one field that isn't a code or an id: a yes or a no, never a value.
      if (line.fields !== undefined && 'appDeleted' in line.fields) {
        expect(typeof line.fields['appDeleted'], JSON.stringify(line)).toBe('boolean');
      }
    }
    ```

- [ ] **Step 2: Run them and see them fail.**
  Run: `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/admin-routes.test.ts`
  Expected: FAIL. a-d, f-l and n are missing `slack_disconnected` / `slack_leftover_app_deleted`, and the leak test's `arrayContaining` fails. e, m and o pass already.

- [ ] **Step 3: Implement in `packages/channel-slack/src/admin-routes.ts`.**
  - `log` (`:304`): `fields: Record<string, string | boolean>`.
  - `disconnect()`: after `await d.secrets.removeAll(install);`, add `log('info', 'slack_disconnected', { installId: install.installId, appDeleted });`.
  - `deleteLeftoverApps`: set `let alreadyGone = false` per leftover, and set it to `true` in the `app_not_found` branch of the delete's catch. The forget's catch ends with `continue;`. After the forget's try/catch, add `log('info', 'slack_leftover_app_deleted', { installId: app.installId, ...(alreadyGone ? { reason: 'already-gone' } : {}) });`. Keep the log outside the forget's `try`.
  - Comments, exactly (re-wrap each paragraph at the file's width):
    ```
    :58, the header's last secrets line
      before: an install, a stage or reason, and a code.
      after:  an install, a stage or reason, a code, and whether Slack deleted an app.

    deleteLeftoverApps's doc, the sentence after "Deleted, or already gone on Slack's side"
      before: (`app_not_found`): forgotten.
      after:  (`app_not_found`): forgotten, and logged at info (`slack_leftover_app_deleted`,
              with `reason: 'already-gone'` for the second).

    disconnect()'s comment block, a new last sentence
      Once it answers, the outcome is logged at info with the answer's `appDeleted`
      (`slack_disconnected`), so a walk can check it afterwards.
    ```

- [ ] **Step 4: Run and see them pass.**
  Run: `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/admin-routes.test.ts && pnpm --filter @ax/channel-slack build`
  Expected: PASS, and `tsc` exits 0.

- [ ] **Step 5: Commit.** `git add packages/channel-slack/src/admin-routes.ts packages/channel-slack/src/__tests__/admin-routes.test.ts`, then `git commit -m "[TASK-1139] Slack: log Disconnect's appDeleted and each leftover app Connect deletes"`.

---

### Task 2: A finished install is logged, so refused callbacks in the log are followed by the one that worked `[tier: mechanical]`

**Files:**
- Modify: `packages/channel-slack/src/admin-routes.ts:80`, `:477-481`, `:535`
- Test: `packages/channel-slack/src/__tests__/admin-routes.test.ts` (`world()` `:428-445`, `connectedWorld()` `:613-618`, the callback describe `:1190-1442`, a new describe after the Disconnect describe)

**Interfaces:**
- Consumes: Task 1's `slack_disconnected` and `slack_leftover_app_deleted` (the guard test, f).
- Produces: line `slack_connected { installId: string }`, `info`. Test helpers: `world({ logFault?: Error })`, where every fake logger call records its line and then throws `logFault`. `connectedWorld()` now asserts exactly one `slack_connected` line, then empties `w.lines`.

- [ ] **Step 1: Write the failing tests.**
  - **a.** `connectedWorld()` becomes:
    ```ts
    async function connectedWorld(o: Parameters<typeof world>[0] = {}) {
      const w = world(o);
      const state = stateOf(await w.connect());
      expect((await w.callback({ code: CODE, state })).location).toBe(back('connected'));
      const installId = mintedInstallId(w);
      // A clean Connect and Allow log exactly this line (TASK-1139). Cleared, so each test sees only its own.
      expect(w.lines).toEqual([{ level: 'info', msg: 'slack_connected', fields: { installId } }]);
      w.lines.length = 0;
      return { w, state, installId };
    }
    ```
  - **b.** A new test in the callback describe, named `the TASK-1134 walk: two callbacks the admin gate refuses, then one from the signed-in admin; the log shows both refusals, then slack_connected (TASK-1139)`:
    ```ts
    const w = world();
    const state = stateOf(await w.connect());
    const installId = mintedInstallId(w);
    expect(await w.callback({ code: CODE, state }, null)).toStrictEqual(FAILED);
    expect(await w.callback({ code: CODE, state }, null)).toStrictEqual(FAILED);
    expect((await w.callback({ code: CODE, state })).location).toBe(back('connected'));
    expect(w.lines).toEqual([
      { level: 'info', msg: 'slack_install_refused', fields: { reason: 'unauthenticated' } },
      { level: 'info', msg: 'slack_install_refused', fields: { reason: 'unauthenticated' } },
      { level: 'info', msg: 'slack_connected', fields: { installId } },
    ]);
    ```
  - **c.** `'success: oauthAccess uses the stored client secret …'` (`:1294`), at the end: `expect(w.lines).toEqual([{ level: 'info', msg: 'slack_connected', fields: { installId } }]);`
  - **d.** `'activate throwing → failed …'` (`:1368`), at the end: `expect(w.lines.filter((l) => l.msg === 'slack_connected')).toEqual([{ level: 'info', msg: 'slack_connected', fields: { installId } }]);`. That's one line, from the retry.
  - **e.** `'a replayed callback after success …'` (`:1426`): `expect(w.lines).toEqual([{ level: 'info', msg: 'slack_install_refused', fields: { reason: 'invalid-state' } }]);`
  - **f.** `world()` gets `logFault?: Error` in its options. Its `at` pushes the line first, then throws `o.logFault` when it is set. Add a new describe after the Disconnect describe, `a log line never changes an answer (TASK-1139)`, with one test, `with a log sink that throws, Connect (deleting a leftover), Allow and Disconnect still succeed, and each line was attempted`:
    ```ts
    const w = world({ logFault: new Error('log sink is down') });
    leaveApp(w, LEFT_1);
    const state = stateOf(await w.connect());
    expect(w.memory.leftovers.size).toBe(0);
    expect((await w.callback({ code: CODE, state })).location).toBe(back('connected'));
    expect(onlyRow(w).status).toBe('active');
    expect(await w.disconnect()).toMatchObject({ status: 200, body: { appDeleted: true } });
    expect(w.memory.rows.size).toBe(0);
    expect(w.vault.size).toBe(0);
    expect(w.lines.map((l) => l.msg)).toEqual(['slack_leftover_app_deleted', 'slack_connected', 'slack_disconnected']);
    ```

- [ ] **Step 2: Run them and see them fail.**
  Run: `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/admin-routes.test.ts`
  Expected: FAIL. Every test that starts from `connectedWorld()` fails at the helper's assertion, and b, c, d and f fail too.

- [ ] **Step 3: Implement in `packages/channel-slack/src/admin-routes.ts`.**
  - `finishInstall`: add `log('info', 'slack_connected', { installId });` right before `return backToApp('connected');`.
  - Comments, exactly (re-wrap at the file's width):
    ```
    :80, the header's callback paragraph
      before: `slack=connected|cancelled|failed`, and a refusal is logged by reason.
      after:  `slack=connected|cancelled|failed`. A refusal is logged by reason, and a
              finished install as `slack_connected`.

    finishInstall's doc, a new last sentence
      A finished install is logged at info (`slack_connected`), so refusals in the
      log are followed by the callback that worked.
    ```

- [ ] **Step 4: Run and see them pass, then the package and its dependents.**
  Run: `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/admin-routes.test.ts && pnpm --filter @ax/channel-slack build && pnpm -r --no-bail --filter "...@ax/channel-slack" run test` (with `DOCKER_HOST` set).
  Expected: PASS everywhere. `plugin.test.ts` never drives the callback and filters its log lines by name, and `presets/k8s` `channel-slack-composition.test.ts` asserts no log lines, so neither should change.

- [ ] **Step 5: Commit.** `git commit -m "[TASK-1139] Slack: log a finished install (slack_connected)"`, with both files added.

---

### Task 3: Write down what finding 9 was, so the next walk doesn't chase it `[tier: mechanical]`

**Files:**
- Modify: `deploy/kind/walks/2026-11-16-TASK-1134/REPORT.md:41`
- Modify: `deploy/kind/walks/2026-11-15-TASK-1097/REPORT.md:67`
- Modify: `.claude/skills/k8s-acceptance-loop/SKILL.md` (a new bullet right after the **Cookies.** bullet, `:261`)
- Create: `.changeset/slack-admin-log-lines.md`
- Commit with it: `.claude/memory/decisions/2026-11-18-TASK-1139.md` and this plan (the planner wrote them)

**Interfaces:** none. The texts name Task 1 and 2's lines exactly.

- [ ] **Step 1: TASK-1134 report, finding 9** (`:41`). Append to the bullet, as TASK-1130 did to `:34`:
  ```
   *Found later (TASK-1139): both came from the OAuth callback (`GET /admin/slack/oauth/callback`), the only route that logs that refusal. The admin gate turned the browser away before reading the install's state, so nothing was spent, and a later callback from a signed-in browser finished the install (the Rename at 01:18:07 reached `rotate`, which only an active install can). Most likely the browser Slack sent back had no session cookie for the tunnel's address: the walk's session was on the `localhost` port-forward, and cookies are per host, not per port (inferred; the pod's logs are gone). The admin saw no Slack error, only the sign-in page: the app drops `?slack=failed` as it loads, and sign-in returns to the home page. A finished install now logs `slack_connected`, so the next walk's log shows the order. Next walk: sign in on the public address before Connect.*
  ```
- [ ] **Step 2: TASK-1097 report, "Kind sessions"** (`:67`). Append to the bullet:
  ```
   *Found later (TASK-1139): most likely the cookie wasn't lost. A Connect ends on the public address, and the session cookie was on `localhost` (cookies are per host, not per port), so after Slack the browser was somewhere it had no session. It's the same cause as the refused callback in the TASK-1132 line above.*
  ```
- [ ] **Step 3: The acceptance-loop gotcha.** Insert this bullet right after the **Cookies.** bullet in `.claude/skills/k8s-acceptance-loop/SKILL.md`:
  ```
  - **A trip through Slack ends on the public address.** Slack's Allow page sends the browser back to `AX_PUBLIC_BASE_URL` (on kind, the cloudflared tunnel), not to the port-forward, and so does any OAuth callback built on that address. The session cookie is per host, not per port, so a cookie set on `localhost` isn't sent there: the callback logs `slack_install_refused {reason:'unauthenticated'}` and the browser lands on the sign-in page. Sign in on the public address before you start the round trip. (Hit on the TASK-1097 and TASK-1134 walks; TASK-1139.)
  ```
- [ ] **Step 4: The changeset** `.changeset/slack-admin-log-lines.md`:
  ```
  ---
  '@ax/channel-slack': patch
  ---

  The Slack host log now says when things went right, not just when they went wrong. A Disconnect logs `slack_disconnected` with whether Slack deleted the app (`appDeleted`), a finished connection logs `slack_connected`, and each leftover app a new Connect deletes logs `slack_leftover_app_deleted`. Like every Slack log line, they carry ids and outcomes, never tokens.
  ```
- [ ] **Step 5: Check and commit.** Run `pnpm test:scripts`; it passes. Then `git commit -m "[TASK-1139] docs: what the walk's refused Slack callbacks were, and how the next walk avoids them"`, with the five files above added.

---

## Ship-time steps (the builder; not implementer tasks)

1. **PR**, squash title `[TASK-1139] Slack: log Disconnect's appDeleted and a finished install; explain the walk's refused callbacks`. Body:
   - Findings 8 and 9, and the three lines (the Design table).
   - "Finding 9, answered", with its MEASURED and INFERRED labels and the file:line evidence above.
   - **Security:** security-checklist not required. No new capability, route, hook, header read or dependency. Every new field is server-made: our own install id, a computed boolean, a fixed literal. The leak test now also scans the new lines and checks that `appDeleted` is a boolean.
   - **Boundary review:** N/A. No hook, IPC action or manifest change.
   - **TASK-1159:** whichever PR merges second re-runs `admin-routes.test.ts` after its rebase. A test asserting the exact log after a successful callback or a Disconnect gains a line, and `connectedWorld()` absorbs the callback case.
2. **Handoff `learnings:`**
   - The next real-Slack walk can measure TASK-1132's unmeasured items 1 and 2 from `slack_leftover_app_deleted`. A plain line means a NEW token deleted an app an earlier token made. `reason: 'already-gone'` for an app still on api.slack.com/apps is the bad case.
   - Sign in on the public address before Connect (now in the acceptance-loop skill).
   - **Suggested Backlog card:** a signed-out admin who lands from Slack's Allow page sees only sign-in, and afterwards nothing says Slack didn't finish. It needs a ux-design pass and is low priority (decisions shard, YAGNI row).
   - **Not filed:** every channel-slack line carries the plugin's init `reqId`. That's platform-wide; the shard has why.
