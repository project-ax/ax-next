# Phase 3 Attachments Follow-ups — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the six remaining follow-ups surfaced by Phase 3 (PRs #97, #98) so the attachments + artifacts round-trip is complete end-to-end: live-frame chips render, an artifact_publish round-trip is canary-covered, the supporting `conversations:get` plumbing returns turns again, and the admin UX can attach `artifact_publish` to an agent.

**Architecture:** Each follow-up is a small surgical change against the Phase 3 surface — no new plugins, no new hook surface. The plan is sequenced so independent cleanups (F3, F4) ship first as a single "tidy" commit, the live-frame UX gap (F1) is fixed before the canary that depends on it (F2), and the two external blockers (E1 default tool, E2 0-turns plumbing) are resolved in the middle so Task 6's e2e canary has a working substrate.

**Tech Stack:** TypeScript + vitest. Browser-side: assistant-ui `MessagePrimitive.Attachments` slot, shadcn primitives. Server-side: existing `@ax/attachments` + `@ax/conversations` + `@ax/tool-artifact-publish` (no new deps).

**Predecessors:**
- PR #97 — Phase 3 channel-web wiring (merged)
- PR #98 — smoke-driven dup-chip + parent-mismatch fixes (merged)

**Scope check:** Each task is independently shippable. F2 (Task 6) depends on E2 (Task 5) being resolved. Everything else is parallelizable.

---

## File Structure

**Modify:**
- `packages/channel-web/src/components/AttachmentComposerChip.tsx` — remove the bespoke inline progress bar and consume the now-installed `<Progress />` shadcn primitive (Task 1).
- `packages/channel-web/src/components/ui/progress.tsx` — keep (used by the chip after Task 1).
- `packages/channel-web/src/__tests__/server/routes-attachments.test.ts` — add a direct test for the route's `'max file size'` substring → 413 mapping branch (Task 2).
- `packages/channel-web/src/components/Thread.tsx` — wrap `UserMessage` with `MessagePrimitive.Attachments` slot; add `LiveAttachmentChip` for the slot (Task 3).
- `packages/channel-web/src/components/AttachmentChip.tsx` — add a `pending` variant that renders display-name without a download action (Task 3).
- `packages/channel-web/src/__tests__/thread-attachments.test.tsx` — add a test that proves the Attachments-slot chip renders for the live frame (Task 3).
- `presets/k8s/src/index.ts` — bump `phase-d-agent`'s default `allowed_tools` to include `artifact_publish` for new clusters (Task 4).
- `packages/channel-web/src/components/admin/AgentForm.tsx` — verify (and fix if missing) that the tools picker exposes `artifact_publish` (Task 4).
- `packages/conversations/src/handlers.ts` (or wherever `conversations:get` resolves the workspace jsonl path) — root-cause `workspace:list` returning empty for live conversations and apply the fix the investigation produces (Task 5).
- `presets/k8s/src/__tests__/acceptance.test.ts` — extend the Phase 3 canary with an `artifact_publish` round-trip sub-test (Task 6).
- `packages/channel-web/src/__tests__/server/routes-chat.test.ts` — no change expected.

**Create:**
- None unless Task 5's investigation surfaces a structural fix.

**Do not touch:**
- `packages/attachments/**` — already settled by PR #98.
- `packages/tool-artifact-publish/**` — Phase 2 ships the descriptor.

---

## Task 1: Tidy — consume `Progress` primitive in `AttachmentComposerChip`, drop the bespoke bar (F3)

**Decision:** consume rather than delete. The shadcn `Progress` primitive was installed in Task 10 of the Phase 3 plan but the chip rolls its own bar. Two consumers later you'd end up reinstalling it; either way the lint inventory should reflect "we have a Progress primitive and we use it." Consume here.

**Files:**
- Modify: `packages/channel-web/src/components/AttachmentComposerChip.tsx`

- [ ] **Step 1: Inspect the existing inline progress bar block**

Open the file. The bespoke bar is the `<div role="progressbar" …>` block inside the chip's main flex row. Note the surrounding classes (`mt-0.5 h-1 w-full overflow-hidden rounded-full bg-muted`) — the replacement should match the visual mass (height 1 px tailwind = ~4px in this codebase's spacing scale; verify against current visual before swapping).

- [ ] **Step 2: Add the import**

At the top of the file alongside the existing `Button` import:

```tsx
import { Progress } from '@/components/ui/progress';
```

- [ ] **Step 3: Replace the inline bar**

Find this block (current code):

```tsx
{isUploading && progress !== null && (
  <div
    className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-muted"
    role="progressbar"
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={progress}
  >
    <div
      className="h-full bg-primary transition-all"
      style={{ width: `${progress}%` }}
    />
  </div>
)}
```

Replace with:

```tsx
{isUploading && progress !== null && (
  <Progress value={progress} className="mt-0.5 h-1 w-full" />
)}
```

The shadcn `Progress` primitive already wires `role="progressbar"` and the ARIA value attributes via `@radix-ui/react-progress`, and PR #98 added the `[0,100]` clamp inside the primitive — no inline guard needed here.

- [ ] **Step 4: Build + tests**

```bash
pnpm --filter @ax/channel-web test -- attachment-composer-chip
pnpm --filter @ax/channel-web build
```

Expected: PASS for both. The chip test's `role=progressbar` assertion still satisfies — Radix renders the same role on the root.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/components/AttachmentComposerChip.tsx
git commit -m "refactor(channel-web): use shadcn Progress in AttachmentComposerChip"
```

---

## Task 2: Direct test for the route's `'max file size'` → 413 mapping branch (F4)

The route disambiguates the `attachments:store-temp` hook's overloaded `invalid-payload` code via two substring checks. The 413 branch is currently shadowed by the framework's content-length 413 short-circuit — a substring rename in the hook would silently regress to 400 with no test catching it. Add the missing fixture.

**Files:**
- Modify: `packages/channel-web/src/__tests__/server/routes-attachments.test.ts`

- [ ] **Step 1: Find the existing `describe` block**

Look for `describe('POST /api/attachments', …)`. The 6 existing cases are auth/happy/415/413-framework/400/foreign-Origin. We'll add a 7th case that bypasses the framework cap so the route's own 413 branch fires.

- [ ] **Step 2: Add the test**

Append inside the same `describe` block (right after the framework-413 case):

```ts
  it('rejects 413 attachment-too-large when attachments:store-temp rejects on hook-level cap', async () => {
    // Configure the attachments plugin with a 1 KiB per-file cap. The
    // framework's per-route cap stays at 25 MiB, so a 2 KiB body sails
    // through the framework and the route's own substring-mapping
    // branch is the one that fires.
    const h = await makeHarness({
      userId: 'u1',
      attachmentsConfig: { maxFileBytes: 1024 },
    });
    const { body, headers } = makeMultipart([
      {
        name: 'file',
        filename: 'big.txt',
        contentType: 'text/plain',
        body: Buffer.alloc(2 * 1024, 0x41),
      },
    ]);
    const r = await h.fetch('/api/attachments', { method: 'POST', body, headers });
    expect(r.status).toBe(413);
    expect((await r.json()).error).toBe('payload-too-large');
    await h.shutdown();
  });
```

The existing `makeHarness` factory already accepts `attachmentsConfig`. If it doesn't (verify by reading the factory), extend it with one optional field forwarded to `createAttachmentsPlugin`.

- [ ] **Step 3: Run + verify**

```bash
pnpm --filter @ax/channel-web test -- routes-attachments
```

Expected: 7/7 in this describe block.

- [ ] **Step 4: Commit**

```bash
git add packages/channel-web/src/__tests__/server/routes-attachments.test.ts
git commit -m "test(channel-web): direct test for POST /api/attachments 413 hook-mapping branch"
```

---

## Task 3: Live-frame attachment chip via `MessagePrimitive.Attachments` slot (F1)

The AI SDK bridge (`@assistant-ui/react-ai-sdk`'s `convertMessage`) routes user-message `file` parts INTO `attachments` rather than `content.parts`. The Phase 3 `UserFilePart` slot under `MessagePrimitive.Parts.components.File` is the history-load path, which works only after a page reload. For the live frame, render the chip via the `Attachments` slot.

**Constraint discovered during smoke:** the live-frame attachment carries `data: ax://attachment/<id>` — the *attachmentId*, NOT the workspace path. The chip can't build a `GET /api/files?path=…` URL until the runner writes the user-turn jsonl and a subsequent `conversations:get` returns the rewritten `attachment` block. So the live-frame chip is **name-only** (no download action). After page reload, the history-load adapter delivers `ax://attachment-path/<base64(path)>` and the chip becomes downloadable.

**Files:**
- Modify: `packages/channel-web/src/components/AttachmentChip.tsx` — add `variant="pending"`.
- Modify: `packages/channel-web/src/components/Thread.tsx` — wire `MessagePrimitive.Attachments`.
- Modify: `packages/channel-web/src/__tests__/thread-attachments.test.tsx` — add a live-frame test.

- [ ] **Step 1: Extend `AttachmentChip` with a `pending` variant**

Open `AttachmentChip.tsx`. The existing component takes `{ path, displayName, mediaType, conversationId, sizeBytes? }`. Add a discriminated `variant` field:

```tsx
export type AttachmentChipProps =
  | {
      variant?: 'downloadable';
      path: string;
      displayName: string;
      mediaType: string;
      conversationId: string;
      sizeBytes?: number;
    }
  | {
      variant: 'pending';
      displayName: string;
      mediaType: string;
    };
```

Inside the component, branch on the variant. The `pending` branch renders the same icon + name layout, but no `Download` button and no click handler:

```tsx
if (props.variant === 'pending') {
  const Icon = pickIcon(props.mediaType);
  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 max-w-[280px]',
        'rounded-md border border-border bg-card px-2.5 py-1.5',
        'text-[12px] leading-tight text-foreground',
        'opacity-80',
      )}
      data-variant="pending"
    >
      <div className="size-7 shrink-0 rounded-sm bg-muted flex items-center justify-center text-muted-foreground">
        <Icon className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="truncate font-medium">{props.displayName}</div>
      </div>
    </div>
  );
}
```

(The existing downloadable branch stays unchanged but moves under an `else` so the union narrows.)

- [ ] **Step 2: Add a `LiveAttachmentChip` adapter in Thread.tsx**

In `Thread.tsx`, sibling to `UserFilePart`, add a component for the `Attachments` slot:

```tsx
interface LiveAttachmentLike {
  name?: string;
  contentType?: string;
  content?: ReadonlyArray<{ type?: string; data?: string; filename?: string; mimeType?: string }>;
}

const LiveAttachmentChip: FC = () => {
  // useAttachment returns the assistant-ui Attachment object for this slot.
  // We don't need to download in the live frame; the history-load path
  // (UserFilePart, MessagePrimitive.Parts.components.File) handles that
  // after reload.
  const attachment = useAttachment(
    (a) => a as unknown as LiveAttachmentLike,
    () => false,
  );
  const filename =
    attachment.content?.[0]?.filename ??
    attachment.name ??
    'file';
  const mediaType =
    attachment.content?.[0]?.mimeType ??
    attachment.contentType ??
    'application/octet-stream';
  return (
    <AttachmentChip variant="pending" displayName={filename} mediaType={mediaType} />
  );
};
```

Add the necessary imports at the top of the file:

```tsx
import { useAttachment } from '@assistant-ui/react';
```

(`AttachmentChip` is already imported.)

- [ ] **Step 3: Wire the Attachments slot into UserMessage**

In the existing `UserMessage` component, add `MessagePrimitive.Attachments` adjacent to (above) the existing `MessagePrimitive.Parts`:

```tsx
const UserMessage: FC = () => (
  <MessagePrimitive.Root asChild>
    <div className="msg you mb-[22px] flex flex-col items-end relative max-w-full" data-role="user">
      <MessagePrimitive.Attachments
        components={{ Attachment: LiveAttachmentChip }}
      />
      <div className="msg-body bg-muted text-foreground …">
        <MessagePrimitive.Parts components={{ Text: MarkdownText, File: UserFilePart }} />
      </div>
      {/* … existing ActionBarPrimitive.Root … */}
    </div>
  </MessagePrimitive.Root>
);
```

Note: `MessagePrimitive.Attachments`'s `components` prop has the same `{ Attachment, File, Image, Document }` shape as the composer's slot. We use `Attachment` (catch-all) so the chip fires for any file-typed attachment.

- [ ] **Step 4: Test — live-frame chip renders**

Append to `packages/channel-web/src/__tests__/thread-attachments.test.tsx`:

```tsx
describe('Thread live-frame attachment rendering', () => {
  it('renders LiveAttachmentChip via MessagePrimitive.Attachments for a just-sent message', () => {
    const runtime = useExternalStoreRuntime({
      isRunning: false,
      messages: [
        {
          role: 'user',
          id: 'm1',
          createdAt: new Date(),
          content: [{ type: 'text', text: 'see attached' }],
          attachments: [
            {
              id: 'att-1',
              type: 'document',
              name: 'live.pdf',
              contentType: 'application/pdf',
              status: { type: 'complete' },
              content: [
                {
                  type: 'file',
                  data: 'ax://attachment/att-1',
                  mimeType: 'application/pdf',
                  filename: 'live.pdf',
                },
              ],
            },
          ],
        },
      ],
      // Other ExternalStoreAdapter required fields (onNew, etc.) — copy
      // from the existing tests in this file.
    } as never);
    render(
      <AssistantRuntimeProvider runtime={runtime}>
        <Thread />
      </AssistantRuntimeProvider>,
    );
    // The pending-variant chip renders the filename, NO Download button.
    expect(screen.getByText('live.pdf')).toBeTruthy();
    expect(screen.queryByLabelText(/Download/)).toBeNull();
  });
});
```

(If `useExternalStoreRuntime`'s shape differs from this fixture, adapt to whatever shape the existing thread-attachments test already uses. The key invariant: a user message with an `attachments` array (NOT a `file` part inside `content`) must render via the live-frame chip slot.)

- [ ] **Step 5: Run + build**

```bash
pnpm --filter @ax/channel-web test -- thread-attachments attachment-chip
pnpm --filter @ax/channel-web build
```

Expected: pre-existing chip tests still pass, new live-frame test passes.

- [ ] **Step 6: Commit**

```bash
git add packages/channel-web/src/components/Thread.tsx packages/channel-web/src/components/AttachmentChip.tsx packages/channel-web/src/__tests__/thread-attachments.test.tsx
git commit -m "feat(channel-web): live-frame attachment chip via MessagePrimitive.Attachments slot"
```

---

## Task 4: Make `artifact_publish` available to default agents (E1)

The Phase 3 smoke against `phase-d-agent` failed S3 because the agent's `allowed_tools` is hard-coded to `["Bash","Read"]`. Two surfaces need updating: (a) the preset default for newly-created dev agents; (b) the admin UI's tool picker (verify it lists `artifact_publish` at all). Without (b), even a manual fix via SQL gets blown away the next time someone edits the agent in the UI.

**Files:**
- Modify: `presets/k8s/src/index.ts` — wherever the dev-bootstrap agent is created.
- Modify: `packages/channel-web/src/components/admin/AgentForm.tsx` — extend the tools list.
- Modify (existing test): `packages/channel-web/src/components/admin/__tests__/AgentForm*.test.tsx` if any tools-list assertions live there.

- [ ] **Step 1: Find the agent-creation seed in the k8s preset**

```bash
grep -n "allowed_tools\|allowedTools\|phase-d-agent\|displayName.*phase-d" presets/k8s/src/index.ts deploy/charts/ax-next/templates/* 2>/dev/null | head
```

Most likely the agent is created via SQL bootstrap or via a `agents:create` call wired in the chart's postgres-init Job. Find the spot. If no such bootstrap exists (the agent in the cluster was created via the admin UI), skip to Step 2 and update via UI on the cluster, then assert the seed in the preset matches.

- [ ] **Step 2: Add `artifact_publish` to the default `allowed_tools`**

Wherever the seed list is, ensure `artifact_publish` is present. Example shape:

```ts
allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'artifact_publish']
```

If the agent is seeded via SQL DDL in postgres-init, update the SQL.

- [ ] **Step 3: Verify the admin UI tool-picker lists `artifact_publish`**

Open `AgentForm.tsx`. There's a tools selector — look for the source list (could be hardcoded, fetched from a tool-descriptor hook, or sourced from `tools:list-descriptors`). If hardcoded, add `'artifact_publish'`. If sourced from a hook, confirm `@ax/tool-artifact-publish` registers a descriptor that flows through.

```bash
grep -n "allowedTools\|tool.*name.*artifact\|tools:list-descriptors" packages/channel-web/src/components/admin/AgentForm.tsx | head
```

If `artifact_publish` is already in the dropdown, no change needed; document in the task comments.

- [ ] **Step 4: Update phase-d-agent in the running kind cluster**

Manual SQL on the dev cluster (one-shot, not part of the commit):

```bash
PASS=$(kubectl -n ax-next get secret ax-next-postgresql -o jsonpath='{.data.postgres-password}' | base64 -d)
kubectl -n ax-next exec ax-next-postgresql-0 -- env PGPASSWORD="$PASS" psql -U postgres -d ax_next -c \
  "UPDATE agents_v1_agents SET allowed_tools = '[\"Bash\",\"Read\",\"Write\",\"Edit\",\"artifact_publish\"]'::jsonb WHERE display_name = 'phase-d-agent';"
```

Verify in the admin UI that the change is reflected.

- [ ] **Step 5: Run preset.test.ts**

```bash
pnpm --filter @ax/preset-k8s test -- preset.test
```

Expected: still passes (no plugin-list drift).

- [ ] **Step 6: Commit**

```bash
git add presets/k8s/src/index.ts packages/channel-web/src/components/admin/AgentForm.tsx
git commit -m "feat(presets,channel-web): default agents allow artifact_publish; admin UI lists it"
```

---

## Task 5: Spike — investigate why `conversations:get` returns 0 turns (E2)

Discovered during smoke: every conversation returns `{ turns: [] }` from `GET /api/chat/conversations/:id`, even immediately after a successful assistant turn that visibly rendered in the live frame. Affects ALL existing conversations on the dev cluster — pre-existing, not a Phase 3 regression — but it gates the rest of this plan (Task 6 canary, history-load chip download, S5 of the original smoke).

This is a spike: outcome is a written diagnosis + either an inline fix or a redirect to a separate plan.

**Files:**
- Read: `packages/conversations/src/handlers.ts`, `packages/conversations/src/plugin.ts` — the read path.
- Read: `packages/agent-claude-sdk-runner/src/main.ts` — the write path (HOME redirect, jsonl emission).
- Read: `packages/workspace-git-server/src/client/git-engine.ts` — `list` impl for the `pathGlob` matching.

- [ ] **Step 1: Confirm the jsonl exists in the workspace**

Use the workspace-list/read service hooks from a one-shot probe (run inside the host pod's node REPL or via a tiny CLI subcommand):

```bash
# Find the runner_session_id of a recent conversation
PASS=$(kubectl -n ax-next get secret ax-next-postgresql -o jsonpath='{.data.postgres-password}' | base64 -d)
kubectl -n ax-next exec ax-next-postgresql-0 -- env PGPASSWORD="$PASS" psql -U postgres -d ax_next -c \
  "SELECT conversation_id, runner_session_id, user_id, agent_id FROM conversations_v1_conversations WHERE runner_session_id IS NOT NULL ORDER BY updated_at DESC LIMIT 3;"
```

Pick one row. Note the `runner_session_id`.

- [ ] **Step 2: Check whether the jsonl is in the workspace at all**

The expected path per `runner-owned-sessions` design: `.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. Probe via the git-server's debug endpoint or `kubectl exec` into the git-server pod:

```bash
kubectl -n ax-next exec ax-next-git-server-experimental-0 -- ls -la /var/lib/ax/workspaces/ 2>&1 | head -20
# Pick a workspace dir, inspect the bare repo:
kubectl -n ax-next exec ax-next-git-server-experimental-0 -- git -C /var/lib/ax/workspaces/<workspaceId> ls-tree -r HEAD --name-only 2>&1 | grep -E '\.jsonl$' | head
```

If the jsonl is absent → root cause is the runner not writing. If present → root cause is `conversations:get`'s read path.

- [ ] **Step 3: Read `conversations:get` to confirm the glob it uses**

```bash
grep -n "workspace:list\|pathGlob\|projects" packages/conversations/src/handlers.ts | head
```

Confirm the glob shape matches what's actually on disk. Common drift: the `<encoded-cwd>` segment is now `.claude/projects/-permanent/...` per Phase 2 of runner-owned-sessions but the read path still looks for the legacy shape.

- [ ] **Step 4: Capture host-side debug logs for one `conversations:get` call**

```bash
kubectl -n ax-next logs deploy/ax-next-host --tail=200 | grep -iE "conversations_get|workspace_list|runner_session_id" | tail -20
```

Drive a single GET via the browser (with a known conversation id from Step 1) and re-tail logs. The `conversations:get` handler should log the path glob and the resulting paths; if it doesn't, add temporary logging to find out.

- [ ] **Step 5: Document findings**

Write a short investigation note to `docs/plans/2026-05-19-conversations-get-zero-turns-investigation.md`. Three buckets the diagnosis falls into:

  1. **runner never writes** — broader Phase E issue; out of scope for this plan, file a separate plan.
  2. **path-glob drift** — fix the glob inline (1-line change + a regression test); ship as part of this plan.
  3. **workspace-resolution drift** — `conversations:get` reads the wrong workspace (e.g., wrong `(userId,agentId)` derivation); fix inline + test.

- [ ] **Step 6: Implement the inline fix (case 2 or 3 only)**

If the diagnosis fits case 2 or 3, apply the fix in the same commit as the investigation note. Add a regression test:

```ts
// e.g., in packages/conversations/src/__tests__/jsonl-glob.test.ts
it('finds jsonl at .claude/projects/-permanent/<sessionId>.jsonl', async () => { … });
```

If case 1 (broader Phase E), the spike's deliverable is just the investigation note + a follow-up plan filed in `docs/plans/2026-05-19-runner-jsonl-write-phase-e-followup.md`.

- [ ] **Step 7: Run tests + commit**

```bash
pnpm --filter @ax/conversations test
pnpm --filter @ax/conversations build
git add docs/plans/2026-05-19-conversations-get-zero-turns-investigation.md \
  packages/conversations/src/handlers.ts \
  packages/conversations/src/__tests__/  # if you added a regression test
git commit -m "fix(conversations): <describe the diagnosis + the fix>"
```

If the spike concluded case 1, commit ONLY the investigation note and skip the code commit.

---

## Task 6: Phase 3 canary — artifact_publish round-trip (F2)

Builds on Tasks 4 + 5. The Phase 3 canary in `presets/k8s/src/__tests__/acceptance.test.ts` covers the user-attachment round-trip. Add a sibling sub-test that exercises an agent emitting `artifact_publish` → `ArtifactChip`-renderable transcript → GET /api/files returns the artifact bytes.

**Pre-req:** Task 5 either fixed or proved-irrelevant for the canary (the canary seeds jsonl directly via `workspace:apply`, mirroring the Phase D canary's approach, so it does NOT need a real runner — but it DOES need `conversations:get` to find the seeded jsonl).

**Files:**
- Modify: `presets/k8s/src/__tests__/acceptance.test.ts`

- [ ] **Step 1: Locate the existing Phase 3 canary**

Search for `Phase 3 canary` in `acceptance.test.ts`. The sibling sub-test goes alongside it.

```bash
grep -n "Phase 3 canary" presets/k8s/src/__tests__/acceptance.test.ts
```

- [ ] **Step 2: Write the new sub-test**

```ts
it(
  'Phase 3 canary: artifact_publish round-trip via assistant tool_result + GET /api/files',
  { timeout: 180_000 },
  async () => {
    const connectionString = await ensurePostgresStarted();
    const serverToken = randomBytes(32).toString('hex');
    const serverRepoRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'ax-phase-3-artifact-canary-')),
    );

    let server: WorkspaceGitServer | null = null;
    let handle: Awaited<ReturnType<typeof bootstrap>> | null = null;

    try {
      server = await createWorkspaceGitServer({
        repoRoot: serverRepoRoot, host: '127.0.0.1', port: 0, token: serverToken,
      });

      // Same minimal plugin list as the existing Phase 3 canary, plus
      // createToolArtifactPublishPlugin and a stub agent:invoke that
      // emits the assistant turn carrying artifact_publish.
      const stubAgentInvoke: Plugin = {
        manifest: {
          name: '@test/agent-invoke-artifact-stub',
          version: '0.0.0',
          registers: ['agent:invoke'],
          calls: [],
          subscribes: [],
        },
        init({ bus }) {
          bus.registerService('agent:invoke', '@test/agent-invoke-artifact-stub', async () => {
            // Fire-and-forget: chat-messages dispatches async and returns 202.
            // We don't write the user turn here; the canary seeds the jsonl
            // directly via workspace:apply below (matches Phase D pattern).
            return { kind: 'complete', messages: [] } as AgentOutcome;
          });
        },
      };

      const plugins: Plugin[] = [
        // … same minimal stack as the existing Phase 3 canary …
        createToolArtifactPublishPlugin(),
        stubAgentInvoke,
      ];

      handle = await bootstrap({ bus: new HookBus(), plugins, config: {} });
      const port = http.boundPort();

      // 1) Skip POST /api/attachments — this canary focuses on the
      //    artifact-render half. Pre-commit the artifact file via
      //    workspace:apply (with parent-mismatch retry).
      const userId = 'canary-user';
      const ctx = makeAgentContext({ sessionId: 'phase-3-artifact-canary', agentId: 'agent-1', userId });

      // 2) Mint a conversation via channel-web's chat-messages handler.
      const chatResp = await fetch(`http://127.0.0.1:${port}/api/chat/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: `http://127.0.0.1:${port}`,
          'x-requested-with': 'ax-admin',
          'x-test-user': userId,
        },
        body: JSON.stringify({
          conversationId: null,
          agentId: 'agent-1',
          contentBlocks: [{ type: 'text', text: 'make me a summary file' }],
        }),
      });
      expect(chatResp.status).toBe(202);
      const { conversationId } = await chatResp.json() as { conversationId: string };

      // 3) Pre-commit the artifact file at /permanent/summary.md.
      const artifactPath = 'workspace/summary.md';
      const artifactBytes = new TextEncoder().encode('# Summary\n\nLooks good.\n');
      await handle.bus.call('workspace:apply', ctx, {
        changes: [{ path: artifactPath, kind: 'put', content: artifactBytes }],
        parent: null, // empty workspace at this point in the canary
        reason: 'phase 3 artifact canary: seed artifact',
      });

      // 4) Bind a runnerSessionId + seed an assistant-turn jsonl that
      //    carries an artifact_publish tool_use + tool_result.
      const runnerSessionId = '00000000-0000-0000-0000-deadbeefcafe';
      await handle.bus.call('conversations:store-runner-session', ctx, {
        conversationId, runnerSessionId,
      });
      const sha256 = createHash('sha256').update(artifactBytes).digest('hex');
      const artifactResult = {
        artifactId: 'art-canary-1',
        downloadUrl: 'ax://artifact/art-canary-1',
        path: artifactPath,
        displayName: 'summary.md',
        mediaType: 'text/markdown',
        sizeBytes: artifactBytes.byteLength,
        sha256,
      };
      const userLine = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'make me a summary file' }] },
        uuid: 'u-1', timestamp: '2026-05-19T00:00:00.000Z', sessionId: runnerSessionId,
      });
      const assistantLine = JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg-canary', type: 'message', role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'artifact_publish', input: { path: artifactPath, displayName: 'summary.md' } },
            { type: 'tool_result', tool_use_id: 'toolu_1', content: JSON.stringify(artifactResult) },
            { type: 'text', text: 'Done. See [download](ax://artifact/art-canary-1).' },
          ],
        },
        uuid: 'u-2', timestamp: '2026-05-19T00:00:01.000Z', sessionId: runnerSessionId,
      });
      const jsonlPath = `.claude/projects/-permanent/${runnerSessionId}.jsonl`;
      const cur = await handle.bus.call('workspace:read', ctx, { path: artifactPath });
      await handle.bus.call('workspace:apply', ctx, {
        changes: [{
          path: jsonlPath, kind: 'put',
          content: new TextEncoder().encode(userLine + '\n' + assistantLine + '\n'),
        }],
        parent: (cur as { found: true; version: string }).version,
        reason: 'phase 3 artifact canary: seed jsonl',
      });

      // 5) GET /api/files for the artifact path.
      const r = await fetch(
        `http://127.0.0.1:${port}/api/files?path=${encodeURIComponent(artifactPath)}&conversationId=${encodeURIComponent(conversationId)}`,
        { headers: { 'x-test-user': userId } },
      );
      expect(r.status).toBe(200);
      expect(await r.text()).toBe('# Summary\n\nLooks good.\n');

      // 6) Verify the conversation transcript carries the artifact_publish
      //    tool_use + tool_result so MarkdownText's Anchor can resolve
      //    ax://artifact/art-canary-1 to a downloadable chip.
      const conv = await handle.bus.call('conversations:get', ctx, { conversationId, userId });
      const turns = (conv as { turns: Array<{ role: string; contentBlocks: Array<{ type: string; name?: string; tool_use_id?: string }> }> }).turns;
      const assistantTurn = turns.find((t) => t.role === 'assistant');
      expect(assistantTurn).toBeTruthy();
      const toolUse = assistantTurn!.contentBlocks.find((b) => b.type === 'tool_use' && b.name === 'artifact_publish');
      const toolResult = assistantTurn!.contentBlocks.find((b) => b.type === 'tool_result' && b.tool_use_id === 'toolu_1');
      expect(toolUse).toBeTruthy();
      expect(toolResult).toBeTruthy();
    } finally {
      if (handle !== null) await handle.shutdown();
      if (server !== null) await server.close();
      await fs.rm(serverRepoRoot, { recursive: true, force: true });
    }
  },
);
```

(The exact harness helpers — `bootstrap`, `createWorkspaceGitServer`, `ensurePostgresStarted`, etc. — match the existing Phase 3 canary. Reuse them verbatim. Don't introduce a parallel test harness.)

- [ ] **Step 3: Run + verify**

```bash
pnpm --filter @ax/preset-k8s test -- acceptance.test
```

Expected: all preset-k8s tests pass (existing + the new sub-test).

- [ ] **Step 4: Commit**

```bash
git add presets/k8s/src/__tests__/acceptance.test.ts
git commit -m "test(preset-k8s): Phase 3 canary — artifact_publish round-trip"
```

---

## Task 7: Re-walk the manual smoke against `ax-next-dev`

Now that F1–F4 + E1–E2 are landed, re-walk Section A from the predecessor smoke. This is the acceptance gate for the whole plan.

**Pre-req:** `make image` (Tasks 1, 3, 5 changed host or runner code; Task 4's preset change requires image rebuild; F1 affects the SPA but `make image` covers SPA too).

- [ ] **Step 1: Image rebuild + redeploy**

```bash
make image
```

Wait for rollout. Verify with `curl -fsS http://localhost:9090/health`.

- [ ] **Step 2: Drive the scenario in Playwright MCP**

Same script as the prior smoke walkthrough. The PASS table:

| Stage | DOM | Network |
|---|---|---|
| Attach | Single `AttachmentComposerChip` with `Progress` bar (Task 1) | `POST /api/attachments` → 200 |
| Send | `LiveAttachmentChip` (name-only) visible above user-message body | `POST /api/chat/messages` → 202 |
| Assistant turn | `ArtifactChip` (inline) renders when `artifact_publish` is in `allowed_tools` (Task 4) | (no new network) |
| Download (attachment) | New tab opens after reload (history-load chip is downloadable) | `GET /api/files?path=…` → 200, bytes match |
| Download (artifact) | New tab opens for `ax://artifact/...` link | `GET /api/files?path=…` → 200, bytes match |
| `conversations:get` | Reload restores turns (Task 5 closed the 0-turns gap) | `GET /api/chat/conversations/:id` → `turns.length > 0` |
| Console | No red entries throughout | — |

- [ ] **Step 3: Document any new follow-ups**

If the smoke surfaces yet more bugs, file them as a new follow-up plan (`docs/plans/2026-05-19-attachments-phase-3-followups-v2-impl.md`) — do NOT extend this plan. The lesson from PR #98 is that smoke-driven fixes are best landed as their own surgical PR.

- [ ] **Step 4: Update memory**

```bash
# Append a single-line entry in MEMORY.md:
# - [Phase 3 follow-ups shipped](project_attachments_phase_3_followups.md) — YYYY-MM-DD; F1-F4 + E1-E2 closed; PR #<N>
```

- [ ] **Step 5: Open the PR**

```bash
git push -u origin feat/attachments-phase-3-followups
gh pr create --title "feat: Phase 3 attachments follow-ups (F1-F4 + E1-E2)" --body "$(cat <<'EOF'
## Summary

Closes the six follow-ups surfaced by Phase 3 (PRs #97, #98):

- F1: live-frame attachment chip via `MessagePrimitive.Attachments` slot
- F2: artifact_publish e2e canary (sub-test in `acceptance.test.ts`)
- F3: `AttachmentComposerChip` now consumes the shadcn `Progress` primitive
- F4: direct test for the route's `'max file size'` → 413 mapping branch
- E1: `artifact_publish` is in default agent `allowed_tools` + visible in the admin UI tool picker
- E2: `conversations:get` returns turns again — root cause: <fill in from Task 5>

## Tests

- `@ax/channel-web`: <count> pass (+<delta> new)
- `@ax/preset-k8s`: <count> pass (+1 new canary sub-test)
- `@ax/conversations`: <count> pass (+<delta> if regression test added in Task 5)

## Test plan

- [x] `pnpm build`, `pnpm test`, `pnpm lint` clean
- [x] Manual smoke against `ax-next-dev` — full Section A re-walk (Task 7)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review

**Spec coverage:**
- F1 → Task 3 ✅
- F2 → Task 6 ✅
- F3 → Task 1 ✅
- F4 → Task 2 ✅
- E1 → Task 4 ✅
- E2 → Task 5 ✅
- Manual smoke acceptance gate → Task 7 ✅

**Type consistency:** `AttachmentChip` gains a discriminated `variant: 'downloadable' | 'pending'` in Task 3; Task 6 doesn't add new chip variants. The `MessagePrimitive.Attachments` slot uses `components.Attachment` (catch-all) in Task 3; Task 6 doesn't depend on the slot.

**Placeholder scan:** Task 5's investigation has three diagnostic outcomes baked into Step 5; the inline fix is conditional but the contract is explicit (case 2 or 3 = inline commit, case 1 = file separate plan).

**Sequencing risks:**
- Task 6 depends on Task 5 fixing or ruling out the 0-turns issue. If Task 5 concludes "case 1: runner doesn't write", Task 6 still works because it seeds jsonl directly — but the manual smoke in Task 7 won't fully pass until the runner write path is repaired.
- Task 4's UI verification is scoped to "list `artifact_publish` in the tools picker". If the admin UI fetches tool descriptors dynamically (via a hook), no change is needed — Step 3 documents this with a comment in the task.

**YAGNI check:** Task 3's `pending` variant adds one new render branch to `AttachmentChip`. No premature abstraction (e.g., separate `LiveAttachmentChip.tsx` component) — the chip stays one file.
