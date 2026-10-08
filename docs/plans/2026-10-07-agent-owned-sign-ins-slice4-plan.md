# Agent-owned sign-ins — Slice 4 ("Signed in as") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- An agent's connector row shows which account the agent acts as: "Gmail · bob@canopyworks.com".
- When the provider doesn't tell us, the row shows who signed it in and when: "Signed in by Vinay on 7 Oct".
- After **Sign in again**, if the account changed, the row says "Now bob@… (was alice@…)".

**Architecture:**
- **Capture.** After the token exchange, the mcp-oauth callback works out a display identity, best effort:
  1. an `openid`/`email` scope is requested when the authorization server advertises it;
  2. the identity is read from the `id_token` the token endpoint returned;
  3. otherwise from a guarded `userinfo` GET;
  4. otherwise none.
- **Storage.** The identity is stored in the credential's encrypted envelope **metadata** (`credentials:set {metadata}`), next to `signedInBy` and `signedInAt`. That's not the token blob. The vault keeps metadata across refreshes, and `credentials:list` returns it for one agent in one prefix scan without resolving or refreshing a token.
- **Read path.** `mcp-oauth:status-batch` returns those fields per connector. channel-web's `connectorHealth` resolves `signedInBy` to a display name and adds the fields to each rail row. The client renders them as text.

**Tech Stack:** TypeScript, vitest, Postgres via testcontainers, React + shadcn (channel-web), `@modelcontextprotocol/sdk` 1.32.1 (`OAuthTokensSchema` keeps `id_token`).

**Spec:** `docs/plans/2026-10-07-agent-owned-connector-sign-ins-design.md`: §2 "Identity capture", the `status-batch` bullet, "Agent rail › Connectors" (Rows), Boundary review, Security, and Testing › Identity. **Prereqs:** slices 1–3. This branch stacks on `feat/agent-owned-sign-ins-3`.

## Global Constraints

- **No cross-plugin imports (invariant 2).** Mirror types locally. Every hook called is declared in the manifest (`calls` or `optionalCalls`), and absent optional hooks degrade cleanly.
- **No half-wired code (invariant 3).**
- **UI uses shadcn and semantic tokens (invariant 6).** Invoke the `shadcn` skill before UI work. Copy is plain, short and warm.
- **Provider-reported identity is untrusted text.**
  - It's for display only and never used for an access decision.
  - Strip control characters: Unicode category Cc, plus the bidi controls U+200E, U+200F, U+202A–U+202E and U+2066–U+2069.
  - Trim it, cap it at **254** characters, and treat an empty result as `null`.
  - Render it as a React text node only. Never use `dangerouslySetInnerHTML` or put it in an attribute that's interpreted.
- **The `id_token` signature isn't checked.** It came straight from the token endpoint over TLS, and it's used for display only (OIDC Core §3.1.3.7). It is never used for authz.
- **Field names are storage-agnostic:** `account`, `signedInBy`, `signedInAt`.
- **Copy:**
  - With an account: "Signed in as {account}".
  - Without one: "Signed in by {name} on {d MMM}". Name is "you" when it's the viewer, else the display name, else email, else "someone".
  - After an account change: "Now {new} (was {old})".
- `export DOCKER_HOST=unix:///var/run/docker.sock AX_TESTCONTAINER_START_SLOT_WAIT_MS=120000`. The host is heavily loaded: re-run a timing-out Docker file alone with `--no-file-parallelism` before calling it red. Use `pnpm --filter <pkg> test` with the filter first. Check tsc per package, and run eslint.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Rulings carried in

- **The identity lives in envelope metadata only, not also in the token blob.** Nothing reads it from the blob, and the blob can't be read without a resolve. Cost if wrong: a later reader needing it beside the token adds one field.
- **The scope add-on.**
  - Append `openid` when the AS metadata `scopes_supported` includes it, and `email` when it includes that too.
  - Do this only for scopes not already present, and only from the **authorization server** metadata (not the protected-resource metadata).
  - It applies to the authorize request and the pending row. It does **not** apply to the dynamic-registration scope: registration keeps today's scope, so an existing registered client isn't invalidated.
  - Cost if wrong: an AS that rejects `openid` on a client registered without it fails the sign-in. The kind walk (slice 7) confirms against real Linear.
- **The `userinfo` fallback is tightly guarded.** If there's no usable `id_token`, the callback does one GET with `Authorization: Bearer <access token>` only when all of these hold:
  - the metadata advertises an `https:` `userinfo_endpoint`;
  - its host is in the connector's `allowedHosts`.

  The GET follows **no redirects** (any 3xx counts as no identity), uses a **5 s timeout**, and reads at most **64 KiB**. Any failure means `account: null`, and it never fails the sign-in. That keeps the bearer token from following a redirect and from going anywhere the connector can't already reach.
- **`status-batch` gains a `signIns` map** and keeps its existing `needsReconnect` and `shared` lists. Changing the existing lists' shape would ripple through every caller for no gain.
- **Display names are resolved in channel-web** (`auth:get-user`, optional, de-duplicated, fail-soft). They're not stored, because display names change. Mirror the `proposerLabel` pattern in `packages/connectors/src/admin-routes.ts:559-578`.
- **A sign-in from before slice 4 has no metadata.** The row shows neither line, just the existing health. There's no backfill.

## Review Focus

- **An `id_token` with a hostile `email`** (2,000 characters, embedded `‮`, newlines, `<script>`): stored capped and stripped, and rendered as literal text. Tests in Tasks 1 and 3.
- **A malformed `id_token`** (not three parts, bad base64url, non-JSON payload, payload a JSON array, `email` a number): `account` is `null` (or falls to the next claim), and the sign-in still succeeds. Test in Task 1.
- **A `userinfo` endpoint that redirects, hangs, is off-allowlist, or returns 10 MB:** no identity, the sign-in succeeds, and the bearer token isn't sent to the redirect target. Test in Task 1.
- **A token refresh after sign-in:** the account label survives. Test in Task 1, resolver plus vault metadata.
- **Two agents of one owner signed in as different accounts:** each row shows its own account, and one agent's `credentials:list` never returns the other's. Test in Task 2.

---

### Task 1: mcp-oauth — request `openid`/`email`, capture identity, store it as credential metadata

**Files:**
- Create: `packages/mcp-oauth/src/identity.ts`, a pure module:
  - `sanitizeAccount(raw: unknown): string | null`
  - `accountFromIdToken(idToken: unknown): string | null`
  - `fetchUserinfoAccount(...)`
- Modify:
  - `packages/mcp-oauth/src/routes.ts`: begin's scope at ~:585 (the add-on goes into the authorize request and the pending row, **not** `ensureClient`'s registration scope at ~:595); the callback blob and write at ~:889-944.
  - `packages/mcp-oauth/src/oauth-flow.ts`, if a typed accessor for `scopes_supported` / `userinfo_endpoint` belongs there. `AuthorizationServerMetadata` needs a narrow cast; see the precedent at `routes.ts:629`.
- Tests:
  - `packages/mcp-oauth/src/__tests__/identity.test.ts` (new);
  - `routes.test.ts` (fakeFlow ~:122-140, happy path ~:1404-1550);
  - `oauth-flow.test.ts` (:162-275);
  - `resolver.test.ts` (:138 pattern);
  - an e2e through the real vault proving metadata survives a refresh (`e2e.test.ts`, or the credentials-backed suite that already round-trips a refresh).

**Interfaces:**
- **Produces:**
  - The `credentials:set` call in the callback gains `metadata: { account: string | null, signedInBy: string, signedInAt: string }`, where `signedInBy` is `pending.userId` and `signedInAt` is ISO 8601 from the injected `now()`.
  - Task 2 reads these exact keys from `credentials:list` metadata.

**Requirements:**
1. **`sanitizeAccount`**: non-string → `null`. Strip the characters listed in Global Constraints, trim, cap at 254 (by code points; don't split a surrogate pair), empty → `null`.
2. **`accountFromIdToken`**:
   - Split on `.`, and require exactly 3 parts.
   - base64url-decode the payload, `JSON.parse` it, and require a plain object.
   - Return the first non-null `sanitizeAccount` of `email`, `preferred_username`, `sub`.
   - Any error → `null`, without throwing.
   - Don't verify the signature (Global Constraints), and say so in a comment.
3. **`fetchUserinfoAccount({ endpoint, accessToken, allowedHosts, fetchImpl, timeoutMs = 5000, maxBytes = 65536 })`**:
   - Only `https:`, only a host in `allowedHosts`, `redirect: 'manual'` with any non-2xx → `null`.
   - Abort after the timeout. Read the body up to `maxBytes` (abort beyond).
   - Then parse it and take the same claims as the `id_token`.
   - Never throws, and never logs the token. Inject `fetchImpl` for tests.
   - Use the codebase's existing SSRF/IP guard if it can be told not to follow redirects (check `ssrf.ts` `safeFetch`). Otherwise use `fetch` with `redirect:'manual'` after the same private-IP check `safeFetch` uses. Don't re-implement DNS logic. Record which one you chose in your report.
4. **Begin scope.** Compute `requestScope` = the existing scope plus `openid` / `email` per the ruling, de-duplicated and space-joined. Use it for `buildAuthorization` and the pending row's `scope`. Registration keeps the old scope.
5. **Callback.** After `redeemCode`:
   - `account = accountFromIdToken(tokens.id_token)`;
   - if `null` and the metadata has `userinfo_endpoint`, `account = await fetchUserinfoAccount(...)`.

   Pass `metadata` on the `credentials:set`. The step order is otherwise unchanged. An identity failure never changes the outcome or the `reason`.
6. **Refresh.** Prove (a test, plus a fix only if needed) that a vault refresh keeps the envelope metadata. The vault uses `out.refreshed.metadata ?? env.metadata` (`packages/credentials/src/plugin.ts:714-715`). The resolver must not return a `metadata` that erases it.

**Tests (write first):**
- `sanitizeAccount`: control characters, bidi characters, the 254 cap, a surrogate pair at the boundary, non-string, empty.
- `accountFromIdToken`: email present; only `preferred_username`; only `sub`; the malformed cases from Review Focus; a hostile email.
- `fetchUserinfoAccount`:
  - happy path;
  - 302 → `null`, and the fake records that no second request was made;
  - a host off the allowlist → no request at all;
  - a timeout → `null`;
  - an oversized body → `null`;
  - `http:` → `null`;
  - non-JSON → `null`.
- **Begin:**
  - `scopes_supported` with openid and email → the authorize URL scope contains both, once each;
  - without them → unchanged;
  - the registration call's scope is unchanged.
- **Callback:**
  - `id_token` email → metadata account;
  - no `id_token` plus a userinfo email → account;
  - neither → `account: null`;
  - `signedInBy` and `signedInAt` are set;
  - an identity error doesn't change the success redirect.
- **Refresh keeps metadata** (real vault).

Commit: `mcp-oauth: remember which account each agent signed in as`.

### Task 2: status-batch returns sign-in identity; the rail rows carry it

**Files:**
- Modify:
  - `packages/mcp-oauth/src/plugin.ts`: status-batch types and schema :98-129, handler :474-492, manifest :251-263 (`credentials:list` must be declared even when routes aren't mounted, since status-batch is always registered; use `optionalCalls` and degrade to an empty map).
  - `packages/channel-web/src/server/routes-workspace.ts`: `connectorHealth` :3922-4046, the status-batch mirror type :1832-1836, the `connectors` route merge :6992-7032.
  - `packages/channel-web/src/server/plugin.ts`: add `auth:get-user` to `optionalCalls` if it isn't there.
  - `packages/channel-web/src/lib/workspace-types.ts:1096-1118` (`AgentConnectorRow`).
- Tests:
  - `packages/mcp-oauth/src/__tests__/plugin.test.ts` (:200-470), `e2e.test.ts`;
  - `packages/channel-web/src/__tests__/server/routes-workspace-connectors.test.ts` (:307-800).

**Interfaces:**
- **Consumes:** Task 1's metadata keys.
- **Produces:**
  - `StatusBatchOutput` gains `signIns: Record<string, { account: string | null; signedInBy: string | null; signedInAt: string | null }>`. Its keys are the requested connector ids with an agent-scope `account:<id>` row carrying the metadata. It's present only when `agentId` was given, else `{}`.
  - `AgentConnectorRow` gains `signedIn?: { account: string | null; byName: string | null; byYou: boolean; at: string | null }`.

**Requirements:**
1. **status-batch**, when `agentId` is given and `credentials:list` exists:
   - Call `credentials:list {scope:'agent', ownerId: agentId}` once.
   - Keep rows whose `ref` is exactly `account:<id>` for a requested id. A key slot looks like `account:<id>:<slot>`, so exclude it.
   - Read the three metadata keys defensively. A non-string value is treated as `null`, and `account` is re-sanitized with Task 1's `sanitizeAccount` (the same plugin, so it's imported, not mirrored).
   - Any error from `credentials:list` → `signIns: {}` plus one warn log with no metadata values.
   - Update the output zod schema.
2. **channel-web `connectorHealth`:**
   - Read `signIns`, collect the distinct `signedInBy` ids, and resolve each once via `auth:get-user`: display name, else email, else `null`. Fail soft.
   - Build `signedIn` per row, with `byYou = signedInBy === callerUserId`.
   - **A member of a team agent sees `signedIn` too** (spec: "Members see who the agent acts as").
   - **Health read invariant:** the test at `routes-workspace-connectors.test.ts:~719` ("health read never resolves a credential") must still pass. `credentials:list` doesn't resolve.
3. Never put the account into logs.

**Tests (write first):**
- status-batch returns `signIns` for a sign-in row with metadata.
- It excludes `account:<id>:<slot>` key rows and other agents' rows. The two-agents case uses the real vault in e2e: agent A's batch never contains B's account.
- A row without metadata gives `signIns[id] = {account:null, signedInBy:null, signedInAt:null}`. It's still keyed, because the row exists.
- A missing `credentials:list` → `{}`, and a throw → `{}` plus a warn.
- channel-web:
  - the rows carry `signedIn` with the resolved name;
  - `byYou` is true for the viewer;
  - `auth:get-user` throwing → `byName: null`;
  - one `auth:get-user` call per distinct user;
  - a member sees `signedIn`;
  - the "never resolves a credential" test still passes.

Commit: `connectors rail: rows know which account their agent signed in as`.

### Task 3: channel-web client — "Signed in as", "Signed in by", and "Now X (was Y)"

**Files:**
- Modify:
  - `packages/channel-web/src/components/workspace/AgentConnectors.tsx` (row :362-373, sign-in-again success :441-455, notice state ~:237);
  - `components/workspace/ConnectorDetails.tsx` (`ConnectionLine` :331-375; replace the stale "signed in as you" at :357);
  - `lib/workspace-time.ts` (add or export a `shortDay(iso)` → "7 Oct" in the reader's locale; reuse or move the private `grantedDay` from `components/workspace/bits.tsx:484-489`, keeping one helper);
  - `lib/agent-connectors.ts` (if `refresh` must expose the new rows).
- Tests:
  - `components/workspace/__tests__/AgentConnectors.test.tsx`, `ConnectorDetails.test.tsx`, `lib/__tests__/workspace-time.test.ts`, `lib/__tests__/agent-connectors.test.ts`.

**Interfaces:**
- **Consumes:** Task 2's `AgentConnectorRow.signedIn`.

**Requirements:**
1. **Rail row.**
   - When `signedIn?.account`, render `{name} · {account}`. The account goes in a separate span: `text-muted-foreground`, truncated, with the full value in `title`.
   - Otherwise just the name.
   - Rows without `signedIn` are unchanged.
2. **Details `ConnectionLine`.**
   - With an account: "Signed in as {account}".
   - Without one, but with `at`: "Signed in by {you | byName | someone} on {shortDay(at)}".
   - With neither: keep today's line minus "as you".
   - The stale "signed in as you" goes.
3. **Sign in again success.**
   - Remember the row's old `signedIn.account` when the dialog opens.
   - After the refresh, if the new account is non-null and differs from a non-null old one, show the existing notice surface with "Now {new} (was {old})".
   - If the old account was null, or they're equal, show no notice.
   - Implement the comparison deterministically, e.g. `refresh()` returns a promise of the new rows, or an effect keyed on the pending id. Don't use timers.
4. Every provider string is rendered as a text node.

**Tests (write first):**
- A row shows "Gmail · bob@x.com".
- A hostile account (`<img src=x onerror=alert(1)>`, with `‮`) renders as literal text, and no `img` element exists.
- Details: "Signed in as …"; "Signed in by you on 7 Oct" (fixed date, fixed locale in the test); "Signed in by Vinay on …"; "someone" when the name is null.
- Sign in again with a different account → the notice "Now b@x (was a@x)"; the same account → no notice; old null → no notice.
- `shortDay` formats correctly; `bits.tsx` uses the shared helper.

Commit: `channel-web: connector rows say which account the agent uses`.

### Task 4: Gate + memory

- [ ] Run the full gate: `pnpm build && pnpm lint && pnpm -r --workspace-concurrency=2 --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`. Re-run Docker-timeout packages alone.
- [ ] Write the decisions shard (`scripts/memory-write-target.sh --shard decisions SIGNINS-6`). Record:
  - envelope metadata, not the blob;
  - the scope add-on excludes registration;
  - the userinfo guard (no redirects, allowlist, 5 s, 64 KiB);
  - `signIns` as an added map;
  - display names resolved at read time;
  - no backfill.
- [ ] Commit `memory: decisions shard for agent-owned sign-ins slice 4`.
