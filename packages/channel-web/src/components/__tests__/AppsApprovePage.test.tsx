/**
 * The approve page: an external app's viewer, signed in, says yes to the app
 * using one connector as them through one of their own agents. The wire is
 * stubbed at `fetch`, so what is asserted is what the person sees and exactly
 * what the page sends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ApprovalPrompt } from '@ax/apps-bridge-contract';
import { APP_NAMED_ITSELF, AppsApprovePage, ARM_DELAY_MS, TOOLS_ASKED, TOOLS_NEED_ALLOW } from '../AppsApprovePage';

const APP = 'app_01JDZ8M5Q4X7RT3VKF0N2C9H6B';
const IDS = { platformId: 'canopy', appId: APP, connectorId: 'linear' } as const;
const URL_ = `/settings/app-approval/canopy/${APP}/linear`;

function prompt(over: Partial<ApprovalPrompt> = {}): ApprovalPrompt {
  return {
    platformId: 'canopy',
    appId: APP,
    appName: 'Deal Board',
    connectorId: 'linear',
    connectorName: 'Linear',
    tools: ['list_issues', 'create_issue'],
    agents: [{ agentId: 'agt_1', displayName: 'Scout' }],
    approvedAgentId: null,
    ...over,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
let originalFetch: typeof fetch;

beforeEach(() => {
  // Only the clock is fake, so Allow's arming delay can be stepped past while
  // the library's own waits still run on real timers.
  vi.useFakeTimers({ toFake: ['Date'] });
  originalFetch = globalThis.fetch;
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function posts(): Array<{ url: string; init: RequestInit }> {
  return fetchMock.mock.calls
    .filter((c) => c[1]?.method === 'POST')
    .map((c) => ({ url: String(c[0]), init: c[1] as RequestInit }));
}

const allow = () => screen.getByRole('button', { name: 'Allow' });
/** Step the clock past Allow's arming delay. */
const pastArmDelay = () => vi.setSystemTime(Date.now() + ARM_DELAY_MS + 1);

describe('AppsApprovePage', () => {
  it('says "<appName> wants to use <connector> as you" and lists the tools', async () => {
    fetchMock.mockResolvedValueOnce(json(200, prompt()));
    render(<AppsApprovePage {...IDS} />);
    const heading = await screen.findByRole('heading', { name: 'Deal Board wants to use Linear as you' });
    // The app's name is the bold part.
    expect(within(heading).getByText('Deal Board').closest('strong')).not.toBeNull();
    // The bold name is the app's own choosing, and the page says so.
    expect(screen.getByText(APP_NAMED_ITSELF).textContent).toBe('The app chose this name.');
    // It lists what the app asks for, without promising the tools will work:
    // each call still checks the chosen agent's own policy, and the page says so.
    expect(TOOLS_ASKED).toBe("It's asking to use:");
    expect(screen.getByText(TOOLS_ASKED)).toBeTruthy();
    expect(screen.queryByText(/will be able to use/)).toBeNull();
    const list = screen.getByRole('list', { name: TOOLS_ASKED });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['list_issues', 'create_issue']);
    expect(TOOLS_NEED_ALLOW).toBe('Each tool also has to be set to Allow on the agent you pick, under Connectors.');
    const note = screen.getByText(TOOLS_NEED_ALLOW);
    // It sits with the agent choice it's about.
    expect(note.closest('fieldset')).toBe(screen.getByRole('radiogroup').closest('fieldset'));
    expect(fetchMock.mock.calls[0]?.[0]).toBe(URL_);
  });

  it('renders what the app says about itself as text, never markup', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, prompt({ appName: '<img src=x onerror=alert(1)>', tools: ['<b>x</b>'] })),
    );
    const { container } = render(<AppsApprovePage {...IDS} />);
    await screen.findByRole('heading', { name: '<img src=x onerror=alert(1)> wants to use Linear as you' });
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByText('<b>x</b>')).toBeTruthy();
  });

  it('one eligible agent is pre-selected; with several, Allow waits for a choice', async () => {
    fetchMock.mockResolvedValueOnce(json(200, prompt()));
    const one = render(<AppsApprovePage {...IDS} />);
    expect((await screen.findByRole('radio', { name: 'Scout' })).getAttribute('aria-checked')).toBe('true');
    expect(allow().hasAttribute('disabled')).toBe(false);
    one.unmount();

    fetchMock.mockResolvedValueOnce(
      json(
        200,
        prompt({
          agents: [
            { agentId: 'agt_1', displayName: 'Scout' },
            { agentId: 'agt_2', displayName: 'Ranger' },
          ],
        }),
      ),
    );
    render(<AppsApprovePage {...IDS} />);
    await screen.findByRole('radio', { name: 'Ranger' });
    for (const r of screen.getAllByRole('radio')) expect(r.getAttribute('aria-checked')).toBe('false');
    expect(allow().hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Ranger' }));
    expect(allow().hasAttribute('disabled')).toBe(false);
  });

  it('an earlier yes picks that agent again; one that is no longer eligible picks nothing', async () => {
    const two = [
      { agentId: 'agt_1', displayName: 'Scout' },
      { agentId: 'agt_2', displayName: 'Ranger' },
    ];
    fetchMock.mockResolvedValueOnce(json(200, prompt({ agents: two, approvedAgentId: 'agt_2' })));
    const before = render(<AppsApprovePage {...IDS} />);
    expect((await screen.findByRole('radio', { name: 'Ranger' })).getAttribute('aria-checked')).toBe('true');
    before.unmount();

    fetchMock.mockResolvedValueOnce(json(200, prompt({ agents: two, approvedAgentId: 'agt_gone' })));
    render(<AppsApprovePage {...IDS} />);
    await screen.findByRole('radio', { name: 'Ranger' });
    for (const r of screen.getAllByRole('radio')) expect(r.getAttribute('aria-checked')).toBe('false');
    expect(allow().hasAttribute('disabled')).toBe(true);
  });

  it('no eligible agent explains how to get one and offers no Allow', async () => {
    fetchMock.mockResolvedValueOnce(json(200, prompt({ agents: [] })));
    render(<AppsApprovePage {...IDS} />);
    const sentence = 'None of your agents has Linear yet. Add it to one of your agents, then open this link again.';
    // The connector's name is its own (isolated) run inside the sentence.
    expect(await screen.findByText((_, el) => el?.tagName === 'P' && el.textContent === sentence)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to your agents' }).getAttribute('href')).toBe('/workspace');
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('Allow sends the chosen agent with the CSRF header, then shows done', async () => {
    fetchMock.mockResolvedValueOnce(json(200, prompt())).mockResolvedValueOnce(json(200, {}));
    render(<AppsApprovePage {...IDS} />);
    await screen.findByRole('radio', { name: 'Scout' });
    pastArmDelay();
    fireEvent.click(allow());
    const done = await screen.findByText('Done. You can close this tab and go back to the app.');
    // The outcome is announced: it sits inside a status region.
    expect(done.closest('[role="status"]')).not.toBeNull();
    const sent = posts();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(URL_);
    expect((sent[0]?.init.headers as Record<string, string>)['x-requested-with']).toBe('ax-admin');
    expect(sent[0]?.init.credentials).toBe('include');
    // Exactly the tools the page showed: the server approves only those.
    expect(JSON.parse(sent[0]?.init.body as string)).toEqual({
      agentId: 'agt_1',
      tools: ['list_issues', 'create_issue'],
    });
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
  });

  it('Not now goes to the workspace and sends nothing', async () => {
    fetchMock.mockResolvedValueOnce(json(200, prompt()));
    render(<AppsApprovePage {...IDS} />);
    const notNow = await screen.findByRole('link', { name: 'Not now' });
    expect(notNow.getAttribute('href')).toBe('/workspace');
    expect(posts()).toHaveLength(0);
  });

  it('a refused yes says so and keeps the page; an ineligible agent re-reads the list', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, prompt()))
      .mockResolvedValueOnce(json(503, { error: 'unavailable' }));
    const first = render(<AppsApprovePage {...IDS} />);
    await screen.findByRole('radio', { name: 'Scout' });
    pastArmDelay();
    fireEvent.click(allow());
    expect(
      await screen.findByText("We couldn't reach the apps service just now. Nothing changed. Please try again."),
    ).toBeTruthy();
    expect(allow().hasAttribute('disabled')).toBe(false);
    first.unmount();

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(json(200, prompt()))
      .mockResolvedValueOnce(json(400, { error: 'agent-not-eligible' }))
      .mockResolvedValueOnce(json(200, prompt({ agents: [{ agentId: 'agt_3', displayName: 'Ranger' }] })));
    render(<AppsApprovePage {...IDS} />);
    await screen.findByRole('radio', { name: 'Scout' });
    pastArmDelay();
    fireEvent.click(allow());
    expect(
      await screen.findByText("That agent can't lend this connector. Pick one of your own agents that has it."),
    ).toBeTruthy();
    expect((await screen.findByRole('radio', { name: 'Ranger' })).getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByRole('radio', { name: 'Scout' })).toBeNull();
  });

  it('Allow ignores a press until the card has been in view a moment, and again after focus returns', async () => {
    fetchMock.mockResolvedValueOnce(json(200, prompt())).mockResolvedValueOnce(json(200, {}));
    render(<AppsApprovePage {...IDS} />);
    await screen.findByRole('radio', { name: 'Scout' });
    // One agent is picked already, so Allow looks live on first paint...
    expect(allow().hasAttribute('disabled')).toBe(false);
    // ...but a press inside the delay (a double-click timed to land here) does nothing.
    vi.setSystemTime(Date.now() + ARM_DELAY_MS - 50);
    fireEvent.click(allow());
    expect(posts()).toHaveLength(0);

    // The window losing and regaining focus (a popup brought forward) re-arms it.
    pastArmDelay();
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    fireEvent.click(allow());
    expect(posts()).toHaveLength(0);

    // So does the tab coming back into view.
    pastArmDelay();
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    fireEvent.click(allow());
    expect(posts()).toHaveLength(0);

    pastArmDelay();
    fireEvent.click(allow());
    expect(await screen.findByText('Done. You can close this tab and go back to the app.')).toBeTruthy();
    expect(posts()).toHaveLength(1);
  });

  it('while a refusal re-reads the prompt, the reason shows at once and Allow stays off', async () => {
    let answer: (r: Response) => void = () => undefined;
    const reread = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    fetchMock
      .mockResolvedValueOnce(json(200, prompt()))
      .mockResolvedValueOnce(json(400, { error: 'agent-not-eligible' }))
      .mockReturnValueOnce(reread);
    render(<AppsApprovePage {...IDS} />);
    await screen.findByRole('radio', { name: 'Scout' });
    pastArmDelay();
    fireEvent.click(allow());
    const why = "That agent can't lend this connector. Pick one of your own agents that has it.";
    // The old card is still up, the reason is on it, and Allow can't be pressed.
    expect(await screen.findByText(why)).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Scout' })).toBeTruthy();
    expect(allow().hasAttribute('disabled')).toBe(true);
    fireEvent.click(allow());
    expect(posts()).toHaveLength(1);

    await act(async () => {
      answer(json(200, prompt({ agents: [{ agentId: 'agt_3', displayName: 'Ranger' }] })));
      await reread;
    });
    expect((await screen.findByRole('radio', { name: 'Ranger' })).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(why)).toBeTruthy();
    expect(allow().hasAttribute('disabled')).toBe(false);
  });

  it('a 404 shows a plain not-found state', async () => {
    fetchMock.mockResolvedValueOnce(json(404, { error: 'not-found' }));
    render(<AppsApprovePage {...IDS} />);
    expect(await screen.findByText("This link doesn't work any more")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
  });

  it('a link with a bad id asks nothing of the server', async () => {
    render(<AppsApprovePage platformId="canopy" appId=".." connectorId="linear" />);
    expect(await screen.findByText("This link doesn't work any more")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('any other failure offers a retry', async () => {
    fetchMock.mockResolvedValueOnce(json(500, { error: 'internal' })).mockResolvedValueOnce(json(200, prompt()));
    render(<AppsApprovePage {...IDS} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Deal Board wants to use Linear as you' })).toBeTruthy();
  });

  it('inside a frame it asks for its own tab and offers no Allow', async () => {
    vi.spyOn(window, 'top', 'get').mockReturnValue({} as Window);
    render(<AppsApprovePage {...IDS} />);
    expect(await screen.findByText('Open this link in its own tab to continue.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses no raw colours', () => {
    const src = readFileSync(join(__dirname, '..', 'AppsApprovePage.tsx'), 'utf8')
      // Comments may name the colours they avoid.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(
      /\b(?:bg|text|border|ring|fill|stroke)-(?:red|orange|amber|yellow|green|blue|sky|indigo|violet|purple|pink|rose|slate|gray|zinc|neutral|stone|black|white)\b/,
    );
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(src).not.toMatch(/\brgb\(|\bhsl\(/);
    expect(src).not.toMatch(/dangerouslySetInnerHTML/);
  });
});
