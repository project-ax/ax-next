# TASK-992 — Pin the blob root, require the durable `/files` home, kind NFS — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **STATUS: Filestore backups were descoped by the human on 2026-10-30** ("Skip this for now… We'll implement backups later"). They are deferred to a separate later card filed by the orchestrator; TASK-995 does NOT wait on it. This plan ships Tasks 1–6 only. The research the planner did on backup mechanisms is kept in the decisions shard.

**Goal:** Make the blob directory explicit config, byte-identical to today's derived path. Make every agent session's durable `/files` home mandatory at chart render, host boot and session open. Give kind a durable `/files` NFS export.

**Architecture:** There are three fail-closed layers, all keyed to existing value and env names:
- chart template guards: a new `ax-next.validateFilestore` and an extended `ax-next.validateBlobBackend`;
- the k8s preset env loader: `AX_FILESTORE_SERVER` and `AX_BLOB_FS_ROOT` become required;
- both sandbox providers: an owned session without a `role: 'user-files'` mount is refused.

kind reuses `deploy/kind/memory-nfs` with a second, PVC-backed export. The `<release>-workspace` PVC stays, and a chart test now proves the blob root lives on it.

**Tech Stack:** TypeScript + vitest; Helm 3 templates tested with `helm template` (`@ax/chart-tests`); POSIX sh (kind NFS entrypoint); kind on OrbStack for the live check.

**Spec:** `docs/plans/2026-10-29-agent-files-simplification-design.md` (§4 "The durable home is required", §13 Ops, §16 slice 3, §17). Decisions: `.claude/memory/decisions/2026-10-30-TASK-992.md`.

## Global Constraints

- **The blob root is exactly `/var/lib/ax-next/workspaces/blobs`.** That is today's `<workspace.mountPath>/blobs` on GKE (`gke-values.yaml:108`) and on a default install (`values.yaml:146`). kind uses `blob.backend: s3` (MinIO) and has no fs root, so there is nothing to pin there.
- **No new chart value keys.** Use only `blob.fs.root`, `sandbox.filestore.{server,exportPath,mountPath,hostReadPath}`, `memory.exports.*` and `workspace.mountPath`. Prod upgrades with `helm upgrade --reuse-values`, which renders with the OLD release's values. A new key is nil there, so read anything possibly absent through `dig` or `default`.
- **Env names are unchanged:** `AX_BLOB_BACKEND`, `AX_BLOB_FS_ROOT`, `AX_FILESTORE_SERVER`, `AX_FILESTORE_EXPORT_PATH`, `AX_FILESTORE_MOUNT_PATH`, `AX_FILESTORE_HOST_READ_PATH`.
- **Do NOT touch:**
  - the git workspace tier, `.ax/`, `workspace:*` hooks or `validator-identity` (TASK-995);
  - the `/files` quota meter (sibling card);
  - `packages/sandbox-k8s/src/pod-spec.ts` and `packages/agent-claude-sdk-runner/src/main.ts`. TASK-994 edits both; nothing here needs them.
- **Cluster safety:** every kubectl, helm or make call against a cluster names `--context kind-ax-next-dev` or `--kube-context kind-ax-next-dev`. The default context is GKE PROD. Nothing is applied to prod, and nothing calls gcloud.
- **Public repo:** no RFC1918 address under `deploy/` or `docs/` beyond the allowlist in `scripts/__tests__/no-deployment-specifics-committed.test.js`. Use only `10.9.8.7` and `10.96.200.49`; `192.0.2.x` is not RFC1918. `gke-values.yaml` keeps `server: ""` and `hostReadPath: ""`. Production's Filestore address is NOT in this repo and must not be put there.
- **Copy:** error messages and docs follow CLAUDE.md "Voice & Tone": plain language, say what to do next, no jokes in failure text.
- **Gate:**
  - `pnpm build`
  - `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`
  - `pnpm lint`
  - The chart suite is `pnpm --filter @ax/chart-tests test`. It needs helm, which is installed locally (v3.13.2). Its pgvector file also needs `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock`. CI runs it in the `helm-render` lane, because this PR touches `deploy/charts/` and `presets/k8s/`.

## Review Focus

1. **A prod upgrade with `--reuse-values` from a pre-change release.** The live values carry `blob.fs.root: ""`. The render must FAIL and print the exact path to pin, never silently use a new directory. Covered by a test in Task 4.
2. **An owned session whose agentId fails the resolver gate `/^[A-Za-z0-9_-]+$/`.** The resolver returns `[]`. The session is refused with `home-unavailable`, not opened without a home. Covered by Task 2 tests in both providers.
3. **Stub user-files resolvers in tests sharing an NFS server and export with the `/memory` mount.** The pod-spec alias refusal would then fire and mask the case under test. Stubs use the server `files.example.invalid` (Task 2).
4. **A kind NFS pod that starts without its PVC.** For example, someone applies an old manifest. The entrypoint must refuse rather than serve agent homes from the emptyDir (Task 5 test).
5. **A `--reuse-values` prod release whose live values lack `sandbox.filestore.server`.** The render fails with the Filestore message, so the PR deploy notes carry a read-only pre-flight (Task 6).

---

### Task 1: Preset — explicit blob root, required Filestore config [tier: integration]

**Files:**
- Modify: `presets/k8s/src/index.ts` (line numbers approximate):
  - `K8sPresetConfig.blob` (~:287-299) becomes required;
  - the `filestore` doc (~:300-318);
  - the `createK8sPlugins` blob block (~:768-805) and its filestore comment (~:747-753);
  - the `blobConfigFromEnv` header and body (~:1609-1696);
  - the loader's filestore block (~:1807-1850, including the shared-pool `if (!filestore) throw`);
  - config assembly (~:1998-2030).
- Modify tests:
  - `presets/k8s/src/__tests__/blob-backend.test.ts`
  - `presets/k8s/src/__tests__/preset.test.ts`:
    - `stubConfig` :51;
    - env fixtures :441, :1247, :1265, :1286, :1315, :1336, :1360, :1388, :1407, :1424, `minRequired` :1788, `baseEnv()` :2188 and `baseEnv` :2266;
    - the blob-gc arm :923-982, :984, and the filestore describe :2264-2330.
  - `shared-pool.test.ts` (:18, :29), `boot-graph.test.ts` (:12-39), `credentials-admin-loaded.test.ts`, `orchestrator-keepalive.test.ts`, `retire-strata-index.test.ts`, `runner-binaries.test.ts`, `agent-workspace-retired.test.ts`.
  - The real-init suites `multi-tenant-acceptance.test.ts` (:418) and `prod-bootstrap.test.ts` (:93, :269, :473).
  - `presets/memory/src/__tests__/preset.test.ts`: `baseK8s` :12, `baseConfig`/`noVolumeConfig`, and `baseEnv` :331-343.
  - `presets/memory/src/__tests__/boot-graph.test.ts`: `baseK8s` :19 and loader env :57-58.
  - `presets/memory/src/__tests__/canary.test.ts` (:258-305).
- Modify scripts: `scripts/memory-product-e2e.mjs:239` and `scripts/memory-lifetime-soak.mjs:171` (run by `pnpm test:scripts`).

**Interfaces:**
- Produces:
  - `export function blobConfigFromEnv(env: NodeJS.ProcessEnv = process.env): K8sBlobConfig`. The `workspace` parameter is removed.
  - `K8sPresetConfig.blob: K8sBlobConfig`, now required.
  - `loadK8sConfigFromEnv(env)` always returns `filestore: { server, exportPath, mountPath? }`.
  - `K8sPresetConfig.filestore` STAYS optional. Test compositions bring `@ax/workspace-localdir` instead; Task 2's provider check covers the rest.
- Exact error strings. `deploy/charts/ax-next/__tests__/env-shape.test.ts` scans this file for `'X is required` and `requires X to be set`, so keep each one in a plain `'...'` literal, not a template literal:
  - `AX_BLOB_BACKEND=fs requires AX_BLOB_FS_ROOT to be set` (also thrown when `AX_BLOB_BACKEND` is unset, because fs is the default)
  - `AX_FILESTORE_SERVER is required: every agent needs a durable /files home on an NFS export (the chart sets it from sandbox.filestore.server)`
  - `K8sPresetConfig.blob is required: pass the blob backend explicitly (the chart stamps AX_BLOB_FS_ROOT from blob.fs.root)` (from `createK8sPlugins`)

- [ ] **Step 1: Write the failing tests in `presets/k8s/src/__tests__/blob-backend.test.ts`.**
  - Replace `'defaults to fs with a root derived from the workspace root'` (:87) with `'requires AX_BLOB_FS_ROOT for fs — no workspace-derived default'`. Assert `expect(() => blobConfigFromEnv({ AX_WORKSPACE_BACKEND: 'local', AX_WORKSPACE_ROOT: '/var/lib/ax-next/workspaces' })).toThrow('AX_BLOB_BACKEND=fs requires AX_BLOB_FS_ROOT to be set')`, and the same with `AX_BLOB_BACKEND: 'fs'` added.
  - New `'the blob root does not depend on the workspace config'`. Use four workspace variants:
    - `{AX_WORKSPACE_BACKEND:'local', AX_WORKSPACE_ROOT:'/var/lib/ax-next/workspaces'}`
    - `{AX_WORKSPACE_BACKEND:'local', AX_WORKSPACE_ROOT:'/elsewhere'}`
    - `{AX_WORKSPACE_BACKEND:'git-protocol', AX_WORKSPACE_GIT_SERVER_URL:'http://git:7780', AX_WORKSPACE_GIT_SERVER_TOKEN:'t'}`
    - `{}`

    Each `blobConfigFromEnv({ ...ws, AX_BLOB_FS_ROOT: '/var/lib/ax-next/workspaces/blobs' })` must `toEqual({ backend: 'fs', root: '/var/lib/ax-next/workspaces/blobs' })`. The same four variants spread over the loader's base env must give an identical `loadK8sConfigFromEnv(...).blob`.
  - Replace `:195` `'defaults the blob backend to fs (root under the workspace PVC)'` with two tests:
    - `'loadK8sConfigFromEnv takes the fs root from AX_BLOB_FS_ROOT'`;
    - `'loadK8sConfigFromEnv refuses fs without AX_BLOB_FS_ROOT'`, whose base env still carries `AX_WORKSPACE_ROOT`. Today that env silently derived `/var/lib/ax-next/workspaces/blobs`.
  - Replace `:41` `'defaults to the fs backend when blob config is absent'` with `'createK8sPlugins refuses a config without blob'` (`toThrow('K8sPresetConfig.blob is required')`).
  - Give `:65`'s first config an explicit fs `blob`. In the existing explicit-root and s3 tests, drop the second argument.
- [ ] **Step 2: Write the failing tests in `preset.test.ts` and `shared-pool.test.ts`.**
  - `:2319` becomes `'loadK8sConfigFromEnv throws when AX_FILESTORE_SERVER is absent'` (`toThrow(/AX_FILESTORE_SERVER is required/)`).
  - Rename `:2289` to `'createK8sPlugins loads no resolver when filestore is omitted (owned sessions are then refused by the provider)'`. The assertion is unchanged.
  - `shared-pool.test.ts:29` now expects `/AX_FILESTORE_SERVER is required/`; the old shared-pool-only throw becomes unreachable.
- [ ] **Step 3: Run them and confirm the failures.** Run: `pnpm --filter @ax/preset-k8s exec vitest run src/__tests__/blob-backend.test.ts src/__tests__/preset.test.ts src/__tests__/shared-pool.test.ts`. Expected: FAIL on the new and renamed cases.
- [ ] **Step 4: Implement the preset changes in `presets/k8s/src/index.ts`.**
  - `blobConfigFromEnv(env)`: the fs arm reads `AX_BLOB_FS_ROOT` and throws the exact string when it is unset or empty.
  - Loader filestore block: throw the exact `AX_FILESTORE_SERVER` string when it is unset or empty. Keep the export-path check. Put `filestore` in the config literal and delete the unreachable shared-pool throw.
  - `createK8sPlugins`: guard `config.blob === undefined` with the exact string, then `const blobConfig = config.blob`.
  - Rewrite every comment in this file that says the root is derived from `<workspace mountPath>/blobs`, or that sessions get "graceful degradation" or "emptyDir-only" without a resolver. The comments to rewrite are at ~:287-312, :747-753, :768-776, :1609-1643, :1807-1812, :1998-2009, :2026-2028 and :2085-2087.
- [ ] **Step 5: Sweep the fixtures (mechanical).**
  - Every env fixture listed under Files gains `AX_BLOB_FS_ROOT: '/var/lib/ax-next/workspaces/blobs'`, `AX_FILESTORE_SERVER: '10.9.8.7'` and `AX_FILESTORE_EXPORT_PATH: '/vol1'`.
  - Manifest-only config fixtures gain `blob: { backend: 'fs', root: '/tmp/preset-k8s-stub/blobs' }`. These are `stubConfig`, `baseK8s`, the boot-graph shapes, credentials-admin-loaded, orchestrator-keepalive, retire-strata-index, runner-binaries and agent-workspace-retired.
  - Real-init configs gain `join(<that test's own tmp dir>, 'blobs')`:
    - multi-tenant, prod-bootstrap and both scripts (`join(directory, 'blobs')`);
    - the memory canary, as `blob: { backend: 'fs', root: <its tmp>/repo/blobs }`, which is the path it derives today.
  - The memory loader's `baseEnv` gets the same three vars. Its memory-export path must not overlap `/vol1`, because the memory preset's `posixPathsOverlap` checks that.
  - If a "throws X" loader test now reports `AX_FILESTORE_SERVER` or `AX_BLOB_FS_ROOT`, add the vars to that env. Never weaken the assertion.
- [ ] **Step 6: Run the suites.**
  - Run: `pnpm --filter @ax/preset-k8s test`, then `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm --filter @ax/preset-memory test`, then `pnpm test:scripts`, then `pnpm build`. Expected: PASS. tsc covers the now-required `blob`.
- [ ] **Step 7: Commit.** `feat(preset-k8s): blob root and Filestore home are explicit, required config (TASK-992)`

### Task 2: Providers — an owned session without a `/files` home is refused [tier: sensitive] [security-checklist]

**Files:**
- Modify: `packages/sandbox-k8s/src/open-session.ts`, step 2b (~:197-230, comment included).
- Modify: `packages/sandbox-k8s/src/plugin.ts` (:84-101), the `optionalCalls` degradation text and its comment.
- Modify: `packages/sandbox-subprocess/src/open-session.ts`, step 3b (~:410-440, comment included).
- Modify: `packages/sandbox-subprocess/src/plugin.ts` (:60-77), degradation text.
- Modify: `packages/sandbox-mount-protocol/src/mount-spec.ts`, the `sandbox:resolve-mounts` contract comment (:117-127).
- Test: `packages/sandbox-k8s/src/__tests__/open-session.test.ts` and `packages/sandbox-subprocess/src/__tests__/open-session.test.ts`.
- Test (canaries that chat through the subprocess sandbox with an owner):
  - `presets/k8s/src/__tests__/acceptance.test.ts`, the harnesses at :562 (test :473) and :750 (test :652);
  - `multi-tenant-acceptance.test.ts:456`;
  - `usage-limits-acceptance.test.ts:284`.

**Interfaces:**
- Produces `PluginError` with code `'home-unavailable'`, thrown from both providers' `sandbox:open-session` when `input.owner !== undefined` and EITHER:
  - no `sandbox:resolve-mounts` service is registered (do not call it); or
  - the resolved mounts contain no `role: 'user-files'` mount.

  The memory mounts share the k8s `mounts` array, so check the role, not the length.
- The `resolveUserFilesMount` helper (subprocess), host-read (`sandbox:read-user-files`) and the `agents:deleted` cleanup keep their current graceful contracts. Do not change their tests.
- Ownerless sessions are unchanged. No production caller opens one, since `chat-orchestrator` always sets `owner` (orchestrator.ts:3896-3917).
- Messages, verbatim:
  - k8s, no resolver: `no durable home for this session: nothing registers sandbox:resolve-mounts, so the agent would have no /files. Configure sandbox.filestore (the k8s preset then loads @ax/workspace-filestore).`
  - k8s, resolver gave none: `no durable home for this session: the sandbox:resolve-mounts resolver returned no /files mount for this agent.`
  - subprocess, either case: `no durable home for this session: no sandbox:resolve-mounts resolver gave this agent a /files directory. Load @ax/workspace-localdir (the CLI always does).`
- k8s also logs `podLog.error('home_unavailable', { agentId: input.owner.agentId, resolverLoaded: <boolean> })`.

- [ ] **Step 1: Write the failing k8s tests.**
  - Add a `USER_FILES_RESOLVER` services map: `{ 'sandbox:resolve-mounts': async (_ctx, input) => ({ mounts: [{ kind: 'nfs', role: 'user-files', mountPath: '/files', server: 'files.example.invalid', exportPath: '/vol1', subPath: input.owner.agentId, readOnly: false }] }) }`. Pass it to every harness whose tests set `owner`: the tests at :349 and :396, and the memory block harnesses at :927, :977 and :1032, including its 12-row table. Rows that deliberately test memory-vs-writable aliasing keep their own resolver.
  - New tests:
    - `'refuses an owned session when no home resolver is registered'`. Expect `PluginError` code `home-unavailable`; `createNamespacedPod` not called; `session:terminate` called once with the minted sessionId.
    - `'refuses an owned session when the resolver yields no user-files mount'` (resolver returns `{ mounts: [] }`). Same assertions.
    - `'refuses when the resolver yields only a mount without role user-files'`. Same assertions.
    - `'an ownerless session still opens without a resolver (unchanged)'`.
- [ ] **Step 2: Write the failing subprocess tests.**
  - The tests at :899 and :1054 get a services stub returning `{ mounts: [{ kind: 'localDir', role: 'user-files', mountPath: '/files', hostPath: join(tmp, input.owner.agentId), readOnly: false }] }`.
  - New tests:
    - `'refuses an owned session when no home resolver is registered'` and `'refuses an owned session when the resolver yields no mounts'`. Each expects `PluginError` code `home-unavailable`, `session:create` never called (subprocess resolves before minting), no child spawned, and the socket temp dir removed.
- [ ] **Step 3: Run the tests and confirm the failures.** Run: `pnpm --filter @ax/sandbox-k8s exec vitest run src/__tests__/open-session.test.ts` and `pnpm --filter @ax/sandbox-subprocess exec vitest run src/__tests__/open-session.test.ts`. Expected: FAIL on the new refusal tests.
- [ ] **Step 4: Implement the k8s check.** Put it immediately after the step-2b resolve block and before the `sandbox:memory-mounts` block. On refusal, run `session:terminate` exactly like the existing failure handler at :220-226.
- [ ] **Step 5: Implement the subprocess check.** Put it inside the existing step-3b `try`, right after `resolveUserFilesMount`: `input.owner !== undefined && resolved.userFilesRoot === undefined` → throw. The existing `catch` already cleans up the skills and socket dirs and rethrows PluginErrors unchanged.
- [ ] **Step 6: Update the contract text.**
  - Manifest degradation for `sandbox:resolve-mounts`, both providers: `'open-session REFUSES owned sessions (no durable /files home); host-read answers unavailable and agent-delete cleanup is a no-op'`. In subprocess, drop the k8s-only clause.
  - Rewrite the mount-spec contract comment to say providers refuse an owned session without a `role: 'user-files'` mount, and that `[]` is a no-mount only for host-read and cleanup.
- [ ] **Step 7: Fix the canaries.** Next to each `createSandboxSubprocessPlugin()` listed under Files, add `createWorkspaceLocaldirPlugin({ root: join(<that test's tmp root>, 'user-files') })`. The import exists at acceptance.test.ts:40, and `@ax/workspace-localdir` is already a devDependency of `@ax/preset-k8s` (package.json:88). Do NOT set `filestore` in these configs: the subprocess sandbox cannot realize `nfs`.
- [ ] **Step 8: Run and mutate.**
  - Run: `pnpm --filter @ax/sandbox-k8s test`, `pnpm --filter @ax/sandbox-subprocess test`, `pnpm --filter @ax/sandbox-mount-protocol test`, and `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm --filter @ax/preset-k8s test`. Expected: PASS.
  - Mutation, following yolo-ship's commit-first protocol: delete each provider's new `if`. Only the new refusal tests should go red; record which.
- [ ] **Step 9: Write the security note and commit.**
  - Run the `security-checklist` skill. Sandbox-escape thread: the change only narrows (a refusal), grants nothing, and its message carries no untrusted text.
  - Commit: `feat(sandbox): refuse owned sessions without a durable /files home (TASK-992)`

### Task 3: Chart — the durable home is required [tier: integration]

**Files:**
- Create: `deploy/charts/ax-next/__tests__/fixtures/filestore-values.yaml`. `.helmignore` already excludes `__tests__/`.
- Modify: `deploy/charts/ax-next/templates/_helpers.tpl`: new `ax-next.validateFilestore` beside `validateBlobBackend` (~:546).
- Modify: `deploy/charts/ax-next/templates/host/deployment.yaml`:
  - add `{{- include "ax-next.validateFilestore" . -}}` after line 4;
  - always stamp `AX_FILESTORE_SERVER`, `_EXPORT_PATH` and `_MOUNT_PATH`, dropping the `if .Values.sandbox.filestore.server` wrapper at :331 and keeping the inner `hostReadPath` conditional;
  - rewrite the comment at :331-340.

  Leave the NetworkPolicy `if .Values.sandbox.filestore.server` conditionals alone: they are now always true and still correct.
- Modify: `deploy/charts/ax-next/values.yaml` (:299-320), the filestore comment. It is now required, and the line "Empty = feature disabled" goes.
- Modify: `deploy/charts/ax-next/gke-values.yaml`: add a `filestore:` block under the existing `sandbox:`.
- Modify tests:
  - the REQUIRED arrays: `render.test.ts` (:30), `env-shape.test.ts` (:42), `blob-backend.test.ts` (:29), `memory.test.ts` (:21), `pgvector-bootstrap.test.ts` (:45);
  - the cases named below in `render.test.ts`, `memory.test.ts` and `env-shape.test.ts`.
- Docs: `deploy/GKE.md`: Step 6, plus a new provisioning subsection.

**Interfaces:**
- Produces two template failures, verbatim:
  - `sandbox.filestore.server is empty. Every agent's home directory (/files) lives on an NFS export, and the chart will not render without one. On GKE, create a Filestore instance and set sandbox.filestore.server to its IP (deploy/GKE.md, "Provision the user-files Filestore"). On kind, run make dev-kind-memory-nfs; kind-dev-values.yaml already points at it.`
  - `sandbox.filestore.exportPath is empty. Set it to the Filestore share name with a leading slash, for example /vol1.`
- Read the values through `dig "filestore" "server" "" (.Values.sandbox | default dict)`.
- Fixture file content, exact:

```yaml
# Chart-test fixture (TASK-992): every render needs a durable /files home now.
# Suites pass this with -f FIRST, so kind-dev-values.yaml / gke-values.yaml
# passed later override it, and any --set overrides both.
sandbox:
  filestore:
    server: 10.9.8.7
    exportPath: /vol1
```

- `gke-values.yaml` block, exact:

```yaml
  # The agents' durable home (/files). REQUIRED: the chart will not render
  # without a server. Provision it first (deploy/GKE.md, "Provision the
  # user-files Filestore") and put its IP in gke-values.local.yaml.
  filestore:
    server: ""              # >>> EDIT (required) in gke-values.local.yaml: the Filestore IP
    exportPath: "/vol1"     # the share name from `gcloud filestore instances describe`
    hostReadPath: ""        # >>> EDIT (recommended) "/user-files" in gke-values.local.yaml
```

- [ ] **Step 1: Wire the fixture into every suite.**
  - In each suite, define `const FILESTORE_FIXTURE = resolve(here, 'fixtures/filestore-values.yaml')` and make `'-f', FILESTORE_FIXTURE` the FIRST two entries of REQUIRED.
  - Do NOT use `--set` here. Helm applies every `--set` after every `-f`, so it would override kind-dev-values.yaml and gke-values.yaml in every overlay test. `shared-storage.test.ts` already sets a server, so leave it alone.
- [ ] **Step 2: Write the failing render tests.**
  - `render.test.ts` 'sandbox.filestore wiring': replace `'omits AX_FILESTORE_* when no Filestore server is configured (default)'` with `'fails the render when sandbox.filestore.server is empty, and says what to do'`. Render with `--set sandbox.filestore.server=`; expect a non-zero exit, and stderr containing `sandbox.filestore.server is empty` and `deploy/GKE.md`.
  - Add `'fails the render when sandbox.filestore.exportPath is empty'`.
  - Delete `'does NOT open any Filestore egress when no server is configured (default)'`. That configuration can no longer render, and the failure test covers it.
- [ ] **Step 3: Write the failing memory and env-shape tests.**
  - `memory.test.ts` `'TASK-576: gke-values.yaml alone pins and renders facts memory, exports optional'` becomes `'gke-values.yaml plus a Filestore server renders facts memory, exports optional'`. Add `'--set', 'sandbox.filestore.server=10.9.8.7'`, and add the same `--set` to the :223 test.
  - New `'gke-values.yaml alone fails until a Filestore server is set'`: `renderFails(['-f', gke])` contains `sandbox.filestore.server is empty`.
  - Reword :259 to `'memory.exports and sandbox.filestore on one server with different export paths render (the kind layout)'`. Render with `--set sandbox.filestore.server=10.96.200.49 --set sandbox.filestore.exportPath=/files --set memory.exports.server=10.96.200.49 --set memory.exports.exportPath=/memory`; it must render.
  - `env-shape.test.ts`: add `'AX_FILESTORE_SERVER'` and `'AX_FILESTORE_EXPORT_PATH'` to `ALWAYS_REQUIRED`. Task 1 makes both required, and every render stamps them.
- [ ] **Step 4: Run the chart suite and confirm the failures.** Run: `pnpm --filter @ax/chart-tests test`. Expected: FAIL on the new and renamed cases.
- [ ] **Step 5: Implement the helper, the deployment change, and the values and gke-values edits.**
- [ ] **Step 6: Update GKE.md.**
  - Add `### Provision the user-files Filestore (required)` before Step 6's install command. Content:
    - `gcloud filestore instances create ax-next-files --project=$PROJECT_ID --zone=us-central1-a --tier=BASIC_HDD --file-share=name=vol1,capacity=1TB --network=name=default`;
    - the IP from `gcloud filestore instances describe ax-next-files --project=$PROJECT_ID --zone=us-central1-a --format='value(networks[0].ipAddresses[0])'`;
    - that it is dedicated and separate from the memory share;
    - that the chart refuses to render without it.
  - Step 6's `gke-values.local.yaml` sketch gains `sandbox.filestore.server: <the IP from the command above>` and `hostReadPath: /user-files`, with one line pointing at values.yaml's note on the read-only host mount.
  - In the memory section ("Provision the NFS export"), change "separate from any Filestore you point `sandbox.filestore.*` at" to "separate from the user-files Filestore above".
  - Any new `#anchor` link must resolve; `gke-backups-docs.test.js` checks them.
- [ ] **Step 7: Run the suites.** Run: `pnpm --filter @ax/chart-tests test` and `pnpm test:scripts`. The latter re-checks no-deployment-specifics on gke-values and GKE.md links. Expected: PASS.
- [ ] **Step 8: Commit.** `feat(chart): the durable /files home is required (TASK-992)`

### Task 4: Chart — the blob root is pinned [tier: sensitive]

**Files:**
- Modify: `deploy/charts/ax-next/values.yaml`: the blob block (:198-219), with `fs.root: /var/lib/ax-next/workspaces/blobs` and a rewritten comment.
- Modify: `deploy/charts/ax-next/gke-values.yaml`: the blob block (:113-117) and the overlay header lines that say `"" → <workspace.mountPath>/blobs`.
- Modify: `deploy/charts/ax-next/templates/_helpers.tpl`: `ax-next.validateBlobBackend` (:546-571) and its doc comment.
- Modify: `deploy/charts/ax-next/templates/host/deployment.yaml` (:283-296): the fs branch always stamps `AX_BLOB_FS_ROOT`, and the comment is rewritten.
- Modify: `deploy/charts/ax-next/templates/host/pvc.yaml`, header comment only.
- Test: `deploy/charts/ax-next/__tests__/blob-backend.test.ts`.

**Interfaces:**
- Consumes: Task 3's fixture in REQUIRED. Overlay renders below add `--set sandbox.filestore.server=10.9.8.7` after `-f gke-values.yaml`.
- Produces two template failures, both only when `blob.backend` is `fs`. Compute the path as `$mp := dig "mountPath" "/var/lib/ax-next/workspaces" (.Values.workspace | default dict)`. Messages, verbatim, with `$mp` and the root filled in:
  - (a) When `dig "fs" "root" "" .Values.blob` is empty:
    `blob.fs.root is empty. Blobs (attachments, artifacts, skill files) live on the host disk at blob.fs.root, and the chart no longer works that out from workspace.mountPath. This deployment's existing blobs are at <$mp>/blobs: pass --set blob.fs.root=<$mp>/blobs once (--reuse-values keeps it after that). An empty value usually means helm upgrade --reuse-values carried it forward from an older chart.`
  - (b) When `dig "backend" "" (.Values.workspace | default dict)` is `local` and the root does not start with `printf "%s/" (trimSuffix "/" $mp)`:
    `blob.fs.root (<root>) is not on the host's workspace volume (mounted at <$mp>), so blobs would land on the container's scratch disk and vanish on restart. Set blob.fs.root to a path under <$mp>; this deployment's existing blobs are at <$mp>/blobs.`

  Guard (b) exists because the pin creates a new hazard. A deployment with a custom `workspace.mountPath` that upgrades with `-f` values, not `--reuse-values`, would get the new default root, which sits off its PVC. The host has no other volume a blob root could live on: the chart offers no extra host volumes.
- `values.yaml` comment content:
  - where blobs live (the host's `<release>-workspace` PVC);
  - pinned by TASK-992 (it used to be derived from `workspace.mountPath`);
  - do not change it on an existing deployment;
  - the `--reuse-values` note.
- `pvc.yaml` header:
  - the PVC holds the bare repos AND `blobs/` (`blob.fs.root`);
  - when the workspace backend goes away (TASK-995 or the chart cleanup), this PVC and its host mount must stay;
  - the chart test `AX_BLOB_FS_ROOT lies on the host PVC mount` enforces it.

- [ ] **Step 1: Write the failing tests in `blob-backend.test.ts`.**
  - In the default-render test, change `expect(envVal(env, 'AX_BLOB_FS_ROOT')).toBeUndefined()` to `.value).toBe('/var/lib/ax-next/workspaces/blobs')`.
  - New `'the pinned root is byte-identical to the old derivation'`. For renders `[]` and `['-f', GKE_VALUES, '--set', 'sandbox.filestore.server=10.9.8.7']`: `AX_BLOB_FS_ROOT === AX_WORKSPACE_ROOT + '/blobs'` and `=== '/var/lib/ax-next/workspaces/blobs'`.
  - New `'AX_BLOB_FS_ROOT lies on the host PVC mount'`, over the same two renders. Read the PVC's name from the rendered `PersistentVolumeClaim` whose name ends `-workspace`; don't hardcode it. Find the host container `volumeMount` whose volume claims it, and assert that `AX_BLOB_FS_ROOT` starts with `mountPath + '/'`.
  - New `'an empty blob.fs.root fails the render and names the path to pin'`:
    - `['--set', 'blob.fs.root=']`: non-zero exit; stderr contains `blob.fs.root is empty` and `--set blob.fs.root=/var/lib/ax-next/workspaces/blobs`;
    - with `'--set', 'workspace.mountPath=/data/ws'` added, stderr contains `/data/ws/blobs`.
  - New `'a blob.fs.root off the workspace volume fails the render'`: `--set blob.fs.root=/mnt/custom-blobs` gives a non-zero exit, with stderr containing `is not on the host's workspace volume` and `/var/lib/ax-next/workspaces/blobs`.
  - New `'a custom workspace.mountPath with the default blob root fails, naming <mountPath>/blobs'`: `--set workspace.mountPath=/data/ws` fails, with stderr containing `/data/ws/blobs`.
  - Change the existing `'explicit blob.fs.root stamps AX_BLOB_FS_ROOT'` value to `/var/lib/ax-next/workspaces/custom-blobs`, which is under the mount. `/mnt/custom-blobs` now fails by design.
  - In the kind-dev render test, add `expect(envVal(env, 'AX_BLOB_FS_ROOT')).toBeUndefined()`. s3 has no fs root.
- [ ] **Step 2: Run them and confirm the failures.** Run: `pnpm --filter @ax/chart-tests exec vitest run __tests__/blob-backend.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Make the values, gke-values, helper, deployment and pvc.yaml changes.
- [ ] **Step 4: Run the full chart suite.** Run: `pnpm --filter @ax/chart-tests test`, so env-shape and memory re-check the new env line. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(chart): pin blob.fs.root to /var/lib/ax-next/workspaces/blobs (TASK-992)`

### Task 5: kind — the dev NFS server serves `/files` [tier: sensitive] [security-checklist]

**Files:**
- Modify: `deploy/kind/memory-nfs/nfs-server.yaml`: add a PVC, mount it, update the header comment.
- Modify: `deploy/kind/memory-nfs/entrypoint.sh`.
- Modify: `deploy/kind/memory-nfs/README.md`.
- Modify: `deploy/charts/ax-next/kind-dev-values.yaml`: the header (:18-28) and `sandbox:` (:91-100).
- Modify: `Makefile`: the help line (:121) and the target comment (:271-279). The recipe is unchanged: it still runs `apply` and `rollout`, which `scripts/__tests__/kind-tooling-pinned-to-kind-context.test.js` pins. Put no tool names in echo text.
- Modify: `deploy/README.md`: the kind bring-up step 5 comment (:70-76) and the reset note at :208. Deleting the NFS pod now empties `/memory` only; `/files` is on a PVC.
- Test: `deploy/charts/ax-next/__tests__/memory.test.ts`, the 'kind memory overlay' describe (:474-498). It already parses `KIND_NFS_MANIFEST`.

**Interfaces:**
- Consumes: Task 1 (loader), Task 2 (providers) and Task 3 (chart) in the image and chart used for the live check.
- `nfs-server.yaml`:
  - Add a `PersistentVolumeClaim` named `ax-next-files-nfs` in namespace `ax-next`, labelled `app.kubernetes.io/name: ax-next-memory-nfs`, with `accessModes: [ReadWriteOnce]` and `storage: 5Gi`. Give it no `storageClassName`, so kind's default `standard` (rancher local-path) applies.
  - In the Deployment, add volume `files` → that claim, mounted at `/exports/files`. The emptyDir `exports` at `/exports` stays.
- `entrypoint.sh`:
  - `FILES_DIR="$EXPORT_ROOT/files"`.
  - Refuse to start unless `mountpoint -q "$FILES_DIR"`, with the message `memory-nfs: /exports/files is not a mounted volume; refusing to serve agent homes from scratch space (apply nfs-server.yaml, which mounts the ax-next-files-nfs PVC there)` and exit 1.
  - Make `$FILES_DIR` root-owned, mode 0755. kubelet creates each agent's `subPath` as root, and the runner's chown init hands it to uid 1000.
  - `/etc/exports` gets exactly two lines, both to `$NODE_ADDR` only:
    - `$EXPORT_ROOT $NODE_ADDR(rw,fsid=0,crossmnt,sync,no_subtree_check,no_root_squash,insecure)`
    - `$FILES_DIR $NODE_ADDR(rw,fsid=1,sync,no_subtree_check,no_root_squash,insecure)`

    The node's `/var` is btrfs, so set the explicit fsid and don't rely on device UUIDs.
  - The banner names both client mounts (`<server>:/memory`, `<server>:/files`).
- `kind-dev-values.yaml` `sandbox:` gains:

```yaml
  # The agents' durable home (/files): the same dev NFS server as memory.exports
  # (pinned ClusterIP, for the same node-DNS reason), on its own PVC-backed export
  # so it survives NFS-pod restarts. hostReadPath matches production: the Files
  # tab reads through the host's read-only mount, not a pod per click.
  filestore:
    server: 10.96.200.49
    exportPath: /files
    hostReadPath: /user-files
```

- README content:
  - The server serves two things: `/memory` (emptyDir; a projection the host rewrites) and `/files` (the PVC; every agent's home, kept across NFS-pod restarts).
  - Restart the NFS pod → restart the host. That now also clears the host's `/user-files` mount.
  - To wipe every agent's files on kind: scale `deploy/ax-next-memory-nfs` to 0, `kubectl --context kind-ax-next-dev -n ax-next delete pvc ax-next-files-nfs`, then re-run `make dev-kind-memory-nfs`.
  - It stays dev-only: privileged, unauthenticated, exported to the node address only.

- [ ] **Step 1: Write the failing chart tests in the kind overlay describe.**
  - `'points sandbox.filestore at the same dev NFS Service, on its own /files export'`. Render `-f KIND_DEV_VALUES` and check the host env:
    - `AX_FILESTORE_SERVER` equals the Service `clusterIP` parsed from `nfs-server.yaml`;
    - `AX_FILESTORE_EXPORT_PATH === '/files'`, which `!==` `AX_MEMORY_EXPORT_NFS_PATH` (`/memory`);
    - `AX_FILESTORE_HOST_READ_PATH === '/user-files'`;
    - the host's `user-files-read` volume has `nfs.path === '/files'`.
  - `'the dev NFS server keeps /files on a PVC, not the emptyDir'`. Parse `nfs-server.yaml`: a `PersistentVolumeClaim` exists, and the container mounts a volume with `persistentVolumeClaim.claimName === <that PVC's name>` at `/exports/files`, while the emptyDir volume is mounted at `/exports`.
  - `'the entrypoint exports /exports/files separately, to the node only'`. Read `entrypoint.sh` as text: it contains `"$FILES_DIR $NODE_ADDR(`, `fsid=1`, `fsid=0` and `mountpoint -q "$FILES_DIR"`, and it does not contain `*(`.
- [ ] **Step 2: Run them and confirm the failures.** Run: `pnpm --filter @ax/chart-tests exec vitest run __tests__/memory.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Edit the manifest, the entrypoint, the values, the README, the Makefile text and deploy/README.md. Run: `pnpm --filter @ax/chart-tests test` and `pnpm test:scripts` (kind-tooling, no-deployment-specifics). Expected: PASS.
- [ ] **Step 4: Verify on kind.** Every command names `kind-ax-next-dev`. Never use a bare kubectl or helm.
  1. Ensure `deploy/charts/ax-next/charts/postgresql-*.tgz` exists; running the chart suite in Step 3 fetches it.
  2. Run `make dev-kind-memory-nfs`.
  3. Run `kubectl --context kind-ax-next-dev -n ax-next exec deploy/ax-next-memory-nfs -- exportfs -v`. It should show `/exports` (fsid=0) and `/exports/files` (fsid=1), both to the node address only. If NFSv4 clients cannot traverse into the child, check `crossmnt` on the root line before changing anything else.
  4. Run `helm --kube-context kind-ax-next-dev get values ax-next -n ax-next -o yaml > <scratchpad>/TASK-992/kind-values.yaml`. The file holds secrets: keep it in the scratch dir and delete it at the end.
  5. Then run `helm --kube-context kind-ax-next-dev upgrade ax-next deploy/charts/ax-next -n ax-next -f <scratchpad>/TASK-992/kind-values.yaml -f deploy/charts/ax-next/kind-dev-values.yaml`. This is the README's no-`--reuse-values` recipe.
  6. Delete the runner pods first: `kubectl --context kind-ax-next-dev delete pods -n ax-next-runners -l app.kubernetes.io/component=ax-next-runner`. Then run `make image`, which builds, loads and restarts the host.
  7. Check the host: `kubectl --context kind-ax-next-dev -n ax-next exec deploy/ax-next-host -c host -- sh -c 'printenv AX_FILESTORE_SERVER AX_FILESTORE_EXPORT_PATH; grep " /user-files " /proc/mounts'`.
  8. Drive one chat turn to an agent: "run `echo kind-992 > /files/probe.txt && ls -la /files`". Use the UI, or the headless recipe in the user memory note `reference_headless_authed_chat_kind.md`. In the runner pod, `exec ... -- sh -c 'echo $AX_USERFILES_ROOT; cat /files/probe.txt'` should print `/files` and `kind-992`.
  9. Delete that runner pod. On the next turn, "`cat /files/probe.txt`" should print `kind-992`.
  10. Run `kubectl --context kind-ax-next-dev -n ax-next rollout restart deploy/ax-next-memory-nfs`, then wait for the rollout. Delete the runner pods, restart the host, and run a new turn: `cat /files/probe.txt` should still print `kind-992`, because the PVC survived.
  11. Paste the outputs into the PR body, not the repo, and delete `kind-values.yaml`.
- [ ] **Step 5: Write the security note and commit.**
  - Run the `security-checklist` skill. Cover:
    - the dev-only privileged pod;
    - the new export's ACL, which is node-only like `/memory`, so a pod speaking NFS directly is refused;
    - `no_root_squash`, which the runner's chown init requires;
    - kind's new read-only host mount of every agent's files, the same widening as production (values.yaml `hostReadPath` comment).
  - Commit: `feat(kind): serve the agents' /files home from the dev NFS server (TASK-992)`

### Task 6: Stale-line sweep, PR deploy notes [tier: mechanical]

**Files:**
- Modify: `deploy/charts/ax-next/SECURITY.md:195`. Change "the durable `/files` mount, when configured, is NFS and per-agent `subPath`-confined" to "the durable `/files` mount (required) is NFS and per-agent `subPath`-confined".
- Modify: `packages/cli/src/main.ts:314`, comment only: "durable per-agent `/workspace` mount" → "`/files` mount". The CLI's behaviour is unchanged (decisions shard).
- Modify: `docs/plans/2026-10-29-agent-files-simplification-design.md` §13 (:303-304). The design says "today only the workspace PVC is snapshotted"; `backups.sh` snapshots the workspace AND facts disks (`KINDS="workspace facts"`, backups.sh:100). Make it "today only the two host disks (workspace and facts) are snapshotted". Add one sentence: Filestore backups were deferred by the human on 2026-10-30 to a separate card (Basic-tier Filestore has no backup schedule, so the mechanism is its own decision).
- Modify: `deploy/GKE.md`, the upgrade guidance (near "Pass the **same** values on **every** `helm upgrade`", ~:427, or the nearest upgrade section): add a short, plain note that the first upgrade after TASK-992 must carry `--set blob.fs.root=/var/lib/ax-next/workspaces/blobs` when it uses `--reuse-values` (the render refuses otherwise, on purpose), and that `-f gke-values.yaml` upgrades already get the pinned value. Also a matching line in `deploy/README.md`'s upgrade/redeploy section if one exists.
- Create (scratch, NOT in the repo): `<scratchpad>/TASK-992/pr-body-deploy-notes.md`, for the PR body.

- [ ] **Step 1: Make the three edits.** Then run `git grep -nE 'graceful degradation|emptyDir[- ]only|Empty = feature disabled|derives <workspace' -- ':!.claude/memory/**' ':!docs/plans/2026-0*'`. Every remaining hit must describe host-read or cleanup, not session open or the blob root.
- [ ] **Step 2: Write the deploy notes, verbatim headings.**
  - "Order: delete runner pods first, then the host (deploy/README.md 'Restarting the host pod: delete the runner pods FIRST'). Host and runner share one image."
  - "Pre-flight, read-only, on the GKE context you name explicitly:
    - `kubectl -n ax-next exec deploy/ax-next-host -- printenv AX_WORKSPACE_ROOT AX_BLOB_FS_ROOT`. Expect `/var/lib/ax-next/workspaces` and nothing.
    - `kubectl -n ax-next exec deploy/ax-next-host -- sh -c 'ls /var/lib/ax-next/workspaces/blobs | head -3'`. Expect hex shard dirs.
    - `helm get values ax-next -n ax-next -o yaml | grep -A4 'filestore:'`. `server` must be set, or the render fails with the new Filestore message."
  - "The standard `--reuse-values` upgrade FAILS at template time on this release, on purpose (`blob.fs.root is empty ...`). Add `--set blob.fs.root=/var/lib/ax-next/workspaces/blobs` once. From then on the live values carry it."
  - "Server dry-run diff should show `AX_BLOB_FS_ROOT=/var/lib/ax-next/workspaces/blobs` added to the host, plus the image lines. `AX_FILESTORE_*` is already stamped in prod. Anything else: stop."
  - "kind: `make dev-kind-memory-nfs` then helm upgrade with your old values file, as in deploy/kind/memory-nfs/README.md."
- [ ] **Step 3: Commit.** `docs: stale /files and backup lines (TASK-992)`

---

## Out of scope

- Filestore backups: deferred by the human on 2026-10-30, tracked separately (the orchestrator files the card). See the decisions shard for the mechanism research.
