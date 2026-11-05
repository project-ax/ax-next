/**
 * The rail and settings are security surfaces, so these tests are mostly about what it is
 * NOT allowed to say.
 *
 * The rule underneath all of them: an empty list is a CLAIM. A block that has
 * nothing to show has to say WHY — nothing there, no producer here, or a read
 * that failed — because "we can't tell you" and "it cannot do that" are
 * opposite answers and a bare empty state renders as the second one.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { workspaceApi, type WorkspaceAgent } from '@/lib/workspace-api';
import { AgentRail } from '../AgentRail';
import { AgentSettings } from '../AgentSettings';
import { describedRow, mcpRow, rail, siteGrant } from './rail-fixture';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspace-api');
  return {
    ...actual,
    workspaceApi: {
      rail: vi.fn(),
      connectors: vi.fn(async () => ({ connectors: [], shared: false, manageable: true, sharedCredentials: false, connectorsSupported: true })),
      revokeGrant: vi.fn(),
      abilities: vi.fn(),
      setAbility: vi.fn(),
    },
  };
});

const railMock = vi.mocked(workspaceApi.rail);
const revokeMock = vi.mocked(workspaceApi.revokeGrant);
const abilitiesMock = vi.mocked(workspaceApi.abilities);
const ALL_ON = { webSearch: true, readPages: true, runCode: true };

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

/** Permissions and grants moved intact into the settings section (TASK-889). */
function renderConnectorsSettings() {
  const r = render(
    <AgentSettings agent={agent()} section="connectors" onSection={vi.fn()}
      onBack={vi.fn()} compact={false} busy={false} instructions={null} memory={null} />,
  );
  return { ...r, container: document.body };
}

/** Open "See everything it can do" — where the rules list moved (TASK-738). */
async function openPermissions(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'See everything it can do' }));
  await screen.findByRole('dialog', { name: 'Everything Quill can do' });
}

/** Expand the collapsed "Granted by you" group. */
async function openGrants(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: /Granted by you/ }));
}

beforeEach(() => {
  vi.clearAllMocks();
  railMock.mockResolvedValue(rail());
  abilitiesMock.mockResolvedValue({ abilities: ALL_ON });
});

describe('AgentSettings — "See everything it can do"', () => {
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
    const { container } = renderConnectorsSettings();
    await openPermissions();

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
    const { container } = renderConnectorsSettings();
    await openPermissions();

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
    const { container } = renderConnectorsSettings();
    await openPermissions();

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
    const { container } = renderConnectorsSettings();
    await openPermissions();

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
              effect: [],
              mechanicalLabel: 'some_unmapped_tool',
              theirDescription: null,
              theirName: null,
            },
          ],
        },
      }),
    );
    const { container } = renderConnectorsSettings();
    await openPermissions();

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
              effect: [],
              mechanicalLabel: null,
              theirDescription: null,
              theirName: null,
            },
          ],
        },
      }),
    );
    const { container } = renderConnectorsSettings();
    await openPermissions();

    await screen.findByText(/rule:mystery/);
    expect(container.textContent).toMatch(/Can do something we can't put a name to/);
    expect(container.textContent).toMatch(/We haven't described this one/);
    expect(container.querySelector('code')).toBeNull();
  });

  describe('effect disclosure (TASK-329)', () => {
    it('renders the "Costs money" marker on a spends+allow row', async () => {
      railMock.mockResolvedValue(
        rail({
          permissions: {
            status: 'ok',
            incomplete: false,
            unrestrictedTools: false,
            rows: [describedRow({ verdict: 'allow', effect: ['spends'] })],
          },
        }),
      );
      renderConnectorsSettings();
      await openPermissions();

      await screen.findByText(/search the web/);
      expect(await screen.findByText('Costs money')).toBeTruthy();
    });

    it('renders the "Affects the outside world" marker on an outward+hold row', async () => {
      // The lint means `outward` can never be `allow`, so `hold` is the
      // realistic verdict for the first outward row this surface will ever
      // carry — the card asks for that row to render with no further work.
      railMock.mockResolvedValue(
        rail({
          permissions: {
            status: 'ok',
            incomplete: false,
            unrestrictedTools: false,
            rows: [describedRow({ verdict: 'hold', effect: ['outward'] })],
          },
        }),
      );
      renderConnectorsSettings();
      await openPermissions();

      await screen.findByText(/search the web/);
      expect(await screen.findByText('Affects the outside world')).toBeTruthy();
    });

    it('TASK-383: draws the marker on an UNDESCRIBED row that declares an effect', async () => {
      /*
        A row shape nothing rendered before this card, because nothing could
        produce it. The mechanical base row's `effect` was hardcoded `[]`, so
        "we cannot describe this tool" and "nobody classified its effects" were
        the same row in practice, and every effect test above uses
        `describedRow`. Now the base row reads `EvaluateResult.effect` — a
        `when`-only tool's fall-through carries the union of its rules' effects
        — and `described: false` with `['spends']` is a real, shippable row.

        It is not a contradiction: we cannot say what the tool does IN OUR
        WORDS, and the table can still say the call costs money. The renderer
        already handles it — the badge map sits OUTSIDE both `described`
        branches in `PermissionLine` — so this test changes no component code.
        It exists because "already handles it" is a claim, and an unasserted
        claim about a shape that was previously unreachable is exactly the kind
        of thing that quietly stops being true.

        Both halves are asserted on purpose: the trust line proves the row
        really did take the undescribed path (a test that only found the badge
        would pass against a row that rendered as described), and the badge
        proves disclosure survived it.
      */
      railMock.mockResolvedValue(
        rail({
          permissions: {
            status: 'ok',
            incomplete: false,
            unrestrictedTools: false,
            rows: [
              mcpRow({
                verdict: 'hold',
                effect: ['spends'],
                theirDescription: null,
                theirName: null,
                source: 'tool:delete_file',
                provenance: 'unmapped',
                mechanicalLabel: 'delete_file',
              }),
            ],
          },
        }),
      );
      renderConnectorsSettings();
      await openPermissions();

      expect(await screen.findByText(/We haven't described this one/)).toBeTruthy();
      expect(await screen.findByText('Costs money')).toBeTruthy();
    });

    it('suppresses the marker on a deny row that still declares an effect (D3)', async () => {
      // A `deny` row says "Cannot X" — the call never happens, so there is no
      // spend to disclose. "Cannot pay an invoice — Costs money" would read as
      // reach the agent HAS to someone scanning for money-spenders, which is
      // backwards. The wire row still carries `effect: ['spends']` faithfully;
      // only the renderer declines to draw it.
      railMock.mockResolvedValue(
        rail({
          permissions: {
            status: 'ok',
            incomplete: false,
            unrestrictedTools: false,
            rows: [
              describedRow({
                verdict: 'deny',
                capability: 'pay an invoice',
                effect: ['spends'],
              }),
            ],
          },
        }),
      );
      renderConnectorsSettings();
      await openPermissions();

      // The row itself must render — otherwise this test would pass whether
      // or not the suppression logic exists at all.
      await screen.findByText(/pay an invoice/);
      expect(screen.queryByText('Costs money')).toBeNull();
    });

    it('renders no marker for an unclassified row — exactly one marker across the two rows', async () => {
      /*
        Unclassified is an EMPTY ARRAY (TASK-330), and this is the row that
        declares nothing.

        The FIRST version of this test rendered a lone unclassified row and
        asserted `queryByText('Costs money')` was null. That test could not
        fail, and review caught it: back when the field was nullable, deleting
        the `effect !== null` guard rendered `EffectMark({ effect: null })`,
        whose `EFFECT_DISCLOSURES[null]` is `undefined` — spreading `undefined`
        is legal, so the button rendered with NO TEXT, threw nothing, and a
        query for "Costs money" was still null. The assertion passed against
        working code, broken code, and a mutation of the very guard it named.

        So this counts BADGES, not words, and it pairs the unclassified row
        with a spends row. Querying by the trailing "Details." of the trigger's
        `aria-label` finds a marker even when its visible label fenced away to
        nothing, which is exactly the empty-badge case the old test was blind
        to: one marker means the renderer CAN draw one and drew none for the
        unclassified row; two means it is drawing something for `[]`.
      */
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
                effect: ['spends'],
              }),
              describedRow({
                verdict: 'allow',
                capability: 'read files in its own workspace',
                source: 'rule:sandbox.read',
                effect: [],
              }),
            ],
          },
        }),
      );
      renderConnectorsSettings();
      await openPermissions();

      await screen.findByText(/read files in its own workspace/);
      expect(screen.getAllByRole('button', { name: /Details\.$/ })).toHaveLength(1);
      // …and it is the spending row's, not a nameless badge on the other one.
      expect(
        screen.getByRole('button', { name: /Details\.$/ }).textContent,
      ).toBe('Costs money');
    });

    it('opens the popover and shows the per-use cost detail', async () => {
      railMock.mockResolvedValue(
        rail({
          permissions: {
            status: 'ok',
            incomplete: false,
            unrestrictedTools: false,
            rows: [describedRow({ verdict: 'allow', effect: ['spends'] })],
          },
        }),
      );
      renderConnectorsSettings();
      await openPermissions();

      const trigger = await screen.findByText('Costs money');
      fireEvent.click(trigger);
      expect(await screen.findByText(/paid request/)).toBeTruthy();
    });

    it('never renders the same visible string for the two effects', async () => {
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
                effect: ['spends'],
              }),
              describedRow({
                verdict: 'hold',
                capability: 'post a message where others can see it',
                source: 'rule:messaging.post',
                effect: ['outward'],
              }),
            ],
          },
        }),
      );
      renderConnectorsSettings();
      await openPermissions();

      expect(await screen.findByText('Costs money')).toBeTruthy();
      expect(await screen.findByText('Affects the outside world')).toBeTruthy();
    });

    it('draws BOTH disclosures on one row that declares two (TASK-330)', async () => {
      /*
        `web_extract` is the first shipped rule to declare a SET: it spends
        money AND it hands the URL to a third party that sees the request. A
        renderer that drew only the first member would show "Costs money" and
        silently swallow the outward half — understating reach, which is the
        one direction design H4 forbids, and precisely the state the rail was
        in before this card.

        Counts BADGES rather than only querying the two strings, for the same
        reason the unclassified test above does: a marker whose visible label
        came out empty is still a marker, and "there are exactly two" is the
        assertion that a one-badge renderer cannot pass.
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
                capability: 'read a web page, and remember the site it came from',
                source: 'rule:web.extract',
                provenance: 'rule',
                conditional: true,
                effect: ['spends', 'outward'],
              }),
            ],
          },
        }),
      );
      const { container } = renderConnectorsSettings();
      await openPermissions();

      await screen.findByText(/read a web page/);
      const marks = screen.getAllByRole('button', { name: /Details\.$/ });
      expect(marks).toHaveLength(2);
      // Two facts, read as two, in the order the rule declared them.
      expect(marks.map((m) => m.textContent)).toEqual([
        'Costs money',
        'Affects the outside world',
      ]);
      // The verdict frame still leads the row — the badges qualify it, they
      // do not replace it.
      expect(container.textContent).toMatch(
        /Can read a web page, and remember the site it came from — asks you first, in some cases/,
      );
    });
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
    const { container } = renderConnectorsSettings();

    // The tab's rule count must not read as a limit on tool reach.
    await openPermissions();
    expect(screen.getByText(/search the web/)).toBeTruthy();
    // Plain language, and it leads with the consequence. It fires for every
    // default personal agent, so it must not read as an error either.
    expect(container.textContent).toMatch(/Nothing limits which tools Quill can use/);
    expect(container.textContent).toMatch(/not a boundary/);
    // The warning refers to the visible rows.
    expect(container.textContent).toMatch(/The rules above are what's installed today/);
    expect(container.textContent).not.toMatch(/list above/);
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
    const { container } = renderConnectorsSettings();

    // A short list still explains that one of its sources did not answer.
    await openPermissions();
    expect(screen.getByText(/search the web/)).toBeTruthy();
    expect(container.textContent).toMatch(/the rules above may be missing something/);
    expect(container.textContent).not.toMatch(/this list may be/);
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
    const first = renderConnectorsSettings();
    await openPermissions();
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
    renderConnectorsSettings();
    await openPermissions();
    expect(
      await screen.findByText(/couldn’t read the rules that govern Quill/),
    ).toBeTruthy();
  });

  it('never makes a claim about the agent’s reach from an empty list', async () => {
    const { container } = renderConnectorsSettings();
    await screen.findByText(/Granted by you/);
    const text = container.textContent ?? '';

    // The specific false sentences an earlier revision shipped, and the shape
    // of any replacement for them.
    expect(text).not.toMatch(/talk to you and nothing else/);
    expect(text).not.toMatch(/will ask before/);
    expect(text).not.toMatch(/nothing else/i);
  });
});

describe('AgentSettings — rules are disclosed behind "See everything it can do"', () => {
  const rows = [describedRow(), mcpRow()];
  beforeEach(() => {
    railMock.mockResolvedValue(rail({ permissions: {
      status: 'ok', incomplete: false, unrestrictedTools: false, rows,
    } }));
  });

  it('reveals every rule only once the permissions dialog opens in settings', async () => {
    renderConnectorsSettings();
    await screen.findByText('What Quill can do');
    expect(screen.queryByRole('tab', { name: 'Connectors' })).toBeNull();
    expect(document.body.textContent).not.toContain(rows[0]!.source);
    await openPermissions();
    for (const row of rows) expect(document.body.textContent).toContain(row.source);
  });

  it('keeps the unknown-reach sentence for an empty list', async () => {
    railMock.mockResolvedValue(rail({ permissions: {
      status: 'ok', incomplete: false, unrestrictedTools: false, rows: [],
    } }));
    renderConnectorsSettings();
    await openPermissions();
    expect(await screen.findByText(/Nothing here describes Quill/)).toBeTruthy();
  });
});

describe('AgentRail — the side panel shell', () => {
  const body = <p>Panel body fixture</p>;

  it('is named for the view it shows, with that view as its heading', () => {
    render(<AgentRail panel="files" meta="3 files">{body}</AgentRail>);
    const panel = screen.getByRole('complementary', { name: 'Files' });
    expect(panel).toContainElement(screen.getByText('Panel body fixture'));
    expect(screen.getByRole('heading', { level: 2, name: 'Files' })).toBeTruthy();
    expect(screen.getByText('3 files')).toBeTruthy();
  });

  it.each([
    ['memory', 'Memory'],
    ['activity', 'Activity'],
  ] as const)('heads the %s view "%s"', (panel, label) => {
    render(<AgentRail panel={panel}>{body}</AgentRail>);
    expect(screen.getByRole('complementary', { name: label })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: label })).toBeTruthy();
  });

  /*
    The header's icon toggles are the only way in and out. A collapse button
    or a tab strip here would be a second, disagreeing answer to "how do I
    get this back".
  */
  it('has no tabs, no collapse control and no chats', () => {
    render(<AgentRail panel="files">{body}</AgentRail>);
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('button', { name: /Current conversation/ })).toBeNull();
  });

  it('draws no meta line when there is none to show', () => {
    render(<AgentRail panel="files" meta={null}>{body}</AgentRail>);
    expect(screen.getByRole('heading', { level: 2 }).parentElement?.textContent).toBe('Files');
  });
});

describe('AgentSettings — "Granted by you"', () => {
  it('is a separate group, sourced from the grant record, with revoke', async () => {
    railMock.mockResolvedValue(
      rail({ grants: { status: 'ok', rows: [siteGrant()], incomplete: false } }),
    );
    renderConnectorsSettings();
    await openGrants();

    expect(await screen.findByText('api.linear.app')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeTruthy();
  });

  it('the Revoke button revokes — and re-reads rather than removing the row itself', async () => {
    railMock.mockResolvedValue(
      rail({ grants: { status: 'ok', rows: [siteGrant()], incomplete: false } }),
    );
    revokeMock.mockResolvedValue({ revoked: true });
    renderConnectorsSettings();
    await openGrants();

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
    renderConnectorsSettings();
    await openGrants();

    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    expect(await screen.findByText(/already gone/)).toBeTruthy();
  });

  it('says nothing changed when the revoke itself failed', async () => {
    railMock.mockResolvedValue(
      rail({ grants: { status: 'ok', rows: [siteGrant()], incomplete: false } }),
    );
    revokeMock.mockRejectedValue(new Error('boom'));
    renderConnectorsSettings();
    await openGrants();

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
    renderConnectorsSettings();
    await openGrants();

    await screen.findByText('api.linear.app');
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
  });
});

describe('AgentSettings — permissions that would not load', () => {
  it('drops the rail rather than showing stale claims beside an error', async () => {
    railMock.mockRejectedValue(new Error('workspace /rail → 500'));
    const { container } = renderConnectorsSettings();
    await openPermissions();

    await waitFor(() => {
      expect(container.textContent).toMatch(/unknown rather than empty/);
    });
    // And no "This week" panel standing beside the error. A number read
    // before the failure would be the stale claim this test is named for.
    expect(screen.queryByText('This week')).toBeNull();
  });
});

