# TASK-576 — facts memory becomes the default; old memory is wiped once

**Owner rulings (Vinay, 2026-09-27):** switch now (no re-measure gate); wipe old
memory completely on ALL deployments, including production — delete every agent's
Strata docs from its workspace, purge them from that workspace's history, clear
facts rows; keep `@ax/memory-strata*` until this ships and is walked, then delete
it in a separate card.

This plan is the load-bearing slice: the default switch plus the one-time wipe.

## What "old memory" means here (scope — decided, not guessed)

Per agent workspace:

| Path | Wiped? | Why |
|---|---|---|
| `memory/**` except `memory/system/rules.md` | tree + history | The Strata tier (`AGENT_TIER_MEMORY_ROOT='memory'`): `system/{agent,user,session,recent,map}.md`, `system/.map-cache.json`, `inbox/**`, `docs/**`, plus anything a runner wrote there. `agent.md` is a derived copy of `.ax/IDENTITY.md`+`.ax/SOUL.md`, which are untouched. |
| `memory/system/rules.md` | **kept**, history kept | Human-authored Rules; `memory:rules:*` is the shared contract and `@ax/memory` reads/writes the SAME path (`MEMORY_RULES_PATH`). The card says Rules carry over. |
| `permanent/memory/facts/**` | tree + history | The facts export: a host-owned, wholesale-regenerated projection of the facts rows we are clearing. Keeping it would keep the cleared rows' text. |
| facts rows (`memory:facts:clear`) | cleared | Ruling 2. |
| NFS export volume, agent slot | emptied | Same projection as the workspace facts export; the runner mounts it at `/memory`. |
| everything else in the workspace | untouched, history untouched | Tests prove per-commit metadata + non-memory trees are byte-identical. |

Out of scope, returned as follow-ups: the Strata postgres index table
(`memory_strata_index_v2_docs`, a copy of doc text; unreachable under the memory
preset — drop it in the Strata-deletion card), the never-written postgres facts
table, repos of already-deleted agents (no agent id to derive them from).

## Tasks

1. **core** — `workspace:purge` types + `returns` schema in `packages/core/src/workspace.ts`.
   Input `{ prefixes: string[]; keep?: string[] }`, output
   `{ purged: string[]; version: WorkspaceVersion | null; pastVersionsChanged: boolean }`.
   Backend-agnostic: "remove every path under these prefixes (except `keep`) from the
   current version AND every retained past version, irrecoverably".
2. **`@ax/workspace-git-purge`** (new shared package, allow-listed like
   `@ax/user-files-read`): `purgeHistoryPaths({ gitdir, prefixes, keep, runGit })`.
   Caller injects `runGit` (each backend keeps its own paranoid spawn env). Algorithm:
   recover leftover `refs/ax-purge/*` → refuse unknown refs → detect matching paths
   across all history (`git log --all --name-only -z --root -m -- <literal pathspecs>`)
   → if none and not recovering: no-op → `fast-export --no-data` of main, filter
   `M`/`D` lines (byte-exact data-block skipping, C-quoted path unquoting, refuse
   `C`/`R`/unknown refs) → `fast-import` into `refs/ax-purge/main` → VERIFY (no matching
   path in new history; commit count equal; per-commit metadata + non-memory raw diffs
   + keep-path raw diffs byte-identical old vs new) → CAS `update-ref main new old`
   → `reflog expire --expire=now` + `gc --prune=now` → delete temp ref → verify no
   matching path reachable and no unreachable objects left.
3. **workspace-git-core** registers `workspace:purge` under the per-repo mutex
   (clears `refs/bundle/*` first; missing repo → `{purged:[], version:null}` without
   creating one).
4. **workspace-git-server**: server route `POST /repos/<id>/purge` (JSON, same auth,
   strict schema) running task 2 server-side; client plugin registers
   `workspace:purge` → route → drops the host mirror-cache entry.
5. **facts clear count** — `memory:facts:clear` returns `{ removed: number }`
   (sqlite + postgres) so the migration can log counts.
6. **`@ax/memory` migration** (`strata-retirement.ts`), config-gated
   (`retireOldMemory: true`), runs at the end of `init()`:
   global `complete` marker → no-op; otherwise read-or-write the COHORT (agent ids at
   first run, `agents:list-ids`); per cohort agent without a `done` marker:
   `workspace:purge` → `memory:facts:clear` → empty the export volume slot → set the
   agent's `done` marker; after all → set `complete`. Any failure throws a PluginError
   naming agent + step (boot fails; re-run resumes — every step is idempotent or
   guarded by the marker). One log line per agent: counts + paths, never content.
7. **memory preset** turns the migration on; canary seeds an agent with Strata docs +
   facts rows + other files, boots, asserts the wipe, reboots, asserts no-op.
8. **Defaults**: `serve.ts` AX_PRESET default `memory` (+ help text); chart
   `host.preset: memory` (values, gke-values, kind-dev-values with the dev NFS),
   inert `config.preset`, validator messages naming both memories, chart tests,
   `deploy/GKE.md` (NFS export requirement + the irreversible wipe warning).

YAGNI: no dry-run mode (the card's dry-run was for import, option b; wipe has
nothing to preview beyond the log), no import, no Strata deletion.

---

## REVISED RULING (Vinay, 2026-09-27, later the same day) — supersedes the wipe above

The owner doesn't need to keep **any** old memory data, so rewriting each agent's
git history is unnecessary. The ruling is now "drop tables + reset git-server":

1. **Removed from the PR entirely:** `@ax/workspace-git-purge`, the core
   `workspace:purge` hook, the purge implementations in workspace-git-core and
   workspace-git-server (and their SECURITY.md edits), `@ax/memory`'s
   `old-memory-wipe.ts` and its boot wiring, the `memory:facts:clear → {removed}`
   change (it existed only for the wipe's logs), and every test for them. Tasks 1–7
   above are void.
2. **Kept:** facts memory is the chart and CLI default (task 8). The memory NFS
   export (`memory.exports`) is now **optional**, so a default `helm install`
   renders and boots. Without the export, runners get no read-only `/memory`
   mount. Recall, Rules and the Memory tab are unaffected. `gke-values.yaml` pins
   `host.preset: memory`.
3. **Replaced by an operator runbook**, "Switching an existing deployment to facts
   memory" in `deploy/README.md` (linked from `deploy/GKE.md`). It is run by hand,
   once, never by code:
   - drop `memory_strata_index_v2_docs` and truncate the postgres `memory_facts_v1`;
   - remove the SQLite facts store (and the NFS export contents);
   - reset workspace storage: delete the git-server StatefulSet's `repo-*` PVCs
     for `git-protocol` (kind), or the `ws-*.git` repos on the host PVC for
     `local`. The production (GKE) backend is `local`, so it has no git-server.
     Its volume also holds blobs, so the runbook deletes the repos, not the volume.

   The runbook says loudly that the reset deletes ALL agents' workspace repos
   and files, not just memory, and that it can't be undone.
