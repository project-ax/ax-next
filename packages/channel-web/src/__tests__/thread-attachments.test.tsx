/**
 * Thread renders `AttachmentChip` for file parts whose `data` starts with
 * `ax://attachment-path/<base64url(path)>` (Task 14, Phase 3).
 *
 * The history adapter (Task 6) translates stored `attachment` content blocks
 * into assistant-ui `file` parts carrying the `ax://attachment-path/...`
 * URL. Thread.tsx's `UserFilePart` slot decodes the URL and renders the
 * chip so the user can download the file from the transcript.
 *
 * Seeded via `useExternalStoreRuntime` which renders the supplied
 * `messages` array directly — simpler than `useLocalRuntime` here because
 * we don't need the thread-list-runtime indirection for a single render
 * check. For the chip to build a URL it needs a non-null conversation id,
 * so we publish one via `setActiveConversationId` before mount.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
} from '@assistant-ui/react';
import type { ThreadMessageLike } from '@assistant-ui/react';
import { useEffect, type ReactNode } from 'react';
import { Thread } from '../components/Thread';
import { setActiveConversationId } from '../lib/use-conversation-id';

function ProviderWithSeededMessages({ children }: { children: ReactNode }) {
  // Publish a non-null conversation id so AttachmentChip can build the
  // `GET /api/files?...&conversationId=...` URL. Clear it on unmount so
  // the module-level store doesn't bleed into any test that mounts a
  // chip after this one.
  setActiveConversationId('c1');
  useEffect(() => () => setActiveConversationId(null), []);
  const seeded: ThreadMessageLike[] = [
    {
      id: 'm-user-1',
      role: 'user',
      content: [
        { type: 'text', text: 'see attached' },
        {
          type: 'file',
          data: 'ax://attachment-path/' + btoa('.ax/uploads/c1/t1/foo.pdf'),
          mimeType: 'application/pdf',
          filename: 'foo.pdf',
        },
      ],
    },
  ];
  const runtime = useExternalStoreRuntime({
    messages: seeded,
    convertMessage: (m) => m,
    async onNew() {
      // No-op: this test never calls send.
    },
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}

describe('Thread renders AttachmentChip for ax://attachment-path file parts', () => {
  it('renders the chip with the display name', () => {
    render(
      <ProviderWithSeededMessages>
        <Thread />
      </ProviderWithSeededMessages>,
    );
    expect(screen.getByText('foo.pdf')).toBeTruthy();
  });
});

// TASK-81 regression — the runner emits the MCP-namespaced tool name
// `mcp__ax-sandbox-tools__artifact_publish` (the SDK renames MCP tools at the
// canUseTool boundary). Thread's `tools.by_name` registration is an exact-match
// dict on the raw `part.toolName`, and it was keyed only on the bare
// `artifact_publish` — so a published-artifact tool-call rendered the raw
// ToolFallback panel instead of the downloadable `ArtifactChip`. The chip's
// renderer must resolve for the MCP-namespaced name too.
describe('Thread renders the artifact download chip for the MCP-namespaced tool name', () => {
  const ARTIFACT = {
    artifactId: 'a3f2',
    downloadUrl: 'ax://artifact/a3f2',
    path: 'workspace/x.pdf',
    displayName: 'x.pdf',
    mediaType: 'application/pdf',
    sizeBytes: 1234,
    sha256: 'a3f2deadbeef',
  };

  it('routes mcp__ax-sandbox-tools__artifact_publish through ArtifactPublishTool', () => {
    function Provider({ children }: { children: ReactNode }) {
      setActiveConversationId('c1');
      useEffect(() => () => setActiveConversationId(null), []);
      const seeded: ThreadMessageLike[] = [
        {
          id: 'm-assistant-artifact',
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 't1',
              toolName: 'mcp__ax-sandbox-tools__artifact_publish',
              args: { path: ARTIFACT.path },
              result: JSON.stringify(ARTIFACT),
            },
          ],
        },
      ];
      const runtime = useExternalStoreRuntime({
        messages: seeded,
        convertMessage: (m) => m,
        async onNew() {},
      });
      return (
        <AssistantRuntimeProvider runtime={runtime}>
          {children}
        </AssistantRuntimeProvider>
      );
    }
    render(
      <Provider>
        <Thread />
      </Provider>,
    );
    // The downloadable ArtifactChip (data-testid="artifact-chip") renders — NOT
    // the raw ToolFallback panel that would show the bare tool name as a label.
    expect(screen.getByTestId('artifact-chip')).toBeTruthy();
    expect(screen.getByText('x.pdf')).toBeTruthy();
  });
});

describe('Thread live-frame attachment rendering', () => {
  it('renders LiveAttachmentChip via MessagePrimitive.Attachments for a just-sent message', () => {
    const seeded: ThreadMessageLike[] = [
      {
        id: 'm-user-live',
        role: 'user',
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
    ];
    function Provider({ children }: { children: ReactNode }) {
      const runtime = useExternalStoreRuntime({
        messages: seeded,
        convertMessage: (m) => m,
        async onNew() {},
      });
      return (
        <AssistantRuntimeProvider runtime={runtime}>
          {children}
        </AssistantRuntimeProvider>
      );
    }
    render(
      <Provider>
        <Thread />
      </Provider>,
    );
    // The pending-variant chip renders the filename.
    expect(screen.getByText('live.pdf')).toBeTruthy();
    // No download button in the pending variant.
    expect(screen.queryByLabelText(/Download/)).toBeNull();
  });
});
