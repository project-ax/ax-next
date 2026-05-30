# TASK-68 — Attachments & artifacts onto the blob store; /ephemeral working tier

**Branch:** `auto-ship/TASK-68-attachments-artifacts-blob`
**Design:** `docs/plans/2026-05-30-out-of-git-design.md` Part C (Phase 3). Builds ON TASK-65's `blob:*` store.

## Goal

Move large files (inbound uploads, outbound artifacts) off git onto the content-addressed
`blob:*` store (TASK-65), with `/ephemeral` as the disposable sandbox working copy. Add the
first runner-side caller of `blob:put` and, with it, the IPC binary `blob.*` action + the
REQUEST-direction `callBinary` channel (today response-direction only). Drop
`attachments:commit → workspace:apply` (git) and the shared-mirror parent-mismatch race.

## Invariants / boundary review

- **I1 (storage-agnostic hooks):** new hook payloads carry only `conversationId`/`sha256`/
  `displayName`/`mediaType`/`size`/`path` — no `bucket`/`oid`/`lfs`/`pod`/`socket`. `sha256`
  is a content hash (the existing `attachments:commit` output already exposes it), not a
  backend pointer. Talk to the blob store via `blob:put`/`blob:get` hooks, never an import.
- **I2 (no cross-plugin imports):** attachments/artifacts plugins reach the blob store via
  `bus.call('blob:put'/'blob:get')`. The runner reaches the host via IPC only.
- **I3 (no half-wired):** every part ships producer + consumer + canary in this PR. The
  `callBinaryUpload` channel + `blob.put`/`blob.get`/`attachment.publish`/`artifact.publish`/
  `attachments.list` IPC actions all get a live caller here.
- **I4 (one source of truth):** attachment/artifact metadata rows are the single store for
  "what files exist"; bytes are content-addressed (identical bytes once). The transcript
  `attachment` block / `artifact_publish` tool_result keep the `path` as the stable
  display/scope reference; the row maps path→sha256.
- **I5 (capabilities minimized):** `artifact_publish` keeps lstat (symlink reject) + size cap
  + path allowlist (now `/ephemeral/artifacts/**` + `/permanent/workspace/**`). Upload bytes
  are untrusted; stored opaque, never executed. Download keeps the full ACL ladder.

**Boundary review (new/changed hooks):**
- `blob.put` / `blob.get` (IPC actions): alternate impl = fs vs s3 blob backend behind
  `blob:*`. No leaky field (`sha256` is content hash). Wire: bytes ride octet-stream
  (request body for put, response body for get); JSON envelope `{sha256,size}` schema in
  `@ax/ipc-protocol`.
- `attachments:commit` (hook signature UNCHANGED — same `CommitInput`/`CommitOutput`): only
  internal impl changes (blob:put + row instead of workspace:apply). No boundary review needed
  per the "internal-only change" rule — BUT it drops a `calls: ['workspace:apply']` and adds
  `calls: ['blob:put']`, a manifest change, noted in PR.
- `attachments:download` (hook signature UNCHANGED): internal impl swaps workspace:read for
  row→blob:get. Manifest: drop `workspace:read`, add `blob:get`.
- `attachment.publish` / `artifact.publish` / `attachments.list` (IPC actions): host-side
  metadata writers/readers. Alternate impl = any metadata store behind the hook the handler
  calls. Schemas in `@ax/ipc-protocol`.

## Tasks (independent, testable)

### Task 1 — IPC protocol: `blob.put` / `blob.get` / `attachment.publish` / `artifact.publish` / `attachments.list` schemas
`@ax/ipc-protocol/src/actions.ts` (+ `index.ts` exports, `timeouts.ts`, `IpcActionName`).
- `BlobPutResponseSchema = {sha256, size}` (request body is raw bytes — no request schema).
- `blob.get` request `{sha256}` (validated like OID regex) → binary response (no JSON schema,
  like materialize).
- `ArtifactPublishRequestSchema {conversationId, sha256, displayName, mediaType, size, path}`
  → `{artifactId, downloadUrl}`. `AttachmentPublishRequestSchema {conversationId, sha256,
  displayName, mediaType, size, path}` → `{attachmentId}`. (Used by host metadata insert.)
- `AttachmentsListRequestSchema {conversationId}` →
  `{files: [{path, sha256, mediaType, displayName, sizeBytes}]}`.
- Add timeouts + register in `IpcActionName`. Test: schema accept/reject vectors.

### Task 2 — IPC client: `callBinaryUpload` (REQUEST-direction) + extend `callBinary` union with `blob.get`
`@ax/ipc-protocol/src/ipc-client.ts`.
- `callBinaryUpload<Action extends 'blob.put'>(action, payloadHeader, bytes: Buffer)`: POST
  raw bytes as `application/octet-stream`, JSON metadata (none for blob.put — payload is empty)
  ... actually blob.put needs NO metadata; the bytes ARE the payload. Implement
  `callBinaryUpload(action, bytes: Buffer): Promise<unknown>` posting octet-stream body,
  parsing the small JSON response via a schema lookup. Reuse the retry loop (idempotent:
  blob.put is content-addressed, safe to replay; mark it a short-budget non-replay? — blob.put
  IS idempotent so wall-clock retry is safe).
- Extend `callBinary` action union to `'workspace.materialize' | 'workspace.export-baseline-bundle' | 'blob.get'`.
- Tests: upload posts octet-stream + parses `{sha256,size}`; over-cap rejects; blob.get streams
  to file.

### Task 3 — IPC host dispatcher: `blob.put` (raw-body) + `blob.get` (binary) + metadata actions
`@ax/ipc-core` new handlers + `dispatcher.ts` wiring + `@ax/ipc-server` listener (raw-body path).
- `blob.put`: read RAW request body (octet-stream, NOT readJsonBody) under a 100 MiB ceiling
  (stream/buffer), call `blob:put`, return `{sha256,size}`. Needs a new raw-body branch in the
  dispatcher (the existing path always `readJsonBody`s).
- `blob.get`: readJsonBody `{sha256}` → `blob:get` → binary response (HandlerBinary).
- `attachment.publish` / `artifact.publish`: JSON → call host metadata hook
  (`attachments:publish-blob` / `artifacts:publish-blob`) → insert row, return id.
- `attachments.list`: JSON `{conversationId}` → host hook → list. ctx.userId scopes it.
- `DISPATCHER_DEPENDENCIES` gains the new service hooks. Tests: each handler + dispatcher
  routing + raw-body cap.

### Task 4 — Attachments plugin: blob-backed store + metadata rows; rewrite `commit`, `download`; new `publish-blob` + `list`
`@ax/attachments`.
- Migration: `attachments_v1_files {attachment_id, conversation_id, user_id, sha256, path,
  display_name, media_type, size_bytes, created_at}` keyed by (conversation_id, path) unique.
- `attachments:commit` impl: get temp row → `blob:put(bytes)` → insert files row (path =
  `.ax/uploads/<conv>/<turnId>/<file>`) → delete temp → return `CommitOutput` (unchanged shape).
  DROP the workspace:apply retry loop.
- `attachments:download` impl: keep ACL ladder; final fetch = files-row lookup by
  (conversationId, path) → sha256 → `blob:get` → bytes. (Artifacts: also look up artifact row.)
- New `attachments:list-for-conversation` hook (the host IPC `attachments.list` source).
- New `attachments:publish-blob` hook (insert a files row from already-stored sha — used by the
  IPC `attachment.publish`; mostly artifacts use the parallel artifacts plugin path — see Task 5).
- Manifest: drop `workspace:apply`/`workspace:read`, add `blob:put`/`blob:get`. Tests:
  round-trip commit→download via a mock blob store; de-dup (same bytes → one sha); digest verify.

### Task 5 — Artifacts metadata: where artifact rows live (decision in plan)
The host needs an artifact metadata store mirroring attachments. **Decision:** add an
`artifacts_v1_files` table + `artifacts:publish-blob` + `artifacts:get-blob` hooks. Cheapest
home that avoids a new package: put them in `@ax/attachments` (it already owns the upload/
download REST surface + the download ACL scans BOTH attachment blocks AND artifact_publish
tool_results). So `@ax/attachments` owns both `attachments_v1_files` and `artifacts_v1_files`
and the download handler resolves either. The IPC `artifact.publish` action calls
`artifacts:publish-blob`; download resolves an artifact path the same way. (One plugin, one
download ACL, one source of truth for "files for a conversation".)
- Implement `artifacts:publish-blob {conversationId, sha256, path, displayName, mediaType,
  size}` → `{artifactId}` (artifactId = sha256.slice(0,16), matching the executor's existing
  contract) and have `attachments:download` resolve an artifact path via the artifacts table
  too. Tests in @ax/attachments.

### Task 6 — Runner artifact executor → /ephemeral/artifacts + blob.put + artifact.publish
`@ax/tool-artifact-publish` (path-allowlist, descriptor) + `@ax/agent-claude-sdk-runner`
(artifact-publish-executor).
- `path-allowlist.ts`: allowed prefixes → `/ephemeral/artifacts/` (primary) +
  `/permanent/workspace/` (Pattern A double-home); drop `/permanent/.ax/artifacts/`. The
  allowlist is now SPLIT across two roots (`/ephemeral/` and `/permanent/`), so refactor
  `checkPublishablePath` to take the root prefix into account. Executor maps `/ephemeral/<rel>`
  → `ephemeralRoot/<rel>` and `/permanent/<rel>` → `workspaceRoot/<rel>`.
- `descriptor.ts`: flip description — artifacts go under `/ephemeral/artifacts/**`; "the bytes
  are stored durably on publish; nothing is committed."
- Executor: after lstat→cap→read→sha256, `callBinaryUpload('blob.put', bytes)` then
  `client.call('artifact.publish', {conversationId, sha256, displayName, mediaType, size, path})`
  → return `{artifactId, downloadUrl: ax://artifact/<id>, ...}`. Needs the executor to receive
  the IPC client + conversationId (wire in main.ts). Tests: executor calls blob.put + publish,
  durability at return; allowlist accept/reject for both roots.

### Task 7 — Runner session-start materialization of /ephemeral/uploads + re-root
`@ax/agent-claude-sdk-runner` (main.ts, pre-tool-use.ts, attachment-translation wiring).
- At session start (after materializeWorkspace, when ephemeralRoot + conversationId set):
  `client.call('attachments.list', {conversationId})` → for each, `callBinary('blob.get',
  {sha256})` → write to `<ephemeralRoot>/uploads/<conv>/<turnId>/<file>` (derive subpath from
  the stored `path` minus the `.ax/uploads/` segment). Best-effort (a missing blob → skip +
  log, like the materialize degradations).
- `pre-tool-use.ts`: re-root key stays `.ax/uploads/`, but re-root TARGET becomes
  `<ephemeralRoot>/uploads/...` instead of `<workspaceRoot>/.ax/uploads/...`. Thread
  ephemeralRoot into the pre-tool-use deps.
- attachment-translation reader: read the materialized local file (or fetch via blob.get) for
  inline/image bytes instead of `workspace.read`. Tests: materialize loop writes files;
  re-root points at ephemeral; reader returns bytes.

### Task 8 — Wire-in + presets/k8s + canary (close the half-wired window)
- `presets/k8s/src/index.ts`: register `@ax/blob-store-fs` (root from a new
  `AX_BLOB_STORE_ROOT` env, defaulting to a PVC path under `/ephemeral`-equivalent host dir —
  actually a host-side durable dir, distinct from the sandbox `/ephemeral`). Add the blob hooks
  to the IPC server's `DISPATCHER_DEPENDENCIES` consumers. Chart: stamp the env.
- Update preset canaries (`acceptance.test.ts` / `multi-tenant-acceptance.test.ts`
  PLUGINS_TO_DROP + any verifyCalls stubs for the new `blob:*` / `attachments:*` hooks).
- Make sure the existing artifact-publish e2e canary + attachments routes tests pass with the
  new backend (update them).

### Task 9 — Remove dead git-attachment machinery touched here (scoped subset of Part E)
Only what THIS card's drop-attachments:commit→workspace:apply implies; the full LFS-layer
delete is TASK-70. Concretely: the `attachments:commit` workspace:apply path + the
`commit` handler's parent-mismatch retry loop. Do NOT touch the LFS server or runner
`git lfs install` (TASK-70 owns those). Note the boundary in the PR.

## YAGNI pass
- S3 backend, MinIO/GCS wiring, presigned transfer → Phase 6 of design, OUT of scope. DEFER.
- Blob GC / reference counting → design open-question #3, OUT of scope. DEFER (note: a deleted
  attachment/artifact row leaves an orphan blob; acceptable for now, GC is a follow-up).
- Full LFS-layer delete → TASK-70. DEFER.
- Transcript / display-event-log (Part B) → TASK-66/other. OUT of scope.

## Security-checklist
Required (IPC + untrusted blob storage + sandbox path handling). Run before Task 4/6/7 land.
Key points: blob keys are sha256 (no traversal); artifact_publish keeps lstat+cap+allowlist;
upload bytes opaque, never executed; displayName/mediaType untrusted text to renderers;
download ACL ladder unchanged; raw-body upload capped at 100 MiB.
