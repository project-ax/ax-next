# JIT Per-Session Proxy Token (Egress Attribution) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the credential-proxy attribute **every** request — including an allowlist-miss **403** — to the session that made it, by minting a per-session **proxy token** that the sandbox carries as `Proxy-Authorization`, so `event.http-egress` carries a real `sessionId` on blocked egress (today it's an empty string — `plugin.ts:62`). This is the foundation the reactive egress wall (**TASK-37**) builds on, and it immediately improves blocked-egress audit attribution for `@ax/audit-log`.

**Architecture:** `proxy:open-session` mints a 32-hex token and stamps it on the session config. Both sandbox backends carry it into the sandbox proxy env (`AX_PROXY_TOKEN`); the runner embeds it as HTTP **Basic** userinfo (`http://ax:<token>@host:port`) into the proxy URLs every egress client reads, so curl / undici / python all auto-send `Proxy-Authorization: Basic ax:<token>`. The bridge forwards that header on CONNECT (it's already forwarded on the HTTP path). The listener resolves token → session on each request and stamps the block audit with the attributed `sessionId`/`userId`. **Attribution-only:** the token is a *label*, never an allow/deny input — `findAllowingSession` (ORed across sessions) is unchanged, so a missing/forged token degrades to today's empty-`sessionId` behavior and can never *widen* egress.

**Tech Stack:** TypeScript, pnpm workspace, tsconfig project refs, the in-process hook bus, zod (`@ax/sandbox-protocol`), Node `http`/`net`/`crypto` (the proxy listener + bridge), undici `ProxyAgent` (runner), vitest.

---

## Scope guardrails

- **Security-checklist applies** (it touches the egress trust boundary + introduces a token reachable by the model's Bash tool) — it is a **pre-PR gate** (Task 9 Step 4). Pre-stated threat model in [Security threat model](#security-threat-model-pre-stated).
- **Attribution-only, no allow/deny change.** The allowlist gate (`findAllowingSession`, ORed across all sessions) is untouched. The token only *labels* requests for attribution. A request with no/forged token degrades to today's behavior (empty `sessionId` on a block) — it never widens egress. This keeps the change low-risk on the security-critical egress path.
- **Backend-agnostic wire field (I1).** The new `proxyConfig.proxyAuthToken` is an opaque secret — no transport/storage vocabulary (`sha`/`pod`/`socket`/`bucket`), no leak.
- **No cross-plugin imports (I2).** The runner's `withProxyToken` + the listener's `parseProxyToken` are re-implemented at their own trust boundaries (defense-in-depth, the `validateMcpEntry` posture); nothing imports a shared token helper across the plugin boundary.
- **Half-wired window (stated):** see [Half-wired window](#half-wired-window) — the attributed `sessionId` is consumed **today** by `@ax/audit-log` (blocked-egress audit entries gain a real session), so this is **not** dead code; the reactive-wall card that *acts* on a block (`proxy:add-host` + surfacing) is **TASK-37**.

## Dependency status & as-built re-verification (READ FIRST)

**Depends on:** none. This is independent egress-boundary work on as-built code (TASK-33 merged, #182). It is a **dependency of TASK-37** (the reactive wall). Before Task 1, **re-confirm against `main`** (hard requirement #1 — do not trust file:line anchors):

- [ ] **`@ax/credential-proxy`** (`packages/credential-proxy/src/plugin.ts`): `proxy:open-session` returns `OpenSessionOutput { proxyEndpoint, caCertPem, envMap }` (≈207-214); the handler builds a `SessionConfig` and sets `userId: input.userId` on it (≈383-398). The shared `sessions: Map<string,SessionConfig>` is mutated by reference (plugin.ts:8-11). `SessionConfig` (`listener.ts:54-111`) carries `allowlist`, optional `userId`/`sessionId`/`classification`.
- [ ] **The deny path leaves `sessionId` empty** (`listener.ts:434-453` HTTP, ≈846-880 CONNECT): `findAllowingSession` (`listener.ts:230-238`) ORs across all sessions; on miss the `domain_denied` audit has no session fields, and `plugin.ts`'s `onAudit` (≈296-333) emits `event.http-egress` with `sessionId: ''`. `HttpEgressEvent` (`plugin.ts:62-81`). `@ax/audit-log` already subscribes to `event.http-egress` (`audit-log/src/plugin.ts:42`) and persists it — the immediate consumer of better attribution.
- [ ] **`@ax/sandbox-protocol`** `ProxyConfigSchema` (`schemas.ts:186-200`) = `{ endpoint?, unixSocketPath?, caCertPem, envMap }` with the exactly-one-of refine; `OpenSessionInputSchema` carries `proxyConfig?` (≈220).
- [ ] **Orchestrator** builds the `ProxyConfig` via `endpointToProxyConfig(proxyEndpoint, caCertPem, envMap)` at the `proxy:open-session` call site (`orchestrator.ts:1303-1306`); the local `proxy:open-session` result type is ≈251-255.
- [ ] **Sandbox proxy env:** `sandbox-subprocess/src/open-session.ts` sets `sessionEnv.HTTPS_PROXY = input.proxyConfig.endpoint` (≈457-458); `sandbox-k8s/src/pod-spec.ts` stamps `AX_PROXY_ENDPOINT`/`HTTPS_PROXY`/`HTTP_PROXY` from `pc.endpoint` and `AX_PROXY_UNIX_SOCKET` from `pc.unixSocketPath` (≈277-311), with a `PodProxyConfig` interface (≈69-71). Runner `proxy-startup.ts` has **bridge mode** (`AX_PROXY_UNIX_SOCKET` → `@ax/credential-proxy-bridge` + `setGlobalDispatcher(new ProxyAgent(local))`, ≈153-177) and **direct mode** (`AX_PROXY_ENDPOINT`, re-sets `anthropicEnv.HTTPS_PROXY` ≈241-246); `ENV_ALLOWLIST` forwards `http_proxy`/`https_proxy` to the SDK subprocess (≈64-67). `RunnerEnv` (`env.ts`) carries `proxyEndpoint?`/`proxyUnixSocket?`.
- [ ] **The bridge** (`credential-proxy-bridge/src/bridge.ts`): the HTTP-forward path forwards `proxy-authorization` (it's NOT in the strip list ≈43-56); the CONNECT path **rebuilds** the request line with only `Host` and drops other headers (≈105-134) — Task 8 fixes this.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/credential-proxy/src/plugin.ts` | `proxy:open-session` handler | **add** mint token, stamp `SessionConfig.proxyToken`, return `proxyAuthToken` |
| `packages/credential-proxy/src/listener.ts` | proxy request handlers | **add** `SessionConfig.proxyToken`, `parseProxyToken`, `findSessionByProxyToken`, stamp block audits |
| `packages/sandbox-protocol/src/schemas.ts` | `ProxyConfigSchema` | **add** optional `proxyAuthToken` |
| `packages/chat-orchestrator/src/orchestrator.ts` | `endpointToProxyConfig` | **thread** `proxyAuthToken` from the `proxy:open-session` result |
| `packages/sandbox-subprocess/src/open-session.ts` | subprocess session env | **add** `AX_PROXY_TOKEN` |
| `packages/sandbox-k8s/src/pod-spec.ts` | runner pod env | **add** `AX_PROXY_TOKEN` |
| `packages/agent-claude-sdk-runner/src/proxy-startup.ts` + `env.ts` | runner proxy bootstrap | **add** `withProxyToken` userinfo embedding (both modes) |
| `packages/credential-proxy-bridge/src/bridge.ts` | TCP→unix bridge | **forward** `Proxy-Authorization` on CONNECT |
| `packages/credential-proxy/src/__tests__/attribution.canary.test.ts` | end-to-end attribution canary | **create** |

---

## Shared rule: the proxy token (referenced by Tasks 1, 3, 5–8)

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

### Task 9: End-to-end attribution canary + full verification + security-checklist + PR

**Files:**
- Create: `packages/credential-proxy/src/__tests__/attribution.canary.test.ts`

- [ ] **Step 1: Write the attribution canary**

Boot the credential-proxy plugin (real listener) + a host bus. Open a session with a token + an allowlist that excludes `blocked.example.com`. Assert that a blocked request carrying the token is attributed to the session on `event.http-egress`:

```typescript
it('per-session token attributes a blocked egress to its session on event.http-egress', async () => {
  const { bus, listener } = await bootProxyPlugin();
  const audits: HttpEgressEvent[] = [];
  bus.subscribe('event.http-egress', 'canary/egress', async (_c, p) => { audits.push(p as never); return undefined; });

  const open = await bus.call('proxy:open-session', ctx({ userId: 'u1' }), {
    sessionId: 's1', userId: 'u1', agentId: 'a1', allowlist: ['allowed.example.com'], credentials: {},
  });
  const auth = { 'proxy-authorization': 'Basic ' + Buffer.from('ax:' + open.proxyAuthToken).toString('base64') };

  const res = await httpForwardThroughProxy(listener, { method: 'GET', url: 'http://blocked.example.com/', headers: auth });
  expect(res.status).toBe(403);

  const block = audits.find((a) => a.blockedReason === 'allowlist' && a.host === 'blocked.example.com');
  expect(block?.sessionId).toBe('s1'); // attribution: today this is '' — the whole point of TASK-52
  expect(block?.userId).toBe('u1');
  await listener.stop();
});

it('a blocked egress with NO token stays unattributed (degrade, no widening)', async () => {
  const { bus, listener } = await bootProxyPlugin();
  const audits: HttpEgressEvent[] = [];
  bus.subscribe('event.http-egress', 'canary/egress', async (_c, p) => { audits.push(p as never); return undefined; });
  await bus.call('proxy:open-session', ctx({ userId: 'u1' }), { sessionId: 's1', userId: 'u1', agentId: 'a1', allowlist: ['allowed.example.com'], credentials: {} });
  const res = await httpForwardThroughProxy(listener, { method: 'GET', url: 'http://blocked.example.com/', headers: {} });
  expect(res.status).toBe(403); // still blocked — token absence never widens
  const block = audits.find((a) => a.blockedReason === 'allowlist');
  expect(block?.sessionId).toBe(''); // unattributed
  await listener.stop();
});
```

(Mirror the file's real-listener request helpers; if the proxy package has no `bootProxyPlugin`, build via `createCredentialProxyPlugin({ listen: { kind: 'tcp', host: '127.0.0.1', port: 0 } }).init({ bus })` and reach the shared `listener` through the same seam the other tests use.)

- [ ] **Step 2: Run the canary**

Run: `pnpm -F @ax/credential-proxy test -- src/__tests__/attribution.canary.test.ts`
Expected: PASS.

- [ ] **Step 3: Full build + test + lint (pre-PR gate)**

Run:
```bash
pnpm build
pnpm test
pnpm lint
```
Expected: all green. `pnpm build` (tsc project refs) catches the new `proxyAuthToken` field not being threaded everywhere it's consumed; `pnpm lint` catches an accidental cross-plugin import. Bug-fix-test policy: any bug found here gets a regression test before the fix is considered done.

- [ ] **Step 4: Run the `security-checklist` skill (pre-PR gate)**

Invoke the `security-checklist` skill and answer all three threat models against the [pre-stated model](#security-threat-model-pre-stated). Key items: the token is attribution-only (allow/deny unchanged — a missing/forged token never widens egress); the token is readable from `$HTTPS_PROXY` by the model but confers no capability; no new IPC action. Paste the structured note into the PR.

- [ ] **Step 5: Commit + open the PR**

```bash
git add packages/credential-proxy/src/__tests__/attribution.canary.test.ts
git commit -m "test(credential-proxy): canary — per-session token attributes blocked egress"
```

PR description MUST include:
- **Boundary review** — `proxyConfig.proxyAuthToken` (opaque secret, backend-agnostic, no leak; alternate impl = any per-session egress identity). No new hook *signature* changes (additive field); no new IPC action.
- **Half-wired window OPEN** (see below).
- The `security-checklist` structured note.

---

## Half-wired window

Stated explicitly per hard requirement #5:

1. **The attributed `sessionId` has an immediate consumer — `@ax/audit-log`.** It subscribes to `event.http-egress` and persists each entry; with this change, blocked-egress audit entries gain a real `sessionId`/`userId` instead of empty strings. So this is **not** dead code (invariant #3): the token is minted → carried → embedded → parsed → stamped → consumed end-to-end (proven by the canary + audit-log's existing subscriber).
2. **The reactive-wall card that *acts* on a block is TASK-37.** `proxy:add-host` (live allowlist widening) + the orchestrator surfacing + the in-chat "Allow access to host?" card all live in **TASK-37**, which depends on this card. Until TASK-37 merges, a blocked egress is *attributed* (and audited with its session) but does not yet raise a user-facing card. **CLOSES in TASK-37.**

---

## Security threat model (pre-stated)

The `security-checklist` skill is a **pre-PR gate** (Task 9 Step 4). This card touches the **egress trust boundary**. Starting model:

- **Per-session proxy token (the flagged surface).** The token rides in `$HTTPS_PROXY` and is **readable by the model's Bash tool** (`echo $HTTPS_PROXY`). Acceptable because the token is an **attribution label, not an authz input**: the allow/deny gate (`findAllowingSession`) ignores it entirely — a missing/forged/leaked token degrades to today's unattributed behavior and can **never widen** egress. No capability is conferred by possessing it.
- **Forged/cross-session token.** A model could, in principle, present another session's token if it knew it — but each token is a random 16-byte secret per session, not derivable, and the only consequence of a forged match is mis-attributing an audit entry / (post-TASK-37) surfacing a benign "allow host?" card on another session's stream — no egress is widened (allow/deny is unchanged) and no credential is exposed.
- **Allow/deny unchanged.** The SSRF/private-IP/canary/MITM guards and `findAllowingSession` are untouched; this card only adds a *label* on the audit path. There is no path by which the token changes whether a request is forwarded.
- **No new wire/IPC surface.** `proxyConfig.proxyAuthToken` is an additive field on the existing host→sandbox config; no new runner→host IPC action; the agent→host wire surface is unchanged.
- **Supply chain.** No new third-party dependency: undici `ProxyAgent` (already used), Node `crypto`/`http`/`net` (stdlib), zod already installed. (Confirm `pnpm-lock.yaml` shows no new registry packages.)

---

## Self-Review

**Spec coverage** (against the reactive-wall design §6B/§11 + the split-out attribution requirement):
- "A proxy 403 carries a real `sessionId`" → Tasks 1–8 (mint → carry → embed → parse → stamp); proven by Task 9's canary. ✓
- "Works in both proxy transports" → direct/TCP (Tasks 5, 7) + bridge/unix (Tasks 7, 8 — the CONNECT-header forward). ✓
- "Attribution-only, no allow/deny regression" → `findAllowingSession` untouched; the no-token canary asserts a blocked request stays blocked + unattributed. ✓
- "Foundation for TASK-37" → the half-wired window names TASK-37 as the consumer of the live grant; `@ax/audit-log` is the immediate consumer of attribution. ✓

**Placeholder scan:** every code step shows real code; every test step shows real assertions; every run step shows the exact `pnpm -F` command + expected result. Harness-bound steps reference each file's existing helpers by name with concrete assertions. No TBD/TODO in shipped code. ✓

**Type consistency:** `proxyAuthToken: string` (32-hex) flows `OpenSessionOutput` (credential-proxy) → orchestrator `endpointToProxyConfig` → `ProxyConfigSchema` (sandbox-protocol) → both sandbox backends' env (`AX_PROXY_TOKEN`) → runner `proxy-startup` userinfo → listener `parseProxyToken`. `SessionConfig.proxyToken` is the stored copy. `PROXY_TOKEN_RE = /^[0-9a-f]{32}$/` is re-asserted at the mint (Task 1), the schema (Task 3), the runner (Task 7), and the listener (Task 2) — each trust boundary independently (I2).

**Known residual / forks (resolved):** (1) attribution is best-effort — a request with no/forged token degrades to no attribution (never to wider egress), acceptable; (2) the allow/deny gate stays ORed-across-sessions (unchanged) — per-session egress *isolation* via the token is a possible hardening follow-up, deliberately out of scope here to avoid an allow/deny regression.
