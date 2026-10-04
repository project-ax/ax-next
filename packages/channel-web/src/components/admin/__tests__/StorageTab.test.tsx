import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { StorageTab } from '../StorageTab';
import { toastActions } from '@/lib/toast-store';
import type { AdminStorage, MyStorage, StorageOwner } from '@/lib/storage-api';

/*
  The Storage tab talks to four routes: three in `@ax/disk-quota`, and the
  report-only "files no longer used" line from `@ax/blob-gc`. These tests stub
  `fetch` at the wire (the seam the real client uses) rather than mocking
  `lib/storage-api`, so the URLs, methods, headers and bodies the tab really
  sends are part of what is being asserted, and so is the thing a non-admin
  must NOT send: a request to /admin/storage or /admin/storage/cleanup.
*/

const MB = 1_048_576;
const GB = 1024 * MB;

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

let calls: Call[];
let mine: MyStorage;
let admin: AdminStorage;
/** The body of `GET /admin/storage/cleanup`. The tab reads only its `report`. */
let cleanup: unknown;
let handler: (call: Call) => Response | Promise<Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeMine(over: Partial<MyStorage> = {}): MyStorage {
  return {
    usedBytes: Math.round(2.3 * GB),
    limitBytes: 5 * GB,
    warnBytes: 4 * GB,
    workspaceBytes: 2 * GB,
    fileBytes: Math.round(0.3 * GB),
    status: 'ok',
    ...over,
  };
}

function makeOwner(over: Partial<StorageOwner> & { ownerId: string }): StorageOwner {
  return {
    kind: 'person',
    displayName: null,
    email: null,
    usedBytes: 0,
    workspaceBytes: 0,
    fileBytes: 0,
    status: 'ok',
    ...over,
  };
}

function makeAdmin(over: Partial<AdminStorage> = {}): AdminStorage {
  return {
    limits: { limitMb: 1024, warnPercent: 80 },
    defaults: { limitMb: 1024, warnPercent: 80 },
    bounds: {
      limitMb: { min: 64, max: 10_485_760 },
      warnPercent: { min: 1, max: 99 },
    },
    owners: [
      makeOwner({
        ownerId: 'u-jo',
        email: 'jo@example.co',
        usedBytes: 1100 * MB,
        workspaceBytes: 1000 * MB,
        fileBytes: 100 * MB,
        status: 'full',
      }),
      makeOwner({
        ownerId: 'u-riley',
        displayName: 'Riley Park',
        email: 'riley@example.co',
        usedBytes: 900 * MB,
        workspaceBytes: 800 * MB,
        fileBytes: 100 * MB,
        status: 'near-limit',
      }),
      makeOwner({
        ownerId: 'team:t-ops',
        kind: 'team',
        displayName: 'Ops team',
        usedBytes: 256 * MB,
        workspaceBytes: 256 * MB,
        fileBytes: 0,
        status: 'ok',
      }),
      makeOwner({
        ownerId: 'u-anon',
        usedBytes: 1,
        workspaceBytes: 1,
        fileBytes: 0,
      }),
    ],
    ownerCount: 4,
    totalBytes: 2256 * MB + 1,
    ...over,
  };
}

/**
 * What `@ax/blob-gc` answers after a sweep has finished: 12 files, 123,456
 * bytes. `null` is the answer before the first complete sweep.
 */
function makeCleanup(report: Record<string, unknown> | null = {}): unknown {
  return {
    settings: { mode: 'report', graceMs: 86_400_000, retentionMs: 604_800_000 },
    defaults: { mode: 'report', graceMs: 86_400_000, retentionMs: 604_800_000 },
    bounds: {
      graceMs: { min: 60_000, max: 2_592_000_000 },
      retentionMs: { min: 3_600_000, max: 31_536_000_000 },
    },
    report:
      report === null
        ? null
        : {
            at: '2026-10-04T10:00:00.000Z',
            mode: 'report',
            discovered: 40,
            candidates: 20,
            held: 8,
            wouldRetire: 12,
            wouldRetireBytes: 123_456,
            perHolder: { '@ax/attachments': 3 },
            ...report,
          },
  };
}

/** Serve the current `mine` / `admin` / `cleanup` for the reads; everything else is a 404. */
function defaultHandler(call: Call): Response {
  if (call.method === 'GET' && call.path === '/settings/storage') return json(200, mine);
  if (call.method === 'GET' && call.path === '/admin/storage') return json(200, admin);
  if (call.method === 'GET' && call.path === '/admin/storage/cleanup') return json(200, cleanup);
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
  mine = makeMine();
  admin = makeAdmin();
  cleanup = makeCleanup();
  handler = defaultHandler;
  installFetch();
  toastActions.reset();
  showToast = vi.spyOn(toastActions, 'show');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function lastToast(): { title: string; detail?: string; kind?: string } {
  const args = showToast.mock.calls.at(-1)?.[0] as
    | { title: string; detail?: string; kind?: string }
    | undefined;
  if (args === undefined) throw new Error('no toast was shown');
  return args;
}

/** The person's own card: everything between its title and the next card. */
function myCard(): HTMLElement {
  const title = screen.getByRole('heading', { name: 'Your storage' });
  const card = title.closest('.rounded-lg');
  if (!(card instanceof HTMLElement)) throw new Error('no card around "Your storage"');
  return card;
}

async function renderPerson() {
  const utils = render(<StorageTab isAdmin={false} />);
  await screen.findByText(/of .* used/);
  return utils;
}

async function renderAdmin() {
  const utils = render(<StorageTab isAdmin />);
  await screen.findByRole('table');
  return utils;
}

/** The table row that holds this exact text. */
function rowOf(text: string): HTMLElement {
  const row = screen.getByText(text).closest('tr');
  if (row === null) throw new Error(`no table row holds "${text}"`);
  return row;
}

describe('StorageTab — Your storage, for everyone', () => {
  it('shows a busy placeholder that a screen reader can announce while it loads', () => {
    handler = () => new Promise<Response>(() => {});
    render(<StorageTab isAdmin={false} />);
    expect(screen.getByText('Loading your storage…')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).toBeNull();
    // The card keeps its title while it loads, so the page does not jump.
    expect(screen.getByRole('heading', { name: 'Your storage' })).toBeInTheDocument();
  });

  it('says how much of how much is used, with a bar that agrees', async () => {
    await renderPerson();
    expect(screen.getByText('2.3 GB of 5 GB used')).toBeInTheDocument();

    const bar = screen.getByRole('progressbar', { name: 'Storage used' });
    expect(bar).toHaveAttribute('aria-valuemax', String(5 * GB));
    expect(bar).toHaveAttribute('aria-valuenow', String(mine.usedBytes));
    // A screen reader hears the same sentence a sighted person reads.
    expect(bar).toHaveAttribute('aria-valuetext', '2.3 GB of 5 GB used');
  });

  it('breaks it into agent files and uploads and published files', async () => {
    await renderPerson();
    const card = within(myCard());
    expect(card.getByText('Agent files')).toBeInTheDocument();
    expect(card.getByText('2 GB')).toBeInTheDocument();
    expect(card.getByText('Uploads and published files')).toBeInTheDocument();
    expect(card.getByText('307.2 MB')).toBeInTheDocument();
  });

  it('adds nothing when all is well', async () => {
    await renderPerson();
    expect(within(myCard()).queryByRole('alert')).toBeNull();
  });

  it('warns kindly, and truthfully, when they are getting close', async () => {
    mine = makeMine({ usedBytes: Math.round(4.2 * GB), status: 'near-limit' });
    await renderPerson();
    const alert = within(myCard()).getByRole('alert');
    expect(alert).toHaveTextContent("You're getting close to your limit");
    expect(alert).toHaveTextContent("new file changes and uploads won't be saved");
    expect(alert).toHaveTextContent('Ask an admin for more room');
    // The default register: a heads-up, not an emergency.
    expect(alert).not.toHaveClass('text-destructive');
  });

  it('says plainly that nothing new can be saved when it is full', async () => {
    mine = makeMine({ usedBytes: 5 * GB, status: 'full' });
    await renderPerson();
    const alert = within(myCard()).getByRole('alert');
    expect(alert).toHaveTextContent('Your storage is full');
    expect(alert).toHaveTextContent('Nothing new can be saved');
    expect(alert).toHaveTextContent('Ask an admin for more room');
    expect(alert).toHaveClass('text-destructive');
  });

  it('never tells anyone to delete anything, because no small chore gives room back', async () => {
    for (const status of ['near-limit', 'full'] as const) {
      mine = makeMine({ usedBytes: 5 * GB, status });
      const { unmount } = await renderPerson();
      expect(myCard().textContent ?? '').not.toMatch(/delet|remov|clean|free up|make space/i);
      unmount();
    }
  });

  it('shows a full bar, not an overflowing one, when they are over the limit', async () => {
    mine = makeMine({ usedBytes: 6 * GB, status: 'full' });
    await renderPerson();
    expect(screen.getByText('6 GB of 5 GB used')).toBeInTheDocument();
    const bar = screen.getByRole('progressbar', { name: 'Storage used' });
    // `Progress` clamps to its own max: the bar tops out at the end of the track.
    expect(bar).toHaveAttribute('aria-valuenow', String(5 * GB));
  });

  it('does not break on a limit of zero', async () => {
    mine = makeMine({ usedBytes: 0, limitBytes: 0, warnBytes: 0, workspaceBytes: 0, fileBytes: 0 });
    await renderPerson();
    expect(screen.getByText('0 B of 0 B used')).toBeInTheDocument();
  });

  it('says what happened and offers Try again when the load fails, then recovers', async () => {
    let attempt = 0;
    handler = (call) => {
      if (call.method === 'GET' && call.path === '/settings/storage') {
        attempt += 1;
        return attempt === 1 ? json(500, { error: 'db-down' }) : json(200, mine);
      }
      return json(404, {});
    };
    render(<StorageTab isAdmin={false} />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("We couldn't load your storage just now.");
    expect(alert).toHaveTextContent('The server ran into a problem.');
    // The raw code stays off the screen.
    expect(alert).not.toHaveTextContent('db-down');
    expect(screen.queryByRole('progressbar')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('2.3 GB of 5 GB used')).toBeInTheDocument();
    expect(screen.queryByText(/couldn't load your storage/i)).toBeNull();
    expect(callsTo('GET', '/settings/storage')).toHaveLength(2);
  });

  it('tells a signed-out person to sign in rather than to retry', async () => {
    handler = () => json(401, { error: 'unauthenticated' });
    render(<StorageTab isAdmin={false} />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Your session has ended.');
    expect(alert).toHaveTextContent('Sign in again');
  });

  it('explains a network failure without printing a raw error', async () => {
    handler = () => Promise.reject(new TypeError('Failed to fetch'));
    render(<StorageTab isAdmin={false} />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("We couldn't reach the server.");
    expect(alert).not.toHaveTextContent('Failed to fetch');
  });

  it('does not draw numbers from a 200 that is not a storage reading', async () => {
    handler = () => json(200, { hello: 'world' });
    render(<StorageTab isAdmin={false} />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("something we didn't expect");
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByText(/NaN|undefined/)).toBeNull();
  });
});

describe('StorageTab — someone who is not an admin', () => {
  it('reads their own storage and never asks for the admin report', async () => {
    await renderPerson();
    // Give any stray effect a chance to fire before we look.
    await new Promise((r) => setTimeout(r, 0));
    expect(callsTo('GET', '/settings/storage')).toHaveLength(1);
    expect(calls.filter((c) => c.path.startsWith('/admin'))).toEqual([]);
  });

  it('never asks which files nobody uses any more, and is not told', async () => {
    await renderPerson();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.filter((c) => c.path === '/admin/storage/cleanup')).toEqual([]);
    expect(screen.queryByText(/no longer used by anyone/i)).toBeNull();
  });

  it('is not shown the limits form or everyone else\'s storage', async () => {
    await renderPerson();
    expect(screen.queryByRole('heading', { name: 'Storage limits' })).toBeNull();
    expect(screen.queryByRole('heading', { name: "Everyone's storage" })).toBeNull();
    expect(screen.queryByLabelText('Limit per person (MB)')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('StorageTab — an admin also sees the limits and everyone', () => {
  it('reads both reports, and shows the personal card first', async () => {
    await renderAdmin();
    expect(callsTo('GET', '/settings/storage')).toHaveLength(1);
    expect(callsTo('GET', '/admin/storage')).toHaveLength(1);
    const titles = screen
      .getAllByRole('heading')
      .map((h) => h.textContent);
    expect(titles).toEqual(['Your storage', 'Storage limits', "Everyone's storage"]);
  });

  describe('everyone\'s storage', () => {
    it('summarises the total in one plain line', async () => {
      await renderAdmin();
      expect(screen.getByText('4 people and teams, 2.2 GB in total')).toBeInTheDocument();
    });

    it('gives the table a caption and a column for each thing an admin looks at', async () => {
      await renderAdmin();
      const table = screen.getByRole('table', {
        name: 'Storage used by each person or team, biggest first',
      });
      const headers = within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent);
      expect(headers).toEqual(['Person or team', 'Storage used', 'Status']);
    });

    it('lists the biggest first, in the order the server sent', async () => {
      await renderAdmin();
      const rows = screen.getAllByRole('row').slice(1);
      expect(rows).toHaveLength(4);
      expect(within(rows[0]!).getByText('jo@example.co')).toBeInTheDocument();
      expect(within(rows[3]!).getByText('u-anon')).toBeInTheDocument();
    });

    it('names an owner by name, then email, then id — with the email under a name', async () => {
      await renderAdmin();
      const riley = rowOf('Riley Park');
      expect(within(riley).getByText('riley@example.co')).toBeInTheDocument();
      // No name: the email IS the name, and is not repeated underneath.
      expect(within(rowOf('jo@example.co')).getAllByText('jo@example.co')).toHaveLength(1);
      // No name and no email: the raw id, rather than a blank cell.
      expect(within(rowOf('u-anon')).getAllByText('u-anon')).toHaveLength(1);
    });

    it('marks team rows with a Team badge and nobody else', async () => {
      await renderAdmin();
      expect(within(rowOf('Ops team')).getByText('Team')).toBeInTheDocument();
      expect(within(rowOf('Riley Park')).queryByText('Team')).toBeNull();
      expect(within(rowOf('u-anon')).queryByText('Team')).toBeNull();
    });

    it('shows how much each uses, of what kind, and against the limit', async () => {
      await renderAdmin();
      const riley = rowOf('Riley Park');
      expect(within(riley).getByText('900 MB')).toBeInTheDocument();
      expect(within(riley).getByText('800 MB agent files, 100 MB uploads')).toBeInTheDocument();
      // 900 of 1,024 MB.
      expect(within(riley).getByText('88% of limit')).toBeInTheDocument();
      // Over the limit is shown as it is, not clamped to 100.
      expect(within(rowOf('jo@example.co')).getByText('107% of limit')).toBeInTheDocument();
      // A single byte is not nothing, and is not shown as if it were.
      expect(within(rowOf('u-anon')).getByText('1 B')).toBeInTheDocument();
      expect(within(rowOf('u-anon')).getByText('<1% of limit')).toBeInTheDocument();
    });

    it('says the status in words, never in colour alone', async () => {
      await renderAdmin();
      expect(within(rowOf('jo@example.co')).getByText('Full')).toBeInTheDocument();
      expect(within(rowOf('Riley Park')).getByText('Close to limit')).toBeInTheDocument();
      expect(within(rowOf('Ops team')).getByText('OK')).toBeInTheDocument();
    });

    it('says when the list was cut short', async () => {
      admin = makeAdmin({ ownerCount: 250 });
      await renderAdmin();
      expect(screen.getByText('Showing the 4 biggest of 250.')).toBeInTheDocument();
    });

    it('says nothing about cuts when the list is whole', async () => {
      await renderAdmin();
      expect(screen.queryByText(/Showing the/)).toBeNull();
    });

    it('teaches, rather than showing an empty table, when nobody has stored anything', async () => {
      admin = makeAdmin({ owners: [], ownerCount: 0, totalBytes: 0 });
      render(<StorageTab isAdmin />);
      expect(await screen.findByText('No storage used yet')).toBeInTheDocument();
      expect(
        screen.getByText("When people start saving files and uploads, they'll show up here."),
      ).toBeInTheDocument();
      expect(screen.queryByRole('table')).toBeNull();
      // The limits are still editable on a quiet day.
      expect(screen.getByLabelText('Limit per person (MB)')).toBeInTheDocument();
    });
  });

  describe('files no longer used by anyone (report only)', () => {
    const LINE = 'Files no longer used by anyone: 12 (120.6 KB). Not removed yet.';
    const FAILED = "We couldn't check for files no longer in use just now.";

    /** The "Everyone's storage" card: its title up to the next card. */
    function everyoneCard(): HTMLElement {
      const title = screen.getByRole('heading', { name: "Everyone's storage" });
      const card = title.closest('.rounded-lg');
      if (!(card instanceof HTMLElement)) throw new Error('no card around "Everyone\'s storage"');
      return card;
    }

    it('says how many files and how much room, and that nothing is removed yet', async () => {
      await renderAdmin();
      const line = await screen.findByText(LINE);
      expect(callsTo('GET', '/admin/storage/cleanup')).toHaveLength(1);
      // A small muted aside at the foot of the card, not a heading or an alert.
      expect(everyoneCard()).toContainElement(line);
      expect(line).toHaveClass('text-sm', 'text-muted-foreground');
      expect(line.tagName).toBe('P');
      expect(within(everyoneCard()).queryByRole('alert')).toBeNull();
    });

    it('sits after the table, at the bottom of the card', async () => {
      await renderAdmin();
      const line = await screen.findByText(LINE);
      const table = within(everyoneCard()).getByRole('table');
      expect(table.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      // The last thing in the card's content, with nothing after it.
      expect(line.nextElementSibling).toBeNull();
      expect(line.parentElement?.parentElement).toBe(everyoneCard());
    });

    it('reads the same when there is one file, and groups a big count', async () => {
      cleanup = makeCleanup({ wouldRetire: 1, wouldRetireBytes: 2048 });
      const { unmount } = await renderAdmin();
      expect(
        await screen.findByText('Files no longer used by anyone: 1 (2 KB). Not removed yet.'),
      ).toBeInTheDocument();
      unmount();

      cleanup = makeCleanup({ wouldRetire: 1234567, wouldRetireBytes: 5 * GB });
      await renderAdmin();
      expect(
        await screen.findByText('Files no longer used by anyone: 1,234,567 (5 GB). Not removed yet.'),
      ).toBeInTheDocument();
    });

    it('says zero as zero', async () => {
      cleanup = makeCleanup({ wouldRetire: 0, wouldRetireBytes: 0 });
      await renderAdmin();
      expect(
        await screen.findByText('Files no longer used by anyone: 0 (0 B). Not removed yet.'),
      ).toBeInTheDocument();
    });

    it('says it has not looked yet when no sweep has finished', async () => {
      cleanup = makeCleanup(null);
      await renderAdmin();
      expect(
        await screen.findByText('Files no longer used by anyone: not checked yet.'),
      ).toBeInTheDocument();
      expect(screen.queryByText(/Not removed yet/)).toBeNull();
    });

    it('shows nothing about it while it loads, and does not hold the rest of the card back', async () => {
      handler = (call) =>
        call.path === '/admin/storage/cleanup' ? new Promise<Response>(() => {}) : defaultHandler(call);
      await renderAdmin();
      expect(screen.queryByText(/no longer used by anyone/i)).toBeNull();
      expect(screen.queryByText(FAILED)).toBeNull();
      expect(within(everyoneCard()).getByRole('table')).toBeInTheDocument();
    });

    it('asks while the owners list is still loading, so the two reads run side by side', async () => {
      handler = (call) =>
        call.path === '/admin/storage' ? new Promise<Response>(() => {}) : defaultHandler(call);
      render(<StorageTab isAdmin />);
      expect(await screen.findByText(LINE)).toBeInTheDocument();
      expect(screen.getByText("Loading everyone's storage…")).toBeInTheDocument();
    });

    it('keeps the rest of the tab working, and says so quietly, when the check fails', async () => {
      handler = (call) =>
        call.path === '/admin/storage/cleanup' ? json(500, { error: 'db-down' }) : defaultHandler(call);
      await renderAdmin();

      const sentence = await screen.findByText(FAILED);
      expect(sentence).toHaveClass('text-sm', 'text-muted-foreground');
      // Quiet: no alert, no retry button, no code, no reason.
      expect(sentence.closest('[role="alert"]')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
      expect(sentence).not.toHaveTextContent('db-down');
      expect(sentence).not.toHaveTextContent('server ran into a problem');
      // Everything else is as it was.
      expect(within(everyoneCard()).getByRole('table')).toBeInTheDocument();
      expect(screen.getByText('4 people and teams, 2.2 GB in total')).toBeInTheDocument();
      expect(screen.getByLabelText('Limit per person (MB)')).toBeInTheDocument();
      expect(screen.getByText('2.3 GB of 5 GB used')).toBeInTheDocument();
      expect(screen.queryByText(/Not removed yet/)).toBeNull();
    });

    it.each([
      ['a request that never reaches the server', () => Promise.reject(new TypeError('Failed to fetch'))],
      ['a 200 that is not a report', () => json(200, { hello: 'world' })],
      ['a count that is not a number', () => json(200, makeCleanup({ wouldRetire: 'lots' }))],
    ])('says the same quiet sentence for %s', async (_name, answer) => {
      handler = (call) => (call.path === '/admin/storage/cleanup' ? answer() : defaultHandler(call));
      await renderAdmin();
      expect(await screen.findByText(FAILED)).toBeInTheDocument();
      expect(screen.queryByText(/NaN|undefined|Failed to fetch/)).toBeNull();
    });

    it('does not touch the admin report: the limits still load when this read is refused', async () => {
      handler = (call) =>
        call.path === '/admin/storage/cleanup' ? json(403, { error: 'forbidden' }) : defaultHandler(call);
      await renderAdmin();
      await screen.findByText(FAILED);
      expect(callsTo('GET', '/admin/storage')).toHaveLength(1);
      expect(screen.queryByText(/couldn't load the storage limits/i)).toBeNull();
    });

    it('only reads it; nothing here can start a removal', async () => {
      await renderAdmin();
      await screen.findByText(LINE);
      expect(calls.filter((c) => c.path === '/admin/storage/cleanup').map((c) => c.method)).toEqual(['GET']);
      expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
    });

    it('is still there on a quiet day, under the empty state', async () => {
      admin = makeAdmin({ owners: [], ownerCount: 0, totalBytes: 0 });
      render(<StorageTab isAdmin />);
      expect(await screen.findByText('No storage used yet')).toBeInTheDocument();
      expect(await screen.findByText(LINE)).toBeInTheDocument();
    });
  });

  describe('the limits form', () => {
    const limitLabel = 'Limit per person (MB)';
    const warnLabel = 'Show the "getting full" notice at (%)';

    function respondToSave(saved: { limitMb: number; warnPercent: number }) {
      handler = (call) => {
        if (call.method === 'PUT' && call.path === '/admin/storage/limits') {
          // The server now uses the new numbers for everything it reports.
          admin = makeAdmin({ limits: saved });
          mine = makeMine({
            limitBytes: saved.limitMb * MB,
            warnBytes: Math.floor((saved.limitMb * MB * saved.warnPercent) / 100),
          });
          return json(200, { limits: saved });
        }
        return defaultHandler(call);
      };
    }

    it('shows the current limits with plain-language help under each', async () => {
      await renderAdmin();
      expect(screen.getByLabelText(limitLabel)).toHaveValue(1024);
      expect(screen.getByLabelText(warnLabel)).toHaveValue(80);
      expect(
        screen.getByText(
          "This is the most a person can store. It counts their agents' files and their uploads together, and a team counts as one person. Changes apply right away.",
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          "Once someone has used this much of their limit, they see a notice that they're getting close.",
        ),
      ).toBeInTheDocument();
      // The MB box is awkward for big numbers; say what it comes to.
      expect(screen.getByText("That's 1 GB per person.")).toBeInTheDocument();
    });

    it('keeps Save off until there is a valid change to save', async () => {
      await renderAdmin();
      const save = screen.getByRole('button', { name: 'Save limits' });
      expect(save).toBeDisabled();

      fireEvent.change(screen.getByLabelText(limitLabel), { target: { value: '2048' } });
      expect(save).toBeEnabled();
      expect(screen.getByText("That's 2 GB per person.")).toBeInTheDocument();

      // Putting it back is "no change" again.
      fireEvent.change(screen.getByLabelText(limitLabel), { target: { value: '1024' } });
      expect(save).toBeDisabled();
    });

    it('saves only what changed, tells the admin, and refreshes every number on screen', async () => {
      respondToSave({ limitMb: 2048, warnPercent: 80 });
      await renderAdmin();
      expect(screen.getByText('2.3 GB of 5 GB used')).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText(limitLabel), { target: { value: '2048' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save limits' }));

      await waitFor(() => expect(callsTo('PUT', '/admin/storage/limits')).toHaveLength(1));
      const put = callsTo('PUT', '/admin/storage/limits')[0]!;
      // Only the field that changed: the other one is not ours to overwrite.
      expect(put.body).toEqual({ limitMb: 2048 });
      expect(put.headers['x-requested-with']).toBe('ax-admin');

      await waitFor(() => expect(showToast).toHaveBeenCalled());
      expect(lastToast().title).toBe('Storage limits saved');
      expect(lastToast().detail).toBe('The new settings apply to everyone right away.');
      expect(lastToast().kind ?? 'info').toBe('info');

      // The form now IS the saved state: nothing left to save.
      await waitFor(() => expect(screen.getByRole('button', { name: 'Save limits' })).toBeDisabled());
      expect(screen.getByLabelText(limitLabel)).toHaveValue(2048);

      // Both reads happen again: the admin's OWN bar moved, and so did the
      // status of everyone in the table.
      await waitFor(() => expect(callsTo('GET', '/admin/storage')).toHaveLength(2));
      await waitFor(() => expect(callsTo('GET', '/settings/storage')).toHaveLength(2));
      expect(await screen.findByText('2.3 GB of 2 GB used')).toBeInTheDocument();
    });

    it('sends both fields when both changed', async () => {
      respondToSave({ limitMb: 512, warnPercent: 60 });
      await renderAdmin();
      fireEvent.change(screen.getByLabelText(limitLabel), { target: { value: '512' } });
      fireEvent.change(screen.getByLabelText(warnLabel), { target: { value: '60' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save limits' }));
      await waitFor(() => expect(callsTo('PUT', '/admin/storage/limits')).toHaveLength(1));
      expect(callsTo('PUT', '/admin/storage/limits')[0]!.body).toEqual({
        limitMb: 512,
        warnPercent: 60,
      });
    });

    it('accepts the edges of the allowed ranges', async () => {
      await renderAdmin();
      const save = screen.getByRole('button', { name: 'Save limits' });
      for (const [limit, warn] of [
        ['64', '1'],
        ['10485760', '99'],
      ] as const) {
        fireEvent.change(screen.getByLabelText(limitLabel), { target: { value: limit } });
        fireEvent.change(screen.getByLabelText(warnLabel), { target: { value: warn } });
        expect(screen.getByLabelText(limitLabel)).not.toHaveAttribute('aria-invalid', 'true');
        expect(screen.getByLabelText(warnLabel)).not.toHaveAttribute('aria-invalid', 'true');
        expect(save).toBeEnabled();
      }
    });

    it.each(['63', '10485761', '1.5', '0', '-8', ''])(
      'blocks a limit of "%s" and says what is allowed',
      async (bad) => {
        await renderAdmin();
        const input = screen.getByLabelText(limitLabel);
        fireEvent.change(input, { target: { value: bad } });

        expect(input).toHaveAttribute('aria-invalid', 'true');
        expect(input.closest('[data-slot="field"]')).toHaveAttribute('data-invalid', 'true');
        expect(
          screen.getByText('Enter a whole number of MB between 64 and 10,485,760.'),
        ).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Save limits' })).toBeDisabled();
      },
    );

    it.each(['0', '100', '80.5', ''])(
      'blocks a notice point of "%s" and says what is allowed',
      async (bad) => {
        await renderAdmin();
        const input = screen.getByLabelText(warnLabel);
        fireEvent.change(input, { target: { value: bad } });

        expect(input).toHaveAttribute('aria-invalid', 'true');
        expect(screen.getByText('Enter a whole number between 1 and 99.')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Save limits' })).toBeDisabled();
      },
    );

    it('does not send anything while a field is invalid, even on Enter', async () => {
      await renderAdmin();
      fireEvent.change(screen.getByLabelText(limitLabel), { target: { value: '5' } });
      fireEvent.submit(screen.getByLabelText(limitLabel).closest('form')!);
      await Promise.resolve();
      expect(callsTo('PUT', '/admin/storage/limits')).toHaveLength(0);
    });

    it('points at the field with its message, for people who cannot see the red', async () => {
      await renderAdmin();
      const input = screen.getByLabelText(limitLabel);
      fireEvent.change(input, { target: { value: '5' } });
      const error = screen.getByText('Enter a whole number of MB between 64 and 10,485,760.');
      expect(error.id).not.toBe('');
      expect(input.getAttribute('aria-describedby') ?? '').toContain(error.id);
    });

    describe.each([
      [
        400,
        'invalid-limits',
        /64 to 10,485,760 MB.*1 to 99 percent/,
      ],
      [400, 'invalid-json', /Something went wrong on our side/],
      [413, 'body-too-large', /Something went wrong on our side/],
      [403, 'forbidden', /needs an admin account/],
      [401, 'unauthenticated', /Your session has ended/],
    ] as const)('when the server answers %i %s', (status, code, sentence) => {
      it('says so in a sentence, keeps what was typed, and changes nothing', async () => {
        handler = (call) =>
          call.method === 'PUT' ? json(status, { error: code }) : defaultHandler(call);
        await renderAdmin();

        fireEvent.change(screen.getByLabelText(limitLabel), { target: { value: '2048' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save limits' }));

        const alert = await within(
          screen.getByLabelText(limitLabel).closest('form')!,
        ).findByRole('alert');
        expect(alert).toHaveTextContent(sentence);
        // Never the code.
        expect(alert).not.toHaveTextContent(code);
        // The admin can fix the number and try again without retyping.
        expect(screen.getByLabelText(limitLabel)).toHaveValue(2048);
        expect(screen.getByRole('button', { name: 'Save limits' })).toBeEnabled();
        expect(showToast).not.toHaveBeenCalled();
      });
    });

    it('explains a save that never reached the server, and says nothing changed', async () => {
      handler = (call) =>
        call.method === 'PUT'
          ? Promise.reject(new TypeError('Failed to fetch'))
          : defaultHandler(call);
      await renderAdmin();
      fireEvent.change(screen.getByLabelText(limitLabel), { target: { value: '2048' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save limits' }));

      const alert = await within(
        screen.getByLabelText(limitLabel).closest('form')!,
      ).findByRole('alert');
      expect(alert).toHaveTextContent("We couldn't save your changes.");
      expect(alert).toHaveTextContent('Nothing was changed.');
      expect(alert).toHaveTextContent("We couldn't reach the server.");
      expect(alert).not.toHaveTextContent('Failed to fetch');
    });

    it('clears the old complaint the moment the admin starts fixing things', async () => {
      handler = (call) =>
        call.method === 'PUT' ? json(400, { error: 'invalid-limits' }) : defaultHandler(call);
      await renderAdmin();
      const form = screen.getByLabelText(limitLabel).closest('form')!;
      fireEvent.change(screen.getByLabelText(limitLabel), { target: { value: '2048' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save limits' }));
      await within(form).findByRole('alert');

      fireEvent.change(screen.getByLabelText(limitLabel), { target: { value: '4096' } });
      expect(within(form).queryByRole('alert')).toBeNull();
    });
  });

  describe('when the admin report will not load', () => {
    it('says so, offers Try again, and keeps the personal card working', async () => {
      let attempt = 0;
      handler = (call) => {
        if (call.method === 'GET' && call.path === '/admin/storage') {
          attempt += 1;
          return attempt === 1 ? json(500, { error: 'db-down' }) : json(200, admin);
        }
        return defaultHandler(call);
      };
      render(<StorageTab isAdmin />);

      // The person's own numbers are theirs whatever the admin read does.
      expect(await screen.findByText('2.3 GB of 5 GB used')).toBeInTheDocument();
      const alert = await screen.findByText(/couldn't load the storage limits/i);
      expect(alert.closest('[role="alert"]')).toHaveTextContent('The server ran into a problem.');
      // Nothing to edit or list when we cannot see the numbers.
      expect(screen.queryByLabelText('Limit per person (MB)')).toBeNull();
      expect(screen.queryByRole('table')).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(await screen.findByRole('table')).toBeInTheDocument();
      expect(screen.getByLabelText('Limit per person (MB)')).toBeInTheDocument();
      expect(callsTo('GET', '/admin/storage')).toHaveLength(2);
      // Retrying the admin read does not re-read the person's.
      expect(callsTo('GET', '/settings/storage')).toHaveLength(1);
    });

    it('tells someone who lost admin rights to ask an admin, in a sentence', async () => {
      handler = (call) =>
        call.path === '/admin/storage' ? json(403, { error: 'forbidden' }) : defaultHandler(call);
      render(<StorageTab isAdmin />);
      const alert = (await screen.findByText(/couldn't load the storage limits/i)).closest(
        '[role="alert"]',
      );
      expect(alert).toHaveTextContent('This needs an admin account.');
      expect(alert).not.toHaveTextContent('forbidden');
    });
  });
});
