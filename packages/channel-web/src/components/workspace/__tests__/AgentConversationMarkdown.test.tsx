/**
 * TASK-405 — the agent bubble renders markdown.
 *
 * WHAT THE CARD GOT WRONG, because the next reader should not re-file it. The
 * card blames `white-space: normal` for swallowing newlines. There is no
 * `white-space` declaration in `AgentConversation.tsx` at all; the one in
 * `index.css` belongs to `.msg-body .aui-md`, which is `/chat`, not this
 * surface. Collapsed newlines were a SYMPTOM. The cause was that nothing
 * parsed the message: `m.text` went into the DOM as a string, so `**bold**`,
 * tables, lists and headings were all literal too — which is what the TASK-357
 * re-walk measured and what the first test below pins.
 */
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentConversation } from '../AgentConversation';
import type { ThreadMessage, WorkspaceAgent } from '@/lib/workspace-api';

const quill: WorkspaceAgent = {
  id: 'a-quill',
  name: 'Quill',
  state: 'resting',
  now: null,
  counter: null,
  startedAt: null,
  stoppedReason: null,
};

const agentTurn = (text: string): ThreadMessage => ({
  kind: 'agent',
  id: 'a1',
  text,
  at: '2026-09-17T16:12:00.000Z',
});

function conversation(
  over: Partial<ComponentProps<typeof AgentConversation>> = {},
) {
  return (
    <AgentConversation
      agent={quill}
      thread={[agentTurn('hello')]}
      conversationId="c1"
      decisions={[]}
      readOnly={false}
      onSend={vi.fn()}
      onApprove={vi.fn()}
      onDismiss={vi.fn()}
      onUndo={vi.fn()}
      approvalRead="ok"
      onRetryApprovals={vi.fn()}
      grants={[]}
      onGrantResolved={vi.fn()}
      onGranted={vi.fn(async () => true)}
      {...over}
    />
  );
}

describe('the agent bubble renders markdown', () => {
  it('hides file download links during streaming', () => {
    const { container } = render(conversation({ busy: true, thread: [agentTurn([
      'Your poem is ready. [Download inline](ax://artifact/abc123) Enjoy it.',
      '📄 [Download reference][poem]',
      '[poem]: ax://artifact/abc123',
      '[Download via API](/api/files?conversationId=c1&id=0123456789abcdef)',
      '[Read more](https://example.com/poetry)',
      '`[Download example](ax://artifact/example)`',
    ].join('\n\n'))] }));
    expect(screen.queryByText('Download inline')).not.toBeInTheDocument();
    expect(screen.queryByText('Download reference')).not.toBeInTheDocument();
    expect(screen.queryByText('Download via API')).not.toBeInTheDocument();
    expect(container.textContent).not.toContain('📄');
    expect(container.textContent).toContain('Enjoy it.');
    expect(screen.getByRole('link', { name: 'Read more' })).toHaveAttribute('href', 'https://example.com/poetry');
    expect(container.querySelector('code')?.textContent).toBe('[Download example](ax://artifact/example)');
  });

  it('renders bold, headings and paragraphs instead of printing their syntax', () => {
    const { container } = render(
      conversation({
        thread: [agentTurn('## Deploy report\n\nThe build is **green**.')],
      }),
    );

    // The structural claim: real elements, not a string that looks like one.
    expect(container.querySelector('h2')?.textContent).toBe('Deploy report');
    expect(container.querySelector('strong')?.textContent).toBe('green');

    // And the symptom the card named: two blocks, not one run-on line.
    expect(container.querySelectorAll('p')).toHaveLength(1);

    // The negative half, which is the half that fails against `main`: the
    // syntax must be GONE, not merely accompanied by markup. A renderer that
    // emitted `<strong>` while leaving the asterisks in place would satisfy
    // every assertion above.
    expect(container.textContent).not.toContain('**');
    expect(container.textContent).not.toContain('## ');
  });

  it('renders a GFM table as a table', () => {
    const { container } = render(
      conversation({
        thread: [
          agentTurn('| env | status |\n| --- | --- |\n| prod | green |'),
        ],
      }),
    );

    expect(container.querySelectorAll('table')).toHaveLength(1);
    expect(container.querySelectorAll('tbody td')).toHaveLength(2);
    expect(container.textContent).not.toContain('| --- |');
  });

  it('keeps a list a list, so line structure survives', () => {
    const { container } = render(
      conversation({ thread: [agentTurn('- one\n- two\n- three')] }),
    );

    expect(container.querySelectorAll('li')).toHaveLength(3);
  });

  it('never fetches a model-authored image — the alt text stands in for it', () => {
    /*
      An `<img>` here would be an outbound request the reader's browser makes
      because the MODEL asked it to, carrying whatever the model put in the URL.
      `Markdown.tsx` renders images as alt text for exactly this reason, and
      this is the surface where that policy matters most. Stated as a test so
      that "render images like /chat does" is a decision somebody has to make
      on purpose rather than one a refactor can make by accident.
    */
    const { container } = render(
      conversation({
        thread: [agentTurn('![a chart](https://tracker.test/pixel.png)')],
      }),
    );

    expect(screen.getByRole('region', { name: `Conversation with ${quill.name}` }).querySelectorAll('img')).toHaveLength(0);
    expect(container.textContent).toContain('a chart');
    // …and it got there by being PARSED. Without this line the test passes
    // against the unfixed renderer too, which prints the whole `![a chart](…)`
    // string and therefore also contains 'a chart' and also has no <img>.
    expect(container.textContent).not.toContain('![');
    expect(container.textContent).not.toContain('tracker.test');
  });

  it('leaves raw HTML in a model’s reply inert', () => {
    /*
      The message is MODEL OUTPUT. It just went from "a string in a text node"
      to "input to a markup pipeline", which is the moment a renderer starts
      being an injection surface. `rehype-raw` is not installed and
      `allowDangerousHtml` is off, so html is text — pinned here rather than
      left to the absence of a dependency somebody could add later for an
      unrelated reason.
    */
    const { container } = render(
      conversation({
        thread: [
          agentTurn('<img src=x onerror="alert(1)"> and <script>alert(2)</script>'),
        ],
      }),
    );

    expect(screen.getByRole('region', { name: `Conversation with ${quill.name}` }).querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelectorAll('script')).toHaveLength(0);
    expect(container.textContent).toContain('alert(1)');
  });

  it('blanks a javascript: link a model wrote', () => {
    const { container } = render(
      conversation({ thread: [agentTurn('[click me](javascript:alert(1))')] }),
    );

    const link = container.querySelector('a');
    expect(link?.textContent).toBe('click me');
    expect(link?.getAttribute('href')).toBe('');
  });

  it('opens a model’s link in a severed window', () => {
    const { container } = render(
      conversation({ thread: [agentTurn('[the report](https://deploy.test/r)')] }),
    );

    const link = container.querySelector('a');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('leaves the user bubble alone — it is not markdown and gains no markup', () => {
    const { container } = render(
      conversation({
        thread: [{ kind: 'user', id: 'u1', text: 'deploy **now** please' }],
      }),
    );

    expect(container.querySelector('strong')).toBeNull();
    expect(container.textContent).toContain('deploy **now** please');
  });
});
