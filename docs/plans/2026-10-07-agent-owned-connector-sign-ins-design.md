# Agent-owned connector sign-ins: admins define, every agent signs in as itself

**Status:** design approved in conversation 2026-10-07 (Vinay); this spec awaits review.
Builds on `2026-10-02-connectors-rail-design.md` and `2026-10-03-user-added-connectors-design.md`.
Where those conflict with this doc, this doc wins.

## Why

We want agents that act as **digital employees**: agent 1 reads and sends mail as
bob@canopyworks.com, agent 2 as alice@canopyworks.com, even when one person owns both.

Today that's impossible. A sign-in on a *personal* agent is stored on the **person**
(`mcp-oauth/src/routes.ts:411`, `credScope = team ? 'agent' : 'user'`), and the vault always
looks up `user → agent → global` (`credentials/src/plugin.ts:757`). So every personal agent
a person owns shares one account per connector, and the rail's Add list skips sign-in when
the person already has one (`routes-workspace.ts:4060-4087`).

Team agents already store their sign-in on the agent, but a member's own personal sign-in
overrides it for that member's chats (user beats agent). Under the digital-employee model,
that's a bug.

## Decisions (owner, 2026-10-07)

1. **The account belongs to the agent.** Whoever adds a connector to an agent signs in once;
   every chat and routine on that agent acts as that account. An agent never falls back to
   the chatter's own account.
2. **Every agent owns its sign-ins.** Adding a connector to any agent always means signing
   in for that agent. No per-person, cross-agent sign-in exists any more. (This reverses the
   2026-06 Phase 2 "connect once for all my agents" decision.)
3. **Team agents follow the same rule.** One account per connector, used by every member. A
   team admin who signs in as themselves makes every member's chats act as them.
4. **Only admins define connectors.** Personal Settings loses its Connectors page; Admin
   gains **Connectors**. People add admin-defined connectors to agents from the agent rail.
5. **Signing in is part of Add.** A failed or cancelled sign-in adds nothing.
6. **API keys:** a key the admin fills in at creation is shared by every agent. A key left
   blank is entered per agent at Add. This is fixed at creation (today's TASK-827 rule).
7. **No choice step, no hints.** Add opens the provider popup directly. The authorize URL
   always carries `prompt=select_account`; signing out of the provider to use another
   account is up to the person.
8. **Row menu:** Edit (the details view, with editable permissions) and Remove, plus
   **Sign in again** only on a row whose sign-in is needed (expired or missing).
9. **Migration:** everyone signs in again. Existing non-admin connectors are deleted.
10. **Site lists** move unchanged to a new **Settings › Sites** page. Merging them is
    TASK-886 (Backlog), not this project.

## What people see

### Admin › Connectors

- The existing connector editor and list, admins only. Sign-in method: **OAuth** (with an
  optional admin OAuth app — client id + secret), **API key**, or **none**.
- API key field hint: "Leave blank to have each agent add its own key." Once created, the
  editor shows either "Shared key: ••••, Replace" or "Each agent adds its own key."
- All-or-nothing for multi-field keys: the admin fills in every key field or none.
- **Awaiting approval:** connectors an agent proposed with `connector_propose` land here,
  admins only. Approving creates a regular shared connector owned by the approving admin.
  The tool's reply to the agent becomes "I've asked a workspace admin to approve it."

### Settings (personal)

- **Connectors** is removed from the personal nav.
- New **Sites** page hosting `AllowedSitesPanel` and `RememberedSitesPanel`, unchanged.

### Agent rail › Connectors

- **+ Add** lists admin-defined connectors not already on this agent:
  - OAuth → **Add** opens the provider popup directly.
  - Per-agent API key → key form; saving is the Add.
  - Shared key / no auth → adds immediately.
  - The Add subview keeps `<ConnectorAccessNotice kind="attach">` (coverage test).
- **Rows** show the account: "Gmail · bob@canopyworks.com" when the provider told us,
  else "Signed in by Vinay on Oct 7". Provider text is rendered as a React text node,
  length-capped, never used for access decisions.
- **Row menu:** Edit, Remove; **Sign in again** first when sign-in is needed. Sign in
  again opens the popup and replaces only the sign-in — attachment and per-tool
  permissions stay. If the account changed, the row says "Now bob@… (was alice@…)".
- **Remove** detaches and deletes that agent's sign-in/keys, reconnect marker and
  approved access for the connector.
- **Who may act:** personal agent → its owner; team agent → a team admin (TASK-798/813,
  unchanged). Members see who the agent acts as, with no actions.
- The "Retry" item for unreachable servers is dropped; the next chat retries.

## Architecture

### 1. Credential storage and lookup (`@ax/credentials`)

| What | Scope after |
|---|---|
| OAuth sign-in (personal or team agent) | `agent` |
| Per-agent API key | `agent` |
| Shared API key | `global` |
| Admin OAuth client secret | `global` |

- **Lookup:** for `account:` refs, `findRow` walks **agent → global** and never the user
  scope. Other refs (`provider:`, `skill:`, `routine:`) keep `user → agent → global`.
- **Writes:** `credentials:set` refuses an `account:` ref at user scope. One chokepoint, so
  no route can recreate person-level connector credentials.
- **Read authz unchanged:** `credentials:authorize-agent:account` (TASK-711) still requires
  the sole shared definition and the connector being effective on the agent. With
  admin-only definitions every connector qualifies; it stays as defense in depth.
- **New hook `credentials:purge-account {connectorId?, scopes}` → `{purged}`:** tombstones
  `account:<id>` and `account:<id>:*` rows (or, with no `connectorId`, every `account:` row)
  across all owners, only in the listed `scopes` (each `user` or `agent`; `global` is
  refused — a connector's company key is its own key, purged by ref via
  `credentials:delete`). Used by shared-connector delete (`agent`) and the migration
  (`user`).

### 2. Sign-in flow (`@ax/mcp-oauth`)

- `begin` **requires** `agentId` (missing → 400). Scope is always `agent`. The no-agentId
  callers (`AgentConnectors.tsx:636-653` member re-sign-in, `ConnectorConnectDialog.tsx`
  OAuth slot) are removed.
- Authorize URL always includes `prompt=select_account`; for the Google issuer,
  `prompt=select_account consent` (today's `consent` + `access_type=offline` kept,
  `oauth-flow.ts:250-256`). OAuth servers must ignore unknown params (RFC 6749 §3.1); the
  kind walk against real Linear confirms.
- **Identity capture**, best effort, after token exchange:
  - If the AS metadata lists `openid` (and `email`) in `scopes_supported`, request them.
  - Take `email` (else `preferred_username`, else `sub`) from the `id_token` received
    directly from the token endpoint over TLS (display only, so no signature check is
    needed per OIDC Core §3.1.3.7), else from the `userinfo_endpoint` if advertised.
  - Store `{account: string|null, signedInBy: userId, signedInAt}` in the token blob.
    `account` is capped (e.g. 254 chars), control characters stripped.
- **`mcp-oauth:status-batch`** is keyed per agent only and returns
  `{connected, needsReconnect, account, signedInBy, signedInAt}` per connector.
- **Removed:** `mcp-oauth:remove-personal-sign-in`, the user-keyed `needs_reconnect` table
  usage (agent table only), the user-scope status probe.

### 3. All-or-nothing Add

- **OAuth:** the callback, after a successful token exchange, does in order:
  1. write the token at agent scope;
  2. `agents:attach-connector`;
  3. seed starting tool verdicts (`tool-policy:snapshot-connector-for-agent`).

  If 2 or 3 fails, delete the token from 1 and report the error to the popup. Pending state
  records whether this is an **Add** (do all three) or a **Sign in again** (step 1 only;
  the connector must already be attached).
- **Crash between steps** leaves a token for a connector that isn't on the agent:
  unreadable (authz requires attachment) and overwritten by the next Add. Token-first is
  deliberate; attach-first could leave a visible half-added connector.
- **API key:** `POST /api/workspace/agents/:id/connectors {connectorId, keys?}` stores keys
  at agent scope then attaches, with the same compensation.
- This also fixes the possible existing bug where the attach gate can't see a fresh team
  sign-in before attach (it no longer runs as a separate step).

### 4. Admin-only connectors (`@ax/connectors`, channel-web)

- Delete the non-admin write routes (`/settings/connectors`) and their client code/tests.
- `connectors:install-authored` proposals are listed and approved by admins only. The
  approve dialog writes keys per decision 6, never at user scope.
- `keyMode` stored value `personal` → `agent` (migration renames rows). `workspace`
  unchanged. Change after creation stays refused.
- Nav: `USER_NAV` drops `connectors-user`, gains `sites`; `ADMIN_NAV` gains `connectors`
  ("Connectors"). `ConnectorsTab` becomes admin-only; site panels move to `SitesTab`.

### 5. Cleanup

- **Connector delete:** detach from every agent, `credentials:purge-account`, delete every
  agent's reconnect marker and tool-policy rows for it. (Today only the definition goes,
  `connectors/src/purge.ts:57-85`.)
- **Agent delete:** `deleteAgent` already purges agent-scope credentials
  (`agents/src/plugin.ts:862-876`); add an mcp-oauth `agents:deleted` purge of
  `needs_reconnect_agent` rows, and fix the comment that disagrees with the code.
- **Rail remove:** deletes this agent's rows only. #964's `signOutIfUnused` is deleted.

### 6. Routines

When a routine fire skips a connector (TASK-806 presence skip, or needs-reconnect), the
routine row records it beside `lastStatus`/`lastError` (e.g. a `lastWarning`): "Gmail isn't
signed in on Bob, so this run went without it." The Routines UI shows it.

### 7. Migration (one-time, idempotent, at boot)

1. Delete every non-admin-owned connector, using connector-delete cleanup (§5).
2. Delete every `account:` row at user scope (tokens, per-person keys, user-scope client
   secrets, header keys) and every row in the user-keyed `needs_reconnect` table.
3. Rename `keyMode personal` → `agent`.
4. Team-agent rows are untouched.

Afterwards, personal-agent connectors show **Sign-in needed → Sign in again**. An admin
whose client secret was stored on themselves sees the existing "Re-enter the client
secret" editor notice.

**Main is not deployable mid-epic:** deploy only after slice 5 (see Slices).

## Boundary review

- **`mcp-oauth:status-batch` gains `account`, `signedInBy`, `signedInAt`.** Alternate impl:
  a vault-backed or API-key store answering "who is this credential for" (`account: null`).
  Leaky names: none. Subscriber risk: none (service hook, one caller).
- **New `credentials:purge-account {connectorId?, scopes}`** (scopes ⊆ `user`|`agent`).
  Alternate impl: a KMS/vault backend deleting by tag. Leaky names: none. Subscriber risk: none.
- **Removed:** `mcp-oauth:remove-personal-sign-in`.
- **Changed semantics:** `account:` refs no longer resolve at user scope; `begin` requires
  `agentId`. No payload field changes.

## Security

- The core guarantee — an agent never acts as the chatter — rests on the lookup skipping
  user scope for `account:` refs and the write refusal. Both get dedicated tests.
- The admin OAuth client secret stays host-side only (TASK-797 rules unchanged).
- Provider-reported identity is untrusted text: display only, capped, escaped.
- Migration deletes are scoped by ref prefix and scope; a test proves team-agent and
  `provider:`/`skill:`/`routine:` rows survive.
- `prompt=select_account` adds no capability.
- Run `security-checklist` on slices 1, 2, 3 and 5.

## Testing

- Two personal agents, same owner, same connector, different accounts → each resolves its
  own token. A user-scope `account:` row is never read; writing one is refused.
- Team agent: a member's personal sign-in no longer overrides the team's.
- Add: attach failure after token exchange deletes the token and leaves the connector off;
  cancel / deny / provider error leave nothing. Same for the API-key route.
  `begin` without `agentId` → 400. Sign in again keeps attachment and verdicts.
- Authorize URL contains `prompt=select_account` (`select_account consent` for Google).
- Identity: id_token email captured; userinfo fallback; neither → `account: null` and the
  row shows "Signed in by … on …"; over-long / control-char labels are sanitized.
- Migration: user-scope `account:` rows and user markers gone; non-admin connectors deleted
  with cleanup; team rows and other ref kinds untouched; second run is a no-op.
- Cleanup: connector delete and agent delete leave no orphaned rows or markers.
- UI: Admin nav has Connectors; personal nav has Sites and no Connectors; menu is Edit /
  Remove (+ Sign in again when needed); "Signed in as" shown; Add opens the popup directly.
- Routines: a skipped connector writes the warning.
- **Canary + kind walk:** real Linear OAuth connector; two agents signed in as two
  different Linear accounts; each agent's `viewer` tool returns its own account.

## Slices (board cards; deps in brackets)

**Revised 2026-10-07 while planning:** the lookup flip must come **last**. 22 test files in 7
packages (mcp-oauth, connectors, mcp-client, channel-web, credentials-admin-routes,
skill-broker, credentials) write or read person-level `account:` rows today, so flipping
the lookup first breaks them all at once. Writers move to agent scope first; the flip,
the write refusal and the person-level purge land together at the end. Main stays green
at every slice, and stays **undeployable** until slice 5 (person-level rows are still
written/read in between, which is the old behavior, but Add semantics are mixed).

1. **Purge + delete cleanup** — `credentials:purge-account`; shared-connector delete
   purges agents' sign-ins; agent delete purges reconnect markers. [none]
2. **Admin-only connectors** — Admin › Connectors; delete non-admin routes; proposals to
   admins; `keyMode personal → agent`; workspace-unique connector ids; detach a deleted
   connector from every agent and drop its reconnect markers; Settings › Sites; boot step deleting non-admin
   connectors. Must precede 3: agent-scope reads only work for shared definitions. [1]
3. **Agent-owned sign-in + all-or-nothing Add** — mcp-oauth `begin` requires agent, always
   agent scope, `prompt=select_account`; callback completion + compensation; Add vs
   Sign-in-again pending mode; API-key Add route at agent scope; rail menu Edit / Remove
   (+ Sign in again); delete `signOutIfUnused` and the no-agentId sign-in callers. [2]
4. **"Signed in as"** — identity capture; status-batch fields; row label. [3]
5. **Lookup flip + boot purge** — `account:` lookup agent → global; refuse user-scope
   `account:` writes; purge user-scope `account:` rows and user markers; retire
   `remove-personal-sign-in` and the user marker table; update the 22 test files. [3]
6. **Routine skip warning.** [none]
7. **(walk)** Kind acceptance with two Linear accounts. [4, 5, 6]

## Out of scope

- TASK-886 (web reading without asking; one Allowed sites list).
- Wildcards in Allowed sites.
- Admin-provisioned identities without interactive sign-in (e.g. Google domain-wide
  delegation).
- Per-member sign-ins on team agents.
