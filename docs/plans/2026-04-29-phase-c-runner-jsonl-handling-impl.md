# Phase C Implementation Plan — runner-side jsonl handling + host-side `runner:read-transcript`

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire the SDK's native session jsonl through the workspace and into a runner-plugin-owned `runner:read-transcript` hook. The runner subprocess captures `system/init.sessionId`, IPCs it back to the host, and uses `query({ resume })` on subsequent spawns. The old replay path (`conversation.fetch-history` → user-message generator) stays alive as a legacy fallback for conversations that haven't been bound yet, so the migration is non-destructive — Phase E deletes the replay code once Phase D switches channel-web over.

**Architecture:**

- **Three PRs, not one.** Phase C touches `@ax/ipc-protocol`, `@ax/ipc-core` dispatcher, `@ax/sandbox-subprocess`, `@ax/agent-claude-sdk-runner`, `@ax/chat-orchestrator`, a new host-side runner plugin package, the CLI preset, and the workspace plugin's ignore-list. Splitting the work into three landing-groups keeps each PR reviewable and lets each ship/revert independently.
  - **PR-A — Read side.** Host-side runner plugin registers `runner:read-transcript`. Workspace ignore-list narrowed to `.claude/projects/`. Closes the *read* half of Phase B's half-wired window.
  - **PR-B — Write side.** Sandbox-side captures `system/init.sessionId` and IPCs it back via new `session.bind-runner-session` action. Dispatcher handler fires `conversations:store-runner-session` (Phase B). Closes the *write* half of Phase B's half-wired window.
  - **PR-C — Resume cutover.** Orchestrator pulls `runnerSessionId` via `conversations:get-metadata` (Phase B) and threads it into `sandbox:open-session`. Sandbox forwards as env. Runner reads, calls `query({ resume })` instead of replaying when set. Replay code stays as the fallback branch.
- **New host-side package: `@ax/agent-claude-sdk-runner-host`.** The existing `@ax/agent-claude-sdk-runner` is sandbox-only (it's a binary spawned by the sandbox provider; the host doesn't load it as a plugin). Phase C introduces a sibling package whose default export is a `Plugin` factory that loads in the host process — same pattern as `@ax/credential-proxy` (host) and `@ax/credential-proxy-bridge` (sandbox-side). The two packages stay coupled by name + by shared knowledge of the SDK's jsonl format. (Single runner per host MVP — D5; the future `@ax/runner-router` plugin will dispatch when a second runner ships.)
- **`CLAUDE_CONFIG_DIR=<workspaceRoot>/.claude`, not HOME redirect.** Phase A's spike originally used HOME. Closer reading of SDK 0.2.119 (`sdk.d.ts:1311`, `sdk.d.ts:3524`) and a quick env-respect test confirm `CLAUDE_CONFIG_DIR` is the canonical override the SDK exposes for "where do session files live." Setting it on the sandbox subprocess lands the jsonl at `<CLAUDE_CONFIG_DIR>/projects/<encoded-cwd>/<sessionId>.jsonl` — same effect as HOME redirect but without polluting HOME for any other tooling that might run in-sandbox. The override happens in `sandbox-subprocess`'s session-env build, NOT in the runner.
- **Host-side reads via SDK's `getSessionMessages` — no custom jsonl parser.** The SDK exports `getSessionMessages(sessionId, options)` which reads from `CLAUDE_CONFIG_DIR` and returns `SessionMessage[]` already filtered to `user|assistant` (system messages opt-in via `includeSystemMessages`). Pagination is built in (`limit`/`offset`), giving us the design doc's deferred `range` parameter for free. We keep our own *projection* from `SessionMessage` to `UITurn` (universal across runners), but the line-by-line parse + bookkeeping filter belong to the SDK.
- **Host-side calls `getSessionMessages` via a per-call tempdir + async mutex.** `workspace:read` is the storage-agnostic byte-fetcher (works for git-backed-but-multi-replica workspaces, future GCS, etc.). Plumbing: fetch jsonl bytes via `workspace:read`, write to a per-call tempdir, point `CLAUDE_CONFIG_DIR` at it, call `getSessionMessages`, clean up. The mutex serializes the env-mutation window; tempdir keeps each call isolated. Adds a few ms of disk I/O per read — fine for sidebar latency and zero cost for cold reads. (Phase A's "sessionId glob, not encoded-cwd reconstruction" worry evaporates: the SDK does the project-dir lookup internally; we just need the bytes.)
- **`UITurn` schema lives in `@ax/ipc-protocol`; SDK's `SessionMessage` is the source format.** The host plugin imports `SessionMessage` type from `@anthropic-ai/claude-agent-sdk` (legitimate — it IS the SDK's host-side counterpart, by design D4). UITurn stays runner-agnostic (any future runner-host plugin produces the same `UITurn[]` from its native format).
- **Replay fallback stays alive through Phase C; Phase E deletes it.** Conversations that existed before Phase C ships have `runner_session_id = NULL`. The runner branches at boot: if `AX_RUNNER_SESSION_ID` is set, use `resume`; otherwise fall back to `conversation.fetch-history` + replay. Both code paths must work in PR-C; equivalence test pins it. Phase E ((`docs/plans/2026-04-29-runner-owned-sessions-design.md` §"Migration sequence")) drops replay once Phase D switches channel-web over.
- **Workspace ignore-list narrows to `.claude/projects/` for the SDK-runner-managed slice.** Phase A surprise: SDK also writes `<HOME>/.claude.json` (~20KB cache), `<HOME>/.claude/backups/.claude.json.backup.<ts>` (accumulates monotonically), `<HOME>/.claude/policy-limits.json`. None are secrets, all are SDK-internal. The workspace plugin's persistence path skips them. (PR-A ships the narrowing.)

**Tech Stack:**

- TypeScript / Node 20+
- Vitest (`.test.ts` per package; testcontainers postgres for the conversations integration tests)
- Zod (IPC schemas in `@ax/ipc-protocol`)
- Claude Agent SDK 0.2.119 — `query({ resume: sessionId })` is the API; `system/init.session_id` is the field on first-turn (SDK type at `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:3105`).
- pnpm workspace + `pnpm build && pnpm test`. Per-package iteration via `pnpm --filter <pkg> test`.

**Out-of-scope (deferred to Phase D / E / F):**

- **Channel-web cutover.** GET `/api/conversations/:id/turns` keeps using `conversations:fetch-history` through Phase C. PR-C wires the SDK-side resume but channel-web's transcript reads stay on the old path. Phase D switches.
- **POST `/api/chat/messages` user-turn append removal.** Phase D / Codex finding 1.
- **Replay-code deletion.** Phase E. The runner keeps both branches through Phase C.
- **`runner:delete-session` cleanup hook.** Open question Q3 in the design doc; not load-bearing for the migration.
- **`@ax/runner-router` plugin.** D5 follow-up. Single-runner-per-host MVP keeps `@ax/agent-claude-sdk-runner-host` registering `runner:read-transcript` directly.
- **Title plugin.** Phase F. Independent track.
- **Multi-runner transcript portability.** Out by design (each runner plugin owns its native format).
- **Investigation of `attachment.skill_listing` injection under `settingSources: []`.** Mildly surprising but doesn't block; tracked in `.claude/memory/context.md` as a known fact.

---

## Reality check — what's already in `@ax/conversations` (post Phase B)

Phase B is the prerequisite for this plan. Before executing Phase C, confirm Phase B has shipped:

```bash
rg -n "conversations:get-metadata|conversations:store-runner-session" packages/conversations/src --no-heading
rg -n "runner_type|runner_session_id|workspace_ref|last_activity_at" packages/conversations/src/migrations.ts --no-heading
```

Expected: both hooks register; all four columns present in the migration. If not, STOP and finish Phase B first.

## Reality check — what's already in `@ax/agent-claude-sdk-runner` (sandbox-side)

| Surface | Today (`packages/agent-claude-sdk-runner/src/main.ts`) | PR-B work |
|---|---|---|
| `readRunnerEnv` | Reads `AX_RUNNER_ENDPOINT, AX_SESSION_ID, AX_AUTH_TOKEN, AX_WORKSPACE_ROOT, AX_PROXY_*` | **Add** `AX_RUNNER_SESSION_ID` (optional). `CLAUDE_CONFIG_DIR` is set by the sandbox provider; the runner doesn't need to read it directly (the SDK reads it). |
| `query({ ... })` call site | `main.ts:309-354`. Options include `cwd, env, settingSources: [], hooks, ...`. No `resume`. | **Add** conditional `resume: env.runnerSessionId` (PR-C) |
| `userMessages()` generator | `main.ts:250-300`. Replays `replayTurns` (from `conversation.fetch-history`) then drains the live inbox. | **PR-C: skip replay** when `resume` is in use |
| `conversation.fetch-history` IPC call | `main.ts:154-166` | **PR-C: gate** behind `runnerSessionId === undefined` |
| `system/init` capture | NOT CAPTURED today. The SDK iterator yields a `system` message with `subtype === 'init'` carrying `session_id` (SDK 0.2.119 — `assistant.mjs` minified; verified in Phase A spike). | **PR-B: capture** `session_id` from first `system/init` message; IPC back via new `session.bind-runner-session`. |
| `CLAUDE_CONFIG_DIR` env | Not set today (SDK falls back to homedir). | **PR-B: set** to `<workspaceRoot>/.claude` in sandbox-subprocess's session-env build. The SDK then writes session jsonl under `<workspaceRoot>/.claude/projects/<encoded-cwd>/`. |

## Reality check — what's already in `@ax/sandbox-subprocess`

| Surface | Today | Phase C work |
|---|---|---|
| `allowlistFromParent` | `env.ts:14-23`. Allowlists `PATH, HOME, LANG, LC_ALL, TZ, NODE_OPTIONS` | **No change** — HOME stays as the parent's HOME. The SDK reads `CLAUDE_CONFIG_DIR` separately. |
| `sessionEnv` build | `open-session.ts:246-307`. Sets `AX_RUNNER_ENDPOINT, AX_SESSION_ID, AX_AUTH_TOKEN, AX_WORKSPACE_ROOT, AX_PROXY_*` | **PR-B: add** `CLAUDE_CONFIG_DIR = <input.workspaceRoot>/.claude` (when input.runnerKind === 'claude-sdk'). **PR-C: pass** `AX_RUNNER_SESSION_ID = input.runnerSessionId` (optional). |
| `sandbox:open-session` input shape | (locate at `packages/ipc-protocol/src/actions.ts` for SandboxOpenSessionRequest, OR an internal type at `sandbox-subprocess/src/open-session.ts`) | **PR-B: add** `runnerKind?: 'claude-sdk'` (optional, default behavior unchanged for absent). **PR-C: add** `runnerSessionId?: string` |

## Reality check — what's already in `@ax/chat-orchestrator`

| Surface | Today (`packages/chat-orchestrator/src/orchestrator.ts`) | PR-C work |
|---|---|---|
| `sandbox:open-session` call | `orchestrator.ts:778+` | **PR-C: prepend** `conversations:get-metadata` lookup; pass `runnerSessionId` + `runnerKind` into the open-session payload |
| Conversation context | Already threaded — orchestrator knows `ctx.conversationId` | **PR-C: read** runnerSessionId from metadata when conversationId is set |

## Reality check — what's already in `@ax/ipc-core` dispatcher

`packages/ipc-core/src/dispatcher.ts:67-79` has a hard-coded action-name map:

```ts
ACTIONS.set('/tool.pre-call', ...);
ACTIONS.set('/tool.execute-host', ...);
ACTIONS.set('/tool.list', ...);
ACTIONS.set('/workspace.commit-notify', ...);
ACTIONS.set('/session.get-config', ...);
ACTIONS.set('/conversation.fetch-history', ...);
```

PR-B adds `/session.bind-runner-session` next to `/session.get-config`.

## Reality check — workspace plugin

```bash
rg -n "\\.claude/projects|ignore|excludePaths" packages/workspace-git-http/src --no-heading | head
```

(Run during Task A1 to confirm what the ignore mechanism looks like — the design assumes one exists; if not, PR-A introduces it.)

---

## Reference material

Files this plan touches (read before editing):

| File | Purpose |
|---|---|
| `packages/agent-claude-sdk-runner/src/main.ts:80-150, 250-300, 309-354` | Boot flow, replay generator, query() call site |
| `packages/agent-claude-sdk-runner/src/env.ts` | RunnerEnv type + `readRunnerEnv` |
| `packages/sandbox-subprocess/src/env.ts:14-23` | Parent-process env allowlist (HOME source) |
| `packages/sandbox-subprocess/src/open-session.ts:235-310` | Session env build |
| `packages/ipc-protocol/src/actions.ts:182-260` | session.get-config + conversation.fetch-history schemas (model the new bind action on these) |
| `packages/ipc-core/src/dispatcher.ts:67-79` | Action name registration |
| `packages/chat-orchestrator/src/orchestrator.ts:746-790` | Sandbox open-session call site |
| `packages/conversations/src/types.ts` | `GetMetadataInput`/`Output`, `StoreRunnerSessionInput`/`Output` (Phase B exports) |
| `packages/cli/src/main.ts:88-110` | Plugin load order; runner-binary resolution |
| `presets/k8s/src/index.ts` | Mirrored plugin load |
| `packages/workspace-git-http/src/...` | Workspace persistence + ignore mechanism (TBD — survey first) |
| `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:3093-3132` | SDKSystemMessage shape; `init` carries `session_id` |
| `docs/plans/2026-04-29-runner-owned-sessions-design.md` | Authoritative for the architecture; this plan implements §"Phase C" + §"Component responsibilities" |
| `docs/plans/2026-04-29-phase-b-conversations-metadata-impl.md` | Defines the hooks PR-A and PR-B call into |
| `.claude/memory/patterns.md` | sessionId-glob pattern (2026-04-29) + jsonl whitelist pattern (2026-04-29) |
| `.claude/memory/context.md` | SDK realpath-encoded cwd (2026-04-29) + extra-files-under-HOME list (2026-04-29) |

**Reference patterns already in the codebase:**

- Host/sandbox plugin pair: `@ax/credential-proxy` (host) + `@ax/credential-proxy-bridge` (sandbox-side). Mirror the package-pair shape for `@ax/agent-claude-sdk-runner-host` + `@ax/agent-claude-sdk-runner`.
- New IPC action skeleton: `session.get-config` (`packages/ipc-protocol/src/actions.ts:182-229`) is the simplest example — request/response zod schemas + dispatcher handler that fires a bus call.
- Workspace plugin persistence pattern: TBD (Task A1 surveys it).
- Boundary-review template: `docs/plans/2026-04-29-phase-3-pr-notes.md`.
- Per-package test invocation: `pnpm --filter <pkg> test`.

---

## Invariants (verified per task)

These reflect Phase A spike findings (`.claude/memory/`), the design doc's I-NEW-1..4, ax-next's five invariants (CLAUDE.md), and lessons from prior phases.

- **I1 — `runner:read-transcript` is host-side, NOT sandbox-side.** Reads must work for closed conversations + sidebar rendering must not require subprocess startup. (Design D2.) The host-side plugin loads in the host process; its hook handler reads jsonl directly via `workspace:read`. *Prevents:* an architecture where transcript reads require a live runner sandbox.
- **I2 — `workspaceRef` is frozen at conversation create (Phase B), used at read time (Phase C).** Older conversations whose agent's workspaceRef changes after-the-fact stay readable from the originally-frozen ref. (Design D3 / I-NEW-3.) *Prevents:* a sidebar that goes blank when an agent's pointer moves.
- **I3 — Single-runner-per-host MVP; no router plugin yet.** `@ax/agent-claude-sdk-runner-host` registers `runner:read-transcript` directly. A future `@ax/runner-router` will dispatch when a second runner ships. (Design D5.) *Prevents:* premature dispatch infrastructure that earns nothing today.
- **I4 — `runner:read-transcript` payload carries no backend vocabulary.** No `jsonl_path`, no `sdk_session_id` field name, no `git_sha` in output. Generic `UITurn[]` with `role`, `contentBlocks`, `turnIndex`, `timestamp`. (CLAUDE.md invariant #1.) *Prevents:* a leak that would force every subscriber to update when a future runner ships.
- **I5 — Host-side reads via SDK's `getSessionMessages`, not a custom parser.** The SDK is the authoritative source for jsonl format. `getSessionMessages` already handles the project-dir lookup (so the realpath-encoded-cwd gotcha from Phase A goes away — the SDK resolves it internally) AND already filters bookkeeping kinds. We project `SessionMessage[] → UITurn[]` and stop. *Prevents:* parser drift when SDK adds new bookkeeping kinds; parser bugs on edge cases the SDK's internal tests already cover.
- **I6 — `CLAUDE_CONFIG_DIR`, not HOME redirect.** The SDK exposes `CLAUDE_CONFIG_DIR` as the canonical "where do session files live" knob (`sdk.d.ts:1311`, `sdk.d.ts:3524`). Cleaner than HOME redirect: targeted, doesn't pollute HOME for any in-sandbox tooling. Sandbox-side: env-set in `sandbox-subprocess`. Host-side: per-call mutation under an async mutex (see I12). *Prevents:* HOME-pollution side effects; works for any future SDK change to where-files-live (we only need to honor CLAUDE_CONFIG_DIR, not reverse-engineer the path).
- **I7 — Workspace persistence ignore-list keeps only `.claude/projects/`.** SDK writes `<HOME>/.claude.json` (~20KB), `<HOME>/.claude/backups/*.backup.<ts>` (accumulates), `<HOME>/.claude/policy-limits.json`. (Memory: `context.md` 2026-04-29.) *Prevents:* monotonic workspace growth + churn-noise in commits.
- **I8 — `session.bind-runner-session` is once-per-conversation, idempotent for same value, conflict for mismatch.** Mirrors Phase B's `conversations:store-runner-session` posture. (Phase B I7.) The dispatcher handler fires the bus hook; the bus hook makes the policy decision. *Prevents:* a runner-side bug that double-binds and silently overwrites the sessionId, leaving an orphan jsonl.
- **I9 — `CLAUDE_CONFIG_DIR` override happens in sandbox-subprocess, not in the runner.** By the time the runner spawns, `process.env.CLAUDE_CONFIG_DIR` is already pointed at `<workspaceRoot>/.claude`. The runner doesn't know about the override mechanism — it just calls `query()` and the SDK reads its own env. (Design §"Component responsibilities".) *Prevents:* coupling the runner to sandbox-provider details.
- **I10 — Replay code stays alive through Phase C.** Pre-Phase-C conversations have `runner_session_id = NULL`; their runner falls back to `conversation.fetch-history` + replay. Both branches operative side-by-side. Equivalence test pins it. (Design §"Phase C".) *Prevents:* a forced backfill of legacy conversations + a half-finished migration.
- **I11 — `query({ resume: sessionId })` triggers ONLY when `AX_RUNNER_SESSION_ID` env is set AND non-empty.** The presence of the env var IS the signal. Empty string falls back to replay. (Design D7.) *Prevents:* a wiring bug where the orchestrator passes empty-string and the runner enters resume mode against a non-existent session.
- **I12 — Host-side `getSessionMessages` calls serialize through an async mutex.** Per-call CLAUDE_CONFIG_DIR mutation is a process-wide write; concurrent reads against different workspaces would race. The runner-host plugin owns a single async mutex; every `runner:read-transcript` call acquires it, sets `process.env.CLAUDE_CONFIG_DIR`, calls `getSessionMessages`, restores prior value, releases. Tempdir per call is set up before mutex entry; cleanup is best-effort after release. *Prevents:* env-mutation races; cross-workspace bleed-through of CLAUDE_CONFIG_DIR.
- **I13 — `system/init.session_id` is captured ONCE per runner lifecycle.** The first system/init message carries `session_id`; subsequent system messages don't. The runner stores it in a closure, IPCs once, and ignores subsequent inits. *Prevents:* duplicate IPC calls on every system message.
- **I14 — bind IPC is fire-and-forget after first attempt; runner does not block on failure.** If the host is gone, the runner's transcript stays on disk anyway and a future spawn will try again. Logging at warn, not failing the runner. *Prevents:* a dead host taking down a healthy runner mid-turn.
- **I15 — Half-wired-window discipline applies.** Phase B opened the window for `conversations:get-metadata` + `conversations:store-runner-session`. PR-A closes the read half (the `runner:read-transcript` hook fires `conversations:get-metadata` for workspaceRef lookup). PR-B closes the write half (the `bind-runner-session` IPC handler calls `conversations:store-runner-session`). PR-C must not merge unless PR-B has shipped. PR-A can ship standalone (read-only). *Prevents:* a longer-than-necessary half-wired window.
- **I16 — `pnpm build && pnpm test` green at every commit boundary.** Each PR has its own commit cadence; each commit leaves the workspace green. (Standard.)
- **I17 — No cross-plugin imports between `@ax/agent-claude-sdk-runner-host` and `@ax/agent-claude-sdk-runner`.** Host-side and sandbox-side are separate packages. Shared *types* live in `@ax/ipc-protocol` (where they already live for `ConversationFetchHistoryTurn` etc.). Shared *constants* (e.g. the `RUNNER_TYPE_NAME = 'claude-sdk'` string) get duplicated, not shared. (CLAUDE.md invariant #2; same posture Phase B took for `WORKSPACE_REF_RE`.) `@ax/agent-claude-sdk-runner-host` IS allowed to import the `SessionMessage` type from `@anthropic-ai/claude-agent-sdk` (the SDK is a third-party dep, not a sibling plugin). *Prevents:* the lint-rule violation that would block merge.
- **I18 — `UITurn` schema lives in `@ax/ipc-protocol`.** Single source of truth (CLAUDE.md invariant #4). Both `runner:read-transcript`'s output schema AND any future channel-web consumer share it. *Prevents:* divergent shapes between runner plugins.

---

## Open questions resolved before execution

1. **One package or two for the runner plugin?** **Two.** `@ax/agent-claude-sdk-runner-host` (new, Phase C) for the host-loaded plugin; `@ax/agent-claude-sdk-runner` (existing) for the sandbox binary. Mirrors `@ax/credential-proxy` + `@ax/credential-proxy-bridge`. Cross-package imports forbidden (I16); shared types via `@ax/ipc-protocol`.
2. **Where does the redirect happen, and which env var?** **`CLAUDE_CONFIG_DIR = <workspaceRoot>/.claude` in `@ax/sandbox-subprocess` open-session.** See I9. The runner doesn't know about it; the sandbox provider sets it in the child env when `input.runnerKind === 'claude-sdk'`. HOME stays untouched (parent's HOME inherited via the existing allowlist). `CLAUDE_CONFIG_DIR` is the SDK's purpose-built knob (`sdk.d.ts:1311`, `sdk.d.ts:3524`), preferred over HOME redirect because it's targeted and can't surprise other in-sandbox tooling.
3. **Should the SDK runner stay backward-compatible with no `CLAUDE_CONFIG_DIR` set?** **No, but defensively.** Phase A confirmed the SDK lands files where we expect when CLAUDE_CONFIG_DIR is set. The orchestrator always passes `runnerKind: 'claude-sdk'` for SDK runners (PR-C wires this), so the override always fires. We do NOT keep a "no CLAUDE_CONFIG_DIR" mode toggle — that would be a half-wired flag with no caller.
4. **What about when the workspace plugin isn't loaded?** **Runner stays alive; transcript is in-memory only and lost on exit.** The SDK still writes the jsonl to `<HOME>/.claude/projects/...`, but with no workspace persistence behind it, the file goes away when the sandbox exits. `runner:read-transcript` returns empty turns. This is the canary acceptance test path; it shouldn't break.
5. **Does the runner need to know its own runnerSessionId to send `bind-runner-session`?** **It captures from `system/init.session_id` and IPCs back.** Single source of truth — the SDK is the source. Runner ≠ orchestrator ≠ host DB. The IPC carries the captured value to the host, which writes via `conversations:store-runner-session`.
6. **What if `system/init` doesn't fire (e.g. SDK boot error)?** **Bind never happens; conversation stays at `runner_session_id = NULL` and falls back to replay on next spawn.** Acceptable: an aborted boot is already a failure mode the runner reports separately. The next successful spawn re-binds.
7. **Where does the `RUNNER_TYPE_NAME` constant live?** **In `@ax/agent-claude-sdk-runner-host` as a package-local constant; mirrored in CLI preset config; passed to `@ax/conversations` via `defaultRunnerType`.** The string `'claude-sdk'` is the public identifier shared by all three places (CLAUDE.md invariant #4 — single source of truth, NOT a shared package). Each duplicate is 1 line; a shared package would be premature.
8. **Does `runner:read-transcript` need the `range` parameter (afterTurnIndex / limit) from the design doc?** **No, defer.** MVP returns the full transcript. Pagination earns its weight when sidebar / channel-web pulls long conversations on first load and we measure latency. Deferred to a follow-up; not load-bearing for the migration.
9. **What's the `UITurn.timestamp` source?** **Try `SessionMessage.message.timestamp` if the SDK populates it; otherwise empty string.** SDK 0.2.119 jsonl entries carry a `timestamp` field on most rows (Phase A spike). Inspect what `getSessionMessages` actually surfaces during Task A4 — the projection function reads whatever the SDK gives us. Caller (channel-web) treats empty as "unknown."
10. **What's the `UITurn.turnIndex` source?** **The array position in `getSessionMessages`'s return value.** SDK returns messages in file order; we project 1:1 (with optional pagination via `limit`/`offset`). `turnIndex` is the offset-adjusted ordinal.
11. **Where does the workspace plugin's ignore-list live?** **TBD — survey in Task A1.** If it doesn't have a generic mechanism, PR-A adds one. If it does, PR-A registers `.claude.json`, `.claude/backups/`, `.claude/policy-limits.json` against it.
12. **Does the runner-host plugin need any config?** **No.** The hook handler reads jsonl bytes via `workspace:read` (passes through the frozen `workspaceRef` directly — the workspace plugin handles resolution), writes to a per-call tempdir, points `CLAUDE_CONFIG_DIR` at the tempdir, calls `getSessionMessages`. No workspace-root resolver hook needed. Verify the `workspace:read` signature in Task A1.
13. **What about the `attachment.skill_listing` injection under `settingSources: []`?** **Tracked but not blocking.** Phase A surprise. The runner-host's parser drops `attachment` rows (I6 whitelist), so they don't surface to consumers. If the SDK eventually offers a knob to suppress the injection, we revisit. Until then, no action needed.
14. **PR ordering: A → B → C, OR C → B → A?** **A → B → C.** PR-A is read-only (lowest risk, ships first). PR-B closes the write half but doesn't change the runner's resume behavior — replay still wins. PR-C is the cutover: orchestrator passes runnerSessionId, runner uses resume. Each PR is shippable on its own; reverting any one doesn't break the others.
15. **What's the equivalence test for replay vs resume (I10)?** **Same conversation, same fixture, two end-to-end runs:** run #1 with `runner_session_id = NULL` (forces replay path); run #2 with `runner_session_id = <jsonl session>` (forces resume). Both should reach the same chat-end outcome with the same model output (modulo non-determinism — pin to a deterministic mock LLM in the test).
16. **What does `runner:read-transcript` return for a conversation without a workspaceRef?** **Empty `{ turns: [], hasMore: false }`.** A conversation without a workspace can't have jsonl on disk; nothing to read. (See Phase B Q15: "frozen as null" is a valid state.)
17. **What does `runner:read-transcript` return for a tombstoned conversation?** **`PluginError({ code: 'not-found' })`.** Mirrors `:get-metadata`'s posture; same ACL gate (the host-side plugin calls `conversations:get-metadata` first).

---

## PR-A — Host-side `runner:read-transcript` + workspace ignore-list

**Goal:** Land the read half. New package `@ax/agent-claude-sdk-runner-host` registers `runner:read-transcript`. Workspace plugin's ignore-list narrows so SDK auxiliary files don't bloat the workspace tree. Closes the read half of Phase B's half-wired window.

**Branch suggestion:** `feat/phase-c-pr-a-runner-read-transcript`.

### Task A1: Survey + commit baseline

**Goal:** Confirm Phase B has shipped; survey the workspace plugin's ignore mechanism.

```bash
pnpm build && pnpm test
rg -n "conversations:get-metadata|conversations:store-runner-session" packages/conversations/src --no-heading
rg -n "runner_type|runner_session_id|workspace_ref|last_activity_at" packages/conversations/src/migrations.ts --no-heading
ls packages/workspace-git-http/src/
rg -n "ignore|exclude|skipPath|\\.claude" packages/workspace-git-http/src --no-heading | head -20
```

Expected: Phase B hooks present; workspace plugin layout visible. If Phase B isn't shipped, STOP. If the workspace plugin has no ignore mechanism, fold the introduction of one into Task A6 below.

**No commit** — read-only verification.

### Task A2: Add `UITurn` to `@ax/ipc-protocol`

**Goal:** Single source of truth for the universal turn shape (I17).

**Files:**
- Modify: `packages/ipc-protocol/src/content-blocks.ts` OR new `packages/ipc-protocol/src/ui-turn.ts`
- Modify: `packages/ipc-protocol/src/index.ts` (re-export)
- Test: `packages/ipc-protocol/src/__tests__/ui-turn.test.ts`

**Step A2.1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { UITurnSchema, type UITurn } from '../index.js';

describe('UITurn schema', () => {
  it('accepts a minimal user turn', () => {
    const t: UITurn = {
      role: 'user',
      contentBlocks: [{ type: 'text', text: 'hi' }],
      turnIndex: 0,
      timestamp: '',
    };
    expect(UITurnSchema.parse(t)).toEqual(t);
  });
  it('accepts assistant turn with thinking + tool_use', () => {
    UITurnSchema.parse({
      role: 'assistant',
      contentBlocks: [
        { type: 'thinking', thinking: 'plan' },
        { type: 'tool_use', id: 'tu1', name: 'Bash', input: {} },
      ],
      turnIndex: 1,
      timestamp: '2026-04-29T12:00:00Z',
    });
  });
  it('rejects unknown role', () => {
    expect(() => UITurnSchema.parse({
      role: 'system', contentBlocks: [], turnIndex: 0, timestamp: '',
    })).toThrow();
  });
});
```

Run: `pnpm --filter @ax/ipc-protocol test -- ui-turn.test`
Expected: FAIL — schema doesn't exist.

**Step A2.2: Add the schema**

```ts
// packages/ipc-protocol/src/ui-turn.ts
import { z } from 'zod';
import { ContentBlockSchema } from './content-blocks.js';

/**
 * Universal UI-facing turn shape. Returned by `runner:read-transcript`
 * regardless of which runner plugin produced the underlying jsonl. The
 * runner plugin parses its native format (e.g. SDK jsonl for claude-sdk;
 * pi sessions for native) and projects to this shape. Channel-web and
 * other consumers see only this — they don't learn either format.
 *
 * Field-name conventions (CLAUDE.md invariant #1):
 *   - `role` — runner-agnostic.
 *   - `contentBlocks` — same Anthropic-compatible schema we use everywhere.
 *   - `turnIndex` — generic ordinal, not a JSONL line number.
 *   - `timestamp` — ISO-8601 string when known, empty string otherwise.
 *     Empty is "unknown" — caller renders as "—" or skips.
 */
export const UITurnSchema = z.object({
  role: z.enum(['user', 'assistant', 'tool']),
  contentBlocks: z.array(ContentBlockSchema),
  turnIndex: z.number().int().min(0),
  timestamp: z.string(),
});
export type UITurn = z.infer<typeof UITurnSchema>;
```

And re-export from `index.ts`.

**Step A2.3: Run tests**

```bash
pnpm --filter @ax/ipc-protocol test
pnpm build
```

Expected: PASS.

**Step A2.4: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(ipc-protocol): add UITurn schema for runner:read-transcript

Single source of truth (I17) for the universal turn shape produced by
all runner plugins' :read-transcript hooks. Channel-web sees this; the
SDK jsonl format never reaches the UI directly.

Invariants: I4 (no backend vocab), I17 (single source of truth).
EOF
)"
```

### Task A3: Scaffold `@ax/agent-claude-sdk-runner-host` package

**Goal:** New package with the same shape as other host-side plugins.

**Files:**
- Create: `packages/agent-claude-sdk-runner-host/package.json`
- Create: `packages/agent-claude-sdk-runner-host/tsconfig.json`
- Create: `packages/agent-claude-sdk-runner-host/src/index.ts` (placeholder export of `createAgentClaudeSdkRunnerHostPlugin`)
- Create: `packages/agent-claude-sdk-runner-host/SECURITY.md` (per `patterns.md` 2026-04-23)

**Step A3.1: Write the package.json**

Mirror the shape of `packages/credential-proxy/package.json`. Dependencies: `@ax/core`, `@ax/ipc-protocol`, `zod`. Dev dependencies: `@ax/test-harness` (if needed), `vitest`, `typescript`.

```json
{
  "name": "@ax/agent-claude-sdk-runner-host",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc --build",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@ax/core": "workspace:*",
    "@ax/ipc-protocol": "workspace:*",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^25.6.0",
    "typescript": "^6.0.3",
    "vitest": "^4.1.4"
  }
}
```

**Step A3.2: Write the placeholder plugin**

```ts
// packages/agent-claude-sdk-runner-host/src/index.ts
import type { Plugin } from '@ax/core';

const PLUGIN_NAME = '@ax/agent-claude-sdk-runner-host';

/**
 * Host-side plugin for the Claude Agent SDK runner. Loads in the host
 * process; registers `runner:read-transcript` so callers (channel-web,
 * sidebar) can read the jsonl the sandbox-side runner persisted into the
 * workspace.
 *
 * Companion to `@ax/agent-claude-sdk-runner` (the sandbox binary). The
 * two packages stay coupled by name + by shared knowledge of the SDK's
 * jsonl format. Cross-package imports forbidden (CLAUDE.md invariant
 * #2); shared types via `@ax/ipc-protocol`.
 *
 * Single-runner-per-host MVP (design D5). When a second runner ships, an
 * `@ax/runner-router` plugin will register `runner:read-transcript`
 * itself and dispatch to runner-typed hooks
 * (`runner.claude-sdk:read-transcript`, ...).
 */
export function createAgentClaudeSdkRunnerHostPlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['runner:read-transcript'],
      calls: ['conversations:get-metadata', 'workspace:read'],
      subscribes: [],
    },
    async init({ bus }) {
      // Filled in Task A4.
      void bus;
    },
    async shutdown() { /* nothing to clean up yet */ },
  };
}
```

**Step A3.3: Write the SECURITY.md**

Mirror `packages/storage-sqlite/SECURITY.md`'s shape. Threats:

- **Untrusted-content (jsonl)** — the SDK writes turn content from the model. Reader treats every `text` / `thinking` / `tool_use.input` / `tool_result.content` field as untrusted (CLAUDE.md invariant #5). Renderer (channel-web) sanitizes; this plugin's job is parse+project, no execution.
- **Path traversal** — `workspaceRef` is regex-validated upstream (`@ax/agents`, mirrored in `@ax/conversations`). The host plugin still sanitizes by passing through `workspace:read`, NOT raw `fs.readFile`. (CLAUDE.md invariant #5.)
- **Sandbox boundary** — N/A; this is a host-side plugin that reads via the workspace plugin. The actual sandbox concerns are in `@ax/agent-claude-sdk-runner` (sandbox-side).

**Step A3.4: Add to root tsconfig refs (if applicable) + pnpm-workspace**

Verify `pnpm-workspace.yaml` already covers `packages/*`; the new package picks up automatically.

```bash
pnpm install  # link the new workspace package
pnpm build    # confirm builds
```

Expected: PASS (placeholder plugin compiles; nothing registers yet so no test fails).

**Step A3.5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(agent-claude-sdk-runner-host): scaffold package + SECURITY.md

New host-side plugin package, sibling to @ax/agent-claude-sdk-runner
(sandbox binary). Registers runner:read-transcript (Task A4 fills the
handler). Mirrors the @ax/credential-proxy + @ax/credential-proxy-bridge
pair shape.

Invariants: I1 (host-side, not sandbox-side), I3 (single-runner MVP),
I16 (no cross-plugin imports between host/sandbox sibling packages).
EOF
)"
```

### Task A4: Implement the `runner:read-transcript` handler

**Goal:** The hook returns `UITurn[]` from the SDK jsonl, sourced via `getSessionMessages`. Tests pin: SDK-mediated read, ACL via `:get-metadata`, empty for missing workspace, not-found for tombstone, mutex serializes concurrent reads.

**Files:**
- Modify: `packages/agent-claude-sdk-runner-host/src/index.ts`
- Create: `packages/agent-claude-sdk-runner-host/src/read-session.ts` (the `getSessionMessages` wrapper + tempdir + mutex)
- Create: `packages/agent-claude-sdk-runner-host/src/project-to-ui-turn.ts` (`SessionMessage[] → UITurn[]`)
- Create: `packages/agent-claude-sdk-runner-host/src/__tests__/project-to-ui-turn.test.ts`
- Create: `packages/agent-claude-sdk-runner-host/src/__tests__/read-transcript.test.ts`
- Modify: `packages/ipc-protocol/src/index.ts` (add `RunnerReadTranscriptInput`/`Output` if these aren't already there; the design doc names them but they may need to be added here)
- Modify: `packages/agent-claude-sdk-runner-host/package.json` — add `@anthropic-ai/claude-agent-sdk` as a dependency (same version-pin as `@ax/agent-claude-sdk-runner`).

**Step A4.1: Define the hook payload types**

In `@ax/ipc-protocol` (or in `@ax/agent-claude-sdk-runner-host` if cleaner; design says the shape is shared with future runner plugins, so `@ax/ipc-protocol` is right):

```ts
export const RunnerReadTranscriptInputSchema = z.object({
  conversationId: z.string().min(1).max(256),
  userId: z.string().min(1),
}).strict();
export type RunnerReadTranscriptInput = z.infer<typeof RunnerReadTranscriptInputSchema>;

export const RunnerReadTranscriptOutputSchema = z.object({
  turns: z.array(UITurnSchema),
  hasMore: z.boolean(),  // always false in MVP; reserved for pagination
});
export type RunnerReadTranscriptOutput = z.infer<typeof RunnerReadTranscriptOutputSchema>;
```

**Step A4.2: Write the failing projection test**

```ts
// project-to-ui-turn.test.ts
import { describe, it, expect } from 'vitest';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { projectSessionMessagesToUITurns } from '../project-to-ui-turn.js';

describe('projectSessionMessagesToUITurns', () => {
  it('maps user/assistant SessionMessage[] to UITurn[]', () => {
    const msgs: SessionMessage[] = [
      // SDK shape — message field is `unknown` per type, but in practice
      // carries Anthropic-compatible { role, content: ContentBlock[] }
      { type: 'user', uuid: 'u1', session_id: 's1', parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
      { type: 'assistant', uuid: 'u2', session_id: 's1', parent_tool_use_id: null,
        message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
    ];
    const turns = projectSessionMessagesToUITurns(msgs, { offset: 0 });
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(turns[0]?.turnIndex).toBe(0);
    expect(turns[1]?.turnIndex).toBe(1);
  });

  it('classifies tool_result-only user messages as role=tool', () => {
    const msgs: SessionMessage[] = [
      { type: 'user', uuid: 'u1', session_id: 's1', parent_tool_use_id: null,
        message: { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'tu1', content: '42' },
        ] } },
    ];
    const turns = projectSessionMessagesToUITurns(msgs, { offset: 0 });
    expect(turns[0]?.role).toBe('tool');
  });

  it('preserves redacted_thinking blocks verbatim (Anthropic compat)', () => {
    const msgs: SessionMessage[] = [
      { type: 'assistant', uuid: 'u1', session_id: 's1', parent_tool_use_id: null,
        message: { role: 'assistant', content: [
          { type: 'redacted_thinking', data: 'abc' },
        ] } },
    ];
    const turns = projectSessionMessagesToUITurns(msgs, { offset: 0 });
    expect(turns[0]?.contentBlocks).toEqual([{ type: 'redacted_thinking', data: 'abc' }]);
  });

  it('drops `system` SessionMessage[] (we never set includeSystemMessages)', () => {
    const msgs: SessionMessage[] = [
      { type: 'system', uuid: 'u1', session_id: 's1', parent_tool_use_id: null,
        message: { subtype: 'compact_boundary' } },
    ];
    const turns = projectSessionMessagesToUITurns(msgs, { offset: 0 });
    expect(turns).toEqual([]);
  });

  it('respects offset for turnIndex', () => {
    const msgs: SessionMessage[] = [
      { type: 'user', uuid: 'u1', session_id: 's1', parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    ];
    const turns = projectSessionMessagesToUITurns(msgs, { offset: 5 });
    expect(turns[0]?.turnIndex).toBe(5);
  });

  it('drops messages whose content is malformed', () => {
    const msgs: SessionMessage[] = [
      { type: 'user', uuid: 'u1', session_id: 's1', parent_tool_use_id: null,
        message: 'not an object' },
      { type: 'assistant', uuid: 'u2', session_id: 's1', parent_tool_use_id: null,
        message: { role: 'assistant', content: 'not an array' } },
    ];
    expect(projectSessionMessagesToUITurns(msgs, { offset: 0 })).toEqual([]);
  });
});
```

Run: `pnpm --filter @ax/agent-claude-sdk-runner-host test -- project-to-ui-turn.test`
Expected: FAIL — module doesn't exist.

**Step A4.3: Implement the projection**

```ts
// project-to-ui-turn.ts
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { ContentBlockSchema, type ContentBlock, type UITurn } from '@ax/ipc-protocol';

/**
 * Project SDK `SessionMessage[]` (returned by `getSessionMessages`) into
 * runner-agnostic `UITurn[]` for `runner:read-transcript`.
 *
 * The SDK already filters bookkeeping rows (queue-operation / last-prompt
 * / attachment); we don't see them. We DO see `system` SessionMessages
 * when includeSystemMessages is true — at default (false) the SDK omits
 * them, but we filter defensively in case a caller threads the option
 * through.
 *
 * Tool-flow detection: the SDK echoes tool_result blocks back as `user`
 * SessionMessages whose content is a tool_result-only array. We project
 * those as role=tool so the UI renders tool flow distinctly from
 * user-typed text.
 */
export interface ProjectionOptions {
  /** Index of the first turn in this batch (for paginated reads). */
  offset: number;
}

export function projectSessionMessagesToUITurns(
  messages: SessionMessage[],
  opts: ProjectionOptions,
): UITurn[] {
  const turns: UITurn[] = [];
  let idx = opts.offset;
  for (const m of messages) {
    if (m.type !== 'user' && m.type !== 'assistant') continue;
    const msg = m.message;
    if (typeof msg !== 'object' || msg === null) continue;
    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    const blocks: ContentBlock[] = [];
    for (const item of content) {
      const parsed = ContentBlockSchema.safeParse(item);
      if (parsed.success) blocks.push(parsed.data);
    }
    if (blocks.length === 0) continue;
    const timestamp = typeof (msg as { timestamp?: unknown }).timestamp === 'string'
      ? ((msg as { timestamp: string }).timestamp)
      : '';
    if (m.type === 'user' && blocks.every((b) => b.type === 'tool_result')) {
      turns.push({ role: 'tool', contentBlocks: blocks, turnIndex: idx++, timestamp });
      continue;
    }
    turns.push({
      role: m.type === 'user' ? 'user' : 'assistant',
      contentBlocks: blocks,
      turnIndex: idx++,
      timestamp,
    });
  }
  return turns;
}
```

**Step A4.4: Run projection tests**

```bash
pnpm --filter @ax/agent-claude-sdk-runner-host test -- project-to-ui-turn.test
```

Expected: PASS.

**Step A4.4b: Implement the read-session wrapper (tempdir + mutex + getSessionMessages)**

```ts
// read-session.ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * Single async mutex for `getSessionMessages` calls. `CLAUDE_CONFIG_DIR`
 * is process-wide; concurrent calls would race. (I12.) Worst case is a
 * sidebar that fires N transcript reads in parallel — they serialize
 * here. Each read is fast (<10ms tempdir + SDK read), so latency stays
 * acceptable.
 */
let lock: Promise<void> = Promise.resolve();

export interface ReadSessionArgs {
  /** Raw jsonl bytes from `workspace:read`. */
  jsonl: string;
  /** SDK session id (matches the filename). */
  sessionId: string;
  /** Pagination — passes through to getSessionMessages. */
  limit?: number;
  offset?: number;
}

/**
 * Stage `jsonl` into a per-call tempdir, set CLAUDE_CONFIG_DIR, and
 * delegate to the SDK's `getSessionMessages`. The SDK does the actual
 * parse + filter; we just give it a directory it expects.
 */
export async function readSessionViaSdk(args: ReadSessionArgs): Promise<SessionMessage[]> {
  const next = lock.then(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ax-rrt-'));
    try {
      // The SDK looks for sessions under `<CLAUDE_CONFIG_DIR>/projects/<projDir>/<sessionId>.jsonl`.
      // We don't care about the projDir name — getSessionMessages without `dir`
      // searches all project dirs under CLAUDE_CONFIG_DIR. Use a stable nonce
      // to keep the path well-formed.
      const projectDir = '-ax-runner-host-shim';
      const target = join(dir, 'projects', projectDir, `${args.sessionId}.jsonl`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, args.jsonl, { mode: 0o600 });
      const prev = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = dir;
      try {
        const opts: { limit?: number; offset?: number } = {};
        if (typeof args.limit === 'number') opts.limit = args.limit;
        if (typeof args.offset === 'number') opts.offset = args.offset;
        return await getSessionMessages(args.sessionId, opts);
      } finally {
        if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = prev;
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
  // Update the lock so the next caller waits on this one's settle (success or fail).
  lock = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}
```

**Step A4.4c: Test `readSessionViaSdk` with a known fixture**

```ts
// __tests__/read-session.test.ts
it('reads a fixture jsonl through the SDK', async () => {
  const jsonl = [
    JSON.stringify({ type: 'user', uuid: 'u1', sessionId: 's1', parentUuid: null,
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
    JSON.stringify({ type: 'assistant', uuid: 'u2', sessionId: 's1', parentUuid: null,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } }),
  ].join('\n');
  const msgs = await readSessionViaSdk({ jsonl, sessionId: 's1' });
  expect(msgs.map((m) => m.type)).toEqual(['user', 'assistant']);
});

it('returns [] for an unknown sessionId', async () => {
  const msgs = await readSessionViaSdk({ jsonl: '', sessionId: 'no-such' });
  expect(msgs).toEqual([]);
});

it('serializes concurrent calls (mutex)', async () => {
  // Race two reads with different sessionIds; both should succeed.
  const j1 = JSON.stringify({ type: 'user', uuid: 'u1', sessionId: 'sA', parentUuid: null,
    message: { role: 'user', content: [{ type: 'text', text: 'A' }] } });
  const j2 = JSON.stringify({ type: 'user', uuid: 'u2', sessionId: 'sB', parentUuid: null,
    message: { role: 'user', content: [{ type: 'text', text: 'B' }] } });
  const [r1, r2] = await Promise.all([
    readSessionViaSdk({ jsonl: j1, sessionId: 'sA' }),
    readSessionViaSdk({ jsonl: j2, sessionId: 'sB' }),
  ]);
  expect(r1.map((m) => m.type)).toEqual(['user']);
  expect(r2.map((m) => m.type)).toEqual(['user']);
});
```

(NB: SDK's exact required field shape on the jsonl row may differ slightly from this fixture — verify during execution by capturing real bytes from a Phase A-style spike and matching them.)

**Step A4.5: Wire `runner:read-transcript` handler**

```ts
// index.ts — fill in init()
import { PluginError, type AgentContext, type HookBus, type Plugin } from '@ax/core';
import {
  RunnerReadTranscriptInputSchema,
  type RunnerReadTranscriptInput,
  type RunnerReadTranscriptOutput,
} from '@ax/ipc-protocol';
import { projectSessionMessagesToUITurns } from './project-to-ui-turn.js';
import { readSessionViaSdk } from './read-session.js';

const PLUGIN_NAME = '@ax/agent-claude-sdk-runner-host';
const RUNNER_TYPE_NAME = 'claude-sdk';

export function createAgentClaudeSdkRunnerHostPlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['runner:read-transcript'],
      calls: ['conversations:get-metadata', 'workspace:read'],
      subscribes: [],
    },

    async init({ bus }) {
      bus.registerService<RunnerReadTranscriptInput, RunnerReadTranscriptOutput>(
        'runner:read-transcript',
        PLUGIN_NAME,
        async (ctx, input) => readTranscript(bus, ctx, input),
      );
    },

    async shutdown() { /* no-op */ },
  };
}

async function readTranscript(
  bus: HookBus,
  ctx: AgentContext,
  input: RunnerReadTranscriptInput,
): Promise<RunnerReadTranscriptOutput> {
  const hookName = 'runner:read-transcript';
  const parsed = RunnerReadTranscriptInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new PluginError({
      code: 'invalid-payload', plugin: PLUGIN_NAME, hookName,
      message: parsed.error.message,
    });
  }
  // ACL gate (mirrors :get) — :get-metadata throws PluginError(not-found)
  // for foreign user / tombstone. We let that propagate.
  const md = await bus.call<
    { conversationId: string; userId: string },
    { conversationId: string; runnerSessionId: string | null; workspaceRef: string | null; runnerType: string | null }
  >('conversations:get-metadata', ctx, {
    conversationId: parsed.data.conversationId,
    userId: parsed.data.userId,
  });
  // Empty cases: no workspace, no session bound yet, or wrong runner type.
  if (md.workspaceRef === null) return { turns: [], hasMore: false };
  if (md.runnerSessionId === null) return { turns: [], hasMore: false };
  if (md.runnerType !== RUNNER_TYPE_NAME && md.runnerType !== null) {
    // Different runner type — not ours. The router pattern (D5) handles
    // this when it ships; for MVP, return empty.
    return { turns: [], hasMore: false };
  }
  // Fetch jsonl bytes via workspace:read. The path under the workspace is
  // `.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. We don't know the
  // encoded-cwd, but workspace:list (or equivalent — verify in Task A1)
  // gives us the file's path under the workspace; sessionId.jsonl is
  // unique. (No realpath gotcha — the SDK handles project-dir lookup
  // internally once we hand it CLAUDE_CONFIG_DIR and the sessionId.)
  const jsonl = await fetchSessionJsonl(bus, ctx, md.workspaceRef, md.runnerSessionId);
  if (jsonl === null) return { turns: [], hasMore: false };
  const messages = await readSessionViaSdk({ jsonl, sessionId: md.runnerSessionId });
  return {
    turns: projectSessionMessagesToUITurns(messages, { offset: 0 }),
    hasMore: false,
  };
}
```

**Step A4.6: Implement `fetchSessionJsonl`**

This is the workspace-plugin-mediated read. Uses `workspace:read` for individual files; needs a list operation to find the file under `.claude/projects/<unknown-dir>/<sessionId>.jsonl`. Survey from Task A1 informs the API. Sketch:

```ts
async function fetchSessionJsonl(
  bus: HookBus,
  ctx: AgentContext,
  workspaceRef: string,
  sessionId: string,
): Promise<string | null> {
  // The workspace plugin must expose either:
  //   (a) a list operation that takes a glob pattern, OR
  //   (b) a list operation we can post-filter in-process.
  // Survey result (Task A1) determines the exact call.
  //
  // PSEUDOCODE — replace with the real call once Task A1 confirms shape:
  const entries = await bus.call<unknown, { paths: string[] }>(
    'workspace:list', ctx,
    { workspaceRef, prefix: '.claude/projects/' },
  );
  const match = entries.paths.find((p) => p.endsWith(`/${sessionId}.jsonl`));
  if (match === undefined) return null;
  const { content } = await bus.call<unknown, { content: string }>(
    'workspace:read', ctx, { workspaceRef, path: match },
  );
  return content;
}
```

(Sketch — finalize once survey lands. If `workspace:list` doesn't exist, PR-A also adds it OR uses `workspace:read` against a known-path scheme. **Do not skip this step** — flag deviation if API doesn't match.)

**Step A4.7: Write the integration test**

```ts
// read-transcript.test.ts — uses test harness; verify harness exposes a
// minimal workspace plugin (or a mock workspace:list/:read handler set).
import { describe, it, expect } from 'vitest';
import { withHostPlugin } from './helpers/host.js';  // TBD — verify in Task A1

describe('runner:read-transcript', () => {
  it('returns empty when conversation has no workspaceRef', async () => {
    /* ... */
  });
  it('returns empty when runner_session_id is null', async () => {
    /* ... */
  });
  it('parses SDK jsonl into UITurn[] when workspace + session both set', async () => {
    /* ... seed a fake jsonl in the mock workspace; assert turn count + roles */
  });
  it('throws not-found for tombstoned conversation', async () => {
    /* ... */
  });
  it('throws not-found for foreign user', async () => {
    /* ... */
  });
});
```

**Step A4.8: Run tests + build**

```bash
pnpm --filter @ax/agent-claude-sdk-runner-host test
pnpm build
```

Expected: PASS.

**Step A4.9: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(agent-claude-sdk-runner-host): implement runner:read-transcript

Reads SDK jsonl via workspace:read (sessionId-glob), parses to UITurn[].
ACL gate via conversations:get-metadata (Phase B). Empty for missing
workspace / unbound session; not-found for tombstone.

Invariants: I4 (no backend vocab), I5 (sessionId glob, not encoded-cwd
reconstruction), I6 (whitelist turn-bearing kinds), I17 (UITurn shared
in @ax/ipc-protocol).

Closes the read half of Phase B's half-wired window.
EOF
)"
```

### Task A5: Wire the host plugin into the CLI preset

**Goal:** Plugin actually loads. CLI canary test exercises it.

**Files:**
- Modify: `packages/cli/src/main.ts` (import + add to plugin list)
- Modify: `presets/k8s/src/index.ts` (mirror)

**Step A5.1: Read the current preset to see plugin-load ordering**

```bash
sed -n '1,50p' packages/cli/src/main.ts
sed -n '1,50p' presets/k8s/src/index.ts
```

**Step A5.2: Add the import + load**

```ts
// packages/cli/src/main.ts (alongside existing imports)
import { createAgentClaudeSdkRunnerHostPlugin } from '@ax/agent-claude-sdk-runner-host';

// In the plugin list (after @ax/conversations, since the host plugin
// calls conversations:get-metadata):
plugins.push(createAgentClaudeSdkRunnerHostPlugin());
```

**Step A5.3: Update the conversations config to default-runner-type 'claude-sdk'**

If the CLI is already passing `defaultRunnerType: 'claude-sdk'` to `createConversationsPlugin`, no change. If not, add it now (Phase B's default already does this — verify).

**Step A5.4: Run the CLI's canary acceptance test**

```bash
pnpm --filter @ax/cli test
```

Expected: PASS. The canary test exercises agent:invoke end-to-end; the new plugin shouldn't break it (the read-transcript hook isn't called by anything in the canary path yet — half-wired-window discipline).

**Step A5.5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(cli): load @ax/agent-claude-sdk-runner-host

Plugin registers runner:read-transcript. No caller in the canary path
(channel-web cutover is Phase D); this commit only wires the plugin
into the host preset so subsequent PRs (and channel-web reads outside
the canary) can reach the hook.
EOF
)"
```

### Task A6: Workspace plugin ignore-list

**Goal:** SDK auxiliary files (`.claude.json`, `.claude/backups/`, `.claude/policy-limits.json`) don't bloat the workspace tree.

**Files:**
- Modify: `packages/workspace-git-http/src/...` (per Task A1 survey)

**Step A6.1: Use survey results from A1**

The exact API depends on what's already there. Possibilities:

- **Option α: A `commit` operation that takes a path filter.** Add the SDK-aux paths to its skip-list.
- **Option β: A persistence layer that walks the workspace tree.** Add an explicit ignore list with the three patterns.
- **Option γ: No filter mechanism exists.** Introduce one as part of this task; ship it with the SDK-aux defaults.

**Step A6.2: Write a failing test for the ignore behavior**

```ts
it('does not persist .claude.json / .claude/backups/ / .claude/policy-limits.json', async () => {
  await withWorkspace(async (ws) => {
    await ws.write('.claude.json', '{}');
    await ws.write('.claude/backups/abc.backup', '{}');
    await ws.write('.claude/policy-limits.json', '{}');
    await ws.write('.claude/projects/foo/abc.jsonl', '...');
    await ws.commit({ message: 'turn' });
    const tracked = await ws.listTracked();
    expect(tracked).not.toContain('.claude.json');
    expect(tracked).not.toContain('.claude/backups/abc.backup');
    expect(tracked).not.toContain('.claude/policy-limits.json');
    expect(tracked).toContain('.claude/projects/foo/abc.jsonl');
  });
});
```

(Adapt to the real workspace API.)

**Step A6.3: Implement**

Per Task A1's survey result. Add the ignore patterns; ship them as defaults so any consumer that loads the workspace plugin gets the right behavior.

**Step A6.4: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(workspace-git-http): ignore SDK auxiliary files in .claude/

The Claude Agent SDK writes .claude.json (~20KB cache), .claude/backups/
(accumulates per spawn), and .claude/policy-limits.json under HOME. With
HOME = workspaceRoot (Phase C PR-B), those files would otherwise bloat
the workspace tree.

Ignore-list keeps only .claude/projects/ — the actual session jsonls.

Invariants: I7 (workspace ignore-list narrowed).
EOF
)"
```

### Task A7: PR-A description + push

**Goal:** Document the read-half closure of Phase B's window. Boundary review.

**Files:**
- Create: `docs/plans/2026-04-29-phase-c-pr-a-pr-notes.md`

**Sections:**
1. Summary (3 bullets)
2. Boundary review for `runner:read-transcript` (alternate impl: `@ax/agent-native-runner-host` for pi sessions; payload audit; subscriber risk: none; wire surface: none)
3. **WINDOW STATUS — read half CLOSED, write half STILL OPEN.** Phase B's `conversations:get-metadata` now has a caller (the new plugin's hook handler). `conversations:store-runner-session` STILL has no caller; closes in PR-B.
4. Test coverage list
5. Reviewer asks

**Push + open PR.**

---

## PR-B — Sandbox-side jsonl handling + `session.bind-runner-session` IPC

**Goal:** Runner captures `system/init.session_id`, IPCs back to host. Host fires `conversations:store-runner-session`. HOME is redirected at the sandbox level. The runner does NOT use `resume()` yet — that's PR-C. Closes the *write* half of Phase B's half-wired window.

**Branch suggestion:** `feat/phase-c-pr-b-bind-runner-session`. Builds atop PR-A's branch (after PR-A merges to main).

### Task B1: Add `session.bind-runner-session` action to `@ax/ipc-protocol`

**Files:**
- Modify: `packages/ipc-protocol/src/actions.ts`
- Modify: `packages/ipc-protocol/src/index.ts`
- Test: `packages/ipc-protocol/src/__tests__/schemas.test.ts`

**Step B1.1: Schema definitions**

```ts
// packages/ipc-protocol/src/actions.ts (after session.get-config block)
export const SessionBindRunnerSessionRequestSchema = z.object({
  runnerSessionId: z.string().min(1).max(256),
}).strict();
export type SessionBindRunnerSessionRequest = z.infer<typeof SessionBindRunnerSessionRequestSchema>;

export const SessionBindRunnerSessionResponseSchema = z.object({
  // No payload — bind is best-effort idempotent. Errors come back via
  // the action's error envelope.
}).strict();
export type SessionBindRunnerSessionResponse = z.infer<typeof SessionBindRunnerSessionResponseSchema>;
```

**Step B1.2: Test the schemas**

`schemas.test.ts` already has parallel tests for `session.get-config`; mirror.

**Step B1.3: Commit**

```bash
git commit -m "feat(ipc-protocol): session.bind-runner-session action schema"
```

### Task B2: Dispatcher handler

**Files:**
- Modify: `packages/ipc-core/src/dispatcher.ts`
- Create: `packages/ipc-core/src/__tests__/session-bind-runner-session.test.ts` (or add to existing)

**Step B2.1: Action registration**

```ts
// dispatcher.ts
ACTIONS.set('/session.bind-runner-session', {
  method: 'POST',
  handler: sessionBindRunnerSessionHandler,
});
```

**Step B2.2: Handler implementation**

```ts
// new file or alongside existing handlers
import { SessionBindRunnerSessionRequestSchema } from '@ax/ipc-protocol';

export const sessionBindRunnerSessionHandler: ActionHandler = async (req, ctx, bus) => {
  const parsed = SessionBindRunnerSessionRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return { status: 400, body: { error: { code: 'invalid-payload', message: parsed.error.message } } };
  }

  // The session row carries conversationId (Week 10–12 schema). The host
  // resolves the session via the bearer token (already done; ctx.userId
  // and ctx.conversationId are populated by the IPC server's
  // authenticate step). We need ctx.conversationId here.
  const conversationId = ctx.conversationId;
  if (typeof conversationId !== 'string' || conversationId.length === 0) {
    // Non-conversation session (canary, admin probe). Bind is a no-op.
    return { status: 200, body: {} };
  }

  try {
    await bus.call('conversations:store-runner-session', ctx, {
      conversationId,
      runnerSessionId: parsed.data.runnerSessionId,
    });
    return { status: 200, body: {} };
  } catch (err) {
    // PluginError code 'conflict' → 409; 'not-found' → 404; else 500.
    if (err instanceof PluginError && err.code === 'conflict') {
      return { status: 409, body: { error: { code: 'conflict', message: err.message } } };
    }
    if (err instanceof PluginError && err.code === 'not-found') {
      return { status: 404, body: { error: { code: 'not-found', message: err.message } } };
    }
    throw err;  // dispatcher's outer catch turns into 500
  }
};
```

**Step B2.3: Tests**

- happy-path: bind succeeds; bus call observed with correct payload
- conflict: bus throws conflict; handler returns 409
- non-conversation session: handler short-circuits with 200, bus not called

**Step B2.4: Commit**

```bash
git commit -m "feat(ipc-core): /session.bind-runner-session dispatcher action"
```

### Task B3: Runner captures `system/init.session_id` and IPCs back

**Files:**
- Modify: `packages/agent-claude-sdk-runner/src/main.ts`

**Step B3.1: Detect the init message in the SDK iterator loop**

```ts
// main.ts:356 (the `for await (const msg of queryIter)` loop)
let runnerSessionId: string | undefined;
for await (const msg of queryIter) {
  if (msg.type === 'system' && (msg as { subtype?: string }).subtype === 'init') {
    const sid = (msg as { session_id?: string }).session_id;
    if (typeof sid === 'string' && sid.length > 0 && runnerSessionId === undefined) {
      runnerSessionId = sid;
      // Fire-and-forget bind. I13: never block the runner on failure.
      void client
        .call('session.bind-runner-session', { runnerSessionId: sid })
        .catch((err) => {
          process.stderr.write(
            `runner: session.bind-runner-session failed: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        });
    }
    continue;  // SDK bookkeeping; not a turn.
  }
  // ... existing assistant / user / result branches
}
```

(Place the new branch BEFORE the `else if (msg.type === 'user')` branches so it short-circuits cleanly.)

**Step B3.2: Tests**

The runner is a binary; testing requires the existing test-harness pattern (`packages/cli/src/__tests__/chat-pipeline.e2e.test.ts` is the precedent). For unit-level coverage of just the bind logic, add a lightweight test that drives a mock IPC client through the system/init handling.

**Step B3.3: Commit**

```bash
git commit -m "feat(agent-claude-sdk-runner): capture system/init.session_id and bind via IPC"
```

### Task B4: Sandbox-subprocess `CLAUDE_CONFIG_DIR` injection

**Files:**
- Modify: `packages/sandbox-subprocess/src/open-session.ts`

**Step B4.1: Add `runnerKind` to open-session input shape**

The input shape is internal — find it in `open-session.ts`. Add an optional `runnerKind?: 'claude-sdk'` field. Treat `undefined` as the legacy behavior (no `CLAUDE_CONFIG_DIR` injection).

**Step B4.2: Inject `CLAUDE_CONFIG_DIR` into `sessionEnv`**

```ts
// open-session.ts:246
const sessionEnv: Record<string, string> = {
  AX_RUNNER_ENDPOINT: runnerEndpoint,
  AX_SESSION_ID: created.sessionId,
  AX_AUTH_TOKEN: created.token,
  AX_WORKSPACE_ROOT: input.workspaceRoot,
};

if (input.runnerKind === 'claude-sdk') {
  // Phase C (2026-04-29): point the Claude Agent SDK at a workspace-
  // rooted config dir so session jsonl lands inside the workspace plugin's
  // tracked tree. The SDK then writes:
  //   <workspaceRoot>/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
  // and reads from the same place on resume. CLAUDE_CONFIG_DIR is the
  // SDK's purpose-built knob (sdk.d.ts:1311); we prefer it over a HOME
  // redirect because it's targeted (no surprise to other in-sandbox
  // tooling that reads HOME for unrelated reasons).
  //
  // Workspace ignore-list (Phase C PR-A) drops the SDK auxiliary files
  // (.claude.json, .claude/backups/, .claude/policy-limits.json) so they
  // don't bloat workspace commits.
  sessionEnv.CLAUDE_CONFIG_DIR = `${input.workspaceRoot}/.claude`;
}
```

(No allowlist change needed — `CLAUDE_CONFIG_DIR` is a new key; HOME stays the parent's.)

**Step B4.3: Test the injection**

```ts
it('sets CLAUDE_CONFIG_DIR = <workspaceRoot>/.claude when runnerKind=claude-sdk', async () => {
  /* ... open-session with runnerKind: 'claude-sdk', spawn `printenv` or
     `node -e "console.log(process.env.CLAUDE_CONFIG_DIR)"`, assert child
     CLAUDE_CONFIG_DIR matches `<workspaceRoot>/.claude` */
});

it('does not set CLAUDE_CONFIG_DIR when runnerKind is undefined', async () => {
  /* ... legacy behavior, child env has no CLAUDE_CONFIG_DIR */
});

it('preserves parent HOME (no override) regardless of runnerKind', async () => {
  /* ... HOME comes from the parent allowlist as before */
});
```

**Step B4.4: Commit**

```bash
git commit -m "feat(sandbox-subprocess): inject CLAUDE_CONFIG_DIR=<wsRoot>/.claude when runnerKind=claude-sdk"
```

### Task B5: Orchestrator passes `runnerKind: 'claude-sdk'` (PR-B subset)

**Goal:** PR-B passes `runnerKind` so HOME redirect activates. (`runnerSessionId` threading is PR-C.)

**Files:**
- Modify: `packages/chat-orchestrator/src/orchestrator.ts:778`

**Step B5.1: Add `runnerKind: 'claude-sdk'` to the open-session call**

Hardcoded for now (single-runner MVP, I3). PR-C revisits when the runner type comes from `conversations:get-metadata`.

**Step B5.2: Tests pass**

```bash
pnpm build && pnpm test
```

Expected: existing tests pass; the new field flows through.

**Step B5.3: Commit**

```bash
git commit -m "feat(chat-orchestrator): pass runnerKind=claude-sdk to sandbox:open-session"
```

### Task B6: PR-B description + push

**Sections:**
1. Summary
2. Boundary review for `session.bind-runner-session`: alternate impl (any host that accepts a runner-side bind report — generic), payload audit (`runnerSessionId` is opaque string; no leak), subscriber risk (none — service action), wire surface (`/session.bind-runner-session` POST in dispatcher)
3. **WINDOW STATUS — write half CLOSED.** Phase B's `conversations:store-runner-session` now has a caller (the dispatcher handler). Phase B half-wired window is fully closed.
4. Test coverage
5. Reviewer asks

---

## PR-C — Resume cutover

**Goal:** Orchestrator threads `runnerSessionId` from `conversations:get-metadata` into `sandbox:open-session`. Sandbox forwards as `AX_RUNNER_SESSION_ID` env. Runner uses `query({ resume })` when set; falls back to replay otherwise. Equivalence test pins it.

**Branch suggestion:** `feat/phase-c-pr-c-resume`. Builds atop PR-B.

### Task C1: Survey + baseline

```bash
pnpm build && pnpm test  # confirm PR-A + PR-B both shipped + green
rg -n "AX_RUNNER_SESSION_ID|runnerSessionId" packages --no-heading | head
```

Expected: PR-A + PR-B both reflected in code (host plugin loads, bind IPC exists). No `AX_RUNNER_SESSION_ID` references yet.

### Task C2: Sandbox-subprocess accepts `runnerSessionId`

**Files:**
- Modify: `packages/sandbox-subprocess/src/open-session.ts`

**Step C2.1: Add input field**

```ts
// open-session input — extend
runnerSessionId?: string;
```

**Step C2.2: Forward as env**

```ts
if (typeof input.runnerSessionId === 'string' && input.runnerSessionId.length > 0) {
  sessionEnv.AX_RUNNER_SESSION_ID = input.runnerSessionId;
}
```

**Step C2.3: Test**

```ts
it('forwards runnerSessionId as AX_RUNNER_SESSION_ID', async () => { /* ... */ });
it('omits AX_RUNNER_SESSION_ID when input is undefined or empty (I11)', async () => { /* ... */ });
```

**Step C2.4: Commit**

### Task C3: Runner reads `AX_RUNNER_SESSION_ID` and uses `resume`

**Files:**
- Modify: `packages/agent-claude-sdk-runner/src/env.ts` (extend `RunnerEnv`)
- Modify: `packages/agent-claude-sdk-runner/src/main.ts`

**Step C3.1: Extend `readRunnerEnv`**

```ts
export interface RunnerEnv {
  /* existing fields */
  /** Phase C — when set, the SDK resumes the prior session and replay is skipped. */
  runnerSessionId?: string;
}

// in readRunnerEnv():
const runnerSessionId = opt('AX_RUNNER_SESSION_ID');
if (runnerSessionId !== undefined) result.runnerSessionId = runnerSessionId;
```

**Step C3.2: Skip replay when resume is in play; pass `resume` to query**

```ts
// main.ts — replay block (around line 153)
if (env.runnerSessionId !== undefined) {
  // Phase C: SDK resume is in play. The SDK loads from jsonl; we don't
  // pre-fetch + replay user-side history.
  replayTurns = [];
} else if (conversationId !== null) {
  // Legacy path — pre-Phase-C conversations or runners that haven't
  // bound a session yet. Phase E removes this branch.
  /* existing fetch-history call */
}

// main.ts — query call site (around line 309)
const queryIter = query({
  prompt: userMessages(),
  options: {
    /* existing options */
    ...(env.runnerSessionId !== undefined ? { resume: env.runnerSessionId } : {}),
  },
});
```

**Step C3.3: Tests**

End-to-end test exercising both branches:

```ts
it('resume path: AX_RUNNER_SESSION_ID set → replay skipped, query gets resume option', () => { /* ... */ });
it('replay path: AX_RUNNER_SESSION_ID unset → fetch-history fires, no resume option', () => { /* ... */ });
```

**Step C3.4: Commit**

### Task C4: Orchestrator looks up runnerSessionId and threads it

**Files:**
- Modify: `packages/chat-orchestrator/src/orchestrator.ts`

**Step C4.1: Before `sandbox:open-session`, read metadata**

```ts
let runnerSessionId: string | undefined;
if (ctx.conversationId !== undefined) {
  try {
    const md = await bus.call('conversations:get-metadata', ctx, {
      conversationId: ctx.conversationId,
      userId: ctx.userId,
    });
    runnerSessionId = md.runnerSessionId ?? undefined;
  } catch (err) {
    // Lookup failed — fall back to replay branch (treat as unbound).
    runnerSessionId = undefined;
    ctx.logger.warn('orchestrator_get_metadata_failed', { err });
  }
}
```

**Step C4.2: Pass into open-session**

```ts
await bus.call('sandbox:open-session', ctx, {
  /* existing fields */
  runnerKind: 'claude-sdk',
  ...(runnerSessionId !== undefined ? { runnerSessionId } : {}),
});
```

**Step C4.3: Tests**

```ts
it('passes runnerSessionId from conversations:get-metadata into sandbox:open-session', () => { /* ... */ });
it('omits runnerSessionId when conversation has no runner_session_id yet (legacy)', () => { /* ... */ });
it('omits runnerSessionId on get-metadata failure (graceful degrade to replay)', () => { /* ... */ });
```

**Step C4.4: Commit**

### Task C5: Equivalence test

**Goal:** A multi-turn conversation produces the same observable outcome via replay vs resume. (I10.)

**Files:**
- Create: `packages/cli/src/__tests__/replay-vs-resume-equivalence.e2e.test.ts`

**Step C5.1: Test outline**

```ts
it('multi-turn conversation: replay path and resume path produce same final transcript', async () => {
  // Setup: deterministic mock LLM that returns predictable text.
  // Run 1 (replay): create conversation, run 3 turns, kill runner, restart with NULL runnerSessionId, run 1 more turn.
  // Run 2 (resume): create conversation, run 3 turns, kill runner, runner_session_id is bound, restart, run 1 more turn.
  // Assert the persisted transcript (via runner:read-transcript) matches between runs.
});
```

(Pin via the deterministic mock LLM the existing test-harness already exposes — see `packages/llm-mock`.)

**Step C5.2: Commit**

### Task C6: PR-C description + push

**Sections:**
1. Summary
2. **Window status — fully closed.** Phase B's window is fully sealed by PR-B; this PR is a behavior cutover, not a window-closer.
3. Replay-vs-resume equivalence test outcome
4. Open question: when does Phase E delete replay? (Answer per design doc: after Phase D's channel-web cutover, when no caller of `conversations:fetch-history` remains.)
5. Reviewer asks

---

## Done criteria (all three PRs)

- All ten tasks across PR-A + PR-B + PR-C committed; PRs pushed and merged.
- `pnpm build && pnpm test` green at every commit boundary.
- `runner:read-transcript` returns the same `UITurn[]` content as `conversations:fetch-history` for any conversation, modulo the projection differences (full block fidelity vs lossy `ContentBlock[]`).
- A new conversation created post-PR-C goes through resume; pre-PR-C conversations go through replay; both produce coherent multi-turn dialogues.
- Workspace tree under `.claude/` contains `projects/` only; no `.claude.json`, no `.claude/backups/`, no `.claude/policy-limits.json`.
- `.claude/memory/` updated at session end:
  - `context.md` — confirm SDK realpath fact + extra-files fact didn't drift.
  - `decisions.md` — Phase C shipping note.
  - `meta.md` — any "I worked differently than the plan said" insight.
  - Auto-memory pointer for "Phase C shipped, Phase D next."

## What this enables (Phase D)

- Channel-web's `GET /api/conversations/:id/turns` switches from `conversations:fetch-history` to `runner:read-transcript`. Pre-Phase-C conversations need a fallback (`fetch-history` still works); post-Phase-C ones get full block fidelity for free.
- POST `/api/chat/messages` stops appending the user turn before dispatch — the duplicate-yield bug (Codex finding 1) goes away.
- Phase E becomes a pure-deletion PR (replay code, fetch-history, append-turn, conversation_turns table).
