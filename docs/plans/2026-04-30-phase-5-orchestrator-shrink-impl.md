# Phase 5 Implementation Plan — orchestrator shrink (delete legacy `AX_LLM_PROXY_URL` fallback chain)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Finish the agent-centric simplification's "host stops driving the loop" milestone by deleting the legacy `AX_LLM_PROXY_URL` / in-sandbox llm-proxy fallback paths. Phase 2 made the credential-proxy + bridge the default; Phase 5 deletes the now-unreachable fallback so Phase 6 can delete `@ax/llm-proxy-anthropic-format` cleanly.

**Architecture:** The orchestrator's host-side turn loop is **already gone** (removed when `@ax/agent-claude-sdk-runner` became the production runner — the SDK drives the loop in-sandbox). Today's `runAgentInvoke` is essentially the thin RPC the design called for; the only host-side coordination still standing is `agents:resolve` (Week 9.5 ACL gate), J6 conversation routing (Week 10-12), proxy lifecycle (Phase 2), sandbox open/close, `session:queue-work`, `chat:end` await, the one-shot `chat:turn-end` cancel, and Phase 3's `proxy:rotate-session` plumbing. Phase 5's deletion targets the dead-code paths that branch on `AX_LLM_PROXY_URL` (the runner-side fallback when no proxy plugin is loaded). Cleaning these now lets Phase 6 delete `@ax/llm-proxy-anthropic-format` without leaving a runner that can't boot.

**Tech Stack:**

- TypeScript / Node 20+
- Vitest (`.test.ts` per package)
- `@ax/credential-proxy` + `@ax/credential-proxy-bridge` (Phase 1a/2 — the now-default path)
- No new dependencies, no new plugins

**Out-of-scope (deferred):**

- Deleting `@ax/llm-proxy-anthropic-format`, `@ax/llm-anthropic`, `@ax/agent-native-runner`, `@ax/llm-mock`, `@ax/tool-dispatcher`, `@ax/tool-bash*`, `@ax/tool-file-io*`. **Phase 6** owns those (design Section 6 deletes table). Phase 5 stops at "the legacy code path is now unreachable; the packages still build."
- Deleting `LlmRequest` / `LlmResponse` / `ToolCall` / `ToolDescriptor` / `ToolPreCall*` / `ToolExecuteHost*` from `@ax/core` and `@ax/ipc-protocol`. **Phase 7** owns kernel cleanup.
- Switching `@ax/audit-log`'s subscription from `chat:end` to `event.http-egress`. **Phase 7**. Phase 5 must NOT touch the audit-log path — `chat:end` keeps firing exactly once per `agent:invoke` with the same `AgentOutcome`.
- Narrowing `AgentMessage` role union from 3 roles to 2. Phase 7 (open question §1 in the Phase 4 plan).
- Refactoring `runAgentInvoke`'s 560-LOC body into smaller helpers for clarity. The design's "~80 line" target was written before Week 9.5 (ACL gate) + Week 10-12 (J6 routing) + Phase 2 (proxy lifecycle) + Phase 3 (rotate-session) added their slices. The current shape is dense but each block earns its weight. A clarity refactor is a separate, lower-priority slice (open question §3 — defer).

---

## Reality check — what the design said vs. what's actually in the tree

The design doc's Phase 5 description ("Turn-loop logic deleted; agent:invoke becomes the thin RPC described in Section 5 (~80 lines). The agent runner now drives the loop end-to-end.") was drafted before several intervening slices landed. A pre-execution survey (`packages/chat-orchestrator/src/orchestrator.ts`, plus a `Phase 5|Phase 6` grep across the workspace) shows:

| Design's premise | Reality at HEAD of `main` (post-Phase 4) |
|---|---|
| Host-side turn loop must be deleted | Already gone. No `while(turn) { llm.call(...); for tool of resp.toolCalls { tool.execute-host(...) } }` pattern anywhere in `chat-orchestrator/src/`. |
| Tool-call fanning lives in the orchestrator | Already gone. Tool dispatch is the SDK runner's responsibility. |
| LLM-call retry / stop-reason logic in the orchestrator | Already gone. The SDK runner owns retry semantics for its model calls. |
| Orchestrator shrinks to ~80 lines | `runAgentInvoke` is 560 LOC inside a 1090-LOC file. The bulk is: agents:resolve (~30 LOC), J6 conversation-routing branch (~100 LOC), proxy:open-session (~100 LOC), sandbox spawn + waiter setup + queue-work + chat:end await (~230 LOC), structured-error finally (~100 LOC). Each block traces to a slice that landed AFTER the design was written. |
| Phase 5 risk: medium-high (runner self-sufficiency) | Already verified by Phase 2 shipping (`@ax/agent-claude-sdk-runner` is in production; CLI canary + multi-tenant acceptance test pass). Risk reduces to medium-low. |

**What's left for Phase 5:**

1. **Delete the legacy `AX_LLM_PROXY_URL` fallback** in `@ax/agent-claude-sdk-runner`. This is the runner-side branch that runs when no `AX_PROXY_*` env var is set — it points the SDK at `@ax/llm-proxy-anthropic-format`'s in-sandbox listener via `ANTHROPIC_BASE_URL`. After Phase 2, this branch is unreachable in any preset that loads `@ax/credential-proxy` (CLI canary + k8s preset both do); after Phase 5, deleting it is safe. The branch is explicitly self-marked as "Phase 5/6 deletes this" in 8 places across the runner and orchestrator.
2. **Delete the half-wired `AX_LLM_PROXY_URL` env-injection path** in `@ax/sandbox-subprocess` (one comment-flagged stub).
3. **Audit `@ax/agent-claude-sdk-runner` for residual host-side coordination assumptions.** Specifically: confirm no code path falls back to `tool.execute-host` IPC, no path calls `llm.call` IPC, the SDK's tool dispatch and retry are entirely in-sandbox.
4. **Update orchestrator + runner comments** that reference the legacy path with future tense (`"Phase 5/6 deletes…"`) — those comments are about to become past tense; rewrite or delete.
5. **Verify the canary, multi-turn tool-use, conversations bind-session, and audit-log behavior all stay green** as the gate before merging.

The `runAgentInvoke` clarity refactor (extracting `routeIntoLiveSession()` / `openFreshSandbox()` / `awaitChatEnd()` helpers) is a candidate for a future slice; defer per open question §3.

---

## Reference material

ax-next files this plan touches (read before editing):

| File | Lines | Why |
|---|---|---|
| `packages/agent-claude-sdk-runner/src/proxy-startup.ts` | 29-32, 106-118 | The legacy branch — `if (env.proxyEndpoint === undefined && env.proxyUnixSocket === undefined) { ... ANTHROPIC_BASE_URL = env.llmProxyUrl ... }`. Delete the else-branch entirely; `setupProxy` becomes "always Phase 2 path." Update the file's header comment block accordingly. |
| `packages/agent-claude-sdk-runner/src/env.ts` | 8, 28 (comments); the `llmProxyUrl?: string` field declaration; `readRunnerEnv` validation | Drop `AX_LLM_PROXY_URL` recognition. `RunnerEnv.llmProxyUrl` field deletes; `readRunnerEnv` validates exactly one of `AX_PROXY_ENDPOINT` / `AX_PROXY_UNIX_SOCKET` is set, errors if both or neither. Update header comments. |
| `packages/agent-claude-sdk-runner/src/__tests__/env.test.ts` | line 5 + any test cases that exercise the legacy `llmProxyUrl` path | Delete legacy-path tests. Keep the "exactly one of bridge/direct" assertion. Add a positive test confirming the legacy env var is no longer recognized (typed `AX_LLM_PROXY_URL` should still parse but `RunnerEnv` should not carry it; or: `readRunnerEnv` errors if it's set without one of the new vars). Plan author: keep behavior loose — accept extra env vars (don't reject), just don't act on them. |
| `packages/agent-claude-sdk-runner/src/main.ts` | 77, 316 (comments) | Comments referencing "Phase 5/6 deletes" — rewrite or delete. |
| `packages/chat-orchestrator/src/orchestrator.ts` | 260, 622 (comments) | Two comment blocks that mention "Phase 5/6 deletes the fallback" — rewrite to past tense or delete. |
| `packages/sandbox-subprocess/src/open-session.ts` | 249 (comment) | One comment about half-wired-pending Phase 5/6 deletion. Investigate the surrounding code: if there's an actual code branch wired to a Phase 5/6 delete, that's the deletion target; if it's only a comment, just rewrite the comment. |
| `packages/agent-claude-sdk-runner/src/__tests__/main.test.ts` (and friends) | runner test files | Audit for any test that exercises the legacy `AX_LLM_PROXY_URL` path. Delete those cases; keep the proxy-bridge + direct-mode tests. |
| `packages/chat-orchestrator/src/__tests__/orchestrator.test.ts` | search for `proxyConfig.*undefined`, `AX_LLM_PROXY_URL`, "fallback" | Audit. Today the `proxyOpenLoaded`/`proxyCloseLoaded` gating means the orchestrator can run with proxyConfig undefined (CLI canary pre-Phase-2-complete). Phase 5 may TIGHTEN this — proxy hooks are now required if any agent has credentials. But that change is a behavior change, not just a deletion; keep it to "delete the unreachable runner branch" unless tests force otherwise. |

**Reference patterns already in the codebase:**

- Hard-cut deletion precedent: Phase 4 reshape (delete the old type, no aliases). `docs/plans/2026-04-30-phase-4-pr-notes.md`.
- Half-wired removal precedent: Phase 1a's "window CLOSED" pattern — delete the dead branch in the same PR that removes its last caller. Memory `feedback_half_wired_window_pattern.md`.

**Phase 5/6 self-marker grep (10 hits across 7 files):**

```
$ rg -n "Phase 5|Phase 6" --no-heading -g '!node_modules' -g '!docs/plans/'
packages/agent-claude-sdk-runner/src/env.ts:8         (legacy AX_LLM_PROXY_URL)
packages/agent-claude-sdk-runner/src/env.ts:28        (legacy field)
packages/agent-claude-sdk-runner/src/__tests__/env.test.ts:5  (legacy path test)
packages/chat-orchestrator/src/orchestrator.ts:260    (proxy fallback comment)
packages/chat-orchestrator/src/orchestrator.ts:622    (proxy fallback comment)
packages/agent-claude-sdk-runner/src/proxy-startup.ts:31  (file header)
packages/agent-claude-sdk-runner/src/proxy-startup.ts:109 (legacy branch)
packages/agent-claude-sdk-runner/src/main.ts:77       (header comment)
packages/agent-claude-sdk-runner/src/main.ts:316      (proxy comment)
packages/sandbox-subprocess/src/open-session.ts:249   (half-wired comment)
```

These 10 hits are the deletion inventory for Phase 5. Plan author: re-grep before starting Task 1 to catch any drift since this plan was written.

---

## Invariants (verified per task)

These reflect Phase 2's end-to-end proxy lessons, Phase 3's rotate-session seam, and Phase 4's hard-cut discipline.

- **I1 — `chat:end` continues to fire exactly once per `agent:invoke`.** [Phase 4 wire-surface preservation; design Section 5 + Phase 7 prep.] Audit-log subscribes; conversations subscribes; the channel-web SSE handler subscribes via reqId. Any deletion that changes the chat:end firing pattern is out-of-scope; Phase 7 handles the audit-log subscription switch separately. *Prevents:* a "delete the legacy path" PR that accidentally regresses chat:end emission (e.g., if a runner now exits without firing, the deferred times out, audit-log misses the outcome shape it expects).
- **I2 — `chat:turn-end` continues to fire and the `proxy:rotate-session` seam stays intact for OAuth sessions.** [Phase 3 carry-over.] `sessionsNeedingRotation` Set + `onTurnEnd` handler in orchestrator must survive Phase 5 untouched. Verified by `packages/chat-orchestrator/src/__tests__/orchestrator.test.ts` rotation tests. *Prevents:* Phase 5 quietly losing the OAuth refresh seam Phase 3 added — if those tests pass before AND after, the seam is safe.
- **I3 — `agents:resolve` ACL gate fires on every `agent:invoke`.** [Week 9.5 carry-over.] No fast-path that skips it. *Prevents:* a "trim down the orchestrator" pass that removes the gate as visually-redundant — it's the multi-tenant authorization point.
- **I4 — J6 conversation routing (`conversations:get` → `session:is-alive` → route into existing session) keeps working when `@ax/conversations` is loaded.** [Week 10-12 carry-over.] *Prevents:* a deletion that strips the routing branch because it's "complex" — it's load-bearing for the channel-web web-chat path.
- **I5 — Hard cut on the legacy `AX_LLM_PROXY_URL` path.** [Phase 4 I1 / I12 carry-over.] No fallback alias, no compatibility shim. After Phase 5, setting `AX_LLM_PROXY_URL` in the runner env without one of `AX_PROXY_ENDPOINT` / `AX_PROXY_UNIX_SOCKET` causes a structured `MissingEnvError` (or equivalent) — not silent fall-through. *Prevents:* the rot pattern where "we'll keep the fallback for one more PR" turns into "we'll keep it forever." Memory `project_phase_1b_shipped.md` paid this lesson once.
- **I6 — Runner self-sufficiency audit.** The SDK runner must drive its own turn loop, fan tools via the SDK's `query()`, and signal `chat:end` through its IPC `event.chat-end` POST. Phase 5 confirms (does not introduce) this. *Prevents:* shipping a Phase 5 PR that assumes the runner is self-sufficient without verifying it — the design doc called this risk "medium-high"; the audit converts assumption to evidence.
- **I7 — `proxy:close-session` still fires exactly once per fresh-spawn `proxy:open-session`.** [Phase 2 I7 carry-over.] The `proxyOpened` flag + finally block in `runAgentInvoke` is load-bearing. *Prevents:* a refactor that re-wires the proxy lifecycle and silently introduces a leak (open without close on an error path).
- **I8 — `@ax/llm-proxy-anthropic-format` still ships and builds during Phase 5.** [Phase 4 I7 — "Phase 6 deletion targets stay green."] The package's deletion is Phase 6. Phase 5 just removes the runner's reliance on it; the package itself, the legacy env recognition's tests, and any other packages importing it stay buildable. *Prevents:* a Phase 5 PR that deletes too much and breaks the workspace build.
- **I9 — `pnpm build` + `pnpm test` clean across all packages at the end of every commit on the branch (or every commit pair, where one commit removes a definition and the next removes its callers).** [Phase 4 I2.] No build-broken intermediate states longer than one task. *Prevents:* the bisect-unfriendly chain Phase 4 had to accept; Phase 5 is small enough to keep every commit green.
- **I10 — No new half-wired plugins, hooks, or bus surfaces.** [Phase 4 I11.] Phase 5 is pure deletion + audit. *Prevents:* feature creep — "while we're in here, let's add X."
- **I11 — Audit-log subscription path unchanged.** [Phase 7 prep — out-of-scope for Phase 5.] `@ax/audit-log` continues to subscribe to `chat:end`; `event.http-egress` plumbing is Phase 7. *Prevents:* a "we're touching the orchestrator anyway" temptation to fold Phase 7 work into Phase 5. Phase 7 has its own boundary review.
- **I12 — `AgentInvokeInput` shape unchanged.** [Phase 4 carry-over.] `AgentInvokeInput { message: AgentMessage }` stays exactly as Phase 4 left it. The implementation behind `agent:invoke` shrinks (or in our case, mostly stays the same — the deletion is in the runner); the input contract does not. *Prevents:* a "rewrite agent:invoke" pass that subtly reshapes the input and forces channel-web's local redeclaration to drift.
- **I13 — `'chat-run-timeout'` / `'chat-run-error'` / `'chat_run_dispatch_failed'` reason+log strings preserved.** [Phase 4 wire-surface preservation; same reasoning.] *Prevents:* an audit-log subscriber breaking silently because a reason string changed.
- **I14 — `ChatTimeoutError` class stays.** [Phase 4 carry-over.] Distinct error type for the timeout branch; reused elsewhere if needed. *Prevents:* swallowing the type into a generic `Error` and losing the class-based discrimination at the catch site.

---

## Open questions resolved before execution

1. **Does Phase 5 also delete the dead-code branches in `runAgentInvoke` that handle `proxyConfig === undefined`?** **No, defer to Phase 6.** The orchestrator's `if (proxyOpenLoaded !== proxyCloseLoaded)` skew check + the `proxyLoaded === false` fall-through are wired for "no proxy plugin loaded" — that's still a valid mode for the mcp-client e2e harness and any preset that doesn't load `@ax/credential-proxy`. After Phase 6 deletes `@ax/llm-proxy-anthropic-format`, those preset variants either load the proxy or don't run — at which point we can tighten to "proxy is required." Phase 5 stops at "runner-side legacy path deleted," not "host-side soft-dep gating tightened."
2. **Does Phase 5 narrow `RunnerEnv` to require exactly one of `AX_PROXY_ENDPOINT` / `AX_PROXY_UNIX_SOCKET`?** **Yes.** `readRunnerEnv` currently accepts three modes (bridge, direct, legacy). Phase 5 collapses to two — exactly one of bridge/direct must be set; both set or neither set is a `MissingEnvError`. This is consistent with the existing belt-and-suspenders check in `setupProxy:56-60` (which already throws if both are set). The `llmProxyUrl?: string` field on `RunnerEnv` deletes.
3. **Should `runAgentInvoke` get factored into smaller helpers (`routeIntoLiveSession`, `openFreshSandbox`, etc.)?** **No, defer.** This is a clarity refactor with no behavior change. The 560-LOC body is dense but each block has a clear comment header and traces to a specific slice (Week 9.5 / 10-12 / Phase 2 / Phase 3). A future slice can take this on if-and-when the dense layout costs reading time; for now, keeping it inline preserves the comment density that documents the cross-slice invariants. Memory `feedback_minor_issues_non_blocking.md` says: don't chase perfection.
4. **Does the orchestrator's "proxy hooks misconfigured" structured-outcome path stay?** **Yes.** Lines 636-645 of `orchestrator.ts`. Belt-and-suspenders: a preset that loads `proxy:open-session` but not `proxy:close-session` (or vice versa) is misconfigured; better to fail loud at agent:invoke time than to leak an open proxy session. Phase 5 doesn't touch this.
5. **What happens to `@ax/llm-proxy-anthropic-format`'s tests during Phase 5?** They keep running. The package still builds and is exercised by its own unit tests; only the runner's reliance on it is removed. Phase 6 deletes the package.
6. **What about `@ax/llm-anthropic`, `@ax/agent-native-runner`, `@ax/agent-runner-core`'s `ChatMessage`-typed APIs (renamed in Phase 4 to `AgentMessage`)?** No change in Phase 5. These packages all still build (Phase 4 verified). Phase 6 deletes `@ax/llm-anthropic` + `@ax/agent-native-runner`; `@ax/agent-runner-core` stays (it's the shared library used by `@ax/agent-claude-sdk-runner`).
7. **Phase 5 sequencing relative to Phase 6:** Per design Section 7 sequencing diagram, Phase 5 must land before Phase 6 (Phase 6 depends on Phase 5). After Phase 5, Phase 6 deletes `@ax/llm-proxy-anthropic-format` + 9 other packages cleanly because the runner no longer boots into the legacy path.
8. **Multi-turn tool-use end-to-end test — does one exist or does Phase 5 add one?** Plan author: check `packages/agent-claude-sdk-runner/src/__tests__/claude-sdk-runner.e2e.test.ts` (Phase 2 referenced this as the gated e2e). If it exists and exercises bash + file_read in the same session, Phase 5's verification is "this test passes." If it only exercises a single tool, Phase 5 adds a multi-tool case — but only if the existing coverage is genuinely insufficient. Don't add tests speculatively.
9. **Does the `AX_LLM_PROXY_URL` env-var deletion break any operator-facing docs?** Plan author: grep `~/.ax/`, `ax.config.ts`, and operator-facing READMEs (the few that are tracked, per Phase 4 finding) for mentions. If any reference exists, update or delete in the same commit that deletes the recognition. Most likely there are none — Phase 2's PR notes documented the new env vars and the legacy path was already self-marked as deprecated.

---

## Tasks

### Task 1: Pre-execution survey + baseline confirmation

**Goal:** Verify the deletion inventory is still accurate and that the workspace is green at HEAD before any change.

**Files:** Read-only — `packages/agent-claude-sdk-runner/src/{env.ts,proxy-startup.ts,main.ts}`, `packages/chat-orchestrator/src/orchestrator.ts`, `packages/sandbox-subprocess/src/open-session.ts`.

**Step 1.1: Re-grep for Phase 5/6 markers**

```bash
rg -n 'Phase 5|Phase 6' --no-heading -g '!node_modules' -g '!dist' -g '!.git' -g '!docs/plans/'
```

Expected: ~10 hits across the 7 files listed in Reference material above. If counts have drifted (e.g., a stray new `Phase 6` comment landed since this plan was written), STOP and reconcile before continuing. Memory `feedback_check_plan_vs_reality.md`.

**Step 1.2: Confirm the legacy path is the only recognition of `AX_LLM_PROXY_URL`**

```bash
rg -n 'AX_LLM_PROXY_URL|llmProxyUrl' --no-heading -g '!node_modules' -g '!dist' -g '!.git' -g '!docs/plans/'
```

Expected: hits in `env.ts`, `env.test.ts`, `proxy-startup.ts`, plus possibly one or two operator-facing comment references. If hits show up in unexpected places (e.g., `presets/k8s/`, `cli/main.ts`), STOP and reconcile.

**Step 1.3: Baseline build + test**

```bash
pnpm build
pnpm test
```

Expected: clean build; all packages green. Captures the pre-Phase-5 baseline so any regression introduced later is attributable.

**Step 1.4: No commit** — read-only verification.

---

### Task 2: Delete the legacy `AX_LLM_PROXY_URL` recognition in `@ax/agent-claude-sdk-runner`

**Goal:** Remove the legacy env-var recognition + the corresponding branch in `setupProxy`. After this task, `RunnerEnv` exposes only `proxyEndpoint` and `proxyUnixSocket` (in addition to the always-present `authToken`, `runnerEndpoint`, etc.); `setupProxy` always takes the Phase 2 path.

**Files:**
- Modify: `packages/agent-claude-sdk-runner/src/env.ts` (delete `llmProxyUrl` field; tighten `readRunnerEnv` validation)
- Modify: `packages/agent-claude-sdk-runner/src/proxy-startup.ts` (delete the legacy branch lines 106-118; update file header comment block lines 1-33)
- Modify: `packages/agent-claude-sdk-runner/src/__tests__/env.test.ts` (delete legacy-path tests; keep + tighten the "exactly one of bridge/direct" assertion)

**Step 2.1: Write the failing test**

Add to `packages/agent-claude-sdk-runner/src/__tests__/env.test.ts`:

```ts
it('readRunnerEnv rejects when neither AX_PROXY_ENDPOINT nor AX_PROXY_UNIX_SOCKET is set', () => {
  const baseEnv = {
    AX_RUNNER_ENDPOINT: 'unix:///tmp/sock',
    AX_AUTH_TOKEN: 't',
    AX_SESSION_ID: 's',
    // Intentionally NO AX_PROXY_ENDPOINT, NO AX_PROXY_UNIX_SOCKET, NO AX_LLM_PROXY_URL.
  };
  expect(() => readRunnerEnv(baseEnv)).toThrow(MissingEnvError);
});

it('readRunnerEnv ignores AX_LLM_PROXY_URL (legacy path deleted in Phase 5)', () => {
  const env = readRunnerEnv({
    AX_RUNNER_ENDPOINT: 'unix:///tmp/sock',
    AX_AUTH_TOKEN: 't',
    AX_SESSION_ID: 's',
    AX_PROXY_ENDPOINT: 'http://127.0.0.1:8443',
    AX_LLM_PROXY_URL: 'http://legacy.local',  // present but ignored
  });
  // The returned env should not carry an llmProxyUrl field.
  expect((env as Record<string, unknown>).llmProxyUrl).toBeUndefined();
  expect(env.proxyEndpoint).toBe('http://127.0.0.1:8443');
});
```

Plus delete any existing test that asserts the legacy `AX_LLM_PROXY_URL`-only path is valid.

Run: `pnpm --filter @ax/agent-claude-sdk-runner test -- env`
Expected: FAIL — `readRunnerEnv` still accepts the legacy path.

**Step 2.2: Update `env.ts`**

Delete the `llmProxyUrl?: string` field from `RunnerEnv`. Update `readRunnerEnv`:

- If `AX_LLM_PROXY_URL` is set, ignore it (don't read into the returned object). Don't error on its presence — operators may have stale shell exports.
- Validate that exactly one of `AX_PROXY_ENDPOINT` and `AX_PROXY_UNIX_SOCKET` is set. If both, throw. If neither, throw (this is the new tightening — pre-Phase-5 the legacy path was the fallback).

Update the header comment block (lines 1-30 area) to remove the "Phase 5/6 deletes…" forward references — Phase 5 IS that deletion.

**Step 2.3: Update `proxy-startup.ts`**

- Delete lines 106-118 (the `else { ... ANTHROPIC_BASE_URL = env.llmProxyUrl ... }` branch).
- Adjust the surrounding `if` to be unconditional Phase 2 path (the `if (env.proxyEndpoint !== undefined || env.proxyUnixSocket !== undefined)` check becomes redundant given the new `readRunnerEnv` contract — drop the conditional and always run the Phase 2 path).
- Delete the `if (placeholder === undefined || placeholder.length === 0)` belt-and-suspenders if it's load-bearing on the legacy fallback only; keep it if it's load-bearing on the Phase 2 path's "credential not yet ready" race. Plan author: keep it — it's still a valid invariant per I1.
- Update the file header comment block (lines 1-33) to drop the legacy mode description.

**Step 2.4: Run tests + commit**

```bash
pnpm --filter @ax/agent-claude-sdk-runner build
pnpm --filter @ax/agent-claude-sdk-runner test
```

Expected: green for `@ax/agent-claude-sdk-runner`. The runner's own unit tests + the gated e2e (if env-set).

```bash
git add packages/agent-claude-sdk-runner
git commit -m "refactor(claude-sdk-runner): delete legacy AX_LLM_PROXY_URL fallback [Phase 5]"
```

---

### Task 3: Update orchestrator + sandbox-subprocess comments

**Goal:** The orchestrator and sandbox-subprocess each have one or two comment blocks that say "Phase 5/6 deletes the fallback." With Task 2 landed, those references are now past tense — rewrite or delete.

**Files:**
- Modify: `packages/chat-orchestrator/src/orchestrator.ts:260, 622`
- Modify: `packages/sandbox-subprocess/src/open-session.ts:249`
- Modify: `packages/agent-claude-sdk-runner/src/main.ts:77, 316`

**Step 3.1: Read each comment block**

Read each of the 5 line ranges (each comment is part of a multi-line block). Determine for each: is the comment about the legacy fallback specifically (delete or rewrite to past tense), or about something else that mentions the fallback in passing (just trim the legacy reference)?

**Step 3.2: Rewrite or delete**

- If the comment exists ONLY to flag the upcoming Phase 5/6 deletion, delete the comment entirely (the deletion has happened; the comment is now noise).
- If the comment explains a load-bearing invariant and mentions the fallback as one of two paths, rewrite to remove the legacy mention. CLAUDE.md guidance: "Default to no comments. Only add one when the WHY is non-obvious." After Phase 5, the legacy path doesn't exist — comments documenting it as one of two modes need updating to reflect the single-mode reality.

**Step 3.3: Investigate `sandbox-subprocess/open-session.ts:249`**

This one mentions "Phase 5/6" in a half-wired-code policy context. Read the surrounding ~30 lines. If there's a code branch wired to the legacy AX_LLM_PROXY_URL injection that needs deletion (not just a comment), delete the branch in this same commit. If it's only a comment, rewrite. Memory `feedback_half_wired_window_pattern.md` — the half-wired window for the legacy path closes here.

**Step 3.4: Run + commit**

```bash
pnpm build
pnpm test
```

All packages green.

```bash
git add packages/chat-orchestrator packages/sandbox-subprocess packages/agent-claude-sdk-runner
git commit -m "docs(phase-5): retire 'Phase 5/6 deletes' forward references [Phase 5]"
```

---

### Task 4: Runner self-sufficiency audit

**Goal:** Convert "the SDK runner is self-sufficient" from assumption to documented evidence. This is the medium-high-risk item the design called out for Phase 5; with the legacy fallback gone, we want to verify the runner doesn't silently rely on host-side coordination for any code path.

**Files:** Read-only — `packages/agent-claude-sdk-runner/src/{main.ts,can-use-tool.ts,host-mcp-server.ts,pre-tool-use.ts,post-tool-use.ts}`.

**Step 4.1: Audit checklist**

For each item, find the answer in the code (cite file:line):

1. **Does the runner ever call `tool.execute-host` IPC?** Expected: no. Tool dispatch is the SDK's responsibility; host-mediated MCP tools go through `mcp-client` over the IPC bus, not via the deprecated `tool.execute-host`.
2. **Does the runner ever call `llm.call` IPC?** Expected: no. The SDK's outbound HTTP goes through the credential-proxy to Anthropic directly; no host-side LLM call mediation.
3. **Does the runner own its own retry / stop-reason / turn loop?** Expected: yes. The `query()` function from `@anthropic-ai/claude-agent-sdk` drives the loop in-sandbox; the runner only consumes its async iterator.
4. **Does the runner emit `event.chat-end` reliably on every exit path?** Expected: yes. Verified by Phase 2 (the IPC server's `/event.chat-end` handler resolves the orchestrator's deferred). Spot-check the runner's exit code paths (lines 54-58 of main.ts list "Exit codes" — confirm each exit path emits chat-end before exiting).
5. **Does the runner depend on any host hook other than the per-session hooks the orchestrator already calls?** Expected: no — runner uses IPC actions (`session:next-message`, `tool.list`, `tool.invoke`, `event.stream-chunk`, `event.chat-end`, `workspace:read`, etc.), not the in-process hook bus.

**Step 4.2: Write the audit findings to a doc-comment**

Where appropriate, add a short audit-summary comment to `packages/agent-claude-sdk-runner/src/main.ts` near the top (near the existing "Shape:" comment around line 48-52), documenting the self-sufficiency contract going forward. CLAUDE.md "Default to no comments" applies — this comment earns its weight because the contract is non-obvious from reading the code (the SDK's internal turn loop is opaque). Two sentences max; reference the audit task and date.

If the audit finds any latent host-side dependency, STOP and report — that's a new Phase 5 task, not a doc update.

**Step 4.3: Commit (if doc-comment added)**

```bash
git add packages/agent-claude-sdk-runner/src/main.ts
git commit -m "docs(claude-sdk-runner): record self-sufficiency audit (Phase 5) [Phase 5]"
```

If no comment was needed (the existing comments at lines 34-58 already cover the contract), skip the commit and note in Task 11's verification report.

---

### Task 5: Multi-turn tool-use end-to-end verification

**Goal:** Confirm the verification gates the user prompt called out: canary, multi-turn tool-use, conversations bind-session, audit-log behavior unchanged.

**Files:** Test-only — no production code changes.

**Step 5.1: Canary acceptance test**

```bash
pnpm test --filter @ax/cli
```

Confirm the CLI canary acceptance test (`packages/cli/src/__tests__/canary.test.ts` if present, or whatever the equivalent is) passes. The canary is `ax-next "list this directory"` end-to-end through the orchestrator, proxy, sandbox, runner.

Expected: pass. If gated on env vars (e.g., `ANTHROPIC_API_KEY`), document the skip.

**Step 5.2: Multi-turn tool-use test**

```bash
pnpm test --filter @ax/agent-claude-sdk-runner -- e2e
```

Look for `claude-sdk-runner.e2e.test.ts` or equivalent. If it exercises bash + file_read in the same session, Phase 5's verification is "this test passes."

Expected: pass (or environment-gated skip with `ANTHROPIC_API_KEY` / `AX_TEST_*` not set).

If no multi-tool test exists, Phase 5 ADDS ONE — but only if the existing coverage is genuinely insufficient. Plan author judgment: a new e2e test is a real cost (CI time, key requirements, env brittleness); skip it if a single-tool e2e + the orchestrator unit tests already cover the relevant code paths.

**Step 5.3: Conversations bind-session + route-by-conversation tests**

```bash
pnpm test --filter @ax/conversations
pnpm test --filter @ax/chat-orchestrator -- route
```

Expected: pass. These exercise the J6 routing branch (Week 10-12) — Phase 5 must NOT regress them.

**Step 5.4: Audit-log behavior unchanged**

```bash
pnpm test --filter @ax/audit-log
```

Expected: pass. `chat:end` still fires once per `agent:invoke`; audit-log's subscriber still records the same outcome shape.

**Step 5.5: No commit** — this is a verification-only task. Document findings in Task 6's PR notes.

---

### Task 6: Final verification + boundary review note

**Goal:** Confirm full workspace builds clean. Compose the boundary-review section for the PR description (per design's "Phase 5 medium-high risk" framing — the boundary review explains what the risk turned into).

**Step 6.1: Full workspace build + test**

```bash
pnpm build
pnpm test
```

Expected: green across all packages. No regressions.

**Step 6.2: Re-grep for stragglers**

```bash
rg -n 'AX_LLM_PROXY_URL|llmProxyUrl' --no-heading -g '!node_modules' -g '!dist' -g '!.git' -g '!docs/plans/'
rg -n 'Phase 5/6 deletes' --no-heading -g '!node_modules' -g '!dist' -g '!.git' -g '!docs/plans/'
```

Expected: zero hits in code (or only operator-doc references that update in the same commit).

**Step 6.3: Compose boundary-review block for PR description**

Per design, Phase 5 changes the runner's egress contract (it always uses the credential-proxy now). Boundary review template:

```markdown
## Boundary review — runner egress contract tightening

- **Alternate impl this contract could have:** an LLM proxy that lives elsewhere (sidecar container, a different in-sandbox listener). The contract today: runner reads `AX_PROXY_ENDPOINT` (subprocess) or `AX_PROXY_UNIX_SOCKET` (k8s) from env, sets HTTPS_PROXY accordingly, calls `api.anthropic.com` directly. Alternate impls would set the same env vars and the runner would not need to change.
- **Payload field names that might leak:** none. The env-var contract is `AX_PROXY_ENDPOINT` (URL) + `AX_PROXY_UNIX_SOCKET` (path). Both are generic transport-shape names; neither implies a specific backend (Unix socket vs TCP is a transport detail, not a backend).
- **Subscriber risk:** none. No subscribers to runner env-var contracts. The orchestrator's `proxy:open-session` → `proxyEndpoint` return is the upstream — that contract is unchanged.
- **Wire surface:** the runner's process env. The host still injects `ANTHROPIC_API_KEY=ax-cred:<hex>` placeholder + `AX_PROXY_*` for the proxy mode + `NODE_EXTRA_CA_CERTS` etc. for trust. After Phase 5: no `AX_LLM_PROXY_URL` (legacy) and no `ANTHROPIC_BASE_URL` injection. The runner reaches Anthropic directly through the proxy.
```

**Step 6.4: Compose Phase 5 PR notes**

Mirror Phase 4's PR-notes structure (`docs/plans/2026-04-30-phase-4-pr-notes.md`): What lands, Reality-check deviations from plan, Half-wired window CLOSED, Boundary review, Invariants verified, Stats, Bisect note, Operator notes (whether `AX_LLM_PROXY_URL` was previously documented anywhere — if so, note the deletion), Follow-ups.

Save as `docs/plans/<YYYY-MM-DD>-phase-5-pr-notes.md` AFTER the PR opens (gitignored; local-only artifact, same as Phase 4).

**Step 6.5: No commit for this task** — verification + PR-description prep only.

---

## Acceptance criteria (verified before merge)

| | Criterion | How verified |
|---|---|---|
| I1 | `chat:end` fires exactly once per `agent:invoke` | Existing audit-log + orchestrator tests pass |
| I2 | `chat:turn-end` + `proxy:rotate-session` seam intact | Existing rotation tests pass |
| I3 | `agents:resolve` ACL gate fires on every chat | Existing orchestrator tests pass |
| I4 | J6 conversation routing intact | Existing route-by-conversation tests pass |
| I5 | Hard cut on `AX_LLM_PROXY_URL` legacy path | Task 6 grep clean; new env.test.ts cases pass |
| I6 | Runner self-sufficiency audited | Task 4 audit checklist filed; PR description references it |
| I7 | `proxy:close-session` fires once per `proxy:open-session` | Existing proxy-lifecycle tests pass |
| I8 | `@ax/llm-proxy-anthropic-format` still builds | `pnpm --filter @ax/llm-proxy-anthropic-format build` clean |
| I9 | All commits leave workspace buildable | Per-task `pnpm build` + `pnpm test` |
| I10 | No new half-wired plugins / hooks / bus surfaces | Visual review of diff — no new exports, no new manifest entries |
| I11 | Audit-log subscription unchanged (chat:end-based) | `git diff` on `packages/audit-log/` is empty |
| I12 | `AgentInvokeInput` shape unchanged | `git diff` on `packages/chat-orchestrator/src/orchestrator.ts:71-74` shows no interface change |
| I13 | Wire-surface reason+log strings preserved | Grep confirms `chat-run-timeout` / `chat-run-error` / `chat_run_dispatch_failed` still present |
| I14 | `ChatTimeoutError` class stays | Grep confirms class still defined |

---

## Phase 2/3/4 lessons feeding into this plan

| Lesson | How it shapes Phase 5 |
|---|---|
| **Phase 2 — end-to-end proxy + bridge wiring** | Phase 2 made the credential-proxy the production path. Phase 5's deletion of the legacy fallback is the Phase 2 follow-up that closes the half-wired window for `AX_LLM_PROXY_URL`. Memory `feedback_half_wired_window_pattern.md`. |
| **Phase 3 — rotate-session + chat:turn-end seam** | Phase 3 added `sessionsNeedingRotation` Set + `onTurnEnd` handler in orchestrator. Phase 5 invariant I2 explicitly preserves this; the seam must survive untouched, with the rotation tests as the gate. |
| **Phase 4 — hard-cut discipline + wire-surface preservation** | Phase 4 I1 (no aliasing) → Phase 5 I5 (hard cut on legacy). Phase 4 I13 (wire-surface reason strings preserved) → Phase 5 I13 (same — `chat-run-*` and `chat_run_dispatch_failed` stay). Phase 4 reality-check pattern → Phase 5 Task 1 (re-grep before any change; the design's premise is partially obsolete). Memory `feedback_check_plan_vs_reality.md`. |
| **`feedback_targeted_followup_commits.md`** | If a CR pass turns up an issue (e.g., a missed comment update or a stray `AX_LLM_PROXY_URL` reference), prefer a small follow-up commit to a reflexive amend. |
| **`feedback_minor_issues_non_blocking.md`** | Open question §3 (clarity refactor of `runAgentInvoke` body) is deliberately deferred. Phase 5 ships when the legacy path is gone and verification gates pass; it does NOT block on a clarity rewrite that earns no behavioral change. |

---

## Estimated landing

- **Tasks:** 6 (1 read-only survey + 4 substantive + 1 verification).
- **Commits:** ~3 (one per logical group: claude-sdk-runner deletion, comments cleanup, optional self-sufficiency audit comment).
- **Files touched:** ~8.
- **Risk:** **Medium-low** (revised down from design's "medium-high" — the runner self-sufficiency the design worried about is already in production via Phase 2; Phase 5 just deletes the dead fallback).
- **Predecessors:** Phase 4 (PR #22, in-flight or merged at execution time). No blocking dependency on Phase 4 — Phase 5 doesn't touch the renamed types — but Phase 4 should be merged or close to merging to avoid re-base churn.
- **Successors:** Phase 6 (delete `@ax/llm-proxy-anthropic-format` + 9 other packages) depends on Phase 5 being merged. Phase 7 (kernel cleanup + audit-log subscription switch + AgentMessage role narrowing) depends on Phase 6.

---

## Out-of-scope reminder

Phase 5 does NOT:

- Delete `@ax/llm-proxy-anthropic-format` (Phase 6).
- Delete `@ax/llm-anthropic`, `@ax/agent-native-runner`, `@ax/llm-mock`, `@ax/tool-dispatcher`, `@ax/tool-bash*`, `@ax/tool-file-io*` (Phase 6).
- Delete `LlmRequest` / `LlmResponse` / `ToolCall` / `ToolDescriptor` / `ToolPreCall*` / `ToolExecuteHost*` from `@ax/core` or `@ax/ipc-protocol` (Phase 7).
- Switch `@ax/audit-log`'s subscription from `chat:end` to `event.http-egress` (Phase 7).
- Narrow `AgentMessage` from 3 roles to 2 (Phase 7).
- Refactor `runAgentInvoke` for clarity (deferred — open question §3).
- Touch the package name `@ax/chat-orchestrator` (deferred per Phase 4 plan I8).

The discipline: each phase deletes exactly the dead code from the prior phases that's now reachable to remove. Phase 5 is the smallest such slice — it unblocks Phase 6's mass deletion.
