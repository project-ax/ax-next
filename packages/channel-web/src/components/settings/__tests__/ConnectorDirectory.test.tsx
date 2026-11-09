/**
 * TASK-1101 — Admin › Connectors › Find in directory: the subview that
 * searches the directory and hands a listing to the create editor.
 *
 * What these pin: the directory's states (loading, couldn't load, turned
 * off, never synced, stale, fresh), that nothing is listed until the admin
 * types, the debounce, the ORDER of answers (a slow answer for an older query
 * never lands, Review Focus 1), the query cap (Review Focus 5), Show more,
 * and "already in your connectors" by server address (Review Focus 3), which
 * fails open.
 *
 * Real timers throughout. The debounce is short and `findBy*` waits it out.
 * Each "this did not happen" check runs after the thing that WOULD have made
 * it happen has had its chance: a broken guard has to be able to fail it.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ConnectorDirectory, SEARCH_DEBOUNCE_MS } from '../ConnectorDirectory';
import * as directoryLib from '@/lib/connector-directory';
import * as connectorsLib from '@/lib/connectors';
import type { DirectoryPage } from '@/lib/connector-directory';
import type { Connector, ConnectorSummary } from '@/lib/connectors';
import { directoryEntry, directoryPage } from '@/lib/__tests__/directory-fixtures';
import { headingOutline, headingOutlineProblems } from '@/test-utils/heading-outline';

const INTRO =
  'Search a public directory of services that work with agents. Anyone can publish to it, so each result shows who published it.';
const LOCAL_ONLY =
  'Only servers on the web are listed. Ones that run on someone’s own computer can’t be reached by agents, so we leave them out.';
const VERIFIED_ONLY = 'Only listings from verified publishers are shown in this workspace.';
const NOT_YET_TITLE = 'The directory isn’t available yet';
const NOT_YET_DESCRIPTION =
  'We haven’t been able to load it since this workspace started, so there’s nothing to search yet. The first load takes a few minutes. If it never finishes, your network may be blocking outside sites. You can still set up a connector by hand.';
const OFF_TITLE = 'The directory is turned off in this workspace';
const OFF_DESCRIPTION = 'You can still set up a connector by hand.';
const LOAD_FAILED = 'We couldn’t load the directory just now.';
const SEARCH_FAILED = 'We couldn’t search the directory just now.';
const NO_MATCH_DESCRIPTION =
  'Try the service’s name rather than what it does. Not every service is listed yet. If you know its address, you can set it up by hand.';
const MORE_FAILED = 'We couldn’t load more just now.';

/** A domain-proven listing that needs a key. */
const linear = directoryEntry({ auth: 'key', keyHeader: 'X-API-Key' });
/** A community listing that declares no key. */
const community = directoryEntry({
  id: 'io.github.quickmcp/notes',
  title: 'Quick Notes',
  description: 'Jot notes down from any chat.',
  publisher: 'quickmcp',
  publisherProof: 'account',
  url: 'https://notes.quickmcp.dev/mcp',
});
const tickets = directoryEntry({
  id: 'com.example/tickets',
  title: 'Tickets',
  description: 'Open and close tickets.',
  publisher: 'example.com',
  url: 'https://mcp.example.com/mcp',
});
const docs = directoryEntry({
  id: 'com.example/docs',
  title: 'Docs',
  description: 'Search the team’s docs.',
  publisher: 'example.com',
  url: 'https://docs.example.com/mcp',
});

const SUMMARY: ConnectorSummary = {
  id: 'team-linear',
  name: 'Team Linear',
  description: '',
  usageNote: '',
  keyMode: 'personal',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

/** The full record `getConnector` answers: one http server per address. */
function fullConnector(summary: ConnectorSummary, urls: readonly string[] = []): Connector {
  return {
    ...summary,
    capabilities: {
      ...connectorsLib.emptyCapabilities(),
      mcpServers: urls.map((url, i) => ({
        name: `server-${i}`,
        transport: 'http' as const,
        url,
        allowedHosts: [],
        credentials: [],
      })),
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A request that never answers on its own, and rejects as `fetch` does once aborted. */
function untilAborted(signal: AbortSignal | undefined): Promise<DirectoryPage> {
  return new Promise((_, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), {
      once: true,
    });
  });
}

let search: MockInstance<typeof directoryLib.searchDirectory>;
let getConnector: MockInstance<typeof connectorsLib.getConnector>;

beforeEach(() => {
  search = vi
    .spyOn(directoryLib, 'searchDirectory')
    .mockImplementation(async (q) => (q === '' ? directoryPage() : directoryPage({ entries: [linear, community] })));
  getConnector = vi
    .spyOn(connectorsLib, 'getConnector')
    .mockImplementation(async (id) => fullConnector({ ...SUMMARY, id }));
});
afterEach(() => vi.restoreAllMocks());

function renderDirectory(connectors: readonly ConnectorSummary[] = []) {
  const onBack = vi.fn();
  const onSetUp = vi.fn();
  const onNewConnector = vi.fn();
  const ui = (list: readonly ConnectorSummary[]) => (
    <ConnectorDirectory connectors={list} onBack={onBack} onSetUp={onSetUp} onNewConnector={onNewConnector} />
  );
  const view = render(ui(connectors));
  return {
    ...view,
    onBack,
    onSetUp,
    onNewConnector,
    /** Re-render with another connectors list, as the tab would. */
    setConnectors: (list: readonly ConnectorSummary[]) => view.rerender(ui(list)),
  };
}

/** The search box, once the directory's state has loaded. */
const searchBox = () => screen.findByLabelText('Search the directory');
/** Type into the box. `user-event` isn't installed. */
const typeQuery = (box: HTMLElement, value: string) => fireEvent.change(box, { target: { value } });
/** The query of every `searchDirectory` call, in order. */
const queries = () => search.mock.calls.map(([q]) => q);
/** Every listing row's accessible name, in order. */
const rowNames = () =>
  screen.queryAllByRole('button', { name: /^Details for / }).map((b) => b.getAttribute('aria-label'));
const row = (title: string) => screen.getByRole('button', { name: `Details for ${title}` });
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Let real time pass inside `act`, so anything it sets off lands before the next check. */
const pass = (ms: number) =>
  act(async () => {
    await wait(ms);
  });

describe('ConnectorDirectory', () => {
  describe('what it opens on', () => {
    it('opens on the search box and freshness only: no list until the admin types', async () => {
      // Even an answer that carries rows lists nothing: the list waits for typing.
      search.mockImplementation(async () => directoryPage({ entries: [linear, community] }));
      renderDirectory();
      expect(await screen.findByText('List updated 12 min ago')).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 2, name: 'Find a connector' })).toBeInTheDocument();
      expect(screen.getByText(INTRO)).toBeInTheDocument();
      const box = screen.getByLabelText('Search the directory');
      expect(box).toHaveValue('');
      expect(box).toHaveAttribute('placeholder', 'Search by service, like Notion or Stripe');
      expect(box).toHaveFocus();
      expect(screen.queryAllByRole('button', { name: /^Details for/ })).toEqual([]);
      expect(screen.queryByRole('status')).toBeNull();
      expect(search).toHaveBeenCalledTimes(1);
      expect(search).toHaveBeenCalledWith('', { signal: expect.any(AbortSignal) });
      expect(screen.getByText(LOCAL_ONLY)).toBeInTheDocument();
      // The synced state offers no shortcut to a blank editor.
      expect(screen.queryByRole('button', { name: 'New connector' })).toBeNull();
    });

    it('caps the query at the route’s limit', async () => {
      // Review Focus 5. jsdom doesn't enforce `maxLength` on a programmatic
      // value, so the attribute is what a browser paste would stop at.
      renderDirectory();
      expect(await searchBox()).toHaveAttribute('maxLength', '200');
    });

    it('a stale list says how old it is', async () => {
      const sixHoursAgo = new Date(Date.now() - 6 * 3_600_000).toISOString();
      search.mockImplementation(async () => directoryPage({ stale: true, syncedAt: sixHoursAgo }));
      const view = renderDirectory();
      const note = await screen.findByTestId('directory-stale');
      expect(note).toHaveAttribute('role', 'note');
      expect(note.textContent).toBe(
        'We couldn’t refresh the directory, so this is the list from 6 hr ago. New servers may be missing. We’ll keep trying.',
      );
      expect(screen.queryByText(/^List updated/)).toBeNull();
      // A stale list is still a list.
      expect(screen.getByLabelText('Search the directory')).toBeInTheDocument();
      view.unmount();

      // A time it can't read: stale says so without one, and fresh says nothing.
      search.mockImplementation(async () => directoryPage({ stale: true, syncedAt: 'not a time' }));
      const unread = renderDirectory();
      expect((await screen.findByTestId('directory-stale')).textContent).toBe(
        'We couldn’t refresh the directory, so this list may be out of date. New servers may be missing. We’ll keep trying.',
      );
      unread.unmount();
      search.mockImplementation(async () => directoryPage({ syncedAt: 'not a time' }));
      renderDirectory();
      await searchBox();
      expect(screen.queryByText(/^List updated/)).toBeNull();
      expect(screen.queryByTestId('directory-stale')).toBeNull();
    });

    it('says when only verified publishers are shown', async () => {
      search.mockImplementation(async () => directoryPage({ verifiedOnly: true }));
      const view = renderDirectory();
      expect(await screen.findByText(VERIFIED_ONLY)).toBeInTheDocument();
      view.unmount();

      search.mockImplementation(async () => directoryPage({ verifiedOnly: false }));
      renderDirectory();
      await screen.findByText('List updated 12 min ago');
      expect(screen.queryByText(VERIFIED_ONLY)).toBeNull();
    });

    it('never synced: explains, offers Try again and New connector, and has no search box', async () => {
      search.mockResolvedValueOnce(directoryPage({ syncedAt: null }));
      const { onNewConnector } = renderDirectory();
      expect(await screen.findByText(NOT_YET_TITLE)).toBeInTheDocument();
      expect(screen.getByText(NOT_YET_DESCRIPTION)).toBeInTheDocument();
      expect(screen.queryByLabelText('Search the directory')).toBeNull();
      expect(screen.queryByText(LOCAL_ONLY)).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'New connector' }));
      expect(onNewConnector).toHaveBeenCalledTimes(1);

      // The second answer has synced, and it replaces the first.
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(await searchBox()).toBeInTheDocument();
      expect(queries()).toEqual(['', '']);
      expect(screen.queryByText(NOT_YET_TITLE)).toBeNull();
    });

    it('turned off: says so and offers New connector, with no search box', async () => {
      // Off and never synced at once (what a host without a directory answers):
      // off is the one that's true for good, so it wins.
      search.mockImplementation(async () => directoryLib.directoryOffPage());
      const { onNewConnector } = renderDirectory();
      expect(await screen.findByText(OFF_TITLE)).toBeInTheDocument();
      expect(screen.getByText(OFF_DESCRIPTION)).toBeInTheDocument();
      expect(screen.queryByText(NOT_YET_TITLE)).toBeNull();
      expect(screen.queryByLabelText('Search the directory')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'New connector' }));
      expect(onNewConnector).toHaveBeenCalledTimes(1);
    });

    it('could not load: says so and tries again', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      search.mockRejectedValueOnce(new Error('search directory: 500'));
      renderDirectory();
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(LOAD_FAILED);
      expect(screen.queryByLabelText('Search the directory')).toBeNull();
      expect(warn).toHaveBeenCalled();

      fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
      expect(await searchBox()).toBeInTheDocument();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(queries()).toEqual(['', '']);
    });

    it('headings step down from the page title', async () => {
      renderDirectory();
      typeQuery(await searchBox(), 'linear');
      await screen.findByRole('button', { name: 'Details for Linear' });
      // A fragment of Admin › Connectors, which sits under the pane's h1.
      expect(headingOutlineProblems(document.body, 2)).toEqual([]);
      expect(headingOutline()).toEqual(['h2: Find a connector']);
    });
  });

  describe('searching', () => {
    it('typing shows each listing’s title, publisher proof, description and auth chip', async () => {
      renderDirectory();
      typeQuery(await searchBox(), 'linear');
      const linearRow = await screen.findByRole('button', { name: 'Details for Linear' });
      const communityRow = row('Quick Notes');
      expect(rowNames()).toEqual(['Details for Linear', 'Details for Quick Notes']);
      expect(screen.getByRole('status')).toHaveTextContent(/^2 servers match$/);
      expect(within(linearRow).getByTestId('directory-proof-domain')).toHaveTextContent('Published by linear.app');
      expect(within(communityRow).getByTestId('directory-proof-account')).toHaveTextContent(
        /^Community · quickmcp$/,
      );
      expect(within(linearRow).getByText(linear.description)).toBeInTheDocument();
      expect(within(communityRow).getByText(community.description)).toBeInTheDocument();
      expect(within(linearRow).getByText('API key')).toBeInTheDocument();
      expect(screen.getAllByText('API key')).toHaveLength(1);
      expect(search).toHaveBeenLastCalledWith('linear', { signal: expect.any(AbortSignal) });
    });

    it('a search answer updates how fresh the list says it is', async () => {
      // Fresh when the admin opened it, stale by the time they searched.
      const sixHoursAgo = new Date(Date.now() - 6 * 3_600_000).toISOString();
      search.mockImplementation(async (q) =>
        q === '' ? directoryPage() : directoryPage({ entries: [linear], stale: true, syncedAt: sixHoursAgo }),
      );
      renderDirectory();
      typeQuery(await searchBox(), 'linear');
      await screen.findByRole('button', { name: 'Details for Linear' });
      expect(screen.getByTestId('directory-stale').textContent).toContain('this is the list from 6 hr ago');
      expect(screen.queryByText(/^List updated/)).toBeNull();
    });

    it('says “1 server matches” for one', async () => {
      search.mockImplementation(async (q) => (q === '' ? directoryPage() : directoryPage({ entries: [linear] })));
      renderDirectory();
      typeQuery(await searchBox(), 'linear');
      await screen.findByRole('button', { name: 'Details for Linear' });
      expect(screen.getByRole('status')).toHaveTextContent(/^1 server matches$/);
    });

    it('debounces typing into one search for the newest text', async () => {
      renderDirectory();
      const box = await searchBox();
      typeQuery(box, 'n');
      typeQuery(box, 'no');
      typeQuery(box, 'notion');
      // Partway through the pause, nothing has gone out yet.
      await pass(SEARCH_DEBOUNCE_MS / 2);
      expect(queries()).toEqual(['']);
      expect(screen.getByRole('status')).toHaveTextContent('Searching…');
      await screen.findByRole('button', { name: 'Details for Linear' });
      // Any timer the typing failed to cancel has had time to fire too.
      await pass(SEARCH_DEBOUNCE_MS);
      expect(queries()).toEqual(['', 'notion']);
    });

    it('a slow answer for an older query never replaces a newer one', async () => {
      // Review Focus 1.
      const notion = directoryEntry({
        id: 'com.notion/mcp',
        title: 'Notion',
        publisher: 'notion.com',
        url: 'https://mcp.notion.com/mcp',
      });
      const slow = deferred<DirectoryPage>();
      search.mockImplementation(async (q) => {
        if (q === 'linear') return slow.promise;
        if (q === 'notion') return directoryPage({ entries: [notion] });
        return directoryPage();
      });
      renderDirectory();
      const box = await searchBox();
      typeQuery(box, 'linear');
      await waitFor(() => expect(queries()).toEqual(['', 'linear']));
      typeQuery(box, 'notion');
      await screen.findByRole('button', { name: 'Details for Notion' });

      // The older answer arrives last, and is fully processed before the checks.
      await act(async () => {
        slow.resolve(directoryPage({ entries: [linear] }));
        await wait(0);
      });
      expect(screen.queryByRole('button', { name: 'Details for Linear' })).toBeNull();
      // Nor does it knock the newer answer off the screen.
      expect(rowNames()).toEqual(['Details for Notion']);
      expect(screen.getByRole('status')).toHaveTextContent(/^1 server matches$/);
      // The older request was cancelled when the newer one went out.
      expect(search.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
    });

    it('a search the admin typed past is cancelled quietly, not shown as a failure', async () => {
      // What `fetch` does with an abort: the older request REJECTS.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const notion = directoryEntry({
        id: 'com.notion/mcp',
        title: 'Notion',
        publisher: 'notion.com',
        url: 'https://mcp.notion.com/mcp',
      });
      search.mockImplementation(async (q, options) => {
        if (q === 'linear') return untilAborted(options?.signal);
        return q === 'notion' ? directoryPage({ entries: [notion] }) : directoryPage();
      });
      renderDirectory();
      const box = await searchBox();
      typeQuery(box, 'linear');
      await waitFor(() => expect(queries()).toEqual(['', 'linear']));
      typeQuery(box, 'notion');
      await screen.findByRole('button', { name: 'Details for Notion' });
      await pass(0);
      expect(search.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
      expect(screen.queryByRole('alert')).toBeNull();
      expect(warn).not.toHaveBeenCalled();
      // Back to the text whose request was cancelled: no failure was left behind.
      typeQuery(box, 'linear');
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByRole('status')).toHaveTextContent('Searching…');
    });

    it('clearing the box goes back to no list, and cancels the search in flight', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      search.mockImplementation(async (q, options) => {
        if (q === 'notion') return untilAborted(options?.signal);
        return q === '' ? directoryPage() : directoryPage({ entries: [linear, community] });
      });
      renderDirectory();
      const box = await searchBox();
      typeQuery(box, 'linear');
      await screen.findByRole('button', { name: 'Details for Linear' });
      typeQuery(box, 'notion');
      await waitFor(() => expect(queries()).toEqual(['', 'linear', 'notion']));

      typeQuery(box, '');
      expect(rowNames()).toEqual([]);
      expect(screen.queryByRole('status')).toBeNull();
      expect(search.mock.calls[2]?.[1]?.signal?.aborted).toBe(true);
      // The cancelled request's rejection lands, and is neither shown nor logged.
      await pass(0);
      expect(warn).not.toHaveBeenCalled();
      expect(rowNames()).toEqual([]);
      expect(screen.getByText('List updated 12 min ago')).toBeInTheDocument();
      expect(screen.getByText(LOCAL_ONLY)).toBeInTheDocument();
      // Typing the same text again searches afresh, with no failure left behind.
      typeQuery(box, 'notion');
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByRole('status')).toHaveTextContent('Searching…');
    });

    it('whitespace only never searches', async () => {
      renderDirectory();
      typeQuery(await searchBox(), '   ');
      await pass(SEARCH_DEBOUNCE_MS + 100);
      expect(search).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('no matches: names the query and offers New connector', async () => {
      search.mockImplementation(async (q) => (q === '' ? directoryPage() : directoryPage({ entries: [] })));
      const { onNewConnector } = renderDirectory();
      // The box's own spaces are not part of the search.
      typeQuery(await searchBox(), '  zzz ');
      expect(await screen.findByText('Nothing matches “zzz”')).toBeInTheDocument();
      expect(screen.getByText(NO_MATCH_DESCRIPTION)).toBeInTheDocument();
      expect(queries()).toEqual(['', 'zzz']);
      expect(screen.queryByText(/servers? match/)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'New connector' }));
      expect(onNewConnector).toHaveBeenCalledTimes(1);
    });

    it('could not search: says so and tries the same query again', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      search.mockImplementation(async (q) => {
        if (q === '') return directoryPage();
        throw new Error('search directory: 502');
      });
      renderDirectory();
      const box = await searchBox();
      typeQuery(box, 'linear');
      expect(await screen.findByRole('alert')).toHaveTextContent(SEARCH_FAILED);
      expect(warn).toHaveBeenCalled();

      // The failure belongs to the text that failed: new text searches afresh.
      typeQuery(box, 'linear docs');
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByRole('status')).toHaveTextContent('Searching…');
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(SEARCH_FAILED);
      expect(screen.queryByRole('status')).toBeNull();

      search.mockImplementation(async (q) =>
        q === '' ? directoryPage() : directoryPage({ entries: [linear, community] }),
      );
      fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
      expect(await screen.findByRole('button', { name: 'Details for Linear' })).toBeInTheDocument();
      expect(queries()).toEqual(['', 'linear', 'linear docs', 'linear docs']);
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  describe('Show more', () => {
    function pagedSearch(secondPage: () => Promise<DirectoryPage>) {
      search.mockImplementation(async (q, options) => {
        if (q === '') return directoryPage();
        if (options?.cursor === 'cur2') return secondPage();
        return directoryPage({ entries: [linear, community], nextCursor: 'cur2' });
      });
    }

    it('Show more appends the next page and disappears at the end', async () => {
      // Three pages, so the middle one proves the cursor moves on and the
      // button comes back ready, not stuck loading.
      search.mockImplementation(async (q, options) => {
        if (q === '') return directoryPage();
        if (options?.cursor === 'cur2') return directoryPage({ entries: [tickets], nextCursor: 'cur3' });
        if (options?.cursor === 'cur3') return directoryPage({ entries: [docs] });
        return directoryPage({ entries: [linear, community], nextCursor: 'cur2' });
      });
      renderDirectory();
      typeQuery(await searchBox(), 'linear');
      await screen.findByRole('button', { name: 'Details for Linear' });
      // The route sends a page and no total, so a bare count would understate.
      expect(screen.getByRole('status')).toHaveTextContent(/^More than 2 servers match$/);

      fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
      await screen.findByRole('button', { name: 'Details for Tickets' });
      expect(search).toHaveBeenLastCalledWith(
        'linear',
        expect.objectContaining({ cursor: 'cur2', signal: expect.any(AbortSignal) }),
      );
      expect(screen.getByRole('status')).toHaveTextContent(/^More than 3 servers match$/);
      const more = screen.getByRole('button', { name: 'Show more' });
      expect(more).toBeEnabled();

      fireEvent.click(more);
      await screen.findByRole('button', { name: 'Details for Docs' });
      expect(search).toHaveBeenLastCalledWith('linear', expect.objectContaining({ cursor: 'cur3' }));
      expect(rowNames()).toEqual([
        'Details for Linear',
        'Details for Quick Notes',
        'Details for Tickets',
        'Details for Docs',
      ]);
      expect(screen.getByRole('status')).toHaveTextContent(/^4 servers match$/);
      expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    });

    it('Show more skips a listing it already shows', async () => {
      // Offset pages over a list that resyncs can repeat a row.
      pagedSearch(async () => directoryPage({ entries: [community, tickets] }));
      renderDirectory();
      typeQuery(await searchBox(), 'linear');
      await screen.findByRole('button', { name: 'Details for Linear' });
      fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
      await screen.findByRole('button', { name: 'Details for Tickets' });
      expect(rowNames()).toEqual(['Details for Linear', 'Details for Quick Notes', 'Details for Tickets']);
      expect(screen.getByRole('status')).toHaveTextContent(/^3 servers match$/);
    });

    it('a failed Show more says so and keeps the button', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      let fail = true;
      pagedSearch(async () => {
        if (fail) throw new Error('search directory: 503');
        return directoryPage({ entries: [tickets] });
      });
      renderDirectory();
      typeQuery(await searchBox(), 'linear');
      await screen.findByRole('button', { name: 'Details for Linear' });
      fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
      expect(await screen.findByText(MORE_FAILED)).toBeInTheDocument();
      expect(warn).toHaveBeenCalled();
      // The rows it had stay, and so does the way to try again.
      expect(rowNames()).toEqual(['Details for Linear', 'Details for Quick Notes']);
      const more = screen.getByRole('button', { name: 'Show more' });
      expect(more).toBeEnabled();

      fail = false;
      fireEvent.click(more);
      await screen.findByRole('button', { name: 'Details for Tickets' });
      expect(screen.queryByText(MORE_FAILED)).toBeNull();
    });

    it('a page that arrives after the admin typed something new is dropped', async () => {
      const notion = directoryEntry({
        id: 'com.notion/mcp',
        title: 'Notion',
        publisher: 'notion.com',
        url: 'https://mcp.notion.com/mcp',
      });
      const page2 = deferred<DirectoryPage>();
      search.mockImplementation(async (q, options) => {
        if (q === '') return directoryPage();
        if (q === 'notion') return directoryPage({ entries: [notion] });
        if (options?.cursor === 'cur2') return page2.promise;
        return directoryPage({ entries: [linear, community], nextCursor: 'cur2' });
      });
      renderDirectory();
      const box = await searchBox();
      typeQuery(box, 'linear');
      await screen.findByRole('button', { name: 'Details for Linear' });
      fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
      typeQuery(box, 'notion');
      await screen.findByRole('button', { name: 'Details for Notion' });

      await act(async () => {
        page2.resolve(directoryPage({ entries: [tickets] }));
        await wait(0);
      });
      expect(rowNames()).toEqual(['Details for Notion']);
      expect(screen.getByRole('status')).toHaveTextContent(/^1 server matches$/);
    });
  });

  describe('already in your connectors', () => {
    it('marks a listing whose address a connector already uses', async () => {
      // Review Focus 3: the same server written differently is the same
      // server, and another path on the same host is another server.
      const sse = directoryEntry({ id: 'app.linear/sse', title: 'Linear SSE', url: 'https://mcp.linear.app/sse' });
      search.mockImplementation(async (q) => (q === '' ? directoryPage() : directoryPage({ entries: [linear, sse] })));
      getConnector.mockResolvedValue(fullConnector(SUMMARY, ['https://MCP.linear.app:443/mcp/']));
      renderDirectory([SUMMARY]);
      typeQuery(await searchBox(), 'linear');
      const linearRow = await screen.findByRole('button', { name: 'Details for Linear' });
      expect(await within(linearRow).findByText('Added')).toBeInTheDocument();
      expect(within(row('Linear SSE')).queryByText('Added')).toBeNull();
      expect(getConnector).toHaveBeenCalledWith(SUMMARY.id, '/admin/connectors');

      fireEvent.click(linearRow);
      const sheet = await screen.findByRole('dialog', { name: 'Linear' });
      expect(within(sheet).getByRole('button', { name: 'Already in your connectors' })).toBeDisabled();
      expect(within(sheet).queryByRole('button', { name: 'Set it up' })).toBeNull();
    });

    it('still offers Set it up when a connector’s details won’t load', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const broken: ConnectorSummary = { ...SUMMARY, id: 'broken' };
      const notes: ConnectorSummary = { ...SUMMARY, id: 'team-notes' };
      getConnector.mockImplementation(async (id) => {
        if (id === broken.id) throw new Error('get connector: 500');
        return fullConnector(notes, [community.url]);
      });
      renderDirectory([broken, notes]);
      typeQuery(await searchBox(), 'linear');
      await screen.findByRole('button', { name: 'Details for Linear' });
      // A record that did load still counts: one failure doesn't drop the rest.
      expect(await within(row('Quick Notes')).findByText('Added')).toBeInTheDocument();
      expect(warn).toHaveBeenCalled();

      // The one that didn't load is skipped, never read as a match.
      expect(within(row('Linear')).queryByText('Added')).toBeNull();
      fireEvent.click(row('Linear'));
      const sheet = await screen.findByRole('dialog', { name: 'Linear' });
      expect(within(sheet).getByRole('button', { name: 'Set it up' })).toBeEnabled();
      expect(within(sheet).queryByRole('button', { name: 'Already in your connectors' })).toBeNull();
    });

    it('reads each connector once, and again only when one changes', async () => {
      const { setConnectors } = renderDirectory([SUMMARY]);
      await searchBox();
      expect(getConnector).toHaveBeenCalledTimes(1);
      // An equal list in a new array (the tab re-rendering) reads nothing.
      setConnectors([{ ...SUMMARY }]);
      expect(getConnector).toHaveBeenCalledTimes(1);
      // An edited connector is read again.
      setConnectors([{ ...SUMMARY, updatedAt: '2026-11-02T00:00:00.000Z' }]);
      expect(getConnector).toHaveBeenCalledTimes(2);
    });

    it('an older read that answers late never overwrites a newer one', async () => {
      const firstRead = deferred<Connector>();
      getConnector.mockImplementationOnce(() => firstRead.promise);
      getConnector.mockImplementation(async () => fullConnector(SUMMARY, [linear.url]));
      const { setConnectors } = renderDirectory([SUMMARY]);
      // The connector was edited to Linear's address before its first read answered.
      setConnectors([{ ...SUMMARY, updatedAt: '2026-11-02T00:00:00.000Z' }]);
      typeQuery(await searchBox(), 'linear');
      await screen.findByRole('button', { name: 'Details for Linear' });
      expect(await within(row('Linear')).findByText('Added')).toBeInTheDocument();

      // The first read, from before the edit, lands last.
      await act(async () => {
        firstRead.resolve(fullConnector(SUMMARY, [community.url]));
        await wait(0);
      });
      expect(within(row('Linear')).getByText('Added')).toBeInTheDocument();
      expect(within(row('Quick Notes')).queryByText('Added')).toBeNull();
    });
  });

  describe('leaving and wiring', () => {
    it('Back and Set it up go to the parent', async () => {
      const { onBack, onSetUp } = renderDirectory();
      typeQuery(await searchBox(), 'linear');
      await screen.findByRole('button', { name: 'Details for Linear' });

      fireEvent.click(screen.getByRole('button', { name: 'Back to connectors' }));
      expect(onBack).toHaveBeenCalledTimes(1);

      fireEvent.click(row('Linear'));
      const sheet = await screen.findByRole('dialog', { name: 'Linear' });
      fireEvent.click(within(sheet).getByRole('button', { name: 'Set it up' }));
      expect(onSetUp).toHaveBeenCalledTimes(1);
      expect(onSetUp).toHaveBeenCalledWith(linear);
    });

    it('leaving while the directory loads cancels the load', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      search.mockImplementation(async (_q, options) => untilAborted(options?.signal));
      const view = renderDirectory();
      await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
      view.unmount();
      expect(search.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      // The cancelled load's rejection is expected, not a failure to report.
      await wait(0);
      expect(warn).not.toHaveBeenCalled();
    });

    it('leaving cancels the search in flight and the one still waiting for typing to stop', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      search.mockImplementation(async (q, options) => (q === '' ? directoryPage() : untilAborted(options?.signal)));
      const view = renderDirectory();
      const box = await searchBox();
      typeQuery(box, 'linear');
      await waitFor(() => expect(queries()).toEqual(['', 'linear']));
      typeQuery(box, 'linear docs');
      view.unmount();
      expect(search.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
      // The waiting one never goes out, and the cancelled one isn't reported.
      await wait(SEARCH_DEBOUNCE_MS + 100);
      expect(queries()).toEqual(['', 'linear']);
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
