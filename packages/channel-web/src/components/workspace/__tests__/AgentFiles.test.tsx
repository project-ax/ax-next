/**
 * The Files tab (plan task AW-12).
 *
 * What is under test is almost entirely HONESTY. There are four different
 * reasons the middle of this tab can be empty, and only ONE of them is a
 * statement about the agent:
 *
 *   1. the listing failed,
 *   2. no workspace backend is running at all,
 *   3. the listing has not come back yet,
 *   4. the agent genuinely has not written anything.
 *
 * The prototype could only ever say (4), because `files: []` arrived inside the
 * agent-detail response and an empty array cannot carry a reason. So "has not
 * written anything yet" got rendered over failed reads. These tests pin all
 * four apart, and pin the two things about untrusted content the tab must not
 * get wrong: the fenced LABEL is what is drawn, and a markdown body is
 * rendered without loading remote images.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { workspaceApi, WorkspaceApiError } from '@/lib/workspace-api';
import { AgentFiles } from '../AgentFiles';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '@/lib/workspace-api',
  );
  return {
    ...actual,
    workspaceApi: { files: vi.fn(), file: vi.fn() },
  };
});

const filesMock = vi.mocked(workspaceApi.files);
const fileMock = vi.mocked(workspaceApi.file);

function renderTab() {
  return render(<AgentFiles agentId="a-quill" agentName="Quill" />);
}

beforeEach(() => {
  filesMock.mockReset();
  fileMock.mockReset();
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
    expect(screen.getByText(/loading/i)).toBeTruthy();
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
