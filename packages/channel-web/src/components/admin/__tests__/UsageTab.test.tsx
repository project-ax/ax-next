import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from '@testing-library/react';
import { UsageTab } from '../UsageTab';
import { toastActions } from '@/lib/toast-store';
import type { UsageReport, UsageUser } from '@/lib/usage-admin';

/*
  The Usage tab talks to four routes. These tests stub `fetch` at the wire (the
  same seam the real client uses) rather than mocking `lib/usage-admin`, so the
  URLs, methods, headers and bodies the tab really sends are part of what is
  being asserted.
*/

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

let calls: Call[];
let report: UsageReport;
let handler: (call: Call) => Response | Promise<Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeUser(over: Partial<UsageUser> & { userId: string }): UsageUser {
  return {
    displayName: null,
    email: null,
    turnsLastHour: 0,
    turnsLast24h: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    spendUsd: 0,
    status: 'ok',
    suspended: null,
    ...over,
  };
}

function makeReport(): UsageReport {
  return {
    windowHours: 24,
    truncated: false,
    limits: { dailySpendUsd: 5, turnsPerHour: 60, assumedTurnCostUsd: 0.25 },
    totals: { turns: 150, spendUsd: 12.86, users: 5 },
    users: [
      makeUser({
        userId: 'u-jo',
        email: 'jo@example.co',
        turnsLastHour: 60,
        turnsLast24h: 90,
        spendUsd: 5.5,
        status: 'at-limit',
      }),
      makeUser({
        userId: 'u-riley',
        displayName: 'Riley Park',
        email: 'riley@example.co',
        turnsLastHour: 10,
        turnsLast24h: 40,
        spendUsd: 4.1,
        status: 'near-limit',
      }),
      makeUser({
        userId: 'u-casey',
        displayName: 'Casey Lee',
        email: 'casey@example.co',
        turnsLastHour: 0,
        turnsLast24h: 7,
        spendUsd: 2,
        status: 'suspended',
        suspended: {
          at: '2026-09-29T09:00:00.000Z',
          by: 'admin-1',
          note: 'Runaway loop, checking in with Casey',
        },
      }),
      makeUser({
        userId: 'u-sam',
        displayName: 'Sam Chen',
        email: 'sam@example.co',
        turnsLastHour: 3,
        turnsLast24h: 12,
        spendUsd: 1.25,
      }),
      makeUser({ userId: 'u-anon', turnsLastHour: 1, turnsLast24h: 1, spendUsd: 0.01 }),
    ],
  };
}

/** Serve the current `report` for GET /admin/usage; everything else is a 404. */
function defaultHandler(call: Call): Response {
  if (call.method === 'GET' && call.path === '/admin/usage') {
    return json(200, report);
  }
  return json(404, { error: 'not-found' });
}

function installFetch(): void {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        method: init?.method ?? 'GET',
        path: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      return handler(call);
    }),
  );
}

function callsTo(method: string, path: string): Call[] {
  return calls.filter((c) => c.method === method && c.path === path);
}

let showToast: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  report = makeReport();
  handler = defaultHandler;
  installFetch();
  toastActions.reset();
  showToast = vi.spyOn(toastActions, 'show');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Render and wait for the table to appear. */
async function renderLoaded() {
  const utils = render(<UsageTab />);
  await screen.findByRole('table');
  return utils;
}

/** The table row that holds this exact text. */
function rowOf(text: string): HTMLElement {
  const row = screen.getByText(text).closest('tr');
  if (row === null) throw new Error(`no table row holds "${text}"`);
  return row;
}

function lastToast(): { title: string; detail?: string; kind?: string } {
  const args = showToast.mock.calls.at(-1)?.[0] as
    | { title: string; detail?: string; kind?: string }
    | undefined;
  if (args === undefined) throw new Error('no toast was shown');
  return args;
}

describe('UsageTab — loading, empty and failure', () => {
  it('shows a busy placeholder that a screen reader can announce while it loads', () => {
    handler = () => new Promise<Response>(() => {});
    render(<UsageTab />);
    expect(screen.getByText('Loading usage…')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('teaches, rather than shows an empty table, when nobody has used anything', async () => {
    report = {
      ...makeReport(),
      totals: { turns: 0, spendUsd: 0, users: 0 },
      users: [],
    };
    render(<UsageTab />);
    expect(await screen.findByText('No usage in the last 24 hours')).toBeInTheDocument();
    expect(
      screen.getByText("When people start chatting, they'll show up here."),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
    // The limits are still editable on a quiet day.
    expect(screen.getByLabelText('Daily spend limit per person (USD)')).toBeInTheDocument();
  });

  it('says what happened and offers Try again when the load fails, then recovers', async () => {
    let attempt = 0;
    handler = (call) => {
      if (call.method === 'GET' && call.path === '/admin/usage') {
        attempt += 1;
        return attempt === 1 ? json(500, { error: 'db-down' }) : json(200, report);
      }
      return json(404, {});
    };
    render(<UsageTab />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("We couldn't load usage just now.");
    expect(alert).toHaveTextContent('The server ran into a problem.');
    // Nothing to edit or pause when we cannot see the numbers.
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByLabelText('Daily spend limit per person (USD)')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(screen.queryByText(/couldn't load usage/i)).toBeNull();
    expect(callsTo('GET', '/admin/usage')).toHaveLength(2);
  });

  it('tells a signed-out admin to sign in rather than to retry', async () => {
    handler = () => json(401, { error: 'unauthenticated' });
    render(<UsageTab />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Your session has ended.');
    expect(alert).toHaveTextContent('Sign in again');
  });

  it('explains a network failure without printing a raw error', async () => {
    handler = () => Promise.reject(new TypeError('Failed to fetch'));
    render(<UsageTab />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("We couldn't load usage just now.");
    expect(alert).toHaveTextContent("We couldn't reach the server.");
    expect(alert).not.toHaveTextContent('Failed to fetch');
  });
});

describe('UsageTab — who used what', () => {
  it('summarises the day in one plain line', async () => {
    await renderLoaded();
    expect(
      screen.getByText('5 people, 150 messages, about $12.86 estimated'),
    ).toBeInTheDocument();
  });

  it('agrees with itself in the singular', async () => {
    report = {
      ...makeReport(),
      totals: { turns: 1, spendUsd: 0.25, users: 1 },
      users: [makeUser({ userId: 'u-sam', displayName: 'Sam Chen', turnsLast24h: 1, spendUsd: 0.25 })],
    };
    await renderLoaded();
    expect(screen.getByText('1 person, 1 message, about $0.25 estimated')).toBeInTheDocument();
  });

  it('gives the table a caption and a column for each thing an admin decides on', async () => {
    await renderLoaded();
    const table = screen.getByRole('table', {
      name: 'Estimated usage per person, last 24 hours',
    });
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers).toEqual(['Person', 'Messages', 'Estimated spend', 'Status', 'Action']);
  });

  it('lists the biggest spender first, in the order the server sent', async () => {
    await renderLoaded();
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(5);
    expect(within(rows[0]!).getByText('jo@example.co')).toBeInTheDocument();
    expect(within(rows[4]!).getByText('u-anon')).toBeInTheDocument();
  });

  it('names a person by name, then email, then id — with the email under a name', async () => {
    await renderLoaded();

    const sam = rowOf('Sam Chen');
    expect(within(sam).getByText('sam@example.co')).toBeInTheDocument();

    // No name: the email IS the name, and is not repeated underneath.
    const jo = rowOf('jo@example.co');
    expect(within(jo).getAllByText('jo@example.co')).toHaveLength(1);

    // No name and no email: fall back to the id rather than a blank cell.
    expect(within(rowOf('u-anon')).getAllByText('u-anon')).toHaveLength(1);
  });

  it('shows messages, the last-hour count, dollars and the share of the daily limit', async () => {
    await renderLoaded();

    const sam = rowOf('Sam Chen');
    expect(within(sam).getByText('12')).toBeInTheDocument();
    expect(within(sam).getByText('3 in the last hour')).toBeInTheDocument();
    expect(within(sam).getByText('$1.25')).toBeInTheDocument();
    expect(within(sam).getByText('25% of limit')).toBeInTheDocument();

    // Over the limit is shown as it is, not clamped to 100.
    expect(within(rowOf('jo@example.co')).getByText('110% of limit')).toBeInTheDocument();
    // A cent is not zero, and is not shown as if it were nothing.
    expect(within(rowOf('u-anon')).getByText('$0.01')).toBeInTheDocument();
    expect(within(rowOf('u-anon')).getByText('<1% of limit')).toBeInTheDocument();
  });

  it('says the status in words, never in colour alone', async () => {
    await renderLoaded();
    expect(within(rowOf('Sam Chen')).getByText('OK')).toBeInTheDocument();
    expect(within(rowOf('Riley Park')).getByText('Close to limit')).toBeInTheDocument();
    expect(within(rowOf('jo@example.co')).getByText('At limit')).toBeInTheDocument();
    expect(within(rowOf('Casey Lee')).getByText('Paused')).toBeInTheDocument();
  });

  it("shows why someone is paused, so the next admin doesn't have to ask", async () => {
    await renderLoaded();
    expect(
      within(rowOf('Casey Lee')).getByText('Runaway loop, checking in with Casey'),
    ).toBeInTheDocument();
  });

  it('offers Pause to everyone who is running and Resume to whoever is paused, by name', async () => {
    await renderLoaded();
    expect(screen.getByRole('button', { name: 'Pause agents for Sam Chen' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause agents for jo@example.co' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume agents for Casey Lee' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause agents for Casey Lee' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resume agents for Sam Chen' })).toBeNull();
  });

  it('says when the list was cut short', async () => {
    report = { ...makeReport(), truncated: true };
    await renderLoaded();
    expect(screen.getByText('Showing the 200 biggest users.')).toBeInTheDocument();
  });

  it('says nothing about cuts when the list is whole', async () => {
    await renderLoaded();
    expect(screen.queryByText(/biggest users/)).toBeNull();
  });

  it('Refresh reloads the numbers and keeps the table on screen while it does', async () => {
    await renderLoaded();
    expect(callsTo('GET', '/admin/usage')).toHaveLength(1);

    let release: (r: Response) => void = () => {};
    handler = () => new Promise<Response>((resolve) => (release = resolve));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByRole('button', { name: 'Refreshing…' })).toBeDisabled();
    expect(screen.getByRole('table')).toBeInTheDocument();

    release(json(200, { ...report, totals: { turns: 151, spendUsd: 12.9, users: 5 } }));
    expect(
      await screen.findByText('5 people, 151 messages, about $12.90 estimated'),
    ).toBeInTheDocument();
    expect(callsTo('GET', '/admin/usage')).toHaveLength(2);
  });
});

describe('UsageTab — the two limits', () => {
  const dailyLabel = 'Daily spend limit per person (USD)';
  const turnsLabel = 'Messages per person per hour';

  it('shows the current limits with plain-language help under each', async () => {
    await renderLoaded();
    expect(screen.getByLabelText(dailyLabel)).toHaveValue(5);
    expect(screen.getByLabelText(turnsLabel)).toHaveValue(60);
    expect(
      screen.getByText(
        "We estimate spend from how much each person's agents use, over a rolling 24 hours. At the limit, their next message waits until usage frees up.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Includes messages that scheduled routines send for them."),
    ).toBeInTheDocument();
  });

  it('keeps Save limits off until there is a valid change to save', async () => {
    await renderLoaded();
    const save = screen.getByRole('button', { name: 'Save limits' });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText(dailyLabel), { target: { value: '10' } });
    expect(save).toBeEnabled();

    // Putting it back is "no change" again.
    fireEvent.change(screen.getByLabelText(dailyLabel), { target: { value: '5' } });
    expect(save).toBeDisabled();
  });

  it('saves both limits as numbers and confirms', async () => {
    handler = (call) => {
      if (call.method === 'PUT' && call.path === '/admin/usage/limits') {
        return json(200, {
          limits: { dailySpendUsd: 12.5, turnsPerHour: 90, assumedTurnCostUsd: 0.25 },
        });
      }
      return defaultHandler(call);
    };
    await renderLoaded();

    fireEvent.change(screen.getByLabelText(dailyLabel), { target: { value: '12.5' } });
    fireEvent.change(screen.getByLabelText(turnsLabel), { target: { value: '90' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save limits' }));

    await waitFor(() => expect(callsTo('PUT', '/admin/usage/limits')).toHaveLength(1));
    const put = callsTo('PUT', '/admin/usage/limits')[0]!;
    expect(put.body).toEqual({ dailySpendUsd: 12.5, turnsPerHour: 90 });
    expect(put.headers['x-requested-with']).toBe('ax-admin');

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(lastToast().title).toBe('Limits saved');
    expect(lastToast().kind ?? 'info').toBe('info');

    // The form now IS the saved state: nothing left to save.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save limits' })).toBeDisabled());
    expect(screen.getByLabelText(dailyLabel)).toHaveValue(12.5);
    // …and the share-of-limit column uses the new limit (1.25 of 12.5 is 10%).
    expect(within(rowOf('Sam Chen')).getByText('10% of limit')).toBeInTheDocument();
  });

  it('accepts the edges of the allowed ranges', async () => {
    await renderLoaded();
    const save = screen.getByRole('button', { name: 'Save limits' });
    for (const [daily, turns] of [
      ['0.01', '1'],
      ['10000', '100000'],
    ] as const) {
      fireEvent.change(screen.getByLabelText(dailyLabel), { target: { value: daily } });
      fireEvent.change(screen.getByLabelText(turnsLabel), { target: { value: turns } });
      expect(screen.getByLabelText(dailyLabel)).not.toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByLabelText(turnsLabel)).not.toHaveAttribute('aria-invalid', 'true');
      expect(save).toBeEnabled();
    }
  });

  it.each(['0', '-3', '10000.01', ''])(
    'blocks a daily limit of "%s" and says what is allowed',
    async (bad) => {
      await renderLoaded();
      const input = screen.getByLabelText(dailyLabel);
      fireEvent.change(input, { target: { value: bad } });

      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(input.closest('[data-slot="field"]')).toHaveAttribute('data-invalid', 'true');
      expect(screen.getByText('Enter an amount between $0.01 and $10,000.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save limits' })).toBeDisabled();
    },
  );

  it.each(['0', '1.5', '100001', ''])(
    'blocks %s messages an hour and says what is allowed',
    async (bad) => {
      await renderLoaded();
      const input = screen.getByLabelText(turnsLabel);
      fireEvent.change(input, { target: { value: bad } });

      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(input.closest('[data-slot="field"]')).toHaveAttribute('data-invalid', 'true');
      expect(
        screen.getByText('Enter a whole number between 1 and 100,000.'),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save limits' })).toBeDisabled();
    },
  );

  it('does not send anything while a field is invalid, even on Enter', async () => {
    await renderLoaded();
    fireEvent.change(screen.getByLabelText(dailyLabel), { target: { value: '0' } });
    fireEvent.submit(screen.getByLabelText(dailyLabel).closest('form')!);
    await Promise.resolve();
    expect(callsTo('PUT', '/admin/usage/limits')).toHaveLength(0);
  });

  it('points at the field with its message, for people who cannot see the red', async () => {
    await renderLoaded();
    const input = screen.getByLabelText(dailyLabel);
    fireEvent.change(input, { target: { value: '0' } });
    const error = screen.getByText('Enter an amount between $0.01 and $10,000.');
    expect(input.getAttribute('aria-describedby') ?? '').toContain(error.id);
    expect(error.id).not.toBe('');
  });

  it('shows the server\'s reason when a save is refused, and keeps what was typed', async () => {
    handler = (call) => {
      if (call.method === 'PUT' && call.path === '/admin/usage/limits') {
        return json(400, { error: 'invalid-limits' });
      }
      return defaultHandler(call);
    };
    await renderLoaded();

    fireEvent.change(screen.getByLabelText(dailyLabel), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save limits' }));

    const alert = await screen.findByText(/We couldn't save those limits\./);
    expect(alert.closest('[role="alert"]')).toBeInTheDocument();
    expect(alert).toHaveTextContent('$0.01 to $10,000');
    expect(screen.getByLabelText(dailyLabel)).toHaveValue(20);
    expect(showToast).not.toHaveBeenCalled();
    // Still saveable once they fix it.
    expect(screen.getByRole('button', { name: 'Save limits' })).toBeEnabled();
  });

  it('explains an outage on save without a raw code', async () => {
    handler = (call) => {
      if (call.method === 'PUT' && call.path === '/admin/usage/limits') {
        return json(500, { error: 'boom' });
      }
      return defaultHandler(call);
    };
    await renderLoaded();
    fireEvent.change(screen.getByLabelText(dailyLabel), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save limits' }));

    const alert = await screen.findByText(/We couldn't save your changes\./);
    expect(alert).toHaveTextContent('Nothing was changed.');
    expect(alert).toHaveTextContent('The server ran into a problem.');
    expect(alert).toHaveTextContent('Try again in a moment.');
    expect(alert).not.toHaveTextContent('boom');
  });
});

describe('UsageTab — pausing someone', () => {
  function suspendedReply(interrupted: number, note: string | null) {
    return json(200, {
      suspended: { at: '2026-09-29T10:00:00.000Z', by: 'admin-1', note },
      interrupted,
    });
  }

  async function openPauseDialog(name: string) {
    fireEvent.click(screen.getByRole('button', { name: `Pause agents for ${name}` }));
    return screen.findByRole('dialog', { name: `Pause agents for ${name}?` });
  }

  it('asks first, in plain words, and says it can be undone', async () => {
    await renderLoaded();
    const dialog = await openPauseDialog('Sam Chen');
    expect(
      within(dialog).getByText(
        "We'll stop anything they have running and hold their new messages until you resume them. You can undo this at any time.",
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Reason (only admins see this)')).toBeInTheDocument();
    // Nothing happens until they confirm.
    expect(callsTo('PUT', '/admin/usage/users/u-sam/suspension')).toHaveLength(0);
  });

  it('changes nothing when they cancel', async () => {
    await renderLoaded();
    const dialog = await openPauseDialog('Sam Chen');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
    expect(within(rowOf('Sam Chen')).getByText('OK')).toBeInTheDocument();
  });

  it('pauses with the reason, flips the row, and says how many running tasks it stopped', async () => {
    handler = (call) =>
      call.method === 'PUT' && call.path === '/admin/usage/users/u-sam/suspension'
        ? suspendedReply(2, 'Loop on the billing agent')
        : defaultHandler(call);
    await renderLoaded();

    const dialog = await openPauseDialog('Sam Chen');
    fireEvent.change(within(dialog).getByLabelText('Reason (only admins see this)'), {
      target: { value: 'Loop on the billing agent' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Pause agents' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const put = callsTo('PUT', '/admin/usage/users/u-sam/suspension')[0]!;
    expect(put.body).toEqual({ note: 'Loop on the billing agent' });
    expect(put.headers['x-requested-with']).toBe('ax-admin');

    const sam = rowOf('Sam Chen');
    expect(within(sam).getByText('Paused')).toBeInTheDocument();
    expect(within(sam).queryByText('OK')).toBeNull();
    expect(within(sam).getByText('Loop on the billing agent')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume agents for Sam Chen' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause agents for Sam Chen' })).toBeNull();

    expect(lastToast().title).toBe('Paused. Stopped 2 running tasks.');
  });

  it('sends no note when the reason is left blank', async () => {
    handler = (call) =>
      call.method === 'PUT' && call.path === '/admin/usage/users/u-sam/suspension'
        ? suspendedReply(0, null)
        : defaultHandler(call);
    await renderLoaded();

    const dialog = await openPauseDialog('Sam Chen');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Pause agents' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(callsTo('PUT', '/admin/usage/users/u-sam/suspension')[0]!.body).toEqual({});
    expect(lastToast().title).toBe('Paused. Nothing was running.');
  });

  it('says "1 running task" in the singular', async () => {
    handler = (call) =>
      call.method === 'PUT' && call.path === '/admin/usage/users/u-sam/suspension'
        ? suspendedReply(1, null)
        : defaultHandler(call);
    await renderLoaded();
    const dialog = await openPauseDialog('Sam Chen');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Pause agents' }));
    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(lastToast().title).toBe('Paused. Stopped 1 running task.');
  });

  it('addresses the right person by their id, even when the id needs escaping', async () => {
    report = {
      ...makeReport(),
      users: [makeUser({ userId: 'org/a b', displayName: 'Odd Id', turnsLast24h: 1 })],
      totals: { turns: 1, spendUsd: 0, users: 1 },
    };
    handler = (call) =>
      call.method === 'PUT' ? suspendedReply(0, null) : defaultHandler(call);
    await renderLoaded();

    const dialog = await openPauseDialog('Odd Id');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Pause agents' }));
    await waitFor(() =>
      expect(callsTo('PUT', '/admin/usage/users/org%2Fa%20b/suspension')).toHaveLength(1),
    );
  });

  it("won't let an admin pause themselves — and says who can", async () => {
    handler = (call) =>
      call.method === 'PUT' ? json(400, { error: 'cannot-suspend-self' }) : defaultHandler(call);
    await renderLoaded();

    const dialog = await openPauseDialog('Sam Chen');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Pause agents' }));

    expect(
      await within(dialog).findByText(
        "You can't pause your own agents. Ask another admin to do it.",
      ),
    ).toBeInTheDocument();
    // The dialog stays put so the sentence can be read; the row is untouched.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(within(rowOf('Sam Chen')).getByText('OK')).toBeInTheDocument();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('keeps the dialog open with a plain explanation when the server has a problem', async () => {
    handler = (call) => (call.method === 'PUT' ? json(500, {}) : defaultHandler(call));
    await renderLoaded();

    const dialog = await openPauseDialog('Sam Chen');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Pause agents' }));

    const message = await within(dialog).findByText(/We couldn't pause Sam Chen's agents\./);
    expect(message).toHaveTextContent('Nothing was changed.');
    expect(message).toHaveTextContent('The server ran into a problem.');
    expect(message).toHaveTextContent('Try again in a moment.');
    expect(within(rowOf('Sam Chen')).getByText('OK')).toBeInTheDocument();
  });

  it('forgets the last reason and error when the dialog is opened for someone else', async () => {
    handler = (call) => (call.method === 'PUT' ? json(500, {}) : defaultHandler(call));
    await renderLoaded();

    let dialog = await openPauseDialog('Sam Chen');
    fireEvent.change(within(dialog).getByLabelText('Reason (only admins see this)'), {
      target: { value: 'first reason' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Pause agents' }));
    await within(dialog).findByText(/We couldn't pause Sam Chen's agents\./);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    dialog = await openPauseDialog('Riley Park');
    expect(within(dialog).getByLabelText('Reason (only admins see this)')).toHaveValue('');
    expect(within(dialog).queryByText(/We couldn't pause/)).toBeNull();
  });

  it('limits the reason to what the server accepts', async () => {
    await renderLoaded();
    const dialog = await openPauseDialog('Sam Chen');
    expect(within(dialog).getByLabelText('Reason (only admins see this)')).toHaveAttribute(
      'maxlength',
      '200',
    );
  });
});

describe('UsageTab — resuming someone', () => {
  function resumeHandler(after: (r: UsageReport) => void): (call: Call) => Response {
    return (call) => {
      if (call.method === 'DELETE' && call.path === '/admin/usage/users/u-casey/suspension') {
        after(report);
        return json(200, { suspended: null });
      }
      return defaultHandler(call);
    };
  }

  it('resumes on one click, no ceremony, and confirms', async () => {
    handler = resumeHandler((r) => {
      const casey = r.users.find((u) => u.userId === 'u-casey')!;
      casey.status = 'ok';
      casey.suspended = null;
    });
    await renderLoaded();

    fireEvent.click(screen.getByRole('button', { name: 'Resume agents for Casey Lee' }));

    await waitFor(() =>
      expect(callsTo('DELETE', '/admin/usage/users/u-casey/suspension')).toHaveLength(1),
    );
    const del = callsTo('DELETE', '/admin/usage/users/u-casey/suspension')[0]!;
    expect(del.headers['x-requested-with']).toBe('ax-admin');
    expect(screen.queryByRole('dialog')).toBeNull();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Pause agents for Casey Lee' })).toBeInTheDocument(),
    );
    const casey = rowOf('Casey Lee');
    expect(within(casey).queryByText('Paused')).toBeNull();
    expect(within(casey).queryByText('Runaway loop, checking in with Casey')).toBeNull();
    expect(within(casey).getByText('OK')).toBeInTheDocument();
    expect(lastToast().title).toBe('Resumed agents for Casey Lee.');
  });

  it("shows the server's view of the status once it has re-read the numbers", async () => {
    // Resumed, but they are still close to the limit: the second read says so.
    handler = resumeHandler((r) => {
      const casey = r.users.find((u) => u.userId === 'u-casey')!;
      casey.status = 'near-limit';
      casey.suspended = null;
    });
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Resume agents for Casey Lee' }));

    await waitFor(() =>
      expect(within(rowOf('Casey Lee')).getByText('Close to limit')).toBeInTheDocument(),
    );
    expect(callsTo('GET', '/admin/usage')).toHaveLength(2);
  });

  it('disables the button while it works so it cannot be sent twice', async () => {
    let release: (r: Response) => void = () => {};
    handler = (call) =>
      call.method === 'DELETE'
        ? new Promise<Response>((resolve) => (release = resolve))
        : defaultHandler(call);
    await renderLoaded();

    fireEvent.click(screen.getByRole('button', { name: 'Resume agents for Casey Lee' }));
    const busy = await screen.findByRole('button', { name: 'Resume agents for Casey Lee' });
    expect(busy).toBeDisabled();
    expect(busy).toHaveTextContent('Resuming…');

    release(json(200, { suspended: null }));
    await waitFor(() => expect(showToast).toHaveBeenCalled());
  });

  it('says what happened, and that they are still paused, when resuming fails', async () => {
    handler = (call) => (call.method === 'DELETE' ? json(500, {}) : defaultHandler(call));
    await renderLoaded();

    fireEvent.click(screen.getByRole('button', { name: 'Resume agents for Casey Lee' }));

    const alert = await screen.findByText(/We couldn't resume Casey Lee's agents\./);
    expect(alert.closest('[role="alert"]')).toBeInTheDocument();
    expect(alert).toHaveTextContent('They are still paused.');
    expect(alert).toHaveTextContent('Try again in a moment.');
    expect(within(rowOf('Casey Lee')).getByText('Paused')).toBeInTheDocument();
    expect(showToast).not.toHaveBeenCalled();
  });
});
