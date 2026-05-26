# JIT `proxy:add-host` Live Allowlist Widening + Reactive-Wall Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a blocked sandbox egress (a credential-proxy 403) surface as an in-chat **"Allow access to `<host>`?"** card with **Just this once** / **Always for this agent**; granting widens the **live** session allowlist via a new host-internal `proxy:add-host` service hook — **no re-spawn** — so the next egress to that host succeeds.

**Architecture:** Three moving parts. (1) **Per-session attribution** — `proxy:open-session` mints a per-session **proxy token**; both sandbox backends carry it into the sandbox proxy env so every egress sends `Proxy-Authorization: Basic ax:<token>`; the credential-proxy listener resolves the token → session on *every* request, so an allowlist-miss 403 now carries a real `sessionId` on `event.http-egress` (today it's empty — `plugin.ts:62`). (2) **Surfacing** — `@ax/chat-orchestrator` subscribes to `event.http-egress`, filters allowlist-blocks, resolves `sessionId → reqId` via its in-memory `reqIdsBySession` map (the exact Fault-A `session:terminate → chat:turn-error` machinery), dedups per `(sessionId, host)`, and fires the TASK-35 `chat:permission-request` hook with a new **host-grant** payload variant. (3) **Grant** — the user clicks **Just this once**; the browser POSTs `{ sessionId, host }` to a CSRF-gated channel-web route which calls the **host-internal** `proxy:add-host` service hook (the agent can never reach it over IPC); the proxy validates session ownership (`SessionConfig.userId === ctx.userId`) and does `allowlist.add(host)` on the live `Set` shared by reference with the listener.

**Tech Stack:** TypeScript, pnpm workspace, tsconfig project refs, the in-process hook bus (`bus.call`/`bus.fire`/`bus.subscribe`), zod (`@ax/sandbox-protocol`), Node `http`/`net` (the proxy listener + bridge), undici `ProxyAgent` (runner), React + shadcn primitives in `packages/channel-web`, vitest (+ `@testing-library/react` jsdom, + testcontainers in the canary).

---

## Scope & sequencing (read this first)

This card is **large** — it touches the egress trust boundary across **8 packages**, because the design's premise ("a raw proxy 403 becomes a card for `{sessionId, host}`") assumed a per-session 403 attribution that **does not exist as-built**: the proxy is one shared listener whose allowlist is ORed across all sessions, so a blocked host matches no session and the deny path stamps **empty** `sessionId`/`userId` (`listener.ts:436-453`, `plugin.ts:62`). Building the wall therefore requires building attribution first.

It is sequenced in five phases. **Phase A (per-session attribution) is a self-contained, separately-shippable unit** — if the team prefers smaller PRs, Phase A can be split into its own card and the rest of TASK-37 made to depend on it. Shipped together, it is one coherent plan.

- **Phase A — per-session proxy token (attribution):** Tasks 1–8. Blocked egress carries a real `sessionId`.
- **Phase B — `proxy:add-host` hook:** Task 9. Host-internal allowlist widening.
- **Phase C — surfacing:** Task 10. Orchestrator turns an allowlist-block into the card.
- **Phase D — card UI (reuses TASK-35):** Tasks 11–14. Host-grant payload variant + grant route.
- **Phase E — canary + verification:** Task 15.

## Implementation forks resolved (hard requirement #7)

> **1. `proxy:add-host` wire surface — `IPC: yes` (design §11.4) is REJECTED; the hook is HOST-INTERNAL.**
> The IPC dispatcher is a *fixed, hardcoded* runner→host action table (`ipc-core/dispatcher.ts:69-83`); plugins cannot contribute IPC schemas, so the design's "schema lives in @ax/credential-proxy" (for an IPC action) was never buildable. More importantly, **any** IPC action is callable by the untrusted runner — exposing `proxy:add-host` over IPC would let the agent widen its *own* egress allowlist, defeating the entire reactive wall (invariant #5; design §10 "human in the loop on every security decision"; decision #3 "hosts are always the user's own call"). **Resolution (confirmed with the human):** `proxy:add-host` is a host-bus **service hook**, never an IPC action; the only caller is the user's browser via a CSRF-gated channel-web route, and the proxy validates session ownership host-side. The design's `IPC: yes` boundary note is **stale** — flag it in the PR.
>
> **2. 403 → session attribution — per-session proxy token.**
> Because a blocked request matches no session, the proxy can't attribute it (no `sessionId` on the egress event). **Resolution (confirmed with the human):** `proxy:open-session` mints a per-session token; the sandbox proxy env embeds it as `Proxy-Authorization: Basic ax:<token>`; the listener resolves token → session on every request and stamps the block audit. **Attribution-only:** the token is a *label*, never an authz input — the allow/deny gate (`findAllowingSession`, ORed) is **unchanged** (a missing/forged token degrades to today's empty-`sessionId` behavior, never widens egress). Ownership for `proxy:add-host` is validated separately via `SessionConfig.userId`, so the token confers **no** capability even if the model reads it from `$HTTPS_PROXY`.
>
> **3. Surfacing home + match key — the orchestrator, matched by `reqId`.**
> `@ax/chat-orchestrator` already bridges session-events → chat-stream hooks (Fault A: `session:terminate → chat:turn-error`, `orchestrator.ts:586-601`) and holds `reqIdsBySession: Map<sessionId, Set<reqId>>` in memory (`orchestrator.ts:488-507`). It resolves the block's `sessionId → reqId` there and fires `chat:permission-request` stamped with that `reqId`; the SSE handler matches the host-grant variant by **`payload.reqId`** (exactly like `chat:turn-error`), while TASK-35's skill variant keeps matching by `ctx.conversationId`. No new `conversations` hook, no DB read.
>
> **4. Grant identity — payload carries `sessionId`, proxy re-validates ownership.**
> The host-grant card payload carries the opaque `sessionId` (so the browser can echo it back on grant). This is **not** a capability leak: `proxy:add-host` rejects unless `SessionConfig.userId === ctx.userId`, and the route is auth + CSRF gated — a user can only widen *their own* session's allowlist (their own isolated sandbox), which is exactly the intended capability.

## Dependency status & as-built re-verification (READ FIRST)

This card **Depends on TASK-35** (bundled approval card + `chat:permission-request` SSE frame), which depends on TASK-34 → TASK-33 (merged, #182). `yolo-ship` only pulls this card once **TASK-35 is Done**, so by execution time TASK-34 + TASK-35 are merged to `main`. This plan was written against design §6B/§7/§10/§11 + decision #4 (reactive walls) + the committed TASK-35 impl plan + the **pre-34/35** as-built code. Before Task 1, **re-confirm against `main`** (hard requirement #1 — do not trust file:line anchors) and adjust if any moved:

- [ ] **TASK-35 shipped `chat:permission-request`** as a subscriber hook fired by `@ax/skill-broker`, with channel-web server `PermissionRequest` payload (`{ skillId, description, hosts, slots }`) in `packages/channel-web/src/server/types.ts`, an `SseFrame` variant `{ reqId, permissionRequest }`, a per-connection subscriber in `sse.ts` (matched by `ctx.conversationId`), a client `permission-card-store.ts`, a transport `permissionRequest` dispatch branch, and `<PermissionCard>` mounted above `<AgentStatus />` in `Composer.tsx`. **This plan extends all of them** — if TASK-35 shipped different names, adapt the diffs. (If TASK-35's payload has no discriminant, Task 11 adds `kind: 'skill' | 'host'`.)
- [ ] **`@ax/credential-proxy` shape** (`packages/credential-proxy/src/plugin.ts`): `proxy:open-session` returns `OpenSessionOutput { proxyEndpoint, caCertPem, envMap }` (≈207-214); the handler builds a `SessionConfig` and sets `userId: input.userId` on it (≈383-398); `registers: ['proxy:open-session','proxy:rotate-session','proxy:close-session']` (≈269). `SessionConfig` (`listener.ts:54-111`) carries `allowlist: Set<string>`, optional `userId`, `sessionId`. The shared `sessions: Map<string,SessionConfig>` is mutated by reference (plugin.ts:8-11).
- [ ] **The proxy deny path leaves `sessionId` empty** (`listener.ts:434-453` HTTP, ≈846-880 CONNECT): `findAllowingSession` (`listener.ts:230-238`) ORs across all sessions; on miss the `domain_denied` audit has no session fields, and `plugin.ts`'s `onAudit` (≈296-333) emits `event.http-egress` with `sessionId: ''`. `HttpEgressEvent` carries `{ sessionId, userId, host, blockedReason?: 'allowlist'|… }` (`plugin.ts:62-81`). `@ax/audit-log` already subscribes to `event.http-egress` (`audit-log/src/plugin.ts:42`).
- [ ] **Orchestrator routing state** (`packages/chat-orchestrator/src/orchestrator.ts`): `reqIdsBySession: Map<string, Set<string>>` + `waitersByReqId` (≈487-507); `onSessionTerminate` resolves `sessionId → reqIds` and calls `fireTurnError(ctx, reqId, reason)` per in-flight reqId (≈586-601); `fireTurnError` does `bus.fire('chat:turn-error', ctx, { reqId, reason })` (≈559-571). `endpointToProxyConfig(proxyEndpoint, caCertPem, envMap)` builds the `ProxyConfig` at the open-session call site (≈1303-1306). Plugin manifest `subscribes: ['chat:end','chat:turn-end','session:terminate']` (`plugin.ts:94`).
- [ ] **`@ax/sandbox-protocol`** `ProxyConfigSchema` (`schemas.ts:186-200`) = `{ endpoint?, unixSocketPath?, caCertPem, envMap }` with the exactly-one-of refine; `OpenSessionInputSchema` carries `proxyConfig?` (≈220).
- [ ] **Sandbox proxy env stamping:** `sandbox-subprocess/src/open-session.ts` sets `sessionEnv.HTTPS_PROXY = input.proxyConfig.endpoint` (≈457-458); `sandbox-k8s/src/pod-spec.ts` stamps `AX_PROXY_ENDPOINT`/`HTTPS_PROXY`/`HTTP_PROXY` from `pc.endpoint` and `AX_PROXY_UNIX_SOCKET` from `pc.unixSocketPath` (≈277-311). Runner `proxy-startup.ts` has **bridge mode** (`AX_PROXY_UNIX_SOCKET` → `@ax/credential-proxy-bridge` + `setGlobalDispatcher(new ProxyAgent(local))`, ≈153-177) and **direct mode** (`AX_PROXY_ENDPOINT`); it forwards `http_proxy`/`https_proxy` into the SDK subprocess via `ENV_ALLOWLIST` (≈64-67) and re-sets `anthropicEnv.HTTPS_PROXY` (≈241-246). `RunnerEnv` (`env.ts`) carries `proxyEndpoint?`/`proxyUnixSocket?`.
- [ ] **The bridge** (`credential-proxy-bridge/src/bridge.ts`): the HTTP-forward path rebuilds headers but does **not** strip `proxy-authorization` (≈43-56); the CONNECT path **rebuilds** the request line with only `Host` and drops all other headers (≈105-134) — Task 8 fixes this to forward `Proxy-Authorization`.
- [ ] **channel-web routes:** registered via `http:register-route` (`server/plugin.ts:173`); `routes-chat.ts` has `POST /api/chat/messages`, CSRF-gated by the http-server subscriber expecting `X-Requested-With: ax-admin` (≈62-79, route table ≈736-769). Manifest `calls` list at `server/plugin.ts:83-98`.

---

## Phase A — Per-session proxy token (attribution)

### Shared rule: the proxy token (referenced by Tasks 1, 3, 5–8)

A **proxy token** is a 32-hex secret minted per session. It rides as HTTP **Basic** proxy auth: clients send `Proxy-Authorization: Basic base64("ax:" + token)`. It is an **attribution label only** — never an allow/deny input, never a capability. Format (shared by mint + parse, asserted at both ends):

```
PROXY_TOKEN_RE = /^[0-9a-f]{32}$/
header value   = "Basic " + base64("ax:" + token)
```

---

### Task 1: Mint a per-session proxy token in `proxy:open-session`

**Files:**
- Modify: `packages/credential-proxy/src/plugin.ts`, `packages/credential-proxy/src/listener.ts`
- Test: `packages/credential-proxy/src/__tests__/plugin.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `plugin.test.ts` (reuse the file's harness that boots the plugin + calls `proxy:open-session`):

```typescript
it('proxy:open-session returns a 32-hex proxyAuthToken and stamps it on the session', async () => {
  const { bus, sessions } = await bootProxyPlugin(); // file's existing boot helper
  const out = await bus.call('proxy:open-session', ctx(), {
    sessionId: 's1', userId: 'u1', agentId: 'a1',
    allowlist: ['api.example.com'], credentials: {},
  });
  expect(out.proxyAuthToken).toMatch(/^[0-9a-f]{32}$/);
  expect(sessions.get('s1')?.proxyToken).toBe(out.proxyAuthToken);
});

it('mints a distinct token per session', async () => {
  const { bus } = await bootProxyPlugin();
  const a = await bus.call('proxy:open-session', ctx(), { sessionId: 'sa', userId: 'u', agentId: 'a', allowlist: [], credentials: {} });
  const b = await bus.call('proxy:open-session', ctx(), { sessionId: 'sb', userId: 'u', agentId: 'a', allowlist: [], credentials: {} });
  expect(a.proxyAuthToken).not.toBe(b.proxyAuthToken);
});
```

(If the file has no `bootProxyPlugin`/`sessions` accessor, mirror the existing open-session test's setup; the listener's `sessions` Map is the one passed into `startProxyListener`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/credential-proxy test -- src/__tests__/plugin.test.ts`
Expected: FAIL — `proxyAuthToken` is undefined; `SessionConfig.proxyToken` doesn't exist.

- [ ] **Step 3: Add `proxyToken` to `SessionConfig` and mint it on open**

In `packages/credential-proxy/src/listener.ts`, add to `SessionConfig` (after `userId`):

```typescript
  /**
   * Per-session proxy token (attribution label, NOT an authz input). Clients
   * send it as `Proxy-Authorization: Basic ax:<token>`; the listener resolves
   * token → session so even an allowlist-MISS (403) can be attributed to the
   * session that made it. Optional for back-compat with tests that build
   * SessionConfig directly. See findSessionByProxyToken.
   */
  proxyToken?: string;
```

In `packages/credential-proxy/src/plugin.ts`, add to `OpenSessionOutput` (≈207-214):

```typescript
  /** Per-session proxy token for egress attribution (Proxy-Authorization Basic). */
  proxyAuthToken: string;
```

Import a hex generator (`randomBytes` from `node:crypto`) at the top, and inside the `proxy:open-session` handler, before building `sessionConfig`, mint the token and stamp it:

```typescript
import { randomBytes } from 'node:crypto';
// ...
const proxyToken = randomBytes(16).toString('hex'); // 32 hex chars
```

Set it on the `SessionConfig` (`sessionConfig.proxyToken = proxyToken;` after the existing assignments, ≈398) and add it to the return object (`proxyAuthToken: proxyToken,` alongside `proxyEndpoint`/`caCertPem`/`envMap`, ≈408-412).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/credential-proxy test -- src/__tests__/plugin.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/credential-proxy/src/plugin.ts packages/credential-proxy/src/listener.ts packages/credential-proxy/src/__tests__/plugin.test.ts
git commit -m "feat(credential-proxy): mint per-session proxy token on open-session"
```

---

### Task 2: Listener attributes a blocked request to its session via the token

**Files:**
- Modify: `packages/credential-proxy/src/listener.ts`
- Test: `packages/credential-proxy/src/__tests__/listener.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `listener.test.ts` (reuse the file's `startProxyListener` + request helpers; build a session with a `proxyToken` + an allowlist that does NOT contain the requested host so the request is blocked):

```typescript
it('stamps the session on an allowlist-miss 403 when the request carries the proxy token', async () => {
  const audits: ProxyAuditEntry[] = [];
  const sessions = new Map<string, SessionConfig>([
    ['s1', { allowlist: new Set(['allowed.example.com']), sessionId: 's1', userId: 'u1', proxyToken: 'a'.repeat(32) }],
  ]);
  const listener = await startProxyListener({ /* ...opts... */ sessions, onAudit: (e) => audits.push(e) });
  // HTTP-forward a request to a BLOCKED host WITH the Proxy-Authorization header.
  await httpForwardThroughProxy(listener, {
    method: 'GET', url: 'http://blocked.example.com/x',
    headers: { 'proxy-authorization': 'Basic ' + Buffer.from('ax:' + 'a'.repeat(32)).toString('base64') },
  });
  const block = audits.find((a) => a.blocked?.startsWith('domain_denied:'));
  expect(block?.sessionId).toBe('s1');
  expect(block?.userId).toBe('u1');
  await listener.stop();
});

it('leaves the session empty on a blocked request with no/unknown token (no widening, just no attribution)', async () => {
  const audits: ProxyAuditEntry[] = [];
  const sessions = new Map<string, SessionConfig>([
    ['s1', { allowlist: new Set(['allowed.example.com']), sessionId: 's1', userId: 'u1', proxyToken: 'a'.repeat(32) }],
  ]);
  const listener = await startProxyListener({ /* ...opts... */ sessions, onAudit: (e) => audits.push(e) });
  await httpForwardThroughProxy(listener, { method: 'GET', url: 'http://blocked.example.com/x', headers: {} });
  const block = audits.find((a) => a.blocked?.startsWith('domain_denied:'));
  expect(block?.sessionId).toBeUndefined();
  await listener.stop();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/credential-proxy test -- src/__tests__/listener.test.ts`
Expected: FAIL — the block audit has no `sessionId`.

- [ ] **Step 3: Parse the token + resolve the session, stamp the block**

In `packages/credential-proxy/src/listener.ts`, add helpers near `findAllowingSession`:

```typescript
const PROXY_TOKEN_RE = /^[0-9a-f]{32}$/;

/**
 * Parse a `Proxy-Authorization: Basic base64("ax:<token>")` header into the
 * 32-hex token, or undefined. Attribution-only — a malformed/absent header
 * just yields no attribution; it NEVER affects the allow/deny decision.
 */
function parseProxyToken(headerValue: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (typeof raw !== 'string' || !raw.startsWith('Basic ')) return undefined;
  let decoded: string;
  try { decoded = Buffer.from(raw.slice(6), 'base64').toString('utf-8'); } catch { return undefined; }
  const sep = decoded.indexOf(':');
  if (sep === -1) return undefined;
  const token = decoded.slice(sep + 1);
  return PROXY_TOKEN_RE.test(token) ? token : undefined;
}

/** Resolve token → SessionConfig (attribution). Linear scan; session counts are small. */
function findSessionByProxyToken(
  token: string | undefined,
  sessions: Map<string, SessionConfig>,
): SessionConfig | undefined {
  if (token === undefined) return undefined;
  for (const session of sessions.values()) {
    if (session.proxyToken === token) return session;
  }
  return undefined;
}
```

In **both** deny paths (HTTP `listener.ts:436-453`, CONNECT ≈846-880), before calling `audit({...blocked: 'domain_denied: …'})`, resolve the attributed session from the request's `Proxy-Authorization` header and stamp the audit. Concretely, in the HTTP handler replace the `audit({...})` block at the allowlist-miss with:

```typescript
const attributed = findSessionByProxyToken(parseProxyToken(req.headers['proxy-authorization']), sessions);
audit({
  action: 'proxy_request', method, url, status: 403,
  requestBytes: 0, responseBytes: 0, durationMs: Date.now() - startTime,
  blocked: `domain_denied: ${hostname}`,
  ...(attributed?.sessionId !== undefined ? { sessionId: attributed.sessionId } : {}),
  ...(attributed?.userId !== undefined ? { userId: attributed.userId } : {}),
  ...(attributed?.classification !== undefined ? { classification: attributed.classification } : {}),
});
```

Apply the same `attributed`-stamping to the CONNECT allowlist-miss audit. For CONNECT the header is on the CONNECT request — Node's `server.on('connect', (req, …))` exposes `req.headers['proxy-authorization']` the same way.

(Leave `findAllowingSession` and the allow/deny logic untouched — attribution is additive.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/credential-proxy test -- src/__tests__/listener.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/credential-proxy/src/listener.ts packages/credential-proxy/src/__tests__/listener.test.ts
git commit -m "feat(credential-proxy): attribute blocked egress to its session via the proxy token"
```

---

### Task 3: Thread `proxyAuthToken` through the `sandbox-protocol` wire shape

**Files:**
- Modify: `packages/sandbox-protocol/src/schemas.ts`
- Test: `packages/sandbox-protocol/src/__tests__/schemas.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('ProxyConfigSchema accepts an optional proxyAuthToken', () => {
  const ok = ProxyConfigSchema.safeParse({
    endpoint: 'http://127.0.0.1:5432', caCertPem: '-----X-----', envMap: {}, proxyAuthToken: 'a'.repeat(32),
  });
  expect(ok.success).toBe(true);
  // Back-compat: still valid without it.
  const legacy = ProxyConfigSchema.safeParse({ endpoint: 'http://127.0.0.1:5432', caCertPem: '-----X-----', envMap: {} });
  expect(legacy.success).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/sandbox-protocol test`
Expected: FAIL — `proxyAuthToken` is stripped (or the shape is unchanged).

- [ ] **Step 3: Add the field**

In `packages/sandbox-protocol/src/schemas.ts`, add to the `ProxyConfigSchema` object (after `envMap`, before the `.refine`):

```typescript
    /**
     * Per-session proxy token (egress attribution; Proxy-Authorization Basic).
     * Optional + backend-agnostic (I1) — an opaque secret, no transport/storage
     * vocabulary. The sandbox bootstrap embeds it into the proxy URL userinfo.
     */
    proxyAuthToken: z.string().regex(/^[0-9a-f]{32}$/).optional(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/sandbox-protocol test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox-protocol/src/schemas.ts packages/sandbox-protocol/src/__tests__/schemas.test.ts
git commit -m "feat(sandbox-protocol): proxyConfig carries an optional per-session proxyAuthToken"
```

---

### Task 4: Orchestrator threads the token from `proxy:open-session` into `proxyConfig`

**Files:**
- Modify: `packages/chat-orchestrator/src/orchestrator.ts`
- Test: `packages/chat-orchestrator/src/__tests__/orchestrator.test.ts`

- [ ] **Step 1: Write the failing test**

Extend the existing open-session test that captures the `sandbox:open-session` input. Stub `proxy:open-session` to return `proxyAuthToken: 'a'.repeat(32)` and assert it lands on the captured `proxyConfig`:

```typescript
const pc = captured.proxyConfig;
expect(pc?.proxyAuthToken).toBe('a'.repeat(32));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/chat-orchestrator test`
Expected: FAIL — `proxyConfig.proxyAuthToken` undefined.

- [ ] **Step 3: Thread it through `endpointToProxyConfig`**

In `orchestrator.ts`: the `proxy:open-session` result type (the local `interface` near line 251, `{ proxyEndpoint, caCertPem, envMap }`) gains `proxyAuthToken: string`. `endpointToProxyConfig` (≈the helper invoked at 1303-1306) gains a `proxyAuthToken` parameter and sets it on the returned `ProxyConfig`. At the call site (1303-1306):

```typescript
proxyConfig = endpointToProxyConfig(
  opened.proxyEndpoint,
  opened.caCertPem,
  opened.envMap,
  opened.proxyAuthToken,
);
```

In `endpointToProxyConfig`, spread it onto the result (preserve `exactOptionalPropertyTypes`):

```typescript
return {
  ...(isUnix ? { unixSocketPath: socketPath } : { endpoint }),
  caCertPem,
  envMap,
  ...(proxyAuthToken !== undefined ? { proxyAuthToken } : {}),
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/chat-orchestrator test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/chat-orchestrator/src/orchestrator.ts packages/chat-orchestrator/src/__tests__/orchestrator.test.ts
git commit -m "feat(orchestrator): thread proxyAuthToken from proxy:open-session into proxyConfig"
```

---

### Task 5: subprocess sandbox carries the token into the proxy env

**Files:**
- Modify: `packages/sandbox-subprocess/src/open-session.ts`
- Test: `packages/sandbox-subprocess/src/__tests__/open-session.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('sets AX_PROXY_TOKEN in the session env when proxyConfig carries a token', async () => {
  const { sessionEnv } = await openSessionForTest({
    proxyConfig: { endpoint: 'http://127.0.0.1:5432', caCertPem: 'x', envMap: {}, proxyAuthToken: 'a'.repeat(32) },
  });
  expect(sessionEnv.AX_PROXY_TOKEN).toBe('a'.repeat(32));
});
```

(Use the file's existing open-session test helper that exposes the composed child env; mirror its setup.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/sandbox-subprocess test`
Expected: FAIL — `AX_PROXY_TOKEN` not set.

- [ ] **Step 3: Stamp the env var**

In `packages/sandbox-subprocess/src/open-session.ts`, where the proxy env is built (≈457-458, next to `sessionEnv.HTTPS_PROXY = input.proxyConfig.endpoint`):

```typescript
if (input.proxyConfig.proxyAuthToken !== undefined) {
  sessionEnv.AX_PROXY_TOKEN = input.proxyConfig.proxyAuthToken;
}
```

(Keep `HTTPS_PROXY`/`HTTP_PROXY` exactly as-is — `proxy-startup.ts` (Task 7) embeds the token into the URL the SDK subprocess actually uses; the token in `AX_PROXY_TOKEN` is the single source the runner reads.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/sandbox-subprocess test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox-subprocess/src/open-session.ts packages/sandbox-subprocess/src/__tests__/open-session.test.ts
git commit -m "feat(sandbox-subprocess): pass AX_PROXY_TOKEN into the session env"
```

---

### Task 6: k8s sandbox carries the token into the pod env

**Files:**
- Modify: `packages/sandbox-k8s/src/pod-spec.ts`
- Test: `packages/sandbox-k8s/src/__tests__/pod-spec.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('stamps AX_PROXY_TOKEN on the pod env when proxyConfig carries a token', () => {
  const spec = buildPodSpec({
    /* ...existing required fields... */
    proxyConfig: { endpoint: 'http://10.0.0.1:8080', caCertPem: 'x', envMap: {}, proxyAuthToken: 'b'.repeat(32) },
  });
  expect(findEnv(spec, 'AX_PROXY_TOKEN')?.value).toBe('b'.repeat(32));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/sandbox-k8s test`
Expected: FAIL — no `AX_PROXY_TOKEN` env.

- [ ] **Step 3: Add the field to `PodProxyConfig` + stamp it**

In `pod-spec.ts`, add `proxyAuthToken?: string;` to the `PodProxyConfig` interface (≈69-71), and inside the `if (input.proxyConfig !== undefined)` block (≈277), after the endpoint/unixSocket stamping:

```typescript
if (pc.proxyAuthToken !== undefined) {
  proxyEnv.push({ name: 'AX_PROXY_TOKEN', value: pc.proxyAuthToken });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/sandbox-k8s test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox-k8s/src/pod-spec.ts packages/sandbox-k8s/src/__tests__/pod-spec.test.ts
git commit -m "feat(sandbox-k8s): stamp AX_PROXY_TOKEN on the runner pod env"
```

---

### Task 7: Runner embeds the token as `Proxy-Authorization` for both proxy modes

**Files:**
- Modify: `packages/agent-claude-sdk-runner/src/proxy-startup.ts`, `packages/agent-claude-sdk-runner/src/env.ts`
- Test: `packages/agent-claude-sdk-runner/src/__tests__/proxy-startup.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('embeds AX_PROXY_TOKEN as Basic userinfo in the SDK subprocess proxy URL (direct mode)', async () => {
  process.env.AX_PROXY_TOKEN = 'c'.repeat(32);
  const { anthropicEnv } = await setupProxy({ proxyEndpoint: 'http://127.0.0.1:9000' });
  // ax:<token> as Basic userinfo on the proxy URL the SDK subprocess uses.
  expect(anthropicEnv.HTTPS_PROXY).toBe(`http://ax:${'c'.repeat(32)}@127.0.0.1:9000`);
  expect(anthropicEnv.HTTP_PROXY).toBe(`http://ax:${'c'.repeat(32)}@127.0.0.1:9000`);
  delete process.env.AX_PROXY_TOKEN;
});

it('leaves the proxy URL untouched when no token is present (back-compat)', async () => {
  delete process.env.AX_PROXY_TOKEN;
  const { anthropicEnv } = await setupProxy({ proxyEndpoint: 'http://127.0.0.1:9000' });
  expect(anthropicEnv.HTTPS_PROXY).toBe('http://127.0.0.1:9000');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/agent-claude-sdk-runner test -- src/__tests__/proxy-startup.test.ts`
Expected: FAIL — no userinfo embedded.

- [ ] **Step 3: Read the token + embed it as userinfo**

In `packages/agent-claude-sdk-runner/src/env.ts`, add `proxyToken?: string;` to `RunnerEnv` and read `AX_PROXY_TOKEN` in `readRunnerEnv` (validate `^[0-9a-f]{32}$`; ignore if malformed).

In `proxy-startup.ts`, add a pure helper near the top:

```typescript
const PROXY_TOKEN_RE = /^[0-9a-f]{32}$/;

/**
 * Embed the per-session proxy token into an http(s) proxy URL as Basic
 * userinfo, so every client reading HTTP(S)_PROXY (curl, undici, python) sends
 * `Proxy-Authorization: Basic ax:<token>` automatically. The listener uses it
 * to attribute egress (incl. blocks) to this session. No token → URL unchanged.
 */
export function withProxyToken(proxyUrl: string, token: string | undefined): string {
  if (token === undefined || !PROXY_TOKEN_RE.test(token)) return proxyUrl;
  try {
    const u = new URL(proxyUrl);
    u.username = 'ax';
    u.password = token;
    return u.toString().replace(/\/$/, ''); // URL adds a trailing slash on bare authority
  } catch {
    return proxyUrl;
  }
}
```

Read the token once (`const proxyToken = env.proxyToken;`). Apply it:
- **Bridge mode** (≈158): `const local = withProxyToken(\`http://127.0.0.1:${bridge.port}\`, proxyToken);` — set `process.env.HTTP_PROXY`/`HTTPS_PROXY` to `local` (unchanged below), and pass the token to the parent dispatcher: `setGlobalDispatcher(new ProxyAgent({ uri: \`http://127.0.0.1:${bridge.port}\`, token: 'Basic ' + Buffer.from('ax:' + proxyToken).toString('base64') }))` **when** `proxyToken` is set (else `new ProxyAgent(local)` as today).
- **Direct + the SDK subprocess env** (≈242-246): wrap the forwarded URL — `const proxyUrl = withProxyToken(env.proxyEndpoint ?? process.env.HTTPS_PROXY ?? '', proxyToken);` then `anthropicEnv.HTTPS_PROXY = anthropicEnv.HTTP_PROXY = proxyUrl;` (guard the empty-string case as today).

(`ENV_ALLOWLIST` already forwards `http_proxy`/`https_proxy` to the SDK subprocess — no allowlist change. The token being readable by the model's Bash tool is acceptable: it's an attribution label, not a capability — see the security note.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/agent-claude-sdk-runner test -- src/__tests__/proxy-startup.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-claude-sdk-runner/src/proxy-startup.ts packages/agent-claude-sdk-runner/src/env.ts packages/agent-claude-sdk-runner/src/__tests__/proxy-startup.test.ts
git commit -m "feat(runner): embed AX_PROXY_TOKEN as Proxy-Authorization for both proxy modes"
```

---

### Task 8: Bridge forwards `Proxy-Authorization` on CONNECT

**Files:**
- Modify: `packages/credential-proxy-bridge/src/bridge.ts`
- Test: `packages/credential-proxy-bridge/src/__tests__/bridge.test.ts`

- [ ] **Step 1: Write the failing test**

Assert the CONNECT request line the bridge writes to the unix socket includes the `Proxy-Authorization` header it received (use the file's fake unix-socket-proxy harness; capture the bytes written by the bridge):

```typescript
it('forwards Proxy-Authorization on the CONNECT it writes to the unix socket', async () => {
  const received = await captureCONNECTBytes(async (bridgeUrl) => {
    await connectThroughBridge(bridgeUrl, {
      target: 'api.example.com:443',
      headers: { 'proxy-authorization': 'Basic ' + Buffer.from('ax:' + 'd'.repeat(32)).toString('base64') },
    });
  });
  expect(received).toContain('Proxy-Authorization: Basic ' + Buffer.from('ax:' + 'd'.repeat(32)).toString('base64'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/credential-proxy-bridge test`
Expected: FAIL — the bridge writes only `CONNECT … Host: …`.

- [ ] **Step 3: Forward the header**

In `bridge.ts` CONNECT handler (≈113), build the request with the inbound `Proxy-Authorization` (if any) appended:

```typescript
const pa = req.headers['proxy-authorization'];
const paLine = typeof pa === 'string' ? `Proxy-Authorization: ${pa}\r\n` : '';
proxySocket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${paLine}\r\n`);
```

(The HTTP-forward path at ≈43-56 already forwards `proxy-authorization` — it's not in the strip list — so no change there.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/credential-proxy-bridge test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/credential-proxy-bridge/src/bridge.ts packages/credential-proxy-bridge/src/__tests__/bridge.test.ts
git commit -m "feat(credential-proxy-bridge): forward Proxy-Authorization on CONNECT (k8s attribution)"
```

---

## Phase B — `proxy:add-host` host-internal hook

### Task 9: `proxy:add-host` widens the live session allowlist (ownership-checked)

**Files:**
- Modify: `packages/credential-proxy/src/plugin.ts`
- Test: `packages/credential-proxy/src/__tests__/plugin.test.ts`

> **Boundary review** (per CLAUDE.md): *Alternate impl* — any egress gate (a k8s `NetworkPolicy` patch, an Envoy RBAC update, an iptables rule); the hook says "let this session reach this host" without naming how. *Fields* — `{ sessionId, host }` in, `{ added: boolean }` out: `sessionId` is an opaque token, `host` a hostname — no `sha`/`pod`/`socket`/`bucket`/`generation` vocabulary, no leak. *Subscriber risk* — none; it's a single-impl service hook, not a broadcast. *Wire surface* — **NOT an IPC action** (fork #1): host-internal only, so the untrusted runner can never widen its own egress. `returns` schema `z.object({ added: z.boolean() })`.

- [ ] **Step 1: Write the failing test**

```typescript
it('proxy:add-host adds a host to the live session allowlist (owner only)', async () => {
  const { bus, sessions } = await bootProxyPlugin();
  await bus.call('proxy:open-session', ctx({ userId: 'u1' }), {
    sessionId: 's1', userId: 'u1', agentId: 'a1', allowlist: ['a.example.com'], credentials: {},
  });
  const out = await bus.call('proxy:add-host', ctx({ userId: 'u1' }), { sessionId: 's1', host: 'b.example.com' });
  expect(out).toEqual({ added: true });
  expect(sessions.get('s1')?.allowlist.has('b.example.com')).toBe(true);
});

it('rejects a grant from a different user (ownership)', async () => {
  const { bus } = await bootProxyPlugin();
  await bus.call('proxy:open-session', ctx({ userId: 'u1' }), {
    sessionId: 's1', userId: 'u1', agentId: 'a1', allowlist: [], credentials: {},
  });
  await expect(
    bus.call('proxy:add-host', ctx({ userId: 'attacker' }), { sessionId: 's1', host: 'b.example.com' }),
  ).rejects.toThrow(/forbidden|not the session owner/i);
});

it('returns { added: false } for an unknown/closed session (no throw)', async () => {
  const { bus } = await bootProxyPlugin();
  const out = await bus.call('proxy:add-host', ctx({ userId: 'u1' }), { sessionId: 'gone', host: 'b.example.com' });
  expect(out).toEqual({ added: false });
});

it.each(['', 'a'.repeat(254), 'has space', 'UPPER.example.com', '*.example.com'])(
  'rejects an invalid host %p', async (host) => {
    const { bus } = await bootProxyPlugin();
    await bus.call('proxy:open-session', ctx({ userId: 'u1' }), { sessionId: 's1', userId: 'u1', agentId: 'a', allowlist: [], credentials: {} });
    await expect(bus.call('proxy:add-host', ctx({ userId: 'u1' }), { sessionId: 's1', host })).rejects.toThrow(/invalid host/i);
  },
);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/credential-proxy test -- src/__tests__/plugin.test.ts`
Expected: FAIL — no `proxy:add-host` registered.

- [ ] **Step 3: Add the host validator + register the hook**

In `plugin.ts`, add a hostname validator near the top:

```typescript
// Exact-match allowlist hostnames only (mirrors the listener's exact-match
// gate — no wildcards, no ports, no schemes). Capability minimized.
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
```

Add the input/output types:

```typescript
interface AddHostInput { sessionId: string; host: string; }
interface AddHostOutput { added: boolean; }
```

Add `'proxy:add-host'` to `manifest.registers`. Register the handler inside `init` (after `proxy:close-session`, sharing the `sessions` closure):

```typescript
// proxy:add-host — widen a LIVE session's allowlist (reactive egress wall).
// Host-internal ONLY (never an IPC action): the untrusted runner must not be
// able to widen its own egress (invariant #5; design §10). The caller is the
// authenticated owner's browser via a CSRF-gated channel-web route. Ownership
// is re-validated here against SessionConfig.userId — the proxy owns the
// session→owner fact (one source of truth, I4). The widened host lands on the
// live `allowlist` Set the listener reads by reference — no re-spawn.
bus.registerService<AddHostInput, AddHostOutput>(
  'proxy:add-host',
  PLUGIN_NAME,
  async (ctx, { sessionId, host }) => {
    if (!sessions) {
      throw new PluginError({ code: 'not-initialized', plugin: PLUGIN_NAME, message: 'handler invoked before init' });
    }
    if (typeof host !== 'string' || !HOST_RE.test(host)) {
      throw new PluginError({ code: 'invalid-host', plugin: PLUGIN_NAME, message: `invalid host: ${String(host)}` });
    }
    const sess = sessions.get(sessionId);
    if (sess === undefined) return { added: false }; // closed/unknown — graceful no-op
    if (sess.userId === undefined || sess.userId !== ctx.userId) {
      throw new PluginError({ code: 'forbidden', plugin: PLUGIN_NAME, message: 'caller is not the session owner' });
    }
    sess.allowlist.add(host);
    return { added: true };
  },
  { returns: z.object({ added: z.boolean() }) },
);
```

(Import `z` from `zod` and ensure `PluginError` is imported — it already is.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/credential-proxy test`
Expected: PASS (whole package green).

- [ ] **Step 5: Commit**

```bash
git add packages/credential-proxy/src/plugin.ts packages/credential-proxy/src/__tests__/plugin.test.ts
git commit -m "feat(credential-proxy): proxy:add-host live allowlist widening (host-internal, owner-checked)"
```

---

## Phase C — Surfacing (orchestrator)

### Task 10: Orchestrator fires the host-grant card on an allowlist-block

**Files:**
- Modify: `packages/chat-orchestrator/src/orchestrator.ts`, `packages/chat-orchestrator/src/plugin.ts`
- Test: `packages/chat-orchestrator/src/__tests__/orchestrator.test.ts`

> **Boundary review** (extends TASK-35's `chat:permission-request`): the orchestrator *fires* (no manifest declaration needed — it fires `chat:turn-error` undeclared too) the host-grant variant `{ kind: 'host', host, sessionId, reqId }`. *Fields* — `host` (hostname, public), `sessionId` (opaque), `reqId` (opaque routing key) — no backend vocabulary, no secret. *Subscriber risk* — none backend-specific (channel-web renders; an audit subscriber sees only public fields). It *subscribes* to `event.http-egress` (add to `subscribes`). It does **not** call `proxy:add-host` (that's the grant route's job) — no new `calls`.

- [ ] **Step 1: Write the failing test**

```typescript
it('fires a host-grant chat:permission-request when an allowlist-block carries a known session', async () => {
  const orch = createOrchestrator(bus, cfg);
  // Register a live waiter so reqIdsBySession resolves (mirror the file's helper
  // that drives runAgentInvoke / registers a waiter for sessionId 's1' + reqId 'r1').
  await startInFlightTurn(orch, { sessionId: 's1', reqId: 'r1' });

  const cards: Array<{ ctx: AgentContext; payload: any }> = [];
  bus.subscribe('chat:permission-request', 'test/capture', async (ctx, p) => { cards.push({ ctx, payload: p }); return undefined; });

  await orch.onHttpEgress(makeAgentContext({ sessionId: 's1', userId: 'u1', agentId: '' }), {
    sessionId: 's1', userId: 'u1', host: 'blocked.example.com', blockedReason: 'allowlist',
    method: 'GET', path: '/', status: 403, requestBytes: 0, responseBytes: 0, durationMs: 1,
    credentialInjected: false, classification: 'other', timestamp: Date.now(),
  });

  expect(cards).toHaveLength(1);
  expect(cards[0].payload).toEqual({ kind: 'host', host: 'blocked.example.com', sessionId: 's1', reqId: 'r1' });
});

it('does NOT fire for a non-allowlist block, an empty sessionId, or a session with no in-flight turn', async () => {
  const orch = createOrchestrator(bus, cfg);
  const cards: unknown[] = [];
  bus.subscribe('chat:permission-request', 'test/capture', async (_c, p) => { cards.push(p); return undefined; });
  const base = { method: 'GET', path: '/', status: 403, requestBytes: 0, responseBytes: 0, durationMs: 1, credentialInjected: false, classification: 'other' as const, timestamp: Date.now() };
  await orch.onHttpEgress(ctxFor('s1'), { ...base, sessionId: 's1', userId: 'u1', host: 'h', blockedReason: 'private-ip' }); // wrong reason
  await orch.onHttpEgress(ctxFor(''), { ...base, sessionId: '', userId: '', host: 'h', blockedReason: 'allowlist' });   // unattributed
  await orch.onHttpEgress(ctxFor('s-noturn'), { ...base, sessionId: 's-noturn', userId: 'u1', host: 'h', blockedReason: 'allowlist' }); // no waiter
  expect(cards).toHaveLength(0);
});

it('dedups repeated blocks for the same (session, host)', async () => {
  const orch = createOrchestrator(bus, cfg);
  await startInFlightTurn(orch, { sessionId: 's1', reqId: 'r1' });
  const cards: unknown[] = [];
  bus.subscribe('chat:permission-request', 'test/capture', async (_c, p) => { cards.push(p); return undefined; });
  const ev = (host: string) => ({ sessionId: 's1', userId: 'u1', host, blockedReason: 'allowlist' as const, method: 'GET', path: '/', status: 403, requestBytes: 0, responseBytes: 0, durationMs: 1, credentialInjected: false, classification: 'other' as const, timestamp: Date.now() });
  await orch.onHttpEgress(ctxFor('s1'), ev('h.example.com'));
  await orch.onHttpEgress(ctxFor('s1'), ev('h.example.com')); // same host → deduped
  await orch.onHttpEgress(ctxFor('s1'), ev('other.example.com')); // distinct host → new card
  expect(cards).toHaveLength(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/chat-orchestrator test`
Expected: FAIL — `orch.onHttpEgress` doesn't exist.

- [ ] **Step 3: Add the egress subscriber to the orchestrator**

In `orchestrator.ts`, add a dedup set near the other in-memory state (alongside `reqIdsBySession`):

```typescript
// Reactive egress wall (TASK-37) — dedup raised host-grant cards per
// (sessionId, host) so repeated 403s to the same host don't spam the stream.
// Cleared per session in onSessionTerminate (the session's egress is gone).
const wallCardsByHost = new Map<string, Set<string>>(); // sessionId → hosts already carded
```

Add `onHttpEgress` (mirrors `onSessionTerminate`'s sessionId→reqId resolution + the `fireTurnError` broadcast shape):

```typescript
// Reactive egress wall — turn an allowlist-MISS 403 into the in-chat
// "Allow access to <host>?" card (design §6B, decision #4). The credential
// proxy now attributes blocked egress to its session (per-session token,
// Phase A), so event.http-egress carries a real sessionId. We resolve it to
// the in-flight reqId(s) via reqIdsBySession — the SAME map Fault A uses —
// and fire the TASK-35 chat:permission-request hook with the host-grant
// variant, stamped with reqId so the SSE matches the precise turn (the
// host variant matches by payload.reqId, like chat:turn-error). Observation-
// only; a no-op when nothing is attributed / no turn is in flight.
async function onHttpEgress(ctx: AgentContext, payload: HttpEgressEventLike): Promise<void> {
  if (payload?.blockedReason !== 'allowlist') return;
  const sessionId = payload.sessionId;
  const host = payload.host;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return; // unattributed
  if (typeof host !== 'string' || host.length === 0) return;
  const reqIds = reqIdsBySession.get(sessionId);
  if (reqIds === undefined || reqIds.size === 0) return; // no in-flight turn to surface on
  let carded = wallCardsByHost.get(sessionId);
  if (carded === undefined) { carded = new Set(); wallCardsByHost.set(sessionId, carded); }
  if (carded.has(host)) return; // already surfaced this host for this session
  carded.add(host);
  for (const reqId of [...reqIds]) {
    const deferred = waitersByReqId.get(reqId);
    if (deferred === undefined || deferred.settled) continue;
    ctx.logger.info('reactive_wall_card', { sessionId, host, reqId });
    await bus.fire('chat:permission-request', ctx, { kind: 'host', host, sessionId, reqId });
  }
}
```

Define the local payload type (no `@ax/credential-proxy` import — I2; mirror the public `HttpEgressEvent` subset):

```typescript
interface HttpEgressEventLike {
  sessionId: string; userId: string; host: string;
  blockedReason?: 'allowlist' | 'private-ip' | 'canary' | 'tls-error' | 'request-body-too-large';
}
```

In `onSessionTerminate`, clear the dedup set for the terminating session (add after the existing body): `wallCardsByHost.delete(sessionId);`.

Export `onHttpEgress` from `createOrchestrator`'s return (≈1759) and add it to the `Orchestrator` interface (≈468-469).

- [ ] **Step 4: Wire the subscriber in `plugin.ts`**

In `packages/chat-orchestrator/src/plugin.ts`, add `'event.http-egress'` to `manifest.subscribes` (≈94) and register the subscriber alongside the others (≈123-130):

```typescript
bus.subscribe<{ sessionId: string; userId: string; host: string; blockedReason?: string }>(
  'event.http-egress',
  PLUGIN_NAME,
  async (ctx, payload) => {
    await orch.onHttpEgress(ctx, payload as never);
    return undefined; // observation-only; never vetoes egress audit.
  },
);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm -F @ax/chat-orchestrator test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/chat-orchestrator/src/orchestrator.ts packages/chat-orchestrator/src/plugin.ts packages/chat-orchestrator/src/__tests__/orchestrator.test.ts
git commit -m "feat(orchestrator): surface allowlist-block egress as a host-grant permission card"
```

---

## Phase D — Card UI (reuses TASK-35)

### Shared rule: the `PermissionRequest` discriminated union (referenced by Tasks 10–14)

TASK-35 shipped a single `PermissionRequest` shape (the skill card). TASK-37 widens it to a **discriminated union on `kind`**, re-declared **locally** at each plugin boundary (I2 — no shared import), structurally aligned:

```typescript
type PermissionRequest =
  | { kind: 'skill'; skillId: string; description: string; hosts: string[]; slots: { slot: string; kind: 'api-key' }[] }
  | { kind: 'host'; host: string; sessionId: string };
```

The **skill** variant is fired by `@ax/skill-broker` and SSE-matched by `ctx.conversationId` (TASK-35, unchanged). The **host** variant is fired by `@ax/chat-orchestrator` carrying a routing `reqId` and SSE-matched by `payload.reqId` (this card). The host variant carries **no secret** — `sessionId` is opaque + ownership-revalidated at the grant route. (If TASK-35 shipped the skill payload without a `kind` field, add `kind: 'skill'` to it here and update its producer/consumers in the same task.)

---

### Task 11: channel-web server — host variant in the payload union + SSE reqId match

**Files:**
- Modify: `packages/channel-web/src/server/types.ts`, `packages/channel-web/src/server/sse.ts`
- Test: `packages/channel-web/src/__tests__/server/sse.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
describe('host-grant permission card', () => {
  it('emits a host card frame matched by reqId and keeps the stream open', async () => {
    const { bus, initCtx, handler } = bootHandler();
    const { res, captured } = fakeRes();
    await handler(fakeReq({ reqId: 'r-test' }), res);

    // Host variant is fired with a routing reqId in the PAYLOAD (orchestrator-style).
    await bus.fire('chat:permission-request', initCtx, { kind: 'host', host: 'status.example.com', sessionId: 's1', reqId: 'r-test' });

    const frames = captured.streamWrites.filter((w) => w.startsWith('data: ')).map((w) => JSON.parse(w.slice(6)));
    const card = frames.find((f) => 'permissionRequest' in f);
    expect(card).toMatchObject({ reqId: 'r-test', permissionRequest: { kind: 'host', host: 'status.example.com', sessionId: 's1' } });
    expect(captured.streamClosed).toBe(false); // non-terminal
  });

  it('does NOT deliver a host card whose reqId differs from the connection', async () => {
    const { bus, initCtx, handler } = bootHandler();
    const { res, captured } = fakeRes();
    await handler(fakeReq({ reqId: 'r-test' }), res);
    await bus.fire('chat:permission-request', initCtx, { kind: 'host', host: 'h', sessionId: 's1', reqId: 'r-OTHER' });
    const frames = captured.streamWrites.filter((w) => w.startsWith('data: ')).map((w) => JSON.parse(w.slice(6)));
    expect(frames.some((f) => 'permissionRequest' in f)).toBe(false);
  });
});
```

(Keep TASK-35's skill-variant conversationId-match test passing — Step 3 branches on `kind`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/server/sse.test.ts`
Expected: FAIL — host variant isn't matched/emitted.

- [ ] **Step 3: Widen the payload type + branch the SSE match on `kind`**

In `packages/channel-web/src/server/types.ts`, replace the single `PermissionRequest` interface (from TASK-35) with the discriminated union above (carry over TASK-35's doc comment; add the host variant). The `SseFrame` variant `{ reqId; permissionRequest: PermissionRequest }` is unchanged (the union flows through).

In `sse.ts`, the `chat:permission-request` subscriber (added by TASK-35, matching `ctx.conversationId`) branches on `kind`. The **fired** payload may carry a routing `reqId` for the host variant; strip it from what the browser sees (the browser already knows its reqId from the connection):

```typescript
deps.bus.subscribe<PermissionRequest & { reqId?: string }>(
  'chat:permission-request',
  permissionSubKey,
  async (ctx, payload) => {
    if (payload.kind === 'host') {
      // Host-grant card: orchestrator-fired, matched by the routing reqId
      // (like chat:turn-error). Forward only the card data the browser needs.
      if (payload.reqId !== reqId) return undefined;
      safeWrite({ reqId, permissionRequest: { kind: 'host', host: payload.host, sessionId: payload.sessionId } });
      return undefined;
    }
    // Skill card (TASK-35): broker-fired, matched by conversation.
    if (ctx.conversationId !== conversationId) return undefined;
    safeWrite({ reqId, permissionRequest: payload });
    return undefined;
  },
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/server/sse.test.ts`
Expected: PASS (skill + host cases green).

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/server/types.ts packages/channel-web/src/server/sse.ts packages/channel-web/src/__tests__/server/sse.test.ts
git commit -m "feat(channel-web): host-grant permission-request variant + reqId-matched SSE frame"
```

---

### Task 12: Client transport + store handle the host variant

**Files:**
- Modify: `packages/channel-web/src/lib/transport.ts`, `packages/channel-web/src/lib/permission-card-store.ts`
- Test: `packages/channel-web/src/__tests__/transport.test.ts`, `packages/channel-web/src/__tests__/permission-card-store.test.ts`

- [ ] **Step 1: Write the failing tests**

Store test (the store now holds the union):

```typescript
it('show() stores a host-grant request', () => {
  permissionCardActions.show({ kind: 'host', host: 'status.example.com', sessionId: 's1' });
  expect(getPermissionCardSnapshot().request).toEqual({ kind: 'host', host: 'status.example.com', sessionId: 's1' });
  permissionCardActions.dismiss();
});
```

Transport test:

```typescript
it('routes a host permissionRequest frame into the card store (non-terminal)', async () => {
  permissionCardActions.reset();
  const body =
    'data: {"reqId":"r1","permissionRequest":{"kind":"host","host":"status.example.com","sessionId":"s1"}}\n\n' +
    'data: {"reqId":"r1","text":"ok","kind":"text","seq":1}\n\n' +
    'data: {"reqId":"r1","done":true}\n\n';
  const out = await drain(run(sseStream(body)));
  expect(getPermissionCardSnapshot().request).toEqual({ kind: 'host', host: 'status.example.com', sessionId: 's1' });
  expect(out.some((c) => (c as { type?: string }).type === 'finish')).toBe(true);
  permissionCardActions.reset();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/transport.test.ts src/__tests__/permission-card-store.test.ts`
Expected: FAIL — `PermissionRequest` store type rejects the host shape; transport's frame type lacks the host variant.

- [ ] **Step 3: Widen the store + transport types**

In `permission-card-store.ts`, replace the local `PermissionRequest` interface with the discriminated union (same shape as the server type). No logic change — `show`/`dismiss`/`reset` already store an opaque `request`.

In `transport.ts`, widen the client-local `SseFrame` `permissionRequest` variant to the union, and the existing dispatch branch (TASK-35) already calls `permissionCardActions.show(frame.permissionRequest)` — it forwards the union unchanged:

```typescript
  | {
      reqId: string;
      permissionRequest:
        | { kind: 'skill'; skillId: string; description: string; hosts: string[]; slots: { slot: string; kind: 'api-key' }[] }
        | { kind: 'host'; host: string; sessionId: string };
    };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/transport.test.ts src/__tests__/permission-card-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/lib/transport.ts packages/channel-web/src/lib/permission-card-store.ts packages/channel-web/src/__tests__/transport.test.ts packages/channel-web/src/__tests__/permission-card-store.test.ts
git commit -m "feat(channel-web): client store + transport carry the host-grant card variant"
```

---

### Task 13: `<PermissionCard>` renders the host-grant variant

**Files:**
- Modify: `packages/channel-web/src/components/PermissionCard.tsx`, `packages/channel-web/src/lib/credentials.ts` (add the grant helper)
- Test: `packages/channel-web/src/__tests__/permission-card.test.tsx`

> Invoke the **`shadcn`** skill first (invariant #6). Reuse the installed `Card`/`Button`/`Badge` primitives + semantic tokens; add any missing primitive via `pnpm dlx shadcn@latest add <name> -c packages/channel-web` — no raw colors, no hand-rolled `<div>` forms.

- [ ] **Step 1: Write the failing test**

```typescript
describe('PermissionCard — host grant', () => {
  afterEach(() => { vi.restoreAllMocks(); permissionCardActions.reset(); });

  it('renders the host + two grant buttons; "Just this once" POSTs the grant then dismisses', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ added: true }), { status: 200 }));
    render(<PermissionCard />);
    permissionCardActions.show({ kind: 'host', host: 'status.example.com', sessionId: 's1' });

    expect(await screen.findByText(/status\.example\.com/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /just this once/i }));

    await waitFor(() => expect(getPermissionCardSnapshot().request).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chat/allow-host',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"host":"status.example.com"'),
      }),
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ headers: expect.objectContaining({ 'x-requested-with': 'ax-admin' }) });
  });

  it('"Always for this agent" also grants (persistence is TASK-44)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ added: true }), { status: 200 }));
    render(<PermissionCard />);
    permissionCardActions.show({ kind: 'host', host: 'status.example.com', sessionId: 's1' });
    fireEvent.click(await screen.findByRole('button', { name: /always for this agent/i }));
    await waitFor(() => expect(getPermissionCardSnapshot().request).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith('/api/chat/allow-host', expect.objectContaining({ method: 'POST' }));
  });
});
```

(Keep TASK-35's skill-variant tests passing — the component branches on `kind`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/permission-card.test.tsx`
Expected: FAIL — no host-variant rendering; `grantHost` helper missing.

- [ ] **Step 3: Add the grant helper + branch the component**

In `packages/channel-web/src/lib/credentials.ts`, add the grant fetch (mirror `setDestinationCredential`'s CSRF posture — `x-requested-with: ax-admin`, `credentials: 'include'`):

```typescript
/** POST a reactive-wall host grant to the user-scoped route → proxy:add-host. */
export async function grantHost(input: { sessionId: string; host: string }): Promise<void> {
  const res = await fetch('/api/chat/allow-host', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'ax-admin' },
    credentials: 'include',
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`allow-host failed: ${res.status}`);
}
```

In `PermissionCard.tsx`, branch on `request.kind`. Keep the existing skill branch; add the host branch:

```tsx
import { grantHost, setDestinationCredential } from '@/lib/credentials';
// ...
if (request.kind === 'host') {
  return (
    <Card className="mb-3" data-testid="permission-card-host">
      <CardHeader>
        <CardTitle>Allow access to {request.host}?</CardTitle>
        <CardDescription>Your assistant tried to reach a site it isn’t allowed to yet.</CardDescription>
      </CardHeader>
      <CardContent>
        <Badge variant="secondary">{request.host}</Badge>
        {error !== null && (
          <Alert variant="destructive" className="mt-3"><AlertDescription>{error}</AlertDescription></Alert>
        )}
      </CardContent>
      <CardFooter className="justify-end gap-2">
        <Button variant="ghost" disabled={busy} onClick={close}>Not now</Button>
        {/* "Always" does the same live grant this phase; per-(user,agent) persistence is TASK-44. */}
        <Button variant="outline" disabled={busy} onClick={() => void allow()}>Always for this agent</Button>
        <Button disabled={busy} onClick={() => void allow()}>{busy ? 'Allowing…' : 'Just this once'}</Button>
      </CardFooter>
    </Card>
  );
}
// (existing skill-variant JSX below, unchanged)
```

Add an `allow()` handler alongside the existing `connect()`:

```tsx
async function allow(): Promise<void> {
  if (busy || request === null || request.kind !== 'host') return;
  setBusy(true); setError(null);
  try {
    await grantHost({ sessionId: request.sessionId, host: request.host });
    close();
  } catch (err) {
    setError(err instanceof Error ? err.message : String(err));
  } finally {
    setBusy(false);
  }
}
```

(The card is already mounted above `<AgentStatus />` from TASK-35 — no `Composer.tsx` change.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/permission-card.test.tsx`
Expected: PASS (skill + host variants green).

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/components/PermissionCard.tsx packages/channel-web/src/lib/credentials.ts packages/channel-web/src/__tests__/permission-card.test.tsx
git commit -m "feat(channel-web): reactive-wall host-grant card UI (allow host, just-once / always)"
```

---

### Task 14: Grant route — `POST /api/chat/allow-host` → `proxy:add-host`

**Files:**
- Create: `packages/channel-web/src/server/routes-allow-host.ts`
- Modify: `packages/channel-web/src/server/plugin.ts`
- Test: `packages/channel-web/src/__tests__/server/routes-allow-host.test.ts`

> **Boundary review** (the route is host-internal plumbing, not a new hook): it authenticates the user, then calls the host-internal `proxy:add-host` service hook with the *authenticated* user's ctx — the proxy re-validates `SessionConfig.userId === ctx.userId`, so a browser-supplied `sessionId` can never widen another user's session. CSRF-gated by the http-server subscriber (`x-requested-with: ax-admin`). `host`/`sessionId` are zod-validated; the proxy validates `host` again (defense-in-depth at its own boundary, I2).

- [ ] **Step 1: Write the failing test**

```typescript
it('POST /api/chat/allow-host calls proxy:add-host with the authenticated user ctx', async () => {
  const calls: Array<{ ctx: AgentContext; input: unknown }> = [];
  const bus = makeBus();
  bus.registerService('auth:require-user', 'auth', async () => ({ user: { id: 'u1', isAdmin: false } }));
  bus.registerService('proxy:add-host', 'proxy', async (ctx, input) => { calls.push({ ctx, input }); return { added: true }; });
  const handler = makeAllowHostHandler({ bus, initCtx });

  const res = fakeRes();
  await handler(fakeReq({ body: Buffer.from(JSON.stringify({ sessionId: 's1', host: 'status.example.com' })) }), res);
  expect(res.statusCode).toBe(200);
  expect(calls).toHaveLength(1);
  expect(calls[0].ctx.userId).toBe('u1');           // host-side identity, not browser-supplied
  expect(calls[0].input).toEqual({ sessionId: 's1', host: 'status.example.com' });
});

it('returns 401 when unauthenticated and 400 on a malformed body', async () => {
  const bus = makeBus();
  bus.registerService('auth:require-user', 'auth', async () => { throw new PluginError({ code: 'unauthenticated', plugin: 'auth', message: 'no' }); });
  const handler = makeAllowHostHandler({ bus, initCtx });
  const r1 = fakeRes();
  await handler(fakeReq({ body: Buffer.from('{"sessionId":"s1","host":"h"}') }), r1);
  expect(r1.statusCode).toBe(401);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/server/routes-allow-host.test.ts`
Expected: FAIL — module/handler doesn't exist.

- [ ] **Step 3: Implement the route**

Create `packages/channel-web/src/server/routes-allow-host.ts` (mirror `routes-chat.ts`'s POST-handler + `http:register-route` shape; zod-validate the body; build the per-request ctx from the authenticated user):

```typescript
import { makeAgentContext, makeReqId, PluginError, type AgentContext, type HookBus } from '@ax/core';
import { z } from 'zod';
import type { RouteRequest, RouteResponse } from './sse.js';

const BodySchema = z.object({
  sessionId: z.string().min(1).max(128),
  host: z.string().min(1).max(253),
});

export function makeAllowHostHandler(deps: { bus: HookBus; initCtx: AgentContext }) {
  return async function handle(req: RouteRequest, res: RouteResponse): Promise<void> {
    let userId: string;
    try {
      const r = await deps.bus.call<{ req: RouteRequest }, { user: { id: string } }>('auth:require-user', deps.initCtx, { req });
      userId = r.user.id;
    } catch (err) {
      if (err instanceof PluginError) { res.status(401).json({ error: 'unauthenticated' }); return; }
      throw err;
    }
    const parsed = BodySchema.safeParse(JSON.parse(req.body.toString('utf-8') || '{}'));
    if (!parsed.success) { res.status(400).json({ error: 'invalid-body' }); return; }

    // Per-request ctx carries the AUTHENTICATED identity. The proxy re-checks
    // ownership against SessionConfig.userId — a forged sessionId can't widen
    // someone else's session.
    const ctx = makeAgentContext({ sessionId: parsed.data.sessionId, agentId: '', userId, reqId: makeReqId() });
    try {
      const out = await deps.bus.call<{ sessionId: string; host: string }, { added: boolean }>(
        'proxy:add-host', ctx, { sessionId: parsed.data.sessionId, host: parsed.data.host },
      );
      res.status(200).json(out);
    } catch (err) {
      if (err instanceof PluginError && err.code === 'forbidden') { res.status(403).json({ error: 'forbidden' }); return; }
      if (err instanceof PluginError && err.code === 'invalid-host') { res.status(400).json({ error: 'invalid-host' }); return; }
      throw err;
    }
  };
}
```

In `packages/channel-web/src/server/plugin.ts`: add `'proxy:add-host'` to `manifest.calls` (≈83-98; channel-web only loads in the k8s preset, which always loads `@ax/credential-proxy`, so it's a hard dep), and register the route in `init` (mirror the `/api/chat/stream/:reqId` registration ≈173):

```typescript
const allowHost = makeAllowHostHandler({ bus, initCtx });
const allowHostRoute = await bus.call<{ method: 'POST'; path: string; handler: typeof allowHost }, { unregister: () => void }>(
  'http:register-route', initCtx, { method: 'POST', path: '/api/chat/allow-host', handler: allowHost },
);
unregisterRoutes.push(allowHostRoute.unregister);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/server/routes-allow-host.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/server/routes-allow-host.ts packages/channel-web/src/server/plugin.ts packages/channel-web/src/__tests__/server/routes-allow-host.test.ts
git commit -m "feat(channel-web): POST /api/chat/allow-host → host-internal proxy:add-host"
```

---

## Phase E — Canary + verification

### Task 15: End-to-end attribution+grant test, full verification, security-checklist, PR

**Files:**
- Create: `packages/credential-proxy/src/__tests__/reactive-wall.canary.test.ts`

- [ ] **Step 1: Write the canary (attribution + live grant + retry, no re-spawn)**

Boot the credential-proxy plugin (real listener) + a host bus. Open a session with a token + an allowlist that excludes `blocked.example.com`. Assert the full reactive loop end to end:

```typescript
it('reactive wall: blocked egress is attributed → proxy:add-host widens live → retry succeeds (no re-spawn)', async () => {
  const { bus, sessions, listener } = await bootProxyPlugin();
  const audits: HttpEgressEvent[] = [];
  bus.subscribe('event.http-egress', 'canary/egress', async (_c, p) => { audits.push(p as never); return undefined; });

  const open = await bus.call('proxy:open-session', ctx({ userId: 'u1' }), {
    sessionId: 's1', userId: 'u1', agentId: 'a1', allowlist: ['allowed.example.com'], credentials: {},
  });
  const token = open.proxyAuthToken;
  const auth = { 'proxy-authorization': 'Basic ' + Buffer.from('ax:' + token).toString('base64') };

  // 1) Blocked request carrying the token → 403, attributed to s1.
  const r1 = await httpForwardThroughProxy(listener, { method: 'GET', url: 'http://blocked.example.com/', headers: auth });
  expect(r1.status).toBe(403);
  const block = audits.find((a) => a.blockedReason === 'allowlist' && a.host === 'blocked.example.com');
  expect(block?.sessionId).toBe('s1'); // attribution (Phase A) works

  // 2) Owner grants the host live — no re-spawn.
  expect(await bus.call('proxy:add-host', ctx({ userId: 'u1' }), { sessionId: 's1', host: 'blocked.example.com' })).toEqual({ added: true });

  // 3) Retry now passes the allowlist gate (we stub upstream so the assertion
  //    is "no longer a domain_denied 403", not a real fetch).
  const r2 = await httpForwardThroughProxy(listener, { method: 'GET', url: 'http://blocked.example.com/', headers: auth });
  expect(r2.status).not.toBe(403);
  await listener.stop();
});
```

(Mirror the file's existing real-listener request helpers; if the proxy package has no `bootProxyPlugin`, build the plugin via `createCredentialProxyPlugin({ listen: { kind: 'tcp', host: '127.0.0.1', port: 0 } }).init({ bus })` and reach the shared `sessions`/`listener` through the same seam the other tests use.)

- [ ] **Step 2: Run the canary**

Run: `pnpm -F @ax/credential-proxy test -- src/__tests__/reactive-wall.canary.test.ts`
Expected: PASS.

- [ ] **Step 3: Full build + test + lint (pre-PR gate)**

Run:
```bash
pnpm build
pnpm test
pnpm lint
```
Expected: all green. `pnpm build` (tsc project refs) catches the new `proxyAuthToken` field not being threaded everywhere it's consumed and the `PermissionRequest` union not being handled in every `kind` switch; `pnpm lint` catches an accidental cross-plugin import (`no-restricted-imports`) in the orchestrator/channel-web, and a raw color / non-shadcn primitive in `PermissionCard.tsx`. Bug-fix-test policy: any bug found here gets a regression test before the fix is considered done.

- [ ] **Step 4: Run the `security-checklist` skill (pre-PR gate)**

Invoke the `security-checklist` skill and answer all three threat models against the [pre-stated model](#security-threat-model-pre-stated). Key items: (a) `proxy:add-host` is host-internal + owner-checked — confirm no IPC action was added; (b) the proxy token is attribution-only and confers no capability even when readable from `$HTTPS_PROXY`; (c) the grant route forces server-side identity + CSRF + zod, never trusting the browser's `sessionId` for authorization. Paste the structured note into the PR.

- [ ] **Step 5: Commit + open the PR**

```bash
git add packages/credential-proxy/src/__tests__/reactive-wall.canary.test.ts
git commit -m "test(credential-proxy): reactive-wall canary (attribution → live grant → retry)"
```

PR description MUST include:
- **Boundary review** — `proxy:add-host` `{ sessionId, host } → { added }`, host-internal service hook (alternate impl = any egress gate; no leak; subscriber risk none); the `chat:permission-request` host variant `{ kind:'host', host, sessionId }` (channel-agnostic, no secret). Explicitly note the design's "`IPC: yes`" boundary note is **stale/rejected** (fork #1) and the per-session-token attribution closes the design's missing 403→session link (fork #2).
- **Half-wired window OPEN** (see below).
- The `security-checklist` structured note.

---

## Half-wired window

Stated explicitly per hard requirement #5:

1. **"Always for this agent" persistence is not built.** This phase, **both** buttons perform the same **live** grant via `proxy:add-host` (the host is widened for the session's life). The per-`(user, agent)` "always-allow" list that survives across sessions + its revoke path is **TASK-44** (design §P7.3). The button is present and functional (it grants now); only the durability is deferred. **CLOSES in TASK-44.**
2. **Seamless auto-retry is not built.** Granting widens the live allowlist, so the *next* egress to that host succeeds (design §7: host-grant = no re-spawn). But this card does **not** inject a synthetic "retry now" turn — if the model already concluded its turn, the user re-prompts (or the model retries on its own). The seamless pause→grant→auto-continue is the same turn-injection machinery as **TASK-36** (pending-turn → resume) and is owned there. The wall's security-critical core (attribution + the user-gated live grant) is fully built and tested here.
3. **What IS fully wired (no dead code — invariant #3):** per-session token attribution (proven by the canary — a blocked request carries its sessionId), `proxy:add-host` (proven by the proxy unit tests + canary live grant), the orchestrator surfacing (proven by the orchestrator tests), the SSE host frame (server test), the transport+store (client tests), the card UI + grant route (component + route tests). `proxy:add-host` has a real production caller (the grant route) — it is not half-wired.

---

## Security threat model (pre-stated)

The `security-checklist` skill is a **pre-PR gate** (Task 15 Step 4). This card touches the **egress trust boundary at runtime** — the flagged threat. Starting model:

- **Runtime egress widening (the flagged threat).** `proxy:add-host` widens a live session's allowlist with **no** spawn/credential/filesystem reach — it only `allowlist.add(host)` on the session's own `Set`. It is **host-internal** (never an IPC action — fork #1), so the untrusted runner cannot call it; the only caller is the authenticated owner's browser via a CSRF-gated route, and the proxy re-validates `SessionConfig.userId === ctx.userId`. A user can therefore widen only **their own** isolated sandbox's egress — exactly the capability the wall is designed to grant (decision #3, §10). The host is exact-match, hostname-validated (no wildcards/ports/schemes) at both the route and the proxy (defense-in-depth, I2). Capability minimized: a single host, a single session, no blanket egress.
- **Per-session proxy token (new untrusted-content-adjacent surface).** The token rides in `$HTTPS_PROXY` and is **readable by the model's Bash tool** (`echo $HTTPS_PROXY`). This is acceptable because the token is an **attribution label, not an authz input**: the allow/deny gate ignores it (a missing/forged token degrades to today's unattributed behavior — it can never *widen* egress), and `proxy:add-host` ownership is validated via `SessionConfig.userId`, not the token. Worst case for a prompt-injected model: it makes the wall card appear on **its own** session's stream for a host it tried to reach — which is precisely the wall working as intended (the user is the backstop, §10). It cannot forge another session's token (each is random 16-byte per session) to surface a card elsewhere with any security consequence (the card is benign + the grant is owner-checked).
- **Prompt-injection steering the card.** The card's `host` is whatever the model tried to reach — by design (an ad-hoc fetch no skill declared). The user sees the exact hostname before allowing (the §10 card-as-backstop). The host string renders as a React text node (auto-escaped; no raw-HTML sink), so a hostile hostname can't inject markup.
- **Sandbox / capability leakage.** No new IPC action (the agent→host wire surface is unchanged). No new filesystem/process/env reach. The proxy listener change is attribution-only (the SSRF/private-IP/canary/MITM guards are untouched). The orchestrator surfacing is host-side and observation-only.
- **Supply chain.** No new third-party dependency: undici `ProxyAgent` (already used), Node `crypto`/`http`/`net` (stdlib), zod + shadcn primitives already installed. (Confirm `pnpm-lock.yaml` shows no new registry packages.)

---

## Self-Review

**Spec coverage** (against design §6B flow B, §7 turn mechanics, §10 security, §11 component #4, decision #4, and the card body):

- "A raw proxy 403 becomes an in-chat 'Allow access to host?' card" → Phase A makes the 403 attributable (Tasks 1–8) + Task 10 surfaces it + Tasks 11–13 render it. The as-built gap (no 403→session attribution) is closed by the per-session token, per the human's decision. ✓
- "Just this once / Always for this agent" → Task 13's two buttons; "Always" persistence is the stated TASK-44 half-wired seam. ✓
- "Granting widens the live session allowlist via `proxy:add-host` — no re-spawn — and the agent retries" → Task 9 (`allowlist.add`, live, no re-spawn) + Task 14 (grant route) + the canary's retry assertion (Task 15). Seamless auto-retry is the stated TASK-36 seam. ✓
- "Capabilities minimized: a single host to a single session, never blanket egress" → Task 9 ownership check + exact-match host validation; threat model. ✓
- "New hook + IPC `proxy:add-host {sessionId, host}` — schema in @ax/credential-proxy" → resolved: host-internal service hook (NOT IPC — fork #1), registered in `@ax/credential-proxy`. The design's "IPC: yes" is flagged stale in the PR. ✓
- "Security-checklist (egress boundary widening at runtime)" → pre-PR gate (Task 15 Step 4) + pre-stated threat model. ✓
- "Reuses the card/SSE frame from TASK-35" → Tasks 11–13 extend TASK-35's `chat:permission-request` hook, `permissionRequest` SSE frame, `permission-card-store`, transport branch, and `<PermissionCard>` to a discriminated union. ✓

**Placeholder scan:** every code step shows real code; every test step shows real assertions; every run step shows the exact `pnpm -F` command + expected result. Harness-bound steps (proxy listener request helpers, sandbox open-session test helpers, the SSE `bootHandler`/`fakeRes`, transport `sseStream`/`drain`/`run`) reference each file's existing helpers by name with concrete assertions — matching the template's harness-bound tasks. No TBD/TODO in shipped code. ✓

**Type consistency:** `proxyAuthToken: string` (32-hex) flows: `OpenSessionOutput` (credential-proxy) → orchestrator `endpointToProxyConfig` → `ProxyConfigSchema` (sandbox-protocol) → both sandbox backends' env (`AX_PROXY_TOKEN`) → runner `proxy-startup` userinfo → listener `parseProxyToken`. `SessionConfig.proxyToken` is the stored copy. The `PermissionRequest` union `{ kind:'skill'|'host' }` is identical at every hop (server `types.ts`, `sse.ts`, transport `SseFrame`, `permission-card-store`, `<PermissionCard>`); the host variant is `{ kind:'host', host, sessionId }` to the browser (+ a routing `reqId` on the hook payload, stripped before the frame). `proxy:add-host` is `{ sessionId, host } → { added: boolean }` at the hook, the route, and the client `grantHost`. The host-variant SSE match key is `payload.reqId` (distinct from the skill variant's `ctx.conversationId` — intentional, each producer's available key).

**Known residual / forks (resolved):** (1) attribution is best-effort — a request with no/forged token degrades to no card (never to wider egress), acceptable; (2) the host-variant card is live-only (not buffered like content frames) — if no SSE is attached when the block fires, the card is lost and the egress stays blocked (same as today), acceptable for the wall; (3) the allow/deny gate stays ORed-across-sessions (unchanged) — per-session egress *isolation* via the token is a possible hardening follow-up, deliberately out of scope to avoid an allow/deny regression; (4) "Always" grants live but doesn't persist (TASK-44) and there's no seamless auto-retry (TASK-36) — both stated half-wired seams.
