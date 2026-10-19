/**
 * W3c — people change a project's files in the browser (W3 spec §6.3): Edit
 * on a text file (with the "someone changed this file" dialog), the + menu's
 * new text file and upload, Delete with a confirm, and the places none of it
 * is offered (viewers, `sources/`, the two files the project leans on).
 *
 * Through the real shell at `/workspace/projects/p1/files/*`, like the W3b
 * browser tests, with `workspaceApi` stubbed. The stub folder is mutable, so a
 * save the browser makes is what it reads back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { ProjectFileChangeError, workspaceApi, WorkspaceApiError, type AgentDetail } from '@/lib/workspace-api';
import { UserProvider } from '@/lib/user-context';
import type { UserFileEntry, UserFilesAnswer } from '@/lib/workspace-types';
import type { ProjectDetail, ProjectSummary } from '@/wire/projects';
import { WorkspaceShell } from '../WorkspaceShell';
import { PROJECT_FILE_CONFLICT_TITLE } from '../ProjectFileEditing';
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

const refusal = (status: number, code: string) => new ProjectFileChangeError('/projects/p1/files/x', status, code);

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

// ---------------------------------------------------------------------------

describe('editing a file', () => {
  it('Edit opens the text, Save sends it with the loaded hash, and the viewer shows the saved file', async () => {
    await openAt('/workspace/projects/p1/files/work/plan.md');
    fireEvent.click(await within(main()).findByRole('button', { name: 'Edit' }));
    const box = within(main()).getByRole('textbox', { name: 'File contents' });
    expect(box).toHaveValue('Ship it.');
    fireEvent.change(box, { target: { value: 'Ship it on Friday.' } });
    fireEvent.click(within(main()).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.writeProjectFile).toHaveBeenCalledWith('p1', 'work/plan.md', 'Ship it on Friday.', { baseHash: H1 }),
    );
    // Back to the viewer, reading the file again.
    expect(await within(main()).findByText('Ship it on Friday.')).toBeTruthy();
    expect(within(main()).queryByRole('textbox', { name: 'File contents' })).toBeNull();
    expect(api.projectFiles.mock.calls.filter(([, p]) => p === 'work/plan.md').length).toBeGreaterThan(1);
  });

  it('Cancel drops the edit without saving', async () => {
    await openAt('/workspace/projects/p1/files/work/plan.md');
    fireEvent.click(await within(main()).findByRole('button', { name: 'Edit' }));
    fireEvent.change(within(main()).getByRole('textbox', { name: 'File contents' }), { target: { value: 'nope' } });
    fireEvent.click(within(main()).getByRole('button', { name: 'Cancel' }));
    expect(await within(main()).findByText('Ship it.')).toBeTruthy();
    expect(api.writeProjectFile).not.toHaveBeenCalled();
  });

  it('a file the server sent no hash for (too long) offers no Edit', async () => {
    await openAt('/workspace/projects/p1/files/work/big.md');
    await within(main()).findByRole('button', { name: 'Download' });
    expect(within(main()).queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('says files aren’t available when the server can’t change them', async () => {
    api.writeProjectFile.mockRejectedValue(refusal(503, 'project-files-unavailable'));
    await openAt('/workspace/projects/p1/files/work/plan.md');
    fireEvent.click(await within(main()).findByRole('button', { name: 'Edit' }));
    fireEvent.click(within(main()).getByRole('button', { name: 'Save' }));
    expect(await within(main()).findByText('Files aren’t available right now.')).toBeTruthy();
    // The edit is still there to try again.
    expect(within(main()).getByRole('textbox', { name: 'File contents' })).toHaveValue('Ship it.');
  });
});

describe('when someone else changed the file', () => {
  async function conflictOnSave() {
    api.writeProjectFile.mockRejectedValueOnce(refusal(409, 'conflict'));
    await openAt('/workspace/projects/p1/files/work/plan.md');
    fireEvent.click(await within(main()).findByRole('button', { name: 'Edit' }));
    fireEvent.change(within(main()).getByRole('textbox', { name: 'File contents' }), { target: { value: 'Mine.' } });
    fireEvent.click(within(main()).getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(PROJECT_FILE_CONFLICT_TITLE);
    expect(PROJECT_FILE_CONFLICT_TITLE).toBe('Someone changed this file. Reload, or save over it?');
    return dialog;
  }

  it('Save over it sends the edit again with no base hash', async () => {
    const dialog = await conflictOnSave();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save over it' }));
    await waitFor(() => expect(api.writeProjectFile).toHaveBeenLastCalledWith('p1', 'work/plan.md', 'Mine.', {}));
    expect(await within(main()).findByText('Mine.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('Reload drops the edit and shows the newer file', async () => {
    const dialog = await conflictOnSave();
    folder['work/plan.md'] = textFile('work/plan.md', 'Theirs.', H2);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reload' }));
    expect(await within(main()).findByText('Theirs.')).toBeTruthy();
    expect(within(main()).queryByRole('textbox', { name: 'File contents' })).toBeNull();
    expect(api.writeProjectFile).toHaveBeenCalledTimes(1);
  });
});

describe('the + menu', () => {
  it('New text file asks for a name, opens an empty editor in work/, and creates it only if absent', async () => {
    await openAt('/workspace/projects/p1/files');
    await openMenu('Add');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'New text file' }));
    const dialog = await screen.findByRole('dialog', { name: 'New text file' });
    expect(dialog).toHaveTextContent('It goes in work/');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'ideas.md' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    const box = await within(main()).findByRole('textbox', { name: 'File contents' });
    expect(box).toHaveValue('');
    fireEvent.change(box, { target: { value: '# Ideas' } });
    fireEvent.click(within(main()).getByRole('button', { name: 'Save file' }));
    await waitFor(() =>
      expect(api.writeProjectFile).toHaveBeenCalledWith('p1', 'work/ideas.md', '# Ideas', { createOnly: true }),
    );
    await waitFor(() => expect(window.location.pathname).toBe('/workspace/projects/p1/files/work/ideas.md'));
    expect(await within(main()).findByRole('button', { name: 'ideas.md' })).toBeTruthy();
  });

  it('adds into the folder on screen when it’s memory/, work/ or playbooks/', async () => {
    await openAt('/workspace/projects/p1/files/memory');
    await openMenu('Add');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'New text file' }));
    expect(await screen.findByRole('dialog', { name: 'New text file' })).toHaveTextContent('It goes in memory/');
  });

  it('a name that’s already taken reads “A file with that name already exists.”', async () => {
    api.writeProjectFile.mockRejectedValueOnce(refusal(409, 'exists'));
    await openAt('/workspace/projects/p1/files');
    await openMenu('Add');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'New text file' }));
    const dialog = await screen.findByRole('dialog', { name: 'New text file' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'taken.md' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    fireEvent.click(await within(main()).findByRole('button', { name: 'Save file' }));
    expect(await within(main()).findByText('A file with that name already exists.')).toBeTruthy();
  });

  it('a name already in the folder on screen is caught in the dialog', async () => {
    await openAt('/workspace/projects/p1/files/work');
    await openMenu('Add');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'New text file' }));
    const dialog = await screen.findByRole('dialog', { name: 'New text file' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'plan.md' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(await within(dialog).findByText('A file with that name already exists.')).toBeTruthy();
    expect(api.writeProjectFile).not.toHaveBeenCalled();
  });

  it('SECURITY: refuses a name with a bidi or control character', async () => {
    await openAt('/workspace/projects/p1/files');
    await openMenu('Add');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'New text file' }));
    const dialog = await screen.findByRole('dialog', { name: 'New text file' });
    for (const bad of ['inv\u202Eoice.md', 'a\u0007b.md', 'zero\u200Bwidth.md', 'a/b.md']) {
      fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: bad } });
      expect(within(dialog).getByRole('button', { name: 'Continue' })).toBeDisabled();
    }
  });

  it('New folder makes it and opens it', async () => {
    await openAt('/workspace/projects/p1/files/work');
    await openMenu('Add');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'New folder' }));
    const dialog = await screen.findByRole('dialog', { name: 'New folder' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'drafts' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create folder' }));
    await waitFor(() => expect(api.createProjectFolder).toHaveBeenCalledWith('p1', 'work/drafts'));
    await waitFor(() => expect(window.location.pathname).toBe('/workspace/projects/p1/files/work/drafts'));
  });

  it('Upload files sends each one create-only, refuses one over 10 MB before sending, and says how each went', async () => {
    api.writeProjectFile.mockImplementation(async (_p: string, path: string) => {
      if (path === 'work/taken.txt') throw refusal(409, 'exists');
      put(path, '(uploaded)');
      return { sha256: H2 };
    });
    await openAt('/workspace/projects/p1/files/work');
    await within(main()).findByRole('button', { name: 'plan.md' });
    const ok = new File(['hello'], 'notes.txt');
    const taken = new File(['x'], 'taken.txt');
    const huge = new File(['x'], 'huge.bin');
    Object.defineProperty(huge, 'size', { value: 11 * MiB });
    const sneaky = new File(['x'], 'inv\u202Eoice.txt');
    await openMenu('Add');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Upload files' }));
    fireEvent.change(screen.getByTestId('project-upload-input'), { target: { files: [ok, taken, huge, sneaky] } });

    const results = await screen.findByRole('alert', { name: 'Upload results' });
    expect(results).toHaveTextContent('Uploaded 1 of 4 files.');
    expect(results).toHaveTextContent('taken.txt: a file with that name already exists.');
    expect(results).toHaveTextContent('huge.bin: it’s too big. Each file can be up to 10 MB.');
    expect(results).not.toHaveTextContent('\u202E');
    expect(api.writeProjectFile).toHaveBeenCalledTimes(2);
    expect(api.writeProjectFile).toHaveBeenCalledWith('p1', 'work/notes.txt', ok, { createOnly: true });
    expect(api.writeProjectFile).toHaveBeenCalledWith('p1', 'work/taken.txt', taken, { createOnly: true });
    // The listing shows the new file.
    expect(await within(main()).findByRole('button', { name: 'notes.txt' })).toBeTruthy();
  });
});

describe('deleting a file', () => {
  it('confirms, deletes, and goes back to the folder', async () => {
    await openAt('/workspace/projects/p1/files/work/plan.md');
    await openMenu('File options');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent('Delete plan.md?');
    expect(api.deleteProjectFile).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.deleteProjectFile).toHaveBeenCalledWith('p1', 'work/plan.md'));
    await waitFor(() => expect(window.location.pathname).toBe('/workspace/projects/p1/files/work'));
  });

  it.each(['instructions.md', 'memory/status.md'])('%s can be edited but offers no Delete', async (path) => {
    await openAt(`/workspace/projects/p1/files/${path}`);
    expect(await within(main()).findByRole('button', { name: 'Edit' })).toBeTruthy();
    // The menu is there for History (W3d), without Delete.
    await openMenu('File options');
    expect(await screen.findByRole('menuitem', { name: 'History' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull();
  });
});

describe('where nothing can be changed', () => {
  it('sources/ is read-only: no Edit, no Delete', async () => {
    await openAt('/workspace/projects/p1/files/sources/import.md');
    await within(main()).findByText('Copied in.');
    expect(within(main()).queryByRole('button', { name: 'Edit' })).toBeNull();
    await openMenu('File options');
    expect(await screen.findByRole('menuitem', { name: 'History' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull();
  });

  it('the + menu in sources/ adds into work/, never sources/', async () => {
    await openAt('/workspace/projects/p1/files/sources');
    await openMenu('Add');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'New text file' }));
    expect(await screen.findByRole('dialog', { name: 'New text file' })).toHaveTextContent('It goes in work/');
  });

  it('a person whose agents here are all viewers sees no edit controls at all', async () => {
    api.getProject.mockResolvedValue(
      detail({
        members: [
          { agentId: 'a-owner', role: 'owner' },
          { agentId: 'a-quill', role: 'viewer', displayName: 'Quill' },
        ],
        canManage: false,
      }),
    );
    await openAt('/workspace/projects/p1/files/work/plan.md');
    await within(main()).findByText('Ship it.');
    expect(within(main()).getByRole('button', { name: 'Download' })).toBeTruthy();
    for (const name of ['Edit', 'Add']) {
      expect(within(main()).queryByRole('button', { name })).toBeNull();
    }
    // History is for everyone; Delete isn't.
    await openMenu('File options');
    expect(await screen.findByRole('menuitem', { name: 'History' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull();
  });
});
