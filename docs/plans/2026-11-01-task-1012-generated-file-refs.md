# TASK-1012 — Generated /files files become references, not blob copies — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **STATUS: UNBLOCKED (revised 2026-11-01 after TASK-1014 #1098).** Q1 was answered by shipping (C): `/files` downloads now stream whole files up to 1 GiB through `sendUserFileDownload` (`packages/channel-web/src/server/user-file-download.ts`). Task 3 reuses it; the old Task 8 (16 MiB bound) is dropped.

**Goal:** A file the agent creates in `/files` during a turn gets a chat chip that points at the file itself (no blob copy). It is charged once (Agent files), and deleting it lowers usage at the next turn-end meter.

**Architecture:** The runner emits a new `agent_file` content block `{ path, mediaType, sizeBytes }` instead of publishing a blob. `path` is the file's key relative to the agent's files root, the same key the Files tab uses. The host stores and validates it like any block. The workspace thread turns it into a chip. The chip downloads live through a new conversation-scoped route. That route runs the chip ACL (conversation owner, plus access to the conversation's own agent), validates the key with `workspaceFilePath`, then hands the bytes to the Files tab's streaming helper `sendUserFileDownload` (TASK-1014). There is no second reader. Explicit `artifact_publish` and uploads are untouched.

**Tech Stack:** TypeScript, zod, vitest, React + shadcn (`packages/channel-web`).

**Spec:** card TASK-1012 + Vinay's decision of 2026-11-01 (in the card). Design: `docs/plans/2026-10-29-agent-files-simplification-design.md` §7, §12. Decisions: `.claude/memory/decisions/2026-11-01-TASK-1012.md`.

## Q1 — resolved by TASK-1014

The plan first stalled on the old 1 MiB read cap. TASK-1014 (#1098) replaced the Files tab download with a streamed range read: `sendUserFileDownload({ bus, ctx, owner, relPath, downloadName, res })` loops `sandbox:read-user-file-range` in 1 MiB ranges, caps at `USER_FILE_DOWNLOAD_MAX_BYTES` (1 GiB), and answers absent → 404 `file-not-found`, folder → 400 `not-a-file`, over the ceiling → 413 `file-too-large`, no range service / unavailable → 503 `user-files-unavailable`, a failed read → 503 `file-read-failed`. Path confinement (`O_NOFOLLOW` per component; symlinks and FIFOs read as absent) is inside the hook. The chip route does its own ACL check, then calls it. `agentWorkspaceCtx` and `userFilesOwner` are closures inside `makeWorkspaceHandlers`; the new handler lives in that same function (beside `agentUserFileDownload`), so it reaches them without lifting or duplicating either.

## Global Constraints

- Do not touch `packages/attachments` or ipc-core's `artifact.publish` / `blob.*` handlers: TASK-1010 (#1097, merged) owns that path. Explicit `artifact_publish` and uploads stay blob-backed and charged.
- Old `attachment` chips keep working by id. No migration.
- Invariant 1: the block carries the key relative to the agent's files root. Never a sandbox-absolute path, `/files`, or mount/export names. The agent is always derived on the host from the conversation, never taken from the block or the client.
- The real HookBus delivers a provider's plain throw as `PluginError{code:'unknown'}` (`packages/core/src/hook-bus.ts:436-444`). Tests that model a provider failure use that shape.
- Copy: plain and short. No byte figures for a limit that lives in another package (rule in `lib/file-download.ts:72-80`). UI uses the existing shadcn `Button` / `Alert` only (invariant 6).
- Commands: `pnpm --filter <pkg> test` (filter BEFORE the script) plus `pnpm --filter <pkg> build` (tsc; vitest tolerates type errors). `@ax/disk-quota` plugin tests and `@ax/preset-k8s` acceptance need Docker (`DOCKER_HOST`). The Task 6 canary is Linux-only (`ON_LINUX`, CI).
- PR description, boundary review for the new block. Alternate impl: object-store-backed agent files (key = object key under the agent prefix). Leaking names: none (`path` is the Files key, the same name as `UserFileEntry.path`). Subscriber risk: none (`chat:turn-end` subscribers read text only). Wire: `@ax/ipc-protocol` `content-blocks.ts`, validated at `event.turn-end` ingress (`EventTurnEndSchema`) and on storage read (`validateContentBlocks`).
- PR description, rollback note: a host older than this change drops, on read, any stored tool turn carrying an `agent_file` block. That turn's tool results and chips vanish; assistant text survives.
- `security-checklist` runs for Tasks 1, 2 and 3. Put its note in the PR.

## Review Focus

1. Keys with spaces, `#`, `?`, `%`, or non-ASCII. The client encodes the whole key once with `encodeURIComponent`; the route decodes once with `workspaceFilePath`. Pinned in Task 3 and Task 6 with `reports/Q3 plan #1 (50%).pdf`.
2. Two new files with the same name in different folders must get two chips. Pinned in Task 4.
3. A file replaced by a symlink after the turn must answer 404, a folder 400 `not-a-file`; the chip shows "no longer available" for both, never a 500. Pinned in Task 3 (fake range reader), Task 4 (chip copy) and Task 6 (real reader).
4. Storage that won't answer (the provider throws, which arrives as `PluginError{code:'unknown'}`) must answer 503 `file-read-failed`, never 500. Pinned in Task 3.
5. A name the Files tab cannot address (`notes: q3.md`, `a..b.txt`, `file.`) must get a text note, never a chip that always fails. Pinned in Task 1 (parity) and Task 2.

---

### Task 1: `agent_file` block contract + refuse it from the browser [tier: sensitive] (security-checklist)

**Files:**
- Modify: `packages/ipc-protocol/src/content-blocks.ts`: new schema after `AttachmentBlockSchema` (:169-178); add to the `ContentBlockSchema` union (:224-233)
- Test: `packages/ipc-protocol/src/__tests__/content-blocks.test.ts`
- Modify: `packages/channel-web/src/server/routes-chat.ts:445-457`: the refusal predicate and its comment
- Test: `packages/channel-web/src/__tests__/server/routes-chat.test.ts` (beside `:2352`)
- Create: `packages/channel-web/src/__tests__/server/agent-file-path-parity.test.ts`

**Interfaces — Produces** (re-exported by the package barrel, `index.ts:3`):
```ts
export const AGENT_FILE_PATH_MAX = 4096;
export function isAgentFilePath(key: string): boolean;
export const AgentFilePathSchema; // z.string().min(1).max(AGENT_FILE_PATH_MAX).refine(isAgentFilePath)
export const AgentFileBlockSchema; // z.object({ type: z.literal('agent_file'), path: AgentFilePathSchema,
                                   //   mediaType: z.string().min(1).max(ATTACHMENT_MEDIA_TYPE_MAX),
                                   //   sizeBytes: z.number().int().nonnegative() }).strict()
export type AgentFileBlock = z.infer<typeof AgentFileBlockSchema>;
export function agentFileBlock(v: { path: unknown; mediaType: unknown; sizeBytes: unknown }): AgentFileBlock | null;
```

`isAgentFilePath` must accept exactly the keys for which `workspaceFilePath(encodeURIComponent(key)) === key` (`channel-web/src/server/safe-path.ts:103-132`, with `safePath` at :1-76):
- the key has no NUL;
- split on `/`, every segment is 1–255 UTF-16 units;
- no segment contains `\`, `:` or `..`;
- no segment matches `/^\s/` or `/[\s.]$/`.

Two rules are protocol-only:
- length ≤ `AGENT_FILE_PATH_MAX`;
- the key must survive `encodeURIComponent`, so a lone surrogate is refused. A forged one would otherwise throw in the chip's URL builder.

No `node:` imports: the package is browser-safe.

- [ ] **Step 1: Write the failing tests** in `content-blocks.test.ts`:
  - `AgentFileBlockSchema` accepts `{ type:'agent_file', path:'docs/report.pdf', mediaType:'application/pdf', sizeBytes:12 }`, `'.gitignore'` and `'reports/Q3 plan #1 (50%).pdf'`.
  - It refuses each of these paths: `''`, `'/etc/passwd'`, `'../x'`, `'a/../b'`, `'a//b'`, `'a/'`, `'./a'`, `'a/./b'`, `'a\\b'`, `'a:b'`, `'a..b'`, `'a\u0000b'`, `' a'`, `'a.'`, `'a '`, `'a\uD800b'`, a 256-unit segment, and a 4097-unit key.
  - It refuses extra fields (`filename`, `attachmentId`): `.strict()`.
  - `ContentBlockSchema.safeParse(validBlock).success === true`.
  - `agentFileBlock({ path:'a:b', mediaType:'text/plain', sizeBytes:1 }) === null`.
- [ ] **Step 2: Run** `pnpm --filter @ax/ipc-protocol test`. Expected: FAIL (exports missing).
- [ ] **Step 3: Implement.** The doc comment on the schema must say:
  - the key is relative to the agent's files root, the same key the Files tab lists by, and not a sandbox layout (Invariant 1);
  - the host derives the agent from the conversation;
  - the label is derived on the host from the last segment;
  - only a runner `event.turn-end` may carry one.
- [ ] **Step 4: Write the parity test.** Build a table from every key in Step 1 except the two protocol-only cases (4097-unit key, lone surrogate), plus `'a b/c d.txt'`, `'ünï/cødé.md'` and `'x‮y.pdf'`. For each key: `expect(isAgentFilePath(k)).toBe(workspaceFilePath(encodeURIComponent(k)) === k)`.
- [ ] **Step 5: Extend the routes-chat refusal** to `block.type === 'attachment' || block.type === 'agent_file'`. Add a test copied from `:2352`: a POST carrying an `agent_file` block gets 400 `{ error:'invalid-content-block' }`, and `agents:resolve`, conversation creation and commit are never called.
- [ ] **Step 6: Run** `pnpm --filter @ax/ipc-protocol test && pnpm --filter @ax/channel-web test`, then both packages' `build`. Expected: PASS.
- [ ] **Step 7: Commit** `[TASK-1012] ipc-protocol: agent_file block; refuse it from the browser`.

### Task 2: the runner attaches references, never blob copies [tier: sensitive] (security-checklist)

**Files:**
- Modify: `packages/agent-runner-core/src/generated-files.ts:74-121` and its header comment
- Modify: `packages/agent-runner-core/src/run-runner.ts:1299-1325`
- Modify: `packages/agent-runner-core/src/artifact-publish-executor.ts:54`: `export` `mediaTypeFromExtension`
- Test: `packages/agent-runner-core/src/__tests__/generated-files.test.ts` and `run-runner.test.ts:185-225`

**Interfaces:**
- Consumes: `agentFileBlock`, `AgentFileBlock` (Task 1).
- Produces:
```ts
export async function agentFileReference(root: string, relative: string): Promise<AgentFileBlock>;
export async function trackGeneratedFiles(opts: {
  root: string;
  /** The policy gate a model's own artifact_publish call gets: resolves = may attach, rejects = may not. */
  admit: (call: ToolCall) => Promise<void>;
  /** Reports the attached chip as that call's outcome (tool.post-call). */
  attached: (call: ToolCall, chip: AgentFileBlock) => Promise<void>;
  warn: () => void;
}): Promise<GeneratedFiles>; // GeneratedFiles.collect(alreadyPublished) unchanged
```

**`agentFileReference`:**
- `lstat(join(root, relative))` must be a regular file: no symlink, no folder.
- `realpath` of the file must stay under `realpath(root)`, the same check as the executor at :181-197.
- Reads no bytes. Applies no size cap; the route answers for size.
- Fields: `path` = `relative` with `/` separators, `mediaType = mediaTypeFromExtension(basename)`, `sizeBytes = lstat.size`.
- If `agentFileBlock(...)` returns `null`, throw.

**`collect`:** for each new key:
1. `call = { id: randomUUID(), name: 'artifact_publish', input: { path: join(root, rel) } }`
2. `await admit(call)`
3. `chip = await agentFileReference(root, rel)`
4. `await attached(call, chip)`
5. push the chip.

Any throw marks the batch failed (existing `warn`, existing text copy). Explicit-publish dedup (`alreadyPublished`) and the baseline fail-closed path are unchanged.

**`run-runner.ts`:**
- Delete `publishGeneratedFile`.
- `admit` calls `preToolUse` and throws unless `decision === 'allow'`. Ignore `updatedInput`: a reference names the file the turn created.
- `attached` calls `postToolUse(call.name, call.id, call.input, chip, false)`.
- Keep the `canPublishGenerated` condition.
- Rewrite the :1299-1309 comment. No bytes move now. The gate keeps a person's "publish a file for you to open" setting meaning the same for automatic chips.

- [ ] **Step 1: Write the failing tests** in `generated-files.test.ts`, replacing the publish-based cases:
  - **'attaches new nested files by their key':** `collect()` returns `[{ type:'agent_file', path:'docs/new.md', mediaType:'text/markdown', sizeBytes:<written length> }]`. Pre-existing files, `node_modules/`, dot-folders and `*.pyc` are not attached. `attached` gets the same chip once.
  - **'never attaches file or directory symlinks':** keep the existing case.
  - **'skips a file the model already published':** keep the existing case.
  - **'a gate refusal attaches nothing and says so':** `admit` rejects. No `agent_file` block; the text is `'Some new files could not be attached. Ask the agent to attach them again.'`.
  - **'a name the Files tab cannot address is reported, not attached':** write `notes: q3.md` (`it.skipIf(process.platform === 'win32')`). The text block appears; no chip.
  - **'fails closed when the initial baseline is unavailable':** keep the existing case.
  - `publishedAttachments` tests: unchanged.
- [ ] **Step 2: Update `run-runner.test.ts:185-225`.** Rename to `'uses the policy gate (%s) and attaches a reference, never a blob copy'`.
  - `allow`: `upload` is never called. No `fakeClient.call` with `'artifact.publish'`. The first `event.turn-end` (role `tool`) contains `{ type:'agent_file', path:'report.txt', mediaType:'text/plain', sizeBytes:6 }`.
  - `reject` / `hold`: no `agent_file` block, no upload.
- [ ] **Step 3: Run** `pnpm --filter @ax/agent-runner-core test`. Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** the runner-core tests and build, then `pnpm --filter @ax/agent-claude-sdk-runner test` and `pnpm --filter @ax/agent-aisdk-runner test`. Expected: PASS.
- [ ] **Step 6: Commit** `[TASK-1012] runner: attach new /files files as references, not blob copies`.

### Task 3: conversation-scoped live download of an agent file [tier: sensitive] (security-checklist)

**Files:**
- Modify: `packages/channel-web/src/server/routes-workspace.ts`:
  - a new handler `conversationAgentFileDownload` in `makeWorkspaceHandlers`, right after `agentUserFileDownload`;
  - its registration right after `/api/workspace/agents/:agentId/download/user-files/*`, using the same `DownloadRouteResponse` adapter cast;
  - the header route list at the top of the file.
- Modify: `packages/channel-web/src/__tests__/server/routes-workspace-registration.test.ts` (the pinned route list), if it pins routes.
- Create: `packages/channel-web/src/__tests__/server/routes-workspace-conversation-file.test.ts`. Copy the harness from `routes-workspace-download.test.ts` (TASK-1014 rewrote it around a fake `sandbox:read-user-file-range` and a response with `bodyStream`).

**Interfaces — Produces:** `GET /api/workspace/conversations/:conversationId/download/user-files/*` → `handlers.conversationAgentFileDownload`. Answers:

| Code | When |
|---|---|
| 200 | `sendUserFileDownload` streamed it (octet-stream, `attachment`, `nosniff`, no-store) |
| 401 | No session |
| 400 `missing-conversation-id` / `invalid-path` | Malformed request |
| 400 `not-a-file` | The key is a folder now (from the helper) |
| 404 `file-not-found` | Conversation missing or not theirs, agent unreachable, file absent (incl. now a symlink) |
| 413 `file-too-large` | Over 1 GiB (from the helper) |
| 503 `agent-unavailable` | The conversation ACL lookup failed for another reason |
| 503 `user-files-unavailable` / `file-read-failed` | From the helper |

Order is fixed. ACL runs before path validation, as in `agentUserFileDownload`.
1. `authOr401` → `userId`.
2. Empty `conversationId` → 400 `missing-conversation-id`.
3. `conversations:get-metadata({ conversationId, userId })`, with the same ctx shape other conversation-scoped handlers in this file use for that hook (find an existing caller; the hook gates on `input.userId`):
   - a `PluginError` / rejection with code `not-found` or `forbidden` → 404 `file-not-found`;
   - any other error → log `workspace_conversation_file_acl_failed` with `{ conversationId }`, then 503 `agent-unavailable`.
4. `resolveAgentOr404(bus, initCtx, md.agentId, userId, res)`. The agent ALWAYS comes from the conversation, never from the request.
5. `workspaceFilePath(req.params['*'] ?? '')` returns null → 400 `invalid-path`.
6. `await sendUserFileDownload({ bus, ctx: agentWorkspaceCtx(agent.id, userId), owner: userFilesOwner(agent, userId), relPath, downloadName: basenameOf(relPath), res })`. Nothing else: no second reader, no own status mapping.

- [ ] **Step 1: Write the failing tests:**
  - **Owner downloads.** Splat `reports%2FQ3%20plan%20%231%20(50%25).pdf` gives 200 with the exact bytes. `content-disposition` carries the key's basename; `content-type` is `application/octet-stream`. The range reader received `relPath:'reports/Q3 plan #1 (50%).pdf'` and `owner.agentId` = the agent from `get-metadata` (not anything in the URL).
  - **Conversation gate.** `get-metadata` throws `PluginError{code:'not-found'}` → 404, reader never called. The same 404 for a foreign conversation with a malformed path (ACL before path). `get-metadata` throws `PluginError{code:'unknown'}` → 503 `agent-unavailable`, no read, handler does not throw.
  - **Agent gate.** `agents:resolve` throws `forbidden` → 404, no read.
  - **Bad paths.** `..%2Fx`, `%2Fetc%2Fpasswd` and `%252e%252e%252fx` → 400, no read.
  - **Helper answers pass through.** `absent` → 404; `dir` → 400 `not-a-file`; reader throws `PluginError{code:'unknown'}` → 503 `file-read-failed`.
  - **Unauthenticated** → 401.
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-web test -- routes-workspace-conversation-file`. Expected: FAIL (no handler).
- [ ] **Step 3: Implement the handler and its registration.** Update any pinned route list.
- [ ] **Step 4: Run** the channel-web tests and build. Expected: PASS.
- [ ] **Step 5: Commit** `[TASK-1012] channel-web: conversation-scoped live download of an agent file`.

### Task 4: draw agent-file chips and download them live [tier: integration]

**Files:**
- Modify: `packages/channel-web/src/lib/workspace-types.ts:630-649`: `ThreadAttachment` and its doc
- Modify: `packages/channel-web/src/server/routes-workspace.ts`: a new `turnAgentFiles` beside `turnAttachments` (:3691-3709); the tool branch, dedup and comment (:3832-3857)
- Modify: `packages/channel-web/src/components/workspace/GeneratedFileChip.tsx`
- Modify: `packages/channel-web/src/components/workspace/AgentConversation.tsx:1407`: React key `file.attachmentId ?? file.agentFilePath ?? file.displayName`
- Test: `packages/channel-web/src/__tests__/server/routes-workspace.test.ts` (beside `:1125`) and `packages/channel-web/src/components/workspace/__tests__/GeneratedFileChip.test.tsx`

**Interfaces:**
- Consumes: `AgentFileBlockSchema` (Task 1) and the route (Task 3).
- Produces: `ThreadAttachment.agentFilePath?: string`. This is the RAW key and is never rendered. It is set only on agent-output chips for a file in the agent's files, and `attachmentId` is `null` then.

**Server.** `turnAgentFiles(blocks: readonly TurnBlock[]): ThreadAttachment[]` takes every `agent_file` block that parses with `AgentFileBlockSchema` and maps it to:

```ts
{
  attachmentId: null,
  agentFilePath: b.path,
  displayName: fenceLine(basenameOf(b.path), FILE_LABEL_MAX_CHARS) ?? UNREADABLE_FILE_NAME,
  mediaType: b.mediaType,
  sizeBytes: b.sizeBytes,
}
```

Call it ONLY in the `role === 'tool'` branch. Append its chips right after `turnAttachments(blocks)`. Dedup key: `f.agentFilePath !== undefined ? 'file:' + f.agentFilePath : 'id:' + f.attachmentId`. A null id must not collapse agent files into one chip.

**Client.** `GeneratedFileChip` picks the URL:
- `agentFilePath` set → `` `/api/workspace/conversations/${encodeURIComponent(conversationId)}/download/user-files/${encodeURIComponent(agentFilePath)}` ``;
- else `attachmentId` set → the existing `/api/files?…`;
- else none, and the button is disabled.

Copy:
- 404, and 400 on an agent-file chip (`not-a-file`: the key is a folder now) → the existing `'This file is no longer available to download.'`;
- 413 → `'This file is too big to download from the chat. Ask the agent for a smaller copy, or to split it up.'`;
- 403 and the rest (503 included) → existing copy.

Rewrite the doc comment at :13-15 to cover both kinds of chip.

- [ ] **Step 1: Write the failing server test** `'(TASK-1012) draws an agent-file chip per key, beside published artifacts'`. The tool turn carries:
  - `agent_file` blocks for `a/report.pdf` and `b/report.pdf`;
  - a duplicate of `a/report.pdf`;
  - an invalid `../x`;
  - a file whose name contains U+202E;
  - one explicit-publish result (copy `:1125`).

  Expect: one chip each for `a/report.pdf` and `b/report.pdf`, both `displayName:'report.pdf'`, `attachmentId:null`. No chip for `../x`. A fenced label for the U+202E name. The publish chip is kept. Also: a tool turn with ONLY `agent_file` blocks still yields an `agent` message, and a USER turn carrying an `agent_file` block draws no chip.
- [ ] **Step 2: Write the failing chip tests** in `GeneratedFileChip.test.tsx`:
  - The agent-file chip fetches `'/api/workspace/conversations/c%20%26%201/download/user-files/reports%2FQ3%20plan%20%231.pdf'` with `{ credentials:'include' }`, saves under the server filename, and never calls `/api/files`.
  - A 404 shows `'This file is no longer available to download.'`, and so does a 400 on an agent-file chip.
  - A 413 shows the too-big sentence.
  - The existing attachment-id chip tests still pass unchanged.
- [ ] **Step 3: Run** `pnpm --filter @ax/channel-web test`. Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** the channel-web tests and build (channel-web's tsc includes tests). Expected: PASS.
- [ ] **Step 6: Commit** `[TASK-1012] channel-web: draw and download agent-file chips`.

### Task 5: quota — deleting an agent file lowers the total and clears the warning [tier: mechanical]

**Files:** Test: `packages/disk-quota/src/__tests__/plugin.test.ts`, beside the agent-files block (:282-386). Copy its `bootDiskQuota`, `sandbox:user-files-usage` stub and `agents:resolve` stub (:283-292).

- [ ] **Step 1: Write the test** `'(TASK-1012) deleting an agent file lowers the total by its full size and clears the warning at the next turn end'`:
  - Setup: limit 10 MB, warn 80%, set through the same knobs the existing status tests use. The usage stub returns a mutable `bytes`.
  - First measure: `bytes = 9 MB`. Fire `chat:turn-end` `{ role:'assistant' }`, then `drain()`. `GET /settings/storage` shows `status:'near-limit'`, agent-files 9 MB, and no file (blob) bytes.
  - Second measure: `bytes = 1 MB`. Fire again, then `drain()`. Status is `'ok'` and the total fell by exactly 8 MB.
- [ ] **Step 2: Run** `pnpm --filter @ax/disk-quota test` (Docker). Expected: PASS. This pins behavior that exists but was never tested flipping back down. If it FAILS, stop: that is a real bug, and its fix lands with this test.
- [ ] **Step 3: Commit** `[TASK-1012] disk-quota: pin that a smaller re-measure clears the warning`.

### Task 6: canary — an agent-file chip round-trips through the real server [tier: integration]

**Files:** Test: `presets/k8s/src/__tests__/acceptance.test.ts`. Add a new `it.skipIf(!ON_LINUX)` right after the F4 user-files canary (it now also has TASK-1014's streamed-download step 8) and copy its scaffolding: `@ax/sandbox-subprocess`, `@ax/workspace-localdir` over a temp tier, real Postgres, and real channel-web over a socket.

- [ ] **Step 1: Write** `'TASK-1012 canary: an agent_file chip downloads live from the agent files and 404s after delete'`.
  - Setup: user A owns conversation C with agent X. Write `<tier>/<agentId>/reports/Q3 plan #1.pdf`. Append a `tool` turn carrying `{ type:'agent_file', path:'reports/Q3 plan #1.pdf', mediaType:'application/pdf', sizeBytes:n }` through `conversations:append-event`, the hook `persistEventTurnEnd` uses.
  - The thread served by `GET /api/workspace/agents/:agentId` (the handler calling `buildThread` at :7752) carries a chip with `agentFilePath:'reports/Q3 plan #1.pdf'`.
  - `GET /api/workspace/conversations/C/download/user-files/${encodeURIComponent(key)}` returns 200 and the exact bytes for A, and 404 for user B.
  - After replacing the file with a symlink to a sibling file: 404. After `fs.rm`: 404.
  - If extending the F4 canary in place is clearly cheaper than a new `it` (same scaffolding, already boots the real range reader), do that instead and say so in the commit.
- [ ] **Step 2: Run** `pnpm --filter @ax/preset-k8s test -- acceptance` on Linux with `DOCKER_HOST`, or rely on CI. Expected: PASS.
- [ ] **Step 3: Commit** `[TASK-1012] acceptance: agent-file chip canary`.

### Task 7: docs — record what changed (stale-line fix) [tier: mechanical]

**Files:** `docs/plans/2026-10-29-agent-files-simplification-design.md`

- [ ] **Step 1:** In §7 (:262-268, "As built (TASK-995)"), the claim "Uploads and artifact chips share one ID-based attachment block … a download is by ID" is no longer true for generated files. Add after it: "**As built (TASK-1012):** a file the agent creates in `/files` is attached as an `agent_file` reference by its key there and downloaded live from `/files` (§12); uploads and explicitly published artifacts keep the ID-based block."
- [ ] **Step 2:** In §12, after :361, add "**As built (TASK-1012):**":
  - auto-attach no longer copies new `/files` files into chat blobs;
  - the chip is `agent_file { path, mediaType, sizeBytes }`;
  - `GET /api/workspace/conversations/:id/download/user-files/*` serves it live with the chip ACL (conversation owner, plus the conversation's agent);
  - it reuses the Files tab's streamed download (`sendUserFileDownload`, TASK-1014): 404 when the file is gone, 400 when the key is now a folder (the chip says "no longer available" for both), 503 when storage won't answer, and 413 over 1 GiB;
  - such a file is charged once (Agent files), and deleting it lowers usage at the next assistant turn end;
  - explicit `artifact_publish` and uploads are unchanged;
  - files auto-attached before this change keep their blob and its charge (no migration: their artifact rows live until the agent is deleted).
- [ ] **Step 3: Commit** `[TASK-1012] design doc: as-built note`.

## Final gate (builder)

`pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts && pnpm lint`. Then the security-checklist note and the boundary review in the PR body.
