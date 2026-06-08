# TASK-163 — Filestore mount infrastructure (design §13 Phase 1)

**Branch:** `auto-ship/TASK-163-filestore-mount-infra`
**Design:** `docs/plans/2026-06-07-filestore-user-files-design.md` (§4–6, §9, §13 Phase 1)
**Scope:** ONE fully-wired PR delivering the per-agent durable `/workspace` mount.
NOT Phase 2 (cwd/HOME re-root → TASK-164), NOT Phase 3 (skill drafts → TASK-165).

## Established interface facts (predecessors, binding)

- `@ax/sandbox-mount-protocol` already ships `MountSpec` (`NfsMountSpec | LocalDirMountSpec`),
  `ResolveMountsInput { owner }`, `ResolveMountsOutput { mounts }`, `ResolveMountsHandler`
  (TASK-162). **Import — do not redefine.**
- Governed tier is `/agent` (TASK-161, was `/permanent`). New NFS user-files tier is `/workspace`.
- Env var the provider sets from the `role:'user-files'` mount = `AX_USERFILES_ROOT`.

## Tasks (independent, testable)

### T1 — `@ax/workspace-localdir` plugin (new)
- New package mirroring `@ax/workspace-git`'s manifest shape. Deps: `@ax/core`,
  `@ax/sandbox-mount-protocol`.
- Config `{ root: string; mountPath?: string }` (default mountPath `/workspace`).
- Registers `sandbox:resolve-mounts`. Returns
  `[{ kind:'localDir', mountPath, hostPath: join(root, agentId), readOnly:false, role:'user-files' }]`
  when `owner.agentId` matches `^[a-z0-9-]+$`, else `[]`.
- Tests: spec shape, agentId validation (reject `../`, uppercase, empty), `[]` for ownerless.

### T2 — `@ax/workspace-filestore` plugin (new)
- New package, same shape. Deps: `@ax/core`, `@ax/sandbox-mount-protocol`.
- Config `{ backing: { server, exportPath }; mountPath?: string }` (default `/workspace`).
- Registers `sandbox:resolve-mounts`. Returns
  `[{ kind:'nfs', mountPath, server, exportPath, subPath: agentId, readOnly:false, role:'user-files' }]`
  when `owner.agentId` matches `^[a-z0-9-]+$`, else `[]`.
- Tests: spec shape, agentId validation, `[]` for ownerless.
- SECURITY.md note (new outbound network capability + per-agent subtree confinement).

### T3 — subprocess provider realizes `localDir`
- Add `sandbox:resolve-mounts` to `optionalCalls` with a degradation note.
- In `openSessionImpl`: when the hook is registered, `bus.call` it with `{ owner }`;
  for each returned mount switch on `kind` — `localDir` → `mkdir -p hostPath` (recursive),
  stamp `AX_USERFILES_ROOT=mountPath... ` (for subprocess hostPath==mountPath conceptually:
  the runner sees the real hostPath, so stamp the hostPath). Unknown kind → throw PluginError.
- Helper extracted to a testable `resolve-and-realize` module so it has a unit test that
  doesn't need a full spawn.
- Tests: localDir mkdir + env stamp; unknown kind errors; no resolver → no AX_USERFILES_ROOT.

### T4 — k8s provider realizes `nfs`
- Add `sandbox:resolve-mounts` to `optionalCalls` with the degradation note.
- `open-session.ts`: `bus.call` the hook (when registered) with `{ owner }`, pass `mounts`
  into `buildPodSpec`.
- `pod-spec.ts`: accept `mounts?: MountSpec[]`. For each `nfs` mount add an inline volume
  `{ name, nfs: { server, path: exportPath } }` + a runner `volumeMount{ name, mountPath, subPath, readOnly }`,
  and (when `role==='user-files'`) stamp `AX_USERFILES_ROOT=mountPath`. Unknown kind → throw.
- Tests: pod-spec includes inline nfs volume + subPath mount + env when a mount is yielded;
  no mounts → spec unchanged; unknown kind throws.

### T5 — runner consumes `AX_USERFILES_ROOT`
- `env.ts`: read optional `AX_USERFILES_ROOT` (empty=absent) → `RunnerEnv.userFilesRoot?`.
- `main.ts`: when set, add it to `additionalDirectories` (alongside ephemeralRoot) —
  NOT cwd, NOT HOME.
- `system-prompt.ts`: a `userFilesNote(userFilesRoot)` describing `/workspace` as the durable
  shared user-files location; thread through `operationalNotes` / `buildSystemPrompt`.
- Tests: env read; additionalDirectories includes it; note present when set, absent when unset.

### T6 — preset wiring
- CLI (`packages/cli/src/main.ts`): push `createWorkspaceLocaldirPlugin({ root })` (root under
  the same parent dir as the sqlite/workspace repo, env override `AX_USERFILES_ROOT_DIR`).
- k8s preset (`presets/k8s/src/index.ts`): when a filestore config is present, push
  `createWorkspaceFilestorePlugin({ backing, mountPath })`; `loadK8sConfigFromEnv` reads
  `AX_FILESTORE_SERVER` / `AX_FILESTORE_EXPORT_PATH` / `AX_FILESTORE_MOUNT_PATH`.
- Tests: preset registers exactly one resolver; CLI registers the localdir resolver.

### T7 — canary acceptance (subprocess + localDir, no NFS)
- New acceptance test: open a subprocess session for agent `a` writing a marker file under
  the resolved `/workspace` hostPath; end; open a second session for the same agent; assert
  the file persists (the durable localDir survives across sessions). Green in CI, no NFS.

### T8 — deploy chart: Filestore config + NetworkPolicy egress
- `values.yaml`: `sandbox.filestore: { server, exportPath, mountPath }` (default empty server
  = disabled).
- Host deployment template: stamp `AX_FILESTORE_*` env when `sandbox.filestore.server` set.
- `sandbox-restrict.yaml`: when `sandbox.filestore.server` set, add egress to that IP on
  TCP+UDP 2049 + 111 only.
- helm-render test: NetworkPolicy egress present + scoped; env stamped; absent when disabled.

## Gate
`pnpm install && pnpm build && pnpm -r run test` + lint clean. Whole-branch
`ax-code-reviewer` (skipped — no Task tool in orchestrated mode; self-review +
security-checklist instead). security-checklist note in PR.

## Learnings to surface (for TASK-164 / TASK-165)
- `AX_USERFILES_ROOT` value + `/workspace` mountPath, `optionalCalls` wiring, the
  provider→runner env contract, and the resolver plugin factory names.
