# AX v2 — Current Architecture (2026-05)

**Status:** Current state, as-built
**Date:** 2026-05-24
**Supersedes (for "what is true today"):** `docs/plans/2026-04-22-plugin-architecture-design.md`

---

## Why this doc exists

The 2026-04-22 design doc is the *founding* spec — the brainstorm that set the
shape (tiny kernel, hook bus, everything-else-a-plugin, deployment-via-plugin-
selection). It's still the best read for the *why* behind the architecture, and
the invariants in it still hold.

But it described a topology we didn't end up building literally. Most visibly:
it puts a ~500-LOC **chat completion loop inside the kernel** (Section 3), with
core firing `llm:pre-call` / `tool:execute` / `chat:end` in a `while` loop. That
loop no longer exists in `@ax/core`. The model turn-loop moved *out* of the host
entirely and into a sandboxed runner; the host's job shrank to control-plane
orchestration around it.

This doc is the current map. If the 04-22 doc and this doc disagree about what
the code does *today*, this doc wins. If you want to understand the reasoning
behind a boundary, read the 04-22 doc — its Sections 1, 2, 4, 4.5, 5, 6, 9 are
still accurate as design rationale.

The big architectural cards (ARCH-1 through ARCH-13) have landed except ARCH-9,
10, and 11, which are deliberately deferred — see "What's still transitional or
deferred," below. We reflect their outcomes here.

---

## TL;DR — what changed from the founding design

- **The kernel does not run chat.** `@ax/core` has no chat loop. The old
  `chat-loop.ts` was deleted. The kernel is now: bootstrap + manifest validation,
  the hook bus (with timeout + return-schema enforcement), identity/context
  primitives, IPC framing/wire primitives, and the storage-neutral workspace
  contract (types, policy filter, apply facade). The kernel's acceptance test no
  longer asserts a chat outcome — it asserts that `bootstrap()` refuses to start a
  plugin set with unmet `calls:`.

- **Host vs. runner is the central split.** The model agent loop runs in a
  **runner** (`@ax/agent-claude-sdk-runner`) inside a sandbox (subprocess locally,
  pod in k8s), driving the Claude Agent SDK. The **host** is everything outside
  the sandbox: orchestration, tools, workspace, credentials, conversations,
  channels. The runner reaches the host only over a narrow authenticated IPC wire.

- **`@ax/chat-orchestrator` owns the per-chat control plane.** It registers the
  host-side `agent:invoke` service hook (not the `chat:run` the 04-22 doc named).
  One `agent:invoke` = resolve the agent (ACL gate), decide route-vs-fresh, open
  or reuse a sandbox, enqueue the user turn, wait for the runner's `chat:end`,
  clean up.

- **The transcript lives where the SDK writes it, and the host reads it back.**
  The runner owns the session; the durable conversation transcript is the
  committed `.claude/projects/*/<sessionId>.jsonl` in the workspace, read by
  `conversations:get`. There is no host-side replayed message array.

- **Boundaries are now schema-enforced.** Service hooks reachable over IPC, plus
  the security/tenant-boundary hooks, plus the long tail, carry `returns` zod
  schemas (ARCH-6/12/13). The IPC dispatcher's dependency surface is declared in
  one place (ARCH-2). Git-vocabulary and sandbox/IPC payload shapes live in
  dedicated `*-protocol` packages, not in the kernel (ARCH-3/5).

---

## Section 1 — The host/runner split

This is the load-bearing structural fact of v2 as-built, and it's the thing the
04-22 doc's "core chat loop" section obscured.

```
            HOST  (trusted)                       SANDBOX  (untrusted)
  ┌───────────────────────────────┐        ┌──────────────────────────────┐
  │  channel-web / CLI             │        │  @ax/agent-claude-sdk-runner  │
  │     │ agent:invoke             │        │     │                        │
  │     ▼                          │        │     ▼                        │
  │  @ax/chat-orchestrator         │        │  Claude Agent SDK            │
  │   - agents:resolve (ACL)       │        │   - runs the model turn loop │
  │   - sandbox:open-session ──────┼───────▶│   - calls tools              │
  │   - session:queue-work         │  spawn │   - writes the jsonl         │
  │   - awaits chat:end            │  pod   │     transcript               │
  │                                │        │     │                        │
  │  @ax/ipc-http / @ax/ipc-server │◀───────┼─────┘ IPC (auth'd wire)      │
  │   dispatcher → host services   │  back- │   tool.list / tool.execute   │
  │   (tool / workspace / session  │ channel│   / workspace.read /         │
  │    / conversations)            │        │    .materialize / .commit    │
  └───────────────────────────────┘        └──────────────────────────────┘
```

**The host never runs the model.** It hands the runner a session (bearer token,
config, workspace baseline) and waits. The runner drives the SDK, which spawns
the bundled `claude` CLI, runs the agentic turn loop, and calls back to the host
over IPC for the things only the host can do safely: list tools, execute
host-side tools, read/materialize/commit the workspace, claim the next queued
message, report stream chunks and turn/chat end.

Why it's shaped this way: the trust boundary is the sandbox edge (04-22 doc
"capability model" decision). Putting the agent loop in the sandbox means the
untrusted model-driven loop has *no* in-process access to credentials, the DB,
other tenants' data, or the host filesystem — it has a bearer token and a socket,
and every reach is a validated IPC action. The host code that does have that
access (orchestrator, tools, workspace) is small, first-party, and never executes
model output directly.

### What runs where

| Concern | Lives in | Notes |
|---|---|---|
| Model turn loop, tool dispatch decisions | **Runner** (sandbox) | Claude Agent SDK |
| Per-chat orchestration (`agent:invoke`) | **Host** — `@ax/chat-orchestrator` | route-vs-fresh, lifecycle |
| Sandbox spawn / pod lifecycle | **Host** — `@ax/sandbox-subprocess` / `@ax/sandbox-k8s` | registers `sandbox:open-session` |
| IPC wire (runner ↔ host) | **Host** — `@ax/ipc-server` (unix) / `@ax/ipc-http` (tcp); dispatcher in `@ax/ipc-core` | auth + per-action handlers |
| Host tool execution | **Host** — `@ax/mcp-client`, `@ax/web-tools`, `@ax/tool-artifact-publish` | `tool:execute:<name>` |
| Workspace versioning | **Host** — `@ax/workspace-git` (local) / `@ax/workspace-git-server` (git-protocol) | opaque `WorkspaceVersion` |
| Conversation/transcript metadata | **Host** — `@ax/conversations` | reads committed jsonl |
| Credentials / egress proxy | **Host** — `@ax/credentials*`, `@ax/credential-proxy` | runner sees only `ax-cred:<hex>` placeholders |

---

## Section 2 — The kernel (`@ax/core`) today

The kernel is still tiny and still trusted-by-everything, but its responsibilities
are now precisely:

1. **Bootstrap + manifest validation** (`bootstrap.ts`, `plugin.ts`). Reads each
   plugin's in-code `manifest`, topo-sorts on declared `calls`/`registers`,
   detects cycles, and **fails the boot** if a required `calls:` hook has no
   registered producer. The manifest is the canonical compatibility surface —
   there is no `ax` field in `package.json` (see `2026-05-20-manifest-canonical-form-design.md`).
   `manifest.optionalCalls` is `{ hook, degradation }[]` (ARCH-4): a non-fatal
   dependency that still forms a real call-graph edge when the producer is present.

2. **The hook bus** (`hook-bus.ts`). Two flavors, unchanged in spirit from the
   04-22 doc: **service** (exactly one producer, DI-shaped) and **subscriber**
   (many observers/transformers, middleware-shaped). What's new:
   - Every service call has a **timeout** (default 120s, overridable per
     registration; `Infinity` opts out). A hang becomes `PluginError('timeout')`.
   - A service registration may carry a **`returns` zod schema**; a bad shape
     becomes `PluginError('invalid-return')`. See
     `2026-05-20-hook-bus-enforcement-design.md`.

3. **Identity / context primitives** (`context.ts`, `errors.ts`). `AgentContext`
   (`reqId`, `sessionId`, `conversationId?`, bound `logger`, …), `PluginError`,
   `makeReqId`, `makeAgentContext`.

4. **IPC primitives** (`ipc/`). Length-prefixed framing (`encodeFrame`,
   `FrameDecoder`, `MAX_FRAME`) and the `WireRequest`/`WireResponse` zod schemas.
   NOT the dispatcher or transport — those are plugins.

5. **The storage-neutral workspace contract** (`workspace.ts`,
   `workspace-policy.ts`, `workspace-apply-facade.ts`). The opaque
   `WorkspaceVersion` brand, the `FileChange`/`WorkspaceDelta` types, the
   `returns` schemas for read/list/apply/diff, the policy filter, and the
   `registerWorkspaceApplyFacade` chokepoint that fires `workspace:pre-apply` →
   internal apply → `workspace:applied`. This is the one place a multi-plugin
   data contract lives in core, and it's deliberately backend-agnostic (no
   sha/branch/bundle/ref — see ARCH-3).

What is **not** in the kernel anymore (vs. the 04-22 doc Section 3): the chat
loop. Its responsibilities dispersed — orchestration to `@ax/chat-orchestrator`,
the model loop to the runner, LLM calls to the runner's SDK (the host no longer
registers `llm:call` for the chat path; only `@ax/llm-anthropic`'s
`llm:call:anthropic` exists, used for auto-titling and web-tools, not the agent).

---

## Section 3 — `@ax/chat-orchestrator`: the per-chat control plane

Registers the **`agent:invoke`** service hook. The 04-22 doc called this
`chat:run` and put it in core; in the as-built system it's a plugin hook with a
backend-agnostic payload (`{ message, maxTurns? }` in, `AgentOutcome` out — no
transport or storage vocabulary, I1).

One `agent:invoke` call does roughly:

1. **`chat:start`** (subscriber hook, veto-capable) fires for observers.
2. **`agents:resolve`** (hard dep since Week 9.5) — the tenant ACL gate. Every
   chat resolves through an agent record before a sandbox is spawned. This forces
   any preset wiring the orchestrator to also wire `@ax/agents` (intended coupling).
3. **Route-vs-fresh decision (ARCH J6).** If `ctx.conversationId` is set and its
   `active_session_id` points at a live session, **route** the message into that
   warm runner's inbox (skip the sandbox spawn). Otherwise **open fresh**.
4. **(fresh path) `sandbox:open-session`** — the sandbox plugin binds the IPC
   listener, spawns the runner, and *internally* mints the session +
   bearer token via `session:create`. The orchestrator deliberately does **not**
   call `session:create` (a double-create throws `duplicate-session`); session
   minting belongs to the sandbox plugin. The token flows only into the runner's
   env, never back to the host (I9).
5. **`conversations:bind-session`** (when conversation-scoped) — writes
   `active_session_id` + `active_req_id` so the SSE stream router can find the
   in-flight turn.
6. **`session:queue-work`** — enqueue the user message (stamped with `reqId` so
   the runner can tag stream chunks back to the right request).
7. **Await `chat:end`.** The runner POSTs `/event.chat-end` over IPC; the IPC
   dispatcher fires `chat:end`; the orchestrator's own `chat:end` subscriber
   resolves the waiting deferred.
8. **Cleanup** — kill the handle if still alive (fresh path only; warm runners
   are left alive in keepAlive mode and reaped by an idle timer).

### Lifecycle subtleties worth knowing

- **Exactly one `chat:end` per invoke.** The happy path is fired by the IPC
  server (when the runner reports done). Error paths (`chat:start` rejection,
  sandbox-open failure, queue-work failure, chat timeout, sandbox early exit)
  synthesize a terminated outcome and fire `chat:end` themselves. Audit-style
  subscribers always see exactly one — double-firing would double-count.
- **keepAlive vs one-shot.** The CLI canary is one-shot: on the first
  `chat:turn-end` the orchestrator queues a `cancel` so the persistent runner
  exits cleanly. The channel-web/k8s preset sets `keepAlive: true`: a turn
  completes on `chat:turn-end`, the runner stays warm, and a per-session idle
  reaper (graceful cancel → force kill) collects it later.
- **Fault A (sandbox dies mid-turn).** The orchestrator subscribes to
  `session:terminate` and fires a `chat:turn-error` broadcast so a SSE stream on
  the routed/warm path surfaces a turn-error promptly instead of hanging until
  `chatTimeoutMs`. The client renders it as an error+retry row.

---

## Section 4 — IPC action boundaries (runner → host)

The IPC wire is the trust boundary. The 04-22 doc's two constraints (Section 5)
both held, and got sharper:

1. **The wire surface is intentionally smaller than the in-process hook surface.**
   The runner gets only the handful of actions it genuinely needs. It cannot
   inject middleware into the host's hook bus.
2. **Each IPC action maps to host service hooks; schemas live with the plugin,
   not in a central file.** The untrusted wire shapes are zod-validated in
   `@ax/ipc-protocol`.

### The dispatcher (`@ax/ipc-core`)

Two transports wrap one dispatcher:

- **`@ax/ipc-server`** — unix-socket listener (local/CLI profile).
- **`@ax/ipc-http`** — TCP listener (k8s profile; runner pods dial it as a
  cluster-internal back-channel, never public).

The dispatcher routes authenticated requests to per-action handlers. There are
three shapes:

- **GET action:** `/session.next-message` (claims the next queued work item).
- **POST actions** (synchronous response): `/tool.pre-call`, `/tool.execute-host`,
  `/tool.list`, `/workspace.commit-notify`, `/workspace.materialize`,
  `/workspace.read`, `/session.get-config`, `/conversation.store-runner-session`.
- **POST events** (fire-and-forget 202, subscriber fired async):
  `/event.tool-post-call`, `/event.turn-end`, `/event.chat-end`,
  `/event.stream-chunk`.

### ARCH-2: one source of truth for the dispatcher's dependencies

Both transports used to hand-maintain their own `manifest.calls` and drifted —
they declared the obvious session/tool calls and silently omitted the workspace,
conversation, and session-config services the handlers reach. ARCH-2 fixed this:
`@ax/ipc-core` exports a single `DISPATCHER_DEPENDENCIES` const with
`requiredCalls`, `optionalCalls` (with degradation notes), and `dynamicCallPatterns`
(the `tool:execute:` prefix, resolved per-tool at dispatch time). Both transports
spread it into their manifests. A `dependency-sync.test.ts` source-scan keeps the
const honest against the handlers — a new `bus.call(...)` that the metadata
doesn't cover fails the test.

Required vs. optional turns on one question: *is the producer guaranteed present
wherever a transport loads?* The local CLI loads `@ax/ipc-server` **without**
`@ax/conversations`, so `conversations:store-runner-session` and
`conversations:get-metadata` are optional (the route 500s / degrades when absent),
while `session:resolve-token`, `session:claim-work`, `tool:list`,
`session:get-config`, and `workspace:read` are required (present in every IPC
deployment).

---

## Section 5 — Transcript & source-of-truth rules

This is the area where the runner-owned-session design (Phase A/C, the 2026-05-01
workspace redesign) most diverges from anything in the 04-22 doc, so it's worth
stating plainly.

- **The runner owns the session.** The Claude Agent SDK assigns a `sessionId`
  and writes the conversation transcript as a jsonl file under
  `<HOME>/.claude/projects/*/<sessionId>.jsonl`. The runner runs with `HOME` set
  to a workspace path so that file lands *in the versioned workspace*.

- **The durable transcript is the committed jsonl, full stop.** There is no
  host-side replayed message array and no `runner:read-transcript` host hook (an
  earlier plan had one; it never shipped — Phase C was superseded). The host reads
  history by having `conversations:get` glob the committed
  `.claude/projects/*/<sessionId>.jsonl` and parse it (`@ax/agent-claude-sdk-runner-host`
  exposes the parser). Transcript parsing **whitelists** turn-bearing entry types
  (`user`/`assistant`/`tool`) because the SDK adds bookkeeping kinds
  (`queue-operation`, `last-prompt`, `attachment`) over time.

- **Commits happen at turn-end, not mid-turn.** The runner commits the workspace
  (including the jsonl) via `/workspace.commit-notify` only when a turn ends. A
  turn killed before its first commit never persists a transcript — which is why
  the `runner_session_id` binding moved from `system/init` to the **first
  host-accepted turn-end commit** (F2a). Binding at init pointed at a transcript
  that didn't exist yet; a retry then resumed a session id with no parseable
  transcript and the SDK hard-crashed ("No conversation found with session ID").
  Now `runner_session_id` is set iff a resumable transcript is durable, so a retry
  cleanly starts fresh.

- **One writer per concept (I4).** `active_session_id` / `active_req_id` (routing)
  live on the conversation row via `conversations:bind-session`. The
  `runner_session_id` (SDK resume pointer) is written once via
  `conversations:store-runner-session`. The transcript content lives only in the
  workspace. Audit records live under the `chat:<reqId>` storage namespace owned
  by `@ax/audit-log`. No two plugins store the same fact.

- **Attachments are reconstructed on read.** Under runner-owned sessions the jsonl
  stores the runner's text-mention translation of an upload, not the original
  `attachment` block. `conversations:get` reconstructs the chip from that mention
  (path-prefix-gated to the conversation's own uploads), so the original wire
  shape needn't be persisted — and already-broken chats are fixed retroactively
  with no migration. The `formatAttachmentMention`/`parseAttachmentMention` pair
  in `@ax/ipc-protocol` keeps producer (runner) and consumer (host) from drifting.

---

## Section 6 — Stable vs. transitional hooks

The 04-22 doc listed an aspirational hook surface. Here's the current reality,
classed by how settled each surface is.

### Stable — relied on by IPC and/or a tenant/security boundary

These carry `returns` zod schemas (ARCH-6/12) and have at least one real producer
and consumer. Treat their *shape* as a contract; changing it is a boundary review.

- **Orchestration:** `agent:invoke` (`@ax/chat-orchestrator`).
- **Workspace:** `workspace:read`, `workspace:list`, `workspace:apply` (via the
  core facade), `workspace:diff`. The `workspace:pre-apply` / `workspace:applied`
  subscriber pair is the policy/scanner chokepoint. The bundle fast-path hooks
  (`workspace:apply-bundle`, `workspace:export-baseline-bundle`) are **optional**
  and git-specific; their payload types live in `@ax/workspace-bundle-protocol`
  (ARCH-3), not core, because they carry git vocabulary.
- **Session:** `session:create`, `session:resolve-token`, `session:claim-work`,
  `session:queue-work`, `session:get-config`, `session:is-alive`,
  `session:terminate`. Two backends register these (`@ax/session-inmemory`,
  `@ax/session-postgres`), each carrying its own structurally-identical schema
  copy (I2 — no cross-plugin import; the drift is the documented boundary cost).
- **Agents / tenancy:** `agents:resolve` (the ACL gate every conversation hook
  chains through).
- **Conversations:** `conversations:get-metadata`,
  `conversations:store-runner-session` (and the `conversations:bind-session` /
  `:get` / `:list` family).
- **Credentials:** `credentials:get`, `credentials:resolve:<kind>`,
  `credentials:list`, `credentials:list-kinds`, plus the `credentials:store-blob:*`
  storage seam.
- **Sandbox:** `sandbox:open-session` — special-cased: its result carries a live
  `handle` (functions + a Promise), so its schema is `.passthrough()` validating
  only the opaque `runnerEndpoint`. A strict schema would strip the handle.
- **Tool catalog:** `tool:register`, `tool:list`, and the dynamic
  `tool:execute:<name>` family.

### Stable — covered by ARCH-13's long-tail rollout

`returns` schemas now also cover skills (7), routines (7), teams (5), the storage
backends, `llm:call:anthropic` + `models:list-supported`, mcp `tool:register` /
`tool:list`, `http:register-route`, `memory:index:search` (both backends),
`bootstrap:status`/`reset`, attachments (3), and `eventbus:subscribe` (both
backends) — ~32 hooks. Live-handle hooks (`http:register-route`,
`eventbus:subscribe`) use a bare `z.object({}).passthrough()` so the capability
object rides through by reference (modeling it with `z.function()` breaks identity).
`void`-returning hooks (`eventbus:emit`, `storage:set`, `db:transact`, …) are
intentionally unschema'd — there's nothing to validate.

### Transitional / single-replica-bound

- **Streaming hooks** (`chat:stream-chunk`, the SSE chunk-buffer behind
  `/api/chat/stream`) are **in-process and single-replica**. The Helm chart
  *fails `helm template` for `replicas > 1`* (ARCH-1) so nobody can ship a
  multi-replica host while this is in-process. Lifting that needs ARCH-9.
- **`eventbus:emit` / `:subscribe`** exist with both an in-process and a Postgres
  LISTEN/NOTIFY backend, but the NOTIFY backend caps payloads at 8000 bytes —
  hostile to streaming text. It is **not** the chat-stream transport. Today the
  eventbus's only production use is cross-replica re-broadcast of small events
  (e.g. `session:terminate`, live title refresh).
- **Workspace `local` backend** (`@ax/workspace-git` on an RWO PVC) is
  single-replica by construction; `git-protocol` (`@ax/workspace-git-server`) is
  the multi-replica-capable path.

---

## Section 7 — Deployment profiles (as-built)

The 04-22 doc's "deployment shapes fall out of plugin selection" held. Two
profiles exist:

- **Local / CLI** — `@ax/cli` assembles: `storage-sqlite`, `session-inmemory`,
  `sandbox-subprocess`, `ipc-server` (unix socket), `workspace-git` (local),
  `chat-orchestrator`, the credential proxy, mcp-client, `llm-anthropic`,
  memory-strata (sqlite index), web-tools. Single laptop; drives the canary.
- **k8s** — `presets/k8s` assembles the production set: the Postgres trio
  (`database-postgres` + `storage-postgres` + `eventbus-postgres` +
  `session-postgres`), `workspace-git` (local PVC) **or** `workspace-git-server`
  (git-protocol), `sandbox-k8s`, `ipc-http` (TCP), `chat-orchestrator`
  (keepAlive), `http-server` (public listener), `auth-better`, `teams`,
  `onboarding`, `agents`, `skills`, `conversations`, `attachments`,
  `channel-web`, and (env-gated on `ANTHROPIC_API_KEY`) `conversation-titles` +
  memory-strata + web-tools.

`@ax/cli` and `presets/**` are the only packages allowed to import sibling
plugins directly (eslint `no-restricted-imports` allowlist); everything else talks
through the bus. ARCH-8 added a CI-grade prod-bootstrap lane that boots the real
production plugin set against a Postgres testcontainer, swapping only the k8s
sandbox seam for a fake — proving the production assembly is well-formed without a
real cluster.

The two listeners in the host pod are distinct: `@ax/ipc-http` (runner ↔ host
back-channel, Service :80) and `@ax/http-server` (public — `/chat`, `/health`,
`/admin/*`, `/auth/*`, `/api/chat/*`, Service :9090). State-changing public routes
are CSRF-gated by an `@ax/http-server` subscriber.

---

## Section 8 — Protocol packages (ARCH-3/5)

Shared payload shapes that would otherwise be duplicated (and drift) across
plugins live in dedicated packages on the cross-plugin-import allowlist. The
decision rule for the workspace surface: a *wire* shape → `@ax/ipc-protocol`
(zod-validated, untrusted runner↔host wire); an in-process *hook-bus* type → its
own `*-protocol` package; never the storage-neutral kernel (I1 forbids
sha/branch/bundle/ref/commit in `@ax/core`).

- **`@ax/ipc-protocol`** — the zod-validated untrusted wire shapes (request/
  response framing payloads, attachment-mention format).
- **`@ax/sandbox-protocol`** (ARCH-5) — `ProxyConfigSchema`, `InstalledSkillSchema`,
  `McpServerSchema`, `AgentConfigSchema`, `OpenSessionInputSchema`,
  `OpenSessionResultSchema`. Zod schemas, no `@ax/core` dep. Both sandbox backends
  and the orchestrator (type-only) share them; convergence picked the *stricter*
  proxy-config schema (exactly-one-of endpoint/socket).
- **`@ax/workspace-protocol`** — the workspace wire shapes.
- **`@ax/workspace-bundle-protocol`** (ARCH-3) — the 4 git-bundle hook-payload
  types (`WorkspaceApplyBundle*`, `WorkspaceExportBaselineBundle*`). **Pure TS
  types, no zod** (the contract is an in-process `bus.call<In,Out>` generic, not an
  untrusted wire — the wire is already `@ax/ipc-protocol`), but **does** depend on
  `@ax/core` type-only for the neutral `WorkspaceVersion`. Moved out of the kernel
  precisely because `bundleBytes`/`baselineCommit` are git vocabulary that leaked
  into the storage-neutral surface.

`@ax/agent-claude-sdk-runner`'s hand-rolled, non-zod `validateMcpEntry` is the one
deliberate duplication — it's defense-in-depth on the *sandbox side* of the trust
boundary and intentionally does not import the host contract package. Keeping it
in sync with `McpServerSchema` is ARCH-11 (deferred — see below).

---

## What's still transitional or deferred

These are **not done** and shouldn't be described as such. They sit in Backlog.

- **ARCH-9 — distributed chat-stream broker.** ARCH-1 shipped a fail-fast
  single-replica *guard*, not a broker. Multi-replica chat needs a real
  cross-replica stream transport (a Redis stream or pg-logical channel — **not**
  the 8000-byte-capped Postgres NOTIFY eventbus). **Gated** on a multi-replica
  workspace backend existing first (today `workspace.backend=local` is RWO/single-
  node). Until then, the chart's `replicas > 1` guard stays and chat streaming is
  single-replica.

- **ARCH-10 — compatibility-matrix generator.** The architecture spec lists a
  compatibility matrix as a consumer of manifest `optionalCalls` + degradation
  notes (ARCH-4 shipped the data). No generator exists yet; it'll be earned when a
  real consumer needs it, not built speculatively.

- **ARCH-11 — keep runner `validateMcpEntry` in sync with `McpServerSchema`.**
  The intentional sandbox-side duplication (above) needs a drift detector (shared
  test fixture / golden vectors) or an accepted-duplication cross-reference. Gated
  on ARCH-5 (done); the work itself is still open.

Other deferrals from the founding design that remain deferred: hot-reload of
plugins, config hot-update, an explicit inter-plugin capability model (the trust
boundary is still the IPC line, not between host plugins), inter-plugin
transactions, and dynamic filesystem plugin discovery.

---

## Reading order for a new contributor

1. **This doc** — what the system is today.
2. **`2026-04-22-plugin-architecture-design.md`** Sections 1, 2, 4.5, 5, 6, 9 —
   the *why* behind the kernel/bus/workspace/IPC/DB/packaging decisions.
3. **`.claude/memory/decisions.md`** — the running log of every architectural
   decision since, with rationale and rejected alternatives. When this doc says
   "ARCH-N did X," the decisions log has the detail.
4. The `ax-conventions` skill — the invariants, manifest format, hook bus
   mechanics, and boundary-review checklist in their canonical form.
