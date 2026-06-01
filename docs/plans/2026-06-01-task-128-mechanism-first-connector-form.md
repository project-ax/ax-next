# TASK-128 — Mechanism-first connector form

Epic: settings-unified. Reshapes the shared connector form (`lib/connector-form.ts`)
+ the inline admin-curation `ConnectorEditDialog` into a **mechanism-first** form:
a segmented picker (MCP server / Direct API / Command-line tool) up top that
reshapes the visible fields. Removes the "Advanced — how it connects" disclosure.
Adds an npm/pypi package field (Command-line tool) and **structured credential
slot rows** (description + machine name + optional account) replacing the
comma-string. Makes the dialog the **shared** component for admin curation AND
user authoring (admin-only fields hidden + visibility forced private for users).

## Predecessor learnings folded in
- TASK-127: form logic lives in `lib/connector-form.ts` (single source of truth) +
  `ConnectorEditDialog` (the inline admin-curation Dialog). Reshape THOSE, not the
  orphaned `ConnectorRegistry.tsx`. Self-connect reuses `ConnectorConnectDialog`
  verbatim — DO NOT touch it (consent copy pinned by `connectors-credential-plan.test.ts`).
- TASK-124: structured slot rows must produce `ConnectorCredentialSlot {slot, kind:'api-key', description?, account?}`; `deriveCredentialPlan` consumes that shape — NO string-parsing of refs. `deriveCredentialPlan`/`accountRef` in `lib/connectors.ts` are unchanged.
- TASK-126: ConnectorsTab admin curation is gated `isAdmin`. The user-authoring path is the SAME dialog with `isAdmin=false`.

## Data shapes (unchanged, server-validated)
`ConnectorCapabilities = { allowedHosts: string[], credentials: ConnectorCredentialSlot[], mcpServers: ConnectorMcpServerSpec[], packages: { npm: string[], pypi: string[] } }`.
`ConnectorCredentialSlot = { slot, kind:'api-key', description?, account? }`.
`ConnectorMcpServerSpec = { name, transport:'stdio'|'http', command?, args?, env?, url?, allowedHosts, credentials }`.

## Mechanism model
`Mechanism = 'mcp' | 'direct-api' | 'cli'` (new field on `ConnectorFormState`).
- **mcp** → builds leading `mcpServers[0]`: stdio (`command`+`args`) or http (`url`); secrets are the credential slots (env for stdio, headers for http — labelled, not stored differently). NO `packages`.
- **direct-api** → no mcpServer, no packages; top-level `allowedHosts` + credential slots (key(s), proxy-injected).
- **cli** → `packages.{npm|pypi}=[name]` + top-level `allowedHosts` + credential slots (env secrets). "Downloadable binary" folds here (no fourth type).

**Inference on edit** (`formFromConnector`): packages present → `cli`; else leading mcpServer present → `mcp`; else → `direct-api`.

**Round-trip discipline**: `capabilitiesFromForm` MERGES onto `baseCapabilities` so un-surfaced fields (beyond-first mcpServer, beyond-first package, inner mcpServer env/hosts/creds) are preserved on edit; switching mechanism CLEARS the now-irrelevant fill for the chosen mechanism (e.g. choosing direct-api drops the leading mcpServer + packages it no longer represents) while leaving beyond-first untouched.

## Tasks

### Task 1 — connector-form.ts: mechanism model + structured slot rows + package field (pure, test-first)
File: `packages/channel-web/src/lib/connector-form.ts` + `lib/__tests__/connector-form.test.ts`.
- Add `export type Mechanism = 'mcp' | 'direct-api' | 'cli'`.
- Add `export interface CredentialSlotRow { slot: string; description: string; account: string }` + `emptySlotRow()`.
- `ConnectorFormState`: add `mechanism: Mechanism`; replace `credentialSlots: string` → `credentialSlots: CredentialSlotRow[]`; add `packageRegistry: 'npm'|'pypi'`; `packageName: string`. Keep `transport/command/args/url/allowedHosts/baseCapabilities`.
- `emptyConnectorForm()`: `mechanism:'mcp'`, `credentialSlots:[]`, `packageRegistry:'npm'`, `packageName:''`.
- `formFromConnector(c)`: infer mechanism; read leading mcpServer (mcp), leading package (cli); map `credentials` → rows (`{slot, description:s.description??'', account:s.account??''}`); fill `packageRegistry`/`packageName` from first non-empty registry.
- `capabilitiesFromForm(form)`: build per mechanism (see model). Map rows → `ConnectorCredentialSlot[]` dropping empty-`slot` rows; include `description`/`account` only when non-empty (exactOptionalPropertyTypes). Preserve beyond-first mcpServers/packages from base.
- Keep `splitList` (allowedHosts comma-string stays), `connectorIdFromName`, `summaryToForm`.
- Rewrite the unit tests for the new shapes: empty form defaults, mechanism inference (all 3), row round-trip incl. description/account, package build npm+pypi, mechanism-switch clears the other fill, beyond-first preservation, slotless connector.

### Task 2 — ConnectorEditDialog.tsx: mechanism-first UI + structured rows + npm/pypi + isAdmin variant (test-first)
File: `packages/channel-web/src/components/settings/ConnectorEditDialog.tsx` + its test.
- Add prop `isAdmin: boolean`. When false: hide Sharing (`visibility`) + default-on; force `visibility:'private'` in the submit body (and on reset). When true: keep both.
- Replace the Advanced disclosure with a top-of-form **ToggleGroup** mechanism picker (MCP server / Direct API / Command-line tool). Switching mechanism updates `form.mechanism` only — derivation handles field reshaping.
- Per-mechanism fields:
  - mcp: transport Select (stdio/http) → command+args OR url; credential slots (label "Secrets (env vars / headers)").
  - direct-api: allowed hosts + credential slots (label "API key(s)").
  - cli: package picker (registry Select npm/pypi + package name Input) + allowed hosts + credential slots (label "Secrets (env vars)").
- Structured slot rows UI: per-row description Input + machine-name Input (mono) + optional account Input + remove button; an "Add secret/key" button appends `emptySlotRow()`. Compose with existing primitives (Button/Input/Label) — same div+Label pattern the file already uses.
- Drop `ChevronRight/ChevronDown` + `showAdvanced` state. Keep the create/edit/error/submit flow.
- Tests: mechanism picker reshapes fields (mcp shows transport, cli shows package picker, direct-api shows neither); a CLI connector submits `packages.npm=[name]`; structured rows submit `credentials` with description/account; `isAdmin=false` hides Sharing+default-on and forces `visibility:'private'`; `isAdmin=true` shows them; create/edit/error paths still pass. The old "Advanced disclosure" test is removed.

### Task 3 — ConnectorsTab.tsx: pass isAdmin to the shared dialog (wire-in) + test
File: `packages/channel-web/src/components/settings/ConnectorsTab.tsx` + its test.
- Pass `isAdmin={isAdmin}` to `<ConnectorEditDialog>`. (The tab already gates the "New connector"/Edit buttons on `isAdmin`; this card keeps that gate — user-authoring entry points are TASK-129. The dialog being shared-and-ready is what this card delivers; passing the flag is the wiring that proves the variant works through the tab.)
- Verify ConnectorsTab test still green; add/adjust an assertion if needed.

### Task 4 — Pre-PR gate + security note
- `pnpm build && pnpm test --filter @ax/channel-web` + lint (scope eslint to changed files).
- security-checklist PR note: untrusted browser-supplied connector specs (hosts/commands/package names/secrets-slot-names), egress+exec posture of the CLI path; all flows to owner-scoped `/admin/connectors` which forces owner + validates `capabilities` server-side; no secret values in the form (slot names only).

## YAGNI pass
- Single package per connector (not a list) — matches the design's "package name" singular field; beyond-first preserved from base. ✓ load-bearing.
- env vs header storage: design says label only ("Truthful per mechanism"); slots store identically — no separate storage. ✓ avoids dead grammar.
- User-authoring ENTRY points (own-connector New/Edit for non-admins) — deferred to TASK-129 per card scope ("shared component … used by users to author"); this card makes the component shared+variant-ready. Not building the non-admin entry button.
