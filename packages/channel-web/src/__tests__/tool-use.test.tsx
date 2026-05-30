/**
 * ToolUse — summary header + expansion toggle for tool-call message parts.
 *
 * Behaviors under test:
 *
 *   1. ToolFallback renders the tool name, args JSON, and result JSON for
 *      a completed tool call. Status pill shows "done".
 *
 *   2. ToolFallback shows the error block (not result) when the call
 *      reports `isError: true`.
 *
 *   3. ToolFallback shows status "running" with no result block while a
 *      tool call is in flight.
 *
 *   4. ToolGroup renders a comma-joined past-tense summary of the tools
 *      in its slice (first verb sentence-cased), with body collapsed by
 *      default; clicking the header toggles `.open`.
 *
 *   5. ToolGroup picks up `.running` / `.failed` / done class based on
 *      the parts in its slice.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ToolCallMessagePartProps } from '@assistant-ui/react';

declare global {
  // Test-only handoff between `setParts()` and the mocked `useMessage`.
  // eslint-disable-next-line no-var
  var __TEST_PARTS__: unknown[] | undefined;
}

vi.mock('@assistant-ui/react', () => ({
  useMessage: (selector: (m: { content: unknown[] }) => unknown) =>
    selector({ content: globalThis.__TEST_PARTS__ ?? [] }),
}));

import { ToolFallback, ToolGroup, ArtifactPublishTool } from '../components/ToolUse';
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

const setParts = (parts: unknown[]) => {
  globalThis.__TEST_PARTS__ = parts;
};

describe('ToolFallback', () => {
  it('renders tool name, args, and result for a completed call', () => {
    render(<ToolFallback {...makePart()} />);
    expect(screen.getByText('web.search')).toBeTruthy();
    expect(screen.getByText('done')).toBeTruthy();
    expect(screen.getByText('args')).toBeTruthy();
    expect(screen.getByText(/"q": "hello"/)).toBeTruthy();
    expect(screen.getByText('result')).toBeTruthy();
    expect(screen.getByText('5 results')).toBeTruthy();
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
    expect(screen.getByText('failed')).toBeTruthy();
    expect(screen.getByText('error')).toBeTruthy();
    expect(screen.getByText('rate-limited')).toBeTruthy();
    expect(screen.queryByText('result')).toBeNull();
  });

  it('shows running status with no result block while in flight', () => {
    render(
      <ToolFallback
        {...makePart({
          result: undefined,
          status: { type: 'running' } as unknown as ToolCallMessagePartProps['status'],
        })}
      />,
    );
    expect(screen.getByText('running')).toBeTruthy();
    expect(screen.queryByText('result')).toBeNull();
    expect(screen.queryByText('error')).toBeNull();
  });
});

describe('ToolGroup', () => {
  it('renders a comma-joined verb summary and toggles open on click', () => {
    setParts([
      { type: 'tool-call', toolName: 'web.search', isError: false, status: { type: 'complete' } },
      { type: 'tool-call', toolName: 'drive.read', isError: false, status: { type: 'complete' } },
    ]);
    const { container } = render(
      <ToolGroup startIndex={0} endIndex={1}>
        <div data-testid="child" />
      </ToolGroup>,
    );

    const header = screen.getByRole('button');
    expect(header.textContent).toContain('Searched the web, read the file');

    const group = container.querySelector('.tgroup')!;
    expect(group.classList.contains('open')).toBe(false);
    expect(header.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(header);
    expect(group.classList.contains('open')).toBe(true);
    expect(header.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(header);
    expect(group.classList.contains('open')).toBe(false);
  });

  it('marks the group as running while any tool call is running', () => {
    setParts([
      { type: 'tool-call', toolName: 'web.search', isError: false, status: { type: 'complete' } },
      { type: 'tool-call', toolName: 'drive.read', isError: false, status: { type: 'running' } },
    ]);
    const { container } = render(
      <ToolGroup startIndex={0} endIndex={1}>
        <div />
      </ToolGroup>,
    );
    expect(container.querySelector('.tgroup.running')).toBeTruthy();
  });

  it('marks the group as failed when no calls are running but one errored', () => {
    setParts([
      { type: 'tool-call', toolName: 'web.search', isError: true, status: { type: 'incomplete' } },
    ]);
    const { container } = render(
      <ToolGroup startIndex={0} endIndex={0}>
        <div />
      </ToolGroup>,
    );
    expect(container.querySelector('.tgroup.failed')).toBeTruthy();
  });

  it('falls back to "ran <name>" for tools without a verb mapping', () => {
    setParts([
      { type: 'tool-call', toolName: 'github.search_issues', isError: false, status: { type: 'complete' } },
    ]);
    render(
      <ToolGroup startIndex={0} endIndex={0}>
        <div />
      </ToolGroup>,
    );
    expect(screen.getByRole('button').textContent).toContain('Ran search issues');
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
