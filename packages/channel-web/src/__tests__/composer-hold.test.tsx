/**
 * Composer hold while an approval decision is open (TASK-275).
 *
 * The bug: when a tool call was held for approval, the `/` composer stayed
 * live — a send during the hold raced the parked turn or vanished silently.
 * The ruling: the composer is DISABLED with reason copy while anything is
 * waiting, no focus move, no queueing.
 *
 * These tests drive the REAL `Composer` (with its nested `InThreadApprovals`)
 * under a stub runtime, with `useConversationDecisions` swapped for a mutable
 * holder — the same shape as `permission-card.test.tsx`. That keeps one
 * predicate under test: `held = open.length > 0`.
 *
 * What "disabled" means here is load-bearing, so each test pins the
 * mechanism, not the styling:
 *
 *   - Send/Input/Attach carry the real `disabled` attribute (assistant-ui's
 *     `ComposerPrimitive.Input` also suppresses Enter-to-submit and autofocus
 *     off that same flag; `createActionButton` disables Send/AddAttachment).
 *   - The form `onSubmit` guard `preventDefault`s, which stops assistant-ui's
 *     own submit handler composed behind it — the backstop for programmatic
 *     submits a disabled button cannot stop.
 *   - The reason copy is real text in a `<p>`, not a placeholder or a dimming
 *     class.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
} from '@assistant-ui/react';
import type { ReactNode } from 'react';
import { Composer, COMPOSER_HOLD_COPY } from '../components/Composer';
import type { ConversationDecisions } from '../lib/conversation-decisions';
import type { Decision } from '../lib/workspace-api';
import { decisionFixture } from '../components/workspace/__tests__/decision-fixture';

// Mutable holder for the mocked hook. The `mock` prefix is what lets a
// `vi.mock` factory reference a top-level variable (same shape as the
// `mockConversationId` holder in `in-thread-approvals.test.tsx`).
let mockOpen: Decision[] = [];
vi.mock('../lib/conversation-decisions', () => ({
  useConversationDecisions: (): ConversationDecisions => ({
    open: mockOpen,
    settled: [],
    conversationId: 'c1',
    error: null,
    retrying: false,
    raised: 0,
    busyIds: new Set<string>(),
    notices: new Map<string, string>(),
    approve: () => undefined,
    dismiss: () => undefined,
    undo: () => undefined,
    clearNotice: () => undefined,
    refresh: async () => undefined,
  }),
}));

const runFn = vi.fn(async () => ({
  content: [{ type: 'text' as const, text: 'ok' }],
}));

function HoldRuntimeProvider({ children }: { children: ReactNode }) {
  const runtime = useLocalRuntime({ async run() {
    return runFn();
  } });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}

function renderComposer() {
  return render(
    <HoldRuntimeProvider>
      <Composer />
    </HoldRuntimeProvider>,
  );
}

function fieldNodes(container: HTMLElement) {
  const input = container.querySelector(
    '.composer-input',
  ) as HTMLTextAreaElement;
  const form = container.querySelector('.composer-inner') as HTMLFormElement;
  expect(input).not.toBeNull();
  expect(form).not.toBeNull();
  return { input, form };
}

/**
 * The spec sentence, written out in full. The component exports the same
 * string as `COMPOSER_HOLD_COPY` and the drift guard below pins them
 * together — but the find-by-text assertions use THIS literal, so on code
 * without the hold they fail with "unable to find the element" (a genuine
 * absence) rather than with an undefined-matcher artifact of the import.
 */
const HOLD_COPY =
  "We're waiting on your approval above — send is paused until you choose.";

describe('Composer hold while an approval is open', () => {
  beforeEach(() => {
    mockOpen = [];
    runFn.mockClear();
  });

  it('exports the spec hold sentence', () => {
    expect(COMPOSER_HOLD_COPY).toBe(HOLD_COPY);
  });

  it('disables the input, the send button, and attach while held', () => {
    // Text present, so Send would be live without the hold — every disabled
    // below is the hold's doing, not assistant-ui's empty-text disable.
    mockOpen = [];
    const { container, unmount } = renderComposer();
    const { input } = fieldNodes(container);
    fireEvent.change(input, { target: { value: 'draft' } });
    expect(screen.getByLabelText('Send')).toBeEnabled();
    unmount();

    // Same holder, now with an open decision: the hold flips on.
    mockOpen = [decisionFixture()];
    renderComposer();

    // Real `disabled` attributes — what blocks the click/type paths — not
    // opacity classes.
    expect(screen.getByLabelText('Send')).toBeDisabled();
    expect(screen.getByPlaceholderText('Message ax…')).toBeDisabled();
    expect(screen.getByLabelText('Attach')).toBeDisabled();
  });

  it('blocks form submit while held: nothing sends and the draft is kept', async () => {
    mockOpen = [decisionFixture()];
    const { container } = renderComposer();
    const { input, form } = fieldNodes(container);

    fireEvent.change(input, { target: { value: 'half-typed draft' } });
    expect(input.value).toBe('half-typed draft');

    fireEvent.submit(form);

    // The send path is async (submit → runtime start → `run`), so a bare
    // synchronous assertion would pass vacuously here AND on code without the
    // guard. Settle first: on unmodified code `runFn` fires inside this
    // window (the control test below proves it), which is what fails there.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // No send path ran — not the runtime, and not the dev-trigger branch
    // (which would have cleared the input).
    expect(runFn).not.toHaveBeenCalled();
    // The draft is intact: a held submit neither sends nor silently drops text.
    expect(input.value).toBe('half-typed draft');
  });

  it('shows the hold reason as real text while held, and hides it otherwise', () => {
    mockOpen = [decisionFixture()];
    const held = renderComposer();

    const copy = screen.getByText(HOLD_COPY);
    // A paragraph in the DOM — not placeholder text on the (disabled) input,
    // and not an opacity-only treatment with nothing to read.
    expect(copy.tagName).toBe('P');
    expect(copy.closest('[data-composer-hold]')).not.toBeNull();
    expect(screen.getByPlaceholderText('Message ax…')).toHaveAttribute(
      'placeholder',
      'Message ax…',
    );
    held.unmount();

    mockOpen = [];
    const back = renderComposer();
    expect(screen.queryByText(HOLD_COPY)).toBeNull();
    // Controls are back. (Send stays disabled on empty text by assistant-ui
    // itself — `canSend` false — so it re-enables only once there is text.)
    expect(screen.getByPlaceholderText('Message ax…')).toBeEnabled();
    expect(screen.getByLabelText('Attach')).toBeEnabled();
    const { input: backInput } = fieldNodes(back.container);
    fireEvent.change(backInput, { target: { value: 'typing again' } });
    expect(screen.getByLabelText('Send')).toBeEnabled();
  });

  it('moves no focus when the approval arrives', () => {
    mockOpen = [];
    const { container, rerender } = render(
      <HoldRuntimeProvider>
        <Composer />
      </HoldRuntimeProvider>,
    );
    const { input } = fieldNodes(container);
    input.focus();
    expect(document.activeElement).toBe(input);

    // The hold arrives on the next render. Nothing may steal the caret out
    // of the half-typed message — the ruling keeps the announcement polite
    // and leaves focus exactly where the reader put it.
    mockOpen = [decisionFixture()];
    rerender(
      <HoldRuntimeProvider>
        <Composer />
      </HoldRuntimeProvider>,
    );
    expect(document.activeElement).toBe(input);
  });

  it('sends normally when nothing is waiting (control for the harness)', async () => {
    mockOpen = [];
    const { container } = renderComposer();
    const { input, form } = fieldNodes(container);

    fireEvent.change(input, { target: { value: 'hello agent' } });
    fireEvent.submit(form);

    // Proves the blocked-submit test above is not vacuous: the same submit
    // reaches the runtime when no approval is open.
    await waitFor(() => expect(runFn).toHaveBeenCalledTimes(1));
  });
});
