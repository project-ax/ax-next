# DB-backed routines cutover

This release deletes authored routine definitions and their current workspace files. It does **not** import them. Defaults, overrides, default history (including orphan default history), and existing default conversation identities survive. Identity, goals, normal workspace files, and `.ax/skill-reflection/last-run.json` are outside the deletion scope.

Schedule downtime. Keep an explicit pre-cutover backup of the database, credential store, and **all** workspace-store volumes together. Authored-data deletion is irreversible without that backup. An older image alone is not a rollback: restore the old schema, data, credentials, and workspaces together before starting an old host. Never start a sync-capable old host after the migration.

1. Stop every host and runner that can write workspaces. For the git-server backend, also stop the git-server writer before offline maintenance. Mount its persistent store read/write in an isolated maintenance process running as the store owner (the same UID/GID as its writer) with the new release's CLI available; do not operate on a client mirror cache. Keep writers stopped until verification and deployment finish.
2. Identify the explicit absolute repository root on each store/shard. Local CLI uses `AX_WORKSPACE_REPO_ROOT`; its default is `ax-next-workspace.git` beside the resolved sqlite database file. That directory contains the agent repositories; do not point the command at an individual bare repository. Git-server uses `AX_GIT_SERVER_REPO_ROOT`, set from `gitServer.mountPath` (chart default `/var/lib/ax-next/repo`). Use the mounted maintenance path if different. Run against every active store root.
3. Run the new CLI in dry-run mode, which changes no ref or object:

   ```sh
   ax retire-routine-files --repo-root /absolute/workspace-store
   ```

4. Review the JSON report. `repositories` counts recognized valid layouts; `removed` counts current direct `.ax/routines/*.md` entries that would be deleted. `failures` must be empty. Unknown `.git` layouts and symlinks are failures, never guessed. No content, webhook tokens, secrets, or arbitrary exception messages are printed. Exit 0 means success, 1 maintenance failure, 2 invalid command arguments.
5. Apply the fixed-scope deletion and run dry-run again:

   ```sh
   ax retire-routine-files --repo-root /absolute/workspace-store --apply
   ax retire-routine-files --repo-root /absolute/workspace-store
   ```

   Require `removed: 0` and `failures: []` on **every** root before proceeding. The command only supports direct `ws-<16 lowercase hex>.git` repositories whose symbolic HEAD is `refs/heads/main`. It deletes matching current-tree blob entries, including never-synced files; nested files and non-markdown entries remain outside its exact scope. It creates one ordinary child commit per changed workspace. Old commits remain readable. It does not prune or rewrite history, export/import definitions, or consult online quota.
6. Deploy the new image with offline cleanup complete. The new host's startup migration must finish before admitting traffic or enabling runners. It records authored-definition/fire retirement once, queues exact old HMAC cleanup references, removes the obsolete source column, and preserves canonical defaults. Verify migration success and credential-cleanup completion (retry pending cleanup failures with the new runtime); do not interpret an empty routine list as proof that credential cleanup completed. Verify the retired schema version, absence of old path/source columns, and no outstanding legacy-reference cleanup jobs through the operator's DB inspection channel; never print credential values.
7. Start the new git-server and host, then restore traffic/runners after startup checks. Confirm routine tools and settings work and attempts to put files under the retired prefix receive the core veto. New routine CRUD must work even when workspace quota is full.

If interrupted, rerun the dry-run. A completed commit is idempotent. New loose objects are written and synced to unique temporary files, then published atomically without replacing existing object IDs. An interrupted staging write can leave an unreferenced `.retire-object-*` file; it is retained and does not block retry. Every rewritten tree and commit, including a reused existing object, is decompressed and hash-checked before advancing the ref. `invalid-object` means an existing would-be reused object is corrupt (including a partial object left by an older writer); maintenance refuses to advance HEAD. Keep writers stopped and have the store operator inspect or restore the affected object from the coordinated backup before retrying. The command does not silently overwrite or remove corrupt objects. `ref-changed` means a writer changed the workspace: stop all writers, inspect the store, then retry. `ref-locked` leaves the existing `refs/heads/main.lock` untouched. Only after proving no process owns that lock may an operator remove that exact stale lock and retry; the command never removes another process's lock. `unsafe-path`, `unexpected-repository`, or `unexpected-layout` requires operator inspection before continuing. `maintenance-failed` is deliberately redacted; investigate locally without publishing repository bodies or secrets.

This runbook does not authorize live cleanup by automated tests. Acceptance uses disposable kind test stores only, with every cluster command explicitly selecting `--context kind-ax-next-dev`.
