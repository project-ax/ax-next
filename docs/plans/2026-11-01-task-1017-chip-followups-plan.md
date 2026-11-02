# TASK-1017 Generated-file chip follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Approving a held auto-attach attaches the same `agent_file` reference (no blob, charged once). A stored `agent_file` block that fails today's rule never hides its turn. Gate refusals get their own reason codes, and the chip says "no longer available" before anyone clicks.

**Architecture:** The runner already knows which holds it raised for auto-attach, because `tool.pre-call` hands it the `decisionId`. It remembers them in memory for the session. When a `decision-resolved` entry names one of them, the runner re-runs the gate with the byte-identical call **at pull time**, before any model turn can spend that approval, and queues the chip for the next turn-end. It then starts the turn with its own fixed note instead of the host's "make that call again" note. Conversations turns an invalid stored `agent_file` block into a "no longer available" text line, as it already does for legacy attachments. A new status route calls `sandbox:read-user-file-range` with `length: 0`: no bytes are read and no pod is started. The chip calls it when it mounts and again whenever a new turn lands.

**Tech Stack:** TypeScript, vitest, zod, React + shadcn (channel-web).

**Spec:** card TASK-1017; `docs/plans/2026-10-29-agent-files-simplification-design.md` §7 and §12 (the TASK-1012 as-built entries); decisions `.claude/memory/decisions/2026-11-01-TASK-1012.md`, `.claude/memory/decisions/2026-11-01-TASK-1017.md`.

## What the code says (verified 2026-11-01 at 44f452443)

- Auto-attach makes up `{id: randomUUID(), name: 'artifact_publish', input: {path: <abs home path>}}` and sends it through `createToolPolicy().preToolUse` (`run-runner.ts:1318-1321`). That returns `allow`, `deny` with `cause` set to `'policy'` or `'unavailable'`, or `hold` with a `decisionId` (`tool-policy.ts:75-81`). Today every non-allow verdict throws, so the warn line says `gate-refused` and the turn gets "Some new files could not be attached. Ask the agent to attach them again."
- **The approval never re-runs anything by itself.** In a warm session, `@ax/decisions` delivers `{type:'decision-resolved', decisionId, outcome, note}` (`delivery.ts:186-194`). The runner then opens a model turn with the host note, "You may now make that call again, exactly as you made it before" (`run-runner.ts:1055-1091`, `templates.ts:439`). The model never made that call: the runner invented it, so it is not in the model's transcript. If the model guesses the exact input anyway, `takeApproval(agentId, fingerprint)` (`pre-call.ts:200`; fingerprint = sha256 of `[name, input]`, id excluded) lets it through once. It then runs in the sandbox executor (`blob.put` + `artifact.publish`), and that is the double charge. Otherwise the approval attaches nothing. In a cold session, the host replay finds no `tool:execute:artifact_publish` (`tool-artifact-publish/src/plugin.ts:17`) and parks the call as `approved-pending-agent`. Nothing ever attaches it, because the next session's baseline already contains the file.
- The "Ask the agent to attach them again" advice on a **held** file sends people straight to that explicit-publish path.
- Read path: `projectEventTurns` (`conversations/src/plugin.ts:1589-1612`) runs `validateContentBlocks(degradeLegacyAttachmentBlocks(...))` and **skips the whole turn** if any block fails. Nothing else re-validates stored turns (the SPA's `GetConversationResponse` is types only).
- `sandbox:read-user-file-range` accepts `length: 0` (`user-files-read/src/confined-read.ts:323-325`). That call walks the path with O_NOFOLLOW, fstats the file and reads no bytes. On k8s it works only through the host mount: without one it throws `user-files-download-unavailable` and starts no pod (TASK-1014).

## Global Constraints

- Do not edit `packages/ipc-core/src/handlers/*`: sibling card TASK-1015 is working there.
- No hook signature changes, no new IPC action, no new dependency. The `decision-resolved` entry and `tool.pre-call` shapes stay as they are.
- `safePath`'s body in `channel-web/src/server/safe-path.ts` stays verbatim (it is the v1 port). Doc comments only.
- Warn and log lines carry reason codes only, never a path or a file name.
- UI follows invariant 6: shadcn primitives and semantic tokens only. Invoke the `shadcn` skill before you touch `GeneratedFileChip.tsx`.
- Copy strings must match this plan exactly. The tests pin them.
- Per-package tests: `pnpm --filter <pkg> test` (the filter goes before the script). Run `pnpm --filter <pkg> exec tsc --noEmit -p .` alongside, because vitest tolerates type errors. The full gate is `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts && pnpm lint`.
- Run `security-checklist` once for the PR. It covers Task 2 (when a held call is attached) and Task 4 (a new route that takes a path from the caller). Boundary review is N/A: no hook or IPC surface changes. Say so in the PR body.

## Review Focus

1. **The person approves while another turn is still streaming.** The claude-sdk loop pulls messages early (`run-runner.ts:795-806`), so `resolveHeld` runs in the middle of a turn. The chip must land exactly once, in whichever turn ends next. Pinned in Task 2 (`lands once`).
2. **The file is deleted, or swapped for a symlink, between the hold and the approval.** No chip, the generic note, and the gate is **not** asked again, so the approval stays unspent. Pinned in Task 2.
3. **The gate holds or denies the re-issued call** (Undo, expiry, or someone else spent the approval). No chip. A new hold is remembered under its new id. Pinned in Task 2.
4. **A `decision-resolved` this runner did not raise** (a cold session, or a model-made hold). Behaviour stays as today: the host note, no `artifact_publish` pre-call, no chip. Pinned in Task 2.
5. **Storage is slow or down when the chip checks itself** (503, network error, missing host mount). The chip must stay downloadable, never "gone". Pinned in Task 4.

---

### Task 1: Reason codes, scan-limit, held and plural copy `[tier: mechanical]`

**Files:**
- Modify: `packages/agent-runner-core/src/generated-files.ts` (types at :50-66, `snapshot` :27-48, `collect` :155-201)
- Modify: `packages/agent-runner-core/src/run-runner.ts:1314-1325` (the `admit` mapping)
- Test: `packages/agent-runner-core/src/__tests__/generated-files.test.ts`, `packages/agent-runner-core/src/__tests__/run-runner.test.ts:192-243`

**Interfaces (Produces, used by Task 2):**
```ts
export type GateVerdict =
  | { kind: 'allow' }
  | { kind: 'held'; decisionId: string }
  | { kind: 'denied' }        // deny, cause 'policy'
  | { kind: 'unavailable' };  // deny, cause 'unavailable' (the gate failed closed)
export type GeneratedFileFailure =
  | 'denied' | 'held' | 'unavailable' | 'scan-limit'
  | 'unaddressable-name' | 'not-a-regular-file' | 'outside-root' | 'error';
// trackGeneratedFiles opts: admit: (call: ToolCall) => Promise<GateVerdict>;
//                           maxEntries?: number  (test seam, default MAX_ENTRIES = 10_000)
```
Copy (exact):
- `NOT_ATTACHED` (unchanged): `Some new files could not be attached. Ask the agent to attach them again.`
- `HELD` (new): `Some new files need your approval before we attach them. You can also find them in the Files tab.`
- `NOT_NAMEABLE` (now plural): `Some new files have names we can't link to here (for example, ones with a colon). Ask the agent to rename them.`
- The scan-failure line stays: `We could not check for new files to attach. Ask the agent to attach the files again.`

Notes appear at most once each, in the order NOT_ATTACHED, HELD, NOT_NAMEABLE, after the chips.

- [ ] **Step 1: Write the failing tests** in `generated-files.test.ts`. `track(dir, gate)` now takes `gate: (call) => Promise<GateVerdict>`, defaulting to `async () => ({ kind: 'allow' })`. Update the existing refusal tests to `({ kind: 'denied' })` and update the `NOT_NAMEABLE` constant. Add:
  - `warn gets denied, held and unavailable for the three gate refusals`: with gates `{kind:'denied'}`, `{kind:'held', decisionId:'d1'}` and `{kind:'unavailable'}`, the warn calls equal `[['denied']]`, `[['held']]` and `[['unavailable']]`.
  - `a held file gets the approval note, never the attach-again note`: `collect()` returns `[HELD]`.
  - `a home over the entry limit warns scan-limit`: `maxEntries: 2`, three files present at baseline. `warn.mock.calls` contains `['scan-limit']` and no `['error']`.
- [ ] **Step 2: Update the run-runner `it.each`** (`run-runner.test.ts:192`). The rejected case expects `could not attach a generated file (denied)`, the held case `(held)`, and the held tool turn-end `contentBlocks` contain the HELD text. Add the case `'unavailable'`, in which `tool.pre-call` throws `new Error('host gone')`, and expect `(unavailable)`.
- [ ] **Step 3: Run** `pnpm --filter @ax/agent-runner-core test -- generated-files run-runner`. Expected: the new assertions FAIL.
- [ ] **Step 4: Implement.** `snapshot(root, maxEntries)` throws a module-private `ScanLimitError`, and both catch sites call `warn(err instanceof ScanLimitError ? 'scan-limit' : 'error')`. `GateRefusedError` carries `reason: 'denied' | 'held' | 'unavailable'`. A `held` verdict sets a `held` flag rather than `failed`. In `run-runner.ts`, `admit` returns `allow` → `{kind:'allow'}`, `hold` → `{kind:'held', decisionId}`, `deny` → `{kind: cause === 'unavailable' ? 'unavailable' : 'denied'}`. Remembering held calls is Task 2's job, not this one.
- [ ] **Step 5: Run** the same command plus `tsc`. Expected: PASS.
- [ ] **Step 6: Commit** `[TASK-1017] Generated files: denied/held/unavailable + scan-limit reason codes, held and plural notes`

---

### Task 2: Approving a held auto-attach attaches the reference, never a blob `[tier: sensitive]` (security-checklist)

**Files:**
- Modify: `packages/agent-runner-core/src/generated-files.ts`
- Modify: `packages/agent-runner-core/src/run-runner.ts:1055-1066` (the decision-resolved branch) and the comment at :1296-1303
- Test: `packages/agent-runner-core/src/__tests__/generated-files.test.ts`, `packages/agent-runner-core/src/__tests__/run-runner.test.ts` (the `decision-resolved delivery` describe)

**Interfaces:**
- Consumes: `GateVerdict` and the notes from Task 1; `decisionResolvedTurn(note): string | null` (`decision-turn.ts`).
- Produces:
```ts
export const MAX_HELD_AUTO_ATTACH = 256;
export interface GeneratedFiles {
  collect(alreadyPublished?: readonly string[]): Promise<ContentBlock[]>;
  /** True iff `decisionId` is a hold this tracker raised and still remembers. Never rejects. */
  resolveHeld(decisionId: string, outcome: 'approved' | 'dismissed' | undefined): Promise<boolean>;
}
/** Model-facing; prefixed by decisionResolvedTurn. `undefined` is treated as dismissed. */
export function autoAttachResolvedNote(outcome: 'approved' | 'dismissed' | undefined): string;
```
Model notes (exact):
- approved: `A person approved attaching new files from earlier in this conversation. That is handled for you: do not publish them yourself unless the user asks you to. You do not need to reply.`
- otherwise: `A person chose not to attach new files from earlier in this conversation, so they were not attached. Do not publish them unless the user asks you to. You do not need to reply.`

**Behaviour (the order is the security property):**
1. In `collect`, a `held` verdict stores `decisionId → { call, relative }`, with the **same `ToolCall` object** that was sent to the gate. The map holds at most `MAX_HELD_AUTO_ATTACH` entries and evicts the oldest first (it is a `Map`, so insertion order works).
2. `resolveHeld` returns `false` for an id it does not know, without calling the gate. For a known id it deletes the entry **synchronously, before any `await`**, so a repeated delivery cannot attach twice. If the outcome is not `'approved'` it returns `true` with no gate call.
3. For an approved id it calls `agentFileReference(root, relative)` **first**, so the approval is never spent on a file that cannot be a chip. Only then does it call `admit(storedCall)`. That re-sends the byte-identical call and spends the standing approval. `allow` → `attached(call, chip)`, and the chip waits for the next collect. `held` → remember the new id and set the HELD flag. `denied` / `unavailable` / a throw → `warn(reason)` and the NOT_ATTACHED flag (`unaddressable-name` sets NOT_NAMEABLE).
4. Every `collect()` return path starts with the waiting chips and folds in the waiting flags, then clears them. They go out exactly once.
5. In `run-runner.ts`, call `generatedFiles.resolveHeld(entry.decisionId, entry.outcome)` when `generatedFiles !== null` and `decisionId` is a string. If it returns `true`, `content = decisionResolvedTurn(autoAttachResolvedNote(entry.outcome))`. Otherwise use the host note as today. Leave everything after it alone (the null check, `adoptReqIdForTurn`, `chatEndHistory`). The gate is asked at pull time, before the model turn, so the model can never spend this approval through the sandbox executor.

- [ ] **Step 1: Write the failing unit tests** (`generated-files.test.ts`; the gate is scripted per call):
  - `an approved hold attaches the file by reference after the gate allows the identical call`: the first gate call returns `held d1` and the second `allow`. `collect()` → `[HELD]`; `resolveHeld('d1','approved')` → `true`; `admit.mock.calls[1][0]` is the same object as `admit.mock.calls[0][0]`; the next `collect()` → `[chip]`; `attached` was called with `(call, chip)`.
  - `a dismissed or unanswered hold attaches nothing and is forgotten`: `resolveHeld('d1','dismissed')` → `true`; `admit` was called once; `collect()` → `[]`; `resolveHeld('d1','approved')` → `false`. Run the same check with `undefined`.
  - `a decision this tracker did not raise is not ours`: `resolveHeld('nope','approved')` → `false`, and `admit` is never called.
  - `the gate still decides: a re-held approval is remembered, a denied one attaches nothing`. Re-admit returns `held d2`: `collect()` → `[HELD]`, then `resolveHeld('d2','approved')` with `allow` → `[chip]`. In a separate tracker, re-admit returns `denied`: `[NOT_ATTACHED]`, warn `denied`.
  - `a file gone or linked since the hold never spends the approval`. Remove the file, or replace it with a symlink to a sibling. `resolveHeld` → `true`; `admit` was called once in total; `collect()` → `[NOT_ATTACHED]`.
  - `an approval answered while a turn runs lands once`: `resolveHeld` approved, then two `collect()` calls → `[chip]` then `[]`.
  - `remembers at most MAX_HELD_AUTO_ATTACH holds`: 257 files are held as d0..d256. `resolveHeld('d0','approved')` → `false`; `resolveHeld('d256','approved')` → `true`.
  - `resolveHeld never rejects`: a re-admit that throws resolves to `true`, `collect()` → `[NOT_ATTACHED]`, warn `error`.
- [ ] **Step 2: Write the failing acceptance test** in `run-runner.test.ts`: `approving a held auto-attach attaches the reference once and creates no blob`. Copy the harness from the `:192` test. `tool.pre-call` returns `hold d1` and then `allow`. `scriptInbox([{type:'decision-resolved', decisionId:'d1', outcome:'approved', note:'HOST NOTE'}])`. The loop writes `report.txt`, calls `endTurn`, then `seen = await ctx.nextMessage()` and records how many `tool.pre-call` calls there have been at that moment, then calls `endTurn` again, and finally `nextMessage()` → null. Assert:
  - `seen.content === 'System message (not from the user): ' + <approved note>`, and the content does not contain `HOST NOTE`.
  - The pre-call count at pull time is `2`, and the two payloads are `toEqual`.
  - `callBinaryUpload` was never called, and no `artifact.publish` or `blob.put` call was made.
  - The first tool turn-end has HELD and no `agent_file`. Exactly one later tool turn-end has `{type:'agent_file', path:'report.txt', mediaType:'text/plain', sizeBytes:6}`.
  - One `event.tool-post-call` carries that call and the chip as output.
- [ ] **Step 3: Write** `a decision-resolved the runner did not raise keeps the host note even with auto-attach on`. Same harness: d1 is held, but the delivery is for `d2`. The content is the host note, and the pre-call count stays at 1.
- [ ] **Step 4: Run** `pnpm --filter @ax/agent-runner-core test`. Expected: the new tests FAIL.
- [ ] **Step 5: Implement** the behaviour above. Update the `run-runner.ts:1296-1303` comment so it says a held chip is attached only after the person approves it and the gate itself then allows the identical call, at pull time (TASK-1017).
- [ ] **Step 6: Run** the tests and `tsc`. Expected: PASS. Then fill in the `security-checklist` section for this task. Prompt injection: the model cannot add entries to the held map, because only gate verdicts populate it, and the path comes from the runner's own scan. Approval bypass: the gate's `allow` is the only authority, and the inbox entry is just a prompt.
- [ ] **Step 7: Commit** `[TASK-1017] Approving a held auto-attach attaches the agent_file reference, no blob copy`

---

### Task 3: An invalid stored `agent_file` block costs its chip, not its turn `[tier: integration]`

**Files:**
- Modify: `packages/conversations/src/plugin.ts:1589-1650`
- Create: `packages/conversations/src/__tests__/invalid-agent-file-blocks.test.ts` (copy the harness in `legacy-attachment-blocks.test.ts`)
- Modify (stale line, rule 5): `packages/ipc-protocol/src/content-blocks.ts:224-230`
- Modify (comment only): `packages/channel-web/src/server/safe-path.ts`, the `workspaceFilePath` doc block

**Interfaces:**
- Produces, in conversations and module-private: `degradeInvalidAgentFileBlocks(rawBlocks: unknown): unknown`. Any `type === 'agent_file'` block that fails `AgentFileBlockSchema.safeParse` becomes `{ type: 'text', text: noLongerAvailableText(<last '/' segment of path, if path is a string>) }`. Pull the name rule out of `legacyAttachmentText` into `noLongerAvailableText(rawName: unknown): string`, which strips C0 and DEL, trims, and allows 1–255 units, falling back to `A file`. Both degrade functions use it. The order becomes `validateContentBlocks(degradeInvalidAgentFileBlocks(degradeLegacyAttachmentBlocks(rawBlocks ?? [])))`.

- [ ] **Step 1: Write the failing tests:**
  - `a stored agent_file block whose key fails today's rule keeps its turn`: stored blocks `[{type:'text', text:'Here you go.'}, {type:'agent_file', path:'notes: q3.md', mediaType:'text/markdown', sizeBytes:2}]` → the turn is present with `[{type:'text', text:'Here you go.'}, {type:'text', text:'notes: q3.md (this file is no longer available)'}]`.
  - `a nested key shows its last segment`: `path:'reports/a:b.pdf'` → `a:b.pdf (this file is no longer available)`.
  - `an agent_file block with a field the strict schema refuses degrades too`: a valid key plus `filename:'x'` → `ok.pdf (this file is no longer available)`.
  - `a key with no usable name reads A file`: `path: 42`, `path: ''` and a path of `'\u0007'` → `A file (this file is no longer available)`.
  - `a valid agent_file block passes through unchanged`.
- [ ] **Step 2: Run** `pnpm --filter @ax/conversations test -- invalid-agent-file-blocks`. Expected: FAIL (the turn is missing).
- [ ] **Step 3: Implement.** Also update `projectEventTurns`'s doc comment to name the new step.
- [ ] **Step 4: Fix the stale line** in `content-blocks.ts:224-230`. Replace "Loosen only, never tighten … drops its whole turn … needs a degrade step first" with this: prefer loosening. Stored turns are re-checked when read. Since TASK-1017 a block that fails `AgentFileBlockSchema` is shown as `<name> (this file is no longer available)` (conversations' `degradeInvalidAgentFileBlocks`). So tightening the rule costs every stored chip it stops accepting its download, but never its turn. The parity test pins the rule to `safePath`, so the two change together.
- [ ] **Step 5: Add a pointer** to `workspaceFilePath`'s doc. `isAgentFilePath` (`@ax/ipc-protocol`) restates this rule for chat chips, and `agent-file-path-parity.test.ts` pins the two together. Tightening this rule turns every stored chip it stops accepting into a "no longer available" line. The `:` refusal stays on purpose (TASK-1017).
- [ ] **Step 6: Run** the conversations tests, `pnpm --filter @ax/ipc-protocol test`, `pnpm --filter @ax/channel-web test -- agent-file-path-parity` and `tsc`. Expected: PASS.
- [ ] **Step 7: Commit** `[TASK-1017] Invalid stored agent_file blocks degrade to a "no longer available" line instead of dropping the turn`

---

### Task 4: The chip says "no longer available" up front `[tier: sensitive]` (security-checklist, shadcn)

**Files:**
- Modify: `packages/channel-web/src/server/user-file-download.ts` (add `sendUserFileStatus`; leave `sendUserFileDownload` unchanged)
- Modify: `packages/channel-web/src/server/routes-workspace.ts`. Pull the ACL half of `conversationAgentFileDownload` (:7943-7988) out into a closure that both handlers share. Add `conversationAgentFileStatus`, register the route beside :9870, and update the route list in the header (:21-23, :77).
- Modify: `packages/channel-web/src/components/workspace/GeneratedFileChip.tsx`, `packages/channel-web/src/components/workspace/AgentConversation.tsx:1407` (pass `recheckKey`)
- Test: `src/__tests__/server/routes-workspace-conversation-file.test.ts`, `src/__tests__/server/routes-workspace-registration.test.ts:115`, `src/components/workspace/__tests__/GeneratedFileChip.test.tsx`, `presets/k8s/src/__tests__/acceptance.test.ts` step 11

**Interfaces:**
- Route: `GET /api/workspace/conversations/:conversationId/status/user-files/*`. It runs the same ACL, in the same order, as the download route: auth → `conversations:get-metadata` → `resolveAgentOr404` → `workspaceFilePath`.
- `sendUserFileStatus({ bus, ctx, owner, relPath, res }): Promise<void>`, where `res` is `Pick<StreamingDownloadResponse, 'status' | 'header' | 'json'>`. It makes **one** `sandbox:read-user-file-range` call with `{ offset: 0, length: 0 }`. Answers:
  - file → 200 `{ available: true }` with `cache-control: private, no-store`
  - absent → 404 `file-not-found`
  - dir → 400 `not-a-file`
  - `unavailable`, no range service, or a throw with code `user-files-download-unavailable` → 503 `user-files-unavailable`
  - any other throw, or a non-object answer → 503 `file-read-failed`, logged with `READ_FAILED` and the error codes only
  - There is no 413.
- Chip: `GeneratedFileChip({ file, conversationId, recheckKey }: { …; recheckKey?: number })`. Only agent-file chips (`file.agentFilePath !== undefined`) check. They check when they mount and again whenever `recheckKey` changes, with an `AbortController` aborted on cleanup. The URL is `/api/workspace/conversations/${encodeURIComponent(conversationId)}/status/user-files/${encodeURIComponent(path)}`, built inside the effect inside a try (an encode throw counts as "unknown"). **Only 404 or 400 means gone.** Everything else (200, 401, 403, 5xx, a network error, an abort) leaves the chip as it was. When gone: the button is disabled, the secondary line reads exactly `No longer available`, and the aria-label reads `${name} is no longer available`. `AgentConversation` passes `recheckKey={thread.length}`, so a turn in which the agent deleted the file updates the chip.

- [ ] **Step 1: Write the failing route tests** (a new `describe('the chat file chip status route')`):
  - `answers 200 for a file and reads no bytes`: the range spy saw exactly one call, `{offset:0, length:0}`.
  - `404 when the file is gone`, `400 not-a-file for a folder`.
  - `checks the conversation before the path`: a foreign conversation answers 404 for both a real key and `../../secret`, and the range spy is never called.
  - `401 without a session`.
  - `503 user-files-unavailable when there is no host mount`, `503 file-read-failed on any other read error`.
  - In the registration test, add `{ method: 'GET', path: '/api/workspace/conversations/:conversationId/status/user-files/*' }`.
- [ ] **Step 2: Write the failing chip tests:**
  - `an agent file that is gone says so before any click`: the status fetch returns 404, the text `No longer available` appears, and the button is disabled.
  - `a status that is not 404 or 400 leaves the chip downloadable`: 503 and a rejected fetch.
  - `rechecks when a new turn lands`: rerender with `recheckKey` going from 1 to 2 → two status fetches; the second answers 404 → gone.
  - `an attachment chip never checks`: no status fetch when `attachmentId` is set.
- [ ] **Step 3: Run** `pnpm --filter @ax/channel-web test -- routes-workspace-conversation-file routes-workspace-registration GeneratedFileChip`. Expected: FAIL.
- [ ] **Step 4: Implement** the server half and then the client half. Invoke the `shadcn` skill first, and use only the existing `Button` and tokens.
- [ ] **Step 5: Extend canary step 11** in `presets/k8s/src/__tests__/acceptance.test.ts`. Before 11d, status on `chipUrl`'s key → 200 `{available:true}`, and a foreign user → 404. After the file is deleted in 11d → 404, and the folder key → 400. CI runs this test (Linux + Docker). Locally, run tsc on the preset.
- [ ] **Step 6: Run** the tests, `tsc` and `pnpm lint`. Expected: PASS. Then fill in the `security-checklist` section for this task. The route uses the same ACL and validator as the download route and reveals only whether a file exists, which a person who can open the Files tab already knows. It reads no bytes and starts no pod.
- [ ] **Step 7: Commit** `[TASK-1017] File chips check whether the file still exists (metadata only) and say "No longer available" up front`

---

### Task 5: Design doc as-built `[tier: mechanical]`

**Files:** Modify `docs/plans/2026-10-29-agent-files-simplification-design.md` §12, after the TASK-1012 as-built paragraph (:375-393).

- [ ] **Step 1:** Add `- **As built (TASK-1017):**` and cover four points:
  - Approving a held auto-attach makes the runner re-send the identical call at pull time and attach the `agent_file` reference: no blob, charged once. A cold session, where the hold was raised by an earlier session, still attaches nothing on approval (accepted residual).
  - An invalid stored `agent_file` block reads as "<name> (this file is no longer available)" and its turn stays.
  - Chips check whether their file exists through `GET …/conversations/:id/status/user-files/*` (a length-0 range read: no bytes, no pod) when they mount and after each turn.
  - `workspaceFilePath` keeps refusing `:`.
- [ ] **Step 2: Commit** `[TASK-1017] Design doc: as-built for chip follow-ups`

## Out of scope (record as follow-ups in the PR body)

- In a cold session, approving an auto-attach attaches nothing. It would need the next session to learn about approved-pending holds, which is new host surface.
- Under `ask`, one turn that makes N files raises N approval cards.
- A **denied** file still gets "Ask the agent to attach them again", which cannot work.
- Model-free handling of the approval turn. It would save a model turn, but it means emitting turn-ends outside the loop, on top of the TASK-573/708 reqId hand-over.
