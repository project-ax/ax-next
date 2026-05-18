// @vitest-environment jsdom
/**
 * composer-attachments — Task 9 smoke test.
 *
 * Verifies that mounting `<Composer />` under an AssistantRuntime whose
 * adapters slot includes an `AxAttachmentAdapter` instance causes the
 * composer's Attach button to render. The button is gated on
 * adapter-presence by assistant-ui (`ComposerPrimitive.AddAttachment`
 * only mounts the button if the runtime advertises an attachments
 * adapter).
 *
 * The production runtime is `useAISDKRuntime` — but the
 * adapter-presence gate is identical across local/AI-SDK runtimes
 * (both forward `adapters.attachments` to the same composer state),
 * so `useLocalRuntime` is sufficient for this smoke check.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
} from '@assistant-ui/react';
import type { ReactNode } from 'react';
import { Composer } from '../components/Composer';
import { AxAttachmentAdapter } from '../lib/ax-attachment-adapter';

function ProviderWithAttachments({ children }: { children: ReactNode }) {
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

describe('Composer with attachments adapter', () => {
  it('renders the Attach button (gated on adapter presence)', () => {
    render(
      <ProviderWithAttachments>
        <Composer />
      </ProviderWithAttachments>,
    );
    expect(screen.getByLabelText('Attach')).toBeTruthy();
  });
});
