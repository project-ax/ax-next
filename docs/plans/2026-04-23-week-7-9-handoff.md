# Week 7–9 handoff — production deployment shapes

**For:** session starting Week 7–9.
**Previous slices:** Weeks 1–2, 3, 4–6, 6.5a (topology shift), 6.5d (claude-sdk runner), 6.5e (`@ax/mcp-client` + `@ax/credentials`). This is where single-host v2 grows into a deployable k8s system.

**Assumes the following are in place:**
- Week 4–6: `@ax/llm-anthropic`, `@ax/tool-bash`, `@ax/tool-file-io`, `@ax/sandbox-subprocess`, `@ax/tool-dispatcher` shipped. IPC primitives in `@ax/core`. `ax.config.ts` loader in `@ax/cli`. Kernel follow-ups from Week 1–2 review (classify regex, max-turns, detectCycles rename).
- Week 6.5a: agent loop runs in a subprocess sandbox via `@ax/ipc-server`, `@ax/session-inmemory`, `@ax/chat-orchestrator`, `@ax/agent-runner-core`, `@ax/agent-native-runner`. Tools refactored to `executesIn: 'sandbox' | 'host'`.
- Week 6.5d: `@ax/agent-claude-sdk-runner` + `@ax/llm-proxy-anthropic-format`. Claude-sdk is the default runner.
- Week 6.5e: `@ax/mcp-client` (host-side MCP hosting) and `@ax/credentials`.

See `docs/plans/2026-04-24-week-6.5-agent-sandbox-design.md` for the topology contract and `docs/plans/2026-04-24-week-6.5e-mcp-client-handoff.md` for MCP scope. MVP direction memo (project memory) supersedes the original plan where they conflict — notably, `@ax/llm-openrouter` and streaming are deferred out of this period.

If any predecessor slice diverged, revisit decisions below.

---

## Goal (architecture doc Section 10)

```
Week 7-9 — Production deployment shapes
  • @ax/sandbox-k8s (port + adapt — per-pod logger, lifecycle reason capture,
    kill-with-reqId all carry over from Task 1-7)
  • @ax/storage-postgres, @ax/eventbus-postgres, @ax/session-postgres
  • @ax/workspace-git (snapshot-oriented, see Section 4.5 contract)
  • Goal: deploy v2 to a real k8s cluster, run a real chat
```

Translation: swap the single-host plugins for their production equivalents. If invariant 1 (transport/storage-agnostic hooks) held in Week 4–6, this slice reuses every subscriber unchanged.

## Deliverables

- `@ax/sandbox-k8s` — replaces `@ax/sandbox-subprocess` for k8s deployments. Same `sandbox:open-session` service hook (from 6.5a). Port from legacy: per-pod logger, lifecycle reason capture, kill-with-reqId. Arch doc explicitly names these as "Task 1-7 work to carry over." Pod image bundles both runner binaries (`@ax/agent-native-runner` + `@ax/agent-claude-sdk-runner`) — config picks which one starts per session.
- `@ax/database-postgres` — Kysely instance factory. Per architecture doc Section 6, a dedicated database plugin provides the connection pool. Stores consume it via `database:get-instance`.
- `@ax/storage-postgres` — replaces `@ax/storage-sqlite`. Same `storage:get` / `storage:set` hooks.
- `@ax/eventbus-postgres` — LISTEN/NOTIFY pub/sub for cross-replica coordination. Same `eventbus:emit` / `eventbus:subscribe` hooks as the (future) in-process impl.
- `@ax/session-postgres` — replaces `@ax/session-inmemory` (from 6.5a). Same `session:*` hooks. Initial schema is session-resolution-only (token + sandbox metadata). `user_id` and `agent_id` columns are added by Week 9.5's migration — design the initial schema additively so 9.5 lands as a forward-only migration.
- `@ax/workspace-git` — **first workspace impl.** Must follow architecture doc Section 4.5 contract exactly: opaque `WorkspaceVersion` (commit SHA wrapped in a branded type), snapshot-oriented, lazy content fetchers in the delta. Runner calls `workspace.commit-notify` **once per turn** with the aggregate diff, not per-tool-call — `@ax/workspace-git` processes one `workspace:pre-apply` per turn. (Rationale: D4 moved secret redaction to `llm:pre-call`, removing the per-tool-commit argument. See MVP direction memo.)
- `@ax/preset-k8s` — meta-package that pins the k8s plugin set (per arch doc Section 9). Includes `@ax/mcp-client` + `@ax/credentials` from 6.5e.

## Scope decisions to make while writing the plan

1. **Section 4.5 workspace contract is the hardest thing in this slice.** The hook surface must not leak git's vocabulary (`sha`, `commit`, `branch`, `bundle`, `ref`). If a subscriber can key off git-specific fields, the GCS impl in Week 13+ will break them. The tests must verify subscriber code is **identical** across backends — write a test-harness `MockWorkspace` plugin that passes the exact same assertions as `@ax/workspace-git`.

2. **`@ax/workspace-git` vs `@ax/workspace-git-http`.** Legacy uses a separate git-server container in k8s for multi-replica. Options:
   - **(a)** Ship only `@ax/workspace-git` (local). Acceptance test is single-replica k8s.
   - **(b)** Ship both — local and http variant. Acceptance test is multi-replica k8s.
   - **Recommendation:** (a). Multi-replica is a hard problem; a single-replica deploy proves the shape. `@ax/workspace-git-http` lands in Week 10+ when multi-replica is actually needed.

3. **In-process eventbus.** `@ax/eventbus-postgres` is the k8s impl. Single-host presets need `@ax/eventbus-inprocess` — is that shipped here or retroactively in Week 4–6? If Week 4–6 didn't need it, ship it here alongside `@ax/eventbus-postgres` so the contract has two impls validating it.

4. **Migration story.** Per architecture doc Section 6: each store plugin owns its tables and migrations. Per-plugin migrations means:
   - `@ax/storage-postgres` owns the `storage` table + its migrations.
   - `@ax/session-postgres` owns the `sessions` table.
   - **No cross-plugin foreign keys.** Enforce in review.
   - Migration runner: each plugin calls `database:get-instance` at init and runs its own migrations against the Kysely instance.

5. **Deploy tooling.** Helm? Kustomize? Raw manifests? Out of scope for the plan itself — whatever legacy uses (`~/dev/ai/ax/deploy/` or similar) is fine. Port, don't design.

6. **Single-host preset still works.** `@ax/preset-local` (Week 4–6) must continue to work unchanged after this slice. The whole point of the plugin model is deploy-shape switching without code changes.

## Security — `security-checklist` required (heavy)

All five packages cross trust boundaries:

- **`@ax/sandbox-k8s`** — k8s API access, pod lifecycle, RBAC. The single biggest blast-radius surface. Escape scenarios: pod-to-node, pod-to-pod, pod-to-control-plane.
- **`@ax/storage-postgres`** — SQL injection (Kysely parametrizes but verify), connection string handling.
- **`@ax/eventbus-postgres`** — LISTEN/NOTIFY channel names (quote properly), payload size limits.
- **`@ax/session-postgres`** — session tokens are sensitive.
- **`@ax/workspace-git`** — path traversal, git protocol attacks if remote refs ever land. Secret scanning at `workspace:pre-apply` is the place to wire in `@ax/scanner-canary` (Week 10–12).

Three threat models apply end-to-end: sandbox escape (pod boundary), prompt injection (still relevant — LLM output reaches the k8s plugin via tool calls), supply chain (Kysely + driver + k8s client are all new deps).

## Legacy helpers to port (read-only `~/dev/ai/ax/`)

This slice is the heaviest port-from-legacy:

- k8s pod lifecycle — correlation IDs, lifecycle reason capture, kill-with-reqId. Arch doc labels this "Task 1-7" — find those commits or files in legacy.
- k8s pod spec template.
- RBAC / service account definitions.
- Postgres schema (as a starting reference; per-plugin ownership means we chop it up).
- Git workspace layout (bare repo vs working tree, how legacy does atomic ref updates).

Do NOT port legacy's orchestration glue — just the adapters and primitives.

## Acceptance test for Week 7–9

Manual: deploy to a real k8s cluster (kind/minikube for dev, real cluster for full verification), send a chat message via the CLI with config pointed at the k8s host, get a response that actually executed a bash tool in a pod. Chat:end event landed in `@ax/audit` (wait, audit is Week 10 — fine, use the logger for now). Workspace write persisted in the git backend.

Automated (CI): mock k8s API, mock postgres (or use testcontainers), exercise the full plugin chain end-to-end on a laptop. Plan for ~30s test runtime — the postgres container overhead is real.

## Kickoff prompt for next session

After `/clear`:

```
Write an implementation plan for Week 7–9 of docs/plans/2026-04-22-plugin-architecture-design.md
(k8s deployment shape). Read docs/plans/2026-04-23-week-7-9-handoff.md first — it flags Section
4.5's workspace contract as the hardest part of the slice, specifies that workspace commits are
turn-end (not per-tool-call), and calls out legacy helpers to port. Read the MVP direction memo
in project memory for context on the claude-sdk runner + MCP client dependencies landing before
this slice. Invoke security-checklist for every package in this slice. Branch off the tip of
6.5e. The plan should be executable via subagent-driven-development.
```
