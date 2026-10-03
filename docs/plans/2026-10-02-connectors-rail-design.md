# Connectors rail: replace the "rules" tab with connectors + per-tool permissions

**Status:** approved design, 2026-10-02 (Vinay). Decomposed into board cards, `epic: connectors-rail`.
**Visual spec (source of truth for layout and copy):** Figma, AX-Components, page "Workspace · current UI",
section "Rules tab redesign — connectors + abilities":
https://www.figma.com/design/NrQ1AjWE6L2Op9NlsV3mOP/AX-Components?node-id=56-3169

| Frame | Node |
|---|---|
| 1 · Default (list, error icon + hover tooltip, Other abilities) | `55:1903` |
| 2 · Row menu (⋯ open on an errored row) | `55:2177` |
| 3 · Connector details (per-tool Allow / Ask / Deny) | `56:1903` |
| 4 · Add connector (auth first, then attach) | `56:2176` |
| 5 · Empty | `56:2398` |

The old frame is `AX/AgentRail / rules` (`38:3925`); it stays as the "before".

## Why

The current tab ("What it may do alone") lists static policy rules and grants. It is noisy and
does not answer the question a non-technical person has: *what can my agent reach, is it working,
and what may it do there without asking me?* The redesign answers exactly that.

## What the person sees (summary; Figma is authoritative)

- **Tab:** lucide `Plug` icon, tooltip "Connectors". No panel title.
- **Connectors `<n>` + "+ Add".** One card; each row is the connector name and a `⋯` menu.
  An errored row shows a red `CircleAlert` icon after the name. Its reason is a shadcn `Tooltip`
  on hover **and keyboard focus**: "Sign-in expired" or "Can't reach it". The fix lives in the
  `⋯` menu: **Reconnect** (sign-in expired) or **Retry** (unreachable), shown only on errored rows,
  then View details, Edit connector, separator, **Remove from `<agent>`** (destructive).
- **Other abilities:** icon + label + `Switch` rows: Web search, Read web pages, Run code.
  Caption "Changes apply to `<agent>` only."
- **Details subview** (in-rail, "‹ Connectors" back + `⋯`): name, "Connected · signed in as you",
  "What `<agent>` may do · N tools", icon legend (check = Allow, hand = Ask first, ban = Deny), tools
  grouped "Looks things up" / "Makes changes" ("Others may see these"), each row a 3-option
  icon segmented control. The list scrolls; "Edit connector" / "Remove" footer is pinned.
- **Add subview:** "Add a connector", one-line intro, search, "Available `<n>`" rows with
  **Sign in** / **Add key** / **Add**. Pending sign-in row: spinner + Cancel. Footer: "Don't see the
  one you need? Ask a workspace admin to set it up."
- **Empty:** dashed card, plug icon, "No connectors yet", primary "Add connector".

All UI uses the channel-web shadcn install and semantic tokens (invariant #6). Segmented control =
shadcn `toggle-group` (add via CLI if missing). Selected tints: Allow `primary-soft`/`primary`,
Ask `warning-soft`/`warning`, Deny `destructive-soft`/`destructive`.

## Product decisions (Vinay, 2026-10-02)

1. **Admin sets per-tool defaults when defining a connector.** Whoever can edit the connector
   (workspace admin for shared/workspace connectors; the author for a private one) sets each tool to
   Allow / Ask first / Deny in the connector editor (Settings › Connectors). Pre-filled suggestion
   when nothing is set: tools the server marks `readOnlyHint: true` → Allow, everything else → Ask first.
2. **Agents copy those defaults on attach and may only tighten.** Admin Deny → the user cannot pick
   Ask or Allow. Admin Ask → the user may pick Ask or Deny, not Allow. Admin Allow → any.
3. **Unattended runs wait.** A tool set to Ask first in a routine produces a queued decision; the
   routine cannot use it on that run. The control says so in its help text.
4. **Owners may remove a workspace-default connector from their own agent** (per-agent exclusion;
   the connector and other agents are untouched).
5. **Built by auto-ship** from the cards below.

### Assumptions made while writing this (flag if wrong)

- **Effective verdict = strictest of (static tool-policy rule, admin connector default, agent choice).**
  The agent's choice is snapshotted from the admin default at attach (decision 2: "copy"), so an
  admin *loosening* a default later does not silently loosen agents already using the connector,
  while an admin *tightening* applies to every agent immediately (it is a ceiling).
  **As built (TASK-737 + TASK-754).** The copy also records each of the connector's tool namespaces
  as *copied* for the agent (`tool_policy_v1_agent_copied_namespaces`). A tool under a copied
  namespace with no row of its own is held (Ask first), so a tool that had **no default** when the
  agent got the connector stays Ask first after the editor first sets Allow; the person may then pick
  Allow themselves (the live default is still the ceiling). **Default-on (workspace) connectors**,
  which never attach, are copied by the orchestrator at the agent's first session that sees them
  (`onlyIfNotCopied: true` — first sight only, never overwrites a row). Before that first session such
  an agent follows the live default. An explicit attach re-copies (overwriting copied rows, never a
  person's own choice). `list-agent-overrides` returns `copiedNamespaces` so the rail shows the held
  verdict rather than the live default.
- **A connector tool with no admin default and never inventoried → Ask first.** Today it runs
  unasked (`tool-policy` no-match default `allow`); this closes that hole for connector tools only.
- **Ability toggles** are agent-level tighten-only overrides on `web_search`, `web_extract`, `Bash`.
  Off = `deny`. They can never loosen a static rule (e.g. SDK `WebFetch` stays denied).
- **Workspace-keyed connectors are hidden from non-admins in Add** (attach is admin-only for them today).
- **The full capability list (the old `Permissions` disclosure) stays reachable** behind a
  "See everything it can do" link that opens a `Dialog`, and approved-capability grants keep a Revoke
  path (see "What moves" below). Nothing that can only be revoked from the old tab is lost.

## Architecture

### Corrections to earlier assumptions (verified at `45c03ba4`)

- `connector-union.ts:217-222` no longer folds *every* owner connector: since #835, step 3 skips
  `requiresAttachment` / `canEdit:false` connectors. Effective set = workspace defaults + per-agent
  attachments + the owner's legacy connectors.
- Connector MCP tools reach the gate as `mcp__<spec.name>__<tool>` (claude-sdk passes them through,
  `agent-claude-sdk-runner/src/tool-names.ts:148-152`), **not** `mcp.<id>.<tool>`; nothing maps a
  call back to a connector id. The aisdk runner does not load `.mcp.json` at all.
- Agent owners can already attach (`agents/src/admin-routes.ts:875`); only workspace-keyed
  connectors are admin-only (`:448-475`).
- There is no real reachability probe (connectors probe is admin-only and offline,
  `connectors/src/admin-routes.ts:182-206`); the OAuth status route can trigger a refresh
  (`mcp-oauth/src/routes.ts:756`), so per-row status today would cost N refreshes per render.
- No MCP tool annotations are read anywhere; nothing host-side lists a connector's tools.

### 1. Canonical connector tool key

`@ax/connectors` derives a short stable alias per (connectorId, serverName) (e.g. `c<hash10>`,
short for the 64-char tool-name limit) and returns it as `toolNamespace` on `connectors:resolve`.
The orchestrator keys `.mcp.json` by it; the claude-sdk runner normalizes `mcp__<ns>__<tool>` →
`mcp.<ns>.<tool>`. **toolKey = `mcp.<toolNamespace>.<tool>`** everywhere (policy, inventory, UI).

### 2. Tool inventory

`connectors:describe-tools {userId, agentId?, connectorId}` →
`{status: 'ok'|'unreachable'|'needs-auth'|'unknown', tools: [{name, title, description, readOnly: boolean|null, outward: boolean|null, toolKey}], checkedAt}`.
Implemented in `@ax/mcp-client` (http transport `tools/list` through the credential path), cached
(~15 min TTL) in a table it owns. stdio connectors return `unknown`. `readOnly` = `readOnlyHint`,
`outward` = `destructiveHint || openWorldHint`. **Hints are untrusted server self-description:
they choose pre-filled defaults and grouping, never a security claim.** Descriptions are fenced like
the rail's `theirDescription`. SSRF guard + response-size caps (security-checklist required).
Grouping: `readOnly === true` → "Looks things up", else "Makes changes"; `outward` → "Others may see these".

### 3. Verdict store + enforcement (`@ax/tool-policy`, single source of truth)

Tables: `tool_policy_v1_connector_defaults(connector_id, tool_name, verdict, updated_by, updated_at)`
and `tool_policy_v1_agent_overrides(agent_id, tool_key, verdict, origin 'snapshot'|'user', updated_by, updated_at)`.
Host-internal service hooks (never IPC actions):

- `tool-policy:set-connector-defaults {connectorId, verdicts: [{tool, verdict}]}` /
  `tool-policy:get-connector-defaults {connectorId}`
- `tool-policy:set-agent-override {agentId, toolKey, verdict | null}` — rejects a verdict looser
  than the current ceiling (`ceiling-violation`).
- `tool-policy:list-agent-overrides {agentId}` → `{overrides: [{toolKey, verdict, ceiling, origin}]}`
- `tool-policy:snapshot-connector-for-agent {agentId, connectorId, toolNamespace}` (called on attach).
- Subscribes to `agents:deleted` (purge overrides) and connector deletion (purge defaults).

`evaluate()` takes the agent's overrides + connector ceilings; effective = strictest. Per-agent
in-memory cache, invalidated on write (the `tool:pre-call` path has a 10 s ceiling). **Store-read
failure fails closed to `hold`** for any `mcp.*` key and the three ability tools, never to `allow`.
Accepted keys: `mcp.*` and `{web_search, web_extract, Bash}`; anything else is rejected.
Authz lives in the routes (`agents:resolve` + `assertWriteAllowed`; connector defaults require
`canEdit` on the connector).

Boundary review: alternate impl = a per-tenant policy service (OPA-style); leaky field names: none
(`toolKey` is opaque, `hold` is existing hook vocabulary); subscriber risk: none.

Session open (`orchestrator.ts` ~1878): `list-agent-overrides`; denied host tools are filtered out of
the catalog and `Bash` deny goes to the runner's `disallowedTools` via `AgentConfig`, so the model is
not offered tools it will be refused. Do **not** use `allowedTools` (empty = unrestricted).
Turning off Run code breaks skills that run scripts; the Switch help text says "Some skills won't work."

### 4. Effective connector list, attach, detach

`connectors:list-effective {userId, agentId, attachmentIds, exclusions}` →
`[{summary, source: 'default'|'attached'|'legacy-owned'}]`; the orchestrator's
`resolveEffectiveConnectors` switches to it (one implementation). New per-agent
`connectorExclusions` (agents store). Atomic `agents:attach-connector` / `agents:detach-connector`
(the current set-whole-list hook can lose a concurrent edit), with `workspaceConnectorGrantViolation`
moved into the hook so every route enforces it. Remove: `attached` → detach; `default` /
`legacy-owned` → exclusion. Remove also revokes that connector's approved-capability grants.

Workspace routes (`channel-web/src/server/routes-workspace.ts`, all gated by `agents:resolve`):
`GET /api/workspace/agents/:id/connectors` → `{connectors: [{id, name, source, health, removable}], abilities: {webSearch, readPages, runCode}, available: [...]}`;
`POST …/connectors {connectorId}`; `DELETE …/connectors/:cid`; `GET …/connectors/:cid/tools`;
`PUT …/connectors/:cid/tool-verdicts {toolKey, verdict}` (as built, TASK-742: nested so the key is bound to that connector's namespaces); `PUT …/abilities`.

### 5. Health without N probes

`health` comes from stored state only: an `mcp-oauth` `needs_reconnect` marker written when the
refresh is rejected (`resolver.ts:111`), read via a new non-refreshing `mcp-oauth:status-batch`; and
reachability from the inventory cache `status`. Only Reconnect / Retry trigger a fresh check, one
connector at a time.

### 6. Add flow

Available = `connectors:list` minus the effective set (non-admins don't see workspace-keyed ones).
Sign in → `ConnectorOAuthConnect agentId showAccessNotice={false}`, `onConnected` → attach. Add key →
`ConnectorConnectDialog`, `onConnected` → attach. Ready → attach directly. **Attach happens only after
auth succeeds.** If attach fails after sign-in, show the error + Retry. The Add subview renders
`<ConnectorAccessNotice kind="attach">` (the `connector-access-coverage.test.ts` scan requires it).
When Ask first exists, `lib/connector-access-copy.ts` "without asking you each time" is no longer
universally true: update the copy and deliberately update its pinned `asking` count test.

### What moves (nothing load-bearing is dropped)

- Approved-capability grants were revocable **only** from the rail (`routes-workspace.ts:5293`,
  `skills:approved-caps-revoke`): connector-subject ones move into the details view ("Access you
  approved" + Revoke); skill-subject ones go in a collapsible "Granted by you" under Other abilities
  (reuse `Grants` / `GrantLine`).
- Site grants are also revocable in Settings (`RememberedSitesPanel`); no change.
- The `Permissions` list (H4 disclosure, incl. the `unrestrictedTools` banner) → "See everything it
  can do" `Dialog` linked from the Other abilities caption.
- Tab id `rules` → `connectors`; keep `rules` parsing as an alias in `workspace-route.ts`.

## Slices (cards; deps in brackets)

1. **Canonical connector tool names** — `toolNamespace`, `.mcp.json` key, runner normalization. [none]
2. **Connector tool inventory** — `connectors:describe-tools` in mcp-client + cache + security checklist. [1]
3. **Verdict store + tighten-only enforcement** — tool-policy tables, hooks, evaluate precedence,
   fail-closed, cache, purge, session-open filtering. [1]
4. **Admin per-tool defaults in the connector editor** — Settings segmented control per tool,
   pre-fill from hints, snapshot-on-attach. [2, 3]
5. **Rail tab swap + Other abilities** — Plug tab, abilities Switches + route, Grants/H4 moved, `rules` alias. [3]
6. **Connector list + remove** — list-effective, exclusions, atomic attach/detach, row menu, empty state. [5]
7. **Add flow** — Available list, auth-then-attach, access notice. [4, 6]
8. **Connector health** — needs-reconnect marker, status batch, error icon + tooltip, Reconnect/Retry. [2, 6]
9. **Details view per-tool permissions** — segmented icons, groups, scroll, ceiling-disabled options
   with "Your admin set this to …" tooltip, revoke approved access, access-copy update. [3, 4, 6]
10. **(walk) Connectors rail acceptance on kind** — Playwright against the cluster, all five frames. [7, 8, 9]

Each slice is fully wired and reachable (invariant #3), adds tests for every new behavior, and
runs the security checklist where it touches policy, IPC, credentials or untrusted tool metadata.
