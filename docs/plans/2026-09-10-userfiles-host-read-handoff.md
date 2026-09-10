# Durable user-files: host-mounted read + a UI that can browse it — handoff

**Date:** 2026-09-10
**Status:** Plan, approved in conversation. Not started.
**Branch this continues:** `fix/agent-path-tier-naming` (5 commits, all green, nothing pushed)
**Baseline:** verified against that branch's tip, which is `main` @ `da34e0ff` + the 5 commits below.

---

## Why this exists

A review of "agents seem confused about `/agent` vs `/workspace` vs a temp dir" found that
the *tier plumbing* is correct and the defects were all in naming and in the tool contracts
layered on top. Four defects came out of it. Three are fixed and committed. This document is
the fourth.

**F4: `sandbox:read-user-files` has no consumer.** Both sandbox providers register it, a
canary exercises it, and `packages/channel-web/src/` contains zero references to it. The
workspace Files tab reads `workspace:read`, which is the git-backed `/agent` tier. So the
durable tier — which is the agent's cwd, and therefore where a deliverable lands by
default — is invisible in the UI.

---

## What already landed (do not redo)

Five commits on `fix/agent-path-tier-naming`, full gate green at the tip:

| Commit | What |
|---|---|
| `5351de55` | `test(sandbox-subprocess)`: three-tier durability canary — pins that the three roots are distinct and only the user-files tier survives a session |
| `65de3bb7` | `refactor(filestore)`: renamed the durable mount default `/workspace` → `/files` |
| `b3b544d6` | `fix(runner)`: agent-facing prose uses one term per root; the word "workspace" is banned from it and a test enforces that |
| `032b1334` | `docs(memory)`: review findings + naming decisions |
| `28d27146` | `fix(artifact-publish)`: allowlist validates against the session's real roots; the durable tier is publishable; the governed tier is off the list entirely |

Fixed by those: **F1** (the agent's cwd could not produce a download link), **F2** (the
`/agent/workspace/**` fossil), **F3** (`artifact_publish` was k8s-only because the allowlist
hardcoded sandbox-absolute prefixes).

Still open: **F4**, this document.

---

## The three tiers, as verified

| Root | env var | k8s backing | Durability |
|---|---|---|---|
| `/agent` | `AX_WORKSPACE_ROOT` | emptyDir, re-materialized from a host git bundle each session | per-turn `git add -A` → thin bundle → `workspace.commit-notify` |
| `/files` | `AX_USERFILES_ROOT` | Filestore NFS, `subPath=<agentId>` | live, survives sessions, never versioned |
| `/ephemeral` | `AX_EPHEMERAL_ROOT` | emptyDir | dies with the pod |

Since TASK-164 the agent's **cwd and HOME are `/files`** (`packages/agent-runner-core/src/run-runner.ts:1026`).
`/agent` is AX-internal, held together by the PreToolUse re-rooter in
`packages/agent-runner-core/src/governed-paths.ts`, which forces `.ax/**`, `.claude/**` and
root-exact `CLAUDE.md` back onto the governed tier however the model rooted them.

Note the naming trap this branch only half-fixed: `AX_WORKSPACE_ROOT` is `/agent`, and the
`workspace:*` hooks plus `@ax/workspace-git*` are all the *governed* tier, while
`@ax/workspace-filestore` and `@ax/workspace-localdir` serve the *durable* tier. The code
vocabulary was deliberately left alone — see `.claude/memory/decisions.md`, "Path-tier
vocabulary". Don't "fix" it as a side quest.

---

## The blocker that decided the design

`sandbox:read-user-files` costs **one Kubernetes pod per call**:
`packages/sandbox-k8s/src/user-files-ops.ts:416` — create pod → poll for exit at 500ms
(`ONESHOT_POLL_MS`, line 66) → read the log → kill. A file browser on that spawns a pod per
directory click and per file open, on the same Autopilot cold-start path the north-star doc
calls a live failure rather than a theoretical one.

The subprocess provider is nearly free by comparison — shared filesystem, direct read
(`packages/sandbox-subprocess/src/user-files-host-ops.ts:170`). So the hook works fine in dev
and is expensive exactly where it matters. That is very likely why nothing consumes it.

Four options were considered; **B was chosen**, on the grounds that the goal is eventually
browsing all of an agent's files, memory and artifacts, and the other options don't get there.

- **A — build on the pod-per-call hook.** No new capability, but seconds per click and likely
  timeouts on Autopilot. Rejected.
- **B — mount the export read-only on the host pod. CHOSEN.** Fast, no pods. Costs a real
  capability widening (see the security section).
- **C — don't build a browser.** Artifacts already reach the user as download links. Rejected:
  doesn't reach the stated goal.
- **D — one bounded recursive listing + per-file opens.** `buildReadCommand`
  (`user-files-ops.ts:338`) is POSIX `sh`, so a recursive walk is a contained script change;
  1 + N pods instead of N + N. Was the recommendation before the "browse everything" goal was
  stated. Rejected in favour of B, but **keep it in mind as the fallback if B's chart work
  turns out to be blocked** — it needs no new capability at all.

---

## Design

### Registration stays single-homed

`@ax/sandbox-k8s` keeps registering `sandbox:read-user-files`
(`packages/sandbox-k8s/src/plugin.ts:68` declares it, `:150` registers the handler) and picks
its realization from config:

- `userFilesHostReadRoot` set → direct filesystem read under that root.
- unset → today's one-shot pod, unchanged.

Two plugins racing to register one service hook would be load-order dependent. Choosing
pod-vs-host-mount is a k8s deployment detail the provider already owns — it owns the
`agents:deleted` cleanup realization too. **No new hook, so no boundary review**: this is a
second impl behind an existing signature, which is the answer that review would have asked for.

The hook contract is unchanged and lives at
`packages/sandbox-mount-protocol/src/mount-spec.ts:196-242` —
`ReadUserFilesInput { owner, relPath? }` → `{kind:'file',contents} | {kind:'dir',entries} | {kind:'absent'}`.
`absent` is a graceful "nothing to serve", never an error.

With the export mounted on the host, agent X's files are just `<hostReadRoot>/<agentId>/<relPath>` —
structurally identical to the localdir/dev case that `@ax/workspace-localdir` already serves.

### The judgement call, still open

The realpath-confinement reader exists **twice** already: as shell inside the k8s pod script
(`buildReadCommand`, `user-files-ops.ts:338` — `realpath` then a `case` confining to
`$realbase`) and as TypeScript in `sandbox-subprocess`
(`user-files-host-ops.ts:108 safeJoin`, `:135 confineByRealpath`, `:219` the `O_NOFOLLOW`
open). This adds a third caller.

**Recommended:** extract the TypeScript one into a shared pure package — `@ax/user-files-read`,
following the established `-core` / `-impl` / `-protocol` precedent (`@ax/skills-parser`,
`@ax/workspace-git-core`, `@ax/tool-bash-impl`) — and have both providers import it. A pure
library is not a cross-plugin import, so invariant #2 is satisfied.

**The alternative** is to copy the confinement a third time and unify later. That was offered
and not chosen either way before the session ended. Duplicating security-critical path
confinement is the thing you least want to defer, so start from the extraction unless it turns
out to be disproportionate.

### Scope

1. **Shared confined reader package.** Extract from `sandbox-subprocess`; switch that provider
   over; keep its existing tests green (they are the spec).
2. **`@ax/sandbox-k8s`:** `userFilesHostReadRoot` config → direct-read realization. Keep the
   pod path as the fallback when unset. Preserve the 1 MiB cap (`READ_MAX_FILE_BYTES`,
   `user-files-ops.ts:70`) so both realizations agree.
3. **Chart:** host NFS volume + read-only mount, a new value under `sandbox.filestore`, and
   host NFS egress. Preset threads the env through.
4. **Route:** `GET /api/workspace/agents/:agentId/user-files` and `/user-files/*`.
5. **UI:** the durable tier in `AgentFiles.tsx`.
6. **Tests per layer**, plus the k8s acceptance canary reaching the new route so it is not
   half-wired (invariant #3).

---

## Security — the actual decision in B

Today the host has **zero** access to agent subtrees; isolation is structural. After this it
has read access to all of them and isolation becomes code. Run the `security-checklist` skill
and put its note in the commit. The walk done in conversation:

- **Cross-tenant reads.** The route must resolve `agents:resolve` and 404 on miss *before*
  touching a path, then confine to `<root>/<agentId>`. Copy the ordering from the existing
  `agentFile` handler (`routes-workspace.ts:3352`), which documents why ACL precedes path
  validation: a 400-vs-404 split is a free oracle for probing another tenant's paths.
- **Symlink escape matters more here.** An agent writes its whole subtree and can plant
  `../other-agent/secrets`. Note the pod realization has the *same* exposure — it mounts the
  export and composes `$EXPORT/$SUBPATH` — and defends with realpath confinement. What changes
  is that the property becomes load-bearing in the host process. This is the single strongest
  argument for extracting the reader rather than copying it.
- **Host compromise** now also yields agent files. State it plainly; the host already holds the
  database, the blob store and every credential, so it is not a step up in blast radius.
- **Read-only end to end:** `readOnly: true` on the volumeMount, and the reader never opens a
  writable handle.
- **Resource bounds:** keep a file-size cap and a listing cap; an unbounded read of an NFS file
  into the host process is a DoS on the host, not just a slow request.

---

## File map

Everything below was verified on the branch tip; line numbers will drift as you edit.

**Hook + realizations**
- `packages/sandbox-mount-protocol/src/mount-spec.ts:196-242` — `ReadUserFiles*` types.
- `packages/sandbox-k8s/src/plugin.ts:68`, `:150` — declares + registers the hook.
- `packages/sandbox-k8s/src/user-files-ops.ts:416` — pod realization; `:338` the sh script;
  `:66` poll interval; `:70` the 1 MiB cap.
- `packages/sandbox-subprocess/src/user-files-host-ops.ts:170` — the direct-read realization to
  extract; `:108` `safeJoin`, `:135` `confineByRealpath`, `:219` the `O_NOFOLLOW` open.
- `packages/workspace-filestore/src/plugin.ts` — NFS coordinates (`server`, `exportPath`,
  `mountPath`, default now `/files`); `@ax/workspace-localdir` is its dev sibling.

**Chart / preset**
- `deploy/charts/ax-next/templates/host/deployment.yaml:428` volumeMounts, `:441` volumes —
  both already have conditional entries to copy the shape from; `:330-335` the `AX_FILESTORE_*`
  env block.
- `deploy/charts/ax-next/values.yaml` — `sandbox.filestore` block (carries the `/workspace`→
  `/files` upgrade note added on this branch).
- `deploy/charts/ax-next/templates/networkpolicies/agent-runtime-network.yaml:25-30` — selects
  the **host** component with an Egress policy, so host NFS egress must be added here.
- `deploy/charts/ax-next/templates/networkpolicies/sandbox-restrict.yaml:74-86` — the existing
  scoped NFS egress for runner pods (that IP/32, ports 2049 + 111). Copy this shape.
- `presets/k8s/src/index.ts:1683` — reads `AX_FILESTORE_SERVER` / `_EXPORT_PATH` / `_MOUNT_PATH`
  into config; `:702` loads `@ax/workspace-filestore`.

**Route**
- `packages/channel-web/src/server/routes-workspace.ts:3298` `agentFiles` (listing), `:3352`
  `agentFile` (one file) — the ACL ordering and error shapes to mirror.
- `:3760` and `:3776` — where the `/files` and `/files/*` routes are declared; add siblings.
- `packages/channel-web/src/server/safe-path.ts:103` `workspaceFilePath` — owns the single
  decode of the splat, which arrives from `@ax/http-server` verbatim (undecoded, slashes
  intact).
- `routes-workspace.ts:1354` `isServableWorkspaceFile`, and the response types
  `WorkspaceFileSummary` / `AgentFilesResponse` / `AgentFileResponse` around `:770-820`. Note
  the deliberate `path` (raw key, never rendered) vs `name` (fenced label) split — a filename
  is agent-authored and is the Trojan-source surface (CVE-2021-42574). Keep that split.

**UI**
- `packages/channel-web/src/components/workspace/AgentFiles.tsx` — read its header comment
  before editing. It distinguishes four things an empty middle can mean (listing failed / no
  backend / loading / agent wrote nothing) and only the last makes a claim about the agent.
  Preserve that; it is design rule H7 from `2026-08-21-agent-workspace-design.md`.
- `packages/channel-web/src/lib/workspace-files.ts:59` `useAgentFiles` — the hook to mirror.
- **Invoke the `shadcn` skill before writing UI** (invariant #6). The workspace lives in
  `packages/channel-web`, so every shadcn CLI call needs `-c packages/channel-web`.

---

## Gotchas that will cost you an hour each

- **`pnpm --filter` goes BEFORE the script name.** `pnpm test --filter @ax/x` silently runs the
  whole repo suite instead.
- **The full gate is three suites, not one.** `pnpm -r run test` bails at the first failing
  package. Use:
  `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, and do not stop
  at the recursive part — substituting it alone skips two suites.
- **A stale `dist/` looks exactly like a real regression.** This session hit 56 failures in
  `@ax/agent-claude-sdk-runner` with `buildActivityPhraseMap is not a function`; they reproduced
  on clean `main` and cleared with `pnpm build`. Vitest resolves workspace deps through built
  output, so a new export is invisible until `tsc --build` runs. Before investigating a package
  suite failure: `git stash`, re-run, then `pnpm build`.
- **`tsc` excludes test files**, so `pnpm build` never type-checks `__tests__`. Run vitest too.
- The Bash tool here runs **zsh**; brace `${i}` before a `:` or you get zsh modifier expansion.

---

## Verification before you call it done

```bash
pnpm build
pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts
pnpm lint
```

Then the things a green suite does not prove:

- The k8s acceptance canary must reach the new route — otherwise this is a half-wired plugin
  and does not merge (invariant #3).
- Walk it in a browser against the kind cluster with the `k8s-acceptance-loop` skill. A file
  browser that lists correctly and renders nothing is a passing test suite and a broken feature.
- Confirm the **read-only** property empirically, not by reading the manifest: exec into the
  host pod and try to write under the mount.

---

## Explicitly out of scope

Browsing **memory** and **artifacts**. Memory is already served by `workspace:read` and
artifacts live in the content-addressed blob store, so "browse everything" is three backends
behind one UI. Worth doing — it is the stated end goal — but after this lands, not inside it.

Renaming the code vocabulary (`AX_WORKSPACE_ROOT` → `AX_AGENT_ROOT`, `workspace:*` →
`agent-state:*`). Considered and deliberately rejected on this branch: nine hooks with
cross-plugin subscribers, manifest churn and a boundary review each, for no effect on what the
model reads.
