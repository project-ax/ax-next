/**
 * The Files tab (plan task AW-12): one section, the agent's own files.
 *
 * What is under test is almost entirely HONESTY. There are four different
 * reasons the list can be empty, and only ONE of them is a statement about
 * the agent:
 *
 *   1. the listing failed,
 *   2. no file area is running at all,
 *   3. the listing has not come back yet,
 *   4. the agent genuinely has not written anything.
 *
 * The prototype could only ever say (4), because `files: []` arrived inside the
 * agent-detail response and an empty array cannot carry a reason. So "has not
 * written anything yet" got rendered over failed reads. These tests pin all
 * four apart, and pin the two things about untrusted content the tab must not
 * get wrong: the fenced LABEL is what is drawn, and a markdown body is
 * rendered without loading remote images.
 *
 * The tab used to show a second, git-backed "Agent workspace" section next to
 * this one; it was removed in TASK-995 and a test below pins that it is gone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { workspaceApi, WorkspaceApiError } from '@/lib/workspace-api';
import type { UserFilesAnswer } from '@/lib/workspace-types';
import { AgentFiles } from '../AgentFiles';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '@/lib/workspace-api',
  );
  return {
    ...actual,
    workspaceApi: {
      userFiles: vi.fn(),
      probeFileDownload: vi.fn(),
    },
  };
});

const userFilesMock = vi.mocked(workspaceApi.userFiles);
/** The probe: it resolves to the route the browser is then handed. */
const downloadMock = vi.mocked(workspaceApi.probeFileDownload);

function renderTab() {
  return render(<AgentFiles agentId="a-quill" agentName="Quill" />);
}

/** The agent's files as a tree: directory listings and file bodies, keyed by raw path. */
function durableTree(dirs: Record<string, UserFilesAnswer>) {
  userFilesMock.mockImplementation(async (_agentId: string, relPath: string) => {
    const hit = dirs[relPath];
    if (hit === undefined) {
      throw new WorkspaceApiError(`/agents/a-quill/user-files/${relPath}`, 404);
    }
    return hit;
  });
}

beforeEach(() => {
  userFilesMock.mockReset();
  downloadMock.mockReset();
  // 503 is the quiet default answer: a deployment with no file area, no retry
  // button, no claim about the agent. Tests that care install a tree.
  userFilesMock.mockRejectedValue(
    new WorkspaceApiError('/agents/a-quill/user-files', 503),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AgentFiles: one section', () => {
  it('shows one Files section for the agent home and no Agent workspace section', async () => {
    durableTree({
      '': {
        kind: 'dir',
        path: '',
        name: '',
        entries: [{ path: 'q3.csv', name: 'q3.csv', kind: 'file' }],
        truncated: false,
      },
    });
    renderTab();
    expect(await screen.findByText('q3.csv')).toBeTruthy();
    // Exactly one section label, and the git-backed one's words are gone.
    expect(screen.getAllByText('Files')).toHaveLength(1);
    expect(screen.queryByText(/agent workspace/i)).toBeNull();
    expect(screen.queryByText(/has not written anything yet/i)).toBeNull();
    // And only the one read happened: the files route, never a second listing.
    expect(userFilesMock).toHaveBeenCalledTimes(1);
    expect(userFilesMock).toHaveBeenCalledWith('a-quill', '');
  });
});

// ---------------------------------------------------------------------------
// The agent's cwd and HOME. It is a TREE: the backing hook answers one
// directory at a time, so walking in and back out is a real behavior with its
// own bugs.
// ---------------------------------------------------------------------------
describe('AgentFiles: the agent\u2019s files', () => {
  it('lists what the agent has in its own working directory', async () => {
    durableTree({
      '': {
        kind: 'dir',
        path: '',
        name: '',
        entries: [
          { path: 'reports', name: 'reports', kind: 'dir' },
          { path: 'q3.csv', name: 'q3.csv', kind: 'file' },
        ],
        truncated: false,
      },
    });
    renderTab();
    expect(await screen.findByText('reports')).toBeTruthy();
    expect(screen.getByText('q3.csv')).toBeTruthy();
    // Nothing open, so nothing claimed about any file's contents.
    expect(screen.getByText(/pick a file to read it/i)).toBeTruthy();
  });

  it('walks into a folder and back out again', async () => {
    durableTree({
      '': {
        kind: 'dir',
        path: '',
        name: '',
        entries: [{ path: 'reports', name: 'reports', kind: 'dir' }],
        truncated: false,
      },
      reports: {
        kind: 'dir',
        path: 'reports',
        name: 'reports',
        entries: [{ path: 'reports/summary.md', name: 'summary.md', kind: 'file' }],
        truncated: false,
      },
    });
    renderTab();
    fireEvent.click(await screen.findByText('reports'));
    expect(await screen.findByText('summary.md')).toBeTruthy();
    // The breadcrumb is the way back, and it goes back to the ROOT listing —
    // not to a cached copy of it, which is how a stale tree gets shown.
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    await waitFor(() => expect(screen.queryByText('summary.md')).toBeNull());
    expect(screen.getByText('reports')).toBeTruthy();
  });

  it('opens a file with the RAW path as the key and draws the FENCED name', async () => {
    // The key goes back on the wire untouched, and the fenced label is the
    // only one that reaches the screen. A filename here is agent-authored with
    // no review at all, so the bidi override (CVE-2021-42574) is exactly what
    // to expect.
    const raw = 'inv\u202Eoice.md';
    durableTree({
      '': {
        kind: 'dir',
        path: '',
        name: '',
        entries: [{ path: raw, name: 'invoice.md', kind: 'file' }],
        truncated: false,
      },
      [raw]: {
        kind: 'file',
        path: raw,
        name: 'invoice.md',
        body: 'paid',
        clipped: null,
      },
    });
    renderTab();
    fireEvent.click(await screen.findByText('invoice.md'));
    await waitFor(() =>
      expect(userFilesMock).toHaveBeenCalledWith('a-quill', raw),
    );
    expect(await screen.findByText('paid')).toBeTruthy();
    expect(screen.queryByText(raw)).toBeNull();
  });

  it('a 404 on the ROOT is the empty state, with no hedge left in it', async () => {
    /*
      TASK-403. This used to be the ambiguous case: the hook answered one word
      for "no file area here" and for "nothing written yet", so the tab had
      to name both and admit it could not tell which — and it said that even on
      a deployment where the file area was wired and working.

      The hook now answers `unavailable` (503) for the no-file-area case, so a 404
      at the root means exactly one thing and gets the plain sentence. The
      hedge must be gone: leaving "we can't tell which" over a working
      deployment is its own small lie.
    */
    userFilesMock.mockRejectedValue(
      new WorkspaceApiError('/agents/a-quill/user-files', 404),
    );
    renderTab();
    expect(
      await screen.findByText(/Quill hasn’t put any files here yet/i),
    ).toBeTruthy();
    expect(screen.queryByText(/can’t tell which/i)).toBeNull();
    expect(screen.queryByText(/isn’t keeping them/i)).toBeNull();
  });

  it('a 503 says this server keeps no files, and offers no retry', async () => {
    /*
      The other half of the same split. Retrying will never produce a file, so
      a "try again" button here would send somebody hunting for something that
      was never going to be there.
    */
    userFilesMock.mockRejectedValue(
      new WorkspaceApiError('/agents/a-quill/user-files', 503),
    );
    renderTab();
    expect(
      await screen.findByText(/server isn’t set up to keep Quill’s files/i),
    ).toBeTruthy();
    expect(screen.queryByText(/hasn’t put any files here yet/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
  });

  it('REGRESSION: a FAILED durable read never renders as an empty list', async () => {
    /*
      THE HALF THAT MATTERS. A read that broke — the export unreachable, the
      reader pod dead, a listing that raised EIO — reaches the client as a 5xx,
      and it must not be spelled like an absence. "Quill hasn't put any files
      here yet" over a mount we could not read is indistinguishable from the
      truth, so the reader cannot tell anything is wrong. This is the assertion
      the card asks for explicitly, and it is written as a NEGATIVE on every
      emptiness sentence this section can draw, not just as a positive on the
      error one.
    */
    userFilesMock.mockRejectedValue(
      new WorkspaceApiError('/agents/a-quill/user-files', 500),
    );
    renderTab();
    expect(await screen.findByText(/could not read Quill’s files/i)).toBeTruthy();
    // None of the three ways this tab can say "there is nothing here".
    expect(screen.queryByText(/hasn’t put any files here yet/i)).toBeNull();
    expect(screen.queryByText(/this folder is empty/i)).toBeNull();
    expect(screen.queryByText(/server isn’t set up to keep/i)).toBeNull();
    // A broken read is worth coming back to, so it gets a real button.
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
  });

  it('REGRESSION: "Go back" leaves the subtree instead of re-asking for it', async () => {
    /*
      The button used to call `reload()`, which re-fetches `dirPath` — the last
      SUCCESSFUL listing. That looks right when you walk INTO a missing folder,
      because `dirPath` is then the parent. It is wrong the moment the failing
      path is an ANCESTOR of where we stand: walk down to `reports/deep`, have
      the whole subtree disappear, click back up to `reports` — and the reload
      re-fetches `reports/deep`, which is just as gone. The escape hatch loops
      on the thing it offers to escape. It has to leave to the MISSING path's
      parent, which is the one place we know still answers.
    */
    const rootDir: UserFilesAnswer = {
      kind: 'dir',
      path: '',
      name: '',
      entries: [{ path: 'reports', name: 'reports', kind: 'dir' }],
      truncated: false,
    };
    let subtreeGone = false;
    userFilesMock.mockImplementation(async (_a: string, relPath: string) => {
      if (relPath === '') return rootDir;
      if (!subtreeGone && relPath === 'reports') {
        return {
          kind: 'dir',
          path: 'reports',
          name: 'reports',
          entries: [{ path: 'reports/deep', name: 'deep', kind: 'dir' }],
          truncated: false,
        } satisfies UserFilesAnswer;
      }
      if (!subtreeGone && relPath === 'reports/deep') {
        return {
          kind: 'dir',
          path: 'reports/deep',
          name: 'deep',
          entries: [],
          truncated: false,
        } satisfies UserFilesAnswer;
      }
      throw new WorkspaceApiError(`/agents/a-quill/user-files/${relPath}`, 404);
    });
    renderTab();
    fireEvent.click(await screen.findByText('reports'));
    fireEvent.click(await screen.findByText('deep'));
    // Standing in `reports/deep`, with `reports` a clickable crumb above us.
    expect(await screen.findByText(/this folder is empty/i)).toBeTruthy();

    subtreeGone = true;
    fireEvent.click(screen.getByRole('button', { name: 'reports' }));
    expect(await screen.findByText(/that folder isn’t here any more/i)).toBeTruthy();

    // `reports/deep` is gone too, so a reload would loop. Leaving must work.
    fireEvent.click(screen.getByRole('button', { name: /go back/i }));
    expect(await screen.findByText('reports')).toBeTruthy();
    expect(screen.queryByText(/that folder isn’t here any more/i)).toBeNull();
  });

  it('drops the breadcrumb when the ROOT read comes back missing', async () => {
    /*
      `dirPath` is the last SUCCESSFUL listing, so walking back to the root and
      having THAT 404 leaves the trail pointing into a folder while the note
      says the agent has put nothing anywhere. Two true sentences that cannot
      both be describing the same screen.
    */
    const root: UserFilesAnswer = {
      kind: 'dir',
      path: '',
      name: '',
      entries: [{ path: 'reports', name: 'reports', kind: 'dir' }],
      truncated: false,
    };
    let rootGone = false;
    userFilesMock.mockImplementation(async (_a: string, relPath: string) => {
      if (relPath === 'reports') {
        return {
          kind: 'dir',
          path: 'reports',
          name: 'reports',
          entries: [],
          truncated: false,
        } satisfies UserFilesAnswer;
      }
      if (rootGone) {
        throw new WorkspaceApiError('/agents/a-quill/user-files', 404);
      }
      return root;
    });
    renderTab();
    fireEvent.click(await screen.findByText('reports'));
    // We are inside the folder: the trail is showing.
    expect(await screen.findByText(/this folder is empty/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Files' })).toBeTruthy();

    rootGone = true;
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    expect(
      await screen.findByText(/Quill hasn’t put any files here yet/i),
    ).toBeTruthy();
    // No trail left pointing into a folder we are no longer claiming to be in.
    expect(screen.queryByRole('button', { name: 'Files' })).toBeNull();
  });

  it('REGRESSION: a 404 walking INTO a folder is not the root being empty', async () => {
    /*
      `dirPath` only moves on a SUCCESSFUL listing, so after a failed step into
      `reports/` it still reads `''`. A root check written against it would
      call this failure the root's and tell the reader Quill has written
      nothing — while the root listing on screen names a folder. The error
      carries the path it is about for exactly this reason.
    */
    durableTree({
      '': {
        kind: 'dir',
        path: '',
        name: '',
        entries: [{ path: 'reports', name: 'reports', kind: 'dir' }],
        truncated: false,
      },
      // `reports` is deliberately absent from the tree, so durableTree 404s it.
    });
    renderTab();
    fireEvent.click(await screen.findByText('reports'));
    expect(
      await screen.findByText(/that folder isn’t here any more/i),
    ).toBeTruthy();
    expect(screen.queryByText(/hasn’t put any files here yet/i)).toBeNull();
  });

  it('says an empty SUBFOLDER is empty — that one is not ambiguous', async () => {
    durableTree({
      '': {
        kind: 'dir',
        path: '',
        name: '',
        entries: [{ path: 'reports', name: 'reports', kind: 'dir' }],
        truncated: false,
      },
      reports: {
        kind: 'dir',
        path: 'reports',
        name: 'reports',
        entries: [],
        truncated: false,
      },
    });
    renderTab();
    fireEvent.click(await screen.findByText('reports'));
    // A listing that SUCCEEDED and came back empty is a fact, not a guess.
    expect(await screen.findByText(/this folder is empty/i)).toBeTruthy();
  });

  it('tells a 503 apart from a blip, and offers no pointless retry', async () => {
    userFilesMock.mockRejectedValue(
      new WorkspaceApiError('/agents/a-quill/user-files', 503),
    );
    renderTab();
    expect(await screen.findByText(/isn’t set up to keep Quill’s files/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
  });

  it('offers a retry on a real failure, and recovers', async () => {
    userFilesMock
      .mockRejectedValueOnce(new WorkspaceApiError('/agents/a-quill/user-files', 500))
      .mockResolvedValueOnce({
        kind: 'dir',
        path: '',
        name: '',
        entries: [{ path: 'out.md', name: 'out.md', kind: 'file' }],
        truncated: false,
      });
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /try again/i }));
    expect(await screen.findByText('out.md')).toBeTruthy();
  });

  it('says out loud when a folder listing was cut short', async () => {
    durableTree({
      '': {
        kind: 'dir',
        path: '',
        name: '',
        entries: [{ path: 'a.md', name: 'a.md', kind: 'file' }],
        truncated: true,
      },
    });
    renderTab();
    expect(
      await screen.findByText(/more files in this folder than we list here/i),
    ).toBeTruthy();
  });

  it('never shows one agent’s files under another agent’s name', async () => {
    userFilesMock.mockResolvedValueOnce({
      kind: 'dir',
      path: '',
      name: '',
      entries: [{ path: 'quill.md', name: 'quill.md', kind: 'file' }],
      truncated: false,
    });
    const { rerender } = renderTab();
    expect(await screen.findByText('quill.md')).toBeTruthy();

    // The second agent's listing never resolves. The first agent's rows must
    // still go away the moment the agent does.
    userFilesMock.mockReturnValueOnce(new Promise(() => undefined));
    rerender(<AgentFiles agentId="a-tern" agentName="Tern" />);
    await waitFor(() => expect(screen.queryByText('quill.md')).toBeNull());
  });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// GETTING THE FILE OUT (TASK-355).
//
// Until this, the tab could show you a file and never hand it to you. The two
// cases that mattered most were the two it could say least about: a PDF
// rendered as the sentence "this one isn't text", and a long file rendered as
// its first 128 KiB. So the affordance is offered for EVERY open file, not
// just the ones we managed to draw.
//
// The other half is the failure. A download that does not happen is a FIFTH
// thing this tab has to tell apart from the four it already does — and it must
// not borrow any of their sentences, because each of those is a claim about
// the agent's files rather than about one click.
// ---------------------------------------------------------------------------
describe('AgentFiles: downloading', () => {
  /**
   * What the browser was actually asked to save.
   *
   * jsdom has no download machinery, so a real `<a download>` click here is
   * both unobservable and noisy ("Not implemented: navigation"). Intercepting
   * the click gives us the two things worth asserting: where the browser was
   * sent, and what the link said about the file's name.
   */
  let saved: Array<{ href: string | null; download: string | null }>;

  beforeEach(() => {
    saved = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
      function (this: HTMLAnchorElement) {
        saved.push({
          href: this.getAttribute('href'),
          download: this.getAttribute('download'),
        });
      },
    );
  });

  /** What the probe hands back for `reports/q3.pdf`: the route itself. */
  const Q3_ROUTE = '/api/workspace/agents/a-quill/download/user-files/reports%2Fq3.pdf';

  /** A one-file tree whose file already answers with `body`. */
  function oneFile(body: {
    body: string | null;
    clipped: 'binary' | 'too-large' | null;
  }) {
    durableTree({
      '': {
        kind: 'dir',
        path: '',
        name: '',
        entries: [{ path: 'reports/q3.pdf', name: 'reports/q3.pdf', kind: 'file' }],
        truncated: false,
      },
      'reports/q3.pdf': {
        kind: 'file',
        path: 'reports/q3.pdf',
        name: 'reports/q3.pdf',
        ...body,
      },
    });
  }

  it('offers a download for a file whose body we could NOT show', async () => {
    // The case the whole card is about. `clipped: 'binary'` is what a PDF an
    // agent made you looks like on this tab, and it used to be the end of the
    // road.
    oneFile({ body: null, clipped: 'binary' });
    downloadMock.mockResolvedValue(Q3_ROUTE);
    renderTab();
    fireEvent.click(await screen.findByText('reports/q3.pdf'));
    const button = await screen.findByRole('button', { name: /download/i });
    expect(screen.getByText(/isn’t text/i)).toBeTruthy();

    fireEvent.click(button);
    await waitFor(() =>
      expect(downloadMock).toHaveBeenCalledWith('a-quill', 'reports/q3.pdf'),
    );
  });

  it('leaves the name to the server: the anchor is the route with an empty download attribute', async () => {
    /*
      The row's label was fenced for a SCREEN; the download name was sanitized
      for a FILESYSTEM and a header, which is a different rule set. Re-deriving
      one from the other in the browser would be a second sanitizer, and two
      sanitizers is the shape where one gets fixed and the other quietly does
      not. So the link names nothing (`download=""`), and the browser takes the
      name the route put on `Content-Disposition` (TASK-1022).
    */
    oneFile({ body: null, clipped: 'binary' });
    downloadMock.mockResolvedValue(Q3_ROUTE);
    renderTab();
    fireEvent.click(await screen.findByText('reports/q3.pdf'));
    fireEvent.click(await screen.findByRole('button', { name: /download/i }));
    await waitFor(() => expect(saved).toEqual([{ href: Q3_ROUTE, download: '' }]));
  });

  it('sends the RAW path, not the fenced label', async () => {
    // Same split as the read: the fenced name is for the screen, the raw key
    // is what addresses the file. Sending the label would 404 on every name
    // that needed fencing.
    const raw = 'inv‮oice.pdf';
    durableTree({
      '': {
        kind: 'dir',
        path: '',
        name: '',
        entries: [{ path: raw, name: 'invoice.pdf', kind: 'file' }],
        truncated: false,
      },
      [raw]: {
        kind: 'file',
        path: raw,
        name: 'invoice.pdf',
        body: null,
        clipped: 'binary',
      },
    });
    downloadMock.mockResolvedValue(
      `/api/workspace/agents/a-quill/download/user-files/${encodeURIComponent(raw)}`,
    );
    renderTab();
    fireEvent.click(await screen.findByText('invoice.pdf'));
    fireEvent.click(await screen.findByRole('button', { name: /download/i }));
    await waitFor(() =>
      expect(downloadMock).toHaveBeenCalledWith('a-quill', raw),
    );
  });

  it('says why a download failed, in a sentence, and says nothing else', async () => {
    /*
      The fifth state. A failed download must NOT reach for any of the other
      four sentences — "Quill has not written anything yet" over a file that is
      listed, on screen, and readable would be a claim about the agent made
      from a click that did not work.
    */
    oneFile({ body: 'plain', clipped: null });
    downloadMock.mockRejectedValue(
      new WorkspaceApiError('/agents/a-quill/download/user-files/reports%2Fq3.pdf', 500),
    );
    renderTab();
    fireEvent.click(await screen.findByText('reports/q3.pdf'));
    fireEvent.click(await screen.findByRole('button', { name: /download/i }));

    expect(await screen.findByText(/download didn’t start/i)).toBeTruthy();
    expect(screen.queryByText(/has not written anything yet/)).toBeNull();
    expect(screen.queryByText(/could not read Quill/i)).toBeNull();
    // The body it DID manage to show is still there — the failure was the
    // handing-over, not the read.
    expect(screen.getByText('plain')).toBeTruthy();
  });

  it('explains a file that is too big for us to pass along', async () => {
    // Not "an error occurred". The person needs to know that we cannot send
    // this one whole and that a fragment would be useless — that is the part
    // that tells them to go ask for a smaller copy.
    oneFile({ body: null, clipped: 'binary' });
    downloadMock.mockRejectedValue(
      new WorkspaceApiError('/agents/a-quill/download/user-files/reports%2Fq3.pdf', 413),
    );
    renderTab();
    fireEvent.click(await screen.findByText('reports/q3.pdf'));
    fireEvent.click(await screen.findByRole('button', { name: /download/i }));
    const said = await screen.findByText(/too big for us to pass along/i);
    expect(said.textContent).toContain('Quill');
    expect(said.textContent).not.toContain('413');
  });

  it('clears the failure when the next attempt is made', async () => {
    // A stale error under a button that is currently working is its own lie.
    oneFile({ body: 'plain', clipped: null });
    downloadMock
      .mockRejectedValueOnce(new WorkspaceApiError('/x', 500))
      .mockResolvedValueOnce(Q3_ROUTE);
    renderTab();
    fireEvent.click(await screen.findByText('reports/q3.pdf'));
    const button = await screen.findByRole('button', { name: /download/i });
    fireEvent.click(button);
    expect(await screen.findByText(/download didn’t start/i)).toBeTruthy();
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByText(/download didn’t start/i)).toBeNull());
  });

  it('disables the button while a download is in flight', async () => {
    // The visible half of the in-flight guard. The invisible half — two calls
    // landing in ONE frame, before this `disabled` can take effect — is not
    // reachable through `fireEvent`, which commits between clicks; it is
    // pinned at the hook level in `lib/__tests__/file-download.test.ts`.
    oneFile({ body: 'plain', clipped: null });
    downloadMock.mockImplementation(async () => new Promise(() => undefined));
    renderTab();
    fireEvent.click(await screen.findByText('reports/q3.pdf'));
    const button = await screen.findByRole('button', { name: /download/i });
    fireEvent.click(button);
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(true));
    expect(button.textContent).toContain('Getting it');
  });

  it('offers nothing to download when no file is open', async () => {
    // The affordance hangs off the open file, so an empty pane has no button
    // to press and nothing to be wrong about.
    durableTree({
      '': {
        kind: 'dir',
        path: '',
        name: '',
        entries: [{ path: 'a.md', name: 'a.md', kind: 'file' }],
        truncated: false,
      },
    });
    renderTab();
    expect(await screen.findByText('a.md')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /download/i })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SWITCHING FILES. Found by review: the download hook's state is per-FILE, and
// the pane that holds it is reused across files unless something says not to.
// ---------------------------------------------------------------------------
describe('AgentFiles: the download state belongs to the file, not to the pane', () => {
  let saved: Array<{ href: string | null; download: string | null }>;

  beforeEach(() => {
    saved = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
      function (this: HTMLAnchorElement) {
        saved.push({
          href: this.getAttribute('href'),
          download: this.getAttribute('download'),
        });
      },
    );
    durableTree({
      '': {
        kind: 'dir',
        path: '',
        name: '',
        entries: [
          { path: 'a.pdf', name: 'a.pdf', kind: 'file' },
          { path: 'b.pdf', name: 'b.pdf', kind: 'file' },
        ],
        truncated: false,
      },
      'a.pdf': { kind: 'file', path: 'a.pdf', name: 'a.pdf', body: null, clipped: 'binary' },
      'b.pdf': { kind: 'file', path: 'b.pdf', name: 'b.pdf', body: null, clipped: 'binary' },
    });
  });

  it('does not carry one file’s download failure onto the next file', async () => {
    /*
      The fifth state is a claim about ONE click on ONE file. Showing it over a
      different file says a download failed that was never attempted — which is
      the same lie as "this agent has written nothing" over files we did not
      read, just pointed at a smaller thing.
    */
    downloadMock.mockRejectedValue(new WorkspaceApiError('/x', 500));
    renderTab();
    fireEvent.click(await screen.findByText('a.pdf'));
    fireEvent.click(await screen.findByRole('button', { name: /download/i }));
    expect(await screen.findByText(/download didn’t start/i)).toBeTruthy();

    fireEvent.click(screen.getByText('b.pdf'));
    await waitFor(() => expect(screen.queryByText(/download didn’t start/i)).toBeNull());
  });

  it('does not let one file’s in-flight download swallow the next file’s click', async () => {
    /*
      The same state, costing something worse than a stale sentence. The
      in-flight guard is deliberately a ref so a second click on the SAME file
      cannot start a second download — and if that ref outlives the file, the
      first click on the NEXT file is silently dropped while its button says
      "Getting it…". A control that does nothing and reports that it is working
      is the worst outcome available here.
    */
    const route = (path: string) =>
      `/api/workspace/agents/a-quill/download/user-files/${path}`;
    let finishA: (() => void) | undefined;
    downloadMock.mockImplementation(async (_a: string, path: string) => {
      if (path === 'a.pdf') {
        return new Promise<string>((resolve) => {
          finishA = () => resolve(route('a.pdf'));
        });
      }
      return route('b.pdf');
    });
    renderTab();
    fireEvent.click(await screen.findByText('a.pdf'));
    fireEvent.click(await screen.findByRole('button', { name: /download/i }));
    await waitFor(() => expect(downloadMock).toHaveBeenCalledTimes(1));

    // A is still in flight. Move to B and ask for it.
    fireEvent.click(screen.getByText('b.pdf'));
    fireEvent.click(await screen.findByRole('button', { name: /^download$/i }));
    await waitFor(() =>
      expect(saved).toEqual([{ href: route('b.pdf'), download: '' }]),
    );
    finishA?.();
  });
});

/*
  TASK-436 — the Files tab clamps in three more places than the rail row that
  already had a `title`: both breadcrumb crumbs, the viewer's filename heading,
  and the full path under it. jsdom has no CSS, so none of these assert the
  clamp; they assert that the string the clamp would hide is still on the
  element, where a hover (and most screen readers) can reach it.
*/
describe('clamped labels in the Files tab (TASK-436)', () => {
  it('puts each breadcrumb crumb in its own `title`', async () => {
    const folder = 'quarterly-review-2026-Q3-regional-breakdown-emea';
    durableTree({
      '': {
        kind: 'dir',
        path: '',
        name: '',
        entries: [{ path: folder, name: folder, kind: 'dir' }],
        truncated: false,
      },
      [folder]: {
        kind: 'dir',
        path: folder,
        name: folder,
        entries: [],
        truncated: false,
      },
    });
    renderTab();
    fireEvent.click(await screen.findByText(folder));
    await screen.findByText(/this folder is empty/i);

    // Standing inside it: `Files` is the clickable crumb, the folder is the
    // current page. Both are clamped, so both have to carry their own value.
    const root = screen.getByRole('button', { name: 'Files' });
    expect(root.getAttribute('title')).toBe('Files');
    const here = screen.getAllByText(folder).find((n) => n.hasAttribute('title'));
    expect(here?.getAttribute('title')).toBe(folder);
  });

  it('puts the viewer filename and its full path in `title`', async () => {
    const path = 'reports/2026-Q3/regional-breakdown-emea-with-adjustments.md';
    durableTree({
      '': {
        kind: 'dir',
        path: '',
        name: '',
        entries: [{ path, name: path, kind: 'file' }],
        truncated: false,
      },
      [path]: { kind: 'file', path, name: path, body: 'rows', clipped: null },
    });
    renderTab();
    fireEvent.click(await screen.findByText(path));
    expect(await screen.findByText('rows')).toBeTruthy();

    // The heading shows the BASENAME and the line under it the whole path, so
    // each carries what IT would hide — not the other one's string.
    const basename = 'regional-breakdown-emea-with-adjustments.md';
    expect(screen.getByText(basename).getAttribute('title')).toBe(basename);
    const full = screen.getAllByText(path).find((n) => n.getAttribute('title') === path);
    expect(full).toBeTruthy();
  });
});
