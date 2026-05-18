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
import { render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
} from '@assistant-ui/react';
import type { ThreadMessageLike } from '@assistant-ui/react';
import { MarkdownText } from '../components/MarkdownText';
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
