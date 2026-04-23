---
name: ax-conventions
description: Use when writing or modifying any AX plugin or hook — covers the four invariants (transport/storage-agnostic hooks, no cross-plugin imports, no half-wired plugins, one source of truth), the plugin manifest format, hook bus mechanics, the boundary review checklist, and common patterns
---

# AX conventions

The architecture spec is `docs/plans/2026-04-22-plugin-architecture-design.md` — read that for rationale. This skill is the operational summary: the rules, the shapes, the patterns.

---

## The four invariants

### 1. Hook surface is transport-agnostic and storage-agnostic

No git/sqlite/k8s/postgres/gcs vocabulary in hook payloads. If a payload field name only makes sense for one backend, it leaks.

**Bad:**

```ts
'workspace:commit' (ctx, { sha, branch, bundle, parentSha }) → { newSha }
```

Every field leaks git semantics. A GCS backend couldn't implement this.

**Good:**

```ts
'workspace:apply' (ctx, { changes, parent, reason }) → { version, delta }
```

`version` and `parent` are opaque `WorkspaceVersion` tokens. Git makes them SHAs; GCS makes them manifest object names. Neither leaks.

### 2. No cross-plugin imports

Plugins talk through the hook bus only. Enforced by `eslint.config.mjs`.

**Bad:**

```ts
// in packages/sandbox-k8s/src/index.ts
import { writeCredential } from '@ax/credentials';
await writeCredential(name, value);
```

**Good:**

```ts
await hooks.call('credentials:write', ctx, { name, value });
```

The only `@ax/*` imports allowed inside plugin code are `@ax/core` (kernel, everyone depends on it) and `@ax/test-harness` (test-only). The CLI and presets are exempt — they legitimately wire plugins together.

### 3. No half-wired plugins

A plugin is either fully registered + tested + reachable from the canary acceptance test, or it doesn't merge. No "wire this up later" PRs.

Why: v1 accumulated half-wired traps (NATS bridge not called, k8s-pod sandbox incompatible with all-in-one server). They confused readers, drifted from the rest of the system, and represented work that looked done but wasn't.

### 4. One source of truth per concept

If two plugins both hold state about the same thing (skills, tools, sessions, sandbox pods), one of them is wrong. Coordinate through service hooks, not shared rows.

**Bad:** `sandbox-k8s` tracks pods in-memory AND `storage-postgres` has a `sandbox_pods` table, both updated separately. They will drift.

**Good:** `sandbox-k8s` owns the concept and exposes `sandbox:lookup(id)`. If it needs durability, it calls `storage:set` — the table is an implementation detail, not a shared resource.

Corollary: **no foreign keys across plugin boundaries.** Each plugin's schema evolves independently.

---

## Plugin manifest format

Each plugin's `package.json` has an `ax` field:

```json
{
  "name": "@ax/sandbox-k8s",
  "version": "0.1.0",
  "peerDependencies": {
    "@ax/core": "^1.0.0"
  },
  "ax": {
    "registers": ["sandbox:spawn", "sandbox:kill"],
    "calls":     ["storage:get", "storage:set", "audit:write"],
    "configSchema": "./schema.json"
  }
}
```

- **`registers`** — service hooks this plugin implements. Exactly one plugin may register each service hook; collision is a boot-time error.
- **`calls`** — service hooks this plugin depends on. Core uses this for (a) cycle detection at boot, (b) failing fast on missing services, (c) generating a compatibility matrix.
- **`configSchema`** — JSON schema for config the plugin accepts. Plugins receive config at construction, not via a runtime hook.

**Subscriber hooks are NOT declared here.** Subscribing doesn't create a dependency — a plugin can subscribe to anything without requiring it to exist.

---

## Hook bus mechanics

Two primitives, deliberately distinct.

### `hooks.call(service, ctx, payload) → result` — service hooks

- Exactly one registered implementation (boot-time error otherwise).
- Returns the implementation's response.
- Return shape is Zod-validated; mismatches become `PluginError`.
- Each service hook has a timeout (configurable per hook). Exceeded = `PluginError`.
- If the impl throws, the caller decides how to handle — retry (`llm:call`), translate to tool error (`tool:execute`), propagate (`storage:get`).

### `hooks.fire(event, ctx, payload) → modified` — subscriber hooks

- Many subscribers, called in registration order.
- Each subscriber returns modified payload, passes through unchanged, or calls `reject({ reason })`.
- **Rejection short-circuits** with a structured `PluginError` — core lifts to `chat_terminated`.
- **Throws are isolated** — caught + logged as `hook_subscriber_failed` (plugin name + hook + error) + chat continues. One bad subscriber never tanks the host.

### Choosing between them

| Shape | Use service hook | Use subscriber hook |
|---|---|---|
| "I'm THE one who does this" | ✓ | |
| "I want to observe / intercept" | | ✓ |
| Exactly one answer | ✓ | |
| Multiple participants | | ✓ |
| Return value is the point | ✓ | |
| Side effects / transforms | | ✓ |

Trying to unify them produces awkward APIs (e.g., picking one subscriber's return value as canonical). Keep them distinct.

---

## Boundary review checklist

Required when adding/changing a service-hook signature, or adding a subscriber hook with a non-trivial payload. Five minutes per review; the cost of a leaked abstraction that grows subscribers is much higher.

### 1. Alternate impl this hook could have?

Good answer: `workspace:apply` — git backend today, GCS backend tomorrow. Two concrete impls with known differences.

Bad answer: "I guess we could have... a different version of this?" If you can't name a concrete second impl, the abstraction is probably premature. Just write a function inside one plugin. Promote to a hook when the second impl actually shows up.

### 2. Payload field names that might leak

Red flags by backend:

| Backend | Leaky names |
|---|---|
| Git | `sha`, `branch`, `bundle`, `ref`, `commit`, `tree`, `parentSha` |
| Postgres | `generation`, `oid`, `nextval`, `lsn` |
| GCS / S3 | `bucket`, `generation`, `etag`, `objectName` |
| Kubernetes | `pod_name`, `namespace`, `resourceVersion` |
| Filesystem | `path` (when the concept is a version, not a location) |
| IPC | `socket_path`, `url`, `port` |

Rename to the generic concept: `parentSha` → `parent`, `sha` → `version` (brand as opaque), `bucket` → don't expose it at all.

### 3. Subscriber risk

Could a subscriber parse `version` as a SHA and call `git cat-file`? If yes, your "opaque token" isn't opaque in practice. The contract must be: **subscribers treat version tokens as opaque — pass them back to service hooks, never parse.**

Document it on the type:

```ts
/** Opaque token. Pass to workspace hooks; never parse. */
type WorkspaceVersion = string & { __brand: 'WorkspaceVersion' };
```

### 4. Wire surface

If this hook is also an IPC action (agent → host), the Zod schema lives in your plugin's directory — **not** a central `ipc-schemas.ts`. Each plugin owns its slice of the wire surface. Core's IPC dispatcher loads schemas from registered plugins.

The wire surface is intentionally smaller than the in-process hook surface: only "public" service hooks get an IPC action. Internal subscriber hooks (`chat:start`, `llm:pre-call`) stay in-process. Agent doesn't inject middleware into host's chat loop.

---

## Common patterns

### Opaque version tokens

```ts
type WorkspaceVersion = string & { __brand: 'WorkspaceVersion' };
```

Branded types keep callers from accidentally passing random strings. Implementations mint values however they want (SHA, manifest name, UUID).

### Lazy content fetchers in deltas

```ts
type WorkspaceDelta = {
  before: WorkspaceVersion | null;
  after: WorkspaceVersion;
  changes: Array<{
    path: string;
    kind: 'added' | 'modified' | 'deleted';
    contentBefore?: () => Promise<Bytes>;  // lazy
    contentAfter?:  () => Promise<Bytes>;
  }>;
};
```

Many subscribers only need metadata (what paths changed). A few need bytes (secret scanner, skill indexer). Forcing eager fetches makes everyone pay full cost regardless of who's listening.

### Optimistic concurrency via `parent`

```ts
'workspace:apply' (ctx, { changes, parent, reason }) → { version, delta }
```

Caller passes the version they thought they were changing. Backend CAS-updates against it. Conflict = structured error; caller fetches latest + retries. Git uses `update-ref` with expected-old-sha; GCS uses `ifGenerationMatch`. Hook surface doesn't know or care.

### Two-phase validation: pre-apply + applied

```ts
'workspace:pre-apply' (ctx, { changes, parent, reason }) → modified | reject
'workspace:applied'   (ctx, delta)
```

`pre-apply` is for veto (secret scanner rejects secrets before storage). `applied` is for react-after (skill indexer, audit, search). Two hooks because "veto before it lands" is a genuinely different need from "observe what landed."

### Config at construction, not at runtime

Plugins receive config when `createPlugin(config)` runs. No runtime-config hook. Implications:

- Config changes require a restart (hot-reload is explicitly out of scope).
- Each plugin's config schema is local — no central config file that knows about every plugin.

### Every plugin's `init()` runs after all service hooks register

Core guarantees: every `registers` entry is wired before any `init()` fires. Plugins can call each other's service hooks from `init()` safely. No DI container needed — the hook bus IS the inter-plugin API.

### Cycle detection is at boot

Core dry-runs declared dependencies from manifests. If `A.calls = ['B:foo']` and `B.calls = ['A:bar']`, boot fails with a clear error naming both plugins. Subscribers don't count — only service calls form cycles.

---

## Failure modes to design for

| Failure | Mechanism |
|---|---|
| Subscriber throws | Caught by bus, logged, chat continues. |
| Service impl throws | Propagates as structured `PluginError`. Caller decides. |
| Service impl wrong return shape | Zod catches, `PluginError`. |
| Plugin hangs | Per-hook timeout, `PluginError`. |
| Plugin init fails at boot | Fail fast — refuse to start, name the plugin. |
| Cycle detected | Fail fast — name both plugins. |
| Missing service hook | Fail fast — "plugin X declares `calls: ['Y:z']` but no plugin registers it." |
| Two plugins register same service | Fail fast — config must pick one. |

**Pattern:** boot-time failures are loud and prevent startup; runtime failures degrade gracefully with structured errors. The hook bus is the enforcement point — every cross-plugin interaction goes through it.
