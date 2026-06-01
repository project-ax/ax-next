# TASK-132 — Add-a-key: Service dropdown (connectors + Custom…) + per-slot fields + friendly labels

**Epic:** settings-unified (`docs/plans/2026-06-01-settings-unified-skills-connectors-credentials-design.md`, card #9)
**Depends on:** TASK-124 (per-slot credential refs — MERGED).

## Problem

Today the Credentials tab "Add a key" form has a free-text Service field (slugified to
`account:<service>`) + a single Value. It's connector-unaware: a user must already know
the right service slug, and a multi-slot connector (e.g. an MCP server declaring
`CLIENT_ID` + `CLIENT_SECRET`) can't be configured here at all.

Rework "Add a key" to be connector-aware:
1. Service becomes a **dropdown** of the user's existing connectors + a **"Custom…"**
   free-text fallback.
2. **Custom…** behaves exactly as today: free-typed name → `account:<service>` single Value.
3. Selecting a **connector** reveals its declared slots via the TASK-124 derivation
   (`deriveCredentialPlan`): a single-slot connector collapses to one Value; a multi-slot
   connector shows one labeled field per slot.
4. Each per-slot field carries a **friendly label**: the slot `description` as the label,
   `<MACHINE_NAME> · <mechanism hint>` as mono subtext. Mechanism hint is truthful per
   mechanism: stdio MCP → "env var"; http MCP → "header"; Direct API → "request auth".
5. Provider/model API keys are untouched (separate Default-AI-model surface).

## Key facts (verified against code)

- `lib/connectors.ts` already exports `listConnectors()` (→ `ConnectorSummary[]`, metadata
  only), `getConnector(id)` (→ full `Connector` with `capabilities`), and the TASK-124
  derivation `deriveCredentialPlan(connector)` → `ConnectorCredentialPlanEntry[]` with
  structured `{slot, scope, ref, service, slotTag?}`. **Do NOT string-parse refs** — build
  `{kind:'account', service, slot: slotTag}` from the structured fields.
- `KeysTab.tsx` `addAccountKey(service, payload, slot?)` already threads the optional slot
  into the `account` destination (TASK-124). Reuse it verbatim for both Custom and
  per-slot writes.
- A connector's mechanism is connector-level (the admin registry form treats it as a single
  leading `mcpServers[0]`): `capabilities.mcpServers[0]?.transport === 'stdio'` → env var;
  `=== 'http'` → header; **no mcpServers** → Direct API → request auth. Same model
  `ConnectorRegistry.tsx` uses.
- `deriveCredentialPlan` reads `connector.capabilities.credentials` (top-level slots) and
  collapses on `credentials.length` (1 = collapsed `account:<service>`; ≥2 = per-slot).
  The slot's `description` lives on the matching `connector.capabilities.credentials[i]`.
- `Select` shadcn primitive is installed; `Sheet`/`Input`/`Label`/`Button`/`Alert` already
  used in this file. Match the file's existing Sheet+Label+Input idiom (FieldGroup/Field
  is NOT installed — don't introduce it for one form).
- The connect dialog (`ConnectorConnectDialog`) already does a near-identical per-slot
  render for the CONNECT path. This card is the analogous render for the manual
  ADD-A-KEY path. (Different surface: connect uses keyMode-derived scope + consent gate;
  add-a-key is always the user's own `scope:'user'` vault, no consent gate — you're
  storing your own key.)

## Tasks

### Task 1 — Mechanism-hint helper + per-slot derivation in `lib/connectors.ts` (or KeysTab-local)
- Add a small pure helper `mechanismHint(connector): 'env var' | 'header' | 'request auth'`
  in `lib/connectors.ts` (co-located with the other connector derivations), keying on
  `capabilities.mcpServers[0]?.transport` (stdio→env var, http→header, none→request auth).
  Exported + unit-tested (it's a truthful-per-mechanism security-relevant label).
- TEST FIRST: `__tests__/connectors-credential-plan.test.ts` (or a sibling) — assert the
  three mechanism cases.

### Task 2 — Rework `AddByServiceSheet` → connector-aware service picker
- Replace the free-text Service `Input` with a `Select`:
  - One `SelectItem` per `ConnectorSummary` (value = connector id, label = `c.name`).
  - A `"Custom…"` `SelectItem` (a sentinel value) at the bottom.
- State machine inside the sheet:
  - **Custom selected** → render the free-text name Input (today's `toServiceSlug` path) +
    single Value Input → `addAccountKey(slug, value)`. UNCHANGED behaviour.
  - **Connector selected** → `getConnector(id)` to load capabilities, then
    `deriveCredentialPlan(full)`:
    - render one field per plan entry. Each field: label = slot `description` (fall back to
      a calm default if absent), mono subtext = `<MACHINE_NAME> · <mechanismHint>`, a
      password Value Input.
    - On save, for each entry with a non-empty value, call
      `addAccountKey(entry.service, value, entry.slotTag)`.
- Loading + error states for the `getConnector` fetch (reuse `humanError`/Alert idiom).
- `listConnectors()` loaded once when the sheet opens (or on KeysTab mount, passed down).
- Empty connector list → the dropdown still offers Custom… (back-compat: a user with no
  connectors gets exactly today's flow, just one extra click). Consider defaulting the
  selection to Custom… when there are no connectors so the common case is unchanged.

### Task 3 — Tests (channel-web `__tests__/KeysTab.test.tsx`)
- Service dropdown lists the user's connectors + a Custom… option.
- Custom… path still writes `{kind:'account', service:<slug>}` single Value (existing tests
  stay green; add explicit "Custom selected" coverage).
- Single-slot connector → one Value field; save writes `account:<service>` (no slot).
- Multi-slot connector → one labeled field per slot; each save threads `slotTag` →
  `account:<service>:<slot>`; the per-slot WRITE never collapses to `account:<service>`.
- Friendly label: slot `description` rendered as label; `<MACHINE_NAME> · <hint>` subtext;
  hint truthful for stdio (env var) / http (header) / direct (request auth).
- No raw secret value rendered; password input type.
- `listConnectors`/`getConnector` mocked via `vi.spyOn(connLib, …)`.

### Task 4 — Pre-PR gate + security note
- `pnpm -F @ax/channel-web build` (channel-web tsconfig type-checks `__tests__`), run the
  package's OWN vitest binary from inside the worktree, lint.
- security-checklist note for the credential write path: untrusted browser-supplied secret
  values + service/slot selection. Server forces scope=user + ownerId; refs/slots render
  through React text nodes (escaped); slot names come from the user's OWN connector
  capabilities (already validated server-side at connector upsert). No new wire surface
  (reuses `setDestinationCredential`).

## YAGNI pass
- No new wire surface, no new hook, no new HTTP route — reuses `listConnectors`,
  `getConnector`, `deriveCredentialPlan`, `addAccountKey`/`setDestinationCredential`. All
  load-bearing.
- `mechanismHint` is the only new exported helper — load-bearing (the card's friendly-label
  requirement). Keep it tiny + tested.
- Do NOT touch ConnectorConnectDialog or the connect path — different surface, out of scope.
- Do NOT add per-connector filtering of which connectors appear (all the user's connectors
  are valid add-a-key targets). No search box (the list is short; the connect tab has the
  app-store search — not this surface).

## Invariant / boundary notes
- #2 no cross-plugin imports: `mechanismHint` is local to `channel-web/lib/connectors.ts`
  (the established mirrored-copy posture). No `@ax/connectors` runtime import.
- #6 one UI language: shadcn `Select` + existing Sheet/Label/Input/Button/Alert + semantic
  tokens only.
- No new service-hook signature → no boundary-review table needed.
