# TASK-990 — Show the agent's own identity edits on Today: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task heading carries exactly one `[tier: …]` tag.

**Goal:** When an agent saves a change to its own identity or soul with `update_identity`, the host records which section changed. The agent's owner then sees a short, host-worded, informational row about it on Today. A person's editor save records nothing, and the row is never counted as waiting on anyone.

**Architecture:** `@ax/agents` owns the record. It is two nullable timestamps on the existing `agents_v1_identity` row, written in the same UPDATE as the text, and only when the write is attributed to the agent. Attribution is a new `author` field on `agents:identity:set`, and only the tool sets it. A new service hook, `agents:identity:self-changes-for-user`, lists a person's personal agents' recent changes. channel-web serves the list at `GET /api/workspace/self-changes`. The shell reads it on each Today entry, and `TodayView` draws it below the queue as an FYI section that `waitingOnYou` never sees.

**Tech Stack:** TypeScript, Kysely + Postgres (`@ax/agents`), zod `returns` schemas, React + shadcn (`@ax/channel-web`), vitest (+ testcontainers Postgres for `@ax/agents` and `@ax/preset-memory`).

**Spec:** the card (`[TASK-990]`, copied in the dispatch scratchpad) and `docs/plans/2026-10-29-agent-files-simplification-design.md` §5 ("Agent-facing tools", last bullet). Decisions, with rationale and rejected alternatives: `.claude/memory/decisions/2026-10-30-TASK-990.md`. **Do not re-open those decisions.** If the code contradicts one, stop and report it.

## Global Constraints

- **Wire and record carry three fields only:** `agentId`, `section` (`'identity' | 'soul'`), `changedAt` (ISO 8601). No identity, soul, Instructions or tool-input text is stored for an entry, sent with it, or rendered in it.
- **Exact names:** hook `agents:identity:self-changes-for-user`; route `GET /api/workspace/self-changes`; columns `identity_changed_by_agent_at`, `soul_changed_by_agent_at`; `agents:identity:set` field `author?: 'agent' | 'person'` (absent means `'person'`).
- **Recording rule:** a mark is written only when the outcome is `saved`, `author === 'agent'`, and the agent's `bootstrap !== 'pending'`. One mark goes on each section the UPDATE actually changes, set to the UPDATE's `now()`. `unchanged`, `conflict`, `refused`, a throw and `complete-bootstrap` write no mark.
- **Visibility:** personal agents of the asking person only (`scopedAgents(db, { userId, teamIds: [] })`). Team agents are never listed.
- **Window:** `SELF_CHANGE_WINDOW_DAYS = 7`, on the DB clock, applied to each section on its own. At most one item per (agent, section), the newest. Ordered newest first, then by `agentId`, then by `section`.
- **Wording (exact):** `identity` → `changed how it describes itself`; `soul` → `changed its personality`. Section heading: `Changes your agents made to themselves`. Note: `Just so you know — nothing to do here. You can edit any of it in Settings.` Button: `Review`, which calls `onOpenAdminSettings('agents')`. A `ux-design` pass may refine the copy only within these constraints: no counts, never "waiting", wording keyed by section, nothing from the agent.
- **`waitingOnYou` (`packages/channel-web/src/lib/today-queue.ts`) and its two call sites stay byte-for-byte unchanged.** The changes never reach its inputs.
- **UI:** compose the installed shadcn `Card` + `Button` with semantic tokens only (`text-muted-foreground`, `border-border`, `bg-card`…), with no raw colours. Invoke the `shadcn` and `ux-design` skills in Task 4. channel-web is on Tailwind 3: write `aria-[invalid=true]:`, never bare `aria-invalid:` (PR-1084).
- **No new dependency, no new package, no IPC change, no change to `agents:identity:get` output** (its exact shape is pinned with `toEqual` in admin-routes, onboarding and canary tests).
- **Tests:** `pnpm --filter <pkg> test` (filter BEFORE the script). `@ax/agents` and `@ax/preset-memory` start Postgres containers: prefix `DOCKER_HOST=unix:///var/run/docker.sock` (locally that is a symlink to OrbStack). The full gate is three suites: `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`. Run `pnpm typecheck` too: channel-web's tsc covers its tests.
- **Memory:** write new rows to shards only (`scripts/memory-write-target.sh --shard <kind> TASK-990`), never to a root archive, and add no `Memory-Rewrite` trailer.
- **Siblings:** TASK-993 (quota) and TASK-995 (git-tier removal) are in flight. Keep edits to `routes-workspace.ts` additive and surgical, and rebase rather than re-plan.

## Review Focus

Five ways this can go wrong that the spec implies but does not state, with the most likely first. Each is pinned by a test in the task named.

1. **Quick Today re-entry:** an older `/self-changes` reply that lands after a newer one must not overwrite it. Pinned in Task 4 (`useSelfChanges ignores a reply that lands after a newer read began`).
2. **A change whose agent is not in the roster** (deleted, unshared, or the roster is not loaded yet) is not drawn, and does not crash or render nameless. Pinned in Task 4 (`selfChangeRows drops a change whose agent the roster does not have`).
3. **A person saves in the editor while the agent's save is in flight:** this gives exactly one entry, for the agent's section only. Pinned in Task 2 (`a conflict retry lists exactly once, and a person's save in between lists nothing`).
4. **One agent with a fresh change in one section and an old one (more than 7 days) in the other:** only the fresh one is listed. Pinned in Task 1 (`each section has its own window`).
5. **A hook reply that carries extra fields** (say, a stray text field) never reaches the browser. Pinned in Task 3 (`never forwards a field it was not asked for`).

## Boundary review (paste into the PR body)

- **`agents:identity:set` gains `author?: 'agent' | 'person'`.** Alternate impl: a team-level profile service. It would also need to know whether a change was the agent's own, so that it can tell people. Leaky names: none. Subscriber risk: none (a service hook, and `system-prompt:augment-changed` is unchanged). Wire surface: not an IPC action. The sandbox reaches the hook only through `tool:execute:update_identity`, whose input parser refuses extra keys, and the executor hard-codes `'agent'`.
- **New `agents:identity:self-changes-for-user {userId} → {changes: [{agentId, section, changedAt}]}`.** Alternate impl: a notifications/inbox service that stores agent-authored events, or the team-level profile service. Leaky names: none (`section` is the identity vocabulary, `changedAt` is an ISO instant, and no table, column or row ids appear). Subscriber risk: none (a service hook). Wire surface: none. It is host-only, and its one caller is channel-web's authenticated route.

## Security note pointers (run `security-checklist` for Tasks 1–2)

- **Prompt injection.** The model cannot word, add or suppress an entry. The wording is host constants keyed by a closed enum. The mark is committed with the text in one UPDATE. The model controls neither `author` nor the transaction. Make that claim with the evidence: `ipc-protocol/src/actions.ts` (a fixed action list), `tools.ts` `UPDATE_KEYS`, and the Task 2 tests.
- **Cross-tenant read.** The hook scopes through `scopedAgents` with the given `userId`. The route passes only the authenticated id and reads no params. Tests cover another user, team members and query smuggling.
- **Sandbox escape and supply chain:** N/A. There is no new process, path, network reach or dependency.

## File map

| File | Change |
|---|---|
| `packages/agents/src/migrations.ts` | +2 `ADD COLUMN IF NOT EXISTS` after the `agents_v1_identity` CREATE (:177-191); `AgentsIdentityRow` (:223-231) +2 columns |
| `packages/agents/src/types.ts` | new TASK-990 block after the identity schemas (~:551); `IdentitySetInput.author` |
| `packages/agents/src/identity/store.ts` | `listSelfChanges`; `set` takes `author` and marks |
| `packages/agents/src/identity/service.ts` | `selfChangesForUser`; `parseSetInput` accepts `author` |
| `packages/agents/src/identity/tools.ts` | set payload + `author: 'agent'`; local `SelfSection` → imported |
| `packages/agents/src/plugin.ts`, `src/index.ts` | register + export |
| `packages/channel-web/src/lib/workspace-types.ts` | `SelfChangeSection`, `SelfChange`, `SelfChangesResponse` |
| `packages/channel-web/src/server/routes-workspace.ts` | `selfChanges` handler + route entry + header lines |
| `packages/channel-web/src/server/plugin.ts` | optionalCalls entry |
| `packages/channel-web/src/lib/workspace-api.ts` | `workspaceApi.selfChanges()` + guard |
| `packages/channel-web/src/lib/workspace-self-changes.ts` (new) | words, rows, `useSelfChanges` |
| `packages/channel-web/src/components/workspace/AgentSelfChanges.tsx` (new) | the section |
| `packages/channel-web/src/components/workspace/TodayView.tsx` | two optional props + render + header comment |
| `packages/channel-web/src/components/workspace/WorkspaceShell.tsx` | read + pass props |
| `packages/channel-web/src/lib/workspace-context.tsx` | header comment only |
| `presets/memory/src/__tests__/canary.test.ts` | one end-to-end case |
| `docs/plans/2026-10-29-agent-files-simplification-design.md` | §5 as-built note |

---

### Task 1: `@ax/agents` — the change marks and their read hook [tier: sensitive]

Needs `security-checklist` (owner-scoped multi-tenant read on a new hook).

**Files:**
- Modify: `packages/agents/src/migrations.ts`, `src/types.ts`, `src/identity/store.ts`, `src/identity/service.ts`, `src/plugin.ts` (registers :164-171; registration next to :713-718), `src/index.ts`
- Create test: `packages/agents/src/__tests__/identity-self-changes.test.ts` (top-level `const env = useIdentityEnv();`, its own container)
- Modify tests: `src/__tests__/migrations.test.ts`, `src/__tests__/return-schemas.test.ts`, `src/__tests__/plugin.test.ts:127-157`

**Interfaces — Produces** (Task 2, Task 3 and the canary use these names):
```ts
// types.ts
export const AGENTS_IDENTITY_SELF_CHANGES_FOR_USER_HOOK = 'agents:identity:self-changes-for-user';
export const SELF_SECTIONS = ['identity', 'soul'] as const;      // what an agent may change about itself
export type SelfSection = (typeof SELF_SECTIONS)[number];
export const SELF_CHANGE_WINDOW_DAYS = 7;
export interface IdentitySelfChange { agentId: string; section: SelfSection; changedAt: string } // ISO 8601
export interface IdentitySelfChangesForUserInput { userId: string }
export interface IdentitySelfChangesForUserOutput { changes: IdentitySelfChange[] }
export const IdentitySelfChangesForUserOutputSchema: ZodType<IdentitySelfChangesForUserOutput>;
//   z.object({ changes: z.array(z.object({ agentId: z.string().min(1), section: z.enum(SELF_SECTIONS), changedAt: z.string().datetime() })) })
// identity/store.ts — IdentityStore gains
listSelfChanges(userId: string): Promise<IdentitySelfChange[]>;
// identity/service.ts — IdentityService gains
selfChangesForUser(ctx: AgentContext, input: unknown): Promise<IdentitySelfChangesForUserOutput>;
```
DB: `agents_v1_identity.identity_changed_by_agent_at TIMESTAMPTZ NULL`, `agents_v1_identity.soul_changed_by_agent_at TIMESTAMPTZ NULL`. The Kysely row type for both is `Generated<Date | null>`, so the existing `insertInto(...).values({ agent_id })` still compiles.

- [ ] **Step 1: Write the failing tests** in `identity-self-changes.test.ts`. Seed marks with raw SQL, because no writer exists until Task 2:
```ts
async function mark(agentId: string, section: 'identity' | 'soul', ago: string): Promise<void> {
  await env.query('INSERT INTO agents_v1_identity (agent_id) VALUES ($1) ON CONFLICT (agent_id) DO NOTHING', [agentId]);
  await env.query(`UPDATE agents_v1_identity SET ${section}_changed_by_agent_at = now() - $2::interval WHERE agent_id = $1`, [agentId, ago]);
}
const list = (ih: IdentityHarness, userId: string) =>
  ih.h.bus.call<unknown, IdentitySelfChangesForUserOutput>(AGENTS_IDENTITY_SELF_CHANGES_FOR_USER_HOOK, ih.ctx('any', userId), { userId });
```
  - `lists the owner's own agents' changes, newest first, three fields each`: alice owns A1 (`mark soul '1 day'`) and A2 (`mark identity '2 hours'`). Expect `changes.map(c => [c.agentId, c.section])` to equal `[[A2,'identity'],[A1,'soul']]`, every `Object.keys(c).sort()` to equal `['agentId','changedAt','section']`, and `Date.parse(c.changedAt)` to land inside the seeded range.
  - `an agent with no identity row, or no mark, lists nothing`: `{ changes: [] }`.
  - `each section has its own window`: A1 with soul `'8 days'` and identity `'6 days'` lists only `[A1,'identity']`.
  - `another person never sees them`: `list(ih, 'bob')` gives `[]`.
  - `team agents are left out, for every member`: use `makeHarness({ teamMembers: ['alice','bob'] })` and `createAgent('alice', { input: { visibility: 'team', teamId: 't1' } })`, then mark soul. Both alice and bob get `[]`.
  - `a deleted agent's changes go with it`: mark, then `agents:delete` (`{ actor: { userId: 'alice', isAdmin: false }, agentId }`), then `[]`.
  - `refuses malformed input`: for each of `undefined, null, 'alice', {}, { userId: '' }, { userId: 7 }, { userId: 'alice', teamIds: [] }`, the call rejects with a `PluginError` whose code is `'invalid-payload'` (reuse the `rejection()` helper pattern from `identity.test.ts:62`).
  - In `migrations.test.ts`: `adds the two self-change columns to agents_v1_identity as nullable timestamptz, idempotently`. Copy the `connector_exclusions` case: run twice, then check that `information_schema.columns` reports both as `timestamp with time zone`, `is_nullable: 'YES'`, and that a pre-existing identity row reads `null` for both.
  - In `return-schemas.test.ts`: the schema round-trips a valid output, and rejects an unknown section, an empty `agentId`, a missing `changedAt` and a non-ISO `changedAt`.
  - In `plugin.test.ts:127`: the `registers` pin gains `'agents:identity:self-changes-for-user'` right after `'agents:identity:complete-bootstrap'`.

- [ ] **Step 2: Run the suite and confirm it fails.**
  Run: `DOCKER_HOST=unix:///var/run/docker.sock pnpm --filter @ax/agents test src/__tests__/identity-self-changes.test.ts src/__tests__/migrations.test.ts src/__tests__/return-schemas.test.ts src/__tests__/plugin.test.ts`
  Expected: FAIL (unknown hook / missing columns / missing export).

- [ ] **Step 3: Implement.**
  - `migrations.ts`: after the `agents_v1_identity` CREATE, add two `ALTER TABLE agents_v1_identity ADD COLUMN IF NOT EXISTS <col> TIMESTAMPTZ` statements. Write a header comment saying what they mean: "the last time the agent itself changed this section, outside first-run setup (TASK-990); not a history." Update the table list in the file header.
  - `store.ts` `listSelfChanges(userId)`: start from `scopedAgents(db, { userId, teamIds: [] })` and inner-join `agents_v1_identity` on `agent_id`. Qualify the columns, because both tables have `agent_id`. Take each section's mark only when it is newer than `now() - make_interval(days => SELF_CHANGE_WINDOW_DAYS)`, judged on the DB clock and per column (for example, `CASE WHEN … THEN col END`). Flatten to one item per present mark, turn dates into strings with `toISOString()`, and sort as the Global Constraints say. Comment that `teamIds: []` is the deliberate personal-only choice (see the decisions shard).
  - `service.ts` `selfChangesForUser`: the input must be a plain object whose only key is `userId`, a non-empty string. Anything else is `invalid-payload` (use the existing `invalid()` helper and name the hook). Return `{ changes: await deps.identity.listSelfChanges(userId) }`. Add no ctx ACL: like `agents:list-for-user`, the host-only caller supplies the person, and a comment should say so.
  - `plugin.ts`: register it with `{ returns: IdentitySelfChangesForUserOutputSchema }` after `complete-bootstrap`, and add it to `registers`. `index.ts`: export the new constants, schema and types.
  - `types.ts`: in the block comment, give the hook's contract and the boundary-review answers (copy them from this plan).

- [ ] **Step 4: Run the tests and confirm they pass.** Use the same command, then run the whole package: `DOCKER_HOST=unix:///var/run/docker.sock pnpm --filter @ax/agents test`. Expected: PASS.

- [ ] **Step 5: Commit**: `feat(agents): agents:identity:self-changes-for-user over per-section change marks (TASK-990)`.

---

### Task 2: `@ax/agents` — attribute the agent's own writes and mark them [tier: sensitive]

Needs `security-checklist` (this is the hook that carries model-written text; the attribution must be impossible for the model to forge or suppress).

**Files:**
- Modify: `packages/agents/src/types.ts` (`IdentitySetInput` :476-482; new `IdentityAuthor`), `src/identity/service.ts` (`parseSetInput` :108-135, `set` :258-314), `src/identity/store.ts` (`IdentityStoreSetArgs` :32-37, `set` :121-176), `src/identity/tools.ts` (:123, :275-282), `src/index.ts`
- Modify tests: `src/__tests__/identity.test.ts` (new `describe`), `src/__tests__/identity-tools.test.ts` (the pin at :436-439, plus new cases)

**Interfaces:**
- Consumes (Task 1): `AGENTS_IDENTITY_SELF_CHANGES_FOR_USER_HOOK`, `SelfSection`, the two columns.
- Produces:
```ts
export type IdentityAuthor = 'agent' | 'person';
export interface IdentitySetInput { agentId: string; patch: Partial<Record<IdentitySection, string>>; expectedRevision: number;
  /** Who is writing. Absent = 'person'. Only the agent's own update_identity sends 'agent'; an 'agent' patch may name only identity and soul. */
  author?: IdentityAuthor }
// identity/store.ts
export interface IdentityStoreSetArgs { agentId: string; patch: …; expectedRevision: number; author: IdentityAuthor }
```

- [ ] **Step 1: Write the failing tests.** List through the Task 1 hook (`list(ih, userId)` as there). Create a helper `setAs(ih, id, user, patch, author?)` that reads the revision and calls `AGENTS_IDENTITY_SET_HOOK` with `author` only when it is given.
  In `identity.test.ts`, `describe('agents:identity:set — who wrote it (TASK-990)')`:
  - `an agent's saved write lists its section; a person's write lists nothing`: a person sets identity, which lists `[]`. The agent then sets soul, which lists exactly `[[id,'soul']]`.
  - `"author" is "agent" or "person", and an agent's write may not name the Instructions`: `author: 'robot'` and `{ author: 'agent', patch: { instructions: 'x' } }` both reject as `invalid-payload`. `ih.scanned` stays `[]` and the revision is unchanged.
  - `only the sections an agent's write actually changes are listed`: a person sets identity to `'Pip'`. The agent then patches `{ identity: 'Pip', soul: 'Kind' }`, which lists only soul. An agent patch that changes both sections lists two items with equal `changedAt`.
  - `an agent's write that changes nothing lists nothing`: a person saves soul `'Kind'`, then the agent saves soul `'Kind'`. The outcome is `unchanged` and the list is `[]`.
  - `an agent's writes during first-run setup list nothing; after it they do`: `createAgent('alice', { bootstrap: 'pending' })`. The agent saves identity and soul, which lists `[]`. `complete-bootstrap` returns `completed`. Another agent soul save then lists `[[id,'soul']]`.
  - `a refused or stale agent write lists nothing`: with `setScan(async () => ({ verdict: 'refused', reason: 'x' }))` the outcome is `refused` and the list is `[]`. With a stale `expectedRevision` the outcome is `conflict` and the list is `[]`.
  - `the same section changed again stays one entry, at the newer time`: two agent soul saves give one item, whose second `changedAt` is `>=` the first.

  In `identity-tools.test.ts`:
  - Update the pin at :436-439 to `{ agentId: id, patch: { soul: 'Kind' }, expectedRevision: 0, author: 'agent' }`.
  - `a successful update_identity lists exactly one change for its owner, naming the section`: content `'I keep promises small and specific.'` gives `[[id,'soul']]`. `JSON.stringify(output)` does not contain `'promises'`. Bob's list is `[]`.
  - `failed or refused update_identity calls list nothing`: an `it.each` over refused scan, a scan that throws (`unavailable`), `old` not found, `old` not unique, `section: 'instructions'`, `{ source: 'routine' }`, and an extra input key. Each returns `ok: false` and the list is `[]`.
  - `a conflict retry lists exactly once, and a person's save in between lists nothing`: make the scan stub hold its FIRST call until released. Start the tool's soul save, and while it is held, save identity through the hook with no `author` (its own scan answers at once). Then release. Expect the tool to return `ok: true` and the list to be exactly `[[id,'soul']]`.

- [ ] **Step 2: Run the tests and confirm they fail.**
  Run: `DOCKER_HOST=unix:///var/run/docker.sock pnpm --filter @ax/agents test src/__tests__/identity.test.ts src/__tests__/identity-tools.test.ts`
  Expected: FAIL (`author` is refused as an unknown key; nothing is marked).

- [ ] **Step 3: Implement.**
  - `parseSetInput`: allow the `author` key. Anything other than `undefined | 'agent' | 'person'` is `invalid('author must be "agent" or "person"')`, and `author === 'agent'` with an `instructions` key in the patch is `invalid("an agent's own write may change only its identity and soul")`. Both checks run before any scan. Return `author: author ?? 'person'`.
  - `set`: pass `author` to the store. Add `author` to the `agent_identity_saved` log fields. Never log text.
  - `store.set`: inside the existing transaction, after `changes` is computed and before the UPDATE, add one `<section>_changed_by_agent_at: sql<Date>\`now()\`` to the UPDATE's `.set({...})` for each section in `changes`, but only when `author === 'agent' && current.bootstrap !== 'pending'`. `changes` can only hold identity and soul for an agent, because the service refuses `instructions`. `RETURNING`/`COLUMNS` stay as they are, so the identity record shape is unchanged.
  - `tools.ts`: add `author: 'agent'` to the set payload, and replace the local `type SelfSection` (:123) with the import from `../types.js`. Add a header line saying that the tool is the only `'agent'` writer, and that this is what puts the change on the owner's Today.
  - `index.ts`: export `IdentityAuthor`.

- [ ] **Step 4: Run the tests and confirm they pass.** Run the whole package: `DOCKER_HOST=unix:///var/run/docker.sock pnpm --filter @ax/agents test`. Expected: PASS, including the existing TASK-989 cases unchanged apart from the one pin.

- [ ] **Step 5: Commit**: `feat(agents): attribute update_identity writes and mark the changed section (TASK-990)`.

---

### Task 3: channel-web server — `GET /api/workspace/self-changes` [tier: integration]

The posture copies `/grants`: no params, the authenticated caller only. It is covered by the PR's security note.

**Files:**
- Modify: `packages/channel-web/src/lib/workspace-types.ts` (DTOs, next to `TasksResponse` ~:1420)
- Modify: `packages/channel-web/src/server/routes-workspace.ts`. Add the handler `selfChanges` in `makeWorkspaceHandlers` next to `grants` (~:6712) and a `routes` entry next to `/api/workspace/grants` (~:9975). Header edits: add a route-map line (:2-33); add the `/self-changes` posture to the "gated DIFFERENTLY" paragraph (:119-139); delete the stale `/activity` mentions at :66 and :121; replace the retired activity-feed paragraph :148-160 with the current rule: "each collection has ONE producer route, never a field on `/state`: `/decisions`, `/tasks`, `/grants`, `/self-changes`. The Activity feed that first set this rule was retired in TASK-972."
- Modify: `packages/channel-web/src/server/plugin.ts` optionalCalls (after the `agents:identity:set` entry, ~:740)
- Create test: `packages/channel-web/src/__tests__/server/routes-workspace-self-changes.test.ts` (copy `mkReq`/`mkRes`/`initCtx` from `routes-workspace-grants.test.ts`; real `HookBus`; fake `auth:require-user` and a fake hook)
- Modify tests: `src/__tests__/server/plugin.test.ts:687` (exact manifest pin), `src/__tests__/server/routes-workspace-registration.test.ts` (`toContain`)

**Interfaces — Produces** (Task 4):
```ts
// lib/workspace-types.ts
export type SelfChangeSection = 'identity' | 'soul';
export interface SelfChange { agentId: string; section: SelfChangeSection; changedAt: string }
export interface SelfChangesResponse { changes: SelfChange[] }
```
Route contract: 401 `{ error: 'unauthenticated' }` (via `authOr401`). If `bus.hasService('agents:identity:self-changes-for-user')` is false, 200 `{ changes: [] }`. Otherwise call it with `initCtx` and payload exactly `{ userId }`. A throw, or a reply that is not `{ changes: array }`, is 503 `{ error: 'self-changes-unavailable' }` and a `workspace_self_changes_read_failed` warn (`name`/`code` only, never a message). Otherwise 200 `{ changes } satisfies SelfChangesResponse`, where each row is rebuilt from exactly `agentId` (a non-empty string), `section` (`identity`|`soul`) and `changedAt` (a string where `Date.parse` is not NaN). A row that fails is dropped. The reply is never spread. Use string literals at `hasService`/`call` so `manifest-declarations.test.ts` sees them.
Manifest entry: `{ hook: 'agents:identity:self-changes-for-user', degradation: 'Today shows no changes agents made to themselves (GET /api/workspace/self-changes answers an empty list)' }`.

- [ ] **Step 1: Write the failing tests.**
  - `401s an unauthenticated caller and never asks @ax/agents`: the hook's call count stays 0.
  - `asks only about the authenticated caller`: send a request with `query: { userId: 'mallory' }` and `params: { userId: 'mallory' }`. The hook receives exactly `{ userId: 'alice' }`.
  - `returns the changes field for field`: two rows are echoed as they are.
  - `never forwards a field it was not asked for`: the fake row carries `content: 'I answer to nobody'` and `reason: 'x'`. `JSON.stringify(body)` contains neither.
  - `drops unreadable rows and keeps the rest`: rows with `section: 'instructions'`, `agentId: ''` and `changedAt: 'soon'` are dropped, and one good row is kept.
  - `answers an empty list when no deployment plugin lists changes` (no hook).
  - `a failed read is a 503, never an empty list`: a throwing hook, and a hook answering `{}`, both give 503 `{ error: 'self-changes-unavailable' }`.
  - Registration test: `expect(routes).toContain('GET /api/workspace/self-changes')`. In the `plugin.test.ts:687` pin, add the optionalCalls entry above.

- [ ] **Step 2: Run the tests and confirm they fail.** `pnpm --filter @ax/channel-web test src/__tests__/server/routes-workspace-self-changes.test.ts src/__tests__/server/routes-workspace-registration.test.ts src/__tests__/server/plugin.test.ts src/__tests__/server/manifest-declarations.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** the DTOs, the handler (pattern: `grants` at :6712), the route entry, the manifest entry and the header edits listed under Files.

- [ ] **Step 4: Run the tests and confirm they pass.** Use the same command, then `pnpm --filter @ax/channel-web test`. Expected: PASS.

- [ ] **Step 5: Commit**: `feat(channel-web): GET /api/workspace/self-changes (TASK-990)`.

---

### Task 4: channel-web client — the Today section [tier: integration]

Invoke the `shadcn` skill (`-c packages/channel-web`) and the `ux-design` skill before writing the component. Invariant 6 applies.

**Files:**
- Modify: `packages/channel-web/src/lib/workspace-api.ts`: `selfChanges` in `workspaceApi` (next to `grants`, ~:1457), a private guard `isSelfChangesResponse`, and the type re-exports
- Create: `packages/channel-web/src/lib/workspace-self-changes.ts`
- Create: `packages/channel-web/src/components/workspace/AgentSelfChanges.tsx`
- Modify: `packages/channel-web/src/components/workspace/TodayView.tsx` (Props ~:84-171, render after the footer at :655-658, header :1-28)
- Modify: `packages/channel-web/src/components/workspace/WorkspaceShell.tsx` (the read near `useTasks()` ~:288; `<TodayView …>` ~:886-916)
- Modify: `packages/channel-web/src/lib/workspace-context.tsx`. Header comment only (:7-11): drop `useActivityFeed` / `/activity`, and add `useSelfChanges` over `GET /api/workspace/self-changes`.
- Create tests: `src/lib/__tests__/workspace-self-changes.test.ts`, `src/lib/__tests__/workspace-api-self-changes.test.ts` (copy `respondWith` from `workspace-api-decision-shape.test.ts:24`)
- Modify tests: `src/components/workspace/__tests__/TodayView.test.tsx` (via `renderToday(over)`), `src/components/workspace/__tests__/WorkspaceShell.test.tsx` (add `selfChanges: vi.fn()` to the mock at :24-53, and in `beforeEach` default it to `{ changes: [] }`)

**Interfaces:**
- Consumes (Task 3): `SelfChange`, `SelfChangeSection`, `SelfChangesResponse`, `GET /api/workspace/self-changes`.
- Produces:
```ts
// lib/workspace-api.ts
workspaceApi.selfChanges(): Promise<SelfChangesResponse>   // checkedRead('/self-changes', …): every row must have agentId string, section identity|soul, changedAt string — else WorkspaceShapeError
// lib/workspace-self-changes.ts
export const SELF_CHANGE_WORDS: Readonly<Record<SelfChangeSection, string>>; // { identity: 'changed how it describes itself', soul: 'changed its personality' }
export interface SelfChangeRow { key: string; agentId: string; agentName: string; words: string; changedAt: string }
export function selfChangeRows(changes: readonly SelfChange[], agents: readonly { id: string; name: string }[]): SelfChangeRow[];
export function useSelfChanges(active: boolean): readonly SelfChange[];
// components/workspace/AgentSelfChanges.tsx
export function AgentSelfChanges(props: { rows: readonly SelfChangeRow[]; onReview?: (() => void) | undefined }): JSX.Element | null;
// TodayView Props (optional; exactOptionalPropertyTypes-safe)
selfChanges?: readonly SelfChange[] | undefined;      // default []
onReviewSelfChange?: (() => void) | undefined;        // absent → no Review button
```
Behaviour:
- **`selfChangeRows`** drops changes whose agent is not in the roster. It orders newest first (unparseable `changedAt` last) and uses the key `JSON.stringify([agentId, section])`. `words` comes from `SELF_CHANGE_WORDS`. It does not dedupe, because the server guarantees one item per (agent, section).
- **`useSelfChanges(active)`** reads `workspaceApi.selfChanges()` each time `active` becomes true. It keeps only the reply of the newest read that is still active (a sequence ref plus an effect-cleanup flag). On any failure it keeps what it had, writes one `console.warn('[workspace] could not read agent self-changes', err)`, and never throws. A missing mock method lands in the same catch.
- **`AgentSelfChanges`** renders `null` when `rows` is empty. Otherwise it renders `<section aria-labelledby=…>` with an `h2` (heading copy; `text-[12.5px] font-medium text-muted-foreground`), a muted `p` (note copy), and then a `Card` containing a `ul` (`divide-y divide-border`). Each `li` holds `{agentName}` (`font-medium`) and `{words}`, then `timeAgo(changedAt)` from `lib/workspace-time.ts` (left out when it returns `null`), then, only when `onReview` is set, `<Button variant="ghost" size="sm" aria-label={`Review: ${agentName} ${words}`}>Review</Button>`.
- **`TodayView`** renders `<AgentSelfChanges rows={selfChangeRows(selfChanges, agents)} onReview={onReviewSelfChange} />` as the last child of its root, after the footer and outside the consent region, whatever `filter` is set to. Nothing feeds it into `waitingOnYou`, `headline`, `summary` or `nothingListed`. Header comment: line 2's "and nothing else" becomes "and, below it, the changes agents made to themselves, which are never counted as waiting". Property 2 drops the Activity / footer-link sentence (both were retired by TASK-972).
- **`WorkspaceShell`**: `const selfChanges = useSelfChanges(route.kind === 'today');`. Pass `selfChanges={selfChanges}` and `onReviewSelfChange={onOpenAdminSettings === undefined ? undefined : () => onOpenAdminSettings('agents')}`. `pending` / `waitingOnYou` stay as they are.

- [ ] **Step 1: Write the failing tests.**
  - `workspace-api-self-changes.test.ts`: `selfChanges()` returns a valid body. It rejects with `WorkspaceShapeError` for `{}`, for a row with `section: 'instructions'`, for a row with no `agentId`, and for a row whose `changedAt` is a number.
  - `workspace-self-changes.test.ts`: `SELF_CHANGE_WORDS` equals the exact two strings. `selfChangeRows drops a change whose agent the roster does not have`. `selfChangeRows orders newest first and names each row from the roster`. Using `renderHook` with deferred promises: `useSelfChanges reads when it becomes active and again on each re-activation`; `useSelfChanges ignores a reply that lands after a newer read began` (enter, leave, re-enter, then resolve the first read last; the state equals the second reply); `useSelfChanges keeps what it had when a read fails`.
  - `TodayView.test.tsx`:
    - `shows each self-change in host words`: the text `Quill changed its personality` is present, and so are `Changes your agents made to themselves` and the note.
    - `self-changes never count as waiting`: with only self-changes the headline is `Nothing is waiting on you.` and there is no summary line. Add one open `decision()` and the headline is `One thing is waiting on you.` with the summary `1 waiting on you`.
    - `self-changes show under the Working filter too`.
    - `no self-changes, no section`: `queryByText('Changes your agents made to themselves')` is null.
    - `a self-change for an agent not on the roster is not drawn`.
    - `Review calls onReviewSelfChange; without it there is no Review button`.
  - `WorkspaceShell.test.tsx`: `Today shows the agents' self-changes and the Needs you count ignores them`. Mock two changes and one open decision; the "Needs you" segment shows 1 and both rows render. `Review opens Settings on the Agents tab`: `onOpenAdminSettings` is called with `'agents'`.

- [ ] **Step 2: Run the tests and confirm they fail.** `pnpm --filter @ax/channel-web test src/lib/__tests__/workspace-self-changes.test.ts src/lib/__tests__/workspace-api-self-changes.test.ts src/components/workspace/__tests__/TodayView.test.tsx src/components/workspace/__tests__/WorkspaceShell.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement** the interfaces above. Then do the `ux-design` pass on the rendered section. Copy changes are allowed only within the Global Constraints, and must be reflected in the tests and the decisions shard.

- [ ] **Step 4: Run the tests and confirm they pass.** Use the same command, then `pnpm --filter @ax/channel-web test` and `pnpm typecheck` (channel-web's tsc covers its tests). Expected: PASS.

- [ ] **Step 5: Commit**: `feat(channel-web): show agents' own identity changes on Today (TASK-990)`.

---

### Task 5: Canary — the whole path on the real assembly (Invariant 3) [tier: integration]

**Files:**
- Modify: `presets/memory/src/__tests__/canary.test.ts`. Add one `it` inside `describe('TASK-989: identity in the database')` (:1490-1644), after the admin-editor case, reusing its `runTool`, `getIdentity` and `INJECTION`, plus the file's `apiJson`, `ctxFor`, `ALICE` and `EVE`.

**Interfaces — Consumes:** the hook (Task 1), `author` marking (Task 2), the route (Task 3).

- [ ] **Step 1: Write the test** `identity: an agent's own change shows on its owner's Today; a person's edit, a refused change and first-run setup don't (TASK-990)`. Use a fresh personal agent for ALICE (`agents:create` as in `seedAgents`'s `mk`, display name `'Wren'`), so earlier cases' state cannot leak in. Let `mine(json)` be the rows whose `agentId` is that agent.
  1. `GET /api/workspace/self-changes` as ALICE gives 200, and `mine` is `[]`.
  2. `PUT /admin/agents/<id>/identity` as ALICE `{ identity: 'Wren, a careful helper.', soul: 'Be plain.' }` gives 200. `mine` is still `[]`.
  3. `runTool('update_identity', id, ALICE, { section: 'soul', content: INJECTION })` gives `ok: false` with error `refused`. `mine` is still `[]`.
  4. `runTool('update_identity', id, ALICE, { section: 'soul', content: 'I value plain words and short answers.' })` gives `ok: true`. `mine` equals `[{ agentId: id, section: 'soul', changedAt: expect.any(String) }]`, and `JSON.stringify(json)` does not contain `'plain words'`.
  5. The same GET as EVE gives 200 with no row for the agent. The GET with user `null` gives 401.
  6. `POST /api/agents/bootstrap` as ALICE `{ displayName: 'Sprout' }` gives 201, so the agent is pending. A tool soul save gives `ok: true`, and there is no row for Sprout.

- [ ] **Step 2: Run it** (it fails before Tasks 1-3 land, and passes after): `DOCKER_HOST=unix:///var/run/docker.sock pnpm --filter @ax/preset-memory test src/__tests__/canary.test.ts`. Expected: PASS.

- [ ] **Step 3: Commit**: `test(preset-memory): canary for agents' own identity changes on Today (TASK-990)`.

No change is needed in `presets/k8s`. The acceptance permissive agents stub does not register the hook, so the route answers `[]`. The `preset.test.ts` channel-web pins use `toContain`. Confirm this by running `pnpm --filter @ax/preset-k8s test src/__tests__/preset.test.ts`.

---

### Task 6: Design-doc as-built note and memory [tier: mechanical]

**Files:**
- Modify: `docs/plans/2026-10-29-agent-files-simplification-design.md` §5. Add the bullet below directly after the "When the agent changes its own identity…" bullet (:153-157).
- Create: the context shard at `$(scripts/memory-write-target.sh --shard context TASK-990)` (run `mkdir -p` on its dirname first).

- [ ] **Step 1:** Add this bullet verbatim, adjusting it only if Task 4's `ux-design` pass changed the copy:

```markdown
- **As built (TASK-990):** there is no activity feed to add to (TASK-972 retired
  it). The entry is a per-section "last changed by the agent" time on the
  agent's identity row, written in the same transaction as the text, only for
  `update_identity` saves (`author: 'agent'` on `agents:identity:set`), and not
  during first-run setup. Today reads `agents:identity:self-changes-for-user`
  through `GET /api/workspace/self-changes`: the owner's personal agents, last 7
  days, newest change per section, worded by the host ("changed its
  personality", "changed how it describes itself"), and never counted as
  waiting on you. Team agents are left out until the team role model exists.
  The §16.6 walk should check that an agent's soul change shows on Today and a
  person's edit doesn't.
```
- [ ] **Step 2:** Add a context shard row. Since TASK-972 there is no Activity feed: `context.md:75`, `mistakes.md:15` and `decisions.md:66-89` describe a retired route. An agent's own identity or soul change reaches Today through `agents:identity:self-changes-for-user` → `GET /api/workspace/self-changes` (TASK-990). Also add a patterns row if the build hit something non-obvious.
- [ ] **Step 3: Commit** the doc and the memory shards (decisions, context) with the work: `docs: as-built note for agents' own identity changes on Today (TASK-990)`.

---

## Final verification (before the PR)

```bash
pnpm build && pnpm typecheck && pnpm lint
DOCKER_HOST=unix:///var/run/docker.sock pnpm --filter @ax/agents test
pnpm --filter @ax/channel-web test
DOCKER_HOST=unix:///var/run/docker.sock pnpm --filter @ax/preset-memory test
DOCKER_HOST=unix:///var/run/docker.sock pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts
```
Expected: all green. An `@ax/auth-better` Docker teardown timeout with every assertion passing is the known local flake (CLAUDE.md). `@ax/routines` can time out under load: re-run that package alone. The PR body carries the boundary review above, the `security-checklist` note, and the three deliberate refinements of the card's wording: (1) first-run setup saves are not listed; (2) an `unchanged` save is not listed; (3) repeated changes to one section show once, at the newest time. It also states the team-agent exclusion.

## Not doing (YAGNI, logged in the decisions shard)

Dismiss / mark-as-seen; clearing a row when a person later edits; a deep link to this agent's edit form; a generic notifications store; team-agent rows; a cap on rows (at most 2 per personal agent); any change to `waitingOnYou`, the sidebar badge or the Needs you count.
