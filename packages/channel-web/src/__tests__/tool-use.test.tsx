/**
 * ToolUse — the per-tool-call detail panels the transcript renders.
 *
 * Behaviors under test:
 *
 *   1. ToolFallback renders the tool name, args JSON, and result JSON for
 *      a completed tool call, and shows NO status word (TASK-260).
 *
 *   2. ToolFallback shows the error block (not result) when the call
 *      reports `isError: true`.
 *
 *   3. ToolFallback shows status "Running" with no result block while a
 *      tool call is in flight.
 *
 *   3b. TASK-260 regression: a tool result with `isError` absent renders no
 *       destructive class and no `error` label. A HOLD arrives on exactly that
 *       shape — the runner publishes the held call's result with `is_error`
 *       omitted — so this is the assertion that stops a hold rendering as a
 *       failure. Paired with the reload-path assertion in
 *       `history-adapter.test.ts`.
 *
 *   4. ToolFallback renders a string result in the prose face and an object
 *      result in mono.
 *
 *   5. ArtifactPublishTool renders the inline download chip for both the
 *      array and the legacy string result shapes.
 *
 * Nothing here mocks `@assistant-ui/react`. It used to — solely to feed
 * `useMessage` for the deleted `ToolGroup` (TASK-269). Both components below
 * are pure props-in renderers, so a whole-module mock would only be able to
 * hide a future regression.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ToolCallMessagePartProps } from '@assistant-ui/react';

import { ToolFallback, ArtifactPublishTool } from '../components/ToolUse';
import { setActiveConversationId } from '../lib/use-conversation-id';

const makePart = (
  overrides: Partial<ToolCallMessagePartProps> = {},
): ToolCallMessagePartProps =>
  ({
    type: 'tool-call',
    toolCallId: 't1',
    toolName: 'web.search',
    args: { q: 'hello' },
    argsText: '{"q":"hello"}',
    result: '5 results',
    isError: false,
    status: { type: 'complete' },
    addResult: () => {},
    resume: () => {},
    ...overrides,
  }) as unknown as ToolCallMessagePartProps;

describe('ToolFallback', () => {
  it('renders tool name, args, and result for a completed call — and no status word', () => {
    const { container } = render(<ToolFallback {...makePart()} />);
    expect(screen.getByText('web.search')).toBeTruthy();
    expect(screen.getByText('args')).toBeTruthy();
    expect(screen.getByText(/"q": "hello"/)).toBeTruthy();
    expect(screen.getByText('result')).toBeTruthy();
    expect(screen.getByText('5 results')).toBeTruthy();
    // TASK-260: the settled state carries no word. `done` was the one element
    // in this panel making a claim, and it is false for a call that was HELD
    // for a person rather than executed. The result block is the completion
    // signal; a badge is not needed to restate it.
    expect(container.querySelector('.tstep-status')).toBeNull();
    expect(screen.queryByText(/done/i)).toBeNull();
  });

  it('shows error block instead of result when isError is true', () => {
    render(
      <ToolFallback
        {...makePart({
          isError: true,
          result: 'rate-limited',
          status: { type: 'incomplete', reason: 'error' } as unknown as ToolCallMessagePartProps['status'],
        })}
      />,
    );
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText('error')).toBeTruthy();
    expect(screen.getByText('rate-limited')).toBeTruthy();
    expect(screen.queryByText('result')).toBeNull();
  });

  it('shows Running status with no result block while in flight', () => {
    render(
      <ToolFallback
        {...makePart({
          result: undefined,
          status: { type: 'running' } as unknown as ToolCallMessagePartProps['status'],
        })}
      />,
    );
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.queryByText('result')).toBeNull();
    expect(screen.queryByText('error')).toBeNull();
  });

  // TASK-260. A hold reaches this component on exactly this shape: the runner
  // publishes the held call's tool result with `is_error` OMITTED and a
  // host-authored sentence as the body. Before the fix that same call arrived
  // with `is_error: true` and rendered as a red FAILED step with the model's
  // instructions under a heading reading `error` — a tool error, for a call
  // that had not run and had not failed.
  it('a result with isError absent renders no destructive class and no error label (hold, not failure)', () => {
    const { container } = render(
      <ToolFallback
        {...makePart({
          toolName: 'request_capability',
          isError: undefined,
          result:
            'Waiting for you to choose. Nothing has happened yet, and nothing will until you do.',
          status: { type: 'complete' } as unknown as ToolCallMessagePartProps['status'],
        })}
      />,
    );
    expect(screen.queryByText('error')).toBeNull();
    expect(container.querySelector('.tstep-error')).toBeNull();
    expect(container.querySelector('[class*="text-destructive"]')).toBeNull();
    expect(container.querySelector('.tstep-status')).toBeNull();
    expect(screen.getByText('result')).toBeTruthy();
    expect(
      screen.getByText(/Waiting for you to choose\. Nothing has happened yet/),
    ).toBeTruthy();
    // No internal identifier reaches the panel: not the SDK's `mcp__` wire
    // name (stripped upstream in history-adapter/transport) and not a `dec_`
    // decision id (never in the prose — see @ax/decisions templates.ts).
    expect(container.textContent).not.toMatch(/mcp__/);
    expect(container.textContent).not.toMatch(/dec_/);
  });

  // TASK-260 companion: a string result is prose, an object result is data.
  it('renders a string result in the prose face and an object result in mono', () => {
    const { container: prose } = render(
      <ToolFallback {...makePart({ result: 'a plain sentence' })} />,
    );
    expect(prose.querySelector('.tstep-result')?.className).toMatch(/font-sans/);

    const { container: data } = render(
      <ToolFallback {...makePart({ result: { rows: 3 } })} />,
    );
    expect(data.querySelector('.tstep-result')?.className).not.toMatch(/font-sans/);
  });
});

// ---------------------------------------------------------------------------
// TASK-77: the inline artifact chip must render for the ARRAY content shape
// `[{type:'text', text:<json>}]` the runner persists for an artifact_publish
// result — not just the legacy string form. A bare array dropped through the
// old `JSON.stringify(p.result)` path never matched the artifact fields, so
// the chip silently degraded to the raw tool panel.
// ---------------------------------------------------------------------------
describe('ArtifactPublishTool array-content shape', () => {
  const ARTIFACT = {
    artifactId: 'a3f2',
    downloadUrl: 'ax://artifact/a3f2',
    path: 'workspace/x.pdf',
    displayName: 'x.pdf',
    mediaType: 'application/pdf',
    sizeBytes: 1234,
    sha256: 'a3f2deadbeef',
  };

  const makeArtifactPart = (
    result: unknown,
  ): ToolCallMessagePartProps =>
    ({
      type: 'tool-call',
      toolCallId: 't1',
      toolName: 'artifact_publish',
      args: { path: ARTIFACT.path },
      result,
      isError: false,
      status: { type: 'complete' },
      addResult: () => {},
      resume: () => {},
    }) as unknown as ToolCallMessagePartProps;

  it('renders the inline chip when result is the array shape', () => {
    setActiveConversationId('c1');
    try {
      render(
        <ArtifactPublishTool
          {...makeArtifactPart([{ type: 'text', text: JSON.stringify(ARTIFACT) }])}
        />,
      );
      expect(screen.getByTestId('artifact-chip')).toBeTruthy();
      expect(screen.getByText('x.pdf')).toBeTruthy();
    } finally {
      setActiveConversationId(null);
    }
  });

  it('still renders the inline chip for the legacy string shape', () => {
    setActiveConversationId('c1');
    try {
      render(
        <ArtifactPublishTool {...makeArtifactPart(JSON.stringify(ARTIFACT))} />,
      );
      expect(screen.getByTestId('artifact-chip')).toBeTruthy();
    } finally {
      setActiveConversationId(null);
    }
  });
});
