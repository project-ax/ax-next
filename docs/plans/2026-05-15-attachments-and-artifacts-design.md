# Attachments & artifacts — design

**Status:** Proposed
**Date:** 2026-05-15
**Related:**
- `2026-05-01-workspace-redesign-design.md` (three-tier topology, bundle wire, git smart-HTTP storage)
- `2026-04-29-runner-owned-sessions-design.md` (runner-native transcripts; source of truth for ContentBlock storage)
- `CLAUDE.md` (the five invariants this design lands against)

---

## Goal

Two coupled capabilities that share substrate:

1. **User-uploaded attachments on chat messages.** Users can attach images and files (PDFs, text, JSON, archives, etc.) when sending a message. Image attachments are seen directly by the model; non-image attachments are placed in the workspace where the agent can `file_read` them via existing tools.

2. **Agent-published artifacts in chat responses.** The agent calls a dedicated `artifact_publish` tool with a workspace path; the tool returns a stable, channel-portable URL (`ax://artifact/<id>`-shaped) that the agent embeds in its text response. The user clicks and downloads.

Both capabilities are channel-agnostic by construction — the web channel ships day-1, but the same transcript shape renders correctly in a future Slack channel plugin (or any other channel) with no per-channel storage forks.

Storage is the existing workspace git repo with LFS for binaries. No new persistence tier.

### Non-goals (deferred)

- **Pre-signed direct-to-storage uploads.** Bytes proxy through the host pod. Simpler ACL story; revisit if upload throughput becomes a problem.
- **Link permanence past file deletion in `main`.** `ax://attachment/...` 404s if the file is gone from HEAD. Stock git/LFS GC applies; no special pinning refs, no special GC story.
- **Cross-conversation sharing or content-deduped global blob store.** Each upload commits under a per-conversation path; identical bytes uploaded twice produce two LFS blobs (LFS will dedupe by sha256 in practice, but we don't rely on it for correctness).
- **Format-specific server-side processing.** No OCR, no PDF→text extraction, no archive unpacking. The agent reads attachments via existing tools.
- **Multipart in the existing chat-messages endpoint.** A separate `/api/attachments` endpoint handles binary uploads; the JSON-bodied `/api/chat/messages` only carries references.
- **Bulk download (zip everything).** Single-file only at v1.
- **Validators on uploads** (virus scan, file-type policy beyond MIME allowlist). The `workspace:pre-apply` hook from the workspace redesign already exists; subscribers are independent work.

### Caps (v1)

- 25 MiB per file, 100 MiB total per message. Configurable in plugin config.
- 200 MiB outstanding pending-attachment quota per user (uploaded but not yet sent).
- HTTP body cap at `/api/attachments` enforces the per-file ceiling at the framework boundary.

---

## How this design lands the five invariants

| Invariant | How this design satisfies it |
|---|---|
| **I1** — No storage vocabulary in hook payloads | New hooks (`attachments:store-temp`, `attachments:commit`, `attachments:download`) carry workspace + filesystem vocab only: `attachmentId`, `path`, `displayName`, `mediaType`, `sizeBytes`, `sha256`. No `lfs_oid`, no `bucket`, no `pack_file`. Alternate impl: a future Postgres-BYTEA-backed `@ax/attachments-pg` plugin would register the same hooks with the same shapes — only the in-process impl swaps. |
| **I2** — No cross-plugin imports | `@ax/attachments` (new) reaches `@ax/workspace-git` only through bus hooks (`workspace:apply` for commit, `workspace:read` for download). `@ax/tool-artifact-publish` (new) and `@ax/channel-web` (extended) similarly reach `@ax/attachments` only through bus. |
| **I3** — No half-wired plugins | Day-1 PR ships *both* sides reachable from the canary acceptance test. Upload-side adapter wired into the Composer + download endpoint, AND the artifact-publish tool registered + rendered as a chip. The canary attaches a file, gets a response with an artifact, downloads it. |
| **I4** — One source of truth | The workspace IS the storage. The conversation transcript references workspace paths; the conversation row stores no duplicate metadata. Download resolution is: `path` → `workspace:read` at current HEAD. Attachment metadata travels with the transcript blocks, not as a side table. |
| **I5** — Capabilities minimized | `/api/attachments` requires auth + CSRF. The `artifact_publish` tool only reads paths the agent already has access to in the sandbox; no escalation. The tool refuses paths outside an explicit allowlist. Download endpoint validates conversation ownership AND path-scope (path must be in the conversation's transcript). Bytes validated against MIME allowlist + size cap at HTTP boundary. |
| **I6** — One UI design language | Composer attach chip and inline download chip both compose existing shadcn primitives + `lucide-react` icons. No new color tokens. assistant-ui primitives (`ComposerPrimitive.AttachmentDropzone`, `AttachmentPrimitive.unstable_Thumb`, etc.) provide the structural composition. |

---

## Architecture overview

```
┌─────────────────────────────────────────────────────────────────────┐
│ Browser (channel-web SPA)                                           │
│                                                                     │
│   <Composer>                                                        │
│     ├─ ComposerPrimitive.AttachmentDropzone (drag-and-drop)         │
│     ├─ ComposerPrimitive.AddAttachment      (existing button)       │
│     ├─ ComposerPrimitive.Attachments        (in-composer chips      │
│     │                                        with thumbnail + remove│
│     │                                        before send)           │
│     └─ AxAttachmentAdapter (new)                                    │
│          .add(file)  ──── POST /api/attachments  ──┐                │
│          .send(att)  ──── returns ThreadUserMessagePart             │
│                                                    │                │
│   <Thread> rendering                               │                │
│     ├─ AttachmentChip (user-message side)          │                │
│     └─ ArtifactChip   (assistant-message side)     │                │
│           click ──── GET /api/files ───────────────┼─────┐          │
└────────────────────────────────────────────────────┼─────┼──────────┘
                                                     │     │
┌────────────────────────────────────────────────────▼─────▼──────────┐
│ Host pod                                                            │
│                                                                     │
│   @ax/http-server                                                   │
│     ├─ POST /api/attachments   (new — multipart)                    │
│     ├─ POST /api/chat/messages (extended — recognizes               │
│     │                           attachment_ref in contentBlocks)    │
│     └─ GET  /api/files         (new — ACL'd byte download)          │
│                                                                     │
│   @ax/attachments (new plugin)                                      │
│     ├─ attachments:store-temp  (postgres-backed temp store, TTL)    │
│     ├─ attachments:commit      (workspace:apply LFS-tracked commit) │
│     └─ attachments:download    (ACL-gated read via workspace:read)  │
│                                                                     │
│   @ax/tool-artifact-publish (new plugin)                            │
│     └─ tools:register('artifact_publish')                           │
│           input  → { path, displayName? }                           │
│           output → { artifactId, downloadUrl, path, displayName,    │
│                      mediaType, sizeBytes, sha256 }                 │
│                                                                     │
│   @ax/workspace-git (existing, unchanged)                           │
│     └─ workspace:apply / read / list / diff                         │
└─────────────────────────────────────────────────────────────────────┘
                       ↕ git smart-HTTP + LFS HTTPS (bearer auth)
┌─────────────────────────────────────────────────────────────────────┐
│ Storage tier (@ax/workspace-git-server, extended)                   │
│   ├─ existing bare repos (<workspaceId>.git/)                       │
│   └─ LFS server endpoints + per-workspace blob store                │
│      (<workspaceId>.lfs/objects/<sha[0:2]>/<sha[2:4]>/<sha>)        │
└─────────────────────────────────────────────────────────────────────┘
                       ↕ bundle protocol over IPC
┌─────────────────────────────────────────────────────────────────────┐
│ Sandbox pod (per-session)                                           │
│   ├─ git binary + git-lfs binary                                    │
│   ├─ runner materializes /permanent at session start                │
│   │   ├─ /permanent/.ax/uploads/<conv>/<turn>/<file>                │
│   │   └─ (other workspace content)                                  │
│   │   LFS smudge filter pulls binary content on checkout            │
│   └─ runner translates `attachment` blocks before LLM call:         │
│       attachment(image/*) → Anthropic image block                   │
│       attachment(other)   → text mention "User attached X at <path>"│
└─────────────────────────────────────────────────────────────────────┘
```

### Plugin inventory

**New plugins (2):**

1. `@ax/attachments` — host-side. Temp store + commit + ACL'd download.
2. `@ax/tool-artifact-publish` — host-side. Registers the `artifact_publish` tool against the existing tool-dispatcher.

(`AxAttachmentAdapter` is not a separate plugin; it's a TypeScript class inside `@ax/channel-web`.)

**Extended packages:**

- `@ax/channel-web` — `AxAttachmentAdapter`, the chip UI components, the new routes (`/api/attachments`, `/api/files`), the markdown link detection for `ax://artifact/<id>`.
- `@ax/workspace-git-server` — LFS batch + storage endpoints.
- `@ax/ipc-protocol` — new `attachment` and `attachment_ref` ContentBlock variants.
- `@ax/agent-claude-sdk-runner` — pre-LLM translation pass for `attachment` blocks; `git lfs install --local` at session start.

---

## Hook surface (the inter-plugin API)

### `@ax/attachments` service hooks

```typescript
// Stage uploaded bytes in a host-local temp store. Used by POST /api/attachments.
//
// Returns an opaque attachmentId. The actual commit-to-workspace happens later
// at message-send time (so we don't commit files the user never actually sent).
//
// ACL: route gates auth before calling. The temp store row records
// (userId, attachmentId) so a different user can't redeem the attachmentId
// on send. Cross-user redemption raises `forbidden`.
attachments:store-temp
  (ctx, { bytes: Buffer; displayName: string; mediaType: string }) →
  { attachmentId: string; sizeBytes: number; expiresAt: string /* ISO 8601 */ }

// Commit a previously staged temp to the workspace. Called by
// POST /api/chat/messages when handling user contentBlocks that include
// attachment_ref blocks.
//
// Does: read temp bytes, compute sha256, workspace:apply commit to
// `.ax/uploads/<conversationId>/<turnId>/<server-sanitized-filename>`
// with LFS tracking, then delete the temp row.
//
// Idempotent: a second call with the same attachmentId after a successful
// commit returns the same `{ path, sha256, mediaType, sizeBytes, displayName }`
// (looked up from the workspace state). No second commit.
//
// Errors:
//   not-found      attachmentId expired or not present
//   forbidden      attachmentId owned by a different user
attachments:commit
  (ctx, { attachmentId: string; conversationId: string; turnId: string }) →
  { path: string; sha256: string; mediaType: string; sizeBytes: number;
    displayName: string }

// Read bytes for a workspace path under the conversation's scope.
//
// Path-scope ACL lives INSIDE this hook (not the route handler) so all
// callers — channel-web's GET /api/files today, a future Slack channel
// plugin tomorrow — get the same enforcement. Path-scope rule:
//
//   either path starts with `.ax/uploads/<conversationId>/`,
//   or path appears in some `attachment` block / `artifact_publish`
//      tool_result in conversation's transcript.
//
// Validation done inside the hook BEFORE workspace:read:
//   - path normalized; reject `..`, leading `/`, `//`, length > 1024 chars
//   - conversations:get({ conversationId, userId }) — owner gate
//   - path-scope check against the transcript
//   - workspace:read — refuse symlinks (tree mode 120000)
//
// Errors:
//   forbidden  conversationId not owned by userId, OR path not in scope
//   not-found  path normalized invalid, OR file not in main, OR symlink refused
//
// Returns the displayName + mediaType + sizeBytes sourced from the
// matching transcript block (so a renamed file's display name stays
// stable across renames; the bytes come from the path).
attachments:download
  (ctx, { path: string; conversationId: string; userId: string }) →
  { bytes: Buffer; mediaType: string; sizeBytes: number; displayName: string }
```

### `@ax/tool-artifact-publish` (no new hook surface)

This plugin subscribes to `tools:register` and registers `artifact_publish` against `@ax/tool-dispatcher`.

```
Tool: artifact_publish

Input schema:
  {
    path: string          // workspace-absolute path under /permanent/
                          // (must be readable by the agent in its sandbox)
    displayName?: string  // optional; defaults to basename(path)
  }

Allowlist (enforced by the tool, returned as tool_result.is_error on miss):
  Only paths matching these prefixes are publishable:
    - /permanent/workspace/**     (user project content)
    - /permanent/.ax/artifacts/** (explicit artifact namespace)
  Any other path → tool_result.is_error: true,
                   content: "artifact-path-not-publishable: <reason>"

Other validations (also raise is_error):
  - file must exist (real regular file, not a directory)
  - file must not be a symlink (mode != 120000)
  - file size must be <= 100 MiB

Tool output (tool_result content — JSON-encoded string):
  {
    artifactId:   string,   // sha256[0:16] — short, hex
    downloadUrl:  string,   // "ax://artifact/<artifactId>"
    path:         string,   // workspace-RELATIVE path (e.g. "workspace/reports/Q4.pdf").
                            // The tool strips the `/permanent/` prefix from the input
                            // path before storing. Workspace-relative paths match what
                            // workspace:read expects and what the path-scope ACL check
                            // compares against in attachment blocks.
    displayName:  string,
    mediaType:    string,   // sniffed from extension; uses application/octet-stream as fallback
    sizeBytes:    number,
    sha256:       string,
  }

Side effects:
  - None at tool-call time. The runner's existing `git add -A` + commit at
    turn end naturally includes the file. The tool does NOT commit early.
```

No `artifacts:published` subscriber hook. Channels render by scanning the
assistant turn's `tool_use` blocks for `name === 'artifact_publish'` and
matching the corresponding `tool_result`. Equally usable on history-load
(cold open) and live turns — single rendering path.

### `@ax/ipc-protocol` — ContentBlock extensions

Two new variants added to the `ContentBlockSchema` discriminated union:

```typescript
export const AttachmentRefBlockSchema = z.object({
  type: z.literal('attachment_ref'),
  attachmentId: z.string(),
});

export const AttachmentBlockSchema = z.object({
  type: z.literal('attachment'),
  path: z.string(),          // workspace-relative, e.g. ".ax/uploads/<conv>/<turn>/foo.pdf"
  displayName: z.string(),
  mediaType: z.string(),
  sizeBytes: z.number(),
});
```

Wire flow:

- **Browser → server (POST /api/chat/messages):** `attachment_ref` blocks (just the attachmentId).
- **Server-side rewrite inside the chat-messages handler:** for each `attachment_ref`, call `attachments:commit({ attachmentId, conversationId, turnId })`, replace the block with an `attachment` block carrying the full metadata.
- **Stored in transcript:** `attachment` blocks only. `attachment_ref` exists only in transit on the request body.
- **Runner translation (before LLM call):** `attachment` blocks → Anthropic types:
  - `mediaType` matches `image/*` → Anthropic `image` block, with bytes read from the workspace path and base64-encoded.
  - `mediaType === 'application/pdf'` AND the pinned Anthropic SDK supports `document` blocks → Anthropic `document` block; otherwise text mention. Feature-detected at translation-pass call time.
  - Otherwise → text mention: `"User attached '<displayName>' at <path>"`.
- **Replay from transcript:** the same translation runs again. The `attachment` block is the single source of truth; the Anthropic shape is derived per LLM call.

This is the **one Anthropic-compat break** in the design — `attachment` isn't an Anthropic block type. We own the translation at the runner boundary, so it doesn't leak past our boundary.

---

## Wire surfaces (REST + frontend adapter)

### `POST /api/attachments`

Multipart upload. One file per request (keeps progress accounting clean; multi-file selection triggers N requests in parallel from the adapter).

```
Request:
  Content-Type: multipart/form-data
  Part:  name="file"  filename="<userFilename>"  (binary)

Headers required:
  Cookie: <session>
  X-Requested-With: ax-admin   (CSRF — same posture as existing endpoints)

Response 200:
  {
    attachmentId: string,
    sizeBytes:    number,
    mediaType:    string,
    displayName:  string,
    expiresAt:    string    // ISO 8601
  }

Errors:
  400  invalid-payload
  401  unauthenticated
  413  payload-too-large            (> 25 MiB)
  415  unsupported-media-type       (MIME not in allowlist)
  429  too-many-pending             (per-user quota — 200 MiB outstanding)
  500  internal
```

**MIME validation.** Server reads the multipart part's `Content-Type` header. Default allowlist (configurable per agent):
- `image/png`, `image/jpeg`, `image/gif`, `image/webp`
- `application/pdf`
- `text/plain`, `text/csv`, `text/markdown`
- `application/json`
- `application/zip`
- `application/octet-stream` (with the per-file size cap)

**MIME spoofing.** We do not sniff file contents to confirm the claimed MIME at v1. The agent doesn't *execute* uploaded content (it only reads bytes via tools), so the blast radius is bounded. Documented limitation. Future hardening could add content-type sniffing.

**Filename sanitization.** Uploaded filename from the multipart part header becomes `displayName` verbatim. The on-disk path component is server-constructed: `<random-8-hex>__<sanitized>` where `sanitized` is the filename with everything outside `[A-Za-z0-9._-]` collapsed to `_`. Path traversal (`../`, leading `/`) is impossible because the user never supplies a path component — the full on-disk path is derived from server state.

### `POST /api/chat/messages` (extended)

Existing route; extended to recognize `attachment_ref` items in `contentBlocks`.

```
Body (extended ContentBlock union):
  {
    conversationId: string | null,
    agentId:        string,
    contentBlocks:  Array<
      | { type: 'text', text: string }
      | { type: 'attachment_ref', attachmentId: string }
    >
  }
```

Server flow change:

1. Resolve conversationId (existing path: create or get).
2. Allocate the user `turnId` (server-minted).
3. For each `attachment_ref` block:
   - `attachments:commit({ attachmentId, conversationId, turnId })`.
   - Replace the block with an `attachment` block carrying the returned metadata.
4. Enforce per-message total size cap: sum of `sizeBytes` across all attachment blocks must be ≤ 100 MiB. Over → 413.
5. Continue with existing `agent:invoke` dispatch.

Atomicity: all attachment commits succeed or the entire message fails (and the agent is not invoked). On any commit failure, the temp-store rows remain in place (TTL janitor cleans them; the user can retry).

Errors specific to this extension:

```
400 attachment-not-found        attachmentId expired or unknown
400 attachment-foreign-user     attachmentId owned by a different user
413 attachment-total-too-large  per-message total > 100 MiB
```

### `GET /api/files`

Channel-portable download. Used by web's `AttachmentChip` and `ArtifactChip` click handlers. The `ax://artifact/<id>` URL (returned by `artifact_publish`) is resolved client-side to this endpoint (browser parses the artifactId, looks up the matching tool_result in the rendered turn, extracts `path`, and navigates to `/api/files?path=...&conversationId=...`).

```
Query:
  path:           string  (workspace-relative path, %-encoded)
  conversationId: string  (ACL scope)

Headers required:
  Cookie: <session>

Response 200:
  Content-Type:           <mediaType>   (sourced from the transcript block)
  Content-Disposition:    attachment; filename="<sanitized displayName>"
  Content-Length:         <sizeBytes>
  X-Content-Type-Options: nosniff
  <bytes>  (streamed)

Response 404:
  {"error": "not-found"}
  Returned uniformly for: missing/invalid path, missing/empty conversationId,
                          forbidden conversation, path not in scope,
                          file removed from main, symlink target.
```

Route handler:

1. `auth:require-user` → 401 on miss.
2. Reject missing/empty `conversationId` query param → 400.
3. Reject path containing `..` segments, leading `/`, `//`, or length > 1024 chars → 400.
4. Call `attachments:download(ctx, { path, conversationId, userId: ctx.userId })`.
5. On `forbidden` OR `not-found` from the hook → 404 (uniform existence-leak).
6. Sets response headers + streams bytes.

Bytes are streamed, not buffered, so large files don't spike host-pod memory.

### Frontend: `AxAttachmentAdapter`

A custom implementation of `AttachmentAdapter` from `@assistant-ui/core`, wired into the `AssistantRuntime` constructor in `App.tsx`. Sketch:

```typescript
import type {
  AttachmentAdapter,
  PendingAttachment,
  CompleteAttachment,
} from '@assistant-ui/core';

export class AxAttachmentAdapter implements AttachmentAdapter {
  accept = 'image/*,application/pdf,text/*,application/json,application/zip';

  async *add({ file }: { file: File }): AsyncGenerator<PendingAttachment> {
    const id = crypto.randomUUID();   // client-side pending id (replaced on response)
    yield {
      id, type: typeFromMime(file.type), name: file.name,
      contentType: file.type, file,
      status: { type: 'running', reason: 'uploading', progress: 0 },
    };

    // POST /api/attachments via XHR (for progress events).
    // Yield PendingAttachment with updated progress as upload streams.
    const result = await uploadWithProgress(file);

    yield {
      id: result.attachmentId,
      type: typeFromMime(result.mediaType),
      name: result.displayName,
      contentType: result.mediaType, file,
      status: { type: 'requires-action', reason: 'composer-send' },
    };
  }

  async send(pending: PendingAttachment): Promise<CompleteAttachment> {
    return {
      id: pending.id,
      type: pending.type,
      name: pending.name,
      contentType: pending.contentType,
      status: { type: 'complete' },
      content: [{
        type: 'file',                              // assistant-ui's part type
        data: `ax://attachment/${pending.id}`,    // resolved server-side to attachmentId
        mimeType: pending.contentType ?? 'application/octet-stream',
        filename: pending.name,
      }],
    };
  }

  async remove(): Promise<void> {
    // No-op. The temp store TTL handles cleanup; we don't need a DELETE endpoint at v1.
    // (Future enhancement: explicit DELETE /api/attachments/<id> for prompt removal.)
  }
}
```

The `AssistantChatTransport` serializes the `ThreadUserMessagePart[]` into the chat request body. A thin translation in `routes-chat.ts` recognizes parts of `type: 'file'` with `data` matching `ax://attachment/<id>` and converts them to `attachment_ref` ContentBlocks before calling `attachments:commit`.

### Composer wiring (channel-web Composer.tsx)

```tsx
<ComposerPrimitive.AttachmentDropzone>
  <ComposerPrimitive.Root>
    <ComposerPrimitive.Attachments
      components={{ Attachment: AttachmentComposerChip }}
    />
    <ComposerPrimitive.Input ref={inputRef} />
    <AttachMenu />                {/* existing AddAttachment file picker */}
    <ComposerPrimitive.Send />
  </ComposerPrimitive.Root>
</ComposerPrimitive.AttachmentDropzone>
```

Two new components:

- `AttachmentComposerChip` — pre-send, in-composer. Wraps `AttachmentPrimitive.Root` with `unstable_Thumb` (image/*) or a file-type icon (other), plus `AttachmentPrimitive.Name` and `AttachmentPrimitive.Remove`.
- `AttachmentChip` — in-transcript user-message rendering. Same visual look but no `Remove` action; click downloads.

Plus one more for assistant turns:

- `ArtifactChip` — renders an artifact. Used both inline (from `tool_use` scan) and via markdown link substitution (from `ax://artifact/<id>` URL detection in `MarkdownText`).

**`unstable_Thumb` is unstable in assistant-ui.** We pin the assistant-ui version in `package.json`; a future major rename is tracked as a maintenance burden, not a design blocker.

---

## Storage tier: LFS configuration

`@ax/workspace-git-server` gains Git LFS server endpoints (standard Git LFS batch API spec, so any `git-lfs` client just works).

### New endpoints (per workspace, mounted under each repo URL)

```
POST /<workspaceId>.git/info/lfs/objects/batch    — negotiate upload/download URLs
PUT  /<workspaceId>.git/info/lfs/storage/<oid>    — blob upload
GET  /<workspaceId>.git/info/lfs/storage/<oid>    — blob download
POST /<workspaceId>.git/info/lfs/verify           — post-upload verification
```

### On-disk layout (per shard)

```
<repoRoot>/
├── <workspaceId>.git/                            (existing bare repo)
└── <workspaceId>.lfs/                            (new — LFS object store)
    └── objects/
        └── <first2>/<next2>/<sha256>             (standard LFS layout)
```

### Auth

Same bearer token the existing git smart-HTTP endpoints use. `crypto.timingSafeEqual` on every request (mirroring the existing `@ax/workspace-git-http` pattern).

### Sandbox + host LFS client config

Both pods get `git-lfs` installed (distro-package version-pinned in Dockerfile).

At workspace materialization:
- The runner runs `git lfs install --local` inside `/permanent`.
- Sets `lfs.url = <storage-tier-base>/<workspaceId>.git/info/lfs` plus the workspace's bearer token in `http.extraheader`.
- Same configuration on the host pod for any host-side reads (the `attachments:commit` impl uses the host's existing local mirror clone).

`.gitattributes` (committed once at workspace init):

```
.ax/uploads/**     filter=lfs diff=lfs merge=lfs -text
*.pdf              filter=lfs diff=lfs merge=lfs -text
*.png              filter=lfs diff=lfs merge=lfs -text
*.jpg              filter=lfs diff=lfs merge=lfs -text
*.jpeg             filter=lfs diff=lfs merge=lfs -text
*.gif              filter=lfs diff=lfs merge=lfs -text
*.webp             filter=lfs diff=lfs merge=lfs -text
*.zip              filter=lfs diff=lfs merge=lfs -text
*.mp4              filter=lfs diff=lfs merge=lfs -text
*.mov              filter=lfs diff=lfs merge=lfs -text
```

User uploads always flow through LFS (every path under `.ax/uploads/`). Agent-published artifacts at arbitrary paths flow through LFS only if their extension matches. Source code, prose, JSON — git-tracked directly, no LFS.

### GC

- Workspace-tier `git gc` runs on its existing cadence.
- `git lfs prune` runs on the storage tier periodically (configurable, default: weekly). Honors standard LFS reachability (referenced from any ref + recent reflog).
- Link-breaks-on-delete is the intended posture: when a file is deleted from `main`, eventually its LFS object becomes unreferenced, gets pruned, and `ax://attachment/...` 404s.

### Bundle-protocol interaction

The sandbox↔host bundle protocol carries LFS *pointer files* (tiny text stubs), not LFS object contents. LFS object transfer happens directly between sandbox/host and the storage tier over the LFS HTTPS endpoints. The bundle protocol stays cheap; only workspace tree shape changes propagate.

### Capability budget delta (storage tier)

- Filesystem: extends to `<repoRoot>/<workspaceId>.lfs/`. Path derived from validated workspaceId (same regex check that already protects `.git` paths).
- Network: still inbound-only on the same port.
- Process spawn: no additional binaries needed (LFS endpoints are HTTP-only on the server side).
- Env: unchanged.

---

## Channel-portable rendering

The contract: **everything a channel needs is in the canonical transcript** — no out-of-band channel coordination.

### User-message attachments

One `attachment` block per attachment in the user turn's `contentBlocks`:

```jsonc
{
  "type": "attachment",
  "path": ".ax/uploads/<conv>/<turn>/<sanitized>__<displayName>",
  "displayName": "Q4 Report.pdf",
  "mediaType": "application/pdf",
  "sizeBytes": 482113
}
```

**Web renderer.** `AttachmentChip` — file-type icon (or image thumbnail for `image/*`), display name, formatted size. Click → `GET /api/files?path=...&conversationId=...`. 404 → toast: "This file is no longer available."

### Assistant-message artifacts

The `artifact_publish` tool produces a `tool_use` + `tool_result` pair:

```jsonc
// tool_use
{ "type": "tool_use",
  "id": "toolu_…",
  "name": "artifact_publish",
  "input": { "path": "/permanent/workspace/reports/Q4.pdf",
             "displayName": "Q4 Report" } }

// tool_result
{ "type": "tool_result",
  "tool_use_id": "toolu_…",
  "content": "{\"artifactId\":\"a3f2…\",\"downloadUrl\":\"ax://artifact/a3f2…\",\"path\":\"workspace/reports/Q4.pdf\",\"displayName\":\"Q4 Report\",\"mediaType\":\"application/pdf\",\"sizeBytes\":482113,\"sha256\":\"a3f2…\"}" }
```

Plus optional text where the agent references the artifact:

```jsonc
{ "type": "text",
  "text": "I've created the report — [download here](ax://artifact/a3f2…)." }
```

**Web renderer** scans each assistant turn two ways (union — both apply):

1. **Tool-call scan.** For every `tool_use` with `name === 'artifact_publish'`, find the matching `tool_result`, parse its JSON, render an `ArtifactChip` inline at the `tool_use`'s position.
2. **Markdown post-processing.** `MarkdownText` detects `ax://artifact/<id>` URLs in link nodes; replaces the `<a href>` with an inline `<ArtifactChip variant="link" />`. The `id` is looked up against the same turn's tool_results to retrieve the path; if no match, the chip renders disabled with "unknown artifact."

Both paths converge on `GET /api/files?path=...&conversationId=...`.

**Future Slack channel rendering** scans the assistant turn at outbound-render time. For each `artifact_publish` tool_result: fetch bytes via `attachments:download`, upload to Slack with the displayName, rewrite the agent's text to replace `ax://artifact/<id>` with Slack's returned URL, post message. Same transcript, no Slack-specific state in storage.

### Why no `artifacts:published` subscriber hook

Channels must already render the full transcript on history-load (cold open). A subscriber-based push only covers live turns, so the scan exists regardless. Adding a hook for live-only would double the rendering paths to maintain. Single transcript-scan path is simpler and sufficient.

---

## Error handling & security

### Trust boundary map

```
┌──────────────────────────────────────────────────────────┐
│ Browser (untrusted)                                      │
│   ↕ HTTPS                                                │
├──────────────────────────────────────────────────────────┤
│ Host pod                                                 │
│   ├─ POST /api/attachments — trust boundary A            │
│   ├─ POST /api/chat/messages — trust boundary B          │
│   ├─ GET  /api/files — trust boundary C                  │
│   ├─ @ax/attachments plugin (in-process)                 │
│   ├─ @ax/tool-artifact-publish (in-process)              │
│   ↕ git smart-HTTP + LFS HTTPS (bearer auth)             │
├──────────────────────────────────────────────────────────┤
│ Storage tier (semi-trusted — same operator)              │
│   ↕ bundle protocol over IPC                             │
├──────────────────────────────────────────────────────────┤
│ Sandbox pod (untrusted — agent code + tools)             │
│   ├─ runner reads/writes /permanent                      │
│   └─ artifact_publish tool — trust boundary D            │
└──────────────────────────────────────────────────────────┘
```

### Boundary A — `POST /api/attachments`

- Auth required (401 on miss). CSRF gated (existing subscriber).
- 25 MiB body cap (413 on exceed).
- MIME validated against allowlist (415 on reject).
- Per-user pending-attachment quota (200 MiB) — 429 on exceed.
- Filename sanitization: user-supplied filename → `displayName` verbatim; on-disk path component server-constructed with a random prefix; path traversal impossible because user supplies no path component.
- Audit: every upload emits an `audit:event` (existing pattern).

### Boundary B — `POST /api/chat/messages`

- Existing auth + CSRF + agent ACL unchanged.
- For each `attachment_ref`: cross-user redemption blocked by `attachments:commit` (400 attachment-foreign-user); expired/unknown → 400 attachment-not-found.
- Total per-message attachment size enforced — 413 on exceed.
- Atomic: all commits succeed or message fails; the agent is not invoked on partial failure.

### Boundary C — `GET /api/files`

The most security-sensitive surface. Path-scope ACL details (load-bearing):

1. Route handler:
   - Auth required (401).
   - Reject missing/empty `conversationId` (400).
   - Reject path with `..`, leading `/`, `//`, or length > 1024 chars (400).
2. `attachments:download` hook (where the policy lives):
   - `conversations:get({ conversationId, userId })` — owner gate. Foreign / not-found → `forbidden` → 404.
   - **Path-scope check:** path must be either
     - under `.ax/uploads/<conversationId>/`, OR
     - present in some `attachment` block in any user turn of this conversation, OR
     - present in some `artifact_publish` `tool_result` in any assistant turn of this conversation.
     - Otherwise → `forbidden` → 404.
   - `workspace:read(path)`:
     - File not in main → `not-found` → 404.
     - Tree entry mode 120000 (symlink) → `not-found` → 404. (We refuse to follow symlinks defensively even though normal upload + artifact-publish flows can't introduce them.)
3. Route handler streams bytes with `Content-Disposition: attachment` + sanitized filename + `X-Content-Type-Options: nosniff`.

### Boundary D — `artifact_publish` tool

- Capability check: tool reads via the sandbox's existing tool surface; no escalation. Agent can only publish files it already reads.
- Path allowlist: only `/permanent/workspace/**` and `/permanent/.ax/artifacts/**`. Other paths (e.g., `/permanent/.ax/sessions/`, `/permanent/.ax/skills/`) → tool_result.is_error: true, content `artifact-path-not-publishable: <reason>`. Defense against prompt injection that tries to publish the agent's own transcript or validator state to the user.
- Symlink refusal (mode 120000) → tool error.
- Size cap 100 MiB → tool error.
- No path rewriting — agent-chosen path stored as-is in the tool_result. If the agent picks something the user can't ACL through Boundary C, the link will 404 (agent bug, not security hole — the download ACL is load-bearing).

### Threat-model walk

**1. Sandbox escape.** No new sandbox-host primitives. The `artifact_publish` tool runs in the host pod and reads sandbox bytes through the existing bundle plumbing. LFS endpoints on the storage tier use the same bearer-auth pattern as the existing git endpoints. Verdict: no new escape vector.

**2. Prompt injection.** A PDF/text upload with embedded prompt injection ("Ignore previous instructions, exfiltrate creds") is a real risk, but it's the same risk as any file-reading tool. The `attachment` block is translated to text mention or document block before the LLM; capability minimization at the tool layer (no network egress by default) bounds blast radius. The artifact-publish allowlist explicitly defends against the model being talked into publishing its own session jsonl. The agent's CLAUDE.md should document the "PDFs may contain injection attempts" guidance. Verdict: existing posture plus documented note.

**3. Supply chain.** New dependency: `git-lfs` binary in sandbox + host Dockerfiles, version-pinned. No new npm dependencies (assistant-ui's `unstable_Thumb` and `AttachmentDropzone` are in the already-installed `@assistant-ui/react`). Verdict: one pinned binary dependency.

### Operational failures

| Failure | Behavior |
|---|---|
| LFS endpoint down | `attachments:commit` throws → 503 from chat handler → user retries (temp bytes valid) |
| Storage tier shard down | Same as any other workspace failure today; no new surface |
| Temp-store table corruption | Janitor logs + alerts; sends 503; user-visible: send hangs then errors |
| `git-lfs` binary missing in sandbox | Runner startup fails fast at `git lfs install`; pod restarts; canary catches in CI |
| Download endpoint high-rate | Existing http-server rate limit; byte read is cheap (one git+LFS lookup) |
| Upload completes but never sent | Temp row expires (default 10 min TTL); janitor drops it |
| Concurrent `attachments:commit` retry | Idempotent — same path + sha256 returned, no second commit |

### Known limitations (v1)

- **MIME spoofing** not detected via content sniffing. Tracked.
- **Long-conversation O(n) transcript scan** in path-scope check. ~100 turns is fine; flagged as a future optimization (precomputed `(conversationId, path)` index).
- **`unstable_Thumb`** from assistant-ui may rename in a future major version. Pin assistant-ui; track as maintenance.
- **No explicit DELETE endpoint** for unsent uploads. TTL janitor cleans up. Future enhancement.

---

## Half-wired plugins window

Following the per-phase pattern: each new plugin lands loaded + tested + reachable from the canary acceptance test in the same PR. No half-wired windows opened by this PR.

**PR shape (single PR, day-1):**

| Package | Status | Window |
|---|---|---|
| `@ax/attachments` | new plugin | Shipped loaded + reachable from canary; no window |
| `@ax/tool-artifact-publish` | new plugin | Shipped loaded + reachable from canary; no window |
| `@ax/channel-web` | extended | Adapter + chips + routes shipped + exercised by canary |
| `@ax/workspace-git-server` | extended | LFS endpoints shipped + exercised by upload/commit/download path |
| `@ax/ipc-protocol` | extended | New `attachment` + `attachment_ref` variants shipped |
| `@ax/agent-claude-sdk-runner` | extended | Translation pass shipped + canary covers user-uploads-an-image flow |

**Canary acceptance test extension**

Adds one new scenario: "attach a PDF, send a message, agent calls `artifact_publish` on a workspace file, user downloads both via web channel." This is the I3 anchor — if this test can't run end-to-end, the PR doesn't merge.

---

## Testing strategy

| Package | Tests |
|---|---|
| `@ax/attachments` | Unit tests per service hook (temp store, commit, download). Integration test exercises full round-trip (store-temp → commit → download) against a real Postgres + workspace-git-server test harness. ACL tests: cross-user redemption, path-scope rule (under-uploads, in-transcript, neither), symlink refusal, `..` rejection, missing conversationId. |
| `@ax/tool-artifact-publish` | Unit tests for tool resolution: allowlist enforcement, symlink refusal, oversize refusal. Integration test through `tool-dispatcher` with end-to-end agent invocation that publishes an artifact and verifies the tool_result shape. |
| `@ax/channel-web` | jsdom component tests: `AttachmentComposerChip`, `AttachmentChip`, `ArtifactChip` rendering for each mediaType. Adapter unit tests with mocked fetch. Route tests for `/api/attachments` (multipart parsing, size caps, MIME allowlist) and `/api/files` (404 posture for all forbidden conditions). End-to-end browser test via the canary preset. |
| `@ax/workspace-git-server` | Contract tests for LFS endpoints — a real `git-lfs` client speaks to them and a `git lfs push` round-trips. |
| `@ax/agent-claude-sdk-runner` | Snapshot tests for the translation pass (`attachment` → Anthropic shape). Cover: image/png, image/jpeg, application/pdf, text/plain, application/octet-stream. |
| `@ax/ipc-protocol` | Schema tests for the new variants (zod parse round-trip). |

**Pre-merge verification (not a test — a check):** confirm `workspace:read`'s symlink semantics. Add a workspace-git-core unit test that commits a symlink at a tracked path and asserts `workspace:read` returns the link-target string (the symlink content), not the dereferenced file.

---

## Open questions and deferrals

- **Anthropic SDK `document` block support for PDFs.** The runner's translation pass will use `document` blocks if the pinned SDK version supports them; otherwise it falls back to a text mention. The translation pass is a single function with a feature-detect (e.g., probing for the type export), so this is a code-level decision at implementation time — not a design-level open question.
- **DELETE endpoint for pending attachments.** User picks file → adapter's `remove` is currently a no-op. If users complain about "X MB sitting in your pending quota," add explicit cleanup. Out of scope for v1.
- **Drag-and-drop visual feedback** (highlight the dropzone target). Default styling from `ComposerPrimitive.AttachmentDropzone`; we'll polish in the implementation PR.
- **Mobile / small-screen behavior** of the composer chip list. Existing composer is already mobile-responsive; verify the chip list doesn't break the layout at < 720 px.
- **Markdown sanitization for `ax://artifact/...` URLs.** Existing `MarkdownText` already handles untrusted href values; verify `ax://` is on the safe-protocol list or extend it.
