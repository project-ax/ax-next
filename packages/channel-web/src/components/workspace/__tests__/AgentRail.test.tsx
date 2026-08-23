/**
 * The rail is the security surface, so these tests are mostly about what it is
 * NOT allowed to say.
 *
 * The rule underneath all of them: an empty list is a CLAIM. A block that has
 * nothing to show has to say WHY — nothing there, no producer here, or a read
 * that failed — because "we can't tell you" and "it cannot do that" are
 * opposite answers and a bare empty state renders as the second one.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { workspaceApi, type AgentDetail, type WorkspaceAgent } from '@/lib/workspace-api';
import { AgentRail } from '../AgentRail';
import { describedRow, mcpRow, rail, railActivity, siteGrant } from './rail-fixture';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspace-api');
  return {
    ...actual,
    workspaceApi: { rail: vi.fn(), revokeGrant: vi.fn() },
  };
});

const railMock = vi.mocked(workspaceApi.rail);
const revokeMock = vi.mocked(workspaceApi.revokeGrant);

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
    conversationId: null,
    thread: [],
    past: [],
    memory: [],
    ...over,
  };
}

function renderRail(d: AgentDetail = detail()) {
  return render(<AgentRail detail={d} openPastId={null} onOpenPast={vi.fn()} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  railMock.mockResolvedValue(rail());
});

describe('AgentRail — "Right now"', () => {
  it('says only the state word when nothing is reporting an activity line', async () => {
    renderRail(detail({ agent: agent({ state: 'resting' }) }));

    expect(await screen.findByText('Resting')).toBeTruthy();
    // No em-dash placeholder and no "nothing queued" stand-in: an empty counter
    // row reads as a report we are not in a position to make.
    expect(screen.queryByText('—')).toBeNull();
    expect(screen.queryByText('nothing queued')).toBeNull();
  });

  it('renders the phrase, a real counter and elapsed-since-start', async () => {
    railMock.mockResolvedValue(
      rail({
        activity: {
          status: 'ok',
          activity: railActivity({
            phrase: 'Reading the Q3 notes',
            counter: { done: 2, total: 9, unit: 'files' },
          }),
        },
      }),
    );
    renderRail();

    expect(await screen.findByText('Reading the Q3 notes')).toBeTruthy();
    expect(screen.getByText('2 of 9 files')).toBeTruthy();
  });

  it('never renders progress-bar vocabulary anywhere on the rail (design H2)', async () => {
    railMock.mockResolvedValue(
      rail({
        activity: {
          status: 'ok',
          activity: railActivity({
            phrase: 'No activity for 4 minutes',
            counter: null,
            stale: true,
          }),
        },
      }),
    );
    const { container } = renderRail();

    await screen.findByText('No activity for 4 minutes');
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/%/);
    expect(text).not.toMatch(/\bremaining\b/i);
    expect(text).not.toMatch(/\bleft\b/i);
    expect(text).not.toMatch(/\beta\b/i);
  });

  it('drops the counter on a stale line — the phrase is replaced, not decorated', async () => {
    railMock.mockResolvedValue(
      rail({
        activity: {
          status: 'ok',
          activity: railActivity({
            phrase: 'No activity for 4 minutes',
            // The wire already refuses to carry one on a stale line; this pins
            // that the renderer does not put one back if it ever does.
            counter: null,
            stale: true,
          }),
        },
      }),
    );
    renderRail();

    await screen.findByText('No activity for 4 minutes');
    expect(screen.queryByText(/ of /)).toBeNull();
  });
});

describe('AgentRail — "What it may do alone"', () => {
  it('groups allow first, then hold, then deny', async () => {
    railMock.mockResolvedValue(
      rail({
        permissions: {
          status: 'ok',
          incomplete: false,
          unrestrictedTools: false,
          rows: [
            describedRow({
              verdict: 'allow',
              capability: 'search the web',
              source: 'rule:web.search',
            }),
            describedRow({
              verdict: 'hold',
              capability: 'install a skill it wrote for itself',
              source: 'rule:skills.propose',
            }),
            describedRow({
              verdict: 'deny',
              capability: 'start a hidden helper agent',
              source: 'rule:builtins.task',
            }),
          ],
        },
      }),
    );
    const { container } = renderRail();

    await screen.findByText(/search the web/);
    const text = container.textContent ?? '';
    expect(text.indexOf('search the web')).toBeLessThan(
      text.indexOf('install a skill it wrote for itself'),
    );
    expect(text.indexOf('install a skill it wrote for itself')).toBeLessThan(
      text.indexOf('start a hidden helper agent'),
    );
  });

  it('frames from the verdict, never from the clause', async () => {
    railMock.mockResolvedValue(
      rail({
        permissions: {
          status: 'ok',
          incomplete: false,
          unrestrictedTools: false,
          rows: [
            // A clause that smuggled in a deny word was already rejected by
            // @ax/tool-policy's lint. This pins that the RENDERER would not
            // have believed it either.
            describedRow({ verdict: 'allow', capability: 'never delete anything' }),
          ],
        },
      }),
    );
    const { container } = renderRail();

    await screen.findByText(/never delete anything/);
    expect(container.textContent).toMatch(/Can never delete anything — on its own/);
    expect(container.textContent).not.toMatch(/Cannot/);
  });

  it('says out loud when a rule only applies in some cases (TASK-267)', async () => {
    /*
      "Can delete a folder and everything in it — asks you first" tells the
      reader every such call stops for them. If the rule's predicate only holds
      the recursive ones, the rest do not stop for anybody. The qualifier is the
      difference between a claim we enforce and one we do not.
    */
    railMock.mockResolvedValue(
      rail({
        permissions: {
          status: 'ok',
          incomplete: false,
          unrestrictedTools: false,
          rows: [
            describedRow({
              verdict: 'hold',
              capability: 'delete a folder and everything in it',
              source: 'rule:files.delete-recursive',
              provenance: 'rule',
              conditional: true,
            }),
          ],
        },
      }),
    );
    const { container } = renderRail();

    await screen.findByText(/delete a folder and everything in it/);
    expect(container.textContent).toMatch(
      /Can delete a folder and everything in it — asks you first, in some cases/,
    );
  });

  it('renders an MCP tool mechanically and attributes the vendor prose', async () => {
    railMock.mockResolvedValue(
      rail({
        permissions: {
          status: 'ok',
          incomplete: false,
          unrestrictedTools: false,
          rows: [mcpRow()],
        },
      }),
    );
    const { container } = renderRail();

    await screen.findByText('mcp.linear.create_issue');
    // Our claim: the tool name and the verdict. Nothing else.
    expect(container.textContent).toMatch(/Can use.*mcp\.linear\.create_issue/s);
    expect(container.textContent).toMatch(/asks you first/);
    /*
      THE ROW MUST READ AS LESS TRUSTWORTHY, NOT MERELY LESS DETAILED. The
      sentence is about the TOOL — "we can't tell you what this does" — not
      about the description text, and it names who the tool came from. A muted
      "not verified" hung off the end of the row reads as a documentation
      quibble; this cannot.
    */
    expect(
      screen.getByText(/We can't tell you what this does — it comes from linear/),
    ).toBeTruthy();
    // The vendor's words are NOT on the row — they are behind the affordance.
    expect(screen.queryByText('Creates an issue in Linear')).toBeNull();
    expect(screen.getByText(/What linear says it does/)).toBeTruthy();

    fireEvent.click(screen.getByText(/What linear says it does/));
    expect(await screen.findByText('Creates an issue in Linear')).toBeTruthy();
    // …and attributed, inside the disclosure, in their voice not ours.
    expect(screen.getByText(/linear describes this tool as/)).toBeTruthy();
    expect(screen.getByText(/Those are their words, not ours/)).toBeTruthy();
  });

  it('renders an unmapped capability explicitly rather than omitting it (H4)', async () => {
    railMock.mockResolvedValue(
      rail({
        permissions: {
          status: 'ok',
          incomplete: false,
          unrestrictedTools: false,
          rows: [
            {
              verdict: 'allow',
              capability: '',
              source: 'tool:some_unmapped_tool',
              provenance: 'unmapped',
              described: false,
              conditional: false,
              mechanicalLabel: 'some_unmapped_tool',
              theirDescription: null,
              theirName: null,
            },
          ],
        },
      }),
    );
    const { container } = renderRail();

    expect(await screen.findByText('some_unmapped_tool')).toBeTruthy();
    expect(container.textContent).toMatch(/We haven't described this one/);
    // Nobody else's prose to offer, so no affordance that would promise some.
    expect(screen.queryByText(/says it does/)).toBeNull();
  });

  it('still renders a row it can neither describe nor name', async () => {
    // A described row whose clause fenced away to nothing, with no tool name
    // behind it. Rare, and it still gets a row: dropping it would hide reach
    // the agent has (H4), and an empty code block would read as a rendering
    // bug rather than as a capability.
    railMock.mockResolvedValue(
      rail({
        permissions: {
          status: 'ok',
          incomplete: false,
          unrestrictedTools: false,
          rows: [
            {
              verdict: 'allow',
              capability: '',
              source: 'rule:mystery',
              provenance: 'unmapped',
              described: false,
              conditional: false,
              mechanicalLabel: null,
              theirDescription: null,
              theirName: null,
            },
          ],
        },
      }),
    );
    const { container } = renderRail();

    await screen.findByText(/rule:mystery/);
    expect(container.textContent).toMatch(/Can do something we can't put a name to/);
    expect(container.textContent).toMatch(/We haven't described this one/);
    expect(container.querySelector('code')).toBeNull();
  });

  it('says the list is not a limit when the agent has no tool allow-list', async () => {
    railMock.mockResolvedValue(
      rail({
        permissions: {
          status: 'ok',
          incomplete: false,
          unrestrictedTools: true,
          rows: [describedRow()],
        },
      }),
    );
    const { container } = renderRail();

    await screen.findByText(/search the web/);
    // Plain language, and it leads with the consequence. It fires for every
    // default personal agent, so it must not read as an error either.
    expect(container.textContent).toMatch(/Nothing limits which tools Quill can use/);
    expect(container.textContent).toMatch(/not a boundary/);
  });

  it('says so when a source did not answer, instead of shipping a short list', async () => {
    railMock.mockResolvedValue(
      rail({
        permissions: {
          status: 'ok',
          incomplete: true,
          unrestrictedTools: false,
          rows: [describedRow()],
        },
      }),
    );
    const { container } = renderRail();

    await screen.findByText(/search the web/);
    expect(container.textContent).toMatch(/may be missing something/);
  });

  it('distinguishes "no producer" from "read failed" from "nothing there"', async () => {
    railMock.mockResolvedValue(
      rail({
        permissions: {
          status: 'unavailable',
          incomplete: true,
          unrestrictedTools: false,
          rows: [],
        },
      }),
    );
    const first = renderRail();
    expect(
      await screen.findByText(/doesn’t publish the rules that govern Quill/),
    ).toBeTruthy();
    first.unmount();

    railMock.mockResolvedValue(
      rail({
        permissions: {
          status: 'failed',
          incomplete: true,
          unrestrictedTools: false,
          rows: [],
        },
      }),
    );
    renderRail();
    expect(
      await screen.findByText(/couldn’t read the rules that govern Quill/),
    ).toBeTruthy();
  });

  it('never makes a claim about the agent’s reach from an empty list', async () => {
    const { container } = renderRail();
    await screen.findByText(/Granted by you/);
    const text = container.textContent ?? '';

    // The specific false sentences an earlier revision shipped, and the shape
    // of any replacement for them.
    expect(text).not.toMatch(/talk to you and nothing else/);
    expect(text).not.toMatch(/will ask before/);
    expect(text).not.toMatch(/nothing else/i);
  });
});

describe('AgentRail — "Granted by you"', () => {
  it('is a separate group, sourced from the grant record, with revoke', async () => {
    railMock.mockResolvedValue(
      rail({ grants: { status: 'ok', rows: [siteGrant()], incomplete: false } }),
    );
    renderRail();

    expect(await screen.findByText('api.linear.app')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeTruthy();
  });

  it('the Revoke button revokes — and re-reads rather than removing the row itself', async () => {
    railMock.mockResolvedValue(
      rail({ grants: { status: 'ok', rows: [siteGrant()], incomplete: false } }),
    );
    revokeMock.mockResolvedValue({ revoked: true });
    renderRail();

    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    await waitFor(() => {
      expect(revokeMock).toHaveBeenCalledWith('a-quill', {
        grant: 'site',
        host: 'api.linear.app',
      });
    });
    // The list is re-read from the server. A row that vanished on click without
    // the server agreeing would be this surface lying where it matters most.
    await waitFor(() => {
      expect(railMock.mock.calls.length).toBeGreaterThan(1);
    });
    /*
      And the receipt does not overstate what just happened. A site grant is
      loaded into the egress allowlist when a session OPENS, so a conversation
      already running keeps it until it ends. A bare "Revoked." would let
      somebody believe they had stopped something mid-flight.
    */
    expect(await screen.findByText(/Revoked\./)).toBeTruthy();
    expect(screen.getByText(/may still have it until it finishes/)).toBeTruthy();
  });

  it('reports "already gone" as a refusal, not as a success', async () => {
    railMock.mockResolvedValue(
      rail({ grants: { status: 'ok', rows: [siteGrant()], incomplete: false } }),
    );
    revokeMock.mockResolvedValue({ revoked: false });
    renderRail();

    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    expect(await screen.findByText(/already gone/)).toBeTruthy();
  });

  it('says nothing changed when the revoke itself failed', async () => {
    railMock.mockResolvedValue(
      rail({ grants: { status: 'ok', rows: [siteGrant()], incomplete: false } }),
    );
    revokeMock.mockRejectedValue(new Error('boom'));
    renderRail();

    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    expect(await screen.findByText(/Nothing changed/)).toBeTruthy();
  });

  it('offers no Revoke control when this deployment cannot honour one', async () => {
    railMock.mockResolvedValue(
      rail({
        grants: {
          status: 'ok',
          rows: [siteGrant({ revocable: false })],
          incomplete: false,
        },
      }),
    );
    renderRail();

    await screen.findByText('api.linear.app');
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
  });
});

/*
  WHICH counters exist is the route's contract, not this component's — the panel
  renders whatever rows it is handed. So the pin that "Handled on its own" and
  "You overruled it" never ship (TASK-265) lives with their producer, in
  `__tests__/server/routes-workspace-rail.test.ts`. Asserting their absence here
  instead would only prove that a mock we wrote never mentioned them, which is
  the kind of green that reads as a guarantee and is not one.
*/
describe('AgentRail — "This week"', () => {
  it('renders no panel at all when there is no number to put in it', async () => {
    renderRail();
    await screen.findByText(/Granted by you/);
    expect(screen.queryByText('This week')).toBeNull();
  });

  it('prints each counter’s written definition beside its number', async () => {
    railMock.mockResolvedValue(
      rail({
        counters: {
          status: 'ok',
          windowDays: 7,
          rows: [
            {
              id: 'brought-to-you',
              label: 'Brought to you',
              value: 3,
              definition: 'Decisions this agent raised for you in the last 7 days.',
            },
          ],
        },
      }),
    );
    renderRail();

    expect(await screen.findByText('Brought to you')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(
      screen.getByText('Decisions this agent raised for you in the last 7 days.'),
    ).toBeTruthy();
  });
});

describe('AgentRail — a rail that would not load', () => {
  it('drops the rail rather than showing stale claims beside an error', async () => {
    railMock.mockRejectedValue(new Error('workspace /rail → 500'));
    const { container } = renderRail();

    await waitFor(() => {
      expect(container.textContent).toMatch(/unknown rather than empty/);
    });
    // And no "This week" panel standing beside the error. A number read
    // before the failure would be the stale claim this test is named for.
    expect(screen.queryByText('This week')).toBeNull();
  });
});
