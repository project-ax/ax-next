/**
 * W3d — a project file's history in the browser (W3 spec §7.3): History in the
 * file's menu opens a Sheet of versions (who, when, what, a chat link, "Too
 * large to keep history", gaps), a version previews in place, Restore asks
 * first and then refreshes everything, Undo restores the version before the
 * newest (the last write, after a delete), and viewers read but never change.
 *
 * Through the real shell at `/workspace/projects/p1/files/*`, with
 * `workspaceApi` stubbed, like the W3c tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { ProjectFileChangeError, workspaceApi, WorkspaceApiError, type AgentDetail } from '@/lib/workspace-api';
import { UserProvider } from '@/lib/user-context';
import type { UserFileEntry, UserFilesAnswer } from '@/lib/workspace-types';
import type { ProjectDetail, ProjectSummary } from '@/wire/projects';
import { WorkspaceShell } from '../WorkspaceShell';
import { NOT_RESTORABLE, RESTORE_CONFIRM_TITLE, UNDO_CONFIRM_TITLE, undoTarget } from '../ProjectFileHistory';
import type { ProjectFileVersion } from '@/wire/projects';
import { rail as railFixture } from './rail-fixture';

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
      writeProjectFile: vi.fn(),
      deleteProjectFile: vi.fn(),
      createProjectFolder: vi.fn(),
      projectFileHistory: vi.fn(),
      projectFileVersion: vi.fn(),
      restoreProjectFileVersion: vi.fn(),
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
const MiB = 1024 * 1024;
const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
/** The inline restore/undo confirmation (a group inside the History sheet, never a dialog). */
const CONFIRM_NAME = (name: string): boolean => name === RESTORE_CONFIRM_TITLE || name === UNDO_CONFIRM_TITLE;

function summary(): ProjectSummary {
  return { projectId: 'p1', name: 'Q4 launch', description: null, updatedAt: hoursAgo(2), members: [{ agentId: 'a-quill', role: 'owner' }] };
}

function detail(over: Partial<ProjectDetail> = {}): ProjectDetail {
  return {
    projectId: 'p1',
    name: 'Q4 launch',
    description: null,
    createdAt: hoursAgo(48),
    updatedAt: hoursAgo(2),
    members: [{ agentId: 'a-quill', role: 'owner', displayName: 'Quill' }],
    canManage: true,
    ...over,
  };
}

const dir = (path: string, entries: UserFileEntry[]): UserFilesAnswer => ({ kind: 'dir', path, name: path, entries, truncated: false });
const fileEntry = (path: string): UserFileEntry => ({ path, name: path.slice(path.lastIndexOf('/') + 1), kind: 'file' });
const dirEntry = (path: string): UserFileEntry => ({ path, name: path, kind: 'dir' });
type FileAnswer = Extract<UserFilesAnswer, { kind: 'file' }>;
const textFile = (path: string, body: string, sha256?: string): FileAnswer => ({
  kind: 'file',
  path,
  name: path.slice(path.lastIndexOf('/') + 1),
  body,
  clipped: null,
  size: body.length,
  downloadable: true,
  ...(sha256 !== undefined ? { sha256 } : {}),
});

let folder: Record<string, UserFilesAnswer>;

function freshFolder(): Record<string, UserFilesAnswer> {
  return {
    '': dir('', [fileEntry('instructions.md'), dirEntry('memory'), dirEntry('sources'), dirEntry('work')]),
    memory: dir('memory', [fileEntry('memory/status.md')]),
    sources: dir('sources', [fileEntry('sources/import.md')]),
    work: dir('work', [fileEntry('work/plan.md'), fileEntry('work/big.md')]),
    'instructions.md': textFile('instructions.md', 'Be brief.', H1),
    'memory/status.md': textFile('memory/status.md', 'On track.', H1),
    'sources/import.md': textFile('sources/import.md', 'Copied in.', H1),
    'work/plan.md': textFile('work/plan.md', 'Ship it.', H1),
    // Too long to edit here: the server sends no hash.
    'work/big.md': { ...textFile('work/big.md', 'x'), clipped: 'too-large', size: 2 * MiB },
  };
}

/** Add a file to the stub folder, listing it in its parent. */
function put(path: string, body: string) {
  folder[path] = textFile(path, body, H2);
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const listing = folder[parent];
  if (listing?.kind === 'dir' && !listing.entries.some((e) => e.path === path)) {
    folder[parent] = { ...listing, entries: [...listing.entries, fileEntry(path)] };
  }
}


function renderAt(path: string) {
  window.history.replaceState(null, '', path);
  return render(
    <UserProvider value={user}>
      <WorkspaceShell />
    </UserProvider>,
  );
}

const main = () => screen.getByRole('main');

async function openAt(path: string) {
  renderAt(path);
  await screen.findByRole('main');
}

async function openMenu(name: string) {
  fireEvent.pointerDown(await within(main()).findByRole('button', { name }), { button: 0, ctrlKey: false });
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  vi.clearAllMocks();
  api.board.mockResolvedValue({ agents: [QUILL] } as never);
  api.agent.mockResolvedValue({ agent: QUILL, conversationId: 'c', thread: [], decisions: { status: 'ok' }, past: [], memory: { rules: { status: 'unavailable', doc: null } } } as unknown as AgentDetail);
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
  folder = freshFolder();
  api.projectFiles.mockImplementation(async (_projectId: string, path: string) => {
    const answer = folder[path];
    if (answer === undefined) throw new WorkspaceApiError(`/projects/p1/files/${path}`, 404);
    return answer;
  });
  api.writeProjectFile.mockImplementation(async (_p: string, path: string, content: Blob | string) => {
    put(path, typeof content === 'string' ? content : '(uploaded)');
    return { sha256: H2 };
  });
  api.deleteProjectFile.mockResolvedValue(undefined);
  api.createProjectFolder.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});


const ver = (over: Partial<ProjectFileVersion> & { versionId: string }): ProjectFileVersion => ({
  kind: 'write',
  label: 'edit',
  size: 10,
  tooLarge: false,
  author: { kind: 'none' },
  chat: null,
  createdAt: hoursAgo(1),
  ...over,
});

/** Newest first, one of each label and author kind. */
function fullHistory(): ProjectFileVersion[] {
  return [
    ver({ versionId: 'v8', label: 'restore', author: { kind: 'you' }, createdAt: hoursAgo(1) }),
    ver({ versionId: 'v7', label: 'edit', author: { kind: 'person', displayName: 'Bob Builder' }, createdAt: hoursAgo(2) }),
    ver({ versionId: 'v6', label: 'edit', author: { kind: 'person', displayName: null }, createdAt: hoursAgo(3) }),
    ver({
      versionId: 'v5',
      label: 'agent',
      author: { kind: 'agent', displayName: 'Quill', removed: false },
      chat: { conversationId: 'conv-1', agentId: 'a-quill' },
      createdAt: hoursAgo(4),
    }),
    ver({ versionId: 'v4', label: 'agent', author: { kind: 'agent', displayName: null, removed: true }, createdAt: hoursAgo(5) }),
    ver({ versionId: 'v3', label: 'outside', createdAt: hoursAgo(6) }),
    ver({ versionId: 'v2', label: 'seed', author: { kind: 'you' }, size: 3 * MiB, tooLarge: true, createdAt: hoursAgo(7) }),
    ver({ versionId: 'v1', label: 'baseline', createdAt: hoursAgo(8) }),
  ];
}

let history: { versions: ProjectFileVersion[]; gaps: Array<{ at: string }> };

beforeEach(() => {
  history = { versions: fullHistory(), gaps: [] };
  api.projectFileHistory.mockImplementation(async () => history);
  api.projectFileVersion.mockResolvedValue({ body: 'An older plan.', clipped: null, size: 14 });
  api.restoreProjectFileVersion.mockResolvedValue({ sha256: H2 });
});

async function openHistory(path = 'work/plan.md') {
  await openAt(`/workspace/projects/p1/files/${path}`);
  await openMenu('File options');
  fireEvent.click(await screen.findByRole('menuitem', { name: 'History' }));
  const sheet = await screen.findByRole('dialog', { name: 'History' });
  await within(sheet).findByRole('list', { name: 'Versions' });
  return sheet;
}

const row = (id: string) => screen.getByTestId(`version-${id}`);

describe('the History sheet', () => {
  it('lists each version newest first: what, who, when, and the chat', async () => {
    const sheet = await openHistory();
    expect(api.projectFileHistory).toHaveBeenCalledWith('p1', 'work/plan.md');
    const items = within(sheet).getAllByTestId(/^version-/).map((el) => el.dataset.testid);
    expect(items).toEqual(['version-v8', 'version-v7', 'version-v6', 'version-v5', 'version-v4', 'version-v3', 'version-v2', 'version-v1']);
    expect(row('v8')).toHaveTextContent('Restored');
    expect(row('v8')).toHaveTextContent('You ·');
    expect(row('v7')).toHaveTextContent('Edited');
    expect(row('v7')).toHaveTextContent('Bob Builder');
    expect(row('v6')).toHaveTextContent('Someone');
    expect(row('v5')).toHaveTextContent('Changed by Quill');
    expect(row('v4')).toHaveTextContent('Changed by a removed agent');
    expect(row('v3')).toHaveTextContent('Changed outside history');
    expect(row('v2')).toHaveTextContent('Created with the project');
    expect(row('v1')).toHaveTextContent('Before history started');
    // When: relative, the absolute time on hover.
    const when = within(row('v7')).getByText('2h ago');
    expect(when.tagName).toBe('TIME');
    expect(when.getAttribute('title')).not.toBe('');
  });

  it('a delete reads "Deleted"', async () => {
    history.versions = [ver({ versionId: 'd1', kind: 'delete', label: 'edit', author: { kind: 'you' } }), ...fullHistory()];
    await openHistory();
    expect(row('d1')).toHaveTextContent('Deleted');
    expect(within(row('d1')).queryByRole('button', { name: 'Restore' })).toBeNull();
  });

  it('the chat link opens that chat', async () => {
    await openHistory();
    fireEvent.click(within(row('v5')).getByRole('link', { name: 'Open the chat' }));
    await waitFor(() => expect(window.location.pathname).toBe('/workspace/agents/a-quill'));
  });

  it('a gap inside the listed range shows as a muted row; one before the oldest version doesn’t', async () => {
    const at = hoursAgo(4.5);
    history.gaps = [{ at }, { at: hoursAgo(100) }];
    const sheet = await openHistory();
    const gaps = within(sheet).getAllByText(/History may be missing changes from around/);
    expect(gaps).toHaveLength(1);
    const items = within(sheet).getAllByRole('listitem');
    const gapIndex = items.findIndex((li) => li.textContent?.includes('may be missing'));
    expect(items[gapIndex - 1]).toContainElement(row('v5'));
    expect(items[gapIndex + 1]).toContainElement(row('v4'));
  });

  it('too-large versions say so and offer no Preview or Restore', async () => {
    await openHistory();
    expect(row('v2')).toHaveTextContent('Too large to keep history');
    expect(within(row('v2')).queryByRole('button', { name: 'Restore' })).toBeNull();
    expect(within(row('v2')).queryByRole('button', { name: 'Preview' })).toBeNull();
  });

  it('Preview shows the version inside the sheet', async () => {
    await openHistory();
    fireEvent.click(within(row('v7')).getByRole('button', { name: 'Preview' }));
    expect(await within(row('v7')).findByText('An older plan.')).toBeTruthy();
    expect(api.projectFileVersion).toHaveBeenCalledWith('p1', 'v7');
  });

  it('a version that isn’t text says there’s no preview', async () => {
    api.projectFileVersion.mockResolvedValue({ body: null, clipped: 'binary', size: 3 });
    await openHistory();
    fireEvent.click(within(row('v7')).getByRole('button', { name: 'Preview' }));
    expect(await within(row('v7')).findByText(/no preview/)).toBeTruthy();
  });
});

describe('restoring', () => {
  // Production smoke test, 2026-10-19: an AlertDialog stacked over the History
  // Sheet left the page unclickable after Cancel or Restore, and the restore
  // never reached the server. The confirmation now lives inside the sheet:
  // one dialog layer, ever.
  it('confirms inside the sheet, never as a second dialog, and Cancel leaves the sheet usable', async () => {
    await openHistory();
    const sheet = screen.getByRole('dialog', { name: 'History' });
    fireEvent.click(within(row('v7')).getByRole('button', { name: 'Restore' }));
    const confirm = await within(sheet).findByRole('group', { name: CONFIRM_NAME });
    expect(within(row('v7')).getByRole('group', { name: CONFIRM_NAME })).toBe(confirm);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group', { name: CONFIRM_NAME })).toBeNull();
    expect(api.restoreProjectFileVersion).not.toHaveBeenCalled();
    // Still open, and the row offers Restore again.
    expect(screen.getByRole('dialog', { name: 'History' })).toBe(sheet);
    expect(within(row('v7')).getByRole('button', { name: 'Restore' })).toBeTruthy();
  });

  it('confirms, restores, then refreshes the viewer and the history', async () => {
    await openHistory();
    const fileReads = () => api.projectFiles.mock.calls.filter(([, p]) => p === 'work/plan.md').length;
    const readsBefore = fileReads();
    fireEvent.click(within(row('v7')).getByRole('button', { name: 'Restore' }));
    const confirm = await screen.findByRole('group', { name: CONFIRM_NAME });
    expect(confirm).toHaveTextContent(RESTORE_CONFIRM_TITLE);
    expect(confirm).toHaveTextContent('The current file stays in history, so you can undo this too.');
    expect(api.restoreProjectFileVersion).not.toHaveBeenCalled();
    folder['work/plan.md'] = textFile('work/plan.md', 'An older plan.', H2);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(api.restoreProjectFileVersion).toHaveBeenCalledWith('p1', 'v7'));
    await waitFor(() => expect(screen.queryByRole('group', { name: CONFIRM_NAME })).toBeNull());
    await waitFor(() => expect(api.projectFileHistory).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(fileReads()).toBeGreaterThan(readsBefore));
    // The sheet stays open on the refreshed list; behind it, the viewer shows the restored file.
    expect(screen.getByRole('dialog', { name: 'History' })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'History' }), { key: 'Escape' });
    expect(await within(main()).findByText('An older plan.')).toBeTruthy();
  });

  it('a version that can’t be restored says so plainly', async () => {
    api.restoreProjectFileVersion.mockRejectedValue(new ProjectFileChangeError('/x', 409, 'not-restorable'));
    await openHistory();
    fireEvent.click(within(row('v7')).getByRole('button', { name: 'Restore' }));
    const confirm = await screen.findByRole('group', { name: CONFIRM_NAME });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Restore' }));
    expect(await within(confirm).findByText(NOT_RESTORABLE)).toBeTruthy();
    expect(NOT_RESTORABLE).toBe('This version can’t be restored.');
    // Announced, and focus is back on the confirm button (the busy button had
    // disabled itself and dropped it).
    expect(within(confirm).getByRole('alert')).toHaveTextContent(NOT_RESTORABLE);
    await waitFor(() => expect(within(confirm).getByRole('button', { name: 'Restore' })).toHaveFocus());
  });
});

describe('Undo the last change', () => {
  it('restores the version just before the newest', async () => {
    const sheet = await openHistory();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Undo the last change' }));
    const confirm = await screen.findByRole('group', { name: CONFIRM_NAME });
    expect(confirm).toHaveTextContent(UNDO_CONFIRM_TITLE);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(api.restoreProjectFileVersion).toHaveBeenCalledWith('p1', 'v7'));
  });

  it('after a delete, restores the last write before it', async () => {
    history.versions = [
      ver({ versionId: 'gone', kind: 'delete', author: { kind: 'you' } }),
      ...fullHistory(),
    ];
    const sheet = await openHistory();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Undo the last change' }));
    fireEvent.click(within(await screen.findByRole('group', { name: CONFIRM_NAME })).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(api.restoreProjectFileVersion).toHaveBeenCalledWith('p1', 'v8'));
  });

  it('isn’t offered when there’s nothing restorable just before the newest', () => {
    expect(undoTarget([])).toBeNull();
    expect(undoTarget([ver({ versionId: 'only' })])).toBeNull();
    expect(undoTarget([ver({ versionId: 'a' }), ver({ versionId: 'b', tooLarge: true }), ver({ versionId: 'c' })])).toBeNull();
    // A file deleted and made again: Undo would mean deleting it, which isn't a restore.
    expect(undoTarget([ver({ versionId: 'a' }), ver({ versionId: 'b', kind: 'delete' }), ver({ versionId: 'c' })])).toBeNull();
    expect(
      undoTarget([ver({ versionId: 'a', kind: 'delete' }), ver({ versionId: 'b', kind: 'delete' }), ver({ versionId: 'c' })])?.versionId,
    ).toBe('c');
  });

  it('is hidden in the sheet when there’s no such version', async () => {
    history.versions = [ver({ versionId: 'only', author: { kind: 'you' } })];
    const sheet = await openHistory();
    expect(within(sheet).queryByRole('button', { name: 'Undo the last change' })).toBeNull();
  });
});

describe('viewers', () => {
  it('see History, but no Restore and no Undo', async () => {
    api.getProject.mockResolvedValue(
      detail({
        members: [
          { agentId: 'a-owner', role: 'owner' },
          { agentId: 'a-quill', role: 'viewer', displayName: 'Quill' },
        ],
        canManage: false,
      }),
    );
    const sheet = await openHistory();
    expect(row('v7')).toHaveTextContent('Edited');
    expect(within(sheet).queryByRole('button', { name: 'Restore' })).toBeNull();
    expect(within(sheet).queryByRole('button', { name: 'Undo the last change' })).toBeNull();
    // They can still look.
    fireEvent.click(within(row('v7')).getByRole('button', { name: 'Preview' }));
    expect(await within(row('v7')).findByText('An older plan.')).toBeTruthy();
  });
});

describe('a deleted file', () => {
  it('“See history” on the missing path, then Restore brings it back', async () => {
    history.versions = [
      ver({ versionId: 'gone', kind: 'delete', author: { kind: 'you' } }),
      ver({ versionId: 'last', author: { kind: 'you' }, createdAt: hoursAgo(2) }),
    ];
    await openAt('/workspace/projects/p1/files/work/old.md');
    fireEvent.click(await within(main()).findByRole('button', { name: 'See history' }));
    const sheet = await screen.findByRole('dialog', { name: 'History' });
    expect(api.projectFileHistory).toHaveBeenCalledWith('p1', 'work/old.md');
    await within(sheet).findByRole('list', { name: 'Versions' });
    put('work/old.md', 'Back again.');
    fireEvent.click(within(row('last')).getByRole('button', { name: 'Restore' }));
    fireEvent.click(within(await screen.findByRole('group', { name: CONFIRM_NAME })).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(api.restoreProjectFileVersion).toHaveBeenCalledWith('p1', 'last'));
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'History' }), { key: 'Escape' });
    expect(await within(main()).findByText('Back again.')).toBeTruthy();
  });
});
