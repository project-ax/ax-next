# TASK-161 — Rename sandbox governed tier `/permanent` → `/agent`

**Type:** Mechanical rename (design `2026-06-07-filestore-user-files-design.md` §13 Phase 0).
**Branch:** `auto-ship/TASK-161-rename-permanent-to-agent`

## Scope (from card + design §3, §13)

Rename the git-backed governed sandbox tier `/permanent` → `/agent`. Keep the env var
**name** `AX_WORKSPACE_ROOT`; change only its **default value**, the k8s pod-spec
`mountPath` + `permanent` volume name, the subprocess setup, and references/comments/tests.
`.ax/` is **NOT** flattened — governed state stays under `/agent/.ax/`.

The runner reads `env.workspaceRoot` (no hardcoded `/permanent` in the live path), so this
is constants + comments + the artifact-publish allowlist prefix that tracks the tier.

### IN scope (load-bearing constants)
1. `packages/sandbox-k8s/src/pod-spec.ts`
   - `RUNNER_WORKSPACE_ROOT = '/permanent'` → `'/agent'`
   - volumeMount `{ name: 'permanent', mountPath: '/permanent' }` → `{ name: 'agent', mountPath: '/agent' }`
   - volume `{ name: 'permanent', emptyDir: {} }` → `{ name: 'agent', emptyDir: {} }`
   - surrounding comments
2. `packages/agent-claude-sdk-runner/src/env.ts` — default `?? '/permanent'` → `?? '/agent'`
3. `packages/tool-artifact-publish/src/path-allowlist.ts`
   - `PublishRoot = 'ephemeral' | 'permanent'` → `'ephemeral' | 'agent'`
   - `{ root: 'permanent', prefix: '/permanent/', allowed: ['workspace/'] }` → `{ root: 'agent', prefix: '/agent/', ... }`
   - `ALLOWED_DESC` string + docstring
   - (verified: `root` is not persisted/wire — only consumed by `root === 'ephemeral'` in `rootBaseFor`; safe to rename)
4. `packages/tool-artifact-publish/src/descriptor.ts` — model-facing path strings `/permanent/workspace/**` → `/agent/workspace/**`

### IN scope (tests asserting the above)
- `packages/sandbox-k8s/src/__tests__/{open-session,pod-spec}.test.ts`
- `packages/agent-claude-sdk-runner/src/__tests__/{env,home-bin-env,pre-tool-use,system-prompt,transcript-delta,tool-cache-env,main}.test.ts` (slug `-permanent` → `-agent`)
- `packages/tool-artifact-publish/src/__tests__/path-allowlist.test.ts`
- `packages/chat-orchestrator/src/__tests__/services-canary.test.ts`
- artifact-publish-executor e2e if it asserts `/permanent`

### IN scope (comments/docstrings — codebase consistency)
runner package (`pre-tool-use`, `materialize-uploads`, `prompt-engine`, `git-workspace`,
`commit-notify-resync`, `home-bin-env`, `tool-cache-env`, `main`, `transcript-delta`),
`pod-spec`, `ipc-protocol/actions.ts`, `ipc-core/workspace-materialize.ts`, `memory-strata`,
`validator-identity`, `workspace-git`, `workspace-git-server`, `channel-web` server +
tests, `tool-skill-propose`, `agent-identity-templates`, `container/agent/Dockerfile`,
`deploy/MANUAL-ACCEPTANCE.md`, `cli/serve.ts` help text if present.

### OUT of scope (do NOT edit)
- `docs/plans/*` historical design docs (incl. the filestore design doc — it IS the spec
  describing the rename) and `BACKLOG.md` — historical records.
- `.claude/memory/*` (append-only; main-checkout copies not mine).
- deploy chart `workspace.mountPath` (`/var/lib/ax-next/workspaces`) — that's the **host
  pod PVC** git-storage path, a different concept from the runner sandbox tier. Verified.
- `AX_WORKSPACE_ROOT` env var **name** stays (card requirement).

## Tasks (independent, testable)

- **T1 — k8s pod-spec rename.** pod-spec.ts constant + volume/mount name + comments;
  update `open-session.test.ts` + `pod-spec.test.ts`. Test-first: assert mountPath/volume
  `/agent` & name `agent`, env `AX_WORKSPACE_ROOT=/agent`.
- **T2 — runner env default.** env.ts `?? '/agent'`; env.test.ts default assertions →
  `/agent`. Test-first.
- **T3 — artifact-publish allowlist + descriptor.** path-allowlist.ts root/prefix/desc;
  descriptor.ts; path-allowlist.test.ts. Test-first (expect `root: 'agent'`, prefix `/agent/`).
- **T4 — transcript slug + runner comments.** transcript-delta slug example `-agent`;
  transcript-delta.test.ts; home-bin-env/tool-cache-env/pre-tool-use/system-prompt tests
  using `/permanent` literal → `/agent`; main.test.ts; comment-only sweeps across runner +
  other packages + Dockerfile + MANUAL-ACCEPTANCE.
- **T5 — whole-repo grep sweep.** `grep -rn "/permanent"` across code/config (excluding
  out-of-scope docs/memory) returns zero; build + test + lint green.

## Verification
`pnpm build && pnpm test && pnpm lint` clean. No stray `/permanent` in code/config.
