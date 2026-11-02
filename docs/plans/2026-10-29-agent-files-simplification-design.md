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
- Identity, onboarding state and Instructions (memory rules merged with
  `AGENTS.md`, §6) become DB rows written through hooks, validated at write time.
- One obvious answer to "where does X live?" for the agent and for us.
- A brand-new agent's `/files` is empty: nothing the platform runs writes into
  it. Only the agent's own work (and people, via the agent) puts files there.

Non-goals
- File history / versioning / undo for `/files` (git never provided it to users).
- Version history for DB-backed, hook-written content (identity, Instructions).
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
- **As built (TASK-995):** `/tmp` is the scratch root, a disk `emptyDir` capped at
  10Gi. The runner reads it from `AX_EPHEMERAL_ROOT` (the host sets it from
  `POD_SCRATCH_ROOT`) and refuses to boot without it, or without
  `AX_USERFILES_ROOT`. `/agent`, `/ephemeral` and `.ax/` no longer exist anywhere.
- **As built (TASK-1014):** Files-tab downloads stream through the host-internal
  hook `sandbox:read-user-file-range`: one 1 MiB range per call, the path re-walked
  with `O_NOFOLLOW` each time, an opaque `version` checked on every range, one
  final validation call, and the last chunk held until it passes, so a file that
  changes mid-download aborts instead of arriving as a torn 200. Ceiling 1 GiB
  (413 above). Responses carry `Cache-Control: private, no-store`. k8s serves
  downloads from the read-only host mount only (`sandbox.filestore.hostReadPath`;
  unset means 503, never a pod per range). Previews stay capped at 1 MiB.
- **As built (TASK-1016):** a download whose client stops reading is cut after
  60 s without progress (`bodyStream()`'s idle window, `client-stalled`). What
  fails before the head is answered: a short first range, or a one-range file
  failing its final check, is 409 `file-changed` (404 if gone). `http:response-sent`
  carries `incomplete: true` for a cut-off body, including a client that leaves
  during the final flush (that chunk's write is checked on its own), so a torn
  download is not recorded as a complete 200. The one blind spot is TCP's: bytes
  the OS accepted for a client that never reads them count as sent. Browser
  stream-to-disk and HTTP `Range` stay deferred.

## 5. Identity, Instructions and onboarding → DB

Owner: `@ax/agents` (Invariant 4).

Storage
- Identity sections: `identity`, `soul` (the agent describing itself), text, per
  agent, plus `instructions` (people's standing instructions, §6), with a
  monotonically increasing `revision` covering all three.
- No version history is stored (decided 2026-10-30; see §3 non-goals). `revision`
  is only a change counter used for the prompt refresh below.
- Onboarding state: `bootstrap: 'none' | 'pending' | 'done'`, set inside the
  `agents:create` transaction. Only the conversational "create an agent by
  talking to it" path creates `pending`; onboarding's Default Agent and
  admin-created agents get `none`.

Service hooks (names indicative; boundary review in the PR)
- `agents:identity:get {agentId} → {identity, soul, instructions, bootstrap, revision}`
- `agents:identity:set {agentId, patch, expectedRevision}` — calls the scan hook,
  fails closed; on success fires `system-prompt:augment-changed` so live
  sessions pick up the change (the mechanism memory rules use today).
- `agents:identity:complete-bootstrap {agentId}` — requires non-empty identity
  and soul; compare-and-set `pending → done`; second caller gets "already done".
- `identity:scan` registered by `@ax/validator-identity` (precedent:
  `skills:scan`). Reuse `regexScan` + UTF-8 check + the 256 KiB cap. The
  bootstrap-window logic and canonical-BOOTSTRAP-bytes check are deleted.
- Boundary review notes from review: alternate impl = a team-level profile
  service; avoid leaky names (`path`, `.ax`, `AGENTS.md`, git `version`/`parent`).

Agent-facing tools (host-executed)
- `update_identity({section: 'identity'|'soul', content})` plus
  an optional `{old, new}` edit form. Returns the saved text and says "applies
  from your next message".
- `complete_bootstrap()` — offered only while `bootstrap = 'pending'`.
- Both are system tools: they bypass the per-agent `allowedTools` filter
  (`run-runner.ts:703-706`), otherwise allowlisted agents can never finish
  bootstrap.
- **`update_identity` is not offered in unattended runs** (routine- or
  task-sourced sessions with no person present). Decided 2026-10-29.
- **As built (TASK-989):** the tools pass both filters through the
  orchestrator's session-open union, and are hidden from wildcard catalogs via
  `disallowedTools`. Bootstrap mode also adds a host-authored "Saved so far:
  your identity (yes|not yet), your soul (yes|not yet)" line (never the saved
  text).
- When the agent changes its own identity, the host (not the model) records an
  entry in the agent's activity, shown on Today to the agent's owner (decided
  2026-10-30). It says which section changed. No Undo: the owner fixes the text
  in the identity editor like any other edit. Writes made by a person through
  the editor don't create an entry.
- **As built (TASK-990):** there is no activity feed to add to (TASK-972 retired
  it). The entry is a per-section "last changed by the agent" time on the
  agent's identity row, written in the same transaction as the text, only for
  `update_identity` saves (`author: 'agent'` on `agents:identity:set`), and not
  during first-run setup. Today reads `agents:identity:self-changes-for-user`
  through `GET /api/workspace/self-changes`: the owner's personal agents, last 7
  days, newest change per section, worded by the host ("changed its
  personality", "changed how it describes itself"), and never counted as
  waiting on you. Team agents are left out until the team role model exists.
  The §16.6 walk should check that an agent's soul change shows on Today and a
  person's edit doesn't.

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
- **As built (TASK-989):** refresh = `system-prompt:augment-changed` plus the
  TASK-612 generation. `revision` is the write CAS counter and is not on the
  wire. `complete_bootstrap` is offered only in bootstrap mode.
- **As built (TASK-989), team agents:** `update_identity` is offered to team
  agents too. The admin identity editor still refuses team agents (TASK-465:
  a *person* changing a shared agent's persona should need a team role, which
  doesn't exist yet). The agent evolving itself is a different act, and §5
  intends it. It's also what team agents could already do before this change:
  the old `workspace:pre-apply` gate allowed `.ax/IDENTITY.md`, `SOUL.md` and
  even `AGENTS.md` writes with no owner-type check. This change narrows that,
  because the agent can no longer touch Instructions. The gate stays out of
  `agents:identity:set`, because team members legitimately save team
  Instructions through that hook. Revisit together with the team role model.
- Templates: rewrite `BOOTSTRAP_TEMPLATE` to use `update_identity` +
  `complete_bootstrap`; delete `bootstrapPathNote`; rewrite
  `identityEvolutionNote` (it currently says "use Write … committed
  automatically").

UI
- Identity editor and bootstrap routes (`routes-agent-identity.ts`,
  `routes-agent-bootstrap.ts`) call the identity hooks. Admin `AgentForm.tsx`
  stops showing `.ax/*.md` file names and loses its "advanced operating
  instructions" field (§6).

## 6. Instructions: memory rules + `AGENTS.md` merged (decided 2026-10-30)

Today two places hold people's standing instructions: memory rules (settings
page "Instructions", `@ax/memory`, people-only) and `AGENTS.md` (admin form
"advanced operating instructions", agent-writable). Same concept, two sources of
truth (Invariant 4). They merge into one **Instructions** field:

- Stored by `@ax/agents` as the `instructions` section (§5). Always on — no
  longer depends on a memory option.
- **People only.** Written through `agents:identity:set` from the settings page;
  `update_identity` cannot touch it, so the agent can never rewrite its own
  standing instructions. What the agent learns goes to facts and skills.
- **As built (TASK-989):** today's rules had no content scan; Instructions are
  now scanned like every other section.
- Same 16,384-character cap and scan as today's rules; same edit permissions as
  today's settings-page Instructions section.
- Prompt: one section, "Instructions from your people", after the defaults,
  overriding them, never trimmed. Replaces both the `AGENTS.md` override layer
  and the `## Rules From Your User` memory block section.
- One editor: the settings page Instructions section (`AgentInstructions.tsx`).
  The admin form's operating-instructions field goes away.
- `@ax/memory` loses rules entirely: `memory:rules:read/write`, its rules
  augment rendering and its `rules` option are deleted. `RUNNER_IMMUTABLE_PATHS`
  and `MEMORY_RULES_PATH` go away. `@ax/memory` keeps facts only.

## 6a. Facts export

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
- **As built (TASK-995):** the design above was refined into IDs. Uploads and
  artifact chips share one ID-based attachment block, so a chip renders from the
  stored block and a download is by ID (ownership and content-hash checked). The
  runner copies each upload into `<scratch>/uploads/` for the model; the copy is
  not the record. Legacy text-mention turns still render as plain text. The
  path-mention reconstruction in `conversations:get` is deleted, and a client can
  no longer send an attachment block of its own (the host builds them).
- **As built (TASK-1012):** a file the agent creates in `/files` is attached as an
  `agent_file` reference by its key there and downloaded live from `/files` (§12);
  uploads and explicitly published artifacts keep the ID-based block.

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
| `.ax/skill-reflection/last-run.json` | **Deleted — no marker** (decided 2026-10-30). The routines plugin already records every fire in the DB (`routines:recent-fires`); when the skill-reflection routine fires, the host puts the date of the last completed pass (or "never") into the prompt from those records. The agent writes nothing. Update the seeded prompt (`routines/src/reflection-prompt.ts:72,91`: Step 1 reads the date from the prompt; Step 4 no longer writes a file) via a `prompt_body` migration; bump `SKILL_REFLECTION_SEED_HASH`. |
| Ordinary work product under `/agent` | `/files` |
| `.claude/*`, root `CLAUDE.md` vetoes (`validator-skill` pre-apply) | deleted; replaced by tests in §11 |

## 10. Reset (no migration)

Decided 2026-10-30: plain reset; nobody is using ax yet.
- Existing agents: identity empty, `bootstrap = 'none'` (fallback identity line
  from `fallbackIdentityLine(displayName)`), Instructions empty.
- Delete host bare repos (`ws-*.git`) and `disk_quota` rows with
  `kind='workspace'`. Write the runbook step.
- Old conversations stay readable; uploads in them degrade (§7).

## 11. Security guards that replace the removed ones

- Test: `settingSources === ['user']` in the Claude SDK runner.
- Runner refuses to start if `CLAUDE_CONFIG_DIR` is unset or resolves inside
  `/files` (otherwise an agent-planted `/files/.claude/settings.json` would load
  as user settings — hooks run commands).
- Test: after a brand-new agent's first chat, its `/files` is empty. In
  particular the SDK's side files (`.claude.json`, `backups/`, `projects/`,
  `sessions/`) already land in `CLAUDE_CONFIG_DIR` whenever it is set (measured
  2026-10-30, SDK 0.2.119), and the runner refuses to start without it, so they
  never reach `/files`. The one exception is the MCP-log cache, which follows
  `XDG_CACHE_HOME` on Linux but uses `HOME/Library/Caches` on macOS (local CLI
  only). Tool caches/venvs go to `/tmp`.
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
- **As built (TASK-993):** `sandbox:user-files-usage` is answered by
  `@ax/user-files-read`'s `measureConfinedUserFiles` (allocated bytes; every
  folder opened through its held parent descriptor with `O_NOFOLLOW`; bounded
  by entries, depth and time, a bounded reading logged as partial). k8s
  measures only through the read-only host mount (`hostReadPath`) and throws
  `user-files-usage-unavailable` without it. `@ax/disk-quota` measures after
  each assistant `chat:turn-end` and on its sweep, into a new ledger kind
  `agent-files` (`agent-files:<agentId>`) charged to the agent's owner and
  folded into "Agent files". Default limit is now 10 GiB. A missing mount, a
  missing export or an unreadable home is an error; an agent folder that does
  not exist yet (no session yet) is 0.
- **As built (TASK-993):** `storage-full-copy.ts` was already dead (no caller
  since TASK-989) and is deleted; the live copy is channel-web's
  `lib/storage-copy.ts` and disk-quota's `blobFullMessage`, both now pointing at
  the agent and an admin. `agents:deleted` drops the `agent-files` row; the git
  `workspace:deleted` subscriber stays until TASK-995 (git removal), as does the
  TASK-720 plumbing.
- **As built (TASK-993):** the Filestore capacity alert is documented in
  `deploy/GKE.md` ("Alert before the user-files share fills up"); alerting is
  not managed in this repo.
- **As built (TASK-995):** the `workspace:deleted` subscriber and the TASK-720
  plumbing are gone. `@ax/disk-quota` deletes any leftover `workspace` ledger rows
  at boot, so the old git-era bytes stop counting.
- **As built (TASK-1012):** auto-attach no longer copies new `/files` files into
  chat blobs. The chip is an `agent_file { path, mediaType, sizeBytes }` block,
  `path` being the key the Files tab lists the file by. A name the Files tab
  cannot address gets a text note instead of a chip. The chip downloads through
  `GET /api/workspace/conversations/:id/download/user-files/*`, live from the
  file itself. Its ACL is two checks, both before the key is read: the
  conversation is the caller's own (404 `file-not-found` otherwise), and the
  caller can still reach the conversation's agent (404 `agent-not-found`
  otherwise). The agent always comes from the conversation, never from the
  block or the URL. The bytes are the Files tab's streamed download
  (`sendUserFileDownload`, TASK-1014), so its answers carry over: 404
  `file-not-found` when the file is gone (or is now a link), 400 `not-a-file`
  when the key is now a folder (the chip says "no longer available" for both),
  503 when storage will not answer, 409 `file-changed` when it changed before
  the first byte, 413 over 1 GiB. A malformed key is a 400
  `invalid-path`. Such a file is charged once (Agent files), and deleting it
  lowers usage at the next assistant turn end. Explicit `artifact_publish` and
  uploads are unchanged. Files auto-attached before this change keep their blob
  and its charge (no migration: their artifact rows live until the agent is
  deleted).
- **As built (TASK-1017):** (The held-approval half of this bullet never ran in any shipped configuration and was deleted in TASK-1021; see below. The rest, from the invalid stored `agent_file` block onward, is live.) Approving a held auto-attach closes the common path
  to a blob copy. The runner remembers the holds it raised itself. When the
  approval reaches the session that raised it, the runner re-sends the
  identical call to the gate as it pulls the answer, ahead of the turn that
  answer opens, and an `allow` attaches the same `agent_file` reference: no
  blob, charged once. The model reads a fixed "that is handled for you" note
  instead of the host's "make that call again". This narrows the window; it
  does not close it. The standing approval exists from the moment the person
  says yes, so a model that happens to make the identical explicit
  `artifact_publish` before the runner pulls the answer still spends it on a
  blob copy: during the decisions undo window (the answer is held back that
  long before delivery), or during a turn already running on the aisdk loop,
  which pulls only between turns. An approved chip whose continuation turn
  throws out of the loop is never delivered; the runner logs
  `could not attach a generated file (undelivered)` once per chip, and the
  file stays in the Files tab. Accepted residual: a cold session (the hold was
  raised by an earlier session) still attaches nothing on approval. A stored
  `agent_file` block that fails today's key rule reads as "<name> (this file is no longer available)" and its
  turn stays. Chips check whether their file still exists through
  `GET /api/workspace/conversations/:id/status/user-files/*` (a length-0 range
  read: no bytes, no pod) when they appear and after each turn, so a deleted
  file says "No longer available" before anyone clicks. `workspaceFilePath`
  keeps refusing `:`.
- **As built (TASK-1019):** the automatic-attach gate can only allow or fail
  closed in every shipped configuration. `@ax/tool-policy`'s
  `artifacts.publish` rule is `allow`. Publishing is not one of the abilities a
  person can switch (`ABILITY_TOOLS`: `web_search`, `web_extract`, `Bash`), and
  production always loads the built-in rule table. So the TASK-1017
  held-approval path, and its cold-session residual, were dormant (deleted in
  TASK-1021, below). The rule and the "not an ability" fact are both pinned in
  `@ax/tool-policy`'s `verdicts.test.ts`. A denied automatic attach
  is a gate that failed closed. Its note said "Ask the agent to attach them
  again", which leads to an explicit `artifact_publish` and so a blob copy
  (changed in TASK-1021, below). Chips now also recheck their file after a turn that fails, which
  re-reads nothing.
- **As built (TASK-1021):** the dormant held path is gone. Publishing stays a
  fixed `allow`, not a setting (Vinay, 2026-11-01). The runner no longer
  remembers its own holds: `resolveHeld`, `undelivered()`, the held note, the
  approved/declined model notes and the `undelivered` log line were deleted
  with their tests. A held automatic attach, if a rule ever produced one, is
  refused like any other: no chip, the Files-tab note, and an answer to it
  opens a turn with the host's note. So a hold on `artifact_publish` needs a
  held path built first; the `verdicts.test.ts` tripwire says so and points at
  TASK-1019's recorded design. The `denied` / `unavailable` paths are not part
  of the held path and stay: `unavailable` is no usable verdict reaching the
  runner, `denied` the host answering no (in production only when its own gate
  fails closed, since no rule denies `artifact_publish`). No note asks for files to be attached or published again: the person
  reads these notes, and asking the agent to attach a file again makes it call
  `artifact_publish`, a blob copy charged twice. A refused file reads "Some new
  files could not be attached here. Look for them in the Files tab." and a
  failed scan reads "We could not check for new files to attach. Look in the
  Files tab for anything the agent saved." Neither promises the file is there
  (a refusal can race a delete; a failed scan may mean the home is gone).

## 13. Ops

- **Pin the blob root first.** Blob root is derived from the workspace config
  (`presets/k8s/src/index.ts:783,1658`; gke-values `blob.fs.root: ""`); removing
  the workspace config would point prod at an empty `/var/lib/ax-next/blobs`.
  Set `AX_BLOB_FS_ROOT` explicitly. Keep the `ax-next-workspace` PVC (holds `blobs/`).
- **Filestore backups** added to `backups.sh` (enable/status/drill); today only
  the two host disks (workspace and facts) are snapshotted. Filestore backups
  were deferred on 2026-10-30 to a separate card (Basic-tier Filestore has no
  backup schedule, so the mechanism is its own decision).
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

- **As built (TASK-995):** all of the above is deleted, plus the `workspace:*`
  hooks, the commit-notify and materialize IPC actions, governed paths and the
  `conversations` `workspace_ref` column and drain-save-refusals hook.
  `commit-trace` is **kept**: it also traces the turn-end transcript ship, which is
  not a git thing.

Already dead, ignore: `agent-native-runner`, `tool-file-io(-impl)`,
`tool-bash(-impl)` (node_modules only).

## 15. What we give up

- All-or-nothing per-turn saves and in-sandbox rollback on veto. `/files`
  already saves live; no feature relies on atomic turn saves.
- Concurrent-session rebase/replay. Sessions of one agent already share
  `/files` live.
- Write-granular quota (§12).

## 16. Rollout (PR slicing from review)

1. Identity, Instructions + onboarding to DB (§5, §6), including the reset.
2. Exporter volume-only; reflection marker replaced by host-supplied last-pass date (§6a, §9).
3. Pin blob root; home required in chart/presets; kind NFS; Filestore backups;
   `/files` quota meter (§4, §12, §13).
4. Atomic removal of the git tier and uploads change (§7, §8, §11, §14) — one
   PR, since removing only the runner side leaves dead host handlers.
5. Chart/ops cleanup and reset runbook (§10, §13).
6. `(walk)` card on kind: bootstrap, identity edit, Instructions, Files tab, uploads,
   resume, quota.

## 17. Left to the builder

- Exact hook/tool names and table shapes.
- `/tmp` emptyDir size limit now that it holds venvs, caches, uploads, transcripts.
- Whether old transcripts that contain `Write .ax/SOUL.md` get a deny-with-hint
  pointing at `update_identity`.
  - **As built (TASK-989):** no deny-with-hint for `Write .ax/SOUL.md`; the
    removal card deletes that tier.
  - **As built (TASK-995):** the `/tmp` limit is 10Gi. Still no deny-with-hint.
- How the local CLI sandbox maps the layout (no mount namespace; `/memory`
  absent there today).
