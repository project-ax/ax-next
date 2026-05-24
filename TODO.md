# TODO — deferred work

Living list of work explicitly punted, parked, or "wait until earned." Anything
without a concrete trigger is a candidate for deletion. When an item ships,
strike it through (or remove it) and reference the closing PR.

Sources scanned (2026-05-19): `MEMORY.md`, recent `docs/plans/*followup*`,
`docs/plans/2026-05-10-memory-strata-roadmap.md`,
`docs/plans/2026-05-08-first-use-onboarding-followup.md`, recent commits, and
`project_codex_findings_2026_04_29.md`.

---

## Parallelization DAG (derived 2026-05-24)

Every open task below carries a stable ID (`ARCH-n`, `CLI-n`, `SYNC-n`,
`FAULTA-n`). This graph tells one agent — or a team of agents — what is safe to
pick up in parallel **right now**, what must be sequenced, and what must not be
started yet.

**How to read it**

- **No edge between two nodes ⇒ they are independent — work them in parallel.** Most of this list is independent; the edges are the exceptions.
- **Solid edge `A --> B`** — land A before B. B builds on a surface A creates (e.g. a schema field).
- **Dashed edge `A -.-> B`** — soft ordering. Coordinate to avoid merge churn (shared hook surface, fold-in, or an assumption B relies on). Not a hard block, but two agents working both at once will collide.
- **⚠ cluster box** — code-independent, but every task in it drives the single `kind-ax-next-dev` cluster. Run them **one at a time** (one agent + one cluster), not concurrently.
- **🚫 trigger box** — deferred-until-earned. Do **not** start until the named trigger fires; the task text states the trigger.

```mermaid
graph TD
    %% Architecture review — parallelizable unless an edge says otherwise
    ARCH1["ARCH-1 · distributed chat stream broker"]
    ARCH2["ARCH-2 · IPC dispatcher dep metadata"]
    ARCH3["ARCH-3 · git bundle wire placement"]
    ARCH4["ARCH-4 · manifest optionalCalls + degradation"]
    ARCH5["ARCH-5 · shared protocol pkgs (sandbox-protocol)"]
    ARCH6["ARCH-6 · require returns schemas (broad surface)"]
    ARCH7["ARCH-7 · refresh architecture doc (do LAST)"]
    ARCH8["ARCH-8 · CI prod bootstrap lane"]
    CLI3["CLI-3 · digest-pin agent image deps"]

    ARCH4 --> ARCH2
    ARCH5 --> ARCH3
    ARCH1 -.-> ARCH6
    ARCH3 -.-> ARCH6
    ARCH5 -.-> ARCH6
    ARCH6 -.-> ARCH7
    CLI3 -.-> CLI2

    subgraph CLUSTER["⚠ manual-acceptance walks — share kind-ax-next-dev, run one at a time"]
        CLI1["CLI-1 · walk B: git clone over Basic-auth (image rebuild)"]
        CLI2["CLI-2 · walk D: npx skill CLI (image rebuild)"]
        SYNC1["SYNC-1 · walk F-2 re-sync (image rebuild)"]
        SYNC2["SYNC-2 · walk F-1 (single-replica deploy)"]
        FA1["FAULTA-1 · walk F2a (image rebuild)"]
        FA4["FAULTA-4 · walk F1+F2b (fast hostPath)"]
    end
    FA1 -.-> FA4

    subgraph BLOCKED["🚫 trigger-gated — do NOT start until trigger fires"]
        CLI4["CLI-4 · per-package registry allowlist"]
        CLI5["CLI-5 · body-split placeholder substitution"]
        CLI6["CLI-6 · CLI cache / pre-warm"]
        CLI7["CLI-7 · Go toolchain support"]
        FA2["FAULTA-2 · host-side runner_session rebind"]
        FA3["FAULTA-3 · turn-end turnId fix"]
        FA5["FAULTA-5 · Faults B/D (tracked in chat-qa-sweep)"]
    end

    classDef blocked fill:#ffe3e3,stroke:#c92a2a,color:#7a1212;
    classDef cluster fill:#fff3bf,stroke:#b8860b,color:#5c4400;
    class CLI4,CLI5,CLI6,CLI7,FA2,FA3,FA5 blocked;
    class CLI1,CLI2,SYNC1,SYNC2,FA1,FA4 cluster;
```

**Parallel batches (actionable now)**

- **Batch 1 — fully independent, fire all at once:** `ARCH-1`, `ARCH-4`, `ARCH-5`, `ARCH-8`, `CLI-3`.
- **Batch 2 — start once the solid-edge parent lands:** `ARCH-2` (after `ARCH-4`'s manifest schema field), `ARCH-3` (after `ARCH-5` sets the protocol-package precedent).
- **Batch 3 — broad cleanup, sequence after the structural moves settle:** `ARCH-6` (edits hook signatures across workspace/sandbox/session/agents/conversations/credentials — coordinate with `ARCH-1`/`ARCH-3`/`ARCH-5` or it churns), then `ARCH-7` (doc refresh, genuinely last — otherwise it just needs a re-refresh).
- **Cluster walks — serialize, any order:** `CLI-1`, `CLI-2`, `SYNC-1`, `SYNC-2`, `FAULTA-1`, `FAULTA-4`. Code-independent, but one cluster. `CLI-2`/`SYNC-1`/`FAULTA-1` each need an agent-image rebuild ([[docker-build-cache-runner-fixes]]); `SYNC-2` needs a single-replica backend deployment; `FAULTA-4` is host-side only (fast hostPath dist loop, no rebuild).

**Not actionable (trigger-gated — leave alone):** `CLI-4`, `CLI-5`, `CLI-6`, `CLI-7`, `FAULTA-2`, `FAULTA-3`, `FAULTA-5`.

---

## Architecture review follow-ups (2026-05-24)

- [ ] **[ARCH-1] Distributed chat stream delivery before multi-replica chat.** `@ax/channel-web` still uses an in-process per-`reqId` SSE chunk buffer, so the web chat surface is single-replica even though the k8s preset has multi-replica-friendly storage/eventbus pieces. Either keep the chat deployment explicitly pinned to one replica, or introduce a stream-broker hook/package backed by Postgres, Redis, or the existing eventbus before claiming multi-replica chat support.
- [ ] **[ARCH-2] Export IPC dispatcher dependency metadata from `@ax/ipc-core`.** `@ax/ipc-http` / `@ax/ipc-server` manifests declare only the obvious session/tool calls, while `@ax/ipc-core` handlers also call workspace, conversation, session-config, and dynamic tool services. Add exported `requiredCalls` / `optionalCalls` / dynamic-pattern metadata from the dispatcher package, spread it into each transport's `manifest.calls`, and add a test that the dispatcher action table and manifest metadata stay in sync. _(Sequence after `ARCH-4` — it owns the manifest `optionalCalls` schema field.)_
- [ ] **[ARCH-3] Revisit git bundle wire placement.** `workspace:apply-bundle` / `workspace:export-baseline-bundle` live in `@ax/core` as optional hooks with git vocabulary, but the runner write path rejects backends that do not implement the bundle wire. Either split this into a git-runner protocol package/action, or define a storage-neutral "runner snapshot transfer" protocol that preserves the current performance/audit wins without making core carry git-specific field names. _(Sequence after `ARCH-5` — follow the protocol-package precedent it sets.)_
- [ ] **[ARCH-4] Add manifest `optionalCalls` with degradation notes.** `bus.hasService(...)` is now a legitimate pattern for feature-gated peers, but it also creates a second implicit dependency graph that bootstrap cannot report. Extend the manifest schema with optional calls plus a short reason/degradation mode, have bootstrap report unsatisfied optional hooks, and let preset tests assert the intended optional surface.
- [ ] **[ARCH-5] Create shared protocol packages for duplicated hook payload schemas.** Start with `@ax/sandbox-protocol`: `ProxyConfig`, installed skills, MCP server specs, and `sandbox:open-session` are structurally duplicated across sandbox backends and already differ in validation strictness. A pure contract package keeps the no-cross-plugin-import rule while preventing schema drift.
- [ ] **[ARCH-6] Require `returns` schemas for public service hooks.** `HookBus` can validate service return values, but most hooks rely on TypeScript-only shape agreement. Roll this out first for IPC-reachable and security/tenant-boundary hooks: workspace, session, agents, conversations, sandbox, and credentials. _(Broad surface — coordinate with `ARCH-1`/`ARCH-3`/`ARCH-5`, which add or move some of those same hooks.)_
- [ ] **[ARCH-7] Refresh the current architecture document.** `docs/plans/2026-04-22-plugin-architecture-design.md` still describes the original core-owned chat loop. Add or replace with a 2026-05 current-state doc that names the host/runner split, `@ax/chat-orchestrator` ownership, IPC action boundaries, transcript/source-of-truth rules, and which hooks are stable vs. transitional. _(Do this LAST — after the other architecture changes settle, or it documents a moving target.)_
- [ ] **[ARCH-8] Add a CI-grade production bootstrap lane.** The k8s acceptance canary imports the production preset but drops Postgres, the real k8s sandbox, HTTP/auth, channel-web, conversations, agents, workspace-git, IPC HTTP, skills, attachments, and other production-bound plugins. Add a Testcontainers/fake-k8s lane that boots closer to `createK8sPlugins`, with the real-cluster walk remaining gated/nightly.

---

## Credentialed CLI tools & git Basic-auth (PR for `worktree-credentialed-cli-and-git-auth`)

Sub-projects **B** (git Basic-auth substitution in the credential-proxy MITM path) + **D** (skill-declared `capabilities.packages` → registry auto-allowlist + `uv`/`uvx`/`python3` in the agent image). Design: `docs/plans/2026-05-22-credentialed-cli-tools-and-git-auth-design.md`. Shipped green + review-clean; deferred items:

- [ ] **[CLI-1] MANUAL-ACCEPTANCE walk (B) — real `git clone` over Basic-auth on kind.** Install a skill declaring `allowedHosts: [gitlab.com]` + a `GITLAB_TOKEN` (`api-key`) credential slot, then have the agent run `git clone https://oauth2:$GITLAB_TOKEN@gitlab.com/<path>.git` and confirm the clone succeeds (the proxy decodes → substitutes → re-encodes the Basic header). Needs `kind-ax-next-dev` up + a real GitLab read token. Covered by unit + MITM integration tests; the cluster walk is the end-to-end proof.
- [ ] **[CLI-2] MANUAL-ACCEPTANCE walk (D) — skill-declared CLI through the proxy on kind.** Install a skill declaring `capabilities.packages.npm: ['@linear/cli']` + `allowedHosts: [api.linear.app]` + a `LINEAR_API_KEY` slot, and confirm the agent can `npx @linear/cli ...` (registry auto-allowlisted to `registry.npmjs.org`, tool fetched on demand, Bearer key substituted by the proxy). The agent **image** changed in this PR (D), so rebuild it (`--no-cache` or verify the compiled image per [[docker-build-cache-runner-fixes]]) before walking.
- [ ] **[CLI-3] Digest-pin the agent image's pinned-by-tag deps.** `uv`/`uvx` is pinned to `ghcr.io/astral-sh/uv:0.11.16` (version tag, not digest). Fold a digest-pin into the existing `tini`/`ca-certificates` digest-pin follow-up so all image deps are content-addressed. Low-risk; do them together.
- [ ] **[CLI-4] Per-package registry allowlisting (vs whole-registry).** D auto-allowlists the *entire* `registry.npmjs.org` / PyPI when an ecosystem is declared (design §5.7 — bounded by the admin-skill trust boundary + session allowlist + canary, acceptable for MVP). A later tightening could restrict egress to the specific declared package paths. Trigger: a tighter supply-chain posture is requested.
- [ ] **[CLI-5] Body-split placeholder substitution across TCP segments (pre-existing, out of scope).** B's `RequestFramer` fixes placeholder substitution for placeholders split across TCP segments in the request **head**; a placeholder split across segments inside a request **body** is still handled only by the per-chunk verbatim path (unchanged from before B). Bearer/api-key creds live in the head, so this rarely bites. Fix only if a real body-credential case appears.
- [ ] **[CLI-6] Cross-session CLI tool caching / pre-warming (design §5.6, deferred).** MVP is per-session ephemeral `npx`/`uvx` fetch (re-fetch latency per session). Add a cache/pre-warm step if the latency becomes a problem. YAGNI now.
- [ ] **[CLI-7] Go toolchain support (design §2/§5.6, deferred).** `packages.go` is rejected with `unsupported-package-ecosystem`. The grammar is shaped to add it (remove from the unsupported set + union a registry host). Trigger: a skill needs a Go CLI AND the ~300 MB+ image weight is acceptable.

## Concurrent-writer re-sync follow-ups (F-1/F-2, PR for `worktree-f1-f2-resync-followups`)

Completes PR #132 (per-turn server-backend re-sync) so the "robust to ANY concurrent writer, ANY backend" guarantee fully holds. Spec: `.claude/prompts/implement-f1-f2-resync-followups.md` + `docs/plans/2026-05-23-chat-transcript-loss-fix-impl.md` §Follow-ups. Shipped green + review-clean; deferred:

- [ ] **[SYNC-1] MANUAL-ACCEPTANCE cluster re-walk (F-2, any backend).** Re-walk PR #132's repro on `kind-ax-next-dev`: new chat → npx turn → attachment-upload turn → reload → assert all turns present, no synthetic `Continue…` turn. F-2 is runner-side (the final/idle commit now re-syncs), so the fast hostPath loop won't cover it — **rebuild the agent image first** (per [[docker-build-cache-runner-fixes]]). Covered by unit + the runner final-commit regression test; the cluster walk is the end-to-end proof.
- [ ] **[SYNC-2] MANUAL-ACCEPTANCE for F-1 needs a single-replica deployment.** F-1 fixes the `@ax/workspace-git` (workspace-git-core) single-replica backend's apply-bundle re-sync. The standard `ax-next-dev` cluster runs the multi-replica `@ax/workspace-git-server` backend (where the mismatch surfaces at *export*, the PR #132 path), so it does NOT exercise F-1's apply-bundle catch. Walk F-1 end-to-end only on a deployment configured with the single-replica backend. Covered by the real-backend integration test (`workspace-commit-notify-core-resync.test.ts`).

## Fault A follow-ups (F1 sticky error row + F2b unsurfaced terminated end — PR for `worktree-fault-a-followups-f1-f2b`)

Completes PR #137 (Fault A: sandbox death mid-turn → error+retry). F1 (client) + F2b (host) shipped here. Handoff: `.claude/prompts/fault-a-followups-f1-f2.md`. Deferred:

- [x] ~~**[FAULTA-0] F2a — runner exits 1 replaying an interrupted transcript on retry.**~~ — fixed (PR #139, merged). A **live SDK repro** (claude-agent-sdk 0.2.119, 2026-05-24) **disproved** the static "truncated / dangling-tool_use" hypothesis: the SDK resume is robust to both a truncated trailing line AND a dangling tool_use. The real crash is `Error: Claude Code returned an error result: No conversation found with session ID: X`, thrown by `query({ resume: X })` whenever the materialized jsonl for X has **no parseable user/assistant message**. Root cause: commits fire only at turn-end, but the host bind (`conversation.store-runner-session`) fired at `system/init` (~1s in, before durability) — a turn killed in that window persisted a `runner_session_id` pointing at nothing → the retry's resume crashed. Fix = (root) defer the bind to the first host-ACCEPTED turn-end commit (`bindRunnerSessionIfNeeded`, fresh-boot only, self-healing) so `runner_session_id` is set IFF a resumable transcript is durable → killed-before-commit leaves it NULL → retry starts fresh; + (defense-in-depth) a `hasResumableTranscript()` resume guard that omits `resume` instead of letting the SDK hard-crash. No host change; once-only bind invariant intact. Covered by unit tests; cluster walk below.
- [ ] **[FAULTA-1] MANUAL-ACCEPTANCE walk (F2a) on kind — image-rebuild loop required.** Runner code is baked into the image ([[docker-build-cache-runner-fixes]]), so the fast hostPath loop won't cover it. Walk: start a NEW chat → during the FIRST turn kill the serving pod (`kubectl -n ax-next-runners delete pod <pod>`) → click retry → assert the retry **completes** (not stuck on "Starting sandbox…", not a crash-loop). Confirm via `kubectl -n ax-next-runners logs <retry-pod>` that there is NO `No conversation found with session ID` and the conversation row's `runner_session_id` is bound only after the turn commits. Auth via [[reference_headless_authed_chat_kind]]. Covered by unit tests (turn-end-uuid + main); the cluster walk is the end-to-end proof.
- [ ] **[FAULTA-2] F2a follow-up: host-side rebind to repair a stale `runner_session_id` (legacy/regression rows).** The F2a resume guard demotes a bound-but-non-resumable session to a fresh start, but cannot rebind the conversation row to the new SDK session id — the host bind is once-only (`conflict` on a different value), so the row stays pointed at the stale id and `conversations:get` shows empty history (repeats every boot). This is reachable ONLY for rows already broken by the pre-fix init-time bind (which used to *crash* — now functional-but-empty) or a future materialize/git regression. Full repair needs a host capability to overwrite `runner_session_id` (e.g. a `conversations:rebind-runner-session` hook + IPC action — safe because the runner only demotes after proving the bound transcript is absent in the materialized workspace), called from the demotion path at the first accepted commit. Pick up if legacy stale rows prove to matter in practice.
- [ ] **[FAULTA-3] Pre-existing (noted during F2a, out of scope): turn-end `turnId` uses the boot `runnerSessionId`, not `transcriptSessionId`** (`main.ts` turn-end emissions). On a fresh first turn `runnerSessionId` is null, so no `turnId` is emitted for that turn's `event.turn-end` (drop-turn / routines silence-token can't refer back to it). Switch those reads to `transcriptSessionId` if a real caller needs first-turn turnIds.
- [ ] **[FAULTA-4] MANUAL-ACCEPTANCE walk (F1 + F2b) on kind.** Host-side TS → fast hostPath dist loop (no image rebuild). F1: any turn-error → red row → start a new turn → assert the row resets to "Thinking…" then hides (no stale stuck row; reload not required). F2b: kill the serving pod mid-turn → click retry → assert the retry either completes (only once F2a is fixed) OR surfaces error+retry again — **never** stuck on "Starting sandbox…". Auth via [[reference_headless_authed_chat_kind]]. Covered by unit tests (orchestrator + sse + agent-status); the cluster walk is the end-to-end proof.
- [ ] **[FAULTA-5] Faults B/D (host bounce / network drop → silent finalize) remain a separate pre-existing finding.** Out of scope for F1/F2b (different root cause — the client synthesizes a `done`-less close and surfaces nothing; a transport `flush()` concern, not an orchestrator-terminated-outcome concern). Tracked by chat-qa-sweep ([[project_chat_qa_sweep_2026_05_23]]).
