# TASK-131 — Allowed sites: own section + proactive add

**Epic:** settings-unified (`docs/plans/2026-06-01-settings-unified-skills-connectors-credentials-design.md`, decision §7, surface design line 107-108).
**Depends on:** TASK-127 (#283, merged) — ConnectorsTab carries the allowed-sites block verbatim.
**Branch:** `auto-ship/TASK-131-allowed-sites-section`.

## Problem

Allowed sites is a revoke-only `Card` at the bottom of `ConnectorsTab.tsx` (carried
verbatim by TASK-127). TASK-131 promotes it into its **own section** with a proactive
**"Add a site"** affordance alongside revoke, and adds the missing **POST add HTTP
route** so the UI can grant a host (`host-grants:grant`).

## What already exists (verified against code)

- `host-grants:grant/list/revoke` service hooks (host-internal; `@ax/host-grants`).
  `store.grant` already validates the host (`assertValidHost`), caps at 256/agent, and
  is idempotent.
- `GET /api/chat/allowed-sites/:agentId` (list) + `DELETE .../:agentId/:host` (revoke)
  already exist in `routes-connections.ts` with auth → `agents:resolve` ACL (404) →
  server-forced `ownerUserId`. The **POST add route does NOT exist** — the only current
  caller of `host-grants:grant` is the reactive-wall `routes-allow-host.ts` persist branch.
- Client wrappers `getAllowedSites` / `revokeAllowedSite` in `lib/connections.ts`. No
  `addAllowedSite` wrapper yet.

## Tasks (independent, testable)

### Task 1 — POST add route in the Connections BFF (server)
- Add `addAllowedSite(req, res)` to `makeConnectionsHandlers` in
  `packages/channel-web/src/server/routes-connections.ts`, mirroring `revokeAllowedSite`:
  auth → `agents:resolve` ACL (404) → server-forced `ownerUserId` → `host-grants:grant`.
- Body: `{ host: string }` parsed from `req.body`; `400 invalid-body` on malformed JSON
  or missing host.
- The authoritative host validation + cap is the `host-grants` store. Map store errors:
  `invalid-host` → `400 invalid-host`; `grant-limit` → `409 grant-limit`. (Mirror the
  allow-host route's PluginError-code → status mapping.)
- `hasService('host-grants:grant')` gate: degrade to `503 host-grants-unavailable`
  (the add cannot succeed without the store, unlike revoke which is idempotent-204).
  Decision: surfacing 503 is honest (no silent success); a preset without host-grants
  never reaches this in production (k8s preset has it).
- Add `HostGrantsGrantInput`/`Output` local interfaces (no cross-plugin import, I2).
- Register the route in `server/plugin.ts`:
  `{ method: 'POST', path: '/api/chat/allowed-sites/:agentId', handler: connections.addAllowedSite }`,
  add `host-grants:grant` to `optionalCalls` with a degradation note.
- Tests (`__tests__/server/routes-connections.test.ts`): success 201/200 + server-forced
  ownerUserId + host from body; 404 for inaccessible agent; 401 unauth; 400 invalid body;
  invalid-host → 400; grant-limit → 409; missing-store → 503. Register a
  `host-grants:grant` spy in `beforeEach`.

### Task 2 — `addAllowedSite` client wrapper (channel-web lib)
- Add `addAllowedSite(agentId, host): Promise<{ created: boolean }>` to
  `lib/connections.ts`, POSTing `{ host }` with `writeHeaders` (CSRF) +
  `credentials: 'include'`. Throw on non-2xx.

### Task 3 — Allowed sites = own section with proactive Add (UI)
- In `ConnectorsTab.tsx`, reshape the trailing allowed-sites block into its **own
  section**: keep the agent `Select`, add an **"Add a site"** row above the list — an
  `Input` (host) + `Add` `Button`. On submit: call `addAllowedSite(agentId, host)`,
  clear the input, reload the list. Surface the route error (e.g. invalid host) inline
  near the input (not the page-level Alert) so the user sees why an add failed.
- Per-row `Revoke` stays. shadcn primitives + semantic tokens only (invariant #6).
- Update the section comment (drop the "TASK-131 will move this" note).
- Tests (`ConnectorsTab.test.tsx`): add-a-site happy path (input → Add → addAllowedSite
  called with agentId+host → list reloads); add error shows inline; revoke still works.

## Security (card-required `security-checklist`)

The add path takes a **browser-supplied host string that widens egress reach** — the one
real attack surface here. Walk:
- **Who can add:** only an authenticated user, for an agent they own/can access
  (`agents:resolve` ACL → 404, no existence leak). `ownerUserId` is SERVER-FORCED from
  the auth cookie — never from the request body (no IDOR). CSRF-gated (`x-requested-with`).
- **Server-side enforcement (no client-only gate):** the host is validated server-side
  by `host-grants` `assertValidHost` (exact-match hostname regex, no wildcards/ports/
  schemes), capped at 256/agent. The client `Input` is convenience only; the wall is the
  store. A persisted grant only ever loads into a FUTURE session's allowlist at open —
  it cannot widen a live session out of band (mirror property, design P6).
- **Untrusted text rendering:** hosts render through React text nodes (auto-escaped);
  never raw HTML.
- **Capability minimization:** reuses existing host-internal `host-grants:grant`; no new
  service-hook signature; no new IPC action (the untrusted runner can never reach this).

## Boundary review

- **No new service-hook signature.** Reuses `host-grants:grant/list/revoke`.
- **New HTTP route** `POST /api/chat/allowed-sites/:agentId` — schema (body `{host}`)
  lives in the route plugin's own directory (`routes-connections.ts`), per boundary rule.
- Path prefix stays `/api/chat/allowed-sites/*` (as-built BFF convention); the design's
  `/settings/allowed-sites` is the logical surface name. Renaming would churn the
  sibling list/revoke routes + the concurrent TASK-129 rebase.

## YAGNI

All three tasks load-bearing at MVP (route+wrapper+UI = the half-wired-policy triple:
ship the route only with its consumer). No dead code.
