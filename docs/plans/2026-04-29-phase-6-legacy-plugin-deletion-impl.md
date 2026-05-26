# Phase 6 Implementation Plan — delete legacy plugin set (8 packages, host-side gating tightening)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Delete the 8 host-side plugin packages that became unreachable after Phase 5 (`@ax/llm-proxy-anthropic-format` + 7 others), tighten the chat-orchestrator's proxy gating to fail loud at `agent:invoke` time instead of letting the runner fail at boot, and clean up the `cfg.llm` / `cfg.runner` config dimensions that no longer have multiple valid values. The SDK runner via credential-proxy becomes the only path; legacy `llm:call`-based topology stops compiling.

**Architecture:** Phase 5 closed the half-wired window for `AX_LLM_PROXY_URL` (the runner-side fallback was deleted; `sandbox-subprocess`'s `useLegacyProxy` branch was deleted; the orchestrator's "Phase 5/6 deletes…" forward-references were retired). After Phase 5 the workspace is in a "legacy packages still build but nothing wires them into the running system" state. Phase 6 is the cleanup that removes the packages themselves, plus the schema fields and host-side IPC wiring that only had value when the legacy runner existed. The chat path narrows to: CLI/preset → `agent-claude-sdk-runner` (only runner) → in-sandbox SDK → `api.anthropic.com` via `credential-proxy` (only LLM transport).

**Tech Stack:**

- TypeScript / Node 20+
- Vitest (`.test.ts` per package)
- pnpm workspace + tsconfig refs (every deletion needs both touched)
- No new dependencies, no new plugins
- One existing plugin (`@ax/tool-dispatcher`) is **deferred** out of the deletion set per reality-check below

**Out-of-scope (deferred):**

- **`@ax/tool-dispatcher` deletion.** Reality-check (below) shows the design's "delete this" call is wrong for this slice — `tool:register` and `tool:list` are load-bearing for retained plugins (`@ax/mcp-client`, `@ax/test-harness`'s `createTestHostToolPlugin`, `@ax/agent-claude-sdk-runner`'s `tool.list` IPC). Deleting the plugin requires moving the catalog ownership to a retained plugin (likely `@ax/mcp-client`) or to a smaller successor plugin. That's a redesign, not a hard-cut deletion. Phase 6 leaves `@ax/tool-dispatcher` in place. A future slice ("host-tool catalog ownership") owns the move. The design doc's Section 6 deletes table is wrong on this row at HEAD; the plan's reality-check section flags it explicitly.
- **`@ax/agent-runner-core` deletion.** Still imported by `@ax/agent-claude-sdk-runner` (IpcClient type, DiffAccumulator, createDiffAccumulator, SessionInvalidError, toWireChanges) and by `@ax/tool-bash-impl` / `@ax/tool-file-io-impl` (which DO delete in Phase 6 along with the native runner). The SDK runner shedding its dependency is a separate refactor. Phase 5 also deferred this. Phase 7 or a dedicated successor slice owns the merge.
- **Kernel-type deletion** (`LlmRequest` / `LlmResponse` / `ToolCall` / `ToolDescriptor` / `ToolPreCall*`) from `@ax/core` and `@ax/ipc-protocol`. Phase 7. Some are still used by `@ax/agent-claude-sdk-runner` (`ToolCall` shape on `tool.pre-call` payloads, `ToolDescriptor` for the host MCP server) — Phase 7 audits which are truly orphaned.
- **`ToolExecuteHost*` types** stay (Phase 5 audit: live; canonical SDK-runner → host route via `host-mcp-server.ts:116`). Out of scope.
- **Switching `@ax/audit-log`'s subscription** from `chat:end` to `event.http-egress`. Phase 7. Audit-log already subscribes to both today; Phase 7 drops the chat:end one.
- **Narrowing `AgentMessage`** from 3 roles to 2. Phase 7.
- **The `runAgentInvoke` clarity refactor.** Same reasoning as Phase 5 — defer.

---

## Reality check — what the design said vs. what's actually in the tree

The design doc's Section 6 Deletes table lists 10 plugins. A pre-execution survey at HEAD of `main` (post-Phase 5, post-#23-merge) shows that 1 of those 10 cannot be cleanly deleted in this slice, and the other 9 (we're treating `@ax/agent-runner-core` separately as already deferred by Phase 5) have specific consumer footprints worth enumerating *before* writing the task list.

| Design's premise | Reality at HEAD of `main` (post-Phase 5) |
|---|---|
| Delete `@ax/llm-proxy-anthropic-format` | **Cleanly deletable.** No production code calls its hooks after Phase 5. Two prod imports (`packages/cli/src/main.ts:22`, `presets/k8s/src/index.ts:11`) + one test devDep (`packages/sandbox-subprocess/package.json:26`, no `from` import — devDep is stale). Package's own 81 unit tests retire with the package. |
| Delete `@ax/llm-anthropic` | **Cleanly deletable.** Two prod imports (`packages/cli/src/main.ts:12`, `presets/k8s/src/index.ts:10`) + one test seam (`packages/cli/src/__tests__/e2e-real-llm.test.ts` — uses `anthropicClientFactory` to stub the Anthropic SDK; whole test retires with the package). |
| Delete `@ax/agent-native-runner` | **Cleanly deletable.** Zero static `import` statements outside the package itself + tests. Resolved dynamically via `requireFromCli.resolve('@ax/agent-native-runner')` in `packages/cli/src/main.ts:58` and `packages/cli/src/__tests__/main.test.ts:6`. Default for `cfg.runner: 'native'` in `packages/cli/src/config/schema.ts:21`. |
| Delete `@ax/llm-mock` | **Cleanly deletable.** Three import sites: `packages/cli/src/main.ts:11`, `presets/k8s/src/__tests__/acceptance.test.ts:29`, `presets/k8s/src/__tests__/multi-tenant-acceptance.test.ts:26`. Both preset tests need conversion to a non-llm-mock setup OR the tests' "no real LLM" mode needs another mechanism. |
| Delete `@ax/tool-dispatcher` | **REALITY-CHECK FAIL — defer.** Registers `tool:register` + `tool:list`. Live consumers in retained plugins: `@ax/mcp-client/src/plugin.ts:203` calls `tool:register` for every MCP tool; `@ax/test-harness/src/test-host-tool.ts:82` calls `tool:register`; `@ax/agent-claude-sdk-runner/src/main.ts:174` consumes `tool.list` IPC which routes to `bus.call('tool:list')`. After Phase 6 the SDK runner still needs the host-tool catalog to know which `executesIn:'host'` tools to expose via the host MCP server. Cannot delete in a hard-cut Phase 6 — needs a redesign that moves ownership. **Plan author decision: leave `@ax/tool-dispatcher` in place.** Section 6's table is wrong at HEAD on this row. |
| Delete `@ax/tool-bash` and `@ax/tool-bash-impl` | **Cleanly deletable.** `@ax/tool-bash` imports from `cli/main.ts:25`, `presets/k8s/src/index.ts:14`, `e2e-real-llm.test.ts` (test seam). `@ax/tool-bash-impl` imports from `agent-native-runner/src/main.ts:14` ONLY — deletes alongside the native runner. |
| Delete `@ax/tool-file-io` and `@ax/tool-file-io-impl` | **Cleanly deletable.** `@ax/tool-file-io` imports from `cli/main.ts:26`, `presets/k8s/src/index.ts:15`. `@ax/tool-file-io-impl` imports from `agent-native-runner/src/main.ts:15` ONLY. Two **comment** references in `packages/agent-claude-sdk-runner/src/workspace-diff.ts:34, 55` mention `@ax/tool-file-io-impl` ("constants redeclared, not imported") — those need editing in the same commit that deletes the impl package, or future readers chase a dangling reference. |
| Delete `@ax/agent-runner-core` | **DEFERRED.** Phase 5's PR notes say "agent-runner-core stays (it's the shared library used by @ax/agent-claude-sdk-runner)." Still imported by the SDK runner for IpcClient type, DiffAccumulator, createDiffAccumulator, SessionInvalidError, toWireChanges. Phase 6 does NOT delete it. |

**Summary:** Phase 6 deletes **8 packages** (not 10): `@ax/llm-proxy-anthropic-format`, `@ax/llm-anthropic`, `@ax/agent-native-runner`, `@ax/llm-mock`, `@ax/tool-bash`, `@ax/tool-bash-impl`, `@ax/tool-file-io`, `@ax/tool-file-io-impl`. `@ax/tool-dispatcher` stays (reality-check pushback). `@ax/agent-runner-core` stays (Phase 5's deferred decision still holds).

**Cascading host-side cleanups that fall out of the deletions:**

- The CLI's `cfg.runner` enum (`'native' | 'claude-sdk'`) collapses to one valid value. Either drop the field entirely (the SDK runner is the only runner) or narrow the enum to `['claude-sdk']` and change the default. Plan picks **drop the field** — no consumer needs the dimension after `'native'` is gone.
- The CLI's `cfg.llm` enum (`'anthropic' | 'mock'`) similarly collapses. Today it gates "load `@ax/credential-proxy`" (only on `'anthropic'`) and "push the LLM plugin" (anthropic vs. mock). After Phase 6: SDK runner always uses the credential-proxy, no LLM plugin is loaded host-side. Plan picks **drop the field** — load credential-proxy unconditionally (still gated by `skipCredentialProxy` test seam).
- `packages/ipc-server/src/plugin.ts:80` declares `'llm:call'` in its manifest `calls`. After deletion, no plugin registers `llm:call`; bootstrap will fail with "no plugin registered for service hook 'llm:call'" unless we drop that line.
- `packages/ipc-http/src/plugin.ts:45` likewise declares `'llm:call'`. Same drop needed.
- `packages/ipc-core/src/handlers/llm-call.ts` is the IPC dispatcher entry that calls `bus.call('llm:call')`. Only invoked by the native runner. Delete the handler, its registration in `packages/ipc-core/src/listener.ts` (or wherever it's wired), and the test file.
- `tool:execute-host` IPC handler stays — it's the SDK runner's host-tool route (Phase 5 audit). Out of scope.

**Half-wired windows that close in this PR:**

| Window opened in… | What stayed live | What Phase 6 closes |
|---|---|---|
| Phase 2 (PR #5) | The legacy `llm-proxy-anthropic-format` listener was loaded by every preset that loaded the orchestrator, even after the credential-proxy became the production path. Phase 5 stopped routing to it; Phase 6 deletes the plugin. | Window CLOSED. |
| Week 6.5d | The CLI defaulted `cfg.runner: 'native'` so the canary acceptance test could run without a real claude binary. After Phase 5 the SDK runner is the only runtime that's still wired through the credential-proxy. | Window CLOSED — `cfg.runner` dropped, `agent-native-runner` deleted, `e2e-real-llm.test.ts` retires. |
| Section 6 Deletes table | The design listed all 10 deletions as a single Phase 6 commitment. | Window NOT YET CLOSED for `@ax/tool-dispatcher` and `@ax/agent-runner-core`. Both stay; the table is updated by this PR's notes (or a successor's). |

---

## Reference material

ax-next files this plan touches (read before editing):

| File | Why |
|---|---|
| `packages/llm-proxy-anthropic-format/` (whole tree) | Delete. |
| `packages/llm-anthropic/` (whole tree) | Delete. |
| `packages/agent-native-runner/` (whole tree) | Delete. |
| `packages/llm-mock/` (whole tree) | Delete. |
| `packages/tool-bash/` (whole tree) | Delete. |
| `packages/tool-bash-impl/` (whole tree) | Delete. |
| `packages/tool-file-io/` (whole tree) | Delete. |
| `packages/tool-file-io-impl/` (whole tree) | Delete. |
| `packages/cli/src/main.ts:11-12, 22, 24-26, 40-64, 222-232, 250-271, 181-187` | Drop legacy imports. Simplify `resolveRunnerBinary` to a single-case (or inline the resolve, since `cfg.runner` is also dropping). Drop the `cfg.tools` push of bash/file-io plugins. Drop the `cfg.llm` LLM-selection block. Tighten the credential-proxy gate to `if (opts.skipCredentialProxy !== true)`. |
| `packages/cli/src/config/schema.ts:14, 17-23, 25-30` | Drop `llm`, `runner`, `tools`, `anthropic` config fields. (Or narrow the enums and keep the dimensions if a future phase reintroduces choice — plan picks drop.) |
| `packages/cli/package.json:25-44` | Drop deletion-target dependencies. |
| `packages/cli/tsconfig.json:9, 11, 16-23` | Drop deletion-target tsconfig refs. |
| `packages/cli/src/__tests__/main.test.ts` (whole) | Whole test retires (asserts `resolveRunnerBinary` for both runner values; one is gone, the function may also go). Convert to a no-op or delete. |
| `packages/cli/src/__tests__/e2e-real-llm.test.ts` (whole) | Whole test retires (uses `llm: 'anthropic'` + `tools: ['bash']` + native runner default). Coverage gap: audit-log SQLite outcome shape — already covered by `@ax/audit-log` unit tests + `@ax/cli/__tests__/e2e.test.ts`. Net: delete. |
| `packages/cli/src/__tests__/mcp-client.e2e.test.ts` (whole) | Whole test retires (uses `llm: 'mock'` + native runner default + stub `llm:call`). The MCP stdio-server end-to-end coverage is unique. **Decision:** delete this file in Phase 6 PR-A; the rewritten claude-sdk-runner.e2e (PR-B) absorbs the MCP coverage. **Trade-off:** brief gap in MCP-stdio coverage between PR-A merge and PR-B merge. The `@ax/mcp-client` package's own unit tests (~25 cases) cover the plugin's mechanics; only the host-end-to-end shape is missing. Acceptable given PR-B follows quickly. |
| `packages/cli/src/__tests__/credential-proxy.e2e.test.ts:151-157` | Drop `llm: 'anthropic'` + `runner: 'claude-sdk'` from configOverride (both fields gone from schema). Test still works — uses `runner: 'claude-sdk'` explicitly today, but since it'll be the only runner the field is dead. |
| `packages/cli/src/__tests__/claude-sdk-runner.e2e.test.ts` | Stays SKIPPED through PR-A. PR-B (separate slice) rewrites it. |
| `presets/k8s/src/index.ts:10-11, 13-15, 506-535, 546-555, 198-204` | Drop legacy imports. Drop bash/file-io/llm-anthropic/llm-proxy plugin loads. Drop the section-9 LLM block. Drop the `anthropic` config field. tool-dispatcher push stays (Phase 6 keeps the plugin). |
| `presets/k8s/package.json:11, 12, 21, 22, 23, 31` | Drop deletion-target dependencies. **Note:** `@ax/llm-mock` is a devDep — also retire. |
| `presets/k8s/tsconfig.json` | Drop deletion-target refs. |
| `presets/k8s/src/__tests__/acceptance.test.ts:29, 205` | Uses `llmMockPlugin()`. Whole test rebuilds against an alternative no-LLM path OR retires (it's a CI canary, not a unit test). **Decision:** delete the test in PR-A, rebuild in PR-B alongside the SDK e2e rewrite. Same trade-off as `mcp-client.e2e.test.ts`. |
| `presets/k8s/src/__tests__/multi-tenant-acceptance.test.ts:26, 408` | Same as acceptance.test.ts. |
| `packages/sandbox-subprocess/package.json:26` | Drop the `@ax/llm-proxy-anthropic-format` devDep (already unused at HEAD — Phase 5 dropped the imports; this is the package.json residue). |
| `packages/agent-claude-sdk-runner/src/workspace-diff.ts:34, 55` | Edit the two comments that reference `@ax/tool-file-io-impl` (constants redeclared from there). After deletion the path doesn't exist; either reword to "1 MiB ceiling" without the cross-reference, or replace the cross-reference with the inline value. |
| `packages/ipc-server/src/plugin.ts:77-82` | Drop `'llm:call'` from manifest `calls`. Keep `'tool:list'` (it's still registered by `@ax/tool-dispatcher`). |
| `packages/ipc-http/src/plugin.ts:42-48` | Drop `'llm:call'` from manifest `calls`. |
| `packages/ipc-core/src/handlers/llm-call.ts` (whole) | Delete the handler — only invoked by the native runner. |
| `packages/ipc-core/src/listener.ts` (search "llm-call" / "llm.call") | Drop the registration of the deleted handler. |
| `packages/ipc-core/src/__tests__/handlers/llm-call.test.ts` (or wherever it lives) | Delete. |
| `packages/chat-orchestrator/src/orchestrator.ts:635-645` | Tighten gating: replace soft `proxyLoaded` skip with explicit termination when `proxy:open-session` isn't registered. New outcome reason: `'proxy-not-loaded'` (distinct from existing `'proxy-hooks-misconfigured'` — see invariant I7). Defends I7 (close-session lifecycle untouched — `proxyOpened` is still false on this path; nothing to close). |
| `packages/chat-orchestrator/src/__tests__/orchestrator.test.ts:1030-1050ish` | The "skips the proxy lifecycle when proxy:open-session is not registered" test inverts: now expects `'proxy-not-loaded'` outcome and a single `chat:end` fire. Add positive coverage for the new path. |
| `tsconfig.json` (root) | Drop the 8 deleted-package refs. |
| `pnpm-lock.yaml` | Regenerated by `pnpm install` after `package.json` edits. Don't hand-edit. |
| `README.md:13, 14, 16, 17, 18, 25, 146-151` | Update plugin lists — drop deleted packages from the prose and tree. |
| `deploy/MANUAL-ACCEPTANCE.md:25` | Drop the `@ax/agent-native-runner` line from the runner-binary list. |

**Reference patterns in the codebase to mirror:**

- Hard-cut deletion precedent: Phase 5 (PR #23) deleted the runner-side legacy fallback. Same shape: re-grep before each task; commit-pair pattern allowed where one commit removes a definition and the next removes its callers.
- Half-wired-window-CLOSED note pattern: Phase 5 PR notes (`docs/plans/2026-04-29-phase-5-pr-notes.md`). Phase 6 closes two windows; PR notes spell out which.

**Pre-execution greps the executor MUST re-run before Task 1:**

```bash
# Confirm the 8 deletion targets still have the consumer footprint this plan
# describes. Memory `feedback_check_plan_vs_reality.md`: flag deviations.
for pkg in llm-proxy-anthropic-format llm-anthropic agent-native-runner llm-mock \
           tool-bash tool-bash-impl tool-file-io tool-file-io-impl; do
  echo "===== @ax/$pkg ====="
  rg -n "from ['\"]@ax/$pkg" --no-heading -g '!node_modules' -g '!dist'
done

# Confirm @ax/tool-dispatcher still has live consumers (= still in scope to keep).
rg -n "from ['\"]@ax/tool-dispatcher" --no-heading -g '!node_modules' -g '!dist'

# Confirm @ax/agent-runner-core still has live consumers in retained packages.
rg -n "from ['\"]@ax/agent-runner-core" --no-heading -g '!node_modules' -g '!dist'

# Phase 5/6 self-marker grep — should be ZERO hits in production code after
# Phase 5. If any hit shows up, Phase 5 missed something; reconcile.
rg -n 'Phase 5/6 deletes|Phase 6 deletes' --no-heading -g '!node_modules' -g '!dist' -g '!docs/plans/'
```

If any deviation surfaces, STOP and reconcile in the reality-check section before continuing. Memory `feedback_check_plan_vs_reality.md`.

---

## Invariants (verified per task)

Phase 5's I1–I14 are carried forward where they still apply. Phase 6 adds I15–I18.

- **I1 — `chat:end` fires exactly once per `agent:invoke` (SDK-runner path).** [Phase 4 + Phase 5 carry-over.] The orchestrator's `proxyOpened` flag + `chat:end` fire on the new `'proxy-not-loaded'` exit path is the new code site to defend. *Prevents:* a tightened gate that exits without firing chat:end and silently skips audit-log.
- **I2 — `chat:turn-end` + `proxy:rotate-session` seam intact for OAuth sessions.** [Phase 3 + Phase 5 carry-over.] Phase 6 doesn't touch the rotation code. Tests must still pass.
- **I3 — `agents:resolve` ACL gate fires on every `agent:invoke`.** [Week 9.5 + Phase 5 carry-over.] Phase 6 doesn't touch the gate.
- **I4 — J6 conversation routing intact when `@ax/conversations` is loaded.** [Week 10-12 + Phase 5 carry-over.]
- **I5 — Hard cut on legacy plugins.** [Phase 4 + Phase 5 discipline.] No deprecation aliases, no compatibility shims, no "we'll keep one for one more release." After Phase 6, `@ax/llm-anthropic` etc. are not on disk and not in any package.json.
- **I6 — Runner self-sufficiency holds.** [Phase 5 audit.] No new host-side mediation; the SDK runner continues to own its turn loop and reach `api.anthropic.com` via the credential-proxy.
- **I7 — `proxy:close-session` fires once per `proxy:open-session`.** [Phase 2 + Phase 5 carry-over.] Phase 6's new `'proxy-not-loaded'` exit happens BEFORE `proxyOpened = true` ever sets, so there's nothing to close. The `proxy-hooks-misconfigured` skew check stays. *Prevents:* a tightening that opens but never closes (or vice versa).
- **I9 — `pnpm build` + `pnpm test` clean across all packages at the end of every commit on the branch (or every commit pair).** [Phase 4 + Phase 5 carry-over.] Phase 6 commits are bisect-friendly: each package deletion lands as a commit pair (delete dependents in commit A, delete the package itself in commit B). See bisect note in Estimated landing.
- **I10 — No new half-wired plugins, hooks, or bus surfaces.** [Phase 5 carry-over.] Phase 6 is pure deletion + gating tightening. *Prevents:* feature creep.
- **I11 — Audit-log subscription unchanged in PR-A.** Phase 7 owns the chat:end → event.http-egress switch. Phase 6 must NOT touch `@ax/audit-log` source.
- **I12 — `AgentInvokeInput` shape unchanged.** [Phase 4 carry-over.]
- **I13 — `'chat-run-timeout'` / `'chat-run-error'` / `'chat_run_dispatch_failed'` reason+log strings preserved.** [Phase 4 carry-over.] The new `'proxy-not-loaded'` reason is additive — existing strings stay.
- **I14 — `ChatTimeoutError` class stays.** [Phase 4 carry-over.]
- **I15 (new) — No retained package imports any deletion target after Phase 6.** Verified by the post-deletion grep gate (Task 11) — `rg "from ['\"]@ax/(llm-proxy-anthropic-format|llm-anthropic|agent-native-runner|llm-mock|tool-bash|tool-bash-impl|tool-file-io|tool-file-io-impl)"` returns zero hits. *Prevents:* a stranded `import` that compiles only because tsc is forgiving about missing-package shapes (it isn't, actually, but the gate is cheap).
- **I16 (new) — `@ax/tool-dispatcher` continues to register `tool:register` and `tool:list` after Phase 6.** Verified by `@ax/mcp-client` plugin tests + `@ax/test-harness` test-host-tool tests still passing. *Prevents:* an over-eager deletion sweep that takes the catalog plugin down before its successor exists.
- **I17 (new) — Workspace `pnpm install` produces a deterministic lockfile after package.json edits.** No `pnpm install --no-frozen-lockfile` workarounds. *Prevents:* lockfile drift that surfaces only on next CI run.
- **I18 (new) — Tightened orchestrator gating preserves the existing skew-misconfig path.** The `proxyOpenLoaded !== proxyCloseLoaded` skew check must still fire `'proxy-hooks-misconfigured'` (existing test). The new "neither registered" path fires `'proxy-not-loaded'`. Two distinct outcomes. *Prevents:* collapsing the two paths into one and losing the diagnostic distinction (skew = preset bug; neither = no proxy plugin loaded at all).

---

## Open questions resolved before execution

1. **Does Phase 6 land as one PR or split?** **Split into two PRs.**
   - **PR-A — "Phase 6: delete legacy plugins":** the 8-package deletion + cli/preset/manifest cleanup + orchestrator gating tightening + obsolete-test deletion. Self-contained, large but homogeneous (most diff is `git rm`). Bisect-friendly via commit pairs.
   - **PR-B — "Phase 6.6: rewrite claude-sdk-runner e2e + preset acceptance tests":** the actual coverage-restoring slice. Stub Anthropic backend, MCP stdio coverage absorbed from the deleted `mcp-client.e2e.test.ts`, k8s preset acceptance rebuild without `llm-mock`. Lives separately because (a) the test rewrites are non-trivial design work that benefits from being its own diff, and (b) PR-A doesn't block on it — the SDK runner still has unit-level coverage in `@ax/agent-claude-sdk-runner/__tests__/main.test.ts` and the orchestrator + audit-log have their own tests. Memory `feedback_minor_issues_non_blocking.md`: ship PR-A when the deletion is clean, don't gate on the e2e rewrite.
2. **Does Phase 6 delete `@ax/tool-dispatcher`?** **No.** Reality-check fail (above). The package stays. Section 6 of the design is wrong on this row at HEAD; the eventual PR notes update that record.
3. **Does Phase 6 delete `@ax/agent-runner-core`?** **No.** Phase 5's deferred decision still holds. `@ax/agent-claude-sdk-runner` still imports from it.
4. **Stub-Anthropic-backend strategy for the rewritten e2e (PR-B).** Defer the strategy decision to PR-B's planning phase. PR-A only needs the test skipped (already is) — the rewrite owns the strategy choice.
5. **Should `cfg.llm` and `cfg.runner` config dimensions stay or go?** **Drop both fields entirely.**
   - `cfg.runner`: only had two values (`'native'`, `'claude-sdk'`). Native is gone. The schema field, `resolveRunnerBinary` switch, and `cli/main.ts` argument all collapse. The runner binary becomes inline: `requireFromCli.resolve('@ax/agent-claude-sdk-runner')`.
   - `cfg.llm`: gated `cfg.llm === 'anthropic'` for `createCredentialProxyPlugin` push and the LLM plugin selection. After Phase 6: the SDK runner ALWAYS uses the credential-proxy. The plugin push moves outside the gate; the gate retires; the schema field retires.
   - The `cfg.tools` field similarly retires — `'bash'` and `'file-io'` are the only two values, and both plugins delete in this PR. The SDK runner's built-in Bash/Read/Write run inside the sandboxed `claude` grandchild and are not host-side concerns.
   - The `cfg.anthropic` field similarly retires (only consumer was `createLlmAnthropicPlugin`).
   - Final schema: `sandbox` (single value `'subprocess'`) and `storage` (single value `'sqlite'`) remain. Plan author note: Phase 7 may collapse those too — defer.
6. **Does deleting `@ax/llm-mock` break any retained test?** **Yes — three.** `presets/k8s/src/__tests__/acceptance.test.ts`, `presets/k8s/src/__tests__/multi-tenant-acceptance.test.ts`, `packages/cli/src/__tests__/mcp-client.e2e.test.ts`. PR-A deletes all three; PR-B rewrites `mcp-client.e2e.test.ts` and the preset acceptance tests against the credential-proxy + stub-Anthropic-backend topology.
7. **Does deleting `cfg.runner` break the `credential-proxy.e2e.test.ts` config?** Today it sets `runner: 'claude-sdk'` explicitly — drop the field from configOverride; behavior unchanged.
8. **CI gating for Linux runner.** Phase 5 noted `claude-sdk-runner.e2e.test.ts` is darwin-only because the SDK's libc detection picks the wrong claude binary on Linux. PR-A doesn't change that — the test stays skipped. PR-B's rewrite uses a stub Anthropic backend that doesn't depend on the real claude binary, so PR-B can drop the platform gate. **Out of scope for PR-A.**
9. **Does the orchestrator gating change need its own commit, or fold into a package-deletion commit?** **Own commit.** It's a behavior change (new outcome reason `'proxy-not-loaded'`) with its own test update. Folding it into a deletion commit muddles bisect.
10. **Lockfile commit.** `pnpm-lock.yaml` regenerates after every `package.json` edit. Plan picks: regenerate ONCE at the end (after all `package.json` edits land) and commit the result as part of the final task. Mid-task lockfile commits churn the diff.
11. **Does Phase 6 update the design doc's Section 6 deletes table?** **No — leave the design doc untouched.** Document the deviation in the PR notes file (gitignored, lives at `docs/plans/2026-XX-XX-phase-6-pr-notes.md` after merge). The design doc is a snapshot; the PR notes are the authoritative running record.

---

## Tasks

### Task 1: Pre-execution survey + baseline confirmation

**Goal:** Verify the deletion inventory is still accurate at HEAD and that the workspace is green before any change. Memory `feedback_check_plan_vs_reality.md`.

**Files:** Read-only.

**Step 1.1: Re-run consumer greps**

```bash
for pkg in llm-proxy-anthropic-format llm-anthropic agent-native-runner llm-mock \
           tool-bash tool-bash-impl tool-file-io tool-file-io-impl; do
  echo "===== @ax/$pkg ====="
  rg -n "from ['\"]@ax/$pkg" --no-heading -g '!node_modules' -g '!dist'
done
```

Expected hit profile (compare to Reference material above):

- `llm-proxy-anthropic-format`: 2 hits (cli/main.ts:22, presets/k8s/index.ts:11).
- `llm-anthropic`: 2 hits (cli/main.ts:12, presets/k8s/index.ts:10) + e2e-real-llm test seam reads `anthropicClientFactory` (no `from` import — the seam plumbs through `MainOptions`).
- `agent-native-runner`: 0 hits.
- `llm-mock`: 3 hits (cli/main.ts:11, presets/k8s acceptance + multi-tenant-acceptance tests).
- `tool-bash`: 2-3 hits (cli/main.ts:25, presets/k8s/index.ts:14, possibly e2e-real-llm).
- `tool-bash-impl`: 1 hit (agent-native-runner/main.ts:14).
- `tool-file-io`: 2 hits (cli/main.ts:26, presets/k8s/index.ts:15).
- `tool-file-io-impl`: 1 hit (agent-native-runner/main.ts:15) + 2 comment refs in agent-claude-sdk-runner/workspace-diff.ts.

If counts differ, STOP and reconcile.

**Step 1.2: Re-confirm `@ax/tool-dispatcher` is still in scope to keep**

```bash
rg -n "from ['\"]@ax/tool-dispatcher" --no-heading -g '!node_modules' -g '!dist'
```

Expected: hits in `mcp-client/src/plugin.ts`, `mcp-client/src/__tests__/`, `test-harness/src/__tests__/test-host-tool.test.ts`, `tool-bash/src/__tests__/bash.test.ts` (deletes with package), `tool-file-io/src/__tests__/file-io.test.ts` (deletes with package), `cli/main.ts:24`, `presets/k8s/src/index.ts:13`.

If `mcp-client` no longer calls `tool:register` (i.e., a parallel slice has moved the catalog elsewhere), reconcile. Otherwise the keep-decision stands.

**Step 1.3: Re-confirm `@ax/agent-runner-core` is still in scope to keep**

```bash
rg -n "from ['\"]@ax/agent-runner-core" --no-heading -g '!node_modules' -g '!dist'
```

Expected: hits in `agent-claude-sdk-runner/src/{main,pre-tool-use,post-tool-use,host-mcp-server,can-use-tool,workspace-diff}.ts` plus the runner's tests, plus `tool-bash-impl` and `tool-file-io-impl` (both deleting).

**Step 1.4: Phase 5/6 marker grep**

```bash
rg -n 'Phase 5/6 deletes|Phase 6 deletes' --no-heading -g '!node_modules' -g '!dist' -g '!docs/plans/'
```

Expected: zero hits. Phase 5 retired the forward-references. If any hit remains, Phase 5 missed it — reconcile.

**Step 1.5: Baseline build + test**

```bash
pnpm build
pnpm test
```

Expected: clean build; ~1547+ tests passing across the workspace (Phase 5's stat). Captures the pre-Phase-6 baseline. If anything is red at baseline, STOP and fix before Phase 6 — don't conflate Phase 5 / pre-existing breakage with Phase 6's diff.

**Step 1.6: No commit** — read-only verification.

---

### Task 2: Delete `@ax/llm-proxy-anthropic-format`

**Goal:** Remove the in-sandbox HTTP-to-IPC translator package and all consumer wiring. After this commit pair, `pnpm build` is clean and the package is not on disk.

**Files:**
- Modify: `packages/cli/src/main.ts:22, 204` (drop the import + the `plugins.push(createLlmProxyAnthropicFormatPlugin())` call)
- Modify: `presets/k8s/src/index.ts:11, 512` (same)
- Modify: `packages/cli/package.json:36` (drop dependency)
- Modify: `presets/k8s/package.json:21` (drop dependency)
- Modify: `packages/sandbox-subprocess/package.json:26` (drop devDep)
- Modify: `packages/cli/tsconfig.json` (drop ref)
- Modify: `presets/k8s/tsconfig.json` (drop ref)
- Modify: `tsconfig.json` (root — drop ref)
- Delete: `packages/llm-proxy-anthropic-format/` (whole directory)

**Step 2.1: Drop consumer imports + plugin pushes (commit A)**

In `packages/cli/src/main.ts`: delete line 22 (`import { createLlmProxyAnthropicFormatPlugin } from ...`) and line 204 (`plugins.push(createLlmProxyAnthropicFormatPlugin());`). Update the surrounding comment block (lines 198-204) — the "Session + IPC + chat orchestration" block currently mentions `createLlmProxyAnthropicFormatPlugin` between `IpcServer` and `ChatOrchestrator`. After deletion, the comment doesn't need to mention it.

In `presets/k8s/src/index.ts`: delete line 11 (import) and line 512 (`plugins.push(createLlmProxyAnthropicFormatPlugin());`). Update the section banner around line 58 ("6. sandbox / ipc-http / llm-proxy / chat-orchestrator (chat plane)") to "6. sandbox / ipc-http / chat-orchestrator (chat plane)".

Run:

```bash
pnpm build
pnpm test --filter @ax/cli --filter @ax/preset-k8s
```

Expected: clean — the package is still on disk, just not loaded.

```bash
git add packages/cli/src/main.ts presets/k8s/src/index.ts
git commit -m "refactor(cli,preset-k8s): drop @ax/llm-proxy-anthropic-format plugin loads [Phase 6]"
```

**Step 2.2: Drop package.json + tsconfig refs + delete the package (commit B)**

Edit `packages/cli/package.json`, `presets/k8s/package.json`, `packages/sandbox-subprocess/package.json` — drop the `@ax/llm-proxy-anthropic-format: workspace:*` lines.

Edit `packages/cli/tsconfig.json`, `presets/k8s/tsconfig.json`, `tsconfig.json` — drop the `{ "path": ".../llm-proxy-anthropic-format" }` references.

Delete the package directory:

```bash
rm -rf packages/llm-proxy-anthropic-format
```

Regenerate the lockfile last:

```bash
pnpm install
pnpm build
pnpm test
```

Expected: clean across all packages (Phase 5 already proved no production code depends on the package's hooks; this commit is the package.json residue + tsconfig refs).

```bash
git add packages/cli/package.json packages/cli/tsconfig.json \
        presets/k8s/package.json presets/k8s/tsconfig.json \
        packages/sandbox-subprocess/package.json \
        tsconfig.json pnpm-lock.yaml
git rm -r packages/llm-proxy-anthropic-format
git commit -m "refactor: delete @ax/llm-proxy-anthropic-format package [Phase 6]"
```

**Step 2.3: Verify**

```bash
rg -n "@ax/llm-proxy-anthropic-format" --no-heading -g '!node_modules' -g '!dist' -g '!pnpm-lock.yaml'
```

Expected: zero hits (or only in `docs/plans/` historical notes).

---

### Task 3: Delete `@ax/agent-native-runner` (and its `tool-bash-impl` / `tool-file-io-impl` companions)

**Goal:** Remove the pre-SDK runner and the two impl packages whose only consumer was the native runner. After this commit pair, `cfg.runner` has no second value to pick, so the schema field also collapses (Task 4).

**Why bundled:** `tool-bash-impl` and `tool-file-io-impl` have exactly one importer each (`agent-native-runner/src/main.ts:14, 15`). Deleting the runner without the impls would leave them as orphaned packages with zero consumers — a half-wired surface. Memory `feedback_half_wired_window_pattern.md`: close the window in the same PR.

**Files:**
- Modify: `packages/cli/src/main.ts:51-64` (collapse `resolveRunnerBinary` to inline a single resolve, or delete the function and inline its only call)
- Modify: `packages/cli/src/main.ts:40-50` (rewrite the comment block — the lazy-resolve rationale stays for the SDK runner's binary)
- Modify: `packages/cli/package.json:38` (drop `@ax/agent-native-runner` dep)
- Modify: `packages/cli/tsconfig.json` (drop ref)
- Modify: `tsconfig.json` (root — drop ref)
- Modify: `packages/agent-claude-sdk-runner/src/workspace-diff.ts:34, 55` (edit the two comment refs to `tool-file-io-impl`)
- Delete: `packages/agent-native-runner/` (whole tree)
- Delete: `packages/tool-bash-impl/` (whole tree)
- Delete: `packages/tool-file-io-impl/` (whole tree)
- Modify: `deploy/MANUAL-ACCEPTANCE.md:25` (drop the agent-native-runner line)

**Step 3.1: Inline the SDK runner binary resolution (commit A)**

In `packages/cli/src/main.ts`, the current `resolveRunnerBinary(cfg.runner)` switch has two cases. Native goes; only `'claude-sdk'` remains. Two valid options:

(a) **Keep the function** — narrow it to a single arm and call it `resolveSdkRunnerBinary()` with no parameter. Test in `main.test.ts` simplifies to one assertion.

(b) **Inline the resolve at line 207** — `runnerBinary: requireFromCli.resolve('@ax/agent-claude-sdk-runner')`. Drop the function. Drop the test file.

Plan picks (b) — no consumer of the abstraction remains. Saves one function and one test file. The lazy-resolve comment block at lines 40-50 keeps its content (still applies to the SDK runner's binary; the rationale is library-mode safety + pnpm hoisting robustness) but is rewritten to not mention "agent-native-runner."

Run:

```bash
pnpm --filter @ax/cli build
pnpm --filter @ax/cli test
```

Expected: `main.test.ts` failures (the file asserts the deleted function). Delete the test file in this same commit.

```bash
git rm packages/cli/src/__tests__/main.test.ts
git add packages/cli/src/main.ts
git commit -m "refactor(cli): inline @ax/agent-claude-sdk-runner binary resolution [Phase 6]"
```

**Step 3.2: Drop `@ax/agent-native-runner` package + tool-bash-impl + tool-file-io-impl (commit B)**

Edit `packages/cli/package.json` — drop `@ax/agent-native-runner` from dependencies.

Edit `packages/cli/tsconfig.json` — drop the ref.

Edit `tsconfig.json` (root) — drop refs for `agent-native-runner`, `tool-bash-impl`, `tool-file-io-impl`.

Edit `packages/agent-claude-sdk-runner/src/workspace-diff.ts` — line 34 currently reads `* 1 MiB ceiling matches @ax/tool-file-io-impl/exec.ts.MAX_FILE_BYTES.`; replace with `* 1 MiB ceiling — keep aligned with the host file-IO ceiling.` Line 55 similar — drop the cross-reference, state the constant inline.

Edit `deploy/MANUAL-ACCEPTANCE.md:25` — drop the agent-native-runner mapping line.

```bash
rm -rf packages/agent-native-runner packages/tool-bash-impl packages/tool-file-io-impl
pnpm install
pnpm build
pnpm test
```

Expected: clean. The SDK runner's `workspace-diff` tests still pass (constants are redeclared, not imported).

```bash
git add packages/cli/package.json packages/cli/tsconfig.json tsconfig.json \
        packages/agent-claude-sdk-runner/src/workspace-diff.ts \
        deploy/MANUAL-ACCEPTANCE.md pnpm-lock.yaml
git rm -r packages/agent-native-runner packages/tool-bash-impl packages/tool-file-io-impl
git commit -m "refactor: delete @ax/agent-native-runner + tool-{bash,file-io}-impl [Phase 6]"
```

**Step 3.3: Verify**

```bash
rg -n "@ax/(agent-native-runner|tool-bash-impl|tool-file-io-impl)" \
   --no-heading -g '!node_modules' -g '!dist' -g '!pnpm-lock.yaml' -g '!docs/plans/'
```

Expected: zero hits.

---

### Task 4: Drop `cfg.runner`, `cfg.tools`, and `cfg.anthropic` from the CLI config schema

**Goal:** With the native runner gone (Task 3) and the host-side bash/file-io descriptors about to go (Task 5/6), the `cfg.runner` and `cfg.tools` fields have no remaining consumer. `cfg.anthropic` also retires — only `createLlmAnthropicPlugin` read it. `cfg.llm` retires after Task 5. This task takes the runner+tools+anthropic side; Task 5 takes the llm side.

**Files:**
- Modify: `packages/cli/src/config/schema.ts` (drop `runner`, `tools`, `anthropic` fields)
- Modify: `packages/cli/src/main.ts:227-232` (drop the `if (cfg.tools.includes('bash')) push(...)` and equivalent for file-io)
- Modify: `packages/cli/src/__tests__/credential-proxy.e2e.test.ts:153, 154` (drop `runner: 'claude-sdk'` + `tools: []`)
- Modify: `packages/cli/src/__tests__/credentials-wiring.test.ts` (search `runner:` / `tools:`)
- Modify: any other CLI test that sets `runner:` or `tools:` in `configOverride`
- Modify: `ax.config.ts` is local/untracked — leave alone

**Step 4.1: Drop schema fields**

Open `packages/cli/src/config/schema.ts`. Current shape (lines 14-31):

```ts
export const AxConfigSchema = z
  .object({
    llm: z.enum(['anthropic', 'mock']).default('mock'),
    sandbox: z.enum(['subprocess']).default('subprocess'),
    tools: z.array(z.enum(['bash', 'file-io'])).default(['bash', 'file-io']),
    storage: z.enum(['sqlite']).default('sqlite'),
    runner: z.enum(['native', 'claude-sdk']).default('native'),
    anthropic: z.object({...}).optional(),
  })
  .strict();
```

Plan author: drop `runner`, `tools`, `anthropic` fields entirely. Leave `llm` for Task 5. The `.strict()` posture means dropping the fields makes any config file that sets them fail schema validation — which is the intended hard cut. Memory `feedback_half_wired_window_pattern.md`: don't leave a deprecated field accepted-but-ignored.

**Step 4.2: Drop the consumer code blocks in `main.ts`**

In `packages/cli/src/main.ts`:

- Lines 222-232: the "Tool dispatcher is the single entry point…" block. Keep `plugins.push(createToolDispatcherPlugin())` (Task 0 — tool-dispatcher stays). Drop the `if (cfg.tools.includes('bash')) plugins.push(createToolBashPlugin())` and `if (cfg.tools.includes('file-io')) plugins.push(createToolFileIoPlugin())` lines. Update the comment to reflect that the dispatcher's tools come from MCP-registered host tools only.
- Lines 250-271: The `if (cfg.llm === 'anthropic') { plugins.push(createLlmAnthropicPlugin(...)) } else { plugins.push(llmMockPlugin()) }` block. **Defer this edit to Task 5** — Task 4 leaves it untouched (Task 5 deletes it as part of llm-anthropic + llm-mock removal).
- Lines 207-208: the `runnerBinary: resolveRunnerBinary(cfg.runner)` becomes `runnerBinary: requireFromCli.resolve('@ax/agent-claude-sdk-runner')` (already inlined in Task 3 if (b) was picked).

**Step 4.3: Update test fixtures**

Search for remaining `runner:` / `tools:` references in CLI tests:

```bash
rg -n "runner: '|tools: \[" packages/cli/src/__tests__/ --no-heading
```

Drop those keys from each `configOverride` block. The strict schema would reject them, so retaining them turns the tests red.

**Step 4.4: Run + commit**

```bash
pnpm --filter @ax/cli build
pnpm --filter @ax/cli test
```

Expected: clean.

```bash
git add packages/cli/src/config/schema.ts packages/cli/src/main.ts \
        packages/cli/src/__tests__/
git commit -m "refactor(cli): drop runner/tools/anthropic config fields (no consumers) [Phase 6]"
```

---

### Task 5: Delete `@ax/llm-anthropic` + `@ax/llm-mock` and the `cfg.llm` switch

**Goal:** Remove the host-side LLM plugins. With them gone, `cfg.llm` has no consumer — drop it. The credential-proxy push moves outside the gate (always loaded unless `skipCredentialProxy`).

**Files:**
- Modify: `packages/cli/src/main.ts:11-12, 181-187, 250-271` (drop both imports; ungate the credential-proxy; drop the LLM plugin push block)
- Modify: `packages/cli/src/config/schema.ts` (drop `llm` field)
- Modify: `packages/cli/package.json` (drop both deps)
- Modify: `packages/cli/tsconfig.json` (drop both refs)
- Modify: `presets/k8s/src/index.ts:10, 198-204, 546-555` (drop `createLlmAnthropicPlugin` import + push; drop `anthropic` config field; drop AX_LLM_MODEL/AX_LLM_MAX_TOKENS env reads at lines 705-715)
- Modify: `presets/k8s/package.json` (drop `@ax/llm-anthropic` dep + `@ax/llm-mock` devDep)
- Modify: `presets/k8s/tsconfig.json` (drop refs)
- Modify: `presets/k8s/src/__tests__/preset.test.ts` (drop any `llmMockPlugin` / anthropic-config assertions)
- Modify: `tsconfig.json` (root)
- Delete: `packages/llm-anthropic/` (whole tree)
- Delete: `packages/llm-mock/` (whole tree)
- Delete: `packages/cli/src/__tests__/e2e-real-llm.test.ts` (whole — uses both)
- Delete: `presets/k8s/src/__tests__/acceptance.test.ts` (whole — uses llm-mock; PR-B rebuilds)
- Delete: `presets/k8s/src/__tests__/multi-tenant-acceptance.test.ts` (whole — uses llm-mock; PR-B rebuilds)
- Delete: `packages/cli/src/__tests__/mcp-client.e2e.test.ts` (whole — uses llm-mock + native runner; PR-B absorbs into rewritten claude-sdk e2e)

**Step 5.1: Drop CLI consumer code (commit A)**

In `packages/cli/src/main.ts`:
- Delete lines 11, 12 (imports of `llmMockPlugin`, `createLlmAnthropicPlugin`).
- Lines 181-187: change `if (cfg.llm === 'anthropic' && opts.skipCredentialProxy !== true) {` to `if (opts.skipCredentialProxy !== true) {`. Update the surrounding comment block (lines 170-181) — drop the "mock-LLM mode never reaches the wire" branch description; the SDK runner is the only path now.
- Lines 250-271: delete the entire `if (opts.skipDefaultLlm !== true) { ... }` block. The SDK runner doesn't use `llm:call`. The `MainOptions.skipDefaultLlm` and `MainOptions.anthropicClientFactory` fields lose their callers — drop them too. (The `extraPlugins` seam survives.)

In `packages/cli/src/config/schema.ts`: drop the `llm: z.enum(['anthropic', 'mock']).default('mock'),` field.

In `packages/cli/package.json`: drop `@ax/llm-mock` + `@ax/llm-anthropic` deps.

In `packages/cli/tsconfig.json`: drop the two refs.

Delete the obsolete CLI tests:

```bash
git rm packages/cli/src/__tests__/e2e-real-llm.test.ts \
       packages/cli/src/__tests__/mcp-client.e2e.test.ts
```

Run:

```bash
pnpm --filter @ax/cli build
pnpm --filter @ax/cli test
```

Expected: clean. The remaining CLI tests (e2e.test.ts, credentials-cli.test.ts, credential-proxy.e2e.test.ts, etc.) don't touch these packages. If a remaining test is red, it relied on a dropped seam — revert and reconcile.

**Step 5.2: Drop preset consumer code (commit B)**

In `presets/k8s/src/index.ts`:
- Delete line 10 (import of `createLlmAnthropicPlugin`).
- Delete the `anthropic` field from `K8sPresetConfig` (lines 198-204).
- Delete the section-9 LLM block (lines 546-555).
- Delete the AX_LLM_MODEL/AX_LLM_MAX_TOKENS env reads (lines 705-715 in `loadK8sConfigFromEnv`).
- Update the section-banner comment (lines 50-62) — drop "9. llm-anthropic (last; everything else is in place when init runs)".

In `presets/k8s/package.json`: drop `@ax/llm-anthropic` (dependencies) + `@ax/llm-mock` (devDependencies).

In `presets/k8s/tsconfig.json`: drop both refs.

Delete the obsolete preset tests:

```bash
git rm presets/k8s/src/__tests__/acceptance.test.ts \
       presets/k8s/src/__tests__/multi-tenant-acceptance.test.ts
```

Update `presets/k8s/src/__tests__/preset.test.ts` — search for any `llmMockPlugin` / `createLlmAnthropicPlugin` / `anthropic:` references and drop them.

```bash
pnpm --filter @ax/preset-k8s build
pnpm --filter @ax/preset-k8s test
```

Expected: clean.

**Step 5.3: Delete the packages + lockfile (commit C)**

```bash
rm -rf packages/llm-anthropic packages/llm-mock
```

Drop refs from `tsconfig.json` (root).

```bash
pnpm install
pnpm build
pnpm test
```

Expected: clean across all packages.

```bash
git add packages/cli/src/main.ts packages/cli/src/config/schema.ts \
        packages/cli/package.json packages/cli/tsconfig.json \
        presets/k8s/src/index.ts presets/k8s/package.json \
        presets/k8s/tsconfig.json presets/k8s/src/__tests__/preset.test.ts \
        tsconfig.json pnpm-lock.yaml
git rm -r packages/llm-anthropic packages/llm-mock
git commit -m "refactor: delete @ax/llm-anthropic + @ax/llm-mock + cfg.llm switch [Phase 6]"
```

**Step 5.4: Verify**

```bash
rg -n "@ax/(llm-anthropic|llm-mock)" --no-heading -g '!node_modules' -g '!dist' -g '!pnpm-lock.yaml' -g '!docs/plans/'
rg -n "cfg\\.llm|llmMockPlugin|createLlmAnthropicPlugin" --no-heading -g '!node_modules' -g '!dist' -g '!docs/plans/'
```

Expected: zero hits.

---

### Task 6: Delete `@ax/tool-bash` + `@ax/tool-file-io`

**Goal:** Remove the host-side tool descriptor packages. Their `tool:execute:bash` / `tool:execute:read_file` / `tool:execute:write_file` registrations were the only host-side bash/file-io tool execution path — now obsolete because the SDK runner's built-in Bash/Read/Write run inside the sandboxed `claude` grandchild.

Note: This depends on Task 4 (cfg.tools removed) and Task 5 (e2e-real-llm.test.ts deleted). Order Tasks 4 → 5 → 6.

**Files:**
- Modify: `packages/cli/src/main.ts:25, 26, 227-232` (already half-done in Task 4; finalize)
- Modify: `presets/k8s/src/index.ts:14, 15, 532-535` (drop imports + plugin pushes; tool-dispatcher push stays)
- Modify: `packages/cli/package.json` (drop both deps)
- Modify: `packages/cli/tsconfig.json` (drop both refs)
- Modify: `presets/k8s/package.json` (drop both deps)
- Modify: `presets/k8s/tsconfig.json` (drop both refs)
- Modify: `tsconfig.json` (root)
- Delete: `packages/tool-bash/` (whole tree)
- Delete: `packages/tool-file-io/` (whole tree)
- Modify: `README.md:17, 18, 150, 151` (drop from the prose plugin list and the directory tree)

**Step 6.1: Drop consumer pushes + imports (commit A)**

In `packages/cli/src/main.ts`: delete lines 25, 26 (imports). Confirm Task 4's edit also removed the `if (cfg.tools.includes(...))` branches; the comment block (lines 222-225) tightens to "Tool dispatcher is the registrar for `tool:register`/`tool:list`. Tools come from `@ax/mcp-client` (registered MCP tools). The bash/file-io built-ins live in-sandbox per the SDK runner."

In `presets/k8s/src/index.ts`: delete lines 14, 15 (imports). Lines 532-535: the section-7 "tool catalog" block — drop the `createToolBashPlugin()` and `createToolFileIoPlugin()` pushes. Keep `createToolDispatcherPlugin()` (Phase 6 keeps it). Update the comment to match.

```bash
pnpm build
pnpm test
```

Expected: clean.

```bash
git add packages/cli/src/main.ts presets/k8s/src/index.ts
git commit -m "refactor(cli,preset-k8s): drop @ax/tool-bash + @ax/tool-file-io plugin loads [Phase 6]"
```

**Step 6.2: Delete packages + lockfile (commit B)**

Drop deps from `packages/cli/package.json`, `presets/k8s/package.json`. Drop refs from `packages/cli/tsconfig.json`, `presets/k8s/tsconfig.json`, `tsconfig.json`.

```bash
rm -rf packages/tool-bash packages/tool-file-io
pnpm install
pnpm build
pnpm test
```

Update `README.md` lines 17, 18 (prose plugin list) and 150, 151 (directory tree) — drop the entries.

```bash
git add packages/cli/package.json packages/cli/tsconfig.json \
        presets/k8s/package.json presets/k8s/tsconfig.json \
        tsconfig.json pnpm-lock.yaml README.md
git rm -r packages/tool-bash packages/tool-file-io
git commit -m "refactor: delete @ax/tool-bash + @ax/tool-file-io packages [Phase 6]"
```

**Step 6.3: Verify**

```bash
rg -n "@ax/(tool-bash|tool-file-io)(['\"]|/)" --no-heading -g '!node_modules' -g '!dist' -g '!pnpm-lock.yaml' -g '!docs/plans/'
```

Expected: zero hits (no slash → catches `tool-bash-impl`/`tool-file-io-impl` historical mentions in pnpm-lock.yaml only).

---

### Task 7: Drop `'llm:call'` from `@ax/ipc-server` and `@ax/ipc-http` manifests; delete the `llm-call` IPC handler

**Goal:** With the native runner gone (Task 3), no caller hits the `llm.call` IPC action. The handler in `@ax/ipc-core` is dead code; the manifest `calls` lines in `ipc-server` and `ipc-http` reference an unregistered service hook (would fail boot once `@ax/llm-anthropic` and `@ax/llm-mock` are gone — Task 5 already removed those, so this task removes the manifest entries that would have triggered the boot failure).

**Order note:** This task should land BEFORE Task 5 (or in the same commit) — otherwise between Task 5's commit and this task's commit, bootstrap fails with "no plugin registered for service hook 'llm:call'" because `ipc-server` declares it as a dependency. Adjust order: Run Task 7 right after Task 4 (cfg.runner gone) and before Task 5 (LLM plugins gone). Update the task list ordering in the executor's mind.

Wait — actually, `ipc-server`'s `calls: ['llm:call']` is enforced by core's `verifyCalls` startup check, which fails fast at bootstrap. If Task 5 lands first, the workspace becomes unbuildable for `pnpm test --filter @ax/cli` because every CLI test that bootstraps the full plugin set hits the verifyCalls failure. So Task 7 MUST land before Task 5.

**Revised plan ordering:** Tasks 1, 2, 3, 4, **7**, 5, 6, 8, 9, 10, 11. Task 7 squeezes in between Task 4 and Task 5.

**Files:**
- Modify: `packages/ipc-server/src/plugin.ts:77-82` (drop `'llm:call'` from `calls` array)
- Modify: `packages/ipc-http/src/plugin.ts:42-48` (drop `'llm:call'` from `calls` array)
- Delete: `packages/ipc-core/src/handlers/llm-call.ts`
- Modify: `packages/ipc-core/src/listener.ts` (or wherever the handler is registered — drop the import + registration)
- Modify: `packages/ipc-server/src/__tests__/listener.test.ts:269, 293` (the test stubs that register `'llm:call'` — those tests test the listener which currently dispatches that handler; drop the assertion or the whole test case if it ONLY exercised llm-call)
- Modify: `packages/ipc-http/src/__tests__/plugin.test.ts:29, 34, 88` (similar)
- Delete: `packages/ipc-core/src/handlers/__tests__/llm-call.test.ts` (or wherever it lives)

**Step 7.1: Drop `'llm:call'` from manifest calls**

In `packages/ipc-server/src/plugin.ts`: edit the `calls:` array around line 77-82 — drop `'llm:call'`. Keep `'session:resolve-token'`, `'session:claim-work'`, `'tool:list'`.

In `packages/ipc-http/src/plugin.ts:42-48`: same drop.

**Step 7.2: Delete the IPC handler + its test**

```bash
git rm packages/ipc-core/src/handlers/llm-call.ts
# Find and drop its registration in listener.ts:
rg -n "llm-call|LlmCall" packages/ipc-core/src/listener.ts
# Edit: remove the import + registerHandler call.
# Find and drop the test:
git rm packages/ipc-core/src/__tests__/handlers/llm-call.test.ts  # path may vary
```

**Step 7.3: Update listener tests**

In `packages/ipc-server/src/__tests__/listener.test.ts:269, 293`: each test that does `'llm:call': async () => ({...})` is exercising "the listener forwards llm.call IPC actions to bus.call('llm:call')" — the entire flow goes away. Either drop the case entirely (it's redundant once the action is unwired) or keep the case and assert the listener now rejects unknown action names. Plan author judgment: drop the cases — the listener's other actions cover the dispatch-mechanics contract.

In `packages/ipc-http/src/__tests__/plugin.test.ts:29, 34, 88`: same — drop the llm:call cases.

**Step 7.4: Run + commit**

```bash
pnpm build
pnpm test
```

Expected: clean.

```bash
git add packages/ipc-server packages/ipc-http packages/ipc-core
git commit -m "refactor(ipc): drop unused llm.call IPC action + handler [Phase 6]"
```

**Step 7.5: Verify**

```bash
rg -n "llm-call|llm\\.call|'llm:call'" packages/ipc-core packages/ipc-server packages/ipc-http --no-heading
```

Expected: zero hits in production code. Test assertions about "no plugin registered for service hook 'llm:call'" in `packages/core/src/__tests__/errors.test.ts` are testing core's error-formatting machinery against an arbitrary unregistered hook name — those tests don't depend on llm:call being a real hook anywhere. They stay.

---

### Task 8: Tighten chat-orchestrator gating — `'proxy-not-loaded'` outcome

**Goal:** With the credential-proxy now mandatory (post Task 5), the orchestrator's soft-skip "proxy hooks not registered → don't open a session, let the runner fail at boot" is a worse error path than a structured outcome at agent:invoke time. Replace the soft skip with a fail-loud `'proxy-not-loaded'` terminate.

I7 defense: the new exit path runs BEFORE `proxyOpened = true`. Nothing to close.

I18 defense: the existing `'proxy-hooks-misconfigured'` skew check (one of open/close registered, the other not) stays — it's a different diagnostic.

**Files:**
- Modify: `packages/chat-orchestrator/src/orchestrator.ts:635-716` (the proxy gating block; specifically, the `proxyLoaded` soft path)
- Modify: `packages/chat-orchestrator/src/__tests__/orchestrator.test.ts:1030-1050` (the existing "skips the proxy lifecycle" test inverts; add the new "terminates with proxy-not-loaded" positive test)

**Step 8.1: Write the failing test**

In `packages/chat-orchestrator/src/__tests__/orchestrator.test.ts`, find the existing "skips the proxy lifecycle when proxy:open-session is not registered" test around line 1030. Rewrite it:

```ts
it('terminates with proxy-not-loaded when neither proxy hook is registered', async () => {
  // Default mocks (no proxy hooks registered).
  const mocks = makeDefaultMocks();
  const { bus } = await bootstrap({ ... });

  const outcome = await bus.call<AgentInvokeInput, AgentOutcome>('agent:invoke', ctx, {
    message: { role: 'user', content: 'hi' },
  });
  expect(outcome.kind).toBe('terminated');
  expect((outcome as { reason: string }).reason).toBe('proxy-not-loaded');

  // I1: chat:end fires exactly once on this exit path.
  expect(mocks.chatEndFires).toBe(1);

  // I7: proxy:close-session was NOT called (proxyOpened never set).
  expect(mocks.proxyCloseCalls).toBe(0);

  // I18: distinct from the skew-misconfigured outcome.
  expect((outcome as { reason: string }).reason).not.toBe('proxy-hooks-misconfigured');
});
```

The exact mock-helper shape depends on what's in the test file — match the existing test patterns. Run:

```bash
pnpm --filter @ax/chat-orchestrator test
```

Expected: FAIL — the orchestrator currently soft-skips and the runner-side fails later (or in this test harness, the sandbox stub completes happily without proxy env).

**Step 8.2: Tighten the gating**

In `packages/chat-orchestrator/src/orchestrator.ts:635-648`, current shape:

```ts
const proxyOpenLoaded = bus.hasService('proxy:open-session');
const proxyCloseLoaded = bus.hasService('proxy:close-session');
if (proxyOpenLoaded !== proxyCloseLoaded) {
  // ... 'proxy-hooks-misconfigured' termination (stays)
}
const proxyLoaded = proxyOpenLoaded && proxyCloseLoaded;
let proxyConfig: ProxyConfig | undefined;
let proxyOpened = false;
if (proxyLoaded) {
  // open-session ... (stays)
}
```

Tighten to:

```ts
const proxyOpenLoaded = bus.hasService('proxy:open-session');
const proxyCloseLoaded = bus.hasService('proxy:close-session');
if (proxyOpenLoaded !== proxyCloseLoaded) {
  // ... 'proxy-hooks-misconfigured' termination (unchanged)
}
if (!proxyOpenLoaded) {
  // I18 — distinct from skew-misconfigured. Phase 6 made the credential-
  // proxy mandatory; running without it would force real credentials into
  // the sandbox env, breaking I1 (the same defense the open-session catch
  // block carries). Terminate at agent:invoke time with a clear outcome
  // instead of letting the runner fail at boot with MissingEnvError.
  const outcome: AgentOutcome = {
    kind: 'terminated',
    reason: 'proxy-not-loaded',
  };
  await bus.fire('chat:end', ctx, { outcome });
  return outcome;
}
let proxyConfig: ProxyConfig;  // no longer optional; proxyOpenLoaded is true.
let proxyOpened = false;
try {
  // ... open-session logic stays
}
```

The `proxyConfig: ProxyConfig | undefined` becomes `proxyConfig: ProxyConfig` (asserted assignment). The downstream `if (input.proxyConfig !== undefined)` checks in `sandbox-subprocess` are unaffected — sandbox-subprocess still accepts `proxyConfig` as optional in its schema (Phase 5 left that side alone), but the orchestrator now always passes a defined value.

**Step 8.3: Run + commit**

```bash
pnpm --filter @ax/chat-orchestrator test
pnpm test
```

Expected: clean across all packages. Existing rotation tests, the proxy-hooks-misconfigured test, and the new proxy-not-loaded test all pass.

```bash
git add packages/chat-orchestrator/src
git commit -m "feat(chat-orchestrator): terminate with proxy-not-loaded when credential-proxy missing [Phase 6]"
```

---

### Task 9: Update operator docs

**Goal:** Drop deletion-target mentions from operator-facing tracked docs (README + deploy/MANUAL-ACCEPTANCE.md). Already partially done in Task 3 (deploy/MANUAL-ACCEPTANCE) and Task 6 (README plugin lists). This task is a final sweep for anything missed.

**Files:**
- Modify: `README.md` (any remaining mentions of the 8 deleted packages)
- Modify: `deploy/MANUAL-ACCEPTANCE.md` (any remaining mentions)
- Modify: `presets/k8s/README.md` if present (check)
- Modify: `packages/agent-claude-sdk-runner/SECURITY.md` if it mentions any deleted package (the Phase 5 follow-up `3d5d5e1` already corrected the env-var name; check for plugin-name leftovers)

**Step 9.1: Final sweep**

```bash
rg -n "@ax/(llm-proxy-anthropic-format|llm-anthropic|agent-native-runner|llm-mock|tool-bash|tool-bash-impl|tool-file-io|tool-file-io-impl)" \
   --no-heading -g '!node_modules' -g '!dist' -g '!pnpm-lock.yaml' -g '!docs/plans/'
```

Expected: zero hits, OR only in comments / docs that update in this commit.

For each remaining hit, read the context and either delete the mention (if it's a "we ship X" plugin-list entry) or rewrite it (if it describes a flow that retired).

**Step 9.2: Run + commit**

```bash
pnpm build
pnpm test
```

Expected: clean.

```bash
git add README.md deploy/ presets/
git commit -m "docs: retire references to legacy plugins deleted in Phase 6 [Phase 6]"
```

---

### Task 10: Final verification + boundary review note

**Goal:** Confirm the full workspace builds clean, all 8 deletion targets are gone, the new gating works, and compose the boundary-review section + PR notes.

**Step 10.1: Full workspace build + test**

```bash
pnpm build
pnpm test
```

Expected: green across all packages. ~40 packages remain (was ~48 pre-Phase-6 — net 8 deletions). Test count drops by ~150-200 (the deletion-target packages' own unit tests retire).

**Step 10.2: Re-grep stragglers**

```bash
# Hard gate: no retained code imports any deleted package.
rg -n "from ['\"]@ax/(llm-proxy-anthropic-format|llm-anthropic|agent-native-runner|llm-mock|tool-bash|tool-bash-impl|tool-file-io|tool-file-io-impl)" \
   --no-heading -g '!node_modules' -g '!dist'
# Expected: zero.

# Schema-field cleanup gate.
rg -n 'cfg\\.llm|cfg\\.runner|cfg\\.tools|cfg\\.anthropic' --no-heading -g '!node_modules' -g '!dist' -g '!docs/plans/'
# Expected: zero — all references retired in Tasks 4 and 5.

# IPC manifest cleanup gate.
rg -n "'llm:call'" packages/ipc-core packages/ipc-server packages/ipc-http --no-heading
# Expected: zero in src/; only in tests asserting "missing service hook" error formatting (those use llm:call as an arbitrary unregistered hook name and stay).
```

If anything is non-zero, STOP and reconcile before composing the PR.

**Step 10.3: Compose boundary-review block for PR description**

Phase 6 doesn't add new hooks or change existing hook signatures (the orchestrator's gating tightening is a behavior change inside an existing hook, not a new contract). The boundary-review note is short:

```markdown
## Boundary review — orchestrator gating tightening

- **Alternate impl this contract could have:** none — the gating is a host-side decision based on `bus.hasService(...)`, not a hook signature. No alternate impl applies.
- **Payload field names that might leak:** none. The new outcome adds a string `reason: 'proxy-not-loaded'` to `AgentOutcome` (already a string-tagged union). No new field names.
- **Subscriber risk:** `chat:end` subscribers (`@ax/audit-log`, `@ax/conversations`, channel-web SSE) see one new `outcome.reason` value. Their existing handling for `'terminated'` outcomes already covers the structural shape; the new reason string is additive.
- **Wire surface:** none. The orchestrator's gating decision happens before any IPC / sandbox interaction. No wire-format change.
```

**Step 10.4: Compose Phase 6 PR notes**

Mirror Phase 5's PR-notes structure. Save as `docs/plans/<YYYY-MM-DD>-phase-6-pr-notes.md` AFTER the PR opens (gitignored; local-only artifact).

Contents:
- What lands (per-slice table of slices: package deletions × 8, schema cleanup, IPC manifest cleanup, orchestrator gating, doc updates).
- Reality-check deviations from plan (especially the `@ax/tool-dispatcher` deferral — design Section 6 was wrong on that row at HEAD).
- Half-wired window CLOSED (Phase 2 → llm-proxy-anthropic-format dies; Week 6.5d → native runner dies; cfg.llm/cfg.runner config dimensions retire).
- Boundary review (orchestrator gating).
- Invariants verified (table mapping each I to the test/grep that proves it).
- Stats (commit count, file count, LOC delta — expect ~−2000 LOC net).
- Bisect note (commit pairs per task).
- Operator notes (`cfg.llm`, `cfg.runner`, `cfg.tools`, `cfg.anthropic` no longer accepted; `ax.config.ts` files setting them will fail validation. Deploy: AX_LLM_MODEL / AX_LLM_MAX_TOKENS env vars no longer read by the k8s preset).
- Follow-ups (Phase 6.6 — rewrite claude-sdk-runner.e2e + preset acceptance tests; Phase 7 — kernel types + audit-log subscription switch + AgentMessage role narrowing; tool-dispatcher → mcp-client merge as a separate slice; agent-runner-core merge into SDK runner as a separate slice).

**Step 10.5: No commit for this task** — verification + PR-description prep only.

---

## Acceptance criteria (verified before merge)

| | Criterion | How verified |
|---|---|---|
| I1 | `chat:end` fires exactly once per `agent:invoke` (incl. new `'proxy-not-loaded'` exit) | New orchestrator test in Task 8 + existing audit-log + orchestrator tests still passing |
| I2 | `chat:turn-end` + `proxy:rotate-session` seam intact | Phase 3 rotation tests still passing; no orchestrator-rotation code changed |
| I3 | `agents:resolve` ACL gate fires on every chat | Existing orchestrator tests still passing; no gate code touched |
| I4 | J6 conversation routing intact | Existing route-by-conversation tests still passing |
| I5 | Hard cut on legacy plugins (no aliases, no shims) | Task 10 grep gate: zero hits for any deleted package |
| I6 | Runner self-sufficiency holds | No runner code changed except workspace-diff comment |
| I7 | `proxy:close-session` fires once per `proxy:open-session` | New `proxy-not-loaded` test asserts close-count = 0; existing close-once tests still passing |
| I9 | All commits leave workspace buildable (or commit-pair) | Per-task `pnpm build` + `pnpm test`; bisect-note in PR notes lists pair boundaries |
| I10 | No new half-wired plugins / hooks / bus surfaces | Pure deletion + gating tighten; no new manifest entries |
| I11 | Audit-log subscription unchanged | `git diff main..HEAD packages/audit-log/` is empty |
| I12 | `AgentInvokeInput` shape unchanged | `git diff main..HEAD packages/chat-orchestrator/src/orchestrator.ts | rg AgentInvokeInput` shows no interface change |
| I13 | Wire-surface reason+log strings preserved | Existing `chat-run-timeout` / `chat-run-error` / `chat_run_dispatch_failed` strings still present at their existing sites |
| I14 | `ChatTimeoutError` class stays | `class ChatTimeoutError` still defined |
| I15 | No retained package imports any deletion target | Task 10 grep gate |
| I16 | `@ax/tool-dispatcher` continues to register `tool:register` and `tool:list` | mcp-client + test-harness tests still passing |
| I17 | Deterministic lockfile after `pnpm install` | `pnpm install --frozen-lockfile` succeeds in CI |
| I18 | Tightened orchestrator gating preserves the skew-misconfig path | Existing `'proxy-hooks-misconfigured'` test still passing; new `'proxy-not-loaded'` test passes; reasons distinct |

---

## Phase 5 lessons feeding into Phase 6

| Lesson | How it shapes Phase 6 |
|---|---|
| **`feedback_check_plan_vs_reality.md`** — design's deletes table predates several intervening slices. | Reality-check section is an explicit task (Task 1). The design's "delete `@ax/tool-dispatcher`" row is wrong at HEAD; this plan flags and defers, doesn't blindly follow. |
| **`feedback_half_wired_window_pattern.md`** — close the window in the same PR. | Phase 6 closes two windows: Phase 2 (`@ax/llm-proxy-anthropic-format` dies; was loaded but unreached) and Week 6.5d (native runner default; `cfg.runner` collapses). Explicit "window CLOSED" section in PR notes. Memory mutation note: Phase 6 also opens NO new windows — pure deletion + behavior tightening. |
| **`feedback_targeted_followup_commits.md`** — small follow-up commits over reflexive amends. | If CR turns up an issue (say a stray import of a deleted package), prefer a follow-up commit. PR-A is large enough that mid-PR amends churn the diff. |
| **`feedback_minor_issues_non_blocking.md`** — reviewer Minor + ship = ship. | Don't gate PR-A on perfect e2e coverage (PR-B will rebuild it). Don't gate on the `cfg.llm`/`cfg.runner` schema collapse being maximally elegant — drop the field, don't redesign the schema. |
| **`feedback_plan_revision_after_rollback.md`** — number invariants explicitly when shipping a higher-effort slice. | Phase 6 has 18 invariants (Phase 5's 14 + 4 new). Every one earns its slot — see Acceptance criteria table. |
| **`project_phase_1b_shipped.md`** — `credentials:get` reshape was deferred from Phase 1b to Phase 3 because OAuth needed `kind`. Pattern: defer deletions when a successor's needs aren't yet known. | Tool-dispatcher deletion is exactly this pattern: defer because the catalog ownership move isn't clear yet. |

---

## Estimated landing

- **Tasks:** 10 (1 read-only survey + 8 substantive + 1 verification).
- **Commits:** ~14-16 (commit pairs per package deletion + a few inline edits + the gating change + final docs).
- **Files touched:** ~50 (drops in cli + 2 presets + 8 deleted packages × ~10 files each + ipc-server/ipc-http/ipc-core + chat-orchestrator + README + deploy + tsconfig refs + lockfile).
- **LOC delta:** approximately **−2000 LOC** net (eight packages × ~150-300 LOC each, minus ~100 LOC of new tightening / comment-rewriting).
- **Risk:** **Low-medium.** Pure deletion is straightforward; the orchestrator gating change has a behavior-shape implication (new outcome reason) that's covered by a new test. The two halves are bisect-friendly.
- **Predecessors:** Phase 5 (PR #23, merged). Hard dependency — Phase 6 deletes the packages Phase 5 left orphaned.
- **Successors:**
  - **PR-B (Phase 6.6) — rewrite claude-sdk-runner e2e + preset acceptance tests.** Stub Anthropic backend, MCP stdio coverage, k8s preset acceptance. Lives in its own PR for review-grain (memory `feedback_minor_issues_non_blocking.md`: ship PR-A independently).
  - **Phase 7 — kernel types + audit-log + AgentMessage narrowing.** Drops `LlmRequest` / `LlmResponse` / `ToolCall` / `ToolDescriptor` / `ToolPreCall*` from `@ax/core` and `@ax/ipc-protocol` (audits which are still live first), switches `@ax/audit-log` to subscribe to `event.http-egress`, narrows `AgentMessage` from 3 roles to 2.
  - **Tool-dispatcher → mcp-client merge slice.** Move host-tool catalog ownership; delete `@ax/tool-dispatcher`. Out of Phase 6 (reality-check fail).
  - **`@ax/agent-runner-core` merge into SDK runner slice.** Inline IpcClient + DiffAccumulator + co. into `@ax/agent-claude-sdk-runner`, delete the shared library. Phase 5 deferred this; Phase 6 still defers.

---

## Out-of-scope reminder

Phase 6 PR-A does NOT:

- Delete `@ax/tool-dispatcher` (reality-check fail; deferred to a successor slice).
- Delete `@ax/agent-runner-core` (Phase 5's deferral still holds).
- Delete `LlmRequest` / `LlmResponse` / `ToolCall` / `ToolDescriptor` / `ToolPreCall*` from `@ax/core` or `@ax/ipc-protocol` (Phase 7).
- Delete `ToolExecuteHost*` types (Phase 5 audit confirms they're live; Phase 7 audits orphans).
- Switch `@ax/audit-log`'s subscription from `chat:end` to `event.http-egress` (Phase 7).
- Narrow `AgentMessage` from 3 roles to 2 (Phase 7).
- Refactor `runAgentInvoke` for clarity (deferred from Phase 5 open question §3).
- Rewrite `claude-sdk-runner.e2e.test.ts` (PR-B).
- Rebuild `presets/k8s/src/__tests__/{acceptance,multi-tenant-acceptance}.test.ts` (PR-B).
- Rename `@ax/chat-orchestrator` (deferred per Phase 4 plan).

The discipline: Phase 6 deletes exactly the package-level dead code that Phase 5 made unreachable. Anything else — kernel type cleanup, audit-log subscription switch, catalog ownership refactor — has its own slice.
