# TASK-1026 — Webhook signatures: paste-the-secret only — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A task's app updates are verified with nothing but a pasted signing secret. The host detects the app's signing format on each delivery. The app picker and its header/algorithm/prefix fields are gone from the task form, the routine editor and the agent's routine tools.

**Architecture:** The receiver reads the task's secret on every delivery (`credentials:get`). The `credential-not-found` code means "none saved"; any other failure refuses. A saved secret, or a signature setting saved before this change, turns verification on. A new pure verifier, `verifyWebhookDelivery`, handles two cases. If a Stripe, Slack or Zendesk header is present, it checks that app's full timestamped protocol and refuses on failure, never falling through. Otherwise it compares HMAC-SHA256(secret, raw body) against a bounded set of header values. The detected app is recorded in the existing private connection evidence (`webhook_health`) and reported by `routines:webhook-status`. The secret's lifecycle (save gate, cleanup) moves from `webhook.hmac` to the webhook itself.

**Tech stack:** TypeScript, Zod 3, `node:crypto`, Kysely + PostgreSQL (Testcontainers), React + shadcn in `@ax/channel-web`, Vitest, Ajv (test-only, already pinned).

**Spec:** the TASK-1026 card (Why / Decisions (Vinay, 11-02) / Scope notes / Acceptance) and the Planner decisions below. Rationale and rejected alternatives for each decision are in `.claude/memory/decisions/2026-11-02-TASK-1026.md`.

## Planner decisions

Tasks cite these as D1–D9.

**D1 — When verification is on.** `required = secretSaved || hasLegacySignatureSetting(row)`.
- If a secret is saved, detect the format and verify. On failure, 401 `signature`.
- If no secret is saved but a legacy setting is stored, 401 `secret`. This fails closed, as today.
- If neither, accept unsigned, as today for tasks without settings. The evidence says "signature not checked".

Card decision 6 ("treated as 'verify on'", "Saved tasks keep working") governs legacy tasks. Card decision 1 holds for every task without a legacy setting, which includes every task created from now on. There is one deviation: removing the secret from a legacy task leaves its updates refused. The task page says so (Task 5).

**D2 — "Secret saved".** Read it with the existing call: `credentials:get` with `{ ref: credentialRef(row), userId: row.ownerUserId }`. A non-empty string means saved. Only `error instanceof PluginError && error.code === 'credential-not-found'` means none is saved; a removed secret's tombstone reads the same way. Any other error logs the existing warning `routines_webhook_secret_fetch_failed` (with the error code) and refuses with 503 `unavailable`, so senders retry (review F3; this replaced the original 401 `secret`). An empty string also refuses with 401 `secret`: never HMAC with an empty key. Keep `webhookGeneration(row)` before the secret read. A secret saved or removed mid-delivery then makes admission refuse the delivery through the existing fence.

**D3 — Detection (`verifyWebhookDelivery`)**, applied in this order:
1. **Timestamped apps.** An app is present when any of its headers is an own property, whatever its length:
   - Stripe: `stripe-signature`
   - Slack: `x-slack-signature`, `x-slack-request-timestamp`
   - Zendesk: `x-zendesk-webhook-signature`, `x-zendesk-webhook-signature-timestamp`

   If more than one app is present, refuse. If exactly one is present, run that app's existing TASK-981 protocol unchanged, including the five-minute window. Pass returns `{ app, timestamp: true }`; fail refuses. Never fall through to step 3.
2. **Cross-protocol guard.** Refuse when `/^(?:\d+\.|v0:|\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z)/` matches `body.subarray(0, 40).toString('latin1')`. Stripe signs `t.`+body, Slack `v0:t:`+body and Zendesk `t`+body. Without this guard, someone could take a captured timestamped delivery, move the prefix into the body and strip the app's headers. Step 3 would then accept it with no clock check. No real JSON or form body starts this way.
3. **Body-only.** Compute `HMAC-SHA256(secret, body)` once, as hex and as base64. Walk the own entries of `headers` in order, visiting at most `MAX_SCANNED_HEADERS = 100` entries in total. For each entry:
   - Skip names in `NOT_SCANNED`.
   - Skip non-strings and values longer than `MAX_SIGNATURE_HEADER` (8192, existing).
   - Strip one leading `sha256=`, case-insensitive.
   - Compare with `timingSafeEqual` only when the length fits. A 64-char value is compared lowercased against the hex digest. A 44-char value is compared as-is against padded standard base64.

   The first match returns `{ app: BODY_ONLY_APPS.get(name) ?? 'other', timestamp: false }`.
   - `NOT_SCANNED` is a `ReadonlySet<string>`: `authorization, proxy-authorization, proxy-authenticate, cookie, set-cookie, connection, keep-alive, proxy-connection, te, trailer, transfer-encoding, upgrade`.
   - `BODY_ONLY_APPS` is a `ReadonlyMap<string, WebhookDetectedApp>`: `x-hub-signature-256 → github`, `linear-signature → linear`. Use a `Map`/`Set`, never an object literal. An own header named `constructor` or `__proto__` would otherwise read `Object.prototype` values, putting an app outside the enum into the evidence. `Health` would then fail to parse and `state()` would silently wipe it.
   - Only SHA-256 is computed, so a SHA-1 signature never matches. Header names arrive lowercase (an HTTP adapter precondition, as today).

**D4 — Legacy signature settings** (`webhook.hmac`, both shapes).
- They still parse everywhere; the shared Zod schemas are unchanged.
- Their values are ignored. Their presence keeps verification on (D1).
- `updateAuthored` carries a stored `hmac` into a replacement webhook object that omits it. Only removing app updates (webhook → `null`) or deleting the task clears it.
- Re-parse the carried object with `WebhookTriggerSchema` so its key order matches. `updateAuthored` resets evidence when `JSON.stringify(current.webhook) !== JSON.stringify(next.webhook)`, and TASK-982 already hit a key-order bug there.
- Nothing new authors these settings. The UI passes the stored value through untouched, and agents can neither see nor send them (Task 7).

**D5 — The secret follows the webhook, not `hmac`.**
- Saving or removing a secret requires `row.webhook !== null`. Otherwise throw `SafeToolError('validation', 'webhook')`.
- Queue cleanup when an update removes the webhook, and on delete/purge of a row that has one.
- Run `assertNoCleanup` only when an update adds app updates (`current.webhook === null && next.webhook !== null`). Saving a secret already asserts it (`withLockedWebhookSecret`), so a pending cleanup can never delete a newly saved secret.
- No other edit checks for a pending cleanup. An emergency stop is never blocked. Example: a row whose `hmac` was dropped before deploy still has its webhook and a cleanup that keeps failing; stopping it must still work, as it does today.

**D6 — Evidence and status.**
- The `webhook_health` JSON gains `signature: { app, timestamp } | null`. A Zod default of `null` lets old rows parse. The column is `jsonb`, so no migration is needed.
- `'accepted'` writes `signatureChecked = signature !== null` and `signature`.
- `'verified'` (the Slack handshake) writes `verifiedAt` and `signature`.
- In `@ax/routines-contract`, add `WebhookDetectedAppSchema = z.enum(['stripe', 'slack', 'zendesk', 'github', 'linear', 'other'])`.
- `RoutineWebhookStatusOutputSchema` changes:
  - `app: WebhookDetectedAppSchema.nullable()`, where `null` means nothing checked yet.
  - New field `timestampChecked: z.boolean()`.
  - `signatureChecked` is kept.

**D7 — Slack handshake.** `url_verification` is answered only when the delivery verified as Slack. Otherwise refuse it: 401 `secret` when no secret is saved, else 401 `signature`. Never enqueue it. Slack sends the challenge as soon as its URL is pasted, often before the secret is saved.

**D8 — The "Edit app setup" button stays.** It edits the address name, event filter and response time. Only the copy that sends people there to choose an app is retired.

**D9 — Known consequences.** List these in the PR description.
- (a) SHA-1-only senders (e.g. Intercom's `X-Hub-Signature: sha1=`) are refused, even on tasks saved with `algorithm: 'sha1'`. GitHub keeps working via `X-Hub-Signature-256`.
- (b) Prefixes other than `sha256=` stop matching.
- (c) Every delivery reads the vault, so a vault outage also refuses tasks without secrets, with a retryable 503 `unavailable`.
- (d) An agent request carrying `webhook.hmac` from before the deploy, retried with the same requestId after it, is refused rather than replayed.
- (e) Rollback hazard: an older receiver ignores secrets saved without legacy settings, so verification is silently off. Stop webhook ingress before rolling the receiver back.

## Global Constraints

- SHA-256 only. `MAX_SIGNATURE_HEADER = 8192` and the five-minute `TOLERANCE_MS` are unchanged. `MAX_SCANNED_HEADERS = 100`.
- No new dependency, DB migration, hook registration or IPC action.
- Both legacy `hmac` shapes still parse: `{ app: 'stripe' | 'slack' | 'zendesk' }` and `{ header, algorithm: 'sha256' | 'sha1', prefix? }`. Don't drop or rewrite stored data.
- Never log or persist header names or values, bodies or secrets. Evidence holds only the app enum and booleans.
- Every signature comparison uses `timingSafeEqual` on equal-length buffers.
- UI changes compose installed shadcn primitives with semantic tokens (`text-muted-foreground`, …). Invoke the `shadcn` skill before editing UI.
- Copy follows the CLAUDE.md voice: plain and short, with no jokes about security. The strings in this plan are the spec; UX review may polish them.
- Put the filter before the script: `pnpm --filter @ax/<pkg> test -- <path>`.
- `@ax/routines-contract` is consumed from `dist/`, with no source alias in routines or channel-web. After editing anything under `packages/routines-contract/src`, run `pnpm --filter @ax/routines-contract build` before running any other package's tests. Otherwise they test the old contract: strict status reads fail with `invalid-return`, and new exports are `undefined`.
- Routines, admin-route and credentials-admin-route suites start PostgreSQL through Testcontainers. Export an explicit `DOCKER_HOST` (CLAUDE.md "Docker-backed tests").
- Final gate:

  ```
  pnpm build && pnpm lint && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts
  ```

- Memory rows go to `.claude/memory/<kind>/2026-11-02-TASK-1026.md` shards, never to a root archive.

## Review Focus

1. **A vault outage read as "no secret saved"**, so unsigned updates get accepted. Expected: refused. Covered by Task 4 test 5.
2. **A secret saved while a delivery sits between its secret read and admission.** Expected: refused, nothing queued. Covered by Task 4 test 6.
3. **Node joins a duplicated header with ", ".** Expected: no match and no throw. Covered by Task 2, `refuses a doubled signature header`.
4. **A webhook edit that omits a legacy `hmac`** (from an agent or an old client) silently turns verification off or deletes the secret. Expected: the setting, the secret and the evidence are all kept. Covered by Task 3's second test.
5. **A Slack URL pasted before the secret** turns the challenge into a paid run. Expected: refused with the `secret` reason, nothing queued. Covered by Task 4 test 7.

## File map

| File | Responsibility | Task |
| --- | --- | --- |
| `packages/routines/src/__tests__/support/routine-harness.ts` | Fixture vault answers like production. Adds `seedSecret` | 1 |
| `packages/routines-contract/src/services.ts` | `WebhookDetectedAppSchema` (2); status schema fields (4) | 2, 4 |
| `packages/routines/src/webhook-signature.ts` | `verifyWebhookDelivery` (2); old `verifyWebhookSignature` deleted (4) | 2, 4 |
| `packages/routines/src/definition.ts` | `hasHmac` renamed to `hasLegacySignatureSetting` | 3 |
| `packages/routines/src/store.ts` | Secret gate, cleanup trigger, legacy carry-over | 3 |
| `packages/credentials-admin-routes/src/destination-routes.ts` | Own secret status no longer needs `hmac` | 3 |
| `packages/routines/src/webhook-handler.ts` | Presence rule, detection, Slack handshake, evidence | 4 |
| `packages/routines/src/webhook-health.ts`, `repeat-deliveries.ts`, `task-events.ts` | Record and report the detected signature | 4 |
| `packages/channel-web/src/components/workspace/TaskAppConnection.tsx` | Label map (4); copy (5) | 4, 5 |
| `packages/channel-web/src/components/workspace/TaskAppUpdates.tsx` | Secret field up front, legacy note | 5 |
| `TaskForm.tsx`, `RoutineEditor.tsx`, `task-form-helpers.ts`, `RoutinesList.tsx`, `TriggerChip.tsx`; delete `WebhookSignatureFields.tsx` | Picker removed everywhere | 6 |
| `packages/routines-contract/src/tools.ts`, `definition.ts`; `packages/routines/src/tools.ts` | Agents neither see nor send signature settings | 7 |
| `docs/plans/2026-10-20-agent-tasks-design.md`, `deploy/MANUAL-ACCEPTANCE.md` | Stale prose (rule 5) | 8 |

## PR obligations (collect while building)

- **Security note.** Run the `security-checklist` skill over Tasks 2, 3, 4 and 7. Cover:
  - untrusted headers and body on a route that starts paid work
  - fail-closed paths: outage, ambiguous apps, over-long values, header flood, cross-protocol replay, legacy setting without a secret
  - constant-time comparison
  - no logging of headers or secrets
  - the generation fence
  - the agent losing any say over verification
  - D9.
- **Boundary review** for the `routines:webhook-status` output change. Copy it from the decisions shard: the alternate impl, "no leaky names", "no subscriber risk", and the wire, which is the same JSON over `GET /settings/routines/:agentId/:routineId/receiver/status` validated by the shared contract with no IPC. Also note that `routines:set-webhook-secret` keeps its signature but drops the `hmac` precondition.
- **D9 list and rollback note.**

---

### Task 1: Production-faithful fixture vault [tier: integration]

**Files:**
- Modify: `packages/routines/src/__tests__/support/routine-harness.ts` (the `credentials:get` stub at ~92, the options type at 35, the `RoutineHarness` type at 16, the return object at ~148)
- Modify:
  - `packages/routines/src/__tests__/webhook-health.test.ts`
  - `webhook-router.test.ts`
  - `webhook-address-http.test.ts`
  - `task-events-runtime.test.ts`
  - `provider-signatures.integration.test.ts`
  - `canary.test.ts`
  - `member-owned.test.ts`

**Interfaces:**
- Produces: `RoutineHarness.seedSecret(key: { agentId: string; routineId: string }, value?: string): void`. `value` defaults to `'test-secret'`. It writes the fixture-vault entry `routine:<agentId>:<routineId>:hmac` directly, the way a secret saved before the delivery would exist, with no generation bump.

- [ ] **Step 1: Make the stub production-faithful.** `credentials:get` returns the stored value. Otherwise it throws `new PluginError({ plugin: '@ax/credentials', code: 'credential-not-found', message: 'no credential' })`, which is what production throws for a missing or removed secret. Delete the `'test-secret'` fallback and the `strictCredentials` option, and remove `strictCredentials: true` from its 5 call sites.
- [ ] **Step 2: Add `seedSecret`** to the type and the return object. It writes into the same `secrets` map, so a seeded secret survives `restart()`.
- [ ] **Step 3: Seed in the four files that signed with the implicit `'test-secret'`:** webhook-health, webhook-router, webhook-address-http and task-events-runtime. Call `h.seedSecret(row)` right after creating each routine whose deliveries are signed. Tests sending unsigned deliveries to routines without `hmac` need nothing.
- [ ] **Step 4: Run against the unchanged handler.** Run `pnpm --filter @ax/routines test` and `pnpm --filter @ax/routines-admin-routes test`. Expected: PASS. Any new 401 depended on the fallback; seed it.
- [ ] **Step 5: Commit:** `test(routines): fixture vault answers credential-not-found like production`.

### Task 2: Detecting verifier [tier: sensitive]

**Needs `security-checklist`:** this parses untrusted request headers and body.

**Files:**
- Modify: `packages/routines-contract/src/services.ts` (add next to `WebhookRefusalReasonSchema`, ~21)
- Modify: `packages/routines/src/webhook-signature.ts` (add `verifyWebhookDelivery`; keep `verifyWebhookSignature` until Task 4)
- Test: `packages/routines/src/__tests__/webhook-signature.test.ts` (new `describe('host-detected signatures')`)

**Interfaces:**
- Produces:

  ```ts
  // @ax/routines-contract
  export const WebhookDetectedAppSchema = z.enum(['stripe', 'slack', 'zendesk', 'github', 'linear', 'other']);
  export type WebhookDetectedApp = z.infer<typeof WebhookDetectedAppSchema>;
  // packages/routines/src/webhook-signature.ts
  export interface VerifiedSignature { readonly app: WebhookDetectedApp; readonly timestamp: boolean }
  export const MAX_SCANNED_HEADERS = 100;
  export function verifyWebhookDelivery(headers: Record<string, string>, body: Buffer, secret: string, now: Date): VerifiedSignature | null;
  ```

- [ ] **Step 1: Write the failing tests.** These are pure, with no Docker. Reuse the file's `signed(app, at)`, `body`, `secret` and `now`. Define `hex`/`b64` as `createHmac('sha256', secret).update(body).digest('hex' | 'base64')` and `sha1hex` the same way with `'sha1'`. Each case asserts `verifyWebhookDelivery(headers, body, secret, now)`:
  - `accepts a Linear-shaped signature`: `{ 'linear-signature': hex }` and the uppercase hex both give `{ app: 'linear', timestamp: false }`.
  - `accepts a GitHub-shaped signature`: `{ 'x-hub-signature': 'sha1=' + sha1hex, 'x-hub-signature-256': 'sha256=' + hex }` gives `{ app: 'github', timestamp: false }`.
  - `names any other signing header a signed app`: `{ 'x-signature': hex }`, `{ 'x-shopify-hmac-sha256': b64 }` and `{ 'x-signature': 'sha256=' + b64 }` each give `{ app: 'other', timestamp: false }`.
  - `refuses a wrong secret, a changed body, SHA-1 and no signature`: the wrong secret, `body + ' '`, `{ 'x-hub-signature': 'sha1=' + sha1hex }` alone, and `{}` each give `null`.
  - `never reads credential or hop-by-hop headers`: the valid `hex` under each `NOT_SCANNED` name gives `null`.
  - `it.each(['stripe','slack','zendesk'])`:
    - `'%s: verifies the full protocol'` gives `{ app, timestamp: true }`.
    - `'%s: a present header that fails refuses even beside a valid body signature'` gives `null` for each of these, each paired with `'x-hub-signature-256': 'sha256=' + hex`:
      - `signed(app, 301 s stale)`
      - for Slack and Zendesk, only the app's timestamp header
      - for Stripe, an 8193-char `stripe-signature`
    - `'%s: bounds timestamp age'`: ±300 s verifies, ±301 s gives `null`.
    - `'%s: a captured signature re-sent as a body-only one is refused'`:
      - Let `prefixed = Buffer.concat([signingPrefix(app), body])`. Take the captured digest: hex for Stripe and Slack (without `v0=`), base64 for Zendesk.
      - First assert that `createHmac('sha256', secret).update(prefixed)` equals that digest, so the test proves the guard and not a mismatch.
      - Then `verifyWebhookDelivery({ 'x-hub-signature-256': captured }, prefixed, …)` gives `null`.
  - `refuses two timestamped apps at once`: `{ ...signed('stripe'), ...signed('slack') }` gives `null`.
  - `refuses a doubled signature header`: `{ 'linear-signature': hex + ', ' + hex }` gives `null`.
  - `bounds the header scan`, with no throw in any case:
    - 10 000 own `x-junk-${i}: 'a'.repeat(64)` entries before a valid `linear-signature` give `null`.
    - A valid `linear-signature` first, followed by 10 000 junk entries, matches.
    - A 9000-char value is skipped.
  - `reads only own header properties`:
    - `Object.create({ 'linear-signature': hex })` gives `null`.
    - An object whose prototype carries `stripe-signature` and that owns a valid `linear-signature` gives `{ app: 'linear', … }`. Inherited headers neither verify nor trigger detection.
  - `it.each(['constructor', '__proto__'])('an own %s header is a signed app, never a prototype value')`: on `Object.create(null)`, own `[name]: hex` gives exactly `{ app: 'other', timestamp: false }`. Use `toStrictEqual`. This pins the `Map` lookup in D3.
- [ ] **Step 2: Build the contract and run the tests.** Run `pnpm --filter @ax/routines-contract build`, then `pnpm --filter @ax/routines test -- src/__tests__/webhook-signature.test.ts`. Expected: the new cases FAIL because the export is missing.
- [ ] **Step 3: Implement D3.**
  - Move the Stripe, Slack and Zendesk branches of `verifyWebhookSignature` unchanged into a private `verifyTimestamped(app, headers, body, secret, now): boolean`, and call it from both functions.
  - Name the guard regex constant. Its comment says which downgrade it blocks.
  - Compute the digest once with `.digest()`, then convert it to hex and base64 strings.
- [ ] **Step 4: Run** the file again; old and new cases PASS. Run `pnpm --filter @ax/routines-contract test`; PASS.
- [ ] **Step 5: Commit:** `feat(routines): detect the signing app from a delivery's headers`.

### Task 3: Verification state follows the webhook and the secret [tier: sensitive]

**Needs `security-checklist`:** this changes the auth boundary of a paid-work route and secret deletion.

**Files:**
- Modify: `packages/routines/src/definition.ts:55`. Rename `hasHmac` to `hasLegacySignatureSetting`, keeping the body. Doc comment: "Saved before TASK-1026. Its presence keeps signature checks on; its values are ignored."
- Modify `packages/routines/src/store.ts`:
  - `queueCleanup` (~966)
  - `updateAuthored` (~1003–1011)
  - `withLockedWebhookSecret` (~1567)
- Modify: `packages/credentials-admin-routes/src/destination-routes.ts:549`
- Test: `packages/routines/src/__tests__/store.test.ts`
- Test: `store-fixture.ts`. Add `plainWebhookInput(requestId = 'hook-plain')`, which is `webhookInput` without `hmac`.
- Test: `packages/credentials-admin-routes/src/__tests__/routine-member-http.test.ts`

**Interfaces:**
- Produces: `hasLegacySignatureSetting(row: RoutineDefinition): boolean`, exported from `packages/routines/src/definition.ts`. Task 4 uses it.

- [ ] **Step 1: Write the failing tests.** These go in `store.test.ts` with `fixture()`:
  - `saves a secret for any task with app updates, and only those`:
    - `withLockedWebhookSecret({ ...key, expectedRevision, operation: 'set', secret: new Uint8Array([1]) }, async () => {})` on `plainWebhookInput()` resolves `{ saved: true }`.
    - On `createInput()` (schedule only) it rejects `{ toolCode: 'validation', field: 'webhook' }`.
  - `keeps a legacy signature setting and its secret when an edit replaces the webhook without it`:
    - Create a stay-on-top task with `webhook: { kind: 'webhook', path: '/hook', hmac: { header: 'x-signature', algorithm: 'sha256' }, respondWithin: '10m' }`. Build it with `RoutineDefinitionSchema.parse`, adding the task's required `schedule` and `goodWhen`.
    - Update with `patch: { webhook: { kind: 'webhook', path: '/hook', respondWithin: '10m' } }`.
    - Expect `result.webhook` `toStrictEqual` the stored webhook.
    - Expect `pendingCleanup({ limit: 10 })` to be `[]`.
    - Expect the raw row's `webhook_health_generation` and `webhook_health` to be unchanged.
  - `removing app updates queues the secret for cleanup, with or without a legacy setting`:
    - Take `plainWebhookInput()` and remove the webhook with `{ trigger: { kind: 'interval', every: '60s' } }`. The cleanup job is listed.
    - Re-adding a webhook while it is pending rejects `{ toolCode: 'cleanup-pending' }`.
  - `deleting a task with app updates queues its secret for cleanup`: `deleteAuthored` on `plainWebhookInput()` returns `cleanupPending: true`.
  - Rewrite two existing tests that queued cleanup by dropping only `hmac`. Under D4/D5 that no longer queues anything, so both must now remove the webhook with `{ trigger: { kind: 'interval', every: '60s' } }`. The rest of each test stands.
    - `cleanup fences stale discovery, concurrent drains, failure, and new secret reconfiguration`
    - `allows an emergency stop while credential cleanup is pending` (`store.test.ts:112-117`)
  - Add `allows an emergency stop on a task with app updates while an old secret's cleanup is pending`. This is the leftover from before the deploy (D5).
    - Create `webhookInput()`.
    - Insert a `routines_v1_credential_cleanup` row for it directly, with the same columns `queueCleanup` writes (`agent_id`, `routine_id`, `credential_ref: credentialRef(row)`, `owner_user_id`).
    - A stop-only update (`{ enabled: false }`, `stopOnly: true`) resolves with `enabled: false`, and the job is still listed.
    - Saving a secret on that row rejects `{ toolCode: 'cleanup-pending' }`.
  - In `independent-definition.test.ts:24-25`, rename `D.hasHmac` to `D.hasLegacySignatureSetting`.
  - In `routine-member-http.test.ts`, add `reports a member's own secret status for a task without signature settings`.
    - Fixture: the routine row is built inside `beforeEach` and read by the stub store's `findOne`. Hoist it to a module-level `let row: StoredRoutine`. Assign the current default in `beforeEach`, so each test can replace it before its first request; `findOne` reads it at call time.
    - Replace it with `{ ...row, webhook: { kind: 'webhook', path: '/member' } }` (no `hmac`):
      - GET `ownStatus` returns 200 `{ configured: false }`.
      - After `seed()` it returns `{ configured: true }`.
    - Replace it with `{ ...row, webhook: null, schedule: { kind: 'interval', every: '1h' } }`: GET returns 404.
- [ ] **Step 2: Run** `pnpm --filter @ax/routines test -- src/__tests__/store.test.ts` and `pnpm --filter @ax/credentials-admin-routes test -- src/__tests__/routine-member-http.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement D4 and D5.**
  - `queueCleanup`: return early when `row.webhook === null`. This replaces `!hasHmac(row)`.
  - `updateAuthored`:
    - Directly after `next = applyRoutinePatch(…)`, carry the legacy setting (D4). If `current.webhook?.hmac !== undefined && next.webhook !== null && next.webhook.hmac === undefined`, set `next = { ...next, webhook: WebhookTriggerSchema.parse({ ...next.webhook, hmac: current.webhook.hmac }) }`.
    - Replace the two `hasHmac` lines with `if (current.webhook === null && next.webhook !== null) await assertNoCleanup(trx, current)` and `if (current.webhook !== null && next.webhook === null) await queueCleanup(trx, current)`.
  - `withLockedWebhookSecret`: `if (row.webhook === null) throw new SafeToolError('validation', 'webhook')`.
  - `destination-routes.ts:549`: `if (!routine.permissions.manageSecret || routine.webhook === null)`.
- [ ] **Step 4: Run** both test files; PASS. Then run the full suites; PASS:
  - `pnpm --filter @ax/routines test`
  - `pnpm --filter @ax/credentials-admin-routes test`
  - `pnpm --filter @ax/routines-admin-routes test`
- [ ] **Step 5: Commit:** `feat(routines): a task's signing secret follows its app updates, not its signature settings`.

### Task 4: Receiver — saved secret decides, detection verifies, evidence records it [tier: sensitive]

**Needs `security-checklist` and a boundary review:** this changes the `routines:webhook-status` output.

**Files:**
- Modify: `packages/routines-contract/src/services.ts:23-30`
- Modify: `packages/routines/src/webhook-handler.ts:51` (`observe`), `:59-77` (step 2), `:96-105` (Slack), `:121-126` (admit)
- Modify: `packages/routines/src/webhook-signature.ts` (delete `verifyWebhookSignature`)
- Modify: `packages/routines/src/webhook-health.ts:10-36, 55-64, 65-78`
- Modify: `packages/routines/src/repeat-deliveries.ts:20,42` and `task-events.ts:81,103`
- Modify: `packages/channel-web/src/components/workspace/TaskAppConnection.tsx:16,37` (label map only)
- Test (new): `packages/routines/src/__tests__/secret-only-signatures.integration.test.ts`
- Test (update), in `packages/routines/src/__tests__/` unless another package is named:
  - `webhook-signature.test.ts`
  - `webhook-router.test.ts`
  - `webhook-health.test.ts`
  - `webhook-admission.test.ts`
  - `packages/routines-contract/src/__tests__/webhook-status.test.ts`
  - `packages/routines-admin-routes/src/__tests__/routes.test.ts:113`
  - `packages/channel-web/src/components/workspace/__tests__/TaskAppConnection.test.tsx`

**Interfaces:**
- Consumes: `verifyWebhookDelivery` and `VerifiedSignature` (Task 2), `hasLegacySignatureSetting` (Task 3), `seedSecret` (Task 1).
- Produces. Task 5 relies on the status fields.

  ```ts
  // RoutineWebhookStatusOutputSchema (strict): changed fields
  app: WebhookDetectedAppSchema.nullable(),   // app of the last checked delivery; null = none yet
  signatureChecked: z.boolean(),              // unchanged: the last accepted update's signature was checked
  timestampChecked: z.boolean(),              // new: that check included the app's signed timestamp
  // packages/routines/src/webhook-health.ts
  writeWebhookObservation(db, row, observation, now, signature: VerifiedSignature | null = null): Promise<void>
  observeWebhook(input: { row; address; observation; now; signature?: VerifiedSignature | null }, authorizeLegacy)
  // repeat-deliveries.ts admit(...) and task-events.ts admitTaskEvent(...): input gains `signature: VerifiedSignature | null` (required)
  ```

- [ ] **Step 1: Contract test** (`webhook-status.test.ts`).
  - The fixture gains `app: null, timestampChecked: false`.
  - It accepts each of the six apps and `null`.
  - It rejects `app: 'unknown'` and a missing `timestampChecked`.
- [ ] **Step 2: Evidence tests** (`webhook-health.test.ts`, store-level).
  - `store.admitTaskEvent({ …, signature: { app: 'linear', timestamp: false } })`, then status gives `{ app: 'linear', signatureChecked: true, timestampChecked: false }`.
  - With `signature: null`, status gives `{ app: null, signatureChecked: false, timestampChecked: false }`.
  - A health value written before this change, set directly as `{ lastAcceptedAt, signatureChecked: true, verifiedAt: null, buckets: [] }`, reads as `{ signatureChecked: true, app: null, timestampChecked: false }`.
- [ ] **Step 3: Integration tests.** The new file is modeled on `provider-signatures.integration.test.ts`:
  - real HTTP server
  - harness
  - repeat webhook-only routines created without `hmac`
  - address from `routines:webhook-address`
  - secret via `routines:set-webhook-secret`

  Send mixed-case header names (`Linear-Signature`, `X-Hub-Signature-256`); the adapter lowercases them.
  1. `accepts unsigned updates until a secret is saved, then only signed ones`.
     - With no secret, an unsigned delivery gets 202 and status `{ app: null, signatureChecked: false }`.
     - After the secret is saved:
       - unsigned → 401
       - Linear-shaped with the wrong secret → 401
       - Linear-shaped → 202, status `{ app: 'linear', signatureChecked: true, timestampChecked: false }`
       - GitHub-shaped (`sha256=`) → 202, status `app: 'github'`
     - After `operation: 'delete'`, an unsigned delivery gets 202 again.
  2. `refuses a present but failing Stripe header beside a valid body signature`: 401, `h.invokeCalls` empty.
  3. `it.each(stripe, slack, zendesk)('%s works with only a secret saved')`. A fresh timestamp gets 202 with `{ app, timestampChecked: true }`; a 301 s old one gets 401.
  4. `keeps every legacy signature setting working`.
     - Run it for each stored shape:
       - `{ app: 'stripe' }`
       - `{ app: 'slack' }`
       - `{ app: 'zendesk' }`
       - `{ header: 'X-Hub-Signature-256', algorithm: 'sha256', prefix: 'sha256=' }`
       - `{ header: 'Linear-Signature', algorithm: 'sha256' }`
       - `{ header: 'X-Signature', algorithm: 'sha1' }`
     - Create the task with `routines:create`.
     - After `h.restart()`, expect `webhook.hmac` unchanged (decision 6: "loads each old shape").
     - With no secret, a correctly signed delivery gets 401 (D1).
     - With the secret saved, a delivery the detector accepts gets 202. For `{app}` shapes that is the app's own protocol; otherwise a SHA-256 hex signature in that header.
     - For the `sha1` shape, a SHA-1-only delivery gets 401 (D9a).
  5. `refuses when the secret can't be read, even with no signature settings`.
     - Spy on `h.bus.call` the way the existing pattern at `webhook-router.test.ts:133` does. Make `credentials:get` throw `new PluginError({ plugin: '@ax/credentials', code: 'timeout', message: 'slow' })`.
     - Expect: unsigned delivery 503 `unavailable` (a transient failure the sender retries), warning `routines_webhook_secret_fetch_failed` with `code: 'timeout'`, nothing invoked.
     - Then make it throw `code: 'decrypt-failed'`. Expect 401 `secret` (a per-secret problem a retry can't fix; the owner saves the secret again), the warning with that code, nothing invoked.
     - The transient set is the bus's own codes: `timeout`, `no-service` and `unknown` (any plain thrown error). Every other code, such as `decrypt-failed`, `invalid-envelope` or `unsupported-credential-kind`, is per-secret.
  6. `fences a delivery that saw no secret when one is saved before admission`.
     - The spy's `credentials:get` first awaits the real `routines:set-webhook-secret` (`operation: 'set'`), then throws the `credential-not-found` PluginError.
     - Expect: unsigned delivery 404, nothing queued or invoked, `lastAcceptedAt` still `null`.
  7. `refuses an unverified Slack URL check without queuing it`.
     - With no secret, `{"type":"url_verification","challenge":"c"}` gets 401 and status `refusals: [{ reason: 'secret', count: 1 }]`, with nothing invoked.
     - With the secret saved, a signed Slack challenge gets 200 `{ challenge: 'c' }` and status `{ app: 'slack', verifiedAt: <now>, signatureChecked: false }`.
- [ ] **Step 4: Bring existing tests to the new rule.**
  - `webhook-router.test.ts:86`: the `sha1`/`sha1=` row now expects 401 for a SHA-1-signed delivery and 202 for a SHA-256 hex one.
  - `webhook-router.test.ts:133` expects 503 `unavailable` and the warning with `code: 'unknown'`: its vault throws a plain Error from a service on a real HookBus, which wraps it as `unknown`, a transient failure.
  - `webhook-health.test.ts`: the signed-provider case expects `timestampChecked: true` and the detected `app`. The Slack-verification case expects `app: 'slack'`.
  - `webhook-admission.test.ts` fixtures pass `signature`.
  - `routes.test.ts:113` fixture becomes `app: null, timestampChecked: false`.
  - Every channel-web `getWebhookStatus` mock fixture gains `timestampChecked: false`, and `app` stays a valid enum value or `null`. Find them with `grep -rn "getWebhookStatus" packages/channel-web/src --include='*.test.tsx'`.
    - This includes `TaskAppUpdates.test.tsx:12`. That test renders the real `TaskAppConnection`, whose strict parse rejects a stale fixture.
    - channel-web's `tsc` also checks test files, so `pnpm build` fails at this task's commit unless the fixtures are fixed here, not in Task 5.
  - `provider-signatures.integration.test.ts` must pass unchanged. If it doesn't, the rule is wrong: stop and re-read D1–D3.
- [ ] **Step 5: Build the contract and run.** Run `pnpm --filter @ax/routines-contract build`, then the touched suites. Expected: the new tests FAIL.
- [ ] **Step 6: Implement.**
  - Contract status fields per D6.
  - `webhook-health.ts` per D6:
    - Add `SignatureEvidence = z.object({ app: WebhookDetectedAppSchema, timestamp: z.boolean() })` and `Health.signature: SignatureEvidence.nullable().default(null)`. The empty state includes `signature: null`.
    - `webhookStatus` returns `app: value.signature?.app ?? null` and `timestampChecked: value.signature?.timestamp ?? false`.
    - Delete the `spec.hmac?.app` read.
  - Admission: thread `signature` into `writeWebhookObservation`.
  - Handler: replace lines 59–77 with D2, then D1, then `verifyWebhookDelivery`, giving `signature`.
    - `observe(observation, signature?)`.
    - D7 replaces the `trigger.hmac.app === 'slack'` test.
    - Pass `signature` to `admit`.
    - Import `PluginError` from `@ax/core`.
    - Comment: "Whether a signing secret is saved decides (TASK-1026). Settings saved before then keep checks on; their values are ignored."
  - `webhook-signature.ts`: delete `verifyWebhookSignature`.
    - Move the surviving old tests to `verifyWebhookDelivery`: Slack's published vector, Stripe rotation, Zendesk's UTF-8 secret, malformed timestamps, byte-exact signing, inherited headers.
    - The moved inherited-header case (`webhook-signature.test.ts:19-27`) keeps its own `constructor`/`__proto__` header with a valid digest. That now gives `{ app: 'other', timestamp: false }`, and the inherited variant gives `null`.
    - Delete `preserves custom SHA1/SHA256, optional prefixes and case handling`. Decision 3 removes SHA-1, and Task 2 covers prefix and case.
  - `TaskAppConnection.tsx`: use `const apps: Record<WebhookDetectedApp, string> = { stripe: 'Stripe', slack: 'Slack', zendesk: 'Zendesk', github: 'GitHub', linear: 'Linear', other: 'Signed app' }`. The connected line uses `status.app === null ? 'App' : apps[status.app]`.
    - Its test fixture gains `timestampChecked: false`.
    - Add `names the detected app`: `app: 'linear'` plus accepted shows 'Linear connected'; `app: null` shows 'App connected'.
- [ ] **Step 7: Rebuild and run.** Run `pnpm --filter @ax/routines-contract build` again (the contract changed in Step 6), then these, then `pnpm build` (channel-web's tsc includes tests). Expected: PASS.
  - `pnpm --filter @ax/routines-contract test`
  - `pnpm --filter @ax/routines test`
  - `pnpm --filter @ax/routines-admin-routes test`
  - `pnpm --filter @ax/channel-web test -- TaskAppConnection`
- [ ] **Step 8: Commit:** `feat(routines): verify app updates by saved secret and detected format`.

### Task 5: Task page — secret up front, honest connection status [tier: integration]

**Files:**
- Modify: `packages/channel-web/src/components/workspace/TaskAppUpdates.tsx:43-51`
- Modify: `packages/channel-web/src/components/workspace/TaskAppConnection.tsx:7-16, 36-40`
- Test: `__tests__/TaskAppUpdates.test.tsx`, `__tests__/TaskAppConnection.test.tsx`

**Interfaces:**
- Consumes: the status fields `app`, `signatureChecked` and `timestampChecked` (Task 4); an own-status read that answers for tasks without legacy settings (Task 3).

**Exact copy (typographic apostrophes, as the files use):**

`TaskAppUpdates`:
- **Secret row.**
  - Render `CredentialSlotRow` with `slot={{ label: 'Signing secret', kind: 'api-key' }}` whenever `row.permissions.manageSecret`, with no `hmac` condition. Place it directly after `WebhookAddressFields`.
  - Without `manageSecret`, keep "Signing secret management is currently unavailable."
- **Help** (muted, always): "Paste the signing secret from the other app’s webhook settings. Once it’s saved, we recognize the app and turn away updates whose signature doesn’t match. Without a secret, updates aren’t checked."
- **Legacy note** (muted, only when `row.webhook.hmac !== undefined`): "This task was set up to always check signatures, so without a saved secret its updates are turned away."
- **Delete:** "Signature verification is recommended. Choose the app in Edit app setup, then save its signing secret here."

`TaskAppConnection`:
- **Connected line:** `{name} connected · last accepted update {time} · {check}`.
  - If `signatureChecked` and `timestampChecked`: `'signature checked'`.
  - If `signatureChecked` and not `timestampChecked`: `'signature checked, no timestamp'`.
  - Otherwise: `'signature not checked'`.
- **Honesty line** (muted, when `lastAcceptedAt && signatureChecked && !timestampChecked`): "This app doesn’t sign the time it sent each update, so we can’t spot an old update that’s sent again."
- **Verified line:** `{name} address verified {time} · Waiting for the first update`.
- **`reasons.signature`:** `'the signature didn’t match. Check the signing secret'`.

- [ ] **Step 1: Write the failing tests.**
  - `shows the signing secret right under the address for a task with no signature settings`:
    - Use the row `webhook: { kind: 'webhook', path: '/updates' }`. The mocked `CredentialSlotRow` renders and follows the 'Webhook URL' field in DOM order. The help sentence is present.
    - None of these appear: a 'Verify signature' switch, an 'App' radio group, `/Choose the app/`, the legacy note.
  - `explains that a legacy task always checks signatures`: with `hmac: { app: 'slack' }`, the legacy note is visible.
  - `says when a signature had no timestamp`, with `lastAcceptedAt` set:
    - `{ signatureChecked: true, timestampChecked: false, app: 'github' }` shows 'GitHub connected', 'signature checked, no timestamp' and the honesty line.
    - `{ signatureChecked: true, timestampChecked: true, app: 'stripe' }` shows 'signature checked' and no honesty line.
    - `signatureChecked: false` shows 'signature not checked'.
  - Update `does not call a verified Slack address…` to expect 'Slack address verified'.
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-web test -- TaskAppUpdates TaskAppConnection`. Expected: FAIL.
- [ ] **Step 3: Implement** with the elements the files already use (`FieldGroup`, `<p className="text-sm text-muted-foreground">`). Add no new components.
- [ ] **Step 4: Run** again; PASS. Optionally get an advisory `ux-design` read of the three new sentences.
- [ ] **Step 5: Commit:** `feat(channel-web): paste the signing secret right under the app address`.

### Task 6: Editors — no app picker anywhere [tier: integration]

**Files:**
- Delete: `packages/channel-web/src/components/routines/WebhookSignatureFields.tsx`
- Modify: `packages/channel-web/src/components/workspace/TaskForm.tsx` (import :46, copy :449, block :502-511)
- Modify: `packages/channel-web/src/components/routines/RoutineEditor.tsx` (import :42, block :482-496)
- Modify: `packages/channel-web/src/components/workspace/task-form-helpers.ts:120-187`
- Modify: `packages/channel-web/src/components/routines/RoutinesList.tsx:362-374`, `TriggerChip.tsx:19`
- Test:
  - `workspace/__tests__/TaskForm.test.tsx:339-347`
  - `routines/__tests__/RoutineEditor.test.tsx:176-188, 432-435`
  - `routines/__tests__/RoutineEditor.methods.test.tsx:28-73, 100-102, 300-306`
  - `src/__tests__/routines-list.test.tsx:135-141`
  - any test expecting `(hmac)` in a trigger summary

- [ ] **Step 1: Write the failing tests.**
  - `has no signature controls`, in TaskForm with More options open and in RoutineEditor with Optional settings open. None of these appear: a 'Verify signature' switch, an 'App' radio group, 'Signature header', 'Signature algorithm', 'Signature prefix'.
  - `saves a legacy signature setting back unchanged`:
    - Edit a task in taskMode whose webhook is `{ kind: 'webhook', path: '/original', events: ['push'], hmac: { header: 'X-Signature', algorithm: 'sha256', prefix: 'sha256=' } }`.
    - Set Address name to `/renamed`, then Save. `patch.webhook` must `toStrictEqual` `{ ...webhook, path: '/renamed' }`, with `hmac` kept.
    - Do the same in the Settings RoutineEditor with `hmac: { app: 'stripe' }`.
  - TaskForm create (:339): drop the switch click and expect `webhook: { kind: 'webhook', path: '/digest', events: ['push', 'release'] }`.
  - `reloads saved updates…` (methods test, ~300): the copy becomes 'Its address is under More options. Save the app’s signing secret on the task page.' Drop the 'Signature header' and 'Signature prefix' assertions there and at :100-102.
  - Delete the `app signature settings` describe block (methods test :28-73) and `explains owner signing-secret setup to a member configuring HMAC` (RoutineEditor.test :176-188). Drop the 'Verify signature' and 'Signature header' steps at :432-435.
  - routines-list: a webhook routine without `hmac` shows 'Signing secret' to an owner with `manageSecret`.
  - TriggerChip: a webhook with `hmac` summarizes as `webhook /hook`, with no `(hmac)`.
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-web test -- TaskForm RoutineEditor routines-list`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Delete the component, its imports and the `register('signature')` wrapper with its `fieldError('signature')`.
  - In `TaskForm.tsx:449`, the `hasAddress` copy becomes 'Its address is under More options. Save the app’s signing secret on the task page.'
  - `task-form-helpers.ts`:
    - Remove `'signature'` from `TASK_FIELDS`, `MORE_OPTIONS_FIELDS` and `FALLBACK`.
    - `taskField` maps `trigger.hmac*` and `webhook.hmac*` to `'updates'`.
    - `fieldHasControl` drops its `signature` case.
  - RoutinesList renders the secret row when `row.webhook !== null && row.permissions.manageSecret`, labeled 'Signing secret'.
  - TriggerChip returns `` `webhook ${t.path}` ``.
  - Leave the `lib/routines.ts` field lists alone, since the host can still name `webhook.hmac`.

  The draft keeps a stored `hmac` untouched because nothing edits it. Don't strip it.
- [ ] **Step 4: Run** the full `pnpm --filter @ax/channel-web test`, then `pnpm build`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(channel-web): remove the app picker from the task form and routine editor`.

### Task 7: Agents neither see nor send signature settings [tier: sensitive]

**Needs `security-checklist`:** this is model-output validation on the agent tool surface.

**Files:**
- Modify: `packages/routines-contract/src/tools.ts`
  - `:242-247`: delete `hmac` from the webhook trigger JSON
  - `:13`: refine the create definition
  - `:25-37`: refine the update patch
- Modify: `packages/routines-contract/src/definition.ts:65-75` (comments only)
- Modify: `packages/routines/src/tools.ts`
  - `:243-247` (`listToolView`)
  - `:302` (the `routine_get` output)
- Test: `packages/routines-contract/src/__tests__/webhook-signature.test.ts`
- Test: `packages/routines/src/__tests__/tools.test.ts`
- Test: `packages/routines/src/__tests__/canary.test.ts:60, :311`

- [ ] **Step 1: Write the failing tests.**
  - In `webhook-signature.test.ts` (contract), keep Ajv `advertisedCreate` and add `advertisedUpdate` from `RoutineToolJsonSchemas.routine_update`.
    - `stops advertising signature settings`: `webhook.hmac` of `{ app: 'stripe' }` or `{ header: 'X-Signature' }` is refused by both Ajv validators. Without it, both accept.
    - `refuses signature settings from an agent but still parses saved ones`:
      - `RoutineCreateToolInputSchema.safeParse` with `definition.webhook.hmac` fails, with issue path `['definition', 'webhook', 'hmac']`.
      - `RoutineUpdateToolInputSchema` with `patch.webhook.hmac` fails at `['patch', 'webhook', 'hmac']`. So does the legacy `patch.trigger` webhook with `hmac`, which normalizes to `webhook`.
      - `RoutineDefinitionSchema`, `RoutinePatchSchema` and `WebhookHmacSchema` still accept both legacy shapes. Keep the existing round-trip assertions; delete the old Ajv `{app}`-accepted assertions.
  - In `tools.ts` tests (routines), add `hides legacy signature settings from the agent`. Create a task with `hmac` through `routines:create`. The webhook objects returned by `tool:execute:routine_get` and `tool:execute:routine_list` have no `hmac`.
  - In `canary.test.ts:60`, drop `hmac` from the tool-created definition. The routine saves a secret at :70, and its `x-signature: sha256=` delivery verifies by detection. At :311, expect the get output to equal `changed` with `webhook.hmac` removed.
- [ ] **Step 2: Run** `pnpm --filter @ax/routines-contract test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Delete the `hmac` property.
  - Add the agent-only refinements. Follow the `RoutineUpdateToolPatchSchema` pattern (TASK-906) and refine the parsed output's `webhook?.hmac`. Use the message "Signature settings can’t be set here. The person pastes the app’s signing secret on the task page." The model sees the fixed template plus `Field: webhook.hmac`, which is already in core's field list.
  - Add `withoutSignatureSettings(view)`, which returns the view with `webhook` minus `hmac`. Apply it in `listToolView`, which covers list and update, and to the `routine_get` output.
  - Contract comments on `CustomWebhookHmacSchema`/`WebhookHmacSchema`: "Saved before TASK-1026. Still parsed so saved tasks keep working; the host detects the signing format, ignores these values, and their presence keeps signature checks on. Nothing authors them now."
- [ ] **Step 4: Build and run.** Run `pnpm --filter @ax/routines-contract test`, then `pnpm --filter @ax/routines-contract build`, then `pnpm --filter @ax/routines test -- src/__tests__/tools.test.ts src/__tests__/canary.test.ts`. Expected: PASS. Routines picks up the refinements only from the rebuilt `dist/`.
- [ ] **Step 5: Commit:** `feat(routines-contract): agents no longer see or author webhook signature settings`.

### Task 8: Stale prose (rule 5) [tier: mechanical]

**Files:**
- Modify: `docs/plans/2026-10-20-agent-tasks-design.md`
  - `:581-582` (§5.2 step 2)
  - `:584-585` (§5.2 status example)
  - `:617` (§5.3 HMAC row)
  - `:652-655` (§5.4 bullet)
  - the §15 table after `:1172`
- Modify: `deploy/MANUAL-ACCEPTANCE.md:729-795` ("Steps — HMAC variant" and its acceptance bullets)

- [ ] **Step 1: Edit the design doc.**
  - §5.2 step 2 becomes: "Check it's really that app (recommended): paste the app's signing secret. The host works out which app sent each update from its headers (TASK-1026)."
  - Append to the status example: "Apps that sign only the body, like GitHub and Linear, show 'signature checked, no timestamp'."
  - The §5.3 row becomes: `| HMAC header, algorithm, prefix | Paste the app's signing secret; the host detects the format (TASK-1026). Settings saved earlier still load but only keep checks on. |`.
  - Append to the §5.4 bullet: "(TASK-1026 replaced the per-app table with detection: no picker, SHA-256 only.)"
  - Add a §15 row: `| 2026-11-02 | Implemented (TASK-1026) | Webhook signatures are paste-the-secret only. A saved secret (or a setting saved earlier) turns checks on; the host verifies Stripe, Slack and Zendesk by their timestamped protocols and everything else by an HMAC-SHA256 of the body in any header. The app picker and header/algorithm/prefix fields are gone from the task form, routine editor and agent tools. |`
- [ ] **Step 2: Rewrite the MANUAL-ACCEPTANCE HMAC variant.**
  - Step 1: open the task's page, App updates, paste `shhh-test-secret` into **Signing secret**, Save. There are no signature settings to choose.
  - Set `URL=` to the address copied from the same row.
  - Keep the three curl checks (no signature 401, wrong 401, correct `X-Hub-Signature-256` 202) against `$URL`.
  - Add a fourth check, `-H "Linear-Signature: $(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')"`, expecting 202 and a task page showing "Linear connected … signature checked, no timestamp".
  - Update the acceptance bullets to match: no secret means 202; with a secret, missing or wrong means 401 and GitHub or Linear means 202.
- [ ] **Step 3: Grep for leftovers.** Run `grep -rnE "Edit app setup.*choose|Choose the app|Verify signature|Signature header|pick the app" docs deploy packages --include='*.md' --include='*.ts' --include='*.tsx'`. Expected: hits only in dated plan or mockup files, the shard and tests asserting absence.
- [ ] **Step 4: Commit** `docs: webhook signatures are paste-the-secret only (TASK-1026)` together with `.claude/memory/decisions/2026-11-02-TASK-1026.md`.

### Final verification

- [ ] `pnpm build && pnpm lint && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`. All three suites must be green. A Docker teardown timeout in `@ax/auth-better` with all assertions passing is the known local flake (CLAUDE.md); confirm it with its counts, don't hide it.
- [ ] `scripts/memory-append-check.sh` passes (new shard only, no archive edits).
- [ ] PR description: security note, boundary review, D9 list and rollback note (see "PR obligations").
