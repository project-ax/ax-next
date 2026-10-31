# TASK-995 — Agent files: remove the git workspace tier, `.ax/` and `/agent` (atomic) + uploads to `/tmp/uploads` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the git workspace tier end to end — five packages, every `workspace:*` hook, five IPC actions, the runner's git/commit/governed-path machinery, the save-refused pipeline and `workspaceRef` — and move uploads to a flat `<scratch>/uploads/` directory (k8s: `/tmp/uploads/`), addressed by attachment ID. All of it ships in ONE PR, and the §11 guards stay green.

**Architecture:** Every stored or wire `attachment` content block becomes `{type, attachmentId, filename, mediaType, sizeBytes}`. That covers uploads AND agent-published artifact chips. The host serves bytes by ID after two checks: the requester owns the conversation, and the row belongs to that conversation. The runner materializes the bound conversation's uploads at session start, plus any new upload at later turns. It writes them flat into `<scratch>/uploads/`, with ` (2)` collision names, and translates each turn's blocks by ID from those copies, after checking each copy's hash. The k8s sandbox keeps `/files` (home), `/memory` (RO), `/tmp` (disk emptyDir, now also the scratch root, 10Gi cap) and `/home/runner` (tmpfs, `CLAUDE_CONFIG_DIR`). `/agent` and `/ephemeral` are gone. Consumers are removed before providers: runner → host IPC → host plugins → presets/CLI → packages.

**Tech Stack:** TypeScript (tsc project references), vitest, zod 3, kysely + Postgres (testcontainers; needs `DOCKER_HOST`), pnpm workspaces, Helm chart tests (`@ax/chart-tests`, the env-shape suite only).

**Spec:** `docs/plans/2026-10-29-agent-files-simplification-design.md` (§3, §4, §7, §8, §9, §10, §11, §12, §14, §15, §16 slice 4, §17). Card: TASK-995 body, including its "Predecessor learnings". Decisions: `.claude/memory/decisions/2026-10-31-TASK-995.md`. Every "why" below is logged there.

---

## How to run this plan

- **Order matters. Remove consumers before providers.** Tasks 1–3 change the attachment contract, then 4–6 the runner and sandboxes. 7–10 remove host consumers and the IPC. 11–12 unwire and delete providers. 13 adds the acceptance tests, 14 the prose, 15 the gate.
- **Known red windows:**
  - Between Tasks 1 and 3, `@ax/channel-web` and the runners don't typecheck. They read the old block shape.
  - Between Tasks 4 and 5, `@ax/agent-claude-sdk-runner` and `@ax/agent-aisdk-runner` are red: runner-core's exports changed.
  - `@ax/preset-k8s`'s `acceptance.test.ts` is red from Task 1 until Task 13. It holds the upload/artifact canaries, which Task 13 rewrites.
  - Everywhere else, the tree builds at task boundaries.
  - Run each task's own verification commands. Run the full repo only in Task 15 (the account spend limit has been hit once; be frugal).
- **Build before cross-package tests.** Workspace packages resolve each other through `dist/`. After changing a package that another package's tests import, run `pnpm build` (or `pnpm --filter <pkg> exec tsc --build`) first. Runner tests load runner-core from `dist` (TASK-994 learning).
- **Filter goes before the script:** `pnpm --filter @ax/<pkg> test`, never `pnpm test --filter`.
- **Docker-backed suites** (`@ax/attachments`, `@ax/conversations`, `@ax/agents`, `@ax/disk-quota`, the preset canaries) need an explicit `DOCKER_HOST`. If local Docker is down, say so in the handoff and let CI run them. Never skip silently.
- **Dependency edits are deferred.** All `package.json` and `tsconfig.json` dependency/reference removals happen in **Task 12**, followed by ONE `pnpm install` (not frozen) and a lockfile commit. Earlier tasks only stop importing.
- **Fix stale comments in every file you edit.** If a comment you touch names `/agent`, `.ax/`, git, commits, bundles, governed paths or `/ephemeral`, fix it in the same task. Task 14 covers only the files no code task touches.

---

## 0. Brainstorm, self-answered (the questions a human would have been asked)

1. **What is "the git tier", concretely?** It is several connected pieces:
   - The runner materializes `/agent` from a host bundle (`workspace.materialize` → `git-workspace.ts`), commits and bundles every turn, and sends the bundle up (`workspace.commit-bundle`).
   - On the host, ipc-core verifies the bundle (`bundler/`) and fires `workspace:pre-apply`. The subscribers are validator-skill, validator-identity and disk-quota. ipc-core then applies the bundle through `workspace:apply-bundle` (`@ax/workspace-git` / `-server`) and fires `workspace:applied`.
   - Around this sit the governed-path re-rooting, the save-refused notices, the host-tool flush and the channel-web "Agent workspace" file browser.
   - Nothing in production calls `workspace:apply` any more (TASK-989/991).
2. **Do `workspace-localdir` / `workspace-filestore` serve the git tier?** No. Each registers only `sandbox:resolve-mounts`, the `/files` mount resolver (localdir `plugin.ts:49-57`, filestore `:50-58`). Both stay; their names are legacy. The CLI keeps localdir unchanged (TASK-992: home `<dirname(sqlite)>/ax-next-userfiles/cli-agent`).
3. **How does the runner get upload bytes today, and after this change?** The same hooks, with a new shape. It calls IPC `attachments.list` (ipc-core `handlers/attachments-list.ts`, which calls `attachments:list-for-conversation`), then `blob.get` (`callBinary`, which calls `blob:get`). No hook or action is added; the list entries change shape (§5).
4. **Where are attachment blocks stored?**
   - User turns are stored STRUCTURALLY in `conversations_v1_events`, via the orchestrator's `persistUserDisplayTurn` (`orchestrator.ts:4942-4974`).
   - The runner's text mention exists only in the SDK resume rows (`conversations_v1_transcripts`). So `reconstructAttachmentBlocks` (`conversations/src/plugin.ts:1788-1845`) is effectively dead.
   - The same `AttachmentBlockSchema` also carries **artifact chips** in tool turns (`agent-runner-core/src/generated-files.ts:36-66`), downloaded through the same `GET /api/files?path=` route.
5. **What happens to old turns if the block schema changes?** `getConversation` skips a turn whole when any block fails `ContentBlockSchema` (`conversations/src/plugin.ts:1672-1676`). So old turns, their text included, would vanish. A legacy shim must turn path-shaped blocks into text before validation.
6. **Is `/tmp` already an emptyDir?** Yes:
   - `tmp: emptyDir {}`, on disk with no limit (`sandbox-k8s/src/pod-spec.ts:1015`, mounted `:927`). `/agent` (`:1022`, `:941`) and `/ephemeral` (`:1023`, `:942`) are separate emptyDirs.
   - No pod emptyDir has a `sizeLimit`, and the pod spec is TypeScript, so the §17 limit is in scope (Task 6). The chart is not involved.
7. **Is the `/ephemeral` → `/tmp` merge just a value change?** Mostly. Three things have to move together:
   - The runner reads `AX_EPHEMERAL_ROOT`.
   - The warm-pool bootstrap allowlist pins it to `/ephemeral` (`sandbox-protocol/src/bootstrap.ts:21-30`).
   - The standby hardcodes `/ephemeral` (`agent-runner-core/src/standby.ts:24`).
   `buildToolCacheEnv` already derives from that root, so it lands in `/tmp` with no code change.
8. **What does the runner use for HOME/cwd today?**
   - `runnerHomeDir(env) = userFilesRoot ?? ephemeralRoot ?? workspaceRoot` (`agent-runner-core/src/env.ts:104-106`). `AX_WORKSPACE_ROOT` defaults to `/agent` (`:175`), and `AX_USERFILES_ROOT` / `AX_EPHEMERAL_ROOT` are optional.
   - The SDK subprocess gets `HOME = cwd = runnerHomeDir` (`agent-claude-sdk-runner/src/main.ts:436,478`). Both providers stamp `HOME=/home/runner` and `CLAUDE_CONFIG_DIR` (`pod-spec.ts:641-642`).
   - After this change the home must be `/files`, with no fallback.
9. **Does anything else boot-require a `workspace:*` producer?** Yes. These fail boot once the providers go (`core/src/bootstrap.ts:345-353`):
   - ipc-core's REQUIRED `workspace:read` (`ipc-core/src/dependencies.ts:77-82`), copied into the `@ax/ipc-http` and `@ax/ipc-server` manifests;
   - channel-web's hard `workspace:read` + `workspace:list` (`channel-web/src/server/plugin.ts:167,172`).
10. **Will the chart (out of scope) break?** Only one chart *test* breaks:
    - `deploy/charts/ax-next/__tests__/env-shape.test.ts` fails on any host env the k8s loader doesn't read (`:262-269`). The chart stamps `AX_WORKSPACE_ROOT`/`_BACKEND`/`_GIT_SERVER_URL`/`_GIT_SERVER_TOKEN` (`templates/host/deployment.yaml:259-282`).
    - Task 11 adds those four to its `EXTERNAL_READERS` allowlist. That is a test-file edit; no template changes.
    - CI's helm lane runs this suite on `presets/k8s/` changes.
11. **What does the local CLI look like after this change?** It loses `@ax/workspace-git` and `ax retire-routine-files`, and keeps `@ax/workspace-localdir`:
    - Every CLI session is owned (`cli-agent`), so `AX_USERFILES_ROOT` is always stamped.
    - The subprocess sandbox's per-session `ephemeral` dir is the scratch root (no mount namespace, so not literally `/tmp`).
    - The runner process still runs with `cwd = ctx.workspace.rootPath` (the user's cwd). It no longer reads that path for anything.
12. **Deny-with-hint for `Write .ax/SOUL.md` (§17)?** **No** (decision, logged). TASK-989 already chose none. Such a write now lands as an inert file in `/files`, which the §11 canary proves has no effect. The prompt teaches `update_identity`. Re-adding path matching would rebuild the re-rooting this card deletes.

## 1. Card and brief claims checked against the code (report these in the PR)

| Claim | Finding | What the plan does |
|---|---|---|
| Delete `commit-trace.ts` | **Refuted.** `commitTrace` also traces the turn-end transcript ship (`run-runner.ts:1654,1694,1721,1990`; `agent-claude-sdk-runner/src/main.ts:1023-1029`). | Keep the module and `AX_COMMIT_TRACE`. Delete only the git call sites and rewrite its header (Task 4). |
| channel-web hard deps on `workspace:apply/read/list` (`server/plugin.ts ~:174-183`) | **Stale.** The hard calls are only `workspace:read` (:167) and `workspace:list` (:172). `:173-183` is `conversations:*`. | Task 8 removes those two. |
| `storage-full-refusal.ts` "where it serves only that" | **Already gone.** Deleted in TASK-989 (b9cc84a9a). `lib/storage-full.ts` is the 413 on sending an attachment and stays. | Nothing to do. |
| Uploads change = upload blocks only | **Incomplete.** `AttachmentBlockSchema` is shared with artifact chips (`generated-files.ts:36-66`), and both are downloaded by path. | One ID-based block for both. Artifact chips use `artifactId` (Tasks 1–3). |
| "Old `.ax/uploads` blocks degrade to a text mention" | **Needs code.** A schema change would DROP old turns entirely, text included (`conversations/src/plugin.ts:1672-1676`). | Task 1 adds a legacy shim before validation. |
| Download route check at `attachments/src/handlers.ts ~:367-440` | True, but more than a prefix check: the transcript path-scope scan (`:405-453`), the prefix fallback (`:410,:444-450`) and path→row (`:564-576`). | Replaced wholesale by lookup-by-ID plus a conversation check (Task 1). |
| "Remove `agents.workspaceRef`" | **Incomplete.** `@ax/conversations` freezes a copy (`conversations_v1_conversations.workspace_ref`, `validateWorkspaceRefForFreeze`). | Both are dropped (Task 9). |
| Save-refused "SSE/route fields" | **Wider than listed.** It also covers `conversations:drain-save-refusals` (hook), IPC `conversation.drain-save-refusals`, the `save_refused_drained_seq` column, the `save-refused` display-event kind, and `saveRefused` on `event.turn-end`/`event.chat-end`. | Removed end to end (Tasks 4, 8, 9, 10). |
| Nothing else boots on `workspace:*` | **Refuted.** ipc-core REQUIRES `workspace:read`; ipc-http/ipc-server copy it. | Task 10. |
| Chart cleanup is entirely the next card | **One test edit is needed now:** `env-shape.test.ts` (row 10 above). | Task 11 (test file only). |
| Runner home = `/files` "already" | True when `AX_USERFILES_ROOT` is set. Otherwise it **falls back to `ephemeralRoot` then `/agent`** (`env.ts:104-106`). With the scratch root at `/tmp` and no `/files`, the home would be `/tmp`, and the TASK-994 guard would refuse `/tmp/transcripts`. | `AX_USERFILES_ROOT` and `AX_EPHEMERAL_ROOT` become required (Task 4). |
| Hidden hard breaks the card didn't list | Each fails CI if missed:<ul><li>`scripts/memory-product-e2e.mjs:250-252` (preset slice set has `@ax/workspace-git`)</li><li>`scripts/__tests__/memory-cited-paths-exist.test.js` (needs `Deleted in TASK-995:` tombstones)</li><li>`test-harness/src/stub-runner.ts:50` (requires `AX_WORKSPACE_ROOT`)</li><li>the ipc-http/ipc-server tenant-isolation tests (probe `/workspace.read`)</li><li>`.github/workflows/ci.yml:443-453` (builds the git-server image)</li><li>`.changeset/*` frontmatter naming deleted packages</li></ul> | Tasks 6, 10, 12 and 14. |

## 2. Global Constraints

- One PR. No `workspace:*` hook, `workspace.*` IPC action, `conversations:drain-save-refusals`, `conversation.drain-save-refusals`, `saveRefused` field or `flushWorkspaceBeforeCall` may survive, as code or as a manifest entry (§3 anti-goal, Invariant 3).
- Stored and wire `attachment` blocks never carry a sandbox or workspace path (Invariant 1). Shape: `{ type: 'attachment', attachmentId, filename, mediaType, sizeBytes }`, `.strict()`.
- `attachmentId` matches `^[A-Za-z0-9_-]{1,128}$`. That accepts store-temp UUIDs and 16-hex artifact IDs. It is opaque: nothing parses it.
- Sandbox layout (k8s):
  - `/files` is HOME and cwd for the agent SDK subprocess only.
  - `/home/runner` (tmpfs) is the runner's HOME, and `CLAUDE_CONFIG_DIR=/home/runner/.ax/session` stays.
  - `/memory` is a read-only sibling mount; never nest it.
  - `/tmp` is a disk emptyDir with `sizeLimit: 10Gi`. It is `AX_EPHEMERAL_ROOT`, holding `uploads/`, `transcripts/`, caches, venvs and clones.
  - There is no `/agent` and no `/ephemeral`.
- `settingSources` stays `['user']`. The `CLAUDE_CONFIG_DIR` guard stays (refuse unset, relative, missing, or overlapping the home). Keep `prepareTranscriptDir` before the resume restore (#1085).
- git stays in the runner image. Keep the runner's git hardening/identity env and `safe.directory=*`, which agents now use for their own clones. Only comments change.
- Upload names: flat, basename only. Collisions take ` (2)`, ` (3)`… before the LAST extension dot (`report (2).pdf`; `notes` → `notes (2)`; `.bashrc` → `.bashrc (2)`). A name that is empty, `.` or `..` after sanitizing becomes `file`. Names are capped at 200 UTF-8 bytes. Create files with `COPYFILE_EXCL`: never overwrite, never follow.
- Prompt text must not contain `.ax`, `/agent`, `governed`, `committed`, `versioned` or `bundle`. It must say that `<home>` is home and cwd, and that shared files are at `<scratch>/uploads/` and go away after this conversation (copy anything needed later into `<home>`). Interpolate runtime roots; never hardcode `/tmp` or `/files` in runner prose.
- Migrations are forward-only and idempotent:
  - a dropped column is removed from its `CREATE TABLE`/`ADD COLUMN` statement AND gets an appended `DROP COLUMN IF EXISTS` (TASK-142 precedent, `agents/src/migrations.ts`);
  - CHECK values that existing rows use stay (`'save-refused'`, quota kind `'workspace'`).
- No chart template, values or NetworkPolicy edits (TASK-1003 and the chart/ops card own those). The only `deploy/` edit is `deploy/charts/ax-next/__tests__/env-shape.test.ts`. Do not edit `deploy/README.md` or `deploy/GKE.md` (ops card; `scripts/__tests__/kind-tooling-pinned-to-kind-context.test.js` counts README's kind blocks).
- UI: removal only, composed from existing shadcn primitives and semantic tokens (Invariant 6). Invoke the `shadcn` skill before editing `AgentFiles.tsx` / chips.

## 3. Review Focus (each has a test in its owning task)

1. **Hostile upload filenames.** Cases: `../../files/x`, `a/b`, `a\b`, `..`, `.`, control characters and newlines, a 300-byte name, and a name the agent already took with a file or a symlink. Expected: everything lands flat inside `<scratch>/uploads/`, and nothing is overwritten or followed (Task 3).
2. **Another conversation's attachment through the download route.** That includes another user's, and a forged chip in our own conversation pointing at a foreign ID. Expected: 404, with no bytes (Task 1 hook test, Task 2 route test).
3. **Old conversations.** A stored `{path,…}` upload block in a user turn, or an artifact chip in a tool turn. Expected: the turn still renders, its text survives, and the block reads `<name> (this file is no longer available)` (Task 1).
4. **Tampered uploads.** The agent rewrites `<scratch>/uploads/<file>`, or swaps it for a symlink, before a later turn's translation. Expected: the copy is never inlined or passed through as the person's content; the model gets a mention only (Task 3).
5. **Scratch merge.** `<scratch>/uploads/*` and `<scratch>/transcripts/*` now sit in the scratch root next to `artifacts/`. Expected: they stay unpublishable, directly and through a symlink placed in `<scratch>/artifacts/` (Task 3).

Also pinned:
- a client-sent `attachment` block is refused (Task 2);
- a fresh pod re-derives identical upload names (Task 3);
- a bootstrap assignment carrying `AX_WORKSPACE_ROOT` or `AX_EPHEMERAL_ROOT=/ephemeral` is refused (Task 6);
- a runner can only list its own bound conversation's attachments (Task 1).

## 4. Guards removed, and what replaces them (copy into the PR body)

| Guard deleted | Where today | Replacement / why nothing reads that surface any more |
|---|---|---|
| `workspace:pre-apply` veto of `.claude/settings.json`, `.claude/settings.local.json`, `.claude/CLAUDE.md`, root `CLAUDE.md`, `CLAUDE.local.md`, `.claude/{agents,commands,rules}/` | `validator-skill/src/plugin.ts:56-68,125-149` | Nothing loads those files from `/files`. Already landed in §11 (TASK-994), and must stay green:<ul><li>`settingSources: ['user']` (`agent-claude-sdk-runner/src/__tests__/main.test.ts`, 4 assertions)</li><li>`CLAUDE_CONFIG_DIR` required and outside the home (`agent-runner-core/src/config-dir-guard.ts` + tests)</li><li>the real-binary canary with live controls (`agent-files-guards-real-sdk.e2e.test.ts`)</li><li>the runner-level canary (`main.test.ts` `describe('agent files §11 guards')`)</li></ul> |
| validator-identity gate: `.ax/IDENTITY.md`/`SOUL.md`/`AGENTS.md` UTF-8 + injection scan; `.ax/BOOTSTRAP.md` canonical-bytes veto; bootstrap-window read via `workspace:read` | `validator-identity/src/plugin.ts:190-372` | Identity is DB rows written only through `agents:identity:set`, which calls `identity:scan` and fails closed (TASK-989; `identity:scan` stays). The prompt composes from session config. The §11 canary plants `/files/.ax/SOUL.md`, and it has no effect. |
| disk-quota `workspace:pre-apply` storage gate | `disk-quota/src/plugin.ts:269-273` | No git writes exist. `/files` is metered (`agent-files`), and `blob:pre-put` gates uploads and artifacts (TASK-993). |
| Bundle verification: `bundler/verify.ts` author/committer check, `walk.ts`, `filter.ts`/`filterToPolicy`, size caps, `assertNoRetiredRoutinePuts` | `ipc-core/src/bundler/*`, `handlers/workspace-commit-notify.ts`, `core/src/retired-routine-path.ts` | The runner→host bundle path is deleted, so no runner-supplied tree is applied to host state. What remains of the runner's write surface is unchanged and separately bounded: `blob.put` (size-capped, digest-verified), `artifact.publish`, the transcript append and `skill.propose`. |
| Governed-path re-rooting of `.ax/**`, `.claude/**`, `CLAUDE.md` (and the `.ax/uploads/` re-root) into `/agent` | `agent-runner-core/src/governed-paths.ts`, `tool-policy.ts:89-124`, `agent-claude-sdk-runner/src/pre-tool-use.ts`, `agent-aisdk-runner/src/tools/policy-wrap.ts` | Those writes now land as plain files in `/files`, visible in the Files tab, and nothing reads them (row 1). New test: tool policy passes `.ax/SOUL.md`, `.claude/settings.json` and `CLAUDE.md` through unchanged to `tool.pre-call` (Task 4). |
| Download path-scope: the transcript scan + `.ax/uploads/<conv>/` prefix fallback | `attachments/src/handlers.ts:354-453,484-603` | Lookup by attachment ID needs two things: the requester owns the conversation (`conversations:get`), AND the row's `conversation_id` equals it. Test: "refuses an attachment from another conversation" (Task 1). |
| Chip reconstruction gated on the `.ax/uploads/<thisConv>/` prefix | `conversations/src/plugin.ts:1788-1845` | Deleted. User turns are stored as structured blocks. Legacy blocks degrade to text, and the download check is the boundary (Task 1). |
| Upload confinement in the runner: `.ax/uploads/` prefix, segment refusal, text-only containment, wipe-then-write | `agent-runner-core/src/materialize-uploads.ts:85-148` | A basename-only sanitizer (`..`/`.`/empty → `file`), a containment check, and `COPYFILE_EXCL` (never overwrite or follow). The uploads dir must be a real directory, there is no wipe, and the hash is verified before anything is inlined (Task 3). |
| Runner home fallback to the scratch tier or `/agent` | `agent-runner-core/src/env.ts:104-106,175` | `AX_USERFILES_ROOT` + `AX_EPHEMERAL_ROOT` are required (missing → `MissingEnvError`, exit 2). The SDK subprocess gets HOME = cwd = `/files`; the runner keeps HOME `/home/runner` (Task 4). |
| `flushWorkspaceBeforeCall` precondition on host tools | both runners' host-tool adapters | No production tool set it, and there is no workspace to flush. |
| Bootstrap pin `AX_WORKSPACE_ROOT=/agent` | `sandbox-protocol/src/bootstrap.ts` | The name is removed, so the generic `AX_` rule refuses it. `AX_EPHEMERAL_ROOT` is pinned to `/tmp` (Task 6 test). |

## 5. Boundary review (copy into the PR body)

**Changed service-hook signatures** (all registered by `@ax/attachments`):
- `attachments:commit`:
  - input `{ attachmentId, conversationId }` (`turnId` dropped; it only built the path key);
  - output `{ attachmentId, filename, sha256, mediaType, sizeBytes }` (was `{ path, displayName, … }`).
- `attachments:download`: input `{ conversationId, attachmentId, userId }` (was `path`); output unchanged.
- `attachments:list-for-conversation`: entries `{ attachmentId, filename, sha256, mediaType, sizeBytes }`, oldest first (`created_at`, then `attachment_id`).
- IPC `attachments.list` response (`ipc-protocol/src/actions.ts`): the same entries.
- The `attachment` content block, which rides `chat:start`/`agent:invoke`/`conversations:get`/`event.turn-end`: `{ type, attachmentId, filename, mediaType, sizeBytes }`.

**Boundary review answers:**
- **Alternate impl:** an attachments backend that keeps bytes and metadata in an object store under its own opaque IDs. Or the `@ax/attachments-pg-bytea-only` variant named in `attachments/src/migrations.ts`.
- **Leaky field names:** `path` is removed; it leaked the sandbox/workspace layout. `sha256` is the file's own content digest, storage-agnostic (TASK-68), and is kept. No others.
- **Subscriber risk:** none. These are service hooks with one caller each (channel-web `routes-chat`/`routes-attachments`, ipc-core `attachments-list`). `attachmentId` is opaque: channel-web only passes it back to `/api/files`.
- **Wire surface:** the `attachments.list` response schema stays in `@ax/ipc-protocol`, where every IPC schema already lives. Moving it is out of scope.

**Removed (no review; list them in the PR):**
- Hooks: `workspace:apply`, `apply-internal`, `apply-bundle`, `read`, `list`, `diff`, `pre-apply`, `applied`, `deleted`, `usage`, `export-baseline-bundle`, and `conversations:drain-save-refusals`.
- IPC actions: `workspace.materialize`, `workspace.commit-bundle`, `workspace.commit-notify`, `workspace.export-baseline-bundle`, `workspace.read`, `conversation.drain-save-refusals`.
- Fields: `ToolDescriptor.flushWorkspaceBeforeCall`; `saveRefused` on `event.turn-end`/`event.chat-end`.

## 6. Data changes and deploy notes (copy into the PR body)

Migrations (all idempotent):
- `agents_v1_agents`: `DROP COLUMN IF EXISTS workspace_ref` (Task 9).
- `conversations_v1_conversations`: `DROP COLUMN IF EXISTS workspace_ref`, `DROP COLUMN IF EXISTS save_refused_drained_seq`. The `'save-refused'` event kind stays in the CHECK; old rows are kept and ignored (Task 9).
- `attachments_v1_files`: `DROP COLUMN IF EXISTS path`, which also drops `UNIQUE (conversation_id, path)` (Task 1). `attachments_v1_artifacts.path` stays, as the publish upsert key.
- `disk_quota_v1_usage`: `DELETE … WHERE kind = 'workspace'` on every boot. Nothing re-measures or releases those rows any more, and they would charge people forever. The CHECK keeps `'workspace'` (Task 7).

Deploy notes:
1. Ship in the same production deploy as #1085–#1090. None of them is deployed yet. Until TASK-995 lands, old workspaces keep a stale git copy of the facts export (#1088 learning).
2. **Take a database backup first.** The migrations drop columns.
3. Rollback before re-deploying the old image:
   - `ALTER TABLE agents_v1_agents ADD COLUMN IF NOT EXISTS workspace_ref TEXT;`
   - `ALTER TABLE conversations_v1_conversations ADD COLUMN IF NOT EXISTS workspace_ref TEXT, ADD COLUMN IF NOT EXISTS save_refused_drained_seq BIGINT;`
   - `ALTER TABLE attachments_v1_files ADD COLUMN IF NOT EXISTS path TEXT; CREATE UNIQUE INDEX IF NOT EXISTS attachments_v1_files_conv_path ON attachments_v1_files (conversation_id, path);`
   - Quota rows re-measure themselves under the old image.
4. **Delete runner pods first** (shared image), including the warm-pool standby pods.
5. **After the upgrade, delete the storage-helper pods.** The DaemonSet is `OnDelete`, and its bootstrap allowlist changed: `AX_EPHEMERAL_ROOT=/tmp`, and `AX_WORKSPACE_ROOT` is now refused. An old helper answers 409 and pooled sessions fail with `pod-create-failed` (TASK-994 context).
6. The first prod `--reuse-values` upgrade needs `--set blob.fs.root=/var/lib/ax-next/workspaces/blobs` (TASK-992, GKE.md §4d).
7. Until the chart/ops card, the chart still stamps `AX_WORKSPACE_*` on the host and runs the git-server StatefulSet (kind). The host ignores both. The §10 reset (delete `ws-*.git`) and the restore drill (`deploy/gke/restore-drill-verify.sh` expects `ws-*.git`) belong to that card.
8. Old conversations: upload and generated-file chips render as "… (this file is no longer available)", and their downloads stop (accepted, §10). A message queued across the deploy in the old block shape fails delivery once; resend it.

---

## 7. Tasks

### Task 1: Attachment blocks carry an ID; `@ax/attachments` stores and serves by ID; old blocks degrade [tier: sensitive] [security-checklist]

**Files:**
- Modify:
  - `packages/ipc-protocol/src/content-blocks.ts`: `AttachmentBlockSchema`, `AttachmentIdSchema`, `attachmentBlockFromArtifact`. Delete `parseAttachmentMention`, `ATTACHMENT_MENTION_RE`, and `isWorkspaceRelativePath` if it has no remaining caller. Fix the `AttachmentRefBlockSchema` doc.
  - `packages/ipc-protocol/src/actions.ts`: `AttachmentsListResponseSchema` and its comments `:30-37`, `:878-907`.
  - `packages/attachments/src/{types.ts,handlers.ts,store.ts,migrations.ts,plugin.ts}`.
  - `packages/ipc-core/src/handlers/attachments-list.ts`: new entry type and conversation binding.
  - `packages/conversations/src/plugin.ts`: delete `reconstructAttachmentBlocks` and its call at `:1625`; add the legacy shim in `projectEventTurns`.
- Delete: `packages/conversations/src/__tests__/get-reconstructs-attachments.test.ts`.
- Test:
  - `packages/ipc-protocol/src/__tests__/content-blocks.test.ts`
  - `packages/attachments/src/__tests__/{commit,download,contract,metadata-hooks,return-schemas}.test.ts`, plus a migration test (`migrations.test.ts`; create it if absent)
  - `packages/ipc-core/src/handlers/__tests__/attachments-list.test.ts`
  - a new `packages/conversations/src/__tests__/legacy-attachment-blocks.test.ts`

**Interfaces — Produces** (later tasks rely on these exact names):
- `AttachmentIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)` and `AttachmentBlock = { type: 'attachment'; attachmentId: string; filename: string; mediaType: string; sizeBytes: number }`, `.strict()`. `filename` has length 1..1024; `mediaType` has length 1..255.
- `attachmentBlockFromArtifact(value: unknown): AttachmentBlock | null`. It maps an `artifact_publish` result object `{ artifactId, displayName, mediaType, sizeBytes, … }` to `{ type:'attachment', attachmentId: artifactId, filename: displayName, mediaType, sizeBytes }`, or returns `null` if any field fails.
- `AttachmentsListResponseSchema = { files: Array<{ attachmentId, filename, sha256 /^[0-9a-f]{64}$/, mediaType, sizeBytes }> }`.
- The hook shapes in §5. Store methods: `insertFile`, `getFileById(id)`, `getArtifactById(id)`, and `listFilesForConversation(conversationId, userId)` ordered `created_at ASC, attachment_id ASC`.

- [ ] **Step 1: Write the failing tests.**
  - content-blocks:
    - `AttachmentBlockSchema` accepts `{type:'attachment', attachmentId:'3f1c…-uuid', filename:'a.pdf', mediaType:'application/pdf', sizeBytes:10}`;
    - it rejects the same block plus `path`;
    - it rejects the legacy `{type:'attachment', path:'.ax/uploads/c/t/x__a.pdf', displayName, mediaType, sizeBytes}`;
    - it rejects `attachmentId` values `'../x'`, `'a/b'`, `''` and 129 chars;
    - `attachmentBlockFromArtifact({artifactId:'0123456789abcdef', displayName:'r.pdf', mediaType:'application/pdf', sizeBytes:3, path:'r.pdf'})` returns the ID block, and it returns `null` for `{}`.
  - attachments, with Postgres via testcontainers:
    - `it('commit returns the attachment id and mints no path')`: the output deep-equals `{attachmentId: <temp id>, filename, sha256, mediaType, sizeBytes}` and has no `path` key.
    - `it('download serves an upload by id to the owner of its conversation')`.
    - `it('download serves an artifact by id')`.
    - `it('download refuses an attachment that belongs to another conversation')`: the row is in conversation B, the request names A (which the caller owns), and the call throws `not-found`.
    - `it('download refuses a conversation the caller does not own')`: throws `not-found`.
    - `it('list-for-conversation returns oldest first with id and filename')`.
    - `it('an attachments_v1_files table created with a path column upgrades: path is gone and old rows still read by id')`.
  - ipc-core attachments-list:
    - `it('lists only the session\'s bound conversation')`: with `ctx.conversationId='A'`, a request for `B` gets 403, and the hook is not called;
    - an entry with a bad `attachmentId` from the hook gives 500 (response re-check).
  - conversations (new test file):
    - `it('keeps an old turn whose upload block has a path, rendering it as text')`: append a user-turn event with blocks `[{type:'text',text:'see this'}, {type:'attachment', path:'.ax/uploads/c/t/x__a.pdf', displayName:'a.pdf', mediaType:'application/pdf', sizeBytes:10}]`. `getConversation` returns the turn with blocks `[{type:'text',text:'see this'},{type:'text',text:'a.pdf (this file is no longer available)'}]`.
    - the same for a tool-turn artifact block `{type:'attachment', path:'out/r.png', displayName:'r.png', …}`;
    - a legacy block with no usable `displayName` reads `A file (this file is no longer available)`.
- [ ] **Step 2: Run them and confirm they fail.** Run `pnpm --filter @ax/ipc-protocol test -- content-blocks`, `pnpm --filter @ax/attachments test`, `pnpm --filter @ax/ipc-core test -- attachments-list`, and `pnpm --filter @ax/conversations test -- legacy-attachment-blocks`. Expected: FAIL (new names missing, path minted, legacy turn dropped).
- [ ] **Step 3: Implement.**
  - **ipc-protocol:** the schema as above.
  - **attachments:**
    - `commit` inserts by `attachment_id` (`ON CONFLICT (attachment_id) DO NOTHING`) and returns the new output. Delete `sanitizeFilenameComponent` and the `.ax/uploads` key (`handlers.ts:151-201`).
    - `download`: `userId` must equal `ctx.userId`; then the `conversations:get` owner gate (existing); then `getFileById ?? getArtifactById`; then `row.conversationId === input.conversationId`, else `not-found`; then `blob:get`.
    - Delete `normalizePath`, `checkPathScope`, `getFileByPath`, `getArtifactByPath` and `upsertFile`, if no caller remains.
    - Migration: remove `path` and its `UNIQUE` from the `CREATE TABLE`, and append `ALTER TABLE attachments_v1_files DROP COLUMN IF EXISTS path`. Rewrite the header (`:105-121`): IDs, not paths.
  - **ipc-core handler:** refuse when `ctx.conversationId` is missing or `!== request.conversationId` (403 via `mapPluginError` with `forbidden`, logged). Update the stale header comment.
  - **conversations:**
    - `legacyAttachmentText(block)` returns `` `${name} (this file is no longer available)` ``. `name` is the block's `displayName` when it is a non-empty string ≤255 chars, else `A file`.
    - Apply it to any `type:'attachment'` block without a string `attachmentId`, BEFORE `validateContentBlocks`.
    - Delete `reconstructAttachmentBlocks`.
- [ ] **Step 4: Run the Step 2 commands.** Expected: PASS. `@ax/channel-web` and the runners are now expected to fail typecheck; Tasks 2–3 fix them.
- [ ] **Step 5: Commit.** `[TASK-995] Attachment blocks carry an ID; serve uploads and artifacts by ID; old blocks degrade to text`.

### Task 2: channel-web sends, renders and downloads attachments by ID [tier: sensitive] [security-checklist]

**Files:**
- Modify:
  - `packages/channel-web/src/server/routes-chat.ts` (`:540-600` commit loop, `:126`)
  - `packages/channel-web/src/server/routes-attachments.ts` (`:215-300`)
  - `packages/channel-web/src/server/routes-workspace.ts`: `turnAttachments` `:3805-3825`; artifact JSON dedup `:3991-4017`
  - `packages/channel-web/src/lib/workspace-types.ts` (`ThreadAttachment :640-645`)
  - `packages/channel-web/src/components/AttachmentChip.tsx` (URL `:66-68`; stale `ax://attachment-path` comment `:16-22`)
  - `packages/channel-web/src/components/workspace/GeneratedFileChip.tsx` (`:31-37`)
  - `packages/channel-web/src/components/workspace/AgentConversation.tsx` (`:1131-1147`)
  - `packages/channel-web/src/components/workspace/AgentView.tsx` (live frame `:1408-1422`)
- Test:
  - `src/__tests__/server/{routes-chat,routes-attachments,routes-workspace}.test.ts`
  - `src/__tests__/{attachment-chip,workspace-attachment-seam}.test.tsx`
  - `src/components/workspace/__tests__/{GeneratedFileChip,AgentConversationMarkdown,TaskCheckinPage}.test.tsx`

**Interfaces:**
- Consumes Task 1's `AttachmentBlock`, `attachmentBlockFromArtifact`, and the commit/download shapes.
- Produces `ThreadAttachment = { attachmentId: string | null; displayName: string; mediaType: string; sizeBytes?: number }`. `null` keeps today's meaning: "no download URL yet" (live frame).
- Download URL: `/api/files?conversationId=<c>&id=<attachmentId>`. The server reads lowercased keys `conversationid` and `id`.

- [ ] **Step 1: Write the failing tests.**
  - routes-chat:
    - `it('rewrites an attachment_ref into an id block')`: the stored and invoked block deep-equals `{type:'attachment', attachmentId, filename, mediaType, sizeBytes}`, and `attachments:commit` received `{attachmentId, conversationId}` with no `turnId`;
    - `it('refuses a client-sent attachment block with 400 and commits nothing')`.
  - routes-attachments:
    - `GET /api/files?conversationId=c&id=a` streams with `content-disposition: attachment` and `x-content-type-options: nosniff`;
    - a missing `id` gives 400;
    - a hook `not-found` or `forbidden` gives 404.
  - Chips: `AttachmentChip` and `GeneratedFileChip` build `/api/files?conversationId=…&id=…`, and neither builds a `path=` URL.
  - routes-workspace `buildThread`: artifact chips dedupe by `attachmentId`, and `ThreadAttachment.attachmentId` is set.
- [ ] **Step 2: Run and confirm they fail.** `pnpm build && pnpm --filter @ax/channel-web test -- routes-chat routes-attachments routes-workspace attachment-chip GeneratedFileChip workspace-attachment-seam`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Refuse any request block of `type:'attachment'` with 400 `{error:'invalid-content-block'}`, before any commit.
  - Map the `ThreadAttachment` fields (`displayName` ← block `filename`).
  - Before finishing, run `git grep -n -i 'attachment' -- packages/channel-web/src | grep -i path` and update every remaining client or server read of a block's `path`.
  - Keep the existing 25 MiB and 100 MiB caps and the error mapping.
  - Invoke the `shadcn` skill if any chip markup changes; expect only URL changes.
- [ ] **Step 4: Verify.** Run the Step 2 command and `pnpm --filter @ax/channel-web exec tsc --noEmit -p tsconfig.json`. channel-web is the one package whose tsc includes tests (auto-memory). Expected: PASS.
- [ ] **Step 5: Commit.** `[TASK-995] channel-web: send, render and download attachments by ID`.

### Task 3: Runner — uploads land flat in `<scratch>/uploads/`, translated by ID [tier: sensitive] [security-checklist]

**Files:**
- Modify:
  - `packages/agent-runner-core/src/materialize-uploads.ts` (rewrite)
  - `packages/agent-runner-core/src/attachment-translation.ts` (by-ID lookup; `formatAttachmentMention` and `formatAttachmentInline` move here from ipc-protocol, their sole producer)
  - `packages/agent-runner-core/src/run-runner.ts`: the boot call `:656-679`, the warm-rebind call `:1327-1332`, and the reader `:849-875`. Remove the `workspace.read` fallback.
  - `packages/agent-runner-core/src/generated-files.ts` (`:36-66`)
  - `packages/ipc-protocol/src/content-blocks.ts`: delete the two moved formatters
  - `packages/agent-aisdk-runner/src/__tests__/parity.e2e.test.ts`: test `:749` uses the new list shape
- Test:
  - `packages/agent-runner-core/src/__tests__/{materialize-uploads,attachment-translation,generated-files,run-runner,artifact-publish-executor}.test.ts`
  - `packages/tool-artifact-publish/src/__tests__/path-allowlist.test.ts`

**Interfaces — Produces:**
- `sanitizeUploadName(filename: string): string`
- `collisionName(name: string, n: number): string` (n ≥ 2)
- `interface MaterializedUpload { attachmentId: string; filename: string; path: string; sha256: string; mediaType: string; sizeBytes: number }`
- `materializeUploads(opts: { client: IpcClient; conversationId: string; uploadsDir: string; known: Map<string, MaterializedUpload>; warn: (msg: string) => void }): Promise<void>` adds new entries to `known`.
- `formatAttachmentMention({ filename, path, mediaType })` returns `User attached '<filename>' at <path> (<mediaType>)`, where `path` is the absolute runtime path, model-facing only. When the upload is unavailable, the text is `User attached '<filename>' (<mediaType>), but the file could not be loaded.`
- `uploadsDir = path.join(env.ephemeralRoot, 'uploads')`. Until Task 4 makes the root required, a missing `ephemeralRoot` skips materialization with a warning.

- [ ] **Step 1: Write the failing tests** (real temp dirs; a fake client built from `AttachmentsListResponseSchema.parse(...)`, never hand-typed, per the `mistakes.md` "harness fake" lesson).
  - materialize-uploads:
    - `it('writes the conversation\'s uploads flat into uploads/ in list order')`.
    - `it('names duplicates report.pdf, report (2).pdf, report (3).pdf')`; `notes` becomes `notes (2)`, and `.bashrc` becomes `.bashrc (2)`.
    - `it('keeps hostile names inside uploads/')`, table-driven:
      - `../../files/x` → `x`; `a/b` → `b`; `a\b` → `b`;
      - `..`, `.` and `''` → `file`;
      - `"a\nb.txt"` → `ab.txt`;
      - a 300-byte name gives a name of ≤255 bytes ending in `.pdf`;
      - for every case, `path.dirname(realpath) === realpath(uploadsDir)`.
    - `it('never overwrites or follows an existing name')`: plant `report.pdf -> <outside>/victim` (a symlink) and a regular file `notes`. Afterwards `victim` is unchanged, and the uploads sit at `report (2).pdf` and `notes (2)`.
    - `it('refuses an uploads path that is a symlink or a file')`: nothing is written, and `warn` is called.
    - `it('a later call writes only new attachments and keeps earlier names')`.
    - `it('a fresh process given the same list derives the same names')`.
    - `it('a list failure writes and deletes nothing')`.
  - attachment-translation:
    - `it('inlines a text upload by attachmentId when its real size is at most 64 KiB')`.
    - `it('mentions, never inlines, a text upload larger than 64 KiB')`: the size comes from `fstat`, not the list.
    - `it('passes images through, and PDFs when document blocks are supported')`.
    - `it('mentions, never inlines or passes through, a copy whose bytes no longer match its sha256')`.
    - `it('mentions, never follows, a copy replaced by a symlink')`: open with `O_NOFOLLOW`.
    - `it('mentions an attachmentId that was never materialized, with no IPC read')`: the fake client records no `workspace.read`.
  - generated-files: `it('artifact chips carry the artifactId, not a path')`; the auto-attach dedup still skips files the model already published, by path.
  - run-runner: `it('re-materializes when a queued message carries an unknown attachmentId')`.
  - Scratch merge (Review Focus 5):
    - in `path-allowlist.test.ts`, with roots `{userFilesRoot:'/files', ephemeralRoot:'/tmp'}`, `/tmp/uploads/a.pdf`, `/tmp/transcripts/s.jsonl` and `/tmp/a.txt` are all `ok:false`, and `/tmp/artifacts/a.png` is `ok:true`;
    - in `artifact-publish-executor.test.ts`, `<t>/tmp/artifacts/x -> <t>/tmp/transcripts/s.jsonl` is rejected.
- [ ] **Step 2: Run and confirm they fail.** `pnpm build && pnpm --filter @ax/agent-runner-core test -- materialize-uploads attachment-translation generated-files run-runner artifact-publish-executor` and `pnpm --filter @ax/tool-artifact-publish test`. Expected: FAIL (new names missing). The allowlist tests may already pass; keep them as pins.
- [ ] **Step 3: Implement.**
  - **Sanitizer:** take the last segment after splitting on `/` and `\`; drop U+0000–U+001F and U+007F; trim; cap at 200 UTF-8 bytes, keeping an extension of up to 16 bytes, on a code-point boundary. `''`, `.` and `..` become `file`.
  - **Writes:** `mkdir(uploadsDir, {recursive:true, mode:0o700})`, then `lstat` must be a directory and not a symlink. Fetch with `blob.get` into the client's temp file, then `copyFile(tmp, dest, fs.constants.COPYFILE_EXCL)`. On `EEXIST`, try the next collision name, up to 999. Always unlink the temp file. There is no wipe.
  - **Translation:** open with `O_RDONLY|O_NOFOLLOW` and `fstat`, read, compare `sha256`, then branch.
  - **Mention name:** the `filename` with control characters stripped.
- [ ] **Step 4: Verify.** Run the Step 2 commands, plus `pnpm --filter @ax/agent-aisdk-runner test -- parity` (rebuild runner-core first). Expected: PASS.
- [ ] **Step 5: Commit.** `[TASK-995] Runner: uploads flat under the scratch root, translated by ID and verified`.

### Task 4: Runner core — delete the git tier, `/agent`, re-rooting and save-refused; require home + scratch; new prompt notes [tier: sensitive] [security-checklist]

**Files** (all under `packages/agent-runner-core/src/` unless noted):
- Delete: `git-workspace.ts`, `commit-notify-resync.ts`, `save-refused-notice.ts`, `governed-paths.ts`, and their tests (`git-workspace`, `commit-notify-resync`, `save-refused-notice`, `flush-workspace-host-teardown`, plus any `governed-paths` tests).
- Modify:
  - `env.ts`: drop `workspaceRoot` and `AX_WORKSPACE_ROOT`; `AX_USERFILES_ROOT` and `AX_EPHEMERAL_ROOT` are required and absolute; `runnerHomeDir(env) => env.userFilesRoot`.
  - `run-runner.ts`, in detail:
    - boot `:550-603`: no `workspace.materialize`, no gitignore scaffold; the seam `afterMaterialize` is renamed `prepareSession` and stays bootstrap-fatal (exit 2) and before the resume restore;
    - `closeTurn` `:1683-1895`: drop `commitTurnAndBundle`/`commitNotifyWithResync`/`saveRefused`/`refusedTurnKeys`; keep the transcript ship, the 4xx re-throw at `:1776-1794`, and the `beforeCommit` seam renamed `beforeTranscriptShip`;
    - drop the flush chain `:746-795` and `RunnerDeps.flushWorkspaceForHostTool` `:121-125`;
    - drop `drainHostSaveRefusals`/`withSaveRefusedNotice`/`pendingSaveRefusedNotice` `:949-1002`;
    - the final save `:1999-2035` becomes the transcript ship only;
    - the chat-end `:2093` has no `saveRefused`;
    - the skill-draft root `:831-840` is always `userFilesRoot`.
  - `tool-policy.ts`: delete the re-root options `:89-96,121-124`; adjudication is unchanged.
  - `config-dir-guard.ts`: the roots are the home; rewrite the header `:26-28`.
  - `tool-cache-env.ts`: the root is required; fix comments `:4-22`.
  - `system-prompt.ts`: `workspaceNote` becomes `filesNote(home, scratch)`; `ephemeralScratchNote`, `fileOutputNote`, `userFilesNote`, cwd `:388,391`.
  - `prompt-engine.ts`: `:285,293,309-310`.
  - `skill-propose-executor.ts:128`: no scratch fallback.
  - `commit-trace.ts`: header only.
  - `python-venv.ts`, `home-bin-env.ts`, `proxy-startup.ts`: comments only.
  - `index.ts`: drop exports `:28-43,73`, plus `IDENTITY_SCAFFOLD`/`SOUL_SCAFFOLD` re-exports from `identity-templates.ts:14-15`.
  - `packages/agent-runner-core/package.json`: drop the `./internal/git-workspace.js` export.
  - `packages/agent-runner-core/README.md`: lines 4, 35, 56-57, 71.
- Test: `env`, `run-runner`, `tool-policy`, `config-dir-guard`, `system-prompt`, `prompt-engine`, `tool-cache-env`, `skill-propose-executor`, `identity-templates` (`.test.ts` under `src/__tests__/`).

**Interfaces — Produces:**
- `RunnerEnv` without `workspaceRoot`, with `userFilesRoot: string` and `ephemeralRoot: string` required.
- `RunnerSeams.prepareSession`, `EndTurnInput.beforeTranscriptShip`.
- `filesNote(home: string, scratch: string): string`.

- [ ] **Step 1: Write the failing tests.**
  - env:
    - `it('requires AX_USERFILES_ROOT')` and `it('requires AX_EPHEMERAL_ROOT')`: each throws `MissingEnvError`;
    - `it('ignores AX_WORKSPACE_ROOT')`: the result has no `workspaceRoot` key;
    - `runnerHomeDir` returns `userFilesRoot`.
  - config-dir-guard:
    - home `/files` with `CLAUDE_CONFIG_DIR=<t>/home-runner/.ax/session` and `AX_TRANSCRIPTS_ROOT=<t>/tmp/transcripts` passes;
    - `CLAUDE_CONFIG_DIR=<t>/files/.claude` is refused.
  - tool-policy: `it('passes .ax/SOUL.md, .claude/settings.json and CLAUDE.md through unchanged to tool.pre-call')`.
  - run-runner, with a fake IPC that records every action:
    - `it('boots, runs a turn and ends the chat without any workspace.* or drain-save-refusals call')`;
    - `it('a prepareSession failure exits 2 before the resume restore')`;
    - `it('turn-end and chat-end events carry no saveRefused')`.
  - system-prompt: across the notes, the text names `<home>` as home and cwd and `<scratch>/uploads/`, contains "go away after this conversation", and contains none of `.ax`, `/agent`, `governed`, `committed`, `versioned`, `bundle`. Bootstrap mode still includes the output note.
- [ ] **Step 2: Run and confirm they fail.** `pnpm --filter @ax/agent-runner-core test`. Expected: FAIL.
- [ ] **Step 3: Implement.** Prompt copy to use (adjust only for length):
  - `filesNote`: "Your files: `<home>` is your home and working directory. Everything you want to keep goes there — documents you produce, code, datasets, downloaded or cloned repositories — and it persists across sessions. Files people share with you in this chat are at `<scratch>/uploads/`; they go away after this conversation, so copy anything you need later into `<home>`."
  - Scratch note: keep it, but drop the "durable user-files directory, when available" sentence.
  - `fileOutputNote`: "save documents, code and other finished files under `<home>/…`".
  - `userFilesNote`: drop "versioned/committed".
- [ ] **Step 4: Verify.** `pnpm --filter @ax/agent-runner-core test && pnpm --filter @ax/agent-runner-core exec tsc --build`. Expected: PASS. The two runner packages are expected to be red until Task 5.
- [ ] **Step 5: Commit.** `[TASK-995] Runner core: remove the git tier, governed re-rooting and save-refused; home and scratch are required`.

### Task 5: Runner adapters — claude-sdk and aisdk drop re-rooting and the host-tool flush [tier: sensitive] [security-checklist]

**Files:**
- `packages/agent-claude-sdk-runner/src/`:
  - `main.ts`:
    - `additionalDirectories` = dedup of `[ephemeralRoot, memoryRoot]` minus the home (`:503-516`);
    - `HOME`/`cwd` come from `runnerHomeDir`;
    - the pre-tool-use wiring `:567-594` has no `broaden`/`recognizedRoots`;
    - drop the host-mcp flush wiring `:154-158`;
    - rename the seam `:1082`;
    - fix comments `:402-422`.
  - `pre-tool-use.ts`, `host-mcp-server.ts` (drop the gate `:184-202` and the option `:53-58`), `tool-names.ts:50-56`, `post-tool-use.ts:10-17`, `turn-end-uuid.ts:60-73`.
  - Delete `__tests__/flush-workspace-host.e2e.test.ts`.
  - `__tests__/main.test.ts`: remove the `internal/git-workspace.js` mock `:105-117`. In every env fixture, drop `AX_WORKSPACE_ROOT` and add `AX_EPHEMERAL_ROOT=<t>/tmp`; this includes the §11 canary `describe('agent files §11 guards')`.
  - Also `pre-tool-use.test.ts`, `host-mcp-server.test.ts`, and `SECURITY.md` (`:7,45-46,53,107`).
- `packages/agent-aisdk-runner/src/`:
  - `main.ts`: `policy-wrap` without re-root `:215-228`; `host-tools` without flush `:297`; `bashEnv` `:197-207`; comments `:58,209-214`.
  - `tools/policy-wrap.ts`, `tools/host-tools.ts` (`:47-52,81,133-146`), `tools/builtins.ts:12-18`.
  - `__tests__/{interrupt.e2e,policy-wrap,host-tools,parity.e2e,builtins}.test.ts`: remove the git-workspace mock at `interrupt.e2e:71`, and fix parity `:537` ("keeps identity in agent state").
  - `README.md` (`:10,21,43-45,76`).
- `packages/agent-identity-templates/src/templates.ts`: delete `IDENTITY_SCAFFOLD`/`SOUL_SCAFFOLD` (`:86-110`) and their test assertions; fix the comment `:22-23`.

**Interfaces:** Consumes Task 4's `RunnerEnv`, `prepareSession`, `beforeTranscriptShip` and `filesNote`.

- [ ] **Step 1: Write and adjust the tests.**
  - claude-sdk main:
    - `it('runs the SDK with HOME = cwd = the agent home, CLAUDE_CONFIG_DIR outside it, and additionalDirectories = [scratch, memory]')`;
    - `it('a host tool call has no workspace flush precondition')`.
  - pre-tool-use: `it('never rewrites .ax/, .claude/ or CLAUDE.md paths')`.
  - aisdk policy-wrap: the same no-rewrite case.
  - The §11 canary (`main.test.ts`) still asserts:
    - `settingSources` `['user']`;
    - only the two MCP servers;
    - no `CANARY-` in the prompt;
    - `cwd` = `env.HOME` = `<t>/files`;
    - `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` absent;
    - the home's listing equals the planted set.
- [ ] **Step 2: Run them.** `pnpm --filter @ax/agent-runner-core exec tsc --build && pnpm --filter @ax/agent-claude-sdk-runner test && pnpm --filter @ax/agent-aisdk-runner test && pnpm --filter @ax/agent-identity-templates test`. Expected: FAIL before Step 3, then PASS. The real-SDK e2e files need the native CLI. If it is missing locally, say so; CI runs them.
- [ ] **Step 3: Implement** to the interfaces above.
- [ ] **Step 4: Verify.** Run the Step 2 commands, plus `pnpm build` (the runner and identity-template packages). Expected: PASS.
- [ ] **Step 5: Commit.** `[TASK-995] Runners: drop governed re-rooting and the host-tool workspace flush`.

### Task 6: Sandboxes — `/tmp` replaces `/agent` and `/ephemeral`; bootstrap pins; size limit; stub runner [tier: sensitive] [security-checklist]

**Files:**
- `packages/sandbox-protocol/src/bootstrap.ts`:
  - export `POD_SCRATCH_ROOT = '/tmp'`;
  - `controlNames` loses `AX_WORKSPACE_ROOT`;
  - `fixedPaths` loses `AX_WORKSPACE_ROOT` and pins `AX_EPHEMERAL_ROOT: POD_SCRATCH_ROOT`;
  - also `src/index.ts` (export) and the `schemas.ts:19` comment.
- `packages/sandbox-k8s/src/pod-spec.ts`:
  - delete the `agent` and `ephemeral` volumes and mounts (`:941-942`, `:1022-1023`);
  - the `tmp` volume becomes `{ emptyDir: { sizeLimit: TMP_SIZE_LIMIT } }`, with `export const TMP_SIZE_LIMIT = '10Gi'`;
  - env: no `AX_WORKSPACE_ROOT` (`:810,823`); `AX_EPHEMERAL_ROOT = POD_SCRATCH_ROOT` (`:817,824`);
  - drop `BuildPodSpecInput.workspaceRoot` (`:106`, unused, `:801-809`);
  - comments: sdk-scaffold `:968-977`, git env `:621-658` (now "for the agent's own git work").
- `packages/sandbox-k8s/src/shared-pool.ts:44`: no `workspaceRoot: '/agent'` in the `buildPodSpec` call.
- `packages/sandbox-k8s/src/open-session.ts:363`: stop passing `workspaceRoot` to `buildPodSpec`. **KEEP `:198`.** That is the `session:create` payload, and both session stores still require `workspaceRoot` (`session-inmemory/src/plugin.ts:472-477`, `session-postgres/src/plugin.ts:794-799`). Keep `AX_COMMIT_TRACE` forwarding (`:409-410`).
- `packages/sandbox-k8s/SECURITY.md` (`:7,23,73-96,200`).
- `packages/agent-runner-core/src/standby.ts:24`: use `POD_SCRATCH_ROOT`.
- `packages/sandbox-subprocess/src/open-session.ts`: no `AX_WORKSPACE_ROOT` (`:546`); comments `:49`, `:580`. Keep `cwd: input.workspaceRoot` (`:711`) and the per-session `ephemeral` dir. Also `SECURITY.md:44`.
- `packages/test-harness/src/stub-runner.ts:34,50,78-82`: stop requiring `AX_WORKSPACE_ROOT`; add no replacement.
- Fixtures: `packages/sandbox-subprocess/src/__tests__/fixtures/{echo-stub,tiers-stub}.mjs`.
- Test:
  - `sandbox-protocol/src/__tests__/bootstrap.test.ts`
  - `sandbox-k8s/src/__tests__/{pod-spec,open-session,shared-pool,agent-sandbox}.test.ts`
  - `sandbox-subprocess/src/__tests__/{open-session,userfiles-canary.acceptance}.test.ts`
  - `agent-runner-core/src/__tests__/standby.test.ts`

**Interfaces — Produces:** `POD_SCRATCH_ROOT` (sandbox-protocol) and `TMP_SIZE_LIMIT` (sandbox-k8s). `OpenSessionInput.workspaceRoot` STAYS: it is the subprocess runner's process cwd, and nothing in the sandbox reads it any more.

- [ ] **Step 1: Write the failing tests.**
  - bootstrap:
    - `allowedBootstrapEnv('AX_EPHEMERAL_ROOT','/tmp')` is true; `'/ephemeral'` is false;
    - `allowedBootstrapEnv('AX_WORKSPACE_ROOT','/agent')` is false;
    - a `BootstrapAssignmentSchema` carrying `AX_WORKSPACE_ROOT` is refused.
  - pod-spec:
    - `it('mounts no /agent or /ephemeral and caps the disk /tmp at 10Gi')`: volumes have no names `agent`/`ephemeral`; `tmp.emptyDir.sizeLimit === '10Gi'` and there is no `medium`;
    - env has `AX_EPHEMERAL_ROOT=/tmp` and no `AX_WORKSPACE_ROOT`. Rewrite the old pins at `pod-spec.test.ts:297-334`, and keep `:336-360` (transcripts on the disk `/tmp`).
  - shared-pool: the session env built from the pod spec passes `BootstrapAssignmentSchema`.
  - subprocess:
    - no `AX_WORKSPACE_ROOT` in the child env;
    - `userfiles-canary` asserts two distinct roots (user files, scratch).
  - standby: the template root equals `POD_SCRATCH_ROOT`.
- [ ] **Step 2: Run and confirm they fail.** `pnpm --filter @ax/sandbox-protocol test && pnpm --filter @ax/sandbox-k8s test && pnpm --filter @ax/sandbox-subprocess test && pnpm --filter @ax/agent-runner-core test -- standby`. Expected: FAIL.
- [ ] **Step 3: Implement** (rebuild `@ax/sandbox-protocol` before the dependents).
- [ ] **Step 4: Verify.** Run the Step 2 commands, plus `pnpm --filter @ax/test-harness test`. Expected: PASS.
- [ ] **Step 5: Commit.** `[TASK-995] Sandboxes: /tmp is the scratch root (10Gi), /agent and /ephemeral removed`.

### Task 7: Delete every git-tier event subscriber — the disk-quota meter and gate (plus leftover rows) and the validator vetoes [tier: sensitive] [security-checklist]

**Files:**
- `packages/disk-quota/src/`:
  - `plugin.ts`: subscriptions `:18-26`; `workspace:usage` optionalCall `:195-199`; subscribers `:269-297`; header `:28-87`.
  - `service.ts`: `admitWorkspaceWrite` `:310-323`; `measureOnce` workspace path `:366-391`; `measuring` `:398`; `scheduleWorkspaceMeasure` `:413-436`; `releaseWorkspace` `:438-479`; `sweepWorkspaces` `:630-655`; reconcile `:899-909`. `admit` counts `agent-files` only.
  - `store.ts`: `deleteWorkspaceUsage` `:43-50,130-141`; SUM filter `:156,174` becomes `kind = 'agent-files'`.
  - `migrations.ts`: append `DELETE FROM disk_quota_v1_usage WHERE kind = 'workspace'`; keep the CHECK with a comment.
  - `messages.ts`: delete `workspaceFullMessage` `:45-52`, and its export in `index.ts:11`.
- `packages/validator-skill/src/plugin.ts`: delete the subscriber `:125-149`, the vetoed lists `:56-68` and `subscribes` `:115`. Keep `skills:scan`.
- `packages/validator-identity/src/plugin.ts`: delete the pre-apply gate `:217-332`, `isInBootstrapWindow` `:347-372`, the optional `workspace:read` `:190-196` and `subscribes` `:197`. Keep `identity:scan`. The `@ax/agent-identity-templates` import goes away; the dependency edit waits for Task 12.
- Also: both validators' README/SECURITY.
- Pins:
  - `presets/k8s/src/__tests__/preset.test.ts`: the disk-quota lists `:988-1050`; validator-identity `:1570-1599`, including the "some plugin registers workspace:read" assertion at `:1598`;
  - `presets/k8s/src/__tests__/disk-quota-acceptance.test.ts`: delete tests (2), (2b), (3), (4), (5b-a…d) (`:733-1378`) and the workspace-git setup `:40-80,398-409,533-631`; keep (1), (5), (6), (7a), (7b).
- Test:
  - `disk-quota/src/__tests__/{plugin,service,store,messages,routes}.test.ts`
  - `validator-skill/src/__tests__/plugin.test.ts` (delete `:52-240`; keep the `skills:scan` suite)
  - `validator-identity/src/__tests__/plugin.test.ts` (delete `:160-470`; keep `:81-158`; manifest `:64-79`)

- [ ] **Step 1: Write the failing tests.**
  - disk-quota:
    - `it('the manifest subscribes to no workspace:* event and calls no workspace:usage')`;
    - `it('boot deletes leftover workspace rows and keeps agent-files and blob rows')`: seed one row of each kind, run the migration twice, and expect 2 rows;
    - `it('usage counts agent-files only')`.
  - Validators: `manifest.subscribes` deep-equals `[]` and there is no `workspace:*` in `optionalCalls`; `skills:scan` and `identity:scan` still answer.
- [ ] **Step 2: Run and confirm they fail.** `pnpm --filter @ax/disk-quota test && pnpm --filter @ax/validator-skill test && pnpm --filter @ax/validator-identity test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.** Run the Step 2 commands, plus `pnpm build && pnpm --filter @ax/preset-k8s test -- preset disk-quota-acceptance`. Expected: PASS. `acceptance.test.ts` is out of this task's scope until Task 13.
- [ ] **Step 5: Commit.** `[TASK-995] Remove the git-tier subscribers: quota meter and gate, validator vetoes; drop leftover workspace quota rows`.

### Task 8: channel-web — drop the git Files section, the git routes, the `workspace:*` deps and the save-refused UI [tier: integration]

**Files:**
- Server:
  - `src/server/plugin.ts`: drop hard calls `:164-172`.
  - `src/server/routes-workspace.ts`:
    - delete the routes `GET /api/workspace/agents/:agentId/files` (`:10131`, handler `:7981`), `…/files/*` (`:10147`, `:8035`) and `…/download/files/*` (`:10189`, `:8160`);
    - delete the git-only helpers `:1317,1322,1339,2892,2924,2931,3076` and the local types `:624-633`, after confirming no other caller;
    - delete the save-refused parts `:300-303,713-723,3922-3958,4086-4089`;
    - keep `workspaceFilePath`, `decodeFileBody` and `sendFileDownload`.
  - `src/server/sse.ts:17,499,517-530` and `src/server/types.ts:11,217-230`.
  - Delete `src/lib/save-refused.ts`.
- Client:
  - `src/components/workspace/AgentFiles.tsx`:
    - delete the "Agent workspace" section `:524-591`, its viewer `:671-682`, the two-tier logic `:264-279` and the summed count `:221-223`;
    - the count is now `/files` only; rewrite the header `:1-53`.
  - Delete `src/lib/workspace-files.ts`.
  - `src/lib/workspace-api.ts`: `files`/`file` `:1582-1596`; `downloadFile` drops the tier `:1639-1646`; `FileTier` `:1170`; save-refused `:77,1039-1041,2268-2270`.
  - `src/lib/file-download.ts` (no tier), `src/lib/user-files.ts:4` comment, and `src/lib/workspace-types.ts` (`:46,746-794,922,969`).
  - Delete `src/components/workspace/save-refused-copy.ts`.
  - `AgentView.tsx` (`:80,645-663,839,880,931-936,1183,1494-1518`), `AgentConversation.tsx` (`:55-56,185-190,1243-1270`), `src/lib/thread-find.ts:321-322`.
  - `AgentInstructions.tsx`: drop the unreachable `StorageFullError` branch (a TASK-989 leftover, noted by TASK-993).
  - `src/lib/storage-copy.ts`: drop any wording that says saves are refused when storage is full. TASK-993 left the NEAR_LIMIT/FULL_BODY mention for this card. Keep the copy-test bans on "delete"/"remove", digits and jargon.
- Preset canary: `presets/memory/src/__tests__/canary.test.ts`: delete the TASK-717 git-files block `:1771-2020`.
- Tests:
  - Delete `AgentViewSaveRefused.test.tsx` and `workspace-api-stream-save-refused.test.ts`.
  - Update `AgentFiles.test.tsx`: delete `:88-300` and `:664-709`; re-point the download suites `:710-1060` to the user-files fixture.
  - Update `AgentFilesCompact.test.tsx`, `lib/__tests__/file-download.test.ts`, `server/{plugin,routes-workspace,routes-workspace-files,routes-workspace-download,routes-workspace-team-agent,routes-agent-bootstrap,routes-chat,stream-e2e,acceptance-e2e,routes-attachments,sse}.test.ts`.
  - Drop every `createMockWorkspacePlugin` use in channel-web tests.

- [ ] **Step 1: Write and adjust the tests.**
  - `plugin.test.ts`: the manifest's `calls` contains no `workspace:*`.
  - `routes-workspace-files.test.ts`: `it('serves no git workspace file routes')` (the old paths give 404).
  - `AgentFiles.test.tsx`:
    - `it('shows one Files section for the agent home and no Agent workspace section')`;
    - the download suites pass against `/download/user-files/*`.
  - `sse.test.ts`: the `done` frame has no `saveRefused`.
- [ ] **Step 2: Run and confirm they fail.** `pnpm --filter @ax/channel-web test`. Expected: FAIL.
- [ ] **Step 3: Implement.** Invoke the `shadcn` skill before editing `AgentFiles.tsx`. This is removal only: no new components and no raw colors. If the one remaining section's heading or empty-state text changes, run the `ux-design` skill over the copy.
- [ ] **Step 4: Verify.** `pnpm --filter @ax/channel-web test && pnpm --filter @ax/channel-web exec tsc --noEmit -p tsconfig.json && pnpm build && pnpm --filter @ax/preset-memory test -- canary`. Expected: PASS.
- [ ] **Step 5: Commit.** `[TASK-995] channel-web: Files tab shows /files only; git routes and save-refused UI removed`.

### Task 9: Host data — drop `workspaceRef` and the save-refused store [tier: sensitive]

**Files:**
- `packages/agents/src/`:
  - `migrations.ts`: remove `workspace_ref TEXT,` from `CREATE TABLE` `:43`; append `ALTER TABLE agents_v1_agents DROP COLUMN IF EXISTS workspace_ref` after the TASK-142 drop; type `:229`.
  - `types.ts` `:56,118,162-189`; `store.ts` `:26,37,333-345,362,388,433-434,576,739,756,817,833,1004`; `admin-routes.ts` `:106,143-148,166,199,381`.
  - Comments: `plugin.ts:187,607,614-616`, `admin-routes.ts:843`, `authored-skills.ts:8-10`.
- `packages/conversations/src/`:
  - `migrations.ts`:
    - remove `workspace_ref` from the `ADD COLUMN` list `:94` and the `save_refused_drained_seq` `ADD` `:155-163`;
    - append `ALTER TABLE conversations_v1_conversations DROP COLUMN IF EXISTS workspace_ref, DROP COLUMN IF EXISTS save_refused_drained_seq`;
    - keep `'save-refused'` in the event-kind CHECK `:186-265`, with a "rows predate TASK-995; nothing writes or reads them" comment;
    - row types `:360,371-374`.
  - `types.ts` `:97-101,221-252,290-325,516,563`; `store.ts` `:54-55,153-163,191,233,265,460-473,638-644,785,806,931,1057,1228-1275,1522-1548`.
  - `plugin.ts`: freeze `:1360-1374,1438,1457,2071,2085`; drain hook `:288-293,486-494,962-1000`.
  - `index.ts:19` (`validateWorkspaceRefForFreeze`).
  - The `conversations:append-event` input enum loses `'save-refused'`, and the read path ignores old rows of that kind.
- `packages/chat-orchestrator/src/orchestrator.ts`: `:400` and comments `:646-651,4064-4072`.
- `packages/routines/src/fire.ts:196`.
- `packages/cli/src/dev-agents-stub.ts:98-99,139,152`.
- `packages/channel-web/src/lib/admin.ts:47,64`; `src/server/routes-chat.ts:614,1350` comments; `src/wire/chat.ts:277`.
- Tests:
  - agents: `{acl,admin-routes,migrations,model-policy,return-schemas,store,store-webhook}`;
  - conversations: `{create-freezes,migrations,store-phase-b,types-shape,display-events,events-store,plugin}` and the remaining files that pass `workspaceRef`;
  - chat-orchestrator (10 files), `decisions` (`attendance`, `decisions.canary`), `ipc-core` (`runner-chat-end-bound`).

- [ ] **Step 1: Write the failing tests.**
  - agents migrations: `it('an agents table with workspace_ref upgrades: column dropped; a second run is a no-op')`.
  - conversations migrations: the same for both conversation columns. Also: `it('an old save-refused event row stays valid and getConversation ignores it')`.
  - `it('conversations registers no drain-save-refusals hook')`.
  - admin-routes: a body carrying `workspaceRef` gets the same outcome as any unknown field under that schema's strictness. Assert the current behaviour; don't add new strictness.
- [ ] **Step 2: Run and confirm they fail.** `pnpm --filter @ax/agents test && pnpm --filter @ax/conversations test`. Expected: FAIL.
- [ ] **Step 3: Implement.** In every test fixture that inserts raw `agents_v1_agents` or `conversations_v1_conversations` rows (`git grep workspace_ref`), drop the column.
- [ ] **Step 4: Verify.** Run the Step 2 commands, plus `pnpm build && pnpm --filter @ax/chat-orchestrator test && pnpm --filter @ax/decisions test && pnpm --filter @ax/routines test`. Expected: PASS.
- [ ] **Step 5: Commit.** `[TASK-995] Drop workspaceRef and the save-refused store (agents, conversations)`.

### Task 10: Host IPC and kernel types — remove the `workspace.*` and drain-save-refusals actions, `saveRefused` and `flushWorkspaceBeforeCall` [tier: sensitive] [security-checklist]

**Files:**
- `packages/ipc-protocol/src/`:
  - `actions.ts`: delete the `workspace.*` schemas `:194-527`, drain `:578-622`, `:324-325`, the `asWorkspaceVersion`/`WorkspaceVersion` re-exports `:2,9,276`, and `flushWorkspaceBeforeCall` `:70-77`; fix comments `:1044-1046`.
  - `events.ts`: `saveRefused` `:152-163,207-220`.
  - Delete `save-refused.ts` and its `index.ts:5` export.
  - `ipc-client.ts`: maps `:11,105-109,134`, binary unions `:225-226,259,1025-1026,1078`, comments `:214-217`.
  - `timeouts.ts`: `:15,22,31,40,55,66-77,120-125`.
- `packages/ipc-core/src/`:
  - Delete `handlers/{workspace-materialize,workspace-commit-notify,workspace-export-baseline-bundle,workspace-read,conversation-drain-save-refusals}.ts` and the whole `bundler/`.
  - `dispatcher.ts`: `:31,107-113,133-135,185,230-235`.
  - `dependencies.ts`: required `workspace:read` `:77-82`; optional `:110-124,172-180`; degradation strings `:139,149` (`/ephemeral/uploads` → "the scratch uploads directory").
  - `handlers/event-turn-end.ts:74-136,180-184`, `handlers/event-chat-end.ts:5,66-97`, `index.ts:33-45`.
  - Tests: delete the handler, bundler, commit-bundle and large-bundle tests; update `dependency-sync` (`:86-87,121`), `dispatcher`, the `event-turn-end`/`event-chat-end` tests and `runner-chat-end-bound`.
- `packages/ipc-http` and `packages/ipc-server`:
  - manifests follow `dependencies.ts`;
  - comments on `IDLE_TIMEOUT_MS` (keep the value; the materialize rationale goes) and in `plugin.ts`;
  - tests: `plugin`, `listener` (ipc-http `:205-220`, ipc-server `:222-296`) and `ownerless-tenant-isolation`. Move that probe from `/workspace.read` to `/tool.list`: a stub `tool:list` records `ctx.agentId`, and the per-session isolation assertions are kept.
- `packages/core/src/types.ts:52-67` (`flushWorkspaceBeforeCall`).
- `packages/core/src/errors.ts`: drop `Rejection.offendingPaths` `:95-157` if no reader remains (only pre-apply vetoes set it).
- `packages/mcp-client/src/catalog.ts:151-170,218-219` and `tool-dispatcher-plugin.ts:25,37`; tests `catalog`, `return-schemas`; `packages/routines` `tools` test (drop the flag-absent assertion).

- [ ] **Step 1: Write the failing tests.**
  - dispatcher: `it('has no workspace.* or conversation.drain-save-refusals route')`. A POST to each of the six removed paths gives 404.
  - dependency-sync: the declared hooks equal the hooks the handlers use; there is no `workspace:*`.
  - ipc-protocol schemas: `EventTurnEndSchema`/`EventChatEndSchema` strip or refuse `saveRefused`, matching each schema's existing strictness. `ToolDescriptorSchema` has no `flushWorkspaceBeforeCall` key.
  - Tenant isolation, both transports: same assertions, new probe.
- [ ] **Step 2: Run and confirm they fail.** `pnpm --filter @ax/ipc-protocol test && pnpm --filter @ax/ipc-core test && pnpm --filter @ax/ipc-http test && pnpm --filter @ax/ipc-server test && pnpm --filter @ax/mcp-client test && pnpm --filter @ax/core test`. Expected: FAIL.
- [ ] **Step 3: Implement.** Rebuild `@ax/core` and `@ax/ipc-protocol` before the dependents.
- [ ] **Step 4: Verify.** Run the Step 2 commands, plus `pnpm --filter @ax/routines test && pnpm build`. Expected: PASS.
- [ ] **Step 5: Commit.** `[TASK-995] Remove the workspace and save-refused IPC actions, saveRefused events and flushWorkspaceBeforeCall`.

### Task 11: Presets and CLI stop loading the git tier; pins; chart env-shape allowlist [tier: integration]

**Files:**
- `presets/k8s/src/index.ts`:
  - delete `K8sWorkspaceConfig` `:192-204`, the `workspace` field `:267-287`, the selection `:732-750`, and `workspaceConfigFromEnv` `:1552-1615` with its loader call `:2014` and doc `:1712-1715`;
  - imports `:8-9`;
  - comments `:198,817-828,1290,1377`. The `:1377` comment should state the real `<home>/.skill-draft/<id>/` path.
- `presets/k8s/src/__tests__/`:
  - `preset.test.ts`: the expected set drops `'@ax/workspace-git'` (`:281`); delete `:1632-1708,1710-1835,2068-2072`; change `:1860-1868`; drop the `AX_WORKSPACE_*` fixtures.
  - `acceptance.test.ts`:
    - imports `:39,66-70`; `PLUGINS_TO_DROP` `:180-182`; the `createDispatcherDepsStubPlugin` arg `:587`; config `:508-511`;
    - delete the tests whose subject is a deleted surface: the git-protocol canary `:675`; the `bootCanaryHarness` suite `:994-1120` and its users `:1121,1168,1539,1664,1694,1729,1759`; Phase F `:1819`; the Task 21 stub `:3046-3060`. Read each title first: a test asserting surviving behaviour through the git harness is re-pointed, not deleted;
    - the uploads `:2076` and artifact `:2521` canaries are Task 13.
  - `multi-tenant-acceptance` `:145,233-246,404-407,464`; `usage-limits-acceptance` `:102,237-242,350`; `prod-bootstrap` `:172,216,457-458`.
  - Remove the `workspace:` config literals in the other preset tests: `boot-graph`, `agent-workspace-retired`, `blob-backend`, `credentials-admin-loaded`, `runner-binaries`, `shared-pool`, `orchestrator-keepalive`, `retire-strata-index`, `blob-*`, `provider-metering`.
  - `k8s-e2e/runner-owned-sessions-k8s-gap.test.ts`: KEEP the file. Its `180_000` timeout and bare teardowns are pinned by `scripts/__tests__/out-of-process-test-timeouts.test.js:751-761`. Reword its `commitTurnAndBundle` case (`:485-541`) to the turn-end transcript ship, or delete only that case.
- `presets/memory/src/index.ts:84-110`: the two overlap checks against `config.workspace.repoRoot` now compare against the fs blob root (`config.blob.backend === 'fs' ? config.blob.root : undefined`), with messages naming the blob root. Tests: `preset.test.ts` (`:16,241-252,254-268,280-296,337-338`), `boot-graph.test.ts` (`:23,51-52`), and the `canary.test.ts` workspace config `:257` and stubs `:1352-1354,2057-2062`.
- `packages/cli/src/main.ts`: imports `:24`; the repo default `:153-164`; the workspace-git push `:298-309`; the `retire-routine-files` dispatch `:455-458`; comments `:250-265,486-488`.
  - Delete `src/retire-routine-files.ts` and its test.
  - `src/commands/serve.ts:42-45`: this usage text is user-visible. Remove the `AX_WORKSPACE_*` lines.
- `deploy/charts/ax-next/__tests__/env-shape.test.ts`: add `AX_WORKSPACE_ROOT`, `AX_WORKSPACE_BACKEND`, `AX_WORKSPACE_GIT_SERVER_URL` and `AX_WORKSPACE_GIT_SERVER_TOKEN` to `EXTERNAL_READERS`, with the comment "stamped by the chart until the chart-cleanup card removes them; nothing reads them since TASK-995". Do not touch templates.

- [ ] **Step 1: Adjust the tests.**
  - preset: `it('loads no workspace backend and every call is satisfied')` (`:94-118` stays green).
  - memory preset: `it('refuses a memory export hostRoot that overlaps the fs blob root')`, and the same for `factsDatabasePath`.
  - CLI: `it('boots with workspace-localdir and no workspace-git')`, if a CLI boot test exists; else assert it through `prod-bootstrap`/`boot-graph`.
- [ ] **Step 2: Run them.** `pnpm build && pnpm --filter @ax/preset-k8s test -- preset multi-tenant-acceptance usage-limits-acceptance prod-bootstrap boot-graph && pnpm --filter @ax/preset-memory test && pnpm --filter @ax/cli test && pnpm --filter @ax/chart-tests test -- env-shape`. Expected: FAIL before Step 3, then PASS. env-shape skips without `helm`; if `helm` is installed run `AX_REQUIRE_HELM=1 pnpm --filter @ax/chart-tests test -- env-shape`, otherwise CI's helm lane runs it.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.** Run the Step 2 commands. Expected: PASS.
- [ ] **Step 5: Commit.** `[TASK-995] Presets and CLI no longer load the git workspace tier`.

### Task 12: Delete the five packages, the kernel workspace modules and the test-harness workspace mocks; build, CI and lockfile [tier: integration]

**Files:**
- `rm -rf packages/workspace-git packages/workspace-git-core packages/workspace-git-server packages/workspace-protocol packages/workspace-bundle-protocol`. Use `rm -rf`, not just `git rm`: stale `dist/` and `node_modules/` must go too.
- `packages/core/src/`: delete `workspace-apply-facade.ts`, `workspace-policy.ts`, `retired-routine-path.ts`, `workspace.ts`, `workspace-path.ts`, their tests (`workspace-apply-facade`, `workspace-policy`, `retired-routine-path`, `workspace`, `workspace-return-schemas`), and the `index.ts` exports `:26-34,77-95`. Keep `WorkspaceContext` in `context.ts`. First `git grep` every removed export for remaining importers.
- `packages/test-harness/src/`:
  - delete `mock-workspace.ts`, `workspace-contract.ts` and the self-test; `index.ts:7,10`; the `vitest.config.ts:35` comment;
  - `package.json`: drop `picomatch` and `@types/picomatch`;
  - `packages/agents/src/__tests__/promote-authored-skills.test.ts:28,97,380` stops using the mock.
- Dependencies (then one `pnpm install`):
  - `package.json`: `attachments:30`, `cli:39-40` (keep localdir), `conversations:29`, `ipc-core:23,31`, `memory:30`, `presets/k8s:81-82`, `validator-identity` (`@ax/agent-identity-templates`, if unused);
  - tsconfig refs: root `tsconfig.json:31-33,37,78`, `cli:23-24`, `ipc-core:12`, `memory:13`, `presets/k8s:17-18`.
- `eslint.config.mjs`: comments `:17-20,31-41,100-111,256-258`; allowlist `:139,141`; the message text `:151`; path entries `:266-273`.
- Delete `container/git-server/`; delete the CI step at `.github/workflows/ci.yml:443-453`.
- scripts:
  - `scripts/memory-product-e2e.mjs:241,250-252` (keep set);
  - `scripts/memory-lifetime-soak.mjs:173`;
  - comments only in `scripts/__tests__/no-raw-nul-bytes.test.js:5-6` (annotate "deleted in TASK-995"), `out-of-process-test-timeouts.test.js:165-171`, `vitest.config.mjs:19-21` and `agent-keyed-tables-are-cleaned.test.js:94-99`;
  - keep the file pinned at `out-of-process-test-timeouts.test.js:751-761` (only its git case goes, if any).
- `.changeset/`: delete `workspace-git-http.md`; remove the frontmatter lines naming deleted packages in `week-7-9-k8s-deployment.md:14`, `test-harness-close.md:4,23` and `skill-authoring-phase-3.md:14`.

- [ ] **Step 1: Delete, then search.** `git grep -nE "@ax/(workspace-git|workspace-git-core|workspace-git-server|workspace-protocol|workspace-bundle-protocol)\b" -- . ':!docs/plans/**' ':!.claude/memory/**'`. Expected: no hits outside history docs.
- [ ] **Step 2: Install and build.** `pnpm install && pnpm install --frozen-lockfile && pnpm build`. Expected: both installs succeed; the lockfile diff is removals only (`isomorphic-git` and `picomatch` drop if unused elsewhere); the build is green.
- [ ] **Step 3: Verify.** `pnpm --filter @ax/core test && pnpm --filter @ax/test-harness test && pnpm --filter @ax/agents test -- promote-authored-skills && pnpm lint && pnpm test:scripts`. Expected: PASS. If `memory-cited-paths-exist` fails, that is Task 14's tombstones. Commit this task first, then add them there.
- [ ] **Step 4: Commit.** `[TASK-995] Delete the git workspace packages and kernel workspace modules`.

### Task 13: Acceptance — a brand-new agent's `/files` stays empty; uploads and artifacts by ID in the canary; §11 on the new layout [tier: integration]

**Files:**
- `packages/agent-claude-sdk-runner/src/__tests__/main.test.ts`
- `packages/agent-aisdk-runner/src/__tests__/parity.e2e.test.ts`
- `presets/k8s/src/__tests__/acceptance.test.ts`
- `packages/agent-claude-sdk-runner/src/__tests__/agent-files-guards-real-sdk.e2e.test.ts`

- [ ] **Step 1: The runner-level empty-home test.** In `main.test.ts` add `it("a brand-new agent's home is still empty after its first chat turn, upload included")`:
  - env: `AX_USERFILES_ROOT=<t>/files` (empty), `AX_EPHEMERAL_ROOT=<t>/tmp`, `AX_TRANSCRIPTS_ROOT=<t>/tmp/transcripts`, `CLAUDE_CONFIG_DIR=<t>/cfg`;
  - the fake IPC serves one `attachments.list` entry and its `blob.get` bytes; the first message carries text plus that attachment block; the mocked `query()` ends the turn;
  - assert that the recursive listing of `<t>/files` is `[]`, and that `<t>/tmp/uploads/<name>` exists.
- [ ] **Step 2: aisdk.** In `parity.e2e.test.ts`'s plain-turn test (`:441`), assert that the home dir is empty after the turn.
- [ ] **Step 3: The canary.** In `acceptance.test.ts`, after the main chat turn (subprocess sandbox + `workspace-localdir` at `<tmp>/user-files`, `:576-581`), assert that `<tmp>/user-files/<agentId>` has no entries. Rewrite the uploads canary (`:2076`) and the artifact canary (`:2521`) without `createWorkspaceGitPlugin`:
  - upload via `attachments:store-temp`, then the chat POST;
  - the stored user-turn block has `attachmentId` and no `path`;
  - `attachments:download` by ID succeeds for the owner and is `not-found` for a second conversation of the same user;
  - an artifact publish yields a tool-turn chip with `attachmentId === artifactId` that downloads by ID.
- [ ] **Step 4: Real-SDK scratch plants** (Review Focus; `productionOptions` already passes `additionalDirectories: [pod.scratch]`, `:236-240`):
  - extend the canary with `<scratch>/CLAUDE.md` (marker `CANARY-SCRATCH-CLAUDEMD-…`) and `<scratch>/.claude/settings.json` (a `UserPromptSubmit` hook that touches a marker); assert there is no effect under production options;
  - add a control: with `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`, the marker reaches the request, which proves the plant is live. If the CLI does not honour that variable, keep only the no-effect assertion and say so in the PR.
- [ ] **Step 5: Verify.**
  - `pnpm build && pnpm --filter @ax/agent-claude-sdk-runner test -- main agent-files-guards-real-sdk && pnpm --filter @ax/agent-aisdk-runner test -- parity && pnpm --filter @ax/preset-k8s test`. Expected: PASS.
  - Mutation evidence (commit first; restore with `git checkout HEAD -- <path>`; assert `git status --short` is empty between mutants, per yolo-ship Phase 4). Two mutants, each with a prediction:
    - **M1:** runner-core `prepareSession` also writes `<home>/.ax-probe`. Predict: the Step 1 test goes red; Step 3 stays green, because the canary runs the stub runner, not runner code.
    - **M2:** sandbox-subprocess `open-session.ts` writes `.ax-probe` into the resolved user-files dir after `mkdir`. Predict: the Step 3 canary assertion goes red; Step 1 stays green.
    - Record predicted vs actual in the PR.
- [ ] **Step 6: Commit.** `[TASK-995] Acceptance: a new agent's /files stays empty; uploads and artifacts by ID in the canary`.

### Task 14: Docs, skills and memory (rule 5) [tier: mechanical]

**Files:**
- `docs/plans/2026-05-24-current-architecture.md`: rewrite to as-built.
  - TL;DR `:34-65`; §1 `:69-119`; §2 item 5 `:160-167`; §4 `:262-293`; §5 `:297-340`.
  - §6 workspace bullets `:356-405` and the storage limit `:444-542`; transitional `:567-569`; §7 `:578-591`; §8 `:621-640`; ARCH-9 `:656-658`.
  - The new facts: the four-tier layout; uploads by ID; no `workspace:*` hooks; the presets load filestore/localdir.
- `docs/plans/2026-10-29-agent-files-simplification-design.md`: add "As built (TASK-995)" notes.
  - §4: `/tmp` 10Gi cap; `AX_EPHEMERAL_ROOT=/tmp` via `POD_SCRATCH_ROOT`.
  - §7: one ID block for uploads and artifact chips; download by ID; legacy text; reconstruction deleted; client-sent blocks refused; hash check.
  - §12: `workspace` rows deleted at boot.
  - §14: `commit-trace` kept; `conversations` `workspace_ref` and the drain hook removed too.
  - §17: size limit; no deny-with-hint.
- Package docs: `packages/agent-claude-sdk-runner/SECURITY.md`, `agent-runner-core/README.md` and `agent-aisdk-runner/README.md`, if Tasks 4–5 left them; `ipc-http/SECURITY.md:28`; `blob-store-fs/SECURITY.md:27`; `eventbus-postgres/SECURITY.md:94`; validator READMEs/SECURITY, if Task 7 left them.
- `THIRD-PARTY-NOTICES.md:44-50`: a legal notice. Name `update_identity` and "Instructions from your people", not `.ax/AGENTS.md`/`.ax/SOUL.md`.
- `deploy/MANUAL-ACCEPTANCE.md`:
  - "Retired (TASK-995)" banners on: State persistence `:124-143`, the `/ephemeral` scenario `:1757-1879`, and the `.ax/routines` sections `:889-1109`, if not already retired;
  - Phase 0 `:272-300`: expect the skill link under `CLAUDE_CONFIG_DIR` (the TASK-994 reviewer finding);
  - the Stop-cancel probe `:2050-2090`: `/agent/cancel-probe.txt` → `/tmp/cancel-probe.txt`.
- `docs/runbooks/db-backed-routines-cutover.md` and `docs/runbooks/2026-05-01-workspace-git-server-canary.md`: add a "Retired (TASK-995)" banner at the top.
- Skills:
  - `.claude/skills/k8s-acceptance-loop/SKILL.md:177-179,192,208,267`: no git-server image build, no `workspace.backend=http`.
  - `.claude/skills/claude-memory/SKILL.md:173`: an example path that exists.
  - `.claude/skills/ax-conventions/SKILL.md`: one line saying the `workspace:*` examples were removed in TASK-995 and the patterns still apply; fix the `@ax/workspace-git` manifest example `:104-109` to say "illustrative".
  - `.claude/skills/chat-qa-sweep/references/scenario-catalog.md:131-140`: chips render from stored blocks.
- `presets/k8s/src/builtin-skills/ax-skill-creator/SKILL.md:34,87,91,154,157,189,214`: replace `/ephemeral/skill-draft/<id>/` with the enforced `<home>/.skill-draft/<id>/`. This text is model-facing; check it against `tool-skill-propose/src/draft-paths.ts`.
- Long-tail comments no code task touched:
  - `conversation-titles/src/plugin.ts:103-107`; `memory/src/owner.ts:49-50` and `__tests__/ownership.test.ts:159`; `memory-facts-{sqlite,postgres}/src/agent-scope-key.ts`;
  - `workspace-filestore/src/plugin.ts:35`, `workspace-localdir/src/plugin.ts:33`, `user-files-read/src/measure.ts:15`, `blob-store-fs/src/store.ts:11`, `credential-proxy/vitest.config.ts:11`;
  - `onboarding/src/completion-tx.ts:110-113`; `routines/src/reflection-prompt.ts:43` (NOT `reflection-prompt-history.ts`, which is frozen);
  - `tool-skill-propose` (`descriptor.ts:8-9`, `draft-paths.ts:10-11,53-54`, `plugin.ts:16`);
  - `tool-artifact-publish` (`path-allowlist.ts:25-38,55,69`, `descriptor.ts:13-16`, `plugin.ts:15`: the rationale is now "uploads and transcripts sit in the scratch root but outside `artifacts/`");
  - `container/agent/Dockerfile` (comments `:18-19,171-178,241-258,289-290`; the `.bashrc` lines pinned by `scripts/__tests__/dockerfile-home-bin-path.test.js` stay byte-identical);
  - `decisions/src/{plugin,replay}.ts`, `agent-activity/src/derive.ts:31-32`, `session-postgres` comments.
- Memory (shards only, never root archives):
  - `context` shard `.claude/memory/context/2026-10-31-TASK-995.md`:
    - a line starting `Deleted in TASK-995:` that backticks every deleted path any memory file cites (find them with `pnpm test:scripts -- memory-cited-paths-exist`; known ones: `packages/core/src/workspace-apply-facade.ts`, `packages/core/src/workspace-policy.ts`, `packages/ipc-core/src/handlers/workspace-commit-notify.ts`, `packages/ipc-core/src/handlers/__tests__/workspace-commit-notify.test.ts`, `packages/core/src/__tests__/workspace-return-schemas.test.ts`);
    - the as-built facts.
  - `patterns` shard: the uploads layout and naming; one ID block for uploads and artifacts; the scratch root constant.
  - Append builder decisions to the `decisions` shard.

- [ ] **Step 1: Edit.**
- [ ] **Step 2: Verify.** `pnpm build && pnpm test:scripts && pnpm --filter @ax/preset-k8s test -- builtin-skills && scripts/memory-append-check.sh` (R1/R2 clean). Expected: PASS.
- [ ] **Step 3: Commit.** `[TASK-995] Docs and memory: the agent files layout as built`.

### Task 15: Final gate [tier: integration]

- [ ] **Step 1:** `pnpm install --frozen-lockfile && pnpm build`. Expected: green.
- [ ] **Step 2:** `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`. Expected: all green. If `@ax/auth-better`'s Docker teardown times out with all assertions passing, record it; it is a known local flake.
- [ ] **Step 3:** `pnpm lint` and `pnpm typecheck`. tsc excludes most test files; channel-web is the exception. Expected: green.
- [ ] **Step 4: Grep audit.** Paste the output and the reason for each remaining hit into the PR.
  ```bash
  git grep -nE '\.ax/' -- packages presets
  git grep -n 'AX_WORKSPACE_ROOT' -- packages presets deploy/charts/ax-next/__tests__
  git grep -nE '(^|[^a-zA-Z0-9_.-])/agent([^a-zA-Z0-9_-]|$)' -- packages presets container   # matches /agent but not /agents or agent-runner
  git grep -n '/ephemeral' -- packages presets container scripts .claude/skills
  git grep -nE 'workspace:(pre-apply|applied|deleted|apply|read|list|diff|usage)' -- packages presets
  git grep -n 'flushWorkspaceBeforeCall' -- packages presets
  git grep -nE 'workspaceRef|workspace_ref' -- packages presets
  git grep -nE 'saveRefused|save-refused|save_refused' -- packages presets
  ```
  Expected intentional hits only:
  - runner-HOME paths `/home/runner/.ax/session` and `~/.ax/proxy-ca` (`sandbox-protocol/bootstrap.ts`, `sandbox-k8s/pod-spec.ts`, `sandbox-subprocess` `<home>/.ax/session`, `credential-proxy`);
  - the §11 canary plants (`.ax/SOUL.md`) and the Task 1 legacy-shim fixtures;
  - `routines/src/reflection-prompt-history.ts` (frozen);
  - the `AX_WORKSPACE_*` names in `env-shape.test.ts` and the bootstrap refusal test;
  - the `DROP COLUMN … workspace_ref`/`save_refused_drained_seq` statements and their migration tests;
  - the `'save-refused'` CHECK value and its comment.
- [ ] **Step 5: Hook-name pins.** `git grep -n` each removed hook and IPC action name. Check the exact-list pins:
  - `presets/k8s/src/__tests__/preset.test.ts`;
  - `packages/mcp-oauth/src/__tests__/e2e.test.ts` (`captureRouteServices`) and `plugin.test.ts`: neither names a removed hook today; confirm, then run `pnpm --filter @ax/mcp-oauth test` (Docker);
  - `presets/k8s/src/__tests__/acceptance.test.ts` `PLUGINS_TO_DROP`.
- [ ] **Step 6: Kind smoke** (`k8s-acceptance-loop` skill; ALWAYS `--context kind-ax-next-dev`, never the default context, which is GKE prod).
  - Build and load the agent image; skip the git-server image. Upgrade the release; if the git-server image is missing on the node, add `--set workspace.backend=local --set gitServer.enabled=false`. Delete the runner pods first, and the storage-helper pod after.
  - Walk:
    1. a chat turn;
    2. upload `report.pdf` twice and ask the agent to list `/tmp/uploads` (expect `report.pdf` and `report (2).pdf`);
    3. ask the agent to write `/files/hello.txt`, then see it in the Files tab (only one section);
    4. delete the runner pod and resume (the agent still sees its uploads and `/files/hello.txt`);
    5. download an upload chip.
  - Record the results in the PR.
- [ ] **Step 7: PR body.** Include §1 (premises), §4 (guards), §5 (boundary review), §6 (data and deploy notes), the grep audit, the mutation evidence from Task 13, the kind smoke, and a `security-checklist` note. The note covers:
  - sandbox boundary: Tasks 4–6;
  - untrusted upload names and the tamper check: Task 3;
  - the download ACL and client-sent blocks: Tasks 1–2;
  - settings loading: §11 and Task 13;
  - IPC removal: Task 10.

---

## 8. Out of scope (follow-ups to return in the handoff)

- Chart/ops card (§16 slice 5): git-server templates, NetworkPolicy, auth secret and image values; the host `AX_WORKSPACE_*` env, and then the `env-shape.test.ts` allowlist entries; `deploy/README.md` (Step 5 is pinned by `kind-tooling-pinned-to-kind-context.test.js`); `deploy/GKE.md`; the §10 reset runbook (`ws-*.git`); `restore-drill-verify.sh`; and the `workspace` PVC gate.
- Remove the now-vestigial `OpenSessionInput.workspaceRoot` / `AgentContext.workspace.rootPath` / session-store `workspace_root`. They are kept here because they are generic, not git-specific, and the cascade touches ~36 files.
- `blob.get` over IPC is unscoped (it is a content-hash capability). This predates this card.
- The artifact `artifact_id` primary key is content-derived and global, so identical bytes published twice can collide. This predates this card.

## 9. YAGNI cuts (logged)

None of these is load-bearing for the acceptance, or each belongs to another card:
- no rename of `AX_EPHEMERAL_ROOT` or `AX_COMMIT_TRACE`;
- no provider-level refusal of ownerless sessions (the runner now refuses to boot without a home);
- no deny-with-hint;
- no path→ID upgrade of old blocks (the design deletes the old-key mapping);
- no `attachments_v1_artifacts.path` drop;
- no narrowing of the CHECK constraints;
- no change to `IDLE_TIMEOUT_MS`;
- no move of IPC schemas into plugin directories.
