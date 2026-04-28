# Phase 1a Implementation Plan — credential-proxy + bridge

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Land two new additive plugins (`@ax/credential-proxy` host-side MITM + `@ax/credential-proxy-bridge` sandbox-side relay) by porting four v1 helpers (~1100 LOC). No consumer wires them in this phase — Phase 2 attaches them to `@ax/agent-claude-sdk-runner`.

**Architecture:**
- **`@ax/credential-proxy`** — host-side plugin. One listener per host process (Unix socket OR TCP loopback). Per-session: allowlist + credential placeholder map, all aggregated in a `SharedCredentialRegistry` so a single listener can serve N concurrent sessions. CONNECT requests are TLS-terminated with a domain cert minted from a persistent CA (`~/.ax/proxy-ca/`); decrypted bytes are scanned for placeholders and substituted in-place before forwarding upstream.
- **`@ax/credential-proxy-bridge`** — NOT a hook plugin. Library shipped as a package; runs sandbox-side; exports `startWebProxyBridge(unixSocketPath) → { port, stop }` for k8s pods that can't reach host TCP. Pure TCP↔Unix-socket relay; no policy.
- Both packages are referenced **only** by their own tests in this phase. Phase 2 wires them into the CLI + runner.

**Tech Stack:**
- TypeScript / Node 20+
- Vitest
- `node-forge` (NEW dependency — X.509 cert generation)
- `node:tls`, `node:net`, `node:dns/promises`, `node:http` (stdlib)
- `undici` (already a transitive dep — Agent with `socketPath` for bridge HTTP forwarding)

---

## Reference material

v1 source files to port (read-only — `~/dev/ai/ax/`):

| v1 file | LOC | Maps to |
|---|---|---|
| `src/host/credential-placeholders.ts` | 122 | `packages/credential-proxy/src/registry.ts` |
| `src/host/proxy-ca.ts` | 124 | `packages/credential-proxy/src/ca.ts` |
| `src/host/web-proxy.ts` | 656 | `packages/credential-proxy/src/listener.ts` + `private-ip.ts` |
| `src/agent/web-proxy-bridge.ts` | 174 | `packages/credential-proxy-bridge/src/bridge.ts` |

Reference patterns in ax-next:
- Plugin shape: `packages/audit-log/src/plugin.ts` (subscriber-only — but smallest plugin)
- Plugin with `registerService`: `packages/credentials/src/plugin.ts`
- Test pattern with in-memory dep plugins: `packages/credentials/src/__tests__/plugin.test.ts`

---

## Invariants (security-critical — verified at every task)

- **I1:** Real credentials never leave the host process. Sandbox env contains only `ax-cred:<hex>` placeholders.
- **I2:** Allowlist is the only egress gate. No allow-all, no implicit bypass.
- **I3:** Private IP ranges blocked: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`, `169.254.0.0/16` (cloud metadata), IPv6 link-local + unique-local. Test allowlist override exists for the integration test only.
- **I4:** Canary scan, when configured, aborts the request before forwarding upstream and fires `event.http-egress` with `blockedReason: 'canary'`.
- **I5:** CA private key persisted with mode 0600.
- **I6:** Placeholders are 16 random bytes (`randomBytes(16).toString('hex')`) — globally unique across sessions.
- **I7:** No substitution on the response path. Real credentials never come back from upstream.
- **I8:** Bridge contains zero policy. Pure relay. All security checks live host-side in the proxy.
- **I9:** Phase 1a's plugins are additive. Loaded only by their own tests this phase. The CLAUDE.md "no half-wired plugins" rule is satisfied via integration tests as the consumer; Phase 2 wires into `cli/main.ts`. **PR description must call this out.**

---

## Open questions resolved before execution

1. **CA dir location.** Default `~/.ax/proxy-ca/`. Plugin config accepts `caDir?: string` to override (used by tests). `os.homedir()` resolved at plugin construction.
2. **Listener mode.** Plugin config: `listen: { kind: 'unix'; path: string } | { kind: 'tcp'; host?: string; port?: number }`. TCP default for subprocess sandbox; Unix socket for k8s. `port: 0` = ephemeral.
3. **Cuts vs. v1.** Drop `urlRewrites`, drop `onApprove` callback, drop `allowedDomains` pre-approved set + per-domain `domainDecisions` cache (the per-session allowlist replaces all of these). Keep `bypassMITM` (per design Section 1). Keep canary scan but simpler (no per-domain caching).
4. **`credentials:get` dependency.** The current `@ax/credentials` plugin's `credentials:get` shape is `({id}) → {value}` — different from the design's eventual `(ref, {userId}) → currentValue`. Phase 1b reshapes it. Phase 1a tests stub `credentials:get` with the **current** shape; Phase 1b refactors both proxy + facade together.
5. **Half-wired tension.** Plugin is integration-tested but not loaded by `cli/main.ts`. Acceptable per design Section 7 ("Risk: Low. New plugins, not loaded anywhere yet."). PR description must flag this.
6. **node-forge dependency.** New transitive risk — supply-chain checklist (Task 19).

---

## Tasks

### Task 1: Scaffold `@ax/credential-proxy` package

**Files:**
- Create: `packages/credential-proxy/package.json`
- Create: `packages/credential-proxy/tsconfig.json`
- Create: `packages/credential-proxy/src/index.ts`
- Create: `packages/credential-proxy/src/plugin.ts` (skeleton, no impl)
- Modify: `pnpm-workspace.yaml` (already covers `packages/*`)
- Modify: `tsconfig.base.json` references (verify auto-pickup)

**Step 1.1:** Create `package.json`:

```json
{
  "name": "@ax/credential-proxy",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc --build",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@ax/core": "workspace:*",
    "node-forge": "^1.3.1"
  },
  "devDependencies": {
    "@ax/test-harness": "workspace:*",
    "@types/node": "^25.6.0",
    "@types/node-forge": "^1.3.11",
    "typescript": "^6.0.3",
    "vitest": "^4.1.4"
  }
}
```

**Step 1.2:** Create `tsconfig.json` matching `packages/audit-log/tsconfig.json` (same `extends` + `references` to `@ax/core`).

**Step 1.3:** Create `src/index.ts`:

```ts
export { createCredentialProxyPlugin } from './plugin.js';
export type { CredentialProxyConfig } from './plugin.js';
```

**Step 1.4:** Create `src/plugin.ts` skeleton:

```ts
import type { Plugin } from '@ax/core';

export interface CredentialProxyConfig {
  listen: { kind: 'unix'; path: string } | { kind: 'tcp'; host?: string; port?: number };
  caDir?: string;
}

export function createCredentialProxyPlugin(_config: CredentialProxyConfig): Plugin {
  return {
    manifest: {
      name: '@ax/credential-proxy',
      version: '0.0.0',
      registers: ['proxy:open-session', 'proxy:rotate-session', 'proxy:close-session'],
      calls: ['credentials:get'],
      subscribes: [],
    },
    init() {
      throw new Error('not implemented');
    },
  };
}
```

**Step 1.5:** Run `pnpm install` then `pnpm build --filter @ax/credential-proxy`. Expected: builds clean.

**Step 1.6:** Commit.

```bash
git add packages/credential-proxy/
git commit -m "feat(credential-proxy): scaffold plugin (Phase 1a Task 1)"
```

---

### Task 2: Port `CredentialPlaceholderMap`

**Files:**
- Create: `packages/credential-proxy/src/registry.ts`
- Create: `packages/credential-proxy/src/__tests__/registry.test.ts`

**Step 2.1:** Write failing tests in `src/__tests__/registry.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { CredentialPlaceholderMap } from '../registry.js';

describe('CredentialPlaceholderMap', () => {
  it('register returns ax-cred: prefixed placeholder', () => {
    const m = new CredentialPlaceholderMap();
    const ph = m.register('ANTHROPIC_API_KEY', 'sk-real');
    expect(ph).toMatch(/^ax-cred:[0-9a-f]{32}$/);
  });

  it('replaceAll substitutes placeholder with real value', () => {
    const m = new CredentialPlaceholderMap();
    const ph = m.register('K', 'real-secret');
    expect(m.replaceAll(`auth: ${ph}`)).toBe('auth: real-secret');
  });

  it('hasPlaceholders true when any placeholder appears in input', () => {
    const m = new CredentialPlaceholderMap();
    const ph = m.register('K', 'secret');
    expect(m.hasPlaceholders(`x ${ph} y`)).toBe(true);
    expect(m.hasPlaceholders('no creds here')).toBe(false);
  });

  it('replaceAllBuffer returns same Buffer instance when no placeholders present', () => {
    const m = new CredentialPlaceholderMap();
    m.register('K', 'secret');
    const buf = Buffer.from('plain text');
    expect(m.replaceAllBuffer(buf)).toBe(buf); // identity check, not equality
  });

  it('re-registering same env name replaces previous placeholder', () => {
    const m = new CredentialPlaceholderMap();
    const ph1 = m.register('K', 'v1');
    const ph2 = m.register('K', 'v2');
    expect(ph1).not.toBe(ph2);
    expect(m.hasPlaceholders(ph1)).toBe(false); // old retired
    expect(m.replaceAll(ph2)).toBe('v2');
  });

  it('toEnvMap returns env-name → placeholder map', () => {
    const m = new CredentialPlaceholderMap();
    const ph = m.register('ANTHROPIC_API_KEY', 'sk-real');
    expect(m.toEnvMap()).toEqual({ ANTHROPIC_API_KEY: ph });
  });
});
```

**Step 2.2:** Run tests, confirm fail with "module not found":

```bash
pnpm test --filter @ax/credential-proxy
```

**Step 2.3:** Implement `src/registry.ts` by porting v1 `~/dev/ai/ax/src/host/credential-placeholders.ts:14-76` (the `CredentialPlaceholderMap` class). Verbatim port — no shape changes.

**Step 2.4:** Re-run tests. Expected: all 6 pass.

**Step 2.5:** Commit.

```bash
git add packages/credential-proxy/src/registry.ts packages/credential-proxy/src/__tests__/registry.test.ts
git commit -m "feat(credential-proxy): CredentialPlaceholderMap (Phase 1a Task 2)"
```

---

### Task 3: Port `SharedCredentialRegistry`

**Files:**
- Modify: `packages/credential-proxy/src/registry.ts` (append class)
- Modify: `packages/credential-proxy/src/__tests__/registry.test.ts` (append `describe` block)

**Step 3.1:** Append failing tests:

```ts
describe('SharedCredentialRegistry', () => {
  it('substitutes placeholder from any registered session', () => {
    const reg = new SharedCredentialRegistry();
    const m1 = new CredentialPlaceholderMap(); const ph1 = m1.register('K', 'v1');
    const m2 = new CredentialPlaceholderMap(); const ph2 = m2.register('K', 'v2');
    reg.register('s1', m1);
    reg.register('s2', m2);
    expect(reg.replaceAll(`${ph1} ${ph2}`)).toBe('v1 v2');
  });

  it('deregister removes session', () => {
    const reg = new SharedCredentialRegistry();
    const m = new CredentialPlaceholderMap();
    const ph = m.register('K', 'secret');
    reg.register('s', m);
    reg.deregister('s');
    expect(reg.hasPlaceholders(ph)).toBe(false);
  });

  it('replaceAllBuffer returns same Buffer when no session has placeholders', () => {
    const reg = new SharedCredentialRegistry();
    reg.register('s', new CredentialPlaceholderMap());
    const buf = Buffer.from('hello');
    expect(reg.replaceAllBuffer(buf)).toBe(buf);
  });
});
```

**Step 3.2:** Implement `SharedCredentialRegistry` (verbatim port from v1 `credential-placeholders.ts:85-122`).

**Step 3.3:** Re-run tests. All pass.

**Step 3.4:** Commit.

---

### Task 4: Port CA management (`getOrCreateCA` + `generateDomainCert`)

**Files:**
- Create: `packages/credential-proxy/src/ca.ts`
- Create: `packages/credential-proxy/src/__tests__/ca.test.ts`

**Step 4.1:** Write failing tests:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getOrCreateCA, generateDomainCert } from '../ca.js';

describe('getOrCreateCA', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ax-ca-')); });

  it('generates ca.key + ca.crt on first call', async () => {
    const ca = await getOrCreateCA(dir);
    expect(ca.key).toMatch(/-----BEGIN (RSA )?PRIVATE KEY-----/);
    expect(ca.cert).toMatch(/-----BEGIN CERTIFICATE-----/);
    expect(existsSync(join(dir, 'ca.key'))).toBe(true);
    expect(existsSync(join(dir, 'ca.crt'))).toBe(true);
  });

  it('persists ca.key with mode 0600', async () => {
    await getOrCreateCA(dir);
    const mode = statSync(join(dir, 'ca.key')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('subsequent calls return the same persisted CA', async () => {
    const a = await getOrCreateCA(dir);
    const b = await getOrCreateCA(dir);
    expect(a.cert).toBe(b.cert);
    expect(a.key).toBe(b.key);
  });
});

describe('generateDomainCert', () => {
  it('mints a domain cert signed by the CA', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ax-ca-'));
    const ca = await getOrCreateCA(dir);
    const dc = generateDomainCert('api.anthropic.com', ca);
    expect(dc.cert).toMatch(/-----BEGIN CERTIFICATE-----/);
    expect(dc.key).toMatch(/-----BEGIN (RSA )?PRIVATE KEY-----/);
  });

  it('caches certs per domain — second call returns same instance', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ax-ca-'));
    const ca = await getOrCreateCA(dir);
    const a = generateDomainCert('example.com', ca);
    const b = generateDomainCert('example.com', ca);
    expect(a).toBe(b); // identity — cache hit
  });

  it('handles literal IP addresses (subjectAltName type 7)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ax-ca-'));
    const ca = await getOrCreateCA(dir);
    expect(() => generateDomainCert('127.0.0.1', ca)).not.toThrow();
  });
});
```

**Step 4.2:** Run tests. Fail.

**Step 4.3:** Port `src/ca.ts` from v1 `~/dev/ai/ax/src/host/proxy-ca.ts`. Adapt:
- Drop `getLogger` import (use no-op for now; logger comes from `ctx` at call sites in Task 9).
- Cache key includes CA cert hash (verbatim from v1).

**Step 4.4:** Re-run tests. All pass.

**Step 4.5:** Commit.

---

### Task 5: Port `resolveAndCheck` (private IP block + DNS resolve)

**Files:**
- Create: `packages/credential-proxy/src/private-ip.ts`
- Create: `packages/credential-proxy/src/__tests__/private-ip.test.ts`

**Step 5.1:** Write tests for both helper functions:

```ts
import { describe, it, expect } from 'vitest';
import { resolveAndCheck, isPrivateIPv4, isPrivateIPv6 } from '../private-ip.js';

describe('isPrivateIPv4', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.0.0.1', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false],   // outside 172.16/12
    ['192.168.1.1', true],
    ['169.254.169.254', true], // AWS metadata
    ['8.8.8.8', false],
    ['1.1.1.1', false],
  ])('%s → %s', (ip, expected) => {
    expect(isPrivateIPv4(ip)).toBe(expected);
  });
});

describe('isPrivateIPv6', () => {
  it.each([
    ['::1', true],
    ['fe80::1', true],
    ['fd00::1', true],
    ['2606:4700:4700::1111', false],
  ])('%s → %s', (ip, expected) => {
    expect(isPrivateIPv6(ip)).toBe(expected);
  });
});

describe('resolveAndCheck', () => {
  it('throws Blocked: for literal private IP', async () => {
    await expect(resolveAndCheck('127.0.0.1')).rejects.toThrow(/Blocked: private IP/);
  });

  it('returns IP for literal public IP', async () => {
    expect(await resolveAndCheck('8.8.8.8')).toBe('8.8.8.8');
  });

  it('allowedIPs override unblocks the IP', async () => {
    expect(await resolveAndCheck('127.0.0.1', new Set(['127.0.0.1']))).toBe('127.0.0.1');
  });

  // DNS-based test — needs an actual hostname. Use 'localhost' which resolves to 127.0.0.1.
  it('throws Blocked: for hostname resolving to private IP', async () => {
    await expect(resolveAndCheck('localhost')).rejects.toThrow(/Blocked.*private IP/);
  });
});
```

**Step 5.2:** Port from v1 `web-proxy.ts:107-146`. Export `isPrivateIPv4`, `isPrivateIPv6`, `resolveAndCheck` so tests can call them directly.

**Step 5.3:** Tests pass.

**Step 5.4:** Commit.

---

### Task 6: HTTP forwarding handler (additive)

**Files:**
- Create: `packages/credential-proxy/src/listener.ts`
- Create: `packages/credential-proxy/src/__tests__/listener-http.test.ts`

This task introduces the listener with HTTP forwarding only (no CONNECT, no MITM yet). Builds the skeleton that Tasks 7 and 8 extend.

**Step 6.1:** Write a failing test that:
- Stands up a tiny test upstream server (`http.createServer` returning JSON)
- Stands up the proxy listener with a session whose allowlist includes the upstream's hostname
- Sends an HTTP request through the proxy via `fetch` with `dispatcher` pointing at the listener
- Asserts the response body matches the upstream's

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { createServer as httpCreate, type Server } from 'node:http';
import { Agent } from 'undici';
import { startProxyListener, type ProxyListener } from '../listener.js';
import { SharedCredentialRegistry, CredentialPlaceholderMap } from '../registry.js';

let upstream: Server | undefined;
let listener: ProxyListener | undefined;

afterEach(async () => {
  if (listener) listener.stop();
  if (upstream) await new Promise<void>((r) => upstream!.close(() => r()));
  upstream = listener = undefined;
});

describe('proxy listener — HTTP forwarding', () => {
  it('forwards GET to allowlisted upstream and returns body', async () => {
    upstream = httpCreate((_req, res) => { res.end('OK from upstream'); });
    const upPort = await new Promise<number>((r) =>
      upstream!.listen(0, '127.0.0.1', () => r((upstream!.address() as any).port)));

    const registry = new SharedCredentialRegistry();
    listener = await startProxyListener({
      listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      registry,
      sessions: new Map([['s1', { allowlist: new Set(['127.0.0.1']), allowedIPs: new Set(['127.0.0.1']) }]]),
      // ca + onAudit added in later tasks
    });

    const dispatcher = new Agent({ connect: { host: '127.0.0.1', port: listener.port } });
    const res = await fetch(`http://127.0.0.1:${upPort}/`, { dispatcher } as RequestInit);
    expect(await res.text()).toBe('OK from upstream');
  });

  it('returns 403 when host not in any session allowlist', async () => {
    upstream = httpCreate((_req, res) => res.end('SHOULD NOT REACH'));
    const upPort = await new Promise<number>((r) =>
      upstream!.listen(0, '127.0.0.1', () => r((upstream!.address() as any).port)));

    const registry = new SharedCredentialRegistry();
    listener = await startProxyListener({
      listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      registry,
      sessions: new Map([['s1', { allowlist: new Set(['other.example.com']), allowedIPs: new Set(['127.0.0.1']) }]]),
    });

    const dispatcher = new Agent({ connect: { host: '127.0.0.1', port: listener.port } });
    const res = await fetch(`http://127.0.0.1:${upPort}/`, { dispatcher } as RequestInit);
    expect(res.status).toBe(403);
  });

  it('returns 403 for private-IP target without allowedIPs override', async () => {
    const registry = new SharedCredentialRegistry();
    listener = await startProxyListener({
      listen: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      registry,
      sessions: new Map([['s1', { allowlist: new Set(['127.0.0.1']) /* no allowedIPs */ }]]),
    });
    const dispatcher = new Agent({ connect: { host: '127.0.0.1', port: listener.port } });
    const res = await fetch(`http://127.0.0.1/`, { dispatcher } as RequestInit);
    expect(res.status).toBe(403);
  });
});
```

**Step 6.2:** Run, fail (no listener.ts yet).

**Step 6.3:** Implement `listener.ts` with `startProxyListener` exporting `ProxyListener = { port: number; address: string|number; stop(): void }`. Port v1 `handleHTTPRequest` from `web-proxy.ts:217-349`. Cuts:
- Drop `urlRewrites` block (lines 226-227)
- Drop `onApprove` callback path. Use the per-session allowlist directly: a request's hostname is allowed only if SOME session's `allowlist` contains it. (For Phase 1a, sessions are passed to `startProxyListener` directly — Task 9 swaps to a per-process map keyed by sessionId.)
- Keep canary-detection skeleton but defer wiring (Task 8)
- Audit callback (Task 11) — leave as `options.onAudit?.(entry)` no-op

**Step 6.4:** Tests pass.

**Step 6.5:** Commit.

---

### Task 7: HTTPS CONNECT — bypass mode (raw TCP tunnel)

**Files:**
- Modify: `packages/credential-proxy/src/listener.ts` (add CONNECT handler)
- Create: `packages/credential-proxy/src/__tests__/listener-connect-bypass.test.ts`

**Step 7.1:** Write failing test that:
- Stands up a TLS upstream with a self-signed cert
- Configures session `bypassMITM: ['localhost']`
- Verifies CONNECT tunnel passes raw TLS bytes through

```ts
// Use node:tls.createServer with a one-off cert
// Connect through proxy via HTTPS_PROXY env var or undici Agent CONNECT
// Assert client receives upstream's TLS handshake unmodified
```

(Detailed test code in implementation; ~80 LOC.)

**Step 7.2:** Implement CONNECT handler. Port v1 `web-proxy.ts:353-493` (the non-MITM raw-tunnel path). Skip `urlRewrites` block (lines 386-401) and `onApprove` block (lines 404-415) — use allowlist directly.

**Step 7.3:** Tests pass.

**Step 7.4:** Commit.

---

### Task 8: HTTPS CONNECT — MITM mode (TLS termination + substitution + canary)

**Files:**
- Modify: `packages/credential-proxy/src/listener.ts` (add MITM path)
- Create: `packages/credential-proxy/src/__tests__/listener-connect-mitm.test.ts`

**Step 8.1:** Write failing tests for three behaviors:

(a) **MITM substitution.** Test upstream signed by the SAME CA we hand the proxy. Configure session with `ANTHROPIC_API_KEY=ax-cred:<ph>`. Send POST through proxy with the placeholder in the Authorization header. Assert upstream sees the substituted real value.

(b) **Canary scan blocks.** Same setup. Send a body containing the canary token. Assert client gets 403 over the TLS channel; upstream never receives the request.

(c) **MITM bypass for `bypassMITM` hostnames.** When session declares `bypassMITM: ['cert-pinned.example.com']`, that hostname falls through to the raw-tunnel path from Task 7.

**Step 8.2:** Implement MITM path. Port v1 `web-proxy.ts:497-620` (`handleMITMConnect`). Adapt:
- Replace `options.mitm.credentials` with the per-session view from `SharedCredentialRegistry`
- Inline `generateDomainCert` import (no longer dynamic)
- Audit callback shape changes per Task 11

**Step 8.3:** Tests pass.

**Step 8.4:** Commit.

---

### Task 9: Wire `proxy:open-session` + `proxy:close-session`

**Files:**
- Modify: `packages/credential-proxy/src/plugin.ts` (real impl)
- Modify: `packages/credential-proxy/src/listener.ts` (sessions Map made dynamic)
- Create: `packages/credential-proxy/src/__tests__/plugin.test.ts`

The listener's `sessions` Map (passed in static from tests in Tasks 6-8) becomes the registry the plugin mutates as `proxy:open-session` and `proxy:close-session` fire.

**Step 9.1:** Write failing plugin tests using bootstrap pattern from `packages/credentials/src/__tests__/plugin.test.ts`:

```ts
// Stub credentials:get plugin (current shape: ({id}) → {value})
// Bootstrap with credential-proxy plugin
// Call proxy:open-session({ sessionId, userId, agentId, allowlist, credentials: { ANTHROPIC_API_KEY: { ref: 'r1', kind: 'api-key' } } })
// Assert: returns { proxyEndpoint, caCertPem, envMap: { ANTHROPIC_API_KEY: 'ax-cred:...' } }
// Call proxy:close-session({ sessionId })
// Assert: subsequent forwarded request with that placeholder fails (no longer registered)
```

**Step 9.2:** Implement `proxy:open-session`:

```
1. Resolve every credential ref via bus.call('credentials:get', ctx, { id: ref })
2. Build a CredentialPlaceholderMap for this session, register each (envName → placeholder)
3. registry.register(sessionId, map)
4. Persist allowlist (Set), allowedIPs (Set, optional from config), bypassMITM (Set), canaryToken (string?) under sessionId in the listener's session-config store
5. Return { proxyEndpoint, caCertPem: ca.cert, envMap: map.toEnvMap() }
```

`proxy:close-session`:
```
1. registry.deregister(sessionId)
2. delete from session-config store
3. return {}
```

**Step 9.3:** Tests pass.

**Step 9.4:** Commit.

---

### Task 10: `proxy:rotate-session`

**Files:**
- Modify: `packages/credential-proxy/src/plugin.ts`
- Modify: `packages/credential-proxy/src/__tests__/plugin.test.ts`

**Step 10.1:** Write failing test:
- Open session, capture envMap. Substitute via placeholder; observe upstream gets 'sk-original'.
- Re-stub credentials:get to return 'sk-rotated' on next call.
- Call `proxy:rotate-session({ sessionId })`. Assert returned envMap differs.
- Substitute again with NEW placeholder; observe upstream gets 'sk-rotated'.
- Substitute with OLD placeholder; observe substitution fails (placeholder no longer registered) — request gets sent with literal `ax-cred:<oldhex>` and upstream sees it as garbage. (We don't need to test the upstream's behavior; we just verify the registry no longer matches the old placeholder.)

**Step 10.2:** Implement: re-resolve credentials via `bus.call('credentials:get')`, register fresh `CredentialPlaceholderMap` (which retires old placeholders per `register()` semantics), swap in the registry, return new envMap.

**Step 10.3:** Tests pass.

**Step 10.4:** Commit.

---

### Task 11: `event.http-egress` subscriber emission

**Files:**
- Modify: `packages/credential-proxy/src/listener.ts` (audit callback fires `event.http-egress` via `bus.fire`)
- Modify: `packages/credential-proxy/src/plugin.ts` (pass `bus.fire` into listener as `onAudit` callback)
- Create: `packages/credential-proxy/src/__tests__/egress-events.test.ts`

**Step 11.1:** Write failing test that subscribes to `event.http-egress` from a test plugin; runs an HTTP forward + an MITM CONNECT + a blocked private-IP request; asserts three events with the expected fields:

```ts
{ sessionId, userId, method, host, path, status, requestBytes, responseBytes,
  durationMs, credentialInjected: boolean, classification: 'llm'|'mcp'|'other',
  blockedReason?: 'allowlist'|'private-ip'|'canary'|'tls-error', timestamp }
```

`classification` is `'llm'` when any substituted credential's `kind` was an LLM kind (`'api-key'` for now; later `'anthropic-oauth'` etc.); `'other'` otherwise. (Phase 3 adds the `'mcp'` cases.)

**Step 11.2:** Implement. Note: subscribers MUST be allowed to throw without breaking the proxy (HookBus contract).

**Step 11.3:** Tests pass.

**Step 11.4:** Commit.

---

### Task 12: Plugin acceptance test

**Files:**
- Create: `packages/credential-proxy/src/__tests__/acceptance.test.ts`

**Step 12.1:** Write a single test that exercises the full session lifecycle end-to-end:
- Generate CA in tmpdir
- Bootstrap host with credential-proxy + stub credentials plugin
- Stand up TLS upstream signed by our CA, accepting POST `/v1/messages`
- `proxy:open-session({ allowlist: ['mock-llm.test'], credentials: { ANTHROPIC_API_KEY: { ref: 'anthropic', kind: 'api-key' } } })`
- Use returned envMap + caCertPem; configure undici dispatcher to use the proxy + trust the CA
- POST through proxy with `Authorization: Bearer <placeholder>`
- Assert upstream received `Authorization: Bearer sk-real-secret`
- Assert subscriber saw exactly one `event.http-egress` with `classification: 'llm'`, `credentialInjected: true`, `host: 'mock-llm.test'`
- `proxy:close-session`. Subsequent request fails with 403.

**Step 12.2:** Run. Pass.

**Step 12.3:** Commit.

---

### Task 13: Scaffold `@ax/credential-proxy-bridge` package

**Files:**
- Create: `packages/credential-proxy-bridge/package.json`
- Create: `packages/credential-proxy-bridge/tsconfig.json`
- Create: `packages/credential-proxy-bridge/src/index.ts`
- Create: `packages/credential-proxy-bridge/src/bridge.ts` (skeleton)

```json
{
  "name": "@ax/credential-proxy-bridge",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": {
    "build": "tsc --build",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "undici": "^7.0.0"
  },
  "devDependencies": {
    "@types/node": "^25.6.0",
    "typescript": "^6.0.3",
    "vitest": "^4.1.4"
  }
}
```

**No `@ax/core` dep.** This package is a sandbox-side library, not a host plugin.

`src/index.ts`:
```ts
export { startWebProxyBridge } from './bridge.js';
export type { WebProxyBridge } from './bridge.js';
```

**Step 13.1-13.3:** Create files. Build clean. Commit.

---

### Task 14: Bridge HTTP forwarding mode

**Files:**
- Modify: `packages/credential-proxy-bridge/src/bridge.ts`
- Create: `packages/credential-proxy-bridge/src/__tests__/bridge-http.test.ts`

**Step 14.1:** Write test:
- Start a Unix-socket server that pretends to be the host proxy (just echoes the request method+path)
- Start the bridge pointed at that socket
- Send GET via fetch + Agent { connect: { host: '127.0.0.1', port: bridge.port } }
- Assert bridge forwards through Unix socket and returns echo

**Step 14.2:** Port HTTP forwarding from v1 `web-proxy-bridge.ts:36-88`. Verbatim — no changes.

**Step 14.3:** Test passes. Commit.

---

### Task 15: Bridge CONNECT mode

**Files:**
- Modify: `packages/credential-proxy-bridge/src/bridge.ts`
- Create: `packages/credential-proxy-bridge/src/__tests__/bridge-connect.test.ts`

**Step 15.1:** Write test:
- Start a Unix-socket server that responds to `CONNECT host:port HTTP/1.1` with `HTTP/1.1 200 Connection Established\r\n\r\n` and then echoes bytes
- Start the bridge pointed at that socket
- Use undici to send a tunnelled HTTPS-ish payload and verify echo

**Step 15.2:** Port CONNECT from v1 `web-proxy-bridge.ts:95-156`. Verbatim.

**Step 15.3:** Test passes. Commit.

---

### Task 16: Bridge lifecycle (`stop()` cleans up sockets)

**Files:**
- Create: `packages/credential-proxy-bridge/src/__tests__/lifecycle.test.ts`

**Step 16.1:** Tests:
- `port` is a valid TCP port number after start
- `stop()` closes the listener and destroys all active sockets
- After stop, new connections to the port fail

**Step 16.2:** No new impl — this verifies the existing `stop` from v1 works. If a test exposes a leak, fix it now.

**Step 16.3:** Tests pass. Commit.

---

### Task 17: End-to-end integration test (proxy + bridge + mock LLM)

**Files:**
- Create: `packages/credential-proxy/src/__tests__/integration-with-bridge.test.ts`

**Step 17.1:** Test:
- Stand up host proxy on Unix socket in tmpdir (per-test isolation)
- Stand up bridge in same process pointed at that Unix socket
- Stand up mock TLS upstream signed by the proxy's CA
- Open a session with allowlist + cred substitution
- Send HTTPS POST through the bridge's TCP port (simulating sandbox-side traffic)
- Assert: upstream sees substituted credential; subscriber sees `event.http-egress` with `classification: 'llm'`

This is the Phase 1a verification criterion from the design doc Section 7: "integration test stands up a proxy listener, sends a mock HTTPS request, confirms cert minting + substitution + audit event."

**Step 17.2:** Tests pass. Commit.

---

### Task 18: Run security-checklist skill walk

**Files:**
- Create: `docs/plans/2026-04-27-phase-1a-security-note.md`

**Step 18.1:** Invoke the `security-checklist` skill. The skill walks three threat models (sandbox escape, prompt injection, supply chain) and produces a structured PR security note.

**Step 18.2:** Save the output to the security note file. Key points to address explicitly:
- **Sandbox escape:** Sandbox env contains placeholders only (I1). Bridge contains zero policy (I8). Allowlist + private-IP block enforced host-side.
- **Prompt injection:** Untrusted bytes from sandbox flow through `replaceAllBuffer`. Substitution is buffer-level string replace — no eval, no parser. `ax-cred:<32-hex>` placeholders cannot collide with random text statistically.
- **Supply chain:** New dep `node-forge@^1.3.1` (X.509 cert ops). Maintained by Digital Bazaar; ~3M weekly downloads; pinned to ^1.3.1. Confirm no install scripts. `pnpm audit` clean.

**Step 18.3:** Commit security note.

---

### Task 19: Final verification

**Step 19.1:** From repo root in worktree:

```bash
pnpm install            # picks up node-forge + new packages
pnpm build              # tsc --build across all packages
pnpm lint               # eslint .
pnpm test               # vitest across all packages
```

Expected:
- Build: clean, no errors
- Lint: clean
- Tests: previous 1607 + Phase 1a's new tests, 0 failures

**Step 19.2:** Verify no half-wired changes to existing plugins:

```bash
git diff --stat HEAD~N main -- packages/cli packages/chat-orchestrator packages/agent-claude-sdk-runner
```

Expected: zero changes to existing plugin code. Only new packages.

**Step 19.3:** If anything fails, stop and fix before committing.

---

### Task 20: PR description + final review

**Files:**
- Modify: `docs/plans/2026-04-27-phase-1a-pr-notes.md` (create — companion doc per past PR pattern)

PR description must include:

- **What lands:** `@ax/credential-proxy` (host) + `@ax/credential-proxy-bridge` (sandbox library). 4 v1 helpers ported.
- **What does NOT land:** any wiring into `cli/main.ts` or `agent-claude-sdk-runner` (deferred to Phase 2). The `@ax/credentials` plugin's hook shapes are NOT changed (deferred to Phase 1b).
- **Half-wired note:** Plugins are integration-tested but not loaded by the production CLI. Tradeoff accepted per design Section 7. Phase 2 closes the loop within ~1 week.
- **Boundary review:** New service hooks `proxy:open-session/rotate-session/close-session` — alternate impl could be a different proxy backend (e.g., per-pod sidecar instead of shared-host). Payload field names: `proxyEndpoint` (opaque URI string), `caCertPem` (PEM string), `envMap` (Record<string,string>) — none leak backend specifics. New subscriber hook `event.http-egress` — payload uses `host`/`path`/`status` (HTTP-generic, not k8s-specific).
- **Security note:** Link to `2026-04-27-phase-1a-security-note.md`.
- **Invariants verified:** I1-I9 from the impl plan, with test references.

After approval, commit and push (in next session — see Execution Handoff below).

---

## Risks + mitigation summary

| Risk | Mitigation |
|---|---|
| Half-wired plugin lingers if Phase 2 stalls | Land Phase 2 within 1 week; flag in PR notes |
| node-forge supply-chain risk | Pin to `^1.3.1`; `pnpm audit` in Task 18; document in security note |
| Cert-minting cost balloons under load | Domain cert cache (per-process, in-memory) — first-mint ~50ms, subsequent O(1) |
| Multi-tenant placeholder collisions | 16 random bytes; statistically infeasible (covered by Task 3 test) |
| MITM intercepts cert-pinning CLIs | `bypassMITM` per-session opt-out (Task 7); raw tunnel for those hostnames |
| Logger noise (CA generation, egress events) | Use `ctx.logger` for per-request lines; structured fields only |

---

## Out of scope (deferred to later phases)

- Wiring proxy into chat-orchestrator (Phase 2)
- Wiring bridge into agent-claude-sdk-runner startup (Phase 2)
- Splitting `@ax/credentials` into facade + store + per-kind resolvers (Phase 1b)
- OAuth lifecycle (`credentials:resolve:anthropic-oauth`) (Phase 3)
- K8s NetworkPolicy belt-and-suspenders (defer per design Section 8)
- Cross-replica OAuth refresh coordination (defer per design Section 8)
- Per-agent canary token integration into `agents:resolve` (defer per design Section 8)
