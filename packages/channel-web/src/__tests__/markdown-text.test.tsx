/**
 * MarkdownText renders `ax://artifact/<id>` links as `<ArtifactChip
 * variant="link" />` so a published artifact prose-link in an assistant
 * answer becomes a downloadable affordance instead of getting stripped
 * by react-markdown's default urlTransform.
 *
 * Seeded via `useExternalStoreRuntime` which renders the supplied
 * messages directly (simpler than `useLocalRuntime` for a one-shot
 * render check, matching the pattern used by `thread-attachments.test.tsx`).
 * The chip needs a non-null conversation id to build the
 * `GET /api/files?...&conversationId=...` URL, so we publish one via
 * `setActiveConversationId` before mount.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
} from '@assistant-ui/react';
import type { ThreadMessageLike } from '@assistant-ui/react';
import { useAISDKRuntime } from '@assistant-ui/react-ai-sdk';
import { useChat } from '@ai-sdk/react';
import { MarkdownText } from '../components/MarkdownText';
import { createAxHistoryAdapter } from '../lib/history-adapter';
import { setActiveConversationId } from '../lib/use-conversation-id';

interface SeededArtifactResult {
  artifactId: string;
  downloadUrl: string;
  path: string;
  displayName: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
}

function Harness({
  markdown,
  toolResult,
}: {
  markdown: string;
  toolResult?: SeededArtifactResult;
}) {
  setActiveConversationId('c1');
  // Reset the module-level conversation id on unmount so it doesn't bleed
  // into any sibling test that mounts a chip-rendering component after.
  useEffect(() => () => setActiveConversationId(null), []);
  const content: ThreadMessageLike['content'] = toolResult
    ? [
        {
          type: 'tool-call',
          toolCallId: 't1',
          toolName: 'artifact_publish',
          args: { path: toolResult.path },
          result: JSON.stringify(toolResult),
        },
        { type: 'text', text: markdown },
      ]
    : [{ type: 'text', text: markdown }];
  const seeded: ThreadMessageLike[] = [
    {
      id: 'a1',
      role: 'assistant',
      content,
    },
  ];
  const runtime = useExternalStoreRuntime({
    messages: seeded,
    convertMessage: (m) => m,
    async onNew() {
      // No-op: tests never send.
    },
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root>
        <ThreadPrimitive.Messages
          components={{
            UserMessage: () => null,
            AssistantMessage: () => (
              <MessagePrimitive.Root>
                <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
              </MessagePrimitive.Root>
            ),
          }}
        />
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

describe('MarkdownText ax:// URL handling', () => {
  it('renders ax://artifact/<id> as a link chip when the artifact is known', () => {
    render(
      <Harness
        markdown="see [download](ax://artifact/a3f2)"
        toolResult={{
          artifactId: 'a3f2',
          downloadUrl: 'ax://artifact/a3f2',
          path: 'workspace/x.pdf',
          displayName: 'x.pdf',
          mediaType: 'application/pdf',
          sizeBytes: 1234,
          sha256: 'a3f2deadbeef',
        }}
      />,
    );
    // The link variant of ArtifactChip renders an <a> with the displayName.
    const a = screen.getByRole('link', { name: 'x.pdf' });
    expect(a).toBeTruthy();
    expect(a.getAttribute('href')).toMatch(/\/api\/files\?/);
  });

  it('renders "unknown artifact" for unmatched ids', () => {
    render(<Harness markdown="[broken](ax://artifact/nope)" />);
    expect(screen.getByText(/unknown artifact/i)).toBeTruthy();
  });

  it('leaves regular http://… links untouched', () => {
    render(<Harness markdown="[ok](https://example.com)" />);
    const a = screen.getByRole('link', { name: 'ok' });
    // react-markdown emits the URL as-authored (no trailing slash added).
    expect(a.getAttribute('href')).toBe('https://example.com');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  });
});

// ---------------------------------------------------------------------------
// TASK-20 regression — the published artifact's `ax://artifact/<id>` link and
// its `artifact_publish` tool-call result land in SEPARATE assistant messages
// (the runner emits the tool result, then the closing text as a fresh turn;
// reload's history adapter builds one renderable message per turn). The
// resolver must scan the WHOLE thread, not just the link's own message —
// otherwise the chip renders as a dead "unknown artifact" pill (the bug).
// ---------------------------------------------------------------------------

const ARTIFACT = {
  artifactId: '21bea75',
  downloadUrl: 'ax://artifact/21bea75',
  path: 'workspace/poem.txt',
  displayName: 'Ocean Poem',
  mediaType: 'text/plain',
  sizeBytes: 171,
  sha256: 'deadbeef',
};

function ThreadRenderer() {
  return (
    <ThreadPrimitive.Root>
      <ThreadPrimitive.Messages
        components={{
          UserMessage: () => null,
          AssistantMessage: () => (
            <MessagePrimitive.Root>
              <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
            </MessagePrimitive.Root>
          ),
        }}
      />
    </ThreadPrimitive.Root>
  );
}

describe('MarkdownText ax://artifact resolution across messages (TASK-20)', () => {
  it('resolves the chip when the tool-call and the link are in DIFFERENT live-turn messages', async () => {
    // Live-turn shape: the artifact tool-call lands in one assistant
    // UIMessage; an intervening user turn + the closing-text link land in a
    // later assistant UIMessage. Driven through the real AI SDK runtime so
    // the messages stay distinct (they don't coalesce the way consecutive
    // streaming deltas in a single message do).
    const uiMessages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'make a poem' }] },
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          {
            type: 'dynamic-tool',
            toolName: 'artifact_publish',
            toolCallId: 't1',
            state: 'output-available',
            input: { path: ARTIFACT.path },
            output: JSON.stringify(ARTIFACT),
          },
        ],
      },
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'thanks' }] },
      {
        id: 'a2',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Done: [Download Ocean Poem](ax://artifact/21bea75)' },
        ],
      },
    ];

    function LiveHarness() {
      setActiveConversationId('c1');
      const chat = useChat();
      useEffect(() => {
        chat.setMessages(uiMessages as never);
        return () => setActiveConversationId(null);
      }, []);
      const runtime = useAISDKRuntime(chat);
      return (
        <AssistantRuntimeProvider runtime={runtime}>
          <ThreadRenderer />
        </AssistantRuntimeProvider>
      );
    }

    render(<LiveHarness />);
    // The named, downloadable chip — NOT the "unknown artifact" pill.
    const a = await screen.findByRole('link', { name: 'Ocean Poem' });
    expect(a.getAttribute('href')).toMatch(/\/api\/files\?/);
    expect(screen.queryByText(/unknown artifact/i)).toBeNull();
  });

  it('resolves the chip on reload — the history adapter splits the tool turn from the closing-text turn', async () => {
    // Reload shape: conversations:get → `createAxHistoryAdapter` →
    // `blocksToParts` → one renderable message per turn. The artifact_publish
    // tool turn becomes a `dynamic-tool` part in one assistant message; the
    // closing-text link lands in a SEPARATE assistant message. We drive the
    // adapter for real (stubbed fetch), then seed its converted output as the
    // chat's messages — exactly what `useAISDKRuntime` imports on reload —
    // and assert the chip resolves.
    setActiveConversationId('c1');
    const turns = [
      {
        turnId: 't0',
        turnIndex: 0,
        role: 'user',
        contentBlocks: [{ type: 'text', text: 'make a poem' }],
        createdAt: new Date().toISOString(),
      },
      {
        turnId: 't1',
        turnIndex: 1,
        role: 'assistant',
        contentBlocks: [
          { type: 'tool_use', id: 'tu_1', name: 'artifact_publish', input: { path: ARTIFACT.path } },
        ],
        createdAt: new Date().toISOString(),
      },
      {
        turnId: 't2',
        turnIndex: 2,
        role: 'tool',
        contentBlocks: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: JSON.stringify(ARTIFACT) },
        ],
        createdAt: new Date().toISOString(),
      },
      {
        turnId: 't3',
        turnIndex: 3,
        role: 'assistant',
        contentBlocks: [
          { type: 'text', text: 'Done: [Download Ocean Poem](ax://artifact/21bea75)' },
        ],
        createdAt: new Date().toISOString(),
      },
    ];

    // Run the real adapter through a stubbed fetch to get the per-turn,
    // split-message parts (the reload-path output we then feed the chat).
    const origFetch = global.fetch;
    global.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          conversation: { conversationId: 'c1', title: null },
          turns,
        }),
      }) as unknown as Response) as typeof fetch;
    let reloadMessages: unknown[];
    try {
      const adapter = createAxHistoryAdapter(() => 'c1');
      // `withFormat` is optional on the ThreadHistoryAdapter interface but our
      // adapter always provides it; the no-op `decode` returns its argument so
      // each loaded message keeps its `{ content: { role, parts } }` shape.
      const withFmt = adapter.withFormat!({
        format: 'ax',
        decode: (x: unknown) => x,
      } as never);
      const loaded = (await withFmt.load()) as unknown as {
        messages: Array<{ content: { role: string; parts: unknown[] } }>;
      };
      // Map the adapter's per-turn output to AI SDK UIMessages — the same
      // `dynamic-tool` / text parts, kept as DISTINCT messages.
      reloadMessages = loaded.messages.map((m, i) => ({
        id: `m${i}`,
        role: m.content.role,
        parts: m.content.parts,
      }));
    } finally {
      global.fetch = origFetch;
    }

    // Sanity: the adapter really did split tool from closing text across
    // separate messages (otherwise this test wouldn't exercise the bug).
    expect(reloadMessages.length).toBeGreaterThanOrEqual(2);

    function ReloadHarness() {
      const chat = useChat();
      useEffect(() => {
        chat.setMessages(reloadMessages as never);
        return () => setActiveConversationId(null);
      }, []);
      const runtime = useAISDKRuntime(chat);
      return (
        <AssistantRuntimeProvider runtime={runtime}>
          <ThreadRenderer />
        </AssistantRuntimeProvider>
      );
    }

    render(<ReloadHarness />);
    const a = await screen.findByRole('link', { name: 'Ocean Poem' });
    expect(a.getAttribute('href')).toMatch(/\/api\/files\?/);
    expect(screen.queryByText(/unknown artifact/i)).toBeNull();
  });

  // TASK-77 regression — the runner persists an artifact_publish tool_result as
  // the SDK/MCP ARRAY shape `[{type:'text', text:<json>}]`. If that array reaches
  // the thread part's `result`/`output` un-flattened (e.g. a future transport
  // tweak, or a tool_result that wasn't string-flattened), `parseArtifactsFromThread`
  // must still recover the artifact JSON — otherwise a perfectly valid published
  // artifact renders as a dead "unknown artifact" pill.
  it('resolves the chip when the tool-call result is the ARRAY content shape', async () => {
    const uiMessages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'make a poem' }] },
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          {
            type: 'dynamic-tool',
            toolName: 'artifact_publish',
            toolCallId: 't1',
            state: 'output-available',
            input: { path: ARTIFACT.path },
            // The shape the SDK echoes for an MCP tool result.
            output: [{ type: 'text', text: JSON.stringify(ARTIFACT) }],
          },
        ],
      },
      {
        id: 'a2',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Done: [Download Ocean Poem](ax://artifact/21bea75)' },
        ],
      },
    ];

    function ArrayHarness() {
      setActiveConversationId('c1');
      const chat = useChat();
      useEffect(() => {
        chat.setMessages(uiMessages as never);
        return () => setActiveConversationId(null);
      }, []);
      const runtime = useAISDKRuntime(chat);
      return (
        <AssistantRuntimeProvider runtime={runtime}>
          <ThreadRenderer />
        </AssistantRuntimeProvider>
      );
    }

    render(<ArrayHarness />);
    const a = await screen.findByRole('link', { name: 'Ocean Poem' });
    expect(a.getAttribute('href')).toMatch(/\/api\/files\?/);
    expect(screen.queryByText(/unknown artifact/i)).toBeNull();
  });

  // TASK-81 regression — the runner emits the MCP-namespaced tool name
  // `mcp__ax-sandbox-tools__artifact_publish` (the SDK renames MCP tools at the
  // canUseTool boundary, and that name is what's persisted + reaches the part).
  // `parseArtifactsFromThread` keyed on the bare `artifact_publish`, so the link
  // never paired with its result and rendered a dead "unknown artifact" pill —
  // the published artifact wasn't downloadable from the transcript.
  it('resolves the chip when the tool-call carries the MCP-namespaced tool name', async () => {
    const uiMessages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'make a poem' }] },
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          {
            type: 'dynamic-tool',
            toolName: 'mcp__ax-sandbox-tools__artifact_publish',
            toolCallId: 't1',
            state: 'output-available',
            input: { path: ARTIFACT.path },
            output: JSON.stringify(ARTIFACT),
          },
        ],
      },
      {
        id: 'a2',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Done: [Download Ocean Poem](ax://artifact/21bea75)' },
        ],
      },
    ];

    function McpNameHarness() {
      setActiveConversationId('c1');
      const chat = useChat();
      useEffect(() => {
        chat.setMessages(uiMessages as never);
        return () => setActiveConversationId(null);
      }, []);
      const runtime = useAISDKRuntime(chat);
      return (
        <AssistantRuntimeProvider runtime={runtime}>
          <ThreadRenderer />
        </AssistantRuntimeProvider>
      );
    }

    render(<McpNameHarness />);
    const a = await screen.findByRole('link', { name: 'Ocean Poem' });
    expect(a.getAttribute('href')).toMatch(/\/api\/files\?/);
    expect(screen.queryByText(/unknown artifact/i)).toBeNull();
  });

  it('still renders "unknown artifact" when NO message in the thread published that id', async () => {
    const uiMessages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      {
        id: 'a1',
        role: 'assistant',
        parts: [{ type: 'text', text: '[broken](ax://artifact/does-not-exist)' }],
      },
    ];

    function Harness2() {
      setActiveConversationId('c1');
      const chat = useChat();
      useEffect(() => {
        chat.setMessages(uiMessages as never);
        return () => setActiveConversationId(null);
      }, []);
      const runtime = useAISDKRuntime(chat);
      return (
        <AssistantRuntimeProvider runtime={runtime}>
          <ThreadRenderer />
        </AssistantRuntimeProvider>
      );
    }

    render(<Harness2 />);
    await waitFor(() =>
      expect(screen.getByText(/unknown artifact/i)).toBeTruthy(),
    );
    expect(screen.queryByRole('link', { name: 'Ocean Poem' })).toBeNull();
  });
});
