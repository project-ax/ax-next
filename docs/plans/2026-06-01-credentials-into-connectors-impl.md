# Impl plan — fold credentials into connectors

Design (source of truth): `2026-06-01-credentials-into-connectors-design.md`.
Operational deviations found vs the design's stated 2-place scope are logged in
`.claude/memory/decisions.md` (2026-06-01 section). TDD: failing test before each change.

## Tasks (TDD, committed per logical unit)

### T1 — connectors: serviceTagForSlot always returns connectorId
- `credential-plan.ts`: `serviceTagForSlot(_slot, connectorId)` → `return connectorId`.
- Tests (`credential-plan.test.ts`): rewrite the "uses slot account" case to "ignores
  the legacy account tag → connectorId"; multi-slot "distinct accounts" case now yields
  per-slot refs keyed by connectorId (`account:<connectorId>:<slot>`), no collision.
- `deriveCredentialPlan` body unchanged (calls serviceTagForSlot(slot, id)).

### T2 — connectors: drop `account` from schema + authored assembly
- `types.ts`: drop `account` from `CapabilitySlotSchema`; drop `account?` from
  `AuthoredConnectorSlot`.
- `plugin.ts` `assembleProposal` (l.489): drop the `...(s?.account…)` spread.
- Tests: `authored-hooks.test.ts` (stored proposal no longer carries account);
  `hooks.test.ts` resolve refs now key by connectorId; `admin-routes.test.ts` Test-probe
  presence fixtures use `account:<connectorId>`.
- Add: "a connector authored/stored WITH a legacy account tag has it stripped and
  resolves to `account:<connectorId>`" (round-trip — proves the orchestrator stays safe).

### T3 — connectors: purge-on-delete
- `plugin.ts`: manifest `optionalCalls: [{ hook: 'credentials:delete', degradation }]`.
- `deleteConnector(store, bus, ctx, input)`: load connector → softDelete → if loaded &&
  `bus.hasService('credentials:delete')`, for each plan entry call `credentials:delete`
  `{ scope, ownerId: scope==='user'?userId:null, ref }`; log+swallow per-entry failures.
- Wire the registration to pass `bus` + `ctx`.
- Tests (`hooks.test.ts` or new `delete-purge.test.ts`): personal connector purges
  `scope:user/ownerId:userId`; workspace purges `scope:global/ownerId:null`; multi-slot
  purges every ref; `hasService` false → still soft-deletes, no throw (degraded);
  bug-fix-policy regression: after delete no resolvable key remains for its refs.

### T4 — channel-web client mirror (must match T1/T2 byte-for-byte)
- `lib/connectors.ts`: `serviceTagForSlot` → connectorId; drop `account?` from
  `ConnectorCredentialSlot`.
- `lib/__tests__/connectors-credential-plan.test.ts`: mirror T1 test changes.

### T5 — connector form: drop share-by-service
- `lib/connector-form.ts`: drop `account` from `CredentialSlotRow`, `emptySlotRow`,
  `slotToRow`, `rowsToSlots`; update JSDoc.
- `ConnectorEditDialog.tsx`: remove the "Share key by service (optional)" field/row.
- Tests: connector-form round-trip (Label+Machine name only, no account); edit-dialog
  has no share field.

### T6 — Connect dialog: enter → manage (Replace/Remove)
- `CredentialSlotForm.tsx`: add Remove button (only when `current.set`) → `clearDestinationCredential` + `onCleared`.
- `ConnectorConnectDialog.tsx`: on open load user (+global if admin) credential lists;
  compute per-slot `current={{ set: hasCred(scope, ref) }}`; refresh on save/clear.
- Tests: form Remove calls clear+onCleared when set; Connect dialog shows Replace/Remove
  for a set slot and enter for empty (mocked presence); Remove triggers onConnected.

### T7 — remove the Credentials tab
- `AdminSidebar.tsx`: drop `'credentials'` from `AdminTabId` + USER_NAV + unused `Key` icon.
- `AdminShell.tsx`: drop from `TAB_META`, drop import + render branch.
- Delete `CredentialsTab.tsx`, `KeysTab.tsx` + `__tests__/KeysTab.test.tsx`.
- Tests: no `credentials` nav entry / no Credentials render.

### T8 — prune account-usage dead code
- `lib/connections.ts`: delete `getAccountUsage`.
- `server/routes-connections.ts`: delete `AccountUsageResponse` + `accountUsage` handler.
- `server/plugin.ts`: delete the `/api/chat/account-usage` registration + retarget comment.
- Tests: delete the account-usage cases in `connections-client.test.ts`,
  `routes-connections.test.ts`, `server/plugin.test.ts`.

### T9 — relabel connected-shelf action
- `ConnectorsTab.tsx` `renderTile`: "Reconnect" → "Manage" (connected shelf only).
- Tests: connected tile shows "Manage", available shows "Connect".

## Gate
`pnpm install --frozen-lockfile` (done) → `pnpm build` → `pnpm --filter @ax/connectors test`,
`--filter @ax/credentials test`, `--filter @ax/channel-web test` → eslint changed files.
Whole-branch `ax-code-reviewer` before PR.
</content>
</invoke>
