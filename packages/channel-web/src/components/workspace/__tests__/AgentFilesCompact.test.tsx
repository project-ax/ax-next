/**
 * The Files tab below 768px (TASK-455).
 *
 * The tab is a master-detail: a `w-[260px] shrink-0` list column and a `flex-1`
 * viewer. On a 390px phone the column leaves the viewer 130px, which is not a
 * pane, it is a gutter. It is the fourth fixed-width column in this shell and
 * the one TASK-404 deliberately left alone, because the other three collapse by
 * hiding and both halves of this one are content somebody came here for.
 *
 * WHAT THIS FILE CAN AND CANNOT PIN — the same split `responsive-shell.test.tsx`
 * makes, and for the same measured reason. jsdom applies no CSS and does no
 * layout: `getBoundingClientRect()` is zeroes, media queries never evaluate,
 * and `w-[260px]` is a string nothing reads. So an assertion here about a
 * width, a position, or the spelling of a Tailwind class would pass identically
 * against the unfixed code — a check that cannot fail, wearing the costume of a
 * guard.
 *
 * What is real in jsdom is the TREE, the accessibility names in it, and
 * `document.activeElement`. So this file pins the state machine and nothing
 * else:
 *
 *   - below `md`, exactly ONE of the two panes is mounted at a time;
 *   - opening a FILE crosses to the viewer, opening a FOLDER does not;
 *   - the back control is the only exit and it exists on every viewer state,
 *     including a failed open;
 *   - focus follows the pane, because each crossing unmounts the control that
 *     was pressed;
 *   - above `md` nothing about the two-column layout changed.
 *
 * The geometry is measured in a real browser instead; the before/after numbers
 * are in the PR body.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { workspaceApi, WorkspaceApiError } from '@/lib/workspace-api';
import type { UserFilesAnswer } from '@/lib/workspace-types';
import { AgentFiles } from '../AgentFiles';
import { clearViewport, setViewport } from './viewport';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '@/lib/workspace-api',
  );
  return {
    ...actual,
    workspaceApi: {
      files: vi.fn(),
      file: vi.fn(),
      userFiles: vi.fn(),
      downloadFile: vi.fn(),
    },
  };
});

const filesMock = vi.mocked(workspaceApi.files);
const fileMock = vi.mocked(workspaceApi.file);
const userFilesMock = vi.mocked(workspaceApi.userFiles);

function renderTab(agentId = 'a-quill') {
  return render(<AgentFiles agentId={agentId} agentName="Quill" />);
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
  /*
    Unless a test says otherwise the durable tier answers 503 — the quiet
    answer, and the same default `AgentFiles.test.tsx` takes: a deployment with
    no durable backend makes no claim about the agent and adds no buttons the
    assertions would have to step around.
  */
  userFilesMock.mockRejectedValue(
    new WorkspaceApiError('/agents/a-quill/user-files', 503),
  );
  filesMock.mockResolvedValue({
    files: [
      { path: 'notes.md', name: 'notes.md' },
      { path: 'q3.csv', name: 'q3.csv' },
    ],
    truncated: false,
  });
  fileMock.mockResolvedValue({
    path: 'notes.md',
    name: 'notes.md',
    body: 'the body of the file',
    clipped: null,
  });
});

afterEach(() => {
  clearViewport();
  vi.restoreAllMocks();
});

describe('the Files tab below md', () => {
  it('opens on the LIST, not on an empty viewer telling you to pick a file', async () => {
    /*
      The whole argument against the Sheet pattern TASK-404 used for the rail,
      in one assertion. The rail is supplementary and the conversation stays on
      screen behind it; here the list IS the page until a file is open, so a
      viewer-first phone layout would land a first-timer on a blank pane reading
      "Pick a file to read it." with no files anywhere on it.
    */
    setViewport(true);
    renderTab();

    expect(await screen.findByRole('button', { name: 'notes.md' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Agent workspace' })).toBeTruthy();
    expect(screen.queryByText(/pick a file to read it/i)).toBeNull();
  });

  it('gives the viewer the whole screen once you open a file', async () => {
    setViewport(true);
    renderTab();

    fireEvent.click(await screen.findByRole('button', { name: 'notes.md' }));

    // The body is up…
    expect(await screen.findByText('the body of the file')).toBeTruthy();
    // …and the 260px column is not beside it. This is the assertion the card
    // is about: at 390px the two cannot both be on screen.
    expect(screen.queryByRole('button', { name: 'q3.csv' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Agent workspace' })).toBeNull();
  });

  it('comes back to the list, at the same folder, with the file still marked', async () => {
    /*
      Back clears the PANE, not the selection. The row you were reading is
      still the highlighted one when the list returns, so "where was I" is
      answered by the screen rather than by memory.
    */
    setViewport(true);
    durableTree({
      '': {
        kind: 'dir',
        path: '',
        name: '',
        entries: [
          { path: 'reports', name: 'reports', kind: 'dir' },
          { path: 'reports/q3.md', name: 'q3.md', kind: 'file' },
        ],
        truncated: false,
      },
      reports: {
        kind: 'dir',
        path: 'reports',
        name: 'reports',
        entries: [{ path: 'reports/q3.md', name: 'q3.md', kind: 'file' }],
        truncated: false,
      },
      'reports/q3.md': {
        kind: 'file',
        path: 'reports/q3.md',
        name: 'q3.md',
        body: 'third quarter',
        clipped: null,
      },
    });
    renderTab();

    // Walk into a folder, then open a file from inside it.
    fireEvent.click(await screen.findByRole('button', { name: 'reports' }));
    fireEvent.click(await screen.findByRole('button', { name: 'q3.md' }));
    expect(await screen.findByText('third quarter')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    // The list is back, and it is back at `reports/`, not at the root — which
    // is why the control says "Back" rather than naming a destination.
    const row = await screen.findByRole('button', { name: 'q3.md' });
    expect(screen.queryByRole('button', { name: 'reports' })).toBeNull();
    // Still selected. A class assertion, which is the one class assertion that
    // is NOT vacuous here: this one is written by the component's own state,
    // not by a stylesheet jsdom never loads.
    expect(row.className).toContain('bg-primary-soft');
  });

  it('treats a folder as navigation, not as a drill-in — even with a file still selected', async () => {
    /*
      Two motions that are both one tap. Stepping into `reports/` re-lists in
      place; only a FILE crosses to the viewer. Conflating them would put the
      reader in the viewer every time they tried to navigate.

      WHAT THIS TEST IS WORTH, measured rather than assumed. "A folder tap
      cannot reach the viewer" is enforced TWICE over: `showViewer` is
      `drilledIn && hasSelection`, and `useAgentUserFiles.openDir` independently
      clears the open file on the way into a folder. So each half alone is an
      EQUIVALENT mutation — setting the drill-in latch on the folder branch too,
      or routing dir rows through `selectDurable`, both leave all nine of these
      tests green, because the other half still holds the pane down. Only
      breaking BOTH (latch on the folder branch AND `openDir` no longer clearing
      the selection) actually reopens the viewer, and this is the one test in
      the file that goes red when it does.

      Which is why it is written as Back-then-navigate rather than as a folder
      tap from a clean start. From a clean start `hasSelection` is false and the
      pane could not appear however wrong the latch was — the assertion would be
      proving the selection is empty, not that a folder is navigation. Coming
      back from the viewer leaves the selection standing ON PURPOSE (see the
      test above), which is both the state where the two conjuncts can disagree
      and the state a reader is really in when they press Back and then go
      looking somewhere else.
    */
    setViewport(true);
    durableTree({
      '': {
        kind: 'dir',
        path: '',
        name: '',
        entries: [
          { path: 'reports', name: 'reports', kind: 'dir' },
          { path: 'inbox.md', name: 'inbox.md', kind: 'file' },
        ],
        truncated: false,
      },
      'inbox.md': {
        kind: 'file',
        path: 'inbox.md',
        name: 'inbox.md',
        body: 'the inbox body',
        clipped: null,
      },
      reports: {
        kind: 'dir',
        path: 'reports',
        name: 'reports',
        entries: [{ path: 'reports/q3.md', name: 'q3.md', kind: 'file' }],
        truncated: false,
      },
    });
    renderTab();

    // Open a file, then come back — the selection survives the trip.
    fireEvent.click(await screen.findByRole('button', { name: 'inbox.md' }));
    expect(await screen.findByText('the inbox body')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    // Now navigate. `hasSelection` is still true, so the ONLY thing keeping
    // the viewer down is that a folder does not set the drill-in latch.
    fireEvent.click(await screen.findByRole('button', { name: 'reports' }));

    expect(await screen.findByRole('button', { name: 'q3.md' })).toBeTruthy();
    // Still on the list: the other section is beside it and there is nothing
    // to go back FROM.
    expect(screen.getByRole('heading', { name: 'Agent workspace' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    expect(screen.queryByText('the inbox body')).toBeNull();
  });

  it('keeps the way out on a viewer that could not open the file', async () => {
    /*
      The list is unmounted, so this control is the ENTIRE exit. Tying it to a
      successful body render would leave a failed open as a screen with an
      error on it and nothing to press — which is why it lives above
      `FileViewer` rather than inside its branches.
    */
    setViewport(true);
    fileMock.mockRejectedValue(new WorkspaceApiError('/agents/a-quill/file', 500));
    renderTab();

    fireEvent.click(await screen.findByRole('button', { name: 'notes.md' }));

    expect(await screen.findByText(/could not open that file/i)).toBeTruthy();
    const back = screen.getByRole('button', { name: 'Back' });

    fireEvent.click(back);
    expect(await screen.findByRole('button', { name: 'q3.csv' })).toBeTruthy();
  });

  it('moves focus with the pane, in both directions', async () => {
    /*
      Each crossing UNMOUNTS the control that was pressed, so without this
      `document.activeElement` falls back to `<body>` and a keyboard or
      screen-reader user is dropped at the top of the document on every tap.
      Going in lands on the way out; coming back lands on the row you came
      from.

      This is checked with `waitFor` because the pane arrives on the file read
      rather than on the click, and the focus lands in the same commit that
      mounts it (`useLayoutEffect`, TASK-451 — a passive effect would leave a
      real window where the target is mounted and focus is still on `<body>`).
    */
    setViewport(true);
    renderTab();

    const row = await screen.findByRole('button', { name: 'notes.md' });
    fireEvent.click(row);

    const back = await screen.findByRole('button', { name: 'Back' });
    await waitFor(() => expect(document.activeElement).toBe(back));

    fireEvent.click(back);

    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'notes.md' }),
      ),
    );
  });

  it('returns to the list when the selection is dropped under it', async () => {
    /*
      "Showing the viewer" is a preference; having something to show is the
      truth, and the render requires both. A new agent is a new workspace and
      both file hooks drop their selection on the switch — without the second
      half of that condition the reader would be left on a pane with no file in
      it and a back button, which is a dead end reached by doing nothing wrong.
    */
    setViewport(true);
    const { rerender } = renderTab();

    fireEvent.click(await screen.findByRole('button', { name: 'notes.md' }));
    expect(await screen.findByText('the body of the file')).toBeTruthy();

    filesMock.mockResolvedValue({
      files: [{ path: 'other.md', name: 'other.md' }],
      truncated: false,
    });
    rerender(<AgentFiles agentId="a-other" agentName="Quill" />);

    expect(await screen.findByRole('button', { name: 'other.md' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
  });
});

describe('the Files tab above md', () => {
  it('is still the two-column master-detail it always was', async () => {
    setViewport(false);
    renderTab();

    // Both panes at once, which is the whole point of the desktop layout…
    expect(await screen.findByRole('button', { name: 'notes.md' })).toBeTruthy();
    expect(screen.getByText(/pick a file to read it/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'notes.md' }));
    expect(await screen.findByText('the body of the file')).toBeTruthy();

    // …and the list does not go anywhere when a file opens, so there is
    // nothing to come back from and no control offering to.
    expect(screen.getByRole('button', { name: 'q3.csv' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
  });

  it('leaves focus where the reader put it', async () => {
    /*
      The counterpart to the focus test above, and the reason that one is
      gated on a CHANGE in which pane is showing rather than on its value:
      above `md` nothing is unmounted by opening a file, so nothing needs
      rescuing and moving focus would be taking it from the reader.
    */
    setViewport(false);
    renderTab();

    const row = await screen.findByRole('button', { name: 'notes.md' });
    row.focus();
    fireEvent.click(row);

    expect(await screen.findByText('the body of the file')).toBeTruthy();
    expect(document.activeElement).toBe(row);
  });
});
