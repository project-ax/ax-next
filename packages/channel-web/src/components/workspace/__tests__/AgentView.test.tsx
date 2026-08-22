/**
 * The agent pane, held to the same rule as the rest of the surface: nothing
 * renders as content unless something real produced it, and every dead end
 * offers a way out.
 *
 * Three regressions are pinned here:
 *
 *   1. A past conversation used to render a lone divider reading "Earlier turns
 *      were summarised into memory · 0 messages folded" over an empty
 *      transcript. Three claims, none of them true: nothing was summarised, the
 *      zero was a fixture, and the excerpt was never fetched.
 *   2. The agent-load error printed a raw code inside the sentence and told the
 *      reader to try again with no way to do it.
 *   3. The dropped-stream error said "send it again" twice and meant RETYPE —
 *      the composer had already cleared the draft.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  workspaceApi,
  type AgentDetail,
  type WorkspaceAgent,
} from '@/lib/workspace-api';
import { AgentView } from '../AgentView';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '@/lib/workspace-api',
  );
  return {
    ...actual,
    workspaceApi: {
      agent: vi.fn(),
      sendMessage: vi.fn(),
      streamReply: vi.fn(),
    },
  };
});

const agentMock = vi.mocked(workspaceApi.agent);
const sendMock = vi.mocked(workspaceApi.sendMessage);
const streamMock = vi.mocked(workspaceApi.streamReply);

const quill: WorkspaceAgent = {
  id: 'a-quill',
  name: 'Quill',
  state: 'resting',
  now: null,
  counter: null,
  startedAt: null,
  stoppedReason: null,
};

function detail(over: Partial<AgentDetail> = {}): AgentDetail {
  return {
    agent: quill,
    permissions: [],
    conversationId: 'c-now',
    thread: [{ kind: 'user', id: 't1', text: 'what is on today' }],
    past: [],
    files: [],
    memory: [],
    ...over,
  };
}

/** Current detail carries one past row; `?conversationId=` returns its turns. */
function withPast() {
  agentMock.mockImplementation(async (_id: string, conversationId?: string) =>
    conversationId === 'c-old'
      ? detail({
          conversationId: 'c-old',
          thread: [{ kind: 'user', id: 'o1', text: 'the March question' }],
        })
      : detail({ past: [{ id: 'c-old', title: 'March', meta: 'last week' }] }),
  );
}

function renderView() {
  return render(
    <AgentView
      agentId="a-quill"
      tab="chat"
      onTab={vi.fn()}
      decisions={[]}
      onApprove={vi.fn()}
      onDismiss={vi.fn()}
      onUndo={vi.fn()}
      activity={[]}
      agents={[quill]}
      onBack={vi.fn()}
      version={0}
      onChanged={vi.fn()}
    />,
  );
}

beforeEach(() => {
  agentMock.mockReset();
  sendMock.mockReset();
  streamMock.mockReset();
});

describe('past conversations', () => {
  it('fetches the real excerpt and invents no fold marker', async () => {
    withPast();

    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'March' }));

    expect(await screen.findByText('the March question')).toBeTruthy();
    await waitFor(() =>
      expect(agentMock).toHaveBeenCalledWith('a-quill', 'c-old'),
    );
    // The three claims that used to sit above an empty transcript.
    expect(screen.queryByText(/summarised into memory/)).toBeNull();
    expect(screen.queryByText(/messages folded/)).toBeNull();
    expect(screen.queryByText(/0 messages/)).toBeNull();
  });

  it('keeps a past conversation read-only', async () => {
    withPast();

    renderView();
    // The current conversation has a composer…
    expect(await screen.findByPlaceholderText('Message Quill')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'March' }));
    await screen.findByText('the March question');

    // …and the past one does not.
    expect(screen.queryByPlaceholderText('Message Quill')).toBeNull();
    expect(screen.getByText(/read-only/)).toBeTruthy();
  });

  it('says so when the excerpt will not open, instead of showing a blank one', async () => {
    agentMock.mockImplementation(async (_id: string, conversationId?: string) => {
      if (conversationId === 'c-old') throw new Error('workspace /agents → 404');
      return detail({ past: [{ id: 'c-old', title: 'March', meta: 'last week' }] });
    });

    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'March' }));

    expect(
      await screen.findByText(/could not open that conversation/i),
    ).toBeTruthy();
  });
});

describe('the agent will not load', () => {
  it('offers a Try again that actually re-runs the load', async () => {
    agentMock.mockRejectedValueOnce(new Error('workspace /agents/ag_x → 404'));
    agentMock.mockResolvedValue(detail());

    renderView();
    const retry = await screen.findByRole('button', { name: 'Try again' });
    // The code is present, but on its own line — never inside the sentence a
    // non-technical reader has to parse.
    const prose = screen.getByText(/We could not load this agent/);
    expect(prose.textContent).not.toMatch(/ag_x/);
    expect(screen.getByText('workspace /agents/ag_x → 404')).toBeTruthy();

    fireEvent.click(retry);
    expect(await screen.findByText('what is on today')).toBeTruthy();
  });
});

describe('a reply that did not finish', () => {
  it('says it once and resends the held text without retyping', async () => {
    agentMock.mockResolvedValue(detail());
    sendMock.mockResolvedValue({ conversationId: 'c-now', reqId: 'r1' });
    streamMock.mockImplementation(
      async (_reqId: string, h: { onError: (m: string) => void }) => {
        h.onError('the reply stream would not open (500)');
      },
    );

    renderView();
    const box = await screen.findByPlaceholderText('Message Quill');
    fireEvent.change(box, { target: { value: 'summarise the roof quote' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    const line = await screen.findByText(/didn’t finish/);
    // One statement about one event — the raw code lives below the prose, and
    // "send it again" is a button, not an instruction repeated twice.
    expect(line.textContent).not.toMatch(/500/);
    expect(line.textContent).not.toMatch(/send it again/i);
    expect(screen.getByText('the reply stream would not open (500)')).toBeTruthy();

    sendMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Resend' }));

    await waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'summarise the roof quote' }),
      ),
    );
  });
});
