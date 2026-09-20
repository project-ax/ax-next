/**
 * The replayed turn-failure row (TASK-498).
 *
 * WHAT THIS IS THE OTHER HALF OF. Fault A (#137/#138) made a dying turn
 * visible while it was dying — an SSE error frame, and an alert over the
 * composer. Nothing made it visible AFTERWARDS. `chat:turn-error` has been
 * persisted as a display event since TASK-66 and projected onto
 * `conversations:get`'s `displayEvents` ever since, and on the day this card
 * was built a repo-wide grep found no reader for that field anywhere. So the
 * TASK-357 walk saw a refresh leave the person's message sitting alone: no
 * reply, no failure, nothing to say the turn had ever been tried.
 *
 * WHAT IS ASSERTABLE HERE AND WHAT IS NOT. jsdom has no CSS and no layout, so
 * every claim about width, colour or contrast is vacuous by construction and
 * none is made. What is real is the ACCESSIBILITY TREE and the rendered text:
 * the row carries `role="alert"`, and it says the authored sentence for its
 * reason code rather than the code.
 */
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentConversation } from '../AgentConversation';
import type { ThreadMessage, WorkspaceAgent } from '@/lib/workspace-api';
import { DEFAULT_TURN_ERROR, ERROR_LABELS } from '@/lib/turn-error-labels';
import { localTime } from '@/lib/workspace-time';

const quill: WorkspaceAgent = {
  id: 'a1',
  name: 'Quill',
  state: 'resting',
  now: null,
  counter: null,
  startedAt: null,
  stoppedReason: null,
};

function renderThread(thread: ThreadMessage[]): ReturnType<typeof render> {
  const props: ComponentProps<typeof AgentConversation> = {
    agent: quill,
    thread,
    conversationId: 'c1',
    decisions: [],
    readOnly: false,
    onSend: vi.fn(),
    onApprove: vi.fn(),
    onDismiss: vi.fn(),
    onUndo: vi.fn(),
    approvalRead: 'ok',
    onRetryApprovals: vi.fn(),
    grants: [],
    onGrantResolved: vi.fn(),
    onGranted: vi.fn(async () => true),
  };
  return render(<AgentConversation {...props} />);
}

const errorRow = (
  over: Partial<Extract<ThreadMessage, { kind: 'error' }>> = {},
): ThreadMessage =>
  ({
    kind: 'error',
    id: 'turn-error:req-dead',
    reason: 'chat-run-timeout',
    at: '2026-09-20T16:12:00.000Z',
    ...over,
  }) as ThreadMessage;

const ask: ThreadMessage = {
  kind: 'user',
  id: 't1',
  text: 'summarise my inbox',
};

describe('a replayed turn failure', () => {
  it('announces itself — the person is not left with their message alone', () => {
    /*
      THE REGRESSION, in one assertion. Before this card the thread had no
      `error` variant at all, so this row could not exist and a reloaded
      failure rendered as nothing whatsoever.
    */
    renderThread([ask, errorRow()]);
    expect(screen.getByRole('alert')).toHaveTextContent(
      ERROR_LABELS['chat-run-timeout']!,
    );
  });

  it('says the sentence, never the reason code', () => {
    // `chat-run-timeout` is host vocabulary. A reader meeting it on screen is
    // the defect TASK-296 spent a card removing from this surface.
    renderThread([errorRow()]);
    const alert = screen.getByRole('alert');
    expect(alert.textContent ?? '').not.toContain('chat-run-timeout');
  });

  it('falls back to the generic sentence for a code it does not know', () => {
    // Forward-compat with a newer host. The wrong answer here is not a
    // different sentence — it is printing `chat-run-dispatch-failed` at
    // someone, which is what an unmapped code would do without the fallback.
    renderThread([errorRow({ reason: 'chat-run-dispatch-failed' })]);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(DEFAULT_TURN_ERROR);
    expect(alert.textContent ?? '').not.toContain('chat-run-dispatch-failed');
  });

  it('renders the optional detail line under the label', () => {
    // TASK-160 — the only actionable specifics a reader gets ("this dev
    // service failed, at this path"). Dropping it costs them the line that
    // says what to do.
    renderThread([errorRow({ reason: 'dev-service-failed', detail: 'kafka: no /opt' })]);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(ERROR_LABELS['dev-service-failed']!);
    expect(alert).toHaveTextContent('kafka: no /opt');
  });

  it('draws the detail as TEXT, never as markup', () => {
    // Untrusted host output. It is bounded and sanitized server-side and React
    // escapes it here regardless; this is the assertion that says so out loud.
    const { container } = renderThread([
      errorRow({ reason: 'dev-service-failed', detail: '<img src=x onerror=alert(1)>' }),
    ]);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('<img src=x onerror=alert(1)>');
  });

  it('sits in the thread in its own place, not hoisted to the end', () => {
    /*
      A failure is a thing that happened at a moment. The LIVE alert floats
      above the composer because it is about the message you are still
      holding; this one is history, and history that reorders itself is a
      failure from last Tuesday claiming to be the state of things now.
    */
    const later: ThreadMessage = {
      kind: 'agent',
      id: 't3',
      text: 'Four things need you.',
      at: '2026-09-20T16:20:00.000Z',
    };
    const { container } = renderThread([ask, errorRow(), later]);
    const text = container.textContent ?? '';
    expect(text.indexOf('summarise my inbox')).toBeLessThan(
      text.indexOf(ERROR_LABELS['chat-run-timeout']!),
    );
    expect(text.indexOf(ERROR_LABELS['chat-run-timeout']!)).toBeLessThan(
      text.indexOf('Four things need you.'),
    );
  });

  it('keeps its clock, like the agent bubble it stands in for', () => {
    // WHEN it failed is most of what makes this legible as history rather than
    // as the state of things now — the same reason the row is not hoisted.
    const { container } = renderThread([errorRow()]);
    expect(container.textContent ?? '').toContain(
      localTime('2026-09-20T16:12:00.000Z')!,
    );
  });

  it('draws NOTHING for an instant it cannot read', () => {
    /*
      An empty `at` is "no committed instant", not midnight — and not a dash
      either. Asserted as "the row ends at the alert": a placeholder is the
      tempting wrong answer here and it would still satisfy a looser check.
    */
    const { container } = renderThread([errorRow({ at: '' })]);
    const alertText = screen.getByRole('alert').textContent ?? '';
    expect(alertText).toContain(ERROR_LABELS['chat-run-timeout']!);
    expect((container.textContent ?? '').endsWith(alertText)).toBe(true);
  });

  it('offers no control — the composer below is the way on', () => {
    /*
      A "Resend" here would have to re-send a message whose attachment ids
      were spent the moment the POST landed: a button that cannot work, which
      is the dead-button offer TASK-276 spent a card removing. The thread has
      a live composer under it and saying it again is the honest route.
    */
    renderThread([ask, errorRow()]);
    const alert = screen.getByRole('alert');
    expect(alert.querySelectorAll('button')).toHaveLength(0);
  });

  it('two failures in one thread are two rows', () => {
    // They fold per originating turn in the store, so two rows here mean two
    // turns died — and collapsing them would hide one of them.
    renderThread([
      errorRow({ id: 'turn-error:r1' }),
      errorRow({ id: 'turn-error:r2', reason: 'dev-service-failed' }),
    ]);
    expect(screen.getAllByRole('alert')).toHaveLength(2);
  });
});
