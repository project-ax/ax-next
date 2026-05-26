# Phase 3 Implementation Plan — OAuth slice (credentials:get reshape, per-kind resolvers, proxy:rotate-session plumbing)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Anthropic OAuth a usable auth path end-to-end. Three structural pillars carry the weight:

1. **Reshape `credentials:get` / `:set` / `:delete`** from the Phase 1b "monolithic by id" shape to `(ctx, { ref, userId, kind? })` with per-kind dispatch in the facade.
2. **`@ax/credentials-anthropic-oauth` plugin** — first per-kind sub-service. Owns PKCE login, token exchange, and refresh-if-needed (`credentials:resolve:anthropic-oauth`).
3. **`proxy:rotate-session` plumbing in the orchestrator** — the hook is already registered in `@ax/credential-proxy` (Phase 1a); Phase 3 adds the orchestrator call site so long OAuth sessions can pick up refreshed tokens without re-launching the sandbox.

A user-visible `ax-next credentials login anthropic` CLI command and the supporting wiring close the loop.

**Architecture:**

- `@ax/credentials` becomes a dispatcher. `credentials:get(ctx, { ref, userId })` reads `(userId, ref)` from store-blob, decrypts, looks at `kind`. If a `credentials:resolve:<kind>` sub-service is registered, dispatch to it for refresh-if-needed; otherwise return the decrypted value as-is (api-key path). A per-blob async mutex (`Map<key, Promise>`) serializes concurrent resolves of the same blob so only one refresh fires.
- `@ax/credentials-store-db` gains a `(userId, ref)` storage key shape. The encrypted blob value embeds `{ kind, expiresAt?, metadata?, payload }` so per-kind sub-services can interpret `payload` themselves. No Kysely schema yet — `expiresAt` lives inside the encrypted blob, refresh checks happen lazily on `credentials:get`. Background sweeps are deferred (design Section 8 open question; not blocking MVP).
- `@ax/credentials-anthropic-oauth` registers three hooks: `credentials:login:anthropic-oauth` (PKCE start: build authorize URL + verifier), `credentials:exchange:anthropic-oauth` (code → token blob), `credentials:resolve:anthropic-oauth` (decrypted blob → current access token, refreshing through Anthropic's token endpoint when within 5 minutes of `expiresAt`).
- `@ax/chat-orchestrator` calls `proxy:rotate-session` between internal agent turns (gated on a per-session "has at least one OAuth credential" check; coarse mode is the default for api-key sessions). The placeholder envMap stays stable — the proxy's registry updates the placeholder→real-value mapping in place. We do NOT mint fresh placeholders mid-session (avoids the "running SDK has stale env" problem described in design Section 5).
- `ax-next credentials login anthropic` CLI subcommand stands up an ephemeral 127.0.0.1 listener, opens a browser, exchanges the code, and calls `credentials:set(ctx, { ref: 'anthropic-personal', kind: 'anthropic-oauth', blob, userId })`.

**Tech Stack:**

- TypeScript / Node 20+
- Vitest (`.test.ts` per package)
- `@ax/credential-proxy` + `@ax/credential-proxy-bridge` (Phase 1a, already shipped)
- `@ax/credentials` + `@ax/credentials-store-db` (Phase 1b, already shipped — refactored here)
- Node `crypto` for PKCE (S256 challenge — `randomBytes` + `createHash('sha256')`)
- Node `http` module for the CLI's local-loopback redirect listener
- Node `child_process.spawn` (with arg array, never shell) for the "open browser" helper — never `exec`/template-strings

**Out-of-scope (deferred):**

- Web-chat OAuth UI: `POST /auth/oauth/start` + `GET /auth/oauth/callback` HTTP routes, "Connect Claude Max" button. Phase 10–12 (web-chat) earns it. The per-kind hook surface is identical for web-chat — when it lands, it's an `http:register-route` plus a cookie-keyed state stash, not new sub-services.
- `credentials:list` / `credentials:rotate` (force refresh) hooks. Defer until an admin UI or "switch account" feature earns them.
- Real `@ax/database-*` Kysely-backed credentials-store schema (with `expires_at` column, indexed lookups). Stay in storage:get/set shim shape — the JSON-blob-in-storage scheme handles MVP. Earns weight when background expiry sweeps or per-user listings need it.
- Cross-replica refresh coordination (postgres advisory locks). In-process per-blob mutex covers single-replica deployments. Multi-replica earns it.
- Native runner / `@ax/llm-proxy-anthropic-format` deletion. Still Phase 5/6.
- OpenAI OAuth or any sibling per-kind plugin. Anthropic is enough to prove the seam.

---

## Reference material

ax-next files this plan touches (read before editing):

| File | Why |
|---|---|
| `packages/credentials/src/plugin.ts:42-105` | `credentials:get/set/delete` handlers we're reshaping. The encryption code at lines ~110+ stays; the input/output schemas change. |
| `packages/credentials/src/crypto.ts` (or wherever `encrypt`/`decrypt` live) | AES-256-GCM helpers. Reused as-is around the new blob envelope. |
| `packages/credentials-store-db/src/plugin.ts:69-100` | `credentials:store-blob:put` / `:get` shapes. Storage key prefix gains `userId` segment: `credential:<userId>:<ref>`. |
| `packages/credential-proxy/src/plugin.ts:330-460` | Two `credentials:get` call sites (lines 346, 428) — both update for the new shape. The `proxy:rotate-session` handler stays as-is; only the orchestrator call site is new. |
| `packages/chat-orchestrator/src/orchestrator.ts:609-687, 906-914` | `proxy:open-session` + `proxy:close-session` live here today (Phase 2 lines, confirmed). `proxy:rotate-session` plumbing slots in between turn boundaries — find/establish the runner-emitted turn-boundary signal during Task 10. |
| `packages/cli/src/dev-agents-stub.ts:91-130` | Already returns `kind` on `requiredCredentials` (Phase 2). Add an example agent that uses `kind: 'anthropic-oauth'` for the e2e. |
| `packages/cli/src/commands/credentials.ts` | The `set` subcommand pattern. `login` subcommand mirrors it — async function dispatched from the verb switch. |
| `packages/cli/src/main.ts:131-168` | Where `createCredentialsAnthropicOauthPlugin()` slots in. Same plugin-load pattern as Phase 2's credential-proxy. |
| `presets/k8s/src/index.ts` | Same plugin-load mirror in the k8s preset. |
| `~/dev/ai/ax/src/host/credentials.ts` | **Read-only reference.** v1's OAuth refresh + PKCE helpers — port the token-endpoint client + PKCE verifier/challenge math; do NOT carry over the v1 storage schema or the v1 register-with-kernel shape. |
| `~/dev/ai/ax/src/agent/runner.ts` (auth section) | **Read-only reference.** Confirms which env var name (`CLAUDE_CODE_OAUTH_TOKEN`) the SDK's subprocess CLI honors with `settingSources: []`. Open question §1 of the design — verify before Task 8 lands. |

Reference patterns already in the codebase:

- New plugin scaffold (`package.json`, `tsconfig.json`, manifest, `init`): `packages/credentials-store-db/` (Phase 1b — most recent example)
- `bus.hasService` runtime soft-dep check: `packages/chat-orchestrator/src/orchestrator.ts` (the `proxy:open-session` gating from Phase 2 — same pattern for `proxy:rotate-session` here)
- Real-provider-gated e2e test (skips unless env set): `packages/agent-claude-sdk-runner/src/__tests__/claude-sdk-runner.e2e.test.ts`
- CLI subcommand verb-switch: `packages/cli/src/commands/credentials.ts` (existing `set` verb)

---

## Invariants (verified per task)

These reflect Phase 2's lessons + Phase 1b's "the reshape lands when consumers need it" rationale + Phase 3's new ground.

- **I1 — Real credentials never enter the sandbox process.** [Phase 2 carry-over.] OAuth access tokens, refresh tokens, and PKCE verifiers ALL count as real credentials. Sandbox env continues to carry only `ax-cred:<hex>` placeholders. The CLI's PKCE verifier never crosses any sandbox boundary; the local-loopback listener runs in the same host process as `ax-next`.
- **I2 — No cross-plugin imports.** [Phase 2 carry-over.] `@ax/credentials-anthropic-oauth` registers `credentials:resolve:anthropic-oauth` and friends; `@ax/credentials` calls them via `bus.call`. No `import` from one to the other. The CLI command in `@ax/cli` reaches OAuth purely through `bus.call('credentials:login:anthropic-oauth', ...)`.
- **I3 — Reshape payload field names don't leak backend choice.** The new shape uses `ref` (generic identifier), `kind` (provider-neutral string), `payload` (opaque bytes). No `oauth_token` / `access_token` / `client_id` field names on the facade boundary. Sub-service input/output is allowed to use OAuth-specific fields *internally* (e.g., the OAuth resolve sub-service sees `{ accessToken, refreshToken, expiresAt }` after JSON-decoding the blob) — but the facade's hook surface never names them.
- **I4 — Boundary review for the `credentials:get` reshape recorded in PR description.** Alternate impl (a vault-backed credentials backend that also wants `(userId, ref)` lookup → reshape is forward-compat); leaky names ruled out (`ref` ≠ `id`/`url`/`bucket`); subscriber risk noted (none — no subscribers to `credentials:get`); wire surface flagged (none — in-process facade hook only, NOT exposed on IPC).
- **I5 — Capabilities are explicit.** `@ax/credentials` manifest declares the per-kind dispatch as `calls: ['credentials:resolve:*']` if wildcards are supported, else as a runtime-only check (manifest skips `calls` entries it dispatches dynamically). The new OAuth plugin declares `registers: ['credentials:resolve:anthropic-oauth', 'credentials:login:anthropic-oauth', 'credentials:exchange:anthropic-oauth']`. The CLI declares `calls: ['credentials:login:anthropic-oauth', 'credentials:exchange:anthropic-oauth', 'credentials:set']`.
- **I6 — Half-wired window closes here.** [Phase 2 carry-over.] After this PR: `@ax/credentials-anthropic-oauth` is loaded by the CLI preset and reachable from a (gated) e2e test. PR description must explicitly mark the OAuth seam closed. Phase 1a's Phase 2-side window is already closed (memory `project_phase_2_shipped.md`); this PR opens no new half-wired windows.
- **I7 — Per-blob mutex serializes concurrent `credentials:resolve` calls for the same `(userId, ref)`.** Prevents thundering-herd refreshes when `proxy:open-session` and a concurrent `proxy:rotate-session` (or two parallel sessions sharing the same blob) both ask for the same OAuth credential at the same time. Map `<userId>:<ref>` → `Promise<value>` in the facade; the second caller awaits the same promise.
- **I8 — 5-minute refresh-buffer window prevents mid-flight expiry.** The OAuth resolve sub-service refreshes when `expiresAt - now < 5min`. Prevents handing back a token that expires while a request is in flight (network round-trip + Anthropic-side processing can easily eat 30s; 5min buffer is comfortably above that). This is a Phase 3 design constant; Section 8 calls out we haven't stress-tested it. Task 14 (e2e) doesn't stress-test, but the per-blob mutex is unit-tested for concurrent calls.
- **I9 — Refresh failure surfaces as a structured error, never a silent retry.** [Design Section 4: "What MVP doesn't ship — Silent refresh-failure recovery."] Sub-service throws `PluginError` with a stable code (`oauth-refresh-failed`); facade re-throws; proxy returns 401 to upstream; user sees failure and re-runs `credentials login`. Re-login is explicit, not silent.
- **I10 — `proxy:rotate-session` fires only when at least one OAuth-kind credential is present in the session.** Prevents needless work for api-key-only sessions (no refresh ever needed). Implementation: `agents:resolve` returns `requiredCredentials` with `kind`; orchestrator inspects, sets a `rotateOnTurn: boolean` flag at session-open time; rotate call site is no-op when flag is false. Default behavior for api-key sessions: identical to Phase 2 (coarse mode, no rotation).
- **I11 — `proxy:rotate-session` keeps the placeholder stable; only the registry's placeholder→real-value mapping updates.** Prevents the "running SDK reads stale env" problem. The `envMap` returned by `proxy:rotate-session` carries the same placeholders as `proxy:open-session` returned — the orchestrator can ignore it (or assert equality for sanity). Real-value substitution at request time picks up the refreshed token. Sub-service's `refreshed?: <new-blob>` gets re-stored by the facade; the placeholder doesn't need to change because the `ax-cred:<hex>` is just an opaque pointer into the registry, not a function of the underlying token.
- **I12 — `credentials:get` reshape is a hard cut, not a soft-migration.** [Phase 1b lesson: "Don't reshape speculatively. When you DO reshape, do it cleanly." Memory: `project_phase_1b_shipped.md` — option A vs. option B for the reshape, deferred deliberately to Phase 3.] All call sites update in the same PR. No `id` ↔ `ref` aliasing layer. No backwards-compat shim. Two known call sites (`credential-proxy/plugin.ts:346, 428`) update atomically; if a third surfaces during execution (e.g., mcp-client transport — flagged as possible in the Phase 1b memory but not seen by the Phase 3 survey), it joins the same commit.
- **I13 — PKCE codeVerifier never logs, never crosses a sandbox boundary, never persists.** Stays in the CLI command's local memory between `:login` and `:exchange` calls (a few seconds). Never written to disk; never passed to the runner; never echoed to stderr. The `state` parameter (CSRF-bind for the OAuth round trip) follows the same rule.
- **I14 — Storage key shape change `(userId, ref)` is forward-compatible with multi-user.** Today's CLI uses a hardcoded userId (`dev-agents-stub` returns it as ctx.userId; Phase 9.5 multi-tenant replaces). Phase 3 introduces the `(userId, ref)` key today even though only one userId ever appears in the keyspace; when Phase 9.5 lands, no schema change is needed.

---

## Open questions resolved before execution

1. **Where does the `expiresAt` field live — encrypted blob or unencrypted column?** Encrypted blob, for Phase 3. Design Section 3 calls out unencrypted `expiresAt` as a "background sweep can find tokens about to expire without decrypting" optimization. MVP doesn't have a sweeper; lazy refresh on `credentials:get` reads `expiresAt` post-decrypt. When a real Kysely schema lands, `expiresAt` migrates out as a queryable column. Cost of moving it later: a one-time migration. Cost of premature column today: a real schema we don't otherwise need yet.
2. **`credentials:get` input shape — `{ ref, userId }` or `{ ref }` with userId from ctx?** Explicit `{ ref, userId }`. AgentContext carries `userId`, but the OAuth callback handler (deferred Phase) and admin-CLI scenarios both want to specify a userId distinct from the calling context. Explicit is more flexible AND removes ambiguity at call sites; the cost (one extra field) is negligible. Most callers pass `userId: ctx.userId`.
3. **`credentials:set` blob format — opaque `Uint8Array` or `{ kind, payload }` envelope?** Envelope. The facade adds `{ kind, expiresAt?, metadata?, payload }` JSON-then-encrypt around whatever the per-kind sub-service produces. This way `credentials:get`'s dispatch logic can read `kind` post-decrypt without an extra storage column. The Phase 1b store-blob seam stays as-is (opaque bytes); the envelope is purely a facade-internal format. Per-kind sub-services see only `payload` after the facade unwraps.
4. **Per-blob mutex granularity — global, per-userId, or per-(userId, ref)?** Per-(userId, ref). Two different users refreshing different OAuth blobs should run in parallel; two callers refreshing the same blob should serialize. Map key: `${userId}:${ref}`.
5. **`proxy:rotate-session` trigger — timer, IPC event, or per-tool-call?** IPC event from the runner — the agent runtime emits a turn-boundary signal that the orchestrator subscribes to. Need to confirm during Task 10 that the runner already emits something usable; if not, the runner gains a small "I'm between turns" emission. Timer-based fallback is rejected (too coarse, fires regardless of activity). Per-tool-call is rejected (too fine, every bash call would refresh). Per-turn is the design's stated trigger (Section 5 "Per-turn rotation seam"). For Phase 3 MVP, if the runner doesn't emit cleanly, we ship the orchestrator hook *behind a config flag default-off* and log a TODO.
6. **OAuth client_id source — env var, config, or compiled-in?** Compiled-in constant in `@ax/credentials-anthropic-oauth`. Anthropic's Claude Max OAuth uses a single fixed public client_id (PKCE = no secret needed). Per-deployment override deferred (design Section 4 "What MVP doesn't ship"). Source the value from v1's `~/dev/ai/ax/src/host/credentials.ts` during port — same client Anthropic already authorizes for ax v1.
7. **`CLAUDE_CODE_OAUTH_TOKEN` env var name — verified?** Open question §1 in the design. Verify by reading v1's runner auth section AND the `@anthropic-ai/claude-agent-sdk@0.2.119` source for which env var the subprocess CLI honors with `settingSources: []`. Five-minute spike before Task 8. If the SDK version we vendor doesn't honor it, two options: (a) bump the SDK if a newer version does, (b) write a thin SDK shim. Decision deferred until the spike result.
8. **Ephemeral local-loopback port collision — how to handle in-use ports?** Bind to port 0; let the kernel assign. Read the actual port off the listener after bind. The redirect_uri must match what was sent in the authorize URL, so build it post-bind.
9. **Where do the `/auth/oauth/{start,callback}` HTTP routes go for web-chat?** Out-of-scope for Phase 3. Defer to Phase 10–12. The hook surface is the same; the routes are pure dispatchers (cookie-stash + bus-call). When they land, they live in `@ax/credentials-anthropic-oauth` itself (so OAuth knowledge stays in one plugin) — they call `http:register-route` if and only if `bus.hasService('http:register-route')` (so the CLI-only deployment doesn't pull in `@ax/http-server`).
10. **e2e test gating for OAuth.** Test gate: `AX_TEST_ANTHROPIC_OAUTH_REFRESH_TOKEN` env var. If set, the test installs the refresh token as if a prior login had stashed it, fires `credentials:get` (which forces a refresh through Anthropic's token endpoint), asserts the returned token starts with the right prefix and that `event.http-egress` recorded the refresh call. If unset, the test skips. Mirrors Phase 2's `AX_TEST_ANTHROPIC_KEY` pattern.
11. **"Open browser" helper safety.** Use `child_process.spawn(opener, [url], { detached: true, stdio: 'ignore' })` with `opener` chosen by platform (`'open'` on darwin, `'xdg-open'` on linux, `'start'` arg on windows via `spawn('cmd', ['/c', 'start', '', url])`). Never `exec` with template strings. Even though the URL we pass comes from our own `:login` handler (not user input), shell-quoting drift is a recurring class of bug — use `spawn` with arg array unconditionally. (Hook flagged this; honoring the rule.)

---

## Tasks

### Task 1: Reshape the `credentials:*` hook surface (types only, no behavior change)

**Goal:** Update the input/output schemas of `credentials:get`, `:set`, `:delete`. Pure-types commit. Build will break at the call sites; that's intentional — Tasks 2–5 fix them.

**Files:**
- Modify: `packages/credentials/src/plugin.ts` (the three handler-input schemas)
- Modify: `packages/credentials/src/types.ts` if separate types file exists, else inline
- Modify: `packages/credentials-store-db/src/plugin.ts` (`StoreBlobPutInput` gains `userId`)

**Step 1.1: Decide the new shapes (no code yet)**

```ts
// credentials:get
interface CredentialsGetInput { ref: string; userId: string }
type CredentialsGetOutput = string;  // unwrapped — no {value} envelope

// credentials:set
interface CredentialsSetInput {
  ref: string;
  userId: string;
  kind: string;             // 'api-key' | 'anthropic-oauth' | future
  payload: Uint8Array;      // pre-envelope; facade wraps in { kind, expiresAt?, metadata?, payload }
  expiresAt?: number;       // unix ms; sub-services hint this for OAuth
  metadata?: Record<string, unknown>;
}
type CredentialsSetOutput = void;

// credentials:delete
interface CredentialsDeleteInput { ref: string; userId: string }
type CredentialsDeleteOutput = void;
```

Per-kind sub-service input/output:

```ts
// credentials:resolve:<kind>
interface CredentialsResolveInput { payload: Uint8Array; userId: string; ref: string }
interface CredentialsResolveOutput {
  value: string;            // current usable value (access token, api key)
  refreshed?: {              // present iff the blob updated; facade re-stores
    payload: Uint8Array;
    expiresAt?: number;
    metadata?: Record<string, unknown>;
  };
}
```

**Step 1.2: Write the failing test (red)**

Test file: `packages/credentials/src/__tests__/plugin.test.ts`

```ts
it('credentials:get with new shape returns the unwrapped string', async () => {
  await bus.call('credentials:set', ctx, {
    ref: 'demo', userId: 'u1', kind: 'api-key',
    payload: new TextEncoder().encode('sk-test'),
  });
  const out = await bus.call('credentials:get', ctx, { ref: 'demo', userId: 'u1' });
  expect(out).toBe('sk-test');
});

it('credentials:get with old shape ({ id }) throws schema error', async () => {
  await expect(
    bus.call('credentials:get', ctx, { id: 'demo' }),
  ).rejects.toThrow(/schema|input|invalid/i);
});
```

Run: `pnpm --filter @ax/credentials test -- plugin`
Expected: FAIL — handler still uses old `{ id }`.

**Step 1.3: Update the handler-side schemas**

In `packages/credentials/src/plugin.ts`, replace the zod schemas (or whatever validation lives there) for `credentials:get/set/delete` with the new shapes. Behavior in the handler body still uses old internal vars (e.g., bind `ref` from input, pass it to `credentials:store-blob:get` as the storage key — Task 2 fixes the storage-key composition).

**Step 1.4: Run tests + commit (red is OK; build will be RED across consumers)**

```bash
pnpm --filter @ax/credentials test
git add packages/credentials
git commit -m "refactor(credentials): reshape get/set/delete to (ref, { userId, kind, ... }) [Phase 3 prep]"
```

Expected: facade tests pass; downstream package builds break. That's the next tasks' job.

---

### Task 2: Update `@ax/credentials-store-db` for `(userId, ref)` storage key

**Goal:** Storage key shape changes from `credential:<id>` to `credential:<userId>:<ref>`. Encryption envelope (`{ kind, expiresAt?, metadata?, payload }`) lives at the facade layer (Task 3); store-db stays opaque-bytes.

**Files:**
- Modify: `packages/credentials-store-db/src/plugin.ts` (key composition)
- Modify: `packages/credentials-store-db/src/__tests__/plugin.test.ts`

**Step 2.1: Test first (red)**

```ts
it('store-blob:put writes under credential:<userId>:<ref> key', async () => {
  await bus.call('credentials:store-blob:put', ctx, {
    userId: 'u1', ref: 'demo', blob: new Uint8Array([1, 2, 3]),
  });
  const stored = await bus.call('storage:get', ctx, { key: 'credential:u1:demo' });
  expect(stored.value).toEqual(new Uint8Array([1, 2, 3]));
});

it('store-blob:get returns undefined for a missing (userId, ref)', async () => {
  const out = await bus.call('credentials:store-blob:get', ctx, {
    userId: 'u1', ref: 'missing',
  });
  expect(out.blob).toBeUndefined();
});
```

Run: FAIL.

**Step 2.2: Update the schemas + key composition**

```ts
// store-blob:put input
{ userId: string; ref: string; blob: Uint8Array }
// (was: { id: string; blob: Uint8Array })

// composition:
const storageKey = `credential:${input.userId}:${input.ref}`;
```

**Step 2.3: Run + commit**

```bash
pnpm --filter @ax/credentials-store-db test
git add packages/credentials-store-db
git commit -m "refactor(credentials-store-db): (userId, ref) storage key shape [Phase 3 prep]"
```

---

### Task 3: Facade dispatcher — per-kind `credentials:resolve:<kind>` lookup + envelope (un)wrap

**Goal:** `credentials:get` reads the encrypted blob, decrypts to the envelope, looks up `kind`, dispatches to `credentials:resolve:<kind>` if registered. Otherwise (api-key, "static bearer", etc.) returns `payload` decoded as UTF-8. `credentials:set` wraps the per-kind payload in the envelope and encrypts before passing to store-blob.

**Files:**
- Modify: `packages/credentials/src/plugin.ts` (the `:get` and `:set` handler bodies)
- Modify: `packages/credentials/src/__tests__/plugin.test.ts`

**Step 3.1: Test first (red)**

```ts
it('credentials:get dispatches to resolve:<kind> when sub-service is registered', async () => {
  // Stub a fake resolve sub-service
  bus.registerService('credentials:resolve:fake-oauth', 'test', async (ctx, input) => {
    expect(input.payload).toEqual(new TextEncoder().encode('refresh-token-blob'));
    return { value: 'access-token-from-fake' };
  });
  await bus.call('credentials:set', ctx, {
    ref: 'r1', userId: 'u1', kind: 'fake-oauth',
    payload: new TextEncoder().encode('refresh-token-blob'),
  });
  const out = await bus.call('credentials:get', ctx, { ref: 'r1', userId: 'u1' });
  expect(out).toBe('access-token-from-fake');
});

it('credentials:get re-stores when sub-service returns refreshed blob', async () => {
  let putCount = 0;
  bus.registerService('credentials:resolve:fake-oauth', 'test', async () => ({
    value: 'access-A',
    refreshed: { payload: new TextEncoder().encode('refresh-token-v2') },
  }));
  // ... assert that store-blob:put was called once with the new payload after credentials:get ...
});

it('credentials:get for api-key kind returns payload UTF-8 (no sub-service path)', async () => {
  await bus.call('credentials:set', ctx, {
    ref: 'k1', userId: 'u1', kind: 'api-key',
    payload: new TextEncoder().encode('sk-real'),
  });
  expect(await bus.call('credentials:get', ctx, { ref: 'k1', userId: 'u1' })).toBe('sk-real');
});
```

Run: FAIL.

**Step 3.2: Implement the envelope wrap/unwrap**

```ts
interface Envelope {
  kind: string;
  expiresAt?: number;
  metadata?: Record<string, unknown>;
  payload: number[];          // base64-decoded into Uint8Array — JSON-safe encoding
}

async function setHandler(ctx, input) {
  const env: Envelope = {
    kind: input.kind,
    expiresAt: input.expiresAt,
    metadata: input.metadata,
    payload: Array.from(input.payload),
  };
  const json = new TextEncoder().encode(JSON.stringify(env));
  const encrypted = await encrypt(json);
  await bus.call('credentials:store-blob:put', ctx, {
    userId: input.userId, ref: input.ref, blob: encrypted,
  });
}

async function getHandler(ctx, input) {
  const stored = await bus.call('credentials:store-blob:get', ctx, {
    userId: input.userId, ref: input.ref,
  });
  if (stored.blob === undefined) {
    throw new PluginError({ code: 'credential-not-found', plugin: PLUGIN_NAME, message: `no credential for ref=${input.ref}` });
  }
  const decrypted = await decrypt(stored.blob);
  const env = JSON.parse(new TextDecoder().decode(decrypted)) as Envelope;
  const payload = new Uint8Array(env.payload);

  const subService = `credentials:resolve:${env.kind}`;
  if (bus.hasService(subService)) {
    const out = await bus.call(subService, ctx, { payload, userId: input.userId, ref: input.ref });
    if (out.refreshed) {
      // Re-store with the refreshed payload + updated expiresAt
      await bus.call('credentials:set', ctx, {
        ref: input.ref, userId: input.userId, kind: env.kind,
        payload: out.refreshed.payload,
        expiresAt: out.refreshed.expiresAt,
        metadata: out.refreshed.metadata ?? env.metadata,
      });
    }
    return out.value;
  }
  // No sub-service registered for this kind — default path: payload is the value as UTF-8 bytes.
  return new TextDecoder().decode(payload);
}
```

**Step 3.3: Run + commit**

```bash
pnpm --filter @ax/credentials test
git add packages/credentials
git commit -m "feat(credentials): envelope + per-kind resolve dispatcher [Phase 3]"
```

---

### Task 4: Per-blob mutex serializes concurrent resolves

**Goal:** Two simultaneous `credentials:get` calls for the same `(userId, ref)` share one promise. Prevents two refreshes of the same OAuth token if a turn boundary and a session-open fire concurrently.

**Files:**
- Modify: `packages/credentials/src/plugin.ts`
- Modify: `packages/credentials/src/__tests__/plugin.test.ts`

**Step 4.1: Test first (red)**

```ts
it('serializes concurrent credentials:get for the same (userId, ref) — only one resolve fires', async () => {
  let resolveCount = 0;
  bus.registerService('credentials:resolve:slow-oauth', 'test', async () => {
    resolveCount++;
    await new Promise((r) => setTimeout(r, 50));
    return { value: 'token-' + resolveCount };
  });
  await bus.call('credentials:set', ctx, {
    ref: 'r1', userId: 'u1', kind: 'slow-oauth',
    payload: new TextEncoder().encode('blob'),
  });
  const [a, b] = await Promise.all([
    bus.call('credentials:get', ctx, { ref: 'r1', userId: 'u1' }),
    bus.call('credentials:get', ctx, { ref: 'r1', userId: 'u1' }),
  ]);
  expect(resolveCount).toBe(1);
  expect(a).toBe(b);
});

it('different (userId, ref) pairs run in parallel', async () => {
  // Two refs, two concurrent calls, sub-service start-time delta < 10ms (parallelism evidence)
});
```

Run: FAIL.

**Step 4.2: Implement the mutex**

```ts
const inflight = new Map<string, Promise<string>>();

async function getHandler(ctx, input) {
  const key = `${input.userId}:${input.ref}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = doResolve(ctx, input);
  inflight.set(key, p);
  try {
    return await p;
  } finally {
    inflight.delete(key);
  }
}

async function doResolve(ctx, input) {
  // ... the body of getHandler from Task 3 ...
}
```

**Step 4.3: Run + commit**

```bash
pnpm --filter @ax/credentials test
git add packages/credentials
git commit -m "feat(credentials): per-(userId, ref) mutex serializes resolves [Phase 3 I7]"
```

---

### Task 5: Update `@ax/credential-proxy` call sites for the new `credentials:get` shape

**Goal:** `credential-proxy/plugin.ts:346` (in `proxy:open-session`) and `:428` (in `proxy:rotate-session`) update from `bus.call('credentials:get', ctx, { id: ref }) → { value }` to `bus.call('credentials:get', ctx, { ref, userId }) → string`.

**Files:**
- Modify: `packages/credential-proxy/src/plugin.ts:340-360, 420-440` (the two call sites)
- Modify: `packages/credential-proxy/src/__tests__/plugin.test.ts` (stub credentials handler with new shape)

**Step 5.1: Test first (red — build break already exposed by Task 1; now write a behavior assertion)**

```ts
it('proxy:open-session resolves credentials with (ref, userId) shape', async () => {
  let captured: { ref: string; userId: string } | undefined;
  bus.registerService('credentials:get', 'test', async (ctx, input) => {
    captured = input;
    return 'sk-real';
  });
  await bus.call('proxy:open-session', ctx, {
    sessionId: 's1', userId: 'u1', agentId: 'a1', allowlist: [],
    credentials: { ANTHROPIC_API_KEY: { ref: 'anthropic-api', kind: 'api-key' } },
  });
  expect(captured).toEqual({ ref: 'anthropic-api', userId: 'u1' });
});
```

**Step 5.2: Update both call sites**

Lines ~346 and ~428 — same change:

```ts
// before:
const cred = await bus.call('credentials:get', ctx, { id: spec.ref });
const realValue = cred.value;

// after:
const realValue = await bus.call('credentials:get', ctx, { ref: spec.ref, userId: input.userId });
```

**Step 5.3: Run + commit**

```bash
pnpm --filter @ax/credential-proxy test
git add packages/credential-proxy
git commit -m "refactor(credential-proxy): adopt credentials:get(ref, userId) reshape [Phase 3]"
```

---

### Task 6: Sweep for additional `credentials:get` consumers

**Goal:** Phase 1b memory predicted "credential-proxy's two call sites + mcp-client's transport layer + CLI commands" would need updating. Phase 3 survey only found the credential-proxy two. Before Task 7 lands, double-check there are no other consumers — better to discover one now than during PR review.

**Files:** None modified (sweep only).

**Step 6.1: Grep**

```bash
grep -rn "credentials:get" /Users/vpulim/dev/ai/ax-next/packages/ /Users/vpulim/dev/ai/ax-next/presets/ \
  | grep -v node_modules | grep -v dist | grep -v __tests__ | grep -v ".d.ts"
```

**Step 6.2: For each hit, check the call shape**

- If it uses `{ id: ... }`: update it now under the same task umbrella.
- If it's a registration line (`bus.registerService('credentials:get', ...)`): leave it — the only registrar is `@ax/credentials`.

**Step 6.3: Commit only if hits found**

```bash
# if hits found:
git add <touched-files>
git commit -m "refactor(<package>): adopt credentials:get(ref, userId) reshape [Phase 3]"
# else: no commit; note the empty sweep in PR description.
```

---

### Task 7: Spike — verify `CLAUDE_CODE_OAUTH_TOKEN` env var support in vendored SDK

**Goal:** Five-minute investigation. Resolves design-doc open question §1. Result determines whether Task 9 needs a thin SDK shim.

**Files:** None modified — read-only.

**Step 7.1: Read the vendored SDK source**

```bash
cd /Users/vpulim/dev/ai/ax-next
grep -r 'CLAUDE_CODE_OAUTH_TOKEN' node_modules/@anthropic-ai/claude-agent-sdk/
grep -r 'OAuth' node_modules/@anthropic-ai/claude-agent-sdk/dist/ | head -20
```

**Step 7.2: Read v1's runner auth section for confirmation**

```bash
sed -n '480,560p' /Users/vpulim/dev/ai/ax/src/agent/runner.ts
```

**Step 7.3: Decide path forward**

- If SDK honors `CLAUDE_CODE_OAUTH_TOKEN` with `settingSources: []`: Task 9 sets the env var, no shim needed.
- If not: Task 9 either bumps the SDK to a newer version OR writes a 30-line shim that sets `Authorization: Bearer ax-cred:<hex>` on the SDK's HTTP client directly. Document the chosen path in `docs/plans/2026-04-29-phase-3-pr-notes.md`.

No commit — investigation only. Note findings in PR description.

---

### Task 8: Scaffold `@ax/credentials-anthropic-oauth` package

**Goal:** New package, manifest declares the three sub-service hooks it'll register. Init is a no-op skeleton; behavior lands in Tasks 9–10.

**Files:**
- Add: `packages/credentials-anthropic-oauth/package.json`
- Add: `packages/credentials-anthropic-oauth/tsconfig.json`
- Add: `packages/credentials-anthropic-oauth/src/index.ts` (re-exports `createPlugin`)
- Add: `packages/credentials-anthropic-oauth/src/plugin.ts` (manifest + init skeleton)
- Add: `packages/credentials-anthropic-oauth/src/__tests__/plugin.test.ts`
- Modify: root `tsconfig.json` references list (`pnpm-workspace.yaml` is already `packages/*`, no change needed)

**Step 8.1: Mirror credentials-store-db structure**

```bash
mkdir -p packages/credentials-anthropic-oauth/src/__tests__
cp packages/credentials-store-db/package.json packages/credentials-anthropic-oauth/package.json
cp packages/credentials-store-db/tsconfig.json packages/credentials-anthropic-oauth/tsconfig.json
# then edit name field in package.json
```

```json
// package.json
{
  "name": "@ax/credentials-anthropic-oauth",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "dependencies": { "@ax/core": "workspace:*" },
  "devDependencies": { "@ax/test-harness": "workspace:*", "typescript": "^6.0.3", "vitest": "^4.1.4" }
}
```

**Step 8.2: Manifest skeleton**

```ts
// src/plugin.ts
const PLUGIN_NAME = '@ax/credentials-anthropic-oauth';
const ANTHROPIC_OAUTH_CLIENT_ID = '<from v1 — verify in Task 7>';
const ANTHROPIC_TOKEN_ENDPOINT = 'https://console.anthropic.com/v1/oauth/token';
const ANTHROPIC_AUTHORIZE_ENDPOINT = 'https://claude.ai/oauth/authorize';

export function createCredentialsAnthropicOauthPlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [
        'credentials:resolve:anthropic-oauth',
        'credentials:login:anthropic-oauth',
        'credentials:exchange:anthropic-oauth',
      ],
      calls: [],
      subscribes: [],
    },
    init: async ({ bus }) => {
      // Tasks 9–10 fill these in.
      bus.registerService('credentials:resolve:anthropic-oauth', PLUGIN_NAME, async () => {
        throw new PluginError({ code: 'not-implemented', plugin: PLUGIN_NAME, message: 'Task 9 implements this' });
      });
      bus.registerService('credentials:login:anthropic-oauth', PLUGIN_NAME, async () => {
        throw new PluginError({ code: 'not-implemented', plugin: PLUGIN_NAME, message: 'Task 10 implements this' });
      });
      bus.registerService('credentials:exchange:anthropic-oauth', PLUGIN_NAME, async () => {
        throw new PluginError({ code: 'not-implemented', plugin: PLUGIN_NAME, message: 'Task 10 implements this' });
      });
    },
  };
}
```

**Step 8.3: Skeleton test passes**

```ts
it('plugin loads and registers all three services', async () => {
  const harness = await bootstrap([createCredentialsAnthropicOauthPlugin()]);
  expect(harness.bus.hasService('credentials:resolve:anthropic-oauth')).toBe(true);
  expect(harness.bus.hasService('credentials:login:anthropic-oauth')).toBe(true);
  expect(harness.bus.hasService('credentials:exchange:anthropic-oauth')).toBe(true);
});
```

**Step 8.4: Wire into root tsconfig + run + commit**

```bash
pnpm install
pnpm --filter @ax/credentials-anthropic-oauth build
pnpm --filter @ax/credentials-anthropic-oauth test
git add packages/credentials-anthropic-oauth tsconfig.json pnpm-lock.yaml
git commit -m "feat(credentials-anthropic-oauth): scaffold package + skeleton service registrations [Phase 3]"
```

---

### Task 9: Implement `credentials:resolve:anthropic-oauth` (refresh-if-needed)

**Goal:** Decode the payload as `{ accessToken, refreshToken, expiresAt }`. If `expiresAt - now > 5min`, return as-is. If within the buffer, POST to Anthropic's token endpoint with `grant_type=refresh_token`, parse the response, return new access token + a `refreshed` blob.

**Files:**
- Modify: `packages/credentials-anthropic-oauth/src/plugin.ts`
- Add: `packages/credentials-anthropic-oauth/src/refresh.ts` (the token-endpoint client)
- Modify: `packages/credentials-anthropic-oauth/src/__tests__/plugin.test.ts`

**Step 9.1: Test first (red)**

```ts
it('returns the cached access token when expiresAt is more than 5min away', async () => {
  const blob = encode({ accessToken: 'tok-A', refreshToken: 'r-A', expiresAt: Date.now() + 600_000 });
  const out = await bus.call('credentials:resolve:anthropic-oauth', ctx, {
    payload: blob, userId: 'u1', ref: 'r1',
  });
  expect(out.value).toBe('tok-A');
  expect(out.refreshed).toBeUndefined();
});

it('refreshes when expiresAt is within 5min and returns the new token + refreshed blob', async () => {
  // Mock fetch to return { access_token, refresh_token, expires_in }
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    new Response(JSON.stringify({ access_token: 'tok-NEW', refresh_token: 'r-NEW', expires_in: 3600 })),
  );
  const blob = encode({ accessToken: 'tok-OLD', refreshToken: 'r-OLD', expiresAt: Date.now() + 60_000 });
  const out = await bus.call('credentials:resolve:anthropic-oauth', ctx, {
    payload: blob, userId: 'u1', ref: 'r1',
  });
  expect(out.value).toBe('tok-NEW');
  expect(out.refreshed).toBeDefined();
  // Check refresh blob carries new tokens + expiresAt
});

it('throws PluginError(oauth-refresh-failed) when token endpoint returns non-2xx', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('invalid_grant', { status: 400 }));
  const blob = encode({ accessToken: 'tok-OLD', refreshToken: 'r-OLD', expiresAt: Date.now() + 60_000 });
  await expect(
    bus.call('credentials:resolve:anthropic-oauth', ctx, { payload: blob, userId: 'u1', ref: 'r1' }),
  ).rejects.toThrow(/oauth-refresh-failed/);
});
```

**Step 9.2: Implement**

```ts
// src/refresh.ts
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export interface OauthBlob { accessToken: string; refreshToken: string; expiresAt: number }

export async function resolveAnthropicOauth(input: { payload: Uint8Array }): Promise<{
  value: string;
  refreshed?: { payload: Uint8Array; expiresAt: number };
}> {
  const blob = JSON.parse(new TextDecoder().decode(input.payload)) as OauthBlob;
  if (blob.expiresAt - Date.now() > REFRESH_BUFFER_MS) {
    return { value: blob.accessToken };
  }
  const refreshed = await refreshTokens(blob.refreshToken);
  const newBlob: OauthBlob = {
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token ?? blob.refreshToken,  // some endpoints don't rotate
    expiresAt: Date.now() + refreshed.expires_in * 1000,
  };
  return {
    value: newBlob.accessToken,
    refreshed: {
      payload: new TextEncoder().encode(JSON.stringify(newBlob)),
      expiresAt: newBlob.expiresAt,
    },
  };
}

async function refreshTokens(refreshToken: string) {
  const res = await fetch(ANTHROPIC_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
    }),
  });
  if (!res.ok) {
    throw new PluginError({ code: 'oauth-refresh-failed', plugin: PLUGIN_NAME, message: `token endpoint returned ${res.status}` });
  }
  return res.json() as Promise<{ access_token: string; refresh_token?: string; expires_in: number }>;
}
```

**Step 9.3: Run + commit**

```bash
pnpm --filter @ax/credentials-anthropic-oauth test
git add packages/credentials-anthropic-oauth
git commit -m "feat(credentials-anthropic-oauth): resolve sub-service refreshes when within 5min buffer [Phase 3 I8]"
```

---

### Task 10: Implement `credentials:login:anthropic-oauth` + `:exchange:anthropic-oauth`

**Goal:** PKCE-based authorize-URL generation + token exchange. Helpers ported from v1's `~/dev/ai/ax/src/host/credentials.ts`.

**Files:**
- Add: `packages/credentials-anthropic-oauth/src/pkce.ts` (verifier/challenge math)
- Modify: `packages/credentials-anthropic-oauth/src/plugin.ts`
- Modify: `packages/credentials-anthropic-oauth/src/__tests__/plugin.test.ts`

**Step 10.1: Test first (red)**

```ts
it('credentials:login:anthropic-oauth returns an authorize URL containing challenge and state', async () => {
  const out = await bus.call('credentials:login:anthropic-oauth', ctx, {
    redirectUri: 'http://127.0.0.1:54321/callback',
  });
  const u = new URL(out.authorizeUrl);
  expect(u.origin + u.pathname).toBe(ANTHROPIC_AUTHORIZE_ENDPOINT);
  expect(u.searchParams.get('code_challenge_method')).toBe('S256');
  expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(u.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{16,}$/);
  expect(out.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
  expect(out.state).toBe(u.searchParams.get('state'));
});

it('credentials:exchange:anthropic-oauth POSTs to token endpoint and returns the blob', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    new Response(JSON.stringify({ access_token: 'A', refresh_token: 'R', expires_in: 3600 })),
  );
  const out = await bus.call('credentials:exchange:anthropic-oauth', ctx, {
    code: 'auth-code', codeVerifier: 'v-12345...', redirectUri: 'http://127.0.0.1:54321/callback',
  });
  // out shape: { payload: Uint8Array, expiresAt: number, kind: 'anthropic-oauth' }
  const blob = JSON.parse(new TextDecoder().decode(out.payload));
  expect(blob.accessToken).toBe('A');
  expect(blob.refreshToken).toBe('R');
});
```

**Step 10.2: PKCE primitives**

```ts
// src/pkce.ts
import { randomBytes, createHash } from 'crypto';

export function generateVerifier(): string {
  return base64url(randomBytes(32));
}

export function generateChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

export function generateState(): string {
  return base64url(randomBytes(16));
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
```

**Step 10.3: Service handlers**

```ts
async function loginHandler(ctx, input: { redirectUri: string }) {
  const codeVerifier = generateVerifier();
  const codeChallenge = generateChallenge(codeVerifier);
  const state = generateState();
  const u = new URL(ANTHROPIC_AUTHORIZE_ENDPOINT);
  u.searchParams.set('client_id', ANTHROPIC_OAUTH_CLIENT_ID);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', input.redirectUri);
  u.searchParams.set('scope', 'org:create_api_key user:profile user:inference');
  u.searchParams.set('code_challenge', codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', state);
  return { authorizeUrl: u.toString(), codeVerifier, state };
}

async function exchangeHandler(ctx, input: { code: string; codeVerifier: string; redirectUri: string }) {
  const res = await fetch(ANTHROPIC_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
    }),
  });
  if (!res.ok) {
    throw new PluginError({ code: 'oauth-exchange-failed', plugin: PLUGIN_NAME, message: `token endpoint returned ${res.status}` });
  }
  const tok = await res.json() as { access_token: string; refresh_token: string; expires_in: number };
  const blob: OauthBlob = {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    expiresAt: Date.now() + tok.expires_in * 1000,
  };
  return {
    payload: new TextEncoder().encode(JSON.stringify(blob)),
    expiresAt: blob.expiresAt,
    kind: 'anthropic-oauth',
  };
}
```

**Step 10.4: Run + commit**

```bash
pnpm --filter @ax/credentials-anthropic-oauth test
git add packages/credentials-anthropic-oauth
git commit -m "feat(credentials-anthropic-oauth): login + exchange sub-services with PKCE [Phase 3]"
```

---

### Task 11: Wire `proxy:rotate-session` into the orchestrator (gated on OAuth presence)

**Goal:** When at least one credential in `agents:resolve.requiredCredentials` has `kind: 'anthropic-oauth'` (or any non-`api-key` kind), the orchestrator subscribes to a runner-emitted turn-boundary signal and fires `proxy:rotate-session` between turns. api-key-only sessions stay in coarse mode (Phase 2 behavior).

**Files:**
- Modify: `packages/chat-orchestrator/src/orchestrator.ts:609-687, 906-914`
- Modify: `packages/chat-orchestrator/src/plugin.ts` (manifest `calls`)
- Modify: `packages/chat-orchestrator/src/__tests__/orchestrator.test.ts`

**Step 11.1: Investigate the turn-boundary emission**

Re-read `packages/chat-orchestrator/src/orchestrator.ts` end-to-end and find the IPC event the runner emits between turns. Two outcomes:

- **Signal exists.** Subscribe in the orchestrator's session lifecycle. (Most likely outcome — the SDK runner is already verbose about turn lifecycle for `chat:end` purposes.)
- **No signal.** Add a minimal one in `@ax/agent-claude-sdk-runner`: emit `event.agent-turn-boundary { sessionId, turnId }` after the SDK's per-turn completion, before the next message dequeue.

Document the path in PR description.

**Step 11.2: Test first (red)**

```ts
it('subscribes to turn-boundary and fires proxy:rotate-session for OAuth sessions', async () => {
  const rotateCalls: any[] = [];
  bus.registerService('proxy:rotate-session', 'test', async (ctx, input) => {
    rotateCalls.push(input);
    return { envMap: { ANTHROPIC_API_KEY: 'ax-cred:abc' } };
  });
  // Set up agent with OAuth credential
  // Fire two synthetic turn-boundary events
  expect(rotateCalls.length).toBe(2);
  expect(rotateCalls[0].sessionId).toBe(testSessionId);
});

it('does NOT fire proxy:rotate-session for api-key-only sessions', async () => { ... });

it('survives proxy:rotate-session failure without aborting the session', async () => {
  // rotate throws; session continues; warn logged
});
```

**Step 11.3: Implement**

```ts
// In runChat, after agents:resolve + proxy:open-session:
const hasOauthCred = Object.values(agent.requiredCredentials ?? {})
  .some((c) => c.kind !== 'api-key');

let rotateUnsub: (() => void) | undefined;
if (hasOauthCred && bus.hasService('proxy:rotate-session')) {
  rotateUnsub = bus.subscribe('event.agent-turn-boundary', PLUGIN_NAME, async (ctx, payload) => {
    if (payload.sessionId !== sessionId) return;
    try {
      await bus.call('proxy:rotate-session', ctx, { sessionId });
    } catch (err) {
      ctx.logger.warn('proxy_rotate_session_failed', { sessionId, err });
    }
  });
}

// In the existing finally block (around orchestrator.ts:906):
try { rotateUnsub?.(); } catch { /* best-effort */ }
```

**Step 11.4: Manifest + commit**

`plugin.ts` adds `'proxy:rotate-session'` to `calls` (soft-dep guarded at runtime per Phase 2 pattern; manifest declaration is informational).

```bash
pnpm --filter @ax/chat-orchestrator test
git add packages/chat-orchestrator
git commit -m "feat(chat-orchestrator): wire proxy:rotate-session at turn boundary for OAuth sessions [Phase 3 I10, I11]"
```

---

### Task 12: CLI `ax-next credentials login anthropic` subcommand

**Goal:** End-to-end user-facing flow. Stand up an ephemeral `127.0.0.1:0` listener, call `:login`, open browser, await callback, call `:exchange`, call `credentials:set`, exit.

**Files:**
- Modify: `packages/cli/src/commands/credentials.ts` (add `login` verb)
- Add: `packages/cli/src/commands/open-browser.ts` (the safe-spawn helper — see I11/Open Q 11)
- Add: `packages/cli/src/__tests__/credentials-login.test.ts`

**Step 12.1: Test first (red)**

```ts
it('login flow: starts listener, opens browser, awaits redirect, exchanges code, calls credentials:set', async () => {
  // Stub: bus.call('credentials:login:anthropic-oauth', ...) returns { authorizeUrl, codeVerifier, state }.
  // Stub: bus.call('credentials:exchange:anthropic-oauth', ...) returns { payload, expiresAt, kind }.
  // Stub: bus.call('credentials:set', ...) captures input.
  // Override `openBrowser` to simulate redirecting to http://127.0.0.1:<port>/callback?code=AAA&state=<matching>.
  // Run the command; assert credentials:set was called with the right payload + kind: 'anthropic-oauth'.
});

it('login flow: rejects when state from callback does not match login state (CSRF defense)', async () => { ... });
```

**Step 12.2: Safe-spawn browser opener**

```ts
// src/commands/open-browser.ts
import { spawn } from 'node:child_process';

// I11 / Open question 11: NEVER use exec or template strings.
// spawn() with arg array bypasses the shell entirely.
export function openBrowser(url: string): void {
  // Validate the URL is something we built ourselves (sanity guard).
  // Anthropic's authorize endpoint origin only — refuse anything else.
  const parsed = new URL(url);
  if (parsed.origin !== 'https://claude.ai' && parsed.origin !== 'https://console.anthropic.com') {
    throw new PluginError({
      code: 'unsafe-open-url', plugin: 'cli',
      message: `refusing to open non-anthropic URL: ${parsed.origin}`,
    });
  }
  if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'win32') {
    // 'start' must be invoked through cmd; the empty title is required by start's syntax.
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}
```

**Step 12.3: Login flow**

```ts
// packages/cli/src/commands/credentials.ts
async function loginAnthropic(opts) {
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const { authorizeUrl, codeVerifier, state } = await bus.call(
    'credentials:login:anthropic-oauth', ctx, { redirectUri },
  );
  console.log('Opening browser to authorize Anthropic OAuth.');
  console.log('If the browser does not open, visit:\n  ' + authorizeUrl);
  openBrowser(authorizeUrl);

  const { code, returnedState } = await new Promise<{ code: string; returnedState: string }>((resolve, reject) => {
    server.once('request', (req, res) => {
      const u = new URL(req.url!, redirectUri);
      const code = u.searchParams.get('code');
      const returnedState = u.searchParams.get('state');
      if (code === null || returnedState === null) {
        res.statusCode = 400; res.end('Missing code or state'); reject(new Error('missing code/state')); return;
      }
      res.end('You can close this tab.');
      resolve({ code, returnedState });
    });
  });
  server.close();

  if (returnedState !== state) {
    throw new PluginError({ code: 'oauth-state-mismatch', plugin: 'cli', message: 'state did not match — possible CSRF' });
  }

  const exchanged = await bus.call('credentials:exchange:anthropic-oauth', ctx, {
    code, codeVerifier, redirectUri,
  });

  await bus.call('credentials:set', ctx, {
    ref: opts.ref ?? 'anthropic-personal',
    userId: ctx.userId,
    kind: 'anthropic-oauth',
    payload: exchanged.payload,
    expiresAt: exchanged.expiresAt,
  });

  console.log('Anthropic OAuth credential stored as ref=' + (opts.ref ?? 'anthropic-personal'));
  return 0;
}
```

**Step 12.4: Run + commit**

```bash
pnpm --filter @ax/cli test
git add packages/cli
git commit -m "feat(cli): credentials login anthropic subcommand (PKCE + safe browser open) [Phase 3 I11, I13]"
```

---

### Task 13: Wire `@ax/credentials-anthropic-oauth` into CLI + k8s preset

**Goal:** Plugin gets loaded everywhere. Phase 1a's lesson — half-wired plugins don't merge.

**Files:**
- Modify: `packages/cli/src/main.ts` — push the plugin
- Modify: `packages/cli/package.json` — add workspace dep
- Modify: `presets/k8s/src/index.ts` — push the plugin
- Modify: `presets/k8s/package.json` — add workspace dep
- Modify: `presets/k8s/src/__tests__/preset.test.ts` (the plugin-name list assertion)

**Step 13.1: CLI wiring**

```ts
// packages/cli/src/main.ts, near where other credentials plugins are loaded:
plugins.push(createCredentialsAnthropicOauthPlugin());
```

**Step 13.2: K8s preset wiring**

Same. Same plugin in both deployments — OAuth login can happen on either.

**Step 13.3: Run + commit**

```bash
pnpm install
pnpm --filter @ax/cli --filter @ax/preset-k8s build
pnpm --filter @ax/cli --filter @ax/preset-k8s test
git add packages/cli presets/k8s
git commit -m "feat(cli, preset-k8s): load @ax/credentials-anthropic-oauth [Phase 3 I6]"
```

---

### Task 14: Extend dev-agents-stub with an OAuth example

**Goal:** Default agent stays api-key (so the Phase 2 canary still works without OAuth setup). A second agent definition uses `kind: 'anthropic-oauth'` for testing the rotation path.

**Files:**
- Modify: `packages/cli/src/dev-agents-stub.ts:91-130`
- Modify: `packages/cli/src/__tests__/credentials-wiring.test.ts` (or sibling)

**Step 14.1: Add the variant**

```ts
// dev-agents-stub.ts
if (cfg.agentId === 'anthropic-oauth-demo') {
  return { agent: {
    id: cfg.agentId, ownerId: ctx.userId, /* ... */,
    requiredCredentials: {
      CLAUDE_CODE_OAUTH_TOKEN: { ref: 'anthropic-personal', kind: 'anthropic-oauth' },
    },
    allowedHosts: ['api.anthropic.com'],
    /* ... */
  }};
}
```

(Confirm exact env-var name in Task 7's spike result.)

**Step 14.2: Test that the orchestrator path picks up the OAuth flag**

```ts
it('agent with OAuth credential triggers turn-boundary subscription in orchestrator', async () => {
  // Already covered indirectly by Task 11's tests with stubbed agents:resolve.
  // Add one CLI-level smoke test that the wiring composes end-to-end without errors.
});
```

**Step 14.3: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): dev-agents-stub OAuth-demo agent variant [Phase 3]"
```

---

### Task 15: e2e test (real Anthropic token endpoint, gated)

**Goal:** A single integration test that exercises the OAuth refresh path against the real Anthropic token endpoint when a refresh token is supplied via `AX_TEST_ANTHROPIC_OAUTH_REFRESH_TOKEN`. Skips automatically in CI.

**Files:**
- Add: `packages/credentials-anthropic-oauth/src/__tests__/refresh.e2e.test.ts`

**Step 15.1: Test gate + body**

```ts
const refreshToken = process.env.AX_TEST_ANTHROPIC_OAUTH_REFRESH_TOKEN;
const skip = !refreshToken;

describe.skipIf(skip)('anthropic-oauth refresh e2e (real Anthropic token endpoint)', () => {
  it('exchanges a real refresh token for a fresh access token', async () => {
    const blob = new TextEncoder().encode(JSON.stringify({
      accessToken: 'will-be-replaced',
      refreshToken,
      expiresAt: Date.now() - 1000,  // force refresh
    }));
    const out = await resolveAnthropicOauth({ payload: blob });
    expect(out.value).toMatch(/^sk-ant-/);  // or the SDK's actual prefix
    expect(out.refreshed).toBeDefined();
  });
});
```

**Step 15.2: Run locally + commit**

```bash
AX_TEST_ANTHROPIC_OAUTH_REFRESH_TOKEN=... pnpm --filter @ax/credentials-anthropic-oauth test -- refresh.e2e
git add packages/credentials-anthropic-oauth/src/__tests__/refresh.e2e.test.ts
git commit -m "test(credentials-anthropic-oauth): e2e refresh against real Anthropic token endpoint [Phase 3]"
```

CI does NOT have the env var; the test skips automatically.

---

### Task 16: Boundary review + PR notes + half-wired window closure + memory update

**Goal:** Documentation. Closes the Phase 3 OAuth seam in writing.

**Files:**
- Add: `docs/plans/2026-04-29-phase-3-pr-notes.md` (mirror Phase 2's notes file)
- Modify: PR description on GitHub

**Step 16.1: Boundary review for `credentials:get` reshape**

```
### Boundary review — credentials:get/set/delete reshape

- **Alternate impl this hook could have:** vault-backed credentials backend
  (e.g. AWS Secrets Manager, GKE Secret Manager) — `(ref, userId)` is the
  natural primary key for all such backends. The reshape is forward-compat;
  no rename is needed when a vault backend lands. (See design Section 3
  "Pluggable backends".)
- **Payload field names that might leak:** none. `ref`, `userId`, `kind`,
  `payload` are all generic. Per-kind sub-services own provider-specific
  field names internally (`accessToken`, `refreshToken`) — those don't
  appear on the facade boundary.
- **Subscriber risk:** none. `credentials:get/set/delete` are service
  hooks, not subscriber events. No subscribers to break.
- **Wire surface:** none. `credentials:*` are in-process facade hooks.
  Not exposed on the IPC bridge to sandboxes.
```

**Step 16.2: Half-wired window closure note**

```
### Phase 3 half-wired window — CLOSED on landing

`@ax/credentials-anthropic-oauth` is loaded by both `@ax/cli` and
`@ax/preset-k8s` in the same PR. Reachable from:
- `ax-next credentials login anthropic` CLI subcommand (user-facing)
- The OAuth-demo agent in `dev-agents-stub` (testable today)
- The (gated) e2e test in `packages/credentials-anthropic-oauth/`

No half-wired window opens.

### Phase 1b prediction confirmed wrong

Phase 1a memory predicted `credentials:get` reshape would land in 1b.
Phase 1b memory updated this to "deferred to Phase 3 when OAuth needs
`kind`/`userId`/`resolve:<kind>`." This PR is that delivery.
```

**Step 16.3: Verification table (filled in at PR open)**

Mirror Phase 2's table — one row per invariant, with the file/test that proves it.

**Step 16.4: Memory update plan (post-merge)**

After PR merges:
- Add `~/.claude/projects/-Users-vpulim-dev-ai-ax-next/memory/project_phase_3_shipped.md` with: "Phase 3 OAuth slice merged. credentials:get reshape complete. anthropic-oauth resolver registered. proxy:rotate-session plumbed in orchestrator (gated on OAuth credential presence). Web-chat HTTP routes still deferred to Phase 10–12. CLAUDE_CODE_OAUTH_TOKEN env var <verified|shimmed — see Task 7 result>."
- Add `feedback_credentials_get_reshape_landed.md` (if any judgment calls were corrected during review).
- Update MEMORY.md index entry.

**Step 16.5: Commit**

```bash
git add docs/plans/2026-04-29-phase-3-pr-notes.md
git commit -m "docs(phase-3): PR notes + boundary review + half-wired window closure"
```

---

### Task 17: PR open + CI green

**Goal:** Open PR, watch CI, address feedback.

**Step 17.1: Branch + push**

```bash
git checkout -b phase-3-oauth-slice  # if not already
git push -u origin phase-3-oauth-slice
```

**Step 17.2: Open PR**

PR title: `Phase 3 — credentials:get reshape + anthropic-oauth + proxy:rotate-session`

Body: combines summary + boundary review + half-wired window closure (from Task 16) + test plan checklist.

**Step 17.3: Watch CI**

```bash
gh pr checks --watch
```

Expected: all checks green. If semgrep/test/lint fails, fix the root cause (don't bypass) and push.

---

## Verification table (filled in at PR open)

| Invariant | What | Where verified |
|---|---|---|
| I1 | Real OAuth tokens never enter sandbox | proxy:open-session test asserts envMap contains placeholder, not real token (existing Phase 2 coverage extends; Task 5 doesn't regress it) |
| I2 | No cross-plugin imports | `pnpm lint` clean; `@ax/credentials` imports nothing from `@ax/credentials-anthropic-oauth` (and vice versa) |
| I3 | Reshape field names don't leak | Boundary review § (PR description); facade input uses `ref`/`userId`/`kind`/`payload`, never provider-specific names |
| I4 | Boundary review recorded | PR description has the block (Task 16.1) |
| I5 | Capabilities explicit | `@ax/credentials-anthropic-oauth` manifest declares all three `registers:`; CLI manifest declares `calls: ['credentials:login:anthropic-oauth', ...]` |
| I6 | Half-wired window closes | CLI + k8s preset both load the new plugin (Task 13); e2e test references it (Task 15) |
| I7 | Per-blob mutex serializes resolves | Task 4 unit test (concurrent calls; resolveCount === 1) |
| I8 | 5-min refresh-buffer | Task 9 unit test (cache hit when expiresAt > now+5min; refresh fires when expiresAt < now+5min) |
| I9 | Refresh failure surfaces structurally | Task 9 unit test (mock token endpoint returning 400 → PluginError(oauth-refresh-failed)) |
| I10 | rotate-session fires only for OAuth sessions | Task 11 unit test (api-key-only session: rotateCalls.length === 0; OAuth session: > 0) |
| I11 | Placeholder stable across rotation | Task 11 unit test asserts envMap returned by rotate equals envMap from open (or that orchestrator doesn't propagate envMap into sandbox env mid-flight); also: `openBrowser` URL-origin guard (Task 12) |
| I12 | Hard-cut reshape | `pnpm build` clean across all packages; old `{ id }` shape rejected by handler (Task 1 unit test); Task 6 sweep clean |
| I13 | PKCE codeVerifier never logged/persisted/exported | grep `packages/credentials-anthropic-oauth/src` and `packages/cli/src/commands/credentials.ts` for codeVerifier handling — assertion in CLI test that it never crosses bus.call boundaries except `:exchange` |
| I14 | (userId, ref) storage key forward-compat for multi-user | Task 2 unit test (different userIds with same ref produce different storage keys) |

---

## Out-of-scope (not Phase 3)

- **Web-chat OAuth UI.** `POST /auth/oauth/start` + `GET /auth/oauth/callback` HTTP routes, "Connect Claude Max" button, cookie-based state stash. Phase 10–12 earns it. The hook surface is identical for web-chat — when it lands, the routes call the same `:login`/`:exchange` sub-services this PR registers.
- **`credentials:list` / `credentials:rotate` (force refresh).** Defer until an admin UI / "switch account" flow needs them. Lazy refresh on `credentials:get` covers MVP.
- **Real Kysely-backed credentials schema.** Stay in `storage:get/set` shim shape. `expiresAt` lives encrypted inside the blob; queryable column lands when background sweeps need it.
- **Cross-replica refresh coordination (postgres advisory locks).** In-process per-blob mutex (I7) covers single-replica deployments. Multi-replica earns it. Design open question §4.
- **Native runner / `@ax/llm-proxy-anthropic-format` deletion.** Still Phase 5/6.
- **OpenAI OAuth or any sibling per-kind plugin.** Anthropic alone proves the seam.
- **Custom OAuth client_ids per deployment.** One compiled-in `client_id` per provider plugin. Per-deployment override deferred (design Section 4).
- **Granular OAuth scopes.** Always the full required scope set. Refine when needed.
- **Silent refresh-failure recovery.** Refresh failure → 401 → user re-runs `credentials login`. No retry loops, no background sweeps.
- **Canary token integration (`proxy:open-session.canaryToken`).** Open question §5 in the design — defer until a concrete threat model justifies it.
- **Per-turn rotation stress test under heavy load.** Open question §2 in the design. The per-blob mutex is unit-tested for concurrent calls; production-scale stress test is a follow-up.

---

## Phase 2 lessons feeding into Phase 3

| Phase 2 lesson | How it shows up here |
|---|---|
| Soft-dep via `bus.hasService` (Phase 2 Task 2.2) | I10 — `proxy:rotate-session` plumbing is gated on `bus.hasService('proxy:rotate-session')` so non-credential-proxy presets stay supported |
| Boundary-review block in PR description (Phase 2 Task 9.1) | Task 16.1 — same template, applied to `credentials:get` reshape |
| Half-wired window closure callout (Phase 2 Task 9.2) | Task 16.2 — same pattern; new plugin reachable from canary in same PR |
| Real-provider-gated e2e (`AX_TEST_ANTHROPIC_KEY`) (Phase 2 Task 8) | Task 15 — `AX_TEST_ANTHROPIC_OAUTH_REFRESH_TOKEN` mirrors the gate |
| Hard-cut reshape, no aliasing layer (Phase 1b memory + I12) | Tasks 1–6 land atomically; build will be RED between Task 1 and Task 5 commits — that's intentional |
| Don't speculatively reshape (Phase 1b judgment call) | Phase 1b kept `credentials:get` shape unchanged; Phase 3 reshapes ONLY because OAuth (this PR) is the consumer that earns it |
| `proxyConfig` payload generic field names (Phase 2 I3) | Same discipline applied to `credentials:set.payload` — opaque bytes, not `oauth_blob`/`refresh_token` |
| Targeted follow-up commits over amending (memory) | Reviewer feedback on this PR gets separate commits, not amends |
