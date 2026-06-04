# TASK-153 — fold connector `services` capability → sandbox:open-session

Epic: dev-services-in-sandbox. Deps TASK-150/151/152 all merged: descriptor field
exists on `OpenSessionInputSchema`, both backends render `services[]`. This card
folds each attached **connector's** `capabilities.services` onto the
`sandbox:open-session` payload, mirroring the existing hosts/packages/mcpServers folds.

Half-wired window stays OPEN (closes at the S7 canary) — note in PR.

## Invariants honored
- **I3** — load plumbing exists in both presets already (validator-service in CLI+k8s;
  both sandbox backends render `services[]`). This PR adds payload construction only.
- **I8** — only services from admin-approved connectors are forwarded (the existing
  `connectors:resolve` live-table wall gives this for free; a pending connector
  resolves to nothing → zero services).
- **I11** — capabilities live on connectors.
- **I12** — no cross-plugin imports: descriptor type from `@ax/sandbox-protocol`
  (`ServiceDescriptorParsed`, already a type-only dep), connector shape mirrored
  structurally per I2.

## Tasks (independent, testable)

### Task 1 — `connector-union.ts`: add `services` to the mirror + fold (TDD)
- Add `services?: ServiceDescriptorParsed[]` to `ConnectorCapabilities` (optional, so
  existing fixtures compile) + the `ConnectorsResolve*`/`ListDefaults` mirrors carry it
  implicitly via `capabilities`.
- Add `services: ServiceDescriptorParsed[]` to `FoldConnectorResult`.
- In `foldConnectorCaps`, collect each connector's `capabilities.services ?? []` into a
  `byName` Map keyed by service `name`. On a cross-connector `name` collision, throw a
  new exported `ConnectorServiceCollisionError`.
- Tests (in `connector-union.test.ts`):
  - a connector with a `services` cap → `services` present on fold result.
  - no connectors / no services → `services: []`.
  - same connector listing the same name twice → idempotent (one entry) — actually
    a single connector's own list is the connector author's concern; dedupe within a
    connector too (last-wins is fine within ONE connector since it's one author) — but
    a CROSS-connector collision throws.
  - two connectors declaring the same service `name` → throws
    `ConnectorServiceCollisionError`.

### Task 2 — `orchestrator.ts`: thread folded services onto the payload (TDD)
- After the `foldConnectorCaps` call, take `connectorFold.services`.
- If non-empty AND `bus.hasService('services:validate')`, call it; a non-`clean`
  verdict → hard stop (throw inside the try below).
- Wrap the fold call + validate in a try/catch (the fold can throw the collision
  error). On catch → `terminated` outcome `reason:'connector-services-invalid'`,
  `fireTurnError`, `chat:end`, return. (Same shape as the proxy-open-failed path.)
- Thread `...(services.length > 0 ? { services } : {})` onto `sandboxInput`.
- Tests (in `orchestrator.test.ts`):
  - a connector with a service → `sandbox:open-session` payload carries `services`.
  - no connectors → `services` omitted from payload.
  - cross-connector collision → terminated outcome, no sandbox:open-session call.
  - the fold runs under the real owner ctx (no synthetic-actor spy).

## YAGNI pass
- No new hook surface (payload construction only) → no manifest `calls` change, no
  boundary review needed. `services:validate` stays a hasService-gated peer.
- No new dep (sandbox-protocol type-only import already present).

## Security
Capability → privileged payload: run `security-checklist`. Confirm fold reads only
active/approved connectors (I8), services re-validated at the wire by both backends.
