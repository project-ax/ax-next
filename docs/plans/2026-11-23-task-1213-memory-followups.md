# TASK-1213: Team memory follow-ups — an unrecognized stored source fails closed end to end; names in the `/memory` export; the caller's own name counts; the agent's name and "a teammate" refused; a deadline on name lookups — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a team agent, a session whose stored source this build doesn't recognize recalls shared rows only, end to end. The `/memory` export shows teammates by name, never `user:<id>`. A member can't pass for the caller, for the agent, or for the "a teammate" fallback. A stalled name lookup can't hold up a recall, the memory block or an export for more than 2 s.

**Architecture:**
- `@ax/core`'s `AgentContextSource` gains a fourth value, `'unrecognized'`. session-postgres (`normalizeSource`) and ipc-core (`sessionSource`) read a stored source they can't place as `'unrecognized'` instead of `'external'`. Every exhaustive switch places it as the least privileged value. On a team agent, `recallAudienceScope` gives it `{ audience: 'shared' }`. Nothing ever writes or mints it.
- `member-names.ts` gains three rules and a deadline. `memberName` refuses the agent's own name and "a teammate". `memberLabels` counts the caller's own name as a holder, and gives up after `MEMBER_NAMES_DEADLINE_MS`. `MemoryAccess` carries the agent's display name from the `agents:resolve` call it already makes.
- The exporter calls `memberLabels` once per pass, and `buildFactsExport` prints labels where it printed `user:<id>`.

No new hook, no hook signature change, no manifest change. One value is added to a hook-surface type (`AgentContextSource`), and one returns contract is widened (session-postgres `session:resolve-token`). See Boundary review.

**Tech Stack:** TypeScript, vitest, the better-sqlite3 memory harness (`packages/memory/src/__tests__/harness.ts`), testcontainers Postgres (session-postgres and `presets/memory` tests; they need `DOCKER_HOST`, see CLAUDE.md "Docker-backed tests").

**Spec:** card TASK-1213. Its four items:
1. Carry an "unrecognized source" flag through session-postgres and ipc-core. Today a stored unknown source arrives as `external`, so it reads like an outsider (unscoped), not fail-closed.
2. Members' names, not raw ids, in the `/memory` export.
3. Duplicate display names across a team: disambiguate them, and count the caller's own name.
4. Refuse the agent's own name and "a teammate" as resolved names. Put a time limit on name lookups.

Acceptance: item 1 has a test where an unknown source stays shared-scoped end to end. The others each need a unit test.

**Read the planner's decisions first: `.claude/memory/decisions/2026-11-23-TASK-1213.md`.** Append your own rows there, never to a root archive. Prior decisions this card revisits: `decisions/2026-11-22-TASK-1209.md` rows 17, 27, 35, 38–43. Design: `docs/plans/2026-11-09-channel-slack-design.md` §4c.

## The premise, checked

- **Claim 1 is true.** A stored source this build doesn't know reaches memory as `'external'`:
  - session-postgres `normalizeSource` maps it (`packages/session-postgres/src/store.ts:228-231`, read by `resolveToken` `:344` and `get` `:380`). The `session:resolve-token` returns schema admits only three values (`plugin.ts:302`).
  - ipc-core `sessionSource` maps it again (`packages/ipc-core/src/auth.ts:87-106`, used at `:180`). Its only resolver caller is `authenticate`.
  - Both listeners stamp `auth.source` onto every runner-rebuilt ctx (`ipc-server/src/listener.ts:208`, `ipc-http/src/listener.ts:204`).
  - On a team agent, `recallAudienceScope` returns `{}` for `'external'` (`packages/memory/src/audience.ts:116-122`), and `memberLabels` names members for it (`member-names.ts:197`). So it reads unscoped and named, like an outsider. Personal agents were already fail-closed.
- **The `/memory` mount has no stored-source path.** `sandbox:memory-mounts` reads `owner.source` from `sandbox:open-session`'s input, which comes from the orchestrator's host-built ctx (`chat-orchestrator/src/orchestrator.ts:4802`). The opening turn's ctx is host-built too. `OpenSessionInputSchema` admits only routine/user/external (`sandbox-protocol/src/schemas.ts:318`). So the mount half of "fail closed" is pinned at unit level (the mount follows `recallAudienceScope`). Only recall has an end-to-end path, and Task 2 tests it.
- **Item 2:** `export-render.ts` prints the raw key in team Profile headings (`:142`), user-journal headings (`:248`) and Recent lines (`statementLine`, `:85-97`). The exporter has `access` and a ctx in `runPass` (`exporter.ts:138-145`).
- **Item 3:** per-answer collisions already read "a teammate" (`member-names.ts:233-244`). The caller is skipped (`:186`), so its name is never counted. A team-wide check needs every member's name. `teams:list-members` requires an admin actor (`packages/teams/src/plugin.ts:291`), and there is no batch `auth:get-user`.
- **Item 4:** `memberName`'s reserved words don't include "a teammate" (`member-names.ts:109`), and nothing compares the agent's own name. `agents:resolve` already returns `agent.displayName` (`packages/agents/src/types.ts:177`), and `resolveMemoryAccess` already calls it (`packages/memory/src/access.ts:35-38`). `memberLabels` awaits its lookups with no deadline (`:209-232`). The bus's per-service timeout belongs to the callee, so the caller has to race its own timer.
- **What made the card look true:** the TASK-1209 changeset's "Not done yet" list (`.changeset/memory-outsiders-same-as-members.md:19-28`), the same list in design §4c (`:1173`), and the TASK-1209 plan's follow-ups. All three are accurate today, so no stale line generated the card. This card makes them false, so Task 7 corrects them, along with every code comment that says a stored unknown source "reads as `'external'`".

## Scope decisions (details in the decisions shard)

- **Item 1 is a new `AgentContextSource` member, not a separate flag field.** It's one field for one concept, and the compiler forces all five exhaustive sites to place it. A flag would be a second field every future consumer has to remember. An out-of-type sentinel would fail the returns-schema enums at the bus.
- **Item 3: the caller's own name counts, and duplicates keep reading "a teammate". The team-wide check is not built.** It needs a new team-roster capability (a host-only `@ax/teams` hook plus a name lookup per member per answer). It would also leave two real same-named teammates permanently nameless. That trade is a human's call, so it goes in the PR body as a follow-up. "Bob Smith (2)"-style numbering was rejected by TASK-1209 row 38, and it tells nobody which Bob.
- **Item 4's deadline is 2 000 ms, and all-or-nothing.** A partial name set can't be collision-checked.

## Boundary review

**`AgentContextSource` (`@ax/core`, on every hook's ctx) gains `'unrecognized'`, and session-postgres's `session:resolve-token` returns contract admits it.**
- **Alternate impl:** `session:resolve-token` already has two: session-postgres, and session-inmemory. session-inmemory validates at create and holds no raw rows, so it never answers `'unrecognized'`. Any future store that keeps raw values would. `ctx.source = 'unrecognized'` comes from both listeners (ipc-server, ipc-http) through ipc-core.
- **Payload field names that might leak:** none. "unrecognized" names no backend.
- **Subscriber risk:** a subscriber that tests `ctx.source === 'external'` to spot an outsider would miss it. None exists in product code (checked). Core's doc already says to ask `isOutsiderTurn`, which is `true` for it. An exhaustive switch over the type won't compile until it places the value.
- **Wire surface:** none. `source` is host-only and never on `@ax/ipc-protocol`. The listeners stamp it from the session record. `session:create` (both stores) and `OpenSessionInputSchema` keep refusing it, unchanged, so it is read back only and never written.

`MemoryAccess.agentName` is internal to `@ax/memory`, not a hook. `@ax/memory`'s manifest doesn't change.

## Global Constraints

- **Personal agents are unchanged.** That covers recall, mount, labels and export, and they make no `auth:get-user` or `teams:is-member` call. Every personal-agent test passes unedited.
- **Don't touch:**
  - `packages/channel-web`, `packages/channel-slack`, `packages/tool-policy`, `packages/host-grants`, the credential proxy, the claude-sdk runner (in-flight TASK-1214, TASK-1212, TASK-1207);
  - `packages/memory/src/self-report.ts` (TASK-1210 waits on this card and works there);
  - `packages/memory/src/extraction-prompt.ts` (fingerprint-pinned);
  - `packages/sandbox-protocol` and `packages/session-inmemory` (they must keep refusing `'unrecognized'` as they do today).
- **Names:** read only `displayName`. Never render or log `email` or `isAdmin`. A name reaches any sink only through `memberName`, then that sink's `escapeStatementText`.
- **`'unrecognized'` is read-only.** No code path may create a session or a ctx with it, except tests.
- **Pre-PR gate:** `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts && pnpm lint`. `pnpm build` is the real audit for Task 1, because it's the compiler that finds every switch.
- **Mutation tests:** run the ones named in each task on the committed tree, and record them in the decisions shard (TASK-1209's practice).

## Review Focus

1. **A stored source that differs only in case or spacing** (`'External'`, `' external'`, `''`) reads `'unrecognized'`, never `'external'`. Task 1 pins it in both producers.
2. **A session with an unrecognized source still captures.** It files no person fact (`speakerScope` is `'withheld'`), and its rows carry no conversation. Task 1 adds both rows.
3. **A deadline that fires after some names came back** names nobody in that answer. Task 5.
4. **An export pass from a turn whose recall is scoped** names nobody, and the next pass from a member's turn names them again. Task 6.
5. **A member renamed to the agent's name in another case, spacing or width** (`fern.`, `ＦＥＲＮ`) is refused, and so is `A-Teammate.` Task 3.

---

### Task 1: A stored source this build doesn't recognize reads as `'unrecognized'`, and fails closed everywhere [tier: sensitive]

**Needs `security-checklist`:** IPC auth hop, session-store read path, a core ctx type, and a memory recall and mount boundary.

**Files:**
- Modify: `packages/core/src/context.ts`:
  - `:195` (the union);
  - `:198-213` (`isAttendedTurn`);
  - `:215-237` (`isOutsiderTurn` and its doc);
  - `:262-309` (the `source` and `audience` docs).
- Modify: `packages/memory/src/audience.ts`:
  - `:17-55` (the read header);
  - `:59-110` (the `recallAudienceScope` doc: steps 2 and 3);
  - `:112-131` (the switch).
- Modify: `packages/memory/src/conversation.ts`:
  - `:30-38` (doc);
  - `:51-66` (the switch).
- Modify (comments only): `packages/memory/src/plugin.ts:707-740` (mount), `packages/memory/src/member-names.ts:21-32` (header).
- Modify: `packages/ipc-core/src/auth.ts`:
  - `:84-106` (`KNOWN_SOURCES`, `sessionSource` and its doc);
  - `:173-180` (comment).
- Modify: `packages/session-postgres/src/store.ts:216-231` (`normalizeSource` and its comment).
- Modify: `packages/session-postgres/src/plugin.ts`:
  - `:199-208` (`SessionResolveTokenOutput.source` doc);
  - `:299-302` (returns enum).
- Test: `packages/core/src/__tests__/context.test.ts:460-489`
- Test: `packages/memory/src/__tests__/audience.test.ts`:
  - `OUTSIDER_TURNS` `~:789-796`;
  - the scope table `:857-893`;
  - the `speakerScope` table `~:2532-2547`.
- Test: `packages/memory/src/__tests__/observer.test.ts:1007-1019`, `packages/memory/src/__tests__/export.test.ts:318-326`, `packages/memory/src/__tests__/member-names.test.ts:503-533`
- Test: `packages/ipc-core/src/__tests__/auth.test.ts:155-183`
- Test (Docker): `packages/session-postgres/src/__tests__/plugin.test.ts`:
  - `:566-570` (comment);
  - `:640-665` (the `'weird'` test);
  - `:671-677` (create-rejects table).

**Interfaces:**
- Produces (`@ax/core`): `type AgentContextSource = 'routine' | 'user' | 'external' | 'unrecognized'`.
  - `isAttendedTurn({ source: 'unrecognized' })` is `false`.
  - `isOutsiderTurn({ source: 'unrecognized' })` is `true`.
- Produces (`@ax/memory`, internal):
  - `recallAudienceScope({ source: 'unrecognized', audience }, { visibility: 'team' })` is `{ audience: 'shared' }` for every `audience`. Personal agents get the same through the outsider step, with no code change.
  - `conversationOf({ conversationId, source: 'unrecognized' })` is `undefined`.
  - `speakerScope` is `'withheld'` through `isOutsiderTurn`, with no code change.
- Produces (session-postgres, internal): `normalizeSource(raw)`.
  - `null` or `undefined` gives `null`.
  - `'routine'`, `'user'` or `'external'` gives itself.
  - Anything else gives `'unrecognized'`, including a stored `'unrecognized'`, `''` and `'External'`.
  - Returns schema: `source: z.enum(['routine', 'user', 'external', 'unrecognized']).nullable()`.
- Produces (ipc-core, internal): `KNOWN_SOURCES` gains `unrecognized: true`. `sessionSource(raw)`:
  - absent gives `null`;
  - a `KNOWN_SOURCES` key gives itself;
  - anything else gives `'unrecognized'`.
- Relied on, unchanged: `session:create` refuses `owner.source: 'unrecognized'` (`session-postgres/src/plugin.ts:576`, `session-inmemory/src/plugin.ts:234`), and so does `OpenSessionInputSchema`.

- [ ] **Step 1: Write the failing tests** (mirror the neighbouring `'satellite'` rows, and cast with `as never` where a type refuses the value):
  - `context.test.ts`:
    - `isAttendedTurn fails closed` gains `expect(isAttendedTurn({ source: 'unrecognized' })).toBe(false)`;
    - the `isOutsiderTurn` table gains `{ label: "'unrecognized'", source: 'unrecognized', outsider: true }`.
  - `audience.test.ts` scope table gains six rows:
    - `['shared', 'unrecognized', 'team', { audience: 'shared' }]`;
    - `['public', 'unrecognized', 'team', { audience: 'shared' }]`;
    - `['private', 'unrecognized', 'team', { audience: 'shared' }]`;
    - `[undefined, 'unrecognized', 'team', { audience: 'shared' }]`;
    - `['private', 'unrecognized', 'personal', { audience: 'shared' }]`;
    - `[undefined, 'unrecognized', 'personal', { audience: 'shared' }]`.
  - `audience.test.ts`, more rows:
    - `OUTSIDER_TURNS` gains `['shared', 'unrecognized']` and `['private', 'unrecognized']`;
    - the `speakerScope` table gains `['private', 'unrecognized', 'team', 'withheld']`, `['shared', 'unrecognized', 'team', 'withheld']` and `['private', 'unrecognized', 'personal', 'withheld']`.
  - `observer.test.ts` `conversationOf` table gains ``['`unrecognized` drops it', 'unrecognized', undefined]``.
  - `export.test.ts`: the "gets no mount and nothing is flushed" table gains three rows:
    - `['team', 'an unrecognized-source shared', { audience: 'shared', source: 'unrecognized' }]`;
    - `['team', 'an unrecognized-source unstamped', { source: 'unrecognized' }]`;
    - `['personal', 'an unrecognized-source private-stamped', { audience: 'private', source: 'unrecognized' }]`.
  - `member-names.test.ts`: "asks nobody in a turn from a source this build doesn't know, on a team agent" becomes `it.each(['satellite', 'unrecognized'])`.
  - `auth.test.ts`, the "fails closed on what the resolver returns" table:
    - `an unknown source` (`'bogus'`) and `an empty source` (`''`) now want `source: 'unrecognized'`;
    - add `{ label: 'a source differing only in case', resolved: { source: 'External' }, want: { source: 'unrecognized', audience: null } }`;
    - add `{ label: "a resolver's own 'unrecognized'", resolved: { source: 'unrecognized' }, want: { source: 'unrecognized', audience: null } }`;
    - rewrite the comment above it to say `'unrecognized'`.
  - `session-postgres` `plugin.test.ts`:
    - the `'weird'` test becomes `it.each(['weird', 'External', ' external', '', 'unrecognized'])`, named "a stored source this build does not recognize (%j) resolves as 'unrecognized'; an unknown audience as 'shared' (fail closed, TASK-1213)". It expects `source: 'unrecognized'`, `audience: 'shared'`.
    - the create-rejects table gains `['source', 'unrecognized']`.

- [ ] **Step 2: Run them and see them fail**
  - Run `pnpm --filter @ax/core test`, `pnpm --filter @ax/memory test`, `pnpm --filter @ax/ipc-core test` and `pnpm --filter @ax/session-postgres test` (Docker).
  - Expected: the new rows fail. The memory team rows answer `{}` today, ipc-core and session-postgres answer `'external'`, and core answers through its `default` branch.

- [ ] **Step 3: Implement**
  - **Core:** add the member.
    - `isAttendedTurn`: a `case 'unrecognized':` next to `'routine'`/`'external'` (false).
    - `isOutsiderTurn`: a `case 'unrecognized':` next to `'external'` (true).
    - The `default` branches stay; they cover host-built out-of-type values.
  - **Memory, `recallAudienceScope`:** `case 'unrecognized': return { audience: 'shared' };` as its own case before `default`.
  - **Memory, `conversationOf`:** `case 'unrecognized': return undefined;`.
  - **ipc-core:** add the key, and make the fallback `'unrecognized'`.
  - **session-postgres:** make the `normalizeSource` fallback `'unrecognized'`, and widen the returns enum. Comment: "read back only; `session:create` still refuses it".

- [ ] **Step 4: Fix every comment that says a stored unknown source reads as `'external'`**
  - Locations: the `audience.ts` header (`:26-31`), step 2 (`:78-93`), step 3 (`:98-101`); `plugin.ts:714-736`; `member-names.ts:27-32`; core's `audience` doc (`:296-302`); `auth.ts:97-99,173-178`; `store.ts:219-227`; `plugin.ts:203-207`.
  - New meaning for each: a stored source this build doesn't recognize reads as `'unrecognized'`. That counts as an outsider for every gate, and fails closed for recall on any agent. Step 2 now covers the stored case.
  - Core's `source` doc gets a paragraph for `'unrecognized'`: produced only on read-back by a session store and the IPC auth hop; refused by `session:create` and `sandbox:open-session`; least privileged everywhere.
  - Finish with `grep -rn "as \`'external'\`\|reads as 'external'\|read it as \`'external'\`\|maps it to 'external'" packages`. Expected: no product-code hit.

- [ ] **Step 5: Run the four suites, then `pnpm build`.** Expected: all pass, and `tsc` is clean in every package. A compile error means an exhaustive site you haven't placed. Place it as least privileged, and log it in the shard.

- [ ] **Step 6: Mutations.** Each must turn a test red on the whole suite:
  - M1: `recallAudienceScope` returns `{}` for `'unrecognized'` (team rows, export mount rows).
  - M2: the `normalizeSource` fallback goes back to `'external'` (session-postgres, Docker).
  - M3: the `sessionSource` fallback goes back to `'external'` (ipc-core).
  - M4: `isOutsiderTurn('unrecognized')` is `false` (core table, `speakerScope` rows, personal scope rows).
  - M5: `conversationOf('unrecognized')` keeps the conversation.

- [ ] **Step 7: Commit:** `[TASK-1213] A stored source this build doesn't recognize reads as 'unrecognized' and fails closed`.

---

### Task 2: End to end: a stored unrecognized source recalls a team agent's shared rows only, over IPC [tier: integration]

Test-only, plus one workspace devDependency. It's covered by the PR's single security note: supply chain N/A, since it's a workspace package.

**Files:**
- Modify: `presets/memory/package.json` (`devDependencies`: `"@ax/ipc-http": "workspace:*"`), and `pnpm-lock.yaml` via `pnpm install`. Run it only after any background install in this worktree has finished. The lockfile diff should touch only the `presets/memory` importer.
- Test: `presets/memory/src/__tests__/canary.test.ts`. Add one `it` inside `describe('@ax/preset-memory canary', …)`.

**Interfaces:**
- Consumes: Task 1's `'unrecognized'` path; `createHttpListener({ host, port: 0, bus })` from `@ax/ipc-http` (`.port`, `.close()`); the canary's `bus`, `teamAgentId`, `ctxFor`, `ALICE`, and `database:get-instance` (`{ db }`, the Kysely instance; see the canary's `:1463` use).

- [ ] **Step 1: Write the test** `it("TASK-1213: a session whose stored source this build doesn't recognize recalls only a team agent's shared rows, end to end over IPC")`:
  1. Seed two notes on the team agent:
     - a private one: `tool:execute:memory_note` with `ctxFor(teamAgentId, ALICE)`, input `{ about: 'launch', relation: 'codename', value: 'Bluefin launch codename' }`;
     - a shared one: `ctxFor(teamAgentId, ALICE, { audience: 'shared' })`, input `{ about: 'launch', relation: 'date', value: 'launch on March 3' }`.
     - Expect `ok: true` for both.
  2. Mint two sessions with `session:create`: `{ sessionId: 's-1213-known' | 's-1213-unrecognized', workspaceRoot: '/tmp/ws', owner: { userId: ALICE, agentId: teamAgentId, agentConfig, source: 'external', audience: 'shared' } }`.
     - `agentConfig` is the minimal shape session-postgres's tests use (`displayName`, `systemPromptAugment`, `allowedTools: []`, `mcpConfigIds: []`, `model`, `runner: 'claude-sdk'`).
     - **Use ALICE, not BOB:** the "team agent shares memory across members and revokes on removal" test removes Bob from the team.
     - If `memory_recall` wants a conversation (for its receipt), add `conversationId: 'canary-1213-<known|unrecognized>'` to the owner. The listener stamps it on the ctx.
  3. Set the stored source: `db.updateTable('session_postgres_v2_session_agent').set({ source: 'satellite' }).where('session_id', '=', 's-1213-unrecognized').execute()`.
  4. Start `createHttpListener({ host: '127.0.0.1', port: 0, bus })`, in `try`/`finally { await listener.close() }`. For each token, `POST http://127.0.0.1:${listener.port}/tool.execute-host`:
     - headers `authorization: Bearer <token>` and `content-type: application/json`;
     - body `{ call: { id: 'c-1213', name: 'memory_recall', input: { query: 'launch' } } }`.
  5. Assert:
     - known session: status 200, and `JSON.stringify(body)` contains `Bluefin` and `March 3`. That's the control: an outsider on a team agent reads the private row (TASK-1209).
     - unrecognized session: status 200, contains `March 3`, and does **not** contain `Bluefin`.
     - If the query doesn't hit both rows, change the query, not the assertions.

- [ ] **Step 2: Show it fails without Task 1.**
  - Locally revert the `normalizeSource` and `sessionSource` fallbacks to `'external'`. Never commit this.
  - Run `pnpm --filter @ax/preset-memory test -t "TASK-1213"`. Expected: FAIL. The unrecognized session sees `Bluefin`.
  - Restore the fallbacks.

- [ ] **Step 3: Run it again.** Expected: PASS. If Docker isn't available locally, say so in the shard and the PR body. CI runs it.

- [ ] **Step 4: Commit:** `[TASK-1213] End-to-end canary: an unrecognized stored source recalls shared rows only`.

---

### Task 3: A name that reads as the agent's own name, or as "a teammate", is refused [tier: sensitive]

**Needs `security-checklist`:** untrusted account-holder text going into prompts.

**Files:**
- Modify: `packages/memory/src/access.ts`. `MemoryAccess.agentName?: string`. `resolveMemoryAccess` reads `agent.displayName` (widen the inline type at `:36-38`) and sets `agentName` on team agents only, when it's a string.
- Modify: `packages/memory/src/member-names.ts`:
  - `memberName(raw, agentName?)`;
  - the reserved set gains `nameWords(TEAMMATE_TEXT).join(' ')`;
  - `memberLabels`'s `access` becomes `Pick<MemoryAccess, 'visibility' | 'teamId' | 'agentName'>` and passes `access.agentName`;
  - doc comments.
- Modify: `packages/memory/src/__tests__/harness.ts`. `makeMemoryHarness`'s `agent` option and `registerMemoryAgents` take `displayName?: string`, and the `agents:resolve` stub returns it only when it's set. Existing tests are unchanged.
- Test: `packages/memory/src/__tests__/member-names.test.ts`

**Interfaces:**
- Produces: `MemoryAccess.agentName?: string` (team agents only). `memberName(raw: unknown, agentName?: string): string | undefined` refuses when `nameWords(name).join(' ')` equals `nameWords(agentName).join(' ')` and the agent's words aren't empty. It also refuses the words `a teammate`.

- [ ] **Step 1: Write the failing tests** (`member-names.test.ts`):
  - **Agent's name, refused:** `it.each([['Fern', 'Fern'], ['fern.', 'Fern'], ['ＦＥＲＮ', 'Fern'], ['  FERN  ', 'Fern'], ['Fern', '  fern ']])('%j is refused on an agent named %j: it reads as the agent')`, with `expect(memberName(raw, agent)).toBeUndefined()`.
  - **Agent's name, kept:** `it.each([['Fern Li', 'Fern'], ['Ferns', 'Fern']])('%j stays a name on an agent named %j')`.
  - **No letters in the agent's name:** `it('an agent name with no letter or digit refuses nothing by itself')`. `memberName('Bob', '🤖')` is `'Bob'`.
  - **"a teammate", refused:** `it.each(['a teammate', 'A Teammate', 'a-teammate', 'A  TEAMMATE.', 'ａ ｔｅａｍｍａｔｅ'])('%j is refused: it reads like "a teammate"')`.
  - **"Teammate Tina", kept:** add it to the existing "stay names" list (`:132`).
  - **Labels:** `memberLabels`, `it("a member who calls themself the agent's name reads \"a teammate\"")`. Access is `{ ...TEAM, agentName: 'Fern' }`, and auth answers BOB as `'fern'`, so `user:u-bob` reads `TEAMMATE_TEXT`.
  - **Access:** `it("resolveMemoryAccess carries a team agent's display name as agentName; a personal agent carries none")`, using the harness `displayName: 'Fern'`.
  - **Recall:** in `describe('memory:recall names a teammate …')`, `it('a teammate named like the agent reads "a teammate"')`.

- [ ] **Step 2: Run them and see them fail.** Run `pnpm --filter @ax/memory test -- member-names`. Expected: the new cases fail.

- [ ] **Step 3: Implement** as in Interfaces. Doc: a name is refused when it would read as the person talking, as the agent (its kind or its own name), or as the fallback.

- [ ] **Step 4: Run the whole memory suite.** Expected: PASS.

- [ ] **Step 5: Mutations:**
  - the agent-name check dropped (the `.each` and the labels test fail);
  - the comparison done on raw strings (`fern.` and fullwidth fail);
  - `'a teammate'` dropped from the reserved set;
  - `agentName` set on personal agents too (the access test fails).

- [ ] **Step 6: Commit:** `[TASK-1213] Memory names: refuse the agent's own name and "a teammate"`.

---

### Task 4: The caller's own name counts as a holder [tier: sensitive]

**Needs `security-checklist`:** a new read of the caller's own display name, used only for the collision check, never shown.

**Files:**
- Modify: `packages/memory/src/member-names.ts` (`memberLabels`; its doc, including the residual list `:160-173`)
- Modify (comments): `packages/memory/src/plugin.ts:1083-1087`, `packages/memory/src/augment.ts:749-752`
- Test: `packages/memory/src/__tests__/member-names.test.ts`, `packages/memory/src/__tests__/augment.test.ts`

**Interfaces:**
- Produces: `memberLabels`'s answer is unchanged in shape, and still never holds `self`.
- New rule. The caller's id goes through the same per-id path as everyone else (`teams:is-member`, then `auth:get-user` only on `member: true`, then `memberName`) when all of these hold:
  - `self` is a member key (`memberKeyId(self) !== undefined`);
  - the agent is a team agent;
  - the turn's recall reads everything;
  - at least one **other** member key is on the page.
- A usable name joins the collision count only. With no other member key, nobody is asked, the caller included.

- [ ] **Step 1: Write the failing tests.**
  - **The residual flips.** `member-names.test.ts:478` "DOCUMENTED RESIDUAL: the caller's own name is not a holder…" becomes `it("the caller's own name is a holder: a member renamed to it reads \"a teammate\" in the caller's turn")`.
    - Alice's turn; auth answers ALICE `'Alice Jones'` and BOB `'alice  jones.'`.
    - `labels.get('user:u-bob')` is `TEAMMATE_TEXT`, and `labels.has('user:u-alice')` is `false`.
  - `it('the caller is asked only when another member key is on the page')`: subjects `['user:u-alice', 'launch_plan']`, so no membership call and no auth call.
  - `it("a caller whose own lookup throws: the others keep their names; one warn")`. This pins the per-id rule from TASK-1209 row 35.
  - In `memory:recall`: `it("in a member's own turn, a teammate renamed to the caller's name reads \"a teammate\"")`.
  - In `augment.test.ts`: `it("in Alice's turn a Bob renamed \"Alice Jones\" reads \"a teammate\" in Recent, and Alice still reads you")`.
  - **Expected edits to existing exact-call assertions.** In a non-outsider turn with at least one other member key on the page, the caller now appears once. Compare them sorted.
    - `member-names.test.ts:214`: rename it to "asks once per member on the page, and the caller to count; names only other member keys". `memberAsked` and `asked` become `['u-alice', 'u-bob']`, and the labels are unchanged.
    - `:581-582`: `[ALICE, BOB]` sorted, for both.
    - `:738-739`: `memberCalls` `[ALICE, BOB]` sorted, `authCalls` `[ALICE]`.
    - `augment.test.ts:1653-1654`: `[ALICE, BOB, DAVE]` sorted.
    - `augment.test.ts:1677-1678` (Alice's own turn with only her key on the page) stays `[]`. Only its comment changes: nothing else on the page, so nobody is asked.
    - Outsider-turn assertions don't change, because `self` is undefined there.

- [ ] **Step 2: Run them and see them fail.** Run `pnpm --filter @ax/memory test -- member-names augment`. Expected: the new tests fail, and so do the re-pinned call lists.

- [ ] **Step 3: Implement** inside the existing per-id `Promise.all`. Mark the caller "count only". Add its name to `holders`, and never `labels.set` it.

- [ ] **Step 4: Run the whole memory suite.** Expected: PASS.

- [ ] **Step 5: Mutations:**
  - caller never asked (the flipped test fails);
  - caller's name put in the labels (the `has` assertion fails);
  - caller asked with no other member key (the "only when" test fails);
  - caller's membership check skipped (the call lists fail).

- [ ] **Step 6: Commit:** `[TASK-1213] Memory names: the caller's own name counts as a holder`.

---

### Task 5: A deadline on name lookups [tier: sensitive]

Timers and races. **Needs `security-checklist`:** a fail-closed degradation on a path that feeds the prompt.

**Files:**
- Modify: `packages/memory/src/member-names.ts`
- Test: `packages/memory/src/__tests__/member-names.test.ts`

**Interfaces:**
- Produces: `export const MEMBER_NAMES_DEADLINE_MS = 2_000;`
- Produces: `memberLabels(bus, ctx, access, subjects, self, opts?: { deadlineMs?: number }): Promise<ReadonlyMap<string, string>>`. Call sites pass no `opts`.
- Behavior when the deadline fires: the whole round of per-id lookups races one timer, unref'd and cleared when the round wins. If the timer wins:
  - return the map with **every** member key reading `TEAMMATE_TEXT`, even names that already came back;
  - log **one** `memory_member_names_failed` warn with `agentId`, `hook` and `...faultLogFields(new PluginError({ code: 'timeout', plugin: PLUGIN_NAME, hookName: hook, message: … }))`. `hook` is `teams:is-member` if any membership call is still in flight, else `auth:get-user`. The message names no id.
  - Answers that land later change nothing that was returned. Per-id tasks write only their own locals.
  - The timeout warn is that call's only warn. A throw seen earlier in the same round isn't logged as well (still one warn per call, as today).

- [ ] **Step 1: Write the failing tests**, each passing `{ deadlineMs: 20 }` unless noted:
  - `it('a membership check that never answers: every member reads "a teammate" by the deadline; one warn, code timeout, hook teams:is-member')`. The membership stub returns `new Promise(() => {})`. Use `toMatchObject` on the warn's bindings (`{ agentId, hook: 'teams:is-member', code: 'timeout' }`).
  - `it('a name lookup that never answers: nobody is named, not even a member whose name came back in time; hook auth:get-user')`. Auth answers BOB right away and never answers CAROL, so both read `TEAMMATE_TEXT`.
  - `it('an answer that lands after the deadline changes nothing already returned')`. Hold a deferred, resolve it after `memberLabels` returns, await a tick, and assert the returned map is unchanged.
  - `it('a round that finishes in time names members as before, with no warn')` uses `{ deadlineMs: 1_000 }`.
  - `it('the deadline is on by default')`.
    - `vi.useFakeTimers()`, a never-answering membership stub, and `memberLabels(…)` with **no** `opts`.
    - `await vi.advanceTimersByTimeAsync(MEMBER_NAMES_DEADLINE_MS)`.
    - The promise resolves to all-`TEAMMATE_TEXT`. Restore real timers in `finally`.

- [ ] **Step 2: Run them and see them fail.** Expected: the timeout tests hang until vitest's timeout. Pass a per-test timeout of 2 000 so the RED run fails fast.

- [ ] **Step 3: Implement** as in Interfaces, with a local timer race. `@ax/core`'s `withTimeout` isn't exported, so don't import it. Update the file header ("It never fails a read") and the `memberLabels` doc to describe the deadline.

- [ ] **Step 4: Run the whole memory suite.** Expected: PASS, with no added wall time beyond about 20 ms per test.

- [ ] **Step 5: Mutations:**
  - no deadline (the four timeout tests fail);
  - names that already came back kept on timeout (the "not even" test fails);
  - default `Infinity` (the default test fails);
  - timer not cleared (no test turns red; the risk is a leaked timer). If none turns red, say so in the shard. Don't invent a test.
  - wrong `hook` binding.

- [ ] **Step 6: Commit:** `[TASK-1213] Memory names: name lookups give up after 2 s`.

---

### Task 6: Members' names in the `/memory` export [tier: sensitive]

**Needs `security-checklist`:** untrusted display names go into a model-readable file. On a team agent, outsiders' sessions mount it (TASK-1209).

**Files:**
- Modify: `packages/memory/src/export-render.ts`:
  - `buildFactsExport` gains a third parameter;
  - `buildProfile` (team branch, `:136-145`), `statementLine` (`:85-97`), `buildRecent` (`:149-185`) and the user journals (`:239-252`) print labels.
- Modify: `packages/memory/src/exporter.ts` (`runPass`, `:138-145`)
- Modify (doc): `packages/memory/src/member-names.ts`. The header says names also label the export: one file per agent, labelled by the pass's own ctx, with no `self`.
- Test: `packages/memory/src/__tests__/export-render.test.ts`, `packages/memory/src/__tests__/export.test.ts`

**Interfaces:**
- Consumes: `memberLabels(bus, ctx, access, subjects, self)` from Tasks 3–5.
- Produces: `buildFactsExport(scanned: readonly ExportFact[], access: MemoryAccess, labels: ReadonlyMap<string, string> = new Map()): Map<FactsPath, string>`.
  - Wherever it printed a subject key, it prints `escapeStatementText(labels.get(about) ?? about, UNBOUNDED)`.
  - Sort orders and file paths stay keyed by the raw subject.
- Exporter: `const labels = await memberLabels(bus, ctx, access, rows.map((row) => row.about), undefined);`, between `scanAll` and `buildFactsExport`, inside the same pass.

- [ ] **Step 1: Write the failing tests.**
  - `export-render.test.ts`:
    - `it('prints a label for a subject key in team Profile headings, journal headings and Recent lines, escaped')`.
      - Labels: `new Map([['user:alice', 'Alice | Jones'], ['user:bob', 'a teammate']])`.
      - Expect `## a teammate` and the escaped `Alice | Jones` (whatever `escapeStatementText` gives for `|`).
      - No `user:alice` or `user:bob` in any file.
    - The existing tests without labels stay unchanged.
  - `export.test.ts`:
    - Rewrite `:139` as "a team agent's export names its members, the same whoever triggers the flush".
      - Use `authUser`, with ALICE as `'Alice Jones'` and BOB as `'Bob Smith'`.
      - The journal and `profile.md` contain `## Alice Jones` and `## Bob Smith`. `byBob === byAlice` still holds.
      - No file contains `user:user-alice` or `user:user-bob`.
    - `it("a key for an account outside the team reads \"a teammate\" in the export, and auth is never asked about it")`.
    - `it("a personal agent's export names nobody and asks nobody")`. `authUser` is set, `authCalls` and `memberCalls` stay `[]`, and the journal keeps `## user:user-alice`.
    - `it('two members whose names read the same both read "a teammate" in the export')`.
    - `it('an export pass from a turn whose recall is scoped names nobody; the next pass from a member names them again')`. Flush with `h.ctx({ source: 'unrecognized' as never })` to get `## a teammate` only, then flush with `h.ctx()` to get the names.

- [ ] **Step 2: Run them and see them fail.** Run `pnpm --filter @ax/memory test -- export`. Expected: the new tests fail, and the rewritten `:139` fails on the names.

- [ ] **Step 3: Implement** as in Interfaces.

- [ ] **Step 4: Run the whole memory suite.** Expected: PASS.

- [ ] **Step 5: Mutations:**
  - labels ignored in Profile, journal, and Recent, one at a time (each turns its test red);
  - a label not escaped;
  - `memberLabels` called with the pass ctx's `self` (the "same whoever triggers" test fails).

- [ ] **Step 6: Commit:** `[TASK-1213] The /memory export names teammates instead of user ids`.

---

### Task 7: Docs, design §4c and release notes [tier: mechanical]

**Files:**
- Modify: `.changeset/memory-outsiders-same-as-members.md`.
  - `:13`: drop "One honest gap: … reads everything", and say a stored unrecognized source fails closed too.
  - `:19-28`: keep only the items still open. Those are "Finding a teammate's facts by name doesn't work" and "The duplicate-name check is per answer, not team-wide", with the caller-name sentence removed.
- Create: `.changeset/memory-team-name-followups.md`. Frontmatter:

  ```yaml
  '@ax/core': minor
  '@ax/memory': patch
  '@ax/ipc-core': patch
  '@ax/session-postgres': patch
  ```

  Plain-language bullets in the project voice:
  - A session saved by a newer build, with a source this build doesn't recognize, is treated as `unrecognized`. On a team agent it gets shared memory only and no `/memory` view. Everywhere else it's treated like an outsider. Nothing ever creates one.
  - The `/memory` export names teammates (current members only). Anyone else reads "a teammate".
  - A member's name that reads as the agent's own name, or as "a teammate", is refused.
  - In your own turn, a teammate who takes your display name reads "a teammate".
  - Name lookups give up after 2 seconds, and that answer then names nobody.
  - Still not done: a team-wide duplicate check (it needs a member list memory doesn't have), and finding a teammate's facts by name.
- Modify: `docs/plans/2026-11-09-channel-slack-design.md`.
  - `:1158`: the TASK-1209 parenthetical. A stored session source this build doesn't recognize now reads as `unrecognized` and fails closed on a team agent too.
  - `:1166`: replace "It is not a guard on stored sessions: … is a follow-up." with: since TASK-1213 it is. session-postgres and ipc-core read a stored source they can't place as `unrecognized`, which this step places with the unknowns.
  - `:1167`: "a host-built context with a source outside the type" becomes "a source this build doesn't recognize, or one outside the type".
  - `:1171`: add the agent's own name and "a teammate" to the refused names, and the 2 s deadline.
  - `:1172`: the caller's own name now counts. Keep the per-answer residual.
  - `:1173`: the "Not done" list keeps only query-by-name and the team-wide check, the latter as "needs a team roster memory doesn't have; a human call (TASK-1213 decisions)". The residuals gain: the export's names are frozen until its next pass, and a pass from a turn whose recall is scoped names nobody.
  - Add an **"As built (TASK-1213)."** paragraph after `:1173`, before "The privacy sentence". Five bullets matching Tasks 1–6.

- [ ] **Step 1: Make the edits.** Follow the voice rules in CLAUDE.md: short sentences, "we", no jokes about the boundary itself.
- [ ] **Step 2: Check.** `grep -n "honest gap\|isn't flagged\|still shows raw ids\|no deadline of its own\|caller's own name isn't counted\|literally \"a teammate\"" .changeset/*.md docs/plans/2026-11-09-channel-slack-design.md`. Expected: no hit.
- [ ] **Step 3: Commit:** `[TASK-1213] Docs and release notes: team memory follow-ups`.

---

## PR body must say

- **Boundary review:** the four answers above (`AgentContextSource` gains `'unrecognized'`; session-postgres `session:resolve-token` admits it, read-only).
- **Security note:** one note from the `security-checklist` walk over Tasks 1 and 3–6.
  - *Sandbox:* no new capability. The `/memory` mount follows `recallAudienceScope`, unchanged.
  - *Injection:* display names now also reach the export file, cleaned by `memberName` and escaped. New refusals for the agent's name and the fallback.
  - *Supply chain:* only a workspace devDependency (`@ax/ipc-http` in `@ax/preset-memory`).
- **Scope:** card item 3's team-wide duplicate check is **not built**. It needs a new team-roster capability, and it would leave two real same-named teammates permanently nameless. That's for a human to weigh. Built instead: the caller's own name counts as a holder.
- **Follow-ups for auto-ship to file:**
  1. A team-wide duplicate display-name check. Needs a human decision: may memory read the team roster and every member's name per answer?
  2. Find a teammate's facts by name in a `query`. Carried over from TASK-1209.
- **Learnings:**
  - For TASK-1210: `MemoryAccess.agentName` exists for team agents, so reuse it rather than adding a second `agents:resolve`. `self-report.ts` is untouched.
  - For any card that adds a rule *granting* outsiders something (e.g. TASK-1212): `isOutsiderTurn` is also `true` for `'unrecognized'`, so switch on the source exhaustively, so an unrecognized source doesn't inherit the grant.
- **Accepted residuals:**
  - A per-id lookup failure, including the caller's own, leaves that name out of the collision count for that answer.
  - The export's names are frozen until its next pass.
  - A very large team's export can hit the 2 s deadline, and then names nobody.
  - Only the agent's AX display name is compared, not a different Slack bot name.
  - `'unrecognized'` only helps against sources added after this build. An older build still reads them as `'external'`.
