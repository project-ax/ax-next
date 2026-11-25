# TASK-1247 — Sharing phase 1B: "Who can use <agent>?", owners, the share confirmation, shared agents in lists — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent's owners can choose who can use it (Just me, Everyone, or people found by name), copy another agent's list, and add or remove owners. Widening shows one confirmation that names the agent's real connections. Shared agents appear in the people's agent list with a "Shared by" line, and people an agent is only shared with get chat, not Settings.

**Architecture:** A new signed-in, rate-limited read in `@ax/auth-better`, `GET /admin/people?q=`, returns `{id, displayName}` and nothing else. auth-better is the only plugin allowed to read `auth_better_v1_users`. channel-web's workspace roster (`GET /api/workspace/state`) now lists agents shared with the caller. Each row carries `access` (creator / co-owner / audience / team) and `sharedBy`, and audience rows hide the agent-wide activity line. Every other list stays "agents you manage". The settings UI is a new `sharing` section of the agent settings page. It is built on the TASK-1246 routes (`GET /admin/agents/:id`, `PUT …/audience`, `PUT …/owners`) and the existing connections read (`GET /api/workspace/agents/:agentId/connectors`).

**Tech Stack:** TypeScript, React 19 + shadcn primitives + `@project-ax/ui` (`Stack`/`Inline`/`Text`/`Heading`), vitest + @testing-library/react + jsdom, Kysely + Postgres (testcontainers) in auth-better.

**Spec:** `docs/plans/2026-11-25-agent-sharing-design.md` (§3 screens, §7 security, §9 what phase 1A found). Shapes from card A: `docs/plans/2026-11-25-task-1246-agent-sharing-phase1a-plan.md` ("Shapes cards B and C build on"). Decisions and alternatives: `.claude/memory/decisions/2026-11-25-TASK-1247.md`. Read all three before starting.

## Global Constraints

- **Merge after TASK-1248 (card C).** Memory refuses everyone but the creator until card C lands (`memory/src/access.ts:66`). This card makes shared agents visible in lists, so it must not reach main first. Say so at the top of the PR body. Do not touch memory, Slack or approvals: card C is building there in parallel.
- **No product or company name in any copy.** Not "AX", "Canopy" or "Canopy AI". The design's "Everyone at Canopy" is a draft. Deployments are white-labeled through Branding (`decisions/2026-11-21-TASK-1187.md`, `mistakes/2026-11-20-TASK-1170.md`), so the option reads "Everyone".
- **No email anywhere** in the new route, the sharing UI, `sharedBy`, or any log line. Show a person by display name only. Show a connection's signed-in account (provider text, e.g. a Gmail address) only to owners, in the confirmation, as the connectors tab already does.
- **Every person or connection name the UI shows is fenced** with `fenceLine` (`src/lib/fence-line.ts`, 80 code points) through `personLabel()` (Task 3). Display names are user-written and can carry bidi or zero-width characters. A spoofed name in a sharing picker is a real attack.
- **Write test strings with bidi or zero-width characters via `String.fromCharCode(...)`**, never as a typed backslash-u escape (for example the one for U+202E). Tool inputs decode typed escapes into the literal character (`mistakes/2026-11-13-TASK-1093.md`).
- **UI lint for `packages/channel-web/src/**/*.tsx`** (outside `components/ui/` and tests; `eslint.config.mjs:324-335`):
  - no raw `div`, `span`, `p`, `h2`–`h6`. Use `Stack`/`Inline`/`Text`/`Heading` from `@project-ax/ui`; precedent `settings/AwaitingReviewSection.tsx`;
  - no `className` on lowercase elements;
  - no arbitrary Tailwind values (`[…]`);
  - no `style` prop.

  CLAUDE.md:160 still lists only the last two; the eslint config is the truth. `eslint-suppressions.json` totals may not rise (CI ratchet). If you remove a frozen violation, run `pnpm lint:ui:prune`.
- **shadcn primitives** come from `@/components/ui/*`: `dialog` (no alert-dialog is installed), `command`, `popover`, `dropdown-menu`, `badge`, `alert`, `button`, `field`, `input`. Use `lucide-react` icons. Invoke the `shadcn` skill before building UI. Any missing primitive is added with `pnpm dlx shadcn@latest add <name> -c packages/channel-web` from the repo root. None is expected to be missing.
- **Copy lives in one module**, `src/lib/sharing-copy.ts` (Task 3). Components and tests read strings from it, and tests never repeat a sentence literally. The CLAUDE.md voice applies: warm, plain, short. Security consequences are direct, no jokes.
- **Server writes** keep `x-requested-with: ax-admin` (`lib/admin.ts:31-34`). New client calls go through `httpFetch` (`lib/http.ts:216`), so a 401 trips the session latch.
- **No new hook, no manifest change.** auth-better already `calls` `http:register-route`. channel-web already lists `auth:get-user` in `optionalCalls` (`server/plugin.ts:457-464`).
- **Tests:**
  - `pnpm --filter @ax/<pkg> test` (filter BEFORE the script).
  - auth-better tests need Docker with `DOCKER_HOST` set (CLAUDE.md "Docker-backed tests").
  - channel-web's `pnpm --filter @ax/channel-web build` type-checks its tests.
  - channel-web UI tests: no user-event. Use `fireEvent`, and `fireEvent.pointerDown` for Radix menus (`AgentSwitcher.test.tsx:34`). Mock `@/lib/*` modules with `vi.mock` (`AgentSettings.test.tsx:22-49`).
- **security-checklist** runs once over Tasks 1, 2, 6 and 8 together; paste its note into the PR body.

## Review Focus

1. **The people search as an email oracle, or a source of email.** A query that matches on email, or any field besides `id` and `displayName` in the answer. Pinned in Task 1 (`never matches on email`, `answers only id and displayName`).
2. **The confirmation understating what is shared.** Naming legacy-owned rows (they're the viewer's own and don't travel with the agent) while missing attached ones. Or enabling Share while the connections read is loading or has failed. Pinned in Task 6.
3. **A spoofed or overlong name** in the picker, owners list, members list or "Shared by" line (bidi override, zero-width, 10 000 characters). Pinned in Task 1 (server fence) and Task 3 (`personLabel`).
4. **A shared agent leaking into "your agents" or leaking the owner's activity.** `/route`, `/tasks`, `/tasks/agents` and `/api/chat/agents` must still leave it out. Roster, agent-view and rail must not show its activity line to the audience. Pinned in Task 2.
5. **An owners write that drops someone.** Add must send the creator, every current owner and the new person. Remove must send everyone but that one person. Cancel sends nothing, and no one gets a self-remove button. Pinned in Task 8 by exact request bodies.

## Shapes (copy into the PR body)

```ts
// NEW — @ax/auth-better. Signed-in users only. Never email, never matched on email.
// GET /admin/people?q=<2..64 chars, trimmed>
//   200 { people: Array<{ id: string; displayName: string }> }   // ≤ 10, by name; names fenced (80 code points)
//   400 { error: 'invalid-query' } · 401 { error: 'unauthenticated' }
//   429 { error: 'rate-limited', message } + retry-after: 60       // 60 searches / minute / person
//   every answer: cache-control: private, no-store

// CHANGED — channel-web wire (GET /api/workspace/state rows and GET /api/workspace/agents/:agentId .agent)
type AgentAccess = 'creator' | 'co-owner' | 'audience' | 'team';
interface WorkspaceAgent {
  /* …existing… */
  access?: AgentAccess;        // always sent by this server; optional so older fixtures still type-check
  sharedBy?: string | null;    // creator's display name (fenced), only when access is co-owner/audience AND agent.shared;
                               // null = couldn't look it up. Never an email.
}
// The roster now includes agents shared with the caller (access 'audience'), listed after the rest.
// Their activity line is never read: now/counter/startedAt null, state 'resting'.
// Unchanged lists ("agents you manage": owned, co-owned, team): POST /api/workspace/route,
// GET /api/workspace/tasks, GET /api/workspace/tasks/agents, GET /api/chat/agents, GET /admin/agents.
```

## File map

- `packages/auth-better/src/people-search.ts` (new): query rules, name fence, DB read, route handler.
- `packages/auth-better/src/per-user-rate-limit.ts` (new): a copy of channel-web's limiter.
- `packages/auth-better/src/plugin.ts`: registers `GET /admin/people`.
- `packages/channel-web/src/lib/workspace-types.ts`: `AgentAccess`; `WorkspaceAgent.access` and `.sharedBy`.
- `packages/channel-web/src/server/agent-ownership.ts`: `agentAccess()`; rewritten doc comments.
- `packages/channel-web/src/server/routes-workspace.ts`: the roster, agent detail, rail, `listAgents` comment.
- `packages/channel-web/src/server/plugin.ts`: `auth:get-user` degradation text.
- `packages/agents/src/index.ts`: type-only exports of the sharing shapes.
- `packages/channel-web/src/lib/sharing-copy.ts` (new): every string, and `personLabel`.
- `packages/channel-web/src/lib/agent-sharing.ts` (new): pure helpers. `lib/agent-sharing-api.ts` (new): network calls.
- `packages/channel-web/src/lib/admin.ts`: `AdminAgent` gains `shared`, `isOwner`, `sharing`.
- `packages/channel-web/src/lib/workspace-route.ts`: the `sharing` settings section.
- Components (new, in `packages/channel-web/src/components/workspace/`): `PeoplePicker.tsx`, `ShareConfirmDialog.tsx`, `AgentSharing.tsx`, `AudienceDialog.tsx`, `AgentOwners.tsx`, `AddOwnerDialog.tsx`.
- Modified components: `AgentSettings.tsx`, `AgentSwitcher.tsx`, `AgentView.tsx`.
- Docs: the design doc §10, the architecture doc, a changeset, a context shard, and the stale comments named in Tasks 2, 9 and 10.

---

### Task 1: People search — `GET /admin/people` in @ax/auth-better [tier: sensitive]

**Files:**
- Create: `packages/auth-better/src/per-user-rate-limit.ts`. Copy `packages/channel-web/src/server/per-user-rate-limit.ts` verbatim. Its header says "copied, not imported (invariant 2), as `apps-bridge/src/limits.ts` did".
- Create: `packages/auth-better/src/people-search.ts`
- Modify: `packages/auth-better/src/plugin.ts`. In block 6.5, after `/admin/me` (`:424-443`), register the route and push its `unregister`.
- Test (no Docker): create `packages/auth-better/src/__tests__/people-search.test.ts`.
- Test (Docker): create `packages/auth-better/src/__tests__/people-search-db.test.ts`. Boot it like `admin-routes.test.ts:46-127`.

**Interfaces:**
- Produces (`people-search.ts`):
  - Constants: `PEOPLE_QUERY_MIN_CHARS = 2`, `PEOPLE_QUERY_MAX_CHARS = 64`, `PEOPLE_RESULTS_MAX = 10`, `PEOPLE_SEARCHES_PER_MINUTE = 60`, `PERSON_NAME_MAX_CHARS = 80`.
  - `interface PersonMatch { id: string; displayName: string }`
  - `parsePeopleQuery(raw: unknown): string | null`. A string, trimmed, with 2..64 code points, comes back trimmed. Anything else is `null`.
  - `fencePersonName(raw: string | null): string | null`:
    - `replaceSurfaceRewriters` from `@ax/core/surface-text`;
    - collapse `\s+` to one space, then trim;
    - empty → `null`;
    - over 80 code points → the first 79 plus `…` (the same rule as channel-web `fenceLine`).
  - `findPeople(db: Kysely<AuthBetterDatabase>, query: string): Promise<PersonMatch[]>`
  - `interface PeopleSearchDeps { currentUserId(req: HttpRequest): Promise<string>; findPeople(query: string): Promise<PersonMatch[]>; ctx: AgentContext; now?: () => number }`
  - `createPeopleSearchHandler(deps: PeopleSearchDeps): (req: HttpRequest, res: HttpResponse) => Promise<void>`

`findPeople` matching. Never `LIKE`/`ILIKE`: their wildcards would need escaping, and auth-better already avoids them (`plugin.ts:681-682`). Never touch `email`.
```sql
SELECT id, name FROM auth_better_v1_users
 WHERE name IS NOT NULL
   AND (starts_with(lower(btrim(name)), lower($q)) OR strpos(lower(btrim(name)), ' ' || lower($q)) > 0)
 ORDER BY lower(btrim(name)), id
 LIMIT 10
```
Write it with Kysely `selectFrom(...).where(sql<boolean>\`( … )\`)`; keep the parentheses around the `OR`. Map each row through `fencePersonName`, drop rows that fence to `null`, and project to exactly `{ id, displayName }`. Every row counts as an AX account, by the same rule `isAxAccount` uses, so there is no `email_verified` filter. Filtering on it would hide people the sharing writes still accept.

Handler order. Every answer sets `cache-control: private, no-store`.
1. `currentUserId(req)`. A throw goes to `answerRequireUserFailure(ctx, res, err, 'auth_people_search_require_user_failed')` (401 or 500).
2. `limiter.take(userId)`. False → `retry-after: 60` and 429 `{ error: 'rate-limited', message }`. The message comes from Task 3's copy rules but lives here: "That's a lot of searching in a minute. Give it a moment and try again."
3. `parsePeopleQuery(req.query['q'])`. Null → 400 `{ error: 'invalid-query' }`.
4. `findPeople(q)`. A throw propagates (http-server answers 500 and logs codes only).
5. 200 `{ people }`, re-projected to `{ id, displayName }` here as well, so a store that returned more could never leak it.

Limiter: `createPerUserRateLimiter({ limit: 60, windowMs: 60_000, maxUsers: 10_000, now: deps.now })`.

Registered in `plugin.ts` as `{ method: 'GET', path: '/admin/people', handler }`, with these deps:
- `currentUserId: async (req) => (await requireUser(localDb, sessionCookieName, req)).user.id`
- `findPeople: (q) => findPeople(localDb, q)`
- `ctx: initCtx`

- [ ] **Step 1: Write the failing tests**

`people-search.test.ts` (stub deps, fake req/res; no Docker):
- `parsePeopleQuery takes 2 to 64 characters, trimmed`:
  - `'  al '` → `'al'`
  - `'a'`, `''`, `undefined`, `42` and a 65-character string → `null`
- `fencePersonName drops bidi and zero-width characters, collapses whitespace and caps at 80`:
  - `'Ali' + String.fromCharCode(0x202e) + 'ce'` → `'Ali ce'`
  - `'  Bob \n Stone '` → `'Bob Stone'`
  - a 200-character name → 80 code points ending in `…`
  - a name of only `String.fromCharCode(0x200b)` → `null`
- `answers 401 when nobody is signed in, and never searches` (`currentUserId` throws `PluginError{code:'unauthenticated'}`; the `findPeople` spy sees 0 calls).
- `answers 400 invalid-query for a missing, one-character or 65-character q`.
- `answers only id and displayName`. The stub `findPeople` returns `[{ id: 'u1', displayName: 'Ada', email: 'ada@x' } as never]`. The body is `{ people: [{ id: 'u1', displayName: 'Ada' }] }`, and `JSON.stringify(body)` contains no `@`.
- `allows 60 searches a minute per person, then 429 with retry-after 60; another person is unaffected; a minute later it's open again` (inject `now`).
- `sets cache-control private, no-store on 200, 400 and 429`.

`people-search-db.test.ts` (real Postgres):
- Seed with SQL, as `packages/agents/src/__tests__/admin-routes-harness.ts:217-242` does:
  - `Alice Archer` (alice@example.com)
  - `alicia keys`
  - `Bob Stone` with email `zed@example.com`
  - a `NULL` name and a `'   '` name
  - `50% Off` and `a_b Person`
  - `Zara 01` … `Zara 12`
- Tests:
  - `finds people by the start of any word in their name, ignoring case`:
    - `'ali'` → [Alice Archer, alicia keys] in that order
    - `'ARCH'` → [Alice Archer]
    - `'rcher'` → []
  - `never matches on email`: `'zed'` → [] and `'example'` → [].
  - `skips people with no name`.
  - `treats % and _ as plain characters`: `'50%'` → [50% Off]; `'5_'` → []; `'a_b'` → [a_b Person].
  - `returns at most 10, in name order`: `'zara'` → Zara 01 … Zara 10.
  - `answers only id and displayName`: `Object.keys(row).sort()` equals `['displayName','id']`.
  - `GET /admin/people is mounted: 200 for a signed-in person, 401 signed out`. This goes through the real plugin harness and `signInAsAdmin`.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @ax/auth-better test -- people-search`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** the module, the limiter copy and the registration above.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @ax/auth-better test && pnpm --filter @ax/auth-better build`
Expected: PASS. If the Docker teardown times out with every assertion passing, record that (CLAUDE.md "Build / Test").

- [ ] **Step 5: Commit**

```bash
git add packages/auth-better/src
git commit -m "[TASK-1247] auth-better: find people by name for the sharing picker (names only, rate-limited)"
```

---

### Task 2: The roster lists agents shared with you; every row says how you stand [tier: sensitive]

**Files:**
- Modify: `packages/channel-web/src/lib/workspace-types.ts:353-376`. Add `export type AgentAccess = 'creator' | 'co-owner' | 'audience' | 'team'`, and add `access?` and `sharedBy?` to `WorkspaceAgent`, each with a doc comment (Shapes above).
- Modify: `packages/channel-web/src/server/agent-ownership.ts`:
  - add `agentAccess`;
  - rewrite the `hideAgentsSharedWithMe` doc (`:37-50`). It is the PERMANENT rule for lists of agents the caller manages, not "until card B". Name its readers: `GET /api/chat/agents` (onboarding gate, Sites, Skills, Routines, self-improvement) and `listAgents` (`/route`, `/tasks`, `/tasks/agents`).
- Modify: `packages/channel-web/src/server/routes-workspace.ts`:
  - the local duck types `ResolvedAgent` (from `:403`, the resolve answer) and `AgentsListForUserOutput` (`:659-671`, the list row) gain `ownerId?: string` and `shared?: boolean`. They are optional, like their neighbours, and read defensively;
  - `listAgents` (`:5820-5834`): behavior unchanged; rewrite its comment, which is stale ("until the UI can tell the two apart (card B)");
  - new `listRoster`, `sharedByNames` and `activityFor`;
  - `toWorkspaceAgent` (`:4541`) takes the caller's standing;
  - `state` (`:7008`), `agentDetail` (`:8221`, its `readActivity` at `:8368`) and `rail` (`:8650`, its `readActivity` at `:8665`) use them.
- Modify: `packages/channel-web/src/server/plugin.ts:461-463`. The `auth:get-user` degradation also says: "the 'Shared by' line on a shared agent names nobody".
- Modify: `packages/channel-web/src/server/routes-chat.ts:225-229`. Update the comment only, to say what `/api/chat/agents` lists now ("agents you manage"). Its behavior doesn't change.
- Test: `src/__tests__/server/agent-ownership.test.ts`, `src/__tests__/server/routes-workspace.test.ts` (flip `:290-335`), `src/__tests__/server/routes-workspace-rail.test.ts`.

**Interfaces:**
- Produces (`agent-ownership.ts`): `agentAccess(agent: { visibility?: unknown; isOwner?: unknown; ownerId?: unknown }, userId: string): AgentAccess`. Rules in order:
  1. `visibility === 'team'` → `'team'`
  2. `isOwner === false` → `'audience'`
  3. otherwise (`isOwner` true, or absent from a producer older than sharing) → `ownerId === undefined || ownerId === userId ? 'creator' : 'co-owner'`
- Produces (`routes-workspace.ts`, inside the handlers' closure):
  - `listRoster(userId: string): Promise<AgentsListForUserOutput['agents']>`. It makes the same `agents:list-for-user` call as `listAgents`, with no filter. Rows whose `agentAccess` isn't `'audience'` come first, then the audience rows; each group keeps the hook's order.
  - `sharedByNames(ownerIds: readonly string[]): Promise<Map<string, string>>`:
    - one `auth:get-user` per distinct id; `fenceLine(displayName, 80)`;
    - a miss, a blank name, a throw, or no hook leaves the id out;
    - at most one warn, `workspace_shared_by_lookup_failed { code }`, codes only;
    - never reads `email`.
  - `activityFor(agent, userId): Promise<AgentRailData['activity']>`. An audience caller gets `{ status: 'ok', activity: null }`, and `agent-activity:get` is never called. Anyone else gets `readActivity(agent.id)`.
  - `toWorkspaceAgent(agent, state, activity?, who?: { access: AgentAccess; sharedBy?: string | null })`. It adds `access`, plus `sharedBy` when `who.sharedBy !== undefined`.
- `sharedBy` rule (the learning says check `shared`, not `visibility`): set it only when `access` is `'co-owner'` or `'audience'` AND `agent.shared === true`. The value is the name map's entry for `agent.ownerId`, or `null`.

- [ ] **Step 1: Write the failing tests**

`agent-ownership.test.ts`:
- `agentAccess: a team agent is 'team' whatever else it says`
- `agentAccess: isOwner false is 'audience'`
- `agentAccess: the owner who created it is 'creator'; any other owner is 'co-owner'`
- `agentAccess: a row with no isOwner reads as the caller's own (a producer from before sharing)`

`routes-workspace.test.ts`:
- Flip `:295`: `the roster lists an agent shared with the caller after their own and team agents`. Roster ids are `['a-mine', 't1', 'a-old', 'a-shared']`. The `/route` half of that test stays as it is.
- `roster rows say how the caller stands with each agent`:
  - own agent (`isOwner: true, ownerId: 'u1'`) → `access: 'creator'`, no `sharedBy` key
  - co-owned → `'co-owner'`
  - audience → `'audience'`
  - team → `'team'`
- `the roster names who shared an agent, asks once per person, and never sends an email`:
  - two audience agents from creator `vin` (`shared: true`);
  - `auth:get-user` answers `{ id: 'vin', displayName: 'Vinay Pulim', email: 'v@example.com', isAdmin: false }`;
  - it is called once;
  - both rows say `sharedBy: 'Vinay Pulim'`;
  - `JSON.stringify(body)` has no `@`.
- `a creator whose name can't be looked up reads as null`. Three cases, each giving `sharedBy: null`:
  - no `auth:get-user`;
  - it throws;
  - it answers `null`.
- `a co-owned agent that isn't shared has no Shared-by line` (`isOwner: true`, `ownerId: 'vin'`, `shared: false`) → no `sharedBy` key.
- `the roster never reads what an agent the caller only uses is doing`:
  - an `agent-activity:get` spy records agent ids, and the audience id is not among them;
  - that row has `now: null`, `counter: null`, `startedAt: null`, `state: 'resting'`;
  - the owned agent's row still carries its phrase.
- `tasks and tasks/agents still leave out an agent only shared with the caller`
- `the agent view tells someone an agent is shared with that they only use it, who shared it, and nothing about what it is doing`:
  - `agentDetail` with `agents:resolve` answering `{ visibility: 'personal', isOwner: false, ownerId: 'vin', shared: true }`;
  - `agent.access === 'audience'`, `agent.sharedBy === 'Vinay Pulim'`, `agent.now === null`;
  - no `agent-activity:get` call.

`routes-workspace-rail.test.ts`:
- `the rail shows no activity line to someone the agent is only shared with` → `activity: { status: 'ok', activity: null }`, and the hook is not called.

Existing tests that compare whole roster rows (around `:275-287`) gain `access: 'creator'` (or whatever their stub implies).

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @ax/channel-web test -- agent-ownership routes-workspace`
Expected: FAIL (`agentAccess` missing; the roster still drops the shared row; rows have no `access`).

- [ ] **Step 3: Implement** the rules above. `/route`, `/tasks` and `/tasks/agents` keep calling `listAgents`. Only `state` switches to `listRoster`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @ax/channel-web test && pnpm --filter @ax/channel-web build`
Expected: PASS. `manifest-declarations.test.ts` stays green, because no hook literal is new.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/lib/workspace-types.ts packages/channel-web/src/server packages/channel-web/src/__tests__/server
git commit -m "[TASK-1247] channel-web: the roster lists agents shared with you, says who shared them, and keeps their activity private"
```

---

### Task 3: The copy, and a ux-designer pass over it [tier: mechanical]

**Files:**
- Create: `packages/channel-web/src/lib/sharing-copy.ts`
- Test: `packages/channel-web/src/lib/__tests__/sharing-copy.test.ts`

**Interfaces:**
- Produces:
  - `personLabel(name: string | null | undefined): string`, which is `fenceLine(name, 80) ?? SHARING_COPY.someone`;
  - `SHARING_COPY`, a single object. Every later task reads its strings from here. Keys (draft wording in the deck; the ux-designer pass sets the final words):
    - `nav: { label, summary(agent) }`
    - `heading(agent)`, `change`, `someone`
    - `audience: { justMe(ownerCount), everyone, people(names: string[], total: number) }`. A summary line; list at most 2 names, then "and N more".
    - `picker`:
      - `{ title(agent), fieldLabel, placeholder, justMeOption, everyoneOption, everyoneHint }`;
      - `{ emptyDraft(agent), remove(name), sameAs, sameAsItem(agent), copyFailed(agent) }`;
      - `{ narrowed(agent), peopleCap, keepTyping, searching, noMatches, searchFailed, searchRateLimited }`;
      - `{ save, cancel }`.
    - `confirm`:
      - `{ title(agent, who: 'everyone' | string[]), lead, connections(agent, names: string[]), signedInAs(account) }`;
      - `{ memory(agent), filesAndInstructions(agent) }`;
      - `{ removeConnectionsFirst, share, cancel, loading, connectionsFailed(agent), tryAgain }`.
    - `owners`:
      - `{ heading, creator, you, add, remove(name), cap }`;
      - `{ addTitle(agent), confirmTitle(person, agent), consequences(agent, routinesRunAs: 'you' | string) }`;
      - `{ confirm, cancel }`.
    - `team(agent)`, `sharedBy(name: string | null)`
    - `errors: { forbidden(agent), unknownPerson, accountsUnavailable, notFound(agent), generic, loadFailed(agent) }`

Draft rules the deck must keep, and the ux-designer may only tighten:
- `everyoneOption` is "Everyone", with a hint like "Anyone who can sign in here". No product name.
- `narrowed(agent)` says, in substance: "People who used {agent} may still remember what it told them."
- The `confirm` bullets, all always true:
  - with connections: they can ask {agent} to do things with each named connection, and see which account each is signed in to;
  - they can see what {agent} remembers, including what you told it before today;
  - they can use and change its files and artifacts (rename, delete, make a public link), and read its Instructions (design §9).
- `consequences(agent, routinesRunAs)` says plainly:
  - owners can change everything {agent} does with your connections: its Instructions, tools, connections, and who can use it;
  - {agent}'s routines run as {you | the creator's name}, so an owner's changes also change what those routines do;
  - only the creator can delete {agent} or edit its routines. That last line is TASK-1246's rule: routines and delete stay with the creator.

- [ ] **Step 1: Write the failing test** `sharing-copy.test.ts`:
  - `no string names the product`. Call every function with sample arguments, and walk every string. None matches `/\bAX\b/` or `/Canopy/i` (the white-label rule, as `channel-slack`'s `copy.test.ts` does).
  - `personLabel fences and falls back`:
    - `personLabel(null) === SHARING_COPY.someone`;
    - `personLabel('Ali' + String.fromCharCode(0x202e) + 'ce') === 'Ali ce'`;
    - a 200-character name comes back 80 code points long.
  - `the owner confirmation names routines and who they run as`. `consequences('Fern', 'you')` contains "routine". `consequences('Fern', 'Vinay')` contains "Vinay".
- [ ] **Step 2: Run it to verify it fails** — `pnpm --filter @ax/channel-web test -- sharing-copy` → FAIL (module missing).
- [ ] **Step 3: Write the deck** with the draft wording.
- [ ] **Step 4: ux-designer pass.** Dispatch the `ux-designer` agent (no `name`). Its prompt starts "`cd /Users/…/agent-aa1565639c0b35253` and run every command there". Give it:
  - the deck's path;
  - the design §3 and §7 and this task's draft rules;
  - the screens in plain words: the section row with Change; the picker dialog (one field with Just me / Everyone / people, the people rows with Remove, Same people as…, the narrowed line); the widen confirmation with and without connections, and its failure state; the owners list with Add owner, the confirmation and Remove; the team-agent line; the "Shared by" line; and the errors.

  Ask for final wording, plus any BLOCKING usability problem. Structural ideas beyond that go to the PR's follow-ups, not into this card. Apply the wording to the deck. Append one row to `.claude/memory/decisions/2026-11-25-TASK-1247.md` saying what the pass changed.
- [ ] **Step 5: Run the test to verify it passes** — `pnpm --filter @ax/channel-web test -- sharing-copy` → PASS.
- [ ] **Step 6: Commit** — `git add packages/channel-web/src/lib/sharing-copy.ts packages/channel-web/src/lib/__tests__/sharing-copy.test.ts .claude/memory/decisions/2026-11-25-TASK-1247.md && git commit -m "[TASK-1247] channel-web: sharing copy, reviewed by the ux-designer pass"`

---

### Task 4: The client's sharing types, helpers and calls [tier: integration]

**Files:**
- Modify: `packages/agents/src/index.ts:64-95`. Add `AudienceKind`, `AudienceMember`, `AgentAudience`, `PersonView` and `SharingView` to the `export type { … }` list. They're types only, so the client imports them type-only, as `lib/admin.ts:28` does with `@ax/teams`. This avoids a mirror that could drift.
- Modify: `packages/channel-web/src/lib/admin.ts:38-64`. `AdminAgent` gains `shared: boolean; isOwner?: boolean; sharing?: SharingView`.
- Create: `packages/channel-web/src/lib/agent-sharing.ts` (pure, no I/O)
- Create: `packages/channel-web/src/lib/agent-sharing-api.ts` (network)
- Test: `packages/channel-web/src/lib/__tests__/agent-sharing.test.ts`, `packages/channel-web/src/lib/__tests__/agent-sharing-api.test.ts`

**Interfaces:**
- Produces (`agent-sharing.ts`):
  - `AUDIENCE_MEMBERS_MAX = 50` and `OWNERS_MAX = 10`. Mirrors of `packages/agents/src/sharing/service.ts:41-43`; cite those lines. They're runtime values, so they can't be imported.
  - `type DraftAudience = { kind: 'just-me' } | { kind: 'everyone' } | { kind: 'list'; members: PersonView[] }`
  - `draftFrom(view: SharingView['audience']): DraftAudience`
  - `toAudienceBody(d: DraftAudience): AgentAudience`. A `list` with no members becomes `{ kind: 'just-me' }`.
  - `sameAudience(a: DraftAudience, b: DraftAudience): boolean`. List membership is compared as a set of ids.
  - `isWidening(from: DraftAudience, to: DraftAudience): boolean`:
    - `to` just-me → false
    - `from` everyone → false
    - `to` everyone → true
    - `to` list: `from` just-me → true; `from` list → some id of `to` is not in `from`
  - `isNarrowing(from, to): boolean`:
    - `from` just-me → false
    - `to` just-me → true
    - `from` everyone and `to` list → true
    - `from` list and `to` list → some id of `from` is not in `to`
    - otherwise false
  - `addedPeople(from: DraftAudience, to: DraftAudience): PersonView[]`. For a `to` list: its members not in a `from` list (all of them when `from` is just-me). Empty otherwise.
  - `sharedAgentChoices(agents: AdminAgent[], currentId: string): AdminAgent[]`. Keeps `visibility === 'personal' && isOwner === true && shared === true && id !== currentId`.
  - `canManageAgent(a: { access?: AgentAccess }): boolean` → `a.access !== 'audience'`.
  - `canDeleteAgent(a: { access?: AgentAccess }): boolean` → `a.access === undefined || a.access === 'creator' || a.access === 'team'`.
- Produces (`agent-sharing-api.ts`):
  - `class SharingRequestError extends Error { readonly status: number; readonly code: string | null }`. `code` is the body's `error` when it is a string.
  - `type PersonMatch = { id: string; displayName: string }`
  - `setAudience(agentId: string, audience: AgentAudience): Promise<SharingView>` → `PUT /admin/agents/${encodeURIComponent(agentId)}/audience`.
  - `setOwners(agentId: string, userIds: string[]): Promise<SharingView>` → `PUT /admin/agents/${…}/owners` with body `{ userIds }`.
  - `searchPeople(query: string, signal?: AbortSignal): Promise<PersonMatch[]>` → `GET /admin/people?q=${encodeURIComponent(query)}`.

  All three use `httpFetch`. The writes send `{ 'content-type': 'application/json', 'x-requested-with': 'ax-admin' }`. A non-ok answer throws `SharingRequestError`.

- [ ] **Step 1: Write the failing tests**

`agent-sharing.test.ts`:
- `isWidening`: the full table above, one `it.each` row per pair. Kinds: just-me, everyone, list [a], list [a,b], list [b,c].
- `isNarrowing`: the same, with the table above.
- `a change can widen and narrow at once` (`[a,b] → [b,c]`).
- `toAudienceBody turns an empty list into just-me and strips names`.
- `sameAudience ignores list order`.
- `addedPeople names only the new people`.
- `sharedAgentChoices keeps your other shared personal agents only`.
- `canManageAgent / canDeleteAgent by access, and lenient when access is absent`.

`agent-sharing-api.test.ts` (stub `globalThis.fetch`):
- `setAudience PUTs the body with the CSRF header and returns sharing`.
- `setOwners PUTs { userIds }`.
- `searchPeople GETs with the query encoded`. `a&b` arrives as `q=a%26b`.
- `a refusal throws SharingRequestError with the status and the server's code` (403 `forbidden`, 400 `unknown-person`, 429 `rate-limited`).
- `a body that isn't JSON still throws, with code null`.

- [ ] **Step 2: Run them to verify they fail** — `pnpm --filter @ax/channel-web test -- agent-sharing` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass**

Run: `pnpm --filter @ax/agents build && pnpm --filter @ax/channel-web test -- agent-sharing && pnpm --filter @ax/channel-web build`
Expected: PASS.

- [ ] **Step 5: Commit** — `git add packages/agents/src/index.ts packages/channel-web/src/lib && git commit -m "[TASK-1247] channel-web: sharing helpers and calls (audience, owners, people search)"`

---

### Task 5: PeoplePicker — find a person by name [tier: integration]

**Files:**
- Create: `packages/channel-web/src/components/workspace/PeoplePicker.tsx`
- Test: `packages/channel-web/src/components/workspace/__tests__/PeoplePicker.test.tsx`

**Interfaces:**
- Consumes: `searchPeople` and `SharingRequestError` (Task 4); `SHARING_COPY.picker` and `personLabel` (Task 3).
- Produces:
```ts
export const PEOPLE_SEARCH_DEBOUNCE_MS = 300; // ConnectorDirectory's value (settings/ConnectorDirectory.tsx:58)
export interface PeoplePickerProps {
  label: string;                           // the field's accessible name
  placeholder: string;
  excludeIds: ReadonlySet<string>;         // already chosen or already owners: never offered
  fixedOptions?: Array<{ id: string; label: string; hint?: string }>; // Just me / Everyone, listed first
  onPickFixed?: (id: string) => void;
  onPickPerson: (person: PersonMatch) => void;
  disabled?: boolean;
}
export function PeoplePicker(props: PeoplePickerProps): JSX.Element;
```
Build it from `Popover` + `Command shouldFilter={false}` with a controlled `CommandInput`; the pattern is `settings/SkillForm.tsx:646-737`. Fixed options are always listed first.
- People are searched only when the trimmed text has at least 2 characters, after the debounce.
- One `AbortController` per search, plus a sequence number, so only the latest answer renders (`ConnectorDirectory.tsx:175-217`).
- Results never include `excludeIds`.
- States:
  - one character → `keepTyping`;
  - in flight → `searching`;
  - none → `noMatches`;
  - 429 (`code === 'rate-limited'`) → `searchRateLimited`;
  - any other failure → `searchFailed`.
- Picking anything clears the text.
- Names render through `personLabel`.

- [ ] **Step 1: Write the failing tests** (mock `@/lib/agent-sharing-api`; fake timers for the debounce):
  - `no search for one character, and it says to keep typing`
  - `typing quickly makes one search, after the pause, with the trimmed text` (`'  ali'` → one call with `'ali'`)
  - `offers matches except the excluded ones, and picking one reports it and clears the field`
  - `only the latest search is shown`. The first call resolves after the second, and its results never render.
  - `a rate-limited search says so`, and `any other failure says search isn't working`
  - `a fixed option is listed first and reports its id`
- [ ] **Step 2: Run to verify they fail** — `pnpm --filter @ax/channel-web test -- PeoplePicker` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass** — `pnpm --filter @ax/channel-web test -- PeoplePicker && pnpm --filter @ax/channel-web build` → PASS. Then `pnpm lint` (UI rules).
- [ ] **Step 5: Commit** — `git commit -m "[TASK-1247] channel-web: a people picker that searches by name"` with the two files.

---

### Task 6: ShareConfirmDialog — widening names the agent's real connections [tier: sensitive]

**Files:**
- Create: `packages/channel-web/src/components/workspace/ShareConfirmDialog.tsx`
- Test: `packages/channel-web/src/components/workspace/__tests__/ShareConfirmDialog.test.tsx`

**Interfaces:**
- Consumes: `workspaceApi.connectors(agentId)` → `AgentConnectorsRead` (`lib/workspace-api.ts:1842-1843`; types at `lib/workspace-types.ts:1154-1234`); `SHARING_COPY.confirm` and `personLabel` (Task 3).
- Produces:
```ts
export interface ShareConfirmDialogProps {
  open: boolean;
  agentId: string;
  agentName: string;
  who: { kind: 'everyone' } | { kind: 'people'; added: PersonView[] };
  saving: boolean;
  error: string | null;            // a failed Share, shown inside the dialog
  onShare: () => void;
  onRemoveConnectionsFirst: () => void;
  onCancel: () => void;
}
```

Rules:
- The connections are the rows with `source === 'attached'`. `legacy-owned` rows are the viewer's own connectors (`routes-workspace.ts:8895-8899`). They don't reach anyone the agent is shared with, so naming them would mislead.
- `connectorsSupported === false` means no connections.
- Every attached row is named, signed in or not: listing one more is safe, missing one isn't.
- Each named connection shows `personLabel(row.name)`, and `signedIn.account` when present, inside `<bdi>` as `AgentConnectors.tsx:582-593` does.
- **Fail closed.** While the read is loading, or after it failed, Share is disabled. A failure shows an `Alert` (`connectionsFailed`) with Try again, which reads again.
- With connections, the dialog has the connections bullet and the Remove connections first button. Without, it has neither. The memory bullet and the files-and-Instructions bullet always show.
- Buttons, in `DialogFooter`: Cancel, Remove connections first (only with connections), Share (primary).
- Closing is blocked while `saving` (`AgentSwitcher.tsx:240-297`).
- The title uses `who` (`SHARING_COPY.confirm.title`); `people` uses `added` names.

- [ ] **Step 1: Write the failing tests** (mock `@/lib/workspace-api`):
  - `names each attached connection and the account it's signed in to`. Rows:
    - Gmail, attached, signed in as `vinay@example.com`;
    - Google Calendar, attached, not signed in;
    - Notion, `legacy-owned`.

    Gmail, Google Calendar and the account appear; Notion does not.
  - `Remove connections first reports it and never shares` (`onShare` not called).
  - `with no connections there is no connections line and no Remove connections first, and Share shares` (an empty list, and separately `connectorsSupported: false`).
  - `Share stays off while the connections are loading`.
  - `if the connections can't be read, Share stays off and Try again reads them again`.
  - `always says what it remembers, its files and artifacts, and its Instructions`.
  - `the title names the people being added, or everyone`.
- [ ] **Step 2: Run to verify they fail** — `pnpm --filter @ax/channel-web test -- ShareConfirmDialog` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass** — `pnpm --filter @ax/channel-web test -- ShareConfirmDialog && pnpm --filter @ax/channel-web build` → PASS; `pnpm lint`.
- [ ] **Step 5: Commit** — `git commit -m "[TASK-1247] channel-web: the share confirmation names the agent's connections"` with the two files.

---

### Task 7: "Who can use <agent>?" — the settings section, the picker dialog, Same people as [tier: integration]

**Files:**
- Modify: `packages/channel-web/src/lib/workspace-route.ts:36-45`. Add `'sharing'` to `AGENT_SETTINGS_SECTIONS` right after `'instructions'`; the ux-designer pass may move it.
- Modify: `packages/channel-web/src/components/workspace/AgentSettings.tsx`:
  - `SETTINGS_SECTIONS.sharing`: label and summary from `SHARING_COPY.nav`, `Icon: Users` (lucide), `description: () => null`;
  - `SectionBody` gets `case 'sharing': return <AgentSharing key={agent.id} agent={agent} onSection={onSection} />;`.
- Create: `packages/channel-web/src/components/workspace/AgentSharing.tsx`, `packages/channel-web/src/components/workspace/AudienceDialog.tsx`
- Test: `packages/channel-web/src/components/workspace/__tests__/AgentSharing.test.tsx`; update the section pin in `__tests__/AgentSettings.test.tsx:102-132`.

**Interfaces:**
- Consumes:
  - `getAdminAgent`, `listAdminAgents` (`lib/admin.ts`);
  - `setAudience`, `SharingRequestError` (Task 4);
  - `draftFrom`, `toAudienceBody`, `sameAudience`, `isWidening`, `isNarrowing`, `addedPeople`, `sharedAgentChoices`, `AUDIENCE_MEMBERS_MAX` (Task 4);
  - `PeoplePicker` (Task 5), `ShareConfirmDialog` (Task 6), `SHARING_COPY` (Task 3).
- Produces:
```ts
export interface AgentSharingProps {
  agent: AgentDetail['agent'];
  onSection: (section: AgentSettingsSection) => void;
}
export interface AudienceDialogProps {
  open: boolean;
  agentId: string;
  agentName: string;
  saved: SharingView['audience'];
  ownerIds: ReadonlySet<string>;     // owners can always use it: never offered, never listed
  onSaved: (sharing: SharingView) => void;
  onOpenConnections: () => void;
  onClose: () => void;
}
```

`AgentSharing` behavior:
- Reads `getAdminAgent(agent.id)`:
  - `visibility === 'team'` → one line, `SHARING_COPY.team`, and nothing else;
  - no `sharing` → `errors.forbidden`;
  - a failed read → `errors.loadFailed` with Try again.
- Otherwise, a row with `SHARING_COPY.heading`, the audience summary, and Change, which opens `AudienceDialog`. Below it, a slot Task 8 fills with `AgentOwners`.
- Holds `sharing` in state and replaces it with every `onSaved`.

`AudienceDialog` behavior:
- The draft starts as `draftFrom(saved)`.
- `PeoplePicker`:
  - `fixedOptions` are Just me and Everyone;
  - `excludeIds` is `ownerIds` ∪ the draft's member ids;
  - picking Just me or Everyone replaces the draft;
  - picking a person makes the draft a list that includes them.

  At `AUDIENCE_MEMBERS_MAX` the picker is `disabled` and `peopleCap` shows.
- Draft rows: a list shows one row per person with Remove; removing the last person leaves just-me. Everyone shows one row with Remove. Just-me shows `emptyDraft`.
- **Same people as…** is a `DropdownMenu` of `sharedAgentChoices(await listAdminAgents(), agentId)`, hidden when there are none. Choosing one:
  1. reads `getAdminAgent(sourceId).sharing.audience`;
  2. builds the draft from it, dropping members in `ownerIds`; an empty list becomes just-me;
  3. on failure, shows `copyFailed`.

  It copies; it doesn't link (design §8 Q4).
- `narrowed(agentName)` shows whenever `isNarrowing(draftFrom(saved), draft)`.
- Save is disabled when `sameAudience`.
- Save, by case:
  - `isWidening` → open `ShareConfirmDialog`, with `who` set to everyone, or `added = addedPeople(...)`;
  - otherwise, `setAudience(agentId, toAudienceBody(draft))` → `onSaved`, close.
- `ShareConfirmDialog` is a second Radix `Dialog`, opened while `AudienceDialog` stays open (Radix stacks them). Its Cancel returns to the picker with the draft intact.
- Share → `setAudience`, then `onSaved`, then close both. Remove connections first → close both without saving, then `onOpenConnections()`; `AgentSharing` passes `() => onSection('connectors')`.
- The Same people as… menu is a `DropdownMenu modal={false}`, as at `AgentSwitcher.tsx:202-205`, because a modal menu inside a dialog can leave the page unclickable.
- A refusal maps to copy:
  - 403 → `errors.forbidden`;
  - `unknown-person` → `errors.unknownPerson`;
  - 503 → `errors.accountsUnavailable`;
  - 404 → `errors.notFound`;
  - anything else → `errors.generic`.

  The message shows inline (`Alert`), and the dialog stays open.

- [ ] **Step 1: Write the failing tests**

`AgentSharing.test.tsx` mocks `@/lib/admin`, `@/lib/agent-sharing-api` and `@/lib/workspace-api`, and starts with the creator, Fern, just-me. These are acceptance tests:
- `widen to Everyone with connections: the confirmation names Gmail and Google Calendar, and Share saves { kind: 'everyone' }`
- `widen without connections: no connections line or Remove connections first, and Share saves`
- `Remove connections first saves nothing and opens Connectors`. `setAudience` is not called, and `onSection` is called with `'connectors'`.
- `narrow from Everyone to Just me: no confirmation, the narrowed line shows, and it saves { kind: 'just-me' }`
- `narrow a list by removing a person saves the smaller list without asking`
- `adding a person to a list asks first and names only the new person`
- `Same people as copies another agent's list, then Save confirms and saves those members`. Source Juniper (list [carol, dave]): the draft shows Carol and Dave, and saves `{ kind: 'list', members: [{type:'user',id:'carol'},{type:'user',id:'dave'}] }` after Share.
- `Same people as leaves out this agent's owners` (the source lists bob, an owner here).
- `Same people as is hidden when you have no other shared agent`
- `a team agent shows the team line and no Change`
- `a refused save keeps the dialog open with the owners-only message` (403 `forbidden`)

`AgentSettings.test.tsx:102-132`: the nav pin gains the Sharing label at its position.

- [ ] **Step 2: Run to verify they fail** — `pnpm --filter @ax/channel-web test -- AgentSharing AgentSettings` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass** — `pnpm --filter @ax/channel-web test && pnpm --filter @ax/channel-web build && pnpm lint` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "[TASK-1247] channel-web: Who can use <agent>? — Just me, Everyone or people, and Same people as"` (`lib/workspace-route.ts`, the components, the tests).

---

### Task 8: Owners — list, Add owner (with a plain confirmation), Remove [tier: sensitive]

**Files:**
- Create: `packages/channel-web/src/components/workspace/AgentOwners.tsx`, `packages/channel-web/src/components/workspace/AddOwnerDialog.tsx`
- Modify: `packages/channel-web/src/components/workspace/AgentSharing.tsx`. Render `AgentOwners` below the audience row.
- Test: `packages/channel-web/src/components/workspace/__tests__/AgentOwners.test.tsx`

**Interfaces:**
- Consumes: `setOwners`, `SharingRequestError`, `OWNERS_MAX` (Task 4); `PeoplePicker` (Task 5); `useUser()` (`lib/user-context.tsx:28`) for the signed-in person's id; `SHARING_COPY.owners` (Task 3).
- Produces:
```ts
export interface AgentOwnersProps {
  agentId: string;
  agentName: string;
  owners: SharingView['owners'];        // creator first (agents/src/sharing/service.ts:224-234)
  onSaved: (sharing: SharingView) => void;
}
export interface AddOwnerDialogProps {
  open: boolean;
  agentId: string;
  agentName: string;
  owners: SharingView['owners'];
  onSaved: (sharing: SharingView) => void;
  onClose: () => void;
}
```

Rules:
- The list shows each owner's `personLabel(displayName)`. The creator carries a `Badge` (`owners.creator`), and the signed-in person carries `owners.you`.
- **Remove** is shown only on rows where `!creator && id !== me`. You can't remove yourself here: that edge is cut, see the decisions shard. It asks nothing (removing an owner narrows who can change it) and sends `setOwners(agentId, owners.filter(o => o.id !== removed).map(o => o.id))`.
- **Add owner** is hidden at `OWNERS_MAX`, where `owners.cap` shows instead.
  - Step 1 is a `PeoplePicker` with `excludeIds` set to the owner ids.
  - Picking someone moves to step 2: `confirmTitle(person, agent)` plus `consequences(agent, routinesRunAs)`. `routinesRunAs` is `'you'` when the creator row's id is me, else `personLabel(creator.displayName)`.
  - Buttons: Cancel, and the primary `owners.confirm`.
  - Confirm sends `setOwners(agentId, [...owners.map(o => o.id), person.id])` in that order. Then `onSaved`, then close.
- Errors use the Task 7 mapping, inline. The list stays as it was until a save succeeds.

- [ ] **Step 1: Write the failing tests** (acceptance). Owners: Vinay (creator), Bob; you are Vinay unless a test says otherwise.
  - `lists the owners with the creator first, marked, and marks you`
  - `Add owner asks first, says what owners can change including what routines do, and saves the creator, the current owners and the new one`. The confirmation shows `SHARING_COPY.owners.consequences('Fern', 'you')`. `setOwners` is called once with `('agt_fern', ['vinay', 'bob', 'carol'])`.
  - `cancelling the confirmation saves nothing`
  - `a co-owner adding an owner is told the routines run as the creator`. You are Bob, and the text is `consequences('Fern', 'Vinay')`.
  - `Remove takes a co-owner off without asking, and neither the creator nor you have Remove`. You are Vinay: Bob's row has Remove, which sends `['vinay']`. You are Bob: no row has Remove.
  - `Add owner is unavailable at ten owners`
  - `a refused save shows the message and leaves the owners as they were` (400 `unknown-person`)
- [ ] **Step 2: Run to verify they fail** — `pnpm --filter @ax/channel-web test -- AgentOwners` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass** — `pnpm --filter @ax/channel-web test && pnpm --filter @ax/channel-web build && pnpm lint` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "[TASK-1247] channel-web: owners — add with a plain confirmation, remove"` with the files.

---

### Task 9: People an agent is shared with just chat; agent lists say who shared it [tier: integration]

**Files:**
- Modify: `packages/channel-web/src/components/workspace/AgentSwitcher.tsx`:
  - menu rows `:167-184` gain a caption, `SHARING_COPY.sharedBy(...)`, when `a.sharedBy !== undefined`, through `personLabel` when the name isn't null;
  - the ⋮ menu `:200-237` shows "Agent settings" only if `canManageAgent(selected)`, and "Delete agent…" only if `canDeleteAgent(selected)`;
  - with neither, no ⋮ at all.

  Use `Text role="caption"` (and `Stack`), never a new raw `span`/`div`. The file has frozen counts (`eslint-suppressions.json:1135-1145`) that may not rise.
- Modify: `packages/channel-web/src/components/workspace/AgentView.tsx`:
  - `const canManage = canManageAgent(agent)`; `settingsPage` (`:2024`) renders only when `canManage`;
  - an effect calls `onTab('chat')` when `!canManage && settingsSection !== null`, so a typed or old settings URL lands in the chat;
  - `openSettings` (`:1977`) does nothing when `!canManage`;
  - three links render only when `canManage`: Memory's "See all" (`:1804-1807`), the skipped-connectors notice's link (`:2082`), and a turn error's "Open Connectors" (`:2181-2189`).
- Modify (stale line, rule 5): `packages/channel-web/src/lib/agent-connectors.ts:45-50`. The `canSetAccount` doc says "a personal agent's list is only readable by its owner". Since TASK-1246, anyone it is shared with can read it. Say so. Also say that they never reach this UI (the settings guard above) and that the server refuses their sign-in and key writes (mcp-oauth `begin`, `setupForCaller`).
- Test: `__tests__/AgentSwitcher.test.tsx` (extend), and new `__tests__/AgentViewSharing.test.tsx` (harness like `AgentViewTabs.test.tsx`).

**Interfaces:**
- Consumes: `WorkspaceAgent.access` and `.sharedBy` (Task 2); `canManageAgent`, `canDeleteAgent` (Task 4); `SHARING_COPY.sharedBy`, `personLabel` (Task 3).

- [ ] **Step 1: Write the failing tests** (acceptance: the non-owner view)

`AgentSwitcher.test.tsx`:
- `an agent shared with you says who shared it` (`sharedBy: 'Vinay Pulim'`)
- `an unknown name reads as shared with you` (`sharedBy: null`)
- `an agent you only use has no settings or delete`. With `access: 'audience'`, the ⋮ is absent.
- `a co-owner gets settings but not delete`
- `your own and team agents keep settings and delete`. This covers `access` absent too.

`AgentViewSharing.test.tsx`:
- `opening the settings address of an agent you only use shows its chat instead`. `settingsSection: 'connectors'` with `access: 'audience'`: `onTab` is called with `'chat'`, and no "Settings sections" navigation renders.
- `an owner still gets the settings page`
- `a turn error offers Open Connectors only to someone who manages the agent`

- [ ] **Step 2: Run to verify they fail** — `pnpm --filter @ax/channel-web test -- AgentSwitcher AgentViewSharing` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass** — `pnpm --filter @ax/channel-web test && pnpm --filter @ax/channel-web build && pnpm lint` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "[TASK-1247] channel-web: shared agents say who shared them; people who only use an agent just chat"`

---

### Task 10: Docs, changeset, memory, and the PR's notes [tier: mechanical]

**Files:**
- Modify: `docs/plans/2026-11-25-agent-sharing-design.md`. Append **§10 Found while building phase 1B (TASK-1247)**, one bullet each:
  - the people search route and its rules (names only, not matched on email, 2–64 characters, at most 10, 60 a minute);
  - the roster lists shared agents while every "agents you manage" list doesn't;
  - the audience never sees an agent's activity line;
  - the option reads "Everyone", because the product is white-labeled;
  - the confirmation names attached connections only;
  - Remove owner exists, but self-removal doesn't;
  - the follow-ups listed below.
- Modify: `docs/plans/2026-05-24-current-architecture.md:381`. After the Agents / tenancy bullet, one sentence: people search is `GET /admin/people` in @ax/auth-better (names only), and the workspace roster carries each agent's `access` and `sharedBy`.
- Modify (stale lines): `packages/channel-web/src/lib/agents.ts:7-8` and `packages/channel-web/src/wire/chat.ts:270-271` say workspace pickers use `GET /api/chat/agents`. They use `/state` and `/tasks/agents`. Say who does use it, and that it lists agents the caller manages and never ones only shared with them.
- Create: `.changeset/agent-sharing-phase1b.md`: `"@ax/channel-web": minor`, `"@ax/auth-better": minor`, `"@ax/agents": patch`. Plain-language summary plus a "Not done yet" list (the follow-ups).
- Create: `.claude/memory/context/2026-11-25-TASK-1247.md` (`mkdir -p` its directory first). One row:
  - `GET /api/workspace/state` lists agents shared with the caller, each row carrying `access` and `sharedBy`;
  - `/route`, `/tasks`, `/tasks/agents`, `/api/chat/agents` and `GET /admin/agents` are "agents you manage";
  - people search is `GET /admin/people` (auth-better).

- [ ] **Step 1: Write the edits.**
- [ ] **Step 2: Reconcile with card C.**
  1. `git fetch origin && git rebase origin/main` (fresh `origin/main`, never local `main`).
  2. If TASK-1248 has merged, read `.claude/memory/decisions/*-TASK-1248.md` and the design doc's newest section.
  3. If card C restricted something the confirmation names (files, artifacts, Instructions, the connection accounts) or changed what the audience's memory holds, update `SHARING_COPY.confirm` and its tests in a separate commit.
  4. If TASK-1248 hasn't merged, say so in the handoff, with the sha the copy was checked against.
- [ ] **Step 3: Verify**

Run: `scripts/memory-append-check.sh origin/main && git diff --stat origin/main -- .claude/memory docs .changeset`
Expected: exit 0. The only memory files touched are the decisions shard and the new context shard.

- [ ] **Step 4: Commit** — `git add docs .changeset .claude/memory packages/channel-web/src/lib/agents.ts packages/channel-web/src/wire/chat.ts && git commit -m "[TASK-1247] docs: sharing phase 1B in the design and architecture docs; changeset"`

## Final gate

```bash
pnpm build && pnpm lint && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts
```
Expected: all green. `pnpm lint` includes the UI rules and the suppression ratchet. If `@ax/auth-better`'s Docker teardown times out with every assertion passing, record it, and show its `--filter` run passing.

## PR body must include

- **Merge after TASK-1248**, at the top, with the reason (memory refuses non-creators until card C).
- **Shapes** (the section above).
- **Boundary review: no hook changed.**
  - `GET /admin/people` is a route inside the plugin that owns the user rows. No `auth:*` hook was added, so nothing else on the bus can search people.
  - `WorkspaceAgent.access` and `.sharedBy` are channel-web's own wire between its server and its SPA.
  - Alternate impl if a hook is ever needed: an external directory (Google Workspace, Okta) answering `{ id, displayName }`.
- **security-checklist note** for Tasks 1, 2, 6 and 8. Include the residuals:
  - any signed-in person can list colleagues' names, by design;
  - two people with the same display name can't be told apart, and someone could rename themselves to look like a colleague. There is no email, by design;
  - person ids are now discoverable. The walk must list the routes that turn an id into an email for a non-admin (expected: none; `/admin/me` is self only, and `signerNames` shows email only to admins or the signer);
  - the name search scans the users table (no index on `name`), which is fine at company size;
  - the API still lets the audience read connections, Instructions and files. The UI hides Settings; the confirmation names them.
- **ux-designer**: what the pass changed (from the decisions shard).
- **Follow-ups** (for auto-ship to file):
  - CLAUDE.md:160 understates the UI lint: `className` on intrinsic elements and raw `div`/`span`/`p`/`h2`–`h6` are also banned.
  - Co-owners still see Housekeeping's routine switches and Settings › Agents' Delete, which the server refuses (creator only).
  - A new person whose only agents are shared with them still has to create their own first (the onboarding gate counts `/api/chat/agents`).
  - The per-user limiter now has three copies (channel-web, apps-bridge, auth-better).
  - `AgentSlackDms.tsx:2-5` and `channel-slack/src/agent-routes.ts:392-394` assume only the owner sees a personal agent (card C's area).
  - "Shared by" isn't on the home composer's agent menu or the agent header.
