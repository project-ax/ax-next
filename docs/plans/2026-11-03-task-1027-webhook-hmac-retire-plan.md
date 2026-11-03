# TASK-1027 — Retire the legacy webhook signature setting (parse and ignore), log the silent 503s — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signature setting saved before TASK-1026 (`webhook.hmac`) stops meaning "always check". Only a saved signing secret turns checks on, for every task. The webhook receiver's three silent 503s log an error code, never a message.

**Architecture:** "Parse and ignore". Stored `hmac` stays in the database, receipts and queued-update snapshots, byte for byte, and the contract keeps parsing it exactly as today. Hashes and strict stored-row reads therefore can't change. The receiver stops consulting it (`webhook-handler.ts:100-101`). The task page and Settings drop the legacy note. The store keeps carrying a stored `hmac` into a replacement webhook, now so the stored JSON (and with it the queued-update hash and connection evidence) stays put, not to keep checks on. There is no migration.

**Tech Stack:** TypeScript, Zod 3, Kysely + PostgreSQL (Testcontainers), React + shadcn in `@ax/channel-web`, Vitest.

**Spec:** the TASK-1027 card (Items 1–3), as narrowed by Vinay's choice of option (A) and the coordinator's binding constraints (relayed by the builder, 2026-11-03). Rationale and rejected alternatives: `.claude/memory/decisions/2026-11-03-TASK-1027.md`. Background: `docs/plans/2026-11-02-task-1026-webhook-secret-only-plan.md` (D1–D9).

## Card claims refuted (put in the PR body)

1. **"Migrate the stored definitions"**, and its acceptance "a migration with a test", are replaced by parse-and-ignore. A stripping migration would cancel queued updates, because each waiting repeat delivery is checked twice against the routine's webhook: its stored `configuration_hash` at claim (`repeat-deliveries.ts:64-66`) and its blob's embedded routine at run time (`repeat-runtime.ts:48-50`). Blobs are content-addressed and can't be rewritten. It would also have to rewrite receipts, which are never pruned (only agent purge deletes them, `store.ts:1622`). Ignoring the setting gets the behaviour change with no stored byte touched, and stays rollback-safe.
2. **"Stop parsing the old shapes" / "old shapes are refused by the contract"** is refused for stored data. `claimDue` (`store.ts:1677`), the delivery pump (`repeat-deliveries.ts:63`) and receipt replay (`store.ts:788-796`) all parse through the strict stored-routine schema, so one unparseable row would fail the tick for every task. New *agent* input has been refused since TASK-1026 and still is. HTTP input keeps accepting the stored value (decision P4).
3. **"Keep the routines-contract tests that load each old shape until the migration has run in prod"**: there is no migration, so these tests stay for good. They now pin that each shape parses to exactly the same value and is ignored.
4. **Item 2 is moot.** The delete-and-recreate sentence lives only in the legacy branch that Task 2 deletes. The planner checked for any surviving "turn off app updates" copy: there is none. The only one was the legacy `howToStop` (`SigningSecretHelp.tsx:11`), so no copy gains the sentence (P5).
5. **Item 3's "the same way the admission path does" is wrong.** The admission catch (`webhook-handler.ts:157-160`) logs nothing either. The code-not-message pattern exists only for the secret read (`:73-75`). There are three silent 503s, not one: `refuse()` (`:62`), the Slack `verified` path (`:133`) and admission (`:157-160`).

## Planner decisions

Tasks cite these as P1–P8.

- **P1 — Parse exactly, never strip.** `CustomWebhookHmacSchema`, `WebhookHmacSchema` and `WebhookTriggerSchema.hmac` keep their parse behaviour unchanged, including `algorithm`'s `'sha256'` default and the schema's key order. Every place that hashes or compares a webhook sees what was stored, parsed by the same schema, on both sides:
  - `repeatConfigurationHash`: at admission (`repeat-deliveries.ts:35,43`), claim (`:64`), run (`repeat-runtime.ts:48-50`) and edit (`store.ts:1023`)
  - the evidence reset `JSON.stringify(current.webhook) !== JSON.stringify(next.webhook)` (`store.ts:1033`)
  - receipt replay (`store.ts:881`).

  So nothing changes for a stored row. The one read path that drops `hmac`, the agent tool views (`withoutSignatureSettings`, routines `tools.ts`), never feeds a hash or a comparison. Don't add any other read-path stripping.
- **P2 — The receiver ignores it.** `required = secretSaved`, with no exception. A legacy task with no secret now accepts unsigned updates like any task without a secret; Vinay accepted this. A legacy task whose secret is removed stops checking, so TASK-1026 D9(h) is gone. `hasLegacySignatureSetting` is deleted: the receiver was its only caller.
- **P3 — The carry-over stays (`store.ts:1014-1016`); only its reason changes.** Agents never see `hmac` (their views strip it), so an agent re-sending a legacy task's webhook omits it. Without the carry-over, that no-op edit would change the stored webhook JSON, and that would:
  - reset the connection evidence and rotate the generation (`store.ts:1033`)
  - cancel every waiting update of a repeat routine as "job changed" (`store.ts:1023-1025`).

  The carry-over keeps a no-op edit a no-op. Only removing app updates or deleting the task clears a stored `hmac`. Pinned by Task 1's new regression test.
- **P4 — HTTP input keeps accepting `hmac`; no new HTTP refusal.** The web UI is the HTTP routes' only client. Since TASK-1026 it can't author a setting, but it echoes a stored one when a webhook edit spreads `form.webhook` (`use-routine-draft.ts:72`, `TaskForm.tsx:436,493`, `RoutineEditor.tsx:426,437`). Accepting that echo keeps hashes stable, the same way P3 does. A refusal would mean either stripping the HTTP views (a hook-output change) or teaching the UI to drop the field. Either way about a dozen test fixtures that seed legacy rows through `routines:create` would need rewriting, and the refusal would buy nothing now that the setting is inert. What an old client gets: an echo or even a fresh setting is accepted, stored and ignored, and the task page truthfully says "Without a secret, updates aren't checked". Agents keep `refuseSignatureSettings` (TASK-980: a model must not believe it set up verification).
- **P5 — No new "turn off app updates" copy.** The claim does hold in code, for repeat routines only. Removing app updates invalidates a routine's waiting deliveries (`store.ts:1023-1025`); a task keeps its queued events, which its next check-in consumes (`task-events.ts:23-35`). But the only copy that described that path is the legacy note this PR deletes. Adding a warning to the editors' app-updates toggle would be new scope, so it is noted as a possible follow-up in the shard.
- **P6 — Logged faults.** All three sites log `ctx.logger.warn` with fields `{ agentId, routineId, code? }`. The observe sites also log `observation`, the `WebhookRefusalReason` or `'verified'`, which is an enum.
  - Event names: `routines_webhook_observe_failed` for `refuse()` and the Slack `verified` path, `routines_webhook_admission_failed` for admission.
  - Admission logs only on its 503 branch, never on the 429 quota branch (`code === 'rejected'`).
  - `code` is a `PluginError`'s `.code`, or a 5-character SQLSTATE through store.ts's existing `sqlState` (`store.ts:917-919`, now exported). With neither, there is no `code` field.
  - Never pass the Error to the logger: `createLogger` serializes an Error field with its message (`core/src/context.ts:37`).
  - `ctx` moves up to just after the `!row` 404 (`webhook-handler.ts:56`). `refuse()` is first called at `:65`, before today's declaration at `:67`, so logging inside `refuse()` would otherwise throw a TDZ ReferenceError on a too-large body.
- **P7 — Hook surface: unchanged.** No service-hook signature, payload or `returns` schema changes. `routines:get`/`list` still return a stored `hmac` to owners, and agent tool outputs still strip it. No boundary review and no stable-hook pin change. Say so in the PR.
- **P8 — Rollback fails closed.** The stored `hmac` is untouched, so rolling back to the TASK-1026 receiver re-applies "always check" to legacy tasks. TASK-1026's own D9(e) hazard still applies to anything below TASK-1026.

## YAGNI pass

**Kept**, each load-bearing:
- the receiver rule (Vinay's choice)
- the waiting-delivery regression test, which guards "queued updates must not be cancelled" and pins why the carry-over stays
- the UI note removal (left alone it would claim "always checks", which is no longer true)
- the three logs (card item 3)
- the layout-script line (constraint 4)
- the design-doc row (rule 5).

**Cut:**
- any migration or SQL strip (P1)
- an HTTP-input refusal, view stripping or UI draft stripping (P4)
- new "turn off app updates" copy (P5)
- the cleanup-pending chip fix (a follow-up, by instruction)
- renaming the `cleanup-pending` field
- deleting `CustomWebhookHmacSchema`/`WebhookHmacSchema` (they must keep parsing)
- removing the agent refusal or agent view stripping.

Tasks: 5 (2 mechanical, 1 integration, 2 sensitive). Tasks 1, 2 and 3 are independent of each other. Task 2 needs no server change to pass; it only needs to ship in the same PR as Task 1, so the page never contradicts the receiver.

## Global Constraints

- No SQL that writes `webhook_spec`, no routines migration version, no read-path normalization of `hmac` (P1).
- No new dependency, hook, IPC action or hook-shape change (P7).
- Don't change the parse behaviour of `CustomWebhookHmacSchema`, `WebhookHmacSchema` or `WebhookTriggerSchema`. Comments only (P1).
- Don't touch agent refusal (`refuseSignatureSettings`) or agent view stripping (`withoutSignatureSettings`) beyond comments (P4).
- "Legacy" in `webhook_legacy_enabled`, `legacyOnly`, `resolveLegacy`, `address.kind === 'legacy'` and `legacyRow()` means the old *shared address*. It is unrelated to the signature setting; don't touch it.
- Never log or persist header names or values, bodies, secrets or error messages, and never pass an Error to a logger (P6).
- `@ax/routines-contract` resolves through `dist/` (no source alias in routines or channel-web). After editing anything under `packages/routines-contract/src`, run `pnpm --filter @ax/routines-contract build` before running another package's tests.
- Filter before script: `pnpm --filter @ax/<pkg> test -- <path>`.
- Routines, admin-route and credentials-admin-route suites use Testcontainers. Export an explicit `DOCKER_HOST` (CLAUDE.md).
- UI: invoke the `shadcn` skill before editing. Add no new components; this is copy removal only.
- Memory rows are appended to `.claude/memory/decisions/2026-11-03-TASK-1027.md` and never edit an existing line (R1).

## Review Focus

1. **A legacy repeat routine has updates waiting when the deploy lands.** They must run, not be cancelled as "job changed". Covered by P1, the contract parse pin (Task 1, Step 1a) and the waiting-delivery test (Task 1, Step 1d).
2. **An agent or client re-sends a legacy task's webhook without `hmac`.** Evidence, generation and waiting updates must be unchanged. Covered by Task 1, Step 1d, plus the existing `store.test.ts` carry-over test.
3. **A legacy task's owner removes its secret.** Updates must then be accepted unchecked. Covered by Task 1, Step 1c.
4. **A Slack URL check reaches a legacy `{app:'slack'}` task with no secret.** It must still be refused (401 `secret`), never answered or queued (TASK-1026 D7). Covered by Task 1, Step 1c.
5. **A failure is logged.** The serialized log line must hold the code and never the thrown message, including on the too-large path that runs before the secret read (the TDZ trap). Covered by Task 3, Step 1.

## File map

| File | Responsibility | Task |
| --- | --- | --- |
| `packages/routines/src/webhook-handler.ts` | Drop the legacy branch (1). Move `ctx`, log three faults (3) | 1, 3 |
| `packages/routines/src/definition.ts` | Delete `hasLegacySignatureSetting` | 1 |
| `packages/routines/src/store.ts` | Carry-over comment (1). Export `sqlState` (3) | 1, 3 |
| `packages/routines-contract/src/definition.ts`, `src/tools.ts` | Comments: parsed and ignored | 1 |
| `packages/channel-web/src/components/routines/SigningSecretHelp.tsx`, `RoutinesList.tsx`, `workspace/TaskAppUpdates.tsx` | Legacy note removed | 2 |
| `scripts/check-routines-layout.mjs` | Removed switch no longer clicked | 4 |
| `docs/plans/2026-10-20-agent-tasks-design.md` | Stale prose (rule 5) | 5 |

## PR obligations (collect while building)

- **Pre-deploy check** (read-only; the planner has no prod access). Put this in the PR body:

  > Before deploying, list the tasks that still carry a signature setting saved before TASK-1026:
  > `SELECT agent_id, routine_id FROM routines_v1_definitions WHERE webhook_spec ? 'hmac';`
  > After this deploy, a listed task **without** a saved signing secret accepts unsigned app updates, like any task without a secret. Before the deploy it turned them all away. Check each task page's **Signing secret** row; paste the secret to keep checks on. Listed tasks *with* a secret keep checking, but removing their secret now turns checks off. Nothing stored changes, so rolling back restores "always check" (P8).
- **Security note.** Run `security-checklist` over Tasks 1 and 3. Cover:
  - the fail-open for legacy tasks without a secret (product-accepted; the listing query above)
  - agents still can't author or see the setting
  - nothing stored is rewritten (P1)
  - logs carry codes only, never messages, headers, bodies or secrets
  - no new capability.
- **Boundary review:** none required (P7). Say "no hook surface change" explicitly.
- **Card claims refuted:** the five items above.
- **Follow-ups for auto-ship** (don't fix here):
  - The cleanup-pending save error marks TaskForm's Updates chip with "Choose a response time from 1 minute to 24 hours." (shard, row "Two follow-ups").
  - Optionally, warn that turning off a routine's app updates drops its waiting updates (P5).

---

### Task 1: The receiver ignores legacy signature settings [tier: sensitive]

**Needs `security-checklist`:** this changes the auth rule of a route that starts paid work.

**Files:**
- Modify: `packages/routines/src/webhook-handler.ts`
  - `:7`: drop the `hasLegacySignatureSetting` import
  - `:68-69`: rewrite the comment
  - `:99-105`: the signature block
- Modify: `packages/routines/src/definition.ts:55-56`. Delete `hasLegacySignatureSetting`.
- Modify: `packages/routines/src/store.ts:1010-1013`. Comment only; the code at `:1014-1016` stays.
- Modify, comments only:
  - `packages/routines-contract/src/definition.ts:65-91`
  - `packages/routines-contract/src/tools.ts:11-21`
- Test, in `packages/routines` unless another package is named:
  - `packages/routines-contract/src/__tests__/webhook-signature.test.ts`
  - `src/__tests__/webhook-admission.test.ts`
  - `src/__tests__/secret-only-signatures.integration.test.ts`
  - `src/__tests__/provider-signatures.integration.test.ts:47-48`
  - `src/__tests__/webhook-router.test.ts`
  - `src/__tests__/independent-definition.test.ts:23-27`
  - `src/__tests__/store.test.ts:145-148`

**Interfaces:**
- Produces: none. Deletes `hasLegacySignatureSetting`, which has no other caller (`grep -rn hasLegacySignatureSetting packages` comes back empty afterwards).

- [ ] **Step 1a: Contract pin** (`webhook-signature.test.ts`, contract).
  - Rename the first `describe` to `'legacy signature settings: parsed exactly, ignored since TASK-1027'`.
  - Keep every existing assertion.
  - Add `it('parses a stored setting to the same value, key order and default included')`. It asserts the exact string. This string is what `JSON.stringify` comparisons see, and the value `repeatConfigurationHash` hashes:

    ```ts
    // A task: `respondWithin` is refused on a repeat routine ("Response timing is for batched tasks only.").
    expect(JSON.stringify(RoutineDefinitionSchema.parse({ name: 'U', promptBody: 'R', kind: 'stay-on-top', goodWhen: 'Nothing waits.',
      schedule: { kind: 'interval', every: '1h' },
      webhook: { respondWithin: '10m', events: ['push'], hmac: { header: 'X-Signature' }, path: '/u', kind: 'webhook' } }).webhook))
      .toBe('{"kind":"webhook","path":"/u","events":["push"],"hmac":{"header":"X-Signature","algorithm":"sha256"},"respondWithin":"10m"}');
    ```

    The planner ran this against the built contract at fbd6c63b9: it passes today. It is a guard against anyone "simplifying" the legacy schemas.
- [ ] **Step 1b: Unit flip** (`webhook-admission.test.ts`).
  - Delete the table row `'a signed update when a setting saved earlier asks for a secret and none is saved'` (`:68`).
  - Add `it('ignores a signature setting saved earlier: with no secret saved, an update is accepted unchecked')` inside `describe('the saved secret decides (TASK-1026)')`, where `missing` and `unsigned` live. Use `fixture('accepted', row, missing)` with `row` (it carries `hmac`). Send `request()` and `unsigned()`; each gives 202. `f.admit` is called with `expect.objectContaining({ signature: null })`.
- [ ] **Step 1c: Integration rewrite** (`secret-only-signatures.integration.test.ts`). Replace `'keeps every legacy signature setting working'` (`:121-149`) with `'ignores every legacy signature setting'`. Keep the same six `settings`, the same `create`, and `h.restart()`. For each task:
  1. `routines:get` gives `webhook.hmac` that `toStrictEqual(hmac)`, still stored.
  2. Unsigned `post(url)` gives 202, and status `toMatchObject({ app: null, signatureChecked: false })`.
  3. For `{ app: 'slack' }` only: `post(url, {}, '{"type":"url_verification","challenge":"c"}')` gives 401, and refusals include `{ reason: 'secret', count: 1 }`.
  4. `saveSecret(row)`. Then:
     - the sha1 shape: the SHA-1 delivery gives 401 (unchanged)
     - `post(url, signed)` gives 202, and status `toMatchObject({ app, signatureChecked: true, timestampChecked: 'app' in hmac })`
     - unsigned `post(url)` gives 401.
  5. `saveSecret(row, 'delete')`, then unsigned `post(url)` gives 202. Removing the secret turns checks off, legacy setting or not.

  Finally `await expect.poll(() => h.invokeCalls.length).toBe(settings.length * 3)`. Update the file's header comment to cite TASK-1027.
- [ ] **Step 1d: Hash-stability regression** (`webhook-router.test.ts`, inside `describe('durable signed repeat-delivery canary')`). Model it on the canary at `:225-244`. Name: `'keeps a legacy routine’s waiting update through a re-sent webhook that leaves the setting out'`.
  - Create with `h = await createRoutineHarness({ invoke })`, passing the same completing `invoke` that `setup()` uses (`:28`), so the run finishes. Then `routines:create` as `h.owner` on `h.agentId` with `RoutineDefinitionSchema.parse({ name: 'Hook', promptBody: 'Review {{payload.title}}', trigger: { kind: 'webhook', path: '/hook', events: ['push'], hmac: { header: 'X-Signature' } } })`. No `algorithm`: exercise the default. No `seedSecret`.
  - Then `legacyRow(row)` and `agents:ensure-webhook-token`, as `setup()` does.
  - Hold three slots with `store.acceptDispatch` (`requestId: hold-${i}`, `source: 'manual'`).
  - `request(token, { headers: { 'x-github-event': 'push', 'x-github-delivery': 'waiting-1' } })` gives 202 (unsigned, no secret). `routines:get` `.delivery` gives `{ active: 3, waiting: 1 }`.
  - `routines:update` as `h.owner` with `{ agentId, routineId, expectedRevision: row.revision, requestId: 'resend', patch: { webhook: { kind: 'webhook', path: '/hook', events: ['push'] } } }`. The result's `webhook.hmac` `toEqual({ header: 'X-Signature', algorithm: 'sha256' })`.
  - `SELECT invalidated_reason FROM routines_v1_deliveries WHERE routine_id=…` gives `[{ invalidated_reason: null }]`.
  - Finish the three held dispatches. `await expect.poll(() => h.invokeCalls.length, { timeout: 10_000 }).toBe(1)`.
  - No `routines_v1_fires` row for the routine has `error = 'This app update was cancelled because the job changed.'`.
  - Mutation check (commit first; restore with `git checkout HEAD -- <path>`): deleting `store.ts:1014-1016` must make this test fail.
- [ ] **Step 1e: Small flips.**
  - `provider-signatures.integration.test.ts:47-48`: delete the comment and the `expect((await send(app)).status).toBe(401)` before the secret is saved. A legacy setting no longer refuses; Step 1c covers that case. The `h.invokeCalls` counts are unchanged.
  - `independent-definition.test.ts:23-27`: delete the `hasLegacySignatureSetting` test. The `webhook` fixture at `:6` stays as inert data.
  - `store.test.ts:145-148`: rename the test to `'keeps a stored signature setting when an edit replaces the webhook without it, so nothing hashed or compared changes'`. The comment says P3. The assertions stay.
- [ ] **Step 2: Run the new and changed tests; expect the right failures.**
  - `pnpm --filter @ax/routines-contract test -- src/__tests__/webhook-signature.test.ts` gives PASS (a pin).
  - `pnpm --filter @ax/routines test -- src/__tests__/webhook-admission.test.ts src/__tests__/secret-only-signatures.integration.test.ts src/__tests__/webhook-router.test.ts` gives FAIL on 1b and 1c (still 401). 1d already passes; it guards against a regression.
- [ ] **Step 3: Implement P2.**
  - Signature block: `if (secret !== null) { signature = verifyWebhookDelivery(req.headers, req.body, secret, deps.now()); if (signature === null) { await refuse(401, 'signature'); return; } }`.
  - Rewrite the comment at `:68-69`: "Step 2: signature. A saved signing secret turns checks on; nothing else does. Settings saved before TASK-1026 (`webhook.hmac`) are parsed and ignored (TASK-1027)." Keep the generation sentence.
  - Delete `hasLegacySignatureSetting` and its import.
  - Comments:
    - `store.ts:1010-1013`: "TASK-1027 P3. A stored `webhook.hmac` is ignored, but it is part of the stored webhook, which the queued-update hash (`repeatConfigurationHash`) and the evidence reset below compare. Agents never see it, so a replacement that leaves it out keeps it, and an edit that changes nothing stays a no-op. Only removing app updates or deleting the task clears it. Re-parsed for the schema's key order."
    - Contract `definition.ts:65-91`: "Saved before TASK-1026; parsed and ignored since TASK-1027: only a saved secret turns checks on. Keep parsing exactly as before, `algorithm` default and key order included. Stored rows, receipts and queued-update snapshots are parsed with this and hashed, so any change to what it parses to would cancel queued updates."
    - Contract `tools.ts:11-21`: say the setting is ignored, and that agents are still refused so a model never believes it set up verification.
  - Then `pnpm --filter @ax/routines-contract build`.
- [ ] **Step 4: Run.**
  - `pnpm --filter @ax/routines-contract test`
  - `pnpm --filter @ax/routines test`
  - `pnpm --filter @ax/routines-admin-routes test`
  - `pnpm --filter @ax/credentials-admin-routes test`

  Expected: PASS. `canary.test.ts:306-316` (a person's edit keeps the setting; the agent's read omits it) and the fixture-only `hmac` sites pass unchanged. If one fails, it depended on "always check": fix the test, not the rule.
- [ ] **Step 5: Commit:** `feat(routines): a signature setting saved before TASK-1026 is parsed and ignored; only a saved secret turns checks on`.

### Task 2: Task page and Settings stop describing legacy settings [tier: integration]

**Files:**
- Modify: `packages/channel-web/src/components/routines/SigningSecretHelp.tsx`. It takes no props and renders the help paragraph only.
- Modify: `packages/channel-web/src/components/workspace/TaskAppUpdates.tsx:51`, `packages/channel-web/src/components/routines/RoutinesList.tsx:375-379`. Both become `<SigningSecretHelp />`.
- Test: `packages/channel-web/src/components/workspace/__tests__/TaskAppUpdates.test.tsx:44-60`, `packages/channel-web/src/__tests__/routines-list.test.tsx:151-176`

**Interfaces:**
- Produces: `export function SigningSecretHelp(): JSX.Element`.

**Exact copy (unchanged sentence, typographic apostrophes):** "Paste the signing secret from the other app’s webhook settings. Once it’s saved, we recognize the app and turn away updates whose signature doesn’t match. Without a secret, updates aren’t checked."

- [ ] **Step 1: Write the failing tests.**
  - `TaskAppUpdates.test.tsx`: replace the two legacy tests with `it.each([['scheduled', {}], ['app-only', { kind: 'repeat', goodWhen: null, schedule: null }]])('shows a %s task saved with a signature setting the same help as any task (TASK-1027)')`. Use a row whose webhook carries `hmac: { app: 'slack' }`:
    - `getByText(unchecked)` is visible
    - `queryByText(legacyNote)`, `queryByText(/To stop checking/)` and `queryByText(/delete this task/)` are all absent.
  - `routines-list.test.tsx`: replace `:151-176` with the same `it.each` over `legacyScheduled` and `{ ...legacyScheduled, schedule: null }`:
    - `/Without a secret, updates aren’t checked/` is present
    - `/always check signatures/` and `/To stop checking/` are absent.
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-web test -- TaskAppUpdates routines-list`. Expected: FAIL (the legacy note still shows).
- [ ] **Step 3: Implement.**
  - Invoke the `shadcn` skill first.
  - Delete the `legacy`, `scheduled` and `noun` props, `howToStop` and the legacy `<p>`.
  - Rewrite the doc comment: "What a saved signing secret does, shown next to the Signing secret row on the task page and in Settings. A saved secret is the only switch (TASK-1027): settings saved before TASK-1026 are ignored."
  - Update both callers.
  - Item 2's copy goes with the branch (card claim 4).
- [ ] **Step 4: Run** the full `pnpm --filter @ax/channel-web test`, then `pnpm build` (channel-web's `tsc` checks tests). Expected: PASS. The echo tests (`TaskForm.test.tsx:359-368`, `RoutineEditor.methods.test.tsx:37-48`) stay green and unchanged (P4).
- [ ] **Step 5: Commit:** `feat(channel-web): drop the legacy "always checks signatures" note; a saved secret is the only switch`.

### Task 3: The receiver's 503s log a code, never a message [tier: sensitive]

**Needs `security-checklist`** (logging on an untrusted-input route): codes only, never the message.

**Files:**
- Modify: `packages/routines/src/store.ts:917`. `export function sqlState(error: unknown): string | null`; the body is unchanged.
- Modify: `packages/routines/src/webhook-handler.ts`
  - `:56-67`: move `ctx` up
  - `:61-64`: `refuse`
  - `:133`: the Slack `verified` path
  - `:157-160`: admission
- Test: `packages/routines/src/__tests__/webhook-admission.test.ts` (unit, no Docker)

**Interfaces:**
- Consumes: `sqlState` from `./store.js`.
- Produces: log events `routines_webhook_observe_failed` `{ agentId, routineId, observation, code? }` and `routines_webhook_admission_failed` `{ agentId, routineId, code? }`, both at level `warn`.

- [ ] **Step 1: Write the failing tests.**
  - New `describe('a 503 logs its code, never its message (TASK-1027)')`, with `afterEach(() => vi.restoreAllMocks())`.
  - Copy TASK-1024's `captureStdout()` (`packages/agents/src/__tests__/promote-upsert-errors.test.ts:85-92`). Read lines with `logged.split('\n').filter(l => l.startsWith('{"')).map(l => JSON.parse(l))`. Every case also asserts `expect(logged).not.toContain('PRIVATE')`.
  - Hoist `plain` and `unsigned` (`:57-58`, scoped to the TASK-1026 describe today) to file scope.
  - Use `plain` as the row: no `hmac`, vault `async () => 'secret'`, unless a case says otherwise.

  Cases:
  1. `it.each([['a plugin error', new PluginError({ plugin: '@ax/routines', code: 'timeout', message: 'PRIVATE observe detail' }), 'timeout'], ['a database error', Object.assign(new Error('PRIVATE row detail'), { code: '40P01' }), '40P01'], ['an error with no code', new Error('PRIVATE detail'), undefined]])('logs %s when a refusal can’t be recorded')`.
     - Set `f.observeWebhook.mockRejectedValueOnce(error)` and send `unsigned()`, a refusal as `signature`.
     - Expect status 503.
     - Expect a line `toMatchObject({ msg: 'routines_webhook_observe_failed', level: 'warn', agentId: 'a', routineId: 'r', observation: 'signature' })`. Its `code` equals the expected value; when that is `undefined`, assert `not.toHaveProperty('code')`.
  2. `it('logs when a too-large update’s refusal can’t be recorded, before any secret read')`.
     - Use `request({ body: Buffer.alloc(1024 * 1024 + 1) })` with the observe rejection (`code: 'timeout'`).
     - The handler resolves, with no ReferenceError, and gives 503. The line has `observation: 'too-large'` and `code: 'timeout'`.
  3. `it('logs when a verified Slack address check can’t be recorded')`.
     - Build the signed `url_verification` request as in `:50-52`, on `{ ...row, webhook: { kind: 'webhook', path: '/hook' } }`. Reject the first observe with `code: 'unknown'`.
     - Expect 503, and a line with `observation: 'verified'` and `code: 'unknown'`.
  4. `it('logs a failed admission’s code and still records it as unavailable')`.
     - Use `f.admit.mockRejectedValueOnce(new PluginError({ plugin: '@ax/routines', code: 'unknown', message: 'PRIVATE admission detail' }))`.
     - Expect 503, and a line `toMatchObject({ msg: 'routines_webhook_admission_failed', agentId: 'a', routineId: 'r', code: 'unknown' })`. Expect `observeWebhook` called with `observation: 'unavailable'`.
  5. `it('logs nothing for a quota refusal')`.
     - Use `f.admit.mockRejectedValueOnce(Object.assign(new Error('PRIVATE quota detail'), { code: 'rejected' }))`.
     - Expect 429, and no `routines_webhook_admission_failed` line.
- [ ] **Step 2: Run** `pnpm --filter @ax/routines test -- src/__tests__/webhook-admission.test.ts`. Expected: FAIL (no lines are logged).
- [ ] **Step 3: Implement P6.**
  - Move `const ctx = makeAgentContext({ sessionId: 'routine-webhook', agentId: row.agentId, userId: row.ownerUserId })` to directly after the `!row || row.webhook === null` 404 (`:56`), and delete it at `:67`.
  - Add a private `faultCode(error: unknown): string | undefined`. It returns `error instanceof PluginError ? error.code : (sqlState(error) ?? undefined)`.
  - Log on `ctx.logger.warn` at the three catches, passing only the fields in Interfaces. In admission, log only when `!quota`.
- [ ] **Step 4: Run** the same file, then the full `pnpm --filter @ax/routines test`. Expected: PASS. Mutation checks (commit first):
  - Pass `error` into the log fields: case 1 fails on `PRIVATE`, because `createLogger` serializes an Error with its message.
  - Put the `ctx` declaration back at `:67` while logging in `refuse()`: case 2 fails.
- [ ] **Step 5: Commit:** `fix(routines): webhook 503s log the failure's code, never its message`.

### Task 4: Layout walk no longer clicks the removed switch [tier: mechanical]

**Files:**
- Modify: `scripts/check-routines-layout.mjs:262`. Delete `await dialog.getByRole('switch', { name: 'Verify HMAC signature' }).click();`. TASK-1026 removed that switch.

- [ ] **Step 1: Delete the line.**
- [ ] **Step 2: Verify.** `node --check scripts/check-routines-layout.mjs` exits 0. `grep -n "Verify HMAC" scripts/check-routines-layout.mjs` returns nothing.
  - The script is a local Playwright walk. CI never runs it, and no script test names it (`grep -rn check-routines-layout scripts package.json .github` finds only the file itself).
  - Running it needs a local channel-web on `127.0.0.1:5188`. If one is up, run `node scripts/check-routines-layout.mjs http://127.0.0.1:5188 <scratch>/layout`; otherwise say in the PR that the walk was not re-run.
- [ ] **Step 3: Commit:** `fix(scripts): routines layout walk no longer clicks the removed Verify HMAC switch`.

### Task 5: Stale prose (rule 5) [tier: mechanical]

**Files:**
- Modify: `docs/plans/2026-10-20-agent-tasks-design.md:619` (the §5.3 row), and the §15 table after `:1175`.

- [ ] **Step 1: Edit.**
  - `:619` becomes: `| HMAC header, algorithm, prefix | Paste the app's signing secret; the host detects the format (TASK-1026). Settings saved earlier still load but are ignored (TASK-1027): only a saved secret turns checks on. |`
  - Append to §15: `| 2026-11-03 | Implemented (TASK-1027) | Signature settings saved before TASK-1026 are parsed and ignored: a saved secret is the only switch, so a task that kept one without a secret now accepts unsigned updates like any task without a secret. Stored settings aren't rewritten (queued updates and receipts parse and hash them), and agents still can't send one. |`
  - The `:1175` TASK-1026 row and the dated TASK-1026 plan are history; leave them. The stale memory row (TASK-1026 shard `:6`) is already corrected by a TASK-1027 shard row.
- [ ] **Step 2: Grep for leftovers.** `grep -rnE "always check signatures|keep checks on|keeps checks on|presence keeps" docs/plans/2026-10-20-agent-tasks-design.md deploy packages --include='*.md' --include='*.ts' --include='*.tsx'`. Expected: no hits outside tests asserting absence. Fix any that describe current behaviour.
- [ ] **Step 3: Commit** `docs: legacy webhook signature settings are ignored (TASK-1027)`, together with any new rows appended to `.claude/memory/decisions/2026-11-03-TASK-1027.md`.

### Final verification

- [ ] `pnpm build && pnpm lint && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`. All three suites must be green. An `@ax/auth-better` Docker-teardown timeout with every assertion passing is the known local flake (CLAUDE.md): confirm it with its counts.
- [ ] `scripts/memory-append-check.sh` passes (shard rows appended only).
- [ ] The PR body carries the pre-deploy query and its consequences, the security note, "no hook surface change", the card claims refuted, the rollback note (P8) and the follow-ups.
