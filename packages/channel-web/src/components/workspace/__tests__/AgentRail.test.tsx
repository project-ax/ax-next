/**
 * The rail is where a zero would do the most damage: "you overruled it: 0" is
 * a claim, and we are not counting overrules. So the counters panel is absent
 * rather than empty, and "Right now" says the state word alone when nothing is
 * reporting an activity line.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AgentDetail, WorkspaceAgent } from '@/lib/workspace-api';
import { AgentRail } from '../AgentRail';

function agent(over: Partial<WorkspaceAgent> = {}): WorkspaceAgent {
  return {
    id: 'a-quill',
    name: 'Quill',
    state: 'resting',
    now: null,
    counter: null,
    startedAt: null,
    stoppedReason: null,
    ...over,
  };
}

function detail(over: Partial<AgentDetail> = {}): AgentDetail {
  return {
    agent: agent(),
    permissions: [],
    conversationId: null,
    thread: [],
    past: [],
    files: [],
    memory: [],
    ...over,
  };
}

function renderRail(d: AgentDetail) {
  return render(
    <AgentRail detail={d} openPastId={null} onOpenPast={vi.fn()} />,
  );
}

describe('AgentRail', () => {
  it('never renders a "This week" panel before the counters are real', () => {
    renderRail(detail());
    expect(screen.queryByText('This week')).toBeNull();
    // The old panel's zero-state line went with it.
    expect(screen.queryByText(/it has not run/)).toBeNull();
  });

  it('says only the state word in Right now when the host has no activity line', () => {
    renderRail(detail({ agent: agent({ state: 'resting', now: null }) }));

    expect(screen.getByText('Resting')).toBeTruthy();
    // No em-dash placeholder, and no "nothing queued" stand-in — an empty
    // counter row reads as a report we are not in a position to make.
    expect(screen.queryByText('—')).toBeNull();
    expect(screen.queryByText('nothing queued')).toBeNull();
  });

  it('keeps the counter line when there is something real to put in it', () => {
    renderRail(
      detail({
        agent: agent({
          state: 'working',
          now: 'Reading the Q3 notes',
          counter: { done: 2, total: 9, unit: 'files' },
          startedAt: new Date().toISOString(),
        }),
      }),
    );

    expect(screen.getByText('Reading the Q3 notes')).toBeTruthy();
    expect(screen.getByText('2 of 9 files')).toBeTruthy();
  });

  it('says out loud that the agent has been granted nothing yet', () => {
    renderRail(detail());
    expect(screen.getByText(/it can talk to you and nothing else/)).toBeTruthy();
  });
});
