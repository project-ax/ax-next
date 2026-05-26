# HTTP runner-IPC Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan task-by-task.

**Goal:** Make the `http://` runner-endpoint URI work end-to-end so a runner pod can talk back to the host pod over TCP. After this lands, kind-cluster acceptance can finally tick the "chat returns a response" box in `deploy/MANUAL-ACCEPTANCE.md`.

**Architecture (interpretation B from the planning discussion):** runner stays the IPC client, host stays the IPC server. The HTTP transport puts the listener in the **host pod**, not the runner pod — runner pods connect outbound to a Kubernetes `Service` that points at the host. This matches arch spec Section 5 ("Agent: client.call('workspace:apply', …)"), legacy v1's `HttpIPCClient` shape, and the existing Helm `NetworkPolicies` (`sandbox-restrict.yaml` keeps `ingress: []` on runner pods; `host-network.yaml` allows runner-namespace ingress to the host's port).

The handoff doc (`docs/plans/2026-04-25-http-runner-ipc-handoff.md`) describes a runner-as-server topology — which is wrong for this codebase. We follow the code & arch spec instead. Specifically that means: `runnerEndpoint` for the k8s case becomes the **host's** Service URL, not the runner pod's IP. `containerPort: 7777` and `RUNNER_PORT` get dropped from the runner pod spec (the runner does not bind anything in either transport — that's the sandbox provider's job in unix and the host's job in HTTP).

Everything else from the handoff doc applies cleanly: extract `@ax/ipc-core` from `@ax/ipc-server` in a prep commit, then add `@ax/ipc-http` on top; lift `parseRunnerEndpoint` into `@ax/ipc-protocol`; bearer auth + `crypto.timingSafeEqual` is the gate; Node `http`, no Express/undici/fetch; SECURITY.md walks all three threat models; plain HTTP within the cluster (mTLS deferred).

**Tech stack:** TypeScript, Node `http` (built-in), Zod (already in workspace), Vitest (already in workspace). No new external deps.

**Branch:** off `main` (PR #9 merged). Use a worktree per `superpowers:using-git-worktrees`.

---

## Invariants (from the rolled-back-and-redone playbook in feedback memory)

These are the things the previous "Task 14b" half-shipped — they need to be true at the end of this slice or it's not done:

- **I1.** Runner-side IPC client supports `http://` end-to-end. `parseRunnerEndpoint` no longer throws on `http://`; the defensive guard in `requestOnce` no longer rejects non-`unix` targets. A real action (e.g. `tool.list`) round-trips against an in-process `http.createServer`.
- **I2.** `@ax/ipc-core` exists, owns the transport-agnostic dispatcher / auth / body / response / errors / handlers. `@ax/ipc-server` shrinks to listener + plugin + back-compat re-exports. `@ax/ipc-http` ships a TCP listener on top of the same core.
- **I3.** `parseRunnerEndpoint` lives in `@ax/ipc-protocol` (single source of truth for the URI grammar; runner-side imports it from there).
- **I4.** Host-side TCP listener authenticates every request with `Authorization: Bearer <token>` resolved via `session:resolve-token`. Token equality on the cross-session check uses `crypto.timingSafeEqual`. Token value never echoes into error messages (carries forward I9 from the unix path).
- **I5.** `runnerEndpoint` returned by `@ax/sandbox-k8s` points at the **host** (cluster Service URL). `RUNNER_PORT` and `containerPort: 7777` are deleted from the pod spec — runner pods never listen.
- **I6.** Helm chart wires the host's `Service` URL into the host pod's env so `@ax/sandbox-k8s` can stamp it onto each runner pod's `AX_RUNNER_ENDPOINT`.
- **I7.** `@ax/ipc-http/SECURITY.md` walks all three threat models with concrete answers — sandbox (the new inbound TCP capability), prompt injection (request body is untrusted bytes), supply chain (Node built-in only, no new deps).
- **I8.** `pnpm test` is fully green at the end. The existing `@ax/ipc-server` test file passes against relocated `@ax/ipc-core` modules unchanged in spirit (we move tests for the relocated files; the listener tests stay put).
- **I9.** `pnpm build` is fully green and `pnpm lint` reports no `no-restricted-imports` violations (the cross-plugin import rule). `@ax/ipc-http` only imports `@ax/core`, `@ax/ipc-core`, and `@ax/ipc-protocol`.

---

## Boundary review (per `CLAUDE.md`)

Done up front so each task can refer back rather than re-deriving the answers:

- **Alternate impl this hook could have:** `@ax/ipc-http` does not register a new service hook. It registers no service hooks at all — it just binds an HTTP listener at `init()` time. So no boundary review needed *for hook surface*. The two existing alternate impls of "the IPC listener" are `@ax/ipc-server` (unix-socket, per-session lifecycle via `ipc:start`/`ipc:stop`) and `@ax/ipc-http` (TCP, process-wide bind in `init()`); each preset loads exactly one.
- **Payload field names that might leak:** `runnerEndpoint` is already an opaque URI (I1 from the v2 architecture). `parseRunnerEndpoint` becoming public surface in `@ax/ipc-protocol` doesn't leak — it is the URI grammar's home.
- **Subscriber risk:** `@ax/ipc-http` fires the same subscriber hooks the unix listener fires (via the shared dispatcher in `@ax/ipc-core`). Nothing new.
- **Wire surface (IPC):** the HTTP listener is **the** wire surface. Schemas live with their actions (`@ax/ipc-protocol/src/actions.ts`, already shared by the unix listener). No central registry change.

---

## Security walk (per `security-checklist`)

This is the security gate. Concrete answers, not aspirational lines:

**Sandbox / capability change:**
- New capability: `@ax/ipc-http` binds a TCP listener on `0.0.0.0:<port>` (default 8080). Any client that can route to that address can attempt requests.
- Bounded by: NetworkPolicy in `host-network.yaml` (only runner-namespace pods + own-namespace pods can ingress to this port). Bearer auth via `session:resolve-token` is the wall behind the perimeter. `crypto.timingSafeEqual` on the cross-session compare is the lock on the wall.
- Fixed argv? N/A — no process spawn in this slice.
- Caller-influenced env? N/A.
- Path traversal? N/A — request paths route to a fixed in-code map (`/llm.call`, `/tool.list`, …) in the dispatcher; unknown path → 404.

**Prompt injection:**
- Untrusted strings entering this slice: HTTP request bodies from runner pods. The runner-side IPC client serializes payloads with `JSON.stringify`; the host-side listener parses with `JSON.parse` under `MAX_FRAME` cap (4 MiB). Body parser already enforces this (`@ax/ipc-server/src/body.ts`, moving to `@ax/ipc-core`).
- Bad destinations? Each handler validates with the action's Zod schema before it reaches plugin code (existing pattern in `dispatcher.ts`). Errors never echo body content (already enforced — `writeJsonError` writes a fixed safe message).
- Worst-case: a malicious runner pod sends an arbitrary JSON body that `JSON.parse` rejects → 400, no execution. A well-formed but injection-flavored body still has to pass the Zod schema for the action; the schemas don't accept shell strings or filesystem paths from the wire.

**Supply chain:**
- New deps in `package.json`s of `@ax/ipc-core` and `@ax/ipc-http`: `@ax/core` (workspace), `@ax/ipc-protocol` (workspace), no others. Node's built-in `node:http` is the transport.
- DevDeps are the standard workspace set: `vitest`, `typescript`, `@types/node`. Already present transitively; no new entries in the lockfile diff.
- Resist Express/Koa/undici/middleware — the unix listener is framework-free; the HTTP listener mirrors that.

This security note gets restated and expanded in `@ax/ipc-http/SECURITY.md` (Task 12) with the same answers, because that's where future readers will look. The prep extraction (`@ax/ipc-core`) does not need its own SECURITY.md — it carries no new capability over `@ax/ipc-server`.

---

## File-by-file impact (read once, refer back per task)

**New packages:**
- `packages/ipc-core/` — extracted from `packages/ipc-server/`. Files: `package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md`, `src/index.ts`, `src/dispatcher.ts`, `src/auth.ts`, `src/body.ts`, `src/response.ts`, `src/errors.ts`, `src/handlers/*.ts`, plus the relocated tests for those files (`src/__tests__/auth.test.ts`, `body.test.ts`, `dispatcher.test.ts`).
- `packages/ipc-http/` — new. Files: `package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md`, `SECURITY.md`, `src/index.ts`, `src/listener.ts`, `src/plugin.ts`, `src/__tests__/listener.test.ts`, `src/__tests__/plugin.test.ts`.

**Modified existing files:**
- `packages/ipc-server/package.json` — adds `@ax/ipc-core` dependency.
- `packages/ipc-server/src/index.ts` — re-exports from `@ax/ipc-core` for back-compat. Listener types stay.
- `packages/ipc-server/src/listener.ts` — imports `authenticate`, `dispatch`, `writeJsonError` from `@ax/ipc-core` instead of sibling files.
- `packages/ipc-server/src/plugin.ts` — imports `createListener` (still local) but the dispatcher chain is via `@ax/ipc-core`.
- `packages/ipc-server/src/__tests__/listener.test.ts` — stays put (drives the unix listener end-to-end). May need `import { authenticate } from '@ax/ipc-core'` if it touches that surface; mostly unchanged.
- `packages/ipc-protocol/src/index.ts` — adds `export * from './runner-endpoint.js'`.
- `packages/ipc-protocol/src/runner-endpoint.ts` — **new**. Hosts `parseRunnerEndpoint` and `TransportTarget`. Includes both `unix:` (existing logic) and `http:` (new) branches.
- `packages/ipc-protocol/src/__tests__/runner-endpoint.test.ts` — **new**. Covers parse paths for both schemes.
- `packages/agent-runner-core/src/ipc-client.ts` — drops the inline `parseRunnerEndpoint` (re-imports from `@ax/ipc-protocol`); drops the `if (opts.target.kind !== 'unix')` defensive guard at lines 236–245; switches `http.request` arg shape on `target.kind`.
- `packages/agent-runner-core/src/__tests__/ipc-client.test.ts` — adds an `http:` round-trip block mirroring the existing `unix:` block.
- `packages/sandbox-k8s/src/config.ts` — adds `hostIpcUrl: string` (required) to the resolved config.
- `packages/sandbox-k8s/src/open-session.ts` — replaces `runnerEndpoint = http://${podIP}:${RUNNER_PORT}` with `runnerEndpoint = config.hostIpcUrl`. The placeholder `pending://await-pod-ready` env entry goes away (Task 8 in this plan).
- `packages/sandbox-k8s/src/pod-spec.ts` — drops `RUNNER_PORT` export, `ports: [{ containerPort: 7777, ... }]`, and the env-placeholder lifecycle comment block. `AX_RUNNER_ENDPOINT` env entry takes the resolved host URL directly at spec-build time.
- `packages/sandbox-k8s/src/__tests__/pod-spec.test.ts` — updated assertions: no more `RUNNER_PORT`, no `containerPort`, `AX_RUNNER_ENDPOINT` carries the configured URL.
- `packages/sandbox-k8s/src/__tests__/open-session.test.ts` — updated: result `runnerEndpoint` is the configured host URL, not `http://<podIP>:7777`.
- `packages/sandbox-k8s/SECURITY.md` — removes the "HTTP transport not yet implemented" known-limit (lines around 125).
- `presets/k8s/src/index.ts` — replaces `createIpcServerPlugin()` with `createIpcHttpPlugin({ host, port })`. Adds `ipc.host`/`ipc.port` to `K8sPresetConfig`. Wires `hostIpcUrl` into `createSandboxK8sPlugin` config.
- `presets/k8s/src/__tests__/preset.test.ts` — updates registered-hook expectations: `ipc:start`/`ipc:stop` no longer registered (the unix plugin is gone from this preset).
- `deploy/charts/ax-next/values.yaml` — adds `host.ipcUrl` (computed default) or relies on Service DNS via env interpolation. See Task 13.
- `deploy/charts/ax-next/templates/host/deployment.yaml` — adds env vars: `AX_K8S_HOST_IPC_URL` (the cluster-internal Service URL the runner uses to reach the host).
- `deploy/MANUAL-ACCEPTANCE.md` — drops the "HTTP runner-IPC is not yet implemented" gotcha; replaces with the new acceptance step (kubectl logs the host pod for `ipc_http_listening` and a debug-runner-pod curl probe).

**No file changes (verified):**
- `deploy/charts/ax-next/templates/networkpolicies/host-network.yaml` — already permits runner-namespace ingress to the host on `host.ports.http`.
- `deploy/charts/ax-next/templates/networkpolicies/sandbox-restrict.yaml` — already blocks all ingress to runner pods (good — runner doesn't listen) and allows egress to host's port (good — runner connects out).
- `deploy/charts/ax-next/templates/host/service.yaml` — already exposes `port: 80 → targetPort: http`. Cluster DNS form `http://<svc-name>.<ns>.svc.cluster.local:80` works as-is.

---

## Task list

Each task is small enough to give to a fresh subagent with no context. TDD discipline: failing test, then minimal impl, then green, then commit. Reference `superpowers:test-driven-development` and `superpowers:verification-before-completion`.

### Task 1: Scaffold `@ax/ipc-core` package skeleton

**Goal:** Create the empty package with the same shape as `@ax/ipc-server`. No code moves yet — this is the hosting structure.

**Files:**
- Create: `packages/ipc-core/package.json`
- Create: `packages/ipc-core/tsconfig.json`
- Create: `packages/ipc-core/vitest.config.ts`
- Create: `packages/ipc-core/README.md`
- Create: `packages/ipc-core/src/index.ts` (empty exports)
- Modify: workspace root `tsconfig.json` references (if it lists per-package projects)

**Step 1: Read the equivalent files in `@ax/ipc-server`** to mirror shape exactly.

```bash
cat packages/ipc-server/package.json packages/ipc-server/tsconfig.json packages/ipc-server/vitest.config.ts
```

**Step 2: Write `packages/ipc-core/package.json`.** Mirror the `@ax/ipc-server` shape:

```json
{
  "name": "@ax/ipc-core",
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
    "@ax/ipc-protocol": "workspace:*"
  },
  "devDependencies": {
    "@ax/session-inmemory": "workspace:*",
    "@ax/test-harness": "workspace:*",
    "@types/node": "^25.6.0",
    "typescript": "^6.0.3",
    "vitest": "^4.1.4"
  }
}
```

**Step 3: Copy `tsconfig.json` and `vitest.config.ts`** verbatim from `@ax/ipc-server`.

**Step 4: Write a stub `src/index.ts`:**

```ts
// Populated by Task 2 — moved from @ax/ipc-server.
export {};
```

**Step 5: Run `pnpm install`** so the workspace picks up the new package.

```bash
pnpm install
```

Expected: install succeeds, `pnpm-lock.yaml` updates with the new package entry. No version drift in transitive deps.

**Step 6: Commit.**

```bash
git add packages/ipc-core pnpm-lock.yaml
git commit -m "scaffold(ipc-core): empty package skeleton"
```

---

### Task 2: Move transport-agnostic modules from `@ax/ipc-server` to `@ax/ipc-core`

**Goal:** Relocate `dispatcher.ts`, `auth.ts`, `body.ts`, `response.ts`, `errors.ts`, and `handlers/*.ts` to `@ax/ipc-core`. `@ax/ipc-server` shrinks to `listener.ts` + `plugin.ts`. Tests follow their files.

**Files moved:**
- `packages/ipc-server/src/dispatcher.ts` → `packages/ipc-core/src/dispatcher.ts`
- `packages/ipc-server/src/auth.ts` → `packages/ipc-core/src/auth.ts`
- `packages/ipc-server/src/body.ts` → `packages/ipc-core/src/body.ts`
- `packages/ipc-server/src/response.ts` → `packages/ipc-core/src/response.ts`
- `packages/ipc-server/src/errors.ts` → `packages/ipc-core/src/errors.ts`
- `packages/ipc-server/src/handlers/` → `packages/ipc-core/src/handlers/` (entire directory, including the inner `__tests__/`)
- `packages/ipc-server/src/__tests__/auth.test.ts` → `packages/ipc-core/src/__tests__/auth.test.ts`
- `packages/ipc-server/src/__tests__/body.test.ts` → `packages/ipc-core/src/__tests__/body.test.ts`
- `packages/ipc-server/src/__tests__/dispatcher.test.ts` → `packages/ipc-core/src/__tests__/dispatcher.test.ts`

**Files staying in `@ax/ipc-server`:**
- `packages/ipc-server/src/listener.ts` — owns the unix-socket-specific `fs.unlink`, `server.listen(socketPath, …)`, `socketPath` field on `Listener`.
- `packages/ipc-server/src/plugin.ts` — registers `ipc:start`/`ipc:stop`.
- `packages/ipc-server/src/index.ts` — re-exports from `@ax/ipc-core` for back-compat (existing consumers can keep importing from `@ax/ipc-server`).
- `packages/ipc-server/src/__tests__/listener.test.ts` — drives the unix listener end-to-end.

**Step 1: Move the files.** Use `git mv` so history follows.

```bash
git mv packages/ipc-server/src/dispatcher.ts  packages/ipc-core/src/dispatcher.ts
git mv packages/ipc-server/src/auth.ts        packages/ipc-core/src/auth.ts
git mv packages/ipc-server/src/body.ts        packages/ipc-core/src/body.ts
git mv packages/ipc-server/src/response.ts    packages/ipc-core/src/response.ts
git mv packages/ipc-server/src/errors.ts      packages/ipc-core/src/errors.ts
git mv packages/ipc-server/src/handlers       packages/ipc-core/src/handlers
git mv packages/ipc-server/src/__tests__/auth.test.ts       packages/ipc-core/src/__tests__/auth.test.ts
git mv packages/ipc-server/src/__tests__/body.test.ts       packages/ipc-core/src/__tests__/body.test.ts
git mv packages/ipc-server/src/__tests__/dispatcher.test.ts packages/ipc-core/src/__tests__/dispatcher.test.ts
```

**Step 2: Update `packages/ipc-core/src/index.ts`** to export the moved surfaces:

```ts
export {
  dispatch,
} from './dispatcher.js';
export {
  authenticate,
  type AuthResult,
} from './auth.js';
export {
  readJsonBody,
  BadJsonError,
  TooLargeError,
  type ReadBodyResult,
} from './body.js';
export {
  writeJsonError,
  writeJsonOk,
} from './response.js';
export {
  validationError,
  notFound,
  hookRejected,
  mapPluginError,
  internalError,
  logInternalError,
  type IpcErrorCode,
} from './errors.js';
```

**Step 3: Rewrite `packages/ipc-server/src/index.ts`** to re-export for back-compat:

```ts
export { createIpcServerPlugin } from './plugin.js';
export { createListener, type Listener, type CreateListenerOptions } from './listener.js';
// Back-compat re-exports — the canonical home is now @ax/ipc-core. Existing
// @ax/ipc-server consumers (chat-orchestrator, cli, sandbox-subprocess) keep
// working without import-path churn; new consumers should import from
// @ax/ipc-core directly.
export {
  authenticate,
  type AuthResult,
  readJsonBody,
  BadJsonError,
  TooLargeError,
  type ReadBodyResult,
  writeJsonError,
  writeJsonOk,
  dispatch,
} from '@ax/ipc-core';
```

**Step 4: Update `packages/ipc-server/src/listener.ts`** imports to use `@ax/ipc-core`:

```ts
// before
import { authenticate } from './auth.js';
import { dispatch } from './dispatcher.js';
import { writeJsonError } from './response.js';

// after
import { authenticate, dispatch, writeJsonError } from '@ax/ipc-core';
```

**Step 5: Update `packages/ipc-server/package.json`** dependencies to add `@ax/ipc-core`:

```json
"dependencies": {
  "@ax/core": "workspace:*",
  "@ax/ipc-core": "workspace:*",
  "@ax/ipc-protocol": "workspace:*"
}
```

**Step 6: Update relocated test imports.** The moved test files (`auth.test.ts`, `body.test.ts`, `dispatcher.test.ts`) currently import via `'../auth.js'`, `'../body.js'`, etc. Those relative paths still resolve correctly inside `@ax/ipc-core/src/__tests__/`. Verify by reading them after the move.

The `handlers/__tests__/` folder moves intact — its imports are also relative.

**Step 7: Run `pnpm install`** to sync the new dep in `@ax/ipc-server`.

```bash
pnpm install
```

**Step 8: Run tests on the relocated modules.**

```bash
pnpm test --filter @ax/ipc-core
```

Expected: all relocated tests (auth, body, dispatcher, handler tests) pass. If any fail, the relative imports inside test files probably need adjustment — read the failure, fix, re-run.

**Step 9: Run the unchanged listener test.**

```bash
pnpm test --filter @ax/ipc-server
```

Expected: `listener.test.ts` passes against the relocated dispatcher/auth/body/response modules. The listener's contract is unchanged.

**Step 10: Run the full workspace.**

```bash
pnpm test
pnpm build
```

Expected: green. The other packages that import from `@ax/ipc-server` (chat-orchestrator, cli, sandbox-subprocess) keep working because of the back-compat re-exports in `index.ts`.

**Step 11: Commit.**

```bash
git add -A
git commit -m "refactor(ipc): extract @ax/ipc-core from @ax/ipc-server (transport-agnostic dispatcher, auth, body, response, errors, handlers)"
```

---

### Task 3: Lift `parseRunnerEndpoint` into `@ax/ipc-protocol`

**Goal:** Move the URI-grammar parser to a single canonical home. The runner-side `ipc-client.ts` re-imports it; future callers (server-side wiring, debug tools) get one source of truth.

**Files:**
- Create: `packages/ipc-protocol/src/runner-endpoint.ts`
- Create: `packages/ipc-protocol/src/__tests__/runner-endpoint.test.ts`
- Modify: `packages/ipc-protocol/src/index.ts`
- Modify: `packages/agent-runner-core/src/ipc-client.ts`

**Step 1: Write the failing test** at `packages/ipc-protocol/src/__tests__/runner-endpoint.test.ts`. Cover both schemes plus the error cases the existing inline parser handles:

```ts
import { describe, it, expect } from 'vitest';
import {
  parseRunnerEndpoint,
  RunnerEndpointError,
  type TransportTarget,
} from '../runner-endpoint.js';

describe('parseRunnerEndpoint', () => {
  it('parses unix:///abs/path as a unix target', () => {
    const t: TransportTarget = parseRunnerEndpoint('unix:///tmp/ipc.sock');
    expect(t).toEqual({ kind: 'unix', socketPath: '/tmp/ipc.sock' });
  });

  it('rejects unix:// without an absolute path', () => {
    expect(() => parseRunnerEndpoint('unix://relative/path'))
      .toThrow(RunnerEndpointError);
  });

  it('parses http://host:port as an http target', () => {
    const t: TransportTarget = parseRunnerEndpoint('http://host.example:8080');
    expect(t).toEqual({ kind: 'http', host: 'host.example', port: 8080 });
  });

  it('parses cluster Service DNS shape', () => {
    const t: TransportTarget = parseRunnerEndpoint(
      'http://ax-next-host.ax-next.svc.cluster.local:80',
    );
    expect(t).toEqual({
      kind: 'http',
      host: 'ax-next-host.ax-next.svc.cluster.local',
      port: 80,
    });
  });

  it('rejects http:// with no host', () => {
    expect(() => parseRunnerEndpoint('http://:8080')).toThrow(RunnerEndpointError);
  });

  it('rejects http:// with no port (we never default — be loud)', () => {
    expect(() => parseRunnerEndpoint('http://host.example'))
      .toThrow(RunnerEndpointError);
  });

  it('rejects http:// with a path component (the URI carries the authority only)', () => {
    expect(() => parseRunnerEndpoint('http://host.example:80/extra'))
      .toThrow(RunnerEndpointError);
  });

  it('rejects unsupported schemes', () => {
    expect(() => parseRunnerEndpoint('vsock://1:2')).toThrow(RunnerEndpointError);
  });

  it('rejects malformed URIs', () => {
    expect(() => parseRunnerEndpoint('not-a-uri')).toThrow(RunnerEndpointError);
  });
});
```

**Step 2: Run the test to verify it fails.**

```bash
pnpm test --filter @ax/ipc-protocol -- runner-endpoint.test.ts
```

Expected: FAIL — module `../runner-endpoint.js` does not exist.

**Step 3: Implement `packages/ipc-protocol/src/runner-endpoint.ts`:**

```ts
// ---------------------------------------------------------------------------
// parseRunnerEndpoint — single source of truth for the runner-endpoint URI
// grammar (invariant I3 of this slice).
//
// The URI is an opaque token at the sandbox-provider boundary (architecture
// invariant I1 — no transport-specific field names leak across hooks).
// Inside this file, we know exactly which transports we accept and we
// validate strictly.
//
// Supported schemes:
//   - `unix:///abs/path/ipc.sock` — Unix domain socket. The
//     subprocess sandbox provider sets this. `socketPath` MUST be absolute
//     (a relative path would mean `unix:relative/path` which is almost
//     certainly a wiring bug).
//   - `http://host:port`         — TCP HTTP. The k8s sandbox provider
//     sets this to the cluster-internal Service URL of the host pod (NOT
//     the runner pod's own IP — the runner is the IPC client; the host
//     hosts the listener). Port is REQUIRED — we never default to 80,
//     because a missing port is almost always a wiring bug.
//
// Anything else (vsock://, ws://, https://, ...) is rejected with a clear
// RunnerEndpointError. New transports get a new branch here when (and only
// when) a real impl ships.
// ---------------------------------------------------------------------------

export class RunnerEndpointError extends Error {
  public override readonly name = 'RunnerEndpointError';
  constructor(message: string, public readonly cause?: Error) {
    super(message);
  }
}

export type TransportTarget =
  | { kind: 'unix'; socketPath: string }
  | { kind: 'http'; host: string; port: number };

export function parseRunnerEndpoint(uri: string): TransportTarget {
  let url: URL;
  try {
    url = new URL(uri);
  } catch (cause) {
    throw new RunnerEndpointError(
      `invalid runnerEndpoint URI: ${uri}`,
      cause as Error,
    );
  }

  switch (url.protocol) {
    case 'unix:': {
      const socketPath = url.pathname;
      if (socketPath.length === 0 || !socketPath.startsWith('/')) {
        throw new RunnerEndpointError(
          `unix:// runnerEndpoint must include an absolute path (got ${uri})`,
        );
      }
      return { kind: 'unix', socketPath };
    }
    case 'http:': {
      // url.hostname strips brackets from IPv6 literals automatically — fine.
      // url.port is a string ('') when not specified.
      const host = url.hostname;
      const portStr = url.port;
      if (host.length === 0) {
        throw new RunnerEndpointError(
          `http:// runnerEndpoint must include a host (got ${uri})`,
        );
      }
      if (portStr.length === 0) {
        throw new RunnerEndpointError(
          `http:// runnerEndpoint must include an explicit port (got ${uri})`,
        );
      }
      const port = Number(portStr);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new RunnerEndpointError(
          `http:// runnerEndpoint port out of range (got ${uri})`,
        );
      }
      // The path is reserved for the action name (`/llm.call`, etc.) — the
      // URI carries the authority only.
      if (url.pathname !== '/' && url.pathname !== '') {
        throw new RunnerEndpointError(
          `http:// runnerEndpoint must not include a path component (got ${uri})`,
        );
      }
      return { kind: 'http', host, port };
    }
    default:
      throw new RunnerEndpointError(
        `unsupported runnerEndpoint scheme: ${url.protocol}`,
      );
  }
}
```

**Step 4: Re-export from `packages/ipc-protocol/src/index.ts`:**

```ts
export * from './actions.js';
export * from './events.js';
export * from './errors.js';
export * from './timeouts.js';
export * from './runner-endpoint.js';
```

**Step 5: Run the test to verify it passes.**

```bash
pnpm test --filter @ax/ipc-protocol -- runner-endpoint.test.ts
```

Expected: PASS, all 9 cases.

**Step 6: Update `@ax/agent-runner-core` to import from `@ax/ipc-protocol`.**

In `packages/agent-runner-core/src/ipc-client.ts`:
- Replace the inline `TransportTarget` type and `parseRunnerEndpoint` function (currently lines 104–146) with `import { parseRunnerEndpoint, type TransportTarget, RunnerEndpointError } from '@ax/ipc-protocol';` at the top of the file.
- Where the existing code throws `HostUnavailableError(...)` from the parser, the new lifted parser throws `RunnerEndpointError`. Catch and re-wrap in `createIpcClient` so the public surface (`HostUnavailableError`) stays unchanged for callers that already key off it:

```ts
let target: TransportTarget;
try {
  target = parseRunnerEndpoint(opts.runnerEndpoint);
} catch (err) {
  if (err instanceof RunnerEndpointError) {
    throw new HostUnavailableError(err.message, err.cause);
  }
  throw err;
}
```

**Step 7: Run the existing client tests to verify nothing broke.**

```bash
pnpm test --filter @ax/agent-runner-core -- ipc-client.test.ts
```

Expected: PASS. The unix-branch behavior is unchanged.

**Step 8: Commit.**

```bash
git add -A
git commit -m "refactor(ipc-protocol): lift parseRunnerEndpoint into shared protocol package"
```

---

### Task 4: Wire `http://` support through the runner-side IPC client

**Goal:** Drop the "not implemented yet" guard. The `http:` branch of `requestOnce` switches `http.request` arg shape to `{ host, port, path, method, headers, signal }`. Everything else (response draining, MAX_RESPONSE_BYTES cap, AbortController-based timeout, errno classification) stays.

**Files:**
- Modify: `packages/agent-runner-core/src/ipc-client.ts`

**Step 1: Write the failing test.** This is just the round-trip fixture; we'll add it as the next task. For Task 4, drive the failure through the existing test suite by changing the constructor to actually accept `http://` URIs (it'll fail on the first `requestOnce` call with the defensive `transport ${kind} not implemented` error).

Add a temporary inline test at the bottom of `packages/agent-runner-core/src/__tests__/ipc-client.test.ts`:

```ts
it('http: target reaches requestOnce without throwing the defensive guard', async () => {
  const client = createIpcClient({
    runnerEndpoint: 'http://127.0.0.1:65535',
    token: 'tok',
    maxRetries: 0,
  });
  // Connection will fail (nothing listening on :65535) — but it must fail
  // with a transient connection error, NOT with the "transport not
  // implemented" defensive guard.
  await expect(client.call('tool.list', {})).rejects.toThrow(/HostUnavailable/);
  await expect(client.call('tool.list', {})).rejects.not.toThrow(/not implemented/);
});
```

**Step 2: Run the test to verify it fails.**

```bash
pnpm test --filter @ax/agent-runner-core -- ipc-client.test.ts
```

Expected: FAIL with "transport http not implemented" (the current defensive guard at lines 236–245).

**Step 3: Drop the defensive guard and switch arg shape on `target.kind`.**

In `packages/agent-runner-core/src/ipc-client.ts`, inside `requestOnce`:

```ts
// Before:
if (opts.target.kind !== 'unix') {
  settle(() => reject(new HostUnavailableError(`transport ${opts.target.kind} not implemented`)));
  return;
}
const req = http.request(
  {
    socketPath: opts.target.socketPath,
    path: opts.pathWithQuery,
    method: opts.method,
    headers,
    signal: controller.signal,
  },
  (res) => { ... },
);

// After:
const requestOptions: http.RequestOptions =
  opts.target.kind === 'unix'
    ? {
        socketPath: opts.target.socketPath,
        path: opts.pathWithQuery,
        method: opts.method,
        headers,
        signal: controller.signal,
      }
    : {
        host: opts.target.host,
        port: opts.target.port,
        path: opts.pathWithQuery,
        method: opts.method,
        headers,
        signal: controller.signal,
      };
const req = http.request(requestOptions, (res) => { ... });
```

The response handler, error handler, body write, and `req.end()` stay identical — they're shape-agnostic.

**Step 4: Run the temporary test to verify it passes.**

```bash
pnpm test --filter @ax/agent-runner-core -- ipc-client.test.ts
```

Expected: PASS. The test now sees `HostUnavailableError("connect failed: ECONNREFUSED")` (or similar errno) — a real connection failure to a closed port — not the "not implemented" guard.

**Step 5: Run the full agent-runner-core test suite** to confirm no regressions.

```bash
pnpm test --filter @ax/agent-runner-core
```

Expected: green.

**Step 6: Update the docstring at the top of `ipc-client.ts`.** The "RESERVED for the k8s pod sandbox provider (Task 14). NOT IMPLEMENTED YET" block in lines 28–37 is now stale. Replace with a short note that http:// works, then move on.

```ts
//   - `unix:///abs/path/ipc.sock` — the in-host subprocess sandbox provider.
//                                   Connects via http.request({ socketPath }).
//   - `http://host:port`          — the k8s pod sandbox provider. Connects
//                                   via http.request({ host, port }).
//                                   `host:port` points at the host's IPC
//                                   listener (cluster Service DNS), NOT the
//                                   runner pod itself.
```

**Step 7: Commit.** Keep the temporary test for now — Task 5 replaces it with a real round-trip.

```bash
git add -A
git commit -m "feat(agent-runner-core): http:// transport in IPC client (TCP via http.request)"
```

---

### Task 5: Round-trip test for the runner-side `http:` branch

**Goal:** Replace the temporary connection-refused test with a real round-trip against an in-process `http.createServer`. Mirrors the existing `unix:` round-trip test.

**Files:**
- Modify: `packages/agent-runner-core/src/__tests__/ipc-client.test.ts`

**Step 1: Read the existing `unix:` round-trip block.** It demonstrates the shape — set up a server, expose it on a socket, point the client at it, call an action, assert the body.

```bash
grep -n "callGet\|client\.call\|http\.createServer\|createListener" packages/agent-runner-core/src/__tests__/ipc-client.test.ts | head -20
```

**Step 2: Write the new test. Replace the temporary test from Task 4 with this:**

```ts
import * as http from 'node:http';

describe('http:// transport round-trip', () => {
  let server: http.Server;
  let port: number;
  const TOKEN = 'test-bearer-token';

  beforeEach(async () => {
    server = http.createServer((req, res) => {
      // Auth check: must carry the expected bearer token.
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${TOKEN}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'SESSION_INVALID', message: 'unknown token' } }));
        return;
      }

      // Read body, then respond with a tool.list-shaped body.
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
      req.on('end', () => {
        if (req.url === '/tool.list' && req.method === 'POST') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ tools: [{
            name: 'echo',
            description: 'echo',
            inputSchema: { type: 'object' },
            executesIn: 'sandbox',
          }] }));
          return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'unknown path' } }));
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (typeof addr === 'object' && addr !== null) port = addr.port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('round-trips tool.list with valid bearer auth', async () => {
    const client = createIpcClient({
      runnerEndpoint: `http://127.0.0.1:${port}`,
      token: TOKEN,
    });
    const result = (await client.call('tool.list', {})) as { tools: unknown[] };
    expect(result.tools).toHaveLength(1);
    expect((result.tools[0] as { name: string }).name).toBe('echo');
  });

  it('surfaces 401 as SessionInvalidError', async () => {
    const client = createIpcClient({
      runnerEndpoint: `http://127.0.0.1:${port}`,
      token: 'wrong-token',
      maxRetries: 0,
    });
    await expect(client.call('tool.list', {})).rejects.toThrow(/unknown token|SessionInvalid/);
  });
});
```

**Step 3: Run the test to verify it fails first.**

If the temporary "connection refused" test from Task 4 is still in place, delete it now. Then:

```bash
pnpm test --filter @ax/agent-runner-core -- ipc-client.test.ts
```

Expected: PASS. Both the round-trip and the 401 surfacing.

**Step 4: Commit.**

```bash
git add -A
git commit -m "test(agent-runner-core): round-trip test for http:// IPC client (replaces temp guard test)"
```

---

### Task 6: Scaffold `@ax/ipc-http` package skeleton

**Goal:** Empty package with the same shape as `@ax/ipc-server` minus the listener (which Task 7 implements).

**Files:**
- Create: `packages/ipc-http/package.json`
- Create: `packages/ipc-http/tsconfig.json`
- Create: `packages/ipc-http/vitest.config.ts`
- Create: `packages/ipc-http/README.md`
- Create: `packages/ipc-http/src/index.ts` (empty exports)

**Step 1: Mirror Task 1's shape.** `package.json`:

```json
{
  "name": "@ax/ipc-http",
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
    "@ax/ipc-core": "workspace:*",
    "@ax/ipc-protocol": "workspace:*"
  },
  "devDependencies": {
    "@ax/session-inmemory": "workspace:*",
    "@ax/test-harness": "workspace:*",
    "@types/node": "^25.6.0",
    "typescript": "^6.0.3",
    "vitest": "^4.1.4"
  }
}
```

**Step 2: Copy `tsconfig.json` and `vitest.config.ts`** verbatim from `@ax/ipc-server`.

**Step 3: Stub `src/index.ts`:**

```ts
// Populated by Task 7 (listener) and Task 8 (plugin).
export {};
```

**Step 4: README.md.** One paragraph; explain why this exists separately from `@ax/ipc-server` (TCP transport vs unix-socket transport; both share `@ax/ipc-core`).

**Step 5: Run `pnpm install`** and verify install succeeds.

```bash
pnpm install
pnpm build --filter @ax/ipc-http
```

Expected: green.

**Step 6: Commit.**

```bash
git add packages/ipc-http pnpm-lock.yaml
git commit -m "scaffold(ipc-http): empty package skeleton"
```

---

### Task 7: `createHttpListener` — TCP listener mirroring `createListener`

**Goal:** Bind `0.0.0.0:<port>` HTTP server. Same five gates as the unix listener except the cross-session gate is removed (a single TCP listener serves all sessions; the bearer token's resolution to a sessionId IS the per-request session identification). `crypto.timingSafeEqual` on the bearer comparison is enforced via the shared `authenticate()` helper from `@ax/ipc-core` plus an explicit timing-safe sessionId match in handlers that check session ownership (none today on the HTTP listener; documented).

**Files:**
- Create: `packages/ipc-http/src/listener.ts`
- Create: `packages/ipc-http/src/__tests__/listener.test.ts`

**Step 1: Read `packages/ipc-server/src/listener.ts` end-to-end** to internalize the gate ordering and error shapes.

**Step 2: Write the failing tests** at `packages/ipc-http/src/__tests__/listener.test.ts`. Cover the gates one at a time. Mirror the existing unix listener test (`packages/ipc-server/src/__tests__/listener.test.ts`) but with TCP semantics.

```ts
import * as http from 'node:http';
import { describe, it, expect, afterEach } from 'vitest';
import { createTestHarness } from '@ax/test-harness';
import { createSessionInmemoryPlugin } from '@ax/session-inmemory';
import type {
  SessionCreateInput,
  SessionCreateOutput,
} from '@ax/session-inmemory';
import { createHttpListener, type HttpListener } from '../listener.js';

interface Harness {
  listener: HttpListener;
  port: number;
  token: string;
  cleanup: () => Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const h = await createTestHarness({ plugins: [createSessionInmemoryPlugin()] });
  const ctx = h.ctx();
  const { token } = await h.bus.call<SessionCreateInput, SessionCreateOutput>(
    'session:create',
    ctx,
    { sessionId: 'sess-http', workspaceRoot: '/tmp/ws' },
  );
  // Bind on port 0 so the OS assigns a free port; the listener returns it.
  const listener = await createHttpListener({ host: '127.0.0.1', port: 0, bus: h.bus });
  return {
    listener,
    port: listener.port,
    token,
    cleanup: async () => { await listener.close(); },
  };
}

interface RequestOptions {
  method: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

function requestTo(port: number, opts: RequestOptions): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: opts.path ?? '/',
        method: opts.method,
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          headers: res.headers,
        }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

describe('createHttpListener', () => {
  let harness: Harness;
  afterEach(async () => { if (harness) await harness.cleanup(); });

  it('rejects unsupported methods with 405', async () => {
    harness = await makeHarness();
    const r = await requestTo(harness.port, { method: 'PUT' });
    expect(r.status).toBe(405);
  });

  it('rejects POST with non-json content-type as 415', async () => {
    harness = await makeHarness();
    const r = await requestTo(harness.port, {
      method: 'POST',
      path: '/llm.call',
      headers: { 'content-type': 'text/plain', 'authorization': `Bearer ${harness.token}` },
      body: 'hello',
    });
    expect(r.status).toBe(415);
  });

  it('rejects missing Authorization with 401', async () => {
    harness = await makeHarness();
    const r = await requestTo(harness.port, {
      method: 'POST',
      path: '/llm.call',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(401);
    // I9: token never echoes.
    expect(r.body).not.toContain('Bearer');
  });

  it('rejects bad bearer scheme with 401', async () => {
    harness = await makeHarness();
    const r = await requestTo(harness.port, {
      method: 'POST',
      path: '/llm.call',
      headers: { 'content-type': 'application/json', 'authorization': 'Basic dXNlcjpwYXNz' },
      body: '{}',
    });
    expect(r.status).toBe(401);
  });

  it('rejects unknown token with 401 and does not echo the token', async () => {
    harness = await makeHarness();
    const r = await requestTo(harness.port, {
      method: 'POST',
      path: '/llm.call',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer not-a-real-token-xyz' },
      body: '{}',
    });
    expect(r.status).toBe(401);
    expect(r.body).not.toContain('not-a-real-token-xyz');
  });

  it('returns 404 for unknown paths after auth', async () => {
    harness = await makeHarness();
    const r = await requestTo(harness.port, {
      method: 'POST',
      path: '/no-such-action',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${harness.token}` },
      body: '{}',
    });
    expect(r.status).toBe(404);
  });

  it('returns 200 from /healthz without auth', async () => {
    harness = await makeHarness();
    const r = await requestTo(harness.port, { method: 'GET', path: '/healthz' });
    expect(r.status).toBe(200);
  });

  it('returns 413 on oversized body (over MAX_FRAME)', async () => {
    harness = await makeHarness();
    const huge = 'x'.repeat(5 * 1024 * 1024); // 5 MiB > 4 MiB MAX_FRAME
    const r = await requestTo(harness.port, {
      method: 'POST',
      path: '/llm.call',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${harness.token}`,
        'content-length': String(huge.length),
      },
      body: huge,
    });
    expect(r.status).toBe(413);
  });

  it('returns 400 on malformed JSON', async () => {
    harness = await makeHarness();
    const r = await requestTo(harness.port, {
      method: 'POST',
      path: '/llm.call',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${harness.token}` },
      body: '{not json',
    });
    expect(r.status).toBe(400);
  });
});
```

**Step 3: Run the tests to verify they fail.**

```bash
pnpm test --filter @ax/ipc-http
```

Expected: FAIL — module `../listener.js` does not exist.

**Step 4: Implement `packages/ipc-http/src/listener.ts`:**

```ts
import * as http from 'node:http';
import { authenticate, dispatch, writeJsonError } from '@ax/ipc-core';
import { makeChatContext, type HookBus } from '@ax/core';

// ---------------------------------------------------------------------------
// HTTP listener — TCP analogue of @ax/ipc-server's unix-socket listener.
//
// Process-wide bind: one listener serves ALL sessions, unlike @ax/ipc-server
// which binds a per-session unix socket. The token's resolution to a
// sessionId IS the per-request session identification — there is no
// listener-owning session, so the cross-session gate from the unix listener
// is intentionally absent here. (A token belongs to exactly one session;
// resolving it gives us that session.)
//
// Five gates (in order):
//   1. Method      — only POST / GET. Other → 405.
//   2. /healthz    — handled before auth so a probe can succeed even when no
//                    sessions exist. Returns 200 unconditionally.
//   3. Content-Type — POST must carry application/json. Otherwise → 415.
//   4. Auth         — Authorization: Bearer <token>, resolved via
//                     session:resolve-token. Missing/malformed/unknown → 401.
//   5. Body size    — enforced by the dispatcher's body reader (MAX_FRAME).
//
// I12 idle-timeout (60s) matches the unix listener so 30s long-polls aren't
// killed by a future Node default change.
// ---------------------------------------------------------------------------

const IDLE_TIMEOUT_MS = 60_000;

export interface HttpListener {
  close(): Promise<void>;
  readonly host: string;
  readonly port: number;
}

export interface CreateHttpListenerOptions {
  host: string;
  /** Pass 0 to let the OS assign a free port; readback via `listener.port`. */
  port: number;
  bus: HookBus;
}

export async function createHttpListener(opts: CreateHttpListenerOptions): Promise<HttpListener> {
  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      try {
        if (!res.headersSent) {
          writeJsonError(res, 500, 'INTERNAL', 'internal server error');
        } else {
          res.end();
        }
      } catch {
        // Best-effort.
      }
      process.stderr.write(
        `ipc-http: unhandled handler error: ${(err as Error).message}\n`,
      );
    });
  });

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    // 1. method gate
    if (req.method !== 'POST' && req.method !== 'GET') {
      return writeJsonError(res, 405, 'VALIDATION', 'method not allowed');
    }

    // 2. /healthz pre-auth
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // 3. content-type gate (POST only)
    if (req.method === 'POST') {
      const ct = req.headers['content-type'] ?? '';
      if (!ct.toLowerCase().startsWith('application/json')) {
        return writeJsonError(res, 415, 'VALIDATION', 'content-type must be application/json');
      }
    }

    // 4. auth gate. Pre-auth ctx uses placeholder workspaceRoot; rebuild
    //    after auth with the resolved real value.
    const preAuthCtx = makeChatContext({
      sessionId: 'ipc-http-pre-auth',
      agentId: 'ipc-http',
      userId: 'ipc-http',
      workspace: { rootPath: '/' },
    });
    const auth = await authenticate(req.headers.authorization, opts.bus, preAuthCtx);
    if (!auth.ok) {
      return writeJsonError(res, auth.status, auth.body.error.code, auth.body.error.message);
    }

    // Per-request ctx with the authenticated sessionId + real workspaceRoot.
    const ctx = makeChatContext({
      sessionId: auth.sessionId,
      agentId: 'ipc-http',
      userId: 'ipc-http',
      workspace: { rootPath: auth.workspaceRoot },
    });
    await dispatch(req, res, ctx, opts.bus);
  };

  server.setTimeout(IDLE_TIMEOUT_MS);

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(opts.port, opts.host, () => {
      server.off('error', onError);
      resolve();
    });
  });

  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr !== null ? addr.port : opts.port;

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };

  return {
    get host() { return opts.host; },
    get port() { return boundPort; },
    close,
  };
}
```

**Step 5: Run the tests to verify they pass.**

```bash
pnpm test --filter @ax/ipc-http
```

Expected: PASS, all 9 cases.

**Step 6: Commit.**

```bash
git add -A
git commit -m "feat(ipc-http): TCP listener with five-gate inbound (method/healthz/ct/auth/body)"
```

---

### Task 8: `createIpcHttpPlugin` — wire the listener into the kernel

**Goal:** Binds at `init()`, no per-session lifecycle. Manifest declares the calls the dispatcher transitively makes (`session:resolve-token`, `session:claim-work`, `llm:call`, `tool:list`). Registers no service hooks.

**Files:**
- Create: `packages/ipc-http/src/plugin.ts`
- Create: `packages/ipc-http/src/__tests__/plugin.test.ts`
- Modify: `packages/ipc-http/src/index.ts`

**Step 1: Write the failing test** at `packages/ipc-http/src/__tests__/plugin.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createTestHarness } from '@ax/test-harness';
import { createSessionInmemoryPlugin } from '@ax/session-inmemory';
import { createIpcHttpPlugin } from '../plugin.js';

describe('createIpcHttpPlugin', () => {
  it('binds a listener at init() and serves /healthz', async () => {
    const port = await pickFreePort();
    const h = await createTestHarness({
      plugins: [
        createSessionInmemoryPlugin(),
        createIpcHttpPlugin({ host: '127.0.0.1', port }),
      ],
    });

    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);

    await h.shutdown(); // test-harness should expose a teardown hook; if not,
                        // the plugin needs an explicit close — see Step 3.
  });

  it('does not register service hooks (manifest.registers is empty)', async () => {
    const plugin = createIpcHttpPlugin({ host: '127.0.0.1', port: 0 });
    expect(plugin.manifest.registers).toEqual([]);
  });
});

async function pickFreePort(): Promise<number> {
  // tiny helper using net.createServer().listen(0) to grab a free port
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const addr = srv.address();
      srv.close(() => {
        if (typeof addr === 'object' && addr !== null) resolve(addr.port);
        else reject(new Error('failed to pick free port'));
      });
    });
  });
}
```

**Step 2: Check the test-harness contract.** Read `packages/test-harness/src/index.ts` to see what it returns. If it doesn't have a `shutdown` method, the plugin needs to expose its listener for tests to close (or we add a shutdown hook). Likely path: have `createIpcHttpPlugin` accept an optional ref param the test can use, OR have the plugin store the listener on a returned handle.

```bash
grep -n "shutdown\|close\|teardown" packages/test-harness/src/index.ts
```

If no teardown, the simplest fix: have the plugin expose a `closeListener()` method on the returned `Plugin` object (extending `Plugin`) for test use only. That's also useful when kernel-shutdown lifecycle (followup #3) lands.

**Step 3: Implement `packages/ipc-http/src/plugin.ts`:**

```ts
import type { Plugin } from '@ax/core';
import { createHttpListener, type HttpListener } from './listener.js';

const PLUGIN_NAME = '@ax/ipc-http';

// ---------------------------------------------------------------------------
// @ax/ipc-http plugin
//
// Process-wide TCP HTTP listener for runner→host IPC. Bound at init(); lives
// for the process lifetime. Replaces @ax/ipc-server in k8s-mode presets.
//
// Registers NO service hooks. The k8s sandbox provider does not call
// ipc:start/ipc:stop — listener lifecycle is process-scoped, not session-
// scoped. (A future kernel-shutdown lifecycle will close the listener
// cleanly on SIGTERM; until then, it dies with the process.)
//
// `calls` declares the hooks the dispatcher transitively invokes — the same
// set @ax/ipc-server lists, since both plugins share @ax/ipc-core's
// dispatcher. `tool:execute:<name>` is dynamically resolved at dispatch time
// (same exception @ax/ipc-server documents).
// ---------------------------------------------------------------------------

export interface CreateIpcHttpPluginOptions {
  host: string;
  port: number;
}

export interface IpcHttpPlugin extends Plugin {
  /** Test-only handle for explicit teardown. Production lifecycle is
   *  process-scoped; kernel-shutdown lifecycle (planned follow-up) will
   *  call this from the kernel side. */
  closeListener(): Promise<void>;
}

export function createIpcHttpPlugin(opts: CreateIpcHttpPluginOptions): IpcHttpPlugin {
  let listener: HttpListener | null = null;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [],
      calls: [
        'session:resolve-token',
        'session:claim-work',
        'llm:call',
        'tool:list',
      ],
      subscribes: [],
    },
    async init({ bus }) {
      listener = await createHttpListener({ host: opts.host, port: opts.port, bus });
      // Boot-time observability: print the bound address. Kernel doesn't
      // have a ready logger at init time (ChatContext is per-request); the
      // chart's manual-acceptance step greps for this line.
      process.stderr.write(
        `[ax/ipc-http] listening on http://${listener.host}:${listener.port}\n`,
      );
    },
    async closeListener() {
      if (listener !== null) await listener.close();
    },
  };
}
```

**Step 4: Re-export from `packages/ipc-http/src/index.ts`:**

```ts
export { createIpcHttpPlugin, type CreateIpcHttpPluginOptions, type IpcHttpPlugin } from './plugin.js';
export { createHttpListener, type HttpListener, type CreateHttpListenerOptions } from './listener.js';
```

**Step 5: Run the tests.** If the test-harness teardown is missing, adjust the test to call `(plugin as IpcHttpPlugin).closeListener()` directly via the harness's plugin list.

```bash
pnpm test --filter @ax/ipc-http
```

Expected: PASS.

**Step 6: Commit.**

```bash
git add -A
git commit -m "feat(ipc-http): plugin wires listener into kernel at init()"
```

---

### Task 9: `@ax/ipc-http/SECURITY.md`

**Goal:** The structured security note. This is the gate per `security-checklist`.

**Files:**
- Create: `packages/ipc-http/SECURITY.md`

**Step 1: Mirror the shape of `packages/ipc-server/SECURITY.md`** and adapt for the new capability. The three threat models from the security walk in this plan's preamble are the source — write them out concretely.

**Step 2: Required sections (matching `security-checklist`'s output contract):**

```
## Security review
- Sandbox: New plugin opens a TCP listener on configurable host:port (default 0.0.0.0:8080). Reach is bounded by Helm NetworkPolicy `host-network.yaml` (only runner-namespace pods + own-namespace pods can ingress). Bearer auth via `session:resolve-token` is the wall behind the perimeter; cross-session escalation is blocked by token uniqueness (256-bit base64url; resolution returns the bound sessionId).
- Injection: Request bodies are JSON, parsed under MAX_FRAME (4 MiB) cap. Each handler's Zod schema rejects shape drift before the body reaches plugin code. Errors never echo body content (writeJsonError emits a fixed safe message).
- Supply chain: No new external deps. Node built-in `node:http`. Workspace deps only: `@ax/core`, `@ax/ipc-core`, `@ax/ipc-protocol`. DevDeps match the rest of the workspace.
```

Plus a "Known limits" section noting:
- Plain HTTP within the cluster (no mTLS) — deferred follow-up; documented choice, not oversight.
- Kernel-shutdown lifecycle missing — listener lives until process exit; SIGTERM closes the TCP socket abruptly today. Follow-up #3 in `2026-04-25-week-7-9-followups.md`.
- Token resolution uses `Map.get(token)` lookup in `@ax/session-inmemory` and `session_token` table lookup in `@ax/session-postgres`; both are functionally constant-time given uniformly-distributed 256-bit tokens. Listener-level `crypto.timingSafeEqual` is not added on top because there is no second secret to compare against.

**Step 3: Commit.**

```bash
git add packages/ipc-http/SECURITY.md
git commit -m "docs(ipc-http): SECURITY.md (security-checklist output)"
```

---

### Task 10: Wire `@ax/ipc-http` into `@ax/preset-k8s`

**Goal:** k8s-mode preset now uses the HTTP listener instead of the unix-socket listener. Sandbox provider receives the host's cluster URL.

**Files:**
- Modify: `presets/k8s/package.json`
- Modify: `presets/k8s/src/index.ts`
- Modify: `presets/k8s/src/__tests__/preset.test.ts`

**Step 1: Add `@ax/ipc-http` as a dependency** in `presets/k8s/package.json`. Drop `@ax/ipc-server`.

**Step 2: Update `presets/k8s/src/index.ts`:**

a. Replace `import { createIpcServerPlugin } from '@ax/ipc-server';` with `import { createIpcHttpPlugin } from '@ax/ipc-http';`.

b. Extend `K8sPresetConfig` with:

```ts
ipc: {
  host?: string;       // default '0.0.0.0'
  port?: number;       // default 8080
  /** Cluster-internal URL the runner pods use to reach the host's IPC
   *  listener (e.g. http://ax-next-host.ax-next.svc.cluster.local:80).
   *  Required — there is no useful default; the right value comes from
   *  the chart's Service config. */
  hostIpcUrl: string;
};
```

c. Replace `plugins.push(createIpcServerPlugin());` with:

```ts
plugins.push(
  createIpcHttpPlugin({
    host: config.ipc.host ?? '0.0.0.0',
    port: config.ipc.port ?? 8080,
  }),
);
```

d. Pass `hostIpcUrl` into the sandbox-k8s plugin config:

```ts
plugins.push(createSandboxK8sPlugin({
  ...sandboxOpts,
  hostIpcUrl: config.ipc.hostIpcUrl,
}));
```

(This requires Task 11 to add `hostIpcUrl` to the sandbox-k8s config.)

**Step 3: Update `presets/k8s/src/__tests__/preset.test.ts`:**

The test asserts which service hooks the preset registers. Today it expects `@ax/ipc-server` registers `ipc:start`/`ipc:stop`. After this slice, the k8s preset doesn't register them at all (the HTTP plugin's manifest.registers is `[]`). Update the assertion list.

```bash
grep -n "ipc:start\|ipc:stop" presets/k8s/src/__tests__/preset.test.ts
```

Remove those entries from the expected-registers list.

**Step 4: Run preset tests** (one will fail until Task 11 lands `hostIpcUrl` in `@ax/sandbox-k8s`). If they fail with "missing hostIpcUrl" — that's expected; proceed to Task 11.

```bash
pnpm test --filter @ax/preset-k8s || true
```

**Step 5: Don't commit yet** — this task and Task 11 are coupled (preset references `hostIpcUrl`; sandbox-k8s defines it). Commit after Task 11.

---

### Task 11: `@ax/sandbox-k8s` — accept `hostIpcUrl` and stamp it on every pod

**Goal:** `runnerEndpoint` returned by `sandbox:open-session` is the configured host URL, not the runner pod's own IP. Pod spec drops `containerPort: 7777` and `RUNNER_PORT`.

**Files:**
- Modify: `packages/sandbox-k8s/src/config.ts`
- Modify: `packages/sandbox-k8s/src/open-session.ts`
- Modify: `packages/sandbox-k8s/src/pod-spec.ts`
- Modify: `packages/sandbox-k8s/src/__tests__/pod-spec.test.ts`
- Modify: `packages/sandbox-k8s/src/__tests__/open-session.test.ts`
- Modify: `packages/sandbox-k8s/SECURITY.md`

**Step 1: Read the existing config + pod-spec + open-session to internalize how `RUNNER_PORT` flows today.**

```bash
grep -n "RUNNER_PORT\|runnerEndpoint\|podIP\|pending://await-pod-ready" packages/sandbox-k8s/src/*.ts
```

**Step 2: Add `hostIpcUrl` to `config.ts`:**

```ts
export interface SandboxK8sConfig {
  // ... existing fields ...
  /** Cluster-internal URL the runner pods use to reach the host's IPC
   *  listener. Set by the preset from Helm chart values. Required. */
  hostIpcUrl: string;
}
```

Update `resolveConfig` so missing `hostIpcUrl` throws a `PluginError('invalid-config')` with a clear message: "k8s preset requires ipc.hostIpcUrl — set host.ipcUrl in your Helm values, or pass it via env (AX_K8S_HOST_IPC_URL)".

**Step 3: Update `pod-spec.ts`:**

a. Drop `export const RUNNER_PORT = 7777;`.
b. Drop the `ports: [{ containerPort: RUNNER_PORT, name: 'ipc' }]` entry from the container spec.
c. Drop the `pending://await-pod-ready` placeholder. Replace `BuildPodSpecInput` with a `runnerEndpoint: string` field; set the env entry to that value directly:

```ts
const env: EnvVar[] = [
  { name: 'AX_SESSION_ID', value: input.sessionId },
  { name: 'AX_AUTH_TOKEN', value: input.authToken },
  { name: 'AX_WORKSPACE_ROOT', value: input.workspaceRoot },
  { name: 'AX_RUNNER_BINARY', value: input.runnerBinary },
  { name: 'AX_RUNNER_ENDPOINT', value: input.runnerEndpoint },
  ...(input.requestId !== undefined
    ? [{ name: 'AX_REQUEST_ID', value: input.requestId }]
    : []),
  ...Object.entries(input.extraEnv ?? {}).map(([name, value]) => ({ name, value })),
];
```

d. Strip the lengthy "runnerEndpoint resolution" comment block at the top of the file — it's stale. Replace with two lines noting the runner is purely an IPC client; the URI it reaches comes from the host plugin's config.

**Step 4: Update `open-session.ts`:**

a. Drop `import { ..., RUNNER_PORT } from './pod-spec.js';` — no longer exported.
b. Drop the `const runnerEndpoint = \`http://${podIP}:${RUNNER_PORT}\`;` line near line 234.
c. Replace with `const runnerEndpoint = deps.config.hostIpcUrl;`.
d. Pass `runnerEndpoint` into `buildPodSpec`:

```ts
const podSpec = buildPodSpec(podName, {
  sessionId: created.sessionId,
  workspaceRoot: input.workspaceRoot,
  runnerBinary: input.runnerBinary,
  authToken: created.token,
  runnerEndpoint: deps.config.hostIpcUrl,
  requestId: ctx.reqId,
}, deps.config);
```

e. Strip the long comment block at lines 127–161 (downward-API/POD_IP/placeholder rewrite plan) — that whole approach is no longer needed. Two-line replacement: "runnerEndpoint is fixed at preset-config time and stamped onto every runner pod."

**Step 5: Update tests.**

`pod-spec.test.ts`: change assertions that look for `containerPort: 7777` or `pending://await-pod-ready`. New assertions:
- No `ports` field on the container.
- `AX_RUNNER_ENDPOINT` env equals the input `runnerEndpoint`.
- `RUNNER_PORT` is not exported (drop any `import { RUNNER_PORT }` test references — there should be none).

`open-session.test.ts`: change assertions that expect `runnerEndpoint = http://${mockedPodIP}:7777`. New: `runnerEndpoint === config.hostIpcUrl`. The mock K8sCoreApi can drop the bit where it pretends to return a pod IP — but waitForPodReady probably still needs one for its own internal reasons; check before deleting.

```bash
pnpm test --filter @ax/sandbox-k8s
```

Expected: green.

**Step 6: Update `packages/sandbox-k8s/SECURITY.md`:**

Drop the "HTTP transport not yet implemented" known-limit (around line 125). Replace with a short note that runner pods reach the host via the cluster Service URL set in `config.hostIpcUrl`; auth is bearer per request; mTLS is a documented future hardening.

**Step 7: Commit Tasks 10 and 11 together** (they're coupled — preset passes hostIpcUrl, sandbox-k8s consumes it).

```bash
git add -A
git commit -m "feat(sandbox-k8s,preset-k8s): wire host IPC URL into runner pods (drop RUNNER_PORT placeholder)"
```

---

### Task 12: Helm chart — pass the host's Service URL into the host pod

**Goal:** The host pod now knows the cluster-internal Service URL that runner pods use to reach it. Stamp it via env so `@ax/sandbox-k8s` (and the preset) can read it without hardcoding.

**Files:**
- Modify: `deploy/charts/ax-next/values.yaml`
- Modify: `deploy/charts/ax-next/templates/host/deployment.yaml`
- Modify: `deploy/charts/ax-next/templates/_helpers.tpl` (if it exists; or create the helper inline)

**Step 1: Inspect the existing chart to see how Service DNS is constructed.**

```bash
grep -n "svc.cluster.local\|ax-next-host\|ax-next.fullname\|hostNamespace" deploy/charts/ax-next/templates/ -r
```

**Step 2: Add a chart helper for the host IPC URL.** In `_helpers.tpl`:

```
{{- define "ax-next.hostIpcUrl" -}}
{{- printf "http://%s-host.%s.svc.cluster.local:%d" (include "ax-next.fullname" .) (include "ax-next.hostNamespace" .) (int .Values.host.ipcServicePort) -}}
{{- end -}}
```

Where `.Values.host.ipcServicePort` defaults to 80 (the Service's `port`, not the targetPort). Add to `values.yaml`:

```yaml
host:
  ports:
    http: 8080            # containerPort the host pod binds
  ipcServicePort: 80      # Service port runner pods connect to
  # ... rest unchanged ...
```

**Step 3: Update `templates/host/deployment.yaml`** to inject `AX_K8S_HOST_IPC_URL`:

```yaml
env:
  # ... existing entries ...
  - name: AX_K8S_HOST_IPC_URL
    value: {{ include "ax-next.hostIpcUrl" . | quote }}
```

The `@ax/preset-k8s` config builder reads this env var to populate `config.ipc.hostIpcUrl`. Sketch (lives in the cli `serve`-equivalent or wherever the k8s preset is constructed — TBD by where the host pod's entrypoint reads its config):

```ts
const hostIpcUrl = process.env.AX_K8S_HOST_IPC_URL;
if (typeof hostIpcUrl !== 'string' || hostIpcUrl.length === 0) {
  throw new Error('AX_K8S_HOST_IPC_URL must be set (Helm chart sets this for k8s-mode deploys)');
}
```

**Step 4: Verify with `helm template`** that the rendered Deployment carries the env var with the expected value.

```bash
cd deploy/charts/ax-next
helm template ax-next . --values values.yaml --values kind-dev-values.yaml | grep -A1 'AX_K8S_HOST_IPC_URL'
```

Expected: `value: "http://ax-next-host.ax-next.svc.cluster.local:80"` (or similar — exact name depends on `fullname` template).

**Step 5: Commit.**

```bash
git add deploy/charts/ax-next
git commit -m "feat(deploy): host IPC URL Helm helper + AX_K8S_HOST_IPC_URL env wiring"
```

---

### Task 13: Manual-acceptance + sandbox-k8s SECURITY.md final touches

**Goal:** Update the docs that flagged HTTP IPC as "not yet implemented" so future readers see the honest current state.

**Files:**
- Modify: `deploy/MANUAL-ACCEPTANCE.md`
- Modify: `packages/sandbox-k8s/SECURITY.md`

**Step 1: `deploy/MANUAL-ACCEPTANCE.md`.**

Drop the "HTTP runner-IPC is not yet implemented" gotcha (lines around 113–121). Replace with a verification step:

```markdown
- **HTTP runner-IPC.** After install, verify the host pod is binding the
  IPC listener:

  ```bash
  kubectl logs -n ax-next deploy/ax-next-host | grep ipc-http
  # expect: [ax/ipc-http] listening on http://0.0.0.0:8080
  ```

  Then verify a runner pod can reach it from inside the cluster. The
  simplest probe: launch a one-shot debug pod in the runner namespace:

  ```bash
  kubectl run debug --rm -it -n ax-next-runners \
    --image curlimages/curl --restart=Never -- \
    curl -sS http://ax-next-host.ax-next.svc.cluster.local/healthz
  # expect: {"ok":true}
  ```

  The end-to-end "chat returns a response" criterion requires a
  user-facing entry point on the host pod (separate follow-up) and a
  pre-built runner image (`Dockerfile.agent`, follow-up #4). With those
  in place, kubectl-exec into the host pod and run a one-shot CLI chat;
  the runner pod gets created, connects back over HTTP, and returns.
```

**Step 2: `packages/sandbox-k8s/SECURITY.md`.** Confirm Task 11 already removed the "HTTP transport not yet implemented" known-limit. If not, drop it now and replace with the short note about the host URL flow.

**Step 3: Commit.**

```bash
git add deploy/MANUAL-ACCEPTANCE.md packages/sandbox-k8s/SECURITY.md
git commit -m "docs: HTTP runner-IPC is now wired (manual acceptance + sandbox-k8s SECURITY notes)"
```

---

### Task 14: Final verification

**Goal:** Everything is green. No partial commits left.

**Step 1: Full test run.**

```bash
pnpm test
```

Expected: every package green. If `@ax/preset-k8s` acceptance test (`acceptance.test.ts`) is testcontainers-based and slow, it may need to be run separately or is gated by a CI env var — check the file's top-of-test conditions.

**Step 2: Lint.**

```bash
pnpm lint
```

Expected: no `no-restricted-imports` violations. Verify specifically that `@ax/ipc-http` only imports from `@ax/core`, `@ax/ipc-core`, `@ax/ipc-protocol`.

```bash
grep -rE "^import .* from ['\"]@ax/" packages/ipc-http/src/
```

**Step 3: Build.**

```bash
pnpm build
```

Expected: green.

**Step 4: Helm template check.**

```bash
cd deploy/charts/ax-next
helm template ax-next . --values values.yaml --values kind-dev-values.yaml > /tmp/rendered.yaml
grep "AX_K8S_HOST_IPC_URL" /tmp/rendered.yaml
```

Expected: env var present with expected URL.

**Step 5: Changeset.** Add a changeset entry under `.changeset/`:

```bash
cat > .changeset/http-runner-ipc.md <<'EOF'
---
"@ax/ipc-core": minor
"@ax/ipc-http": minor
"@ax/ipc-server": patch
"@ax/ipc-protocol": minor
"@ax/agent-runner-core": patch
"@ax/sandbox-k8s": patch
"@ax/preset-k8s": minor
---

HTTP runner-IPC is now wired end-to-end. `@ax/ipc-core` extracted from
`@ax/ipc-server` (transport-agnostic dispatcher, auth, body, response,
errors, handlers). `@ax/ipc-http` is the new TCP listener that mirrors
`@ax/ipc-server` for the k8s-mode preset. The runner-side IPC client now
supports `http://` end-to-end. `parseRunnerEndpoint` lives in
`@ax/ipc-protocol` (single source of truth for the URI grammar).
`@ax/sandbox-k8s` returns the host's cluster Service URL as the runner
endpoint; runner pods no longer have a `containerPort: 7777`.
EOF
```

**Step 6: Commit changeset.**

```bash
git add .changeset/http-runner-ipc.md
git commit -m "chore: changeset for http-runner-ipc"
```

**Step 7: PR description.** Open the PR with the security review block from this plan's preamble. Include:

```markdown
## Security review
- Sandbox: New TCP listener at host:port (default 0.0.0.0:8080). Bounded by Helm NetworkPolicy `host-network.yaml` (runner-namespace + own-namespace ingress only) + bearer auth via session:resolve-token. Token resolution is functionally constant-time (256-bit base64url uniformly distributed). Cross-session escalation blocked by token uniqueness.
- Injection: Request bodies parsed under MAX_FRAME (4 MiB). Each handler's Zod schema rejects shape drift before plugin code runs. Errors never echo body content.
- Supply chain: No new external deps. Node built-in `node:http`. Workspace deps only.
```

Plus a boundary-review section noting `@ax/ipc-http` registers no new service hooks (no boundary review needed for hook surface).

---

## Notes for the executing subagent

**TDD discipline:** every task starts with a failing test. Before writing implementation code, run the test and confirm it fails for the right reason. Reference `superpowers:test-driven-development`.

**Verification before completion:** at the end of each task, run the test command in the task. Don't claim a task is done until you've seen the green output. Reference `superpowers:verification-before-completion`.

**Frequent commits:** each task ends with one commit (or two — Tasks 10 & 11 commit together). Don't batch. The history itself is part of the deliverable; reviewers read it.

**No half-wired code (`CLAUDE.md` policy):** if a task adds infrastructure that isn't reachable from the running system at the end of THAT task, it doesn't merge. The task list is structured so every task ends in a green state.

**No cross-plugin imports beyond manifest:** `@ax/ipc-http` may only import from `@ax/core`, `@ax/ipc-core`, `@ax/ipc-protocol`. Lint will catch violations.

**Skip / N/A is mandatory in security note:** if a section turns up genuinely "no change", say so with a reason — bare "N/A" fails the checklist (per `security-checklist`).

**If you discover the plan is wrong:** flag it, don't paper over. The user explicitly asked for plan-vs-reality verification (memory: `feedback_check_plan_vs_reality.md`).
