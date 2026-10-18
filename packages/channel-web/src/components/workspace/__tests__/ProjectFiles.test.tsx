/**
 * W3b — a project's files in the workspace UI (W3 spec §5.3): the files card
 * on the project page and the full-page browser at
 * `/workspace/projects/:id/files/*`.
 *
 * Through the real shell, because most of what matters here is wiring: a card
 * row is a link to the browser's URL, the browser follows the URL (so Back and
 * a shared link both work), and a project that is gone says so before any
 * file is asked for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { workspaceApi, WorkspaceApiError, type AgentDetail } from '@/lib/workspace-api';
import { UserProvider } from '@/lib/user-context';
import type { UserFileEntry, UserFilesAnswer } from '@/lib/workspace-types';
import type { ProjectDetail, ProjectSummary } from '@/wire/projects';
import { WorkspaceShell } from '../WorkspaceShell';
import { rail as railFixture } from './rail-fixture';
import { clearViewport, setViewport } from './viewport';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspace-api');
  return {
    ...actual,
    workspaceApi: {
      board: vi.fn(),
      agent: vi.fn(),
      route: vi.fn(),
      activity: vi.fn(),
      decisions: vi.fn(),
      approveDecision: vi.fn(),
      dismissDecision: vi.fn(),
      undoDecision: vi.fn(),
      grants: vi.fn(async () => ({ grants: [] })),
      rail: vi.fn(async () => railFixture()),
      revokeGrant: vi.fn(),
      saveRules: vi.fn(),
      recallMemory: vi.fn(),
      memoryEvents: vi.fn(() => new Promise(() => {})),
      correctMemory: vi.fn(),
      forgetMemory: vi.fn(),
      unforgetMemory: vi.fn(),
      connectors: vi.fn(async () => ({ connectors: [], shared: false, manageable: true, sharedCredentials: false, connectorsSupported: true })),
      abilities: vi.fn(async () => ({ abilities: {} })),
      sendMessage: vi.fn(),
      // A reply that never ends: these tests are about where the turn went.
      streamReply: vi.fn(() => new Promise(() => {})),
      listProjects: vi.fn(),
      createProject: vi.fn(),
      getProject: vi.fn(),
      updateProject: vi.fn(),
      deleteProject: vi.fn(),
      listProjectConversations: vi.fn(),
      ownerCandidates: vi.fn(),
      projectFiles: vi.fn(),
      downloadProjectFile: vi.fn(),
    },
  };
});

const api = vi.mocked(workspaceApi);

const user = { id: 'u1', email: 'u@example.com', name: 'Uma', role: 'user' as const };

const QUILL = {
  id: 'a-quill',
  name: 'Quill',
  state: 'resting' as const,
  now: null,
  counter: null,
  startedAt: null,
  stoppedReason: null,
};

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

function summary(over: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    projectId: 'p1',
    name: 'Q4 launch',
    description: 'Ship the launch.\nSecond line stays off the card.',
    updatedAt: hoursAgo(2),
    members: [{ agentId: 'a-quill', role: 'owner' }],
    ...over,
  };
}

function detail(over: Partial<ProjectDetail> = {}): ProjectDetail {
  return {
    projectId: 'p1',
    name: 'Q4 launch',
    description: 'Ship the launch.',
    createdAt: hoursAgo(48),
    updatedAt: hoursAgo(2),
    members: [{ agentId: 'a-quill', role: 'owner', displayName: 'Quill' }],
    canManage: true,
    ...over,
  };
}

function agentDetail(over: Partial<AgentDetail> = {}): AgentDetail {
  return {
    agent: QUILL,
    conversationId: 'c-current',
    thread: [],
    decisions: { status: 'ok' },
    past: [],
    memory: { rules: { status: 'unavailable', doc: null } },
    ...over,
  } as AgentDetail;
}

function renderAt(path: string) {
  window.history.replaceState(null, '', path);
  return render(
    <UserProvider value={user}>
      <WorkspaceShell />
    </UserProvider>,
  );
}


// ---- the folder ------------------------------------------------------------

const dir = (path: string, entries: UserFileEntry[], truncated = false): UserFilesAnswer => ({
  kind: 'dir',
  path,
  name: path,
  entries,
  truncated,
});
const fileEntry = (path: string, over: Partial<UserFileEntry> = {}): UserFileEntry => ({
  path,
  name: path.slice(path.lastIndexOf('/') + 1),
  kind: 'file',
  ...over,
});
const dirEntry = (path: string): UserFileEntry => ({ path, name: path, kind: 'dir' });

const HUGE = 24_500_000; // "23.4 MB"

const FOLDER: Record<string, UserFilesAnswer> = {
  '': dir('', [
    fileEntry('instructions.md', { updatedAt: hoursAgo(2), size: 120 }),
    dirEntry('memory'),
    dirEntry('work'),
  ]),
  memory: dir('memory', [
    fileEntry('memory/status.md'),
    fileEntry('memory/decisions.md'),
    fileEntry('memory/people.md'),
  ]),
  work: dir('work', [
    fileEntry('work/plan.md'),
    fileEntry('work/notes.txt'),
    fileEntry('work/chart.png'),
    fileEntry('work/huge.log', { size: HUGE }),
  ]),
  'instructions.md': { kind: 'file', path: 'instructions.md', name: 'instructions.md', body: 'Be brief.', clipped: null, size: 9, downloadable: true },
  'work/plan.md': { kind: 'file', path: 'work/plan.md', name: 'work/plan.md', body: '# Launch plan\n\nShip it.', clipped: null, size: 24, downloadable: true },
  'work/notes.txt': { kind: 'file', path: 'work/notes.txt', name: 'work/notes.txt', body: '# not a heading', clipped: null, size: 15, downloadable: true },
  'work/chart.png': { kind: 'file', path: 'work/chart.png', name: 'work/chart.png', body: null, clipped: 'binary', size: 2048, downloadable: true },
  'work/huge.log': { kind: 'file', path: 'work/huge.log', name: 'work/huge.log', body: 'line 1', clipped: 'too-large', size: HUGE, downloadable: false },
};

function serveFolder(folder: Record<string, UserFilesAnswer> = FOLDER) {
  api.projectFiles.mockImplementation(async (_projectId: string, path: string) => {
    const answer = folder[path];
    if (answer === undefined) throw new WorkspaceApiError(`/projects/p1/files/${path}`, 404);
    return answer;
  });
}


const main = () => screen.getByRole('main');

/** Render the shell at `path` and wait for its frame to be up. */
async function openAt(path: string) {
  renderAt(path);
  await screen.findByRole('main');
}

/** The five card rows, as "label detail" lines, in order. */
async function cardRows(): Promise<string[]> {
  const list = await screen.findByRole('list', { name: 'Project files' });
  await waitFor(() => expect(list.querySelector('[data-slot="skeleton"], .animate-pulse')).toBeNull());
  return within(list)
    .getAllByRole('listitem')
    .map((li) =>
      Array.from(li.querySelectorAll('span'))
        .map((el) => el.textContent ?? '')
        .join(' '),
    );
}

let saved: string[];

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  vi.clearAllMocks();
  api.board.mockResolvedValue({ agents: [QUILL] } as never);
  api.agent.mockResolvedValue(agentDetail());
  api.activity.mockResolvedValue({ events: [], nextBefore: null } as never);
  api.decisions.mockResolvedValue({ decisions: [] } as never);
  api.grants.mockResolvedValue({ grants: [] } as never);
  api.rail.mockResolvedValue(railFixture() as never);
  api.connectors.mockResolvedValue({ connectors: [], shared: false, manageable: true, sharedCredentials: false, connectorsSupported: true } as never);
  api.abilities.mockResolvedValue({ abilities: {} } as never);
  api.memoryEvents.mockImplementation(() => new Promise(() => {}) as never);
  api.streamReply.mockImplementation(() => new Promise(() => {}) as never);
  api.listProjects.mockResolvedValue({ projects: [summary()] });
  api.getProject.mockResolvedValue(detail());
  api.listProjectConversations.mockResolvedValue({ conversations: [] });
  api.ownerCandidates.mockResolvedValue({ agents: [{ agentId: 'a-quill', displayName: 'Quill' }] });
  serveFolder();
  saved = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    saved.push(this.download);
  });
});

afterEach(() => {
  clearViewport();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('the files card', () => {
  it('lists the five places in a fixed order, with counts, times and empties', async () => {
    await openAt('/workspace/projects/p1');
    expect(await cardRows()).toEqual([
      'Instructions Updated 2h ago',
      'Memory 3 items',
      'Playbooks Empty',
      'Sources Empty',
      'Work 4 items',
    ]);
    // One root listing plus one per folder that exists — nothing for the
    // folders that don't.
    expect(api.projectFiles.mock.calls.map((c) => c[1]).sort()).toEqual(['', 'memory', 'work']);
  });

  it('makes the rows that exist links into the browser, and the empty ones not', async () => {
    await openAt('/workspace/projects/p1');
    await cardRows();
    const list = screen.getByRole('list', { name: 'Project files' });
    expect(within(list).getByRole('link', { name: /Memory/ }).getAttribute('href')).toBe(
      '/workspace/projects/p1/files/memory',
    );
    expect(within(list).getByRole('link', { name: /Instructions/ }).getAttribute('href')).toBe(
      '/workspace/projects/p1/files/instructions.md',
    );
    expect(within(list).queryByRole('link', { name: /Playbooks/ })).toBeNull();
    expect(within(list).queryByRole('link', { name: /Sources/ })).toBeNull();
  });

  it('counts a cut-short folder as "N+ items" and an empty one as Empty', async () => {
    serveFolder({
      ...FOLDER,
      memory: dir('memory', [fileEntry('memory/a.md'), fileEntry('memory/b.md')], true),
      work: dir('work', []),
    });
    await openAt('/workspace/projects/p1');
    const rows = await cardRows();
    expect(rows[1]).toBe('Memory 2+ items');
    expect(rows[4]).toBe('Work Empty');
  });

  it('shows every row empty when the folder has nothing in it yet', async () => {
    serveFolder({});
    await openAt('/workspace/projects/p1');
    expect(await cardRows()).toEqual([
      'Instructions Empty',
      'Memory Empty',
      'Playbooks Empty',
      'Sources Empty',
      'Work Empty',
    ]);
  });

  it('says one quiet line when this server has no project files', async () => {
    api.projectFiles.mockRejectedValue(new WorkspaceApiError('/projects/p1/files', 503));
    await openAt('/workspace/projects/p1');
    expect(await screen.findByText('Files aren’t available on this server.')).toBeTruthy();
    // Quiet: no alert, no retry, no way into a browser that can't work.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Browse all files' })).toBeNull();
  });

  it('offers a retry when the read failed, and recovers', async () => {
    api.projectFiles.mockRejectedValueOnce(new WorkspaceApiError('/projects/p1/files', 500));
    await openAt('/workspace/projects/p1');
    expect(await screen.findByText('We couldn’t load the files just now.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect((await cardRows())[1]).toBe('Memory 3 items');
  });

  it('opens the browser at a row’s path, and at the root from "Browse all files"', async () => {
    await openAt('/workspace/projects/p1');
    await cardRows();
    fireEvent.click(within(screen.getByRole('list', { name: 'Project files' })).getByRole('link', { name: /Memory/ }));
    expect(window.location.pathname).toBe('/workspace/projects/p1/files/memory');
    expect(await within(main()).findByRole('button', { name: 'status.md' })).toBeTruthy();

    fireEvent.click(within(main()).getByRole('link', { name: 'Files' }));
    expect(window.location.pathname).toBe('/workspace/projects/p1/files');
    expect(await within(main()).findByRole('button', { name: 'instructions.md' })).toBeTruthy();
  });

  it('“Browse all files” is a real link to the root', async () => {
    await openAt('/workspace/projects/p1');
    const link = await screen.findByRole('link', { name: 'Browse all files' });
    expect(link.getAttribute('href')).toBe('/workspace/projects/p1/files');
    fireEvent.click(link);
    expect(window.location.pathname).toBe('/workspace/projects/p1/files');
  });
});

// ---------------------------------------------------------------------------

describe('the files browser', () => {
  it('lists the folder the URL names', async () => {
    await openAt('/workspace/projects/p1/files/work');
    const m = main();
    for (const name of ['plan.md', 'notes.txt', 'chart.png', 'huge.log']) {
      expect(await within(m).findByRole('button', { name })).toBeTruthy();
    }
    expect(api.projectFiles).toHaveBeenCalledWith('p1', 'work');
  });

  it('opens a deep-linked file beside its own folder, rendering markdown', async () => {
    await openAt('/workspace/projects/p1/files/work/plan.md');
    expect(await within(main()).findByRole('heading', { name: 'Launch plan' })).toBeTruthy();
    // The list is the file's folder, not the root.
    expect(await within(main()).findByRole('button', { name: 'notes.txt' })).toBeTruthy();
    expect(within(main()).queryByRole('button', { name: 'instructions.md' })).toBeNull();
  });

  it('names the open file once in the viewer, not twice (kind walk, 2026-10-17)', async () => {
    await openAt('/workspace/projects/p1/files/work/plan.md');
    await within(main()).findByRole('heading', { name: 'Launch plan' });
    // The folder list's row, the breadcrumb's last crumb, and the viewer
    // header — no second line under the header repeating it.
    expect(within(main()).getAllByText('plan.md')).toHaveLength(3);
  });

  it('shows text as text, not as markdown', async () => {
    await openAt('/workspace/projects/p1/files/work/notes.txt');
    const pre = await waitFor(() => {
      const el = main().querySelector('pre');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(pre.textContent).toBe('# not a heading');
    expect(within(main()).queryByRole('heading', { name: 'not a heading' })).toBeNull();
  });

  it('says a binary file can’t be previewed and still offers the download', async () => {
    await openAt('/workspace/projects/p1/files/work/chart.png');
    expect(await within(main()).findByText('This file can’t be previewed.')).toBeTruthy();
    expect(within(main()).getByRole('button', { name: 'Download' })).toBeTruthy();
  });

  it('shows the size of a file too big to download, and no download button', async () => {
    await openAt('/workspace/projects/p1/files/work/huge.log');
    expect(await within(main()).findByText(/23\.4 MB · Too big to download here/)).toBeTruthy();
    expect(within(main()).queryByRole('button', { name: 'Download' })).toBeNull();
  });

  it('downloads through the project route, under the server’s name', async () => {
    api.downloadProjectFile.mockResolvedValue({ blob: new Blob(['x']), filename: 'plan.md' });
    await openAt('/workspace/projects/p1/files/work/plan.md');
    fireEvent.click(await within(main()).findByRole('button', { name: 'Download' }));
    await waitFor(() => expect(saved).toEqual(['plan.md']));
    expect(api.downloadProjectFile).toHaveBeenCalledWith('p1', 'work/plan.md');
  });

  it.each([
    [413, 'This file is too big to download here.'],
    [503, 'Files aren’t available on this server right now.'],
    [404, 'That file isn’t there anymore.'],
    [500, 'We couldn’t download that just now. Nothing was lost — try again in a moment.'],
  ])('says what a %s download means, without naming an agent', async (status, copy) => {
    api.downloadProjectFile.mockRejectedValue(new WorkspaceApiError('/projects/p1/download/work/plan.md', status));
    await openAt('/workspace/projects/p1/files/work/plan.md');
    fireEvent.click(await within(main()).findByRole('button', { name: 'Download' }));
    expect(await within(main()).findByText(copy)).toBeTruthy();
    expect(saved).toEqual([]);
    expect(main().textContent).not.toMatch(/Quill/);
  });

  it('draws "Projects › name › Files › path" with every crumb a link', async () => {
    await openAt('/workspace/projects/p1/files/work/plan.md');
    await within(main()).findByRole('heading', { name: 'Launch plan' });
    const crumbs = within(main()).getByRole('navigation', { name: /breadcrumb/i });
    const href = (name: string) => within(crumbs).getByRole('link', { name }).getAttribute('href');
    expect(href('Projects')).toBe('/workspace/projects');
    expect(href('Q4 launch')).toBe('/workspace/projects/p1');
    expect(href('Files')).toBe('/workspace/projects/p1/files');
    expect(href('work')).toBe('/workspace/projects/p1/files/work');
    // The file itself is where we are, not a link.
    const here = within(crumbs).getByText('plan.md');
    expect(here.hasAttribute('href')).toBe(false);
    expect(here.getAttribute('aria-current')).toBe('page');

    fireEvent.click(within(crumbs).getByRole('link', { name: 'work' }));
    expect(window.location.pathname).toBe('/workspace/projects/p1/files/work');
    fireEvent.click(within(crumbs).getByRole('link', { name: 'Q4 launch' }));
    expect(window.location.pathname).toBe('/workspace/projects/p1');
  });

  it('leaves a modified click on a crumb to the browser (open in a new tab)', async () => {
    await openAt('/workspace/projects/p1/files/work');
    const crumbs = await within(main()).findByRole('navigation', { name: /breadcrumb/i });
    // jsdom can't follow a real navigation; stop it AFTER the app has decided.
    const stop = (e: Event) => e.preventDefault();
    document.addEventListener('click', stop);
    fireEvent.click(within(crumbs).getByRole('link', { name: 'Files' }), { metaKey: true });
    document.removeEventListener('click', stop);
    expect(window.location.pathname).toBe('/workspace/projects/p1/files/work');
  });

  it('puts each folder and file on the URL, so Back walks them', async () => {
    await openAt('/workspace/projects/p1/files');
    fireEvent.click(await within(main()).findByRole('button', { name: 'work' }));
    await waitFor(() => expect(window.location.pathname).toBe('/workspace/projects/p1/files/work'));
    fireEvent.click(await within(main()).findByRole('button', { name: 'plan.md' }));
    expect(window.location.pathname).toBe('/workspace/projects/p1/files/work/plan.md');
    expect(await within(main()).findByRole('heading', { name: 'Launch plan' })).toBeTruthy();

    window.history.back();
    await waitFor(() => expect(window.location.pathname).toBe('/workspace/projects/p1/files/work'));
    await waitFor(() => expect(within(main()).queryByRole('heading', { name: 'Launch plan' })).toBeNull());
    window.history.back();
    await waitFor(() => expect(window.location.pathname).toBe('/workspace/projects/p1/files'));
    expect(await within(main()).findByRole('button', { name: 'instructions.md' })).toBeTruthy();
  });

  it('encodes a name with spaces and unicode in the URL, one segment per folder', async () => {
    serveFolder({
      ...FOLDER,
      work: dir('work', [fileEntry('work/Q4 plan — café.md')]),
      'work/Q4 plan — café.md': { kind: 'file', path: 'work/Q4 plan — café.md', name: 'work/Q4 plan — café.md', body: 'hi', clipped: null, size: 2, downloadable: true },
    });
    await openAt('/workspace/projects/p1/files/work');
    fireEvent.click(await within(main()).findByRole('button', { name: 'Q4 plan — café.md' }));
    expect(window.location.pathname).toBe(
      `/workspace/projects/p1/files/work/${encodeURIComponent('Q4 plan — café.md')}`,
    );
    await waitFor(() => expect(api.projectFiles).toHaveBeenCalledWith('p1', 'work/Q4 plan — café.md'));
  });

  it('says a missing path isn’t there and offers the way back up', async () => {
    await openAt('/workspace/projects/p1/files/work/gone.md');
    expect(await within(main()).findByText('That isn’t here anymore. It may have been moved or deleted.')).toBeTruthy();
    fireEvent.click(within(main()).getByRole('button', { name: 'Go back' }));
    expect(window.location.pathname).toBe('/workspace/projects/p1/files/work');
  });

  it('keeps the sidebar on the project', async () => {
    await openAt('/workspace/projects/p1/files');
    await within(main()).findByRole('button', { name: 'instructions.md' });
    const nav = screen.getAllByRole('button', { name: /Q4 launch/ }).concat(screen.queryAllByRole('link', { name: /Q4 launch/ }));
    expect(nav.some((el) => el.getAttribute('data-active') === 'true')).toBe(true);
  });

  it('says a gone or unshared project the way the project page does', async () => {
    api.getProject.mockRejectedValue(new WorkspaceApiError('/projects/p1', 404));
    await openAt('/workspace/projects/p1/files/work');
    expect(
      await screen.findByText('We couldn’t open this project. It may have been deleted, or it isn’t shared with you.'),
    ).toBeTruthy();
    // No file is asked for in a project we couldn't open.
    expect(api.projectFiles).not.toHaveBeenCalled();
    fireEvent.click(within(main()).getByRole('button', { name: 'All projects' }));
    expect(window.location.pathname).toBe('/workspace/projects');
  });

  it('says this server has no project files, with no retry', async () => {
    api.projectFiles.mockRejectedValue(new WorkspaceApiError('/projects/p1/files', 503));
    await openAt('/workspace/projects/p1/files');
    expect(await within(main()).findByText('Files aren’t available on this server.')).toBeTruthy();
    expect(within(main()).queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('the files browser on a phone', () => {
  it('is a tap-through list; a file opens full width with Back', async () => {
    setViewport(true);
    await openAt('/workspace/projects/p1/files/work');
    const row = await within(main()).findByRole('button', { name: 'plan.md' });
    // List only: no viewer placeholder beside it.
    expect(within(main()).queryByText('Pick a file to read it.')).toBeNull();

    fireEvent.click(row);
    expect(await within(main()).findByRole('heading', { name: 'Launch plan' })).toBeTruthy();
    expect(within(main()).queryByRole('button', { name: 'notes.txt' })).toBeNull();
    const back = within(main()).getByRole('button', { name: 'Back' });
    expect(document.activeElement).toBe(back);

    fireEvent.click(back);
    const again = await within(main()).findByRole('button', { name: 'plan.md' });
    expect(within(main()).queryByRole('heading', { name: 'Launch plan' })).toBeNull();
    // Focus comes back to the row the reader left.
    expect(document.activeElement).toBe(again);
  });

  it('opens a shared link to a file straight onto the file', async () => {
    setViewport(true);
    await openAt('/workspace/projects/p1/files/work/plan.md');
    expect(await within(main()).findByRole('heading', { name: 'Launch plan' })).toBeTruthy();
    expect(within(main()).getByRole('button', { name: 'Back' })).toBeTruthy();
  });

  it('stays on the list when stepping into a folder', async () => {
    setViewport(true);
    await openAt('/workspace/projects/p1/files');
    fireEvent.click(await within(main()).findByRole('button', { name: 'memory' }));
    expect(await within(main()).findByRole('button', { name: 'status.md' })).toBeTruthy();
    expect(within(main()).queryByRole('button', { name: 'Back' })).toBeNull();
  });
});
