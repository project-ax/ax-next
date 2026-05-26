# Context for new brainstorming session: workspace backend redesign

> **For Claude:** This is a context dump for a new brainstorming session. Use the `superpowers:brainstorming` skill to drive that session. Do NOT skip ahead to design or implementation — the goal is to surface options and trade-offs, not pick a winner in the first pass.

## Goal

Design a workspace plugin that:

1. Adheres to the no-leak rule (CLAUDE.md invariant #1; `docs/plans/2026-04-22-plugin-architecture-design.md:187, 245-248`) — no `sha`, `commit`, `branch`, `ref`, `bundle`, `bucket`, `objectName`, `generation`, `parent-array` in hook payloads or subscriber-visible types.
2. Generalizes to non-git backends (next on the radar: GCS / S3 / object stores). Today's `FileChange[]` wire works for any backend; whatever ships must keep that property.
3. Captures the model's filesystem activity completely — not just `Write`/`Edit`/`MultiEdit`, also Bash-tool deletes/moves/writes, and SDK-internal writes (the jsonl gap that surfaced this whole thread).
4. **Exposes workspace diffs as a hook surface** so other plugins can do semantic validation/permission decisions before durable apply. Concrete examples:
   - **Skill validator** — inspects the diff for `.claude/skills/**/SKILL.md` adds/edits and validates YAML frontmatter
   - **Identity validator** — flags any model-driven change to `SOUL.md` / `IDENTITY.md`
   - **Secret scanner** (already designed: `workspace:pre-apply` per `2026-04-24-week-6.5-agent-sandbox-design.md:399`)
   - **Audit log** (`workspace:applied` subscriber)

   This is load-bearing for the design: validators need *path-level* visibility into what changed, with content-on-demand. The wire transport can be opaque bytes (bundle / manifest delta), but the hook surface must canonicalize to a generic shape (`WorkspaceChange[]` with content-fetcher) before firing pre-apply. This is the core reason the "bundle as private codec" framing earns its keep.

## Hard constraints (the five invariants apply)

- **I1 — no storage vocabulary in hook payloads.** This is the load-bearing one for backend-portability. Critical for the `WorkspaceChange[]` generalization: the discriminator field names (e.g. `kind: 'put' | 'delete'`) must stay generic. **Do not** encode backend-specific transport hints as kind variants (`'git-bundle-ref'`, `'gcs-manifest-entry'`) — those leak. Backend-specific transport optimizations live behind an opaque field or in a private side-channel between sandbox importer and host importer.
- **I2 — no cross-plugin imports.** Sandbox-side and host-side plugins talk through the bus only. Adapter pairs (host plugin + sandbox-side bridge) must communicate via IPC, not shared modules.
- **I5 — capabilities minimized.** Sandbox gaining a `git` binary is in-scope to consider; needs to be justified explicitly in the security review.
- Multi-replica host: today solved by a single git-server pod with an in-process mutex. Whatever ships must keep that property or improve it.
- Half-wired-window discipline (`feedback_half_wired_window_pattern.md`): any new wire surface must have a real caller in the same PR.

## Loosened constraints (was/is)

- **Sandbox spin-up latency:** previously assumed "must not regress." **Now: +2-5s on session open is acceptable.** This unblocks designs that seed sandbox-side state at session start (clone a git repo, materialize files from manifest, etc.).
- **Sandbox → host network reach:** previously implicitly constrained to the IPC channel only. **Now: direct HTTP from sandbox to host (or to a host-managed service like a smart-HTTP git endpoint) is acceptable** for workspace operations, so long as it's authenticated and capability-scoped. This re-opens the rejected option (b) from the 04-25 handoff in revised form: the sandbox (not the host) can be the smart-HTTP client, sidestepping the original "no `simple-get` on host" rejection.
- **Git bundles are OK to consider** as a transport codec.
- **Git binary in sandbox image is OK to consider.**

## What's shipped today

**Wire shape:** `workspace.commit-notify` carries `FileChange[]` — `{ path, kind: 'put', content: base64 }` or `{ path, kind: 'delete' }`. Schema at `packages/ipc-protocol/src/actions.ts:111`.

**Server storage:** `@ax/workspace-git-core` runs `isomorphic-git` against a bare repo (`<repoRoot>/repo.git`). Operations used: `init({bare:true})`, `resolveRef`, `listFiles`, `readBlob`, `writeBlob`, `writeTree`, `commit`. Linear-history-only, CAS on `refs/heads/main`, in-process mutex serializes apply.

**Server delivery:** `@ax/workspace-git-http` — pod-side wrapper, JSON-over-HTTP IPC, single replica server.

**Sandbox side:** No local git repo. `workspaceRoot` is just a directory the SDK reads/writes through normal `fs`. The runner observes `Write`/`Edit`/`MultiEdit` via PostToolUse hook (`packages/agent-claude-sdk-runner/src/workspace-diff.ts:31`), reads the resulting bytes, records into a per-turn `DiffAccumulator`. At turn-end (SDK `result` message), accumulator drained → one `workspace.commit-notify` → host applies.

**Sandbox bootstrap:** Today the workspace is treated as the model's scratch space — starts empty per session, accumulates only what the model writes. There is no read-side sync mechanism. With the loosened spin-up budget, this assumption is now revisitable.

## Documented gaps in the shipped design

- **SDK-internal writes invisible.** `.claude/projects/<sessionId>.jsonl`, `.claude.json`, `.claude/backups/`, `.claude/policy-limits.json` — SDK writes these directly. PostToolUse never fires. Never reach the workspace. **This is the load-bearing gap.** Phase C's `runner:read-transcript` plan assumes the jsonl is in the workspace; today it isn't.
- **Bash-tool deletes/moves silently missed.** Documented in `workspace-diff.ts:14-19`.
- **No `.gitignore` semantics.** No working tree exists for `.gitignore` to apply against.
- **No semantic diff hook for validators.** `workspace:pre-apply` exists in the design but has no callers exercising the validator use case yet.

## Prior history (the pivot that's never explicitly documented)

**Original design** (`docs/plans/2026-04-24-week-6.5-agent-sandbox-design.md:386-393`):

- Sandbox owns a real local git repo
- Sandbox commits locally
- `workspace.commit-notify` carries only `{ parentVersion, commitRef, message }` — metadata
- Host pulls the commit via `git-http-backend` from sandbox's git dir
- Sandbox does `git reset --hard parentVersion` if host rejects

**Pivot** between 2026-04-24 and 2026-04-25 to: no sandbox git, raw `FileChange[]` over JSON, isomorphic-git on server.

**Why pivoted (implicit):** The 04-25 handoff (`docs/plans/2026-04-25-workspace-git-http-handoff.md:44-45`) rejects option (b) — "stock git smart-HTTP via git-http-backend + isomorphic-git's `http/node` variant on the host" — for: (1) `simple-get` adds network capability the host's workspace SECURITY.md excludes, (2) `read/list/diff` aren't smart-HTTP ops, (3) bearer-auth uniformity. This (b)-rejection cascades into killing the original design. **Critical update:** with the loosened constraint allowing sandbox→host HTTP, the (b)-rejection no longer cascades. The host doesn't need network capability if the *sandbox* is the one making the smart-HTTP call to a host-managed endpoint.

## Options to evaluate

1. **Targeted-include only** (smallest diff). Just close the jsonl gap: at turn end, runner does sessionId-glob `readdir` + read of `<HOME>/.claude/projects/*/<sessionId>.jsonl`, records as `put` in existing diff-accumulator, ships through existing `FileChange[]` wire. Zero new architecture. Defers Bash-delete and read-side sync. Doesn't address GCS-future or validator-hook requirements at the architectural level (validators can already subscribe to today's `workspace:pre-apply` with `FileChange[]` payload — but coverage is whatever the diff-accumulator catches).
2. **Codex's "bundle as private codec"** (`workspace.submit-proposal` with opaque `{ syncToken, bytes, integrity }` envelope; host-side importer per backend decodes → canonical `WorkspaceChange[]`; bundle never reaches subscribers; host mints durable WorkspaceVersion with backend rules). Architecturally clean, generalizes to GCS, naturally fits validator-hook requirement (importer decodes before firing `pre-apply`). With loosened constraints: sandbox-side git binary is OK, +2-5s spin-up for `git clone` is OK, sandbox→host HTTP for clone is OK.
3. **Sandbox-side git, ships `WorkspaceChange[]` over current wire** (no opaque codec). Sandbox runs git internally for change detection (catches everything: jsonl, Bash-deletes, etc.), converts to canonical `WorkspaceChange[]` *inside the adapter*, ships over the existing `workspace.commit-notify` wire (renamed/extended). Smaller than Codex proposal. Same git-binary cost. Same +2-5s clone cost. No opaque-bytes optimization (every put ships content), but generalizes to GCS the same way at the wire layer. Validator hook fires on `WorkspaceChange[]` directly with no decode step.
4. **Hybrid:** today's wire (`WorkspaceChange[]` puts) for the common case + opt-in opaque-codec for backends that benefit (git can use bundle for transport efficiency on large diffs; GCS can use manifest delta). Adds complexity but lets the wire shape stay simple in the common case.

## WorkspaceChange[] generalization framing (be careful here)

Generalizing `FileChange[]` → `WorkspaceChange[]` to allow git bundles or GCS manifest deltas has two interpretations:

- **(a) Safe:** `WorkspaceChange` stays semantically path-level (`{ kind: 'put' | 'delete', path, contentFetcher }`). The "git bundle / GCS manifest" carrying mechanism is a separate, opaque transport-level envelope (like Codex's `proposal.bytes`) that the importer decodes INTO `WorkspaceChange[]`. Subscribers always see the canonicalized shape.
- **(b) Leaky:** `WorkspaceChange` becomes a discriminated union with variants like `{ kind: 'git-bundle-ref', bundleId }` or `{ kind: 'gcs-manifest-entry', generation }`. Subscribers see backend vocabulary. **This violates I1.** A skill-validator subscriber would have to know how to handle a `'git-bundle-ref'` to look at the actual file changes — it would either fail on GCS, or have to implement a decoder for every backend. That's exactly the leak the architecture forbids.

The brainstorm should commit explicitly to interpretation (a). Bundle / manifest are *transport*, never *shape*.

## Open questions the brainstorm must resolve

1. **Read-side sync at session start.** With +2-5s budget unlocked, what bootstraps the sandbox workspace? Options: full clone via smart-HTTP from a host-managed git endpoint (revives ex-rejected option (b) in valid form), manifest fetch + lazy materialization, FUSE-style on-demand fetch. Affects validator-hook scope: validators may want to compare against initial state.
2. **Multi-backend generalization.** GCS-backend is named as a future. Is it concrete near-term, or still hypothetical? Determines how much the design pays for abstraction now.
3. **Validator hook contract.** Sketch the exact signature. Hypothesis: `workspace:pre-apply(ctx, { parentVersion, changes: WorkspaceChange[], reason }) → { decision: 'allow' | 'veto', reasons?: string[] }`. Each `WorkspaceChange` carries a lazy content fetcher (per architecture-doc Section 4.5 lazy-fetch convention) so validators that don't need bytes don't pay the materialization cost. Verify what shape `workspace:pre-apply` *currently* exposes and whether it needs revision.
4. **Server-side bundle import.** If we adopt option (2), the host-side importer reads bundle bytes into the bare repo. `isomorphic-git` doesn't ship bundle support (verify). Forces one of: spawn `git bundle unbundle` on the server (relitigates "no process spawn" decision in `workspace-git-core/SECURITY.md`), implement bundle parsing in JS, or swap `isomorphic-git` for real git on the server. Naming this trade explicitly is required — it's currently the silent assumption underneath the Codex proposal.
5. **Multi-replica server.** Currently single git-server pod with in-process mutex. SECURITY.md known-bad. Does the new design unblock multi-replica (real CAS via git's `update-ref` lock semantics, requires real git on server), or stay single-replica?
6. **Rollback story.** Original 6.5a used `git reset --hard` for sandbox-side rollback on host rejection. Today's design has no rollback. With sandbox-side git restored, rollback returns. What's the contract for "host rejected; what does the runner do?" — re-attempt? surface to model? hard-fail the turn?
7. **IPC frame cap.** `@ax/core` has a 4 MiB frame cap. Bundle envelopes hit the same ceiling. A workspace with 3 MiB binary churn already breaks today. Does the new design need chunking / streaming?
8. **Bootstrap *durable state* at session open vs. ephemeral.** When the sandbox spins up and clones, where does it clone *from* and *what version*? Latest HEAD on `refs/heads/main`? A specific WorkspaceVersion frozen at conversation create (Phase B `workspaceRef`)? This intersects with the runner-owned-sessions design (`docs/plans/2026-04-29-runner-owned-sessions-design.md`).

## Files to read before brainstorming

**Specs / prior decisions:**

- `docs/plans/2026-04-22-plugin-architecture-design.md` Section 4.5 + lines 187, 245-248
- `docs/plans/2026-04-24-week-6.5-agent-sandbox-design.md:386-415`
- `docs/plans/2026-04-25-workspace-git-http-handoff.md:44-45, 78-91, 99, 115`
- `docs/plans/2026-04-29-runner-owned-sessions-design.md`
- `docs/plans/2026-04-29-phase-c-runner-jsonl-handling-impl.md`
- CLAUDE.md (the five invariants — especially #1 and #5)

**Current code:**

- `packages/workspace-git-core/src/impl.ts`
- `packages/workspace-git-core/SECURITY.md`
- `packages/workspace-git-http/src/plugin.ts`
- `packages/agent-claude-sdk-runner/src/diff-accumulator.ts`
- `packages/agent-claude-sdk-runner/src/workspace-diff.ts:14-19` (Bash-delete gap admission)
- `packages/agent-claude-sdk-runner/src/post-tool-use.ts`
- `packages/ipc-protocol/src/actions.ts` (`workspace.commit-notify` schema)

**Memory entries:**

- `project_workspace_git_http_pr11.md`
- `project_phase_a_spike_done.md`
- `project_phase_b_shipped.md`
