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
import type { ReactNode } from 'react';
import { Thread } from '../components/Thread';
import { setActiveConversationId } from '../lib/use-conversation-id';

function ProviderWithSeededMessages({ children }: { children: ReactNode }) {
  // Publish a non-null conversation id so AttachmentChip can build the
  // `GET /api/files?...&conversationId=...` URL.
  setActiveConversationId('c1');
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
