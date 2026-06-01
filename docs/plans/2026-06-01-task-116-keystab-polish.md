# TASK-116 — CredentialsTab/KeysTab: humane errors, no raw-ref leak, friendlier service field

KeysTab is the body of CredentialsTab (a thin re-export). It is the most-used credential
surface and kept the worst pre-connectors patterns. Three independent, testable changes,
all in `packages/channel-web/src/components/settings/KeysTab.tsx` + its test.

## Findings being closed
- **M3** — five `setError(String(e))` dump raw error objects (often `[object Object]` /
  `Error: 500`) with no next step.
- **C4** — an unknown credential ref (e.g. `provider:anthropic`, `mcp:...`, `routine:...`)
  renders its raw `kind:value` string straight to the user.
- **L3** — the "Add a key" sheet exposes slug grammar: placeholder `e.g. linear`,
  validation copy `Use a lowercase service name (letters, digits, hyphens).`

## Task 1 — humane error message + next step
- Add a module-level helper `humanError(err: unknown): string` returning
  `err instanceof Error ? err.message : String(err)` (the sibling `ConnectorsTab` /
  `ConnectorConnectDialog` pattern — invariant #6 "one design language" extends to error
  handling). Replace all 5 `setError(String(e))` (load, addAccountKey, removeAccountKey,
  replaceSkillKey, removeSkillKey) with `setError(humanError(e))`.
- The Alert already renders `{error}`. Append a fixed next-step line BELOW the raw
  message inside the same destructive `Alert` so the user always sees an action:
  "We couldn't save your key. Check it's correct and try again — your admin can help if
  it keeps failing." (card-mandated copy). The technical `{error}` becomes a secondary,
  muted detail line so the humane sentence leads.
- Test: mock `myCredentials.list` to reject with a plain `Error('boom')`; assert the
  humane next-step sentence renders AND no `String(e)`-style `[object Object]` dump
  appears. Also assert a non-Error rejection (e.g. a string) still renders the next-step.

## Task 2 — no raw `kind:value` ref leak (the `other` shape)
- The `other` branch currently renders `parsed.raw` (e.g. `provider:anthropic`) as both
  the primary label and the "used by" line.
- Resolve to a friendly name: split on the first `:`; map the `kind` to a human noun via a
  small `OTHER_KIND_LABEL` record (`provider → 'Model provider'`, `mcp → 'Connector'`,
  `routine → 'Scheduled task'`); render `<KindLabel> · <value>` ONLY when the value is a
  safe display token, else just the kind label. Never render the bare `kind:value` string.
  Drop the "used by: <raw>" line entirely for unknown refs (there is no usage data for
  them) — show a calm caption like "Managed elsewhere" instead.
- These rows stay read-only (no Remove) — unchanged.
- Test: seed `myCredentials.list` with `{ ref: 'provider:anthropic', ... }`; assert the
  raw string `provider:anthropic` is NOT in the document, and a friendly label
  ("Model provider") IS.

## Task 3 — friendlier service field, no slug grammar
- The `account:<service>` contract + server grammar `/^[a-z][a-z0-9-]{0,63}$/`
  (`credentials-admin-routes/destination-routes.ts`) stay authoritative. There is NO
  service catalog in the codebase, so a true picker has nothing to pick from — keep a
  text input but stop exposing grammar and silently normalize.
- Relabel: `Service` → "Which service is this key for?"; placeholder
  `e.g. linear` → "e.g. Linear, GitHub, Notion" (human names, not a slug).
- Add `toServiceSlug(input): string` — lowercase, replace any run of non `[a-z0-9]` with a
  single `-`, strip leading non-letters + trailing `-`, cap 64. Guarantees a string that
  passes the server regex OR is empty. The user types a friendly name; we slugify on save.
- Drop the `ACCOUNT_SERVICE_RE` early-validation + the slug-grammar `<p>` entirely. Save is
  enabled iff `toServiceSlug(service).length > 0 && value.length > 0`. The empty/invalid
  case (e.g. user typed only spaces) just keeps Save disabled — no grammar copy.
- `onSave` receives the SLUG (`toServiceSlug(service)`), not the raw text, so the existing
  `setDestinationCredential` call is unchanged and always server-valid.
- Test: open the sheet, type `My Service!`, assert NO "lowercase service name" copy
  appears, fill value, click Save, assert `setDestinationCredential` is called with
  `service: 'my-service'` (slugified). Update the existing "rejects an invalid service
  slug" test — that grammar-copy assertion is removed by this card; replace it with a
  normalization assertion.

## YAGNI / scope
- No service catalog invented (none exists; would be a new wire surface). Text input +
  silent slugify is the minimal change that satisfies "does not expose slug grammar".
- No hook/IPC/boundary change — pure channel-web UI. No security-checklist trigger
  (no sandbox/IPC/plugin-loading/untrusted-content/dep change; untrusted ref text still
  renders through React text nodes, auto-escaped, exactly as before).

## Gate
- `pnpm -F @ax/channel-web build` (tsc type-checks `__tests__/*.tsx`) + the KeysTab test
  file + `pnpm lint` scoped to the changed file. Whole-branch ax-code-reviewer before PR.
