# Agent files simplification — drop `.ax/` and the git workspace

Status: design, 2026-10-30. Reviewed by three adversarial reviewers (sandbox
security; runner/SDK/tools; host/hooks/ops) on 2026-10-29; their findings are
folded in below.

## 1. Why

Agent Tasks shipped, and the agent's file story is more complex than what it
does. A sandbox has five storage tiers today:

| Path | Backing | Lifetime |
|---|---|---|
| `/agent` (`AX_WORKSPACE_ROOT`) | emptyDir, materialized from a host-side git repo each session, committed + bundled back each turn | rebuilt per session |
| `/files` | inline `nfs:` volume, `subPath=<agentId>` (`@ax/workspace-filestore`) | durable, written live |
| `/memory` | read-only NFS facts export (`@ax/memory` export volume) | durable, host-written |
| `/ephemeral`, `/tmp` | emptyDir | pod |
| `/home/runner` | tmpfs; `CLAUDE_CONFIG_DIR=/home/runner/.ax/session` | pod |

The git tier exists to carry `.ax/**` through a per-turn bundle → host verify →
`workspace:pre-apply` → apply pipeline. Recon (2026-10-29) found:

- **Git gives users nothing.** No history UI, no diffs (`workspace:diff` has no
  production callers), no revert, no real CAS on UI edits (the identity editor
  starts at `parent:null` and retries with the actual head).
- **Only two live, file-as-source-of-truth families remain in `.ax`:** identity
  (`SOUL.md`, `IDENTITY.md`, `AGENTS.md`, `BOOTSTRAP.md`) and memory rules
  (`memory/system/rules.md`). Everything else is retired (draft-skills,
  routines), a projection of DB/blob state (uploads, `.claude/projects` jsonl,
  facts export), or defended-but-unread (`.claude/settings.json`, root
  `CLAUDE.md` — nothing reads them since `settingSources: ['user']`).
- **Cost:** ~7k LOC across `workspace-git*` packages, ~3k more in ipc-core
  handlers/bundler and runner `git-workspace.ts` / `commit-notify-resync.ts`, a
  git-server StatefulSet (kind), bare repos on the host PVC (GKE).

## 2. The rule

**Anything that needs a security gate or host validation lives in the DB and is
written only through hooks. Everything else is plain files on NFS.**

## 3. Goals, non-goals, anti-goals

Goals
- Delete the git workspace tier, `.ax/`, and every hook, IPC action and package
  that exists only to serve it.
- Identity, onboarding state and memory rules become DB rows written through
  hooks, validated at write time.
- One obvious answer to "where does X live?" for the agent and for us.

Non-goals
- File history / versioning / undo for `/files` (git never provided it to users).
- Version history for DB-backed, hook-written content (identity, memory rules).
  A later design may add history for everything written through hooks; this
  design stores none (decided 2026-10-30).
- Sharing files between agents or people (W2/W3 territory; reverted in #1004).
- Back-compat for existing conversations, agents or files (§10).

Anti-goals — this is a failure even if it works:
- Any new path where content the agent writes ends up in a future prompt, or in
  settings the SDK loads, without host validation.
- A privileged component writing into, or mounting inside, an agent-writable tree.
- Half-wired leftovers: a host handler, hook or package with no caller.

## 4. Final sandbox layout

```
/files/            agent home. Durable NFS, one share per agent (subPath=<agentId>).
│                  HOME and cwd for the agent SDK subprocess. All work product.
│                  Shown in the Files tab. Counts toward quota.
│
/memory/           read-only NFS facts export, host-written. Present only when
│                  the deployment enables memory exports. Sibling mount, NOT nested.
│
/tmp/              emptyDir on pod disk (not tmpfs). Gone with the pod.
├── uploads/       this conversation's attachments, flat: report.pdf, report (2).pdf
├── transcripts/   the SDK's jsonl working copy (DB is source of truth, §8)
└── …              caches, venvs, temp clones
│
/home/runner/      tmpfs. The RUNNER process's HOME (pod HOME stays here).
                   CLAUDE_CONFIG_DIR lives here: installed skills (0555), SDK state.
```

Removed: `/agent`, `.ax/`, `/ephemeral` (merged into `/tmp`).

Decisions and reasons:
- **Home stays at `/files`.** Fixed and named in the system prompt; agents write
  absolute paths into their instructions, so it must never move.
- **`/memory` stays a sibling mount** (decided 2026-10-30). Nesting it at
  `/files/.memory` was rejected: the agent owns `/files` and can replace the
  `.memory` mountpoint with a symlink or file between sessions — mount redirect
  (runc CVE-2021-30465 class), forged persistent "memory" when the mount is
  absent, or a one-command permanent session-start failure. The existing overlap
  refusal in `sandbox-k8s/src/pod-spec.ts` (~:528-548) stays.
- **HOME = `/files` only for the agent SDK subprocess** (as today,
  `agent-claude-sdk-runner/src/main.ts:448,490`). The pod/runner HOME stays on
  tmpfs `/home/runner`, so the runner's own trusted children (pip venv scaffold,
  npx/uvx MCP servers, proxy CA under `~/.ax/proxy-ca`) never read
  agent-planted `~/.npmrc`, `pip.conf`, `~/.config/uv`. Tool caches
  (`buildToolCacheEnv`) point at `/tmp`.
- **The durable home is required.** Today the NFS mount is optional and git was
  the durable floor. Session open fails without a home resolver. Chart fails at
  template time when `sandbox.filestore.server` is empty; kind dev gets an NFS
  server (reuse `deploy/kind/memory-nfs`); the local CLI keeps
  `workspace-localdir`.
- **git stays installed in the runner image** (agents `git clone` for their own
  work; the prompt suggests it). Only the git-server image/templates go.

## 5. Identity and onboarding → DB

Owner: `@ax/agents` (Invariant 4).

Storage
- Identity sections: `identity`, `soul`, `operatingNotes` (was `AGENTS.md`), text,
  per agent, with a monotonically increasing `revision`.
- No version history is stored (decided 2026-10-30; see §3 non-goals). `revision`
  is only a change counter used for the prompt refresh below.
- Onboarding state: `bootstrap: 'none' | 'pending' | 'done'`, set inside the
  `agents:create` transaction. Only the conversational "create an agent by
  talking to it" path creates `pending`; onboarding's Default Agent and
  admin-created agents get `none`.

Service hooks (names indicative; boundary review in the PR)
- `agents:identity:get {agentId} → {identity, soul, operatingNotes, bootstrap, revision}`
- `agents:identity:set {agentId, patch, expectedRevision}` — calls the scan hook,
  fails closed; on success fires `system-prompt:augment-changed` so live
  sessions pick up the change (same mechanism Rules use).
- `agents:identity:complete-bootstrap {agentId}` — requires non-empty identity
  and soul; compare-and-set `pending → done`; second caller gets "already done".
- `identity:scan` registered by `@ax/validator-identity` (precedent:
  `skills:scan`). Reuse `regexScan` + UTF-8 check + the 256 KiB cap. The
  bootstrap-window logic and canonical-BOOTSTRAP-bytes check are deleted.
- Boundary review notes from review: alternate impl = a team-level profile
  service; avoid leaky names (`path`, `.ax`, `AGENTS.md`, git `version`/`parent`).

Agent-facing tools (host-executed)
- `update_identity({section: 'identity'|'soul'|'operatingNotes', content})` plus
  an optional `{old, new}` edit form. Returns the saved text and says "applies
  from your next message".
- `complete_bootstrap()` — offered only while `bootstrap = 'pending'`.
- Both are system tools: they bypass the per-agent `allowedTools` filter
  (`run-runner.ts:703-706`), otherwise allowlisted agents can never finish
  bootstrap.
- **`update_identity` is not offered in unattended runs** (routine- or
  task-sourced sessions with no person present). Decided 2026-10-29.
- When the agent changes its own identity, the host (not the model) records an
  entry in the agent's activity, shown on Today to the agent's owner (decided
  2026-10-30). It says which section changed. No Undo: the owner fixes the text
  in the identity editor like any other edit. Writes made by a person through
  the editor don't create an entry.

Prompt
- The host freezes the current identity text and bootstrap state into the
  session config (`session.get-config`, an ipc-protocol change); the runner's
  `prompt-engine.ts` composes from config, not files. `readAxIdentityFiles` /
  `readAxFile` are deleted.
- `bootstrap = 'pending'` → bootstrap prompt (from the template), only in
  sessions with a person present; unattended runs never use bootstrap mode.
- **Mid-session change:** the session records the identity `revision` it was
  built with; at turn start the orchestrator compares with the current revision
  and, if different, starts a fresh runner that resumes the SDK session. One
  prompt-cache miss per change. Nothing changes mid-turn.
- Templates: rewrite `BOOTSTRAP_TEMPLATE` to use `update_identity` +
  `complete_bootstrap`; delete `bootstrapPathNote`; rewrite
  `identityEvolutionNote` (it currently says "use Write … committed
  automatically").

UI
- Identity editor and bootstrap routes (`routes-agent-identity.ts`,
  `routes-agent-bootstrap.ts`) call the identity hooks. Admin `AgentForm.tsx`
  stops showing `.ax/*.md` file names.

## 6. Memory rules → DB

- `@ax/memory` stores rules itself (e.g. via `storage:get/set`) instead of
  `workspace:read/apply` on `memory/system/rules.md`. `memory:rules:read/write`
  hook signatures are already storage-agnostic — internal change, no boundary
  review.
- No runner write path exists at all, so `RUNNER_IMMUTABLE_PATHS` and
  `MEMORY_RULES_PATH` go away.
- Purge on `agents:deleted`.
- Facts export: drop the git copy (`permanent/memory/facts/**`); the read-only
  `/memory` mount is the only file view. Deployments without memory exports have
  no file view of facts — recall still works. State this in the chart docs.

## 7. Uploads

Model (decided 2026-10-30, mirrors Claude.ai): uploads belong to their
conversation; keeping a file is deliberate.

- **Transcript stores the attachment ID**, not a path. Content blocks carry
  `{attachmentId, filename, mediaType}`. No sandbox layout in stored data
  (Invariant 1).
- **Download route** looks up by attachment ID and checks it belongs to the
  conversation (replaces the `.ax/uploads/<conv>/` prefix check,
  `attachments/src/handlers.ts` ~:367-440, `conversations/src/plugin.ts` ~:1792).
- **Runner materializes** the bound conversation's attachments at session start
  to `/tmp/uploads/<filename>`, flat. Name collisions get ` (2)`, ` (3)` before
  the extension. Keep the existing filename sanitizing, `..` refusal and
  confinement. Per-turn content translation (inline text, pass-through
  image/PDF) reads by attachment ID from the materialized copy.
- **Prompt line:** files shared in this chat are at `/tmp/uploads/…` and go away
  after this conversation; copy anything needed later into `/files`.
- Deleted: `.ax/uploads` key minting, governed-path upload re-rooting
  (`governed-paths.ts`, aisdk `policy-wrap.ts`), the old-key mapping.
- Old conversations with `.ax/uploads/...` blocks degrade to a text mention;
  their downloads stop working. Accepted (§10).

## 8. SDK transcript working copy

- Unchanged mechanism: the runner ships transcript lines to the host as they're
  written (`shipTranscriptDelta`); on resume `restoreTranscriptForResume`
  (`agent-runner-core/src/transcript-delta.ts:279`) fetches the whole transcript
  from the DB and writes it back for the SDK. The DB is the source of truth.
- Only the location changes: `/tmp/transcripts/` instead of
  `/agent/.claude/projects` via symlink. The symlink setup moves out of
  `git-workspace.ts` into a small non-git module; the readers
  (`jsonl-transcript-source.ts:19`, `turn-end-uuid.ts:174`) take a transcript
  directory instead of hard-coding `<workspaceRoot>/.claude/projects`.
- Non-conversation runs that rely on the `hasLocalTranscript` fallback
  (`run-runner.ts:1376`) don't resume across pods — same as today.

## 9. Other relocations

| Today | Target |
|---|---|
| `.ax/skill-reflection/last-run.json` | plain file `/files/.skill-reflection/last-run.json` (no security gate). Update the seeded routine prompt (`routines/src/reflection-prompt.ts:72,91`) via a `prompt_body` migration; bump `SKILL_REFLECTION_SEED_HASH`. |
| Ordinary work product under `/agent` | `/files` |
| `.claude/*`, root `CLAUDE.md` vetoes (`validator-skill` pre-apply) | deleted; replaced by tests in §11 |

## 10. Reset (no migration)

Decided 2026-10-30: plain reset; nobody is using ax yet.
- Existing agents: identity empty, `bootstrap = 'none'` (fallback identity line
  from `fallbackIdentityLine(displayName)`), memory rules empty.
- Delete host bare repos (`ws-*.git`) and `disk_quota` rows with
  `kind='workspace'`. Write the runbook step.
- Old conversations stay readable; uploads in them degrade (§7).

## 11. Security guards that replace the removed ones

- Test: `settingSources === ['user']` in the Claude SDK runner.
- Runner refuses to start if `CLAUDE_CONFIG_DIR` is unset or resolves inside
  `/files` (otherwise an agent-planted `/files/.claude/settings.json` would load
  as user settings — hooks run commands).
- Canary test: plant `/files/.ax/SOUL.md`, `/files/CLAUDE.md`,
  `/files/.claude/settings.json`, `/files/.mcp.json`; assert no effect on the
  prompt, SDK settings or MCP servers.
- `tool-artifact-publish` allowlist: `/memory` stays out of reach (it is a
  separate root; keep it that way, with a test).
- `delete_user.sh` stops bypassing `agents:deleted` (raw SQL today orphans the
  NFS share and would orphan identity rows).

## 12. Disk quota

- Quota moves from the git repo to `/files`. Metered, not write-enforced:
  Filestore has no per-directory quota and the sandbox writes NFS directly.
- New meter `sandbox:user-files-usage {agentId} → {bytes}`, registered by the
  sandbox providers that already own host-read (sandbox-k8s, sandbox-subprocess);
  run on the sweep and at turn end.
- Enforcement (decided 2026-10-30): being over quota does **not** block chatting,
  so a person can ask the agent to tidy up its own files. It blocks new uploads
  and artifacts (`blob:pre-put`) and shows a warning. The existing `chat:start`
  block is removed for this quota kind. Turn-granular, not write-granular.
- Raise the default limit (today 1 GiB, `disk-quota/src/config.ts`), since
  `/files` now holds clones and all work product. Exact value left to the builder.
- No delete action in the Files tab: that would be a host write path into an
  agent-writable tree (§3 anti-goals). Update `storage-full-copy.ts` and its test
  so the copy says to ask the agent to clean up.
- `disk-quota` switches its `workspace:deleted` subscriber to `agents:deleted`.
- Filestore capacity alert as the noisy-neighbour backstop. Decided 2026-10-29.
- Delete TASK-720 save-refused plumbing.

## 13. Ops

- **Pin the blob root first.** Blob root is derived from the workspace config
  (`presets/k8s/src/index.ts:783,1658`; gke-values `blob.fs.root: ""`); removing
  the workspace config would point prod at an empty `/var/lib/ax-next/blobs`.
  Set `AX_BLOB_FS_ROOT` explicitly. Keep the `ax-next-workspace` PVC (holds `blobs/`).
- **Filestore backups** added to `backups.sh` (enable/status/drill); today only
  the workspace PVC is snapshotted.
- Chart: remove git-server templates, its NetworkPolicy rules, auth secret,
  image value, host env vars.
- Host and runner share one image: each deploying PR follows "delete runner pods
  first" (README:443).

## 14. What gets removed

Packages: `workspace-git`, `workspace-git-core`, `workspace-git-server`,
`workspace-protocol`, `workspace-bundle-protocol`.

Code: ipc-core `workspace.materialize` / `commit-bundle` / `commit-notify` /
`export-baseline-bundle` / `workspace.read` handlers + `bundler/`; core
`workspace-apply-facade.ts`, `workspace-policy.ts`, `retired-routine-path.ts`;
runner `git-workspace.ts` (including `scaffoldWorkspaceGitignore` — nothing
writes a `.gitignore` anywhere after this), `commit-notify-resync.ts`, `governed-paths.ts`
re-rooting, `save-refused-notice.ts`, `commit-trace.ts`;
`flushWorkspaceBeforeCall` (no production tool sets it — `core/src/types.ts:67`,
`ipc-protocol/src/actions.ts:77`, `mcp-client`, both runners' host-tool
adapters, `run-runner.ts:736-777`); validator-skill and validator-identity
`workspace:pre-apply` subscribers; channel-web hard deps on
`workspace:apply/read/list` (`server/plugin.ts:174-183`) and the "Agent
workspace" section of the Files tab; `agents.workspaceRef`; test-harness
`workspace-contract.ts` / `mock-workspace.ts`; CLI `workspace-git` loading and
`retire-routine-files`.

Already dead, ignore: `agent-native-runner`, `tool-file-io(-impl)`,
`tool-bash(-impl)` (node_modules only).

## 15. What we give up

- All-or-nothing per-turn saves and in-sandbox rollback on veto. `/files`
  already saves live; no feature relies on atomic turn saves.
- Concurrent-session rebase/replay. Sessions of one agent already share
  `/files` live.
- Write-granular quota (§12).

## 16. Rollout (PR slicing from review)

1. Identity + onboarding to DB (§5), including the reset for identity.
2. Rules to DB; exporter volume-only; reflection marker moved (§6, §9).
3. Pin blob root; home required in chart/presets; kind NFS; Filestore backups;
   `/files` quota meter (§4, §12, §13).
4. Atomic removal of the git tier and uploads change (§7, §8, §11, §14) — one
   PR, since removing only the runner side leaves dead host handlers.
5. Chart/ops cleanup and reset runbook (§10, §13).
6. `(walk)` card on kind: bootstrap, identity edit, rules, Files tab, uploads,
   resume, quota.

## 17. Left to the builder

- Exact hook/tool names and table shapes.
- `/tmp` emptyDir size limit now that it holds venvs, caches, uploads, transcripts.
- Whether old transcripts that contain `Write .ax/SOUL.md` get a deny-with-hint
  pointing at `update_identity`.
- How the local CLI sandbox maps the layout (no mount namespace; `/memory`
  absent there today).
