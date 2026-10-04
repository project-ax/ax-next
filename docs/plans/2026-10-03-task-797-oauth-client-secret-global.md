# TASK-797 — admin OAuth client secret readable by any signer

Design: `docs/plans/2026-10-03-user-added-connectors-design.md` §B.

## Findings that change the card (verified on main `db46b23e`)

1. **The credential plan must NOT list the client secret.** `deriveCredentialPlan` is not only the
   authz input: it is the connect-flow prompt list (`ConnectorConnectDialog`, `add-connector.ts`,
   `ConnectorsTab`), the attach credential gate (`routes-workspace.ts`), the describe-tools slot
   resolver (`mcp-client`), and the delete purge. Adding the secret there would prompt every user for
   it and put it on paths that send slot values to MCP servers. The client secret gets its own rule.
2. **`begin` cannot reach global today even with authz fixed.** Its ctx agentId is `'@ax/mcp-oauth'`.
   For a SHARED connector `credentials:authorize-agent:account` (TASK-711) says yes, then
   `credentials:store-blob:get` throws on the ownerId grammar, so the walk dies before global. `begin`
   must read the client secret with `agentId: ''` (user -> global only), the same convention the
   `status` route already uses.
3. **The bus cannot pin the calling plugin.** `AgentContext` has no caller identity and `HookBus.call`
   records none; any plugin can mint a ctx with agentId `'@ax/mcp-oauth'`. So the guarantee that the
   secret never reaches the sandbox rests on: (a) the authz rule refusing any ref that is ALSO a
   credential-plan ref of the connector, and (b) the proxy fold dropping `:OAUTH_CLIENT_SECRET` slots.
4. TASK-762 save works on main (existing `RemoteMcpConnectorForm.test.tsx` "stores client secrets in
   the vault" + `connector-credential-slots.contract.test.ts`).

## Tasks

### T1 — connectors: client-secret global rule (+ delete purge)
- `credential-authz.ts` `authorizeGlobalAccountRead`: a ref of the form `account:<id>:OAUTH_CLIENT_SECRET`
  is decided ONLY by the new rule: allow iff `store.getSoleSharedById(userId, id)` returns a connector
  (=> shared, unambiguous, and what this user resolves), its single oauth slot's `clientSecretRef`
  equals the ref, the ref is NOT any `deriveCredentialPlan` entry ref, and `auth:get-user(owner).isAdmin === true`.
  Every other ref keeps the TASK-697 rule unchanged.
- `connectors:delete` also purges the connector's own client secret ref: user scope always, global only
  with `purgeGlobal`.
- Tests: matrix in `credential-authz.test.ts` (allow; deny private, non-admin owner, mismatched ref,
  plan collision, two shared same-id, demoted admin).

### T2 — chat-orchestrator: the proxy plan never carries a client secret
- `foldConnectorCaps` skips a slot named `OAUTH_CLIENT_SECRET` (its ref would be the client secret's).
- Test in `connector-union.test.ts`: no `baseCreds` entry ref ends with `:OAUTH_CLIENT_SECRET`, even
  for a connector declaring such a slot.

### T3 — mcp-oauth: begin reads the client secret user -> global
- New ctx with `agentId: ''` for the client-secret `credentials:get`.
- E2E (postgres): real connectors + credentials + mcp-oauth; admin authors a shared custom-client
  connector, secret at global; a non-admin begins and gets a provider authorizationUrl. Negatives:
  non-admin-owned shared connector and private admin connector -> 400 `oauth_client_secret_unavailable`.

### T4 — channel-web editor
- Helper `clientSecretScope({ isAdmin, keyMode, visibility })` -> `global` for workspace keyMode or
  admin + shared; else `user`. Used by both editors.
- Admin + shared + personal: write via `/admin/destinations/account/credential` at `global`.
- Non-admin custom client: note "Only you can sign in to this connector because it uses your OAuth app."
- Migration: admin editor, existing connector, `clientSecretRef` present, a USER-scope row with that
  ref in `/settings/credentials` -> Alert "Re-enter the client secret so others can sign in". Saving a
  new secret writes global then DELETEs the user copy via `/settings/destinations/account/credential`.
- Tests in `RemoteMcpConnectorForm.test.tsx`; contract test that the admin route accepts the slot at global.

### T5 — docs
- Correct the design doc §B bullet that says the credential plan lists the ref.
