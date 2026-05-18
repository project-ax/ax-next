// @vitest-environment jsdom
/**
 * AttachmentComposerChip — Task 10 unit tests.
 *
 * The chip pulls from `useAttachment()` when rendered inside a
 * ComposerPrimitive.Attachments context. Rendering it standalone in a
 * test harness leaves the attachment-runtime context unmounted, so we
 * use the chip's `_testAttachment` escape-hatch prop to inject a frozen
 * attachment-state shape for unit testing. Production callers never
 * pass `_testAttachment`.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AssistantRuntimeProvider, useLocalRuntime } from '@assistant-ui/react';
import type { ReactNode } from 'react';
import { AttachmentComposerChip } from '../components/AttachmentComposerChip';
import { AxAttachmentAdapter } from '../lib/ax-attachment-adapter';

function Wrapper({ children }: { children: ReactNode }) {
  const runtime = useLocalRuntime(
    {
      async run() {
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    },
    { adapters: { attachments: new AxAttachmentAdapter() } },
  );
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}

function TestHarness(props: { name: string; mediaType: string }) {
  return (
    <AttachmentComposerChip
      _testAttachment={{
        id: 'test-id',
        name: props.name,
        contentType: props.mediaType,
        type: props.mediaType.startsWith('image/') ? 'image' : 'document',
        status: { type: 'complete' },
      }}
    />
  );
}

describe('AttachmentComposerChip', () => {
  it('renders the display name', () => {
    render(
      <Wrapper>
        <TestHarness name="Q4 Report.pdf" mediaType="application/pdf" />
      </Wrapper>,
    );
    expect(screen.getByText('Q4 Report.pdf')).toBeTruthy();
  });

  it('renders an image thumbnail variant for image/* attachments', () => {
    const { container } = render(
      <Wrapper>
        <TestHarness name="cat.png" mediaType="image/png" />
      </Wrapper>,
    );
    // assistant-ui's unstable_Thumb may not actually load the <img> in
    // jsdom; the data-variant attribute is the deterministic signal.
    expect(container.querySelector('[data-variant="image"]')).toBeTruthy();
  });

  it('shows the remove button', () => {
    render(
      <Wrapper>
        <TestHarness name="x.pdf" mediaType="application/pdf" />
      </Wrapper>,
    );
    expect(screen.getByLabelText('Remove attachment')).toBeTruthy();
  });
});
