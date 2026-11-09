# TASK-1102 — Directory provenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an admin saves a connector from a directory listing, `@ax/connector-directory` remembers `{ directoryId, version, edited }` against the connector's id in its own table. A hand-changed server address flips `edited`, and deleting the connector removes the row.

**Architecture:** The editor sends an opaque `fromDirectory` beside the connector fields on `POST /admin/connectors`. The connectors route validates it, strips it, creates the connector byte-for-byte as a hand-entered one, then calls a new directory service hook. PATCH calls a second hook when a server address changed. The directory plugin owns the table, both hooks and a `connectors:deleted` subscriber. No cross-plugin import: hook names are mirrored strings, proven in step by the preset canary.

**Tech Stack:** TypeScript, Kysely + Postgres (testcontainers `postgres:16-alpine`), zod, vitest, React (channel-web).

**Spec:** `docs/plans/2026-11-09-mcp-directory-connectors-design.md` (Decision 8, Resolved questions 3 and 4) + the TASK-1102 card. Decisions: `.claude/memory/decisions/2026-11-09-TASK-1102.md` (read it; it says WHY for every call below).

## Global Constraints

- Hook names, exact: `connectors:directory-provenance-record`, `connectors:directory-provenance-mark-edited`. Subscriber: `connectors:deleted` (existing, payload unchanged).
- `@ax/connectors` never imports `@ax/connector-directory` (invariant 2). `packages/connectors/src/types.ts` is NOT modified: the connector schema gains no directory field.
- A provenance call never fails or changes a connector write: it runs after the write succeeded, is awaited before the response, and any throw is logged and swallowed. Both calls are skipped when `bus.hasService(hook)` is false.
- Never log `directoryId` or `version` (client-originated). Log `connectorId` (server-derived) and a fixed `reason`.
- The disabled directory's manifest stays exactly `{ registers: ['connectors:directory-search'], calls: [], subscribes: [] }` (pinned by TASK-1100 tests).
- No new dependencies. No FK. The migration stays additive and idempotent.
- Docker-backed tests need an explicit `DOCKER_HOST` (CLAUDE.md). One `new PostgreSqlContainer('postgres:16-alpine')` per test file. `pnpm --filter <pkg> test <file>`: filter BEFORE the script.

## Review Focus

1. The admin edits Server URL in the editor before the first Add: the row must say `edited: true` (the field stays editable on a directory prefill, `RemoteMcpConnectorForm.tsx:793`). Test: Task 1 #2.
2. A stale tab or buggy client sends junk `fromDirectory`: the connector is still created (201), nothing is recorded, nothing reaches `connectors:upsert`. Test: Task 2 #2.
3. The directory is turned off (`connectorDirectory.enabled: false`) or absent: create and PATCH behave exactly as before. Tests: Task 1 #9, Task 2 #6.
4. Another owner's connector with the same id survives a delete (`idStillLive: true`): the row stays. Test: Task 1 #8.
5. The listing was re-synced to a newer version between prefill and save: the row keeps the prefilled version, so a later "newer version" notice is true. Test: Task 1 #3.

## Design answers (self-answered brainstorm, from code)

- **Identity.** Connector rows are keyed `(owner_user_id, connector_id)` and the delete event has no owner, so rows key on connector id alone and are deleted only on `idStillLive === false` (copy `packages/mcp-oauth/src/plugin.ts:355-384`).
- **Subscriber hook.** `connectors:deleted`. It fires from the admin DELETE and both boot sweeps (`purge.ts`). The directory already inits before connectors, so it hears the boot sweeps. No boot sweep for missed events (it would need `connectors:live-ids` and close a call-graph cycle).
- **Malformed `fromDirectory`.** Ignored: 201, nothing recorded, one info line. A 400 comes only from the existing body rules.
- **`edited` at create.** The route passes the saved single server address as `serverUrl`; the directory sets `edited = serverUrl !== listing.url`. This adds one field to the card's record signature (decisions shard, row 4).
- **Off.** The disabled plugin registers neither hook nor the subscriber. Known residual: a delete while the directory is off leaves a dead-id row (for the reader card).
- **Out of scope.** The "newer version is listed" notice, any read hook, source-change handling, stale-row sweeps.

## Hook contracts (shared by Tasks 1, 2 and 4)

`connectors:directory-provenance-record`
- in `{ connectorId: string (1..128), directoryId: string (1..200), version: string (1..255), serverUrl: string (≤65,536) | null }`, strict (extra keys refused) → out `{ recorded: boolean }`
- schema-invalid → `PluginError` `invalid-payload`, message exactly `'invalid provenance input'`
- `version` fails `isUsableVersion` → `{ recorded: false }`; `directoryId` not in `connector_directory_v1_entries` → `{ recorded: false }`
- otherwise upsert by `connector_id`: `directory_id`, `version` verbatim, `edited = serverUrl !== <entry url>` (a re-save replaces all three) → `{ recorded: true }`

`connectors:directory-provenance-mark-edited`
- in `{ connectorId: string (1..128) }`, strict → out `{ marked: boolean }` (true iff a row matched; never creates one). Invalid → same `invalid-payload` text.

`connectors:deleted` subscriber: non-empty string `connectorId` (else warn and return); `idStillLive !== false` → keep; else delete the row. Never throws, always returns `undefined` (no veto, no payload rewrite).

---

### Task 1: `@ax/connector-directory` — provenance table, two hooks, `connectors:deleted` subscriber `[tier: sensitive]`

**Needs `security-checklist`:** client-originated ids reach a host table; new migration.

**Files:**
- Modify: `packages/connector-directory/src/migrations.ts` (header 4-17, `ConnectorDirectoryDatabase` 42-45, new `CREATE TABLE` after 72)
- Modify: `packages/connector-directory/src/contract.ts` (append)
- Modify: `packages/connector-directory/src/normalize.ts:218` (export `isUsableVersion`; body unchanged)
- Create: `packages/connector-directory/src/provenance.ts`
- Modify: `packages/connector-directory/src/plugin.ts` (header comment, `manifest()` 103-111, enabled `init` 208-245)
- Modify: `packages/connector-directory/src/index.ts`
- Create test: `packages/connector-directory/src/__tests__/provenance.test.ts` (Docker)
- Modify test: `packages/connector-directory/src/__tests__/plugin-config.test.ts`

**Interfaces — Produces** (`contract.ts`, re-exported from `index.ts`): `DIRECTORY_PROVENANCE_RECORD_HOOK`, `DIRECTORY_PROVENANCE_MARK_EDITED_HOOK`, `PROVENANCE_CONNECTOR_ID_MAX = 128`, `PROVENANCE_SERVER_URL_MAX = 65_536` (compared, never stored), `ProvenanceRecordInputSchema` / `ProvenanceRecordOutputSchema` / `ProvenanceMarkEditedInputSchema` / `ProvenanceMarkEditedOutputSchema` (zod, inputs `.strict()`, caps from `limits.ts` `ID_MAX` / `VERSION_MAX`), plus their `z.infer` types. `provenance.ts`:

```ts
export interface ProvenanceStore {
  listingUrl(directoryId: string): Promise<string | null>; // entries.url, null = not in the mirror
  upsert(row: { connectorId: string; directoryId: string; version: string; edited: boolean }): Promise<void>;
  markEdited(connectorId: string): Promise<boolean>;
  remove(connectorId: string): Promise<number>;
}
export function createProvenanceStore(db: Kysely<ConnectorDirectoryDatabase>): ProvenanceStore;
export function recordProvenance(store: ProvenanceStore, ctx: AgentContext, input: unknown): Promise<{ recorded: boolean }>;
export function markProvenanceEdited(store: ProvenanceStore, input: unknown): Promise<{ marked: boolean }>;
export function onConnectorDeleted(store: ProvenanceStore): (ctx: AgentContext, payload: unknown) => Promise<undefined>;
```

Table: `connector_directory_v1_provenance (connector_id TEXT PRIMARY KEY, directory_id TEXT NOT NULL, version TEXT NOT NULL, edited BOOLEAN NOT NULL DEFAULT false)`. Do NOT touch it from `store.reset()` / `useSource()`. Log events: `connector_directory_provenance_ignored` (info, `{ connectorId, reason: 'unknown-listing' | 'unusable-version' }`), `connector_directory_provenance_removed` (info, only when a row went), `connector_directory_provenance_remove_failed` (error, `{ connectorId, ...faultLogFields(err) }`), `connector_directory_provenance_delete_event_skipped` (warn, `{ reason: 'no-connector-id' }`).

- [ ] **Step 1: Write `provenance.test.ts`.** Harness copied from `plugin.test.ts:1-92`: container per file, `boot()` with `syncIntervalMs: 0`, global `fetch` stubbed to throw, `afterEach` closes harnesses and `TRUNCATE connector_directory_v1_entries, connector_directory_v1_sync_state, connector_directory_v1_provenance`. `beforeEach` boots with `createFakeRegistry(() => page([listing({ name: 'app.linear/linear', title: 'Linear', remotes: [remote('https://mcp.linear.app/mcp')] })]))` and runs `plugin.sync()` (expect `outcome: 'ok'`). Helper `row(id)` = `SELECT connector_id, directory_id, version, edited FROM connector_directory_v1_provenance WHERE connector_id = $1` via `pg.Client`. Constants: `ID = 'linear-0a1b2c3d'`, `URL = 'https://mcp.linear.app/mcp'`, `valid = { connectorId: ID, directoryId: 'app.linear/linear', version: '1.0.0', serverUrl: URL }`.
  1. `records a known listing saved with its own address as unedited`: record `valid` → `{ recorded: true }`; `row(ID)` → `{ connector_id: ID, directory_id: 'app.linear/linear', version: '1.0.0', edited: false }`.
  2. `an address changed before the first save is recorded as edited`: `serverUrl: 'https://mcp.linear.app/other'` → `edited: true`; a second id `'linear-11111111'` with `serverUrl: null` → `edited: true`.
  3. `keeps the prefilled version even when the listing has moved on`: `version: '0.9.0'` → `{ recorded: true }`, row `version: '0.9.0'`, `edited: false`.
  4. `an unknown listing, or a version the sync would refuse, records nothing`: `directoryId: 'com.example/nope'` → `{ recorded: false }`; `version: '1.0.0‮'` → `{ recorded: false }`; no row for `ID`.
  5. `input outside the contract is refused`: for each of `null`, `{ ...valid, edited: false }`, `directoryId` of 201 chars, `version` of 256 chars, `connectorId: ''`, `connectorId` of 129 chars, `serverUrl` key missing, `serverUrl: 1` → rejects `{ code: 'invalid-payload', message: 'invalid provenance input' }`; the table is empty afterwards.
  6. `saving again replaces the row, edited included`: record with `serverUrl: 'https://x.example/mcp'`, then `valid` → one row, `{ version: '1.0.0', edited: false }`.
  7. `mark-edited flips an existing row and creates none`: after `valid` → `{ marked: true }`, `edited: true`; `{ connectorId: 'missing-00000000' }` → `{ marked: false }`, still no row for it; `{ connectorId: 1 }` → rejects `invalid-payload`.
  8. `connectors:deleted drops the row only when no live connector keeps the id`: record `ID` and `'other-22222222'`. `bus.fire('connectors:deleted', ctx, p)` with `p = { connectorId: ID, toolNamespaces: [], idStillLive: true }` → `toEqual({ rejected: false, payload: p })`, row kept. Then `null`, `{ idStillLive: false }`, `{ connectorId: ID, idStillLive: 'false' }` → each `rejected: false`, row kept. Then `idStillLive: false` → `{ rejected: false, payload: p }`, `row(ID)` gone, `'other-22222222'` kept. Firing it once more resolves.
- [ ] **Step 2: Run, expect FAIL** (hooks not registered). `pnpm --filter @ax/connector-directory test src/__tests__/provenance.test.ts`
- [ ] **Step 3: Implement** the migration, contract, `isUsableVersion` export, `provenance.ts`, and the plugin wiring. Enabled manifest: `registers: [search, record, mark-edited]`, `calls: ['database:get-instance']`, `subscribes: ['connectors:deleted']`. Register both services with `{ returns: <output schema> }` (same `z.output` typing trick as `SearchAnswer`, `plugin.ts:81-86`) and subscribe, all inside the existing `try` after the migration. The disabled branch is unchanged. Add one line to the plugin header comment: what the hooks do, and that the off mode remembers nothing.
- [ ] **Step 4: Extend `plugin-config.test.ts`.** (9) In `disabled: calls nothing…` assert `harness.bus.hasService(DIRECTORY_PROVENANCE_RECORD_HOOK)` and `…MARK_EDITED_HOOK` are `false`. (10) New pure test `enabled: registers the provenance hooks and hears connector deletes`: `createConnectorDirectoryPlugin({ syncIntervalMs: 0 }).manifest` toEqual `{ name: '@ax/connector-directory', version: '0.0.0', registers: ['connectors:directory-search', 'connectors:directory-provenance-record', 'connectors:directory-provenance-mark-edited'], calls: ['database:get-instance'], subscribes: ['connectors:deleted'] }`.
- [ ] **Step 5: Run, expect PASS:** `pnpm --filter @ax/connector-directory test` and `pnpm --filter @ax/connector-directory build`. "Waited … for a container start slot" is contention: re-run alone.
- [ ] **Step 6: Commit** `feat(connector-directory): remember which listing a connector came from (TASK-1102)`.

### Task 2: `@ax/connectors` — accept `fromDirectory` on create, mark edited on PATCH `[tier: sensitive]`

**Needs `security-checklist`:** a client-supplied field crosses the HTTP trust boundary.

**Files:**
- Create: `packages/connectors/src/directory-provenance.ts`
- Modify: `packages/connectors/src/admin-routes.ts` (header comment 72-110; `create` 656-716; `update` 719-820)
- Modify: `packages/connectors/src/plugin.ts:289-297` (two `optionalCalls` after `connectors:directory-search`)
- Modify test: `packages/connectors/src/__tests__/plugin.test.ts:89-94` (exact manifest pin)
- Create test: `packages/connectors/src/__tests__/directory-provenance-route.test.ts` (no Docker)

**Interfaces — Consumes:** the hook contracts above (strings mirrored, no import). **Produces** (`directory-provenance.ts`):

```ts
export const DIRECTORY_PROVENANCE_RECORD_HOOK = 'connectors:directory-provenance-record';
export const DIRECTORY_PROVENANCE_MARK_EDITED_HOOK = 'connectors:directory-provenance-mark-edited';
export const FROM_DIRECTORY_FIELD_MAX = 256; // UTF-16 code units: a coarse gate; the hook owns the exact caps
export interface FromDirectory { directoryId: string; version: string }
export function parseFromDirectory(value: unknown): FromDirectory | 'malformed' | undefined;
export function soleServerUrl(c: Pick<Capabilities, 'mcpServers'>): string | null;
export function serverAddressesChanged(before: Pick<Capabilities, 'mcpServers'>, after: Pick<Capabilities, 'mcpServers'>): boolean;
export function recordDirectoryProvenance(bus: HookBus, ctx: AgentContext, connector: Pick<Connector, 'id' | 'capabilities'>, from: FromDirectory): Promise<void>;
export function markDirectoryProvenanceEdited(bus: HookBus, ctx: AgentContext, connectorId: string): Promise<void>;
```

Rules: `parseFromDirectory(undefined)` → `undefined`; a plain object (not null, not array) whose own keys are exactly `directoryId` and `version`, each a string of 1..256 → a fresh `{ directoryId, version }`; anything else → `'malformed'`. `soleServerUrl`: exactly one server with a string `url` → that url, else `null`. `serverAddressesChanged`: the ordered lists `mcpServers.map(s => s.url ?? null)` differ (raw strings). The two callers return early when `!bus.hasService(hook)`, send `{ connectorId: connector.id, directoryId, version, serverUrl: soleServerUrl(connector.capabilities) }` / `{ connectorId }`, and catch every throw into a warn `connectors_directory_provenance_failed` `{ connectorId, hook, err: <message> }`.

Route edits. **create:** right after `const raw = …` (line 671): `const fromDirectory = parseFromDirectory(raw.fromDirectory); delete raw.fromDirectory;` and on `'malformed'` log info `connectors_directory_provenance_malformed` with no fields. After a successful upsert, before the response: when `out.created` and `fromDirectory` is a parsed object, `await recordDirectoryProvenance(deps.bus, ctx, out.connector, fromDirectory)`. The 409 pre-check and every error path record nothing. **update:** add `delete patchRaw.fromDirectory;` beside `delete patchRaw.id;` (line 763). After `logCuration(…)`, when `serverAddressesChanged(existing.capabilities, out.connector.capabilities)`, `await markDirectoryProvenanceEdited(deps.bus, ctx, existing.id)`.

`optionalCalls` degradation strings (exact, also in `plugin.test.ts`):
- record: `'a connector set up from the directory saves normally, but nothing remembers which listing it came from (no @ax/connector-directory loaded, or it is turned off)'`
- mark-edited: `'a connector whose address is changed by hand saves normally, but its directory listing record is not marked as edited (no @ax/connector-directory loaded, or it is turned off)'`

- [ ] **Step 1: Write `directory-provenance-route.test.ts`.** Bare `HookBus` like `directory-route.test.ts:58-89`. Stubs: `auth:require-user` → `{ user: { id: 'root', isAdmin: true } }`. `connectors:get` throws `PluginError` `not-found` (create), or returns `{ connector: STORED, ownerUserId: 'root' }` with `STORED.canEdit = true` (PATCH). `connectors:upsert` pushes its input to `upserts` and returns `{ connector: <built from the input>, created: input.createOnly === true }`, and can be set to throw. The provenance stubs push to `records` / `marks`, can throw, and `null` means not registered. Handlers: `createConnectorRouteHandlers({ bus, mode: 'admin' })`. Fixtures: `caps(url = 'https://mcp.linear.app/mcp')` = one http server named `linear-0a1b2c3d`; `BODY = { connectorId: 'linear-0a1b2c3d', name: 'Linear', usageNote: 'Use it for issues.', keyMode: 'personal', capabilities: caps() }`; `FROM = { directoryId: 'app.linear/linear', version: '1.0.0' }`.
  1. `POST with fromDirectory writes the hand-entered connector, then records the listing`: create `{ ...BODY, fromDirectory: FROM }` and, on a fresh setup, `BODY` → both 201. The two `upserts[0]` are deep-equal, and neither has a `fromDirectory` key. `records` → `[{ connectorId: 'linear-0a1b2c3d', directoryId: 'app.linear/linear', version: '1.0.0', serverUrl: 'https://mcp.linear.app/mcp' }]` (the hand-entered run: `[]`). The response `connector` has no `fromDirectory`.
  2. `a malformed fromDirectory is ignored: created, nothing recorded`: for each of `'app.linear/linear'`, `null`, `[]`, `{ directoryId: 'app.linear/linear' }`, `{ ...FROM, edited: false }`, `{ directoryId: 'x'.repeat(257), version: '1.0.0' }`, `{ directoryId: '', version: '1.0.0' }`, `{ directoryId: 1, version: '1.0.0' }` → 201, `records` `[]`, no `fromDirectory` in the upsert input. Edge: `directoryId: 'x'.repeat(256)` IS forwarded (`records` has one entry).
  3. `an otherwise invalid body is still a 400 from the existing rules`: upsert throws `invalid-payload` `'name is required'` → 400 `{ error: 'name is required' }`, `records` `[]`.
  4. `a taken id is a 409 and records nothing`: `connectors:get` returns a live connector → 409 `{ error: 'connector-id-taken' }`, `upserts` and `records` `[]`.
  5. `a provenance failure never fails the create`: record throws → 201 with `{ connector, created: true }`.
  6. `without the directory, create and PATCH behave as before`: provenance stubs `null` → POST `{ ...BODY, fromDirectory: FROM }` → 201, no `fromDirectory` in the upsert input. PATCH `{ capabilities: caps('https://mcp.linear.app/v2') }` → 200. Nothing throws.
  7. `PATCH that changes a server address marks the record edited`: `{ capabilities: caps('https://mcp.linear.app/v2') }` → 200, `marks` `[{ connectorId: 'linear-0a1b2c3d' }]`.
  8. `PATCH of only the name or usage note marks nothing`: `{ name: 'Linear (team)', usageNote: 'x', capabilities: caps() }` → 200, `marks` `[]`.
  9. `a refused PATCH marks nothing`: upsert throws `invalid-payload` → 400, `marks` `[]`.
  10. `a mark failure never fails the PATCH`: mark throws → 200.
  11. `PATCH drops a fromDirectory field`: `{ name: 'Linear', fromDirectory: FROM }` → no `fromDirectory` in the upsert input; `records` and `marks` `[]`.
  12. `serverAddressesChanged / soleServerUrl` (pure): same list → false; changed url, added server, removed server, swapped order → true; both missing url → false. `soleServerUrl`: one server → its url; zero, two, or one without `url` → null.
- [ ] **Step 2: Update the `plugin.test.ts` manifest pin** with the two `optionalCalls` entries (exact strings above). Run both files and expect FAIL: `pnpm --filter @ax/connectors test src/__tests__/directory-provenance-route.test.ts src/__tests__/plugin.test.ts`.
- [ ] **Step 3: Implement** `directory-provenance.ts`, the route edits, and the manifest entries (with a TASK-1102 comment like the TASK-1100 one at line 289). Add 2-3 lines to the admin-routes header: POST may carry `fromDirectory`, which never becomes part of the connector.
- [ ] **Step 4: Run, expect PASS:** the command above, then `pnpm --filter @ax/connectors test` (Docker) and `pnpm --filter @ax/connectors build`.
- [ ] **Step 5: Commit** `feat(connectors): pass directory provenance to the directory on create and address edits (TASK-1102)`.

### Task 3: channel-web — send `fromDirectory` with a directory save `[tier: mechanical]`

**Files:**
- Modify: `packages/channel-web/src/components/settings/RemoteMcpConnectorForm.tsx:571-577`
- Modify: `packages/channel-web/src/lib/connectors.ts:146-153` (new type), `:176-179` (`createConnector`), `:503-508` (stale JSDoc)
- Modify test: `packages/channel-web/src/components/settings/__tests__/RemoteMcpConnectorForm.test.tsx:626-633`, `:546`, `:691`

**Interfaces — Produces:** the wire field `fromDirectory: { directoryId: string; version: string }` on `POST /admin/connectors`, only when the save started from a directory prefill (Task 2 reads it). `export type ConnectorCreateInput = ConnectorUpsertInput & { fromDirectory?: { directoryId: string; version: string } }`; `createConnector(input: ConnectorCreateInput, base)`.

- [ ] **Step 1: Tests.** At 626-633: drop the "TASK-1102 adds…" comment; the keys become `['capabilities', 'connectorId', 'fromDirectory', 'keyMode', 'name', 'usageNote']`; add `expect(create.body.fromDirectory).toEqual({ directoryId: key.id, version: key.version })`. After line 546 (request prefill): `expect(create.body).not.toHaveProperty('fromDirectory')`. After line 691 (hand-entered): `expect(writes[0]!.body).not.toHaveProperty('fromDirectory')`.
- [ ] **Step 2: Run, expect FAIL** (keys): `pnpm --filter @ax/channel-web test src/components/settings/__tests__/RemoteMcpConnectorForm.test.tsx`
- [ ] **Step 3: Implement.** Add `...(prefill?.fromDirectory ? { fromDirectory: prefill.fromDirectory } : {})` to `input`. The edit path never sends it: `prefill` is undefined whenever `connector` is set (line 135). Replace the JSDoc at 503-508 with: "Set only by `prefillFromDirectoryEntry`: the directory listing this editor was filled from. Its presence switches the editor's copy from a request's to the directory's. Opaque: never shown or edited. It isn't part of the connector: the create body carries it beside the connector's fields, and the server hands it to the directory, which remembers it in its own table (TASK-1102)."
- [ ] **Step 4: Run, expect PASS,** then `pnpm --filter @ax/channel-web build` (its tsc also checks test files).
- [ ] **Step 5: Commit** `feat(channel-web): send the directory listing with a connector saved from it (TASK-1102)`.

### Task 4: Preset canary, preset pins, stale docs `[tier: integration]`

**Files:**
- Modify test: `presets/k8s/src/__tests__/connector-directory-composition.test.ts`
- Modify test: `presets/k8s/src/__tests__/preset.test.ts:1244-1262`
- Modify: `presets/k8s/src/index.ts:550-551` (comment)
- Modify: `docs/plans/2026-11-09-mcp-directory-connectors-design.md:68-74, 143-147`

**Interfaces — Consumes:** Task 1 (table, hooks, subscriber) and Task 2 (route) through the real plugins. `pg` (already a preset devDependency, see `connector-delete-composition.test.ts:95-100`).

- [ ] **Step 1: Composition tests.** Generalize `callRoute` to `(method, path, { query?, params?, body? })`, where `body` becomes `Buffer.from(JSON.stringify(body))`, and update the two existing calls. Add `provenanceRows(id)` via `pg.Client` on `pgContainer.getConnectionUri()`. Use `actor = { id: 'admin-1', isAdmin: true }` and start each new test with `await directory!.sync()`. Body: `connectorId: 'linear-0a1b2c3d'`, `name: 'Linear'`, `keyMode: 'personal'`, one http server `{ name: 'linear-0a1b2c3d', transport: 'http', url: 'https://mcp.linear.app/mcp', allowedHosts: [], credentials: [] }`, empty top-level lists, `packages: { npm: [], pypi: [] }`.
  - `create from the directory records provenance; an address edit marks it; delete removes it (TASK-1102)`: POST with `fromDirectory: { directoryId: 'app.linear/linear', version: '1.0.0' }` → 201, and the response `connector` has no `fromDirectory`. Rows → `[{ connector_id: 'linear-0a1b2c3d', directory_id: 'app.linear/linear', version: '1.0.0', edited: false }]`. `SELECT capabilities::text FROM connectors_v1_connectors WHERE connector_id = $1` does not contain `app.linear/linear`. PATCH `/admin/connectors/:id` (`params: { id }`) `{ name: 'Linear (renamed)' }` → 200, `edited` still false. PATCH with the url `'https://mcp.linear.app/v2'` → 200, `edited: true`. DELETE → 204, rows `[]`.
  - `a hand-entered connector records no provenance`: the same POST for `'hand-1a2b3c4d'` without `fromDirectory` → 201, rows `[]`.
- [ ] **Step 2: Preset pins.** In `loads the connector directory disabled…`: `expect(dir!.manifest.subscribes).toEqual([])`, and connectors' `optionalCalls` hooks `toEqual(expect.arrayContaining(['connectors:directory-search', 'connectors:directory-provenance-record', 'connectors:directory-provenance-mark-edited']))`. In `connectorDirectory.enabled turns the sync on…`: `registers` toEqual the three hooks (search first), `subscribes` toEqual `['connectors:deleted']`. Do NOT touch `PLUGINS_TO_DROP` or prod-bootstrap's list (the plugin set is unchanged).
- [ ] **Step 3: Run, expect PASS:** `pnpm --filter @ax/preset-k8s test src/__tests__/connector-directory-composition.test.ts src/__tests__/preset.test.ts`
- [ ] **Step 4: Stale lines (rule 5).**
  - Design doc line 69-70: change "(where it lives: see Open questions)" to "(where it lives: Resolved question 4)". After "marks it edited" add "An address changed in the editor before the first save counts too."
  - Lines 146-147: replace "Exactly which subscriber hook to use gets settled when the card is planned." with "It subscribes to `connectors:deleted` and drops the row only when no live connector still carries the id (`idStillLive: false`): connector ids are unique per owner, not across owners."
  - `presets/k8s/src/index.ts:550-551`: "`enabled` only decides whether it syncs" becomes "`enabled` decides whether it syncs and whether it remembers which connectors were set up from it".
- [ ] **Step 5: Commit** `test(preset-k8s): directory provenance canary; docs: settle the provenance subscriber (TASK-1102)`.

---

## Whole-branch gate

`pnpm build && pnpm lint`, then `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts` (CLAUDE.md: the recursive run alone skips two suites). Run a whole-branch review against the merge base before opening the PR.

## PR notes (paste into the description)

**Boundary review — `connectors:directory-provenance-record({ connectorId, directoryId, version, serverUrl }) → { recorded }`**
- Alternate impl: a provenance store for a static curated list baked into an air-gapped deployment (checks its own list), or one over a subregistry mirror.
- Leaky names: none. `directoryId` / `version` are opaque listing identifiers, never parsed (no `io.github`, `_meta`, `remotes`). `serverUrl` is the connector's remote address, the same concept as `entry.url` in the existing search contract, which every directory source lists. No storage vocabulary.
- Wire surface: no IPC action. `POST /admin/connectors` gains one optional body field `fromDirectory: { directoryId, version }`. The route gates it, strips it before `connectors:upsert`, and translates it after a successful create into this payload. `connectorId` and `serverUrl` come from the stored connector, never the body.

**Boundary review — `connectors:directory-provenance-mark-edited({ connectorId }) → { marked }`**
- Alternate impl: the same curated-list store, or one keeping an edit history. Leaky names: none. Wire: none new; called by `PATCH /admin/connectors/:id` after a committed edit changed a server address.

**Subscriber — `@ax/connector-directory` on `connectors:deleted` (payload unchanged)**
- Reads only `connectorId` and `idStillLive` (both backend-neutral) and ignores `toolNamespaces`. Missing or non-boolean `idStillLive` keeps the row (keep data when unsure). Returns `undefined`: no veto, no rewrite for later subscribers.

**Security review (sketch; run `security-checklist` for the final text)**
- Sandbox: No new reach. A host-only admin route and the directory's own table; no fs, network, process or env change; the sandbox never sees provenance.
- Injection: `fromDirectory` is client-supplied (an authenticated admin's browser, still untrusted). The route accepts exactly two non-empty strings of at most 256 code units and keeps them out of the connector write. The hook re-validates strictly (caps 200/255, the sync's version rule refusing bidi, control and lone-surrogate characters), stores `directoryId` only if it exists in the mirror, and uses parameterized Kysely queries. `edited` and `connectorId` are server-computed. Nothing is rendered or sent to a model, and the values are never logged or echoed in a response. A malformed value is ignored, never a 400, and the write path is unchanged.
- Supply chain: N/A: no `package.json` or lockfile change.

**Half-wired check.** The rows are write-only until the "a newer version is listed" follow-up, as the design (Resolved question 3) sequenced it. Both hooks and the subscriber have production callers here, and provenance can only be captured at save time, so recording has to start first.

**Departures from the card.** (1) The record hook takes a fourth field, `serverUrl`, so an address changed before the first save records `edited: true` (decisions shard, row 4). (2) `ConnectorPrefill.fromDirectory` already existed (TASK-1101); only `submit()` changes. (3) The subscriber copies `@ax/mcp-oauth`'s `connectors:deleted` handler; it makes no ctx-routed call, so it builds no ctx. (4) PATCH also strips `fromDirectory`.

**For the reader card.** Treat a row as a hint for a live connector you are already showing. Rows from deletes while the directory was off can outlive their connector, and a registry source change keeps old rows.
