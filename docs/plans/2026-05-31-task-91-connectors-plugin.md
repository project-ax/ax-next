# TASK-91 — @ax/connectors plugin: table, manifest schema, connectors:* hooks

**Card:** PVTI_lADOD4dXMc4BYpfZzguUB7s
**Epic:** connectors-first-class
**Design:** `docs/plans/2026-05-31-connectors-first-class-design.md` (Phase 1)
**Branch:** `auto-ship/TASK-91-connectors-plugin`

## Goal

Introduce the first-class `Connector` object backed by its own
`connectors_v1_*` Postgres table, exposed via five mechanism-agnostic
`connectors:*` service hooks. This OPENS the half-wired window by design:
the connector store exists but nothing routes through it yet; the skill
`capabilities` block stays authoritative. The plugin is fully registered +
tested + reachable (so it is NOT a half-wired plugin in the invariant-#3
sense — only its *consumer* lands in later phases).

Scope (resolved in card Clarifications — NOT re-litigated):
- Wire into the **k8s preset ONLY** (local CLI is Postgres-free; connectors
  need `database:get-instance`, so loading in the CLI would crash bootstrap —
  same reason skills/routines/conversations are CLI-absent).
- Keep the spec'd `connectors_v1_*` **Postgres** table (NOT sqlite).

## Shape

`Connector = { id, name, description, usageNote, keyMode, visibility } + Capabilities`

- `keyMode: 'personal' | 'workspace'`
- `visibility: 'private' | 'shared'`
- `Capabilities` (allowedHosts / credentials / mcpServers / packages) is
  TYPE-imported from `@ax/skills-parser` (the only allowed @ax/* type import
  for this plugin per the eslint allow-list). Zod schema re-declared LOCALLY
  (no runtime cross-plugin import — invariant #2).

Five hooks:
- `connectors:list` — list metadata-only descriptors for the owner.
- `connectors:get` — fetch one full connector (metadata + spec) by id.
- `connectors:upsert` — create/update a connector (idempotent by id).
- `connectors:delete` — soft-delete a connector by id.
- `connectors:resolve` — resolve a connector id to its mechanism-agnostic
  spec descriptor (the future routing entry point).

## Boundary review

- **Alternate impl:** `@ax/connectors-sqlite` for single-replica dev — same
  `connectors:*` hooks, same shapes. (Mirrors conversations/conversations-sqlite.)
- **Leaky fields:** none in the hook surface. `transport`/`command`/`stdio`/
  `url`/`mcp` live ONLY inside the `Capabilities` spec object, never as
  first-class hook fields. `keyMode`/`visibility`/`usageNote` are
  storage-agnostic.
- **Subscriber risk:** subscribers must key off the connector `id` + declared
  `credentials`/`allowedHosts`, never "is this MCP?" — a connector's backing
  mechanism can change without its identity changing.
- **Wire surface:** in-process service hooks only; no IPC action this card
  (`install_authored_connector` lands in design Phase 2).

## Security

Touches plugin loading (new manifest) + a new credential-slot surface
(connector spec carries `credentials: CapabilitySlot[]`). The store NEVER
holds secret values — only slot *references* (the `slot`/`account` names),
identical to the skills capability block today. Run `security-checklist`.

## Tasks

1. **Scaffold `@ax/connectors` package** — package.json (deps: @ax/core,
   @ax/skills-parser, kysely, zod; devDeps mirror conversations), tsconfig.json
   (references core + skills-parser), src/index.ts barrel. pnpm-workspace
   already globs `packages/*`.

2. **types.ts** — `Connector`, `KeyMode`, `Visibility`, the per-hook
   Input/Output types, zod return schemas (`GetOutputSchema`,
   `ListOutputSchema`, `UpsertOutputSchema`, `DeleteOutputSchema`,
   `ResolveOutputSchema`) + a local `CapabilitiesSchema` (zod) that validates
   the type-imported `Capabilities` shape.

3. **migrations.ts** — `runConnectorsMigration(db)` creating
   `connectors_v1_connectors` (owner_user_id, connector_id, name, description,
   usage_note, key_mode CHECK, visibility CHECK, capabilities JSONB,
   deleted_at, created_at, updated_at; PK (owner_user_id, connector_id);
   partial owner index excluding tombstones) + `ConnectorsRow` /
   `ConnectorDatabase` row types.

4. **scope.ts** — `scopedConnectors(db, { userId })` baking
   `WHERE owner_user_id = ? AND deleted_at IS NULL`. Add `connectors_v1_` to
   the eslint `no-bare-tenant-tables` TENANT_TABLE_PREFIXES.

5. **store.ts** — `createConnectorStore(db)` with list/get/upsert/delete +
   boundary validators (validateName/Description/UsageNote/KeyMode/Visibility +
   CapabilitiesSchema parse). Bound strings; CHECK-mirrored enums validated at
   the boundary so a bad value surfaces as a structured invalid-payload error,
   not a raw pg error.

6. **plugin.ts** — `createConnectorsPlugin()`: manifest (registers the 5 hooks,
   calls `['database:get-instance']`), init runs the migration + registers the
   5 hooks with `returns` schemas. resolve = spec-descriptor resolution.

7. **Tests (TDD)** — package tests: migrations, store CRUD + resolve (real
   PostgreSqlContainer), scope isolation, manifest shape, return-schema
   validation, leak-guard (no transport/command/url/mcp as first-class hook
   fields).

8. **Wire into k8s preset** — add dep to `presets/k8s/package.json`, push
   `createConnectorsPlugin()` in `presets/k8s/src/index.ts`, add reachability
   assertion in `preset.test.ts`, add `@ax/connectors` to `PLUGINS_TO_DROP` in
   BOTH `acceptance.test.ts` + `multi-tenant-acceptance.test.ts`.

## Verification

`pnpm build` (tsc), `pnpm test --filter @ax/connectors`,
`pnpm test --filter @ax/preset-k8s` (full — catches PLUGINS_TO_DROP /
verifyCalls breaks the per-file run misses), lint changed files.
