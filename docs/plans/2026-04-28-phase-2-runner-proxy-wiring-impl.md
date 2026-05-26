# Phase 2 Implementation Plan — wire credential-proxy + bridge into the SDK runner

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the half-wired window opened by Phase 1a. The host loads `@ax/credential-proxy`; the chat-orchestrator opens a per-session proxy session before sandbox launch and threads the placeholder env + CA into the runner; the SDK runner starts the (k8s-only) bridge, points `HTTPS_PROXY` at the proxy, trusts the MITM CA, and lets the SDK make real Anthropic API calls with `ax-cred:` placeholder keys that the proxy substitutes mid-flight.

**Architecture:**

- `@ax/chat-orchestrator` becomes the proxy-session lifecycle owner. New flow inside `agent:invoke`: `agents:resolve` → `proxy:open-session` → `sandbox:open-session` (now carrying a `proxyConfig` blob) → enqueue → await `chat:end` → `proxy:close-session` in `finally`.
- `@ax/sandbox-subprocess` accepts the `proxyConfig` blob, writes the CA cert PEM to a per-session tmpfile, and injects `HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS` + `SSL_CERT_FILE` (and `AX_PROXY_UNIX_SOCKET` when applicable, k8s-only) into the runner env.
- `@ax/agent-claude-sdk-runner` startup reads the proxy env. If `AX_PROXY_UNIX_SOCKET` is set, starts `startWebProxyBridge()` from `@ax/credential-proxy-bridge` and overrides `HTTP_PROXY` / `HTTPS_PROXY` to point at the local bridge port. Stops setting `ANTHROPIC_BASE_URL` (was pointed at the in-sandbox `llm-proxy-anthropic-format`); the SDK now calls `api.anthropic.com` directly through `HTTPS_PROXY`, with `ANTHROPIC_API_KEY=ax-cred:<placeholder>`. The placeholder is substituted at the credential-proxy boundary.
- `@ax/llm-proxy-anthropic-format` stays loaded for the native runner (which still uses `AX_LLM_PROXY_URL`); deletion is Phase 5/6 work.

**Tech Stack:**

- TypeScript / Node 20+
- Vitest (`.test.ts` per package)
- `@ax/credential-proxy` + `@ax/credential-proxy-bridge` (already shipped — Phase 1a)
- `@anthropic-ai/claude-agent-sdk@0.2.119` (vendored runner SDK; already a dep)

---

## Reference material

ax-next files this plan touches (read before editing):

| File | Why |
|---|---|
| `packages/credential-proxy/src/plugin.ts` | The hook surface we're wiring (`proxy:open-session` / `:rotate-session` / `:close-session`). Lines 330–445 carry the input/output shapes — copy them verbatim into the orchestrator (no `@ax/credential-proxy` import — I2). |
| `packages/credential-proxy-bridge/src/bridge.ts` | `startWebProxyBridge(unixSocketPath) → { port, stop }`. Sandbox-side library. Already a workspace dep of any package that wants to import it. |
| `packages/chat-orchestrator/src/orchestrator.ts:308–730` | `runChat` is the function we extend. The new proxy-session lifecycle bookends `sandbox:open-session`. |
| `packages/sandbox-subprocess/src/open-session.ts:241–270` | The runner-env construction site. New `proxyConfig` field on `OpenSessionInput` lands here. |
| `packages/agent-claude-sdk-runner/src/main.ts:60–305` | Runner entry. New bridge-startup + env-rewrite happens before `query()` opens. |
| `packages/agent-claude-sdk-runner/src/env.ts` | `RunnerEnv` shape — extend with optional `proxyEndpoint`, `proxyUnixSocket`, `proxyCaCertPath`. |
| `packages/cli/src/main.ts:131–168` | Where `createCredentialProxyPlugin()` lands in the chat-path plugin set. |
| `presets/k8s/src/index.ts:295–330` | Same wiring in the k8s preset. |
| `~/dev/ai/ax/src/agent/runner.ts:485–542` | **Read-only reference.** v1's runner-startup env-setup pattern. The bridge-then-set-env shape ports verbatim; the surrounding v1 code does NOT. |

Reference patterns already in the codebase:

- Plugin lifecycle with `init` + service registration: `packages/credential-proxy/src/plugin.ts`
- Test pattern for the orchestrator's bus-call shape: `packages/chat-orchestrator/src/__tests__/orchestrator.test.ts`
- Real-provider-gated e2e test (skips unless env set): `packages/agent-claude-sdk-runner/src/__tests__/claude-sdk-runner.e2e.test.ts`

---

## Invariants (verified per task)

These reflect Phase 1a's lessons + the design's invariants under Phase 2.

- **I1 — Real credentials never enter the sandbox process.** Sandbox env carries only `ax-cred:<hex>` placeholders. The CA cert PEM bytes ARE allowed inside the sandbox (it's a public key); the CA private key is NOT.
- **I2 — No cross-plugin imports.** The orchestrator calls `proxy:*` via `bus.call`. No `import` from `@ax/credential-proxy` anywhere except its own tests. `@ax/credential-proxy-bridge` is allowed inside the runner because it's a sandbox-side library, not a hook plugin (eslint allowlist already covers `packages/agent-*-runner/**`).
- **I3 — `proxyConfig` payload field names don't leak backend choice.** Use `endpoint` (string URI) not `socketPath`/`port`/`url`. Use `caCertPem` (string) not `caCertPath`. The orchestrator → sandbox boundary speaks in `endpoint` + `caCertPem`; sandbox-subprocess decides where to put them on disk.
- **I4 — Boundary review for the new `OpenSessionInput.proxyConfig` field.** Alternate impl named, leaky names ruled out, subscriber risk noted, wire surface flagged. Recorded in PR description.
- **I5 — Capabilities are explicit.** Orchestrator manifest gains `calls: ['proxy:open-session', 'proxy:close-session']` (and `proxy:rotate-session` deferred — single-turn flow doesn't rotate yet). Sandbox-subprocess manifest unchanged (it doesn't call proxy hooks; it receives the resolved blob).
- **I6 — Half-wired window closes here.** After this PR: `@ax/credential-proxy` and `@ax/credential-proxy-bridge` are both reachable from the canary acceptance test. PR description must explicitly close the Phase 1a window.
- **I7 — `proxy:close-session` always fires once per `proxy:open-session`.** Goes in the orchestrator's `finally` block. The chat:end / timeout / sandbox-exit / queue-work-failure paths all flow through it. (Tested in Task 4.)
- **I8 — SDK runner stops setting `ANTHROPIC_BASE_URL` when the proxy is wired.** The runner reads the env at startup; if `AX_PROXY_ENDPOINT` is set, it does NOT pass `ANTHROPIC_BASE_URL` into the SDK options. The native runner is untouched.
- **I9 — `AX_LLM_PROXY_URL` becomes optional in `readRunnerEnv` when `AX_PROXY_ENDPOINT` is set.** Bumping it from required to "required-XOR" is the only env-shape change in this PR.
- **I10 — Bridge mode (`AX_PROXY_UNIX_SOCKET` set) overrides `HTTP_PROXY` / `HTTPS_PROXY`.** Sandbox-subprocess sets HTTPS_PROXY to the host TCP listener; runner's bridge code rewrites it to point at the local bridge port. The order is: (a) sandbox sets env, (b) runner reads env, (c) runner conditionally starts bridge, (d) runner overrides env vars in-process before the SDK reads them.

---

## Open questions resolved before execution

1. **Why split `proxyConfig` from the existing top-level fields?** Adding a single namespaced object (vs. three sibling fields `proxyEndpoint`, `proxyUnixSocket`, `proxyCaCertPem`) keeps the wire schema cohesive when Phase 5 adds `proxyConfig.canaryToken` etc.
2. **CA cert delivery: PEM bytes or path?** Bytes. Sandbox-subprocess writes the PEM to a per-session tmpfile and passes the path to the runner via `NODE_EXTRA_CA_CERTS`. K8s sandbox (future) will mount a per-pod tmpfs and write the PEM there. Either way, the orchestrator never knows or cares about filesystem paths — it just hands over the bytes.
3. **`HTTPS_PROXY` form: TCP loopback or Unix socket URI?** Subprocess uses TCP loopback (`http://127.0.0.1:<proxyPort>`). K8s uses `AX_PROXY_UNIX_SOCKET=/path/to/sock` and the runner-side bridge starts and rewrites HTTP_PROXY to its own port. Single env field `AX_PROXY_ENDPOINT` carries the TCP URL when present; `AX_PROXY_UNIX_SOCKET` carries the socket path when present. They're mutually exclusive.
4. **Per-turn rotation (`proxy:rotate-session`) — Phase 2 or later?** Later. Section 5 of the design calls out a "Per-turn rotation seam" and ships the **coarse** path (open once, close once, no rotation) as MVP. We honor that here. Add `proxy:rotate-session` plumbing in the orchestrator only when an OAuth session demonstrably outlives the access-token expiry window — i.e., during Phase 3 verification, not before.
5. **Native runner (`@ax/agent-native-runner`) — Phase 2 or later?** Untouched. The native runner uses `AX_LLM_PROXY_URL` and the in-sandbox `llm-proxy-anthropic-format`. Phase 5/6 deletes both. Phase 2 limits scope to the SDK runner.
6. **End-to-end test gating.** Real Anthropic API calls cost money and require a key. Test gates on `AX_TEST_ANTHROPIC_KEY` env var; absent → skip with a clear message. Mirrors `claude-sdk-runner.e2e.test.ts`'s existing pattern.
7. **Allowlist for the canary test.** The default agent's `allowedHosts` must include `api.anthropic.com`. The dev-agents-stub plugin (`packages/cli/src/dev-agents-stub.ts`) is the agent source the CLI uses; we extend its returned record with `allowedHosts: ['api.anthropic.com']`. The k8s preset uses real `@ax/agents` — admin must seed an agent with the right allowlist; documented in PR description.
8. **`requiredCredentials` shape today.** `dev-agents-stub` does not currently return any credential refs (the SDK runner gets its key indirectly via `AX_LLM_PROXY_URL`). For Phase 2 we extend the stub to return `{ ANTHROPIC_API_KEY: { ref: 'anthropic-api', kind: 'api-key' } }`. The CLI documents that users `ax-next credentials set anthropic-api` before the canary works.

---

## Tasks

### Task 1: Extend `OpenSessionInput` with `proxyConfig`

**Goal:** Add the optional `proxyConfig` field on the orchestrator → sandbox boundary so the orchestrator has a place to hand off proxy session metadata.

**Files:**
- Modify: `packages/chat-orchestrator/src/orchestrator.ts:169–198` (the `OpenSessionInput` interface)
- Modify: `packages/sandbox-subprocess/src/open-session.ts:80–120` (the receiving shape)

**Step 1.1: Decide the shape (no code yet)**

```ts
interface ProxyConfig {
  /**
   * Either the TCP endpoint (subprocess sandbox) OR the Unix socket path
   * (k8s sandbox). Mutually exclusive — exactly one is set per session.
   * Subprocess sandboxes use `endpoint`; k8s uses `unixSocketPath` and
   * the runner-side bridge translates it to a local TCP port.
   */
  endpoint?: string;        // e.g. 'http://127.0.0.1:54321'
  unixSocketPath?: string;  // e.g. '/var/run/ax/proxy.sock'
  /**
   * MITM CA certificate PEM bytes. The sandbox runtime writes this to
   * disk inside the sandbox and points NODE_EXTRA_CA_CERTS / SSL_CERT_FILE
   * at the path. The orchestrator never knows the path.
   */
  caCertPem: string;
  /**
   * Env injected by `proxy:open-session`. Maps env-var names (e.g.
   * `ANTHROPIC_API_KEY`) to `ax-cred:<hex>` placeholders the proxy
   * recognizes. Sandbox-subprocess merges these into the runner env.
   */
  envMap: Record<string, string>;
}
```

**Step 1.2: Write the test first**

Test file: `packages/chat-orchestrator/src/__tests__/orchestrator.test.ts`

Add a test case that constructs an `OpenSessionInput` with `proxyConfig` and asserts the sandbox plugin sees the field unchanged:

```ts
it('forwards proxyConfig from agent:invoke into sandbox:open-session', async () => {
  // Stub sandbox:open-session that captures the input.
  let captured: OpenSessionInput | undefined;
  // ... bootstrap with capturing stub ...
  await bus.call('agent:invoke', ctx, { message: { ... } });
  expect(captured?.proxyConfig).toEqual({
    endpoint: 'http://127.0.0.1:0', // value the proxy stub returned
    caCertPem: 'TEST-CA-PEM',
    envMap: { ANTHROPIC_API_KEY: 'ax-cred:0123' },
  });
});
```

Run: `pnpm --filter @ax/chat-orchestrator test -- orchestrator`
Expected: FAIL — `captured.proxyConfig is undefined`.

**Step 1.3: Add the field to the interface**

In `packages/chat-orchestrator/src/orchestrator.ts`, extend `OpenSessionInput`:

```ts
interface OpenSessionInput {
  sessionId: string;
  workspaceRoot: string;
  runnerBinary: string;
  owner: { ... };
  proxyConfig?: ProxyConfig;  // optional — undefined when no proxy plugin loaded
}
```

Run the test again. Still failing — the orchestrator doesn't populate `proxyConfig` yet. That's Task 2's job. Mark this test `it.todo` or a `describe.skip` block until Task 2 lands; do NOT fake-pass it.

**Step 1.4: Mirror the field on the sandbox side**

`packages/sandbox-subprocess/src/open-session.ts` — extend the input type used by the registered service handler. No behavioral change yet; just types.

**Step 1.5: Build + commit**

```bash
pnpm --filter @ax/chat-orchestrator --filter @ax/sandbox-subprocess build
git add packages/chat-orchestrator packages/sandbox-subprocess
git commit -m "feat(chat-orchestrator,sandbox-subprocess): add proxyConfig field on open-session boundary (Phase 2 prep)"
```

---

### Task 2: Wire `proxy:open-session` / `proxy:close-session` into the orchestrator

**Goal:** The orchestrator opens a proxy session before the sandbox and closes it in `finally`. Skipped when no plugin registered `proxy:open-session` (preserves the current CLI canary that doesn't load the proxy).

**Files:**
- Modify: `packages/chat-orchestrator/src/orchestrator.ts` — `runChat` function (steps 5–9 of the existing flow), `plugin.ts` (manifest `calls`)
- Modify: `packages/chat-orchestrator/src/__tests__/orchestrator.test.ts`

**Step 2.1: Write the test (red)**

Three test cases:

```ts
it('calls proxy:open-session before sandbox:open-session and threads result through', async () => { ... });
it('calls proxy:close-session in finally on the happy path', async () => { ... });
it('calls proxy:close-session in finally even when sandbox:open-session throws', async () => { ... });
```

Run: `pnpm --filter @ax/chat-orchestrator test -- orchestrator`
Expected: FAIL — proxy hooks never called.

**Step 2.2: Update the manifest**

In `packages/chat-orchestrator/src/plugin.ts`, append to `calls`:

```ts
calls: [
  ...existing,
  'proxy:open-session',
  'proxy:close-session',
],
```

But these are **soft deps** — the orchestrator works without them (CLI canary path). Boot's `verifyCalls` would fail with "no plugin registers proxy:open-session" if proxy isn't loaded. Two options:
1. Don't declare them in `calls`. Use `bus.hasService('proxy:open-session')` runtime-check.
2. Declare them. Force every preset to load proxy. (Cleaner long-term; fits I3 from the design.)

**Decision:** option (1). Phase 2 keeps proxy optional; Phase 5/6 (when the hard cut lands) makes it mandatory. The runtime check mirrors the `conversationsLoaded` pattern at `orchestrator.ts:383`.

**Step 2.3: Add the call sites**

After `agents:resolve` (around line 360), before `sandbox:open-session` (line 559):

```ts
const proxyLoaded = bus.hasService('proxy:open-session');
let proxyConfig: ProxyConfig | undefined;
if (proxyLoaded) {
  const opened = await bus.call<ProxyOpenSessionInput, ProxyOpenSessionOutput>(
    'proxy:open-session',
    ctx,
    {
      sessionId,
      userId: ctx.userId,
      agentId: agent.id,
      allowlist: agent.allowedHosts ?? [],
      credentials: agent.requiredCredentials ?? {},
      // bypassMITM, canaryToken: not in Phase 2
    },
  );
  proxyConfig = {
    endpoint: opened.proxyEndpoint, // see Step 2.4
    caCertPem: opened.caCertPem,
    envMap: opened.envMap,
  };
}
```

Pass `proxyConfig` into the `sandbox:open-session` payload at line 562.

**Step 2.4: Translate `proxyEndpoint` shape**

`@ax/credential-proxy`'s `proxyEndpoint` is `unix:///path/to/sock` OR `tcp://127.0.0.1:<port>`. Translate:

```ts
function endpointToProxyConfig(rawEndpoint: string, caCertPem: string, envMap: Record<string,string>): ProxyConfig {
  if (rawEndpoint.startsWith('unix://')) {
    return { unixSocketPath: rawEndpoint.slice('unix://'.length), caCertPem, envMap };
  }
  if (rawEndpoint.startsWith('tcp://')) {
    return { endpoint: 'http://' + rawEndpoint.slice('tcp://'.length), caCertPem, envMap };
  }
  throw new PluginError({ code: 'invalid-proxy-endpoint', plugin: PLUGIN_NAME, message: `unrecognized proxy endpoint: ${rawEndpoint}` });
}
```

Inline this; don't promote to a helper file unless Task 3 also needs it.

**Step 2.5: `finally` block**

Wrap the existing chat-end-await + sandbox-kill in a `try/finally` that fires `proxy:close-session` last:

```ts
try {
  // ... existing await chat:end + handle.kill ...
  return outcome;
} finally {
  if (proxyLoaded) {
    await bus.call('proxy:close-session', ctx, { sessionId }).catch((err) => {
      ctx.logger.warn('proxy_close_session_failed', { sessionId, err });
    });
  }
}
```

**Step 2.6: Run tests + commit**

```bash
pnpm --filter @ax/chat-orchestrator test
git add packages/chat-orchestrator
git commit -m "feat(chat-orchestrator): open + close credential-proxy session per agent:invoke (Phase 2)"
```

Expected: 3 new tests pass; existing 20 tests still pass.

---

### Task 3: Sandbox-subprocess writes CA + injects proxy env

**Goal:** When `proxyConfig` is present, write the CA PEM to a per-session tmpfile and inject `HTTPS_PROXY` / `NODE_EXTRA_CA_CERTS` / `SSL_CERT_FILE` / `AX_PROXY_ENDPOINT` / `AX_PROXY_UNIX_SOCKET` into the runner env.

**Files:**
- Modify: `packages/sandbox-subprocess/src/open-session.ts:241–270` (env construction)
- Modify: `packages/sandbox-subprocess/src/env.ts` (allowlist — does NOT need to change; the new vars are session-scoped, not parent-allowlisted)
- Modify: `packages/sandbox-subprocess/src/__tests__/open-session.test.ts`

**Step 3.1: Test first**

```ts
it('writes CA cert to disk and injects HTTPS_PROXY / NODE_EXTRA_CA_CERTS when proxyConfig is set', async () => {
  // ... bootstrap stub, call sandbox:open-session with proxyConfig ...
  // assert: child env contains the right vars
  // assert: a file exists at the path NODE_EXTRA_CA_CERTS points to, contents = pem
});
it('does not inject any HTTPS_PROXY when proxyConfig is undefined', async () => { ... });
```

Run: FAIL.

**Step 3.2: Implement the env injection**

In `open-session.ts`, after the existing `sessionEnv` block:

```ts
if (input.proxyConfig !== undefined) {
  const caPath = join(tempDir, 'ax-mitm-ca.pem');
  await writeFile(caPath, input.proxyConfig.caCertPem, { mode: 0o644 });
  sessionEnv.NODE_EXTRA_CA_CERTS = caPath;
  sessionEnv.SSL_CERT_FILE = caPath;
  if (input.proxyConfig.endpoint !== undefined) {
    sessionEnv.HTTPS_PROXY = input.proxyConfig.endpoint;
    sessionEnv.HTTP_PROXY = input.proxyConfig.endpoint;
    sessionEnv.AX_PROXY_ENDPOINT = input.proxyConfig.endpoint;
  }
  if (input.proxyConfig.unixSocketPath !== undefined) {
    // Subprocess sandbox passes through; the runner's bridge converts this
    // to a local TCP port and rewrites HTTP_PROXY/HTTPS_PROXY in-process.
    sessionEnv.AX_PROXY_UNIX_SOCKET = input.proxyConfig.unixSocketPath;
  }
  // Merge envMap last so per-session credential placeholders win over
  // anything we set above. (They shouldn't collide, but be explicit.)
  Object.assign(sessionEnv, input.proxyConfig.envMap);
}
```

`tempDir` already exists at line 200ish — reuse it.

**Step 3.3: Cleanup on session close**

The sandbox plugin's existing tempdir cleanup (rm -rf in the close handler) will sweep `ax-mitm-ca.pem` automatically. No new code.

**Step 3.4: Run + commit**

```bash
pnpm --filter @ax/sandbox-subprocess test
git add packages/sandbox-subprocess
git commit -m "feat(sandbox-subprocess): inject proxy env + write CA cert when proxyConfig is set (Phase 2)"
```

---

### Task 4: SDK runner — start bridge if `AX_PROXY_UNIX_SOCKET`, set SDK env

**Goal:** Runner startup reads `AX_PROXY_ENDPOINT` (TCP) or `AX_PROXY_UNIX_SOCKET` (k8s). For Unix sockets, starts `startWebProxyBridge()` and rewrites `HTTPS_PROXY` / `HTTP_PROXY` in-process. SDK invocation no longer sets `ANTHROPIC_BASE_URL` when the proxy is wired; the SDK calls `api.anthropic.com` directly through `HTTPS_PROXY`.

**Files:**
- Modify: `packages/agent-claude-sdk-runner/src/env.ts`
- Modify: `packages/agent-claude-sdk-runner/src/main.ts:60–305`
- Add: `packages/agent-claude-sdk-runner/src/__tests__/proxy-startup.test.ts`
- Modify: `packages/agent-claude-sdk-runner/package.json` (add `@ax/credential-proxy-bridge` as a workspace dep)

**Step 4.1: Update `RunnerEnv`**

```ts
export interface RunnerEnv {
  runnerEndpoint: string;
  sessionId: string;
  authToken: string;
  workspaceRoot: string;
  llmProxyUrl?: string;          // now optional — see I9
  proxyEndpoint?: string;        // AX_PROXY_ENDPOINT
  proxyUnixSocket?: string;      // AX_PROXY_UNIX_SOCKET
}
```

In `readRunnerEnv`:
- Make `AX_LLM_PROXY_URL` optional. Throw `MissingEnvError` only when BOTH `AX_LLM_PROXY_URL` AND `AX_PROXY_ENDPOINT`/`AX_PROXY_UNIX_SOCKET` are missing.
- New optional reads: `AX_PROXY_ENDPOINT`, `AX_PROXY_UNIX_SOCKET`. Empty string → undefined (consistent with existing convention).

**Step 4.2: Tests for env parsing (red, then green)**

In a new `env.test.ts`:

```ts
it('reads proxyEndpoint when set', () => { ... });
it('reads proxyUnixSocket when set', () => { ... });
it('throws when neither AX_LLM_PROXY_URL nor AX_PROXY_* is set', () => { ... });
it('does not throw when only AX_PROXY_ENDPOINT is set (no AX_LLM_PROXY_URL)', () => { ... });
```

**Step 4.3: Add bridge startup in `main.ts`**

Right after `readRunnerEnv()` returns:

```ts
let bridgeStop: (() => void) | undefined;
if (env.proxyUnixSocket !== undefined) {
  const { startWebProxyBridge } = await import('@ax/credential-proxy-bridge');
  const bridge = await startWebProxyBridge(env.proxyUnixSocket);
  process.env.HTTP_PROXY = `http://127.0.0.1:${bridge.port}`;
  process.env.HTTPS_PROXY = `http://127.0.0.1:${bridge.port}`;
  bridgeStop = bridge.stop;
}
```

Why dynamic `import`: keeps the bridge unloaded when not needed (subprocess sandbox doesn't use it).

**Step 4.4: Stop setting `ANTHROPIC_BASE_URL` when proxy mode is on**

At `main.ts:295`:

```ts
const anthropicEnv: Record<string, string> = {
  ANTHROPIC_API_KEY: env.authToken,
};
if (env.proxyEndpoint === undefined && env.proxyUnixSocket === undefined) {
  // Legacy llm-proxy-anthropic-format path. Phase 5/6 deletes this branch.
  anthropicEnv.ANTHROPIC_BASE_URL = env.llmProxyUrl!;
}
// ... pass anthropicEnv into query() options.env ...
```

**Step 4.5: Cleanup on exit**

Wherever the runner exits (the existing `try/finally` around the SDK loop), add:

```ts
if (bridgeStop !== undefined) {
  try { bridgeStop(); } catch { /* best-effort */ }
}
```

**Step 4.6: Add `@ax/credential-proxy-bridge` workspace dep**

In `packages/agent-claude-sdk-runner/package.json`:

```json
"dependencies": {
  ...
  "@ax/credential-proxy-bridge": "workspace:*"
}
```

`pnpm install` to lock.

**Step 4.7: Add the tsconfig reference**

In `packages/agent-claude-sdk-runner/tsconfig.json` references list, add `{ "path": "../credential-proxy-bridge" }`.

**Step 4.8: Test the bridge-startup path**

```ts
it('starts the bridge and rewrites HTTPS_PROXY when AX_PROXY_UNIX_SOCKET is set', async () => {
  // ... point at a fake Unix socket path; assert process.env after ...
});
```

This is a unit test for `main.ts`'s startup helper — extract the bridge-startup into a small `setupProxy(env)` function so it can be tested without the full SDK loop.

**Step 4.9: Build + commit**

```bash
pnpm install
pnpm --filter @ax/agent-claude-sdk-runner build
pnpm --filter @ax/agent-claude-sdk-runner test
git add packages/agent-claude-sdk-runner
git commit -m "feat(agent-claude-sdk-runner): start bridge + thread proxy env, drop ANTHROPIC_BASE_URL when proxy is wired (Phase 2)"
```

---

### Task 5: Wire `@ax/credential-proxy` into CLI + extend dev-agents-stub

**Goal:** CLI loads the proxy plugin. Default agent stub returns `allowedHosts: ['api.anthropic.com']` and `requiredCredentials: { ANTHROPIC_API_KEY: { ref: 'anthropic-api', kind: 'api-key' } }`.

**Files:**
- Modify: `packages/cli/src/main.ts` — add the import + push
- Modify: `packages/cli/src/dev-agents-stub.ts` — extend stub return shape
- Modify: `packages/cli/package.json` — add `@ax/credential-proxy` dep
- Modify: `packages/cli/src/__tests__/credentials-wiring.test.ts` (or sibling) — assert plugin is loaded

**Step 5.1: Push the plugin**

In `main.ts`, after the credentials block:

```ts
plugins.push(createCredentialProxyPlugin({
  listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
}));
```

The TCP variant is fine for subprocess sandbox. K8s preset uses Unix socket (Task 6).

**Step 5.2: Extend `dev-agents-stub`**

```ts
return {
  agent: {
    id: ctx.agentId,
    ownerId: ctx.userId,
    ownerType: 'user',
    visibility: 'personal',
    displayName: 'CLI agent',
    systemPrompt: '',
    allowedTools: [...],
    mcpConfigIds: [],
    model: 'claude-sonnet-4-6',
    workspaceRef: null,
    allowedHosts: ['api.anthropic.com'],
    requiredCredentials: {
      ANTHROPIC_API_KEY: { ref: 'anthropic-api', kind: 'api-key' },
    },
  },
};
```

The orchestrator already reads these (Task 2 added the call); shape must match what the proxy expects.

**Step 5.3: Test**

Existing `credentials-wiring.test.ts` already verifies plugin order. Add:

```ts
it('loads @ax/credential-proxy and registers proxy:open-session', async () => { ... });
```

**Step 5.4: Build + commit**

```bash
pnpm --filter @ax/cli build
pnpm --filter @ax/cli test
git add packages/cli
git commit -m "feat(cli): load @ax/credential-proxy + extend dev-agents-stub with allowedHosts/requiredCredentials (Phase 2)"
```

---

### Task 6: Wire `@ax/credential-proxy` into k8s preset

**Goal:** Same wiring in `presets/k8s/src/index.ts`. Uses Unix socket so sandbox pods can reach it without exposing host ports.

**Files:**
- Modify: `presets/k8s/src/index.ts`
- Modify: `presets/k8s/package.json`
- Modify: `presets/k8s/tsconfig.json`
- Modify: `presets/k8s/src/__tests__/preset.test.ts` (the plugin-list assertion)

**Step 6.1: Push the plugin**

```ts
plugins.push(createCredentialProxyPlugin({
  listen: { kind: 'unix', path: '/var/run/ax/proxy.sock' },
  // path must be writable; helm chart mounts an emptyDir at /var/run/ax.
}));
```

**Step 6.2: Update `preset.test.ts` plugin-name list**

Add `'@ax/credential-proxy'` to the expected `names` array (same pattern as Phase 1b's k8s preset update).

**Step 6.3: Add deps + tsconfig refs**

Mirror Phase 1b's edits.

**Step 6.4: Verify + commit**

```bash
pnpm install
pnpm --filter @ax/preset-k8s build
pnpm --filter @ax/preset-k8s test
git add presets/k8s
git commit -m "feat(preset-k8s): load @ax/credential-proxy on Unix socket (Phase 2)"
```

---

### Task 7: Audit-log subscribes to `event.http-egress`

**Goal:** Verify that `@ax/audit-log` already subscribes to `event.http-egress` (per the design Section 1, the audit log writes one line per egress). If not, wire it.

**Files:**
- Read: `packages/audit-log/src/plugin.ts`
- Possibly modify: same file
- Possibly modify: `packages/audit-log/src/__tests__/plugin.test.ts`

**Step 7.1: Read the existing audit-log plugin**

If it already subscribes to `event.http-egress`, this task is a no-op — note in the PR description that the wiring is verified.

**Step 7.2: If missing, add the subscription**

```ts
bus.registerSubscriber('event.http-egress', PLUGIN_NAME, async (ctx, payload) => {
  await bus.call('storage:set', ctx, {
    key: `egress:${ctx.sessionId}:${payload.timestamp}`,
    value: new TextEncoder().encode(JSON.stringify(payload)),
  });
  return undefined; // pass-through
});
```

**Step 7.3: Test**

Existing pattern: bootstrap audit-log + a fake fire of `event.http-egress`, assert storage was written.

**Step 7.4: Commit**

```bash
git add packages/audit-log
git commit -m "feat(audit-log): subscribe to event.http-egress (Phase 2)"
```

(Skip the commit if Step 7.1 found the subscription already exists.)

---

### Task 8: End-to-end test against real Anthropic API

**Goal:** A single integration test that runs `ax-next "list this directory"` through the full new path and verifies (a) it succeeds, (b) `event.http-egress` fires with `classification: 'llm'` and `credentialInjected: true`.

**Files:**
- Add: `packages/cli/src/__tests__/credential-proxy.e2e.test.ts`

**Step 8.1: Test gate**

```ts
const apiKey = process.env.AX_TEST_ANTHROPIC_KEY;
const skip = apiKey === undefined || apiKey.length === 0;
describe.skipIf(skip)('credential-proxy e2e (real Anthropic API)', () => { ... });
```

**Step 8.2: Test body**

```ts
it('round-trips a chat through the credential-proxy with a real API key', async () => {
  // 1. Set AX_CREDENTIALS_KEY (test helper).
  // 2. Set the credential: bus.call('credentials:set', ctx, { id: 'anthropic-api', value: apiKey }).
  // 3. Subscribe a `event.http-egress` capture array.
  // 4. Call main({ message: 'reply with the single word PONG and nothing else', ... }).
  // 5. Assert outcome.kind === 'complete' and the response includes 'PONG'.
  // 6. Assert at least one event.http-egress fired with:
  //    classification === 'llm', credentialInjected === true,
  //    host === 'api.anthropic.com'.
});
```

**Step 8.3: Run locally + commit**

```bash
AX_TEST_ANTHROPIC_KEY=sk-ant-... pnpm --filter @ax/cli test -- credential-proxy.e2e
git add packages/cli/src/__tests__/credential-proxy.e2e.test.ts
git commit -m "test(cli): e2e against real Anthropic API through credential-proxy (Phase 2)"
```

CI does NOT have the env var; the test skips automatically.

---

### Task 9: Boundary-review block + PR notes + half-wired window closure

**Goal:** Documentation. Closes the Phase 1a half-wired window in writing.

**Files:**
- Add: `docs/plans/2026-04-28-phase-2-pr-notes.md` (mirror Phase 1a's notes file)
- Modify: PR description on GitHub

**Step 9.1: Boundary review for `OpenSessionInput.proxyConfig`**

The PR description must include:

```
### Boundary review — OpenSessionInput.proxyConfig (new field)

- **Alternate impl this hook could have:** vault-backed proxy that exposes a
  different endpoint shape (e.g. `vault://<role>` URI). The `endpoint`/
  `unixSocketPath` split keeps the wire surface flexible without committing
  to a specific protocol.
- **Payload field names that might leak:** none. `endpoint` is a generic URI;
  `caCertPem` is a generic standard format; `envMap` is a generic key-value
  map. No git/k8s/sqlite vocabulary.
- **Subscriber risk:** sandbox-subprocess is the only consumer today.
  K8s sandbox (Phase 7-9) will consume the same shape. No subscribers
  parse `endpoint` for protocol semantics — it's passed verbatim into
  `HTTPS_PROXY`.
- **Wire surface:** none. `OpenSessionInput` is in-process only; not
  exposed on the IPC bridge to sandboxes (the runner reads the resolved
  env, not the input shape).
```

**Step 9.2: Half-wired window closure note**

```
### Phase 1a half-wired window — CLOSED

Phase 1a (PR #1) shipped `@ax/credential-proxy` and `@ax/credential-proxy-bridge`
without any consumer wiring. This PR closes that window:
- CLI (`packages/cli/src/main.ts`) loads the proxy plugin.
- K8s preset (`presets/k8s/src/index.ts`) loads the proxy plugin (Unix socket).
- `@ax/chat-orchestrator` calls `proxy:open-session` per agent:invoke.
- `@ax/agent-claude-sdk-runner` reads the proxy env, starts the bridge if
  needed (k8s mode), redirects SDK calls through `HTTPS_PROXY`.

Both Phase 1a packages are now reachable from the canary acceptance test.
```

**Step 9.3: Commit**

```bash
git add docs/plans/2026-04-28-phase-2-pr-notes.md
git commit -m "docs(phase-2): PR notes + boundary review + half-wired window closure"
```

---

### Task 10: PR open + CI green

**Goal:** Open PR, watch CI, address any review feedback.

**Step 10.1: Branch + push**

```bash
git checkout -b phase-2-runner-proxy-wiring  # if not already
git push -u origin phase-2-runner-proxy-wiring
```

**Step 10.2: Open PR**

PR title: `Phase 2 — wire credential-proxy + bridge into the SDK runner`

Body: combines summary + boundary review + half-wired window closure (from Task 9) + test plan checklist.

**Step 10.3: Watch CI**

```bash
gh pr checks --watch
```

Expected: all checks green. If semgrep/test/lint fails, fix the root cause (don't bypass) and push.

**Step 10.4: Update memory after merge**

After PR merges to main:
- Update `~/.claude/projects/-Users-vpulim-dev-ai-ax-next/memory/MEMORY.md` with `project_phase_2_shipped.md`.
- Note in the new memory file: "Half-wired window for Phase 1a is now CLOSED. SDK runner uses credential-proxy; native runner still uses llm-proxy-anthropic-format until Phase 5/6 deletes it."
- Update `.claude/memory/decisions.md` with the Task 1 (`proxyConfig` on the boundary), Task 2 (soft-dep via `bus.hasService`), Task 4 (`AX_LLM_PROXY_URL` made optional) decisions.

---

## Verification table (filled in at PR open)

| Invariant | How verified | Evidence |
|---|---|---|
| I1 — real creds never enter sandbox | Read sandbox env in test | unit test in Task 3 |
| I2 — no cross-plugin imports | `pnpm lint` clean | CI |
| I3 — `proxyConfig` field names don't leak | Boundary review § | PR description |
| I4 — boundary review recorded | PR description has the block | PR description |
| I5 — capabilities explicit | `bus.hasService` runtime check, no manifest dep | Task 2.2 decision |
| I6 — half-wired window closed | CLI + k8s both load proxy; canary reaches `event.http-egress` | Task 5/6/8 |
| I7 — `proxy:close-session` always fires | Test with throw in `sandbox:open-session` | Task 2.1 test #3 |
| I8 — SDK runner stops setting `ANTHROPIC_BASE_URL` | Read SDK options in test | Task 4.4 |
| I9 — `AX_LLM_PROXY_URL` optional | `readRunnerEnv` test | Task 4.2 |
| I10 — bridge mode overrides HTTP(S)_PROXY | `setupProxy` unit test | Task 4.8 |

---

## Out-of-scope (not Phase 2)

- **`proxy:rotate-session` plumbing.** Phase 3 (OAuth) earns its weight; Phase 2 ships coarse mode only.
- **K8s deployment manifests** (helm chart updates for proxy Unix socket path). The k8s preset wires the plugin, but actually deploying it requires chart edits not covered here.
- **Native runner deletion.** `@ax/agent-native-runner` and `@ax/llm-proxy-anthropic-format` stay loaded. Phase 5/6 deletes them.
- **`credentials:get` reshape to `(ref, { userId })`.** Still Phase 3 work; the proxy calls credentials with the current `{id} → {value}` shape (set during Phase 1a, unchanged in Phase 1b).
- **Allowlist enforcement at the agents-resolve boundary.** Today the dev stub returns a hardcoded allowlist; Phase 9.5+ extends real `@ax/agents` to plumb per-agent allowlists from a postgres column. Documented in the PR.
- **Canary token integration.** Open question §7 in the design — defer until a concrete threat model justifies it.
