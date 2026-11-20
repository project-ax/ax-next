# TASK-1175 — Slack: one configuration token per person — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AX keeps one rotating Slack configuration refresh token per AX user. Every Slack app that person made through AX (today, the shared install and any leftover apps) uses it. Each rotate's successor is written back to that one slot, so every app of theirs keeps working.

**Architecture:** The token moves from the per-install vault ref `slack:<installId>:config-refresh-token` to a per-person ref `slack:person:<userId>:config-refresh-token`. It stays global-scope and is read global-only, named as that person. Installs already record their person (`connected_by_user_id`). Leftover apps gain the same column. Every token use, under the existing admin lock, resolves the person through the app's row. A boot step moves existing tokens. A person's token is released when no install and no leftover names them.

**Tech Stack:** TypeScript, Kysely/Postgres (`channel_slack_v1_*`), the credentials vault through `credentials:get|set|delete`, vitest (Postgres via Testcontainers for store, plugin and composition tests), React and shadcn (one copy change).

> **As built (after review):** a few details below were superseded in review. A failed delete of a person's token logs stage `person-config-refresh-token`. `releaseConfigToken`'s `onFault` takes `(err, step)`, where step is `'check' | 'read'`. Connect stores the person's token straight after the rotate. The CLI reset builds the plugin with `moveConfigTokens: false`. Connect's undo lists an app Slack won't delete as left over. The decisions shard has the reasons.

**Spec:** the card (the TASK-1175 brief) and `docs/plans/2026-11-09-channel-slack-design.md` §3, §4, §7, §8 Q5/Q6. Every decision below has its reasons and alternatives in `.claude/memory/decisions/2026-11-20-TASK-1175.md`. Read that shard before Task 1.

---

## What the planner verified (so you don't re-derive it)

1. **The vault ignores `userId` on a global `slack:` read.** With `scope: 'global'`, `findRow` tries only `{ scope: 'global', ownerId: null, ref }` (`packages/credentials/src/plugin.ts:884-892`). `userId` only gates `account:` refs. So the person goes **in the ref**: `slack:person:<userId>:config-refresh-token`.
2. **The vault's `REF_RE` (`^[a-zA-Z0-9][a-zA-Z0-9_./:-]{0,191}$`) excludes `@`, but `USER_ID_RE` allows it.** Production ids are `[A-Za-z0-9_]` only. So a person id is checked against `^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$` before a ref is built, and fails closed.
3. **`tooling.tokens.rotate` and the team id.** Slack's docs list `team_id` and `user_id` in its answer. AX's client reads neither (`slack-api.ts:485-500`), and no walk has measured them. **The key is the AX user id only.** Decisions shard row 4 explains why.
4. **Replace keeps the install's person.** Today Replace writes the token as the pasting admin and moves the row to them (`admin-routes.ts:932`, `:936`). Slack accepts only the creator's token (§8 Q5, measured), so a passing Replace always carries the install person's own chain. From now on Replace stores the token as `install.connectedByUserId`'s, and only `config_token_added_at` moves. This changes TASK-1128's cross-admin Replace assertions (Task 4 lists them). It is the card's own rule: "Replace never moves an app to another person".
5. **Only `admin-routes.ts` uses the configuration token.** `rotateConfigToken` and `config-refresh-token` appear nowhere else in `src/`. The boot move runs before any route registers. The reset runs in the CLI's own process, with no lock (an existing, documented race).
6. **No hook-surface change.** There is no new hook, no `calls` or `optionalCalls` change, no IPC action, and no admin wire-shape change. **No boundary review.** The new ref lives inside channel-slack's `slack:` namespace, which `scripts/__tests__/channel-slack-boundaries.test.js` already reserves for it.

## Approaches considered

- **Chosen: a global vault row keyed by person, resolved through the app row's `connected_by_user_id`.** It keeps secrets.ts's global-only isolation rule and every existing trail pin (the ref still ends in `:config-refresh-token`). The migration is a boot step through the vault hooks.
- **A user-scope vault row** (`scope: 'user', ownerId: <id>`). Rejected: `credentials:get` can't read the user row alone (only `'global'` is accepted), so it would fall through to a global row. User rows also show up in per-owner listings and purges.
- **Keyed by (person, Slack team), or by Slack's own `user_id`.** Rejected for now: those fields are unmeasured in AX, the migration can't learn them at boot without calling Slack, and phase 1 never holds two workspaces' live apps at once.

## Global Constraints

- Person ref: `` `slack:person:${userId}:config-refresh-token` ``, `scope: 'global'`, `ownerId: null`, `kind: 'api-key'`. Reads pass `scope: 'global'` and `userId: <person>`. Every read, write and delete runs with ctx `userId: <person>` and `agentId: ''`.
- Person id: `/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/`. Anything else throws an `Error` whose `code` is `'invalid-person-id'` (a fixed message, never the id), before any vault call.
- No route writes the per-install `config-refresh-token` again: `SecretStore.put` only takes `Exclude<SecretName, 'config-refresh-token'>`. `SECRET_NAMES` keeps the name, so `removeAll` and the reset still delete an old row.
- Every token use (read, rotate, store, release) in a route runs inside `d.lock.run`.
- Log lines never carry a token value or an AX user id. Admin-route lines keep the key set `installId | reason | stage | code | appDeleted`. Boot-move lines use `installId | stage | code` or the counts `moved | dropped`.
- SQL is additive-only and idempotent (`ADD COLUMN IF NOT EXISTS … NULL`). `runMigrations` runs every boot.
- No new dependency, no manifest change, no new route, no phase 2 surface.
- Copy (Task 7), exact: `Token replaced. We now use it for this Slack app and for every other Slack app the same person made through AX. Don't revoke the token you just pasted: that's the one we use now.`
- Docker-backed files (`store.test.ts`, `plugin.test.ts`, `agents-deleted.test.ts`, `channel-store.test.ts`, the preset-k8s composition test) run one at a time, with `DOCKER_HOST` set and `AX_TESTCONTAINER_START_SLOT_WAIT_MS=600000`.
- Single-file run: `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/<file>`. The `--filter` goes **before** the script.

## Review Focus

These are the five conditions most likely to bite. Each one is pinned by a named test in the task that owns it.

1. **A hand-off Replace.** Grace pastes the new token Ada generated. It must be stored as Ada's, the row keeps Ada, and Grace's own stored token is untouched. Owned by Task 4 (test `R1`).
2. **A person id that can't name a vault ref** (a hand-inserted `ada@example.com`). Connect answers 500 and takes the app back. The boot move skips that install with `invalid-person-id`, and the pass skips that person. Owned by Tasks 2, 3 and 4 (tests `S2`, `M8`, `R5`).
3. **A boot after a half-finished one.** The person token is already there and an old per-install row is still there (its delete failed last boot, and a rotate has happened since). The person token must never be overwritten, and the old row is dropped. Owned by Task 3 (tests `M4`, `M7`).
4. **A reset racing a Rename that re-stores the person's token after the wipe.** Nothing may survive unless an install or a leftover still names that person. Owned by Task 6 (tests `P2`, `P3`).
5. **The pass rotates another person's stored token, but saving the successor fails.** The delete still happens, one error line is logged, and nothing throws. Owned by Task 5 (test `L7`).

---

## File structure

| File | Responsibility | Tasks |
|---|---|---|
| `packages/channel-slack/src/migrations.ts` | leftover column, header prose | 1 |
| `packages/channel-slack/src/store.ts` | leftover person, `list`, `personHasApps`, `removeAll` person, `setConfigTokenAddedAt` | 1, 4 |
| `packages/channel-slack/src/secrets.ts` | `configTokenRef`, the person-token methods, narrowed `put` | 2, 4 |
| `packages/channel-slack/src/secret-cache.ts` | pass-through of the person-token methods | 2, 4 |
| `packages/channel-slack/src/config-tokens.ts` (**new**) | `moveConfigTokens` (boot move), `releaseConfigToken` | 3 |
| `packages/channel-slack/src/admin-routes.ts` | every token use through the person's slot; Replace keeps the person; the per-person leftover pass | 1, 4, 5 |
| `packages/channel-slack/src/plugin.ts` | run the move at boot; reset sweeps person tokens | 6 |
| `packages/channel-web/src/components/admin/SlackTab.tsx` | Replace success notice | 7 |
| `docs/plans/2026-11-09-channel-slack-design.md`, `scripts/__tests__/channel-slack-boundaries.test.js` (comment), `.changeset/slack-config-token-per-person.md` | stale lines, changeset | 8 |

Tests: `src/__tests__/{store,secrets,secret-cache,config-tokens (new),admin-routes,plugin}.test.ts`, `presets/k8s/src/__tests__/channel-slack-composition.test.ts`, `packages/channel-web/src/components/admin/__tests__/SlackTab.test.tsx`.

---

### Task 1: Leftover apps record whose token made them; the store can list installs and ask whether anyone still names a person [tier: sensitive]

Sensitive: a schema migration, plus the TASK-1132 one-statement CTE. No security-checklist (no boundary is touched).

**Files:**
- Modify: `packages/channel-slack/src/migrations.ts` (`ChannelSlackLeftoverAppsTable` `:130-135`, header `:46-58`, append a statement after `:252`)
- Modify: `packages/channel-slack/src/store.ts` (`RemovedInstall` `:38`, `LeftoverApp` `:47-60`, `InstallStore` `:62-131`, `remove` `:331-357`, `removeAll` `:359-371`, `leftoverApps` `:373-387`, `rememberLeftoverApp` `:389-395`)
- Modify: `packages/channel-slack/src/admin-routes.ts` (`undoCreate` `:502-516` and its call `:585`: pass the connecting admin)
- Test: `packages/channel-slack/src/__tests__/store.test.ts` (Postgres), `packages/channel-slack/src/__tests__/admin-routes.test.ts` (the in-memory store `:201-376`, `leaveApp` `:665-673`, leftover object assertions)

**Interfaces:**
- Produces:
  ```ts
  // store.ts
  export interface LeftoverApp { installId: string; appId: string; botName: string; leftAt: Date;
    /** Whose configuration token made the app (TASK-1175); null for an app left before then. */
    connectedByUserId: string | null }
  export type RemovedInstall = Pick<InstallRow, 'installId' | 'appId' | 'teamId' | 'connectedByUserId'>;
  // InstallStore gains / changes:
  list(): Promise<InstallRow[]>;                       // every install, any status: newest config_token_added_at first, then install_id
  personHasApps(userId: string): Promise<boolean>;     // an install OR a leftover row names this person
  rememberLeftoverApp(app: Pick<LeftoverApp, 'installId' | 'appId' | 'botName'> & { connectedByUserId: string }): Promise<void>;
  // migrations.ts: ChannelSlackLeftoverAppsTable.connected_by_user_id: string | null
  ```

- [ ] **Step 1: Write the failing store tests** in `store.test.ts`:
  - `runMigrations adds connected_by_user_id to a leftover table from before it: an old row reads null, and a second run changes nothing`. Drop the table, recreate it in its old four-column shape, insert a row, run `runMigrations` twice, then expect `leftoverApps()` to equal `[{ installId, appId, botName, leftAt: expect.any(Date), connectedByUserId: null }]`.
  - `remove with appLeft moves the install's person into the leftover row in the same statement`. Insert a pending install for `usr_ada`, call `remove(id, { appLeft: true })`, then expect `leftoverApps()[0].connectedByUserId === 'usr_ada'`. Also add `connectedByUserId` to the existing `:474` and `:586` expectations.
  - `rememberLeftoverApp keeps the person it was given; a second remember of the same id keeps the first`. The existing calls at `:597-636` now pass a person.
  - `removeAll returns each removed install's person`. Extend `:373`: `toEqual([{ installId, appId, teamId, connectedByUserId: 'usr_ada' }, …])`.
  - `list returns every install, any status, newest config_token_added_at first, then by install id; [] when there are none`.
  - `personHasApps`: false with nothing stored; true for a pending install's person, an active install's person, and a person named only by a leftover; false for anyone else; a NULL-person leftover never counts.
- [ ] **Step 2: Run** `DOCKER_HOST=… AX_TESTCONTAINER_START_SLOT_WAIT_MS=600000 pnpm --filter @ax/channel-slack exec vitest run src/__tests__/store.test.ts`. Expected: FAIL (`list`/`personHasApps` are not functions, and the column is missing).
- [ ] **Step 3: Implement.**
  - migrations.ts: `ALTER TABLE channel_slack_v1_leftover_apps ADD COLUMN IF NOT EXISTS connected_by_user_id TEXT NULL`, with a comment: NULL means left before TASK-1175, never backfilled because the install row is gone.
  - store.ts: `remove`'s `appLeft` CTE adds `connected_by_user_id` to its `RETURNING` and to the `INSERT`. `rememberLeftoverApp` inserts it. `leftoverApps` selects it. `removeAll` returns it.
  - `personHasApps` is one statement: `SELECT EXISTS (SELECT 1 FROM channel_slack_v1_installs WHERE connected_by_user_id = $1) OR EXISTS (SELECT 1 FROM channel_slack_v1_leftover_apps WHERE connected_by_user_id = $1)`.
  - `list` is `ORDER BY config_token_added_at DESC, install_id ASC`.
  - admin-routes.ts: `undoCreate(accessToken, appId, installId, botName, connectedByUserId: string)`. `createInstall` passes `actor.id`.
  - Rewrite the stale prose: migrations.ts `:46-58` ("No secret and no person." → the person column), and store.ts `LeftoverApp`'s doc.
- [ ] **Step 4: Keep admin-routes.test.ts green.**
  - The memory store gets `list`, `personHasApps`, the leftover `connectedByUserId` (copied from the row in `remove({ appLeft })`, taken from the argument in `rememberLeftoverApp`), and `removeAll`'s person.
  - `leaveApp(w, l, botName?, leftAtMs?, connectedByUserId: string | null = null)`.
  - Add `connectedByUserId: ADA.id` to the leftover object assertions written by Disconnect (`:1985-1987` and the `:1827` breakers) and by Connect's own undo (`:1359-1441`).
  - Run `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/admin-routes.test.ts`. Expected: PASS.
- [ ] **Step 5: Run** store.test.ts (Docker) and admin-routes.test.ts. Expected: PASS. Then `pnpm --filter @ax/channel-slack build`.
- [ ] **Step 6: Commit** `[TASK-1175] channel-slack: leftover apps record whose token made them; the store lists installs and asks whether anyone still names a person`.

---

### Task 2: secrets.ts keeps one configuration token per person, read and written only as that person [tier: sensitive] — **security-checklist**

**Files:**
- Modify: `packages/channel-slack/src/secrets.ts` (header `:10-43`, `SecretStore` `:63-71`, `createSecretStore` `:92-162`)
- Modify: `packages/channel-slack/src/secret-cache.ts` (`:56-93`: pass-through)
- Test: `packages/channel-slack/src/__tests__/secrets.test.ts`, `packages/channel-slack/src/__tests__/secret-cache.test.ts` (its fake `SecretStore` `:22` gains the three methods)

**Interfaces:**
- Consumes: `SecretOwner` (`{ installId, connectedByUserId }`). `connectedByUserId` is the person; `installId` only names the app in log lines.
- Produces:
  ```ts
  export const PERSON_ID_RE: RegExp;                    // /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
  export function configTokenRef(userId: string): string;   // `slack:person:${userId}:config-refresh-token`; throws { code: 'invalid-person-id' }
  // SecretStore gains:
  getConfigToken(app: SecretOwner): Promise<string | null>;   // global-only read as app.connectedByUserId; not-found/empty → null; other faults reject
  putConfigToken(app: SecretOwner, value: string): Promise<void>;  // written as that person; empty value refused before the vault
  removeConfigToken(app: SecretOwner): Promise<void>;         // deleted as that person; never throws; failure → error line { installId, stage: 'config-refresh-token', code }
  ```

- [ ] **Step 1: Write the failing tests** in `secrets.test.ts`. Use the existing `fakeVault`. Use `fakeConfigRefreshToken(...)` for every token value, so no token-shaped literal appears in source.
  - `S1 configTokenRef is slack:person:<id>:config-refresh-token`. Check `'usr_ada'`, a 32-alphanumeric better-auth-shaped id, and a 128-character id.
  - `S2 configTokenRef refuses an id that cannot name a vault ref, before any vault call`. For each of `['', 'ada@example.com', 'a:b', 'a/b', '-x', 'a b', 'x'.repeat(129)]`: `configTokenRef` throws with `code === 'invalid-person-id'`, and the error message does not contain the id. `getConfigToken` and `putConfigToken` reject with that code. `removeConfigToken` resolves and logs one error line with `code: 'invalid-person-id'`. `vault.calls` stays empty.
  - `S3 putConfigToken writes the global api-key row under the person's ref, as that person`. Exact input keys `['kind','ownerId','payload','ref','scope']`, with `scope: 'global'`, `ownerId: null` and `ref: configTokenRef('usr_ada')`. `ctx.userId === 'usr_ada'`, `ctx.agentId === ''`. An empty value is refused with no vault call.
  - `S4 getConfigToken reads the global row only, as the person; two installs of one person read one ref, another person reads another`. Input `toEqual({ ref: configTokenRef('usr_ada'), userId: 'usr_ada', scope: 'global' })`. Not-found and empty both give `null`. Any other fault rethrows.
  - `S5 removeConfigToken deletes as the person; a failure is logged at error with the install, stage config-refresh-token and a code, and never throws`.
  - Extend `no log line or error ever carries a secret value` (`:305`) to cover the three person-token methods.
  - Real vault (the `describe` at `:363`): `S6 a person's token is theirs alone: a user-scoped row under their ref, stored by them or by anyone else, never stands in; deleting the global one doesn't uncover it`. Use `usr_ada` and a 32-alphanumeric id. This also proves the real `REF_RE` accepts the ref.
  - `secret-cache.test.ts`: `person-token calls pass through and leave the cached signing secret alone`. A `putConfigToken` between two signing-secret reads costs no second vault read.
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/secrets.test.ts src/__tests__/secret-cache.test.ts`. Expected: FAIL (not a function).
- [ ] **Step 3: Implement** the three methods and `configTokenRef` in `secrets.ts`, reusing `ctxFor(person)`, `NOT_FOUND`, `pluginErrorCode` and the `remove` logging shape. In `secret-cache.ts`, delegate straight to `inner`, with no `changing()`: the signing secret didn't change. Do **not** narrow `put` yet: admin-routes still writes the per-install name until Task 4. Rewrite the `secrets.ts` header (`:10-43`): three per-install secrets plus one configuration token per person; why the person is in the ref (global rows are keyed by ref alone, `credentials/src/plugin.ts:884-892`); and the person-id rule.
- [ ] **Step 4: Run** the same two files. Expected: PASS. Then run `pnpm --filter @ax/channel-slack build`.
- [ ] **Step 5: security-checklist.** Walk the three threat models for the person ref (vault identity, global-only reads, the id check, no value in logs or errors). Append the walk as a row to `.claude/memory/decisions/2026-11-20-TASK-1175.md`.
- [ ] **Step 6: Commit** `[TASK-1175] channel-slack: one configuration token per person in the vault, read and written only as that person`.

---

### Task 3: `config-tokens.ts` — the boot move, and releasing a token nobody names [tier: sensitive] — **security-checklist**

**Files:**
- Create: `packages/channel-slack/src/config-tokens.ts`
- Test: `packages/channel-slack/src/__tests__/config-tokens.test.ts` (new; a real `HookBus` with a fake vault as in `secrets.test.ts`, `createSecretStore`, and a fake store `{ list, personHasApps }`)

**Interfaces:**
- Consumes: `InstallStore.list` and `personHasApps` (Task 1), the `SecretStore` person methods plus `get` and `remove` (Task 2), `logCode`.
- Produces:
  ```ts
  export async function moveConfigTokens(d: {
    store: Pick<InstallStore, 'list'>;
    secrets: Pick<SecretStore, 'get' | 'remove' | 'getConfigToken' | 'putConfigToken'>;
    logger: Logger;
  }): Promise<{ moved: number; dropped: number }>;   // never throws

  export async function releaseConfigToken(
    d: { store: Pick<InstallStore, 'personHasApps'>; secrets: Pick<SecretStore, 'getConfigToken' | 'removeConfigToken'> },
    app: SecretOwner,
    o: { onFault: (err: unknown) => void; onlyIfStored?: boolean },
  ): Promise<void>;                                   // never throws
  ```

- [ ] **Step 1: Write the failing tests.** Install rows come from a helper `row({ installId, connectedByUserId, configTokenAddedAt })`. The old per-install token sits at `secretRef(id, 'config-refresh-token')`.
  - `M1 moves an install's token to its person and deletes the old one`. Afterwards the person ref holds `T` and the old ref is gone. It returns `{ moved: 1, dropped: 0 }` and logs exactly `[{ level: 'info', msg: 'slack_config_tokens_moved', fields: { moved: 1, dropped: 0 } }]`.
  - `M2 a second run writes nothing, deletes nothing and logs nothing`. No `credentials:set` or `credentials:delete` calls, and it returns `{ moved: 0, dropped: 0 }`. Also cover the case with no installs, or no old tokens.
  - `M3 two installs of one person: the most recently added token wins, both old rows go`. Returns `{ moved: 1, dropped: 1 }`.
  - `M4 a person token that is already there is never overwritten: the old row is dropped`. Returns `{ moved: 0, dropped: 1 }`, and the person ref keeps its value.
  - `M5 two people each get their own`.
  - `M6 a fault anywhere in a person's group leaves that person untouched for this boot; others still move`. One case each, and each logs one error line `slack_config_token_move_failed` with the stage named. `list` throws: stage `list`, nothing else happens. Reading the newer install's old token fails: stage `read-install-token`, and both of that person's old rows stay with no person write. Reading the person token fails: stage `read-person-token`. Storing fails: stage `store-person-token`, and the old row is **not** deleted.
  - `M7 an old row whose delete fails is logged by the secret store, and the next run drops it without touching the person token`. After a rotate between the runs (set the person ref to a new value), the second run keeps the new value.
  - `M8 an install whose person id cannot name a ref is skipped`. Logs `{ installId, stage: 'read-person-token', code: 'invalid-person-id' }`. Its old row stays, and the others still move.
  - `M9 no line or return value carries a token value`. Every vault fault's message embeds every token. Line keys are a subset of `installId | stage | code | moved | dropped`.
  - `X1 releaseConfigToken deletes the token when no install and no leftover names the person`.
  - `X2 keeps it while an install names them; keeps it while only a leftover names them`.
  - `X3 a failed check keeps the token and calls onFault once with the error`.
  - `X4 a delete that fails never throws` (the secret store logs it).
  - `X5 onlyIfStored: nothing stored → no delete call (no tombstone); stored → deleted; the read faulting → deleted anyway`.
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-slack exec vitest run src/__tests__/config-tokens.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `config-tokens.ts`. The header says what each export is for and cites the decisions shard (rows 8, 9). The move's algorithm, which the signature does not determine:
  ```ts
  // groups: installs from store.list() (newest config_token_added_at first), grouped by connectedByUserId, order kept
  for (const [person, installs] of groups) {
    // 1. read every install's old token (secrets.get(install, 'config-refresh-token')); any fault → log, skip person
    // 2. olds = installs whose old token was non-null; none → next person
    // 3. has = (await secrets.getConfigToken(olds[0])) !== null; a fault (incl. invalid-person-id) → log, skip person
    // 4. if (!has) putConfigToken(olds[0], olds[0].token); a fault → log, skip person (delete nothing)
    // 5. moved += has ? 0 : 1; dropped += olds.length - (has ? 0 : 1)
    // 6. for each of olds: await secrets.remove(install, 'config-refresh-token')   // never throws; logs its own failure
  }
  // one info line with { moved, dropped } only when moved + dropped > 0
  ```
  `releaseConfigToken`: `personHasApps(app.connectedByUserId)` returns true → return. A throw → `onFault(err)`, return (the token is kept). With `onlyIfStored`, call `getConfigToken(app)` first: `null` → return, a throw → go on to delete. Then `removeConfigToken(app)`.
- [ ] **Step 4: Run** the file. Expected: PASS. Then run `pnpm --filter @ax/channel-slack build` and `pnpm lint`. The exports are wired in Tasks 4 and 6 of this same PR.
- [ ] **Step 5: security-checklist.** Walk it for the migration of secrets: no values in logs, never overwriting, a fault skips the whole person, and boot never fails. Append the walk to the shard.
- [ ] **Step 6: Commit** `[TASK-1175] channel-slack: move configuration tokens to their person at boot, and release one nobody names`.

---

### Task 4: Every route's token use goes through the person's slot; Replace keeps the install's person [tier: sensitive] — **security-checklist**

**Files:**
- Modify: `packages/channel-slack/src/admin-routes.ts`:
  - header `:52-102`
  - `undoConnect` `:482-494`, `createInstall` `:589-609`
  - `saveRotatedToken` `:683-691`, `deleteSlackApp` `:703-723`, `updateSlackApp` `:735-756`
  - `connectedByName` doc `:758-764`
  - `rename` reset-race `:866-875`
  - `replaceToken` `:931-950`
  - `disconnect` `:1023-1026`
- Modify: `packages/channel-slack/src/store.ts`: `setConfigTokenOwner` (`:96-102`, `:310-318`) → `setConfigTokenAddedAt`, plus the doc at `:20-25`
- Modify: `packages/channel-slack/src/secrets.ts` and `secret-cache.ts`: narrow `put` to `Exclude<SecretName, 'config-refresh-token'>`
- Modify: `packages/channel-slack/src/migrations.ts:12-14`, `:60-63` (prose)
- Test: `admin-routes.test.ts`, `store.test.ts` (Postgres), `plugin.test.ts:1308`, `:1440` (Postgres), `presets/k8s/src/__tests__/channel-slack-composition.test.ts` (Postgres + the real vault)

**Interfaces:**
- Consumes: Task 2's person methods, Task 3's `releaseConfigToken`, Task 1's `personHasApps`.
- Produces:
  - `InstallStore.setConfigTokenAddedAt(installId: string, addedAt: Date): Promise<void>`. One UPDATE of `config_token_added_at` on an **active** row. A missing or pending row throws `InstallStoreError('install-not-active')`. After this change, no store method writes `connected_by_user_id` except `insertPending`.
  - Inside admin-routes: `saveRotatedToken(app: SecretOwner, refreshToken: string): Promise<boolean>` writes via `putConfigToken`. `release(app: SecretOwner): Promise<void>` calls `releaseConfigToken({ store: d.store, secrets: d.secrets }, app, { onFault: (err) => failed('release-config-token', err, app.installId) })`.

- [ ] **Step 1: Write the failing tests** in `admin-routes.test.ts`, with `import { configTokenRef } from '../secrets.js'`.
  - `R1 Grace pastes the token Ada generated: it is stored as Ada's, the row keeps Ada and only the date moves; Grace's own token is untouched`. Rework `:2897`. Before the replace, set `w.vault.set(configTokenRef(GRACE.id), fakeConfigRefreshToken('GRACEOWNSECRET'))`. Afterwards:
    - `w.vault.get(configTokenRef(ADA.id)) === mintedRefresh(2)`, and Grace's ref still holds her value.
    - `onlyRow(w)` equals `{ ...before, configTokenAddedAt: new Date(REPLACED_AT) }`, so `connectedByUserId` stays `ADA.id`.
    - `ONE_REPLACE` reads `'store:setConfigTokenAddedAt'`.
  - `R2 after a replace by another admin, every token read and write still names Ada, and Rename then Disconnect use the replaced token`. Rework `:2929`. The `vaultAs` entries name `ADA.id`. The status reads `connectedBy: 'Ada Admin'` with `connectedAt: new Date(REPLACED_AT).toISOString()`.
  - `R3 every configuration-token vault call names the person in its ref, and none goes to an install's own ref`. Run Ada's Connect, Allow, Rename, Grace's Replace, Rename and Disconnect. For each `i` where `w.vaultCalls[i].ref` starts with `slack:person:`, `w.vaultAs[i].userId` equals the id between `slack:person:` and `:config-refresh-token`. No `credentials:set` has ref `secretRef(installId, 'config-refresh-token')`.
  - `R4 Disconnect keeps the person's token while a leftover or another install names them, and drops it when nothing does`. Three cases:
    - A dead stored token gives `appDeleted:false`. The leftover names Ada, and `w.vault` equals `new Map([[configTokenRef(ADA.id), mintedRefresh(1)]])`.
    - With a second, pending row for Ada in the memory store, the token is kept after Disconnect.
    - `appDeleted:true` gives `w.vault.size === 0`, and the trail ends `…'store:remove', ...SECRET_NAMES.map((n) => `vault:delete ${n}`), 'store:personHasApps', 'vault:delete config-refresh-token'`.
  - `R5 Connect by an admin whose id cannot name a secret: 500, the app is taken back, nothing stored`. Add a user `{ id: 'ada@example.com', isAdmin: true, … }` to the auth stub. Expect `{ status: 500 }`. `deleteApp` is called on the new app, and `w.vault.size === 0`.
  - `R6 Connect's undo after the token was stored drops it when nothing else names the person, keeps it when a leftover does`. Make `setOAuthState` fail. For the "keeps" case, seed LEFT_1 naming Ada, and make `deleteApp` refuse only `LEFT_1.appId` (`no_permission`), so it survives Connect's pass while the new app is still taken back.
  - `R7 the install gone while Rename or Replace was storing its token (a reset): the token goes unless a leftover still names the person`. Rework `:2750` and `:3173`.
- [ ] **Step 2: Run** admin-routes.test.ts. Expected: FAIL. The pins listed in Step 4 also fail at this point, and only for those reasons.
- [ ] **Step 3: Implement.**
  - `createInstall` stores with `putConfigToken(owner, mintedRefreshToken)`. `undoConnect(accessToken, appId, owner: SecretOwner)` ends with `await release(owner)` after `removeAll`.
  - `deleteSlackApp` and `updateSlackApp` read with `getConfigToken(install)` and save through `saveRotatedToken(install, …)`.
  - `rename`'s and `replaceToken`'s reset-race undo becomes `await release(install)`.
  - `replaceToken` calls `saveRotatedToken(install, minted.refreshToken)`, so the token is stored as the install's person, never as `actor.id`. Then `d.store.setConfigTokenAddedAt(installId, new Date(d.now()))`, with failure stage `'save-added-at'` (was `'save-owner'`). Keep `deleteLeftoverApps(minted.accessToken)` as is; Task 5 changes it.
  - `disconnect` calls `await release(install)` after `removeAll`, then logs `slack_disconnected`.
  - Narrow `put`.
  - Rewrite the stale prose:
    - the admin-routes header Secrets bullets (`:57-80`): the person's slot; Replace keeps the person; one token per person serves every app;
    - the `connectedByName` doc: whose token it is, which a Replace never changes;
    - `store.ts:20-25`;
    - `migrations.ts:12-14`, `:60-63`: three per-install secrets plus the person's token under `slack:person:<id>:config-refresh-token`.
- [ ] **Step 4: Move the dependent assertions.** These are the only legitimate shifts. Each one is a card scope bullet or the new ref (decisions shard, "Test model" row).
  - **admin-routes.test.ts**:
    - every `secretRef(installId, 'config-refresh-token')` read of the token, and `configRef(...)` in the Replace describe, becomes `configTokenRef(<person>)`. That includes the Connect vault map `:985-991`;
    - Disconnect trails `:1798-1806` and `:3306-3315` gain `'store:personHasApps', 'vault:delete config-refresh-token'`. Delete-ref lists `:1819-1821`, the Connect-undo list `:1185-1188`, and the vault-hook list `:1915-1922` gain `configTokenRef(ADA.id)` (one more `credentials:delete`);
    - `:1827` and `:1972` with `appDeleted:false` now expect the person's token kept, because the new leftover names Ada (vault size 1, holding whatever was last stored). The `:1827` breaker whose token is already gone stays at size 0: there is nothing to keep;
    - the reset-race undos `:2750` and `:3173`: the last store call is now `personHasApps`, and the trail gains `'store:personHasApps'` before the final `'vault:delete config-refresh-token'`;
    - `STOPS_AFTER` gets `'save-added-at'`, and the leak test's `'setConfigTokenOwner'` failure becomes `'setConfigTokenAddedAt'`;
    - the memory store's `setConfigTokenOwner` becomes `setConfigTokenAddedAt`, and only the date changes;
    - any other test whose pinned trail or delete list runs through a Connect undo, a Disconnect or a reset-race undo gains the same release pair (`store:personHasApps`, then the person ref's delete). **Nothing else may shift.** If a status code, a Slack call, a log line or a row changes anywhere else, that is a bug, not a pin to update.
  - **store.test.ts**: rename `:319` and `:344` to `setConfigTokenAddedAt`. Same assertions, except `connected_by_user_id` must stay as inserted.
  - **plugin.test.ts** `:1308`, `:1440`: use `configTokenRef(ADMIN.id)`.
  - **composition**: add a `readConfigToken(userId)` helper reading `` `slack:person:${userId}:config-refresh-token` `` with `scope: 'global'` (the file is on the `slack:` allowlist). Then:
    - `:881`, `:912` use it;
    - the Disconnect loop at `:1045` also expects the person ref to be `error:`;
    - the Replace test `:1828-1870` keeps `connected_by_user_id === ADMIN`, and the token is read under ADMIN's ref. Retitle it: "…the plugin still reads them as the admin whose token it is…".
- [ ] **Step 5: Run.**
  - admin-routes.test.ts: PASS.
  - store.test.ts and plugin.test.ts (Docker, one at a time): PASS.
  - `DOCKER_HOST=… AX_TESTCONTAINER_START_SLOT_WAIT_MS=600000 pnpm --filter @ax/preset-k8s exec vitest run src/__tests__/channel-slack-composition.test.ts`: PASS.
  - `pnpm --filter @ax/channel-slack build` and `pnpm lint`.
- [ ] **Step 6: security-checklist.** Walk it for Replace writing another person's slot (guarded by Slack's creator-only check), release under the lock, and fail-closed person ids. Append the walk to the shard.
- [ ] **Step 7: Commit** `[TASK-1175] channel-slack: every configuration-token use goes through its person; Replace never moves an app to another person`.

---

### Task 5: The leftover pass deletes each app with the token of whoever made it [tier: sensitive] — **security-checklist**

**Files:**
- Modify: `packages/channel-slack/src/admin-routes.ts`:
  - `stopsLeftoverPass` `:241-255` → `endsLeftoverPass`
  - `deleteLeftoverApps` `:518-558`
  - `connect` `:824`
  - `replaceToken` `:952-958`
  - `forgetLeftoverApp` `:1046-1051`
- Test: `packages/channel-slack/src/__tests__/admin-routes.test.ts` (new describe `'leftover apps go with the token of whoever made them (TASK-1175)'`)

**Interfaces:**
- Consumes: Task 4's `saveRotatedToken(app)` and `release(app)`; `getConfigToken`; `LeftoverApp.connectedByUserId`.
- Produces: `deleteLeftoverApps(inHand: { userId: string; accessToken: string }): Promise<void>`. Connect passes `{ userId: actor.id, accessToken }`. Replace passes `{ userId: install.connectedByUserId, accessToken: minted.accessToken }`.

- [ ] **Step 1: Write the failing tests.** Seed a stored token with `w.vault.set(configTokenRef(X.id), fakeConfigRefreshToken('…'))`. Seed a leftover with `leaveApp(w, LEFT_n, name, at, X.id)`. Use `w.connect(SECOND_PAIR, GRACE)` for "Grace connects".
  - `L1 Grace's Connect deletes Ada's leftover with Ada's stored token: one rotate, the successor stored before the delete, then Ada's token goes`. The trail from the start is: `store:current`, `store:leftoverApps`, `vault:get config-refresh-token`, `slack:rotateConfigToken`, `vault:set config-refresh-token`, `slack:deleteApp`, `store:forgetLeftoverApp`, `store:personHasApps`, `vault:delete config-refresh-token`, `slack:createApp`. `deleteApp` args are `[MINTED_ACCESS, LEFT_1.appId]`. Afterwards Ada's ref is gone and Grace's ref holds the token her Connect minted.
  - `L2 two of Ada's leftovers share one rotate`.
  - `L3 an app left before TASK-1175 names no one: the token in hand tries it, as before; Ada's in the same pass gets Ada's`. The NULL-person app gets `SECOND_ACCESS`, and Ada's gets `MINTED_ACCESS`.
  - `L4 another person's token missing or unreadable: their apps are skipped and logged, the rest still go`. A missing token logs warn `{ installId: LEFT_1.installId, stage: 'leftover-config-token', code: 'missing' }`. A vault fault logs error with the vault's code. A leftover whose person id can't name a ref (`'ada@example.com'`) logs error with `code: 'invalid-person-id'`, and no vault call is made for it.
  - `L5 another person's token refused at the rotate skips only their apps; Slack not answering (timeout) ends the pass, and Connect still creates its app`. Log stage is `leftover-rotate`.
  - `L6 the token in hand refused (invalid_auth) skips only its own apps; another person's still go`.
  - `L7 saving another person's successor failing still deletes with the minted token`. Exactly one error line with `stage: 'save-config-token'`, and no throw.
  - `L8 "I deleted it" drops the maker's token once nothing names them; keeps it while their install or another leftover does`.
  - `L9 one token, two apps (the card's acceptance)`:
    1. Ada connects, and LEFT_1 (Ada) is seeded.
    2. Ada renames (mintedRefresh(1) → (2)).
    3. Ada disconnects (`appDeleted:true`). Ada's token is kept as `mintedRefresh(3)`, because LEFT_1 still names her.
    4. Grace connects. The pass rotates exactly `mintedRefresh(3)` (the next use reads the successor), deletes LEFT_1 with `MINTED_ACCESS`, and then Ada's ref is gone.
  - `L10 Replace fixes both`:
    1. Ada connects, and LEFT_1 (Ada) is seeded.
    2. Slack now refuses `mintedRefresh(1)` (`invalid_refresh_token`): Rename gives 502 `slack-config-token`.
    3. Ada replaces with `SECOND_REFRESH`: 200, and LEFT_1 is deleted with `MINTED_ACCESS`.
    4. Rename now gives 200, rotating `mintedRefresh(2)`.
  - Extend `secrets never leave` (`:3324`) with worlds L1, L4 (vault fault), L5 and L7.
- [ ] **Step 2: Run** admin-routes.test.ts. Expected: the new tests FAIL. Every existing pass test (`:2011-2270`, `:3201`) still passes, because they seed only NULL-person leftovers.
- [ ] **Step 3: Implement.** The algorithm, which the signature does not determine:
  ```ts
  // endsLeftoverPass(err): SlackApiError && (UNCONFIRMED_CODES | HTTP_5XX | 'ratelimited')  — Slack-wide: every later call would wait out a deadline
  const apps = await d.store.leftoverApps();           // a store fault still throws, before Slack is asked
  const minted = new Map<string, string | null>();     // another person → this pass's access token, null = none to be had
  let inHandDead = false;
  const released = new Map<string, string>();         // another person whose app was forgotten → that app's installId
  try {
    for (const app of apps) {
      const person = app.connectedByUserId ?? inHand.userId;
      let token: string | null;
      if (person === inHand.userId) token = inHandDead ? null : inHand.accessToken;
      else {
        if (!minted.has(person)) {
          // getConfigToken (fault → failed('leftover-config-token'); null → warn line code 'missing') → null
          // rotateConfigToken → fault: failed('leftover-rotate'); endsLeftoverPass(err) ? return : null
          // await saveRotatedToken({ installId: app.installId, connectedByUserId: person }, rotated.refreshToken)  // logged; delete goes on
          minted.set(person, /* rotated.accessToken | null */);
        }
        token = minted.get(person)!;
      }
      if (token === null) continue;
      // deleteApp as today: app_not_found → gone; else failed('delete-leftover-app'); endsLeftoverPass → return;
      //   TOKEN_ERRORS → that token is dead (inHandDead = true, or minted.set(person, null)); continue
      // forget + slack_leftover_app_deleted as today
      if (app.connectedByUserId !== null && app.connectedByUserId !== inHand.userId) released.set(app.connectedByUserId, app.installId);
    }
  } finally {
    for (const [person, installId] of released) await release({ installId, connectedByUserId: person });
  }
  ```
  `forgetLeftoverApp`: collect the non-null `connectedByUserId` of each entry it forgets, then `release` each person once, still inside the lock. Update the `deleteLeftoverApps` doc (`:518-533`): drop "UNMEASURED" (TASK-1163 check 1 measured that a newer token of the creator deletes the app), and describe the per-person rule.
- [ ] **Step 4: Run** admin-routes.test.ts. Expected: PASS, with no existing assertion changed in this task.
- [ ] **Step 5: security-checklist.** Walk it for the pass using another person's stored token (only app ids from channel-slack's own table, lock hold bound, logs code-only). Append the walk to the shard.
- [ ] **Step 6: Commit** `[TASK-1175] channel-slack: each leftover app is deleted with the token of whoever made it`.

---

### Task 6: plugin.ts runs the move at boot; the reset sweeps person tokens [tier: sensitive] — **security-checklist**

**Files:**
- Modify: `packages/channel-slack/src/plugin.ts`: header `:84-88`; init after `secrets` is created (`:306-310`) and before the route list (`:330`); `subscribeResetCleanup` `:511-544` and its doc `:485-510`
- Test: `packages/channel-slack/src/__tests__/plugin.test.ts` (Postgres). `boot(config, o: { seed?: (s: Services) => void } = {})` runs `seed(s)` before `createTestHarness`.

**Interfaces:**
- Consumes: `moveConfigTokens` and `releaseConfigToken` (Task 3), and `RemovedInstall.connectedByUserId` (Task 1).

- [ ] **Step 1: Write the failing tests.**
  - `P1 the first boot moves an install's configuration token to its admin's own place; the next boot does nothing`.
    - First boot: `await runMigrations(probe)`, then `insertActiveInstall()`. Boot with the seed `s.vault.set(secretRef(INSTALL_ID, 'config-refresh-token'), OLD)`, and `captureLogs()` before the boot. Expect `s.vault.get(configTokenRef(ADMIN.id)) === OLD`, `s.vault.has(oldRef) === false`, and one `slack_config_tokens_moved` line with `moved: 1, dropped: 0`. `JSON.stringify(logs)` does not contain `OLD`.
    - Second boot, seeded only with `configTokenRef(ADMIN.id) → OLD`: `s.credentialSets === 0`, `s.credentialDeletes` is `[]`, and there is no move line.
  - `P2 a rename that re-stores the token after the reset wiped the vault leaves no token behind`. Rework `:1675`: `ref` becomes `configTokenRef(ADMIN.id)`, and `s.credentialDeletes` toEqual `[configTokenRef(ADMIN.id)]`.
  - `P3 a reset keeps a person's re-stored token while a leftover app still names them`. Call `insertActiveInstall()`, so ADMIN is a removed install's person. Remember a leftover for `ADMIN.id` through `createInstallStore(probe)`, put the person token in `s.vault`, and fire the reset. The install row is gone, but the token is still there, because the leftover names ADMIN.
  - The existing `:1739` test (no tombstone rows: `credentialDeletes` is `[]`) and the old-ref reset tests `:1750-1810` must pass unchanged.
- [ ] **Step 2: Run** `DOCKER_HOST=… AX_TESTCONTAINER_START_SLOT_WAIT_MS=600000 pnpm --filter @ax/channel-slack exec vitest run src/__tests__/plugin.test.ts`. Expected: P1–P3 FAIL.
- [ ] **Step 3: Implement.**
  - In init, call `await moveConfigTokens({ store, secrets, logger })` right after `secrets` exists and before any route is built. It never throws.
  - In `subscribeResetCleanup`, after the per-install `deleteLeftoverSecrets` loop: for each distinct `connectedByUserId` among `removed`, call `releaseConfigToken({ store, secrets }, { installId: <that person's first removed install>, connectedByUserId }, { onlyIfStored: true, onFault: (err) => logger.error('slack_reset_cleanup_failed', { installId, stage: 'release-config-token', code: logCode(err) }) })`. Wrap the log call so a throwing logger can't skip a person, as the existing loop does.
  - Rewrite the stale prose: the header's "the install's four secrets" (`:85`) and the reset doc. A person token re-stored after the wipe goes unless an install or a leftover still names its person.
- [ ] **Step 4: Run** plugin.test.ts (Docker). Expected: PASS. Then run `pnpm --filter @ax/channel-slack test` (every file; Docker files one at a time, as above).
- [ ] **Step 5: security-checklist.** Walk it for boot ordering (before routes, never fails the boot) and the reset race. Append the walk to the shard.
- [ ] **Step 6: Commit** `[TASK-1175] channel-slack: move configuration tokens at boot; a reset sweeps person tokens nobody names`.

---

### Task 7: Admin › Slack says a Replace fixes every app of that person [tier: mechanical]

**Files:**
- Modify: `packages/channel-web/src/components/admin/SlackTab.tsx` (notice `:1029-1036`; header `:14-15`: "who added the token and when" becomes "whose configuration token it uses and when it was added")
- Test: `packages/channel-web/src/components/admin/__tests__/SlackTab.test.tsx:801-804`

No component change: the same `Alert` and `AlertDescription`, with no link now. CLAUDE.md asks for the `shadcn` skill on any UI change: load it and confirm there is nothing to add. Do **not** touch the Replace form copy or `slack-not-app-manager`: TASK-1164 owns them.

- [ ] **Step 1: Update the test.** Its expected `textContent` becomes exactly: `Token replaced. We now use it for this Slack app and for every other Slack app the same person made through AX. Don't revoke the token you just pasted: that's the one we use now.`
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-web exec vitest run src/components/admin/__tests__/SlackTab.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the notice with that exact text. Its `<SlackAppsLink />` and the "To retire the old one…" sentence go: Slack allows one token per person, so the old one was revoked before the new one could exist.
- [ ] **Step 4: Run** the same file. Expected: PASS. Then run `pnpm --filter @ax/channel-web build` (channel-web's tsc includes tests).
- [ ] **Step 5: Commit** `[TASK-1175] channel-web: a Slack token replace says it serves every app that person made`.

---

### Task 8: Design doc, guard comment and changeset (rule 5) [tier: mechanical]

**Files:**
- Modify: `docs/plans/2026-11-09-channel-slack-design.md`
- Modify: `scripts/__tests__/channel-slack-boundaries.test.js:16-18` (comment only)
- Create: `.changeset/slack-config-token-per-person.md`

- [ ] **Step 1: Design doc.** Each line below states a fact; write it as prose in the doc's voice.
  - §3 `:285` (Replacing the token): the minted token is stored as **the token of the person whose app it is** (the install's), whoever pastes it. It also serves every other Slack app that person made through AX. "record who added it" becomes "record when". Replace the "keeps working on Slack until whoever generated it revokes it" sentence: Slack allows one token per person per workspace (§8 Q5), so the old one was revoked before the new one could be generated.
  - §3 `:287-297`: AX keeps the refresh token **once per person** (TASK-1175), under `slack:person:<userId>:config-refresh-token`, shared by every app they made through AX. Admin settings shows whose token it is and when it was last added.
  - §3 `:298-303`: replace "Whether that Revoke also ends … is unmeasured …" with **measured (TASK-1163 check 4): it does**. The token AX held, rotated from the revoked one, failed at `rotate` with `invalid_refresh_token`. Add: Disconnect keeps the person's token while a leftover app still names them, and drops it after.
  - §3 `:304-313`: leftover apps record whose token made them, and are deleted with that person's token (the pasted or minted one when it is theirs, else their stored one). Replace "Whether a new token can delete an app an earlier token of the same person made is unmeasured" with **yes (TASK-1163 check 1)**.
  - §4 step 3 `:402-404`: replace "under the bot's own install … each bot has its own token and manager" with: the rotated token is stored as **the approver's** (one per person, TASK-1175), shared with every other app they made through AX; the bot records its approver as its manager. In Lifecycle `:445-449`: a Replace of the approver's token fixes all their apps at once.
  - §7 `:944`: the same "unmeasured" sentence becomes measured (TASK-1163 check 4).
  - §8 Q6 `:972-983`: add "Stored once per person (decided 2026-11-20, Vinay; TASK-1175)."
  - §9 `:1012-1020`: TASK-1175 (one token per person) is a phase-2 prerequisite. Note it is done once merged.
- [ ] **Step 2: Guard comment.** `four per-install secrets in the credentials vault under slack:<installId>:<name>` becomes `three per-install secrets under slack:<installId>:<name> and one configuration token per person under slack:person:<userId>:config-refresh-token`.
- [ ] **Step 3: Changeset** (patch for both packages), exact text:
  ```markdown
  ---
  '@ax/channel-slack': patch
  '@ax/channel-web': patch
  ---

  Slack's configuration token now belongs to a person, not to one Slack app. Slack lets each person hold one configuration token per workspace, and only the token of whoever created a Slack app can change or delete it. So AX keeps one token per person and uses it for every Slack app they made through AX. Whenever any of those apps uses it, the fresh token Slack hands back is saved for all of them.

  For admins: **Replace** in Admin › Slack now also fixes every other Slack app the same person made through AX, and the token stays that person's, whoever pastes it ("Added by" keeps their name and shows the new date). Disconnect keeps the token while a Slack app we couldn't delete still needs it.

  For whoever runs the deployment: the first start after this update moves the token AX already holds to its new place, and logs only counts. If you roll back past this change, the older build can't find the token: use **Replace** there, and once more after upgrading again.
  ```
- [ ] **Step 4: Run** `pnpm test:scripts`. Expected: PASS (the guard still finds every `slack:` literal only in allowed files).
- [ ] **Step 5: Commit** `[TASK-1175] docs: one Slack configuration token per person; TASK-1163's measured answers`.

---

## Final gate (after Task 8)

- [ ] `pnpm build && pnpm lint`
- [ ] `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`. Docker-backed packages run one at a time, with `AX_TESTCONTAINER_START_SLOT_WAIT_MS=600000`. Note the `@ax/auth-better` teardown trap in CLAUDE.md.
- [ ] `git grep -n "setConfigTokenOwner\|put([^)]*'config-refresh-token'" -- packages presets`. Expected: nothing.
- [ ] The PR security note combines the five checklist rows, plus the residuals in the decisions shard (row "Residuals").
- [ ] PR body: "No boundary review: no hook, IPC action or manifest change." List the deliberate test shifts (decisions shard, "Test model" row).

## Handoff notes for the builder

- **Learnings to return** (decisions shard, last row):
  - a phase-2 bot's token is its approver's person token, so there is no per-bot secret;
  - every token use must hold the shared admin lock;
  - `personHasApps` counts bot rows automatically;
  - the shared Disconnect's "Revoke" advice must change once a person can have other live apps;
  - the key has no workspace segment, so add one before a person's apps can span two workspaces.
- **Follow-ups (do not build):**
  - remove `moveConfigTokens` once every deployment has booted this build;
  - reword "Added by" if the walk shows admins misread it after a hand-off Replace;
  - a real-Slack walk item: Replace by a second AX admin with the creator's own new token (the hand-off) keeps "Added by" as the creator and still deletes the creator's leftovers.
