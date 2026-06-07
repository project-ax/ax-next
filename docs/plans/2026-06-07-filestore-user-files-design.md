# Filestore-backed user files — design

**Date:** 2026-06-07
**Status:** Design — approved in brainstorming, pending written-spec review
**Author:** Vinay (+ Claude)

---

## 1. Problem & goal

Today the sandbox runner does all its file work inside a single git working tree
(`/permanent`, an emptyDir re-materialized from a host git bundle each session).
Everything the agent touches — agent state *and* the user's actual working files —
rides the per-turn `git add -A` → thin-bundle → `commit-notify` round-trip to the
host git-storage tier.

That round-trip is the wrong tool for **large/binary user content** (datasets, build
trees, media, cloned repos) and for **files that should simply persist live across
sessions** without a re-materialize-from-bundle step. The git pipeline was designed
for small, validated, versioned *agent state*, not bulk user data.

**Goal:** give each agent a durable, shared, real filesystem for the user's working
files — backed by a Google Cloud **Filestore** (managed NFS) export — mounted into
the sandbox, **outside** the git-tracked agent-state tier. User files become *live*:
written straight to NFS, durable across sessions, with **no git, no `workspace:apply`,
no version tokens, and no host round-trip** for them.

This was chosen over a Firestore (document DB) or GCS (blob store) backend because the
two drivers are **persistence of live files** and **large/binary workloads** — both of
which want a real POSIX filesystem, which is exactly what Filestore/NFS is.

### Non-goals (v1)

- Versioning/history for user files (rely on Filestore's native snapshots/backups if
  ever needed).
- Host-side read access to user files (the web UI reading the live share). *Designed
  for, not built — see §11.*
- Cleanup of an agent's subtree on agent deletion. *Designed for, not built — see §11.*

---

## 2. Decisions (resolved in brainstorming)

| # | Decision | Choice |
|---|---|---|
| D1 | Backend | Google Cloud **Filestore** (managed NFS), not Firestore/GCS |
| D2 | Model | **Bypass** git/versioning — user files are live on the mount |
| D3 | Identity | **Per agent** — one durable home per agent, `subPath=<agentId>` |
| D4 | Mount layout | **Separate top-level path** `/workspace`, outside the git tier |
| D5 | Tenancy | **One shared Filestore instance**, per-agent subtree, `subPath`-confined |
| D6 | Injection seam | **Tagged-union mount hook** `sandbox:resolve-mounts` (Approach A) |
| D7 | v1 scope | k8s **+ local-dev parity**; no host-read, no cleanup; *extensible to both* |
| D8 | Skill drafting | **Moves to `/workspace/.skill-draft/<id>/`** (durable), was `/ephemeral/skill-draft/` |
| D9 | cwd / HOME | **Plan 2** — `cwd=HOME=/workspace`; governed tier purely AX-internal |
| D10 | Tier rename | `/permanent` → **`/agent`** (separable refactor); `.ax/` **not** flattened |

---

## 3. Tier topology (target state)

Four mounts in the sandbox, each with one clear job:

| Mount | Volume | Backing | Persists? | Governed? | Holds |
|---|---|---|---|---|---|
| `/agent` (was `/permanent`) | `agent` | emptyDir, git-backed via host bundle | across sessions (via git tier) | **yes** (validator) | `.ax/**` agent state, `.claude/**` SDK config + transcripts |
| `/workspace` | `workspace` | **Filestore NFS**, per-agent `subPath` | across sessions (live) | no | user files, `~/bin`, dotfiles, `.skill-draft/`, cwd/HOME |
| `/ephemeral` | `ephemeral` | emptyDir | no (per-pod) | no | scratch, caches, venv, temp uploads |
| `/home/runner` | `home` | tmpfs (memory) | no | no | `CLAUDE_CONFIG_DIR=/home/runner/.ax/session` (host-materialized RO skills, transcript symlink) |

Key correction surfaced during design: there are **two distinct `.ax` directories**.
`/agent/.ax/SOUL.md` (git tier) is *not* the same as `CLAUDE_CONFIG_DIR`'s
`/home/runner/.ax/session/skills` (tmpfs home volume, the SDK `'user'` skill-discovery
source). The Filestore work touches neither — see §7.

> **Naming:** `/permanent` is renamed to `/agent` because under Plan 2 (§8) it becomes
> purely AX-internal, and "permanent" is actively misleading — that mount is an
> *emptyDir*, while `/workspace` (NFS) is the one that actually persists. The rename
> keeps the env var name `AX_WORKSPACE_ROOT`; only its default value and the pod-spec
> `mountPath`/volume name change. `.ax/` is kept as the governed subtree (`/agent/.ax/...`)
> — not flattened — because `.claude/` (SDK-owned) can't flatten anyway and `.ax/` is a
> recognizable, policy-load-bearing convention (`POLICY_PREFIXES`, `workspace-policy.ts`).
> The rename is a **separable refactor** (its own commit/PR) so it doesn't inflate the
> Filestore feature's security review.

---

## 4. The injection seam (Approach A)

The sandbox providers (`@ax/sandbox-k8s`, `@ax/sandbox-subprocess`) build the pod/process.
Something has to contribute the per-agent NFS mount. We introduce **one host-internal
service hook** — never an IPC action, never exposed to the untrusted sandbox:

```ts
'sandbox:resolve-mounts' (ctx, { owner }) → { mounts: MountSpec[] }
```

`owner` is the existing `OpenSessionInput.owner` (`{ userId, agentId, agentConfig, … }`).

`MountSpec` is a **discriminated union** living in a new pure-types package
`@ax/sandbox-mount-protocol` (mirrors `@ax/workspace-bundle-protocol` — keeps
backend vocabulary out of `@ax/core`, invariant I1):

```ts
export type MountSpec =
  | { kind: 'nfs';
      mountPath: string;   // e.g. '/workspace'
      server: string;      // Filestore IP / DNS
      exportPath: string;  // export path on the server, e.g. '/vol1/agents'
      subPath: string;     // per-tenant subtree, e.g. the agentId
      readOnly: boolean;
      role?: 'user-files'; // provider sets AX_USERFILES_ROOT from this mount
    }
  | { kind: 'localDir';
      mountPath: string;
      hostPath: string;    // real persistent dir on the dev host
      readOnly: boolean;
      role?: 'user-files';
    };
```

### Two preset-swapped plugins (one hook)

Exactly like `@ax/workspace-git` (local) vs `@ax/workspace-git-server` (multi-replica),
the hook has two concrete impls, **only one loaded per deployment**:

- **`@ax/workspace-filestore`** — prod/k8s preset. Config `{ backing: { server, exportPath },
  mountPath: '/workspace' }`. Returns
  `[{ kind:'nfs', mountPath, server, exportPath, subPath: owner.agentId, readOnly:false, role:'user-files' }]`,
  or `[]` when `owner.agentId` is absent (anonymous CLI → graceful no-mount).
- **`@ax/workspace-localdir`** — CLI/subprocess preset. Config `{ root, mountPath: '/workspace' }`.
  Returns `[{ kind:'localDir', mountPath, hostPath: join(root, owner.agentId), readOnly:false, role:'user-files' }]`.
  Gives the canary + dev loop a durable mount without real NFS.

Sandbox providers list `sandbox:resolve-mounts` in **`optionalCalls`** (degradation:
*"only the default emptyDir tiers; no durable per-agent user-files mount"*). When present
they call it and realize the kinds they support:

- **k8s** realizes `kind:'nfs'` as an **inline `nfs:` pod volume** (`{ nfs: { server, path: exportPath } }`)
  + `volumeMount{ mountPath, subPath, readOnly }`. No PVC/StorageClass/CSI driver needed;
  the kubelet auto-creates the `subPath` subdir on first use.
- **subprocess** realizes `kind:'localDir'` by `mkdir -p hostPath` (it shares the host FS;
  no container mount).
- An **unrealizable kind is an explicit error**, never a silent skip.

The provider sets `AX_USERFILES_ROOT = <mountPath|hostPath of the role:'user-files' mount>`
in the runner env.

### Boundary review (required for new hooks)

- **Alternate impl:** `@ax/workspace-filestore` (`nfs`) vs `@ax/workspace-localdir` (`localDir`)
  — two concrete impls with known differences. ✓ (a future `gcsFuse`/`s3Csi` is just another `kind`.)
- **Leaky field names:** `server`, `exportPath`, `subPath`, `hostPath` are backend-ish, but
  **bounded behind the `kind` discriminator** — the same escape hatch `@ax/credentials`
  uses for its `kind` union. Justify in the PR.
- **Subscriber risk:** providers MUST switch on `kind` and error on an unknown kind; they
  must never key off `server`/`exportPath` without checking `kind`. Documented on the type.
- **Wire surface:** **not** an IPC action. Host-internal only (the provider calls it during
  pod construction). It never crosses the sandbox edge, so there's no wire schema and no new
  untrusted-input surface.

---

## 5. Components / packages

| Package | New? | Responsibility | Registers | optionalCalls |
|---|---|---|---|---|
| `@ax/sandbox-mount-protocol` | new (types only) | `MountSpec` union + the hook's TS signature | — | — |
| `@ax/workspace-filestore` | new (plugin) | emit per-agent `nfs` mount from `owner` | `sandbox:resolve-mounts` | — |
| `@ax/workspace-localdir` | new (plugin) | emit per-agent `localDir` mount (dev) | `sandbox:resolve-mounts` | — |
| `@ax/sandbox-k8s` | modified | realize `nfs` mounts; set `AX_USERFILES_ROOT` | — | `sandbox:resolve-mounts` |
| `@ax/sandbox-subprocess` | modified | realize `localDir` mounts; set `AX_USERFILES_ROOT` | — | `sandbox:resolve-mounts` |
| `@ax/agent-claude-sdk-runner` | modified | consume `AX_USERFILES_ROOT` (cwd/HOME/addl-dirs/re-root/drafts) | — | — |
| `@ax/tool-skill-propose` | modified | draft `PREFIX` → `/workspace/.skill-draft/`, dynamic root | — | — |
| presets (CLI / k8s) | modified | load filestore (k8s) / localdir (CLI) | — | — |
| deploy chart + NetworkPolicy | modified | Filestore config + egress allow | — | — |

---

## 6. Data flow (session lifecycle)

1. Host opens a session: `sandbox:open-session(input)` with the existing `owner`.
2. Provider calls `sandbox:resolve-mounts({ owner })` (if available) → `MountSpec[]`.
3. Provider realizes each mount (k8s: inline `nfs` volume + `subPath`; subprocess: `mkdir`),
   auto-creating the per-agent subtree on first use, and sets `AX_USERFILES_ROOT`.
4. Runner boots: materializes the **governed tier** (`/agent`) from the host git bundle as
   today; finds `/workspace` already mounted (its per-agent subtree, possibly empty first time).
5. With `AX_USERFILES_ROOT` set, the runner applies **Plan 2** (§8): `cwd=HOME=/workspace`,
   `additionalDirectories += [/agent, /ephemeral]`, PreToolUse re-root of `.ax/**`+`.claude/**`
   → `/agent`, skill-draft root → `/workspace/.skill-draft/`.
6. Agent works: user files + `~/bin` + dotfiles land **live** on NFS. Per-turn `git add -A`
   in `/agent` only ever stages governed agent state (`/workspace` is a separate mount, outside
   the git root).
7. Session ends, pod dies; `/workspace` subtree persists on Filestore for the next session;
   `/agent` is re-materialized from the (advanced) git tier.

If `AX_USERFILES_ROOT` is **unset** (no mount resolver loaded), the runner behaves exactly as
today (`cwd=HOME=/agent`, drafts on `/ephemeral`). Graceful degradation, no half-wired path.

---

## 7. Skill paths (verified — what does and doesn't move)

- **Discovery** (`.ax/session/skills`) = `$CLAUDE_CONFIG_DIR/skills` = `/home/runner/.ax/session/skills`
  — tmpfs `home` volume, host-materialized read-only (`chmod 0555`), the SDK **`'user'`** source
  (`settingSources: ['user']`, `main.ts:1135`). **cwd/HOME-independent; untouched** by this work.
  (The `skills`/`projects` subdir names there are SDK-fixed and cannot be renamed.)
- **Drafting** moves from `/ephemeral/skill-draft/<id>/` to **`/workspace/.skill-draft/<id>/`**
  (D8) so half-finished drafts persist across sessions. The draft root becomes
  `AX_USERFILES_ROOT ?? ephemeralRoot` (graceful fallback when no durable mount), advertised to
  the model dynamically. Touches `tool-skill-propose/draft-paths.ts` (`PREFIX` + mapped root),
  the executor, the `skill_propose` descriptor, and the system-prompt line.

### Hard requirements for drafts-on-NFS (non-negotiable)

1. **`/workspace` is never an SDK setting/skill-discovery source.** Keep `settingSources: ['user']`;
   never lay a `.claude/skills` symlink into `/workspace`. A draft on durable shared NFS stays
   *inert* only because nothing discovers/executes it until the host `skill.propose` gate runs —
   this is the same hole that got the `'project'` source dropped (`main.ts:1123-1129`), and NFS
   would make a regression durable + shared.
2. **`SKILL.md` lstat hardening** in the executor — reject a `SKILL.md`-as-symlink (the extra-file
   walk already rejects symlinks at `skill-propose-executor.ts:170`; `SKILL.md` is read at line 117
   without an lstat).
3. **Per-agent quota + cleanup-on-successful-promote** (delete `/workspace/.skill-draft/<id>/` once
   the gate returns `active`/`pending`). A TTL sweeper for abandoned drafts is a follow-up. (Per-agent
   quota is needed for `/workspace` regardless — the agent can write arbitrary files there.)

The trust boundary is unchanged: draft (untrusted) → `skill.propose` validation + quarantine scan →
DB authored store → RO `0555` materialization → `'user'` discovery. Moving the *staging* location
from emptyDir to NFS does not weaken that gate; it trades away ephemerality, single-writer isolation,
and auto-GC, which (1)–(3) compensate for.

---

## 8. Plan 2 — cwd / HOME reshaping

`/permanent`→`/agent` conflates three things today: the git root, `HOME`, and the `.ax` location.
Plan 2 separates the user's working frame from the governed frame.

When `AX_USERFILES_ROOT` is set, the runner sets:

- **`cwd = /workspace`** — relative-path file work, builds, `git clone .`, and drafts land on durable
  storage by default (instead of the ephemeral `/agent` emptyDir).
- **`HOME = /workspace`** — `~/bin`, dotfiles, and tool caches go durable on NFS, killing the
  *large/binary-in-git* pattern (`~/bin` is currently git-bundled). The `home-bin-env` builder must
  use the `HOME` value, not `workspaceRoot`.
- **`additionalDirectories += [/agent, /ephemeral]`** — so the agent can still reach `.ax/uploads`
  and scratch.
- **PreToolUse re-root of `.ax/**` + `.claude/**` → `/agent`** — extends the existing `.ax/uploads`
  re-rooter (`main.ts:1091`). This closes the governance hazard: a `.ax/…` write relative to
  `cwd=/workspace` would otherwise land on ungoverned NFS, bypassing the validator and breaking
  git-backed memory.

What stays anchored to `/agent` (unaffected by the cwd move):
- The prompt-engine reads `${workspaceRoot}/.ax` (= `/agent/.ax`) directly, server-side. ✓
- Transcripts: `$CLAUDE_CONFIG_DIR/projects → /agent/.claude/projects` symlink redirects regardless
  of the cwd slug; `conversations:get`/resume readdir-walk `/agent/.claude/projects` (slug-agnostic). ✓
- Skill discovery is `CLAUDE_CONFIG_DIR`-based, HOME/cwd-independent. ✓

Result: **`/agent` becomes purely AX-internal** — the agent never writes user-driven data there; its
governed self-management (`.ax/**`) is re-rooted there explicitly and stays validated + git-backed.

---

## 9. Security (design-level walk; full `security-checklist` per impl phase)

The untrusted runner gets a **writable NFS mount**. The threat-model walk:

- **Sandbox escape / cross-tenant:** `subPath=<agentId>` confines the mount to the agent's own
  subtree — other agents' subtrees are *not even mounted*. `agentId` is validated `^[a-z0-9-]+$`
  (defense-in-depth vs. traversal). NFS symlinks resolve in the runner's *own* namespace, so they
  can't escape across tenants. Runner is non-root; `fsGroup`/ownership lets the runner UID write.
- **Prompt injection / governance:** §7 hard requirements (1)–(3) — `/workspace` is never a
  setting/skill source; the validator policy boundary (`.ax/**`+`.claude/**`) is preserved via the
  Plan-2 re-root; user files were never validated anyway (`filterToPolicy`), so nothing is lost.
- **Supply chain:** new deps are the NFS client path (k8s inline `nfs` volume = kubelet, no new npm
  dep) and the two small plugins (no third-party runtime deps). `security-checklist` re-runs per phase.
- **Network capability:** the sandbox egress lock must **explicitly allow** NFS to the Filestore IP
  (`:2049` + `:111`/rpcbind) — a deliberate, documented `NetworkPolicy` widening, scoped to the
  single Filestore IP.
- **Availability:** an **NFS mount failure** at pod start (server unreachable) must surface as a
  sandbox-open error (pod-event/timeout → the `chat:turn-error` path), **not** a silent CrashLoop hang.
- **Quota/DoS:** durable NFS has no auto-GC; per-agent quota + draft cleanup (§7.3) bound it.

---

## 10. Error handling & concurrency

| Condition | Behavior |
|---|---|
| `sandbox:resolve-mounts` absent | No durable mount; runner falls back to today's behavior. |
| `owner.agentId` missing | Plugin returns `[]`; no mount. |
| Unknown `MountSpec.kind` for a provider | Explicit error at realization (never a silent skip). |
| NFS mount failure at pod start | Surfaced sandbox-open error (not a hang). |
| Concurrent sessions of the *same* agent | Both mount `/workspace` RW — NFS allows it; file-level races are the agent's own concern (same as two terminals on one home). Documented as intended ("live shared files"). |

---

## 11. Built to support the deferred work (no rework)

- **Host-side read access (#3):** `MountSpec` carries `readOnly` from day one (runner uses `false`;
  the host later calls the **same** `sandbox:resolve-mounts` for an owner with a read-only realization
  to serve user files to the web UI). The hook is owner-keyed and reusable.
- **Cleanup-on-agent-delete:** `subPath=<agentId>` is a stable, documented convention, so a future
  `agents:deleted` subscriber can `rm -rf` the subtree via a short-lived job that mounts the export.

Neither is built in v1.

---

## 12. Testing (invariant I3 — fully wired, canary-reachable)

- **Unit:** `resolve-mounts` returns the right spec per plugin (and `[]` for an ownerless call);
  `agentId` validation; draft-path `PREFIX`/root resolution.
- **Provider:** k8s `buildPodSpec` includes the inline `nfs` volume + `subPath` mount when
  `resolve-mounts` yields one; subprocess creates the `localDir` + sets `AX_USERFILES_ROOT`.
- **Runner:** `AX_USERFILES_ROOT` drives `cwd`/`HOME`/`additionalDirectories`; `.ax/**` writes
  re-root to `/agent`; skill-draft root resolves to `/workspace/.skill-draft/`.
- **Canary / acceptance:** exercised via the **subprocess + `localDir`** path — a session writes a
  file to `/workspace`, ends; a second session sees it **persist**. Real end-to-end in CI, no NFS
  needed. (This is why local-dev parity is in v1 scope — canary reachability.)
- **k8s MANUAL-ACCEPTANCE walk** on the dev cluster: real Filestore — reload persistence + cross-agent
  isolation (agent A cannot see agent B's subtree).

---

## 13. Phasing (each phase fully wired; security-checklist per boundary-touching phase)

- **Phase 0 (separable refactor):** `/permanent` → `/agent` rename. Change `AX_WORKSPACE_ROOT`
  default, pod-spec `mountPath` + `permanent` volume name, subprocess, tests, docs. Pure mechanical;
  own commit/PR. May lead or trail the feature.
- **Phase 1 (mount infrastructure):** `@ax/sandbox-mount-protocol`, `sandbox:resolve-mounts`,
  `@ax/workspace-filestore` + `@ax/workspace-localdir`, provider `optionalCall` + realization,
  `AX_USERFILES_ROOT`, preset wiring, NetworkPolicy + chart config. The mount exists and is
  writable (added to `additionalDirectories`); the canary writes to `/workspace` and verifies
  persistence. Fully wired without Plan 2.
- **Phase 2 (Plan 2 reshaping):** `cwd=HOME=/workspace`, re-root `.ax/**`+`.claude/**`, `home-bin`
  uses `HOME`. Depends on Phase 1. Canary: agent writes land durable by default; `.ax` writes re-root.
- **Phase 3 (drafts → `/workspace/.skill-draft/`):** draft-path change + dynamic root, `SKILL.md`
  lstat, descriptor/system-prompt text, cleanup-on-promote, quota. Depends on Phase 1; parallel to
  Phase 2.
- **Phase 4 (deferred):** host-read mount + cleanup-on-agent-delete (§11).

Half-wired window: Phase 1 loads the resolver plugin in **both** presets in the same PR; the window
closes when Phase 2/3 make the mount load-bearing.

---

## 14. Open risks

- **Re-root robustness (Phase 2).** Broadening the PreToolUse re-rooter from `.ax/uploads` to all
  `.ax/**`+`.claude/**` is the linchpin of the governance story. Needs its own tests + a kind-cluster
  pressure-test before it's trusted. If the agent self-edits `.ax/` on a hot path, validate this early.
- **`subPath` auto-create semantics.** Confirm the kubelet creates the per-agent `subPath` subdir
  with writable ownership for the non-root runner UID (else an init step / `fsGroup` is required).
- **Filestore provisioning** is out-of-band (terraform/gcloud); the chart consumes `server`/`exportPath`
  but does not create the instance. Document the runbook.
