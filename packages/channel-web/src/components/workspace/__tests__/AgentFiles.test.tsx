/**
 * The Files tab (plan task AW-12), now showing BOTH tiers.
 *
 * What is under test is almost entirely HONESTY. There are four different
 * reasons a section of this tab can be empty, and only ONE of them is a
 * statement about the agent:
 *
 *   1. the listing failed,
 *   2. no backend for that tier is running at all,
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
 * The tab now reads TWO tiers — the durable user-files tier (the agent's cwd,
 * a tree) and the git-backed workspace (a flat list) — from two different
 * backends. So the honesty rules are asserted PER SECTION, and there is a test
 * that one tier failing does not blank the other: they are separate backends
 * and one being down says nothing about the other.
 *
 * Every governed-tier test below stubs the durable read as a 503, so the
 * assertions are about the section under test and not about whichever section
 * happened to render first.
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
    workspaceApi: { files: vi.fn(), file: vi.fn(), userFiles: vi.fn() },
  };
});

const filesMock = vi.mocked(workspaceApi.files);
const fileMock = vi.mocked(workspaceApi.file);
const userFilesMock = vi.mocked(workspaceApi.userFiles);

function renderTab() {
  return render(<AgentFiles agentId="a-quill" agentName="Quill" />);
}

/** One durable-tier directory listing, keyed by raw path. */
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
  filesMock.mockReset();
  fileMock.mockReset();
  userFilesMock.mockReset();
  // The governed-tier tests are not about the durable tier. 503 is the quiet
  // answer: a deployment with no durable backend, no retry button, no claim
  // about the agent.
  userFilesMock.mockRejectedValue(
    new WorkspaceApiError('/agents/a-quill/user-files', 503),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AgentFiles', () => {
  it('lists what the agent has written', async () => {
    filesMock.mockResolvedValue({
      files: [
        { path: 'notes/plan.md', name: 'notes/plan.md' },
        { path: 'q3.csv', name: 'q3.csv' },
      ],
      truncated: false,
    });
    renderTab();
    expect(await screen.findByText('notes/plan.md')).toBeTruthy();
    expect(screen.getByText('q3.csv')).toBeTruthy();
    // Nothing is open, so nothing is claimed about any file's contents.
    expect(screen.getByText(/pick a file to read it/i)).toBeTruthy();
  });

  it('says the agent has written nothing ONLY after a listing that worked', async () => {
    filesMock.mockResolvedValue({ files: [], truncated: false });
    renderTab();
    expect(await screen.findByText(/Quill has not written anything yet/)).toBeTruthy();
  });

  it('says "we could not read it" instead — never "nothing yet" — on a failure', async () => {
    filesMock.mockRejectedValue(new WorkspaceApiError('/agents/a-quill/files', 500));
    renderTab();
    expect(await screen.findByText(/could not read Quill/i)).toBeTruthy();
    expect(screen.queryByText(/has not written anything yet/)).toBeNull();
    // A failure the reader can act on gets a button. This one can.
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
  });

  it('retries the listing when asked, and recovers', async () => {
    filesMock
      .mockRejectedValueOnce(new WorkspaceApiError('/agents/a-quill/files', 500))
      .mockResolvedValueOnce({
        files: [{ path: 'report.md', name: 'report.md' }],
        truncated: false,
      });
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /try again/i }));
    expect(await screen.findByText('report.md')).toBeTruthy();
  });

  it('tells a 503 apart from a blip, and offers no pointless retry', async () => {
    /*
      503 means this deployment is not running a workspace backend. "Try again"
      would send someone clicking at something that is never going to change,
      so the button is absent and the sentence is different.
    */
    filesMock.mockRejectedValue(new WorkspaceApiError('/agents/a-quill/files', 503));
    renderTab();
    expect(await screen.findByText(/can’t reach Quill’s workspace/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
  });

  it('says it is loading rather than claiming the agent wrote nothing', async () => {
    filesMock.mockReturnValue(new Promise(() => undefined));
    renderTab();
    // `getAllBy`: on the first tick BOTH sections are still loading, and both
    // saying so is the point — neither is allowed to guess early.
    expect(screen.getAllByText(/loading/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/has not written anything yet/)).toBeNull();
  });

  it('says out loud when the listing was cut short', async () => {
    filesMock.mockResolvedValue({
      files: [{ path: 'a.md', name: 'a.md' }],
      truncated: true,
    });
    renderTab();
    expect(await screen.findByText(/has more files than we list here/i)).toBeTruthy();
  });

  it('opens a file with the RAW path as the key and draws the FENCED name', async () => {
    // The server fenced the label; the key it handed back is the raw one. The
    // tab must send the key back untouched, or the read 404s — and it must
    // never draw the key, or the bidi override lands on the screen.
    const raw = 'inv\u202Eoice.md';
    filesMock.mockResolvedValue({
      files: [{ path: raw, name: 'invoice.md' }],
      truncated: false,
    });
    fileMock.mockResolvedValue({
      path: raw,
      name: 'invoice.md',
      body: 'paid',
      clipped: null,
    });
    renderTab();
    fireEvent.click(await screen.findByText('invoice.md'));
    await waitFor(() => expect(fileMock).toHaveBeenCalledWith('a-quill', raw));
    expect(await screen.findByText('paid')).toBeTruthy();
    expect(screen.queryByText(raw)).toBeNull();
  });

  it('renders a markdown body as a document, with images refusing to load', async () => {
    filesMock.mockResolvedValue({
      files: [{ path: 'plan.md', name: 'plan.md' }],
      truncated: false,
    });
    fileMock.mockResolvedValue({
      path: 'plan.md',
      name: 'plan.md',
      body: '# Ship it\n\n![a tracking pixel](https://evil.example/p.gif)',
      clipped: null,
    });
    const { container } = renderTab();
    fireEvent.click(await screen.findByText('plan.md'));
    expect(await screen.findByRole('heading', { name: 'Ship it' })).toBeTruthy();
    /*
      And it is STYLED. The `prose-*` utilities on the container emit no CSS —
      @tailwindcss/typography is not installed — so `.ax-md` in index.css is
      what stops a rendered file from inheriting Preflight and coming out with
      body-sized headings and unmarked lists. Without this assertion the class
      is invisible to the suite and a tidy-up deletes it.
    */
    expect(container.querySelector('.ax-md')).toBeTruthy();
    // A remote <img> in a file body is an outbound request the reader's
    // browser makes on the file author's behalf. The alt text survives.
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('a tracking pixel')).toBeTruthy();
  });

  it('renders anything that is not markdown as source, not as a document', async () => {
    filesMock.mockResolvedValue({
      files: [{ path: 'main.py', name: 'main.py' }],
      truncated: false,
    });
    fileMock.mockResolvedValue({
      path: 'main.py',
      name: 'main.py',
      // Run through a markdown parser this becomes an <h1> and a lost newline.
      body: '# a comment\nprint("hi")',
      clipped: null,
    });
    const { container } = renderTab();
    fireEvent.click(await screen.findByText('main.py'));
    await waitFor(() => expect(container.querySelector('pre')).toBeTruthy());
    expect(container.querySelector('h1')).toBeNull();
    expect(container.querySelector('pre')?.textContent).toBe(
      '# a comment\nprint("hi")',
    );
  });

  it('says a binary file is not text instead of showing mojibake', async () => {
    filesMock.mockResolvedValue({
      files: [{ path: 'chart.png', name: 'chart.png' }],
      truncated: false,
    });
    fileMock.mockResolvedValue({
      path: 'chart.png',
      name: 'chart.png',
      body: null,
      clipped: 'binary',
    });
    renderTab();
    fireEvent.click(await screen.findByText('chart.png'));
    expect(await screen.findByText(/isn’t text/i)).toBeTruthy();
  });

  it('says a long file was cut short rather than passing the excerpt off as the file', async () => {
    filesMock.mockResolvedValue({
      files: [{ path: 'log.txt', name: 'log.txt' }],
      truncated: false,
    });
    fileMock.mockResolvedValue({
      path: 'log.txt',
      name: 'log.txt',
      body: 'line one',
      clipped: 'too-large',
    });
    renderTab();
    fireEvent.click(await screen.findByText('log.txt'));
    expect(await screen.findByText(/showing the beginning of it/i)).toBeTruthy();
  });

  it('reports a failed OPEN without blaming the listing', async () => {
    filesMock.mockResolvedValue({
      files: [{ path: 'gone.md', name: 'gone.md' }],
      truncated: false,
    });
    fileMock.mockRejectedValue(
      new WorkspaceApiError('/agents/a-quill/files/gone.md', 404),
    );
    renderTab();
    fireEvent.click(await screen.findByText('gone.md'));
    expect(await screen.findByText(/could not open that file/i)).toBeTruthy();
    // The list is still there — one unreadable file is not a broken tab.
    // (`getAllByText`: the name appears in the row AND in the viewer heading.)
    expect(screen.getAllByText('gone.md').length).toBeGreaterThan(0);
  });

  it('never shows one agent’s files under another agent’s name', async () => {
    filesMock.mockResolvedValueOnce({
      files: [{ path: 'quill.md', name: 'quill.md' }],
      truncated: false,
    });
    const { rerender } = renderTab();
    expect(await screen.findByText('quill.md')).toBeTruthy();

    // The second agent's listing never resolves. The first agent's rows must
    // still go away the moment the agent does.
    filesMock.mockReturnValueOnce(new Promise(() => undefined));
    rerender(<AgentFiles agentId="a-tern" agentName="Tern" />);
    await waitFor(() => expect(screen.queryByText('quill.md')).toBeNull());
  });
});

// ---------------------------------------------------------------------------
// The DURABLE tier — the agent's cwd and HOME, and the half of this tab that
// did not exist before. It is a TREE: the backing hook answers one directory
// at a time, so walking in and back out is a real behavior with its own bugs.
// ---------------------------------------------------------------------------
describe('AgentFiles: the durable user-files tier', () => {
  beforeEach(() => {
    // These tests are not about the governed tier; keep it quiet and empty.
    filesMock.mockResolvedValue({ files: [], truncated: false });
  });

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
    // Same rule as the other tier: the key goes back on the wire untouched,
    // and the fenced label is the only one that reaches the screen. On this
    // tier nothing has been through a git commit, so the bidi override
    // (CVE-2021-42574) is if anything more likely to be there.
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

  it('names BOTH possibilities at the root rather than blaming the agent', async () => {
    /*
      The ambiguous case, and the reason it gets its own test. The backing hook
      answers `absent` for "no durable tier here" AND for "nothing written
      yet", deliberately — distinguishing them on a mount that holds every
      tenant would be an oracle. So the UI must not pick one. Saying "Quill
      hasn't written anything" over a deployment that stores nothing is exactly
      the H7 lie this tab exists to stop telling.
    */
    userFilesMock.mockRejectedValue(
      new WorkspaceApiError('/agents/a-quill/user-files', 404),
    );
    renderTab();
    const note = await screen.findByText(/we can’t tell which from here/i);
    expect(note.textContent).toMatch(/hasn’t written any yet/);
    expect(note.textContent).toMatch(/isn’t keeping them/);
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
// The two tiers are two backends. One being down says nothing about the other,
// and the tab must not act as though it did — the old whole-page error branch
// would have blanked a perfectly readable tier.
// ---------------------------------------------------------------------------
describe('AgentFiles: the two tiers fail independently', () => {
  it('shows the durable tier even when the governed listing failed', async () => {
    filesMock.mockRejectedValue(new WorkspaceApiError('/agents/a-quill/files', 500));
    durableTree({
      '': {
        kind: 'dir',
        path: '',
        name: '',
        entries: [{ path: 'deliverable.md', name: 'deliverable.md', kind: 'file' }],
        truncated: false,
      },
    });
    renderTab();
    // Both true at once: the failure is reported AND the readable tier is read.
    expect(await screen.findByText('deliverable.md')).toBeTruthy();
    expect(screen.getByText(/could not read Quill’s workspace/i)).toBeTruthy();
  });

  it('shows the governed tier even when the durable read failed', async () => {
    userFilesMock.mockRejectedValue(
      new WorkspaceApiError('/agents/a-quill/user-files', 500),
    );
    filesMock.mockResolvedValue({
      files: [{ path: 'committed.md', name: 'committed.md' }],
      truncated: false,
    });
    renderTab();
    expect(await screen.findByText('committed.md')).toBeTruthy();
    expect(screen.getByText(/could not read Quill’s files/i)).toBeTruthy();
  });
});
