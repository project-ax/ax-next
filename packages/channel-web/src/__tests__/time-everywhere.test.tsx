/**
 * Rule 11, "Timestamp everywhere": the moments channel-web shows, each through
 * the package's one formatter, at a fixed local-noon "now" so the words are the
 * same in any machine zone. One case per helper this card retired: `ago`
 * (DecisionRow), `timeAgo` (artifact version labels, self-changes), the Models
 * tab's own `timeAgo`, `Elapsed`, `toLocale*` (fires table, teams) and the rest
 * are asserted where their screens are tested; this file covers the ones that
 * had no test of their own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { Elapsed } from '@/components/workspace/bits';
import { DecisionRow } from '@/components/workspace/DecisionRow';
import { AgentSelfChanges } from '@/components/workspace/AgentSelfChanges';
import { FireRowsTable } from '@/components/routines/FireRowsTable';
import { versionLabel } from '@/lib/artifact-labels';
import { cachedNote } from '@/lib/models-copy';
import type { Fire } from '@/lib/routines';
import type { WorkspaceAgent } from '@/lib/workspace-api';
import { decisionFixture } from '@/components/workspace/__tests__/decision-fixture';
import { beforeNoon, freezeClock, NOON, thawClock, visibleText } from '@/test-utils/time';

const MIN = 60_000;
const HR = 60 * MIN;

beforeEach(freezeClock);
afterEach(thawClock);

describe('Elapsed (was "started N min ago" by hand)', () => {
  it('says when the work began, through Timestamp', () => {
    const { container } = render(<Elapsed since={beforeNoon(5 * MIN)} />);
    expect(visibleText(container)).toBe('started 5 min ago');
    expect(container.querySelector('time')?.getAttribute('datetime')).toBe(beforeNoon(5 * MIN));
  });

  it('a moment ago reads "started just now"; a bad or missing time says nothing', () => {
    expect(visibleText(render(<Elapsed since={beforeNoon(10_000)} />).container)).toBe('started just now');
    expect(render(<Elapsed since="not a time" />).container.innerHTML).toBe('');
    expect(render(<Elapsed since={null} />).container.innerHTML).toBe('');
  });
});

describe('DecisionRow (was `ago`: "5m ago", "1h ago")', () => {
  const agent: WorkspaceAgent = {
    id: 'scheduler',
    name: 'Scheduler',
    state: 'waiting',
    now: null,
    counter: null,
    startedAt: null,
    stoppedReason: null,
  };

  it('dates the row with a Timestamp', () => {
    const { container } = render(
      <DecisionRow
        decision={decisionFixture({ createdAt: beforeNoon(HR) })}
        agent={agent}
        expanded={false}
        onToggle={vi.fn()}
        onOpenAgent={vi.fn()}
        onApprove={vi.fn()}
        onDismiss={vi.fn()}
        onUndo={vi.fn()}
      />,
    );
    const time = container.querySelector('time');
    expect(time && visibleText(time)).toBe('1 hr ago');
    expect(time?.getAttribute('datetime')).toBe(beforeNoon(HR));
  });
});

describe('artifact version labels (was timeAgo)', () => {
  it('v3 · 2 hr ago, and just the version for a time it cannot read', () => {
    expect(versionLabel({ version: 3, createdAt: beforeNoon(2 * HR) })).toBe('v3 · 2 hr ago');
    expect(versionLabel({ version: 3, createdAt: 'nope' })).toBe('v3');
  });
});

describe("the Models tab's cached note (was its own timeAgo)", () => {
  it('words the age with the shared formatter, and "earlier" without one', () => {
    expect(cachedNote(beforeNoon(10 * MIN), NOON.getTime())).toBe('Showing models from 10 min ago.');
    expect(cachedNote(beforeNoon(MIN / 2), NOON.getTime())).toBe('Showing models from just now.');
    expect(cachedNote(undefined, NOON.getTime())).toBe('Showing models from earlier.');
    expect(cachedNote('nope', NOON.getTime())).toBe('Showing models from earlier.');
  });
});

describe('the agent self-changes list (was timeAgo)', () => {
  it('shows each change with a Timestamp, and none for a time it cannot read', () => {
    render(
      <AgentSelfChanges
        rows={[
          { key: 'a', agentId: 'a1', agentName: 'Quill', words: 'edited its own persona.', changedAt: beforeNoon(3 * HR) },
          { key: 'b', agentId: 'a2', agentName: 'Fern', words: 'added a skill.', changedAt: 'nope' },
        ]}
      />,
    );
    const times = document.querySelectorAll('time');
    expect(times).toHaveLength(1);
    expect(visibleText(times[0]!)).toBe('3 hr ago');
  });
});

describe('the fires table (was a hand-rolled "Today 10:02 AM")', () => {
  const fire = (firedAt: string): Fire => ({
    agentId: 'agt',
    routineId: 'r1',
    firedAt,
    triggerSource: 'tick',
    status: 'ok',
    error: null,
    warning: null,
    conversationId: 'c1',
    renderedPrompt: null,
    report: null,
  });

  it('dates each run relative to now, with the whole date as the tooltip', () => {
    render(<FireRowsTable fires={[fire(beforeNoon(5 * MIN)), fire(beforeNoon(30 * 86_400_000))]} />);
    const times = [...document.querySelectorAll('time')];
    expect(times.map((t) => visibleText(t))).toEqual(['5 min ago', 'Oct 27']);
    expect(times.map((t) => t.getAttribute('title'))).toEqual([
      'Thu, Nov 26, 2026, 11:55 AM',
      expect.stringMatching(/^\w{3}, Oct 27, 2026, /),
    ]);
  });
});
