# Model policy — implementation verification

Completed for **TASK-G001** on `feat/model-policy`, based on `12793769`.
All 16 implementation tasks are complete. The new plugin is registered in the k8s
composition and reached by the production-bootstrap canary; the memory preset
inherits that composition.

Admins can search provider catalogs, select available models, choose a Default,
review removal impact, and save a versioned policy. New agents use the Default,
including personal-agent bootstrap. Removed models resolve onto the Default with
the correct runner without changing stored choices; re-adding a model restores
the original choice. The editor explains the move and leaves unchanged models out
of PATCH requests.

## Verification

The final recursive run exercised every package:

```sh
DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock \
AX_TESTCONTAINER_START_SLOT_WAIT_MS=180000 \
pnpm -r --no-bail --workspace-concurrency=2 run test --maxWorkers=2
```

**84 of 85 packages passed in that run.** The unchanged Claude SDK real-interrupt
test failed during temporary-directory cleanup with `ENOTEMPTY`. Its isolated
full-suite retry passed **279/279** tests. All package suites therefore have a
passing result; a single wholly green recursive run was not obtained. Earlier
runs also encountered Docker start-slot contention and timing-sensitive web
fixtures; limiting concurrency resolved those failures.

| Check | Result |
|---|---|
| `@ax/model-policy` | 94 tests passed |
| `@ax/agents` | 336 tests passed |
| OpenRouter / Anthropic | 69 / 67 tests passed |
| `@ax/channel-web` | 3,783 tests passed |
| k8s preset | 223 tests passed |
| `pnpm test:eslint-rules` | 22 tests passed |
| `pnpm test:scripts` | 1,091 passed, 3 skipped |
| Memory citation/blob guards after new shards | 13 tests passed |
| `scripts/memory-append-check.sh 12793769` | Shard-only, zero deletions |
| Root build and `pnpm typecheck` | Passed |
| Scoped ESLint and `git diff --check` | Passed |
| `pnpm audit --audit-level moderate` | No known vulnerabilities |

New policy/provider tests also passed an explicit typecheck. Some existing tests
excluded from the normal TypeScript build retain pre-existing strict typing
errors; this work does not claim to have repaired those unrelated tests.

## Independent review and regressions

A fresh reviewer found five important defects. Each received a failing regression
test before the fix, then a passing focused run and the package suites above:

1. Personal-agent bootstrap still supplied Sonnet after the Default changed.
   It now consumes the policy softly, with its legacy fallback when unavailable.
2. Catalog cache, pending reads and refresh throttles crossed admin credential
   identities. They now use authenticated user plus provider.
3. A delayed policy read could overwrite a successful save's cache. A generation
   guard returns the latest saved view instead.
4. Observed missing keys or failures could become `live` again without a fetch.
   Missing keys clear good state; failed refreshes preserve their status.
5. Delayed agent details could replace a newer New/Edit draft. Request generations
   are invalidated on New, Cancel and unmount.

The browser walk also caught the fixed Settings sidebar consuming most of a
390-pixel screen. A regression now pins compact navigation through the existing
shadcn Sheet. Existing focus tests still assert restoration to the workspace.
There are no deferred minor review findings.

## Local browser acceptance

The image was rebuilt and rolled out only to **kind-ax-next-dev**. `make image`
already loads the image, removes development source mounts and performs rollout.
The accepted host image was:

```text
sha256:66871ceedf2ae457878a4a5942deaf6194ba836e090e6acc6c35c42513b4c64c
```

Standalone Playwright with installed Chrome was used because this harness did not
expose the in-app browser tool. At **1280 and 390 pixels**, in **light and dark**:

- Built-in notice, selected list and initial Sonnet Default were visible.
- Multi-word search narrowed immediately; clearing restored the count; no-match
  copy, select-all, Default changes, removal and Cancel behaved correctly.
- There were no page errors or horizontal overflow.
- Screenshots captured initial, search, selection and moved-agent states in all
  four width/theme combinations.

Functional acceptance passed save/reload persistence, exactly matching model
picker options and Default, empty-selection save prevention, impact counts,
Go back without saving, confirmed moves, unrelated rename without a `model`
PATCH, re-adding the stored model, two-tab 409 recovery and Reload. A non-admin
received 403 for the policy and saw no Models navigation. First-run creation
succeeded with Sonnet removed and selected the policy Default.

The moved-agent chat completed with **“OK.”** Its persisted frozen session used
`openrouter/moonshotai/kimi-k3` and `aisdk`; its pod command selected the AI SDK
runner and its conversation recorded `runnerType: aisdk`. Normal host info logs
do not include the model, so these records were used as the routing evidence.

The cluster's actual catalog state was Anthropic live (13 models), OpenRouter
no-key. The no-key link opened AI model keys. No credentials were added to force
the plan's assumed opposite state; large OpenRouter catalogs and failure/retry
states are covered by automated tests.

Browser screenshots and the execution ledger are retained locally in
`.playwright-mcp/model-policy/` in the implementation worktree. Test agents,
conversations, runners, temporary authentication sessions/user and usage buckets
were removed. The original absent policy document was restored, then the host
restarted to clear caches. Existing users and agents were preserved.

The restoration rollout explicitly completed successfully. Later Kubernetes
status probes timed out (TLS handshake/header timeouts), and a Docker status probe
also stalled. Browser acceptance completed before these runtime availability
problems; the final cluster state could not be queried again. Shared Docker and
OrbStack settings were left unchanged.

## Boundaries and security

- **`models:get-policy`:** alternate implementation is a remote policy service or
  per-team policy table. Payload names do not leak a storage or transport backend.
  Two soft service consumers, agents and personal-agent bootstrap; no subscriber
  payload or IPC action. HTTP schemas/routes live in the owning plugin.
- **`models:list-available:<provider>`:** another provider plugin can implement the
  same backend-neutral `ref`, `label`, `status` response. Per-provider ownership
  follows the existing LLM hooks; discovery checks registration before calling.
- **Sandbox:** fixed HTTPS destinations, redirect refusal, existing credential
  resolution; no caller-supplied URLs, paths or new process access. Keys are never
  returned or logged. Routes enforce admin authorization and existing HTTP CSRF;
  removal impact returns counts only. Credential-dependent caches are isolated by
  authenticated user.
- **Injection:** strict refs and provider prefixes; labels use the core surface
  sanitizer plus Unicode format stripping and a 120-character cap. Responses have
  streamed 5 MiB budgets, 2,000-model caps and bounded deadlines; Anthropic paging
  shares the byte/deadline budget. Labels render as text. Model references reach
  the provider model parameter without command, path or SQL interpolation.
- **Supply chain:** no new registry packages or versions. Workspace package links
  reuse existing dependencies. Audit passed.

## Scope retained

Warm sessions keep their frozen model until a new session. Helper-model settings
and initial onboarding configuration remain separate from agent policy. Dirty
drafts prompt on browser unload; switching admin tabs still discards them.
Unobserved credential changes can wait for refresh or catalog TTL/retry expiry.

The branch and worktree are retained for review. PR description text is prepared
locally; publishing the PR and production rollout remain separate actions.
