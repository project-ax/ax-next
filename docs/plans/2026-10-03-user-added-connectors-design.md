# User-added connectors: admins define, people add and sign in

**Status:** approved design, 2026-10-03 (Vinay). Builds on `2026-10-02-connectors-rail-design.md`
(the rail, its Add subview and per-tool verdicts are unchanged except where stated here).

## Problem (as reported on production, 2026-10-03)

An admin creates a Gmail connector in Settings → Connectors (MCP server URL + their own OAuth client
ID and secret). The expected next step is that **any person adds it to their own agent from the
agent rail and signs in with their own Google account.** Instead:

1. There is no "+ Add" in the rail. *Cause:* production runs `5e9d340b` (09-29), which predates the
   rail epic (#840–#864). Main has the Add subview. Deploying fixes this symptom only.
2. The only way to get the connector onto an agent is the admin agent editor's per-agent picker.
   Admins should never have to assign connectors.
3. After an admin assigns it, the rail row offers no way to sign in. *Cause:* the `⋯` menu shows
   **Reconnect** only for `health === 'needs-reconnect'` (`AgentConnectors.tsx:627`), which comes
   only from a marker written when a token refresh is *rejected* (`mcp-oauth/src/plugin.ts:297-355`).
   A person who never signed in has no marker, so the row reads healthy. The details view says
   "Sign-in needed" (`ConnectorDetails.tsx:299`) with no button. Add was the only first-sign-in
   path, and it hides connectors already in the effective set.
4. Latent, would be hit right after (3) is fixed: **nobody but the admin can sign in to a
   custom-client OAuth connector.** The editor saves the client secret at the admin's *user* scope
   (`RemoteMcpConnectorForm.tsx:339-357` → `destination-routes.ts:33,272` forces `ownerId` = actor).
   `mcp-oauth` begin reads `credentials:get(clientSecretRef, userId = signer)`
   (`mcp-oauth/src/routes.ts:416-434`) → `400 oauth_client_secret_unavailable` for everyone else.

## Model after this change

- **Admins define connectors.** Optionally "Turn on for every agent" (`default_attached`) stays.

> **Update 2026-10-04 (TASK-808): "Set default" (`default_attached`) is removed.** Owner decision
> (Vinay): "default" did not say what it did — a first-timer reads it as "recommended", but it
> silently put the connector on agents, skipped the attach consent and access notice, and with
> per-user sign-in it could never actually be "on" (it showed "Not signed in yet" rows instead).
> People add every connector they need from the rail's **+ Add**; admins never put a connector on
> someone's agent. Existing defaults were converted once, at boot, into explicit attachments on the
> connector owner's **personal** agents. (Measured while doing it: a default only ever reached
> sessions run by the connector's *owner*, not every person.) Team agents were deliberately not
> converted: an attachment there reaches every member, which is wider than the default ever was. A
> team admin re-adds it from the rail if the team wants it. The `default_attached` column is kept
> but nothing reads it except that one-time conversion.
- **People add connectors to their own agents** from the rail (Add → Sign in / Add key → attach).
  Admins have no per-agent assignment UI.
- **Every person signs in with their own account** on personal agents, using the admin's OAuth
  client when one is configured.
- **Team agents:** only the agent's owner or a workspace admin may add, sign in to, or remove a
  connector on it. Their sign-in is stored on the agent (shared by members), as today.

## Design

### A. "Needs sign-in" row state (fixes 3)

- `mcp-oauth:status-batch` gains a non-refreshing **presence** answer per connector for a given
  `(userId, agentId)`: `connected` iff a token exists along the normal lookup order
  (user → agent → global) that this caller would actually resolve. No refresh, no network.
  API-key connectors use the equivalent `credentials` presence check already behind
  `attachCredentialGate` (`routes-workspace.ts:1467-1546`), reused, not duplicated.
- `connectorHealth` (`routes-workspace.ts:3702-3752`) adds `health: 'needs-sign-in'`, ranked below
  `needs-reconnect` and above `unreachable`/`ok`.
- Rail (`AgentConnectors.tsx`):
  - Row: neutral (not destructive) `CircleAlert`-style icon with tooltip "Not signed in yet"
    (hover **and** keyboard focus, like the existing error tooltip).
  - `⋯` menu, first item: **Sign in** (OAuth → `ConnectorOAuthConnect agentId`) or **Add key**
    (→ `ConnectorConnectDialog`). On success, refetch the list.
  - Details view: the "Sign-in needed" line gets the same action as a button.
  - Team agent viewed by a member (not owner/admin): no action; tooltip/caption
    "Ask <owner> to sign in".
- This is what makes default-on connectors usable: each person sees Sign in on the row.
- Chat: ~~alongside TASK-713's `connector-needs-reconnect`, the orchestrator reports
  `connector-needs-sign-in` when a session opens with an effective connector that has no credential,
  and chat points at the Connectors tab with "sign in" wording.~~ **Superseded by TASK-806 (owner
  decision A, 2026-10-04):** a connector this person never signed in to / added a key for is
  SKIPPED for the session (presence read via `credentials:has` before `proxy:open-session`); the
  turn runs without its tools, the agent's prompt names it, and chat shows a non-blocking,
  dismissible "isn't signed in yet, so it's off for this chat" notice (from the rail's
  `needs-sign-in` rows) with **Open Connectors**. Signing in re-spawns the warm session on the next
  message. A rejected refresh still blocks with `connector-needs-reconnect`.

### B. Admin OAuth client secret readable by any signer (fixes 4)

- When the author of a custom-client OAuth connector is a **workspace admin**, the editor writes
  `account:<connectorId>:OAUTH_CLIENT_SECRET` at **`global`** scope (admin destination route), not
  user scope.
- ~~Credential plan (`connectors/src/credential-plan.ts:127-141`) lists that ref at `global` for such
  connectors.~~ **Superseded by TASK-797:** the plan must NOT list the client secret. It is also the
  connect-flow prompt list, the attach credential gate and mcp-client's describe-tools slot resolver,
  so listing it there would prompt every user for it and put it on paths that send slot values to MCP
  servers. The secret has its own global-read rule in `credential-authz.ts` instead.
- Read authz (`connectors/src/credential-authz.ts`, extending the TASK-697 global-read rule): a
  global read of an `…:OAUTH_CLIENT_SECRET` ref is allowed only if **all** hold:
  the connector is `visibility: 'shared'`, its owner is an admin, and the ref equals that connector's
  slot `clientSecretRef`. Everything else denies. (TASK-797 checked: the bus ctx can NOT pin the
  calling plugin — `AgentContext` has no caller identity and `HookBus.call` records none — so the
  guarantee rests on the next bullet: the rule also denies a ref that is a plan slot, and the proxy
  fold drops an `OAUTH_CLIENT_SECRET` slot.)
- The secret is used only host-side to talk to the provider's token endpoint. It is never placed in
  the credential proxy, the sandbox, a runner, a hook payload, or a log: the proxy-injection plan
  must never list `OAUTH_CLIENT_SECRET` refs (add a test pinning that).
- **Depends on TASK-762** (editor rejects `header-<uuid>` / OAuth client secret slots with
  "invalid account slot"). Verify on main whether a custom-client secret save succeeds today; if
  not, fold TASK-762's fix in or land it first.
- **Non-admin authors** keep user-scope storage; the editor says "Only you can sign in to this
  connector because it uses your OAuth app."
- **Migration:** existing admin connectors whose secret is at user scope show
  "Re-enter the client secret so others can sign in" in the editor; saving rewrites it at global and
  deletes the user-scope copy. No automatic copy (production has one such connector).

### C. Remove admin per-agent assignment

Delete, with their tests, in the same PR (half-wired policy):

- `AgentForm.tsx` connector picker (`:23-27,119`, the read-only hint `:129-168`) and the team-agent
  sign-in block (`:979-993`).
- `lib/admin.ts:239-247` client and `PATCH /admin/agents/:id/connector-attachments`
  (`agents/src/admin-routes.ts:237-245, 835-890, 1130`).
- `agents:set-connector-attachments` (`agents/src/plugin.ts:131,384-406`, types `:298`). Its only
  caller is that route. `agents:attach-connector` / `detach-connector` stay and remain the single
  write path; the `connector_attachments` column stays.
- The `workspaceConnectorGrantViolation` error contract (`connector-guard.ts:104`) moves to the
  attach hook's docs.

Team agents get their shared sign-in from the rail instead (A), via Add → Sign in → attach. Admins add
workspace-key connectors from the rail (non-admins still don't see them in Add).

### D. Team-agent authority: owner or admin only

- `mcp-oauth` begin with an `agentId` whose agent is `team`: if the caller is neither the agent's
  owner nor a workspace admin → `403 forbidden` (before any provider redirect). Today any member
  passing `agents:resolve` can replace the shared sign-in (`mcp-oauth/src/routes.ts:327-373`).
- Workspace routes `POST/DELETE /api/workspace/agents/:id/connectors…` on a team agent: same
  owner-or-admin check (TASK-765 asks this for removing defaults; this widens it to add/remove).
  The check lives in `agents:attach-connector` / `detach-connector` so every caller enforces it.
- Rail hides Add / Sign in / Remove for members on team agents.
- Members' own Settings → Connectors sign-ins (no `agentId`, user scope) are unaffected; per the
  HYBRID lookup they shadow the team token for that member's own runs, as today.

### E. Tool permissions by auth type (TASK-809, owner decision 2026-10-04)

Found on the TASK-800 walk: a new connector never saved per-tool defaults (the editor showed the
section only after a first save), so every tool had no admin default and the rail capped it at Ask
first — Allow greyed out on Gmail's read tools.

- **API-key / no-auth MCP servers:** the create dialog saves the connector, lists its tools and shows
  the tool-permissions section in the same dialog; Save writes every row shown, suggestions included.
  Listing failure still saves (tools stay Ask first). The admin default stays a ceiling, as before.
- **OAuth MCP servers:** no tool-permissions section in the admin editor (create or edit). No admin
  ceiling: the namespace is `agent`-sourced in tool-policy, its old admin defaults are deleted (once,
  idempotently, at boot and on save) and ignored. Attach seeds each tool's starting per-agent verdict
  from the server's hints (`readOnly → Allow`, else Ask first); a tool with no row is Ask first. People
  change them in the rail; team agents follow D.
- **Trust note (accepted by the owner):** for OAuth servers the starting verdicts come from the MCP
  server's own hints without admin review. Hints are untrusted connector text; the person who signs in
  decides. Static deny rules and the implicit-MCP ceiling for non-connector tools are unchanged.

## Boundary review

- **`mcp-oauth:status-batch` gains presence.** Alternate impl: an API-key or vault-backed credential
  store answering the same "does this caller resolve a credential" question. Leaking field names:
  none (`connected`, `needsReconnect`). Subscriber risk: none; it's a service hook with one caller.
- **`health: 'needs-sign-in'`** is a channel-web route value, not a hook.
- **Removed:** `agents:set-connector-attachments` (no remaining callers).
- **Changed authz** on `agents:attach-connector` / `detach-connector` (team owner-or-admin). No payload
  change.

## Security notes

- Global client-secret reads are narrowed to (shared, admin-owned, exact ref, host-side mcp-oauth).
  A shared connector authored by a non-admin cannot expose a secret workspace-wide.
- Team-agent sign-in tightening removes a member's ability to swap the account every member's runs act as.
- Run the `security-checklist` skill on the authz and mcp-oauth changes.

## Testing

- `credential-authz` matrix: global read of the client secret allowed for shared + admin-owned + exact
  ref; denied for private, non-admin-owned, mismatched ref, and non-mcp-oauth readers.
- mcp-oauth begin, end to end: **a non-admin signs in to an admin-made custom-client connector** and gets
  a provider redirect (the test that would have caught 4). Team agent: member → 403; owner and admin → ok.
- `connectorHealth`: never signed in → `needs-sign-in`; signed in → `ok`; rejected refresh →
  `needs-reconnect`; status-batch never triggers a refresh.
- Rail component tests: Sign in / Add key item on `needs-sign-in` rows, details button, member-on-team
  view shows no actions.
- Removal: PATCH route returns 404; the agents plugin no longer registers the hook; AgentForm has no picker.
- Migration: editor shows re-enter notice for a user-scope secret; save moves it to global.
- Canary acceptance stays green; a kind walk covers: admin creates custom-client OAuth connector →
  non-admin adds it to a personal agent from the rail → signs in → tool call works; default-on connector
  shows Sign in for a second user.

## Deploy

Shipping to production also ships the rail epic's Add flow (symptom 1). The rail handoff's warning
applies: with no admin per-tool defaults saved, every connector tool is "Ask first" (routines pause).
(Since TASK-809 this is true only for API-key / no-auth connectors created before the create dialog
learned to save defaults; OAuth connectors start from the server's hints per agent — see E.)
OAuth on kind needs helm `onboarding.publicBaseUrl`.

## Out of scope

- Auto-copying existing user-scope client secrets.
- aisdk runner connector support (rail shows "unsupported" there; unchanged).
- Rail-handoff follow-ups (TASK-754/756/757/758/762/763/764) except TASK-765, which D subsumes.
