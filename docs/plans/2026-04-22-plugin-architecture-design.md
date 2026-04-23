# AX v2 — Plugin Architecture Design

**Status:** Validated brainstorm, ready to build
**Date:** 2026-04-22
**Branch:** `feat/chat-observability` (legacy reference); v2 ships in a new monorepo

---

## TL;DR

AX v2 is a greenfield rewrite of AX motivated by **component robustness in isolation** — every piece should be developable, testable, and debuggable without booting the whole system. The current ~20k-LOC host monolith (where `server-completions.ts` alone is 2,400 lines) couples chat orchestration to every concern that touches it, which is why chat reliability, observability, and component boundaries have all been hard.

The shape, in five bullets:

- A tiny **kernel** (~1,600 LOC, ~92% smaller than today's host) owns only the things every plugin assumes exist: bootstrap, hook bus, chat loop skeleton, identity primitives, IPC primitives.
- A **hook bus** with two flavors: **service hooks** (exactly one plugin produces the result — DI-shaped) and **subscriber hooks** (many plugins observe / transform / veto — middleware-shaped).
- **Everything else is a plugin** — sandbox impls, LLM providers, memory, storage, scheduler, eventbus, channels, audit, scanners, workspace, prompt builder, multi-model routing, diagnostic collector, even chat-event logging. Plugins talk to each other only through the hook bus.
- **Deployment shapes fall out of plugin selection.** Docker mode and k8s mode differ only in which plugins are loaded for the same hooks. The chat loop has no idea which is running.
- **Monorepo, independent semver per plugin** (pnpm + changesets + tsconfig refs). Greenfield — current AX repo becomes a reference implementation we read for edge cases, not a base we mutate.

The doc below expands each piece. Section ordering mirrors how decisions stack: boundaries first, then the bus, then the loop, then the consequences (deployment, IPC, DB, channels), then the practical concerns (testing, packaging, build order).

---

## Section 1 — Core boundaries

The core ("kernel") is the smallest set of things that "every plugin assumes exists." It can't itself be plugins, because plugins assume it. Five things, ~1,600 LOC total:

1. **Bootstrap** (~300 LOC) — load config, discover and load plugins, wire lifecycle (init / start / stop), surface boot-time errors loudly.
2. **Hook bus** (~200 LOC) — register / fire / dispatch hooks. Two flavors (Section 2).
3. **Chat completion loop** (~500 LOC) — the orchestration skeleton. Everything interesting happens via hook fires (Section 3).
4. **Identity / context primitives** (~200 LOC) — `reqId`, `sessionId`, structured logger (already bound with `reqId`), structured `PluginError` type, per-request `ChatContext`.
5. **IPC primitives** (~400 LOC) — length-prefixed framing, Zod schema validation, sandbox-side IPC client. NOT sandbox spawning (that's a plugin) — just the wire protocol.

Compared to today's ~20k LOC of host code, this is roughly a 92% reduction in trusted-core surface.

Explicitly **NOT** in core (all become plugins):

- sandbox implementations (subprocess, docker, k8s, seatbelt)
- LLM providers (anthropic, openai, router, traced wrapper, mock)
- memory (cortex)
- storage (sqlite, postgres, conversations, credentials, etc.)
- scheduler
- eventbus (in-process, postgres LISTEN/NOTIFY)
- channels (slack, web chat UI, ink)
- audit
- credentials
- web proxy
- scanners (canary, output sanitizer)
- skills validation
- workspace (git, gcs, content-addressed stores — see Section 4.5 for the contract)
- prompt builder
- multi-model routing
- catalog
- diagnostic collector
- chat termination tracker

Anything on that list that today lives in `src/host/` is a candidate for excision — not by porting the host code, but by re-implementing as a plugin against the new hook surface.

---

## Section 2 — Two flavors of hook

The hook bus distinguishes two shapes. Confusing them produces incoherent designs, so they get distinct registration / dispatch primitives.

### Service hooks — exactly one producer

Like dependency injection. Examples:

- `llm:call(request) → response`
- `sandbox:spawn(config) → SandboxHandle`
- `memory:recall(query) → matches`
- `storage:get(key) → value`

Core picks the registered service plugin (config-driven, like AX's current static `provider-map.ts`) and calls it. **Two plugins registering for the same service is a config error caught at load time.**

### Subscriber hooks — many observers / transformers

Called in order. Each subscriber sees the payload and can return a modified payload, pass it through, or `reject({ reason })`. Examples:

- `chat:start(ctx)` — observers (audit log, metrics)
- `tool:pre-call(name, input) → modified-input | reject` — middleware (security scanner can veto a `bash` call; canary injector can rewrite input)
- `tool:post-call(name, input, output) → modified-output` — middleware (output scanner, taint tagger)
- `llm:pre-call(request) → modified-request` — middleware (history compactor, system prompt injector)
- `llm:post-call(request, response) → modified-response` — middleware (response sanitizer)
- `chat:end(ctx, outcome)` — observers (chat_complete logger, cost meter)
- `workspace:pre-apply(ctx, { changes, parent, reason }) → modified | reject` — middleware (secret scanner vetoes secrets before they reach storage)
- `workspace:applied(ctx, delta)` — observers (skill validator runs, indexer updates, audit log) — see Section 4.5
- `sandbox:exit(sandboxId, reason)` — observers (cleanup, lifecycle audit)

**Rejection short-circuits with a structured failure that core surfaces as `chat_terminated`.** Observers that throw are isolated (caught + logged at error level + chat continues — never take down the host).

### Why two flavors

The natural shape differs. Service = "I'm THE one who does this." Subscriber = "I want to react / intercept." Trying to unify them produces awkward APIs (e.g., having to pick one subscriber's return value as canonical). Distinct primitives keep both shapes clean.

---

## Section 3 — The core chat loop

The orchestration skeleton in core. It's meant to be read end-to-end:

```typescript
async function runChat(ctx: ChatContext, message: Message): Promise<ChatOutcome> {
  await hooks.fire('chat:start', ctx, message);
  try {
    let messages = [message];
    while (true) {
      const llmRequest = await hooks.fire('llm:pre-call', ctx, { messages, tools: ctx.tools });
      let response = await hooks.call('llm:call', ctx, llmRequest);
      response = await hooks.fire('llm:post-call', ctx, llmRequest, response);

      messages.push(response.assistantMessage);
      if (response.toolCalls.length === 0) break;

      for (const toolCall of response.toolCalls) {
        const input = await hooks.fire('tool:pre-call', ctx, toolCall);
        if (input.rejected) { messages.push(rejectionMessage(input)); continue; }
        let output = await hooks.call('tool:execute', ctx, input);
        output = await hooks.fire('tool:post-call', ctx, input, output);
        messages.push(toolResult(toolCall, output));
      }
    }
    const outcome: ChatOutcome = { kind: 'complete', messages };
    await hooks.fire('chat:end', ctx, outcome);
    return outcome;
  } catch (err) {
    const outcome: ChatOutcome = { kind: 'terminated', reason: classify(err), error: err };
    await hooks.fire('chat:end', ctx, outcome);
    return outcome;
  }
}
```

Roughly 50 lines. Compare to today's 2,400-line `server-completions.ts`.

What's no longer in this loop (now plugins):

- **Skills validation** — subscribed to `workspace:applied`, runs out-of-band.
- **Memory recall** — `llm:pre-call` subscriber injects memory into messages.
- **History compaction** — `llm:pre-call` subscriber.
- **Scanner / canary injection** — `tool:pre-call` and `tool:post-call` subscribers.
- **Diagnostic collector** — `chat:start` creates a per-request collector; hooks push into it.
- **`chat_complete` / `chat_terminated` events** — `chat:end` subscriber.
- **Sandbox spawn** — `tool:execute` for tools that need it, OR `chat:start` subscriber if one sandbox per chat.

### ChatContext

Carries: `reqId`, `sessionId`, `agentId`, `userId`, `tools` (catalog), `logger` (already bound with `reqId`), and a tiny `state` map plugins can use for per-chat state. **Nothing else** — no provider references, no config. Plugins that need config get it at construction time.

---

## Section 4 — Deployment shapes via plugin selection

Every difference between docker-mode and k8s-mode falls out as a different service plugin loaded for the same hook. **The core chat loop never knows which is running.**

| Hook | docker mode | k8s mode |
|---|---|---|
| `sandbox:spawn` | sandbox-docker | sandbox-k8s |
| `ipc:transport` | ipc-unix-socket | ipc-http |
| `workspace:provision` | workspace-local-git | workspace-git-http (talks to ax-git pod) |
| `storage:get` / `set` | storage-sqlite | storage-postgres |
| `eventbus:emit` / `subscribe` | eventbus-inprocess | eventbus-postgres (LISTEN/NOTIFY) |
| `session:lookup` / `store` | session-inmemory | session-postgres |
| `audit:write` | audit-sqlite | audit-postgres |

A "profile" is just a set of plugins. Today's `config.providers` already does this for some categories; the new design pushes it all the way down. `ax-values.yaml` becomes essentially: "load these plugins, configure them like so." No code change to switch deployment shapes.

The multi-replica concern is fully absorbed because every "where does this state live" question routes through a service plugin: N replicas can run concurrently because they all read / write through `storage-postgres` and coordinate via `eventbus-postgres`. Core has no in-memory cross-request state. Session affinity (which replica owns SSE stream X?) is the session plugin's responsibility.

### CRITICAL CONSTRAINT

**The hook surface MUST be transport-agnostic.** The moment a hook payload includes a Unix socket path or HTTP URL, the abstraction has leaked. `sandbox:spawn(config) → SandboxHandle` — `SandboxHandle` exposes `send(msg)` / `recv()` / `kill()`. The k8s impl wraps HTTP; the docker impl wraps a Unix socket. Core sees neither.

### Plugin-to-plugin dependencies

E.g., k8s sandbox writes pod metadata to storage. Plugins call other service hooks directly — `storage.set('sandbox-pods', ...)`. **No DI container.** Core only guarantees: every plugin's `init()` runs after all service hooks are registered.

### The git-server case

Stays as a separate container; the `workspace-git` plugin (in HTTP mode) just talks to it. The "plugin" is the client talking to it, not the server itself. Out-of-process services not on the hot path don't need to be plugins; they're just dependencies the right plugin client knows how to reach.

---

## Section 4.5 — Workspace abstraction

The workspace contract has to outlive its first backend. Today we'd build it for git; tomorrow we'd want GCS, S3, or a content-addressed object store. The hook surface MUST not leak any of git's vocabulary (sha, branch, bundle, ref, commit) — same rule as Section 4's transport-agnostic constraint, applied to storage.

This matters for security: skill validation, secret scanning, and audit are all delta-driven. If the delta shape leaks git semantics, every scanner becomes a coupled rewrite when a non-git backend shows up. Get the surface right at Week 1; ship `@ax/workspace-gcs` as a Week-13 additive plugin with no subscriber changing.

### The primitive: opaque versions over snapshots

`WorkspaceVersion` is an opaque token. Subscribers never parse it; they pass it back to workspace hooks. Git impl makes it a commit SHA; GCS impl makes it a manifest object name. Neither leaks.

A "workspace state" is a snapshot — the full set of `path → content` at a point in time. Deltas between snapshots are derived. This is the GCS-natural shape; git can always derive it (`git ls-tree` + `git diff-tree`). The reverse — building snapshots out of commits in a GCS impl — would require GCS to invent commit semantics it doesn't have.

### Service hooks (workspace plugin registers exactly one impl)

```typescript
type WorkspaceVersion = string & { __brand: 'WorkspaceVersion' };

type FileChange =
  | { path: string; kind: 'put'; content: Bytes }
  | { path: string; kind: 'delete' };

'workspace:apply' (ctx, { changes, parent, reason }) → { version, delta }
'workspace:read'  (ctx, { path, version? })          → Bytes
'workspace:list'  (ctx, { version?, pathGlob? })     → string[]
'workspace:diff'  (ctx, { from, to })                → WorkspaceDelta
```

`parent` is the version the caller thought it was changing. Conflict → structured error; caller retries with the new latest. Git maps this to `update-ref` with expected-old-sha; GCS maps it to manifest write with `ifGenerationMatch`.

### The delta — what scanners and skill validators consume

```typescript
type WorkspaceDelta = {
  before: WorkspaceVersion | null;     // null = initial state
  after: WorkspaceVersion;
  reason?: string;                     // agent-supplied at apply time
  author?: { agentId, userId, sessionId };
  changes: Array<{
    path: string;
    kind: 'added' | 'modified' | 'deleted';
    contentBefore?: () => Promise<Bytes>;   // lazy — fetched on demand
    contentAfter?:  () => Promise<Bytes>;
  }>;
};
```

Lazy content fetchers matter: skill validation only needs `contentAfter` for paths matching `.claude/skills/**/SKILL.md`; canary scanner needs it for everything; an indexer might want neither. Forcing eager bytes makes every workspace change pay full cost regardless of who's listening.

### Subscriber hooks

```typescript
'workspace:pre-apply' (ctx, { changes, parent, reason }) → modified | reject
'workspace:applied'   (ctx, delta)
```

Two hooks, not one, because the security need is veto-before-storage:

- **pre-apply:** secret scanner inspects `changes[].content` and rejects (`"AWS key in src/foo.ts"`) before anything lands. This is the abstraction being *stronger* than git — you can't veto a git commit without rewriting history; you can veto a workspace apply.
- **applied:** the post-fact event. Skills validator regenerates manifest for changed `.claude/skills/**`; indexer updates search; audit logs the delta. Replaces today's git:commit-shaped event.

### What's intentionally absent from the surface

- No SHA, commit, bundle, branch, ref, parent-array (merges), or working-tree-vs-committed distinction.
- No transport-format payloads (git bundles, GCS resumable upload tokens).
- No `reason` semantics beyond "agent-supplied string." Subscribers MUST NOT assume git-quality commit messages — GCS impls might pass `"agent applied 3 changes"` and that's correct.

If a future hook signature wants to expose any of these, that's a leak — flag it in review.

### Backend implementation contracts

**`@ax/workspace-git`:**
- `apply` → write blobs, build tree, create commit with parent, atomic ref update.
- `read` → `git show <version>:<path>`.
- `diff` → `git diff-tree <from> <to>` mapped to `FileChange[]`.
- `WorkspaceVersion` is the commit SHA.

**`@ax/workspace-gcs`:**
- `apply` → write each blob to `bucket/objects/<contenthash>`; write manifest `bucket/manifests/<uuid>` mapping path→contenthash; CAS-update `bucket/HEAD` with `ifGenerationMatch=<parent generation>`.
- `read` → fetch manifest, look up path, read blob.
- `diff` → set-diff two manifests' path→hash maps.
- `WorkspaceVersion` is the manifest object name.

The manifest-object pattern is the GCS-side cost of buying atomic snapshots — call it out in the GCS plugin's README so future maintainers don't try to skip it and reintroduce torn writes.

### Subscriber code is identical across backends

```typescript
hooks.subscribe('workspace:pre-apply', async (ctx, payload) => {
  for (const change of payload.changes) {
    if (change.kind === 'put' && containsSecret(change.content)) {
      return reject({ reason: `secret detected in ${change.path}` });
    }
  }
});

hooks.subscribe('workspace:applied', async (ctx, delta) => {
  const skillChanges = delta.changes.filter(c =>
    c.path.startsWith('.claude/skills/') && c.path.endsWith('SKILL.md'));
  for (const c of skillChanges) {
    if (c.contentAfter) await reindexSkill(c.path, await c.contentAfter());
  }
});
```

Neither subscriber knows or cares whether the backend is git or GCS. That's the whole game.

---

## Section 5 — Agent → host RPCs and plugin-to-plugin calls

Wire protocol stays `{action: string, ...payload}` over Unix socket or HTTP. IPC primitives (in core) handle framing + Zod validation. The new piece: **each IPC action maps 1:1 to a service hook on the host.**

```
Agent: client.call('workspace:apply', { changes, parent, reason })
  ↓ IPC wire
Host IPC handler: fires 'workspace:pre-apply' (scanners may veto)
  ↓ if not vetoed, dispatches to:
workspace-git plugin: writes blobs, atomic ref update, returns { version, delta }
  ↓ subscriber hooks fire
hooks.fire('workspace:applied', ctx, delta)
  → audit, skill validator, indexer all observe
```

Same hook whether triggered by agent (over IPC) or by core (in-process). Plugin doesn't know who called it.

### Two important constraints

1. **Wire surface is intentionally smaller than in-process hook surface.** Only "public" service hooks get an IPC action — workspace, llm, tool, memory, scan. Internal subscriber hooks (`chat:start`, `llm:pre-call`) stay in-process. Agent doesn't get to inject middleware into host's chat loop. Keeps the trust boundary tight.

2. **IPC schema lives with the hook.** Each plugin that registers a public service hook also exports its IPC schema. Core's IPC dispatcher loads schemas from registered plugins. **No giant central `ipc-schemas.ts`** — each plugin owns its slice.

### Plugin → plugin (in-process, same host)

Plugins call other service hooks directly via `await hooks.call('storage:set', ...)`. **The hook bus IS the inter-plugin API.** No DI container. No separate "core API object." Plugin imports the hook bus type, calls hooks like core does.

### Cycle detection

Concern: circular service calls (X → storage → audit → storage → ...). At startup, core dry-runs each plugin's declared dependencies (manifest lists which service hooks it `calls`) and refuses to start if there's a cycle. Subscribers don't count.

### Sandbox-side plugins

A separate population — loaded into the agent process, not the host. Agent has its own (much smaller) hook bus for sandbox-internal hooks (e.g., `tool:local-execute` for sandbox-local tools like file I/O without RPCing back to host). Most agent-side work is just calling host RPCs, so the sandbox-side bus is tiny.

---

## Section 6 — Database portability (SQLite ↔ Postgres)

Three layers:

1. **`database` plugin** — exactly one of `database-sqlite` or `database-postgres`. Owns connection pool + dialect config. Exposes `database:get-instance` → returns a Kysely instance scoped to that dialect.

2. **Store plugins** — one per domain (`storage-conversations`, `storage-credentials`, `storage-skill-state`, `storage-job-queue`). Each owns its tables + migrations. At `init()` it calls `database:get-instance`, runs its own migrations, and exposes domain-shaped service hooks. Only writes Kysely queries, never raw SQL — dialect translation automatic.

3. **Consumer plugins** call domain hooks. Don't know if bytes land in SQLite or Postgres.

### The hard rule

**Per-plugin migrations means stores don't share tables. A plugin only writes / reads its own tables.** Cross-plugin coordination goes through service hooks, not shared rows. This forbids foreign keys across plugin boundaries — feature, not bug. Each plugin's schema can evolve independently.

### Dialect-divergent features

SQL features that differ between dialects (vector search, JSON ops, listen / notify, full-text):

- Stick to Kysely's portable surface where possible.
- Kysely abstracts JSON, `ON CONFLICT`, `RETURNING` — write once, both work.
- For genuinely missing features (e.g., vector search needs `sqlite-vec` extension OR `pgvector`) — plugin can detect dialect via Kysely and branch, OR be split into two plugins (`memory-sqlite-vec` + `memory-postgres-pgvector`) and config picks one.

### eventbus

Related but separate plugin — Postgres LISTEN / NOTIFY for cross-replica, in-process emitter for single-host. Pub/sub semantics identical at the hook surface; the impl bridges to deployment.

### Transactions

`database:get-instance` can also expose `database:transaction(fn)` for single-plugin atomicity. **Cross-plugin transactions are intentionally not supported** (would re-couple plugins).

---

## Section 7 — Channels as bottom-up triggers

Channels (Slack, web chat UI) are different — **not called BY the chat loop; they CALL the chat loop.** Entry points, not callees.

Channels = service plugins that own a listener and emit triggers:

```
At boot:
  hooks.fire('channel:start')   // every channel plugin spins up its listener

Slack message arrives:
  channel-slack plugin:
    ctx = buildContext(slackMessage)        // map slack_thread_ts → sessionId
    response = await hooks.call('chat:run', ctx, message)
    slackClient.post(channel, response)

Browser POSTs /v1/chat/completions:
  channel-chat-ui plugin:
    ctx = buildContext(httpReq)             // map browser session → sessionId
    streamSubscription = hooks.subscribe('chat:stream-chunk',
      chunk => { if (chunk.reqId === ctx.reqId) sseWrite(chunk) })
    await hooks.call('chat:run', ctx, message)
    streamSubscription()                    // unsubscribe
    sseEnd()
```

`chat:run` is a service hook **registered by core itself** (the orchestration loop from Section 3 IS the impl). Channels and other triggers (scheduler, webhooks) call it the same way.

### Streaming back

Uses the existing subscriber hook surface. Each chunk fires `chat:stream-chunk(ctx, chunk)`. The channel that started the chat subscribes (filtered by `reqId`), translates chunks to its output format. SSE channel writes each chunk as a frame. Slack channel buffers and posts on `chat:end` (or implements progressive edits).

### Session mapping

Purely the channel's responsibility. `slack_thread_ts → sessionId`, `browser_auth → sessionId`, `webhook_id → sessionId`. Core gets a `sessionId` in the ctx; channel handles the external ↔ internal translation.

### Outbound from core to a channel

Proactive hints, scheduled notifications. Channel plugins subscribe to `channel:outbound(target, message)`. Each channel checks if `target` is "theirs" and posts. **No central routing table.**

### Two real complications

1. **HTTP server ownership.** SSE (chat UI), webhooks, admin all want HTTP routes. **Recommendation:** one designated `http-server` plugin provides `http:register-route(method, path, handler)` hook; others register against it. Keeps core small (no HTTP code), keeps everything on one port (operational simplicity), the `http-server` plugin is itself swappable.

2. **Persistent connections in multi-replica.** Slack socket mode connects to ONE replica; SSE held by ONE replica. If an event needs to reach a held connection on a different replica, the channel plugin coordinates via the eventbus plugin: replica A fires `channel:outbound` on the bus; the replica holding the connection picks it up. Plugin internals, not core surface.

---

## Section 8 — Testing strategy: the actual B story

The whole point of motivation B was "develop / test / debug each component without booting the whole system." That promise depends on the testing story being good in practice.

### Per-plugin test harness

1. Boots a tiny in-memory hook bus (the real one, just empty).
2. Optionally registers a `MockServices` bundle — minimal fakes for service hooks the plugin calls (storage, audit, eventbus). Each fake ~20 LOC, lives in core (reusable).
3. Loads only the plugin under test.
4. Tests fire hooks and assert on side effects + return values.

### Example: testing the k8s sandbox plugin

```typescript
import { createTestHarness, MockServices } from '@ax/test-harness';
import { createK8sSandboxPlugin } from '../src/k8s-sandbox.js';

it('passes requestId through to pod env', async () => {
  const harness = createTestHarness({
    services: { ...MockServices.basics(), 'k8s:api': mockKubeApi() },
  });
  await harness.load(createK8sSandboxPlugin({ namespace: 'test' }));

  await harness.hooks.call('sandbox:spawn', ctx, { requestId: 'abc-12345678', /*...*/ });

  expect(mockKubeApi.lastPodSpec.spec.containers[0].env).toContainEqual({
    name: 'AX_REQUEST_ID', value: 'abc-12345678',
  });
});
```

No host. No LLM. No real k8s. Mocked `k8s:api` (the only real-world dep), real hook bus, real plugin code. Fast (sub-second), deterministic, no setup.

### Memory plugin in isolation

Today this is hard because memory recall calls LLM. With the new shape:

```typescript
const harness = createTestHarness({
  services: {
    ...MockServices.basics(),
    'database:get-instance': mockSqlite(),
    'llm:call': fakeLlm({ extractions: [{ kind: 'preference', text: 'uses kebab-case' }] }),
  },
});
```

### Three test layers, in order of cost

1. **Unit / hook-driven** — single plugin + mocks. ~ms per test. Dominant test layer.
2. **Plugin-pair integration** — two real plugins together (e.g., scanner + tool-execute), mocks for everything else. ~10ms per test. For interactions too important to fake.
3. **End-to-end** — full plugin set, real database, real sandbox. ~seconds per test. Few tests, smoke-only.

### The contract that makes this work

Plugins:

- don't reach for global state,
- don't construct their own deps from scratch,
- and don't import other plugins directly.

Get config at construction; get dependencies via hook calls. Detectable by linting (no cross-plugin imports) and code review.

### Where mocks live

`MockServices` lives in core (`@ax/test-harness`), not scattered across plugin test dirs. `MockServices.basics()` returns a registered set of "do nothing successfully" fakes for the dozen common services every plugin assumes. Plugin test files override the ones that matter for that test.

---

## Section 9 — Packaging: monorepo + independent semver

Recommended shape: **monorepo, independent semver per plugin.** Examples in the wild that work well: prisma, nx, turborepo, vscode-extensions.

```
ax/
├── packages/
│   ├── core/                       # @ax/core           — the ~1,600 LOC kernel
│   ├── sandbox-k8s/                # @ax/sandbox-k8s
│   ├── sandbox-docker/             # @ax/sandbox-docker
│   ├── sandbox-subprocess/         # @ax/sandbox-subprocess
│   ├── storage-sqlite/             # @ax/storage-sqlite
│   ├── storage-postgres/           # @ax/storage-postgres
│   ├── llm-anthropic/              # @ax/llm-anthropic
│   ├── llm-openai/                 # @ax/llm-openai
│   ├── llm-router/                 # @ax/llm-router
│   ├── memory-cortex/              # @ax/memory-cortex
│   ├── channel-slack/              # @ax/channel-slack
│   ├── channel-chat-ui/            # @ax/channel-chat-ui
│   ├── workspace-git-http/         # @ax/workspace-git-http
│   ├── ... (~25 plugins eventually)
│   ├── test-harness/               # @ax/test-harness   — MockServices etc.
│   └── cli/                        # @ax/cli            — user-facing binary
├── presets/
│   ├── k8s/                        # @ax/preset-k8s     — bundles the k8s plugin set
│   └── local/                      # @ax/preset-local   — bundles dev/laptop set
├── pnpm-workspace.yaml
└── .changeset/                     # changesets manages per-package version bumps
```

### Tooling

- **pnpm workspaces** for the monorepo (faster + smaller than npm / yarn).
- **changesets** for per-package version + changelog management. Contributors add `.changeset/foo.md`; CI computes per-package semver bump.
- **TypeScript project references** between packages so incremental builds only rebuild changed plugins.
- **Per-package vitest configs** so testing one plugin doesn't run the whole suite.

### Compatibility model

Core's `package.json` carries the public hook-surface version (same as semver — major bumps mean breaking hook changes). Plugins declare:

```json
{
  "name": "@ax/sandbox-k8s",
  "version": "0.3.2",
  "peerDependencies": { "@ax/core": "^1.0.0" }
}
```

At load, core reads each plugin's manifest (the `ax` field in their `package.json`):

```json
"ax": {
  "registers": ["sandbox:spawn", "sandbox:kill"],
  "calls":     ["storage:get", "storage:set", "audit:write"],
  "configSchema": "./schema.json"
}
```

Core uses this for: (a) cycle detection at load, (b) failing fast on missing services, (c) generating a compatibility matrix.

### User installation

```bash
# Local dev preset
npm install @ax/cli @ax/preset-local

# Or hand-pick
npm install @ax/cli @ax/core @ax/sandbox-k8s @ax/storage-postgres \
            @ax/llm-router @ax/llm-anthropic @ax/memory-cortex
```

`ax.config.ts` lists which plugins to load by name; the CLI imports them. **No filesystem-based plugin discovery** (matches today's SC-SEC-002 — static allowlist of providers).

### Why this shape for AX specifically

- Core changes fast (early phase) — independent semver lets a sandbox plugin pin to `^1.x` without dragging the whole world to `2.x` when channel API breaks.
- Cross-cutting refactors need to touch many plugins atomically — monorepo makes that one PR, not 25.
- Third-party plugins (if we ever want them) just peerDepend `@ax/core` and live anywhere — same model as VS Code extensions or eslint plugins.
- Tests run per-package, so CI is fast for small changes.

### Versioning policy

- Core stays at `0.x` until the hook surface is stable (low cost while in `0.x`).
- Plugins independently semver from day one — minor for new hook subscriptions, patch for fixes.
- A "preset" package is just a meta-package with deps; bumping it ships a coordinated release of "k8s mode is now this set of plugin versions."

### CLI binary

`@ax/cli` bundles a curated default set for the common case but allows the config file to override (so power users can swap). Same pattern as `npx create-react-app` — opinionated defaults, configurable for advanced cases.

---

## Section 10 — Build order: greenfield, legacy as reference

Greenfield rewrite. New monorepo, fresh code. Legacy AX (the current repo) becomes a reference implementation — read its source for edge cases, port specific helpers, but **don't carry over the orchestration shape.**

### Why this is the right call

- Expensive parts of legacy (`server-completions.ts`, IPC handler dispatcher, multi-mode sandbox manager) are exactly what the new architecture removes. Porting is wasted.
- Valuable parts (hardened sandbox impls, security helpers, edge-case fixes from production debugging) are small, self-contained, easy to lift — `safePath`, canary scanner, taint tagging, k8s pod lifecycle bits from Tasks 1–7 (correlation IDs + canonical chat events). These become 50–200 LOC each that ports cleanly into a plugin.
- No risk of "new thing has to interoperate with old" — interoperation contracts are themselves a major source of complexity.
- AX is not yet public; no users to migrate.

### Build order

```
Week 1-2 — Kernel
  • New monorepo: pnpm + changesets + tsconfig refs
  • @ax/core: hook bus, ChatContext, IPC primitives, logger, error types
  • @ax/test-harness: createTestHarness + MockServices.basics()
  • Goal: `chat:run` returns "no llm registered" cleanly. Tests exist.

Week 3 — Smallest viable end-to-end
  • @ax/llm-mock (always returns "hello"), @ax/sandbox-subprocess
    (just spawns node + IPC), @ax/storage-sqlite, @ax/cli
  • Goal: send a message, get a fake response. Full loop runs.

Week 4-6 — Real LLM + tools
  • @ax/llm-anthropic, @ax/llm-router (port routing logic from legacy)
  • @ax/tool-bash, @ax/tool-file-io (port from legacy agent code)
  • Goal: real chat with bash + file tools, single-host. Smoke test passes.

Week 7-9 — Production deployment shapes
  • @ax/sandbox-k8s (port + adapt — per-pod logger, lifecycle reason capture, kill-with-reqId all carry over from Task 1-7)
  • @ax/storage-postgres, @ax/eventbus-postgres, @ax/session-postgres
  • @ax/workspace-git (snapshot-oriented, see Section 4.5 contract)
  • Goal: deploy v2 to a real k8s cluster, run a real chat

Week 10-12 — Channels + observability
  • @ax/channel-chat-ui (port assistant-ui adapter), @ax/channel-slack
  • @ax/audit, @ax/scanner-canary, @ax/memory-cortex (port logic, simplify)
  • Goal: feature parity with current legacy AX

Week 13+ — Cleanups + additive plugins
  • Now things are pluggable, cleanups are bounded — refactor a plugin
    in isolation instead of rippling through 20k LOC
  • @ax/workspace-gcs (or s3) lands additively against Section 4.5's contract —
    no subscriber (skill validator, scanner, audit) changes
```

~3 months elapsed time with focused part-time work, faster if dedicated. Early weeks are mostly net-new code (kernel + harness + smallest end-to-end). Later weeks are heavy on porting from legacy — but porting into clean plugin shape, not into refactor.

### Concrete risk

Scope creep. With a clean slate, the temptation is to also redo skill validation, credential model, OAuth flow. **Resist.** Port them as plugins first, fix later. The win is the architecture, not rewriting every component.

### Concrete advantage

Better test culture from day one. Legacy has ~3000 tests but most go through the monolithic `processCompletion`. The new repo can be 80%+ unit tests at the hook-isolation layer (per Section 8) from the start — no retrofitting.

### Failure modes

Applies to both build-out AND steady state.

| Failure | Mechanism |
|---|---|
| Subscriber throws | Caught at hook bus, logged at error level (`hook_subscriber_failed` with plugin name + hook + error), chat continues. One bad subscriber can't tank the chat. |
| Service plugin throws | Propagates as structured `PluginError`. Caller (often chat loop) decides — for `llm:call` errors, the existing retry loop kicks in; for `tool:execute`, becomes a tool error returned to LLM; for `storage:get`, bubbles up. |
| Service plugin returns wrong shape | Caught at hook bus via Zod validation on the hook's return schema. Treated as `PluginError`. (Cost: Zod parse per service-hook return — measurable but worth it.) |
| Plugin hangs (no return) | Each service-hook call has a timeout (configurable per hook, e.g., 60s for `llm:call`, 5s for `storage:get`). Timeout becomes `PluginError`. |
| Plugin init fails at boot | Core fails fast — refuses to start. Better than half-broken runtime. Error message names which plugin failed and why. |
| Cycle detected at boot | Same — fail fast with a clear "plugin X declares calls→Y, plugin Y declares calls→X" message. |
| Required service hook missing | Boot-time check: if any plugin declares `calls: ['storage:set']` but no plugin registers `storage:set`, fail fast with a missing-service message. |
| Two plugins register the same service hook | Boot-time error — config must pick one. (Subscribers to the same hook are fine; service hooks are exclusive.) |

Pattern: **boot-time failures are loud and prevent startup; runtime failures degrade gracefully with structured errors.** The hook bus is the natural enforcement point — every cross-plugin interaction goes through it.

---

## What's NOT in scope (yet)

Things explicitly deferred. Listed so future readers don't assume the design covers them.

- **Hot-reload of plugins.** No. Restart the host for plugin changes. Hot-reload introduces a class of state-management bugs that aren't worth the convenience at this stage.
- **Config hot-update.** Same — restart on config change. Plugins read config at construction.
- **Security capability model.** Do plugins get explicit permission grants (e.g., "this plugin may call `storage:*` but not `credentials:*`")? Punted. For now, all in-process plugins are trusted equally; the trust boundary is the IPC line between host and sandbox, not between host plugins.
- **Inter-plugin transactions.** Cross-plugin atomicity is intentionally not supported. Single-plugin transactions via `database:transaction` only. If we discover a use case that genuinely needs cross-plugin atomicity, we'll revisit — but the default answer is "redesign so you don't need it."
- **Dynamic plugin discovery.** No filesystem scanning. Plugins are loaded by explicit config / preset. Matches today's SC-SEC-002 posture.

---

## Design decisions log

Each line: what was considered, what was chosen. Future readers see both.

- **Motivation:** A (chat reliability), B (component robustness in isolation), C (multi-deployment support). **Chose B** — it's the upstream cause; A and C fall out of it.
- **Isolation flavor:** F1 (microservices — separate processes per component) vs F2 (in-process plugins with hook bus). **Chose F2** — keeps deploy simple, gets isolation via the bus contract, no IPC tax for every cross-component call.
- **Hook flavors:** unify into one shape vs split into service + subscriber. **Chose split** — service and subscriber have genuinely different semantics; unifying makes both awkward.
- **Hook surface transport:** allow transport-aware payloads vs require transport-agnostic. **Chose transport-agnostic, MUST.** Leaks here defeat Section 4 entirely.
- **Plugin → plugin API:** DI container vs hook bus only. **Chose hook bus only** — one fewer concept, already have the bus for cross-cutting concerns.
- **Cross-plugin DB sharing:** allow shared tables / FKs vs strict per-plugin tables. **Chose strict per-plugin** — independent schema evolution is worth the loss of FK enforcement.
- **Cross-plugin transactions:** support vs don't. **Don't support** — would re-couple plugins.
- **HTTP server:** in core vs dedicated `http-server` plugin. **Chose dedicated plugin** — keeps core small, keeps `http-server` itself swappable.
- **Channel routing:** central registry vs subscribe-and-claim. **Chose subscribe-and-claim** — no central state, channels self-identify.
- **Packaging:** single package vs monorepo with independent semver. **Chose monorepo + independent semver** — matches the shape of work (cross-cutting refactors need atomic PRs; plugin-only changes shouldn't bump everything).
- **Workspace tool:** npm / yarn / pnpm. **Chose pnpm** — faster, smaller, better workspace ergonomics.
- **Versioning tool:** lerna / changesets / manual. **Chose changesets** — per-package bumps without ceremony.
- **Build approach:** incremental refactor of legacy vs greenfield rewrite. **Chose greenfield** — legacy's expensive parts are exactly what the new architecture removes; no users to migrate.
- **Legacy disposition:** delete vs keep as reference. **Keep as reference** — read it for edge cases, port specific helpers, don't mutate it.
- **Plugin discovery:** filesystem scan vs explicit config. **Chose explicit config** — matches SC-SEC-002, no surprise loads.
- **Hot-reload:** support vs restart-only. **Restart-only** — simpler, fewer state bugs, fine at this stage.
- **Capability model for plugins:** explicit permission grants vs trust-all-in-process. **Trust-all-in-process for now**; trust boundary stays at the IPC line.
