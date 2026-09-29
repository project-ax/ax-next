# TASK-697: a user-authored connector must not read a company-wide credential

## Problem (measured by probe, 2026-09-29)

A connector's credential ref is `account:<connectorId>` (or `account:<connectorId>:<SLOT>`
for a connector with two or more slots). `credentials:get({ref, userId})` walks user, then
agent, then **global** scope and never asks which connector the ref came from. So a signed-in
non-admin who creates a connector with the same id as a company-keyed one gets the company key
(`account:zendesk` at `global`), with `keyMode: 'personal'` through `/settings/connectors` or
`keyMode: 'workspace'` through the un-gated `/admin/connectors` (TASK-698 gates that route; this
card must not depend on it landing first).

Every connector resolves under the chat user (`connectors:resolve(userId = ctx.userId, id)`), so
the attacker's own connector joins every one of their sessions with no attach step.

## Shape

`credentials:get` keeps the fixed user -> agent -> global chain, with one change: for an
`account:` ref, the **global** step is taken only if a provider of
`credentials:authorize-global:account` says the requesting user may read that ref. No provider
registered, provider returns anything but `{allowed: true}`, or provider throws: skip global
(fail closed). Other ref namespaces (`provider:`, `mcp:`, `skill:`, `routine:`) are unchanged.

`@ax/connectors` registers the provider. It allows iff:

1. the ref parses as `account:<id>` or `account:<id>:<SLOT>` with a valid connector id,
2. the requesting user owns a live (not soft-deleted) connector with that id,
3. `deriveCredentialPlan(connector)` contains an entry with exactly this ref at `scope: 'global'`
   (that is, `keyMode: 'workspace'`; one function decides both the ref and the scope), and
4. `auth:get-user(owner).isAdmin === true` (optional call; missing, null, throwing = deny).

Boundary review (new service hook):

- Alternate impl: an org/RBAC plugin that authorizes company keys by team membership instead of
  connector ownership.
- Payload field names that might leak: none (`userId`, `ref` in; `allowed` out).
- Subscriber risk: none, it is a service hook with one registrant, not a subscriber event.
- Wire surface: not an IPC action.

## Tasks

1. `@ax/credentials`: the guard in `doResolve` and unit tests (`account-global-guard.test.ts`).
   Load-bearing: this is the enforcement point. The hook is deliberately NOT declared in the
   credentials manifest (`calls` or `optionalCalls`): `@ax/connectors` already has an optional edge
   into credentials (`credentials:delete`), so declaring the reverse edge makes core's call graph
   report a cycle and bootstrap throws. It is reached with `bus.hasService`, like
   `credentials:resolve:<kind>`; a test boots a provider shaped like connectors to pin that.
2. `@ax/connectors`: the provider hook (`credential-authz.ts`), types/schema, registration,
   provider unit tests, and the end-to-end regression adapted from the probe
   (`credential-scope-authz.test.ts`, real routes + real store + real vault). Load-bearing.
3. Comments that said the wrong thing (`credential-plan.ts`, `refs.ts`, the `plugin.ts` resolve
   comment), the connectors manifest and k8s preset pins, memory shards, and the PR body with
   the security-checklist note.

Not in this card: the admin gate on `/admin/connectors*` (TASK-698), host binding of credentials
at the proxy (TASK-687), `agent`-scope rows, `mcp-oauth`'s `clientSecretRef` (TASK-712: an OAuth
slot may now name only `account:<its own connector id>:<tag>`, checked at `connectors:upsert` and
again in `mcp-oauth`'s `begin`, so this guard is what decides what a global-scope step does with it).

## Prod read-only check (2026-09-29, ids only)

5 users (1 admin). The admin owns every workspace-keyed connector (`zendesk` with two slots,
`canopy-docs`, `example-com`, and a soft-deleted `salesforce`); the only global `account:` rows are
`account:zendesk:ZENDESK_API_TOKEN`, `account:zendesk:ZENDESK_EMAIL` and `account:salesforce`. The
one non-admin connector owner has two personal connectors (`linear`, `linear-direct`) with
user-scope keys and no global row of the same ref. So no live connector changes behaviour: the fix
denies nothing that resolves today except the hole itself.
